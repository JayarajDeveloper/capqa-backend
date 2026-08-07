/**
 * Spec UI helpers — re-exports the active target adapter pack.
 * Generated specs import from here so the engine stays target-agnostic.
 */
export {
  ensureTargetSession,
  waitForAppShell,
  spaNavigate,
  listPathFromRoute,
  verifyInList,
  assertAbsentInList,
  waitForViewFormReady,
  waitForEditFormReady,
  waitForFormSave,
  fillAngularField,
  fillMatAutocomplete,
  selectMatDropdown,
  valueFromPattern,
  hasSavedAuth,
  AUTH_STATE_PATH,
  // Compat for older generated specs
  ensureCapboSession,
  waitForCapboShell,
} from '../adapters/capbo/ui';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Click list Add/Create using a code testId, with i18n role fallback. */
export async function clickListCreate(page: Page, testId?: string | null, nameRe = /^(add|create|new|ajouter|créer)$/i): Promise<void> {
  if (testId) {
    const byTid = page.getByTestId(testId);
    if (await byTid.count()) {
      await byTid.first().click();
      return;
    }
  }
  const byRole = page.getByRole('button', { name: nameRe });
  await expect(byRole.first()).toBeVisible({ timeout: 20000 });
  await byRole.first().click();
}

/** Click form Save/Submit using a code testId, with role fallback. */
export async function clickFormSave(page: Page, testId?: string | null): Promise<void> {
  if (testId) {
    const byTid = page.getByTestId(testId);
    if (await byTid.count()) {
      await byTid.first().click();
      return;
    }
  }
  const byRole = page.getByRole('button', { name: /^(save|submit|enregistrer|valider)$/i });
  await expect(byRole.first()).toBeVisible({ timeout: 20000 });
  await byRole.first().click();
}
