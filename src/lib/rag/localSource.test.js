/**
 * Local CapBO source smoke.
 * Run: node --test src/lib/rag/localSource.test.js
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hydrateChunksFromLocal,
  resolveLocalPagesFolder,
  listLocalPageFolders,
  isLocalSourceConfigured,
} from './localSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../../');
const uiRoot = path.join(workspace, 'capbo-frontend');
const apiRoot = path.join(workspace, 'capbo-backend');

describe('localSource', () => {
  it('lists CapBO page folders when UI root is set', async () => {
    process.env.CAPQA_LOCAL_UI_ROOT = uiRoot;
    process.env.CAPQA_LOCAL_API_ROOT = apiRoot;
    assert.equal(isLocalSourceConfigured(), true);
    const folders = await listLocalPageFolders();
    assert.ok(folders.includes('eco-tax') || folders.includes('partners') || folders.includes('vat'));
  });

  it('resolves eco-tax folder', async () => {
    process.env.CAPQA_LOCAL_UI_ROOT = uiRoot;
    const folder = await resolveLocalPagesFolder('Eco Tax');
    assert.equal(folder, 'eco-tax');
  });

  it('hydrates UI component files for eco-tax', async () => {
    process.env.CAPQA_LOCAL_UI_ROOT = uiRoot;
    process.env.CAPQA_LOCAL_API_ROOT = apiRoot;
    const result = await hydrateChunksFromLocal({
      featureName: 'Eco Tax',
      query: 'create eco tax',
      layers: ['ui', 'backend'],
      chunks: [],
    });
    assert.equal(result.live.ok, true);
    assert.ok(result.liveChunks.length >= 2, `expected live chunks, got ${result.liveChunks.length}`);
    assert.ok(result.liveChunks.every((c) => c.method === 'live-local'));
    assert.ok(result.liveChunks.some((c) => /\.component\.html$/i.test(c.path)));
    assert.ok(result.liveChunks.some((c) => /eco-tax/i.test(c.path)));
  });
});
