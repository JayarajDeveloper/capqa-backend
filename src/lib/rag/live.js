// CapVision-style live GitLab reads for Compose.
// Index still finds the feature; this re-fetches current branch file bodies over HTTP.

import { prisma } from '../../db.js';
import { decrypt } from '../crypto.js';
import * as GL from '../scm/gitlab.js';
import { languageOf } from './chunk.js';
import { layerOf } from './retrieve.js';
import { featureFromPath } from './ground.js';
import { featureFolderFromPath, hasFeatureDetailChunk, isDetailChunkPath, isFeatureFormHtmlPath, primaryFeatureFolder, featureSlugFromName, resolvedFeatureFolder } from './codeSignals.js';

function featureSlugFromNameSafe(name) {
  return featureSlugFromName(name) || '';
}

const MAX_FILE_CHARS = 12_000;
/** Component HTML/TS hold FormGroup + testIds far past 12k (partners ~70k HTML). */
const MAX_COMPONENT_CHARS = Number(process.env.GITLAB_LIVE_COMPONENT_CHARS || 400_000);
const MAX_PATHS_REFRESH = 14;
const MAX_AUTO_FE = 8;
/** Backend + Entity/Repository live files for full module logic */
const MAX_AUTO_BE = 10;
/** Cap total live-hydrate wall time so compose does not hang when GitLab is unreachable. */
const HYDRATE_BUDGET_MS = Number(process.env.GITLAB_HYDRATE_BUDGET_MS || 45000);
/** Per-file timeout for live compose (indexing still uses GITLAB_HTTP_TIMEOUT_MS). */
const LIVE_FILE_TIMEOUT_MS = Number(process.env.GITLAB_LIVE_FILE_TIMEOUT_MS || 5000);
/** Skip live GitLab entirely when set false — NOT allowed for UI compose (testIds/rules). */
const LIVE_ENABLED = process.env.GITLAB_LIVE_ENABLED !== 'false';
/** UI compose must use live GitLab bodies only (no truncated index junk). Default: on. */
export const REQUIRE_LIVE_FOR_UI = process.env.COMPOSE_REQUIRE_LIVE_GITLAB !== 'false';
const PING_TIMEOUT_MS = Number(process.env.GITLAB_PING_TIMEOUT_MS || 8000);
const PING_RETRIES = Number(process.env.GITLAB_PING_RETRIES || 3);

export function maxCharsForPath(filePath) {
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

function keywordsFrom(query, featureName) {
  const subject = String(featureName || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  // Prefer module name over field values in the ask (code EUR, numeric 978, …)
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'test', 'case', 'create', 'update',
    'delete', 'list', 'page', 'screen', 'how', 'does', 'work', 'named', 'called', 'using',
    'code', 'name', 'symbol', 'numeric', 'rounding', 'increment', 'rate', 'euro', 'eur',
    'email', 'phone', 'type', 'status', 'value', 'amount',
  ]);
  const fromAsk = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stop.has(t));
  return [...new Set([...subject, ...fromAsk])].slice(0, 8);
}

function scorePath(path, keywords) {
  const lower = path.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 2;
    if (new RegExp(`/${kw}(?:/|\\.|-|_|$)`).test(lower)) score += 3;
  }
  return score;
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

async function loadActiveGitlabRepos(projectId) {
  const repos = await prisma.repo.findMany({
    where: { projectId, active: true, provider: 'GITLAB' },
    include: { connector: true },
  });
  return repos
    .filter((r) => r.connector?.tokenCipher && r.connector?.baseUrl)
    .map((r) => ({
      id: r.id,
      name: r.name,
      branch: r.branch,
      baseUrl: r.connector.baseUrl,
      token: decrypt(r.connector.tokenCipher),
    }));
}

async function readLiveFile(repo, path) {
  const raw = await GL.fetchFileRaw(
    repo.baseUrl,
    repo.token,
    repo.name,
    path,
    repo.branch,
    LIVE_FILE_TIMEOUT_MS,
  );
  return truncate(raw, maxCharsForPath(path));
}

