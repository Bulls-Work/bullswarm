// A caller-authored program accepted with the same bookkeeping a dispatched
// planner turn gets (acceptCallerPlannerResponse). A v3 launch is such a turn.

import { appendEvent } from './events.js';
import { initializeNewActions } from './v2-state.js';
import { applyV2PlannerResponse } from './v2-planner.js';
import { deliverSteering } from './steering.js';

// Apply a planner response that did not come from a dispatched planner
// process (a caller-authored program), from the runtime's initial-program
// path. It records the same durable bookkeeping a dispatched turn does: turn
// counters, expansion rounds, action initialization, and the same
// planner.finished event a dispatched planner would have produced.
export function acceptCallerPlannerResponse(state, response, { boundary, runDir, onEvent = null, now = () => new Date().toISOString(), deliverSteeringIds = null } = {}) {
  // Steering the request surfaced to the caller is consumed by this turn
  // (recorded before the turn counter advances, like a dispatched delivery).
  // Steering queued after the request was shown stays pending, so the resumed
  // kernel opens a steering boundary for it instead of losing it.
  const deliveredSteering = deliverSteeringIds ? deliverSteering(state, runDir, { ids: deliverSteeringIds }) : [];
  const next = applyV2PlannerResponse(state, response, { boundary, requiredScoutUnits: [] });
  next.planner.awaiting = null;
  for (const entry of deliveredSteering) {
    // Append first, then notify: `onEvent?.(appendEvent(...))` would skip the
    // append entirely when no listener is attached (optional-call
    // short-circuiting does not evaluate the arguments).
    const event = appendEvent(runDir, next, 'steering.delivered', { steeringId: entry.id, message: entry.message, decisionSequence: entry.decisionSequence, source: 'caller' });
    onEvent?.(event);
  }
  if (boundary === 'gaps') next.budget.expansions += 1;
  initializeNewActions(next);
  const accepted = next.planner.lastDecision;
  if (accepted.kind === 'exhausted') {
    next.lifecycle.status = 'planning';
  }
  const event = appendEvent(runDir, next, 'planner.finished', {
    turn: next.planner.turns, ok: true, kind: accepted.kind, summary: accepted.summary,
    programRevision: next.program.revision, source: 'caller', boundary, at: now(),
  });
  onEvent?.(event);
  return { state: next, accepted };
}
