import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();
app.use(express.json());

// Initialize the S3 Client pointing to your Cloudflare R2 endpoint
const s3Client = new S3Client({
  region: "auto", // R2 requires 'auto'
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.post('/api/get-upload-url', async (req, res) => {
  const { fileName } = req.body;
  
  // Generate a unique key so concurrent renders don't overwrite each other
  const key = `renders/${Date.now()}-${fileName}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: 'application/octet-stream', 
    });

    // Generate a URL that expires in 1 hour
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    
    // Return both the URL to upload to, and the final key we'll need for RunPod
    res.json({ uploadUrl, key });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate R2 pre-signed URL" });
  }
});

app.post('/api/trigger-render', async (req, res) => {
  const { fileKey } = req.body;
  
  // The RunPod Serverless execution URL
  const runpodUrl = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`;

  try {
    const response = await fetch(runpodUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`
      },
      // We pass the fileKey inside the 'input' object, which matches 
      // exactly what our handler.py script is looking for!
      body: JSON.stringify({
        input: { file_key: fileKey }
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log(`🚀 Render Job Dispatched! Job ID: ${data.id}`);
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

app.listen(3000, () => console.log('Gateway running on port 3000 🚀'));