/**
 * Guard: create flows must always click Add before fills — never confuse Save wording with Add.
 * Run: node --test src/lib/automation/createClickGuard.test.js
 */
import assert from 'node:assert/strict';
import {
  isCreateClickStep,
  isSaveClickStep,
  ensureCreateClickStep,
  ensureDeleteFlowSteps,
  buildRunnablePlaywrightSpec,
  normalizeAutomationStepOrder,
  editButtonStrategies,
} from './codegen.js';

assert.equal(
  isCreateClickStep({ action: 'click', description: "Click the 'Save' button to create the currency." }),
  false,
  'Save-to-create wording is NOT Add',
);
assert.equal(
  isSaveClickStep({ action: 'click', description: "Click the 'Save' button to create the currency." }),
  true,
  'Save-to-create wording IS Save',
);
assert.equal(
  isCreateClickStep({ action: 'click', description: 'Click Add / Create' }),
  true,
);
assert.equal(
  isCreateClickStep({ id: 'click-create', action: 'click', description: 'anything' }),
  true,
);

const modules = ['Currency', 'VAT', 'Eco Tax', 'Partners', 'Retail Chain'];
for (const feature of modules) {
  const steps = ensureCreateClickStep(
    [
      { id: 'goto', action: 'goto', path: `/${feature.toLowerCase().replace(/\s+/g, '-')}` },
      { id: 'fill-name', action: 'fill', formControl: 'name', testId: 'x-name', value: 'A', strategies: [{ type: 'testid', value: 'x-name' }] },
      { id: 'click-save', action: 'click', description: 'Click the Save button to create the record', strategies: [{ type: 'testid', value: 'x-save' }] },
    ],
    { action: 'create', vocab: { testIds: ['x-create', 'x-save', 'x-search'] }, entityStem: 'x' },
  );
  assert.ok(steps.some((s) => s.id === 'click-create'), `${feature}: injects click-create`);
  const createIdx = steps.findIndex((s) => s.id === 'click-create');
  const fillIdx = steps.findIndex((s) => s.action === 'fill');
  assert.ok(createIdx < fillIdx, `${feature}: Add before fill`);
}

const spec = buildRunnablePlaywrightSpec({
  feature: 'Currency',
  action: 'create',
  route: '/currency',
  createTestId: 'currency-create',
  steps: [
    { id: 'goto', action: 'goto', path: '/currency', description: 'Navigate to currency creation page' },
    {
      id: 'fill-code',
      action: 'fill',
      formControl: 'code',
      testId: 'currency-code',
      componentType: 'autocomplete',
      value: 'EUR',
      strategies: [{ type: 'testid', value: 'currency-code' }],
      description: 'Enter EUR',
    },
    {
      id: 'click-save',
      action: 'click',
      testId: 'currency-save',
      strategies: [{ type: 'testid', value: 'currency-save' }],
      description: "Click the 'Save' button to create the currency.",
    },
  ],
  data: { verifyText: 'EUR' },
}, { createTestId: 'currency-create' });
assert.match(spec, /currency-create/, 'spec clicks currency-create');
assert.match(spec, /Open create form via Add button/, 'spec documents Add click');
assert.ok(
  spec.indexOf('currency-create') < spec.indexOf('currency-code'),
  'Add click before currency-code fill',
);

// All 5 modules: bare *-edit in AI plan → row-scoped locator in generated spec
const MODULE_STEMS = [
  { stem: 'vat', row: 'VAT-01', rowTestId: 'vat-row', editTestId: 'vat-edit', searchTestId: 'vat-search' },
  { stem: 'eco-tax', row: 'ECO-01', rowTestId: 'eco-tax-row', editTestId: 'eco-tax-edit', searchTestId: 'eco-tax-search' },
  { stem: 'partner', row: 'ACME-01', rowTestId: 'partner-row', editTestId: 'partner-edit', searchTestId: 'partner-search' },
  { stem: 'currency', row: 'EUR', rowTestId: 'currency-row', editTestId: 'currency-edit', searchTestId: 'currency-search' },
  { stem: 'retail-chain', row: 'Jay 123', rowTestId: 'retail-chain-row', editTestId: 'retail-chain-edit', searchTestId: 'retail-chain-search' },
];
for (const mod of MODULE_STEMS) {
  const specUpdate = buildRunnablePlaywrightSpec({
    feature: mod.stem,
    action: 'update',
    route: `/${mod.stem}`,
    steps: [
      { id: 'goto', action: 'goto', path: `/${mod.stem}` },
      { id: 'fill-search', action: 'fill', value: mod.row, strategies: [{ type: 'testid', value: mod.searchTestId }] },
      {
        id: 'click-edit',
        action: 'click',
        testId: mod.editTestId,
        strategies: [{ type: 'testid', value: mod.editTestId }, { type: 'testid', value: mod.rowTestId }],
        description: `Click Edit for row "${mod.row}"`,
      },
      { id: 'click-save', action: 'click', testId: `${mod.stem}-save`, strategies: [{ type: 'testid', value: `${mod.stem}-save` }] },
    ],
    data: { existingRowNeedle: mod.row },
  });
  assert.ok(
    !new RegExp(`getByTestId\\("${mod.editTestId}"\\)`).test(specUpdate),
    `${mod.stem}: no bare ${mod.editTestId}`,
  );
  assert.ok(/has-text|hasText/.test(specUpdate), `${mod.stem}: row-scoped edit`);
}

