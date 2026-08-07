/**
 * Local filesystem live source for Compose.
 * When CAPQA_LOCAL_UI_ROOT / CAPQA_LOCAL_API_ROOT are set, read target trees from disk
 * instead of GitLab HTTP (same relative paths, same chunk shape).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { languageOf } from './chunk.js';
import { layerOf } from './retrieve.js';
import {
  featureSlugFromName,
  isFeatureFormHtmlPath,
  resolvedFeatureFolder,
  primaryFeatureFolder,
} from './codeSignals.js';

const MAX_FILE_CHARS = 12_000;
const MAX_COMPONENT_CHARS = Number(process.env.GITLAB_LIVE_COMPONENT_CHARS || 400_000);
const MAX_AUTO_FE = 8;
const MAX_AUTO_BE = 10;
const MAX_PATHS = 14;

export function getLocalRoots() {
  const ui = String(process.env.CAPQA_LOCAL_UI_ROOT || '').trim().replace(/\/+$/, '');
  const api = String(process.env.CAPQA_LOCAL_API_ROOT || '').trim().replace(/\/+$/, '');
  return { ui, api };
}

export function isLocalSourceConfigured() {
  const { ui, api } = getLocalRoots();
  return Boolean(ui || api);
}

function maxCharsForPath(filePath) {
  const p = String(filePath || '');
  if (/\.component\.(html|ts)$/i.test(p) && !/\.spec\./i.test(p)) return MAX_COMPONENT_CHARS;
  if (/\/pages\/.+\.(html|ts)$/i.test(p) && !/\.spec\./i.test(p)) return MAX_COMPONENT_CHARS;
  return MAX_FILE_CHARS;
}

function truncate(text, max = MAX_FILE_CHARS) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n/* … truncated (${s.length} chars) */\n`;
}

function preferPath(a, b) {
  const rank = (p) => {
    if (/-details\.component\.html$/i.test(p)) return 0;
    if (/-details\.component\.ts$/i.test(p) && !/\.spec\./i.test(p)) return 1;
    if (/\.component\.html$/i.test(p) && !/list/i.test(p)) return 2;
    if (/\.component\.ts$/i.test(p) && !/\.spec\./i.test(p) && !/list/i.test(p)) return 3;
    if (/Controller\.(php|ts)$/i.test(p)) return 4;
    if (/Service\.(php|ts)$/i.test(p) && !/\.spec\./i.test(p)) return 5;
    if (/Entity\//i.test(p) || /Entities\//i.test(p)) return 6;
    if (/Repository\.(php|ts)$/i.test(p)) return 7;
    if (/Dto|DTO/i.test(p)) return 8;
    if (/\.component\.html$/i.test(p)) return 9;
    return 10;
  };
  return rank(a) - rank(b) || a.length - b.length;
}

function rankListHtmlPath(pathStr, folder = '') {
  const p = String(pathStr || '');
  const base = p.split('/').pop() || '';
  const stem = String(folder || '').replace(/ies$/i, 'y').replace(/s$/i, '') || '';
  let rank = 5;
  if (/-list\.component\.html$/i.test(p)) rank = 0;
  if (stem && new RegExp(`^${stem}-list\\.component\\.html$`, 'i').test(base)) rank -= 2;
  if (/-details\.component\.html$/i.test(p)) rank = Math.min(rank, 1);
  if (/\.component\.html$/i.test(p) && !/-list\./i.test(p)) rank = Math.min(rank, 2);
  return rank;
}

function scorePath(filePath, keywords) {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 2;
    if (new RegExp(`/${kw}(?:/|\\.|-|_|$)`).test(lower)) score += 3;
  }
  return score;
}

function keywordsFrom(query, featureName) {
  const subject = String(featureName || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'test', 'case', 'create', 'update',
    'delete', 'list', 'page', 'screen', 'how', 'does', 'work', 'named', 'called', 'using',
    'code', 'name', 'symbol', 'numeric', 'email', 'phone', 'type', 'status', 'value',
  ]);
  const fromAsk = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stop.has(t));
  return [...new Set([...subject, ...fromAsk])].slice(0, 8);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootAbs, { maxDepth = 8 } = {}) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || out.length > 2000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'vendor') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs, depth + 1);
      else if (ent.isFile()) out.push(abs);
    }
  }
  await walk(rootAbs, 0);
  return out;
}

/** Map absolute file under root → repo-relative POSIX path (same as GitLab). */
function toRelPath(rootAbs, absFile) {
  return path.relative(rootAbs, absFile).split(path.sep).join('/');
}

async function readLocalFile(rootAbs, relPath) {
  const abs = path.join(rootAbs, ...relPath.split('/'));
  const raw = await fs.readFile(abs, 'utf8');
  return truncate(raw, maxCharsForPath(relPath));
}

function makeChunk({ rootLabel, relPath, content, score = 3 }) {
  const lines = content.split('\n');
  return {
    id: `live_local_${rootLabel}_${relPath}`,
    path: relPath,
    startLine: 1,
    endLine: lines.length,
    language: languageOf(relPath),
    content,
    repoId: `local:${rootLabel}`,
    repoName: rootLabel,
    score,
    method: 'live-local',
    layer: layerOf(relPath),
    branch: 'local',
  };
}

/** List `src/app/pages/*` folder names under the UI root. */
export async function listLocalPageFolders(uiRoot = getLocalRoots().ui) {
  if (!uiRoot) return [];
  const candidates = [
    path.join(uiRoot, 'src', 'app', 'pages'),
    path.join(uiRoot, 'app', 'pages'),
  ];
  for (const dir of candidates) {
    try {
      const ents = await fs.readdir(dir, { withFileTypes: true });
      return ents.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* try next */ }
  }
  return [];
}

