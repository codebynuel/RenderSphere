import express from 'express';
import { prisma } from '../src/db.js';

function createSystemRouter({ config }) {
  const router = express.Router();

  router.get('/healthz', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        database: 'postgres',
        limits: {
          maxUploadBytes: config.maxUploadBytes,
          maxRenderSamples: config.maxRenderSamples,
          maxResolutionPct: config.maxResolutionPct,
          maxAnimationFrames: config.maxAnimationFrames,
          maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
          maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
          renderPricePerSecondUsd: config.renderPricePerSecondUsd,
          minRenderStartBalanceUsd: config.minRenderStartBalanceUsd,
        },
      });
    } catch {
      res.status(500).json({ status: 'error', error: 'Database is not reachable' });
    }
  });

  router.get('/api/config', (req, res) => {
    res.json({
      supportEmail: config.supportEmail,
      starterBalanceUsd: config.freeRenderCredits,
      inviteRequired: Boolean(config.inviteCode),
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxRenderSamples: config.maxRenderSamples,
        maxResolutionPct: config.maxResolutionPct,
        maxAnimationFrames: config.maxAnimationFrames,
        maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
        maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
        renderPricePerSecondUsd: config.renderPricePerSecondUsd,
        minRenderStartBalanceUsd: config.minRenderStartBalanceUsd,
      },
    });
  });

  return router;
}

export { createSystemRouter };
