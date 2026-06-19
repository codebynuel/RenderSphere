import { config } from './config.js';

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const SECRET_KEY_PATTERN = /(authorization|cookie|token|secret|password|apikey|api_key|accesskey|access_key|session|credential|privatekey|private_key)/i;
const SECRET_VALUE_PATTERN = /(rs_live_|rs_session_|Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi;
const MAX_STRING_LENGTH = 1200;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 50;

function normalizedLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : 'info';
}

function shouldLog(level) {
  return LEVELS[normalizedLevel(level)] >= LEVELS[normalizedLevel(config.logLevel)];
}

function redactString(value) {
  const normalized = String(value);
  const redacted = normalized.replace(SECRET_VALUE_PATTERN, '$1[REDACTED]');
  return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…` : redacted;
}

function serializeError(error) {
  if (!error || typeof error !== 'object') return error;
  return {
    name: error.name,
    message: redactString(error.message || String(error)),
    code: error.code || undefined,
    status: error.status || error.statusCode || undefined,
    retryable: typeof error.retryable === 'boolean' ? error.retryable : undefined,
    operation: error.operation || undefined,
    stack: config.isProduction ? undefined : redactString(error.stack || ''),
    data: error.data ? redactSecrets(error.data) : undefined,
  };
}

function redactSecrets(value, depth = 0) {
  if (value instanceof Error) return serializeError(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return '[Truncated]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactSecrets(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    return items;
  }

  if (typeof value === 'object') {
    const output = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, childValue] of entries) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(childValue, depth + 1);
    }
    const remaining = Object.keys(value).length - entries.length;
    if (remaining > 0) output._truncated = `${remaining} more keys`;
    return output;
  }

  return redactString(value);
}

function normalizeMeta(meta = {}) {
  if (meta instanceof Error) return { error: serializeError(meta) };
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { value: redactSecrets(meta) };
  return redactSecrets(meta);
}

function formatDevLine(entry) {
  const requestPart = entry.requestId ? ` requestId=${entry.requestId}` : '';
  const contextPart = entry.context ? ` context=${entry.context}` : '';
  const meta = { ...entry };
  delete meta.timestamp;
  delete meta.level;
  delete meta.message;
  delete meta.requestId;
  delete meta.context;
  const metaKeys = Object.keys(meta).filter((key) => meta[key] !== undefined);
  const metaPart = metaKeys.length ? ` ${JSON.stringify(meta)}` : '';
  return `${entry.timestamp} ${entry.level.toUpperCase()}${requestPart}${contextPart} ${entry.message}${metaPart}`;
}

function write(level, message, meta = {}) {
  const normalized = normalizedLevel(level);
  if (!shouldLog(normalized)) return;

  const safeMeta = normalizeMeta(meta);
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalized,
    message: redactString(message || ''),
    ...safeMeta,
  };

  const line = config.logFormat === 'json' ? JSON.stringify(entry) : formatDevLine(entry);
  if (normalized === 'error') console.error(line);
  else if (normalized === 'warn') console.warn(line);
  else console.log(line);
}

function withRequest(req, meta = {}) {
  return {
    requestId: req?.id || req?.requestId || null,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    route: req?.route?.path ? `${req.baseUrl || ''}${req.route.path}` : undefined,
    userId: req?.user?.id || undefined,
    ...meta,
  };
}

const logger = {
  debug(message, meta) { write('debug', message, meta); },
  info(message, meta) { write('info', message, meta); },
  warn(message, meta) { write('warn', message, meta); },
  error(message, meta) { write('error', message, meta); },
  child(defaultMeta = {}) {
    return {
      debug(message, meta = {}) { write('debug', message, { ...defaultMeta, ...meta }); },
      info(message, meta = {}) { write('info', message, { ...defaultMeta, ...meta }); },
      warn(message, meta = {}) { write('warn', message, { ...defaultMeta, ...meta }); },
      error(message, meta = {}) { write('error', message, { ...defaultMeta, ...meta }); },
    };
  },
};

export { logger, redactSecrets, serializeError, withRequest };
