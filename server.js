import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import http from 'http';

import {
  ACTIVE_JOB_STATUSES,
  MB,
  MONGODB_DB_NAME,
  MONGODB_URI,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  VALID_DENOISERS,
  VALID_ENGINES,
  VALID_OUTPUT_FORMATS,
  config,
  validateRequiredEnv,
} from './helpers/config.js';
import { readResponseJson } from './helpers/http.js';
import { createRateLimiter, requireSameOriginForBrowserWrites, securityHeaders } from './helpers/security.js';
import {
  connectStore,
  getStoreDbName,
  pingStore,
  readStore,
  updateStore,
} from './helpers/store.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createSystemRouter } from './routes/system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(requireSameOriginForBrowserWrites);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many auth attempts. Please try again later.',
});
const accountRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many account changes. Please try again later.',
});
const renderRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 12,
  message: 'Too many render requests. Please slow down and try again.',
});

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

async function verifyPassword(password, user) {
  const passwordHash = await hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(passwordHash.hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    starterBalanceUsd: typeof user.starterBalanceUsd === 'number' ? user.starterBalanceUsd : 0,
  };
}

function adminUser(user) {
  return {
    id: user.id,
    email: user.email,
    starterBalanceUsd: typeof user.starterBalanceUsd === 'number' ? user.starterBalanceUsd : 0,
    accessKeyCount: Array.isArray(user.accessKeys) ? user.accessKeys.length : 0,
    createdAt: user.createdAt,
  };
}

function normalizeAccessKeys(user) {
  if (Array.isArray(user.accessKeys) && user.accessKeys.length > 0) {
    return user.accessKeys;
  }

  if (user.apiKeyHash) {
    return [
      {
        id: crypto.randomUUID(),
        name: 'Legacy access key',
        tokenHash: user.apiKeyHash,
        tokenPreview: 'Legacy key',
        createdAt: user.apiKeyUpdatedAt || user.createdAt || nowIso(),
        lastUsedAt: null,
      },
    ];
  }

  return [];
}

function tokenPreview(token) {
  return `${token.slice(0, 10)}...${token.slice(-6)}`;
}

function publicAccessKey(accessKey, token = null) {
  return {
    id: accessKey.id,
    name: accessKey.name,
    token,
    preview: token ? tokenPreview(token) : accessKey.tokenPreview || (accessKey.tokenValue ? tokenPreview(accessKey.tokenValue) : 'Hidden after creation'),
    createdAt: accessKey.createdAt,
    lastUsedAt: accessKey.lastUsedAt || null,
  };
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function containsTraversalOrAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).includes('..');
}

function isSafeFileName(fileName) {
  return !containsTraversalOrAbsolutePath(fileName) && path.basename(fileName) === fileName;
}

