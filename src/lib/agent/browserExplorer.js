/**
 * Browser Explorer — Playwright MCP for DeepSeek.
 * Gives the LLM eyes to see the actual CapBO DOM before generating tests.
 *
 * The LLM calls these tools during exploration phase, then generates
 * a spec with VERIFIED selectors — no iteration, no timeouts.
 */

import { chromium } from '@playwright/test';

let browser = null;
let context = null;
let page = null;

const TARGET = process.env.TARGET_APP_URL || 'http://localhost:4200';

// ── Lifecycle ────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
}

export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null; context = null; page = null;
}

// ── Tools ────────────────────────────────────────────────────────

/**
 * Navigate to a URL and return the page snapshot.
 * LLM calls this to explore a route.
 */
export async function browserNavigate(url) {
  await ensureBrowser();
  const fullUrl = url.startsWith('http') ? url : `${TARGET}${url}`;
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(800);
  return snapshot();
}

/**
 * Return the current page's accessibility tree as text.
 * LLM reads this to discover testIds, buttons, tabs, form fields.
 */
export async function browserSnapshot() {
  await ensureBrowser();
  return snapshot();
}

/**
 * Click an element by testId or ref and return new snapshot.
 */
export async function browserClick(testId) {
  await ensureBrowser();
  try {
    const locator = resolveLocator(testId);
    await locator.first().click({ timeout: 8000, force: true });
    await page.waitForTimeout(500);
    return snapshot();
  } catch (e) {
    return { error: e.message, snapshot: await snapshot() };
  }
}

/**
 * Type text into a field by testId.
 */
export async function browserType(testId, text) {
  await ensureBrowser();
  try {
    const locator = resolveLocator(testId);
    await locator.first().fill(text, { timeout: 8000 });
    await page.waitForTimeout(200);
    return snapshot();
  } catch (e) {
    return { error: e.message, snapshot: await snapshot() };
  }
}

/**
 * Return all data-testid attributes on the current page.
 */
export async function browserGetTestIds() {
  await ensureBrowser();
  const ids = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid]')].map(el => el.getAttribute('data-testid'));
  });
  const unique = [...new Set(ids)].sort();
  return { testIds: unique, count: unique.length };
}

/**
 * Execute a full exploration workflow for a given ask.
 * LLM calls this once and gets back a verified flow.
 */
export async function browserExplore(flow) {
  const results = [];
  await ensureBrowser();

  // Phase 0: Login if needed
  const { TARGET_APP_USERNAME, TARGET_APP_PASSWORD } = process.env;
  if (TARGET_APP_USERNAME && TARGET_APP_PASSWORD) {
    await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.fill('input[name="username"], input[type="email"]', TARGET_APP_USERNAME);
    await page.fill('input[name="password"], input[type="password"]', TARGET_APP_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }

  for (const step of flow) {
    const { action, url, testId, text } = step;
    let result;
    switch (action) {
      case 'navigate': result = await browserNavigate(url); break;
      case 'click':    result = await browserClick(testId); break;
      case 'type':     result = await browserType(testId, text); break;
      case 'snapshot': result = await browserSnapshot(); break;
      case 'testids':  result = await browserGetTestIds(); break;
      default: result = { error: `Unknown action: ${action}` };
    }
    results.push({ step, result });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveLocator(testIdOrSelector) {
  // If it looks like a testId, use getByTestId
  if (/^[a-z][a-z0-9-]*$/.test(testIdOrSelector)) {
    return page.getByTestId(testIdOrSelector);
  }
  // Otherwise treat as CSS selector
  return page.locator(testIdOrSelector);
}

async function snapshot() {
  try {
    // Get accessibility tree — same format as Playwright error-context.md
    const aria = await page.accessibility.snapshot({ interestingOnly: false });
    const text = formatAriaTree(aria, 0);
    // Also get visible testIds
    const testIds = await page.evaluate(() => {
      return [...document.querySelectorAll('[data-testid]')]
        .map(el => el.getAttribute('data-testid'));
    });
    const unique = [...new Set(testIds)];
    return {
      url: page.url(),
      title: await page.title(),
      testIds: unique.slice(0, 50),
      testIdCount: unique.length,
      snapshot: text.slice(0, 8000), // Cap to avoid token explosion
      snapshotTruncated: text.length > 8000,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function formatAriaTree(node, depth) {
  if (!node) return '';
  const indent = '  '.repeat(depth);
  let line = `${indent}- ${node.role || 'generic'}`;
  if (node.name) line += ` "${node.name}"`;
  if (node.disabled) line += ' [disabled]';
  if (node.selected) line += ' [selected]';
  if (node.checked) line += ' [checked]';
  if (node.expanded) line += ' [expanded]';
  if (node.level) line += ` [level=${node.level}]`;
  line += '\n';
  
  if (node.children) {
    for (const child of node.children) {
      line += formatAriaTree(child, depth + 1);
    }
  }
  return line;
}
