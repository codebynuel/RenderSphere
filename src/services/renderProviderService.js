import { readResponseJson } from '../../helpers/http.js';

export function getProviderResultKey(data) {
  return data?.output?.result_key || data?.output?.resultKey || data?.result_key || data?.resultKey || data?.key || null;
}

export function getProviderExecutionSeconds(data, job) {
  const executionSeconds = Number(data?.executionSeconds ?? data?.execution_seconds ?? data?.output?.executionSeconds ?? data?.output?.execution_seconds);
  if (Number.isFinite(executionSeconds) && executionSeconds > 0) return Math.max(1, Math.ceil(executionSeconds));

  const executionMs = Number(data?.executionTime ?? data?.execution_time ?? data?.output?.executionTime ?? data?.output?.execution_time);
  if (Number.isFinite(executionMs) && executionMs > 0) return Math.max(1, Math.ceil(executionMs / 1000));

  const startedAt = new Date(job?.createdAt || Date.now()).getTime();
  if (!Number.isFinite(startedAt)) return 1;
  return Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
}

function renderBaseUrl() {
  return String(process.env.MODAL_RENDER_ENDPOINT_URL || '').replace(/\/+$/, '');
}

function renderHeaders(extra = {}) {
  const token = process.env.MODAL_RENDER_TOKEN;
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function ensureRenderProviderConfigured() {
  if (!renderBaseUrl()) {
    throw new Error('MODAL_RENDER_ENDPOINT_URL is required to dispatch render jobs');
  }
}

function providerStatusFromHttpStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 404) return 'UNKNOWN';
  if (status === 409) return 'CANCELLED';
  return 'FAILED';
}

export async function fetchRenderJobStatus(jobId) {
  ensureRenderProviderConfigured();
  const response = await fetch(`${renderBaseUrl()}/status/${encodeURIComponent(jobId)}`, {
    headers: renderHeaders(),
  });
  const data = await readResponseJson(response);
  if (!response.ok) {
    const error = new Error(data.detail || data.error || data.message || `Render status failed with ${response.status}`);
    error.status = response.status;
    error.data = { id: jobId, status: providerStatusFromHttpStatus(response.status), error: error.message };
    throw error;
  }
  return data;
}

export async function startRenderJob(input) {
  ensureRenderProviderConfigured();
  const response = await fetch(`${renderBaseUrl()}/render`, {
    method: 'POST',
    headers: renderHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ input }),
  });

  const data = await readResponseJson(response);
  if (!response.ok) {
    const error = new Error(data.detail || data.error || data.message || 'Failed to trigger render');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export async function cancelRenderJob(jobId) {
  ensureRenderProviderConfigured();
  const response = await fetch(`${renderBaseUrl()}/cancel/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: renderHeaders(),
  });
  const data = await readResponseJson(response);
  return { ok: response.ok, status: response.status, data };
}
