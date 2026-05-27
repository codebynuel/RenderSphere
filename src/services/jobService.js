import { ACTIVE_JOB_STATUSES, VALID_DENOISERS, VALID_ENGINES, VALID_OUTPUT_FORMATS, config } from '../../helpers/config.js';
import { prisma } from '../db.js';
import { fetchRunpodJobStatus, getRunpodExecutionSeconds, getRunpodResultKey } from './runpodService.js';

const INTERNAL_ERROR_MARKERS = [
  'runpod',
  'traceback',
  'error_traceback',
  'hostname',
  'worker_id',
  'serverless',
  'rp_job.py',
  'handler.py',
  '/usr/local/',
];

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function readInteger(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) return fallback;
  return numberValue;
}

export function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

export function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function normalizeOptionalName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 120) return null;
  return normalized;
}

export function renderedFileDownloadPath(jobId) {
  return `/api/rendered-files/${encodeURIComponent(jobId)}/download`;
}

export function normalizeRenderSettings(body) {
  const isAnimation = normalizeBoolean(body.isAnimation, false);
  const startFrame = readInteger(body.startFrame, 1);
  const endFrame = isAnimation ? readInteger(body.endFrame, startFrame) : startFrame;
  const samples = readInteger(body.samples, 256);
  const resolutionPct = readInteger(body.resolutionPct, 100);
  const noiseThreshold = clampNumber(body.noiseThreshold, 0, 1, 0.01);
  const camera = normalizeOptionalName(body.camera);
  const scene = normalizeOptionalName(body.scene);

  if (startFrame < 0 || endFrame < 0 || endFrame < startFrame) return { error: 'Invalid frame range' };

  const frameCount = isAnimation ? endFrame - startFrame + 1 : 1;
  if (frameCount > config.maxAnimationFrames) return { error: `Animation frame count exceeds limit of ${config.maxAnimationFrames}` };
  if (samples < 1 || samples > config.maxRenderSamples) return { error: `Samples must be between 1 and ${config.maxRenderSamples}` };
  if (resolutionPct < 1 || resolutionPct > config.maxResolutionPct) return { error: `Resolution percentage must be between 1 and ${config.maxResolutionPct}` };

  return { isAnimation, startFrame, endFrame, frameCount, samples, resolutionPct, noiseThreshold, camera, scene };
}

export function validateRenderChoices({ engine, outputFormat, denoiser }) {
  if (!VALID_ENGINES.has(engine)) return 'Invalid engine';
  if (!VALID_OUTPUT_FORMATS.has(outputFormat)) return 'Invalid outputFormat';
  if (!VALID_DENOISERS.has(denoiser)) return 'Invalid denoiser';
  return null;
}

export function buildRunpodInput({ fileKey, engine, outputFormat, denoiser, normalizedSettings }) {
  return {
    fileKey,
    engine,
    samples: normalizedSettings.samples,
    isAnimation: normalizedSettings.isAnimation,
    startFrame: normalizedSettings.startFrame,
    endFrame: normalizedSettings.endFrame,
    outputFormat,
    resolutionPct: normalizedSettings.resolutionPct,
    denoiser,
    noiseThreshold: normalizedSettings.noiseThreshold,
    camera: normalizedSettings.camera,
    scene: normalizedSettings.scene,
    output_format: outputFormat,
    resolution_pct: normalizedSettings.resolutionPct,
    noise_threshold: normalizedSettings.noiseThreshold,
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function providerErrorMessage(error) {
  const parsed = parseMaybeJson(error);
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';

  return firstString(
    parsed.user_message,
    parsed.userMessage,
    parsed.message,
    parsed.error_message,
    parsed.error,
    parsed.output?.message,
    parsed.output?.error
  );
}

export function sanitizeRenderError(error, fallback = 'Render failed while processing the scene.') {
  const rawMessage = providerErrorMessage(error) || fallback;
  const normalized = rawMessage.replace(/\s+/g, ' ').trim();
  const lowerMessage = normalized.toLowerCase();

  if (lowerMessage.includes('blender crashed') || lowerMessage.includes('exit code')) {
    return 'Blender stopped unexpectedly while rendering this scene. Try lowering samples or resolution, then submit again.';
  }

  if (!normalized || INTERNAL_ERROR_MARKERS.some((marker) => lowerMessage.includes(marker))) {
    return fallback;
  }

  return normalized.slice(0, 320);
}

function unwrapStreamPayload(item) {
  let payload = parseMaybeJson(item);

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload = payload.update ?? payload.output ?? payload.message ?? payload.data ?? payload;
    payload = parseMaybeJson(payload);
  }

  return payload;
}

export function extractProgressFromRunpodData(rpData) {
  const stream = Array.isArray(rpData?.stream) ? rpData.stream : [];

  for (const item of [...stream].reverse()) {
    const payload = unwrapStreamPayload(item);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;

    const currentFrame = Number(payload.current_frame ?? payload.currentFrame);
    const currentSample = Number(payload.current_sample ?? payload.currentSample);
    const percent = Number(payload.percent ?? payload.progress ?? payload.progressPercent);

    const progress = {
      updatedAt: new Date().toISOString(),
    };

    if (Number.isFinite(currentFrame)) progress.currentFrame = currentFrame;
    if (Number.isFinite(currentSample)) progress.currentSample = currentSample;
    if (Number.isFinite(percent)) progress.percent = Math.min(100, Math.max(0, percent));
    if (typeof payload.message === 'string') progress.message = payload.message.slice(0, 240);

    if (Object.keys(progress).length > 1) return progress;
  }

  return null;
}

function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
  return progress;
}

