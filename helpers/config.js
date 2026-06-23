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
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const VALID_LOG_FORMATS = new Set(['auto', 'json', 'pretty']);
const VALID_PAYPAL_ENVIRONMENTS = new Set(['sandbox', 'live']);
const DEFAULT_PAYPAL_PREPAID_PACKAGES = Object.freeze([
  { id: 'starter-10', amountUsd: 10, currency: 'USD', label: '$10 prepaid credits' },
  { id: 'creator-25', amountUsd: 25, currency: 'USD', label: '$25 prepaid credits' },
  { id: 'studio-50', amountUsd: 50, currency: 'USD', label: '$50 prepaid credits' },
]);
const DEFAULT_PAYPAL_CUSTOM_TOP_UP = Object.freeze({
  minAmountUsd: 5,
  maxAmountUsd: 500,
  currency: 'USD',
  decimalPlaces: 2,
});
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

function parseBooleanEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function normalizedChoiceEnv(name, allowed, fallback) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return allowed.has(value) ? value : fallback;
}

function parsePositiveNumberValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseIntegerValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return parsed;
}

function envValue(names, fallback = '') {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return fallback;
}

function normalizedChoiceValue(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
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

function normalizePrepaidPackage(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = String(candidate.id || '').trim();
  const amountUsd = Number(candidate.amountUsd ?? candidate.amount ?? candidate.value);
  const currency = String(candidate.currency || 'USD').trim().toUpperCase();
  const label = String(candidate.label || `$${amountUsd} prepaid credits`).trim();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(id)) return null;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { id, amountUsd, currency, label };
}

function parsePrepaidPackageToken(token) {
  const [id, amountUsd, currencyOrLabel, ...labelParts] = String(token || '').split(':').map((part) => part.trim());
  if (!id || !amountUsd) return null;
  const hasCurrency = /^[a-zA-Z]{3}$/.test(currencyOrLabel || '');
  return normalizePrepaidPackage({
    id,
    amountUsd,
    currency: hasCurrency ? currencyOrLabel : 'USD',
    label: hasCurrency ? labelParts.join(':') : [currencyOrLabel, ...labelParts].filter(Boolean).join(':'),
  });
}

