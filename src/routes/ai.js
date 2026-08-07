import { Router } from 'express';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { generateComposeArtifacts, testConnection, isLlmReady, LLM_KEY_REQUIRED_MSG } from '../lib/llm.js';
import { retrieveChunks, formatChunksForPrompt, layerOf, matchesLayers } from '../lib/rag/retrieve.js';
import { filterChunksToAsk, suggestIndexedFeatures, parseIntent, pickFeatureFromCatalog, loadChunksForFeature, prioritizeFeatureChunks } from '../lib/rag/ground.js';
import { resolveComposeLanes } from '../lib/rag/resolveComposeLanes.js';
import { pathInFeatureFolder, primaryFeatureFolder, filterChunksToFeatureFolder, resolvedFeatureFolder } from '../lib/rag/codeSignals.js';
import {
  hydrateChunksForCompose,
  REQUIRE_LIVE_FOR_UI,
  filterLiveGitlabChunks,
  liveUiSourcesReady,
  supplementLiveUiForCompose,
  isLocalSourceConfigured,
} from '../lib/rag/live.js';
import { buildAutomationBundle, ensureAutomationHasFillSteps } from '../lib/automation/codegen.js';
import { writePlaywrightSpec, writeApiSpec, saveAndRunPlaywrightSpec, saveAndRunApiSpec } from '../lib/automation/specWriter.js';
import { loadDbTarget, testDbConnection, runDbAutomation } from '../lib/automation/dbRunner.js';
import { indexRepo, indexActiveRepos, getIndexStatus } from '../lib/rag/indexer.js';
import { persistTestRun, publicRun } from '../lib/reports/persistRun.js';
import { extractAllRules, formatAllRules } from '../lib/rag/allRules.js';
import { readSourceDirect, buildDirectContext } from '../lib/rag/directSource.js';
import { nlpParseIntent } from '../lib/rag/nlpIntent.js';

// Mounted at /api. Full paths include /projects/:projectId.
export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.param('projectId', async (req, res, next, projectId) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const membership = await prisma.membership.findUnique({ where: { userId_orgId: { userId: req.user.id, orgId: project.orgId } } });
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  req.project = project;
  next();
});

const PROVIDER = 'anthropic';

async function attachSavedReport(projectId, result, options = {}, extras = {}) {
  if (options.saveReport === false || result?.skipped) {
    return { ...result, report: null };
  }
  try {
    const run = await persistTestRun({
      projectId,
      result,
      meta: {
        label: options.label
          || extras.label
          || `${extras.kind || result?.kind || 'ui'} · ${result?.feature || extras.feature || 'run'}`,
        kind: extras.kind || result?.kind || 'ui',
        suiteId: options.suiteId || null,
        caseId: options.caseId || null,
        askTitle: options.askTitle || extras.askTitle || null,
        feature: extras.feature || result?.feature || null,
        acceptanceCriteria: options.acceptanceCriteria || extras.acceptanceCriteria || null,
        collectArtifacts: extras.collectArtifacts !== false,
        runStartedAt: extras.runStartedAt || Date.now(),
      },
    });
    return {
      ...result,
      reportId: run.id,
      report: publicRun({ ...run, projectId }),
    };
  } catch (e) {
    console.warn('[reports] persist failed:', e.message);
    return { ...result, reportError: String(e.message || e) };
  }
}

function envKeyFor() {
  return env.ANTHROPIC_API_KEY || '';
}

function envModelFor() {
  return env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
}

const publicAi = (s) => {
  const hasStored = !!s?.apiKeyCipher;
  const hasEnv = !!envKeyFor();
  return {
    provider: PROVIDER,
    storedProvider: PROVIDER,
    model: s?.model || envModelFor() || '',
    hasKey: hasStored || hasEnv,
    keySource: hasStored ? 'stored' : hasEnv ? 'env' : null,
    envAvailable: {
      anthropic: !!env.ANTHROPIC_API_KEY,
    },
  };
};

