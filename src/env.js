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

  /** DeepSeek LLM provider (OpenAI-compatible API). */
  DEEPSEEK_API_KEY: required('DEEPSEEK_API_KEY'),
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  DEEPSEEK_BASE_URL: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),

  /** Default app-under-test URL for Playwright when no per-project target is set. */
  DEFAULT_TARGET_APP_URL: process.env.DEFAULT_TARGET_APP_URL || 'http://localhost:4200',

  TARGET_APP_URL: (process.env.TARGET_APP_URL || '').replace(/\/+$/, ''),
  TARGET_API_URL: (process.env.TARGET_API_URL || process.env.TARGET_APP_URL || '').replace(/\/+$/, ''),
  TARGET_DATABASE_URL: process.env.TARGET_DATABASE_URL || '',

  CAPQA_LOCAL_UI_ROOT: (process.env.CAPQA_LOCAL_UI_ROOT || '').replace(/\/+$/, ''),
  CAPQA_LOCAL_API_ROOT: (process.env.CAPQA_LOCAL_API_ROOT || '').replace(/\/+$/, ''),
};

export const AI_PROVIDER = 'deepseek';
export const AI_DEFAULT_MODEL = env.DEEPSEEK_MODEL;

/** Resolve the DeepSeek API key. */
export function resolveApiKey() {
  return env.DEEPSEEK_API_KEY;
}

/** Resolve the DeepSeek model. */
export function resolveModel() {
  return env.DEEPSEEK_MODEL;
}

/** DeepSeek does not provide embeddings — vector search not available. */
export function providerSupportsEmbeddings() {
  return false;
}
