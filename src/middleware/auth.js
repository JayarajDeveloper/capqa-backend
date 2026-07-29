import { verifyToken } from '../lib/auth.js';
import { prisma } from '../db.js';

// Attaches req.user (from a valid Bearer token) or 401s.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Ensures req.user can access :projectId (member of the project's org). Attaches req.project.
export async function requireProjectAccess(req, res, next) {
  const projectId = req.params.projectId;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.user.id, orgId: project.orgId } },
  });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  req.project = project;
  next();
}

// Ensures req.user is a member of :orgId (params or body) and attaches req.membership.
export async function requireOrgMember(req, res, next) {
  const orgId = req.params.orgId || req.body.orgId;
  if (!orgId) return res.status(400).json({ error: 'orgId required' });
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.user.id, orgId } },
  });
  if (!membership) return res.status(403).json({ error: 'Not a member of this organization' });
  req.membership = membership;
  next();
}
