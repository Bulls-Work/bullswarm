// Durable operator guidance for autonomous workflows.
// Instructions are append-only and are delivered only at a not-yet-started
// decide/planning checkpoint. Active workers are never hot-patched.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveRunId } from './short-id.js';

export function steeringPath(runDir) {
  return join(runDir, 'steering.jsonl');
}

export function readSteering(runDir) {
  const path = steeringPath(runDir);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore interrupted final append */ }
  }
  return rows;
}

export function queueSteering(bullswarmDir, token, message) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('steering message must not be empty');
  if (text.length > 4000) throw new Error('steering message exceeds 4000 characters');
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.finishedAt || ['completed', 'failed', 'cancelled', 'interrupted', 'budget_exhausted'].includes(state.status)) {
    throw new Error(`run "${token}" is already terminal (${state.status})`);
  }
  const hasDecisionGate = state._doc?.phases?.some((phase) =>
    phase.steps?.some((step) => step.type === 'decide'));
  if (!hasDecisionGate) throw new Error(`run "${token}" has no orchestration decision gate to receive steering`);
  const entry = {
    id: `steer-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    message: text,
    queuedAt: new Date().toISOString(),
    delivery: 'next-not-yet-started-planner-checkpoint',
  };
  appendFileSync(steeringPath(resolved.runDir), `${JSON.stringify(entry)}\n`, { flag: 'a' });
  return { ...resolved, entry, state };
}

export function deliverSteering(state, runDir) {
  state.steering ??= [];
  const known = new Set(state.steering.map((entry) => entry.id));
  const deliveredAt = new Date().toISOString();
  const fresh = readSteering(runDir).filter((entry) => !known.has(entry.id)).map((entry) => ({
    ...entry,
    status: 'delivered_to_planner',
    deliveredAt,
    decisionSequence: (state.decisions?.length ?? 0) + 1,
  }));
  state.steering.push(...fresh);
  return fresh;
}
