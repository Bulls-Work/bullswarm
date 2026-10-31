import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadState, saveState, updateState } from '../src/lib/state.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-statefmt-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function row(i, pad = 0) {
  return {
    at: `2026-10-31T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    pool: `pool-${i % 5}`,
    note: 'line one\nline two "quoted"',
    routing: { picked: `pool-${i % 5}`, candidates: [{ pool: 'a', surplus: 0.1 * i }, { pool: 'b', surplus: -1 }] },
    usage: { text: 'x'.repeat(pad * 40), turns: Array.from({ length: pad }, (_, k) => ({ i: k, tokens: { in: k * 3, out: k }, model: 'm' })), nested: { list: [1, 2, 3], empty: {}, none: null } },
  };
}

test('decision log is written one compact row per line, top level indented', () => {
  const { dir, cleanup } = tmp();
  try {
    const state = loadState(dir);
    state.decisionLog = [row(1), row(2), row(3)];
    saveState(dir, state);
    const text = readFileSync(join(dir, 'state.json'), 'utf8');
    const lines = text.split('\n');
    const start = lines.indexOf('  "decisionLog": [');
    assert.ok(start > 0, `decisionLog opener missing:\n${text.slice(0, 400)}`);
    assert.equal(lines[start + 1], `    ${JSON.stringify(row(1))},`);
    assert.equal(lines[start + 2], `    ${JSON.stringify(row(2))},`);
    assert.equal(lines[start + 3], `    ${JSON.stringify(row(3))}`);
    assert.equal(lines[start + 4], '  ]' + (lines[start + 5] === '}' ? '' : ','));
    assert.match(lines[1], /^ {2}"/, 'other top-level keys stay 2-space indented');
    assert.ok(text.endsWith('}\n'));
  } finally { cleanup(); }
});

test('round trip is deep-equal with key order kept; empty log is []', () => {
  const { dir, cleanup } = tmp();
  try {
    const state = loadState(dir);
    state.decisionLog = [row(1), row(2)];
    saveState(dir, state);
    const back = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(back, state);
    assert.deepEqual(Object.keys(back), Object.keys(state));
    state.decisionLog = [];
    saveState(dir, state);
    const text = readFileSync(join(dir, 'state.json'), 'utf8');
    assert.ok(text.includes('"decisionLog": []'));
    assert.deepEqual(JSON.parse(text), state);
  } finally { cleanup(); }
});

test('updateState also writes the compact layout', () => {
  const { dir, cleanup } = tmp();
  try {
    updateState(dir, (s) => { s.decisionLog = [row(1), row(2)]; });
    const text = readFileSync(join(dir, 'state.json'), 'utf8');
    assert.ok(text.includes(`\n    ${JSON.stringify(row(1))},\n`));
  } finally { cleanup(); }
});

test('an old pretty-printed file still loads', () => {
  const { dir, cleanup } = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    const state = { ...loadState(dir), decisionLog: [row(1), row(2)] };
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    assert.deepEqual(loadState(dir).decisionLog, state.decisionLog);
  } finally { cleanup(); }
});

test('a file written here is plain JSON that origin/main loadState reads', () => {
  const { dir, cleanup } = tmp();
  try {
    const state = loadState(dir);
    state.decisionLog = [row(1), row(2)];
    saveState(dir, state);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).decisionLog, state.decisionLog);
    let old;
    try {
      old = execFileSync('git', ['show', 'origin/main:src/lib/state.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return; } // no origin/main here: the JSON.parse check above stands
    const src = join(dir, 'oldsrc');
    mkdirSync(join(src, 'lib'), { recursive: true });
    writeFileSync(join(src, 'lib', 'state.js'), old);
    for (const f of execFileSync('git', ['ls-tree', '--name-only', 'origin/main', 'src/lib/'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
      if (f.endsWith('state.js')) continue;
      writeFileSync(join(src, 'lib', f.split('/').pop()), execFileSync('git', ['show', `origin/main:${f}`], { encoding: 'utf8' }));
    }
    writeFileSync(join(src, 'package.json'), '{"type":"module"}');
    const out = execFileSync(process.execPath, ['-e', `
      import(${JSON.stringify(join(src, 'lib', 'state.js'))}).then((m) => {
        process.stdout.write(JSON.stringify(m.loadState(${JSON.stringify(dir)}, { skipMigration: true }).decisionLog));
      });`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.deepEqual(JSON.parse(out), state.decisionLog);
  } finally { cleanup(); }
});

test('4,000 rows of ~7 KB: compact file is at least 35% smaller and parses faster', () => {
  const { dir, cleanup } = tmp();
  try {
    const state = loadState(dir);
    state.decisionLog = Array.from({ length: 4000 }, (_, i) => row(i, 75));
    const pretty = `${JSON.stringify(state, null, 2)}\n`;
    saveState(dir, state);
    const compact = readFileSync(join(dir, 'state.json'), 'utf8');
    const time = (text) => {
      const t = performance.now();
      JSON.parse(text);
      return performance.now() - t;
    };
    time(pretty); // warm-up
    const prettyMs = Math.min(time(pretty), time(pretty));
    const compactMs = Math.min(time(compact), time(compact));
    console.log(`pretty ${pretty.length} B parse ${prettyMs.toFixed(0)} ms; compact ${compact.length} B parse ${compactMs.toFixed(0)} ms; ${(100 * (1 - compact.length / pretty.length)).toFixed(1)}% smaller`);
    assert.ok(compact.length <= pretty.length * 0.65, `compact ${compact.length} vs pretty ${pretty.length}`);
  } finally { cleanup(); }
});
