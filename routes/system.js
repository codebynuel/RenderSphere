import express from 'express';
import { getEnvironmentReadiness } from '../helpers/config.js';
import { prisma } from '../src/db.js';

function limitSummary(config) {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxRenderSamples: config.maxRenderSamples,
    maxResolutionPct: config.maxResolutionPct,
    maxAnimationFrames: config.maxAnimationFrames,
    maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
    maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
    renderPricePerSecondUsd: config.renderPricePerSecondUsd,
    renderEstimateBaseSecondsPerFrame: config.renderEstimateBaseSecondsPerFrame,
    minRenderReservationUsd: config.minRenderReservationUsd,
    defaultRenderMaxBudgetUsd: config.defaultRenderMaxBudgetUsd,
    maxRenderBudgetUsd: config.maxRenderBudgetUsd,
    minRenderStartBalanceUsd: config.minRenderStartBalanceUsd,
    runpodRequestTimeoutMs: config.runpodRequestTimeoutMs,
    runpodStatusMaxRetries: config.runpodStatusMaxRetries,
    runpodCancelMaxRetries: config.runpodCancelMaxRetries,
    runpodRetryBackoffMs: config.runpodRetryBackoffMs,
  };
}

function createSystemRouter({ buildOperationalSnapshot, config }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.json({
      status: 'ok',
      service: 'rendersphere-web',
      uptimeSeconds: Math.round(process.uptime()),
      requestId: req.id || req.requestId || null,
    });
  });

  router.get('/readyz', async (req, res) => {
    const checks = {
      environment: getEnvironmentReadiness(),
      prisma: { status: 'unknown' },
      database: { status: 'unknown', provider: 'postgres' },
      dependencies: {
        r2Configured: false,
        runpodConfigured: false,
      },
    };

    checks.dependencies.r2Configured = checks.environment.r2Configured;
    checks.dependencies.runpodConfigured = checks.environment.runpodConfigured;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.prisma = { status: 'ok', client: 'accessible' };
      checks.database = { status: 'ok', provider: 'postgres' };
    } catch {
      checks.prisma = { status: 'error', client: 'unavailable' };
      checks.database = { status: 'error', provider: 'postgres', error: 'Database is not reachable' };
    }

    const ready = checks.environment.status === 'ok'
      && checks.prisma.status === 'ok'
      && checks.database.status === 'ok';

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      service: 'rendersphere-web',
      checks,
      alertHints: {
        databaseUnavailable: checks.database.status !== 'ok',
        environmentInvalid: checks.environment.status !== 'ok',
        providerConfigurationMissing: !checks.dependencies.r2Configured || !checks.dependencies.runpodConfigured,
      },
      requestId: req.id || req.requestId || null,
    });
  });

  router.get('/metrics', async (req, res) => {
    if (!config.publicMetricsEnabled) return res.status(404).json({ error: 'Not found', requestId: req.id || req.requestId || null });
    const snapshot = await buildOperationalSnapshot();
    return res.json({ ...snapshot, requestId: req.id || req.requestId || null });
  });

  router.get('/api/config', (req, res) => {
    res.json({
      supportEmail: config.supportEmail,
      starterBalanceUsd: config.freeRenderCredits,
      inviteRequired: Boolean(config.inviteCode),
      limits: limitSummary(config),
      observability: {
        requestIdHeader: 'X-Request-Id',
        publicMetricsEnabled: config.publicMetricsEnabled,
      },
    });
  });

  return router;
}

export { createSystemRouter };
