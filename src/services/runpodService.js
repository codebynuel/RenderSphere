import { config } from '../../helpers/config.js';
import { readResponseJson } from '../../helpers/http.js';
import { logger } from '../../helpers/logger.js';

export class RunpodProviderError extends Error {
  constructor(message, { status = 502, data = null, code = 'RUNPOD_PROVIDER_ERROR', retryable = false, operation = 'runpod_request', cause = null } = {}) {
    super(message);
    this.name = 'RunpodProviderError';
    this.status = status;
    this.data = data;
    this.code = code;
    this.retryable = retryable;
    this.operation = operation;
    this.cause = cause;
  }
}

export function getRunpodResultKey(data) {
  return data?.output?.result_key || data?.output?.resultKey || data?.output?.key || data?.result_key || data?.resultKey || null;
}

export function getRunpodExecutionSeconds(data, job) {
  const executionMs = Number(data?.executionTime ?? data?.output?.executionTime ?? data?.output?.execution_time);
  if (Number.isFinite(executionMs) && executionMs > 0) return Math.max(1, Math.ceil(executionMs / 1000));

  const durationSeconds = Number(data?.durationSeconds ?? data?.duration_seconds ?? data?.output?.durationSeconds ?? data?.output?.duration_seconds);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return Math.max(1, Math.ceil(durationSeconds));

  const startedAt = new Date(job?.dispatchedAt || job?.createdAt || Date.now()).getTime();
  if (!Number.isFinite(startedAt)) return 1;
  return Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
}

function runpodBaseUrl() {
  return `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}`;
}

function runpodHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
  };
}

function mockRunpodEnabled() {
  return process.env.RENDERSPHERE_MOCK_RUNPOD === 'true';
}

function mockDispatchFailurePattern() {
  return String(process.env.RENDERSPHERE_MOCK_RUNPOD_FAIL_FILEKEY_PATTERN || '').trim();
}

