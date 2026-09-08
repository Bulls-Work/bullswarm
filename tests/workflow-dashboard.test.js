import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dashboardRows, renderDashboard, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, actionJson, decideApproval, runDashboard } from '../src/workflow/dashboard.js';
import { appendEvent, readEvents } from '../src/workflow/events.js';
import { cmdWorkflow } from '../src/workflow/cli.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

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

function addHistoricalRun(home) {
  const dir = join(home, 'workflows', 'wf-done');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    runId: 'wf-done', shortId: 'def345', workflow: 'docs-audit',
    startedAt: '2026-08-30T01:00:00.000Z', finishedAt: '2026-08-30T01:05:00.000Z',
    status: 'completed_with_concerns', stage: 'delivered',
    intent: { goal: 'Audit documentation freshness.' },
    outcome: { concerns: ['One stale example remains.'] },
    actionLedger: [{ id: 'audit', phase: 'audit', kind: 'run', status: 'succeeded', attempts: [0] }],
    attempts: [{
      actionId: 'audit', attemptNumber: 1, pool: 'opencode2', model: 'luna',
      status: 'succeeded', startedAt: '2026-08-30T01:00:00.000Z', finishedAt: '2026-08-30T01:05:00.000Z',
    }],
    steps: [{ phase: 'audit', stepId: 'audit', ok: true }],
    outputs: { audit: { ok: true, outputText: 'Audit complete.' } },
  }));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ status: 'completed_with_concerns' }));
}

