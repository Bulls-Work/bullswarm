import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HELP_PATHS, helpForArgs } from '../src/help.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

test('every documented command and nested subcommand accepts --help', () => {
  const base = mkdtempSync(join(tmpdir(), 'bullswarm-help-'));
  const bullswarmHome = join(base, 'must-not-be-created');
  try {
    for (const path of HELP_PATHS) {
      const result = spawnSync(process.execPath, [BIN, ...path, '--help'], {
        cwd: ROOT,
        env: { ...process.env, BULLSWARM_HOME: bullswarmHome },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${path.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage: bullswarm/m, path.join(' '));
      assert.equal(result.stderr, '', path.join(' '));
    }
    assert.equal(existsSync(bullswarmHome), false, 'help must not initialize Bullswarm state');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('help remains contextual when operands precede the flag', () => {
  assert.match(helpForArgs(['workflow', 'run', 'demo', '--help']), /workflow run <file-or-name>/);
  assert.match(helpForArgs(['workflow', 'runs', 'show', 'abc234', '-h']), /runs show <shortId\|runId>/);
  assert.match(helpForArgs(['workflow', 'runs', 'result', 'abc234', '-h']), /runs result <shortId\|runId>/);
  assert.match(helpForArgs(['workflow', 'draft', 'step', 'add', 'd', 'p', 's', '--help']), /draft step add/);
});

test('help command syntax and aliases resolve without executing commands', () => {
  assert.match(helpForArgs(['help']), /Commands:/);
  assert.match(helpForArgs(['help', 'workflow', 'watch']), /workflow watch <runId>/);
  assert.match(helpForArgs(['runs', 'delete', '--help']), /workflow runs delete/);
  assert.equal(helpForArgs(['workflow', 'list']), null);
});
