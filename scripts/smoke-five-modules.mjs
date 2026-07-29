#!/usr/bin/env node
/**
 * Headed smoke: build codegen automation for VAT, Eco Tax, Partners, Currency, Retail Chain
 * Write generated-e2e/{module}-create.spec.ts and run via npx playwright test.
 *
 *   cd nocta-backend
 *   TARGET_APP_URL='https://172.31.12.13/?tenant=bota' \
 *   APP_TEST_USERNAME=… APP_TEST_PASSWORD=… \
 *   node scripts/smoke-five-modules.mjs
 *
 * Optional: SMOKE_MODULES=vat,partners  HEADLESS=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareModuleTestCase } from '../src/lib/rag/testCasePipeline.js';
import { formatChunksForPrompt } from '../src/lib/rag/retrieve.js';
import { buildUiAutomation, ensureAutomationHasFillSteps } from '../src/lib/automation/codegen.js';
import { writePlaywrightSpec, runPlaywrightSpecFile } from '../src/lib/automation/specWriter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(__dirname, '../../capbo-frontend/src/app/pages');
const ROUTES = path.resolve(__dirname, '../../capbo-frontend/src/app/app.routes.ts');

const ALL = [
  {
    id: 'vat',
    feature: 'Vat',
    ask: { title: 'create a VAT', description: 'create a VAT' },
    list: 'vat/vat/vat-list/vat-list.component.html',
    form: 'vat/vat/vat/vat.component.html',
    ts: 'vat/vat/vat/vat.component.ts',
  },
  {
    id: 'eco-tax',
    feature: 'Eco Tax',
    ask: { title: 'create eco tax', description: 'create eco tax' },
    list: 'eco-tax/eco-tax-list/eco-tax-list.component.html',
    form: 'eco-tax/eco-tax-details/eco-tax-details.component.html',
    ts: 'eco-tax/eco-tax-details/eco-tax-details.component.ts',
  },
  {
    id: 'partners',
    feature: 'Partners',
    ask: { title: 'create a partner', description: 'create a partner' },
    list: 'partners/partner-list/partner-list.component.html',
    form: 'partners/partner/partner.component.html',
    ts: 'partners/partner/partner.component.ts',
  },
  {
    id: 'currency',
    feature: 'Currencies',
    ask: { title: 'create a currency', description: 'create a currency' },
    list: 'currencies/currency-list/currency-list.component.html',
    form: 'currencies/currency/currency.component.html',
    ts: 'currencies/currency/currency.component.ts',
  },
  {
    id: 'retail-chain',
    feature: 'Retail Chain',
    ask: { title: 'create a retail chain', description: 'create retail chain' },
    list: 'retail_chain/retail-chain-list/retail-chain-list.component.html',
    form: 'retail_chain/retail-chain/retail-chain.component.html',
    ts: 'retail_chain/retail-chain/retail-chain.component.ts',
  },
  {
    id: 'articles',
    feature: 'Articles',
    ask: { title: 'create an article', description: 'create an article QA Test' },
    list: 'articles/article-list/article-list.component.html',
    form: 'articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.html',
    ts: 'articles/article-detail/article-detail-host.service.ts',
    extraForms: ['articles/article-detail/article-detail.component.html'],
    extraTs: ['articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.ts'],
  },
];

function chunk(rel, content) {
  return {
    path: `src/app/pages/${rel}`,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
  };
}

function buildAutomation(mod, routesText) {
  let formContent = fs.readFileSync(path.join(FE, mod.form), 'utf8');
  for (const ef of mod.extraForms || []) {
    formContent += `\n${fs.readFileSync(path.join(FE, ef), 'utf8')}`;
  }
  let tsContent = fs.readFileSync(path.join(FE, mod.ts), 'utf8');
  for (const et of mod.extraTs || []) {
    tsContent += `\n${fs.readFileSync(path.join(FE, et), 'utf8')}`;
  }
  const chunks = [
    chunk(mod.list, fs.readFileSync(path.join(FE, mod.list), 'utf8')),
    chunk(mod.form, formContent),
    chunk(mod.ts, tsContent),
  ];
  const codeContext = formatChunksForPrompt(chunks.map((c, i) => ({
    ...c,
    id: String(i),
    repoName: 'capbo',
    score: 1,
    method: 'smoke',
  })));
  const intent = {
    action: 'create',
    rawTitle: mod.ask.title,
    rawDescription: mod.ask.description,
    combinedAsk: `${mod.ask.title}. ${mod.ask.description}`,
  };
  prepareModuleTestCase({
    codeContext,
    title: mod.ask.title,
    description: mod.ask.description,
    matchedFeature: mod.feature,
    intent,
  });
  let auto = buildUiAutomation({
    uiPlan: { title: mod.ask.title, ask: { action: 'create' } },
    codeContext: `${codeContext}\n${routesText}`,
    matchedFeature: mod.feature,
    intent,
  });
  auto = ensureAutomationHasFillSteps(auto, {
    codeContext,
    matchedFeature: mod.feature,
    intent,
  }) || auto;
  return auto;
}

async function main() {
  const baseUrl = (process.env.TARGET_APP_URL || '').replace(/\/+$/, '');
  const email = process.env.APP_TEST_USERNAME || '';
  const password = process.env.APP_TEST_PASSWORD || '';
  if (!baseUrl || !email || !password) {
    console.error('Set TARGET_APP_URL, APP_TEST_USERNAME, APP_TEST_PASSWORD');
    process.exit(1);
  }

  const filter = (process.env.SMOKE_MODULES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const mods = filter.length ? ALL.filter((m) => filter.includes(m.id)) : ALL;
  const routesText = fs.readFileSync(ROUTES, 'utf8');
  const headless = process.env.HEADLESS === '1';
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || 180000;

  console.log(`Smoke ${mods.length} module(s) → ${baseUrl} (${headless ? 'headless' : 'headed'})`);
  console.log('Each module: write generated-e2e/{module}-create.spec.ts → npx playwright test\n');

  const results = [];
  for (const mod of mods) {
    process.stdout.write(`▶ ${mod.id} … `);
    const automation = buildAutomation(mod, routesText);
    const t0 = Date.now();
    try {
      const written = await writePlaywrightSpec(automation, {
        title: `Smoke · ${mod.feature}`,
        stableName: mod.id,
        action: 'create',
      });
      const res = await runPlaywrightSpecFile({
        filePath: written.filePath,
        baseUrl,
        email,
        password,
        headless,
        timeoutMs,
      });
      const ms = Date.now() - t0;
      const ok = res.passed && !res.skipped;
      results.push({ id: mod.id, ok, ms, log: res.log, spec: written.relativePath });
      console.log(ok ? `PASS ${ms}ms` : `FAIL ${ms}ms`);
      console.log(`  spec → ${written.relativePath}`);
      if (!ok) console.log(res.log?.split('\n').slice(-10).join('\n'));
    } catch (e) {
      const ms = Date.now() - t0;
      results.push({ id: mod.id, ok: false, ms, log: String(e.message || e) });
      console.log(`FAIL ${ms}ms\n${e.message || e}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