function addV2HistoricalRun(home) {
  const dir = join(home, 'workflows', 'wf-v2-newer');
  mkdirSync(dir, { recursive: true });
  const goal = createV2GoalDocument({
    goal: 'Newer V2 dashboard run.',
    cwd: home,
    requirements: [{ id: 'inspect', text: 'Inspect the workflow.', mandatory: true }],
  });
  const state = createV2State(goal, { runId: 'wf-v2-newer', shortId: 'v2n456' });
  state.lifecycle = {
    status: 'completed',
    startedAt: '2026-08-30T02:00:00.000Z',
    finishedAt: '2026-08-30T02:05:00.000Z',
    resultFile: null,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Timeline redesign: the overview timeline groups events under phase segment
// headers shaped `── Implement ──────── 2m10s ──` instead of prefixing every
// event line with `[Phase: ...]`. A phase re-opened after another phase ran in
// between reads `── Implement · continued ── …`, and a viewport that starts mid
// segment re-emits that continuation header. The helpers below read the
// timeline pane structurally so the assertions never depend on dash padding,
// panel geometry, or the terminal width in use.
// ---------------------------------------------------------------------------

function timelinePaneRows(screen) {
  const rows = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
  const top = rows.findIndex((line) => line.includes('Workflow timeline ·'));
  if (top < 0) return [];
  const left = rows[top].indexOf('┌ Workflow timeline');
  const pane = [];
  for (const line of rows.slice(top + 1)) {
    const cell = line.slice(left);
    if (!cell.startsWith('│')) break; // the Live divider closes the timeline pane
    pane.push(cell.replace(/^│/, '').replace(/│$/, '').trimEnd());
  }
  return pane;
}

function timelineSegments(screen) {
  const segments = [];
  for (const line of timelinePaneRows(screen)) {
    const header = /^─{2,}\s+(.+?)\s+─{2,}\s+(\S+)\s+─+$/.exec(line);
    if (header) segments.push({ label: header[1].replace(/^Phase \d+ · /, ''), elapsed: header[2], rows: [] });
    else if (/^─{2,}/.test(line)) segments.push({ label: line.replace(/─+/g, ' ').trim().replace(/^Phase \d+ · /, ''), elapsed: null, rows: [] });
    else if (segments.length && line.trim()) segments[segments.length - 1].rows.push(line);
  }
  return segments;
}

function segmentLabels(screen) {
  return timelineSegments(screen).map((segment) => segment.label);
}

function normalizeRow(line) {
  return line.replace(/^\d{2}:\d{2}/, 'HH:MM').replace(/\s+/g, ' ').trim();
}

function segmentRows(screen, label) {
  return timelineSegments(screen)
    .filter((segment) => segment.label === label)
    .flatMap((segment) => segment.rows);
}

const iso = (seconds, base = '2026-08-29T00:00:00.000Z') =>
  new Date(Date.parse(base) + seconds * 1000).toISOString();

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

test('V2 dashboard renders durable presentation stages, dense timeline, live filtering, and plain next step', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2-'));
  try {
    const runId = 'wf-v2dash-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2d234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    state.presentation.stages[0].startedAt = iso(2);
    state.presentation.stages[0].completedAt = iso(5);
    Object.assign(state.actions[0], { status: 'succeeded', startedAt: iso(2), finishedAt: iso(5), attempts: 1 });
    state.attempts.push({ id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: iso(5) });
    state.presentation.stages[1].startedAt = iso(6);
    Object.assign(state.actions[1], { status: 'running', startedAt: iso(6), attempts: 1 });
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay-2', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null, lastActivityAt: iso(7), outputBytesObserved: 42, lastAgentEvent: { at: iso(7), kind: 'tool', summary: 'node --test' } });
    const emit = (type, committedAt, payload) => appendEvent(dir, state, type, { ...payload, committedAt });
    emit('workflow.started', iso(0), {});
    emit('planner.finished', iso(1), { turn: 1, ok: true, summary: 'Implement then collect independent evidence.' });
    emit('presentation.stage_started', iso(2), { stageId: 'r1-implementation', label: 'Implementation' });
    emit('action.finished', iso(5), { actionId: 'implement-result', status: 'succeeded' });
    emit('presentation.stage_completed', iso(5), { stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1 });
    emit('presentation.stage_started', iso(6), { stageId: 'r1-evidence', label: 'Evidence' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const screen = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.match(screen, /\[Workflow Planner\] plan created/);
    assert.match(screen, /── Phase 1 · Implementation/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /├─ started/);
    assert.match(segmentRows(screen, 'Implementation').join('\n'), /└─✓ completed/);
    assert.match(screen, /── Phase 2 · Evidence/);
    assert.doesNotMatch(timelinePaneRows(screen).join('\n'), /\[Phase:/);
    assert.match(screen, /check-result · relay-2 · gpt-5\.6-luna/);
    assert.doesNotMatch(screen, /Live[^]*implement-result · relay/);
    assert.match(screen, /Waiting for 1 worker/);
    assert.equal(workflowPanelModel(row).phases[0].name, 'r1-implementation');
    const narrowTimeline = renderWorkflowTui(row, { width: 60, height: 26, focus: 0 });
    const narrowPhases = renderWorkflowTui(row, { width: 60, height: 26, focus: 0, mobileTimeline: false });
    const narrowAgents = renderWorkflowTui(row, { width: 60, height: 26, focus: 1 });
    assert.match(narrowTimeline, /Workflow timeline/);
    assert.doesNotMatch(narrowTimeline, /Phases · 2/);
    assert.match(narrowPhases, /Phases · 2/);
    assert.doesNotMatch(narrowPhases, /Workflow timeline/);
    assert.match(narrowAgents, /Evidence · 0\/1 complete/);
    assert.doesNotMatch(narrowAgents, /Workflow timeline/);
    const cancelled = requestCancel(home, 'v2d234', { source: 'test', requesterPid: 1234 });
    assert.equal(cancelled.state.cancellation.requested, true);
    assert.equal(cancelled.state.cancellation.source, 'test');
    assert.equal(cancelled.state.cancellation.requesterPid, 1234);
    const cancellationEvent = readEvents(join(home, 'workflows', 'wf-v2dash-abcdef'))
      .find((event) => event.type === 'workflow.cancellation_requested');
    assert.equal(cancellationEvent.payload.source, 'test');
    assert.equal(cancellationEvent.payload.requesterPid, 1234);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unified dashboard lists active before recent runs and renders a selected-run preview', () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    const active = dashboardRows(home);
    const all = dashboardRows(home, { all: true });
    assert.equal(active.length, 1);
    assert.deepEqual(all.map((row) => row.shortId), ['abc234', 'def345']);

    const desktop = renderDashboard({
      rows: all, allRows: all, selected: 1, previewRow: all[1],
      filter: 'all', width: 120, height: 30,
    });
    assert.match(desktop, /1 active · 0 waiting · 1 recent/);
    assert.match(desktop, /def345 · docs-audit/);
    assert.match(desktop, /1 concern/);
    assert.match(desktop, /Workflow timeline/);

    const mobile = renderDashboard({
      rows: all, allRows: all, selected: 0, previewRow: all[0],
      filter: 'all', width: 60, height: 24,
    });
    assert.match(mobile, /Runs · all/);
    assert.match(mobile, /abc234 · audit-files/);
    assert.match(mobile, /def345 · docs-audit/);
    assert.doesNotMatch(mobile, /Workflow timeline/);
    assert.match(mobile, /Enter open · \/ filter · a active\/all/);
    const plain = mobile.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.equal(Math.max(...plain.split('\n').map((line) => line.length)) <= 60, true);
  } finally { cleanup(); }
});

test('all-runs ordering uses the V2 lifecycle start time and keeps the initial list layout', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    const all = dashboardRows(home, { all: true });
    assert.deepEqual(all.map((row) => row.shortId), ['abc234', 'v2n456', 'def345']);

    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 60;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = cmdWorkflow([], { bullswarmDir: home, input, output });
    assert.match(output.text, /Runs · active/);
    assert.match(output.text, /abc234 · audit-files/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('direct V2 run IDs initially select the unified list shell before drilldown', async () => {
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 120;
      rows = 30;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = runDashboard(home, { token: 'v2n456', input, output, refreshMs: 60_000 });
    assert.match(output.text, /Runs · all/);
    assert.match(output.text, /v2n456 · Newer V2 dashboard run/);
    assert.match(output.text, /Workflow timeline/);
    input.emit('data', Buffer.from('\r'));
    assert.match(output.text, /Phases ·/);
    input.emit('data', Buffer.from('\u001b'));
    assert.match(output.text, /Runs · all/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('recent-list V2 selection opens the unified overview before phase drilldown', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 120;
      rows = 30;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = cmdWorkflow([], { bullswarmDir: home, input, output });

    input.emit('data', Buffer.from('a')); // active -> all
    input.emit('data', Buffer.from('\u001b[B')); // active run -> newer V2 run
    assert.match(output.text, /Runs · all/);
    assert.match(output.text, /v2n456 · Newer V2 dashboard run/);
    input.emit('data', Buffer.from('\r'));
    assert.match(output.text, /Phases ·/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('live dashboard navigation preserves V2 drilldowns, mobile panes, and empty active fallback', async () => {
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);

    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns;
      rows = 30;
      text = '';
      constructor(columns) { super(); this.columns = columns; }
      write(chunk) { this.text += chunk; }
    }
    const session = (columns, token = 'v2n456') => {
      const input = new FakeInput();
      const output = new FakeOutput(columns);
      const running = runDashboard(home, { token, input, output, refreshMs: 60_000 });
      const press = (key) => {
        const before = output.text.length;
        input.emit('data', Buffer.from(key));
        return output.text.slice(before);
      };
      return { press, quit: () => { press('q'); return running; } };
    };

    // Desktop: list -> phase/agent detail -> planner -> technical planner.
    const desktop = session(120);
    assert.match(desktop.press('\r'), /Phases ·/);
    assert.match(desktop.press('o'), /Workflow Planner · overview/);
    assert.match(desktop.press('v'), /Workflow Planner · technical details/);
    assert.equal(await desktop.quit(), 0);

    // Mobile: the selected run opens on the timeline, then t exposes phases.
    const mobile = session(80);
    assert.match(mobile.press('\r'), /Workflow timeline/);
    assert.match(mobile.press('t'), /Phases ·/);
    assert.doesNotMatch(mobile.press('t'), /Phases ·/);
    assert.match(mobile.press('t'), /Phases ·/);
    assert.equal(await mobile.quit(), 0);

    // Bare active view: no active rows show the explicit recent-runs escape.
    const emptyHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-empty-'));
    addV2HistoricalRun(emptyHome);
    const input = new FakeInput();
    const output = new FakeOutput(120);
    const running = runDashboard(emptyHome, { input, output, refreshMs: 60_000 });
    assert.match(output.text, /Press a to browse recent runs\./);
    input.emit('data', Buffer.from('a'));
    assert.match(output.text, /Runs · all/);
    assert.match(output.text, /v2n456 · Newer V2 dashboard run/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    rmSync(emptyHome, { recursive: true, force: true });
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
    assert.match(printed, /Workflow timeline/);
    assert.match(printed, /── Preflight/);
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
     assert.match(detail, /Enter open/);

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
    state.status = 'completed_with_concerns';
    state.outcome = { concerns: ['one', 'two'] };
    writeFileSync(statePath, JSON.stringify(state));
    const concernsOverview = renderWorkflowTui(dashboardRows(home)[0] ?? { state }, { width: 120, height: 30 });
    assert.match(concernsOverview, /No agents running · workflow finished with 2 concerns/);
    assert.match(concernsOverview, /Workflow finished with 2 concerns · review 2 concerns in result/);
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
    // the timeline names each phase once, in a segment header, instead of
    // prefixing every event line with `[Phase: ...]`
    assert.deepEqual(segmentLabels(overview), ['Preflight', 'Discover', 'Implement']);
    const preflightRows = segmentRows(overview, 'Preflight').join('\n');
    assert.match(preflightRows, /\d{2}:\d{2}  ● Scout started/);
    assert.match(preflightRows, /\d{2}:\d{2}  ✓ Scout completed/);
    assert.match(preflightRows, /\d{2}:\d{2}  ◆ \[Workflow Planner\] plan created/);
    assert.match(segmentRows(overview, 'Discover').join('\n'), /\d{2}:\d{2}  ├─ started/);
    assert.match(segmentRows(overview, 'Discover').join('\n'), /\d{2}:\d{2}  └─✓ completed/);
    assert.match(segmentRows(overview, 'Implement').join('\n'), /\d{2}:\d{2}  ├─ started/);
    assert.deepEqual(segmentRows(overview, 'Implement').filter((line) => line.includes('completed')), []);
    assert.deepEqual(timelinePaneRows(overview).filter((line) => line.includes('[Phase:')), []);
    assert.match(overview, /Live · 1 running · 1 waiting/);
    assert.match(overview, /⧖ \[Workflow Planner\].*waiting/);
    assert.match(overview, /⠋ implement-b · command-code · minimax-m3/);
    assert.match(overview, /Write file · src\/workflow\/result\.js/);
    assert.match(overview, /○ \[Phase: Verify\] · verify-all · waiting for implement-b/);
    assert.doesNotMatch(overview, /Autonomous Delivery/);
    // worker rows sit under their own phase segment: concurrent phases still
    // interleave in time order
    assert.match(segmentRows(overview, 'Discover').join('\n'), /├─✓ discover-a/);
    assert.match(segmentRows(overview, 'Discover').join('\n'), /└─✓ discover-b/);
    assert.match(segmentRows(overview, 'Implement').join('\n'), /├─✓ implement-a/);
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
    assert.match(segmentRows(blocked, 'Report').join('\n'), /\d{2}:\d{2}  ⊘ skipped\s+2 actions not run/);
    assert.match(blocked, /Required earlier work did not pass; the planner chose a recovery path/);
    assert.doesNotMatch(segmentRows(blocked, 'Report').join('\n'), /verify-report|completed/);
    assert.deepEqual(timelinePaneRows(blocked).filter((line) => line.includes('[Phase:')), []);
    const plain = overview.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const plainBlocked = blocked.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    // the planner turn and the phase that follows it are separated by a segment
    // header, never by a bare blank gap
    for (const rendered of [overview, blocked]) {
      const pane = timelinePaneRows(rendered);
      pane.forEach((line, index) => {
        if (line.trim() || index === pane.length - 1) return;
        assert.ok(!pane[index + 1].trim() || /^─{2,}/.test(pane[index + 1]),
          `blank timeline row ${index} is not a segment separator: ${pane[index + 1]}`);
      });
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

test('bare workflow dashboard navigates active and recent runs on mobile', async () => {
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    class FakeInput extends EventEmitter {
      isTTY = true;
      rawModes = [];
      setRawMode(value) { this.rawModes.push(value); }
      resume() {}
      pause() {}
    }
    class FakeOutput extends EventEmitter {
      isTTY = true;
      columns = 60;
      rows = 26;
      text = '';
      write(chunk) { this.text += chunk; }
    }
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = cmdWorkflow([], { bullswarmDir: home, input, output });
    input.emit('data', Buffer.from('a')); // active -> all
    input.emit('data', Buffer.from('\u001b[B')); // select historical
    input.emit('data', Buffer.from('\r')); // open timeline
    input.emit('data', Buffer.from('\u001b')); // back to runs
    input.emit('data', Buffer.from('/'));
    input.emit('data', Buffer.from('docs'));
    input.emit('data', Buffer.from('\r'));
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.match(output.text, /Runs · all/);
    assert.match(output.text, /def345 · docs-audit/);
    assert.match(output.text, /Workflow timeline/);
    assert.match(output.text, /Showing workflows matching “docs”/);
     assert.match(output.text, /Enter open · \/ filter · a active\/all · q detach/);
    assert.match(output.text, /\x1b\[\?1049l/);
  } finally { cleanup(); }
});

test('interactive TUI repaints spinner frames in place without clearing the screen', async () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.currentPhase = { index: 0, name: 'review', total: 1 };
    state.actionLedger = [{ id: 'fan', phase: 'review', kind: 'run', status: 'running', attempts: [0] }];
    state.attempts = [{
      actionId: 'fan', attemptNumber: 1, pool: 'grok', model: 'grok-4.6', status: 'running',
      startedAt: new Date().toISOString(),
    }];
    state.activeAgents = { fan: {
      stepId: 'fan', pool: 'grok', model: 'grok-4.6', attempt: 1, status: 'running',
      startedAt: new Date().toISOString(),
    } };
    writeFileSync(statePath, JSON.stringify(state));

    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode() {}
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
    const running = runDashboard(home, {
      token: 'abc234', input, output, refreshMs: 60_000, spinnerMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.equal((output.text.match(/\x1b\[2J/g) ?? []).length, 1, 'alternate screen is cleared only once');
    assert.ok((output.text.match(/\x1b\[H/g) ?? []).length >= 3, 'spinner frames repaint from cursor home');
    assert.ok((output.text.match(/\x1b\[K/g) ?? []).length >= output.rows, 'each row clears only its stale tail');
  } finally { cleanup(); }
});

test('narrow interactive TUI opens on the timeline and t toggles the phase browser', async () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    Object.assign(state, {
      startedAt: iso(0), finishedAt: iso(120), status: 'completed',
      intent: { ...state.intent, autonomous: true },
      orchestration: { ...state.orchestration, mode: 'autonomous' },
      decisions: [{ gateId: 'orchestrator', decision: 'complete', reason: 'All phases passed.' }],
      actionLedger: [
        { id: 'discover-files', phase: 'discover', kind: 'run', status: 'succeeded', startedAt: iso(10), finishedAt: iso(40), attempts: [0] },
        { id: 'verify-files', phase: 'verify', kind: 'run', status: 'succeeded', startedAt: iso(50), finishedAt: iso(110), attempts: [1] },
      ],
      attempts: [
        { actionId: 'discover-files', status: 'succeeded', pool: 'luna', startedAt: iso(10), finishedAt: iso(40) },
        { actionId: 'verify-files', status: 'succeeded', pool: 'luna', startedAt: iso(50), finishedAt: iso(110) },
        { actionId: 'orchestrator', status: 'succeeded', pool: 'luna', startedAt: iso(1), finishedAt: iso(5) },
      ],
      outputs: { 'discover-files': { ok: true }, 'verify-files': { ok: true } },
      steps: [
        { phase: 'discover', stepId: 'discover-files', ok: true },
        { phase: 'verify', stepId: 'verify-files', ok: true },
      ],
    });
    writeFileSync(statePath, JSON.stringify(state));
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
    let frameStart = output.text.length;
    input.emit('data', Buffer.from('\x1b[B')); // first target: Preflight
    const preflightText = output.text.slice(frameStart);
    frameStart = output.text.length;
    input.emit('data', Buffer.from('\x1b[C')); // Preflight opens Workflow Planner
    const plannerText = output.text.slice(frameStart);
    input.emit('data', Buffer.from('\x1b')); // planner -> selected Preflight
    frameStart = output.text.length;
    input.emit('data', Buffer.from('\x1b[B')); // next target: Phase 1
    const focusedTimeline = output.text.slice(frameStart);
    frameStart = output.text.length;
    input.emit('data', Buffer.from('\x1b[C')); // open selected phase's agents
    const agentsText = output.text.slice(frameStart);
    input.emit('data', Buffer.from('\x1b')); // agents -> timeline
    input.emit('data', Buffer.from('t'));
    const phasesText = output.text;
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.match(timelineText, /Workflow timeline/);
    assert.match(timelineText, /t phases/);
    assert.match(timelineText, /↑ previous phase · ↓ next phase/);
    assert.match(timelineText, /Enter agents/);
    assert.doesNotMatch(timelineText, /t phases · t timeline/);
    assert.match(preflightText, /\x1b\[7m── Preflight/);
    assert.match(preflightText, /Enter planner/);
    assert.match(plannerText, /Workflow Planner · overview/);
    assert.match(focusedTimeline, /\x1b\[7m── Phase 1 · Discover/);
    assert.match(agentsText, /Discover · 1\/1 complete/);
    const visibleWidths = timelineText
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .split('\n')
      .filter((line) => line.includes('│') || line.includes('┐') || line.includes('┘'))
      .map((line) => line.length);
    assert.ok(visibleWidths.every((lineWidth) => lineWidth <= output.columns - 1), 'mobile frames reserve the terminal wrap column');
    assert.match(phasesText, /Phases · 2/);
    assert.match(phasesText, /t timeline/);
    assert.doesNotMatch(phasesText, /t phases · t timeline/);
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
  assert.deepEqual(segmentLabels(screen), ['Preflight', 'Acceptance', 'Report']);
  assert.match(segmentRows(screen, 'Acceptance').join('\n'), /⊘ skipped/);
  assert.match(segmentRows(screen, 'Report').join('\n'), /⊘ skipped/);
  assert.match(screen, /Required earlier work did not pass; the planner chose a recovery path/);
  assert.deepEqual(timelinePaneRows(screen).filter((line) => /completed|\[Phase:/.test(line)), []);
  assert.match(screen, /Live · 1 running · 1 waiting/);
  assert.match(screen, /repair · opencode2 · luna/);
  assert.doesNotMatch(screen, /verify-docs · opencode2/);
});

test('auto-follow starts at a timestamped milestone instead of an orphaned detail row', () => {
  const base = Date.parse('2026-08-30T03:00:00.000Z');
  const actions = Array.from({ length: 8 }, (_, index) => ({
    id: `work-${index}`, phase: `g:phase-${index}`, kind: 'run', status: 'succeeded',
    startedAt: new Date(base + index * 120_000).toISOString(),
    finishedAt: new Date(base + index * 120_000 + 60_000).toISOString(),
    attempts: [index],
  }));
  const state = {
    runId: 'wf-scroll', shortId: 'scr234', workflow: 'scroll-test', status: 'running',
    startedAt: new Date(base).toISOString(),
    intent: { autonomous: true, goal: 'Render enough milestones to scroll.' },
    orchestration: { mode: 'autonomous', selectedPool: 'codex', selectedModel: 'sol' },
    decisions: [{ gateId: 'orchestrator', decision: 'needs_more_work', actions: [] }],
    actionLedger: actions,
    attempts: actions.map((action) => ({
      actionId: action.id, status: 'succeeded', startedAt: action.startedAt, finishedAt: action.finishedAt,
    })),
    outputs: Object.fromEntries(actions.map((action) => [action.id, { ok: true }])),
    activeAgents: {}, _doc: { phases: [] },
  };
  const screen = renderWorkflowTui({ state, events: [] }, { width: 80, height: 22 });
  const rendered = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const pane = timelinePaneRows(screen);
  const marker = pane.findIndex((line) => line.includes('earlier timeline rows'));
  assert.ok(marker >= 0, rendered);
  // the viewport re-announces the segment it scrolled into, then resumes at a
  // timestamped milestone rather than an orphaned detail row
  assert.match(pane[marker + 1], /^─{2,}\s+.+ · continued\s+─{2,}/);
  assert.match(pane[marker + 2], /^\d{2}:\d{2}\s/);
  // auto-follow still ends on the newest milestone
  assert.match(segmentRows(screen, 'Phase 7').join('\n'), /└─✓ completed\s+1\/1/);
  assert.doesNotMatch(rendered, /newer timeline rows/);
});

function plain(screen) {
  return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// Modeled on the real delivered run wf-mtgr56l1-167281: an audit verification
// that failed and was superseded by a repair, and a final verification that
// never dispatched because that verify was still failed when it was scheduled.
function deliveredRunWithSupersededFailure(overrides = {}) {
  const startedAt = '2026-08-31T04:42:00.000Z';
  const finishedAt = '2026-08-31T05:04:00.000Z';
  const attempt = (actionId, status) => ({
    actionId, attemptNumber: 1, pool: 'opencode2', model: 'luna', status,
    startedAt, finishedAt,
  });
  return {
    runId: 'wf-superseded', shortId: 'sup234', workflow: 'goal-delivered',
    status: 'completed', stage: 'delivered', startedAt, finishedAt,
    intent: { autonomous: true, goal: 'Deliver after a recovered verification failure.' },
    orchestration: { mode: 'autonomous', selectedPool: 'opencode2', selectedModel: 'luna' },
    decisions: [{ gateId: 'orchestrator', decision: 'complete', actions: [] }],
    outcome: {
      verified: true, bestEffort: false, concerns: ['One audit gap remains.'],
      reason: 'Every requirement is independently verified.', deliveryActionId: 'verify-audit-repair-1',
    },
    actionLedger: [
      { id: 'verify-audit', phase: 'g:audit-verification', kind: 'verify', status: 'succeeded', attempts: [0], startedAt, finishedAt },
      { id: 'verify-audit-repair-1', phase: 'g:audit-verification', kind: 'run', status: 'succeeded', attempts: [1], startedAt, finishedAt },
      {
        id: 'verify-suite', phase: 'g:final-verification', kind: 'verify', status: 'failed_terminal',
        attempts: [], finishedAt, dependsOn: ['verify-implementation', 'verify-audit'],
        why: 'dynamic actions blocked by failed or unresolved dependencies',
      },
      { id: 'verify-completion', phase: 'g:completion-verification', kind: 'verify', status: 'succeeded', attempts: [2], startedAt, finishedAt },
    ],
    attempts: [
      attempt('verify-audit', 'succeeded'),
      attempt('verify-audit-repair-1', 'succeeded'),
      attempt('verify-completion', 'succeeded'),
    ],
    outputs: {
      'verify-implementation': { ok: true },
      'verify-audit': { ok: false },
      'verify-audit-repair-1': { ok: true },
      'verify-suite': { ok: false, dependencyBlocked: true },
      'verify-completion': { ok: true },
    },
    activeAgents: {}, _doc: { phases: [] },
    ...overrides,
  };
}

test('a delivered run states concerns and best-effort qualification from the outcome, not the status string', () => {
  const base = {
    runId: 'wf-outcome', shortId: 'out234', workflow: 'qualified',
    startedAt: '2026-08-31T04:00:00.000Z', finishedAt: '2026-08-31T04:30:00.000Z',
    status: 'completed', stage: 'delivered',
    intent: { autonomous: true, goal: 'Deliver a qualified result.' },
    orchestration: { mode: 'autonomous', selectedPool: 'codex', selectedModel: 'sol' },
    decisions: [{ gateId: 'orchestrator', decision: 'complete', actions: [] }],
    actionLedger: [{ id: 'work', phase: 'g:deliver', kind: 'run', status: 'succeeded', attempts: [0] }],
    attempts: [{ actionId: 'work', attemptNumber: 1, pool: 'codex', model: 'sol', status: 'succeeded' }],
    outputs: { work: { ok: true } }, activeAgents: {}, _doc: { phases: [] },
  };
  // A width wide enough that the terminal sentence is never pane-truncated.
  const render = (state) => plain(renderWorkflowTui({ state, events: [] }, { width: 160, height: 30 }));
  const result = (state) => plain(renderWorkflowTui({ state, events: [] }, {
    width: 160, height: 30, orchestratorDetail: true,
  }));

  const clean = { ...base, outcome: { verified: true, bestEffort: false, concerns: [] } };
  assert.match(render(clean), /✓ No agents running · workflow finished\b/);
  assert.match(render(clean), /Workflow finished · result ready/);
  assert.match(result(clean), /Result · Verified delivery is ready +│/);
  assert.doesNotMatch(render(clean), /concern/);

  // `completed` now carries its concerns in the outcome envelope: the count
  // must stay visible without a `completed_with_concerns` status.
  const concerned = { ...base, outcome: { verified: true, bestEffort: false, concerns: ['a', 'b', 'c'] } };
  assert.match(render(concerned), /! No agents running · workflow finished with 3 concerns/);
  assert.match(render(concerned), /Workflow finished with 3 concerns · review 3 concerns in result/);
  assert.match(render(concerned), /! Completed with 3 concerns/);
  assert.match(result(concerned), /Result · Verified delivery is ready · 3 concerns/);
  assert.match(result(concerned), /Concerns · 3 recorded in the result envelope/);

  const single = { ...base, outcome: { verified: true, bestEffort: false, concerns: ['only one'] } };
  assert.match(render(single), /workflow finished with 1 concern\b/);

  const bestEffort = { ...base, outcome: { verified: false, bestEffort: true, concerns: ['x', 'y'] } };
  assert.match(render(bestEffort), /! No agents running · best-effort delivery, unverified — 2 concerns/);
  assert.match(render(bestEffort), /! Best-effort delivery, unverified — 2 concerns · review 2 concerns in result/);
  assert.match(render(bestEffort), /! Best-effort, unverified/);
  assert.match(result(bestEffort), /Result · Best useful delivery is ready, unverified · 2 concerns/);

  // A legacy run dir replays through the same outcome fields.
  const legacy = { ...concerned, status: 'completed_with_concerns', stage: 'delivered_with_concerns' };
  assert.equal(
    render(legacy).replace(/completed_with_concerns/g, 'completed'),
    render(concerned).replace(/ · done/g, ' · completed'),
  );
  // A legacy run dir with no outcome envelope keeps its qualification.
  const legacyNoOutcome = { ...base, status: 'completed_with_concerns' };
  assert.match(render(legacyNoOutcome), /! No agents running · workflow finished with concerns/);
  assert.match(result(legacyNoOutcome), /Result · Best useful delivery is ready with concerns/);
});

test('a delivered run shows no phase failure marks, and a never-dispatched action names its failed dependency', () => {
  const state = deliveredRunWithSupersededFailure();
  const model = workflowPanelModel({ state, events: [] });
  const audit = model.phases.find((phase) => phase.name === 'g:audit-verification');
  const final = model.phases.find((phase) => phase.name === 'g:final-verification');

  // Defect A: the audit verification failed and was superseded by its repair
  // before the run delivered, so the phase list must not keep a ✗.
  assert.deepEqual(model.phases.filter((phase) => phase.status === 'failed'), []);
  assert.equal(audit.status, 'completed');
  assert.equal(audit.completed, 2);

  // Defect B: verify-suite never dispatched, so it is neither complete nor
  // "not started yet" — it was blocked by the verify that had failed.
  assert.equal(final.status, 'dependency_blocked');
  assert.deepEqual([final.completed, final.total], [0, 1]);
  assert.deepEqual(final.blockedActions, [{ id: 'verify-suite', kind: 'verify', blockedBy: ['verify-audit'] }]);

  const finalIndex = model.phases.indexOf(final);
  const phases = plain(renderWorkflowTui({ state, events: [] }, { width: 120, height: 30, phaseIndex: finalIndex }));
  assert.match(phases, /⊘ Final Verification 0\/1/);
  assert.doesNotMatch(phases, /✗ (Audit|Final) Verification/);

  const agents = plain(renderWorkflowTui({ state, events: [] }, {
    width: 120, height: 30, phaseIndex: finalIndex, focus: 1,
  }));
  assert.match(agents, /Final Verification · 0\/1 complete/);
  assert.match(agents, /⊘ verify-suite · never dispatched · blocked by verify-audit/);
  assert.doesNotMatch(agents, /Not started yet/);

  const detail = plain(renderWorkflowTui({ state, events: [] }, {
    width: 120, height: 30, phaseIndex: finalIndex, focus: 2,
  }));
  assert.match(detail, /⊘ verify-suite · verify · never dispatched/);
  assert.match(detail, /blocked by verify-audit/);
});

test('a run that did not deliver keeps its phase failure marks, and still never counts a blocked action as complete', () => {
  const failed = deliveredRunWithSupersededFailure({ status: 'failed', stage: 'failed', outcome: null });
  const model = workflowPanelModel({ state: failed, events: [] });
  const audit = model.phases.find((phase) => phase.name === 'g:audit-verification');
  const final = model.phases.find((phase) => phase.name === 'g:final-verification');
  assert.equal(audit.status, 'failed');
  assert.equal(final.status, 'failed');
  assert.deepEqual([final.completed, final.total], [0, 1]);
  const screen = plain(renderWorkflowTui({ state: failed, events: [] }, { width: 120, height: 30 }));
  assert.match(screen, /✗ Audit Verification 2\/2/);
  assert.match(screen, /✗ Final Verification 0\/1/);
});

// An autonomous run with a preflight scout, one accepted planner turn, a
// finished Discover phase, and a still-running Implement phase.
function segmentedRunState(overrides = {}) {
  return {
    runId: 'wf-segments', shortId: 'seg234', workflow: 'segmented', status: 'running',
    startedAt: iso(0),
    intent: { autonomous: true, goal: 'Group the timeline into phase segments.' },
    orchestration: { mode: 'autonomous', selectedPool: 'claude-code', selectedModel: 'opus-5' },
    currentStep: { id: 'implement-b', type: 'run', phase: 'implement' },
    _doc: { phases: [{ name: 'autonomous-delivery', steps: [{ id: 'scout', type: 'run' }, { id: 'orchestrator', type: 'decide' }] }] },
    decisions: [{ gateId: 'orchestrator', decision: 'needs_more_work', reason: 'Discover, then implement.' }],
    actionLedger: [
      { id: 'scout', phase: 'autonomous-delivery', kind: 'run', status: 'succeeded', attempts: [0] },
      { id: 'orchestrator', phase: 'autonomous-delivery', kind: 'decide', status: 'succeeded', attempts: [1] },
      { id: 'discover-a', phase: 'discover', kind: 'run', status: 'succeeded', attempts: [2] },
      { id: 'discover-b', phase: 'discover', kind: 'run', status: 'succeeded', attempts: [3] },
      { id: 'implement-a', phase: 'implement', kind: 'run', status: 'succeeded', attempts: [4] },
      { id: 'implement-b', phase: 'implement', kind: 'run', status: 'running', attempts: [5] },
      { id: 'verify-all', phase: 'verify', kind: 'verify', status: 'pending', dependsOn: ['implement-b'], attempts: [] },
    ],
    attempts: [
      { actionId: 'scout', pool: 'opencode2', model: 'luna', status: 'succeeded', startedAt: iso(10), finishedAt: iso(130) },
      { actionId: 'orchestrator', pool: 'claude-code', model: 'opus-5', status: 'succeeded', startedAt: iso(130), finishedAt: iso(190) },
      { actionId: 'discover-a', pool: 'grok', model: 'grok-4.6', status: 'succeeded', startedAt: iso(190), finishedAt: iso(250) },
      { actionId: 'discover-b', pool: 'grok', model: 'grok-4.6', status: 'succeeded', startedAt: iso(190), finishedAt: iso(260) },
      { actionId: 'implement-a', pool: 'command-code', model: 'minimax-m3', status: 'succeeded', startedAt: iso(260), finishedAt: iso(320) },
      { actionId: 'implement-b', pool: 'command-code', model: 'minimax-m3', status: 'running', startedAt: iso(320) },
    ],
    outputs: { scout: { ok: true }, 'discover-a': { ok: true }, 'discover-b': { ok: true }, 'implement-a': { ok: true } },
    activeAgents: {},
    ...overrides,
  };
}

test('timeline segments replace per-line phase prefixes with one header per phase change', () => {
  const screen = renderWorkflowTui({ state: segmentedRunState(), events: [] }, { width: 120, height: 40 });
  const pane = timelinePaneRows(screen);

  // one header per phase change, in chronological order, and none repeated
  // between two events of the same phase
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discover', 'Implement']);

  // the event lines themselves no longer name their phase
  assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
  assert.deepEqual(pane.filter((line) => /\[(Discover|Implement|Preflight):? ?[^\]]*\]/.test(line)), []);

  // glyphs, action names, timestamps, and right-aligned durations survive
  const discover = segmentRows(screen, 'Discover');
  // (timestamps render in the local zone, so only their shape is asserted)
  assert.deepEqual(discover.map(normalizeRow), [
    'HH:MM ├─ started',
    'HH:MM │ ├─✓ discover-a 1m00s',
    'HH:MM │ └─✓ discover-b 1m10s',
    'HH:MM └─✓ completed 2/2',
  ]);
  // four Discover events, one Discover header: no header between same-phase events
  assert.equal(pane.filter((line) => /^─{2,}\s+Phase 1 · Discover\s/.test(line)).length, 1);

  // the running phase keeps its started row and reports no completion
  const implement = segmentRows(screen, 'Implement');
  assert.match(implement.join('\n'), /├─ started/);
  assert.match(implement.join('\n'), /├─✓ implement-a\s+1m00s/);
  assert.deepEqual(implement.filter((line) => line.includes('completed')), []);

  // every blank separator inside the timeline introduces a segment header
  pane.forEach((line, index) => {
    if (line.trim() || index === pane.length - 1) return;
    const next = pane[index + 1];
    assert.ok(!next.trim() || /^─{2,}/.test(next), `blank row ${index} is not a segment separator: ${next}`);
  });

  // the prefix removal is scoped to timeline event lines: the Next pane still
  // names the phase of the pending work it announces
  const rendered = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.match(rendered, /Workflow timeline · \d+ milestones?/);
  assert.match(rendered, /○ \[Phase: Verify\] · verify-all/);
});

test('parallel phase events stay grouped in declared phase-number order', () => {
  const state = {
    runId: 'wf-interleaved', shortId: 'int234', workflow: 'interleaved', status: 'completed',
    startedAt: iso(0), finishedAt: iso(270),
    intent: { autonomous: true, goal: 'Interleave two phases in time.' },
    orchestration: { mode: 'autonomous', selectedPool: 'codex', selectedModel: 'sol' },
    decisions: [{ gateId: 'orchestrator', decision: 'complete', actions: [] }],
    actionLedger: [
      { id: 'implement-a', phase: 'implement', kind: 'run', status: 'succeeded', attempts: [0] },
      { id: 'implement-b', phase: 'implement', kind: 'run', status: 'succeeded', attempts: [1] },
      { id: 'verify-a', phase: 'verify', kind: 'verify', status: 'succeeded', attempts: [2] },
    ],
    attempts: [
      { actionId: 'implement-a', status: 'succeeded', startedAt: iso(60), finishedAt: iso(120) },
      { actionId: 'implement-b', status: 'succeeded', startedAt: iso(210), finishedAt: iso(240) },
      { actionId: 'verify-a', status: 'succeeded', startedAt: iso(150), finishedAt: iso(180) },
    ],
    outputs: { 'implement-a': { ok: true }, 'implement-b': { ok: true }, 'verify-a': { ok: true } },
    activeAgents: {}, _doc: { phases: [] },
  };
  const screen = renderWorkflowTui({ state, events: [] }, { width: 120, height: 40 });

  // Worker completion times interleave, but the human-facing phase program is
  // stable: Phase 1 is a single block before Phase 2.
  assert.deepEqual(segmentLabels(screen), ['Preflight', 'Implement', 'Verify']);
  assert.deepEqual(segmentRows(screen, 'Implement').map(normalizeRow), [
    'HH:MM ├─ started',
    'HH:MM │ ├─✓ implement-a 1m00s',
    'HH:MM │ └─✓ implement-b 30s',
    'HH:MM └─✓ completed 2/2',
  ]);
  assert.match(screen, /── Phase 1 · Implement/);
  assert.match(screen, /── Phase 2 · Verify/);
  assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
});

test('scout and the first planner turn share Preflight; later checkpoints open a Planner segment', () => {
  const state = segmentedRunState({
    status: 'completed', finishedAt: iso(280), currentStep: null,
    decisions: [
      { gateId: 'orchestrator', decision: 'needs_more_work', reason: 'Discover, then implement.' },
      { gateId: 'orchestrator', decision: 'complete', reason: 'Every requirement is verified.' },
    ],
  });
  state.actionLedger = state.actionLedger
    .filter((action) => !action.id.startsWith('implement'))
    .map((action) => (action.id === 'orchestrator' ? { ...action, attempts: [1, 6] } : action));
  state.attempts = [
    ...state.attempts.filter((attempt) => !attempt.actionId.startsWith('implement')),
    { actionId: 'orchestrator', pool: 'claude-code', model: 'opus-5', status: 'succeeded', startedAt: iso(260), finishedAt: iso(270) },
  ];
  const screen = renderWorkflowTui({ state, events: [] }, { width: 120, height: 40 });

  // one Preflight segment carries the run start, the scout, and the first plan
  assert.equal(segmentLabels(screen).filter((label) => label === 'Preflight').length, 1);
  assert.equal(segmentLabels(screen)[0], 'Preflight');
  const preflight = segmentRows(screen, 'Preflight').join('\n');
  assert.match(preflight, /● Workflow initiated/);
  assert.match(preflight, /● Scout started/);
  assert.match(preflight, /✓ Scout completed/);
  assert.match(preflight, /◆ \[Workflow Planner\] plan created/);
  // neither the scout nor the planner opens a segment of its own before work starts
  assert.deepEqual(segmentLabels(screen).filter((label) => /^(Scout|Workflow Planner)/.test(label)), []);

  // a later planner checkpoint lands in its own Planner segment, after the phase
  assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discover', 'Planner']);
  assert.match(segmentRows(screen, 'Planner').join('\n'), /◆ \[Workflow Planner\] completion confirmed/);
});

test('finished segment headers carry elapsed time and the active segment reads running', () => {
  const running = renderWorkflowTui({ state: segmentedRunState(), events: [] }, { width: 120, height: 40 });
  const headers = Object.fromEntries(timelineSegments(running).map((segment) => [segment.label, segment.elapsed]));
  // Preflight spans the run start through the accepted plan (0s → 3m10s)
  assert.equal(headers.Preflight, '3m10s');
  // Discover spans its own first and last event (00:03:10 → 00:04:20)
  assert.equal(headers.Discover, '1m10s');
  // the phase still executing reports running instead of a finished duration
  assert.equal(headers.Implement, 'running');

  const finished = renderWorkflowTui({
    state: segmentedRunState({ status: 'completed', finishedAt: iso(400), currentStep: null }),
    events: [],
  }, { width: 120, height: 40 });
  const finishedHeaders = timelineSegments(finished);
  assert.deepEqual(finishedHeaders.filter((segment) => segment.elapsed === 'running'), []);
  for (const segment of finishedHeaders) {
    assert.match(segment.elapsed, /^\d+(?:h\d+m|m\d+s|s)$|^\d+s$/, `${segment.label} header lost its elapsed time`);
  }
});

// A single long phase: any viewport short enough to scroll starts mid-segment.
function longPhaseState() {
  const actions = Array.from({ length: 12 }, (_, index) => ({
    id: `work-${index}`, phase: 'g:implement', kind: 'run', status: 'succeeded', attempts: [index],
  }));
  return {
    runId: 'wf-long', shortId: 'lng234', workflow: 'long-phase', status: 'running',
    startedAt: iso(0),
    intent: { autonomous: true, goal: 'Render more rows than the viewport holds.' },
    orchestration: { mode: 'autonomous', selectedPool: 'codex', selectedModel: 'sol' },
    currentStep: { id: 'work-11', type: 'run', phase: 'g:implement' },
    decisions: [{ gateId: 'orchestrator', decision: 'needs_more_work', actions: [] }],
    actionLedger: [...actions, { id: 'tail', phase: 'g:implement', kind: 'run', status: 'running', attempts: [12] }],
    attempts: [
      ...actions.map((action, index) => ({
        actionId: action.id, status: 'succeeded', startedAt: iso(60 + index * 120), finishedAt: iso(120 + index * 120),
      })),
      { actionId: 'tail', status: 'running', startedAt: iso(60 + 12 * 120) },
    ],
    outputs: Object.fromEntries(actions.map((action) => [action.id, { ok: true }])),
    activeAgents: {}, _doc: { phases: [] },
  };
}

test('a timeline viewport that starts mid-segment re-emits a continuation header', () => {
  const state = longPhaseState();
  const tall = renderWorkflowTui({ state, events: [] }, { width: 100, height: 46 });
  // with room for every row the phase is introduced once and never continued
  assert.deepEqual(segmentLabels(tall), ['Preflight', 'Implement']);

  const short = renderWorkflowTui({ state, events: [] }, { width: 100, height: 22 });
  const pane = timelinePaneRows(short);
  const marker = pane.findIndex((line) => line.includes('earlier timeline rows'));
  assert.ok(marker >= 0, `expected a scrolled viewport:\n${pane.join('\n')}`);
  // the scrolled-into segment is re-announced before its first visible event
  assert.match(pane[marker + 1], /^─{2,}\s+Phase 1 · Implement · continued\s+─{2,}/);
  assert.match(pane[marker + 2], /^\d{2}:\d{2}\s/);
  assert.deepEqual(segmentLabels(short), ['Implement · continued']);
  assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
});

test('narrow timeline rendering uses the same segment headers and no phase prefixes', () => {
  // tall enough that the whole timeline fits: nothing here is a scroll artifact
  const screen = renderWorkflowTui({ state: segmentedRunState(), events: [] }, { width: 60, height: 44 });
   assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discover', 'Implement']);
  const pane = timelinePaneRows(screen);
  assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
  assert.match(segmentRows(screen, 'Discover').join('\n'), /├─✓ discover-a/);
   assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Implement').elapsed, 'running');
  // headers obey the narrow width like every other row
  const overflow = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').filter((line) => [...line].length > 60);
  assert.deepEqual(overflow, []);

  // and the narrow viewport re-emits the continuation header when it scrolls
  const scrolled = renderWorkflowTui({ state: longPhaseState(), events: [] }, { width: 60, height: 22 });
  const narrowPane = timelinePaneRows(scrolled);
   const marker = narrowPane.findIndex((line) => line.includes('earlier timeline'));
  assert.ok(marker >= 0, `expected a scrolled narrow viewport:\n${narrowPane.join('\n')}`);
   assert.match(narrowPane[marker + 1], /^─{2,}\s+Phase 1 · Implement · continue/);
});

// ---------------------------------------------------------------------------
// Unified application shell: the workflows list, a run, a phase, and an agent
// are four depths of one hierarchy. Each depth carries the same persistent
// breadcrumb, the same key grammar, and the same drill-down, so the helpers
// below read the breadcrumb and the footer structurally — never by panel
// geometry, hint order, or the exact wording a binding happens to use today.
// ---------------------------------------------------------------------------

function shellRunState({ runId, shortId, workflow, goal, agentId, startedAt }) {
  return {
    runId, shortId, workflow, status: 'running', startedAt,
    intent: { goal },
    orchestration: { selectedPool: 'codex', selectedModel: 'sol', selection: 'capability-and-quota' },
    currentStep: { id: agentId, type: 'run', phase: 'implement' },
    currentPhase: { index: 1, name: 'implement', total: 2 },
    actionLedger: [
      { id: 'scan', phase: 'discover', kind: 'run', status: 'succeeded', attempts: [0] },
      { id: agentId, phase: 'implement', kind: 'run', status: 'running', attempts: [1] },
    ],
    attempts: [
      {
        actionId: 'scan', attemptNumber: 1, pool: 'opencode2', model: 'luna',
        status: 'succeeded', startedAt, finishedAt: startedAt,
      },
      { actionId: agentId, attemptNumber: 1, pool: 'codex', model: 'sol', status: 'running', startedAt },
    ],
    activeAgents: {
      [agentId]: { stepId: agentId, pool: 'codex', model: 'sol', attempt: 1, status: 'running', startedAt },
    },
    steps: [{ phase: 'discover', stepId: 'scan', ok: true }],
    outputs: { scan: { ok: true } },
  };
}

// Two live runs of the same shape: the sibling exists at every depth, so Tab
// has an equivalent location to land on instead of falling back to the root.
const SHELL_RUNS = [
  {
    runId: 'wf-alpha', shortId: 'aaa111', workflow: 'unified-shell',
    goal: 'Unify the workflow viewer.', agentId: 'build-alpha',
    startedAt: '2026-08-29T00:02:00.000Z',
  },
  {
    runId: 'wf-beta', shortId: 'bbb222', workflow: 'sibling-run',
    goal: 'Run beside the first one.', agentId: 'build-beta',
    startedAt: '2026-08-29T00:01:00.000Z',
  },
];

function shellFixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-shell-'));
  for (const run of SHELL_RUNS) {
    const dir = join(home, 'workflows', run.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(shellRunState(run)));
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// A rendered screen opens with the clear/home escape; an in-place repaint frame
// does not. Both start their first visible row with the breadcrumb.
function visibleLines(screen) {
  const lines = plain(screen).split('\n');
  return lines[0] === '' ? lines.slice(1) : lines;
}

function breadcrumbOf(screen) {
  const [first] = visibleLines(screen);
  return String(first ?? '').replace(/\s+$/, '');
}

function crumbSegments(screen) {
  return breadcrumbOf(screen).split('›').map((segment) => segment.trim()).filter(Boolean);
}

function footerOf(screen) {
  const lines = visibleLines(screen).filter((line) => line.trim());
  return String(lines.at(-1) ?? '').trim();
}

// Keys that belong to the hierarchy-wide grammar. Screen-specific keys (t, o,
// v, /, a, r, c, PgUp/PgDn) are deliberately excluded: they are not the same
// action everywhere, and `t` is one toggle that prints both of its labels.
const SHARED_KEYS = ['↑', '↓', 'Enter', 'Esc', 'Shift+Tab', 'Tab', 'q'];

function hintLabels(screen) {
  const footer = footerOf(screen);
  const labels = new Map();
  for (const key of SHARED_KEYS) {
    // tolerate a hint that spells out its aliases (`Enter/→/l open`) and a
    // token that pairs two bindings (`Tab next workflow/Shift+Tab previous …`)
    const pattern = new RegExp(`(?:^|[\\s·/])${key.replace('+', '\\+')}(?:/\\S+)?\\s+([^·/]+)`, 'g');
    const found = [...footer.matchAll(pattern)].map((match) => match[1].trim());
    if (found.length) labels.set(key, found);
  }
  return labels;
}

test('the breadcrumb names the location at list, run, phase, and agent depth', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home);
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    assert.ok(row, 'the fixture run is listed');

    const list = breadcrumbOf(renderDashboard({ rows, selected: 0, width: 200, height: 30 }));
    const [run, phase, agent] = [0, 1, 2].map((focus) =>
      breadcrumbOf(renderWorkflowTui(row, { width: 200, height: 30, focus })));

    // the list is the root of the hierarchy and names nothing below itself
    assert.equal(list, ' Workflows');
    // one run segment identifies the run the way `runs` does: id · workflow
    assert.equal(crumbSegments(renderWorkflowTui(row, { width: 200, height: 30 }))[1], 'aaa111 · unified-shell');
    // the run depth is not an agent location
    assert.doesNotMatch(run, /build-alpha/);
    // the phase depth names the phase, the agent depth names the agent
    assert.ok(phase.includes('implement'), `phase breadcrumb lost its phase: ${phase}`);
    assert.ok(agent.endsWith('build-alpha'), `agent breadcrumb lost its agent: ${agent}`);
    // drilling in only ever extends the path it came from
    assert.ok(run.startsWith(list), `${run} does not extend ${list}`);
    assert.ok(phase.startsWith(run), `${phase} does not extend ${run}`);
    assert.ok(agent.startsWith(phase), `${agent} does not extend ${phase}`);
  } finally { cleanup(); }
});

test('a breadcrumb wider than the terminal drops its deepest segments first', () => {
  const { home, cleanup } = shellFixture();
  try {
    const row = dashboardRows(home).find((entry) => entry.runId === 'wf-alpha');
    const deepest = (width) => renderWorkflowTui(row, { width, height: 30, focus: 2 });

    assert.deepEqual(crumbSegments(deepest(200)),
      ['Workflows', 'aaa111 · unified-shell', 'implement', 'build-alpha']);
    // the agent and its phase go before the run that contains them
    assert.deepEqual(crumbSegments(deepest(40)), ['Workflows', 'aaa111 · unified-shell']);
    // and the root survives a terminal too narrow for anything else
    assert.deepEqual(crumbSegments(deepest(24)), ['Workflows']);

    const full = crumbSegments(deepest(200));
    for (const width of [24, 32, 40, 60, 80, 200]) {
      const screen = deepest(width);
      const segments = crumbSegments(screen);
      assert.ok(segments.length >= 1, `width ${width} rendered no breadcrumb`);
      // whatever survives is the shallow prefix of the full path, never a hole
      assert.deepEqual(segments, full.slice(0, segments.length), `width ${width} truncated out of order`);
      assert.ok([...breadcrumbOf(screen)].length <= width, `width ${width} breadcrumb overflows`);
    }
  } finally { cleanup(); }
});

test('one shared key reads the same on the list, run, phase, and agent screens', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home);
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const screens = {
      list: renderDashboard({ rows, selected: 0, width: 200, height: 30 }),
      run: renderWorkflowTui(row, { width: 200, height: 30, focus: 0 }),
      phase: renderWorkflowTui(row, { width: 200, height: 30, focus: 1 }),
      agent: renderWorkflowTui(row, { width: 200, height: 30, focus: 2 }),
    };

    // every wording a key is given, on every screen that offers it
    const seen = new Map();
    for (const [name, screen] of Object.entries(screens)) {
      for (const [key, found] of hintLabels(screen)) {
        for (const label of found) seen.set(key, [...(seen.get(key) ?? []), { name, label }]);
      }
    }

    // the grammar is genuinely shared, not one hint compared with itself
    for (const key of ['↑', 'Enter', 'Esc', 'Tab', 'Shift+Tab', 'q']) {
      assert.ok((seen.get(key) ?? []).length >= 2, `${key} is not part of the shared footer grammar`);
    }

     // Every shared binding has one label at every hierarchy depth.
    assert.deepEqual(new Set(seen.get('↑').map(({ label }) => label)), new Set(['move up']));
    assert.deepEqual(new Set(seen.get('↓').map(({ label }) => label)), new Set(['move down']));
    assert.deepEqual(new Set(seen.get('Esc').map(({ label }) => label)), new Set(['move out']));
     assert.deepEqual(new Set(seen.get('Enter').map(({ label }) => label)), new Set(['open']));
      assert.deepEqual(new Set(seen.get('Shift+Tab').map(({ label }) => label)), new Set(['previous workflow']));
     assert.deepEqual(new Set(seen.get('Tab').map(({ label }) => label)), new Set(['next workflow']));
     assert.deepEqual(new Set(seen.get('q').map(({ label }) => label)), new Set(['detach']));
  } finally { cleanup(); }
});

// The two navigation moves that only exist in the input loop. Each keypress is
// delivered synchronously, so the returned repaint frame is exactly the screen
// that key produced — nothing else can have painted in between.
const ESC_KEY = String.fromCharCode(27);

function shellSession(home, { columns = 120, rows = 30 } = {}) {
  const width = columns;
  const height = rows;
  class FakeInput extends EventEmitter {
    isTTY = true;
    setRawMode() {}
    resume() {}
    pause() {}
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    columns = width;
    rows = height;
    text = '';
    write(chunk) { this.text += chunk; }
  }
  const input = new FakeInput();
  const output = new FakeOutput();
  const running = runDashboard(home, { input, output, refreshMs: 60_000 });
  const press = (key) => {
    const before = output.text.length;
    input.emit('data', Buffer.from(key));
    return output.text.slice(before);
  };
  const drillToAgent = () => {
    press('\r'); // workflows list -> run
    press('\r'); // run -> phase
    return press('\r'); // phase -> agent
  };
  return { input, output, running, press, drillToAgent, quit: () => { press('q'); return running; } };
}

test('Tab re-enters the sibling workflow at the depth it was left at', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home);
    const atAgent = session.drillToAgent();
    assert.match(atAgent, /Agent activity · r refresh/);
    assert.deepEqual(crumbSegments(atAgent),
      ['Workflows', 'aaa111 · unified-shell', 'implement', 'build-alpha']);

    const sibling = session.press('\t');
    assert.ok(sibling.length, 'Tab repainted the screen');
    // same depth, same phase, the sibling workflow's own agent
    assert.match(sibling, /Agent activity · r refresh/);
    assert.deepEqual(crumbSegments(sibling),
      ['Workflows', 'bbb222 · sibling-run', 'implement', 'build-beta']);
    assert.equal(crumbSegments(sibling).length, crumbSegments(atAgent).length);
    assert.doesNotMatch(sibling, /build-alpha/);

    // and Shift+Tab comes back the same way, still at agent depth
    const back = session.press(`${ESC_KEY}[Z`);
    assert.match(back, /Agent activity · r refresh/);
    assert.deepEqual(crumbSegments(back),
      ['Workflows', 'aaa111 · unified-shell', 'implement', 'build-alpha']);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Esc walks out exactly one level: agent to phase to run to the workflows list', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home);
    assert.match(session.drillToAgent(), /Agent activity · r refresh/);

    const phase = session.press(ESC_KEY);
    assert.match(phase, /Agents · r refresh/);
    assert.doesNotMatch(phase, /Agent activity · r refresh/); // not two levels at once
    assert.doesNotMatch(phase, /Runs · active/); // and not all the way out
    assert.match(breadcrumbOf(phase), /^ Workflows › aaa111 · unified-shell/);

    const run = session.press(ESC_KEY);
    assert.match(run, /Timeline · auto-following newest event/);
    assert.doesNotMatch(run, /Agents · r refresh/);
    assert.doesNotMatch(run, /Runs · active/);
    assert.match(breadcrumbOf(run), /^ Workflows › aaa111 · unified-shell/);

    const list = session.press(ESC_KEY);
    assert.match(list, /Runs · active/);
    assert.doesNotMatch(list, /Timeline · auto-following newest event/);
    assert.equal(breadcrumbOf(list), ' Workflows');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('V2 planned steps name each action work or evidence, never undefined', () => {
  // Regression: the planned-steps list printed `action.kind`, a field only
  // authored drafts carry. Every V2 run rendered "<id> · undefined · <status>"
  // for every step that had no agent yet. Observed live on run zx9vni.
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-role-'));
  try {
    const runId = 'wf-role-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Close the UI gaps and prove the suite is green', cwd: '/tmp/repo',
      requirements: [{ id: 'requirement-1', text: 'The UI gaps are closed' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'role12' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Fix, then verify.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'shell-and-visual-system', purpose: 'Close the shell gaps', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['src/shell.js'], prompt: 'Fix it.', lane: 'build', effort: 'high', evidenceFor: [], inputs: [], produces: ['shell'] },
        { id: 'space-and-spaces', purpose: 'Close the Space gaps', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['src/space.js'], prompt: 'Fix it.', lane: 'build', effort: 'high', evidenceFor: [], inputs: [], produces: ['space'] },
        { id: 'verify-surfaces', purpose: 'Verify the surfaces', dependsOn: ['shell-and-visual-system', 'space-and-spaces'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['shell', 'space'], produces: [] },
      ] },
    });
    // One action running, no attempt recorded yet: exactly the state that shows
    // the planned-steps list because no agent can be selected.
    state.presentation.stages[0].startedAt = iso(2);
    Object.assign(state.actions[0], { status: 'running', startedAt: iso(2), attempts: 1 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    const row = dashboardRows(home)[0];
    const agentPane = renderWorkflowTui(row, { width: 120, height: 30, focus: 1 });
    assert.match(agentPane, /No agent selected\./);
    assert.match(agentPane, /Planned steps in this phase:/);
    assert.doesNotMatch(agentPane, /undefined/);
    assert.match(agentPane, /shell-and-visual-system · work · running/);
    assert.match(agentPane, /space-and-spaces · work · pending/);

    // The evidence stage names its actions by the role the kernel gives them.
    const evidencePane = renderWorkflowTui(row, { width: 120, height: 30, focus: 1, phaseIndex: 1 });
    assert.doesNotMatch(evidencePane, /undefined/);
    assert.match(evidencePane, /verify-surfaces · evidence · pending/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a V2 run whose kernel died is not reported as running', async () => {
  // Regression: V2 states recorded no runner pid or heartbeat, and
  // reconcileInterruptedRun skipped V2 entirely, so a kernel that died left
  // state.json saying "running" forever. Observed live on run zx9vni, which
  // showed "running · 0/6 actions" for 17 minutes with no process alive.
  const { v2RunnerLiveness } = await import('../src/workflow/short-id.js');
  const at = (ms) => new Date(ms).toISOString();
  const now = 1_000_000_000_000;
  const v2 = (status, runner) => ({
    schemaVersion: 'bullswarm.workflow.state.v2', lifecycle: { status }, runner,
  });

  const live = v2('running', { pid: 4242, startedAt: at(now - 60_000), lastHeartbeatAt: at(now - 1_000) });
  assert.equal(v2RunnerLiveness(live, { now, processAlive: () => true }).alive, true);

  // The exact shape of the reported failure: process gone, state still active.
  const dead = v2RunnerLiveness(live, { now, processAlive: () => false });
  assert.equal(dead.alive, false);
  assert.match(dead.reason, /runner process 4242 is gone/);

  // Alive pid but a heartbeat that stopped advancing is also not running.
  const wedged = v2RunnerLiveness(
    v2('running', { pid: 4242, startedAt: at(now - 600_000), lastHeartbeatAt: at(now - 300_000) }),
    { now, processAlive: () => true },
  );
  assert.equal(wedged.alive, false);
  assert.match(wedged.reason, /has not updated the run/);

  // A caller-planner pause is ownerless by design and must never be flagged.
  assert.equal(v2RunnerLiveness(v2('waiting', null), { now, processAlive: () => false }).alive, true);
  for (const status of ['completed', 'partial', 'cancelled', 'failed']) {
    assert.equal(v2RunnerLiveness(v2(status, null), { now, processAlive: () => false }).alive, true);
  }

  // No runner record and no run directory: no evidence, so no accusation.
  assert.equal(v2RunnerLiveness(v2('running', null), { now, processAlive: () => false }).alive, true);

  // A run directory whose state.json went silent for longer than the legacy
  // window is the only signal available for pre-heartbeat runs.
  const home = mkdtempSync(join(tmpdir(), 'bs-liveness-'));
  try {
    writeFileSync(join(home, 'state.json'), '{}');
    const fresh = v2RunnerLiveness(v2('running', null), { now: Date.now(), processAlive: () => false, runDir: home });
    assert.equal(fresh.alive, true, 'a just-written state is not stale');
    const stale = v2RunnerLiveness(v2('running', null), { now: Date.now() + 3_600_000, processAlive: () => false, runDir: home });
    assert.equal(stale.alive, false);
    assert.match(stale.reason, /no heartbeat recorded/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('program dashboard projects saved categories into dependency levels with overlapping activity', () => {
  const goal = createV2GoalDocument({ goal: 'Research docs', cwd: '/tmp',
    requirements: [{ id: 'correct', text: 'Correct comparison' }], settings: { scout: false, executionMode: 'program' } });
  const state = createV2State(goal, { runId: 'wf-levels-abcdef', shortId: 'lv1234' });
  state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
  state.program = { actions: [
    { id: 'fast', purpose: 'Read docs', dependsOn: [], ownedFiles: ['a.md'] },
    { id: 'slow', purpose: 'Research docs', dependsOn: [], ownedFiles: ['b.md'] },
    { id: 'next', purpose: 'Write comparison', dependsOn: ['fast'], ownedFiles: ['result.md'] },
  ] };
  state.actions = [
    { id: 'fast', status: 'succeeded', startedAt: iso(1), finishedAt: iso(2) },
    { id: 'slow', status: 'running', startedAt: iso(1) },
    { id: 'next', status: 'running', startedAt: iso(3) },
  ];
  state.presentation.stages = [{ id: 'old', label: 'Documentation', actionIds: ['fast', 'slow', 'next'], startedAt: iso(1) }];
  const row = { state, events: [{ type: 'presentation.stage_started', committedAt: iso(1), payload: { label: 'Documentation' } }] };
  const before = JSON.stringify(state);
  const model = workflowPanelModel(row);
  assert.deepEqual(model.phases.map((phase) => phase.status), ['active', 'active']);
  for (const width of [60, 120]) {
    const screen = renderWorkflowTui(row, { width, height: 40 });
    assert.match(screen, /Level 1/);
    assert.match(screen, /Level 2/);
    assert.doesNotMatch(screen, /Phase [12]|Documentation/);
    assert.match(renderWorkflowTui(row, { width, height: 40, mobileTimeline: false }), /Dependency levels/);
  }
  assert.equal(JSON.stringify(state), before);
});
