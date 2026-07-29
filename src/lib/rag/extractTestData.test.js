// Quick checks for free-form ask parsing (run: node src/lib/rag/extractTestData.test.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTestData,
  mapFieldToFormControl,
  parseIntent,
  combineAsk,
  normalizeTestData,
  entityStemFromVocab,
  entityStemFromResourceSeg,
  resolveVerifyNeedle,
  isGenericOutcomePhrase,
} from './ground.js';
import { extractFormSchema, parseListSearchMeta, resolveFormFieldValues, buildFormAutomationFields, buildFormFillStepLines, resolveFormFieldValuesWithSources, defaultValueFromPattern } from './formSchema.js';
import { extractModuleCapabilities, validateActionAgainstCapabilities, assessComposeFeasibility, normalizeRowNeedle } from './codeSignals.js';
import { applyFormSchemaDefaults } from './ground.js';
import { buildSelectStrategies, buildFillStrategies } from './componentRegistry.js';
import { saveButtonStrategies } from '../automation/codegen.js';
import { prepareModuleTestCase } from './testCasePipeline.js';
import { mergePreparedFormSteps } from '../llm.js';

const currencySnippet = `[1] capbo :: capbo-frontend/src/app/pages/currencies/currency/currency.component.html:40-50
\`\`\`html
<input matInput [formControl]="currencyCodeControl" [matAutocomplete]="currencyCodeAuto"
  maxlength="3" data-testid="currency-code" />
<input matInput formControlName="numericCode" data-testid="currency-numeric-code" />
<input matInput formControlName="name" data-testid="currency-name" />
<input matInput formControlName="symbol" data-testid="currency-symbol" />
\`\`\`
[2] capbo :: capbo-frontend/src/app/pages/currencies/currency/currency.component.ts:130-180
\`\`\`typescript
currencyCodeControl = new FormControl('', [Validators.required, Validators.pattern('[A-Z]{3}')]);
currencyForm: FormGroup = this.fb.group({
  code: ['', [Validators.required, Validators.pattern('[A-Z]{3}')]],
  numericCode: ['', [Validators.required, Validators.pattern('[0-9]{3}')]],
  name: ['', Validators.required],
  symbol: [''],
});
this.currencyCodeControl.valueChanges.subscribe((value) => {
  this.currencyForm.get('code')?.setValue(value);
});
// Autocomplete filter — must NOT steal sync map toward conversionCurrency
this.currencyCodeControl.valueChanges.subscribe((value) => {
  const searchTerm = (value || '').toUpperCase();
  this.filteredCurrencyCodes = this.availableCurrencyCodes.filter((c) => c.code.includes(searchTerm));
});
private handleConversionCurrencyValidation(baseCode: unknown): void {
  this.conversions.controls.forEach((control) => {
    const conversionCode = control.get('conversionCurrency')?.value;
  });
}
\`\`\``;

const currencySchema = extractFormSchema(currencySnippet, { entityStem: 'currency' });
const codeField = currencySchema.fields.find((f) => f.key === 'code');
assert.equal(codeField?.testId, 'currency-code', 'currency code testId from [formControl]');
assert.equal(codeField?.standalone, true, 'currency code is standalone FormControl');
assert.equal(codeField?.type, 'autocomplete', 'currency code is autocomplete');
assert.equal(codeField?.controlVar, 'currencyCodeControl', 'keeps control var from HTML');
assert.ok(!currencySchema.fields.some((f) => f.key === 'conversionCurrency' && f.testId === 'currency-code'),
  'currency-code must not map to conversionCurrency');
const codeFill = buildFillStrategies(codeField);
assert.ok(codeFill.some((s) => s.value === 'currency-code'), 'fill uses currency-code testId');
assert.ok(!codeFill.some((s) => /formcontrolname="code"/i.test(s.value || '')), 'no formcontrolname=code for standalone');
const alpha3 = defaultValueFromPattern('[A-Z]{3}');
assert.equal(alpha3?.length, 3, 'pattern default length 3');
assert.notEqual(alpha3, 'EUR', 'no hardcoded EUR');
assert.match(alpha3, /^[A-Z]{3}$/);
const digits = defaultValueFromPattern('[0-9]{3}');
assert.equal(digits?.length, 3, 'digit pattern length 3');
assert.notEqual(digits, '978', 'no hardcoded 978');

