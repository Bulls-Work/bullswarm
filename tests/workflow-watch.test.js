import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDuration, timingBreakdown, watchSnapshot, snapshotFingerprint,
  renderWatchSnapshot, runWorkflowWatch,
} from '../src/workflow/watch-cli.js';

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

test('watch snapshot is concise, stable between heartbeats, and shows last actions', () => {
  const f = fixture();
  try {
    const now = new Date('2026-08-28T01:05:00.000Z');
    const snapshot = watchSnapshot(f.runDir, f.state, now);
    assert.equal(snapshot.elapsedSec, 300);
    assert.equal(snapshot.agents[0].elapsedSec, 240);
    assert.equal(snapshot.agents[0].lastActions[0].summary, 'npm test');
    assert.match(renderWatchSnapshot(snapshot), /command-code\/gpt-5\.6-sol/);
    assert.match(renderWatchSnapshot(snapshot), /shell_command:running · npm test/);
    const later = watchSnapshot(f.runDir, f.state, new Date('2026-08-28T01:05:30.000Z'));
    assert.equal(snapshotFingerprint(snapshot), snapshotFingerprint(later));
    assert.equal(formatDuration(3661), '1h01m');
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
    const code = await runWorkflowWatch(f.home, 'abc234', { output: { write: (text) => { output += text; } } });
    assert.equal(code, 0);
    assert.match(output, /timing: 1 attempts in 3m00s/);
    assert.match(output, /implement#1/);
  } finally { f.cleanup(); }
});
