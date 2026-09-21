// Tests for short run IDs, the `workflow runs` sub-verb, and the
// legacy read-only surface's V2 neighbours.
//
// Doctrine:
//   I1. Every new run gets a 6-char shortId in `state.shortId`. The full
//       runId (`wf-...`) stays unchanged.
//   I2. The shortId alphabet is Crockford-style 32 chars: no `0/1/i/l/o`
//       to avoid visual ambiguity.
//   I3. `isShortId` accepts only the 32-char alphabet at exactly 6
//       characters.
//   I4. generateShortId never returns a value already in the existing
//       set (collision-free across 16 attempts).
//   I5. resolveRunId maps a shortId to the correct runId; collisions
//       throw a hard error.
//   I6. resolveRunId accepts a full `wf-...` runId as a fast path.
//   I7. isOngoing is false for a terminal run and for one whose kernel is
//       gone; true only while a live kernel is heartbeating.
//   I8. listRuns enumerates every `wf-...` subdir, with state + report
//       shapes attached.
//   I9. `bullswarm workflow runs` lists ongoing by default; `--all`
//       includes historical; `--historical` shows only historical;
//       `--name <goal>` filters by goal; initiated-time bounds compare
//       `startedAt` with an inclusive lower and exclusive upper bound.
//   I10. `runs show <id>` accepts a shortId or a full runId; `runs result`
//        returns the stable caller-facing V2 delivery envelope.
//   I11. `runs delete <id>` refuses without --yes; refuses for an
//        ongoing run without --force; deletes with both flags.
//   I12. `workflow resume <shortId>` resolves through the same resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  generateShortId, isShortId, resolveRunId, listRuns, isOngoing,
  SHORT_ID_ALPHABET, SHORT_ID_LEN,
} from '../src/workflow/short-id.js';
import { isDeliveredWorkflowStatus, isTerminalWorkflowStatus } from '../src/workflow/status.js';
import { deserializeV2DurableState } from '../src/workflow/v2-state.js';
import { deserializeV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import { rollupRecord } from '../src/workflow/rollup.js';
import { historyLines } from '../src/workflow/history-view.js';

const REAL_G6D6Q2 = JSON.parse(
  readFileSync(new URL('./fixtures/workflows/g6d6q2-state.json', import.meta.url), 'utf8'),
);

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bs-runs-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(join(home, 'workflows'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {},
    decisionLog: [], config: { depthLimit: 2, callerName: 'claude-code' },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: env.home },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const wf = (...args) => ['workflow', ...args];

// One durable V2 run written straight to disk. Every `runs` surface reads
// state.json, so a hand-written V2 state exercises the same code path a
// kernel-produced one does without dispatching anything.
function v2Run(home, {
  runId = 'wf-v2-run', shortId = 'v2r234', goal = 'Produce and prove a V2 artifact.',
  status = 'completed', startedAt = '2026-08-31T01:00:00.000Z',
  finishedAt = '2026-08-31T01:02:00.000Z', runner = null, result = true,
  report = null, actions = [{ id: 'produce', status: 'succeeded' }, { id: 'prove', status: 'succeeded' }],
} = {}) {
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const intentId = `intent-${shortId}`;
  const state = {
    schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId, intentId,
    intent: { goal },
    lifecycle: { status, startedAt, finishedAt, resultFile: result ? join(runDir, 'result.json') : null },
    ledger: { requirements: { 'requirement-1': { status: 'passed' } } },
    actions,
    ...(runner ? { runner } : {}),
  };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  let envelope = null;
  if (result) {
    envelope = {
      schemaVersion: 'bullswarm.workflow.result.v2', runId, shortId, intentId,
      status, verified: true, reason: 'All mandatory requirements have fresh passing evidence.',
      goal,
      requirements: [{ id: 'requirement-1', text: 'Artifact is correct.', mandatory: true, status: 'passed', workRevision: 'initial', evidence: [{ sourceAction: 'prove', status: 'passed', evidence: ['focused check passed'], concerns: [], eventSequence: 1 }] }],
      actions: [{ id: 'produce', purpose: 'Produce artifact', status: 'succeeded', outputFile: null, artifactIds: ['artifact'] }, { id: 'prove', purpose: 'Prove artifact', status: 'succeeded', outputFile: null, artifactIds: [] }],
      gaps: null, usage: { total: 0, byPool: {} }, finishedAt,
    };
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(envelope));
  }
  if (report) writeFileSync(join(runDir, 'report.json'), JSON.stringify(report));
  return { runDir, state, result: envelope };
}

// A pre-0.27.0-style helper name kept for the tests that only care about the
// initiated time of an already-finished run.
function historicalFixture(home, { runId, shortId, goal = 'dated', startedAt, stateStartedAt = startedAt }) {
  return v2Run(home, {
    runId, shortId, goal, status: 'completed', startedAt: stateStartedAt,
    finishedAt: startedAt == null ? null : new Date(Date.parse(startedAt) + 60_000).toISOString(),
    result: false,
    report: { runId, shortId, status: 'completed', startedAt, finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString() },
  });
}

const autonomousV2Fixture = (home, options = {}) => v2Run(home, { runId: 'wf-v2-result', ...options });

// --- I1: shortId is set on every new run -------------------------------
test('I1: a new run gets a 6-char shortId in its durable V2 state', { timeout: 30_000 }, () => {
  const { home, cleanup } = sandbox();
  const workspace = mkdtempSync(join(tmpdir(), 'bs-runs-ws-'));
  try {
    const worker = join(home, 'runs-worker.mjs');
    writeFileSync(worker, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const task = readFileSync(process.argv[2], "utf8");',
      'const id = task.match(/Bullswarm program action: (\\S+)/)?.[1];',
      'if (!id) throw new Error("unexpected planner or scout dispatch");',
      'if (id === "produce") writeFileSync("done.txt", "ready\\n");',
      'else if (readFileSync("done.txt", "utf8") !== "ready\\n") throw new Error("missing artifact");',
      'process.stdout.write("Completed " + id + ": delivered the requested file or inspection, read the concrete dependency file done.txt, and verified that its content matches the required acceptance value.");',
    ].join('\n'));
    writeFileSync(join(home, 'connectors', 'runs-agent.json'), JSON.stringify({
      name: 'runs-agent', bin: 'node', configDirs: [],
      spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'add-dir' },
      authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
      costRank: 1, lanes: ['analyze', 'build', 'chore'], capabilities: ['code-reading', 'file-editing'],
      knownModels: ['fixture-model'], modelSelection: { flag: '--model', mode: 'replace-or-append' },
      timeoutSec: 30,
    }));
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: { 'runs-agent': { enabled: true } }, incumbents: {}, decisionLog: [],
      config: { depthLimit: 2, callerName: 'claude-code' },
    }));
    const programPath = join(home, 'program.json');
    writeFileSync(programPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'produce', purpose: 'Write done.txt', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Write done.txt containing exactly ready.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done-artifact'] },
        { id: 'prove', purpose: 'Inspect done.txt', dependsOn: ['produce'], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare every byte with the required content.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: ['done-artifact'], produces: [] },
      ],
    }));
    const executed = spawnSync('node', [BIN, 'workflow', 'goal', '1. done.txt exists and says ready.', '--cwd', workspace, '--program', programPath, '--foreground', '--json'], {
      encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0' },
    });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const runs = listRuns(home);
    assert.equal(runs.length, 1);
    const [only] = runs;
    assert.ok(isShortId(only.shortId), `bad shortId: ${only.shortId}`);
    assert.equal(only.shortId.length, SHORT_ID_LEN);
    assert.equal(only.legacy, false);
    // The durable artifact on disk carries the same shortId the list reports.
    const stateOnDisk = JSON.parse(readFileSync(join(only.runDir, 'state.json'), 'utf8'));
    assert.equal(stateOnDisk.shortId, only.shortId);
    assert.equal(resolveRunId(home, only.shortId).runId, only.runId);
    const durable = deserializeV2DurableState(JSON.stringify(stateOnDisk));
    assert.equal(durable.attempts.length, 2);
    const envelope = deserializeV2ResultEnvelope(readFileSync(join(only.runDir, 'result.json'), 'utf8'));
    const resultReadback = run(wf('runs', 'result', only.shortId, '--json'), { home });
    assert.equal(resultReadback.status, 0, resultReadback.stderr || resultReadback.stdout);
    const cliResult = JSON.parse(resultReadback.stdout);
    for (const attempt of durable.attempts) {
      assert.equal(typeof attempt.routeWhy, 'string');
      assert.equal(attempt.routeWhy, attempt.routing.reason);
      const candidates = attempt.routing.candidates.map(({ pool, effectiveSurplus, urgencyState, forecastPacingPct }) => ({ pool, effectiveSurplus, urgencyState, forecastPacingPct }));
      assert.deepEqual(attempt.routeCandidates, candidates);
      const actionReadback = run(wf('action', 'show', only.shortId, attempt.actionId, '--json'), { home });
      assert.equal(actionReadback.status, 0, actionReadback.stderr || actionReadback.stdout);
      const shownAttempt = JSON.parse(actionReadback.stdout).attempts.at(-1);
      assert.equal(shownAttempt.routeWhy, attempt.routeWhy);
      assert.deepEqual(shownAttempt.routeCandidates, candidates);
      for (const result of [envelope, cliResult]) {
        const action = result.actions.find((entry) => entry.id === attempt.actionId);
        assert.equal(action.routeWhy, attempt.routeWhy);
        assert.deepEqual(action.routeCandidates, candidates);
      }
    }
    const legacy = structuredClone(durable);
    for (const attempt of legacy.attempts) {
      delete attempt.routeWhy;
      delete attempt.routeCandidates;
    }
    assert.deepEqual(deserializeV2DurableState(JSON.stringify(legacy)), legacy);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cleanup();
  }
});

