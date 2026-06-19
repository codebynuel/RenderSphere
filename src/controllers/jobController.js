import { config } from '../../helpers/config.js';
import { prisma } from '../db.js';
import { publicUser } from '../services/authService.js';
import { attachmentFileName, contentTypeForKey, getRenderedObject } from '../services/storageService.js';
import { fetchRunpodJobStatus, getRunpodResultKey } from '../services/runpodService.js';
import { jobIsProviderDispatched, persistRunpodStatus, providerJobIdForJob, renderedFileDownloadPath, sanitizeRenderError, serializeJob, serializeRenderedFile, syncActiveJobsForUser } from '../services/jobService.js';

export function createJobController({ emitJobUpdate = null } = {}) {
  return {
    async listJobs(req, res) {
      await syncActiveJobsForUser(req.user.id, emitJobUpdate);

      const [user, jobs] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.job.findMany({
          where: { userId: req.user.id },
          orderBy: { createdAt: 'desc' },
          include: { project: true },
        }),
      ]);

      res.json({ jobs: jobs.map((job) => serializeJob(job)), user: publicUser(user) });
    },

    async listRenderedFiles(req, res) {
      await syncActiveJobsForUser(req.user.id, emitJobUpdate);

      const [user, completedJobs] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.job.findMany({
          where: { userId: req.user.id, status: 'COMPLETED', resultKey: { not: null } },
          orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
          include: { project: true },
        }),
      ]);

      res.json({ files: completedJobs.map(serializeRenderedFile), user: publicUser(user) });
    },

    async downloadRenderedFile(req, res) {
      const { jobId } = req.params;
      const job = await prisma.job.findFirst({ where: { jobId, userId: req.user.id } });

      if (!job || job.status !== 'COMPLETED' || !job.resultKey) {
        return res.status(404).json({ error: 'Rendered file not found' });
      }

      try {
        const object = await getRenderedObject(job.resultKey);
        const fileName = attachmentFileName(job.resultKey);

        res.setHeader('Content-Type', object.ContentType || contentTypeForKey(job.resultKey));
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));

        if (object.Body && typeof object.Body.pipe === 'function') {
          object.Body.pipe(res);
          return undefined;
        }

        const body = object.Body?.transformToByteArray ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
        res.end(body);
        return undefined;
      } catch (error) {
        console.error(`Could not proxy rendered file ${job.resultKey}:`, error);
        return res.status(502).json({ error: 'Rendered file is temporarily unavailable' });
      }
    },

    async getJobStatus(req, res) {
      const { jobId } = req.params;
      const job = await prisma.job.findFirst({ where: { jobId, userId: req.user.id }, include: { project: true } });

      if (!job) return res.status(404).json({ error: 'Job not found' });

      try {
        if (!jobIsProviderDispatched(job)) {
          return res.json({ status: job.status, stream: [], job: serializeJob(job) });
        }

        const rpData = await fetchRunpodJobStatus(providerJobIdForJob(job));
        const updatedJob = await persistRunpodStatus(req.user.id, jobId, rpData);
        if (updatedJob && emitJobUpdate) emitJobUpdate(updatedJob, rpData);

        if (rpData.status === 'COMPLETED') {
          const resultKey = getRunpodResultKey(rpData) || updatedJob?.resultKey;
          if (!resultKey) return res.status(502).json({ error: 'Render completed without a result file' });
          return res.json({ status: 'COMPLETED', downloadUrl: renderedFileDownloadPath(jobId), job: serializeJob(updatedJob, rpData) });
        }

        if (rpData.status === 'FAILED') {
          return res.json({
            status: 'FAILED',
            error: sanitizeRenderError(updatedJob?.error || rpData.error || rpData.output),
            job: serializeJob(updatedJob, rpData),
          });
        }

        if (rpData.status === 'CANCELLED') {
          return res.json({ status: 'CANCELLED', job: serializeJob(updatedJob, rpData) });
        }

        return res.json({ status: rpData.status, stream: rpData.stream || [], job: serializeJob(updatedJob || job, rpData) });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to check status' });
      }
    },

    async getConfig(req, res) {
      res.json({ limits: config });
    },
  };
}