export function calculateProgressPercent(job, progressInput = job?.progress) {
  const status = job?.status || 'SUBMITTED';
  if (status === 'COMPLETED') return 100;

  const progress = normalizeProgress(progressInput);
  if (Number.isFinite(Number(progress.percent))) return Math.min(100, Math.max(0, Number(progress.percent)));
  if (status === 'FAILED' || status === 'CANCELLED') return Number(job?.progress?.percent || 0);

  const settings = job?.settings || {};
  const samples = Math.max(1, Number(settings.samples || 1));
  const startFrame = Number(settings.startFrame ?? settings.start_frame ?? 1);
  const endFrame = Number(settings.endFrame ?? settings.end_frame ?? startFrame);
  const frameCount = Math.max(1, Number(job?.frameCount || endFrame - startFrame + 1 || 1));
  const currentFrame = Number(progress.currentFrame ?? startFrame);
  const currentSample = Number(progress.currentSample ?? 0);

  if (settings.isAnimation || settings.is_animation) {
    const frameIndex = Math.min(frameCount - 1, Math.max(0, currentFrame - startFrame));
    const sampleRatio = Math.min(1, Math.max(0, currentSample / samples));
    return Math.round(((frameIndex + sampleRatio) / frameCount) * 100);
  }

  if (currentSample > 0) return Math.round(Math.min(1, currentSample / samples) * 100);
  if (status === 'RUNNING' || status === 'IN_PROGRESS') return 10;
  if (status === 'IN_QUEUE') return 4;
  return 2;
}

export function serializeJob(job, rpData = null) {
  if (!job) return null;
  const progress = normalizeProgress(job.progress);
  const serialized = {
    ...job,
    progress: {
      ...progress,
      percent: calculateProgressPercent(job, progress),
    },
    downloadUrl: job.status === 'COMPLETED' && job.resultKey ? renderedFileDownloadPath(job.jobId) : null,
  };

  if (rpData?.stream) serialized.stream = rpData.stream;
  return serialized;
}

export function serializeRenderedFile(job) {
  return {
    jobId: job.jobId,
    projectId: job.projectId || null,
    project: job.project || null,
    resultKey: job.resultKey,
    fileName: job.resultKey?.split('/').pop() || 'render-output',
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    outputFormat: job.settings?.outputFormat || job.settings?.output_format || null,
    billableSeconds: job.billableSeconds || 0,
    priceUsd: typeof job.priceUsd === 'number' ? job.priceUsd : 0,
    downloadUrl: renderedFileDownloadPath(job.jobId),
  };
}

export async function persistRunpodStatus(userId, jobId, rpData) {
  const status = rpData.status || 'UNKNOWN';
  const resultKey = getRunpodResultKey(rpData);
  const progress = extractProgressFromRunpodData(rpData);

  const job = await prisma.job.findUnique({ where: { jobId }, include: { project: true } });
  if (!job || job.userId !== userId) return null;

  const updateData = { status, lastCheckedAt: new Date() };
  if (progress) {
    updateData.progress = {
      ...(job.progress && typeof job.progress === 'object' ? job.progress : {}),
      ...progress,
    };
  }

  if (status === 'COMPLETED') {
    updateData.resultKey = resultKey || job.resultKey || null;
    updateData.completedAt = job.completedAt || new Date();
    updateData.error = null;
    updateData.progress = {
      ...(updateData.progress || (job.progress && typeof job.progress === 'object' ? job.progress : {})),
      percent: 100,
      updatedAt: new Date().toISOString(),
    };
  } else if (status === 'FAILED') {
    updateData.error = sanitizeRenderError(rpData.error || rpData.output, 'Render failed while processing the scene.');
    updateData.failedAt = job.failedAt || new Date();
  } else if (status === 'CANCELLED') {
    updateData.cancelledAt = job.cancelledAt || new Date();
  }

  return prisma.$transaction(async (tx) => {
    if (status === 'COMPLETED' && updateData.resultKey && !job.billedAt) {
      const billableSeconds = getRunpodExecutionSeconds(rpData, job);
      const priceUsd = roundMoney(billableSeconds * config.renderPricePerSecondUsd);
      const billedJob = await tx.job.updateMany({
        where: { jobId, userId, billedAt: null },
        data: {
          ...updateData,
          billableSeconds,
          priceUsd,
          pricePerSecondUsd: config.renderPricePerSecondUsd,
          billedAt: new Date(),
        },
      });

      if (billedJob.count > 0 && priceUsd > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { starterBalanceUsd: { decrement: priceUsd } },
        });
      }
    } else {
      await tx.job.updateMany({ where: { jobId, userId }, data: updateData });
    }

    return tx.job.findUnique({ where: { jobId }, include: { project: true } });
  });
}

export async function syncActiveJobsForUser(userId, emitJobUpdate = null) {
  const syncableJobs = await prisma.job.findMany({
    where: {
      userId,
      OR: [
        { status: { in: Array.from(ACTIVE_JOB_STATUSES) } },
        { status: 'COMPLETED', resultKey: null },
      ],
    },
    include: { project: true },
  });

  await Promise.all(syncableJobs.map(async (job) => {
    try {
      const rpData = await fetchRunpodJobStatus(job.jobId);
      const updatedJob = await persistRunpodStatus(userId, job.jobId, rpData);
      if (updatedJob && emitJobUpdate) emitJobUpdate(updatedJob, rpData);
    } catch (error) {
      console.error(`Could not sync render job ${job.jobId}:`, error);
    }
  }));
}
