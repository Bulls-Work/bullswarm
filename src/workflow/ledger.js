export const LEDGER_SCHEMA_VERSION = 'bullswarm.workflow.ledger.v2';
export const REQUIREMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  PASSED: 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});
export const REQUIREMENT_STATUS_VALUES = Object.freeze(Object.values(REQUIREMENT_STATUSES));

const STATUS_SET = new Set(REQUIREMENT_STATUS_VALUES);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new TypeError(`Invalid requirement ledger: ${message}`);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value) fail(`${name} must be a non-empty string`);
  return value;
}

function revision(value, name = 'workRevision') {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') fail(`${name} must be a string or number`);
  return value;
}

function sequence(value) {
  if (!Number.isInteger(value) || value < 0) fail('eventSequence must be a non-negative integer');
  return value;
}

function mechanicalFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('mechanicalFailure must be an object');
  return clone(value);
}

function requirementMap(requirements) {
  if (Array.isArray(requirements)) {
    const ids = new Set();
    return Object.fromEntries(requirements.map((requirement) => {
      object(requirement, 'requirement');
      const id = nonEmptyString(requirement.id, 'requirement.id');
      if (ids.has(id)) fail(`duplicate requirement id ${id}`);
      ids.add(id);
      return [id, { id, mandatory: requirement.mandatory !== false, workRevision: requirement.workRevision, status: REQUIREMENT_STATUSES.PENDING, evidence: [] }];
    }));
  }
  object(requirements, 'requirements');
  return Object.fromEntries(Object.entries(requirements).map(([id, requirement]) => {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) fail(`requirement ${id} must be an object`);
    nonEmptyString(id, 'requirement id');
    return [id, { id, mandatory: requirement.mandatory !== false, workRevision: requirement.workRevision, status: REQUIREMENT_STATUSES.PENDING, evidence: [] }];
  }));
}

export function createLedger(requirements = [], { workRevision = null } = {}) {
  revision(workRevision);
  const requirementMapValue = requirementMap(requirements);
  for (const requirement of Object.values(requirementMapValue)) {
    requirement.workRevision ??= workRevision;
    revision(requirement.workRevision, `requirement ${requirement.id} workRevision`);
  }
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    workRevision,
    requirements: requirementMapValue,
    evidence: [],
  };
  normalizeLedger(ledger);
  return ledger;
}

function normalizeLedger(ledger) {
  object(ledger, 'ledger');
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) fail(`schemaVersion must be ${LEDGER_SCHEMA_VERSION}`);
  revision(ledger.workRevision);
  object(ledger.requirements, 'ledger.requirements');
  if (!Array.isArray(ledger.evidence)) fail('ledger.evidence must be an array');
  for (const [id, requirement] of Object.entries(ledger.requirements)) {
    object(requirement, `requirement ${id}`);
    revision(requirement.workRevision, `requirement ${id} workRevision`);
  }
  return ledger;
}

function actionRevision(action, requirementId) {
  if (action.inspectedRevisions !== undefined) {
    object(action.inspectedRevisions, 'inspectedRevisions');
    if (!(requirementId in action.inspectedRevisions)) fail(`missing inspected revision for ${requirementId}`);
    return revision(action.inspectedRevisions[requirementId], `inspectedRevisions.${requirementId}`);
  }
  return revision(action.inspectedRevision ?? action.workRevision, 'inspectedRevision');
}