export async function resolveLocalPagesFolder(featureName = '', hintFolder = '') {
  const folders = await listLocalPageFolders();
  if (!folders.length) return hintFolder || featureSlugFromName(featureName) || '';

  const slug = featureSlugFromName(featureName);
  const raw = [hintFolder, slug, slug ? `${slug}s` : '', slug?.replace(/s$/, '')]
    .map((s) => String(s || '').toLowerCase())
    .filter(Boolean);
  for (const c of [...new Set(raw)]) {
    if (folders.includes(c)) return c;
  }

  const key = String(featureName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key) {
    const hit = folders.find((f) => {
      const nk = String(f).toLowerCase().replace(/[^a-z0-9]+/g, '');
      return nk === key || nk.includes(key) || key.includes(nk);
    });
    if (hit) return hit;
  }
  return hintFolder || slug || '';
}

async function discoverUiRels(uiRoot, folder) {
  if (!uiRoot || !folder) return [];
  const roots = [
    path.join(uiRoot, 'src', 'app', 'pages', folder),
    path.join(uiRoot, 'app', 'pages', folder),
  ];
  for (const absRoot of roots) {
    if (!(await pathExists(absRoot))) continue;
    const files = await walkFiles(absRoot, { maxDepth: 6 });
    const rels = files
      .map((abs) => toRelPath(uiRoot, abs))
      .filter((p) => /\.component\.(html|ts)$/i.test(p) && !/\.spec\./i.test(p));
    return rels.sort(
      (a, b) => rankListHtmlPath(a, folder) - rankListHtmlPath(b, folder) || preferPath(a, b),
    );
  }
  return [];
}

