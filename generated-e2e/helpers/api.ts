/**
 * Spec API helpers — auth token + HTTP against TARGET_API_URL.
 * Cookie name is configurable via CAPQA_ACCESS_TOKEN_COOKIE (default: access_token).
 */
import type { APIRequestContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = path.resolve(__dirname, '../.auth/user.json');

function accessTokenCookieName(): string {
  return process.env.CAPQA_ACCESS_TOKEN_COOKIE || 'access_token';
}

function apiBase(): string {
  const raw = (process.env.TARGET_API_URL || '').trim().replace(/\/+$/, '');
  if (raw) return raw;
  throw new Error('TARGET_API_URL is not set');
}

/** Read bearer token from Playwright storageState cookies. */
export async function ensureAccessToken(_request?: APIRequestContext): Promise<string | null> {
  try {
    if (!fs.existsSync(AUTH_STATE_PATH)) return null;
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
    const cookies = state?.cookies || [];
    const name = accessTokenCookieName();
    const hit = cookies.find((c: { name?: string }) => c.name === name)
      || cookies.find((c: { name?: string }) => /access.?token/i.test(String(c.name || '')));
    return hit?.value || null;
  } catch {
    return null;
  }
}

/** @deprecated Use ensureAccessToken */
export const ensureCapboAccessToken = ensureAccessToken;

export async function targetApiRequest(
  request: APIRequestContext,
  opts: { method?: string; path: string; body?: unknown; token?: string | null },
) {
  const method = (opts.method || 'GET').toUpperCase();
  const url = `${apiBase()}${opts.path.startsWith('/') ? opts.path : `/${opts.path}`}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body != null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }
  return request.fetch(url, {
    method,
    headers,
    data: opts.body != null && method !== 'GET' && method !== 'HEAD'
      ? JSON.stringify(opts.body)
      : undefined,
  });
}

/** @deprecated Use targetApiRequest */
export const capboApiRequest = targetApiRequest;

/**
 * Resolve `__first__` placeholders by GETting indexed enum/dropdown endpoints.
 * Each resolver: { field, path, pick: 'value'|'id' }
 */
export async function resolveApiFirstOptions(
  request: APIRequestContext,
  body: Record<string, unknown>,
  resolvers: Array<{ field: string; path: string; pick?: string }> = [],
  token?: string | null,
): Promise<Record<string, unknown>> {
  const next = { ...body };
  for (const r of resolvers || []) {
    if (!r?.field || !r?.path) continue;
    if (next[r.field] !== '__first__' && next[r.field] !== 'first' && next[r.field] != null && next[r.field] !== '') {
      continue;
    }
    try {
      const res = await targetApiRequest(request, { method: 'GET', path: r.path, token });
      if (!res.ok()) continue;
      const data = await res.json().catch(() => null);
      const rows = Array.isArray(data) ? data
        : Array.isArray(data?.['hydra:member']) ? data['hydra:member']
          : Array.isArray(data?.data) ? data.data
            : Array.isArray(data?.items) ? data.items
              : [];
      const first = rows[0];
      if (first == null) continue;
      const pick = (r.pick || 'value').toLowerCase();
      next[r.field] = typeof first === 'object'
        ? (first[pick] ?? first.id ?? first.value ?? first.code)
        : first;
    } catch {
      /* leave placeholder */
    }
  }
  return next;
}
