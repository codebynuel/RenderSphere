import { config } from '../../helpers/config.js';
import { readResponseJson } from '../../helpers/http.js';
import { logger } from '../../helpers/logger.js';

const mockJobs = new Map();

export class ModalProviderError extends Error {
  constructor(message, { status = 502, data = null, code = 'MODAL_PROVIDER_ERROR', retryable = false, operation = 'modal_request', cause = null } = {}) {
    super(message);
    this.name = 'ModalProviderError';
    this.status = status;
    this.data = data;
    this.code = code;
    this.retryable = retryable;
    this.operation = operation;
    this.cause = cause;
  }
}

export function getModalResultKey(data) {
  return data?.output?.result_key || data?.output?.resultKey || data?.output?.key || data?.result_key || data?.resultKey || null;
}

export function getModalExecutionSeconds(data, job) {
  const executionMs = Number(data?.executionTimeMs ?? data?.executionTime ?? data?.output?.executionTimeMs);
  if (Number.isFinite(executionMs) && executionMs > 0) return Math.max(1, Math.ceil(executionMs / 1000));

  const durationSeconds = Number(data?.durationSeconds ?? data?.duration_seconds ?? data?.output?.durationSeconds ?? data?.output?.duration_seconds);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return Math.max(1, Math.ceil(durationSeconds));

  const startedAt = new Date(job?.dispatchedAt || job?.createdAt || Date.now()).getTime();
  if (!Number.isFinite(startedAt)) return 1;
  return Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
}

function modalEnabled() {
  return process.env.RENDERSPHERE_MOCK_MODAL === 'true';
}

function mockDispatchFailurePattern() {
  return String(process.env.RENDERSPHERE_MOCK_MODAL_FAIL_FILEKEY_PATTERN || '').trim();
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
    return new ModalProviderError(`Modal ${operation} timed out`, {
      status: 504,
      data: { error: 'Modal request timed out' },
      code: 'MODAL_TIMEOUT',
      retryable: true,
      operation,
      cause,
    });
  }

  if (cause && !status) {
    return new ModalProviderError(`Modal ${operation} network error`, {
      status: 502,
      data: { error: cause.message || 'Modal network error' },
      code: 'MODAL_NETWORK_ERROR',
      retryable: true,
      operation,
      cause,
    });
  }

  const safeStatus = Number.isInteger(status) ? status : 502;
  return new ModalProviderError(providerMessage(data, `Modal ${operation} failed with ${safeStatus}`), {
    status: safeStatus,
    data,
    code: retryableStatus(safeStatus) ? 'MODAL_TRANSIENT_ERROR' : 'MODAL_REQUEST_REJECTED',
    retryable: retryableStatus(safeStatus),
    operation,
    cause,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function modalRequest(payload, {
  operation,
  retries = 0,
  retryUnsafe = false,
  requestId = null,
} = {}) {
  if (!config.modalEndpointUrl || !config.modalApiSecret) {
    throw new ModalProviderError('Modal provider is not configured', {
      status: 503,
      code: 'MODAL_NOT_CONFIGURED',
      operation,
    });
  }

  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.modalRequestTimeoutMs);

    try {
      const response = await fetch(config.modalEndpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.modalApiSecret}`,
          'Content-Type': 'application/json',
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await readResponseJson(response);
      clearTimeout(timeout);

      if (!response.ok) throw classifyProviderError({ status: response.status, data, operation });
      if (attempt > 1) {
        logger.info('Modal request recovered after retry', { context: 'modal', requestId, operation, attempt, statusCode: response.status });
      }
      return data;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof ModalProviderError
        ? error
        : classifyProviderError({ operation, cause: error });

      logger.warn('Modal request failed', {
        context: 'modal',
        requestId,
        operation,
        attempt,
        maxAttempts,
        statusCode: lastError.status,
        code: lastError.code,
        retryable: lastError.retryable,
        error: lastError,
      });

      if (attempt >= maxAttempts || !lastError.retryable || !retryUnsafe) break;

      const backoffMs = Math.min(2500, config.modalRetryBackoffMs * (2 ** (attempt - 1)));
      await delay(backoffMs);
    }
  }

  throw lastError;
}

export async function fetchModalJobStatus(providerJobId, { requestId = null } = {}) {
  if (modalEnabled()) {
    return mockJobs.get(providerJobId) || { id: providerJobId, status: 'IN_PROGRESS' };
  }
  return modalRequest({ action: 'status', id: providerJobId }, {
    operation: 'status',
    retries: config.modalStatusMaxRetries,
    retryUnsafe: true,
    requestId,
  });
}

export async function startModalRender(input, { idempotencyKey = null, requestId = null } = {}) {
  if (modalEnabled()) {
    const failurePattern = mockDispatchFailurePattern();
    if (failurePattern && String(input?.fileKey || '').includes(failurePattern)) {
      throw new ModalProviderError('Mock Modal dispatch failure', {
        status: 502,
        data: { error: 'Mock Modal dispatch failure' },
        code: 'MODAL_MOCK_DISPATCH_FAILURE',
        retryable: true,
        operation: 'dispatch',
      });
    }

    const id = `mock-modal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const job = { id, status: 'IN_PROGRESS', input };
    mockJobs.set(id, job);
    return job;
  }

  return modalRequest({ action: 'submit', input, idempotencyKey }, {
    operation: 'dispatch',
    requestId,
  });
}

export async function cancelModalJob(providerJobId, { requestId = null } = {}) {
  if (modalEnabled()) {
    const data = { id: providerJobId, status: 'CANCELLED' };
    mockJobs.set(providerJobId, data);
    return { ok: true, status: 200, data };
  }

  try {
    const data = await modalRequest({ action: 'cancel', id: providerJobId }, {
      operation: 'cancel',
      retries: config.modalCancelMaxRetries,
      retryUnsafe: true,
      requestId,
    });
    return { ok: data.status === 'CANCELLED', status: data.status === 'CANCELLED' ? 200 : 409, data };
  } catch (error) {
    return {
      ok: false,
      status: error.status || 502,
      data: error.data || { error: error.message || 'Modal cancel failed' },
      error,
    };
  }
}
