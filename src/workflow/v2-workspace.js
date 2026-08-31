import { execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { captureWorkspaceManifest, checkOwnership, compareManifests, normalizeOwnedFiles } from './ownership.js';

const normalized = (value) => value.split(sep).join('/');

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: options.encoding === 'buffer' ? null : (options.encoding ?? 'utf8'),
    stdio: options.stdio ?? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input: options.input, maxBuffer: 128 * 1024 * 1024,
  });
}

function gitRoot(sourceDir) {
  try { return git(sourceDir, ['rev-parse', '--show-toplevel']).trim(); }
  catch { return null; }
}

function copyPath(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const stat = lstatSync(source);
  rmSync(destination, { recursive: true, force: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else if (stat.isFile()) copyFileSync(source, destination);
  else throw new TypeError(`isolated workspace path is not a file: ${source}`);
}

function overlayWorkingTree(sourceRoot, isolatedRoot) {
  const patch = git(sourceRoot, ['diff', '--binary', 'HEAD'], { encoding: 'buffer' });
  if (patch.length) git(isolatedRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
  const untracked = git(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const file of untracked.split('\0').filter(Boolean)) copyPath(join(sourceRoot, file), join(isolatedRoot, file));
  const sourceModules = join(sourceRoot, 'node_modules');
  const isolatedModules = join(isolatedRoot, 'node_modules');
  if (existsSync(sourceModules) && !existsSync(isolatedModules)) symlinkSync(sourceModules, isolatedModules, 'dir');
}

/** Create an exact disposable workspace for one mutating V2 action. */
export function createIsolatedWorkspace({ sourceDir, runDir, actionId, maxFiles = 50_000 } = {}) {
  if (typeof sourceDir !== 'string' || !sourceDir) throw new TypeError('sourceDir is required');
  if (typeof runDir !== 'string' || !runDir) throw new TypeError('runDir is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(actionId ?? '')) throw new TypeError('actionId must be a kebab-case ID');
  const source = realpathSync(resolve(sourceDir));
  const root = gitRoot(source);
  const workspaceRoot = join(runDir, 'workspaces', actionId);
  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(dirname(workspaceRoot), { recursive: true });
  let kind = 'copy';
  let targetDir = workspaceRoot;
  if (root) {
    git(root, ['worktree', 'add', '--detach', workspaceRoot, 'HEAD']);
    overlayWorkingTree(root, workspaceRoot);
    targetDir = join(workspaceRoot, relative(realpathSync(root), source));
    kind = 'git-worktree';
  } else {
    cpSync(source, workspaceRoot, {
      recursive: true,
      filter: (path) => {
        const name = relative(source, path).split(sep)[0];
        return name !== '.git' && name !== 'node_modules';
      },
    });
    if (existsSync(join(source, 'node_modules'))) symlinkSync(join(source, 'node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  }
  return {
    kind, sourceDir: source, sourceRoot: root, workspaceRoot, targetDir,
    mainBefore: captureWorkspaceManifest(source, { maxFiles }),
    isolatedBefore: captureWorkspaceManifest(targetDir, { maxFiles }),
  };
}

/** Ownership-check and atomically attribute only declared files back to main. */
export function integrateIsolatedWorkspace(workspace, { ownedFiles, maxFiles = 50_000 } = {}) {
  if (!workspace?.targetDir || !workspace?.sourceDir) throw new TypeError('workspace is required');
  const declared = normalizeOwnedFiles(ownedFiles);
  const isolatedAfter = captureWorkspaceManifest(workspace.targetDir, { maxFiles });
  const ownership = checkOwnership({ before: workspace.isolatedBefore, after: isolatedAfter, ownedFiles: declared });
  if (!ownership.ok) return { ok: false, kind: 'ownership', ownership };
  const mainNow = captureWorkspaceManifest(workspace.sourceDir, { maxFiles });
  const concurrent = compareManifests(workspace.mainBefore, mainNow).changed.filter((file) => declared.includes(file));
  if (concurrent.length) return { ok: false, kind: 'conflict', concurrent, ownership };
  for (const file of ownership.changed) {
    const source = join(workspace.targetDir, file);
    const destination = join(workspace.sourceDir, file);
    if (ownership.deleted.includes(file)) rmSync(destination, { force: true });
    else copyPath(source, destination);
  }
  return { ok: true, integrated: ownership.changed, ownership };
}

export function disposeIsolatedWorkspace(workspace) {
  if (!workspace?.workspaceRoot) return;
  if (workspace.kind === 'git-worktree' && workspace.sourceRoot) {
    try { git(workspace.sourceRoot, ['worktree', 'remove', '--force', workspace.workspaceRoot]); return; }
    catch { /* explicit bounded cleanup below */ }
  }
  rmSync(workspace.workspaceRoot, { recursive: true, force: true });
}
