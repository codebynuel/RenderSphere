import { spawn } from 'node:child_process';

const port = process.env.SMOKE_TEST_PORT || '3999';
const baseUrl = `http://127.0.0.1:${port}`;
const schemaName = `smoke_${Date.now()}`;
const defaultDatabaseUrl = `postgresql://rendersphere:rendersphere_password@127.0.0.1:5432/rendersphere_db?schema=${schemaName}`;
const databaseUrl = process.env.SMOKE_TEST_DATABASE_URL || process.env.DATABASE_URL || defaultDatabaseUrl;

function commandName(binary) {
  return process.platform === 'win32' ? `${binary}.cmd` : binary;
}

function runCommand(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', [commandName(binary), ...args].join(' ')], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      : spawn(commandName(binary), args, {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${binary} ${args.join(' ')} failed with ${code}\n${output}`));
    });
  });
}

const serverEnv = {
  ...process.env,
  PORT: port,
  DATABASE_URL: databaseUrl,
  CLOUDFLARE_ACCOUNT_ID: 'smoke-account',
  R2_ACCESS_KEY_ID: 'smoke-access-key',
  R2_SECRET_ACCESS_KEY: 'smoke-secret-key',
  R2_BUCKET_NAME: 'smoke-bucket',
  RUNPOD_ENDPOINT_ID: 'smoke-endpoint',
  RUNPOD_API_KEY: 'smoke-runpod-key',
  RENDERSPHERE_INVITE_CODE: 'smoke-invite',
  RENDERSPHERE_ADMIN_TOKEN: 'smoke-admin',
  RENDERSPHERE_FREE_RENDER_CREDITS_USD: '5',
  RENDERSPHERE_MIN_RENDER_START_BALANCE_USD: '6',
};

await runCommand('npx', ['prisma', 'generate'], serverEnv);
await runCommand('npx', ['prisma', 'db', 'push', '--force-reset'], serverEnv);

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: serverEnv,
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
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      await request('/healthz');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server did not become healthy.\n${serverOutput}`);
}

try {
  await waitForServer();

  const initialSummary = await request('/api/admin/summary', {
    headers: { Authorization: 'Bearer smoke-admin' },
  });
  if (initialSummary.database !== 'postgres') throw new Error(`Expected postgres database summary, got ${initialSummary.database}.`);

  const email = `smoke-${Date.now()}@example.com`;
  const registerResult = await rawRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'longenoughpassword', inviteCode: 'smoke-invite' }),
  });
  if (!registerResult.response.ok) {
    throw new Error(`POST /api/auth/register failed: ${registerResult.response.status} ${registerResult.data.error || ''}`);
  }

  const registered = registerResult.data;
  if (!registered.token || !registered.accessKey || registered.user.email !== email) {
    throw new Error('Register response did not include the expected session, access key, and user.');
  }
  if (registered.user.starterBalanceUsd !== 5) {
    throw new Error(`Expected starter balance 5, got ${registered.user.starterBalanceUsd}.`);
  }

  const sessionCookie = registerResult.response.headers.get('set-cookie')?.split(';')[0];
  if (!sessionCookie?.startsWith('rs_session=')) {
    throw new Error('Register response did not set the HTTP-only session cookie.');
  }

  const cookieHeaders = { Cookie: sessionCookie };
  const me = await request('/api/auth/me', { headers: cookieHeaders });
  if (me.user.email !== email) throw new Error('/api/auth/me returned the wrong user.');

  const appConfig = await request('/api/config');
  if (appConfig.limits?.minRenderStartBalanceUsd !== 6) {
    throw new Error(`Expected minimum render start balance 6, got ${appConfig.limits?.minRenderStartBalanceUsd}.`);
  }

  const project = await request('/api/projects', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({ name: 'Smoke project' }),
  });
  if (!project.project?.id) throw new Error('Project creation did not return a project id.');

  const projects = await request('/api/projects', { headers: cookieHeaders });
  if (projects.projects.length !== 1) throw new Error(`Expected one project, got ${projects.projects.length}.`);

  const oversized = await fetch(`${baseUrl}/api/get-upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeaders },
    body: JSON.stringify({
      fileName: 'too-big.blend',
      fileSizeBytes: 11 * 1024 * 1024 * 1024,
    }),
  });
  if (oversized.status !== 413) {
    throw new Error(`Expected oversized upload to return 413, got ${oversized.status}.`);
  }

  const upload = await request('/api/get-upload-url', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({
      fileName: 'smoke.blend',
      fileSizeBytes: 1024,
    }),
  });
  if (!upload.key) throw new Error('Upload URL creation did not return a file key.');

  const underfundedRender = await rawRequest('/api/trigger-render', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({
      fileKey: upload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
    }),
  });
  if (underfundedRender.response.status !== 402) {
    throw new Error(`Expected underfunded render to return 402, got ${underfundedRender.response.status}.`);
  }
  if (!underfundedRender.data.error?.includes('minimum balance')) {
    throw new Error(`Expected underfunded render to return a clear minimum balance error, got ${underfundedRender.data.error || 'no error'}.`);
  }

  const summary = await request('/api/admin/summary', {
    headers: { Authorization: 'Bearer smoke-admin' },
  });
  if (summary.users !== initialSummary.users + 1) {
    throw new Error(`Expected admin summary user count to increase by one, got ${summary.users - initialSummary.users}.`);
  }
  if (summary.jobs !== initialSummary.jobs) {
    throw new Error(`Expected underfunded render not to create a job, job count changed from ${initialSummary.jobs} to ${summary.jobs}.`);
  }
  if (summary.limits?.minRenderStartBalanceUsd !== 6) {
    throw new Error(`Expected admin summary minimum render start balance 6, got ${summary.limits?.minRenderStartBalanceUsd}.`);
  }
  if (summary.database !== 'postgres') throw new Error(`Expected postgres database summary, got ${summary.database}.`);

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
