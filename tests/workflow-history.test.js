// The History page's day rollup (src/workflow/history.js).
//
// Doctrine under test:
//   H1. The day boundary is the reader's own local zone, resolved at call
//       time — never a hard-coded zone and never UTC-as-local.
//   H2. `runs` counts the runs a day started; `finished` counts the runs it
//       finished. Verified counts and spend attach to the finish day.
//   H3. Spend is never invented: a day where no run recorded an estimate is
//       null, not 0. The same for verifiedShare on a day with no finishes.
//   H4. Scroll-back is consecutive-day and stops at the oldest run on record.
//   H5. A run with no finish time is still filed where it started, so it is
//       visible rather than absent.
//   H6. The index holds the runs that finished; the runs still in flight are
//       read from their own directories, and only for the directories the
//       index does not already name. listRuns is never called — it parses
//       every state.json (293 files, ~100 ms) against a 1 s refresh.
//   H7. The counts a day hands the page are truthful: `rows` is every
//       workflow filed there, `legacyRows` and `unfinishedRows` count what a
//       row is, and nothing is counted twice.
//
// Every fixture builds its own home with mkdtempSync; nothing needs the
// network and nothing reads the developer's real ~/.bullswarm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dayKey, historyDays } from '../src/workflow/history.js';
import { historyLines, historyNote } from '../src/workflow/history-view.js';
import { appendRollupIndex, ROLLUP_SCHEMA_VERSION } from '../src/workflow/rollup.js';

// The row marks are asserted in their unicode form, so pin the glyph table:
// it otherwise follows the developer's terminal and would fall back to ascii
// when the suite runs inside Apple Terminal.
process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const REPO = resolve(new URL('..', import.meta.url).pathname);

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-history-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A local time on a given calendar day, so the fixture lands on that day in
// whatever zone the machine running the suite happens to use.
function localNoon(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

let sequence = 0;
function record(dir, { startedAt, finishedAt, verified = false, costUsd = null, project = 'bullswarm', status = 'completed' }) {
  sequence += 1;
  const runId = `wf-day${String(sequence).padStart(4, '0')}-000000`;
  appendRollupIndex(dir, {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId, shortId: `hs${String(sequence).padStart(4, '0')}`, project,
    goal: 'fixture', cwd: '/repo', startedAt, finishedAt, status, verified,
    requirements: { passed: verified ? 1 : 0, total: 1 },
    minutes: { wall: 10, agent: 9 },
    pools: { codex: { attempts: 1, minutes: 9, costUsd, tokens: 100 } },
    models: { 'gpt-5.6-luna': { attempts: 1, minutes: 9 } },
    legacy: false,
  });
  return runId;
}

// A run directory on disk, the shape every run surface reads: state.json for a
// V2 run, report.json for a legacy one, result.json when it delivered.
let runSequence = 0;
function runDir(dir, { runId = null, state = null, report = null, result = null, project = null } = {}) {
  runSequence += 1;
  const id = runId ?? `wf-fixture${String(runSequence).padStart(4, '0')}-000000`;
  const at = join(dir, 'workflows', id);
  mkdirSync(at, { recursive: true });
  if (state) writeFileSync(join(at, 'state.json'), JSON.stringify(state));
  if (report) writeFileSync(join(at, 'report.json'), JSON.stringify(report));
  if (result) writeFileSync(join(at, 'result.json'), JSON.stringify(result));
  if (project) writeFileSync(join(at, 'project.json'), JSON.stringify({
    schemaVersion: 'bullswarm.workflow.project.v1', name: project,
    remote: null, toplevel: null, cwd: null, recordedAt: localNoon(2026, 9, 16, 12),
  }));
  return { runId: id, runDir: at, statePath: join(at, 'state.json') };
}

function v2State({
  runId, shortId = null, goal = 'a fixture goal', status = 'running',
  startedAt, finishedAt = null, runner = null,
  attempts = [], seconds = null, ledger = null,
} = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.state.v2',
    runId, shortId, intentId: `intent-${runId}`,
    intent: { goal, cwd: '/repo', requirements: [] },
    lifecycle: { status, startedAt, finishedAt },
    budget: { seconds },
    ledger: ledger ?? { requirements: {} },
    attempts,
    actions: [],
    ...(runner ? { runner } : {}),
  };
}

