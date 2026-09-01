import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnershipValidationError, captureWorkspaceManifest, changedManifestPaths, checkOwnership, compareManifests, normalizeOwnedFiles } from '../src/workflow/ownership.js';

test('compares manifests and lists created, modified, and deleted exact paths', () => {
  const result = compareManifests({ 'a.js': '1', 'deleted.js': 'x', 'same.js': 'z' }, { 'a.js': '2', 'created.js': '3', 'same.js': 'z' });
  assert.deepEqual(result.created, ['created.js']);
  assert.deepEqual(result.modified, ['a.js']);
  assert.deepEqual(result.deleted, ['deleted.js']);
  assert.deepEqual(result.changed, ['a.js', 'created.js', 'deleted.js']);
});

test('accepts declared changes and rejects every undeclared mutation', () => {
  const before = { 'src/a.js': '1', 'src/old.js': '1' };
  const after = { 'src/a.js': '2', 'src/new.js': '1' };
  const result = checkOwnership({ before, after, ownedFiles: ['src/a.js'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.outOfScope, ['src/new.js', 'src/old.js']);
  assert.deepEqual(result.modified, ['src/a.js']);
  assert.deepEqual(before, { 'src/a.js': '1', 'src/old.js': '1' });
});

test('uses exact-file ownership and fails closed on ambiguous paths or manifests', () => {
  assert.deepEqual(normalizeOwnedFiles(['src/a.js']), ['src/a.js']);
  assert.throws(() => normalizeOwnedFiles(['src/']), OwnershipValidationError);
  assert.throws(() => normalizeOwnedFiles(['src/*.js']), /glob/);
  assert.throws(() => normalizeOwnedFiles(['src\\a.js']), /relative path/);
  assert.throws(() => normalizeOwnedFiles(['src/../a.js']), /canonical/);
  assert.throws(() => checkOwnership({ before: [], after: {}, ownedFiles: [] }), /before must be a path-to-digest object/);
  assert.throws(() => checkOwnership({ before: {}, after: { 'a.js': '' }, ownedFiles: ['a.js'] }), /digest/);
});

test('returns defensive ownership results', () => {
  const result = checkOwnership({ before: {}, after: { 'a.js': '1' }, ownedFiles: ['a.js'] });
  result.changed.push('fake.js');
  result.ownedFiles.push('fake.js');
  assert.deepEqual(checkOwnership({ before: {}, after: { 'a.js': '1' }, ownedFiles: ['a.js'] }).changed, ['a.js']);
});

test('captures a deterministic bounded non-git workspace manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-ownership-'));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(root, 'nested', 'b.txt'), 'b');
  const before = captureWorkspaceManifest(root);
  writeFileSync(join(root, 'a.txt'), 'changed');
  const after = captureWorkspaceManifest(root);
  assert.deepEqual(Object.keys(before), ['a.txt', 'nested/b.txt']);
  assert.deepEqual(changedManifestPaths(before, after), ['a.txt']);
  assert.throws(() => captureWorkspaceManifest(root, { maxFiles: 1 }), /exceeds 1 files/);
});
