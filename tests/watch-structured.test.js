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

// A v3 step with no answer declared gets an accept-all validator
// (workflow/answers.js stepAnswerHooks): it checks nothing, so the verdict
// never claims a validated answer, and content that passes the judge after a
// non-zero exit is still reported as usable.
const COMPLETE = 'Refactor complete.\n\n- Renamed getUser to fetchUser across 12 files (grep-verified: zero remaining references).\n- All 47 tests pass. Files touched: src/api/user.ts, src/api/index.ts, src/hooks/useUser.ts, and 9 test files.\n';

test('a step with no answer declared: exit 1 after complete content is usable, and no answer is claimed', async () => {
  const { stepAnswerHooks } = await import('../src/workflow/answers.js');
  const f = fixture(COMPLETE, 1);
  try {
    const result = await watchOnce(f.connector, 'do the work', f.dir, f.paths, {
      outputValidator: stepAnswerHooks({ id: 'task' }).outputValidator,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'process');
    assert.equal(result.contentUsableDespiteExit, true);
    assert.doesNotMatch(result.why, /structured output validated/);
    assert.match(result.why, /no answer declared/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a step with no answer declared that exits 0 does not claim a validated answer', async () => {
  const { stepAnswerHooks } = await import('../src/workflow/answers.js');
  const f = fixture(COMPLETE, 0);
  try {
    const result = await watchOnce(f.connector, 'do the work', f.dir, f.paths, {
      outputValidator: stepAnswerHooks({ id: 'task' }).outputValidator,
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.why, /structured output validated/);
    assert.equal(result.contentUsableDespiteExit, false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a validated answer with a non-zero exit is usable despite the exit', async () => {
  const f = fixture('{"answer":42}', 1);
  try {
    const result = await watchOnce(f.connector, 'return structured data', f.dir, f.paths, {
      outputValidator: (text) => ({ ok: true, errors: [], value: JSON.parse(text) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.why, 'structured output validated but process exited non-zero');
    assert.equal(result.contentUsableDespiteExit, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an invalid answer with a non-zero exit is not usable', async () => {
  const f = fixture('{"answer":41}', 1);
  try {
    const result = await watchOnce(f.connector, 'return structured data', f.dir, f.paths, {
      outputValidator: () => ({ ok: false, errors: ['answer must be 42'] }),
    });
    assert.equal(result.contentUsableDespiteExit, false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
