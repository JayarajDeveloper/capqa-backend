// Grounded by Nocta QA against capbo-frontend/src/app/pages/currencies (live code, full files).
// Required fields from currency.component.ts fb.group:
//   code [A-Z]{3}, numericCode [0-9]{3}, name, symbol, roundingIncrement (0.01–1 decimal).
// Business-rule data comes from valueFromPattern() — unique per run, no fixed EUR/978.
// Run: cd nocta-backend && npx playwright test generated-e2e/currency-create.spec.ts --headed
import { test, expect } from '@playwright/test';
import { ensureCapboSession, fillAngularField, searchList, valueFromPattern } from './helpers/capbo-ui';

test.describe('Currencies', () => {
  test.setTimeout(120_000);

  test('Create a new currency with all required fields', async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const name = `e2e-currency-${suffix}`;
    const code = valueFromPattern('[A-Z]{3}');     // exactly 3 uppercase letters
    const numericCode = valueFromPattern('[0-9]{3}'); // exactly 3 digits

    await ensureCapboSession(page);

    // List page → Add (data-testid from currency-list.component.html)
    await page.goto('/currency', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('currency-create').click({ timeout: 15000 });

    // currency.code — Validators.pattern('[A-Z]{3}'), maxlength 3
    await fillAngularField(page, page.getByTestId('currency-code'), code);

    // currency.numericCode — Validators.pattern('[0-9]{3}'), maxlength 3
    await fillAngularField(page, page.getByTestId('currency-numeric-code'), numericCode);

    // currency.name
    await fillAngularField(page, page.getByTestId('currency-name'), name);

    // currency.symbol
    await fillAngularField(page, page.getByTestId('currency-symbol'), `¤${suffix.slice(-2)}`);

    // currency.roundingIncrement — appLocalizedDecimalInput (0.01–1) → typed per-key
    await fillAngularField(page, page.getByTestId('currency-rounding-increment'), '0.01');

    const save = page.getByTestId('currency-save');
    await expect(save, 'currency-save should enable once all five required fields are set').toBeEnabled({ timeout: 10000 });
    await save.click({ timeout: 15000 });

    // Verify in list — currency-list passes searchTestId="currency-search".
    await page.waitForURL((u) => !/\/details/i.test(String(u)), { timeout: 15000 }).catch(() => {});
    await searchList(page, name, { testId: 'currency-search', route: '/currency' });
    await expect(
      page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 20000 });
  });
});
