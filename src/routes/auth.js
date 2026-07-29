import { Router } from 'express';
import { prisma } from '../db.js';
import { verifyPassword, signToken, publicUser } from '../lib/auth.js';
import { validate, loginSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

async function orgsForUser(userId) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { org: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map((m) => ({ id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role }));
}

// POST /api/auth/login
authRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user), orgs: await orgsForUser(user.id) });
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user), orgs: await orgsForUser(req.user.id) });
});
