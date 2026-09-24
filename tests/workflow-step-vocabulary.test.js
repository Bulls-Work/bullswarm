import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_KINDS, KIND_DEFAULTS } from '../src/workflow/action-validator.js';
import { STEP_EVIDENCE_TYPES as VALIDATOR_STEP_EVIDENCE_TYPES } from '../src/workflow/action-validator.js';
import {
  DELIVERABLE_TYPES, EVIDENCE_ITEM_STATUSES, EVIDENCE_RESULT_FIELDS, EVIDENCE_TYPES, KIND_ROLES, ROLES,
  ROLE_DEFAULT_DELIVERABLE, ROLE_ROUTING, STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES,
  declaredDeliverable, declaredEvidence, deliverableTypeOf, evidenceResultsIssues, laneFitsDeliverable, roleOf, roleRouting,
} from '../src/workflow/step-vocabulary.js';

test('ROLES, DELIVERABLE_TYPES and EVIDENCE_TYPES are the exact lists', () => {
  assert.deepEqual([...ROLES], ['investigate', 'produce', 'transform', 'combine', 'check', 'act']);
  assert.deepEqual([...DELIVERABLE_TYPES], ['files', 'report', 'data', 'media', 'outward']);
  assert.deepEqual([...EVIDENCE_TYPES], ['command', 'schema', 'review', 'choice']);
});

test('KIND_ROLES keys match ACTION_KINDS and values are the D8 roles', () => {
  assert.deepEqual(Object.keys(KIND_ROLES), [...ACTION_KINDS]);
  assert.deepEqual(KIND_ROLES, {
    mechanical: 'transform',
    'io-read': 'investigate',
    digest: 'combine',
    check: 'check',
    implement: 'produce',
    integration: 'combine',
    architecture: 'investigate',
    'adversarial-acceptance': 'check',
  });
  for (const role of Object.values(KIND_ROLES)) assert.ok(ROLES.includes(role), role);
});

test('ROLE_ROUTING matches the role table, including combine + data', () => {
  const cell = (lane, effort) => ({ lane, effort });
  const writer = {
    files: cell('build', 'medium'),
    data: cell('build', 'medium'),
    media: cell('build', 'medium'),
    report: cell('analyze', 'medium'),
  };
  assert.deepEqual(ROLE_ROUTING, {
    investigate: writer,
    produce: writer,
    transform: {
      files: cell('chore', 'low'),
      data: cell('chore', 'low'),
      media: cell('chore', 'low'),
      report: cell('analyze', 'low'),
    },
    combine: {
      files: cell('build', 'high'),
      data: cell('build', 'medium'),
      media: cell('build', 'medium'),
      report: cell('analyze', 'medium'),
    },
    check: { report: cell('analyze', 'medium') },
    act: { outward: cell('analyze', 'medium') },
  });
  assert.deepEqual(roleRouting('combine', 'data'), { lane: 'build', effort: 'medium' });
  assert.equal(roleRouting('investigate', 'outward'), null);
  assert.equal(roleRouting('check', 'files'), null);
  assert.equal(roleRouting('act', 'report'), null);
  assert.equal(Object.hasOwn(ROLE_DEFAULT_DELIVERABLE, 'combine'), false);
});

