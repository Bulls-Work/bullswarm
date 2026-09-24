// Stage-2 proof labels (E22, E23, §2.8, §2.10): what backs each finished
// step, the summary's proof rows and top-level count, the end-of-run line, and
// the rule that saved runs without the `proofLabels` marker read as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROOF_TYPES, deserializeV2ResultEnvelope, formatV2HandbackLines, formatV2ProofLabel, formatV2ProofLine,
  stepProof, summarizeV2Result,
} from '../src/workflow/v2-outcome.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME_351 = join(ROOT, 'tests', 'fixtures', 'home-351');
const MARKED = { deliverableGate: 1, proofLabels: 1 };

const passedItem = (type) => (type === 'command'
  ? { type: 'command', cmd: 'npm test', status: 'passed', exit: 0, durationMs: 10, tail: '', log: '/runs/acme/evidence-a-attempt-1-1.log', why: null }
  : { type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', status: 'passed', exit: 0, durationMs: 5, tail: '', log: '/runs/acme/evidence-a-attempt-1-2.log', why: null });

// A small program: `build` writes, `review` checks requirement-1 and -2.
function programState({
  definition = {}, status = 'succeeded', evidenceResults, requirements = { 'requirement-1': 'pending', 'requirement-2': 'pending' },
  reviewers = [{ id: 'review', evidenceFor: ['requirement-1', 'requirement-2'] }], reviewerStatus = 'pending',
} = {}) {
  const build = { id: 'build', purpose: 'build it', kind: 'implement', affects: [], evidenceFor: [], ...definition };
  return {
    program: { actions: [build, ...reviewers.map((entry) => ({ purpose: 'check it', kind: 'adversarial-acceptance', affects: [], ...entry }))] },
    actions: [{ id: 'build', status }, ...reviewers.map((entry) => ({ id: entry.id, status: reviewerStatus }))],
    attempts: [{ id: 'build-1', actionId: 'build', status: status === 'succeeded' ? 'succeeded' : 'failed', ...(evidenceResults ? { evidenceResults } : {}) }],
    ledger: { requirements: Object.fromEntries(Object.entries(requirements).map(([id, value]) => [id, { id, status: value, mandatory: true }])) },
  };
}

test('stepProof: the passed evidence types in order, then review, and whether a review is still pending', () => {
  const both = [passedItem('schema'), passedItem('command')];
  const cases = [
    ['command', { evidenceResults: [passedItem('command')] }, { by: ['command'], reviewPending: false }],
    ['schema', { evidenceResults: [passedItem('schema')] }, { by: ['schema'], reviewPending: false }],
    ['both, listed command first whatever the declared order', { evidenceResults: both }, { by: ['command', 'schema'], reviewPending: false }],
    ['review', { definition: { affects: ['requirement-1'] }, requirements: { 'requirement-1': 'passed' } }, { by: ['review'], reviewPending: false }],
    ['review pending', { definition: { affects: ['requirement-1', 'requirement-2'] }, requirements: { 'requirement-1': 'passed', 'requirement-2': 'pending' } }, { by: [], reviewPending: true }],
    ['both with review pending', { definition: { affects: ['requirement-2'] }, evidenceResults: both }, { by: ['command', 'schema'], reviewPending: true }],
    ['unproven', {}, { by: [], reviewPending: false }],
  ];
  for (const [name, options, expected] of cases) {
    assert.deepEqual(stepProof(programState(options), programState(options).program.actions[0], { atFinish: true }), expected, name);
  }
  // A failed or not-run item proves nothing.
  const failed = { ...passedItem('command'), status: 'failed', exit: 1, why: 'exit 1' };
  assert.deepEqual(stepProof(programState({ evidenceResults: [failed, passedItem('schema')] }), programState().program.actions[0]), { by: ['schema'], reviewPending: false });
  // Only a live review step can be pending: a removed one, or one that checks
  // just part of what the step affects, leaves it unproven.
  const partial = programState({ definition: { affects: ['requirement-1', 'requirement-3'] }, requirements: { 'requirement-1': 'pending', 'requirement-3': 'pending' } });
  assert.deepEqual(stepProof(partial, partial.program.actions[0], { atFinish: true }), { by: [], reviewPending: false });
  const removed = programState({ definition: { affects: ['requirement-1'] }, reviewerStatus: 'removed' });
  assert.deepEqual(stepProof(removed, removed.program.actions[0], { atFinish: true }), { by: [], reviewPending: false });
  // Pending is a fact of the moment the step finishes; the end of the run
  // reads only what backs it.
  const later = programState({ definition: { affects: ['requirement-1'] } });
  assert.deepEqual(stepProof(later, later.program.actions[0]), { by: [], reviewPending: false });
  assert.deepEqual(PROOF_TYPES, ['command', 'schema', 'review']);
});

test('stepProof: review and digest steps, and steps that did not succeed, get no label', () => {
  const state = programState({ reviewerStatus: 'succeeded' });
  assert.equal(stepProof(state, state.program.actions[1]), null, 'a review step');
  const digest = programState({ definition: { kind: 'digest' } });
  assert.equal(stepProof(digest, digest.program.actions[0]), null, 'a digest step');
  const failed = programState({ status: 'failed', evidenceResults: [passedItem('command')] });
  assert.equal(stepProof(failed, failed.program.actions[0]), null, 'a failed step');
  assert.equal(stepProof(state, null), null);
});

test('stepProof: the marker gates steps without evidence; a step that declares evidence is always labelled', () => {
  const plain = programState();
  assert.equal(stepProof(plain, plain.program.actions[0], { features: {} }), null);
  assert.equal(stepProof(plain, plain.program.actions[0], { features: { deliverableGate: 1 } }), null, 'a stage-1 marker');
  assert.equal(stepProof(plain, plain.program.actions[0], { features: { deliverableGate: 1, proofLabels: 2 } }), null, 'only the value 1 counts');
  assert.deepEqual(stepProof(plain, plain.program.actions[0], { features: MARKED }), { by: [], reviewPending: false });
  const declared = programState({ definition: { evidence: [{ type: 'command', cmd: 'npm test' }] }, evidenceResults: [passedItem('command')] });
  assert.deepEqual(stepProof(declared, declared.program.actions[0], { features: {} }), { by: ['command'], reviewPending: false });
  // Without `features` the caller has already applied the gate.
  assert.deepEqual(stepProof(plain, plain.program.actions[0]), { by: [], reviewPending: false });
});

test('formatV2ProofLabel: the words after `finished` on a step line', () => {
  assert.equal(formatV2ProofLabel({ by: ['command'], reviewPending: false }), 'proven by command');
  assert.equal(formatV2ProofLabel({ by: ['command', 'schema'], reviewPending: false }), 'proven by command, schema');
  assert.equal(formatV2ProofLabel({ by: ['command'], reviewPending: true }), 'proven by command · review pending');
  assert.equal(formatV2ProofLabel({ by: [], reviewPending: true }), 'review pending');
  assert.equal(formatV2ProofLabel({ by: [], reviewPending: false }), 'unproven');
  assert.equal(formatV2ProofLabel(null), null);
  assert.equal(formatV2ProofLabel(undefined), null);
});

test('formatV2ProofLine: every §2.10 form, the singular, and the `and N more` cut', () => {
  const line = (proof) => formatV2ProofLine({ proof });
  assert.equal(line({ proven: 4, byType: { command: 3, schema: 1, review: 1 }, unproven: 1, unprovenSteps: ['readme'] }),
    'proof: 4 steps proven (command 3, schema 1, review 1) · 1 finished · unproven: readme');
  assert.equal(line({ proven: 4, byType: { command: 3, schema: 1, review: 0 }, unproven: 0, unprovenSteps: [] }),
    'proof: 4 steps proven (command 3, schema 1)');
  assert.equal(line({ proven: 0, byType: { command: 0, schema: 0, review: 0 }, unproven: 3, unprovenSteps: ['a', 'b', 'c'] }),
    'proof: 3 finished · unproven: a, b, c');
  assert.equal(line({ proven: 1, byType: { command: 1, schema: 0, review: 0 }, unproven: 0, unprovenSteps: [] }),
    'proof: 1 step proven (command 1)');
  assert.equal(line({ proven: 0, byType: { command: 0, schema: 0, review: 0 }, unproven: 7, unprovenSteps: ['a', 'b', 'c', 'd'] }),
    'proof: 7 finished · unproven: a, b, c, d and 3 more');
  assert.equal(formatV2ProofLine({}), null, 'no row carries a proof');
  assert.equal(formatV2ProofLine(null), null);
});

// A minimal completed program envelope; the summariser reads it without the
// full validator.
function envelopeFor(state, { outDir = '/runs/acme' } = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.result.v2', runId: 'wf-acme-000001', shortId: 'acme01', intentId: 'intent-acme',
    goal: 'ship the acme widget', status: 'completed', verified: true, executionMode: 'program', reason: 'all steps succeeded',
    requirements: [],
    actions: state.program.actions.map((definition) => ({
      id: definition.id, purpose: definition.purpose, status: state.actions.find((entry) => entry.id === definition.id).status,
      outputFile: `${outDir}/out-${definition.id}-attempt-1.md`, artifactIds: [], kind: definition.kind ?? null,
    })),
    gaps: null, usage: { total: 0, byPool: {} }, finishedAt: '2026-09-24T00:00:00.000Z',
  };
}

function manySteps(count, { declare = () => false } = {}) {
  const program = { actions: [] };
  const actions = [];
  const attempts = [];
  for (let index = 0; index < count; index += 1) {
    const id = `step-${String(index).padStart(2, '0')}`;
    const evidence = declare(index) ? [{ type: 'command', cmd: 'npm test' }] : undefined;
    program.actions.push({ id, purpose: `part ${index}`, kind: 'implement', lane: 'build', effort: 'medium', affects: [], evidenceFor: [], ...(evidence ? { evidence } : {}) });
    actions.push({ id, status: 'succeeded' });
    attempts.push({
      id: `${id}-1`, actionId: id, status: 'succeeded', pool: 'example-pool', model: 'example-model', wallSec: 60,
      bytes: { taskFile: 1000, authorPrompt: 200, kernel: 800, dependencyInputs: 0, output: 300 },
      ...(evidence ? { evidenceResults: [passedItem('command')] } : {}),
    });
  }
  return { program, actions, attempts, ledger: { requirements: {} } };
}

test('summary gating: with the marker every eligible row has proof; without it only evidence steps do', () => {
  const state = manySteps(4, { declare: (index) => index === 1 });
  state.program.actions.push({ id: 'review', purpose: 'check', kind: 'adversarial-acceptance', affects: [], evidenceFor: ['requirement-1'] });
  state.actions.push({ id: 'review', status: 'succeeded' });
  state.program.actions.push({ id: 'broken', purpose: 'fails', kind: 'implement', affects: [], evidenceFor: [] });
  state.actions.push({ id: 'broken', status: 'failed' });
  const envelope = envelopeFor(state);

  const marked = summarizeV2Result(envelope, state, { features: MARKED });
  assert.deepEqual(marked.actions.map((row) => [row.id, row.proof]), [
    ['step-00', []], ['step-01', ['command']], ['step-02', []], ['step-03', []], ['review', undefined], ['broken', undefined],
  ]);
  assert.deepEqual(marked.proof, { proven: 1, byType: { command: 1, schema: 0, review: 0 }, unproven: 3, unprovenSteps: ['step-00', 'step-02', 'step-03'] });
  assert.equal(formatV2ProofLine(marked), 'proof: 1 step proven (command 1) · 3 finished · unproven: step-00, step-02, step-03');

  const unmarked = summarizeV2Result(envelope, state, { features: { deliverableGate: 1 } });
  assert.deepEqual(unmarked.actions.filter((row) => row.proof).map((row) => [row.id, row.proof]), [['step-01', ['command']]]);
  assert.deepEqual(unmarked.proof, { proven: 1, byType: { command: 1, schema: 0, review: 0 }, unproven: 0, unprovenSteps: [] });

  const none = summarizeV2Result(envelopeFor(manySteps(3)), manySteps(3), { features: {} });
  assert.equal(Object.hasOwn(none, 'proof'), false, 'no top-level proof when no row carries one');
  assert.equal(none.actions.some((row) => Object.hasOwn(row, 'proof')), false);
  assert.equal(formatV2ProofLine(none), null);
});

test('summary reads the marker from the run directory when the caller passes none', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'bs-proof-marker-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const state = manySteps(2);
  const envelope = envelopeFor(state, { outDir: runDir });
  assert.equal(Object.hasOwn(summarizeV2Result(envelope, state, { runDir }), 'proof'), false, 'no features.json');
  writeFileSync(join(runDir, 'features.json'), JSON.stringify({ deliverableGate: 1 }));
  assert.equal(Object.hasOwn(summarizeV2Result(envelope, state, { runDir }), 'proof'), false, 'a stage-1 marker');
  writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
  assert.equal(summarizeV2Result(envelope, state, { runDir }).proof.unproven, 2);
  // Without a runDir the directory comes from the output paths.
  assert.equal(summarizeV2Result(envelope, state).proof.unproven, 2);
  writeFileSync(join(runDir, 'features.json'), '{not json');
  assert.equal(Object.hasOwn(summarizeV2Result(envelope, state, { runDir }), 'proof'), false, 'an unreadable marker reads as none');
});