function isSafeObjectKey(key) {
  return !containsTraversalOrAbsolutePath(key);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readInteger(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) return fallback;
  return numberValue;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function contentTypeForKey(key) {
  const extension = path.extname(key || '').toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.exr') return 'image/aces';
  if (extension === '.zip') return 'application/zip';
  return 'application/octet-stream';
}

function attachmentFileName(key) {
  return path.basename(key || 'render-output').replace(/[^a-zA-Z0-9._-]/g, '_') || 'render-output';
}

function renderedFileDownloadPath(jobId) {
  return `/api/rendered-files/${encodeURIComponent(jobId)}/download`;
}

function activeJobCount(store, userId) {
  return store.jobs.filter((job) => job.userId === userId && ACTIVE_JOB_STATUSES.has(job.status)).length;
}

function normalizeRenderSettings(body) {
  const isAnimation = normalizeBoolean(body.isAnimation, false);
  const startFrame = readInteger(body.startFrame, 1);
  const endFrame = isAnimation ? readInteger(body.endFrame, startFrame) : startFrame;
  const samples = readInteger(body.samples, 256);
  const resolutionPct = readInteger(body.resolutionPct, 100);
  const noiseThreshold = clampNumber(body.noiseThreshold, 0, 1, 0.01);

  if (startFrame < 0 || endFrame < 0 || endFrame < startFrame) {
    return { error: 'Invalid frame range' };
  }

  const frameCount = isAnimation ? endFrame - startFrame + 1 : 1;
  if (frameCount > config.maxAnimationFrames) {
    return { error: `Animation frame count exceeds the limit of ${config.maxAnimationFrames}` };
  }

  if (samples < 1 || samples > config.maxRenderSamples) {
    return { error: `Samples must be between 1 and ${config.maxRenderSamples}` };
  }

  if (resolutionPct < 1 || resolutionPct > config.maxResolutionPct) {
    return { error: `Resolution percentage must be between 1 and ${config.maxResolutionPct}` };
  }

  return {
    isAnimation,
    startFrame,
    endFrame,
    frameCount,
    samples,
    resolutionPct,
    noiseThreshold,
  };
}

function getBearerToken(req) {
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function parseCookies(req) {
  const rawCookie = req.get('cookie') || '';
  const cookies = new Map();

  for (const part of rawCookie.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) continue;

    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function getSessionCookie(req) {
  return parseCookies(req).get(SESSION_COOKIE_NAME) || null;
}

function getRequestToken(req) {
  const bearerToken = getBearerToken(req);
  if (bearerToken) return { token: bearerToken, source: 'bearer' };

  const cookieToken = getSessionCookie(req);
  if (cookieToken) return { token: cookieToken, source: 'cookie' };

  return { token: null, source: null };
}

function sessionCookieOptions(req, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = config.secureCookies || req.secure || req.get('x-forwarded-proto') === 'https';
  return [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${sessionCookieOptions(req)}`);
}

function clearSessionCookie(req, res) {
  const baseOptions = [
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');

  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; ${baseOptions}`,
    `${SESSION_COOKIE_NAME}=; ${baseOptions}; Secure`,
  ]);
}

async function authenticateToken(token) {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const store = await readStore();
  const now = Date.now();

  const session = store.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > now);
  if (session) {
    const user = store.users.find((item) => item.id === session.userId);
    return user ? { user, authType: 'session' } : null;
  }

  const user = store.users.find((item) => normalizeAccessKeys(item).some((accessKey) => accessKey.tokenHash === tokenHash));
  if (!user) return null;

  const accessKey = normalizeAccessKeys(user).find((item) => item.tokenHash === tokenHash);
  const lastUsedAt = accessKey?.lastUsedAt ? new Date(accessKey.lastUsedAt).getTime() : 0;
  if (!lastUsedAt || Date.now() - lastUsedAt > 5 * 60 * 1000) {
    await updateStore(async (nextStore) => {
      const nextUser = nextStore.users.find((item) => item.id === user.id);
      const nextAccessKey = nextUser ? normalizeAccessKeys(nextUser).find((item) => item.tokenHash === tokenHash) : null;
      if (nextAccessKey) nextAccessKey.lastUsedAt = nowIso();
    });
  }

  return { user, authType: 'accessKey' };
}

async function requireAuth(req, res, next) {
  try {
    const requestToken = getRequestToken(req);
    const auth = await authenticateToken(requestToken.token);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    req.user = auth.user;
    req.authType = auth.authType;
    req.authToken = requestToken.token;
    req.authSource = requestToken.source;
    next();
  } catch (error) {
    console.error("Auth Error:", error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!config.adminToken) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== config.adminToken) return res.status(401).json({ error: 'Admin authentication required' });
  next();
}

async function createSessionForUser(store, userId) {
  const token = randomToken('rs_session');
  const session = {
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  store.sessions = store.sessions.filter((item) => new Date(item.expiresAt).getTime() > Date.now());
  store.sessions.push(session);
  return token;
}

async function createApiKeyForUser(store, user) {
  const accessKey = randomToken('rs_live');
  user.accessKeys = normalizeAccessKeys(user);
  user.accessKeys.push({
    id: crypto.randomUUID(),
    name: `Access key ${user.accessKeys.length + 1}`,
    tokenHash: hashToken(accessKey),
    tokenPreview: tokenPreview(accessKey),
    createdAt: nowIso(),
    lastUsedAt: null,
  });
  user.apiKeyHash = null;
  user.apiKeyUpdatedAt = null;
  return accessKey;
}

function getRunpodResultKey(data) {
  return data?.output?.result_key || data?.output?.resultKey || data?.output?.key || data?.result_key || data?.resultKey || null;
}

function getRunpodExecutionSeconds(data, job) {
  const executionMs = Number(data?.executionTime ?? data?.output?.executionTime ?? data?.output?.execution_time);
  if (Number.isFinite(executionMs) && executionMs > 0) {
    return Math.max(1, Math.ceil(executionMs / 1000));
  }

  const durationSeconds = Number(data?.durationSeconds ?? data?.duration_seconds ?? data?.output?.durationSeconds ?? data?.output?.duration_seconds);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return Math.max(1, Math.ceil(durationSeconds));
  }

  const startedAt = new Date(job.createdAt || Date.now()).getTime();
  if (!Number.isFinite(startedAt)) return 1;
  return Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
}

async function fetchRunpodJobStatus(jobId) {
  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/status/${encodeURIComponent(jobId)}`;
  const response = await fetch(runpodUrl, {
    headers: { 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` },
  });
  const data = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(data.error || data.message || `RunPod status failed with ${response.status}`);
  }

  return data;
}

