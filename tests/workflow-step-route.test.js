import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateActionProgram } from '../src/workflow/action-validator.js';
import {
  inheritedRepairRoute, inheritedVerifyRoute, normalizeRoute, poolPassesRoute, resolveRouteFilter,
  routeIssuesForPools, routeSummary, routeUnavailableWhy, workAttempts,
} from '../src/workflow/step-route.js';

const SCHEMA = 'bullswarm.workflow.program.v2';
const relaxed = { mandatoryRequirements: ['result'], requireMandatoryEvidence: false, relaxedGraph: true };
const writer = (over = {}) => ({
  id: 'build-a', purpose: 'Build a', dependsOn: [], affects: ['result'], ownedFiles: ['src/a.js'],
  prompt: 'Implement a.', kind: 'implement', evidenceFor: [], ...over,
});
const checker = (over = {}) => ({
  id: 'check-a', purpose: 'Check a', dependsOn: ['build-a'], affects: [], ownedFiles: [],
  prompt: 'Inspect a.', kind: 'check', evidenceFor: ['result'], ...over,
});
const program = (actions) => ({ schemaVersion: SCHEMA, actions });
const validate = (actions, runtime = relaxed) => validateActionProgram(program(actions), runtime);
const issuesOf = (actions, runtime = relaxed) => {
  try {
    validate(actions, runtime);
  } catch (error) {
    return error.issues;
  }
  return [];
};
const routeOf = (route, over = {}) => validate([writer(), checker({ route, ...over })]).actions[1].route;

test('every §2.4 validator message', () => {
  const at = 'actions[1].route';
  const cases = [
    [{ pools: { use: ['pool-a'] } }, `${at} needs a program-mode run`, { mandatoryRequirements: ['result'] }],
    [['pool-a'], `${at} must be an object with pools, providers or independentOf`],
    ['pool-a', `${at} must be an object with pools, providers or independentOf`],
    [{ lane: 'build' }, `${at}.lane is not a route key; set the lane with the step's own "lane" field`],
    [{ model: 'x' }, `${at}.model is not allowed; a step's capability is its effort (and reasoning), not its route`],
    [{ reasoning: 'high' }, `${at}.reasoning is not allowed; a step's capability is its effort (and reasoning), not its route`],
    [{ effort: 'high' }, `${at}.effort is not allowed; a step's capability is its effort (and reasoning), not its route`],
    [{ pool: 'pool-a' }, `${at}.pool is not allowed; route takes pools, providers and independentOf`],
    [{ pools: ['pool-a'] }, `${at}.pools must be an object with use and/or avoid`],
    [{ providers: 'grok' }, `${at}.providers must be an object with use and/or avoid`],
    [{ pools: { prefer: ['pool-a'] } }, `${at}.pools.prefer is not allowed; pools takes use and avoid`],
    [{ providers: { only: ['grok'] } }, `${at}.providers.only is not allowed; providers takes use and avoid`],
    [{ pools: { use: 'pool-a' } }, `${at}.pools.use must be an array of pool ids`],
    [{ pools: { avoid: [''] } }, `${at}.pools.avoid must be an array of pool ids`],
    [{ pools: { use: ['pool a'] } }, `${at}.pools.use must be an array of pool ids`],
    [{ pools: { use: ['p'.repeat(81)] } }, `${at}.pools.use must be an array of pool ids`],
    [{ providers: { use: [1] } }, `${at}.providers.use must be an array of provider names`],
    [{ providers: { avoid: ['grok '] } }, `${at}.providers.avoid must be an array of provider names`],
    [{ pools: { use: ['pool-a', 'pool-b'], avoid: ['pool-b'] } }, `${at}.pools names "pool-b" in both use and avoid`],
    [{ providers: { use: ['grok'], avoid: ['grok'] } }, `${at}.providers names "grok" in both use and avoid`],
    [{ independentOf: 'everyone' }, `${at}.independentOf must be "writers" or an array of step ids`],
    [{ independentOf: ['Build A'] }, `${at}.independentOf must be "writers" or an array of step ids`],
    [{ independentOf: ['missing-step'] }, `${at}.independentOf names "missing-step", which is not a step in this program`],
    [{ independentOf: ['check-a'] }, `${at}.independentOf cannot name the step itself`],
  ];
  for (const [route, message, runtime] of cases) {
    const issues = issuesOf([writer(), checker({ route })], runtime);
    assert.ok(issues.includes(message), `${JSON.stringify(route)} → ${JSON.stringify(issues)}`);
  }
  // "writers" on a step without evidenceFor.
  assert.ok(issuesOf([writer({ route: { independentOf: 'writers' } })])
    .includes('actions[0].route.independentOf "writers" needs evidenceFor; on other steps name the steps'));
  // A step that does not run before this one.
  const later = writer({ id: 'build-b', ownedFiles: ['src/b.js'] });
  assert.ok(issuesOf([writer(), later, checker({ dependsOn: ['build-a', 'build-b'], route: { independentOf: ['build-b'] } }),
    writer({ id: 'build-c', ownedFiles: ['src/c.js'], route: { independentOf: ['build-b'] } })])
    .includes('actions[3].route.independentOf names "build-b", which does not run before this step; add it to dependsOn (directly or through another step)'));
});

