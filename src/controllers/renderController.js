import { randomUUID } from 'crypto';

import { ACTIVE_JOB_STATUSES, config } from '../../helpers/config.js';
import { prisma } from '../db.js';
import { publicUser } from '../services/authService.js';
import { reserveRenderCredits } from '../services/creditService.js';
import { buildRunpodInput, estimateRenderCostUsd, normalizeRenderSettings, releaseJobReservation, resolveRenderBudget, sanitizeRenderError, serializeJob, validateRenderChoices } from '../services/jobService.js';
import { cancelRunpodJob, startRunpodRender } from '../services/runpodService.js';
import { createUploadUrl, isSafeFileName, isSafeObjectKey } from '../services/storageService.js';

function normalizeIdempotencyKey(req) {
  const rawValue = req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || req.body?.idempotencyKey || req.body?.clientRequestId || '';
  const normalized = String(rawValue).trim();
  if (!normalized) return null;
  return normalized.slice(0, 160);
}

function internalDispatchReference() {
  return `render:${randomUUID()}`;
}

function dispatchMetadata(existing = {}, patch = {}) {
  return {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function dispatchFailureMetadata(error, patch = {}) {
  return dispatchMetadata(patch, {
    providerErrorCode: error.code || null,
    providerStatus: error.status || null,
    providerRetryable: Boolean(error.retryable),
    providerError: sanitizeRenderError(error.data || error.message, 'RunPod dispatch failed before provider acceptance.'),
  });
}

export function createRenderController({ emitJobUpdate = null } = {}) {
  return {
    async getUploadUrl(req, res) {
      const { fileName } = req.body;
      const fileSizeBytes = Number(req.body.fileSizeBytes);

      if (!isSafeFileName(fileName)) return res.status(400).json({ error: 'Invalid fileName' });
      if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) return res.status(400).json({ error: 'A valid fileSizeBytes value is required' });
      if (fileSizeBytes > config.maxUploadBytes) return res.status(413).json({ error: 'Packed .blend file exceeds upload limit' });

      const key = `renders/${req.user.id}/${Date.now()}-${fileName}`;

      try {
        const uploadUrl = await createUploadUrl(key);
        await prisma.upload.create({
          data: {
            key,
            userId: req.user.id,
            fileName,
            fileSizeBytes: BigInt(fileSizeBytes),
            used: false,
          },
        });

        return res.json({ uploadUrl, key });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to generate R2 pre-signed URL' });
      }
    },

    async triggerRender(req, res) {
      const { fileKey, engine, outputFormat = 'PNG', denoiser = 'NONE' } = req.body;
      const projectId = String(req.body.projectId || '').trim() || null;
      const requestIdempotencyKey = normalizeIdempotencyKey(req);
      const scopedIdempotencyKey = requestIdempotencyKey ? `render:${req.user.id}:${requestIdempotencyKey}` : null;

      if (!isSafeObjectKey(fileKey)) return res.status(400).json({ error: 'Invalid fileKey' });

      const choiceError = validateRenderChoices({ engine, outputFormat, denoiser });
      if (choiceError) return res.status(400).json({ error: choiceError });

      const normalizedSettings = normalizeRenderSettings(req.body);
      if (normalizedSettings.error) return res.status(400).json({ error: normalizedSettings.error });

      if (scopedIdempotencyKey) {
        const existingJob = await prisma.job.findUnique({ where: { idempotencyKey: scopedIdempotencyKey }, include: { project: true } });
        if (existingJob) {
          const retryableDispatch = existingJob.dispatchStatus === 'FAILED' && existingJob.reservationReleasedAt;
          if (retryableDispatch) {
            return res.status(409).json({
              error: 'A previous render submission with this idempotency key failed before provider acceptance. Submit again with a new idempotency key to retry dispatch.',
              idempotent: true,
              retryable: true,
              jobId: existingJob.jobId,
              dispatchStatus: existingJob.dispatchStatus,
              job: serializeJob(existingJob),
            });
          }

          const refreshedUser = await prisma.user.findUnique({ where: { id: req.user.id } });
          return res.status(200).json({
            success: existingJob.dispatchStatus === 'DISPATCHED',
            idempotent: true,
            jobId: existingJob.jobId,
            providerJobId: existingJob.providerJobId,
            status: existingJob.status,
            dispatchStatus: existingJob.dispatchStatus,
            job: serializeJob(existingJob),
            user: publicUser(refreshedUser),
          });
        }
      }

      const [upload, activeJobs, user, project] = await Promise.all([
        prisma.upload.findFirst({ where: { key: fileKey, userId: req.user.id } }),
        prisma.job.count({ where: { userId: req.user.id, status: { in: Array.from(ACTIVE_JOB_STATUSES) } } }),
        prisma.user.findUnique({ where: { id: req.user.id } }),
        projectId ? prisma.project.findFirst({ where: { id: projectId, userId: req.user.id } }) : Promise.resolve(null),
      ]);

      if (!upload) return res.status(403).json({ error: 'This upload does not belong to the authenticated account' });
      if (upload.used) return res.status(409).json({ error: 'This upload has already been used' });
      if (activeJobs >= config.maxConcurrentJobsPerUser) return res.status(429).json({ error: 'Active job limit reached' });
      if (projectId && !project) return res.status(404).json({ error: 'Project not found' });

      const runpodInput = buildRunpodInput({ fileKey, engine, outputFormat, denoiser, normalizedSettings });
      const costEstimate = estimateRenderCostUsd({ engine, outputFormat, denoiser, normalizedSettings });
      const budget = resolveRenderBudget({ body: req.body, estimatedCostUsd: costEstimate.estimatedCostUsd });
      const localJobId = internalDispatchReference();
      const reservationReferenceId = localJobId;

      if (Number(user?.starterBalanceUsd || 0) < budget.reservationUsd) {
        return res.status(402).json({
          error: `Insufficient prepaid credits. This render requires a $${budget.reservationUsd.toFixed(2)} reservation, but only $${Number(user?.starterBalanceUsd || 0).toFixed(2)} is available.`,
          requiredUsd: budget.reservationUsd,
          availableUsd: Number(user?.starterBalanceUsd || 0),
          estimatedCostUsd: costEstimate.estimatedCostUsd,
          maxBudgetUsd: budget.maxBudgetUsd,
        });
      }

      let job = null;
      let providerJobId = null;
      let providerData = null;
      try {
        job = await prisma.$transaction(async (tx) => {
          const claimedUpload = await tx.upload.updateMany({ where: { key: fileKey, userId: req.user.id, used: false }, data: { used: true } });
          if (claimedUpload.count !== 1) {
            const error = new Error('This upload has already been used');
            error.status = 409;
            throw error;
          }

          const createdJob = await tx.job.create({
            data: {
              jobId: localJobId,
              userId: req.user.id,
              projectId: project?.id || null,
              fileKey,
              status: 'DISPATCHING',
              dispatchStatus: 'PENDING',
              idempotencyKey: scopedIdempotencyKey,
              settings: { ...runpodInput, dispatchReference: localJobId },
              frameCount: normalizedSettings.frameCount,
              estimatedCostUsd: costEstimate.estimatedCostUsd,
              maxBudgetUsd: budget.maxBudgetUsd,
              reservedCreditsUsd: budget.reservationUsd,
              billingState: 'RESERVING',
              billingMetadata: {
                reservationReferenceId,
                requestedBudgetUsd: budget.requestedBudgetUsd,
                estimatedSeconds: costEstimate.estimatedSeconds,
              },
              dispatchMetadata: dispatchMetadata({}, {
                dispatchReference: localJobId,
                requestIdempotencyKey: requestIdempotencyKey || null,
                phase: 'local_job_created',
              }),
              progress: { percent: 1, updatedAt: new Date().toISOString(), message: 'Preparing provider dispatch' },
            },
            include: { project: true },
          });

          const reserved = await reserveRenderCredits({
            client: tx,
            userId: req.user.id,
            referenceId: reservationReferenceId,
            jobId: createdJob.jobId,
            amountUsd: budget.reservationUsd,
            estimatedCostUsd: costEstimate.estimatedCostUsd,
            maxBudgetUsd: budget.maxBudgetUsd,
            metadata: {
              fileKey,
              projectId: project?.id || null,
              requestedBudgetUsd: budget.requestedBudgetUsd,
              estimatedSeconds: costEstimate.estimatedSeconds,
            },
          });

          const billingMetadata = {
            ...(createdJob.billingMetadata && typeof createdJob.billingMetadata === 'object' ? createdJob.billingMetadata : {}),
            reservationTransactionId: reserved.transaction.id,
            reservationIdempotent: reserved.idempotent,
          };

          return tx.job.update({
            where: { jobId: createdJob.jobId },
            data: {
              billingState: 'RESERVED',
              billingMetadata,
              dispatchStatus: 'DISPATCHING',
              dispatchMetadata: dispatchMetadata(createdJob.dispatchMetadata, { phase: 'provider_dispatch_started' }),
              progress: { percent: 2, updatedAt: new Date().toISOString(), message: 'Dispatching to render provider' },
            },
            include: { project: true },
          });
        });

        if (emitJobUpdate) emitJobUpdate(job, null);

        const data = await startRunpodRender({ ...runpodInput, dispatchReference: localJobId, idempotencyKey: scopedIdempotencyKey }, { idempotencyKey: scopedIdempotencyKey || localJobId });
        providerData = data;
        providerJobId = data.id;
        if (!providerJobId) throw new Error('RunPod accepted dispatch without returning a provider job id');

        job = await prisma.job.update({
          where: { jobId: localJobId },
          data: {
            providerJobId,
            status: data.status || 'SUBMITTED',
            dispatchStatus: 'DISPATCHED',
            dispatchedAt: new Date(),
            dispatchMetadata: dispatchMetadata(job.dispatchMetadata, {
              phase: 'provider_dispatch_accepted',
              providerJobId,
              providerStatus: data.status || null,
            }),
            progress: { percent: 2, updatedAt: new Date().toISOString(), message: 'Render provider accepted job' },
          },
          include: { project: true },
        });

        if (emitJobUpdate) emitJobUpdate(job, data);
        console.log(`Render job dispatched. Local Job ID: ${localJobId}; RunPod Job ID: ${providerJobId}`);
        const refreshedUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        return res.json({ success: true, jobId: job.jobId, providerJobId, status: job.status, dispatchStatus: job.dispatchStatus, job: serializeJob(job, data), user: publicUser(refreshedUser) });
      } catch (error) {
        console.error('Render dispatch error:', error.data || error);

        if (job && providerJobId) {
          try {
            const reconcileJob = await prisma.job.update({
              where: { jobId: job.jobId },
              data: {
                providerJobId,
                status: providerData?.status || 'SUBMITTED',
                dispatchStatus: 'DISPATCHED',
                dispatchedAt: new Date(),
                error: null,
                dispatchMetadata: dispatchMetadata(job.dispatchMetadata, {
                  phase: 'provider_dispatch_accepted_attach_retried',
                  providerJobId,
                  providerStatus: providerData?.status || null,
                  attachError: sanitizeRenderError(error.data || error.message, 'Local provider attachment initially failed.'),
                }),
              },
              include: { project: true },
            });
            if (emitJobUpdate) emitJobUpdate(reconcileJob, providerData);
            const refreshedUser = await prisma.user.findUnique({ where: { id: req.user.id } });
            return res.json({
              success: true,
              reconciled: true,
              jobId: reconcileJob.jobId,
              providerJobId,
              status: reconcileJob.status,
              dispatchStatus: reconcileJob.dispatchStatus,
              job: serializeJob(reconcileJob, providerData),
              user: publicUser(refreshedUser),
            });
          } catch (reconcileError) {
            console.error('RunPod accepted a job but local provider id attachment needs manual reconciliation:', {
              localJobId: job.jobId,
              providerJobId,
              error: reconcileError.message || reconcileError,
            });
          }
        } else if (job) {
          try {
            const failedJob = await prisma.$transaction(async (tx) => {
              const currentJob = await tx.job.findUnique({ where: { jobId: job.jobId }, include: { project: true } });
              if (!currentJob) return null;

              const updatedJob = await tx.job.update({
                where: { jobId: currentJob.jobId },
                data: {
                  status: 'DISPATCH_FAILED',
                  dispatchStatus: 'FAILED',
                  failedAt: currentJob.failedAt || new Date(),
                  error: sanitizeRenderError(error.data || error.message, 'RunPod dispatch failed before provider acceptance.'),
                  billingState: currentJob.reservationReleasedAt ? currentJob.billingState : 'RELEASING',
                  dispatchMetadata: dispatchFailureMetadata(error, currentJob.dispatchMetadata),
                  progress: { percent: 0, updatedAt: new Date().toISOString(), message: 'Dispatch failed before provider acceptance' },
                },
                include: { project: true },
              });

              await releaseJobReservation({
                client: tx,
                job: updatedJob,
                reason: 'dispatch_failed',
                status: 'DISPATCH_FAILED',
                extraMetadata: { fileKey, providerStatus: error.status || null, providerRetryable: Boolean(error.retryable) },
              });

              return tx.job.findUnique({ where: { jobId: currentJob.jobId }, include: { project: true } });
            });
            if (failedJob && emitJobUpdate) emitJobUpdate(failedJob, null);
          } catch (releaseError) {
            console.error('Could not release render reservation after dispatch failure:', releaseError);
          }
        }

        const refreshedUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        return res.status(error.status || 500).json({
          error: sanitizeRenderError(error.data || error.message, 'Failed to start render job'),
          retryable: Boolean(error.retryable),
          jobId: job?.jobId || null,
          dispatchStatus: job ? 'FAILED' : null,
          user: publicUser(refreshedUser),
        });
      }
    },

    async cancelJob(req, res) {
      const { jobId } = req.body;
      if (typeof jobId !== 'string' || jobId.trim() === '') return res.status(400).json({ error: 'Invalid jobId' });

      const job = await prisma.job.findFirst({ where: { jobId, userId: req.user.id }, include: { project: true } });
      if (!job) return res.status(404).json({ error: 'Job not found' });

      try {
        const providerJobId = job.providerJobId || job.jobId;
        const hasProviderJob = job.dispatchStatus === 'DISPATCHED' && providerJobId;
        const runpodResult = hasProviderJob
          ? await cancelRunpodJob(providerJobId)
          : { ok: true, status: 200, data: { id: providerJobId, status: 'CANCELLED', localOnly: true } };
        let updatedJob = job;

        if (runpodResult.ok) {
          updatedJob = await prisma.$transaction(async (tx) => {
            const cancelledJob = await tx.job.update({
              where: { jobId },
              data: {
                status: 'CANCELLED',
                dispatchStatus: hasProviderJob ? job.dispatchStatus : 'CANCELLED',
                cancelledAt: new Date(),
                billingState: job.reservationReleasedAt ? job.billingState : 'RELEASING',
                progress: {
                  ...(job.progress && typeof job.progress === 'object' ? job.progress : {}),
                  updatedAt: new Date().toISOString(),
                },
              },
              include: { project: true },
            });
            await releaseJobReservation({ client: tx, job: cancelledJob, reason: 'cancelled', status: 'CANCELLED' });
            return tx.job.findUnique({ where: { jobId }, include: { project: true } });
          });
          if (emitJobUpdate) emitJobUpdate(updatedJob, runpodResult.data);
        }

        return res.status(runpodResult.ok ? 200 : runpodResult.status).json({
          success: runpodResult.ok,
          status: runpodResult.status,
          provider: runpodResult.data,
          job: serializeJob(updatedJob, runpodResult.data),
        });
      } catch (error) {
        console.error('Cancel Error:', error);
        return res.status(500).json({ success: false, error: 'Failed to cancel render job' });
      }
    },
  };
}
