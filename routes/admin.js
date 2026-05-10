import express from 'express';

function createAdminRouter({
  ACTIVE_JOB_STATUSES,
  adminUser,
  config,
  getStoreDbName,
  readStore,
  requireAdmin,
  updateStore,
}) {
  const router = express.Router();

  router.use(requireAdmin);

  router.get('/summary', async (req, res) => {
    const store = await readStore();
    const activeJobs = store.jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
    const failedJobs = store.jobs.filter((job) => job.status === 'FAILED');
    const completedJobs = store.jobs.filter((job) => job.status === 'COMPLETED');

    res.json({
      users: store.users.length,
      uploads: store.uploads.length,
      jobs: store.jobs.length,
      activeJobs: activeJobs.length,
      failedJobs: failedJobs.length,
      completedJobs: completedJobs.length,
      database: getStoreDbName(),
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxRenderSamples: config.maxRenderSamples,
        maxResolutionPct: config.maxResolutionPct,
        maxAnimationFrames: config.maxAnimationFrames,
        maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
        maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
        starterBalanceUsd: 0,
        jobRecordRetentionDays: config.jobRecordRetentionDays,
      },
    });
  });

  router.get('/users', async (req, res) => {
    const store = await readStore();
    const users = store.users
      .map((user) => {
        const jobs = store.jobs.filter((job) => job.userId === user.id);
        return {
          ...adminUser(user),
          jobs: jobs.length,
          activeJobs: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ users });
  });

  router.get('/jobs', async (req, res) => {
    const store = await readStore();
    const jobs = store.jobs
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100)
      .map((job) => ({
        jobId: job.jobId,
        userId: job.userId,
        fileKey: job.fileKey,
        status: job.status,
        frameCount: job.frameCount,
        billableSeconds: job.billableSeconds || 0,
        resultKey: job.resultKey,
        error: job.error,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        cancelledAt: job.cancelledAt,
        settings: job.settings,
      }));

    res.json({ jobs });
  });

  router.post('/cleanup-records', async (req, res) => {
    const cutoff = Date.now() - config.jobRecordRetentionDays * 24 * 60 * 60 * 1000;
    const result = await updateStore(async (store) => {
      const before = {
        sessions: store.sessions.length,
        uploads: store.uploads.length,
        jobs: store.jobs.length,
      };

      store.sessions = store.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
      store.uploads = store.uploads.filter((upload) => new Date(upload.createdAt).getTime() >= cutoff);
      store.jobs = store.jobs.filter((job) => {
        if (ACTIVE_JOB_STATUSES.has(job.status)) return true;
        return new Date(job.createdAt).getTime() >= cutoff;
      });

      return {
        removed: {
          sessions: before.sessions - store.sessions.length,
          uploads: before.uploads - store.uploads.length,
          jobs: before.jobs - store.jobs.length,
        },
      };
    });

    res.json(result);
  });

  return router;
}

export { createAdminRouter };
