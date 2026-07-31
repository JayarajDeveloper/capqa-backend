// Index a connected GitLab repo into CodeChunk rows for RAG retrieval.

import { prisma } from '../../db.js';
import { decrypt } from '../crypto.js';
import * as GL from '../scm/gitlab.js';
import { shouldIndexPath, languageOf, chunkFile } from './chunk.js';
import { embedTexts } from './embed.js';

const BATCH = 16;
const MAX_FILES = 1500;
/** No heartbeat for this long → treat as stuck (process hang, not normal slowness). */
const STALE_INDEX_MS = Number(process.env.RAG_INDEX_STALE_MS || 15 * 60 * 1000);

const activeJobs = new Map();

function cuid() {
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function ensureIndexRow(repoId) {
  return prisma.repoIndex.upsert({
    where: { repoId },
    update: {},
    create: { repoId, status: 'pending' },
  });
}

async function insertChunk({ id, path, startLine, endLine, language, content, embedding, repoId, projectId }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CodeChunk" (id, path, "startLine", "endLine", language, content, embedding, search, "repoId", "projectId")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, to_tsvector('english', $6), $8, $9)`,
    id,
    path,
    startLine,
    endLine,
    language,
    content,
    embedding ? JSON.stringify(embedding) : null,
    repoId,
    projectId,
  );
}

async function heartbeat(repoId, { fileCount, chunkCount }) {
  await prisma.repoIndex.update({
    where: { repoId },
    data: { fileCount, chunkCount },
  });
}

/**
 * Mark indexes stuck in "indexing" as failed so the UI can retry.
 * Called on server startup (process kill) and periodically from status reads.
 */
export async function recoverStaleIndexes({ onStartup = false } = {}) {
  if (onStartup) {
    const n = await prisma.repoIndex.updateMany({
      where: { status: 'indexing' },
      data: {
        status: 'failed',
        error: 'Indexing interrupted (server restarted). Click Index to retry.',
      },
    });
    if (n.count) console.warn(`[rag] reset ${n.count} interrupted index job(s) after startup`);
    return n.count;
  }

  const cutoff = new Date(Date.now() - STALE_INDEX_MS);
  const stale = await prisma.repoIndex.findMany({
    where: { status: 'indexing', updatedAt: { lt: cutoff } },
    include: { repo: { select: { name: true } } },
  });
  for (const row of stale) {
    await prisma.repoIndex.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        error: 'Indexing timed out (no progress). Click Index to retry.',
      },
    });
    console.warn('[rag] recovered stale index', row.repo?.name || row.repoId);
  }
  return stale.length;
}

/**
 * Full re-index of one repo. Safe to call repeatedly.
 */
export async function indexRepo(repoId, { apiKey = null, provider = 'deepseek', baseUrl = null } = {}) {
  if (activeJobs.has(repoId)) {
    return activeJobs.get(repoId);
  }

  const job = (async () => {
    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
      include: { connector: true },
    });
    if (!repo) throw new Error('Repo not found');
    if (repo.provider !== 'GITLAB') throw new Error('Only GitLab repos can be indexed right now');

    await ensureIndexRow(repoId);
    await prisma.repoIndex.update({
      where: { repoId },
      data: { status: 'indexing', error: null, fileCount: 0, chunkCount: 0 },
    });

    try {
      const token = decrypt(repo.connector.tokenCipher);
      const base = repo.connector.baseUrl;
      console.log(`[rag] indexing ${repo.name} @ ${repo.branch}…`);
      const paths = (await GL.fetchFullTree(base, token, repo.name, repo.branch))
        .filter(shouldIndexPath)
        .slice(0, MAX_FILES);

      await prisma.codeChunk.deleteMany({ where: { repoId } });

      let chunkCount = 0;
      let filesProcessed = 0;
      const pending = [];

      const flush = async () => {
        if (!pending.length) return;
        const batch = pending.splice(0, pending.length);
        let embeddings = null;
        try {
          embeddings = await embedTexts(
            batch.map((b) => `${b.path}\n${b.content}`),
            { apiKey, provider, baseUrl },
          );
        } catch (e) {
          console.warn('[rag] embed batch failed, continuing with FTS only:', e.message);
        }
        for (let i = 0; i < batch.length; i++) {
          const b = batch[i];
          await insertChunk({
            id: cuid(),
            path: b.path,
            startLine: b.startLine,
            endLine: b.endLine,
            language: b.language,
            content: b.content,
            embedding: embeddings?.[i] || null,
            repoId: repo.id,
            projectId: repo.projectId,
          });
          chunkCount++;
        }
        await heartbeat(repoId, { fileCount: filesProcessed, chunkCount });
      };

      for (const path of paths) {
        let raw;
        try {
          raw = await GL.fetchFileRaw(base, token, repo.name, path, repo.branch);
        } catch {
          continue;
        }
        filesProcessed++;
        if (!raw || raw.length > 300_000) continue;
        const language = languageOf(path);
        for (const ch of chunkFile(raw)) {
          pending.push({ path, language, ...ch });
          if (pending.length >= BATCH) await flush();
        }
        if (filesProcessed % 75 === 0) {
          console.log(`[rag] ${repo.name}: ${filesProcessed}/${paths.length} files · ${chunkCount} chunks`);
          await heartbeat(repoId, { fileCount: filesProcessed, chunkCount });
        }
      }
      await flush();

      await prisma.repo.update({
        where: { id: repoId },
        data: { files: paths.slice(0, 500) },
      });

      await prisma.repoIndex.update({
        where: { repoId },
        data: {
          status: 'ready',
          fileCount: paths.length,
          chunkCount,
          error: null,
          commitSha: `${repo.branch}@${Date.now()}`,
        },
      });

      console.log(`[rag] done ${repo.name}: ${paths.length} files · ${chunkCount} chunks`);
      return { fileCount: paths.length, chunkCount };
    } catch (e) {
      await prisma.repoIndex.update({
        where: { repoId },
        data: { status: 'failed', error: String(e.message || e).slice(0, 500) },
      });
      console.error('[rag] index failed', repoId, e.message);
      throw e;
    }
  })();

  activeJobs.set(repoId, job);
  try {
    return await job;
  } finally {
    activeJobs.delete(repoId);
  }
}

export async function indexActiveRepos(projectId, embedOpts) {
  const repos = await prisma.repo.findMany({ where: { projectId, active: true } });
  const results = [];
  for (const r of repos) {
    try {
      results.push({ repoId: r.id, name: r.name, ...(await indexRepo(r.id, embedOpts)) });
    } catch (e) {
      results.push({ repoId: r.id, name: r.name, error: e.message });
    }
  }
  return results;
}

export async function getIndexStatus(projectId) {
  await recoverStaleIndexes();
  const repos = await prisma.repo.findMany({
    where: { projectId },
    include: { index: true },
    orderBy: { createdAt: 'asc' },
  });
  return repos.map((r) => ({
    repoId: r.id,
    name: r.name,
    active: r.active,
    status: r.index?.status || 'pending',
    fileCount: r.index?.fileCount || 0,
    chunkCount: r.index?.chunkCount || 0,
    error: r.index?.error || null,
    updatedAt: r.index?.updatedAt || null,
  }));
}
