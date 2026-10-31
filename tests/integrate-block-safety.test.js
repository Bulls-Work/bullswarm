import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAwarenessBlock, awarenessBlock, cmdIntegrate, integrationStatus, removeAwarenessBlock } from '../src/integrate.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-block-safety-'));
  return { dir, file: join(dir, 'CLAUDE.md'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const apply = (file) => applyAwarenessBlock(file, { approved: true });
const remove = (file) => removeAwarenessBlock(file, { approved: true });
const count = (text, needle) => text.split(needle).length - 1;

test('B1: a begin marker with no end is never repaired by deleting text', () => {
  const { file, cleanup } = sandbox();
  try {
    const original = '# Mine\n<!-- bullswarm:begin v3 -->\nMY IMPORTANT NOTES\n';
    writeFileSync(file, original);
    for (let i = 0; i < 2; i += 1) {
      const result = apply(file);
      assert.equal(result.changed, false);
      assert.equal(result.reason, 'malformed');
      assert.match(result.detail, /line 2/);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
    const removed = remove(file);
    assert.equal(removed.reason, 'malformed');
    assert.equal(removed.changed, false);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { cleanup(); }
});

test('B1: an end marker with no begin is malformed too', () => {
  const { file, cleanup } = sandbox();
  try {
    const original = 'top\n<!-- bullswarm:end -->\nnotes\n';
    writeFileSync(file, original);
    assert.equal(apply(file).reason, 'malformed');
    assert.equal(remove(file).reason, 'malformed');
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { cleanup(); }
});

test('B2: a directory at the path is not written or replaced', () => {
  const { dir, cleanup } = sandbox();
  try {
    const path = join(dir, 'AGENTS.md');
    mkdirSync(path);
    writeFileSync(join(path, 'keep.txt'), 'x');
    const result = apply(path);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'unreadable');
    assert.equal(statSync(path).isDirectory(), true);
    assert.equal(remove(path).changed, false);
    assert.equal(statSync(path).isDirectory(), true);
  } finally { cleanup(); }
});

test('B2: an unreadable file is not overwritten, and a read-only file reports the write error', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores file modes');
  const { file, cleanup } = sandbox();
  try {
    writeFileSync(file, 'PRIVATE\n');
    chmodSync(file, 0o200);
    const result = apply(file);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'unreadable');
    assert.equal(remove(file).reason, 'unreadable');
    chmodSync(file, 0o600);
    assert.equal(readFileSync(file, 'utf8'), 'PRIVATE\n');
    chmodSync(file, 0o400);
    const readOnly = apply(file);
    assert.equal(readOnly.changed, false);
    assert.equal(readOnly.reason, 'unwritable');
    chmodSync(file, 0o600);
    assert.equal(readFileSync(file, 'utf8'), 'PRIVATE\n');
  } finally { cleanup(); }
});

test('B3: two complete blocks become one current block, and remove clears both', () => {
  const { file, cleanup } = sandbox();
  try {
    const old = '<!-- bullswarm:begin v2 -->\nold text\n<!-- bullswarm:end -->';
    writeFileSync(file, `intro\n\n${old}\n\nmiddle\n\n${old}\n\noutro\n`);
    const result = apply(file);
    assert.equal(result.changed, true);
    assert.equal(result.removedExtra, 1);
    const text = readFileSync(file, 'utf8');
    assert.equal(count(text, 'bullswarm:begin'), 1);
    assert.equal(count(text, 'bullswarm:end'), 1);
    assert.ok(text.includes(awarenessBlock()));
    for (const line of ['intro', 'middle', 'outro']) assert.ok(text.includes(`${line}\n`));
    assert.equal(apply(file).reason, 'already current');

    writeFileSync(file, `intro\n\n${old}\n\nmiddle\n\n${old}\n\noutro\n`);
    const removed = remove(file);
    assert.equal(removed.changed, true);
    const after = readFileSync(file, 'utf8');
    assert.equal(count(after, 'bullswarm'), 0);
    assert.equal(after, 'intro\n\nmiddle\n\noutro\n');
  } finally { cleanup(); }
});

test('R1: a block from a newer Bullswarm is left by apply and removed by remove', () => {
  const { file, cleanup } = sandbox();
  try {
    const original = 'a\n\n<!-- bullswarm:begin v99 -->\nfuture\n<!-- bullswarm:end -->\n';
    writeFileSync(file, original);
    const result = apply(file);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'newer');
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(remove(file).changed, true);
    assert.equal(readFileSync(file, 'utf8'), 'a\n');
  } finally { cleanup(); }
});

test('R2: a CRLF file stays CRLF and its user lines are byte-identical', () => {
  const { file, cleanup } = sandbox();
  try {
    const user = 'line one\r\n\r\nline two\r\n';
    writeFileSync(file, user);
    assert.equal(apply(file).reason, 'installed');
    const installed = readFileSync(file, 'utf8');
    assert.ok(installed.startsWith(user));
    assert.equal(/[^\r]\n/.test(installed), false, 'every newline is CRLF');
    assert.equal(apply(file).reason, 'already current');

    const old = '<!-- bullswarm:begin v2 -->\r\nold\r\n<!-- bullswarm:end -->\r\n';
    writeFileSync(file, `${user}\r\n${old}\r\ntail\r\n`);
    assert.equal(apply(file).reason, 'updated');
    const updated = readFileSync(file, 'utf8');
    assert.equal(/[^\r]\n/.test(updated), false);
    assert.ok(updated.startsWith(user));
    assert.ok(updated.endsWith('tail\r\n') || updated.includes('tail\r\n'));

    assert.equal(remove(file).changed, true);
    const removed = readFileSync(file, 'utf8');
    assert.equal(removed, `${user}\r\ntail\r\n`);
  } finally { cleanup(); }
});

// Round two: no byte of the person's text may change. Files are written and
// read as latin1 so every byte, a BOM included, is compared as it is on disk.
const put = (file, text) => writeFileSync(file, Buffer.from(text, 'latin1'));
const get = (file) => readFileSync(file).toString('latin1');
const BOM = 'ï»¿';

test('F1: install then remove returns the exact bytes when the file ends in a line break', () => {
  const { file, cleanup } = sandbox();
  try {
    const cases = {
      'trailing spaces': 'notes  \n',
      'trailing blank lines': 'notes\n\n\n\n',
      'only line breaks': '\n',
      'crlf blanks': 'a\r\n\r\n  \r\n',
      'BOM and text': `${BOM}hello\n`,
      'tab last line': 'x\t\t\n',
    };
    for (const [name, original] of Object.entries(cases)) {
      put(file, original);
      assert.equal(apply(file).changed, true, name);
      assert.ok(get(file).startsWith(original), `${name}: original bytes stay first`);
      assert.equal(apply(file).reason, 'already current', name);
      assert.equal(remove(file).changed, true, name);
      assert.equal(get(file), original, name);
    }
  } finally { cleanup(); }
});

test('F1: a file with no final line break comes back as the original plus one line break', () => {
  const { file, cleanup } = sandbox();
  try {
    const cases = {
      'trailing spaces, no break': 'notes   ',
      BOM: BOM,
      'BOM and text': `${BOM}hello`,
      'bare CR': 'old\rmac\rfile\r',
      'bare CR with text last': 'old\rmac',
    };
    for (const [name, original] of Object.entries(cases)) {
      put(file, original);
      assert.equal(apply(file).changed, true, name);
      assert.ok(get(file).startsWith(original), `${name}: original bytes stay first`);
      assert.equal(remove(file).changed, true, name);
      assert.equal(get(file), `${original}\n`, name);
    }
  } finally { cleanup(); }
});

test('F2: removing the only block keeps the BOM and the user whitespace around it', () => {
  const { file, cleanup } = sandbox();
  try {
    put(file, `${BOM}${awarenessBlock()}\n`);
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), BOM);

    put(file, `top\n\n${awarenessBlock()}\n\n   \n\n`);
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), 'top\n\n   \n\n');

    put(file, `${awarenessBlock()}\n`);
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), '');
  } finally { cleanup(); }
});

