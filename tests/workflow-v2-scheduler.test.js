import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerValidationError, scheduleV2Actions } from '../src/workflow/v2-scheduler.js';

const action = (id, over = {}) => ({ id, dependsOn: [], ownedFiles: [], ...over });

test('selects a deterministic dependency-ready set and ignores evidence as a global barrier', () => {
  const actions = [
    action('evidence', { dependsOn: ['work'], evidenceFor: ['r'] }),
    action('work', { ownedFiles: ['src/work.js'] }),
    action('unrelated', { ownedFiles: ['src/other.js'] }),
  ];
  const result = scheduleV2Actions(actions, { work: 'succeeded', evidence: 'pending', unrelated: 'pending' }, { concurrency: 2, workspaceMode: 'isolated' });
  assert.deepEqual(result.ready, ['evidence', 'unrelated']);
  assert.deepEqual(result.selected, ['evidence', 'unrelated']);
});

test('waits for pending dependencies and blocks descendants of failed dependencies', () => {
  const result = scheduleV2Actions([
    action('failed'), action('waiting', { dependsOn: ['running'] }),
    action('blocked', { dependsOn: ['failed'] }), action('running'),
  ], { failed: 'failed', running: 'running', waiting: 'pending', blocked: 'pending' });
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.waiting, [{ id: 'waiting', reason: 'pending dependency' }]);
  assert.deepEqual(result.blocked, [{ id: 'blocked', reason: 'failed dependency' }]);
});

test('accepts durable action-state arrays and propagates blocked descendants transitively', () => {
  const result = scheduleV2Actions([
    action('root'), action('middle', { dependsOn: ['root'] }), action('leaf', { dependsOn: ['middle'] }),
  ], [{ id: 'root', status: 'failed' }, { id: 'middle', status: 'pending' }, { id: 'leaf', status: 'pending' }]);
  assert.deepEqual(result.blocked, [
    { id: 'middle', reason: 'failed dependency' }, { id: 'leaf', reason: 'failed dependency' },
  ]);
});

test('enforces shared workspace single-mutator rule while allowing read-only capacity', () => {
  const result = scheduleV2Actions([
    action('write-a', { ownedFiles: ['a.js'] }), action('read'), action('write-b', { ownedFiles: ['b.js'] }),
  ], undefined, { concurrency: 3, workspaceMode: 'shared' });
  assert.deepEqual(result.selected, ['write-a', 'read']);
  assert.deepEqual(result.deferred, [{ id: 'write-b', reason: 'shared workspace allows one mutating action' }]);
});

test('allows disjoint isolated mutators, but rejects overlapping ownership', () => {
  const result = scheduleV2Actions([
    action('first', { ownedFiles: ['same.js'] }),
    action('second', { ownedFiles: ['same.js'] }),
    action('third', { ownedFiles: ['other.js'] }),
  ], undefined, { concurrency: 3, workspaceMode: 'isolated' });
  assert.deepEqual(result.selected, ['first', 'third']);
  assert.deepEqual(result.deferred, [{ id: 'second', reason: 'owned file conflict' }]);
});

test('accounts for active work in concurrency and ownership decisions', () => {
  const actions = [
    action('active-write', { ownedFiles: ['same.js'] }),
    action('overlap', { ownedFiles: ['same.js'] }),
    action('disjoint', { ownedFiles: ['other.js'] }),
  ];
  const isolated = scheduleV2Actions(actions, { 'active-write': 'running' }, { concurrency: 2, workspaceMode: 'isolated' });
  assert.deepEqual(isolated.active, ['active-write']);
  assert.deepEqual(isolated.selected, ['disjoint']);
  assert.deepEqual(isolated.deferred, [{ id: 'overlap', reason: 'owned file conflict' }]);
  const shared = scheduleV2Actions(actions, { 'active-write': 'running' }, { concurrency: 3, workspaceMode: 'shared' });
  assert.deepEqual(shared.selected, []);
  assert.deepEqual(shared.deferred, [
    { id: 'overlap', reason: 'shared workspace allows one mutating action' },
    { id: 'disjoint', reason: 'shared workspace allows one mutating action' },
  ]);
});

test('treats waiting workers as active and rejects impossible active state', () => {
  const actions = [action('root'), action('child', { dependsOn: ['root'] })];
  assert.throws(() => scheduleV2Actions(actions, { root: 'running', child: 'running' }, { concurrency: 2 }), /unfinished dependency/);
  const result = scheduleV2Actions([action('waiting'), action('next')], { waiting: 'waiting' }, { concurrency: 1 });
  assert.deepEqual(result.active, ['waiting']);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.deferred, [{ id: 'next', reason: 'concurrency cap' }]);
});

test('rejects cycles even when every action is already terminal', () => {
  const actions = [action('a', { dependsOn: ['b'] }), action('b', { dependsOn: ['a'] })];
  assert.throws(() => scheduleV2Actions(actions, { a: 'succeeded', b: 'succeeded' }), /cycle/);
});

test('rejects malformed scheduler inputs and does not expose mutable action references', () => {
  assert.throws(() => scheduleV2Actions([action('a', { dependsOn: ['missing'] })]), SchedulerValidationError);
  assert.throws(() => scheduleV2Actions([action('a'), action('a')]), /duplicate action id/);
  assert.throws(() => scheduleV2Actions([action('Bad_ID')]), /lowercase kebab-case/);
  assert.throws(() => scheduleV2Actions([action('a')], { a: 'bogus' }), /malformed status/);
  assert.throws(() => scheduleV2Actions([action('a', { ownedFiles: ['src/'] })]), /directory or glob/);
  const input = [action('a', { ownedFiles: ['a.js'] })];
  const result = scheduleV2Actions(input);
  input[0].ownedFiles[0] = 'changed.js';
  assert.deepEqual(result.selected, ['a']);
});