test('program mode only: a route is refused outside a program-mode run and kept inside one', () => {
  const route = { pools: { use: ['pool-a'] } };
  assert.deepEqual(issuesOf([writer({ route })], { mandatoryRequirements: ['result'], requireMandatoryEvidence: false }),
    ['actions[0].route needs a program-mode run']);
  assert.deepEqual(validate([writer({ route })]).actions[0].route, route);
});

test('normalisation sorts, de-duplicates and drops empties; the result is a fixed point', () => {
  const raw = {
    independentOf: ['build-a', 'build-a'],
    providers: { avoid: ['grok', 'codex', 'grok'], use: [] },
    pools: { avoid: ['pool-b', 'pool-a', 'pool-b'], use: [] },
  };
  const normalized = routeOf(raw);
  assert.equal(JSON.stringify(normalized),
    '{"pools":{"avoid":["pool-a","pool-b"]},"providers":{"avoid":["codex","grok"]},"independentOf":["build-a"]}');
  // Twice-normalised is byte-identical, program and all.
  const once = validate([writer(), checker({ route: raw })]);
  const twice = validateActionProgram(once, relaxed);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
  // An empty route, or one made only of empties, is dropped entirely, so it
  // never becomes an amendment.
  for (const empty of [{}, { pools: {} }, { pools: { use: [], avoid: [] } }, { providers: { use: [] } }, { independentOf: [] }]) {
    const accepted = validate([writer(), checker({ route: empty })]);
    assert.equal(Object.hasOwn(accepted.actions[1], 'route'), false, JSON.stringify(empty));
  }
  // No route: nothing is written.
  assert.equal(Object.hasOwn(validate([writer(), checker()]).actions[1], 'route'), false);
  // The helper itself returns undefined for a missing route and pushes nothing.
  const issues = [];
  assert.equal(normalizeRoute(undefined, 'actions[0]', issues, { relaxedGraph: true }), undefined);
  assert.deepEqual(issues, []);
});

test('use/avoid overlap is refused per list, and the same name may appear across lists', () => {
  const issues = issuesOf([writer(), checker({ route: { pools: { use: ['pool-a'], avoid: ['pool-a'] }, providers: { use: ['pool-a'] } } })]);
  assert.deepEqual(issues, ['actions[1].route.pools names "pool-a" in both use and avoid']);
  assert.deepEqual(routeOf({ pools: { use: ['grok'] }, providers: { avoid: ['grok'] } }),
    { pools: { use: ['grok'] }, providers: { avoid: ['grok'] } });
});

test('"writers" is kept on a check step', () => {
  assert.deepEqual(routeOf({ independentOf: 'writers' }), { independentOf: 'writers' });
});

