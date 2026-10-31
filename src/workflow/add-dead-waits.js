// `workflow add`: the added steps that can never run on their own because
// they wait, directly or through other added steps, on a step that is
// failed, cancelled or blocked. The add still applies (a person may rerun the
// dependency afterwards); the caller is told which steps stay blocked.

import { blockingRoot } from './cli-step-verbs.js';

const DEAD = new Set(['failed', 'cancelled', 'blocked']);

/**
 * [{step, dependency, status, blockedBy?}] in added order, one entry per dead
 * step an added step waits on: `step` is an added step, `dependency` the
 * failed, cancelled or blocked step it waits on. `state` is
 * the run as the add left it (a cancelled step the reopen ran again is
 * pending, not dead); `added` the added step definitions. A blocked
 * dependency also names `blockedBy`, the failed step at its root: rerun
 * refuses a blocked step, so that is the one to run again.
 */
export function waitsOnFinishedSteps(state, added) {
  const statusOf = new Map((state?.actions ?? []).map((action) => [action.id, action.status]));
  const addedIds = new Set(added.map((action) => action.id));
  const dependsOf = new Map(added.map((action) => [action.id, Array.isArray(action.dependsOn) ? action.dependsOn : []]));
  // Every dead step `id` waits on, each once, in dependsOn order.
  const deadDependencies = (id, seen, out) => {
    for (const dependency of dependsOf.get(id) ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      if (addedIds.has(dependency)) deadDependencies(dependency, seen, out);
      else if (DEAD.has(statusOf.get(dependency))) out.push(dependency);
    }
    return out;
  };
  const found = [];
  for (const action of added) {
    for (const dependency of deadDependencies(action.id, new Set(), [])) {
      const status = statusOf.get(dependency);
      if (status !== 'blocked') {
        found.push({ step: action.id, dependency, status });
        continue;
      }
      // A blocked step with no failed or cancelled step above it may still
      // run once its upstream does, and rerun refuses it: no warning.
      const root = state?.program ? blockingRoot(state, dependency) : null;
      if (root && root.status !== 'blocked') found.push({ step: action.id, dependency, status, blockedBy: { step: root.id, status: root.status } });
    }
  }
  return found;
}

const WORDS = { failed: 'failed', cancelled: 'was cancelled', blocked: 'is blocked' };

/** The warning line for one entry; `rerun(step)` is the command that runs that step again. */
export function waitsOnFinishedLine(entry, rerun) {
  const which = entry.blockedBy ? `is blocked by ${entry.blockedBy.step} (${entry.blockedBy.status})` : WORDS[entry.status];
  return `⚠ ${entry.step} waits on ${entry.dependency}, which ${which}: it stays blocked until you run \`${rerun(entry.blockedBy?.step ?? entry.dependency)}\``;
}