// --- I2 / I3: shortId alphabet and isShortId ---------------------------
test('I2: shortId alphabet has exactly 32 symbols, no 0/1/i/l/o', () => {
  assert.equal(SHORT_ID_ALPHABET.length, 32);
  assert.equal(SHORT_ID_LEN, 6);
  for (const c of '0o1lI') {
    assert.equal(SHORT_ID_ALPHABET.includes(c), false, `forbidden char ${c} in alphabet`);
  }
});

test('I3: isShortId accepts only 6 chars from the alphabet', () => {
  assert.equal(isShortId('abc234'), true);
  assert.equal(isShortId('234567'), true);
  assert.equal(isShortId('a'), false);            // too short
  assert.equal(isShortId('abcdefg'), false);      // too long
  assert.equal(isShortId('abc0ef'), false);       // forbidden char
  assert.equal(isShortId('wf-mtap1-b2345'), false);
  assert.equal(isShortId(''), false);
  assert.equal(isShortId(null), false);
  assert.equal(isShortId(123), false);
});

// --- I4: generateShortId avoids collisions ---------------------------
test('I4: generateShortId never collides with the existing set', () => {
  const a = generateShortId();
  const b = generateShortId();
  const c = generateShortId({ existing: [a, b] });
  assert.notEqual(a, b);
  assert.notEqual(c, a);
  assert.notEqual(c, b);
});

