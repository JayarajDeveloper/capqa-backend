// Server-side LLM + code-grounded generators.
// STRICT RAG: indexed chunks only. Test case generation REQUIRES a live LLM key (no parser-only compose).

import { env } from '../env.js';
import {
  extractCodeVocabulary,
  featureFromPath,
  extractTestData,
  combineAsk,
  mergeTestData,
  entityStemFromVocab,
} from './rag/ground.js';
import { prepareModuleTestCase, enrichVocabFromSchema, buildAcceptanceCriteriaFromSteps } from './rag/testCasePipeline.js';
import { buildFieldCatalog } from './rag/askAnalyzer.js';
import { extractModuleCapabilities, assessComposeFeasibility, normalizeRowNeedle } from './rag/codeSignals.js';
import { buildUiAutomationFromAiPlan, validateAiExecutionPlan } from './automation/aiAutomation.js';
import { extractRouteHints } from './automation/codegen.js';

const DEFAULT_MODELS = {
  anthropic: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
};

export const LLM_KEY_REQUIRED_MSG = 'An Anthropic API key is required to generate test cases. Set ANTHROPIC_API_KEY in the backend .env, or add an Anthropic key in Settings.';

/** True when compose may call a live model (project key or .env fallback). */
export function isLlmReady(provider, apiKey) {
  return Boolean(provider === 'anthropic' && apiKey);
}

function assertLlmReady(provider, apiKey) {
  if (!isLlmReady(provider, apiKey)) {
    const err = new Error(LLM_KEY_REQUIRED_MSG);
    err.code = 'LLM_KEY_REQUIRED';
    throw err;
  }
}

function uid(prefix = 'tc') { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '');
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  try { return JSON.parse(m ? m[0] : cleaned); } catch { return null; }
}

function normalizeCase(c) {
  return {
    id: uid('tc'),
    title: c.title || 'Untitled case',
    type: c.type || 'Functional',
    priority: c.priority || 'P2',
    steps: Array.isArray(c.steps) ? c.steps : String(c.steps || '').split('\n').filter(Boolean),
    expected: c.expected || '',
    sourceRefs: Array.isArray(c.sourceRefs) ? c.sourceRefs : [],
    status: 'pending',
    lastRun: null, durationMs: null, log: null,
  };
}

const SYSTEM_API = `You are a senior QA engineer. Generate API/backend test cases STRICTLY from retrieved source-code chunks (RAG index).

HARD RULES — ZERO INVENTION:
1. ONLY endpoints, permissions, fields, validations that appear in CODE CHUNKS or ALLOWED VOCABULARY.
2. Do NOT invent product names, domains, or behaviors not in the code.
3. Ignore the user's wording when it conflicts with the code — the code wins.
4. Every case MUST include sourceRefs from the chunks (path:start-end).
5. Return ONLY JSON: {"testCases":[{"title","type","priority","steps","expected","sourceRefs"}]}.`;

const SYSTEM_TEST_DATA = `You extract concrete test values from a user's natural-language QA ask — STRICTLY grounded in indexed UI code.

HARD RULES:
1. ONLY use field keys from formControls in ALLOWED VOCABULARY (e.g. name, searchTerm). Never invent fields.
2. ONLY extract values explicitly stated or clearly implied in the USER ASK. Never invent names, emails, or search terms.
3. Ignore verification phrasing as data: "or not", "check whether", "verify if" are NOT values.
4. For update/edit: existingRowNeedle = row to find (often first quoted value); fields.name = new value if given.
5. For create: fields.name = the value to type in the primary name/title field.
6. searchTerm = list search/filter value when user wants to find a row or filter a list.
7. verifyText = the created entity NAME (e.g. partner name from PREPARED TEST DATA). NEVER use "success", "saved", or "submitted successfully".
8. NEVER map values to filter controls: activeOnly, searchTerm, search, filter, query.
9. For create flows, fields.name is the primary identity field unless user specifies code.
10. Field-specific phrases: "country dropdown as France" → fields.country = "France" (NOT name).
11. Map values ONLY to fields listed in INDEXED FORM FIELDS (key, label, testId from code).
12. Use testId from code for automation — never invent selectors.
13. Return ONLY JSON:
{
  "fields": { "name": "optional" },
  "searchTerm": "optional or null",
  "verifyText": "optional or null",
  "existingRowNeedle": "optional or null"
}`;

