import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardRows, renderDashboard, renderDetails, requestCancel, dashboardJson, actionJson, decideApproval, runDashboard } from '../src/workflow/dashboard.js';
import { appendEvent, readEvents } from '../src/workflow/events.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-'));
  const dir = join(home, 'workflows', 'wf-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    runId: 'wf-test', shortId: 'abc234', workflow: 'audit-files', startedAt: new Date().toISOString(),
    intent: { goal: 'Audit every file autonomously.' },
    orchestration: { selectedPool: 'planner-agent', selectedModel: 'planner-v1', selection: 'capability-and-quota' },
    inputs: {}, outputs: { fan: { total: 3, ok: 2, failed: 0, items: [] } },
    steps: [{ phase: 'review', stepId: 'fan', ok: true }],
    usage: {
      tokens: { standardRead: 120, cacheRead: 40, cacheWrite: 10, output: 30 },
      cost: { estimatedUsd: 0.012 },
      normalizedQuota: { estimatedPercent: 0.5 },
    },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('dashboard renders ongoing run progress and details', () => {
  const { home, cleanup } = fixture();
  try {
    const rows = dashboardRows(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fanout.ok, 2);
    assert.match(renderDashboard({ rows }), /audit-files/);
    assert.match(renderDashboard({ rows }), /2\/3 items/);
    assert.match(renderDetails(rows[0]), /review\/fan/);
    assert.match(renderDetails(rows[0]), /Audit every file autonomously/);
    assert.match(renderDetails(rows[0]), /planner-agent · planner-v1 · capability-and-quota/);
    assert.match(renderDetails(rows[0]), /read=120 cache-read=40 cache-write=10 output=30/);
    assert.match(renderDetails(rows[0]), /quota≈0.5%/);
  } finally { cleanup(); }
});

test('tui with a run ID prints a historical text tree without a TTY', async () => {
  const { home, cleanup } = fixture();
  try {
    let printed = '';
    const output = { isTTY: false, write: (chunk) => { printed += chunk; } };
    const code = await runDashboard(home, { token: 'abc234', input: { isTTY: false }, output });
    assert.equal(code, 0);
    assert.match(printed, /bullswarm · audit-files · abc234/);
    assert.match(printed, /action tree:/);
    assert.doesNotMatch(printed, /Press b to go back/);
    assert.doesNotMatch(printed, /\x1b/);
  } finally { cleanup(); }
});

test('dashboard JSON supports listing, show, and cancellation', () => {
  const { home, cleanup } = fixture();
  try {
    const listed = dashboardJson(home);
    assert.equal(listed.action, 'list');
    assert.equal(listed.count, 1);
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.action, 'show');
    const cancelled = dashboardJson(home, { token: 'abc234', cancel: true });
    assert.equal(cancelled.action, 'cancel');
    assert.equal(JSON.parse(readFileSync(join(home, 'workflows', 'wf-test', 'state.json'))).cancelRequested, true);
    assert.equal(requestCancel(home, 'abc234').alreadyFinished, false);
  } finally { cleanup(); }
});

test('dashboard JSON show includes live state and report when present', () => {
  const { home, cleanup } = fixture();
  try {
    writeFileSync(join(home, 'workflows', 'wf-test', 'report.json'), JSON.stringify({ status: 'completed' }));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.state.workflow, 'audit-files');
    assert.deepEqual(shown.report, { status: 'completed' });
  } finally { cleanup(); }
});

test('dashboard rows expose current step and active agent state', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.currentPhase = { index: 0, name: 'review', total: 1 };
    state.currentStep = { id: 'fan', type: 'fanout', phase: 'review:adaptive' };
    state.activeAgents = { 'fan[0]': { stepId: 'fan[0]', pool: 'opencode2', model: 'relay/gpt-5.6-luna', attempt: 0 } };
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    assert.equal(row.currentStep.id, 'fan');
    assert.equal(row.phase, 'review:adaptive');
    assert.equal(row.activeAgents[0].model, 'relay/gpt-5.6-luna');
    assert.match(renderDetails(row), /relay\/gpt-5\.6-luna/);
  } finally { cleanup(); }
});

test('completed detail shows the last phase, terminal status, and routing rationale', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.status = 'completed';
    state.stage = 'delivered';
    state.finishedAt = new Date().toISOString();
    state.actionLedger = [{ id: 'fan', kind: 'run', status: 'succeeded', attempts: [0] }];
    state.attempts = [{
      actionId: 'fan', attemptNumber: 1, pool: 'planner-agent', model: 'planner-v1',
      effort: 'high', status: 'succeeded',
      routing: {
        reason: 'approved high assignment planner-agent; eligible by capability and quota',
        candidates: [{ pool: 'planner-agent', pace: 21 }, { pool: 'backup', pace: 8 }],
        configuredAssignment: { pool: 'planner-agent', model: 'planner-v1' },
        assignmentApplied: { pool: 'planner-agent', model: 'planner-v1' },
      },
    }];
    writeFileSync(statePath, JSON.stringify(state));
    const shown = dashboardJson(home, { token: 'abc234' });
    const text = renderDetails(shown, { interactive: false });
    assert.match(text, /phase:\s+review/);
    assert.match(text, /current: terminal:completed/);
    assert.match(text, /route: approved high assignment planner-agent/);
    assert.match(text, /candidates \[planner-agent:21, backup:8\]/);
  } finally { cleanup(); }
});

test('JSON inspection and action inspection expose the same durable state and events', () => {
  const { home, cleanup } = fixture();
  try {
    const runDir = join(home, 'workflows', 'wf-test');
    const statePath = join(runDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.actionLedger = [{ id: 'fan', kind: 'fanout', status: 'succeeded', attempts: [0] }];
    state.attempts = [{ actionId: 'fan', attemptNumber: 1, pool: 'echo', status: 'succeeded' }];
    appendEvent(runDir, state, 'action.completed', { actionId: 'fan' });
    writeFileSync(statePath, JSON.stringify(state));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.deepEqual(shown.state, JSON.parse(readFileSync(statePath, 'utf8')));
    assert.deepEqual(shown.events, readEvents(runDir));
    const action = actionJson(home, 'abc234', 'fan');
    assert.deepEqual(action.actionRecord, state.actionLedger[0]);
    assert.deepEqual(action.attempts, [state.attempts[0]]);
  } finally { cleanup(); }
});

test('human approval decisions are durable and visible to a resumed planner', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.status = 'waiting_for_approval';
    state.approval = { gateId: 'planner', reason: 'Need human review', requestedAt: new Date().toISOString() };
    writeFileSync(statePath, JSON.stringify(state));
    const result = decideApproval(home, 'abc234', 'approve');
    assert.equal(result.state.status, 'paused');
    assert.equal(result.state.approval.status, 'approved');
    assert.equal(readEvents(join(home, 'workflows', 'wf-test')).at(-1).type, 'approval.granted');
  } finally { cleanup(); }
});
