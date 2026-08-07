import { NAVIGATION, resolveNavigation } from '../rag/navigationModel.js';
import { extractBusinessRules } from '../rag/businessRules.js';
import { getLocalRoots } from '../rag/localSource.js';
import { layerOf } from '../rag/retrieve.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';

// ── Field extraction from entity analysis ─────────────────────────

/** Extract fields from business rule catalog, grouped by entity. */
function extractFieldsFromCatalog(catalog) {
  const fieldsByEntity = new Map();
  if (!catalog?.entities) return fieldsByEntity;
  
  for (const entity of catalog.entities) {
    const fields = [];
    for (const prop of (entity.properties || [])) {
      const propName = prop.name || prop.column_name || '';
      if (!propName || propName === 'id') continue;
      fields.push({
        name: propName,
        label: propName.replace(/([A-Z])/g, ' $1').trim(),
        type: prop.columnType || 'string',
        required: !!prop.required,
        maxLength: prop.maxLength || null,
        testId: prop.testId || `${entity.entity.toLowerCase().replace(/\s+/g, '-')}-${propName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
        formControl: propName,
        isDropdown: prop.columnType === 'entity' || prop.columnType === 'enum' || propName.endsWith('Id') || propName.endsWith('_id'),
      });
    }
    fieldsByEntity.set(entity.entity, fields);
  }
  return fieldsByEntity;
}

/** Add navigation context to each entity: route, create/save testIds. */
function enrichWithNavigation(fieldsByEntity) {
  const enriched = new Map();
  for (const [entityName, fields] of fieldsByEntity) {
    const nav = resolveNavigation(entityName);
    enriched.set(entityName, {
      fields,
      nav: nav ? {
        listRoute: nav.listRoute || nav.route,
        createTestId: (fields.find(f => f.testId?.endsWith('-create')) || {}).testId
          || `${nav.listRoute?.replace(/\//g, '') || entityName.toLowerCase()}-create`,
        saveTestId: (fields.find(f => f.testId?.endsWith('-save')) || {}).testId
          || `${nav.listRoute?.replace(/\//g, '') || entityName.toLowerCase()}-save`,
        formPattern: nav.formPattern || 'inline',
        tabs: nav.tabs || [],
        navigationNote: nav.navigationNote || null,
      } : {
        listRoute: `/${entityName.toLowerCase()}`,
        createTestId: `${entityName.toLowerCase()}-create`,
        saveTestId: `${entityName.toLowerCase()}-save`,
      },
    });
  }
  return enriched;
}

// ── Step generator ─────────────────────────────────────────────────

/** Generate value for a field — uses LLM for smart values, fallback for basic ones. */
function fieldValue(field, context = {}) {
  if (field.isDropdown) {
    return context.userPick || '__first__';
  }
  if (field.name === 'code') return `TEST-${context.suffix || Date.now().toString(36).toUpperCase()}`;
  if (field.name === 'name' || field.name === 'shortDesignation') return context.name || `Test ${field.label}`;
  if (field.type === 'integer' || field.type === 'decimal') return context.number || '1';
  if (field.maxLength && field.maxLength < 50) return 'X'.repeat(Math.max(1, field.maxLength - 1));
  return context.value || `auto-${field.name}`;
}

/** Build entity phase steps. Filters system fields and marks dropdowns correctly. */
function buildEntityPhase(entityName, entityData, phaseNum, context = {}) {
  const { fields, nav } = entityData;
  const steps = [];
  const prefix = `ph${phaseNum}`;

  // System fields to skip
  const skipFields = new Set([
    'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'enterprise',
    'isDynamic', 'dynamicCriteria', 'isReturnable', 'sellingUnit',
    'rejectionComment', 'artcodeReftype', 'isLocalArticle', 'family',
    'contactInfo', 'isPrimary', 'status', 'price',
  ]);

  // Step 1: Navigate
  steps.push({
    id: `${prefix}-goto`, action: 'goto', path: nav.listRoute,
    description: `Phase ${phaseNum}: Navigate to ${entityName}`,
  });

  // Step 2: Click Add/Create
  if (!nav.isChildModule) {
    steps.push({
      id: `${prefix}-add`, action: 'click', testId: nav.createTestId,
      description: `Click Add to open ${entityName} form`,
    });
  }

  // Step 3-N: Fill/Select each field
  let fillIdx = 0;
  for (const field of fields) {
    const fn = field.name;
    if (skipFields.has(fn)) continue;
    if (fn === 'isActive') continue;

    const value = fieldValue(field, context);
    const isDropdown = field.isDropdown || fn.endsWith('Id') || fn.endsWith('Code') ||
      fn === 'partnerType' || fn === 'enterpriseIdentifierType' || fn === 'vatPercentage' ||
      field.type === 'entity';

    if (isDropdown) {
      steps.push({
        id: `${prefix}-sel-${fillIdx}`, action: 'select',
        formControl: field.formControl, testId: field.testId,
        value: '__first__', description: `Select ${field.label}`,
      });
    } else {
      steps.push({
        id: `${prefix}-fill-${fillIdx}`, action: 'fill',
        formControl: field.formControl, testId: field.testId,
        value, description: `Enter ${field.label}: "${value}"`,
      });
    }
    fillIdx++;
  }

  // Final step: Save
  steps.push({
    id: `${prefix}-save`, action: 'click', testId: nav.saveTestId,
    description: `Save ${entityName}`,
  });

  return steps;
}

// ── Main orchestrator ──────────────────────────────────────────────

/** Generate a complete execution plan for a dependency chain. */
export function generateFieldDrivenPlan(dependencyChain, fieldsByEntity, context = {}) {
  const enriched = enrichWithNavigation(fieldsByEntity);
  const phases = [];
  const allSteps = [];

  for (let i = 0; i < dependencyChain.length; i++) {
    const entityName = dependencyChain[i];
    const entityData = enriched.get(entityName);
    if (!entityData) continue;

    // Mark child modules
    if (i > 0 && !entityData.nav.listRoute) {
      entityData.nav.isChildModule = true;
      // Find parent
      const parent = resolveNavigation(dependencyChain[i - 1]);
      if (parent?.tabs) {
        entityData.nav.navigationNote = `Switch to "${parent.tabs.find(t => 
          entityName.toLowerCase().includes(t.toLowerCase())) || parent.tabs[0]}" tab`;
      }
    }

    const steps = buildEntityPhase(entityName, entityData, i + 1, context);
    phases.push({ entity: entityName, nav: entityData.nav, steps });
    allSteps.push(...steps);
  }

  return {
    action: 'create',
    route: phases[0]?.nav?.listRoute || '/partners',
    steps: allSteps,
    phases,
    phaseCount: phases.length,
    stepCount: allSteps.length,
    isFieldDriven: true,
  };
}

/** Build the full compose response — executionPlan + uiPlan. */
export function buildFieldDrivenResponse(dependencyChain, catalog, title = '') {
  const fieldsByEntity = extractFieldsFromCatalog(catalog);
  const plan = generateFieldDrivenPlan(dependencyChain, fieldsByEntity, {
    suffix: Date.now().toString(36).toUpperCase().slice(-6),
    name: title || 'Test Entity',
  });

  const uiSteps = [];
  for (const p of plan.phases) {
    uiSteps.push(`Phase ${plan.phases.indexOf(p) + 1}: ${p.entity} — ${p.steps.length} steps (${p.nav?.listRoute || '/dialog'})`);
    for (const s of p.steps) {
      uiSteps.push(`  ${s.description}`);
    }
  }

  return {
    uiPlan: {
      title: title || 'Field-driven test',
      runAs: 'UI · Browser',
      steps: uiSteps,
      acceptanceCriteria: [
        { id: 'AC1', requirement: 'All entities created and linked successfully', proof: 'Verify in list' },
      ],
    },
    executionPlan: plan,
    isFieldDriven: true,
  };
}
