/**
 * Persist a TestRun report (+ optional AC + artifacts).
 */
import { prisma } from '../../db.js';
import { buildAcResults, acFromRunSteps } from './acSnapshot.js';
import { archivePlaywrightArtifacts, writeTextArtifact } from './artifacts.js';

function runStatus(result) {
  if (result?.skipped) return 'skipped';
  if (result?.passed) return 'passed';
  return 'failed';
}

function countsFromResult(result) {
  const summary = result?.runSummary || {};
  if (summary.total != null) {
    return {
      passed: Number(summary.passed) || 0,
      failed: Number(summary.failed) || 0,
      skipped: Number(summary.skipped) || 0,
    };
  }
  if (result?.skipped) return { passed: 0, failed: 0, skipped: 1 };
  return result?.passed
    ? { passed: 1, failed: 0, skipped: 0 }
    : { passed: 0, failed: 1, skipped: 0 };
}

/**
 * Save an immutable report after a Compose / Regression / Database run.
 */
export async function persistTestRun({
  projectId,
  result,
  meta = {},
}) {
  const {
    label,
    kind = result?.kind || 'ui',
    suiteId = null,
    caseId = null,
    parentRunId = null,
    askTitle = null,
    feature = null,
    acceptanceCriteria = null,
    collectArtifacts = true,
    runStartedAt = null,
  } = meta;

  const counts = countsFromResult(result);
  let acResults = buildAcResults(acceptanceCriteria || [], result);
  if (!acResults.length && Array.isArray(result?.runSteps) && result.runSteps.length) {
    acResults = acFromRunSteps(result.runSteps);
  }

  const run = await prisma.testRun.create({
    data: {
      projectId,
      suiteId: suiteId || null,
      caseId: caseId || null,
      parentRunId: parentRunId || null,
      label: label || `${kind} run`,
      kind: kind === 'database' || kind === 'api' || kind === 'suite' ? kind : (result?.kind || 'ui'),
      status: runStatus(result),
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      durationMs: Number(result?.durationMs) || 0,
      askTitle: askTitle || null,
      feature: feature || result?.feature || null,
      runMode: result?.runMode || null,
      log: typeof result?.log === 'string' ? result.log.slice(0, 200_000) : null,
      runSteps: result?.runSteps || null,
      runSummary: result?.runSummary || null,
      acResults,
      specPath: result?.relativePath || result?.specPath || null,
    },
  });

  const artifactRows = [];

  if (collectArtifacts && (kind === 'ui' || kind === 'api' || result?.engine?.includes?.('playwright'))) {
    const sinceMs = runStartedAt ? Number(runStartedAt) - 5000 : Date.now() - 20 * 60 * 1000;
    try {
      const files = await archivePlaywrightArtifacts({
        projectId,
        runId: run.id,
        sinceMs,
      });
      for (const f of files) {
        artifactRows.push(await prisma.runArtifact.create({
          data: { runId: run.id, ...f },
        }));
      }
    } catch (e) {
      console.warn('[reports] artifact archive failed:', e.message);
    }
  }

  // Always keep a log file for reopen
  if (result?.log) {
    try {
      const logArt = await writeTextArtifact({
        projectId,
        runId: run.id,
        fileName: 'run.log',
        content: result.log,
        type: 'log',
      });
      artifactRows.push(await prisma.runArtifact.create({
        data: { runId: run.id, ...logArt },
      }));
    } catch { /* optional */ }
  }

  return {
    ...run,
    artifacts: artifactRows,
  };
}

export function publicRun(run) {
  if (!run) return null;
  const projectId = run.projectId;
  return {
    id: run.id,
    projectId,
    label: run.label,
    kind: run.kind,
    status: run.status,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped,
    durationMs: run.durationMs,
    askTitle: run.askTitle,
    feature: run.feature,
    runMode: run.runMode,
    log: run.log,
    runSteps: run.runSteps,
    runSummary: run.runSummary,
    acResults: run.acResults,
    specPath: run.specPath,
    createdAt: run.createdAt,
    suiteId: run.suiteId,
    caseId: run.caseId,
    parentRunId: run.parentRunId,
    suite: run.suite ? { id: run.suite.id, name: run.suite.name } : undefined,
    case: run.case ? { id: run.case.id, title: run.case.title } : undefined,
    artifacts: (run.artifacts || []).map((a) => ({
      id: a.id,
      type: a.type,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      url: projectId
        ? `/api/projects/${projectId}/reports/${run.id}/artifacts/${a.id}`
        : null,
    })),
    childRuns: Array.isArray(run.childRuns)
      ? run.childRuns.map((c) => publicRun({ ...c, projectId: c.projectId || projectId }))
      : undefined,
  };
}
