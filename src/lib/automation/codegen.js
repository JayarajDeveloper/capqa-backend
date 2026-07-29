// Build executable automation from RAG-grounded UI plans / API cases.
 // Selectors and endpoints come only from indexed code — no invented product UI.

import { buildSelectStrategies, buildFillStrategies, interactionKindForField, isInventedDropdownValue } from '../rag/componentRegistry.js';
import { extractCodeVocabulary, getTestData, entityStemFromVocab, entityStemFromResourceSeg, resolveVerifyNeedle, isGenericOutcomePhrase, isListMetaPhrase, normalizeRowNeedle } from '../rag/ground.js';
import { prepareModuleTestCase } from '../rag/testCasePipeline.js';
import { pickIdentityFieldFromSchema } from '../rag/askAnalyzer.js';
import { extractModuleCapabilities } from '../rag/codeSignals.js';
import { extractFormSchema, defaultValueForField, isFilterFieldKey } from '../rag/formSchema.js';
import { auditCodeTestIds, auditAutomationTestIds, formatTestIdAuditError } from '../rag/codeTestIds.js';

function slugFromFeature(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function uniqueName(prefix = 'Auto') {
  const t = Date.now().toString(36).slice(-5);
  return `${prefix} ${t}`;
}

/** Pull routes only from indexed router config / routerLink — no folder guessing. */
export function extractRouteHints(codeContext, featureName) {
  const text = String(codeContext || '');
  const routes = [];
  for (const m of text.matchAll(/path\s*:\s*['"]([a-z0-9/_-]+)['"]/gi)) {
    routes.push(`/${m[1].replace(/^\//, '')}`);
  }
  for (const m of text.matchAll(/routerLink\s*=\s*['"]\/?([^'"?]+)/gi)) {
    routes.push(`/${m[1].replace(/^\//, '').split('?')[0]}`);
  }
  for (const m of text.matchAll(/fallbackCommands\s*:\s*\[\s*['"]([^'"]+)['"]/gi)) {
    routes.push(`/${m[1].replace(/^\//, '')}`);
  }

  const slug = slugFromFeature(featureName).toLowerCase();
  const stem = (s) => String(s || '')
    .toLowerCase()
    .replace(/ies$/, 'y')
    .replace(/ses$/, 's')
    .replace(/s$/, '');
  const slugStem = stem(slug);

  const unique = [...new Set(routes.map((r) => r.split('?')[0]))];
  const scored = unique.map((r) => {
    const seg = r.replace(/^\//, '').split('/')[0].toLowerCase();
    let score = 50;
    if (seg === slug || stem(seg) === slugStem) score = 0;
    else if (seg.includes(slug) || slug.includes(seg) || stem(seg).includes(slugStem)) score = 10;
    // Prefer real app list path (currency) over folder plural (currencies) when both appear
    if (score === 0 && seg !== slug && stem(seg) === slugStem && seg.length < slug.length) {
      score = -1; // singular route wins over plural slug
    }
    // List route first — create flow opens /details after Add click
    if (/\/(details|new|create)(\/|$|\?)/i.test(r)) score += 20;
    if (r.split('/').filter(Boolean).length > 2) score += 5;
    return { r, score };
  }).sort((a, b) => a.score - b.score || a.r.length - b.r.length);

  if (scored.length && scored[0].score < 50) return scored[0].r;
  // Keep plural when indexed router/links already use that exact segment (e.g. /articles, /partners)
  if (slug && unique.some((r) => {
    const seg = r.replace(/^\//, '').split('/')[0].toLowerCase();
    return seg === slug;
  })) {
    return `/${slug}`;
  }
  if (
    slug
    && new RegExp(
      `(?:path\\s*:\\s*['"\`]${slug}['"\`]|routerLink\\s*=\\s*['"\`]/${slug}(?:['"\`?/]|$)|navigate\\(\\s*\\[\\s*['"\`]/?${slug}['"\`])`,
      'i',
    ).test(text)
  ) {
    return `/${slug}`;
  }
  // Indexed page/feature folders keep plural list URLs (pages/articles → /articles)
  if (slug && new RegExp(`(?:pages|Features)/${slug}(?:/|['"\`]|$)`, 'i').test(text)) {
    return `/${slug}`;
  }
  // Plural feature name → try singular stem when no router hit (Currencies → /currency)
  if (slugStem && slugStem !== slug) return `/${slugStem}`;
  if (slug) return `/${slug}`;
  return '/';
}

function entityStemFromTestId(testId) {
  const m = String(testId || '').match(/^(.+?)-(?:create|add|save|name)$/);
  return m?.[1] || '';
}

function fieldTestId(vocab, formControl) {
  const fc = String(formControl || '').replace(/_/g, '-');
  return (vocab.testIds || []).find((id) => id.endsWith(`-${fc}`) && !/search|filter|active/i.test(id)) || null;
}

function fillStrategiesForField(formControl, testId, fieldMeta = {}) {
  return buildFillStrategies({ key: formControl, testId, ...fieldMeta });
}

function selectStrategiesForField(formControl, testId, fieldMeta = {}) {
  return buildSelectStrategies({ key: formControl, testId, ...fieldMeta });
}

function searchFillStrategies(vocab = {}) {
  const searchTestId = (vocab.testIds || []).find((id) => /search/i.test(id));
  const searchFc = (vocab.formControls || []).find((fc) => /search|filter|query/i.test(fc));
  const strategies = [];
  if (searchTestId) {
    strategies.push(
      { type: 'testid', value: searchTestId },
      { type: 'css', value: `[data-testid="${searchTestId}"]` },
      { type: 'css', value: `[data-testid="${searchTestId}"] input` },
    );
  }
  if (searchFc) {
    strategies.push({
      type: 'css',
      value: `[formcontrolname="${searchFc}"], input[formControlName="${searchFc}"]`,
    });
  }
  strategies.push(
    { type: 'css', value: '[data-testid*="search"] input, input[type="search"]' },
    { type: 'label', value: 'search', regex: true },
  );
  return strategies;
}

/** Edit button on a filtered row — CapBO editRetailChain() → /details?id=…&mode=edit (never bare /details). */
export function editButtonStrategies(vocab, needle) {
  const rowTestId = (vocab.testIds || []).find((id) => /-row$/i.test(id));
  const editTestId = (vocab.testIds || []).find((id) => /-edit$/i.test(id));
  const q = String(needle || '').trim();
  const strategies = [];

  if (q) {
    if (rowTestId && editTestId) {
      strategies.push({
        type: 'css',
        value: `[data-testid="${rowTestId}"]:has-text("${q}") [data-testid="${editTestId}"]`,
      });
    }
    strategies.push({
      type: 'css',
      value: `[data-testid$="-row"]:has-text("${q}") [data-testid$="-edit"]`,
    });
    strategies.push({
      type: 'css',
      value: `table tbody tr:has-text("${q}") [data-testid$="-edit"]`,
    });
    strategies.push({
      type: 'css',
      value: `table tbody tr:has-text("${q}") button[aria-label*="edit" i], table tbody tr:has-text("${q}") [title*="edit" i]`,
    });
  }

  // After search filters to one row, a lone edit control is safe
  if (editTestId) {
    strategies.push(
      { type: 'testid', value: editTestId },
      { type: 'css', value: `[data-testid="${editTestId}"]` },
    );
  }
  strategies.push({ type: 'css', value: '[data-testid$="-edit"]' });
  return strategies;
}

/** View button on a filtered row (eye icon). */
export function viewButtonStrategies(vocab, needle) {
  const rowTestId = (vocab.testIds || []).find((id) => /-row$/i.test(id));
  const viewTestId = (vocab.testIds || []).find((id) => /-view$/i.test(id));
  const q = String(needle || '').trim();
  const strategies = [];

  if (q) {
    if (rowTestId && viewTestId) {
      strategies.push({
        type: 'css',
        value: `[data-testid="${rowTestId}"]:has-text("${q}") [data-testid="${viewTestId}"]`,
      });
    }
    strategies.push(
      { type: 'css', value: `[data-testid$="-row"]:has-text("${q}") [data-testid$="-view"]` },
      { type: 'css', value: `table tbody tr:has-text("${q}") [data-testid$="-view"]` },
    );
  }
  if (viewTestId) {
    strategies.push(
      { type: 'testid', value: viewTestId },
      { type: 'css', value: `[data-testid="${viewTestId}"]` },
    );
  }
  strategies.push({ type: 'css', value: '[data-testid$="-view"]' });
  return strategies;
}

function deleteButtonStrategies(vocab, needle) {
  const deleteTestId = (vocab.testIds || []).find((id) => /-delete$/i.test(id) && !/-delete-(confirm|cancel|dialog)/i.test(id));
  const q = String(needle || '').trim();
  const strategies = [];
  if (deleteTestId) {
    strategies.push(
      { type: 'testid', value: deleteTestId },
      { type: 'css', value: `[data-testid="${deleteTestId}"]` },
    );
  }
  if (q) {
    strategies.push({ type: 'css', value: `[data-testid$="-row"]:has-text("${q}") [data-testid$="-delete"]` });
  }
  strategies.push({ type: 'css', value: '[data-testid$="-delete"]' });
  return strategies;
}

/** Delete confirmation dialog — shared CapBO confirm testId; module-specific only when indexed in code. */
function confirmDeleteStrategies(vocab) {
  const strategies = [];
  const moduleConfirm = (vocab.testIds || []).find((id) => /-delete-confirm$/i.test(id));
  if (moduleConfirm) {
    strategies.push(
      { type: 'testid', value: moduleConfirm },
      { type: 'css', value: `[data-testid="${moduleConfirm}"]` },
    );
  }
  strategies.push(
    { type: 'testid', value: 'confirm' },
    { type: 'css', value: '[data-testid="confirm"], .confirm-button.bg-danger, .confirm-button' },
  );
  return strategies;
}

function strategyKey(s) {
  return `${s.type}:${s.value || ''}:${s.role || ''}:${s.name || ''}`;
}

/** Dedupe locator strategies (AI + codegen merge). */
export function dedupeStrategies(strategies = []) {
  const seen = new Set();
  const out = [];
  for (const s of strategies) {
    if (!s?.type) continue;
    const k = strategyKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Locator strategies for list-page Add/Create — testId from CapBO code, plus i18n role fallback. */
export function createButtonStrategies(vocab = {}, _entityStem = '') {
  const createTestId = (vocab.testIds || []).find((id) => /-(create|add|new)$/i.test(id) && !/filter|search|modal|form$/i.test(id))
    || (vocab.testIds || []).find((id) => /create|add|new/i.test(id) && !/filter|search|form|cancel|delete/i.test(id))
    || null;
  const nameRe = createButtonNamePattern(vocab);
  const out = [];
  if (createTestId) {
    out.push({ type: 'testid', value: createTestId });
    out.push({ type: 'css', value: `[data-testid="${createTestId}"]` });
  }
  // CapBO list Add often uses {{ 'common.add' | translate }} — role works when DOM lacks testId
  out.push({ type: 'role', role: 'button', name: nameRe, regex: true });
  return dedupeStrategies(out);
}

/** Build regex source for list Add/Create from indexed i18n keys (common.add, …). */
export function createButtonNamePattern(vocab = {}) {
  const labels = (vocab.labels || []).map((l) => String(l).toLowerCase());
  const parts = new Set(['add', 'create', 'new', 'ajouter', 'créer', 'creer', 'nouveau']);
  for (const key of labels) {
    if (/common\.(add|create|new)|actions?\.(add|create|new)|btn\.(add|create)/i.test(key)) {
      const leaf = key.split('.').pop();
      if (leaf) parts.add(leaf);
    }
  }
  return `^(${[...parts].map(escapeRegExp).join('|')})$`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locator strategies for form Save/Submit — testId from CapBO code only. */
export function saveButtonStrategies(vocab = {}, _entityStem = '') {
  const saveTestId = (vocab.testIds || []).find((id) => /-(save|submit)$/i.test(id))
    || (vocab.testIds || []).find((id) => /save|submit/i.test(id) && !/form|cancel|delete/i.test(id))
    || null;
  if (!saveTestId) return [];
  return dedupeStrategies([
    { type: 'testid', value: saveTestId },
    { type: 'css', value: `[data-testid="${saveTestId}"]` },
  ]);
}

export function isCreateClickStep(step) {
  if (!step) return false;
  if (step.id === 'click-create') return true;
  const tid = String(step.testId || '');
  if (/-(create|add|new)$/i.test(tid)) return true;
  if (/-(save|submit)$/i.test(tid)) return false;
  const desc = String(step.description || '');
  // "Click Save to create the record" is SAVE — never treat as Add
  if (/save|submit|enregistrer/i.test(desc)) return false;
  return /^(click )?(the )?(add|create|new|ajouter|nouveau)\b/i.test(desc)
    || /\b(add|create|new)\b.*\b(button|btn)\b/i.test(desc)
    || /add \/ create|open create form|open the create/i.test(desc);
}

export function isSaveClickStep(step) {
  if (step?.id === 'click-save') return true;
  const tid = String(step?.testId || '');
  if (/-(save|submit)$/i.test(tid)) return true;
  if (/-(create|add|new)$/i.test(tid)) return false;
  const desc = String(step?.description || '');
  // Prefer save/submit wording even when the sentence also says "create"
  if (/save|submit|enregistrer/i.test(desc)) return true;
  return false;
}

/**
 * Every create/exercise flow must have an Add/Create click before fills.
 * Applies to all modules (VAT, currency, eco-tax, partners, retail-chain, …).
 */
export function ensureCreateClickStep(steps = [], {
  vocab = {},
  entityStem = '',
  action = 'create',
} = {}) {
  if (!/^(create|exercise)$/i.test(action)) return steps;
  const list = [...(steps || [])];
  if (list.some((s) => isCreateClickStep(s))) {
    return normalizeAutomationStepOrder(list.map((s) => (
      isCreateClickStep(s) && s.id !== 'click-create'
        ? { ...s, id: 'click-create' }
        : s
    )));
  }
  const stem = entityStem || entityStemFromVocab(vocab) || '';
  const createTid = (vocab.testIds || []).find((id) => /-(create|add|new)$/i.test(id) && !/filter|search|modal|form$/i.test(id))
    || null;
  if (!createTid) {
    // No invented stems — CapBO must expose *-create testId
    return normalizeAutomationStepOrder(list);
  }
  const createStep = {
    id: 'click-create',
    action: 'click',
    strategies: createButtonStrategies(vocab, stem),
    testId: createTid,
    description: 'Click Add / Create',
  };
  const gotoIdx = list.findIndex((s) => s.action === 'goto');
  if (gotoIdx >= 0) list.splice(gotoIdx + 1, 0, createStep);
  else list.unshift(createStep);
  return normalizeAutomationStepOrder(list);
}

export function normalizeAutomationStepOrder(steps = []) {
  const goto = [];
  const creates = [];
  const listSearch = [];
  const rowClicks = [];
  const clicks = [];
  const fills = [];
  const saves = [];
  const expects = [];
  const other = [];

  const isRowClick = (s) => s.id === 'click-edit' || s.id === 'click-view' || s.id === 'click-delete-row'
    || (s.action === 'click' && /edit for row|click edit|view button|eye icon|delete row/i.test(s.description || ''));

  for (const s of steps) {
    if (!s?.action) continue;
    if (s.action === 'goto') goto.push(s);
    else if (s.id === 'fill-search') listSearch.push(s);
    else if (s.action === 'fill' || s.action === 'select') fills.push(s);
    else if (s.action === 'click' && (s.id === 'click-save' || isSaveClickStep(s))) saves.push(s);
    else if (s.action === 'click' && (s.id === 'click-create' || isCreateClickStep(s))) creates.push(s);
    else if (s.action === 'click' && isRowClick(s)) rowClicks.push(s);
    else if (s.action === 'click') clicks.push(s);
    else if (s.action === 'expectText' || s.action === 'expectVisible' || s.action === 'expectAbsent') expects.push(s);
    else other.push(s);
  }

  return [...goto, ...creates, ...listSearch, ...rowClicks, ...clicks, ...fills, ...saves, ...expects, ...other];
}

/** True when value/description means “pick first real option”, not a concrete label. */
export function isFirstDropdownIntent(value, step = {}) {
  if (value == null || value === '' || value === '__first__' || value === 'first') return true;
  const s = String(value).toLowerCase().trim();
  if (s === 'first') return true;
  if (/^first[\s_()-]*(available|option|dropdown|choice)/.test(s)) return true;
  if (/^\(first[\s_-]*(dropdown\s*)?option\)$/i.test(s)) return true;
  if (/^__?first__?$/.test(s)) return true;
  const desc = String(step.description || '').toLowerCase();
  if (/first available|first option|select the first|première option|premier/.test(desc)) {
    const looksConcrete = /\([A-Z]{2,5}\)/.test(String(value))
      || (String(value).length > 32 && !/first/i.test(String(value)));
    if (!looksConcrete) return true;
  }
  return false;
}

/** Prefer schema codegen __first__ when AI sends instructional/meta values. */
export function coalesceSelectValue(aiVal, codegenVal, step = {}) {
  if (isFirstDropdownIntent(aiVal, step) || isFirstDropdownIntent(codegenVal, step)) {
    return '__first__';
  }
  return aiVal ?? codegenVal;
}

/** Inject codegen fill/select steps missing from AI plan; keep schema values + strategies. */
export function mergeFillStepsFromCodegen(aiAuto, codegenAuto) {
  if (!codegenAuto?.steps?.length) return aiAuto;
  if (!aiAuto?.steps?.length) return normalizeAutomationStepOrder(codegenAuto.steps);

  const codegenFills = codegenAuto.steps.filter((s) => s.action === 'fill' || s.action === 'select');
  const merged = [...(aiAuto.steps || [])];
  const seen = new Set(
    merged.filter((s) => s.action === 'fill' || s.action === 'select')
      .map((s) => s.formControl || s.id),
  );

  for (const fill of codegenFills) {
    const key = fill.formControl || fill.id;
    const idx = merged.findIndex(
      (s) => (s.action === 'fill' || s.action === 'select') && (s.formControl === key || s.id === fill.id),
    );
    if (idx >= 0) {
      const coalescedValue = merged[idx].action === 'select' || fill.action === 'select'
        ? coalesceSelectValue(merged[idx].value, fill.value, merged[idx])
        : (merged[idx].value ?? fill.value);
      merged[idx] = {
        ...merged[idx],
        value: coalescedValue,
        strategies: dedupeStrategies([...(merged[idx].strategies || []), ...(fill.strategies || [])]),
        testId: merged[idx].testId || fill.testId,
        componentType: merged[idx].componentType || fill.componentType,
        wrapperTag: merged[idx].wrapperTag || fill.wrapperTag,
      };
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fill);
  }

  return {
    ...aiAuto,
    data: { ...(codegenAuto.data || {}), ...(aiAuto.data || {}) },
    steps: normalizeAutomationStepOrder(merged),
  };
}

/** AI descriptions + codegen locators, fill order, and business-rule test data. */
export function mergeAutomationWithCodegen(aiAuto, codegenAuto) {
  if (!codegenAuto?.steps?.length) return aiAuto;
  if (!aiAuto?.steps?.length) return codegenAuto;

  const countFills = (steps) => (steps || []).filter((s) => s.action === 'fill' || s.action === 'select').length;
  const aiFills = countFills(aiAuto.steps);
  const cgFills = countFills(codegenAuto.steps);

  // Schema/codegen has the real required fields (testIds from CapBO). If AI underfills, prefer codegen fills.
  if (cgFills > aiFills) {
    const merged = mergeFillStepsFromCodegen(
      {
        ...aiAuto,
        // Drop incomplete AI fills — codegen values + testIds win
        steps: (aiAuto.steps || []).filter((s) => s.action !== 'fill' && s.action !== 'select'),
        data: { ...(codegenAuto.data || {}), ...(aiAuto.data || {}), formSchema: codegenAuto.data?.formSchema || aiAuto.data?.formSchema },
      },
      codegenAuto,
    );
    return mergeClickStrategiesFromCodegen({
      ...merged,
      data: { ...(codegenAuto.data || {}), ...(merged.data || {}) },
      source: 'codegen+ai',
    }, codegenAuto);
  }

  let merged = mergeFillStepsFromCodegen(aiAuto, codegenAuto);
  merged = mergeClickStrategiesFromCodegen(merged, codegenAuto);
  if (!merged.steps.some((s) => s.action === 'fill' || s.action === 'select')) {
    merged = { ...codegenAuto, source: aiAuto.source || codegenAuto.source };
  }
  return merged;
}

/** Merge codegen click locators into AI-authored steps (AI descriptions, code-grounded selectors). */
export function mergeClickStrategiesFromCodegen(aiAuto, codegenAuto) {
  if (!aiAuto?.steps?.length) return aiAuto;
  const refById = new Map(
    (codegenAuto?.steps || []).filter((s) => s.action === 'click').map((s) => [s.id, s]),
  );
  const steps = aiAuto.steps.map((s) => {
    if (s.action !== 'click') return s;
    let ref = null;
    if (isCreateClickStep(s)) ref = refById.get('click-create');
    else if (isSaveClickStep(s)) ref = refById.get('click-save');
    else if (isRowActionClick(s) || s.id === 'click-edit') ref = refById.get('click-edit');
    else if (s.id === 'click-delete' || s.id === 'click-delete-row') {
      ref = refById.get(s.id) || refById.get('click-delete') || refById.get('click-delete-row');
    } else if (s.id === 'click-confirm') ref = refById.get('click-confirm');
    if (!ref?.strategies?.length) return s;
    return {
      ...s,
      id: s.id || ref.id,
      testId: (isRowActionClick(s) || s.id === 'click-edit') ? null : s.testId,
      strategies: dedupeStrategies([...(ref.strategies || []), ...(s.strategies || [])]),
    };
  });
  return { ...aiAuto, steps };
}

/** AI delete plans often stop at Edit — merge full delete + confirm + absent verify from codegen. */
export function ensureDeleteFlowSteps(automation, codegenAuto, intentAction = null) {
  const resolvedIntent = intentAction && intentAction !== 'exercise' ? intentAction : null;
  const action = resolvedIntent || automation?.action || codegenAuto?.action;
  const isDelete = action === 'delete'
    || codegenAuto?.action === 'delete'
    || resolvedIntent === 'delete';
  if (!isDelete) return automation;
  const cg = codegenAuto?.steps || [];
  if (!cg.length) return automation;

  const rowNeedle = normalizeRowNeedle(
    automation?.data?.existingRowNeedle
      || automation?.data?.searchTerm
      || automation?.steps?.find((s) => s.id === 'fill-search')?.value
      || cg.find((s) => s.id === 'fill-search')?.value,
  );

  const pick = (id) => cg.find((s) => s.id === id)
    || automation?.steps?.find((s) => s.id === id);

  const ordered = [];
  const goto = automation?.steps?.find((s) => s.action === 'goto') || pick('goto');
  if (goto) ordered.push(goto);
  const search = pick('fill-search');
  if (search) ordered.push(search);
  const edit = pick('click-edit');
  if (edit) ordered.push(edit);
  const listDel = pick('click-delete-row');
  const formDel = pick('click-delete');
  if (listDel) ordered.push(listDel);
  else if (formDel) ordered.push(formDel);
  const confirm = pick('click-confirm');
  if (confirm) ordered.push(confirm);

  if (rowNeedle) {
    ordered.push({
      id: 'expect-absent',
      action: 'expectAbsent',
      text: rowNeedle,
      description: `Verify "${rowNeedle}" is no longer in the list`,
    });
  }

  return {
    ...automation,
    action: 'delete',
    steps: normalizeAutomationStepOrder(ordered),
    data: {
      ...(automation?.data || {}),
      existingRowNeedle: rowNeedle || automation?.data?.existingRowNeedle,
      searchTerm: rowNeedle || automation?.data?.searchTerm,
    },
  };
}

/** When the ask has no explicit verb, infer from indexed code (createRetailChain, etc.). */
function resolveAutomationAction(intent, vocab, codeContext = '') {
  let action = intent?.action || 'exercise';
  if (action !== 'exercise') return action;

  const ask = String(intent?.combinedAsk || '').toLowerCase();
  const caps = codeContext ? extractModuleCapabilities(codeContext) : null;
  const hasCreate = (vocab.clicks || []).some((c) => /create|add|new/i.test(c))
    || (vocab.testIds || []).some((id) => /create|add|new/i.test(id));
  const hasEdit = caps?.listHasEdit
    || (vocab.clicks || []).some((c) => /edit|update/i.test(c))
    || (vocab.testIds || []).some((id) => /edit|update/i.test(id));
  const hasDelete = caps?.supportsDelete
    || (vocab.testIds || []).some((id) => /delete|remove/i.test(id));

  if (/\b(delete|remove)\b/.test(ask) && hasDelete) return 'delete';
  if (/\b(edit|update|modify|rename|change)\b/.test(ask) && hasEdit) return 'update';
  if (/\bview\b/.test(ask) && !/\bview all\b/.test(ask) && caps?.listHasView) return 'view';
  if (/\b(search|list|filter|browse)\b/.test(ask)) return 'list';
  if (hasCreate) return 'create';
  if (hasEdit) return 'update';
  return 'create'; // default for CRUD modules with a list + form
}

/**
 * Build structured UI automation + Playwright source from a grounded plan + UI code.
 */
export function buildUiAutomation({ uiPlan, codeContext, matchedFeature, intent }) {
  const vocab = extractCodeVocabulary(codeContext || '');
  const feature = matchedFeature || uiPlan?.ask?.matchedFeature || 'feature';
  const action = resolveAutomationAction(intent, vocab, codeContext)
    || intent?.action
    || uiPlan?.ask?.action
    || 'create';
  const route = extractRouteHints(codeContext, feature);
  const createTestId = (vocab.testIds || []).find((id) => /create|add|new/i.test(id));
  const entityStem = entityStemFromTestId(createTestId) || entityStemFromVocab(vocab);
  const saveTestId = (vocab.testIds || []).find((id) => /save|submit|confirm/i.test(id))
    || (createTestId ? createTestId.replace(/-(create|add|new)$/i, '-save') : null)
    || (entityStem ? `${entityStem}-save` : null);

  const prepared = prepareModuleTestCase({
    codeContext,
    title: intent?.rawTitle ?? uiPlan?.ask?.title ?? '',
    description: intent?.rawDescription ?? uiPlan?.ask?.description ?? '',
    matchedFeature: feature,
    intent: intent?.testData ? intent : { ...intent, testData: uiPlan?.ask?.testData },
    vocab,
    action,
  });

  const capabilities = prepared.capabilities || extractModuleCapabilities(codeContext || '');
  const testData = prepared.testData;
  const schema = prepared.schema;
  const resolvedValues = prepared.resolvedValues;
  const formFields = prepared.automationFields;
  const identityField = pickIdentityFieldFromSchema(schema);
  const formControl = testData.primaryField || identityField?.key
    || schema.fields?.find((f) => f.required && f.type !== 'dropdown')?.key;
  const nameValue = testData.primaryValue || (action === 'update' ? null : uniqueName(feature.split(/\s+/)[0] || 'Item'));
  const verifyText = resolveVerifyNeedle(testData, resolvedValues, schema)
    || nameValue
    || (action === 'update' ? (testData.existingRowNeedle || testData.searchTerm) : null);
  const createPerm = vocab.permissions.find((p) => /CREATE|ADD|NEW/i.test(p));
  const nameTestId = fieldTestId(vocab, formControl)
    || identityField?.testId
    || (vocab.testIds || []).find((id) => /-name$/i.test(id) && !/search/i.test(id))
    || (createTestId ? createTestId.replace(/-(create|add|new)$/i, '-name') : null);

  const steps = [];
  steps.push({
    id: 'goto',
    action: 'goto',
    path: route,
    description: `Open ${feature} at ${route}`,
  });

  if (action === 'create' || action === 'exercise') {
    steps.push({
      id: 'click-create',
      action: 'click',
      strategies: createButtonStrategies(vocab, entityStem),
      description: 'Click Add / Create',
    });
    for (const field of formFields) {
      const tid = field.testId || fieldTestId(vocab, field.formControl);
      const label = field.label || field.formControl;
      const meta = {
        testId: tid,
        componentType: field.componentType,
        wrapperTag: field.wrapperTag,
        innerTag: field.innerTag,
        standalone: field.standalone,
        binding: field.binding,
        type: field.kind === 'select' ? 'dropdown' : field.componentType,
      };
      steps.push({
        id: field.kind === 'select' ? `select-${field.formControl}` : `fill-${field.formControl}`,
        action: field.kind === 'select' ? 'select' : 'fill',
        formControl: field.formControl,
        testId: tid,
        label,
        strategies: field.kind === 'select'
          ? selectStrategiesForField(field.formControl, tid, meta)
          : fillStrategiesForField(field.formControl, tid, meta),
        value: field.value,
        componentType: field.componentType,
        standalone: field.standalone,
        binding: field.binding,
        description: field.kind === 'select'
          ? (field.value && field.value !== '__first__'
            ? `Select ${label} "${field.value}"`
            : `Select ${label} (first option)`)
          : `Fill ${label} with "${field.value}"`,
      });
    }
    steps.push({
      id: 'click-save',
      action: 'click',
      strategies: saveButtonStrategies(vocab, entityStem),
      description: 'Click Save / Submit',
    });
    steps.push({
      id: 'expect-name',
      action: 'expectText',
      text: verifyText,
      description: `Verify "${verifyText}" appears on screen`,
    });
  } else if (action === 'list') {
    if (testData.searchTerm) {
      steps.push({
        id: 'fill-search',
        action: 'fill',
        strategies: searchFillStrategies(vocab),
        value: testData.searchTerm,
        description: `Search for "${testData.searchTerm}"`,
      });
      steps.push({
        id: 'expect-search',
        action: 'expectText',
        text: testData.verifyText || testData.searchTerm,
        description: `Verify "${testData.verifyText || testData.searchTerm}" in results`,
      });
    } else {
      steps.push({
        id: 'expect-list',
        action: 'expectVisible',
        strategies: [
          { type: 'css', value: 'table tbody tr, [data-testid$="-row"], .mat-mdc-row, .list-container table' },
          { type: 'css', value: '[data-testid$="-list"], .list-container, table.mat-table, [role="table"]' },
        ],
        description: 'Verify list table is visible',
      });
    }
  } else if (action === 'delete') {
    const rowNeedle = normalizeRowNeedle(testData.existingRowNeedle || testData.searchTerm);
    if (rowNeedle) {
      steps.push({
        id: 'fill-search',
        action: 'fill',
        strategies: searchFillStrategies(vocab),
        value: rowNeedle,
        description: `Search for "${rowNeedle}"`,
      });
      if (capabilities.deleteMode === 'list-row') {
        steps.push({
          id: 'click-delete-row',
          action: 'click',
          strategies: deleteButtonStrategies(vocab, rowNeedle),
          description: `Delete row "${rowNeedle}" from list`,
        });
        steps.push({
          id: 'click-confirm',
          action: 'click',
          strategies: confirmDeleteStrategies(vocab, entityStem),
          description: 'Confirm delete in dialog',
        });
      } else {
        // CapBO: delete on edit form (e.g. retail-chain) — view mode hides delete button
        steps.push({
          id: 'click-edit',
          action: 'click',
          strategies: editButtonStrategies(vocab, rowNeedle),
          description: `Open edit for row "${rowNeedle}" before delete`,
        });
        steps.push({
          id: 'click-delete',
          action: 'click',
          strategies: deleteButtonStrategies(vocab, rowNeedle),
          description: 'Click Delete on edit form',
        });
        steps.push({
          id: 'click-confirm',
          action: 'click',
          strategies: confirmDeleteStrategies(vocab, entityStem),
          description: 'Confirm delete in dialog',
        });
      }
      if (rowNeedle) {
        steps.push({
          id: 'expect-absent',
          action: 'expectAbsent',
          text: rowNeedle,
          description: `Verify "${rowNeedle}" is no longer in the list`,
        });
      }
    } else {
      steps.push({
        id: 'click-delete',
        action: 'click',
        strategies: deleteButtonStrategies(vocab, rowNeedle),
        description: 'Click Delete',
      });
      steps.push({
        id: 'click-confirm',
        action: 'click',
        strategies: confirmDeleteStrategies(vocab, entityStem),
        description: 'Confirm delete in dialog',
      });
    }
  } else if (action === 'update') {
    const rowNeedle = normalizeRowNeedle(testData.existingRowNeedle || testData.searchTerm);
    const searchQ = rowNeedle;
    if (searchQ) {
      steps.push({
        id: 'fill-search',
        action: 'fill',
        strategies: searchFillStrategies(vocab),
        value: searchQ,
        description: `Search for "${searchQ}"`,
      });
    }
    steps.push({
      id: 'click-edit',
      action: 'click',
      strategies: editButtonStrategies(vocab, rowNeedle || searchQ),
      description: (rowNeedle || searchQ)
        ? `Click edit for row "${rowNeedle || searchQ}"`
        : 'Click edit on an existing row',
    });
    if (nameValue) {
      steps.push({
        id: 'fill-name',
        action: 'fill',
        strategies: fillStrategiesForField(formControl, nameTestId),
        value: nameValue,
        description: `Update ${formControl} to "${nameValue}"`,
      });
    }
    steps.push({
      id: 'click-save',
      action: 'click',
      strategies: [
        ...(saveTestId ? [{ type: 'testid', value: saveTestId }, { type: 'css', value: `[data-testid="${saveTestId}"]` }] : []),
        { type: 'css', value: 'button.save-button, button[data-testid$="-save"], button[data-testid*="save"]' },
        { type: 'role', role: 'button', name: 'save|submit|enregistrer', regex: true },
      ],
      description: 'Save changes',
    });
    if (verifyText) {
      steps.push({
        id: 'expect-name',
        action: 'expectText',
        text: verifyText,
        description: `Verify "${verifyText}" appears on screen`,
      });
    }
  } else if (action === 'view') {
    const rowNeedle = normalizeRowNeedle(testData.existingRowNeedle || testData.searchTerm);
    if (rowNeedle) {
      steps.push({
        id: 'fill-search',
        action: 'fill',
        strategies: searchFillStrategies(vocab),
        value: rowNeedle,
        description: `Search for "${rowNeedle}"`,
      });
      steps.push({
        id: 'click-view',
        action: 'click',
        strategies: viewButtonStrategies(vocab, rowNeedle),
        description: `Click view for row "${rowNeedle}"`,
      });
    } else {
      steps.push({
        id: 'click-view',
        action: 'click',
        strategies: viewButtonStrategies(vocab, rowNeedle),
        description: 'Click view on a list row',
      });
    }
  }

  const playwrightSource = buildRunnablePlaywrightSpec({
    feature,
    action,
    route,
    steps,
    data: { verifyText, nameValue, fields: resolvedValues },
    title: uiPlan?.title || `UI · ${action} ${feature}`,
  });

  return packageUiAutomationResult({
    uiPlan,
    feature,
    action,
    route,
    steps,
    testData,
    formControl,
    nameValue,
    verifyText,
    vocab,
    createTestId,
    saveTestId,
    nameTestId,
    createPerm,
    resolvedValues,
    formFields,
    playwrightSource,
    source: 'codegen',
  });
}

/** Shared packaging for deterministic codegen and AI materialized plans. */
export function packageUiAutomationResult({
  uiPlan,
  feature,
  action,
  route,
  steps,
  testData,
  formControl,
  nameValue,
  verifyText,
  vocab,
  createTestId,
  saveTestId,
  nameTestId,
  createPerm,
  resolvedValues,
  formFields,
  playwrightSource: _existingSource,
  source = 'codegen',
}) {
  // Always rebuild from steps — never keep stale getByTestId-only sources from older codegen
  void _existingSource;
  const playwrightSource = buildRunnablePlaywrightSpec({
    feature,
    action,
    route,
    steps,
    createTestId,
    saveTestId,
    data: { verifyText, nameValue, fields: resolvedValues, testDataEntries: testData.testDataEntries },
    title: uiPlan?.title || `UI · ${action} ${feature}`,
  }, { createTestId, saveTestId, title: uiPlan?.title || `UI · ${action} ${feature}` });

  return {
    kind: 'ui',
    engine: 'playwright',
    feature,
    action,
    route,
    source,
    data: {
      nameValue,
      verifyText,
      formControl,
      fields: resolvedValues,
      existingRowNeedle: testData.existingRowNeedle || null,
      searchTerm: testData.searchTerm || testData.existingRowNeedle || null,
      formSchema: testData.formSchema || null,
      testDataEntries: testData.testDataEntries || formFields.map((f) => ({
        key: f.formControl,
        label: f.label || f.formControl,
        value: f.value,
        source: testData.fields?.[f.formControl] != null ? 'description' : 'code-default',
        kind: f.kind,
        required: f.required,
        testId: f.testId,
      })),
      fromDescription: testData.fromDescription,
    },
    steps,
    playwrightSource,
    sourceRefs: uiPlan?.sourceRefs || vocab.paths,
    acceptanceCriteria: uiPlan?.acceptanceCriteria || [],
  };
}

function renderSearchLocatorExpr(steps = []) {
  const testIds = new Set();
  for (const s of steps) {
    if (s.testId) testIds.add(s.testId);
    for (const st of s.strategies || []) {
      if (st.type === 'testid' && st.value) testIds.add(st.value);
    }
  }
  const ids = [...testIds];
  const searchId = ids.find((id) => /-search$/i.test(id))
    || ids.find((id) => /search/i.test(id));
  if (searchId) return `page.getByTestId(${JSON.stringify(searchId)})`;
  const stem = entityStemFromTestId(ids.find((id) => /-(create|save|name)$/i.test(id)));
  if (stem) return `page.getByTestId(${JSON.stringify(`${stem}-search`)})`;
  return 'page.locator(\'[data-testid$="-search"], input[formcontrolname="searchTerm"], input[formControlName="searchTerm"]\').first()';
}

/** Collect testIds from automation steps (any module — no hardcoded stems). */
export function vocabFromSteps(steps = []) {
  const testIds = new Set();
  for (const s of steps || []) {
    if (s?.testId) testIds.add(s.testId);
    for (const st of s.strategies || []) {
      if (st.type === 'testid' && st.value) testIds.add(st.value);
    }
  }
  return { testIds: [...testIds] };
}

function isRowActionClick(step = {}) {
  const desc = step.description || '';
  return step.id === 'click-edit' || step.id === 'click-view' || step.id === 'click-delete-row'
    || (/edit for row|click edit|edit button/i.test(desc))
    || (/click view|view for row|view button|eye icon/i.test(desc));
}

function rowActionKindFromStep(step = {}) {
  if (step.id === 'click-view' || /click view|view for row|view button|eye icon/i.test(step.description || '')) return 'view';
  if (step.id === 'click-delete-row' || /delete row/i.test(step.description || '')) return 'delete';
  return 'edit';
}

/** Build row-scoped edit/view locator when list has many row action buttons (stem from indexed testIds). */
function rowActionLocatorExpr(needle, strategies = [], testId = null, vocab = null, actionKind = 'edit') {
  const q = String(needle || '').trim();
  if (!q) return null;
  const ids = vocab?.testIds || vocabFromSteps([]).testIds;
  const suffix = actionKind === 'view' ? '-view' : actionKind === 'delete' ? '-delete' : '-edit';
  const actionTid = testId
    || ids.find((id) => new RegExp(`${suffix}$`, 'i').test(id))
    || (strategies || []).find((s) => s.type === 'testid' && new RegExp(`${suffix}$`, 'i').test(s.value || ''))?.value
    || (strategies || []).find((s) => {
      const m = String(s.value || '').match(new RegExp(`\\[data-testid="([^"]+${suffix.slice(1)})"\\]`));
      return m?.[1];
    })?.value
    || null;
  const rowTid = ids.find((id) => /-row$/i.test(id))
    || (strategies || []).find((s) => s.type === 'testid' && /-row$/i.test(s.value || ''))?.value
    || (actionTid ? actionTid.replace(new RegExp(`${suffix}$`, 'i'), '-row') : null);
  if (rowTid && actionTid) {
    return `page.locator("[data-testid=\\"${rowTid}\\"]:has-text(\\"${q}\\") [data-testid=\\"${actionTid}\\"]").first()`;
  }
  const actionAttr = actionKind === 'view' ? '-view' : actionKind === 'delete' ? '-delete' : '-edit';
  return `page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: ${JSON.stringify(q)} }).locator('[data-testid$="${actionAttr}"]').first()`;
}

function renderLocatorExpr(strategies, testId, formControl, opts = {}) {
  const { standalone = false, preferRowScoped = false, rowNeedle = null, rowVocab = null, rowActionKind = 'edit' } = opts;
  // Prefer real action controls — never emit *-form / cancel as primary locator
  const bad = (id) => /-(form|cancel|back|close)$/i.test(String(id || ''));
  if (preferRowScoped) {
    const rowCss = (strategies || []).find(
      (s) => s.type === 'css' && /has-text|tbody tr/i.test(String(s.value || '')),
    );
    if (rowCss?.value) return `page.locator(${JSON.stringify(rowCss.value)}).first()`;
    const synthesized = rowActionLocatorExpr(rowNeedle, strategies, testId, rowVocab, opts.rowActionKind || 'edit');
    if (synthesized) return synthesized;
    // Never fall back to bare *-edit / *-view when multiple rows may match
    const safeCss = (strategies || []).find(
      (s) => s.type === 'css'
        && !/data-testid="[^"]*-form"/i.test(String(s.value || ''))
        && !/\[data-testid\$="-edit"\]$/.test(String(s.value || '')),
    );
    if (safeCss?.value) return `page.locator(${JSON.stringify(safeCss.value)}).first()`;
    return null;
  }
  if (testId && !bad(testId)) {
    const byTid = `page.getByTestId(${JSON.stringify(testId)})`;
    if (!standalone && formControl) {
      return `${byTid}.or(page.locator('[formcontrolname="${formControl}"], [formControlName="${formControl}"]')).first()`;
    }
    return byTid;
  }
  const tid = (strategies || []).find((s) => s.type === 'testid' && !bad(s.value));
  if (tid?.value) {
    const byTid = `page.getByTestId(${JSON.stringify(tid.value)})`;
    if (!standalone && formControl) {
      return `${byTid}.or(page.locator('[formcontrolname="${formControl}"], [formControlName="${formControl}"]')).first()`;
    }
    return byTid;
  }
  const css = (strategies || []).find((s) => s.type === 'css' && !/data-testid="[^"]*-form"/i.test(String(s.value || '')));
  if (css?.value) return `page.locator(${JSON.stringify(css.value)}).first()`;
  if (!standalone && formControl) {
    return `page.locator('[formcontrolname="${formControl}"], input[formControlName="${formControl}"]').first()`;
  }
  return null;
}

/** CapBO list path — strip /details so create starts on list (save uses history.back()). */
function listPathForSpec(routeOrPath = '/') {
  let p = String(routeOrPath || '/').trim();
  try {
    if (p.startsWith('http')) p = new URL(p).pathname;
  } catch { /* keep */ }
  p = p.split('?')[0].replace(/\/+$/, '') || '/';
  p = p.replace(/\/details.*$/i, '').replace(/\/(new|create|edit|view)(\/|$)/i, '/');
  return p.replace(/\/+$/, '') || '/';
}

function searchTestIdFromSteps(steps = []) {
  for (const s of steps) {
    if (s.testId && /-search$/i.test(s.testId)) return s.testId;
    for (const st of s.strategies || []) {
      if (st.type === 'testid' && st.value && /-search$/i.test(st.value)) return st.value;
    }
  }
  const expr = renderSearchLocatorExpr(steps);
  const m = expr.match(/getByTestId\((["'])(.+?)\1\)/);
  return m?.[2] || null;
}

function isListChromeTestId(testId) {
  return /search|filter|active|export|paginator|toolbar|header|list-table|row-/i.test(String(testId || ''));
}

/** Attach schema labels/testIds/strategies to a fill/select step. */
function enrichFillSelectStep(step, fieldByKey) {
  if (!step || (step.action !== 'fill' && step.action !== 'select') || !step.formControl) return step;
  const meta = fieldByKey.get(step.formControl) || {};
  let testId = step.testId || meta.testId || null;
  if (isListChromeTestId(testId)) testId = meta.testId && !isListChromeTestId(meta.testId) ? meta.testId : null;
  const label = step.label || meta.label || step.formControl;
  const isSelect = step.action === 'select'
    || interactionKindForField(meta, step.value) === 'select'
    || meta.type === 'dropdown';
  let strategies = step.strategies?.length ? step.strategies : null;
  if (!strategies?.length) {
    strategies = isSelect
      ? buildSelectStrategies({
        key: step.formControl,
        testId,
        wrapperTag: meta.wrapperTag,
        innerTag: meta.innerTag,
        formControl: step.formControl,
      })
      : buildFillStrategies({
        key: step.formControl,
        testId,
        formControl: step.formControl,
        standalone: meta.standalone,
        binding: meta.binding,
      });
  }
  const invented = isSelect && isInventedDropdownValue(step.value, step.formControl);
  const value = isSelect && (invented || step.value == null || step.value === '') ? '__first__' : step.value;
  return {
    ...step,
    action: isSelect ? 'select' : step.action,
    testId,
    label,
    value,
    componentType: step.componentType || meta.componentType,
    standalone: meta.standalone ?? step.standalone,
    binding: meta.binding ?? step.binding,
    strategies: strategies || step.strategies || [],
  };
}

function stepNeedsSchemaRebuild(step, fieldByKey) {
  if (!step?.formControl || (step.action !== 'fill' && step.action !== 'select')) return false;
  if (!step.strategies?.length) return true;
  const meta = fieldByKey.get(step.formControl);
  if (!meta?.testId) return false;
  const hasTestId = (step.strategies || []).some((s) => s.type === 'testid' && s.value === meta.testId);
  return !hasTestId && !step.testId;
}

/** Attach schema labels/testIds to select steps; sort fills by form order. */
function enrichAndOrderFillSteps(steps, fieldByKey) {
  const orderOf = (key) => fieldByKey.get(key)?.order ?? 9999;
  const enriched = steps.map((s) => {
    if ((s.action !== 'fill' && s.action !== 'select') || !s.formControl) return s;
    return enrichFillSelectStep(s, fieldByKey);
  });
  return normalizeAutomationStepOrder(
    enriched.sort((a, b) => {
      const rank = (s) => {
        if (s.action === 'goto') return 0;
        if (s.id === 'click-create' || isCreateClickStep(s)) return 1;
        if (s.id === 'fill-search') return 2;
        if (s.action === 'fill' || s.action === 'select') return 10 + orderOf(s.formControl);
        if (s.action === 'click' && isSaveClickStep(s)) return 90;
        if (s.action === 'expectText') return 100;
        return 50;
      };
      return rank(a) - rank(b);
    }),
  );
}

/** Scope host for dropdowns inside MatDialog create forms. */
const FORM_SCOPE_LOC = `page.locator('mat-dialog-container form, [role="dialog"] form, form').first()`;

function selectHostExpr(strategies, testId, formControl, standalone) {
  const loc = renderLocatorExpr(strategies, testId, formControl, { standalone });
  return loc || FORM_SCOPE_LOC;
}

function selectLabelArg(step, fieldByKey) {
  const meta = fieldByKey?.get(step.formControl) || {};
  const label = step.label || meta.label;
  return label ? `, ${JSON.stringify(label)}` : '';
}

function pushTestStep(lines, title, codeLines) {
  const label = String(title || 'Step').replace(/\s+/g, ' ').trim();
  const body = (codeLines || []).map((l) => l.replace(/^\s+/, '')).filter(Boolean);
  if (!body.length) return;
  lines.push(`    await test.step(${JSON.stringify(label)}, async () => {`);
  for (const c of body) lines.push(`      ${c}`);
  lines.push('    });');
}

function createFormBodyLines(createTid) {
  if (!createTid) throw new Error('Cannot open create form — no *-create data-testid in CapBO code');
  const nameRe = createButtonNamePattern({});
  return [
    `await clickListCreate(page, ${JSON.stringify(createTid)}, ${JSON.stringify(nameRe)});`,
  ];
}

/** verifyInList call — update/delete search by row identity, assert changed field in row. */
function buildVerifyInListCall(listPath, assertText, searchTid, action, data, steps) {
  const rowNeedle = normalizeRowNeedle(
    data?.existingRowNeedle || data?.searchTerm || data?.searchNeedle
      || steps.find((s) => s.id === 'fill-search')?.value,
  );
  const text = String(assertText ?? '').trim();
  const isUpdateStyle = /^(update|delete)$/i.test(action) && rowNeedle && rowNeedle !== text;
  if (isUpdateStyle) {
    return `await verifyInList(page, ${JSON.stringify(listPath)}, ${JSON.stringify(text)}, ${JSON.stringify(searchTid)}, { searchNeedle: ${JSON.stringify(rowNeedle)} });`;
  }
  return `await verifyInList(page, ${JSON.stringify(listPath)}, ${JSON.stringify(text)}, ${JSON.stringify(searchTid)});`;
}

/**
 * Runnable Playwright spec — SSO session, fill/select from step strategies, saved to generated-e2e/.
 * In-app routes use spaNavigate (no full reload). Create: list → Add → form → save → verifyInList.
 */
export function buildRunnablePlaywrightSpec(automation, meta = {}) {
  const {
    feature = automation.feature || 'feature',
    action = automation.action || 'create',
    route = automation.route || '/',
    steps = [],
    data = {},
  } = automation;
  const title = meta.title || automation.title || `UI · ${action} ${feature}`;
  const verifyText = resolveVerifyNeedle(data, data.fields, data.formSchema)
    || data.verifyText
    || data.nameValue
    || '';
  const fieldByKey = new Map((data.formSchema?.fields || []).map((f) => [f.key, f]));
  const listPath = listPathForSpec(route);
  const searchTid = searchTestIdFromSteps(steps);
  const hasCreateClickStep = steps.some((s) => isCreateClickStep(s));
  const needsCreateClick = /^(create|exercise)$/i.test(action) && !hasCreateClickStep;
  // Create testId from code only (search→create rewrite, or step/automation vocab) — never invent from feature name
  const createTid = searchTid
    ? String(searchTid).replace(/-search$/i, '-create')
    : (meta.createTestId || automation.createTestId || null);
  // If rewrite produced a stem that isn't a known code testId, still use it only when searchTid came from code
  const lines = [];

  lines.push('// Auto-generated by Nocta QA — run: cd nocta-backend && npx playwright test generated-e2e/<file>.spec.ts --headed');
  lines.push('// Fast path (~10s): run auth.setup once (E2E_AUTH_SETUP=1), then reuse generated-e2e/.auth/user.json');
  lines.push('// Requires TARGET_APP_URL, APP_TEST_USERNAME, APP_TEST_PASSWORD in env or Settings');
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("import { ensureCapboSession, spaNavigate, verifyInList, assertAbsentInList, fillAngularField, fillMatAutocomplete, selectMatDropdown, waitForEditFormReady, waitForViewFormReady, waitForFormSave, clickListCreate, clickFormSave } from './helpers/capbo-ui';");
  lines.push('');
  lines.push(`test.describe(${JSON.stringify(feature)}, () => {`);
  lines.push('  test.setTimeout(90_000);');
  lines.push('');
  lines.push(`  test(${JSON.stringify(title)}, async ({ page }) => {`);
  pushTestStep(lines, 'Establish authenticated CapBO session', ['await ensureCapboSession(page);']);
  lines.push('');

  let emittedExpect = false;
  let emittedCreate = false;
  const rowNeedle = normalizeRowNeedle(
    data.existingRowNeedle || data.searchTerm || data.searchNeedle
      || steps.find((s) => s.id === 'fill-search')?.value,
  );
  const rowVocab = vocabFromSteps(steps);
  for (const s of steps) {
    const stepTitle = s.description || s.action || 'Step';
    if (s.action === 'goto') {
      const p = listPathForSpec(s.path || route || '/');
      pushTestStep(lines, stepTitle, [`await spaNavigate(page, ${JSON.stringify(p)});`]);
      if (needsCreateClick && !emittedCreate) {
        emittedCreate = true;
        pushTestStep(lines, 'Open create form via Add button', createFormBodyLines(createTid));
      }
    } else if ((s.action === 'fill' || s.action === 'select') && needsCreateClick && !emittedCreate) {
      emittedCreate = true;
      pushTestStep(lines, `Navigate to ${listPath}`, [`await spaNavigate(page, ${JSON.stringify(listPath)});`]);
      pushTestStep(lines, 'Open create form via Add button', createFormBodyLines(createTid));
      if (s.action === 'fill') {
        const loc = renderLocatorExpr(s.strategies, s.testId, s.formControl, { standalone: s.standalone });
        if (loc) {
          const fillFn = s.componentType === 'autocomplete' ? 'fillMatAutocomplete' : 'fillAngularField';
          pushTestStep(lines, stepTitle, [`await ${fillFn}(page, ${loc}, ${JSON.stringify(String(s.value ?? ''))});`]);
        }
      } else {
        const host = selectHostExpr(s.strategies, s.testId, s.formControl, s.standalone);
        const pick = s.value === '__first__' || s.value == null ? 'first' : String(s.value);
        const labelArg = selectLabelArg(s, fieldByKey);
        pushTestStep(lines, stepTitle, [`await selectMatDropdown(page, ${host}, ${JSON.stringify(pick)}${labelArg});`]);
      }
    } else if (s.action === 'fill') {
      const loc = renderLocatorExpr(s.strategies, s.testId, s.formControl, { standalone: s.standalone });
      if (loc) {
        const fillFn = s.componentType === 'autocomplete' ? 'fillMatAutocomplete' : 'fillAngularField';
        const fillBody = [`await ${fillFn}(page, ${loc}, ${JSON.stringify(String(s.value ?? ''))});`];
        if (s.id === 'fill-search' && s.value) {
          fillBody.push('await page.waitForTimeout(900);');
          fillBody.push(
            `await page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: ${JSON.stringify(String(s.value))} }).first().waitFor({ state: 'visible', timeout: 20000 });`,
          );
        }
        pushTestStep(lines, stepTitle, fillBody);
      }
    } else if (s.action === 'select') {
      const host = selectHostExpr(s.strategies, s.testId, s.formControl, s.standalone);
      const pick = s.value === '__first__' || s.value == null ? 'first' : String(s.value);
      const labelArg = selectLabelArg(s, fieldByKey);
      pushTestStep(lines, stepTitle, [`await selectMatDropdown(page, ${host}, ${JSON.stringify(pick)}${labelArg});`]);
    } else if (s.action === 'click') {
      const desc = s.description || '';
      const isSave = isSaveClickStep(s)
        || /-(save|submit)$/i.test(String(s.testId || ''))
        || (/save|submit|enregistrer/i.test(desc) && !isCreateClickStep(s));
      const isCreate = !isSave && isCreateClickStep(s);
      let tid = s.testId;
      if (tid && /-(form|cancel|back|close)$/i.test(tid)) tid = null;
      if (isSave && (!tid || !/save|submit/i.test(tid))) {
        const fromStrat = (s.strategies || []).find((x) => x.type === 'testid' && /save|submit/i.test(x.value || ''));
        tid = fromStrat?.value || tid;
      }
      const isRowAction = isRowActionClick(s)
        || (/edit for row|click edit on|click the ['"]?edit/i.test(desc) && !isSave && !isCreate);
      const isDeleteClick = s.id === 'click-delete' || s.id === 'click-delete-row';
      const isConfirmClick = s.id === 'click-confirm';
      const rowActionKind = rowActionKindFromStep(s);
      const loc = renderLocatorExpr(s.strategies, tid, null, {
        preferRowScoped: isRowAction,
        rowNeedle,
        rowVocab,
        rowActionKind,
      });
      const clickBody = [];
      if (isCreate) {
        const createTid = tid
          || (s.strategies || []).find((x) => x.type === 'testid' && /-(create|add|new)$/i.test(x.value || ''))?.value
          || meta.createTestId
          || automation.createTestId
          || null;
        const roleStrat = (s.strategies || []).find((x) => x.type === 'role' && x.name);
        const nameRe = roleStrat?.name || createButtonNamePattern({});
        if (!createTid && !roleStrat) {
          throw new Error('Create click missing code testId — add data-testid on CapBO Add button');
        }
        clickBody.push(
          `await clickListCreate(page, ${JSON.stringify(createTid)}, ${JSON.stringify(nameRe)});`,
        );
        emittedCreate = true;
      } else if (isSave && (loc || tid)) {
        clickBody.push(tid
          ? `await clickFormSave(page, ${JSON.stringify(tid)});`
          : `await clickFormSave(page);`);
        if (/^(create|update|delete)$/i.test(action)) {
          clickBody.push('await waitForFormSave(page);');
        }
      } else if (isConfirmClick) {
        const confirmLoc = renderLocatorExpr(s.strategies, s.testId, null);
        if (confirmLoc) {
          clickBody.push(`await ${confirmLoc}.click({ timeout: 15000 });`);
        } else {
          clickBody.push('await page.getByTestId("confirm").or(page.locator(\'[data-testid="confirm"]\')).first().click({ timeout: 15000 });');
        }
      } else if (loc) {
        clickBody.push(`await ${loc}.click({ timeout: 15000 });`);
        if (isDeleteClick) {
          clickBody.push('await page.getByTestId("confirm").or(page.locator(\'[data-testid="confirm"]\')).first().waitFor({ state: \'visible\', timeout: 15000 }).catch(() => {});');
        } else if (isRowAction && rowActionKind === 'view') clickBody.push('await waitForViewFormReady(page);');
        else if (isRowAction) clickBody.push('await waitForEditFormReady(page);');
      } else if (isSave) {
        throw new Error('Save click missing code testId — add data-testid on CapBO Save button');
      }
      if (clickBody.length) pushTestStep(lines, stepTitle, clickBody);
    } else if (s.action === 'expectText') {
      if (/^delete$/i.test(action)) {
        // Delete must use expectAbsent — verifyInList would assert row still visible
        lines.push('');
        continue;
      }
      const text = (!s.text || isGenericOutcomePhrase(s.text) || isListMetaPhrase(s.text)) ? verifyText : s.text;
      const skipListMeta = /^list$/i.test(action) && isListMetaPhrase(text);
      const hasSearch = steps.some((x) => x.id === 'fill-search') || data.searchTerm;
      if (text && !emittedExpect && !skipListMeta && (!/^list$/i.test(action) || hasSearch)) {
        emittedExpect = true;
        pushTestStep(
          lines,
          stepTitle || `Verify "${text}" appears in list`,
          [buildVerifyInListCall(listPath, text, searchTid, action, data, steps)],
        );
      }
    } else if (s.action === 'expectAbsent') {
      const needle = String(s.text || data.existingRowNeedle || data.searchTerm || '').trim();
      if (needle) {
        emittedExpect = true;
        pushTestStep(
          lines,
          stepTitle || `Verify "${needle}" is no longer in the list`,
          [`await assertAbsentInList(page, ${JSON.stringify(listPath)}, ${JSON.stringify(needle)}, ${JSON.stringify(searchTid)});`],
        );
      }
    } else if (s.action === 'expectVisible') {
      const listTid = (rowVocab.testIds || []).find((id) => /-list$/i.test(id));
      if (listTid) {
        pushTestStep(lines, stepTitle || 'Verify list is visible', [
          `await expect(page.getByTestId(${JSON.stringify(listTid)})).toBeVisible();`,
        ]);
      } else {
        pushTestStep(lines, stepTitle || 'Verify list table is visible', [
          `await expect(page.locator('[data-testid$="-list"], table, .mat-table, [role="table"]').first()).toBeVisible();`,
        ]);
      }
    }
    lines.push('');
  }

  const hasSearchStep = steps.some((s) => s.id === 'fill-search');
  const canVerifyInList = verifyText
    && !isGenericOutcomePhrase(verifyText)
    && !isListMetaPhrase(verifyText)
    && !/^delete$/i.test(action)
    && !/^view$/i.test(action)
    && (!/^list$/i.test(action) || hasSearchStep || data.searchTerm);

  if (canVerifyInList && !emittedExpect && !steps.some((s) => s.action === 'expectText')) {
    pushTestStep(
      lines,
      `Verify "${verifyText}" appears in list`,
      [buildVerifyInListCall(listPath, verifyText, searchTid, action, data, steps)],
    );
    lines.push('');
  }

  lines.push('  });');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function renderPlaywrightSpec({
  title, feature, route, steps, nameValue, verifyText, formControl, createPerm,
  createTestId, saveTestId, nameTestId, sourceRefs,
}) {
  return buildRunnablePlaywrightSpec({
    feature,
    action: 'create',
    route,
    steps,
    data: { verifyText: verifyText || nameValue, nameValue },
    title,
  });
}

/**
 * Extract CapBO/Symfony REST endpoints from indexed backend code.
 * Supports: #[Route('/api/...')] class + method attributes, OpenAPI addPath.
 */
export function extractApiEndpoints(codeContext) {
  const text = String(codeContext || '');
  const endpoints = [];
  const seen = new Set();

  const push = (method, path, name = '') => {
    const m = String(method || 'GET').toUpperCase();
    let p = String(path || '').trim();
    if (!p) return;
    if (!p.startsWith('/')) p = `/${p}`;
    p = p.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    // CapBO controllers use /api/... ; OpenAPI paths may already include it.
    // Prefer prepending /api when context already exposes this collection under /api or *Url.
    if (!p.startsWith('/api/') && /^\/[a-z0-9/_-]+$/i.test(p)) {
      const bare = p.replace(/^\//, '');
      if (
        new RegExp(`/api/${bare}(?:/|'|"|\`|\\s|$)`, 'i').test(text)
        || new RegExp(`\\w+Url\\s*=\\s*\`\\$\\{[^}]+\\}/${bare}\``, 'i').test(text)
      ) {
        p = `/api${p}`;
      }
    }
    const key = `${m} ${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({ method: m, path: p, name: String(name || '') });
  };

  // Class-level Route + method Route (Symfony PHP attributes)
  const classRoute = text.match(/#\[Route\('(\/api\/[^']+)'/);
  const base = classRoute?.[1] || '';
  const routeRe = /#\[Route\('([^']*)'(?:[^[\]]*name:\s*'([^']*)')?[^[\]]*methods:\s*\['([A-Z]+)'\]/g;
  let rm;
  while ((rm = routeRe.exec(text)) !== null) {
    const sub = rm[1] || '';
    const full = `${base}${sub}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || base || '/';
    push(rm[3], full.startsWith('/') ? full : `/${full}`, rm[2] || '');
  }

  // OpenAPI decorator: $paths->addPath('/api/currencies', new PathItem( get:..., post:... ))
  for (const m of text.matchAll(/addPath\(\s*'(\/api\/[^']+)'\s*,\s*new PathItem\(([\s\S]*?)\)\s*\)/g)) {
    const path = m[1];
    const body = m[2] || '';
    for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
      if (new RegExp(`\\b${verb}\\s*:`).test(body)) push(verb.toUpperCase(), path);
    }
  }

  // Frontend Angular service: this.http.post(`${currenciesUrl}`, data) / `${baseUrl}/currencies`
  for (const m of text.matchAll(/http\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/gi)) {
    let path = m[2];
    // Skip unresolved template vars unless they already look like an API path
    if (/\$\{/.test(path) && !/\/api\//.test(path) && !/\w+Url/.test(path)) continue;
    path = path.replace(/\$\{[^}]+\}/g, '');
    if (/^https?:\/\//i.test(path)) {
      try { path = new URL(path).pathname; } catch { /* keep */ }
    }
    if (path.includes('/')) push(m[1], path.startsWith('/') ? path : `/${path}`);
  }
  // Any Angular service: currenciesUrl / articlesUrl / … = `${baseUrl}/collection`
  for (const m of text.matchAll(
    /\w+Url\s*=\s*`\$\{[^}]+\}(\/[^`]+)`/g,
  )) {
    push('GET', m[1].startsWith('/api') ? m[1] : `/api${m[1]}`);
    push('POST', m[1].startsWith('/api') ? m[1] : `/api${m[1]}`);
  }

  return endpoints;
}

/** CapBO REST collection path derived from indexed *Url / /api/… hits for the feature. */
export function resolveApiCollectionPath(matchedFeature, codeContext = '') {
  const text = `${matchedFeature || ''} ${codeContext || ''}`;
  const slug = slugFromFeature(matchedFeature);
  const stem = (s) => String(s || '')
    .toLowerCase()
    .replace(/ies$/, 'y')
    .replace(/ses$/, 's')
    .replace(/s$/, '');
  const featureTokens = [slug, stem(slug), ...String(matchedFeature || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)];

  const candidates = new Set();
  for (const m of text.matchAll(/\w+Url\s*=\s*`\$\{[^}]+\}(\/[^`]+)`/g)) {
    const p = m[1].startsWith('/api') ? m[1] : `/api${m[1]}`;
    candidates.add(p.replace(/\/$/, ''));
  }
  for (const m of text.matchAll(/#\[Route\('(\/api\/[^']+)'/g)) {
    candidates.add(m[1].replace(/\/$/, ''));
  }
  for (const m of text.matchAll(/\/api\/[a-z0-9_-]+/gi)) {
    candidates.add(m[0].replace(/\/$/, ''));
  }

  const scored = [...candidates]
    .filter((p) => !/article[-_]?ecotax|article_ecotax|article-hierarch/i.test(p))
    .map((p) => {
      const seg = p.replace(/^\/api\//i, '').split('/')[0].toLowerCase();
      let score = 0;
      for (const t of featureTokens) {
        if (!t) continue;
        if (seg === t || stem(seg) === stem(t)) score += 10;
        else if (seg.includes(t) || t.includes(seg)) score += 4;
      }
      // Prefer collection roots over nested paths
      if (p.split('/').length <= 3) score += 2;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.length - b.p.length);

  if (scored.length) return scored[0].p;

  // Last-resort heuristics when live chunks omit Url/Route (same modules as CapBO MVP)
  if (/\/api\/ecotaxes|EcotaxController|ecotaxesUrl|eco[\s_-]?tax/i.test(text)) return '/api/ecotaxes';
  if (/\/api\/currencies|CurrencyController|currenciesUrl|\bcurrenc/i.test(text)) return '/api/currencies';
  if (/\/api\/vats|VatController|vatsUrl|\bvat\b/i.test(text)) return '/api/vats';
  if (/\/api\/partners|PartnerController|partnersUrl|\bpartner/i.test(text)) return '/api/partners';
  if (/\/api\/retail-chains|RetailChainController|retailChainsUrl|retail[\s_-]?chain/i.test(text)) {
    return '/api/retail-chains';
  }
  if (
    /ArticleOpenApiDecorator|articlesUrl|articles_v2_create|\barticles?\b/i.test(text)
    && !/article[-_]?ecotax|article_ecotax|article-hierarch/i.test(text)
  ) {
    return '/api/articles';
  }
  return null;
}

function defaultApiRequiredFields(collectionPath, codeContext = '') {
  // Prefer OpenAPI / $requiredFields from context — only use empty when nothing indexed.
  // Kept as thin path-based fallbacks for truncated RAG (same as historical CapBO modules).
  const p = String(collectionPath || '');
  const text = String(codeContext || '');
  if (/ecotaxes/i.test(p) || /EcotaxController|eco[\s_-]?tax/i.test(text)) {
    return ['code', 'name', 'display_label', 'category', 'calculation_mode', 'value', 'vat_id'];
  }
  if (/currencies/i.test(p) || /CurrencyController/i.test(text)) {
    return ['code', 'numericCode', 'name', 'symbol', 'roundingIncrement'];
  }
  if (/vats/i.test(p)) return ['code', 'name', 'rate'];
  if (/partners/i.test(p)) return ['code', 'name'];
  if (/retail-chains/i.test(p)) return ['code', 'name'];
  if (/\/articles\b/i.test(p) && !/article-ecotax|article_ecotax/i.test(p)) {
    return ['code', 'shortDesignation'];
  }
  return [];
}

/** Required JSON body fields from OpenAPI createSchema or $requiredFields arrays. */
export function extractApiRequiredFields(codeContext) {
  const text = String(codeContext || '');
  const fields = [];
  const seen = new Set();

  const add = (f) => {
    const k = String(f || '').trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    fields.push(k);
  };

  for (const m of text.matchAll(/\$requiredFields\s*=\s*\[([^\]]+)\]/g)) {
    for (const f of m[1].matchAll(/'([^']+)'/g)) add(f[1]);
  }
  // 'required' => ['code', 'numericCode', ...]
  for (const m of text.matchAll(/['"]required['"]\s*=>\s*\[([^\]]+)\]/g)) {
    for (const f of m[1].matchAll(/'([^']+)'/g)) add(f[1]);
  }
  // OpenAPI JS-ish: required: ['code', 'numericCode', ...]
  for (const m of text.matchAll(/required\s*:\s*\[([^\]]+)\]/g)) {
    for (const f of m[1].matchAll(/['"]([^'"]+)['"]/g)) add(f[1]);
  }

  return fields;
}

/** True when ask/UI means “pick first dropdown option” for this API field. */
export function askWantsFirstOption(field, intent = {}, testData = {}) {
  const key = String(field || '');
  const v = testData?.fields?.[key]
    ?? testData?.fields?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]
    ?? testData?.fields?.[key.replace(/Id$/, '')];
  if (v === '__first__' || v === 'first' || v === true) return true;

  const ask = `${intent?.rawDescription || ''} ${intent?.rawTitle || ''} ${intent?.summary || ''}`.toLowerCase();
  if (!/first\s+option|1st\s+option|premier\s+choix/.test(ask)) return false;

  // "use first option for category, calculation mode, and VAT"
  if (/^category$/i.test(key) && /categor/.test(ask)) return true;
  if (/calculation_mode/i.test(key) && /calculation/.test(ask)) return true;
  if (/vat_id|^vat$/i.test(key) && /\bvat\b/.test(ask)) return true;
  // Broad: “first option” with no field list → treat enum/FK dropdowns as first
  if (!/for\s+\w+/.test(ask) && /category|calculation_mode|vat_id/i.test(key)) return true;
  return false;
}

/**
 * CapBO dropdown → API field resolvers (same as UI “first option”).
 * Enums: GET /api/shared/enum-values/{type} → .value
 * FK lists: GET /api/…/dropdowns → .id
 */
export function buildApiFirstResolvers(collectionPath, body = {}, intent = {}, testData = {}) {
  const path = String(collectionPath || '');
  const resolvers = [];
  const push = (field, apiPath, pick) => {
    if (resolvers.some((r) => r.field === field)) return;
    const cur = body?.[field];
    const wantsFirst = askWantsFirstOption(field, intent, testData)
      || cur === '__first__'
      || cur === 'first';
    const missing = cur == null || cur === '';
    // Enum defaults (RCP…) are fine unless ask says first; FK ids must be fetched when missing
    if (!wantsFirst && !missing) return;
    if (!wantsFirst && missing && !/_id$/i.test(field)) return;
    resolvers.push({ field, path: apiPath, pick });
  };

  if (/ecotaxes/i.test(path)) {
    push('category', '/api/shared/enum-values/ecotax_category', 'value');
    push('calculation_mode', '/api/shared/enum-values/ecotax_calculation_mode', 'value');
    push('vat_id', '/api/vats/dropdowns', 'id');
  }
  return resolvers;
}

function sampleApiFieldValue(field, testData, suffix) {
  const key = String(field || '');
  const fromAsk = testData?.fields?.[key] ?? testData?.[key];
  if (fromAsk != null && fromAsk !== '' && fromAsk !== '__first__') return fromAsk;
  if (key === testData?.primaryField && testData?.primaryValue) return testData.primaryValue;

  const lower = key.toLowerCase();
  if (/^code$/i.test(key) || /currencycode|alphacode/i.test(lower)) {
    const raw = String(testData?.fields?.code || testData?.verifyText || `Q${suffix.slice(-2)}`);
    // Currency ISO codes are 3 letters; eco-tax / VAT codes keep full ask value
    if (/^[A-Za-z]{3}$/.test(raw) || raw.length <= 3) return raw.toUpperCase().padEnd(3, 'X');
    return raw;
  }
  if (/numeric/i.test(lower)) return String(testData?.fields?.numericCode || suffix.slice(-3).padStart(3, '0'));
  if (/^name$/i.test(key) || /displayname|^display_label$/i.test(lower)) {
    return testData?.fields?.name
      || testData?.fields?.display_label
      || testData?.verifyText
      || `API ${suffix}`;
  }
  if (/shortdesignation|short_designation/i.test(lower)) {
    return testData?.fields?.shortDesignation
      || testData?.fields?.short_designation
      || testData?.verifyText
      || `Article ${suffix}`;
  }
  if (/category/i.test(lower)) return testData?.fields?.category || 'RCP';
  if (/calculation_mode|calculationmode/i.test(lower)) {
    return testData?.fields?.calculation_mode || testData?.fields?.calculationMode || 'FIXED_AMOUNT';
  }
  if (/vat_id|vatid/i.test(lower)) return testData?.fields?.vat_id ?? null;
  if (/symbol/i.test(lower)) return testData?.fields?.symbol || '¤';
  if (/round/i.test(lower)) return testData?.fields?.roundingIncrement || '0.01';
  if (/rate|value|amount|percent/i.test(lower)) {
    return testData?.fields?.value || testData?.fields?.rate || '0.01';
  }
  if (/is_active|isactive|active/i.test(lower)) return true;
  if (/email/i.test(lower)) return `api-${suffix}@example.com`;
  return `${key}-${suffix}`;
}

/** Pull code/name/… from ask text without UI formControls (Backend-only compose). */
export function parseAskApiFields(intent = {}, testData = {}) {
  const text = [
    intent?.rawDescription,
    intent?.rawTitle,
    intent?.summary,
    testData?.verifyText,
  ].filter(Boolean).join('. ');
  const fields = {};
  const codeM = text.match(/\bcode\s*[:=]?\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]{1,40})['"]?/i);
  if (codeM) fields.code = codeM[1].trim();
  const nameM = text.match(/\bname\s*[:=]?\s*['"]?([^'";,\n]+?)['"]?(?=\s*[;,]|\s+use\b|\s+with\b|$)/i);
  if (nameM) fields.name = nameM[1].trim();
  const labelM = text.match(/\b(?:display[_\s-]?label|label)\s*[:=]?\s*['"]?([^'";,\n]+?)['"]?/i);
  if (labelM) fields.display_label = labelM[1].trim();
  const catM = text.match(/\bcategory\s*[:=]?\s*['"]?([A-Za-z0-9_]+)['"]?/i);
  if (catM && !/^first$/i.test(catM[1])) fields.category = catM[1].trim();
  const modeM = text.match(/\bcalculation[_\s-]?mode\s*[:=]?\s*['"]?([A-Za-z0-9_]+)['"]?/i);
  if (modeM && !/^first$/i.test(modeM[1])) fields.calculation_mode = modeM[1].trim();
  const valM = text.match(/\bvalue\s*[:=]?\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/i);
  if (valM) fields.value = valM[1].trim();

  // Keep any non-empty ask/LLM fields (snake + camel)
  for (const [k, v] of Object.entries(testData?.fields || {})) {
    if (v == null || v === '' || v === '__first__') continue;
    const snake = String(k).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (fields[snake] == null) fields[snake] = v;
    if (fields[k] == null) fields[k] = v;
  }
  if (testData?.primaryValue && /code/i.test(String(testData.primaryField || 'code'))) {
    fields.code = fields.code || testData.primaryValue;
  }
  return fields;
}

/**
 * Build API automation from grounded backend/OpenAPI code.
 */
export function buildApiAutomation({ cases, codeContext, matchedFeature, intent }) {
  const text = String(codeContext || '');
  const vocab = extractCodeVocabulary(text);
  let testData = intent?.testData
    || getTestData(intent, intent?.rawTitle, intent?.rawDescription, vocab);
  // Backend-only: form vocab is empty so getTestData often returns empty fields — parse ask text.
  const askFields = parseAskApiFields(intent, testData);
  testData = {
    ...testData,
    fields: { ...askFields, ...(testData?.fields || {}) },
    verifyText: testData?.verifyText || askFields.code || askFields.name || null,
  };
  const action = String(intent?.action || 'create').toLowerCase();
  let endpoints = extractApiEndpoints(text);
  const requiredFields = extractApiRequiredFields(text);
  const suffix = Date.now().toString(36).slice(-5);

  // When Backend layer is on but live chunks omit Route/OpenAPI, still emit HTTP steps.
  // Also fill missing verbs when chunks only captured GET (common with truncated OpenAPI PathItem).
  const fallbackPath = resolveApiCollectionPath(matchedFeature, text);
  if (fallbackPath) {
    const hasGet = endpoints.some((e) => e.method === 'GET' && e.path === fallbackPath);
    const hasPost = endpoints.some((e) => e.method === 'POST' && e.path === fallbackPath);
    if (!hasGet) endpoints.push({ method: 'GET', path: fallbackPath, name: 'list' });
    if (!hasPost) endpoints.push({ method: 'POST', path: fallbackPath, name: 'create' });
    if (!endpoints.some((e) => e.method === 'PUT' && e.path.startsWith(`${fallbackPath}/`))) {
      endpoints.push({ method: 'PUT', path: `${fallbackPath}/{id}`, name: 'update' });
    }
  }

  // Prefer collection root POST (not /exports, /dropdowns, …)
  const collection = (fallbackPath
      && endpoints.find((e) => e.method === 'POST' && e.path === fallbackPath))
    || endpoints.find((e) => e.method === 'POST' && !/\{/.test(e.path) && !/\/(exports|dropdowns|simple)/i.test(e.path))
    || endpoints.find((e) => e.method === 'POST' && !/\{/.test(e.path))
    || endpoints.find((e) => e.method === 'POST')
    || (fallbackPath
      ? endpoints.find((e) => e.method === 'GET' && e.path === fallbackPath)
      : null)
    || endpoints.find((e) => e.method === 'GET' && !/\{/.test(e.path));

  const askKeys = Object.keys(testData?.fields || {}).filter(
    (k) => testData.fields[k] != null && testData.fields[k] !== '',
  );
  const defaults = defaultApiRequiredFields(collection?.path || fallbackPath, text);
  // Union — never drop collection defaults when DB/OpenAPI required[] is incomplete (e.g. missing code)
  let keys = [...new Set([
    ...defaults,
    ...requiredFields,
    ...askKeys.filter((k) => defaults.includes(k) || requiredFields.includes(k) || /^(code|name|display_label|category|calculation_mode|value|is_active)$/i.test(k)),
  ])];
  if (!keys.length) keys = ['name'];

  const body = {};
  for (const f of keys) {
    body[f] = sampleApiFieldValue(f, testData, suffix);
  }
  // Prefer ask values for known aliases (UI camelCase → API snake_case)
  const aliases = {
    code: ['code'],
    name: ['name'],
    display_label: ['display_label', 'displayLabel', 'display-label'],
    calculation_mode: ['calculation_mode', 'calculationMode', 'calculation-mode'],
    is_active: ['is_active', 'isActive'],
    vat_id: ['vat_id', 'vatId', 'vat'],
    category: ['category'],
    value: ['value'],
  };
  for (const [apiKey, alts] of Object.entries(aliases)) {
    for (const a of alts) {
      const v = testData?.fields?.[a] ?? askFields[a];
      if (v != null && v !== '' && v !== '__first__') {
        body[apiKey] = v;
        break;
      }
    }
  }
  if (!body.code && (askFields.code || testData?.verifyText)) {
    body.code = askFields.code || testData.verifyText;
  }
  if (!body.name && askFields.name) body.name = askFields.name;
  if (!body.display_label && body.name) body.display_label = body.name;
  if (/ecotaxes/i.test(collection?.path || '') && body.is_active === undefined) body.is_active = true;
  if (/currencies/i.test(collection?.path || '') && body.isActive === undefined) body.isActive = true;

  // Mirror UI “first option”: leave placeholders; runtime GETs enum/dropdown lists
  const firstResolvers = buildApiFirstResolvers(
    collection?.path || fallbackPath,
    body,
    intent,
    testData,
  );
  for (const r of firstResolvers) {
    body[r.field] = '__first__';
  }

  const steps = [];
  const verifyNeedle = String(
    testData?.verifyText
    || body.code
    || body.name
    || body[keys[0]]
    || '',
  ).trim();

  if (action === 'create' || action === 'update' || !action) {
    const createEp = (fallbackPath
        && endpoints.find((e) => e.method === 'POST' && e.path === fallbackPath))
      || endpoints.find((e) => e.method === 'POST' && !/\{/.test(e.path) && !/\/(exports|dropdowns|simple)/i.test(e.path))
      || endpoints.find((e) => e.method === 'POST' && !/\{/.test(e.path))
      || (collection?.method === 'POST' ? collection : null)
      || (fallbackPath ? { method: 'POST', path: fallbackPath } : null);
    if (createEp && createEp.method === 'POST') {
      steps.push({
        id: 'api-create',
        action: 'http',
        method: 'POST',
        path: createEp.path,
        body,
        resolveFirst: firstResolvers.length ? firstResolvers : undefined,
        expectStatus: [200, 201],
        expectBodyIncludes: verifyNeedle || undefined,
        description: `POST ${createEp.path} — create`,
      });
    }
  }

  if (action === 'list' || action === 'view' || steps.length) {
    const listEp = (fallbackPath
        && endpoints.find((e) => e.method === 'GET' && e.path === fallbackPath))
      || endpoints.find((e) => e.method === 'GET' && !/\{/.test(e.path) && !/\/(exports|dropdowns|simple)/i.test(e.path))
      || endpoints.find((e) => e.method === 'GET' && !/\{/.test(e.path))
      || (collection?.path ? { method: 'GET', path: collection.path.replace(/\/(exports|dropdowns)$/i, '') } : null)
      || (fallbackPath ? { method: 'GET', path: fallbackPath } : null);
    if (listEp) {
      const q = verifyNeedle ? `?search=${encodeURIComponent(verifyNeedle)}` : '';
      steps.push({
        id: 'api-list',
        action: 'http',
        method: 'GET',
        path: `${listEp.path}${q}`,
        expectStatus: [200],
        expectBodyIncludes: verifyNeedle || undefined,
        description: `GET ${listEp.path}${q ? ' (search)' : ''} — verify`,
      });
    }
  }

  if (action === 'update') {
    const code = body.code || testData?.existingRowNeedle || testData?.searchTerm;
    const updateEp = endpoints.find((e) => e.method === 'PUT')
      || (code ? { method: 'PUT', path: `${collection?.path || '/api/currencies'}/${code}` } : null);
    if (updateEp) {
      const path = /\{/.test(updateEp.path) && code
        ? updateEp.path.replace(/\{[^}]+\}/, encodeURIComponent(String(code)))
        : updateEp.path;
      steps.push({
        id: 'api-update',
        action: 'http',
        method: 'PUT',
        path,
        body,
        expectStatus: [200],
        description: `PUT ${path} — update`,
      });
    }
  }

  // Extra cases that name HTTP verbs explicitly
  for (const c of (cases || []).slice(0, 5)) {
    const m = String(c.title || '').match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i);
    if (!m) continue;
    if (steps.some((s) => s.path === m[2] && s.method === m[1].toUpperCase())) continue;
    steps.push({
      id: `api-${steps.length}`,
      action: 'http',
      method: m[1].toUpperCase(),
      path: m[2],
      body: /^(POST|PUT|PATCH)$/i.test(m[1]) ? body : undefined,
      expectStatus: [200, 201, 204],
      description: c.title,
    });
  }

  return {
    kind: 'api',
    engine: 'http',
    action,
    feature: matchedFeature || 'api',
    steps,
    data: { ...testData, fields: body, verifyText: verifyNeedle },
    sourceRefs: (cases || []).flatMap((c) => c.sourceRefs || []).slice(0, 8),
  };
}

/** CapBO table name from feature / Doctrine #[ORM\Table]. */
export function resolveDbTableName(matchedFeature, codeContext = '') {
  const tables = resolveDbTables(matchedFeature, codeContext);
  return tables[0] || null;
}

/** CapBO table names from indexed Doctrine #[ORM\Table] — no feature→table hardcoding. */
export function resolveDbTables(matchedFeature, codeContext = '') {
  const text = String(codeContext || '');
  const found = [];
  const seen = new Set();
  const add = (t) => {
    const k = String(t || '').toLowerCase();
    if (!k || !/^[a-z][a-z0-9_]*$/.test(k) || seen.has(k)) return;
    seen.add(k);
    found.push(k);
  };

  for (const m of text.matchAll(/#\[ORM\\Table\(name:\s*'([a-z0-9_]+)'/gi)) add(m[1]);
  for (const m of text.matchAll(/ORM\\Table\(name:\s*'([a-z0-9_]+)'/gi)) add(m[1]);
  for (const m of text.matchAll(/Table\(name:\s*['"]([a-z0-9_]+)['"]/gi)) add(m[1]);

  if (!found.length) return [];

  const ranked = found
    .map((t) => ({ t, score: scoreDbTableForFeature(t, matchedFeature) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.localeCompare(b.t));

  if (ranked.length) return ranked.map((x) => x.t);
  return found;
}

function scoreDbTableForFeature(table, featureName) {
  const feat = String(featureName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const raw = String(table || '').toLowerCase();
  const compact = raw.replace(/_/g, '');
  if (!feat) return 1;
  if (compact === feat || compact.replace(/s$/, '') === feat.replace(/s$/, '')) return 100;
  const featStem = feat.replace(/s$/, '');
  if (compact.includes(featStem) || featStem.includes(compact.replace(/s$/, ''))) return 50;
  return 0;
}

function camelToSnakeColumn(prop) {
  return String(prop || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

/** Split indexed PHP into per-table Doctrine entity regions (no cross-entity bleed). */
function splitDoctrineEntityChunks(codeContext = '') {
  const text = String(codeContext || '');
  const hits = [];
  const re = /#\[ORM\\Table\(name:\s*'([a-z0-9_]+)'/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ table: m[1].toLowerCase(), index: m.index });
  }
  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    return { table: hit.table, src: text.slice(hit.index, end) };
  });
}

/** Slice PHP source for the Doctrine entity mapped to `table`. */
function extractDoctrineEntitySource(table, codeContext = '') {
  const key = String(table || '').toLowerCase();
  const chunk = splitDoctrineEntityChunks(codeContext).find((c) => c.table === key);
  return chunk?.src || '';
}

/** Parse trait bodies referenced by `use SomeTrait` from the same indexed context. */
function extractUsedTraitSources(entitySrc, codeContext = '') {
  const text = String(codeContext || '');
  const traits = [];
  for (const m of String(entitySrc).matchAll(/use\s+([A-Za-z0-9\\]+Trait)\s*;/g)) {
    const traitName = m[1].split('\\').pop();
    if (!traitName) continue;
    const traitRe = new RegExp(`trait\\s+${traitName}\\b[\\s\\S]*?(?=\\ntrait\\s+|\\nclass\\s+|$)`);
    const block = text.match(traitRe)?.[0];
    if (block) traits.push(block);
  }
  return traits;
}

/** Column names from a Doctrine entity (+ used traits) in indexed PHP — schema checks only. */
function extractColumnsFromDoctrineSource(src) {
  const cols = [];
  const seen = new Set();
  const add = (c) => {
    const k = String(c || '').trim().toLowerCase();
    if (!k || !/^[a-z][a-z0-9_]*$/.test(k) || seen.has(k)) return;
    seen.add(k);
    cols.push(k);
  };

  const text = String(src || '');

  for (const m of text.matchAll(/#\[ORM\\JoinColumn\([^)]*name:\s*'([a-z0-9_]+)'/gi)) {
    add(m[1]);
  }

  for (const m of text.matchAll(/#\[ORM\\Column\([^[\]]*name:\s*'([a-z0-9_]+)'/gi)) {
    add(m[1]);
  }

  for (const m of text.matchAll(/private\s+(?:\?)?[\w\\|]+\s+\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const prop = m[1];
    const before = text.slice(Math.max(0, m.index - 500), m.index);
    if (!/#\[ORM\\(?:Id|Column)\(/i.test(before)) continue;
    if (/#\[ORM\\(?:OneToMany|ManyToMany)\(/i.test(before)) continue;
    if (/Collection\s*;?\s*$/i.test(text.slice(m.index, m.index + 100))) continue;
    if (/^(translations|articleEcotaxes|enterprise|vat|eanCodes|composition)$/i.test(prop)) continue;
    const colAttr = [...before.matchAll(/#\[ORM\\Column\(([^)]*)\)/gi)].pop()?.[1] || '';
    const nameM = colAttr.match(/name:\s*'([a-z0-9_]+)'/i);
    if (nameM) {
      add(nameM[1]);
      continue;
    }
    add(camelToSnakeColumn(prop));
  }

  return cols;
}

/** Column names for a table — parsed from indexed Doctrine entity for that table only. */
export function extractDbSchemaColumns(table, codeContext = '') {
  const entitySrc = extractDoctrineEntitySource(table, codeContext);
  if (!entitySrc) return ['id'];

  const cols = extractColumnsFromDoctrineSource(entitySrc);
  for (const traitSrc of extractUsedTraitSources(entitySrc, codeContext)) {
    for (const c of extractColumnsFromDoctrineSource(traitSrc)) {
      if (!cols.includes(c)) cols.push(c);
    }
  }

  return cols.length ? cols : ['id'];
}

/**
 * Build Database automation — schema + migration checks only.
 * No business-row SELECTs and no data creation.
 */
export function buildDbAutomation({ cases, codeContext, matchedFeature, intent }) {
  const text = String(codeContext || '');
  const action = String(intent?.action || 'exercise').toLowerCase();
  const tables = resolveDbTables(matchedFeature, text);
  if (!tables.length) {
    return {
      kind: 'database',
      engine: 'sql',
      action,
      feature: matchedFeature || 'database',
      steps: [],
      data: {},
    };
  }

  const steps = [];
  const columnsByTable = {};

  for (const table of tables) {
    const columns = extractDbSchemaColumns(table, text);
    columnsByTable[table] = columns;

    steps.push({
      id: `db-table-${table}`,
      action: 'sqlAssert',
      sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
      params: [table],
      expectMinRows: 1,
      expectIncludes: table,
      description: `Table exists — ${table}`,
    });

    steps.push({
      id: `db-columns-${table}`,
      action: 'sqlAssert',
      sql: `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      params: [table],
      expectMinRows: 1,
      expectColumns: columns,
      description: `Columns — ${table}`,
      expectLabel: `${table} columns`,
    });
  }

  steps.push({
    id: 'db-migrations',
    action: 'sqlAssert',
    sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    params: [tables],
    expectMinRows: tables.length,
    description: `Migration — ${tables.length} table(s) present (DDL applied)`,
  });

  return {
    kind: 'database',
    engine: 'sql',
    action,
    feature: matchedFeature || tables[0],
    table: tables[0],
    tables,
    columns: columnsByTable[tables[0]] || [],
    columnsByTable,
    steps,
    data: { table: tables[0], tables, columnsByTable },
    sourceRefs: (cases || []).flatMap((c) => c.sourceRefs || []).slice(0, 8),
  };
}

/** Playwright request-context spec for API runs. */
export function buildRunnableApiSpec(automation, meta = {}) {
  const feature = automation.feature || meta.matchedFeature || 'API';
  const action = automation.action || meta.action || 'create';
  const steps = automation.steps || [];
  const lines = [];
  lines.push('// Auto-generated by Nocta QA — API');
  lines.push('// Requires TARGET_API_URL (or CapBO backend at http://localhost:8000/api)');
  lines.push('// Auth: reuses generated-e2e/.auth/user.json cookie capbo_access_token (run UI Foreground once)');
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("import { capboApiRequest, ensureCapboAccessToken, resolveApiFirstOptions } from '../helpers/capbo-api';");
  lines.push('');
  lines.push(`test.describe(${JSON.stringify(`${feature} · API`)}, () => {`);
  lines.push('  test.setTimeout(60_000);');
  lines.push('');
  lines.push(`  test(${JSON.stringify(`API · ${action} ${feature}`)}, async ({ request }) => {`);
  lines.push('    const token = await ensureCapboAccessToken(request);');
  lines.push("    test.skip(!token, 'No CapBO token — run a UI Foreground test once to cache SSO');");
  lines.push('');

  for (const s of steps) {
    if (s.action !== 'http') continue;
    const title = s.description || `${s.method} ${s.path}`;
    const hasFirst = Array.isArray(s.resolveFirst) && s.resolveFirst.length > 0;
    lines.push(`    await test.step(${JSON.stringify(title)}, async () => {`);
    if (s.body != null && hasFirst) {
      lines.push(`      let body = ${JSON.stringify(s.body)};`);
      lines.push(`      body = await resolveApiFirstOptions(request, body, ${JSON.stringify(s.resolveFirst)}, token);`);
      lines.push('      const res = await capboApiRequest(request, {');
      lines.push(`        method: ${JSON.stringify(s.method || 'GET')},`);
      lines.push(`        path: ${JSON.stringify(s.path)},`);
      lines.push('        body,');
      lines.push('        token,');
      lines.push('      });');
    } else {
      lines.push('      const res = await capboApiRequest(request, {');
      lines.push(`        method: ${JSON.stringify(s.method || 'GET')},`);
      lines.push(`        path: ${JSON.stringify(s.path)},`);
      if (s.body != null) {
        lines.push(`        body: ${JSON.stringify(s.body)},`);
      }
      lines.push('        token,');
      lines.push('      });');
    }
    const statuses = Array.isArray(s.expectStatus) ? s.expectStatus : [200, 201];
    lines.push('      const status = res.status();');
    lines.push('      const raw = await res.text();');
    lines.push(`      expect(${JSON.stringify(statuses)}.includes(status), \`HTTP \${status}: \${raw.slice(0, 300)}\`).toBeTruthy();`);
    if (s.expectBodyIncludes) {
      lines.push(`      expect(raw).toContain(${JSON.stringify(String(s.expectBodyIncludes))});`);
    }
    lines.push('    });');
    lines.push('');
  }

  lines.push('  });');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/** Build runner fill/select steps from prepared testDataEntries when AI plan omits them. */
export function buildFillStepsFromTestDataEntries(entries = [], schema = null) {
  const fieldByKey = new Map((schema?.fields || []).map((f) => [f.key, f]));
  const steps = [];

  for (const entry of entries) {
    const key = entry.key || entry.formControl;
    if (!key) continue;
    const meta = fieldByKey.get(key) || {};
    const testId = entry.testId || meta.testId || null;
    const label = entry.label || meta.label || key;
    const wrapperTag = meta.wrapperTag || null;
    const forceFill = entry.kind === 'fill' || meta.type === 'autocomplete' || entry.componentType === 'autocomplete';
    const isSelect = !forceFill && (
      entry.kind === 'select'
      || entry.value === '__first__'
      || meta.type === 'dropdown'
      || /dropdown|select/i.test(meta.componentType || '')
      || interactionKindForField(meta, entry.value) === 'select'
    );
    let value = entry.value;
    if (isSelect && isInventedDropdownValue(value, key)) {
      value = '__first__';
    }
    const strategies = isSelect
      ? buildSelectStrategies({
        key,
        testId,
        wrapperTag,
        innerTag: meta.innerTag,
        formControl: key,
      })
      : buildFillStrategies({
        key,
        testId,
        formControl: key,
        standalone: meta.standalone,
        binding: meta.binding,
      });
    if (!strategies.length && !testId) continue;

    steps.push({
      id: isSelect ? `select-${key}` : `fill-${key}`,
      action: isSelect ? 'select' : 'fill',
      formControl: key,
      testId,
      label,
      strategies,
      value,
      componentType: meta.componentType,
      standalone: meta.standalone,
      binding: meta.binding,
      description: isSelect
        ? (value && value !== '__first__'
          ? `Select ${label} "${value}"`
          : `Select first option for ${label}`)
        : `Enter ${label}`,
    });
  }

  return steps;
}

/** Row-scoped edit/view/delete — never bare *-edit when multiple rows exist. */
export function ensureRowActionStepStrategies(steps = [], testData = {}, vocab = {}) {
  const needle = normalizeRowNeedle(
    testData?.existingRowNeedle || testData?.searchTerm || testData?.searchNeedle
      || steps.find((s) => s.id === 'fill-search')?.value,
  );
  if (!needle) return steps;
  return steps.map((s) => {
    if (s.action !== 'click') return s;
    let strategies = s.strategies || [];
    if (isRowActionClick(s) || s.id === 'click-edit') {
      strategies = dedupeStrategies([...editButtonStrategies(vocab, needle), ...strategies]);
      return { ...s, id: s.id || 'click-edit', testId: null, strategies };
    }
    if (s.id === 'click-view' || (/click view|view button|eye icon/i.test(s.description || '') && /-view$/i.test(s.testId || ''))) {
      strategies = dedupeStrategies([...viewButtonStrategies(vocab, needle), ...strategies]);
      return { ...s, id: s.id || 'click-view', testId: null, strategies };
    }
    if (s.id === 'click-delete-row') {
      strategies = dedupeStrategies([...deleteButtonStrategies(vocab, needle), ...strategies]);
      return { ...s, testId: null, strategies };
    }
    return s;
  });
}

/** Inject list search before row view/edit when AI plan skipped fill-search. */
function ensureRowSearchStep(steps, testData, vocab) {
  const needle = normalizeRowNeedle(testData?.existingRowNeedle || testData?.searchTerm);
  if (!needle) return steps;
  if (steps.some((s) => s.id === 'fill-search')) return steps;
  const needsRow = steps.some(
    (s) => s.id === 'click-view' || s.id === 'click-edit' || s.id === 'click-delete-row'
      || /view button|click view|eye icon|edit for row|click edit/i.test(s.description || ''),
  );
  if (!needsRow) return steps;
  const searchStep = {
    id: 'fill-search',
    action: 'fill',
    strategies: searchFillStrategies(vocab),
    value: needle,
    description: `Search for "${needle}"`,
  };
  const gotoIdx = steps.findIndex((s) => s.action === 'goto');
  const out = [...steps];
  out.splice(gotoIdx >= 0 ? gotoIdx + 1 : 0, 0, searchStep);
  return out;
}

/** Guarantee executable fill/select steps — merge missing required fields even if AI filled one.
 * Also coerce AI "fill" on dropdown fields → select (schema wins). */
export function ensureAutomationHasFillSteps(automation, {
  codeContext = '',
  uiPlan = null,
  matchedFeature = '',
  intent = null,
} = {}) {
  if (!automation) return automation;

  const action = automation.action || intent?.action || 'create';
  const listOnly = action === 'list' || action === 'delete' || action === 'view';
  const feature = matchedFeature || automation.feature || '';
  const effectiveContext = codeContext || '';

  const entries = automation.data?.testDataEntries || uiPlan?.testDataEntries || [];
  let schema = automation.data?.formSchema || intent?.testData?.formSchema || null;

  // Re-extract from compose context (index + live GitLab bodies — no local FE overlay)
  if (effectiveContext) {
    try {
      const parsed = extractFormSchema(effectiveContext, {
        entityStem: entityStemFromVocab(extractCodeVocabulary(effectiveContext || '')) || '',
      });
      if ((parsed?.fields?.length || 0) >= (schema?.fields?.length || 0)) {
        schema = parsed;
      }
    } catch { /* keep prior schema */ }
  }

  if (schema?.fields?.length) {
    automation = {
      ...automation,
      data: { ...(automation.data || {}), formSchema: schema },
    };
  }
  const fieldByKey = new Map((schema?.fields || []).map((f) => [f.key, f]));

  // Fix misclassified dropdown fills (AI wrote fill category-xxx instead of select)
  let steps = (automation.steps || []).map((s) => {
    if (listOnly && s.action === 'fill' && s.id !== 'fill-search') return null;
    if (s.action !== 'fill' || !s.formControl) return s;
    const meta = fieldByKey.get(s.formControl) || {};
    const tid = s.testId || meta.testId || '';
    const dropdownTid = /-(category|vat|country|type|currency|calculation-mode|enterprise-identifier)$/i.test(tid);
    // Do NOT treat invented "name-xxx" alone as dropdown — that breaks text fields.
    const shouldSelect = interactionKindForField(meta, s.value) === 'select'
      || meta.type === 'dropdown'
      || /dropdown|select/i.test(meta.componentType || '')
      || /dropdown/i.test(s.description || '')
      || dropdownTid;
    if (!shouldSelect) return s;
    const testId = tid || null;
    const invented = isInventedDropdownValue(s.value, s.formControl);
    const value = invented || s.value == null || s.value === '' ? '__first__' : s.value;
    return {
      ...s,
      id: s.id?.replace(/^fill-/, 'select-') || `select-${s.formControl}`,
      action: 'select',
      value,
      testId,
      componentType: meta.componentType || s.componentType,
      strategies: buildSelectStrategies({
        key: s.formControl,
        testId,
        wrapperTag: meta.wrapperTag,
        innerTag: meta.innerTag,
        formControl: s.formControl,
      }),
      description: s.description?.replace(/^Enter |^Fill /i, 'Select ')
        || `Select ${s.formControl} (first option)`,
    };
  }).filter(Boolean);

  const vocab = extractCodeVocabulary(effectiveContext || '');
  steps = ensureRowSearchStep(steps, automation.data || intent?.testData, vocab);
  const rowCtx = {
    ...(automation.data || {}),
    ...(intent?.testData || {}),
    existingRowNeedle: intent?.testData?.existingRowNeedle
      || automation.data?.existingRowNeedle
      || steps.find((s) => s.id === 'fill-search')?.value,
    searchTerm: intent?.testData?.searchTerm || automation.data?.searchTerm,
  };
  steps = ensureRowActionStepStrategies(steps, rowCtx, vocab);
  steps = ensureCreateClickStep(steps, {
    vocab,
    entityStem: entityStemFromVocab(vocab),
    action,
  });

  if (listOnly) {
    steps = steps.filter((s) => s.action !== 'select' && (s.action !== 'fill' || s.id === 'fill-search'));
    return { ...automation, steps: enrichAndOrderFillSteps(steps, fieldByKey) };
  }

  // Enrich AI/partial steps with schema metadata; rebuild broken locators
  steps = steps.map((s) => {
    if (s.action !== 'fill' && s.action !== 'select') return s;
    if (stepNeedsSchemaRebuild(s, fieldByKey)) {
      const rebuilt = buildFillStepsFromTestDataEntries([{
        key: s.formControl,
        label: s.label,
        testId: s.testId,
        kind: s.action,
        value: s.value,
      }], schema);
      return rebuilt[0] || enrichFillSelectStep(s, fieldByKey);
    }
    return enrichFillSelectStep(s, fieldByKey);
  });

  const covered = new Set(
    steps.filter((s) => s.action === 'fill' || s.action === 'select').map((s) => s.formControl).filter(Boolean),
  );

  const missingEntries = [];
  const seenMissing = new Set();
  for (const e of entries || []) {
    if (!e?.key || covered.has(e.key) || seenMissing.has(e.key)) continue;
    seenMissing.add(e.key);
    missingEntries.push(e);
  }
  for (const f of schema?.fields || []) {
    if (action === 'update') break;
    if (!f?.key || !f.required || covered.has(f.key) || seenMissing.has(f.key)) continue;
    if (isFilterFieldKey(f.key, schema.filterKeys || [])) continue;
    if (f.automate === false) continue;
    if (!f.testId || isListChromeTestId(f.testId)) continue;
    if (/^(isActive|active|activeOnly|is_active|searchTerm|search)$/i.test(f.key)) continue;
    const isSelect = f.type === 'dropdown'
      || /dropdown|select/i.test(f.componentType || '')
      || interactionKindForField(f, null) === 'select';
    const kind = isSelect && f.type !== 'autocomplete' ? 'select' : 'fill';
    missingEntries.push({
      key: f.key,
      label: f.label || f.key,
      testId: f.testId || null,
      kind,
      componentType: f.componentType || null,
      value: kind === 'select' ? '__first__' : defaultValueForField(f),
      source: 'schema-required',
    });
    seenMissing.add(f.key);
  }

  if (missingEntries.length) {
    const fillSteps = buildFillStepsFromTestDataEntries(missingEntries, schema);
    if (fillSteps.length) {
      steps = [...steps, ...fillSteps];
    }
  }

  const existingFills = steps.filter((s) => s.action === 'fill' || s.action === 'select');
  if (!existingFills.length && effectiveContext) {
    const codegen = buildUiAutomation({
      uiPlan: uiPlan || { ask: { action: automation.action || 'create' } },
      codeContext: effectiveContext,
      matchedFeature: feature || automation.feature,
      intent: {
        action: automation.action || intent?.action || 'create',
        testData: automation.data,
        ...(intent || {}),
      },
    });
    if (codegen?.steps?.some((s) => s.action === 'fill' || s.action === 'select')) {
      return mergeAutomationWithCodegen({ ...automation, steps }, codegen);
    }
  }

  if (!existingFills.length && entries?.length) {
    const fillSteps = buildFillStepsFromTestDataEntries(entries, schema);
    if (fillSteps.length) {
      const baseSteps = steps.filter((s) => s.action !== 'fill' && s.action !== 'select');
      steps = [...baseSteps, ...fillSteps];
    }
  }

  return {
    ...automation,
    steps: enrichAndOrderFillSteps(steps, fieldByKey),
    data: { ...(automation.data || {}), formSchema: schema },
  };
}

/** Guarantee expectText uses the prepared entity name, not generic "success" from AC/LLM wording.
 * Always collapses to a single post-save verify (LLM often duplicates AC wording as a 2nd expect). */
export function ensureVerifyStep(automation, { testData, resolvedValues, schema, title } = {}) {
  if (!automation?.steps?.length) return automation;
  const action = automation.action || 'create';
  if (action === 'list') {
    const hasSearch = automation.steps.some((s) => s.id === 'fill-search') || testData?.searchTerm;
    return {
      ...automation,
      steps: automation.steps.filter((s) => {
        if (s.action !== 'expectText') return true;
        if (isListMetaPhrase(s.text) || isGenericOutcomePhrase(s.text)) return false;
        return hasSearch;
      }),
    };
  }
  if (action === 'delete') return automation;

  const needle = resolveVerifyNeedle(
    testData || automation.data || {},
    resolvedValues || automation.data?.fields || {},
    schema || automation.data?.formSchema,
  );
  if (!needle) return automation;

  let steps = automation.steps.map((s) => {
    if (s.action !== 'expectText') return s;
    if (!s.text || isGenericOutcomePhrase(s.text)) {
      return {
        ...s,
        text: needle,
        description: `Verify "${needle}" appears in list`,
      };
    }
    // Normalize every verify to the same prepared name (avoid code vs name mismatch)
    const looksLikeName = /name|partner|label|title/i.test(s.description || '')
      || String(s.text) === needle
      || !/^[A-Z]{3}$/.test(String(s.text));
    return looksLikeName
      ? { ...s, text: needle, description: s.description || `Verify "${needle}" appears in list` }
      : s;
  });

  const expects = steps.filter((s) => s.action === 'expectText');
  if (expects.length !== 1) {
    steps = steps.filter((s) => s.action !== 'expectText');
    steps.push({
      id: 'expect-name',
      action: 'expectText',
      text: needle,
      description: `Verify "${needle}" appears in list`,
    });
    steps = normalizeAutomationStepOrder(steps);
  }

  const data = { ...automation.data, verifyText: needle, nameValue: automation.data?.nameValue || needle };
  const next = { ...automation, steps, data };
  next.playwrightSource = buildRunnablePlaywrightSpec(next, { title: title || automation.title });
  return next;
}

/** Compose-level automation bundle. Prefers AI materialized plan when provided. */
export function buildAutomationBundle({
  layers = [],
  uiPlan,
  uiContext,
  apiContext,
  cases,
  matchedFeature,
  intent,
  uiAutomation = null,
}) {
  const wantsUi = !layers.length || layers.includes('ui');
  const wantsApi = layers.includes('backend');
  const wantsDb = layers.includes('database');
  const out = { ui: null, api: null, db: null };

  if (wantsUi && uiPlan) {
    const codegen = buildUiAutomation({
      uiPlan,
      codeContext: uiContext,
      matchedFeature,
      intent,
    });
    if (uiAutomation?.steps?.length) {
      out.ui = mergeAutomationWithCodegen(uiAutomation, codegen);
    } else {
      out.ui = codegen;
    }
    // Delete only: AI plans often stop at Edit — keep parsed intent authoritative without touching create/update/list/view
    const intentAction = intent?.action === 'delete' ? 'delete' : null;
    if (intentAction) {
      out.ui = { ...out.ui, action: intentAction };
    }
    out.ui = ensureDeleteFlowSteps(out.ui, codegen, intentAction);
    out.ui = ensureAutomationHasFillSteps(out.ui, {
      codeContext: uiContext,
      uiPlan,
      matchedFeature,
      intent,
    });
    if (out.ui?.steps?.length) {
      const vocab = extractCodeVocabulary(uiContext || '');
      const rowCtx = {
        ...(out.ui.data || {}),
        ...(intent?.testData || {}),
        existingRowNeedle: intent?.testData?.existingRowNeedle
          || out.ui.data?.existingRowNeedle
          || out.ui.steps.find((s) => s.id === 'fill-search')?.value,
      };
      out.ui = {
        ...out.ui,
        steps: ensureRowActionStepStrategies(
          normalizeAutomationStepOrder(out.ui.steps),
          rowCtx,
          vocab,
        ),
        data: {
          ...(out.ui.data || {}),
          existingRowNeedle: rowCtx.existingRowNeedle,
          searchTerm: rowCtx.searchTerm || rowCtx.existingRowNeedle,
        },
      };
    }
    out.ui = ensureVerifyStep(out.ui, {
      testData: intent?.testData || out.ui?.data,
      resolvedValues: out.ui?.data?.fields,
      schema: out.ui?.data?.formSchema,
      title: uiPlan?.title,
    });

    // Fail closed: every fill/select/create/save must use CapBO code testIds
    if (out.ui?.steps?.length) {
      const vocab = extractCodeVocabulary(uiContext || '');
      const schema = out.ui.data?.formSchema || extractFormSchema(uiContext || '');
      const schemaAudit = auditCodeTestIds({
        schema,
        vocab,
        action: out.ui.action || intent?.action || 'create',
      });
      const stepAudit = auditAutomationTestIds(out.ui);
      if (!schemaAudit.ok || !stepAudit.ok) {
        const err = new Error(formatTestIdAuditError({
          missing: [...(schemaAudit.missing || []), ...(stepAudit.missing || [])],
        }));
        err.code = 'CODE_TESTIDS_REQUIRED';
        err.missing = [...(schemaAudit.missing || []), ...(stepAudit.missing || [])];
        throw err;
      }
      out.ui = {
        ...out.ui,
        createTestId: schemaAudit.createTestId,
        saveTestId: schemaAudit.saveTestId,
      };
    }
  }
  if (wantsApi) {
    out.api = buildApiAutomation({
      cases,
      codeContext: apiContext,
      matchedFeature,
      intent,
    });
  }
  if (wantsDb) {
    out.db = buildDbAutomation({
      cases,
      codeContext: apiContext,
      matchedFeature,
      intent,
    });
  }
  return out;
}
