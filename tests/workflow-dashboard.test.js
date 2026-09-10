import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dashboardRows, renderDashboard, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, runDashboard } from '../src/workflow/dashboard.js';
import { appendEvent, readEvents } from '../src/workflow/events.js';
import { cmdWorkflow } from '../src/workflow/cli.js';
import { createV2GoalDocument, createV2DurableState, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

// These tests assert the unicode presentation, so pin it: the glyph table
// otherwise follows the developer's terminal and would fall back to ascii
// when the suite runs inside Apple Terminal.
process.env.BULLSWARM_UNICODE = '1';
// BULLSWARM_ASCII outranks it, and it is the workaround the README hands
// an affected user, so a contributor may well have it in their shell.
delete process.env.BULLSWARM_ASCII;

function v2Actions() {
  return [
    { id: 'audit-files', purpose: 'Audit every file', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['audit.md'], prompt: 'Audit them.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['audit'] },
    { id: 'inspect-audit', purpose: 'Inspect the audit', dependsOn: ['audit-files'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['audit'], produces: [] },
  ];
}

function writeV2Run(home, {
  runId, shortId, goal, status = 'running', startedAt = new Date().toISOString(),
  finishedAt = null, live = false, running = false,
}) {
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const document = createV2GoalDocument({
    goal, cwd: home,
    requirements: [{ id: 'requirement-1', text: 'Every file is audited.', mandatory: true }],
    settings: { scout: false },
  });
  let state = createV2State(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Audit then inspect.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: v2Actions() },
  });
  // Accepting a program moves the lifecycle on, so the caller's status wins.
  state.lifecycle = { status, startedAt, finishedAt, resultFile: null };
  if (running) {
    Object.assign(state.actions[0], { status: 'running', startedAt, attempts: 1 });
    state.attempts.push({
      id: 'audit-files-1', actionId: 'audit-files', ordinal: 1, status: 'running',
      pool: 'planner-agent', model: 'planner-v1', startedAt, finishedAt: null,
      lastActivityAt: startedAt, outputBytesObserved: 42,
    });
  }
  // A live kernel pid is what makes a run read as ongoing.
  if (live) state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return { dir, state };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-'));
  writeV2Run(home, {
    runId: 'wf-test', shortId: 'abc234', goal: 'Audit every file autonomously.',
    live: true, running: true,
  });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function addHistoricalRun(home) {
  writeV2Run(home, {
    runId: 'wf-done', shortId: 'def345', goal: 'Audit documentation freshness.',
    status: 'completed', startedAt: '2026-08-30T01:00:00.000Z',
    finishedAt: '2026-08-30T01:05:00.000Z',
  });
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
    assert.equal(rows[0].legacy, false);
    assert.equal(rows[0].stepsTotal, 2);
    assert.match(renderDashboard({ rows }), /abc234 · Audit every file autonomously/);
    assert.match(renderDashboard({ rows }), /0\/1 workers/);
    assert.match(renderDetails(rows[0]), /audit-files · running/);
    assert.match(renderDetails(rows[0]), /goal:   Audit every file autonomously/);
    assert.match(renderDetails(rows[0]), /status: running/);
    assert.match(renderDetails(rows[0]), /requirement-1/);
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
    assert.match(desktop, /def345 · Audit documentation freshness/);
    assert.match(desktop, /0\/2 actions · 5m00s · finis/);
    assert.match(desktop, /Workflow timeline/);

    const mobile = renderDashboard({
      rows: all, allRows: all, selected: 0, previewRow: all[0],
      filter: 'all', width: 60, height: 24,
    });
    assert.match(mobile, /Runs · all/);
    assert.match(mobile, /abc234 · Audit every file/);
    assert.match(mobile, /def345 · Audit documentation/);
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
    assert.match(output.text, /abc234 · Audit every file/);
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
    assert.match(printed, /bullswarm · abc234/);
    assert.match(printed, /presentation stages:/);
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
    assert.equal(JSON.parse(readFileSync(join(home, 'workflows', 'wf-test', 'cancellation.json'))).requested, true);
    assert.equal(requestCancel(home, 'abc234').alreadyFinished, false);
  } finally { cleanup(); }
});

test('dashboard JSON show includes live state and report when present', () => {
  const { home, cleanup } = fixture();
  try {
    writeFileSync(join(home, 'workflows', 'wf-test', 'report.json'), JSON.stringify({ status: 'completed' }));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.state.intent.goal, 'Audit every file autonomously.');
    assert.deepEqual(shown.report, { status: 'completed' });
  } finally { cleanup(); }
});

