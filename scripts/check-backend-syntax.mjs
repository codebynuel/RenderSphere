import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const roots = ['server.js', 'helpers', 'routes', 'scripts', 'src'];
const ignoredDirectories = new Set(['node_modules', '.git', 'public', 'frontend', '.data-dev']);
const extensions = new Set(['.js', '.mjs']);

async function collectJavaScriptFiles(targetPath, files = []) {
  const absolutePath = path.resolve(process.cwd(), targetPath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOTDIR') {
      if (extensions.has(path.extname(targetPath))) files.push(targetPath);
      return [];
    }
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  for (const entry of entries) {
    const relativePath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await collectJavaScriptFiles(relativePath, files);
      }
      continue;
    }

    if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files;
}

function checkSyntax(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', filePath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => {
      resolve({ filePath, ok: false, output: error.message });
    });
    child.on('exit', (code) => {
      resolve({ filePath, ok: code === 0, output });
    });
  });
}

const files = [...new Set((await Promise.all(roots.map((root) => collectJavaScriptFiles(root)))).flat())]
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.warn('No backend JavaScript files were found for syntax validation.');
  process.exit(1);
}

const results = await Promise.all(files.map((filePath) => checkSyntax(filePath)));
const failures = results.filter((result) => !result.ok);

for (const failure of failures) {
  console.error(`Syntax check failed for ${failure.filePath}`);
  if (failure.output) console.error(failure.output.trim());
}

if (failures.length > 0) {
  console.error(`Backend syntax validation failed for ${failures.length} file(s).`);
  process.exit(1);
}

console.log(`Backend syntax validation passed for ${files.length} file(s).`);
