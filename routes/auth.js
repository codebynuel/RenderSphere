import crypto from 'crypto';
import express from 'express';

function createAuthRouter({
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
  publicAccessKey,
  publicUser,
  readStore,
  requireAuth,
  sessionCookieName,
  setSessionCookie,
  updateStore,
  verifyPassword,
  nowIso,
}) {
  const router = express.Router();

  router.post('/register', authRateLimit, async (req, res) => {
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
          accessKeys: [],
          starterBalanceUsd: 0,
          createdAt: nowIso(),
        };
        const accessKeyToken = await createApiKeyForUser(store, user);
        const createdAccessKey = publicAccessKey(normalizeAccessKeys(user).at(-1), accessKeyToken);
        const token = await createSessionForUser(store, user.id);
        store.users.push(user);

        return { user: publicUser(user), token, accessKey: createdAccessKey };
      });

      if (result.error) return res.status(409).json({ error: result.error });
      setSessionCookie(req, res, result.token);
      res.status(201).json(result);
    } catch (error) {
      console.error('Register Error:', error);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });

  router.post('/login', authRateLimit, async (req, res) => {
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
      console.error('Login Error:', error);
      res.status(500).json({ error: 'Failed to log in' });
    }
  });

  router.post('/logout', async (req, res) => {
    const bearerToken = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookieMatch = req.headers.cookie?.match(new RegExp(`${sessionCookieName}=([^;]+)`));
    let token = req.authToken || bearerToken || null;

    if (!token && cookieMatch?.[1]) {
      try {
        token = decodeURIComponent(cookieMatch[1]);
      } catch {
        token = cookieMatch[1];
      }
    }

    if (token) {
      const tokenHash = hashToken(token);
      await updateStore(async (store) => {
        store.sessions = store.sessions.filter((session) => session.tokenHash !== tokenHash);
      });
    }

    clearSessionCookie(req, res);
    res.json({ success: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), authType: req.authType });
  });

  router.get('/access-keys', requireAuth, async (req, res) => {
    const store = await readStore();
    const user = store.users.find((item) => item.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ accessKeys: normalizeAccessKeys(user).map(publicAccessKey) });
  });

  router.post('/access-keys', accountRateLimit, requireAuth, async (req, res) => {
    const requestedName = String(req.body.name || '').trim();
    const result = await updateStore(async (store) => {
      const user = store.users.find((item) => item.id === req.user.id);
      if (!user) return null;
      const accessKeyToken = await createApiKeyForUser(store, user);
      const created = normalizeAccessKeys(user).at(-1);
      if (created && requestedName) {
        created.name = requestedName.slice(0, 80);
      }
      return { accessKey: publicAccessKey(created, accessKeyToken) };
    });

    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json(result);
  });

  router.delete('/access-keys/:accessKeyId', accountRateLimit, requireAuth, async (req, res) => {
    const { accessKeyId } = req.params;
    const result = await updateStore(async (store) => {
      const user = store.users.find((item) => item.id === req.user.id);
      if (!user) return null;

      const accessKeys = normalizeAccessKeys(user);
      const nextAccessKeys = accessKeys.filter((accessKey) => accessKey.id !== accessKeyId);
      if (nextAccessKeys.length === accessKeys.length) {
        return { notFound: true };
      }

      user.accessKeys = nextAccessKeys;
      return { success: true };
    });

    if (!result) return res.status(404).json({ error: 'User not found' });
    if (result.notFound) return res.status(404).json({ error: 'Access key not found' });
    res.json({ success: true });
  });

  router.post('/api-key', accountRateLimit, requireAuth, async (req, res) => {
    const result = await updateStore(async (store) => {
      const user = store.users.find((item) => item.id === req.user.id);
      if (!user) return null;
      const accessKeyToken = await createApiKeyForUser(store, user);
      const created = normalizeAccessKeys(user).at(-1);
      return {
        apiKey: accessKeyToken,
        accessKey: publicAccessKey(created, accessKeyToken),
      };
    });

    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json(result);
  });

  return router;
}

export { createAuthRouter };
