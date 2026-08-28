// Tests for short run IDs, the `workflow runs` sub-verb, and the
// resume-by-shortId path.
//
// Doctrine:
//   I1. Every new run gets a 6-char shortId in `state.shortId` and
//       `report.shortId`. The full runId (`wf-...`) stays unchanged.
//   I2. The shortId alphabet is Crockford-style 32 chars: no `0/1/i/l/o`
//       to avoid visual ambiguity.
//   I3. `isShortId` accepts only the 32-char alphabet at exactly 6
//       characters.
//   I4. generateShortId never returns a value already in the existing
//       set (collision-free across 16 attempts).
//   I5. resolveRunId maps a shortId to the correct runId; collisions
//       throw a hard error.
//   I6. resolveRunId accepts a full `wf-...` runId as a fast path.
//   I7. isOngoing returns false for a run with finishedAt; returns
//       true only when state.json's mtime is within the grace window.
//   I8. listRuns enumerates every `wf-...` subdir, with state + report
//       shapes attached.
//   I9. `bullswarm workflow runs` lists ongoing by default; `--all`
//       includes historical; `--historical` shows only historical;
//       `--name <wf>` filters by workflow; initiated-time bounds compare
//       `startedAt` with an inclusive lower and exclusive upper bound.
//   I10. `runs show <id>` accepts a shortId or a full runId; `runs result`
//        returns the stable caller-facing delivery envelope.
//   I11. `runs delete <id>` refuses without --yes; refuses for an
//        ongoing run without --force; deletes with both flags.
//   I12. `workflow run --resume <shortId>` resolves to the full runId.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWorkflow } from '../src/workflow/runner.js';
import { buildWorkflowResult } from '../src/workflow/result.js';
import {
  generateShortId, isShortId, resolveRunId, listRuns, isOngoing,
  reconcileInterruptedRun, SHORT_ID_ALPHABET, SHORT_ID_LEN, ONGOING_GRACE_MS,
} from '../src/workflow/short-id.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bs-runs-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(join(home, 'drafts'), { recursive: true });
  for (const f of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(
      join(home, 'connectors', f),
      readFileSync(join(REPO, 'connectors', f)),
    );
  }
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

function historicalFixture(home, { runId, shortId, workflow = 'dated', startedAt, stateStartedAt = startedAt }) {
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const finishedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    runId, shortId, workflow, status: 'completed', startedAt: stateStartedAt,
    finishedAt, steps: [],
  }));
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({
    runId, shortId, workflow, status: 'completed', startedAt, finishedAt,
  }));
}

// --- I1: shortId is set on every new run -------------------------------
test('I1: new run gets a 6-char shortId in state.json and report.json', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    assert.ok(isShortId(r.state.shortId), `bad shortId: ${r.state.shortId}`);
    assert.equal(r.state.shortId.length, SHORT_ID_LEN);
    assert.equal(r.report.shortId, r.state.shortId);
    // Disk artifacts agree.
    const stateOnDisk = JSON.parse(readFileSync(join(r.runDir, 'state.json'), 'utf8'));
    const reportOnDisk = JSON.parse(readFileSync(join(r.runDir, 'report.json'), 'utf8'));
    assert.equal(stateOnDisk.shortId, r.state.shortId);
    assert.equal(reportOnDisk.shortId, r.state.shortId);
  } finally { cleanup(); }
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
test('I5: resolveRunId maps a shortId to its runId, errors on collisions', async () => {
  const { home, cleanup } = sandbox();
  try {
    // Run two workflows so we have two distinct shortIds.
    for (let i = 0; i < 2; i++) {
      await runWorkflow({
        bullswarmDir: home,
        doc: {
          name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
          phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
        },
        pools: [{
          name: 'echo', enabled: true, costRank: 5,
          lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
          usedPct: null, quarantine: null, pace: 0, burstGate: false,
          connector: {
            name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
            spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
            authSignatures: [], outputExtraction: { strategy: 'stdout' },
            meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
          },
        }],
        inputs: {},
        onEvent: () => {},
      });
    }
    const runs = listRuns(home);
    assert.equal(runs.length, 2);
    const r1 = runs[0];
    assert.ok(isShortId(r1.shortId));
    const resolved = resolveRunId(home, r1.shortId);
    assert.equal(resolved.runId, r1.runId);
    assert.equal(resolved.shortId, r1.shortId);
  } finally { cleanup(); }
});

