/**
 * Strict rule: Playwright specs use only data-testid / testId parsed from target code.
 * No invented stems like `${module}-create` for fields.
 */

import { isAutomatableField } from './componentRegistry.js';
import { isFilterFieldKey } from './formSchema.js';

function pickCreateTestId(testIds = []) {
  return testIds.find((id) => /-(create|add|new)$/i.test(id) && !/filter|search|modal|form$/i.test(id))
    || testIds.find((id) => /create|add|new/i.test(id) && !/filter|search|form|cancel|delete/i.test(id))
    || null;
}

function pickSaveTestId(testIds = []) {
  return testIds.find((id) => /-(save|submit)$/i.test(id))
    || testIds.find((id) => /save|submit/i.test(id) && !/form|cancel|delete/i.test(id))
    || null;
}

function pickDeleteTestId(testIds = []) {
  return testIds.find((id) => /-delete$/i.test(id) && !/-delete-(confirm|cancel|dialog)/i.test(id))
    || null;
}

/**
 * @returns {{ ok: boolean, missing: Array<{kind:string,key?:string,message:string}>, createTestId: string|null, saveTestId: string|null }}
 */
export function auditCodeTestIds({
  schema = null,
  vocab = null,
  action = 'create',
} = {}) {
  const missing = [];
  const testIds = vocab?.testIds || [];
  const createTestId = pickCreateTestId(testIds);
  const saveTestId = pickSaveTestId(testIds);
  const filterKeys = schema?.filterKeys || [];

  if (/^(create|exercise)$/i.test(action)) {
    if (!createTestId) {
      missing.push({
        kind: 'create',
        message: 'No list Add/Create data-testid/testId found in the target UI source',
      });
    }
    if (!saveTestId) {
      missing.push({
        kind: 'save',
        message: 'No form Save/Submit data-testid/testId found in the target UI source',
      });
    }
  }

  if (/^delete$/i.test(action)) {
    const deleteTestId = pickDeleteTestId(testIds);
    if (!deleteTestId) {
      missing.push({
        kind: 'delete',
        message: 'No delete data-testid/testId found in the target UI source',
      });
    }
  }

  for (const field of schema?.fields || []) {
    if (!field?.key) continue;
    if (isFilterFieldKey(field.key, filterKeys)) continue;
    if (!field.required) continue;
    if (!isAutomatableField(field)) continue;
    if (field.automate === false) continue;
    if (!field.testId) {
      missing.push({
        kind: 'field',
        key: field.key,
        message: `Required field "${field.key}" has no data-testid/testId in the target source`,
      });
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    createTestId,
    saveTestId,
  };
}

/**
 * Every fill/select/click-create/click-save step must carry a code testId (no invented stems).
 */
export function auditAutomationTestIds(automation = {}) {
  const missing = [];
  const action = automation.action || 'create';
  for (const s of automation.steps || []) {
    if (!s) continue;
    if (s.action === 'fill' || s.action === 'select') {
      const tid = s.testId
        || (s.strategies || []).find((x) => x.type === 'testid')?.value
        || null;
      if (!tid) {
        missing.push({
          kind: 'step',
          key: s.formControl || s.id,
          message: `${s.action} step "${s.formControl || s.id}" has no code testId`,
        });
      }
      continue;
    }
    if (s.action !== 'click') continue;
    const tid = s.testId
      || (s.strategies || []).find((x) => x.type === 'testid')?.value
      || null;
    if (s.id === 'click-create' || /-(create|add|new)$/i.test(String(s.testId || ''))) {
      if (!tid && /^(create|exercise)$/i.test(action)) {
        missing.push({ kind: 'create', message: 'Add/Create click has no code testId' });
      }
    }
    if (s.id === 'click-save' || /-(save|submit)$/i.test(String(s.testId || ''))) {
      if (!tid) {
        missing.push({ kind: 'save', message: 'Save click has no code testId' });
      }
    }
    if ((s.id === 'click-delete' || s.id === 'click-delete-row') && /^delete$/i.test(action)) {
      if (!tid) {
        missing.push({ kind: 'delete', message: 'Delete click has no code testId in automation steps' });
      }
    }
  }
  if (/^delete$/i.test(action)) {
    const hasDeleteClick = (automation.steps || []).some(
      (s) => s.id === 'click-delete' || s.id === 'click-delete-row',
    );
    if (!hasDeleteClick) {
      missing.push({ kind: 'delete', message: 'Delete flow missing click-delete step (compose merge dropped it)' });
    }
    const hasConfirm = (automation.steps || []).some((s) => s.id === 'click-confirm');
    if (!hasConfirm) {
      missing.push({ kind: 'confirm', message: 'Delete flow missing confirm dialog click step' });
    }
  }
  return { ok: missing.length === 0, missing };
}

export function formatTestIdAuditError(audit) {
  const lines = (audit?.missing || []).map((m) => m.message);
  return lines.length
    ? `Code testIds required — missing:\n- ${lines.join('\n- ')}`
    : 'Code testIds required';
}
