import express from 'express';
import {
  createAccessKeyForUser,
  createSessionForUser,
  getBearerToken,
  getSessionCookie,
  normalizeEmail,
  publicAccessKey,
  publicUser,
  registerUser,
  revokeSessionToken,
  setSessionCookie,
  clearSessionCookie,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  resendVerificationEmail,
  verifyPassword,
} from '../src/services/authService.js';
import { config } from '../helpers/config.js';
import { logger, withRequest } from '../helpers/logger.js';
import { prisma } from '../src/db.js';
import { buildPaginationMeta, parsePaginationQuery } from '../src/controllers/pagination.js';

function createAuthRouter({
  accountRateLimit,
  authRateLimit,
  requireAuth,
}) {
  const router = express.Router();

  router.post('/register', authRateLimit, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim().slice(0, 80) || undefined;
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
      const result = await registerUser({ email, password, name });
      setSessionCookie(req, res, result.sessionToken);

      return res.status(201).json({
        user: publicUser(result.user),
        token: result.sessionToken,
        accessKey: publicAccessKey(result.accessKey, result.accessKeyToken),
      });
    } catch (error) {
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      logger.error('Register failed', withRequest(req, { context: 'auth', error }));
      return res.status(500).json({ error: 'Failed to create account' });
    }
  });

  router.post('/login', authRateLimit, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const session = await createSessionForUser(user.id);
      setSessionCookie(req, res, session.token);
      return res.json({ user: publicUser(user), token: session.token });
    } catch (error) {
      logger.error('Login failed', withRequest(req, { context: 'auth', error }));
      return res.status(500).json({ error: 'Failed to log in' });
    }
  });

  router.post('/logout', async (req, res) => {
    const token = req.authToken || getBearerToken(req) || getSessionCookie(req);
    if (token) await revokeSessionToken(token);

    clearSessionCookie(req, res);
    return res.json({ success: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), authType: req.authType });
  });

  router.get('/access-keys', requireAuth, async (req, res) => {
    const pagination = parsePaginationQuery(req.query);
    const where = { userId: req.user.id };
    const [totalItems, accessKeys] = await Promise.all([
      prisma.accessKey.count({ where }),
      prisma.accessKey.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);

    res.json({
      accessKeys: accessKeys.map((accessKey) => publicAccessKey(accessKey)),
      pagination: buildPaginationMeta({ ...pagination, totalItems }),
    });
  });

  router.post('/access-keys', requireAuth, accountRateLimit, async (req, res) => {
    try {
      const requestedName = String(req.body.name || '').trim() || 'Access key';
      const created = await createAccessKeyForUser(req.user.id, requestedName, {
        scopeType: req.body.scopeType || 'GLOBAL',
        scopeProjectId: req.body.scopeProjectId || null,
        budgetCapUsd: req.body.budgetCapUsd ? Number(req.body.budgetCapUsd) : null,
        expiresAt: req.body.expiresAt || null,
      });
      return res.status(201).json({ accessKey: publicAccessKey(created.accessKey, created.token) });
    } catch (error) {
      logger.error('Access key create failed', withRequest(req, { context: 'auth', error }));
      return res.status(500).json({ error: 'Failed to create access key' });
    }
  });

  router.delete('/access-keys/:accessKeyId', requireAuth, accountRateLimit, async (req, res) => {
    try {
      const deleted = await prisma.accessKey.deleteMany({
        where: {
          id: req.params.accessKeyId,
          userId: req.user.id,
        },
      });

      if (deleted.count === 0) return res.status(404).json({ error: 'Access key not found' });
      return res.json({ success: true });
    } catch (error) {
      logger.error('Access key delete failed', withRequest(req, { context: 'auth', accessKeyId: req.params.accessKeyId, error }));
      return res.status(500).json({ error: 'Failed to delete access key' });
    }
  });

  router.post('/api-key', requireAuth, accountRateLimit, async (req, res) => {
    try {
      const created = await createAccessKeyForUser(req.user.id, 'Access key');
      return res.json({ apiKey: created.token, accessKey: publicAccessKey(created.accessKey, created.token) });
    } catch (error) {
      logger.error('Legacy API key create failed', withRequest(req, { context: 'auth', error }));
      return res.status(500).json({ error: 'Failed to create access key' });
    }
  });

  // --- Email verification ---

  router.get('/verify-email/:token', async (req, res) => {
    try {
      await verifyEmail(req.params.token);
      return res.json({ success: true });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      return res.status(500).json({ error: 'Failed to verify email' });
    }
  });

  router.post('/resend-verification', requireAuth, accountRateLimit, async (req, res) => {
    try {
      await resendVerificationEmail(req.user.id);
      return res.json({ success: true });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      return res.status(500).json({ error: 'Failed to resend verification' });
    }
  });

  // --- Password reset ---

  router.post('/forgot-password', authRateLimit, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });

    try {
      await requestPasswordReset(email);
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    } catch (error) {
      logger.error('Password reset request failed', withRequest(req, { context: 'auth', error }));
      return res.status(500).json({ error: 'Failed to process request' });
    }
  });

  router.post('/reset-password/:token', authRateLimit, async (req, res) => {
    const { password } = req.body;
    try {
      const user = await resetPassword(req.params.token, password);
      return res.json({ success: true });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      return res.status(500).json({ error: 'Failed to reset password' });
    }
  });

  return router;
}

export { createAuthRouter };
