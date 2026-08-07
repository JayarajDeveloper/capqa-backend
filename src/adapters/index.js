/**
 * Adapter registry. Framework/stack conventions live in packs under this
 * directory and nowhere else; the zero-hardcode gate exempts this folder for
 * exactly that reason (see scripts/check-no-hardcode.mjs).
 */
import { adapter as symfonyAngular } from './symfony-angular.js';

const PACKS = { [symfonyAngular.id]: symfonyAngular };
const DEFAULT_ID = symfonyAngular.id;

export function resolveAdapter(id = process.env.CAPQA_TARGET_ADAPTER) {
  const pack = PACKS[id || DEFAULT_ID];
  if (!pack) {
    throw new Error(`Unknown target adapter "${id}". Available: ${Object.keys(PACKS).join(', ')}`);
  }
  return pack;
}

export const targetAdapter = resolveAdapter();

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `['a','b']` -> `a|b`, escaped for use inside a RegExp. */
export function alternation(list) {
  return (list || []).map(escape).join('|');
}

/**
 * Target-specific modules to deprioritise during retrieval, supplied by
 * configuration rather than named in engine code.
 *   CAPQA_NOISE_PATHS="CodebaseKnowledge,JiraTestRunner,EanCode"
 */
export function extraNoisePaths() {
  return String(process.env.CAPQA_NOISE_PATHS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Compile the adapter's pathScores once. */
export function pathScoreRules(pack = targetAdapter) {
  return (pack.pathScores || []).map(([src, flags, delta]) => ({ re: new RegExp(src, flags), delta }));
}