// --- I5 / I6: resolveRunId -----------------------------------------
test('I5: resolveRunId maps a shortId to its runId, errors on collisions', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-first', shortId: 'aaa234' });
    v2Run(home, { runId: 'wf-second', shortId: 'bbb345' });
    const runs = listRuns(home);
    assert.equal(runs.length, 2);
    const r1 = runs[0];
    assert.ok(isShortId(r1.shortId));
    const resolved = resolveRunId(home, r1.shortId);
    assert.equal(resolved.runId, r1.runId);
    assert.equal(resolved.shortId, r1.shortId);
    // Two runs claiming one shortId is a hard error, never a silent pick.
    v2Run(home, { runId: 'wf-third', shortId: 'aaa234' });
    assert.throws(() => resolveRunId(home, 'aaa234'), /matches multiple runs/);
  } finally { cleanup(); }
});

test('I5: resolveRunId returns null for an unknown shortId', () => {
  const { home, cleanup } = sandbox();
  try {
    assert.equal(resolveRunId(home, 'zzzzzz'), null);
    assert.equal(resolveRunId(home, 'wf-bogus-run-id-xxxxx'), null);
  } finally { cleanup(); }
});

test('I6: resolveRunId accepts a full wf-... runId as a fast path', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-fastpath', shortId: 'fst234' });
    const resolved = resolveRunId(home, 'wf-fastpath');
    assert.equal(resolved.runId, 'wf-fastpath');
    assert.equal(resolved.shortId, 'fst234');
  } finally { cleanup(); }
});

// --- I7: isOngoing ------------------------------------------------
test('I7: isOngoing returns false for a run with finishedAt', () => {
  const { home, cleanup } = sandbox();
  try {
    const { runDir, state } = v2Run(home, { runId: 'wf-done', shortId: 'dne234' });
    assert.equal(isOngoing(runDir, state), false);
  } finally { cleanup(); }
});

test('I7: isOngoing returns true while a live kernel is heartbeating', () => {
  const { home, cleanup } = sandbox();
  try {
    const { runDir, state } = v2Run(home, {
      runId: 'wf-live', shortId: 'lvv234', status: 'running',
      startedAt: new Date().toISOString(), finishedAt: null, result: false,
      runner: { pid: process.pid, lastHeartbeatAt: new Date().toISOString() },
    });
    assert.equal(isOngoing(runDir, state), true);
  } finally { cleanup(); }
});

test('I7: isOngoing returns false when the kernel that owned the run is gone', () => {
  const { home, cleanup } = sandbox();
  try {
    const { runDir, state } = v2Run(home, {
      runId: 'wf-dead', shortId: 'ded234', status: 'running',
      startedAt: new Date().toISOString(), finishedAt: null, result: false,
      // A pid that cannot be alive: the reader must not repeat "running".
      runner: { pid: 999_999, lastHeartbeatAt: new Date().toISOString() },
    });
    assert.equal(isOngoing(runDir, state), false);
  } finally { cleanup(); }
});

// --- I8: listRuns -------------------------------------------------
test('I8: listRuns returns one entry per wf- subdir with state+report', () => {
  const { home, cleanup } = sandbox();
  try {
    const fixture = v2Run(home, { runId: 'wf-listed', shortId: 'lst234' });
    const list = listRuns(home);
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, 'wf-listed');
    assert.ok(list[0].state);
    // `result.json` is the durable envelope the row summary is read from.
    assert.deepEqual(list[0].report, fixture.result);
    assert.equal(list[0].ongoing, false);
    assert.equal(list[0].legacy, false);
  } finally { cleanup(); }
});

