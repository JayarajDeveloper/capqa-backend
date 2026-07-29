// Grounded by Nocta QA against capbo-frontend/src/app/pages/vat (live code, full files).
// Required fields from vat.component.ts fb.group: name (min 2), rate (0–100), country.
// Run: cd nocta-backend && npx playwright test generated-e2e/vat-create.spec.ts --headed
// Requires TARGET_APP_URL, APP_TEST_USERNAME, APP_TEST_PASSWORD (auth.setup fast path supported).
import { test, expect } from '@playwright/test';
import { ensureCapboSession, fillAngularField, selectMatDropdown, searchList } from './helpers/capbo-ui';

test.describe('Vat', () => {
  test.setTimeout(120_000);

  test('Create a new VAT with all required fields', async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const name = `e2e-vat-${suffix}`;

    await ensureCapboSession(page);

    // List page → Add (data-testid from vat-list.component.html)
    await page.goto('/vat', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('vat-create').click({ timeout: 15000 });

    // vat.vatName — input[data-testid="vat-name"]
    await fillAngularField(page, page.getByTestId('vat-name'), name);

    // vat.rate — appLocalizedDecimalInput, Validators.min(0)/max(100) → typed per-key
    await fillAngularField(page, page.getByTestId('vat-rate'), '5');

    // vat.country — app-countries-dropdown → testId lands on the inner mat-form-field
    await selectMatDropdown(page, page.getByTestId('vat-country'), 'first');

    // Save only enables when the form is valid — assert it so a missed required
    // field fails HERE with a clear message instead of a silent click timeout.
    const save = page.getByTestId('vat-save');
    await expect(save, 'vat-save should enable once name/rate/country are set').toBeEnabled({ timeout: 10000 });
    await save.click({ timeout: 15000 });

    // Verify the new VAT appears in the list (search box has no testid on this
    // page — searchList falls back to the shared list-filters-card input).
    await page.waitForURL((u) => !/\/details/i.test(String(u)), { timeout: 15000 }).catch(() => {});
    await searchList(page, name, { route: '/vat' });
    await expect(
      page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 20000 });
  });
});
