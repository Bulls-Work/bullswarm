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
import { appendEvent, readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { reopenV2RunForRetry, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
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
    // Stage 3 (D26): blocked dependents are listed inside the needs-you block.
    [{ type: 'action.finished', status: 'blocked' }, null],
    [{ type: 'needs-you', actionId: 'a', label: 'deliverable not produced' }, 'failed'],
    // A usage limit ends the step: its block wakes the caller like any other.
    [{ type: 'needs-you', actionId: 'a', label: 'out of quota', failureKind: 'quota', backAt: '2026-09-24T03:00:00.000Z' }, 'failed'],
    // A loop's verify.round with the caller covers a failed review.
    [{ type: 'evidence.recorded', loopMax: 1, requirements: [{ id: 'r1', status: 'failed' }] }, null],
    [{ type: 'evidence.recorded', loopMax: 3, requirements: [{ id: 'r1', status: 'failed' }] }, null],
    [{ type: 'step.accepted', actionId: 'a', reason: 'fine' }, null],
    [{ type: 'action.finished', status: 'cancelled', failureKind: 'paused' }, 'paused'],
    [{ type: 'action.finished', status: 'cancelled', failureKind: 'superseded' }, null],
    [{ type: 'action.finished', status: 'succeeded' }, null],
    [{ type: 'evidence.recorded', requirements: [{ id: 'r1', status: 'passed' }, { id: 'r2', status: 'blocked' }] }, 'rejected'],
    [{ type: 'evidence.recorded', requirements: [{ id: 'r1', status: 'passed' }] }, null],
    [{ type: 'plan.rejected', issues: [] }, 'rejected'],
    [{ type: 'planner.finished', ok: false }, 'rejected'],
    // A marked run's planner stopped by a usage limit or no free pool.
    [{ type: 'planner.finished', ok: false, stopped: true, failureKind: 'quota' }, 'planner-limit'],
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
  // In program runs a stall is not trouble: the needs-you block covers the
  // case with no retry left.
  assert.equal(watchTrouble({ type: 'attempt.stalled' }, { program: true }), null);
  assert.equal(watchTrouble({ type: 'attempt.stalled' }, { program: false }), 'stalled');
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

// Stage-2 proof labels (§2.10, §2.11): what backs a finished step, the
// retry after a failed check, and the proof line at the end of the run.
test('a succeeded step line names what backs it; an event without proof reads as before', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const finished = (proof, extra = {}) => ({ type: 'action.finished', payload: { actionId: 'integrate', status: 'succeeded', ...extra, ...(proof ? { proof } : {}) } });
  const events = [
    finished({ by: ['command'], reviewPending: false }),
    finished({ by: ['command', 'schema'], reviewPending: false }),
    finished({ by: ['command'], reviewPending: true }),
    finished({ by: [], reviewPending: true }),
    finished({ by: [], reviewPending: false }),
    finished({ by: ['review'], reviewPending: false }, { returnedEarly: { count: 2 } }),
    finished(null),
    finished(null, { returnedEarly: { count: 1 } }),
  ];
  const notable = notableWatchEvents({ events, state, nowMs: Date.parse(state.actions.find((action) => action.id === 'integrate').finishedAt) + 180_000 }).notable;
  const lines = notable.map((event) => renderWatchEvent(event));
  const duration = lines[6].split(' · ').at(-1);
  assert.deepEqual(lines, [
    `✓ integrate finished · proven by command · ${duration}`,
    `✓ integrate finished · proven by command, schema · ${duration}`,
    `✓ integrate finished · proven by command · review pending · ${duration}`,
    `✓ integrate finished · review pending · ${duration}`,
    `✓ integrate finished · unproven · ${duration}`,
    '◐ integrate returned early · 2 not done · proven by review',
    `✓ integrate finished · ${duration}`,
    '◐ integrate returned early · 1 not done',
  ]);
  // The notable entry carries the proof only when the event did; JSONL spreads it.
  assert.deepEqual(notable[0].proof, { by: ['command'], reviewPending: false });
  assert.equal(Object.hasOwn(notable[6], 'proof'), false);
  assert.equal(notable.every((event) => watchTrouble(event) === null), true, 'a label is never trouble');
  // A proof on a failed event (never written) is ignored.
  const failed = notableWatchEvents({ events: [{ type: 'action.finished', payload: { actionId: 'integrate', status: 'failed', failureKind: 'failed-evidence', why: 'x', proof: { by: [], reviewPending: false } } }], state }).notable[0];
  assert.equal(Object.hasOwn(failed, 'proof'), false);
});

test('failed-evidence reads as the existing failed line, and its same-pool retry has its own verbose line', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const why = 'node scripts/stamp.mjs log.md → changed the deliverable: log.md';
  assert.equal(
    renderWatchEvent({ type: 'action.finished', actionId: 'forever', status: 'failed', failureKind: 'failed-evidence', why, durationSec: 300 }),
    `✗ forever failed · failed-evidence: ${why} · 5m00s`,
  );
  const retried = [
    { type: 'attempt.finished', payload: { actionId: 'integrate', attemptId: 'integrate-1', status: 'interrupted', failureKind: 'failed-evidence', willRetry: true } },
    { type: 'attempt.started', payload: { actionId: 'integrate', attemptId: 'integrate-2', pool: 'example-pool', model: 'example-model' } },
  ];
  const verbose = notableWatchEvents({ events: retried, state, verbose: true }).notable.map((event) => renderWatchEvent(event));
  assert.equal(verbose[0], `${glyphs().reroute} integrate retrying · failed-evidence · same pool, failure attached`);
  assert.equal(notableWatchEvents({ events: retried, state }).notable.some((event) => event.type === 'attempt.retrying'), false, 'verbose only');
  // Without a retry (act step, second failure) nothing is remembered: a later
  // attempt the caller starts is not called a retry.
  const final = [
    { type: 'attempt.finished', payload: { actionId: 'integrate', attemptId: 'integrate-1', status: 'failed', failureKind: 'failed-evidence', willRetry: false } },
    { type: 'attempt.started', payload: { actionId: 'integrate', attemptId: 'integrate-2', pool: 'example-pool', model: 'example-model' } },
  ];
  assert.equal(notableWatchEvents({ events: final, state, verbose: true }).notable.some((event) => event.type === 'attempt.retrying'), false);
  // Other kinds keep today's line.
  assert.equal(renderWatchEvent({ type: 'attempt.retrying', actionId: 'integrate', failureKind: 'process' }), `${glyphs().reroute} integrate retrying · process`);
});