test('only kind check and role check route identically; other rows match the difference table', () => {
  const difference = {
    mechanical: { role: 'transform', kind: { lane: 'chore', effort: 'low' }, roleAlone: { lane: 'chore', effort: 'low' } },
    'io-read': { role: 'investigate', kind: { lane: 'analyze', effort: 'low' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    architecture: { role: 'investigate', kind: { lane: 'analyze', effort: 'high' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    implement: { role: 'produce', kind: { lane: 'build', effort: 'medium' }, roleAlone: { lane: 'build', effort: 'medium' } },
    integration: { role: 'combine', kind: { lane: 'build', effort: 'high' }, roleAlone: null },
    digest: { role: 'combine', kind: { lane: 'analyze', effort: 'low' }, roleAlone: null },
    check: { role: 'check', kind: { lane: 'analyze', effort: 'medium' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    'adversarial-acceptance': { role: 'check', kind: { lane: 'analyze', effort: 'high' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
  };
  const identical = [];
  for (const kind of ACTION_KINDS) {
    const row = difference[kind];
    const role = KIND_ROLES[kind];
    const kindRoute = { lane: KIND_DEFAULTS[kind].lane, effort: KIND_DEFAULTS[kind].effort };
    const defaultType = ROLE_DEFAULT_DELIVERABLE[role];
    const roleRoute = defaultType ? roleRouting(role, defaultType) : null;
    assert.equal(role, row.role, kind);
    assert.deepEqual(kindRoute, row.kind, kind);
    if (row.roleAlone) assert.deepEqual(roleRoute, row.roleAlone, kind);
    else assert.equal(roleRoute, null, kind);
    if (kind === role && roleRoute && roleRoute.lane === kindRoute.lane && roleRoute.effort === kindRoute.effort) identical.push(kind);
  }
  assert.deepEqual(identical, ['check']);
});

test('roleOf, deliverableTypeOf, declaredDeliverable and laneFitsDeliverable', () => {
  assert.equal(roleOf({ role: 'act' }), 'act');
  assert.equal(roleOf({ kind: 'implement' }), 'produce');
  assert.equal(roleOf({ lane: 'build' }), null);
  assert.equal(roleOf({ role: 'check', kind: 'implement' }), 'check');
  for (const kind of ['constructor', 'toString', '__proto__', 'bogus']) assert.equal(roleOf({ kind }), null, kind);
  assert.equal(deliverableTypeOf('report'), 'report');
  assert.equal(deliverableTypeOf({ type: 'data', paths: ['out/a.json'] }), 'data');
  assert.equal(deliverableTypeOf('actions'), null);
  assert.equal(deliverableTypeOf(undefined), null);
  assert.deepEqual(declaredDeliverable({ deliverable: 'files' }), { type: 'files' });
  assert.deepEqual(declaredDeliverable({ deliverable: { type: 'files', paths: [] } }), { type: 'files' });
  assert.deepEqual(declaredDeliverable({ deliverable: { type: 'data', paths: ['out/a.json'], note: 1 } }), { type: 'data', paths: ['out/a.json'] });
  assert.equal(declaredDeliverable({}), null);
  assert.equal(laneFitsDeliverable('build', 'files'), true);
  assert.equal(laneFitsDeliverable('chore', 'media'), true);
  assert.equal(laneFitsDeliverable('analyze', 'data'), false);
  assert.equal(laneFitsDeliverable('analyze', 'report'), true);
  assert.equal(laneFitsDeliverable('analyze', 'outward'), true);
  assert.equal(laneFitsDeliverable('build', 'report'), false);
  assert.equal(laneFitsDeliverable('chore', 'outward'), false);
});

test('evidence type lists, statuses and the result key set are the exact lists', () => {
  assert.deepEqual([...STEP_EVIDENCE_TYPES], ['command', 'schema']);
  assert.deepEqual([...USABLE_EVIDENCE_TYPES], ['command', 'schema', 'review']);
  assert.deepEqual([...EVIDENCE_TYPES], ['command', 'schema', 'review', 'choice']);
  assert.deepEqual([...EVIDENCE_ITEM_STATUSES], ['passed', 'failed', 'not-run']);
  assert.equal(VALIDATOR_STEP_EVIDENCE_TYPES, STEP_EVIDENCE_TYPES);
  assert.deepEqual([...EVIDENCE_RESULT_FIELDS].sort(), [
    'changed', 'cmd', 'durationMs', 'errorCount', 'errors', 'exit', 'fault', 'file', 'format', 'headMoved',
    'log', 'notes', 'schema', 'schemaChanged', 'signal', 'status', 'tail', 'timedOut', 'timeoutSec', 'touched', 'type', 'why',
  ]);
  for (const list of [STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES, EVIDENCE_ITEM_STATUSES, EVIDENCE_RESULT_FIELDS]) assert.ok(Object.isFrozen(list));
  // No legacy name the state validator rejects anywhere.
  for (const legacy of ['result', 'verify', 'decision', 'completion', 'reviewer']) assert.equal(EVIDENCE_RESULT_FIELDS.includes(legacy), false, legacy);
});

test('declaredEvidence returns the item array or []', () => {
  const items = [{ type: 'command', cmd: 'npm test' }];
  assert.equal(declaredEvidence({ evidence: items }), items);
  assert.deepEqual(declaredEvidence({}), []);
  assert.deepEqual(declaredEvidence({ evidence: [] }), []);
  assert.deepEqual(declaredEvidence(null), []);
  assert.deepEqual(declaredEvidence(undefined), []);
  assert.deepEqual(declaredEvidence({ evidence: { type: 'command' } }), []);
});

const commandResult = (over = {}) => ({
  type: 'command', cmd: 'node --test tests/slug.test.js', timeoutSec: 120,
  status: 'failed', exit: 1, durationMs: 1830,
  tail: 'x joins words with one hyphen (1.2ms)', log: '/tmp/acme/evidence-slug-attempt-1-1.log', why: 'exit 1', ...over,
});
const schemaResult = (over = {}) => ({
  type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', timeoutSec: 120,
  status: 'failed', exit: 1, durationMs: 140, errorCount: 2,
  errors: ['$.events[1].date must match pattern ^\\d{4}-\\d{2}-\\d{2}$'], notes: ['format is not checked (1 place)'],
  schemaChanged: true, tail: 'x', log: '/tmp/acme/evidence-slug-attempt-1-2.log', why: 'not valid: 2 errors', ...over,
});

test('evidenceResultsIssues accepts the documented shapes', () => {
  assert.deepEqual(evidenceResultsIssues([commandResult(), schemaResult()], 'attempt.evidenceResults'), []);
  assert.deepEqual(evidenceResultsIssues([], 'r'), []);
  assert.deepEqual(evidenceResultsIssues([
    commandResult({ status: 'passed', exit: 0, why: null }),
    commandResult({ exit: null, timedOut: true, why: 'timed out after 120s' }),
    commandResult({ exit: null, signal: 'SIGABRT', why: 'killed by SIGABRT' }),
    commandResult({ changed: ['log.md', 'HEAD'], touched: ['junit.xml'], headMoved: true, why: 'changed the deliverable: log.md, HEAD' }),
    { type: 'command', cmd: 'npm test', status: 'not-run', exit: null, why: 'stopped' },
  ], 'r'), []);
  assert.deepEqual(evidenceResultsIssues([
    schemaResult({ file: '$output', format: 'json', exit: 2, fault: 'check', why: 'schema missing: s.json', errorCount: 0, errors: [], notes: [] }),
  ], 'r'), []);
});

test('evidenceResultsIssues reports every shape problem without throwing', () => {
  const has = (value, message) => {
    const issues = evidenceResultsIssues(value, 'r');
    assert.ok(issues.includes(message), `${message}\n---\n${issues.join('\n')}`);
  };
  has(null, 'r must be an array');
  has({}, 'r must be an array');
  has(Array.from({ length: 6 }, () => commandResult()), 'r must have at most 5 items');
  has([null], 'r[0] must be an object');
  has([commandResult({ result: 'ok' })], 'r[0].result is not allowed');
  has([commandResult({ stopped: true })], 'r[0].stopped is not allowed');
  has([commandResult({ type: 'review' })], 'r[0].type must be command|schema');
  has([commandResult({ status: 'skipped' })], 'r[0].status must be passed|failed|not-run');
  has([commandResult({ cmd: undefined })], 'r[0].cmd must be a string of at most 8192 characters');
  has([commandResult({ file: 'a.json' })], 'r[0].file is only for schema items');
  has([commandResult({ errors: [] })], 'r[0].errors is only for schema items');
  has([commandResult({ fault: 'check' })], 'r[0].fault is only for schema items');
  has([schemaResult({ cmd: 'x' })], 'r[0].cmd is only for command items');
  has([schemaResult({ schema: 7 })], 'r[0].schema must be a string of at most 4096 characters');
  has([schemaResult({ format: 'yaml' })], 'r[0].format must be json|jsonl');
  has([schemaResult({ fault: 'data' })], 'r[0].fault must be check when present');
  has([schemaResult({ errorCount: -1 })], 'r[0].errorCount must be a non-negative integer');
  has([schemaResult({ errors: ['a', 'b', 'c', 'd', 'e', 'f'] })], 'r[0].errors must be an array of at most 5 strings of at most 200 characters');
  has([schemaResult({ errors: ['x'.repeat(201)] })], 'r[0].errors must be an array of at most 5 strings of at most 200 characters');
  has([schemaResult({ notes: ['a', 'b', 'c', 'd'] })], 'r[0].notes must be an array of at most 3 strings of at most 200 characters');
  has([commandResult({ timeoutSec: 601 })], 'r[0].timeoutSec must be an integer from 1 to 600');
  has([commandResult({ exit: '1' })], 'r[0].exit must be null or an integer');
  has([commandResult({ durationMs: -5 })], 'r[0].durationMs must be a non-negative number');
  has([commandResult({ tail: 'x'.repeat(4097) })], 'r[0].tail must be a string of at most 4096 characters');
  has([commandResult({ why: 3 })], 'r[0].why must be null or a string of at most 1000 characters');
  has([commandResult({ timedOut: false })], 'r[0].timedOut must be true when present');
  has([commandResult({ headMoved: 1 })], 'r[0].headMoved must be true when present');
  has([commandResult({ changed: Array.from({ length: 21 }, (_, i) => `f${i}`) })], 'r[0].changed must be an array of at most 20 strings');
  has([commandResult({ touched: [1] })], 'r[0].touched must be an array of at most 20 strings');
  // Prototype keys are ordinary unknown names.
  has([JSON.parse('{"type":"command","cmd":"x","status":"passed","__proto__":1}')], 'r[0].__proto__ is not allowed');
});
