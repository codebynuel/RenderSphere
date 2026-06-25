/**
 * Clean frontend rebuild — fixes blank page issues after partial builds.
 *
 * The problem: Vite's `emptyOutDir: true` deletes root `public/` on each build.
 * If the build is interrupted or cached assets are stale, the server serves
 * an `index.html` that references missing JS/CSS bundles, resulting in a
 * blank page.
 *
 * This script:
 *   1. Preserves `public/downloads/` (blender addon files)
 *   2. Wipes `public/` completely
 *   3. Reinstalls frontend deps (fresh node_modules)
 *   4. Rebuilds from scratch
 *   5. Restores `downloads/`
 *   6. Verifies the built JS/CSS bundles actually exist
 *
 * Usage: node scripts/rebuild-frontend.mjs
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const downloadsDir = join(publicDir, 'downloads');
const tmpDir = join(root, '.rebuild-tmp');

let exitCode = 0;

function run(label, cmd, cwd = root) {
  console.log(`\n  ▶ ${label}`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit', timeout: 120_000 });
  } catch (err) {
    console.error(`  ✖ ${label} failed`);
    exitCode = 1;
    process.exit(exitCode);
  }
}

function rm(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function cp(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

console.log('');
console.log('═══════════════════════════════════════');
console.log('  Clean frontend rebuild');
console.log('═══════════════════════════════════════');

// 1. Preserve downloads/
console.log('\n  ▶ Preserving downloads/');
if (existsSync(downloadsDir)) {
  rm(tmpDir);
  mkdirSync(tmpDir, { recursive: true });
  cp(downloadsDir, join(tmpDir, 'downloads'));
  console.log('   → saved to .rebuild-tmp/downloads/');
}

// 2. Wipe public/
console.log('\n  ▶ Wiping public/ build output');
rm(publicDir);
mkdirSync(publicDir, { recursive: true });
console.log('   → public/ emptied');

// 3. Reinstall deps
run('Installing frontend dependencies', 'npm run frontend:install');

// 4. Build frontend
run('Building frontend', 'npm run frontend:build');

// 5. Restore downloads/
console.log('\n  ▶ Restoring downloads/');
if (existsSync(join(tmpDir, 'downloads'))) {
  rm(downloadsDir);
  cp(join(tmpDir, 'downloads'), downloadsDir);
  rm(tmpDir);
  console.log('   → downloads/ restored');
}

// 6. Verify
console.log('\n  ▶ Verifying build output');
const indexPath = join(publicDir, 'index.html');
if (!existsSync(indexPath)) {
  console.error('   ✖ public/index.html not found — build may have failed');
  exitCode = 1;
} else {
  const html = readFileSync(indexPath, 'utf-8');
  const scriptSrc = html.match(/src="\/(assets\/[^"]+\.js)"/)?.[1];
  const cssHref = html.match(/href="\/(assets\/[^"]+\.css)"/)?.[1];
  const jsExists = scriptSrc && existsSync(join(publicDir, scriptSrc));
  const cssExists = cssHref && existsSync(join(publicDir, cssHref));

  if (jsExists) {
    const size = (readFileSync(join(publicDir, scriptSrc)).length / 1024).toFixed(1);
    console.log(`   ✓ JS:  /${scriptSrc} (${size} KB)`);
  } else {
    console.error(`   ✖ JS bundle missing: ${scriptSrc || '(not found in index.html)'}`);
    exitCode = 1;
  }

  if (cssExists) {
    const size = (readFileSync(join(publicDir, cssHref)).length / 1024).toFixed(1);
    console.log(`   ✓ CSS: /${cssHref} (${size} KB)`);
  } else {
    console.error(`   ✖ CSS bundle missing: ${cssHref || '(not found in index.html)'}`);
    exitCode = 1;
  }

  // Count built files
  let fileCount = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else fileCount++;
    }
  }
  walk(publicDir);
  console.log(`   → ${fileCount} files in public/`);
}

console.log('\n───────────────────────────────────────────');
if (exitCode === 0) {
  console.log('  ✓ Rebuild complete — restart the server to pick up changes');
} else {
  console.log('  ✖ Rebuild had errors — check output above');
}
console.log('───────────────────────────────────────────\n');
process.exit(exitCode);
