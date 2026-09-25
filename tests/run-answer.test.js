// Typed answers on `bullswarm run`: --answer-schema tells the worker to write
// its final answer as JSON, and the verdict carries the parsed answer plus the
// schema check. No retry: an invalid or missing answer is exit 1, and the
// caller decides what happens next.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  answerInstruction, checkAnswer, loadAnswerSchema, withAnswerCheck,
} from '../src/lib/answer.js';
import { rungRecord } from '../src/lib/strategy.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

const dir = mkdtempSync(join(tmpdir(), 'answer-'));
const schemaFile = join(dir, 'schema.json');
writeFileSync(schemaFile, JSON.stringify({
  type: 'object', required: ['n', 'tags'],
  properties: { n: { type: 'integer' }, tags: { type: 'array', items: { enum: ['a', 'b'] } } },
}));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// --- the module ------------------------------------------------------------

test('a valid answer is parsed and passes', () => {
  const f = join(dir, 'ok.json');
  writeFileSync(f, '{"n": 3, "tags": ["a"]}');
  const r = checkAnswer({ answerFile: f, schemaFile });
  assert.deepEqual(r.answer, { n: 3, tags: ['a'] });
  assert.equal(r.answerCheck.ok, true);
  assert.deepEqual(r.answerCheck.errors, []);
  assert.equal(r.answerCheck.why, null);
});

test('a wrong answer and a missing answer both fail with reasons', () => {
  const f = join(dir, 'bad.json');
  writeFileSync(f, '{"n": "three", "tags": ["z"]}');
  const bad = checkAnswer({ answerFile: f, schemaFile });
  assert.equal(bad.answerCheck.ok, false);
  assert.equal(bad.answerCheck.errors.length, 2);
  assert.deepEqual(bad.answer, { n: 'three', tags: ['z'] }, 'the caller still sees what the worker wrote');
  assert.equal(bad.answered, true, 'the worker wrote JSON, even if it breaks the schema');
  const missing = checkAnswer({ answerFile: join(dir, 'nope.json'), schemaFile });
  assert.equal(missing.answer, null);
  assert.equal(missing.answered, false);
  assert.equal(missing.answerCheck.ok, false);
  assert.match(missing.answerCheck.why, /file missing/);
});

test('one surrounding code fence is accepted and noted', () => {
  const f = join(dir, 'fenced.json');
  writeFileSync(f, '```json\n{"n": 1, "tags": []}\n```\n');
  const r = checkAnswer({ answerFile: f, schemaFile });
  assert.equal(r.answerCheck.ok, true);
  assert.deepEqual(r.answer, { n: 1, tags: [] });
  assert.deepEqual(r.answerCheck.notes, ['unwrapped one fenced code block']);
});

test('a file that was not written since the run started is stale, not an answer', () => {
  const f = join(dir, 'stale.json');
  writeFileSync(f, '{"n": 3, "tags": ["a"]}');
  const r = checkAnswer({ answerFile: f, schemaFile, mtimeBefore: statSync(f).mtimeMs });
  assert.equal(r.answerCheck.ok, false);
  assert.equal(r.answerCheck.why, 'answer file not rewritten by this run');
  assert.equal(r.answer, null, 'the old value is never handed back as this run\'s answer');
  assert.equal(r.answered, false);
});

test('schema is vetted up front and quoted in the task instruction', () => {
  const s = loadAnswerSchema(schemaFile);
  assert.equal(s.error, undefined);
  assert.match(answerInstruction(s.text, '/x/answer.json'), /\/x\/answer\.json[\s\S]*"required"/);
  const unsupported = join(dir, 'u.json');
  writeFileSync(unsupported, JSON.stringify({ type: 'object', if: {} }));
  assert.match(loadAnswerSchema(unsupported).error, /unsupported keyword "if"/);
  const notJson = join(dir, 'n.json');
  writeFileSync(notJson, '{ type: object');
  assert.match(loadAnswerSchema(notJson).error, /not JSON/);
  assert.match(loadAnswerSchema(join(dir, 'absent.json')).error, /unreadable/);
});

