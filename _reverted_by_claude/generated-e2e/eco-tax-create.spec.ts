// Grounded by Nocta QA against capbo-frontend/src/app/pages/eco-tax (live code, full files).
// Required fields from eco-tax-details.component.ts initForm():
//   code, name, display_label, valued (decimal), vat_id — ALL Validators.required.
//   category ('RCP') and calculation_mode ('FIXED_AMOUNT') have valid defaults → not touched.
// The old generated spec failed twice here: it tried to fill() the category
// custom-dropdown (mat-select can't be filled) and never selected a VAT, so the
// form stayed invalid and Save stayed disabled.
// Data dependency: at least one VAT record must exist (the eco-tax-vat dropdown).
// Run: cd nocta-backend && npx playwright test generated-e2e/eco-tax-create.spec.ts --headed
import { test, expect } from '@playwright/test';
import { ensureCapboSession, fillAngularField, selectMatDropdown, searchList } from './helpers/capbo-ui';

test.describe('Eco Tax', () => {
  test.setTimeout(120_000);

  test('Create a new Eco Tax with all required fields', async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const name = `e2e-ecotax-${suffix}`;

    await ensureCapboSession(page);

    // List page → Add (data-testid from eco-tax-list.component.html)
    await page.goto('/eco-tax', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('eco-tax-create').click({ timeout: 15000 });

    // ecoTax.code — input[data-testid="eco-tax-code"] (writable in create mode)
    await fillAngularField(page, page.getByTestId('eco-tax-code'), `e2e-${suffix}`);

    // ecoTax.name — input[data-testid="eco-tax-name"]
    await fillAngularField(page, page.getByTestId('eco-tax-name'), name);

    // ecoTax.displayLabel — input[data-testid="eco-tax-display-label"]
    await fillAngularField(page, page.getByTestId('eco-tax-display-label'), `${name}-label`);

    // ecoTax.value — formControlName="valued", appLocalizedDecimalInput → typed per-key
    await fillAngularField(page, page.getByTestId('eco-tax-value'), '0.01');

    // ecoTax.vat — app-custom-dropdown testId="eco-tax-vat", async options (fetchVatsStatic)
    await selectMatDropdown(page, page.getByTestId('eco-tax-vat'), 'first');

    // Save is [disabled]="ecoTaxForm.invalid || isLoading" — assert enabled first
    const save = page.getByTestId('eco-tax-save');
    await expect(save, 'eco-tax-save should enable once code/name/label/value/vat are set').toBeEnabled({ timeout: 10000 });
    await save.click({ timeout: 15000 });

    // Verify the new Eco Tax appears in the list (shared list-filters-card search).
    await page.waitForURL((u) => !/\/details/i.test(String(u)), { timeout: 15000 }).catch(() => {});
    await searchList(page, name, { route: '/eco-tax' });
    await expect(
      page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 20000 });
  });
});
