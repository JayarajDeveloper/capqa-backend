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
import { hydrateChunksFromGitLab, REQUIRE_LIVE_FOR_UI, filterLiveGitlabChunks, liveUiSourcesReady, supplementLiveUiFromGitLab } from '../lib/rag/live.js';
import { buildAutomationBundle, ensureAutomationHasFillSteps } from '../lib/automation/codegen.js';
import { writePlaywrightSpec, writeApiSpec, saveAndRunPlaywrightSpec, saveAndRunApiSpec } from '../lib/automation/specWriter.js';
import { loadDbTarget, testDbConnection, runDbAutomation } from '../lib/automation/dbRunner.js';
import { indexRepo, indexActiveRepos, getIndexStatus } from '../lib/rag/indexer.js';
import { persistTestRun, publicRun } from '../lib/reports/persistRun.js';

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

const PROVIDER = 'gemini';

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
  return env.GEMINI_API_KEY || '';
}

function envModelFor() {
  return env.GEMINI_MODEL || 'gemini-2.5-flash';
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
      gemini: !!env.GEMINI_API_KEY,
    },
  };
};

/** Resolve Gemini key/model: project Settings first, then .env fallback. */
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

// PUT Gemini model/key. Empty apiKey keeps existing / falls back to .env.
aiRouter.put('/projects/:projectId/ai-settings', async (req, res) => {
  const { model = '', apiKey } = req.body || {};
  const provider = PROVIDER;

  const existing = await prisma.aiSetting.findUnique({ where: { projectId: req.project.id } });
  let apiKeyCipher = existing?.apiKeyCipher || null;
  if (typeof apiKey === 'string' && apiKey.trim()) apiKeyCipher = encrypt(apiKey.trim());

  if (!apiKeyCipher && !envKeyFor()) {
    return res.status(400).json({ error: 'Gemini API key required — set in Settings or GEMINI_API_KEY in .env' });
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
  if (!apiKey) return res.status(400).json({ error: 'No Gemini API key stored or in .env' });
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

  indexRepo(repo.id, { provider, apiKey, baseUrl: env.GEMINI_BASE_URL }).catch((e) => console.error('[rag] index failed', repo.id, e.message));
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

  indexActiveRepos(req.project.id, { provider, apiKey, baseUrl: env.GEMINI_BASE_URL })
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
    baseUrl: env.GEMINI_BASE_URL,
  });
  res.json({ chunks });
});

