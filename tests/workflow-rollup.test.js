// Per-run rollup and the history index (src/workflow/rollup.js).
//
// Doctrine under test:
//   R1. rollupRecord is pure: no filesystem, no clock beyond the injected
//       `now`, and everything unknown comes back null.
//   R2. Money is never guessed. costUsd is the sum of the estimates the run
//       actually recorded; a run that recorded none gets null, never 0.
//   R3. A legacy run directory with no V2 state.json gets the minimal record:
//       identity, the times its own files prove, the status it recorded,
//       `legacy: true`, no cost and no pool minutes. What it cannot prove is
//       null, and a directory with nothing readable reports nulls, never
//       `now` — so writing the record cannot move what it records.
//   R4. The index is idempotent by runId: one line per run, newest wins.
//   R5. readRollups reads the index; it falls back to the run directories
//       only when the index is empty or the window opens before it.
//
// Every fixture builds its own home with mkdtempSync. Nothing here reads the
// developer's real ~/.bullswarm, and nothing needs the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROLLUP_SCHEMA_VERSION, appendRollupIndex, bullswarmDirOfRun, legacyRollupRecord, readLegacyRunFacts,
  readRollup, readRollupIndex, readRollups, rollupIndexPath, rollupRecord, writeLegacyRollup, writeRunRollup,
} from '../src/workflow/rollup.js';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-rollup-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function stateFixture({
  runId = 'wf-mu42yeqn-e4b9a7', shortId = 'imzcvs', goal = 'Deliver the data floor',
  cwd = '/Users/dev/Repo/bullswarm', status = 'completed',
  startedAt = '2026-09-16T12:31:50.017Z', finishedAt = '2026-09-16T12:52:51.027Z',
  seconds = 1260.2, attempts = null, requirements = null,
} = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.state.v2',
    runId, shortId, intentId: `intent-${shortId}`,
    intent: { goal, cwd, requirements: [{ id: 'R1' }, { id: 'R2' }] },
    lifecycle: { status, startedAt, finishedAt, resultFile: null },
    budget: { agents: 2, seconds, expansions: 0 },
    ledger: { requirements: requirements ?? { R1: { status: 'passed' }, R2: { status: 'open' } } },
    attempts: attempts ?? [
      { id: 'a1', actionId: 'build', pool: 'claude-code:wati', model: 'claude-opus-5', status: 'succeeded', wallSec: 876.9, usage: { tokens: { totalKnown: 10841 }, cost: { estimatedUsd: 0.244205 } } },
      { id: 'a2', actionId: 'prove', pool: 'codex', model: 'gpt-5.6-luna', status: 'succeeded', wallSec: 383.3, usage: { tokens: { totalKnown: 4000 }, cost: { estimatedUsd: 0.05 } } },
    ],
    actions: [], usage: { total: 14841, byPool: {} },
  };
}

function resultFixture({ runId = 'wf-mu42yeqn-e4b9a7', shortId = 'imzcvs', status = 'completed', verified = true, passed = 2, total = 2, finishedAt = '2026-09-16T12:52:51.027Z' } = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.result.v2', runId, shortId, intentId: `intent-${shortId}`,
    goal: 'Deliver the data floor', status, verified, reason: 'ok',
    requirements: Array.from({ length: total }, (_, index) => ({
      id: `R${index + 1}`, text: `requirement ${index + 1}`, mandatory: true,
      status: index < passed ? 'passed' : 'open', workRevision: 'initial', evidence: [],
    })),
    actions: [], gaps: null, usage: { total: 0, byPool: {} }, finishedAt,
  };
}

