import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stalledAttempt } from '../bench/eval-suite/scorecard.mjs';

test('scorecard: a not-produced "no file changed" attempt is not a stall', () => {
  assert.equal(stalledAttempt({ failureKind: 'not-produced', why: 'no file changed' }), false);
  assert.equal(stalledAttempt({ failureKind: 'not-produced', why: 'no file changed · retry skipped: the worker reported a blocker outside this step' }), false);
});

test('scorecard: real stalls still count', () => {
  assert.equal(stalledAttempt({ failureKind: 'stalled', why: 'stalled' }), true);
  assert.equal(stalledAttempt({ why: 'fallback from grok after no file change for 900s' }), true);
  assert.equal(stalledAttempt({ why: 'fallback from grok after stall 600s' }), true);
});