const partnerSnippet = `[1] capbo :: capbo-frontend/src/app/pages/partners/partner/partner.component.html:60-120
\`\`\`html
<form [formGroup]="partnerForm" data-testid="partner-form">
  <input matInput formControlName="code" data-testid="partner-code" />
  <input matInput formControlName="name" data-testid="partner-name" />
  <app-custom-dropdown [control]="partnerTypeControl" testId="partner-type"></app-custom-dropdown>
  <app-custom-dropdown [control]="enterpriseIdentifierTypeControl"></app-custom-dropdown>
  <app-custom-dropdown [control]="currencyControl" testId="partner-currency"></app-custom-dropdown>
</form>
\`\`\`

[2] capbo :: capbo-frontend/src/app/pages/partners/partner/partner.component.ts:385-400
\`\`\`typescript
partnerForm: FormGroup = this.fb.group({
  code: ['', [Validators.required, Validators.minLength(2)]],
  name: ['', [Validators.required, Validators.minLength(2)]],
  partnerType: ['', [Validators.required]],
  enterpriseIdentifierType: ['', [Validators.required]],
  currency: ['', [Validators.required]],
});
get partnerTypeControl(): FormControl { return this.partnerForm.get('partnerType') as FormControl; }
get enterpriseIdentifierTypeControl(): FormControl { return this.partnerForm.get('enterpriseIdentifierType') as FormControl; }
get currencyControl(): FormControl { return this.partnerForm.get('currency') as FormControl; }
\`\`\``;

const vatSnippet = `[1] capbo :: capbo-frontend/src/app/pages/vat/vat/vat/vat.component.html:140-170
\`\`\`html
<input matInput formControlName="name" data-testid="vat-name" />
<input matInput formControlName="rate" data-testid="vat-rate" />
<app-countries-dropdown
  [control]="countryControl"
  testId="vat-country"></app-countries-dropdown>
\`\`\`
[2] capbo :: capbo-frontend/src/app/pages/vat/vat/vat/vat.component.ts:80-100
\`\`\`typescript
vatForm: FormGroup = this.fb.group({
  name: ['', Validators.required],
  rate: ['', Validators.required],
  country: ['', Validators.required],
});
get countryControl(): FormControl { return this.vatForm.get('country') as FormControl; }
\`\`\``;

const vatSchema = extractFormSchema(vatSnippet, { entityStem: 'vat' });
const countryField = vatSchema.fields.find((f) => f.key === 'country');
assert.equal(countryField?.componentType, 'countries-dropdown', 'vat country wrapper');
assert.equal(countryField?.testId, 'vat-country', 'vat country testId');
assert.equal(countryField?.type, 'dropdown', 'vat country is dropdown');

const ecoSnippet = `[1] capbo :: capbo-frontend/src/app/pages/eco-tax/eco-tax-details/eco-tax-details.component.html:130-210
\`\`\`html
<app-custom-dropdown [control]="categoryFormControl" testId="eco-tax-category"></app-custom-dropdown>
<app-custom-dropdown [control]="calculationModeFormControl" testId="eco-tax-calculation-mode"></app-custom-dropdown>
<app-custom-dropdown [control]="vatIdFormControl" testId="eco-tax-vat"></app-custom-dropdown>
\`\`\`
[2] capbo :: capbo-frontend/src/app/pages/eco-tax/eco-tax-details/eco-tax-details.component.ts:240-265
\`\`\`typescript
ecoTaxForm: FormGroup = this.fb.group({
  category: ['', Validators.required],
  calculation_mode: ['', Validators.required],
  vat_id: ['', Validators.required],
});
get categoryFormControl(): FormControl { return this.ecoTaxForm.get('category') as FormControl; }
get calculationModeFormControl(): FormControl { return this.ecoTaxForm.get('calculation_mode') as FormControl; }
get vatIdFormControl(): FormControl { return this.ecoTaxForm.get('vat_id') as FormControl; }
\`\`\``;