function runDirWith(dir, state, { result = null, rollup = null } = {}) {
  const runDir = join(dir, 'workflows', state.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  if (result) writeFileSync(join(runDir, 'result.json'), JSON.stringify(result));
  if (rollup) writeFileSync(join(runDir, 'rollup.json'), JSON.stringify(rollup));
  return runDir;
}

// --- R1: the record ---------------------------------------------------

test('R1: the record carries every field the dashboard reads, measured from state and result', () => {
  const record = rollupRecord(stateFixture(), resultFixture(), { project: 'bullswarm' });
  assert.equal(record.schemaVersion, ROLLUP_SCHEMA_VERSION);
  assert.equal(record.runId, 'wf-mu42yeqn-e4b9a7');
  assert.equal(record.shortId, 'imzcvs');
  assert.equal(record.project, 'bullswarm');
  assert.equal(record.goal, 'Deliver the data floor');
  assert.equal(record.cwd, '/Users/dev/Repo/bullswarm');
  assert.equal(record.startedAt, '2026-09-16T12:31:50.017Z');
  assert.equal(record.finishedAt, '2026-09-16T12:52:51.027Z');
  assert.equal(record.status, 'completed');
  assert.equal(record.verified, true);
  assert.deepEqual(record.requirements, { passed: 2, total: 2 });
  assert.equal(record.legacy, false);
  // 12:31:50.017 → 12:52:51.027 is 1261.01 s = 21.02 minutes of wall clock,
  // and budget.seconds 1260.2 is 21.0 minutes of agent time.
  assert.equal(record.minutes.wall, 21.02);
  assert.equal(record.minutes.agent, 21);
  assert.deepEqual(record.pools['claude-code:wati'], {
    attempts: 1, minutes: 14.62, costUsd: 0.244205, tokens: 10841,
    cacheRead: null, cacheWrite: null, tokenSource: 'unknown',
  });
  assert.deepEqual(record.pools.codex, {
    attempts: 1, minutes: 6.39, costUsd: 0.05, tokens: 4000,
    cacheRead: null, cacheWrite: null, tokenSource: 'unknown',
  });
  assert.deepEqual(record.models['claude-opus-5'], { attempts: 1, minutes: 14.62 });
  assert.deepEqual(record.models['gpt-5.6-luna'], { attempts: 1, minutes: 6.39 });
});

test('R1: rollupRecord touches no filesystem and no wall clock', () => {
  const state = stateFixture();
  const before = JSON.stringify(state);
  const first = rollupRecord(state, resultFixture(), { project: 'p', now: 0 });
  const second = rollupRecord(state, resultFixture(), { project: 'p', now: 0 });
  assert.deepEqual(first, second, 'the same inputs must produce the same record');
  assert.equal(JSON.stringify(state), before, 'the state must not be mutated');
});

test('R1: an unfinished-looking state falls back to the injected now, never to Date.now()', () => {
  const state = stateFixture({ finishedAt: null });
  const record = rollupRecord(state, null, { now: Date.parse('2026-09-16T13:00:00.000Z') });
  assert.equal(record.finishedAt, '2026-09-16T13:00:00.000Z');
  assert.equal(record.status, 'completed', 'with no result envelope the lifecycle status is the answer');
  assert.equal(record.verified, false, 'no result envelope means no verified verdict');
  assert.deepEqual(record.requirements, { passed: 1, total: 2 }, 'requirements fall back to the durable ledger');
});

test('R1: unmeasurable minutes are null, never zero', () => {
  const record = rollupRecord(
    stateFixture({ startedAt: null, finishedAt: null, seconds: 0, attempts: [] }),
    null,
    { now: Number.NaN },
  );
  assert.equal(record.minutes.wall, null);
  assert.equal(record.minutes.agent, 0, 'budget.seconds 0 is a measurement: the run burned no agent time');
  assert.equal(record.startedAt, null);
  assert.deepEqual(record.pools, {});
  assert.deepEqual(record.models, {});
});

// --- R2: money ---------------------------------------------------------

test('R2: a run that recorded no cost estimate gets costUsd null, not 0', () => {
  const record = rollupRecord(stateFixture({
    attempts: [
      { id: 'a1', pool: 'grok', model: 'grok-4.6', status: 'succeeded', wallSec: 60, usage: { tokens: { totalKnown: 100 } } },
      { id: 'a2', pool: 'grok', model: 'grok-4.6', status: 'failed', wallSec: 30, usage: null },
    ],
  }), null);
  assert.equal(record.pools.grok.costUsd, null, 'no estimate recorded → null, never 0');
  assert.equal(record.pools.grok.tokens, 100);
  assert.equal(record.pools.grok.attempts, 2);
  assert.equal(record.pools.grok.minutes, 1.5);
});

test('R2: only the attempts that recorded an estimate move the money', () => {
  const record = rollupRecord(stateFixture({
    attempts: [
      { id: 'a1', pool: 'codex', model: 'gpt-5.6-luna', wallSec: 60, usage: { cost: { estimatedUsd: 0.25 }, tokens: { totalKnown: 10 } } },
      { id: 'a2', pool: 'codex', model: 'gpt-5.6-luna', wallSec: 60, usage: { cost: { estimatedUsd: null }, tokens: { totalKnown: null } } },
    ],
  }), null);
  assert.equal(record.pools.codex.costUsd, 0.25);
  assert.equal(record.pools.codex.tokens, 10);
  assert.equal(record.pools.codex.attempts, 2);
});

test('R2: an explicit "estimatedUsd: null" stays null — Number(null) is 0, and a zero here is a lie', () => {
  const record = rollupRecord(stateFixture({
    attempts: [
      { id: 'a1', pool: 'claude-code', model: 'claude-opus-5', wallSec: 60, usage: { cost: { estimatedUsd: null, basis: 'unknown: no model rate metadata' }, tokens: { totalKnown: null } } },
      { id: 'a2', pool: 'claude-code', model: 'claude-opus-5', wallSec: 60, usage: { cost: { estimatedUsd: null }, tokens: { totalKnown: null } } },
    ],
  }), null);
  // 75 of the 188 V2 runs on this machine carry no cost figure at all; the
  // dashboard must render a blank for them, not $0.00.
  assert.equal(record.pools['claude-code'].costUsd, null);
  assert.equal(record.pools['claude-code'].tokens, null);
  assert.equal(record.pools['claude-code'].attempts, 2);
  assert.equal(record.pools['claude-code'].minutes, 2);
});

test('R2: an attempt with no pool or model is counted under "unknown", not dropped', () => {
  const record = rollupRecord(stateFixture({
    attempts: [{ id: 'a1', pool: null, model: null, wallSec: 120, usage: null }],
  }), null);
  assert.deepEqual(record.pools.unknown, {
    attempts: 1, minutes: 2, costUsd: null, tokens: null,
    cacheRead: null, cacheWrite: null, tokenSource: 'unknown',
  });
  assert.deepEqual(record.models.unknown, { attempts: 1, minutes: 2 });
});

test('rollup keeps cache totals and the worst token basis for each pool', () => {
  const record = rollupRecord(stateFixture({
    attempts: [
      {
        id: 'a1', pool: 'claude-code', model: 'claude-opus-5', wallSec: 60,
        usage: {
          tokenSource: 'provider-reported',
          tokens: { totalKnown: 30, cacheRead: 20, cacheWrite5m: 4, cacheWrite1h: 6 },
          cost: { estimatedUsd: 1 },
        },
      },
      {
        id: 'a2', pool: 'claude-code', model: 'claude-opus-5', wallSec: 60,
        usage: {
          tokenSource: 'transcript-summed',
          tokens: { totalKnown: 10, cacheRead: 3, cacheWrite: 2 },
          cost: { estimatedUsd: 0.5 },
        },
      },
    ],
  }), null);
  assert.equal(record.pools['claude-code'].cacheRead, 23);
  assert.equal(record.pools['claude-code'].cacheWrite, 12);
  assert.equal(record.pools['claude-code'].tokenSource, 'transcript-summed');
});

// --- writeRunRollup / readRollup ---------------------------------------

test('writeRunRollup writes rollup.json and appends the index, and readRollup reads it back', () => {
  const h = home();
  try {
    const state = stateFixture();
    const runDir = runDirWith(h.dir, state);
    const written = writeRunRollup(runDir, state, resultFixture(), { project: 'bullswarm' });
    assert.equal(existsSync(join(runDir, 'rollup.json')), true);
    assert.deepEqual(readRollup(runDir), written);
    assert.equal(bullswarmDirOfRun(runDir), h.dir);

    const indexPath = rollupIndexPath(h.dir);
    assert.equal(indexPath, join(h.dir, 'history', 'runs.jsonl'));
    const lines = readFileSync(indexPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), written);
  } finally { h.cleanup(); }
});