test('F3: marker text that shares a line with other text is user text', () => {
  const { file, cleanup } = sandbox();
  try {
    const tail = 'see <!-- bullswarm:begin v3 -->\nold\nthen <!-- bullswarm:end --> tail text\n';
    put(file, tail);
    assert.equal(apply(file).reason, 'installed');
    assert.ok(get(file).startsWith(tail));
    assert.ok(get(file).includes(awarenessBlock()));
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), tail);

    const inline = 'abc <!-- bullswarm:begin v3 -->x<!-- bullswarm:end -->\nxyz\n';
    put(file, inline);
    assert.deepEqual(remove(file), { changed: false, reason: 'not installed' });
    assert.equal(get(file), inline);
    assert.equal(apply(file).reason, 'installed');
    assert.ok(get(file).startsWith(inline));
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), inline);
  } finally { cleanup(); }
});

test('F3: a marker with trailing spaces or tabs and a CRLF is still a marker', () => {
  const { file, cleanup } = sandbox();
  try {
    put(file, 'a\r\n\r\n<!-- bullswarm:begin v2 --> \t\r\nold\r\n<!-- bullswarm:end -->  \r\nz\r\n');
    assert.equal(apply(file).reason, 'updated');
    assert.equal(count(get(file), 'bullswarm:begin'), 1);
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), 'a\r\nz\r\n');
  } finally { cleanup(); }
});