const ecoSchema = extractFormSchema(ecoSnippet, { entityStem: 'eco-tax' });
assert.ok(ecoSchema.fields.some((f) => f.key === 'category' && f.componentType === 'custom-dropdown'), 'eco category');
assert.ok(ecoSchema.fields.some((f) => f.key === 'calculation_mode' && f.testId === 'eco-tax-calculation-mode'), 'eco calc mode');
assert.ok(ecoSchema.fields.some((f) => f.key === 'vat_id'), 'eco vat_id mapped');

const ecoListHtml = `[1] capbo :: capbo-frontend/src/app/pages/eco-tax/eco-tax-list/eco-tax-list.component.html:1-15
\`\`\`html
<app-list-filters-card
  searchControlName="searchTerm"
  [searchPlaceholder]="'ecoTax.searchTypePlaceholder' | translate"
  searchTestId="eco-tax-search"></app-list-filters-card>
\`\`\``;
const ecoListSearch = parseListSearchMeta(ecoListHtml);
assert.deepEqual(ecoListSearch?.searchableTerms, ['code', 'name', 'value'], 'eco list search terms from i18n');
const ecoVerifySchema = {
  fields: [
    { key: 'code', testId: 'eco-tax-code', type: 'text' },
    { key: 'name', testId: 'eco-tax-name', type: 'text' },
  ],
  listSearch: ecoListSearch,
};
assert.match(
  resolveVerifyNeedle({ fields: { code: 'code-eco1', name: 'name-eco1' } }, { code: 'code-eco1', name: 'name-eco1' }, ecoVerifySchema),
  /^code-eco1$/,
  'eco verify needle prefers code for list search',
);

const partnerTypeStrategies = buildSelectStrategies({ key: 'partnerType', testId: 'partner-type', wrapperTag: 'app-custom-dropdown' });
assert.ok(partnerTypeStrategies.some((s) => s.value?.includes('data-formcontrolname="partnerType"')), 'partnerType fcn strategy');
assert.ok(!partnerTypeStrategies.some((s) => s.value === 'app-custom-dropdown mat-select'), 'no unscoped dropdown fallback');

assert.equal(entityStemFromResourceSeg('partners'), 'partner', 'partners → partner');
assert.equal(entityStemFromResourceSeg('retail-chains'), 'retail-chain', 'retail-chains → retail-chain');
assert.equal(entityStemFromResourceSeg('vat'), 'vat', 'vat unchanged');

assert.ok(isGenericOutcomePhrase('success'), 'success is generic');
assert.ok(isGenericOutcomePhrase('submitted successfully'), 'submitted successfully generic');
assert.equal(resolveVerifyNeedle({ verifyText: 'success', fields: { name: 'name-9g8q9' } }), 'name-9g8q9', 'verify falls back to name');

const partnerSave = saveButtonStrategies({ testIds: ['partner-save', 'partner-create'] }, 'partners');
assert.ok(partnerSave.some((s) => s.value === 'partner-save'), 'partners code → partner-save testId');
assert.deepEqual(
  saveButtonStrategies({}, 'partners'),
  [],
  'no invented partner-save without code testIds',
);

const schema = extractFormSchema(partnerSnippet, { entityStem: 'partner' });
assert.ok(schema.fields.some((f) => f.key === 'code' && f.required), 'partner code required');
assert.ok(schema.fields.some((f) => f.key === 'enterpriseIdentifierType' && f.componentType === 'custom-dropdown'), 'enterprise id type wrapper');
assert.ok(schema.fields.some((f) => f.key === 'name' && f.testId === 'partner-name'), 'partner name testId');
assert.ok(schema.fields.some((f) => f.key === 'partnerType' && f.type === 'dropdown'), 'partnerType dropdown');

const resolved = resolveFormFieldValues(schema, { primaryValue: 'Acme Test', fields: { name: 'Acme Test' } }, { action: 'create', featurePrefix: 'Partner' });
assert.ok(resolved.code?.includes('-'), 'default code generated from field key');
assert.equal(resolved.name, 'Acme Test', 'description name kept');
assert.equal(resolved.partnerType, '__first__', 'dropdown default');

