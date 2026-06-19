import { ACTIVE_JOB_STATUSES, VALID_DENOISERS, VALID_ENGINES, VALID_OUTPUT_FORMATS, config } from '../../helpers/config.js';
import { prisma } from '../db.js';
import { chargeRenderCredits, releaseRenderReservation } from './creditService.js';
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

function clampInteger(value, min, max, fallback) {
  const numberValue = readInteger(value, fallback);
  return Math.min(max, Math.max(min, numberValue));
}

export function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function normalizeMoneyInput(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return roundMoney(numberValue);
}

export function estimateRenderCostUsd({ engine, outputFormat, denoiser, normalizedSettings }) {
  const frameCount = Math.max(1, Number(normalizedSettings.frameCount || 1));
  const samplesFactor = Math.max(0.1, Number(normalizedSettings.samples || 1) / 256);
  const resolutionFactor = Math.max(0.01, (Number(normalizedSettings.resolutionPct || 100) / 100) ** 2);
  const engineFactor = engine === 'CYCLES' ? 1 : 0.45;
  const denoiserFactor = denoiser === 'NONE' ? 1 : 1.08;
  const outputFactor = String(outputFormat || '').startsWith('OPEN_EXR') ? 1.15 : 1;
  const complexityFactor = normalizedSettings.advancedMode ? 1.1 : 1;
  const estimatedSeconds = Math.max(1, Math.ceil(
    config.renderEstimateBaseSecondsPerFrame
    * frameCount
    * samplesFactor
    * resolutionFactor
    * engineFactor
    * denoiserFactor
    * outputFactor
    * complexityFactor
  ));

  return {
    estimatedSeconds,
    estimatedCostUsd: roundMoney(estimatedSeconds * config.renderPricePerSecondUsd),
  };
}

