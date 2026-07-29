// Server-side GitLab client. Uses node:https so ALLOW_INSECURE_TLS can disable cert checks
// (native fetch/undici often ignores NODE_TLS_REJECT_UNAUTHORIZED).
// If Node hits EPERM (macOS long-lived process → private GitLab IP), retry via curl.

import https from 'node:https';
import { spawn } from 'node:child_process';
import { env } from '../../env.js';

const pid = (p) => (/^\d+$/.test(String(p)) ? String(p) : encodeURIComponent(String(p).replace(/^\/+|\/+$/g, '')));

function wrapFetchError(e, hint) {
  const cause = e?.cause?.message || e?.cause?.code || e?.code || '';
  const msg = e?.message || String(e);
  if (/fetch failed|UNABLE_TO_VERIFY|CERT_|self.signed|ECONNREFUSED|ENOTFOUND|EPERM|certificate/i.test(`${msg} ${cause}`)) {
    const err = new Error(
      `${hint}: ${msg}${cause ? ` (${cause})` : ''}. ` +
      'If this is a self-hosted GitLab with an internal cert, set ALLOW_INSECURE_TLS=true in the Cap QA backend .env and restart the backend.',
    );
    err.status = 502;
    return err;
  }
  return e;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.GITLAB_HTTP_TIMEOUT_MS || 20000);

function isEperm(e) {
  return /EPERM|operation not permitted/i.test(`${e?.code || ''} ${e?.message || ''}`);
}

function curlGet(urlString, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS', '-g',
      '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '-w', '\n%{http_code}',
      '-H', `PRIVATE-TOKEN: ${headers['PRIVATE-TOKEN'] || ''}`,
    ];
    if (env.ALLOW_INSECURE_TLS) args.push('-k');
    args.push(urlString);
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !out) {
        reject(Object.assign(new Error(err.trim() || `curl exited ${code}`), { code: 'EPERM' }));
        return;
      }
      const nl = out.lastIndexOf('\n');
      const body = nl >= 0 ? out.slice(0, nl) : out;
      const status = Number(nl >= 0 ? out.slice(nl + 1) : 0) || 0;
      resolve({
        status,
        statusText: '',
        ok: status >= 200 && status < 300,
        text: async () => body,
        json: async () => JSON.parse(body || 'null'),
      });
    });
  });
}

