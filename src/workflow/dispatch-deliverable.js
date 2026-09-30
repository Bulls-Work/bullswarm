// The deliverable verdict: whether a step produced what it declared, from
// the snapshot facts taken around its attempts (pure; no file access).
import { declaredDeliverable, roleOf } from './step-vocabulary.js';

function pathStat(table, path) {
  if (!table) return null;
  if (typeof table.get === 'function') return table.get(path) ?? null;
  return Object.prototype.hasOwnProperty.call(table, path) ? table[path] : null;
}

// Created, bytes changed, or mtime changed. A missing file was not written.
function pathWasWritten(before, after) {
  if (!after?.exists) return false;
  if (!before?.exists) return true;
  return before.sha1 !== after.sha1 || before.mtimeMs !== after.mtimeMs;
}

function ownedStatsWritten(before, after) {
  const keys = new Set([
    ...(typeof before?.keys === 'function' ? before.keys() : Object.keys(before ?? {})),
    ...(typeof after?.keys === 'function' ? after.keys() : Object.keys(after ?? {})),
  ]);
  for (const path of keys) {
    if (pathWasWritten(pathStat(before, path), pathStat(after, path))) return true;
  }
  return false;
}

function compareDeclaredPaths(paths, before, after) {
  const written = [];
  const missing = [];
  for (const path of paths) {
    const next = pathStat(after, path);
    if (!next?.exists) missing.push(path);
    else if (pathWasWritten(pathStat(before, path), next)) written.push(path);
  }
  return { written, missing };
}

function nameList(paths) {
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

export function gateBaselinePaths(action, gitWorks) {
  const declared = declaredDeliverable(action);
  if (!declared) return [];
  if (declared.paths?.length) return declared.paths;
  if (gitWorks) return [];
  return Array.isArray(action?.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
}

// The gate measures the whole step (D19), and only when the content verdict
// is ok. A step with no declared deliverable keeps the legacy lane rule.
// `changed` is the union of this dispatch's attempts; heads and path stats
// are the step baseline. Returns `{ fact, failWhy }`. `fact` is null when
// the action declares no deliverable.
export function deliverableVerdict({
  action,
  verdict,
  legacyGate = true,
  snapshotOk = false,
  changed = [],
  headBefore = null,
  headAfter = null,
  pathsBefore = null,
  pathsAfter = null,
  outputBytes = null,
  earlierWork = { produced: false, unknown: false },
} = {}) {
  const declared = declaredDeliverable(action);
  const contentOk = verdict?.ok !== false;
  const evidence = Array.isArray(action?.evidenceFor) && action.evidenceFor.length > 0;
  const changedList = Array.isArray(changed) ? changed : [];
  const headMoved = headBefore !== headAfter;
  const paths = declared?.paths ?? [];
  const compared = paths.length ? compareDeclaredPaths(paths, pathsBefore, pathsAfter) : { written: [], missing: [] };
  const statWrite = paths.length
    ? compared.written.length > 0
    : ownedStatsWritten(pathsBefore, pathsAfter);
  // For a path deliverable, "this dispatch changed nothing" (D19 3) means no
  // declared path was written: a resumed worker that only reruns its checks
  // may leave a log behind without redoing the deliverable.
  const dispatchChanged = paths.length ? statWrite : changedList.length > 0 || headMoved || statWrite;
  const earlierHit = !dispatchChanged && (earlierWork?.produced === true || earlierWork?.unknown === true);
  const quiet = (fact, failWhy) => ({ fact, failWhy: contentOk ? failWhy : null });

  if (!declared) {
    if (evidence || legacyGate === false) return { fact: null, failWhy: null };
    const judged = action?.lane === 'build' && snapshotOk === true;
    if (!judged || earlierHit) return { fact: null, failWhy: null };
    if (!dispatchChanged) return quiet(null, 'no file changed');
    return { fact: null, failWhy: null };
  }

  const type = declared.type;
  if (evidence) return { fact: { type, gated: false, produced: null }, failWhy: null };
  if (type === 'outward') return { fact: { type: 'outward', gated: false, produced: null }, failWhy: null };
  if (type === 'report') {
    const produced = Number(outputBytes) > 0;
    return quiet(
      { type: 'report', gated: true, produced },
      produced ? null : 'report is empty',
    );
  }
  if (paths.length) {
    const factPaths = {
      written: compared.written.slice(0, 50),
      missing: compared.missing.slice(0, 50),
    };
    if (compared.missing.length) {
      return quiet(
        { type, gated: true, produced: false, ...factPaths, ...(earlierHit ? { carried: true } : {}) },
        `declared ${type} missing: ${nameList(compared.missing)}`,
      );
    }
    if (!compared.written.length) {
      if (earlierHit) {
        return { fact: { type, gated: true, produced: true, written: [], missing: [], carried: true }, failWhy: null };
      }
      return quiet(
        { type, gated: true, produced: false, written: [], missing: [] },
        `declared ${type} not written: ${nameList(paths)}`,
      );
    }
    return { fact: { type, gated: true, produced: true, ...factPaths }, failWhy: null };
  }

  // files, no paths. combine is exempt. No snapshot means the promise cannot
  // be checked (D21), so the attempt is recorded and not failed.
  const role = roleOf(action);
  if (role === 'combine' || snapshotOk !== true) {
    return {
      fact: { type: 'files', gated: false, produced: null, ...(earlierHit ? { carried: true } : {}) },
      failWhy: null,
    };
  }
  if (earlierHit) return { fact: { type: 'files', gated: false, produced: null, carried: true }, failWhy: null };
  if (!dispatchChanged) return quiet({ type: 'files', gated: true, produced: false }, 'no file changed');
  return { fact: { type: 'files', gated: true, produced: true }, failWhy: null };
}