test('the final block prints the proof line after reason, and the JSONL record carries proof, only with the marker', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const finishedRun = (marked) => {
    const run = stagedRun(t, { nowMs });
    if (marked) writeFileSync(join(run.runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1 }));
    run.finish('completed');
    return run;
  };
  const plain = watch(finishedRun(false), { now: () => nowMs });
  assert.equal(await plain.promise, 0);
  assert.equal(plain.lines.some((line) => line.startsWith('proof:')), false, 'a saved run without the marker');
  const marked = watch(finishedRun(true), { now: () => nowMs });
  assert.equal(await marked.promise, 0);
  const reason = marked.lines.findIndex((line) => line.startsWith('reason: '));
  assert.ok(reason > 0, marked.lines.join('\n'));
  assert.equal(marked.lines[reason + 1], 'proof: 4 steps proven (review 4)');
  assert.deepEqual(marked.lines.filter((line) => line !== 'proof: 4 steps proven (review 4)'), plain.lines, 'nothing else changes');

  const jsonlPlain = watch(finishedRun(false), { jsonl: true, now: () => nowMs });
  assert.equal(await jsonlPlain.promise, 0);
  assert.equal(Object.hasOwn(JSON.parse(jsonlPlain.lines.at(-1)), 'proof'), false);
  const jsonlMarked = watch(finishedRun(true), { jsonl: true, now: () => nowMs });
  assert.equal(await jsonlMarked.promise, 0);
  const record = JSON.parse(jsonlMarked.lines.at(-1));
  assert.equal(record.type, 'finished');
  assert.deepEqual(record.proof, { proven: 4, byType: { command: 0, schema: 0, review: 4 }, unproven: 0, unprovenSteps: [] });
});

test('F23: a failed step that declares evidence and failed before it ran reads `evidence not run`; in a program run each failure is a needs-you block', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  state.program.actions.push(
    { id: 'widget', purpose: 'Build the widget', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Write widget.js.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], evidence: [{ type: 'command', cmd: 'node --test tests/widget.test.js' }] },
    { id: 'notes', purpose: 'Write notes', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Summarise.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [] },
  );
  const checked = [{ type: 'command', cmd: 'node --test tests/widget.test.js', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 900, tail: 'not ok 1', log: '/runs/acme/evidence-widget-attempt-1-1.log', why: 'exit 1' }];
  state.attempts.push(
    { id: 'widget-1', actionId: 'widget', ordinal: 1, status: 'failed', failureKind: 'failed-evidence', finishedAt: '2026-09-24T01:05:00.000Z', evidenceResults: checked },
    { id: 'widget-2', actionId: 'widget', ordinal: 2, status: 'failed', failureKind: 'process', finishedAt: '2026-09-24T01:09:00.000Z' },
    { id: 'notes-1', actionId: 'notes', ordinal: 1, status: 'failed', failureKind: 'process', finishedAt: '2026-09-24T01:09:00.000Z' },
  );
  const finished = (actionId, failureKind, why, committedAt) => ({ type: 'action.finished', committedAt, payload: { actionId, status: 'failed', failureKind, why } });
  const lines = notableWatchEvents({
    events: [
      finished('widget', 'failed-evidence', 'node --test tests/widget.test.js → exit 1: not ok 1', '2026-09-24T01:05:01.000Z'),
      finished('widget', 'process', 'worker exited with code 1', '2026-09-24T01:09:01.000Z'),
      finished('notes', 'process', 'worker exited with code 1', '2026-09-24T01:09:01.000Z'),
    ],
    state,
  }).notable.map((event) => renderWatchEvent(event, { terminal: true }).split('\n').slice(0, 2).join('\n'));
  // Stage 3 (D25): a failed program step reads as the needs-you block; each
  // block reads the attempts as they were when its event was committed.
  assert.deepEqual(lines, [
    `${glyphs().fail} widget needs you · command evidence failed · not retried\n  evidence  node --test tests/widget.test.js → exit 1`,
    `${glyphs().fail} widget needs you · worker exited with an error after 1 retry\n  why       worker exited with code 1 · evidence not run`,
    `${glyphs().fail} notes needs you · worker exited with an error · not retried\n  why       worker exited with code 1`,
  ]);
  // An event without the flag renders exactly as before.
  assert.equal(
    renderWatchEvent({ type: 'action.finished', actionId: 'notes', status: 'failed', failureKind: 'process', why: 'worker exited with code 1', durationSec: 300 }),
    `${glyphs().fail} notes failed · process: worker exited with code 1 · 5m00s`,
  );
});

// Stage 3 (§2.6): the accepted line, the plan revised `accepted` part, and the
// needs-you block in a live watch.
test('an accepted step, accepted requirements, and the plan revised `accepted` part', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const { notable } = notableWatchEvents({
    state,
    events: [
      { type: 'step.accepted', payload: { actionId: 'integrate', reason: 'the flaky test is known', requirements: null } },
      { type: 'step.accepted', payload: { actionId: 'verify', reason: 'good enough', requirements: ['requirement-1', 'requirement-2'] } },
      { type: 'program.revised', payload: { source: 'step-accept', programRevision: 4, summary: 'accept integrate: "the flaky test is known"', changes: { accepted: ['integrate'] } } },
    ],
  });
  assert.deepEqual(notable.map((event) => renderWatchEvent(event)), [
    '✓ integrate accepted by choice · "the flaky test is known"',
    '✓ requirement-1 accepted by choice on verify · "good enough"\n✓ requirement-2 accepted by choice on verify · "good enough"',
    `${glyphs().plan} plan revised (revision 4) · accept integrate: "the flaky test is known" · accepted integrate`,
  ]);
  assert.equal(notable.every((event) => watchTrouble(event) === null), true);
});

