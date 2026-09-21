// The stale score (src/lib/stale.js), read from the real attempt streams in
// the scrubbed fixture home (tests/fixtures/home-351): claude-code, grok and
// codex streams exactly as the dispatcher persisted them. Hand-built records
// only appear where a situation has to be staged (a command left in flight, a
// command repeated), and they copy the shape of a real record from the same
// fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STALE_THRESHOLDS, actionWrites, attemptStreamPath, createStaleProbe, createStreamFactsReader,
  emptyStreamFacts, foldStreamRecord, ownedFilesChangedAt, staleScore, streamFacts,
} from '../src/lib/stale.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(ROOT, 'tests', 'fixtures', 'home-351', 'workflows');

// Every persisted stream in the fixture, with the attempt and action it belongs to.
const STREAMS = [
  ['wf-mu6mv62z-cdcd5d', 'stream-accept-attempt-5.jsonl'],
  ['wf-mu8j2hjn-58b8ec', 'stream-verify-attempt-1.jsonl'],
  ['wf-mu8thu2e-27c504', 'stream-integrate-attempt-1.jsonl'],
  ['wf-mu8thu2e-27c504', 'stream-verify-attempt-1.jsonl'],
  ['wf-mu8ni8o4-f9baaf', 'stream-step-view-attempt-1.jsonl'],
  ['wf-mu8ni8o4-f9baaf', 'stream-step-model-attempt-1.jsonl'],
].map(([run, file]) => {
  const runDir = join(HOME, run);
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const task = file.replace(/^stream-/, 'task-').replace(/\.jsonl$/, '.md');
  const attempt = state.attempts.find((entry) => entry.taskFile && basename(entry.taskFile) === task);
  const action = state.program.actions.find((entry) => entry.id === attempt.actionId);
  const records = readFileSync(join(runDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { run, file, path: join(runDir, file), state, attempt, action, records };
});
const stream = (run, file) => STREAMS.find((entry) => entry.run === run && entry.file === file);
const ms = (iso) => Date.parse(iso);
const running = (attempt, extra = {}) => ({ ...attempt, status: 'running', finishedAt: null, lastActivityAt: null, lastEventAt: null, ...extra });

test('every tool call in the real streams pairs with its completion, whatever the provider shape', () => {
  // claude-code (Bash → tool), grok (tool_call → tool_call_update), codex
  // (item.started → item.completed): a finished attempt has nothing in flight.
  const counts = {};
  for (const entry of STREAMS) {
    const facts = streamFacts(entry.records);
    assert.equal(facts.open.length, 0, `${entry.run}/${entry.file}: ${JSON.stringify(facts.open)}`);
    counts[`${entry.attempt.pool}:${entry.attempt.actionId}`] = facts.commandCount;
  }
  assert.deepEqual(counts, {
    'claude-code:accept': 236,
    'grok:verify': 170,
    'codex:integrate': 20,
    'claude-code:verify': 88,
    'codex:step-view': 17,
    'codex:step-model': 120,
  });
  // A codex file_change and a claude Write are file changes; a verifier that
  // only ran commands has none.
  assert.equal(new Date(streamFacts(stream('wf-mu8ni8o4-f9baaf', 'stream-step-model-attempt-1.jsonl').records).lastFileChangeAt).toISOString(), '2026-09-19T18:38:31.023Z');
  assert.equal(streamFacts(stream('wf-mu8thu2e-27c504', 'stream-verify-attempt-1.jsonl').records).lastFileChangeAt, null);
});

test('quiet time excludes a command in flight and counts once nothing is running', () => {
  const { records, attempt } = stream('wf-mu8thu2e-27c504', 'stream-verify-attempt-1.jsonl');
  // Cut the real claude stream right after a Bash call started, before its result.
  const bashAt = records.findIndex((record) => record.kind === 'Bash' && record.status === 'running');
  const inFlight = streamFacts(records.slice(0, bashAt + 1));
  assert.equal(inFlight.open.length, 1);
  const lastAt = ms(records[bashAt].at);
  const thirtyMinutes = lastAt + 30 * 60_000;
  const busy = staleScore({ attempt: running(attempt), facts: inFlight, nowMs: thirtyMinutes });
  assert.equal(busy.signals.some((signal) => signal.id === 'quiet'), false, 'a long command is not quiet');
  // The same stream a moment later: the result came back and nothing runs.
  const closed = streamFacts(records.slice(0, bashAt + 2));
  assert.equal(closed.open.length, 0);
  const idle = staleScore({ attempt: running(attempt), facts: closed, nowMs: ms(records[bashAt + 1].at) + 12 * 60_000 });
  assert.equal(idle.stale, true);
  assert.deepEqual(idle.reasons, ['quiet 12m with no command running']);
  assert.equal(idle.staleSince, ms(records[bashAt + 1].at) + DEFAULT_STALE_THRESHOLDS.quietSec * 1000);
  // Without an event stream, silence is all there is to go on, and it says so.
  const bytesOnly = staleScore({ attempt: running(attempt, { lastActivityAt: records[bashAt + 1].at }), facts: null, nowMs: ms(records[bashAt + 1].at) + 11 * 60_000 });
  assert.deepEqual(bytesOnly.reasons, ['no output for 11m']);
});

test('replaying the real healthy attempts never reads as stale', () => {
  // Every 15 seconds of each real attempt's life, the score sees exactly the
  // records written by then. None of them was stuck; the 49-minute codex step
  // ran past three times its expected 13 minutes, which alone is not stale.
  const fired = {};
  for (const entry of STREAMS) {
    const start = ms(entry.attempt.startedAt);
    const end = ms(entry.attempt.finishedAt);
    const facts = emptyStreamFacts();
    let index = 0;
    for (let now = start; now <= end; now += 15_000) {
      while (index < entry.records.length && ms(entry.records[index].at) <= now) foldStreamRecord(facts, entry.records[index++]);
      const score = staleScore({ attempt: running(entry.attempt), facts, writes: actionWrites(entry.action), nowMs: now });
      assert.equal(score.stale, false, `${entry.run}/${entry.file} at +${Math.round((now - start) / 60000)}m: ${score.reasons.join('; ')}`);
      for (const signal of score.signals) fired[`${entry.attempt.actionId}:${signal.id}`] = true;
    }
  }
  assert.deepEqual(Object.keys(fired), ['step-model:wall']);
});

test('the same command three times in a row is a repeat; a file change in between is progress', () => {
  const { records, attempt } = stream('wf-mu8ni8o4-f9baaf', 'stream-step-view-attempt-1.jsonl');
  const [started, completed] = [records.find((record) => record.status === 'running'), records.find((record) => record.status === 'completed' && record.kind === 'command_execution')];
  const change = stream('wf-mu8ni8o4-f9baaf', 'stream-step-model-attempt-1.jsonl').records.find((record) => record.kind === 'file_change');
  const t0 = ms(attempt.startedAt);
  const at = (minutes) => new Date(t0 + minutes * 60_000).toISOString();
  const run = (minutes) => [{ ...started, at: at(minutes) }, { ...completed, at: at(minutes + 0.5) }];
  const repeated = streamFacts([...run(1), ...run(2), ...run(3)]);
  assert.equal(repeated.streak.count, 3);
  const score = staleScore({ attempt: running(attempt, { routing: { forecast: { expectedMinutes: 1 } } }), facts: repeated, nowMs: t0 + 4 * 60_000 });
  assert.equal(score.stale, true, 'repeat plus 4m over a 1m expectation');
  // Equal weights, equal firing time: they keep the order they were judged in.
  assert.deepEqual(score.signals.map((signal) => signal.id), ['repeat', 'wall']);
  assert.match(score.reasons.find((reason) => reason.startsWith('same command')), /^same command 3× in a row: sample command for step-view-1 /);
  // The streak's third run is when the score reached two.
  assert.equal(score.staleSince, t0 + 3 * 60_000);
  const edited = streamFacts([...run(1), ...run(2), { ...change, at: at(2.7) }, ...run(3)]);
  assert.equal(edited.streak.count, 1);
});

test('no file change while commands continue counts only for a step that writes', () => {
  const { records, attempt, action } = stream('wf-mu8thu2e-27c504', 'stream-integrate-attempt-1.jsonl');
  assert.equal(actionWrites(action), true);
  const change = records.find((record) => record.kind === 'file_change' && record.status === 'completed');
  const [started, completed] = [records.find((record) => record.status === 'running' && record.kind === 'command_execution'), records.find((record) => record.status === 'completed' && record.kind === 'command_execution')];
  const t0 = ms(attempt.startedAt);
  const at = (minutes) => new Date(t0 + minutes * 60_000).toISOString();
  // A change at minute 1, then a different-looking command every four minutes.
  const facts = streamFacts([
    { ...change, at: at(1) },
    ...[5, 9, 13, 17, 21, 25].flatMap((minute, index) => [
      { ...started, summary: `${started.summary} ${index}`, at: at(minute) },
      { ...completed, summary: `${completed.summary} ${index}`, at: at(minute + 0.5) },
    ]),
  ]);
  const nowMs = t0 + 26 * 60_000;
  const writer = staleScore({ attempt: running(attempt, { routing: { forecast: { expectedMinutes: 8 } } }), facts, writes: true, nowMs });
  assert.deepEqual(writer.reasons, ['no file change in 25m while 6 commands ran', 'running 26m, over 3× the expected 8m']);
  assert.equal(writer.stale, true);
  // The fifth command after the change (minute 21) is when it fired.
  assert.equal(writer.signals.find((signal) => signal.id === 'no-file-change').firedAt, t0 + 21 * 60_000);
  // A verifier reads for as long as it likes.
  const reader = staleScore({ attempt: running(attempt, { routing: { forecast: { expectedMinutes: 8 } } }), facts, writes: false, nowMs });
  assert.deepEqual(reader.signals.map((signal) => signal.id), ['wall']);
  assert.equal(reader.stale, false);
  // An owned file touched on disk at minute 20 is progress the stream did not show.
  const touched = staleScore({ attempt: running(attempt), facts, writes: true, fileChangedAt: t0 + 20 * 60_000, nowMs });
  assert.equal(touched.signals.some((signal) => signal.id === 'no-file-change'), false);
});

test('the incremental reader folds appended lines and re-reads the tail segment', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-stale-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { records } = stream('wf-mu6mv62z-cdcd5d', 'stream-accept-attempt-5.jsonl');
  const file = join(dir, 'stream-accept-attempt-5.jsonl');
  const lines = records.map((record) => `${JSON.stringify(record)}\n`);
  writeFileSync(file, lines.slice(0, 200).join(''));
  const read = createStreamFactsReader();
  assert.equal(read(file).records, 200);
  // A half-written line is held back until its newline arrives.
  appendFileSync(file, lines.slice(200).join('').slice(0, -10));
  assert.equal(read(file).records, records.length - 1);
  appendFileSync(file, lines.at(-1).slice(-10));
  assert.deepEqual(read(file), streamFacts(records));
  // Over its cap the sink writes head + marker + tail to a `.tail` sibling.
  const bash = records.find((record) => record.kind === 'Bash');
  writeFileSync(`${file}.tail`, `{"truncated":true,"dropped":12}\n${JSON.stringify({ ...bash, at: '2026-09-19T21:00:00.000Z' })}\n`);
  const withTail = read(file);
  assert.equal(withTail.truncated, true);
  assert.equal(withTail.open.length, 1, 'the in-flight set restarts at the marker, then sees the tail command');
  assert.equal(new Date(withTail.lastEventAt).toISOString(), '2026-09-19T21:00:00.000Z');
  // A write that ends inside a multi-byte character is held back whole.
  const wide = join(dir, 'stream-wide-attempt-1.jsonl');
  const line = Buffer.from(`${JSON.stringify({ ...bash, summary: 'grep — “quoted” ✓', at: '2026-09-19T21:00:00.000Z' })}\n`);
  const split = line.indexOf(Buffer.from('—')) + 1;
  writeFileSync(wide, line.subarray(0, split));
  const wideReader = createStreamFactsReader();
  assert.equal(wideReader(wide).records, 0);
  appendFileSync(wide, line.subarray(split));
  assert.equal(wideReader(wide).streak.summary, 'grep — “quoted” ✓');
  assert.equal(read(null), null);
  assert.equal(read(join(dir, 'missing.jsonl')), null);
});

test('workspace evidence reads only the files the step owns', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-stale-owned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'mine.js'), '1');
  writeFileSync(join(dir, 'sibling.js'), '1');
  utimesSync(join(dir, 'src', 'mine.js'), new Date('2026-09-19T10:00:00Z'), new Date('2026-09-19T10:00:00Z'));
  utimesSync(join(dir, 'sibling.js'), new Date('2026-09-19T11:00:00Z'), new Date('2026-09-19T11:00:00Z'));
  assert.equal(ownedFilesChangedAt(dir, ['src/mine.js', 'src/not-yet.js']), Date.parse('2026-09-19T10:00:00Z'));
  assert.equal(ownedFilesChangedAt(dir, []), null);
  assert.equal(ownedFilesChangedAt(null, ['src/mine.js']), null);
});

