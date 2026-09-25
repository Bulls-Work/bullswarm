// `bullswarm run --batch <tasks.jsonl>`: independent single runs from one
// call, at most N at a time, one JSON array of verdicts in input order.
// The CLI tests dispatch for real through the echo fixture; the in-process
// tests drive cmdRunBatch with a fake single run to pin the pool and the
// routing hand-off exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdRunBatch } from '../src/lib/run-batch.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

/** A home whose only pool is the echo fixture, explicitly enabled. */
function echoHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-run-batch-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  for (const file of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(join(dir, 'connectors', file), readFileSync(join(REPO, 'src', 'providers', 'echo', file === 'echo.json' ? 'connector.json' : file)));
  }
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { echo: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tasksFile(dir, lines) {
  const file = join(dir, 'tasks.jsonl');
  writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
  return file;
}

function bullswarm(dir, args, env = {}) {
  const base = { ...process.env };
  delete base.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], {
    // Run from the home, so a line without "addDir" works there, not in the repo.
    cwd: dir,
    env: { ...base, BULLSWARM_HOME: dir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

const readState = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
const nothingRan = (dir) => {
  assert.deepEqual(readState(dir).decisionLog, [], 'no decision was logged');
  assert.equal(existsSync(join(dir, 'runs')) && readdirSync(join(dir, 'runs')).length > 0, false, 'no task file was written');
};

test('run --batch: 3 tasks, 2 at a time, input order kept, one failure exits 1 with the whole array', () => {
  const f = echoHome();
  try {
    // `a` is slow and `b` fails fast, so `c` starts while `a` still runs:
    // two tasks overlap, never three.
    const file = tasksFile(f.dir, [
      { id: 'a', lane: 'chore', prompt: 'SLEEP_MS:3000 first' },
      { id: 'b', lane: 'chore', prompt: 'FAIL:auth second' },
      '',
      { id: 'c', lane: 'build', addDir: REPO, prompt: 'third' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--concurrency', '2', '--no-caller', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const verdicts = JSON.parse(result.stdout);
    assert.deepEqual(verdicts.map((v) => v.id), ['a', 'b', 'c'], 'the array keeps the file order, not the finish order');
    assert.deepEqual(verdicts.map((v) => v.ok), [true, false, true]);
    assert.deepEqual(verdicts.map((v) => v.exit), [0, 1, 0]);
    assert.match(verdicts[1].why, /auth/i);
    for (const v of verdicts) {
      assert.equal(v.pick.pool, 'echo');
      assert.match(v.outFile, /\/runs\/out-/, 'each task is a full single-run verdict');
    }

    // The exact single-run records: one decision per task, one attempt each.
    const log = readState(f.dir).decisionLog;
    assert.equal(log.length, 3);
    const byCwd = (cwd) => log.filter((d) => d.cwd === cwd);
    assert.equal(byCwd(REPO).length, 1, '"addDir" became --add-dir');
    assert.equal(byCwd(REPO)[0].lane, 'build');
    const spans = log.map((d) => [Date.parse(d.startedAt), Date.parse(d.endedAt)]);
    const overlapAt = (t) => spans.filter(([s, e]) => s <= t && t < e).length;
    const peak = Math.max(...spans.map(([s]) => overlapAt(s)));
    assert.equal(peak, 2, `at most two tasks ran at once, and two did: ${JSON.stringify(log.map((d) => [d.startedAt, d.endedAt]))}`);
    // Routing saw the batch's own pick: `a` was booked when the next task routed.
    const first = log.find((d) => d.why === 'verified' && d.cwd !== REPO && d.durationMs >= 3000);
    assert.equal(first.forecast.inflight, 0);
    assert.ok(log.filter((d) => d !== first).every((d) => d.forecast.inflight >= 1), JSON.stringify(log.map((d) => d.forecast)));
    assert.deepEqual(readdirSync(join(f.dir, 'assignments')).filter((name) => name.endsWith('.json')), [], 'every booking was released');
  } finally { f.cleanup(); }
});

test('run --batch without --json prints one line per task and a total', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'one', lane: 'chore', prompt: 'first' },
      { id: 'two', lane: 'chore', prompt: 'second' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--no-caller']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OK one \[echo\] verified$/m);
    assert.match(result.stdout, /^OK two \[echo\] verified$/m);
    assert.match(result.stdout, /^batch: 2 tasks · 2 ok · 0 failed$/m);
  } finally { f.cleanup(); }
});

test('run --batch: a bad line exits 2 before anything runs, naming every bad line', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'good', lane: 'chore', prompt: 'fine' },
      { id: 'typo', lane: 'chore', promt: 'misspelled' },
      '{"id": "broken",',
      { id: 'lane', lane: 'nope', prompt: 'x' },
      { id: 'good', lane: 'chore', taskFile: join(f.dir, 'missing.md') },
      ['not', 'an', 'object'],
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--json']);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.stdout, '', 'no verdict array: nothing ran');
    assert.match(result.stderr, /line 2: unknown key "promt"/);
    assert.match(result.stderr, /line 2: needs "prompt" or "taskFile"/);
    assert.match(result.stderr, /line 3: not valid JSON/);
    assert.match(result.stderr, /line 4: "lane" must be analyze, build, chore \(got "nope"\)/);
    assert.match(result.stderr, /line 5: "taskFile" cannot be read/);
    assert.match(result.stderr, /line 5: id "good" is already used on line 1/);
    assert.match(result.stderr, /line 6: must be a JSON object/);
    assert.match(result.stderr, /nothing ran/);
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

test('run --batch refuses the typed-answer keys until run has those flags', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'a', lane: 'analyze', prompt: 'x', answerSchema: 'schema.json', answerFile: 'a.json' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--json']);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /line 1: "answerSchema" is not supported yet: this version's run has no --answer-schema/);
    assert.match(result.stderr, /line 1: "answerFile" is not supported yet: this version's run has no --answer-file/);
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

test('run --batch passes each line\'s route filters to its own run', () => {
  const f = echoHome();
  try {
    const first = bullswarm(f.dir, ['run', '--batch', tasksFile(f.dir, [{ id: 'finder', lane: 'chore', prompt: 'find' }]), '--no-caller', '--json']);
    assert.equal(first.status, 0, first.stderr);
    const [finder] = JSON.parse(first.stdout);
    const file = tasksFile(f.dir, [
      { id: 'same', lane: 'chore', prompt: 'x', useProvider: 'echo' },
      { id: 'avoid', lane: 'chore', prompt: 'y', avoidPool: ['echo'] },
      { id: 'checker', lane: 'chore', prompt: 'z', independentOf: finder.outFile },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--no-caller', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const verdicts = JSON.parse(result.stdout);
    assert.deepEqual(verdicts.map((v) => [v.id, v.ok]), [['same', true], ['avoid', false], ['checker', false]]);
    assert.match(verdicts[1].why, /no pool left after route filters/);
    // The only pool ran the finder, so an independent checker has nowhere to go.
    assert.match(verdicts[2].why, /independent/);
    assert.ok(verdicts.every((v) => v.routeFilter), 'each verdict reports its own filter');
  } finally { f.cleanup(); }
});

test('run --batch: a route filter that names nothing real exits 2 before anything runs', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'a', lane: 'chore', prompt: 'x', avoidPool: 'nosuch' },
      { id: 'b', lane: 'chore', prompt: 'x', independentOf: 'no-such-run' },
      { id: 'c', lane: 'chore', prompt: 'x', useProvider: [] },
      { id: 'd', lane: 'chore', prompt: 'x' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--json']);
    assert.equal(result.status, 2, result.stdout);
    const lines = result.stderr.trim().split('\n');
    assert.match(lines[0], /^✗ line 1: "avoidPool" names "nosuch", which is not a configured pool/);
    assert.match(lines[1], /^✗ line 2: "independentOf" "no-such-run" matches no finished run/);
    assert.match(lines[2], /^✗ line 3: "useProvider" must be a non-empty string or a list of them/);
    assert.equal(lines.at(-1), 'nothing ran');
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

test('run --batch: flags that belong on a line, and a bad --concurrency, are usage errors', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [{ id: 'a', lane: 'chore', prompt: 'x' }]);
    const cases = [
      [['--batch', file, '--lane', 'chore'], /--lane does not apply with --batch: set "lane" on each line/],
      [['--batch', file, '--add-dir', '.'], /--add-dir does not apply with --batch: set "addDir" on each line/],
      [['--batch', file, '--avoid-pool', 'echo'], /--avoid-pool does not apply with --batch: set "avoidPool" on each line/],
      [['--batch', file, '--heartbeat', '5'], /--heartbeat does not apply with --batch$/m],
      [['--batch', file, 'trailing', 'words'], /--batch takes no trailing task text/],
      [['--batch', file, '--concurrency', '0'], /--concurrency must be a whole number of at least 1 \(got "0"\)/],
      [['--batch', file, '--concurrency', 'two'], /--concurrency must be a whole number of at least 1/],
      [['--batch', file, '--timeout', 'soon'], /--timeout must be a number of seconds greater than 0/],
      [['--concurrency', '2', '--lane', 'chore', '--prompt', 'x'], /--concurrency needs --batch <tasks.jsonl>/],
      [['--batch'], /--batch requires a file/],
      [['--batch', join(f.dir, 'nope.jsonl')], /cannot read .*nope\.jsonl \(ENOENT\)/],
    ];
    for (const [args, message] of cases) {
      const result = bullswarm(f.dir, ['run', ...args, '--json']);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, message, args.join(' '));
    }
    // --concurrency on a single run: that run's own flags are not batch mistakes.
    const single = bullswarm(f.dir, ['run', '--concurrency', '2', '--lane', 'chore', '--prompt', 'x']);
    assert.equal(single.status, 2);
    assert.doesNotMatch(single.stderr, /does not apply with --batch|trailing task text/);
    const empty = join(f.dir, 'empty.jsonl');
    writeFileSync(empty, '\n\n');
    const result = bullswarm(f.dir, ['run', '--batch', empty]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no tasks in/);
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

test('run --batch: the recursion guard refuses the whole batch as one array', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'a', lane: 'chore', prompt: 'x' },
      { id: 'b', lane: 'chore', prompt: 'y' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--json'], { BULLSWARM_DEPTH: '2' });
    assert.equal(result.status, 1, result.stderr);
    const verdicts = JSON.parse(result.stdout);
    assert.deepEqual(verdicts.map((v) => [v.id, v.ok, v.keepOnClaude]), [['a', false, true], ['b', false, true]]);
    assert.match(verdicts[0].why, /recursion guard/);
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

test('run --batch --dry-run previews every line and dispatches nothing', () => {
  const f = echoHome();
  try {
    const file = tasksFile(f.dir, [
      { id: 'a', lane: 'chore', prompt: 'x', effort: 'low', reasoning: 'default' },
      { id: 'b', lane: 'analyze', prompt: 'y' },
    ]);
    const result = bullswarm(f.dir, ['run', '--batch', file, '--dry-run', '--no-caller', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const verdicts = JSON.parse(result.stdout);
    assert.deepEqual(verdicts.map((v) => [v.id, v.dryRun, v.pick.pool]), [['a', true, 'echo'], ['b', true, 'echo']]);
    nothingRan(f.dir);
  } finally { f.cleanup(); }
});

// --- in process, with a fake single run --------------------------------------

function fakeRuns({ failing = [], throwing = [] } = {}) {
  const events = [];
  let active = 0;
  let peak = 0;
  const pending = new Map();
  const runOne = async (opts) => {
    const id = opts.prompt;
    events.push(`start ${id}`);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`booked ${id}`);
    opts.onDispatch();
    await new Promise((resolve) => pending.set(id, resolve));
    active -= 1;
    if (throwing.includes(id)) throw new Error(`${id} blew up`);
    const ok = !failing.includes(id);
    opts.onVerdict({ ok, why: ok ? 'verified' : 'no', pick: { pool: 'p' }, seen: opts });
    return ok ? 0 : 1;
  };
  return { runOne, events, pending, peak: () => peak };
}

async function inProcess(lines, runs, concurrency) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-run-batch-fake-'));
  const printed = [];
  const errors = [];
  try {
    const file = tasksFile(dir, lines);
    const done = cmdRunBatch({
      batch: file, concurrency, json: true, rest: [], 'no-caller': true,
      _flags: ['batch', 'concurrency', 'json', 'no-caller'],
    }, {
      runOne: runs.runOne, bullswarmDir: dir, print: (line) => printed.push(line), error: (line) => errors.push(line),
    });
    let settled = false;
    done.then(() => { settled = true; }, () => { settled = true; });
    // Finish one task only once every slot that should be busy is waiting
    // (so the peak does not depend on timer luck), last-started first, so the
    // finish order differs from the file order.
    let finished = 0;
    for (let tick = 0; !settled && tick < 4000; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!runs.pending.size || runs.pending.size < Math.min(concurrency, lines.length - finished)) continue;
      const last = [...runs.pending.keys()].at(-1);
      runs.pending.get(last)();
      runs.pending.delete(last);
      finished += 1;
    }
    return { code: await done, verdicts: printed.length ? JSON.parse(printed.join('\n')) : null, errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cmdRunBatch never runs more than --concurrency at once, and routes one task at a time', async () => {
  const runs = fakeRuns({ failing: ['t2'] });
  const lines = ['t1', 't2', 't3', 't4', 't5'].map((id) => ({ id, lane: 'chore', prompt: id }));
  const { code, verdicts } = await inProcess(lines, runs, 2);
  assert.equal(code, 1);
  assert.deepEqual(verdicts.map((v) => [v.id, v.exit, v.ok]), [
    ['t1', 0, true], ['t2', 1, false], ['t3', 0, true], ['t4', 0, true], ['t5', 0, true],
  ]);
  assert.equal(runs.peak(), 2);
  // Each task starts only once the task before it has booked its pool.
  for (let i = 2; i <= 5; i++) {
    assert.ok(runs.events.indexOf(`booked t${i - 1}`) < runs.events.indexOf(`start t${i}`), runs.events.join(', '));
  }
  // The line became the single run's own options.
  const seen = verdicts[0].seen;
  assert.equal(seen.lane, 'chore');
  assert.equal(seen['no-caller'], true);
  assert.equal(seen.json, true);
  assert.deepEqual(seen.rest, []);
});

test('cmdRunBatch turns a single run that throws into a failed verdict and keeps going', async () => {
  const runs = fakeRuns({ throwing: ['b'] });
  const lines = ['a', 'b', 'c'].map((id) => ({ id, lane: 'build', prompt: id }));
  const { code, verdicts } = await inProcess(lines, runs, 4);
  assert.equal(code, 1);
  assert.deepEqual(verdicts.map((v) => [v.id, v.ok]), [['a', true], ['b', false], ['c', true]]);
  assert.equal(verdicts[1].why, 'run failed: b blew up');
  assert.equal(runs.peak(), 3, 'three tasks under a limit of four all run together');
});