// --- I9 / I10 / I11 / I12: CLI surface -------------------------------
test('I9: workflow runs lists ongoing by default, --all includes historical', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-historical', shortId: 'hst234' });
    const def = run(wf('runs'), { home });
    assert.equal(def.status, 0, def.stderr);
    assert.match(def.stdout, /no ongoing runs/);
    const all = run(wf('runs', '--all', '--json'), { home });
    assert.equal(all.status, 0, all.stderr);
    const j = JSON.parse(all.stdout);
    assert.equal(j.count, 1);
    assert.equal(j.runs[0].runId, 'wf-historical');
    const hist = run(wf('runs', '--historical'), { home });
    assert.equal(hist.status, 0, hist.stderr);
    assert.match(hist.stdout, /wf-historical/);
  } finally { cleanup(); }
});

test('I9: workflow runs --name <goal> filters by goal', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-a', shortId: 'aaa234', goal: 'a' });
    v2Run(home, { runId: 'wf-b', shortId: 'bbb345', goal: 'b' });
    const r = run(wf('runs', '--all', '--name', 'a', '--json'), { home });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.count, 1);
    assert.equal(j.runs[0].goal, 'a');
  } finally { cleanup(); }
});

test('I9: workflow runs filters by initiated time with inclusive since and exclusive until', () => {
  const { home, cleanup } = sandbox();
  try {
    historicalFixture(home, {
      runId: 'wf-before', shortId: 'abc234', startedAt: '2026-08-26T23:59:59.999Z',
    });
    historicalFixture(home, {
      runId: 'wf-lower-bound', shortId: 'def567', startedAt: '2026-08-27T00:00:00.000Z',
    });
    historicalFixture(home, {
      runId: 'wf-middle', shortId: 'ghj678', startedAt: '2026-08-27T12:00:00.000Z',
    });
    historicalFixture(home, {
      runId: 'wf-upper-bound', shortId: 'kmn789', startedAt: '2026-08-28T00:00:00.000Z',
    });

    const result = run(wf(
      'runs', '--all', '--started-after=2026-08-27T00:00:00Z',
      '--started-before', '2026-08-28T00:00:00Z', '--json',
    ), { home });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.initiatedRange.field, 'startedAt');
    assert.equal(json.initiatedRange.sinceInclusive, '2026-08-27T00:00:00.000Z');
    assert.equal(json.initiatedRange.untilExclusive, '2026-08-28T00:00:00.000Z');
    assert.deepEqual(json.runs.map((item) => item.runId), ['wf-middle', 'wf-lower-bound']);
  } finally { cleanup(); }
});

test('I9: workflow runs accepts relative since and falls back to report startedAt', () => {
  const { home, cleanup } = sandbox();
  try {
    historicalFixture(home, {
      runId: 'wf-recent', shortId: 'pqr789',
      startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      stateStartedAt: null,
    });
    historicalFixture(home, {
      runId: 'wf-old', shortId: 'stv789',
      startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });

    const result = run(wf('runs', '--all', '--since=7d', '--json'), { home });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.runs.map((item) => item.runId), ['wf-recent']);
    assert.ok(json.runs[0].startedAt);
  } finally { cleanup(); }
});

test('I9: workflow runs rejects invalid or reversed initiated-time ranges', () => {
  const { home, cleanup } = sandbox();
  try {
    const invalid = run(wf('runs', '--all', '--since', 'not-a-time'), { home });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--since has an invalid time/);

    const reversed = run(wf(
      'runs', '--all', '--from', '2026-08-28T00:00:00Z',
      '--to', '2026-08-27T00:00:00Z',
    ), { home });
    assert.equal(reversed.status, 2);
    assert.match(reversed.stderr, /--since must be earlier than --until/);
  } finally { cleanup(); }
});

