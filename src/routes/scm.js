import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import * as GL from '../lib/scm/gitlab.js';
import * as JR from '../lib/scm/jira.js';
import { recoverStaleIndexes } from '../lib/rag/indexer.js';

// Mounted at /api. Routes carry the full /projects/:projectId/... path.
export const scmRouter = Router();
scmRouter.use(requireAuth);

// Resolve + authorize the project for any route that has :projectId.
scmRouter.param('projectId', async (req, res, next, projectId) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.user.id, orgId: project.orgId } },
  });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  req.project = project;
  next();
});

const publicConnector = (c) => ({ id: c.id, provider: c.provider, baseUrl: c.baseUrl, accountName: c.accountName, email: c.email, createdAt: c.createdAt });
const publicRepo = (r) => ({
  id: r.id, provider: r.provider, name: r.name, key: r.key, branch: r.branch, webUrl: r.webUrl,
  language: r.language, summary: r.summary, files: r.files || [], active: r.active, connectorId: r.connectorId,
  index: r.index ? {
    status: r.index.status,
    fileCount: r.index.fileCount,
    chunkCount: r.index.chunkCount,
    error: r.index.error,
    updatedAt: r.index.updatedAt,
  } : { status: 'pending', fileCount: 0, chunkCount: 0, error: null, updatedAt: null },
});
const tokenOf = (c) => decrypt(c.tokenCipher);

function scmError(res, e) {
  const status = e.status && e.status >= 400 && e.status < 600 ? 502 : 500;
  return res.status(status).json({ error: e.message || 'SCM request failed' });
}

/* ---- Connectors ---- */

scmRouter.get('/projects/:projectId/connectors', async (req, res) => {
  const cs = await prisma.connector.findMany({ where: { projectId: req.project.id } });
  res.json(cs.map(publicConnector));
});

// Create or update the connector for a provider (verifies credentials first).
scmRouter.post('/projects/:projectId/connectors', async (req, res) => {
  const { provider, baseUrl, token, email } = req.body || {};
  if (!provider || !baseUrl || !token) return res.status(400).json({ error: 'provider, baseUrl and token are required' });

  let accountName;
  try {
    if (provider === 'GITLAB') accountName = (await GL.verifyAccount(baseUrl, token)).name;
    else if (provider === 'JIRA') {
      if (!email) return res.status(400).json({ error: 'email is required for Jira' });
      accountName = (await JR.verifyAccount(baseUrl, email, token)).name;
    } else return res.status(400).json({ error: 'Unsupported provider' });
  } catch (e) { return scmError(res, e); }

  const data = { provider, baseUrl, accountName, email: email || null, tokenCipher: encrypt(token) };
  const connector = await prisma.connector.upsert({
    where: { projectId_provider: { projectId: req.project.id, provider } },
    update: data,
    create: { ...data, projectId: req.project.id },
  });
  res.status(201).json(publicConnector(connector));
});

scmRouter.delete('/projects/:projectId/connectors/:id', async (req, res) => {
  const c = await prisma.connector.findFirst({ where: { id: req.params.id, projectId: req.project.id } });
  if (!c) return res.status(404).json({ error: 'Connector not found' });
  await prisma.connector.delete({ where: { id: c.id } });
  res.status(204).end();
});

// Browse GitLab projects for a connector.
scmRouter.get('/projects/:projectId/connectors/:id/projects', async (req, res) => {
  const c = await prisma.connector.findFirst({ where: { id: req.params.id, projectId: req.project.id } });
  if (!c || c.provider !== 'GITLAB') return res.status(404).json({ error: 'GitLab connector not found' });
  try { res.json(await GL.listProjects(c.baseUrl, tokenOf(c), req.query.search || '')); }
  catch (e) { scmError(res, e); }
});

async function jiraConnector(req, res) {
  const c = await prisma.connector.findFirst({ where: { id: req.params.id, projectId: req.project.id } });
  if (!c || c.provider !== 'JIRA') { res.status(404).json({ error: 'Jira connector not found' }); return null; }
  return c;
}

// Filter option sources: projects, issue types, statuses.
scmRouter.get('/projects/:projectId/connectors/:id/jira/meta', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  try {
    const [projects, issueTypes, statuses] = await Promise.all([
      JR.listProjects(c.baseUrl, c.email, tokenOf(c)),
      JR.listIssueTypes(c.baseUrl, c.email, tokenOf(c)),
      JR.listStatuses(c.baseUrl, c.email, tokenOf(c)),
    ]);
    res.json({ projects, issueTypes, statuses });
  } catch (e) { scmError(res, e); }
});

scmRouter.get('/projects/:projectId/connectors/:id/jira/boards', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  try { res.json(await JR.listBoards(c.baseUrl, c.email, tokenOf(c), req.query.project)); }
  catch (e) { scmError(res, e); }
});

scmRouter.get('/projects/:projectId/connectors/:id/jira/sprints', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  if (!req.query.boardId) return res.json([]);
  try { res.json(await JR.listSprints(c.baseUrl, c.email, tokenOf(c), req.query.boardId)); }
  catch (e) { scmError(res, e); }
});