test('writeRunRollup resolves the project from the record the run made at goal time', () => {
  const h = home();
  try {
    const state = stateFixture({ cwd: '/gone/forever' });
    const runDir = runDirWith(h.dir, state);
    writeFileSync(join(runDir, 'project.json'), JSON.stringify({
      schemaVersion: 'bullswarm.workflow.project.v1',
      name: 'bullseye', remote: 'git@github.com:Bulls-Work/bullseye.git',
      toplevel: '/gone/forever', cwd: '/gone/forever', recordedAt: '2026-09-16T12:00:00.000Z',
    }));
    const record = writeRunRollup(runDir, state, resultFixture());
    assert.equal(record.project, 'bullseye', 'the goal-time record outlives the checkout');
  } finally { h.cleanup(); }
});

test('readRollup returns null for a run with no rollup and for a foreign schema', () => {
  const h = home();
  try {
    const bare = runDirWith(h.dir, stateFixture({ runId: 'wf-bare-000000' }));
    assert.equal(readRollup(bare), null);
    const foreign = runDirWith(h.dir, stateFixture({ runId: 'wf-foreign-000000' }), {
      rollup: { schemaVersion: 'something.else.v9', runId: 'wf-foreign-000000' },
    });
    assert.equal(readRollup(foreign), null);
  } finally { h.cleanup(); }
});