const steps = buildFormAutomationFields(schema, resolved, 'partner');
assert.ok(steps.some((s) => s.formControl === 'code'), 'code step');
assert.ok(steps.some((s) => s.formControl === 'partnerType' && s.kind === 'select'), 'partnerType select step');
assert.ok(!steps.some((s) => s.formControl === 'activeOnly'), 'no activeOnly');

const withSources = resolveFormFieldValuesWithSources(schema, { primaryValue: 'Acme Test', fields: { name: 'Acme Test' } }, { action: 'create', featurePrefix: 'Partner' });
assert.equal(withSources.entries.find((e) => e.key === 'name')?.source, 'description');
assert.equal(withSources.entries.find((e) => e.key === 'code')?.source, 'code-default');

const { lines } = buildFormFillStepLines(schema, { primaryValue: 'Acme Test', fields: { name: 'Acme Test' } }, { action: 'create', featurePrefix: 'Partner' });
assert.ok(lines.some((l) => /Enter "Acme Test"/.test(l)), 'manual step has name');
assert.ok(lines.some((l) => /first option.*partnerType|partnerType.*first option/i.test(l) || /Select the first option in the .* dropdown/i.test(l)), 'manual step has dropdown');

const vague = applyFormSchemaDefaults(partnerSnippet, { primaryValue: null, fromDescription: false }, { entityStem: 'partner', action: 'create', featurePrefix: 'Partner' });
assert.ok(vague.testDataEntries?.length >= 4, 'vague create gets all required fields');
assert.ok(/^code-[a-z0-9-]+$/i.test(vague.fields.code), 'vague create gets code default from field key');

const vocab = { formControls: ['name', 'searchTerm', 'code'] };

function t(label, title, description, intent, expect) {
  const fullIntent = intent || parseIntent(title, description);
  const got = extractTestData(title, description, vocab, fullIntent);
  for (const [k, v] of Object.entries(expect)) {
    assert.equal(got[k], v, `${label}: ${k}`);
  }
}

assert.equal(combineAsk('create chain', 'using Jay 123'), 'create chain. using Jay 123');
assert.equal(combineAsk('', 'create retail chain Jay 123'), 'create retail chain Jay 123');

assert.equal(parseIntent('', "create retail chain using Jay 123").action, 'create');
assert.equal(parseIntent('edit Jay 123 rename to NewCo', '').action, 'update');
assert.equal(parseIntent('create a retail chain', "using name 'Jay 123'").action, 'create');

t('quoted name', 'create a retail chain', "using name 'Jay 123'", null, {
  primaryField: 'name',
  primaryValue: 'Jay 123',
  verifyText: 'Jay 123',
  fromDescription: true,
});

t('unquoted using', '', 'create retail chain using Jay 123', null, {
  primaryValue: 'Jay 123',
});

t('bare tail', '', 'create retail chain Jay 123', null, {
  primaryValue: 'Jay 123',
});

t('create action without create verb', '', 'Partners ze4b3', { action: 'create', combinedAsk: 'Partners ze4b3' }, {
  primaryField: 'name',
  primaryValue: 'ze4b3',
  verifyText: 'ze4b3',
  fromDescription: true,
});

t('name colon', 'create partner', 'name: Acme Corp', null, {
  primaryValue: 'Acme Corp',
});

t('search', 'list partners', "search for 'Acme'", null, {
  searchTerm: 'Acme',
});

t('update rename', 'edit retail chain Jay 123 rename to NewCo', '', null, {
  primaryValue: 'NewCo',
  existingRowNeedle: 'Jay 123',
});

t('no data', 'create a retail chain', '', null, {
  primaryValue: null,
  fromDescription: false,
});

const vatVocab = { formControls: ['name', 'rate', 'country', 'isActive'] };
const vatFrance = extractTestData(
  'create a VAT',
  'create a VAT with country select dropdown as France',
  vatVocab,
  { action: 'create', combinedAsk: 'create a VAT. create a VAT with country select dropdown as France' },
);
assert.equal(vatFrance.fields.country, 'France', 'country dropdown as France');
assert.ok(!vatFrance.fields.name || vatFrance.fields.name.length < 20, 'name not whole instruction phrase');
assert.notEqual(vatFrance.verifyText, 'country select dropdown as France', 'verify not instruction phrase');

