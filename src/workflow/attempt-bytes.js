// The byte ledger on each attempt the kernel dispatches (attemptBytes below
// names every field).

import { statSync } from 'node:fs';
import { dependencyInputBytes } from './step-prompts.js';

// The requirement texts a task file embeds verbatim: `affects` for work,
// `evidenceFor` for evidence, none for a kernel-owned digest.
export function embeddedRequirementBytes(state, action, { evidence = false, digest = false } = {}) {
  if (digest) return 0;
  const ids = evidence ? action.evidenceFor ?? [] : action.affects ?? [];
  return state.intent.requirements
    .filter((item) => ids.includes(item.id))
    .reduce((total, item) => total + Buffer.byteLength(String(item.text ?? ''), 'utf8'), 0);
}

/**
 * The byte ledger recorded on every attempt this kernel dispatches, at
 * `state.attempts[].bytes`:
 *   taskFile         bytes of the task file the attempt was handed
 *   authorPrompt     bytes of the program author's own prompt, as authored
 *   kernel           taskFile minus authorPrompt minus embedded requirement text
 *   dependencyInputs total bytes of the dependency output files it points at
 *   output           bytes of the durable out file, filled in on completion
 * `output` is null until the attempt finishes, and stays null when no out file
 * was written. The three parts are measured independently, so `kernel` is
 * floored at 0 rather than reporting a negative remainder.
 */
export function attemptBytes(state, action, taskText, { evidence = false, digest = false } = {}) {
  const taskFile = Buffer.byteLength(taskText, 'utf8');
  const authorPrompt = Buffer.byteLength(String(action.prompt ?? ''), 'utf8');
  const requirements = embeddedRequirementBytes(state, action, { evidence, digest });
  return {
    taskFile,
    authorPrompt,
    kernel: Math.max(0, taskFile - authorPrompt - requirements),
    dependencyInputs: dependencyInputBytes(state, action),
    output: null,
  };
}

// Re-measure what the attempt actually cost once it is over: the task file as
// written (a bounded schema correction rewrites it larger) and the durable out
// file. Anything unreadable is left as recorded, never guessed.
export function observeAttemptBytes(attempt, { authorPrompt, requirements }) {
  if (!attempt?.bytes) return;
  if (attempt.taskFile) {
    try {
      attempt.bytes.taskFile = statSync(attempt.taskFile).size;
      attempt.bytes.kernel = Math.max(0, attempt.bytes.taskFile - authorPrompt - requirements);
    } catch { /* the task file is gone; keep the dispatched size */ }
  }
  if (attempt.outputFile) {
    try { attempt.bytes.output = statSync(attempt.outputFile).size; }
    catch { /* no durable out file: output stays null */ }
  }
}
