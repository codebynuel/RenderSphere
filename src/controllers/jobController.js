import { config } from '../../helpers/config.js';
import { logger, withRequest } from '../../helpers/logger.js';
import { prisma } from '../db.js';
import { publicUser } from '../services/authService.js';
import { buildPaginationMeta, parseJobStatusFilter, parsePaginationQuery, parseSearchQuery } from './pagination.js';
import { attachmentFileName, contentTypeForKey, getRenderedObject } from '../services/storageService.js';
import { fetchRunpodJobStatus, getRunpodResultKey } from '../services/runpodService.js';
import { jobIsProviderDispatched, persistRunpodStatus, providerJobIdForJob, renderedFileDownloadPath, sanitizeRenderError, serializeJob, serializeRenderedFile, syncActiveJobsForUser } from '../services/jobService.js';

function buildJobSearchWhere(search) {
  if (!search) return {};
  return {
    OR: [
      { jobId: { contains: search, mode: 'insensitive' } },
      { fileKey: { contains: search, mode: 'insensitive' } },
      { resultKey: { contains: search, mode: 'insensitive' } },
      { status: { contains: search, mode: 'insensitive' } },
      { project: { is: { name: { contains: search, mode: 'insensitive' } } } },
    ],
  };
}

export function createJobController({ emitJobUpdate = null } = {}) {
  return {
    async listJobs(req, res) {
      await syncActiveJobsForUser(req.user.id, emitJobUpdate, { requestId: req.id || req.requestId || null });

      const pagination = parsePaginationQuery(req.query);
      const statusFilter = parseJobStatusFilter(req.query.status);
      const search = parseSearchQuery(req.query);
      const teamId = req.query.teamId || '';
      const where = {
        userId: req.user.id,
        ...statusFilter.where,
        ...buildJobSearchWhere(search),
        ...(teamId ? { project: { teamId } } : {}),
      };

      const [user, totalItems, jobs] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.job.count({ where }),
        prisma.job.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: pagination.skip,
          take: pagination.take,
          include: { project: true },
        }),
      ]);

      res.json({
        jobs: jobs.map((job) => serializeJob(job)),
        pagination: buildPaginationMeta({ ...pagination, totalItems }),
        filters: { status: statusFilter.status, search },
        user: publicUser(user),
      });
    },

    async listRenderedFiles(req, res) {
      await syncActiveJobsForUser(req.user.id, emitJobUpdate, { requestId: req.id || req.requestId || null });

      const pagination = parsePaginationQuery(req.query);
      const search = parseSearchQuery(req.query);
      const teamId = req.query.teamId || '';
      const where = {
        userId: req.user.id,
        status: 'COMPLETED',
        resultKey: { not: null },
        ...buildJobSearchWhere(search),
        ...(teamId ? { project: { teamId } } : {}),
      };

      const [user, totalItems, completedJobs] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.job.count({ where }),
        prisma.job.findMany({
          where,
          orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
          skip: pagination.skip,
          take: pagination.take,
          include: { project: true },
        }),
      ]);

      res.json({
        files: completedJobs.map(serializeRenderedFile),
        pagination: buildPaginationMeta({ ...pagination, totalItems }),
        filters: { search },
        user: publicUser(user),
      });
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
        logger.error('Could not proxy rendered file', withRequest(req, { context: 'storage', jobId, resultKey: job.resultKey, error }));
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

        const rpData = await fetchRunpodJobStatus(providerJobIdForJob(job), { requestId: req.id || req.requestId || null });
        const updatedJob = await persistRunpodStatus(req.user.id, jobId, rpData, { requestId: req.id || req.requestId || null });
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
        logger.error('Failed to check render job status', withRequest(req, { context: 'job_status', jobId, providerJobId: providerJobIdForJob(job), error }));
        return res.status(500).json({ error: 'Failed to check status' });
      }
    },

    async getConfig(req, res) {
      res.json({ limits: config });
    },
  };
}