test('--until trouble wakes on the needs-you block of a failed program step and relaunches from its cursor', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  const cursor = run.state.events.sequence;
  Object.assign(run.state.actions.find((action) => action.id === 'verify'), { status: 'failed', finishedAt: new Date(nowMs).toISOString(), lastFailure: { kind: 'process', message: 'worker exited with code 1' } });
  Object.assign(run.state.attempts.find((entry) => entry.id === 'verify-1'), { status: 'failed', failureKind: 'process', finishedAt: new Date(nowMs).toISOString() });
  run.emit('action.finished', { actionId: 'verify', status: 'failed', failureKind: 'process', why: 'worker exited with code 1', attemptIds: ['verify-1'], retries: 0 });
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  const lines = watcher.lines;
  assert.equal(lines[0], '✗ verify needs you · worker exited with an error · not retried');
  assert.ok(lines.includes('  your call:'), lines.join('\n'));
  assert.equal(lines.at(-1), `next: bullswarm workflow watch ${SHORT} --until trouble --after ${cursor + 1} --since ${new Date(nowMs).toISOString()}`);
  const jsonl = watch(run, { until: 'trouble', afterSequence: cursor, jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  const records = jsonl.lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.type, record.sequence]), [['needs-you', cursor + 1]]);
  assert.equal(records[0].label, 'worker exited with an error');
});

// A usage limit ends the step and goes to the caller (owner decision,
// 2026-09-25): the needs-you block says when the pool is back, and waiting for
// it is one of the caller's options. Bullswarm never waits by itself.
test('--until trouble wakes on the needs-you block of a usage limit, which says when the step can run again', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  writeFileSync(join(run.runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }));
  const cursor = run.state.events.sequence;
  const backAt = new Date(nowMs + 90 * 60_000).toISOString();
  const why = `usage limit: "You've hit your session limit" · pool paused until ${backAt}`;
  Object.assign(run.state.actions.find((action) => action.id === 'verify'), {
    status: 'failed', finishedAt: new Date(nowMs).toISOString(), lastFailure: { kind: 'quota', message: why, retryAfter: backAt },
  });
  Object.assign(run.state.attempts.find((entry) => entry.id === 'verify-1'), { status: 'failed', failureKind: 'quota', finishedAt: new Date(nowMs).toISOString() });
  run.emit('action.finished', { actionId: 'verify', status: 'failed', failureKind: 'quota', why, retryAfter: backAt, attemptIds: ['verify-1'], retries: 0 });
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  const lines = watcher.lines;
  assert.deepEqual(lines.slice(0, 3), [
    '✗ verify needs you · out of quota · not retried',
    `  why       ${why}`,
    `  back at   ${backAt}`,
  ]);
  assert.ok(lines.includes(`    wait for it      after ${backAt}: bullswarm workflow step rerun ${SHORT} verify`), lines.join('\n'));
  assert.equal(lines.at(-1), `next: bullswarm workflow watch ${SHORT} --until trouble --after ${cursor + 1} --since ${new Date(nowMs).toISOString()}`);
  const jsonl = watch(run, { until: 'trouble', afterSequence: cursor, jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  const records = jsonl.lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.type, record.sequence]), [['needs-you', cursor + 1]]);
  assert.deepEqual([records[0].failureKind, records[0].backAt, records[0].options.waitForIt],
    ['quota', backAt, `after ${backAt}: bullswarm workflow step rerun ${SHORT} verify`]);
});

