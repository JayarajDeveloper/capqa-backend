// Retrieve relevant code chunks (hybrid: keyword + path boost + optional embeddings).
// Prefers application source (Controllers/Services/UI) over devops/migrations noise.

import { prisma } from '../../db.js';
import { embedOne } from './embed.js';

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with',
  'from', 'into', 'is', 'are', 'be', 'as', 'it', 'this', 'that', 'my', 'our',
  'create', 'make', 'add', 'new', 'please', 'want', 'need', 'test', 'case', 'cases',
  // Field/value words — drown module retrieval (currency+code → CodeStructure / EanCode)
  'code', 'name', 'symbol', 'numeric', 'rounding', 'increment', 'rate', 'euro', 'eur',
  'named', 'called', 'using',
]);

/** Paths that rarely hold product business logic for QA. */
const NOISE_PATH = /(?:^|\/)(devops|keycloak|keycloack|migrations_bk|vendor|node_modules|docs\/|assets\/i18n|\.github|docker|helm|terraform|CodebaseKnowledge|JiraTestRunner|Shared\/Enum)(?:\/|$)/i;

/** Prefer real application code. */
const APP_PATH = /(?:^|\/)(src\/Features|src\/app|Controller|Service|Repository|Entity|Dto|OpenApi|pages\/|components\/)/i;

/** Classify a file path into ui | backend | database for Compose layer tags. */
export function layerOf(path) {
  const p = String(path || '');
  // Database / persistence first (Entity/Repository before generic .php backend)
  if (/(?:^|\/)(Entity|Entities|migrations?|Migration|Repository|Repositories|Doctrine)\b/i.test(p)) return 'database';
  if (/\.sql$/i.test(p)) return 'database';
  // UI / frontend
  if (/(?:^|\/)(src\/app|pages\/|components\/|assets\/|public\/)/i.test(p)) return 'ui';
  if (/\.(tsx?|jsx?|vue|html|scss|css|less)$/i.test(p) && !/Features\//i.test(p)) return 'ui';
  // Backend / API / services
  if (/(?:^|\/)(Controller|Service|OpenApi|Dto|DTO|Features\/)/i.test(p)) return 'backend';
  if (/\.php$/i.test(p)) return 'backend';
  return 'backend';
}

export function matchesLayers(path, layers) {
  if (!layers?.length) return true;
  const set = new Set(layers.map((l) => String(l).toLowerCase()));
  if (set.has('all')) return true;
  return set.has(layerOf(path));
}

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/[\s_-]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .slice(0, 10);
}

