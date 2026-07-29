#!/usr/bin/env node
/**
 * Generate business-rule VALIDATION specs for the pilot modules.
 *
 *   node scripts/generate-ai-validations.mjs                # rules + AI (if key in env)
 *   node scripts/generate-ai-validations.mjs --no-ai        # deterministic rules only
 *   node scripts/generate-ai-validations.mjs --modules vat
 *
 * Division of labor:
 *   - deriveRuleScenarios(): deterministic cases straight from Validators.* metadata
 *   - LLM (ANTHROPIC_API_KEY / GEMINI_API_KEY in .env): extra judgment cases + AC wording
 *   - validateScenarios(): drops anything not backed by the extracted schema
 *   - emitValidationSpec(): testid-grounded Playwright spec, one assertion per AC
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MODULES, buildModuleContext, featureName, llmFromEnv,
} from '../src/lib/automation/moduleDiscovery.js';
import {
  deriveRuleScenarios, buildScenarioPrompt, validateScenarios, emitValidationSpec, SYSTEM_SCENARIOS,
} from '../src/lib/automation/aiScenarios.js';
import { prepareModuleTestCase } from '../src/lib/rag/testCasePipeline.js';
import { callLLM } from '../src/lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FE_ROOT = path.resolve(BACKEND_ROOT, arg('fe', '../capbo-frontend'));
const OUT_DIR = path.resolve(BACKEND_ROOT, arg('out', 'generated-e2e'));
const modules = arg('modules', DEFAULT_MODULES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const useAi = !process.argv.includes('--no-ai');

function extractJSON(text) {
  const cleaned = String(text || '').replace(/```json/gi, '```').replace(/```/g, '');
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  try { return JSON.parse(m ? m[0] : cleaned); } catch { return null; }
}

const llm = useAi ? llmFromEnv() : null;
console.log(`FE root: ${FE_ROOT}`);
console.log(`AI judgment pass: ${llm ? `${llm.provider} (${llm.model})` : useAi ? 'no API key in env → rules-only' : 'disabled (--no-ai)'}`);
console.log('');

let failed = 0;
for (const folder of modules) {
  try {
    const feature = featureName(folder);
    const { codeContext } = buildModuleContext(FE_ROOT, folder);
    const prepared = prepareModuleTestCase({
      codeContext, title: `create a ${feature}`, description: `create a ${feature}`,
      matchedFeature: feature, intent: { action: 'create' },
    });

    // 1. Deterministic core from validator metadata.
    let scenarios = deriveRuleScenarios(prepared.schema).map((s) => ({ ...s, source: 'rules' }));

    // 2. AI judgment pass — proposals are only kept if the schema backs them.
    if (llm) {
      try {
        const raw = await callLLM({
          ...llm,
          system: SYSTEM_SCENARIOS,
          user: buildScenarioPrompt({ feature, schema: prepared.schema, existing: scenarios }),
        });
        const { valid, dropped } = validateScenarios(extractJSON(raw), prepared.schema, scenarios);
        scenarios = [...scenarios, ...valid];
        if (dropped.length) {
          console.log(`   (AI proposed ${valid.length + dropped.length}, grounded ${valid.length}; dropped: ${dropped.map((d) => d.reason).join('; ')})`);
        }
      } catch (e) {
        console.warn(`   (AI pass skipped: ${e.message})`);
      }
    }

    if (!scenarios.length) {
      console.log(`- ${feature}: no rule-based scenarios derivable (no patterns/lengths/ranges) — skipped`);
      continue;
    }

    const { source, stem } = emitValidationSpec({ feature, codeContext, scenarios });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `${stem || folder}-validations.spec.ts`);
    fs.writeFileSync(outFile, source, 'utf8');
    console.log(`✔ ${feature.padEnd(14)} → ${path.relative(BACKEND_ROOT, outFile)} · ${scenarios.length} scenario(s) [${scenarios.map((s) => s.source).filter((v, i, a) => a.indexOf(v) === i).join('+')}]`);
    for (const s of scenarios) console.log(`   - ${s.title}`);
  } catch (e) {
    failed += 1;
    console.error(`✘ ${folder}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
