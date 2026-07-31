/**
 * Direct Source Reader — uses a pre-built entity→path map.
 * Zero guessing. Zero scanning. 100% accurate file paths.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env.js';
import entityMap from './entityMap.json' with { type: 'json' };

/**
 * Resolve entity name to exact file paths using the static map.
 * Handles case-insensitive matching.
 */
function resolveEntity(entityName) {
  const key = String(entityName).toLowerCase().trim();
  return entityMap[key] || { entities: [], services: [], ui: [] };
}

/**
 * Read full files for entities using the static 100% accurate map.
 */
export async function readSourceDirect(entityNames, { uiRoot, apiRoot } = {}) {
  const ui = uiRoot || env.CAPQA_LOCAL_UI_ROOT;
  const api = apiRoot || env.CAPQA_LOCAL_API_ROOT;

  if (!ui && !api) return { entities: [], services: [], ui: [], errors: ['No local roots configured'] };

  const results = { entities: [], services: [], ui: [], errors: [] };
  const seenFiles = new Set();

  for (const entityName of entityNames) {
    const paths = resolveEntity(entityName);

    for (const relPath of paths.entities) {
      const filePath = path.join(api, relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.entities.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch {}
    }

    for (const relPath of paths.services) {
      const filePath = path.join(api, relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.services.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch {}
    }

    for (const relPath of paths.ui) {
      const filePath = path.join(ui, 'src', 'app', 'pages', relPath);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        results.ui.push({ entity: entityName, file: relPath, content, lines: content.split('\n').length });
      } catch {}
    }
  }

  if (!results.entities.length && !results.ui.length) {
    results.errors.push(`No files found for: ${entityNames.join(', ')}`);
  }

  return results;
}

/**
 * Build code context from direct reads.
 * UI files are sorted: main entity form FIRST, child/tab components LAST.
 */
export function buildDirectContext(direct, primaryEntity) {
  const chunks = [];

  for (const e of direct.entities) {
    chunks.push(`\n// ENTITY: ${e.entity} (${e.file.split('/').slice(-2).join('/')}, ${e.lines} lines)\n${e.content.slice(0, 8000)}`);
  }

  for (const s of direct.services) {
    chunks.push(`\n// SERVICE: ${s.entity} (${s.file.split('/').slice(-2).join('/')}, ${s.lines} lines)\n${s.content.slice(0, 8000)}`);
  }

  // Sort UI: primary entity's OWN form first, child components last.
  // Uses entityMap to get exact file paths for the primary entity.
  const primaryFiles = new Set((entityMap[primaryEntity?.toLowerCase()]?.ui || []).map(f => f.toLowerCase()));
  
  const sorted = [...direct.ui].sort((a, b) => {
    const aPath = a.file.toLowerCase();
    const bPath = b.file.toLowerCase();
    const aIsPrimary = primaryFiles.size ? primaryFiles.has(aPath) : true;
    const bIsPrimary = primaryFiles.size ? primaryFiles.has(bPath) : true;

    if (aIsPrimary && !bIsPrimary) return -1;
    if (!aIsPrimary && bIsPrimary) return 1;
    return b.lines - a.lines;
  });

  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i];
    const label = i === 0 ? 'MAIN FORM (use this for test steps)' : 'CHILD / TAB';
    chunks.push(`\n// UI ${label}: ${u.entity} (${u.file.split('/').slice(-2).join('/')}, ${u.lines} lines)\n${u.content.slice(0, 8000)}`);
  }

  return {
    codeContext: chunks.join('\n').slice(0, 24000),
    uiContext: direct.ui.map(u => u.content).join('\n').slice(0, 12000),
    apiContext: direct.entities.map(e => e.content).join('\n').slice(0, 12000),
    sources: [
      ...direct.entities.map(e => e.file),
      ...direct.services.map(s => s.file),
      ...direct.ui.map(u => u.file),
    ],
  };
}
