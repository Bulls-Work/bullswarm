import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedWorkspace, disposeIsolatedWorkspace, integrateIsolatedWorkspace } from '../src/workflow/v2-workspace.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-workspace-'));
  const repo = join(root, 'repo'); const runDir = join(root, 'run');
  mkdirSync(repo); mkdirSync(runDir);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'owned.txt'), 'base\n'); writeFileSync(join(repo, 'other.txt'), 'other\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  return { root, repo, runDir };
}

test('isolated workspace overlays dirty state and integrates only owned files', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'other.txt'), 'dirty current state\n');
  const workspace = createIsolatedWorkspace({ sourceDir: f.repo, runDir: f.runDir, actionId: 'write-owned' });
  assert.equal(readFileSync(join(workspace.targetDir, 'other.txt'), 'utf8'), 'dirty current state\n');
  writeFileSync(join(workspace.targetDir, 'owned.txt'), 'worker result\n');
  const result = integrateIsolatedWorkspace(workspace, { ownedFiles: ['owned.txt'] });
  assert.deepEqual(result.integrated, ['owned.txt']);
  assert.equal(readFileSync(join(f.repo, 'owned.txt'), 'utf8'), 'worker result\n');
  disposeIsolatedWorkspace(workspace);
  assert.equal(existsSync(workspace.workspaceRoot), false);
});

test('isolated workspace rejects out-of-scope changes and main-workspace conflicts', () => {
  const f = fixture();
  const unsafe = createIsolatedWorkspace({ sourceDir: f.repo, runDir: f.runDir, actionId: 'unsafe-worker' });
  writeFileSync(join(unsafe.targetDir, 'other.txt'), 'unsafe\n');
  assert.equal(integrateIsolatedWorkspace(unsafe, { ownedFiles: ['owned.txt'] }).kind, 'ownership');
  disposeIsolatedWorkspace(unsafe);

  const conflict = createIsolatedWorkspace({ sourceDir: f.repo, runDir: f.runDir, actionId: 'conflicting-worker' });
  writeFileSync(join(conflict.targetDir, 'owned.txt'), 'worker\n');
  writeFileSync(join(f.repo, 'owned.txt'), 'human\n');
  const result = integrateIsolatedWorkspace(conflict, { ownedFiles: ['owned.txt'] });
  assert.equal(result.kind, 'conflict');
  assert.deepEqual(result.concurrent, ['owned.txt']);
  assert.equal(readFileSync(join(f.repo, 'owned.txt'), 'utf8'), 'human\n');
  disposeIsolatedWorkspace(conflict);
});
