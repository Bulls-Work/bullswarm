// `workflow runs result` on a finished v3 run: the text and the --summary
// document carry each step's checked answer (as watch and wait do), and a v3
// run prints no v2 `# gaps` line (it reports facts, not requirements).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SINGLE = fileURLToPath(new URL('./fixtures/v3-runs/wf-mulitn5f-6c56dd/', import.meta.url));
const bin = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-v3-result-'));
  try {
    cpSync(SINGLE, join(dir, 'workflows', 'wf-mulitn5f-6c56dd'), { recursive: true });
    return fn((...args) => spawnSync(process.execPath, [bin, 'workflow', 'runs', 'result', '5r8jyi', ...args], {
      env: { ...process.env, BULLSWARM_HOME: dir, BULLSWARM_DEPTH: '' }, encoding: 'utf8',
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runs result text shows a v3 step\'s checked answer and no # gaps line', () => withHome((result) => {
  const out = result();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^# answer  task  \{"words":13\}$/m);
  assert.doesNotMatch(out.stdout, /# gaps/);
}));

test('runs result --json --summary carries a v3 step\'s checked answer', () => withHome((result) => {
  const out = result('--json', '--summary');
  assert.equal(out.status, 0, out.stderr);
  const summary = JSON.parse(out.stdout);
  const task = summary.actions.find((action) => action.id === 'task');
  assert.deepEqual(task.answer, { words: 13 });
}));