test('dashboard rows expose the running action and its live attempt', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    Object.assign(state.attempts[0], {
      pool: 'opencode2', model: 'relay/gpt-5.6-luna', outputBytesObserved: 321,
      lastAgentEvent: { kind: 'shell_command', summary: 'npm test' },
    });
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home)[0];
    assert.equal(row.currentStep.id, 'audit-files');
    assert.equal(row.phase, 'Implementation');
    assert.equal(row.activeAgents[0].model, 'relay/gpt-5.6-luna');
    const tui = renderWorkflowTui(row, { width: 120, height: 40 });
    assert.match(tui, /audit-files · opencode2 · relay\/gpt-5\.6-luna/);
    assert.match(tui, /npm test/);
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
    assert.match(output.text, /audit-files · planner-agent/);
    // Detaching the viewer never asks the kernel to stop.
    assert.equal(existsSync(join(home, 'workflows', 'wf-test', 'cancellation.json')), false);
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
    assert.match(output.text, /def345 · Audit documentation/);
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
    state.lifecycle = { status: 'completed', startedAt: iso(0), finishedAt: iso(120), resultFile: null };
    for (const action of state.actions) Object.assign(action, { status: 'succeeded', startedAt: iso(10), finishedAt: iso(110) });
    state.attempts = [
      { id: 'audit-files-1', actionId: 'audit-files', ordinal: 1, status: 'succeeded', pool: 'luna', startedAt: iso(10), finishedAt: iso(40) },
      { id: 'inspect-audit-1', actionId: 'inspect-audit', ordinal: 1, status: 'succeeded', pool: 'luna', startedAt: iso(50), finishedAt: iso(110) },
    ];
    // Durable action events are what give each dependency level its own
    // timeline segment to navigate between.
    for (const action of state.actions) {
      appendEvent(join(home, 'workflows', 'wf-test'), state, 'action.started', { actionId: action.id });
      appendEvent(join(home, 'workflows', 'wf-test'), state, 'action.finished', { actionId: action.id, status: 'succeeded' });
    }
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
    // A V2 run opens on the unified list; Enter drills into its overview.
    input.emit('data', Buffer.from('\r'));
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
    assert.match(focusedTimeline, /\x1b\[7m── Phase 1 · Implementation/);
    assert.match(agentsText, /Implementation · 1\/1 complete/);
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

test('JSON inspection exposes the same durable state and events as the run directory', () => {
  const { home, cleanup } = fixture();
  try {
    const runDir = join(home, 'workflows', 'wf-test');
    const statePath = join(runDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    appendEvent(runDir, state, 'action.finished', { actionId: 'audit-files', status: 'succeeded' });
    writeFileSync(statePath, JSON.stringify(state));
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.deepEqual(shown.state, JSON.parse(readFileSync(statePath, 'utf8')));
    assert.deepEqual(shown.events, readEvents(runDir));
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

function plain(screen) {
  return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// ---------------------------------------------------------------------------
// Unified application shell: the workflows list, a run, a phase, and an agent
// are four depths of one hierarchy. Each depth carries the same persistent
// breadcrumb, the same key grammar, and the same drill-down, so the helpers
// below read the breadcrumb and the footer structurally — never by panel
// geometry, hint order, or the exact wording a binding happens to use today.
// ---------------------------------------------------------------------------

function shellRunState({ runId, shortId, goal, agentId, startedAt }) {
  const document = createV2GoalDocument({
    goal, cwd: tmpdir(),
    requirements: [{ id: 'requirement-1', text: 'The viewer is unified.', mandatory: true }],
    settings: { scout: false },
  });
  let state = createV2State(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Scan then build.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'scan', purpose: 'Scan the viewer', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['scan.md'], prompt: 'Scan it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['scan'] },
      { id: agentId, purpose: 'Build the viewer', dependsOn: ['scan'], affects: ['requirement-1'], ownedFiles: ['build.md'], prompt: 'Build it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: ['scan'], produces: ['build'] },
      { id: `${agentId}-evidence`, purpose: 'Inspect the build', dependsOn: [agentId], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['build'], produces: [] },
    ] },
  });
  state.lifecycle = { status: 'running', startedAt, finishedAt: null, resultFile: null };
  Object.assign(state.actions[0], { status: 'succeeded', startedAt, finishedAt: startedAt, attempts: 1 });
  Object.assign(state.actions[1], { status: 'running', startedAt, attempts: 1 });
  state.attempts = [
    { id: 'scan-1', actionId: 'scan', ordinal: 1, pool: 'opencode2', model: 'luna', status: 'succeeded', startedAt, finishedAt: startedAt },
    { id: `${agentId}-1`, actionId: agentId, ordinal: 1, pool: 'codex', model: 'sol', status: 'running', startedAt, finishedAt: null },
  ];
  state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
  return state;
}

// Two live runs of the same shape: the sibling exists at every depth, so Tab
// has an equivalent location to land on instead of falling back to the root.
const SHELL_RUNS = [
  {
    runId: 'wf-alpha', shortId: 'aaa111', goal: 'unified-shell', agentId: 'build-alpha',
    startedAt: '2026-08-29T00:02:00.000Z',
  },
  {
    runId: 'wf-beta', shortId: 'bbb222', goal: 'sibling-run', agentId: 'build-beta',
    startedAt: '2026-08-29T00:01:00.000Z',
  },
];

function shellFixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-shell-'));
  for (const run of SHELL_RUNS) {
    const dir = join(home, 'workflows', run.runId);
    mkdirSync(dir, { recursive: true });
    const state = shellRunState(run);
    // Durable action events give each dependency level its own timeline segment.
    appendEvent(dir, state, 'action.started', { actionId: 'scan' });
    appendEvent(dir, state, 'action.finished', { actionId: 'scan', status: 'succeeded' });
    appendEvent(dir, state, 'action.started', { actionId: run.agentId });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
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
    assert.ok(phase.includes('Implementation'), `phase breadcrumb lost its phase: ${phase}`);
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
      ['Workflows', 'aaa111 · unified-shell', 'Implementation', 'build-alpha']);
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
      ['Workflows', 'aaa111 · unified-shell', 'Implementation', 'build-alpha']);

    const sibling = session.press('\t');
    assert.ok(sibling.length, 'Tab repainted the screen');
    // same depth, same phase, the sibling workflow's own agent
    assert.match(sibling, /Agent activity · r refresh/);
    assert.deepEqual(crumbSegments(sibling),
      ['Workflows', 'bbb222 · sibling-run', 'Implementation', 'build-beta']);
    assert.equal(crumbSegments(sibling).length, crumbSegments(atAgent).length);
    assert.doesNotMatch(sibling, /build-alpha/);

    // and Shift+Tab comes back the same way, still at agent depth
    const back = session.press(`${ESC_KEY}[Z`);
    assert.match(back, /Agent activity · r refresh/);
    assert.deepEqual(crumbSegments(back),
      ['Workflows', 'aaa111 · unified-shell', 'Implementation', 'build-alpha']);
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

// A running worker has no durable finish event, so the timeline used to show
// only its level's "├─ started" row for the whole time it ran while the Live
// pane counted its elapsed time. The level must list the worker with the
// spinner and the same live duration, without counting it as a milestone.
test('V2 timeline lists a running worker under its level with a spinner and live elapsed time', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2-live-'));
  try {
    const runId = 'wf-v2live-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2l234' });
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
    // appendEvent stamps committedAt with the wall clock; this fixture needs the
    // durable history to predate the worker that is still running, as it does
    // in a real run, so events are written with explicit timestamps.
    let sequence = 0;
    const emit = (type, committedAt, payload) => {
      sequence += 1;
      appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ sequence, type, schemaVersion: 1, payload, committedAt })}\n`);
      state.events.sequence = sequence;
    };
    emit('workflow.started', iso(0), {});
    emit('planner.finished', iso(1), { turn: 1, ok: true, summary: 'Implement then collect independent evidence.' });
    emit('presentation.stage_started', iso(2), { stageId: 'r1-implementation', label: 'Implementation' });
    emit('action.finished', iso(5), { actionId: 'implement-result', status: 'succeeded' });
    emit('presentation.stage_completed', iso(5), { stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1 });
    // the evidence level has started but its worker has not been dispatched yet
    state.presentation.stages[1].startedAt = iso(6);
    emit('presentation.stage_started', iso(6), { stageId: 'r1-evidence', label: 'Evidence' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const before = renderWorkflowTui(dashboardRows(home)[0], { width: 120, height: 30 });
    const milestones = /Workflow timeline · (\d+) milestones?/.exec(before)[1];
    assert.match(segmentRows(before, 'Evidence').join('\n'), /├─ started/);
    assert.doesNotMatch(segmentRows(before, 'Evidence').join('\n'), /check-result/);

    // the worker starts 65 seconds ago and is still running
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    Object.assign(state.actions[1], { status: 'running', startedAt, attempts: 1 });
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay-2', model: 'gpt-5.6-luna', startedAt, finishedAt: null, lastActivityAt: startedAt, outputBytesObserved: 42 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const running = renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 0 });
    const evidence = segmentRows(running, 'Evidence').map(normalizeRow);
    assert.equal(evidence[0], 'HH:MM ├─ started');
    assert.match(evidence[1], /^HH:MM │ ├─⠋ check-result 1m0[5-9]s$/, evidence.join('\n'));
    // the spinner animates with the frame counter like the Live pane
    assert.match(segmentRows(renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 3 }), 'Evidence').join('\n'), /├─⠸ check-result/);
    // a live row is not a durable milestone
    assert.equal(/Workflow timeline · (\d+) milestones?/.exec(running)[1], milestones);
    // the level header still reads running rather than a finished duration
    assert.equal(timelineSegments(running).find((segment) => segment.label === 'Evidence').elapsed, 'running');

    // the agent pane leads with the elapsed time; token usage only exists once the attempt finishes
    const agents = renderWorkflowTui(row, { width: 130, height: 22, focus: 1, spinnerFrame: 0 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.match(agents, /check-result · relay-2 · gpt-5\.6-luna · #1 · 1m0[5-9]s/);
    assert.doesNotMatch(agents, /#1 · pending/);
    assert.match(agents, /Tokens · pending/);

    // once the worker finishes, its durable row replaces the live one
    const finishedAt = new Date().toISOString();
    Object.assign(state.actions[1], { status: 'succeeded', finishedAt });
    state.attempts[1] = { ...state.attempts[1], status: 'succeeded', finishedAt, usage: { tokens: { totalKnown: 1200 } } };
    emit('evidence.recorded', finishedAt, { actionId: 'check-result', requirements: ['result-correct'], statuses: { 'result-correct': 'passed' } });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const done = renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 120, height: 30 });
    const doneRows = segmentRows(done, 'Evidence').map(normalizeRow);
    assert.equal(doneRows.filter((line) => line.includes('check-result')).length, 1, doneRows.join('\n'));
    assert.match(doneRows.join('\n'), /├─✓ check-result 1m0[5-9]s/);
    assert.match(renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 130, height: 22, focus: 1, phaseIndex: 1 }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), /#1 · 1m0[5-9]s · 1\.2k tok/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('V2 attempt rows and the agent pane show the applied reasoning level next to the model', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-reasoning-'));
  try {
    const runId = 'wf-v2reas-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
      workerRouting: { reasoning: 'xhigh' },
    });
    let state = createV2State(goal, { runId, shortId: 'v2r234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', reasoning: 'max', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    state.presentation.stages[0].startedAt = iso(2);
    state.presentation.stages[0].completedAt = iso(5);
    Object.assign(state.actions[0], { status: 'succeeded', startedAt: iso(2), finishedAt: iso(5), attempts: 1 });
    // Finished attempt: the action's own override was applied.
    state.attempts.push({
      id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'succeeded',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: iso(5),
      reasoning: { requested: 'max', applied: 'max', source: 'action', clamped: false },
      routing: { reason: 'most-behind capable pool', candidates: [], effort: 'low', lane: 'build' },
    });
    state.presentation.stages[1].startedAt = iso(6);
    Object.assign(state.actions[1], { status: 'running', startedAt: iso(6), attempts: 1 });
    // Running attempt: the run-wide level was clamped to what the connector takes.
    state.attempts.push({
      id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running',
      pool: 'relay-2', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null,
      reasoning: { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const live = renderWorkflowTui(row, { width: 120, height: 30 });
    // The live row shows the level the running worker is actually thinking at.
    assert.match(live, /check-result · relay-2 · gpt-5\.6-luna · high/);
    // Phase 1 holds the finished attempt; its own override reads next to the model.
    const phaseOne = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 });
    assert.match(phaseOne, /implement-result · relay · gpt-5\.6-luna · max · #1/);
    assert.match(phaseOne, /succeeded · gpt-5\.6-luna · max/);
    // The drilled-in agent pane states it as a labelled field beside effort.
    const agentPane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 });
    assert.match(agentPane, /succeeded · gpt-5\.6-luna · max/);
    // The V2 tier lives under attempt.routing; both fields read correctly.
    assert.match(agentPane, /relay · attempt 1 · effort low · reasoning max/);
    // Narrow mode keeps the same fact on the single full-width agent pane.
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 1, agentIndex: 0 });
    assert.match(narrow, /gpt-5\.6-luna · max/);
    // The durable record is what observation reads, so JSON carries it too.
    assert.deepEqual(
      dashboardJson(home, { token: 'v2r234' }).state.attempts.map((attempt) => attempt.reasoning.applied),
      ['max', 'high'],
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('attempts without a reasoning record render exactly as before', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-noreasoning-'));
  try {
    const runId = 'wf-v2plain-abcdef';
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const goal = createV2GoalDocument({
      goal: 'Implement and prove a result envelope', cwd: '/tmp/repo',
      requirements: [{ id: 'result-correct', text: 'The result envelope is correct' }],
      settings: { scout: false, concurrency: 2 },
    });
    let state = createV2State(goal, { runId, shortId: 'v2p234' });
    state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Implement then collect independent evidence.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'implement-result', purpose: 'Implement result envelope', dependsOn: [], affects: ['result-correct'], ownedFiles: ['src/result.js'], prompt: 'Implement it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['result'] },
        { id: 'check-result', purpose: 'Collect independent evidence', dependsOn: ['implement-result'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['result-correct'], inputs: ['result'], produces: [] },
      ] },
    });
    Object.assign(state.actions[0], { status: 'running', startedAt: iso(2), attempts: 1 });
    state.presentation.stages[0].startedAt = iso(2);
    state.attempts.push({
      id: 'implement-result-1', actionId: 'implement-result', ordinal: 1, status: 'running',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(2), finishedAt: null, reasoning: null,
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const live = renderWorkflowTui(row, { width: 120, height: 30 });
    assert.match(live, /implement-result · relay · gpt-5\.6-luna\s+\d/);
    assert.doesNotMatch(live, /gpt-5\.6-luna · /);
    const pane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 });
    assert.match(pane, /implement-result · relay · gpt-5\.6-luna · #1/);
    const agentPane = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 });
    assert.match(agentPane, /relay · attempt 1 · effort auto/);
    assert.doesNotMatch(agentPane, /reasoning/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Rendering behaviours that outlived the V1 executor.
//
// The authored-graph removal deleted the tests that drove workflowPanelModel
// and renderWorkflowTui with a V1 state shape, but the behaviours they covered
// are still live for V2 runs: blocked-action naming, one segment header per
// phase change, the mid-segment continuation header, parallel work grouped in
// declared level order, the narrow layout, and auto-follow. The fixtures below
// rebuild those situations out of a real durable V2 state plus real durable
// events, so the assertions are ported and the V1 state shape is not.
// ---------------------------------------------------------------------------

// appendEvent stamps committedAt from the wall clock. These fixtures run on the
// fixed `iso()` clock instead, which each event carries in its payload, so the
// durable JSONL is written for real and read back at its fixture time.
function durableEvents(dir) {
  return readEvents(dir).map((event) => ({
    ...event,
    committedAt: event.payload?.committedAt ?? event.committedAt,
  }));
}

const v2Action = (overrides) => ({
  dependsOn: [], affects: [], ownedFiles: [], prompt: 'Do it.',
  lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  ...overrides,
});

// One accepted V2 program on disk: durable state.json plus the two events every
// run opens with. The caller fills in action outcomes and emits the rest.
function newV2Run({
  runId, shortId, goal, actions, settings = {}, summary = 'One bounded program.',
  requirements = [{ id: 'requirement-1', text: 'The goal is delivered.', mandatory: true }],
}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-v2render-'));
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const document = createV2GoalDocument({
    goal, cwd: home, requirements, settings: { scout: false, ...settings },
  });
  let state = createV2DurableState(document, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary,
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
  });
  state.lifecycle = { status: 'running', startedAt: iso(0), finishedAt: null, resultFile: null };
  state.planner.attempts.push({
    ordinal: 1, turn: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna',
    startedAt: iso(2), finishedAt: iso(10),
  });
  const emit = (type, committedAt, payload = {}) => appendEvent(dir, state, type, { ...payload, committedAt });
  emit('workflow.started', iso(0));
  emit('planner.finished', iso(10), { turn: 1, ok: true, summary });
  const byId = Object.fromEntries(state.actions.map((action) => [action.id, action]));
  const succeed = (id, from, to) => {
    Object.assign(byId[id], { status: 'succeeded', startedAt: iso(from), finishedAt: iso(to), attempts: 1 });
    state.attempts.push({
      id: `${id}-1`, actionId: id, ordinal: 1, status: 'succeeded',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(from), finishedAt: iso(to),
    });
  };
  const start = (id, from) => {
    Object.assign(byId[id], { status: 'running', startedAt: iso(from), attempts: 1 });
    state.attempts.push({
      id: `${id}-1`, actionId: id, ordinal: 1, status: 'running',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(from), finishedAt: null,
    });
  };
  // The row the dashboard would build for this run: durable state read back
  // from disk, durable events read back from the JSONL.
  const row = () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const durable = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    return {
      runId, shortId, status: durable.lifecycle.status, runDir: dir,
      state: durable, events: durableEvents(dir),
    };
  };
  return {
    home, dir, state, byId, emit, succeed, start, row,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const segmentLabels = (screen) => timelineSegments(screen).map((segment) => segment.label);

// Preflight, a finished Discovery phase, and a running Implementation phase.
// The Evidence phase is planned but never started, so it never opens a segment.
function segmentedV2Run() {
  const run = newV2Run({
    runId: 'wf-segment-aaaaaa', shortId: 'sgm234',
    goal: 'Discover, implement, then prove it.',
    summary: 'Discover, implement, prove.',
    actions: [
      v2Action({ id: 'discover-a', purpose: 'Discover the inputs', lane: 'analyze', produces: ['inputs'] }),
      v2Action({ id: 'discover-b', purpose: 'Discover the outputs', lane: 'analyze', produces: ['outputs'] }),
      v2Action({ id: 'implement-a', purpose: 'Implement the module', ownedFiles: ['src/a.js'], dependsOn: ['discover-a'], inputs: ['inputs'], produces: ['module'], affects: ['requirement-1'] }),
      v2Action({ id: 'implement-b', purpose: 'Implement the adapter', ownedFiles: ['src/b.js'], dependsOn: ['discover-b'], inputs: ['outputs'], produces: ['adapter'], affects: ['requirement-1'] }),
      v2Action({ id: 'verify-all', purpose: 'Prove every requirement', lane: 'analyze', dependsOn: ['implement-a', 'implement-b'], inputs: ['module', 'adapter'], evidenceFor: ['requirement-1'] }),
    ],
  });
  run.succeed('discover-a', 20, 80);
  run.succeed('discover-b', 20, 90);
  run.succeed('implement-a', 160, 220);
  run.start('implement-b', 230);
  run.state.presentation.stages[0].startedAt = iso(20);
  run.state.presentation.stages[0].completedAt = iso(150);
  run.state.presentation.stages[1].startedAt = iso(160);
  run.emit('presentation.stage_started', iso(20), { stageId: 'r1-discovery', label: 'Discovery' });
  run.emit('action.finished', iso(80), { actionId: 'discover-a', status: 'succeeded' });
  run.emit('action.finished', iso(90), { actionId: 'discover-b', status: 'succeeded' });
  run.emit('presentation.stage_completed', iso(150), { stageId: 'r1-discovery', label: 'Discovery', status: 'completed', completed: 2, total: 2 });
  run.emit('presentation.stage_started', iso(160), { stageId: 'r1-implementation', label: 'Implementation' });
  run.emit('action.finished', iso(220), { actionId: 'implement-a', status: 'succeeded' });
  return run;
}

// One phase with more rows than any short viewport holds.
function longPhaseV2Run() {
  const works = Array.from({ length: 12 }, (_, index) => v2Action({
    id: `work-${index}`, purpose: `Implement work ${index}`,
    ownedFiles: [`src/work-${index}.js`], produces: [`artifact-${index}`], affects: ['requirement-1'],
  }));
  const run = newV2Run({
    runId: 'wf-longphase-aaaaaa', shortId: 'lng234',
    goal: 'Render more rows than the viewport holds.',
    actions: [
      ...works,
      v2Action({ id: 'work-tail', purpose: 'Implement the tail', ownedFiles: ['src/tail.js'], produces: ['artifact-tail'], affects: ['requirement-1'] }),
      v2Action({
        id: 'verify-all', purpose: 'Prove every requirement', lane: 'analyze',
        dependsOn: [...works.map((action) => action.id), 'work-tail'],
        inputs: [...works.map((_, index) => `artifact-${index}`), 'artifact-tail'],
        evidenceFor: ['requirement-1'],
      }),
    ],
  });
  run.state.presentation.stages[0].startedAt = iso(20);
  run.emit('presentation.stage_started', iso(20), { stageId: 'r1-implementation', label: 'Implementation' });
  works.forEach((action, index) => {
    run.succeed(action.id, 60 + index * 120, 120 + index * 120);
    run.emit('action.finished', iso(120 + index * 120), { actionId: action.id, status: 'succeeded' });
  });
  run.start('work-tail', 60 + 12 * 120);
  return run;
}

test('a dependency level whose action never dispatched names the dependency that blocked it', () => {
  const run = newV2Run({
    runId: 'wf-blocked-aaaaaa', shortId: 'blk234',
    goal: 'Harden the core after proving it.',
    summary: 'Implement, prove, then harden.',
    settings: { executionMode: 'program' },
    requirements: [
      { id: 'requirement-1', text: 'The core is correct.', mandatory: true },
      { id: 'requirement-2', text: 'The core is hardened.', mandatory: false },
    ],
    actions: [
      v2Action({ id: 'implement-core', purpose: 'Implement the core', ownedFiles: ['src/core.js'], produces: ['core'], affects: ['requirement-1'] }),
      v2Action({ id: 'verify-core', purpose: 'Prove the core', lane: 'analyze', dependsOn: ['implement-core'], inputs: ['core'], produces: ['core-report'], evidenceFor: ['requirement-1'] }),
      v2Action({ id: 'harden-core', purpose: 'Harden the core', ownedFiles: ['src/harden.js'], dependsOn: ['verify-core'], inputs: ['core-report'], affects: ['requirement-2'] }),
    ],
  });
  try {
    run.succeed('implement-core', 60, 120);
    Object.assign(run.byId['verify-core'], {
      status: 'failed', startedAt: iso(130), finishedAt: iso(190), attempts: 1,
      lastFailure: { kind: 'verdict', message: 'the core report is not passing' },
    });
    run.state.attempts.push({
      id: 'verify-core-1', actionId: 'verify-core', ordinal: 1, status: 'failed',
      pool: 'relay', model: 'gpt-5.6-luna', startedAt: iso(130), finishedAt: iso(190),
    });
    // A blocked action is marked terminal without ever being started: the
    // scheduler records finishedAt and the dependency failure, and no attempt
    // is ever appended for it.
    Object.assign(run.byId['harden-core'], {
      status: 'blocked', startedAt: null, finishedAt: iso(195),
      lastFailure: { kind: 'dependency', message: 'dependency verify-core did not succeed' },
    });
    run.emit('action.finished', iso(120), { actionId: 'implement-core', status: 'succeeded' });
    run.emit('action.finished', iso(190), { actionId: 'verify-core', status: 'failed' });
    run.emit('action.finished', iso(195), { actionId: 'harden-core', status: 'blocked', why: 'dependency verify-core did not succeed' });
    run.state.ledger.requirements['requirement-1'].status = 'failed';
    run.state.lifecycle = { status: 'partial', startedAt: iso(0), finishedAt: iso(200), resultFile: null };
    const row = run.row();

    const model = workflowPanelModel(row, { phaseIndex: 2 });
    const blockedLevel = model.phases[2];
    assert.equal(blockedLevel.label, 'Level 3 · harden-core');
    assert.deepEqual(blockedLevel.blockedActions, [
      { id: 'harden-core', kind: 'action', blockedBy: ['verify-core'] },
    ]);
    // Never dispatched means no attempt, so the agent list is empty and the
    // pane must explain the absence rather than claim nothing started yet.
    assert.deepEqual(model.agents, []);
    assert.deepEqual(model.phases[0].blockedActions, []);
    assert.deepEqual(model.phases[1].blockedActions, []);

    const agents = plain(renderWorkflowTui(row, { width: 120, height: 30, phaseIndex: 2, focus: 1 }));
    assert.match(agents, /⊘ harden-core · never dispatched · blocked by verify-core/);
    assert.doesNotMatch(agents, /Not started yet/);

    const detail = plain(renderWorkflowTui(row, { width: 120, height: 30, phaseIndex: 2, focus: 2 }));
    assert.match(detail, /⊘ harden-core · work · never dispatched/);
    assert.match(detail, /blocked by verify-core/);

    // The timeline marks the same action with ⊘, never with the ✓ a finished
    // action carries or the × a dispatched failure carries.
    const timeline = timelinePaneRows(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 2 }));
    assert.match(timeline.join('\n'), /├─⊘ harden-core/);
    assert.match(timeline.join('\n'), /├─× verify-core/);
  } finally { run.cleanup(); }
});

test('the timeline opens one segment header per phase change instead of prefixing every event line', () => {
  const run = segmentedV2Run();
  try {
    const screen = renderWorkflowTui(run.row(), { width: 120, height: 44 });
    const pane = timelinePaneRows(screen);

    // One header per phase change, in chronological order, none repeated
    // between two events of the same phase.
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discovery', 'Implementation']);
    assert.equal(pane.filter((line) => /^─{2,}\s+Phase 1 · Discovery\s/.test(line)).length, 1);

    // The event lines themselves no longer name their phase.
    assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
    assert.deepEqual(pane.filter((line) => /\[(Discovery|Implementation|Preflight):? ?[^\]]*\]/.test(line)), []);

    // Glyphs, action names, timestamps and right-aligned durations survive.
    // (timestamps render in the local zone, so only their shape is asserted)
    assert.deepEqual(segmentRows(screen, 'Discovery').map(normalizeRow), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ discover-a 1m00s',
      'HH:MM │ ├─✓ discover-b 1m10s',
      'HH:MM └─✓ completed 2/2',
    ]);

    // The running phase keeps its started row, shows its live worker, and
    // reports no completion.
    const implementation = segmentRows(screen, 'Implementation').join('\n');
    assert.match(implementation, /├─ started/);
    assert.match(implementation, /├─✓ implement-a\s+1m00s/);
    assert.match(implementation, /├─.\simplement-b/);
    assert.deepEqual(segmentRows(screen, 'Implementation').filter((line) => line.includes('completed')), []);
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Implementation').elapsed, 'running');
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Discovery').elapsed, '2m10s');

    // Every blank separator inside the timeline introduces a segment header.
    pane.forEach((line, index) => {
      if (line.trim() || index === pane.length - 1) return;
      const next = pane[index + 1];
      assert.ok(!next.trim() || /^─{2,}/.test(next), `blank row ${index} is not a segment separator: ${next}`);
    });

    // A planned phase that never started opens no segment at all.
    assert.equal(workflowPanelModel(run.row()).phases[2].label, 'Evidence');
    assert.deepEqual(segmentLabels(screen).filter((label) => label === 'Evidence'), []);
  } finally { run.cleanup(); }
});

test('parallel dependency levels stay grouped in declared level order', () => {
  const run = newV2Run({
    runId: 'wf-parallel-aaaaaa', shortId: 'par234',
    goal: 'Interleave two dependency levels in time.',
    summary: 'Two independent builds, then two proofs.',
    settings: { executionMode: 'program', concurrency: 2 },
    requirements: [
      { id: 'requirement-1', text: 'The module works.', mandatory: true },
      { id: 'requirement-2', text: 'The adapter works.', mandatory: true },
    ],
    actions: [
      v2Action({ id: 'implement-a', purpose: 'Implement the module', ownedFiles: ['src/a.js'], produces: ['a'], affects: ['requirement-1'] }),
      v2Action({ id: 'implement-b', purpose: 'Implement the adapter', ownedFiles: ['src/b.js'], produces: ['b'], affects: ['requirement-2'] }),
      v2Action({ id: 'verify-a', purpose: 'Prove the module', lane: 'analyze', dependsOn: ['implement-a'], inputs: ['a'], evidenceFor: ['requirement-1'] }),
      v2Action({ id: 'verify-b', purpose: 'Prove the adapter', lane: 'analyze', dependsOn: ['implement-b'], inputs: ['b'], evidenceFor: ['requirement-2'] }),
    ],
  });
  try {
    // Levels overlap in wall-clock time: level 2's first proof finishes before
    // level 1's second build does.
    run.succeed('implement-a', 60, 120);
    run.succeed('verify-a', 150, 180);
    run.succeed('implement-b', 210, 240);
    run.succeed('verify-b', 250, 280);
    run.emit('action.finished', iso(120), { actionId: 'implement-a', status: 'succeeded' });
    run.emit('evidence.recorded', iso(180), { actionId: 'verify-a', status: 'succeeded' });
    run.emit('action.finished', iso(240), { actionId: 'implement-b', status: 'succeeded' });
    run.emit('evidence.recorded', iso(280), { actionId: 'verify-b', status: 'succeeded' });
    for (const requirement of Object.values(run.state.ledger.requirements)) requirement.status = 'passed';
    run.state.lifecycle = { status: 'completed', startedAt: iso(0), finishedAt: iso(300), resultFile: null };
    const row = run.row();

    // The durable events really are interleaved; the grouping is the renderer's.
    assert.deepEqual(
      row.events.filter((event) => event.payload.actionId).map((event) => event.payload.actionId),
      ['implement-a', 'verify-a', 'implement-b', 'verify-b'],
    );

    const screen = renderWorkflowTui(row, { width: 120, height: 40 });
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Level 1 · Parallel work', 'Level 2 · Parallel analysis']);
    assert.deepEqual(segmentRows(screen, 'Level 1 · Parallel work').map(normalizeRow), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ implement-a 1m00s',
      'HH:MM │ ├─✓ implement-b 30s',
      'HH:MM └─✓ completed 2/2',
    ]);
    assert.deepEqual(segmentRows(screen, 'Level 2 · Parallel analysis').map(normalizeRow).slice(0, 4), [
      'HH:MM ├─ started',
      'HH:MM │ ├─✓ verify-a 30s',
      'HH:MM │ ├─✓ verify-b 30s',
      'HH:MM └─✓ completed 2/2',
    ]);
    // Level 2 opened while level 1 was still running: the clock column proves
    // the rows were reordered by declared level, not by time.
    const clock = (label, index) => segmentRows(screen, label)[index].slice(0, 5);
    assert.ok(clock('Level 1 · Parallel work', 2) > clock('Level 2 · Parallel analysis', 0),
      `level 1's second worker should postdate level 2's start:\n${timelinePaneRows(screen).join('\n')}`);
    // Dependency levels are not numbered phases, so no phase prefix is added.
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
    assert.doesNotMatch(timelinePaneRows(screen).join('\n'), /── Phase \d/);
  } finally { run.cleanup(); }
});

test('a timeline viewport that starts mid-segment re-emits a continuation header', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    // With room for every row the phase is introduced once and never continued.
    const tall = renderWorkflowTui(row, { width: 100, height: 46 });
    assert.deepEqual(segmentLabels(tall), ['Preflight', 'Implementation']);
    assert.deepEqual(timelinePaneRows(tall).filter((line) => line.includes('continued')), []);

    const short = renderWorkflowTui(row, { width: 100, height: 22 });
    const pane = timelinePaneRows(short);
    const marker = pane.findIndex((line) => line.includes('earlier timeline rows'));
    assert.ok(marker >= 0, `expected a scrolled viewport:\n${pane.join('\n')}`);
    // The scrolled-into segment is re-announced before its first visible event,
    // and the first visible event is a timestamped milestone, never an orphaned
    // detail row.
    assert.match(pane[marker + 1], /^─{2,}\s+Phase 1 · Implementation · continued\s+─{2,}/);
    assert.match(pane[marker + 2], /^\d{2}:\d{2}\s/);
    assert.deepEqual(segmentLabels(short), ['Implementation · continued']);
    assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
  } finally { run.cleanup(); }
});

test('the timeline auto-follows the newest event until the viewer scrolls back', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    const following = renderWorkflowTui(row, { width: 100, height: 22 });
    const pane = timelinePaneRows(following);
    // Auto-follow ends on the newest event — the running worker — and never
    // claims there is anything newer below the viewport.
    assert.match(pane.filter((line) => line.trim()).at(-1), /work-tail/);
    assert.deepEqual(pane.filter((line) => line.includes('newer timeline rows')), []);
    assert.match(plain(following), /Timeline · auto-following newest event/);

    // Scrolling back holds older rows in place and says how much is newer.
    const scrolled = timelinePaneRows(renderWorkflowTui(row, { width: 100, height: 22, detailScroll: 4 }));
    assert.match(scrolled.at(-1), /↓ 4 newer timeline rows/);
    assert.deepEqual(scrolled.filter((line) => line.includes('work-tail')), []);
    assert.match(scrolled[0], /↑ \d+ earlier timeline rows/);
    // The continuation header travels with the scrolled viewport too.
    assert.match(scrolled[1], /^─{2,}\s+Phase 1 · Implementation · continued\s+─{2,}/);
  } finally { run.cleanup(); }
});

test('narrow timeline rendering keeps the segment headers and never overflows the pane', () => {
  const run = segmentedV2Run();
  const long = longPhaseV2Run();
  try {
    const row = run.row();
    // Tall enough that the whole timeline fits: nothing here is a scroll artifact.
    const screen = renderWorkflowTui(row, { width: 60, height: 44 });
    assert.deepEqual(segmentLabels(screen), ['Preflight', 'Discovery', 'Implementation']);
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
    assert.match(segmentRows(screen, 'Discovery').join('\n'), /├─✓ discover-a/);
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'Implementation').elapsed, 'running');

    // Headers obey the narrow width like every other row, on every narrow pane
    // the viewer can open.
    const overflow = (rendered, width) => plain(rendered)
      .split('\n').filter((line) => [...line].length > width);
    for (const width of [60, 52, 44]) {
      for (const options of [
        { focus: 0 }, { focus: 0, mobileTimeline: false }, { focus: 1 }, { focus: 2 },
        { focus: 0, timelineSelection: 0 }, { focus: 0, orchestratorDetail: true }, { focus: 0, workflowVerbose: true },
      ]) {
        const narrow = renderWorkflowTui(row, { width, height: 26, ...options });
        assert.deepEqual(overflow(narrow, width), [], `width ${width} ${JSON.stringify(options)} overflowed`);
      }
    }

    // And the narrow viewport re-emits the continuation header when it scrolls.
    const scrolled = renderWorkflowTui(long.row(), { width: 60, height: 22 });
    const narrowPane = timelinePaneRows(scrolled);
    const marker = narrowPane.findIndex((line) => line.includes('earlier timeline'));
    assert.ok(marker >= 0, `expected a scrolled narrow viewport:\n${narrowPane.join('\n')}`);
    assert.match(narrowPane[marker + 1], /^─{2,}\s+Phase 1 · Implementation · continue/);
    assert.deepEqual(overflow(scrolled, 60), []);
  } finally { run.cleanup(); long.cleanup(); }
});

test('a narrow terminal wraps the agent detail pane to its full width, not the sidebar remainder', () => {
  const { home, cleanup } = fixture();
  try {
    const row = dashboardRows(home)[0];
    const contentWidths = (screen) => plain(screen).split('\n')
      .filter((line) => line.startsWith('│') && line.endsWith('│'))
      .map((line) => line.slice(1, -1).trimEnd().length);
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 });
    assert.match(plain(narrow), /audit-files · planner-agent/);
    const widest = Math.max(...contentWidths(narrow));
    // 60 columns minus the 34-column sidebar minus padding is 22: the width the
    // detail used to wrap at even though the narrow pane spans the whole screen.
    assert.ok(widest > 22, `narrow detail still wraps at ${widest} columns`);
    assert.ok(widest <= 58, `narrow detail overflows the panel: ${widest} columns`);
    const wide = plain(renderWorkflowTui(row, { width: 120, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(wide, /audit-files · planner-agent/);
    // Wide layout is unchanged: two panels side by side on every body row.
    assert.ok(wide.split('\n').some((line) => /^│.*││.*│$/.test(line)));
  } finally { cleanup(); }
});
