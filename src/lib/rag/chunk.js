// Chunk source files into overlapping windows for RAG indexing.

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor',
  '__pycache__', '.turbo', '.cache', 'target', 'Pods', '.idea', '.vscode',
  'devops', 'keycloak', 'keycloack', 'migrations_bk', 'helm', 'terraform',
]);

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.lock',
  '.map', '.min.js', '.min.css', '.bin', '.exe', '.dll', '.so', '.dylib',
]);

const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'Cargo.lock', '.DS_Store', 'Thumbs.db',
]);

const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.rb': 'ruby', '.php': 'php',
  '.rs': 'rust', '.cs': 'csharp', '.kt': 'kotlin', '.swift': 'swift',
  '.vue': 'vue', '.svelte': 'svelte', '.css': 'css', '.scss': 'scss',
  '.html': 'html', '.md': 'markdown', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql', '.sh': 'shell', '.graphql': 'graphql', '.prisma': 'prisma',
};

export function shouldIndexPath(path) {
  const parts = path.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p) || p.startsWith('.'))) return false;
  const name = parts[parts.length - 1] || '';
  if (SKIP_NAMES.has(name)) return false;
  if (name.startsWith('.env')) return false;
  const lower = name.toLowerCase();
  for (const ext of SKIP_EXT) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}

export function languageOf(path) {
  const m = path.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return (m && LANG_BY_EXT[m[1]]) || null;
}

/**
 * Split file content into overlapping line windows.
 * @returns {{ startLine: number, endLine: number, content: string }[]}
 */
export function chunkFile(content, { maxLines = 80, overlap = 12 } = {}) {
  if (!content || typeof content !== 'string') return [];
  // Guard against huge / binary-ish blobs
  if (content.length > 400_000) return [];
  if (content.includes('\0')) return [];

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0) return [];

  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, end).join('\n').trim();
    if (slice.length >= 40) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        content: slice.slice(0, 12_000),
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
