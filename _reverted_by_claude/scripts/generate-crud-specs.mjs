#!/usr/bin/env node
/**
 * Generate metadata-driven CRUD specs for CapBO modules straight from the LIVE
 * frontend source on disk — no DB, no GitLab, no LLM. Deterministic.
 *
 *   node scripts/generate-crud-specs.mjs
 *   node scripts/generate-crud-specs.mjs --modules vat,eco-tax
 *   node scripts/generate-crud-specs.mjs --fe ../capbo-frontend --out generated-e2e
 *
 * Nothing module-specific is hardcoded (see src/lib/automation/moduleDiscovery.js):
 * folders are discovered, templates matched by *-list convention, and the
 * delete-confirm testid is parsed from the shared confirmation component.
 * The default --modules value is the current 5-module pilot scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModuleCrudSpec } from '../src/lib/automation/crudSpec.js';
import {
  DEFAULT_MODULES, buildModuleContext, featureName, confirmTestIdFromSharedDialog,
} from '../src/lib/automation/moduleDiscovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FE_ROOT = path.resolve(BACKEND_ROOT, arg('fe', '../capbo-frontend'));
const OUT_DIR = path.resolve(BACKEND_ROOT, arg('out', 'generated-e2e'));
const modules = arg('modules', DEFAULT_MODULES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const confirmTestId = confirmTestIdFromSharedDialog(FE_ROOT);
console.log(`FE root: ${FE_ROOT}`);
console.log(`Confirm-dialog testid: ${confirmTestId || '(none found — role fallback will be used)'}`);
console.log('');

let failed = 0;
for (const folder of modules) {
  try {
    const { codeContext } = buildModuleContext(FE_ROOT, folder);
    const feature = featureName(folder);
    const { source, meta } = buildModuleCrudSpec({ codeContext, feature, options: { confirmTestId } });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `${meta.stem || folder}-crud.spec.ts`);
    fs.writeFileSync(outFile, source, 'utf8');

    const tests = Object.entries(meta.tests).filter(([, on]) => on).map(([k]) => k).join(', ');
    console.log(`✔ ${feature.padEnd(14)} → ${path.relative(BACKEND_ROOT, outFile)}`);
    console.log(`   route ${meta.route} · fields ${meta.fields.length} (required: ${meta.requiredFields.join(', ') || '—'})`);
    console.log(`   tests: ${tests}`);
  } catch (e) {
    failed += 1;
    console.error(`✘ ${folder}: ${e.message}`);
  }
}

process.exit(failed ? 1 : 0);
