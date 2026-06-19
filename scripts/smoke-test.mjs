import { spawn } from 'node:child_process';

const port = process.env.SMOKE_TEST_PORT || '3999';
const baseUrl = `http://127.0.0.1:${port}`;
const fallbackSchemaName = `smoke_${Date.now()}`;
const defaultDatabaseUrl = `postgresql://rendersphere:rendersphere_password@127.0.0.1:5432/rendersphere_db?schema=${fallbackSchemaName}`;
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
  RENDERSPHERE_RENDER_ESTIMATE_BASE_SECONDS_PER_FRAME: '10',
  RENDERSPHERE_MIN_RENDER_RESERVATION_USD: '0.50',
  RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD: '2.00',
  RENDERSPHERE_MAX_RENDER_BUDGET_USD: '20.00',
  RENDERSPHERE_MOCK_RUNPOD: 'true',
  RENDERSPHERE_JOB_POLL_INTERVAL_MS: '600000',
  RENDERSPHERE_RUNPOD_REQUEST_TIMEOUT_MS: '250',
  RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES: '2',
  RENDERSPHERE_RUNPOD_CANCEL_MAX_RETRIES: '1',
  RENDERSPHERE_RUNPOD_RETRY_BACKOFF_MS: '10',
  RENDERSPHERE_MOCK_RUNPOD_FAIL_FILEKEY_PATTERN: 'dispatch-fail',
  RENDERSPHERE_MAX_CONCURRENT_JOBS: '4',
  RENDERSPHERE_DEFAULT_PAGE_SIZE: '2',
  RENDERSPHERE_MAX_PAGE_SIZE: '3',
  RENDERSPHERE_RATE_LIMIT_STORE: 'memory',
  RENDERSPHERE_ACCOUNT_RATE_LIMIT_WINDOW_MS: '60000',
  RENDERSPHERE_ACCOUNT_RATE_LIMIT_MAX: '1',
  RENDERSPHERE_RENDER_RATE_LIMIT_WINDOW_MS: '60000',
  RENDERSPHERE_RENDER_RATE_LIMIT_MAX: '100',
  RENDERSPHERE_AUTH_RATE_LIMIT_WINDOW_MS: '60000',
  RENDERSPHERE_AUTH_RATE_LIMIT_MAX: '100',
};

await runCommand('npx', ['prisma', 'generate'], serverEnv);
await runCommand('npx', ['prisma', 'db', 'push', '--force-reset'], serverEnv);
Object.assign(process.env, serverEnv);

const { prisma } = await import('../src/db.js');
const { CREDIT_TRANSACTION_TYPES, applyCreditTransaction, chargeRenderCredits, grantCredits } = await import('../src/services/creditService.js');
const { persistRunpodStatus } = await import('../src/services/jobService.js');
const { RunpodProviderError, fetchRunpodJobStatus } = await import('../src/services/runpodService.js');