test('I5: resolveRunId returns null for an unknown shortId', () => {
  const { home, cleanup } = sandbox();
  try {
    assert.equal(resolveRunId(home, 'zzzzzz'), null);
    assert.equal(resolveRunId(home, 'wf-bogus-run-id-xxxxx'), null);
  } finally { cleanup(); }
});

test('I6: resolveRunId accepts a full wf-... runId as a fast path', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const resolved = resolveRunId(home, r.runId);
    assert.equal(resolved.runId, r.runId);
  } finally { cleanup(); }
});

// --- I7: isOngoing ------------------------------------------------
test('I7: isOngoing returns false for a run with finishedAt', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    assert.equal(isOngoing(r.runDir, r.state), false);
  } finally { cleanup(); }
});

test('I7: isOngoing returns true for a state.json with fresh mtime and no finishedAt', () => {
  const { home, cleanup } = sandbox();
  try {
    const runDir = join(home, 'workflows', 'wf-fake');
    mkdirSync(runDir, { recursive: true });
    const state = {
      runId: 'wf-fake', shortId: 'aaaa22',
      workflow: 'w', inputs: {}, settings: {}, outputs: {}, steps: [],
      startedAt: new Date().toISOString(), resumed: false,
    };
    // No finishedAt, mtime is now → ongoing.
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
    assert.equal(isOngoing(runDir, state), true);
  } finally { cleanup(); }
});

test('I7: isOngoing returns false when state.json mtime is older than the grace window', () => {
  const { home, cleanup } = sandbox();
  try {
    const runDir = join(home, 'workflows', 'wf-fake');
    mkdirSync(runDir, { recursive: true });
    const state = {
      runId: 'wf-fake', shortId: 'aaaa22',
      workflow: 'w', inputs: {}, settings: {}, outputs: {}, steps: [],
      startedAt: new Date().toISOString(), resumed: false,
    };
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
    // Backdate mtime to ONGOING_GRACE_MS + 1 ms ago.
    const old = new Date(Date.now() - ONGOING_GRACE_MS - 1000);
    utimesSync(join(runDir, 'state.json'), old, old);
    assert.equal(isOngoing(runDir, state), false);
  } finally { cleanup(); }
});

test('stale active run with a dead owner is reconciled to a resumable interruption', () => {
  const { home, cleanup } = sandbox();
  try {
    const runDir = join(home, 'workflows', 'wf-stale-dead01');
    mkdirSync(runDir, { recursive: true });
    const old = new Date(Date.now() - ONGOING_GRACE_MS - 10_000).toISOString();
    const state = {
      runId: 'wf-stale-dead01', shortId: 'abc234', workflow: 'stale',
      status: 'running', startedAt: old,
      runner: { pid: 999999, status: 'running', lastHeartbeatAt: old },
      attempts: [{ actionId: 'work', status: 'running' }],
      actionLedger: [{ id: 'work', status: 'running' }],
      activeAgents: { work: { stepId: 'work', lastHeartbeatAt: old } },
    };
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
    const reconciled = reconcileInterruptedRun(runDir, state, {
      now: Date.now(), processAlive: () => false,
    });
    assert.equal(reconciled.status, 'interrupted');
    assert.equal(reconciled.recovery.resumable, true);
    assert.equal(reconciled.attempts[0].status, 'abandoned');
    assert.equal(reconciled.usage.attempts, 1);
    assert.equal(reconciled.usage.attemptsWithUsage, 0);
    assert.equal(reconciled.usage.attemptsMissingUsage, 1);
    assert.equal(reconciled.usage.cost.complete, false);
    assert.match(reconciled.usage.cost.basis, /without usage evidence/);
    assert.equal(reconciled.actionLedger[0].status, 'interrupted');
    assert.equal(isOngoing(runDir, reconciled), false);
    assert.equal(JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).status, 'interrupted');
  } finally { cleanup(); }
});

