// A run that is still starting is not a legacy run.
//
// Measured on 0.38.21: `workflow goal --json` returned before the detached
// kernel wrote state.json (it waited 10 s at most), and a `workflow watch`
// started at once found a run directory without state.json and printed the
// legacy line, while the new run was in fact starting. A directory without
// state.json is legacy only when nothing in it says a new run is starting:
// no kernel.lock, no programFormat 3 marker, no caller.json, and no live
// launcher process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as shortIdModule from '../src/workflow/short-id.js';
import { runWorkflowWatch } from '../src/workflow/watch-cli.js';
import { dashboardRows } from '../src/workflow/dashboard.js';
import { renderDetails } from '../src/workflow/dashboard-details.js';
import * as launchModule from '../src/workflow/cli-launch.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

// Namespace imports, so a missing export fails its own test only.
const { isLegacyRunDir, listRuns } = shortIdModule;
const runStartingFacts = (...args) => shortIdModule.runStartingFacts(...args);
const waitForRunState = (...args) => launchModule.waitForRunState(...args);

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');
const RUN_ID = 'wf-mstart1-abcdef';

// A pid that certainly belongs to no running process: one that already exited.
const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid;

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-starting-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// What a 0.38 kernel leaves before its first state.json: the run folder with
// kernel.lock, goal.json, caller.json and features.json, and the launcher's
// goals/<runId>/ folder.
function startingRun(bullswarmDir, { pid = process.pid, lock = true, features = true, stderr = null } = {}) {
  const runDir = join(bullswarmDir, 'workflows', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  if (lock) writeFileSync(join(runDir, 'kernel.lock'), JSON.stringify({ pid, identity: null, token: 't' }));
  if (features) {
    writeFileSync(join(runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller', programFormat: 3 }));
    writeFileSync(join(runDir, 'goal.json'), JSON.stringify({ intent: { goal: 'g', cwd: '/tmp' } }));
    writeFileSync(join(runDir, 'caller.json'), JSON.stringify({ schemaVersion: 'bullswarm.workflow.caller.v1', caller: {}, recordedAt: new Date().toISOString() }));
  }
  const goalDir = join(bullswarmDir, 'goals', RUN_ID);
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(join(goalDir, 'launcher.json'), JSON.stringify({
    schemaVersion: 'bullswarm.goal.launcher.v2', runId: RUN_ID, pid, launchedAt: new Date().toISOString(),
  }));
  if (stderr != null) writeFileSync(join(goalDir, 'stderr.log'), stderr);
  return runDir;
}

function completedState() {
  const goal = createV2GoalDocument({
    goal: 'Land the change', cwd: '/tmp/repo',
    requirements: [{ id: 'requirement-1', text: 'Change lands' }],
    settings: { scout: false },
  });
  const state = createV2State(goal, { runId: RUN_ID, shortId: 'stg234' });
  state.lifecycle = {
    status: 'completed', startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(), resultFile: null,
  };
  return state;
}

function cli(bullswarmDir, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: bullswarmDir },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('a starting run folder (new-run markers, no state.json) is not legacy; an old folder still is', () => {
  const h = home();
  try {
    const runDir = startingRun(h.dir);
    assert.equal(isLegacyRunDir(runDir), false);
    assert.deepEqual(runStartingFacts(runDir), { alive: true, pid: process.pid });

    // Only the kernel's lease so far, with a live pid: still a new run.
    const lockOnly = join(h.dir, 'workflows', 'wf-mstart2-abcdef');
    mkdirSync(lockOnly, { recursive: true });
    writeFileSync(join(lockOnly, 'kernel.lock'), JSON.stringify({ pid: process.pid }));
    assert.equal(isLegacyRunDir(lockOnly), false);

    // A dead starter that left its markers is a failed new run, not history.
    const dead = join(h.dir, 'workflows', 'wf-mstart3-abcdef');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'features.json'), JSON.stringify({ programFormat: 3 }));
    assert.equal(isLegacyRunDir(dead), false);
    assert.deepEqual(runStartingFacts(dead), { alive: false, pid: null });

    // An old folder with no state.json and no marker stays legacy, even with
    // an old launcher record whose process is long gone.
    const old = join(h.dir, 'workflows', 'wf-mold000-abcdef');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'workflow.json'), JSON.stringify({ name: 'ancient' }));
    mkdirSync(join(h.dir, 'goals', 'wf-mold000-abcdef'), { recursive: true });
    writeFileSync(join(h.dir, 'goals', 'wf-mold000-abcdef', 'launcher.json'), JSON.stringify({
      schemaVersion: 'bullswarm.goal.launcher.v2', pid: DEAD_PID, launchedAt: '2026-08-01T00:00:00.000Z',
    }));
    assert.equal(isLegacyRunDir(old), true);
    assert.equal(runStartingFacts(old), null);
  } finally { h.cleanup(); }
});

