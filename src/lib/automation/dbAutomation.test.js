/**
 * Smoke tests for Database schema/migration automation (no row data asserts).
 * Uses real CapBO Doctrine entities from indexed backend code — no hardcoded column lists.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDbAutomation, resolveDbTableName, extractDbSchemaColumns, buildAutomationBundle } from './codegen.js';
import { assertReadOnlySelect } from './dbRunner.js';
import { resolveComposeLanes } from '../rag/resolveComposeLanes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BE = path.resolve(__dirname, '../../../../capbo-backend/src/Features');

function readEntity(...parts) {
  return fs.readFileSync(path.join(BE, ...parts), 'utf8');
}

const traitSrc = readEntity('Shared/Doctrine/BlameableTimestampableTrait.php');
const ecotaxSrc = readEntity('Ecotax/Entity/Ecotax.php');
const articleEcotaxSrc = readEntity('Ecotax/Entity/ArticleEcotax.php');
const ecotaxTranslationSrc = readEntity('Ecotax/Entity/EcotaxTranslation.php');
const articleSrc = readEntity('Article/Entity/Article.php');
const ecoContext = [traitSrc, ecotaxSrc, articleEcotaxSrc, ecotaxTranslationSrc].join('\n');
const articleContext = [traitSrc, articleSrc].join('\n');

assert.equal(resolveDbTableName('Ecotax', ecoContext), 'ecotax');
assert.equal(resolveDbTableName('Articles', articleContext), 'article');

const ecotaxCols = extractDbSchemaColumns('ecotax', ecoContext);
assert.ok(ecotaxCols.includes('code'), `ecotax columns: ${ecotaxCols.join(', ')}`);
assert.ok(ecotaxCols.includes('display_label'));

const articleEcotaxCols = extractDbSchemaColumns('article_ecotax', ecoContext);
assert.ok(articleEcotaxCols.includes('ecotax_code'), `article_ecotax columns: ${articleEcotaxCols.join(', ')}`);
assert.ok(!articleEcotaxCols.includes('display_label'), 'article_ecotax must not bleed ecotax columns');

const articleCols = extractDbSchemaColumns('article', articleContext);
assert.ok(articleCols.includes('short_designation'), `article columns: ${articleCols.join(', ')}`);
assert.ok(articleCols.includes('code'));

const eco = buildDbAutomation({
  cases: [],
  codeContext: ecoContext,
  matchedFeature: 'Ecotax',
  intent: { action: 'exercise', rawTitle: 'check eco tax schema' },
});
assert.equal(eco.kind, 'database');
assert.ok(eco.tables.includes('ecotax'));
assert.ok(eco.tables.includes('article_ecotax'));
assert.ok(eco.steps.some((s) => /Table exists — ecotax/.test(s.description)));
assert.ok(eco.steps.some((s) => s.id === 'db-columns-article_ecotax'));
assert.ok(eco.steps.every((s) => !/ECO-QA|WHERE code/i.test(s.sql || '')), 'no business-row SELECT');
assert.ok(eco.steps.every((s) => !/columns include .+,/i.test(s.description || '')), 'titles stay short');

assert.throws(() => assertReadOnlySelect('DELETE FROM ecotax'), /Only SELECT|not allowed/i);

const lanes = resolveComposeLanes({
  title: 'verify eco tax database schema and migrations',
});
assert.equal(lanes.database, true);
assert.equal(lanes.defaultRunAs, 'database');

const noDb = resolveComposeLanes({
  title: 'create eco tax ECO-QA-0167 and verify in the database',
});
assert.equal(noDb.database, false, 'data verify wording must not open Database lane');

const bundle = buildAutomationBundle({
  layers: ['database'],
  apiContext: ecoContext,
  matchedFeature: 'Ecotax',
  intent: { action: 'exercise' },
});
assert.ok(bundle.db?.steps?.length >= 2);

console.log('dbAutomation: all checks passed');
