import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveV2PresentationStages, presentationStageStatus } from '../src/workflow/v2-presentation.js';

const action = (id, purpose, ownedFiles = [], evidenceFor = []) => ({ id, purpose, ownedFiles, evidenceFor });

test('derives stable display stages from declared actions, not completion order', () => {
  const actions = [
    action('inspect-cli', 'Inspect CLI surface'),
    action('write-runtime', 'Implement runtime', ['src/runtime.js']),
    action('write-tests', 'Add focused tests', ['tests/runtime.test.js']),
    action('update-readme', 'Refresh README help', ['README.md']),
    action('check-runtime', 'Collect evidence', [], ['runtime-correct']),
  ];
  const stages = deriveV2PresentationStages(actions, 1);
  assert.deepEqual(stages.map(({ id, label, actionIds }) => ({ id, label, actionIds })), [
    { id: 'r1-discovery', label: 'Discovery', actionIds: ['inspect-cli'] },
    { id: 'r1-implementation', label: 'Implementation', actionIds: ['write-runtime'] },
    { id: 'r1-tests', label: 'Tests', actionIds: ['write-tests'] },
    { id: 'r1-documentation', label: 'Documentation', actionIds: ['update-readme'] },
    { id: 'r1-evidence', label: 'Evidence', actionIds: ['check-runtime'] },
  ]);
  assert.deepEqual(deriveV2PresentationStages([...actions], 1), stages);
  assert.equal(deriveV2PresentationStages([action('fix-runtime', 'Implement follow-up', ['src/runtime.js'])], 2)[0].label, 'Follow-up 1: Implementation');
});

test('computes stage completion from durable action state', () => {
  const stage = deriveV2PresentationStages([action('a', 'Implement A', ['a.js']), action('b', 'Implement B', ['b.js'])], 1)[0];
  assert.deepEqual(presentationStageStatus(stage, [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'running' }]), { terminal: false, successful: false, completed: 1, total: 2 });
  assert.deepEqual(presentationStageStatus(stage, [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'failed' }]), { terminal: true, successful: false, completed: 2, total: 2 });
});
