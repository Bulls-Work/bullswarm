// The no-progress limit (BULLSWARM_WORKER_NO_PROGRESS_SEC): a build or chore
// worker that keeps talking but changes no file is stopped like a silent one,
// as `stalled`, so the step's one retry on another pool applies. The silence
// clock alone never reaches it, because every read-only tool call is output
// (2026-10 benchmark: a build worker read files for over an hour).
//
// Every worker here is a local `node -e` script behind an inline event-stream
// connector in a temporary Bullswarm home: no real pool, no network, no quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegate } from '../src/lib/run-delegate.js';
import { minutesOrSeconds } from '../src/lib/watch.js';
import { actionWrites, createFileChangeClock, createStreamFactsReader, staleScore } from '../src/lib/stale.js';
import { saveState } from '../src/lib/state.js';
import { listAssignments } from '../src/lib/assignments.js';
import { classifyV2DispatchFailure, dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { noProgressLimitApplies, workerNoProgressTimeoutSec } from '../src/workflow/dispatch-silence.js';
import { renderWatchEvent } from '../src/workflow/watch-cli.js';
import { normalizeAttempt } from '../src/workflow/attempt-record.js';
import {
  createV2DurableState, createV2GoalDocument, deserializeV2DurableState,
} from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

// The event-stream shape of the fixture connectors (tests/watch.test.js).
const EVENT_STREAM = {
  format: 'jsonl',
  modelPaths: ['model'],
  rules: [
    { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kindPaths: ['name'], summaryPaths: ['command'], statusPath: 'status' },
    { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
  ],
  output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
};

// Reads the same file every 100 ms, forever: always output, never a change.
const READER = "let n = 0; setInterval(() => { n += 1; for (const status of ['running', 'completed']) "
  + "console.log(JSON.stringify({ type: 'tool', id: 'read-' + n, name: 'read_file', command: 'cat notes.txt', status })); }, 100);";
// Reads for `ms`, then answers and exits; changes no file.
const answerAfter = (ms) => "let n = 0; const timer = setInterval(() => { n += 1; "
  + "console.log(JSON.stringify({ type: 'tool', id: 'read-' + n, name: 'read_file', command: 'cat notes.txt', status: 'completed' })); }, 100); "
  + `setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ type: 'response', id: 'done', text: 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.' })); }, ${ms});`;
// Writes out.txt, then answers.
const WRITER = "require('node:fs').writeFileSync('out.txt', 'done\\n'); "
  + "console.log(JSON.stringify({ type: 'tool', id: 'w1', name: 'write_file', command: 'out.txt', status: 'completed' })); "
  + "console.log(JSON.stringify({ type: 'response', id: 'done', text: 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.' }));";

const fixturePool = (name, script, extra = {}) => ({
  name,
  enabled: true,
  lanes: ['analyze', 'build', 'chore'],
  capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
  // `--` keeps the model flag the dispatcher appends away from node itself.
  spawn: { cmd: [process.execPath, '-e', script, '--', '{taskFile}'] },
  authSignatures: [],
  outputExtraction: { strategy: 'event-stream' },
  eventStream: EVENT_STREAM,
  meter: { type: 'none' },
  model: `${name}/model`,
  modelSelection: { flag: '--model' },
  strategyAssignments: { low: { pool: name, model: `${name}/model` } },
  ...extra,
});

function isolatedHome(t, pools) {
  const home = mkdtempSync(join(tmpdir(), 'bs-no-progress-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveState(home, {
    version: 1,
    pools: Object.fromEntries(pools.map((pool) => [pool.name, { enabled: true }])),
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  return home;
}

const pathsIn = (home, prefix) => (ordinal) => ({
  taskFile: join(home, `${prefix}-task-${ordinal}.md`),
  outFile: join(home, `${prefix}-out-${ordinal}.md`),
});

test('the limit reads BULLSWARM_WORKER_NO_PROGRESS_SEC, 0 turns it off, and only build and chore steps get it', () => {
  assert.equal(workerNoProgressTimeoutSec({}), 3600);
  assert.equal(workerNoProgressTimeoutSec({ BULLSWARM_WORKER_NO_PROGRESS_SEC: '900' }), 900);
  assert.equal(workerNoProgressTimeoutSec({ BULLSWARM_WORKER_NO_PROGRESS_SEC: '0' }), 0);
  assert.equal(workerNoProgressTimeoutSec({ BULLSWARM_WORKER_NO_PROGRESS_SEC: 'soon' }), 3600);
  assert.equal(workerNoProgressTimeoutSec({ BULLSWARM_WORKER_NO_PROGRESS_SEC: '-5' }), 3600);

  assert.equal(noProgressLimitApplies({ id: 'a', lane: 'build' }), true);
  assert.equal(noProgressLimitApplies({ id: 'a', lane: 'chore' }), true);
  assert.equal(noProgressLimitApplies({ id: 'a' }), true, 'a step with no lane dispatches as chore');
  assert.equal(noProgressLimitApplies({ id: 'a', lane: 'analyze' }), false);
  assert.equal(noProgressLimitApplies({ id: 'a', lane: 'build', role: 'act' }), false);
  assert.equal(noProgressLimitApplies({ id: 'a', lane: 'chore', deliverable: { type: 'outward' } }), false);
});

test('every step the limit stops is one the watcher scores as a writer, on the same file-change clock', () => {
  const steps = [
    { id: 'rename', lane: 'chore', ownedFiles: [], deliverable: 'files' },
    { id: 'tidy' },
    { id: 'build', lane: 'build' },
    { id: 'owned', lane: 'chore', ownedFiles: ['src/a.js'] },
    { id: 'read', lane: 'analyze' },
    { id: 'post', lane: 'chore', deliverable: { type: 'outward' } },
  ];
  for (const action of steps) {
    if (noProgressLimitApplies(action)) assert.equal(actionWrites(action), true, action.id);
  }
  // A chore step with no files, reading busily for 59 minutes: the score's
  // clock is its last file change (the start), not its output.
  const startedAt = new Date(Date.now() - 59 * 60_000).toISOString();
  const attempt = { status: 'running', startedAt, lastActivityAt: new Date().toISOString(), routing: { forecast: { expectedMinutes: 10 } } };
  const score = staleScore({ attempt, writes: actionWrites(steps[0]), nowMs: Date.now() });
  assert.equal(score.progressBy, 'file-change');
  assert.equal(score.progressAt, Date.parse(startedAt));
});

test('a worker that keeps reading but changes no file is stopped; one whose file changes, or whose change cannot be read, is not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-no-progress-delegate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const taskFile = join(dir, 'task.md');
  writeFileSync(taskFile, 'task');
  const reader = fixturePool('reader', READER);

  const started = Date.now();
  const stopped = await runDelegate(reader, taskFile, dir, {
    silenceTimeoutSec: 30, noProgressTimeoutSec: 1, fileChangedAt: () => started,
  });
  assert.equal(stopped.stalled, true);
  assert.equal(stopped.stalledBy, 'no-progress');
  assert.ok(Date.now() - started < 10_000, 'stopped soon after the limit, though the worker never went quiet');

  // A file change every poll keeps it going until it ends on its own.
  const finishing = fixturePool('finisher', answerAfter(1500));
  const moving = await runDelegate(finishing, taskFile, dir, {
    silenceTimeoutSec: 30, noProgressTimeoutSec: 1, fileChangedAt: () => Date.now(),
  });
  assert.equal(moving.stalled, false);
  assert.equal(moving.stalledBy, undefined);
  assert.equal(moving.exitCode, 0);

  // A null reading (no event stream yet) never stops anything.
  const unknown = await runDelegate(finishing, taskFile, dir, {
    silenceTimeoutSec: 30, noProgressTimeoutSec: 1, fileChangedAt: () => null,
  });
  assert.equal(unknown.stalled, false);
  assert.equal(unknown.exitCode, 0);
});

test('the clock reads an edit in the event stream and a changed file in the workspace, and nothing before an event stream exists', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-no-progress-clock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
  const streamFile = join(dir, 'stream-build-attempt-1.jsonl');
  const startedAtMs = Date.now() - 60_000;
  const clock = createFileChangeClock({ streamFile, targetDir: dir, action: { id: 'build', lane: 'build' }, startedAtMs });
  assert.equal(clock(), null, 'no event stream: a file change cannot be told from none');

  const read = { at: new Date(startedAtMs + 5_000).toISOString(), kind: 'read_file', status: 'completed', toolCallId: 'r1', summary: 'cat a.txt' };
  appendFileSync(streamFile, `${JSON.stringify(read)}\n`);
  // The stream file itself is untracked in this repository; it stands for a
  // worker that has changed nothing else, so it is kept out of git's view.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.jsonl\n');
  assert.equal(clock(), startedAtMs, 'reads only: counted from the start');

  const edit = { at: new Date(startedAtMs + 20_000).toISOString(), kind: 'edit', status: 'completed', toolCallId: 'e1', summary: 'a.txt' };
  appendFileSync(streamFile, `${JSON.stringify(edit)}\n`);
  assert.equal(clock(), startedAtMs + 20_000, 'an edit tool call in the stream');

  writeFileSync(join(dir, 'b.txt'), 'new\n');
  assert.ok(clock() > startedAtMs + 50_000, 'a new file in the workspace, by its modification time');
});

test('a shell edit is seen however many files earlier steps left changed; a workspace too large to read whole gives no reading, so nothing is stopped', (t) => {
  const startedAtMs = Date.now() - 60_000;
  const stream = (dir) => {
    const streamFile = join(dir, '.stream-build-attempt-1.jsonl');
    // Reads only: a shell edit (sed, a redirect) is no file_change event.
    writeFileSync(streamFile, `${JSON.stringify({ at: new Date(startedAtMs + 1_000).toISOString(), kind: 'read_file', status: 'completed', toolCallId: 'r1', summary: 'cat a.txt' })}\n`);
    return streamFile;
  };
  const old = new Date(startedAtMs - 3_600_000);
  // A git workspace where an earlier step left 250 files changed; the worker's edit sorts last.
  const repo = mkdtempSync(join(tmpdir(), 'bs-no-progress-many-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.stream-*\n');
  for (let index = 0; index < 250; index += 1) {
    const file = join(repo, `a${String(index).padStart(3, '0')}.txt`);
    writeFileSync(file, 'left by an earlier step\n');
    utimesSync(file, old, old);
  }
  const clock = createFileChangeClock({ streamFile: stream(repo), targetDir: repo, action: { id: 'build', lane: 'build' }, startedAtMs });
  assert.equal(clock(), startedAtMs, 'nothing changed since the start');
  writeFileSync(join(repo, 'z.txt'), 'the worker\'s shell edit\n');
  assert.ok(clock() > startedAtMs + 50_000, 'the edit of z.txt moves the clock');
  // Outside git, a folder past the walk's 5,000 files cannot be read whole: no reading.
  const big = mkdtempSync(join(tmpdir(), 'bs-no-progress-big-'));
  t.after(() => rmSync(big, { recursive: true, force: true }));
  for (let index = 0; index < 5002; index += 1) writeFileSync(join(big, `f${index}.txt`), '');
  const bigClock = createFileChangeClock({ streamFile: stream(big), targetDir: big, action: { id: 'build', lane: 'build' }, startedAtMs });
  assert.equal(bigClock(), null, 'a change it cannot see must not stop the worker');
});

test('an edit that scrolls out of the stream\'s rolling tail still counts: the clock and the facts never move back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-no-progress-tail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const streamFile = join(dir, 'stream-build-attempt-1.jsonl');
  const startedAtMs = Date.now() - 61 * 60_000;
  const at = (minutes) => new Date(startedAtMs + minutes * 60_000).toISOString();
  const read = (id, minutes) => JSON.stringify({ at: at(minutes), kind: 'read_file', status: 'completed', toolCallId: id, summary: 'cat a.txt' });
  // The head (first records) has reads only; the edit lives in the tail.
  writeFileSync(streamFile, `${read('r0', 1)}\n`);
  writeFileSync(`${streamFile}.tail`, `${JSON.stringify({ at: at(30), kind: 'edit', status: 'completed', toolCallId: 'e1', summary: 'a.txt' })}\n${read('r1', 31)}\n`);
  const readFacts = createStreamFactsReader();
  // No workspace to read (as when git status is too slow): the stream alone.
  const clock = createFileChangeClock({ streamFile, targetDir: null, action: { id: 'build', lane: 'build' }, startedAtMs, readFacts });
  assert.equal(clock(), startedAtMs + 30 * 60_000, 'right after the edit');
  // The tail rolls on: later reads push the edit out of it.
  writeFileSync(`${streamFile}.tail`, `${read('r2', 59)}\n${read('r3', 60)}\n${read('r4', 61)}\n`);
  assert.equal(clock(), startedAtMs + 30 * 60_000, 'after more reads, no new edit');
  assert.equal(readFacts(streamFile).lastFileChangeAt, startedAtMs + 30 * 60_000, 'the facts the stale score reads keep it too');
  // A fresh clock over a fresh reader on the same files has no memory of it.
  assert.equal(createFileChangeClock({ streamFile, targetDir: null, startedAtMs })(), startedAtMs);
});

test('a build step that changes no file is stopped as stalled and retried once on another pool; an analyze step is never stopped for it', { timeout: 30_000 }, async (t) => {
  const reader = fixturePool('reader', READER, { costRank: 1 });
  const writer = fixturePool('writer', WRITER, { costRank: 3 });
  const home = isolatedHome(t, [reader, writer]);
  const started = Date.now();
  const result = await dispatchV2Action({
    action: { id: 'build-out', lane: 'build', effort: 'low', ownedFiles: ['out.txt'] },
    taskText: 'Write out.txt.',
    targetDir: home,
    paths: pathsIn(home, 'build'),
    pools: [reader, writer],
    bullswarmDir: home,
    silenceTimeoutSec: 30,
    noProgressTimeoutSec: 1,
    maxMechanicalRetries: 1,
  });
  assert.ok(Date.now() - started < 20_000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['reader', 'writer']);
  const [first, second] = result.attempts;
  assert.equal(first.failureKind, 'stalled');
  assert.equal(first.why, 'stalled: no file change for 1 s, the worker was stopped');
  assert.equal(first.stalled, true);
  assert.equal(first.noProgressSec, 1);
  assert.equal(first.silentSec, undefined, 'the silence limit did not stop it');
  assert.match(second.routeWhy, /^fallback from reader after no file change for 1s/);
  assert.equal(second.retryOf?.how, 'other-pool');
  assert.equal(readFileSync(join(home, 'out.txt'), 'utf8'), 'done\n');
  assert.deepEqual(listAssignments(home), []);
  assert.equal(classifyV2DispatchFailure({ ok: false, failureKind: 'stalled', meta: { stalled: true, stalledBy: 'no-progress' } }), 'stalled');

  // The watch line names the limit that stopped it.
  assert.equal(
    renderWatchEvent({ type: 'attempt.stalled', actionId: 'build-out', pool: 'reader', noProgressSec: 3600, silentSec: null, willRetry: true }),
    '⚠ build-out stalled on reader · no file change for 1h00m · retrying on another pool',
  );
  // A limit that is not whole minutes is not rounded in the why: one stop, one time.
  assert.deepEqual([60, 90, 3600, 3630, 45].map(minutesOrSeconds), ['1 min', '1 min 30 s', '60 min', '60 min 30 s', '45 s']);
  assert.match(renderWatchEvent({ type: 'attempt.stalled', actionId: 'build-out', pool: 'reader', noProgressSec: 90, silentSec: null, willRetry: true }), /no file change for 1m30s/);

  // An analyze step reads by design: the same limit never stops it.
  const analyst = fixturePool('analyst', answerAfter(2500));
  const analyzeHome = isolatedHome(t, [analyst]);
  const analysis = await dispatchV2Action({
    action: { id: 'read-notes', lane: 'analyze', effort: 'low' },
    taskText: 'Summarize the notes.',
    targetDir: analyzeHome,
    paths: pathsIn(analyzeHome, 'analyze'),
    pools: [analyst],
    bullswarmDir: analyzeHome,
    silenceTimeoutSec: 30,
    noProgressTimeoutSec: 1,
  });
  assert.equal(analysis.attempts.length, 1);
  assert.notEqual(analysis.attempts[0].failureKind, 'stalled');
  assert.equal(analysis.attempts[0].stalled, undefined);
});

test('a step stopped for no file change keeps noProgressSec through the attempt record and the durable state', () => {
  const recorded = normalizeAttempt({
    pool: 'reader', model: 'reader/model', status: 'interrupted', startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: '2026-10-14T11:00:01.000Z', failureKind: 'stalled',
    why: 'stalled: no file change for 60 min, the worker was stopped',
    stalled: true, partialOutput: '/tmp/out-build-out.md', noProgressSec: 3600,
  }, { id: 'build-out-1', actionId: 'build-out', ordinal: 1 });
  assert.equal(recorded.noProgressSec, 3600);
  assert.equal(recorded.silentSec, undefined);

  const goal = createV2GoalDocument({
    goal: 'A reader that never writes', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Write out.txt' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-noprog', shortId: 'npg123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'build-out', purpose: 'Write out.txt', dependsOn: [], affects: ['r1'], ownedFiles: ['out.txt'],
      prompt: 'Write out.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'build-out', status: 'running', attempts: 1, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-build', label: 'Build', revision: 1, actionIds: ['build-out'], startedAt: null, completedAt: null }] };
  state.attempts = [{
    id: 'build-out-1', actionId: 'build-out', ordinal: 1, status: 'interrupted',
    pool: 'reader', model: 'reader/model', startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: '2026-10-14T11:00:01.000Z', failureKind: 'stalled',
    why: 'stalled: no file change for 60 min, the worker was stopped',
    stalled: true, partialOutput: '/tmp/out-build-out.md', noProgressSec: 3600,
  }];
  const loaded = deserializeV2DurableState(JSON.stringify(state));
  assert.equal(loaded.attempts[0].noProgressSec, 3600);
});
