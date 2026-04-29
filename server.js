import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();
app.use(express.json());

const VALID_ENGINES = new Set(['CYCLES', 'BLENDER_EEVEE_NEXT']);
const VALID_OUTPUT_FORMATS = new Set(['PNG', 'JPEG', 'OPEN_EXR', 'OPEN_EXR_MULTILAYER']);
const VALID_DENOISERS = new Set(['NONE', 'OPTIX', 'OPENIMAGEDENOISE']);

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function containsTraversalOrAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).includes('..');
}

function isSafeFileName(fileName) {
  return !containsTraversalOrAbsolutePath(fileName) && path.basename(fileName) === fileName;
}

function isSafeObjectKey(key) {
  return !containsTraversalOrAbsolutePath(key);
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

// Initialize the S3 Client pointing to your Cloudflare R2 endpoint
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.get('/api/job-status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/status/${jobId}`;

  try {
    const rpRes = await fetch(runpodUrl, {
      headers: { 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` }
    });
    const rpData = await readResponseJson(rpRes);

    if (rpData.status === 'COMPLETED') {
      const resultKey = rpData.output.result_key;
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: resultKey,
      });
      const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      res.json({ status: 'COMPLETED', downloadUrl });
    } else if (rpData.status === 'FAILED') {
      res.json({ status: 'FAILED', error: rpData.error });
    } else {
      res.json({
        status: rpData.status,
        stream: rpData.stream || []
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to check status" });
  }
});

app.post('/api/get-upload-url', async (req, res) => {
  const { fileName } = req.body;

  if (!isSafeFileName(fileName)) {
    return res.status(400).json({ error: "Invalid fileName" });
  }

  const key = `renders/${Date.now()}-${fileName}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: 'application/octet-stream',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    res.json({ uploadUrl, key });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate R2 pre-signed URL" });
  }
});

app.post('/api/trigger-render', async (req, res) => {
  const {
    fileKey,
    engine,
    isAnimation,
    startFrame,
    endFrame,
    outputFormat = 'PNG',
    denoiser = 'NONE',
  } = req.body;

  if (!isSafeObjectKey(fileKey)) {
    return res.status(400).json({ error: "Invalid fileKey" });
  }

  if (!VALID_ENGINES.has(engine)) {
    return res.status(400).json({ error: "Invalid engine" });
  }

  if (!VALID_OUTPUT_FORMATS.has(outputFormat)) {
    return res.status(400).json({ error: "Invalid outputFormat" });
  }

  if (!VALID_DENOISERS.has(denoiser)) {
    return res.status(400).json({ error: "Invalid denoiser" });
  }

  const samples = Math.round(clampNumber(req.body.samples, 1, 8192, 256));
  const resolutionPct = Math.round(clampNumber(req.body.resolutionPct, 1, 200, 100));
  const noiseThreshold = clampNumber(req.body.noiseThreshold, 0, 1, 0.01);

  const runpodPayload = {
    input: {
      fileKey,
      engine,
      samples,
      isAnimation,
      startFrame,
      endFrame,
      outputFormat,
      resolutionPct,
      denoiser,
      noiseThreshold,
      output_format: outputFormat,
      resolution_pct: resolutionPct,
      noise_threshold: noiseThreshold,
    }
  };

  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`;

  try {
    const response = await fetch(runpodUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`
      },
      body: JSON.stringify(runpodPayload)
    });

    const data = await readResponseJson(response);

    if (response.ok) {
      console.log(`Render Job Dispatched. Job ID: ${data.id}`);
      res.json({ success: true, jobId: data.id, status: data.status });
    } else {
      console.error("RunPod Error:", data);
      res.status(400).json({ error: "Failed to trigger RunPod" });
    }
  } catch (error) {
    console.error("Gateway Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/api/cancel-job', async (req, res) => {
  const { jobId } = req.body;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return res.status(400).json({ error: "Invalid jobId" });
  }

  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/cancel/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(runpodUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` }
    });
    const data = await readResponseJson(response);

    res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      runpod: data,
    });
  } catch (error) {
    console.error("Cancel Error:", error);
    res.status(500).json({ success: false, error: "Failed to cancel RunPod job" });
  }
});

app.listen(3000, () => console.log('Gateway running on port 3000'));