// Generate test cases — ONLY from retrieved codebase chunks (no outside invention).
aiRouter.post('/projects/:projectId/compose', async (req, res) => {
  const { title, description, options } = req.body || {};
  if (!title && !description) return res.status(400).json({ error: 'Provide a title or description' });

  const confirmedFeature = options?.confirmedFeature || options?.confirmFeature || null;
  const intent = parseIntent(title, description);
  // AI adopts UI / API / Database from the ask — Database only when explicitly requested
  const adoptedLanes = resolveComposeLanes({ title, description, intent });
  const forceLayers = options?.forceLayers === true;
  const rawLayers = options?.layers;
  const layers = forceLayers && Array.isArray(rawLayers) && rawLayers.length
    ? rawLayers.map((l) => String(l).toLowerCase()).filter((l) => ['ui', 'backend', 'database'].includes(l))
    : adoptedLanes.layers;

  const agentSteps = [
    {
      id: 'intent',
      status: 'done',
      label: 'Understood your ask',
      detail: `Action: ${intent.action}`
        + `${intent.subjectTerms.length ? ` · Looking for: ${intent.subjectTerms.join(', ')}` : ''}`
        + `${confirmedFeature ? ` · You picked: ${confirmedFeature}` : ''}`
        + ` · Lanes: ${adoptedLanes.summary}`,
    },
    { id: 'retrieve', status: 'active', label: 'Searching your code index', detail: 'RAG over indexed repos…' },
    { id: 'ground', status: 'pending', label: 'Match to real code', detail: 'Waiting…' },
    { id: 'draft', status: 'pending', label: 'Draft plan from code', detail: 'Waiting…' },
    { id: 'ready', status: 'pending', label: 'Ready', detail: 'Waiting…' },
  ];

  const { setting, provider, apiKey, model } = await loadAiCreds(req.project.id);

  if (!isLlmReady(provider, apiKey)) {
    agentSteps[1] = { id: 'retrieve', status: 'skipped', label: 'Search code index', detail: 'Waiting for AI key' };
    agentSteps[2] = { id: 'ground', status: 'skipped', label: 'Match to real code', detail: 'Waiting for AI key' };
    agentSteps[3] = { id: 'draft', status: 'failed', label: 'AI key required', detail: 'Configure Gemini or Anthropic in Settings' };
    agentSteps[4] = { id: 'ready', status: 'skipped', label: 'Not ready', detail: 'Add an LLM API key to generate test cases' };
    return res.status(422).json({
      error: LLM_KEY_REQUIRED_MSG,
      code: 'LLM_KEY_REQUIRED',
      needsAiKey: true,
      grounded: false,
      inventOutsideIndex: false,
      fromIndex: false,
      agentSteps,
      sources: [],
      cases: [],
      uiPlan: null,
      layers,
      adoptedLanes,
    });
  }

  const query = intent.searchQuery || [title, description].filter(Boolean).join('\n');

  // (intent / agentSteps already set above)
  let chunks = [];
  try {
    chunks = await retrieveChunks({
      projectId: req.project.id,
      query: confirmedFeature ? `${confirmedFeature} ${query}` : query,
      topK: options?.topK || 12,
      provider,
      apiKey,
      baseUrl: env.GEMINI_BASE_URL,
      layers,
    });
  } catch (e) {
    console.warn('[compose] retrieve failed:', e.message);
  }

  agentSteps[1] = {
    id: 'retrieve',
    status: 'done',
    label: 'Searched your code index',
    detail: chunks.length
      ? `Found ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} in layer(s): ${layers.join(', ')}`
      : 'No chunks returned from index',
  };

  chunks = chunks.filter((c) => matchesLayers(c.path, layers));

  // 1) Rank ALL indexed features vs ask (not only the few RAG hits)
  const catalog = await suggestIndexedFeatures(req.project.id, layers, 40, query).catch(() => []);
  const pick = pickFeatureFromCatalog(query, catalog, { confirmedFeature });

  if (pick.needsClarification || !pick.ok) {
    agentSteps[2] = {
      id: 'ground',
      status: 'failed',
      label: pick.reason === 'ambiguous' ? 'Need your help — several matches' : 'Need your help — unclear match',
      detail: pick.note || 'Pick which indexed screen you mean.',
    };
    agentSteps[3] = { id: 'draft', status: 'skipped', label: 'Draft paused', detail: 'Waiting for you to pick a feature' };
    agentSteps[4] = { id: 'ready', status: 'skipped', label: 'Not ready', detail: 'Confirm a feature to continue' };

    return res.status(422).json({
      error: pick.note
        || `I’m not sure which screen matches “${intent.subjectTerms.join(' ') || title}”. Please pick one from your index.`,
      grounded: false,
      needsClarification: true,
      inventOutsideIndex: false,
      fromIndex: false,
      grounding: pick,
      intent,
      suggestions: (pick.candidates || catalog).slice(0, 12).map((c) => ({
        name: c.name,
        files: c.files || c.paths?.length || 0,
        score: c.score,
        paths: c.paths || [],
      })),
      agentSteps,
      sources: [],
      cases: [],
      uiPlan: null,
      layers,
    });
  }

  // 2) Load chunks for the matched feature from the index (reliable for any page)
  const featureChunks = await loadChunksForFeature(
    req.project.id,
    pick.matchedFeature,
    layers,
    28,
    pick.paths || [],
  ).catch(() => []);

  if (featureChunks.length) {
    chunks = featureChunks;
  } else {
    // Fallback: filter RAG hits to this feature name
    const focused = filterChunksToAsk(query, chunks, {
      confirmedFeature,
      matchedFeature: pick.matchedFeature,
    });
    if (focused.length) chunks = focused.slice(0, 28);
  }

  let grounding = {
    ...pick,
    matchedPaths: [...new Set(chunks.map((c) => c.path))].slice(0, 12),
  };

  if (!chunks.length) {
    return res.status(422).json({
      error: `Matched “${pick.matchedFeature}” but no ${layers.join('/')} files were found for it. Try another layer or re-index.`,
      grounded: false,
      needsClarification: true,
      suggestions: catalog.slice(0, 12),
      grounding,
      intent,
      agentSteps,
      cases: [],
      uiPlan: null,
      layers,
    });
  }

  agentSteps[2] = {
    id: 'ground',
    status: 'done',
    label: 'Matched your ask to code',
    detail: `${grounding.matchedFeature} · confidence ${(grounding.confidence * 100).toFixed(0)}%`,
  };
  agentSteps[3] = {
    id: 'draft',
    status: 'active',
    label: 'Refreshing files from GitLab',
    detail: `Live fetch for ${grounding.matchedFeature}…`,
  };

  // Strict: no live GitLab connection / fetch → no test plan at all (UI or API)
  const wantsUiLayer = !layers.length || layers.includes('ui');
  const requireLive = REQUIRE_LIVE_FOR_UI;
  let liveMeta = { ok: false, fetched: 0, discovered: 0, reason: null };
  let liveChunksOnly = [];
  const tHydrate = Date.now();
  const hydrateMs = Number(process.env.GITLAB_HYDRATE_BUDGET_MS || 45000);
  const seedPaths = [...(pick.paths || []), ...chunks.map((c) => c.path)];

  async function runLiveHydrate() {
    return Promise.race([
      hydrateChunksFromGitLab({
        projectId: req.project.id,
        chunks,
        featureName: grounding.matchedFeature,
        query,
        layers,
      }),
      new Promise((resolve) => setTimeout(() => resolve({
        chunks,
        liveChunks: [],
        live: { ok: false, reason: 'gitlab_unreachable_timeout', fetched: 0, discovered: 0 },
      }), Math.max(hydrateMs + 5000, 20000))),
    ]);
  }

  try {
    let live = await runLiveHydrate();
    const retryable = new Set(['gitlab_unreachable', 'gitlab_unreachable_timeout', 'gitlab_fetch_failed', 'nothing_fetched']);
    if (requireLive && retryable.has(live.live?.reason)) {
      console.log(`[compose] live GitLab retry (${live.live?.reason})…`);
      await new Promise((r) => setTimeout(r, 1000));
      live = await runLiveHydrate();
    }
    chunks = live.chunks;
    liveChunksOnly = live.liveChunks || filterLiveGitlabChunks(live.chunks);
    liveMeta = live.live || liveMeta;
    liveChunksOnly = filterChunksToFeatureFolder(liveChunksOnly, grounding.matchedFeature, seedPaths);
    console.log(`[compose] live GitLab hydrate ${Date.now() - tHydrate}ms · fetched=${liveMeta.fetched || 0} · ok=${!!liveMeta.ok} · folder=${resolvedFeatureFolder(grounding.matchedFeature, seedPaths)}`);
    grounding = {
      ...grounding,
      matchedPaths: [...new Set((liveChunksOnly.length ? liveChunksOnly : chunks).map((c) => c.path))].slice(0, 12),
      liveGitLab: liveMeta,
    };
  } catch (e) {
    console.warn('[compose] live GitLab hydrate failed:', e.message, `(${Date.now() - tHydrate}ms)`);
    liveMeta = { ok: false, reason: e.message, fetched: 0, discovered: 0 };
    liveChunksOnly = [];
  }

  const refuseNoLivePlan = (reason, detail) => {
    agentSteps[3] = {
      id: 'draft',
      status: 'error',
      label: 'No live GitLab — test plan not created',
      detail: detail || reason,
    };
    agentSteps[4] = {
      id: 'ready',
      status: 'error',
      label: 'Blocked',
      detail: 'Connect GitLab and ensure live fetch works, then compose again',
    };
    return res.status(503).json({
      error: 'No live GitLab code available — test plan was not created.',
      code: 'LIVE_GITLAB_REQUIRED',
      reason,
      liveGitLab: liveMeta,
      hint: 'Add an active GitLab repo connector, set GITLAB_LIVE_ENABLED=true, and retry when GitLab is reachable.',
      detail: detail || ({
        live_disabled: 'GITLAB_LIVE_ENABLED is false',
        no_active_gitlab_repo: 'No active GitLab repo connected to this project',
        gitlab_unreachable: 'GitLab is unreachable (VPN / network)',
        gitlab_unreachable_timeout: 'GitLab live fetch timed out',
        gitlab_fetch_failed: 'GitLab file fetch failed',
        nothing_fetched: 'Live fetch returned no files',
        live_ui_incomplete: 'Live UI files missing testIds or form rules',
      })[reason] || reason,
      cases: [],
      uiPlan: null,
      automation: null,
      specFile: null,
      agentSteps,
      grounded: true,
      fromIndex: true,
      fromLiveGitLab: false,
      inventOutsideIndex: false,
    });
  };

  if (requireLive) {
    if (!liveMeta.ok || !liveChunksOnly.length) {
      const reason = liveMeta.reason || 'no_live_files';
      const detail = ({
        live_disabled: 'GITLAB_LIVE_ENABLED is false',
        no_active_gitlab_repo: 'No active GitLab repo connected to this project',
        gitlab_unreachable: 'GitLab is unreachable',
        gitlab_unreachable_timeout: 'GitLab live fetch timed out',
        gitlab_fetch_failed: 'GitLab file fetch failed',
        nothing_fetched: 'Live fetch returned no files',
      })[reason] || reason;
      return refuseNoLivePlan(reason, detail);
    }

    const wantsUi = wantsUiLayer;
    if (wantsUi) {
      let ready = liveUiSourcesReady(liveChunksOnly);
      if (!ready.ok && !ready.hasTestId) {
        console.log('[compose] live UI missing testIds — mandatory UI supplement…');
        const sup = await supplementLiveUiFromGitLab({
          projectId: req.project.id,
          featureName: grounding.matchedFeature,
          liveChunks: liveChunksOnly,
          seedChunks: chunks,
        });
        if (sup.added.length) {
          liveChunksOnly = filterChunksToFeatureFolder(
            sup.liveChunks,
            grounding.matchedFeature,
            seedPaths,
          );
          liveMeta = { ...liveMeta, fetched: (liveMeta.fetched || 0) + sup.added.length };
          ready = liveUiSourcesReady(liveChunksOnly);
        }
      }
      if (!ready.ok) {
        console.log('[compose] live UI still incomplete — full live hydrate retry…');
        await new Promise((r) => setTimeout(r, 1000));
        const retryLive = await runLiveHydrate();
        liveChunksOnly = filterChunksToFeatureFolder(
          retryLive.liveChunks || filterLiveGitlabChunks(retryLive.chunks),
          grounding.matchedFeature,
          seedPaths,
        );
        liveMeta = retryLive.live || liveMeta;
        ready = liveUiSourcesReady(liveChunksOnly);
      }
      if (!ready.ok) {
        const pathHint = ready.paths?.length ? ` · paths: ${ready.paths.slice(0, 4).join(', ')}` : '';
        return refuseNoLivePlan(
          'live_ui_incomplete',
          !ready.hasTestId
            ? `Live files have no data-testid / testId${pathHint}`
            : !ready.hasRules
              ? `Live files have no FormGroup / Validators${pathHint}`
              : `Live UI HTML/TS incomplete for testIds & business rules${pathHint}`,
        );
      }
    }

    // Draft only from live bodies — never index junk
    chunks = liveChunksOnly;
  }

  chunks = prioritizeFeatureChunks(chunks, { maxTotal: 36, maxList: 6 });

  const featureFolder = primaryFeatureFolder(chunks, grounding.matchedFeature);
  if (featureFolder) {
    chunks = chunks.filter(
      (c) => !String(c.path).includes('/pages/') || pathInFeatureFolder(c.path, featureFolder),
    );
  }

  agentSteps[3] = {
    id: 'draft',
    status: 'active',
    label: 'Drafting from live GitLab files',
    detail: `Live · ${liveMeta.fetched} refreshed` +
      (liveMeta.discovered ? ` · ${liveMeta.discovered} discovered` : '') +
      (liveMeta.branch ? ` · ${liveMeta.branch}` : ''),
  };

  // No index expand — live GitLab only
  chunks = filterLiveGitlabChunks(chunks);

  const uiChunks = prioritizeFeatureChunks(
    chunks.filter((c) => layerOf(c.path) === 'ui'),
    { maxTotal: 28, maxList: 4 },
  );
  const apiChunks = chunks.filter((c) => {
    const l = layerOf(c.path);
    return l === 'backend' || l === 'database';
  }).slice(0, 24);
  const codeContext = formatChunksForPrompt(prioritizeFeatureChunks(chunks, { maxTotal: 32, maxList: 5 }));
  const uiContext = uiChunks.length ? formatChunksForPrompt(uiChunks) : '';
  const apiContext = apiChunks.length ? formatChunksForPrompt(apiChunks) : '';

  if (requireLive && wantsUiLayer && !uiContext.trim()) {
    return refuseNoLivePlan('LIVE_GITLAB_EMPTY_UI', 'Live GitLab returned no UI file bodies for this feature');
  }

  try {
    const { cases, uiPlan, intent: enrichedIntent, uiAutomation, capabilities, capabilitiesWarning, composeAdvice, composeSuggestions } = await generateComposeArtifacts({
      provider,
      apiKey,
      model: setting?.model || model,
      title,
      description,
      options: { ...options, codeOnly: true, layers },
      codeContext,
      uiContext,
      apiContext,
      matchedFeature: grounding.matchedFeature,
      intent,
    });

    const automation = buildAutomationBundle({
      layers,
      uiPlan,
      uiContext,
      apiContext,
      cases,
      matchedFeature: grounding.matchedFeature,
      intent: enrichedIntent || intent,
      uiAutomation,
    });

    let specFile = null;
    let apiSpecFile = null;
    if (automation.ui?.steps?.length) {
      const written = await writePlaywrightSpec(automation.ui, {
        title: uiPlan?.title || title,
        matchedFeature: grounding.matchedFeature,
        action: automation.ui.action || enrichedIntent?.action,
      });
      automation.ui = {
        ...automation.ui,
        playwrightSource: written.source,
        specFile: written.relativePath,
        filePath: written.filePath,
        fileName: written.fileName,
      };
      specFile = written.relativePath;
    }
    if (automation.api?.steps?.length) {
      const writtenApi = await writeApiSpec(automation.api, {
        title: uiPlan?.title || title,
        matchedFeature: grounding.matchedFeature,
        action: automation.api.action || enrichedIntent?.action,
      });
      automation.api = {
        ...automation.api,
        playwrightSource: writtenApi.source,
        specFile: writtenApi.relativePath,
        filePath: writtenApi.filePath,
        fileName: writtenApi.fileName,
      };
      apiSpecFile = writtenApi.relativePath;
    }
    const hasDbSteps = !!(automation.db?.steps?.length);
    if (!specFile && !apiSpecFile && !hasDbSteps) {
      if (layers.includes('ui') || !layers.length) {
        throw new Error('Compose produced no UI steps — cannot write Playwright spec');
      }
      if (layers.includes('backend')) {
        throw new Error('Compose produced no API steps — index Backend controllers/OpenAPI and try again');
      }
      throw new Error('Compose produced no Database steps — ensure ask has a code/name and Entity is matched');
    }

    agentSteps[3] = {
      id: 'draft',
      status: 'done',
      label: [
        specFile && 'UI',
        apiSpecFile && 'API',
        hasDbSteps && 'Database',
      ].filter(Boolean).join(' + ')
        ? `Drafted ${[specFile && 'UI', apiSpecFile && 'API', hasDbSteps && 'Database'].filter(Boolean).join(' + ')} from live GitLab`
        : 'Drafted from live GitLab',
      detail: uiPlan
        ? `Live plan · ${uiPlan.steps?.length || 0} steps · ${[specFile, apiSpecFile, hasDbSteps && 'sql'].filter(Boolean).join(' · ') || 'no spec'}`
        : `${cases.length} case${cases.length === 1 ? '' : 's'}`,
    };
    agentSteps[4] = {
      id: 'ready',
      status: 'done',
      label: automation.ui
        ? 'Ready to run Playwright spec'
        : automation.api
          ? 'Ready to run API'
          : hasDbSteps
            ? 'Ready to run Database SQL'
            : 'Review plan, then Run',
      detail: automation.ui
        ? `npx playwright test ${specFile} · ${automation.ui.steps.length} steps · ${automation.ui.route || ''}`
        : automation.api
          ? `API · ${automation.api.steps.length} HTTP step(s) · ${apiSpecFile}`
          : hasDbSteps
            ? `SQL · ${automation.db.steps.length} assert(s) · ${automation.db.table || 'table'}`
            : 'Review plan, then Run',
    };

    const testTarget = await loadTestTarget(req.project.id);
    const dbTarget = await loadDbTarget(req.project.id, prisma);

    res.json({
      provider,
      cases,
      uiPlan: uiPlan || null,
      automation,
      specFile,
      apiSpecFile,
      defaultRunAs: (() => {
        const prefer = adoptedLanes.defaultRunAs;
        if (prefer === 'database' && hasDbSteps) return 'database';
        if (prefer === 'api' && automation.api?.steps?.length) return 'api';
        if (prefer === 'ui' && automation.ui?.steps?.length) return 'ui';
        if (automation.ui?.steps?.length) return 'ui';
        if (automation.api?.steps?.length) return 'api';
        if (hasDbSteps) return 'database';
        return 'ui';
      })(),
      adoptedLanes,
      runTarget: {
        appUrl: testTarget.appUrl || null,
        apiUrl: env.TARGET_API_URL || testTarget.appUrl || null,
        hasLogin: !!(testTarget.email && testTarget.password),
        hasDatabase: !!dbTarget.config,
      },
      layers,
      intent: enrichedIntent || intent,
      agentSteps,
      grounding: {
        ...grounding,
        capabilities,
        capabilitiesWarning,
        composeAdvice: composeAdvice || [],
        composeSuggestions: composeSuggestions || [],
        note: capabilitiesWarning
          ? `${capabilitiesWarning} ${liveMeta.ok ? 'Plan built from live GitLab.' : (grounding.note || 'Plan built from indexed code.')}`
          : (liveMeta.ok
            ? 'Plan built from live GitLab file contents (matched via index). Application words come from sources, not invented.'
            : (grounding.note || 'Plan built only from indexed code. Application words come from sources, not invented.')),
      },
      liveGitLab: liveMeta,
      sources: chunks.slice(0, 28).map((c) => ({
        repo: c.repoName,
        path: c.path,
        lines: `${c.startLine}-${c.endLine}`,
        score: c.score,
        method: c.method,
        layer: c.layer || layerOf(c.path),
        branch: c.branch || null,
      })),
      grounded: true,
      fromIndex: true,
      fromLiveGitLab: !!liveMeta.ok,
      inventOutsideIndex: false,
      composeAdvice: composeAdvice || [],
      composeSuggestions: composeSuggestions || [],
      codeOnly: true,
    });
  } catch (e) {
    const status = e.code === 'LLM_KEY_REQUIRED' || e.code === 'CODE_TESTIDS_REQUIRED' || e.code === 'COMPOSE_NOT_FEASIBLE'
      ? 422
      : 502;
    if (e.code === 'CODE_TESTIDS_REQUIRED') {
      agentSteps[3] = {
        id: 'draft',
        status: 'error',
        label: 'Missing CapBO testIds — plan not created',
        detail: (e.missing || []).map((m) => m.message).slice(0, 4).join(' · ') || e.message,
      };
      agentSteps[4] = {
        id: 'ready',
        status: 'error',
        label: 'Blocked',
        detail: 'Add data-testid / testId on CapBO form controls, then compose again',
      };
    }
    if (e.code === 'COMPOSE_NOT_FEASIBLE') {
      agentSteps[3] = {
        id: 'draft',
        status: 'error',
        label: 'Scenario not supported by indexed UI',
        detail: (e.advice || []).slice(0, 2).join(' · ') || e.message,
      };
      agentSteps[4] = {
        id: 'ready',
        status: 'error',
        label: 'Pick a suggested alternative',
        detail: 'Your ask conflicts with CapBO code — choose a supported flow below',
      };
    }
    res.status(status).json({
      error: e.message || 'Generation failed',
      code: e.code || null,
      missing: e.missing || null,
      advice: e.advice || null,
      composeSuggestions: e.suggestions || null,
      capabilities: e.capabilities || null,
      needsAiKey: e.code === 'LLM_KEY_REQUIRED',
      needsClarification: e.code === 'COMPOSE_NOT_FEASIBLE',
      suggestions: e.suggestions || null,
      agentSteps,
      inventOutsideIndex: false,
      cases: [],
      uiPlan: null,
      automation: null,
      specFile: null,
    });
  }
});

