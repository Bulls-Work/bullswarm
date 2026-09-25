import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAILURE_CLASSES, NEEDS_YOU_LABELS, RETRY_FACTS, countRetries, failureClassOf,
} from '../src/workflow/step-vocabulary.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// classifyFailure is private to v2-dispatch.js; read the kinds it can return
// from its source so a new kind there fails this test until it has a class.
function classifyFailureKinds() {
  const source = readFileSync(join(REPO, 'src/workflow/v2-dispatch.js'), 'utf8');
  const start = source.indexOf('function classifyFailure(');
  assert.notEqual(start, -1, 'classifyFailure is in v2-dispatch.js');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const kinds = [...body.matchAll(/return '([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(kinds.length >= 10, `read ${kinds.length} kinds`);
  return [...new Set(kinds)];
}

const RUNTIME_KINDS = ['not-produced', 'failed-evidence', 'ownership', 'ownership-conflict', 'runtime', 'unavailable'];
const STOP_KINDS = ['cancelled', 'paused', 'restarted', 'superseded'];

test('FAILURE_CLASSES is the D1 table, frozen, with each kind in exactly one class', () => {
  assert.deepEqual(FAILURE_CLASSES, {
    process: ['auth', 'provider', 'process', 'interrupted', 'stalled'],
    gate: ['not-produced', 'failed-evidence', 'schema', 'semantic'],
    wait: ['quota', 'throttle'],
    caller: ['ownership', 'ownership-conflict', 'runtime', 'unavailable'],
    stop: ['cancelled', 'paused', 'restarted', 'superseded'],
  });
  assert.equal(Object.isFrozen(FAILURE_CLASSES), true);
  for (const kinds of Object.values(FAILURE_CLASSES)) assert.equal(Object.isFrozen(kinds), true);
  const all = Object.values(FAILURE_CLASSES).flat();
  assert.equal(new Set(all).size, all.length, 'no kind is in two classes');
  assert.throws(() => { FAILURE_CLASSES.gate.push('x'); }, TypeError);
});

test('every kind classifyFailure returns, and every runtime and stop kind, has a class', () => {
  const classified = new Set(Object.values(FAILURE_CLASSES).flat());
  const returned = classifyFailureKinds();
  for (const kind of ['cancelled', 'not-produced', 'failed-evidence', 'quota', 'throttle', 'auth', 'stalled', 'provider', 'schema', 'process', 'interrupted', 'semantic']) {
    assert.ok(returned.includes(kind), `classifyFailure returns ${kind}`);
  }
  for (const kind of [...returned, ...RUNTIME_KINDS, ...STOP_KINDS]) assert.ok(classified.has(kind), `${kind} has a class`);
  for (const kind of STOP_KINDS) assert.equal(failureClassOf(kind), 'stop', kind);
});

test('failureClassOf maps each kind to its class and anything unknown to caller', () => {
  for (const [name, kinds] of Object.entries(FAILURE_CLASSES)) {
    for (const kind of kinds) assert.equal(failureClassOf(kind), name, kind);
  }
  assert.equal(failureClassOf('stalled'), 'process');
  assert.equal(failureClassOf('semantic'), 'gate');
  assert.equal(failureClassOf('throttle'), 'wait');
  for (const unknown of ['exploded', 'waiting', '', 'Quota', null, undefined, 42, {}, 'constructor', '__proto__', 'toString']) {
    assert.equal(failureClassOf(unknown), 'caller', String(unknown));
  }
});

test('NEEDS_YOU_LABELS is the §2.5 label table and covers every failure kind', () => {
  assert.deepEqual(NEEDS_YOU_LABELS, {
    'failed-evidence': { command: 'command evidence failed', schema: 'schema evidence failed' },
    'not-produced': 'deliverable not produced',
    schema: 'report format failed',
    semantic: 'output check failed',
    process: 'worker exited with an error',
    provider: 'provider error',
    stalled: 'worker went silent',
    auth: 'sign-in failed',
    interrupted: 'worker was killed',
    throttle: 'rate limited',
    quota: 'out of quota',
    unavailable: 'no eligible pool',
    'ownership-conflict': 'merge conflict',
    ownership: 'wrote outside its files',
    runtime: 'kernel error',
  });
  assert.equal(Object.isFrozen(NEEDS_YOU_LABELS), true);
  assert.equal(Object.isFrozen(NEEDS_YOU_LABELS['failed-evidence']), true);
  const failures = [...FAILURE_CLASSES.process, ...FAILURE_CLASSES.gate, ...FAILURE_CLASSES.wait, ...FAILURE_CLASSES.caller];
  for (const kind of [...new Set([...failures, ...classifyFailureKinds()])].filter((kind) => !STOP_KINDS.includes(kind))) {
    assert.ok(Object.hasOwn(NEEDS_YOU_LABELS, kind), `${kind} has a label`);
  }
  // Stop kinds are not failures: the block never labels them.
  for (const kind of STOP_KINDS) assert.equal(Object.hasOwn(NEEDS_YOU_LABELS, kind), false, kind);
});

test('RETRY_FACTS is the retryOf.how enum', () => {
  assert.deepEqual(RETRY_FACTS, ['other-pool', 'same-pool', 'wait']);
  assert.equal(Object.isFrozen(RETRY_FACTS), true);
});

// A minimal durable state: one step with the given attempts.
function stateWith(attempts, { step = 'build-a', supersededAttempts } = {}) {
  return {
    actions: [{ id: step, status: 'failed', attempts: attempts.length, programRevision: 1, ...(supersededAttempts !== undefined ? { supersededAttempts } : {}) }],
    attempts: attempts.map((retryOf, index) => ({
      id: `${step}-${index + 1}`, actionId: step, ordinal: index + 1, status: 'failed',
      ...(retryOf ? { retryOf: { attempt: `${step}-${index}`, how: retryOf } } : {}),
    })),
  };
}

test('countRetries counts successors whose retryOf.how is other-pool or same-pool', () => {
  assert.equal(countRetries(stateWith([null]), 'build-a'), 0, 'one failed attempt, no successor: nothing spent');
  assert.equal(countRetries(stateWith([null, 'other-pool']), 'build-a'), 1);
  assert.equal(countRetries(stateWith([null, 'same-pool']), 'build-a'), 1);
  assert.equal(countRetries(stateWith([null, 'other-pool', 'same-pool']), 'build-a'), 2);
  // A wait move is not a retry.
  assert.equal(countRetries(stateWith([null, 'wait']), 'build-a'), 0);
  assert.equal(countRetries(stateWith([null, 'wait', 'wait', 'other-pool']), 'build-a'), 1);
});

test('countRetries: a kernel stop spends nothing (plain successors and a failed attempt with no successor)', () => {
  // Attempt 1 failed and the kernel stopped before attempt 2 started: no fact.
  assert.equal(countRetries(stateWith([null]), 'build-a'), 0);
  // A kernel resume reran the step: a plain attempt with no retryOf.
  assert.equal(countRetries(stateWith([null, null, null]), 'build-a'), 0);
  // A retry happened, then a resume started a plain attempt: still one.
  assert.equal(countRetries(stateWith([null, 'other-pool', null]), 'build-a'), 1);
});

test('countRetries counts the current definition only, and resets when supersededAttempts moves', () => {
  const state = stateWith([null, 'same-pool', null, 'other-pool']);
  assert.equal(countRetries(state, 'build-a', 0), 2);
  assert.equal(countRetries(state, 'build-a', 2), 1, 'attempts 1-2 belong to an older definition');
  assert.equal(countRetries(state, 'build-a', 3), 1);
  assert.equal(countRetries(state, 'build-a', 4), 0, 'a caller action moved the boundary past every attempt');
  // Without the argument, the step's stored supersededAttempts applies.
  assert.equal(countRetries(stateWith([null, 'same-pool', null, 'other-pool'], { supersededAttempts: 2 }), 'build-a'), 1);
  assert.equal(countRetries(stateWith([null, 'same-pool'], { supersededAttempts: 2 }), 'build-a'), 0);
  // An explicit value wins over the stored one.
  assert.equal(countRetries(stateWith([null, 'same-pool'], { supersededAttempts: 2 }), 'build-a', 0), 1);
});

test('countRetries ignores other steps, unknown how values and malformed input, and never throws', () => {
  const state = stateWith([null, 'other-pool']);
  state.actions.push({ id: 'build-b', status: 'failed', attempts: 2, programRevision: 1 });
  state.attempts.push(
    { id: 'build-b-1', actionId: 'build-b', ordinal: 1, status: 'failed' },
    { id: 'build-b-2', actionId: 'build-b', ordinal: 2, status: 'failed', retryOf: { attempt: 'build-b-1', how: 'same-pool' } },
  );
  assert.equal(countRetries(state, 'build-a'), 1);
  assert.equal(countRetries(state, 'build-b'), 1);
  assert.equal(countRetries(state, 'missing'), 0);
  const odd = stateWith([null, 'again']);
  assert.equal(countRetries(odd, 'build-a'), 0);
  for (const bad of [null, undefined, {}, { attempts: null }, { attempts: [null, 7] }, { actions: [null], attempts: [] }]) {
    assert.equal(countRetries(bad, 'build-a'), 0);
  }
  // Pure: the state is not changed.
  const before = JSON.stringify(state);
  countRetries(state, 'build-a', 1);
  assert.equal(JSON.stringify(state), before);
});
