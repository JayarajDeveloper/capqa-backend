/**
 * Playwright config for Cap QA generated CapBO E2E specs.
 * Run: npx playwright test --config generated-e2e/playwright.config.mjs --headed
 */
import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authStateForTarget } from './auth-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../.env') });

const DEFAULT_URL = 'http://localhost:4200';

function resolveBaseURL() {
  const raw = (process.env.TARGET_APP_URL || '').trim();
  if (!raw) return DEFAULT_URL;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.origin;
  } catch {
    return raw.replace(/\\/+$/, '') || DEFAULT_URL;
  }
}

const baseURL = resolveBaseURL();
const storageState = authStateForTarget(process.env.TARGET_APP_URL || baseURL) || undefined;

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\\.spec\\.(ts|js|mjs)$/,
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
