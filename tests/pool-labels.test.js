import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  clearPoolLabelCache, poolLabel, resolvePoolId,
} from '../src/lib/pool-labels.js';
import { registerAssignment, releaseAssignment } from '../src/lib/assignments.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const POOL = 'echo';
const LABEL = 'sample:a';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-pool-labels-'));
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { [POOL]: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  })}\n`);
  return home;
}

function run(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' },
    encoding: 'utf8',
  });
}

test('pool labels round-trip through the CLI and pools JSON keeps id plus poolLabel', () => {
  const home = makeHome();
  try {
    const set = run(home, ['pools', 'label', POOL, LABEL]);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout.trim(), `${POOL} displays as ${LABEL}`);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'pool-labels.json'), 'utf8')), {
      version: 1, labels: { [POOL]: LABEL },
    });

    const listed = run(home, ['pools', 'label', '--list', '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).labels, [{ pool: POOL, poolLabel: LABEL }]);

    const pools = run(home, ['pools', '--json']);
    assert.equal(pools.status, 0, pools.stderr);
    const row = JSON.parse(pools.stdout).pools.find((entry) => entry.name === POOL);
    assert.ok(row, pools.stdout);
    assert.equal(row.poolLabel, LABEL);
    const human = run(home, ['pools']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, new RegExp(LABEL.replace(':', '\\:')));
    assert.doesNotMatch(human.stdout, new RegExp(`^${POOL.replace(':', '\\:')}\\s+cost`, 'm'));

    const assignment = registerAssignment(home, {
      pool: POOL, model: 'echo-local', lane: 'build', effort: 'low', source: 'run',
    });
    const assignments = run(home, ['assignments', '--json']);
    assert.equal(assignments.status, 0, assignments.stderr);
    assert.deepEqual(JSON.parse(assignments.stdout).map(({ pool, poolLabel: display }) => ({ pool, poolLabel: display })), [
      { pool: POOL, poolLabel: LABEL },
    ]);
    releaseAssignment(home, assignment.id);

    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    state.strategy = { configuredTiers: ['low'], modelTiers: { echo: { 'echo-local': ['low'] } } };
    writeFileSync(join(home, 'state.json'), `${JSON.stringify(state)}\n`);
    const rungs = run(home, ['strategy', 'rungs', '--pool', LABEL, '--json']);
    assert.equal(rungs.status, 0, rungs.stderr);
    assert.ok(JSON.parse(rungs.stdout).rungs.some((row) => row.pool === POOL && row.poolLabel === LABEL));

    const cleared = run(home, ['pools', 'label', LABEL, '--clear']);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(JSON.parse(readFileSync(join(home, 'pool-labels.json'), 'utf8')).labels[POOL], undefined);
  } finally {
    clearPoolLabelCache(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('pool label validation refuses unknown pools, spaces, duplicate labels, and another pool id', () => {
  const home = makeHome();
  try {
    assert.equal(run(home, ['pools', 'label', 'claude-code:unknown', 'claude-code:u']).status, 2);
    assert.match(run(home, ['pools', 'label', POOL, 'two words']).stderr, /contain no spaces/);
    assert.equal(run(home, ['pools', 'label', POOL, LABEL]).status, 0);

    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    state.pools['codex:sample'] = { enabled: false };
    writeFileSync(join(home, 'state.json'), `${JSON.stringify(state)}\n`);
    assert.match(run(home, ['pools', 'label', 'codex:sample', LABEL]).stderr, /already used/);
    assert.match(run(home, ['pools', 'label', POOL, 'codex:sample']).stderr, /another pool's id/);
  } finally {
    clearPoolLabelCache(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('one resolver accepts both the pool id and its display label', () => {
  const home = makeHome();
  try {
    writeFileSync(join(home, 'pool-labels.json'), `${JSON.stringify({ version: 1, labels: { [POOL]: LABEL } })}\n`);
    clearPoolLabelCache(home);
    assert.equal(resolvePoolId(POOL, home), POOL);
    assert.equal(resolvePoolId(LABEL, home), POOL);
    assert.equal(poolLabel(POOL, home), LABEL);
  } finally {
    clearPoolLabelCache(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('Home, Budget, and Stats render a configured label and never its pool id', () => {
  const pool = {
    name: POOL, poolLabel: LABEL, enabled: true, costRank: 4, lanes: ['analyze'],
    usedPct: 20, elapsedPct: 50, pace: 30, pacingWindow: 'weekly', fiveHourUsedPct: 10,
    meterSource: 'cache', incumbentLane: [], quarantine: null,
    subscription: { monthlyPriceUsd: 20 },
  };
  const model = dashboardModel(null, { usage: { pools: [pool], assignments: [], rungs: [], capturedAt: null } });
  for (const [page, extra] of [
    ['home', {}],
    ['budget', {}],
    ['stats', { statsTab: 'pool' }],
  ]) {
    const text = renderDashboardPage(model, { page, width: 120, height: 60, ...extra }).lines.join('\n');
    assert.match(text, new RegExp(LABEL.replace(':', '\\:')), `${page} should show the label`);
    assert.doesNotMatch(text, new RegExp(POOL.replace(':', '\\:')), `${page} should hide the id`);
  }
});
