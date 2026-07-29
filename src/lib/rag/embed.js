// Embedding helpers — Gemini only (text-embedding-004 retired from v1beta).
// Docs: https://ai.google.dev/gemini-api/docs/embeddings

import { env } from '../../env.js';

/** Stable text embedding model (flexible dims; we pin 768 for RAG compatibility). */
const GEMINI_EMBED = (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim();
const OUTPUT_DIMS = Number(process.env.GEMINI_EMBED_DIMS || 768);

/** @returns {Promise<number[]|null>} */
export async function embedTexts(texts, { apiKey, provider, baseUrl } = {}) {
  if (!apiKey || !texts?.length) return null;
  if (provider && provider !== 'gemini') return null;

  const base = (baseUrl || env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models')
    .replace(/\/+$/, '');
  const url = `${base}/${GEMINI_EMBED}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        model: `models/${GEMINI_EMBED}`,
        content: { parts: [{ text: String(t).slice(0, 7000) }] },
        outputDimensionality: OUTPUT_DIMS,
      })),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini embeddings ${res.status}: ${t.slice(0, 220)}`);
  }
  const data = await res.json();
  return (data.embeddings || []).map((e) => e.values || null);
}

export async function embedOne(text, opts) {
  const arr = await embedTexts([text], opts);
  return arr?.[0] || null;
}