// sha1 of every home-351 summary and handback block, taken with the code
// before stage 2 (src/workflow/v2-outcome.js at the stage-1 commit). The
// saved runs carry no marker and declare no evidence, so nothing may change.
const HOME_351_SUMMARIES_SHA1 = '6709610d2f09a915ab43c97a36ccf9708cd1764e';

function home351Summaries(transform = (runDir) => runDir) {
  const lines = [];
  for (const id of readdirSync(join(HOME_351, 'workflows')).sort()) {
    const source = join(HOME_351, 'workflows', id);
    if (!existsSync(join(source, 'result.json'))) continue;
    const runDir = transform(source, id);
    const envelope = deserializeV2ResultEnvelope(readFileSync(join(runDir, 'result.json'), 'utf8'));
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const summary = summarizeV2Result(envelope, state, { runDir });
    lines.push(JSON.stringify({ ...summary, next: { ...summary.next, runDir: null } }), ...formatV2HandbackLines(summary));
  }
  return lines;
}

test('home-351 fixture runs summarise byte for byte as before stage 2', () => {
  const lines = home351Summaries();
  assert.equal(lines.length, 10);
  assert.equal(createHash('sha1').update(lines.join('\n')).digest('hex'), HOME_351_SUMMARIES_SHA1);
  assert.equal(lines.some((line) => line.includes('"proof"')), false);
});

