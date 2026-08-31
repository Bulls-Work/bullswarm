import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEDGER_SCHEMA_VERSION,
  REQUIREMENT_STATUSES,
  applyEvidence,
  createLedger,
  deserializeLedger,
  invalidateRequirements,
  resolveRequirement,
  serializeLedger,
} from '../src/workflow/ledger.js';

const action = (overrides = {}) => ({
  actionId: 'check-1', evidenceFor: ['quality'], inspectedRevision: 'r1', eventSequence: 1,
  ...overrides,
});
const pass = (overrides = {}) => ({ status: 'passed', evidence: ['check passed'], concerns: [], ...overrides });

test('creates a deterministic pending V2 ledger', () => {
  const ledger = createLedger([{ id: 'quality' }, { id: 'optional', mandatory: false }], { workRevision: 'r1' });
  assert.deepEqual(ledger, {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    workRevision: 'r1',
    requirements: {
      quality: { id: 'quality', mandatory: true, workRevision: 'r1', status: 'pending', evidence: [] },
      optional: { id: 'optional', mandatory: false, workRevision: 'r1', status: 'pending', evidence: [] },
    },
    evidence: [],
  });
});

test('applies scoped pass, fail, and blocked evidence', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action(), { requirements: { quality: pass() } });
  assert.equal(resolveRequirement(ledger, 'quality'), REQUIREMENT_STATUSES.PASSED);
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', evidenceFor: ['quality'], eventSequence: 2 }), { requirements: { quality: pass({ status: 'failed' }) } });
  assert.equal(resolveRequirement(ledger, 'quality'), 'blocked');
  assert.equal(ledger.evidence.length, 2);
});

test('concerns do not turn a pass into failure and preserves evidence metadata', () => {
  const ledger = applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { quality: pass({ concerns: ['slow test'] }) } });
  assert.equal(ledger.requirements.quality.status, 'passed');
  assert.deepEqual(ledger.evidence[0].concerns, ['slow test']);
  assert.equal(ledger.evidence[0].sourceAction, 'check-1');
  assert.equal(ledger.evidence[0].inspectedRevision, 'r1');
  assert.equal(ledger.evidence[0].eventSequence, 1);
  assert.equal(ledger.evidence[0].schemaVersion, LEDGER_SCHEMA_VERSION);
});

test('mechanical evidence failure records pending evidence without failing requirement', () => {
  const ledger = applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { quality: { status: 'pending', mechanicalFailure: { kind: 'provider', message: 'provider unavailable' } } } });
  assert.equal(ledger.requirements.quality.status, 'pending');
  assert.deepEqual(ledger.evidence[0].mechanicalFailure, { kind: 'provider', message: 'provider unavailable' });
});

test('mechanical pending evidence does not conflict with a semantic judgment', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action({ actionId: 'provider', eventSequence: 1 }), { requirements: { quality: { status: 'pending', mechanicalFailure: { kind: 'provider' } } } });
  ledger = applyEvidence(ledger, action({ actionId: 'reviewer', eventSequence: 2 }), { requirements: { quality: pass() } });
  assert.equal(resolveRequirement(ledger, 'quality'), REQUIREMENT_STATUSES.PASSED);
});

test('rejects invalid evidence scope and input', () => {
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { other: pass() } }), /not declared/);
  assert.throws(() => createLedger([{ id: '' }], { workRevision: 'r1' }), /non-empty/);
  assert.throws(() => deserializeLedger('{bad'), /valid JSON/);
  assert.throws(() => createLedger([{ id: 'quality' }, { id: 'quality' }], { workRevision: 'r1' }), /duplicate requirement id/);
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action({ evidenceFor: ['quality', 'quality'] }), { requirements: { quality: pass() } }), /duplicate evidenceFor/);
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action({ evidenceFor: [1] }), { requirements: { quality: pass() } }), /evidenceFor entry/);
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action({ evidenceFor: [] }), { requirements: { quality: pass() } }), /not declared/);
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }, { id: 'coverage' }], { workRevision: 'r1' }), action({ evidenceFor: ['quality', 'coverage'] }), { requirements: { quality: pass() } }), /was not provided/);
  assert.throws(() => createLedger([{ id: 'quality' }]), /workRevision/);
  assert.throws(() => createLedger([{ id: 'quality', workRevision: '' }], { workRevision: 'r1' }), /quality workRevision/);
  assert.throws(() => applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { quality: { status: 'pending' } } }), /requires mechanicalFailure/);
});

test('invalidates affected evidence, retains history, and accepts newer revision', () => {
  let ledger = applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { quality: pass() } });
  ledger = invalidateRequirements(ledger, ['quality'], 'r2');
  assert.equal(ledger.requirements.quality.status, 'pending');
  assert.equal(ledger.evidence[0].stale, true);
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', inspectedRevision: 'r2', eventSequence: 2 }), { requirements: { quality: pass() } });
  assert.equal(ledger.requirements.quality.status, 'passed');
});

