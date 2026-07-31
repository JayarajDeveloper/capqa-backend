/**
 * Professional step-by-step Playwright run log for Compose UI.
 */

const BAR = '─'.repeat(54);
const DBAR = '═'.repeat(54);

function padRight(s, n) {
  const t = String(s || '');
  return t.length >= n ? `${t.slice(0, n - 1)}…` : t + ' '.repeat(n - t.length);
}

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function statusIcon(status) {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '✗';
  if (status === 'skip' || status === 'skipped') return '○';
  return '·';
}

/** Parse NOCTA_STEP_* markers from Playwright stdout/stderr. */
export function parseNoctaStepMarkers(text = '') {
  const steps = [];
  const open = new Map();
  const isNoise = (title) => /^(Wait for timeout|Expect |Fixture |Before Hooks|After Hooks)/i.test(title);
  for (const line of String(text).split('\n')) {
    if (line.startsWith('NOCTA_STEP_BEGIN|')) {
      const title = line.slice('NOCTA_STEP_BEGIN|'.length).trim();
      if (isNoise(title)) continue;
      open.set(title, { title, status: 'running', durationMs: null, error: null });
    } else if (line.startsWith('NOCTA_STEP_END|')) {
      const parts = line.slice('NOCTA_STEP_END|'.length).split('|');
      if (parts.length >= 3) {
        const title = parts[0].trim();
        if (isNoise(title)) continue;
        const status = parts[1] === 'fail' ? 'fail' : 'pass';
        const durationMs = Number(parts[2]);
        const error = parts.slice(3).join('|').trim() || null;
        steps.push({
          title,
          status,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          error,
        });
        open.delete(title);
      }
    }
  }
  return steps;
}

/** Incremental parser for NOCTA_STEP_* lines while Playwright runs. */
export function createLiveStepTracker({
  onProgress = null,
  logToConsole = false,
  modeLabel = 'background',
} = {}) {
  let buffer = '';
  const steps = [];
  let nextId = 0;

  const isNoiseTitle = (title) => /^(Wait for timeout|Expect |Fixture |Before Hooks|After Hooks)/i.test(String(title || ''));

  const emit = (payload) => {
    onProgress?.(payload);
    if (!logToConsole) return;
    const prefix = `[Cap QA · ${modeLabel}]`;
    if (payload.type === 'stepBegin') {
      console.log(`${prefix} … ${payload.step.title}`);
    } else if (payload.type === 'stepEnd') {
      const icon = payload.step.status === 'fail' ? '✗' : '✓';
      const dur = formatMs(payload.step.durationMs);
      console.log(`${prefix} ${icon} ${payload.step.title}  ${dur}`);
      if (payload.step.error) console.log(`${prefix}    ↳ ${payload.step.error}`);
    }
  };

  const feed = (chunk = '') => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('NOCTA_STEP_BEGIN|')) {
        const title = line.slice('NOCTA_STEP_BEGIN|'.length).trim();
        if (isNoiseTitle(title)) continue;
        const step = { id: ++nextId, title, status: 'running', durationMs: null, error: null };
        steps.push(step);
        emit({ type: 'stepBegin', step, steps: steps.map((s) => ({ ...s })) });
      } else if (line.startsWith('NOCTA_STEP_END|')) {
        const parts = line.slice('NOCTA_STEP_END|'.length).split('|');
        if (parts.length < 3) continue;
        const title = parts[0].trim();
        if (isNoiseTitle(title)) continue;
        const status = parts[1] === 'fail' ? 'fail' : 'pass';
        const durationMs = Number(parts[2]);
        const error = parts.slice(3).join('|').trim() || null;
        const idx = steps.findIndex((s) => s.title === title && s.status === 'running');
        const step = {
          id: idx >= 0 ? steps[idx].id : ++nextId,
          title,
          status,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          error,
        };
        if (idx >= 0) steps[idx] = step;
        else steps.push(step);
        emit({ type: 'stepEnd', step, steps: steps.map((s) => ({ ...s })) });
      }
    }
  };

  return { feed, getSteps: () => steps.map((s) => ({ ...s })) };
}

/** Fallback: infer steps from spec // comments + failure line number. */
export function parseSpecCommentSteps(specSource = '') {
  const steps = [];
  const lines = String(specSource).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\/\/\s*(.+)\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
    if (j < lines.length && /^\s*await /.test(lines[j])) {
      steps.push({ title: m[1].trim(), line: j + 1, status: 'pending', durationMs: null, error: null });
    }
  }
  if (!steps.length && /ensureCapboSession/.test(specSource)) {
    steps.push({ title: 'Establish authenticated CapBO session', line: 1, status: 'pending', durationMs: null, error: null });
  }
  return steps;
}