// A live kernel: this process is the pid the run heartbeats with, and the beat
// is now, so isOngoing() answers the same way it does for a real run.
const liveRunner = () => ({ pid: process.pid, startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString() });

// --- H1: the zone -----------------------------------------------------

test('H1: dayKey is YYYY-MM-DD in the resolved local zone, not UTC', () => {
  const instant = '2026-09-16T13:30:00.000Z';
  const script = 'import { dayKey } from "./src/workflow/history.js";'
    + ` process.stdout.write(dayKey(${JSON.stringify(instant)}) + " " + Intl.DateTimeFormat().resolvedOptions().timeZone);`;
  const at = (tz) => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO, encoding: 'utf8', env: { ...process.env, TZ: tz },
    });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.split(' ');
  };
  // 13:30 UTC is 03:30 the next day in Kiritimati (UTC+14) and 02:30 the
  // same day in Niue (UTC-11).
  const [aheadKey, aheadZone] = at('Pacific/Kiritimati');
  const [behindKey, behindZone] = at('Pacific/Niue');
  assert.equal(aheadZone, 'Pacific/Kiritimati', 'the zone must be resolved, not assumed');
  assert.equal(behindZone, 'Pacific/Niue');
  assert.equal(aheadKey, '2026-09-17');
  assert.equal(behindKey, '2026-09-16');
  assert.notEqual(aheadKey, behindKey, 'a hard-coded zone would give the same answer twice');
});

test('H1: dayKey accepts an ISO string, epoch ms and a Date, and refuses anything else', () => {
  const ms = Date.parse('2026-09-16T13:30:00.000Z');
  assert.equal(dayKey('2026-09-16T13:30:00.000Z'), dayKey(ms));
  assert.equal(dayKey(new Date(ms)), dayKey(ms));
  assert.match(dayKey(ms), /^\d{4}-\d{2}-\d{2}$/);
  for (const bad of [null, undefined, '', 'not a date', Number.NaN, {}]) {
    assert.equal(dayKey(bad), null, `dayKey(${JSON.stringify(bad)})`);
  }
});

// --- H2/H3: the rows --------------------------------------------------

