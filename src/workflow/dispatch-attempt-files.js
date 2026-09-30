// Where an attempt's files live: its task, out, stream, stdout, diff and
// evidence-log paths beside the task file, and those read back from disk.
import { basename, dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

/**
 * The run id an artifact path belongs to. The kernel owns the id and should
 * pass it explicitly; deriving it from the run directory keeps the ledger
 * honest for callers that have not been updated yet, without inventing one.
 */
export function runIdFromPaths(files) {
  const match = /(?:^|[\\/])(wf-[a-z0-9]+-[a-f0-9]{6})(?:[\\/]|$)/.exec(files?.taskFile ?? '');
  return match ? match[1] : null;
}

export function attemptPaths(base, ordinal) {
  if (typeof base === 'function') return base(ordinal);
  if (!base?.taskFile || !base?.outFile) throw new TypeError('paths must provide taskFile and outFile');
  if (ordinal === 1) return base;
  const suffix = `-attempt-${ordinal}`;
  const insert = (path) => path.replace(/(\.[^./]+)?$/, `${suffix}$1`);
  return {
    taskFile: insert(base.taskFile),
    outFile: insert(base.outFile),
    ...(base.streamFile ? { streamFile: insert(base.streamFile) } : {}),
    ...(base.stdoutFile ? { stdoutFile: insert(base.stdoutFile) } : {}),
    ...(base.diffFile ? { diffFile: insert(base.diffFile) } : {}),
  };
}

function artifactBesideTask(taskFile, kind, ext) {
  const name = basename(taskFile);
  const trimmed = name.startsWith('task-') ? name.slice(5).replace(/\.[^.]+$/, '') : 'attempt';
  return join(dirname(taskFile), `${kind}-${trimmed}${ext}`);
}

// `evidence-<step>-attempt-<n>-<k>.log` beside the task. `<n>` comes from the
// task file, which carries the run-wide attempt number (a resumed step's
// first attempt in this dispatch is not attempt 1 of the step).
export function evidenceLogFile(taskFile, actionId, ordinal, index) {
  const name = basename(taskFile);
  const stem = name.startsWith('task-') ? name.slice(5).replace(/\.[^.]+$/, '') : `${actionId}-attempt-${ordinal}`;
  return join(dirname(taskFile), `evidence-${stem}-${index}.log`);
}

export function withAttemptArtifacts(files) {
  return {
    ...files,
    streamFile: files.streamFile ?? artifactBesideTask(files.taskFile, 'stream', '.jsonl'),
    stdoutFile: files.stdoutFile ?? artifactBesideTask(files.taskFile, 'stdout', '.log'),
    diffFile: files.diffFile ?? artifactBesideTask(files.taskFile, 'diff', '.txt'),
  };
}

/**
 * The artifacts an attempt left beside its task file, read back from disk by
 * the same naming `withAttemptArtifacts` writes with. Used when the kernel
 * itself died mid-attempt and the record never reached `attempt.finished`, so
 * a resume can still say where the partial output and the stream are.
 */
export function attemptArtifactsOnDisk(taskFile, actionId, ordinal) {
  if (!taskFile) return {};
  const files = withAttemptArtifacts({ taskFile });
  const outputFile = artifactBesideTask(taskFile, 'out', '.md');
  const streamFile = existsSync(files.streamFile) ? files.streamFile
    : existsSync(files.stdoutFile) ? files.stdoutFile
      : null;
  const outputBytes = existsSync(outputFile) ? fileBytes(outputFile) : null;
  return {
    ...(existsSync(outputFile) ? { outputFile } : {}),
    ...(outputBytes != null ? { outputBytes } : {}),
    ...(streamFile ? { streamFile } : {}),
    ...(existsSync(files.diffFile) ? { diffFile: files.diffFile } : {}),
  };
}

export function fileBytes(path) {
  try { return statSync(path).size; } catch { return null; }
}
