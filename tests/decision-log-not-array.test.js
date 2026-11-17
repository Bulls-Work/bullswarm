// A state.json whose decisionLog is present but not an array must not make a
// dispatch throw after the worker ran. Writers set the bad value aside; read-only
// loaders treat it as empty and never write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, updateState } from '../src/lib/state.js';

function homeWith(decisionLog) {
  const home = mkdtempSync(join(tmpdir(), 'bs-dlog-'));
  const body = { version: 1, pools: {}, incumbents: {}, config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true } };
  if (decisionLog !== undefined) body.decisionLog = decisionLog;
  writeFileSync(join(home, 'state.json'), `${JSON.stringify(body, null, 2)}\n`);
  return home;
}
const sideFiles = (home) => readdirSync(home).filter((f) => /^state\.decisionLog-.*\.json$/.test(f));

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

for (const bad of [{ a: 1 }, 'x', 7]) {
  test(`updateState sets aside decisionLog ${JSON.stringify(bad)} once and appends`, () => {
    const home = homeWith(bad);
    try {
      let err = captureStderr(() => updateState(home, (s) => { s.decisionLog.push({ n: 1 }); }));
      assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).decisionLog, [{ n: 1 }]);
      const files = sideFiles(home);
      assert.equal(files.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(home, files[0]), 'utf8')), bad);
      assert.equal(err.split('\n').filter((l) => l.includes(files[0])).length, 1);
      // Second write: log is an array now, nothing more is set aside or printed.
      err = captureStderr(() => updateState(home, (s) => { s.decisionLog.push({ n: 2 }); }));
      assert.equal(err, '');
      assert.equal(sideFiles(home).length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('updateState with an aborting mutator still replaces the bad log once', () => {
  const home = homeWith('x');
  try {
    captureStderr(() => updateState(home, () => false));
    assert.equal(sideFiles(home).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).decisionLog, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a missing decisionLog stays as today: no side file, no warning', () => {
  const home = homeWith(undefined);
  try {
    const err = captureStderr(() => updateState(home, () => {}));
    assert.equal(err, '');
    assert.equal(sideFiles(home).length, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('loadState on a non-array decisionLog returns [] and writes nothing', () => {
  const home = homeWith({ a: 1 });
  try {
    const before = readFileSync(join(home, 'state.json'), 'utf8');
    const err = captureStderr(() => {
      assert.deepEqual(loadState(home).decisionLog, []);
    });
    assert.equal(err, '');
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before);
    assert.equal(readdirSync(home).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
