/**
 * Write generated Playwright specs to disk and run via `npx playwright test`.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildRunnablePlaywrightSpec, buildRunnableApiSpec } from './codegen.js';
import { buildProfessionalRunLog, createLiveStepTracker } from './runLogFormatter.js';
import { env } from '../../env.js';
import { targetAdapter } from '../../adapters/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GENERATED_E2E_DIR = path.resolve(__dirname, '../../../generated-e2e');
export const PLAYWRIGHT_CONFIG = path.join(GENERATED_E2E_DIR, 'playwright.config.mjs');
const BACKEND_ROOT = path.resolve(__dirname, '../../..');

const AUTH_STATE_MODULE = targetAdapter.specRuntime.authState;

const DEFAULT_PLAYWRIGHT_CONFIG = `/**
 * Playwright config for Cap QA generated target E2E specs.
 * Run: npx playwright test --config generated-e2e/playwright.config.mjs --headed
 */
import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authStateForTarget } from '${AUTH_STATE_MODULE}';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../.env') });

const DEFAULT_URL = '${env.DEFAULT_TARGET_APP_URL}';

function resolveBaseURL() {
  const raw = (process.env.TARGET_APP_URL || '').trim();
  if (!raw) return DEFAULT_URL;
  try {
    const u = new URL(raw.includes('://') ? raw : \`https://\${raw}\`);
    return u.origin;
  } catch {
    return raw.replace(/\\\\/+$/, '') || DEFAULT_URL;
  }
}

const baseURL = resolveBaseURL();
const storageState = authStateForTarget(process.env.TARGET_APP_URL || baseURL) || undefined;

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\\\\.spec\\\\.(ts|js|mjs)$/,
  testIgnore: ['**/_reverted_by_claude/**', '**/node_modules/**'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['./reporters/capqa-step-reporter.mjs'],
    ['list'],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    ...(storageState ? { storageState } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;

/** Ensure generated-e2e/playwright.config.mjs exists before CLI runs. */
export async function ensurePlaywrightConfig() {
  await fs.mkdir(GENERATED_E2E_DIR, { recursive: true });
  try {
    await fs.access(PLAYWRIGHT_CONFIG);
  } catch {
    await fs.writeFile(PLAYWRIGHT_CONFIG, DEFAULT_PLAYWRIGHT_CONFIG, 'utf8');
  }
}
function slugify(name) {
  return String(name || 'test')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'test';
}

/** Auto-resolve stable spec slug from any module name. No hardcoded module list needed. */
export function resolveStableSpecSlug(meta = {}) {
  if (meta.stableName) return slugify(meta.stableName);
  if (meta.moduleId) return slugify(meta.moduleId);
  const feature = meta.feature || meta.matchedFeature || meta.title;
  if (!feature) return null;
  const raw = slugify(feature);
  // Normalize common plurals → singular for URL matching, but keep
  // genuine plurals (e.g. "partners" is the target route).
  return raw;
}

/** Resolve runnable TS source (helpers import + SSO + fill/select from automation steps). */
export function resolvePlaywrightSource(automation, meta = {}) {
  if (!automation?.steps?.length) {
    throw new Error('Automation has no steps — generate a plan first');
  }
  return buildRunnablePlaywrightSpec(automation, {
    ...meta,
    createTestId: meta.createTestId || automation.createTestId || null,
    saveTestId: meta.saveTestId || automation.saveTestId || null,
    title: meta.title || automation.title,
  });
}

/** Write *.spec.ts under capqa-backend/generated-e2e/ */
export async function writePlaywrightSpec(automation, meta = {}) {
  const source = resolvePlaywrightSource(automation, meta);
  await ensurePlaywrightConfig();

  const stableSlug = resolveStableSpecSlug({
    ...meta,
    feature: automation.feature || meta.title,
  });
  const action = slugify(automation.action || meta.action || 'create');
  const useTimestamp = meta.timestamped === true || meta.stable === false;
  const fileName = !useTimestamp && stableSlug
    ? `${stableSlug}-${action}.spec.ts`
    : `${slugify(automation.feature || meta.title)}-${action}-${Date.now().toString(36)}.spec.ts`;
  const filePath = path.join(GENERATED_E2E_DIR, fileName);

  await fs.writeFile(filePath, source, 'utf8');

  return {
    filePath,
    fileName,
    relativePath: path.relative(BACKEND_ROOT, filePath),
    source,
  };
}

/** Write API *.spec.ts under capqa-backend/generated-e2e/api/ */
export async function writeApiSpec(automation, meta = {}) {
  if (!automation?.steps?.length) {
    throw new Error('API automation has no steps — generate a plan with Backend layer first');
  }
  const source = buildRunnableApiSpec(automation, meta);
  await ensurePlaywrightConfig();
  const apiDir = path.join(GENERATED_E2E_DIR, 'api');
  await fs.mkdir(apiDir, { recursive: true });

  const stableSlug = resolveStableSpecSlug({
    ...meta,
    feature: automation.feature || meta.title,
  });
  const action = slugify(automation.action || meta.action || 'create');
  const fileName = `${stableSlug || slugify(automation.feature || 'api')}-${action}.api.spec.ts`;
  const filePath = path.join(apiDir, fileName);
  await fs.writeFile(filePath, source, 'utf8');

  return {
    filePath,
    fileName,
    relativePath: path.relative(BACKEND_ROOT, filePath),
    source,
  };
}

/** Save API automation then run via Playwright (request context — no browser UI). */
export async function saveAndRunApiSpec(automation, options = {}) {
  const written = await writeApiSpec(automation, {
    title: options.title,
    matchedFeature: options.matchedFeature,
    action: options.action || automation.action,
  });
  const result = await runPlaywrightSpecFile({
    filePath: written.filePath,
    baseUrl: options.baseUrl,
    email: options.email,
    password: options.password,
    headless: true, // API specs never need a visible browser
    runMode: options.runMode || 'background',
    timeoutMs: options.timeoutMs || 120000,
    onProgress: options.onProgress,
    apiBaseUrl: options.apiBaseUrl,
  });
  return { ...result, ...written, kind: 'api' };
}

function parsePlaywrightOutput(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const passed = /\b(\d+) passed\b/.exec(combined);
  const failed = /\b(\d+) failed\b/.exec(combined);
  return {
    passed: failed ? Number(failed[1]) === 0 && Number(passed?.[1] || 0) > 0 : /passed/i.test(combined) && !/failed/i.test(combined),
    summary: combined.trim(),
  };
}

/** Run a spec file with Playwright CLI (headed by default). */
export function runPlaywrightSpecFile({
  filePath,
  baseUrl = '',
  email = '',
  password = '',
  headless = false,
  runMode = null,
  timeoutMs = 180000,
  onProgress = null,
  apiBaseUrl = '',
  recordVideo = null,
}) {
  return ensurePlaywrightConfig().then(() => new Promise((resolve) => {
    const started = Date.now();
    const args = [
      'playwright',
      'test',
      filePath,
      '--config',
      PLAYWRIGHT_CONFIG,
    ];
    if (!headless) args.push('--headed');

    const env = {
      ...process.env,
      TARGET_APP_URL: baseUrl || process.env.TARGET_APP_URL || '',
      TARGET_API_URL: apiBaseUrl || process.env.TARGET_API_URL || '',
      APP_TEST_USERNAME: email || process.env.APP_TEST_USERNAME || '',
      APP_TEST_PASSWORD: password || process.env.APP_TEST_PASSWORD || '',
      ...(headless
        ? { NOCTA_HEADLESS: '1', NOCTA_RUN_MODE: 'background' }
        : { NOCTA_RUN_MODE: 'foreground' }),
      ...(recordVideo === 'on' || (!headless && recordVideo !== 'retain-on-failure')
        ? { NOCTA_VIDEO: 'on' }
        : {}),
      ...(process.env.NOCTA_TRACE || recordVideo === 'on' ? { NOCTA_TRACE: process.env.NOCTA_TRACE || 'retain-on-failure' } : {}),
    };
    // Cursor sandbox may set PLAYWRIGHT_BROWSERS_PATH to a missing cache — drop it so
    // Playwright uses ~/Library/Caches/ms-playwright (or the default install).
    if (env.PLAYWRIGHT_BROWSERS_PATH && !fsSync.existsSync(env.PLAYWRIGHT_BROWSERS_PATH)) {
      delete env.PLAYWRIGHT_BROWSERS_PATH;
    }

    const proc = spawn('npx', args, {
      cwd: BACKEND_ROOT,
      env,
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    const modeLabel = runMode || (headless ? 'background' : 'foreground');
    const stepTracker = createLiveStepTracker({
      onProgress,
      logToConsole: headless,
      modeLabel,
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      stepTracker.feed(chunk);
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      stepTracker.feed(chunk);
    });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      const parsed = parsePlaywrightOutput(stdout, stderr);
      let specSource = '';
      try {
        specSource = await fs.readFile(filePath, 'utf8');
      } catch { /* optional */ }

      const relSpec = path.relative(BACKEND_ROOT, filePath);
      const formatted = buildProfessionalRunLog({
        specPath: relSpec,
        baseUrl: env.TARGET_APP_URL || '(unset)',
        passed: code === 0 && parsed.passed,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        specSource,
        headless,
        runMode: runMode || (headless ? 'background' : 'foreground'),
      });

      resolve({
        passed: code === 0 && parsed.passed,
        skipped: false,
        durationMs: Date.now() - started,
        engine: 'playwright-cli',
        headless: !!headless,
        runMode: runMode || (headless ? 'background' : 'foreground'),
        exitCode: code ?? 1,
        baseUrl: env.TARGET_APP_URL,
        log: formatted.log,
        rawLog: [
          stdout.trim(),
          stderr.trim() ? `\n--- stderr ---\n${stderr.trim()}` : '',
        ].filter(Boolean).join('\n'),
        runSteps: formatted.runSteps,
        runSummary: {
          passed: formatted.passedCount,
          failed: formatted.failedCount,
          skipped: formatted.skippedCount,
          total: formatted.runSteps.length,
        },
        specPath: filePath,
        relativePath: relSpec,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        skipped: /ENOENT|not found/i.test(err.message),
        durationMs: Date.now() - started,
        engine: 'playwright-cli',
        exitCode: 1,
        log: `FATAL: ${err.message}\nFix: cd capqa-backend && npx playwright install chromium`,
        specPath: filePath,
      });
    });
  }));
}

/** Save spec then run via Playwright CLI. */
export async function saveAndRunPlaywrightSpec(automation, options = {}) {
  const written = await writePlaywrightSpec(automation, {
    title: options.title,
    baseUrl: options.baseUrl,
    matchedFeature: options.matchedFeature,
    action: options.action || automation.action,
  });
  const result = await runPlaywrightSpecFile({
    filePath: written.filePath,
    baseUrl: options.baseUrl,
    email: options.email,
    password: options.password,
    headless: options.headless === true,
    runMode: options.runMode || (options.headless ? 'background' : 'foreground'),
    timeoutMs: options.timeoutMs || 180000,
    onProgress: options.onProgress,
    recordVideo: options.recordVideo,
  });
  return { ...result, ...written };
}
