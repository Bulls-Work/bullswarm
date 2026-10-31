// `workflow add`: the added steps that can never run on their own because
// they wait, directly or through other added steps, on a step that is
// failed, cancelled or blocked. The add still applies (a person may rerun the
// dependency afterwards); the caller is told which steps stay blocked.

const DEAD = new Set(['failed', 'cancelled', 'blocked']);

/**
 * [{step, dependency, status}] in added order: `step` is an added step,
 * `dependency` the failed, cancelled or blocked step it waits on. `state` is
 * the run as the add left it (a cancelled step the reopen ran again is
 * pending, not dead); `added` the added step definitions.
 */
export function waitsOnFinishedSteps(state, added) {
  const statusOf = new Map((state?.actions ?? []).map((action) => [action.id, action.status]));
  const addedIds = new Set(added.map((action) => action.id));
  const dependsOf = new Map(added.map((action) => [action.id, Array.isArray(action.dependsOn) ? action.dependsOn : []]));
  const deadDependency = (id, seen) => {
    for (const dependency of dependsOf.get(id) ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      if (addedIds.has(dependency)) {
        const through = deadDependency(dependency, seen);
        if (through) return through;
      } else if (DEAD.has(statusOf.get(dependency))) return dependency;
    }
    return null;
  };
  const found = [];
  for (const action of added) {
    const dependency = deadDependency(action.id, new Set());
    if (dependency) found.push({ step: action.id, dependency, status: statusOf.get(dependency) });
  }
  return found;
}

const WORDS = { failed: 'failed', cancelled: 'was cancelled', blocked: 'is blocked' };

/** The warning line for one entry; `rerun(dependency)` is the command that runs it again. */
export function waitsOnFinishedLine(entry, rerun) {
  return `⚠ ${entry.step} waits on ${entry.dependency}, which ${WORDS[entry.status]}: it stays blocked until you run \`${rerun(entry.dependency)}\``;
}
