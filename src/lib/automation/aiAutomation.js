/**
 * AI-authored UI execution plans — validated and materialized from indexed code only.
 * LLM decides flow + user-friendly descriptions; strategies/testIds come from schema.
 */

import { extractCodeVocabulary, entityStemFromVocab, resolveVerifyNeedle } from '../rag/ground.js';
import { buildSelectStrategies, buildFillStrategies, interactionKindForField, isInventedDropdownValue } from '../rag/componentRegistry.js';
import { pickIdentityFieldFromSchema } from '../rag/askAnalyzer.js';
import {
  packageUiAutomationResult,
  extractRouteHints,
  createButtonStrategies,
  saveButtonStrategies,
  editButtonStrategies,
  dedupeStrategies,
  isCreateClickStep,
  isSaveClickStep,
  normalizeAutomationStepOrder,
  ensureRowActionStepStrategies,
  isFirstDropdownIntent,
} from './codegen.js';

const ALLOWED_ACTIONS = new Set(['goto', 'click', 'fill', 'select', 'expectText', 'expectVisible']);

function clickStrategies(testId) {
  if (!testId) return [];
  return [
    { type: 'testid', value: testId },
    { type: 'css', value: `[data-testid="${testId}"]` },
  ];
}

function fieldMetaFromSchema(schema, formControl) {
  return (schema.fields || []).find((f) => f.key === formControl) || null;
}

function resolveTestId(step, fieldMeta, vocab) {
  const tid = step.testId || fieldMeta?.testId || null;
  if (tid && (vocab.testIds || []).includes(tid)) return tid;
  if (fieldMeta?.testId) return fieldMeta.testId;
  if (tid) return null;
  return null;
}

/** Merge AI step order with code-prepared fields — required automatable fields must appear. */
function mergeFieldSteps(aiSteps, preparedFields, schema, vocab) {
  const out = [];
  const seen = new Set();
  const byControl = new Map(preparedFields.map((f) => [f.formControl, f]));

  for (const raw of aiSteps) {
    if (!raw || !ALLOWED_ACTIONS.has(raw.action)) continue;
    if (raw.action === 'fill' || raw.action === 'select') {
      const fc = raw.formControl;
      if (!fc || !byControl.has(fc)) continue;
      seen.add(fc);
      const prep = byControl.get(fc);
      const meta = fieldMetaFromSchema(schema, fc);
      const testId = resolveTestId(raw, meta, vocab) || prep.testId;
      if (!testId && !prep.wrapperTag && !meta?.wrapperTag) continue;
      const value = raw.value != null && raw.value !== '' && !isFirstDropdownIntent(raw.value, raw)
        ? String(raw.value)
        : prep.value;
      out.push({
        id: raw.id || (raw.action === 'select' ? `select-${fc}` : `fill-${fc}`),
        action: raw.action === 'select' || prep.kind === 'select' ? 'select' : 'fill',
        formControl: fc,
        testId,
        value,
        componentType: prep.componentType || meta?.componentType,
        wrapperTag: prep.wrapperTag || meta?.wrapperTag,
        description: raw.description || prep.label || fc,
        meta,
      });
    } else {
      out.push(raw);
    }
  }

  for (const prep of preparedFields) {
    if (seen.has(prep.formControl)) continue;
    const meta = fieldMetaFromSchema(schema, prep.formControl);
    if (!prep.testId && !prep.wrapperTag) continue;
    out.push({
      id: prep.kind === 'select' ? `select-${prep.formControl}` : `fill-${prep.formControl}`,
      action: prep.kind === 'select' ? 'select' : 'fill',
      formControl: prep.formControl,
      testId: prep.testId,
      value: prep.value,
      componentType: prep.componentType,
      description: prep.label || prep.formControl,
      meta: meta || prep,
    });
  }

  return out;
}

