/**
 * Runtime Entity Discovery — zero hardcoding.
 *
 * Replaces entityMap.json with live filesystem scanning.
 * PHP entities: scan src/Features/* /Entity/*.php
 * Services:     scan src/Features/* /Service/*Service.php
 * UI files:     scan src/app/pages/*  matching entity name/folder
 *
 * Results are cached in-process for the lifetime of the server.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';

// ── Cache ──────────────────────────────────────────────────────────
let _cache = null;          // { entities: Map<name, {entities, services, ui}> }
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5 min — re-scan on new deploys

function getRoots() {
  const ui = String(env.CAPQA_LOCAL_UI_ROOT || '').trim().replace(/\/+$/, '');
  const api = String(env.CAPQA_LOCAL_API_ROOT || '').trim().replace(/\/+$/, '');
  return { ui, api };
}

async function dirExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── Filesystem helpers ─────────────────────────────────────────────

async function* walkDir(dir, { maxDepth = 5 } = {}) {
  if (maxDepth < 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkDir(full, { maxDepth: maxDepth - 1 });
    else if (e.isFile()) yield full;
  }
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// ── Name → slug conversion ────────────────────────────────────────

function toSlug(name) {
  // PascalCase → kebab-case, also handles snake_case
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

function slugVariants(entityName) {
  const base = toSlug(entityName);
  const lower = entityName.toLowerCase();
  // Common pluralizations
  const plurals = [base + 's'];
  if (base.endsWith('y')) plurals.push(base.slice(0, -1) + 'ies');
  if (base.endsWith('s')) plurals.push(base.slice(0, -1));
  if (base.endsWith('x')) plurals.push(base + 'es');
  return [...new Set([base, lower, ...plurals])];
}

function normalizedKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Main discovery ─────────────────────────────────────────────────

export async function discoverAllEntities({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (_cache && !forceRefresh && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cache;
  }

  const { ui, api } = getRoots();
  const map = new Map();

  // ── 1. Scan PHP entities from src/Features/* /Entity/ ──
  if (api && await dirExists(api)) {
    const featuresDir = path.join(api, 'src', 'Features');
    if (await dirExists(featuresDir)) {
      const featureDirs = await fs.readdir(featuresDir, { withFileTypes: true });
      for (const fd of featureDirs) {
        if (!fd.isDirectory()) continue;
        const entityDir = path.join(featuresDir, fd.name, 'Entity');
        if (!(await dirExists(entityDir))) continue;

        const files = await fs.readdir(entityDir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.php')) continue;
          const entityName = f.name.replace(/\.php$/, '');
          const relPath = toRel(api, path.join(entityDir, f.name));

          let entry = map.get(entityName.toLowerCase());
          if (!entry) {
            entry = { entities: [], services: [], ui: [] };
            map.set(entityName.toLowerCase(), entry);
          }
          entry.entities.push(relPath);
        }

        // Services in the same feature folder
        const serviceDir = path.join(featuresDir, fd.name, 'Service');
        if (await dirExists(serviceDir)) {
          const svcFiles = await fs.readdir(serviceDir, { withFileTypes: true });
          for (const sf of svcFiles) {
            if (!sf.isFile() || !sf.name.endsWith('.php')) continue;
            const relPath = toRel(api, path.join(serviceDir, sf.name));
            // Match service to its entity: ServiceName matches entity if it ends with Service
            const svcEntity = sf.name.replace('Service.php', '');
            if (svcEntity && svcEntity !== sf.name) {
              let entry = map.get(svcEntity.toLowerCase());
              if (!entry) {
                entry = { entities: [], services: [], ui: [] };
                map.set(svcEntity.toLowerCase(), entry);
              }
              entry.services.push(relPath);
            }
          }
        }
      }
    }
  }

  // ── 2. Scan UI pages folders ──
  if (ui && await dirExists(ui)) {
    const pagesCandidates = [
      path.join(ui, 'src', 'app', 'pages'),
      path.join(ui, 'app', 'pages'),
    ];

    let pagesRoot = null;
    for (const c of pagesCandidates) {
      if (await dirExists(c)) { pagesRoot = c; break; }
    }

    if (pagesRoot) {
      const folders = await fs.readdir(pagesRoot, { withFileTypes: true });

      // Build folder → entity matching index
      // For each entity, try all slug variants against folder names
      for (const [entityKey, entry] of map) {
        const variants = slugVariants(entityKey);
        for (const folder of folders) {
          if (!folder.isDirectory()) continue;
          const fk = normalizedKey(folder.name);
          if (variants.some(v => normalizedKey(v) === fk)) {
            // Found matching folder — scan for .html files
            const absFolder = path.join(pagesRoot, folder.name);
            for await (const absFile of walkDir(absFolder, { maxDepth: 5 })) {
              const rel = toRel(ui, absFile);
              if (/\.component\.html$/i.test(rel) && !/\.spec\./i.test(rel)) {
                entry.ui.push(rel);
              }
            }
            break; // first matching folder wins
          }
        }
      }
    }
  }

  _cache = { map, entities: Object.fromEntries(map) };
  _cacheTime = now;
  return _cache;
}

/**
 * Resolve a single entity by name — returns { entities, services, ui }.
 * Case-insensitive. Falls back to fuzzy search if exact match fails.
 */
