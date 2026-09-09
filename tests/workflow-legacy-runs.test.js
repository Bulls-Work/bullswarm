// Legacy runs are read-only history.
//
// 0.27.0 removed the authored-graph executor. A run directory whose state.json
// lacks `schemaVersion: 'bullswarm.workflow.state.v2'` — or that has no
// state.json at all — is a legacy run: it lists as one row marked `legacy`,
// every driving verb refuses it with exactly one line and exit 2, `delete`
// still removes it, and nothing ever writes into it.
//
// The synthetic state below has the shape of a real one; the recorded example
// this was written from is `.build-inputs/legacy-run/state.json`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isLegacyRunState, isLegacyRunDir, legacyRunLine, listRuns, isOngoing } from '../src/workflow/short-id.js';
import { dashboardRows, dashboardJson, renderDashboard, renderDetails, requestCancel } from '../src/workflow/dashboard.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

const LEGACY_RUN_ID = 'wf-mt42x54k-100cf0';
const LEGACY_SHORT_ID = 'lgc234'.replace('l', 'k'); // Crockford: no 'l'
const V2_RUN_ID = 'wf-v2-neighbour';
const V2_SHORT_ID = 'v2n234';

function legacyState() {
  return {
    runId: LEGACY_RUN_ID,
    shortId: LEGACY_SHORT_ID,
    workflow: 'smoke-two-step',
    inputs: { targetDir: '.' },
    settings: { escalateOnFail: false, concurrency: 2 },
    outputs: {
      'step-one': { ok: false, pool: null, why: 'no eligible pool', outFile: '/tmp/out-step-one.md' },
      'step-two': { ok: false, pool: null, why: 'no eligible pool', outFile: '/tmp/out-step-two.md' },
    },
    steps: [
      { phase: 'first', stepId: 'step-one', type: 'run', ok: false, why: 'no eligible pool' },
      { phase: 'second', stepId: 'step-two', type: 'run', ok: false, why: 'no eligible pool' },
    ],
    startedAt: '2026-08-22T07:51:08.084Z',
    resumed: false,
    finishedAt: '2026-08-22T07:51:08.086Z',
    status: 'completed',
  };
}

function v2State() {
  const startedAt = '2026-08-31T01:00:00.000Z';
  const finishedAt = '2026-08-31T01:02:00.000Z';
  return {
    schemaVersion: 'bullswarm.workflow.state.v2',
    runId: V2_RUN_ID, shortId: V2_SHORT_ID, intentId: 'intent-v2-neighbour',
    intent: { goal: 'Prove the V2 neighbour still reads normally.' },
    lifecycle: { status: 'completed', startedAt, finishedAt, resultFile: null },
    ledger: { requirements: { 'requirement-1': { status: 'passed' } } },
    actions: [{ id: 'produce', status: 'succeeded' }, { id: 'prove', status: 'succeeded' }],
  };
}

