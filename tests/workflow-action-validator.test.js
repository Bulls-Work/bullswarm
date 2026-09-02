import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionValidationError, validateActionProgram } from '../src/workflow/action-validator.js';

const work = (over = {}) => ({
  id: 'build-result', purpose: 'Build the result', dependsOn: [], affects: ['result'],
  ownedFiles: ['src/result.js'], prompt: 'Implement the result', lane: 'build', effort: 'medium',
  evidenceFor: [], produces: ['result-artifact'], ...over,
});
const evidence = (over = {}) => ({
  id: 'check-result', purpose: 'Check the result', dependsOn: ['build-result'], affects: [],
  ownedFiles: [], prompt: 'Inspect the result', lane: 'analyze', effort: 'low', evidenceFor: ['result'],
  inputs: ['result-artifact'], ...over,
});
const program = (actions = [work(), evidence()]) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });

test('validates and defensively normalizes a V2 program', () => {
  const input = program([work({ ownedFiles: ['./src/result.js'] }), evidence()]);
  const result = validateActionProgram(input, { mandatoryRequirements: ['result'], maxActions: 2, maxParallel: 2 });
  assert.deepEqual(result.actions[0].ownedFiles, ['src/result.js']);
  input.actions[0].ownedFiles[0] = 'changed.js';
  assert.equal(result.actions[0].ownedFiles[0], 'src/result.js');
});

test('rejects unknown fields, planner control claims, and malformed IDs', () => {
  assert.throws(() => validateActionProgram(program([work({ type: 'verify', completion: true, id: 'Bad ID', extra: 1 })])), (error) => {
    assert.ok(error instanceof ActionValidationError);
    assert.ok(error.issues.some((issue) => issue.includes('extra')));
    assert.ok(error.issues.some((issue) => issue.includes('completion')));
    assert.ok(error.issues.some((issue) => issue.includes('valid kebab-case')));
    return true;
  });
});

test('rejects cycles, unknown references, duplicate artifacts, and unsafe paths', () => {
  assert.throws(() => validateActionProgram(program([
    work({ id: 'a', dependsOn: ['b'], produces: ['same'], ownedFiles: ['../secret'] }),
    work({ id: 'b', dependsOn: ['a'], produces: ['same'], ownedFiles: ['src/b.js'] }),
  ])), (error) => error.issues.some((issue) => issue.includes('cycle')) && error.issues.some((issue) => issue.includes('duplicate producers')));
});

test('requires evidence coverage and independence from every affected work action', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'other', affects: ['result'], ownedFiles: ['src/other.js'] }), evidence({ dependsOn: ['build-result'], inputs: [] })]), { mandatoryRequirements: ['result'] }), (error) => error.issues.some((issue) => issue.includes('other')));
  assert.throws(() => validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', actions: [work()] }, { mandatoryRequirements: ['result'] }), (error) => error.issues.some((issue) => issue.includes('no evidence action')));
});

test('requires justified work dependencies and enforces parallel/action bounds', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'a', affects: [], ownedFiles: ['a.js'], produces: [] }), work({ id: 'b', affects: [], ownedFiles: ['b.js'], produces: [] })]), { maxParallel: 1 }), (error) => error.issues.some((issue) => issue.includes('maxParallel')));
  assert.throws(() => validateActionProgram(program([work({ id: 'a', affects: [], ownedFiles: ['a.js'], produces: [] }), work({ id: 'b', dependsOn: ['a'], affects: [], ownedFiles: ['b.js'], produces: [] })]), { maxParallel: 2 }), (error) => error.issues.some((issue) => issue.includes('not justified')));
});

test('accepts ordered overlap, direct artifact dependencies, evidence inputs, and optional requirements', () => {
  const result = validateActionProgram(program([
    work({ id: 'first', affects: ['optional'], ownedFiles: ['src/shared.js'], produces: ['work-artifact'] }),
    work({ id: 'second', dependsOn: ['first'], affects: ['result'], ownedFiles: ['src/shared.js'], inputs: ['work-artifact'], produces: [] }),
    evidence({ id: 'check', dependsOn: ['second'], evidenceFor: ['result'], inputs: ['work-artifact'] }),
  ]), { requirements: [{ id: 'result', mandatory: true }, { id: 'optional', mandatory: false }] });
  assert.equal(result.actions.length, 3);
});

