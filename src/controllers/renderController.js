import { ACTIVE_JOB_STATUSES, config } from '../../helpers/config.js';
import { prisma } from '../db.js';
import { publicUser } from '../services/authService.js';
import { buildRunpodInput, normalizeRenderSettings, sanitizeRenderError, serializeJob, validateRenderChoices } from '../services/jobService.js';
import { cancelRunpodJob, startRunpodRender } from '../services/runpodService.js';
import { createUploadUrl, isSafeFileName, isSafeObjectKey } from '../services/storageService.js';

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

      if (!isSafeObjectKey(fileKey)) return res.status(400).json({ error: 'Invalid fileKey' });

      const choiceError = validateRenderChoices({ engine, outputFormat, denoiser });
      if (choiceError) return res.status(400).json({ error: choiceError });

      const normalizedSettings = normalizeRenderSettings(req.body);
      if (normalizedSettings.error) return res.status(400).json({ error: normalizedSettings.error });

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

      try {
        const data = await startRunpodRender(runpodInput);
        const job = await prisma.$transaction(async (tx) => {
          await tx.upload.update({ where: { key: fileKey }, data: { used: true } });
          return tx.job.create({
            data: {
              jobId: data.id,
              userId: req.user.id,
              projectId: project?.id || null,
              fileKey,
              status: data.status || 'SUBMITTED',
              settings: runpodInput,
              frameCount: normalizedSettings.frameCount,
              progress: { percent: 2, updatedAt: new Date().toISOString() },
            },
            include: { project: true },
          });
        });

        if (emitJobUpdate) emitJobUpdate(job, data);
        console.log(`Render job dispatched. Job ID: ${data.id}`);
        return res.json({ success: true, jobId: data.id, status: data.status, job: serializeJob(job, data), user: publicUser(user) });
      } catch (error) {
        console.error('Render dispatch error:', error.data || error);
        return res.status(error.status || 500).json({ error: sanitizeRenderError(error.data || error.message, 'Failed to start render job') });
      }
    },

    async cancelJob(req, res) {
      const { jobId } = req.body;
      if (typeof jobId !== 'string' || jobId.trim() === '') return res.status(400).json({ error: 'Invalid jobId' });

      const job = await prisma.job.findFirst({ where: { jobId, userId: req.user.id }, include: { project: true } });
      if (!job) return res.status(404).json({ error: 'Job not found' });

      try {
        const runpodResult = await cancelRunpodJob(jobId);
        let updatedJob = job;

        if (runpodResult.ok) {
          updatedJob = await prisma.job.update({
            where: { jobId },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              progress: {
                ...(job.progress && typeof job.progress === 'object' ? job.progress : {}),
                updatedAt: new Date().toISOString(),
              },
            },
            include: { project: true },
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
