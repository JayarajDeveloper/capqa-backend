/**
 * Business Rule Extractor — scans live target backend code (Entities, Services, Security)
 * and builds a structured catalog of business rules for the LLM to generate
 * comprehensive test cases (happy path + negative + boundary + permission).
 *
 * Extracted patterns:
 *   1. Doctrine ORM constraints (type, length, nullable, unique, enum values)
 *   2. Symfony Assert validators (NotBlank, Length, Email, Regex, Range, Positive, etc.)
 *   3. ApiResource security rules (role-based access per operation)
 *   4. Service-level guard clauses (throw/return early on invalid state)
 *   5. Custom validation logic patterns
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getLocalRoots } from './localSource.js';
import { layerOf } from './retrieve.js';

// ── Pattern Matchers ──────────────────────────────────────────────

/** Extract #[ORM\Column(type: '...', length: N, nullable: true, unique: true)] */
function extractDoctrineColumns(phpSource) {
  const columns = [];
  // Match property blocks: property name + its ORM\Column + Assert constraints
  const propertyRegex = /(?:private|protected|public)\s+(?:\?\s*)?(?:readonly\s+)?(\w+)\s+\$(\w+)/g;
  let m;
  while ((m = propertyRegex.exec(phpSource)) !== null) {
    const type = m[1];
    const propName = m[2];
    const pos = m.index;
    // Look backwards for attributes on this property (within ~500 chars)
    const block = phpSource.slice(Math.max(0, pos - 500), pos);
    
    const colMatch = block.match(/#\[ORM\\Column\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)/s);
    if (!colMatch) continue;
    
    const colArgs = colMatch[1];
    const colType = (colArgs.match(/type\s*:\s*['"](\w+)['"]/) || [])[1] || type;
    const length = (colArgs.match(/length\s*:\s*(\d+)/) || [])[1];
    const isNullable = /nullable\s*:\s*true/.test(colArgs);
    const isUnique = /unique\s*:\s*true/.test(colArgs);
    
    // Extract Assert constraints from the block
    const assertions = [];
    const assertRegex = /#\[Assert\\(\w+)\s*\(([^)]*)\)/g;
    let am;
    while ((am = assertRegex.exec(block)) !== null) {
      const name = am[1];
      const args = am[2];
      const rule = { constraint: name };
      
      if (name === 'NotBlank') rule.required = true;
      if (name === 'Length') {
        const min = (args.match(/min\s*:\s*(\d+)/) || [])[1];
        const max = (args.match(/max\s*:\s*(\d+)/) || [])[1];
        if (min) rule.minLength = parseInt(min);
        if (max) rule.maxLength = parseInt(max);
      }
      if (name === 'Email') rule.format = 'email';
      if (name === 'Regex') {
        const pattern = (args.match(/pattern\s*:\s*['"]([^'"]+)['"]/) || [])[1];
        if (pattern) rule.pattern = pattern;
      }
      if (name === 'Range') {
        const rmin = (args.match(/min\s*:\s*(\d+)/) || [])[1];
        const rmax = (args.match(/max\s*:\s*(\d+)/) || [])[1];
        if (rmin) rule.min = parseInt(rmin);
        if (rmax) rule.max = parseInt(rmax);
      }
      if (name === 'Positive' || name === 'PositiveOrZero') {
        rule.min = 0;
        if (name === 'Positive') rule.min = 1;
      }
      if (name === 'Choice') {
        const choices = (args.match(/choices\s*:\s*\[([^\]]+)\]/) || [])[1];
        if (choices) {
          rule.allowedValues = choices.split(',').map(s => s.trim().replace(/['"]/g, ''));
        }
      }
      
      const msg = (args.match(/message\s*:\s*['"]([^'"]+)['"]/) || [])[1];
      if (msg) rule.message = msg;
      
      assertions.push(rule);
    }
    
    // Check for enum type
    const enumMatch = colType.match(/^(\w+)_enum$/);
    const isEnum = !!enumMatch && colType.includes('_enum');
    
    columns.push({
      property: propName,
      type: colType,
      length: length ? parseInt(length) : null,
      nullable: isNullable,
      unique: isUnique,
      isEnum,
      assertions,
    });
  }
  return columns;
}

/** Extract #[ApiResource] security rules per operation. */
function extractApiSecurity(phpSource) {
  const rules = [];
  const apiBlock = phpSource.match(/#\[ApiResource\s*\(([\s\S]*?)\)\s*\]/);
  if (!apiBlock) return rules;
  
  const operations = ['Get', 'GetCollection', 'Post', 'Put', 'Delete', 'Patch'];
  for (const op of operations) {
    const opRegex = new RegExp(`new\\s+${op}\\s*\\([\\s\\S]*?security\\s*:\\s*['"]([^'"]+)['"]`, 'g');
    let m;
    while ((m = opRegex.exec(phpSource)) !== null) {
      const expr = m[1];
      const roles = [];
      if (expr.includes('ROLE_MANAGER')) roles.push('MANAGER');
      if (expr.includes('ROLE_ADMIN')) roles.push('ADMIN');
      if (expr.includes('ROLE_SUPER_ADMIN')) roles.push('SUPER_ADMIN');
      
      // Extract permission scopes like "partner", "partner_create"
      const scopeMatch = expr.match(/is_granted\('([^']+)'\)/g);
      if (scopeMatch) {
        for (const g of scopeMatch) {
          const scope = g.match(/is_granted\('([^']+)'\)/)[1];
          if (!scope.startsWith('ROLE_')) roles.push(scope);
        }
      }
      
      rules.push({
        operation: op,
        roles,
        expression: expr,
      });
    }
  }
  return rules;
}

/** Extract enum class values from PHP enum definitions. */
function extractEnumValues(phpSource) {
  const enums = [];
  const caseRegex = /case\s+(\w+)\s*=\s*['"](\w+)['"]/g;
  let m;
  while ((m = caseRegex.exec(phpSource)) !== null) {
    enums.push({ name: m[1], value: m[2] });
  }
  return enums;
}

/** Extract guard clauses and business logic from Service methods. */
function extractServiceRules(phpSource) {
  const rules = [];
  
  // Pattern: throw new \Exception('some business message')
  const throwRegex = /throw\s+new\s+(?:\\?)(\w+Exception)\s*\(\s*['"]([^'"]{10,})['"]/g;
  let m;
  while ((m = throwRegex.exec(phpSource)) !== null) {
    rules.push({
      type: 'business_guard',
      exception: m[1],
      message: m[2],
    });
  }
  
  // Pattern: if (condition) { return error/throw }
  const guardRegex = /if\s*\(([^)]{5,100})\)\s*\{\s*(?:throw|return\s+(?:new\s+)?\w+Response[^;]*;)/g;
  let gm;
  while ((gm = guardRegex.exec(phpSource)) !== null) {
    const cond = gm[1].trim();
    // Only capture meaningful conditions
    if (cond.length > 10 && !cond.includes('$this->')) continue;
    rules.push({
      type: 'guard_clause',
      condition: cond.replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  
  return rules;
}

/** Extract searchable/filterable fields from ApiFilter annotations. */
function extractApiFilters(phpSource) {
  const filters = [];
  const filterRegex = /#\[ApiFilter\s*\(\s*(\w+)::class\s*,\s*properties\s*:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = filterRegex.exec(phpSource)) !== null) {
    const filterType = m[1];
    const propsStr = m[2];
    const propRegex = /['"](\w+)['"]\s*=>\s*['"](\w+)['"]/g;
    let pm;
    while ((pm = propRegex.exec(propsStr)) !== null) {
      filters.push({
        field: pm[1],
        filter: pm[2],
        type: filterType,
      });
    }
  }
  return filters;
}

/** Extract entity relationships (ManyToOne, OneToMany, etc.). */
function extractRelationships(phpSource) {
  const rels = [];
  const relRegex = /#\[ORM\\(\w+)\s*\(\s*targetEntity\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = relRegex.exec(phpSource)) !== null) {
    rels.push({
      type: m[1],
      targetEntity: m[2].split('\\').pop(),
    });
  }
  return rels;
}

// ── Full-file reads from local disk (bypasses chunk truncation) ──

/** Read full entity files from local CAPQA_LOCAL_API_ROOT when configured. */
async function loadFullEntityFiles(entityPaths) {
  const { api } = getLocalRoots();
  if (!api) return [];
  
  const fullFiles = [];
  const seen = new Set();
  
  for (const filePath of entityPaths) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    
    try {
      const fullPath = path.join(api, filePath);
      const content = await fs.readFile(fullPath, 'utf8');
      fullFiles.push({ path: filePath, content, layer: 'database' });
    } catch {
      // File not on disk — skip
    }
  }
  
  return fullFiles;
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Read live backend code and extract business rules for a given feature/entity.
 * @param {object} options
 * @param {Array<{path: string, content: string}>} backendChunks - Live backend code chunks
 * @returns {object} Structured business rule catalog
 */
export async function extractBusinessRules(backendChunks = []) {
  if (!backendChunks.length) return null;

  // Collect unique Entity file paths and read them fully from local disk
  const entityPaths = [...new Set(
    backendChunks
      .filter(c => (c.layer || layerOf(c.path)) === 'database' || c.path.includes('/Entity/'))
      .map(c => c.path)
  )];
  
  // Read full entity files from local disk (bypasses chunk truncation)
  const fullEntities = await loadFullEntityFiles(entityPaths);
  
  // Use full-file reads for entities, keep chunks for other files
  const allChunks = [
    ...fullEntities,
    ...backendChunks.filter(c => {
      const l = c.layer || layerOf(c.path);
      return l !== 'database' && !c.path.includes('/Entity/');
    }),
  ];

  const catalog = {
    entities: [],
    enums: [],
    services: [],
    security: [],
    summary: {
      totalRules: 0,
      totalConstraints: 0,
      totalPermissions: 0,
    },
  };

  // Entity map for merging across chunks
  const entityMap = new Map();
  const serviceMap = new Map();
  const enumMap = new Map();

  for (const chunk of allChunks) {
    const source = chunk.content || '';
    const filePath = chunk.path || '';
    const layer = chunk.layer || layerOf(filePath);
    const fileName = filePath.split('/').pop() || '';

    // Entity files — merge across chunks
    if (layer === 'database' || filePath.includes('/Entity/')) {
      const entityName = fileName.replace(/\.php$/, '');
      const columns = extractDoctrineColumns(source);
      const security = extractApiSecurity(source);
      const filters = extractApiFilters(source);
      const relationships = extractRelationships(source);

      if (columns.length || security.length) {
        const existing = entityMap.get(entityName);
        if (existing) {
          // Merge columns: deduplicate by property name
          const seen = new Set(existing.columns.map(c => c.property));
          for (const col of columns) {
            if (!seen.has(col.property)) {
              existing.columns.push(col);
              seen.add(col.property);
            }
          }
          // Merge security rules
          for (const s of security) {
            if (!existing.security.some(es => es.operation === s.operation)) {
              existing.security.push(s);
            }
          }
          existing.filters.push(...filters);
          existing.relationships.push(...relationships);
          existing.fieldCount = existing.columns.length;
          existing.constraintCount = existing.columns.reduce((n, c) => n + c.assertions.length, 0);
          existing.requiredFields = [...new Set([
            ...existing.requiredFields,
            ...columns.filter(c => c.assertions.some(a => a.constraint === 'NotBlank') || !c.nullable).map(c => c.property),
          ])];
          existing.hasUniqueFields = existing.hasUniqueFields || columns.some(c => c.unique);
        } else {
          const entry = {
            entity: entityName,
            file: filePath,
            columns,
            security,
            filters,
            relationships,
            requiredFields: columns.filter(c => c.assertions.some(a => a.constraint === 'NotBlank') || !c.nullable).map(c => c.property),
            hasUniqueFields: columns.some(c => c.unique),
            fieldCount: columns.length,
            constraintCount: columns.reduce((n, c) => n + c.assertions.length, 0),
          };
          entityMap.set(entityName, entry);
        }
      }
    }

    // Enum files — merge
    if (filePath.includes('/Enum/')) {
      const values = extractEnumValues(source);
      if (values.length) {
        const name = fileName.replace(/\.php$/, '');
        const existing = enumMap.get(name);
        if (existing) {
          existing.values.push(...values.filter(v => !existing.values.some(ev => ev.name === v.name)));
        } else {
          enumMap.set(name, { name, file: filePath, values });
        }
      }
    }

    // Service files — merge
    if (layer === 'backend' || filePath.includes('/Service/')) {
      const rules = extractServiceRules(source);
      if (rules.length) {
        const sname = fileName.replace(/\.php$/, '');
        const existing = serviceMap.get(sname);
        if (existing) {
          existing.rules.push(...rules);
        } else {
          serviceMap.set(sname, { service: sname, file: filePath, rules });
        }
      }
    }

    // Security/Voter files
    if (filePath.includes('/Security/') || filePath.includes('/Voter/')) {
      catalog.security.push({
        file: filePath,
        name: fileName.replace(/\.php$/, ''),
      });
    }
  }

  catalog.entities = [...entityMap.values()];
  catalog.enums = [...enumMap.values()];
  catalog.services = [...serviceMap.values()];

  catalog.summary.totalConstraints = catalog.entities.reduce((n, e) => n + e.constraintCount, 0);
  catalog.summary.totalPermissions = catalog.entities.reduce((n, e) => n + e.security.length, 0);
  catalog.summary.totalRules = catalog.summary.totalConstraints + catalog.summary.totalPermissions
    + catalog.services.reduce((n, s) => n + s.rules.length, 0);

  return catalog;
}

/** Extract business rules for specific entity names (bypasses RAG chunks). */
export async function extractBusinessRulesForEntities(entityNames) {
  if (!entityNames?.length) return null;
  const { api } = getLocalRoots();
  if (!api) return null;

  // Find entity files on disk
  const filePaths = [];
  const entityDir = path.join(api, 'src', 'Features');
  for (const name of entityNames) {
    const results = await findEntityFile(entityDir, name);
    filePaths.push(...results);
  }

  const fullFiles = await loadFullEntityFiles([...new Set(filePaths)]);
  if (!fullFiles.length) return null;

  // Same catalog + entity map as extractBusinessRules
  const catalog = { entities: [], enums: [], services: [], security: [], summary: { totalRules: 0, totalConstraints: 0, totalPermissions: 0 } };
  const entityMap = new Map();

  for (const chunk of fullFiles) {
    const source = chunk.content || '';
    const filePath = chunk.path || '';
    const fileName = filePath.split('/').pop() || '';
    const entityName = fileName.replace(/\.php$/, '');

    const columns = extractDoctrineColumns(source);
    const security = extractApiSecurity(source);
    const enums = extractEnumValues(source);
    const serviceRules = extractServiceRules(source);
    const filters = extractApiFilters(source);
    const relationships = extractRelationships(source);

    // Merge entities
    if (entityMap.has(entityName)) {
      const existing = entityMap.get(entityName);
      for (const col of columns) {
        if (!existing.columns.find(c => c.name === col.name)) existing.columns.push(col);
      }
      for (const s of security) {
        if (!existing.security.find(x => x.operation === s.operation)) existing.security.push(s);
      }
      existing.constraintCount = existing.columns.reduce((sum, c) => sum + (c.constraints || []).length, 0);
      existing.fieldCount = existing.columns.length;
    } else {
      entityMap.set(entityName, {
        entity: entityName,
        columns,
        security,
        enums,
        filters,
        relationships,
        fieldCount: columns.length,
        constraintCount: columns.reduce((sum, c) => sum + (c.constraints || []).length, 0),
        requiredFields: columns.filter(c => c.required).map(c => c.name),
      });
    }

    // Enums
    for (const e of enums) {
      if (!catalog.enums.find(x => x.name === e.name)) catalog.enums.push(e);
    }

    // Services
    for (const s of serviceRules) {
      if (!catalog.services.find(x => x.rule === s.rule)) catalog.services.push(s);
    }
  }

  // Convert entity map to array with properties
  for (const [name, data] of entityMap) {
    catalog.entities.push({
      entity: name,
      fieldCount: data.fieldCount,
      constraintCount: data.constraintCount,
      requiredFields: data.requiredFields,
      security: data.security,
      properties: data.columns.map(c => ({
        name: c.property || c.name,
        type: c.type,
        required: !c.nullable,
        maxLength: c.length,
        unique: c.unique,
        columnType: c.type,
      })),
    });
  }

  catalog.summary.totalRules = catalog.services.length + catalog.entities.reduce((s, e) => s + e.constraintCount, 0);
  catalog.summary.totalConstraints = catalog.entities.reduce((s, e) => s + e.constraintCount, 0);
  catalog.summary.totalPermissions = catalog.entities.reduce((s, e) => s + e.security.length, 0);

  return catalog;
}

async function findEntityFile(baseDir, entityName) {
  const found = [];
  async function scan(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full, depth + 1);
      else if (entry.name === `${entityName}.php` && full.includes('/Entity/')) {
        // Return path relative to api root for loadFullEntityFiles
        found.push(path.relative(baseDir.replace(/\/src\/Features$/, ''), full));
      }
    }
  }
  await scan(baseDir);
  return found;
}

/**
 * Build a prompt block from the business rule catalog for LLM consumption.
 */
export function formatBusinessRulesForPrompt(catalog, featureName = '') {
  if (!catalog || typeof catalog.then === 'function') return '';

  const entities = Array.isArray(catalog.entities) ? catalog.entities : [];
  const enums = Array.isArray(catalog.enums) ? catalog.enums : [];
  const services = Array.isArray(catalog.services) ? catalog.services : [];

  const lines = [];
  lines.push('BUSINESS RULES & CONSTRAINTS (extracted from live backend code):');
  lines.push('');

  // Entities + constraints
  for (const entity of entities) {
    lines.push(`## ${entity.entity} (${entity.fieldCount} fields, ${entity.constraintCount} constraints)`);
    
    if (entity.security.length) {
      lines.push('  API Permissions:');
      for (const perm of entity.security) {
        const roleList = perm.roles.length ? ` [${perm.roles.join(', ')}]` : '';
        lines.push(`    ${perm.operation}: requires${roleList} "${perm.expression.slice(0, 80)}"`);
      }
    }
    
    if (entity.requiredFields.length) {
      lines.push(`  Required fields: ${entity.requiredFields.join(', ')}`);
    }
    
    for (const col of entity.columns) {
      const constraints = col.assertions.map(a => {
        let s = a.constraint;
        if (a.minLength != null) s += `(min=${a.minLength})`;
        if (a.maxLength != null) s += `(max=${a.maxLength})`;
        if (a.min != null) s += `(min=${a.min})`;
        if (a.max != null) s += `(max=${a.max})`;
        if (a.pattern) s += `(pattern=${a.pattern})`;
        if (a.allowedValues) s += `(choices: ${a.allowedValues.join('|')})`;
        return s;
      });
      const parts = [];
      parts.push(`  ${col.property}: ${col.type}`);
      if (col.length) parts.push(`length=${col.length}`);
      if (col.nullable) parts.push('nullable');
      if (col.unique) parts.push('UNIQUE');
      if (col.isEnum) parts.push('ENUM');
      if (constraints.length) parts.push(`[${constraints.join(', ')}]`);
      lines.push(parts.join(' · '));
    }
    lines.push('');
  }

  // Enums
  for (const e of enums) {
    lines.push(`## Enum: ${e.name}`);
    lines.push(`  Values: ${e.values.map(v => v.name).join(', ')}`);
    lines.push('');
  }

  // Service rules
  for (const svc of services) {
    const guards = svc.rules.filter(r => r.type === 'business_guard');
    if (guards.length) {
      lines.push(`## Service: ${svc.service} — Business Guards`);
      for (const g of guards.slice(0, 5)) {
        lines.push(`  ⚠ ${g.message}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Given entity constraints, generate implied negative/boundary test scenarios.
 */
export function generateNegativeScenarios(catalog) {
  const scenarios = [];
  for (const entity of catalog.entities) {
    const name = entity.entity;
    
    // Required field tests
    for (const field of entity.requiredFields) {
      scenarios.push({
        type: 'negative',
        scenario: `Create ${name} with empty "${field}" → validation error`,
        field,
        rule: 'required',
      });
    }
    
    // Length boundary tests
    for (const col of entity.columns) {
      const lengthAssert = col.assertions.find(a => a.constraint === 'Length');
      if (lengthAssert && lengthAssert.maxLength) {
        scenarios.push({
          type: 'boundary',
          scenario: `Create ${name} with "${col.property}" exceeding ${lengthAssert.maxLength} chars → validation error`,
          field: col.property,
          rule: `maxLength=${lengthAssert.maxLength}`,
        });
      }
      if (lengthAssert && lengthAssert.minLength && lengthAssert.minLength > 1) {
        scenarios.push({
          type: 'boundary',
          scenario: `Create ${name} with "${col.property}" below ${lengthAssert.minLength} chars → validation error`,
          field: col.property,
          rule: `minLength=${lengthAssert.minLength}`,
        });
      }
    }
    
    // Unique constraint tests
    if (entity.hasUniqueFields) {
      const uniqueField = entity.columns.find(c => c.unique);
      if (uniqueField) {
        scenarios.push({
          type: 'negative',
          scenario: `Create ${name} with duplicate "${uniqueField.property}" → uniqueness error`,
          field: uniqueField.property,
          rule: 'unique',
        });
      }
    }
    
    // Permission tests
    const writes = entity.security.filter(s => 
      s.operation === 'Post' || s.operation === 'Put' || s.operation === 'Delete'
    );
    if (writes.length) {
      scenarios.push({
        type: 'permission',
        scenario: `Attempt ${name} ${writes[0].operation.toLowerCase()} without required roles → 403`,
        rule: 'authorization',
      });
    }
    
    // Enum/Choice tests
    for (const col of entity.columns) {
      const choiceAssert = col.assertions.find(a => a.allowedValues);
      if (choiceAssert) {
        scenarios.push({
          type: 'negative',
          scenario: `Set "${col.property}" to an invalid value not in [${choiceAssert.allowedValues.join(', ')}] → validation error`,
          field: col.property,
          rule: 'enum',
        });
      }
    }
  }
  
  return scenarios;
}
