import { readResponseJson } from '../../helpers/http.js';

export function getRunpodResultKey(data) {
  return data?.output?.result_key || data?.output?.resultKey || data?.output?.key || data?.result_key || data?.resultKey || null;
}

export function getRunpodExecutionSeconds(data, job) {
  const executionMs = Number(data?.executionTime ?? data?.output?.executionTime ?? data?.output?.execution_time);
  if (Number.isFinite(executionMs) && executionMs > 0) return Math.max(1, Math.ceil(executionMs / 1000));

  const durationSeconds = Number(data?.durationSeconds ?? data?.duration_seconds ?? data?.output?.durationSeconds ?? data?.output?.duration_seconds);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return Math.max(1, Math.ceil(durationSeconds));

  const startedAt = new Date(job?.createdAt || Date.now()).getTime();
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

export async function fetchRunpodJobStatus(jobId) {
  const response = await fetch(`${runpodBaseUrl()}/status/${encodeURIComponent(jobId)}`, {
    headers: runpodHeaders(),
  });
  const data = await readResponseJson(response);
  if (!response.ok) throw new Error(data.error || data.message || `RunPod status failed with ${response.status}`);
  return data;
}

export async function startRunpodRender(input) {
  const response = await fetch(`${runpodBaseUrl()}/run`, {
    method: 'POST',
    headers: runpodHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ input }),
  });

  const data = await readResponseJson(response);
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'Failed to trigger RunPod');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export async function cancelRunpodJob(jobId) {
  const response = await fetch(`${runpodBaseUrl()}/cancel/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: runpodHeaders(),
  });
  const data = await readResponseJson(response);
  return { ok: response.ok, status: response.status, data };
}
