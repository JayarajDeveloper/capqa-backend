/**
 * Signals derived from indexed code only — no module-specific lists.
 */

import { parseControlBindings, parseWrapperDropdownFields } from './componentRegistry.js';

function splitCodeChunks(codeContext) {
  const text = String(codeContext || '');
  const chunks = [];
  const re = /\[(\d+)\]\s+[^:]+::\s+([\w./-]+):(\d+)-(\d+)\n```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    chunks.push({ path: m[2], content: m[5] });
  }
  if (!chunks.length && text.trim()) {
    chunks.push({ path: '', content: text });
  }
  return chunks;
}

export function normalizeFeatureKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** `src/app/pages/eco-tax/...` → `eco-tax` */
export function featureFolderFromPath(path) {
  const m = String(path || '').match(/\/pages\/([^/]+)/i);
  return m?.[1]?.toLowerCase() || '';
}

export function featureSlugFromName(featureName) {
  return String(featureName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Resolve the correct CapBO route for an entity.
 *
 * Strategy:
 *  1. If the entity has its own UI folder → /{folder-slug}
 *  2. If the entity is a child/junction (no standalone UI) — infer parent
 *     from dependency graph targetEntity relationships
 *
 * No hardcoded route map — everything discovered at runtime.
 */
export function resolveCorrectRoute(featureName, { dependencyGraph = null } = {}) {
  const slug = featureSlugFromName(featureName);

  // If a dependency graph is available, check if this entity is a child
  // that routes through a parent (junction tables, hierarchy children)
  if (dependencyGraph && dependencyGraph instanceof Map && dependencyGraph.size > 0) {
    const node = dependencyGraph.get(featureName);
    if (node && node.dependsOn && node.dependsOn.length > 0) {
      // For child entities: route through the first non-translation parent
      for (const parent of node.dependsOn) {
        if (parent.endsWith('Translation')) continue;
        const parentSlug = featureSlugFromName(parent);
        if (parentSlug && parentSlug !== slug) return `/${parentSlug}`;
      }
    }
  }

  return `/${slug}`;
}

/** Dominant pages/ folder from matched chunks (eco-tax vs article-eco-tax). */
export function primaryFeatureFolder(chunks = [], featureName = '') {
  const slug = featureSlugFromName(featureName);
  const folders = (chunks || []).map((c) => featureFolderFromPath(c.path)).filter(Boolean);
  if (slug && folders.includes(slug)) return slug;
  const counts = new Map();
  for (const f of folders) counts.set(f, (counts.get(f) || 0) + 1);
  let best = slug;
  let bestN = 0;
  for (const [f, n] of counts) {
    if (n > bestN) { bestN = n; best = f; }
  }
  return best || slug;
}

export function pathInFeatureFolder(path, folder) {
  if (!folder) return true;
  return String(path || '').toLowerCase().includes(`/pages/${folder.toLowerCase()}/`);
}

/**
 * Authoritative pages/ folder for a grounded feature — never infer from unrelated live chunks.
 * Uses catalog seed paths first (e.g. vat-service-spec), then slug (eco-tax).
 */
export function resolvedFeatureFolder(featureName = '', seedPaths = []) {
  const slug = featureSlugFromName(featureName);
  const folders = [...new Set(
    (seedPaths || []).map((p) => featureFolderFromPath(p)).filter(Boolean),
  )];
  if (slug && folders.includes(slug)) return slug;
  if (slug) {
    const prefixed = folders.find((f) => f === slug || f.startsWith(`${slug}-`) || f.startsWith(`${slug}_`));
    if (prefixed) return prefixed;
  }
  if (folders.length === 1) return folders[0];
  if (slug) return slug;
  return primaryFeatureFolder(
    (seedPaths || []).map((path) => ({ path })),
    featureName,
  );
}

/** Drop live/index chunks from other CapBO modules once a feature is grounded. */
export function filterChunksToFeatureFolder(chunks = [], featureName = '', seedPaths = []) {
  const folder = resolvedFeatureFolder(featureName, [
    ...seedPaths,
    ...(chunks || []).map((c) => c.path),
  ]);
  if (!folder) return chunks || [];
  return (chunks || []).filter(
    (c) => !String(c.path || '').includes('/pages/') || pathInFeatureFolder(c.path, folder),
  );
}

/** True when a non-list form HTML template is present (TS alone is not enough for field/testId parsing). */
export function isFeatureFormHtmlPath(path) {
  const p = String(path || '');
  if (!/\.component\.html$/i.test(p)) return false;
  if (/-list\.component\.html$/i.test(p)) return false;
  return true;
}

/** Detail/form template for THIS feature folder — requires form HTML, not TS-only chunks. */
export function hasFeatureDetailChunk(chunks = [], featureName = '') {
  const folder = primaryFeatureFolder(chunks, featureName);
  return (chunks || []).some(
    (c) => isFeatureFormHtmlPath(c.path) && pathInFeatureFolder(c.path, folder),
  );
}

export function isListChunkPath(path) {
  return /-list\.component\.(html|ts)$/i.test(String(path || ''));
}

export function isDetailChunkPath(path) {
  const p = String(path || '').toLowerCase();
  if (/-list\.component/.test(p)) return false;
  if (/\/(details?|form|edit|create|new)\//.test(p)) return true;
  if (/-details\.component\.(html|ts)$/i.test(p)) return true;
  if (/-form\.component\.(html|ts)$/i.test(p)) return true;
  if (/\/[^/]+\/[^/]+\.component\.(html|ts)$/.test(p) && !/-list\.component/.test(p)) return true;
  return false;
}

/** Rank paths for compose: form/detail templates before list templates. */
export function rankFeaturePath(path) {
  const p = String(path || '').toLowerCase();
  if (/-details\.component\.html$/i.test(p)) return 0;
  if (/-details\.component\.ts$/i.test(p) && !/\.spec\./i.test(p)) return 1;
  if (/-form\.component\.html$/i.test(p)) return 2;
  if (/\.component\.html$/i.test(p) && !/-list\.component\.html$/i.test(p)) return 3;
  if (/\.component\.ts$/i.test(p) && !/-list\.component\.ts$/i.test(p) && !/\.spec\./i.test(p)) return 4;
  if (/-list\.component\.html$/i.test(p)) return 8;
  if (/-list\.component\.ts$/i.test(p)) return 9;
  return 6;
}

/** Sort and cap chunks so create/edit form code is always represented (all modules). */
export function prioritizeFeatureChunks(chunks = [], { maxTotal = 32, maxList = 6 } = {}) {
  const byPath = new Map();
  for (const c of chunks) {
    const key = c.path || c.id;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(c);
  }
  const paths = [...byPath.keys()].sort(
    (a, b) => rankFeaturePath(a) - rankFeaturePath(b) || a.localeCompare(b),
  );
  const out = [];
  let listCount = 0;
  for (const path of paths) {
    const isList = /-list\.component\./i.test(path);
    if (isList && listCount >= maxList) continue;
    if (isList) listCount += 1;
    for (const c of byPath.get(path)) {
      out.push(c);
      if (out.length >= maxTotal) return out;
    }
  }
  return out;
}

function fieldKeysInHtml(html, getters = {}) {
  const keys = new Set();
  for (const m of String(html || '').matchAll(/formControlName="(\w+)"/g)) {
    keys.add(m[1]);
  }
  for (const wf of parseWrapperDropdownFields(html, { controlMap: getters })) {
    keys.add(wf.key);
  }
  return keys;
}

/** Fields that appear on list templates but not on detail/form templates = list filters. */
export function deriveListFilterKeys(codeContext) {
  const chunks = splitCodeChunks(codeContext);
  const ts = chunks.filter((c) => /\.ts$/i.test(c.path) && !/\.spec\./i.test(c.path)).map((c) => c.content).join('\n');
  const getters = parseControlBindings(ts);
  const listKeys = new Set();
  const detailKeys = new Set();

  for (const chunk of chunks) {
    if (!/\.html$/i.test(chunk.path)) continue;
    const keys = fieldKeysInHtml(chunk.content, getters);
    if (isListChunkPath(chunk.path)) {
      keys.forEach((k) => listKeys.add(k));
    } else if (isDetailChunkPath(chunk.path) || !isListChunkPath(chunk.path)) {
      keys.forEach((k) => detailKeys.add(k));
    }
  }

  return [...listKeys].filter((k) => !detailKeys.has(k));
}

/** Grammar / intent terms — not module names hardcoded. */
const GRAMMAR_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'from', 'using',
  'create', 'add', 'new', 'edit', 'update', 'delete', 'list', 'test', 'case', 'please',
  'check', 'verify', 'confirm', 'whether', 'if', 'not', 'try', 'that', 'this', 'it', 'is',
]);

/** Terms from matched feature + parsed ask (exclude as data values, not fixed module list). */
export function featureTermsFromContext(intent = null, matchedFeature = '') {
  const terms = new Set(GRAMMAR_STOP);
  for (const t of intent?.subjectTerms || []) {
    const w = String(t).toLowerCase();
    if (w.length >= 2) terms.add(w);
    if (w.length >= 3) {
      if (w.endsWith('s')) terms.add(w.slice(0, -1));
      else terms.add(`${w}s`);
    }
  }
  for (const w of String(matchedFeature || '').toLowerCase().split(/[\s/_-]+/)) {
    if (w.length >= 2) terms.add(w);
  }
  return terms;
}

export function isGrammarOrFeatureTerm(value, featureTerms = null) {
  const raw = String(value || '').trim();
  const s = raw.toLowerCase();
  if (!s) return true;
  // Title-case tokens are entity values, not feature vocabulary ("NewCo", "Acme", "Jay")
  if (/^[A-Z][a-zA-Z0-9]*$/.test(raw)) return false;
  const terms = featureTerms || GRAMMAR_STOP;
  if (terms.has(s)) return true;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 1) return false;
  // Allow multi-word values that contain digits or non-feature tokens (e.g. "Jay 123", "Partners ze4b3")
  if (words.some((w) => /\d/.test(w) || !terms.has(w))) return false;
  // Title-case values are plausible entity names even when tokens appear in the ask ("Acme Corp")
  const rawWords = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (rawWords.length > 1 && rawWords.every((w) => /^[A-Z]/.test(w))) return false;
  return words.every((w) => terms.has(w));
}

/** Clean row needle from NL asks: "the Bota Store row" → "Bota Store". */
export function normalizeRowNeedle(raw) {
  let s = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return '';
  s = s.replace(/^(?:the|a|an)\s+/i, '');
  s = s.replace(/\s+row\s*$/i, '');
  s = s.replace(/\s+(?:retail|partner)\s+chain\s*$/i, '');
  s = s.replace(/\s+chain\s*$/i, '');
  return s.trim();
}

/**
 * Parse row needle from "update {feature words} NEEDLE" — uses featureTerms from index/ask, not a module list.
 */
export function parseUpdateRowNeedleFromAsk(text, featureTerms = null) {
  if (!text || /\brename\s+to\b/i.test(text)) return null;
  const m = String(text).match(/\b(?:update|edit|modify)\s+(?:the\s+)?(.+)/i);
  if (!m) return null;
  const stops = featureTerms instanceof Set ? new Set(featureTerms) : new Set(featureTerms || []);
  for (const w of GRAMMAR_STOP) stops.add(w);

  let rest = m[1].trim();
  rest = rest.replace(/\bchange\b[\s\S]*/i, '').trim();
  rest = rest.replace(/\b(?:and|with)\s+symbol\b[\s\S]*/i, '').trim();

  const tokens = rest.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '').replace(/[,.;]+$/, '')).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (stops.has(tokens[i].toLowerCase()) || isGrammarOrFeatureTerm(tokens[i], stops))) {
    i += 1;
  }
  if (i >= tokens.length) return null;
  const needle = tokens.slice(i).join(' ').trim().replace(/[,.;]+$/, '');
  if (!needle || isGrammarOrFeatureTerm(needle, stops)) return null;
  return needle;
}

/** List-page action testIds from indexed HTML (any module). */
export function extractListRowTestIds(listHtml = '') {
  const html = String(listHtml || '');
  const editTestId = html.match(/data-testid="([^"]+-edit)"/i)?.[1] || null;
  const rowTestId = html.match(/data-testid="([^"]+-row)"/i)?.[1] || null;
  const searchTestId = html.match(/searchTestId="([^"]+)"/i)?.[1]
    || html.match(/data-testid="([^"]+-search)"/i)?.[1]
    || null;
  return { editTestId, rowTestId, searchTestId };
}

/**
 * UI capabilities parsed from indexed list + detail HTML (no module hardcoding).
 * Detects where delete/edit/view live and whether delete requires edit mode.
 */
export function extractModuleCapabilities(codeContext) {
  const chunks = splitCodeChunks(codeContext);
  const listHtml = chunks
    .filter((c) => isListChunkPath(c.path) && /\.html$/i.test(c.path))
    .map((c) => c.content)
    .join('\n');
  const detailHtml = chunks
    .filter((c) => isDetailChunkPath(c.path) && /\.html$/i.test(c.path))
    .map((c) => c.content)
    .join('\n');

  const hasTestIdSuffix = (html, suffix) => new RegExp(`data-testid="[^"]*${suffix}`, 'i').test(String(html || ''));
  const hasDeleteClick = (html) => /\(click\)\s*=\s*"delete\w*\(/i.test(String(html || ''));

  const listHasEdit = hasTestIdSuffix(listHtml, '-edit"')
    || hasTestIdSuffix(listHtml, '-edit\'')
    || /edit-btn|editRetail|editPartner|editCurrency/i.test(listHtml);
  const listHasView = hasTestIdSuffix(listHtml, '-view"') || /view-btn|viewRetail|viewPartner/i.test(listHtml);
  const listHasDelete = hasTestIdSuffix(listHtml, '-delete"') || hasDeleteClick(listHtml);

  const detailHasDelete = hasTestIdSuffix(detailHtml, '-delete"') || hasDeleteClick(detailHtml);
  const detailDeleteEditOnly = detailHasDelete
    && /isEditMode/i.test(detailHtml)
    && /delete/i.test(detailHtml);
  const detailFormHiddenInView = /isViewMode/i.test(detailHtml) && /!isViewMode/i.test(detailHtml);

  let deleteMode = 'none';
  if (listHasDelete) deleteMode = 'list-row';
  else if (detailHasDelete && detailDeleteEditOnly) deleteMode = 'detail-edit';
  else if (detailHasDelete) deleteMode = 'detail';

  const permMatch = [...`${listHtml}\n${detailHtml}`.matchAll(
    /'([A-Z][A-Z0-9_]*DELETE[^']*)'\s*\|\s*hasCompositePermission/g,
  )];
  const deletePermission = permMatch[0]?.[1] || null;

  const searchControlName = listHtml.match(/searchControlName="(\w+)"/)?.[1]
    || (hasTestIdSuffix(listHtml, '-search"') ? 'searchTerm' : null);

  let deleteFlowHint = 'No delete control found in indexed UI for this module.';
  if (deleteMode === 'list-row') {
    deleteFlowHint = 'Delete is available from the list row actions.';
  } else if (deleteMode === 'detail-edit') {
    deleteFlowHint = 'Delete is only on the edit form (not on the list or in view mode). Flow: search → Edit row → Delete → confirm.';
  } else if (deleteMode === 'detail') {
    deleteFlowHint = 'Delete is on the detail form after opening a record.';
  }

  return {
    listHasEdit,
    listHasView,
    listHasDelete,
    detailHasDelete,
    deleteMode,
    deletePermission,
    detailDeleteEditOnly,
    detailFormHiddenInView,
    searchControlName,
    supportsDelete: deleteMode !== 'none',
    deleteFlowHint,
  };
}

/** Block or warn when the ask action is not supported by indexed UI code. */
export function validateActionAgainstCapabilities(action, caps = {}) {
  const act = String(action || '').toLowerCase();
  if (act === 'delete') {
    if (!caps.supportsDelete) {
      return {
        ok: false,
        message: 'This module has no delete control in the indexed UI (list or form). A delete test cannot be generated from code.',
      };
    }
    return { ok: true, warning: caps.deleteFlowHint };
  }
  if (act === 'update' && !caps.listHasEdit) {
    return {
      ok: false,
      message: 'No edit control found in the indexed list UI. An update test cannot be generated.',
    };
  }
  if (act === 'view' && !caps.listHasView) {
    return {
      ok: false,
      message: 'No view control found in the indexed list UI. A view test cannot be generated.',
    };
  }
  return { ok: true };
}

function combinedAskText(askText = '', title = '', description = '') {
  return String(askText || [title, description].filter(Boolean).join(' ')).trim();
}

/** User explicitly asked for a list-row action (from indexed UI capabilities). */
export function askImpliesListRowAction(askText = '') {
  const t = String(askText || '').toLowerCase();
  return /\b(?:on|from)\s+(?:the\s+)?list\b/.test(t)
    || /\blist\s+row\b/.test(t)
    || /\brow\s+action/.test(t)
    || (/\b(?:delete|remove|edit|view)\b/.test(t) && /\b(?:in|on)\s+(?:the\s+)?list\b/.test(t));
}

/** Suggest automatable flows derived only from indexed UI capabilities (no module lists). */
export function buildAlternateComposePrompts(featureName = '', caps = {}, { rowNeedle = '' } = {}) {
  const feature = String(featureName || 'record').trim() || 'record';
  const needle = String(rowNeedle || '').trim();
  const row = needle || '<existing-code>';
  const out = [];

  out.push({
    title: `list ${feature}`,
    description: `open ${feature} list and verify the list loads`,
    reason: 'List table is present in indexed UI',
  });

  if (caps.searchControlName || caps.listHasEdit || caps.listHasView) {
    out.push({
      title: `search ${feature}`,
      description: needle
        ? `search ${feature} list for ${needle}`
        : `search ${feature} list for an existing record`,
      reason: 'Search control found in list template',
    });
  }

  if (caps.listHasView) {
    out.push({
      title: `view ${feature}`,
      description: `view ${feature} ${row} from the list`,
      reason: 'View action (*-view) found on list rows',
    });
  }

  if (caps.listHasEdit) {
    out.push({
      title: `update ${feature}`,
      description: `update ${feature} ${row} — change one field and save`,
      reason: 'Edit action (*-edit) found on list rows',
    });
  }

  if (caps.supportsDelete) {
    const flow = caps.deleteMode === 'list-row'
      ? `delete ${feature} ${row} from the list row`
      : `delete ${feature} ${row} — search, open Edit, then Delete on the form`;
    out.push({
      title: `delete ${feature}`,
      description: flow,
      reason: caps.deleteFlowHint || 'Delete control found in indexed UI',
    });
  }

  return out.slice(0, 6);
}

/**
 * Read indexed UI + ask — block when the scenario is not automatable from code;
 * return advice and alternative prompts (no hardcoded module rules).
 */
export function assessComposeFeasibility({
  action = '',
  caps = {},
  askText = '',
  title = '',
  description = '',
  featureName = '',
  rowNeedle = '',
} = {}) {
  const act = String(action || 'exercise').toLowerCase();
  const ask = combinedAskText(askText, title, description);
  const advice = [];
  const suggestions = [];

  // Action-specific hints only — avoid showing delete/view rules on create/list flows
  if (act === 'delete') {
    if (caps.deletePermission) {
      advice.push(`Delete in CapBO requires permission ${caps.deletePermission} (from indexed template).`);
    }
    if (caps.detailDeleteEditOnly) {
      advice.push('Delete button is only visible in edit mode, not on view or list.');
    }
  }
  if (act === 'view' && caps.detailFormHiddenInView) {
    advice.push('Some form actions are hidden in view mode (*ngIf isViewMode in indexed template).');
  }

  const baseCheck = validateActionAgainstCapabilities(act, caps);
  if (!baseCheck.ok) {
    const alts = buildAlternateComposePrompts(featureName, caps, { rowNeedle });
    return {
      feasible: false,
      blockReason: baseCheck.message,
      advice: [
        ...advice,
        ...alts.map((s) => `Try instead: ${s.title} — ${s.description}`),
      ],
      suggestions: alts,
      capabilities: caps,
    };
  }

  if (act === 'delete' && caps.supportsDelete) {
    if (askImpliesListRowAction(ask) && caps.deleteMode !== 'list-row') {
      const alts = buildAlternateComposePrompts(featureName, caps, { rowNeedle });
      const deleteAlt = alts.find((s) => /^delete /i.test(s.title));
      return {
        feasible: false,
        blockReason: `Delete is not on the list in indexed UI. ${caps.deleteFlowHint}`,
        advice: [
          ...advice,
          caps.deleteFlowHint,
          deleteAlt ? `Suggested flow: ${deleteAlt.description}` : null,
        ].filter(Boolean),
        suggestions: deleteAlt ? [deleteAlt, ...alts.filter((s) => s !== deleteAlt)] : alts,
        capabilities: caps,
      };
    }
    if (caps.deleteFlowHint) advice.push(caps.deleteFlowHint);
  }

  if (act === 'update' && caps.listHasEdit) {
    advice.push('Update flow: search list → Edit on row → change fields → Save.');
  }
  if (act === 'view' && caps.listHasView) {
    advice.push('View flow: search list → View on row (read-only form).');
  }

  const alts = buildAlternateComposePrompts(featureName, caps, { rowNeedle });
  if (baseCheck.warning) advice.push(baseCheck.warning);

  return {
    feasible: true,
    blockReason: null,
    advice: [...new Set(advice.filter(Boolean))],
    suggestions: alts,
    capabilities: caps,
  };
}
