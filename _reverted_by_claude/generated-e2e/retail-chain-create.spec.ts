// Grounded by Nocta QA against capbo-frontend/src/app/pages/retail_chain (live code, full files).
// Required fields from retail-chain.component.ts fb.group: name (min 2). Site is optional.
// Run: cd nocta-backend && npx playwright test generated-e2e/retail-chain-create.spec.ts --headed
import { test, expect } from '@playwright/test';
import { ensureCapboSession, fillAngularField, searchList } from './helpers/capbo-ui';

test.describe('Retail Chain', () => {
  test.setTimeout(120_000);

  test('Create a new retail chain with required name field', async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-5);
    const name = `e2e-chain-${suffix}`;

    await ensureCapboSession(page);

    // List page → Add (data-testid from retail-chain-list.component.html)
    await page.goto('/retail-chains', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('retail-chain-create').click({ timeout: 15000 });

    // retailChains.name — input[data-testid="retail-chain-name"], min 2 chars
    await fillAngularField(page, page.getByTestId('retail-chain-name'), name);

    const save = page.getByTestId('retail-chain-save');
    await expect(save, 'retail-chain-save should enable once name is set').toBeEnabled({ timeout: 10000 });
    await save.click({ timeout: 15000 });

    // Verify in list — this page has its own search input with a testid.
    await page.waitForURL((u) => !/\/details/i.test(String(u)), { timeout: 15000 }).catch(() => {});
    await searchList(page, name, { testId: 'retail-chain-search', route: '/retail-chains' });
    await expect(
      page.locator('table tbody tr, [data-testid$="-row"], .mat-mdc-row, .mat-row').filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 20000 });
  });
});