function fixture({ orphan = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-legacy-'));
  const legacyDir = join(home, 'workflows', LEGACY_RUN_ID);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'state.json'), JSON.stringify(legacyState(), null, 2));
  const v2Dir = join(home, 'workflows', V2_RUN_ID);
  mkdirSync(v2Dir, { recursive: true });
  writeFileSync(join(v2Dir, 'state.json'), JSON.stringify(v2State()));
  // A pre-state.json run directory: only a workflow.json survives.
  let orphanDir = null;
  if (orphan) {
    orphanDir = join(home, 'workflows', 'wf-orphan-000001');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'workflow.json'), JSON.stringify({ name: 'ancient' }));
  }
  return { home, legacyDir, v2Dir, orphanDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function cli(home, args) {
  return spawnSync('node', [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// Everything written under the run directory, so a refusal can be proved to
// have created nothing.
function inventory(dir) {
  const out = [];
  const walk = (path, prefix) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      out.push(`${prefix}${name}`);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
    }
  };
  walk(dir, '');
  return out;
}

const LEGACY_LINE = (dir) =>
  `legacy authored-graph run ${LEGACY_SHORT_ID}: its executor was removed in 0.27.0; files remain under ${dir}`;

test('isLegacyRunState is true for an authored-graph state and false for a V2 one', () => {
  assert.equal(isLegacyRunState(legacyState()), true);
  assert.equal(isLegacyRunState(v2State()), false);
  // No state.json at all is legacy too; anything unreadable is not classified
  // here, because that is a torn read rather than a decision.
  assert.equal(isLegacyRunState(null), true);
  assert.equal(isLegacyRunState(undefined), true);
});

test('listRuns reads only the five read-only fields from a legacy run', () => {
  const f = fixture({ orphan: true });
  try {
    const runs = listRuns(f.home);
    const legacy = runs.find((run) => run.runId === LEGACY_RUN_ID);
    const orphan = runs.find((run) => run.runId === 'wf-orphan-000001');
    const v2 = runs.find((run) => run.runId === V2_RUN_ID);

    assert.equal(legacy.legacy, true);
    assert.equal(legacy.ongoing, false);
    assert.equal(legacy.dir, f.legacyDir);
    assert.equal(legacy.runDir, f.legacyDir);
    assert.deepEqual(legacy.state, {
      status: 'completed',
      startedAt: '2026-08-22T07:51:08.084Z',
      finishedAt: '2026-08-22T07:51:08.086Z',
      name: 'smoke-two-step',
      goal: null,
    });
    // A directory with no state.json is legacy and never throws.
    assert.equal(orphan.legacy, true);
    assert.deepEqual(orphan.state, { status: null, startedAt: null, finishedAt: null, name: null, goal: null });

    assert.equal(v2.legacy, false);
    assert.equal(v2.state.schemaVersion, 'bullswarm.workflow.state.v2');
    assert.equal(isOngoing(f.legacyDir, legacy.state), false);
    assert.equal(isLegacyRunDir(f.legacyDir), true);
    assert.equal(isLegacyRunDir(f.v2Dir), false);
  } finally { f.cleanup(); }
});

test('runs list marks the legacy row and leaves the V2 row alone', () => {
  const f = fixture();
  try {
    const human = cli(f.home, ['workflow', 'runs', '--all']);
    assert.equal(human.status, 0, human.stderr);
    const legacyRow = human.stdout.split('\n').find((line) => line.includes(LEGACY_RUN_ID));
    assert.ok(legacyRow, human.stdout);
    assert.match(legacyRow, new RegExp(LEGACY_SHORT_ID));
    assert.match(legacyRow, /smoke-two-step/);
    assert.match(legacyRow, /completed/);
    assert.match(legacyRow, /\d+d ago/);
    assert.match(legacyRow, /legacy$/);
    // Nothing about steps or actions is claimed for a legacy run.
    assert.doesNotMatch(legacyRow, /steps|actions/);

    const v2Row = human.stdout.split('\n').find((line) => line.includes(V2_RUN_ID));
    assert.match(v2Row, /2\/2 actions/);
    assert.doesNotMatch(v2Row, /legacy/);

    const json = JSON.parse(cli(f.home, ['workflow', 'runs', '--all', '--json']).stdout);
    assert.equal(json.count, 2);
    const legacy = json.runs.find((run) => run.runId === LEGACY_RUN_ID);
    assert.deepEqual(legacy, {
      runId: LEGACY_RUN_ID, shortId: LEGACY_SHORT_ID, legacy: true, dir: f.legacyDir,
      workflow: 'smoke-two-step', goal: null, status: 'completed',
      startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:51:08.086Z',
      ongoing: false,
    });
    assert.equal(json.runs.find((run) => run.runId === V2_RUN_ID).legacy, false);

    // The default (ongoing-only) view never claims a legacy run is running.
    const ongoing = cli(f.home, ['workflow', 'runs']);
    assert.equal(ongoing.status, 0, ongoing.stderr);
    assert.doesNotMatch(ongoing.stdout, new RegExp(LEGACY_RUN_ID));
  } finally { f.cleanup(); }
});

test('every driving verb refuses a legacy run with one line, exit 2, and no writes', () => {
  const f = fixture();
  try {
    const before = inventory(f.legacyDir);
    const line = LEGACY_LINE(f.legacyDir);
    const commands = [
      ['workflow', 'runs', 'show', LEGACY_SHORT_ID],
      ['workflow', 'runs', 'result', LEGACY_SHORT_ID],
      ['workflow', 'watch', LEGACY_SHORT_ID],
      ['workflow', 'cancel', LEGACY_SHORT_ID],
      ['workflow', 'resume', LEGACY_SHORT_ID],
      ['workflow', 'steer', LEGACY_SHORT_ID, 'do something else'],
      ['workflow', 'action', 'show', LEGACY_SHORT_ID, 'step-one'],
      ['workflow', 'tui', LEGACY_SHORT_ID],
    ];
    for (const argv of commands) {
      const result = cli(f.home, argv);
      const printed = `${result.stdout}${result.stderr}`.trim();
      assert.equal(result.status, 2, `${argv.join(' ')}: exit ${result.status}\n${printed}`);
      assert.equal(printed, line, `${argv.join(' ')} printed:\n${printed}`);
      assert.deepEqual(inventory(f.legacyDir), before, `${argv.join(' ')} wrote into the run directory`);
    }
  } finally { f.cleanup(); }
});

// watch resolves its run through a grace window (a freshly launched detached
// run may not have written state.json yet), so it used to report the missing
// file and exit 1 on the 80-odd pre-0.27.0 directories that hold only a
// workflow.json. The legacy guard decides first now, whether the directory
// carries a V1 state.json or no state.json at all.
test('watch refuses a legacy run with the same one line and exit 2 with or without a state.json', () => {
  const f = fixture({ orphan: true });
  try {
    const beforeLegacy = inventory(f.legacyDir);
    const beforeOrphan = inventory(f.orphanDir);
    assert.deepEqual(beforeOrphan, ['workflow.json']);

    // (a) a legacy directory whose state.json is an authored-graph state.
    const withState = cli(f.home, ['workflow', 'watch', LEGACY_SHORT_ID]);
    const withStatePrinted = `${withState.stdout}${withState.stderr}`.trim();
    assert.equal(withState.status, 2, `exit ${withState.status}\n${withStatePrinted}`);
    assert.equal(withStatePrinted, LEGACY_LINE(f.legacyDir));
    assert.deepEqual(inventory(f.legacyDir), beforeLegacy, 'watch wrote into the legacy run directory');

    // (b) a legacy directory with no state.json at all — the line names the
    // runId, because such a directory never recorded a shortId.
    const withoutState = cli(f.home, ['workflow', 'watch', 'wf-orphan-000001']);
    const withoutStatePrinted = `${withoutState.stdout}${withoutState.stderr}`.trim();
    assert.equal(withoutState.status, 2, `exit ${withoutState.status}\n${withoutStatePrinted}`);
    assert.equal(
      withoutStatePrinted,
      legacyRunLine({ shortId: null, runId: 'wf-orphan-000001', runDir: f.orphanDir }),
    );
    assert.doesNotMatch(withoutStatePrinted, /has no state\.json/);
    assert.deepEqual(inventory(f.orphanDir), beforeOrphan, 'watch wrote into the state-less run directory');

    // A token that resolves to nothing is still a different failure.
    const missing = cli(f.home, ['workflow', 'watch', 'wf-absent-000001']);
    assert.equal(missing.status, 1);
    assert.match(`${missing.stdout}${missing.stderr}`, /no run found for "wf-absent-000001"/);
  } finally { f.cleanup(); }
});

test('--json refusals carry the machine form and still exit 2', () => {
  const f = fixture();
  try {
    const expected = {
      legacy: true, runId: LEGACY_RUN_ID, shortId: LEGACY_SHORT_ID,
      dir: f.legacyDir, message: LEGACY_LINE(f.legacyDir),
    };
    for (const argv of [
      ['workflow', 'runs', 'show', LEGACY_SHORT_ID, '--json'],
      ['workflow', 'runs', 'result', LEGACY_SHORT_ID, '--json'],
      ['workflow', 'cancel', LEGACY_SHORT_ID, '--json'],
      ['workflow', 'tui', LEGACY_SHORT_ID, '--json'],
      ['workflow', 'action', 'show', LEGACY_SHORT_ID, 'step-one', '--json'],
      ['workflow', 'steer', LEGACY_SHORT_ID, 'stop', '--json'],
      ['workflow', 'resume', LEGACY_SHORT_ID, '--json'],
    ]) {
      const result = cli(f.home, argv);
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), expected, argv.join(' '));
    }
  } finally { f.cleanup(); }
});

