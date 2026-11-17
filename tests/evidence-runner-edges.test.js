import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVIDENCE_DEFAULT_TIMEOUT_SEC, evidenceItemTimeoutSec, runEvidenceItem } from '../src/workflow/evidence-runner.js';

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acme-edges-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('E1: a timeout outside 1-600 or not an integer falls back to the default', () => {
  for (const bad of [0, -5, 9999, 601, 1.5, '30', null, undefined, NaN]) {
    assert.equal(evidenceItemTimeoutSec({ type: 'command', cmd: 'true', timeoutSec: bad }), EVIDENCE_DEFAULT_TIMEOUT_SEC, `timeoutSec ${String(bad)}`);
  }
  for (const good of [1, 30, 600]) {
    assert.equal(evidenceItemTimeoutSec({ type: 'command', cmd: 'true', timeoutSec: good }), good);
  }
});

test('E1: a stored check with timeoutSec 0 or -5 runs with the default instead of timing out at once', async (t) => {
  const cwd = tempDir(t);
  for (const bad of [0, -5, 9999, 1.5]) {
    const logFile = join(cwd, `log-${String(bad)}.txt`);
    const result = await runEvidenceItem({ type: 'command', cmd: 'sleep 0.3', timeoutSec: bad }, { cwd, outFile: join(cwd, 'out.md'), logFile });
    assert.equal(result.status, 'passed', `timeoutSec ${bad}: ${result.why}`);
    assert.match(readFileSync(logFile, 'utf8'), /timeout: 120s/);
  }
});

test('E2: a missing or non-directory working directory names the path', async (t) => {
  const root = tempDir(t);
  const missing = join(root, 'gone');
  const file = join(root, 'plain.txt');
  writeFileSync(file, 'x');
  for (const cwd of [missing, file]) {
    const result = await runEvidenceItem({ type: 'command', cmd: 'true' }, { cwd, outFile: join(root, 'out.md') });
    assert.equal(result.status, 'failed');
    assert.equal(result.exit, null);
    assert.equal(result.why, `working directory not found: ${cwd}`);
  }
});
