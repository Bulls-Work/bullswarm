// Routing fixes found wiring the Cloudflare Workers AI pools (orders
// bs-cf-pool-1123, bs-cf-pool-golive-1123; Charlie OK'd release 2026-11-24):
// - a pool can take build steps only when the step carries a machine check;
// - model discovery keeps ids with an `@` (every Workers AI id is `@cf/...`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePools } from '../src/workflow/dispatch-pools.js';
import { noPoolCandidates, tierOffReasons } from '../src/workflow/dispatch-no-pool.js';
import { noPoolWhy } from '../src/workflow/no-pool-why.js';
import { routeUnavailableWhy } from '../src/workflow/step-route.js';
import { pinnedPoolIssues } from '../src/workflow/cli-pool-checks.js';
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

// The step-level refusal said "no enabled pool has a model on the medium tier
// for build work" when the only pool with the tier refused for want of a
// check (biweekly eval 2026-11-28: t1 and t3 on a cf:glm pin; leads' unchecked
// builds on the cf route). The reason must name the check, not the tier.
test('a pool that would take the build with a check is named in the off-tier reasons', () => {
  const step = { id: 'b', lane: 'build', effort: 'medium' };
  const reasons = tierOffReasons([strict()], step, 'medium', { now: NOW });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /cheap takes build steps only with a check/);
});

test('when the missing check is the only reason, the refusal does not claim the tier has no model', () => {
  const why = noPoolWhy({
    capableCount: 0, held: [], lane: 'build', effort: 'medium',
    offTier: tierOffReasons([strict()], { id: 'b', lane: 'build', effort: 'medium' }, 'medium', { now: NOW }),
  });
  assert.match(why, /cheap takes build steps only with a check/);
  assert.doesNotMatch(why, /has a model on the medium tier/);
});

test('a program pinned to such a pool is refused for its unchecked builds, naming the check', () => {
  const issues = pinnedPoolIssues(
    { config: { workerRouting: { strictPool: 'cheap' } } },
    { actions: [{ id: 'parse', lane: 'build', effort: 'medium' }, { id: 'cli', lane: 'build', effort: 'medium', evidence: [{ type: 'command', cmd: 'npm test' }] }] },
    [strict()],
    { now: NOW },
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /\(parse\)/);
  assert.match(issues[0], /only with a check/);
  assert.doesNotMatch(issues[0], /no model on the medium tier/);
});

// Second strict review (28 Nov): under a step's route, or when a check
// refusal sits beside another off-tier reason, the why still opened with
// "no enabled pool has a model on the tier". The check leads instead.
test('a check refusal leads the why under a route and beside other off-tier reasons', () => {
  const check = 'cheap takes build steps only with a check (--check or command/schema evidence)';
  const plan = 'luna: the plan does not include acme-6-luna';
  const routed = routeUnavailableWhy({ summary: 'use cheap' }, { lane: 'build', effort: 'low', offTier: [check] });
  assert.match(routed, /^no eligible pool under the step's route \(use cheap\): cheap takes build steps only with a check/);
  assert.doesNotMatch(routed, /has a model on the low tier/);
  const mixed = noPoolWhy({ capableCount: 0, held: [], failureKind: 'unavailable', lane: 'build', effort: 'low', offTier: [plan, check] });
  assert.match(mixed, /^no eligible pool: cheap takes build steps only with a check .*; luna: the plan does not include acme-6-luna; add a check or route to another pool$/);
  assert.doesNotMatch(mixed, /has a model on the low tier/);
  // With no check refusal the tier wording stays.
  assert.match(routeUnavailableWhy({ summary: 'use luna' }, { lane: 'build', effort: 'low', offTier: [plan] }), /no enabled pool left has a model on the low tier/);
});