/**
 * Re-fetch known paths from GitLab (same branch as connector) and replace chunk bodies.
 * Falls back to indexed content per-file if GitLab fails.
 * If GitLab is unreachable, probes once then skips live (no 20s×N waits).
 */
export async function hydrateChunksFromGitLab({ projectId, chunks = [], featureName = '', query = '', layers = [] }) {
  if (!LIVE_ENABLED) {
    return {
      chunks,
      liveChunks: [],
      live: { ok: false, reason: 'live_disabled', fetched: 0, discovered: 0, branch: null },
    };
  }

  const repos = await loadActiveGitlabRepos(projectId);
  if (!repos.length) {
    return {
      chunks,
      liveChunks: [],
      live: { ok: false, reason: 'no_active_gitlab_repo', fetched: 0, discovered: 0, branch: null },
    };
  }

  // Fail-fast ping with retries — GitLab on VPN/internal TLS is often flaky for a single attempt
  const probeRepo = repos[0];
  let pingError = null;
  for (let attempt = 1; attempt <= PING_RETRIES; attempt++) {
    try {
      await GL.pingGitlab(probeRepo.baseUrl, probeRepo.token, PING_TIMEOUT_MS);
      pingError = null;
      break;
    } catch (e) {
      pingError = e;
      if (attempt < PING_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  if (pingError) {
    console.warn(`[live] GitLab unreachable after ${PING_RETRIES} pings (${pingError.message})`);
    return {
      chunks,
      liveChunks: [],
      live: {
        ok: false,
        reason: 'gitlab_unreachable',
        detail: pingError.message,
        fetched: 0,
        discovered: 0,
        branch: probeRepo.branch,
      },
    };
  }

  const started = Date.now();
  const budgetLeft = () => HYDRATE_BUDGET_MS - (Date.now() - started);

  const byRepoId = new Map(repos.map((r) => [r.id, r]));
  const keywords = keywordsFrom(query, featureName);
  const wantsUi = !layers?.length || layers.includes('ui');
  const wantsBe = !layers?.length || layers.includes('backend') || layers.includes('database');

  // Paths already associated with the matched feature (from index)
  const seedPaths = [...new Set(
    (chunks || [])
      .filter((c) => !layers?.length || layers.includes(layerOf(c.path)))
      .map((c) => ({ path: c.path, repoId: c.repoId, repoName: c.repoName })),
  )].sort((a, b) => preferPath(a.path, b.path));

  // When full-module layers are on, backend seeds can crowd out form HTML — UI first
  const uiSeeds = seedPaths.filter((s) => layerOf(s.path) === 'ui');
  const otherSeeds = seedPaths.filter((s) => layerOf(s.path) !== 'ui');
  const orderedSeeds = wantsUi ? [...uiSeeds, ...otherSeeds] : seedPaths;

  const uniqueSeeds = [];
  const seen = new Set();
  const uiCap = wantsUi ? MAX_AUTO_FE : 0;
  const otherCap = wantsBe ? MAX_AUTO_BE : MAX_PATHS_REFRESH;
  let uiCount = 0;
  let otherCount = 0;
  for (const s of orderedSeeds) {
    if (seen.has(s.path)) continue;
    const isUi = layerOf(s.path) === 'ui';
    if (isUi) {
      if (uiCount >= uiCap) continue;
      uiCount += 1;
    } else {
      if (otherCount >= otherCap) continue;
      otherCount += 1;
    }
    seen.add(s.path);
    uniqueSeeds.push(s);
    if (uniqueSeeds.length >= MAX_PATHS_REFRESH) break;
  }

  const liveChunks = [];
  let fetched = 0;
  let failed = 0;
  let discovered = 0;
  const fetchedPaths = new Set();
  let timeoutStreak = 0;

  async function pushLiveFile(repo, path, score = 3) {
    if (!repo || !path || fetchedPaths.has(path)) return false;
    if (budgetLeft() < 800) return false;
    const isUiForm = layerOf(path) === 'ui' && (/\.component\.html$/i.test(path) || /\.component\.ts$/i.test(path));
    if (timeoutStreak >= 3 && !isUiForm) return false;
    try {
      const content = await readLiveFile(repo, path);
      if (!content.trim()) return false;
      fetched += 1;
      timeoutStreak = 0;
      fetchedPaths.add(path);
      const lines = content.split('\n');
      liveChunks.push({
        id: `live_${repo.id}_${path}`,
        path,
        startLine: 1,
        endLine: lines.length,
        language: languageOf(path),
        content,
        repoId: repo.id,
        repoName: repo.name,
        score,
        method: 'live-gitlab',
        layer: layerOf(path),
        branch: repo.branch,
      });
      return true;
    } catch (e) {
      failed += 1;
      console.warn(`[live] fetch ${path}@${repo.branch} failed:`, e.message);
      if (e.code === 'ETIMEDOUT' || /timed out/i.test(e.message || '')) {
        timeoutStreak += 1;
        if (timeoutStreak >= 3) {
          console.warn('[live] repeated timeouts — skipping non-UI live fetches');
        }
      }
      return false;
    }
  }

  // 1) Always hydrate UI form HTML/TS first when UI layer is requested (testIds + validators)
  if (wantsUi) {
    const folder = resolvedFeatureFolder(featureName, (chunks || []).map((c) => c.path))
      || primaryFeatureFolder(chunks, featureName)
      || featureSlugFromNameSafe(featureName);
    try {
      const detailExtras = await autoDiscoverLiveFiles({
        projectId,
        repos,
        keywords: [folder, ...keywords].filter(Boolean).slice(0, 8),
        featureName,
        layers: ['ui'],
        exclude: fetchedPaths,
        folderOnly: folder || '',
      });
      for (const c of detailExtras) {
        if (fetchedPaths.has(c.path)) continue;
        // Prefer form/list component sources; skip pure scss/spec noise
        if (/\.(scss|css|spec\.ts)$/i.test(c.path)) continue;
        liveChunks.push(c);
        fetchedPaths.add(c.path);
        discovered += 1;
      }
    } catch (e) {
      console.warn('[live] UI form hydrate failed:', e.message);
    }
  }

  // 1b) List template — row edit/view/delete testIds (required for update/delete/view compose)
  if (wantsUi && budgetLeft() >= 1200) {
    const folder = resolvedFeatureFolder(featureName, [
      ...(chunks || []).map((c) => c.path),
      ...liveChunks.map((c) => c.path),
    ])
      || primaryFeatureFolder(chunks, featureName)
      || featureSlugFromNameSafe(featureName);
    const hasListHtml = liveChunks.some((c) => /-list\.component\.html$/i.test(c.path));
    const hasCreateTid = /data-testid\s*=\s*["'][^"']*-(create|add|new)["']/i
      .test(liveChunks.map((c) => c.content || '').join('\n'));
    if ((!hasListHtml || !hasCreateTid) && folder) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT DISTINCT c.path, c."repoId", r.name AS "repoName"
           FROM "CodeChunk" c
           LEFT JOIN "Repo" r ON r.id = c."repoId"
           WHERE c."projectId" = $1 AND c.path ILIKE $2
           LIMIT 8`,
          projectId,
          `%/pages/${folder}/%-list.component.html`,
        );
        let listHits = rows || [];
        if (!listHits.length) {
          const treeHits = await discoverUiPathsFromGitlabTree(repos, folder);
          listHits = treeHits
            .filter((h) => /-list\.component\.html$/i.test(h.path))
            .map((h) => ({ path: h.path, repoId: h.repo?.id, repoName: h.repoName }));
        } else {
          // Prefer primary {stem}-list over nested lists
          listHits = [...listHits].sort(
            (a, b) => rankListHtmlPath(a.path, folder) - rankListHtmlPath(b.path, folder),
          );
        }
        for (const hit of listHits.slice(0, 4)) {
          if (!hit?.path || fetchedPaths.has(hit.path)) continue;
          const repo = byRepoId.get(hit.repoId)
            || repos.find((r) => r.name === hit.repoName)
            || repos.find((r) => /frontend|front-end|web|ui/i.test(r.name))
            || repos[0];
          await pushLiveFile(repo, hit.path, 4);
        }
      } catch (e) {
        console.warn('[live] list template fetch failed:', e.message);
      }
    }
  }

  // 2) Seed paths from index (UI already preferred in uniqueSeeds)
  for (const seed of uniqueSeeds) {
    if (budgetLeft() < 800) break;
    const repo = byRepoId.get(seed.repoId)
      || repos.find((r) => r.name === seed.repoName)
      || (layerOf(seed.path) === 'ui'
        ? repos.find((r) => /frontend|front-end|web|ui/i.test(r.name))
        : repos.find((r) => /backend|api|server/i.test(r.name)))
      || repos[0];
    await pushLiveFile(repo, seed.path, 3);
  }

  // 3) If still no form HTML, force one more UI discover pass
  try {
    if (wantsUi && !hasFeatureDetailChunk(liveChunks, featureName) && budgetLeft() >= 2000) {
      const folder = resolvedFeatureFolder(featureName, [
        ...(chunks || []).map((c) => c.path),
        ...liveChunks.map((c) => c.path),
      ])
        || primaryFeatureFolder(chunks, featureName)
        || featureSlugFromNameSafe(featureName);
      const detailExtras = await autoDiscoverLiveFiles({
        projectId,
        repos,
        keywords: [folder, ...keywords].filter(Boolean).slice(0, 8),
        featureName,
        layers: ['ui'],
        exclude: fetchedPaths,
        folderOnly: folder || '',
      });
      for (const c of detailExtras) {
        if (fetchedPaths.has(c.path)) continue;
        if (!isDetailChunkPath(c.path) && !isFeatureFormHtmlPath(c.path)) continue;
        liveChunks.push(c);
        fetchedPaths.add(c.path);
        discovered += 1;
      }
    }
  } catch (e) {
    console.warn('[live] detail template fetch failed:', e.message);
  }

  // 4) Backend/database discover when those layers are on
  try {
    if (wantsBe && budgetLeft() >= 2000 && keywords.length) {
      const extras = await autoDiscoverLiveFiles({
        projectId,
        repos,
        keywords,
        featureName,
        layers: (layers || []).filter((l) => l === 'backend' || l === 'database'),
        exclude: fetchedPaths,
      });
      for (const c of extras) {
        if (fetchedPaths.has(c.path)) continue;
        liveChunks.push(c);
        fetchedPaths.add(c.path);
        discovered += 1;
      }
    }
  } catch (e) {
    console.warn('[live] backend/db discover failed:', e.message);
  }

  // 5) UI still missing testIds (timeouts / backend-only hydrate) — force list + form templates
  if (wantsUi && !liveUiSourcesReady(liveChunks).ok) {
    try {
      const sup = await supplementLiveUiFromGitLab({
        projectId,
        repos,
        featureName,
        liveChunks,
        fetchedPaths,
        seedChunks: chunks,
      });
      if (sup.added.length) {
        for (const c of sup.added) liveChunks.push(c);
        fetched += sup.added.length;
        console.log(`[live] mandatory UI supplement +${sup.added.length}: ${sup.added.map((c) => c.path).join(', ')}`);
      }
    } catch (e) {
      console.warn('[live] mandatory UI supplement failed:', e.message);
    }
  }

  // Keep any indexed chunks whose paths we could not refresh (catalog only — UI draft must not use these)
  const keptIndexed = (chunks || []).filter((c) => !fetchedPaths.has(c.path));

  const merged = liveChunks.length
    ? [...liveChunks, ...keptIndexed].slice(0, 36)
    : chunks;

  const branch = repos.map((r) => `${r.name}@${r.branch}`).join(', ');

  return {
    chunks: merged,
    liveChunks,
    live: {
      ok: fetched > 0 || discovered > 0,
      reason: fetched || discovered ? null : (failed ? 'gitlab_fetch_failed' : 'nothing_fetched'),
      fetched,
      discovered,
      failed,
      branch,
      paths: [...fetchedPaths].slice(0, 16),
    },
  };
}

/** True when chunk body came from live GitLab (seed refresh or auto-discover). */
export function isLiveGitlabChunk(chunk) {
  return /^live-/i.test(String(chunk?.method || ''));
}

/** UI compose input: only live-fetched FE/BE bodies. */
export function filterLiveGitlabChunks(chunks = []) {
  return (chunks || []).filter(isLiveGitlabChunk);
}

/**
 * Live UI sources are usable for testIds + FormGroup rules when we have
 * list HTML (Add/Create click) plus a form/detail template with real fields
 * (shell wrappers with only save/cancel are not enough — e.g. article tabs).
 */
export function liveUiSourcesReady(liveChunks = []) {
  const ui = (liveChunks || []).filter((c) => {
    if (!isLiveGitlabChunk(c)) return false;
    return layerOf(c.path) === 'ui' || /\.(html|ts|tsx)$/i.test(c.path);
  });
  const html = ui.filter((c) => /\.component\.html$/i.test(c.path) && !/\.spec\./i.test(c.path));
  const ts = ui.filter((c) => /\.component\.ts$/i.test(c.path) && !/\.spec\./i.test(c.path));
  const blob = ui.map((c) => c.content || '').join('\n');
  const formBlob = html
    .filter((c) => isFeatureFormHtmlPath(c.path))
    .map((c) => c.content || '')
    .join('\n');
  const hasTestId = /data-testid\s*=|testId\s*=/i.test(blob);
  const hasRules = /Validators\.|formControlName\s*=|FormGroup|fb\.group/i.test(blob);
  const hasListHtml = html.some((c) => /-list\.component\.html$/i.test(c.path));
  const hasFormHtml = html.some((c) => isFeatureFormHtmlPath(c.path));
  const formControlCount = (formBlob.match(/formControlName\s*=/gi) || []).length;
  const formFieldTestIds = (formBlob.match(/data-testid\s*=\s*["'][^"']+["']/gi) || [])
    .filter((m) => !/-(save|cancel|back|close|delete|create|add|new|edit|view|row|list|search|filter|export|paginator|empty)/i.test(m));
  const hasFormFields = formControlCount >= 2 || formFieldTestIds.length >= 2;
  const hasCreateTid = /data-testid\s*=\s*["'][^"']*-(create|add|new)["']/i.test(blob)
    || /testId\s*=\s*["'][^"']*-(create|add|new)["']/i.test(blob);
  const hasSaveTid = /data-testid\s*=\s*["'][^"']*-(save|submit)["']/i.test(blob)
    || /testId\s*=\s*["'][^"']*-(save|submit)["']/i.test(blob);
  return {
    ok: html.length >= 1 && hasTestId && hasRules && hasListHtml && hasFormHtml && hasFormFields && hasCreateTid && hasSaveTid,
    htmlCount: html.length,
    tsCount: ts.length,
    hasTestId,
    hasRules,
    hasListHtml,
    hasFormHtml,
    hasFormFields,
    hasCreateTid,
    hasSaveTid,
    paths: ui.map((c) => c.path).slice(0, 12),
  };
}

/** Prefer `{stem}-list/{stem}-list.component.html` over nested module lists. */
function rankListHtmlPath(path, folder = '') {
  const p = String(path || '');
  const base = p.split('/').pop() || '';
  const stem = String(folder || '').replace(/ies$/i, 'y').replace(/s$/i, '') || '';
  let rank = mandatoryUiRank(p);
  if (stem && new RegExp(`^${stem}-list\\.component\\.html$`, 'i').test(base)) rank -= 2;
  if (stem && new RegExp(`/${stem}-list/${stem}-list\\.component\\.html$`, 'i').test(p)) rank -= 2;
  // Form field tabs (general-tab) before shell detail wrappers
  if (/-general-tab\.component\.html$/i.test(p)) rank -= 1.5;
  else if (/\/[^/]*-tab\.component\.html$/i.test(p)) rank += 1;
  // Detail shell holds save/cancel — keep near top after list/general
  if (stem && new RegExp(`^${stem}-detail\\.component\\.html$`, 'i').test(base)) rank -= 1;
  // Deeper nested lists (partner-list-management, local-list) rank worse
  const depth = (p.match(/\/pages\/[^/]+\//)?.[0] ? p.split(`/pages/${folder}/`)[1] || p : p)
    .split('/').length;
  rank += Math.max(0, depth - 3);
  return rank;
}

/**
 * When index catalog has no pages/{folder} paths (mid-reindex), discover UI files
 * from the live GitLab tree under src/app/pages/{folder}.
 */
async function discoverUiPathsFromGitlabTree(repos, folder) {
  const fe = repos.find((r) => /frontend|front-end|web|ui/i.test(r.name)) || repos[0];
  if (!fe || !folder) return [];
  const roots = [`src/app/pages/${folder}`, `app/pages/${folder}`];
  for (const root of roots) {
    try {
      const paths = await GL.fetchTreeUnderPath(
        fe.baseUrl,
        fe.token,
        fe.name,
        fe.branch,
        root,
        { timeoutMs: LIVE_FILE_TIMEOUT_MS },
      );
      if (!paths.length) continue;
      const uiPaths = paths.filter((p) => {
        if (!/\.component\.(html|ts)$/i.test(p) || /\.spec\./i.test(p)) return false;
        return true;
      });
      return uiPaths
        .sort((a, b) => rankListHtmlPath(a, folder) - rankListHtmlPath(b, folder) || preferPath(a, b))
        .slice(0, 12)
        .map((path) => ({ path, repoId: null, repoName: fe.name, repo: fe }));
    } catch (e) {
      console.warn(`[live] GitLab tree ${root}@${fe.branch} failed:`, e.message);
    }
  }
  return [];
}

const MANDATORY_UI_PATTERNS = (folder) => [
  `%/pages/${folder}/%-list.component.html`,
  `%/pages/${folder}/%-details.component.html`,
  `%/pages/${folder}/%.component.html`,
  `%/pages/${folder}/%-details.component.ts`,
  `%/pages/${folder}/%-list.component.ts`,
];

function mandatoryUiRank(path) {
  if (/-list\.component\.html$/i.test(path)) return 0;
  if (/-details\.component\.html$/i.test(path)) return 1;
  if (/\.component\.html$/i.test(path) && !/-list\./i.test(path)) return 2;
  if (/-details\.component\.ts$/i.test(path)) return 3;
  if (/-list\.component\.ts$/i.test(path)) return 4;
  return 5;
}

/**
 * When live hydrate returned backend-only bodies (or UI fetches timed out), force-fetch
 * list + form templates from the indexed catalog — same paths, fresh GitLab bodies.
 */
export async function supplementLiveUiFromGitLab({
  projectId,
  repos = [],
  featureName = '',
  liveChunks = [],
  fetchedPaths = new Set(),
  seedChunks = [],
}) {
  if (!repos.length) {
    const loaded = await loadActiveGitlabRepos(projectId);
    repos = loaded;
  }
  if (!repos.length) return { liveChunks, added: [] };

  const folder = await resolvePagesFolder(
    projectId,
    featureName,
    resolvedFeatureFolder(
      featureName,
      [...(seedChunks || []).map((c) => c.path), ...(liveChunks || []).map((c) => c.path)],
    ),
  );
  if (!folder) return { liveChunks, added: [] };

  const byRepoId = new Map(repos.map((r) => [r.id, r]));
  const hits = new Map();

  for (const pattern of MANDATORY_UI_PATTERNS(folder)) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT c.path, c."repoId", r.name AS "repoName"
         FROM "CodeChunk" c
         LEFT JOIN "Repo" r ON r.id = c."repoId"
         WHERE c."projectId" = $1 AND c.path ILIKE $2
         LIMIT 6`,
        projectId,
        pattern,
      );
      for (const row of rows || []) {
        if (!row?.path || fetchedPaths.has(row.path)) continue;
        hits.set(row.path, row);
      }
    } catch { /* try next pattern */ }
  }

  // Catalog empty / mid-reindex — discover from live GitLab tree (no hardcoded modules)
  if (!hits.size) {
    try {
      const treeHits = await discoverUiPathsFromGitlabTree(repos, folder);
      for (const hit of treeHits) {
        if (!hit?.path || fetchedPaths.has(hit.path)) continue;
        hits.set(hit.path, {
          path: hit.path,
          repoId: hit.repo?.id,
          repoName: hit.repoName,
        });
      }
      if (treeHits.length) {
        console.log(`[live] GitLab tree fallback for pages/${folder}: ${treeHits.length} UI paths`);
      }
    } catch (e) {
      console.warn('[live] GitLab tree fallback failed:', e.message);
    }
  }

  const ordered = [...hits.values()].sort(
    (a, b) => rankListHtmlPath(a.path, folder) - rankListHtmlPath(b.path, folder)
      || mandatoryUiRank(a.path) - mandatoryUiRank(b.path)
      || preferPath(a.path, b.path),
  );

  const added = [];
  const out = [...liveChunks];

  for (const hit of ordered.slice(0, 12)) {
    const repo = byRepoId.get(hit.repoId)
      || repos.find((r) => r.name === hit.repoName)
      || repos.find((r) => /frontend|front-end|web|ui/i.test(r.name))
      || repos[0];
    if (!repo) continue;
    try {
      const content = await readLiveFile(repo, hit.path);
      if (!content.trim()) continue;
      if (!/data-testid\s*=|testId\s*=/i.test(content) && !/\.component\.ts$/i.test(hit.path)) continue;
      const lines = content.split('\n');
      const chunk = {
        id: `live_mandatory_${repo.id}_${hit.path}`,
        path: hit.path,
        startLine: 1,
        endLine: lines.length,
        language: languageOf(hit.path),
        content,
        repoId: repo.id,
        repoName: repo.name,
        score: 5,
        method: 'live-gitlab',
        layer: layerOf(hit.path),
        branch: repo.branch,
      };
      out.push(chunk);
      added.push(chunk);
      fetchedPaths.add(hit.path);
      if (liveUiSourcesReady(out).ok) break;
    } catch (e) {
      console.warn(`[live] mandatory UI fetch ${hit.path} failed:`, e.message);
    }
  }

  return { liveChunks: out, added };
}

async function resolvePagesFolder(projectId, featureName, hintFolder = '') {
  const slug = featureSlugFromName(featureName);
  const raw = [slug, slug ? `${slug}s` : '', slug?.replace(/ies$/, 'y'), slug?.replace(/s$/, ''), hintFolder]
    .map((s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, ''))
    .filter(Boolean);
  const candidates = [...new Set(raw)];

  for (const folder of candidates) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT 1 AS ok FROM "CodeChunk"
         WHERE "projectId" = $1 AND path ILIKE $2
         LIMIT 1`,
        projectId,
        `%/pages/${folder}/%`,
      );
      if (rows?.length) return folder;
    } catch { /* try next */ }
  }

  // Fuzzy: pages/<folder> whose normalized name contains/equals the feature key
  const key = String(featureName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!key) return hintFolder || slug || '';
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT (regexp_match(path, '/pages/([^/]+)/'))[1] AS folder
       FROM "CodeChunk"
       WHERE "projectId" = $1 AND path ILIKE '%/pages/%'
       LIMIT 200`,
      projectId,
    );
    const folders = (rows || []).map((r) => r.folder).filter(Boolean);
    const hit = folders.find((f) => {
      const nk = String(f).toLowerCase().replace(/[^a-z0-9]+/g, '');
      return nk === key || nk.includes(key) || key.includes(nk);
    });
    if (hit) return hit;
  } catch { /* ignore */ }

  return hintFolder || slug || '';
}

