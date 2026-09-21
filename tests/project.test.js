// Project identity (src/lib/project.js).
//
// Doctrine under test:
//   P1. projectOf never throws — no git binary, no repository, no origin, a
//       deleted directory, a non-string argument.
//   P2. Arguments reach git as an array, so a directory whose name contains
//       shell metacharacters resolves normally instead of being executed.
//   P3. The origin remote names the project when there is one, because three
//       worktrees of one repository are one project; the git toplevel names
//       it when there is no remote; the directory itself when there is no
//       repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectNameFromRemote, projectOf, projectName } from '../src/lib/project.js';

function tempDir(prefix = 'bs-project-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitRepo(dir, { origin = null } = {}) {
  const run = (args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  run(['init', '--quiet']);
  if (origin) run(['remote', 'add', 'origin', origin]);
  return dir;
}

test('P3: a repository with an origin is named after the remote, not the directory', () => {
  const root = tempDir();
  try {
    const checkout = join(root, 'a-worktree-directory');
    mkdirSync(checkout);
    gitRepo(checkout, { origin: 'https://github.com/Bulls-Work/bullswarm.git' });
    const identity = projectOf(checkout);
    assert.equal(identity.name, 'bullswarm');
    assert.equal(identity.remote, 'https://github.com/Bulls-Work/bullswarm.git');
    // macOS resolves /var -> /private/var, so compare the leaf, not the path.
    assert.equal(basename(identity.toplevel), 'a-worktree-directory');
    assert.equal(projectName(checkout), 'bullswarm');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P3: remote:false skips the origin lookup and names the project after the git toplevel', () => {
  const root = tempDir();
  try {
    const checkout = join(root, 'bullswarm-dashboard');
    mkdirSync(checkout);
    gitRepo(checkout, { origin: 'git@github.com:Bulls-Work/bullswarm.git' });
    const identity = projectOf(checkout, { remote: false });
    assert.equal(identity.name, 'bullswarm-dashboard');
    assert.equal(identity.remote, null, 'remote:false must not run the remote lookup');
    assert.equal(basename(identity.toplevel), 'bullswarm-dashboard');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P3: a repository with no origin falls back to the git toplevel, a subdirectory included', () => {
  const root = tempDir();
  try {
    const checkout = join(root, 'no-remote-repo');
    mkdirSync(checkout);
    gitRepo(checkout);
    const nested = join(checkout, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    assert.equal(projectOf(checkout).name, 'no-remote-repo');
    assert.equal(projectOf(nested).name, 'no-remote-repo', 'a subdirectory belongs to the same project');
    assert.equal(projectOf(checkout).remote, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P1/P3: a plain directory that is not a repository falls back to its own basename', () => {
  const root = tempDir();
  try {
    const plain = join(root, 'just-a-folder');
    mkdirSync(plain);
    writeFileSync(join(plain, 'file.txt'), 'x');
    const identity = projectOf(plain);
    assert.equal(identity.name, 'just-a-folder');
    assert.equal(identity.remote, null);
    assert.equal(identity.toplevel, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P1: a deleted directory, an empty string and a non-string never throw', () => {
  const root = tempDir();
  const gone = join(root, 'gone');
  mkdirSync(gone);
  rmSync(gone, { recursive: true, force: true });
  assert.doesNotThrow(() => projectOf(gone));
  assert.equal(projectOf(gone).name, 'gone', 'the name of a deleted directory is still its basename');
  assert.deepEqual(projectOf(''), { name: null, remote: null, toplevel: null });
  assert.deepEqual(projectOf(null), { name: null, remote: null, toplevel: null });
  assert.deepEqual(projectOf(undefined), { name: null, remote: null, toplevel: null });
  assert.deepEqual(projectOf(42), { name: null, remote: null, toplevel: null });
  assert.equal(projectName(null), null);
  rmSync(root, { recursive: true, force: true });
});

test('P1: no git binary on PATH degrades to the basename instead of throwing', () => {
  const root = tempDir();
  const checkout = join(root, 'repo-without-git-binary');
  mkdirSync(checkout);
  gitRepo(checkout, { origin: 'https://github.com/Bulls-Work/bullswarm.git' });
  const realPath = process.env.PATH;
  try {
    // An empty PATH makes execFileSync('git', ...) fail with ENOENT, which is
    // exactly what a machine with no git installed does.
    process.env.PATH = join(root, 'no-such-bin');
    const identity = projectOf(checkout);
    assert.equal(identity.name, 'repo-without-git-binary');
    assert.equal(identity.remote, null);
    assert.equal(identity.toplevel, null);
  } finally {
    process.env.PATH = realPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2: a directory name full of shell metacharacters is a directory, not a command', () => {
  const root = tempDir();
  const hostile = join(root, 'a; touch pwned $(whoami) `id` && echo');
  try {
    mkdirSync(hostile);
    const identity = projectOf(hostile);
    assert.equal(identity.name, basename(hostile));
    // If the argument had gone through a shell, the `touch` would have run
    // and left a file literally named `pwned` beside the directory.
    assert.equal(
      existsSync(join(root, 'pwned')) || existsSync(join(hostile, 'pwned')) || existsSync(join(process.cwd(), 'pwned')),
      false,
      'projectOf must never interpolate a path into a shell string',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P3: remote URLs of every shape reduce to the repository name', () => {
  const cases = [
    ['git@github.com:Bulls-Work/bullswarm.git', 'bullswarm'],
    ['https://github.com/Bulls-Work/bullswarm.git', 'bullswarm'],
    ['https://github.com/Bulls-Work/bullswarm', 'bullswarm'],
    ['https://github.com/Bulls-Work/bullswarm/', 'bullswarm'],
    ['ssh://git@example.com:2222/team/project-alpha-long-names.git', 'project-alpha-long-names'],
    ['/srv/git/bulldemo', 'bulldemo'],
    ['file:///srv/git/bulldemo.git', 'bulldemo'],
    ['', null],
    [null, null],
    [undefined, null],
  ];
  for (const [url, expected] of cases) {
    assert.equal(projectNameFromRemote(url), expected, `remote ${JSON.stringify(url)}`);
  }
});