test('the same saved run with a stage-2 marker gains labels: review-backed writers, never the review step', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bs-proof-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = 'wf-mu8thu2e-27c504';
  const runDir = join(home, run);
  cpSync(join(HOME_351, 'workflows', run), runDir, { recursive: true });
  writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
  const envelope = deserializeV2ResultEnvelope(readFileSync(join(runDir, 'result.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.program.actions.map((definition) => [definition.id, stepProof(state, definition, { features: MARKED })?.by]), [
    ['home-extraction', ['review']], ['runs-extraction', ['review']], ['run-extraction', ['review']], ['integrate', ['review']], ['verify', undefined],
  ]);
  const summary = summarizeV2Result(envelope, state, { runDir });
  // This run's summary only fits the budget at `bare`: the rows lose their
  // proof there, the top-level count stays.
  assert.deepEqual(summary.actions[0], { id: 'home-extraction', status: 'succeeded' });
  assert.deepEqual(summary.proof, { proven: 4, byType: { command: 0, schema: 0, review: 4 }, unproven: 0, unprovenSteps: [] });
  assert.equal(formatV2ProofLine(summary), 'proof: 4 steps proven (review 4)');
});

test('fit levels: the row proof is dropped at `status`, and the top-level proof survives `bare`', () => {
  const levelOf = (row) => (Object.hasOwn(row, 'kind') ? 'named|full|routing' : Object.hasOwn(row, 'outFile') ? 'status' : 'bare');
  const seen = new Map();
  for (const count of [2, 20, 30, 40, 60, 90, 140]) {
    const state = manySteps(count, { declare: (index) => index % 2 === 0 });
    const summary = summarizeV2Result(envelopeFor(state), state, { features: MARKED });
    const level = levelOf(summary.actions[0]);
    seen.set(level, count);
    if (level === 'named|full|routing') {
      assert.deepEqual(summary.actions[0].proof, ['command']);
      assert.deepEqual(summary.actions[1].proof, []);
    } else {
      assert.equal(summary.actions.some((row) => Object.hasOwn(row, 'proof')), false, `${level} rows carry no proof (${count} steps)`);
    }
    const proven = Math.ceil(count / 2);
    assert.deepEqual(summary.proof, {
      proven, byType: { command: proven, schema: 0, review: 0 }, unproven: count - proven,
      unprovenSteps: state.program.actions.filter((_, index) => index % 2 === 1).slice(0, 4).map((action) => action.id),
    }, `top-level proof kept at ${level} (${count} steps)`);
  }
  assert.deepEqual([...seen.keys()].sort(), ['bare', 'named|full|routing', 'status'], `levels reached: ${JSON.stringify([...seen])}`);
});