test('watch waits for a starting run, prints one starting line, then attaches when state.json appears', async () => {
  const h = home();
  try {
    const runDir = startingRun(h.dir);
    setTimeout(() => writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(completedState())}\n`), 600);
    let output = '';
    const code = await runWorkflowWatch(h.dir, RUN_ID, {
      once: true, intervalMs: 50, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /legacy/);
    assert.equal(output.match(/starting/g)?.length, 1, output);
    assert.match(output, new RegExp(`watching ${RUN_ID} · starting`));
    assert.match(output, /workflow complete; result ready/);
  } finally { h.cleanup(); }
});

test('watch reports a starter that died without state.json plainly, with its kernel log, not as legacy', async () => {
  const h = home();
  try {
    startingRun(h.dir, { pid: DEAD_PID, stderr: 'Error: planner exploded\n' });
    let output = '';
    const code = await runWorkflowWatch(h.dir, RUN_ID, {
      intervalMs: 50, until: 'outcome', output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 1, output);
    assert.doesNotMatch(output, /legacy/);
    assert.match(output, new RegExp(`run ${RUN_ID} stopped before it started`));
    assert.match(output, /kernel log:\n {2}Error: planner exploded/);
  } finally { h.cleanup(); }
});

test('runs show and runs result on a starting run say it is starting, never legacy', () => {
  const h = home();
  try {
    startingRun(h.dir);
    for (const args of [['workflow', 'runs', 'show', RUN_ID], ['workflow', 'runs', 'result', RUN_ID]]) {
      const result = cli(h.dir, args);
      const printed = `${result.stdout}${result.stderr}`;
      assert.doesNotMatch(printed, /legacy/, `${args.join(' ')}\n${printed}`);
      assert.match(printed, /is starting/, `${args.join(' ')}\n${printed}`);
    }
    const json = cli(h.dir, ['workflow', 'runs', 'show', RUN_ID, '--json']);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.legacy, undefined);
    assert.equal(doc.starting, true);
  } finally { h.cleanup(); }
});

test('the run list and the dashboard show a starting run as starting, not legacy', () => {
  const h = home();
  try {
    startingRun(h.dir);
    const listed = listRuns(h.dir).find((run) => run.runId === RUN_ID);
    assert.equal(listed.legacy, false);
    assert.equal(listed.ongoing, true);
    const row = dashboardRows(h.dir, { all: true }).find((run) => run.runId === RUN_ID);
    assert.equal(row.legacy, false);
    assert.equal(row.status, 'starting');
    const details = renderDetails(row, { interactive: false });
    assert.doesNotMatch(details, /legacy/);
    assert.match(details, /is starting/);
    const list = cli(h.dir, ['workflow', 'runs']);
    assert.doesNotMatch(`${list.stdout}${list.stderr}`, /legacy/);
    assert.match(list.stdout, new RegExp(`${RUN_ID}.*starting`));
  } finally { h.cleanup(); }
});

test('the launch keeps waiting for state.json past 10 s while the child lives, and stops when it dies', async () => {
  const h = home();
  try {
    const runDir = join(h.dir, 'workflows', RUN_ID);
    mkdirSync(runDir, { recursive: true });
    // A fake clock: every sleep moves time on by its interval, and the
    // child publishes state.json 38 s after launch, as in the measured run.
    let clock = 0;
    const sleep = async (ms) => {
      clock += ms;
      if (clock >= 38_000) writeFileSync(join(runDir, 'state.json'), JSON.stringify({ shortId: 'stg234', lifecycle: { status: 'running' } }));
    };
    const state = await waitForRunState(RUN_ID, {
      bullswarmDir: h.dir, childAlive: () => true, now: () => clock, sleep,
    });
    assert.equal(state?.shortId, 'stg234');
    assert.ok(clock >= 38_000);

    // A child that dies ends the wait at once, with no state.
    rmSync(join(runDir, 'state.json'));
    clock = 0;
    let alive = true;
    const early = await waitForRunState(RUN_ID, {
      bullswarmDir: h.dir, childAlive: () => alive, now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock >= 2_000) alive = false; },
    });
    assert.equal(early, null);
    assert.ok(clock < 3_000, `waited ${clock} ms after the child died`);

    // The wait has an upper bound even while the child lives.
    clock = 0;
    const bounded = await waitForRunState(RUN_ID, {
      bullswarmDir: h.dir, childAlive: () => true, now: () => clock, limitMs: 60_000,
      sleep: async (ms) => { clock += ms; },
    });
    assert.equal(bounded, null);
    assert.ok(clock >= 60_000 && clock < 61_000, `stopped at ${clock} ms`);
  } finally { h.cleanup(); }
});
