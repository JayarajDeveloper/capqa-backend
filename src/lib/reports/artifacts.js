/**
 * Archive Playwright test-results (video / screenshot / trace) into report storage.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '../../..');
export const STORAGE_ROOT = path.join(BACKEND_ROOT, 'storage', 'reports');
export const TEST_RESULTS_DIR = path.join(BACKEND_ROOT, 'generated-e2e', 'test-results');

const MIME = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.log': 'text/plain',
};

function artifactType(fileName) {
  const lower = fileName.toLowerCase();
  if (/\.(webm|mp4)$/.test(lower) || lower.includes('video')) return 'video';
  if (/\.(png|jpe?g)$/.test(lower) || lower.includes('screenshot')) return 'screenshot';
  if (/\.zip$/.test(lower) || lower.includes('trace')) return 'trace';
  return 'log';
}

async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/**
 * Copy recent Playwright artifacts into storage/reports/{projectId}/{runId}/
 * @returns {Promise<Array<{ type, fileName, mimeType, relativePath, sizeBytes }>>}
 */
export async function archivePlaywrightArtifacts({
  projectId,
  runId,
  sinceMs = Date.now() - 15 * 60 * 1000,
  resultsDir = TEST_RESULTS_DIR,
}) {
  const destDir = path.join(STORAGE_ROOT, projectId, runId);
  await fs.mkdir(destDir, { recursive: true });

  const files = await walkFiles(resultsDir);
  const picked = [];
  for (const full of files) {
    const base = path.basename(full);
    if (!/\.(webm|mp4|png|jpe?g|zip)$/i.test(base)) continue;
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < sinceMs) continue;
      const safe = `${picked.length + 1}-${base}`.replace(/[^\w.\-]+/g, '_');
      const dest = path.join(destDir, safe);
      await fs.copyFile(full, dest);
      const rel = path.relative(STORAGE_ROOT, dest).split(path.sep).join('/');
      const ext = path.extname(base).toLowerCase();
      picked.push({
        type: artifactType(base),
        fileName: safe,
        mimeType: MIME[ext] || 'application/octet-stream',
        relativePath: rel,
        sizeBytes: st.size,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return picked;
}

/** Absolute path for a stored artifact (must stay under STORAGE_ROOT). */
export function resolveArtifactAbs(relativePath) {
  const abs = path.resolve(STORAGE_ROOT, relativePath);
  if (!abs.startsWith(STORAGE_ROOT)) throw new Error('Invalid artifact path');
  return abs;
}

export async function writeTextArtifact({ projectId, runId, fileName, content, type = 'log' }) {
  const destDir = path.join(STORAGE_ROOT, projectId, runId);
  await fs.mkdir(destDir, { recursive: true });
  const safe = String(fileName || 'run.log').replace(/[^\w.\-]+/g, '_');
  const dest = path.join(destDir, safe);
  const body = String(content || '');
  await fs.writeFile(dest, body, 'utf8');
  const rel = path.relative(STORAGE_ROOT, dest).split(path.sep).join('/');
  return {
    type,
    fileName: safe,
    mimeType: 'text/plain',
    relativePath: rel,
    sizeBytes: Buffer.byteLength(body),
  };
}
