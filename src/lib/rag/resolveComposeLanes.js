/**
 * AI / heuristic lane adoption for Compose.
 * UI + API are the default pair.
 * Database = schema/migration checks only (not business data).
 */

import { combineAsk } from './ground.js';

/**
 * Analyze title + description (+ optional intent) and decide which automation lanes to build.
 */
export function resolveComposeLanes({ title = '', description = '', intent = null } = {}) {
  const ask = combineAsk(title, description).toLowerCase();
  const action = String(intent?.action || '').toLowerCase();
  const reasons = [];

  // Database: schema / migration only — not "verify row ECO-QA exists"
  const wantsDatabase = Boolean(
    /\b(schema|migration|migrations|migrate|ddl)\b/.test(ask)
    || /\b(database\s+schema|schema\s+check|check\s+schema|verify\s+schema|schema\s+assert)\b/.test(ask)
    || /\b(table\s+exists|column\s+exists|columns?\s+exist|doctrine\s+migration)\b/.test(ask)
    || (/\b(database|sql|postgres)\b/.test(ask) && /\b(schema|migration|structure|columns?|table)\b/.test(ask)),
  );
  if (wantsDatabase) {
    reasons.push('Ask targets schema/migration — adopting Database lane (no data asserts)');
  }

  const apiOnly = Boolean(
    /\b(api\s*only|only\s+api|http\s+only|backend\s*only|no\s+ui|without\s+(the\s+)?(ui|browser)|rest\s+only)\b/.test(ask)
    || (/\b(post|put|patch|delete|get)\s+\/api\//.test(ask) && !/\b(ui|browser|click|form|playwright)\b/.test(ask)),
  );
  const uiOnly = Boolean(
    /\b(ui\s*only|only\s+ui|browser\s*only|playwright\s*only|frontend\s*only|no\s+api)\b/.test(ask)
    && !wantsDatabase,
  );

  let ui = true;
  let api = true;

  if (apiOnly) {
    ui = false;
    api = true;
    reasons.push('Ask is API-focused — UI off, API on');
  } else if (uiOnly) {
    ui = true;
    api = false;
    reasons.push('Ask is UI-focused — UI on, API off');
  } else if (!wantsDatabase || /\b(create|add|update|edit|delete|ui|api|browser)\b/.test(ask)) {
    reasons.push('Standard ask — adopting UI + API');
  }

  const dbOnly = wantsDatabase && Boolean(
    /\b(only\s+(schema|migration|database)|schema\s*only|migration\s*only)\b/.test(ask)
    || (
      /\b(schema|migration)\b/.test(ask)
      && !/\b(create|add|update|edit|delete|remove|click|fill|browser|ui|api|endpoint)\b/.test(ask)
    ),
  );
  if (dbOnly) {
    ui = false;
    api = false;
    reasons.push('Ask is schema/migration only — UI/API off');
  }

  if (wantsDatabase && !dbOnly && (ui || api)) {
    reasons.push('UI/API for app flow; Database for schema/migration check');
  }

  const layers = [];
  if (ui) layers.push('ui');
  if (api) layers.push('backend');
  if (wantsDatabase) layers.push('database');
  if (!layers.length) {
    layers.push('ui', 'backend');
    reasons.push('Fallback — UI + API');
  }

  let defaultRunAs = 'ui';
  if (dbOnly || (wantsDatabase && !ui && !api)) defaultRunAs = 'database';
  else if (!ui && api) defaultRunAs = 'api';
  else if (ui) defaultRunAs = 'ui';
  else if (api) defaultRunAs = 'api';
  else if (wantsDatabase) defaultRunAs = 'database';

  if (/\bvia\s+api\b|\busing\s+(the\s+)?api\b/.test(ask) && api) {
    defaultRunAs = 'api';
    reasons.push('Ask says via API — default run as API');
  }
  if (/\b(via|using)\s+(the\s+)?(schema|migration|database)\b/.test(ask) && wantsDatabase) {
    defaultRunAs = 'database';
    reasons.push('Ask says schema/migration — default run as Database');
  }

  const labels = [
    ui && 'UI',
    api && 'API',
    wantsDatabase && 'Database',
  ].filter(Boolean);

  return {
    ui,
    api,
    database: wantsDatabase,
    layers,
    defaultRunAs,
    reasons,
    summary: labels.length ? labels.join(' · ') : 'UI · API',
    action: action || null,
  };
}
