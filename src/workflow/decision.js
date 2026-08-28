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
// verify.review is a dotted scope path to the artifact under review
// (outputs.<actionId>.outFile), never instructions. Planners routinely put the
// reviewer's instructions there; recover that shape instead of failing a
// dispatch: instructions move to prompt, and a single-dependency verify reviews
// its dependency's artifact.
export const REVIEW_PATH_RE = /^outputs\.([A-Za-z0-9_-]+(?:\[\d+\])?)\.outFile$/;
// Data-driven fan-out source: the artifact of an earlier (or co-proposed)
// action whose output ends with a JSON array of items.
export const ITEMS_FROM_RE = /^outputs\.([A-Za-z0-9_-]+)(?:\.outFile)?$/;
export const REPAIR_MAX_ROUNDS = 3;
// Program-level completion predicates a planner may attach to a program so the
// runtime can record completion itself when every action finishes ok.
export const COMPLETION_PREDICATES = new Set(['all-actions-ok']);

export function looksLikeItemsFromPath(value) {
  return typeof value === 'string' && ITEMS_FROM_RE.test(value.trim());
}

export function looksLikeReviewPath(value) {
  return typeof value === 'string' && REVIEW_PATH_RE.test(value.trim());
}

export function normalizeDecisionProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.actions)) return proposal;
  return {
    ...proposal,
    actions: proposal.actions.map((action) => {
      if (action?.type === 'fanout' && !Array.isArray(action.items) && looksLikeItemsFromPath(action.itemsFrom)) {
        // A fanout fed by an artifact implicitly depends on the producer.
        const itemsFrom = action.itemsFrom.trim();
        const producer = ITEMS_FROM_RE.exec(itemsFrom)[1];
        const dependsOn = Array.isArray(action.dependsOn) ? action.dependsOn : [];
        return {
          ...action,
          itemsFrom,
          ...(dependsOn.includes(producer) || producer === action.id ? {} : { dependsOn: [...dependsOn, producer] }),
        };
      }
      if (action?.type !== 'verify') return action;
      const singleDependency = Array.isArray(action.dependsOn) && action.dependsOn.length === 1
        ? action.dependsOn[0] : null;
      if (action.review == null) {
        return singleDependency ? { ...action, review: `outputs.${singleDependency}.outFile` } : action;
      }
      if (looksLikeReviewPath(action.review)) return { ...action, review: action.review.trim() };
      if (typeof action.review === 'string' && singleDependency) {
        const { review, ...rest } = action;
        return {
          ...rest,
          ...(rest.prompt == null && /\s/.test(review.trim()) ? { prompt: review } : {}),
          review: `outputs.${singleDependency}.outFile`,
          reviewNormalizedFrom: review,
        };
      }
      return action;
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
  if (proposal.completion !== undefined) {
    const completion = proposal.completion;
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
      issues.push('completion must be an object {"when":"all-actions-ok","reason":"…"}');
    } else {
      if (!COMPLETION_PREDICATES.has(completion.when)) {
        issues.push(`completion.when must be one of: ${[...COMPLETION_PREDICATES].join(', ')}`);
      }
      if (completion.reason !== undefined && (typeof completion.reason !== 'string' || !completion.reason.trim())) {
        issues.push('completion.reason must be a non-empty string when present');
      }
      for (const key of Object.keys(completion)) {
        if (!['when', 'reason'].includes(key)) issues.push(`completion.${key} is not a planner field`);
      }
      if (proposal.decision !== 'needs_more_work') {
        issues.push('completion is only meaningful on a needs_more_work decision (a program)');
      } else if (!safeActions.some((action) => action?.type === 'verify')) {
        issues.push('a self-completing program must include at least one verify action');
      }
    }
  }

  const known = new Set(knownActionIds);
  const proposedIds = new Set(safeActions.map((action) => action?.id).filter((id) => typeof id === 'string'));
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
      const hasItems = Array.isArray(action.items);
      const hasItemsFrom = action.itemsFrom != null;
      if (!hasItems && !hasItemsFrom) {
        issues.push(`${at}.items must be an inline array, or ${at}.itemsFrom must be "outputs.<actionId>.outFile" naming the action whose output ends with the JSON array of items`);
      } else if (hasItems) {
        proposedItems += action.items.length;
        if (hasItemsFrom) issues.push(`${at} must use either items or itemsFrom, not both`);
      }
      if (hasItemsFrom && !hasItems) {
        if (!looksLikeItemsFromPath(action.itemsFrom)) {
          issues.push(`${at}.itemsFrom must be a dotted artifact path like "outputs.<actionId>.outFile" (the action whose output ends with a JSON array), not inline items, instructions, or a filesystem path`);
        } else {
          const producer = ITEMS_FROM_RE.exec(action.itemsFrom.trim())[1];
          if (producer === action.id) issues.push(`${at}.itemsFrom cannot reference the fanout itself`);
          else if (!known.has(producer) && !proposedIds.has(producer)) issues.push(`${at}.itemsFrom references unknown action "${producer}"`);
        }
      }
      if (!action.stepTemplate || typeof action.stepTemplate !== 'object') issues.push(`${at}.stepTemplate is required`);
      for (const runtimeOwned of ['pool', 'addDir', 'taskFile']) {
        if (action.stepTemplate?.[runtimeOwned] != null) {
          issues.push(`${at}.stepTemplate.${runtimeOwned} is runtime-owned and cannot be proposed by a planner`);
        }
      }
    }
    if (action.repair != null && action.type !== 'verify') {
      issues.push(`${at}.repair is only valid on verify actions`);
    }
    if (action.type === 'verify' && action.repair != null) {
      const repair = action.repair;
      if (!repair || typeof repair !== 'object' || Array.isArray(repair)) {
        issues.push(`${at}.repair must be an object like {"prompt":"<how to fix what the verifier rejects>","maxRounds":1}`);
      } else {
        if (typeof repair.prompt !== 'string' || !repair.prompt.trim()) {
          issues.push(`${at}.repair.prompt must be a non-empty string telling a worker how to fix what the verifier rejected`);
        }
        if (repair.maxRounds != null && !(Number.isInteger(repair.maxRounds) && repair.maxRounds >= 1 && repair.maxRounds <= REPAIR_MAX_ROUNDS)) {
          issues.push(`${at}.repair.maxRounds must be an integer from 1 to ${REPAIR_MAX_ROUNDS}`);
        }
        if (repair.effort != null && !['high', 'medium', 'low'].includes(repair.effort)) {
          issues.push(`${at}.repair.effort must be high|medium|low`);
        }
        for (const runtimeOwned of ['pool', 'addDir', 'taskFile']) {
          if (repair[runtimeOwned] != null) issues.push(`${at}.repair.${runtimeOwned} is runtime-owned and cannot be proposed by a planner`);
        }
      }
    }
    if (action.type === 'verify') {
      if (typeof action.review !== 'string') {
        issues.push(`${at}.review is required: a verify with one dependsOn reviews that artifact automatically; with several, set review to "outputs.<actionId>.outFile" and put reviewer instructions in prompt`);
      } else if (!looksLikeReviewPath(action.review)) {
        issues.push(`${at}.review must be a dotted artifact path like "outputs.<actionId>.outFile" (the artifact to review), not instructions or a filesystem path; put reviewer instructions in ${at}.prompt`);
      } else {
        const reviewed = REVIEW_PATH_RE.exec(action.review.trim())[1].replace(/\[\d+\]$/, '');
        if (!known.has(reviewed) && !proposedIds.has(reviewed)) {
          issues.push(`${at}.review references unknown action "${reviewed}"`);
        }
      }
    }
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
    ...(proposal.completion
      ? { completion: { when: proposal.completion.when, ...(proposal.completion.reason ? { reason: proposal.completion.reason.trim() } : {}) } }
      : {}),
  };
}
