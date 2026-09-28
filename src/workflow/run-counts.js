// How many of a set of run records are one-step runs and how many are
// workflows (0.37.0): a run is a one-step workflow, so Stats and Home count
// both and name them apart instead of calling a single run a workflow.

import { isOneStepRun } from './v3-phases.js';

/**
 * A one-step run: a v3 rollup marked `oneStep`, a row whose state is one, or
 * a legacy single-run record (`bullswarm run` before 0.37.0).
 */
export function isOneStepRecord(record) {
  return record?.oneStep === true || isOneStepRun(record?.state)
    || record?.kind === 'task' || record?.kind === 'run' || record?.source === 'run';
}

const counted = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * `5 workflows`, `3 runs`, or `3 runs · 5 workflows` for `total` records of
 * which `oneStep` are one-step runs.
 */
export function runCountText(total, oneStep = 0) {
  const single = Math.max(0, Math.min(total, Number(oneStep) || 0));
  if (!single) return counted(total, 'workflow');
  if (single === total) return counted(total, 'run');
  return `${counted(single, 'run')} · ${counted(total - single, 'workflow')}`;
}
