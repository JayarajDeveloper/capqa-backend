/**
 * CapBO target-database helpers for Database · SQL runs (read-only).
 */
import pg from 'pg';
import { encrypt, decrypt } from '../crypto.js';
import { env } from '../../env.js';

const { Client } = pg;

export function publicDbTarget(row) {
  const fromEnv = !row?.host && !row?.database && !!env.TARGET_DATABASE_URL;
  return {
    host: row?.host || '',
    port: row?.port ?? 5432,
    database: row?.database || '',
    username: row?.username || '',
    ssl: !!row?.ssl,
    hasPassword: !!(row?.passwordCipher),
    configured: !!(
      (row?.host && row?.database && row?.username && row?.passwordCipher)
      || env.TARGET_DATABASE_URL
    ),
    fromEnv,
  };
}

/** Build pg Client config from DbTarget row (+ decrypted password) or TARGET_DATABASE_URL. */
export function resolveDbConfig(row, password = '') {
  if (row?.host && row?.database && row?.username) {
    return {
      host: row.host,
      port: Number(row.port) || 5432,
      database: row.database,
      user: row.username,
      password: password || '',
      ssl: row.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 8000,
      statement_timeout: 15000,
    };
  }
  const url = String(env.TARGET_DATABASE_URL || '').trim();
  if (url) {
    return {
      connectionString: url,
      ssl: /sslmode=require|ssl=true/i.test(url) ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 8000,
      statement_timeout: 15000,
    };
  }
  return null;
}

export async function loadDbTarget(projectId, prisma) {
  const row = await prisma.dbTarget.findUnique({ where: { projectId } });
  const password = row?.passwordCipher ? decrypt(row.passwordCipher) : '';
  const config = resolveDbConfig(row, password);
  return { row, password, config, public: publicDbTarget(row) };
}