export function resolveRenderBudget({ body = {}, estimatedCostUsd }) {
  const requestedBudget = normalizeMoneyInput(body.maxBudgetUsd ?? body.maxBudget ?? body.maxRenderBudgetUsd, null);
  const cappedFallbackBudget = Math.min(config.defaultRenderMaxBudgetUsd, config.maxRenderBudgetUsd);
  const fallbackBudget = Math.max(estimatedCostUsd, cappedFallbackBudget, config.minRenderReservationUsd);
  const maxBudgetUsd = Math.min(requestedBudget || fallbackBudget, config.maxRenderBudgetUsd);
  const reservationUsd = Math.max(config.minRenderReservationUsd, estimatedCostUsd, maxBudgetUsd);

  return {
    requestedBudgetUsd: requestedBudget,
    maxBudgetUsd: roundMoney(maxBudgetUsd),
    reservationUsd: roundMoney(Math.min(reservationUsd, config.maxRenderBudgetUsd)),
  };
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
  const advancedMode = normalizeBoolean(body.advancedMode, false);
  const frameStep = advancedMode && isAnimation ? readInteger(body.frameStep, 1) : 1;
  const gpuDeviceType = ['AUTO', 'OPTIX', 'CUDA'].includes(String(body.gpuDeviceType || '').toUpperCase()) ? String(body.gpuDeviceType).toUpperCase() : 'AUTO';
  const simplifyTextureLimit = ['OFF', '128', '256', '512', '1024', '2048', '4096'].includes(String(body.simplifyTextureLimit || '').toUpperCase()) ? String(body.simplifyTextureLimit).toUpperCase() : 'OFF';

  if (startFrame < 0 || endFrame < 0 || endFrame < startFrame) return { error: 'Invalid frame range' };
  if (frameStep < 1 || frameStep > 1000) return { error: 'Frame step must be between 1 and 1000' };

  const frameCount = isAnimation ? Math.floor((endFrame - startFrame) / frameStep) + 1 : 1;
  if (frameCount > config.maxAnimationFrames) return { error: `Animation frame count exceeds limit of ${config.maxAnimationFrames}` };
  if (samples < 1 || samples > config.maxRenderSamples) return { error: `Samples must be between 1 and ${config.maxRenderSamples}` };
  if (resolutionPct < 1 || resolutionPct > config.maxResolutionPct) return { error: `Resolution percentage must be between 1 and ${config.maxResolutionPct}` };

  return {
    isAnimation,
    startFrame,
    endFrame,
    frameCount,
    frameStep,
    samples,
    resolutionPct,
    noiseThreshold,
    camera,
    scene,
    advancedMode,
    gpuDeviceType,
    allowCpuFallback: advancedMode ? normalizeBoolean(body.allowCpuFallback, false) : false,
    transparentFilm: advancedMode ? normalizeBoolean(body.transparentFilm, false) : false,
    usePersistentData: advancedMode ? normalizeBoolean(body.usePersistentData, true) : true,
    viewTransform: advancedMode ? normalizeOptionalName(body.viewTransform) : null,
    look: advancedMode ? normalizeOptionalName(body.look) : null,
    exposure: advancedMode ? clampNumber(body.exposure, -10, 10, 0) : 0,
    gamma: advancedMode ? clampNumber(body.gamma, 0.01, 5, 1) : 1,
    maxBounces: advancedMode ? clampInteger(body.maxBounces, 0, 128, 12) : 12,
    diffuseBounces: advancedMode ? clampInteger(body.diffuseBounces, 0, 128, 4) : 4,
    glossyBounces: advancedMode ? clampInteger(body.glossyBounces, 0, 128, 4) : 4,
    transmissionBounces: advancedMode ? clampInteger(body.transmissionBounces, 0, 128, 12) : 12,
    transparentBounces: advancedMode ? clampInteger(body.transparentBounces, 0, 128, 8) : 8,
    causticsReflective: advancedMode ? normalizeBoolean(body.causticsReflective, true) : true,
    causticsRefractive: advancedMode ? normalizeBoolean(body.causticsRefractive, true) : true,
    useSimplify: advancedMode ? normalizeBoolean(body.useSimplify, false) : false,
    simplifySubdivisions: advancedMode ? clampInteger(body.simplifySubdivisions, 0, 12, 2) : 2,
    simplifyTextureLimit,
  };
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
    frameStep: normalizedSettings.frameStep,
    outputFormat,
    resolutionPct: normalizedSettings.resolutionPct,
    denoiser,
    noiseThreshold: normalizedSettings.noiseThreshold,
    camera: normalizedSettings.camera,
    scene: normalizedSettings.scene,
    advancedMode: normalizedSettings.advancedMode,
    gpuDeviceType: normalizedSettings.gpuDeviceType,
    allowCpuFallback: normalizedSettings.allowCpuFallback,
    transparentFilm: normalizedSettings.transparentFilm,
    usePersistentData: normalizedSettings.usePersistentData,
    viewTransform: normalizedSettings.viewTransform,
    look: normalizedSettings.look,
    exposure: normalizedSettings.exposure,
    gamma: normalizedSettings.gamma,
    maxBounces: normalizedSettings.maxBounces,
    diffuseBounces: normalizedSettings.diffuseBounces,
    glossyBounces: normalizedSettings.glossyBounces,
    transmissionBounces: normalizedSettings.transmissionBounces,
    transparentBounces: normalizedSettings.transparentBounces,
    causticsReflective: normalizedSettings.causticsReflective,
    causticsRefractive: normalizedSettings.causticsRefractive,
    useSimplify: normalizedSettings.useSimplify,
    simplifySubdivisions: normalizedSettings.simplifySubdivisions,
    simplifyTextureLimit: normalizedSettings.simplifyTextureLimit,
    output_format: outputFormat,
    resolution_pct: normalizedSettings.resolutionPct,
    noise_threshold: normalizedSettings.noiseThreshold,
    frame_step: normalizedSettings.frameStep,
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

  if (
    lowerMessage.includes('blender stopped')
    || lowerMessage.includes('blender crashed')
    || lowerMessage.includes('exit code')
    || lowerMessage.includes('signal')
  ) {
    return 'Blender stopped unexpectedly while rendering this scene. Try lowering samples, resolution, or texture sizes before submitting again.';
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
    estimatedCostUsd: job.estimatedCostUsd ? Number(job.estimatedCostUsd) : null,
    maxBudgetUsd: job.maxBudgetUsd ? Number(job.maxBudgetUsd) : null,
    billingState: job.billingState || 'UNBILLED',
    downloadUrl: renderedFileDownloadPath(job.jobId),
  };
}

function reservedAmount(job) {
  return roundMoney(Number(job?.reservedCreditsUsd || 0));
}

function unreleasedReservationAmount(job) {
  if (job?.reservationReleasedAt) return 0;
  return reservedAmount(job);
}

function reservationReferenceId(job) {
  const metadata = job?.billingMetadata && typeof job.billingMetadata === 'object' ? job.billingMetadata : {};
  return metadata.reservationReferenceId || job?.jobId;
}

