// RAG grounding: map a vague user ask onto indexed code, or ask the user to clarify.
 // Never invent application vocabulary — only what the index contains. No page hardcoding.

import { prisma } from '../../db.js';
import { layerOf } from './retrieve.js';
import {
  buildFormAutomationFields,
  extractFormSchema,
  resolveFormFieldValues,
  resolveFormFieldValuesWithSources,
  isFilterFieldKey,
} from './formSchema.js';
import {
  featureTermsFromContext,
  isGrammarOrFeatureTerm,
  rankFeaturePath,
  isDetailChunkPath,
  featureFolderFromPath,
  featureSlugFromName,
  hasFeatureDetailChunk,
  pathInFeatureFolder,
  primaryFeatureFolder,
  resolvedFeatureFolder,
  normalizeRowNeedle,
  parseUpdateRowNeedleFromAsk,
} from './codeSignals.js';
import {
  analyzeAskNlp,
  mapFieldToFormControl,
  pickIdentityFieldFromSchema,
  pickVerifyIdentityFieldFromSchema,
  buildFieldCatalog,
} from './askAnalyzer.js';

export { mapFieldToFormControl, buildFieldCatalog, pickIdentityFieldFromSchema };
export { prioritizeFeatureChunks, normalizeRowNeedle } from './codeSignals.js';

/** Singular entity stem from list route segment (partners → partner, retail-chains → retail-chain). */
export function entityStemFromResourceSeg(resourceSeg) {
  const seg = String(resourceSeg || '').trim();
  if (!seg) return '';
  if (/ies$/i.test(seg) && seg.length > 4) return `${seg.slice(0, -3)}y`;
  if (seg.endsWith('s') && seg.length > 3 && !seg.endsWith('ss')) return seg.slice(0, -1);
  return seg;
}

/** Entity stem from indexed testIds (partner-create → partner). Works for all CRUD modules. */
export function entityStemFromVocab(vocab = {}) {
  const createTestId = (vocab.testIds || []).find((id) => /create|add|new/i.test(id));
  const saveTestId = (vocab.testIds || []).find((id) => /save|submit/i.test(id));
  for (const id of [createTestId, saveTestId]) {
    const m = String(id || '').match(/^(.+?)-(?:create|add|new|save|submit)$/i);
    if (m?.[1]) return m[1];
  }
  return '';
}

const ASK_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with',
  'from', 'into', 'is', 'are', 'be', 'as', 'it', 'this', 'that', 'my', 'our',
  'create', 'make', 'add', 'new', 'please', 'want', 'need', 'test', 'case', 'cases',
  'plan', 'manual', 'ui', 'browser', 'check', 'verify', 'feature', 'screen', 'page',
  'how', 'can', 'should', 'would', 'could', 'write', 'generate', 'draft',
  'required', 'mandatory', 'empty', 'blank', 'missing', 'validation', 'permission',
  'permissions', 'role', 'access', 'duplicate', 'unique', 'save', 'submit', 'confirm',
  'name', 'field', 'fields', 'form', 'button', 'click', 'user', 'also', 'then',
  'list', 'search', 'filter', 'browse', 'open', 'show', 'display', 'all', 'records',
  'items', 'table', 'rows', 'row', 'view', 'delete', 'remove', 'edit', 'update', 'modify',
  'find', 'existing', 'named', 'called',
]);

/** Singular/plural / light stem variants so "partner" matches "partners". */
export function termVariants(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w || w.length < 2) return [];
  const out = new Set([w]);
  if (w.endsWith('ies') && w.length > 4) {
    out.add(`${w.slice(0, -3)}y`);
  } else if (w.endsWith('ses') && w.length > 4) {
    out.add(w.slice(0, -2));
  } else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
    out.add(w.slice(0, -1));
  } else {
    out.add(`${w}s`);
    if (w.endsWith('y') && w.length > 3) out.add(`${w.slice(0, -1)}ies`);
  }
  // compound helpers: retailchain already handled by expandTerms elsewhere
  return [...out];
}

/** Meaningful nouns from the user ask (deduped). Quoted literals are excluded — they are test data, not feature terms. */
export function askTerms(query) {
  const stripped = String(query || '').replace(/['"][^'"]*['"]/g, ' ');
  const parts = stripped
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/[\s_-]+/)
    .filter((w) => w.length >= 3 && !ASK_STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(parts)].slice(0, 12);
}

export function expandAskTerms(query) {
  const base = askTerms(query);
  const out = new Set(base);
  for (const t of base) {
    for (const v of termVariants(t)) out.add(v);
  }
  if (base.length >= 2) {
    out.add(base.join(''));
    out.add(base.join('_'));
    out.add(base.join('-'));
  }
  return { base, all: [...out] };
}

/**
 * Merge title + description into one natural-language ask (order preserved, deduped).
 */
export function combineAsk(title, description) {
  const t = String(title || '').trim();
  const d = String(description || '').trim();
  if (!t) return d;
  if (!d) return t;
  if (d.toLowerCase() === t.toLowerCase()) return t;
  if (d.toLowerCase().startsWith(t.toLowerCase())) return d;
  if (t.toLowerCase().startsWith(d.toLowerCase())) return t;
  return `${t}. ${d}`;
}

/**
 * Parse free-form ask — extract subject terms only for RAG search.
 * Action/entity detection is now handled entirely by nlpParseIntent().
 * This function provides the minimal fallback: subject terms for code indexing.
 */
export function parseIntent(title, description) {
  const rawTitle = String(title || '').trim();
  const rawDescription = String(description || '').trim();
  const combinedAsk = combineAsk(rawTitle, rawDescription);

  const { base: subjectTerms, all: expanded } = expandAskTerms(combinedAsk);
  const summary = combinedAsk.slice(0, 120) || 'Untitled ask';

  return {
    action: 'exercise', // NLP overrides this
    actionScores: { exercise: 1 },
    notes: [],
    subjectTerms,
    expandedTerms: expanded,
    summary,
    rawTitle,
    rawDescription,
    combinedAsk,
    searchQuery: combinedAsk.trim() || subjectTerms.join(' '),
  };
}

/** Pull likely test-data tail from a phrase (strip leading feature terms from ask). */
function extractValueTail(phrase, featureTerms = null) {
  let rest = String(phrase || '').trim();
  if (!rest) return '';
  const tokens = rest.split(/\s+/).filter(Boolean);
  const stop = featureTerms || featureTermsFromContext();
  while (tokens.length > 1 && stop.has(tokens[0].toLowerCase()) && !/^[A-Z]/.test(tokens[0])) {
    tokens.shift();
  }
  return tokens.join(' ').trim();
}

/** Strip verification phrasing — not test data ("or not", "check whether…"). */
function stripVerificationPhrases(text) {
  return String(text || '')
    .replace(/\b(?:check|verify|confirm|ensure)\s+(?:whether|if|that)\s+.+$/i, '')
    .replace(/\b(?:whether|if)\s+it\s+(?:is\s+)?(?:updating|saving|working).+$/i, '')
    .replace(/\s+or\s+not\b/gi, '')
    .trim();
}