test('no free pool when the step is picked is a needs-you block too; without a known return it offers no wait', (t) => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  state.program.actions.push({ id: 'notes', purpose: 'Write notes', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Summarise.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [] });
  // A marked run: the watcher reads the marker from the run directory.
  const runDir = mkdtempSync(join(tmpdir(), 'bs-watch-marked-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }));
  const backAt = '2026-09-24T03:00:00.000Z';
  const finished = (extra) => ({
    type: 'action.finished', committedAt: '2026-09-24T01:00:00.000Z',
    payload: { actionId: 'notes', status: 'failed', failureKind: 'unavailable', attemptIds: [], retries: 0, ...extra },
  });
  // A bench after a sign-in failure is not a usage limit: the step reads as
  // unavailable (a lone nearly spent pool would read as quota).
  const benched = finished({ why: `no pool free: pool-a benched until ${backAt}`, retryAfter: backAt });
  const [block] = notableWatchEvents({ events: [benched], state, runDir }).notable;
  assert.equal(block.type, 'needs-you');
  assert.equal(block.backAt, backAt);
  assert.equal(watchTrouble(block), 'failed');
  const text = renderWatchEvent(block).split('\n');
  assert.deepEqual(text.slice(0, 3), [
    '✗ notes needs you · no eligible pool · not retried',
    `  why       no pool free: pool-a benched until ${backAt}`,
    `  back at   ${backAt}`,
  ]);
  assert.ok(text.includes(`    wait for it      after ${backAt}: bullswarm workflow step rerun ${SHORT} notes`), text.join('\n'));
  // No known return: no back-at line and no wait option. The dispatcher's
  // words: a pause with no end reads `paused`; a pool the step already failed
  // on is named only after an attempt, in the ` · no retry: ` tail of its why.
  state.attempts.push({
    id: 'notes-1', actionId: 'notes', ordinal: 1, status: 'failed', failureKind: 'process', pool: 'pool-a', model: 'model-a',
    startedAt: '2026-09-24T00:58:00.000Z', finishedAt: '2026-09-24T00:59:00.000Z',
  });
  const unknowns = [
    finished({ why: 'no pool free: pool-a paused' }),
    finished({ failureKind: 'process', why: 'worker exited 1 · no retry: pool-a already failed on this step', attemptIds: ['notes-1'] }),
  ];
  for (const event of unknowns) {
    const [unknown] = notableWatchEvents({ events: [event], state, runDir }).notable;
    assert.equal(unknown.type, 'needs-you', event.payload.why);
    assert.equal(Object.hasOwn(unknown, 'backAt'), false, event.payload.why);
    assert.equal(watchTrouble(unknown), 'failed');
    const lines = renderWatchEvent(unknown).split('\n');
    assert.ok(lines.includes(`  why       ${event.payload.why}`), lines.join('\n'));
    assert.equal(lines.some((line) => /back at|wait for it/.test(line)), false, lines.join('\n'));
  }
  // A run without the marker prints no return time, even when the event has one.
  const [plain] = notableWatchEvents({ events: [benched], state }).notable;
  assert.equal(plain.type, 'needs-you');
  assert.equal(Object.hasOwn(plain, 'backAt'), false);
  assert.equal(Object.hasOwn(plain.options, 'waitForIt'), false);
  assert.equal(renderWatchEvent(plain).split('\n').some((line) => /back at|wait for it/.test(line)), false);
});

// The owner's rule covers the preflight scout too (2026-09-25): in a marked
// run a scout that stops on a usage limit, or finds no pool free, is not moved
// to another pool. The watch prints one line for it and wakes the caller.
test('a marked run\'s scout stopped by a usage limit or no free pool is a trouble line; other scout ends and unmarked runs print nothing new', () => {
  const MARKED = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  const back = '2026-09-24T03:00:00.000Z';
  const base = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const scoutState = (actions) => ({
    ...base,
    program: { ...base.program, actions },
    preflight: { scout: {
      status: 'failed', startedAt: '2026-09-24T00:50:00.000Z', finishedAt: '2026-09-24T01:00:00.000Z', outputFile: null, lastFailure: null,
      attempts: [
        { ordinal: 1, status: 'failed', failureKind: 'throttle', pool: 'pool-a', startedAt: '2026-09-24T00:50:00.000Z', finishedAt: '2026-09-24T00:51:00.000Z' },
        { ordinal: 2, status: 'failed', failureKind: 'quota', pool: 'pool-b', startedAt: '2026-09-24T00:52:00.000Z', finishedAt: '2026-09-24T01:00:00.000Z' },
        // A later scout after a resume: not the one the replayed event closed.
        { ordinal: 3, status: 'failed', failureKind: 'quota', pool: 'pool-c', startedAt: '2026-09-24T05:00:00.000Z', finishedAt: '2026-09-24T05:01:00.000Z' },
      ],
    } },
  });
  const noProgram = scoutState([]);
  const withProgram = scoutState(base.program.actions);
  const stopped = (extra) => ({
    type: 'preflight.scout_finished', committedAt: '2026-09-24T01:00:01.000Z',
    payload: { status: 'failed', failureKind: 'quota', why: 'usage window spent: provider said "You\'ve hit your session limit"', ...extra },
  });
  const notables = (event, state = noProgram, features = MARKED) => notableWatchEvents({ events: [event], state, features }).notable;
  // Out of quota, with the pool's return: the run (no program yet) finishes.
  const [quota] = notables(stopped({ retryAfter: back }));
  assert.deepEqual(quota, {
    type: 'preflight.scout_finished', status: 'failed', failureKind: 'quota', label: 'out of quota', pool: 'pool-b',
    retryAfter: back, why: 'usage window spent: provider said "You\'ve hit your session limit"', runContinues: false,
  });
  assert.equal(renderWatchEvent(quota), `⚠ preflight scout stopped · out of quota on pool-b · back at ${back}`);
  assert.equal(watchTrouble(quota), 'scout-limit');
  assert.equal(watchTrouble(quota, { program: true }), 'scout-limit');
  // With the caller's program the run goes on without the report.
  const [continues] = notables(stopped({ retryAfter: back }), withProgram);
  assert.equal(renderWatchEvent(continues), `⚠ preflight scout stopped · out of quota on pool-b · back at ${back} · the run continues without its report`);
  // A rate limit with no known return prints no back at.
  const [throttle] = notables(stopped({ failureKind: 'throttle', why: 'rate limited (transient): "429 Too Many Requests"' }));
  assert.equal(throttle.retryAfter, null);
  assert.equal(renderWatchEvent(throttle), '⚠ preflight scout stopped · rate limited on pool-b');
  // No pool free when the scout was picked: no attempt ran, so no pool.
  const [none] = notables(stopped({ failureKind: 'unavailable', why: `no pool with quota to spare: pool-a paused for quota until ${back}`, retryAfter: back }), withProgram);
  assert.equal(none.pool, null);
  assert.equal(renderWatchEvent(none), `⚠ preflight scout stopped · no eligible pool on no pool · back at ${back} · the run continues without its report`);
  assert.equal(watchTrouble(none), 'scout-limit');
  // A pool on the event is the one printed.
  assert.equal(notables(stopped({ pool: 'pool-d' }))[0].pool, 'pool-d');
  // The kernel's decision on the event wins over the state: a replay of a run
  // that finished at its scout and was revised later (it has a program now)
  // still reads that it finished, and the other way round.
  const [finishedThen] = notables(stopped({ retryAfter: back, runContinues: false }), withProgram);
  assert.equal(finishedThen.runContinues, false);
  assert.equal(renderWatchEvent(finishedThen), `⚠ preflight scout stopped · out of quota on pool-b · back at ${back}`);
  const [wentOn] = notables(stopped({ retryAfter: back, runContinues: true }), noProgram);
  assert.equal(wentOn.runContinues, true);
  assert.equal(renderWatchEvent(wentOn), `⚠ preflight scout stopped · out of quota on pool-b · back at ${back} · the run continues without its report`);
  // Anything but a boolean is not the kernel's field: the state decides.
  assert.equal(notables(stopped({ runContinues: 'no' }), withProgram)[0].runContinues, true);
  // The marker is read from the run directory when no features are given.
  const runDir = mkdtempSync(join(tmpdir(), 'bs-watch-scout-'));
  try {
    writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
    const [read] = notableWatchEvents({ events: [stopped({})], state: noProgram, runDir }).notable;
    assert.equal(read.type, 'preflight.scout_finished');
    assert.equal(read.runContinues, false);
    // A caller's --program waits in the run directory until the kernel applies
    // it just after the scout: a state read before that already continues.
    writeFileSync(join(runDir, 'initial-planner-response.json'), JSON.stringify({ kind: 'program' }));
    const [pending] = notableWatchEvents({ events: [stopped({})], state: noProgram, runDir }).notable;
    assert.equal(pending.runContinues, true);
    assert.ok(renderWatchEvent(pending).endsWith(' · the run continues without its report'), renderWatchEvent(pending));
  } finally { rmSync(runDir, { recursive: true, force: true }); }
  // Any other scout end prints nothing new.
  for (const payload of [{ status: 'succeeded' }, { status: 'failed', failureKind: 'process', why: 'worker exited 1' }, { status: 'failed', failureKind: 'schema' }]) {
    assert.deepEqual(notables({ type: 'preflight.scout_finished', payload }), [], JSON.stringify(payload));
  }
  // Unmarked runs are unchanged: no line, no wake.
  assert.deepEqual(notables(stopped({ retryAfter: back }), noProgram, {}), []);
  assert.deepEqual(notableWatchEvents({ events: [stopped({ retryAfter: back })], state: noProgram }).notable, []);
});

test('--until trouble wakes on a marked run\'s scout stopped by a usage limit and relaunches from its cursor', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  writeFileSync(join(run.runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }));
  const cursor = run.state.events.sequence;
  const back = new Date(nowMs + 90 * 60_000).toISOString();
  run.state.preflight.scout = {
    status: 'failed', startedAt: new Date(nowMs - 60_000).toISOString(), finishedAt: new Date(nowMs).toISOString(), outputFile: null, lastFailure: null,
    attempts: [{ ordinal: 1, status: 'failed', failureKind: 'quota', pool: 'pool-a', startedAt: new Date(nowMs - 60_000).toISOString(), finishedAt: new Date(nowMs).toISOString() }],
  };
  run.emit('preflight.scout_finished', { status: 'failed', failureKind: 'quota', why: 'usage window spent', retryAfter: back });
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  assert.deepEqual(watcher.lines, [
    `⚠ preflight scout stopped · out of quota on pool-a · back at ${back} · the run continues without its report`,
    `next: bullswarm workflow watch ${SHORT} --until trouble --after ${cursor + 1} --since ${new Date(nowMs).toISOString()}`,
  ]);
  const jsonl = watch(run, { until: 'trouble', afterSequence: cursor, jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  const records = jsonl.lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.type, record.sequence, record.failureKind, record.pool, record.retryAfter, record.runContinues]),
    [['preflight.scout_finished', cursor + 1, 'quota', 'pool-a', back, true]]);
});

