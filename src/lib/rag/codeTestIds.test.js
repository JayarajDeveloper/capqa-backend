/**
 * Strict code-testId audit.
 * Run: node --test src/lib/rag/codeTestIds.test.js
 */
import assert from 'node:assert/strict';
import { auditCodeTestIds, auditAutomationTestIds } from './codeTestIds.js';

const ok = auditCodeTestIds({
  action: 'create',
  vocab: { testIds: ['partner-create', 'partner-save', 'partner-code', 'partner-name'] },
  schema: {
    fields: [
      { key: 'code', required: true, testId: 'partner-code', type: 'text' },
      { key: 'name', required: true, testId: 'partner-name', type: 'text' },
    ],
  },
});
assert.equal(ok.ok, true);
assert.equal(ok.createTestId, 'partner-create');
assert.equal(ok.saveTestId, 'partner-save');

const missingField = auditCodeTestIds({
  action: 'create',
  vocab: { testIds: ['vat-create', 'vat-save'] },
  schema: {
    fields: [
      { key: 'name', required: true, testId: null, type: 'text' },
      { key: 'rate', required: true, testId: 'vat-rate', type: 'decimal' },
    ],
  },
});
assert.equal(missingField.ok, false);
assert.ok(missingField.missing.some((m) => m.key === 'name'));

const noInvent = auditAutomationTestIds({
  action: 'create',
  steps: [
    { action: 'fill', formControl: 'code', testId: null },
  ],
});
assert.equal(noInvent.ok, false);

console.log('codeTestIds: all checks passed');
