import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { authRouter } from './routes/auth.js';
import { orgsRouter } from './routes/orgs.js';
import { projectsRouter } from './routes/projects.js';
import { scmRouter } from './routes/scm.js';
import { aiRouter } from './routes/ai.js';
import { reportsRouter } from './routes/reports.js';
import { recoverStaleIndexes } from './lib/rag/indexer.js';

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'cap-qa-backend' }));

app.use('/api/auth', authRouter);
app.use('/api/orgs', orgsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api', scmRouter);
app.use('/api', aiRouter);
app.use('/api', reportsRouter);

// Fallback error handler — surfaces the real message to help debugging.
app.use((err, req, res, _next) => {
  console.error(err);
  const msg = err?.message || 'Internal server error';
  // Prisma "column/table does not exist" usually means a migration hasn't been applied.
  const hint = /does not exist|Unknown argument|P20\d\d|column .* of relation/i.test(msg)
    ? ' (a database migration may be missing — run `npx prisma migrate dev`)'
    : '';
  res.status(500).json({ error: msg + hint });
});

app.listen(env.PORT, () => {
  console.log(`cap-qa backend listening on http://localhost:${env.PORT}`);
  recoverStaleIndexes({ onStartup: true }).catch((e) => console.error('[rag] startup recovery failed', e.message));
});
