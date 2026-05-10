import express from 'express';

function createSystemRouter({ config, getStoreDbName, pingStore }) {
  const router = express.Router();

  router.get('/healthz', async (req, res) => {
    try {
      await pingStore();
      res.json({
        status: 'ok',
        database: getStoreDbName(),
        limits: {
          maxUploadBytes: config.maxUploadBytes,
          maxRenderSamples: config.maxRenderSamples,
          maxResolutionPct: config.maxResolutionPct,
          maxAnimationFrames: config.maxAnimationFrames,
          maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
          maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
        },
      });
    } catch {
      res.status(500).json({ status: 'error', error: 'MongoDB is not reachable' });
    }
  });

  router.get('/api/config', (req, res) => {
    res.json({
      supportEmail: config.supportEmail,
      starterBalanceUsd: 0,
      inviteRequired: Boolean(config.inviteCode),
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxRenderSamples: config.maxRenderSamples,
        maxResolutionPct: config.maxResolutionPct,
        maxAnimationFrames: config.maxAnimationFrames,
        maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
        maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
      },
    });
  });

  return router;
}

export { createSystemRouter };
