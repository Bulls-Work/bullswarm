// The phases a v3 run reads as (0.37.0): the dashboard's Run page, the watch's
// phase lines and the mod group a v3 run's steps by the `phase` label each
// step declares, in the order the graph reaches them.
//
// A v2 run groups its steps by dependency level (v2-presentation.js). A v3
// step may depend on a gate or a loop id, which is not a step, so its level is
// read through the control node: a gate sits at the level of its latest
// dependency, a loop at the level of its latest body step, and a step behind
// either is one level later. Steps that declare no phase keep the v2 grouping
// by level. Pure: reads state.program and state.actions only.

import { createHash } from 'node:crypto';
import { PROGRAM_V3_SCHEMA_VERSION } from './program-v3.js';

/** True for a run whose stored program is v3. */
export function isV3State(state) {
  return state?.program?.schemaVersion === PROGRAM_V3_SCHEMA_VERSION;
}

/**
 * True for a run record (a dashboard row with its state, or a rollup) of a
 * v3 run: rollups say so with `programFormat: 3`.
 */
export function isV3Record(record) {
  return isV3State(record?.state) || record?.programFormat === 3;
}

/** The run's gates and loops as declared ({gates, loops}; empty lists for none). */
export function declaredControl(state) {
  return { gates: state?.program?.control?.gates ?? [], loops: state?.program?.control?.loops ?? [] };
}

/**
 * A one-step run: a v3 run of exactly one step and no gate or loop, which is
 * what `bullswarm run` records (a run is a one-step workflow).
 */
export function isOneStepRun(state) {
  if (!isV3State(state)) return false;
  const { gates, loops } = declaredControl(state);
  return (state.program.actions ?? []).length === 1 && !gates.length && !loops.length;
}

// The live steps: every declared step a revision has not removed.
function liveSteps(state) {
  const removed = new Set((state.actions ?? []).filter((action) => action.status === 'removed').map((action) => action.id));
  return (state.program?.actions ?? []).filter((action) => !removed.has(action.id));
}

/** Each step's level: 0 for a step with no dependency, one more than its latest one. */
function stepLevels(state, steps) {
  const { gates, loops } = declaredControl(state);
  const deps = new Map([
    ...steps.map((step) => [step.id, { step: true, on: step.dependsOn ?? [] }]),
    ...gates.map((gate) => [gate.id, { step: false, on: gate.dependsOn ?? [] }]),
    ...loops.map((loop) => [loop.id, { step: false, on: loop.steps ?? [] }]),
  ]);
  const memo = new Map();
  const visiting = new Set();
  // A step is one level after what it waits on; a gate or a loop is at the
  // level of what it waits on, so it adds no level of its own.
  const level = (id) => {
    const node = deps.get(id);
    if (!node) return -1;
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const latest = Math.max(-1, ...node.on.map(level));
    visiting.delete(id);
    const value = node.step ? latest + 1 : Math.max(0, latest);
    memo.set(id, value);
    return value;
  };
  return new Map(steps.map((step) => [step.id, level(step.id)]));
}

const digest = (ids) => createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 8);

function memberTimes(actionIds, runtime) {
  const members = actionIds.map((id) => runtime.get(id));
  const starts = members.map((action) => action?.startedAt).filter(Boolean).sort();
  const finishes = members.map((action) => action?.finishedAt).filter(Boolean).sort();
  const terminal = members.length > 0 && members.every((action) => ['succeeded', 'failed', 'blocked', 'cancelled', 'removed'].includes(action?.status));
  return { startedAt: starts[0] ?? null, completedAt: terminal ? finishes.at(-1) ?? null : null };
}

/**
 * A v3 run's stages, in the shape v2-presentation.js projects for a v2 run:
 * [{id, label, phase, revision, actionIds, startedAt, completedAt}]. A step
 * with a `phase` joins the stage of that name; a step without one joins the
 * stage of its level among the other unnamed steps. Stages run in the order
 * of their earliest step's level, then the program's order.
 */
export function v3Stages(state) {
  const steps = liveSteps(state);
  const levels = stepLevels(state, steps);
  const groups = new Map();
  steps.forEach((step, order) => {
    const phase = typeof step.phase === 'string' && step.phase.trim() ? step.phase.trim() : null;
    const key = phase ? `phase:${phase}` : `level:${levels.get(step.id)}`;
    if (!groups.has(key)) groups.set(key, { phase, level: levels.get(step.id), order, steps: [] });
    const group = groups.get(key);
    group.level = Math.min(group.level, levels.get(step.id));
    group.steps.push(step);
  });
  const runtime = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const revision = state.program?.revision ?? 1;
  return [...groups.values()]
    .sort((a, b) => a.level - b.level || a.order - b.order)
    .map((group, index) => {
      const actionIds = group.steps.map((step) => step.id);
      const unnamed = group.steps.length === 1 ? actionIds[0]
        : group.steps.every((step) => step.lane === 'analyze') ? 'Parallel analysis' : 'Parallel work';
      return {
        id: group.phase ? `v3-phase-${digest([group.phase])}` : `v3-level-${index + 1}-${digest(actionIds)}`,
        label: `Phase ${index + 1} · ${group.phase ?? unnamed}`,
        ...(group.phase ? { phase: group.phase } : {}),
        revision,
        actionIds,
        ...memberTimes(actionIds, runtime),
      };
    });
}
