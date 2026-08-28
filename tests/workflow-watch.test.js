import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDuration, timingBreakdown, watchSnapshot, snapshotFingerprint,
  renderWatchSnapshot, runWorkflowWatch,
} from '../src/workflow/watch-cli.js';
import { appendEvent } from '../src/workflow/events.js';

function fixture(state = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-'));
  const runId = 'wf-mwatch-abcdef';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const document = {
    runId, shortId: 'abc234', workflow: 'demo', status: 'running', stage: 'executing',
    startedAt: '2026-08-28T01:00:00.000Z', eventSequence: 4,
    budget: { dispatchesUsed: 2, dispatchTarget: 30, expansionRound: 1, expansionLimit: 8 },
    usage: { tokens: { totalKnown: 1234 } },
    currentStep: { id: 'implement', phase: 'delivery' },
    activeAgents: {
      implement: {
        stepId: 'implement', pool: 'command-code', model: 'gpt-5.6-sol', status: 'running',
        startedAt: '2026-08-28T01:01:00.000Z', outputBytesObserved: 42,
        stall: { status: 'active', silentForSec: 20 },
        lastActions: [{ id: 'a', kind: 'shell_command', status: 'running', summary: 'npm test' }],
      },
    },
    attempts: [], steering: [],
    ...state,
  };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(document)}\n`);
  return { home, runDir, state: document, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('watch snapshot is concise and stable between heartbeats', () => {
  const f = fixture();
  try {
    const now = new Date('2026-08-28T01:05:00.000Z');
    const snapshot = watchSnapshot(f.runDir, f.state, now);
    assert.equal(snapshot.elapsedSec, 300);
    assert.equal(snapshot.agents[0].elapsedSec, 240);
    assert.equal(snapshot.agents[0].lastActions[0].summary, 'npm test');
    const compact = renderWatchSnapshot(snapshot);
    assert.match(compact, /0 events, 0 actions/);
    assert.doesNotMatch(compact, /npm test/);
    assert.match(renderWatchSnapshot(snapshot, { verbose: true }), /shell_command:running · npm test/);
    const later = watchSnapshot(f.runDir, f.state, new Date('2026-08-28T01:05:30.000Z'));
    assert.equal(snapshotFingerprint(snapshot), snapshotFingerprint(later));
    assert.equal(formatDuration(3661), '1h01m');
  } finally { f.cleanup(); }
});

test('human watch reports interval activity without repeating excerpts', () => {
  const f = fixture({ eventSequence: 6 });
  try {
    const rendered = renderWatchSnapshot(watchSnapshot(f.runDir, f.state), {
      events: [
        { type: 'phase.started' },
        { type: 'attempt.agent_action', payload: { actionId: 'implement' } },
      ],
    });
    assert.match(rendered, /2 events, 1 actions/);
    assert.doesNotMatch(rendered, /npm test/);
  } finally { f.cleanup(); }
});

test('default watch aggregates low-level actions until the heartbeat interval', async () => {
  const f = fixture();
  try {
    let output = '';
    const watching = runWorkflowWatch(f.home, 'abc234', {
      intervalMs: 10,
      heartbeatMs: 120,
      output: { write: (text) => { output += text; } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = JSON.parse(readFileSync(join(f.runDir, 'state.json'), 'utf8'));
    appendEvent(f.runDir, state, 'attempt.agent_action', { actionId: 'implement' });
    appendEvent(f.runDir, state, 'attempt.agent_action', { actionId: 'implement' });
    writeFileSync(join(f.runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(output.trim().split('\n').length, 1, 'actions alone must not wake compact watch');
    await new Promise((resolve) => setTimeout(resolve, 75));
    state.status = 'completed';
    state.stage = 'delivered';
    state.finishedAt = new Date().toISOString();
    state.activeAgents = {};
    writeFileSync(join(f.runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    assert.equal(await watching, 0);
    assert.match(output, /2 events, 2 actions/);
    assert.doesNotMatch(output, /implement#|npm test/);
  } finally { f.cleanup(); }
});

test('terminal watch emits attempt timing breakdown and exits', async () => {
  const f = fixture({
    status: 'completed', stage: 'delivered', finishedAt: '2026-08-28T01:03:00.000Z',
    currentStep: undefined, activeAgents: {},
    attempts: [{
      actionId: 'implement', attemptNumber: 1, pool: 'command-code', model: 'gpt-5.6-sol',
      status: 'succeeded', startedAt: '2026-08-28T01:01:00.000Z', finishedAt: '2026-08-28T01:02:30.000Z',
      usage: { tokens: { totalKnown: 1000 } },
    }],
  });
  try {
    assert.equal(timingBreakdown(f.state).attempts[0].elapsedSec, 90);
    let output = '';
    const code = await runWorkflowWatch(f.home, 'abc234', { verbose: true, output: { write: (text) => { output += text; } } });
    assert.equal(code, 0);
    assert.match(output, /timing: 1 attempts in 3m00s/);
    assert.match(output, /implement#1/);
    assert.match(output, /next: bullswarm workflow runs result abc234 --json/);
  } finally { f.cleanup(); }
});

test('compact terminal uses finished activity for quiet time and omits attempt detail', async () => {
  const finishedAt = new Date(Date.now() - 5_000).toISOString();
  const f = fixture({
    status: 'completed', stage: 'delivered', finishedAt,
    currentStep: undefined, activeAgents: {},
    attempts: [{
      actionId: 'implement', attemptNumber: 1, pool: 'command-code', status: 'succeeded',
      startedAt: new Date(Date.now() - 10_000).toISOString(), finishedAt,
    }],
    lastEvent: undefined,
  });
  try {
    let output = '';
    assert.equal(await runWorkflowWatch(f.home, 'abc234', {
      once: true, output: { write: (text) => { output += text; } },
    }), 0);
    assert.match(output, /quiet [45]s/);
    assert.match(output, /timing: 1 attempts/);
    assert.doesNotMatch(output, /implement#1/);
  } finally { f.cleanup(); }
});

test('qualified completion is terminal and exits successfully for result consumption', async () => {
  const f = fixture({
    status: 'completed_with_concerns', stage: 'delivered_with_concerns',
    finishedAt: '2026-08-28T01:03:00.000Z', currentStep: undefined, activeAgents: {}, attempts: [],
  });
  try {
    let output = '';
    const code = await runWorkflowWatch(f.home, 'abc234', { output: { write: (text) => { output += text; } } });
    assert.equal(code, 0);
    assert.match(output, /completed_with_concerns\/delivered_with_concerns/);
  } finally { f.cleanup(); }
});

test('compact heartbeat separates semantic quiet from live agent output', async () => {
  const now = Date.now();
  const f = fixture({
    startedAt: new Date(now - 120_000).toISOString(),
    lastEvent: { committedAt: new Date(now - 40_000).toISOString() },
    activeAgents: {
      implement: {
        stepId: 'implement', pool: 'command-code', status: 'running',
        startedAt: new Date(now - 100_000).toISOString(),
        lastActivityAt: new Date(now - 3_000).toISOString(), outputBytesObserved: 4096,
      },
    },
  });
  try {
    const snapshot = watchSnapshot(f.runDir, f.state, new Date(now));
    assert.equal(snapshot.transportQuietForSec, 3);
    assert.equal(watchSnapshot(f.runDir, { ...f.state, activeAgents: {} }, new Date(now)).transportQuietForSec, null);
    let output = '';
    assert.equal(await runWorkflowWatch(f.home, 'abc234', {
      once: true, output: { write: (text) => { output += text; } },
    }), 0);
    assert.match(output, /quiet (39|40|41)s · agent output [2-4]s ago/);
    let json = '';
    await runWorkflowWatch(f.home, 'abc234', { once: true, jsonl: true, output: { write: (text) => { json += text; } } });
    assert.ok([2, 3, 4].includes(JSON.parse(json).transportQuietForSec));
  } finally { f.cleanup(); }
});

test('watch waits a bounded grace period for a freshly launched run to write state.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-grace-'));
  const runId = 'wf-mgrace-abcdef';
  try {
    const runDir = join(home, 'workflows', runId);
    setTimeout(() => {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'state.json'), `${JSON.stringify({
        runId, shortId: 'grc234', status: 'completed', stage: 'delivered',
        startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(),
        attempts: [], activeAgents: {}, steering: [],
      })}\n`);
    }, 400);
    let output = '';
    const code = await runWorkflowWatch(home, runId, {
      once: true, waitForRunMs: 5000, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.match(output, /completed\/delivered/);
    await assert.rejects(() => runWorkflowWatch(home, 'wf-missing-zzzzzz', { once: true, waitForRunMs: 300 }), /no run found/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