function evidenceRecord(action, requirementId, result) {
  object(action, 'evidence action');
  const actionId = nonEmptyString(action.actionId ?? action.sourceAction, 'source action');
  const inspectedRevision = actionRevision(action, requirementId);
  const eventSequence = sequence(action.eventSequence);
  const schemaVersion = action.schemaVersion ?? LEDGER_SCHEMA_VERSION;
  nonEmptyString(schemaVersion, 'schemaVersion');
  if (!Array.isArray(action.evidenceFor)) fail('evidenceFor must be an array');
  const status = result?.status;
  if (!STATUS_SET.has(status)) fail(`evidence status must be one of ${REQUIREMENT_STATUS_VALUES.join(', ')}`);
  if (!Array.isArray(result.evidence ?? [])) fail('evidence must be an array');
  if (!Array.isArray(result.concerns ?? [])) fail('concerns must be an array');
  if (result.mechanicalFailure !== undefined && status !== REQUIREMENT_STATUSES.PENDING) fail('mechanicalFailure requires pending status');
  if (status === REQUIREMENT_STATUSES.PENDING && result.mechanicalFailure === undefined) fail('pending evidence requires mechanicalFailure');
  return {
    sourceAction: actionId,
    inspectedRevision,
    eventSequence,
    schemaVersion,
    requirementId,
    status,
    evidence: clone(result.evidence ?? []),
    concerns: clone(result.concerns ?? []),
    stale: false,
    ...(result.mechanicalFailure !== undefined ? { mechanicalFailure: mechanicalFailure(result.mechanicalFailure) } : {}),
  };
}

function freshRecords(ledger, id) {
  const requirement = ledger.requirements[id];
  if (!requirement) fail(`unknown requirement ${id}`);
  return ledger.evidence.filter((record) => record.requirementId === id && !record.stale && record.inspectedRevision === requirement.workRevision);
}

export function resolveRequirement(ledger, requirementId) {
  normalizeLedger(ledger);
  const id = nonEmptyString(requirementId, 'requirementId');
  const latestBySource = new Map();
  for (const record of freshRecords(ledger, id)) {
    const latest = latestBySource.get(record.sourceAction);
    if (!latest || record.eventSequence > latest.eventSequence) latestBySource.set(record.sourceAction, record);
  }
  let records = [...latestBySource.values()];
  const semanticRecords = records.filter((record) => record.status !== REQUIREMENT_STATUSES.PENDING);
  if (semanticRecords.length) records = semanticRecords;
  if (!records.length) return REQUIREMENT_STATUSES.PENDING;
  const statuses = new Set(records.map((record) => record.status));
  if (statuses.size > 1) return REQUIREMENT_STATUSES.BLOCKED;
  return records[0].status;
}

export function applyEvidence(ledger, action, envelope) {
  normalizeLedger(ledger);
  object(action, 'evidence action');
  object(envelope, 'evidence envelope');
  if (!Array.isArray(action.evidenceFor)) fail('evidenceFor must be an array');
  const declared = new Set();
  for (const id of action.evidenceFor) {
    nonEmptyString(id, 'evidenceFor entry');
    if (declared.has(id)) fail(`duplicate evidenceFor entry ${id}`);
    declared.add(id);
  }
  const results = envelope.requirements ?? envelope;
  object(results, 'requirements evidence');
  const records = [];
  for (const [id, result] of Object.entries(results)) {
    if (!declared.has(id)) fail(`evidence for ${id} was not declared by evidenceFor`);
    if (!ledger.requirements[id]) fail(`unknown requirement ${id}`);
    records.push(evidenceRecord(action, id, result));
  }
  for (const id of declared) if (!(id in results)) fail(`evidence for ${id} was not provided`);
  const lastSequence = ledger.evidence.reduce((max, record) => Math.max(max, record.eventSequence), -1);
  if (sequence(action.eventSequence) <= lastSequence) fail('eventSequence must be greater than existing evidence');
  const next = clone(ledger);
  for (const record of records) {
    const { requirementId: id } = record;
    next.evidence.push(record);
    next.requirements[id].evidence.push(record);
    next.requirements[id].status = resolveRequirement(next, id);
  }
  return next;
}

