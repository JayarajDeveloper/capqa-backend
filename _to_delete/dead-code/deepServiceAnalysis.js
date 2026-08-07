/**
 * Deep Business Rule Extractor — analyzes PHP service methods for
 * validation logic, guard clauses, conditional rules, and error messages.
 *
 * Goes beyond entity-level constraints to capture:
 *  1. Required field arrays in service methods
 *  2. All throw messages as rule identifiers
 *  3. Enum value validation
 *  4. Uniqueness / existence checks
 *  5. Conditional business rules (if partnerType === SUPPLIER ...)
 *  6. Symfony validator calls
 *  7. Cross-entity checks (currency exists, user exists, etc.)
 */

/**
 * Extract all throw new Exception/InvalidArgumentException messages.
 * These are the canonical business rule identifiers.
 */
function extractThrowMessages(phpSource) {
  const rules = [];
  const throwRegex = /throw\s+new\s+(?:\w+Exception|\\\w+Exception)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = throwRegex.exec(phpSource)) !== null) {
    const msg = m[1];
    // Parse structured messages like "PARTNER_CODE_ALREADY_EXISTS" or "INVALID_PARTNER_TYPE|type=..."
    const [code, ...rest] = msg.split('|');
    rules.push({
      type: 'business_guard',
      code: code.trim(),
      detail: rest.join('|').trim(),
      message: msg,
    });
  }
  return rules;
}

/**
 * Extract required field arrays from service methods.
 * Pattern: $requiredFields = ['field1', 'field2', ...]
 */
function extractRequiredFields(phpSource) {
  const required = [];
  const arrayRegex = /\$requiredFields\s*=\s*\[([^\]]+)\]/g;
  let m;
  while ((m = arrayRegex.exec(phpSource)) !== null) {
    const fields = m[1].match(/'([^']+)'/g)?.map(f => f.replace(/'/g, '')) || [];
    required.push(...fields);
  }
  return [...new Set(required)];
}

/**
 * Extract enum validation — tryFrom() calls with allowed values.
 */
function extractEnumValidation(phpSource) {
  const rules = [];
  const enumRegex = /(\w+)::tryFrom\s*\(\s*\$data\['(\w+)'\]\s*\)/g;
  let m;
  while ((m = enumRegex.exec(phpSource)) !== null) {
    const enumClass = m[1];
    const field = m[2];
    // Look for the error message nearby
    const after = phpSource.slice(m.index, m.index + 500);
    const allowedMatch = after.match(/implode\s*\([^)]*\$(\w+)::cases\(\)/);
    rules.push({
      type: 'enum_validation',
      enumClass,
      field,
      rule: `INVALID_${enumClass.toUpperCase()}`,
    });
  }
  return rules;
}

/**
 * Extract conditional business rules — if/else patterns that gate behavior.
 * Pattern: if ($data['partnerType'] === 'SUPPLIER') { ... }
 */
