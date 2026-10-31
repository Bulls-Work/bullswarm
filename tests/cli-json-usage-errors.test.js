// A usage error (exit 2) with --json on the command line must leave stdout as
// one JSON object a caller can parse: { error: 'usage', message, usage }.
// Without --json the text is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function bullswarm(args) {
  const home = mkdtempSync(join(tmpdir(), 'bs-json-usage-'));
  try {
    const env = { ...process.env, BULLSWARM_HOME: home };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 30000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const CASES = [
  { name: 'run bad lane', args: ['run', '--json', '--lane=nope', '--prompt=x'], message: '--lane must be analyze, build, chore (got "nope")', usage: false },
  { name: 'run unknown flag', args: ['run', '--json', '--bogus'], message: 'unknown flag --bogus', usage: true },
  { name: 'pools unknown flag', args: ['pools', '--json', '--bogus'], message: 'unknown flag --bogus', usage: true },
  { name: 'workflow runs list unknown flag', args: ['workflow', 'runs', 'list', '--json', '--bogus'], message: 'unknown flag --bogus', usage: true },
  { name: 'strategy unknown flag', args: ['strategy', '--json', '--bogus'], message: 'unknown flag --bogus', usage: true },
  { name: 'workflow add missing argument', args: ['workflow', 'add', '--json'], message: null, usage: true },
  { name: 'provider unknown flag', args: ['provider', 'list', '--json', '--bogus'], message: 'unknown flag --bogus', usage: true },
  { name: 'json=true form', args: ['pools', '--json=true', '--bogus'], message: 'unknown flag --bogus', usage: true },
];

for (const c of CASES) {
  test(`json usage error: ${c.name}`, () => {
    const r = bullswarm(c.args);
    assert.equal(r.code, 2);
    const body = JSON.parse(r.out);
    assert.equal(body.error, 'usage');
    if (c.message) assert.ok(body.message.includes(c.message), body.message);
    else assert.ok(body.message.length > 0);
    if (c.usage) assert.match(body.usage, /^bullswarm /);
    else assert.equal(body.usage, null);
    assert.equal(r.out.trim().split('\n').filter((l) => l.startsWith('{')).length > 0, true);
    assert.ok(r.err.length > 0, 'human text stays on stderr');
  });
}

test('without --json the usage error text is unchanged', () => {
  const r = bullswarm(['pools', '--bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /^✗ unknown flag --bogus\nusage: bullswarm pools /);
  const lane = bullswarm(['run', '--lane=nope', '--prompt=x']);
  assert.equal(lane.out, '');
  assert.equal(lane.err, '--lane must be analyze, build, chore (got "nope")\n');
});

test('--json=false keeps the plain text', () => {
  const r = bullswarm(['pools', '--json=false', '--bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
});

// Not usage errors: refusals, validation and I/O failures exit 2 too, but they
// are not usage errors, so stdout stays empty as on main.
const NOT_USAGE = [
  { name: 'runs delete without --yes', args: ['workflow', 'runs', 'delete', 'abcdef', '--json'] },
  { name: 'plan validate with a missing program file', args: ['workflow', 'plan', 'validate', 'x', '--program', '/nonexistent-bs.json', '--json'] },
  { name: 'provider validate of a missing path', args: ['provider', 'validate', '/nonexistent-bs', '--json'] },
];

for (const c of NOT_USAGE) {
  test(`json: a non-usage exit-2 refusal prints no usage object: ${c.name}`, () => {
    const r = bullswarm(c.args);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.ok(r.err.length > 0);
  });
}

test('json: the message is the reason alone and usage is the run synopsis, never "usage error"', () => {
  const r = bullswarm(['run', '--lane', 'build', '--prompt', '--json']);
  assert.equal(r.code, 2);
  const body = JSON.parse(r.out);
  assert.equal(body.error, 'usage');
  assert.equal(body.message, '--prompt and --task-file require a value');
  assert.notEqual(body.message, 'usage error');
  assert.ok(body.usage === null || /^bullswarm run /.test(body.usage), String(body.usage));
});

test('json: a --json token after -- is task text, not the mode', () => {
  const r = bullswarm(['run', '--lane', 'build', '--', '--json']);
  assert.equal(r.out.trim().startsWith('{') && r.out.includes('"error": "usage"'), false);
});

test('json: a help-dump usage error has a one-line message', () => {
  const r = bullswarm(['strategy', 'bogus', '--json']);
  assert.equal(r.code, 2);
  const body = JSON.parse(r.out);
  assert.equal(body.error, 'usage');
  assert.ok(!body.message.includes('\n'), body.message);
  assert.ok(!/^usage:/i.test(body.message), body.message);
});

// Input errors (a file that cannot be read, a directory that does not exist)
// also exit 2, but they are not usage errors: stdout stays empty as on main.
const INPUT_ERRORS = [
  { name: 'run --task-file that cannot be read', args: ['run', '--lane', 'build', '--add-dir', tmpdir(), '--task-file', '/nonexistent-bs-task', '--json'], text: /cannot read --task-file/ },
  { name: 'run --answer-schema that cannot be read', args: ['run', '--lane', 'build', '--add-dir', tmpdir(), '--prompt', 'x', '--answer-schema', '/nonexistent-bs-schema', '--json'], text: /cannot read --answer-schema/ },
  { name: 'run --add-dir that is not a directory', args: ['run', '--lane', 'build', '--add-dir', '/nonexistent-bs-dir', '--prompt', 'x', '--json'], text: /--add-dir is not an existing directory/ },
];

for (const c of INPUT_ERRORS) {
  test(`json: an input error is not a usage error: ${c.name}`, () => {
    const r = bullswarm(c.args);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, c.text);
  });
}

// The guard: one representative usage error per command family and per
// producer, each with --json. Every one must leave exactly one
// { error: 'usage' } object on stdout, a non-empty message, and exit 2. A new
// usage exit that forgets reportUsageError fails here.
const GUARD = [
  ['workflow', 'continue', 'abc', 'n1', '--wait', '-1', '--json'],
  ['workflow', 'continue', 'abc', 'n1', '--rounds', 'x', '--json'],
  ['workflow', 'continue', '--json'],
  ['workflow', 'add', 'abc', '--steps', 'x.json', '--from-answer', 's', '--json'],
  ['workflow', 'add', 'abc', '--steps', 'x.json', '--wait', '-1', '--json'],
  ['workflow', 'wait', 'abc', 's1', '--timeout', '-3', '--json'],
  ['workflow', 'wait', '--json'],
  ['workflow', 'step', 'restart', 'abc', 's1', '--wait', '-1', '--json'],
  ['workflow', 'step', 'restart', '--json'],
  ['workflow', 'resume', 'abc', '--watch', '--json'],
  ['workflow', 'resume', '--json'],
  ['workflow', 'pause', '--json'],
  ['workflow', 'cancel', '--json'],
  ['workflow', 'steer', 'abc', '--json'],
  ['workflow', 'events', 'abc', '--after', 'x', '--json'],
  ['workflow', 'events', '--json'],
  ['workflow', 'watch', 'abc', '--until', 'bogus', '--json'],
  ['workflow', 'watch', 'abc', '--classic', '--next', '--json'],
  ['workflow', 'watch', '--json'],
  ['workflow', 'action', 'show', '--json'],
  ['workflow', 'task', 'show', '--json'],
  ['workflow', 'plan', 'nope', '--json'],
  ['workflow', 'plan', 'validate', '--json'],
  ['workflow', 'plan', 'contract', '--json'],
  ['workflow', 'runs', 'nope', '--json'],
  ['workflow', 'runs', '--since', 'garbage', '--json'],
  ['workflow', 'runs', 'show', '--json'],
  ['workflow', 'runs', '--limit', 'x', '--json'],
  ['workflow', 'reprice', '--since', 'garbage', '--json'],
  ['workflow', 'goal', 'g', '--planner', 'x', '--program', 'p.json', '--json'],
  ['workflow', 'goal', 'g', '--watch', '--json', '--program', 'x.json'],
  ['workflow', 'goal', '--json'],
  ['workflow', 'nope', '--json'],
  ['integrate', 'nope', '--json'],
  ['pools', '--max-age', 'x', '--json'],
  ['pools', '--pool', '--json'],
  ['pools', '--pool', 'no-such-pool', '--json'],
  ['pools', 'nope', '--json'],
  ['pools', 'label', '--json'],
  ['assignments', '--max-age', 'x', '--json'],
  ['run', '--json', '--bogus'],
  ['run', '--json', '--lane', 'nope', '--prompt', 'x'],
  ['strategy', 'bogus', '--json'],
  ['strategy', 'set-reserve', '--json'],
  ['provider', 'bogus', '--json'],
  ['home', 'bogus', '--json'],
  ['home', 'snapshot', '--json'],
  ['nope-verb', '--json'],
];

test('json guard: the family list is large enough to mean something', () => {
  assert.ok(GUARD.length >= 30, String(GUARD.length));
});

for (const args of GUARD) {
  test(`json guard: ${args.join(' ')}`, () => {
    const r = bullswarm(args);
    assert.equal(r.code, 2, r.err);
    const lines = r.out.trim().split('\n');
    const body = JSON.parse(r.out);
    assert.equal(body.error, 'usage', r.out);
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.length > 0);
    assert.equal(Object.keys(body).join(), 'error,message,usage');
    assert.ok(lines.length > 1 && r.out.trim().startsWith('{') && r.out.trim().endsWith('}'));
  });
}
