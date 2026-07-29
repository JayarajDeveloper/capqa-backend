// Grounded by Nocta QA against capbo-frontend/src/app/pages/partners (live code, full files).
// Required fields from partner.component.ts fb.group:
//   code (2–50), name (min 2), partnerType, enterpriseIdentifierType, currency.
// The old generated spec targeted app-custom-dropdown[data-formcontrolname="enterpriseIdentifierType"] —
// an attribute Angular never renders — and timed out. The real hook is
// testId="partner-enterprise-identifier-type" (partner.component.html).
// Data dependency: at least one currency must exist for the currency dropdown.
// Run: cd nocta-backend && npx playwright test generated-e2e/partners-create.spec.ts --headed
import { test, expect } from '@playwright/test';
import { ensureCapboSession, fillAngularField, selectMatDropdown, searchList } from './helpers/capbo-ui';

test.describe('Partners', () => {
  test.setTimeout(120_000);

  test('Create a new partner with all required fields', async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const name = `e2e-partner-${suffix}`;

    await ensureCapboSession(page);

    // List page → Add (data-testid from partner-list.component.html)
    await page.goto('/partners', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('partner-create').click({ timeout: 15000 });

    // partners.code — input[data-testid="partner-code"], 2–50 chars
    await fillAngularField(page, page.getByTestId('partner-code'), `e2e-${suffix}`);

    // partners.partnerName — input[data-testid="partner-name"], min 2 chars
    await fillAngularField(page, page.getByTestId('partner-name'), name);

    // partners.partnerType — app-custom-dropdown testId="partner-type" (static list)
    await selectMatDropdown(page, page.getByTestId('partner-type'), 'first');

    // partners.enterpriseIdentifierType — app-custom-dropdown testId="partner-enterprise-identifier-type"
    await selectMatDropdown(page, page.getByTestId('partner-enterprise-identifier-type'), 'first');

    // partners.currency — app-custom-dropdown testId="partner-currency" (needs ≥1 currency)
    await selectMatDropdown(page, page.getByTestId('partner-currency'), 'first');

    // Save gate: all five required controls must be valid
    const save = page.getByTestId('partner-save');
    await expect(save, 'partner-save should enable once code/name/type/idType/currency are set').toBeEnabled({ timeout: 10000 });
    await save.click({ timeout: 15000 });

    // Verify the new partner appears in the list (shared list-filters-card search).
    await page.waitForURL((u) => !/\/details/i.test(String(u)), { timeout: 15000 }).catch(() => {});
    await searchList(page, name, { route: '/partners' });
    await expect(
      page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 20000 });
  });
});
