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

const rateLimitBuckets = new Map();

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

export { createRateLimiter, requireSameOriginForBrowserWrites, securityHeaders };