test('a replay from the start (--after 0) of a run revised after its scout stopped reads the scout line from the event, not the program added later', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  writeFileSync(join(run.runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }));
  const back = new Date(nowMs + 90 * 60_000).toISOString();
  run.state.preflight.scout = {
    status: 'failed', startedAt: new Date(nowMs - 60_000).toISOString(), finishedAt: new Date(nowMs).toISOString(), outputFile: null, lastFailure: null,
    attempts: [{ ordinal: 1, status: 'failed', failureKind: 'quota', pool: 'pool-a', startedAt: new Date(nowMs - 60_000).toISOString(), finishedAt: new Date(nowMs).toISOString() }],
  };
  // The run finished at its scout; the staged state has a program now, as a
  // later plan revise leaves it.
  assert.ok(run.state.program.actions.length > 0);
  run.emit('preflight.scout_finished', { status: 'failed', failureKind: 'quota', why: 'usage window spent', retryAfter: back, runContinues: false });
  const scoutLines = (lines) => lines.filter((line) => line.includes('preflight scout stopped'));
  const watcher = watch(run, { until: 'trouble', afterSequence: 0, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  assert.deepEqual(scoutLines(watcher.lines), [`⚠ preflight scout stopped · out of quota on pool-a · back at ${back}`]);
  const jsonl = watch(run, { until: 'trouble', afterSequence: 0, jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  const records = jsonl.lines.map((line) => JSON.parse(line)).filter((record) => record.type === 'preflight.scout_finished');
  assert.deepEqual(records.map((record) => [record.failureKind, record.pool, record.retryAfter, record.runContinues]), [['quota', 'pool-a', back, false]]);
});

// The same rule for a marked run's dispatched Workflow Planner (2026-09-25): a
// stop on a usage limit, a rate limit that did not clear, or no free pool is
// one line with its pool and return time, not a rejected planning attempt.
test('a marked run\'s planner stopped by a usage limit or no free pool is its own trouble line; other planner failures and unmarked runs read as before', () => {
  const MARKED = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  const back = '2026-09-24T03:00:00.000Z';
  const why = 'usage window spent: provider said "You\'ve hit your session limit"';
  const base = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const state = {
    ...base,
    planner: { ...base.planner, status: 'failed', attempts: [
      { ordinal: 1, turn: 1, status: 'succeeded', pool: 'pool-a', startedAt: '2026-09-24T00:10:00.000Z', finishedAt: '2026-09-24T00:20:00.000Z' },
      { ordinal: 2, turn: 2, status: 'interrupted', failureKind: 'throttle', pool: 'pool-b', startedAt: '2026-09-24T00:50:00.000Z', finishedAt: '2026-09-24T00:51:00.000Z' },
      { ordinal: 3, turn: 2, status: 'failed', failureKind: 'quota', pool: 'pool-b', startedAt: '2026-09-24T00:52:00.000Z', finishedAt: '2026-09-24T01:00:00.000Z' },
      // A later turn after a revise: not the one the replayed event closed.
      { ordinal: 4, turn: 3, status: 'failed', failureKind: 'quota', pool: 'pool-c', startedAt: '2026-09-24T05:00:00.000Z', finishedAt: '2026-09-24T05:01:00.000Z' },
    ] },
  };
  const stopped = (extra) => ({
    type: 'planner.finished', committedAt: '2026-09-24T01:00:01.000Z',
    payload: { turn: 2, ok: false, failureKind: 'quota', why, ...extra },
  });
  const notables = (event, features = MARKED) => notableWatchEvents({ events: [event], state, features }).notable;
  // Out of quota, with the pool's return.
  const [quota] = notables(stopped({ retryAfter: back }));
  assert.deepEqual(quota, {
    type: 'planner.finished', ok: false, turn: 2, failureKind: 'quota', stopped: true,
    label: 'out of quota', pool: 'pool-b', retryAfter: back, why,
  });
  assert.equal(renderWatchEvent(quota), `✗ planner stopped · out of quota on pool-b · back at ${back}`);
  assert.equal(watchTrouble(quota), 'planner-limit');
  assert.equal(watchTrouble(quota, { program: true }), 'planner-limit');
  // A return time given as epoch ms is carried as ISO.
  assert.equal(notables(stopped({ retryAfter: Date.parse(back) }))[0].retryAfter, back);
  // A rate limit with no known return prints no back at.
  const [throttle] = notables(stopped({ failureKind: 'throttle', why: 'rate limited (transient): "429 Too Many Requests"' }));
  assert.equal(throttle.retryAfter, null);
  assert.equal(renderWatchEvent(throttle), '✗ planner stopped · rate limited on pool-b');
  assert.equal(watchTrouble(throttle), 'planner-limit');
  // No pool free when the planner was picked: no attempt ran, so no pool.
  const [none] = notables(stopped({ failureKind: 'unavailable', why: `no pool free: pool-a benched until ${back}`, retryAfter: back }));
  assert.equal(none.pool, null);
  assert.equal(renderWatchEvent(none), `✗ planner stopped · no eligible pool on no pool · back at ${back}`);
  assert.equal(watchTrouble(none), 'planner-limit');
  // A pool on the event is the one printed; with no commit time the turn's last attempt is.
  assert.equal(notables(stopped({ pool: 'pool-d' }))[0].pool, 'pool-d');
  assert.equal(notables({ type: 'planner.finished', payload: stopped({}).payload })[0].pool, 'pool-b');
  // The marker is read from the run directory when no features are given.
  const runDir = mkdtempSync(join(tmpdir(), 'bs-watch-planner-'));
  try {
    const [unmarkedDir] = notableWatchEvents({ events: [stopped({ retryAfter: back })], state, runDir }).notable;
    assert.equal(renderWatchEvent(unmarkedDir), `× planning attempt rejected · ${why}`);
    writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
    const [read] = notableWatchEvents({ events: [stopped({ retryAfter: back })], state, runDir }).notable;
    assert.equal(renderWatchEvent(read), `✗ planner stopped · out of quota on pool-b · back at ${back}`);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
  // Any other planner failure keeps the rejected line, and carries no return time.
  for (const payload of [
    { turn: 2, ok: false, failureKind: 'schema', why: 'the planner response failed validation' },
    { turn: 2, ok: false, failureKind: 'auth', why: 'not logged in' },
    { turn: 2, ok: false, failureKind: 'invalid', why: 'empty program' },
  ]) {
    const [line] = notables({ type: 'planner.finished', payload });
    assert.deepEqual(line, { type: 'planner.finished', ok: false, turn: 2, failureKind: payload.failureKind, why: payload.why }, payload.failureKind);
    assert.equal(renderWatchEvent(line), `× planning attempt rejected · ${payload.why}`);
    assert.equal(watchTrouble(line), 'rejected');
  }
  // Unmarked runs are unchanged, whatever the event carries.
  const [plain] = notables(stopped({ retryAfter: back }), {});
  assert.deepEqual(plain, { type: 'planner.finished', ok: false, turn: 2, failureKind: 'quota', why });
  assert.equal(renderWatchEvent(plain), `× planning attempt rejected · ${why}`);
  assert.equal(watchTrouble(plain), 'rejected');
  assert.deepEqual(notableWatchEvents({ events: [stopped({ retryAfter: back })], state }).notable, [plain]);
});

test('--until trouble wakes on a marked run\'s planner stopped by a usage limit, and the JSONL object carries its return time', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  writeFileSync(join(run.runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }));
  const cursor = run.state.events.sequence;
  const back = new Date(nowMs + 90 * 60_000).toISOString();
  run.state.planner = {
    ...run.state.planner, status: 'failed',
    attempts: [{ ordinal: 1, turn: 2, status: 'failed', failureKind: 'quota', pool: 'pool-a', startedAt: new Date(nowMs - 60_000).toISOString(), finishedAt: new Date(nowMs).toISOString() }],
  };
  run.emit('planner.finished', { turn: 2, ok: false, failureKind: 'quota', why: 'usage window spent', retryAfter: back });
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  assert.deepEqual(watcher.lines, [
    `✗ planner stopped · out of quota on pool-a · back at ${back}`,
    `next: bullswarm workflow watch ${SHORT} --until trouble --after ${cursor + 1} --since ${new Date(nowMs).toISOString()}`,
  ]);
  const jsonl = watch(run, { until: 'trouble', afterSequence: cursor, jsonl: true, now: () => nowMs });
  assert.equal(await jsonl.promise, 0);
  const records = jsonl.lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.type, record.sequence, record.ok, record.stopped, record.failureKind, record.label, record.pool, record.retryAfter]),
    [['planner.finished', cursor + 1, false, true, 'quota', 'out of quota', 'pool-a', back]]);
});