test('events still replays a legacy run\'s durable JSONL when one is present', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.legacyDir, 'events.jsonl'),
      `${JSON.stringify({ sequence: 1, type: 'run.started', committedAt: '2026-08-22T07:51:08.084Z', payload: {} })}\n`);
    const result = cli(f.home, ['workflow', 'events', LEGACY_SHORT_ID]);
    assert.equal(result.status, 0, result.stderr);
    const replayed = JSON.parse(result.stdout);
    assert.equal(replayed.count, 1);
    assert.equal(replayed.events[0].type, 'run.started');
  } finally { f.cleanup(); }
});

test('the workflow home lists a legacy row and shows the one line in its detail pane', () => {
  const f = fixture();
  try {
    const rows = dashboardRows(f.home, { all: true });
    const legacy = rows.find((row) => row.runId === LEGACY_RUN_ID);
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.status, 'completed');
    assert.deepEqual(legacy.activeAgents, []);

    const screen = renderDashboard({ rows, allRows: rows, selected: rows.indexOf(legacy), previewRow: legacy, filter: 'all', width: 120, height: 30 });
    assert.match(screen, new RegExp(`${LEGACY_SHORT_ID} · smoke-two-step`));
    assert.match(screen, /legacy/);
    assert.match(screen.replace(/\s+/g, ' '), /legacy authored-graph run/);

    const detail = renderDetails(legacy, { interactive: false }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.equal(detail.trim(), LEGACY_LINE(f.legacyDir));

    const shown = dashboardJson(f.home, { token: LEGACY_SHORT_ID });
    assert.deepEqual(shown, {
      action: 'show', legacy: true, runId: LEGACY_RUN_ID, shortId: LEGACY_SHORT_ID,
      dir: f.legacyDir, message: LEGACY_LINE(f.legacyDir),
    });

    // requestCancel neither writes nor pretends the run can be stopped.
    const before = inventory(f.legacyDir);
    const cancelled = requestCancel(f.home, LEGACY_SHORT_ID);
    assert.equal(cancelled.legacy, true);
    assert.deepEqual(inventory(f.legacyDir), before);

    // The V2 neighbour still renders normally next to it.
    const v2 = rows.find((row) => row.runId === V2_RUN_ID);
    assert.equal(v2.legacy, undefined === v2.legacy ? undefined : false);
    assert.equal(dashboardJson(f.home, { token: V2_SHORT_ID }).state.schemaVersion, 'bullswarm.workflow.state.v2');
  } finally { f.cleanup(); }
});