test('F4: markers inside a fenced code block are the person\'s example', () => {
  const { file, cleanup } = sandbox();
  try {
    const example = 'How to mark it:\n\n```md\n<!-- bullswarm:begin v3 -->\nexample\n<!-- bullswarm:end -->\n```\n';
    put(file, example);
    assert.deepEqual(remove(file), { changed: false, reason: 'not installed' });
    assert.equal(get(file), example);
    assert.equal(apply(file).reason, 'installed');
    assert.ok(get(file).startsWith(example));
    assert.ok(get(file).endsWith(`${awarenessBlock()}\n`));
    assert.equal(apply(file).reason, 'already current');
    assert.equal(remove(file).changed, true);
    assert.equal(get(file), example);

    const tilde = '~~~\n<!-- bullswarm:begin v3 -->\n~~~\n';
    put(file, tilde);
    assert.equal(remove(file).reason, 'not installed');
    assert.equal(get(file), tilde);

    const longer = '````\n```\n<!-- bullswarm:end -->\n````\n';
    put(file, longer);
    assert.equal(remove(file).reason, 'not installed');
    assert.equal(get(file), longer);
  } finally { cleanup(); }
});

test('F4: an unclosed fence is not a fence, so install stays idempotent', () => {
  const { file, cleanup } = sandbox();
  try {
    put(file, '```\nunclosed\n');
    assert.equal(apply(file).reason, 'installed');
    assert.equal(apply(file).reason, 'already current');
    assert.equal(count(get(file), 'bullswarm:begin'), 1);
  } finally { cleanup(); }
});

test('R1: status names an unreadable or malformed instruction file, not "missing"', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-status-home-'));
  const saved = process.env.HOME;
  const logs = [];
  const log = console.log;
  try {
    mkdirSync(join(home, '.codex', 'AGENTS.md'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'x\n<!-- bullswarm:begin v3 -->\nnotes\n');
    const status = integrationStatus({ homeDir: home, agents: ['codex', 'claude'] });
    const [codex, claude] = status.agents;
    assert.equal(codex.awareness, false);
    assert.equal(codex.awarenessProblem.reason, 'unreadable');
    assert.equal(claude.awareness, false);
    assert.equal(claude.awarenessProblem.reason, 'malformed');
    assert.match(claude.awarenessProblem.detail, /line 2/);
    assert.equal(status.ok, false);

    process.env.HOME = home;
    console.log = (...args) => logs.push(args.join(' '));
    cmdIntegrate({ rest: ['status'], agents: 'codex,claude' });
    console.log = log;
    const out = logs.join('\n');
    assert.match(out, /codex .*awareness unreadable/);
    assert.match(out, /claude .*awareness malformed/);
    assert.doesNotMatch(out, /awareness missing/);
  } finally {
    console.log = log;
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
