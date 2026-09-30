// A caller's exact model: `model` on a v3 step, `--model` on bullswarm run
// (src/lib/model-pin.js). Only pools that can say they run the model stay
// eligible, and nothing substitutes another model.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isModelId, poolCanRunModel } from '../src/lib/model-pin.js';
import { normaliseProgramV3 } from '../src/workflow/program-v3.js';
import { validateActionProgram } from '../src/workflow/action-validator.js';
import { prepareV2DispatchPools, selectedV2DispatchModel } from '../src/workflow/v2-dispatch.js';
import { modelPoolIssues } from '../src/workflow/cli-pool-checks.js';
import { runStepProgram, runStepRequest } from '../src/lib/run-step.js';

const pool = (name, discoveredModels, extra = {}) => ({
  name, enabled: true, lanes: ['analyze', 'build', 'chore'],
  connector: { name, model: null, knownModels: [] },
  discoveredModels, strategyExcludedModels: [], strategyDisabledModels: {},
  strategyModelTiers: {}, strategyConfiguredTiers: [], strategyAssignments: {},
  ...extra,
});
const acme = pool('acme', ['acme-6-sol', 'acme-6-luna']);
const initech = pool('initech', ['initech-opus-5-5', 'initech-opus-5-5[1m]']);

test('a pool runs a model its discovery lists, a context variant of one, and nothing it turned off', () => {
  assert.deepEqual(poolCanRunModel(acme, 'acme-6-sol'), { ok: true });
  assert.deepEqual(poolCanRunModel(initech, 'initech-opus-5-5[1m]'), { ok: true });
  assert.deepEqual(poolCanRunModel(acme, 'initech-opus-5-5'), { ok: false, reason: 'acme does not list initech-opus-5-5' });
  const off = { ...acme, strategyDisabledModels: { acme: ['acme-6-sol'] } };
  assert.deepEqual(poolCanRunModel(off, 'acme-6-sol'), { ok: false, reason: 'acme-6-sol is turned off for acme' });
  const excluded = { ...acme, strategyExcludedModels: ['acme-6-sol'] };
  assert.equal(poolCanRunModel(excluded, 'acme-6-sol').ok, false);
  // No discovery yet: the connector's own names decide.
  const fresh = pool('fresh', [], { connector: { name: 'fresh', model: 'fresh-1', knownModels: ['fresh-2'] } });
  assert.equal(poolCanRunModel(fresh, 'fresh-2').ok, true);
  assert.match(poolCanRunModel(fresh, 'fresh-3').reason, /strategy refresh/);
  // A relay pool runs any model under its own provider id, not another's.
  const relay = pool('relay', [], { connector: { name: 'relay', profile: { providerId: 'a' } } });
  assert.equal(poolCanRunModel(relay, 'a/acme-6-luna').ok, true);
  assert.equal(poolCanRunModel(relay, 'b/acme-6-luna').ok, false);
  assert.equal(isModelId('acme-6.1-sol'), true);
  assert.equal(isModelId('acme 6'), false);
  assert.equal(isModelId(''), false);
});

test('a v3 step may name its model; a v2 action still may not', () => {
  const stored = normaliseProgramV3({
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{ id: 'check', prompt: 'In /work/acme, read README.md.', model: 'acme-6-sol', reasoning: 'high' }],
  });
  const step = stored.steps?.[0] ?? stored.actions?.[0];
  assert.equal(step.model, 'acme-6-sol');
  assert.throws(() => normaliseProgramV3({
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{ id: 'check', prompt: 'In /work/acme, read README.md.', model: 'acme 6 sol' }],
  }), (error) => JSON.stringify(error.issues ?? error.message).includes('model must be a model id'));
  assert.throws(() => validateActionProgram({
    schemaVersion: 'bullswarm.workflow.actions.v2',
    actions: [{ id: 'check', purpose: 'check', prompt: 'x', dependsOn: [], affects: ['goal'], ownedFiles: [], lane: 'analyze', model: 'acme-6-sol' }],
  }, { requirements: [{ id: 'goal', mandatory: false }] }), (error) => JSON.stringify(error.issues ?? error.message).includes('model is not allowed in V2'));
});

test('dispatch keeps only the pools that run the step\'s model, and runs that model whatever the tier holds', () => {
  const action = { id: 'check', lane: 'analyze', effort: 'medium' };
  // acme's medium tier selects luna; the caller asked for sol.
  const tiered = { ...acme, strategyModelTiers: { acme: { 'acme-6-luna': ['medium'] } }, strategyConfiguredTiers: ['medium'] };
  const picked = prepareV2DispatchPools([tiered, initech], action, 'medium', { preferredModel: 'acme-6-sol' });
  assert.deepEqual(picked.map((entry) => entry.name), ['acme']);
  assert.equal(picked[0].modelPolicy.source, 'caller-model');
  assert.equal(selectedV2DispatchModel(picked[0], 'medium', 'acme-6-sol'), 'acme-6-sol');
  assert.deepEqual(prepareV2DispatchPools([tiered, initech], action, 'medium', { preferredModel: 'nope-9' }), []);
});

test('validate names a model no enabled pool can run, with each pool\'s reason', () => {
  const actions = [
    { id: 'fine', model: 'acme-6-sol' },
    { id: 'plain' },
    { id: 'lost', model: 'nope-9' },
  ];
  assert.deepEqual(modelPoolIssues(actions, [acme, initech]), [
    'steps[2] (lost) asks for model nope-9, which no enabled pool can run: acme does not list nope-9; initech does not list nope-9',
  ]);
  // The run's --worker-model is checked the same way on every step without its own.
  const doc = { config: { workerRouting: { model: 'initech-opus-5-5' } } };
  assert.deepEqual(modelPoolIssues([{ id: 'plain' }], [acme, initech], doc), []);
  assert.equal(modelPoolIssues([{ id: 'plain' }], [acme], doc).length, 1);
});

test('bullswarm run --model becomes the one step\'s model', () => {
  const { request, error } = runStepRequest({ lane: 'analyze', prompt: 'Read README.md', model: 'acme-6-sol' }, { cwd: '/work/acme' });
  assert.equal(error, undefined);
  assert.equal(runStepProgram(request).steps[0].model, 'acme-6-sol');
  assert.match(runStepRequest({ lane: 'analyze', prompt: 'x', model: 'acme 6' }).error, /model must be a model id/);
  assert.equal(runStepProgram(runStepRequest({ lane: 'analyze', prompt: 'x' }).request).steps[0].model, undefined);
});
