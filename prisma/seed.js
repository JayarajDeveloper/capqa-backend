// Seeds the admin user and their default organization. Idempotent.
//   npm run seed
import { PrismaClient } from '@prisma/client';
import { env } from '../src/env.js';
import { hashPassword } from '../src/lib/auth.js';

const prisma = new PrismaClient();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';

async function main() {
  const email = env.ADMIN_EMAIL.toLowerCase();

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: env.ADMIN_NAME, passwordHash, role: 'ADMIN' },
  });

  const slug = slugify(env.ADMIN_ORG);
  let org = await prisma.organization.findUnique({ where: { slug } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: env.ADMIN_ORG,
        slug,
        ownerId: admin.id,
        members: { create: { userId: admin.id, role: 'OWNER' } },
      },
    });
  }

  console.log('✔ Seeded admin user and organization');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${env.ADMIN_PASSWORD}`);
  console.log(`  org:      ${org.name} (${org.slug})`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
