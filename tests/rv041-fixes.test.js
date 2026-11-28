import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync, realpathSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { tokensModel } from '../src/workflow/tokens-model.js';
import { statsLines } from '../src/workflow/stats-view.js';
import { attemptMetric } from '../src/workflow/metrics.js';
import { workerMinutesForPool, attemptWindow, poolWindows } from '../src/lib/spend.js';
import { readDecisionLog, readArchivedDecisionLog, decisionLogArchivePath } from '../src/lib/state.js';
import { catalogRows } from '../src/workflow/dashboard-rows.js';
import { watchOnce } from '../src/lib/watch.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readTranscriptUsage as readClaudeUsage } from '../src/lib/transcripts/claude-code.js';
import { readTranscriptUsage as readOpenCodeUsage } from '../src/lib/transcripts/opencode.js';

// 0.41.0 fixes from the strict Opus review nxbx82 (out/rv-041/fix-spec.md).
// R1-R3 fail until the behaviour lands; R4 and R5 are guards.
//
// Seams and spies:
// - R2 counts property reads on the archived decision-log rows and on the
//   live tail's earlier rows. The archived rows are the objects
//   readArchivedDecisionLog caches and readDecisionLog / resolveDecisionLog
//   hand out (shallow copies of one cached array), so a counting getter on
//   each row sees every walk of the archive. The merge itself copies and
//   sorts the numeric window arrays without reading any row, so the guards
//   also assert the merged windows are memoized: poolWindows (exported for
//   this) returns the same object across reloads while nothing changed, and
//   a changed archive or live tail returns a new one.
// - R3 spies on node:fs (statSync, lstatSync, existsSync, readFileSync,
//   readdirSync, openSync) by replacing them on the fs object and calling
//   module.syncBuiltinESMExports(), which updates the named ESM imports that
//   src/workflow/dashboard-rows.js and short-id.js already hold. Only calls on
//   a given run directory (or a file inside it) are counted.
// - R4 runs watchOnce on the packaged OpenCode connector with a `node -e`
//   stand-in that prints one event (no worker CLI), then feeds that verdict to
//   dispatchV2Action through its `dependencies.watchOnce` seam.

process.env.TZ = 'Asia/Hong_Kong';
process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- R1: the Tokens summary shows cache read and cache write ----------------

const NOW = Date.parse('2026-11-28T04:00:00.000Z');
const metric = (over) => ({
  role: 'worker', pool: 'cf:deepseek', model: 'cf/deepseek-v4.1-flash', outcome: 'succeeded',
  startedAt: '2026-11-27T02:00:00.000Z', finishedAt: '2026-11-27T02:10:00.000Z',
  tokenSource: 'provider-reported',
  standardRead: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 500, reasoning: 100, tokens: 10_600,
  ...over,
});
const rollup = (project, attemptMetrics) => ({
  schemaVersion: 'bullswarm.workflow.rollup.v1', runId: `wf-${project}-${attemptMetrics.length}`,
  project, status: 'completed', startedAt: attemptMetrics[0].startedAt, finishedAt: attemptMetrics[0].finishedAt,
  attemptMetrics,
});

function tokensSummaryLine(rollups) {
  const stats = { tokens: tokensModel(rollups, { period: '7d', now: NOW }) };
  const view = statsLines(stats, { width: 140, height: 40, tab: 'tokens', period: '7d', ansi: false });
  const line = view.lines.find((text) => /Input [0-9.]+K? · Output/.test(text));
  assert.ok(line, `a summary line with Input and Output:\n${view.lines.join('\n')}`);
  return line;
}