function extractConditionalRules(phpSource) {
  const rules = [];
  const condRegex = /if\s*\(\s*\$data\['(\w+)'\]\s*(===?|!==?)\s*['"](\w+)['"]/g;
  let m;
  while ((m = condRegex.exec(phpSource)) !== null) {
    const field = m[1];
    const op = m[2];
    const value = m[3];
    rules.push({
      type: 'conditional',
      condition: `${field} ${op} '${value}'`,
      field,
      operator: op,
      value,
    });
  }
  return rules;
}

/**
 * Extract existence/uniqueness checks.
 * Pattern: $this->someRepository->findByX($value)
 */
function extractExistenceChecks(phpSource) {
  const rules = [];
  const existRegex = /\$this->(\w+Repository)->(findBy\w+|findOneBy\w+)\s*\(\s*\$data\['(\w+)'\]/g;
  let m;
  while ((m = existRegex.exec(phpSource)) !== null) {
    const repo = m[1];
    const method = m[2];
    const field = m[3];
    const isUnique = method.includes('findBy') && !method.includes('All');
    rules.push({
      type: isUnique ? 'uniqueness_check' : 'existence_check',
      repository: repo,
      field,
      rule: isUnique ? `${field.toUpperCase()}_ALREADY_EXISTS` : `${field.toUpperCase()}_MUST_EXIST`,
    });
  }
  return rules;
}

/**
 * Extract Symfony validator calls.
 */
function extractValidatorCalls(phpSource) {
  const rules = [];
  if (/\$this->validator->validate/.test(phpSource)) {
    rules.push({
      type: 'symfony_validation',
      rule: 'ENTITY_CONSTRAINT_VALIDATION',
      detail: 'All Doctrine entity constraints (Assert\\NotBlank, Assert\\Length, etc.) are enforced here',
    });
  }
  return rules;
}

/**
 * Extract enterprise context guards.
 */
function extractTenantGuards(phpSource) {
  const rules = [];
  if (/ENTERPRISE_CONTEXT_REQUIRED/.test(phpSource)) {
    rules.push({
      type: 'tenant_guard',
      rule: 'ENTERPRISE_CONTEXT_REQUIRED',
      detail: 'A tenant/enterprise context must be set before any operation',
    });
  }
  return rules;
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Deep-analyze a service file for ALL business rules.
 * Returns structured rules by category.
 */
export function deepAnalyzeService(serviceSource, serviceName = '') {
  return {
    service: serviceName,
    throws: extractThrowMessages(serviceSource),
    requiredFields: extractRequiredFields(serviceSource),
    enumValidation: extractEnumValidation(serviceSource),
    conditionals: extractConditionalRules(serviceSource),
    existenceChecks: extractExistenceChecks(serviceSource),
    validatorCalls: extractValidatorCalls(serviceSource),
    tenantGuards: extractTenantGuards(serviceSource),
    summary: {
      totalRules:
        extractThrowMessages(serviceSource).length +
        extractConditionalRules(serviceSource).length +
        extractExistenceChecks(serviceSource).length +
        (extractRequiredFields(serviceSource).length > 0 ? 1 : 0) +
        extractEnumValidation(serviceSource).length +
        extractValidatorCalls(serviceSource).length +
        extractTenantGuards(serviceSource).length,
    },
  };
}

/**
 * Format deep analysis as LLM prompt.
 */
export function formatDeepAnalysis(analysis, entityName = '') {
  if (!analysis) return '';
  const lines = [];
  lines.push(`\nDEEP SERVICE ANALYSIS: ${entityName}`);
  lines.push('─'.repeat(40));

  if (analysis.requiredFields?.length) {
    lines.push(`\nREQUIRED FIELDS (service-level, in addition to entity constraints):`);
    lines.push(`  ${analysis.requiredFields.join(', ')}`);
  }

  if (analysis.throws?.length) {
    lines.push(`\nBUSINESS GUARDS (throw conditions):`);
    for (const t of analysis.throws) {
      const detail = t.detail ? ` — ${t.detail}` : '';
      lines.push(`  ⚠ ${t.code}${detail}`);
    }
  }

  if (analysis.enumValidation?.length) {
    lines.push(`\nENUM VALIDATION:`);
    for (const e of analysis.enumValidation) {
      lines.push(`  ${e.field}: must be valid ${e.enumClass} value`);
    }
  }

  if (analysis.conditionals?.length) {
    lines.push(`\nCONDITIONAL RULES:`);
    for (const c of analysis.conditionals) {
      lines.push(`  When ${c.field} ${c.operator} '${c.value}' → different behavior applies`);
    }
  }

  if (analysis.existenceChecks?.length) {
    lines.push(`\nEXISTENCE / UNIQUENESS CHECKS:`);
    for (const e of analysis.existenceChecks) {
      lines.push(`  ${e.field}: ${e.rule} (checked via ${e.repository}->${e.method || 'find'})`);
    }
  }

  if (analysis.validatorCalls?.length) {
    lines.push(`\nVALIDATION:`);
    for (const v of analysis.validatorCalls) {
      lines.push(`  ✅ ${v.rule}: ${v.detail}`);
    }
  }

  if (analysis.tenantGuards?.length) {
    lines.push(`\nTENANT GUARDS:`);
    for (const t of analysis.tenantGuards) {
      lines.push(`  🔒 ${t.rule}`);
    }
  }

  lines.push(`\nTotal rules extracted: ${analysis.summary.totalRules}`);
  return lines.join('\n');
}
