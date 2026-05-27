import path from 'path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3Client;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
}

export function containsTraversalOrAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).includes('..');
}

export function isSafeFileName(fileName) {
  return !containsTraversalOrAbsolutePath(fileName) && path.basename(fileName) === fileName;
}

export function isSafeObjectKey(key) {
  return !containsTraversalOrAbsolutePath(key);
}

export function contentTypeForKey(key) {
  const extension = path.extname(key || '').toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.exr') return 'image/aces';
  if (extension === '.zip') return 'application/zip';
  return 'application/octet-stream';
}

export function attachmentFileName(key) {
  return path.basename(key || 'render-output').replace(/[^a-zA-Z0-9._-]/g, '_') || 'render-output';
}

export async function createUploadUrl(key) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: 'application/octet-stream',
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

export async function getRenderedObject(resultKey) {
  const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: resultKey });
  return getS3Client().send(command);
}
