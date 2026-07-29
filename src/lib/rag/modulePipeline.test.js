/**
 * Common pipeline smoke tests for CapBO modules (VAT, eco-tax, partners, currency, retail-chain, articles).
 * Uses real capbo-frontend list + form templates — no module config files.
 *
 * Run: node --test src/lib/rag/modulePipeline.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareModuleTestCase } from './testCasePipeline.js';
import { mergePreparedFormSteps } from '../llm.js';
import { buildUiAutomation, buildRunnablePlaywrightSpec, extractRouteHints } from '../automation/codegen.js';
import { formatChunksForPrompt } from './retrieve.js';
import {
  hasFeatureDetailChunk,
  isDetailChunkPath,
  pathInFeatureFolder,
  primaryFeatureFolder,
  extractListRowTestIds,
} from './codeSignals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.resolve(__dirname, '../../../../capbo-frontend/src/app/pages');

function readPageFile(relPath) {
  const full = path.join(FE_ROOT, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing fixture: ${full}`);
  }
  return fs.readFileSync(full, 'utf8');
}

function chunk(pathRel, content) {
  const lines = content.split('\n').length;
  return {
    path: `src/app/pages/${pathRel}`,
    content,
    startLine: 1,
    endLine: lines,
  };
}

/** Build compose-style context from list + form files (same shape as index + live GitLab). */
function buildModuleContext({
  listHtml,
  listPath,
  formHtml,
  formPath,
  extraForms = [],
  formTs = null,
  formTsPath = null,
  extraTs = [],
}) {
  const chunks = [
    chunk(listPath, listHtml),
    chunk(formPath, formHtml),
  ];
  for (const ef of extraForms) {
    chunks.push(chunk(ef.path, ef.content));
  }
  if (formTs && formTsPath) {
    chunks.push(chunk(formTsPath, formTs));
  }
  for (const et of extraTs) {
    chunks.push(chunk(et.path, et.content));
  }
  return {
    chunks,
    codeContext: formatChunksForPrompt(chunks),
  };
}

const MODULES = [
  {
    id: 'vat',
    feature: 'Vat',
    folder: 'vat',
    ask: { title: 'create a VAT', description: 'create a VAT' },
    listPath: 'vat/vat/vat-list/vat-list.component.html',
    formPath: 'vat/vat/vat/vat.component.html',
    formTsPath: 'vat/vat/vat/vat.component.ts',
    minFields: 3,
    requiredKeys: ['name', 'rate', 'country'],
    createTestId: 'vat-create',
    saveTestId: 'vat-save',
    routeMustNotMatch: /\/details/,
    verifyFieldKey: 'name',
  },
  {
    id: 'eco-tax',
    feature: 'Eco Tax',
    folder: 'eco-tax',
    ask: { title: 'create a eco taxes', description: 'create a eco taxes' },
    listPath: 'eco-tax/eco-tax-list/eco-tax-list.component.html',
    formPath: 'eco-tax/eco-tax-details/eco-tax-details.component.html',
    formTsPath: 'eco-tax/eco-tax-details/eco-tax-details.component.ts',
    minFields: 5,
    requiredKeys: ['code', 'name', 'category', 'calculation_mode', 'vat_id'],
    createTestId: 'eco-tax-create',
    saveTestId: 'eco-tax-save',
    routeMustNotMatch: /\/details/,
    verifyFieldKey: 'code',
  },
  {
    id: 'partner',
    feature: 'Partners',
    folder: 'partners',
    ask: { title: 'create a partner', description: 'create a partner Acme Test' },
    listPath: 'partners/partner-list/partner-list.component.html',
    formPath: 'partners/partner/partner.component.html',
    formTsPath: 'partners/partner/partner.component.ts',
    minFields: 5,
    requiredKeys: ['code', 'name', 'partnerType', 'enterpriseIdentifierType', 'currency'],
    createTestId: 'partner-create',
    saveTestId: 'partner-save',
    routeMustNotMatch: /\/details/,
    verifyFieldKey: 'name',
  },
  {
    id: 'currency',
    feature: 'Currencies',
    folder: 'currencies',
    ask: { title: 'create a currency', description: 'create a currency' },
    listPath: 'currencies/currency-list/currency-list.component.html',
    formPath: 'currencies/currency/currency.component.html',
    formTsPath: 'currencies/currency/currency.component.ts',
    minFields: 3,
    requiredKeys: ['code', 'numericCode', 'name', 'symbol', 'roundingIncrement'],
    createTestId: 'currency-create',
    saveTestId: 'currency-save',
    routeMustNotMatch: /\/details/,
    expectedRoute: '/currency',
    expectedValues: {
      code: /^[A-Z]{3}$/,
      numericCode: /^[0-9]{3}$/,
      roundingIncrement: /^0\.01$|^0,01$/,
    },
    verifyFieldKey: 'code',
  },
  {
    id: 'retail-chain',
    feature: 'Retail Chain',
    folder: 'retail_chain',
    ask: { title: 'create a retail chain', description: 'create retail chain Jay 123' },
    listPath: 'retail_chain/retail-chain-list/retail-chain-list.component.html',
    formPath: 'retail_chain/retail-chain/retail-chain.component.html',
    formTsPath: 'retail_chain/retail-chain/retail-chain.component.ts',
    minFields: 1,
    requiredKeys: ['name'],
    createTestId: 'retail-chain-create',
    saveTestId: 'retail-chain-save',
    routeMustNotMatch: /\/details/,
    verifyFieldKey: 'name',
    updateRowNeedle: 'Jay 123',
    updateTitle: 'update retail chain Jay 123',
  },
  {
    id: 'articles',
    feature: 'Articles',
    folder: 'articles',
    ask: { title: 'create an article', description: 'create an article QA Test' },
    listPath: 'articles/article-list/article-list.component.html',
    formPath: 'articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.html',
    extraFormPaths: ['articles/article-detail/article-detail.component.html'],
    formTsPath: 'articles/article-detail/article-detail-host.service.ts',
    extraTsPaths: ['articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.ts'],
    minFields: 5,
    requiredKeys: ['shortDesignation', 'longDesignation', 'level1', 'price', 'vatId', 'sales_unit'],
    createTestId: 'article-create',
    saveTestId: 'article-save',
    routeMustNotMatch: /\/details/,
    expectedRoute: '/articles',
    verifyFieldKey: 'shortDesignation',
    updateRowNeedle: 'QA Test',
    updateTitle: 'update article QA Test',
  },
];

