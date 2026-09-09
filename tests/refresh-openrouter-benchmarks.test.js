import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, 'scripts', 'refresh-openrouter-benchmarks.mjs');
const BENCHMARKS = join(REPO, 'fixtures', 'openrouter', 'benchmarks.json');
const MODELS = join(REPO, 'fixtures', 'openrouter', 'models.json');

test('refreshes the OpenRouter datapack from offline fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-openrouter-refresh-'));
  const output = join(dir, 'pack.json');
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--benchmarks-file', BENCHMARKS,
      '--models-file', MODELS,
      '--output', output,
    ], { cwd: REPO, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const pack = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(Object.keys(pack.models).length, 1);
    assert.equal(pack.benchmarkRecords.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
