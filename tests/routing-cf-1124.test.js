// Routing fixes found wiring the Cloudflare Workers AI pools (orders
// bs-cf-pool-1123, bs-cf-pool-golive-1123; Charlie OK'd release 2026-11-24):
// - a pool can take build steps only when the step carries a machine check;
// - model discovery keeps ids with an `@` (every Workers AI id is `@cf/...`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePools } from '../src/workflow/dispatch-pools.js';
import { noPoolCandidates } from '../src/workflow/dispatch-no-pool.js';
import { parseDiscoveredModels } from '../src/lib/strategy.js';

const NOW = Date.parse('2026-11-24T02:00:00Z');

function pool(name, connectorExtra = {}) {
  return {
    name, enabled: true, lanes: ['analyze', 'build', 'chore'],
    connector: { name, spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' }, ...connectorExtra },
    strategyAssignments: { medium: { pool: name, model: 'm' }, low: { pool: name, model: 'm' } },
  };
}

const strict = () => pool('cheap', { buildsNeedCheck: true });
const plain = () => pool('usual');
const names = (list) => list.map((p) => p.name);

test('a pool with buildsNeedCheck sits out a build step that carries no check', () => {
  const step = { id: 'b', lane: 'build', effort: 'medium' };
  assert.deepEqual(names(preparePools([strict(), plain()], step, 'medium', { now: NOW })), ['usual']);
});

test('the same pool takes a build step with a command or schema check, and any analyze or chore step', () => {
  const command = { id: 'b', lane: 'build', effort: 'medium', evidence: [{ type: 'command', cmd: 'npm test' }] };
  const schema = { id: 'b', lane: 'build', effort: 'medium', evidence: [{ type: 'schema' }] };
  const analyze = { id: 'a', lane: 'analyze', effort: 'medium' };
  const chore = { id: 'c', lane: 'chore', effort: 'low' };
  for (const step of [command, schema, analyze]) {
    assert.deepEqual(names(preparePools([strict()], step, 'medium', { now: NOW })), ['cheap'], step.id);
  }
  assert.deepEqual(names(preparePools([strict()], chore, 'low', { now: NOW })), ['cheap']);
});

test('a pool without the setting is unchanged: it takes an unchecked build', () => {
  const step = { id: 'b', lane: 'build', effort: 'medium' };
  assert.deepEqual(names(preparePools([plain()], step, 'medium', { now: NOW })), ['usual']);
});

test('when no pool is left, the reason names the missing check', () => {
  const step = { id: 'b', lane: 'build', effort: 'medium' };
  const [row] = noPoolCandidates([strict()], step, 'medium', {
    lane: 'build', failedProbes: new Set(), onLane: () => true, held: [], now: NOW,
  });
  assert.match(row.excluded ?? '', /build steps only with a check/);
});

test('model discovery keeps ids with an @ (Workers AI)', () => {
  const output = 'cf/@cf/deepseek-ai/deepseek-v4.1-flash-1017\ncf/deepseek-v4.1-flash-low\nbad id with spaces\n';
  assert.deepEqual(parseDiscoveredModels(output, { includePattern: '^cf/' }), [
    'cf/@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    'cf/deepseek-v4.1-flash-low',
  ]);
});
