import 'dotenv/config';

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';

import { ACTIVE_JOB_STATUSES, SESSION_COOKIE_NAME, config, validateRequiredEnv } from './helpers/config.js';
import { publicErrorPayload, statusCodeForError } from './helpers/errors.js';
import { logger } from './helpers/logger.js';
import { buildOperationalSnapshot, requestIdMiddleware, requestLoggingMiddleware, responseRequestIdMiddleware } from './helpers/observability.js';
import { accountRateLimitKey, authAttemptRateLimitKey, createRateLimiter, createRateLimitStore, requireSameOriginForBrowserWrites, securityHeaders } from './helpers/security.js';
import { prisma } from './src/db.js';
import { authenticateToken, parseCookieHeader, requireAdmin, requireAuth } from './src/services/authService.js';
import { fetchRunpodJobStatus } from './src/services/runpodService.js';
import { jobIsProviderDispatched, persistRunpodStatus, providerJobIdForJob, serializeJob } from './src/services/jobService.js';

import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createBillingRouter } from './routes/billing.js';
import { createJobsRouter } from './routes/jobs.js';
import { createProjectsRouter } from './routes/projects.js';
import { createRenderRouter } from './routes/render.js';
import { createSystemRouter } from './routes/system.js';

validateRequiredEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const publicHttpPort = Number(process.env.PUBLIC_HTTP_PORT || 0);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestIdMiddleware);
app.use(responseRequestIdMiddleware);
app.use(securityHeaders);
app.use(requireSameOriginForBrowserWrites);
app.use(express.json({ limit: '1mb' }));
app.use(requestLoggingMiddleware);
app.use(express.static(publicDir));

const rateLimitStore = createRateLimitStore({
  store: config.rateLimitStore,
  redisUrl: config.rateLimitRedisUrl,
  keyPrefix: config.rateLimitKeyPrefix,
});
const authRateLimit = createRateLimiter({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMax,
  message: 'Too many auth attempts.',
  store: rateLimitStore,
  keyGenerator: authAttemptRateLimitKey,
  scope: 'auth',
});
const accountRateLimit = createRateLimiter({
  windowMs: config.accountRateLimitWindowMs,
  max: config.accountRateLimitMax,
  message: 'Too many account changes.',
  store: rateLimitStore,
  keyGenerator: accountRateLimitKey,
  scope: 'account',
});
const renderRateLimit = createRateLimiter({
  windowMs: config.renderRateLimitWindowMs,
  max: config.renderRateLimitMax,
  message: 'Too many render requests.',
  store: rateLimitStore,
  keyGenerator: accountRateLimitKey,
  scope: 'render',
});

const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.RENDERSPHERE_SOCKET_ORIGIN || false,
    credentials: true,
  },
});

function socketToken(socket) {
  const authToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
  if (authToken) return authToken;

  const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
  return cookies.get(SESSION_COOKIE_NAME) || null;
}

function emitJobUpdate(job, rpData = null) {
  if (!job) return;
  const payload = serializeJob(job, rpData);
  io.to(`user:${job.userId}`).to(`job:${job.jobId}`).emit('job_update', payload);
}

io.use(async (socket, next) => {
  try {
    const token = socketToken(socket);
    const auth = await authenticateToken(token ? decodeURIComponent(token) : null);
    if (!auth) return next(new Error('Authentication error'));

    socket.user = auth.user;
    return next();
  } catch (error) {
    return next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);
  logger.info('Socket connected', { context: 'socket', userId: socket.user.id });

  socket.on('subscribe_job', async (jobId) => {
    if (typeof jobId !== 'string' || !jobId.trim()) return;
    const job = await prisma.job.findFirst({ where: { jobId, userId: socket.user.id } });
    if (job) socket.join(`job:${jobId}`);
  });

  socket.on('unsubscribe_job', (jobId) => {
    if (typeof jobId === 'string') socket.leave(`job:${jobId}`);
  });
});

app.use(createSystemRouter({ buildOperationalSnapshot, config }));
app.use('/api/admin', createAdminRouter({ buildOperationalSnapshot, requireAdmin }));
app.use('/api/auth', createAuthRouter({ accountRateLimit, authRateLimit, requireAuth }));
app.use('/api/billing', createBillingRouter({ accountRateLimit, requireAuth }));
app.use('/api/projects', createProjectsRouter({ accountRateLimit, requireAuth }));
app.use('/api', createJobsRouter({ emitJobUpdate, requireAuth }));
app.use('/api', createRenderRouter({ emitJobUpdate, renderRateLimit, requireAuth }));

app.use((req, res, next) => {
  const systemPaths = new Set(['/healthz', '/readyz', '/metrics']);
  const isAssetRequest = req.method === 'GET'
    && !req.path.startsWith('/api')
    && !systemPaths.has(req.path)
    && (req.path.startsWith('/assets/') || Boolean(path.extname(req.path)));

  if (isAssetRequest) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const isFrontendNavigation = req.method === 'GET'
    && !req.path.startsWith('/api')
    && !systemPaths.has(req.path)
    && !path.extname(req.path)
    && req.accepts(['html', 'json']) === 'html';

  if (isFrontendNavigation) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }

  return next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = statusCodeForError(error);
  logger.error('Unhandled request error', {
    ...loggerRequestMeta(req),
    statusCode: status,
    error,
  });
  return res.status(status).json(publicErrorPayload(error, req, 'Internal server error', { production: config.isProduction }));
});

function loggerRequestMeta(req) {
  return {
    requestId: req?.id || req?.requestId || null,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    userId: req?.user?.id || undefined,
  };
}

const activeJobPollIntervalMs = Number(process.env.RENDERSPHERE_JOB_POLL_INTERVAL_MS || 5000);
const activeJobPoller = setInterval(async () => {
  try {
    const activeJobs = await prisma.job.findMany({
      where: { status: { in: Array.from(ACTIVE_JOB_STATUSES) } },
      include: { project: true },
    });

    await Promise.all(activeJobs.map(async (job) => {
      try {
        if (!jobIsProviderDispatched(job)) return;
        const rpData = await fetchRunpodJobStatus(providerJobIdForJob(job));
        const updatedJob = await persistRunpodStatus(job.userId, job.jobId, rpData);
        emitJobUpdate(updatedJob || job, rpData);
      } catch (error) {
        logger.warn('Could not poll RunPod job', {
          context: 'job_poller',
          jobId: job.jobId,
          providerJobId: providerJobIdForJob(job),
          error,
        });
      }
    }));
  } catch (error) {
    logger.error('Active job poller failed', { context: 'job_poller', error });
  }
}, activeJobPollIntervalMs);

function listen(httpServer, listenPort, label) {
  httpServer.listen(listenPort, () => logger.info('HTTP listener started', { context: 'server', label, port: listenPort }));
}

listen(server, port, 'Gateway');

if (Number.isInteger(publicHttpPort) && publicHttpPort > 0) {
  listen(http.createServer(app), publicHttpPort, 'Public HTTP listener');
}

async function shutdown(signal) {
  logger.info('Shutdown signal received', { context: 'server', signal });
  clearInterval(activeJobPoller);
  io.close();
  server.close(async () => {
    await rateLimitStore.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
