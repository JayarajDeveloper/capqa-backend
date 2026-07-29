/**
 * Regression tests for the "2 days of data-filling failures" root causes.
 * Guards, per module, that codegen output is executable against the REAL DOM:
 *   1. No phantom selectors — data-formcontrolname is never rendered by Angular,
 *      so no strategy and no emitted spec line may reference it.
 *   2. Custom dropdowns (app-custom-dropdown / wrappers) become SELECT steps with
 *      their real testId — never fill steps (mat-select cannot be fill()ed).
 *   3. Every Validators.required field of the form reaches the plan — including
 *      the ones that live past 12k chars in the TS (vat_id, currency, …).
 *
 * Run: node --test src/lib/rag/groundedSpec.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiAutomation } from '../automation/codegen.js';
import { formatChunksForPrompt, capChunkBodiesForPrompt } from './retrieve.js';
import { maxCharsForPath } from './live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.resolve(__dirname, '../../../../capbo-frontend/src/app/pages');

function readPageFile(relPath) {
  const full = path.join(FE_ROOT, relPath);
  if (!fs.existsSync(full)) throw new Error(`Missing fixture: ${full}`);
  return fs.readFileSync(full, 'utf8');
}

function chunk(pathRel, content) {
  return {
    path: `src/app/pages/${pathRel}`,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
  };
}

const MODULES = [
  {
    id: 'eco-tax',
    feature: 'Eco Tax',
    listPath: 'eco-tax/eco-tax-list/eco-tax-list.component.html',
    formPath: 'eco-tax/eco-tax-details/eco-tax-details.component.html',
    formTsPath: 'eco-tax/eco-tax-details/eco-tax-details.component.ts',
    selectFields: { vat_id: 'eco-tax-vat', category: 'eco-tax-category', calculation_mode: 'eco-tax-calculation-mode' },
    requiredInPlan: ['code', 'name', 'display_label', 'valued', 'vat_id'],
  },
  {
    id: 'partner',
    feature: 'Partners',
    listPath: 'partners/partner-list/partner-list.component.html',
    formPath: 'partners/partner/partner.component.html',
    formTsPath: 'partners/partner/partner.component.ts',
    selectFields: {
      partnerType: 'partner-type',
      enterpriseIdentifierType: 'partner-enterprise-identifier-type',
      currency: 'partner-currency',
    },
    requiredInPlan: ['code', 'name', 'partnerType', 'enterpriseIdentifierType', 'currency'],
  },
  {
    id: 'vat',
    feature: 'Vat',
    listPath: 'vat/vat/vat-list/vat-list.component.html',
    formPath: 'vat/vat/vat/vat.component.html',
    formTsPath: 'vat/vat/vat/vat.component.ts',
    selectFields: { country: 'vat-country' },
    requiredInPlan: ['name', 'rate', 'country'],
  },
];

// Full files must survive the live-hydrate cap (the 12k truncation bug).
assert.ok(maxCharsForPath('src/app/pages/partners/partner/partner.component.ts') >= 136_000,
  'component TS files must not be truncated below real file sizes');
assert.ok(maxCharsForPath('src/app/pages/partners/partner/partner.component.html') >= 70_000,
  'component HTML files must not be truncated below real file sizes');
assert.equal(maxCharsForPath('src/Features/Partner/PartnerController.php'), 12_000,
  'non-component files keep the prompt-safe cap');

// Prompt capping is a separate concern: full context in, bounded prompt out.
{
  const big = formatChunksForPrompt([chunk('partners/partner/partner.component.html',
    readPageFile('partners/partner/partner.component.html'))]);
  const capped = capChunkBodiesForPrompt(big, 12_000);
  assert.ok(big.length > 60_000, 'fixture is actually big');
  assert.ok(capped.length < big.length, 'prompt view is capped');
  assert.ok(/truncated for prompt/.test(capped), 'prompt view notes truncation');
  assert.ok(!/truncated for prompt/.test(big), 'schema view stays complete');
}

for (const mod of MODULES) {
  const chunks = [
    chunk(mod.listPath, readPageFile(mod.listPath)),
    chunk(mod.formPath, readPageFile(mod.formPath)),
    chunk(mod.formTsPath, readPageFile(mod.formTsPath)),
  ];
  const codeContext = formatChunksForPrompt(chunks);

  const automation = buildUiAutomation({
    uiPlan: { ask: { action: 'create' } },
    codeContext,
    matchedFeature: mod.feature,
    intent: { action: 'create', rawTitle: `create a ${mod.id}`, rawDescription: `create a ${mod.id}` },
  });

  const src = automation.playwrightSource || '';
  const steps = automation.steps || [];

  // 1. No phantom selectors anywhere — in strategies or in the emitted spec.
  const allStrategyValues = steps.flatMap((s) => (s.strategies || []).map((x) => String(x.value || '')));
  assert.ok(!allStrategyValues.some((v) => /data-formcontrolname/i.test(v)),
    `${mod.id}: no data-formcontrolname strategy`);
  assert.ok(!/data-formcontrolname/i.test(src), `${mod.id}: no data-formcontrolname in emitted spec`);

  // 2. Wrapper dropdowns are select steps carrying their REAL testId.
  for (const [key, testId] of Object.entries(mod.selectFields)) {
    const step = steps.find((s) => s.formControl === key);
    if (!step) continue; // fields with valid defaults may be skipped by design
    assert.equal(step.action, 'select', `${mod.id}: ${key} must be a select step, not fill`);
    assert.equal(step.testId, testId, `${mod.id}: ${key} select uses real testId ${testId}`);
  }

  // 3. Required fields with NO default all reach the plan (the missing-VAT bug).
  const coveredControls = new Set(steps.filter((s) => s.action === 'fill' || s.action === 'select')
    .map((s) => s.formControl));
  for (const key of mod.requiredInPlan) {
    const field = (automation.data?.formSchema?.fields || []).find((f) => f.key === key);
    const hasDefault = field == null; // schema always has these modules' fields
    assert.ok(!hasDefault, `${mod.id}: schema knows field ${key}`);
    assert.ok(coveredControls.has(key), `${mod.id}: required field ${key} present in plan steps`);
  }

  // 4. Emitted spec uses the hardened helpers (searchList verify, no raw searchTerm locator).
  assert.ok(/searchList\(/.test(src), `${mod.id}: verify uses searchList helper`);
  assert.ok(!/input\[formcontrolname="searchTerm"\], input\[formControlName="searchTerm"\], \[data-testid\*="search"\] input/.test(src),
    `${mod.id}: old broken search locator gone`);
}

console.log('grounded spec guarantees: all modules passed');
