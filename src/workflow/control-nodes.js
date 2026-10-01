// A v3 run's control nodes: the gates and loops its program declares, and
// the record of each (stored, or the initial one before the kernel's first
// pass). gates-loops.js moves them; the revision walk reads them too.

import { PROGRAM_V3_SCHEMA_VERSION } from './program-v3.js';

/** The run's gates and loops ({gates, loops}), or null for a v2 run or a v3 run with none. */
export function controlOf(state) {
  const program = state?.program;
  if (program?.schemaVersion !== PROGRAM_V3_SCHEMA_VERSION) return null;
  const gates = program.control?.gates ?? [];
  const loops = program.control?.loops ?? [];
  return gates.length || loops.length ? { gates, loops } : null;
}

function defaultRecord(node, type) {
  return type === 'loop'
    ? { id: node.id, type, status: 'pending', at: null, round: 1, maxRounds: node.maxRounds }
    : { id: node.id, type, status: 'pending', at: null };
}

/** Every control node's record, stored or (before the kernel's first pass) the initial one. */
export function controlRecords(state) {
  const control = controlOf(state);
  if (!control) return [];
  const stored = new Map((state.controlNodes ?? []).map((record) => [record.id, record]));
  return [
    ...control.loops.map((loop) => stored.get(loop.id) ?? defaultRecord(loop, 'loop')),
    ...control.gates.map((gate) => stored.get(gate.id) ?? defaultRecord(gate, 'gate')),
  ];
}

/**
 * The revision walk's edges through the run's gates and loops ([from, to]): a
 * gate's dependencies lead to the gate, a loop's steps to the loop, so a step
 * rerun or accepted before one reaches the steps behind it. A node that has
 * passed is left out: the steps behind it would start before the rerun step.
 */
export function controlReachEdges(state) {
  const control = controlOf(state);
  if (!control) return [];
  const status = new Map(controlRecords(state).map((record) => [record.id, record.status]));
  const edges = [];
  for (const loop of control.loops) if (status.get(loop.id) !== 'passed') for (const id of loop.steps) edges.push([id, loop.id]);
  for (const gate of control.gates) if (status.get(gate.id) !== 'passed') for (const id of gate.dependsOn) edges.push([id, gate.id]);
  return edges;
}