/** Resolve Anthropic key/model: project Settings first, then .env fallback. */
async function loadAiCreds(projectId) {
  const s = await prisma.aiSetting.findUnique({ where: { projectId } });
  let apiKey = s?.apiKeyCipher ? decrypt(s.apiKeyCipher) : null;
  let model = s?.model || null;
  if (!apiKey) apiKey = envKeyFor() || null;
  if (!model) model = envModelFor() || null;
  return { setting: s, provider: PROVIDER, apiKey, model };
}

// GET current AI config (never returns the key).
aiRouter.get('/projects/:projectId/ai-settings', async (req, res) => {
  const s = await prisma.aiSetting.findUnique({ where: { projectId: req.project.id } });
  res.json(publicAi(s));
});

// PUT Anthropic model/key. Empty apiKey keeps existing / falls back to .env.
aiRouter.put('/projects/:projectId/ai-settings', async (req, res) => {
  const { model = '', apiKey } = req.body || {};
  const provider = PROVIDER;

  const existing = await prisma.aiSetting.findUnique({ where: { projectId: req.project.id } });
  let apiKeyCipher = existing?.apiKeyCipher || null;
  if (typeof apiKey === 'string' && apiKey.trim()) apiKeyCipher = encrypt(apiKey.trim());

  if (!apiKeyCipher && !envKeyFor()) {
    return res.status(400).json({ error: 'Anthropic API key required — set in Settings or ANTHROPIC_API_KEY in .env' });
  }

  const data = { provider, model: model || envModelFor() || null, apiKeyCipher };
  const saved = await prisma.aiSetting.upsert({
    where: { projectId: req.project.id },
    update: data,
    create: { ...data, projectId: req.project.id },
  });
  res.json(publicAi(saved));
});

// Test connectivity with the stored / env key.
aiRouter.post('/projects/:projectId/ai-settings/test', async (req, res) => {
  const { provider, apiKey, model } = await loadAiCreds(req.project.id);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key stored or in .env' });
  try {
    await testConnection({ provider, apiKey, model });
    res.json({ ok: true, provider });
  } catch (e) { res.status(502).json({ error: e.message || 'Test failed' }); }
});

function normalizeAppUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    // Keep ?tenant=bota intact — CapBO SSO depends on it
    return new URL(s.includes('://') ? s : `https://${s}`).toString();
  } catch {
    return s;
  }
}

function publicTestTarget(row) {
  return {
    appUrl: row?.appUrl || env.TARGET_APP_URL || '',
    email: row?.email || '',
    hasPassword: !!(row?.passwordCipher),
    fromEnv: !row?.appUrl && !!env.TARGET_APP_URL,
  };
}

async function loadTestTarget(projectId) {
  const row = await prisma.testTarget.findUnique({ where: { projectId } });
  const appUrl = normalizeAppUrl(row?.appUrl || env.TARGET_APP_URL || '');
  const email = row?.email || '';
  const password = row?.passwordCipher ? decrypt(row.passwordCipher) : '';
  return { row, appUrl, email, password };
}

// GET test execution target (URL / email — never returns password).
aiRouter.get('/projects/:projectId/test-target', async (req, res) => {
  const row = await prisma.testTarget.findUnique({ where: { projectId: req.project.id } });
  res.json(publicTestTarget(row));
});

// PUT test execution target (URL, email, password).
aiRouter.put('/projects/:projectId/test-target', async (req, res) => {
  const { appUrl = '', email = '', password } = req.body || {};
  const existing = await prisma.testTarget.findUnique({ where: { projectId: req.project.id } });

  let passwordCipher = existing?.passwordCipher || null;
  if (typeof password === 'string' && password.trim()) {
    passwordCipher = encrypt(password.trim());
  } else if (password === '') {
    passwordCipher = null;
  }

  const data = {
    appUrl: normalizeAppUrl(appUrl) || null,
    email: String(email || '').trim() || null,
    passwordCipher,
  };

  const saved = await prisma.testTarget.upsert({
    where: { projectId: req.project.id },
    update: data,
    create: { ...data, projectId: req.project.id },
  });
  res.json(publicTestTarget(saved));
});

function publicDbTargetRow(row) {
  return {
    host: row?.host || '',
    port: row?.port ?? 5432,
    database: row?.database || '',
    username: row?.username || '',
    ssl: !!row?.ssl,
    hasPassword: !!(row?.passwordCipher),
    configured: !!(
      (row?.host && row?.database && row?.username && row?.passwordCipher)
      || env.TARGET_DATABASE_URL
    ),
    fromEnv: !row?.host && !row?.database && !!env.TARGET_DATABASE_URL,
  };
}

