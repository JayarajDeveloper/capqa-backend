/**
 * Guards for the AI scenario layer: proposals are only accepted when the
 * extracted schema backs them, and emitted specs stay testid-grounded.
 * Run: node --test src/lib/automation/aiScenarios.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRuleScenarios, validateScenarios, emitValidationSpec, schemaSummary, buildScenarioPrompt,
} from './aiScenarios.js';
import { buildModuleContext, featureName, DEFAULT_MODULES } from './moduleDiscovery.js';
import { prepareModuleTestCase } from '../rag/testCasePipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.resolve(__dirname, '../../../../capbo-frontend');

const { codeContext } = buildModuleContext(FE_ROOT, 'currencies');
const prepared = prepareModuleTestCase({
  codeContext, title: 'create a currency', description: 'create a currency',
  matchedFeature: 'Currencies', intent: { action: 'create' },
});
const schema = prepared.schema;

// 1. Deterministic derivation covers the pattern rules of the currency form.
const derived = deriveRuleScenarios(schema);
assert.ok(derived.some((s) => s.field === 'code' && s.expect === 'error'), 'code pattern scenario derived');
assert.ok(derived.some((s) => s.field === 'numericCode' && s.expect === 'error'), 'numericCode pattern scenario derived');
assert.ok(derived.every((s) => schema.fields.some((f) => f.key === s.field && f.testId)), 'derived scenarios all schema-backed');

// 2. AI proposals: unknown fields, dropdown fields and bad expectations are dropped.
const { valid, dropped } = validateScenarios({
  scenarios: [
    { id: 'ok', title: 'symbol accepts unicode', field: 'symbol', value: '¤', expect: 'accepted', ac: ['Symbol accepts unicode'] },
    { id: 'bad-field', title: 'x', field: 'notAField', value: '1', expect: 'error', ac: [] },
    { id: 'bad-expect', title: 'x', field: 'name', value: '1', expect: 'explodes', ac: [] },
    { id: 'dup', title: 'dup of derived', field: 'code', value: 'abc', expect: 'error', ac: [] },
  ],
}, schema, derived);
assert.equal(valid.length, 1, 'only the schema-backed proposal survives');
assert.equal(valid[0].field, 'symbol');
assert.equal(dropped.length, 3, 'ungrounded proposals dropped');

// 3. Emitted spec is testid-grounded and maps every AC to a comment + assertion.
const { source } = emitValidationSpec({ feature: 'Currencies', codeContext, scenarios: [...derived, ...valid] });
assert.ok(/getByTestId\("currency-code"\)/.test(source), 'uses real currency-code testid');
assert.ok(/getByTestId\("currency-create"\)/.test(source), 'opens form via real create testid');
assert.ok(!/data-formcontrolname/.test(source), 'no phantom selectors');
assert.ok(/\/\/ AC: /.test(source), 'AC comments emitted');
assert.ok(/toBeDisabled|toBeVisible|toBeTruthy|toBe\(/.test(source), 'assertions present');
assert.ok(/ensureCapboSession\(page, "\/currency"\)/.test(source), 'direct route navigation');

// 4. Prompt building stays compact and fact-based.
const prompt = buildScenarioPrompt({ feature: 'Currencies', schema, existing: derived });
assert.ok(prompt.includes('"testId"'), 'prompt carries testids');
assert.ok(prompt.length < 20_000, 'prompt bounded');
assert.ok(schemaSummary(schema).every((f) => f.testId), 'summary only exposes automatable fields');

// 5. Discovery: all five pilot modules resolve without per-module code.
for (const folder of DEFAULT_MODULES) {
  const ctx = buildModuleContext(FE_ROOT, folder);
  assert.ok(ctx.codeContext.length > 1000, `${folder}: context built`);
  assert.ok(featureName(folder).length > 2, `${folder}: feature name`);
}

console.log('aiScenarios guards: all passed');
