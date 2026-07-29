/**
 * AI at exactly the right point: SCENARIO + AC generation.
 *
 * The LLM proposes business-logic validation scenarios (boundaries, pattern
 * violations, clamping) with acceptance-criteria wording. It NEVER invents
 * locators or fields: every proposal is validated against the extracted form
 * schema and dropped if it references anything the code doesn't have. Emission
 * is deterministic codegen over surviving scenarios — testid-first, one
 * assertion per AC.
 *
 * Works keyless too: deriveRuleScenarios() builds the deterministic core set
 * straight from Validators.* metadata; the LLM (when a key is present) adds
 * judgment cases on top.
 */

import { extractCodeVocabulary } from '../rag/ground.js';
import { prepareModuleTestCase } from '../rag/testCasePipeline.js';
import { extractRouteHints } from './codegen.js';

const EXPECTS = new Set(['error', 'save-disabled', 'clamp-or-error', 'truncate', 'accepted']);

function q(s) {
  return JSON.stringify(String(s ?? ''));
}

function slugify(name) {
  return String(name || 'module').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Compact, prompt-friendly view of the schema (facts only). */
export function schemaSummary(schema) {
  return (schema.fields || [])
    .filter((f) => f.testId)
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      testId: f.testId,
      required: Boolean(f.required),
      validators: f.validators || {},
      businessRules: f.businessRules || [],
    }));
}

/** Deterministic scenarios derived purely from Validators.* metadata. */
export function deriveRuleScenarios(schema) {
  const out = [];
  for (const f of schema.fields || []) {
    if (!f.testId) continue;
    const v = f.validators || {};
    const isDecimal = f.type === 'decimal';
    const fillable = f.type !== 'dropdown' && !f.wrapperTag;
    if (!fillable) continue;

    if (v.patternRegex === '[A-Z]{3}') {
      out.push({
        id: `${f.key}-pattern-lower`,
        title: `${f.key} rejects lowercase (pattern [A-Z]{3})`,
        field: f.key,
        value: 'abc',
        expect: 'error',
        ac: [`${f.label || f.key} only accepts exactly 3 uppercase letters`],
      });
    } else if (v.patternRegex === '[0-9]{3}') {
      out.push({
        id: `${f.key}-pattern-alpha`,
        title: `${f.key} rejects non-digits (pattern [0-9]{3})`,
        field: f.key,
        value: 'AB1',
        expect: 'error',
        ac: [`${f.label || f.key} only accepts exactly 3 digits`],
      });
    }

    if (v.minLength != null && v.minLength > 1 && !v.patternRegex) {
      out.push({
        id: `${f.key}-minlength`,
        title: `${f.key} rejects ${v.minLength - 1} character(s) (minLength ${v.minLength})`,
        field: f.key,
        value: 'x'.repeat(Math.max(1, v.minLength - 1)),
        expect: 'error',
        ac: [`${f.label || f.key} requires at least ${v.minLength} characters`],
      });
    }

    if (v.email) {
      out.push({
        id: `${f.key}-email-invalid`,
        title: `${f.key} rejects a malformed email`,
        field: f.key,
        value: 'not-an-email',
        expect: 'error',
        ac: [`${f.label || f.key} must be a valid email address`],
      });
    }

    // Validators.max implies a numeric field even when the decimal directive
    // sits outside the parser's context window (e.g. vat rate 0–100).
    const numericish = isDecimal || f.type === 'number' || (v.max != null && v.min != null);
    if (numericish && v.max != null) {
      out.push({
        id: `${f.key}-over-max`,
        title: `${f.key} does not accept values above ${v.max}`,
        field: f.key,
        value: String(Number(v.max) + 1),
        expect: 'clamp-or-error',
        clampTo: String(v.max),
        ac: [`${f.label || f.key} is limited to a maximum of ${v.max} (clamped or rejected)`],
      });
    }
  }
  return out;
}