test('ok needs both the worker and the answer; the worker\'s own verdict stays separate', () => {
  const good = { ok: true, answerCheck: { ok: true, why: null } };
  const bad = { ok: false, errors: ['$.n must be integer (got string)'], why: 'not valid: 1 error' };
  const passed = withAnswerCheck({ ok: true, why: 'verified' }, { answer: { n: 1 }, answerCheck: good.answerCheck });
  assert.equal(passed.ok, true);
  assert.equal(passed.workerOk, true);
  assert.equal(passed.why, 'verified');

  const failed = withAnswerCheck({ ok: true, why: 'verified' }, { answer: { n: 'x' }, answerCheck: bad });
  assert.equal(failed.ok, false);
  assert.equal(failed.workerOk, true);
  assert.equal(failed.why, 'answer check failed (not valid: 1 error) · verified');

  // A worker that failed keeps its own reason: that is the cause to act on.
  const workerFailed = withAnswerCheck({ ok: false, why: 'auth/throttle signature: "x"' }, { answer: null, answerCheck: bad });
  assert.equal(workerFailed.ok, false);
  assert.equal(workerFailed.workerOk, false);
  assert.equal(workerFailed.why, 'auth/throttle signature: "x"');
});

test('a thin reply beside a valid answer passes; every other worker failure still fails', () => {
  const valid = { answer: { n: 1 }, answerCheck: { ok: true, errors: [], why: null } };
  const invalid = { answer: null, answerCheck: { ok: false, errors: ['file missing: /x'], why: 'file missing: /x' } };
  const thin = (why, extra = {}) => ({ ok: false, why, meta: { exitCode: 0 }, ...extra });

  for (const why of ['announcement without substance', 'empty output']) {
    const passed = withAnswerCheck(thin(why), valid);
    assert.equal(passed.ok, true, why);
    assert.equal(passed.workerOk, true, why);
    assert.equal(passed.why, `answer valid (reply: ${why})`);
    // With no answer at all the thin reply is the cause, as before.
    const failed = withAnswerCheck(thin(why), invalid);
    assert.equal(failed.ok, false);
    assert.equal(failed.workerOk, false);
    assert.equal(failed.why, why);
    // An answer the worker wrote that breaks the schema fails the check
    // alone: the worker did its part (a live worker replies "done" to a
    // schema nothing can satisfy).
    const wrong = withAnswerCheck(thin(why), {
      answer: { n: 3 }, answered: true, answerCheck: { ok: false, errors: ['$.n must be >= 5'], why: 'not valid: 1 error' },
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.workerOk, true);
    assert.equal(wrong.why, `answer check failed (not valid: 1 error) · reply: ${why}`);
  }
  for (const verdict of [
    thin('announcement without substance', { meta: { exitCode: 1 } }),
    thin('empty output', { failureKind: 'stalled' }),
    thin('failure pattern at output head or tail'),
  ]) {
    const r = withAnswerCheck(verdict, valid);
    assert.equal(r.ok, false, verdict.why);
    assert.equal(r.workerOk, false);
    assert.equal(r.why, verdict.why);
  }
});

test('a pool\'s ok share counts the worker\'s verdict, not the caller\'s schema', () => {
  const row = (extra) => ({ pool: 'echo', effort: 'low', kind: 'run', ...extra });
  const record = rungRecord([
    row({ ok: true }),
    row({ ok: false, workerOk: true }),
    row({ ok: false }),
    row({ ok: false, workerOk: false }),
  ], 'echo', 'low');
  assert.equal(record.dispatches, 4);
  assert.equal(record.okShare, 0.5);
});

// --- through the CLI, on the deterministic echo pool -----------------------

function home() {
  const root = mkdtempSync(join(tmpdir(), 'bs-run-answer-'));
  mkdirSync(join(root, 'connectors'), { recursive: true });
  writeFileSync(join(root, 'connectors', 'echo.json'), readFileSync(join(REPO, 'src', 'providers', 'echo', 'connector.json')));
  writeFileSync(join(root, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { echo: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function bullswarm(root, args) {
  const env = { ...process.env, BULLSWARM_HOME: root, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

const run = (root, ...extra) => ['run', '--lane', 'build', '--no-caller', '--add-dir', root, ...extra];
const lastDecision = (root) => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).decisionLog.at(-1);

test('a valid answer: exit 0, the answer in the verdict, the check in the task ledger', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'ANSWER:{"n": 3, "tags": ["a", "b"]}'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const verdict = JSON.parse(r.stdout);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.workerOk, true);
    assert.deepEqual(verdict.answer, { n: 3, tags: ['a', 'b'] });
    assert.equal(verdict.answerCheck.ok, true);
    assert.match(verdict.answerCheck.file, /\/runs\/answer-[^/]+\.json$/);

    // The worker was told where to write, and against which schema.
    const task = readFileSync(lastDecision(h.root).taskFile, 'utf8');
    assert.ok(task.includes(verdict.answerCheck.file));
    assert.match(task, /"required": \[/);
    // The copy the answer was checked against sits next to the run's output.
    assert.ok(readdirSync(join(h.root, 'runs')).some((f) => /^answer-schema-.+\.json$/.test(f)));

    const entry = lastDecision(h.root);
    assert.equal(entry.ok, true);
    assert.equal(entry.workerOk, true);
    assert.deepEqual(entry.answerCheck, { ok: true, why: null, errors: [], file: verdict.answerCheck.file });
    assert.equal(entry.reason, null);
  } finally { h.cleanup(); }
});

test('an invalid answer: exit 1, and the decision log records the failed check, not the worker\'s ok', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'ANSWER:{"n": "three", "tags": []}'));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const verdict = JSON.parse(r.stdout);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.workerOk, true);
    assert.deepEqual(verdict.answer, { n: 'three', tags: [] });
    assert.deepEqual(verdict.answerCheck.errors, ['$.n must be integer (got string)']);
    assert.match(verdict.why, /^answer check failed \(not valid: 1 error\)/);

    const state = JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8'));
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.ok, false, 'the recorded outcome agrees with the exit code');
    assert.equal(entry.workerOk, true, 'the worker\'s own verdict is kept as a separate fact');
    assert.equal(entry.answerCheck.ok, false);
    assert.deepEqual(entry.answerCheck.errors, ['$.n must be integer (got string)']);
    assert.match(entry.reason, /^answer check failed/);
    assert.equal(state.incumbents.build, 'echo', 'the pool did its part, so it stays the incumbent');

    // `health` re-judges the saved output as a pass; that is not the gate eating work.
    const health = bullswarm(h.root, ['health', '--json']);
    assert.equal(health.status, 0, health.stdout + health.stderr);
    assert.deepEqual(JSON.parse(health.stdout).gateFailures, []);
  } finally { h.cleanup(); }
});