const vatPrepared = prepareModuleTestCase({
  codeContext: vatSnippet,
  title: 'create a VAT',
  description: 'create a VAT with country select dropdown as France',
  matchedFeature: 'VAT',
  intent: { action: 'create', rawTitle: 'create a VAT', rawDescription: 'create a VAT with country select dropdown as France' },
});
assert.equal(vatPrepared.testData.fields.country, 'France', 'pipeline: country from description');
assert.ok(vatPrepared.testData.fields.rate, 'pipeline: rate default');
assert.ok(vatPrepared.testData.fields.name, 'pipeline: name default');
assert.ok(vatPrepared.manualFillLines.some((l) => /France/i.test(l)), 'pipeline: manual step mentions France');
assert.ok(vatPrepared.automationFields.some((f) => f.formControl === 'country' && f.value === 'France'), 'pipeline: automation country');

const partnerPrepared = prepareModuleTestCase({
  codeContext: partnerSnippet,
  title: 'create partner',
  description: "name: Acme Test",
  matchedFeature: 'Partners',
  intent: { action: 'create', rawTitle: 'create partner', rawDescription: "name: Acme Test" },
});
assert.equal(partnerPrepared.testData.fields.name, 'Acme Test', 'pipeline: partner name');
assert.ok(partnerPrepared.automationFields.some((f) => f.formControl === 'partnerType'), 'pipeline: partner dropdowns');
assert.ok(partnerPrepared.testDataEntries.some((e) => e.source === 'code-default'), 'pipeline: code defaults');

const ecoPrepared = prepareModuleTestCase({
  codeContext: ecoSnippet,
  title: 'create eco tax',
  description: '',
  matchedFeature: 'Eco tax',
  intent: { action: 'create', rawTitle: 'create eco tax', rawDescription: '' },
});
assert.ok(ecoPrepared.testDataEntries.length >= 3, 'pipeline: eco-tax defaults all required dropdowns');
assert.ok(ecoPrepared.automationFields.every((f) => f.kind === 'select'), 'pipeline: eco-tax fields are selects');

assert.equal(mapFieldToFormControl('title', ['name']), 'name');
assert.equal(mapFieldToFormControl('search', ['searchTerm']), 'searchTerm');

t('edit or not', 'edit a retail chain', "edit the 'Jay 123' retail chain and try to update with new title and check whether it is updating or not", null, {
  primaryValue: null,
  existingRowNeedle: 'Jay 123',
  searchTerm: 'Jay 123',
});

const retailCapsCtx = `[1] capbo :: capbo-frontend/src/app/pages/retail_chain/retail-chain-list/retail-chain-list.component.html:150-175
\`\`\`html
<button data-testid="retail-chain-edit" (click)="editRetailChain(retailChain)"></button>
<button data-testid="retail-chain-view" (click)="viewRetailChain(retailChain)"></button>
<input formControlName="searchTerm" data-testid="retail-chain-search" />
\`\`\`
[2] capbo :: capbo-frontend/src/app/pages/retail_chain/retail-chain/retail-chain.component.html:165-180
\`\`\`html
<div *ngIf="!isViewMode">
  <button *ngIf="isEditMode && ('RETAIL_CHAINS_DELETE' | hasCompositePermission)"
    data-testid="retail-chain-delete" (click)="deleteRetailChain(retailChainId)"></button>
</div>
\`\`\``;
const retailCaps = extractModuleCapabilities(retailCapsCtx);
assert.equal(retailCaps.listHasDelete, false, 'retail list has no delete button');
assert.equal(retailCaps.detailHasDelete, true, 'retail detail has delete in edit mode');
assert.equal(retailCaps.deleteMode, 'detail-edit', 'retail delete requires edit form');
assert.ok(validateActionAgainstCapabilities('delete', retailCaps).ok, 'delete allowed with detail-edit flow');
assert.ok(!validateActionAgainstCapabilities('delete', { supportsDelete: false }).ok, 'delete blocked when unsupported');