/** HTTPS GET that respects ALLOW_INSECURE_TLS via rejectUnauthorized. */
function httpsGetOnce(urlString, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        rejectUnauthorized: !env.ALLOW_INSECURE_TLS,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            text: async () => body,
            json: async () => JSON.parse(body || 'null'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      const err = new Error(`GitLab request timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

async function httpsGet(urlString, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // macOS long-lived Node often gets EPERM to private GitLab IPs; curl still works.
  const preferCurl = process.platform === 'darwin' || process.env.GITLAB_HTTP_VIA_CURL === 'true';
  if (preferCurl) {
    try {
      return await curlGet(urlString, headers, timeoutMs);
    } catch (e) {
      console.warn('[gitlab] curl failed, trying Node HTTPS:', e.message);
      return httpsGetOnce(urlString, headers, timeoutMs);
    }
  }
  try {
    return await httpsGetOnce(urlString, headers, timeoutMs);
  } catch (e) {
    if (!isEperm(e)) throw e;
    console.warn('[gitlab] Node EPERM — fetching GitLab via curl');
    return curlGet(urlString, headers, timeoutMs);
  }
}

async function glFetch(base, token, path, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(base.replace(/\/+$/, '') + '/api/v4' + path);
  Object.entries(params || {}).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  let res;
  try {
    res = await httpsGet(url.toString(), { 'PRIVATE-TOKEN': token }, timeoutMs);
  } catch (e) {
    throw wrapFetchError(e, `Cannot reach GitLab at ${base}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitLab ${res.status}: ${body.slice(0, 160) || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Quick reachability check — use before live hydrate so we don't burn 20s×N files. */
export async function pingGitlab(base, token, timeoutMs = 3000) {
  await glFetch(base, token, '/user', null, timeoutMs);
  return true;
}

export async function verifyAccount(base, token) {
  const u = await glFetch(base, token, '/user');
  return { id: u.id, username: u.username, name: u.name || u.username };
}

export async function listProjects(base, token, search) {
  const ps = await glFetch(base, token, '/projects', {
    membership: true, per_page: 50, order_by: 'last_activity_at', simple: true, ...(search ? { search } : {}),
  });
  return ps.map((p) => ({ id: p.id, name: p.path_with_namespace, title: p.name, branch: p.default_branch, description: p.description || '', webUrl: p.web_url }));
}

export async function getProjectWithTree(base, token, projectPath) {
  const p = await glFetch(base, token, `/projects/${pid(projectPath)}`);
  let files = [];
  try {
    const tree = await glFetch(base, token, `/projects/${pid(projectPath)}/repository/tree`, { recursive: true, per_page: 100, ref: p.default_branch });
    files = tree.filter((t) => t.type === 'blob').map((t) => t.path).slice(0, 200);
  } catch { /* needs read_repository */ }
  return {
    name: p.path_with_namespace,
    branch: p.default_branch,
    webUrl: p.web_url,
    language: p.description ? p.description.slice(0, 60) : 'GitLab project',
    files,
    summary: `${p.name_with_namespace}${p.description ? ' — ' + p.description : ''}. Default branch: ${p.default_branch}.`,
  };
}

export async function listBranches(base, token, projectPath) {
  const bs = await glFetch(base, token, `/projects/${pid(projectPath)}/repository/branches`, { per_page: 100 });
  return bs.map((b) => ({ name: b.name, default: b.default }));
}

export async function fetchTree(base, token, projectPath, ref) {
  try {
    const tree = await glFetch(base, token, `/projects/${pid(projectPath)}/repository/tree`, { recursive: true, per_page: 100, ref });
    return tree.filter((t) => t.type === 'blob').map((t) => t.path).slice(0, 200);
  } catch { return []; }
}

/** Paginated full tree (all blob paths) for RAG indexing. */
export async function fetchFullTree(base, token, projectPath, ref) {
  const paths = [];
  let page = 1;
  while (page <= 50) {
    const tree = await glFetch(base, token, `/projects/${pid(projectPath)}/repository/tree`, {
      recursive: true, per_page: 100, ref, page,
    });
    if (!Array.isArray(tree) || !tree.length) break;
    for (const t of tree) {
      if (t.type === 'blob' && t.path) paths.push(t.path);
    }
    if (tree.length < 100) break;
    page += 1;
  }
  return paths;
}

/**
 * Recursive tree under a folder (e.g. src/app/pages/articles).
 * Used by live hydrate when the RAG catalog is empty/mid-reindex.
 */
export async function fetchTreeUnderPath(base, token, projectPath, ref, pathPrefix, {
  maxPages = 10,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const prefix = String(pathPrefix || '').replace(/^\/+|\/+$/g, '');
  if (!prefix) return [];
  const paths = [];
  let page = 1;
  while (page <= maxPages) {
    const tree = await glFetch(
      base,
      token,
      `/projects/${pid(projectPath)}/repository/tree`,
      { path: prefix, recursive: true, per_page: 100, ref, page },
      timeoutMs,
    );
    if (!Array.isArray(tree) || !tree.length) break;
    for (const t of tree) {
      if (t.type === 'blob' && t.path) paths.push(t.path);
    }
    if (tree.length < 100) break;
    page += 1;
  }
  return paths;
}

/** Raw file contents for a path at ref. */
export async function fetchFileRaw(base, token, projectPath, filePath, ref, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(
    base.replace(/\/+$/, '') +
    `/api/v4/projects/${pid(projectPath)}/repository/files/${encodeURIComponent(filePath)}/raw`,
  );
  url.searchParams.set('ref', ref);
  let res;
  try {
    res = await httpsGet(url.toString(), { 'PRIVATE-TOKEN': token }, timeoutMs);
  } catch (e) {
    throw wrapFetchError(e, `Cannot fetch file from GitLab at ${base}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitLab ${res.status}: ${body.slice(0, 120) || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}
