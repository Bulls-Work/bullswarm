// What earlier dispatches of a step left behind (D19), read when a declared
// deliverable is judged: whether one produced work, and whether one of the
// current definition stopped before its snapshot could say.

import { actionDefinition } from './v2-state.js';

// When the step's current definition began: the last applied revision that
// amended or added it, or null for the original plan. Resume, reopen, rerun,
// invalidation and restore keep the definition, so supersededAttempts (which
// all of them raise) cannot mark this boundary.
function definitionStartedAt(state, actionId) {
  for (const revision of [...(state.revisions ?? [])].reverse()) {
    if (revision?.status !== 'applied') continue;
    const { amended = [], added = [] } = revision.changes ?? {};
    if (amended.includes(actionId) || added.includes(actionId)) return Date.parse(revision.processedAt);
  }
  return null;
}

// Earlier dispatches of this step (D19). produced: an earlier attempt
// succeeded, changed a file, or recorded a written path. A not-produced
// failure never counts, and for a path deliverable only a success or a
// written path does. unknown: an attempt of the current definition stopped
// before its snapshot. An isolated dispatch starts from a fresh copy of the
// main tree, so only integrated (succeeded) work is on its disk.
export function earlierWorkFor(state, actionId, { isolated = false } = {}) {
  const hasPaths = (actionDefinition(state, actionId)?.deliverable?.paths?.length ?? 0) > 0;
  const since = definitionStartedAt(state, actionId);
  let produced = false;
  let unknown = false;
  for (const attempt of state.attempts ?? []) {
    if (attempt?.actionId !== actionId || attempt.failureKind === 'not-produced') continue;
    const written = attempt.deliverable?.written;
    const wrote = Array.isArray(written) && written.length > 0;
    const changed = Number.isInteger(attempt.changedFileCount) && attempt.changedFileCount > 0;
    if (attempt.status === 'succeeded' || (!isolated && (wrote || (!hasPaths && changed)))) produced = true;
    const current = !Number.isFinite(since) || !(Date.parse(attempt.startedAt) < since);
    if (!isolated && current && !Number.isInteger(attempt.changedFileCount)) unknown = true;
  }
  return { produced, unknown };
}
