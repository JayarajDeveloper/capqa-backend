/**
 * Live Tools — real-time database and API introspection.
 * Enables the agent to make data-aware decisions during test generation.
 *
 * MCP-style: these are tools the LLM can call to query the live system.
 */

import pg from 'pg';
import { env } from '../../env.js';

// ── Database Live Query ────────────────────────────────────────

let dbPool = null;

async function getPool() {
  if (dbPool) return dbPool;
  const url = env.TARGET_DATABASE_URL;
  if (!url) throw new Error('TARGET_DATABASE_URL not set in .env');
  dbPool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000 });
  return dbPool;
}

/**
 * Check if a value already exists in a table column.
 * Used to avoid uniqueness conflicts in generated test data.
 */
export async function dbValueExists(table, column, value) {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `SELECT 1 FROM ${safeIdent(table)} WHERE ${safeIdent(column)} = $1 LIMIT 1`,
      [value]
    );
    return result.rows.length > 0;
  } catch (e) {
    console.warn(`[live] dbValueExists(${table}.${column}) failed:`, e.message);
    return null; // unknown — don't block
  }
}

/**
 * Generate a unique value by appending a suffix.
 */
export async function generateUniqueValue(table, column, baseValue) {
  if (!(await dbValueExists(table, column, baseValue))) return baseValue;
  for (let i = 1; i < 100; i++) {
    const candidate = `${baseValue}-${i}`;
    if (!(await dbValueExists(table, column, candidate))) return candidate;
  }
  return `${baseValue}-${Date.now().toString(36)}`;
}

/**
 * Get enum values from a PostgreSQL enum type.
 */
export async function getEnumValues(enumType) {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `SELECT unnest(enum_range(NULL::${safeIdent(enumType)}))::text AS value`
    );
    return result.rows.map(r => r.value);
  } catch {
    return [];
  }
}

/**
 * Get table columns and their types from information_schema.
 */
export async function getTableSchema(tableName) {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    return result.rows.map(r => ({
      column: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      default: r.column_default,
      maxLength: r.character_maximum_length,
    }));
  } catch (e) {
    console.warn(`[live] getTableSchema(${tableName}) failed:`, e.message);
    return [];
  }
}

/**
 * Count rows in a table (with optional filter).
 */
export async function countRows(table, whereClause = '', params = []) {
  try {
    const pool = await getPool();
    const sql = `SELECT COUNT(*) AS cnt FROM ${safeIdent(table)}${whereClause ? ' WHERE ' + whereClause : ''}`;
    const result = await pool.query(sql, params);
    return parseInt(result.rows[0].cnt);
  } catch {
    return -1;
  }
}

/**
 * Run a safe read-only SELECT query.
 */
export async function safeQuery(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Only SELECT queries allowed');
  try {
    const pool = await getPool();
    const result = await pool.query(sql, params);
    return { rows: result.rows.slice(0, 20), rowCount: result.rows.length };
  } catch (e) {
    return { error: e.message };
  }
}

// ── API Health Check ────────────────────────────────────────────

/**
 * Check if the target app is reachable.
 */
export async function checkTargetHealth() {
  const url = env.TARGET_APP_URL;
  if (!url) return { reachable: false, reason: 'TARGET_APP_URL not set' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { reachable: res.ok, status: res.status, url };
  } catch (e) {
    return { reachable: false, reason: e.message, url };
  }
}

/**
 * Check if a specific API endpoint is accessible.
 */
export async function checkApiEndpoint(path) {
  const base = env.TARGET_API_URL || env.TARGET_APP_URL;
  if (!base) return { reachable: false, reason: 'No API URL configured' };
  try {
    const url = `${base.replace(/\/+$/, '')}${path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { reachable: true, status: res.status, url };
  } catch (e) {
    return { reachable: false, reason: e.message, url: `${base}${path}` };
  }
}

// ── Self-Healing Test Data ─────────────────────────────────────

/**
 * Generate collision-free test data for a given entity.
 * Checks the live DB to avoid uniqueness conflicts.
 */
export async function generateSafeTestData(entityInfo) {
  const { table, codeColumn, codeValue, nameColumn, nameValue } = entityInfo;
  const safe = {};

  if (table && codeColumn && codeValue) {
    safe.code = await generateUniqueValue(table, codeColumn, codeValue);
    if (safe.code !== codeValue) {
      safe.codeNote = `Generated "${safe.code}" (base "${codeValue}" already exists)`;
    }
  }

  if (table && nameColumn && nameValue) {
    safe.name = await generateUniqueValue(table, nameColumn, nameValue);
  }

  return safe;
}

// ── Helpers ────────────────────────────────────────────────────

function safeIdent(name) {
  // Only allow alphanumeric + underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

/**
 * Build a live system report for the agent prompt.
 */
export async function buildLiveSystemReport() {
  const lines = [];
  lines.push('\nLIVE SYSTEM STATE:');
  
  const health = await checkTargetHealth();
  lines.push(`  Target app: ${health.reachable ? `✅ reachable (${health.status})` : `❌ ${health.reason}`}`);

  if (env.TARGET_DATABASE_URL) {
    try {
      const pool = await getPool();
      await pool.query('SELECT 1');
      lines.push('  Database: ✅ connected');
      
      // Get table list
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      );
      lines.push(`  Tables: ${tables.rows.length} found`);
    } catch (e) {
      lines.push(`  Database: ❌ ${e.message}`);
    }
  }

  return lines.join('\n');
}
