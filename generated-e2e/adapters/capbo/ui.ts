/**
 * Shared UI helpers for Cap QA generated Playwright specs.
 * Fast path: reuse storageState from auth.setup (no Keycloak per test).
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TICK_MS = 30;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_STATE_PATH = path.resolve(__dirname, '../.auth/user.json');
const AUTH_ORIGIN_PATH = path.resolve(__dirname, '../.auth/origin');

export function hasSavedAuth(): boolean {
  try {
    return fs.existsSync(AUTH_STATE_PATH);
  } catch {
    return false;
  }
}

function appOrigin(): string {
  const baseUrl = process.env.TARGET_APP_URL || '';
  if (!baseUrl) throw new Error('TARGET_APP_URL is not set');
  return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
}

function landingUrl(baseUrl: string, includeTenant: boolean): string {
  const u = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`);
  if (!includeTenant) u.searchParams.delete('tenant');
  return u.toString();
}

function looksLikeIdp(url: string): boolean {
  return /\/auth\/realms\//i.test(url)
    || /\/realms\/[^/]+\/protocol\/openid-connect/i.test(url)
    || /openid-connect/i.test(url)
    || /keycloak/i.test(url);
}

function appShell(page: Page) {
  return page.locator('mat-sidenav, .list-container, nav, [routerlink]').first();
}

function ssoButton(page: Page) {
  return page
    .locator('button.sso-btn, [data-testid="login-sso"]')
    .or(page.getByRole('button', { name: /sign in with sso|sso|connexion/i }))
    .first();
}

async function pageAlive(page: Page): Promise<boolean> {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

/** Wait while OAuth callback / IDP finishes. Returns false if login page (SSO) is shown. */
export async function waitForAppShell(page: Page, origin: string, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pageAlive(page))) return false;

    const url = page.url();
    if (looksLikeIdp(url) || /\/auth\/callback/i.test(url)) {
      await page.waitForTimeout(200);
      continue;
    }

    if (await ssoButton(page).isVisible().catch(() => false)) {
      return false;
    }

    if (await appShell(page).isVisible().catch(() => false)) return true;

    try {
      const path = new URL(url).pathname;
      if (url.startsWith(origin) && path !== '/' && !/\/login\/?$/i.test(path)) return true;
    } catch { /* ignore */ }

    await page.waitForTimeout(200);
  }
  return await looksLoggedIn(page);
}

/** True when app shell is visible and we are not on login/Keycloak/callback. */
async function looksLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (looksLikeIdp(url) || /\/auth\/callback/i.test(url)) return false;
  try {
    if (/\/login\/?$/i.test(new URL(url).pathname)) return false;
  } catch { /* ignore */ }
  const sso = ssoButton(page);
  if (await sso.isVisible().catch(() => false)) return false;
  const shell = await appShell(page).isVisible().catch(() => false);
  if (shell) return true;
  return page.locator('app-root').first().isVisible().catch(() => false);
}

async function waitForSsoButton(page: Page, timeoutMs = 15000): Promise<ReturnType<Page['locator']> | null> {
  const btn = ssoButton(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pageAlive(page))) return null;
    if (await btn.isVisible().catch(() => false)) return btn;
    await page.waitForTimeout(150);
  }
  return null;
}