const updateSteps = normalizeAutomationStepOrder([
  { id: 'goto', action: 'goto', path: '/currency' },
  { id: 'click-edit', action: 'click', testId: 'currency-edit', description: 'Click edit for row "EUR"' },
  { id: 'fill-name', action: 'fill', formControl: 'name', testId: 'currency-name', value: 'Euro Updated QA', strategies: [{ type: 'testid', value: 'currency-name' }] },
  { id: 'fill-search', action: 'fill', value: 'EUR', description: 'Search for "EUR"', strategies: [{ type: 'testid', value: 'currency-search' }] },
  { id: 'click-save', action: 'click', testId: 'currency-save', strategies: [{ type: 'testid', value: 'currency-save' }], description: 'Save' },
]);
const searchIdx = updateSteps.findIndex((s) => s.id === 'fill-search');
const editIdx = updateSteps.findIndex((s) => s.id === 'click-edit');
const fillIdx = updateSteps.findIndex((s) => s.id === 'fill-name');
assert.ok(searchIdx < editIdx, 'update: search before edit');
assert.ok(editIdx < fillIdx, 'update: edit before form fills');

const vocab = { testIds: ['currency-row', 'currency-edit', 'currency-search', 'currency-save', 'currency-name'] };
const editStrats = editButtonStrategies(vocab, 'EUR');
assert.ok(editStrats.some((s) => s.type === 'css' && /currency-row.*EUR.*currency-edit/.test(s.value)), 'edit strategy scoped to EUR row');