test('I10: workflow runs show <id> accepts both shortId and full runId', () => {
  const { home, cleanup } = sandbox();
  try {
    const fixture = v2Run(home, { runId: 'wf-shown', shortId: 'shw234' });
    const byShort = run(wf('runs', 'show', 'shw234', '--json'), { home });
    assert.equal(byShort.status, 0, byShort.stderr);
    const j = JSON.parse(byShort.stdout);
    assert.equal(j.runId, 'wf-shown');
    assert.equal(j.shortId, 'shw234');
    const byFull = run(wf('runs', 'show', 'wf-shown'), { home });
    assert.equal(byFull.status, 0, byFull.stderr);
    assert.match(byFull.stdout, /wf-shown/);

    const resultRun = run(wf('runs', 'result', 'shw234', '--json'), { home });
    assert.equal(resultRun.status, 0, resultRun.stderr);
    const result = JSON.parse(resultRun.stdout);
    assert.equal(result.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(result.runId, 'wf-shown');
    assert.equal(result.shortId, 'shw234');
    assert.equal(result.status, 'completed');
    assert.deepEqual(result, fixture.result);
  } finally { cleanup(); }
});

test('I10: runs list, show, and result expose native autonomous V2 state', () => {
  const { home, cleanup } = sandbox();
  try {
    const fixture = autonomousV2Fixture(home);
    const listed = run(wf('runs', '--all', '--json'), { home });
    assert.equal(listed.status, 0, listed.stderr);
    const list = JSON.parse(listed.stdout);
    assert.equal(list.count, 1);
    assert.deepEqual(list.runs[0], {
      runId: 'wf-v2-result', shortId: 'v2r234', legacy: false, workflow: 'autonomous-v2',
      goal: 'Produce and prove a V2 artifact.', status: 'completed',
      startedAt: '2026-08-31T01:00:00.000Z', finishedAt: '2026-08-31T01:02:00.000Z',
      ongoing: false, actionsSucceeded: 2, actionsTotal: 2,
    });

    const shown = run(wf('runs', 'show', 'v2r234', '--json'), { home });
    assert.equal(shown.status, 0, shown.stderr);
    const show = JSON.parse(shown.stdout);
    assert.equal(show.state.schemaVersion, 'bullswarm.workflow.state.v2');
    assert.equal(show.report, null);
    assert.equal(show.ongoing, false);

    const resultJson = run(wf('runs', 'result', 'v2r234', '--json'), { home });
    assert.equal(resultJson.status, 0, resultJson.stderr);
    assert.deepEqual(JSON.parse(resultJson.stdout), fixture.result);
    const resultHuman = run(wf('runs', 'result', 'v2r234'), { home });
    assert.equal(resultHuman.status, 0, resultHuman.stderr);
    assert.match(resultHuman.stdout, /# status  completed  result ready/);
    assert.match(resultHuman.stdout, /# requirements  1\/1 passed/);
  } finally { cleanup(); }
});

test('I10: runs result rejects a malformed nested V2 result envelope', () => {
  const { home, cleanup } = sandbox();
  try {
    const fixture = autonomousV2Fixture(home);
    fixture.result.requirements[0] = {};
    writeFileSync(join(fixture.runDir, 'result.json'), JSON.stringify(fixture.result));
    const result = run(wf('runs', 'result', 'v2r234', '--json'), { home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /V2 result is invalid.*requirements\[0\]\.id/s);
  } finally { cleanup(); }
});

test('pre-0.27.0 terminal statuses stay terminal and delivered for replay', () => {
  assert.equal(isTerminalWorkflowStatus('completed_with_concerns'), true);
  assert.equal(isDeliveredWorkflowStatus('completed_with_concerns'), true);
  assert.equal(isTerminalWorkflowStatus('budget_exhausted'), true);
});

test('I11: workflow runs delete refuses without --yes, accepts with --yes', () => {
  const { home, cleanup } = sandbox();
  try {
    const { runDir } = v2Run(home, { runId: 'wf-deletable', shortId: 'dtx234' });
    const refuse = run(wf('runs', 'delete', 'dtx234'), { home });
    assert.notEqual(refuse.status, 0);
    assert.match(refuse.stdout + refuse.stderr, /without --yes/);
    const accept = run(wf('runs', 'delete', 'dtx234', '--yes'), { home });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(existsSync(runDir), false);
  } finally { cleanup(); }
});

test('I12: workflow resume resolves through the shortId resolver', () => {
  const { home, cleanup } = sandbox();
  try {
    const bogus = run(wf('resume', 'zzzzzz', '--json'), { home });
    assert.notEqual(bogus.status, 0, 'expected bogus shortId to fail');
    assert.match(bogus.stdout + bogus.stderr, /no run found for "zzzzzz"/);
    // A resolvable V2 run with no durable goal.json cannot be resumed either,
    // but it is named by its runId rather than reported as missing.
    v2Run(home, { runId: 'wf-resumable', shortId: 'rsm234' });
    const known = run(wf('resume', 'rsm234', '--json'), { home });
    assert.equal(known.status, 1);
    assert.match(known.stderr, /cannot resume wf-resumable/);
  } finally { cleanup(); }
});

// --- I13: BULLSWARM_DIR must be re-read per call (regression) -------
// `bullswarmDir` was previously captured at module-load time, which
// silently broke any operation that changed BULLSWARM_HOME after
// the module was first imported (e.g. set inside a subshell or a
// per-test sandbox). The fix is to read the env var on every call.
test('I13: BULLSWARM_DIR honors changes to BULLSWARM_HOME made after module load', () => {
  const { home: home1, cleanup: cleanup1 } = sandbox();
  try {
    v2Run(home1, { runId: 'wf-elsewhere', shortId: 'els234' });
    // Point BULLSWARM_HOME at a different sandbox and ask the CLI to find the
    // run by shortId. It MUST report not-found — proving the CLI read
    // BULLSWARM_HOME from the env at call time, not at module load.
    const { home: home2, cleanup: cleanup2 } = sandbox();
    try {
      const r2 = run(wf('runs', 'show', 'els234', '--json'), { home: home2 });
      assert.notEqual(r2.status, 0, 'shortId from another sandbox should not be found');
      assert.match(r2.stdout + r2.stderr, /no run found for "els234"/);
    } finally { cleanup2(); }
  } finally { cleanup1(); }
});

test('I13: same BULLSWARM_HOME across module load + call works', () => {
  // Sanity: when BULLSWARM_HOME is set BEFORE module load (the
  // common case), resolution still works.
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-fake', shortId: 'a8shqa' });
    const r = run(wf('runs', 'show', 'a8shqa'), { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wf-fake/);
  } finally { cleanup(); }
});

// --- I10: reasoning depth is visible in text mode, not only --json -----
test('I10: runs show prints each attempt with the reasoning level it ran at', () => {
  const { home, cleanup } = sandbox();
  try {
    const fixture = autonomousV2Fixture(home);
    const state = JSON.parse(readFileSync(join(fixture.runDir, 'state.json'), 'utf8'));
    state.attempts = [
      {
        id: 'produce-1', actionId: 'produce', ordinal: 1, status: 'succeeded',
        pool: 'alpha', model: 'alpha-sol',
        reasoning: { requested: 'max', applied: 'high', source: 'action', clamped: true },
         bytes: { taskFile: 3174, authorPrompt: 96, kernel: 2890, dependencyInputs: 62259, output: 15104 },
      },
      // A connector with no reasoning control prints no level rather than a
      // placeholder that would read as a real decision.
      { id: 'prove-1', actionId: 'prove', ordinal: 1, status: 'succeeded', pool: 'beta', model: 'beta-luna', reasoning: null },
    ];
    writeFileSync(join(fixture.runDir, 'state.json'), JSON.stringify(state));

    const shown = run(wf('runs', 'show', 'v2r234'), { home });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /# attempts {2}2/);
    assert.match(shown.stdout, /produce #1 {2}succeeded {2}alpha {2}alpha-sol {2}reasoning high \(action, clamped\) {2}in 3.1K\/60.8K out 14.8K/);
    assert.match(shown.stdout, /prove #1 {2}succeeded {2}beta {2}beta-luna$/m);
    assert.equal(/prove #1.*reasoning/.test(shown.stdout), false);
  } finally { cleanup(); }
});

// --- I13: `workflow reindex` backfills the rollup history index ---------
//
// Runs that finished before 0.33.0 have no rollup. reindex builds one from
// their durable state, writes it into the run directory, and appends it to
// ~/.bullswarm/history/runs.jsonl. A legacy pre-0.27.0 run has no V2 state,
// so it gets the minimal record instead: History is a timeline of every
// workflow, and a run with no record is a run that never shows up.

test('I13: reindex backfills finished V2 runs and legacy runs, skips the unfinished, and is idempotent', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-done-000001', shortId: 'done01', goal: 'first finished run' });
    v2Run(home, {
      runId: 'wf-done-000002', shortId: 'done02', goal: 'second finished run',
      startedAt: '2026-09-01T01:00:00.000Z', finishedAt: '2026-09-01T01:30:00.000Z',
    });
    // Ongoing: a live kernel heartbeat, no finishedAt.
    v2Run(home, {
      runId: 'wf-live-000003', shortId: 'live03', goal: 'still running', status: 'running',
      finishedAt: null, result: false,
      runner: { pid: process.pid, startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString() },
    });
    // Legacy: an authored-graph state.json with no V2 schemaVersion, and no
    // report.json — the little it recorded is all there is.
    const legacyDir = join(home, 'workflows', 'wf-legacy-000004');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({
      workflow: 'authored-graph', goal: 'old run', status: 'completed', startedAt: '2026-07-01T00:00:00.000Z',
    }));

    const first = run(wf('reindex', '--json'), { home });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.scanned, 4);
    assert.equal(report.written, 3, 'both finished V2 runs and the legacy run are rolled up');
    assert.equal(report.legacy, 1, 'counted as legacy, and no longer skipped');
    assert.equal(report.unfinished, 1, 'the ongoing run has no result to roll up yet');
    assert.equal(report.failed, 0);
    assert.equal(report.indexPath, join(home, 'history', 'runs.jsonl'));

    for (const runId of ['wf-done-000001', 'wf-done-000002']) {
      const record = JSON.parse(readFileSync(join(home, 'workflows', runId, 'rollup.json'), 'utf8'));
      assert.equal(record.schemaVersion, 'bullswarm.workflow.rollup.v1');
      assert.equal(record.runId, runId);
      assert.equal(record.legacy, false);
      assert.ok(record.minutes.wall > 0);
    }

    // The legacy record is minimal and marked: identity, the times its own
    // files prove, no cost and no pool minutes.
    const legacyRecord = JSON.parse(readFileSync(join(legacyDir, 'rollup.json'), 'utf8'));
    assert.equal(legacyRecord.legacy, true);
    assert.equal(legacyRecord.runId, 'wf-legacy-000004');
    assert.equal(legacyRecord.goal, 'authored-graph', 'the workflow name it recorded');
    assert.equal(legacyRecord.status, 'completed');
    assert.equal(legacyRecord.startedAt, '2026-07-01T00:00:00.000Z');
    assert.deepEqual(legacyRecord.pools, {}, 'no attempt was ever measured for a legacy run');
    assert.deepEqual(legacyRecord.models, {});
    assert.deepEqual(legacyRecord.requirements, { passed: 0, total: 0 });
    assert.equal(legacyRecord.verified, false);
    assert.equal(legacyRecord.minutes.wall, null, 'its finish time is a file time, which is not the run stopping');
    assert.equal(legacyRecord.timeSource, 'state+directory');
    assert.equal(existsSync(join(home, 'workflows', 'wf-live-000003', 'rollup.json')), false, 'an unfinished run has nothing to record');

    const lines = readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'one index line per run, the legacy run included');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).runId).sort(),
      ['wf-done-000001', 'wf-done-000002', 'wf-legacy-000004'],
    );

    // Running it again writes nothing new and leaves the index the same size:
    // every run directory is accounted for as already indexed or unfinished.
    const second = run(wf('reindex', '--json'), { home });
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.written, 0);
    assert.equal(secondReport.present, 3, 'all three rollups are already indexed');
    assert.equal(secondReport.skipped, 4, 'nothing was written: three present and one unfinished');
    assert.equal(readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8').trim().split('\n').length, 3);
    const afterSecond = run(wf('reindex'), { home });
    assert.match(afterSecond.stdout.trim(), /^✓ reindex: wrote 0, skipped 4 \(1 legacy, 1 unfinished, 3 already indexed\) of 4 run directories → /);

    // A deleted index is rebuilt from the records the run directories hold.
    rmSync(join(home, 'history'), { recursive: true, force: true });
    const repaired = JSON.parse(run(wf('reindex', '--json'), { home }).stdout);
    assert.equal(repaired.written, 3, 'a lost index is rebuilt from the run directories');
    assert.equal(readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8').trim().split('\n').length, 3);
  } finally { cleanup(); }
});

