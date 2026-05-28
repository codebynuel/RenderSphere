import 'dotenv/config';

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';

import { ACTIVE_JOB_STATUSES, SESSION_COOKIE_NAME, config, validateRequiredEnv } from './helpers/config.js';
import { createRateLimiter, requireSameOriginForBrowserWrites, securityHeaders } from './helpers/security.js';
import { prisma } from './src/db.js';
import { authenticateToken, parseCookieHeader, requireAdmin, requireAuth } from './src/services/authService.js';
import { fetchRenderJobStatus } from './src/services/renderProviderService.js';
import { persistProviderStatus, serializeJob } from './src/services/jobService.js';

import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createJobsRouter } from './routes/jobs.js';
import { createProjectsRouter } from './routes/projects.js';
import { createRenderRouter } from './routes/render.js';
import { createSystemRouter } from './routes/system.js';

validateRequiredEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const publicHttpPort = Number(process.env.PUBLIC_HTTP_PORT || 0);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(requireSameOriginForBrowserWrites);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const authRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many auth attempts.' });
const accountRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many account changes.' });
const renderRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 12, message: 'Too many render requests.' });

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
  console.log(`Socket connected for user ${socket.user.id}`);

  socket.on('subscribe_job', async (jobId) => {
    if (typeof jobId !== 'string' || !jobId.trim()) return;
    const job = await prisma.job.findFirst({ where: { jobId, userId: socket.user.id } });
    if (job) socket.join(`job:${jobId}`);
  });

  socket.on('unsubscribe_job', (jobId) => {
    if (typeof jobId === 'string') socket.leave(`job:${jobId}`);
  });
});

app.use(createSystemRouter({ config }));
app.use('/api/admin', createAdminRouter({ requireAdmin }));
app.use('/api/auth', createAuthRouter({ accountRateLimit, authRateLimit, requireAuth }));
app.use('/api/projects', createProjectsRouter({ requireAuth }));
app.use('/api', createJobsRouter({ emitJobUpdate, requireAuth }));
app.use('/api', createRenderRouter({ emitJobUpdate, renderRateLimit, requireAuth }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && req.path !== '/healthz') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

const activeJobPollIntervalMs = Number(process.env.RENDERSPHERE_JOB_POLL_INTERVAL_MS || 5000);
const activeJobPoller = setInterval(async () => {
  try {
    const activeJobs = await prisma.job.findMany({
      where: { status: { in: Array.from(ACTIVE_JOB_STATUSES) } },
      include: { project: true },
    });

    await Promise.all(activeJobs.map(async (job) => {
      try {
        const providerData = await fetchRenderJobStatus(job.jobId);
        const updatedJob = await persistProviderStatus(job.userId, job.jobId, providerData);
        emitJobUpdate(updatedJob || job, providerData);
      } catch (error) {
        console.error(`Could not poll render job ${job.jobId}:`, error.message || error);
      }
    }));
  } catch (error) {
    console.error('Active job poller failed:', error);
  }
}, activeJobPollIntervalMs);

function listen(httpServer, listenPort, label) {
  httpServer.listen(listenPort, () => console.log(`${label} running on port ${listenPort}`));
}

listen(server, port, 'Gateway');

if (Number.isInteger(publicHttpPort) && publicHttpPort > 0) {
  listen(http.createServer(app), publicHttpPort, 'Public HTTP listener');
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(activeJobPoller);
  io.close();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