test('R1: the Tokens summary line shows input, output, cache read and cache write, in that order', () => {
  const line = tokensSummaryLine([
    rollup('kipwise', [metric({})]),
    rollup('gym', [metric({ pool: 'claude-code:w', model: 'claude-sonnet-5-5', standardRead: 100, cacheRead: 50_000, cacheWrite: 4_000, output: 2_000, reasoning: 0, tokens: 56_100 })]),
  ]);
  // input = 1,000 + 9,000 + 100 + 50,000 + 4,000; cache read 59K; cache write 4K
  const order = ['Input 64.1K', 'Output 2.6K', 'Cache read 59K', 'Cache write 4K', 'total 66.7K']
    .map((part) => [part, line.indexOf(part)]);
  for (const [part, at] of order) assert.ok(at >= 0, `summary has "${part}": ${line}`);
  const positions = order.map(([, at]) => at);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `parts in order: ${line}`);
  assert.match(line, /\(reasoning 100\)/);
});

test('R1: a cache part that is zero for the whole period is left out of the summary', () => {
  const line = tokensSummaryLine([rollup('kipwise', [metric({})])]);
  assert.match(line, /Cache read 9K/);
  assert.doesNotMatch(line, /Cache write/);
});

// --- R2: decision-log windows survive reloads ------------------------------

const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const decision = (i) => ({
  pool: i % 3 === 0 ? 'cf:glm' : 'cf:deepseek',
  ts: new Date(T0 + i * 0.5 * HOUR).toISOString(),
  wallSec: 600 + (i % 7) * 300,
});

function writeArchive(home, rows) {
  writeFileSync(decisionLogArchivePath(home), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function bruteForce(log, name, from, to) {
  let minutes = 0;
  for (const entry of log) {
    if (entry.pool !== name) continue;
    const w = attemptWindow(entry);
    if (!w) continue;
    const overlap = Math.min(w.endMs, to) - Math.max(w.startMs, from);
    if (overlap > 0) minutes += overlap / 60_000;
  }
  return Math.round(minutes * 1e4) / 1e4;
}

// Counting getters on rows: every walk of a log reads them, whichever array
// they arrive in.
function countRowReads(rows) {
  const counter = { reads: 0 };
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      Object.defineProperty(row, key, { enumerable: true, configurable: true, get() { counter.reads += 1; return value; } });
    }
  }
  return counter;
}

function countArchiveReads(home) {
  return countRowReads(readArchivedDecisionLog(home));
}