test('accepts a replan depending on a known producer and returns only new actions', () => {
  const knownWork = { id: 'known-work', affects: ['result'], ownedFiles: ['src/known.js'], produces: ['known-artifact'] };
  const result = validateActionProgram(program([
    evidence({ id: 'check-new', dependsOn: ['known-work'], evidenceFor: ['result'], inputs: ['known-artifact'] }),
  ]), {
    mandatoryRequirements: ['result'],
    knownActions: [knownWork],
    knownArtifacts: { 'known-artifact': 'known-work' },
  });
  assert.deepEqual(result.actions.map((action) => action.id), ['check-new']);
});

test('accepts mandatory coverage from fresh existing evidence', () => {
  const result = validateActionProgram(program([work()]), {
    mandatoryRequirements: ['result'],
    freshEvidenceRequirementIds: ['result'],
  });
  assert.equal(result.actions.length, 1);
});

test('rejects known ID and artifact collisions, stale coverage, and unsafe NUL paths', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'known-work' })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', produces: ['known-artifact'] })],
    knownArtifacts: { 'known-artifact': 'known-work' },
  }), (error) => error.issues.some((issue) => issue.includes('collides with known action')));
  assert.throws(() => validateActionProgram(program([work({ produces: ['known-artifact'] }), evidence({ dependsOn: ['build-result'], inputs: ['known-artifact'] })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', produces: ['known-artifact'] })],
  }), (error) => error.issues.some((issue) => issue.includes('duplicate producers')));
  assert.throws(() => validateActionProgram(program([work()]), {
    mandatoryRequirements: ['result'],
    freshEvidenceRequirementIds: [],
  }), (error) => error.issues.some((issue) => issue.includes('no evidence action')));
  assert.throws(() => validateActionProgram(program([work({ ownedFiles: ['src/\0bad.js'] })])), (error) => error.issues.some((issue) => issue.includes('NUL')));
});

test('rejects evidence that misses a known affecting work ancestor and handles malformed entries', () => {
  assert.throws(() => validateActionProgram(program([evidence({ dependsOn: [], inputs: [] })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', affects: ['result'] })],
  }), (error) => error.issues.some((issue) => issue.includes('known-work')));
  assert.throws(() => validateActionProgram(program([null, 3, 'bad']), { mandatoryRequirements: ['result'] }), (error) => {
    assert.ok(error.issues.some((issue) => issue.includes('actions[0] must be an object')));
    assert.ok(error.issues.some((issue) => issue.includes('actions[1] must be an object')));
    return true;
  });
});

test('rejects planner-owned output contracts in evidence prompts before dispatch', () => {
  for (const prompt of [
    'Inspect the result. Return JSON exactly in the form {"ok":true,"concerns":[],"summary":"done"}.',
    'Check the requirement and respond with an object containing the verdict.',
    'Inspect the files, then emit an evidence envelope with your findings.',
  ]) {
    assert.throws(
      () => validateActionProgram(program([work(), evidence({ prompt })]), { mandatoryRequirements: ['result'] }),
      (error) => error.issues.some((issue) => issue.includes('kernel')),
    );
  }
  assert.equal(
    validateActionProgram(program([work(), evidence({ prompt: 'Inspect the result, run the focused tests, and cite concrete findings.' })]), { mandatoryRequirements: ['result'] }).actions.length,
    2,
  );
});

test('enforces structural lane and effort invariants before dispatch', () => {
  assert.throws(
    () => validateActionProgram(program([work({ lane: 'analyze' }), evidence()])),
    (error) => error.issues.some((issue) => issue.includes('analyze actions must not own workspace files')),
  );
  assert.throws(
    () => validateActionProgram(program([work(), evidence({ lane: 'build' })])),
    (error) => error.issues.some((issue) => issue.includes('evidence actions must use lane analyze')),
  );
  assert.throws(
    () => validateActionProgram(program([work({ lane: 'chore', effort: 'medium' }), evidence()])),
    (error) => error.issues.some((issue) => issue.includes('chore actions are deterministic mechanical work and must use low effort')),
  );
  assert.equal(
    validateActionProgram(program([work({ lane: 'chore', effort: 'low' }), evidence()]), { mandatoryRequirements: ['result'] }).actions[0].lane,
    'chore',
  );
});

test('can replay a historical program without retroactively applying routing policy', () => {
  const historical = validateActionProgram(
    program([work({ lane: 'chore', effort: 'medium' }), evidence()]),
    { mandatoryRequirements: ['result'], enforceRoutingPolicy: false },
  );
  assert.equal(historical.actions[0].effort, 'medium');
});
