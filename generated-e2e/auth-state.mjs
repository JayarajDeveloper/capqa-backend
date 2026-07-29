/**
 * Origin-scoped Playwright storage state — avoids reusing 172.31.12.13 cookies on localhost:4200.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = path.resolve(__dirname, '.auth');
export const AUTH_FILE = path.join(AUTH_DIR, 'user.json');
export const AUTH_ORIGIN_FILE = path.join(AUTH_DIR, 'origin');

export function targetOrigin(rawUrl) {
  const raw = String(rawUrl || process.env.TARGET_APP_URL || '').trim();
  if (!raw) return '';
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  return new URL(withScheme).origin;
}

/** Path to user.json only when saved for this TARGET_APP_URL origin. */
export function authStateForTarget(rawUrl) {
  if (!fs.existsSync(AUTH_FILE)) return null;
  const origin = targetOrigin(rawUrl);
  if (!origin) return null;
  if (!fs.existsSync(AUTH_ORIGIN_FILE)) return null;
  if (fs.readFileSync(AUTH_ORIGIN_FILE, 'utf8').trim() !== origin) return null;
  return AUTH_FILE;
}

export async function saveAuthState(context, rawUrl) {
  const origin = targetOrigin(rawUrl);
  if (!origin) throw new Error('TARGET_APP_URL required to save auth');
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  fs.writeFileSync(AUTH_ORIGIN_FILE, origin, 'utf8');
}