test('the ancestor rule: direct and transitive dependencies pass, and known actions count', () => {
  const b = writer({ id: 'build-b', dependsOn: ['build-a'], ownedFiles: ['src/b.js'] });
  const check = checker({ dependsOn: ['build-b'], route: { independentOf: ['build-a', 'build-b'] } });
  assert.deepEqual(validate([writer(), b, check]).actions[2].route, { independentOf: ['build-a', 'build-b'] });
  // Order in the program does not matter: the dependency is declared later.
  assert.deepEqual(validate([check, b, writer()]).actions[0].route, { independentOf: ['build-a', 'build-b'] });
  // A step from an earlier revision (runtime knownActions) is a step too.
  const known = { id: 'build-z', dependsOn: [], affects: ['result'], ownedFiles: ['src/z.js'], evidenceFor: [], produces: [] };
  const later = checker({ id: 'check-z', dependsOn: ['build-z'], route: { independentOf: ['build-z'] } });
  const accepted = validateActionProgram(program([later]), { ...relaxed, knownActions: [known] });
  assert.deepEqual(accepted.actions[0].route, { independentOf: ['build-z'] });
});

// State fixtures: a writer, its check, and attempts on named pools.
const pools = [
  { name: 'claude-code:acme' }, { name: 'claude-code' }, { name: 'grok' }, { name: 'codex' },
  { name: 'relay-x', connector: { profile: { providerId: 'openrouter' } } },
];
const attempt = (actionId, ordinal, pool, over = {}) => ({
  id: `${actionId}-${ordinal}`, actionId, ordinal, status: 'failed', pool, changedFileCount: 0, ...over,
});
const stateWith = ({ actions, attempts, runtime = {} }) => ({
  program: { schemaVersion: SCHEMA, revision: 1, actions },
  actions: actions.map((action) => ({ id: action.id, status: 'succeeded', attempts: 0, ...(runtime[action.id] ?? {}) })),
  attempts,
});

test('resolveRouteFilter: retries on two providers both count; superseded attempts do not', () => {
  const check = checker({ route: { independentOf: ['build-a'] } });
  const state = stateWith({
    actions: [writer(), check],
    attempts: [
      attempt('build-a', 1, 'codex', { status: 'succeeded' }),
      attempt('build-a', 2, 'claude-code:acme', { status: 'failed', changedFileCount: 3 }),
      attempt('build-a', 3, 'grok', { status: 'succeeded' }),
    ],
    runtime: { 'build-a': { supersededAttempts: 1, attempts: 3 } },
  });
  const filter = resolveRouteFilter(state, check, pools);
  assert.deepEqual(filter.independentProviders, ['claude-code', 'grok']);
  assert.deepEqual(filter.independentOf, { 'build-a': ['claude-code', 'grok'] });
  assert.equal(filter.usePools, null);
  assert.equal(filter.useProviders, null);
  assert.deepEqual(filter.avoidPools, []);
  assert.equal(filter.summary, 'independent of build-a (providers claude-code, grok)');
  assert.equal(poolPassesRoute({ name: 'codex' }, filter), true);
  assert.equal(poolPassesRoute({ name: 'claude-code' }, filter), false);
  assert.equal(poolPassesRoute('grok', filter), false);
});