test('I13: reindex rolls up a legacy directory that has no state.json at all', () => {
  const { home, cleanup } = sandbox();
  try {
    const legacyDir = join(home, 'workflows', 'wf-legacy-nostate');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'report.json'), JSON.stringify({
      workflow: 'smoke-two-step', status: 'completed',
      startedAt: '2026-07-02T09:00:00.000Z', finishedAt: '2026-07-02T09:03:00.000Z',
    }));
    const report = JSON.parse(run(wf('reindex', '--json'), { home }).stdout);
    assert.equal(report.written, 1);
    assert.equal(report.legacy, 1);
    const record = JSON.parse(readFileSync(join(legacyDir, 'rollup.json'), 'utf8'));
    assert.equal(record.legacy, true);
    assert.equal(record.goal, 'smoke-two-step');
    assert.equal(record.minutes.wall, 3, 'both times came from the run report');
    assert.equal(record.timeSource, 'report');
  } finally { cleanup(); }
});

test('I13: reindex prints one plain summary line and refuses an unknown flag', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-plain-000001', shortId: 'plan01', goal: 'a finished run' });
    const plain = run(wf('reindex'), { home });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(
      plain.stdout.trim(),
      /^✓ reindex: wrote 1, skipped 0 \(0 legacy, 0 unfinished, 0 already indexed\) of 1 run directories → \S+runs\.jsonl$/,
    );
    const bogus = run(wf('reindex', '--bogus-flag'), { home });
    assert.equal(bogus.status, 2, bogus.stdout);
    assert.match(bogus.stderr, /unknown flag --bogus-flag/);
  } finally { cleanup(); }
});