const currencyFormOnly = `[1] capbo :: capbo-frontend/src/app/pages/currencies/currency/currency.component.html:1-50
\`\`\`html
<input formControlName="name" data-testid="currency-name" />
<button data-testid="currency-save"></button>
\`\`\``;
const currencyWithList = `${currencyFormOnly}
[2] capbo :: capbo-frontend/src/app/pages/currencies/currency-list/currency-list.component.html:280-300
\`\`\`html
<button (click)="editCurrency(currency)" data-testid="currency-edit"></button>
<input data-testid="currency-search" />
\`\`\``;
assert.equal(extractModuleCapabilities(currencyFormOnly).listHasEdit, false, 'form-only: no edit in list');
assert.equal(extractModuleCapabilities(currencyWithList).listHasEdit, true, 'list chunk: currency-edit found');
assert.ok(validateActionAgainstCapabilities('update', extractModuleCapabilities(currencyWithList)).ok, 'update allowed with list');

assert.equal(normalizeRowNeedle('the Bota Store row'), 'Bota Store', 'strip article + row suffix');
assert.equal(normalizeRowNeedle('Metro Paris retail chain'), 'Metro Paris', 'strip entity suffix');

const currencyUpdateAsk = extractTestData(
  'update currency EUR',
  'change name to Euro Updated QA and symbol to €',
  {
    formControls: ['code', 'numericCode', 'name', 'symbol', 'rounding'],
    schemaFields: currencySchema.fields,
    matchedFeature: 'Currency',
  },
  { action: 'update', combinedAsk: 'update currency EUR. change name to Euro Updated QA and symbol to €' },
);
assert.equal(currencyUpdateAsk.existingRowNeedle, 'EUR', 'update: row needle from title');
assert.equal(currencyUpdateAsk.fields.name, 'Euro Updated QA', 'update: name from description');
assert.equal(currencyUpdateAsk.fields.symbol, '€', 'update: symbol from description');
assert.ok(!currencyUpdateAsk.fields.code, 'update: do not invent code');
assert.ok(!currencyUpdateAsk.fields.numericCode, 'update: do not invent numericCode');
assert.equal(currencyUpdateAsk.verifyText, 'Euro Updated QA', 'update: verify changed name');

const currencyUpdateResolved = resolveFormFieldValues(
  currencySchema,
  currencyUpdateAsk,
  { action: 'update', featurePrefix: 'Currency' },
);
assert.equal(currencyUpdateResolved.name, 'Euro Updated QA', 'resolve: keeps name');
assert.equal(currencyUpdateResolved.symbol, '€', 'resolve: keeps symbol');
assert.ok(!currencyUpdateResolved.code, 'resolve: no code default on update');
assert.ok(!currencyUpdateResolved.numericCode, 'resolve: no numeric default on update');

const currencyUpdatePrepared = prepareModuleTestCase({
  codeContext: `${currencySnippet}
[3] capbo :: capbo-frontend/src/app/pages/currencies/currency-list/currency-list.component.html:280-300
\`\`\`html
<button (click)="editCurrency(currency)" data-testid="currency-edit"></button>
<input data-testid="currency-search" />
\`\`\``,
  title: 'update currency EUR',
  description: 'change name to Euro Updated QA and symbol to €',
  matchedFeature: 'Currency',
  intent: {
    action: 'update',
    rawTitle: 'update currency EUR',
    rawDescription: 'change name to Euro Updated QA and symbol to €',
  },
});
assert.equal(currencyUpdatePrepared.testData.existingRowNeedle, 'EUR', 'pipeline update: EUR needle');
assert.equal(currencyUpdatePrepared.testData.searchNeedle, 'EUR', 'pipeline update: search EUR not new name');
assert.equal(currencyUpdatePrepared.testData.verifyText, 'Euro Updated QA', 'pipeline update: verify new name');
assert.equal(currencyUpdatePrepared.testDataEntries.length, 2, 'pipeline update: only name+symbol entries');
assert.ok(!currencyUpdatePrepared.testDataEntries.some((e) => e.key === 'code'), 'pipeline update: no code entry');
assert.ok(
  currencyUpdatePrepared.manualFillLines.some((l) => /Euro Updated QA/i.test(l)),
  'pipeline update: manual line for name',
);
assert.ok(
  !currencyUpdatePrepared.manualFillLines.some((l) => /GOP|955|Add|Create/i.test(l)),
  'pipeline update: no create defaults in manual lines',
);

