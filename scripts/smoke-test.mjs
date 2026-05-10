import { spawn } from 'node:child_process';

const port = process.env.SMOKE_TEST_PORT || '3999';
const baseUrl = `http://127.0.0.1:${port}`;
const mongoDbName = `rendersphere_smoke_${Date.now()}`;

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: port,
    MONGODB_DB_NAME: mongoDbName,
    CLOUDFLARE_ACCOUNT_ID: 'smoke-account',
    R2_ACCESS_KEY_ID: 'smoke-access-key',
    R2_SECRET_ACCESS_KEY: 'smoke-secret-key',
    R2_BUCKET_NAME: 'smoke-bucket',
    RUNPOD_ENDPOINT_ID: 'smoke-endpoint',
    RUNPOD_API_KEY: 'smoke-runpod-key',
    RENDERSPHERE_INVITE_CODE: 'smoke-invite',
    RENDERSPHERE_ADMIN_TOKEN: 'smoke-admin',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${data.error || ''}`.trim());
  }
  return data;
}

async function rawRequest(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      await request('/healthz');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Server did not become healthy.\n${serverOutput}`);
}

try {
  await waitForServer();

  const email = `smoke-${Date.now()}@example.com`;
  const registerResult = await rawRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'longenoughpassword', inviteCode: 'smoke-invite' }),
  });
  if (!registerResult.response.ok) {
    throw new Error(`POST /api/auth/register failed: ${registerResult.response.status} ${registerResult.data.error || ''}`);
  }

  const registered = registerResult.data;
  if (!registered.token || !registered.apiKey || registered.user.email !== email) {
    throw new Error('Register response did not include the expected session, API key, and user.');
  }

  const sessionCookie = registerResult.response.headers.get('set-cookie')?.split(';')[0];
  if (!sessionCookie?.startsWith('rs_session=')) {
    throw new Error('Register response did not set the HTTP-only session cookie.');
  }

  const cookieHeaders = { Cookie: sessionCookie };
  const me = await request('/api/auth/me', { headers: cookieHeaders });
  if (me.user.email !== email) throw new Error('/api/auth/me returned the wrong user.');

  const oversized = await fetch(`${baseUrl}/api/get-upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeaders },
    body: JSON.stringify({
      fileName: 'too-big.blend',
      fileSizeBytes: 501 * 1024 * 1024,
    }),
  });
  if (oversized.status !== 413) {
    throw new Error(`Expected oversized upload to return 413, got ${oversized.status}.`);
  }

  const summary = await request('/api/admin/summary', {
    headers: { Authorization: 'Bearer smoke-admin' },
  });
  if (summary.users !== 1) throw new Error(`Expected admin summary to report one user, got ${summary.users}.`);

  const logout = await rawRequest('/api/auth/logout', {
    method: 'POST',
    headers: cookieHeaders,
    body: '{}',
  });
  if (!logout.response.ok) throw new Error(`Expected logout to succeed, got ${logout.response.status}.`);
  const clearedCookie = logout.response.headers.get('set-cookie') || '';
  if (!clearedCookie.includes('Max-Age=0')) throw new Error('Logout did not clear the session cookie.');

  console.log('Smoke test passed.');
} finally {
  server.kill();
}