test('R2: a usage reload with no new decision walks neither the archive nor the earlier live rows (readDecisionLog each reload)', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r2-'));
  try {
    writeArchive(home, Array.from({ length: 400 }, (_, i) => decision(i)));
    const counter = countArchiveReads(home);
    const live = [
      { pool: 'cf:deepseek', ts: new Date(T0 + 201 * HOUR).toISOString(), wallSec: 900 },
      { pool: 'cf:deepseek', ts: new Date(T0 + 202 * HOUR).toISOString(), wallSec: 600 },
    ];
    // The merge copies and sorts the numeric window arrays without reading
    // any row, so row reads alone cannot see it re-run. The earlier live
    // rows can: a re-merge re-walks the whole live tail, while the memoized
    // path reads only the last row (the memo key).
    const liveHeadReads = countRowReads(live.slice(0, -1));
    const now = T0 + 300 * HOUR;
    // The panel's usage reload: a fresh readDecisionLog array every 10 s.
    const reload = () => workerMinutesForPool('cf:deepseek', T0 + 10 * HOUR, T0 + 210 * HOUR, {
      decisionLog: readDecisionLog(home, { decisionLog: live }), nowMs: now,
    });
    const first = reload();
    counter.reads = 0;
    liveHeadReads.reads = 0;
    for (let i = 0; i < 5; i += 1) assert.equal(reload(), first);
    assert.equal(counter.reads, 0, `five reloads read archived rows ${counter.reads} times; the archive did not change`);
    assert.equal(liveHeadReads.reads, 0, `five reloads read earlier live rows ${liveHeadReads.reads} times; the live tail did not change`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R2: a reload through bullswarmDir (resolveDecisionLog) does not walk the archive again', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r2-'));
  try {
    writeArchive(home, Array.from({ length: 400 }, (_, i) => decision(i)));
    const counter = countArchiveReads(home);
    const now = T0 + 300 * HOUR;
    const reload = () => workerMinutesForPool('cf:glm', T0, T0 + 100 * HOUR, { bullswarmDir: home, nowMs: now });
    const first = reload();
    counter.reads = 0;
    for (let i = 0; i < 5; i += 1) assert.equal(reload(), first);
    assert.equal(counter.reads, 0, `five reloads read archived rows ${counter.reads} times; the archive did not change`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R2: the panel reload (fresh state rows each time) reuses one memoized merged windows object', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r2-'));
  try {
    writeArchive(home, Array.from({ length: 400 }, (_, i) => decision(i)));
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      decisionLog: [
        { pool: 'cf:glm', ts: new Date(T0 + 201 * HOUR).toISOString(), wallSec: 900 },
        { pool: 'cf:glm', ts: new Date(T0 + 202 * HOUR).toISOString(), wallSec: 600 },
      ],
    }));
    // Warms the home scan (state migration check) so it never walks the
    // archive rows behind the counting getters below.
    readDecisionLog(home);
    const counter = countArchiveReads(home);
    const now = T0 + 300 * HOUR;
    // The panel's real reload shape: readDecisionLog re-parses state.json,
    // so the live rows are fresh objects every time; only their content is
    // stable, so the memo must key on content, not object identity.
    const reload = () => workerMinutesForPool('cf:glm', T0, T0 + 210 * HOUR, { decisionLog: readDecisionLog(home), nowMs: now });
    const first = reload();
    const merged = poolWindows(readDecisionLog(home));
    counter.reads = 0;
    for (let i = 0; i < 5; i += 1) assert.equal(reload(), first);
    assert.equal(counter.reads, 0, `five reloads read archived rows ${counter.reads} times; the archive did not change`);
    assert.ok(merged === poolWindows(readDecisionLog(home)), 'the merged archive+live windows are memoized across reloads');

    // A new live decision is a miss: the merged object is rebuilt, and the
    // new decision is counted.
    const state = JSON.parse(fs.readFileSync(join(home, 'state.json'), 'utf8'));
    state.decisionLog.push({ pool: 'cf:glm', ts: new Date(T0 + 203 * HOUR).toISOString(), wallSec: 1200 });
    writeFileSync(join(home, 'state.json'), JSON.stringify(state));
    const nextLog = readDecisionLog(home);
    assert.notEqual(poolWindows(nextLog), merged, 'a new live decision rebuilds the merged windows');
    assert.equal(
      workerMinutesForPool('cf:glm', T0, T0 + 210 * HOUR, { decisionLog: nextLog, nowMs: now }),
      bruteForce(nextLog, 'cf:glm', T0, T0 + 210 * HOUR),
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R2 guard: cached windows match a plain sum, and see a new live decision, an archive append and a rotation', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r2-'));
  try {
    const archived = Array.from({ length: 300 }, (_, i) => decision(i));
    writeArchive(home, archived);
    const live = [{ pool: 'cf:glm', ts: new Date(T0 + 160 * HOUR).toISOString(), wallSec: 1200 }];
    const now = T0 + 400 * HOUR;
    const minutes = (pool, from, to) => workerMinutesForPool(pool, from, to, {
      decisionLog: readDecisionLog(home, { decisionLog: live }), nowMs: now,
    });
    const check = (log) => {
      for (const [from, to] of [[T0, T0 + HOUR], [T0 + 7.25 * HOUR, T0 + 31 * HOUR], [T0 - HOUR, T0 + 500 * HOUR], [T0 + 159.9 * HOUR, T0 + 160.1 * HOUR]]) {
        for (const pool of ['cf:deepseek', 'cf:glm', 'agy']) {
          assert.equal(minutes(pool, from, to), bruteForce(log, pool, from, to), `${pool} ${from}-${to}`);
        }
      }
    };
    check([...archived, ...live]);
    check([...archived, ...live]);

    // A live decision appended (same array, as state.json grows).
    live.push({ pool: 'agy', ts: new Date(T0 + HOUR).toISOString(), wallSec: 1800 });
    assert.equal(minutes('agy', T0, T0 + 2 * HOUR), 30, 'a new live decision is counted');
    // A fresh live array (the next loadState) with one more decision.
    const nextLive = [...live, { pool: 'agy', ts: new Date(T0 + 1.5 * HOUR).toISOString(), wallSec: 600 }];
    assert.equal(workerMinutesForPool('agy', T0, T0 + 2 * HOUR, {
      decisionLog: readDecisionLog(home, { decisionLog: nextLive }), nowMs: now,
    }), 40, 'a fresh live array is counted');

    // A same-length live tail whose last decision changed is a memo miss,
    // not a hit: the memo keys on the last row's content, not just length.
    live[live.length - 1] = { pool: 'agy', ts: new Date(T0 + HOUR).toISOString(), wallSec: 3600 };
    assert.equal(minutes('agy', T0, T0 + 2 * HOUR), 60, 'a changed last live decision is re-merged');

    // An archive append (size and mtime change).
    const appended = { pool: 'agy', ts: new Date(T0 + 3 * HOUR).toISOString(), wallSec: 600 };
    appendFileSync(decisionLogArchivePath(home), `${JSON.stringify(appended)}\n`);
    utimesSync(decisionLogArchivePath(home), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    assert.equal(minutes('agy', T0 + 2.5 * HOUR, T0 + 4 * HOUR), 10, 'an appended archive line is counted');
    check([...archived, appended, ...live]);

    // A rotation: the archive rewritten with other rows.
    const rotated = Array.from({ length: 50 }, (_, i) => ({ ...decision(i + 1000), pool: 'agy' }));
    writeArchive(home, rotated);
    utimesSync(decisionLogArchivePath(home), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    check([...rotated, ...live]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R2 guard: an archive append walks only the new lines, not the archived prefix', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r2-'));
  try {
    writeArchive(home, Array.from({ length: 400 }, (_, i) => decision(i)));
    // Counting getters on the parsed archive rows: a full rebuild re-walks
    // them, an incremental append walks only the new, getter-free row.
    const before = readArchivedDecisionLog(home);
    const counter = countRowReads(before);
    const live = [];
    const now = T0 + 500 * HOUR;
    const reload = () => workerMinutesForPool('cf:deepseek', T0, now, {
      decisionLog: readDecisionLog(home, { decisionLog: live }), nowMs: now,
    });
    reload();
    counter.reads = 0;

    const appended = decision(5000);
    appendFileSync(decisionLogArchivePath(home), `${JSON.stringify(appended)}\n`);
    utimesSync(decisionLogArchivePath(home), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const after = readArchivedDecisionLog(home);
    assert.equal(after.length, 401);
    assert.equal(after[0], before[0], 'the parsed prefix is reused, not re-parsed');
    const log = readDecisionLog(home, { decisionLog: live });
    const minutes = reload();
    assert.equal(counter.reads, 0, `an append walked archived rows ${counter.reads} times; only the new lines should be read`);
    assert.equal(minutes, bruteForce(log, 'cf:deepseek', T0, now), 'the appended window is counted');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- R3: a settled run older than a day costs one stat ----------------------

function writeRun(home, index, { finishedMs, goal = `run ${index}`, status = 'completed', finished = true } = {}) {
  const runId = `wf-rv041-${String(index).padStart(4, '0')}`;
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const at = new Date(finishedMs).toISOString();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId: `r${String(index).padStart(5, '0')}`,
    lifecycle: { status, startedAt: at, finishedAt: finished ? at : null },
    intent: { goal, cwd: '/tmp' },
    actions: [], attempts: [], planner: { status: 'completed', turns: 1, attempts: [] },
    presentation: { stages: [] }, ledger: { requirements: {} },
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  if (finished) writeFileSync(join(dir, 'rollup.json'), '{}');
  return { runId, dir };
}

function ageRun(dir, ms) {
  const when = new Date(ms);
  for (const name of fs.readdirSync(dir)) utimesSync(join(dir, name), when, when);
  utimesSync(dir, when, when);
}

const SPIED = ['statSync', 'lstatSync', 'existsSync', 'readFileSync', 'readdirSync', 'openSync'];

function spyFs() {
  const originals = Object.fromEntries(SPIED.map((name) => [name, fs[name]]));
  const calls = [];
  for (const name of SPIED) {
    fs[name] = function spied(path, ...rest) {
      calls.push({ name, path: String(path) });
      return originals[name].call(this, path, ...rest);
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    on: (dir) => calls.filter((call) => call.path === dir || call.path.startsWith(`${dir}${sep}`)),
    restore() {
      for (const name of SPIED) fs[name] = originals[name];
      syncBuiltinESMExports();
    },
  };
}

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.runId, row]));

test('R3: a settled run whose finished marker is older than a day costs one fs call per rebuild', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bs-rv041-r3-')));
  const old = Date.now() - 3 * DAY;
  try {
    const runs = [0, 1, 2].map((index) => writeRun(home, index, { finishedMs: old }));
    for (const { dir } of runs) ageRun(dir, old);
    const cache = new Map();
    const first = byId(catalogRows(home, cache));
    assert.equal(Object.keys(first).length, 3);

    const spy = spyFs();
    let second;
    try { second = byId(catalogRows(home, cache)); } finally { spy.restore(); }
    for (const { runId, dir } of runs) {
      assert.equal(second[runId], first[runId], `${runId}: its cached row is reused`);
      const calls = spy.on(dir);
      assert.ok(calls.length <= 1, `${runId}: ${calls.length} fs calls on a settled run a day old, want at most 1: ${calls.map((call) => `${call.name} ${call.path.slice(dir.length) || '.'}`).join(', ')}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R3 guard: an old settled run is re-read when its directory changes, and drops out when removed', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bs-rv041-r3-')));
  const old = Date.now() - 3 * DAY;
  try {
    const runs = [0, 1].map((index) => writeRun(home, index, { finishedMs: old }));
    for (const { dir } of runs) ageRun(dir, old);
    const cache = new Map();
    const first = byId(catalogRows(home, cache));

    // Run 0 gains a file (its directory mtime moves); run 1 is removed.
    writeFileSync(join(runs[0].dir, 'cancellation.json'), '{}');
    const later = new Date(Date.now() + 60_000);
    utimesSync(runs[0].dir, later, later);
    rmSync(runs[1].dir, { recursive: true, force: true });

    const second = byId(catalogRows(home, cache));
    assert.deepEqual(Object.keys(second), [runs[0].runId]);
    assert.notEqual(second[runs[0].runId], first[runs[0].runId], 'a changed directory is read again');
    assert.equal(cache.size, 1, 'a removed run leaves the cache');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R3 guard: a settled run younger than a day keeps the full fingerprint', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bs-rv041-r3-')));
  try {
    const recent = Date.now() - HOUR;
    const { runId, dir } = writeRun(home, 0, { finishedMs: recent });
    ageRun(dir, recent);
    const cache = new Map();
    const first = byId(catalogRows(home, cache));
    // state.json rewritten in place: the directory mtime does not move.
    writeRun(home, 0, { finishedMs: recent, goal: 'changed after resume' });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'state.json'), later, later);
    utimesSync(dir, new Date(recent), new Date(recent));
    const second = byId(catalogRows(home, cache));
    assert.notEqual(second[runId], first[runId], 'a young run with a changed file is read again');
    assert.equal(second[runId].state.intent.goal, 'changed after resume');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- R4 (guard): a 3021 inside a generic OpenCode stream error waits --------

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const packagedOpenCode = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'providers/contrib/opencode/connector.json'), 'utf8'));
const streamingEvent = (event) => ({
  ...packagedOpenCode,
  spawn: {
    ...packagedOpenCode.spawn,
    cmd: [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(event))}); process.exit(1)`, '--'],
  },
});

const CF_3021_BODY = '{"errors":[{"message":"AiError: AiError: rate limiting: inference request per min rate reached (6d1ea148-0f94-4f01-adde-9e65e2f09183)","code":3021}],"success":false,"result":{},"messages":[]}';
// The 7sb3va shape as it really arrives (counted by the lead in the run
// records, 21 to 28 Nov: 115 OpenCode error events). The 3021 body comes as an
// APIError whose message is the HTTP 429 reason phrase plus the body, with the
// same body in responseBody; the stream's `why` is the generic
// "provider stream reported error". No UnknownError or other message wording
// carried a 3021 in that week.
const GENERIC_3021_EVENTS = {
  'an APIError "Too Many Requests: {3021 body}" with the body in responseBody': {
    type: 'error', sessionID: 'ses_rv041a',
    error: { name: 'APIError', data: { message: `Too Many Requests: ${CF_3021_BODY}`, statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after': '1' }, responseBody: CF_3021_BODY } },
  },
};

function tempCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-rv041-r4-'));
  return { dir, paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const [label, event] of Object.entries(GENERIC_3021_EVENTS)) {
  test(`R4 guard: ${label} is a same-pool throttle, not a provider failure`, async () => {
    const ctx = tempCtx();
    try {
      const verdict = await watchOnce(streamingEvent(event), 'Do the thing.', ctx.dir, ctx.paths, { usageLimitsToCaller: true });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.failureKind, 'throttle', verdict.why);
      assert.equal(verdict.throttleRetrySamePool, true);
      assert.notEqual(verdict.why, 'provider stream reported error');
    } finally { ctx.cleanup(); }
  });
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 2); });
const good = { ok: true, why: 'done', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };
const cfConnector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'cf/inkling' } },
});

