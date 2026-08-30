import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dashboardRows, renderDashboard, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, actionJson, decideApproval, runDashboard } from '../src/workflow/dashboard.js';
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
    state.activeAgents = { 'fan[0]': {
      stepId: 'fan[0]', pool: 'opencode2', model: 'relay/gpt-5.6-luna', attempt: 0,
      lastActivityAt: '2026-08-28T01:00:00.000Z', outputBytesObserved: 321,
      eventStreamSupported: true,
      stall: { status: 'suspected_stalled', silentForSec: 601, autoTerminate: false },
      lastActions: [
        { id: 'a', kind: 'read_file', status: 'completed', summary: 'src/app.js' },
        { id: 'b', kind: 'shell_command', status: 'running', summary: 'npm test' },
      ],
    } };
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    assert.equal(row.currentStep.id, 'fan');
    assert.equal(row.phase, 'review:adaptive');
    assert.equal(row.activeAgents[0].model, 'relay/gpt-5.6-luna');
    assert.match(renderDetails(row), /relay\/gpt-5\.6-luna/);
    assert.match(renderDetails(row), /output activity 2026-08-28T01:00:00\.000Z \(321 bytes observed\)/);
    assert.match(renderDetails(row), /suspected stalled \(601s without evidence; no auto-kill\)/);
    assert.match(renderDetails(row), /read_file · completed · src\/app\.js/);
    assert.match(renderDetails(row), /shell_command · running · npm test/);
  } finally { cleanup(); }
});

