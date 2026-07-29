#!/usr/bin/env node
/**
 * Failure-feedback loop ("self-healing") for generated specs.
 *
 *   node scripts/heal-spec.mjs currency-crud
 *   node scripts/heal-spec.mjs generated-e2e/eco-tax-crud.spec.ts --headed
 *
 * Loop per attempt:
 *   1. Run the spec (Playwright JSON reporter).
 *   2. On failure, RE-GROUND: re-extract the module schema from the live
 *      frontend source and classify the failure deterministically:
 *        - locator missing but present in source  → deployed-build-drift (advice, no patch can help)
 *        - locator missing from source too        → stale spec → REGENERATE from live code and rerun
 *        - "No selectable dropdown options"       → data dependency (seed record missing)
 *        - login/Keycloak                          → auth session expired
 *   3. Anything unclassified goes to the LLM (if ANTHROPIC_API_KEY / GEMINI_API_KEY
 *      in env) for a diagnosis + suggestion. AI advises — only code-grounded
 *      regeneration ever rewrites the spec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MODULES, buildModuleContext, featureName, llmFromEnv, confirmTestIdFromSharedDialog,
} from '../src/lib/automation/moduleDiscovery.js';
import { buildModuleCrudSpec } from '../src/lib/automation/crudSpec.js';
import { schemaSummary } from '../src/lib/automation/aiScenarios.js';
import { prepareModuleTestCase } from '../src/lib/rag/testCasePipeline.js';
import { extractCodeVocabulary } from '../src/lib/rag/ground.js';
import { callLLM } from '../src/lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(BACKEND_ROOT, 'generated-e2e', 'playwright.config.mjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FE_ROOT = path.resolve(BACKEND_ROOT, arg('fe', '../capbo-frontend'));
const MAX_ATTEMPTS = Number(arg('max', '2'));
const HEADED = process.argv.includes('--headed');

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('Usage: node scripts/heal-spec.mjs <spec-file-or-name> [--headed] [--max 2]');
  process.exit(2);
}
const specPath = fs.existsSync(target)
  ? path.resolve(target)
  : path.join(BACKEND_ROOT, 'generated-e2e', target.endsWith('.spec.ts') ? target : `${target}.spec.ts`);
if (!fs.existsSync(specPath)) {
  console.error(`Spec not found: ${specPath}`);
  process.exit(2);
}

function runSpec() {
  const args = ['playwright', 'test', specPath, '--config', CONFIG, '--reporter=json'];
  if (HEADED) args.push('--headed');
  const res = spawnSync('npx', args, { cwd: BACKEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report = null;
  try {
    const m = String(res.stdout || '').match(/\{[\s\S]*\}\s*$/);
    report = m ? JSON.parse(m[0]) : null;
  } catch { /* non-JSON output */ }
  return { code: res.status ?? 1, report, raw: `${res.stdout || ''}\n${res.stderr || ''}` };
}

function collectFailures(report) {
  const failures = [];
  const walkSuites = (suite, chain = []) => {
    for (const child of suite?.suites || []) walkSuites(child, [...chain, child.title]);
    for (const spec of suite?.specs || []) {
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          if (r.status !== 'passed' && r.status !== 'skipped') {
            failures.push({
              title: [...chain, spec.title].filter(Boolean).join(' › '),
              message: r.error?.message || (r.errors || []).map((e) => e.message).join('\n') || r.status,
            });
          }
        }
      }
    }
  };
  for (const s of report?.suites || []) walkSuites(s, [s.title]);
  return failures;
}

/** Map this spec back to its pages/ folder by matching generated stems. */
function resolveModuleFolder() {
  const base = path.basename(specPath).replace(/-(crud|create|validations)\.spec\.ts$/, '');
  for (const folder of DEFAULT_MODULES) {
    try {
      const { codeContext } = buildModuleContext(FE_ROOT, folder);
      const prepared = prepareModuleTestCase({
        codeContext, title: 'x', description: 'x', matchedFeature: featureName(folder), intent: { action: 'create' },
      });
      if ((prepared.entityStem || folder) === base) return { folder, codeContext, prepared };
    } catch { /* module folder missing — keep looking */ }
  }
  return null;
}

