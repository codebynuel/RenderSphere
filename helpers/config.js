import 'dotenv/config';

const BASE_REQUIRED_ENV_VARS = [
  'DATABASE_URL',
];

const PROVIDER_REQUIRED_ENV_VARS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_API_KEY',
];

const PRODUCTION_REQUIRED_ENV_VARS = [
  ...BASE_REQUIRED_ENV_VARS,
  ...PROVIDER_REQUIRED_ENV_VARS,
  'RENDERSPHERE_PUBLIC_URL',
];

const VALID_RATE_LIMIT_STORES = new Set(['memory', 'redis']);
const VALID_ENGINES = new Set(['CYCLES', 'BLENDER_EEVEE_NEXT']);
const VALID_OUTPUT_FORMATS = new Set(['PNG', 'JPEG', 'OPEN_EXR', 'OPEN_EXR_MULTILAYER']);
const VALID_DENOISERS = new Set(['NONE', 'OPTIX', 'OPENIMAGEDENOISE']);
const ACTIVE_JOB_STATUSES = new Set(['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SESSION_COOKIE_NAME = 'rs_session';
const MB = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 10 * 1024;

function parsePositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function parsePositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseNonNegativeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function isProductionEnv() {
  return process.env.NODE_ENV === 'production';
}

function envPresent(name) {
  return String(process.env[name] || '').trim().length > 0;
}

function unique(values) {
  return Array.from(new Set(values));
}

function requiredEnvVars({ production = isProductionEnv() } = {}) {
  return production ? unique(PRODUCTION_REQUIRED_ENV_VARS) : unique(BASE_REQUIRED_ENV_VARS);
}

function groupConfigured(names) {
  return names.every(envPresent);
}

function urlEnvError(name, { required = false } = {}) {
  if (!envPresent(name)) return required ? `${name} is required` : null;
  try {
    // eslint-disable-next-line no-new
    new URL(process.env[name]);
    return null;
  } catch {
    return `${name} must be a valid URL`;
  }
}

function databaseUrlError() {
  if (!envPresent('DATABASE_URL')) return 'DATABASE_URL is required';
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    if (!['postgresql:', 'postgres:'].includes(databaseUrl.protocol)) {
      return 'DATABASE_URL must use the postgresql:// or postgres:// protocol';
    }
    return null;
  } catch {
    return 'DATABASE_URL must be a valid PostgreSQL URL';
  }
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: isProductionEnv(),
  publicUrl: process.env.RENDERSPHERE_PUBLIC_URL || '',
  maxUploadBytes: parsePositiveIntegerEnv('RENDERSPHERE_MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * MB,
  defaultPageSize: parsePositiveIntegerEnv('RENDERSPHERE_DEFAULT_PAGE_SIZE', 25),
  maxPageSize: parsePositiveIntegerEnv('RENDERSPHERE_MAX_PAGE_SIZE', 100),
  rateLimitStore: (process.env.RENDERSPHERE_RATE_LIMIT_STORE || 'memory').trim().toLowerCase(),
  rateLimitRedisUrl: process.env.RENDERSPHERE_RATE_LIMIT_REDIS_URL || process.env.REDIS_URL || '',
  rateLimitKeyPrefix: process.env.RENDERSPHERE_RATE_LIMIT_KEY_PREFIX || 'rendersphere',
  authRateLimitWindowMs: parsePositiveIntegerEnv('RENDERSPHERE_AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  authRateLimitMax: parsePositiveIntegerEnv('RENDERSPHERE_AUTH_RATE_LIMIT_MAX', 20),
  accountRateLimitWindowMs: parsePositiveIntegerEnv('RENDERSPHERE_ACCOUNT_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  accountRateLimitMax: parsePositiveIntegerEnv('RENDERSPHERE_ACCOUNT_RATE_LIMIT_MAX', 20),
  renderRateLimitWindowMs: parsePositiveIntegerEnv('RENDERSPHERE_RENDER_RATE_LIMIT_WINDOW_MS', 60 * 1000),
  renderRateLimitMax: parsePositiveIntegerEnv('RENDERSPHERE_RENDER_RATE_LIMIT_MAX', 12),
  maxRenderSamples: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RENDER_SAMPLES', 2048),
  maxResolutionPct: parsePositiveIntegerEnv('RENDERSPHERE_MAX_RESOLUTION_PCT', 150),
  maxAnimationFrames: parsePositiveIntegerEnv('RENDERSPHERE_MAX_ANIMATION_FRAMES', 250),
  maxConcurrentJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_CONCURRENT_JOBS', 1),
  maxQueuedJobsPerUser: parsePositiveIntegerEnv('RENDERSPHERE_MAX_QUEUED_JOBS', 3),
  renderPricePerSecondUsd: parseNonNegativeNumberEnv('RENDERSPHERE_RENDER_PRICE_PER_SECOND_USD', 0.01),
  renderEstimateBaseSecondsPerFrame: parsePositiveNumberEnv('RENDERSPHERE_RENDER_ESTIMATE_BASE_SECONDS_PER_FRAME', 60),
  minRenderReservationUsd: parseNonNegativeNumberEnv('RENDERSPHERE_MIN_RENDER_RESERVATION_USD', 1),
  defaultRenderMaxBudgetUsd: parsePositiveNumberEnv('RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD', 10),
  maxRenderBudgetUsd: parsePositiveNumberEnv('RENDERSPHERE_MAX_RENDER_BUDGET_USD', 250),
  freeRenderCredits: parseNonNegativeNumberEnv('RENDERSPHERE_FREE_RENDER_CREDITS_USD', parseNonNegativeNumberEnv('RENDERSPHERE_FREE_RENDER_CREDITS', 0)),
  minRenderStartBalanceUsd: parseNonNegativeNumberEnv('RENDERSPHERE_MIN_RENDER_START_BALANCE_USD', 1),
  supportEmail: process.env.RENDERSPHERE_SUPPORT_EMAIL || 'support@rendersphere.app',
  inviteCode: process.env.RENDERSPHERE_INVITE_CODE || '',
  adminToken: process.env.RENDERSPHERE_ADMIN_TOKEN || '',
  jobRecordRetentionDays: parsePositiveIntegerEnv('RENDERSPHERE_JOB_RECORD_RETENTION_DAYS', 30),
  runpodRequestTimeoutMs: parsePositiveIntegerEnv('RENDERSPHERE_RUNPOD_REQUEST_TIMEOUT_MS', 15000),
  runpodStatusMaxRetries: parsePositiveIntegerEnv('RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES', 2),
  runpodCancelMaxRetries: parsePositiveIntegerEnv('RENDERSPHERE_RUNPOD_CANCEL_MAX_RETRIES', 1),
  runpodRetryBackoffMs: parsePositiveIntegerEnv('RENDERSPHERE_RUNPOD_RETRY_BACKOFF_MS', 300),
  secureCookies: process.env.RENDERSPHERE_SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production',
};

function environmentValidation({ production = config.isProduction } = {}) {
  const required = requiredEnvVars({ production });
  const missing = required.filter((name) => !envPresent(name));
  const invalid = [];

  const dbError = databaseUrlError();
  if (dbError && !missing.includes('DATABASE_URL')) invalid.push(dbError);

  const publicUrlError = urlEnvError('RENDERSPHERE_PUBLIC_URL', { required: production });
  if (publicUrlError && !missing.includes('RENDERSPHERE_PUBLIC_URL')) invalid.push(publicUrlError);

  if (!VALID_RATE_LIMIT_STORES.has(config.rateLimitStore)) {
    invalid.push('RENDERSPHERE_RATE_LIMIT_STORE must be memory or redis');
  }

  if (config.rateLimitStore === 'redis' && !config.rateLimitRedisUrl) {
    invalid.push('RENDERSPHERE_RATE_LIMIT_REDIS_URL is required when RENDERSPHERE_RATE_LIMIT_STORE=redis');
  }

  if (config.defaultPageSize > config.maxPageSize) {
    invalid.push('RENDERSPHERE_DEFAULT_PAGE_SIZE must be less than or equal to RENDERSPHERE_MAX_PAGE_SIZE');
  }

  if (config.defaultRenderMaxBudgetUsd > config.maxRenderBudgetUsd) {
    invalid.push('RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD must be less than or equal to RENDERSPHERE_MAX_RENDER_BUDGET_USD');
  }

  if (config.minRenderReservationUsd > config.maxRenderBudgetUsd) {
    invalid.push('RENDERSPHERE_MIN_RENDER_RESERVATION_USD must be less than or equal to RENDERSPHERE_MAX_RENDER_BUDGET_USD');
  }

  return {
    production,
    required,
    missing,
    invalid,
    ok: missing.length === 0 && invalid.length === 0,
  };
}

function getEnvironmentReadiness({ production = config.isProduction } = {}) {
  const validation = environmentValidation({ production });
  return {
    status: validation.ok ? 'ok' : 'error',
    production,
    missingRequired: validation.missing,
    invalid: validation.invalid,
    requiredPresent: validation.required.filter(envPresent),
    r2Configured: groupConfigured(['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']),
    runpodConfigured: groupConfigured(['RUNPOD_ENDPOINT_ID', 'RUNPOD_API_KEY']),
    publicUrlConfigured: envPresent('RENDERSPHERE_PUBLIC_URL'),
    rateLimitStore: config.rateLimitStore,
    redisRateLimitConfigured: config.rateLimitStore === 'redis' ? Boolean(config.rateLimitRedisUrl) : null,
  };
}

function validateRequiredEnv(options = {}) {
  const validation = environmentValidation(options);
  if (!validation.ok) {
    const messages = [];
    if (validation.missing.length) messages.push(`missing required environment variables: ${validation.missing.join(', ')}`);
    if (validation.invalid.length) messages.push(validation.invalid.join('; '));
    throw new Error(`Invalid environment configuration: ${messages.join('; ')}`);
  }
  return validation;
}

export {
  ACTIVE_JOB_STATUSES,
  BASE_REQUIRED_ENV_VARS,
  MB,
  PRODUCTION_REQUIRED_ENV_VARS,
  PROVIDER_REQUIRED_ENV_VARS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  VALID_DENOISERS,
  VALID_ENGINES,
  VALID_OUTPUT_FORMATS,
  config,
  environmentValidation,
  getEnvironmentReadiness,
  requiredEnvVars,
  validateRequiredEnv,
};