// A marked run's quota line: a usage limit sends the step to the caller; a
// saved stage-3 attempt that promised a retry spent none. Unmarked runs keep
// their tail. A saved why that names a pause reads `back at` that time.
test('a marked run\'s usage-limit line reads `back to you`, or `no retry spent` on a saved attempt; an unmarked run keeps its tail', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const why = 'usage limit · pool paused until 2026-09-24T03:00:00.000Z';
  const line = (extra) => {
    const [notable] = notableWatchEvents({
      events: [{ type: 'attempt.finished', payload: { actionId: 'verify', attemptId: 'verify-1', status: 'failed', failureKind: 'quota', why, ...extra } }], state,
    }).notable;
    return renderWatchEvent(notable, { now: Date.parse('2026-09-20T01:00:00.000Z') });
  };
  const head = '⚠ verify usage limit on claude-code · back at 2026-09-24T03:00:00.000Z · ';
  assert.equal(line({ failureRule: true, willRetry: false }), `${head}back to you`);
  assert.equal(line({ failureRule: true, willRetry: true }), `${head}no retry spent`);
  // A saved stage-3 decision to move or wait no longer changes the line.
  assert.equal(line({ failureRule: true, willRetry: true, quotaNext: 'move' }), `${head}no retry spent`);
  assert.equal(line({ failureRule: true, willRetry: true, quotaNext: 'wait' }), `${head}no retry spent`);
  assert.equal(line({ willRetry: true }), `${head}retrying on another pool`);
  assert.equal(line({ willRetry: false }), `${head}no retry left`);
});