function classify(failure, vocab) {
  const msg = String(failure.message || '');
  const tids = [...msg.matchAll(/getByTestId\('([^']+)'\)/g), ...msg.matchAll(/data-testid="([^"]+)"/g)]
    .map((m) => m[1]);
  if (/Not logged in|realms|Keycloak|login/i.test(msg)) {
    return { category: 'auth', advice: 'Session expired — run: npm run e2e:auth' };
  }
  if (/No selectable dropdown options/i.test(msg)) {
    return {
      category: 'data-dependency',
      advice: 'A dropdown had zero options — the referenced data does not exist on the target (e.g. eco-tax needs a VAT, partners needs a currency). Seed it, or run currency/vat suites first.',
    };
  }
  if (tids.length) {
    const known = tids.filter((t) => (vocab.testIds || []).includes(t));
    if (known.length) {
      return {
        category: 'deployed-build-drift',
        advice: `Locator(s) [${known.join(', ')}] EXIST in the frontend source but were not found in the running app — `
          + 'the deployed build at TARGET_APP_URL is older than your code. Redeploy capbo-frontend or point TARGET_APP_URL at your dev build. Regenerating tests cannot fix this.',
      };
    }
    return {
      category: 'stale-spec',
      advice: `Locator(s) [${tids.join(', ')}] no longer exist in the source — spec is stale. Regenerating from live code.`,
      regenerate: true,
    };
  }
  if (/toBeEnabled|save must enable/i.test(msg)) {
    return {
      category: 'form-invalid',
      advice: 'Save stayed disabled — a required control was not satisfied. Regenerating from live code in case the form changed.',
      regenerate: true,
    };
  }
  return { category: 'unknown', advice: null };
}

async function aiDiagnose(failure, prepared) {
  const llm = llmFromEnv();
  if (!llm) return null;
  const system = 'You are a senior QA engineer diagnosing ONE Playwright test failure. '
    + 'Use ONLY the given error, spec source and form schema. Return ONLY JSON: '
    + '{"rootCause":"...","category":"app-bug|timing|data|selector|environment","suggestion":"..."} — no invented selectors.';
  const user = `FAILED TEST: ${failure.title}\nERROR:\n${String(failure.message).slice(0, 3000)}\n\n`
    + `SPEC SOURCE (truncated):\n${fs.readFileSync(specPath, 'utf8').slice(0, 6000)}\n\n`
    + `FORM SCHEMA:\n${JSON.stringify(schemaSummary(prepared.schema), null, 1)}`;
  try {
    const raw = await callLLM({ ...llm, system, user });
    const m = String(raw).replace(/```json/gi, '```').replace(/```/g, '').match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn(`(AI diagnosis unavailable: ${e.message})`);
    return null;
  }
}

function regenerate(mod) {
  const confirmTestId = confirmTestIdFromSharedDialog(FE_ROOT);
  const { source } = buildModuleCrudSpec({
    codeContext: mod.codeContext,
    feature: featureName(mod.folder),
    options: { confirmTestId },
  });
  fs.writeFileSync(specPath, source, 'utf8');
  console.log(`↻ Regenerated ${path.relative(BACKEND_ROOT, specPath)} from live code.`);
}

console.log(`Heal loop: ${path.relative(BACKEND_ROOT, specPath)} (max ${MAX_ATTEMPTS} attempt(s))\n`);

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`— Attempt ${attempt}: running…`);
  const { code, report } = runSpec();
  const failures = report ? collectFailures(report) : [];
  if (code === 0 && !failures.length) {
    console.log('✔ All tests passed.');
    process.exit(0);
  }
  if (!failures.length) {
    console.error('✘ Run failed before any test executed (config/env issue). Check TARGET_APP_URL and auth.');
    process.exit(1);
  }

  const mod = resolveModuleFolder();
  const vocab = mod ? extractCodeVocabulary(mod.codeContext) : { testIds: [] };
  let wantsRegen = false;

  for (const f of failures) {
    console.log(`\n✘ ${f.title}`);
    console.log(`  ${String(f.message).split('\n')[0]}`);
    const c = classify(f, vocab);
    console.log(`  → ${c.category}${c.advice ? `: ${c.advice}` : ''}`);
    if (c.regenerate) wantsRegen = true;
    if (c.category === 'unknown' && mod) {
      const diag = await aiDiagnose(f, mod.prepared);
      if (diag) console.log(`  → AI: [${diag.category}] ${diag.rootCause} — ${diag.suggestion}`);
    }
    if (c.category === 'deployed-build-drift' || c.category === 'auth' || c.category === 'data-dependency') {
      console.log('\nStopping: this failure class cannot be fixed by regenerating tests.');
      process.exit(1);
    }
  }

  if (wantsRegen && mod && attempt < MAX_ATTEMPTS) {
    regenerate(mod);
    continue;
  }
  console.log('\n✘ Still failing after heal attempts — see diagnoses above.');
  process.exit(1);
}