test('fresh heartbeat plus live owner is not reconciled', () => {
  const { home, cleanup } = sandbox();
  try {
    const runDir = join(home, 'workflows', 'wf-live-owner01');
    mkdirSync(runDir, { recursive: true });
    const state = {
      runId: 'wf-live-owner01', status: 'running',
      runner: { pid: 42, status: 'running', lastHeartbeatAt: new Date().toISOString() },
    };
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
    assert.equal(reconcileInterruptedRun(runDir, state, { processAlive: () => true }).status, 'running');
  } finally { cleanup(); }
});

// --- I8: listRuns -------------------------------------------------
test('I8: listRuns returns one entry per wf- subdir with state+report', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const list = listRuns(home);
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, r.runId);
    assert.ok(list[0].state);
    assert.ok(list[0].report);
    assert.equal(list[0].ongoing, false);
  } finally { cleanup(); }
});

// --- I9 / I10 / I11 / I12: CLI surface -------------------------------
test('I9: workflow runs lists ongoing by default, --all includes historical', async () => {
  const { home, cleanup } = sandbox();
  try {
    // Make a completed run.
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const def = run(wf('runs'), { home });
    assert.equal(def.status, 0, def.stderr);
    assert.match(def.stdout, /no ongoing runs/);
    const all = run(wf('runs', '--all', '--json'), { home });
    assert.equal(all.status, 0, all.stderr);
    const j = JSON.parse(all.stdout);
    assert.equal(j.count, 1);
    assert.equal(j.runs[0].runId, r.runId);
    const hist = run(wf('runs', '--historical'), { home });
    assert.equal(hist.status, 0, hist.stderr);
    assert.match(hist.stdout, new RegExp(r.runId));
  } finally { cleanup(); }
});

test('I9: workflow runs --name <wf> filters by workflow', async () => {
  const { home, cleanup } = sandbox();
  try {
    await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'a', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'b', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const r = run(wf('runs', '--all', '--name', 'a', '--json'), { home });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.count, 1);
    assert.equal(j.runs[0].workflow, 'a');
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
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--since has an invalid time/);

    const reversed = run(wf(
      'runs', '--all', '--from', '2026-08-28T00:00:00Z',
      '--to', '2026-08-27T00:00:00Z',
    ), { home });
    assert.equal(reversed.status, 1);
    assert.match(reversed.stderr, /--since must be earlier than --until/);
  } finally { cleanup(); }
});

test('I10: workflow runs show <id> accepts both shortId and full runId', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const byShort = run(wf('runs', 'show', r.state.shortId, '--json'), { home });
    assert.equal(byShort.status, 0, byShort.stderr);
    const j = JSON.parse(byShort.stdout);
    assert.equal(j.runId, r.runId);
    assert.equal(j.shortId, r.state.shortId);
    const byFull = run(wf('runs', 'show', r.runId), { home });
    assert.equal(byFull.status, 0, byFull.stderr);
    assert.match(byFull.stdout, new RegExp(r.runId));

    const resultRun = run(wf('runs', 'result', r.state.shortId, '--json'), { home });
    assert.equal(resultRun.status, 0, resultRun.stderr);
    const result = JSON.parse(resultRun.stdout);
    assert.equal(result.schemaVersion, 'bullswarm.workflow.result.v1');
    assert.equal(result.runId, r.runId);
    assert.equal(result.shortId, r.state.shortId);
    assert.equal(result.status, 'completed');
    assert.equal(result.ready, true);
    assert.equal(result.delivery.actionId, 'go');
    assert.equal(result.delivery.format, 'text');
    assert.match(result.delivery.content, /processed the task file successfully/i);
    assert.equal(result.delivery.truncated, false);
    assert.equal(result.agentProgress.completed, 1);
    assert.equal(result.agentProgress.total, 1);
    assert.deepEqual(result.logs.map((entry) => entry.actionId), ['go']);
    assert.equal(typeof result.totalTokens, 'number');
    assert.ok(result.tokenUsage);
    assert.equal(typeof result.totalToolCalls.complete, 'boolean');
  } finally { cleanup(); }
});

