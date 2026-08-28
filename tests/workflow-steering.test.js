import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueSteering, readSteering, deliverSteering } from '../src/workflow/steering.js';

function fixture({ terminal = false, decide = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-steer-'));
  const runId = 'wf-msteer-abcdef';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const state = {
    runId, shortId: 'abc234', status: terminal ? 'completed' : 'running',
    ...(terminal ? { finishedAt: new Date().toISOString() } : {}),
    decisions: [], steering: [],
    _doc: { phases: [{ name: 'p', steps: [{ id: 'gate', type: decide ? 'decide' : 'run' }] }] },
  };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  return { home, runDir, state, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('steering queues durably and is delivered exactly once at a planner boundary', () => {
  const f = fixture();
  try {
    const queued = queueSteering(f.home, 'abc234', 'Prefer a focused test before the full suite.');
    assert.equal(queued.entry.delivery, 'next-not-yet-started-planner-checkpoint');
    assert.equal(readSteering(f.runDir).length, 1);
    const first = deliverSteering(f.state, f.runDir);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'delivered_to_planner');
    assert.equal(first[0].decisionSequence, 1);
    assert.deepEqual(deliverSteering(f.state, f.runDir), []);
  } finally { f.cleanup(); }
});

test('steering refuses terminal and non-orchestrated workflows', () => {
  const terminal = fixture({ terminal: true });
  const staticRun = fixture({ decide: false });
  try {
    assert.throws(() => queueSteering(terminal.home, 'abc234', 'too late'), /already terminal/);
    assert.throws(() => queueSteering(staticRun.home, 'abc234', 'no gate'), /no orchestration decision gate/);
  } finally {
    terminal.cleanup();
    staticRun.cleanup();
  }
});
