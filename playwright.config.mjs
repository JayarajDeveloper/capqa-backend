/**
 * Root Playwright config for CapBO E2E.
 * testDir is only generated-e2e/ — archives like _reverted_by_claude/ are ignored.
 *
 *   npx playwright test retail-chain-create --headed
 *   npm run test:e2e:headed -- retail-chain-create
 */
import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authStateForTarget } from './generated-e2e/auth-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '.env') });

const e2eDir = path.join(__dirname, 'generated-e2e');

function resolveBaseURL() {
  const raw = (process.env.TARGET_APP_URL || '').trim();
  if (!raw) return 'http://localhost:4200';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.origin;
  } catch {
    return raw.replace(/\/+$/, '') || 'http://localhost:4200';
  }
}

const baseURL = resolveBaseURL();
const storageState = authStateForTarget(process.env.TARGET_APP_URL || baseURL) || undefined;

export default defineConfig({
  testDir: e2eDir,
  testMatch: /.*\.spec\.(ts|js|mjs)$/,
  testIgnore: ['**/_reverted_by_claude/**', '**/node_modules/**'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
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
