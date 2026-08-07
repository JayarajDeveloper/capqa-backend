/**
 * Capability Index — everything the engine knows about a target application,
 * derived from that application's own source at runtime.
 *
 * This exists to replace hardcoded per-module tables (the module -> API path and
 * module -> required-field maps that used to live in codegen.js). Nothing here
 * names a module, a field, or a route: the shapes come from the selected target
 * adapter, and the values come from the target's files.
 *
 * Every fact carries `source` as "<relative/path>:<line>" so a generated test can
 * cite why it believes something.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { targetAdapter } from '../../adapters/index.js';
import { parseEntityProperties } from '../rag/allRules.js';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

async function listDirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}
async function listFiles(dir, ext = '.php') {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(ext)).map((d) => d.name);
  } catch { return []; }
}
const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return ''; } };

/** PascalCase feature dir -> kebab module id (Currency -> currency, RetailChain -> retail-chain). */
export function moduleIdFromFeatureDir(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Controller routes. Symfony declares the collection path on the class and each
 * operation as a suffix on the method, so the pair yields a full operation map.
 */
function parseControllerRoutes(text, relPath) {
  const classRoute = text.match(/#\[Route\(\s*'([^']*)'[^)]*\)\]\s*(?:final\s+)?class\s/);
  const basePath = classRoute?.[1] || null;
  const base = { path: basePath, source: basePath ? `${relPath}:${lineOf(text, classRoute.index)}` : null };

  const operations = [];
  for (const m of text.matchAll(/#\[Route\(\s*'([^']*)'((?:[^)\]]|\[[^\]]*\])*)\)\]/g)) {
    const [, suffix, rest] = m;
    if (!/methods:/.test(rest)) continue;                       // class-level route has no methods
    const name = rest.match(/name:\s*'([^']+)'/)?.[1] || null;
    const methods = [...rest.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]);
    operations.push({
      name,
      methods,
      path: `${basePath || ''}${suffix}`,
      source: `${relPath}:${lineOf(text, m.index)}`,
    });
  }
  return { base, operations };
}

/** API Platform resources declare their own paths via uriTemplate. */
function parseApiResourcePaths(text, relPath) {
  const out = [];
  for (const m of text.matchAll(/uriTemplate:\s*'([^']+)'/g)) {
    out.push({ path: m[1], source: `${relPath}:${lineOf(text, m.index)}` });
  }
  return out;
}

/** Entity properties -> field facts, with the constraint metadata a test needs. */
/**
 * Properties assigned inside a lifecycle callback are set by the framework, not by
 * the client. Derived by reading the callbacks — not by guessing from field names.
 */
