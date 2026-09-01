// Pure ready-set scheduling for generic V2 actions. This module selects work;
// a runtime adapter remains responsible for dispatch and durable persistence.
import { normalizeOwnedFiles } from './ownership.js';

export class SchedulerValidationError extends TypeError {
  constructor(message) {
    super(`workflow scheduler invalid: ${message}`);
    this.name = 'SchedulerValidationError';
  }
}

const STATUSES = new Set(['pending', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SUCCESS = 'succeeded';
const UNSUCCESSFUL = new Set(['failed', 'blocked', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['running', 'waiting']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const object = (value, name) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SchedulerValidationError(`${name} must be an object`);
  return value;
};

function actionList(input) {
  const actions = Array.isArray(input) ? input : input?.actions;
  if (!Array.isArray(actions)) throw new SchedulerValidationError('actions must be an array');
  const ids = new Set();
  return actions.map((action, index) => {
    object(action, `actions[${index}]`);
    if (typeof action.id !== 'string' || !ID_RE.test(action.id)) throw new SchedulerValidationError(`actions[${index}].id must be a lowercase kebab-case ID`);
    if (ids.has(action.id)) throw new SchedulerValidationError(`duplicate action id "${action.id}"`);
    ids.add(action.id);
    if (!Array.isArray(action.dependsOn)) throw new SchedulerValidationError(`${action.id}.dependsOn must be an array`);
    if (!Array.isArray(action.ownedFiles)) throw new SchedulerValidationError(`${action.id}.ownedFiles must be an array`);
    const deps = [...action.dependsOn];
    if (deps.some((dep) => typeof dep !== 'string' || !dep)) throw new SchedulerValidationError(`${action.id}.dependsOn must contain non-empty strings`);
    if (new Set(deps).size !== deps.length) throw new SchedulerValidationError(`${action.id}.dependsOn contains duplicates`);
    return { ...clone(action), dependsOn: deps, ownedFiles: normalizeOwnedFiles(action.ownedFiles, `${action.id}.ownedFiles`) };
  });
}

function normalizeStates(states, ids) {
  if (states === undefined) return new Map([...ids].map((id) => [id, 'pending']));
  if (Array.isArray(states)) {
    const result = new Map();
    for (const [index, entry] of states.entries()) {
      object(entry, `states[${index}]`);
      if (typeof entry.id !== 'string' || !ids.has(entry.id)) throw new SchedulerValidationError(`states[${index}] references unknown action`);
      if (result.has(entry.id)) throw new SchedulerValidationError(`duplicate action state "${entry.id}"`);
      result.set(entry.id, entry.status);
    }
    states = Object.fromEntries(result);
  } else if (states?.actions !== undefined) {
    states = states.actions;
    return normalizeStates(states, ids);
  }
  object(states, 'states');
  const result = new Map();
  for (const [id, state] of Object.entries(states)) {
    if (!ids.has(id)) throw new SchedulerValidationError(`state references unknown action "${id}"`);
    const status = typeof state === 'string' ? state : state?.status;
    if (!STATUSES.has(status)) throw new SchedulerValidationError(`${id} has malformed status`);
    result.set(id, status);
  }
  for (const id of ids) result.set(id, result.get(id) ?? 'pending');
  return result;
}

function validateOptions(options) {
  const value = options ?? {};
  object(value, 'options');
  const concurrency = value.concurrency ?? value.maxParallel ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new SchedulerValidationError('concurrency must be a positive integer');
  const workspaceMode = value.workspaceMode ?? 'shared';
  if (workspaceMode !== 'shared' && workspaceMode !== 'isolated') throw new SchedulerValidationError('workspaceMode must be shared or isolated');
  return { concurrency, workspaceMode };
}

function mutating(action) { return action.ownedFiles.length > 0; }
function overlap(left, right) { return left.some((file) => right.includes(file)); }

function validateAcyclic(actions, byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new SchedulerValidationError('dependency graph contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const action of actions) visit(action.id);
}

export function scheduleV2Actions(input, states, options = {}) {
  const actions = actionList(input);
  const byId = new Map(actions.map((action) => [action.id, action]));
  for (const action of actions) for (const dep of action.dependsOn) if (!byId.has(dep)) {
    throw new SchedulerValidationError(`${action.id}.dependsOn references unknown action "${dep}"`);
  }
  validateAcyclic(actions, byId);
  const { concurrency, workspaceMode } = validateOptions(options);
  const status = normalizeStates(states, new Set(byId.keys()));
  const active = actions.filter((action) => ACTIVE.has(status.get(action.id)));
  if (active.length > concurrency) throw new SchedulerValidationError('active actions exceed concurrency');
  for (const action of active) if (action.dependsOn.some((dependency) => status.get(dependency) !== SUCCESS)) {
    throw new SchedulerValidationError(`active action "${action.id}" has an unfinished dependency`);
  }
  const activeMutators = active.filter(mutating);
  if (workspaceMode === 'shared' && activeMutators.length > 1) {
    throw new SchedulerValidationError('shared workspace has multiple active mutating actions');
  }
  for (let left = 0; left < activeMutators.length; left += 1) for (let right = left + 1; right < activeMutators.length; right += 1) {
    if (overlap(activeMutators[left].ownedFiles, activeMutators[right].ownedFiles)) {
      throw new SchedulerValidationError('active mutating actions have an owned file conflict');
    }
  }
  const memo = new Map();
  const outcome = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) throw new SchedulerValidationError('dependency graph contains a cycle');
    visiting.add(id);
    const action = byId.get(id);
    let result = status.get(id);
    for (const dependency of action.dependsOn) {
      const dependencyOutcome = outcome(dependency, visiting);
      if (UNSUCCESSFUL.has(dependencyOutcome)) result = 'blocked';
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  const ready = [], waiting = [], blocked = [];
  for (const action of actions) {
    if (status.get(action.id) !== 'pending' && status.get(action.id) !== 'ready') continue;
    const dependencies = action.dependsOn.map((id) => outcome(id));
    if (dependencies.some((value) => UNSUCCESSFUL.has(value))) blocked.push({ id: action.id, reason: 'failed dependency' });
    else if (dependencies.some((value) => value !== SUCCESS)) waiting.push({ id: action.id, reason: 'pending dependency' });
    else ready.push(action);
  }
  const selected = [];
  const deferred = [];
  const available = concurrency - active.length;
  for (const action of ready) {
    if (selected.length >= available) { deferred.push({ id: action.id, reason: 'concurrency cap' }); continue; }
    if (workspaceMode === 'shared' && mutating(action) && (activeMutators.length || selected.some(mutating))) {
      deferred.push({ id: action.id, reason: 'shared workspace allows one mutating action' }); continue;
    }
    if (mutating(action) && [...activeMutators, ...selected.filter(mutating)].some((other) => overlap(action.ownedFiles, other.ownedFiles))) {
      deferred.push({ id: action.id, reason: 'owned file conflict' }); continue;
    }
    selected.push(action);
  }
  return clone({ workspaceMode, concurrency, active: active.map((action) => action.id), ready: ready.map((action) => action.id), selected: selected.map((action) => action.id), waiting, blocked, deferred });
}

export const scheduleActions = scheduleV2Actions;
export const getReadySet = scheduleV2Actions;
export const selectReadyActions = scheduleV2Actions;