async function performSsoLogin(page: Page, baseUrl: string, origin: string, email: string, password: string): Promise<boolean> {
  await page.goto(landingUrl(baseUrl, true), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const ssoBtn = await waitForSsoButton(page, 20000);
  if (!ssoBtn) return false;

  await ssoBtn.click({ timeout: 10000 });
  await page.waitForTimeout(300);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (looksLikeIdp(url)) break;
    if (await looksLoggedIn(page)) return true;
    const userInput = page.locator('#username, input[name="username"]').first();
    if (await userInput.isVisible({ timeout: 500 }).catch(() => false)) break;
    await page.waitForTimeout(150);
  }

  if (await looksLoggedIn(page)) return true;

  const userInput = page.locator('#username, input[name="username"]').first();
  if (!(await userInput.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  if (!email || !password) {
    throw new Error('Keycloak visible but APP_TEST_USERNAME / APP_TEST_PASSWORD not set');
  }

  await userInput.fill(email);
  await page.locator('#password, input[name="password"]').first().fill(password);
  await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click();

  await page.waitForURL(
    (url) => url.origin === origin && !looksLikeIdp(url.href),
    { timeout: 90000 },
  ).catch(() => {});

  return waitForAppShell(page, origin, 90000);
}

async function saveAuthState(page: Page, origin: string): Promise<void> {
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
  fs.writeFileSync(AUTH_ORIGIN_PATH, origin, 'utf8');
}

/**
 * Ensure session. With storageState (auth.setup), this is usually <1s.
 * Without it, does full SSO + Keycloak (slow).
 */
export async function ensureTargetSession(page: Page): Promise<void> {
  const baseUrl = process.env.TARGET_APP_URL || '';
  if (!baseUrl.trim()) {
    throw new Error(
      'TARGET_APP_URL is not set (or empty in nocta-backend/.env).\n' +
      'Add e.g. TARGET_APP_URL=http://localhost:4200/?tenant=<tenant>\n' +
      'and APP_TEST_USERNAME / APP_TEST_PASSWORD, then re-run.\n' +
      'Or run from Compose (Settings → App URL) which injects these for you.',
    );
  }
  const origin = appOrigin();
  const email = process.env.APP_TEST_USERNAME || process.env.E2E_USERNAME || '';
  const password = process.env.APP_TEST_PASSWORD || process.env.E2E_PASSWORD || '';
  const warm = hasSavedAuth();

  // Always keep ?tenant= — stripping it after warm auth causes wrong shell / dashboard redirects.
  await page.goto(landingUrl(baseUrl, true), { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (await waitForAppShell(page, origin, 30000)) {
    return;
  }

  if (!(await pageAlive(page))) {
    throw new Error('Browser closed during login — keep the headed window open until the test finishes');
  }

  // Stale storageState cookies — clear and login fresh with tenant
  if (warm) {
    await page.context().clearCookies();
  }

  if (!(await performSsoLogin(page, baseUrl, origin, email, password))) {
    throw new Error(
      `Not logged in at ${page.url()}. Re-run auth setup:\n` +
      '  E2E_AUTH_SETUP=1 TARGET_APP_URL=… APP_TEST_USERNAME=… APP_TEST_PASSWORD=… npm run test:e2e:auth',
    );
  }

  await saveAuthState(page, origin);
}

function pathMatches(url: string, clean: string): boolean {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return p === clean || p.startsWith(`${clean}/`);
  } catch {
    return String(url).includes(clean);
  }
}

/** Exact list path only — /retail-chains/details must NOT count as /retail-chains. */
function isExactPath(url: string, clean: string): boolean {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return p === clean;
  } catch {
    return false;
  }
}

function isDetailsPath(url: string): boolean {
  try {
    return /\/details(\/|$|\?)/i.test(new URL(url).pathname);
  } catch {
    return /\/details/i.test(String(url));
  }
}

/**
 * Leave create/edit/view via Angular (Cancel / back). Prefer this over pushState.
 */
async function leaveDetailView(page: Page): Promise<boolean> {
  if (!isDetailsPath(page.url())) return false;

  const cancel = page.getByRole('button', { name: /^(cancel|annuler)$/i });
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 8000 });
    await page.waitForTimeout(200);
    return !isDetailsPath(page.url());
  }

  const back = page.locator('button').filter({
    has: page.locator('.material-symbols-outlined, mat-icon', { hasText: /^arrow_back$/ }),
  }).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click({ timeout: 8000 });
    await page.waitForTimeout(200);
    return !isDetailsPath(page.url());
  }

  return false;
}

/**
 * In-app SPA navigation. Never treat /…/details as the list route.
 * Prefer Angular Cancel/back from detail; fall back to same-origin goto for list.
 */