/** Parse postgresql://user:pass@host:port/db?... into Settings fields. */
function parseDatabaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : `postgresql://${s}`);
    if (!/^postgres(ql)?:$/i.test(u.protocol)) return null;
    const password = decodeURIComponent(u.password || '');
    return {
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 5432,
      database: (u.pathname || '').replace(/^\//, '').split('?')[0] || '',
      username: decodeURIComponent(u.username || ''),
      password,
      ssl: /sslmode=require|ssl=true/i.test(s) || u.searchParams.get('sslmode') === 'require',
    };
  } catch {
    return null;
  }
}

/** If host was entered as host:port, split it. */
function normalizeHostPort(host, port) {
  let h = String(host || '').trim();
  let p = Number(port) > 0 ? Number(port) : 5432;
  const m = h.match(/^([^:/]+):(\d+)$/);
  if (m) {
    h = m[1];
    p = Number(m[2]) || p;
  }
  return { host: h || null, port: p };
}

// GET CapBO Postgres target (never returns password).
aiRouter.get('/projects/:projectId/db-target', async (req, res) => {
  try {
    if (!prisma.dbTarget) {
      return res.status(503).json({
        error: 'Prisma client missing DbTarget — restart nocta-backend (npm run dev) after prisma generate',
      });
    }
    const row = await prisma.dbTarget.findUnique({ where: { projectId: req.project.id } });
    res.json(publicDbTargetRow(row));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load db target' });
  }
});

// PUT CapBO Postgres target. Accepts discrete fields and/or connection `url`.
aiRouter.put('/projects/:projectId/db-target', async (req, res) => {
  try {
    if (!prisma.dbTarget) {
      return res.status(503).json({
        error: 'Prisma client missing DbTarget — restart nocta-backend (npm run dev) after prisma generate',
      });
    }
    const body = req.body || {};
    const fromUrl = parseDatabaseUrl(body.url);
    const hostIn = fromUrl?.host ?? body.host ?? '';
    const portIn = fromUrl?.port ?? body.port ?? 5432;
    const { host, port } = normalizeHostPort(hostIn, portIn);
    const database = String(fromUrl?.database ?? body.database ?? '').trim() || null;
    const username = String(fromUrl?.username ?? body.username ?? '').trim() || null;
    const ssl = fromUrl ? !!fromUrl.ssl : !!body.ssl;

    const existing = await prisma.dbTarget.findUnique({ where: { projectId: req.project.id } });
    let passwordCipher = existing?.passwordCipher || null;
    const password = typeof body.password === 'string'
      ? body.password
      : (fromUrl?.password != null ? fromUrl.password : undefined);
    if (typeof password === 'string' && password.trim()) {
      passwordCipher = encrypt(password.trim());
    } else if (password === '') {
      passwordCipher = null;
    }

    const data = {
      host,
      port,
      database,
      username,
      passwordCipher,
      ssl,
    };

    const saved = await prisma.dbTarget.upsert({
      where: { projectId: req.project.id },
      update: data,
      create: { ...data, projectId: req.project.id },
    });
    res.json(publicDbTargetRow(saved));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save db target' });
  }
});

// Test CapBO Postgres connectivity.
aiRouter.post('/projects/:projectId/db-target/test', async (req, res) => {
  try {
    if (!prisma.dbTarget) {
      return res.status(503).json({
        error: 'Prisma client missing DbTarget — restart nocta-backend (npm run dev) after prisma generate',
      });
    }
    const { config } = await loadDbTarget(req.project.id, prisma);
    if (!config) {
      return res.status(400).json({
        error: 'Database not configured — fill Settings → Target database (or TARGET_DATABASE_URL in .env)',
      });
    }
    await testDbConnection(config);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Database connection failed' });
  }
});

/* ---- RAG index ---- */

aiRouter.get('/projects/:projectId/rag/status', async (req, res) => {
  res.json(await getIndexStatus(req.project.id));
});