/** All quoted literals in the ask — highest-confidence test data. */
function extractQuotedStrings(text) {
  return [...String(text || '').matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1].trim())
    .filter((v) => v.length >= 1);
}

function isPlausibleValue(v, featureTerms = null) {
  const s = String(v || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s || s.length < 1) return false;
  if (isGrammarOrFeatureTerm(s, featureTerms)) return false;
  if (looksLikeInstructionPhrase(s)) return false;
  return true;
}

/** Map a field phrase ("country select", "country") to an indexed formControl. */
function resolveFieldPhrase(phrase, formControls = [], schemaFields = []) {
  const parts = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    const chunk = parts.slice(0, i).join(' ');
    const fc = mapFieldToFormControl(chunk, formControls, schemaFields);
    if (fc) return fc;
  }
  return mapFieldToFormControl(parts[0], formControls, schemaFields);
}

/** Parse explicit per-field values from natural language (dropdown as X, field as X, …). */
function extractExplicitFieldValues(text, formControls = [], schemaFields = [], assign) {
  const t = String(text || '');

  for (const m of t.matchAll(
    /\b([\w]+(?:\s+[\w]+)?)\s+(?:select\s+)?dropdown\s+(?:as|to|=)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b|\s+then\b)/gi,
  )) {
    const fc = resolveFieldPhrase(m[1], formControls, schemaFields);
    if (fc) assign(fc, m[2].trim());
  }

  for (const m of t.matchAll(
    /\bselect\s+['"]?([^'"\n,;]+?)['"]?\s+(?:for|in)\s+(?:the\s+)?(\w+(?:\s+\w+)?)(?:\s+dropdown)?/gi,
  )) {
    const fc = resolveFieldPhrase(m[2], formControls, schemaFields);
    if (fc) assign(fc, m[1].trim());
  }

  for (const m of t.matchAll(
    /\b(?:with\s+)?(?:the\s+)?(\w+)\s+(?:as|to|=)\s+['"]?([A-Za-z][^'"\n,;]{0,40}?)['"]?(?:\s*$|[,.;]|\s+and\b|\s+then\b)/gi,
  )) {
    if (/^(create|add|new|a|an|the|name|using|with)$/i.test(m[1])) continue;
    if (/dropdown|select|field|button/i.test(m[2])) continue;
    const fc = resolveFieldPhrase(m[1], formControls, schemaFields);
    if (fc) assign(fc, m[2].trim());
  }
}

const FILTER_FORM_CONTROLS = null; // replaced by vocab.filterKeys from indexed list templates

function isFilterFormControl(fc, vocab = {}) {
  return (vocab.filterKeys || []).includes(fc);
}

/** Normalize + validate extracted test data against indexed form controls. */
export function normalizeTestData(raw, vocab = {}, intent = null) {
  const formControls = vocab.formControls || [];
  const schemaFields = vocab.schemaFields || [];
  const featureTerms = featureTermsFromContext(intent, vocab.matchedFeature);
  const action = intent?.action || '';
  const fields = {};
  for (const [k, v] of Object.entries(raw?.fields || {})) {
    const fc = mapFieldToFormControl(k, formControls, schemaFields);
    if (fc && !isFilterFormControl(fc, vocab) && isPlausibleValue(v, featureTerms)) fields[fc] = String(v).trim();
  }

  let existingRowNeedle = isPlausibleValue(raw?.existingRowNeedle, featureTerms)
    ? normalizeRowNeedle(extractValueTail(String(raw.existingRowNeedle).trim(), featureTerms) || raw.existingRowNeedle)
    : null;
  let searchTerm = isPlausibleValue(raw?.searchTerm, featureTerms)
    ? normalizeRowNeedle(extractValueTail(String(raw.searchTerm).trim(), featureTerms) || raw.searchTerm)
    : null;
  let verifyText = isPlausibleValue(raw?.verifyText, featureTerms) ? String(raw.verifyText).trim() : null;

  const identity = pickIdentityFieldFromSchema({ fields: schemaFields });
  const identityKey = identity?.key || formControls.find((c) => !isFilterFormControl(c)) || null;

  const priority = [
    identityKey,
    ...formControls.filter((c) => !isFilterFormControl(c)),
    ...Object.keys(fields).filter((k) => !isFilterFormControl(k)),
  ];
  let primaryField = null;
  let primaryValue = null;
  for (const key of [...new Set(priority)]) {
    if (fields[key]) {
      primaryField = key;
      primaryValue = fields[key];
      break;
    }
  }
  if (!primaryValue && searchTerm && action !== 'update') {
    primaryField = formControls.find((c) => /search/i.test(c)) || null;
    primaryValue = searchTerm;
  }
  if (!verifyText && fields[identityKey] && action !== 'update') verifyText = fields[identityKey];
  else if (!verifyText && primaryValue && primaryField === identityKey && action !== 'update') verifyText = primaryValue;
  if (action === 'update' && !verifyText) {
    if (fields.name) verifyText = fields.name;
    else if (fields[identityKey]) verifyText = fields[identityKey];
    else {
      const first = Object.values(fields).find((v) => v && isPlausibleValue(v, featureTerms));
      if (first) verifyText = first;
    }
  }
  if (verifyText && (isGenericOutcomePhrase(verifyText) || !isPlausibleValue(verifyText, featureTerms))) {
    verifyText = fields[identityKey] || (primaryField === identityKey ? primaryValue : null) || null;
  }

  return {
    fields,
    primaryField,
    primaryValue,
    searchTerm,
    verifyText,
    existingRowNeedle,
    fromDescription: Boolean(primaryValue || searchTerm || existingRowNeedle || Object.keys(fields).length),
    source: raw?.source || 'parser',
  };
}

/** Prefer intent.testData (AI-resolved) over fresh regex parse. */
export function getTestData(intent, title, description, vocab = {}) {
  if (intent?.testData && typeof intent.testData === 'object') return intent.testData;
  return extractTestData(intent?.rawTitle ?? title, intent?.rawDescription ?? description, vocab, intent);
}

/** Merge regex baseline with LLM extraction — both validated against indexed formControls. */
export function mergeTestData(baseline, llmRaw, vocab = {}, intent = null) {
  const base = baseline || normalizeTestData({}, vocab, intent);
  if (!llmRaw || typeof llmRaw !== 'object') return base;

  const llmFields = {};
  for (const [k, v] of Object.entries(llmRaw.fields || {})) {
    const fc = mapFieldToFormControl(k, vocab.formControls || [], vocab.schemaFields || []);
    if (fc && isPlausibleValue(v, featureTermsFromContext(intent, vocab.matchedFeature))) llmFields[fc] = String(v).trim();
  }

  const mergedFields = { ...base.fields, ...llmFields };
  const pick = (llmVal, baseVal) => (isPlausibleValue(llmVal) ? String(llmVal).trim() : baseVal);

  return normalizeTestData({
    fields: mergedFields,
    searchTerm: pick(llmRaw.searchTerm, base.searchTerm),
    verifyText: pick(llmRaw.verifyText, base.verifyText),
    existingRowNeedle: pick(llmRaw.existingRowNeedle, base.existingRowNeedle),
    source: Object.keys(llmFields).length || llmRaw.searchTerm || llmRaw.existingRowNeedle ? 'llm' : base.source,
  }, vocab, intent);
}