function parsePayPalPrepaidPackages() {
  const raw = envValue(['RENDERSPHERE_PAYPAL_PREPAID_PACKAGES', 'PAYPAL_PREPAID_PACKAGES']);
  if (!raw) return [...DEFAULT_PAYPAL_PREPAID_PACKAGES];

  let parsed = null;
  if (raw.trim().startsWith('[')) {
    try {
      parsed = JSON.parse(raw).map(normalizePrepaidPackage).filter(Boolean);
    } catch {
      parsed = [];
    }
  } else {
    parsed = raw.split(/[;,]/).map(parsePrepaidPackageToken).filter(Boolean);
  }

  const seen = new Set();
  return parsed.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function parsePayPalCustomTopUpConfig() {
  const currency = envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_CURRENCY', 'PAYPAL_CUSTOM_TOPUP_CURRENCY'], DEFAULT_PAYPAL_CUSTOM_TOP_UP.currency).toUpperCase();
  return {
    minAmountUsd: parsePositiveNumberValue(
      envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD', 'PAYPAL_CUSTOM_TOPUP_MIN_USD'], String(DEFAULT_PAYPAL_CUSTOM_TOP_UP.minAmountUsd)),
      DEFAULT_PAYPAL_CUSTOM_TOP_UP.minAmountUsd,
    ),
    maxAmountUsd: parsePositiveNumberValue(
      envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD', 'PAYPAL_CUSTOM_TOPUP_MAX_USD'], String(DEFAULT_PAYPAL_CUSTOM_TOP_UP.maxAmountUsd)),
      DEFAULT_PAYPAL_CUSTOM_TOP_UP.maxAmountUsd,
    ),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_PAYPAL_CUSTOM_TOP_UP.currency,
    decimalPlaces: parseIntegerValue(
      envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES', 'PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES'], String(DEFAULT_PAYPAL_CUSTOM_TOP_UP.decimalPlaces)),
      DEFAULT_PAYPAL_CUSTOM_TOP_UP.decimalPlaces,
    ),
  };
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
  logLevel: normalizedChoiceEnv('RENDERSPHERE_LOG_LEVEL', VALID_LOG_LEVELS, isProductionEnv() ? 'info' : 'debug'),
  logFormat: normalizedChoiceEnv('RENDERSPHERE_LOG_FORMAT', VALID_LOG_FORMATS, 'auto') === 'auto'
    ? (isProductionEnv() ? 'json' : 'pretty')
    : normalizedChoiceEnv('RENDERSPHERE_LOG_FORMAT', VALID_LOG_FORMATS, 'auto'),
  requestLoggingEnabled: parseBooleanEnv('RENDERSPHERE_REQUEST_LOGGING', true),
  publicMetricsEnabled: parseBooleanEnv('RENDERSPHERE_PUBLIC_METRICS', false),
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
  paypal: {
    environment: normalizedChoiceValue(envValue(['RENDERSPHERE_PAYPAL_ENVIRONMENT', 'PAYPAL_ENVIRONMENT'], 'sandbox'), VALID_PAYPAL_ENVIRONMENTS, 'sandbox'),
    clientId: envValue(['RENDERSPHERE_PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_ID']),
    clientSecret: envValue(['RENDERSPHERE_PAYPAL_CLIENT_SECRET', 'PAYPAL_CLIENT_SECRET']),
    webhookId: envValue(['RENDERSPHERE_PAYPAL_WEBHOOK_ID', 'PAYPAL_WEBHOOK_ID']),
    mock: parseBooleanEnv('RENDERSPHERE_PAYPAL_MOCK', false),
    prepaidPackages: parsePayPalPrepaidPackages(),
    customTopUp: parsePayPalCustomTopUpConfig(),
  },
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

  if (!VALID_LOG_LEVELS.has(config.logLevel)) {
    invalid.push('RENDERSPHERE_LOG_LEVEL must be debug, info, warn, error, or silent');
  }

  if (!VALID_LOG_FORMATS.has(config.logFormat)) {
    invalid.push('RENDERSPHERE_LOG_FORMAT must be auto, json, or pretty');
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

  const paypalEnvironment = envValue(['RENDERSPHERE_PAYPAL_ENVIRONMENT', 'PAYPAL_ENVIRONMENT']);
  if (paypalEnvironment && !VALID_PAYPAL_ENVIRONMENTS.has(paypalEnvironment.toLowerCase())) {
    invalid.push('RENDERSPHERE_PAYPAL_ENVIRONMENT must be sandbox or live');
  }

  if (!config.paypal.prepaidPackages.length) {
    invalid.push('RENDERSPHERE_PAYPAL_PREPAID_PACKAGES must define at least one valid package');
  }

  const customTopUpMin = envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD', 'PAYPAL_CUSTOM_TOPUP_MIN_USD']);
  const customTopUpMax = envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD', 'PAYPAL_CUSTOM_TOPUP_MAX_USD']);
  const customTopUpCurrency = envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_CURRENCY', 'PAYPAL_CUSTOM_TOPUP_CURRENCY']);
  const customTopUpDecimalPlaces = envValue(['RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES', 'PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES']);
  if (customTopUpMin && (!Number.isFinite(Number(customTopUpMin)) || Number(customTopUpMin) <= 0)) {
    invalid.push('RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD must be a positive number');
  }
  if (customTopUpMax && (!Number.isFinite(Number(customTopUpMax)) || Number(customTopUpMax) <= 0)) {
    invalid.push('RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD must be a positive number');
  }
  if (config.paypal.customTopUp.minAmountUsd > config.paypal.customTopUp.maxAmountUsd) {
    invalid.push('RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD must be less than or equal to RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD');
  }
  if (customTopUpCurrency && !/^[a-zA-Z]{3}$/.test(customTopUpCurrency)) {
    invalid.push('RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_CURRENCY must be a three-letter ISO currency code');
  }
  if (customTopUpDecimalPlaces && (!Number.isInteger(Number(customTopUpDecimalPlaces)) || Number(customTopUpDecimalPlaces) < 0 || Number(customTopUpDecimalPlaces) > 6)) {
    invalid.push('RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES must be an integer between 0 and 6');
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
    paypalConfigured: config.paypal.mock || Boolean(config.paypal.clientId && config.paypal.clientSecret),
    paypalEnvironment: config.paypal.environment,
    paypalMock: config.paypal.mock,
    paypalPackagesConfigured: config.paypal.prepaidPackages.length,
    paypalCustomTopUp: {
      minAmountUsd: config.paypal.customTopUp.minAmountUsd,
      maxAmountUsd: config.paypal.customTopUp.maxAmountUsd,
      currency: config.paypal.customTopUp.currency,
      decimalPlaces: config.paypal.customTopUp.decimalPlaces,
    },
    publicUrlConfigured: envPresent('RENDERSPHERE_PUBLIC_URL'),
    rateLimitStore: config.rateLimitStore,
    redisRateLimitConfigured: config.rateLimitStore === 'redis' ? Boolean(config.rateLimitRedisUrl) : null,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    requestLoggingEnabled: config.requestLoggingEnabled,
    publicMetricsEnabled: config.publicMetricsEnabled,
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
  VALID_LOG_FORMATS,
  VALID_LOG_LEVELS,
  VALID_OUTPUT_FORMATS,
  VALID_PAYPAL_ENVIRONMENTS,
  config,
  environmentValidation,
  getEnvironmentReadiness,
  requiredEnvVars,
  validateRequiredEnv,
};
