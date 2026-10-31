// A provider-qualified model pin ('anthropic/claude-x') keeps only pools whose
// connector.profile.providerId matches the prefix; pools with no providerId stay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePools } from '../src/workflow/dispatch-pools.js';
import { poolCanRunModel } from '../src/lib/model-pin.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

// `knownModels` lists the pin so poolCanRunModel accepts every pool: the
// provider-prefix filter is then the only thing that can drop one.
const mk = (name, providerId, models = ['anthropic/claude-x', 'plainmodel']) => ({
  name, enabled: true, lanes: ['analyze', 'build', 'chore'],
  connector: {
    name, model: 'plainmodel', knownModels: models, spawn: { cmd: ['fake'] },
    ...(providerId ? { profile: { providerId } } : {}),
  },
});
const A = mk('a', 'openai');
const B = mk('b', 'anthropic');
const C = mk('c', null);
const names = (pools) => pools.map((p) => p.name);
const prepare = (opts) => preparePools([A, B, C], 'build', 'medium', { now: NOW, ...opts });

test('the fixture: poolCanRunModel would accept the pinned model on every pool', () => {
  for (const pool of [A, B, C]) assert.equal(poolCanRunModel(pool, 'anthropic/claude-x').ok, true, pool.name);
});

test('a provider-qualified pin drops a pool under another provider id, even one that could run the model', () => {
  assert.deepEqual(names(prepare({ preferredModel: 'anthropic/claude-x' })), ['b', 'c']);
});

test('a pool with no provider id stays under a provider-qualified pin', () => {
  assert.ok(names(prepare({ preferredModel: 'anthropic/claude-x' })).includes('c'));
});

test('the prefix is the text before the first slash', () => {
  assert.deepEqual(names(prepare({ preferredModel: 'openai/anything/deep' })).filter((n) => n === 'a' || n === 'b'), ['a']);
});

test('a model with no slash pins no provider and keeps every pool that can run it', () => {
  assert.deepEqual(names(prepare({ preferredModel: 'plainmodel' })), ['a', 'b', 'c']);
});

test('a leading slash pins no provider; the model check alone drops a pool that does not list it', () => {
  assert.deepEqual(names(prepare({ preferredModel: '/plainmodel' })).includes('a'), false,
    'a pool that does not list "/plainmodel" is dropped by the model check, not the provider check');
});

test('no pin keeps every pool', () => {
  assert.deepEqual(names(prepare({})), ['a', 'b', 'c']);
});
