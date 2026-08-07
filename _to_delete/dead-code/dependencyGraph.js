/**
 * Cross-Module Dependency Graph — maps how CapBO entities depend on each other.
 * Used to generate multi-phase test flows where dependencies must be created first.
 *
 * Example: "link partner to article"
 *   → ArticlePartner depends on Partner + Article
 *   → Article depends on Currency, VAT, RetailChain
 *   → Partner depends on Currency
 *   → Ordered flow: Currency → Partner → RetailChain → VAT → Article → ArticlePartner
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getLocalRoots } from './localSource.js';
import { targetAdapter } from '../../adapters/index.js';

/**
 * Scan all Entity PHP files and extract relationship dependencies.
 * @returns {Map<string, {file: string, dependsOn: string[], fields: string[]}>}
 */
export async function buildDependencyGraph() {
  const { api } = getLocalRoots();
  if (!api) return new Map();

  const graph = new Map();
  const entityDir = path.join(api, 'src', 'Features');

  async function scan(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full, depth + 1);
      else if (entry.name.endsWith('.php') && full.includes('/Entity/')) {
        try {
          const content = await fs.readFile(full, 'utf8');
          const entityName = entry.name.replace('.php', '');

          // Extract targetEntity references (both ::class and 'string' formats)
          const deps = [];
          const requiredDeps = [];
          const depRegex = /targetEntity:\s*(?:'([^']+)'|"([^"]+)"|(\w+)::class)/g;
          let m;
          while ((m = depRegex.exec(content)) !== null) {
            const dep = (m[1] || m[2] || m[3] || '').split('\\').pop();
            if (dep && dep !== entityName && dep !== 'self') {
              deps.push(dep);
              // Check if this is a NOT NULL FK (hard dependency)
              // nullable: false is on #[JoinColumn] which comes AFTER #[ManyToOne]
              const after = content.slice(m.index, m.index + 300);
              if (/nullable\s*:\s*false/.test(after)) {
                requiredDeps.push(dep);
              }
            }
          }

          // Extract field/property names
          const fields = [];
          const fieldRegex = /private\s+(?:\?\s*)?(?:readonly\s+)?\w+\s+\$(\w+)/g;
          let fm;
          while ((fm = fieldRegex.exec(content)) !== null) {
            fields.push(fm[1]);
          }

          const relPath = path.relative(api, full);
          graph.set(entityName, {
            file: relPath,
            dependsOn: [...new Set(deps)],
            requiredDeps: [...new Set(requiredDeps)],
            fields,
          });
        } catch { /* skip unreadable */ }
      }
    }
  }

  await scan(entityDir);
  return graph;
}

/**
 * Given a target entity, compute the hard dependency chain (NOT NULL FKs only).
 * Returns entities in creation order. Depth-limited to avoid infinite recursion.
 *
 * Auto-detects seed/system entities:
 *  - Entities with no UI pages folder (no standalone create/edit pages)
 *  - Translation entities (always excluded)
 *  - Entities marked as nullable FKs (optional, not hard deps)
 */
export function resolveDependencyChain(graph, targetEntity, { maxDepth = 3, useRequired = true, uiEntityNames = null } = {}) {
  const visited = new Set();
  const order = [];

  // Auto-detect seed entities: entities with no UI folder are system/seed data
  const uiSet = uiEntityNames instanceof Set ? uiEntityNames : new Set(uiEntityNames || []);

  function isSeedEntity(name) {
    if (!graph.has(name)) return false;
    if (name.endsWith(targetAdapter.i18nEntitySuffix)) return true;
    // Entities without UI pages are seed/system data (Country, City, Currency, etc.)
    if (uiSet.size > 0 && !uiSet.has(name)) return true;
    return false;
  }

  function visit(name, depth = 0) {
    if (visited.has(name) || depth > maxDepth) return;
    if (isSeedEntity(name)) return;

    visited.add(name);
    const node = graph.get(name);
    if (node) {
      const deps = useRequired ? (node.requiredDeps || node.dependsOn) : node.dependsOn;
      for (const dep of deps) {
        if (graph.has(dep) && dep !== name && !isSeedEntity(dep)) {
          visit(dep, depth + 1);
        }
      }
    }
    if (name !== targetEntity) {
      order.push(name);
    }
  }

  visit(targetEntity);
  order.push(targetEntity);
  return order;
}

/**
 * Build RAG search queries for all entities in a dependency chain.
 */
export function buildCrossModuleQueries(graph, targetEntity) {
  const chain = resolveDependencyChain(graph, targetEntity);
  const queries = [];

  for (const entity of chain) {
    const node = graph.get(entity);
    if (!node) continue;

    // Entity + its own constraints
    queries.push({
      entity,
      query: `${entity.toLowerCase()} entity validator constraint service`,
      layers: ['backend', 'database'],
      topK: 12,
    });

    // UI forms
    const slug = entity.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    queries.push({
      entity,
      query: `${slug} form component create html ts`,
      layers: ['ui'],
      topK: 8,
    });
  }

  return { chain, queries };
}

/**
 * Build a multi-phase Playwright spec outline from a dependency chain.
 */
export function buildMultiPhaseSpecOutline(graph, targetEntity) {
  const chain = resolveDependencyChain(graph, targetEntity);
  const phases = [];

  for (const entity of chain) {
    const node = graph.get(entity);
    phases.push({
      phase: phases.length + 1,
      entity,
      action: 'create',
      description: `Create ${entity}`,
      dependsOn: node?.dependsOn.filter(d => chain.includes(d)) || [],
    });
  }

  return {
    target: targetEntity,
    chain,
    phases,
    totalPhases: phases.length,
    note: chain.length > 1
      ? `Multi-module: create ${chain.join(' → ')}`
      : `Single module: ${targetEntity}`,
  };
}
