import { randomUUID } from 'crypto';

import { ACTIVE_JOB_STATUSES, config } from '../../helpers/config.js';
import { logger, withRequest } from '../../helpers/logger.js';
import { prisma } from '../db.js';
import { publicUser } from '../services/authService.js';
import { reserveRenderCredits } from '../services/creditService.js';
import { buildRunpodInput, estimateRenderCostUsd, normalizeRenderSettings, releaseJobReservation, resolveRenderBudget, sanitizeRenderError, serializeJob, validateRenderChoices } from '../services/jobService.js';
import { cancelRunpodJob, startRunpodRender } from '../services/runpodService.js';
import { createUploadUrl, isSafeFileName, isSafeObjectKey } from '../services/storageService.js';
import { userCanSubmitToProject } from '../services/projectService.js';

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

      // Enforce access key budget cap before upload
      if (req.accessKey?.budgetCapUsd && req.accessKey.budgetSpentUsd >= req.accessKey.budgetCapUsd) {
        return res.status(402).json({ error: 'Access key budget cap has been reached.' });
      }

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
        logger.error('Failed to generate R2 upload URL', withRequest(req, { context: 'storage', error }));
        return res.status(500).json({ error: 'Failed to generate R2 pre-signed URL' });
      }
    },

    async triggerRender(req, res) {
      const { fileKey, engine, outputFormat = 'PNG', denoiser = 'NONE', teamId: requestedTeamId } = req.body;
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

      const [upload, activeJobs, user] = await Promise.all([
        prisma.upload.findFirst({ where: { key: fileKey, userId: req.user.id } }),
        prisma.job.count({ where: { userId: req.user.id, status: { in: Array.from(ACTIVE_JOB_STATUSES) } } }),
        prisma.user.findUnique({ where: { id: req.user.id } }),
      ]);

      if (!upload) return res.status(403).json({ error: 'This upload does not belong to the authenticated account' });
      if (upload.used) return res.status(409).json({ error: 'This upload has already been used' });
      if (activeJobs >= config.maxConcurrentJobsPerUser) return res.status(429).json({ error: 'Active job limit reached' });

      // Enforce project-level access (project owner or COLLABORATOR+)
      if (projectId) {
        const canSubmit = await userCanSubmitToProject(projectId, req.user.id);
        if (!canSubmit) return res.status(403).json({ error: 'You do not have permission to submit renders to this project.' });
      }

      // Enforce access key budget cap
      if (req.accessKey?.budgetCapUsd && req.accessKey.budgetSpentUsd >= req.accessKey.budgetCapUsd) {
        return res.status(402).json({ error: 'Access key budget cap has been reached. Create a new key or increase the cap.' });
      }

      // Enforce access key project scoping
      if (req.accessKey?.scopeType === 'PROJECT' && req.accessKey.scopeProjectId) {
        if (!projectId || projectId !== req.accessKey.scopeProjectId) {
          return res.status(403).json({ error: 'This access key is scoped to a specific project and cannot be used for this job.' });
        }
      }

      // Team context: resolve billing user and enforce member budget
      let billingUserId = req.user.id;
      let teamMembership = null;
      const teamId = String(requestedTeamId || '').trim() || null;
      if (teamId) {
        teamMembership = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId, userId: req.user.id } },
          include: { team: { select: { ownerId: true } } },
        });
        if (!teamMembership) return res.status(403).json({ error: 'You are not a member of this team.' });
        if (teamMembership.role === 'READ_ONLY') return res.status(403).json({ error: 'Read-only team members cannot submit renders.' });

        // Check member budget cap
        if (teamMembership.budgetCapUsd) {
          const spentResult = await prisma.job.aggregate({
            where: { userId: req.user.id, billedAt: { not: null } },
            _sum: { priceUsd: true },
          });
          const memberSpent = Number(spentResult._sum.priceUsd || 0);
          if (memberSpent >= Number(teamMembership.budgetCapUsd)) {
            return res.status(402).json({ error: 'Your team budget cap has been reached. Contact the team owner to increase it.' });
          }
        }

        billingUserId = teamMembership.team.ownerId;
      }

      const runpodInput = buildRunpodInput({ fileKey, engine, outputFormat, denoiser, normalizedSettings });
      const costEstimate = estimateRenderCostUsd({ engine, outputFormat, denoiser, normalizedSettings });
      const budget = resolveRenderBudget({ estimatedCostUsd: costEstimate.estimatedCostUsd });
      const localJobId = internalDispatchReference();
      const reservationReferenceId = localJobId;

      // Check balance of the billing user (either the member or team owner)
      const billingUser = await prisma.user.findUnique({ where: { id: billingUserId } });
      const availableBalance = Number(billingUser?.starterBalanceUsd || 0);
      if (availableBalance < budget.reservationUsd) {
        return res.status(402).json({
          error: `Insufficient prepaid credits. This render requires a $${budget.reservationUsd.toFixed(2)} reservation, but only $${availableBalance.toFixed(2)} is available.`,
          requiredUsd: budget.reservationUsd,
          availableUsd: availableBalance,
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
              accessKeyId: req.accessKey?.id || null,
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
                requestId: req.id || req.requestId || null,
                requestIdempotencyKey: requestIdempotencyKey || null,
                phase: 'local_job_created',
              }),
              progress: { percent: 1, updatedAt: new Date().toISOString(), message: 'Preparing provider dispatch' },
            },
            include: { project: true },
          });

          const reserved = await reserveRenderCredits({
            client: tx,
            userId: billingUserId,
            referenceId: reservationReferenceId,
            jobId: createdJob.jobId,
            amountUsd: budget.reservationUsd,
            estimatedCostUsd: costEstimate.estimatedCostUsd,
            maxBudgetUsd: budget.maxBudgetUsd,
            metadata: {
              requestId: req.id || req.requestId || null,
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
            billedToUserId: billingUserId !== req.user.id ? billingUserId : undefined,
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

        logger.info('Dispatching render job to provider', withRequest(req, { context: 'render_dispatch', jobId: localJobId, idempotencyKey: scopedIdempotencyKey || localJobId }));
        const data = await startRunpodRender(
          { ...runpodInput, dispatchReference: localJobId, idempotencyKey: scopedIdempotencyKey },
          { idempotencyKey: scopedIdempotencyKey || localJobId, requestId: req.id || req.requestId || null }
        );
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
        logger.info('Render job dispatched', withRequest(req, { context: 'render_dispatch', jobId: localJobId, providerJobId }));
        const refreshedUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        return res.json({ success: true, jobId: job.jobId, providerJobId, status: job.status, dispatchStatus: job.dispatchStatus, job: serializeJob(job, data), user: publicUser(refreshedUser) });
      } catch (error) {
        logger.error('Render dispatch error', withRequest(req, { context: 'render_dispatch', jobId: job?.jobId || localJobId, providerJobId, error }));

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
            logger.error('RunPod accepted a job but local provider id attachment needs manual reconciliation', withRequest(req, {
              context: 'render_dispatch',
              jobId: job.jobId,
              providerJobId,
              error: reconcileError,
            }));
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
                extraMetadata: { requestId: req.id || req.requestId || null, fileKey, providerStatus: error.status || null, providerRetryable: Boolean(error.retryable) },
              });

              return tx.job.findUnique({ where: { jobId: currentJob.jobId }, include: { project: true } });
            });
            if (failedJob && emitJobUpdate) emitJobUpdate(failedJob, null);
          } catch (releaseError) {
            logger.error('Could not release render reservation after dispatch failure', withRequest(req, { context: 'billing', jobId: job.jobId, error: releaseError }));
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
          ? await cancelRunpodJob(providerJobId, { requestId: req.id || req.requestId || null })
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
            await releaseJobReservation({
              client: tx,
              job: cancelledJob,
              reason: 'cancelled',
              status: 'CANCELLED',
              extraMetadata: { requestId: req.id || req.requestId || null },
            });
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
        logger.error('Cancel render job failed', withRequest(req, { context: 'render_cancel', jobId, error }));
        return res.status(500).json({ success: false, error: 'Failed to cancel render job' });
      }
    },
  };
}