async function persistRunpodStatus(userId, jobId, rpData) {
  const status = rpData.status || 'UNKNOWN';
  const resultKey = getRunpodResultKey(rpData);

  await updateStore(async (nextStore) => {
    const nextJob = nextStore.jobs.find((item) => item.jobId === jobId && item.userId === userId);
    if (!nextJob) return;

    const previousStatus = nextJob.status;
    nextJob.status = status;
    nextJob.lastCheckedAt = nowIso();

    if (status === 'COMPLETED') {
      nextJob.resultKey = resultKey || nextJob.resultKey || null;
      nextJob.completedAt = nextJob.completedAt || nowIso();
      nextJob.error = null;

      if (nextJob.resultKey && !nextJob.billedAt) {
        const billableSeconds = getRunpodExecutionSeconds(rpData, nextJob);
        const priceUsd = roundMoney(billableSeconds * config.renderPricePerSecondUsd);
        const user = nextStore.users.find((item) => item.id === userId);

        nextJob.billableSeconds = billableSeconds;
        nextJob.priceUsd = priceUsd;
        nextJob.pricePerSecondUsd = config.renderPricePerSecondUsd;
        nextJob.billedAt = nowIso();

        if (user) {
          const currentBalance = typeof user.starterBalanceUsd === 'number' ? user.starterBalanceUsd : 0;
          user.starterBalanceUsd = roundMoney(currentBalance - priceUsd);
        }
      }
    } else if (status === 'FAILED') {
      nextJob.error = rpData.error || rpData.output?.message || rpData.output?.error || 'Unknown RunPod error';
      nextJob.failedAt = nextJob.failedAt || nowIso();
    } else if (status === 'CANCELLED') {
      nextJob.cancelledAt = nextJob.cancelledAt || nowIso();
    } else if (previousStatus === 'COMPLETED' && !nextJob.completedAt) {
      nextJob.completedAt = nowIso();
    }
  });
}

async function syncActiveJobsForUser(userId) {
  const store = await readStore();
  const syncableJobs = store.jobs.filter((job) => {
    if (job.userId !== userId || !job.jobId) return false;
    if (ACTIVE_JOB_STATUSES.has(job.status)) return true;
    return job.status === 'COMPLETED' && !job.resultKey;
  });

  await Promise.all(syncableJobs.map(async (job) => {
    try {
      const rpData = await fetchRunpodJobStatus(job.jobId);
      await persistRunpodStatus(userId, job.jobId, rpData);
    } catch (error) {
      console.error(`Could not sync RunPod job ${job.jobId}:`, error);
    }
  }));
}

validateRequiredEnv();
await connectStore({ uri: MONGODB_URI, dbName: MONGODB_DB_NAME });

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.use(createSystemRouter({
  config,
  getStoreDbName,
  pingStore,
}));

app.use('/api/admin', createAdminRouter({
  ACTIVE_JOB_STATUSES,
  adminUser,
  config,
  getStoreDbName,
  readStore,
  requireAdmin,
  updateStore,
}));

app.use('/api/auth', createAuthRouter({
  accountRateLimit,
  authRateLimit,
  clearSessionCookie,
  config,
  createApiKeyForUser,
  createSessionForUser,
  hashPassword,
  hashToken,
  normalizeAccessKeys,
  normalizeEmail,
  nowIso,
  publicAccessKey,
  publicUser,
  readStore,
  requireAuth,
  sessionCookieName: SESSION_COOKIE_NAME,
  setSessionCookie,
  updateStore,
  verifyPassword,
}));

