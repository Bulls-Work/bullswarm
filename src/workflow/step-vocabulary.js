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

// Evidence a step declares in its `evidence` field (checks Bullswarm runs
// itself), and the types a finished step can be proven by. `review` is a check
// step with evidenceFor; `choice` is recorded by the caller (stage 3).
export const STEP_EVIDENCE_TYPES = Object.freeze(['command', 'schema']);
export const USABLE_EVIDENCE_TYPES = Object.freeze(['command', 'schema', 'review']);
export const EVIDENCE_ITEM_STATUSES = Object.freeze(['passed', 'failed', 'not-run']);
// The closed key set of one `evidenceResults` entry (attempt and result action).
export const EVIDENCE_RESULT_FIELDS = Object.freeze([
  'type', 'cmd', 'file', 'schema', 'format', 'timeoutSec',
  'status', 'exit', 'durationMs', 'tail', 'log', 'why',
  'timedOut', 'signal', 'changed', 'touched', 'headMoved', 'schemaChanged',
  'fault', 'errorCount', 'errors', 'notes',
]);
const EVIDENCE_RESULT_FIELD_SET = new Set(EVIDENCE_RESULT_FIELDS);
const SCHEMA_ONLY_RESULT_FIELDS = Object.freeze(['file', 'schema', 'format', 'fault', 'errorCount', 'errors', 'notes']);
const EVIDENCE_RESULTS_MAX = 5;
// Bounds for stored strings. `cmd` is the command as it ran, after the
// isolated-path rewrite, so it may be longer than the 2000 bytes the field takes.
const RESULT_TEXT_MAX = Object.freeze({ cmd: 8192, file: 4096, schema: 4096, tail: 4096, log: 4096, why: 1000, signal: 32 });

// Pure nested validator shared by v2-state.js and v2-outcome.js; returns
// messages, never throws.
export function evidenceResultsIssues(value, name) {
  if (!Array.isArray(value)) return [`${name} must be an array`];
  const issues = [];
  if (value.length > EVIDENCE_RESULTS_MAX) issues.push(`${name} must have at most ${EVIDENCE_RESULTS_MAX} items`);
  const text = (item, key, at, { nullable = false } = {}) => {
    const raw = item[key];
    if (nullable && raw === null) return;
    if (typeof raw !== 'string' || raw.length > RESULT_TEXT_MAX[key]) {
      issues.push(`${at}.${key} must be ${nullable ? 'null or ' : ''}a string of at most ${RESULT_TEXT_MAX[key]} characters`);
    }
  };
  const strings = (item, key, at, max, length = Infinity) => {
    const raw = item[key];
    if (!Array.isArray(raw) || raw.length > max || raw.some((entry) => typeof entry !== 'string' || entry.length > length)) {
      issues.push(`${at}.${key} must be an array of at most ${max} strings${Number.isFinite(length) ? ` of at most ${length} characters` : ''}`);
    }
  };
  const flag = (item, key, at) => {
    if (item[key] !== undefined && item[key] !== true) issues.push(`${at}.${key} must be true when present`);
  };
  for (const [index, item] of value.entries()) {
    const at = `${name}[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${at} must be an object`);
      continue;
    }
    for (const key of Object.keys(item)) if (!EVIDENCE_RESULT_FIELD_SET.has(key)) issues.push(`${at}.${key} is not allowed`);
    const typeKnown = STEP_EVIDENCE_TYPES.includes(item.type);
    if (!typeKnown) issues.push(`${at}.type must be ${STEP_EVIDENCE_TYPES.join('|')}`);
    if (!EVIDENCE_ITEM_STATUSES.includes(item.status)) issues.push(`${at}.status must be ${EVIDENCE_ITEM_STATUSES.join('|')}`);
    if (item.type === 'command') {
      text(item, 'cmd', at);
      for (const key of SCHEMA_ONLY_RESULT_FIELDS) if (Object.hasOwn(item, key)) issues.push(`${at}.${key} is only for schema items`);
    } else if (item.type === 'schema') {
      text(item, 'file', at);
      text(item, 'schema', at);
      if (Object.hasOwn(item, 'cmd')) issues.push(`${at}.cmd is only for command items`);
      if (item.format !== undefined && item.format !== 'json' && item.format !== 'jsonl') issues.push(`${at}.format must be json|jsonl`);
      if (item.fault !== undefined && item.fault !== 'check') issues.push(`${at}.fault must be check when present`);
      if (item.errorCount !== undefined && !(Number.isInteger(item.errorCount) && item.errorCount >= 0)) issues.push(`${at}.errorCount must be a non-negative integer`);
      if (item.errors !== undefined) strings(item, 'errors', at, 5, 200);
      if (item.notes !== undefined) strings(item, 'notes', at, 3, 200);
    }
    if (item.timeoutSec !== undefined && !(Number.isInteger(item.timeoutSec) && item.timeoutSec >= 1 && item.timeoutSec <= 600)) {
      issues.push(`${at}.timeoutSec must be an integer from 1 to 600`);
    }
    if (item.exit !== undefined && item.exit !== null && !Number.isInteger(item.exit)) issues.push(`${at}.exit must be null or an integer`);
    if (item.durationMs !== undefined && !(Number.isFinite(item.durationMs) && item.durationMs >= 0)) issues.push(`${at}.durationMs must be a non-negative number`);
    if (item.tail !== undefined) text(item, 'tail', at);
    if (item.log !== undefined) text(item, 'log', at);
    if (item.why !== undefined) text(item, 'why', at, { nullable: true });
    if (item.signal !== undefined) text(item, 'signal', at);
    for (const key of ['timedOut', 'headMoved', 'schemaChanged']) flag(item, key, at);
    for (const key of ['changed', 'touched']) if (item[key] !== undefined) strings(item, key, at, 20);
  }
  return issues;
}

// The checks a step declares, or [] (the validator drops `evidence: []`).
export function declaredEvidence(action) {
  return Array.isArray(action?.evidence) ? action.evidence : [];
}
