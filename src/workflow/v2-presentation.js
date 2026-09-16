import { createHash } from 'node:crypto';
import { isLiveProgram } from './execution-policy.js';

const CATEGORY_ORDER = Object.freeze([
  'Discovery', 'Implementation', 'Tests', 'Documentation', 'Evidence',
]);

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function categoryFor(action) {
  if ((action.evidenceFor ?? []).length) return 'Evidence';
  const text = `${action.id ?? ''} ${action.purpose ?? ''}`.toLowerCase();
  const files = (action.ownedFiles ?? []).join(' ').toLowerCase();
  if (!action.ownedFiles?.length && /\b(discover|inspect|inventory|map|audit|analy[sz]e|research|scout)\b/.test(text)) return 'Discovery';
  if (/\b(test|spec|fixture|check|acceptance)\b/.test(text) || /(^|\/)(test|tests|spec|specs)(\/|$)/.test(files)) return 'Tests';
  if (/\b(doc|docs|readme|changelog|help|guide)\b/.test(`${text} ${files}`)) return 'Documentation';
  return 'Implementation';
}

export function deriveV2PresentationStages(actions, revision) {
  if (!Array.isArray(actions)) throw new TypeError('actions must be an array');
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError('revision must be a positive integer');
  const grouped = new Map();
  for (const action of actions) {
    const category = categoryFor(action);
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(action.id);
  }
  return CATEGORY_ORDER.filter((category) => grouped.has(category)).map((label) => ({
    id: `r${revision}-${slug(label)}`,
    label: revision === 1 ? label : `Follow-up ${revision - 1}: ${label}`,
    revision,
    actionIds: grouped.get(label),
    startedAt: null,
    completedAt: null,
  }));
}

export function stageForAction(presentation, actionId) {
  return presentation?.stages?.find((stage) => stage.actionIds.includes(actionId)) ?? null;
}

export function presentationStageStatus(stage, actionStates) {
  const byId = new Map((actionStates ?? []).map((action) => [action.id, action]));
  const states = stage.actionIds.map((id) => byId.get(id)?.status ?? 'pending');
  const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'removed']);
  return {
    terminal: states.length > 0 && states.every((status) => terminal.has(status)),
    successful: states.length > 0 && states.every((status) => status === 'succeeded'),
    completed: states.filter((status) => terminal.has(status)).length,
    total: states.length,
  };
}

// Dependency levels describe the graph; they never impose scheduling barriers.
export function deriveV2DependencyStages(actions, revision) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const depths = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (!byId.has(id)) return -1;
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) throw new Error('Cyclic action dependencies');
    visiting.add(id);
    const value = 1 + Math.max(-1, ...(byId.get(id).dependsOn ?? []).map(depth));
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  const groups = new Map();
  for (const action of actions) {
    const level = depth(action.id);
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(action);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([level, members]) => {
    const description = members.length === 1 ? members[0].id
      : members.every((action) => action.lane === 'analyze') ? 'Parallel analysis' : 'Parallel work';
    return {
      id: `r${revision}-level-${level + 1}`,
      label: `${revision > 1 ? `Follow-up ${revision - 1}: ` : ''}Phase ${level + 1} · ${description}`,
      revision, actionIds: members.map((action) => action.id), startedAt: null, completedAt: null,
    };
  });
}

// A revised program is one live graph, so its levels are derived over every
// action still in the plan. A level's id names its exact membership: a level a
// revision left alone keeps its id, and a changed level gets a new one, so a
// watcher reports each distinct level once.
function liveStageGroups(state) {
  const removed = new Set((state.actions ?? []).filter((action) => action.status === 'removed').map((action) => action.id));
  const live = (state.program?.actions ?? []).filter((action) => !removed.has(action.id));
  return deriveV2DependencyStages(live, 1).map((stage, index) => ({
    ...stage,
    id: `live-level-${index + 1}-${createHash('sha256').update([...stage.actionIds].sort().join('\n')).digest('hex').slice(0, 8)}`,
  }));
}

function memberTimes(stage, runtime) {
  const members = stage.actionIds.map((id) => runtime.get(id));
  const starts = members.map((action) => action?.startedAt).filter(Boolean).sort();
  const finishes = members.map((action) => action?.finishedAt).filter(Boolean).sort();
  return { start: starts[0] ?? null, finish: finishes.at(-1) ?? null };
}

// The kernel-owned stages written when a revision applies. An unchanged level
// keeps its stage record (and so its start); one that has work to do again
// loses its completion so the kernel reports it when it finishes again.
export function deriveV2LiveStages(state, { revision, at }) {
  const prior = new Map((state.presentation?.stages ?? []).map((stage) => [stage.id, stage]));
  const runtime = new Map((state.actions ?? []).map((action) => [action.id, action]));
  return liveStageGroups(state).map((stage) => {
    const status = presentationStageStatus(stage, state.actions);
    const { start, finish } = memberTimes(stage, runtime);
    const kept = prior.get(stage.id);
    if (kept) return { ...kept, completedAt: status.terminal ? kept.completedAt ?? finish ?? at : null };
    return {
      ...stage,
      revision,
      startedAt: status.terminal ? start ?? at : start,
      completedAt: status.terminal ? finish ?? at : null,
    };
  });
}

// Project older saved program runs too, without rewriting their event history.
export function projectV2DependencyStages(state) {
  const runtime = new Map((state.actions ?? []).map((action) => [action.id, action]));
  if (isLiveProgram(state)) {
    return liveStageGroups(state).map((stage) => {
      const { start, finish } = memberTimes(stage, runtime);
      return {
        ...stage, revision: state.program.revision, startedAt: start,
        completedAt: presentationStageStatus(stage, state.actions).terminal ? finish : null,
      };
    });
  }
  const revisions = new Map();
  for (const action of state.program?.actions ?? []) {
    const revision = runtime.get(action.id)?.programRevision ?? 1;
    if (!revisions.has(revision)) revisions.set(revision, []);
    revisions.get(revision).push(action);
  }
  return [...revisions].sort(([a], [b]) => a - b).flatMap(([revision, actions]) =>
    deriveV2DependencyStages(actions, revision).map((stage) => {
      const members = stage.actionIds.map((id) => runtime.get(id));
      const starts = members.map((action) => action?.startedAt).filter(Boolean).sort();
      const finishes = members.map((action) => action?.finishedAt).filter(Boolean).sort();
      return { ...stage, startedAt: starts[0] ?? null,
        completedAt: presentationStageStatus(stage, state.actions).terminal ? finishes.at(-1) ?? null : null };
    }));
}