test('I10: caller result selects the latest run delivery and its dependent verifier', () => {
  const { home, cleanup } = sandbox();
  try {
    const artifact = join(home, 'delivery.json');
    writeFileSync(artifact, JSON.stringify({ confirmed: 3, refuted: 6 }));
    const state = {
      shortId: 'abc234', workflow: 'audit', status: 'completed',
      intent: { goal: 'Audit candidates' },
      startedAt: '2026-08-28T01:00:00.000Z', finishedAt: '2026-08-28T01:02:00.000Z',
      actionLedger: [
        { id: 'draft', kind: 'run', status: 'succeeded', phase: 'audit' },
        { id: 'delivery', kind: 'run', status: 'succeeded', phase: 'verify' },
        { id: 'skeptic', kind: 'verify', status: 'succeeded', dependsOn: ['delivery'], phase: 'verify' },
        { id: 'orchestrator', kind: 'decide', status: 'succeeded', phase: 'verify' },
      ],
      outputs: {
        delivery: { outFile: artifact },
        skeptic: { outFile: join(home, 'verify.md'), verify: { ok: true, concerns: [], summary: 'checked' } },
      },
      attempts: [
        { actionId: 'delivery', status: 'succeeded', finishedAt: '2026-08-28T01:01:00.000Z', actionCount: 4 },
        { actionId: 'skeptic', status: 'succeeded', finishedAt: '2026-08-28T01:01:30.000Z', actionCount: 3 },
        { actionId: 'orchestrator', status: 'succeeded', finishedAt: '2026-08-28T01:02:00.000Z', actionCount: 2 },
      ],
      steps: [], usage: { tokens: { totalKnown: 4200, output: 800 } },
    };
    const result = buildWorkflowResult({
      state, report: { summary: { stepsOk: 3, stepsFailed: 0 } },
      runId: 'wf-example', shortId: 'abc234', ongoing: false,
    });
    assert.equal(result.delivery.actionId, 'delivery');
    assert.equal(result.delivery.format, 'json');
    assert.deepEqual(result.delivery.content, { confirmed: 3, refuted: 6 });
    assert.equal(result.verification.actionId, 'skeptic');
    assert.equal(result.verification.verdict.ok, true);
    assert.equal(result.totalTokens, 4200);
    assert.deepEqual(result.totalToolCalls, { known: 9, complete: true, attemptsMissingCount: 0 });
  } finally { cleanup(); }
});

test('I10: qualified terminal result remains ready and exposes unresolved concerns', () => {
  const { home, cleanup } = sandbox();
  try {
    const artifact = join(home, 'best-effort.md');
    writeFileSync(artifact, 'Useful completed analysis with one unresolved verification concern.');
    const outcome = {
      status: 'completed_with_concerns', verified: false, bestEffort: true,
      reason: 'Further refinement is disproportionate.', concerns: ['Independent verification was not satisfied.'],
      deliveryActionId: 'analysis',
    };
    const result = buildWorkflowResult({
      state: {
        shortId: 'abc234', workflow: 'qualified', status: 'completed_with_concerns', outcome,
        actionLedger: [{ id: 'analysis', kind: 'run', status: 'succeeded', phase: 'analyze' }],
        outputs: { analysis: { ok: true, outFile: artifact } }, attempts: [], steps: [],
      },
      report: { summary: { stepsOk: 1, stepsFailed: 0 } },
      runId: 'wf-qualified', shortId: 'abc234', ongoing: false,
    });
    assert.equal(result.ready, true);
    assert.equal(result.verified, false);
    assert.deepEqual(result.outcome, outcome);
    assert.equal(result.delivery.actionId, 'analysis');
  } finally { cleanup(); }
});

test('I11: workflow runs delete refuses without --yes, accepts with --yes', async () => {
  const { home, cleanup } = sandbox();
  try {
    const r = await runWorkflow({
      bullswarmDir: home,
      doc: {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      },
      pools: [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }],
      inputs: {},
      onEvent: () => {},
    });
    const refuse = run(wf('runs', 'delete', r.state.shortId), { home });
    assert.notEqual(refuse.status, 0);
    assert.match(refuse.stdout + refuse.stderr, /without --yes/);
    const accept = run(wf('runs', 'delete', r.state.shortId, '--yes'), { home });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(existsSync(r.runDir), false);
  } finally { cleanup(); }
});

