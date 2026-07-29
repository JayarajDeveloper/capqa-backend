/**
 * Schema-aware NLP for title + description → field values.
 * No module-specific hardcoding: field keys, labels, and testIds come from indexed code.
 */

import { isFilterFieldKey } from './formSchema.js';

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Build searchable aliases from an indexed schema field (key, i18n label, testId tail). */
export function buildFieldCatalog(schemaFields = [], formControls = []) {
  const catalog = new Map();

  const add = (field) => {
    if (!field?.key || isFilterFieldKey(field.key)) return;
    const aliases = new Set([normKey(field.key)]);
    if (field.label) {
      aliases.add(normKey(field.label));
      if (String(field.label).includes('.')) {
        aliases.add(normKey(String(field.label).split('.').pop()));
      }
    }
    if (field.testId) {
      const parts = String(field.testId).split('-');
      if (parts.length > 1) {
        aliases.add(normKey(parts.slice(1).join('-')));
        aliases.add(normKey(parts[parts.length - 1]));
      }
    }
    for (const piece of String(field.key).replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').split(/\s+/)) {
      if (piece.length >= 2) aliases.add(normKey(piece));
    }
    catalog.set(field.key, {
      key: field.key,
      label: field.label || field.key,
      testId: field.testId || null,
      type: field.type,
      required: Boolean(field.required),
      aliases: [...aliases].filter(Boolean),
    });
  };

  for (const f of schemaFields || []) add(f);
  for (const fc of formControls || []) {
    if (!catalog.has(fc) && !isFilterFieldKey(fc)) {
      add({ key: fc, label: fc });
    }
  }
  return [...catalog.values()];
}

/** Map a natural-language field phrase to an indexed formControl using schema catalog. */
export function mapFieldToFormControl(fieldName, formControls = [], schemaFields = []) {
  const n = normKey(fieldName);
  if (!n) return null;

  const catalog = buildFieldCatalog(schemaFields, formControls);

  for (const entry of catalog) {
    if (normKey(entry.key) === n) return entry.key;
    if (entry.aliases.some((a) => a === n)) return entry.key;
  }

  for (const entry of catalog) {
    const keyNorm = normKey(entry.key);
    if (keyNorm.includes(n) || n.includes(keyNorm)) return entry.key;
    for (const a of entry.aliases) {
      if (a.length >= 3 && (a.includes(n) || n.includes(a))) return entry.key;
    }
  }

  if (/^(name|title|label)$/.test(n)) {
    const identity = catalog.find((e) => e.required && e.type !== 'dropdown')
      || catalog.find((e) => /name|title|label/i.test(e.key));
    if (identity) return identity.key;
  }

  if (/search|filter|query/.test(n)) {
    const searchFc = formControls.find((fc) => /search|filter|query/i.test(fc));
    if (searchFc) return searchFc;
  }

  return null;
}

function resolveFieldPhrase(phrase, catalog, formControls) {
  const parts = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    const chunk = parts.slice(0, i).join(' ');
    const fc = mapFieldToFormControl(chunk, formControls, catalog.map((c) => ({ key: c.key, label: c.label, testId: c.testId, type: c.type, required: c.required })));
    if (fc) return fc;
  }
  return mapFieldToFormControl(parts[0], formControls, catalog);
}

function looksLikeInstructionPhrase(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  if (/\b(dropdown|select|checkbox|toggle|button|field|form)\b/.test(t)) return true;
  if (/\bdropdown\s+as\b/.test(t)) return true;
  if (t.split(/\s+/).length > 6) return true;
  return false;
}

/**
 * Extract field→value pairs from title + description using indexed schema vocabulary.
 * Returns { fields, mentions } where mentions are raw NLP hits for debugging.
 */
