// Every hooks module of the Claude mod must parse: the host refuses a module
// that does not, and the mod stays on its previous version (0.37.0 shipped a
// quote inside a single-quoted string in hooks/pools.ts). Types are stripped
// the way Node does, then the result is syntax-checked with `node --check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = join(dirname(fileURLToPath(import.meta.url)), '..', 'mods', 'bullswarm', 'hooks');

test('every mod hooks module parses once its types are stripped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-mod-parse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = readdirSync(hooks).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const out = join(dir, name.replace(/\.ts$/, '.mjs'));
    writeFileSync(out, stripTypeScriptTypes(readFileSync(join(hooks, name), 'utf8')));
    const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${name} does not parse:\n${check.stderr}`);
  }
});

test('the parse check catches a quote inside a single-quoted string', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-mod-parse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'bad.mjs');
  let stripped;
  try { stripped = stripTypeScriptTypes("const note: string = 'runs in bullswarm's analyze lane'\n"); }
  catch { return; } // the type stripper refused it already
  writeFileSync(out, stripped);
  assert.notEqual(spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' }).status, 0);
});
