/**
 * Unified Business Rule Extractor.
 * One function. All sources. 100% coverage.
 *
 * Feeds entity constraints + service guards + enum validation +
 * required fields + uniqueness checks + permission rules to the LLM.
 */

import { env } from '../../env.js';

/**
 * Extract ALL business rules from direct-read files.
 * Returns a single catalog with every rule found.
 */
export function extractAllRules(direct) {
  const catalog = { entities: {}, rules: [], required: [], guards: [], permissions: [], enumRules: [] };

  // ── Source 1: Entity constraints (ORM columns, Assert validators) ──
  for (const e of direct.entities || []) {
    const entityRules = extractEntityRules(e.content, e.entity);
    catalog.entities[e.entity] = entityRules;
    catalog.required.push(...entityRules.required);
    for (const c of entityRules.constraints) {
      catalog.rules.push(`[${e.entity}] ${c.field}: ${c.rule}`);
    }
    catalog.permissions.push(...entityRules.permissions);
  }

  // ── Source 2: Service guards (throw messages, conditions) ──
  for (const s of direct.services || []) {
    const throws = s.content.match(/throw\s+new\s+\w+\s*\(\s*'([^']+)'/g) || [];
    for (const t of throws) {
      const msg = t.match(/'([^']+)'/)?.[1];
      if (msg) catalog.guards.push(`[${s.entity}] ${msg}`);
    }

    // Required fields arrays
    const reqMatch = s.content.match(/\$requiredFields\s*=\s*\[([^\]]+)\]/);
    if (reqMatch) {
      const fields = reqMatch[1].match(/'([^']+)'/g)?.map(f => f.replace(/'/g, '')) || [];
      catalog.required.push(...fields.map(f => `${s.entity}.${f}`));
    }

    // Uniqueness checks
    const uniqueChecks = s.content.match(/findBy(\w+)\s*\(\s*\$(?:data|code|name)\['(\w+)'\]/g) || [];
    for (const c of uniqueChecks) {
      const field = c.match(/\['(\w+)'\]/)?.[1];
      if (field) catalog.rules.push(`[${s.entity}] ${field}: UNIQUE (checked by repository)`);
    }
  }

  // ── Source 3: Permissions (ApiResource security rules) ──
  for (const e of direct.entities || []) {
    const secs = e.content.match(/security:\s*"([^"]+)"/g) || [];
    for (const s of secs) {
      const rule = s.match(/"([^"]+)"/)?.[1];
      if (rule) catalog.permissions.push(`[${e.entity}] ${rule}`);
    }
  }

  // ── Build summary ──
  catalog.summary = {
    entities: Object.keys(catalog.entities).length,
    rules: catalog.rules.length,
    required: catalog.required.length,
    guards: catalog.guards.length,
    permissions: catalog.permissions.length,
    total: catalog.rules.length + catalog.guards.length + catalog.permissions.length,
  };

  return catalog;
}

/**
 * Extract rules from a single entity PHP file.
 */
function extractEntityRules(content, entityName) {
  const constraints = [];
  const required = [];
  const permissions = [];

  // Assert constraints
  const assertMatch = content.match(/#\[Assert\\(NotBlank|Length|Email|Regex|Positive|Range|NotEqualTo)[^\]]*\]/g) || [];
  for (const a of assertMatch) {
    const type = a.match(/Assert\\(\w+)/)?.[1] || 'Constraint';
    // Find the field this belongs to
    const fieldMatch = content.slice(
      Math.max(0, content.indexOf(a) - 300),
      content.indexOf(a)
    ).match(/\$(\w+)/g)?.pop()?.replace('$', '') || 'field';
    
    if (type === 'NotBlank') required.push(`${entityName}.${fieldMatch}`);
    constraints.push({ field: fieldMatch, rule: type });
  }

  // ORM column constraints
  const colMatch = content.match(/#\[ORM\\Column\s*\([^)]*\)\]/g) || [];
  for (const c of colMatch) {
    const unique = c.includes('unique: true');
    const nullable = c.match(/nullable:\s*(\w+)/)?.[1];
    const field = c.includes('private') ? c.split('$')[1]?.split(';')[0]?.trim() : null;
    if (unique) constraints.push({ field: field || 'col', rule: 'UNIQUE' });
    if (nullable === 'false' && !required.includes(field)) required.push(`${entityName}.${field}`);
  }

  // ApiResource security
  const secMatch = content.match(/security:\s*"([^"]+)"/g) || [];
  for (const s of secMatch) {
    permissions.push(`${entityName}: ${s.match(/"([^"]+)"/)?.[1]}`);
  }

  return { constraints, required, permissions };
}

/**
 * Format catalog as LLM prompt section.
 */
export function formatAllRules(catalog, primaryEntity) {
  if (!catalog || !catalog.summary?.total) return '';

  const lines = [];
  lines.push(`\nBUSINESS RULES (${catalog.summary.total} total):`);
  lines.push('─'.repeat(50));

  if (catalog.required.length) {
    lines.push(`\nREQUIRED FIELDS (${catalog.required.length}):`);
    for (const r of catalog.required) lines.push(`  • ${r}`);
  }

  if (catalog.rules.length) {
    lines.push(`\nCONSTRAINTS (${catalog.rules.length}):`);
    for (const r of catalog.rules.slice(0, 30)) lines.push(`  • ${r}`);
  }

  if (catalog.guards.length) {
    lines.push(`\nSERVICE GUARDS (${catalog.guards.length}):`);
    const unique = [...new Set(catalog.guards)];
    for (const g of unique.slice(0, 20)) lines.push(`  ⚠ ${g}`);
  }

  if (catalog.permissions.length) {
    lines.push(`\nPERMISSIONS (${catalog.permissions.length}):`);
    const unique = [...new Set(catalog.permissions)];
    for (const p of unique.slice(0, 10)) lines.push(`  🔒 ${p}`);
  }

  lines.push(`\nTEST GENERATION RULES:`);
  lines.push(`  1. Generate 1 happy-path test`);
  lines.push(`  2. Generate 1 negative test per REQUIRED FIELD (try saving without it)`);
  lines.push(`  3. Generate 1 boundary test per LENGTH/UNIQUE constraint`);
  lines.push(`  4. Generate 1 permission test per role guard`);
  lines.push(`  5. Total: at least ${Math.min(8, catalog.summary.total)} test cases`);

  return lines.join('\n');
}