export async function spaNavigate(page: Page, path: string): Promise<void> {
  const raw = String(path || '/').trim() || '/';
  let pathOnly = raw;
  let search = '';
  try {
    if (raw.startsWith('http')) {
      const u = new URL(raw);
      pathOnly = u.pathname;
      search = u.search;
    } else {
      const q = raw.indexOf('?');
      if (q >= 0) {
        pathOnly = raw.slice(0, q);
        search = raw.slice(q);
      }
    }
  } catch { /* keep */ }
  const clean = (pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`).replace(/\/+$/, '') || '/';
  const targetUrl = `${clean}${search}`;
  const wantList = !/\/details$/i.test(clean) && !/\/(new|create|edit|view)$/i.test(clean);

  if (isExactPath(page.url(), clean) && (!search || page.url().includes(search))) {
    await page.waitForTimeout(50);
    return;
  }

  // From detail → list: target app Cancel/back uses Router (history.back / navigate)
  if (wantList && isDetailsPath(page.url())) {
    const left = await leaveDetailView(page);
    if (left && isExactPath(page.url(), clean)) {
      await page.waitForTimeout(120);
      return;
    }
  }

  // Prefer routerLink / href in the shell
  const link = page.locator(
    [
      `a[routerlink="${clean}"]`,
      `a[routerLink="${clean}"]`,
      `[routerlink="${clean}"]`,
      `a[href="${clean}"]`,
      `a[href^="${clean}?"]`,
      `a[href="${targetUrl}"]`,
    ].join(', '),
  ).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click({ timeout: 8000 });
  } else if (wantList) {
    // Reliable list open — pushState does not update target app's Angular view
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.evaluate((target) => {
      const abs = `${window.location.origin}${target}`;
      window.history.pushState({ noctaSpa: true }, '', abs);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { noctaSpa: true } }));
    }, targetUrl);
  }

  await page.waitForURL((u) => {
    if (wantList) return isExactPath(String(u), clean);
    return pathMatches(String(u), clean);
  }, { timeout: 15000 }).catch(async () => {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  });

  if (wantList) {
    // Must be list UI — not still the create/edit form
    await page.locator(
      '[data-testid$="-search"], .list-container, [data-testid$="-create"]',
    ).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  } else {
    await page.locator(
      'form, [data-testid$="-name"], [data-testid$="-save"]',
    ).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(120);
}

/** List path from feature route (/retail-chains/details → /retail-chains). */
export function listPathFromRoute(routeOrPath: string): string {
  let p = String(routeOrPath || '/').trim();
  try {
    if (p.startsWith('http')) p = new URL(p).pathname;
  } catch { /* keep */ }
  p = p.split('?')[0].replace(/\/+$/, '') || '/';
  p = p.replace(/\/details.*$/i, '').replace(/\/(new|create|edit|view)(\/|$)/i, '/');
  return p.replace(/\/+$/, '') || '/';
}

/**
 * After save/create: land on list (Angular back or goto), search, assert row.
 * @param assertText — text that must appear in the matched list row
 * @param searchTestId — list search control testId from target app code
 * @param options.searchNeedle — search box value (update: row identity e.g. EUR; create: same as assertText)
 */
export async function verifyInList(
  page: Page,
  listPath: string,
  assertText: string,
  searchTestId?: string | null,
  options?: { searchNeedle?: string },
): Promise<void> {
  const list = listPathFromRoute(listPath);
  const searchValue = String(options?.searchNeedle ?? assertText).trim();
  const expectInRow = String(assertText ?? '').trim();

  // Save step already waited — do not re-wait for API (that caused 25s hangs).
  // target app create often lands on /details?mode=edit; navigate to list when needed.
  await page.waitForURL((u) => isExactPath(String(u), list) || isDetailsPath(String(u)), { timeout: 8000 }).catch(() => {});
  if (!isExactPath(page.url(), list) || isDetailsPath(page.url())) {
    await spaNavigate(page, list);
  }

  // Final guard: still on detail form → force list load
  if (isDetailsPath(page.url()) || await page.getByRole('heading', { name: /create |edit |view /i }).isVisible().catch(() => false)) {
    await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  const search = searchTestId
    ? page.getByTestId(searchTestId)
    : page.locator(
      '[data-testid$="-search"] input, [data-testid$="-search"], input[formcontrolname="searchTerm"], input[formControlName="searchTerm"]',
    ).first();

  await search.waitFor({ state: 'visible', timeout: 20000 });
  await fillAngularField(page, search, searchValue);
  // target app list pages debounce search (~300ms) then call API
  await page.waitForTimeout(900);

  const rowLocator = page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row');

  if (options?.searchNeedle && searchValue !== expectInRow) {
    const row = rowLocator.filter({ hasText: searchValue }).first();
    await row.waitFor({ state: 'visible', timeout: 20000 });
    const rowText = await row.innerText();
    if (!rowText.includes(expectInRow)) {
      throw new Error(
        `List row matching "${searchValue}" does not contain "${expectInRow}". Row: ${rowText.slice(0, 300)}`,
      );
    }
    return;
  }

  await rowLocator.filter({ hasText: expectInRow }).first().waitFor({ state: 'visible', timeout: 20000 });
}

/** After delete: return to list, search, assert row is gone. */
export async function assertAbsentInList(
  page: Page,
  listPath: string,
  absentText: string,
  searchTestId?: string | null,
): Promise<void> {
  const list = listPathFromRoute(listPath);
  const needle = String(absentText ?? '').trim();

  await page.waitForURL((u) => isExactPath(String(u), list), { timeout: 8000 }).catch(() => {});
  if (!isExactPath(page.url(), list) || isDetailsPath(page.url())) {
    await spaNavigate(page, list);
  }

  const search = searchTestId
    ? page.getByTestId(searchTestId)
    : page.locator(
      '[data-testid$="-search"] input, [data-testid$="-search"], input[formcontrolname="searchTerm"], input[formControlName="searchTerm"]',
    ).first();

  await search.waitFor({ state: 'visible', timeout: 20000 });
  await fillAngularField(page, search, needle);
  await page.waitForTimeout(900);

  const rowLocator = page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row');
  await expect(rowLocator.filter({ hasText: needle })).toHaveCount(0, { timeout: 15000 });
}

/** After View: wait for read-only form without requiring Save button. */
export async function waitForViewFormReady(page: Page): Promise<void> {
  await page.locator('form, [data-testid$="-form"], [data-testid$="-name"], [data-testid$="-code"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

/** After Edit: wait for save button + form data load (patchValue) before filling fields. */
export async function waitForEditFormReady(page: Page): Promise<void> {
  await page.locator('[data-testid$="-save"]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('form, [data-testid$="-form"], [data-testid$="-name"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});
  // Let Angular finish async loadCurrencyData / patchValue
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}

function isHeadlessRun(): boolean {
  return process.env.NOCTA_HEADLESS === '1' || process.env.NOCTA_RUN_MODE === 'background';
}

function isSaveLikeResponse(r: import('@playwright/test').Response): boolean {
  if (!r.ok()) return false;
  if (!/^(PUT|PATCH|POST)$/i.test(r.request().method())) return false;
  const url = r.url();
  if (/auth|login|token|keycloak|realms|openid-connect/i.test(url)) return false;
  if (/\.(js|css|png|svg|woff|ico)(\?|$)/i.test(url)) return false;
  return true;
}

/**
 * Brief settle after Save click. Never blocks 25s — response often finishes
 * before this listener starts (click then wait), so short race + URL check.
 */
export async function waitForFormSave(page: Page): Promise<void> {
  if (isDetailsPath(page.url())) {
    await page.waitForTimeout(200);
    return;
  }

  await Promise.race([
    page.waitForResponse(isSaveLikeResponse, { timeout: 4000 }).catch(() => null),
    page.waitForURL((u) => isDetailsPath(String(u)), { timeout: 4000 }).catch(() => null),
  ]);
  await page.waitForTimeout(300);
}

async function hostLooksLikeDropdown(host: Locator): Promise<boolean> {
  return host.evaluate((el) => {
    const root = el as HTMLElement;
    if (root.matches('mat-select, [role="combobox"], .mat-mdc-select, .mat-select')) return true;
    if (root.querySelector('mat-select, .mat-mdc-select-trigger, .mat-select-trigger')) return true;
    if (root.querySelector('input, textarea')) return false;
    return /dropdown|select/i.test(root.tagName + (root.className || ''));
  }).catch(() => false);
}

async function isLocalizedDecimalInput(loc: Locator): Promise<boolean> {
  return loc.evaluate((el) => {
    const input = (el.tagName === 'INPUT' ? el : el.querySelector('input')) as HTMLInputElement | null;
    if (!input) return false;
    if (input.hasAttribute('applocalizeddecimalinput') || input.hasAttribute('ng-reflect-localized-decimal-min')) return true;
    if (input.getAttribute('inputmode') === 'decimal') return true;
    return /rate|value|valued|rounding|amount|percent/i.test(input.getAttribute('formcontrolname') || input.id || '');
  }).catch(() => false);
}

async function typeIntoAngularInput(page: Page, loc: Locator, value: string): Promise<void> {
  const text = String(value ?? '');
  await loc.click({ timeout: 5000 });
  await loc.fill('');
  // appLocalizedDecimalInput sanitizes on input — keystrokes keep FormControl in sync
  if (await isLocalizedDecimalInput(loc)) {
    await loc.pressSequentially(text, { delay: 25 });
  } else {
    await loc.fill(text);
    await loc.evaluate((el, v) => {
      const target = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
        ? el as HTMLInputElement
        : (el.querySelector('input, textarea') as HTMLInputElement | null);
      if (!target) return;
      const proto = target.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(target, v);
      else target.value = v;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v, inputType: 'insertText' }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  }
  await loc.blur().catch(() => {});
  await page.waitForTimeout(TICK_MS);
}

/** Fast Angular fill — handles matInput, localized decimals, and misclassified dropdown hosts. */
export async function fillAngularField(page: Page, host: Locator, value: string): Promise<void> {
  await host.waitFor({ state: 'visible', timeout: 8000 });
  if (await hostLooksLikeDropdown(host)) {
    await selectMatDropdown(page, host, value || 'first');
    return;
  }
  const input = host.locator('input:not([type="hidden"]), textarea').first();
  const loc = (await input.count()) ? input : host;
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  const want = String(value ?? '');
  await typeIntoAngularInput(page, loc, want);

  const got = await loc.inputValue().catch(() => '');
  const ok = !want || got.replace(/\s/g, '').includes(want.replace(/\s/g, ''))
    || got.replace(',', '.').includes(want.replace(',', '.'));
  if (!ok) {
    await loc.click({ timeout: 3000 });
    await loc.fill('');
    await loc.pressSequentially(want, { delay: 30 });
    await loc.blur().catch(() => {});
    await page.waitForTimeout(TICK_MS);
  }
}

/** mat-autocomplete — type value, then pick the matching option (not merely the first row). */
export async function fillMatAutocomplete(page: Page, host: Locator, value: string): Promise<void> {
  const want = String(value ?? '').trim();
  const input = host.locator('input, textarea').first();
  const loc = (await input.count()) ? input : host;
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  await loc.click({ timeout: 5000 });
  await loc.fill(want);
  await page.waitForTimeout(isHeadlessRun() ? 350 : 180);

  const panel = page.locator('.mat-mdc-autocomplete-panel:visible, .mat-autocomplete-panel:visible').first();
  if (await panel.isVisible().catch(() => false)) {
    const options = panel.locator('mat-option:not([disabled])');
    // Prefer exact code/label match — target app currency list is alphabetic (AED before ALL)
    const exact = options.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(want)}\\b`, 'i') }).first();
    const contains = options.filter({ hasText: new RegExp(escapeRegExp(want), 'i') }).first();
    const pick = (await exact.isVisible().catch(() => false))
      ? exact
      : (await contains.isVisible().catch(() => false)) ? contains : null;

    if (pick) {
      await pick.click({ timeout: 3000, force: isHeadlessRun() });
      await page.waitForTimeout(isHeadlessRun() ? 200 : TICK_MS);
      const got = await loc.inputValue().catch(() => '');
      if (want && !got.toUpperCase().includes(want.toUpperCase())) {
        await loc.fill(want);
        await loc.blur().catch(() => {});
      }
      return;
    }
  }

  // No matching option (free-text code) — keep typed value
  await loc.blur().catch(() => {});
  await page.waitForTimeout(TICK_MS);
}