const updateSpec = buildRunnablePlaywrightSpec({
  feature: 'Currency',
  action: 'update',
  route: '/currency',
  steps: [
    { id: 'goto', action: 'goto', path: '/currency', description: 'Navigate to the Currency List page.' },
    {
      id: 'fill-search',
      action: 'fill',
      value: 'EUR',
      strategies: [{ type: 'testid', value: 'currency-search' }],
      description: 'Search for "EUR"',
    },
    {
      id: 'click-edit',
      action: 'click',
      testId: 'currency-edit',
      strategies: [{ type: 'testid', value: 'currency-edit' }],
      description: "Click the 'Edit' button for the currency 'EUR'.",
    },
    {
      id: 'fill-name',
      action: 'fill',
      formControl: 'name',
      testId: 'currency-name',
      value: 'Euro Updated QA',
      strategies: [{ type: 'testid', value: 'currency-name' }],
      description: "Enter 'Euro Updated QA' into the Name field.",
    },
    {
      id: 'click-save',
      action: 'click',
      testId: 'currency-save',
      strategies: [{ type: 'testid', value: 'currency-save' }],
      description: 'Click Save',
    },
  ],
  data: { verifyText: 'Euro Updated QA', existingRowNeedle: 'EUR' },
});
const updateStepTitles = [...updateSpec.matchAll(/test\.step\(([^,]+)/g)].map((m) => m[1]);
const updSearchIdx = updateStepTitles.findIndex((t) => /search/i.test(t));
const updEditIdx = updateStepTitles.findIndex((t) => /edit/i.test(t));
assert.ok(updSearchIdx >= 0 && updEditIdx > updSearchIdx, 'update spec: search before edit');
assert.ok(updateSpec.includes('waitForEditFormReady'), 'update spec: waits for form load after edit');
assert.ok(updateSpec.includes('waitForFormSave'), 'update spec: waits for save API');
assert.ok(!/getByTestId\("currency-edit"\)/.test(updateSpec), 'update spec: no bare currency-edit');
assert.match(updateSpec, /currency-row.*EUR.*currency-edit|filter\(\{ hasText: "EUR" \}\)/, 'update spec: row-scoped EUR');
assert.ok(updateSpec.includes('searchNeedle'), 'update spec: verify uses row search needle');

const listSpec = buildRunnablePlaywrightSpec({
  feature: 'Currencies',
  action: 'list',
  route: '/currency',
  steps: [
    { id: 'goto', action: 'goto', path: '/currency' },
    { id: 'expect-list', action: 'expectVisible', description: 'Verify list table is visible' },
    { id: 'expect-name', action: 'expectText', text: 'the table is visible', description: 'Verify table visible' },
  ],
  data: { verifyText: 'the table is visible' },
});
assert.ok(!listSpec.includes('the table is visible'), 'list spec: no verifyInList for meta phrase');
assert.match(listSpec, /currency-list|data-testid\$="-list"/, 'list spec: uses list container testId');

const viewSpec = buildRunnablePlaywrightSpec({
  feature: 'Currency',
  action: 'view',
  route: '/currency',
  steps: [
    { id: 'goto', action: 'goto', path: '/currency' },
    { id: 'fill-search', action: 'fill', value: 'EUR', strategies: [{ type: 'testid', value: 'currency-search' }] },
    {
      id: 'click-view',
      action: 'click',
      testId: 'currency-view',
      strategies: [{ type: 'testid', value: 'currency-view' }],
      description: 'Click view for row "EUR"',
    },
  ],
  data: { searchTerm: 'EUR', existingRowNeedle: 'EUR' },
});
assert.ok(!/getByTestId\("currency-view"\)/.test(viewSpec), 'view spec: no bare currency-view');
assert.match(viewSpec, /currency-row.*EUR.*currency-view/, 'view spec: row-scoped EUR view');
assert.ok(viewSpec.includes('waitForViewFormReady'), 'view spec: waits for view form');

const codegenDelete = {
  action: 'delete',
  steps: [
    { id: 'goto', action: 'goto', path: '/eco-tax' },
    { id: 'fill-search', action: 'fill', value: 'ECO-QA-01', strategies: [{ type: 'testid', value: 'eco-tax-search' }] },
    { id: 'click-edit', action: 'click', strategies: [{ type: 'css', value: '[data-testid$="-row"]:has-text("ECO-QA-01") [data-testid$="-edit"]' }] },
    { id: 'click-delete', action: 'click', strategies: [{ type: 'testid', value: 'eco-tax-delete' }] },
    { id: 'click-confirm', action: 'click', strategies: [{ type: 'testid', value: 'confirm' }] },
    { id: 'expect-absent', action: 'expectAbsent', text: 'ECO-QA-01' },
  ],
  data: { searchTerm: 'ECO-QA-01', existingRowNeedle: 'ECO-QA-01' },
};
const aiDeleteIncomplete = {
  action: 'delete',
  steps: [
    { id: 'goto', action: 'goto', path: '/eco-tax' },
    { id: 'fill-search', action: 'fill', value: 'ECO-QA-01', strategies: [{ type: 'testid', value: 'eco-tax-search' }] },
    { id: 'click-edit', action: 'click', description: "Click the 'Edit' button for the found eco tax" },
    { id: 'expect-text', action: 'expectText', text: 'ECO-QA-01', description: 'Verify eco tax is no longer present' },
  ],
  data: { searchTerm: 'ECO-QA-01' },
};
const mergedDelete = ensureDeleteFlowSteps(aiDeleteIncomplete, codegenDelete);
const deleteIds = mergedDelete.steps.map((s) => s.id);
assert.ok(deleteIds.includes('click-delete'), 'delete merge: injects click-delete');
assert.ok(deleteIds.includes('click-confirm'), 'delete merge: injects click-confirm');
assert.ok(deleteIds.includes('expect-absent'), 'delete merge: injects expect-absent');
assert.ok(deleteIds.indexOf('click-edit') < deleteIds.indexOf('click-delete'), 'delete merge: edit before delete');

const deleteSpec = buildRunnablePlaywrightSpec({
  feature: 'Eco Tax',
  action: 'delete',
  route: '/eco-tax',
  steps: mergedDelete.steps,
  data: mergedDelete.data,
});
assert.ok(deleteSpec.includes('eco-tax-delete'), 'delete spec: clicks eco-tax-delete');
assert.ok(deleteSpec.includes('getByTestId("confirm")'), 'delete spec: confirms dialog');
assert.ok(deleteSpec.includes('assertAbsentInList'), 'delete spec: asserts row absent');
assert.ok(!/await verifyInList\(/.test(deleteSpec), 'delete spec: no verifyInList call (would assert present)');
assert.match(
  deleteSpec,
  /getByTestId\("eco-tax-delete-confirm"\)|getByTestId\("confirm"\)/,
  'delete spec: confirms via module or shared dialog testId',
);

console.log('createClickGuard: all checks passed');