// Execute via generated Playwright *.spec.ts (UI browser, API, or Database SQL).
aiRouter.post('/projects/:projectId/run-tests', async (req, res) => {
  const { automation, kind, options } = req.body || {};
  const payload = automation
    || (kind === 'api' ? req.body?.api : kind === 'database' ? req.body?.db : req.body?.ui)
    || null;
  if (!payload) {
    return res.status(400).json({ error: 'Provide automation payload from compose (automation.ui, .api, or .db)' });
  }

  const target = await loadTestTarget(req.project.id);
  const baseUrl = (options?.baseUrl || target.appUrl || '').replace(/\/+$/, '');
  const runStartedAt = Date.now();
  const reportMeta = {
    askTitle: options?.askTitle || null,
    acceptanceCriteria: options?.acceptanceCriteria || null,
    feature: payload.feature || options?.feature || null,
  };

  // Database · SQL — read-only SELECT asserts against CapBO Postgres
  if (payload.kind === 'database' || payload.engine === 'sql' || kind === 'database') {
    if (!payload?.steps?.length) {
      return res.status(400).json({ error: 'No Database steps to run' });
    }
    try {
      const { config } = await loadDbTarget(req.project.id, prisma);
      if (!config) {
        return res.status(400).json({
          error: 'Database not configured — open Settings → Target database (or set TARGET_DATABASE_URL)',
          skipped: true,
        });
      }
      const result = await runDbAutomation(payload, config);
      const withReport = await attachSavedReport(req.project.id, result, options || {}, {
        kind: 'database',
        collectArtifacts: false,
        runStartedAt,
        ...reportMeta,
        label: options?.label || `Database · ${payload.feature || payload.table || 'schema'}`,
      });
      return res.json({
        ...withReport,
        targetConfigured: true,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  // API HTTP cases — Playwright request context
  if (payload.kind === 'api' || payload.engine === 'http') {
    if (!payload?.steps?.length) {
      return res.status(400).json({ error: 'No API steps to run' });
    }
    try {
      const result = await saveAndRunApiSpec(payload, {
        baseUrl,
        apiBaseUrl: options?.apiBaseUrl || env.TARGET_API_URL || '',
        email: options?.email || target.email || '',
        password: options?.password || target.password || '',
        runMode: options?.runMode || 'background',
        timeoutMs: options?.timeoutMs || 120000,
        title: payload.title || payload.feature,
        matchedFeature: payload.feature,
        action: payload.action,
      });
      const packed = {
        ...result,
        engine: 'playwright-api',
        kind: 'api',
        headless: true,
        runMode: options?.runMode || 'background',
        targetConfigured: !!(env.TARGET_API_URL || baseUrl),
      };
      const withReport = await attachSavedReport(req.project.id, packed, options || {}, {
        kind: 'api',
        collectArtifacts: true,
        runStartedAt,
        ...reportMeta,
        label: options?.label || `API · ${payload.feature || 'run'}`,
      });
      return res.json(withReport);
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  try {
    let runnable = payload;
    if (payload?.steps) {
      const beforeSteps = JSON.stringify(payload.steps || []);
      const before = (payload.steps || []).filter((s) => s.action === 'fill' || s.action === 'select').length;
      runnable = ensureAutomationHasFillSteps(payload, {
        matchedFeature: payload.feature,
        intent: { action: payload.action, testData: payload.data },
      }) || payload;
      const after = (runnable.steps || []).filter((s) => s.action === 'fill' || s.action === 'select').length;
      const changed = beforeSteps !== JSON.stringify(runnable.steps || []);
      if (changed) {
        runnable = {
          ...runnable,
          _planRefreshed: true,
          _planFillCount: { before, after },
        };
      }
    }

    if (!runnable?.steps?.length) {
      return res.status(400).json({ error: 'No UI steps to write into a Playwright spec' });
    }

    const runOpts = {
      baseUrl,
      email: options?.email || target.email || '',
      password: options?.password || target.password || '',
      headless: options?.headless === true,
      runMode: options?.runMode || (options?.headless ? 'background' : 'foreground'),
      timeoutMs: options?.timeoutMs || 180000,
      title: runnable.title || payload.title,
      matchedFeature: runnable.feature,
      action: runnable.action,
      recordVideo: options?.recordVideo
        || (options?.runMode === 'foreground' || options?.headless === false ? 'on' : 'retain-on-failure'),
    };

    const resultMeta = {
      engine: 'playwright-cli',
      headless: options?.headless === true,
      runMode: runOpts.runMode,
      targetConfigured: !!baseUrl,
      planRefreshed: !!runnable._planRefreshed,
      planFillCount: runnable._planFillCount || null,
      kind: 'ui',
    };

    if (options?.streamSteps) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const writeEvt = (evt) => {
        try {
          res.write(`${JSON.stringify(evt)}\n`);
        } catch {
          /* client disconnected */
        }
      };

      const result = await saveAndRunPlaywrightSpec(runnable, {
        ...runOpts,
        onProgress: (evt) => writeEvt(evt),
      });

      const withReport = await attachSavedReport(req.project.id, { ...result, ...resultMeta }, options || {}, {
        kind: 'ui',
        collectArtifacts: true,
        runStartedAt,
        ...reportMeta,
        label: options?.label || `UI · ${runnable.feature || 'run'}`,
      });
      writeEvt({ type: 'done', result: withReport });
      return res.end();
    }

    const result = await saveAndRunPlaywrightSpec(runnable, runOpts);
    const withReport = await attachSavedReport(req.project.id, { ...result, ...resultMeta }, options || {}, {
      kind: 'ui',
      collectArtifacts: true,
      runStartedAt,
      ...reportMeta,
      label: options?.label || `UI · ${runnable.feature || 'run'}`,
    });

    res.json(withReport);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Playwright spec run failed', passed: false });
  }
});

// Save Playwright spec to nocta-backend/generated-e2e/ (does not run).
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