test('a worker that writes no answer: exit 1 with the file named as missing', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--answer-schema', schemaFile, '--prompt', 'no answer here'));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL \[echo\] answer check failed \(file missing: /m);
    assert.match(r.stdout, /^answer: INVALID — file missing: .*\/runs\/answer-.+\.json \(/m);
    assert.equal(lastDecision(h.root).ok, false);
  } finally { h.cleanup(); }
});

test('a worker failure keeps its own reason; the answer check rides along', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'FAIL:auth'));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const verdict = JSON.parse(r.stdout);
    assert.equal(verdict.workerOk, false);
    assert.match(verdict.why, /auth/);
    assert.doesNotMatch(verdict.why, /answer check/);
    assert.equal(verdict.answerCheck.ok, false);
  } finally { h.cleanup(); }
});

// The worker is told it may skip the prose, so a one-line "done" beside a
// valid answer file is a finished step, not an announcement.
test('a worker that writes a valid answer and replies only with an announcement: exit 0', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'ANSWER:{"n": 4, "tags": []}\nINTENT: say little'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const verdict = JSON.parse(r.stdout);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.workerOk, true);
    assert.equal(verdict.why, 'answer valid (reply: announcement without substance)');
    assert.deepEqual(verdict.answer, { n: 4, tags: [] });
    const entry = lastDecision(h.root);
    assert.equal(entry.ok, true);
    assert.equal(entry.workerOk, true);
    assert.equal(entry.reason, null);
    assert.equal(JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8')).incumbents.build, 'echo');

    // Without an answer the same reply is still an announcement.
    const bare = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'INTENT: say little'));
    assert.equal(bare.status, 1, bare.stdout + bare.stderr);
    assert.equal(JSON.parse(bare.stdout).why, 'announcement without substance');
    assert.equal(JSON.parse(bare.stdout).workerOk, false);

    // An answer that breaks the schema beside the same reply fails the check
    // only: the worker wrote its answer, so `workerOk` stays true.
    const wrong = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--prompt', 'ANSWER:{"n": "four", "tags": []}\nINTENT: say little'));
    assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
    const invalid = JSON.parse(wrong.stdout);
    assert.deepEqual([invalid.ok, invalid.workerOk], [false, true]);
    assert.equal(invalid.why, 'answer check failed (not valid: 1 error) · reply: announcement without substance');
    assert.deepEqual(invalid.answer, { n: 'four', tags: [] });
    assert.equal(lastDecision(h.root).workerOk, true);
  } finally { h.cleanup(); }
});