test('full-screen workflow view models phase, agent, and selected-agent steps', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state._doc = { phases: [
      { name: 'discover', steps: [{ id: 'scan', type: 'run' }] },
      { name: 'review', steps: [{ id: 'fan', type: 'fanout' }] },
    ] };
    state.currentPhase = { index: 1, name: 'review', total: 2 };
    state.actionLedger = [{ id: 'fan', phase: 'review', kind: 'fanout', status: 'running', attempts: [0] }];
    state.attempts = [{
      actionId: 'fan', attemptNumber: 1, pool: 'grok', model: 'grok-4.6',
      effort: 'high', status: 'running', startedAt: new Date().toISOString(),
      usage: { tokens: { standardRead: 40, output: 12 } },
      actionCount: 7,
    }];
    state.activeAgents = { fan: {
      stepId: 'fan', pool: 'grok', model: 'grok-4.6', attempt: 1, status: 'running',
      lastActivityAt: new Date().toISOString(), outputBytesObserved: 900,
      actionCount: 7,
      lastActions: [
        { kind: 'read_file', status: 'completed', summary: 'src/app.js' },
        { kind: 'shell_command', status: 'running', summary: 'npm test' },
      ],
    } };
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const model = workflowPanelModel(row);
    assert.equal(model.selectedPhase.name, 'review');
    assert.equal(model.selectedAgent.pool, 'grok');
    assert.equal(model.selectedAgent.action.id, 'fan');
    const overview = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.match(overview, /Phases · 2/);
    assert.match(overview, /1 ○ discover/);
    assert.match(overview, /2 ⠋ review 0\/1/);
    assert.match(overview, /Workflow timeline/);
    assert.match(overview, /Live · 1 running · 0 waiting/);
    assert.match(overview, /fan · grok · grok-4\.6/);
    assert.match(overview, /shell command · npm test/);
    assert.doesNotMatch(overview, /Activity/);

    const agents = renderWorkflowTui(row, { width: 120, height: 30, focus: 1 });
    assert.match(agents, /review · 0\/1 complete/);
    assert.match(agents, /fan · grok · grok-4\.6 · #1 · 52 tok/);

    const detail = renderWorkflowTui(row, { width: 120, height: 30, focus: 2 });
    assert.match(detail, /fan · grok/);
    assert.match(detail, /⠋ running · grok-4\.6/);
    assert.match(detail, /Activity/);
    assert.match(detail, /Activity · last 2 of 7/);
    assert.match(detail, /#6 ✓ read_file · completed/);
    assert.match(detail, /#7 ⠋ shell_command · running/);
    assert.match(detail, /Enter inspect/);

    state.status = 'completed';
    state.finishedAt = new Date().toISOString();
    state.actionLedger[0].status = 'succeeded';
    state.attempts[0].status = 'succeeded';
    state.activeAgents = {};
    state.outputs.fan = { ok: true, outputText: '{\n  "result": "verified"\n}' };
    writeFileSync(statePath, JSON.stringify(state));
    const completed = renderWorkflowTui(dashboardRows(home)[0] ?? { state }, {
      width: 120, height: 30, focus: 2,
    });
    assert.match(completed, /1\/1 workers · .* · done/);
    assert.match(completed, /Outcome/);
    assert.match(completed, /"result": "verified"/);
    const completedOverview = renderWorkflowTui(dashboardRows(home)[0] ?? { state }, { width: 120, height: 30 });
    assert.match(completedOverview, /No agents running · workflow finished/);
    assert.match(completedOverview, /Workflow finished · result ready/);
    assert.doesNotMatch(completedOverview, /workflow is terminal|stable result envelope/);
    state.status = 'blocked';
    writeFileSync(statePath, JSON.stringify(state));
    const blockedOverview = renderWorkflowTui(dashboardRows(home)[0] ?? { state }, { width: 120, height: 30 });
    assert.match(blockedOverview, /No agents running · workflow stopped with blockers/);
    assert.match(blockedOverview, /Workflow stopped with blockers · review blockers and partial work/);
    assert.doesNotMatch(blockedOverview, /result ready/i);
  } finally { cleanup(); }
});

test('narrow workflow view uses one full-width phase, agent, or activity pane', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.currentPhase = { index: 0, name: 'review', total: 1 };
    state.actionLedger = [{ id: 'fan', phase: 'review', kind: 'run', status: 'running', attempts: [0] }];
    state.attempts = [{
      actionId: 'fan', attemptNumber: 1, pool: 'grok', model: 'grok-4.6', status: 'running',
      usage: { tokens: { standardRead: 40, output: 12 } },
      lastActions: [{ kind: 'read_file', status: 'completed', summary: 'src/app.js' }],
    }];
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const timeline = renderWorkflowTui(row, { width: 80, height: 22, focus: 0 });
    const phases = renderWorkflowTui(row, { width: 80, height: 22, focus: 0, mobileTimeline: false });
    const agents = renderWorkflowTui(row, { width: 80, height: 22, focus: 1 });
    const detail = renderWorkflowTui(row, { width: 80, height: 22, focus: 2 });
    assert.match(timeline, /Workflow timeline/);
    assert.match(timeline, /t phases/);
    assert.match(phases, /Phases · 1/);
    assert.doesNotMatch(phases, /52 tok/);
    assert.match(agents, /review · 0\/1 complete/);
    assert.match(agents, /52 tok/);
    assert.doesNotMatch(agents, /Activity/);
    assert.match(detail, /fan · grok/);
    assert.match(detail, /Activity/);
    assert.doesNotMatch(detail, /Phases · 1/);
    for (const screen of [timeline, phases, agents, detail]) {
      const plain = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const overflow = plain.split('\n').filter((line) => line.length > 80);
      assert.deepEqual(overflow, []);
    }
  } finally { cleanup(); }
});