export async function releaseJobReservation({
  client = prisma,
  job,
  reason,
  status = job?.status,
  amountUsd = unreleasedReservationAmount(job),
  extraMetadata = {},
}) {
  const releaseAmount = roundMoney(amountUsd);
  if (!job || releaseAmount <= 0 || job.reservationReleasedAt) return null;

  const persistedJobId = typeof job.jobId === 'string' && !job.jobId.startsWith('pending:') ? job.jobId : null;

  await releaseRenderReservation({
    client,
    userId: job.userId,
    referenceId: reservationReferenceId(job),
    jobId: persistedJobId,
    amountUsd: releaseAmount,
    metadata: {
      reason,
      status,
      reservedCreditsUsd: reservedAmount(job),
      ...extraMetadata,
    },
  });

  if (!persistedJobId) return null;

  return client.job.updateMany({
    where: { jobId: persistedJobId, userId: job.userId, reservationReleasedAt: null },
    data: {
      reservationReleasedAt: new Date(),
      billingState: reason === 'completed' ? 'SETTLED' : 'RELEASED',
      billingMetadata: {
        ...(job.billingMetadata && typeof job.billingMetadata === 'object' ? job.billingMetadata : {}),
        reservationReleaseReason: reason,
        reservationReleaseAmountUsd: releaseAmount,
        reservationReleasedAt: new Date().toISOString(),
      },
    },
  });
}

export function providerJobIdForJob(job) {
  return job?.providerJobId || (job?.dispatchStatus === 'DISPATCHED' ? job?.jobId : null) || null;
}

export function jobIsProviderDispatched(job) {
  return Boolean(providerJobIdForJob(job) && job?.dispatchStatus === 'DISPATCHED');
}

export async function persistRunpodStatus(userId, jobId, rpData) {
  const status = rpData.status || 'UNKNOWN';
  const resultKey = getRunpodResultKey(rpData);
  const progress = extractProgressFromRunpodData(rpData);

  const job = await prisma.job.findUnique({ where: { jobId }, include: { project: true } });
  if (!job || job.userId !== userId) return null;

  const updateData = { status, lastCheckedAt: new Date() };
  if (job.dispatchStatus !== 'DISPATCHED' && job.providerJobId) updateData.dispatchStatus = 'DISPATCHED';
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
      const uncappedPriceUsd = roundMoney(billableSeconds * config.renderPricePerSecondUsd);
      const maxBudgetUsd = roundMoney(Number(job.maxBudgetUsd || config.maxRenderBudgetUsd));
      const priceUsd = roundMoney(Math.min(uncappedPriceUsd, maxBudgetUsd));
      const reservationAmount = unreleasedReservationAmount(job);
      const releaseAmount = reservationAmount;
      const billingMetadata = {
        ...(job.billingMetadata && typeof job.billingMetadata === 'object' ? job.billingMetadata : {}),
        uncappedPriceUsd,
        maxBudgetUsd,
        reservationAmountUsd: reservationAmount,
        chargedUsd: priceUsd,
        releasedUsd: releaseAmount,
      };
      const billedJob = await tx.job.updateMany({
        where: { jobId, userId, billedAt: null },
        data: {
          ...updateData,
          billableSeconds,
          priceUsd,
          pricePerSecondUsd: config.renderPricePerSecondUsd,
          billedAt: new Date(),
          billingState: 'SETTLING',
          billingMetadata,
        },
      });

      if (billedJob.count > 0) {
        const currentJob = { ...job, billingMetadata };
        if (releaseAmount > 0) {
          await releaseJobReservation({
            client: tx,
            job: currentJob,
            reason: 'completed',
            status,
            amountUsd: releaseAmount,
            extraMetadata: { chargedUsd: priceUsd, uncappedPriceUsd, maxBudgetUsd },
          });
        }

        if (priceUsd > 0) {
          await chargeRenderCredits({
            client: tx,
            userId,
            jobId,
            amountUsd: priceUsd,
            billableSeconds,
            pricePerSecondUsd: config.renderPricePerSecondUsd,
            metadata: { status, resultKey: updateData.resultKey, uncappedPriceUsd, maxBudgetUsd, reservationReleasedUsd: releaseAmount },
          });
        }

        await tx.job.updateMany({ where: { jobId, userId }, data: { billingState: 'SETTLED', billingMetadata } });
      }
    } else if ((status === 'FAILED' || status === 'CANCELLED') && !job.reservationReleasedAt) {
      await tx.job.updateMany({ where: { jobId, userId }, data: { ...updateData, billingState: 'RELEASING' } });
      await releaseJobReservation({
        client: tx,
        job,
        reason: status.toLowerCase(),
        status,
        extraMetadata: { error: updateData.error || null },
      });
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
      if (!jobIsProviderDispatched(job)) return;
      const rpData = await fetchRunpodJobStatus(providerJobIdForJob(job));
      const updatedJob = await persistRunpodStatus(userId, job.jobId, rpData);
      if (updatedJob && emitJobUpdate) emitJobUpdate(updatedJob, rpData);
    } catch (error) {
      console.error(`Could not sync render job ${job.jobId}:`, error);
    }
  }));
}