function providerMessage(data, fallback) {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
  return data.error || data.message || data.detail || data.output?.error || data.output?.message || fallback;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function classifyProviderError({ status, data, operation, cause = null }) {
  if (cause?.name === 'AbortError') {
    return new RunpodProviderError(`RunPod ${operation} timed out`, {
      status: 504,
      data: { error: 'RunPod request timed out' },
      code: 'RUNPOD_TIMEOUT',
      retryable: true,
      operation,
      cause,
    });
  }

  if (cause && !status) {
    return new RunpodProviderError(`RunPod ${operation} network error`, {
      status: 502,
      data: { error: cause.message || 'RunPod network error' },
      code: 'RUNPOD_NETWORK_ERROR',
      retryable: true,
      operation,
      cause,
    });
  }

  const safeStatus = Number.isInteger(status) ? status : 502;
  return new RunpodProviderError(providerMessage(data, `RunPod ${operation} failed with ${safeStatus}`), {
    status: safeStatus,
    data,
    code: retryableStatus(safeStatus) ? 'RUNPOD_TRANSIENT_ERROR' : 'RUNPOD_REQUEST_REJECTED',
    retryable: retryableStatus(safeStatus),
    operation,
    cause,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runpodFetch(pathname, {
  method = 'GET',
  body = null,
  headers = {},
  operation = 'request',
  timeoutMs = config.runpodRequestTimeoutMs,
  retries = 0,
  retryUnsafe = false,
  requestId = null,
} = {}) {
  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${runpodBaseUrl()}${pathname}`, {
        method,
        headers: runpodHeaders(headers),
        body,
        signal: controller.signal,
      });
      const data = await readResponseJson(response);
      clearTimeout(timeout);

      if (!response.ok) throw classifyProviderError({ status: response.status, data, operation });
      if (attempt > 1) {
        logger.info('RunPod request recovered after retry', { context: 'runpod', requestId, operation, attempt, statusCode: response.status });
      }
      return { response, data };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof RunpodProviderError
        ? error
        : classifyProviderError({ operation, cause: error });

      logger.warn('RunPod request failed', {
        context: 'runpod',
        requestId,
        operation,
        attempt,
        maxAttempts,
        statusCode: lastError.status,
        code: lastError.code,
        retryable: lastError.retryable,
        error: lastError,
      });

      const mayRetryMethod = method === 'GET' || method === 'HEAD' || method === 'DELETE' || retryUnsafe;
      if (attempt >= maxAttempts || !lastError.retryable || !mayRetryMethod) break;

      const backoffMs = Math.min(2500, config.runpodRetryBackoffMs * (2 ** (attempt - 1)));
      await delay(backoffMs);
    }
  }

  throw lastError;
}

export async function fetchRunpodJobStatus(providerJobId, { requestId = null } = {}) {
  const { data } = await runpodFetch(`/status/${encodeURIComponent(providerJobId)}`, {
    operation: 'status',
    retries: config.runpodStatusMaxRetries,
    requestId,
  });
  return data;
}

export async function cancelRunpodJob(providerJobId, { requestId = null } = {}) {
  if (mockRunpodEnabled()) return { ok: true, status: 200, data: { id: providerJobId, status: 'CANCELLED' } };

  try {
    const { response, data } = await runpodFetch(`/cancel/${encodeURIComponent(providerJobId)}`, {
      method: 'DELETE',
      operation: 'cancel',
      retries: config.runpodCancelMaxRetries,
      requestId,
    });
    return { ok: true, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: error.status || 502,
      data: error.data || { error: error.message || 'RunPod cancel failed' },
      error,
    };
  }
}

// ─── Pod lifecycle ────────────────────────────────────────────────────────────

function podApiUrl() {
  return 'https://api.runpod.ai/v2/pods';
}

function podHeaders(extra = {}) {
  return { ...extra, Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` };
}

async function podApiFetch(pathname, { method = 'GET', body = null, operation = 'pod_request', timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${podApiUrl()}${pathname}`, {
      method,
      headers: podHeaders({ 'Content-Type': 'application/json' }),
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new RunpodProviderError(
        data.message || data.error || `Pod API ${operation} failed with ${response.status}`,
        { status: response.status, data, code: 'POD_API_ERROR', operation, retryable: false },
      );
    }
    return data;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof RunpodProviderError) throw error;
    throw new RunpodProviderError(`Pod API ${operation} network error`, {
      status: 502, data: { error: error.message }, code: 'POD_NETWORK_ERROR', operation, retryable: true, cause: error,
    });
  }
}

export async function listPods() {
  const data = await podApiFetch('', { operation: 'list_pods' });
  return data || [];
}

export async function getPod(podId) {
  return podApiFetch(`/${encodeURIComponent(podId)}`, { operation: 'get_pod' });
}

export async function startPod(podId) {
  const result = await podApiFetch(`/${encodeURIComponent(podId)}/start`, {
    method: 'POST',
    operation: 'start_pod',
    timeoutMs: 60_000,
  });
  return result;
}

export async function stopPod(podId) {
  const result = await podApiFetch(`/${encodeURIComponent(podId)}/stop`, {
    method: 'POST',
    operation: 'stop_pod',
    timeoutMs: 30_000,
  });
  return result;
}

export async function createPod(spec = {}) {
  const gpuTypeId = config.runpodGpuTypeId || 'NVIDIA-GeForce-RTX-5090';
  const templateId = config.runpodPodTemplateId || '';
  const body = {
    name: spec.name || `rendersphere-worker-${Date.now()}`,
    imageName: spec.imageName || process.env.RUNPOD_WORKER_IMAGE || 'nvidia/cuda:12.1.1-base-ubuntu22.04',
    gpuTypeId: spec.gpuTypeId || gpuTypeId,
    gpuCount: spec.gpuCount || 1,
    containerDiskSizeGb: spec.containerDiskSizeGb || 20,
    ...(templateId ? { templateId } : {}),
    env: spec.env || [
      { key: 'CUDA_CACHE_PATH', value: '/runpod-volume' },
      { key: 'CUDA_MODULE_LOADING', value: 'EAGER' },
    ],
    ...(spec.networkVolumeId ? { networkVolumeId: spec.networkVolumeId } : {}),
  };
  const result = await podApiFetch('', {
    method: 'POST',
    body,
    operation: 'create_pod',
    timeoutMs: 60_000,
  });
  return result;
}

export async function waitForPodRunning(podId, { timeoutMs = config.runpodPodStartTimeoutMs, pollIntervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const pod = await getPod(podId);
    const desiredStatus = pod?.desiredStatus || '';
    const status = (pod?.podStatus || pod?.status || '').toLowerCase();
    if (status !== lastStatus) {
      logger.info('Pod status update', { context: 'pod_lifecycle', podId, status, desiredStatus });
      lastStatus = status;
    }
    if (status === 'running') return pod;
    await delay(pollIntervalMs);
  }
  throw new RunpodProviderError(`Pod ${podId} did not reach RUNNING within ${timeoutMs}ms`, {
    status: 504, data: { error: 'Pod start timeout' }, code: 'POD_START_TIMEOUT', operation: 'wait_pod', retryable: true,
  });
}

export async function findOrCreatePod() {
  // If a specific pod ID is configured, use it
  if (config.runpodPodId) {
    try {
      const pod = await getPod(config.runpodPodId);
      if (pod) return pod;
    } catch {
      logger.warn('Configured pod not found, will try to create', { context: 'pod_lifecycle', podId: config.runpodPodId });
    }
  }

  // Try to find a stopped pod with matching GPU type
  const gpuTypeId = config.runpodGpuTypeId || '';
  try {
    const pods = await listPods();
    const stopped = pods.find((p) => {
      const status = (p.podStatus || p.status || '').toLowerCase();
      const gpuMatch = !gpuTypeId || p.gpuTypeId === gpuTypeId || p.gpuType === gpuTypeId;
      return (status === 'stopped' || status === 'exited') && gpuMatch;
    });
    if (stopped) {
      logger.info('Found stopped pod to reuse', { context: 'pod_lifecycle', podId: stopped.id, gpuType: stopped.gpuTypeId });
      return stopped;
    }
  } catch (error) {
    logger.warn('Failed to list pods, will create new', { context: 'pod_lifecycle', error });
  }

  // No stopped pod found — create a new one
  const created = await createPod({ name: `rendersphere-worker-${Date.now()}` });
  logger.info('Created new render pod', { context: 'pod_lifecycle', podId: created.id });
  return created;
}

export async function runSyncOnPod(podId, command, { timeoutMs = 21600_000 } = {}) {
  const result = await podApiFetch(`/${encodeURIComponent(podId)}/runSync`, {
    method: 'POST',
    body: { input: { command, timeout: Math.ceil(timeoutMs / 1000) } },
    operation: 'run_sync',
    timeoutMs: timeoutMs + 30_000,
  });
  return result;
}

/**
 * Dispatch a render job using the pod lifecycle:
 *   1. Find or create a pod
 *   2. Start it if stopped
 *   3. Wait for RUNNING
 *   4. Execute render via runSync
 *   5. Stop the pod (preserve disk / CUDA cache)
 *   6. Return result in the same shape as serverless /run
 */
export async function startRunpodRender(input, { idempotencyKey = null, requestId = null } = {}) {
  if (mockRunpodEnabled()) {
    const failurePattern = mockDispatchFailurePattern();
    if (failurePattern && String(input?.fileKey || '').includes(failurePattern)) {
      throw new RunpodProviderError('Mock RunPod dispatch failure', {
        status: 502, data: { error: 'Mock RunPod dispatch failure' },
        code: 'RUNPOD_MOCK_DISPATCH_FAILURE', retryable: true, operation: 'dispatch',
      });
    }
    return {
      id: `mock-pod-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      status: 'COMPLETED',
      output: { resultKey: 'mock/result.png' },
      executionTime: 100,
    };
  }

  const pod = await findOrCreatePod();
  const podId = pod.id || pod.podId;

  // Start pod if not already running
  const status = (pod.podStatus || pod.status || '').toLowerCase();
  if (status !== 'running') {
    logger.info('Starting render pod', { context: 'pod_lifecycle', podId, currentStatus: status, requestId });
    await startPod(podId);
    await waitForPodRunning(podId);
  }

  // Build the handler CLI command
  const renderInput = { ...input, dispatchReference: input.dispatchReference };
  const escapedJson = JSON.stringify(renderInput).replace(/'/g, "'\\''");
  const command = `cd / && python3 /handler.py --input '${escapedJson}' 2>&1`;

  logger.info('Executing render on pod', { context: 'pod_lifecycle', podId, requestId, fileKey: input.fileKey });
  const runResult = await runSyncOnPod(podId, command, { timeoutMs: 21600_000 });

  // Stop pod to preserve disk / CUDA cache
  try {
    await stopPod(podId);
    logger.info('Stopped render pod', { context: 'pod_lifecycle', podId, requestId });
  } catch (stopError) {
    logger.warn('Failed to stop pod (may stop on its own)', { context: 'pod_lifecycle', podId, error: stopError });
  }

  // Parse handler output and shape response like serverless /run
  const outputText = typeof runResult.output === 'string' ? runResult.output : JSON.stringify(runResult.output || '');
  let parsedOutput = {};
  try { parsedOutput = JSON.parse(outputText); } catch { /* use raw output */ }

  const status2 = parsedOutput.status || (runResult.status === 'completed' ? 'COMPLETED' : 'FAILED');
  return {
    id: podId,
    status: status2,
    output: { resultKey: parsedOutput.result_key || parsedOutput.resultKey || null },
    error: parsedOutput.error || runResult.error || null,
    executionTime: runResult.executionTime || 0,
  };
}

/**
 * Fallback: fetch job status from serverless endpoint (used when serverless /run was the dispatch method).
 * For pod-dispatched jobs, the status is returned synchronously from startRunpodRender.
 */