async function autoDiscoverLiveFiles({ projectId, repos, keywords, featureName, layers, exclude, folderOnly = '' }) {
  if (!keywords.length && !folderOnly) return [];

  let effectiveFolder = folderOnly;
  if (folderOnly || featureName) {
    effectiveFolder = await resolvePagesFolder(projectId, featureName, folderOnly);
  }

  // Candidate paths from index catalog (fast) — bodies come live from GitLab
  let rows = [];
  try {
    if (effectiveFolder) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT c.path, c."repoId", r.name AS "repoName"
         FROM "CodeChunk" c
         LEFT JOIN "Repo" r ON r.id = c."repoId"
         WHERE c."projectId" = $1 AND c.path ILIKE $2
         LIMIT 40`,
        projectId,
        `%/pages/${effectiveFolder}/%`,
      );
    }
    if (!rows.length) {
      const likes = keywords.slice(0, 6).map((_, i) => `path ILIKE $${i + 2}`);
      const params = [projectId, ...keywords.slice(0, 6).map((k) => `%${k}%`)];
      rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT c.path, c."repoId", r.name AS "repoName"
         FROM "CodeChunk" c
         LEFT JOIN "Repo" r ON r.id = c."repoId"
         WHERE c."projectId" = $1 AND (${likes.join(' OR ')})
         LIMIT 80`,
        ...params,
      );
    }
  } catch {
    return [];
  }

  const byRepoId = new Map(repos.map((r) => [r.id, r]));
  const byRepoName = new Map(repos.map((r) => [r.name, r]));
  const scored = rows
    .filter((r) => r.path && !exclude.has(r.path))
    .filter((r) => !layers?.length || layers.includes(layerOf(r.path)))
    .filter((r) => {
      if (!effectiveFolder) return true;
      const p = r.path.toLowerCase();
      const f = effectiveFolder.toLowerCase();
      return p.includes(`/pages/${f}/`) || p.includes(`/${f}/`);
    })
    .map((r) => {
      let score = scorePath(r.path, keywords);
      if (featureName) {
        const fk = String(featureName).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const pk = featureFromPath(r.path).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (fk && pk && (pk === fk || pk.includes(fk) || fk.includes(pk))) score += 8;
      }
      if (isFeatureFormHtmlPath(r.path)) score += 20;
      if (/\.component\.ts$/i.test(r.path) && !/\.spec\./i.test(r.path) && !/-list\./i.test(r.path)) score += 12;
      return { ...r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || preferPath(a.path, b.path));

  const fe = scored.filter((x) => layerOf(x.path) === 'ui').slice(0, MAX_AUTO_FE);
  const be = scored.filter((x) => layerOf(x.path) === 'backend').slice(0, Math.ceil(MAX_AUTO_BE / 2));
  const db = scored.filter((x) => layerOf(x.path) === 'database').slice(0, Math.ceil(MAX_AUTO_BE / 2));
  const out = [];

  for (const hit of [...fe, ...be, ...db]) {
    // Never fetch FE paths via backend repo (and vice versa)
    const repo = byRepoId.get(hit.repoId)
      || byRepoName.get(hit.repoName)
      || (layerOf(hit.path) === 'ui'
        ? repos.find((r) => /frontend|front-end|web|ui/i.test(r.name))
        : repos.find((r) => /backend|api|server/i.test(r.name)))
      || repos[0];
    if (!repo) continue;
    try {
      const content = await readLiveFile(repo, hit.path);
      if (!content.trim()) continue;
      const lines = content.split('\n');
      out.push({
        id: `live_auto_${repo.id}_${hit.path}`,
        path: hit.path,
        startLine: 1,
        endLine: lines.length,
        language: languageOf(hit.path),
        content,
        repoId: repo.id,
        repoName: repo.name,
        score: hit.score,
        method: 'live-gitlab',
        layer: layerOf(hit.path),
        branch: repo.branch,
      });
    } catch {
      // skip
    }
  }

  return out;
}