function assertNoGenericSteps(steps) {
  const blob = steps.join(' ').toLowerCase();
  assert.ok(!/fill in all required form fields/.test(blob), 'steps must not be generic fill');
  assert.ok(!/valid data/.test(blob) || /Enter "/.test(blob), 'steps should use concrete values');
}

for (const mod of MODULES) {
  const listHtml = readPageFile(mod.listPath);
  const formHtml = readPageFile(mod.formPath);
  const extraForms = (mod.extraFormPaths || []).map((p) => ({
    path: p,
    content: readPageFile(p),
  }));
  let formTs = null;
  try {
    if (mod.formTsPath) formTs = readPageFile(mod.formTsPath);
    for (const p of mod.extraTsPaths || []) {
      formTs = `${formTs || ''}\n${readPageFile(p)}`;
    }
  } catch {
    /* TS optional for schema — HTML + testIds often enough */
  }

  const { chunks, codeContext } = buildModuleContext({
    listHtml,
    listPath: mod.listPath,
    formHtml,
    formPath: mod.formPath,
    extraForms,
    formTs,
    formTsPath: mod.formTsPath,
  });

  assert.ok(hasFeatureDetailChunk(chunks, mod.feature), `${mod.id}: has feature detail chunk`);

  const folderFromChunks = primaryFeatureFolder(chunks, mod.feature);
  assert.ok(folderFromChunks, `${mod.id}: resolved folder ${folderFromChunks}`);
  assert.ok(pathInFeatureFolder(chunks[1].path, folderFromChunks),
    `${mod.id}: form path under pages/${folderFromChunks}/`);

  const route = extractRouteHints(codeContext, mod.feature);
  assert.ok(route.startsWith('/'), `${mod.id}: route ${route}`);
  if (mod.routeMustNotMatch) {
    assert.ok(!mod.routeMustNotMatch.test(route), `${mod.id}: list route preferred over details (${route})`);
  }

  const prepared = prepareModuleTestCase({
    codeContext,
    title: mod.ask.title,
    description: mod.ask.description,
    matchedFeature: mod.feature,
    intent: { action: 'create', ...mod.ask, subjectTerms: mod.id.split('-') },
  });

  assert.ok(prepared.schema.fields.length >= mod.minFields,
    `${mod.id}: schema fields (${prepared.schema.fields.length}) >= ${mod.minFields}`);
  for (const key of mod.requiredKeys) {
    assert.ok(prepared.schema.fields.some((f) => f.key === key),
      `${mod.id}: schema has field ${key}`);
  }
  assert.ok(prepared.manualFillLines.length >= mod.requiredKeys.length,
    `${mod.id}: manual fill lines (${prepared.manualFillLines.length})`);
  assert.ok(prepared.automationFields.length >= 1,
    `${mod.id}: automation fields (${prepared.automationFields.length})`);
  assert.ok(prepared.testDataEntries.length >= 1,
    `${mod.id}: test data entries`);

  if (mod.verifyFieldKey) {
    const terms = prepared.schema.listSearch?.searchableTerms || [];
    assert.ok(terms.length >= 1, `${mod.id}: list search terms from placeholder (${terms.join(', ')})`);
    const verifyVal = prepared.testData.verifyText;
    const fieldVal = prepared.resolvedValues[mod.verifyFieldKey];
    assert.equal(verifyVal, fieldVal, `${mod.id}: verifyText uses list-search field ${mod.verifyFieldKey}`);
  }

  if (mod.expectedValues) {
    for (const [key, pattern] of Object.entries(mod.expectedValues)) {
      const val = prepared.resolvedValues[key];
      assert.ok(val != null, `${mod.id}: has value for ${key}`);
      assert.ok(pattern.test(String(val)), `${mod.id}: ${key}=${val} matches business rule ${pattern}`);
    }
  }

  const codeField = prepared.schema.fields.find((f) => f.key === 'numericCode' || f.key === 'code');
  if (mod.id === 'currency' && codeField) {
    assert.ok((codeField.businessRules || []).length > 0, `${mod.id}: business rules on fields`);
  }

  const genericPlan = {
    steps: [
      '1. Navigate to the list.',
      '2. Click Add / Create.',
      '3. Fill in all required form fields with valid data.',
      '4. Identify and click the Save or Submit button.',
    ],
  };
  const merged = mergePreparedFormSteps(genericPlan, prepared);
  assertNoGenericSteps(merged.steps);
  assert.ok(merged.schemaLearned, `${mod.id}: schemaLearned flag`);
  assert.ok(merged.steps.some((s) => /Enter|Select/i.test(s)), `${mod.id}: concrete fill/select steps`);

  const auto = buildUiAutomation({
    uiPlan: { ask: { action: 'create' } },
    codeContext,
    matchedFeature: mod.feature,
    intent: { action: 'create', ...mod.ask },
  });

  const fills = auto.steps.filter((s) => s.action === 'fill' || s.action === 'select');
  assert.ok(fills.length >= 1, `${mod.id}: playwright fill/select steps (${fills.length})`);
  assert.ok(!fills.some((s) => s.formControl === 'conversionCurrency'),
    `${mod.id}: create must not fill conversionCurrency FormArray`);

  if (mod.id === 'currency') {
    assert.equal(auto.route, '/currency', 'currency list route is /currency (not /currencies)');
    const codeFill = fills.find((s) => s.formControl === 'code');
    assert.ok(codeFill, 'currency: has code fill');
    assert.ok(codeFill.strategies?.some((s) => s.value === 'currency-code'),
      'currency: code uses currency-code testId');
    assert.ok(!prepared.schema.fields.some((f) => f.key === 'conversionCurrency' && f.testId === 'currency-code'),
      'currency: currency-code not mapped to conversionCurrency');
    const fillOrder = fills.map((s) => s.formControl);
    const codeIdx = fillOrder.indexOf('code');
    const numIdx = fillOrder.indexOf('numericCode');
    assert.ok(codeIdx >= 0 && numIdx >= 0 && codeIdx < numIdx,
      `currency: code fills before numericCode (${fillOrder.join(', ')})`);
  }

  if (mod.expectedRoute) {
    assert.equal(auto.route, mod.expectedRoute, `${mod.id}: route ${auto.route}`);
  }

  const save = auto.steps.find((s) => s.id === 'click-save');
  assert.ok(save, `${mod.id}: click-save step`);
  const saveTid = save.strategies.find((s) => s.type === 'testid');
  assert.equal(saveTid?.value, mod.saveTestId, `${mod.id}: save testId`);

  const create = auto.steps.find((s) => s.id === 'click-create');
  assert.ok(create?.strategies.some((s) => s.value === mod.createTestId),
    `${mod.id}: create testId ${mod.createTestId}`);

  // --- Update flow (generic: search → row-scoped edit → only user fields — all modules) ---
  const listIds = extractListRowTestIds(listHtml);
  assert.ok(listIds.editTestId, `${mod.id}: list has *-edit testId (${listIds.editTestId})`);
  assert.ok(listIds.searchTestId, `${mod.id}: list has search testId (${listIds.searchTestId})`);

  const rowNeedle = mod.updateRowNeedle || 'ROW-NEEDLE-99';
  const updateTitle = mod.updateTitle || `update ${mod.feature} ${rowNeedle}`;
  const updateDesc = mod.updateDescription || 'change name to Updated QA Test';

  const updatePrepared = prepareModuleTestCase({
    codeContext,
    title: updateTitle,
    description: updateDesc,
    matchedFeature: mod.feature,
    intent: {
      action: 'update',
      rawTitle: updateTitle,
      rawDescription: updateDesc,
      subjectTerms: mod.id.split('-'),
    },
  });

  assert.equal(updatePrepared.testData.existingRowNeedle, rowNeedle,
    `${mod.id} update: parsed row needle`);
  assert.ok(updatePrepared.testDataEntries.every((e) => e.source === 'description'),
    `${mod.id} update: only user-named fields, no code defaults`);
  assert.ok(!updatePrepared.testDataEntries.some((e) => e.key === 'code' && mod.id !== 'currency'),
    `${mod.id} update: must not auto-fill code`);

  const updateAuto = buildUiAutomation({
    uiPlan: { ask: { action: 'update' } },
    codeContext,
    matchedFeature: mod.feature,
    intent: {
      action: 'update',
      testData: updatePrepared.testData,
      rawTitle: updateTitle,
      rawDescription: updateDesc,
    },
  });

  const searchStep = updateAuto.steps.find((s) => s.id === 'fill-search');
  const editStep = updateAuto.steps.find((s) => s.id === 'click-edit');
  assert.ok(searchStep, `${mod.id} update: fill-search step`);
  assert.ok(editStep, `${mod.id} update: click-edit step`);
  assert.ok(
    updateAuto.steps.indexOf(searchStep) < updateAuto.steps.indexOf(editStep),
    `${mod.id} update: search before edit`,
  );
  assert.ok(
    editStep.strategies?.some((s) => s.type === 'css' && /has-text|tbody tr/i.test(s.value || '')),
    `${mod.id} update: edit strategies row-scoped`,
  );

  const updateSpec = buildRunnablePlaywrightSpec({
    ...updateAuto,
    data: {
      ...updateAuto.data,
      existingRowNeedle: rowNeedle,
      searchTerm: rowNeedle,
    },
  });
  assert.ok(
    !new RegExp(`getByTestId\\("${listIds.editTestId}"\\)`).test(updateSpec),
    `${mod.id} update spec: no bare ${listIds.editTestId}`,
  );
  assert.ok(
    /has-text|hasText/.test(updateSpec),
    `${mod.id} update spec: row-scoped edit locator`,
  );
  assert.ok(
    updateSpec.includes('searchNeedle'),
    `${mod.id} update spec: verify searches by row identity`,
  );
  const stepTitles = [...updateSpec.matchAll(/test\.step\(([^,]+)/g)].map((m) => m[1]);
  const searchIdx = stepTitles.findIndex((t) => /search/i.test(t));
  const editIdx = stepTitles.findIndex((t) => /edit/i.test(t));
  assert.ok(searchIdx >= 0 && editIdx > searchIdx,
    `${mod.id} update spec: search step before edit step`);
}

// List-only context must NOT produce field steps (regression guard)
{
  const listOnly = buildModuleContext({
    listHtml: readPageFile('eco-tax/eco-tax-list/eco-tax-list.component.html'),
    listPath: 'eco-tax/eco-tax-list/eco-tax-list.component.html',
    formHtml: '',
    formPath: 'eco-tax/eco-tax-list/eco-tax-list.component.scss',
  });
  listOnly.chunks[1].content = '/* scss only */';
  listOnly.codeContext = formatChunksForPrompt(listOnly.chunks.filter((c) => c.content.includes('eco-tax-create')));
  const weak = prepareModuleTestCase({
    codeContext: listOnly.codeContext,
    title: 'create eco tax',
    matchedFeature: 'Eco Tax',
    intent: { action: 'create' },
  });
  assert.ok(weak.manualFillLines.length === 0 || weak.schema.fields.length === 0,
    'list-only: no schema fill lines (proves details template is required)');
}

{
  const base = 'capbo-frontend/src/app/pages/partners/partner/partner.component';
  const tsOnly = [{ path: `${base}.ts`, content: 'partnerForm = this.fb.group({});' }];
  const withHtml = [
    ...tsOnly,
    { path: `${base}.html`, content: '<input formControlName="name" data-testid="partner-name" />' },
  ];
  assert.ok(!hasFeatureDetailChunk(tsOnly, 'Partners'), 'TS-only: not a form template');
  assert.ok(hasFeatureDetailChunk(withHtml, 'Partners'), 'HTML present: form template detected');
}

console.log(`module pipeline: all ${MODULES.length} modules passed`);
