// An unreadable state.json is kept, never silently overwritten.
//
// The bug this guards: loadState answers DEFAULT_STATE when state.json exists
// but does not parse, and updateState then saved the mutated default over it,
// erasing every pool record, decision-log row, spend record and setting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, updateState } from '../src/lib/state.js';

const GOOD = {
  version: 1,
  pools: { a: { enabled: true } },
  decisionLog: [{ id: 1 }, { id: 2 }],
};

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-state-unreadable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function kept(dir) {
  return readdirSync(dir).filter((name) => name.startsWith('state.json.unreadable-'));
}

function captureStderr(fn) {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = (chunk) => { text += String(chunk); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return text;
}

const append = (state) => { state.decisionLog.push({ id: 'new' }); };

test('a truncated state.json is kept in one unreadable file and a fresh state is written', (t) => {
  const dir = home(t);
  const bad = `${JSON.stringify(GOOD, null, 2)}`.slice(0, 40);
  writeFileSync(join(dir, 'state.json'), bad);

  const stderr = captureStderr(() => updateState(dir, append));

  const files = kept(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^state\.json\.unreadable-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  assert.ok(!files[0].includes(':'));
  assert.equal(readFileSync(join(dir, files[0]), 'utf8'), bad);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).decisionLog, [{ id: 'new' }]);
  assert.match(stderr, /^bullswarm: state\.json could not be read \(.+\); kept it as state\.json\.unreadable-\S+ and started a fresh state\n$/);
  assert.ok(stderr.includes(files[0]));
});

for (const [label, body] of [['an array', '[1,2]'], ['null', 'null'], ['a number', '42']]) {
  test(`state.json holding ${label} is treated as unreadable`, (t) => {
    const dir = home(t);
    writeFileSync(join(dir, 'state.json'), body);

    const stderr = captureStderr(() => updateState(dir, append));

    const files = kept(dir);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(dir, files[0]), 'utf8'), body);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).decisionLog, [{ id: 'new' }]);
    assert.match(stderr, /state\.json could not be read/);
  });
}

test('loadState alone leaves an unreadable state.json untouched', (t) => {
  const dir = home(t);
  writeFileSync(join(dir, 'state.json'), '{"pools":');

  const stderr = captureStderr(() => {
    assert.deepEqual(loadState(dir).decisionLog, []);
  });

  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{"pools":');
  assert.deepEqual(kept(dir), []);
  assert.equal(stderr, '');
});

test('a valid state.json creates no unreadable file and no message', (t) => {
  const dir = home(t);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD));

  const stderr = captureStderr(() => updateState(dir, append));

  assert.deepEqual(kept(dir), []);
  assert.equal(stderr, '');
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.pools, GOOD.pools);
  assert.equal(saved.decisionLog.length, 3);
});

test('when the rename fails updateState throws naming the path and writes nothing', (t) => {
  const dir = home(t);
  writeFileSync(join(dir, 'state.json'), '{"pools":');
  // A directory squatting on every name the move may pick makes it fail.
  const real = Date;
  const frozen = new real('2026-01-02T03:04:05.000Z');
  globalThis.Date = class extends real {
    constructor(...args) { return args.length ? new real(...args) : frozen; }
    static now() { return frozen.getTime(); }
  };
  t.after(() => { globalThis.Date = real; });
  // Every name the move may pick (the stamp, then -2 to -100) is taken.
  const base = join(dir, 'state.json.unreadable-2026-01-02T03-04-05.000Z');
  for (let n = 1; n <= 100; n += 1) mkdirSyncCompat(n > 1 ? `${base}-${n}` : base);

  assert.throws(
    () => captureStderr(() => updateState(dir, append)),
    (err) => err instanceof Error && err.message.includes(join(dir, 'state.json')),
  );
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{"pools":');
});

import { mkdirSync } from 'node:fs';
function mkdirSyncCompat(p) { mkdirSync(p, { recursive: true }); }

test('a state.json that cannot be opened (no read permission) is refused, not moved aside or overwritten', { skip: process.getuid?.() === 0 && 'root reads any file' }, (t) => {
  const dir = home(t);
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(GOOD));
  chmodSync(path, 0o000);
  t.after(() => { try { chmodSync(path, 0o600); } catch { /* already removed */ } });
  assert.throws(() => updateState(dir, append), /state\.json .*EACCES/);
  assert.deepEqual(kept(dir), []);
  chmodSync(path, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), GOOD);
});

test('two unreadable files moved aside in the same millisecond are both kept', (t) => {
  const dir = home(t);
  const RealDate = Date;
  const fixed = RealDate.parse('2026-01-01T00:00:00.000Z');
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  t.after(() => { globalThis.Date = RealDate; });
  writeFileSync(join(dir, 'state.json'), 'AAA');
  captureStderr(() => updateState(dir, append));
  writeFileSync(join(dir, 'state.json'), 'BBB');
  const stderr = captureStderr(() => updateState(dir, append));
  globalThis.Date = RealDate;
  const contents = kept(dir).map((name) => readFileSync(join(dir, name), 'utf8')).sort();
  assert.deepEqual(contents, ['AAA', 'BBB']);
  assert.equal(kept(dir).filter((name) => stderr.includes(`kept it as ${name} and`)).length, 1);
});
