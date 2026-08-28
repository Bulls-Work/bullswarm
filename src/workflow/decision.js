// Planner decisions are untrusted proposals. This module is deliberately
// deterministic: it parses and bounds proposals before the runtime can append
// or dispatch any new action.

export const DECISION_SCHEMA_VERSION = 'bullswarm.workflow.decision.v1';
export const DECISIONS = new Set([
  'proceed', 'complete', 'needs_more_work', 'retry', 'escalate',
  'wait_for_approval', 'stop',
]);
const ACTION_TYPES = new Set(['run', 'fanout', 'verify']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class DecisionValidationError extends Error {
  constructor(issues) {
    super(`planner decision invalid: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

export function parseDecisionText(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new DecisionValidationError(['response did not contain a JSON object']);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new DecisionValidationError([`response JSON could not be parsed: ${err.message}`]);
  }
}

// Remove a workflow-format detail that planner models should not need to know:
// a verifier depending on exactly one action plainly intends to review that
// action's durable output artifact. Ambiguous or missing dependencies remain
// untouched and are rejected by normal validation.
export function normalizeDecisionProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.actions)) return proposal;
  return {
    ...proposal,
    actions: proposal.actions.map((action) => {
      if (action?.type !== 'verify' || action.review != null ||
          !Array.isArray(action.dependsOn) || action.dependsOn.length !== 1) {
        return action;
      }
      return { ...action, review: `outputs.${action.dependsOn[0]}.outFile` };
    }),
  };
}

export function validateDecisionProposal(proposal, {
  knownActionIds = [],
  closedPhases = [],
  currentActionCount = 0,
  maxActions = 100,
  maxItemsPerExpansion = 50,
} = {}) {
  const issues = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new DecisionValidationError(['decision must be an object']);
  }
  if (proposal.schemaVersion !== DECISION_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be "${DECISION_SCHEMA_VERSION}"`);
  }
  if (!DECISIONS.has(proposal.decision)) issues.push(`unknown decision "${proposal.decision}"`);
  if (typeof proposal.reason !== 'string' || !proposal.reason.trim()) issues.push('reason must be a non-empty string');

  const actions = proposal.actions ?? [];
  if (!Array.isArray(actions)) issues.push('actions must be an array');
  const safeActions = Array.isArray(actions) ? actions : [];
  if (['needs_more_work', 'retry', 'escalate'].includes(proposal.decision) && safeActions.length === 0) {
    issues.push(`${proposal.decision} requires at least one bounded action`);
  }
  if (!['needs_more_work', 'retry', 'escalate'].includes(proposal.decision) && safeActions.length > 0) {
    issues.push(`${proposal.decision} cannot include actions`);
  }
  if (currentActionCount + safeActions.length > maxActions) {
    issues.push(`proposal would exceed maxActions=${maxActions}`);
  }

  const known = new Set(knownActionIds);
  const closed = new Set(closedPhases);
  const proposed = new Set();
  let proposedItems = 0;
  for (const [index, action] of safeActions.entries()) {
    const at = `actions[${index}]`;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      issues.push(`${at} must be an object`);
      continue;
    }
    if (typeof action.id !== 'string' || !ID_RE.test(action.id)) issues.push(`${at}.id must be kebab-case`);
    else if (known.has(action.id) || proposed.has(action.id)) issues.push(`${at}.id "${action.id}" is not unique`);
    else proposed.add(action.id);
    if (!ACTION_TYPES.has(action.type)) issues.push(`${at}.type must be run|fanout|verify`);
    if (action.phase != null && (typeof action.phase !== 'string' || !ID_RE.test(action.phase))) {
      issues.push(`${at}.phase must be kebab-case`);
    } else if (action.phase != null && closed.has(action.phase)) {
      issues.push(`${at}.phase "${action.phase}" is already finished; phases are forward-only`);
    }
    if (action.dependsOn != null && (!Array.isArray(action.dependsOn) ||
      action.dependsOn.some((id) => typeof id !== 'string'))) {
      issues.push(`${at}.dependsOn must be an array of action IDs`);
    }
    if (action.requiresCapabilities != null && (!Array.isArray(action.requiresCapabilities) ||
      action.requiresCapabilities.some((capability) => typeof capability !== 'string' || !ID_RE.test(capability)))) {
      issues.push(`${at}.requiresCapabilities must contain kebab-case names`);
    }
    if (action.effort != null && !['high', 'medium', 'low'].includes(action.effort)) {
      issues.push(`${at}.effort must be high|medium|low`);
    }
    for (const runtimeOwned of ['pool', 'addDir', 'taskFile']) {
      if (action[runtimeOwned] != null) issues.push(`${at}.${runtimeOwned} is runtime-owned and cannot be proposed by a planner`);
    }
    if (action.type === 'run' && typeof action.prompt !== 'string') {
      issues.push(`${at} needs a prompt`);
    }
    if (action.type === 'fanout') {
      if (!Array.isArray(action.items)) issues.push(`${at}.items must be an inline array`);
      else proposedItems += action.items.length;
      if (!action.stepTemplate || typeof action.stepTemplate !== 'object') issues.push(`${at}.stepTemplate is required`);
      for (const runtimeOwned of ['pool', 'addDir', 'taskFile']) {
        if (action.stepTemplate?.[runtimeOwned] != null) {
          issues.push(`${at}.stepTemplate.${runtimeOwned} is runtime-owned and cannot be proposed by a planner`);
        }
      }
    }
    if (action.type === 'verify' && typeof action.review !== 'string') issues.push(`${at}.review is required`);
  }
  if (proposedItems > maxItemsPerExpansion) {
    issues.push(`proposal has ${proposedItems} fanout items, exceeding maxItemsPerExpansion=${maxItemsPerExpansion}`);
  }

  const all = new Set([...known, ...proposed]);
  for (const [index, action] of safeActions.entries()) {
    for (const dependency of action?.dependsOn ?? []) {
      if (!all.has(dependency)) issues.push(`actions[${index}].dependsOn references unknown action "${dependency}"`);
      if (dependency === action.id) issues.push(`actions[${index}] cannot depend on itself`);
    }
  }
  // Detect cycles among newly proposed actions.
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(safeActions.map((action) => [action?.id, action]));
  const visit = (id) => {
    if (!byId.has(id) || visited.has(id)) return;
    if (visiting.has(id)) { issues.push(`proposed actions contain a dependency cycle at "${id}"`); return; }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of proposed) visit(id);

  if (issues.length) throw new DecisionValidationError(issues);
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    decision: proposal.decision,
    reason: proposal.reason.trim(),
    actions: safeActions.map((action) => ({ ...action, dependsOn: [...(action.dependsOn ?? [])] })),
  };
}