// --- R4: index idempotency ---------------------------------------------

test('R4: appending the same record twice leaves one line', () => {
  const h = home();
  try {
    const record = rollupRecord(stateFixture(), resultFixture(), { project: 'bullswarm' });
    const first = appendRollupIndex(h.dir, record);
    const second = appendRollupIndex(h.dir, record);
    assert.deepEqual(first, { runId: record.runId, appended: true, replaced: false });
    assert.deepEqual(second, { runId: record.runId, appended: false, replaced: false });
    assert.equal(readFileSync(rollupIndexPath(h.dir), 'utf8').trim().split('\n').length, 1);
    assert.equal(readRollupIndex(h.dir).length, 1);
  } finally { h.cleanup(); }
});

test('R4: re-finishing a run replaces its line rather than adding a second', () => {
  const h = home();
  try {
    const first = rollupRecord(stateFixture(), resultFixture({ verified: false, passed: 1 }), { project: 'bullswarm' });
    appendRollupIndex(h.dir, first);
    appendRollupIndex(h.dir, rollupRecord(stateFixture({ runId: 'wf-other-000000', shortId: 'other1' }), null, { project: 'bullseye' }));
    const revised = rollupRecord(stateFixture(), resultFixture({ verified: true, passed: 2 }), { project: 'bullswarm' });
    const result = appendRollupIndex(h.dir, revised);
    assert.deepEqual(result, { runId: revised.runId, appended: true, replaced: true });

    const index = readRollupIndex(h.dir);
    assert.equal(index.length, 2, 'one line per run');
    assert.equal(index.filter((entry) => entry.runId === revised.runId).length, 1);
    assert.equal(index.find((entry) => entry.runId === revised.runId).verified, true, 'the newest record wins');
    assert.equal(index.find((entry) => entry.runId === 'wf-other-000000').project, 'bullseye', 'the sibling line survives the rewrite');
  } finally { h.cleanup(); }
});

test('R4: a record with no runId is refused rather than written', () => {
  const h = home();
  try {
    assert.throws(() => appendRollupIndex(h.dir, { schemaVersion: ROLLUP_SCHEMA_VERSION }), /runId/);
    assert.equal(existsSync(rollupIndexPath(h.dir)), false);
  } finally { h.cleanup(); }
});

test('R4: a torn final line is skipped, not fatal', () => {
  const h = home();
  try {
    const good = rollupRecord(stateFixture(), resultFixture(), { project: 'bullswarm' });
    appendRollupIndex(h.dir, good);
    writeFileSync(rollupIndexPath(h.dir), `${readFileSync(rollupIndexPath(h.dir), 'utf8')}{"runId":"wf-torn`, { flag: 'w' });
    const index = readRollupIndex(h.dir);
    assert.equal(index.length, 1);
    assert.equal(index[0].runId, good.runId);
  } finally { h.cleanup(); }
});

