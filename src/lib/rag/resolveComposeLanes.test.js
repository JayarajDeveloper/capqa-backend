/**
 * Tests for AI lane adoption (UI / API / Database schema).
 */
import assert from 'node:assert/strict';
import { resolveComposeLanes } from '../rag/resolveComposeLanes.js';

const create = resolveComposeLanes({
  title: 'create an eco tax',
  description: 'code ECO-QA-0167',
  intent: { action: 'create' },
});
assert.deepEqual(create.layers.sort(), ['backend', 'ui'].sort());
assert.equal(create.database, false);

const schema = resolveComposeLanes({
  title: 'check eco tax schema and migrations',
});
assert.ok(schema.database);
assert.equal(schema.defaultRunAs, 'database');

const dataVerify = resolveComposeLanes({
  title: 'verify eco tax ECO-QA-0167 in database',
});
assert.equal(dataVerify.database, false, 'row verify is not a Database lane');

const apiOnly = resolveComposeLanes({
  title: 'create currency via API only',
});
assert.equal(apiOnly.ui, false);
assert.equal(apiOnly.api, true);

console.log('resolveComposeLanes: all checks passed');