test('autonomous TUI presents one orchestrator thread outside execution phases', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.intent.autonomous = true;
    state.orchestration.mode = 'autonomous';
    state._doc = { phases: [{ name: 'autonomous-delivery', steps: [{ id: 'orchestrator', type: 'decide' }] }] };
    state.currentStep = { id: 'orchestrator', type: 'decide', phase: 'autonomous-delivery' };
    state.steps = [];
    state.actionLedger = [
      { id: 'orchestrator', phase: 'autonomous-delivery', kind: 'decide', status: 'running', attempts: [0, 2] },
      { id: 'inspect', phase: 'autonomous-delivery', kind: 'run', status: 'succeeded', attempts: [1] },
    ];
    state.attempts = [
      { actionId: 'orchestrator', attemptNumber: 1, pool: 'grok', model: 'grok-4.6', status: 'succeeded' },
      { actionId: 'inspect', attemptNumber: 1, pool: 'command-code', model: 'minimax/minimax-m3-free', status: 'succeeded' },
      { actionId: 'orchestrator', attemptNumber: 2, pool: 'grok', model: 'grok-4.6', status: 'running' },
    ];
    state.decisions = [{ sequence: 1, gateId: 'orchestrator', decision: 'needs_more_work', reason: 'Inspect then verify.' }];
    state.orchestration.conversations = { grok: { sessionId: 'thread-123', started: true } };
    state.activeAgents = { orchestrator: {
      stepId: 'orchestrator', pool: 'grok', model: 'grok-4.6', status: 'running',
      actionCount: 5,
      lastEventAt: new Date().toISOString(),
      outputBytesObserved: 12345,
      lastActions: [
        { kind: 'read_file', status: 'completed', summary: 'state.json' },
        { kind: 'response', status: 'completed', summary: 'needs_more_work' },
      ],
    } };
    writeFileSync(statePath, JSON.stringify(state));

    const row = dashboardRows(home)[0];
    const model = workflowPanelModel(row);
    assert.equal(model.orchestrator.status, 'planning');
    assert.equal(model.orchestrator.attempts.length, 2);
    assert.deepEqual(model.phases.map((phase) => phase.label), ['Autonomous Delivery']);
    assert.deepEqual(model.agents.map((agent) => agent.action.id), ['inspect']);

    const tui = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.match(tui, /Workflow Planner/);
    assert.match(tui, /\[Workflow Planner\].*planning/);
    assert.match(tui, /1\/1 workers/);
    assert.match(tui, /Autonomous Delivery 1\/1/);
    assert.doesNotMatch(tui, /orchestrator · grok · grok-4\.6 · #/);
    assert.match(renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 1 }), /⠙ \[Workflow Planner\]/);

    const control = renderWorkflowTui(row, {
      width: 120, height: 30, controlSelected: true,
    });
    assert.match(control, /Workflow Planner · planning/);
    assert.match(control, /⠋ planning · grok · grok-4\.6/);

    const thread = renderWorkflowTui(row, {
      width: 120, height: 60, controlSelected: true, orchestratorDetail: true,
    });
    assert.match(thread, /Workflow Planner · overview/);
    assert.match(thread, /Now · Choosing the next smallest useful action/);
    assert.match(thread, /Latest action · Response · Planner decision recorded/);
    assert.match(thread, /Live stream · event .* ago · 12345 bytes observed/);
    assert.match(thread, /Latest decision · Continue with bounded work/);
    assert.match(thread, /Why · Inspect then verify\./);
    assert.match(thread, /Press v for checkpoint prompts, sessions, usage, and artifact paths/);
    assert.doesNotMatch(thread, /Session · grok · thread-123 · resumable/);
    assert.doesNotMatch(thread, /Current checkpoint prompt/);
    assert.match(thread, /#4 ✓ Read file · state\.json/);
    assert.match(thread, /#5 ✓ Response · Planner decision recorded/);

    const technicalThread = renderWorkflowTui(row, {
      width: 120, height: 60, controlSelected: true, orchestratorDetail: true,
      orchestratorVerbose: true,
    });
    assert.match(technicalThread, /Workflow Planner · technical details/);
    assert.match(technicalThread, /Technical thread/);
    assert.match(technicalThread, /Session · grok · thread-123 · resumable/);
    assert.match(technicalThread, /Logical thread · 2 checkpoint turns/);
    assert.match(technicalThread, /decision: needs_more_work · Inspect then verify/);
    assert.match(technicalThread, /#4 ✓ read_file · completed/);
    assert.match(technicalThread, /#5 ✓ response · completed/);

    state.outputs.inspect = { ok: false, why: 'verify json returned ok:false' };
    writeFileSync(statePath, JSON.stringify(state));
    const semanticFailure = renderWorkflowTui(dashboardRows(home)[0], { width: 120, height: 30 });
    assert.match(semanticFailure, /1 ✗ Autonomous Delivery 1\/1/);
    const semanticFailureAgents = renderWorkflowTui(dashboardRows(home)[0], { width: 120, height: 30, focus: 1 });
    assert.match(semanticFailureAgents, /✗ inspect · command-code/);

    state.attempts[2].status = 'succeeded';
    state.outputs.inspect = { ok: true, why: 'verified' };
    state.activeAgents = { repair: {
      stepId: 'repair', pool: 'command-code', model: 'minimax/minimax-m3-free', status: 'running',
    } };
    writeFileSync(statePath, JSON.stringify(state));
    const waiting = renderWorkflowTui(dashboardRows(home)[0], {
      width: 120, height: 30, controlSelected: true,
    });
    assert.match(waiting, /Workflow Planner · directing execution/);
    assert.match(waiting, /1 ✓ Autonomous Delivery 1\/1/);
  } finally { cleanup(); }
});

test('workflow overview separates timestamped history from live planner and worker activity', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.startedAt = '2026-08-29T00:00:00.000Z';
    state.intent.autonomous = true;
    state.orchestration.mode = 'autonomous';
    state._doc = { phases: [{ name: 'autonomous-delivery', steps: [
      { id: 'scout', type: 'run' },
      { id: 'orchestrator', type: 'decide' },
    ] }] };
    state.currentStep = { id: 'implement-b', type: 'run', phase: 'implement' };
    state.actionLedger = [
      { id: 'scout', phase: 'autonomous-delivery', kind: 'run', status: 'succeeded', attempts: [0] },
      { id: 'orchestrator', phase: 'autonomous-delivery', kind: 'decide', status: 'succeeded', attempts: [1] },
      { id: 'discover-a', phase: 'discover', kind: 'run', status: 'succeeded', attempts: [2] },
      { id: 'discover-b', phase: 'discover', kind: 'run', status: 'succeeded', attempts: [3] },
      { id: 'implement-a', phase: 'implement', kind: 'run', status: 'succeeded', attempts: [4] },
      { id: 'implement-b', phase: 'implement', kind: 'run', status: 'running', attempts: [5] },
      { id: 'verify-all', phase: 'verify', kind: 'verify', status: 'pending', dependsOn: ['implement-b'], attempts: [] },
    ];
    state.attempts = [
      { actionId: 'scout', pool: 'opencode2', model: 'gpt-5.6-luna', status: 'succeeded', startedAt: '2026-08-29T00:00:10.000Z', finishedAt: '2026-08-29T00:02:10.000Z', usage: { tokens: { totalKnown: 3300 } } },
      { actionId: 'orchestrator', pool: 'claude-code', model: 'opus-5', status: 'succeeded', startedAt: '2026-08-29T00:02:10.000Z', finishedAt: '2026-08-29T00:03:10.000Z' },
      { actionId: 'discover-a', pool: 'grok', model: 'grok-4.6', status: 'succeeded', startedAt: '2026-08-29T00:03:10.000Z', finishedAt: '2026-08-29T00:04:10.000Z' },
      { actionId: 'discover-b', pool: 'grok', model: 'grok-4.6', status: 'succeeded', startedAt: '2026-08-29T00:03:10.000Z', finishedAt: '2026-08-29T00:04:20.000Z' },
      { actionId: 'implement-a', pool: 'command-code', model: 'minimax-m3', status: 'succeeded', startedAt: '2026-08-29T00:04:20.000Z', finishedAt: '2026-08-29T00:05:20.000Z' },
      { actionId: 'implement-b', pool: 'command-code', model: 'minimax-m3', status: 'running', startedAt: '2026-08-29T00:04:20.000Z' },
    ];
    state.outputs = {
      scout: { ok: true },
      'discover-a': { ok: true },
      'discover-b': { ok: true },
      'implement-a': { ok: true },
    };
    state.decisions = [{ gateId: 'orchestrator', decision: 'needs_more_work', reason: 'Discover, implement, then independently verify.' }];
    state.activeAgents = { 'implement-b': {
      stepId: 'implement-b', pool: 'command-code', model: 'minimax-m3', status: 'running',
      startedAt: '2026-08-29T00:04:20.000Z', lastEventAt: new Date().toISOString(), outputBytesObserved: 83968,
      lastActions: [{ kind: 'write_file', status: 'running', summary: 'src/workflow/result.js' }],
    } };
    writeFileSync(statePath, JSON.stringify(state));

    const row = dashboardRows(home)[0];
    const overview = renderWorkflowTui(row, { width: 140, height: 54 });
    assert.match(overview, /Workflow timeline · \d+ milestones?/);
    assert.match(overview, /\d{2}:\d{2}  ● \[Preflight: Scout\] started/);
    assert.match(overview, /\d{2}:\d{2}  ✓ \[Preflight: Scout\] completed/);
    assert.match(overview, /\d{2}:\d{2}  ◆ \[Workflow Planner\] plan created/);
    assert.match(overview, /\d{2}:\d{2}  ├─ \[Phase: Discover\] started/);
    assert.match(overview, /\d{2}:\d{2}  └─✓ \[Phase: Discover\] completed/);
    assert.match(overview, /\d{2}:\d{2}  ├─ \[Phase: Implement\] started/);
    assert.doesNotMatch(overview, /\[Phase: Implement\] completed/);
    assert.match(overview, /Live · 1 running · 1 waiting/);
    assert.match(overview, /⧖ \[Workflow Planner\].*waiting/);
    assert.match(overview, /⠋ implement-b · command-code · minimax-m3/);
    assert.match(overview, /Write file · src\/workflow\/result\.js/);
    assert.match(overview, /○ \[Phase: Verify\] · verify-all · waiting for implement-b/);
    assert.doesNotMatch(overview, /Autonomous Delivery/);
    // worker rows name their phase: concurrent phases interleave in time order
    assert.match(overview, /├─✓ \[Discover\] discover-a/);
    assert.match(overview, /└─✓ \[Discover\] discover-b/);
    assert.match(overview, /├─✓ \[Implement\] implement-a/);
    // the header never exceeds the width, down to 20 columns
    for (const width of [20, 28, 37]) {
      const narrowLines = renderWorkflowTui(row, { width, height: 22 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
      assert.ok(narrowLines.every((line) => [...line].length <= width), `width ${width}: ${narrowLines.find((line) => [...line].length > width)}`);
      assert.doesNotMatch(narrowLines.at(-1), /PgUp/);
    }
    // a phase whose actions never started (blocked tail) still appears, labelled blocked
    state.actionLedger.push(
      { id: 'report', phase: 'report', kind: 'run', status: 'failed', dependsOn: ['verify-all'], attempts: [], finishedAt: '2026-08-29T00:06:00.000Z' },
      { id: 'verify-report', phase: 'report', kind: 'verify', status: 'failed', dependsOn: ['report'], attempts: [], finishedAt: '2026-08-29T00:06:00.000Z' },
    );
    state.outputs.report = { ok: false, dependencyBlocked: true };
    state.outputs['verify-report'] = { ok: false, dependencyBlocked: true };
    writeFileSync(statePath, JSON.stringify(state));
    const blocked = renderWorkflowTui(dashboardRows(home)[0], { width: 140, height: 54 });
    assert.match(blocked, /\d{2}:\d{2}  ⊘ \[Phase: Report\] skipped\s+2 actions not run/);
    assert.match(blocked, /Required earlier work did not pass; the planner chose a recovery path/);
    assert.doesNotMatch(blocked, /\[Report\] verify-report|\[Phase: Report\] completed/);
    const plain = overview.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const plainBlocked = blocked.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    for (const rendered of [plain, plainBlocked]) {
      assert.doesNotMatch(rendered, /\[Workflow Planner\] plan created[^]*?\n\s*\n[^]*?\[Phase: Discover\] started/);
    }
    assert.deepEqual(plain.split('\n').filter((line) => line.length > 140), []);

    const technical = renderWorkflowTui(row, { width: 140, height: 36, workflowVerbose: true });
    assert.match(technical, /Workflow technical details/);
    assert.match(technical, /Action ledger/);
    assert.match(technical, /\[Workflow Planner\] · decide/);
  } finally { cleanup(); }
});

test('planner retries do not shift accepted decisions onto rejected attempts', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.intent.autonomous = true;
    state.startedAt = '2026-08-29T00:00:00.000Z';
    state.orchestration.mode = 'autonomous';
    state._doc = { phases: [{ name: 'autonomous-delivery', steps: [{ id: 'orchestrator', type: 'decide' }] }] };
    state.actionLedger = [{ id: 'orchestrator', phase: 'autonomous-delivery', kind: 'decide', status: 'succeeded', attempts: [0, 1, 2, 3] }];
    state.attempts = [
      { actionId: 'orchestrator', status: 'succeeded', startedAt: '2026-08-29T00:00:00.000Z', finishedAt: '2026-08-29T00:00:30.000Z', outFile: '/tmp/rejected.json' },
      { actionId: 'orchestrator', status: 'succeeded', startedAt: '2026-08-29T00:00:31.000Z', finishedAt: '2026-08-29T00:01:00.000Z', outFile: '/tmp/accepted.json' },
      { actionId: 'orchestrator', status: 'succeeded', startedAt: '2026-08-29T00:01:01.000Z', finishedAt: '2026-08-29T00:01:30.000Z', outFile: '/tmp/updated.json' },
      { actionId: 'orchestrator', status: 'succeeded', startedAt: '2026-08-29T00:01:31.000Z', finishedAt: '2026-08-29T00:02:00.000Z', outFile: '/tmp/complete.json' },
    ];
    state.decisions = [
      { sequence: 1, artifact: '/tmp/accepted.json', createdAt: '2026-08-29T00:00:59.000Z', decision: 'needs_more_work', reason: 'Accepted plan belongs to the second turn.' },
      { sequence: 2, artifact: '/tmp/updated.json', createdAt: '2026-08-29T00:01:29.000Z', decision: 'needs_more_work', reason: 'The plan gained one bounded verification action.' },
      { sequence: 3, artifact: '/tmp/complete.json', createdAt: '2026-08-29T00:01:59.000Z', decision: 'complete', reason: 'All required work is independently verified.' },
    ];
    writeFileSync(statePath, JSON.stringify(state));
    appendEvent(join(home, 'workflows', 'wf-test'), state, 'decision.rejected', {
      gateId: 'orchestrator', why: 'First response did not match the decision schema.',
    });
    writeFileSync(statePath, JSON.stringify(state));

    const row = dashboardRows(home)[0];
    row.events = readEvents(join(home, 'workflows', 'wf-test'));
    const tui = renderWorkflowTui(row, { width: 140, height: 45 });
    assert.match(tui, /planning retry #1.*No accepted decision; correction or retry turn/s);
    assert.match(tui, /decision rejected.*First response did not match the decision schema/s);
    assert.match(tui, /plan created.*Accepted plan belongs to the second turn/s);
    assert.match(tui, /plan updated #2.*The plan gained one bounded verification action/s);
    assert.match(tui, /completion confirmed.*All required work is independently verified/s);
  } finally { cleanup(); }
});

test('workflow TUI honors terminal widths below the previous 38-column floor', () => {
  const { home, cleanup } = fixture();
  try {
    const row = dashboardRows(home)[0];
    for (const width of [20, 28, 37]) {
      const plain = renderWorkflowTui(row, { width, height: 20 })
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      assert.equal(Math.max(...plain.split('\n').map((line) => line.length)) <= width, true);
    }
  } finally { cleanup(); }
});

test('interactive TUI uses alternate screen and q only detaches the viewer', async () => {
  const { home, cleanup } = fixture();
  try {
    class FakeInput extends EventEmitter {
      isTTY = true;
      rawModes = [];
      setRawMode(value) { this.rawModes.push(value); }
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 110;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = runDashboard(home, { token: 'abc234', input, output, refreshMs: 60_000 });
    input.emit('data', Buffer.from('\r')); // phase -> agent
    input.emit('data', Buffer.from('\r')); // agent -> detail
    input.emit('data', Buffer.from('\u001b')); // detail -> agent
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.match(output.text, /\x1b\[\?1049h/);
    assert.match(output.text, /\x1b\[\?1049l/);
    assert.match(output.text, /Agents · r refresh/);
    assert.match(output.text, /No agent has started in this phase yet/);
    const state = JSON.parse(readFileSync(join(home, 'workflows', 'wf-test', 'state.json')));
    assert.equal(state.cancelRequested, undefined);
  } finally { cleanup(); }
});

test('narrow interactive TUI opens on the timeline and t toggles the phase browser', async () => {
  const { home, cleanup } = fixture();
  try {
    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 80;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = runDashboard(home, { token: 'abc234', input, output, refreshMs: 60_000 });
    const timelineText = output.text;
    input.emit('data', Buffer.from('t'));
    const phasesText = output.text;
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.match(timelineText, /Workflow timeline/);
    assert.match(timelineText, /t phases/);
    assert.match(phasesText, /Phases · 1/);
    assert.match(phasesText, /t timeline/);
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

test('a torn state.json (writer mid-write) never crashes the observation paths', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    // Overwrite with a mid-write snapshot cut inside a string — the exact
    // shape of the observed `workflow tui` crash (2026-08-29).
    writeFileSync(statePath, '{"runId":"wf-test","shortId":"abc234","status":"running","intent":{"goal":"do the th');
    assert.doesNotThrow(() => dashboardRows(home));
    const shown = dashboardJson(home, { token: 'wf-test' });
    assert.equal(shown.action, 'show');
    assert.equal(shown.state, null);
    // Mutating paths must refuse loudly rather than silently no-op.
    assert.throws(() => requestCancel(home, 'wf-test'), /unreadable.*retry the command/s);
  } finally { cleanup(); }
});

test('an action being re-run reads as running, and its phase as active, despite an earlier failed round', () => {
  const state = {
    intent: { autonomous: true },
    orchestration: { mode: 'autonomous' },
    decisions: [{ gateId: 'orchestrator' }],
    actionLedger: [
      { id: 'verify-docs', phase: 'g:verify-docs', kind: 'verify', status: 'running', attempts: [] },
      { id: 'verify-impl', phase: 'g:verify-impl', kind: 'verify', status: 'failed', attempts: [] },
    ],
    outputs: { 'verify-docs': { ok: false }, 'verify-impl': { ok: false } },
    activeAgents: { a1: { stepId: 'verify-docs', pool: 'p1' } },
    _doc: { phases: [] },
  };
  const model = workflowPanelModel({ state, events: [] });
  const reRunning = model.phases.find((phase) => phase.name === 'g:verify-docs');
  const trulyFailed = model.phases.find((phase) => phase.name === 'g:verify-impl');
  // Failed round + attempt still spinning => the phase is active, not failed
  // (user report 2026-08-29: TUI showed ✗ "2/2 complete" beside a spinner).
  assert.equal(reRunning.status, 'active');
  assert.equal(reRunning.completed, 0);
  // No active agent => the failure is real and stays failed.
  assert.equal(trulyFailed.status, 'failed');
});

test('timeline calls dependency-blocked phases skipped and excludes stale completed agents from Live', () => {
  const startedAt = '2026-08-30T03:28:00.000Z';
  const finishedAt = '2026-08-30T03:29:00.000Z';
  const state = {
    runId: 'wf-blocked', shortId: 'blk234', workflow: 'blocked-recovery', status: 'running', startedAt,
    intent: { autonomous: true, goal: 'Recover after a rejected check.' },
    orchestration: { mode: 'autonomous', selectedPool: 'codex', selectedModel: 'gpt-5.6-sol' },
    decisions: [{ gateId: 'orchestrator', decision: 'needs_more_work', actions: [] }],
    actionLedger: [
      { id: 'verify-full-suite', phase: 'g:acceptance', kind: 'verify', status: 'failed_terminal', finishedAt, attempts: [] },
      { id: 'report', phase: 'g:report', kind: 'run', status: 'failed_terminal', finishedAt, attempts: [] },
    ],
    outputs: {
      'verify-full-suite': { ok: false, dependencyBlocked: true },
      report: { ok: false, dependencyBlocked: true },
    },
    activeAgents: {
      stale: { stepId: 'verify-docs', pool: 'opencode2', model: 'luna', status: 'completed' },
      live: { stepId: 'repair', pool: 'opencode2', model: 'luna', status: 'running' },
    },
    _doc: { phases: [] },
  };
  const screen = renderWorkflowTui({ state, events: [] }, { width: 120, height: 34 });
  assert.match(screen, /\[Phase: Acceptance\] skipped/);
  assert.match(screen, /\[Phase: Report\] skipped/);
  assert.match(screen, /Required earlier work did not pass; the planner chose a recovery path/);
  assert.doesNotMatch(screen, /\[Phase: (Acceptance|Report)\] completed/);
  assert.match(screen, /Live · 1 running · 1 waiting/);
  assert.match(screen, /repair · opencode2 · luna/);
  assert.doesNotMatch(screen, /verify-docs · opencode2/);
});
