/**
 * Extract structured form schema from indexed UI code and resolve test values
 * (description overrides + business-rule defaults for required fields).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseControlBindings,
  parseStandaloneSyncMap,
  parseFormGroupFieldKeys,
  parseWrapperDropdownFields,
  resolveControlVarToFieldKey,
  inferNativeFieldMeta,
  isAutomatableField,
  interactionKindForField,
} from './componentRegistry.js';
import {
  deriveListFilterKeys,
  isDetailChunkPath,
  isListChunkPath,
  prioritizeFeatureChunks,
  rankFeaturePath,
} from './codeSignals.js';
import { pickIdentityFieldFromSchema } from './askAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPBO_I18N_DIR = path.resolve(__dirname, '../../../../capbo-frontend/src/assets/i18n');
/** English catalog only — used to derive list-search field keys (code, name, …). */
const I18N_SEARCH_FILE = path.join(CAPBO_I18N_DIR, 'en-GB.json');

let i18nCache = null;

function loadI18nCatalog() {
  if (i18nCache) return i18nCache;
  i18nCache = {};
  try {
    if (fs.existsSync(I18N_SEARCH_FILE)) {
      Object.assign(i18nCache, JSON.parse(fs.readFileSync(I18N_SEARCH_FILE, 'utf8')));
    }
  } catch { /* ignore */ }
  return i18nCache;
}

function resolveI18nString(key) {
  if (!key || !key.includes('.')) return '';
  const catalog = loadI18nCatalog();
  const parts = key.split('.');
  let node = catalog;
  for (const p of parts) {
    node = node?.[p];
    if (node == null) return '';
  }
  return typeof node === 'string' ? node : '';
}

/** Parse "Search by code, name or value" → ['code', 'name', 'value']. */
export function parseSearchableTermsFromPlaceholder(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const m = raw.match(/(?:search|rechercher)\s+(?:by|par)\s+(.+)/i);
  const tail = m ? m[1] : raw;
  return tail
    .split(/\s*,\s*|\s+or\s+|\s+ou\s+/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** List search metadata from list HTML + i18n placeholder (drives verify/search needle). */
export function parseListSearchMeta(codeContext) {
  const chunks = splitCodeChunks(codeContext);
  const listHtml = chunks.filter((c) => isListChunk(c.path)).map((c) => c.content).join('\n');
  if (!listHtml) return null;

  const placeholderKey = listHtml.match(/\[searchPlaceholder\]="'([^']+)'\s*\|\s*translate"/)?.[1]
    || listHtml.match(/searchPlaceholder]="([^"]+)"/)?.[1]
    || null;
  const searchTestId = listHtml.match(/searchTestId="([^"]+)"/)?.[1] || null;
  const placeholderText = placeholderKey ? resolveI18nString(placeholderKey) : '';
  let searchableTerms = parseSearchableTermsFromPlaceholder(placeholderText);

  if (!searchableTerms.length) {
    searchableTerms = [...listHtml.matchAll(/matColumnDef="(\w+)"/g)].map((m) => m[1].toLowerCase());
  }

  return {
    placeholderKey,
    placeholderText,
    searchableTerms,
    searchTestId,
  };
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** List-only fields from indexed HTML (not a fixed key list). */
export function isFilterFieldKey(key, filterKeys = []) {
  if (!key) return false;
  return (filterKeys || []).includes(key);
}

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

function isDetailChunk(path) {
  return isDetailChunkPath(path);
}

function isListChunk(path) {
  return isListChunkPath(path);
}

function parseControlGetters(text) {
  return parseControlBindings(text);
}

