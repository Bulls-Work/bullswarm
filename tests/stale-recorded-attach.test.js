// A watch that attaches to a run that saves its stale warnings (events carry a
// `stale.recording` marker, state.json carries nothing new) must still show an
// attempt that is already stale, once: the latest recorded warning that no
// later `attempt.stale_cleared` closed. Staged from the scrubbed fixture run
// (tests/fixtures/home-351), as workflow-watch-cli.test.js does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflowWatch } from '../src/workflow/watch-cli.js';
import { appendEvent } from '../src/workflow/events.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = 'wf-mu8thu2e-27c504';
const SHORT = 'euqrni';
const SOURCE = join(ROOT, 'tests', 'fixtures', 'home-351', 'workflows', RUN);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(check, what) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await sleep(15); }
  throw new Error(`timed out waiting for ${what}`);
}

function stagedRun(t) {
  const nowMs = Date.now();
  const home = mkdtempSync(join(tmpdir(), 'bs-stale-attach-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runDir = join(home, 'workflows', RUN);
  mkdirSync(dirname(runDir), { recursive: true });
  cpSync(SOURCE, runDir, { recursive: true });
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  state.intent.cwd = mkdtempSync(join(tmpdir(), 'bs-stale-attach-cwd-'));
  t.after(() => rmSync(state.intent.cwd, { recursive: true, force: true }));
  state.lifecycle = { ...state.lifecycle, status: 'running', finishedAt: null, resultFile: null };
  Object.assign(state.actions.find((action) => action.id === 'verify'), { status: 'running', finishedAt: null });
  const attempt = state.attempts.find((entry) => entry.id === 'verify-1');
  const at = new Date(nowMs).toISOString();
  Object.assign(attempt, { status: 'running', finishedAt: null, taskFile: join(runDir, 'task-verify-attempt-1.md'), lastActivityAt: at, lastEventAt: at });
  delete attempt.streamFile;
  state.runner = { ...(state.runner ?? {}), pid: process.pid, lastHeartbeatAt: at };
  const save = () => writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  save();
  const run = {
    home, runDir,
    emit(type, payload) { appendEvent(runDir, state, type, payload); save(); },
    finish() {
      const done = new Date().toISOString();
      Object.assign(state.actions.find((action) => action.id === 'verify'), { status: 'succeeded', finishedAt: done });
      Object.assign(attempt, { status: 'succeeded', finishedAt: done });
      state.lifecycle = { ...state.lifecycle, status: 'completed', finishedAt: done, resultFile: join(runDir, 'result.json') };
      save();
    },
  };
  // A failing test must not leave a watch polling forever.
  t.after(() => { try { run.finish(); } catch { /* the run folder is already gone */ } });
  return run;
}

const stalePayload = (level) => ({
  actionId: 'verify', attemptId: 'verify-1', pool: 'codex', model: 'gpt-5.6-luna',
  score: 2, reasons: ['no output'], staleSince: new Date().toISOString(), level, noProgressSec: 40 * level,
});

function watch(run, options) {
  let output = '';
  const probe = () => { throw new Error('a run that records its warnings is never scored by the watch'); };
  const promise = runWorkflowWatch(run.home, SHORT, {
    intervalMs: 40, stale: probe, ...options, output: { write: (text) => { output += text; } },
  });
  return { promise, get lines() { return output.split('\n').filter(Boolean); } };
}
const staleLines = (w) => w.lines.filter((line) => /stale/.test(line) && !/^watching /.test(line));

test('a fresh watch on a recording run prints the open stale warning once, and the next level is not a duplicate', async (t) => {
  const run = stagedRun(t);
  run.emit('stale.recording', {});
  run.emit('attempt.stale', stalePayload(1));
  run.emit('attempt.stale', stalePayload(2));
  const w = watch(run, {});
  await eventually(() => staleLines(w).length >= 1, 'the open warning on attach');
  await sleep(200);
  assert.equal(staleLines(w).length, 1, w.lines.join('\n'));
  assert.match(staleLines(w)[0], /warning 2/);
  run.emit('attempt.stale', stalePayload(3));
  await eventually(() => staleLines(w).length >= 2, 'the next level');
  run.finish();
  await w.promise;
  const lines = staleLines(w);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /warning 3/);
});

test('--until trouble wakes on attach for an open stale warning', async (t) => {
  const run = stagedRun(t);
  run.emit('stale.recording', {});
  run.emit('attempt.stale', stalePayload(1));
  const w = watch(run, { until: 'trouble', timeoutMs: 3000 });
  const code = await Promise.race([w.promise, sleep(1500).then(() => 'still waiting')]);
  assert.notEqual(code, 'still waiting', `no wake; output: ${w.lines.join(' | ')}`);
  assert.equal(staleLines(w).length, 1);
});

test('a warning closed by attempt.stale_cleared is not shown on attach, and with --after the replay is exact', async (t) => {
  const run = stagedRun(t);
  run.emit('stale.recording', {});
  run.emit('attempt.stale', stalePayload(1));
  run.emit('attempt.stale_cleared', { actionId: 'verify', attemptId: 'verify-1', level: 1, staleSec: 40 });
  const w = watch(run, {});
  await sleep(300);
  assert.equal(staleLines(w).length, 0, w.lines.join('\n'));
  run.finish();
  await w.promise;

  const replay = stagedRun(t);
  replay.emit('stale.recording', {});
  replay.emit('attempt.stale', stalePayload(1));
  replay.emit('attempt.stale', stalePayload(2));
  const r = watch(replay, { afterSequence: 0, sinceMs: Date.now() - 1000 });
  await eventually(() => staleLines(r).length >= 2, 'both replayed warnings');
  replay.finish();
  await r.promise;
  assert.equal(staleLines(r).length, 2, 'exact replay prints every recorded warning after the cursor');
});

// The runner appended an event but has not saved state.json yet, so it sits
// past the cursor a fresh watch reads from (blind reviews 57fjfi, 8h6eqi).
function laggingEmit(run, type, payload) {
  const lagging = JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  appendEvent(run.runDir, lagging, type, payload);
}

test('an attach while events.jsonl is ahead of state.json prints only the newest warning, once', async (t) => {
  const run = stagedRun(t);
  run.emit('stale.recording', {});
  run.emit('attempt.stale', stalePayload(1));
  laggingEmit(run, 'attempt.stale', stalePayload(2));
  const w = watch(run, {});
  await eventually(() => staleLines(w).length >= 1, 'the open warning on attach');
  await sleep(300);
  run.finish();
  await w.promise;
  const lines = staleLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /warning 2/);
});

test('an attach while a clear past the cursor closed the warning prints no warning', async (t) => {
  const run = stagedRun(t);
  run.emit('stale.recording', {});
  run.emit('attempt.stale', stalePayload(1));
  laggingEmit(run, 'attempt.stale_cleared', { actionId: 'verify', attemptId: 'verify-1', level: 1, staleSec: 40 });
  const w = watch(run, {});
  await sleep(400);
  run.finish();
  await w.promise;
  assert.equal(staleLines(w).length, 0, w.lines.join('\n'));
});
