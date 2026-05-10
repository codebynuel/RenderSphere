import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = process.env.SMOKE_TEST_PORT || '3999';
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(tmpdir(), 'rendersphere-smoke-'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: port,
    RENDERSPHERE_DATA_DIR: dataDir,
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
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'longenoughpassword', inviteCode: 'smoke-invite' }),
  });

  if (!registered.token || !registered.apiKey || registered.user.email !== email) {
    throw new Error('Register response did not include the expected session, API key, and user.');
  }

  const authHeaders = { Authorization: `Bearer ${registered.token}` };
  const me = await request('/api/auth/me', { headers: authHeaders });
  if (me.user.email !== email) throw new Error('/api/auth/me returned the wrong user.');

  const oversized = await fetch(`${baseUrl}/api/get-upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
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

  console.log('Smoke test passed.');
} finally {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
}
