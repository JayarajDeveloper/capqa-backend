#!/usr/bin/env node
/**
 * Smoke-check the common compose pipeline against real capbo-frontend templates.
 * Run from nocta-backend: node scripts/compose-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareModuleTestCase } from '../src/lib/rag/testCasePipeline.js';
import { mergePreparedFormSteps } from '../src/lib/llm.js';
import { buildUiAutomation, extractRouteHints } from '../src/lib/automation/codegen.js';
import { formatChunksForPrompt } from '../src/lib/rag/retrieve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(__dirname, '../../capbo-frontend/src/app/pages');

const MODULES = [
  ['Vat', 'create a VAT', 'vat/vat/vat-list/vat-list.component.html', 'vat/vat/vat/vat.component.html', 'vat/vat/vat/vat.component.ts'],
  ['Eco Tax', 'create eco taxes', 'eco-tax/eco-tax-list/eco-tax-list.component.html', 'eco-tax/eco-tax-details/eco-tax-details.component.html', 'eco-tax/eco-tax-details/eco-tax-details.component.ts'],
  ['Partners', 'create partner', 'partners/partner-list/partner-list.component.html', 'partners/partner/partner.component.html', 'partners/partner/partner.component.ts'],
  ['Currencies', 'create currency', 'currencies/currency-list/currency-list.component.html', 'currencies/currency/currency.component.html', 'currencies/currency/currency.component.ts'],
  ['Retail Chain', 'create retail chain', 'retail_chain/retail-chain-list/retail-chain-list.component.html', 'retail_chain/retail-chain/retail-chain.component.html', 'retail_chain/retail-chain/retail-chain.component.ts'],
  {
    feature: 'Articles',
    ask: 'create an article',
    list: 'articles/article-list/article-list.component.html',
    form: 'articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.html',
    ts: 'articles/article-detail/article-detail-host.service.ts',
    extraForms: ['articles/article-detail/article-detail.component.html'],
    extraTs: ['articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.ts'],
  },
];

function loadContext(entry) {
  const listP = entry.list || entry[2];
  const formP = entry.form || entry[3];
  const tsP = entry.ts || entry[4];
  const extraForms = entry.extraForms || [];
  const extraTs = entry.extraTs || [];
  let formContent = fs.readFileSync(path.join(FE, formP), 'utf8');
  for (const ef of extraForms) {
    formContent += `\n${fs.readFileSync(path.join(FE, ef), 'utf8')}`;
  }
  let tsContent = fs.readFileSync(path.join(FE, tsP), 'utf8');
  for (const et of extraTs) {
    tsContent += `\n${fs.readFileSync(path.join(FE, et), 'utf8')}`;
  }
  const chunks = [listP, formP, tsP].map((p, i) => {
    const content = i === 1 ? formContent : (i === 2 ? tsContent : fs.readFileSync(path.join(FE, p), 'utf8'));
    return { path: `src/app/pages/${p}`, content, startLine: 1, endLine: content.split('\n').length };
  });
  return formatChunksForPrompt(chunks);
}

console.log('\nCapBO compose pipeline smoke (list + form HTML from capbo-frontend)\n');
console.log('Module          Route          Fields  Auto-fills  Save testId       OK');
console.log('─'.repeat(78));

let failed = 0;
for (const entry of MODULES) {
  const feature = entry.feature || entry[0];
  const ask = entry.ask || entry[1];
  try {
    const ctx = loadContext(entry);
    const route = extractRouteHints(ctx, feature);
    const prep = prepareModuleTestCase({
      codeContext: ctx,
      title: ask,
      matchedFeature: feature,
      intent: { action: 'create' },
    });
    const merged = mergePreparedFormSteps({ steps: ['Fill in all required form fields with valid data.'] }, prep);
    const auto = buildUiAutomation({ uiPlan: {}, codeContext: ctx, matchedFeature: feature, intent: { action: 'create' } });
    const fills = auto.steps.filter((s) => s.action === 'fill' || s.action === 'select').length;
    const save = auto.steps.find((s) => s.id === 'click-save')?.strategies?.find((s) => s.type === 'testid')?.value || '';
    const generic = merged.steps.some((s) => /fill in all required/i.test(s));
    const ok = prep.schema.fields.length > 0 && fills > 0 && save && !generic;
    if (!ok) failed += 1;
    console.log(
      `${feature.padEnd(15)} ${route.padEnd(14)} ${String(prep.schema.fields.length).padStart(6)}  `
      + `${String(fills).padStart(10)}  ${save.padEnd(16)}  ${ok ? '✓' : '✗'}`,
    );
  } catch (e) {
    failed += 1;
    console.log(`${feature.padEnd(15)} ERROR: ${e.message}`);
  }
}

console.log('');
if (failed) {
  console.error(`${failed} module(s) failed — check testIds and form HTML in capbo-frontend.`);
  process.exit(1);
}
console.log(`All ${MODULES.length} modules OK. Re-index capbo-frontend, then draft from index in the UI.`);