async function verifyRunpodRetryHelper() {
  const originalFetch = globalThis.fetch;
  const originalMockRunpod = process.env.RENDERSPHERE_MOCK_RUNPOD;
  let attempts = 0;

  process.env.RENDERSPHERE_MOCK_RUNPOD = 'false';
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: 'temporary provider outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'retry-smoke', status: 'IN_PROGRESS' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const retriedStatus = await fetchRunpodJobStatus('retry-smoke');
    if (attempts !== 2 || retriedStatus.status !== 'IN_PROGRESS') {
      throw new Error(`RunPod retry helper did not retry once as expected; attempts=${attempts}, status=${retriedStatus.status}.`);
    }

    globalThis.fetch = async () => new Promise((resolve, reject) => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      setTimeout(() => reject(abortError), 20);
    });
    process.env.RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES = '0';

    try {
      await fetchRunpodJobStatus('timeout-smoke');
      throw new Error('RunPod timeout helper unexpectedly succeeded.');
    } catch (error) {
      if (!(error instanceof RunpodProviderError) || error.status !== 504 || error.code !== 'RUNPOD_TIMEOUT') {
        throw new Error(`RunPod timeout helper returned the wrong error classification: ${error.code || error.message}.`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.RENDERSPHERE_MOCK_RUNPOD = originalMockRunpod;
    process.env.RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES = serverEnv.RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES;
  }
}

await verifyRunpodRetryHelper();

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

  const registrationGrant = await prisma.creditTransaction.findFirst({
    where: {
      userId: registered.user.id,
      type: CREDIT_TRANSACTION_TYPES.CREDIT_GRANT,
      idempotencyKey: `registration-grant:${registered.user.id}`,
    },
  });
  if (!registrationGrant || Number(registrationGrant.amountUsd) !== 5 || Number(registrationGrant.balanceAfterUsd) !== 5) {
    throw new Error('Registration grant was not recorded in the credit ledger with the expected amount and balance.');
  }

  const grantAudit = await prisma.creditAuditEvent.findFirst({
    where: { creditTransactionId: registrationGrant.id, eventType: 'credit.grant_applied' },
  });
  if (!grantAudit) throw new Error('Registration grant did not create a credit audit event.');

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
  if (projects.pagination?.pageSize !== 2 || projects.pagination?.totalItems !== 1) {
    throw new Error('Project list did not return expected default pagination metadata.');
  }

  const invalidProjectPageSize = await rawRequest('/api/projects?pageSize=4', { headers: cookieHeaders });
  if (invalidProjectPageSize.response.status !== 400) {
    throw new Error(`Expected over-limit project page size to return 400, got ${invalidProjectPageSize.response.status}.`);
  }

  const ledgerJobId = `smoke-ledger-${Date.now()}`;
  await prisma.job.create({
    data: {
      jobId: ledgerJobId,
      userId: registered.user.id,
      projectId: project.project.id,
      fileKey: `smoke-ledger/${registered.user.id}.blend`,
      status: 'COMPLETED',
      frameCount: 1,
      billableSeconds: 125,
      priceUsd: 1.25,
      pricePerSecondUsd: 0.01,
      completedAt: new Date(),
      billedAt: new Date(),
    },
  });

  const renderCharge = await chargeRenderCredits({
    userId: registered.user.id,
    jobId: ledgerJobId,
    amountUsd: 1.25,
    billableSeconds: 125,
    pricePerSecondUsd: 0.01,
    metadata: { source: 'smoke-test' },
  });
  if (renderCharge.idempotent || Number(renderCharge.transaction.amountUsd) !== -1.25 || Number(renderCharge.transaction.balanceAfterUsd) !== 3.75) {
    throw new Error('Render charge was not recorded in the credit ledger with the expected amount and balance.');
  }

  const duplicateRenderCharge = await chargeRenderCredits({
    userId: registered.user.id,
    jobId: ledgerJobId,
    amountUsd: 1.25,
    billableSeconds: 125,
    pricePerSecondUsd: 0.01,
    metadata: { source: 'smoke-test-duplicate' },
  });
  const userAfterDuplicateCharge = await prisma.user.findUnique({ where: { id: registered.user.id } });
  if (!duplicateRenderCharge.idempotent || Number(userAfterDuplicateCharge.starterBalanceUsd) !== 3.75) {
    throw new Error('Render charge idempotency did not preserve the cached user balance.');
  }

  const directAdjustment = await applyCreditTransaction({
    userId: registered.user.id,
    type: CREDIT_TRANSACTION_TYPES.REFUND,
    amountUsd: 0.25,
    referenceType: 'smoke_test',
    referenceId: ledgerJobId,
    idempotencyKey: `smoke-refund:${ledgerJobId}`,
    metadata: { reason: 'ledger_smoke_refund' },
  });
  if (directAdjustment.idempotent || Number(directAdjustment.transaction.amountUsd) !== 0.25 || Number(directAdjustment.transaction.balanceAfterUsd) !== 4) {
    throw new Error('Refund credit was not recorded in the credit ledger with the expected amount and balance.');
  }

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
      maxBudgetUsd: 4.5,
    }),
  });
  if (underfundedRender.response.status !== 402) {
    throw new Error(`Expected underfunded render to return 402, got ${underfundedRender.response.status}.`);
  }
  if (!underfundedRender.data.error?.includes('Insufficient prepaid credits')) {
    throw new Error(`Expected underfunded render to return a clear prepaid credit error, got ${underfundedRender.data.error || 'no error'}.`);
  }

  await grantCredits({
    userId: registered.user.id,
    amountUsd: 10,
    referenceType: 'smoke_test',
    referenceId: 'reservation-coverage',
    idempotencyKey: `smoke-reservation-grant:${registered.user.id}`,
    metadata: { reason: 'reservation_smoke_coverage' },
  });

  const fundedUpload = await request('/api/get-upload-url', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({
      fileName: 'funded-smoke.blend',
      fileSizeBytes: 1024,
    }),
  });

  const fundedIdempotencyKey = `funded-render-${Date.now()}`;
  const jobsBeforeFundedRender = await prisma.job.count({ where: { userId: registered.user.id } });
  const fundedRender = await request('/api/trigger-render', {
    method: 'POST',
    headers: { ...cookieHeaders, 'Idempotency-Key': fundedIdempotencyKey },
    body: JSON.stringify({
      fileKey: fundedUpload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
      maxBudgetUsd: 2,
    }),
  });
  if (!fundedRender.jobId || fundedRender.job?.billingState !== 'RESERVED' || fundedRender.job?.dispatchStatus !== 'DISPATCHED' || !fundedRender.providerJobId) {
    throw new Error('Funded render did not create a dispatched reserved job.');
  }
  if (fundedRender.jobId === fundedRender.providerJobId) {
    throw new Error('Funded render did not keep separate local and provider job identifiers.');
  }
  const persistedFundedJob = await prisma.job.findUnique({ where: { jobId: fundedRender.jobId } });
  if (!persistedFundedJob || persistedFundedJob.providerJobId !== fundedRender.providerJobId || persistedFundedJob.dispatchStatus !== 'DISPATCHED') {
    throw new Error('Accepted render was not persisted locally with provider dispatch metadata.');
  }

  const duplicateFundedRender = await request('/api/trigger-render', {
    method: 'POST',
    headers: { ...cookieHeaders, 'Idempotency-Key': fundedIdempotencyKey },
    body: JSON.stringify({
      fileKey: fundedUpload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
      maxBudgetUsd: 2,
    }),
  });
  const jobsAfterDuplicateFundedRender = await prisma.job.count({ where: { userId: registered.user.id } });
  if (!duplicateFundedRender.idempotent || duplicateFundedRender.jobId !== fundedRender.jobId || duplicateFundedRender.providerJobId !== fundedRender.providerJobId) {
    throw new Error('Render submission idempotency did not return the existing accepted job.');
  }
  if (jobsAfterDuplicateFundedRender !== jobsBeforeFundedRender + 1) {
    throw new Error('Render submission idempotency created a duplicate local job.');
  }

  const reservation = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RENDER_RESERVATION_HOLD, jobId: fundedRender.jobId },
  });
  if (!reservation || Number(reservation.amountUsd) !== -2) {
    throw new Error('Accepted render did not create the expected reservation hold transaction.');
  }

  const afterReservationUser = await prisma.user.findUnique({ where: { id: registered.user.id } });
  if (Number(afterReservationUser.starterBalanceUsd) !== 12) {
    throw new Error(`Expected balance 12 after reservation, got ${afterReservationUser.starterBalanceUsd}.`);
  }

  const dispatchFailureUpload = await request('/api/get-upload-url', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({ fileName: 'dispatch-fail-smoke.blend', fileSizeBytes: 1024 }),
  });
  const beforeDispatchFailureBalance = Number((await prisma.user.findUnique({ where: { id: registered.user.id } })).starterBalanceUsd);
  const dispatchFailure = await rawRequest('/api/trigger-render', {
    method: 'POST',
    headers: { ...cookieHeaders, 'Idempotency-Key': `dispatch-failure-${Date.now()}` },
    body: JSON.stringify({
      fileKey: dispatchFailureUpload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
      maxBudgetUsd: 2,
    }),
  });
  if (dispatchFailure.response.status !== 502 || !dispatchFailure.data.jobId || dispatchFailure.data.dispatchStatus !== 'FAILED') {
    throw new Error(`Expected dispatch failure to return a persisted failed job, got ${dispatchFailure.response.status}.`);
  }
  const failedDispatchJob = await prisma.job.findUnique({ where: { jobId: dispatchFailure.data.jobId } });
  if (!failedDispatchJob || failedDispatchJob.dispatchStatus !== 'FAILED' || failedDispatchJob.billingState !== 'RELEASED' || failedDispatchJob.reservationReleasedAt === null) {
    throw new Error('Dispatch failure did not persist a failed local job and release its hold.');
  }
  const dispatchFailureRelease = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE, jobId: dispatchFailure.data.jobId },
  });
  const afterDispatchFailureBalance = Number((await prisma.user.findUnique({ where: { id: registered.user.id } })).starterBalanceUsd);
  if (!dispatchFailureRelease || afterDispatchFailureBalance !== beforeDispatchFailureBalance) {
    throw new Error('Dispatch failure did not release prepaid credits back to the user.');
  }
  const duplicateDispatchFailure = await rawRequest('/api/trigger-render', {
    method: 'POST',
    headers: { ...cookieHeaders, 'Idempotency-Key': failedDispatchJob.idempotencyKey.split(':').pop() },
    body: JSON.stringify({
      fileKey: dispatchFailureUpload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
      maxBudgetUsd: 2,
    }),
  });
  if (duplicateDispatchFailure.response.status !== 409 || duplicateDispatchFailure.data.jobId !== failedDispatchJob.jobId) {
    throw new Error('Retrying a failed dispatch idempotency key did not return the recoverable failed job without redispatching.');
  }

  const completedJob = await persistRunpodStatus(registered.user.id, fundedRender.jobId, {
    status: 'COMPLETED',
    output: { result_key: `finished_renders/${fundedRender.jobId}.png` },
    executionTime: 125000,
  });
  if (!completedJob?.billedAt || completedJob.billingState !== 'SETTLED' || Number(completedJob.priceUsd) !== 1.25) {
    throw new Error('Completed render did not settle billing with the expected final charge.');
  }

  const completionCharge = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RENDER_CHARGE, jobId: fundedRender.jobId },
  });
  const completionRelease = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE, jobId: fundedRender.jobId },
  });
  if (!completionCharge || Number(completionCharge.amountUsd) !== -1.25 || !completionRelease || Number(completionRelease.amountUsd) !== 2) {
    throw new Error('Completed render did not record the expected charge and reservation release.');
  }

  await persistRunpodStatus(registered.user.id, fundedRender.jobId, {
    status: 'COMPLETED',
    output: { result_key: `finished_renders/${fundedRender.jobId}.png` },
    executionTime: 125000,
  });
  const completionCharges = await prisma.creditTransaction.count({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RENDER_CHARGE, jobId: fundedRender.jobId },
  });
  const userAfterDuplicateCompletion = await prisma.user.findUnique({ where: { id: registered.user.id } });
  if (completionCharges !== 1 || Number(userAfterDuplicateCompletion.starterBalanceUsd) !== 12.75) {
    throw new Error('Completion billing was not idempotent or produced an unexpected balance.');
  }
  if (Number(userAfterDuplicateCompletion.starterBalanceUsd) < 0) throw new Error('Successful billing produced a negative balance.');

  const cancelUpload = await request('/api/get-upload-url', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({ fileName: 'cancel-smoke.blend', fileSizeBytes: 1024 }),
  });
  const cancelRender = await request('/api/trigger-render', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({
      fileKey: cancelUpload.key,
      projectId: project.project.id,
      engine: 'CYCLES',
      outputFormat: 'PNG',
      denoiser: 'NONE',
      maxBudgetUsd: 2,
    }),
  });
  const cancelled = await rawRequest('/api/cancel-job', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({ jobId: cancelRender.jobId }),
  });
  if (!cancelled.response.ok || cancelled.data.job?.billingState !== 'RELEASED') {
    throw new Error('Cancelled render did not release the reservation hold.');
  }

  const cancelRelease = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE, jobId: cancelRender.jobId },
  });
  const userAfterCancel = await prisma.user.findUnique({ where: { id: registered.user.id } });
  if (!cancelRelease || Number(cancelRelease.amountUsd) !== 2 || Number(userAfterCancel.starterBalanceUsd) !== 12.75) {
    throw new Error('Cancellation did not restore the reserved credits.');
  }

  const pagedJobs = await request('/api/jobs?page=1&pageSize=2&status=all', { headers: cookieHeaders });
  if (pagedJobs.jobs.length !== 2 || pagedJobs.pagination?.pageSize !== 2 || pagedJobs.pagination?.totalItems < 4 || !pagedJobs.pagination?.hasNextPage) {
    throw new Error('Paginated jobs endpoint did not enforce page size or return expected metadata.');
  }
  const activePagedJobs = await request('/api/jobs?page=1&pageSize=2&status=active', { headers: cookieHeaders });
  if (!activePagedJobs.jobs.every((job) => ['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING'].includes(job.status))) {
    throw new Error('Job status filter returned non-active jobs.');
  }
  const invalidJobStatus = await rawRequest('/api/jobs?status=NOT_A_STATUS', { headers: cookieHeaders });
  if (invalidJobStatus.response.status !== 400) {
    throw new Error(`Expected invalid job status filter to return 400, got ${invalidJobStatus.response.status}.`);
  }
  const renderedFilesPage = await request('/api/rendered-files?page=1&pageSize=2', { headers: cookieHeaders });
  if (renderedFilesPage.files.length !== 1 || renderedFilesPage.pagination?.totalItems !== 1) {
    throw new Error('Rendered files endpoint did not return expected paginated response.');
  }
  const accessKeysPage = await request('/api/auth/access-keys?page=1&pageSize=2', { headers: cookieHeaders });
  if (accessKeysPage.accessKeys.length < 1 || accessKeysPage.pagination?.pageSize !== 2) {
    throw new Error('Access keys endpoint did not return expected paginated response.');
  }

  const rateLimitedProject = await rawRequest('/api/projects', {
    method: 'POST',
    headers: cookieHeaders,
    body: JSON.stringify({ name: 'Smoke project rate limit check' }),
  });
  if (rateLimitedProject.response.status !== 429) {
    throw new Error(`Expected account mutation rate limit to return 429 after repeated project/access-key mutations, got ${rateLimitedProject.response.status}.`);
  }

  const failedJobId = `smoke-failed-${Date.now()}`;
  await prisma.job.create({
    data: {
      jobId: failedJobId,
      userId: registered.user.id,
      projectId: project.project.id,
      fileKey: `smoke-failed/${registered.user.id}.blend`,
      status: 'SUBMITTED',
      frameCount: 1,
      maxBudgetUsd: 1,
      reservedCreditsUsd: 1,
      billingState: 'RESERVED',
      billingMetadata: { reservationReferenceId: failedJobId },
    },
  });
  await applyCreditTransaction({
    userId: registered.user.id,
    type: CREDIT_TRANSACTION_TYPES.RENDER_RESERVATION_HOLD,
    amountUsd: 1,
    referenceType: 'render_reservation',
    referenceId: failedJobId,
    jobId: failedJobId,
    idempotencyKey: `render-reservation:${failedJobId}`,
    metadata: { source: 'smoke_failed_job' },
  });
  const releasedFailedJob = await persistRunpodStatus(registered.user.id, failedJobId, { status: 'FAILED', error: 'Smoke render failure' });
  const failedRelease = await prisma.creditTransaction.findFirst({
    where: { userId: registered.user.id, type: CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE, jobId: failedJobId },
  });
  const userAfterFailure = await prisma.user.findUnique({ where: { id: registered.user.id } });
  if (releasedFailedJob?.billingState !== 'RELEASED' || !failedRelease || Number(userAfterFailure.starterBalanceUsd) !== 12.75) {
    throw new Error('Failed render did not release/refund its reservation hold.');
  }

  const summary = await request('/api/admin/summary', {
    headers: { Authorization: 'Bearer smoke-admin' },
  });
  if (summary.users !== initialSummary.users + 1) {
    throw new Error(`Expected admin summary user count to increase by one, got ${summary.users - initialSummary.users}.`);
  }
  if (summary.jobs !== initialSummary.jobs + 5) {
    throw new Error(`Expected smoke ledger, completed, dispatch-failed, cancelled, and failed jobs to be present, job count changed from ${initialSummary.jobs} to ${summary.jobs}.`);
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
  await prisma.$disconnect();
}