// --- R5: reading ------------------------------------------------------

test('R5: readRollups returns records newest first and honours since, until and limit', () => {
  const h = home();
  try {
    const days = ['2026-09-10', '2026-09-12', '2026-09-14', '2026-09-16'];
    for (const [index, day] of days.entries()) {
      appendRollupIndex(h.dir, rollupRecord(
        stateFixture({
          runId: `wf-day${index}-000000`, shortId: `day${index}00`,
          startedAt: `${day}T09:00:00.000Z`, finishedAt: `${day}T10:00:00.000Z`,
        }),
        resultFixture({ runId: `wf-day${index}-000000`, shortId: `day${index}00`, finishedAt: `${day}T10:00:00.000Z` }),
        { project: 'bullswarm' },
      ));
    }
    const all = readRollups(h.dir);
    assert.deepEqual(all.map((r) => r.finishedAt.slice(0, 10)), ['2026-09-16', '2026-09-14', '2026-09-12', '2026-09-10']);

    const since = readRollups(h.dir, { since: '2026-09-12T10:00:00.000Z' });
    assert.deepEqual(since.map((r) => r.finishedAt.slice(0, 10)), ['2026-09-16', '2026-09-14', '2026-09-12'], 'since is inclusive');

    const until = readRollups(h.dir, { until: '2026-09-14T10:00:00.000Z' });
    assert.deepEqual(until.map((r) => r.finishedAt.slice(0, 10)), ['2026-09-12', '2026-09-10'], 'until is exclusive');

    assert.equal(readRollups(h.dir, { limit: 2 }).length, 2);
    const relative = readRollups(h.dir, { since: '3d', now: Date.parse('2026-09-16T12:00:00.000Z') });
    assert.deepEqual(relative.map((r) => r.finishedAt.slice(0, 10)), ['2026-09-16', '2026-09-14'], "'3d' is measured back from now");
  } finally { h.cleanup(); }
});

test('R5: an empty index falls back to the run directories', () => {
  const h = home();
  try {
    const state = stateFixture();
    const runDir = runDirWith(h.dir, state);
    writeFileSync(join(runDir, 'rollup.json'), JSON.stringify(
      rollupRecord(state, resultFixture(), { project: 'bullswarm' }),
    ));
    assert.equal(existsSync(rollupIndexPath(h.dir)), false);
    const records = readRollups(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].runId, state.runId);
  } finally { h.cleanup(); }
});

test('R5: a window opening before the oldest indexed run picks up the run directories too', () => {
  const h = home();
  try {
    const indexed = stateFixture({ runId: 'wf-new-0000000', shortId: 'newrun', startedAt: '2026-09-16T09:00:00.000Z', finishedAt: '2026-09-16T10:00:00.000Z' });
    runDirWith(h.dir, indexed);
    appendRollupIndex(h.dir, rollupRecord(indexed, null, { project: 'bullswarm' }));

    const older = stateFixture({ runId: 'wf-old-0000000', shortId: 'oldrun', startedAt: '2026-09-01T09:00:00.000Z', finishedAt: '2026-09-01T10:00:00.000Z' });
    const olderDir = runDirWith(h.dir, older);
    writeFileSync(join(olderDir, 'rollup.json'), JSON.stringify(rollupRecord(older, null, { project: 'bullswarm' })));

    assert.deepEqual(
      readRollups(h.dir).map((r) => r.runId), ['wf-new-0000000'],
      'an unbounded read trusts the index — reindex is what completes it',
    );
    assert.deepEqual(
      readRollups(h.dir, { since: '2026-08-01T00:00:00.000Z' }).map((r) => r.runId),
      ['wf-new-0000000', 'wf-old-0000000'],
      'a window that opens before the index reaches into the run directories',
    );
  } finally { h.cleanup(); }
});

test('R3: a legacy run directory with nothing readable records nothing', () => {
  const h = home();
  try {
    const noStateDir = join(h.dir, 'workflows', 'wf-nostate-00000');
    mkdirSync(noStateDir, { recursive: true });
    assert.equal(readRollup(noStateDir), null);
    assert.deepEqual(readRollups(h.dir), [], 'no index line and no directory record');
  } finally { h.cleanup(); }
});

