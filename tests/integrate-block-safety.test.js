import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAwarenessBlock, awarenessBlock, removeAwarenessBlock } from '../src/integrate.js';

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
