/**
 * Smoke tests for Code · Repo API automation parsing.
 */
import assert from 'node:assert/strict';
import {
  extractApiEndpoints,
  extractApiRequiredFields,
  buildApiAutomation,
  buildRunnableApiSpec,
  resolveApiCollectionPath,
} from './codegen.js';

const currencyCtx = `
#[Route('/api/currencies', name: 'api_currency_', priority: 10)]
class CurrencyController {
  #[Route('', name: 'list', methods: ['GET'])]
  public function list() {}
  #[Route('', name: 'create', methods: ['POST'])]
  public function create() {}
  #[Route('/{code}', name: 'update', methods: ['PUT'])]
  public function update() {}
}
$createSchema = [
  'required' => ['code', 'numericCode', 'name', 'symbol', 'roundingIncrement'],
];
$paths->addPath('/api/currencies', new PathItem(
  get: new Operation(),
  post: new Operation(),
));
`;

const endpoints = extractApiEndpoints(currencyCtx);
assert.ok(endpoints.some((e) => e.method === 'POST' && e.path === '/api/currencies'), 'POST /api/currencies');
assert.ok(endpoints.some((e) => e.method === 'GET' && e.path === '/api/currencies'), 'GET /api/currencies');

const required = extractApiRequiredFields(currencyCtx);
assert.deepEqual(
  required.sort(),
  ['code', 'name', 'numericCode', 'roundingIncrement', 'symbol'].sort(),
  'OpenAPI required fields',
);

const auto = buildApiAutomation({
  cases: [],
  codeContext: currencyCtx,
  matchedFeature: 'Currency',
  intent: {
    action: 'create',
    testData: {
      fields: { code: 'TOP', numericCode: '776', name: 'Paanga QA', symbol: 'T$', roundingIncrement: '0.01' },
      verifyText: 'TOP',
    },
  },
});
assert.equal(auto.kind, 'api');
assert.ok(auto.steps.some((s) => s.method === 'POST' && s.path === '/api/currencies'), 'create step');
assert.equal(auto.steps.find((s) => s.id === 'api-create').body.code, 'TOP');

const src = buildRunnableApiSpec(auto, { matchedFeature: 'Currency', action: 'create' });
assert.match(src, /capboApiRequest/);
assert.match(src, /POST \/api\/currencies/);
assert.match(src, /ensureCapboAccessToken/);

// Eco tax: no Route chunks — feature fallback must still unlock Code · Repo
assert.equal(resolveApiCollectionPath('Eco Tax', ''), '/api/ecotaxes');
const eco = buildApiAutomation({
  cases: [],
  codeContext: '',
  matchedFeature: 'Eco Tax',
  intent: {
    action: 'create',
    testData: {
      fields: { code: 'ECO-QA-0167', name: 'Plastic packaging tax', category: 'RCP' },
      verifyText: 'ECO-QA-0167',
    },
  },
});
assert.ok(eco.steps.length >= 1, 'eco tax API steps without backend context');
assert.ok(eco.steps.some((s) => s.method === 'POST' && s.path === '/api/ecotaxes'), 'POST /api/ecotaxes');
assert.equal(eco.steps.find((s) => s.id === 'api-create').body.code, 'ECO-QA-0167');
assert.equal(eco.steps.find((s) => s.id === 'api-create').body.category, 'RCP');
assert.equal(eco.steps.find((s) => s.id === 'api-create').body.calculation_mode, 'FIXED_AMOUNT');

// Truncated OpenAPI: GET /api/ecotaxes present, POST missing → still emit create
const partialGetOnly = `
$paths->addPath('/api/ecotaxes', new PathItem(
  get: new Operation(),
));
`;
const ecoPartial = buildApiAutomation({
  cases: [],
  codeContext: partialGetOnly,
  matchedFeature: 'Ecotax',
  intent: {
    action: 'create',
    testData: { fields: { code: 'ECO-QA-0167' }, verifyText: 'ECO-QA-0167' },
  },
});
assert.ok(
  ecoPartial.steps.some((s) => s.method === 'POST' && s.path === '/api/ecotaxes'),
  'GET-only OpenAPI chunk must still yield POST /api/ecotaxes',
);
assert.equal(ecoPartial.steps.find((s) => s.id === 'api-create').body.code, 'ECO-QA-0167');

// Ask code/name must appear even when LLM testData.fields is empty (Backend-only)
const ecoAsk = buildApiAutomation({
  cases: [],
  codeContext: '',
  matchedFeature: 'Ecotax',
  intent: {
    action: 'create',
    rawTitle: 'create an eco tax',
    rawDescription: 'create an eco tax with code ECO-QA-0167, name Plastic packaging tax; use first option for category',
    testData: { fields: {}, verifyText: null },
  },
});
const ecoBody = ecoAsk.steps.find((s) => s.id === 'api-create').body;
assert.equal(ecoBody.code, 'ECO-QA-0167', 'ask code must be in POST body');
assert.match(String(ecoBody.name), /Plastic packaging tax/i, 'ask name must be in POST body');
assert.ok(ecoBody.display_label, 'display_label required');

// “first option” → resolveFirst GETs (same idea as UI select first)
const ecoFirst = buildApiAutomation({
  cases: [],
  codeContext: '',
  matchedFeature: 'Ecotax',
  intent: {
    action: 'create',
    rawTitle: 'create an eco tax',
    rawDescription: 'code ECO-QA-0199, name Plastic; use first option for category, calculation mode, and VAT',
    testData: { fields: {} },
  },
});
const createStep = ecoFirst.steps.find((s) => s.id === 'api-create');
assert.ok(Array.isArray(createStep.resolveFirst) && createStep.resolveFirst.length >= 3, 'resolveFirst for category/mode/vat');
assert.equal(createStep.body.category, '__first__');
assert.equal(createStep.body.calculation_mode, '__first__');
assert.equal(createStep.body.vat_id, '__first__');
const ecoSrc = buildRunnableApiSpec(ecoFirst, { matchedFeature: 'Ecotax', action: 'create' });
assert.match(ecoSrc, /resolveApiFirstOptions/);
assert.match(ecoSrc, /ecotax_category/);
assert.match(ecoSrc, /vats\/dropdowns/);

console.log('apiAutomation: all checks passed');