// Saved stage-3 runs may hold a waiting step and `action.waiting` events. The
// watcher reads them without a line or a wake: waiting is no longer news.
test('a saved run\'s old action.waiting event is not a line and wakes nothing; the watch follows the run to its outcome', async (t) => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const old = { type: 'action.waiting', committedAt: '2026-09-24T01:00:00.000Z', payload: { actionId: 'verify', until: '2026-09-24T03:00:00.000Z', pools: ['pool-a'], reason: 'quota' } };
  assert.deepEqual(notableWatchEvents({ events: [old], state }).notable, []);
  const nowMs = minutesAfterLastEvent(1);
  const saved = () => {
    const run = stagedRun(t, { nowMs });
    const cursor = run.state.events.sequence;
    Object.assign(run.state.actions.find((action) => action.id === 'verify'), { status: 'waiting' });
    Object.assign(run.state.attempts.find((entry) => entry.id === 'verify-1'), { status: 'failed', failureKind: 'quota', finishedAt: new Date(nowMs).toISOString() });
    run.emit('action.waiting', { actionId: 'verify', until: new Date(nowMs + 120 * 60_000).toISOString(), pools: ['pool-a'], reason: 'quota' });
    return { run, cursor };
  };
  // Attached with no cursor: the waiting step is counted, never replayed.
  const plain = saved();
  const follow = watch(plain.run, { now: () => nowMs, intervalMs: 20 });
  await eventually(() => follow.lines.length > 0, 'the attach line');
  await sleep(80);
  plain.run.finish('completed');
  assert.equal(await follow.promise, 0);
  assert.match(follow.lines[0], /^.+ watching .+ · 0 running, 1 waiting · /);
  assert.equal(follow.lines.some((line) => /waiting for|back at|⧖/.test(line)), false, follow.lines.join('\n'));
  assert.ok(follow.lines.includes('outcome: completed · verified'), follow.lines.join('\n'));
  // --until trouble from a cursor before the old event: replayed, not printed, no wake.
  const replay = saved();
  const until = watch(replay.run, { until: 'trouble', afterSequence: replay.cursor, now: () => nowMs, intervalMs: 20 });
  await sleep(120);
  replay.run.finish('completed');
  assert.equal(await until.promise, 0);
  assert.equal(until.lines[0], 'outcome: completed · verified', until.lines.join('\n'));
  assert.equal(until.lines.at(-1), `next: bullswarm workflow runs result ${SHORT} --json --summary`);
  assert.equal(until.lines.some((line) => /waiting for|back at|⧖|^next: bullswarm workflow watch/.test(line)), false, until.lines.join('\n'));
});

test('a run that ended in the same poll prints the block without your call or next, then the outcome', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  const cursor = run.state.events.sequence;
  Object.assign(run.state.actions.find((action) => action.id === 'verify'), { status: 'failed', finishedAt: new Date(nowMs).toISOString() });
  Object.assign(run.state.attempts.find((entry) => entry.id === 'verify-1'), { status: 'failed', failureKind: 'process', finishedAt: new Date(nowMs).toISOString() });
  run.emit('action.finished', { actionId: 'verify', status: 'failed', failureKind: 'process', why: 'worker exited with code 1' });
  run.state.lifecycle = { ...run.state.lifecycle, status: 'failed', finishedAt: new Date(nowMs).toISOString() };
  run.save();
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 1);
  const lines = watcher.lines;
  assert.equal(lines[0], '✗ verify needs you · worker exited with an error · not retried');
  assert.equal(lines.some((line) => line === '  your call:' || line.startsWith('next: bullswarm workflow watch')), false, lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('outcome: failed')), lines.join('\n'));
});

