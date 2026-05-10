import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const REQUIRED_ENV_VARS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_API_KEY',
];
const VALID_ENGINES = new Set(['CYCLES', 'BLENDER_EEVEE_NEXT']);
const VALID_OUTPUT_FORMATS = new Set(['PNG', 'JPEG', 'OPEN_EXR', 'OPEN_EXR_MULTILAYER']);
const VALID_DENOISERS = new Set(['NONE', 'OPTIX', 'OPENIMAGEDENOISE']);
const ACTIVE_JOB_STATUSES = new Set(['SUBMITTED', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SESSION_COOKIE_NAME = 'rs_session';
const DATA_DIR = process.env.RENDERSPHERE_DATA_DIR || path.join(__dirname, '.data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MB = 1024 * 1024;

let writeQueue = Promise.resolve();
const rateLimitBuckets = new Map();

function parsePositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function parseNonNegativeIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

const config = {
  maxUploadBytes: parsePositiveIntegerEnv('RENDERSPHERE_MAX_UPLOAD_MB', 500) * MB,
  maxRenderSamples: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RENDER_SAMPLES', 2048),
  maxResolutionPct: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RESOLUTION_PCT', 150),
  maxAnimationFrames: parsePositiveIntegerEnv('RENDERSPHERE_MAX_ANIMATION_FRAMES', 250),
  maxConcurrentJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_CONCURRENT_JOBS', 1),
  maxQueuedJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_QUEUED_JOBS', 3),
  freeRenderCredits: parseNonNegativeIntegerEnv('RENDERSPHERE_FREE_RENDER_CREDITS', 3),
  supportEmail: process.env.RENDERSPHERE_SUPPORT_EMAIL || 'support@rendersphere.app',
  inviteCode: process.env.RENDERSPHERE_INVITE_CODE || '',
  adminToken: process.env.RENDERSPHERE_ADMIN_TOKEN || '',
  jobRecordRetentionDays: parsePositiveIntegerEnv('RENDERSPHERE_JOB_RECORD_RETENTION_DAYS', 30),
  secureCookies: process.env.RENDERSPHERE_SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production',
};

function validateRequiredEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function createRateLimiter({ windowMs, max, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.method}:${req.path}`;
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

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

function createEmptyStore() {
  return {
    users: [],
    sessions: [],
    uploads: [],
    jobs: [],
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    return { ...createEmptyStore(), ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return createEmptyStore();
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpFile = `${STORE_FILE}.tmp`;
  await fs.writeFile(tmpFile, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tmpFile, STORE_FILE);
}

async function updateStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  return writeQueue;
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
    creditsRemaining: typeof user.creditsRemaining === 'number' ? user.creditsRemaining : config.freeRenderCredits,
  };
}

function adminUser(user) {
  return {
    id: user.id,
    email: user.email,
    creditsRemaining: typeof user.creditsRemaining === 'number' ? user.creditsRemaining : config.freeRenderCredits,
    apiKeyUpdatedAt: user.apiKeyUpdatedAt || null,
    createdAt: user.createdAt,
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
    return { error: `Animation frame count exceeds the MVP limit of ${config.maxAnimationFrames}` };
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
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; ${sessionCookieOptions(req, 0)}`);
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

  const user = store.users.find((item) => item.apiKeyHash === tokenHash);
  return user ? { user, authType: 'apiKey' } : null;
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

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
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
  const apiKey = randomToken('rs_live');
  user.apiKeyHash = hashToken(apiKey);
  user.apiKeyUpdatedAt = nowIso();
  return apiKey;
}

validateRequiredEnv();

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.get('/healthz', async (req, res) => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    res.json({
      status: 'ok',
      dataDir: DATA_DIR,
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxRenderSamples: config.maxRenderSamples,
        maxResolutionPct: config.maxResolutionPct,
        maxAnimationFrames: config.maxAnimationFrames,
        maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
        maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: 'Data directory is not writable' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    supportEmail: config.supportEmail,
    freeRenderCredits: config.freeRenderCredits,
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

app.get('/api/admin/summary', requireAdmin, async (req, res) => {
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
    dataDir: DATA_DIR,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxRenderSamples: config.maxRenderSamples,
      maxResolutionPct: config.maxResolutionPct,
      maxAnimationFrames: config.maxAnimationFrames,
      maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
      maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
      freeRenderCredits: config.freeRenderCredits,
      jobRecordRetentionDays: config.jobRecordRetentionDays,
    },
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
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

app.get('/api/admin/jobs', requireAdmin, async (req, res) => {
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
      creditsCharged: job.creditsCharged,
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

app.post('/api/admin/cleanup-records', requireAdmin, async (req, res) => {
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

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const inviteCode = String(req.body.inviteCode || '');

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  if (config.inviteCode && inviteCode !== config.inviteCode) {
    return res.status(403).json({ error: 'A valid invite code is required' });
  }

  try {
    const result = await updateStore(async (store) => {
      if (store.users.some((user) => user.email === email)) {
        return { error: 'An account with this email already exists' };
      }

      const passwordHash = await hashPassword(password);
      const user = {
        id: crypto.randomUUID(),
        email,
        passwordHash: passwordHash.hash,
        passwordSalt: passwordHash.salt,
        apiKeyHash: null,
        apiKeyUpdatedAt: null,
        creditsRemaining: config.freeRenderCredits,
        createdAt: nowIso(),
      };
      const apiKey = await createApiKeyForUser(store, user);
      const token = await createSessionForUser(store, user.id);
      store.users.push(user);

      return { user: publicUser(user), token, apiKey };
    });

    if (result.error) return res.status(409).json({ error: result.error });
    setSessionCookie(req, res, result.token);
    res.status(201).json(result);
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  try {
    const store = await readStore();
    const user = store.users.find((item) => item.email === email);
    if (!user || !(await verifyPassword(password, user))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = await updateStore(async (nextStore) => createSessionForUser(nextStore, user.id));
    setSessionCookie(req, res, token);
    res.json({ user: publicUser(user), token });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const tokenHash = hashToken(req.authToken);
  await updateStore(async (store) => {
    store.sessions = store.sessions.filter((session) => session.tokenHash !== tokenHash);
  });
  clearSessionCookie(req, res);
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), authType: req.authType });
});

app.post('/api/auth/api-key', accountRateLimit, requireAuth, async (req, res) => {
  const result = await updateStore(async (store) => {
    const user = store.users.find((item) => item.id === req.user.id);
    if (!user) return null;
    const apiKey = await createApiKeyForUser(store, user);
    return { apiKey, updatedAt: user.apiKeyUpdatedAt };
  });

  if (!result) return res.status(404).json({ error: 'User not found' });
  res.json(result);
});

app.get('/api/jobs', requireAuth, async (req, res) => {
  const store = await readStore();
  const jobs = store.jobs
    .filter((job) => job.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(({ runpodPayload, ...job }) => job);
  res.json({ jobs });
});

app.get('/api/job-status/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const store = await readStore();
  const job = store.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/status/${encodeURIComponent(jobId)}`;

  try {
    const rpRes = await fetch(runpodUrl, {
      headers: { 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` }
    });
    const rpData = await readResponseJson(rpRes);

    if (rpData.status === 'COMPLETED') {
      const resultKey = rpData.output?.result_key;
      if (!resultKey) return res.status(502).json({ error: 'RunPod completed without a result key' });

      await updateStore(async (nextStore) => {
        const nextJob = nextStore.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);
        if (nextJob) {
          nextJob.status = 'COMPLETED';
          nextJob.resultKey = resultKey;
          nextJob.completedAt = nowIso();
        }
      });

      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: resultKey,
      });
      const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      res.json({ status: 'COMPLETED', downloadUrl });
    } else if (rpData.status === 'FAILED') {
      await updateStore(async (nextStore) => {
        const nextJob = nextStore.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);
        if (nextJob) {
          nextJob.status = 'FAILED';
          nextJob.error = rpData.error || 'Unknown RunPod error';
          nextJob.failedAt = nowIso();
        }
      });
      res.json({ status: 'FAILED', error: rpData.error });
    } else {
      await updateStore(async (nextStore) => {
        const nextJob = nextStore.jobs.find((item) => item.jobId === jobId && item.userId === req.user.id);
        if (nextJob) nextJob.status = rpData.status || nextJob.status;
      });
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
      error: `Packed .blend file exceeds the MVP upload limit of ${Math.round(config.maxUploadBytes / MB)} MB`,
    });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.id === req.user.id);
  const creditsRemaining = typeof user?.creditsRemaining === 'number' ? user.creditsRemaining : config.freeRenderCredits;
  if (creditsRemaining <= 0) {
    return res.status(402).json({ error: "This account has no render credits remaining" });
  }

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

  const user = store.users.find((item) => item.id === req.user.id);
  const creditsRemaining = typeof user?.creditsRemaining === 'number' ? user.creditsRemaining : config.freeRenderCredits;
  if (creditsRemaining <= 0) {
    return res.status(402).json({ error: "This account has no render credits remaining" });
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
        const nextUser = nextStore.users.find((item) => item.id === req.user.id);
        if (nextUser) {
          nextUser.creditsRemaining = Math.max(
            0,
            (typeof nextUser.creditsRemaining === 'number' ? nextUser.creditsRemaining : config.freeRenderCredits) - 1
          );
        }
        nextStore.jobs.push({
          jobId: data.id,
          userId: req.user.id,
          fileKey,
          status: data.status || 'SUBMITTED',
          settings: runpodPayload.input,
          frameCount: normalizedSettings.frameCount,
          creditsCharged: 1,
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
