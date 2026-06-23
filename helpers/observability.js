import { randomUUID } from 'crypto';

import { ACTIVE_JOB_STATUSES, config, getEnvironmentReadiness } from './config.js';
import { logger, withRequest } from './logger.js';
import { prisma } from '../src/db.js';

const requestMetrics = new Map();
const startedAt = new Date();

function isValidRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
}

function requestIdMiddleware(req, res, next) {
  const inbound = req.get('x-request-id') || req.get('x-correlation-id');
  const requestId = isValidRequestId(inbound) ? inbound : randomUUID();
  req.id = requestId;
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  return next();
}

function responseRequestIdMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && !Object.prototype.hasOwnProperty.call(body, 'requestId')) {
      return originalJson({ ...body, requestId: req.id || req.requestId || null });
    }
    return originalJson(body);
  };
  return next();
}

function normalizePath(pathname = '') {
  return String(pathname || '')
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/render:[0-9a-f-]+/gi, 'render::id')
    .replace(/mock-runpod-[^/]+/gi, 'mock-runpod::id')
    .replace(/\/[^/]{24,}(?=\/|$)/g, '/:id');
}

function routeLabel(req) {
  if (req.route?.path) return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
  return `${req.method} ${normalizePath(req.path || req.originalUrl || req.url)}`;
}

function statusClass(statusCode) {
  return `${Math.floor(Number(statusCode || 500) / 100)}xx`;
}

function observeHttpRequest({ route, statusCode, durationMs }) {
  const key = `${route}|${statusClass(statusCode)}`;
  const current = requestMetrics.get(key) || {
    route,
    statusClass: statusClass(statusCode),
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  current.count += 1;
  current.totalDurationMs += durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
  requestMetrics.set(key, current);
}

function requestLoggingMiddleware(req, res, next) {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const route = routeLabel(req);
    observeHttpRequest({ route, statusCode: res.statusCode, durationMs });

    if (config.requestLoggingEnabled) {
      const log = res.statusCode >= 500 ? logger.error : res.statusCode >= 400 ? logger.warn : logger.info;
      log('HTTP request completed', withRequest(req, {
        route,
        statusCode: res.statusCode,
        statusClass: statusClass(res.statusCode),
        durationMs: Math.round(durationMs),
        contentLength: res.getHeader('content-length') || undefined,
      }));
    }
  });

  return next();
}

function httpMetricsSnapshot() {
  return Array.from(requestMetrics.values())
    .sort((a, b) => a.route.localeCompare(b.route) || a.statusClass.localeCompare(b.statusClass))
    .map((item) => ({
      route: item.route,
      statusClass: item.statusClass,
      count: item.count,
      avgDurationMs: item.count > 0 ? Math.round(item.totalDurationMs / item.count) : 0,
      maxDurationMs: Math.round(item.maxDurationMs),
    }));
}

async function countByField(model, field, where = {}) {
  const rows = await model.groupBy({
    by: [field],
    where,
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row[field] || 'UNKNOWN', row._count._all]));
}

async function buildOperationalSnapshot() {
  const [jobStatusCounts, dispatchStatusCounts, billingStateCounts, creditTypeCounts, auditEventsLastHour, readiness] = await Promise.all([
    countByField(prisma.job, 'status'),
    countByField(prisma.job, 'dispatchStatus'),
    countByField(prisma.job, 'billingState'),
    countByField(prisma.creditTransaction, 'type'),
    prisma.creditAuditEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } }),
    Promise.resolve(getEnvironmentReadiness()),
  ]);

  const recentFailureCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const [activeJobs, dispatchingWithoutProvider, unreleasedReservations, recentlyFailedJobs] = await Promise.all([
    prisma.job.count({ where: { status: { in: Array.from(ACTIVE_JOB_STATUSES) } } }),
    prisma.job.count({ where: { dispatchStatus: 'DISPATCHING', providerJobId: null } }),
    prisma.job.count({
      where: {
        reservedCreditsUsd: { gt: 0 },
        reservationReleasedAt: null,
        billingState: { in: ['RESERVED', 'RELEASING', 'SETTLING'] },
      },
    }),
    prisma.job.count({
      where: {
        OR: [
          { failedAt: { gte: recentFailureCutoff } },
          { status: 'DISPATCH_FAILED', createdAt: { gte: recentFailureCutoff } },
        ],
      },
    }),
  ]);

  const memoryUsage = process.memoryUsage();
  const memoryUsageMb = Math.round(memoryUsage.rss / 1024 / 1024);

  return {
    generatedAt: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memoryUsageMb,
    nodeVersion: process.version,
    platform: process.platform,
    activeJobs,
    process: {
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: config.nodeEnv,
    },
    http: httpMetricsSnapshot(),
    jobs: {
      active: activeJobs,
      byStatus: jobStatusCounts,
      dispatch: {
        byStatus: dispatchStatusCounts,
        dispatchingWithoutProvider,
      },
      recentlyFailedJobs,
    },
    billing: {
      byState: billingStateCounts,
      unreleasedReservations,
      creditTransactionsByType: creditTypeCounts,
      auditEventsLastHour,
    },
    providers: {
      database: { configured: true, provider: 'postgres' },
      r2: { configured: readiness.r2Configured },
      runpod: { configured: readiness.runpodConfigured },
      rateLimitStore: readiness.rateLimitStore,
      redisRateLimitConfigured: readiness.redisRateLimitConfigured,
    },
    readiness: {
      status: readiness.status,
      missingRequired: readiness.missingRequired,
      invalid: readiness.invalid,
    },
  };
}

export {
  buildOperationalSnapshot,
  httpMetricsSnapshot,
  requestIdMiddleware,
  requestLoggingMiddleware,
  responseRequestIdMiddleware,
};
