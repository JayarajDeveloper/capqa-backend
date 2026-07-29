/**
 * Live UI readiness gate.
 * Run: node --test src/lib/rag/live.test.js
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { liveUiSourcesReady } from './live.js';
import { resolvedFeatureFolder, filterChunksToFeatureFolder } from './codeSignals.js';

function chunk(path, content, method = 'live-gitlab') {
  return { path, content, method, layer: 'ui' };
}

describe('liveUiSourcesReady', () => {
  it('fails when list+TS exist but form HTML is missing', () => {
    const live = [
      chunk('src/app/pages/eco-tax/eco-tax-list/eco-tax-list.component.html', `
        <button data-testid="eco-tax-create"></button>
        <button data-testid="eco-tax-edit"></button>
        <tr data-testid="eco-tax-row"></tr>
      `),
      chunk('src/app/pages/eco-tax/eco-tax-details/eco-tax-details.component.ts', `
        ecoTaxForm = this.fb.group({ name: ['', Validators.required] });
      `),
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.ok, false);
    assert.equal(ready.hasTestId, true);
    assert.equal(ready.hasRules, true);
    assert.equal(ready.hasListHtml, true);
    assert.equal(ready.hasCreateTid, true);
    assert.equal(ready.hasFormHtml, false);
  });

  it('fails when only form HTML (no list create testId)', () => {
    const live = [
      chunk('src/app/pages/articles/article-detail/article-detail.component.html', `
        <button data-testid="article-save"></button>
        <input formControlName="name" data-testid="article-name" />
      `),
      chunk('src/app/pages/articles/article-detail/article-detail.component.ts', `
        form = this.fb.group({ name: ['', Validators.required] });
      `),
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.ok, false);
    assert.equal(ready.hasCreateTid, false);
    assert.equal(ready.hasListHtml, false);
    assert.equal(ready.hasFormHtml, true);
  });

  it('passes when list create + form HTML are both present', () => {
    const live = [
      chunk('src/app/pages/articles/article-list/article-list.component.html', `
        <button data-testid="article-create"></button>
      `),
      chunk('src/app/pages/articles/article-detail/article-detail.component.html', `
        <button data-testid="article-save"></button>
      `),
      chunk('src/app/pages/articles/article-detail/article-detail-general-tab/article-detail-general-tab.component.html', `
        <form data-testid="article-form">
          <input formControlName="shortDesignation" data-testid="article-short-designation" />
          <input formControlName="price" data-testid="article-price" />
        </form>
      `),
      chunk('src/app/pages/articles/article-detail/article-detail.component.ts', `
        form = this.fb.group({ shortDesignation: ['', Validators.required] });
      `),
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.ok, true);
    assert.equal(ready.hasFormHtml, true);
    assert.equal(ready.hasFormFields, true);
    assert.equal(ready.hasCreateTid, true);
    assert.equal(ready.hasSaveTid, true);
  });

  it('fails when form shell has no field testIds', () => {
    const live = [
      chunk('src/app/pages/articles/article-list/article-list.component.html', `
        <button data-testid="article-create"></button>
      `),
      chunk('src/app/pages/articles/article-detail/article-detail.component.html', `
        <button data-testid="article-save"></button>
        <button data-testid="article-cancel"></button>
      `),
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.ok, false);
    assert.equal(ready.hasFormFields, false);
  });

  it('fails when only backend live chunks (no UI HTML)', () => {
    const live = [
      { path: 'src/Controller/EcoTaxController.php', content: 'class EcoTax {}', method: 'live-gitlab', layer: 'backend' },
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.ok, false);
    assert.equal(ready.hasTestId, false);
    assert.equal(ready.htmlCount, 0);
  });

  it('accepts testId= attribute on custom dropdowns when list create exists', () => {
    const live = [
      chunk('src/app/pages/eco-tax/eco-tax-list/eco-tax-list.component.html', `
        <button data-testid="eco-tax-create"></button>
      `),
      chunk('src/app/pages/eco-tax/eco-tax-details/eco-tax-details.component.html', `
        <app-custom-dropdown testId="eco-tax-category"></app-custom-dropdown>
        <button data-testid="eco-tax-save"></button>
        <input formControlName="name" data-testid="eco-tax-name" />
        <input formControlName="code" data-testid="eco-tax-code" />
      `),
      chunk('src/app/pages/eco-tax/eco-tax-details/eco-tax-details.component.ts', `
        formControlName="name"
      `),
    ];
    const ready = liveUiSourcesReady(live);
    assert.equal(ready.hasTestId, true);
    assert.equal(ready.ok, true);
  });
});

describe('resolvedFeatureFolder', () => {
  it('keeps eco-tax when live chunks wrongly include credit-reference-date', () => {
    const seeds = [
      'src/app/pages/eco-tax/eco-tax-list/eco-tax-list.component.html',
    ];
    const wrongLive = [
      'src/app/pages/credit-reference-date/credit-ref-date-list/credit-ref-date-list.component.html',
    ];
    assert.equal(resolvedFeatureFolder('Eco Tax', seeds), 'eco-tax');
    const filtered = filterChunksToFeatureFolder(
      wrongLive.map((path) => ({ path, method: 'live-gitlab', content: '' })),
      'Eco Tax',
      seeds,
    );
    assert.equal(filtered.length, 0);
  });

  it('resolves vat-service-spec from catalog seed paths', () => {
    const seeds = ['src/app/pages/vat-service-spec/vat-list/vat-list.component.html'];
    assert.equal(resolvedFeatureFolder('VAT', seeds), 'vat-service-spec');
  });
});
