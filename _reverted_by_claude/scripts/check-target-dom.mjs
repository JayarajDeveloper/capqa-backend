#!/usr/bin/env node
/**
 * Target-DOM doctor: proves WHERE the mismatch is — your tests, or the deployed app.
 *
 *   npm run e2e:doctor                          (uses TARGET_APP_URL from .env / env)
 *   npm run e2e:doctor -- --url https://172.31.12.13
 *   npm run e2e:doctor -- --modules currencies,vat
 *
 * For each pilot module it:
 *   1. extracts the EXPECTED testids/controls from your capbo-frontend SOURCE,
 *   2. opens the module route in a real browser (reusing generated-e2e/.auth/user.json),
 *   3. clicks Add/Create, waits for the form, and counts what actually exists in the DOM,
 *   4. captures console/network errors and a screenshot (generated-e2e/doctor/<module>.png),
 *   5. prints a verdict:
 *        HEALTHY              → DOM matches source; test failures lie elsewhere
 *        DEPLOYED-BUILD-DRIFT → form rendered, but your testids are missing → the server
 *                               runs an OLDER build than your source. Redeploy capbo-frontend
 *                               (or point TARGET_APP_URL at your dev build). Tests cannot fix this.
 *        FORM-NOT-RENDERED    → neither testids nor form controls appeared → loading gate or
 *                               failing API on that environment (see captured errors).
 *        AUTH                 → session invalid → npm run e2e:auth
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  DEFAULT_MODULES, buildModuleContext, featureName,
} from '../src/lib/automation/moduleDiscovery.js';
import { prepareModuleTestCase } from '../src/lib/rag/testCasePipeline.js';
import { extractCodeVocabulary } from '../src/lib/rag/ground.js';
import { extractRouteHints } from '../src/lib/automation/codegen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(BACKEND_ROOT, 'generated-e2e', '.auth', 'user.json');
const OUT_DIR = path.join(BACKEND_ROOT, 'generated-e2e', 'doctor');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

const FE_ROOT = path.resolve(BACKEND_ROOT, arg('fe', '../capbo-frontend'));
const rawUrl = arg('url', process.env.TARGET_APP_URL || '');
if (!rawUrl) {
  console.error('No target. Pass --url https://… or set TARGET_APP_URL in nocta-backend/.env');
  process.exit(2);
}
const ORIGIN = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`).origin;
const modules = arg('modules', DEFAULT_MODULES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const hasAuth = fs.existsSync(AUTH_FILE);
console.log(`Target: ${ORIGIN}`);
console.log(`Session: ${hasAuth ? 'generated-e2e/.auth/user.json' : 'NONE — run npm run e2e:auth first if the app needs login'}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const launchOpts = { headless: !process.argv.includes('--headed') };
if (process.env.PW_CHROMIUM_PATH) launchOpts.executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  ...(hasAuth ? { storageState: AUTH_FILE } : {}),
});

let unhealthy = 0;
for (const folder of modules) {
  const feature = featureName(folder);
  let verdict = 'ERROR';
  let detail = '';
  try {
    const { codeContext } = buildModuleContext(FE_ROOT, folder);
    const vocab = extractCodeVocabulary(codeContext);
    const prepared = prepareModuleTestCase({
      codeContext, title: 'x', description: 'x', matchedFeature: feature, intent: { action: 'create' },
    });
    const route = extractRouteHints(codeContext, feature);
    const createTid = (vocab.testIds || []).find((id) => id.endsWith('-create'));
    const fieldTids = (prepared.schema.fields || []).map((f) => f.testId).filter(Boolean);
    const controls = (prepared.schema.fields || []).map((f) => f.key);

    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && /\/api\//.test(r.url())) errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`);
    });

    await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    if (/realms|openid-connect|\/auth\//i.test(page.url())) {
      verdict = 'AUTH';
      detail = 'Redirected to Keycloak — session invalid. Run: npm run e2e:auth';
    } else {
      const createBtn = createTid ? page.getByTestId(createTid).first() : null;
      const createSeen = createBtn ? await createBtn.isVisible({ timeout: 8000 }).catch(() => false) : false;
      if (createSeen) await createBtn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000); // form route/dialog + lazy chunk

      const probe = await page.evaluate(({ tids, ctrls }) => {
        const q = (sel) => document.querySelectorAll(sel).length;
        return {
          tidsFound: tids.filter((t) => q(`[data-testid="${t}"]`) > 0),
          ctrlsFound: ctrls.filter((c) => q(`[formcontrolname="${c}"]`) > 0),
          anyTestIds: q('[data-testid]'),
          anyControls: q('[formcontrolname]'),
          inputs: q('input, mat-select, textarea'),
          url: location.href,
          bodySample: (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
        };
      }, { tids: fieldTids, ctrls: controls });

      const shot = path.join(OUT_DIR, `${folder}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

      const tidPct = fieldTids.length ? probe.tidsFound.length / fieldTids.length : 0;
      if (!createSeen && probe.anyTestIds === 0 && probe.inputs < 3) {
        verdict = 'FORM-NOT-RENDERED';
        detail = `List/create UI did not render at ${route} (create button ${createTid}: not found; page says: "${probe.bodySample}")`;
      } else if (tidPct >= 0.8) {
        verdict = 'HEALTHY';
        detail = `${probe.tidsFound.length}/${fieldTids.length} form testids present in live DOM`;
      } else if (probe.ctrlsFound.length > 0 || probe.inputs >= 3) {
        verdict = 'DEPLOYED-BUILD-DRIFT';
        detail = `Form rendered (${probe.inputs} inputs, controls found: ${probe.ctrlsFound.join(',') || 'none'}) but only `
          + `${probe.tidsFound.length}/${fieldTids.length} source testids exist in DOM. `
          + 'The server runs an OLDER build than your source — redeploy capbo-frontend or use your dev build URL.';
      } else {
        verdict = 'FORM-NOT-RENDERED';
        detail = `Reached ${probe.url} but no form appeared (inputs: ${probe.inputs}). Likely a loading gate or failing API on this environment.`;
      }
      if (errors.length) detail += `\n     errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}`;
      detail += `\n     screenshot: generated-e2e/doctor/${folder}.png`;
    }
    await page.close();
  } catch (e) {
    detail = e.message;
  }
  if (verdict !== 'HEALTHY') unhealthy += 1;
  console.log(`\n${verdict === 'HEALTHY' ? '✔' : '✗'} ${feature.padEnd(14)} ${verdict}`);
  console.log(`     ${detail}`);
}

await browser.close();
console.log(unhealthy
  ? `\n${unhealthy} module(s) unhealthy — fix the environment before re-running tests.`
  : '\nAll modules healthy — the live DOM matches your source. Run: npm run e2e:crud -- --headed');
process.exit(unhealthy ? 1 : 0);