/** System prompt for the LLM judgment pass. */
export const SYSTEM_SCENARIOS = `You are a senior QA engineer designing BUSINESS-RULE validation tests for one Angular form.

HARD RULES — ZERO INVENTION:
1. Use ONLY field keys listed in FORM SCHEMA. Never invent fields, testids, or selectors.
2. Each scenario targets ONE field with ONE typed value and ONE expectation.
3. expect must be one of: "error" (mat-error after blur), "save-disabled", "clamp-or-error" (input auto-clamps or errors; set clampTo), "truncate" (maxlength cuts input; set truncateTo length), "accepted".
4. Base every scenario on the validators/businessRules given — no imagined rules.
5. Skip scenarios already in EXISTING (same field + same expectation).
6. Each scenario carries "ac": 1-2 short acceptance-criteria sentences a QA lead would sign off.
7. Return ONLY JSON: {"scenarios":[{"id","title","field","value","expect","clampTo?","truncateTo?","ac":["..."]}]}. Max 6.`;

export function buildScenarioPrompt({ feature, schema, existing = [] }) {
  return (
    `Module: ${feature}\n`
    + `FORM SCHEMA (extracted from live Angular source):\n${JSON.stringify(schemaSummary(schema), null, 1)}\n\n`
    + `EXISTING (already covered — do not repeat):\n${JSON.stringify(existing.map((s) => ({ field: s.field, expect: s.expect })))}\n\n`
    + 'Propose additional business-rule validation scenarios as strict JSON.'
  );
}

/** Ground the AI's proposals: drop anything the schema cannot back. */
export function validateScenarios(parsed, schema, existing = []) {
  const byKey = new Map((schema.fields || []).map((f) => [f.key, f]));
  const seen = new Set(existing.map((s) => `${s.field}:${s.expect}`));
  const valid = [];
  const dropped = [];

  for (const s of parsed?.scenarios || []) {
    const field = byKey.get(s?.field);
    const reason = !s?.field ? 'no field'
      : !field ? `unknown field ${s.field}`
        : !field.testId ? `field ${s.field} has no testId`
          : field.type === 'dropdown' || field.wrapperTag ? `field ${s.field} is a dropdown`
            : !EXPECTS.has(s.expect) ? `bad expect ${s.expect}`
              : s.value == null ? 'no value'
                : seen.has(`${s.field}:${s.expect}`) ? 'duplicate'
                  : null;
    if (reason) {
      dropped.push({ scenario: s, reason });
      continue;
    }
    seen.add(`${s.field}:${s.expect}`);
    valid.push({
      id: String(s.id || `${s.field}-${s.expect}`).replace(/[^\w-]/g, '-').slice(0, 48),
      title: String(s.title || `${s.field} ${s.expect}`),
      field: s.field,
      value: String(s.value),
      expect: s.expect,
      clampTo: s.clampTo != null ? String(s.clampTo) : null,
      truncateTo: Number.isFinite(Number(s.truncateTo)) ? Number(s.truncateTo) : null,
      ac: (Array.isArray(s.ac) ? s.ac : [s.ac]).filter(Boolean).map(String).slice(0, 3),
      source: 'ai',
    });
    if (valid.length >= 6) break;
  }
  return { valid, dropped };
}

/**
 * Emit a runnable validations spec: one test per scenario, one assertion per AC.
 * All locators from schema testIds; navigation/session via shared helpers.
 */