test('I13: reindex records the project a run stamped at goal time, without touching git', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-proj-000001', shortId: 'proj01', goal: 'a finished run' });
    writeFileSync(join(home, 'workflows', 'wf-proj-000001', 'project.json'), JSON.stringify({
      schemaVersion: 'bullswarm.workflow.project.v1', name: 'bulldemo',
      remote: 'git@github.com:Bulls-Work/bulldemo.git', toplevel: '/gone', cwd: '/gone',
      recordedAt: '2026-09-01T00:00:00.000Z',
    }));
    assert.equal(run(wf('reindex', '--json'), { home }).status, 0);
    const record = JSON.parse(readFileSync(join(home, 'workflows', 'wf-proj-000001', 'rollup.json'), 'utf8'));
    assert.equal(record.project, 'bulldemo', 'the goal-time record outlives the checkout it names');
  } finally { cleanup(); }
});

test('I13: a partial run is terminal, indexes, and lists as finished', () => {
  const { home, cleanup } = sandbox();
  try {
    // 14 of the 190 V2 runs in the live home finished `partial`, and the V2
    // kernel's own terminal set (v2-runtime.js TERMINAL) has always included
    // it. The shared set now matches it, so nothing treats a partial run as
    // unfinished work.
    assert.equal(isTerminalWorkflowStatus('partial'), true, 'status.js and v2-runtime.js must agree');
    // The case the set decides: partial with no finish time of its own.
    v2Run(home, {
      runId: 'wf-partial-00001', shortId: 'part01', goal: 'a partial run',
      status: 'partial', finishedAt: null, result: false,
    });
    const report = JSON.parse(run(wf('reindex', '--json'), { home }).stdout);
    assert.equal(report.written, 1, 'the status word is the kernel saying it finished');
    assert.equal(report.unfinished, 0);
    const record = JSON.parse(readFileSync(join(home, 'workflows', 'wf-partial-00001', 'rollup.json'), 'utf8'));
    assert.equal(record.status, 'partial');
    assert.equal(record.legacy, false);

    // `workflow runs` lists it as finished: not ongoing, in the historical
    // set, and named with the status it finished on.
    const listed = JSON.parse(run(wf('runs', '--all', '--json'), { home }).stdout);
    assert.equal(listed.count, 1);
    assert.equal(listed.runs[0].status, 'partial');
    assert.equal(listed.runs[0].ongoing, false);
    assert.equal(listed.runs[0].finishedAt, null, 'the state never stamped one; it is not invented for the list');
    // The record reindex wrote does carry a finish time, because rollupRecord
    // has always stamped the moment it was asked about a terminal run with no
    // time of its own. That stamp is the reindex instant, not a claim about
    // when the run stopped, and it is the only derived time in the record.
    assert.ok(Number.isFinite(Date.parse(record.finishedAt)), `expected a stamped finish, got ${record.finishedAt}`);
    const ongoing = JSON.parse(run(wf('runs', '--json'), { home }).stdout);
    assert.equal(ongoing.count, 0, 'a partial run is not ongoing work');
    const historical = run(wf('runs', '--historical'), { home });
    assert.equal(historical.status, 0, historical.stderr);
    assert.match(historical.stdout, /wf-partial-00001/);
    assert.match(historical.stdout, /partial/);
  } finally { cleanup(); }
});