function parseValidatorBlock(block) {
  const v = { required: /Validators\.required/.test(block) };
  const minLen = block.match(/Validators\.minLength\((\d+)\)/);
  const maxLen = block.match(/Validators\.maxLength\((\d+)\)/);
  const min = block.match(/Validators\.min\(([^)]+)\)/);
  const max = block.match(/Validators\.max\(([^)]+)\)/);
  const pat = block.match(/Validators\.pattern\(\s*['"]([^'"]+)['"]\s*\)/);
  if (minLen) v.minLength = Number(minLen[1]);
  if (maxLen) v.maxLength = Number(maxLen[1]);
  if (min) v.min = Number(min[1]);
  if (max) v.max = Number(max[1]);
  if (/Validators\.email|EMAIL_PATTERN/.test(block)) v.email = true;
  if (pat) {
    v.pattern = true;
    v.patternRegex = pat[1];
  } else if (/Validators\.pattern/.test(block)) {
    v.pattern = true;
  }
  return v;
}

function extractBalancedBraces(src, openBraceIndex) {
  let depth = 0;
  let body = '';
  for (let i = openBraceIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth > 0) body += ch;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
      body += ch;
    } else if (depth > 0) {
      body += ch;
    }
  }
  return body;
}

/** Extract [default, [Validators…]] blocks with bracket-aware parsing. */
function parseFieldValidatorEntries(body) {
  const meta = {};
  const fieldRe = /^\s*(\w+)\s*:\s*\[/gm;
  let match;
  while ((match = fieldRe.exec(body)) !== null) {
    const key = match[1];
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < body.length; i++) {
      if (body[i] === '[') depth += 1;
      else if (body[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = body.slice(start, end + 1);
    const valArrayMatch = block.match(/,\s*\[([\s\S]+)\]\s*]$/);
    if (!valArrayMatch) continue;
    const v = parseValidatorBlock(valArrayMatch[1]);
    if (v.required || v.minLength || v.maxLength || v.min != null || v.max != null || v.email || v.pattern) {
      meta[key] = { ...(meta[key] || {}), ...v };
    }
  }
  return meta;
}

/** Primary component FormGroup only — skips nested fb.group blocks (e.g. address rows, EAN array items). */
function parsePrimaryFormGroupValidators(text) {
  const meta = {};
  const src = String(text);
  const patterns = [
    /(?:\w+Form\s*:\s*FormGroup\s*=\s*this\.fb\.group|this\.\w+Form\s*=\s*this\.fb\.group)\s*\(\s*\{/,
    /this\.fb\.group\s*\(\s*\{/,
  ];
  let openIdx = -1;
  for (const re of patterns) {
    const anchor = src.match(re);
    if (!anchor) continue;
    openIdx = src.indexOf('{', anchor.index);
    if (openIdx >= 0) break;
  }
  if (openIdx < 0) return null;

  const body = extractBalancedBraces(src, openIdx);
  if (!body) return meta;

  return parseFieldValidatorEntries(body);
}

/** Save-gate essentials from TS (e.g. partner essentialControlNames). */
/** Fields checked in meetsCommonSaveRequirements / meetsCreateSaveRequirements (TS save gate). */
function parseSaveGateFields(text) {
  const keys = new Set();
  for (const regionRe of [/meetsCommonSaveRequirements[\s\S]{0,3000}/, /meetsCreateSaveRequirements[\s\S]{0,3000}/]) {
    const region = String(text).match(regionRe)?.[0] || '';
    for (const m of region.matchAll(/form\.get\(['"](\w+)['"]\)/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
}

function parseEssentialControlNames(text) {
  const m = String(text).match(/essentialControlNames\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1]);
}

function parseHtmlRequiredFields(html) {
  const keys = new Set();
  for (const m of String(html).matchAll(/hasError\s*\(\s*['"](\w+)['"]\s*,\s*['"]required['"]\s*\)/g)) {
    keys.add(m[1]);
  }
  return keys;
}

function parseFieldValidators(text) {
  const primary = parsePrimaryFormGroupValidators(text);
  if (primary && Object.keys(primary).length) return primary;

  const meta = {};
  const src = String(text);
  const groupMatch = src.match(/\.group\(\{([\s\S]*?)\n\s*\}\)/);
  if (groupMatch) {
    for (const line of groupMatch[1].split('\n')) {
      const fm = line.match(/^\s*(\w+)\s*:/);
      if (!fm || !/Validators\./.test(line)) continue;
      const v = parseValidatorBlock(line);
      if (v.required || v.minLength || v.maxLength || v.min != null || v.max != null || v.email || v.pattern) {
        meta[fm[1]] = { ...(meta[fm[1]] || {}), ...v };
      }
    }
  }
  for (const m of src.matchAll(/(\w+)\s*:\s*\[[^\n]+Validators\.[^\n]+\]/g)) {
    const key = m[1];
    if (meta[key]?.patternRegex) continue;
    const v = parseValidatorBlock(m[0]);
    if (v.required || v.pattern || v.minLength || v.maxLength || v.min != null || v.max != null) {
      meta[key] = { ...(meta[key] || {}), ...v };
    }
  }
  return meta;
}

/** Standalone FormControl declarations → validators, keyed by FormGroup field when sync/suffix maps. */
function parseInlineFormControlValidators(ts, formFieldKeys = [], syncMap = {}) {
  const meta = {};
  const controlMap = { ...parseControlBindings(ts), ...syncMap };
  for (const m of String(ts).matchAll(/(\w+)\s*=\s*new FormControl\([^,\n]*,\s*\[([^\]]+)\]/g)) {
    const varName = m[1];
    const v = parseValidatorBlock(m[2]);
    const key = resolveControlVarToFieldKey(varName, controlMap, formFieldKeys)
      || varName.replace(/Control$/, '');
    if (v.required || v.pattern || v.minLength || v.maxLength) {
      meta[key] = { ...(meta[key] || {}), ...v, required: v.required || meta[key]?.required };
    }
  }
  return meta;
}

/** Custom validator methods in TS (e.g. roundingRangeValidator min/max). */
function parseCustomMethodRules(ts) {
  const rules = {};
  const text = String(ts);
  if (/roundingRangeValidator/i.test(text)) {
    const minM = text.match(/parsed\s*<\s*([\d.]+)/);
    const maxM = text.match(/parsed\s*>\s*([\d.]+)/);
    rules.roundingIncrement = {
      min: minM ? Number(minM[1]) : 0.01,
      max: maxM ? Number(maxM[1]) : 1,
    };
  }
  const errMin = text.match(/roundingMinError[^}]*min:\s*([\d.]+)/);
  const errMax = text.match(/roundingMaxError[^}]*max:\s*([\d.]+)/);
  if (errMin || errMax) {
    rules.roundingIncrement = {
      ...(rules.roundingIncrement || {}),
      ...(errMin ? { min: Number(errMin[1]) } : {}),
      ...(errMax ? { max: Number(errMax[1]) } : {}),
    };
  }
  return rules;
}

function isFormArrayNestedControl(html, key, matchIndex = 0) {
  const region = String(html || '').slice(Math.max(0, matchIndex - 2500), matchIndex + 80);
  return new RegExp(`formArrayName\\s*=\\s*["'][^"']+["'][\\s\\S]*formControlName\\s*=\\s*["']${key}["']`, 'i').test(region);
}

function parseHtmlConstraints(html, key) {
  const constraints = {};
  const re = new RegExp(
    `(?:formControlName|formcontrolname)=["']${key}["'][^>]*`,
    'gi',
  );
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = html.slice(m.index, m.index + 400);
    const maxLen = block.match(/maxlength=["'](\d+)["']/i);
    if (maxLen) constraints.maxLength = Number(maxLen[1]);
    if (/appLocalizedDecimalInput|inputmode="decimal"/i.test(block)) {
      constraints.decimal = true;
    }
    if (/inputmode="numeric"/i.test(block)) constraints.numeric = true;
  }
  return constraints;
}

/** Human-readable business rules from indexed validators (for test plan + AI prompt). */
export function buildBusinessRules(field) {
  const v = field.validators || {};
  const rules = [];
  if (v.patternRegex === '[A-Z]{3}') {
    rules.push('exactly 3 uppercase letters (ISO currency / alpha code)');
  } else if (v.patternRegex === '[0-9]{3}') {
    rules.push('exactly 3 digits (ISO 4217 numeric code)');
  } else if (v.patternRegex) {
    rules.push(`must match pattern ${v.patternRegex}`);
  }
  if (v.min != null && v.max != null) {
    rules.push(`value between ${v.min} and ${v.max} inclusive`);
  } else if (v.max != null) {
    rules.push(`value must not exceed ${v.max}`);
  } else if (v.min != null) {
    rules.push(`minimum value ${v.min}`);
  }
  if (v.minLength != null && v.maxLength != null && v.minLength === v.maxLength) {
    rules.push(`exactly ${v.minLength} characters`);
  } else if (v.maxLength != null) {
    rules.push(`max ${v.maxLength} characters`);
  }
  if (field.constraints?.decimal && v.max === 1) {
    rules.push('decimal rounding increment ≤ 1 (e.g. 0.01)');
  }
  return rules;
}

/** Build a unique sample that satisfies a Validators.pattern regex (no fixed EUR/978). */
export function defaultValueFromPattern(patternRegex) {
  const rx = String(patternRegex || '');
  const stamp = Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '');

  const alpha = rx.match(/^\[A-Z\]\{(\d+)\}$/i);
  if (alpha) {
    const n = Number(alpha[1]);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let x = Date.now() % (26 ** Math.min(n, 8) || 26);
    let out = '';
    for (let i = 0; i < n; i++) {
      out = alphabet[x % 26] + out;
      x = Math.floor(x / 26);
    }
    return out;
  }

  const digit = rx.match(/^\[0-9\]\{(\d+)\}$/);
  if (digit) {
    const n = Number(digit[1]);
    const raw = String(Date.now());
    return raw.slice(-n).padStart(n, '0');
  }

  if (/^\[A-Z0-9\]\{(\d+)\}$/i.test(rx)) {
    const n = Number(RegExp.$1);
    return (stamp + 'X'.repeat(n)).slice(0, n);
  }

  return null;
}

function mergeValidators(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [key, v] of Object.entries(map || {})) {
      out[key] = { ...(out[key] || {}), ...v };
    }
  }
  return out;
}

function parseLabels(text) {
  const labels = {};
  for (const m of text.matchAll(/mat-label[^>]*>\s*\{\{\s*['"]([^'"]+)['"]\s*\|\s*translate/g)) {
    const i18n = m[1];
    const short = i18n.split('.').pop();
    labels[short] = i18n;
  }
  return labels;
}

function inferLabel(key, labels) {
  const human = {
    sales_unit: 'Sales unit',
    vatId: 'VAT',
    retailChains: 'Retail Chains',
    level1: 'Level 1',
    shortDesignation: 'Short description',
    longDesignation: 'Detailed description',
  };
  if (human[key]) return human[key];

  const n = normKey(key);
  for (const [short, i18n] of Object.entries(labels)) {
    if (normKey(short) === n || normKey(i18n).includes(n) || n.includes(normKey(short))) {
      return resolveI18nString(i18n) || i18n.split('.').pop() || key;
    }
  }
  return key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
}

function upsertField(map, key, patch, filterKeys = []) {
  if (!key || isFilterFieldKey(key, filterKeys)) return;
  const cur = map.get(key) || {
    key, type: 'text', required: false, testId: null, label: key, validators: {}, order: 999,
  };
  map.set(key, {
    ...cur,
    ...patch,
    order: patch.order != null ? patch.order : cur.order,
    validators: { ...cur.validators, ...(patch.validators || {}) },
  });
}

function attachTestIds(map, testIds, entityStem) {
  /** testId tail → form field key when normKey alone is ambiguous */
  const tailAliases = {
    vat: 'vatId',
    'sales-unit': 'sales_unit',
    'salesunit': 'sales_unit',
    'retail-chains': 'retailChains',
    level1: 'level1',
    level2: 'level2',
  };

  for (const id of testIds || []) {
    if (/search|filter|active|export|create|save|cancel|delete|row|edit|view|paginator|form|list|table|header|toolbar/i.test(id)) continue;
    const tail = id.includes('-') ? id.split('-').slice(1).join('-') : id;
    const camel = tail.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const aliasKey = tailAliases[tail] || tailAliases[normKey(tail)];

    const keysToTry = [...new Set([aliasKey, tail, camel].filter(Boolean))];
    for (const key of map.keys()) {
      const nk = normKey(key);
      if (keysToTry.some((t) => nk === normKey(t))) {
        const f = map.get(key);
        if (!f.testId) map.set(key, { ...f, testId: id });
      }
    }
  }
}

/**
 * Build form schema from RAG code context (HTML + TS chunks).
 * Prefers detail/form component chunks over list filter chunks.
 */
export function extractFormSchema(codeContext, { entityStem = '' } = {}) {
  const chunks = splitCodeChunks(codeContext);
  const filterKeys = deriveListFilterKeys(codeContext);
  const detail = chunks.filter((c) => isDetailChunk(c.path));
  const nonList = chunks.filter((c) => !isListChunk(c.path));
  const source = (detail.length ? detail : nonList.length ? nonList : chunks);
  let html = source.filter((c) => /\.html$/i.test(c.path)).map((c) => c.content).join('\n');
  let ts = chunks.filter((c) => /\.ts$/i.test(c.path) && !/\.spec\./i.test(c.path)).map((c) => c.content).join('\n');
  // Unpath'd / mixed blobs (or path filters missed files) — still parse FormGroup + formControlName
  if (!html.trim() && !ts.trim()) {
    const blob = source.map((c) => c.content).join('\n') || String(codeContext || '');
    html = blob;
    ts = blob;
  } else if (!html.trim()) {
    html = source.map((c) => c.content).join('\n');
  } else if (!ts.trim()) {
    ts = chunks.map((c) => c.content).join('\n');
  }
  const text = `${html}\n${ts}`;
  const formFieldKeys = [
    ...new Set([
      ...parseFormGroupFieldKeys(ts),
      ...[...html.matchAll(/formControlName="(\w+)"/gi)].map((m) => m[1]),
    ]),
  ];
  const syncMap = parseStandaloneSyncMap(ts);
  const getters = { ...parseControlGetters(ts), ...syncMap };
  const validators = mergeValidators(
    parseFieldValidators(ts),
    parseInlineFormControlValidators(ts, formFieldKeys, syncMap),
    parseCustomMethodRules(ts),
  );
  const essentialControls = parseEssentialControlNames(ts);
  const saveGateFields = parseSaveGateFields(ts);
  const htmlRequired = parseHtmlRequiredFields(html);
  const labels = parseLabels(html);
  const fields = new Map();

  const upsert = (key, patch) => upsertField(fields, key, patch, filterKeys);

  for (const wf of parseWrapperDropdownFields(html, {
    controlMap: getters,
    formFieldKeys,
    validators,
    labels,
    entityStem,
  })) {
    upsert(wf.key, wf);
  }

  let parseOrder = 0;
  for (const m of html.matchAll(/formControlName="(\w+)"/g)) {
    const key = m[1];
    if (isFormArrayNestedControl(html, key, m.index ?? 0)) continue;
    const meta = inferNativeFieldMeta(html, key, m.index ?? 0);
    upsert(key, {
      ...meta,
      label: inferLabel(key, labels),
      validators: validators[key] || {},
      required: Boolean(validators[key]?.required),
      order: parseOrder++,
    });
  }

  for (const m of html.matchAll(/\[formControl\]="(\w+)"[^>]*data-testid="([^"]+)"/gi)) {
    const key = resolveControlVarToFieldKey(m[1], getters, formFieldKeys);
    if (!key) continue;
    const meta = inferNativeFieldMeta(html, key, m.index ?? 0);
    const region = html.slice(m.index ?? 0, (m.index ?? 0) + 500);
    upsert(key, {
      ...meta,
      testId: m[2],
      standalone: true,
      binding: 'formControl',
      controlVar: m[1],
      order: m.index ?? 0,
      ...( /matAutocomplete|mat-autocomplete/i.test(region)
        ? { type: 'autocomplete', componentType: 'autocomplete', innerTag: 'input' }
        : {}),
    });
  }
  for (const m of html.matchAll(/data-testid="([^"]+)"[^>]*\[formControl\]="(\w+)"/gi)) {
    const key = resolveControlVarToFieldKey(m[2], getters, formFieldKeys);
    if (!key) continue;
    const meta = inferNativeFieldMeta(html, key, m.index ?? 0);
    const region = html.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 300);
    upsert(key, {
      ...meta,
      testId: m[1],
      standalone: true,
      binding: 'formControl',
      controlVar: m[2],
      order: m.index ?? 0,
      ...( /matAutocomplete|mat-autocomplete/i.test(region)
        ? { type: 'autocomplete', componentType: 'autocomplete', innerTag: 'input' }
        : {}),
    });
  }

  // Multiline: [formControl] and data-testid may be on different attribute lines
  for (const m of html.matchAll(/<input\b([^>]*\[formControl\]="(\w+)"[^>]*)>/gi)) {
    const attrs = m[1];
    const varName = m[2];
    const tid = attrs.match(/data-testid="([^"]+)"/i)?.[1];
    if (!tid) continue;
    const key = resolveControlVarToFieldKey(varName, getters, formFieldKeys);
    if (!key) continue;
    upsert(key, {
      standalone: true,
      binding: 'formControl',
      controlVar: varName,
      testId: tid,
      order: m.index ?? 0,
      type: /matAutocomplete/i.test(attrs) ? 'autocomplete' : 'text',
      componentType: /matAutocomplete/i.test(attrs) ? 'autocomplete' : 'mat-input',
      innerTag: 'input',
      label: inferLabel(key, labels),
      validators: validators[key] || {},
      required: Boolean(validators[key]?.required),
    });
  }

  for (const m of html.matchAll(/(?:formControlName|formcontrolname)="(\w+)"[^>]*data-testid="([^"]+)"/gi)) {
    upsert(m[1], { testId: m[2] });
  }
  for (const m of html.matchAll(/data-testid="([^"]+)"[^>]*(?:formControlName|formcontrolname)="(\w+)"/gi)) {
    upsert(m[2], { testId: m[1] });
  }

  for (const [key, v] of Object.entries(validators)) {
    if (isFilterFieldKey(key, filterKeys)) continue;
    upsert(key, {
      validators: v,
      required: Boolean(v.required),
      label: inferLabel(key, labels),
    });
  }

  for (const key of saveGateFields) {
    if (isFilterFieldKey(key, filterKeys)) continue;
    upsert(key, {
      required: true,
      validators: { required: true },
      label: inferLabel(key, labels),
    });
  }

  const testIds = [
    ...text.matchAll(/data-testid\s*=\s*"([^"]+)"/g),
    ...text.matchAll(/\btestId\s*=\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  attachTestIds(fields, testIds, entityStem);

  /** First occurrence in form HTML — standalone [formControl] fields keep order 999 otherwise. */
  function htmlPositionForField(field) {
    if (field.testId) {
      const byAttr = html.indexOf(`data-testid="${field.testId}"`);
      if (byAttr >= 0) return byAttr;
      const byProp = html.indexOf(`testId="${field.testId}"`);
      if (byProp >= 0) return byProp;
    }
    const fcn = html.indexOf(`formControlName="${field.key}"`);
    if (fcn >= 0) return fcn;
    return (field.order ?? 999) * 100000;
  }

  for (const f of fields.values()) {
    const htmlConstraints = parseHtmlConstraints(html, f.key);
    if (htmlConstraints.maxLength && !f.validators?.maxLength) {
      f.validators = { ...(f.validators || {}), maxLength: htmlConstraints.maxLength };
    }
    if (htmlConstraints.decimal) {
      f.type = f.type === 'text' ? 'decimal' : f.type;
    }
    if (essentialControls?.length) {
      f.required = essentialControls.includes(f.key);
    } else if (saveGateFields.has(f.key)) {
      f.required = true;
      f.validators = { ...(f.validators || {}), required: true };
    } else if (htmlRequired.has(f.key)) {
      f.required = true;
      f.validators = { ...(f.validators || {}), required: true };
    } else if (f.validators?.required) {
      f.required = true;
    }
    f.businessRules = buildBusinessRules({ ...f, constraints: htmlConstraints });
  }

  const ordered = [...fields.values()].filter((f) => !isFilterFieldKey(f.key, filterKeys));
  for (const f of ordered) {
    if (f.key === 'code' && !f.testId) {
      const ref = fields.get('reference');
      if (ref?.testId) {
        f.required = false;
        f.automate = false;
      }
    }
    if (isFormArrayNestedControl(html, f.key)) {
      f.required = false;
    }
    f.order = htmlPositionForField(f);
  }
  ordered.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.key.localeCompare(b.key);
  });

  return {
    entity: entityStem || null,
    fields: ordered,
    filterKeys,
    listSearch: parseListSearchMeta(codeContext),
  };
}

function isRunnerFillable(field) {
  if (!field?.key) return false;
  // Strict: only automate fields that expose a code testId / data-testid
  return Boolean(field.testId);
}

function uniqueSuffix() {
  return Date.now().toString(36).slice(-5);
}

/** Default from validators + parsed field type only (no key-name heuristics). */
export function defaultValueForField(field, ctx = {}) {
  const suffix = uniqueSuffix();
  const v = field.validators || {};

  if (interactionKindForField(field, null) === 'select') {
    return '__first__';
  }
  if (v.email || field.type === 'email') {
    return `auto+${suffix}@test.com`;
  }

  const fromPattern = defaultValueFromPattern(v.patternRegex);
  if (fromPattern) return fromPattern;

  if (field.type === 'decimal' || (v.min != null && v.max != null && v.max <= 1)) {
    const min = v.min != null ? Number(v.min) : 0.01;
    return String(min <= 1 ? min : 0.01);
  }

  if (field.type === 'number' || v.min != null || v.max != null) {
    let n = v.min != null ? Number(v.min) : 1;
    if (!Number.isFinite(n) || n <= 0) n = 1;
    if (v.max != null && n > Number(v.max)) n = Number(v.max);
    return String(n);
  }

  const minLen = Math.max(v.minLength || v.maxLength || 0, 1);
  if (v.maxLength && v.maxLength <= 4 && v.pattern) {
    return defaultValueFromPattern(v.patternRegex) || '1'.repeat(v.maxLength);
  }

  let val = `${field.key}-${suffix}`.replace(/_/g, '-');
  if (v.maxLength) val = val.slice(0, v.maxLength);
  while (val.length < minLen) val += 'x';
  if (ctx.primaryValue && field.key === ctx.primaryField) {
    return ctx.primaryValue;
  }
  return val;
}

/**
 * Merge description values with schema defaults (required fields only on create).
 */
export function resolveFormFieldValues(schema, testData = {}, ctx = {}) {
  const values = { ...(testData.fields || {}) };
  const identity = pickIdentityFieldFromSchema(schema);
  const primaryField = testData.primaryField || identity?.key
    || schema.fields?.find((f) => f.required && f.type !== 'dropdown')?.key;
  if (testData.primaryValue && primaryField && !values[primaryField]) {
    const explicit = testData.fields || {};
    const applyPrimary = Boolean(testData.primaryField) || !Object.keys(explicit).length;
    if (applyPrimary) values[primaryField] = testData.primaryValue;
  }

  const action = ctx.action || 'create';
  const filterKeys = schema.filterKeys || [];
  for (const field of schema.fields || []) {
    if (isFilterFieldKey(field.key, filterKeys)) continue;
    if (values[field.key]) continue;
    // Update: only fields the user explicitly named — never auto-fill code/numeric/name defaults
    if (action === 'update') continue;
    if (!field.required) continue;
    if (action === 'create' && !isRunnerFillable(field)) continue;
    values[field.key] = defaultValueForField(field, {
      ...ctx,
      primaryField,
      primaryValue: testData.primaryValue || values[primaryField],
    });
  }

  return values;
}

/** Automation steps data: ordered fields with kind/testId/value (respects component types). */
export function buildFormAutomationFields(schema, values, _entityStem = '') {
  const out = [];
  const filterKeys = schema.filterKeys || [];
  for (const field of schema.fields || []) {
    if (isFilterFieldKey(field.key, filterKeys)) continue;
    if (!isRunnerFillable(field)) continue;
    if (!isAutomatableField(field)) continue;
    if (values[field.key] == null || values[field.key] === '') continue;
    const kind = interactionKindForField(field, values[field.key]);
    if (kind === 'skip') continue;
    out.push({
      formControl: field.key,
      label: field.label,
      kind,
      componentType: field.componentType || field.type,
      wrapperTag: field.wrapperTag || null,
      innerTag: field.innerTag || null,
      testId: field.testId,
      standalone: Boolean(field.standalone),
      binding: field.binding || null,
      value: values[field.key],
      required: Boolean(field.required),
    });
  }
  return out;
}

/** Human label for a form field key (i18n tail or key). */
function camelToTitle(s) {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fieldDisplayLabel(field) {
  const raw = field?.label || field?.key || '';
  if (!raw.includes('.')) return camelToTitle(raw);
  return camelToTitle(raw.split('.').pop());
}

/** One manual-test step line for a prepared field value. */
export function formatTestDataStep(entry) {
  const label = fieldDisplayLabel(entry);
  if (entry.kind === 'select' || entry.value === '__first__') {
    if (entry.value && entry.value !== '__first__') {
      return `Select "${entry.value}" in the ${label} dropdown.`;
    }
    return `Select the first option in the ${label} dropdown.`;
  }
  return `Enter "${entry.value}" in the ${label} field.`;
}

/**
 * Resolve values + per-field source (description vs code-default).
 * Used by manual test cases and automation so both show the same data.
 */
export function resolveFormFieldValuesWithSources(schema, testData = {}, ctx = {}) {
  const descriptionFields = { ...(testData.fields || {}) };
  if (testData.primaryValue && testData.primaryField && !descriptionFields[testData.primaryField]) {
    descriptionFields[testData.primaryField] = testData.primaryValue;
  }
  const values = resolveFormFieldValues(schema, testData, ctx);
  const entries = [];

  for (const field of schema.fields || []) {
    if (isFilterFieldKey(field.key, schema.filterKeys || [])) continue;
    const val = values[field.key];
    if (val == null || val === '') continue;
    if (ctx.action === 'create' && !isRunnerFillable(field)) continue;
    const fromDescription = descriptionFields[field.key] != null && descriptionFields[field.key] !== '';
    const isSelect = field.type === 'dropdown' || val === '__first__'
      || interactionKindForField(field, val) === 'select';
    entries.push({
      key: field.key,
      label: fieldDisplayLabel(field),
      value: val,
      source: fromDescription ? 'description' : 'code-default',
      kind: isSelect ? 'select' : 'fill',
      required: Boolean(field.required),
      testId: field.testId || null,
      businessRules: field.businessRules || buildBusinessRules(field),
    });
  }

  return { values, entries };
}

/** Manual test-case lines for every prepared form field (all modules). */
export function buildFormFillStepLines(schema, testData = {}, ctx = {}) {
  if (!schema?.fields?.length) {
    return { lines: [], entries: [] };
  }
  const { entries } = resolveFormFieldValuesWithSources(schema, testData, ctx);
  if (!entries.length) {
    return { lines: [], entries: [] };
  }
  const lines = ctx.action === 'update'
    ? ['Wait for the edit form to open.']
    : ['Wait for the create or edit form to open.'];
  for (const entry of entries) {
    lines.push(formatTestDataStep(entry));
  }
  lines.push('Identify and click the Save or Submit button.');
  return { lines, entries };
}