const SYSTEM_UI = `You are a senior QA writing a SHORT MANUAL UI browser test plan AND a Playwright execution plan — STRICTLY from RAG-retrieved frontend code.

WORKFLOW (follow in order):
1. LEARN from CODE CHUNKS: form fields, testIds, buttons, routes.
2. ANALYZE title + description: map intent to the learned UI.
3. WRITE a concise manual test (max ~10 steps) using PREPARED TEST DATA exactly.
4. WRITE executionPlan steps using ONLY testIds/formControls from INDEXED FORM FIELDS.
5. Keep acceptanceCriteria SHORT (3–5 items max) — outcomes only, not one AC per field.

HARD RULES — ZERO INVENTION:
1. ONLY screens, buttons, formControlName, data-testid, routes from CODE CHUNKS or ALLOWED VOCABULARY.
2. Manual steps: plain language (Navigate → Click Add → Enter/Select → Save → Verify).
   UPDATE/EDIT: Search → Edit row → change ONLY the fields in PREPARED TEST DATA → Save → Verify. Never Click Add/Create. Never re-fill code/identity fields the user did not mention.
3. DROPDOWNS: select the first option unless PREPARED TEST DATA / user ask names a specific value — then use that value.
4. Use PREPARED TEST DATA values exactly in manual steps and executionPlan.
5. OBEY businessRules and validators — never invent values that fail Angular validation.
6. route MUST come from ALLOWED VOCABULARY routes or path: in code chunks.
7. Return ONLY JSON:
{
  "uiPlan": {
    "title": "string — short test case title",
    "runAs": "UI · Browser",
    "steps": ["1. ...", "2. ..."],
    "acceptanceCriteria": [{"id":"AC1","requirement":"...","proof":"..."}],
    "sourceRefs": ["path:lines"]
  },
  "executionPlan": {
    "action": "create|update|list|delete|exercise",
    "route": "/from-code",
    "steps": [
      {"id":"goto","action":"goto","path":"/route","description":"..."},
      {"id":"click-create","action":"click","testId":"from-code","description":"..."},
      {"id":"fill-name","action":"fill","formControl":"name","testId":"from-code","value":"exact value","description":"..."},
      {"id":"select-country","action":"select","formControl":"country","testId":"from-code","value":"__first__","description":"Select first option"},
      {"id":"click-save","action":"click","testId":"from-code","description":"..."},
      {"id":"expect-text","action":"expectText","text":"verify value","description":"..."}
    ]
  },
  "testCases": []
}`;