function materializeRunnerStep(step, vocab, schema) {
  const action = step.action;
  if (action === 'goto') {
    return {
      id: step.id || 'goto',
      action: 'goto',
      path: step.path || '/',
      description: step.description || `Open ${step.path || '/'}`,
    };
  }
  if (action === 'click') {
    const vocabIds = vocab.testIds || [];
    const createTestId = vocabIds.find((id) => /-(create|add|new)$/i.test(id))
      || vocabIds.find((id) => /create|add|new/i.test(id) && !/form|cancel|back|close|delete/i.test(id));
    const saveTestId = vocabIds.find((id) => /-(save|submit)$/i.test(id))
      || vocabIds.find((id) => /save|submit/i.test(id) && !/form|cancel|back|close|delete/i.test(id));
    const entityStem = createTestId?.replace(/-(create|add|new)$/i, '') || entityStemFromVocab(vocab);

    // AI often invents/misuses *-form as the submit target — never trust that for save/create
    let testId = step.testId && vocabIds.includes(step.testId) ? step.testId : null;
    if (testId && /-(form|cancel|back|close|delete)$/i.test(testId)) testId = null;

    if (isCreateClickStep(step)) testId = createTestId || testId || null;
    if (isSaveClickStep(step)) testId = saveTestId || testId || null;

    const isEditClick = step.id === 'click-edit'
      || (/edit for row|click edit|edit button/i.test(step.description || '') && /-edit$/i.test(step.testId || ''));
    const rowNeedle = step.rowNeedle || null;

    const strategies = dedupeStrategies([
      ...(isEditClick && rowNeedle ? editButtonStrategies(vocab, rowNeedle) : []),
      ...clickStrategies(isEditClick && rowNeedle ? null : testId),
      ...(isCreateClickStep(step) ? createButtonStrategies(vocab, entityStem) : []),
      ...(isSaveClickStep(step) ? saveButtonStrategies(vocab, entityStem) : []),
      ...(step.strategies || []).filter((s) => !/-(form|cancel|back|close)$/i.test(String(s.value || ''))),
    ]);

    return {
      id: step.id || (isCreateClickStep(step) ? 'click-create' : isSaveClickStep(step) ? 'click-save' : (isEditClick ? 'click-edit' : 'click')),
      action: 'click',
      testId: isEditClick && rowNeedle ? null : testId,
      strategies,
      description: step.description || 'Click control',
    };
  }
  if (action === 'fill' || action === 'select') {
    const meta = step.meta || fieldMetaFromSchema(schema, step.formControl) || {};
    // Schema testId wins over AI guesses (keeps eco-tax/partners/VAT etc. module-correct)
    const testId = meta.testId || resolveTestId(step, meta, vocab) || step.testId || null;
    const kind = interactionKindForField(meta, step.value);
    // Schema wins: dropdown/custom-dropdown must be select even if AI said "fill"
    let actionOut = kind === 'select' ? 'select' : (step.action === 'select' ? 'select' : 'fill');
    if (meta.type === 'dropdown' || /dropdown|select/i.test(meta.componentType || '')) {
      actionOut = 'select';
    }
    let value = step.value;
    if (actionOut === 'select' && isInventedDropdownValue(value, step.formControl)) {
      value = '__first__';
    }
    const strategies = actionOut === 'select'
      ? buildSelectStrategies({
        key: step.formControl,
        testId,
        wrapperTag: meta.wrapperTag || step.wrapperTag,
        innerTag: meta.innerTag,
      })
      : buildFillStrategies({
        key: step.formControl,
        testId,
        standalone: meta.standalone,
        binding: meta.binding,
      });
    if (!strategies.length) return null;
    return {
      id: step.id || (actionOut === 'select' ? `select-${step.formControl}` : `fill-${step.formControl}`),
      action: actionOut,
      formControl: step.formControl,
      testId,
      strategies,
      value,
      componentType: step.componentType || meta.componentType,
      description: step.description,
    };
  }
  if (action === 'expectText') {
    return {
      id: step.id || 'expect-text',
      action: 'expectText',
      text: step.text || step.value || '',
      description: step.description || `Verify "${step.text || step.value}"`,
    };
  }
  if (action === 'expectVisible') {
    const desc = String(step.description || '');
    const formScoped = /toggle|form|field|input|dropdown|save|submit|partner-form|details/i.test(desc);
    return {
      id: step.id || 'expect-visible',
      action: 'expectVisible',
      strategies: step.strategies?.length
        ? step.strategies
        : formScoped
          ? [
            { type: 'css', value: '[data-testid$="-form"], form[data-testid], mat-slide-toggle, input[formcontrolname]' },
          ]
          : [{ type: 'css', value: 'table, .mat-table, [role="table"], .list-container' }],
      description: step.description || 'Verify element visible',
    };
  }
  return null;
}

/**
 * Validate AI execution plan and build runner-ready automation (same shape as buildUiAutomation).
 * Returns null when the plan cannot be grounded in indexed code.
 */