test('R4 guard: dispatch waits on the same pool after a generic-stream 3021, with the step retry unspent', async () => {
  const ctx = tempCtx();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-rv041-r4d-')));
  try {
    const throttled = await watchOnce(streamingEvent(GENERIC_3021_EVENTS['an APIError "Too Many Requests: {3021 body}" with the body in responseBody']), 'Do the thing.', ctx.dir, ctx.paths, { usageLimitsToCaller: true });
    const providerFail = { ok: false, failureKind: 'provider', why: 'provider stream reported error', meta: { exitCode: 1, wallSec: 1 } };
    const verdicts = [throttled, providerFail, good];
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const result = await dispatchV2Action({
      action: { id: 'tests', lane: 'analyze', effort: 'low' }, taskText: 'look', targetDir: root,
      paths: { taskFile: join(root, 'task-tests.md'), outFile: join(root, 'out-tests.md') },
      pools: [cfConnector('cf:inkling')], bullswarmDir: root, runDir: null, maxMechanicalRetries: 1,
      dependencies: {
        watchOnce: async () => verdicts.shift(),
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        uuid: () => 'session-fixed', sleep: tick, capsPollMs: 1, random: () => 0,
      },
    });
    const attempts = result.attempts ?? [];
    assert.deepEqual(attempts.map((attempt) => attempt.pool), ['cf:inkling', 'cf:inkling', 'cf:inkling'], result.verdict?.why ?? result.why);
    assert.equal(attempts[0].failureKind, 'throttle');
    assert.equal(attempts[1].retryOf?.how, 'wait', 'the 3021 retry is the backoff, not a counted retry');
    assert.equal(result.ok, true, 'the step\'s one retry was still there for the provider failure after the wait');
  } finally { ctx.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

// --- R5 (guard): one message, several usage lines, counted once -------------

function tokensFor(usage, pool, model) {
  const m = attemptMetric({ pool, model, status: 'succeeded', startedAt: '2026-11-27T02:00:00.000Z', finishedAt: '2026-11-27T02:10:00.000Z', usage });
  return tokensModel([rollup('r5', [{ ...m, startedAt: '2026-11-27T02:00:00.000Z', finishedAt: '2026-11-27T02:10:00.000Z' }])], { period: '7d', now: NOW }).totals;
}

test('R5 guard: Claude Code partial usage rows for one message id count once (last wins), through to the Tokens totals', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r5c-'));
  try {
    const sessionId = '5b0c1f1e-0000-4000-8000-000000000541';
    const dir = join(home, '.claude', 'projects', '-tmp-rv041');
    mkdirSync(dir, { recursive: true });
    const row = (id, requestId, at, usage) => JSON.stringify({
      type: 'assistant', sessionId, cwd: '/tmp/rv041', requestId, timestamp: at,
      message: { id, model: 'claude-sonnet-5-5', role: 'assistant', usage },
    });
    writeFileSync(join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId, cwd: '/tmp/rv041', timestamp: '2026-11-27T02:00:00.000Z', message: { role: 'user', content: 'go' } }),
      // Three streamed rows for msg_a: partial, partial, final.
      row('msg_a', 'req_a', '2026-11-27T02:01:00.000Z', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 1 }),
      row('msg_a', 'req_a', '2026-11-27T02:01:01.000Z', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 50 }),
      row('msg_a', 'req_a', '2026-11-27T02:01:02.000Z', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 300 }),
      row('msg_b', 'req_b', '2026-11-27T02:02:00.000Z', { input_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, output_tokens: 7 }),
      row('msg_b', 'req_b', '2026-11-27T02:02:01.000Z', { input_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, output_tokens: 40 }),
    ].join('\n') + '\n');
    const usage = readClaudeUsage({ sessionId, home });
    assert.equal(usage.requests.length, 2, 'two messages, not five rows');
    assert.equal(usage.tokens.standardRead, 15);
    assert.equal(usage.tokens.cacheRead, 3_000);
    assert.equal(usage.tokens.cacheWrite, 200);
    assert.equal(usage.tokens.output, 340);
    const totals = tokensFor({ tokenSource: 'transcript', tokens: usage.tokens }, 'claude-code:w', 'claude-sonnet-5-5');
    assert.equal(totals.input, 15 + 3_000 + 200);
    assert.equal(totals.cacheRead, 3_000);
    assert.equal(totals.output, 340);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('R5 guard: an OpenCode (cf) message with several step usage parts counts once, through to the Tokens totals', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-rv041-r5o-'));
  try {
    const dataDir = join(home, '.local', 'share', 'opencode');
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const sid = 'ses_rv041opencode';
    const t = Date.parse('2026-11-27T02:01:00.000Z');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sid, '/tmp/rv041', 'cf/inkling', t - 60_000, t + 60_000, 0, 0, 0, 0, 0);
    const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
    insertMessage.run('msg_u', sid, t - 30_000, t - 30_000, JSON.stringify({ role: 'user', time: { created: t - 30_000 } }));
    const final = { input: 400, output: 90, reasoning: 10, cache: { read: 6_000, write: 0 } };
    insertMessage.run('msg_a', sid, t, t + 5_000, JSON.stringify({
      role: 'assistant', modelID: 'inkling', providerID: 'cloudflare', time: { created: t, completed: t + 5_000 }, tokens: final,
    }));
    // Several step-finish parts on the same message each carry usage.
    for (const [i, step] of [{ input: 100, output: 20, reasoning: 0, cache: { read: 2_000, write: 0 } }, { input: 300, output: 70, reasoning: 10, cache: { read: 4_000, write: 0 } }].entries()) {
      insertPart.run(`prt_${i}`, 'msg_a', sid, t + i, t + i, JSON.stringify({ type: 'step-finish', tokens: step }));
    }
    db.close();
    const usage = readOpenCodeUsage({ sessionId: sid, home });
    assert.equal(usage.requests.length, 1, 'one assistant message, one request');
    assert.deepEqual(
      [usage.tokens.standardRead, usage.tokens.cacheRead, usage.tokens.output, usage.tokens.reasoning],
      [400, 6_000, 90, 10],
    );
    const totals = tokensFor({ tokenSource: 'transcript', tokens: usage.tokens }, 'cf:inkling', 'cf/inkling');
    assert.equal(totals.input, 6_400);
    assert.equal(totals.output, 100);
    assert.equal(totals.total, 6_500);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
