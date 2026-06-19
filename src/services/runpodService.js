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

export async function startRunpodRender(input, { idempotencyKey = null, requestId = null } = {}) {
  if (mockRunpodEnabled()) {
    const failurePattern = mockDispatchFailurePattern();
    if (failurePattern && String(input?.fileKey || '').includes(failurePattern)) {
      throw new RunpodProviderError('Mock RunPod dispatch failure', {
        status: 502,
        data: { error: 'Mock RunPod dispatch failure' },
        code: 'RUNPOD_MOCK_DISPATCH_FAILURE',
        retryable: true,
        operation: 'dispatch',
      });
    }

    return {
      id: `mock-runpod-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      status: 'SUBMITTED',
      input,
    };
  }

  const { data } = await runpodFetch('/run', {
    method: 'POST',
    operation: 'dispatch',
    retries: 0,
    requestId,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ input }),
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
