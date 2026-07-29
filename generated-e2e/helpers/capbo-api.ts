/**
 * CapBO API helpers for Playwright API specs (no browser UI).
 * Auth reuses SSO cookies from UI Foreground runs, and refreshes when expired.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = path.resolve(__dirname, '../.auth/user.json');

type AuthCookies = {
  access: string;
  refresh: string;
  raw: { cookies?: Array<{ name?: string; value?: string }> };
};

export function resolveApiBaseUrl(): string {
  const raw = (process.env.TARGET_API_URL || '').trim();
  if (raw) {
    try {
      const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
      return u.toString().replace(/\/+$/, '');
    } catch {
      return raw.replace(/\/+$/, '');
    }
  }
  return 'http://localhost:8000/api';
}

export function resolveTenant(): string {
  const app = (process.env.TARGET_APP_URL || '').trim();
  if (!app) return 'bota';
  try {
    const u = new URL(app.includes('://') ? app : `http://${app}`);
    return u.searchParams.get('tenant') || 'bota';
  } catch {
    return 'bota';
  }
}

function readAuthCookies(): AuthCookies {
  try {
    if (!fs.existsSync(AUTH_STATE_PATH)) return { access: '', refresh: '', raw: {} };
    const raw = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
    const cookies = Array.isArray(raw?.cookies) ? raw.cookies : [];
    const get = (name: string) => String(cookies.find((c: { name?: string }) => c?.name === name)?.value || '').trim();
    return {
      access: get('capbo_access_token'),
      refresh: get('capbo_refresh_token'),
      raw,
    };
  } catch {
    return { access: '', refresh: '', raw: {} };
  }
}

/** Sync read — prefer ensureCapboAccessToken() which refreshes when expired. */
export function loadCapboAccessToken(): string {
  return readAuthCookies().access;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isAccessTokenFresh(token: string, skewSec = 60): boolean {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  if (!exp) return true; // opaque token — try it
  return exp > Math.floor(Date.now() / 1000) + skewSec;
}

function persistAccessToken(access: string, refresh?: string): void {
  try {
    if (!fs.existsSync(AUTH_STATE_PATH) || !access) return;
    const raw = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    const upsert = (name: string, value: string) => {
      const hit = cookies.find((c: { name?: string }) => c?.name === name);
      if (hit) hit.value = value;
      else cookies.push({ name, value, domain: 'localhost', path: '/' });
    };
    upsert('capbo_access_token', access);
    if (refresh) upsert('capbo_refresh_token', refresh);
    raw.cookies = cookies;
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(raw, null, 2), 'utf8');
  } catch {
    /* best-effort cache update */
  }
}

function joinUrl(base: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const b = base.replace(/\/+$/, '');
  let p = String(pathOrUrl || '');
  if (b.endsWith('/api') && p.startsWith('/api/')) p = p.slice(4);
  if (!p.startsWith('/')) p = `/${p}`;
  return `${b}${p}`;
}

/**
 * Return a usable CapBO Bearer token. Refreshes via POST /auth/refresh when the
 * cached access token is missing or expired (common after UI session ages out).
 */
export async function ensureCapboAccessToken(request: APIRequestContext): Promise<string> {
  const { access, refresh } = readAuthCookies();
  if (isAccessTokenFresh(access)) return access;

  if (!refresh) {
    throw new Error(
      'No CapBO token (or refresh). Run a UI Foreground compose once to cache SSO, then retry API.',
    );
  }

  const tenant = resolveTenant();
  const refreshUrl = new URL(joinUrl(resolveApiBaseUrl(), '/auth/refresh'));
  refreshUrl.searchParams.set('tenant', tenant);

  // Do NOT send expired Bearer — CapBO JWT firewall returns 401 before refresh runs.
  const res = await request.fetch(refreshUrl.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Tenant-Subdomain': tenant,
    },
    form: { refresh_token: refresh },
  });

  const raw = await res.text();
  if (!res.ok()) {
    throw new Error(
      `Token refresh failed (${res.status()}): ${raw.slice(0, 240)}. Run a UI Foreground test to renew SSO.`,
    );
  }

  let json: { data?: { access_token?: string; refresh_token?: string }; access_token?: string } = {};
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Token refresh returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const nextAccess = String(json?.data?.access_token || json?.access_token || '').trim();
  const nextRefresh = String(json?.data?.refresh_token || refresh).trim();
  if (!nextAccess) {
    throw new Error(`Token refresh succeeded but no access_token in body: ${raw.slice(0, 200)}`);
  }

  persistAccessToken(nextAccess, nextRefresh);
  return nextAccess;
}

export async function capboApiRequest(
  request: APIRequestContext,
  opts: {
    method: string;
    path: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
): Promise<APIResponse> {
  const token = opts.token || await ensureCapboAccessToken(request);
  const tenant = resolveTenant();
  const url = new URL(joinUrl(resolveApiBaseUrl(), opts.path));
  if (!url.searchParams.has('tenant')) url.searchParams.set('tenant', tenant);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Tenant-Subdomain': tenant,
    ...(opts.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const method = String(opts.method || 'GET').toUpperCase();
  return request.fetch(url.toString(), {
    method,
    headers,
    data: opts.body != null && method !== 'GET' && method !== 'HEAD'
      ? opts.body
      : undefined,
  });
}

/**
 * UI “first option” for API: GET a CapBO list/enum endpoint and return the first row’s field.
 * Examples: /api/shared/enum-values/ecotax_category → value, /api/vats/dropdowns → id
 */
export async function pickFirstApiOption(
  request: APIRequestContext,
  opts: {
    path: string;
    pick?: string;
    token?: string;
  },
): Promise<string | number | boolean | null> {
  const res = await capboApiRequest(request, {
    method: 'GET',
    path: opts.path,
    token: opts.token,
  });
  const raw = await res.text();
  if (!res.ok()) {
    throw new Error(`First-option fetch failed ${opts.path} (${res.status()}): ${raw.slice(0, 200)}`);
  }
  let json: { data?: unknown } = {};
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`First-option non-JSON from ${opts.path}: ${raw.slice(0, 160)}`);
  }
  const rows = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  if (!rows.length) {
    throw new Error(`No options returned from ${opts.path} — cannot pick first`);
  }
  const row = rows[0] as Record<string, unknown>;
  const pick = String(opts.pick || 'value');
  const val = row?.[pick] ?? row?.id ?? row?.code ?? row?.value;
  if (val == null || val === '') {
    throw new Error(`First row from ${opts.path} has no "${pick}" (keys: ${Object.keys(row || {}).join(',')})`);
  }
  return val as string | number | boolean;
}

/** Resolve several __first__ body fields in one go. Mutates and returns body. */
export async function resolveApiFirstOptions(
  request: APIRequestContext,
  body: Record<string, unknown>,
  resolvers: Array<{ field: string; path: string; pick?: string }>,
  token?: string,
): Promise<Record<string, unknown>> {
  const next = { ...body };
  for (const r of resolvers || []) {
    const cur = next[r.field];
    if (cur != null && cur !== '' && cur !== '__first__' && cur !== 'first') continue;
    next[r.field] = await pickFirstApiOption(request, {
      path: r.path,
      pick: r.pick || (r.field.endsWith('_id') ? 'id' : 'value'),
      token,
    });
  }
  return next;
}