export async function resolveEntity(entityName) {
  const { map } = await discoverAllEntities();

  // Exact match
  const key = String(entityName).toLowerCase().trim();
  const exact = map.get(key);
  if (exact) return exact;

  // Try normalized key matching
  const nk = normalizedKey(key);
  for (const [k, v] of map) {
    if (normalizedKey(k) === nk) return v;
  }

  // Fuzzy: entity name contains the search term
  for (const [k, v] of map) {
    if (k.includes(key) || key.includes(k)) return v;
  }

  return { entities: [], services: [], ui: [] };
}

/**
 * Read full source files for one or more entity names.
 * Returns same shape as the old readSourceDirect().
 */
export async function readSourceDirect(entityNames, { uiRoot, apiRoot } = {}) {
  const { ui, api } = getRoots();
  const uiR = uiRoot || ui;
  const apiR = apiRoot || api;

  if (!uiR && !apiR) return { entities: [], services: [], ui: [], errors: ['No local roots configured'] };

  const results = { entities: [], services: [], ui: [], errors: [] };
  const seenFiles = new Set();

  for (const entityName of entityNames) {
    const paths = await resolveEntity(entityName);

    for (const relPath of paths.entities) {
      const filePath = path.join(apiR, relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.entities.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch { /* file missing on disk — skip */ }
    }

    for (const relPath of paths.services) {
      const filePath = path.join(apiR, relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.services.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch { /* skip */ }
    }

    for (const relPath of paths.ui) {
      const filePath = path.join(uiR, relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.ui.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch { /* skip */ }
    }
  }

  if (!results.entities.length && !results.ui.length) {
    results.errors.push(`No files found for: ${entityNames.join(', ')}`);
  }

  return results;
}

/**
 * Build code context from direct reads.
 * UI files are sorted: main entity form FIRST, child/tab components LAST.
 */
/**
 * Context budgets, in characters. All overridable via env.
 *
 * The previous values (8000 / 12000 / 24000) cut real target templates so hard
 * that extractModuleCapabilities() reported "no edit, no view, no delete" for
 * 5 of 6 modules — the row-action buttons sit at the bottom of a list template
 * and were always the part that got dropped. Measured across
 * currency/vat/partner/eco-tax/retail-chain/article:
 *
 *    perFile/layer/code      capabilities detected   fields found   prompt size
 *     8000/ 12000/ 24000            1 of 6                15         ~6.3k tok
 *    12000/ 30000/ 40000            5 of 6                32         ~9.5k tok
 *    16000/ 50000/ 60000            5 of 6                41        ~12.0k tok   <- default
 *    40000/150000/200000            5 of 6                68        ~19.9k tok
 *
 * Raise these if a module's form is unusually large; the `truncated` array on
 * buildDirectContext()'s result reports when a file was cut.
 */
const PER_FILE_CHARS = Number(process.env.CAPQA_PER_FILE_CHARS || 16000);
const CODE_CONTEXT_CHARS = Number(process.env.CAPQA_CONTEXT_CHARS || 60000);
const LAYER_CONTEXT_CHARS = Number(process.env.CAPQA_LAYER_CONTEXT_CHARS || 50000);

function fenceLang(file) {
  if (/\.php$/i.test(file)) return 'php';
  if (/\.html$/i.test(file)) return 'html';
  if (/\.tsx?$/i.test(file)) return 'ts';
  return '';
}

/**
 * Render one file as a chunk in the canonical format that splitCodeChunks()
 * (codeSignals.js, formSchema.js) parses:
 *
 *   [n] LABEL:: <relative/path>:<from>-<to>
 *   ```lang
 *   …source…
 *   ```
 *
 * The FULL relative path is carried so downstream list-vs-detail predicates
 * (isListChunkPath / isDetailChunkPath / rankFeaturePath) can actually fire.
 * Truncation is announced inline AND pushed onto `truncated`.
 */
function renderChunk(seq, label, item, maxChars, truncated) {
  // A literal fence inside source would end the block early.
  const safe = String(item.content || '').replace(/```/g, '~~~');
  const clipped = safe.length > maxChars;
  const body = clipped
    ? `${safe.slice(0, maxChars)}\n/* CAPQA TRUNCATED: ${safe.length - maxChars} of ${safe.length} chars omitted */`
    : safe;
  if (clipped) truncated.push({ file: item.file, keptChars: maxChars, totalChars: safe.length });
  return `[${seq}] ${label}:: ${item.file}:1-${item.lines}\n\`\`\`${fenceLang(item.file)}\n${body}\n\`\`\``;
}

/**
 * Build one context layer.
 *
 * The budget is shared FAIRLY across files rather than first-come-first-served.
 * Sequential filling used to consume the whole budget on the first one or two
 * files and drop the rest — including the list template that capability
 * detection depends on. Every file now gets a slice, so every file is visible.
 */
function buildLayer(items, budget, truncated, seqStart = 0) {
  if (!items.length) return { text: '', next: seqStart };
  const perFile = Math.max(500, Math.min(PER_FILE_CHARS, Math.floor(budget / items.length)));
  const parts = items.map((it, i) => renderChunk(seqStart + i + 1, it.label, it, perFile, truncated));
  return { text: parts.join('\n'), next: seqStart + items.length };
}

export function buildDirectContext(direct, primaryEntity) {
  const truncated = [];

  // Sort UI: entity's OWN form first, child/tab components later.
  const primaryKey = (primaryEntity || '').toLowerCase();
  const primarySlug = toSlug(primaryEntity);

  const sortedUi = [...direct.ui].sort((a, b) => {
    const aHasPrimary = primarySlug ? a.file.toLowerCase().includes(primarySlug) : a.file.toLowerCase().includes(primaryKey);
    const bHasPrimary = primarySlug ? b.file.toLowerCase().includes(primarySlug) : b.file.toLowerCase().includes(primaryKey);
    if (aHasPrimary && !bHasPrimary) return -1;
    if (!aHasPrimary && bHasPrimary) return 1;
    return b.lines - a.lines;
  });

  const entityItems = direct.entities.map((e) => ({ ...e, label: 'ENTITY' }));
  const serviceItems = direct.services.map((sv) => ({ ...sv, label: 'SERVICE' }));
  const uiItems = sortedUi.map((u, i) => ({
    ...u,
    label: i === 0 ? 'UI MAIN FORM (use this for test steps)' : 'UI CHILD / TAB',
  }));

  const all = [...entityItems, ...serviceItems, ...uiItems];

  return {
    codeContext: buildLayer(all, CODE_CONTEXT_CHARS, truncated).text,
    uiContext: buildLayer(uiItems, LAYER_CONTEXT_CHARS, truncated).text,
    apiContext: buildLayer(entityItems, LAYER_CONTEXT_CHARS, truncated).text,
    sources: [
      ...direct.entities.map(e => e.file),
      ...direct.services.map(s => s.file),
      ...direct.ui.map(u => u.file),
    ],
    /**
     * Non-empty when source was cut. Surface this instead of letting the prompt
     * and the UI both claim the files were read in full.
     */
    truncated: dedupeTruncation(truncated),
  };
}

function dedupeTruncation(list) {
  const worst = new Map();
  for (const t of list) {
    const prev = worst.get(t.file);
    if (!prev || t.keptChars < prev.keptChars) worst.set(t.file, t);
  }
  return [...worst.values()];
}

/** Get list of all known entity names (lowercase keys). */
export async function listEntityNames() {
  const { map } = await discoverAllEntities();
  return [...map.keys()];
}

/** Invalidate cache — call after a target deploy. */
export function invalidateCache() {
  _cache = null;
  _cacheTime = 0;
}