/**
 * Extract concrete test values from free-form ask (regex baseline).
 * Maps only to indexed formControls. LLM refine via resolveTestDataFromAsk when available.
 */
export function extractTestData(title, description, vocab = {}, intent = null) {
  const text = stripVerificationPhrases(intent?.combinedAsk || combineAsk(title, description));
  const formControls = vocab.formControls || [];
  const schemaFields = vocab.schemaFields || [];
  const fields = {};
  let searchTerm = null;
  let verifyText = null;
  let existingRowNeedle = null;

  if (!text) {
    return normalizeTestData({}, vocab, intent);
  }

  const identity = pickIdentityFieldFromSchema({ fields: schemaFields });
  const identityKey = identity?.key || formControls.find((c) => !isFilterFormControl(c, vocab)) || null;

  const featureTerms = featureTermsFromContext(intent, vocab.matchedFeature);

  const assign = (fieldName, value) => {
    const v = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!isPlausibleValue(v, featureTerms)) return;
    const fc = mapFieldToFormControl(fieldName, formControls, schemaFields);
    const key = fc || (['name', 'title', 'label'].includes(normFieldKey(fieldName)) ? identityKey : null);
    if (!key) return;
    fields[key] = v;
    if (/search|filter|query/.test(normFieldKey(fieldName)) || /search|filter|query/i.test(key)) {
      searchTerm = v;
    }
  };

  const action = intent?.action || '';
  const quoted = extractQuotedStrings(text);

  // Schema-aware NLP pass (title + description → field values from indexed labels/keys/testIds)
  const nlp = analyzeAskNlp(title, description, {
    formControls,
    schemaFields,
    intent,
    featureTerms,
    matchedFeature: vocab.matchedFeature,
  });
  for (const [k, v] of Object.entries(nlp.fields)) {
    assign(k, v);
  }

  // Regex patterns for edge cases NLP may miss
  extractExplicitFieldValues(text, formControls, schemaFields, (fieldName, value) => assign(fieldName, value));

  // Quoted literals: on update first = row to find, second = new value
  if (quoted.length) {
    if (action === 'update' || action === 'delete') {
      existingRowNeedle = quoted[0];
      searchTerm = searchTerm || quoted[0];
      if (quoted.length >= 2) assign('name', quoted[1]);
    } else if (!fields[identityKey]) {
      assign(identityKey, quoted[0]);
    }
  }

  // Update: "rename to X" / "change name to X" / "from A to B"
  const renameNamed = text.match(/\b(?:rename|change)\s+(\w+)\s+(?:to|as)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b)/i);
  if (renameNamed) {
    assign(renameNamed[1], renameNamed[2]);
  } else {
    const renameBare = text.match(/\b(?:rename|change)\s+(?:to|as)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b)/i);
    if (renameBare) assign(identityKey, renameBare[1]);
  }

  for (const m of text.matchAll(/\bchange\s+(\w+)\s+to\s+([^,;]+?)(?:\s+and\b|\s*$|[,.;])/gi)) {
    assign(m[1], m[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  const fromTo = text.match(/\bfrom\s+['"]?([^'"\n,;]+?)['"]?\s+to\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;])/i);
  if (fromTo) {
    existingRowNeedle = fromTo[1].trim();
    assign(identityKey, fromTo[2]);
    searchTerm = searchTerm || existingRowNeedle;
  }

  // "update with (a) new title X" / "with new name X"
  const updateTitle = text.match(
    /\bupdate\s+with\s+(?:a\s+)?new\s+(?:title|name)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b)/i,
  );
  if (updateTitle) assign(identityKey, updateTitle[1]);

  for (const m of text.matchAll(
    /\b(?:using|with|set)\s+(?:the\s+)?(\w+)\s+(?:to\s+)?['"]([^'"]+)['"]/gi,
  )) {
    assign(m[1], m[2]);
  }
  const usingBare = text.match(
    /\b(?:using|with)\s+(?:the\s+)?name\s+['"]?([A-Za-z0-9][\w\s.-]{0,48}?)['"]?(?:\s*$|[,.;]|\s+and\b|\s+then\b|\s+verify\b)/i,
  );
  if (usingBare && !fields[identityKey] && action !== 'update') {
    const val = usingBare[1].trim();
    if (isPlausibleValue(val)) assign(identityKey, val);
  }

  for (const m of text.matchAll(
    /\b(?:fill|enter|type|input)\s+(?:the\s+)?(\w+)\s+(?:with|as|=)\s+['"]?([^'"\n,;]+?)['"]?(?:\s*$|[,.;]|\s+and\b)/gi,
  )) {
    assign(m[1], m[2]);
  }

  for (const m of text.matchAll(/\b(\w+)\s+['"]([^'"]+)['"]/g)) {
    if (/^(create|add|new|using|with|the|and|or|for|to|a)$/i.test(m[1])) continue;
    assign(m[1], m[2]);
  }

  for (const m of text.matchAll(/\b(\w+)\s*[:=]\s*([^,\n;]+)/g)) {
    if (/^(create|add|new|using|with|the|and|or|for|to|a|http|https)$/i.test(m[1])) continue;
    assign(m[1], m[2]);
  }

    const featureStop = featureTerms;
    if ((action === 'create' || action === 'exercise') && !Object.keys(fields).length
      && !/\b(dropdown|select\s+\w+\s+for)\b/i.test(text)) {
      const usingTail = text.match(
        /\b(?:using|with)\s+(?:the\s+)?(?:name\s+)?(.+?)(?:\s*$|[,.;]|\s+and\b|\s+then\b|\s+verify\b)/i,
      );
      if (usingTail) {
        const val = usingTail[1].replace(/^['"]|['"]$/g, '').trim();
        if (isPlausibleValue(val, featureTerms)) assign(identityKey, val);
      }
      if (!Object.keys(fields).length) {
      let rest = text.replace(/^.*?\b(create|add)\b\s+(?:a|an|the\s+)?/i, '').trim();
      rest = rest.replace(/^(using|with|named|called|name)\s+/i, '').replace(/^['"]|['"]$/g, '').trim();
      const tokens = rest.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        for (let take = Math.min(3, tokens.length - 1); take >= 1; take -= 1) {
          const rawCandidate = tokens.slice(-take).join(' ');
          const candidate = extractValueTail(rawCandidate, featureTerms);
          if (!candidate) continue;
          const firstTok = candidate.split(/\s+/)[0]?.toLowerCase();
          if (featureStop.has(firstTok) && !/\d/.test(candidate)) continue;
          if (/^(using|with)\b/i.test(candidate)) continue;
          const looksLikeValue = /[0-9]/.test(candidate)
            || /^[A-Z]/.test(candidate.split(/\s+/)[0])
            || candidate.split(/\s+/).length === 1;
          if (candidate.length >= 2 && looksLikeValue && isPlausibleValue(candidate, featureTerms)) {
            assign(identityKey, candidate);
            break;
          }
        }
      } else if (tokens.length === 1 && isPlausibleValue(tokens[0], featureTerms) && !featureStop.has(tokens[0].toLowerCase())) {
        assign(identityKey, tokens[0]);
      }
      }
    }

  for (const m of text.matchAll(/\bsearch(?:\s+for|\s+by)?\s+['"]([^'"]+)['"]/gi)) {
    searchTerm = m[1].trim();
  }
  if (!searchTerm) {
    const m = text.match(/\bsearch(?:\s+for|\s+by)?\s+([A-Za-z0-9][\w\s.-]{0,40})(?:\s*$|[,.;]|\s+and\b)/i);
    if (m && isPlausibleValue(m[1], featureTerms)) searchTerm = m[1].replace(/^['"]|['"]$/g, '').trim();
  }

  // Update: "edit retail chain Jay 123 rename to NewCo"
  if (action === 'update' && !existingRowNeedle) {
    const editRename = text.match(
      /\b(?:edit|update|modify)\s+(?:the\s+)?(?:[\w]+\s+)*?['"]?([^'"\n]+?)['"]?\s+rename\s+to\b/i,
    );
    if (editRename) {
      const needle = extractValueTail(editRename[1].trim(), featureTerms) || editRename[1].trim();
      if (needle) {
        existingRowNeedle = needle;
        searchTerm = searchTerm || needle;
      }
    }
  }

  // Update: "update {feature} NEEDLE" — generic (featureTerms from index, not module list)
  if (action === 'update' && !existingRowNeedle && !/\brename\s+to\b/i.test(text)) {
    const parsed = parseUpdateRowNeedleFromAsk(text, featureTerms);
    if (parsed) {
      existingRowNeedle = parsed;
      searchTerm = searchTerm || parsed;
    }
  }

  // Row needle for update/delete/view — quoted, "for X", or "Metro Paris retail chain"
  if (!existingRowNeedle) {
    const forRow = text.match(/\b(?:for|on)\s+(?:the\s+)?(.+?)\s+row\b/i);
    if (forRow?.[1]) existingRowNeedle = normalizeRowNeedle(forRow[1]);
  }
  if (!existingRowNeedle) {
    const forNamed = text.match(
      /\b(?:for|named|called)\s+['"]?([^'"\n,;.]+?)['"]?(?:\s*$|[,.;])/i,
    );
    if (forNamed?.[1]) existingRowNeedle = normalizeRowNeedle(forNamed[1]);
  }
  if (!existingRowNeedle) {
    const entityNamed = text.match(
      /\b(?:modify|edit|update|delete|remove|view)\s+(?:the\s+)?(?:\w+\s+){0,5}?([A-Za-z0-9][\w\s.-]{1,40}?)(?:\s*$|[,.;])/i,
    );
    if (entityNamed?.[1]) {
      const candidate = normalizeRowNeedle(entityNamed[1]);
      if (candidate && !isGrammarOrFeatureTerm(candidate, featureTerms)) {
        existingRowNeedle = candidate;
      }
    }
  }
  if (!existingRowNeedle && searchTerm) existingRowNeedle = searchTerm;
  if ((action === 'update' || action === 'delete' || action === 'view') && existingRowNeedle && !searchTerm) {
    searchTerm = existingRowNeedle;
  }

  for (const m of text.matchAll(/\bverify\s+['"]([^'"]+)['"]/gi)) {
    verifyText = m[1].trim();
  }
  if (!verifyText) {
    const m = text.match(/\bverify\s+([A-Za-z0-9][\w\s.-]{0,40})(?:\s+appears|\s+in|\s+on|\s*$|[,.;])/i);
    if (m && isPlausibleValue(m[1])) verifyText = m[1].trim();
  }

  if (action === 'list' && !searchTerm && fields[identityKey]) searchTerm = fields[identityKey];

  return normalizeTestData({
    fields,
    searchTerm,
    verifyText,
    existingRowNeedle,
    source: 'parser',
  }, vocab, intent);
}

/** Normalize a user-mentioned field key for matching indexed formControls. */
function normFieldKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeInstructionPhrase(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  if (/\b(dropdown|select|checkbox|toggle|button|field|form)\b/.test(t)) return true;
  if (/\bdropdown\s+as\b/.test(t)) return true;
  if (t.split(/\s+/).length > 6) return true;
  return false;
}

/** Outcome/status words — not searchable entity names (LLM sometimes picks "success" from AC wording). */
export function isGenericOutcomePhrase(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  if (/^(success(ful(ly)?)?|saved|created|submitted|done|ok|passed|complete(d)?)$/i.test(t)) return true;
  if (/submitted\s+successfully|saved\s+successfully|created\s+successfully/i.test(t)) return true;
  if (/^(the\s+)?form\s+(can\s+be\s+)?submitted/i.test(t)) return true;
  return false;
}

/** List-view AC wording — not a searchable row value (e.g. "the table is visible"). */
export function isListMetaPhrase(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  if (isGenericOutcomePhrase(t)) return true;
  if (/table\s+(is\s+)?visible|list\s+(table\s+)?(is\s+)?visible|records?\s+(are\s+)?(shown|displayed)|list\s+loads?/i.test(t)) return true;
  if (/verify\s+(the\s+)?(list|table)|browse\s+.*list|open\s+.*list/i.test(t)) return true;
  if (/^(the\s+)?(list|table)(\s+page)?(\s+is\s+visible)?$/i.test(t)) return true;
  return false;
}

/** True when needle matches a concrete filled form value (not a feature word from the ask title). */
export function isExplicitFieldNeedle(needle, resolvedValues = {}) {
  const n = String(needle || '').trim();
  if (!n) return false;
  return Object.values(resolvedValues || {}).some(
    (v) => v != null && v !== '__first__' && String(v).trim() === n,
  );
}

/** Best needle for post-save list search — identity field name, never generic outcome words. */
export function resolveVerifyNeedle(testData = {}, resolvedValues = {}, schema = null) {
  const action = testData.action || '';
  const identity = pickVerifyIdentityFieldFromSchema(schema || testData.formSchema || { fields: [] });
  const identityKey = identity?.key || 'name';

  if (action === 'update') {
    const nameVal = resolvedValues?.name ?? testData.fields?.name;
    if (nameVal) return String(nameVal).trim();
    const changed = (testData.testDataEntries || []).filter((e) => e.source === 'description' && e.value && e.value !== '__first__');
    const prefer = changed.find((e) => e.key === 'name') || changed.find((e) => !/symbol/i.test(e.key)) || changed[0];
    if (prefer?.value) return String(prefer.value).trim();
    if (testData.verifyText && !isGenericOutcomePhrase(testData.verifyText)) {
      return String(testData.verifyText).trim();
    }
    return testData.existingRowNeedle ? String(testData.existingRowNeedle).trim() : null;
  }

  const fromVerify = testData.verifyText && !isGenericOutcomePhrase(testData.verifyText)
    ? String(testData.verifyText).trim()
    : null;
  const fromFields = resolvedValues?.[identityKey] ?? testData.fields?.[identityKey];
  const fromPrimary = testData.primaryField === identityKey ? testData.primaryValue : null;
  const fromEntries = (testData.testDataEntries || []).find((e) => e.key === identityKey)?.value;
  const fromIdentity = (fromFields != null && fromFields !== '' && fromFields !== '__first__' ? String(fromFields).trim() : null)
    || (fromPrimary != null && fromPrimary !== '' ? String(fromPrimary).trim() : null)
    || (fromEntries != null && fromEntries !== '' && fromEntries !== '__first__' ? String(fromEntries).trim() : null);

  if (fromIdentity) return fromIdentity;
  if (fromVerify && isExplicitFieldNeedle(fromVerify, resolvedValues)) return fromVerify;
  return fromVerify || null;
}

function pathTokens(path) {
  return String(path || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\/_.-]+/)
    .filter((w) => w.length >= 2 && !['src', 'app', 'pages', 'components', 'features', 'html', 'component', 'ts', 'tsx'].includes(w));
}

/** Human label from a code path (generic — any folder under pages/Features/components). */
export function featureFromPath(path) {
  const p = String(path || '');
  // Spec / unit-test files are not product features (e.g. vat.service.spec.ts → "Vat.Service.Spec")
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/i.test(p) || /\/(__tests__|testing)\//i.test(p)) {
    const m = p.match(/(?:pages|Features|components|modules|views)\/([^/]+)/i);
    if (m?.[1] && !/^(shared|common|core|layout|ui|utils|helpers|services)$/i.test(m[1])) {
      return m[1]
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }
    return '';
  }
  // Shared enums/DTOs/serializers are not screens (e.g. CurrencyCode.php → must NOT become "Currency Code")
  if (/\/(Shared|Common|Core|Enum|Enums|Dto|DTOs|OpenApi|Serializer|Normalizer|Denormalizer|Chunker|Migration)s?\//i.test(p)) {
    return '';
  }
  const base = p.split('/').pop() || p;
  let name = base
    .replace(/\.(component|page|dialog|service|controller|entity|module)\.[a-z]+$/i, '')
    .replace(/\.(html|ts|tsx|js|jsx|vue|php)$/i, '')
    .replace(/[-_](list|form|detail|edit|create|index|show|table|view)$/i, '');
  const m = p.match(/(?:pages|Features|components|modules|views)\/([^/]+)/i);
  if (m?.[1] && !/^(shared|common|core|layout|ui|utils|helpers|services)$/i.test(m[1])) {
    name = m[1];
  }
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Matched screen';
}

/**
 * Module noun from "create a currency with code EUR…" → "currency"
 * (ignores field values after with/named/called).
 */
export function primarySubjectFromAsk(query) {
  const s = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const m = s.match(
    /\b(?:create|add|new|update|edit|delete|list|open)\s+(?:an?\s+|the\s+)?([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,2})/,
  );
  if (!m?.[1]) return '';
  return m[1]
    .replace(/\s+(with|named|called|using|for|as|and)\b.*/, '')
    .trim();
}

/** Field / value words that should not win feature matching over the module noun. */
const FIELD_LIKE_ASK_TERMS = new Set([
  'code', 'name', 'symbol', 'rate', 'numeric', 'rounding', 'increment', 'euro', 'eur',
  'email', 'phone', 'type', 'status', 'label', 'value', 'amount', 'price', 'qty',
  'quantity', 'description', 'title', 'id', 'uuid', 'test', 'qa',
]);

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const GENERIC_FEATURE_TERMS = new Set([
  'list', 'search', 'filter', 'browse', 'open', 'show', 'display', 'all', 'records',
  'items', 'table', 'rows', 'row', 'view', 'delete', 'remove', 'edit', 'update', 'modify',
  'create', 'add', 'new', 'page', 'screen', 'module', 'management', 'find', 'existing',
]);

/** Score how well a feature name / path matches ask terms (path beats content). */
export function scoreFeatureAgainstAsk(featureName, samplePath, termsAll, askQuery = '') {
  const nameNorm = normalizeKey(featureName);
  const nameToks = String(featureName || '').toLowerCase().split(/\s+/).filter(Boolean);
  const pToks = pathTokens(samplePath);
  const pathNorm = normalizeKey(samplePath);
  let score = 0;
  let pathHits = 0;

  const subject = primarySubjectFromAsk(askQuery || termsAll.join(' '));
  const subjectKey = normalizeKey(subject);

  let domainTerms = termsAll.filter((t) => t && t.length >= 2 && !GENERIC_FEATURE_TERMS.has(t));
  // When ask is "create a currency with code EUR…", ignore field/value words for feature pick
  if (subjectKey) {
    domainTerms = domainTerms.filter((t) => !FIELD_LIKE_ASK_TERMS.has(t) || normalizeKey(t) === subjectKey);
    if (!domainTerms.length) domainTerms = [subject];
  }
  const askNorm = normalizeKey(domainTerms.join(' '));

  for (const t of domainTerms) {
    if (!t || t.length < 2) continue;
    const variants = termVariants(t);
    for (const v of variants) {
      if (nameToks.some((tok) => tok === v || tok.startsWith(v) || v.startsWith(tok))) {
        score += 5;
        pathHits += 1;
      } else if (nameNorm.includes(v)) {
        score += 4;
        pathHits += 1;
      }
      if (pToks.some((tok) => tok === v || tok.startsWith(v) || v.startsWith(tok))) {
        score += 4;
        pathHits += 1;
      } else if (pathNorm.includes(v)) {
        score += 3;
        pathHits += 1;
      }
    }
  }

  // Exact / plural match on the create-subject noun wins hard over "Currency Code" enums
  if (subjectKey) {
    if (nameNorm === subjectKey || nameNorm === `${subjectKey}s` || nameNorm === `${subjectKey}es`) {
      score += 25;
      pathHits += 3;
    } else if (nameNorm.startsWith(subjectKey) && nameNorm.length > subjectKey.length + 2) {
      // "Currency Code" when subject is currency
      score -= 15;
    }
  }

  // Prefer real screens (pages/) over Shared enums
  if (/\/pages\//i.test(samplePath)) score += 6;
  if (/\/Features\/[^/]+\/(Controller|Entity)\//i.test(samplePath)) score += 3;
  if (/\/(Shared|Enum)\//i.test(samplePath)) score -= 20;

  // Compound ask: "retail" + "chain" → retail_chain path
  if (domainTerms.length >= 2) {
    const compound = normalizeKey(domainTerms.join(''));
    if (pathNorm.includes(compound) || nameNorm.includes(compound)) {
      score += 12;
      pathHits += 2;
    }
  }

  // Prefer eco-tax over article-eco-tax when ask is "eco taxes" (no "article")
  if (/article/i.test(pathNorm) && !/article/i.test(askNorm)) score -= 10;
  if (/article/i.test(nameNorm) && !/article/i.test(askNorm)) score -= 8;
  // Prefer primary feature folder over compound siblings (article-eco-tax vs articles)
  if (
    /article[-_]?ecotax|article_ecotax/i.test(pathNorm)
    && /article/i.test(askNorm)
    && !/ecotax|eco-tax|eco\s*tax/i.test(askNorm)
  ) {
    score -= 12;
  }
  // Generic: boost pages/{folder} when ask tokens match that folder stem
  const pageFolder = (samplePath.match(/\/pages\/([^/]+)\//i) || [])[1] || '';
  if (pageFolder) {
    const folderNorm = normalizeKey(pageFolder);
    const askCompact = normalizeKey(askNorm);
    if (
      folderNorm.length >= 4
      && (askCompact.includes(folderNorm) || folderNorm.includes(normalizeKey(domainTerms.join(''))) || domainTerms.some((t) => folderNorm.includes(normalizeKey(t))))
    ) {
      score += 6;
    }
  }
  // Generic *List features when ask has no product-specific noun
  if (/list$/i.test(nameNorm) && domainTerms.length === 0) score -= 12;
  return { score, pathHits };
}

function termInText(hay, termsAll) {
  const h = String(hay || '').toLowerCase();
  return termsAll.some((t) => termVariants(t).some((v) => v.length >= 3 && h.includes(v)));
}

/**
 * Rank indexed features for this ask. Prefer path/name match over loose content hits.
 */
export function rankFeaturesFromChunks(query, chunks) {
  const { base, all } = expandAskTerms(query);
  const byFeature = new Map();

  for (const c of chunks || []) {
    const name = featureFromPath(c.path);
    if (!name || name === 'Matched screen') continue;
    if (/^(Shared|Common|Core|Layout|Auth|Login)$/i.test(name)) continue;
    if (/\.(spec|test)\./i.test(String(c.path || '')) || /\bService\.Spec\b/i.test(name)) continue;
    const key = normalizeKey(name);
    let row = byFeature.get(key);
    if (!row) {
      row = { name, key, paths: new Set(), contentHits: 0, chunks: 0 };
      byFeature.set(key, row);
    }
    row.paths.add(c.path);
    row.chunks += 1;
    if (termInText(`${c.path} ${c.content}`, all)) row.contentHits += 1;
  }

  const ranked = [...byFeature.values()].map((f) => {
    const samplePath = [...f.paths][0];
    const { score: nameScore, pathHits } = scoreFeatureAgainstAsk(
      f.name,
      samplePath,
      all.length ? all : base,
      query,
    );
    // Content-only mentions are weak — don't let them win over a real path match
    const contentBonus = Math.min(f.contentHits, 3) * (pathHits > 0 ? 0.5 : 0.15);
    const score = nameScore + contentBonus;
    return {
      name: f.name,
      score,
      pathHits,
      contentHits: f.contentHits,
      files: f.paths.size,
      paths: [...f.paths].slice(0, 4),
    };
  }).sort((a, b) => b.score - a.score || b.pathHits - a.pathHits);

  return { ranked, base, all };
}

/**
 * Decide: grounded | needs clarification | no match.
 * If user confirmed a feature name, force that pick.
 */
export function evaluateGrounding(query, chunks, { confirmedFeature = null } = {}) {
  const matchedPaths = [...new Set((chunks || []).map((c) => c.path))].slice(0, 12);

  if (!chunks?.length) {
    return {
      ok: false,
      needsClarification: false,
      confidence: 0,
      matchedFeature: null,
      matchedPaths: [],
      candidates: [],
      termHits: {},
      reason: 'no_chunks',
    };
  }

  const { ranked, base, all } = rankFeaturesFromChunks(query, chunks);

  // User already picked from clarification UI
  if (confirmedFeature) {
    const pick = ranked.find((r) => normalizeKey(r.name) === normalizeKey(confirmedFeature))
      || { name: confirmedFeature, score: 10, pathHits: 1, paths: matchedPaths };
    return {
      ok: true,
      needsClarification: false,
      confidence: 0.95,
      matchedFeature: pick.name,
      matchedPaths: pick.paths || matchedPaths,
      candidates: ranked.slice(0, 6),
      termHits: Object.fromEntries(base.map((t) => [t, 1])),
      reason: 'user_confirmed',
      note: `Using your selection: ${pick.name}`,
    };
  }

  if (!base.length) {
    return {
      ok: false,
      needsClarification: true,
      confidence: 0.2,
      matchedFeature: null,
      matchedPaths,
      candidates: ranked.slice(0, 8),
      termHits: {},
      reason: 'broad_ask',
      note: 'Your ask didn’t name a specific screen. Which indexed feature should we test?',
    };
  }

  const top = ranked[0];
  const second = ranked[1];

  // No feature has a path/name hit for the ask nouns → don't invent a plan
  const withPath = ranked.filter((r) => r.pathHits > 0 && r.score >= 3);
  if (!withPath.length) {
    return {
      ok: false,
      needsClarification: true,
      confidence: 0,
      matchedFeature: null,
      matchedPaths,
      candidates: ranked.slice(0, 8),
      termHits: Object.fromEntries(base.map((t) => [t, 0])),
      reason: 'no_path_match',
      note: `I couldn’t find a screen whose name matches “${base.join(' ')}”. Pick the closest indexed feature, or rephrase.`,
    };
  }

  const best = withPath[0];
  const runnerUp = withPath[1];
  const ambiguous = runnerUp && best.score > 0 && (best.score - runnerUp.score) < 2.5 && runnerUp.pathHits > 0;
  const weak = best.score < 4;

  if (ambiguous || weak) {
    return {
      ok: false,
      needsClarification: true,
      confidence: Math.min(0.55, best.score / 12),
      matchedFeature: null,
      matchedPaths: best.paths || matchedPaths,
      candidates: withPath.slice(0, 6),
      termHits: Object.fromEntries(base.map((t) => [t, 1])),
      reason: ambiguous ? 'ambiguous' : 'weak_match',
      note: ambiguous
        ? `I’m not sure which screen you mean for “${base.join(' ')}”. Please pick one:`
        : `I’m not confident “${base.join(' ')}” maps cleanly. Please confirm the feature:`,
    };
  }

  const confidence = Math.min(1, 0.45 + best.score / 14 + best.pathHits * 0.08);
  return {
    ok: true,
    needsClarification: false,
    confidence,
    matchedFeature: best.name,
    matchedPaths: best.paths || matchedPaths,
    candidates: withPath.slice(0, 5),
    termHits: Object.fromEntries(base.map((t) => [t, 1])),
    reason: 'grounded',
    note: `Matched indexed feature “${best.name}” from your ask.`,
  };
}

/** Keep chunks for the confirmed/matched feature, or ask-overlap. */
export function filterChunksToAsk(query, chunks, { confirmedFeature = null, matchedFeature = null } = {}) {
  const feature = confirmedFeature || matchedFeature;
  if (feature && chunks?.length) {
    const key = normalizeKey(feature);
    const byName = chunks.filter((c) => normalizeKey(featureFromPath(c.path)) === key);
    if (byName.length) return byName;
  }

  const { all } = expandAskTerms(query);
  if (!all.length || !chunks?.length) return chunks || [];
  return chunks.filter((c) => {
    const hay = `${c.path} ${c.content}`.toLowerCase();
    const pToks = pathTokens(c.path);
    return all.some((t) => termVariants(t).some((v) => {
      if (v.length < 3) return false;
      return pToks.some((p) => p === v || p.includes(v) || v.includes(p)) || hay.includes(v);
    }));
  });
}

/**
 * Suggest real feature folders from the index (optionally ranked vs ask).
 * Collects ALL paths per feature (not just one sample).
 */
export async function suggestIndexedFeatures(projectId, layers, limit = 12, query = '') {
  const rows = await prisma.codeChunk.findMany({
    where: { projectId },
    select: { path: true },
    distinct: ['path'],
    take: 2000,
  });

  const counts = new Map();
  const pathsByFeat = new Map();
  for (const { path } of rows) {
    if (layers?.length && !layers.includes(layerOf(path))) continue;
    const feat = featureFromPath(path);
    if (!feat || feat === 'Matched screen') continue;
    if (/^(Shared|Common|Core|Layout|Auth|Login)$/i.test(feat)) continue;
    counts.set(feat, (counts.get(feat) || 0) + 1);
    if (!pathsByFeat.has(feat)) pathsByFeat.set(feat, []);
    const list = pathsByFeat.get(feat);
    if (list.length < 8) list.push(path);
  }

  let list = [...counts.entries()].map(([name, files]) => ({
    name,
    files,
    paths: pathsByFeat.get(name) || [],
  }));

  if (query?.trim()) {
    const { all } = expandAskTerms(query);
    list = list
      .map((f) => {
        const { score, pathHits } = scoreFeatureAgainstAsk(f.name, f.paths[0] || f.name, all, query);
        return { ...f, score, pathHits };
      })
      .sort((a, b) => b.score - a.score || b.pathHits - a.pathHits || b.files - a.files);
  } else {
    list.sort((a, b) => b.files - a.files);
  }

  return list.slice(0, limit);
}

/**
 * Resolve the best indexed feature for an ask from the FULL catalog
 * (not only the few RAG chunks). Auto-match when clear; otherwise clarify.
 */
export function pickFeatureFromCatalog(query, catalog, { confirmedFeature = null } = {}) {
  const { base } = expandAskTerms(query);
  const label = base.join(' ') || 'your ask';

  if (confirmedFeature) {
    const hit = catalog.find((c) => normalizeKey(c.name) === normalizeKey(confirmedFeature));
    return {
      ok: true,
      needsClarification: false,
      matchedFeature: hit?.name || confirmedFeature,
      confidence: 0.95,
      candidates: catalog.slice(0, 6),
      reason: 'user_confirmed',
      note: `Using your selection: ${hit?.name || confirmedFeature}`,
      paths: hit?.paths || [],
    };
  }

  if (!base.length) {
    return {
      ok: false,
      needsClarification: true,
      matchedFeature: null,
      confidence: 0.2,
      candidates: catalog.slice(0, 8),
      reason: 'broad_ask',
      note: 'Your ask didn’t name a specific screen. Which indexed feature should we test?',
      paths: [],
    };
  }

  const strong = catalog.filter((c) => (c.pathHits || 0) > 0 && (c.score || 0) >= 3);
  if (!strong.length) {
    return {
      ok: false,
      needsClarification: true,
      matchedFeature: null,
      confidence: 0,
      candidates: catalog.slice(0, 8),
      reason: 'no_path_match',
      note: `I couldn’t find a screen whose name matches “${label}”. Pick the closest indexed feature, or rephrase.`,
      paths: [],
    };
  }

  const best = strong[0];
  const second = strong[1];
  const ambiguous = second && (best.score - second.score) < 2.5;

  if (ambiguous) {
    return {
      ok: false,
      needsClarification: true,
      matchedFeature: null,
      confidence: Math.min(0.55, best.score / 12),
      candidates: strong.slice(0, 6),
      reason: 'ambiguous',
      note: `I’m not sure which screen you mean for “${label}”. Please pick one:`,
      paths: best.paths || [],
    };
  }

  return {
    ok: true,
    needsClarification: false,
    matchedFeature: best.name,
    confidence: Math.min(1, 0.5 + best.score / 14),
    candidates: strong.slice(0, 5),
    reason: 'grounded',
    note: `Matched indexed feature “${best.name}” from your ask.`,
    paths: best.paths || [],
  };
}

/** Load code chunks for a resolved feature name (any page — no hardcoding). */
export async function loadChunksForFeature(projectId, featureName, layers, take = 28, seedPaths = []) {
  if (!featureName) return [];
  const key = normalizeKey(featureName);
  const folder = resolvedFeatureFolder(featureName, seedPaths);

  let rows = [];
  const selectSql = `SELECT c.id, c.path, c."startLine", c."endLine", c.language, c.content, c."repoId", r.name AS "repoName"
         FROM "CodeChunk" c
         LEFT JOIN "Repo" r ON r.id = c."repoId"
         WHERE c."projectId" = $1`;

  // 1) Exact pages/ folder — avoids broad "%tax%" matching unrelated modules
  if (folder) {
    try {
      rows = await prisma.$queryRawUnsafe(
        `${selectSql} AND c.path ILIKE $2
         ORDER BY c.path, c."startLine"
         LIMIT 120`,
        projectId,
        `%/pages/${folder}/%`,
      );
    } catch (e) {
      console.warn('[ground] feature folder query failed:', e.message);
    }
  }

  // 2) Catalog seed paths from user pick / ranker
  if (!rows.length && seedPaths?.length) {
    try {
      const paths = [...new Set(seedPaths)].slice(0, 12);
      const clauses = paths.map((_, i) => `c.path = $${i + 2}`);
      rows = await prisma.$queryRawUnsafe(
        `${selectSql} AND (${clauses.join(' OR ')})
         ORDER BY c.path, c."startLine"
         LIMIT 120`,
        projectId,
        ...paths,
      );
    } catch (e) {
      console.warn('[ground] feature seed path query failed:', e.message);
    }
  }

  // 3) Last resort: feature label from path (never loose token OR on path)
  if (!rows.length) {
    try {
      rows = await prisma.codeChunk.findMany({
        where: { projectId },
        orderBy: { startLine: 'asc' },
        take: 800,
        include: { repo: { select: { name: true } } },
      });
      rows = rows
        .filter((row) => normalizeKey(featureFromPath(row.path)) === key)
        .map((row) => ({ ...row, repoName: row.repo?.name || '' }));
    } catch (e) {
      console.warn('[ground] feature name scan failed:', e.message);
    }
  }

  const matched = rows.filter((row) => {
    if (layers?.length && !layers.includes(layerOf(row.path))) return false;
    if (folder && pathInFeatureFolder(row.path, folder)) return true;
    return normalizeKey(featureFromPath(row.path)) === key;
  });

  matched.sort((a, b) => rankFeaturePath(a.path) - rankFeaturePath(b.path) || a.startLine - b.startLine);

  return matched.slice(0, take).map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    language: row.language,
    content: row.content,
    repoId: row.repoId,
    repoName: row.repoName || row.repo?.name || '',
    score: 2,
    method: 'feature-load',
    layer: layerOf(row.path),
  }));
}

/**
 * If matched chunks lack a detail/form template, pull detail paths from the index (all modules).
 */
export async function ensureFormChunksForFeature(projectId, featureName, chunks = [], layers = [], take = 12) {
  const folder = primaryFeatureFolder(chunks, featureName);
  if (hasFeatureDetailChunk(chunks, featureName)) return chunks;

  const slug = featureSlugFromName(featureName);
  const folderLike = folder || slug;
  if (!folderLike) return chunks;

  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.path, c."startLine", c."endLine", c.language, c.content, c."repoId", r.name AS "repoName"
       FROM "CodeChunk" c
       LEFT JOIN "Repo" r ON r.id = c."repoId"
       WHERE c."projectId" = $1
         AND path ILIKE $2
         AND (path ILIKE '%details%' OR path ILIKE '%-form.%' OR path ILIKE '%/form/%'
              OR (path ILIKE '%.component.html' AND path NOT ILIKE '%-list.component.html'))
       ORDER BY c.path, c."startLine"
       LIMIT 80`,
      projectId,
      `%/pages/${folderLike}/%`,
    );
  } catch (e) {
    console.warn('[ground] ensureFormChunks query failed:', e.message);
    return chunks;
  }

  const existing = new Set((chunks || []).map((c) => `${c.path}:${c.startLine}`));
  const extra = rows
    .filter((row) => !layers?.length || layers.includes(layerOf(row.path)))
    .filter((row) => isDetailChunkPath(row.path))
    .filter((row) => pathInFeatureFolder(row.path, folderLike))
    .filter((row) => !existing.has(`${row.path}:${row.startLine}`))
    .slice(0, take)
    .map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      language: row.language,
      content: row.content,
      repoId: row.repoId,
      repoName: row.repoName || '',
      score: 2.5,
      method: 'form-ensure',
      layer: layerOf(row.path),
    }));

  return extra.length ? [...extra, ...chunks] : chunks;
}

/** Extract allowlisted tokens from code so the LLM cannot invent app words. */
export function extractCodeVocabulary(codeContext) {
  const text = String(codeContext || '');
  const paths = [...text.matchAll(/([\w./-]+\.(?:html|ts|tsx|jsx|vue|php|java)):(\d+)-(\d+)/g)]
    .map((m) => m[1]);
  const clicks = [...text.matchAll(/\(click\)\s*=\s*"(\w+)\(/g)].map((m) => m[1]);
  const forms = [...text.matchAll(/formControlName\s*=\s*"(\w+)"/g)].map((m) => m[1]);
  const i18n = [
    ...text.matchAll(/\{\{\s*['"]([^'"]+)['"]\s*\|\s*translate/g),
    ...text.matchAll(/translate\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  const perms = [...text.matchAll(/'([A-Z][A-Z0-9_]{4,})'/g)].map((m) => m[1]);
  const routes = [...text.matchAll(/#\[Route\('([^']+)'/g)].map((m) => m[1]);
  const methods = [...text.matchAll(/(?:function|async\s+function)\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const components = [...text.matchAll(/([\w-]+)\.component\.(html|ts)/g)].map((m) => m[1]);
  const testIds = [...text.matchAll(/data-testid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const propTestIds = [
    ...text.matchAll(/\btestId\s*=\s*"([^"]+)"/g),
    ...text.matchAll(/\btestId\s*=\s*'([^']+)'/g),
    ...text.matchAll(/searchTestId\s*=\s*"([^"]+)"/g),
    ...text.matchAll(/searchTestId\s*=\s*'([^']+)'/g),
  ].map((m) => m[1]);
  const requiredFields = [...text.matchAll(/(\w+)\s*:\s*\[[^\]]*Validators\.required/g)].map((m) => m[1]);
  const detailForms = forms.filter((fc) => !isFilterFormControl(fc));

  return {
    paths: [...new Set(paths)].slice(0, 12),
    clicks: [...new Set(clicks)],
    formControls: [...new Set(detailForms.length ? detailForms : forms)],
    requiredFields: [...new Set(requiredFields)],
    labels: [...new Set(i18n)].slice(0, 40),
    permissions: [...new Set(perms)].slice(0, 30),
    routes: [...new Set(routes)],
    methods: [...new Set(methods)].slice(0, 40),
    components: [...new Set(components)],
    testIds: [...new Set([...testIds, ...propTestIds])],
  };
}

/** Build automation field steps from schema + resolved values (wraps formSchema). */
export function inferRequiredFormFields(vocab = {}, testData = {}, entityStem = '', codeContext = '') {
  const schema = extractFormSchema(codeContext, { entityStem });
  if (!schema.fields.length) return [];
  const values = resolveFormFieldValues(schema, testData, {
    featurePrefix: entityStem || 'Auto',
    action: 'create',
  });
  return buildFormAutomationFields(schema, values, entityStem);
}

/** Apply schema defaults on top of parsed/LLM test data. */
export function applyFormSchemaDefaults(codeContext, testData, { entityStem = '', action = 'create', featurePrefix = '' } = {}) {
  const schema = extractFormSchema(codeContext, { entityStem });
  if (!schema.fields.length) return testData;
  const ctx = { action, featurePrefix: featurePrefix || entityStem || 'Auto' };
  const { values, entries } = resolveFormFieldValuesWithSources(schema, testData, ctx);
  const identity = pickIdentityFieldFromSchema(schema);
  return {
    ...testData,
    fields: values,
    testDataEntries: entries,
    primaryField: testData.primaryField || identity?.key || schema.fields[0]?.key || null,
    primaryValue: testData.primaryValue || (identity ? values[identity.key] : null) || Object.values(values)[0] || null,
    verifyText: testData.verifyText || (identity ? values[identity.key] : null) || testData.primaryValue || null,
    formSchema: schema,
  };
}