test('the V2 neighbour still shows and reports normally', () => {
  const f = fixture();
  try {
    const shown = cli(f.home, ['workflow', 'runs', 'show', V2_SHORT_ID]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /# goal  Prove the V2 neighbour still reads normally\./);
    assert.match(shown.stdout, /# actions  2\/2 succeeded/);
  } finally { f.cleanup(); }
});

test('runs delete still removes a legacy run directory', () => {
  const f = fixture({ orphan: true });
  try {
    const refuse = cli(f.home, ['workflow', 'runs', 'delete', LEGACY_SHORT_ID]);
    assert.notEqual(refuse.status, 0);
    assert.match(`${refuse.stdout}${refuse.stderr}`, /without --yes/);
    assert.equal(existsSync(f.legacyDir), true);

    const deleted = cli(f.home, ['workflow', 'runs', 'delete', LEGACY_SHORT_ID, '--yes']);
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.equal(existsSync(f.legacyDir), false);
    // The neighbours are untouched.
    assert.equal(existsSync(f.v2Dir), true);
    assert.equal(existsSync(f.orphanDir), true);

    const orphanDeleted = cli(f.home, ['workflow', 'runs', 'delete', 'wf-orphan-000001', '--yes']);
    assert.equal(orphanDeleted.status, 0, orphanDeleted.stderr);
    assert.equal(existsSync(f.orphanDir), false);
  } finally { f.cleanup(); }
});

test('legacyRunLine falls back to the runId when a legacy run recorded no shortId', () => {
  assert.equal(
    legacyRunLine({ shortId: null, runId: 'wf-old-1', runDir: '/tmp/wf-old-1' }),
    'legacy authored-graph run wf-old-1: its executor was removed in 0.27.0; files remain under /tmp/wf-old-1',
  );
});