test('resolveRouteFilter: a crashed attempt that changed files and the succeeded retry are both writers', () => {
  const check = checker({ route: { independentOf: ['build-a'] } });
  const base = { actions: [writer(), check], runtime: { 'build-a': { attempts: 2 } } };
  const crashed = stateWith({
    ...base,
    attempts: [
      attempt('build-a', 1, 'codex', { status: 'failed', failureKind: 'process', changedFileCount: 2 }),
      attempt('build-a', 2, 'grok', { status: 'succeeded' }),
    ],
  });
  assert.deepEqual(resolveRouteFilter(crashed, check, pools).independentProviders, ['codex', 'grok']);
  // changedFileCount 0 and no output: not a writer.
  const idle = stateWith({
    ...base,
    attempts: [attempt('build-a', 1, 'codex'), attempt('build-a', 2, 'grok', { status: 'succeeded' })],
  });
  assert.deepEqual(resolveRouteFilter(idle, check, pools).independentProviders, ['grok']);
  // No changedFileCount because the kernel stopped it before its snapshot: a writer.
  const unknown = stateWith({
    ...base,
    attempts: [
      attempt('build-a', 1, 'codex', { status: 'interrupted', failureKind: 'interrupted', changedFileCount: undefined }),
      attempt('build-a', 2, 'grok', { status: 'succeeded' }),
    ],
  });
  assert.deepEqual(resolveRouteFilter(unknown, check, pools).independentProviders, ['codex', 'grok']);
  // A written deliverable, or partial output a later attempt was handed: writers.
  const deliverable = stateWith({
    ...base,
    attempts: [attempt('build-a', 1, 'codex', { deliverable: { type: 'files', written: ['src/a.js'] } })],
  });
  assert.deepEqual(workAttempts(deliverable, 'build-a').map((item) => item.pool), ['codex']);
  const partial = stateWith({
    ...base,
    attempts: [attempt('build-a', 1, 'codex', { status: 'interrupted', stalled: true, partialOutput: 'out.md', outputBytes: 12 })],
  });
  assert.deepEqual(workAttempts(partial, 'build-a').map((item) => item.pool), ['codex']);
  const emptyPartial = stateWith({
    ...base,
    attempts: [attempt('build-a', 1, 'codex', { partialOutput: 'out.md', outputBytes: 0 })],
  });
  assert.deepEqual(workAttempts(emptyPartial, 'build-a'), []);
});

test('resolveRouteFilter: an accepted step\'s accepted attempt counts', () => {
  const check = checker({ route: { independentOf: ['build-a'] } });
  const state = stateWith({
    actions: [writer(), check],
    attempts: [attempt('build-a', 1, 'codex', { failureKind: 'failed-evidence' })],
    runtime: { 'build-a': { attempts: 1, acceptance: { evidence: 'choice', reason: 'good enough', attemptId: 'build-a-1' } } },
  });
  assert.deepEqual(resolveRouteFilter(state, check, pools).independentProviders, ['codex']);
});

test('resolveRouteFilter: "writers" resolves to the live work steps whose affects meet evidenceFor', () => {
  const other = writer({ id: 'build-b', affects: ['other'], ownedFiles: ['src/b.js'] });
  const removed = writer({ id: 'build-old', ownedFiles: ['src/old.js'] });
  const check = checker({ dependsOn: ['build-a', 'build-b'], route: { independentOf: 'writers', pools: { avoid: ['pool-b'] } } });
  const state = stateWith({
    actions: [writer(), other, removed, check],
    attempts: [
      attempt('build-a', 1, 'relay-x', { status: 'succeeded' }),
      attempt('build-b', 1, 'grok', { status: 'succeeded' }),
      attempt('build-old', 1, 'codex', { status: 'succeeded' }),
    ],
    runtime: { 'build-old': { status: 'removed' } },
  });
  const filter = resolveRouteFilter(state, { id: 'check-a' }, pools);
  assert.deepEqual(filter.independentOf, { 'build-a': ['openrouter'] });
  assert.deepEqual(filter.independentProviders, ['openrouter']);
  assert.equal(filter.summary, 'avoid pool-b · independent of writers (providers openrouter)');
  assert.equal(poolPassesRoute(pools[4], filter), false);
  assert.equal(poolPassesRoute({ name: 'pool-b' }, filter), false);
  assert.equal(poolPassesRoute({ name: 'grok' }, filter), true);
  // No route: no filter, and every pool passes.
  assert.equal(resolveRouteFilter(state, writer(), pools), null);
  assert.equal(poolPassesRoute({ name: 'grok' }, null), true);
});