function normalizePick(value: string | null | undefined): string {
  if (value == null || value === '' || value === '__first__' || value === 'first') return 'first';
  const s = String(value).toLowerCase().trim();
  if (/^first[\s_()-]*(available|option|dropdown|choice)/.test(s)) return 'first';
  if (/^\(first[\s_-]*(dropdown\s*)?option\)$/i.test(s)) return 'first';
  return String(value);
}

async function dismissOpenOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 2500 }).catch(() => {});
  await page.locator('.cdk-overlay-container .mat-mdc-select-panel:visible, .cdk-overlay-container .mat-select-panel:visible')
    .waitFor({ state: 'hidden', timeout: 2500 }).catch(() => {});
  // Blur active mat-select — avoid (8,8) which hits the sidebar menu in target app
  await page.locator('[role="tabpanel"]:visible, form').first().click({ position: { x: 24, y: 24 }, force: true }).catch(() => {});
  await page.waitForTimeout(120);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefer code testId; fall back to visible combobox label when DOM lacks data-testid (older target app builds). */
async function resolveDropdownHost(page: Page, host: Locator, labelHint?: string): Promise<Locator> {
  if (await host.count()) return host.first();

  const hints = [...new Set([labelHint, labelHint?.replace(/([a-z0-9])([A-Z])/g, '$1 $2')].filter(Boolean))] as string[];
  for (const hint of hints) {
    const byRole = page.getByRole('combobox', { name: new RegExp(escapeRegExp(hint), 'i') });
    const count = await byRole.count();
    if (!count) continue;
    // Prefer the create-form field (usually the last visible combobox with this label)
    for (let i = count - 1; i >= 0; i--) {
      const candidate = byRole.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return byRole.last();
  }

  return host;
}

/** Real mat-select options (skip ngx-mat-select-search row). */
function selectableOptions(panel: Locator): Locator {
  return panel.getByRole('option').filter({
    hasNot: panel.page().locator('input, ngx-mat-select-search, mat-select-search'),
  });
}

/** target app enums often show i18n labels ("Fixed Amount") while plans use FIXED_AMOUNT. */
function dropdownMatchNeedles(pick: string): string[] {
  const raw = String(pick || '').trim();
  if (!raw) return [];
  const human = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = raw.replace(/[_-\s]+/g, '');
  return [...new Set([raw, human, compact].filter(Boolean))];
}

async function findDropdownOption(panel: Locator, pick: string): Promise<Locator | null> {
  // Prefer data-value (app-custom-dropdown sets attr.data-value = item.value)
  const byValue = panel.locator(`mat-option[data-value="${pick.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).first();
  if (await byValue.isVisible().catch(() => false)) return byValue;

  for (const needle of dropdownMatchNeedles(pick)) {
    const re = new RegExp(escapeRegExp(needle), 'i');
    const byRole = panel.getByRole('option', { name: re }).first();
    if (await byRole.isVisible().catch(() => false)) return byRole;
    const byText = selectableOptions(panel).filter({ hasText: re }).first();
    if (await byText.isVisible().catch(() => false)) return byText;
  }
  return null;
}

export async function selectMatDropdown(page: Page, host: Locator, want: string, labelHint?: string): Promise<string> {
  const pick = normalizePick(want);
  await dismissOpenOverlays(page);

  const resolved = await resolveDropdownHost(page, host, labelHint);

  // target app app-custom-dropdown puts data-testid on mat-form-field — that host is often
  // "hidden" to Playwright while the inner combobox is visible. Wait attached, click trigger.
  await resolved.waitFor({ state: 'attached', timeout: 12000 });
  await resolved.scrollIntoViewIfNeeded().catch(() => {});

  const trigger = resolved.locator(
    '.mat-mdc-select-trigger, .mat-select-trigger, mat-select, [role="combobox"]',
  ).first();
  const clickTarget = (await trigger.count()) ? trigger : resolved;
  await clickTarget.waitFor({ state: 'visible', timeout: 12000 });
  await clickTarget.click({ timeout: 10000 });
  await page.waitForTimeout(isHeadlessRun() ? 450 : 250);

  const panel = page.locator(
    '.cdk-overlay-container .mat-mdc-select-panel:visible, .cdk-overlay-container .mat-select-panel:visible',
  ).last();
  await panel.waitFor({ state: 'visible', timeout: 10000 });

  const search = panel.locator(
    'ngx-mat-select-search input, .mat-select-search-input, input[type="text"], input[type="search"]',
  ).first();
  const hasSearch = await search.isVisible().catch(() => false);

  let chosen: Locator | null = null;

  if (pick === 'first') {
    await selectableOptions(panel).first().waitFor({ state: 'visible', timeout: 12000 });
    chosen = selectableOptions(panel).first();
  } else {
    // Long lists: type enum or label — target app filters by value OR label
    if (hasSearch) {
      for (const needle of dropdownMatchNeedles(pick)) {
        await search.fill('');
        await search.fill(needle);
        await page.waitForTimeout(isHeadlessRun() ? 400 : 250);
        chosen = await findDropdownOption(panel, pick);
        if (chosen) break;
      }
    } else {
      await selectableOptions(panel).first().waitFor({ state: 'visible', timeout: 12000 });
      chosen = await findDropdownOption(panel, pick);
    }

    // target app shows i18n labels; plans often send API enums (FIXED_AMOUNT). If still unmatched, first option.
    if (!chosen && /^[A-Z][A-Z0-9_]*$/.test(pick)) {
      const fallback = selectableOptions(panel).first();
      if (await fallback.isVisible().catch(() => false)) chosen = fallback;
    }
  }

  if (!chosen) {
    throw new Error(`Dropdown option not found: "${pick}"`);
  }

  await chosen.waitFor({ state: 'visible', timeout: 8000 });
  const text = ((await chosen.textContent()) || '').trim();
  await chosen.click({ timeout: 4000, force: isHeadlessRun() });
  await dismissOpenOverlays(page);
  return text;
}

/** Unique sample matching Validators.pattern (e.g. [A-Z]{3}, [0-9]{3}). */
export function valueFromPattern(patternRegex: string): string {
  const rx = String(patternRegex || '');
  const alpha = rx.match(/^\[A-Z\]\{(\d+)\}$/i);
  if (alpha) {
    const n = Number(alpha[1]);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let x = Date.now() % (26 ** Math.min(n, 8) || 26);
    let out = '';
    for (let i = 0; i < n; i++) {
      out = alphabet[x % 26] + out;
      x = Math.floor(x / 26);
    }
    return out;
  }
  const digit = rx.match(/^\[0-9\]\{(\d+)\}$/);
  if (digit) {
    const n = Number(digit[1]);
    return String(Date.now()).slice(-n).padStart(n, '0');
  }
  return `v${Date.now().toString(36).slice(-5)}`;
}


/** @deprecated Use ensureTargetSession */
export const ensureCapboSession = ensureTargetSession;
/** @deprecated Use waitForAppShell */
export const waitForCapboShell = waitForAppShell;
