/**
 * Unified Business Rule Extractor.
 * One function. All sources. 100% coverage.
 *
 * Feeds entity constraints + service guards + enum validation +
 * required fields + uniqueness checks + permission rules to the LLM.
 */

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

  catalog.required = [...new Set(catalog.required)];
  catalog.rules = [...new Set(catalog.rules)];

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
 * Split a PHP class body into { name, attrs[] } for each declared property.
 *
 * Attribute blocks are accumulated line by line and flushed onto the next
 * property declaration, so the field name is READ, never guessed. Multi-line
 * attributes are joined by tracking bracket depth.
 */
export function parseEntityProperties(content) {
  const props = [];
  const lines = String(content || '').split('\n');
  let attrs = [];
  let pending = null;
  let depth = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Continuation of a multi-line attribute.
    if (pending !== null) {
      pending += '\n' + line;
      depth += (line.split('[').length - 1) - (line.split(']').length - 1);
      if (depth <= 0) { attrs.push(pending); pending = null; depth = 0; }
      continue;
    }

    if (line.startsWith('#[')) {
      const open = (line.split('[').length - 1) - (line.split(']').length - 1);
      if (open > 0) { pending = line; depth = open; }
      else attrs.push(line);
      continue;
    }

    const m = line.match(/^(?:private|protected|public)(?:\s+readonly)?\s+[^$]*\$(\w+)/);
    if (m) {
      if (attrs.length) props.push({ name: m[1], attrs: attrs.slice(), decl: line });
      attrs = [];
      continue;
    }

    // Docblocks do not break an attribute block; anything else does.
    if (!line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('//')) attrs = [];
  }

  return props;
}

/**
 * Extract rules from a single entity PHP file.
 */
function extractEntityRules(content, entityName) {
  const constraints = [];
  const required = [];
  const permissions = [];

  for (const prop of parseEntityProperties(content)) {
    const blob = prop.attrs.join('\n');

    // ORM column constraints — field name comes from the property declaration.
    const col = blob.match(/#\[ORM\\Column\s*\(([\s\S]*?)\)\s*\]/);
    if (col) {
      const args = col[1];
      if (/unique:\s*true/.test(args)) constraints.push({ field: prop.name, rule: 'UNIQUE' });
      if (/nullable:\s*false/.test(args)) required.push(`${entityName}.${prop.name}`);
      const len = args.match(/length:\s*(\d+)/);
      if (len) constraints.push({ field: prop.name, rule: `MAX LENGTH ${len[1]}` });
    }

    // Symfony validation constraints — every Assert\*, not a fixed list of 7.
    for (const a of blob.matchAll(/#\[Assert\\(\w+)/g)) {
      const type = a[1];
      if (type === 'NotBlank' || type === 'NotNull') required.push(`${entityName}.${prop.name}`);
      constraints.push({ field: prop.name, rule: type });
    }
  }

  // ApiResource security
  for (const s of content.match(/security:\s*"([^"]+)"/g) || []) {
    permissions.push(`${entityName}: ${s.match(/"([^"]+)"/)?.[1]}`);
  }

  return {
    constraints: dedupe(constraints, (c) => `${c.field}|${c.rule}`),
    required: [...new Set(required)],
    permissions: [...new Set(permissions)],
  };
}

function dedupe(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
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