test('poolPassesRoute applies use and avoid for pools and providers', () => {
  const filter = resolveRouteFilter({ program: { actions: [] }, actions: [], attempts: [] }, writer({
    route: { pools: { use: ['claude-code:acme', 'grok'], avoid: [] }, providers: { use: ['claude-code', 'grok'], avoid: ['grok'] } },
  }), pools);
  assert.equal(poolPassesRoute({ name: 'claude-code:acme' }, filter), true);
  assert.equal(poolPassesRoute({ name: 'claude-code' }, filter), false, 'not in pools.use');
  assert.equal(poolPassesRoute({ name: 'grok' }, filter), false, 'provider avoided');
  const providerOnly = { usePools: null, avoidPools: [], useProviders: ['codex'], avoidProviders: [], independentProviders: [] };
  assert.equal(poolPassesRoute({ name: 'codex' }, providerOnly), true);
  assert.equal(poolPassesRoute({ name: 'grok' }, providerOnly), false);
});

test('routeSummary text', () => {
  const route = {
    pools: { use: ['pool-a', 'pool-b'], avoid: ['pool-c'] },
    providers: { use: ['claude-code'], avoid: ['grok'] },
    independentOf: ['build-a', 'build-b'],
  };
  assert.equal(routeSummary(route),
    'use pool-a, pool-b · avoid pool-c · providers claude-code · avoid providers grok · independent of build-a, build-b');
  assert.equal(routeSummary(route, { independentProviders: ['codex', 'grok'] }),
    'use pool-a, pool-b · avoid pool-c · providers claude-code · avoid providers grok · independent of build-a, build-b (providers codex, grok)');
  assert.equal(routeSummary({ independentOf: 'writers' }), 'independent of writers');
  assert.equal(routeSummary(undefined), '');
  const filter = { summary: 'independent of build-a (providers grok)', independentOf: { 'build-a': ['grok'] }, independentProviders: ['grok'] };
  assert.equal(routeUnavailableWhy(filter, { lane: 'analyze', effort: 'medium' }),
    "no eligible pool under the step's route (independent of build-a (providers grok)): no enabled pool left has a model on the medium tier for analyze work");
  assert.equal(routeUnavailableWhy(filter, { lane: 'analyze', effort: 'medium', sharedProvider: true }),
    "no eligible pool under the step's route (independent of build-a (providers grok)): every pool that could run it shares a provider with build-a (grok)");
});

test('inheritedRepairRoute: avoid unions, use intersections, never independentOf', () => {
  const a = { route: { pools: { use: ['pool-a', 'pool-b'], avoid: ['pool-x'] }, providers: { avoid: ['grok'] }, independentOf: ['build-z'] } };
  const b = { route: { pools: { use: ['pool-b', 'pool-c'], avoid: ['pool-y'] }, providers: { use: ['codex'], avoid: ['claude-code'] } } };
  assert.deepEqual(inheritedRepairRoute([a, b]), {
    pools: { use: ['pool-b'], avoid: ['pool-x', 'pool-y'] },
    providers: { avoid: ['claude-code', 'grok'] },
  });
  // A step with no use list makes the use absent.
  assert.deepEqual(inheritedRepairRoute([a, { id: 'plain' }]), { pools: { avoid: ['pool-x'] }, providers: { avoid: ['grok'] } });
  // No route anywhere: undefined, so nothing is written.
  assert.equal(inheritedRepairRoute([{ id: 'x' }, { id: 'y' }]), undefined);
  assert.equal(inheritedRepairRoute([]), undefined);
  // A single step's lists come across whole.
  assert.deepEqual(inheritedRepairRoute([b]), b.route);
  // An avoided name is dropped from the intersection.
  const c = { route: { pools: { use: ['pool-b', 'pool-c'], avoid: ['pool-b'] } } };
  assert.deepEqual(inheritedRepairRoute([b, c]), {
    pools: { use: ['pool-c'], avoid: ['pool-b', 'pool-y'] },
    providers: { avoid: ['claude-code'] },
  });
  // The inherited route is a normalisation fixed point.
  const inherited = inheritedRepairRoute([a, b]);
  const issues = [];
  assert.deepEqual(normalizeRoute(inherited, 'actions[0]', issues, { relaxedGraph: true }), inherited);
  assert.deepEqual(issues, []);
});