export function buildUiAutomationFromAiPlan({
  aiPlan,
  codeContext,
  matchedFeature,
  intent,
  uiPlan,
  prepared,
}) {
  if (!aiPlan?.steps?.length || !prepared?.schema) return null;

  const vocab = extractCodeVocabulary(codeContext || '');
  const schema = prepared.schema;
  const testData = prepared.testData;
  const action = aiPlan.action || intent?.action || 'create';
  const feature = matchedFeature || uiPlan?.ask?.matchedFeature || 'feature';
  let route = aiPlan.route || extractRouteHints(codeContext, feature) || '/';
  // CapBO create must start on list — deep-link /details makes save → history.back() leave the module
  if (/^(create|exercise)$/i.test(action) && /\/details/i.test(route)) {
    route = route.replace(/\/details.*$/i, '') || route;
  }

  const allowedRoutes = new Set([
    ...(vocab.routes || []).map((r) => (r.startsWith('/') ? r : `/${r}`)),
    route,
  ]);

  if (aiPlan.route && !allowedRoutes.has(route) && !allowedRoutes.has(route.replace(/^\//, ''))) {
    const routeSeg = route.replace(/^\//, '').split('/')[0];
    const ok = (vocab.routes || []).some((r) => r.includes(routeSeg));
    if (!ok && route !== '/') return null;
  }

  const merged = mergeFieldSteps(aiPlan.steps, prepared.automationFields || [], schema, vocab);
  const runnerSteps = [];

  for (const raw of merged) {
    if (raw.action === 'fill' || raw.action === 'select') {
      const mat = materializeRunnerStep(raw, vocab, schema);
      if (mat) runnerSteps.push(mat);
      continue;
    }
    const rowNeedle = testData?.existingRowNeedle || testData?.searchTerm || null;
    const withRow = (raw.action === 'click' && rowNeedle) ? { ...raw, rowNeedle } : raw;
    const mat = materializeRunnerStep(withRow, vocab, schema);
    if (mat) {
      if (mat.action === 'goto' && /^(create|exercise)$/i.test(action) && /\/details/i.test(mat.path || '')) {
        mat.path = String(mat.path).replace(/\/details.*$/i, '') || mat.path;
      }
      runnerSteps.push(mat);
    }
  }

  if (!runnerSteps.some((s) => s.action === 'goto')) {
    runnerSteps.unshift({
      id: 'goto',
      action: 'goto',
      path: route,
      description: `Open ${feature} at ${route}`,
    });
  }

  const orderedSteps = ensureRowActionStepStrategies(
    normalizeAutomationStepOrder(runnerSteps),
    testData,
    vocab,
  );

  if (!orderedSteps.length) return null;

  const identity = pickIdentityFieldFromSchema(schema);
  const formControl = testData.primaryField || identity?.key;
  const nameValue = testData.primaryValue;
  const verifyText = resolveVerifyNeedle(testData, prepared.resolvedValues, schema) || nameValue;
  const createTestId = (vocab.testIds || []).find((id) => /create|add|new/i.test(id));
  const saveTestId = (vocab.testIds || []).find((id) => /save|submit/i.test(id));
  const nameTestId = identity?.testId
    || (vocab.testIds || []).find((id) => /-name$/i.test(id) && !/search/i.test(id));
  const createPerm = vocab.permissions.find((p) => /CREATE|ADD|NEW/i.test(p));

  return packageUiAutomationResult({
    uiPlan,
    feature,
    action,
    route,
    steps: orderedSteps,
    testData,
    formControl,
    nameValue,
    verifyText,
    vocab,
    createTestId,
    saveTestId,
    nameTestId,
    createPerm,
    resolvedValues: prepared.resolvedValues,
    formFields: prepared.automationFields || [],
    source: 'ai',
  });
}

export function validateAiExecutionPlan(aiPlan, { vocab, prepared }) {
  const issues = [];
  if (!aiPlan?.steps?.length) issues.push('no steps');
  const allowedIds = new Set(vocab?.testIds || []);
  const filterKeys = new Set(prepared?.schema?.filterKeys || []);
  const listFilterControls = new Set(['searchTerm', 'search', 'query', 'filter']);
  for (const s of aiPlan?.steps || []) {
    if (s.testId && !allowedIds.has(s.testId)) {
      issues.push(`unknown testId: ${s.testId}`);
    }
    if ((s.action === 'fill' || s.action === 'select') && s.formControl) {
      if (s.id === 'fill-search' || filterKeys.has(s.formControl) || listFilterControls.has(s.formControl)) {
        continue;
      }
      const ok = (prepared?.automationFields || []).some((f) => f.formControl === s.formControl);
      if (!ok) issues.push(`unknown formControl: ${s.formControl}`);
    }
  }
  return { ok: !issues.length, issues };
}
