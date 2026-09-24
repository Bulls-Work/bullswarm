// Closed role and deliverable vocabulary. No imports: action-validator.js
// imports this file, and this file must not import it back.

export const ROLES = Object.freeze(['investigate', 'produce', 'transform', 'combine', 'check', 'act']);

// Key order matches ACTION_KINDS / KIND_DEFAULTS.
export const KIND_ROLES = Object.freeze({
  mechanical: 'transform',
  'io-read': 'investigate',
  digest: 'combine',
  check: 'check',
  implement: 'produce',
  integration: 'combine',
  architecture: 'investigate',
  'adversarial-acceptance': 'check',
});

export const DELIVERABLE_TYPES = Object.freeze(['files', 'report', 'data', 'media', 'outward']);
export const WRITING_DELIVERABLES = Object.freeze(['files', 'data', 'media']);
export const EVIDENCE_TYPES = Object.freeze(['command', 'schema', 'review', 'choice']);

const WRITER_DELIVERABLES = Object.freeze(['files', 'data', 'media', 'report']);
export const ROLE_DELIVERABLES = Object.freeze({
  investigate: WRITER_DELIVERABLES,
  produce: WRITER_DELIVERABLES,
  transform: WRITER_DELIVERABLES,
  combine: WRITER_DELIVERABLES,
  check: Object.freeze(['report']),
  act: Object.freeze(['outward']),
});

// combine has no default: the caller must name files, data, media, or report.
export const ROLE_DEFAULT_DELIVERABLE = Object.freeze({
  investigate: 'report',
  produce: 'files',
  transform: 'files',
  check: 'report',
  act: 'outward',
});

const route = (lane, effort) => Object.freeze({ lane, effort });
export const ROLE_ROUTING = Object.freeze({
  investigate: Object.freeze({
    files: route('build', 'medium'),
    data: route('build', 'medium'),
    media: route('build', 'medium'),
    report: route('analyze', 'medium'),
  }),
  produce: Object.freeze({
    files: route('build', 'medium'),
    data: route('build', 'medium'),
    media: route('build', 'medium'),
    report: route('analyze', 'medium'),
  }),
  transform: Object.freeze({
    files: route('chore', 'low'),
    data: route('chore', 'low'),
    media: route('chore', 'low'),
    report: route('analyze', 'low'),
  }),
  combine: Object.freeze({
    files: route('build', 'high'),
    data: route('build', 'medium'),
    media: route('build', 'medium'),
    report: route('analyze', 'medium'),
  }),
  check: Object.freeze({
    report: route('analyze', 'medium'),
  }),
  act: Object.freeze({
    outward: route('analyze', 'medium'),
  }),
});

export function roleRouting(role, type) {
  const cell = ROLE_ROUTING[role]?.[type];
  return cell ? { lane: cell.lane, effort: cell.effort } : null;
}

export function laneFitsDeliverable(lane, type) {
  if (WRITING_DELIVERABLES.includes(type)) return lane === 'build' || lane === 'chore';
  if (type === 'report' || type === 'outward') return lane === 'analyze';
  return false;
}

export function roleOf(action) {
  return action?.role ?? (Object.hasOwn(KIND_ROLES, action?.kind ?? '') ? KIND_ROLES[action.kind] : null);
}

export function deliverableTypeOf(raw) {
  if (typeof raw === 'string') return DELIVERABLE_TYPES.includes(raw) ? raw : null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.type === 'string' && DELIVERABLE_TYPES.includes(raw.type)) {
    return raw.type;
  }
  return null;
}

// Structural form {type} or {type, paths}. Path legality is the validator's job.
export function declaredDeliverable(action) {
  const raw = action?.deliverable;
  const type = deliverableTypeOf(raw);
  if (!type) return null;
  if (typeof raw === 'string' || type === 'report' || type === 'outward') return { type };
  const paths = Array.isArray(raw.paths) ? raw.paths.filter((item) => typeof item === 'string' && item.length) : [];
  return paths.length ? { type, paths: [...paths] } : { type };
}
