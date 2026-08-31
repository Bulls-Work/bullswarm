import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOnce } from '../src/lib/watch.js';

function fixture(output, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-structured-watch-'));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});\n`);
  return {
    dir,
    connector: { name: 'fixture', spawn: { cmd: [process.execPath, worker, '{taskFile}'], cwdMode: 'cwd' }, outputExtraction: { strategy: 'stdout' } },
    paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') },
  };
}

test('structured validator, not prose heuristics, determines schema-bound success', async () => {
  const f = fixture('{"answer":42}');
  try {
    const result = await watchOnce(f.connector, 'return structured data', f.dir, f.paths, {
      outputValidator: (text) => {
        const value = JSON.parse(text);
        return value.answer === 42 ? { ok: true, errors: [], value } : { ok: false, errors: ['answer must be 42'] };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.why, 'structured output validated');
    assert.deepEqual(result.structured.value, { answer: 42 });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('schema rejection remains a mechanical structured-output failure', async () => {
  const f = fixture('{"answer":41}');
  try {
    const result = await watchOnce(f.connector, 'return structured data', f.dir, f.paths, {
      outputValidator: () => ({ ok: false, errors: ['answer must be 42'] }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'schema');
    assert.deepEqual(result.structured.errors, ['answer must be 42']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
