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
    // Stage 3 (D26): blocked dependents are listed inside the needs-you block.
    [{ type: 'action.finished', status: 'blocked' }, null],
    [{ type: 'needs-you', actionId: 'a', label: 'deliverable not produced' }, 'failed'],
    // A loop's verify.round with the caller covers a failed review.
    [{ type: 'evidence.recorded', loopMax: 1, requirements: [{ id: 'r1', status: 'failed' }] }, null],
    [{ type: 'evidence.recorded', loopMax: 3, requirements: [{ id: 'r1', status: 'failed' }] }, null],
    [{ type: 'action.waiting', waitSec: 29 * 60 }, null],
    [{ type: 'action.waiting', waitSec: 31 * 60 }, 'waiting'],
    [{ type: 'step.accepted', actionId: 'a', reason: 'fine' }, null],
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

// Stage 3 (§2.6, D24): the waiting line, the accepted line, the plan revised
// `accepted` part, and the needs-you block in a live watch.
test('a waiting step prints one line; more than 30 minutes away it adds the options and is trouble', () => {
  const state = JSON.parse(readFileSync(join(SOURCE, 'state.json'), 'utf8'));
  const committedAt = '2026-09-24T01:00:00.000Z';
  const waiting = (minutes, reason, pools = ['pool-a']) => ({
    type: 'action.waiting', committedAt,
    payload: { actionId: 'verify', until: new Date(Date.parse(committedAt) + minutes * 60_000).toISOString(), pools, reason },
  });
  const render = (event) => {
    const [notable] = notableWatchEvents({ events: [event], state }).notable;
    return { notable, text: renderWatchEvent(notable, { now: Date.parse(committedAt) }) };
  };
  const back = (minutes) => `(?:\\d\\d:\\d\\d|${new Date(Date.parse(committedAt) + minutes * 60_000).toISOString().replace(/\./g, '\\.')})`;
  const short = render(waiting(10, 'hold'));
  assert.match(short.text, new RegExp(`^⧖ verify waiting for quota · pool-a back at ${back(10)} \\(in 10m00s\\)$`));
  assert.equal(watchTrouble(short.notable), null, 'a short wait is not a decision');
  const hold = render(waiting(120, 'hold'));
  assert.equal(watchTrouble(hold.notable), 'waiting');
  assert.deepEqual(hold.text.split('\n').slice(1), [
    `  or change the step: bullswarm workflow plan export ${SHORT} --out plan.json → plan revise ${SHORT} --program plan.json`,
    `  or run it elsewhere: bullswarm workflow step rerun ${SHORT} verify --avoid pool-a`,
  ]);
  const paused = render(waiting(120, 'quota', ['pool-a', 'pool-b']));
  assert.match(paused.text.split('\n')[0], new RegExp(`^⧖ verify waiting for quota · first back: pool-a at ${back(120)} \\(in 2h00m\\)$`));
  assert.equal(paused.text.split('\n')[2], '  or lift the pause:  bullswarm pools resume pool-a');
  assert.match(render(waiting(10, 'bench')).text, /^⧖ verify waiting for a pool · /);
  // In --until modes the option lines follow even a short wait.
  const [shortNotable] = notableWatchEvents({ events: [waiting(10, 'hold')], state }).notable;
  assert.equal(renderWatchEvent(shortNotable, { now: Date.parse(committedAt), untilMode: true }).split('\n').length, 3);
  // The JSONL object carries no run token of its own.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(hold.notable))), ['type', 'actionId', 'until', 'pools', 'reason', 'waitSec']);
});

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

test('--until trouble prints a short wait without waking, and wakes on a long one', async (t) => {
  const nowMs = minutesAfterLastEvent(1);
  const run = stagedRun(t, { nowMs });
  const cursor = run.state.events.sequence;
  // appendEvent stamps events with the wall clock, which the wait is measured from.
  const until = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  run.emit('action.waiting', { actionId: 'verify', until: until(10), pools: ['pool-a'], reason: 'hold' });
  run.emit('action.waiting', { actionId: 'verify', until: until(120), pools: ['pool-a'], reason: 'quota' });
  const watcher = watch(run, { until: 'trouble', afterSequence: cursor, now: () => nowMs });
  assert.equal(await watcher.promise, 0);
  const waits = watcher.lines.filter((line) => line.startsWith('⧖ verify waiting for quota'));
  assert.equal(waits.length, 2, watcher.lines.join('\n'));
  assert.ok(watcher.lines.includes('  or lift the pause:  bullswarm pools resume pool-a'));
  assert.match(watcher.lines.at(-1), new RegExp(`^next: bullswarm workflow watch ${SHORT} --until trouble --after ${cursor + 2} --since `));
  // Only the short wait: printed, but nothing wakes the caller yet.
  const quiet = stagedRun(t, { nowMs });
  const start = quiet.state.events.sequence;
  quiet.emit('action.waiting', { actionId: 'verify', until: until(10), pools: ['pool-a'], reason: 'hold' });
  const follow = watch(quiet, { until: 'trouble', afterSequence: start, now: () => nowMs, intervalMs: 20 });
  await eventually(() => follow.lines.length > 0, 'the waiting line');
  assert.match(follow.lines[0], /^⧖ verify waiting for quota · pool-a back at /);
  quiet.finish('completed');
  assert.equal(await follow.promise, 0);
  assert.equal(follow.lines.some((line) => line.startsWith('next: bullswarm workflow watch')), false, 'a short wait never woke it');
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
