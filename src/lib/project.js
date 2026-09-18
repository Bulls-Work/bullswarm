// Project identity for a working directory.
//
// The dashboard groups runs by project (Stats › Projects, History rows). A
// run only records its `cwd`, and a cwd is not a project: three git worktrees
// of the same repository are three directories and one project. So the name
// comes from the origin remote when there is one, and from the git toplevel
// (then the directory itself) when there is not.
//
// Doctrine:
//   P1. Never throws. A missing git binary, a directory that is not a
//       repository, a repository with no origin, a deleted cwd — each one
//       resolves to the best name available, never to an exception. This runs
//       on the finish path of a workflow and inside `workflow reindex`; a
//       failure here must never cost a run its result.
//   P2. Arguments are passed as an array, never interpolated into a shell
//       string: a directory named `; rm -rf ~` is a legal directory.
//   P3. No caching in here. Callers that resolve hundreds of directories
//       (reindex) keep their own map; a memo inside this module would answer
//       from before a `git init` or a remote change.

import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

const GIT_TIMEOUT_MS = 5000;

function git(cwd, args) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const trimmed = String(out).trim();
    return trimmed || null;
  } catch {
    // No git, not a repository, no such remote, deleted cwd: all the same
    // answer — this fact is unavailable (P1).
    return null;
  }
}

// `git@github.com:Bulls-Work/bullswarm.git` and
// `https://github.com/Bulls-Work/bullswarm.git` both name the project
// `bullswarm`; so does a bare local path remote `/srv/git/bullswarm`.
export function projectNameFromRemote(remote) {
  const url = String(remote ?? '').trim();
  if (!url) return null;
  const withoutQuery = url.split(/[?#]/)[0];
  const path = withoutQuery.replace(/\/+$/, '');
  const last = path.split(/[/:]/).filter(Boolean).at(-1) ?? '';
  const name = last.replace(/\.git$/i, '').trim();
  return name || null;
}

/**
 * Identify the project a directory belongs to.
 *
 * @param {string} cwd            absolute or relative directory
 * @param {{remote?: boolean}} [options]  `remote: false` skips the origin
 *        lookup entirely (one fewer git process), naming the project after
 *        its git toplevel instead.
 * @returns {{name: string|null, remote: string|null, toplevel: string|null}}
 *          `name` is null only when `cwd` is not a usable string.
 */
export function projectOf(cwd, { remote = true } = {}) {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw) return { name: null, remote: null, toplevel: null };
  const dir = resolve(raw);
  const toplevel = git(dir, ['rev-parse', '--show-toplevel']);
  const origin = remote ? git(dir, ['remote', 'get-url', 'origin']) : null;
  const name = projectNameFromRemote(origin)
    ?? (toplevel ? basename(toplevel) : null)
    ?? (basename(dir) || null);
  return { name, remote: origin, toplevel };
}

export function projectName(cwd) {
  return projectOf(cwd).name;
}