app.get('/api/jobs', requireAuth, async (req, res) => {
  await syncActiveJobsForUser(req.user.id);

  const store = await readStore();
  const user = store.users.find((item) => item.id === req.user.id) || req.user;
  const jobs = store.jobs
    .filter((job) => job.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(({ runpodPayload, ...job }) => job);
  res.json({ jobs, user: publicUser(user) });
});

app.get('/api/rendered-files', requireAuth, async (req, res) => {
  await syncActiveJobsForUser(req.user.id);

  const store = await readStore();
  const user = store.users.find((item) => item.id === req.user.id) || req.user;
  const completedJobs = store.jobs
    .filter((job) => job.userId === req.user.id && job.status === 'COMPLETED' && job.resultKey)
    .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime());

  const files = completedJobs.map((job) => ({
    jobId: job.jobId,
    resultKey: job.resultKey,
    fileName: job.resultKey.split('/').pop(),
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    outputFormat: job.settings?.outputFormat || job.settings?.output_format || null,
    billableSeconds: job.billableSeconds || 0,
    priceUsd: typeof job.priceUsd === 'number' ? job.priceUsd : 0,
    downloadUrl: renderedFileDownloadPath(job.jobId),
  }));

  res.json({ files, user: publicUser(user) });
});

app.get('/api/rendered-files/:jobId/download', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const store = await readStore();
  const job = store.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);

  if (!job || job.status !== 'COMPLETED' || !job.resultKey) {
    return res.status(404).json({ error: 'Rendered file not found' });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: job.resultKey,
    });
    const object = await s3Client.send(command);
    const fileName = attachmentFileName(job.resultKey);

    res.setHeader('Content-Type', object.ContentType || contentTypeForKey(job.resultKey));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (object.ContentLength) {
      res.setHeader('Content-Length', String(object.ContentLength));
    }

    if (object.Body && typeof object.Body.pipe === 'function') {
      object.Body.pipe(res);
      return;
    }

    const body = object.Body?.transformToByteArray ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
    res.end(body);
  } catch (error) {
    console.error(`Could not proxy rendered file ${job.resultKey}:`, error);
    res.status(502).json({ error: 'Rendered file is temporarily unavailable' });
  }
});

