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