test('H2: runs count the day that started them, finished counts the day that delivered them', () => {
  const h = home();
  try {
    // One run crosses midnight: started 23:50 on the 15th, finished 00:30 on
    // the 16th, local time.
    record(h.dir, { startedAt: localNoon(2026, 9, 15, 23), finishedAt: localNoon(2026, 9, 16, 0), verified: true, costUsd: 1.5 });
    record(h.dir, { startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10), verified: false, costUsd: 0.5 });

    const rows = historyDays(h.dir, { days: 3, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    assert.deepEqual(rows.map((row) => row.date), ['2026-09-16', '2026-09-15']);
    const [today, yesterday] = rows;
    assert.equal(today.runs, 1, 'only one run started on the 16th');
    assert.equal(today.finished, 2, 'both runs finished on the 16th');
    assert.equal(today.verified, 1);
    assert.equal(today.verifiedShare, 0.5);
    assert.equal(today.spendUsd, 2);
    assert.equal(yesterday.runs, 1, 'the crossing run started on the 15th');
    assert.equal(yesterday.finished, 0);
    assert.equal(yesterday.verifiedShare, null, 'no finished run that day → no share, not 0%');
    assert.equal(yesterday.spendUsd, null, 'nothing finished that day → no spend, not $0');
  } finally { h.cleanup(); }
});

test('H3: a day whose runs recorded no cost estimate reports null spend, not zero', () => {
  const h = home();
  try {
    record(h.dir, { startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10), verified: true, costUsd: null });
    const [today] = historyDays(h.dir, { days: 1, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    assert.equal(today.finished, 1);
    assert.equal(today.verified, 1);
    assert.equal(today.verifiedShare, 1);
    assert.equal(today.spendUsd, null);
  } finally { h.cleanup(); }
});

// --- H4: scroll-back ---------------------------------------------------

test('H4: days are consecutive, newest first, including days with no runs', () => {
  const h = home();
  try {
    record(h.dir, { startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10) });
    record(h.dir, { startedAt: localNoon(2026, 9, 13, 9), finishedAt: localNoon(2026, 9, 13, 10) });
    const rows = historyDays(h.dir, { days: 7, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    assert.deepEqual(rows.map((row) => row.date), ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-13']);
    assert.deepEqual(rows.map((row) => row.finished), [1, 0, 0, 1]);
    assert.equal(rows.at(-1).date, '2026-09-13', 'H4: scroll-back stops at the oldest run on record');
  } finally { h.cleanup(); }
});

test('H4: `before` returns the days strictly before it, which is how the page pages', () => {
  const h = home();
  try {
    for (const day of [16, 15, 14, 13, 12, 11, 10]) {
      record(h.dir, { startedAt: localNoon(2026, 9, day, 9), finishedAt: localNoon(2026, 9, day, 10) });
    }
    const now = Date.parse(localNoon(2026, 9, 16, 20));
    const first = historyDays(h.dir, { days: 3, now });
    assert.deepEqual(first.map((row) => row.date), ['2026-09-16', '2026-09-15', '2026-09-14']);
    const second = historyDays(h.dir, { before: first.at(-1).date, days: 3, now });
    assert.deepEqual(second.map((row) => row.date), ['2026-09-13', '2026-09-12', '2026-09-11']);
    const third = historyDays(h.dir, { before: second.at(-1).date, days: 3, now });
    assert.deepEqual(third.map((row) => row.date), ['2026-09-10'], 'the last page is short, not padded');
    assert.deepEqual(historyDays(h.dir, { before: '2026-09-10', days: 3, now }), [], 'paging past the oldest run ends');
  } finally { h.cleanup(); }
});

test('H4: a home with no rollups at all returns no rows rather than inventing empty days', () => {
  const h = home();
  try {
    assert.deepEqual(historyDays(h.dir, { days: 7 }), []);
    assert.deepEqual(historyDays(join(h.dir, 'does-not-exist'), { days: 7 }), []);
  } finally { h.cleanup(); }
});

// --- H5: it reads the index ------------------------------------------

test('H6: the index alone carries a finished run — no run directory has to exist', () => {
  const h = home();
  try {
    record(h.dir, { startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10), verified: true, costUsd: 0.25 });
    // No workflows/<runId>/ directory exists at all: listRuns would return [].
    const [today] = historyDays(h.dir, { days: 1, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    assert.deepEqual({ ...today, rows: undefined }, {
      date: '2026-09-16', runs: 1, finished: 1, verified: 1, verifiedShare: 1, spendUsd: 0.25,
      legacyRows: 0, unfinishedRows: 0, rows: undefined,
    });
    // H5: the day carries its own record, so the page never rejoins the index.
    assert.equal(today.rows.length, 1);
    assert.equal(today.rows[0].pools.codex.costUsd, 0.25);
  } finally { h.cleanup(); }
});

test('H6: history.js never calls listRuns, and asks the run directories only where the index is silent', () => {
  // Comment lines are stripped: the header explains WHY listRuns is banned
  // here, and naming it in prose must not trip the guard.
  const source = readFileSync(join(REPO, 'src', 'workflow', 'history.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /listRuns\s*\(/, 'History must never parse every state.json');
  assert.doesNotMatch(source, /withV2Cancellation|v2RunnerLiveness/, 'History asks one question per directory, not liveness policy');
  // The one thing it does take from the run module is the verdicts themselves.
  assert.match(source, /import \{[^}]*isOngoing[^}]*\} from '\.\/short-id\.js'/, 'the liveness verdict must be the run module\'s');
  assert.match(source, /indexedIds\.has\(name\)/, 'a directory the index names is skipped, never re-read');
  assert.match(source, /from '\.\/rollup\.js'/, 'the index is the steady-state source');
});

test('H5: a run directory holding a rollup is still reachable when the index is empty', () => {
  const h = home();
  try {
    const runDir = join(h.dir, 'workflows', 'wf-direct-000000');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'rollup.json'), JSON.stringify({
      schemaVersion: ROLLUP_SCHEMA_VERSION, runId: 'wf-direct-000000', shortId: 'direct',
      project: 'bullswarm', goal: 'fixture', cwd: '/repo',
      startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10),
      status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
      minutes: { wall: 60, agent: 55 }, pools: {}, models: {}, legacy: false,
    }));
    const [today] = historyDays(h.dir, { days: 1, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    assert.equal(today.date, '2026-09-16');
    assert.equal(today.finished, 1);
    assert.equal(today.verified, 1);
    assert.equal(today.spendUsd, null, 'a record with no pool costs has no spend to report');
  } finally { h.cleanup(); }
});

// --- H6/H7: every workflow, including the ones with no record ---------
//
// The home the release has to draw: one run the index carries, a finished run
// the index has not been told about yet, a partial run, a legacy directory
// with only a report.json, a legacy directory with only a state.json, a run
// whose kernel is alive and one whose kernel died before it delivered.

const NOW = Date.parse(localNoon(2026, 9, 16, 18));

function everyWorkflowHome() {
  const h = home();
  // 1. Indexed finished run, with a cost.
  const indexedRunId = record(h.dir, {
    startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10),
    verified: true, costUsd: 0.25,
  });
  // 2. Finished run the index does not carry: it must still be on the timeline,
  //    with the cost its own attempts recorded.
  runDir(h.dir, {
    runId: 'wf-unindexed-000001', project: 'project-a',
    state: v2State({
      runId: 'wf-unindexed-000001', shortId: 'unindx', goal: 'finished, not yet indexed',
      status: 'completed', startedAt: localNoon(2026, 9, 16, 11), finishedAt: localNoon(2026, 9, 16, 11, 30),
      seconds: 1800,
      attempts: [{ id: 'a1', actionId: 'build', pool: 'codex', model: 'gpt-5.6-luna', status: 'succeeded', wallSec: 1800, usage: { cost: { estimatedUsd: 0.05 }, tokens: { totalKnown: 100 } } }],
    }),
  });
  // 3. Legacy directory: report.json only, no state.json at all.
  runDir(h.dir, {
    runId: 'wf-legacy-000001',
    report: {
      schemaVersion: 'bullswarm.workflow.report.v1', runId: 'wf-legacy-000001',
      workflow: 'smoke-two-step', status: 'completed',
      startedAt: localNoon(2026, 9, 15, 9), finishedAt: localNoon(2026, 9, 15, 9, 2),
    },
  });
  // 4. Legacy directory: state.json only, which is all it kept.
  runDir(h.dir, {
    runId: 'wf-legacy-000002',
    state: { status: 'completed', name: 'connector-audit', startedAt: localNoon(2026, 9, 14, 9), finishedAt: localNoon(2026, 9, 14, 9, 5) },
  });
  // 5. Partial run: the kernel calls it terminal, so the timeline files it as
  //    a finished run with that status word.
  runDir(h.dir, {
    runId: 'wf-partial-000001',
    state: v2State({
      runId: 'wf-partial-000001', shortId: 'part01', goal: 'delivered part of the work',
      status: 'partial', startedAt: localNoon(2026, 9, 16, 12), finishedAt: localNoon(2026, 9, 16, 12, 20),
    }),
  });
  // 6. In flight: a live kernel owns it and it has no finish time.
  runDir(h.dir, {
    runId: 'wf-running-000001', project: 'bullswarm',
    state: v2State({
      runId: 'wf-running-000001', shortId: 'run101', goal: 'still going',
      status: 'running', startedAt: localNoon(2026, 9, 16, 13), runner: liveRunner(),
    }),
  });
  // 7. Stopped: the state still says running, the kernel is gone, and the last
  //    write is pinned so the measured interval is exact.
  const stopped = runDir(h.dir, {
    runId: 'wf-stopped-000001',
    state: v2State({
      runId: 'wf-stopped-000001', shortId: 'stop01', goal: 'died before it delivered',
      status: 'running', startedAt: localNoon(2026, 9, 15, 8),
      runner: { pid: 999_999, lastHeartbeatAt: localNoon(2026, 9, 15, 8, 20) },
    }),
  });
  const lastWrite = new Date(Date.parse(localNoon(2026, 9, 15, 8, 30)));
  utimesSync(stopped.statePath, lastWrite, lastWrite);
  return { ...h, indexedRunId };
}

test('H6: a finished run with no index entry and no goal-project file is named by its working directory', () => {
  // Requirement 3: `workflow reindex` derives the project from the run's
  // goal.json `intent.cwd` (`src/lib/project.js`); a finished run the index
  // has not caught up with must read the same way, never `unknown project`.
  // `unknown project` remains only when no cwd is recorded.
  const h = home();
  try {
    // A real git checkout so projectName() has an origin to name.
    const repo = mkdtempSync(join(tmpdir(), 'bs-project-'));
    const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init']);
    git(['remote', 'add', 'origin', 'https://github.com/Bulls-Work/bullswarm-handoff.git']);
    // The run: goal.json records a cwd, no goal-project.json, no rollup.
    runDir(h.dir, {
      runId: 'wf-goal-cwd-000001',
      state: { ...v2State({
        runId: 'wf-goal-cwd-000001', shortId: 'cwd001', goal: 'finished, never reindexed',
        status: 'completed', startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 9, 10),
      }), intent: { goal: 'finished, never reindexed', cwd: repo, requirements: [] } },
    });
    // And a twin with no cwd anywhere: it keeps `unknown project`.
    runDir(h.dir, {
      runId: 'wf-no-cwd-000001',
      state: { ...v2State({
        runId: 'wf-no-cwd-000001', shortId: 'nocwd1', goal: 'no cwd on record',
        status: 'completed', startedAt: localNoon(2026, 9, 16, 10), finishedAt: localNoon(2026, 9, 16, 10, 5),
      }), intent: { goal: 'no cwd on record', cwd: null, requirements: [] } },
    });
    const [today] = historyDays(h.dir, { days: 1, now: Date.parse(localNoon(2026, 9, 16, 20)) });
    const withCwd = today.rows.find((row) => row.runId === 'wf-goal-cwd-000001');
    assert.equal(withCwd.project, 'bullswarm-handoff', 'the cwd derives the same name reindex writes');
    const noCwd = today.rows.find((row) => row.runId === 'wf-no-cwd-000001');
    assert.equal(noCwd.project, null, 'no working directory, no invented project');
    // And the page text agrees: the row is named, the blank stays blank.
    const text = historyLines([today], { width: 100, ansi: false }).lines.join('\n');
    assert.match(text, /bullswarm-handoff/);
    assert.match(text, /unknown project/);
  } finally { h.cleanup(); }
});

test('H6: the timeline holds every workflow — indexed, un-indexed, partial, legacy, running and stopped', () => {
  const h = everyWorkflowHome();
  try {
    const days = historyDays(h.dir, { days: 3, now: NOW });
    assert.deepEqual(days.map((day) => day.date), ['2026-09-16', '2026-09-15', '2026-09-14']);

    const [today, yesterday, older] = days;
    // H7: the counts are the rows themselves, and the two kinds are separate.
    assert.deepEqual(
      { rows: today.rows.length, runs: today.runs, finished: today.finished, legacy: today.legacyRows, unfinished: today.unfinishedRows },
      { rows: 4, runs: 4, finished: 3, legacy: 0, unfinished: 1 },
      'today: the indexed run, the un-indexed finished run, the partial run, the live one',
    );
    assert.deepEqual(
      { rows: yesterday.rows.length, runs: yesterday.runs, finished: yesterday.finished, legacy: yesterday.legacyRows, unfinished: yesterday.unfinishedRows },
      { rows: 2, runs: 2, finished: 1, legacy: 1, unfinished: 1 },
      'yesterday: one legacy finish and the run whose kernel died',
    );
    assert.deepEqual(
      { rows: older.rows.length, legacy: older.legacyRows, unfinished: older.unfinishedRows },
      { rows: 1, legacy: 1, unfinished: 0 },
    );

    const rows = days.flatMap((day) => day.rows);
    assert.deepEqual(rows.map((row) => row.runId).sort(), [
      h.indexedRunId, 'wf-legacy-000001', 'wf-legacy-000002', 'wf-partial-000001',
      'wf-running-000001', 'wf-stopped-000001', 'wf-unindexed-000001',
    ].sort(), 'every workflow exactly once: nothing dropped, nothing double-counted');
    assert.equal(rows.length, 7);

    // A finished run the index had not been told about is a finished record,
    // measured the same way reindex would have measured it.
    const unindexed = rows.find((row) => row.runId === 'wf-unindexed-000001');
    assert.equal(unindexed.status, 'completed');
    assert.equal(unindexed.project, 'project-a', 'the project the run recorded at goal time');
    assert.equal(unindexed.unfinished, undefined);
    assert.equal(unindexed.pools.codex.costUsd, 0.05);
    assert.equal(unindexed.minutes.wall, 30);

    // The partial run is terminal, and says so.
    const partial = rows.find((row) => row.runId === 'wf-partial-000001');
    assert.equal(partial.status, 'partial', 'the status the kernel finished it with');
    assert.equal(partial.unfinished, undefined, 'a partial run has finished: it is not in flight');
    assert.equal(today.rows.includes(partial), true);

    // In flight: filed under the day it started, with the interval measured
    // from its own start to the instant the model was asked for.
    const running = rows.find((row) => row.runId === 'wf-running-000001');
    assert.equal(running.unfinished, true);
    assert.equal(running.running, true);
    assert.equal(running.elapsedMinutes, 300, '13:00 to 18:00');
    assert.equal(running.lastWriteAt, null);
    assert.equal(today.rows.includes(running), true);

    // Stopped: no kernel, so no claim that it is still going — and the
    // interval is its start to its last write, not to now.
    const stopped = rows.find((row) => row.runId === 'wf-stopped-000001');
    assert.equal(stopped.unfinished, true);
    assert.equal(stopped.running, false);
    assert.equal(stopped.elapsedMinutes, 30, '08:00 to the pinned 08:30 write');
    assert.equal(stopped.lastWriteAt, new Date(Date.parse(localNoon(2026, 9, 15, 8, 30))).toISOString());

    // Legacy: what the directory proves, and nothing it does not.
    const legacyReport = rows.find((row) => row.runId === 'wf-legacy-000001');
    assert.deepEqual(
      { legacy: legacyReport.legacy, goal: legacyReport.goal, status: legacyReport.status, wall: legacyReport.minutes.wall, timeSource: legacyReport.timeSource },
      { legacy: true, goal: 'smoke-two-step', status: 'completed', wall: 2, timeSource: 'report' },
    );
    assert.deepEqual(legacyReport.pools, {}, 'no attempt was ever measured for a legacy run');
    assert.deepEqual(legacyReport.models, {});
    assert.equal(legacyReport.minutes.agent, null);
    assert.deepEqual(legacyReport.requirements, { passed: 0, total: 0 });
    assert.equal(legacyReport.verified, false);
    const legacyState = rows.find((row) => row.runId === 'wf-legacy-000002');
    assert.equal(legacyState.goal, 'connector-audit');
    assert.equal(legacyState.minutes.wall, 5);
  } finally { h.cleanup(); }
});

test('H3/H7: a day of legacy and unfinished rows reports no spend rather than a zero', () => {
  const h = everyWorkflowHome();
  try {
    const [today, yesterday, older] = historyDays(h.dir, { days: 3, now: NOW });
    assert.equal(today.spendUsd, 0.3, 'the indexed 0.25 plus the un-indexed run\'s recorded 0.05');
    assert.equal(today.verifiedShare, 0.3333, 'one of the three finished runs recorded a verified verdict');
    assert.equal(yesterday.spendUsd, null, 'a legacy finish carries no cost and an unfinished run has none yet');
    assert.equal(yesterday.verifiedShare, 0, 'the legacy finish recorded no verdict, and that is a measured 0 of 1');
    assert.equal(older.spendUsd, null);
  } finally { h.cleanup(); }
});

test('H6: a directory the index already names is never opened', () => {
  const h = home();
  try {
    const runId = record(h.dir, {
      startedAt: localNoon(2026, 9, 16, 9), finishedAt: localNoon(2026, 9, 16, 10), verified: true, costUsd: 0.25,
    });
    // The same runId on disk, with a state.json nothing can parse: a reader
    // that opened it would have to guess. The index answers, so it does not.
    const at = runDir(h.dir, { runId });
    writeFileSync(at.statePath, '{"torn":');
    const [today] = historyDays(h.dir, { days: 1, now: NOW });
    assert.equal(today.rows.length, 1, 'the indexed record, and nothing manufactured from the torn file');
    assert.equal(today.rows[0].runId, runId);
    assert.equal(today.rows[0].pools.codex.costUsd, 0.25);
  } finally { h.cleanup(); }
});

test('H5/H6: a run with no readable start is not dated from the clock, and paints no blank unit', () => {
  const h = home();
  try {
    runDir(h.dir, {
      runId: 'wf-nostart-000001',
      state: v2State({ runId: 'wf-nostart-000001', shortId: 'nostrt', status: 'running', startedAt: null, runner: liveRunner() }),
    });
    // Nothing dates this run — no start, no finish — so no day may claim it:
    // filing it under "today" would be the clock inventing a start.
    assert.deepEqual(historyDays(h.dir, { days: 1, now: NOW }), []);
    // The page still never prints a bare unit where the number would go.
    const day = {
      date: '2026-09-16', runs: 1, finished: 0, verified: 0, verifiedShare: null, spendUsd: null,
      legacyRows: 0, unfinishedRows: 1,
      rows: [{ runId: 'wf-nostart-000001', shortId: 'nostrt', project: 'bullswarm', goal: 'no start recorded', startedAt: null, unfinished: true, running: true, elapsedMinutes: null, lastWriteAt: null }],
    };
    const text = historyLines([day], { width: 120, ansi: false }).lines.join('\n');
    assert.match(text, /● nostrt\s+bullswarm\s+running · elapsed unavailable · no result yet/);
  } finally { h.cleanup(); }
});

// --- H6/H7: the page that draws them ---------------------------------

test('H6/H7: legacy and unfinished rows render with their marks at 120 and 55 columns', () => {
  const h = everyWorkflowHome();
  try {
    const days = historyDays(h.dir, { days: 3, now: NOW });
    for (const width of [120, 55]) {
      const view = historyLines(days, { width, ansi: false });
      // Wrapped lines are still one sentence: fold them before matching, and
      // assert the frame per line below.
      const text = view.lines.join('\n').replace(/\s+/g, ' ');
      for (const line of view.lines) {
        assert.ok(line.length <= width, `${width}: over the frame: ${JSON.stringify(line)}`);
        assert.doesNotMatch(line, /(?:^|\s)(?:≈|·|\$)\s*$/, `${width}: a figure mark with nothing after it: ${JSON.stringify(line)}`);
      }
      for (const region of view.regions) {
        assert.ok(region.x >= 1 && region.x + region.width - 1 <= width, `${width}: region past the frame`);
      }
      // Every row is clickable, and each workflow appears once.
      const targets = view.regions.filter((region) => region.action.kind === 'run').map((region) => region.action.runId);
      assert.equal(new Set(targets).size, 7, `${width}: one region per workflow`);
      // The legacy state survives the phone width in its compact row; the
      // shared reason now appears once in the page footer rather than being
      // repeated as a second line for every legacy workflow.
      assert.match(text, /legacy · read-only/);
      assert.match(text, /Legacy workflows are read-only: no cost and no pool minutes were recorded\./);
      // Marks and identities stay at the row start at every width. Desktop
      // also has room for the measured state, duration and trailing clock;
      // the phone keeps the item to one row and may cut that context.
      assert.match(text, /● run101/);
      assert.match(text, /■ stop01/, 'a dead kernel is never painted as a live run');
      assert.match(text, /✓ 000001/, 'the legacy result mark survives');
      if (width === 120) {
        assert.match(text, /running · 5h00m elapsed · no result yet/);
        assert.match(text, /interrupted · no result recorded/);
        assert.match(text, /legacy · read-only · smoke-two-step\s+2m\s+09:02/, 'the legacy row shows its measured duration and finish time');
      }
    }
    // A goal long enough to fill the row leaves the identity and fixed
    // trailing measurements intact: the elastic summary is what gets cut.
    const running = days[0].rows.find((row) => row.unfinished === true);
    const wide = historyLines([{ ...days[0], rows: [{ ...running, goal: 'g'.repeat(200) }] }], { width: 120, ansi: false });
    const row = wide.lines.find((line) => line.includes('running'));
    assert.match(row, /^ ● run101\s+bullswarm/);
    assert.match(row, /5h00m\s+—$/, `fixed measurements trimmed instead of the summary: ${JSON.stringify(row)}`);
    assert.ok(row.length <= 120, `over the frame: ${row.length}`);

    // The legacy-only day prints no money at all (H3), at either width.
    for (const width of [120, 55]) {
      const only = historyLines([historyDays(h.dir, { days: 3, now: NOW })[2]], { width, ansi: false });
      assert.equal(only.lines.join('\n').includes('$'), false);
    }
  } finally { h.cleanup(); }
});

test('H7: a day whose runs are all still in flight says why it has no estimate', () => {
  const h = home();
  try {
    runDir(h.dir, {
      runId: 'wf-only-running-01',
      state: v2State({ runId: 'wf-only-running-01', shortId: 'onlyrn', goal: 'the only run', status: 'running', startedAt: localNoon(2026, 9, 16, 17), runner: liveRunner() }),
    });
    const [today] = historyDays(h.dir, { days: 1, now: NOW });
    assert.equal(today.finished, 0);
    assert.equal(today.unfinishedRows, 1);
    for (const width of [120, 55]) {
      const view = historyLines([today], { width, ansi: false });
      assert.match(view.lines.join('\n'), /no result recorded yet/);
      assert.doesNotMatch(view.lines.join('\n'), /no recorded API-equivalent cost/, 'the reason is that it has not delivered, not that it recorded nothing');
    }
    assert.equal(historyNote([today], { width: 120 })[0], '1 day loaded · older days load as you scroll');
  } finally { h.cleanup(); }
});

test('H7: finished single tasks share a day row without changing workflow counts', () => {
  const h = home();
  try {
    const task = {
      id: 'task-history-1', kind: 'task', source: 'run', lane: 'analyze', pool: 'codex', model: 'luna',
      project: 'bullswarm', taskFile: '/tmp/task-history.md',
      startedAt: localNoon(2026, 9, 16, 14), endedAt: localNoon(2026, 9, 16, 14, 3),
      durationMs: 180_000, ok: true,
    };
    const [day] = historyDays(h.dir, { days: 1, now: NOW, tasks: [task] });
    assert.equal(day.runs, 0);
    assert.equal(day.finished, 0);
    assert.equal(day.verified, 0);
    assert.equal(day.spendUsd, null);
    assert.deepEqual(day.rows, [task]);
    const view = historyLines([day], { width: 120, ansi: false });
    assert.match(view.lines.join('\n'), /0 runs · 1 task/);
    assert.match(view.lines.join('\n'), /task-history-1/);
    assert.ok(view.regions.some((region) => region.action.kind === 'task'
      && region.action.taskId === 'task-history-1'));
  } finally { h.cleanup(); }
});