export function analyzeAskNlp(title, description, { formControls = [], schemaFields = [], intent = null } = {}) {
  const combined = [title, description].filter(Boolean).join('. ').trim();
  const catalog = buildFieldCatalog(schemaFields, formControls);
  const fields = {};
  const mentions = [];
  const text = combined;

  if (!text || !catalog.length) return { fields, mentions };

  const assign = (fieldKey, value, pattern) => {
    const v = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!v || looksLikeInstructionPhrase(v)) return;
    if (!fieldKey || isFilterFieldKey(fieldKey)) return;
    fields[fieldKey] = v;
    mentions.push({ field: fieldKey, value: v, pattern });
  };

  for (const m of text.matchAll(
    /\b([\w]+(?:\s+[\w]+)?)\s+(?:select\s+)?dropdown\s+(?:as|to|=)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b|\s+then\b)/gi,
  )) {
    const fc = resolveFieldPhrase(m[1], catalog, formControls);
    if (fc) assign(fc, m[2], 'dropdown-as');
  }

  for (const m of text.matchAll(
    /\bselect\s+['"]?([^'"\n,;]+?)['"]?\s+(?:for|in)\s+(?:the\s+)?(\w+(?:\s+\w+)?)(?:\s+dropdown)?/gi,
  )) {
    const fc = resolveFieldPhrase(m[2], catalog, formControls);
    if (fc) assign(fc, m[1], 'select-for');
  }

  for (const m of text.matchAll(
    /\b(?:with|set)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+(?:as|to|=)\s+['"]?([A-Za-z][^'"\n,;]{0,48}?)['"]?(?:\s*$|[,.;]|\s+and\b|\s+then\b)/gi,
  )) {
    const fc = resolveFieldPhrase(m[1], catalog, formControls);
    if (fc) assign(fc, m[2], 'with-as');
  }

  for (const m of text.matchAll(
    /\b(?:fill|enter|type|input)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+(?:with|as|=)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b)/gi,
  )) {
    const fc = resolveFieldPhrase(m[1], catalog, formControls);
    if (fc) assign(fc, m[2], 'fill-with');
  }

  for (const m of text.matchAll(/\b(\w+(?:\s+\w+)?)\s*[:=]\s*([^,\n;]+)/g)) {
    const fc = resolveFieldPhrase(m[1], catalog, formControls);
    if (fc) assign(fc, m[2], 'colon');
  }

  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      if (alias.length < 3) continue;
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:is|as|to|=)\\s+['"]?([^'"\n,;]+?)['"]?(?:\\s*$|[,.;]|\\s+and\\b)`, 'i');
      const hit = text.match(re);
      if (hit) assign(entry.key, hit[1], 'alias-is');
    }
  }

  const tokens = tokenize(text);
  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      if (alias.length < 4) continue;
      const aliasTokens = alias.length >= 6 ? [alias] : alias.match(/.{3,}/g) || [];
      for (const at of aliasTokens.length ? [alias] : []) {
        if (!text.toLowerCase().includes(at)) continue;
        const after = text.toLowerCase().split(at).pop();
        const vm = after?.match(/^\s*(?:as|to|=|is)\s+['"]?([^'"\n,;]+?)['"]?(?:\s|$|[,.;])/);
        if (vm) assign(entry.key, vm[1], 'token-after');
      }
    }
  }

  return { fields, mentions };
}

/** Pick the primary identity field from schema (testId / required / type — not hardcoded keys). */
export function pickIdentityFieldFromSchema(schema = {}) {
  const fields = (schema.fields || []).filter((f) => !isFilterFieldKey(f.key, schema.filterKeys));
  for (const tail of ['name', 'title', 'label', 'code']) {
    const hit = fields.find((f) => f.testId && new RegExp(`-${tail}$`, 'i').test(f.testId) && f.type !== 'dropdown');
    if (hit) return hit;
  }
  const requiredText = fields.find((f) => f.required && f.type !== 'dropdown');
  if (requiredText) return requiredText;
  return fields.find((f) => f.type !== 'dropdown') || fields[0] || null;
}

const SEARCH_TERM_FIELD_KEYS = {
  code: ['code'],
  name: ['name'],
  value: ['value', 'valued', 'rate'],
  rate: ['rate'],
  description: ['description', 'display_label', 'displaylabel'],
  symbol: ['symbol'],
  email: ['email'],
  phone: ['phone'],
};

/** List-search needle field — prefer fields the list search box actually indexes (code before name). */
export function pickVerifyIdentityFieldFromSchema(schema = {}) {
  const fields = (schema.fields || []).filter((f) => !isFilterFieldKey(f.key, schema.filterKeys));
  const listTerms = schema.listSearch?.searchableTerms || [];

  for (const term of listTerms) {
    const candidates = SEARCH_TERM_FIELD_KEYS[term] || [term];
    for (const key of candidates) {
      const hit = fields.find((f) => normKey(f.key) === normKey(key) && f.type !== 'dropdown');
      if (hit) return hit;
      const byTestId = fields.find((f) => f.testId && new RegExp(`-${term.replace(/_/g, '-')}$`, 'i').test(f.testId));
      if (byTestId) return byTestId;
    }
  }

  for (const tail of ['code', 'name', 'title', 'label']) {
    const hit = fields.find((f) => f.testId && new RegExp(`-${tail}$`, 'i').test(f.testId) && f.type !== 'dropdown');
    if (hit) return hit;
  }
  const codeField = fields.find((f) => f.key === 'code' && f.type !== 'dropdown');
  if (codeField) return codeField;
  return pickIdentityFieldFromSchema(schema);
}
