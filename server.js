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

app.listen(3000, () => console.log('Gateway running on port 3000 🚀'));