test('inheritedVerifyRoute: "writers" wins; otherwise named steps plus every earlier repair', () => {
  const named = { route: { independentOf: ['build-a'], providers: { use: ['codex', 'grok'] } } };
  const other = { route: { independentOf: ['build-b'], providers: { use: ['grok'] }, pools: { avoid: ['pool-a'] } } };
  assert.deepEqual(inheritedVerifyRoute([named, other], ['repair-1']), {
    pools: { avoid: ['pool-a'] },
    providers: { use: ['grok'] },
    independentOf: ['build-a', 'build-b', 'repair-1'],
  });
  assert.deepEqual(inheritedVerifyRoute([named, { route: { independentOf: 'writers' } }], ['repair-1', 'repair-2']), {
    independentOf: 'writers',
  });
  // No check names steps: no independentOf, and repairs alone add nothing.
  assert.deepEqual(inheritedVerifyRoute([{ route: { pools: { avoid: ['pool-a'] } } }, { id: 'plain' }], ['repair-1']), {
    pools: { avoid: ['pool-a'] },
  });
  assert.equal(inheritedVerifyRoute([{ id: 'plain' }], ['repair-1']), undefined);
});

test('routeIssuesForPools: the CLI checks against the configured pools', () => {
  const configured = [
    { name: 'claude-code:acme', enabled: true }, { name: 'grok', enabled: true }, { name: 'codex', enabled: false },
  ];
  const step = (route, over = {}) => ({ id: 'build-a', lane: 'build', effort: 'high', route, ...over });
  const check = (route, opts = {}) => routeIssuesForPools(program([step(route)]), configured, opts);
  assert.deepEqual(check({ pools: { use: ['nope'] } }),
    ['step build-a route.pools.use names "nope", which is not a configured pool (configured: claude-code:acme, grok, codex)']);
  assert.deepEqual(check({ pools: { avoid: ['nope'] } }),
    ['step build-a route.pools.avoid names "nope", which is not a configured pool (configured: claude-code:acme, grok, codex)']);
  assert.deepEqual(check({ pools: { use: ['work'] } }, { labels: { 'claude-code:acme': 'work' } }),
    ['step build-a route.pools.use names "work", which is a pool label; use its id "claude-code:acme"']);
  assert.deepEqual(check({ providers: { use: ['initech'] } }),
    ['step build-a route.providers.use names "initech", which no configured pool uses (providers: claude-code, codex, grok)']);
  assert.deepEqual(check({ providers: { avoid: ['initech'] } }),
    ['step build-a route.providers.avoid names "initech", which no configured pool uses (providers: claude-code, codex, grok)']);
  // Only a disabled pool left: no enabled pool can run it.
  assert.deepEqual(check({ pools: { use: ['codex'] } }),
    ['step build-a: no enabled pool can run it under its route (build/high work; route: use codex)']);
  // The capability filter decides with a window at its limit ignored; its answer is still route-filtered.
  const seen = [];
  const preparePools = (list, action, effort, opts) => {
    seen.push({ action: action.id, effort, opts: { ...opts, routeFilter: undefined } });
    return list.filter((pool) => pool.name === 'grok');
  };
  assert.deepEqual(check({ pools: { use: ['claude-code:acme'] } }, { preparePools }),
    ['step build-a: no enabled pool can run it under its route (build/high work; route: use claude-code:acme)']);
  assert.deepEqual(seen[0], {
    action: 'build-a', effort: 'high',
    opts: { routeFilter: undefined, ignoreBurstGate: true },
  });
  assert.deepEqual(check({ pools: { use: ['grok'] } }, { preparePools }), []);
  // The run pin and the route must meet.
  assert.deepEqual(check({ pools: { avoid: ['grok'] } }, { runPin: 'grok' }),
    ["step build-a: its route leaves nothing of the run's pinned pool grok (--worker-pool)"]);
  assert.deepEqual(check({ providers: { use: ['grok'] } }, { runPin: 'grok' }), []);
  // Steps without a route are not checked.
  assert.deepEqual(routeIssuesForPools(program([{ id: 'plain', lane: 'build', effort: 'high' }]), [], {}), []);
});

