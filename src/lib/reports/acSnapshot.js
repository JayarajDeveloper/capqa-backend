/**
 * Map acceptance criteria → pass/fail/pending from a run result (server-side snapshot).
 * Mirrors capqa-frontend/src/lib/acRunStatus.js so reports stay stable after save.
 */

const AC_PHASE_ORDER = ['navigate', 'form', 'save', 'verify'];

function acPhaseForItem(ac, index) {
  const req = String(ac?.requirement || '').toLowerCase();
  if (/screen opens|flow can start|reachable|list opens|can start|table exists|schema|migration/i.test(req)) {
    return /table exists|schema|migration|column/i.test(req) ? 'verify' : 'navigate';
  }
  if (/form data|form fields|entered|dropdown|filled|required form|completed/i.test(req)) return 'form';
  if (/save|submit|saved successfully/i.test(req)) return 'save';
  if (/appears in the list|after save|visible in|record appears|updated record|column|ddl/i.test(req)) return 'verify';
  if (/deleted|removed|can be delete/i.test(req)) return 'verify';
  return AC_PHASE_ORDER[Math.min(index, AC_PHASE_ORDER.length - 1)] || 'form';
}

function inferFailurePhaseFromLog(log = '', runSteps = []) {
  const failedStep = (runSteps || []).find((s) => s.status === 'fail');
  if (failedStep?.title) {
    const t = String(failedStep.title).toLowerCase();
    if (/verify|appears in|list|displayed|column|migration|schema|table/i.test(t)) return 'verify';
    if (/save|submit|create the/i.test(t)) return 'save';
    if (/enter|fill|field|dropdown/i.test(t)) return 'form';
    if (/navigate|session|open/i.test(t)) return 'navigate';
  }
  const low = String(log).toLowerCase();
  if (/column|schema|migration|table exists/i.test(low)) return 'verify';
  if (/verifyinlist|appears in list/i.test(low)) return 'verify';
  if (/-save['"]\)|tobeenabled.*save/i.test(low)) return 'save';
  if (/selectmatdropdown|fillangularfield/i.test(low)) return 'form';
  if (/spanavigate|ensure(?:target)?session/i.test(low)) return 'navigate';
  return 'form';
}

/**
 * @param {Array<{id?: string, requirement?: string}>} acs
 * @param {{ passed?: boolean, skipped?: boolean, log?: string, runSteps?: any[] }} result
 */
export function buildAcResults(acs, result) {
  const list = Array.isArray(acs) ? acs : [];
  if (!list.length) return [];

  if (!result || result.skipped) {
    return list.map((a, i) => ({
      id: a.id || `AC-${i + 1}`,
      requirement: a.requirement || String(a),
      status: 'pending',
      evidence: null,
    }));
  }

  if (result.passed) {
    return list.map((a, i) => ({
      id: a.id || `AC-${i + 1}`,
      requirement: a.requirement || String(a),
      status: 'pass',
      evidence: 'Run passed',
    }));
  }

  // Database / step-level: map failed step points onto last AC if only one phase
  const failPhase = inferFailurePhaseFromLog(result.log || '', result.runSteps || []);
  const failIdx = AC_PHASE_ORDER.indexOf(failPhase);
  const failedStep = (result.runSteps || []).find((s) => s.status === 'fail');
  const evidence = failedStep
    ? `${failedStep.title}${failedStep.detail ? ` — ${failedStep.detail}` : ''}`
    : null;

  return list.map((a, i) => {
    const phase = acPhaseForItem(a, i);
    const phaseIdx = AC_PHASE_ORDER.indexOf(phase);
    let status = 'pending';
    if (phaseIdx < failIdx) status = 'pass';
    else if (phaseIdx === failIdx) status = 'fail';
    return {
      id: a.id || `AC-${i + 1}`,
      requirement: a.requirement || String(a),
      status,
      evidence: status === 'fail' ? evidence : status === 'pass' ? 'Reached before failure' : 'Not reached',
    };
  });
}

/** When no AC list: synthesize points from runSteps (DB schema checks). */
export function acFromRunSteps(runSteps = []) {
  return (runSteps || []).map((s, i) => ({
    id: `STEP-${i + 1}`,
    requirement: s.title || s.description || `Step ${i + 1}`,
    status: s.status === 'pass' ? 'pass' : s.status === 'fail' ? 'fail' : s.status === 'skip' ? 'pending' : 'pending',
    evidence: Array.isArray(s.points) && s.points.length
      ? s.points.slice(0, 8).join(' · ')
      : (s.detail || s.error || null),
  }));
}
