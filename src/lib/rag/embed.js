// Embedding helpers — Anthropic has no embeddings API.
// RAG falls back to lexical / keyword retrieval when embeddings are unavailable.

/** @returns {Promise<number[]|null>} */
export async function embedTexts(_texts, { apiKey, provider } = {}) {
  if (!apiKey || !_texts?.length) return null;
  // Anthropic (and any non-embedding provider): skip vector search.
  if (!provider || provider === 'anthropic') return null;
  return null;
}

export async function embedOne(text, opts) {
  const arr = await embedTexts([text], opts);
  return arr?.[0] || null;
}
