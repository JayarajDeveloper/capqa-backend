/**
 * Emits machine-readable step markers for Nocta Compose run log formatting.
 * Only surfaces meaningful test.step() titles — not Playwright internals
 * (Wait for timeout, Expect …, Fixture …) that flood Background live logs.
 * @type {import('@playwright/test').Reporter}
 */

const NOISE = /^(Wait for timeout|Expect |Fixture |Before Hooks|After Hooks|Worker Cleanup|Attach |Browser |Context |Page\.|Locator\.|Mouse\.|Keyboard\.|Clock\.|Tracing)/i;

function isMeaningfulStep(step) {
  if (!step) return false;
  const title = String(step.title || '').trim();
  if (!title || NOISE.test(title)) return false;
  // Prefer explicit test.step(); also keep top-level api actions that look like user steps
  const cat = String(step.category || '');
  if (cat === 'test.step') return true;
  if (cat === 'hook' || cat === 'fixture') return false;
  // Skip nested pw:api noise (waitForTimeout, etc.)
  if (cat === 'pw:api') return false;
  // Unknown categories: keep only if title looks like our compose steps
  return /^(Navigate|Fill|Select|Click|Verify|Search|Establish|POST|GET|PUT|PATCH|DELETE|SQL|API)/i.test(title);
}

export default class NoctaStepReporter {
  onStepBegin(_test, _result, step) {
    if (!isMeaningfulStep(step)) return;
    const title = String(step?.title || '').replace(/\|/g, '/');
    process.stdout.write(`NOCTA_STEP_BEGIN|${title}\n`);
  }

  onStepEnd(_test, _result, step) {
    if (!isMeaningfulStep(step)) return;
    const title = String(step?.title || '').replace(/\|/g, '/');
    const status = step?.error ? 'fail' : 'pass';
    const duration = Math.round(step?.duration ?? 0);
    const err = step?.error?.message
      ? String(step.error.message).split('\n')[0].slice(0, 240).replace(/\|/g, '/')
      : '';
    process.stdout.write(`NOCTA_STEP_END|${title}|${status}|${duration}|${err}\n`);
  }

  onTestEnd(test, result) {
    const title = String(test?.title || '').replace(/\|/g, '/');
    process.stdout.write(`NOCTA_TEST_END|${title}|${result.status}|${Math.round(result.duration ?? 0)}\n`);
  }
}