test('the probe finds a running attempt\'s stream beside its task file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-stale-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = stream('wf-mu8thu2e-27c504', 'stream-verify-attempt-1.jsonl');
  const runDir = join(root, entry.run);
  mkdirSync(runDir);
  writeFileSync(join(runDir, entry.file), readFileSync(entry.path));
  const attempt = running(entry.attempt, { taskFile: join(runDir, 'task-verify-attempt-1.md'), streamFile: undefined });
  assert.equal(attemptStreamPath(attempt), join(runDir, entry.file));
  const probe = createStaleProbe({ runDir, state: entry.state });
  const last = ms(entry.records.at(-1).at);
  assert.equal(probe({ attempt, action: entry.action, nowMs: last + 60_000 }).stale, false);
  const later = probe({ attempt, action: entry.action, nowMs: last + 15 * 60_000 });
  assert.equal(later.stale, true);
  // 20.5 real minutes plus 15 quiet ones is still under 3× its expected 13.5.
  assert.equal(entry.attempt.routing.forecast.expectedMinutes, 13.53);
  assert.deepEqual(later.reasons, ['quiet 15m with no command running']);
  // Finished attempts are never scored.
  assert.equal(probe({ attempt: entry.attempt, action: entry.action, nowMs: last + 15 * 60_000 }).score, 0);
});