test('F18: a missing changedFileCount is work only when the kernel stopped the attempt before its snapshot', () => {
  // Outside git no attempt records changedFileCount. An auth failure that did
  // nothing, then a succeeded retry on another provider: only the retry wrote.
  const check = checker({ route: { independentOf: ['build-a'] } });
  const base = { actions: [writer(), check], runtime: { 'build-a': { attempts: 2 } } };
  const noSnapshot = { changedFileCount: undefined };
  const ungit = stateWith({
    ...base,
    attempts: [
      attempt('build-a', 1, 'codex', { ...noSnapshot, status: 'interrupted', failureKind: 'auth', willRetry: true }),
      attempt('build-a', 2, 'grok', { ...noSnapshot, status: 'succeeded' }),
    ],
  });
  assert.deepEqual(workAttempts(ungit, 'build-a').map((item) => item.id), ['build-a-2']);
  const filter = resolveRouteFilter(ungit, check, pools);
  assert.deepEqual(filter.independentProviders, ['grok']);
  assert.equal(poolPassesRoute({ name: 'codex' }, filter), true, 'the provider that did nothing may review');
  // Other failures that ended on their own, without a snapshot: not work either.
  for (const failureKind of ['spawnError', 'quota', 'unavailable', 'process', 'timeout', null]) {
    const state = stateWith({ ...base, attempts: [attempt('build-a', 1, 'codex', { ...noSnapshot, failureKind })] });
    assert.deepEqual(workAttempts(state, 'build-a'), [], String(failureKind));
  }
  // The kernel stopped it (signal, dead kernel, pause, restart, cancel, a
  // running attempt the kernel has not snapshotted yet): unknown work counts.
  const stops = [
    { status: 'interrupted', failureKind: 'interrupted' },
    { status: 'cancelled', failureKind: 'cancelled' },
    { status: 'cancelled', failureKind: 'paused' },
    { status: 'cancelled', failureKind: 'restarted' },
    { status: 'running', failureKind: null },
  ];
  for (const stop of stops) {
    const state = stateWith({ ...base, attempts: [attempt('build-a', 1, 'codex', { ...noSnapshot, ...stop })] });
    assert.deepEqual(workAttempts(state, 'build-a').map((item) => item.pool), ['codex'], JSON.stringify(stop));
  }
  // A kernel-stopped attempt whose snapshot was taken is judged by its count.
  const snapped = stateWith({ ...base, attempts: [attempt('build-a', 1, 'codex', { status: 'cancelled', failureKind: 'paused', changedFileCount: 0 })] });
  assert.deepEqual(workAttempts(snapped, 'build-a'), []);
});

