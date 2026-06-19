import { logger } from './logger.js';

function securityHeaders(req, res, next) {
  const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://images.unsplash.com",
    "connect-src 'self' ws: wss:",
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

function requireSameOriginForBrowserWrites(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  try {
    const originUrl = new URL(origin);
    const forwardedHost = req.get('x-forwarded-host');
    const host = req.get('host');
    const allowedHosts = [forwardedHost, host]
      .filter(Boolean)
      .flatMap((value) => value.split(',').map((part) => part.trim()));

    if (allowedHosts.includes(originUrl.host)) {
      return next();
    }
  } catch {
    return res.status(403).json({ error: 'Invalid request origin' });
  }

  return res.status(403).json({ error: 'Invalid request origin' });
}

function normalizeKeyPart(value) {
  return String(value || 'anonymous').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160);
}

function defaultKeyGenerator(req) {
  const actor = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`;
  return `${actor}:${req.method}:${req.path}`;
}

class MemoryRateLimitStore {
  constructor() {
    this.buckets = new Map();
  }

  async increment(key, windowMs) {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    }

    bucket.count += 1;
    return { count: bucket.count, resetAt: bucket.resetAt };
  }

  async close() {
    this.buckets.clear();
  }
}

class RedisRateLimitStore {
  constructor({ url, keyPrefix = 'rendersphere' }) {
    if (!url) throw new Error('Redis rate limit store requires a URL');
    this.url = url;
    this.keyPrefix = keyPrefix;
    this.client = null;
    this.connecting = null;
    this.disabled = false;
  }

  async getClient() {
    if (this.disabled) return null;
    if (this.client?.isOpen) return this.client;
    if (!this.connecting) {
      this.connecting = import('redis')
        .then(({ createClient }) => {
          const client = createClient({ url: this.url });
          client.on('error', (error) => {
            logger.error('Redis rate limit store error', { context: 'rate_limit', error });
          });
          this.client = client;
          return client.connect().then(() => client);
        })
        .catch((error) => {
          this.disabled = true;
          logger.error('Redis rate limit store unavailable; falling back to process memory until restart', { context: 'rate_limit', error });
          return null;
        });
    }
    return this.connecting;
  }

  async increment(key, windowMs) {
    const client = await this.getClient();
    if (!client) return null;

    const redisKey = `${this.keyPrefix}:rate-limit:${key}`;
    const count = await client.incr(redisKey);
    if (count === 1) await client.pExpire(redisKey, windowMs);
    const ttl = await client.pTTL(redisKey);
    return {
      count,
      resetAt: Date.now() + (ttl > 0 ? ttl : windowMs),
    };
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
  }
}

function createRateLimitStore({ store = 'memory', redisUrl = '', keyPrefix = 'rendersphere' } = {}) {
  const normalizedStore = String(store || 'memory').trim().toLowerCase();
  const memoryStore = new MemoryRateLimitStore();
  if ((normalizedStore === 'redis' || redisUrl) && redisUrl) {
    const redisStore = new RedisRateLimitStore({ url: redisUrl, keyPrefix });
    return {
      async increment(key, windowMs) {
        const result = await redisStore.increment(key, windowMs);
        return result || memoryStore.increment(key, windowMs);
      },
      async close() {
        await redisStore.close();
        await memoryStore.close();
      },
    };
  }
  if (normalizedStore === 'redis' && !redisUrl) {
    logger.warn('Redis rate limit store requested without RENDERSPHERE_RATE_LIMIT_REDIS_URL; using process memory', { context: 'rate_limit' });
  }
  return memoryStore;
}

function createRateLimiter({ windowMs, max, message, store = null, keyGenerator = defaultKeyGenerator, scope = 'route' }) {
  const limiterStore = store || createRateLimitStore();
  return async (req, res, next) => {
    try {
      const rawKey = keyGenerator(req);
      const key = `${normalizeKeyPart(scope)}:${normalizeKeyPart(rawKey)}`;
      const bucket = await limiterStore.increment(key, windowMs);

      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

      if (bucket.count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
        return res.status(429).json({ error: message });
      }

      return next();
    } catch (error) {
      logger.error('Rate limiter failed open', { context: 'rate_limit', requestId: req.id || req.requestId || null, scope, error });
      return next();
    }
  };
}

function accountRateLimitKey(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip}`;
}

function authAttemptRateLimitKey(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  return `${req.ip}:${email || 'no-email'}`;
}

export {
  accountRateLimitKey,
  authAttemptRateLimitKey,
  createRateLimiter,
  createRateLimitStore,
  requireSameOriginForBrowserWrites,
  securityHeaders,
};
