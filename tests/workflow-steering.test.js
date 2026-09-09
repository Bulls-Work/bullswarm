import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueSteering, readSteering, deliverSteering } from '../src/workflow/steering.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

function fixture({ terminal = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-steer-'));
  const runId = 'wf-msteer-abcdef';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const goal = createV2GoalDocument({
    goal: 'Deliver a focused change', cwd: home,
    requirements: [{ id: 'change', text: 'the change is correct' }],
    settings: { scout: false },
  });
  const state = createV2State(goal, { runId, shortId: 'abc234' });
  state.lifecycle.status = terminal ? 'completed' : 'running';
  if (terminal) state.lifecycle.finishedAt = new Date().toISOString();
  state.planner.status = 'waiting';
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

test('steering refuses terminal and legacy workflows', () => {
  const terminal = fixture({ terminal: true });
  const legacyHome = mkdtempSync(join(tmpdir(), 'bs-steer-legacy-'));
  try {
    assert.throws(() => queueSteering(terminal.home, 'abc234', 'too late'), /already terminal/);
    // A pre-0.27.0 authored-graph run has no planner boundary to steer toward.
    const legacyDir = join(legacyHome, 'workflows', 'wf-legacy-steer01');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({
      runId: 'wf-legacy-steer01', shortId: 'def345', workflow: 'old', status: 'running',
      startedAt: new Date().toISOString(), steps: [],
    }));
    assert.throws(() => queueSteering(legacyHome, 'def345', 'no gate'), /legacy authored-graph run/);
  } finally {
    terminal.cleanup();
    rmSync(legacyHome, { recursive: true, force: true });
  }
});

test('V2 steering queues against the Workflow Planner and uses its next turn number', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-steer-v2-'));
  const runId = 'wf-msteerv2-abcdef';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  try {
    const goal = createV2GoalDocument({
      goal: 'Deliver a report', cwd: home,
      requirements: [{ id: 'report', text: 'report is correct' }],
      settings: { scout: false },
    });
    const state = createV2State(goal, { runId, shortId: 'v2s234' });
    state.lifecycle.status = 'running';
    state.planner.turns = 2;
    state.planner.status = 'waiting';
    writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    const queued = queueSteering(home, 'v2s234', 'Prefer the smaller public API.');
    assert.equal(queued.entry.delivery, 'next-not-yet-started-planner-checkpoint');
    const delivered = deliverSteering(state, runDir);
    assert.equal(delivered[0].decisionSequence, 3);
    assert.equal(delivered[0].status, 'delivered_to_planner');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