/** Expand query words: plurals + joined forms (no app-specific hardcoding). */
function expandTerms(words) {
  const out = new Set(words);
  for (const w of words) {
    if (w.endsWith('ies') && w.length > 4) out.add(`${w.slice(0, -3)}y`);
    else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) out.add(w.slice(0, -1));
    else {
      out.add(`${w}s`);
      if (w.endsWith('y') && w.length > 3) out.add(`${w.slice(0, -1)}ies`);
    }
  }
  if (words.length >= 2) {
    out.add(words.join(''));
    out.add(words.join('_'));
    out.add(words.join('-'));
  }
  return [...out];
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function pathBoost(path, terms) {
  const p = String(path || '').toLowerCase();
  let boost = 0;
  if (NOISE_PATH.test(path)) boost -= 2.5;
  if (APP_PATH.test(path)) boost += 1.2;
  if (/\.(php|ts|tsx|js|jsx|vue|html)$/i.test(path)) boost += 0.4;
  if (/\.html$/i.test(path)) boost += 0.5;
  if (/\/pages\/.+\/.+\.component\.(html|ts)$/i.test(path) && !/\.spec\./i.test(path)) boost += 3.5;
  if (/\.md$/i.test(path)) boost -= 0.8;
  if (/migrations?\//i.test(path)) boost -= 0.6;
  if (/CodebaseKnowledge|JiraTestRunner|EanCode/i.test(path)) boost -= 3;

  for (const t of terms) {
    if (!t) continue;
    const tl = t.toLowerCase();
    if (p.includes(tl)) boost += 2.0;
    // light plural: partners ↔ partner in path
    if (tl.endsWith('s') && tl.length > 3 && p.includes(tl.slice(0, -1))) boost += 1.5;
    if (!tl.endsWith('s') && p.includes(`${tl}s`)) boost += 1.5;
  }
  const joined = terms.filter((t) => t.length > 3).join('');
  if (joined && p.includes(joined)) boost += 3.0;

  return boost;
}

/**
 * @returns {Promise<Array<{ id, path, startLine, endLine, language, content, repoId, repoName, score, method }>>}
 */
export async function retrieveChunks({
  projectId,
  query,
  topK = 10,
  apiKey = null,
  provider = 'anthropic',
  repoIds = null,
  baseUrl = null,
  layers = null,
} = {}) {
  if (!projectId || !query?.trim()) return [];

  const active = await prisma.repo.findMany({
    where: {
      projectId,
      active: true,
      ...(repoIds?.length ? { id: { in: repoIds } } : {}),
      index: { status: 'ready' },
    },
    select: { id: true, name: true },
  });
  if (!active.length) return [];

  const ids = active.map((r) => r.id);
  const nameById = Object.fromEntries(active.map((r) => [r.id, r.name]));
  const byId = new Map();
  const words = tokenize(query);
  const terms = expandTerms(words);

  const push = (row, method, baseScore) => {
    if (!row?.id) return;
    if (!matchesLayers(row.path, layers)) return;
    const boost = pathBoost(row.path, terms);
    const score = (Number(baseScore) || 0) + boost;
    if (score < -1) return; // drop heavy noise
    const prev = byId.get(row.id);
    if (!prev || score > prev.score) {
      byId.set(row.id, {
        id: row.id,
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        language: row.language,
        content: row.content,
        repoId: row.repoId,
        repoName: nameById[row.repoId] || row.repoId,
        score,
        method,
        layer: layerOf(row.path),
        embedding: row.embedding,
      });
    }
  };

  // 1) Path-first: files whose path matches ask terms (incl. plural variants)
  if (terms.length) {
    const pathClauses = [];
    const pathParams = [projectId, ids];
    let i = 3;
    for (const t of terms.slice(0, 6)) {
      pathClauses.push(`path ILIKE $${i}`);
      pathParams.push(`%${t}%`);
      i += 1;
    }
    if (pathClauses.length) {
      try {
        const pathHits = await prisma.$queryRawUnsafe(
          `SELECT id, path, "startLine", "endLine", language, content, "repoId", embedding
           FROM "CodeChunk"
           WHERE "projectId" = $1
             AND "repoId" = ANY($2::text[])
             AND (${pathClauses.join(' OR ')})
           LIMIT 80`,
          ...pathParams,
        );
        pathHits.forEach((r) => push(r, 'path', 1.5));
      } catch (e) {
        console.warn('[rag] path search failed:', e.message);
      }
    }
  }

  // 1b) When UI layer is on, force-include /pages/<module>/ form sources for the subject noun
  if ((!layers?.length || layers.includes('ui')) && words.length) {
    const subject = words.find((w) => w.length >= 3) || words[0];
    if (subject) {
      const folders = [...new Set([
        subject,
        `${subject}s`,
        subject.endsWith('y') && subject.length > 3 ? `${subject.slice(0, -1)}ies` : null,
        subject.endsWith('ies') ? `${subject.slice(0, -3)}y` : null,
        subject.endsWith('s') && !subject.endsWith('ss') ? subject.slice(0, -1) : null,
      ].filter(Boolean))];
      try {
        const uiHits = await prisma.$queryRawUnsafe(
          `SELECT id, path, "startLine", "endLine", language, content, "repoId", embedding
           FROM "CodeChunk"
           WHERE "projectId" = $1
             AND "repoId" = ANY($2::text[])
             AND path ILIKE '%/pages/%'
             AND (${folders.map((_, idx) => `path ILIKE $${idx + 3}`).join(' OR ')})
             AND path ~* '\\.component\\.(html|ts)$'
             AND path !~* '\\.spec\\.'
           LIMIT 40`,
          projectId,
          ids,
          ...folders.map((f) => `%/pages/%${f}%/%`),
        );
        uiHits.forEach((r) => push(r, 'path-ui', 4.0));
      } catch (e) {
        console.warn('[rag] UI pages seed failed:', e.message);
      }
    }
  }

  // 2) Full-text on significant terms (AND preferred, else OR)
  if (words.length) {
    const safe = words.map((w) => w.replace(/[^a-z0-9_]/g, '')).filter(Boolean);
    const andQ = safe.join(' & ');
    const orQ = safe.join(' | ');
    for (const [tsQuery, weight] of [[andQ, 1.0], [orQ, 0.35]]) {
      if (!tsQuery) continue;
      try {
        const ftsHits = await prisma.$queryRawUnsafe(
          `SELECT id, path, "startLine", "endLine", language, content, "repoId", embedding,
                  ts_rank(search, to_tsquery('english', $1)) AS score
           FROM "CodeChunk"
           WHERE "projectId" = $2
             AND "repoId" = ANY($3::text[])
             AND search @@ to_tsquery('english', $1)
           ORDER BY score DESC
           LIMIT $4`,
          tsQuery, projectId, ids, Math.max(topK * 4, 40),
        );
        ftsHits.forEach((r) => push(r, 'keyword', (Number(r.score) || 0) * weight));
        if (andQ && byId.size >= topK) break;
      } catch (e) {
        console.warn('[rag] FTS failed:', e.message);
      }
    }

    // Content ILIKE for remaining gaps (prefer longer terms)
    if (byId.size < topK) {
      for (const w of [...terms].sort((a, b) => b.length - a.length).slice(0, 4)) {
        if (w.length < 4) continue;
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, path, "startLine", "endLine", language, content, "repoId", embedding
           FROM "CodeChunk"
           WHERE "projectId" = $1
             AND "repoId" = ANY($2::text[])
             AND (content ILIKE $3 OR path ILIKE $3)
           LIMIT $4`,
          projectId, ids, `%${w}%`, topK * 2,
        );
        rows.forEach((r) => push(r, 'keyword', 0.4));
      }
    }
  }

  // 3) Embeddings when available (skipped for Anthropic — lexical only)
  let queryEmb = null;
  try {
    queryEmb = await embedOne(query, { apiKey, provider, baseUrl });
  } catch (e) {
    console.warn('[rag] query embed failed:', e.message);
  }

  if (queryEmb) {
    const candidates = await prisma.$queryRawUnsafe(
      `SELECT id, path, "startLine", "endLine", language, content, "repoId", embedding
       FROM "CodeChunk"
       WHERE "projectId" = $1
         AND "repoId" = ANY($2::text[])
         AND embedding IS NOT NULL
         AND path NOT ILIKE '%/devops/%'
         AND path NOT ILIKE '%keycloak%'
         AND path NOT ILIKE '%keycloack%'
         AND path NOT ILIKE '%migrations_bk/%'
       LIMIT 500`,
      projectId, ids,
    );
    for (const row of candidates) {
      const emb = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
      const score = cosine(queryEmb, emb);
      if (score > 0.28) push(row, 'vector', score * 2);
    }
  }

  return diversify([...byId.values()], topK)
    .map(({ embedding, ...c }) => ({
      ...c,
      // Keep full bodies for UI form sources — 2.5k cuts drop FormGroup + testIds
      content: keepFullChunkBody(c.path)
        ? String(c.content || '')
        : String(c.content || '').slice(0, 2500),
    }));
}

/** Component templates/logic must stay whole for schema extraction (live hydrate or index expand). */
export function keepFullChunkBody(filePath) {
  const p = String(filePath || '');
  if (/\.component\.(html|ts)$/i.test(p) && !/\.spec\./i.test(p)) return true;
  if (/\/pages\/.+\.(html|ts)$/i.test(p) && !/\.spec\./i.test(p)) return true;
  return false;
}

/**
 * Collapse overlapping index windows for the same form file into one body
 * (index-only fallback when live GitLab did not refresh the path).
 */
export function mergeFormFileChunks(chunks = []) {
  const byPath = new Map();
  const passthrough = [];
  for (const c of chunks || []) {
    if (!keepFullChunkBody(c.path)) {
      passthrough.push(c);
      continue;
    }
    const list = byPath.get(c.path) || [];
    list.push(c);
    byPath.set(c.path, list);
  }
  const merged = [];
  for (const [path, list] of byPath) {
    if (list.length === 1 && (list[0].method === 'live-gitlab' || (list[0].content || '').length > 12_000)) {
      merged.push(list[0]);
      continue;
    }
    const ordered = [...list].sort((a, b) => (a.startLine || 0) - (b.startLine || 0));
    const content = ordered.map((c) => c.content || '').join('\n');
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    merged.push({
      ...first,
      id: first.id || `merged_${path}`,
      startLine: first.startLine || 1,
      endLine: last.endLine || content.split('\n').length,
      content,
      method: first.method === 'live-gitlab' ? 'live-gitlab' : 'index-merged',
      score: Math.max(...ordered.map((c) => c.score || 0)),
    });
  }
  return [...passthrough, ...merged];
}

/** Prefer variety of files/repos so one component's chunks don't fill the whole context. */
function diversify(rows, topK) {
  const sorted = rows.sort((a, b) => b.score - a.score);
  const picked = [];
  const pathCount = new Map();
  const repoCount = new Map();

  for (const row of sorted) {
    if (picked.length >= topK) break;
    const pc = pathCount.get(row.path) || 0;
    const rc = repoCount.get(row.repoId) || 0;
    // Form HTML/TS: allow more windows so validators + testIds can be merged later
    const maxPerPath = keepFullChunkBody(row.path) ? 8 : 2;
    if (pc >= maxPerPath) continue;
    if (rc >= Math.ceil(topK * 0.7) && picked.length >= Math.ceil(topK / 2)) continue;
    picked.push(row);
    pathCount.set(row.path, pc + 1);
    repoCount.set(row.repoId, rc + 1);
  }

  // Fill remaining from sorted if under topK
  for (const row of sorted) {
    if (picked.length >= topK) break;
    if (picked.some((p) => p.id === row.id)) continue;
    picked.push(row);
  }
  return picked;
}

export function formatChunksForPrompt(chunks) {
  if (!chunks?.length) return '';
  return chunks.map((c, i) => (
    `[${i + 1}] ${c.repoName} :: ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`${c.language || ''}\n${c.content}\n\`\`\``
  )).join('\n\n');
}
