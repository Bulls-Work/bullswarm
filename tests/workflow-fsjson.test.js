import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync, writeJsonAtomic, readJsonSafe, readJsonForUpdate } from '../src/workflow/fsjson.js';

test('atomicWriteFileSync leaves the final content and no temp remnants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-fsjson-'));
  try {
    const p = join(dir, 'nested', 'state.json');
    atomicWriteFileSync(p, '{"a":1}\n');
    atomicWriteFileSync(p, '{"a":2}\n');
    assert.equal(readFileSync(p, 'utf8'), '{"a":2}\n');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['state.json']);
    writeJsonAtomic(p, { b: 3 });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { b: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readJsonSafe tolerates missing and torn files; readJsonForUpdate refuses torn files loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-fsjson-'));
  try {
    const missing = join(dir, 'absent.json');
    assert.equal(readJsonSafe(missing), null);
    assert.equal(readJsonSafe(missing, 'fb'), 'fb');
    const torn = join(dir, 'torn.json');
    // A mid-write snapshot: valid prefix, cut inside a string (the exact shape
    // of the observed TUI crash "Unterminated string in JSON").
    writeFileSync(torn, '{"runId":"wf-x","status":"running","intent":{"goal":"do the th');
    assert.equal(readJsonSafe(torn), null);
    assert.throws(() => readJsonForUpdate(torn, 'workflow state'), /workflow state at .*unreadable.*retry the command/s);
    const fine = join(dir, 'fine.json');
    writeFileSync(fine, '{"ok":true}');
    assert.deepEqual(readJsonForUpdate(fine, 'workflow state'), { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
