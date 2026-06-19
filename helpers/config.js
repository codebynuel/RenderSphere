import 'dotenv/config';

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
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
const MB = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 10 * 1024;

function parsePositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function parseNonNegativeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

const config = {
  maxUploadBytes: parsePositiveIntegerEnv('RENDERSPHERE_MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * MB,
  maxRenderSamples: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RENDER_SAMPLES', 2048),
  maxResolutionPct: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RESOLUTION_PCT', 150),
  maxAnimationFrames: parsePositiveIntegerEnv('RENDERSPHERE_MAX_ANIMATION_FRAMES', 250),
  maxConcurrentJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_CONCURRENT_JOBS', 1),
  maxQueuedJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_QUEUED_JOBS', 3),
  renderPricePerSecondUsd: parseNonNegativeNumberEnv('RENDERSPHERE_RENDER_PRICE_PER_SECOND_USD', 0.01),
  freeRenderCredits: parseNonNegativeNumberEnv('RENDERSPHERE_FREE_RENDER_CREDITS_USD', parseNonNegativeNumberEnv('RENDERSPHERE_FREE_RENDER_CREDITS', 0)),
  minRenderStartBalanceUsd: parseNonNegativeNumberEnv('RENDERSPHERE_MIN_RENDER_START_BALANCE_USD', 1),
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

export {
  ACTIVE_JOB_STATUSES,
  MB,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  VALID_DENOISERS,
  VALID_ENGINES,
  VALID_OUTPUT_FORMATS,
  config,
  validateRequiredEnv,
};
