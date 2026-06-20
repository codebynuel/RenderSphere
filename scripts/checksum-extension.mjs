import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const artifactPaths = [
  path.join(process.cwd(), 'public', 'downloads', 'rendersphere-blender-addon.zip'),
  path.join(process.cwd(), 'frontend', 'public', 'downloads', 'rendersphere-blender-addon.zip'),
];

const verify = process.argv.includes('--verify');

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function readExpected(checksumPath) {
  const checksumText = await readFile(checksumPath, 'utf8');
  const [hash] = checksumText.trim().split(/\s+/);
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid SHA-256 checksum format in ${checksumPath}.`);
  }
  return hash.toLowerCase();
}

const hashes = [];

for (const artifactPath of artifactPaths) {
  const checksumPath = `${artifactPath}.sha256`;
  const hash = await sha256(artifactPath);
  hashes.push({ artifactPath, hash });
  const checksumContents = `${hash}  ${path.basename(artifactPath)}\n`;

  if (verify) {
    const expected = await readExpected(checksumPath);
    if (expected !== hash) {
      throw new Error(`Checksum mismatch for ${artifactPath}. Expected ${expected}, got ${hash}.`);
    }
    console.log(`Verified ${checksumPath}`);
  } else {
    await writeFile(checksumPath, checksumContents, 'utf8');
    console.log(`Wrote ${checksumPath}`);
  }
}

const uniqueHashes = new Set(hashes.map((item) => item.hash));
if (uniqueHashes.size !== 1) {
  throw new Error('Packaged extension artifacts differ between public download locations.');
}

console.log(`Extension artifact SHA-256: ${hashes[0].hash}`);
