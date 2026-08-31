import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVIDENCE_CONTRACT_SCHEMA_VERSION,
  EVIDENCE_OUTPUT_SCHEMA_VERSION,
  buildEvidencePreflight,
  validateEvidenceContract,
  validateEvidenceOutput,
} from '../src/workflow/evidence-output.js';

const CHECKER = new URL('../bin/check-v2-evidence.js', import.meta.url).pathname;
const contract = (evidenceFor = ['result']) => ({ schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor });
const value = (over = {}) => ({
  schemaVersion: EVIDENCE_OUTPUT_SCHEMA_VERSION,
  requirements: { result: { status: 'passed', evidence: ['tests passed'], concerns: [] } },
  ...over,
});

test('accepts the exact V2 envelope and defensively normalizes it', () => {
  const input = value();
  const result = validateEvidenceOutput(input, contract());
  assert.deepEqual(result, { ok: true, errors: [], value: input });
  input.requirements.result.evidence[0] = 'changed';
  assert.equal(result.value.requirements.result.evidence[0], 'tests passed');
});

test('requires exact coverage, own fields, substantive evidence, and string concerns', () => {
  for (const candidate of [
    value({ requirements: {} }),
    value({ requirements: { result: { status: 'pending', evidence: ['x'], concerns: [] } } }),
    value({ requirements: { result: { status: 'passed', evidence: ['   '], concerns: [] } } }),
    value({ requirements: { result: { status: 'passed', evidence: [], concerns: [] } } }),
    value({ requirements: { result: { status: 'passed', evidence: ['x'], concerns: [3] } } }),
    value({ requirements: { result: { status: 'passed', evidence: ['x'], concerns: [], inherited: true } } }),
    value({ requirements: { result: { status: 'passed', evidence: ['x'], concerns: [] }, extra: { status: 'passed', evidence: ['x'], concerns: [] } } }),
    { ok: true, concerns: [], summary: 'old shape' },
  ]) assert.equal(validateEvidenceOutput(candidate, contract()).ok, false);
});

test('rejects malformed and duplicate contract declarations', () => {
  assert.equal(validateEvidenceContract({ schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor: ['result', 'result'] }).ok, false);
  assert.equal(validateEvidenceContract({ schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor: [] }).ok, false);
  assert.equal(validateEvidenceContract({ schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION, evidenceFor: ['constructor'] }).ok, false);
  assert.equal(validateEvidenceOutput(value(), { schemaVersion: 'old', evidenceFor: ['result'] }).ok, false);
});

test('rejects inherited fields at every object boundary', () => {
  const inheritedEnvelope = Object.assign(Object.create({ old: true }), value());
  assert.equal(validateEvidenceOutput(inheritedEnvelope, contract()).ok, false);
  const inheritedResult = Object.assign(Object.create({ old: true }), value().requirements.result);
  assert.equal(validateEvidenceOutput(value({ requirements: { result: inheritedResult } }), contract()).ok, false);
  const inheritedRequirements = Object.assign(Object.create({ old: true }), value().requirements);
  assert.equal(validateEvidenceOutput(value({ requirements: inheritedRequirements }), contract()).ok, false);
});

test('preflight is shell-safe and requires repeated validation', () => {
  const text = buildEvidencePreflight('/tmp/$HOME/a path/contract.json', "/tmp/check's v2.js");
  assert.match(text, /--contract '\/tmp\/\$HOME\/a path\/contract\.json'/);
  assert.match(text, /check'"'"'s v2\.js/);
  assert.match(text, /--value \"\$candidate_file\"/);
  assert.match(text, /rerun until it exits zero/);
});

test('CLI returns deterministic statuses for valid, invalid, malformed, and usage input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-evidence-check-'));
  try {
    const contractPath = join(dir, 'contract.json');
    const valuePath = join(dir, 'value.json');
    writeFileSync(contractPath, JSON.stringify(contract()));
    writeFileSync(valuePath, JSON.stringify(value()));
    const valid = spawnSync(process.execPath, [CHECKER, '--contract', contractPath, '--value', valuePath], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { ok: true, errors: [] });
    writeFileSync(valuePath, JSON.stringify({ ...value(), requirements: {} }));
    const invalid = spawnSync(process.execPath, [CHECKER, '--contract', contractPath, '--value', valuePath], { encoding: 'utf8' });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
    writeFileSync(valuePath, '{');
    const malformed = spawnSync(process.execPath, [CHECKER, '--contract', contractPath, '--value', valuePath], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stdout).ok, false);
    const usage = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
