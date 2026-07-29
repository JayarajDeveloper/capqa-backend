import assert from 'node:assert/strict';
import {
  parseNoctaStepMarkers,
  parseSpecCommentSteps,
  buildProfessionalRunLog,
} from './runLogFormatter.js';

const stdout = [
  'NOCTA_STEP_BEGIN|Establish session',
  'NOCTA_STEP_END|Establish session|pass|1200|',
  'NOCTA_STEP_BEGIN|Fill Code',
  'NOCTA_STEP_END|Fill Code|fail|8000|TimeoutError: locator timeout',
  'NOCTA_TEST_END|UI test|failed|9200',
].join('\n');

const steps = parseNoctaStepMarkers(stdout);
assert.equal(steps.length, 2);
assert.equal(steps[0].status, 'pass');
assert.equal(steps[1].status, 'fail');
assert.match(steps[1].error, /TimeoutError/);

const spec = `
test('x', async () => {
  // Navigate to list
  await spaNavigate(page, '/partners');
  // Fill code
  await fillAngularField(page, loc, 'X');
});
`;
const specSteps = parseSpecCommentSteps(spec);
assert.equal(specSteps.length, 2);

const log = buildProfessionalRunLog({
  specPath: 'generated-e2e/partners-create.spec.ts',
  baseUrl: 'http://localhost:4200',
  passed: true,
  durationMs: 17300,
  stdout,
  specSource: spec,
});
assert.match(log.log, /PASSED/);
assert.equal(log.runSteps.length, 2);

console.log('runLogFormatter.test.js OK');