// Index one repo (async). Returns immediately with status "indexing".
aiRouter.post('/projects/:projectId/repos/:repoId/index', async (req, res) => {
  const repo = await prisma.repo.findFirst({ where: { id: req.params.repoId, projectId: req.project.id } });
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  const { provider, apiKey } = await loadAiCreds(req.project.id);

  await prisma.repoIndex.upsert({
    where: { repoId: repo.id },
    update: { status: 'indexing', error: null },
    create: { repoId: repo.id, status: 'indexing' },
  });
  res.status(202).json({ ok: true, repoId: repo.id, status: 'indexing' });

  indexRepo(repo.id, { provider, apiKey, baseUrl: env.ANTHROPIC_BASE_URL }).catch((e) => console.error('[rag] index failed', repo.id, e.message));
});

// Index all active repos in the project.
aiRouter.post('/projects/:projectId/rag/index', async (req, res) => {
  const { provider, apiKey } = await loadAiCreds(req.project.id);
  const active = await prisma.repo.findMany({ where: { projectId: req.project.id, active: true } });
  if (!active.length) return res.status(400).json({ error: 'No active repos. Select repos in Connectors first.' });

  for (const r of active) {
    await prisma.repoIndex.upsert({
      where: { repoId: r.id },
      update: { status: 'indexing', error: null },
      create: { repoId: r.id, status: 'indexing' },
    });
  }
  res.status(202).json({ ok: true, status: 'indexing', repoIds: active.map((r) => r.id) });

  indexActiveRepos(req.project.id, { provider, apiKey, baseUrl: env.ANTHROPIC_BASE_URL })
    .then((r) => console.log('[rag] project index done', req.project.id, r))
    .catch((e) => console.error('[rag] project index failed', e.message));
});

// Preview retrieval for a free-text query.
aiRouter.post('/projects/:projectId/rag/query', async (req, res) => {
  const { question, topK } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
  const { provider, apiKey } = await loadAiCreds(req.project.id);
  const chunks = await retrieveChunks({
    projectId: req.project.id,
    query: question,
    topK: Number(topK) || 10,
    provider,
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL,
  });
  res.json({ chunks });
});

