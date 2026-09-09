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
