// `workflow watch` as a caller's background watch: the stale line, `--until
// outcome|trouble`, and how a caller-driven restart reads. The run is a real
// finished run from the scrubbed fixture home (tests/fixtures/home-351),
// staged as it was while its last step, `verify` on claude-code, was still
// running: the step's persisted stream is the real one, and the watcher's
// clock is set to minutes after its last recorded event.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialWatchMemory, notableWatchEvents, renderWatchEvent, runWorkflowWatch, watchTrouble,
} from '../src/workflow/watch-cli.js';
import { appendEvent } from '../src/workflow/events.js';
import { createStaleProbe } from '../src/lib/stale.js';
import { glyphs } from '../src/lib/glyphs.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = 'wf-mu8thu2e-27c504';
const SHORT = 'euqrni';
const SOURCE = join(ROOT, 'tests', 'fixtures', 'home-351', 'workflows', RUN);
const STREAM = readFileSync(join(SOURCE, 'stream-verify-attempt-1.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const LAST_EVENT_MS = Date.parse(STREAM.at(-1).at);
const minutesAfterLastEvent = (minutes) => LAST_EVENT_MS + minutes * 60_000;

// The real run, rewound to the moment its verify attempt was still running.
function stagedRun(t, { nowMs }) {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-until-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runDir = join(home, 'workflows', RUN);
  mkdirSync(dirname(runDir), { recursive: true });
  cpSync(SOURCE, runDir, { recursive: true });
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  state.intent.cwd = mkdtempSync(join(tmpdir(), 'bs-watch-until-cwd-'));
  t.after(() => rmSync(state.intent.cwd, { recursive: true, force: true }));
  state.lifecycle = { ...state.lifecycle, status: 'running', finishedAt: null, resultFile: null };
  Object.assign(state.actions.find((action) => action.id === 'verify'), { status: 'running', finishedAt: null });
  const attempt = state.attempts.find((entry) => entry.id === 'verify-1');
  Object.assign(attempt, {
    status: 'running', finishedAt: null, taskFile: join(runDir, 'task-verify-attempt-1.md'),
    lastActivityAt: STREAM.at(-1).at, lastEventAt: STREAM.at(-1).at,
  });
  delete attempt.streamFile;
  state.runner = { ...(state.runner ?? {}), pid: process.pid, lastHeartbeatAt: new Date(nowMs).toISOString() };
  const save = () => writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  save();
  return {
    home, runDir, state, save,
    emit(type, payload) { appendEvent(runDir, state, type, payload); save(); },
    finish(status = 'completed') {
      Object.assign(state.actions.find((action) => action.id === 'verify'), { status: 'succeeded', finishedAt: new Date(nowMs).toISOString() });
      Object.assign(attempt, { status: 'succeeded', finishedAt: new Date(nowMs).toISOString() });
      state.lifecycle = { ...state.lifecycle, status, finishedAt: new Date(nowMs).toISOString(), resultFile: join(runDir, 'result.json') };
      save();
    },
  };
}

function watch(run, options) {
  let output = '';
  const promise = runWorkflowWatch(run.home, SHORT, {
    intervalMs: 50, ...options, output: { write: (text) => { output += text; } },
  });
  return { promise, get lines() { return output.split('\n').filter(Boolean); } };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(check, what) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await sleep(15); }
  throw new Error(`timed out waiting for ${what}`);
}

test('--until trouble prints only the stale line, then the relaunch and restart lines', async (t) => {
  const nowMs = minutesAfterLastEvent(12);
  const run = stagedRun(t, { nowMs });
  const watcher = watch(run, { until: 'trouble', now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  const at = new Date(nowMs).toISOString();
  assert.deepEqual(watcher.lines, [
    '⚠ verify looks stale: quiet 12m with no command running',
    `next: bullswarm workflow watch ${SHORT} --until trouble --after 33 --since ${at}`,
    `  or restart: bullswarm workflow step restart ${SHORT} verify`,
  ]);
  // The machine form carries the reasons and the cursor, and no human next line.
  const jsonl = watch(run, { until: 'trouble', jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  assert.equal(jsonl.lines.length, 1);
  const event = JSON.parse(jsonl.lines[0]);
  assert.deepEqual(
    { type: event.type, actionId: event.actionId, attemptId: event.attemptId, pool: event.pool, reasons: event.reasons, sequence: event.sequence, staleSince: event.staleSince },
    { type: 'attempt.stale', actionId: 'verify', attemptId: 'verify-1', pool: 'claude-code', reasons: ['quiet 12m with no command running'], sequence: 33, staleSince: new Date(minutesAfterLastEvent(10)).toISOString() },
  );
});

test('--next wakes on the stale line and hands over the restart command too', async (t) => {
  const nowMs = minutesAfterLastEvent(12);
  const run = stagedRun(t, { nowMs });
  const watcher = watch(run, { next: true, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  // Plain event mode keeps its raw silence line (it counts a long command as
  // silence); the stale line is the judgement with reasons.
  assert.deepEqual(watcher.lines, [
    '⚠ verify silent for 12m00s · claude-code/claude-opus-5 · still running, not auto-killed',
    '⚠ verify looks stale: quiet 12m with no command running',
    `next: bullswarm workflow watch ${SHORT} --next --after 33 --since ${new Date(nowMs).toISOString()}`,
    `  or restart: bullswarm workflow step restart ${SHORT} verify`,
  ]);
});

test('--until outcome keeps following through trouble, skips routine lines, and ends at the outcome', async (t) => {
  // Nine minutes of quiet is not yet stale.
  const nowMs = minutesAfterLastEvent(9);
  const run = stagedRun(t, { nowMs });
  const watcher = watch(run, { until: 'outcome', now: () => nowMs });
  await sleep(200);
  assert.deepEqual(watcher.lines, [], 'no attach line, nothing while all is well');
  run.emit('evidence.recorded', { actionId: 'verify', requirements: ['requirement-1', 'requirement-2'], statuses: { 'requirement-1': 'passed', 'requirement-2': 'failed' } });
  run.emit('action.finished', { actionId: 'verify', status: 'succeeded' });
  await eventually(() => watcher.lines.length >= 1, 'the evidence line');
  await sleep(150);
  assert.deepEqual(watcher.lines, [`${glyphs().evidence} verify evidence · requirement-1 passed, requirement-2 failed`]);
  run.finish('completed');
  assert.equal(await watcher.promise, 0);
  assert.equal(watcher.lines[1], 'outcome: completed · verified');
  assert.equal(watcher.lines.at(-1), `next: bullswarm workflow runs result ${SHORT} --json --summary`);
  assert.equal(watcher.lines.some((line) => /verify finished|watching/.test(line)), false);
});

test('a relaunched --until watcher does not repeat a stale line its predecessor printed', async (t) => {
  const nowMs = minutesAfterLastEvent(12);
  const run = stagedRun(t, { nowMs });
  // The previous watcher exited at +11m, after the step went stale at +10m.
  const quiet = watch(run, { until: 'trouble', afterSequence: 33, sinceMs: minutesAfterLastEvent(11), now: () => nowMs });
  await sleep(250);
  assert.deepEqual(quiet.lines, []);
  run.finish('completed');
  assert.equal(await quiet.promise, 0);
  assert.equal(quiet.lines[0], 'outcome: completed · verified');
  // One that exited at +9m, before it went stale, did not see it: this one does.
  const run2 = stagedRun(t, { nowMs });
  const fresh = watch(run2, { until: 'trouble', afterSequence: 33, sinceMs: minutesAfterLastEvent(9), now: () => nowMs });
  assert.equal(await fresh.promise, 0);
  assert.equal(fresh.lines[0], '⚠ verify looks stale: quiet 12m with no command running');
});

test('one stale line per attempt, from the probe the watcher is given', () => {
  const run = { state: JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8')) };
  const attempt = { ...run.state.attempts.find((entry) => entry.id === 'verify-1'), status: 'running', finishedAt: null };
  const state = { ...run.state, attempts: [...run.state.attempts.filter((entry) => entry.id !== 'verify-1'), attempt] };
  let calls = 0;
  const stale = () => { calls += 1; return { stale: true, score: 2, staleSince: minutesAfterLastEvent(10), reasons: ['quiet 12m with no command running'] }; };
  const staleLines = (collected) => collected.notable.filter((event) => event.type === 'attempt.stale').map((event) => renderWatchEvent(event));
  const first = notableWatchEvents({ state, stale, nowMs: minutesAfterLastEvent(12), memory: initialWatchMemory(state) });
  assert.deepEqual(staleLines(first), ['⚠ verify looks stale: quiet 12m with no command running']);
  const second = notableWatchEvents({ state, stale, nowMs: minutesAfterLastEvent(13), memory: first.memory });
  assert.deepEqual(staleLines(second), []);
  assert.equal(calls, 1, 'an attempt already reported is not scored again');
  // Once the attempt stops running it is forgotten; without a probe nothing is scored.
  const finished = { ...state, attempts: state.attempts.map((entry) => (entry.id === 'verify-1' ? { ...entry, status: 'succeeded' } : entry)) };
  assert.equal(notableWatchEvents({ state: finished, stale, memory: second.memory }).memory.staleReported.size, 0);
  assert.deepEqual(staleLines(notableWatchEvents({ state, memory: initialWatchMemory(state) })), []);
  // The real probe agrees on the staged run's stream.
  const probeDir = mkdtempSync(join(tmpdir(), 'bs-watch-probe-'));
  try {
    writeFileSync(join(probeDir, 'stream-verify-attempt-1.jsonl'), readFileSync(join(SOURCE, 'stream-verify-attempt-1.jsonl')));
    const probe = createStaleProbe({ runDir: probeDir });
    const live = { ...attempt, taskFile: join(probeDir, 'task-verify-attempt-1.md'), streamFile: undefined, lastActivityAt: null, lastEventAt: null };
    assert.equal(probe({ attempt: live, action: state.program.actions.find((entry) => entry.id === 'verify'), state, nowMs: minutesAfterLastEvent(12) }).reasons[0], 'quiet 12m with no command running');
  } finally { rmSync(probeDir, { recursive: true, force: true }); }
});

test('trouble is a failed, rejected, paused, stalled or stale line, or steering for the caller', () => {
  const kinds = [
    [{ type: 'action.finished', status: 'failed' }, 'failed'],
    [{ type: 'action.finished', status: 'blocked' }, 'failed'],
    [{ type: 'action.finished', status: 'cancelled', failureKind: 'paused' }, 'paused'],
    [{ type: 'action.finished', status: 'cancelled', failureKind: 'superseded' }, null],
    [{ type: 'action.finished', status: 'succeeded' }, null],
    [{ type: 'evidence.recorded', requirements: [{ id: 'r1', status: 'passed' }, { id: 'r2', status: 'blocked' }] }, 'rejected'],
    [{ type: 'evidence.recorded', requirements: [{ id: 'r1', status: 'passed' }] }, null],
    [{ type: 'plan.rejected', issues: [] }, 'rejected'],
    [{ type: 'planner.finished', ok: false }, 'rejected'],
    [{ type: 'planner.finished', ok: true }, null],
    [{ type: 'attempt.stalled' }, 'stalled'],
    [{ type: 'attempt.stale' }, 'stale'],
    [{ type: 'pause.requested' }, 'paused'],
    [{ type: 'steering.received' }, 'steering'],
    // The watcher's raw silence line counts a long command as silence; the
    // stale score replaces it for --until.
    [{ type: 'agent.stalled' }, null],
    [{ type: 'attempt.quota', willRetry: true }, null],
    [{ type: 'stage.completed' }, null],
    [{ type: 'step.restarted' }, null],
  ];
  for (const [event, kind] of kinds) assert.equal(watchTrouble(event), kind, JSON.stringify(event));
});

test('a caller restart reads as one restart line and one handoff line, never a cancelled step', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const events = [
    { type: 'attempt.finished', payload: { actionId: 'verify', attemptId: 'verify-1', status: 'cancelled', failureKind: 'restarted', pool: 'claude-code' } },
    { type: 'action.finished', payload: { actionId: 'verify', status: 'cancelled', failureKind: 'restarted' } },
    { type: 'step.restarted', payload: { requestId: 'restart-1a2b3c4d', actionId: 'verify', attemptId: 'verify-1', stoppedPool: 'claude-code', pool: 'codex' } },
    { type: 'attempt.started', payload: { actionId: 'verify', attemptId: 'verify-2', pool: 'codex', model: 'gpt-5.4', handoff: { from: 'verify-1', bytes: 1200, pool: 'claude-code', files: 0, lastSaid: 'checking the rollup totals' } } },
  ];
  for (const verbose of [false, true]) {
    const lines = notableWatchEvents({ events, state, verbose }).notable.map((event) => renderWatchEvent(event));
    assert.deepEqual(lines.filter((line) => !line.includes(' started · ')), [
      '↻ verify restarted · stopped verify-1 on claude-code · runs again with its handoff on codex',
      '↪ verify handed off from claude-code · 0 files · last said "checking the rollup totals"',
    ], `verbose ${verbose}`);
  }
  assert.equal(
    renderWatchEvent({ type: 'step.restart_refused', actionId: 'verify', why: 'it finished before the restart took effect' }),
    '× verify not restarted · it finished before the restart took effect',
  );
});

test('an early return prints `◐ <step> returned early · N not done` instead of the finished line, and is not trouble', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const events = [
    { type: 'action.finished', payload: { actionId: 'verify', status: 'succeeded', returnedEarly: { count: 2 } } },
    { type: 'action.finished', payload: { actionId: 'verify', status: 'succeeded' } },
  ];
  const notable = notableWatchEvents({ events, state }).notable.filter((event) => event.type === 'action.finished');
  assert.equal(notable[0].returnedEarly, 2);
  assert.equal(Object.hasOwn(notable[1], 'returnedEarly'), false, 'each finish reads its own event');
  const lines = notable.map((event) => renderWatchEvent(event));
  assert.equal(lines[0], '◐ verify returned early · 2 not done');
  assert.match(lines[1], /^✓ verify finished · /);
  assert.equal(watchTrouble(notable[0]), null, 'the step still succeeded');
  assert.equal(glyphs({ BULLSWARM_ASCII: '1' }).early, '-');
  const previous = process.env.BULLSWARM_ASCII;
  process.env.BULLSWARM_ASCII = '1';
  try { assert.equal(renderWatchEvent(notable[0]), '- verify returned early · 2 not done'); }
  finally { if (previous === undefined) delete process.env.BULLSWARM_ASCII; else process.env.BULLSWARM_ASCII = previous; }
});