async function callLLM({ provider, apiKey, model, system, user }) {
  if (provider !== 'anthropic') {
    throw new Error('Only Anthropic is supported. Set provider to anthropic.');
  }
  const m = model || DEFAULT_MODELS.anthropic;
  const base = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const url = `${base}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: m,
      max_tokens: 8192,
      temperature: 0.1,
      system: system || undefined,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw await httpErr('Anthropic', res);
  const data = await res.json();
  return (data.content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('') || '';
}

async function httpErr(name, res) {
  const t = await res.text().catch(() => '');
  const e = new Error(`${name} ${res.status}: ${t.slice(0, 200)}`);
  e.status = res.status;
  return e;
}

function vocabBlock(vocab) {
  return (
    `ALLOWED VOCABULARY (use ONLY these app-specific terms — nothing else from the product domain):\n` +
    `paths: ${(vocab.paths || []).join(', ') || '(none)'}\n` +
    `components: ${(vocab.components || []).join(', ') || '(none)'}\n` +
    `click handlers: ${(vocab.clicks || []).join(', ') || '(none)'}\n` +
    `formControls: ${(vocab.formControls || []).join(', ') || '(none)'}\n` +
    `i18n labels: ${(vocab.labels || []).join(', ') || '(none)'}\n` +
    `permissions: ${(vocab.permissions || []).join(', ') || '(none)'}\n` +
    `routes: ${(vocab.routes || []).join(', ') || '(none)'}\n` +
    `methods: ${(vocab.methods || []).slice(0, 25).join(', ') || '(none)'}\n`
  );
}

function promptApi(title, description, codeContext, matchedFeature) {
  const vocab = extractCodeVocabulary(codeContext);
  return (
    `User ask (may be wrong/vague — CODE WINS): ${title || '(none)'}\n` +
    `Details: ${description || '(none)'}\n` +
    `Matched indexed feature: ${matchedFeature || '(from paths)'}\n\n` +
    `${vocabBlock(vocab)}\n` +
    `CODE CHUNKS:\n${codeContext}\n\n` +
    `Generate API test cases only from this code and allowlist.`
  );
}

function promptTestData(title, description, codeContext, intent, vocab, baseline) {
  const combinedAsk = intent?.combinedAsk || combineAsk(title, description);
  const catalog = buildFieldCatalog(vocab.schemaFields || [], vocab.formControls || []);
  const fieldBlock = catalog.length
    ? `\nINDEXED FORM FIELDS (map user phrases to these keys only — use testId for automation):\n${
      JSON.stringify(catalog.map((f) => ({
        key: f.key, label: f.label, testId: f.testId, type: f.type, required: f.required,
      })), null, 2)}\n`
    : '';
  return (
    `USER ASK — analyze title + description with NLP; extract values ONLY from this text:\n`
    + `Title: ${title || '(none)'}\n`
    + `Description: ${description || '(none)'}\n`
    + `Combined: ${combinedAsk}\n\n`
    + `Parsed action: ${intent?.action || 'exercise'}\n`
    + `Regex/NLP baseline (refine using title + description):\n${JSON.stringify(baseline, null, 2)}\n`
    + `${fieldBlock}`
    + `${vocabBlock(vocab)}\n`
    + `UI CODE CHUNKS (field keys must match indexed form fields above):\n${codeContext}\n\n`
    + `Extract test data JSON mapped to indexed field keys only.`
  );
}

/**
 * AI analyzes the free-form ask + indexed code to extract test values.
 * Requires a live LLM — no parser-only fallback.
 */
export async function resolveTestDataFromAsk({
  provider, apiKey, model, title, description, codeContext, intent, vocab, baseline,
}) {
  assertLlmReady(provider, apiKey);

  const prepared = prepareModuleTestCase({ codeContext, vocab });
  const enrichedVocab = prepared.enrichedVocab;
  const base = baseline || extractTestData(
    intent?.rawTitle ?? title,
    intent?.rawDescription ?? description,
    enrichedVocab,
    intent,
  );

  const raw = await callLLM({
    provider,
    apiKey,
    model,
    system: SYSTEM_TEST_DATA,
    user: promptTestData(title, description, codeContext, intent, enrichedVocab, base),
  });
  const parsed = extractJSON(raw);
  if (parsed && typeof parsed === 'object') {
    const merged = mergeTestData(base, parsed, enrichedVocab, intent);
    return prepareModuleTestCase({
      codeContext,
      title: intent?.rawTitle ?? title,
      description: intent?.rawDescription ?? description,
      matchedFeature: intent?.matchedFeature || '',
      intent: { ...intent, testData: merged },
      vocab: enrichedVocab,
    }).testData;
  }

  return base;
}

function formatSchemaBlock(prepared) {
  const fields = prepared?.schema?.fields || [];
  if (!fields.length) return '';
  const withRules = fields.filter((f) => f.testId || f.required);
  return (
    `\nLEARNED FORM SCHEMA + BUSINESS RULES (from indexed HTML/TS — MUST obey for test data, steps, executionPlan):\n${
      JSON.stringify(withRules.map((f) => ({
        key: f.key,
        label: f.label,
        testId: f.testId,
        type: f.type,
        componentType: f.componentType,
        required: f.required,
        validators: f.validators || {},
        businessRules: f.businessRules || [],
        wrapperTag: f.wrapperTag,
      })), null, 2)}\n`
  );
}

function isGenericFillStep(step) {
  const s = String(step || '').toLowerCase();
  return /fill in all required|valid data|all required form fields/.test(s);
}

function stripStepNum(step) {
  return String(step || '').replace(/^\d+\.\s*/, '').trim();
}

function normToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a prepared field already appears in the manual steps (key, label, or value). */
function entryCoveredInSteps(stepsBlobNorm, entry) {
  const key = normToken(entry.key);
  const label = normToken(entry.label);
  if (key && stepsBlobNorm.includes(key)) return true;
  if (label && label.length > 2 && stepsBlobNorm.includes(label)) return true;
  const val = entry.value && entry.value !== '__first__' ? String(entry.value) : '';
  if (val && stepsBlobNorm.includes(normToken(val))) return true;
  return false;
}

/**
 * Keep ONE short manual case: navigate → open form → prepared fills → save → verify.
 * Never append prepared fills on top of an AI plan that already entered the same fields.
 */
export function mergePreparedFormSteps(uiPlan, prepared, intent = null) {
  const action = intent?.action || prepared?.action || 'create';
  const feature = prepared?.featurePrefix
    || intent?.matchedFeature
    || uiPlan?.ask?.matchedFeature
    || 'feature';
  const entries = prepared?.testData?.testDataEntries || uiPlan?.testDataEntries || [];
  const base = {
    ...uiPlan,
    schemaLearned: Boolean(prepared?.schema?.fields?.length),
    testDataEntries: entries.length ? entries : uiPlan?.testDataEntries,
  };

  if (action === 'list' || action === 'delete' || action === 'view') {
    return base;
  }

  const fillLines = (prepared?.manualFillLines || [])
    .map(stripStepNum)
    .filter((s) => s && !/save or submit|identify and click the save/i.test(s));
  if (!fillLines.length || !uiPlan?.steps?.length) return base;

  const rawSteps = (uiPlan.steps || []).map(stripStepNum).filter(Boolean);
  const blobNorm = normToken(rawSteps.join(' '));
  const hasGeneric = rawSteps.some(isGenericFillStep);
  const concreteFills = rawSteps.filter((s) => /^(enter|select)\b/i.test(s));
  const covered = entries.length
    ? entries.filter((e) => entryCoveredInSteps(blobNorm, e)).length
    : 0;
  const coverage = entries.length ? covered / entries.length : 1;

  const looksLikeCreateFlow = rawSteps.some((s) => /click.*\b(add|create|new)\b/i.test(s));
  const skipAiKeep = action === 'update' && looksLikeCreateFlow;

  // AI (or prior) plan already has the field values — keep it, just dedupe / trim
  if (!skipAiKeep && !hasGeneric && concreteFills.length >= 2 && coverage >= 0.6) {
    const seen = new Set();
    const deduped = [];
    for (const s of rawSteps) {
      const k = normToken(s);
      if (/^wait for the create or edit form/i.test(s) && deduped.some((x) => /^(enter|select)\b/i.test(x))) {
        continue;
      }
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(s);
    }
    // Drop trailing duplicate fill blocks after Save/Verify
    const saveIdx = deduped.findIndex((s) => /click.*save|save or submit/i.test(s));
    let trimmed = deduped;
    if (saveIdx >= 0) {
      const before = deduped.slice(0, saveIdx + 1);
      const after = deduped.slice(saveIdx + 1).filter((s) => !/^(enter|select|wait for the create)\b/i.test(s));
      // One verify line is enough
      const verifies = after.filter((s) => /^verify\b/i.test(s));
      const other = after.filter((s) => !/^verify\b/i.test(s));
      const verifyVal = prepared?.testData?.verifyText || prepared?.testData?.primaryValue;
      const oneVerify = verifyVal
        ? [`Verify "${verifyVal}" appears in the list.`]
        : verifies.slice(0, 1);
      trimmed = [...before, ...other, ...oneVerify];
    }
    return {
      ...base,
      steps: trimmed.map((s, i) => `${i + 1}. ${s}`),
    };
  }

  // Rebuild a short canonical manual case from prepared data
  const nav = rawSteps.find((s) => /^navigate\b/i.test(s))
    || `Navigate to the ${feature} list.`;
  const rowNeedle = prepared?.testData?.existingRowNeedle || prepared?.testData?.searchTerm;
  const open = action === 'update'
    ? (rawSteps.find((s) => /click.*edit|open.*edit|search for/i.test(s))
      || (rowNeedle
        ? `Search for "${rowNeedle}" and click Edit on that row.`
        : 'Search for the existing record and click Edit.'))
    : (rawSteps.find((s) => /click.*(add|create|new)|open the (create|edit) form/i.test(s))
      || 'Click Add / Create to open the form.');
  const verifyVal = prepared?.testData?.verifyText || prepared?.testData?.primaryValue;
  const verify = rawSteps.find((s) => /^verify\b/i.test(s) && verifyVal && s.includes(verifyVal))
    || (verifyVal
      ? `Verify "${verifyVal}" appears in the list.`
      : (rawSteps.find((s) => /^verify\b/i.test(s)) || 'Verify the record appears in the list.'));

  const body = fillLines.filter((s) => !/^navigate\b/i.test(s) && !/^verify\b/i.test(s) && !/save or submit|identify and click the save/i.test(s));
  const merged = [
    nav,
    open,
    ...body,
    'Click Save.',
    verify,
  ].filter(Boolean);

  const seen = new Set();
  const unique = merged.filter((s) => {
    const k = normToken(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    ...base,
    steps: unique.map((s, i) => `${i + 1}. ${s}`),
  };
}

function formatPreparedTestDataBlock(testData) {
  if (!testData || typeof testData !== 'object') return '';
  const payload = {
    entries: (testData.testDataEntries || []).map((e) => {
      const isFirst = e.kind === 'select' && (!e.value || e.value === '__first__');
      return {
        field: e.key,
        label: e.label,
        value: isFirst ? '(first dropdown option)' : e.value,
        source: e.source,
        required: e.required,
      };
    }),
    searchTerm: testData.searchTerm || null,
    verifyText: testData.verifyText || null,
    existingRowNeedle: testData.existingRowNeedle || null,
    primaryValue: testData.primaryValue || null,
  };
  if (!payload.entries.length && !payload.searchTerm && !payload.verifyText && !payload.primaryValue) {
    return '';
  }
  return (
    `\nPREPARED TEST DATA (use these EXACT values in Enter/Select/Search/Verify steps — `
    + `dropdowns: first option unless a named value is listed; `
    + `UPDATE: only fill listed fields — do not invent code/numeric values; search existingRowNeedle to find the row; `
    + `from user description or code-derived defaults for required fields on CREATE only):\n`
    + `${JSON.stringify(payload, null, 2)}\n`
  );
}

function promptUi(title, description, codeContext, matchedFeature, intent, testData, enrichedVocab, prepared = null) {
  const vocab = enrichedVocab || extractCodeVocabulary(codeContext);
  const dataBlock = formatPreparedTestDataBlock(testData);
  const catalog = buildFieldCatalog(vocab.schemaFields || [], vocab.formControls || []);
  const fieldBlock = catalog.length
    ? `\nINDEXED FORM FIELDS (use ONLY these for fill/select/executionPlan — testId required):\n${
      JSON.stringify(catalog.map((f) => ({
        key: f.key, label: f.label, testId: f.testId, type: f.type, required: f.required,
      })), null, 2)}\n`
    : '';
  const schemaBlock = formatSchemaBlock(prepared);
  const suggestedRoute = extractRouteHints(codeContext, matchedFeature);
  return (
    `User ask (may be wrong/vague — CODE WINS): ${title || '(none)'}\n` +
    `Details: ${description || '(none)'}\n` +
    `Parsed intent: action=${intent?.action || 'exercise'}; focus notes=${(intent?.notes || []).join(',') || 'none'}\n` +
    `Matched indexed feature: ${matchedFeature || '(derive from paths)'}\n` +
    `Suggested route from code: ${suggestedRoute}\n` +
    `Shape manual steps AND executionPlan for action "${intent?.action || 'exercise'}".${dataBlock}${fieldBlock}${schemaBlock}\n` +
    `${vocabBlock(vocab)}\n` +
    `data-testids: ${(vocab.testIds || []).join(', ') || '(none)'}\n\n` +
    `UI CODE CHUNKS:\n${codeContext}\n\n` +
    `Write a user-friendly manual test case AND a grounded executionPlan JSON.`
  );
}

/**
 * Main compose generator. Returns { cases, uiPlan }.
 * Requires a live LLM — parser output is only used as grounded context for the model.
 */
export async function generateComposeArtifacts({ provider, apiKey, model, title, description, options, codeContext, uiContext, apiContext, matchedFeature, intent }) {
  assertLlmReady(provider, apiKey);

  const layers = (options?.layers || []).map((l) => String(l).toLowerCase());
  const wantsUi = !layers.length || layers.includes('ui');
  const wantsApi = !layers.length || layers.includes('backend') || layers.includes('database');

  let cases = [];
  let uiPlan = null;
  let uiAutomation = null;
  let uiAiAuthored = false;
  const featureName = matchedFeature || featureFromPath(
    (uiContext || codeContext || '').match(/([\w./-]+\.(?:html|ts|tsx)):\d+/)?.[1] || '',
  );

  const ctx = uiContext || codeContext || '';
  const capsCtx = [codeContext, uiContext].filter(Boolean).join('\n\n') || ctx;
  const vocab = extractCodeVocabulary(ctx);
  const testData = await resolveTestDataFromAsk({
    provider,
    apiKey,
    model,
    title,
    description,
    codeContext: ctx,
    intent,
    vocab,
  });
  const enrichedIntent = { ...intent, testData };
  const prepared = prepareModuleTestCase({
    codeContext: ctx,
    title: intent?.rawTitle ?? title,
    description: intent?.rawDescription ?? description,
    matchedFeature: featureName,
    intent: enrichedIntent,
    vocab,
  });

  const capabilities = extractModuleCapabilities(capsCtx);
  const rowNeedle = normalizeRowNeedle(
    testData?.existingRowNeedle || testData?.searchTerm || testData?.fields?.code || testData?.fields?.name,
  );
  const feasibility = assessComposeFeasibility({
    action: enrichedIntent?.action || intent?.action,
    caps: capabilities,
    title: intent?.rawTitle ?? title,
    description: intent?.rawDescription ?? description,
    featureName,
    rowNeedle,
  });
  if (!feasibility.feasible) {
    const err = new Error(feasibility.blockReason);
    err.code = 'COMPOSE_NOT_FEASIBLE';
    err.advice = feasibility.advice;
    err.suggestions = feasibility.suggestions;
    err.capabilities = capabilities;
    throw err;
  }
  const capabilitiesWarning = feasibility.advice?.length
    ? feasibility.advice.join(' ')
    : null;

  if (wantsUi && ctx) {
    uiPlan = buildUiPlanFromCode(ctx, title, featureName, enrichedIntent);

    const raw = await callLLM({
      provider,
      apiKey,
      model,
      system: SYSTEM_UI,
      user: promptUi(
        title,
        description,
        ctx,
        featureName,
        enrichedIntent,
        testData,
        prepared.enrichedVocab,
        prepared,
      ),
    });
    const parsed = extractJSON(raw);
    if (!parsed?.uiPlan?.steps?.length) {
      throw new Error('AI UI test plan generation failed — no valid steps returned');
    }

    const polished = normalizeUiPlan(parsed.uiPlan, featureName);
    if (!polished.sourceRefs?.length) polished.sourceRefs = uiPlan.sourceRefs;
    polished.acceptanceCriteria = buildAcceptanceCriteriaFromSteps({
      steps: polished.steps,
      testData,
      testDataEntries: testData.testDataEntries || [],
      uiFacts: extractUiFacts(ctx),
      feature: featureName,
      action: enrichedIntent?.action || 'create',
      sourceRefs: polished.sourceRefs?.length ? polished.sourceRefs : uiPlan.sourceRefs,
    });
    polished.ask = { ...uiPlan.ask, testData };
    polished.testDataEntries = testData.testDataEntries;
    polished.fromIndex = true;
    polished.aiAuthored = true;
    uiPlan = polished;
    uiAiAuthored = true;

    const execPlan = parsed?.executionPlan || parsed?.automation;
    if (execPlan?.steps?.length) {
      const validation = validateAiExecutionPlan(execPlan, {
        vocab: prepared.enrichedVocab,
        prepared,
      });
      if (!validation.ok) {
        console.warn('[compose] AI execution plan issues:', validation.issues.join('; '));
      }
      uiAutomation = buildUiAutomationFromAiPlan({
        aiPlan: execPlan,
        codeContext: ctx,
        matchedFeature: featureName,
        intent: enrichedIntent,
        uiPlan,
        prepared,
      });
      if (uiAutomation) {
        console.info('[compose] Using AI-authored execution plan (validated against indexed code)');
      }
    }

    if (uiPlan?.ask) uiPlan.ask.testData = testData;
    if (testData.testDataEntries?.length) uiPlan.testDataEntries = testData.testDataEntries;

    uiPlan = mergePreparedFormSteps(uiPlan, prepared, enrichedIntent);
    if (uiPlan?.steps?.length) {
      uiPlan.acceptanceCriteria = buildAcceptanceCriteriaFromSteps({
        steps: uiPlan.steps,
        testData,
        testDataEntries: uiPlan.testDataEntries || testData.testDataEntries || [],
        uiFacts: extractUiFacts(ctx),
        feature: featureName,
        action: enrichedIntent?.action || 'create',
        sourceRefs: uiPlan.sourceRefs || [],
      });
    }

    if (uiPlan?.steps?.length) {
      cases.unshift(normalizeCase({
        title: uiPlan.title || `UI plan: ${featureName}`,
        type: 'Functional',
        priority: 'P0',
        steps: uiPlan.steps,
        expected: (uiPlan.acceptanceCriteria || []).map((a) => `${a.id}: ${a.requirement}`).join(' | ') || 'UI acceptance criteria met.',
        sourceRefs: uiPlan.sourceRefs || [],
      }));
    }
  }

  // When a UI plan exists, keep a single manual case — skip flooding API variant cases
  if (wantsApi && !uiPlan && (apiContext || (!wantsUi && codeContext))) {
    const apiCtx = apiContext || codeContext;
    const raw = await callLLM({ provider, apiKey, model, system: SYSTEM_API, user: promptApi(title, description, apiCtx, featureName) });
    const parsed = extractJSON(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed?.testCases || [];
    if (!arr.length) {
      throw new Error('AI API test case generation failed — no valid cases returned');
    }
    cases.push(...arr.map(normalizeCase));
  }

  if (wantsUi && ctx && !uiAiAuthored) {
    throw new Error('AI UI test plan generation failed');
  }

  const seen = new Set();
  cases = cases.filter((c) => {
    const k = c.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!cases.length) {
    throw new Error('AI test case generation produced no cases');
  }

  return { cases, uiPlan, intent: enrichedIntent, uiAutomation, capabilities, capabilitiesWarning, composeAdvice: feasibility.advice, composeSuggestions: feasibility.suggestions };
}

export async function generateTestCases(args) {
  const { cases } = await generateComposeArtifacts(args);
  return cases;
}

export async function testConnection({ provider, apiKey, model }) {
  await callLLM({
    provider, apiKey, model,
    system: 'Reply with JSON {"ok":true}',
    user: 'ping',
  });
  return true;
}

function normalizeUiPlan(plan, title) {
  const steps = Array.isArray(plan.steps) ? plan.steps.map((s, i) => {
    const t = String(s).trim();
    return /^\d+\./.test(t) ? t : `${i + 1}. ${t}`;
  }) : [];
  const ac = Array.isArray(plan.acceptanceCriteria)
    ? plan.acceptanceCriteria.map((a, i) => ({
      id: a.id || `AC${i + 1}`,
      requirement: a.requirement || a.text || '',
      proof: a.proof || '',
    }))
    : [];
  return {
    title: plan.title || `Manual test case · ${title || 'feature'}`,
    runAs: plan.runAs || 'UI · Browser',
    mode: 'Foreground',
    steps,
    acceptanceCriteria: ac,
    sourceRefs: Array.isArray(plan.sourceRefs) ? plan.sourceRefs : [],
    ask: plan.ask || null,
    testDataEntries: plan.testDataEntries || plan.ask?.testData?.testDataEntries || [],
    fromIndex: plan.fromIndex !== false,
  };
}

function extractUiFacts(codeContext) {
  const text = String(codeContext || '');
  const pathMatches = [...text.matchAll(/([\w./-]+\.(?:html|ts|tsx|jsx|vue|scss)):(\d+)-(\d+)/g)];
  const paths = pathMatches.map((m) => `${m[1]}:${m[2]}-${m[3]}`);
  const filePaths = pathMatches.map((m) => m[1]);
  const clicks = [...new Set([...text.matchAll(/\(click\)\s*=\s*"(\w+)\(/g)].map((m) => m[1]))];
  const formControls = [...new Set([...text.matchAll(/formControlName\s*=\s*"(\w+)"/g)].map((m) => m[1]))];
  const labels = [...new Set([...text.matchAll(/\{\{\s*"([^"]+)"\s*\|\s*translate/g)].map((m) => m[1]))];
  const permissions = [...new Set([
    ...[...text.matchAll(/'([A-Z0-9_]+)'\s*\|\s*hasCompositePermission/g)].map((m) => m[1]),
    ...[...text.matchAll(/hasCompositePermission\s*\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]),
  ])];
  const validators = {
    required: /Validators\.required|hasError\('(\w+)',\s*'required'\)/.test(text),
    minLength: [...text.matchAll(/Validators\.minLength\((\d+)\)/g)].map((m) => Number(m[1])).filter(Boolean)[0] || null,
  };
  const listPage = /list-container|mat-table|dataSource|common\.add/i.test(text) || clicks.some((c) => /create/i.test(c));
  const formPage = /formControlName|action-buttons|getSubmitButtonText|FormGroup|FormBuilder/i.test(text);
  const createClick = clicks.find((c) => /create|add|new/i.test(c)) || null;
  const updateClick = clicks.find((c) => /update|edit|save|open/i.test(c)) || null;
  const deleteClick = clicks.find((c) => /delete|remove|archive/i.test(c)) || null;
  const listComp = filePaths.find((p) => /list/i.test(p)) || filePaths[0] || null;
  const formComp = filePaths.find((p) => /details|form|edit|create|dialog/i.test(p)) || null;
  const nameField = formControls.includes('name') || /formControlName\s*=\s*"name"/.test(text);
  const hasMatTable = /mat-table|dataSource/i.test(text);
  const fieldRequiredKey = labels.find((l) => /fieldRequired|required/i.test(l)) || (/common\.fieldRequired/.test(text) ? 'common.fieldRequired' : null);
  const nameLabel = labels.find((l) => /\.name$/i.test(l)) || (nameField ? 'name' : null);

  return {
    paths: [...new Set(paths)].slice(0, 8),
    filePaths,
    clicks,
    formControls,
    labels,
    permissions,
    validators,
    listPage,
    formPage,
    createClick,
    updateClick,
    deleteClick,
    listComp,
    formComp,
    nameField,
    hasMatTable,
    fieldRequiredKey,
    nameLabel,
  };
}

function pushFormFillSteps(steps, manualFillLines, testData) {
  if (manualFillLines?.length) {
    steps.push(...manualFillLines);
    return;
  }
  if (!testData?.fields || !Object.keys(testData.fields).length) {
    steps.push('Fill in all required form fields with valid data.');
    steps.push('Identify and click the Save or Submit button.');
    return;
  }
  steps.push('Wait for the create or edit form to open.');
  for (const [key, val] of Object.entries(testData.fields)) {
    if (val === '__first__') {
      steps.push(`Select the first option in the ${key} dropdown.`);
    } else {
      steps.push(`Enter "${val}" in the ${key} field.`);
    }
  }
  steps.push('Identify and click the Save or Submit button.');
}

export function buildUiPlanFromCode(codeContext, title, matchedFeature, intent = null) {
  const f = extractUiFacts(codeContext);
  const feature = matchedFeature
    || (f.listComp && featureFromPath(f.listComp))
    || (f.filePaths[0] && featureFromPath(f.filePaths[0]))
    || 'matched screen';
  const action = intent?.action || 'create';

  const prepared = prepareModuleTestCase({
    codeContext,
    title: intent?.rawTitle ?? title,
    description: intent?.rawDescription ?? '',
    matchedFeature: feature,
    intent,
    action,
  });
  const testData = prepared.testData;
  const manualFillLines = prepared.manualFillLines;
  const combinedAsk = intent?.combinedAsk || combineAsk(intent?.rawTitle || title, intent?.rawDescription);
  const notes = new Set(intent?.notes || []);
  const steps = [];
  const refs = f.paths;

  const askMeta = {
    title: intent?.rawTitle || title || '',
    description: intent?.rawDescription || '',
    combinedAsk,
    action,
    matchedFeature: feature,
  };

  if (!f.paths.length && !f.clicks.length && !f.formControls.length) {
    return normalizeUiPlan({
      title: `Manual test case · ${feature}`,
      runAs: 'UI · Browser',
      ask: askMeta,
      fromIndex: true,
      steps: [
        `1. Navigate to the ${feature} area in the application.`,
        '2. Locate and use only the controls shown on that screen.',
        '3. Verify the result matches what the screen displays after you act.',
      ],
      acceptanceCriteria: [{
        id: 'AC1',
        requirement: `An accessible ${feature} screen exists in the indexed UI.`,
        proof: 'No detailed controls were parsed — refine the ask or re-index.',
      }],
      sourceRefs: refs,
    }, feature);
  }

  // LIST / entry
  if (action === 'list' || f.listPage || f.listComp || action === 'create' || action === 'exercise' || action === 'update' || action === 'delete') {
    steps.push(`Navigate to the ${feature} list or main section.`);
  }

  if (action === 'list') {
    steps.push('Verify the list of records is visible.');
    if (testData.searchTerm) {
      steps.push(`Search for "${testData.searchTerm}" using the search or filter control.`);
      steps.push(`Verify "${testData.verifyText || testData.searchTerm}" appears in the results.`);
    } else if (f.labels.some((l) => /search|filter/i.test(l))) {
      steps.push('Locate and use the search or filter control if you need a specific row.');
    }
  }

  // CREATE
  if (action === 'create' || action === 'exercise') {
    const createPerm = f.permissions.find((p) => /CREATE|ADD|NEW/i.test(p));
    if ((notes.has('permission') || createPerm) && createPerm) {
      steps.push(`Confirm you can create only when allowed (permission: ${createPerm}).`);
    }
    if (f.createClick || f.labels.some((l) => /common\.add|add|create/i.test(l))) {
      steps.push('Locate and click the button used to create a new item (Add / Create / New).');
    }
    if (f.formPage || f.formControls.length || testData.testDataEntries?.length) {
      pushFormFillSteps(steps, manualFillLines, testData);
    }
  }

  // UPDATE
  if (action === 'update') {
    const rowNeedle = testData.existingRowNeedle || testData.searchTerm;
    if (rowNeedle) {
      steps.push(`Search for "${rowNeedle}" using the search or filter control.`);
    }
    steps.push('Locate and open an existing row to edit.');
    if (f.updateClick) {
      steps.push(`Locate and click the edit control for the row${rowNeedle ? ` containing "${rowNeedle}"` : ''}.`);
    }
    if (f.formPage || f.formControls.length || testData.testDataEntries?.length) {
      pushFormFillSteps(steps, manualFillLines, testData);
    }
    if (testData.primaryValue) {
      steps.push('Change the field values as specified, then save.');
    } else {
      steps.push('Change at least one field, then save.');
    }
  }

  // DELETE — flow depends on indexed UI (list row vs edit form)
  if (action === 'delete') {
    const caps = extractModuleCapabilities(codeContext);
    if (!caps.supportsDelete) {
      steps.push('NOTE: No delete control found in indexed UI — this scenario may not be automatable.');
    } else if (caps.deleteMode === 'detail-edit') {
      steps.push('Search for the target record in the list.');
      steps.push('Click Edit on that row (delete is not on the list or in view mode).');
      steps.push('Click Delete on the edit form.');
      steps.push('Confirm the delete prompt if one appears.');
      steps.push('Verify the record is no longer visible in the list.');
    } else if (caps.deleteMode === 'list-row') {
      steps.push('Search for or select the target record in the list.');
      steps.push('Click Delete on the list row.');
      steps.push('Confirm the delete prompt if one appears.');
      steps.push('Verify the record is no longer visible in the list.');
    } else if (f.deleteClick) {
      steps.push('Select an existing record from the list.');
      steps.push('Locate and click the delete or remove control.');
      steps.push('Confirm the delete prompt if one appears.');
      steps.push('Verify the record is no longer visible in the list.');
    }
  }

  if (action !== 'delete' && (f.hasMatTable || f.listPage) && (action === 'create' || action === 'update' || action === 'exercise')) {
    steps.push('Observe the screen for a confirmation message or return to the list.');
    const verifyVal = testData.verifyText || testData.primaryValue;
    if (verifyVal) {
      steps.push(`Verify "${verifyVal}" appears in the list.`);
    } else {
      steps.push(
        f.nameField
          ? 'Verify the name you entered appears in the list.'
          : 'Verify the new or updated record appears in the list.',
      );
    }
  }

  const wantValidation = notes.has('validation') || action === 'create' || action === 'exercise';
  if (wantValidation && f.validators.required && f.nameField) {
    steps.push('Clear the Name field and try to save — verify a required-field error is shown.');
  }
  if (notes.has('uniqueness') && f.nameField) {
    steps.push('Try saving with a duplicate name — verify the app blocks it if uniqueness is enforced.');
  }

  const numberedSteps = steps.map((s, i) => `${i + 1}. ${s}`);
  const ac = buildAcceptanceCriteriaFromSteps({
    steps: numberedSteps,
    testData,
    testDataEntries: testData.testDataEntries || [],
    uiFacts: f,
    feature,
    action,
    sourceRefs: refs,
  });

  return normalizeUiPlan({
    title: `Manual test case · ${feature}`,
    runAs: 'UI · Browser',
    ask: { ...askMeta, testData },
    testDataEntries: testData.testDataEntries || [],
    fromIndex: true,
    steps: numberedSteps,
    acceptanceCriteria: ac,
    sourceRefs: refs,
  }, feature);
}

function parseApiFacts(codeContext) {
  const text = String(codeContext || '');
  const paths = [...text.matchAll(/([\w./-]+\.(?:php|ts|java)):(\d+)-(\d+)/g)].map((m) => `${m[1]}:${m[2]}-${m[3]}`);
  const classRoute = text.match(/#\[Route\('(\/api\/[^']+)'/);
  const base = classRoute?.[1] || '';
  const endpoints = [];
  const routeRe = /#\[Route\('([^']*)'(?:[^[\]]*name:\s*'([^']*)')?[^[\]]*methods:\s*\['([A-Z]+)'\]/g;
  let rm;
  while ((rm = routeRe.exec(text)) !== null) {
    const sub = rm[1] || '';
    const full = `${base}${sub}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || base || '/';
    endpoints.push({ method: rm[3], path: full.startsWith('/') ? full : base, name: rm[2] || '' });
  }
  if (/function\s+create\s*\(/.test(text) && /methods:\s*\['POST'\]/.test(text)) {
    endpoints.push({ method: 'POST', path: base, name: 'create' });
  }
  if (/function\s+index\s*\(/.test(text)) endpoints.push({ method: 'GET', path: base, name: 'index' });
  if (/function\s+show\s*\(/.test(text)) endpoints.push({ method: 'GET', path: `${base}/{id}`, name: 'show' });
  if (/function\s+update\s*\(/.test(text)) endpoints.push({ method: 'PUT', path: `${base}/{id}`, name: 'update' });
  if (/function\s+delete\s*\(/.test(text)) endpoints.push({ method: 'DELETE', path: `${base}/{id}`, name: 'delete' });
  const permissions = [...new Set([...text.matchAll(/#\[IsGranted\('([^']+)'\)\]/g)].map((m) => m[1]))];
  const requiredFields = [];
  for (const m of text.matchAll(/\$requiredFields\s*=\s*\[([^\]]+)\]/g)) {
    for (const f of m[1].matchAll(/'([^']+)'/g)) requiredFields.push(f[1]);
  }
  return {
    paths: [...new Set(paths)].slice(0, 6),
    base,
    endpoints,
    permissions,
    requiredFields: [...new Set(requiredFields)],
    nameExists: /nameExists\(/.test(text),
  };
}

export function codeGroundedApiCases(codeContext, title) {
  const facts = parseApiFacts(codeContext);
  const refs = facts.paths;
  const cases = [];
  const add = (c) => cases.push(normalizeCase({ ...c, sourceRefs: c.sourceRefs || refs }));
  const createEp = facts.endpoints.find((e) => e.method === 'POST' || e.name === 'create');
  const createPath = (createEp?.path || facts.base || '').replace(/\/$/, '');
  const createPerm = facts.permissions.find((p) => /create/i.test(p));

  if (createEp && createPath) {
    add({
      title: `POST ${createPath} creates resource when payload is valid`,
      type: 'Functional', priority: 'P0',
      steps: [
        createPerm ? `Authenticate with permission ${createPerm}` : 'Authenticate as allowed by controller IsGranted attributes',
        `POST ${createPath} with required fields: ${facts.requiredFields.join(', ') || '(see controller requiredFields)'}`,
        'Assert success response from create()',
      ],
      expected: 'Resource created per create() implementation in cited controller/service.',
    });
    if (facts.requiredFields.length) {
      add({
        title: `POST ${createPath} rejects missing ${facts.requiredFields.join(', ')}`,
        type: 'Negative', priority: 'P0',
        steps: [`POST ${createPath} without ${facts.requiredFields.join(', ')}`],
        expected: 'Validation rejects missing requiredFields as coded.',
      });
    }
    if (facts.nameExists) {
      add({
        title: `POST ${createPath} rejects duplicate name`,
        type: 'Negative', priority: 'P1',
        steps: ['Create once with a name', 'POST again with the same name for the same enterprise scope'],
        expected: 'nameExists(...) in code blocks the duplicate.',
      });
    }
  }
  for (const ep of facts.endpoints.filter((e) => e.name !== 'create' && e.method !== 'POST').slice(0, 4)) {
    add({
      title: `${ep.method} ${ep.path} (${ep.name || 'action'})`,
      type: 'Functional', priority: 'P1',
      steps: [`Call ${ep.method} ${ep.path}`, 'Assert response matches the cited controller method'],
      expected: `${ep.name || ep.method} behaves as implemented in sourceRefs.`,
    });
  }
  if (!cases.length && refs.length) {
    add({
      title: `Exercise indexed API for ${title || 'matched feature'}`,
      type: 'Functional', priority: 'P1',
      steps: [`Review ${refs.slice(0, 3).join(', ')}`, 'Call only operations defined in those files'],
      expected: 'Behavior matches cited sources only — nothing outside the index.',
    });
  }
  return cases;
}

export function codeGroundedDemoCases(codeContext, title) {
  return codeGroundedApiCases(codeContext, title);
}

export function demoTestCases(title, description, options, codeContext) {
  if (!codeContext?.trim()) return [];
  return codeGroundedApiCases(codeContext, title);
}