export function invalidateRequirements(ledger, affects, nextWorkRevision) {
  normalizeLedger(ledger);
  if (!Array.isArray(affects)) fail('affects must be an array');
  if (nextWorkRevision === undefined) fail('nextWorkRevision is required');
  if (!affects.length) fail('affects must name at least one requirement');
  const nextRevision = revision(nextWorkRevision, 'nextWorkRevision');
  const affected = new Set();
  const next = clone(ledger);
  if (nextRevision === next.workRevision) fail('nextWorkRevision must differ from current workRevision');
  for (const id of affects) {
    nonEmptyString(id, 'affected requirement');
    if (affected.has(id)) fail(`duplicate affected requirement ${id}`);
    affected.add(id);
    if (!next.requirements[id]) fail(`unknown requirement ${id}`);
    if (next.requirements[id].workRevision === nextRevision) fail(`nextWorkRevision must differ for ${id}`);
    for (const record of next.evidence) if (record.requirementId === id) record.stale = true;
    next.requirements[id].evidence = next.evidence.filter((record) => record.requirementId === id);
    next.requirements[id].workRevision = nextRevision;
    next.requirements[id].status = REQUIREMENT_STATUSES.PENDING;
  }
  next.workRevision = nextRevision;
  return next;
}

export function serializeLedger(ledger) {
  validateStoredLedger(ledger);
  return JSON.stringify(ledger);
}

function validateStoredLedger(ledger) {
  normalizeLedger(ledger);
  const recordsByRequirement = new Map(Object.keys(ledger.requirements).map((id) => [id, []]));
  const seen = new Set();
  for (const record of ledger.evidence) {
    object(record, 'evidence record');
    nonEmptyString(record.sourceAction, 'evidence sourceAction');
    revision(record.inspectedRevision, 'evidence inspectedRevision');
    sequence(record.eventSequence);
    nonEmptyString(record.schemaVersion, 'evidence schemaVersion');
    nonEmptyString(record.requirementId, 'evidence requirementId');
    if (!recordsByRequirement.has(record.requirementId)) fail(`evidence for unknown requirement ${record.requirementId}`);
    if (!STATUS_SET.has(record.status)) fail(`invalid evidence status for ${record.requirementId}`);
    if (!Array.isArray(record.evidence) || !Array.isArray(record.concerns)) fail(`invalid evidence details for ${record.requirementId}`);
    if (record.mechanicalFailure !== undefined) {
      mechanicalFailure(record.mechanicalFailure);
      if (record.status !== REQUIREMENT_STATUSES.PENDING) fail(`mechanicalFailure requires pending status for ${record.requirementId}`);
    }
    if (typeof record.stale !== 'boolean') fail(`invalid stale flag for ${record.requirementId}`);
    if (record.currentRevision !== undefined) fail('evidence currentRevision is redundant');
    const key = `${record.sourceAction}\u0000${record.inspectedRevision}\u0000${record.eventSequence}\u0000${record.requirementId}`;
    if (seen.has(key)) fail(`duplicate evidence record for ${record.requirementId}`);
    seen.add(key);
    recordsByRequirement.get(record.requirementId).push(record);
  }
  for (let index = 1; index < ledger.evidence.length; index += 1) {
    if (ledger.evidence[index].eventSequence < ledger.evidence[index - 1].eventSequence) fail('evidence must be ordered by eventSequence');
  }
  for (const [id, requirement] of Object.entries(ledger.requirements)) {
    nonEmptyString(id, 'requirement id');
    if (requirement.id !== id || typeof requirement.mandatory !== 'boolean' || !STATUS_SET.has(requirement.status) || !Array.isArray(requirement.evidence)) fail(`invalid requirement ${id}`);
    revision(requirement.workRevision, `requirement ${id} workRevision`);
    const expected = recordsByRequirement.get(id);
    if (requirement.evidence.length !== expected.length || requirement.evidence.some((record, index) => JSON.stringify(record) !== JSON.stringify(expected[index]))) fail(`inconsistent evidence for requirement ${id}`);
    const computed = resolveRequirement(ledger, id);
    if (requirement.status !== computed) fail(`inconsistent status for requirement ${id}`);
  }
  return ledger;
}

export function deserializeLedger(serialized) {
  if (typeof serialized !== 'string') fail('serialized ledger must be a string');
  let ledger;
  try { ledger = JSON.parse(serialized); } catch { fail('serialized ledger must be valid JSON'); }
  validateStoredLedger(ledger);
  return clone(ledger);
}
