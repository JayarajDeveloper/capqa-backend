/**
 * Unified test-case preparation for ALL CapBO modules (partners, VAT, currency, eco-tax, retail-chain, …).
 * One code path: indexed UI → schema → description parse → defaults → manual steps + automation fields.
 */

import {
  extractFormSchema,
  buildFormAutomationFields,
  buildFormFillStepLines,
  resolveFormFieldValuesWithSources,
} from './formSchema.js';
import {
  entityStemFromVocab,
  extractCodeVocabulary,
  getTestData,
  resolveVerifyNeedle,
} from './ground.js';
import { pickIdentityFieldFromSchema } from './askAnalyzer.js';
import { extractModuleCapabilities } from './codeSignals.js';

/** Merge indexed formControls + schema fields so NLP and defaults work for any module. */
export function enrichVocabFromSchema(vocab = {}, schema = {}) {
  return {
    ...vocab,
    formControls: [...new Set([
      ...(vocab.formControls || []),
      ...(schema.fields || []).map((f) => f.key),
    ])],
    schemaFields: schema.fields || [],
    filterKeys: schema.filterKeys || [],
  };
}

/**
 * Single entry: read code + user ask → prepared test data, entries, automation fields, manual fill lines.
 * Used by compose (LLM plan), codegen (Playwright), and resolveTestDataFromAsk.
 */
export function prepareModuleTestCase({
  codeContext = '',
  title = '',
  description = '',
  matchedFeature = '',
  intent = null,
  vocab = null,
  action = null,
} = {}) {
  const v = vocab || extractCodeVocabulary(codeContext);
  const entityStem = entityStemFromVocab(v);
  const schema = extractFormSchema(codeContext, { entityStem });
  const capabilities = extractModuleCapabilities(codeContext);
  const enrichedVocab = enrichVocabFromSchema(v, schema);
  const act = action || intent?.action || 'create';
  const featurePrefix = String(matchedFeature || intent?.matchedFeature || entityStem || 'Auto').split(/\s+/)[0];

  let testData = getTestData(intent, intent?.rawTitle ?? title, intent?.rawDescription ?? description, {
    ...enrichedVocab,
    matchedFeature: matchedFeature || intent?.matchedFeature || '',
  });

  const explicitFields = { ...(testData.fields || {}) };
  if (testData.primaryValue && testData.primaryField && explicitFields[testData.primaryField] == null) {
    explicitFields[testData.primaryField] = testData.primaryValue;
  }

  const ctx = { action: act, featurePrefix };
  let values = { ...explicitFields };
  let entries = [];

  if (act === 'create' || act === 'exercise' || act === 'update') {
    ({ values, entries } = resolveFormFieldValuesWithSources(schema, { ...testData, fields: explicitFields }, ctx));
  }

  const identity = pickIdentityFieldFromSchema(schema);
  const verifyText = resolveVerifyNeedle({ ...testData, formSchema: schema, action: act }, values, schema);
  const searchNeedle = (act === 'update' || act === 'delete' || act === 'view')
    ? (testData.existingRowNeedle || testData.searchTerm || null)
    : verifyText;

  testData = {
    ...testData,
    fields: values,
    testDataEntries: entries,
    formSchema: schema,
    primaryField: testData.primaryField || identity?.key || null,
    primaryValue: testData.primaryValue || (identity ? values[identity.key] : null) || null,
    verifyText,
    searchNeedle,
  };

  const automationFields = buildFormAutomationFields(schema, values, entityStem);
  const { lines: manualFillLines } = buildFormFillStepLines(schema, testData, ctx);

  return {
    schema,
    testData,
    testDataEntries: entries,
    resolvedValues: values,
    automationFields,
    manualFillLines,
    entityStem,
    enrichedVocab,
    action: act,
    featurePrefix,
    capabilities,
  };
}

/**
 * Short acceptance criteria — a few outcomes, not one AC per form field.
 * Dropdowns: first option unless the user named a value (shown in requirement).
 */
export function buildAcceptanceCriteriaFromSteps({
  steps = [],
  testData = {},
  testDataEntries = [],
  uiFacts = {},
  feature = 'feature',
  action = 'create',
  sourceRefs = [],
} = {}) {
  const ac = [];
  let n = 1;
  const stepBlob = steps.map((s) => String(s).replace(/^\d+\.\s*/, '')).join(' ').toLowerCase();
  const refs = sourceRefs.filter(Boolean);
  const proofPath = (pattern) => refs.find((r) => pattern.test(r)) || refs[0] || 'Indexed UI source';
  const verifyVal = testData.verifyText || testData.primaryValue;

  const namedSelects = (testDataEntries || []).filter(
    (e) => e?.kind === 'select' && e.value && e.value !== '__first__',
  );
  const firstSelects = (testDataEntries || []).filter(
    (e) => e?.kind === 'select' && (!e.value || e.value === '__first__'),
  );

  if (/navigate/i.test(stepBlob) || action === 'list' || action === 'create' || action === 'update') {
    ac.push({
      id: `AC${n++}`,
      requirement: `${feature} screen opens and the flow can start.`,
      proof: uiFacts.listComp || proofPath(/list|pages|features/i),
    });
  }

  if (/enter |select |fill |form to open/i.test(stepBlob) || (testDataEntries || []).length) {
    const parts = [];
    if (namedSelects.length) {
      parts.push(namedSelects.map((e) => `${e.label || e.key}="${e.value}"`).join(', '));
    }
    if (firstSelects.length) {
      parts.push(`${firstSelects.length} dropdown(s) use the first option`);
    }
    const fills = (testDataEntries || []).filter((e) => e?.kind !== 'select');
    if (fills.length) {
      parts.push(`${fills.length} field(s) filled with prepared values`);
    }
    ac.push({
      id: `AC${n++}`,
      requirement: parts.length
        ? `Required form data is entered (${parts.join('; ')}).`
        : 'Required form fields are completed.',
      proof: uiFacts.formComp
        ? `Form: ${uiFacts.formComp}`
        : `formControls: ${(uiFacts.formControls || []).slice(0, 6).join(', ') || 'indexed HTML'}`,
    });
  }

  if (/save|submit/i.test(stepBlob)) {
    ac.push({
      id: `AC${n++}`,
      requirement: 'Form saves successfully with the prepared data.',
      proof: uiFacts.formComp ? `Save on ${uiFacts.formComp}` : proofPath(/detail|form|component/i),
    });
  }

  if (/verify/i.test(stepBlob) || verifyVal) {
    ac.push({
      id: `AC${n++}`,
      requirement: verifyVal
        ? `"${verifyVal}" appears in the list after save.`
        : 'The new or updated record appears after save.',
      proof: uiFacts.hasMatTable ? 'mat-table / list' : proofPath(/list/i),
    });
  }

  if (action === 'delete' && /delete|remove/i.test(stepBlob)) {
    ac.push({
      id: `AC${n++}`,
      requirement: `The ${feature} record can be deleted.`,
      proof: uiFacts.deleteClick ? `Delete handler ${uiFacts.deleteClick}()` : proofPath(/list|detail/i),
    });
  }

  if (!ac.length) {
    ac.push({
      id: 'AC1',
      requirement: `The ${feature} flow completes successfully.`,
      proof: refs.slice(0, 2).join(', ') || 'Indexed UI sources',
    });
  }

  return ac;
}