// --- R3: what a legacy directory can prove ----------------------------

function legacyDir(dir, runId, { report = null, state = null, files = {} } = {}) {
  const at = join(dir, 'workflows', runId);
  mkdirSync(at, { recursive: true });
  if (report) writeFileSync(join(at, 'report.json'), JSON.stringify(report));
  if (state) writeFileSync(join(at, 'state.json'), JSON.stringify(state));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(at, name), content);
  return at;
}

test('R3: readLegacyRunFacts prefers report.json, then state.json, then the file times', () => {
  const h = home();
  try {
    const withReport = legacyDir(h.dir, 'wf-legacy-report', {
      report: {
        workflow: 'smoke-two-step', status: 'completed',
        startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:54:08.084Z',
      },
      // A state.json that disagrees: the run's own summary is the authority.
      state: { name: 'something-else', startedAt: '2026-08-20T00:00:00.000Z' },
    });
    const reportFacts = readLegacyRunFacts(withReport, { runId: 'wf-legacy-report' });
    assert.deepEqual(
      { goal: reportFacts.goal, status: reportFacts.status, startedAt: reportFacts.startedAt, finishedAt: reportFacts.finishedAt, timeSource: reportFacts.timeSource },
      {
        goal: 'smoke-two-step', status: 'completed',
        startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:54:08.084Z', timeSource: 'report',
      },
    );

    const withState = legacyDir(h.dir, 'wf-legacy-state', {
      state: { name: 'connector-audit', status: 'completed', startedAt: '2026-08-22T09:00:00.000Z', finishedAt: '2026-08-22T09:05:00.000Z' },
    });
    assert.equal(readLegacyRunFacts(withState, { runId: 'wf-legacy-state' }).timeSource, 'state');

    // The state recorded a start and no finish (14 of the live home's 105
    // legacy directories are this shape): the file times answer for the
    // finish, and the facts name both sources rather than pretending one did.
    const halfRecorded = legacyDir(h.dir, 'wf-legacy-half', {
      state: { status: 'completed', startedAt: '2026-08-22T09:00:00.000Z' },
      files: { 'output.md': 'x' },
    });
    const started = new Date('2026-08-22T09:00:00.000Z');
    const newer = new Date('2026-08-22T09:30:00.000Z');
    utimesSync(join(halfRecorded, 'state.json'), started, started);
    utimesSync(join(halfRecorded, 'output.md'), newer, newer);
    const halfFacts = readLegacyRunFacts(halfRecorded, { runId: 'wf-legacy-half' });
    assert.equal(halfFacts.timeSource, 'state+directory');
    assert.equal(halfFacts.startedAt, '2026-08-22T09:00:00.000Z');
    assert.equal(halfFacts.finishedAt, newer.toISOString());

    // Nothing recorded a time at all: the file times are all there is.
    const fromFiles = legacyDir(h.dir, 'wf-legacy-files', {
      state: { status: 'completed' },
      files: { 'output.md': 'x' },
    });
    const older = new Date('2026-08-22T10:00:00.000Z');
    const last = new Date('2026-08-22T10:30:00.000Z');
    utimesSync(join(fromFiles, 'state.json'), older, older);
    utimesSync(join(fromFiles, 'output.md'), last, last);
    const fileFacts = readLegacyRunFacts(fromFiles, { runId: 'wf-legacy-files' });
    assert.equal(fileFacts.timeSource, 'directory');
    assert.equal(fileFacts.startedAt, older.toISOString());
    assert.equal(fileFacts.finishedAt, last.toISOString());
  } finally { h.cleanup(); }
});