scmRouter.get('/projects/:projectId/connectors/:id/jira/epics', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  if (!req.query.boardId) return res.json([]);
  try { res.json(await JR.listEpics(c.baseUrl, c.email, tokenOf(c), req.query.boardId)); }
  catch (e) { scmError(res, e); }
});

// Structured issue search — builds JQL from filters.
scmRouter.get('/projects/:projectId/connectors/:id/jira/issues', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  const { project, sprintId, epicKey, status, text, max } = req.query;
  const types = req.query.types ? String(req.query.types).split(',').filter(Boolean) : [];
  const jql = JR.buildJql({ project, types, sprintId, epicKey, status, text });
  try { res.json({ jql, issues: await JR.searchIssues(c.baseUrl, c.email, tokenOf(c), jql, Number(max) || 50) }); }
  catch (e) { scmError(res, e); }
});

// Raw JQL search (kept for flexibility).
scmRouter.get('/projects/:projectId/connectors/:id/issues', async (req, res) => {
  const c = await jiraConnector(req, res); if (!c) return;
  try { res.json(await JR.searchIssues(c.baseUrl, c.email, tokenOf(c), req.query.jql || '', 50)); }
  catch (e) { scmError(res, e); }
});

/* ---- Repos ---- */

scmRouter.get('/projects/:projectId/repos', async (req, res) => {
  await recoverStaleIndexes();
  const repos = await prisma.repo.findMany({
    where: { projectId: req.project.id },
    include: { index: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(repos.map(publicRepo));
});

// Add a repo under a connector (fetches metadata + file tree via the stored token).
scmRouter.post('/projects/:projectId/repos', async (req, res) => {
  const { connectorId, name, branch, key } = req.body || {};
  if (!connectorId || !name) return res.status(400).json({ error: 'connectorId and name are required' });
  const c = await prisma.connector.findFirst({ where: { id: connectorId, projectId: req.project.id } });
  if (!c) return res.status(404).json({ error: 'Connector not found' });

  let meta;
  try {
    if (c.provider === 'GITLAB') meta = await GL.getProjectWithTree(c.baseUrl, tokenOf(c), name);
    else return res.status(400).json({ error: 'Only GitLab repos are supported right now' });
  } catch (e) { return scmError(res, e); }

  const existing = await prisma.repo.findUnique({ where: { projectId_name: { projectId: req.project.id, name: meta.name } } });
  if (existing) return res.status(200).json(publicRepo(existing));

  // Optional explicit branch overrides the repo's default.
  let finalBranch = meta.branch;
  let files = meta.files;
  if (branch && branch.trim() && branch.trim() !== meta.branch) {
    try {
      files = await GL.fetchTree(c.baseUrl, tokenOf(c), meta.name, branch.trim());
      finalBranch = branch.trim();
    } catch (e) { return scmError(res, e); }
  }

  const repo = await prisma.repo.create({
    data: {
      provider: c.provider, name: meta.name, key: key?.trim() || null, branch: finalBranch, webUrl: meta.webUrl,
      language: meta.language, summary: meta.summary, files,
      active: true, projectId: req.project.id, connectorId: c.id,
    },
  });
  res.status(201).json(publicRepo(repo));
});

// Update branch and/or active flag.
scmRouter.patch('/projects/:projectId/repos/:id', async (req, res) => {
  const repo = await prisma.repo.findFirst({ where: { id: req.params.id, projectId: req.project.id }, include: { connector: true } });
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  const patch = {};

  if (req.body.branch && req.body.branch !== repo.branch) {
    try {
      const files = await GL.fetchTree(repo.connector.baseUrl, tokenOf(repo.connector), repo.name, req.body.branch);
      patch.branch = req.body.branch;
      patch.files = files;
    } catch (e) { return scmError(res, e); }
  }
  // Multi-select: each repo's selected flag toggles independently.
  if (typeof req.body.active === 'boolean') patch.active = req.body.active;
  if (typeof req.body.key === 'string') patch.key = req.body.key.trim() || null;
  const updated = await prisma.repo.update({ where: { id: repo.id }, data: patch, include: { index: true } });
  res.json(publicRepo(updated));
});

scmRouter.delete('/projects/:projectId/repos/:id', async (req, res) => {
  const repo = await prisma.repo.findFirst({ where: { id: req.params.id, projectId: req.project.id } });
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  await prisma.repo.delete({ where: { id: repo.id } });
  res.status(204).end();
});

// List branches for a repo.
scmRouter.get('/projects/:projectId/repos/:id/branches', async (req, res) => {
  const repo = await prisma.repo.findFirst({ where: { id: req.params.id, projectId: req.project.id }, include: { connector: true } });
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  try { res.json(await GL.listBranches(repo.connector.baseUrl, tokenOf(repo.connector), repo.name)); }
  catch (e) { scmError(res, e); }
});