// Direct-read compose — reads full files from local disk, zero index dependency.
aiRouter.post('/projects/:projectId/compose', async (req, res) => {
  const { title, description, options } = req.body || {};
  if (!title && !description) return res.status(400).json({ error: 'Provide a title or description' });

  const { apiKey } = await loadAiCreds(req.project.id);

  const agentSteps = [
    { id: 'intent',   status: 'pending', label: 'Understanding your ask',        detail: '' },
    { id: 'files',    status: 'pending', label: 'Reading source files',          detail: '' },
    { id: 'rules',    status: 'pending', label: 'Extracting business rules',     detail: '' },
    { id: 'generate', status: 'pending', label: 'Generating test cases',         detail: '' },
    { id: 'ready',    status: 'pending', label: 'Ready',                         detail: '' },
  ];

  // NLP parse (sole intent parser — no keyword fallback)
  const rawIntent = await nlpParseIntent(title, description, { apiKey }).catch(() => null);
  const intent = rawIntent || parseIntent(title, description); // parseIntent for subjectTerms only

  agentSteps[0] = {
    id: 'intent', status: 'done',
    label: 'Understood your ask',
    detail: `${intent.action || 'test'} · ${intent.entities?.join(', ') || intent.subjectTerms?.join(', ') || title}`,
  };

  // Determine entities from intent — NLP entities > subjectTerms
  const entities = intent.entities?.length
    ? intent.entities
    : (intent.subjectTerms?.length ? intent.subjectTerms : [title].filter(Boolean));
  if (!entities.length) return res.status(422).json({ error: 'Could not determine which module to test' });

  // Read source files directly from disk
  const direct = await readSourceDirect(entities);
  if (direct.errors.length && !direct.entities.length && !direct.ui.length) {
    return res.status(422).json({ error: direct.errors[0] });
  }

  const { codeContext, uiContext, apiContext, sources } = buildDirectContext(direct, entities[0]);

  agentSteps[1] = {
    id: 'files', status: 'done',
    label: 'Read source files from disk',
    detail: `${direct.entities.length + direct.services.length} PHP · ${direct.ui.length} UI · ${direct.entities.map(e => e.entity).join(', ')}`,
  };

  // Extract ALL business rules from entity + service files (unified)
  const allRules = extractAllRules(direct);
  const businessRules = formatAllRules(allRules, entities[0]);

  agentSteps[2] = {
    id: 'rules', status: 'done',
    label: 'Extracted business rules',
    detail: `${allRules.summary.total} rules (${allRules.summary.required} required · ${allRules.summary.guards} guards · ${allRules.summary.permissions} permissions)`,
  };

  // Generate
  agentSteps[3] = { id: 'generate', status: 'active', label: 'Generating test cases', detail: 'DeepSeek drafting…' };
  const result = await generateComposeArtifacts({
    provider: 'deepseek',
    apiKey,
    model: env.DEEPSEEK_MODEL,
    title, description,
    options: { codeOnly: options?.codeOnly === true, layers: ['ui', 'backend'] },
    codeContext, uiContext, apiContext,
    matchedFeature: entities[0],
    intent,
    businessRules,
  });

  // Frontend expects { ui, api, db } — not the flat uiAutomation object
  const automation = buildAutomationBundle({
    layers: ['ui', 'backend'],
    uiPlan: result.uiPlan,
    uiContext,
    apiContext,
    cases: result.cases,
    matchedFeature: entities[0],
    intent: result.intent || intent,
    uiAutomation: result.uiAutomation,
  });

  // Write spec file during compose — ready to run immediately
  let specFile = result.specFile || null;
  if (automation?.ui?.steps?.length) {
    try {
      const written = await writePlaywrightSpec(automation.ui, {
        title: result.uiPlan?.title || title,
        stableName: entities[0],
        matchedFeature: entities[0],
      });
      specFile = written.relativePath;
      if (automation.ui) automation.ui.specFile = written.relativePath;
    } catch (e) {
      console.warn('[compose] spec write failed:', e.message);
    }
  }

  agentSteps[3] = { id: 'generate', status: 'done', label: 'Generated test cases', detail: `${(result.cases || []).length} cases · ${specFile || 'no spec'}` };
  agentSteps[4] = { id: 'ready', status: 'done', label: 'Ready', detail: options?.codeOnly ? 'Test plan ready' : 'Spec ready to run' };

  // Strip spec file from manual test plan (codeOnly mode)
  const stripped = options?.codeOnly
    ? { cases: result.cases, uiPlan: result.uiPlan, intent: result.intent, capabilities: result.capabilities }
    : result;

  res.json({
    ...stripped,
    automation,
    specFile,
    codeOnly: !!options?.codeOnly,
    fromDirectRead: true,
    sources,
    entities,
    agentSteps,
  });
});


// Run Playwright spec from generated-e2e/
aiRouter.post('/projects/:projectId/run-tests', async (req, res) => {
  const { specFile, automation } = req.body || {};
  const payload = automation?.ui || automation;
  if (!payload?.steps?.length && !specFile) {
    return res.status(400).json({ error: 'No automation steps or spec file provided' });
  }

  try {
    const result = await saveAndRunPlaywrightSpec(payload, {
      specFile,
      title: payload?.title,
      matchedFeature: payload?.matchedFeature,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Run failed' });
  }
});

// Save Playwright spec to capqa-backend/generated-e2e/ (does not run).
aiRouter.post('/projects/:projectId/save-spec', async (req, res) => {
  const { automation, title, stableName, matchedFeature } = req.body || {};
  const payload = automation?.ui || automation;
  if (!payload?.steps?.length) {
    return res.status(400).json({ error: 'Provide automation.ui with steps from compose' });
  }
  try {
    const written = await writePlaywrightSpec(payload, { title, stableName, matchedFeature });
    res.json({
      ok: true,
      filePath: written.filePath,
      relativePath: written.relativePath,
      fileName: written.fileName,
      playwrightSource: written.source,
      hint: `cd nocta-backend && TARGET_APP_URL=... APP_TEST_USERNAME=... APP_TEST_PASSWORD=... npx playwright test ${written.relativePath} --headed`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save spec' });
  }
});
