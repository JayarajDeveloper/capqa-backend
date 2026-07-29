import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const allowInsecureTls =
  process.env.ALLOW_INSECURE_TLS === 'true' ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[tls] ALLOW_INSECURE_TLS enabled — GitLab HTTPS cert verification is off (dev only)');
}

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'dev-insecure-encryption-key-change-me',
  ALLOW_INSECURE_TLS: allowInsecureTls,
  PORT: Number(process.env.PORT || 4000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@cap.local',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  ADMIN_NAME: process.env.ADMIN_NAME || 'Admin',
  ADMIN_ORG: process.env.ADMIN_ORG || 'Cap',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  GEMINI_BASE_URL: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/+$/, ''),
  /** App under test for Playwright UI runs (e.g. CapBO frontend URL). */
  TARGET_APP_URL: (process.env.TARGET_APP_URL || '').replace(/\/+$/, ''),
  /** API base for HTTP automation (defaults to TARGET_APP_URL if unset). */
  TARGET_API_URL: (process.env.TARGET_API_URL || process.env.TARGET_APP_URL || '').replace(/\/+$/, ''),
  /** CapBO Postgres for Database · SQL (optional; Settings per project preferred). */
  TARGET_DATABASE_URL: process.env.TARGET_DATABASE_URL || '',
};
