import { execFileSync } from 'node:child_process';

// Observation only. A failed/non-git/large checkout never prevents a worker
// from running or invalidates its output. No hashing, copying or rollback.
export function captureWorkspaceStatus(cwd) {
  try {
    const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 };
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], options).replace(/\n$/, '');
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.'], options);
    const changedFiles = output.split('\0').filter(Boolean).map((entry) => entry.slice(3))
      .filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    return { changedFiles: [...new Set(changedFiles)].sort(), warnings: [] };
  } catch {
    return { changedFiles: [], warnings: ['Workspace change inventory is unavailable; files and action outputs remain in place.'] };
  }
}

export function buildWorkspaceReport(cwd, baseline, actions, capture = captureWorkspaceStatus) {
  let current;
  try { current = capture(cwd); }
  catch { current = { changedFiles: [], warnings: ['Workspace change inventory is unavailable; files and action outputs remain in place.'] }; }
  const warnings = [...(baseline?.warnings ?? []), ...current.warnings];
  const unrestricted = actions.some((action) => ['build', 'chore'].includes(action.lane) && !action.ownedFiles.length);
  if (!unrestricted) {
    const declared = new Set(actions.flatMap((action) => action.ownedFiles));
    const outside = current.changedFiles.filter((file) => !declared.has(file));
    if (outside.length) warnings.push(`Workspace changes outside declared territories: ${outside.join(', ')}. This inventory is advisory and may include pre-existing or concurrent edits; it is not per-action attribution.`);
  }
  return {
    cwd, changedFiles: current.changedFiles, baselineChangedFiles: baseline?.changedFiles ?? [],
    warnings: [...new Set(warnings)],
  };
}