function lifecycleManagedProps(text) {
  const managed = new Set();
  for (const m of text.matchAll(/#\[ORM\\(?:PrePersist|PreUpdate)\]([\s\S]{0,400}?)\n\s*\}/g)) {
    for (const a of m[1].matchAll(/\$this->(\w+)\s*=/g)) managed.add(a[1]);
  }
  // Properties initialised by the entity's own constructor are equally not client input.
  const ctor = text.match(/function\s+__construct\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  if (ctor) for (const a of ctor[1].matchAll(/\$this->(\w+)\s*=/g)) managed.add(a[1]);
  return managed;
}

function fieldsFromEntity(text, relPath) {
  const fields = [];
  const managed = lifecycleManagedProps(text);
  for (const prop of parseEntityProperties(text)) {
    const blob = prop.attrs.join('\n');
    const col = blob.match(/#\[ORM\\Column\s*\(([\s\S]*?)\)\s*\]/);
    const asserts = [...blob.matchAll(/#\[Assert\\(\w+)([^\]]*)\]/g)].map((a) => ({ type: a[1], args: a[2] }));
    const relation = /#\[ORM\\(ManyToOne|OneToMany|ManyToMany|OneToOne)/.exec(blob)?.[1] || null;

    // Doctrine defaults nullable to FALSE when the option is omitted, so absence of
    // `nullable:` means required. Reading only explicit `nullable: false` silently
    // marked whole entities optional (Ecotax declares no nullable: and no Assert).
    const join = blob.match(/#\[ORM\\JoinColumn\s*\(([\s\S]*?)\)\s*\]/);
    const mapping = col?.[1] ?? join?.[1] ?? null;
    const isGenerated = /#\[ORM\\GeneratedValue/.test(blob);
    const isCollection = /Collection\s+\$/.test(prop.decl || '') || /#\[ORM\\(OneToMany|ManyToMany)/.test(blob);
    const required = !isGenerated && !isCollection && (
      asserts.some((a) => a.type === 'NotBlank' || a.type === 'NotNull')
      || (mapping !== null && !/nullable:\s*true/.test(mapping))
    );

    // The wire name can differ from the PHP property (displayLabel -> display_label,
    // $vat -> vat_id). Read it from the mapping rather than transforming the name.
    const columnName = (col?.[1] || join?.[1] || '').match(/name:\s*'([^']+)'/)?.[1] || null;
    const hasDefault = /=\s*[^;]+;/.test(prop.decl || '');
    const framework = isGenerated || managed.has(prop.name);

    const idx = text.indexOf(`$${prop.name}`);
    fields.push({
      id: `f.${prop.name}`,
      name: prop.name,
      wireName: columnName || prop.name,
      kind: relation ? 'relation' : 'scalar',
      relation,
      required: required && !framework,
      hasDefault,
      frameworkManaged: framework,
      constraints: {
        unique: /unique:\s*true/.test(col?.[1] || '') || undefined,
        maxLength: col?.[1]?.match(/length:\s*(\d+)/)?.[1] ? Number(col[1].match(/length:\s*(\d+)/)[1]) : undefined,
        pattern: asserts.find((a) => a.type === 'Regex')?.args.match(/pattern:\s*'([^']+)'/)?.[1],
        asserts: asserts.map((a) => a.type),
      },
      source: idx >= 0 ? `${relPath}:${lineOf(text, idx)}` : relPath,
    });
  }
  return fields;
}

/**
 * Build the index for every module the target exposes.
 * Pure filesystem reads — no DB, no network, safe to run in CI.
 */
/**
 * The framework mounts resource routes under a prefix declared in config, not in
 * the attributes. Read it rather than assuming '/api'.
 */
async function readRoutePrefix(apiRoot) {
  const text = await read(path.join(apiRoot || '', 'config', 'routes', 'api_platform.yaml'));
  const m = text.match(/^\s*prefix:\s*(\S+)\s*$/m);
  return m ? m[1].replace(/\/+$/, '') : '';
}

export async function buildCapabilityIndex({ apiRoot, uiRoot } = {}) {
  const A = targetAdapter;
  const featuresDir = path.join(apiRoot || '', ...A.layout.apiFeaturesDir);
  const routePrefix = await readRoutePrefix(apiRoot);
  const modules = {};

  for (const featureDir of await listDirs(featuresDir)) {
    const moduleId = moduleIdFromFeatureDir(featureDir);
    const mod = {
      moduleId,
      featureDir,
      aliases: [...new Set([moduleId, moduleId.replace(/-/g, ''), featureDir, `${moduleId}s`])],
      api: { collectionPath: null, source: null, operations: [] },
      fields: [],
      ui: { templates: [] },
    };

    // ── Controllers -> routes ────────────────────────────────────────────────
    const ctrlDir = path.join(featuresDir, featureDir, 'Controller');
    for (const f of await listFiles(ctrlDir)) {
      const rel = path.join('src', ...A.layout.apiFeaturesDir.slice(1), featureDir, 'Controller', f);
      const text = await read(path.join(ctrlDir, f));
      const { base, operations } = parseControllerRoutes(text, rel);
      if (!base.path) continue;
      // The module's primary collection is the shortest base path among its controllers.
      if (!mod.api.collectionPath || base.path.length < mod.api.collectionPath.length) {
        mod.api.collectionPath = base.path;
        mod.api.source = base.source;
      }
      mod.api.operations.push(...operations.map((o) => ({ ...o, base: base.path })));
    }

    // ── Entities -> fields (+ ApiResource paths when there is no controller) ──
    const entDir = path.join(featuresDir, featureDir, A.layout.apiEntityDir);
    for (const f of await listFiles(entDir)) {
      const rel = path.join('src', ...A.layout.apiFeaturesDir.slice(1), featureDir, A.layout.apiEntityDir, f);
      const text = await read(path.join(entDir, f));
      // Primary entity = the one named after the feature; others are children.
      if (f.replace('.php', '').toLowerCase() === featureDir.toLowerCase()) {
        mod.fields = fieldsFromEntity(text, rel);
      }
      if (!mod.api.collectionPath) {
        // Shortest uriTemplate is the collection root; the first one may be a sub-resource
        // (Vat declares '/vats/locale' before '/vats').
        const best = parseApiResourcePaths(text, rel)
          .filter((r) => !/\{/.test(r.path))
          .sort((a, b) => a.path.length - b.path.length)[0];
        if (best) { mod.api.collectionPath = best.path; mod.api.source = best.source; }
      }
    }

    // Drop operations belonging to a sibling/child controller (Partner's feature dir
    // also holds ArticlePartnerController, whose POST is not Partner's create).
    mod.api.operations = mod.api.operations.filter((o) => !o.base || o.base === mod.api.collectionPath);

    if (routePrefix && mod.api.collectionPath && !mod.api.collectionPath.startsWith(routePrefix)) {
      mod.api.collectionPath = routePrefix + mod.api.collectionPath;
      mod.api.operations = mod.api.operations.map((o) => ({ ...o, path: routePrefix + o.path }));
    }

    if (mod.api.collectionPath || mod.fields.length) modules[moduleId] = mod;
  }

  return { adapter: A.id, modules };
}

/** Required field NAMES for a module — replaces the hardcoded per-module table. */
/**
 * Field names a CREATE payload must carry — replaces the hardcoded per-module table.
 * Framework-managed and defaulted fields are excluded: the client does not send them.
 * `wire: true` returns the serialized names (display_label, vat_id).
 */
export function requiredFieldNames(mod, { includeRelations = true, includeDefaulted = false, wire = false } = {}) {
  return (mod?.fields || [])
    .filter((f) => f.required && !f.frameworkManaged)
    .filter((f) => includeDefaulted || !f.hasDefault)
    .filter((f) => includeRelations || f.kind !== 'relation')
    .map((f) => (wire ? f.wireName : f.name));
}

/** The POST/create operation for a module, if it exposes one. */
export function createOperation(mod) {
  return (mod?.api?.operations || []).find((o) => o.methods?.includes('POST')) || null;
}

// ── Cached accessor ──────────────────────────────────────────────────────────
// The compose route needs this synchronously deep inside codegen, so it is built
// once per process (TTL-refreshed) and threaded down as a plain object.

let _cache = null;
let _cacheKey = '';
let _cacheAt = 0;
const TTL_MS = Number(process.env.CAPQA_INDEX_TTL_MS || 5 * 60_000);

/** Build (or reuse) the index for the configured target roots. */
export async function getCapabilityIndex({ apiRoot, uiRoot, now = Date.now() } = {}) {
  const key = `${apiRoot}|${uiRoot}`;
  if (_cache && _cacheKey === key && now - _cacheAt < TTL_MS) return _cache;
  _cache = await buildCapabilityIndex({ apiRoot, uiRoot });
  _cacheKey = key;
  _cacheAt = now;
  return _cache;
}

/** Drop the cache — call after the target is redeployed or its source changes. */
export function invalidateCapabilityIndex() { _cache = null; _cacheKey = ''; _cacheAt = 0; }

/**
 * Resolve a module entry by any of the names the intent parser might produce.
 * Matching is on the index's own derived aliases — no name table here.
 */
export function findModule(index, name) {
  if (!index?.modules || !name) return null;
  const want = String(name).toLowerCase().replace(/[\s_]+/g, '-');
  const flat = want.replace(/-/g, '');
  for (const mod of Object.values(index.modules)) {
    for (const a of mod.aliases || []) {
      const al = String(a).toLowerCase();
      if (al === want || al.replace(/-/g, '') === flat) return mod;
    }
  }
  // Fall back to the API collection path's last segment (…/retail-chains -> retail-chains)
  for (const mod of Object.values(index.modules)) {
    const seg = String(mod.api?.collectionPath || '').split('/').filter(Boolean).pop();
    if (seg && (seg === want || seg.replace(/-/g, '') === flat)) return mod;
  }
  return null;
}