test('I13: reindex --force rewrites rollups that already exist', () => {
  const { home, cleanup } = sandbox();
  try {
    v2Run(home, { runId: 'wf-force-000001', shortId: 'frc001', goal: 'a finished run' });
    assert.equal(JSON.parse(run(wf('reindex', '--json'), { home }).stdout).written, 1);
    const rollupPath = join(home, 'workflows', 'wf-force-000001', 'rollup.json');
    // Simulate a record written by an older shape of this module.
    writeFileSync(rollupPath, JSON.stringify({ ...JSON.parse(readFileSync(rollupPath, 'utf8')), project: 'stale-name' }));
    // Without --force the run's own record is authoritative: it is left
    // exactly as it is, and the index is brought into line with it.
    run(wf('reindex', '--json'), { home });
    assert.equal(JSON.parse(readFileSync(rollupPath, 'utf8')).project, 'stale-name');
    assert.equal(
      JSON.parse(readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8').trim()).project, 'stale-name',
      'the index follows the record, never the other way round',
    );

    const forced = JSON.parse(run(wf('reindex', '--force', '--json'), { home }).stdout);
    assert.equal(forced.written, 1, '--force rebuilds the record from durable state');
    assert.notEqual(JSON.parse(readFileSync(rollupPath, 'utf8')).project, 'stale-name');
    assert.equal(readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { cleanup(); }
});

// --- R1: the Runs table shows active minutes, never the idle-inflated span --
//
// The real g6d6q2 record proves both numbers: its 19 attempt intervals union
// to 360.65 minutes of at-least-one-agent-working time, while the first start
// to the last finish spans 2234.93 minutes because the run restarted a day
// later. The Runs table must print 6h01m, and a record too old to carry the
// active union keeps only its span, which the row has to say out loud.
test('the Runs table prints a real history row\u2019s active minutes, not its span', () => {
  const record = rollupRecord(REAL_G6D6Q2, null, { project: 'bulldemo' });
  assert.equal(record.minutes.active, 360.65);
  assert.equal(record.minutes.span, 2234.93);
  const day = (row) => historyLines([{ date: '2026-09-19', runs: 1, finished: 1, rows: [row] }], { width: 200, ansi: false });
  const row = day(record).lines.filter((line) => line.includes('g6d6q2'));
  assert.equal(row.length, 1, 'the real run paints exactly one row');
  assert.match(row[0], /6h01m/);
  assert.doesNotMatch(row[0], /37h15m/);

  // A record written before 0.35 kept only the wall alias, which this release
  // made equal to the span. The value stays visible and is labelled `span`.
  const stored = { ...record, minutes: { wall: record.minutes.wall, agent: record.minutes.agent } };
  const old = day(stored).lines.filter((line) => line.includes('g6d6q2'));
  assert.match(old[0], /span 37h15m/);
});