export async function withDbClient(config, fn) {
  if (!config) {
    throw new Error(
      'Database not configured — add CapBO Postgres credentials in Settings (or TARGET_DATABASE_URL in .env).',
    );
  }
  const client = new Client(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function testDbConnection(config) {
  return withDbClient(config, async (client) => {
    const res = await client.query('SELECT 1 AS ok');
    return { ok: true, result: res.rows?.[0]?.ok === 1 };
  });
}

/** Only allow single SELECT statements (no multi-statement, no writes). */
export function assertReadOnlySelect(sql) {
  const raw = String(sql || '').trim();
  if (!raw) throw new Error('Empty SQL');
  if (raw.includes(';') && raw.replace(/;\s*$/, '').includes(';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
  const cleaned = raw.replace(/;\s*$/, '').trim();
  if (!/^\s*select\b/i.test(cleaned)) {
    throw new Error('Only SELECT queries are allowed in Database · SQL (v1)');
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute)\b/i.test(cleaned)) {
    throw new Error('Write/DDL keywords are not allowed in Database · SQL (v1)');
  }
  return cleaned;
}

function columnNamesFromRows(rows) {
  return rows
    .map((r) => String(r.column_name || r.columnName || Object.values(r)[0] || '').toLowerCase())
    .filter(Boolean);
}

/**
 * Run Database automation steps against CapBO Postgres.
 * Step shape: { action: 'sqlAssert', sql, params?, expectMinRows?, expectIncludes?, expectColumns? }
 */
export async function runDbAutomation(automation, config) {
  const steps = automation?.steps || [];
  if (!steps.length) throw new Error('No database steps to run');

  const started = Date.now();
  const runSteps = [];
  let passed = true;
  const logs = [];

  await withDbClient(config, async (client) => {
    for (const step of steps) {
      const title = step.description || step.id || step.action || 'sql';
      const begin = Date.now();
      try {
        if (step.action !== 'sqlAssert' && step.action !== 'sql') {
          runSteps.push({
            title,
            status: 'skip',
            durationMs: 0,
            detail: `Unsupported action ${step.action}`,
            points: [`Skipped — unsupported action ${step.action}`],
          });
          continue;
        }
        const sql = assertReadOnlySelect(step.sql);
        const params = Array.isArray(step.params) ? step.params : [];
        const res = await client.query(sql, params);
        const rows = res.rows || [];
        const points = [];

        if (step.expectAbsent) {
          if (rows.length > 0) {
            const err = new Error(`Expected 0 rows (absent), got ${rows.length}`);
            err.points = [`Expected absent`, `Got ${rows.length} row(s)`];
            throw err;
          }
          points.push('0 rows (absent) — OK');
        } else {
          const minRows = step.expectMinRows != null ? Number(step.expectMinRows) : 1;
          if (rows.length < minRows) {
            const err = new Error(`Expected ≥${minRows} row(s), got ${rows.length}`);
            err.points = [`Expected ≥${minRows} row(s)`, `Got ${rows.length}`];
            throw err;
          }
          const needle = step.expectIncludes != null ? String(step.expectIncludes) : '';
          if (needle) {
            const blob = JSON.stringify(rows);
            if (!blob.includes(needle)) {
              const err = new Error(`Result did not include ${JSON.stringify(needle)}`);
              err.points = [`Expected to include ${needle}`, `Got: ${blob.slice(0, 200)}`];
              throw err;
            }
            points.push(`Found ${needle}`);
          }

          const wantCols = Array.isArray(step.expectColumns) ? step.expectColumns : [];
          if (wantCols.length) {
            const haveList = columnNamesFromRows(rows);
            const have = new Set(haveList);
            const wantLower = wantCols.map((c) => String(c).toLowerCase());
            const missing = wantCols.filter((c) => !have.has(String(c).toLowerCase()));
            const ok = wantCols.filter((c) => have.has(String(c).toLowerCase()));
            if (missing.length) {
              const err = new Error(`Missing ${missing.length} column(s)`);
              err.points = [
                ...missing.map((c) => `Missing — ${c}`),
                ...ok.map((c) => `OK — ${c}`),
                ...haveList.filter((c) => !wantLower.includes(c)).map((c) => `Extra — ${c}`),
              ];
              err.missing = missing;
              err.found = haveList;
              err.expected = wantCols;
              throw err;
            }
            points.push(`All ${wantCols.length} expected column(s) present`);
            for (const c of wantCols) points.push(`OK — ${c}`);
          } else if (!needle) {
            points.push(`${rows.length} row(s)`);
          }
        }

        const detail = points[0] || 'OK';
        runSteps.push({
          title,
          status: 'pass',
          durationMs: Date.now() - begin,
          detail,
          points,
          error: null,
        });
        logs.push(`✓ ${title}`);
        for (const p of points) logs.push(`  · ${p}`);
      } catch (e) {
        passed = false;
        const msg = String(e.message || e);
        const points = Array.isArray(e.points) && e.points.length
          ? e.points
          : [msg];
        runSteps.push({
          title,
          status: 'fail',
          durationMs: Date.now() - begin,
          detail: msg,
          error: msg,
          points,
          missing: e.missing || null,
          found: e.found || null,
          expected: e.expected || null,
        });
        logs.push(`✗ ${title} — ${msg}`);
        for (const p of points) logs.push(`  · ${p}`);
        break;
      }
    }
  });

  return {
    passed,
    skipped: false,
    durationMs: Date.now() - started,
    log: logs.join('\n'),
    runSteps,
    runSummary: {
      total: runSteps.length,
      passed: runSteps.filter((s) => s.status === 'pass').length,
      failed: runSteps.filter((s) => s.status === 'fail').length,
      skipped: runSteps.filter((s) => s.status === 'skip').length,
    },
    engine: 'postgres-sql',
    kind: 'database',
  };
}

export function encryptDbPassword(password) {
  return encrypt(String(password || ''));
}

export { decrypt as decryptDbSecret };