export function inferFailureLine(text = '') {
  const m = String(text).match(/\.spec\.(?:ts|js|mjs):(\d+):(\d+)/);
  return m ? Number(m[1]) : null;
}

export function applyFailureToSpecSteps(steps, failLine, errorMessage) {
  if (!steps.length || !failLine) return steps;
  let failedIdx = steps.findIndex((s, i) => {
    const nextLine = steps[i + 1]?.line ?? Infinity;
    return failLine >= s.line && failLine < nextLine;
  });
  if (failedIdx < 0) {
    failedIdx = steps.findIndex((s) => s.line >= failLine);
  }
  if (failedIdx < 0) failedIdx = steps.length - 1;

  return steps.map((s, i) => {
    if (i < failedIdx) return { ...s, status: 'pass' };
    if (i === failedIdx) return { ...s, status: 'fail', error: errorMessage || s.error };
    return { ...s, status: 'skip' };
  });
}

function extractErrorSummary(text = '') {
  const lines = String(text).split('\n');
  const err = lines.find((l) => /TimeoutError|Error:|expect\(/.test(l));
  return err?.trim().slice(0, 200) || null;
}

/**
 * Build structured steps + professional monospace log.
 */
export function buildProfessionalRunLog({
  specPath = '',
  baseUrl = '',
  passed = false,
  durationMs = 0,
  stdout = '',
  stderr = '',
  specSource = '',
  testTitle = '',
  headless = false,
  runMode = null,
} = {}) {
  const combined = `${stdout}\n${stderr}`;
  let steps = parseNoctaStepMarkers(combined);

  if (!steps.length && specSource) {
    const specSteps = parseSpecCommentSteps(specSource);
    const failLine = inferFailureLine(combined);
    const err = extractErrorSummary(combined);
    if (passed) {
      steps = specSteps.map((s) => ({ ...s, status: 'pass' }));
    } else {
      steps = applyFailureToSpecSteps(specSteps, failLine, err);
    }
  }

  const testEnd = combined.match(/NOCTA_TEST_END\|([^|]+)\|(\w+)\|(\d+)/);
  const resolvedTitle = testTitle || testEnd?.[1] || 'UI test';
  const passedCount = steps.filter((s) => s.status === 'pass').length;
  const failedCount = steps.filter((s) => s.status === 'fail').length;
  const skippedCount = steps.filter((s) => s.status === 'skip' || s.status === 'skipped').length;

  const out = [];
  out.push(DBAR);
  out.push('  Cap QA · Playwright E2E');
  out.push(DBAR);
  if (specPath) out.push(`  Spec     ${specPath}`);
  if (baseUrl) out.push(`  Target   ${baseUrl}`);
  out.push('  Engine   playwright-cli');
  const modeLabel = runMode === 'background' || headless
    ? 'Background (headless)'
    : 'Foreground (headed)';
  out.push(`  Mode     ${modeLabel}`);
  out.push('');
  out.push(BAR);
  out.push(`  Test     ${resolvedTitle}`);
  out.push(BAR);
  out.push('');

  if (steps.length) {
    const w = String(steps.length).length;
    steps.forEach((s, i) => {
      const num = String(i + 1).padStart(w, '0');
      const icon = statusIcon(s.status);
      const dur = formatMs(s.durationMs);
      out.push(`  ${icon}  ${num}  ${padRight(s.title, 42)}  ${dur}`);
      if (s.status === 'fail' && s.error) {
        out.push(`         ↳ ${s.error}`);
      }
    });
  } else {
    out.push('  (no step markers — raw Playwright output below)');
    out.push('');
    const summary = combined.split('\n').filter((l) => l.trim() && !l.startsWith('NOCTA_')).slice(-12);
    for (const l of summary) out.push(`  ${l}`);
  }

  out.push('');
  out.push(BAR);
  const resultWord = passed ? 'PASSED' : 'FAILED';
  const tally = steps.length
    ? `${passedCount}/${steps.length} steps`
    : passed ? '1/1 tests' : '0/1 tests';
  const extra = failedCount ? ` · ${failedCount} failed` : '';
  const skip = skippedCount ? ` · ${skippedCount} skipped` : '';
  out.push(`  Result   ${resultWord} · ${tally}${extra}${skip} · ${formatMs(durationMs)}`);
  out.push(DBAR);

  return {
    log: out.join('\n'),
    runSteps: steps.map((s, i) => ({ id: i + 1, ...s })),
    passedCount,
    failedCount,
    skippedCount,
  };
}
