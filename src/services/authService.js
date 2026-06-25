import crypto from 'crypto';
import { prisma } from '../db.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, config } from '../../helpers/config.js';
import { logger, withRequest } from '../../helpers/logger.js';
import { CREDIT_ACTOR_TYPES, grantCredits } from './creditService.js';

export function nowIso() {
  return new Date().toISOString();
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ''), salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

export async function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;

  const passwordHash = await hashPassword(password, user.passwordSalt);
  const candidate = Buffer.from(passwordHash.hash, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');

  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name || null,
    role: user.role || 'user',
    createdAt: user.createdAt,
    starterBalanceUsd: Number(user.starterBalanceUsd || 0),
  };
}

export function adminUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    starterBalanceUsd: Number(user.starterBalanceUsd || 0),
    createdAt: user.createdAt,
  };
}

export function publicAccessKey(accessKey, token = null) {
  if (!accessKey) return null;
  return {
    id: accessKey.id,
    name: accessKey.name,
    preview: accessKey.tokenPreview,
    token,
    scopeType: accessKey.scopeType,
    scopeProjectId: accessKey.scopeProjectId,
    budgetCapUsd: accessKey.budgetCapUsd ? Number(accessKey.budgetCapUsd) : null,
    budgetSpentUsd: accessKey.budgetSpentUsd ? Number(accessKey.budgetSpentUsd) : null,
    expiresAt: accessKey.expiresAt,
    lastUsedAt: accessKey.lastUsedAt,
    createdAt: accessKey.createdAt,
  };
}

export function createRawAccessKey() {
  const token = `rs_live_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashToken(token),
    tokenPreview: `${token.slice(0, 10)}...${token.slice(-6)}`,
  };
}

export async function createAccessKeyForUser(userId, name = 'Access key', options = {}) {
  const rawAccessKey = createRawAccessKey();
  const accessKey = await prisma.accessKey.create({
    data: {
      userId,
      name: String(name || 'Access key').trim().slice(0, 80) || 'Access key',
      tokenHash: rawAccessKey.tokenHash,
      tokenPreview: rawAccessKey.tokenPreview,
      scopeType: options.scopeType || 'GLOBAL',
      scopeProjectId: options.scopeProjectId || null,
      budgetCapUsd: options.budgetCapUsd || null,
      expiresAt: options.expiresAt || null,
    },
  });

  return { accessKey, token: rawAccessKey.token };
}

export function createRawSessionToken() {
  const token = `rs_session_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
}

export async function createSessionForUser(userId) {
  const rawSession = createRawSessionToken();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: rawSession.tokenHash,
      expiresAt: rawSession.expiresAt,
    },
  });

  return { session, token: rawSession.token };
}

export async function revokeSessionToken(token) {
  if (!token) return { count: 0 };
  return prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export function parseCookieHeader(rawCookie = '') {
  const cookies = new Map();
  for (const part of String(rawCookie || '').split(';')) {
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

export function getBearerToken(req) {
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function getSessionCookie(req) {
  return parseCookieHeader(req.get('cookie') || '').get(SESSION_COOKIE_NAME) || null;
}

export function getRequestToken(req) {
  const bearerToken = getBearerToken(req);
  if (bearerToken) return { token: bearerToken, source: 'bearer' };

  const cookieToken = getSessionCookie(req);
  if (cookieToken) return { token: cookieToken, source: 'cookie' };

  return { token: null, source: null };
}

export function sessionCookieOptions(req, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = config.secureCookies || req.secure || req.get('x-forwarded-proto') === 'https';
  return ['Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : ''].filter(Boolean).join('; ');
}

export function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${sessionCookieOptions(req)}`);
}

export function clearSessionCookie(req, res) {
  const baseOptions = ['Path=/', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'HttpOnly', 'SameSite=Lax'].join('; ');
  res.setHeader('Set-Cookie', [`${SESSION_COOKIE_NAME}=; ${baseOptions}`, `${SESSION_COOKIE_NAME}=; ${baseOptions}; Secure`]);
}

export async function authenticateToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (session) {
    if (new Date(session.expiresAt).getTime() > Date.now()) {
      return { user: session.user, authType: 'session' };
    }

    await prisma.session.deleteMany({ where: { id: session.id } });
  }

  const accessKey = await prisma.accessKey.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (accessKey) {
    // Enforce expiry
    if (accessKey.expiresAt && new Date(accessKey.expiresAt).getTime() < Date.now()) {
      return null;
    }

    const lastUsedAt = accessKey.lastUsedAt ? new Date(accessKey.lastUsedAt).getTime() : 0;
    if (!lastUsedAt || Date.now() - lastUsedAt > 5 * 60 * 1000) {
      await prisma.accessKey.update({
        where: { id: accessKey.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return {
      user: accessKey.user,
      authType: 'accessKey',
      accessKey: {
        id: accessKey.id,
        scopeType: accessKey.scopeType,
        scopeProjectId: accessKey.scopeProjectId,
        budgetCapUsd: accessKey.budgetCapUsd ? Number(accessKey.budgetCapUsd) : null,
        budgetSpentUsd: accessKey.budgetSpentUsd ? Number(accessKey.budgetSpentUsd) : 0,
      },
    };
  }

  return null;
}

export async function requireAuth(req, res, next) {
  try {
    const requestToken = getRequestToken(req);
    const auth = await authenticateToken(requestToken.token);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    req.user = auth.user;
    req.authType = auth.authType;
    req.authToken = requestToken.token;
    req.authSource = requestToken.source;
    req.accessKey = auth.accessKey || null;
    return next();
  } catch (error) {
    logger.error('Authentication middleware failed', withRequest(req, { context: 'auth', error }));
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const requestToken = getRequestToken(req);
    const auth = await authenticateToken(requestToken.token);
    if (!auth || auth.user.role !== 'admin') {
      return res.status(404).json({ error: 'Not found' });
    }

    req.user = auth.user;
    req.authType = auth.authType;
    req.authToken = requestToken.token;
    req.authSource = requestToken.source;
    return next();
  } catch (error) {
    return res.status(404).json({ error: 'Not found' });
  }
}

export async function registerUser({ email, password, name }) {
  const normalizedEmail = normalizeEmail(email);
  const displayName = String(name || '').trim().slice(0, 80) || null;
  const passwordHash = await hashPassword(password);
  const rawAccessKey = createRawAccessKey();
  const rawSession = createRawSessionToken();

  const user = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        email: normalizedEmail,
        name: displayName,
        passwordHash: passwordHash.hash,
        passwordSalt: passwordHash.salt,
        starterBalanceUsd: 0,
        accessKeys: {
          create: {
            name: 'Blender workstation',
            tokenHash: rawAccessKey.tokenHash,
            tokenPreview: rawAccessKey.tokenPreview,
          },
        },
        sessions: {
          create: {
            tokenHash: rawSession.tokenHash,
            expiresAt: rawSession.expiresAt,
          },
        },
      },
      include: { accessKeys: true },
    });

    if (config.freeRenderCredits > 0) {
      await grantCredits({
        client: tx,
        userId: createdUser.id,
        amountUsd: config.freeRenderCredits,
        actor: { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
        referenceType: 'user_registration',
        referenceId: createdUser.id,
        idempotencyKey: `registration-grant:${createdUser.id}`,
        metadata: { reason: 'new_user_free_render_credits' },
      });
    }

    return tx.user.findUnique({ where: { id: createdUser.id }, include: { accessKeys: true } });
  });

  return {
    user,
    sessionToken: rawSession.token,
    accessKey: user.accessKeys[0],
    accessKeyToken: rawAccessKey.token,
  };
}