async function discoverBeRels(apiRoot, keywords = []) {
  if (!apiRoot) return [];
  const searchRoots = [
    path.join(apiRoot, 'src', 'Features'),
    path.join(apiRoot, 'src', 'Entity'),
    path.join(apiRoot, 'src', 'Entities'),
    path.join(apiRoot, 'src', 'Repository'),
    path.join(apiRoot, 'src', 'Repositories'),
    path.join(apiRoot, 'src', 'Controller'),
    path.join(apiRoot, 'src', 'Service'),
  ];
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const scored = [];

  for (const absRoot of searchRoots) {
    if (!(await pathExists(absRoot))) continue;
    const files = await walkFiles(absRoot, { maxDepth: 7 });
    for (const abs of files) {
      const rel = toRelPath(apiRoot, abs);
      if (!/\.(php|ts|yml|yaml|xml)$/i.test(rel)) continue;
      if (/\.(spec|test)\./i.test(rel)) continue;
      let score = scorePath(rel, kws);
      if (/Controller\.(php|ts)$/i.test(rel)) score += 4;
      if (/Service\.(php|ts)$/i.test(rel)) score += 3;
      if (/Entity\//i.test(rel)) score += 3;
      if (/Repository/i.test(rel)) score += 2;
      if (score <= 0 && kws.length) continue;
      if (!kws.length) score = 1;
      scored.push({ path: rel, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || preferPath(a.path, b.path))
    .map((x) => x.path);
}

/**
 * Prefer local disk for compose live bodies when CAPQA_LOCAL_* roots are set.
 */
export async function hydrateChunksFromLocal({
  chunks = [],
  featureName = '',
  query = '',
  layers = [],
} = {}) {
  const roots = getLocalRoots();
  if (!roots.ui && !roots.api) {
    return {
      chunks,
      liveChunks: [],
      live: { ok: false, reason: 'local_not_configured', fetched: 0, discovered: 0, branch: null },
    };
  }

  for (const [label, root] of [['ui', roots.ui], ['api', roots.api]]) {
    if (root && !(await pathExists(root))) {
      return {
        chunks,
        liveChunks: [],
        live: {
          ok: false,
          reason: 'local_root_missing',
          detail: `${label} root not found: ${root}`,
          fetched: 0,
          discovered: 0,
          branch: 'local',
        },
      };
    }
  }

  const wantsUi = !layers?.length || layers.includes('ui');
  const wantsBe = !layers?.length || layers.includes('backend') || layers.includes('database');
  const keywords = keywordsFrom(query, featureName);
  const hintFolder = resolvedFeatureFolder(
    featureName,
    (chunks || []).map((c) => c.path),
  ) || primaryFeatureFolder(chunks, featureName);

  const folder = await resolveLocalPagesFolder(featureName, hintFolder);
  const liveChunks = [];
  const fetchedPaths = new Set();
  let fetched = 0;
  let discovered = 0;

  async function push(rootAbs, rootLabel, relPath, score = 3) {
    if (!rootAbs || !relPath || fetchedPaths.has(relPath)) return false;
    try {
      const content = await readLocalFile(rootAbs, relPath);
      if (!content.trim()) return false;
      liveChunks.push(makeChunk({ rootLabel, relPath, content, score }));
      fetchedPaths.add(relPath);
      fetched += 1;
      return true;
    } catch (e) {
      console.warn(`[live-local] read ${relPath} failed:`, e.message);
      return false;
    }
  }

  // 1) UI feature folder
  if (wantsUi && roots.ui && folder) {
    const uiRels = await discoverUiRels(roots.ui, folder);
    let uiCount = 0;
    for (const rel of uiRels) {
      if (/\.(scss|css)$/i.test(rel)) continue;
      const ok = await push(roots.ui, 'local-ui', rel, isFeatureFormHtmlPath(rel) ? 5 : 4);
      if (ok) {
        discovered += 1;
        uiCount += 1;
      }
      if (uiCount >= MAX_AUTO_FE + 4) break;
    }
  }

  // 2) Seed paths from index / prior chunks
  const seedPaths = [...new Set(
    (chunks || [])
      .filter((c) => !layers?.length || layers.includes(layerOf(c.path)))
      .map((c) => c.path),
  )].sort(preferPath);

  for (const rel of seedPaths) {
    if (fetchedPaths.size >= MAX_PATHS) break;
    if (fetchedPaths.has(rel)) continue;
    const layer = layerOf(rel);
    if (layer === 'ui' && roots.ui) await push(roots.ui, 'local-ui', rel, 3);
    else if (layer !== 'ui' && roots.api) await push(roots.api, 'local-api', rel, 3);
  }

  // 3) Backend / database by keywords
  if (wantsBe && roots.api && keywords.length) {
    const beRels = await discoverBeRels(roots.api, keywords);
    let beCount = 0;
    for (const rel of beRels) {
      if (fetchedPaths.has(rel)) continue;
      const layer = layerOf(rel);
      if (layers?.length && !layers.includes(layer) && layer !== 'database' && layer !== 'backend') continue;
      if (layers?.length && layers.includes('database') && !layers.includes('backend') && layer === 'backend') continue;
      const ok = await push(roots.api, 'local-api', rel, 3);
      if (ok) {
        discovered += 1;
        beCount += 1;
      }
      if (beCount >= MAX_AUTO_BE) break;
    }
  }

  const keptIndexed = (chunks || []).filter((c) => !fetchedPaths.has(c.path));
  const merged = liveChunks.length
    ? [...liveChunks, ...keptIndexed].slice(0, 36)
    : chunks;

  const branch = [
    roots.ui && `ui:${roots.ui}`,
    roots.api && `api:${roots.api}`,
  ].filter(Boolean).join(', ');

  return {
    chunks: merged,
    liveChunks,
    live: {
      ok: fetched > 0,
      reason: fetched ? null : 'nothing_fetched',
      fetched,
      discovered,
      failed: 0,
      branch,
      source: 'local',
      paths: [...fetchedPaths].slice(0, 16),
      folder: folder || null,
    },
  };
}

/** Force-load list + form templates from local UI tree (compose readiness). */
export async function supplementLiveUiFromLocal({
  featureName = '',
  liveChunks = [],
  fetchedPaths = new Set(),
  seedChunks = [],
} = {}) {
  const { ui } = getLocalRoots();
  if (!ui) return { liveChunks, added: [] };

  const folder = await resolveLocalPagesFolder(
    featureName,
    resolvedFeatureFolder(
      featureName,
      [...(seedChunks || []).map((c) => c.path), ...(liveChunks || []).map((c) => c.path)],
    ),
  );
  if (!folder) return { liveChunks, added: [] };

  const rels = await discoverUiRels(ui, folder);
  const ordered = [...rels].sort(
    (a, b) => rankListHtmlPath(a, folder) - rankListHtmlPath(b, folder) || preferPath(a, b),
  );

  const added = [];
  const out = [...liveChunks];
  const seen = new Set(fetchedPaths);

  for (const rel of ordered.slice(0, 12)) {
    if (seen.has(rel)) continue;
    try {
      const content = await readLocalFile(ui, rel);
      if (!content.trim()) continue;
      if (!/data-testid\s*=|testId\s*=/i.test(content) && !/\.component\.ts$/i.test(rel)) continue;
      const chunk = makeChunk({ rootLabel: 'local-ui', relPath: rel, content, score: 5 });
      out.push(chunk);
      added.push(chunk);
      seen.add(rel);
    } catch (e) {
      console.warn(`[live-local] supplement ${rel} failed:`, e.message);
    }
  }

  return { liveChunks: out, added };
}