test('F9: an empty use intersection is refused through validation, never widened', () => {
  // Each source avoids the other's pool: nothing is left in common.
  const a = { id: 'build-a', route: { pools: { use: ['grok'], avoid: ['codex'] } } };
  const b = { id: 'build-b', route: { pools: { use: ['codex'], avoid: ['grok'] } } };
  const conflict = 'pools.use of build-a (grok), build-b (codex) have no name in common once the avoided pools (codex, grok) are removed; change one of those routes (plan revise) or accept the requirement';
  assert.deepEqual(inheritedRepairRoute([a, b]), { pools: { avoid: ['codex', 'grok'] }, inheritConflict: conflict });
  // Disjoint use lists with nothing avoided: no union stands in either.
  const c = { id: 'check-a', route: { providers: { use: ['grok'] }, independentOf: ['build-a'] } };
  const d = { id: 'check-b', route: { providers: { use: ['codex'] } } };
  assert.deepEqual(inheritedVerifyRoute([c, d], ['repair-1']), {
    inheritConflict: 'providers.use of check-a (grok), check-b (codex) have no name in common; change one of those routes (plan revise) or accept the requirement',
    independentOf: ['build-a', 'repair-1'],
  });
  // The validator refuses the inherited route, so the kernel's revision is
  // rejected and the loop stops with the caller.
  const repair = writer({ id: 'repair-1', dependsOn: ['build-a'], ownedFiles: ['src/r.js'], route: inheritedRepairRoute([a, b]) });
  const check = checker({ dependsOn: ['build-a', 'repair-1'] });
  assert.deepEqual(issuesOf([writer(), repair, check]), [`actions[1].route cannot be inherited: ${conflict}`]);
  assert.deepEqual(issuesOf([writer(), { ...repair, route: undefined }, check]), []);
  // A shared name survives: no conflict key.
  assert.equal(Object.hasOwn(inheritedRepairRoute([a, { id: 'build-c', route: { pools: { use: ['grok', 'codex'] } } }]), 'inheritConflict'), false);
});

test('F6: under a --worker-pool pin, independentOf is refused up front when the pin did or will do the work', () => {
  const configured = [{ name: 'grok', enabled: true }, { name: 'codex', enabled: true }];
  const build = writer({ lane: 'build', effort: 'high' });
  const named = checker({ lane: 'analyze', effort: 'medium', route: { independentOf: ['build-a'] } });
  const writers = checker({ id: 'check-b', lane: 'analyze', effort: 'medium', route: { independentOf: 'writers' } });
  const issues = routeIssuesForPools(program([build, named, writers]), configured, { runPin: 'grok' });
  assert.deepEqual(issues, [
    "step check-a: its route is independent of build-a, which runs on the run's pinned pool grok (--worker-pool, provider grok), so no pool is left for it; drop independentOf or run without --worker-pool",
    "step check-b: its route is independent of writers (build-a), which runs on the run's pinned pool grok (--worker-pool, provider grok), so no pool is left for it; drop independentOf or run without --worker-pool",
  ]);
  // Without the pin the same program passes: another pool is left.
  assert.deepEqual(routeIssuesForPools(program([build, named, writers]), configured, {}), []);
  // "writers" with no writer step names nobody.
  const lone = checker({ id: 'check-c', dependsOn: [], evidenceFor: ['other'], route: { independentOf: 'writers' } });
  assert.deepEqual(routeIssuesForPools(program([build, lone]), configured, { runPin: 'grok' }), []);
  // A running run: build-a finished without doing work (an auth failure,
  // accepted nowhere), so the pinned provider did not do it and the check may
  // run there; the same state's runtime filter agrees.
  const idle = stateWith({
    actions: [build, named],
    attempts: [attempt('build-a', 1, 'grok', { changedFileCount: undefined, failureKind: 'auth' })],
    runtime: { 'build-a': { status: 'failed', attempts: 1 } },
  });
  assert.deepEqual(routeIssuesForPools(program([named]), configured, { runPin: 'grok', state: idle }), []);
  assert.equal(poolPassesRoute({ name: 'grok' }, resolveRouteFilter(idle, named, configured)), true);
  // Once it did the work on the pin, the running-run check says so.
  const worked = stateWith({
    actions: [build, named],
    attempts: [attempt('build-a', 1, 'grok', { status: 'succeeded' })],
  });
  assert.equal(routeIssuesForPools(program([named]), configured, { runPin: 'grok', state: worked }).length, 1);
  assert.equal(poolPassesRoute({ name: 'grok' }, resolveRouteFilter(worked, named, configured)), false);
  // "writers" reads the writer steps from the run's program when the revision names only the check.
  assert.equal(routeIssuesForPools(program([writers]), configured, { runPin: 'grok', state: { ...worked, program: { actions: [build, writers] } } }).length, 1);
});
