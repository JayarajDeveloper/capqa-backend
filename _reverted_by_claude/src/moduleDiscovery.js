/**
 * Shared module discovery for CLI generators — reads the LIVE capbo-frontend
 * source on disk and produces the code context the extractors consume.
 * Generic rules only: no per-module paths, no hardcoded component names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatChunksForPrompt } from '../rag/retrieve.js';

/** Pilot scope: the 5 selected modules (pages/ folder names). Extend via CLI, not code. */
export const DEFAULT_MODULES = ['vat', 'eco-tax', 'partners', 'currencies', 'retail_chain'];

export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Feature display name from the folder (retail_chain → Retail Chain). */
export function featureName(folder) {
  return folder.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Discover list/detail component files for pages/<folder> — generic rule. */
export function discoverModuleFiles(feRoot, folder) {
  const dir = path.join(feRoot, 'src', 'app', 'pages', folder);
  if (!fs.existsSync(dir)) throw new Error(`No such module folder: pages/${folder}`);
  const files = walk(dir).filter((f) => !/\.spec\./.test(f));
  const htmls = files.filter((f) => f.endsWith('.component.html'));
  const listHtml = htmls.find((f) => /-list\.component\.html$/.test(f));
  const detailHtml = htmls.find((f) => !/-list\.component\.html$/.test(f));
  if (!listHtml || !detailHtml) {
    throw new Error(`pages/${folder}: need one *-list.component.html and one detail template (found ${htmls.length})`);
  }
  const maybe = (f) => (fs.existsSync(f) ? f : null);
  return {
    listHtml,
    detailHtml,
    detailTs: maybe(detailHtml.replace(/\.html$/, '.ts')),
    listTs: maybe(listHtml.replace(/\.html$/, '.ts')),
  };
}

function chunk(feRoot, absPath, content) {
  const rel = path.relative(feRoot, absPath).replace(/\\/g, '/');
  return { path: `src/${rel.replace(/^src\//, '')}`, content, startLine: 1, endLine: content.split('\n').length };
}

/** Full-file code context for a module (list + detail HTML/TS). */
export function buildModuleContext(feRoot, folder) {
  const f = discoverModuleFiles(feRoot, folder);
  const read = (p) => fs.readFileSync(p, 'utf8');
  const chunks = [
    chunk(feRoot, f.listHtml, read(f.listHtml)),
    chunk(feRoot, f.detailHtml, read(f.detailHtml)),
    ...(f.detailTs ? [chunk(feRoot, f.detailTs, read(f.detailTs))] : []),
    ...(f.listTs ? [chunk(feRoot, f.listTs, read(f.listTs))] : []),
  ];
  return { files: f, chunks, codeContext: formatChunksForPrompt(chunks) };
}

/** Parse the shared confirmation dialog's confirm testid — metadata, not a constant. */
export function confirmTestIdFromSharedDialog(feRoot) {
  const pagesDir = path.join(feRoot, 'src', 'app', 'pages');
  if (!fs.existsSync(pagesDir)) return null;
  const candidates = walk(pagesDir).filter((f) => /confirmation[^/]*\.component\.html$/.test(f));
  for (const f of candidates) {
    const html = fs.readFileSync(f, 'utf8');
    const m = html.match(/\(click\)="onConfirm\(\)"[^>]*data-testid="([^"]+)"/)
      || html.match(/data-testid="([^"]+)"[^>]*\(click\)="onConfirm\(\)"/);
    if (m) return m[1];
  }
  return null;
}

/** LLM credentials from env — Settings-DB keys belong to the server, not CLIs. */
export function llmFromEnv(env = process.env) {
  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5' };
  }
  if (env.GEMINI_API_KEY || env.API_KEY) {
    return { provider: 'gemini', apiKey: env.GEMINI_API_KEY || env.API_KEY, model: env.GEMINI_MODEL || 'gemini-2.5-flash' };
  }
  return null;
}