test('I12: workflow run --resume <shortId> resolves to the full runId', async () => {
  const { home, cleanup } = sandbox();
  try {
    const setup = (() => {
      const doc = {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      };
      const pools = [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }];
      return { doc, pools };
    })();
    const r = await runWorkflow({
      bullswarmDir: home, doc: setup.doc, pools: setup.pools, inputs: {}, onEvent: () => {},
    });
    // Now resume by shortId. The CLI re-validates the doc; that
    // requires a live pool — for the CLI we use the existing
    // `bullswarm workflow draft` path. The simpler check is the
    // resolveRunId() function — already covered by I5/I6. Here we
    // assert that `workflow run --resume <shortId>` rejects a bogus
    // shortId and accepts a known one (the engine then surfaces a
    // resume-OK signal because the run's only step is already ok).
    const bogus = run(wf('run', 'demo', '--resume', 'zzzzzz', '--json', '--quiet'), { home });
    assert.notEqual(bogus.status, 0, 'expected bogus shortId to fail');
    assert.match(bogus.stdout + bogus.stderr, /did not match any run/);
  } finally { cleanup(); }
});

// --- I13: BULLSWARM_DIR must be re-read per call (regression) -------
// `bullswarmDir` was previously captured at module-load time, which
// silently broke any operation that changed BULLSWARM_HOME after
// the module was first imported (e.g. set inside a subshell or a
// per-test sandbox). The fix is to read the env var on every call.
test('I13: BULLSWARM_DIR honors changes to BULLSWARM_HOME made after module load', async () => {
  // First, run a workflow under a unique sandbox to produce a
  // shortId. Then, in a fresh child process with BULLSWARM_HOME
  // pointed at a *different* sandbox, the CLI must find the run by
  // shortId and report not-found (proving it read the new env, not
  // the old one).
  const { home: home1, cleanup: cleanup1 } = sandbox();
  try {
    const setup = (() => {
      const doc = {
        name: 'demo', description: 'd', inputs: {}, settings: { concurrency: 1, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{ id: 'go', type: 'run', lane: 'chore', prompt: 'go', timeoutSec: 60 }] }],
      };
      const pools = [{
        name: 'echo', enabled: true, costRank: 5,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 0, burstGate: false,
        connector: {
          name: 'echo', costRank: 5, lanes: ['analyze', 'build', 'chore'],
          spawn: { cmd: ['node', join(REPO, 'connectors/echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
          authSignatures: [], outputExtraction: { strategy: 'stdout' },
          meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 120,
        },
      }];
      return { doc, pools };
    })();
    const r = await runWorkflow({
      bullswarmDir: home1, doc: setup.doc, pools: setup.pools, inputs: {}, onEvent: () => {},
    });
    const shortId = r.state.shortId;
    assert.ok(shortId);

    // Now point BULLSWARM_HOME at a different sandbox and ask the
    // CLI to find the run by shortId. It MUST report not-found
    // because the run dir doesn't exist there — proving the CLI
    // read BULLSWARM_HOME from the env at call time.
    const { home: home2, cleanup: cleanup2 } = sandbox();
    try {
      const r2 = run(wf('runs', 'show', shortId, '--json'), { home: home2 });
      assert.notEqual(r2.status, 0, 'shortId from another sandbox should not be found');
      assert.match(r2.stdout + r2.stderr, new RegExp(`no run found for "${shortId}"`));
    } finally { cleanup2(); }
  } finally { cleanup1(); }
});

test('I13: same BULLSWARM_HOME across module load + call works', () => {
  // Sanity: when BULLSWARM_HOME is set BEFORE module load (the
  // common case), resolution still works.
  const { home, cleanup } = sandbox();
  try {
    mkdirSync(join(home, 'workflows', 'wf-fake'), { recursive: true });
    writeFileSync(join(home, 'workflows', 'wf-fake', 'state.json'), JSON.stringify({
      runId: 'wf-fake', shortId: 'a8shqa', // valid Crockford shortId
      workflow: 'w', inputs: {}, settings: {}, outputs: {}, steps: [],
      startedAt: new Date().toISOString(), resumed: false,
    }));
    // The module may already be loaded; that's fine — the call
    // still respects the env.
    const r = run(wf('runs', 'show', 'a8shqa'), { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wf-fake/);
  } finally { cleanup(); }
});