test('R3: a legacy record carries identity and times, and neither cost nor pool minutes', () => {
  const record = legacyRollupRecord({
    runId: 'wf-legacy-report', shortId: 'legacy', project: 'bullseye', goal: 'smoke-two-step',
    status: 'completed', startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:54:08.084Z',
    timeSource: 'report',
  });
  assert.deepEqual(record, {
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    runId: 'wf-legacy-report', shortId: 'legacy', project: 'bullseye', goal: 'smoke-two-step', cwd: null,
    startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:54:08.084Z', status: 'completed',
    verified: false, requirements: { passed: 0, total: 0 },
    minutes: { wall: 3, agent: null }, pools: {}, models: {}, legacy: true, timeSource: 'report',
  });
  // A second call with the same facts is the same record, or the index would
  // take a new line every time (R4).
  assert.deepEqual(legacyRollupRecord(record), record);
});

test('R3: a duration is only reported when both times came from the run itself', () => {
  const facts = {
    runId: 'wf-legacy-000000', goal: 'connector-audit', status: 'completed',
    startedAt: '2026-08-22T09:00:00.000Z', finishedAt: '2026-08-26T09:00:00.000Z',
  };
  // A file time says when a file was written, not when the run stopped:
  // subtracting it from the run's own start would report a duration the run
  // never had, so the record reports none.
  assert.equal(legacyRollupRecord({ ...facts, timeSource: 'directory' }).minutes.wall, null);
  assert.equal(legacyRollupRecord({ ...facts, timeSource: 'state+directory' }).minutes.wall, null);
  assert.equal(legacyRollupRecord({ ...facts, timeSource: 'state' }).minutes.wall, 5760);
  assert.equal(legacyRollupRecord({ ...facts, timeSource: 'report' }).minutes.wall, 5760);
  // A finish before the start is a clock that moved: no duration either.
  assert.equal(legacyRollupRecord({ ...facts, startedAt: facts.finishedAt, finishedAt: facts.startedAt, timeSource: 'report' }).minutes.wall, null);
});

test('R3: a directory with no readable time reports nulls, never the current clock', () => {
  const h = home();
  try {
    const empty = legacyDir(h.dir, 'wf-legacy-empty');
    const record = legacyRollupRecord(readLegacyRunFacts(empty, { runId: 'wf-legacy-empty' }));
    assert.equal(record.startedAt, null);
    assert.equal(record.finishedAt, null);
    assert.equal(record.minutes.wall, null);
    assert.equal(record.timeSource, 'directory');
    assert.equal(record.runId, 'wf-legacy-empty');
  } finally { h.cleanup(); }
});

test('R3/R4: writeLegacyRollup writes the record and the index line, and repeats identically', () => {
  const h = home();
  try {
    const at = legacyDir(h.dir, 'wf-legacy-000000', {
      report: { workflow: 'smoke-two-step', status: 'completed', startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:51:08.086Z' },
    });
    const first = writeLegacyRollup(at, { runId: 'wf-legacy-000000' });
    assert.deepEqual(readRollup(at), first, 'the record is readable from the run directory');
    assert.equal(first.legacy, true);
    assert.deepEqual(first.pools, {});
    const lines = readFileSync(rollupIndexPath(h.dir), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), first);

    // Writing it again — the second `workflow reindex` — leaves one line.
    const second = writeLegacyRollup(at, { runId: 'wf-legacy-000000' });
    assert.deepEqual(second, first);
    const again = appendRollupIndex(h.dir, second);
    assert.deepEqual(again, { runId: 'wf-legacy-000000', appended: false, replaced: false });
    assert.equal(readFileSync(rollupIndexPath(h.dir), 'utf8').trim().split('\n').length, 1);
    assert.equal(readRollups(h.dir).length, 1);
  } finally { h.cleanup(); }
});

test('R3: a directory with no state.json at all is still described, from its report', () => {
  const h = home();
  try {
    const at = legacyDir(h.dir, 'wf-legacy-000000', {
      report: { workflow: 'old-graph', status: 'completed', startedAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:02:00.000Z' },
    });
    // No state.json: 0.27.0 lists this as a legacy run, and so does the record.
    assert.equal(existsSync(join(at, 'state.json')), false);
    const record = writeLegacyRollup(at, { runId: 'wf-legacy-000000' });
    assert.equal(record.legacy, true);
    assert.equal(record.goal, 'old-graph');
    assert.equal(record.minutes.wall, 2);
    assert.equal(readRollups(h.dir)[0].runId, 'wf-legacy-000000');
  } finally { h.cleanup(); }
});