const genericUpdatePlan = {
  steps: [
    '1. Navigate to the Currency list.',
    '2. Click Add / Create to open the form.',
    '3. Enter "GOP" in the Currency Code field.',
    '4. Enter "955" in the Numeric Code field.',
    '5. Enter "Euro Updated QA" in the Name field.',
    '6. Click Save.',
    '7. Verify "GOP" appears in the list.',
  ],
  testDataEntries: currencyUpdatePrepared.testDataEntries,
};
const mergedUpdate = mergePreparedFormSteps(genericUpdatePlan, currencyUpdatePrepared, { action: 'update' });
const mergedBlob = mergedUpdate.steps.join(' ');
assert.ok(/search.*EUR|Edit/i.test(mergedBlob), 'merge update: search EUR and edit');
assert.ok(!/Click Add|Click Create/i.test(mergedBlob), 'merge update: no Add/Create');
assert.ok(!/\bGOP\b|\b955\b/.test(mergedBlob), 'merge update: no GOP/955');
assert.ok(/Euro Updated QA/.test(mergedBlob), 'merge update: keeps name change');
assert.ok(/Verify.*Euro Updated QA/i.test(mergedBlob), 'merge update: verify new name');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const retailListHtml = fs.readFileSync(
  path.resolve(__dirname, '../../../../capbo-frontend/src/app/pages/retail_chain/retail-chain-list/retail-chain-list.component.html'),
  'utf8',
);
assert.ok(retailListHtml.includes('searchTestId="retail-chain-search"'), 'retail list has searchTestId');
assert.ok(retailListHtml.includes('data-testid="retail-chain-list"'), 'retail list container testId');

const currencyDeleteCaps = extractModuleCapabilities(`${currencyWithList}
[3] capbo :: capbo-frontend/src/app/pages/currencies/currency/currency.component.html:295-305
\`\`\`html
<button *ngIf="isEditMode" data-testid="currency-delete" (click)="onDelete()"></button>
\`\`\``);
const listDeleteAsk = assessComposeFeasibility({
  action: 'delete',
  caps: currencyDeleteCaps,
  title: 'delete currency EUR from the list',
  featureName: 'Currency',
  rowNeedle: 'EUR',
});
assert.ok(!listDeleteAsk.feasible, 'blocks list delete when only form delete in code');
assert.ok(listDeleteAsk.suggestions?.length >= 2, 'suggests alternatives');
assert.ok(listDeleteAsk.suggestions.some((s) => /^delete /i.test(s.title)), 'suggests form delete flow');

const noDelete = assessComposeFeasibility({
  action: 'delete',
  caps: { supportsDelete: false, listHasEdit: true, listHasView: true },
  title: 'delete currency EUR',
  featureName: 'Currency',
});
assert.ok(!noDelete.feasible, 'blocks when no delete in code');
assert.ok(noDelete.suggestions.some((s) => /^list /i.test(s.title)), 'suggests list when delete missing');

const okDelete = assessComposeFeasibility({
  action: 'delete',
  caps: currencyDeleteCaps,
  title: 'delete currency EUR',
  featureName: 'Currency',
  rowNeedle: 'EUR',
});
assert.ok(okDelete.feasible, 'allows delete when ask does not insist on list row');
assert.ok(okDelete.advice.some((a) => /edit/i.test(a)), 'advises edit-form delete flow');

const createCurrency = assessComposeFeasibility({
  action: 'create',
  caps: currencyDeleteCaps,
  title: 'create a currency',
  description: 'code BWP, name Euro Test',
  featureName: 'Currency',
});
assert.ok(createCurrency.feasible, 'create remains feasible');
assert.ok(
  !createCurrency.advice.some((a) => /delete|CURRENCIES_DELETE|edit mode/i.test(a)),
  'create: no delete/view capability advice',
);

console.log('free-form ask parsing: all checks passed');
