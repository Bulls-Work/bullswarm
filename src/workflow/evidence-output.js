import { fileURLToPath } from 'node:url';

// The V2 evidence boundary is deliberately narrower than the ledger's
// historical input shape. Agents may report semantic results only; pending is
// reserved for the kernel when a mechanical action fails.

export const EVIDENCE_OUTPUT_SCHEMA_VERSION = 'bullswarm.workflow.evidence.v2';
export const EVIDENCE_CONTRACT_SCHEMA_VERSION = 'bullswarm.workflow.evidence.contract.v2';
export const EVIDENCE_STATUS_VALUES = Object.freeze(['passed', 'failed', 'blocked']);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENVELOPE_FIELDS = new Set(['schemaVersion', 'requirements']);
const RESULT_FIELDS = new Set(['status', 'evidence', 'concerns']);
const CONTRACT_FIELDS = new Set(['schemaVersion', 'evidenceFor']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = (value) => isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => Object.hasOwn(value, key);
const clone = (value) => {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
};

function unknownFields(value, allowed, path, errors) {
  if (!isObject(value)) return;
  if (!isPlainObject(value)) errors.push(`${path} must not contain inherited fields`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
}

function strings(value, path, errors, { substantive = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const result = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || (substantive && !item.trim())) {
      errors.push(`${path}[${index}] must be a ${substantive ? 'substantive ' : ''}string`);
    } else result.push(item);
  }
  return result;
}

function contractIds(contract, errors) {
  if (!isObject(contract)) {
    errors.push('contract must be an object');
    return [];
  }
  unknownFields(contract, CONTRACT_FIELDS, 'contract', errors);
  if (contract.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION) {
    errors.push(`contract.schemaVersion must be "${EVIDENCE_CONTRACT_SCHEMA_VERSION}"`);
  }
  if (!Array.isArray(contract.evidenceFor)) {
    errors.push('contract.evidenceFor must be an array');
    return [];
  }
  if (contract.evidenceFor.length === 0) errors.push('contract.evidenceFor must not be empty');
  const seen = new Set();
  const ids = [];
  for (const [index, id] of contract.evidenceFor.entries()) {
    if (typeof id !== 'string' || !ID_RE.test(id) || DANGEROUS_KEYS.has(id)) {
      errors.push(`contract.evidenceFor[${index}] must be a valid ID`);
    } else if (seen.has(id)) {
      errors.push(`contract.evidenceFor contains duplicate "${id}"`);
    } else {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function validateEvidenceContract(contract) {
  const errors = [];
  const evidenceFor = contractIds(contract, errors);
  return errors.length ? { ok: false, errors } : {
    ok: true,
    errors: [],
    value: { schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor: [...evidenceFor] },
  };
}

export function validateEvidenceOutput(envelope, contract) {
  const errors = [];
  const contractValidity = validateEvidenceContract(contract);
  if (!contractValidity.ok) errors.push(...contractValidity.errors);
  const evidenceFor = contractValidity.value?.evidenceFor ?? [];

  if (!isObject(envelope)) {
    errors.push('value must be an object');
    return { ok: false, errors };
  }
  unknownFields(envelope, ENVELOPE_FIELDS, 'value', errors);
  if (envelope.schemaVersion !== EVIDENCE_OUTPUT_SCHEMA_VERSION) {
    errors.push(`value.schemaVersion must be "${EVIDENCE_OUTPUT_SCHEMA_VERSION}"`);
  }
  if (!isObject(envelope.requirements)) {
    errors.push('value.requirements must be an object');
    return { ok: false, errors };
  }
  if (!isPlainObject(envelope.requirements)) errors.push('value.requirements must not contain inherited fields');

  const expected = new Set(evidenceFor);
  for (const id of Object.keys(envelope.requirements)) {
    if (!expected.has(id)) errors.push(`value.requirements.${id} is not declared by evidenceFor`);
  }
  for (const id of evidenceFor) if (!own(envelope.requirements, id)) errors.push(`value.requirements.${id} is required`);

  const normalizedEntries = [];
  for (const id of evidenceFor) {
    if (!own(envelope.requirements, id)) continue;
    const result = envelope.requirements[id];
    const path = `value.requirements.${id}`;
    if (!isObject(result)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    unknownFields(result, RESULT_FIELDS, path, errors);
    if (!EVIDENCE_STATUS_VALUES.includes(result.status)) {
      errors.push(`${path}.status must be passed|failed|blocked`);
    }
    const evidence = strings(result.evidence, `${path}.evidence`, errors, { substantive: true });
    if (Array.isArray(result.evidence) && result.evidence.length === 0) errors.push(`${path}.evidence must not be empty`);
    const concerns = strings(result.concerns, `${path}.concerns`, errors);
    normalizedEntries.push([id, { status: result.status, evidence: [...evidence], concerns: [...concerns] }]);
  }
  const normalizedRequirements = Object.fromEntries(normalizedEntries);
  return errors.length ? { ok: false, errors } : {
    ok: true,
    errors: [],
    value: { schemaVersion: EVIDENCE_OUTPUT_SCHEMA_VERSION, requirements: clone(normalizedRequirements) },
  };
}

export const validateV2EvidenceOutput = validateEvidenceOutput;
export const validateEvidenceEnvelope = validateEvidenceOutput;

export function parseEvidenceOutput(text, contract) {
  const source = String(text ?? '').trim();
  const ends = source.endsWith('```') ? source.slice(0, -3).trimEnd() : source;
  const errors = [];
  for (let index = 0; index < ends.length; index += 1) {
    if (ends[index] !== '{') continue;
    try {
      const candidate = JSON.parse(ends.slice(index));
      const checked = validateEvidenceOutput(candidate, contract);
      if (checked.ok) return checked;
      errors.push(...checked.errors);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: false, errors: errors.length ? [...new Set(errors)] : ['response did not contain a trailing JSON object'] };
}

export function buildEvidencePreflight(contractPath, checkerPath = null) {
  if (typeof contractPath !== 'string' || !contractPath) throw new TypeError('contractPath must be a non-empty string');
  const checker = checkerPath ?? fileURLToPath(new URL('../../bin/check-v2-evidence.js', import.meta.url));
  const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(checker)} --contract ${shellQuote(contractPath)} --value "$candidate_file"`;
  return [
    'MANDATORY V2 EVIDENCE PREFLIGHT before replying:',
    '1. Write only your evidence envelope JSON to a temporary file: candidate_file=$(mktemp)',
    `2. Run: ${command}`,
    '3. If it exits non-zero, fix the candidate and rerun until it exits zero.',
    '4. End your response with the exact validated evidence envelope, then remove the temporary file.',
  ].join('\n');
}

export const evidenceOutputPreflight = buildEvidencePreflight;
