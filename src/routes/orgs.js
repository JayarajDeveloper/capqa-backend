import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, orgSchema } from '../lib/validate.js';

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

// GET /api/orgs — orgs the user belongs to
orgsRouter.get('/', async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.user.id },
    include: { org: { include: { _count: { select: { projects: true, members: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json(memberships.map((m) => ({
    id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role,
    projectCount: m.org._count.projects, memberCount: m.org._count.members,
  })));
});

// POST /api/orgs — create an org (creator becomes OWNER)
orgsRouter.post('/', validate(orgSchema), async (req, res) => {
  const { name } = req.body;
  let slug = slugify(name);
  if (await prisma.organization.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  const org = await prisma.organization.create({
    data: {
      name, slug, ownerId: req.user.id,
      members: { create: { userId: req.user.id, role: 'OWNER' } },
    },
  });
  res.status(201).json({ id: org.id, name: org.name, slug: org.slug, role: 'OWNER' });
});