// Owner decision (2026-09-25): a marked run whose dispatched planner or scout
// stopped on a limit comes back with `workflow resume` among the caller's
// options, the "wait" option: after the return time it runs that dispatch
// again. The outcome block prints it from the result, as it prints any option.
test('the outcome of a marked run whose planner or scout stopped on a usage limit offers the resume that runs it again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-limit-stop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, 'repo');
  mkdirSync(cwd);
  const reset = '2099-01-01T00:00:00.000Z';
  const why = `usage limit: "You've hit your session limit" · pool paused until ${reset}`;
  for (const [scout, runId, who] of [[false, 'wf-wlstp1-abcdef', 'the workflow planner'], [true, 'wf-wlstp2-abcdef', 'the preflight scout']]) {
    const goalDocument = createV2GoalDocument({
      goal: 'Deliver the report', cwd, requirements: [{ id: 'deliver', text: 'report.md exists' }],
      settings: { executionMode: 'program', workspaceMode: 'shared', scout, concurrency: 1 },
    });
    const run = await runV2AutonomousWorkflow({
      bullswarmDir: home, goalDocument, pools: [], runId, parentEnv: {},
      dependencies: {
        refreshPools: async () => null,
        dispatchV2Action: async () => ({ ok: false, status: 'failed', failureKind: 'quota', retryAfter: reset, attempts: [], verdict: { ok: false, why, meta: { exitCode: null } } }),
      },
    });
    const token = run.state.shortId;
    const retry = `bullswarm workflow resume ${token} after ${reset} (reruns ${who})`;
    let output = '';
    assert.equal(await runWorkflowWatch(home, token, { intervalMs: 20, output: { write: (text) => { output += text; } } }), 1, output);
    const lines = output.split('\n').filter(Boolean);
    const outcome = lines.indexOf('outcome: partial · not verified');
    assert.ok(outcome >= 0, output);
    assert.equal(lines[outcome + 1], `reason: ${who} stopped on a usage limit: ${why} · back at ${reset} · your call: resume after ${reset} with bullswarm workflow resume ${token}, `
      + `plan it yourself with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`, who);
    const call = lines.indexOf('your call:');
    assert.ok(call > outcome, output);
    assert.ok(lines.slice(call).includes(`  retry     ${retry}`), output);
    // The JSONL finished record carries the same option.
    let jsonl = '';
    await runWorkflowWatch(home, token, { intervalMs: 20, jsonl: true, output: { write: (text) => { jsonl += text; } } });
    const finished = jsonl.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.type === 'finished');
    assert.equal(finished.handback.options.retry, retry, who);
    // Resume reopens the run to run the stopped dispatch again, and the watch
    // says resume did it, not a plan revision.
    assert.equal(reopenV2RunForRetry({ bullswarmDir: home, runId }).status, 'reopened', who);
    const runDir = join(home, 'workflows', runId);
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const reopened = notableWatchEvents({ events: readEvents(runDir), state, runDir }).notable.filter((event) => event.type === 'run.reopened');
    assert.deepEqual(reopened, [{ type: 'run.reopened', previousStatus: 'partial', source: 'resume' }], who);
    assert.equal(renderWatchEvent(reopened[0]), `${glyphs().started} run reopened from partial by workflow resume`, who);
  }
  // A plan revision's reopen reads as before.
  assert.equal(renderWatchEvent({ type: 'run.reopened', previousStatus: 'cancelled' }), `${glyphs().started} run reopened from cancelled by a plan revision`);
});

// A planner or scout that stopped on a usage limit and was run again by
// `workflow resume` starts a new dispatch: its first attempt is not a move of
// the stopped one, so the watch never prints "now on <pool>" for it.
test('a planner or scout run again after its limit stop prints no move line', () => {
  for (const [who, started, finished, ended] of [
    ['workflow-planner', 'planner.attempt_started', 'planner.attempt_finished', { type: 'planner.finished', payload: { turn: 1, ok: false, failureKind: 'quota', retryAfter: '2099-01-01T00:00:00.000Z' } }],
    ['preflight-scout', 'preflight.scout_attempt_started', 'preflight.scout_attempt_finished', { type: 'preflight.scout_finished', payload: { status: 'failed', failureKind: 'quota', retryAfter: '2099-01-01T00:00:00.000Z', runContinues: false } }],
  ]) {
    let sequence = 0;
    const at = (minute) => `2026-09-25T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const event = (type, payload, minute) => ({ sequence: ++sequence, type, committedAt: at(minute), payload });
    const events = [
      event(started, { turn: 1, ordinal: 1, pool: 'lim', model: 'm' }, 1),
      event(finished, { turn: 1, ordinal: 1, status: 'failed', failureKind: 'quota' }, 2),
      { ...ended, sequence: ++sequence, committedAt: at(3) },
      event('workflow.reopened', { previousStatus: 'partial', source: 'resume', requeued: [who] }, 4),
      event(started, { turn: 1, ordinal: 2, pool: 'lim', model: 'm' }, 5),
    ];
    const state = {
      runId: 'wf-nomove-abcdef', shortId: 'nomove', attempts: [], actions: [], program: { actions: [] },
      planner: { attempts: who === 'workflow-planner' ? [{ ordinal: 1, turn: 1, pool: 'lim', startedAt: at(1), finishedAt: at(2) }, { ordinal: 2, turn: 1, pool: 'lim', startedAt: at(5) }] : [] },
      preflight: { scout: { attempts: who === 'preflight-scout' ? [{ ordinal: 1, pool: 'lim', startedAt: at(1), finishedAt: at(2) }, { ordinal: 2, pool: 'lim', startedAt: at(5) }] : [] } },
    };
    const { notable } = notableWatchEvents({ events, state, features: { failureRule: 1 } });
    assert.equal(notable.some((item) => item.type === 'attempt.moved'), false, `${who}: ${JSON.stringify(notable)}`);
    assert.equal(notable.some((item) => item.type === 'attempt.quota'), true, who);
  }
});
