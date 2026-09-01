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
  const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
  return {
    terminal: states.length > 0 && states.every((status) => terminal.has(status)),
    successful: states.length > 0 && states.every((status) => status === 'succeeded'),
    completed: states.filter((status) => terminal.has(status)).length,
    total: states.length,
  };
}
