/**
 * Suites + Test Reports API.
 */
import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { publicRun } from '../lib/reports/persistRun.js';
import { resolveArtifactAbs } from '../lib/reports/artifacts.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.param('projectId', async (req, res, next, projectId) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.user.id, orgId: project.orgId } },
  });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  req.project = project;
  next();
});

function publicSuite(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    feature: s.feature,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    caseCount: s._count?.cases ?? s.cases?.length ?? 0,
    runCount: s._count?.runs ?? 0,
    cases: Array.isArray(s.cases)
      ? s.cases.map((c) => ({
        id: c.id,
        title: c.title,
        kind: c.kind,
        feature: c.feature,
        priority: c.priority,
        type: c.type,
        sortOrder: c.sortOrder,
        askTitle: c.askTitle,
        askDescription: c.askDescription,
        hasAutomation: !!c.automation,
        acceptanceCriteria: c.acceptanceCriteria,
        automation: c.automation,
      }))
      : undefined,
  };
}

// ——— Suites ———

reportsRouter.get('/projects/:projectId/suites', async (req, res) => {
  const suites = await prisma.testSuite.findMany({
    where: { projectId: req.project.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { cases: true, runs: true } } },
  });
  res.json({ suites: suites.map(publicSuite) });
});

reportsRouter.post('/projects/:projectId/suites', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Suite name required' });
  const suite = await prisma.testSuite.create({
    data: {
      projectId: req.project.id,
      name,
      description: req.body?.description || null,
      feature: req.body?.feature || null,
    },
    include: { _count: { select: { cases: true, runs: true } } },
  });
  res.status(201).json({ suite: publicSuite(suite) });
});

reportsRouter.get('/projects/:projectId/suites/:suiteId', async (req, res) => {
  const suite = await prisma.testSuite.findFirst({
    where: { id: req.params.suiteId, projectId: req.project.id },
    include: {
      cases: { orderBy: { sortOrder: 'asc' } },
      _count: { select: { cases: true, runs: true } },
    },
  });
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  res.json({ suite: publicSuite(suite) });
});

reportsRouter.delete('/projects/:projectId/suites/:suiteId', async (req, res) => {
  const suite = await prisma.testSuite.findFirst({
    where: { id: req.params.suiteId, projectId: req.project.id },
  });
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  await prisma.testSuite.delete({ where: { id: suite.id } });
  res.status(204).end();
});

/** Save Compose draft as a case inside a suite (create suite if needed). */
reportsRouter.post('/projects/:projectId/suites/save-case', async (req, res) => {
  const {
    suiteId,
    suiteName,
    title,
    kind = 'ui',
    feature,
    askTitle,
    askDescription,
    priority,
    type,
    acceptanceCriteria,
    automation,
  } = req.body || {};

  const caseTitle = String(title || askTitle || feature || 'Untitled case').trim();
  if (!caseTitle) return res.status(400).json({ error: 'Case title required' });

  let suite;
  if (suiteId) {
    suite = await prisma.testSuite.findFirst({
      where: { id: suiteId, projectId: req.project.id },
    });
    if (!suite) return res.status(404).json({ error: 'Suite not found' });
  } else {
    const name = String(suiteName || feature || 'Compose suite').trim() || 'Compose suite';
    suite = await prisma.testSuite.create({
      data: {
        projectId: req.project.id,
        name,
        feature: feature || null,
      },
    });
  }

  const maxOrder = await prisma.testCase.aggregate({
    where: { suiteId: suite.id },
    _max: { sortOrder: true },
  });

  const testCase = await prisma.testCase.create({
    data: {
      suiteId: suite.id,
      title: caseTitle,
      kind: ['ui', 'api', 'database'].includes(kind) ? kind : 'ui',
      feature: feature || null,
      askTitle: askTitle || null,
      askDescription: askDescription || null,
      priority: priority || null,
      type: type || null,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      acceptanceCriteria: acceptanceCriteria || null,
      automation: automation || null,
    },
  });

  await prisma.testSuite.update({
    where: { id: suite.id },
    data: { updatedAt: new Date() },
  });

  res.status(201).json({
    suite: { id: suite.id, name: suite.name },
    case: {
      id: testCase.id,
      title: testCase.title,
      kind: testCase.kind,
      suiteId: suite.id,
    },
  });
});

reportsRouter.delete('/projects/:projectId/suites/:suiteId/cases/:caseId', async (req, res) => {
  const testCase = await prisma.testCase.findFirst({
    where: {
      id: req.params.caseId,
      suiteId: req.params.suiteId,
      suite: { projectId: req.project.id },
    },
  });
  if (!testCase) return res.status(404).json({ error: 'Case not found' });
  await prisma.testCase.delete({ where: { id: testCase.id } });
  res.status(204).end();
});

// ——— Reports ———

reportsRouter.get('/projects/:projectId/reports', async (req, res) => {
  const take = Math.min(Number(req.query.limit) || 40, 100);
  const suiteId = req.query.suiteId || undefined;
  const status = req.query.status || undefined;
  const kind = req.query.kind || undefined;

  const runs = await prisma.testRun.findMany({
    where: {
      projectId: req.project.id,
      parentRunId: null, // top-level only
      ...(suiteId ? { suiteId } : {}),
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      suite: { select: { id: true, name: true } },
      case: { select: { id: true, title: true } },
      artifacts: true,
      _count: { select: { childRuns: true } },
    },
  });

  res.json({
    reports: runs.map((r) => ({
      ...publicRun(r),
      childCount: r._count?.childRuns || 0,
    })),
  });
});

reportsRouter.get('/projects/:projectId/reports/:runId', async (req, res) => {
  const run = await prisma.testRun.findFirst({
    where: { id: req.params.runId, projectId: req.project.id },
    include: {
      suite: { select: { id: true, name: true } },
      case: { select: { id: true, title: true } },
      artifacts: true,
      childRuns: {
        orderBy: { createdAt: 'asc' },
        include: { artifacts: true, case: { select: { id: true, title: true } } },
      },
    },
  });
  if (!run) return res.status(404).json({ error: 'Report not found' });
  res.json({ report: publicRun(run) });
});

reportsRouter.get('/projects/:projectId/reports/:runId/artifacts/:artifactId', async (req, res) => {
  const art = await prisma.runArtifact.findFirst({
    where: {
      id: req.params.artifactId,
      runId: req.params.runId,
      run: { projectId: req.project.id },
    },
    include: { run: { select: { projectId: true } } },
  });
  if (!art) return res.status(404).json({ error: 'Artifact not found' });
  try {
    const abs = resolveArtifactAbs(art.relativePath);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', art.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${art.fileName}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad artifact path' });
  }
});