test('invalidates requirements independently and supports per-requirement revisions', () => {
  let ledger = createLedger([{ id: 'quality' }, { id: 'coverage' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action({ evidenceFor: ['quality', 'coverage'] }), { requirements: { quality: pass(), coverage: pass() } });
  ledger = invalidateRequirements(ledger, ['quality'], 'r2');
  assert.equal(resolveRequirement(ledger, 'quality'), REQUIREMENT_STATUSES.PENDING);
  assert.equal(resolveRequirement(ledger, 'coverage'), REQUIREMENT_STATUSES.PASSED);
  ledger = applyEvidence(ledger, action({ actionId: 'mixed', evidenceFor: ['quality', 'coverage'], inspectedRevisions: { quality: 'r2', coverage: 'r1' }, eventSequence: 2 }), { requirements: { quality: pass(), coverage: pass() } });
  assert.equal(resolveRequirement(ledger, 'quality'), REQUIREMENT_STATUSES.PASSED);
  assert.equal(resolveRequirement(ledger, 'coverage'), REQUIREMENT_STATUSES.PASSED);
});

test('invalidation requires a distinct revision and unique affected IDs', () => {
  const ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  assert.throws(() => invalidateRequirements(ledger, [], 'r2'), /at least one/);
  assert.throws(() => invalidateRequirements(ledger, ['quality'], 'r1'), /differ/);
  assert.throws(() => invalidateRequirements(ledger, ['quality', 'quality'], 'r2'), /duplicate affected/);
  assert.throws(() => invalidateRequirements(ledger, [], undefined), /required/);
});

test('same-revision conflicting evidence blocks and JSON round-trips stably', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action(), { requirements: { quality: pass() } });
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', eventSequence: 2 }), { requirements: { quality: pass({ status: 'failed' }) } });
  assert.equal(ledger.requirements.quality.status, 'blocked');
  const serialized = serializeLedger(ledger);
  assert.equal(serializeLedger(deserializeLedger(serialized)), serialized);
});

test('latest evidence from one source supersedes its earlier judgment', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action(), { requirements: { quality: pass({ status: 'failed' }) } });
  ledger = applyEvidence(ledger, action({ eventSequence: 2 }), { requirements: { quality: pass() } });
  assert.equal(resolveRequirement(ledger, 'quality'), 'passed');
});

test('different sources conflict using only each source latest record', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action(), { requirements: { quality: pass({ status: 'failed' }) } });
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', eventSequence: 2 }), { requirements: { quality: pass() } });
  ledger = applyEvidence(ledger, action({ actionId: 'check-1', eventSequence: 3 }), { requirements: { quality: pass() } });
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', eventSequence: 4 }), { requirements: { quality: pass({ status: 'failed' }) } });
  assert.equal(resolveRequirement(ledger, 'quality'), 'blocked');
});

test('deserialization rejects forged structure, evidence links, and status', () => {
  const ledger = applyEvidence(createLedger([{ id: 'quality' }], { workRevision: 'r1' }), action(), { requirements: { quality: pass() } });
  const cases = [
    { ...ledger, workRevision: null },
    { ...ledger, evidence: [{ ...ledger.evidence[0], eventSequence: -1 }] },
    { ...ledger, requirements: { quality: { ...ledger.requirements.quality, status: 'failed' } } },
    { ...ledger, requirements: { quality: { ...ledger.requirements.quality, evidence: [] } } },
    { ...ledger, evidence: [{ ...ledger.evidence[0], currentRevision: 'r1' }] },
  ];
  for (const candidate of cases) assert.throws(() => deserializeLedger(JSON.stringify(candidate)));
});

test('serialization performs the same consistency validation and rejects unordered evidence', () => {
  let ledger = createLedger([{ id: 'quality' }], { workRevision: 'r1' });
  ledger = applyEvidence(ledger, action({ eventSequence: 1 }), { requirements: { quality: pass() } });
  ledger = applyEvidence(ledger, action({ actionId: 'check-2', eventSequence: 2 }), { requirements: { quality: pass() } });
  const unordered = { ...ledger, evidence: [ledger.evidence[1], ledger.evidence[0]] };
  assert.throws(() => serializeLedger(unordered), /ordered/);
  assert.throws(() => applyEvidence(ledger, action({ actionId: 'check-3', eventSequence: 2 }), { requirements: { quality: pass() } }), /greater/);
});

test('multi-requirement evidence is atomic when a later entry is invalid', () => {
  const ledger = createLedger([{ id: 'quality' }, { id: 'coverage' }], { workRevision: 'r1' });
  assert.throws(() => applyEvidence(ledger, action({ evidenceFor: ['quality', 'coverage'] }), { requirements: { quality: pass(), coverage: { status: 'not-a-status' } } }));
  assert.deepEqual(ledger.evidence, []);
  assert.equal(ledger.requirements.quality.status, 'pending');
});
