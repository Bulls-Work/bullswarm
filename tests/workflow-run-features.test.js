import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUN_FEATURES_FILE, STAGE2_RUN_FEATURES, readRunFeatures, runFeaturesPath, writeRunFeatures,
} from '../src/workflow/run-features.js';

function runDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a missing, unreadable or non-object marker reads as {} and never throws', (t) => {
  const dir = runDir(t);
  assert.deepEqual(readRunFeatures(dir), {});
  assert.deepEqual(readRunFeatures(join(dir, 'no-such-run')), {});
  writeFileSync(join(dir, RUN_FEATURES_FILE), '{"deliverableGate":');
  assert.deepEqual(readRunFeatures(dir), {});
  for (const body of ['[1]', 'null', '"x"', '7']) {
    writeFileSync(join(dir, RUN_FEATURES_FILE), body);
    assert.deepEqual(readRunFeatures(dir), {}, body);
  }
  const dirAsFile = join(runDir(t), 'x');
  mkdirSync(join(dirAsFile, RUN_FEATURES_FILE), { recursive: true });
  assert.deepEqual(readRunFeatures(dirAsFile), {});
});

test('the stored object comes back unchanged, with no defaults filled', (t) => {
  const dir = runDir(t);
  writeFileSync(join(dir, RUN_FEATURES_FILE), '{"deliverableGate":1}');
  assert.deepEqual(readRunFeatures(dir), { deliverableGate: 1 });
  assert.equal(readRunFeatures(dir).proofLabels, undefined);
  // A later stage's keys (and unknown ones) survive a read untouched.
  const later = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller', futureKey: [1, 2] };
  writeFileSync(join(dir, RUN_FEATURES_FILE), JSON.stringify(later));
  assert.deepEqual(readRunFeatures(dir), later);
});

test('writeRunFeatures writes the stage-2 marker atomically as JSON', (t) => {
  const dir = runDir(t);
  assert.deepEqual(STAGE2_RUN_FEATURES, { deliverableGate: 1, proofLabels: 1 });
  writeRunFeatures(dir, { ...STAGE2_RUN_FEATURES });
  assert.equal(runFeaturesPath(dir), join(dir, 'features.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')), { deliverableGate: 1, proofLabels: 1 });
  assert.deepEqual(readRunFeatures(dir), { deliverableGate: 1, proofLabels: 1 });
  assert.equal(readRunFeatures(dir).proofLabels === 1, true);
});
