import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, projectSchema } from '../lib/validate.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

// Derive a project key like "CAPBO" from a name.
function keyFromName(name) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'PROJ';
  const base = words.length === 1 ? words[0].slice(0, 6) : words.map((w) => w[0]).join('').slice(0, 6);
  return base.toUpperCase();
}

async function userOrgIds(userId) {
  const ms = await prisma.membership.findMany({ where: { userId }, select: { orgId: true } });
  return ms.map((m) => m.orgId);
}

// GET /api/projects?orgId=…  — projects in the user's orgs
projectsRouter.get('/', async (req, res) => {
  const orgIds = await userOrgIds(req.user.id);
  const where = { orgId: req.query.orgId ? req.query.orgId : { in: orgIds } };
  if (req.query.orgId && !orgIds.includes(req.query.orgId)) return res.status(403).json({ error: 'Not a member of this org' });
  const projects = await prisma.project.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json(projects);
});

// POST /api/projects — create a project in an org (defaults to the user's first org)
projectsRouter.post('/', validate(projectSchema), async (req, res) => {
  const orgIds = await userOrgIds(req.user.id);
  if (!orgIds.length) return res.status(400).json({ error: 'You have no organization yet' });

  const orgId = req.body.orgId || orgIds[0];
  if (!orgIds.includes(orgId)) return res.status(403).json({ error: 'Not a member of this org' });

  // Resolve a unique key within the org.
  let key = (req.body.key || keyFromName(req.body.name)).toUpperCase();
  let candidate = key, n = 1;
  while (await prisma.project.findUnique({ where: { orgId_key: { orgId, key: candidate } } })) {
    candidate = `${key}${++n}`;
  }

  const project = await prisma.project.create({
    data: {
      name: req.body.name,
      key: candidate,
      description: req.body.description || null,
      orgId,
      createdById: req.user.id,
    },
  });
  res.status(201).json(project);
});

// GET /api/projects/:id
projectsRouter.get('/:id', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const orgIds = await userOrgIds(req.user.id);
  if (!orgIds.includes(project.orgId)) return res.status(403).json({ error: 'Forbidden' });
  res.json(project);
});
