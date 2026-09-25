import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerValidationError, canStartV2Action, scheduleV2Actions } from '../src/workflow/v2-scheduler.js';

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

test('a waiting step holds no slot, and a running one still rejects impossible active state', () => {
  const actions = [action('root'), action('child', { dependsOn: ['root'] })];
  assert.throws(() => scheduleV2Actions(actions, { root: 'running', child: 'running' }, { concurrency: 2 }), /unfinished dependency/);
  const result = scheduleV2Actions([action('waiting'), action('next')], { waiting: 'waiting' }, { concurrency: 1 });
  assert.deepEqual(result.active, []);
  assert.deepEqual(result.selected, ['next']);
  assert.deepEqual(result.deferred, []);
});

test('running plus waiting above concurrency does not throw, and a waiting step is never selected again', () => {
  const actions = [action('run-a'), action('wait-b'), action('wait-c'), action('after-b', { dependsOn: ['wait-b'] })];
  const result = scheduleV2Actions(actions, { 'run-a': 'running', 'wait-b': 'waiting', 'wait-c': 'waiting' }, { concurrency: 1 });
  assert.deepEqual(result.active, ['run-a']);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.waiting, [{ id: 'after-b', reason: 'pending dependency' }]);
  assert.throws(() => scheduleV2Actions([action('a'), action('b')], { a: 'running', b: 'running' }, { concurrency: 1 }), /exceed concurrency/);
});

test('a waiting unrestricted writer does not stop other steps from being selected', () => {
  const options = { concurrency: 3, workspaceMode: 'shared', allowParallelShared: true };
  const actions = [action('integrate', { lane: 'build' }), action('read', { lane: 'analyze' }), action('owned', { lane: 'build', ownedFiles: ['a.js'] })];
  const waiting = scheduleV2Actions(actions, { integrate: 'waiting' }, options);
  assert.deepEqual(waiting.selected, ['read', 'owned']);
  const running = scheduleV2Actions(actions, { integrate: 'running' }, options);
  assert.deepEqual(running.selected, []);
  assert.deepEqual(running.deferred.map((entry) => entry.reason), ['unrestricted integrator runs alone', 'unrestricted integrator runs alone']);
});

test('a waiting step with owned files does not block an overlapping writer', () => {
  const actions = [action('holder', { ownedFiles: ['same.js'] }), action('overlap', { ownedFiles: ['same.js'] })];
  const isolated = scheduleV2Actions(actions, { holder: 'waiting' }, { concurrency: 2, workspaceMode: 'isolated' });
  assert.deepEqual(isolated.selected, ['overlap']);
  const shared = scheduleV2Actions(actions, { holder: 'waiting' }, { concurrency: 2, workspaceMode: 'shared' });
  assert.deepEqual(shared.selected, ['overlap']);
});

test('canStartV2Action checks one waiting step against the running steps only', () => {
  const program = { concurrency: 2, workspaceMode: 'shared', allowParallelShared: true };
  // A running unrestricted writer runs alone.
  assert.equal(canStartV2Action([action('integrate', { lane: 'build' }), action('wake', { lane: 'analyze' })],
    { integrate: 'running', wake: 'waiting' }, 'wake', program), false);
  // A waiting unrestricted writer cannot start next to a running reader.
  assert.equal(canStartV2Action([action('read', { lane: 'analyze' }), action('wake', { lane: 'build' })],
    { read: 'running', wake: 'waiting' }, 'wake', program), false);
  // A running owned-file overlap.
  const owned = [action('holder', { ownedFiles: ['same.js'] }), action('wake', { ownedFiles: ['same.js'] })];
  assert.equal(canStartV2Action(owned, { holder: 'running', wake: 'waiting' }, 'wake', { concurrency: 2, workspaceMode: 'isolated' }), false);
  // The one-mutator rule in a plain shared workspace.
  const mutators = [action('holder', { ownedFiles: ['a.js'] }), action('wake', { ownedFiles: ['b.js'] })];
  assert.equal(canStartV2Action(mutators, { holder: 'running', wake: 'waiting' }, 'wake', { concurrency: 2 }), false);
  assert.equal(canStartV2Action(mutators, { holder: 'running', wake: 'waiting' }, 'wake', { concurrency: 2, workspaceMode: 'isolated' }), true);
  // A full cap.
  const cap = [action('a'), action('b'), action('wake')];
  assert.equal(canStartV2Action(cap, { a: 'running', b: 'running', wake: 'waiting' }, 'wake', { concurrency: 2 }), false);
  assert.equal(canStartV2Action(cap, { a: 'running', b: 'waiting', wake: 'waiting' }, 'wake', { concurrency: 2 }), true);
  // Other waiting and ready steps are ignored; the owned-file overlap is only with running steps.
  assert.equal(canStartV2Action([...owned, action('ready')], { holder: 'waiting', wake: 'waiting' }, 'wake', { concurrency: 1, workspaceMode: 'isolated' }), true);
  assert.equal(canStartV2Action(cap, { wake: 'running' }, 'wake', { concurrency: 3 }), false);
  assert.throws(() => canStartV2Action(cap, {}, 'missing'), /unknown action "missing"/);
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