app.get('/api/job-status/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const store = await readStore();
  const job = store.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const rpData = await fetchRunpodJobStatus(jobId);

    if (rpData.status === 'COMPLETED') {
      const resultKey = getRunpodResultKey(rpData);
      if (!resultKey) return res.status(502).json({ error: 'RunPod completed without a result key' });

      await persistRunpodStatus(req.user.id, jobId, rpData);

      res.json({ status: 'COMPLETED', downloadUrl: renderedFileDownloadPath(jobId) });
    } else if (rpData.status === 'FAILED') {
      await persistRunpodStatus(req.user.id, jobId, rpData);
      res.json({ status: 'FAILED', error: rpData.error });
    } else {
      await persistRunpodStatus(req.user.id, jobId, rpData);
      res.json({
        status: rpData.status,
        stream: rpData.stream || []
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to check status" });
  }
});

app.post('/api/get-upload-url', renderRateLimit, requireAuth, async (req, res) => {
  const { fileName } = req.body;
  const fileSizeBytes = Number(req.body.fileSizeBytes);

  if (!isSafeFileName(fileName)) {
    return res.status(400).json({ error: "Invalid fileName" });
  }

  if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
    return res.status(400).json({ error: "A valid fileSizeBytes value is required" });
  }

  if (fileSizeBytes > config.maxUploadBytes) {
    return res.status(413).json({
      error: `Packed .blend file exceeds the upload limit of ${Math.round(config.maxUploadBytes / MB)} MB`,
    });
  }

  const store = await readStore();

  const key = `renders/${req.user.id}/${Date.now()}-${fileName}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: 'application/octet-stream',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    await updateStore(async (store) => {
      store.uploads.push({
        key,
        userId: req.user.id,
        fileName,
        fileSizeBytes,
        used: false,
        createdAt: nowIso(),
      });
    });

    res.json({ uploadUrl, key });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate R2 pre-signed URL" });
  }
});

app.post('/api/trigger-render', renderRateLimit, requireAuth, async (req, res) => {
  const {
    fileKey,
    engine,
    outputFormat = 'PNG',
    denoiser = 'NONE',
  } = req.body;

  if (!isSafeObjectKey(fileKey)) {
    return res.status(400).json({ error: "Invalid fileKey" });
  }

  const store = await readStore();
  const upload = store.uploads.find((item) => item.key === fileKey && item.userId === req.user.id);
  if (!upload) {
    return res.status(403).json({ error: "This upload does not belong to the authenticated account" });
  }

  if (upload.used) {
    return res.status(409).json({ error: "This upload has already been used for a render job" });
  }

  const activeJobs = activeJobCount(store, req.user.id);
  if (activeJobs >= config.maxConcurrentJobsPerUser) {
    return res.status(429).json({ error: `This account already has ${activeJobs} active render job(s)` });
  }

  const queuedJobs = store.jobs.filter((job) => job.userId === req.user.id && ACTIVE_JOB_STATUSES.has(job.status)).length;
  if (queuedJobs >= config.maxQueuedJobsPerUser) {
    return res.status(429).json({ error: `This account has reached the queued job limit of ${config.maxQueuedJobsPerUser}` });
  }

  if (!VALID_ENGINES.has(engine)) {
    return res.status(400).json({ error: "Invalid engine" });
  }

  if (!VALID_OUTPUT_FORMATS.has(outputFormat)) {
    return res.status(400).json({ error: "Invalid outputFormat" });
  }

  if (!VALID_DENOISERS.has(denoiser)) {
    return res.status(400).json({ error: "Invalid denoiser" });
  }

  const normalizedSettings = normalizeRenderSettings(req.body);
  if (normalizedSettings.error) {
    return res.status(400).json({ error: normalizedSettings.error });
  }

  const runpodPayload = {
    input: {
      fileKey,
      engine,
      samples: normalizedSettings.samples,
      isAnimation: normalizedSettings.isAnimation,
      startFrame: normalizedSettings.startFrame,
      endFrame: normalizedSettings.endFrame,
      outputFormat,
      resolutionPct: normalizedSettings.resolutionPct,
      denoiser,
      noiseThreshold: normalizedSettings.noiseThreshold,
      output_format: outputFormat,
      resolution_pct: normalizedSettings.resolutionPct,
      noise_threshold: normalizedSettings.noiseThreshold,
    }
  };

  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`;

  try {
    const response = await fetch(runpodUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`
      },
      body: JSON.stringify(runpodPayload)
    });

    const data = await readResponseJson(response);

    if (response.ok) {
      await updateStore(async (nextStore) => {
        const nextUpload = nextStore.uploads.find((item) => item.key === fileKey && item.userId === req.user.id);
        if (nextUpload) nextUpload.used = true;
        nextStore.jobs.push({
          jobId: data.id,
          userId: req.user.id,
          fileKey,
          status: data.status || 'SUBMITTED',
          settings: runpodPayload.input,
          frameCount: normalizedSettings.frameCount,
          billableSeconds: 0,
          createdAt: nowIso(),
        });
      });

      console.log(`Render Job Dispatched. Job ID: ${data.id}`);
      res.json({ success: true, jobId: data.id, status: data.status });
    } else {
      console.error("RunPod Error:", data);
      res.status(502).json({ error: data.error || data.message || "Failed to trigger RunPod" });
    }
  } catch (error) {
    console.error("Gateway Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/api/cancel-job', requireAuth, async (req, res) => {
  const { jobId } = req.body;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return res.status(400).json({ error: "Invalid jobId" });
  }

  const store = await readStore();
  const job = store.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/cancel/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(runpodUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` }
    });
    const data = await readResponseJson(response);

    await updateStore(async (nextStore) => {
      const nextJob = nextStore.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);
      if (nextJob) {
        nextJob.status = response.ok ? 'CANCELLED' : nextJob.status;
        nextJob.cancelledAt = response.ok ? nowIso() : nextJob.cancelledAt;
      }
    });

    res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      runpod: data,
    });
  } catch (error) {
    console.error("Cancel Error:", error);
    res.status(500).json({ success: false, error: "Failed to cancel RunPod job" });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Gateway running on port ${port}`));

const publicHttpPort = Number(process.env.PUBLIC_HTTP_PORT || 0);
if (Number.isInteger(publicHttpPort) && publicHttpPort > 0) {
  http.createServer(app).listen(publicHttpPort, () => {
    console.log(`Public HTTP listener running on port ${publicHttpPort}`);
  });
}