export function emitValidationSpec({ feature, codeContext, scenarios, route: routeIn }) {
  const vocab = extractCodeVocabulary(codeContext || '');
  const prepared = prepareModuleTestCase({
    codeContext, title: `create a ${feature}`, description: `create a ${feature}`,
    matchedFeature: feature, intent: { action: 'create' },
  });
  const schema = prepared.schema;
  const byKey = new Map((schema.fields || []).map((f) => [f.key, f]));
  const route = routeIn || extractRouteHints(codeContext, feature);
  const stem = prepared.entityStem || slugify(feature);
  const createTid = (vocab.testIds || []).find((id) => id.endsWith('-create'));
  const saveTid = (vocab.testIds || []).find((id) => id.endsWith('-save'));
  const cancelTid = (vocab.testIds || []).find((id) => id.endsWith('-cancel'));
  if (!createTid) throw new Error(`${feature}: no *-create testid — cannot open the form`);

  const L = [];
  const put = (line = '') => L.push(line);
  put('// Auto-generated by Nocta QA (business-rule validation suite).');
  put('// Scenarios: Validators.* metadata + AI judgment, each grounded against the form schema.');
  put('// Regenerate: npm run e2e:validations · Run: npx playwright test --config generated-e2e/playwright.config.mjs <name>-validations');
  put(`// Module: ${feature} · route ${route} · ${scenarios.length} scenario(s)`);
  put("import { test, expect } from '@playwright/test';");
  put("import { ensureCapboSession, fillAngularField } from './helpers/capbo-ui';");
  put('');
  put(`test.describe(${q(`${feature} business-rule validations`)}, () => {`);
  put('  test.setTimeout(30_000);');
  put('');

  for (const s of scenarios) {
    const f = byKey.get(s.field);
    if (!f?.testId) continue;
    const tid = f.testId;
    for (const ac of s.ac || []) put(`  // AC: ${ac}`);
    put(`  test(${q(s.title)}, async ({ page }) => {`);
    put(`    await ensureCapboSession(page, ${q(route)});`);
    put(`    await page.getByTestId(${q(createTid)}).click({ timeout: 15000 });`);
    put(`    const input = page.getByTestId(${q(tid)});`);
    put(`    await fillAngularField(page, input, ${q(s.value)});`);
    put("    await page.keyboard.press('Tab');");
    const formField = `input.locator('xpath=ancestor::mat-form-field[1]')`;
    if (s.expect === 'error') {
      put(`    await expect(${formField}.locator('mat-error').first().or(page.locator('mat-error').first())).toBeVisible({ timeout: 5000 });`);
      if (saveTid) put(`    await expect(page.getByTestId(${q(saveTid)})).toBeDisabled();`);
    } else if (s.expect === 'save-disabled') {
      put(`    await expect(page.getByTestId(${q(saveTid || 'save')})).toBeDisabled({ timeout: 5000 });`);
    } else if (s.expect === 'clamp-or-error') {
      put('    const val = await input.locator(\'input\').first().or(input).inputValue().catch(() => \'\');');
      if (s.clampTo != null) {
        put(`    const clamped = val.replace(',', '.') === ${q(s.clampTo)} || Number(val.replace(',', '.')) <= Number(${q(s.clampTo)});`);
      } else {
        put('    const clamped = false;');
      }
      put(`    const hasError = await ${formField}.locator('mat-error').first().isVisible().catch(() => false);`);
      put("    expect(clamped || hasError, 'value must clamp to the limit or show a validation error').toBeTruthy();");
    } else if (s.expect === 'truncate') {
      put('    const val = await input.locator(\'input\').first().or(input).inputValue().catch(() => \'\');');
      put(`    expect(val.length, 'maxlength must truncate the typed value').toBeLessThanOrEqual(${s.truncateTo ?? 'val.length'});`);
    } else {
      put('    const val = await input.locator(\'input\').first().or(input).inputValue().catch(() => \'\');');
      put(`    expect(val, 'valid value must be accepted').toBe(${q(s.value)});`);
      put(`    await expect(${formField}.locator('mat-error')).toHaveCount(0);`);
    }
    if (cancelTid) put(`    await page.getByTestId(${q(cancelTid)}).click({ timeout: 8000 }).catch(() => {});`);
    put('  });');
    put('');
  }

  put('});');
  put('');
  return { source: L.join('\n'), stem, route, count: scenarios.length };
}