test('a named answer file the run does not rewrite fails; one it rewrites passes', () => {
  const h = home();
  try {
    const answerFile = join(h.root, 'out', 'step.json');
    mkdirSync(join(h.root, 'out'));
    writeFileSync(answerFile, '{"n": 1, "tags": ["a"]}');
    const stale = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--answer-file', answerFile, '--prompt', 'ignore the answer'));
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    const verdict = JSON.parse(stale.stdout);
    assert.equal(verdict.answerCheck.why, 'answer file not rewritten by this run');
    assert.equal(verdict.answer, null);
    assert.equal(readFileSync(answerFile, 'utf8'), '{"n": 1, "tags": ["a"]}', 'the caller\'s file is left alone');

    const fresh = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--answer-file', answerFile, '--prompt', 'ANSWER:{"n": 2, "tags": ["b"]}'));
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout).answer, { n: 2, tags: ['b'] });
    assert.equal(JSON.parse(fresh.stdout).answerCheck.file, answerFile);
  } finally { h.cleanup(); }
});

test('a named answer file in a missing folder gets its folder', () => {
  const h = home();
  try {
    const answerFile = join(h.root, 'new', 'deeper', 'a.json');
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', schemaFile, '--answer-file', answerFile, '--prompt', 'ANSWER:{"n": 5, "tags": []}'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(answerFile), true);
  } finally { h.cleanup(); }
});

test('an invalid schema is exit 2 before any worker starts', () => {
  const h = home();
  try {
    const badSchema = join(h.root, 'bad-schema.json');
    writeFileSync(badSchema, JSON.stringify({ type: 'object', if: { required: ['n'] } }));
    const before = readFileSync(join(h.root, 'state.json'), 'utf8');
    const r = bullswarm(h.root, run(h.root, '--json', '--answer-schema', badSchema, '--prompt', 'ANSWER:{"n": 1, "tags": []}'));
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--answer-schema: unsupported keyword "if" at #/);
    assert.equal(r.stdout, '');
    const runs = existsSync(join(h.root, 'runs')) ? readdirSync(join(h.root, 'runs')) : [];
    assert.deepEqual(runs.filter((f) => /^(task|out|answer)-/.test(f)), [], 'no task file, no output, no answer');
    assert.deepEqual(JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8')).decisionLog, JSON.parse(before).decisionLog);

    const missing = bullswarm(h.root, run(h.root, '--answer-schema', join(h.root, 'absent.json'), '--prompt', 'x'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--answer-schema unreadable/);
  } finally { h.cleanup(); }
});

test('--answer-file alone, or either flag without a value, is a usage error', () => {
  const h = home();
  try {
    const alone = bullswarm(h.root, run(h.root, '--answer-file', join(h.root, 'a.json'), '--prompt', 'x'));
    assert.equal(alone.status, 2);
    assert.match(alone.stderr, /--answer-file needs --answer-schema/);
    const empty = bullswarm(h.root, run(h.root, '--prompt', 'x', '--answer-schema'));
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /require a value/);
  } finally { h.cleanup(); }
});

test('--dry-run vets the schema and writes nothing', () => {
  const h = home();
  try {
    const r = bullswarm(h.root, run(h.root, '--dry-run', '--json', '--answer-schema', schemaFile, '--prompt', 'x'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).dryRun, true);
    const runs = existsSync(join(h.root, 'runs')) ? readdirSync(join(h.root, 'runs')) : [];
    assert.deepEqual(runs.filter((f) => f.startsWith('answer')), []);
  } finally { h.cleanup(); }
});
