import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DASHBOARD_KEYS, activeDashboardRows, agentDetailLines, dashboardModel, dashboardRows, overviewSnapshot, readLicencePerDay, renderDashboard, renderDashboardPage, renderDetails, renderWorkflowTui, workflowPanelModel, requestCancel, dashboardJson, runDashboard, writeClipboard } from '../src/workflow/dashboard.js';
import { readRollups } from '../src/workflow/rollup.js';
import { listTasks } from '../src/lib/tasks.js';
import { stepClockText } from '../src/workflow/step-model.js';
import { SUBSTITUTED_GLYPHS } from '../src/lib/glyphs.js';
import { appendEvent, readEvents } from '../src/workflow/events.js';
import { cmdWorkflow } from '../src/workflow/cli.js';
import { createV2GoalDocument, createV2DurableState, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

// The fixture's clocks were recorded in Hong Kong and the expectations quote
// them as HKT, so this file reads them there on any machine (CI runs in UTC).
process.env.TZ = 'Asia/Hong_Kong';

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

// Run v2 draws the timeline flat: a `── timeline · <n> phases · <n> attempts`
// rule and the rows under it, one column in from the left margin, down to the
// sticky nav. The pane is still read structurally, so the assertions do not
// depend on dash padding or the terminal width in use.
function timelinePaneRows(screen) {
  const rows = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
  const top = rows.findIndex((line) => /^──+ timeline[ ·─]/.test(line.trimEnd()));
  if (top < 0) return [];
  const pane = [];
  for (const line of rows.slice(top + 1)) {
    // The sticky nav closes the page: the shell's button row, or Run v2's
    // `[ back ] [ ● 1.<id> ]` followed by its own hint text.
    if (/^\s*\[.+\]\s*$/.test(line) || /^\s*\[ back \] \[/.test(line)) break;
    pane.push(line.replace(/^ /, '').trimEnd());
  }
  // The nav is sticky, so a short body is padded out to it; those blanks are
  // the frame's, not the timeline's.
  while (pane.length && !pane.at(-1).trim()) pane.pop();
  return pane;
}

// Run v2's phase rule is `── <glyph> Phase <n> · <name> ───… <start> → <end> ·
// <duration> · <done>/<total> ──` (the phone splits the right half onto its
// own dim line). The label is the phase name with its glyph and number off,
// and `elapsed` is the duration cell out of the right half.
function timelineSegments(screen) {
  const segments = [];
  const stripName = (name) => String(name)
    .replace(/^[✓✗▶○⊘!×⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\d*\s*·?\s*/, '')
    .replace(/^Phase \d+ · /, '')
    .trim();
  const durationOf = (right) => {
    const cells = String(right).split(' · ').map((cell) => cell.trim());
    // `<start> → <end> · <duration> · <done>/<total>`, or the waiting phase's
    // `<n> attempts · <duration> · <done>/<total> · waits for <step>`.
    const at = cells.findIndex((cell) => /^\d+\/\d+$/.test(cell));
    return at > 0 ? cells[at - 1] : null;
  };
  for (const line of timelinePaneRows(screen)) {
    const header = /^─{2,}\s+(.+?)\s+─{2,}\s*(.*?)\s*─*$/.exec(line);
    if (/^─{2,}/.test(line)) {
      const name = header ? header[1] : line.replace(/─+/g, ' ').trim();
      segments.push({ label: stripName(name), elapsed: header ? durationOf(header[2]) : null, rows: [] });
    } else if (segments.length && line.trim()) {
      const span = /^\s*(?:\d{2}:\d{2}|—) (?:→|-->) (?:\d{2}:\d{2}|now|—) · (\S+) · \d+\/\d+/.exec(line);
      // The phone puts the phase's span facts on the row under its rule.
      if (span && segments.at(-1).elapsed == null) segments.at(-1).elapsed = span[1];
      else segments[segments.length - 1].rows.push(line);
    }
  }
  return segments;
}

function normalizeRow(line) {
  // Run v2 indents its timeline rows one column inside the page body.
  return line.trim().replace(/^\d{2}:\d{2}/, 'HH:MM').replace(/\s+/g, ' ');
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
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay:b', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null, lastActivityAt: iso(7), outputBytesObserved: 42, lastAgentEvent: { at: iso(7), kind: 'tool', summary: 'node --test' } });
    const emit = (type, committedAt, payload) => appendEvent(dir, state, type, { ...payload, committedAt });
    emit('workflow.started', iso(0), {});
    emit('planner.finished', iso(1), { turn: 1, ok: true, summary: 'Implement then collect independent evidence.' });
    emit('presentation.stage_started', iso(2), { stageId: 'r1-implementation', label: 'Implementation' });
    emit('action.finished', iso(5), { actionId: 'implement-result', status: 'succeeded' });
    emit('presentation.stage_completed', iso(5), { stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1 });
    emit('presentation.stage_started', iso(6), { stageId: 'r1-evidence', label: 'Evidence' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    // 0.33.0 paints the plan strip, the phase count and the run's pool share
    // above the timeline, so the same timeline needs the rows those take.
    const screen = renderWorkflowTui(row, { width: 120, height: 42 });
    assert.doesNotMatch(screen, /\[Workflow Planner\] plan created/);
    // Run v2 rule 1: the step counts live in the header, so the plan rule
    // carries only the phase the run is in. The 0.35.1 colour pass dims the
    // rule dashes and paints the glyphs, so these read the words.
    assert.match(plain(screen), /── plan · phase 2 of 2 ─/);
    assert.match(plain(screen), /^ ● v2d234 · running · 1 of 2 steps done/m);
    // The plan boxes are numbered and arrow-chained across the width. Run v2
    // rule 2: a finished single step and a pending phase show no count.
    assert.match(plain(screen), /\[✓ 1 Implementation\] → \[▶ 2 Evidence 0\/1\]/);
    // Rule 6: Preflight keeps the `● goal accepted · goal.json` row only.
    assert.match(plain(screen), /● goal accepted · goal\.json/);
    // Rule 6: the phase rule carries start → end, duration and done/total, so
    // the `started` and `completed` filler rows are gone.
    assert.match(plain(screen), /── ✓ Phase 1 · Implementation ─.* → .* · 3s · 1\/1/);
    assert.doesNotMatch(segmentRows(screen, 'Implementation').join('\n'), /├─ started/);
    assert.doesNotMatch(segmentRows(screen, 'Implementation').join('\n'), /└─✓ completed/);
    assert.doesNotMatch(segmentRows(screen, 'Implementation').join('\n'), /phase active/);
    assert.match(plain(screen), /── ▶ Phase 2 · Evidence ─/);
    assert.doesNotMatch(timelinePaneRows(screen).join('\n'), /\[Phase:/);
    assert.match(plain(screen), /▶ check-result · relay:b · /);
    // The timeline row carries the attempt's own clock, pool · model · effort
    // and the word `running`, with its duration right-aligned at the end.
    assert.match(plain(screen), /^ \d{2}:\d{2}  ▶ check-result · relay:b · gpt-5\.6-luna · — · running\s+\S+$/m);
    assert.equal(workflowPanelModel(row).phases[0].name, 'r1-implementation');
    // The Run page draws no panel border at any width: flat rules only. The
    // timeline's own ├─/│ tree glyphs are content, not a frame, so the test
    // looks for a border at the edge of a row.
    for (const line of plain(screen).split('\n')) {
      assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
        `a panel border survived: ${line}`);
    }
    const narrowTimeline = renderWorkflowTui(row, { width: 60, height: 26, focus: 0 });
    const narrowPhases = renderWorkflowTui(row, { width: 60, height: 26, focus: 0, mobileTimeline: false });
    const narrowAgents = renderWorkflowTui(row, { width: 60, height: 26, focus: 1 });
    assert.match(plain(narrowTimeline), /── timeline · \d+ phases? · \d+ attempts?/);
    // Run v2 rule 2: at <120 the plan folds to one glyph strip, so the phone
    // never draws the `── phases · N` browser next to the timeline.
    assert.doesNotMatch(plain(narrowTimeline), /── phases · 2/);
    assert.match(plain(narrowPhases), / plan  [✓▶○]+ /);
    assert.doesNotMatch(plain(narrowPhases), /\[✓ 1 Implementation/);
    // Run v2 folds the old agent pane into the timeline: the phase rule names
    // the phase and the row under it carries its span and done/total.
    assert.match(plain(narrowAgents), /── ▶ Phase 2 · Evidence/);
    assert.match(plain(narrowAgents), /^ \d{2}:\d{2} → now · \S+ · 0\/1$/m);
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
    input.emit('data', Buffer.from('r')); // Home -> Runs
    assert.match(plain(lastFrame(output)), /── active ─/);
    assert.match(plain(lastFrame(output)), /abc234.*Audit every file/);
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
  } finally { cleanup(); }
});

test('a run ID passed to the dashboard opens that run on the Run page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30, token: 'v2n456' });
    const runPage = lastFrame(session.output);
    assert.match(frameHeader(runPage), /^ ✓ v2n456 · completed · 0 of 0 steps done/);
    assert.match(plain(runPage), /── timeline · \d+ phases? · \d+ attempts?/);
    // The plan is phase boxes, and this run dispatched no action, so Enter has
    // no step to open and says so instead of inventing one.
    session.press('\r');
    assert.match(plain(lastFrame(session.output)), /No step belongs to this phase yet/);
    session.press(ESC_KEY); // and out to Home
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('r'); // where r lists every run
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('a Runs-table cursor on a finished run survives the refresh tick, so Enter opens that run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    // A short refresh so several ticks land between the arrow key and Enter.
    const session = shellSession(home, { columns: 120, rows: 30, refreshMs: 10 });
    session.press('r'); // Home -> Runs (active filter, the day table below)
    session.press('\u001b[B'); // active run -> the finished run's table row
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    session.press('\r');
    assert.match(frameHeader(lastFrame(session.output)), /^ ✓ v2n456 · completed/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Runs opens on the first active row, paints it inverse, and clamps Up there', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30 });
    const runs = session.press('r');
    const activeRow = String(runs).split('\n').find((line) => plain(line).includes('● aaa111'));
    assert.ok(activeRow, 'the first active run is visible on Runs');
    assert.match(activeRow, /\x1b\[7m/, 'the initial cursor row is inverse');

    session.press('\x1b[A');
    const afterUp = lastFrame(session.output);
    const stillFirst = String(afterUp).split('\n').find((line) => plain(line).includes('● aaa111'));
    assert.ok(stillFirst, 'the first active run remains visible after Up');
    assert.match(stillFirst, /\x1b\[7m/, 'Up did not move the cursor off the first row');

    const opened = session.press('\r');
    assert.match(frameHeader(opened), /aaa111 · running/, 'Enter opens the highlighted active run');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('moving the mouse over a clickable row lights it in reverse video and leaving it clears the light', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30 });
    assert.ok(session.output.text.includes('\x1b[?1003h'), 'the TUI asks the terminal for mouse motion');
    session.press('r');
    const frame = lastFrame(session.output);
    const rows = frame.split('\n');
    const rowIndex = rows.findIndex((line) => plain(line).includes('v2n456'));
    assert.ok(rowIndex >= 0, 'the finished run has a row');
    const y = rowIndex + 1;
    // The frame is painted from the cursor-home; the row's y is its 1-based line.
    const moved = session.press(`\x1b[<35;6;${String(y)}M`);
    assert.ok(moved.length > 0, 'a hover repaints');
    const hovered = lastFrame(session.output).split('\n')[rowIndex];
    assert.match(hovered, /\x1b\[7m/, `the hovered row is painted in reverse: ${JSON.stringify(hovered.slice(0, 40))}`);
    assert.ok(plain(hovered).includes('v2n456'), 'the row keeps its text');
    // Only the words light: the reverse opens right before the first text
    // cell, and the row's own colours survive (the ✓ glyph keeps its green).
    assert.equal(plain(hovered), plain(rows[rowIndex]), 'the text is unchanged');
    // Move onto the header line, which has no clickable region: the light goes.
    session.press('\x1b[<35;6;2M');
    const cleared = lastFrame(session.output).split('\n')[rowIndex];
    assert.doesNotMatch(cleared, /\x1b\[7m/, 'leaving the row clears the highlight');
    // A chart column or a meter is clickable but is not a row: no light.
    session.press('h');
    const homeRows = lastFrame(session.output).split('\n');
    const chartRow = homeRows.findIndex((line) => plain(line).includes('┤') && /[▇█]/.test(plain(line)));
    if (chartRow >= 0) {
      const beforeChart = session.output.text.length;
      const barX = plain(homeRows[chartRow]).search(/[▇█]/) + 1;
      session.press(`\x1b[<35;${String(barX)};${String(chartRow + 1)}M`);
      assert.equal(session.output.text.length, beforeChart, 'hovering a chart column paints nothing');
    }
    // A running step's row on Home carries a bar: the words light, the bar does not.
    const homeAgain = lastFrame(session.output).split('\n');
    const stepRow = homeAgain.findIndex((line) => /[▇█░]/.test(plain(line)) && /@/.test(plain(line)));
    if (stepRow >= 0) {
      const textX = plain(homeAgain[stepRow]).search(/[A-Za-z]/) + 1;
      session.press(`\x1b[<35;${String(textX)};${String(stepRow + 1)}M`);
      const lit = lastFrame(session.output).split('\n')[stepRow];
      const reversed = [...lit.matchAll(/\x1b\[7m([^\x1b]*)/g)].map((m) => m[1]).join('');
      assert.doesNotMatch(reversed, /[▇█░]/, `bar glyphs are never reversed: ${JSON.stringify(reversed)}`);
      assert.match(reversed, /@/, 'the step text is reversed');
    }
    session.press('r');
    // Standing still sends nothing new.
    session.press('\x1b[<35;7;2M');
    const before = session.output.text.length;
    session.press('\x1b[<35;8;2M');
    assert.equal(session.output.text.length, before, 'a move that changes nothing does not repaint');
    const exit = await session.quit();
    assert.equal(exit, 0);
    assert.ok(session.output.text.includes('\x1b[?1003l'), 'motion tracking is released on the way out');
  } finally { cleanup(); }
});

test('Stats slice hover labels move, pin and clear without changing a 55-column frame', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-18T00:00:00.000Z') });
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-slices-'));
  try {
    mkdirSync(join(home, 'history'), { recursive: true });
    const rollup = (runId, model, minutes) => ({
      schemaVersion: 'bullswarm.workflow.rollup.v1', runId, shortId: runId, goal: runId,
      startedAt: '2026-09-17T01:00:00.000Z', finishedAt: '2026-09-17T02:00:00.000Z',
      status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
      minutes: { wall: minutes, agent: minutes },
      pools: { relay: { attempts: 1, minutes, costUsd: null, tokens: null } },
      models: { [model]: { attempts: 1, minutes } }, legacy: false,
    });
    writeFileSync(join(home, 'history', 'runs.jsonl'), [
      rollup('slice-luna', 'gpt-5.6-luna', 724),
      rollup('slice-sol', 'gpt-5.6-sol', 1760),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const session = shellSession(home, { columns: 55, rows: 30 });
    session.press('s'); // Home -> Stats Spending
    session.press('\t'); // Pool
    session.press('\t'); // Model, the stacked model-minutes chart
    const frame = lastFrame(session.output);
    const rows = paintedRows(frame).map(plain);
    const axisRow = rows.findIndex((line) => /[+┼].*Thu/.test(line));
    assert.ok(axisRow > 0, 'the 17 Sep chart column is painted');
    const barGlyph = /[█▇▆▅▄▃▂▁]/;
    const bar = rows.map((line, index) => ({ line, index }))
      .filter(({ line, index }) => index < axisRow && barGlyph.test(line)).at(-1);
    assert.ok(bar, 'the chart has a painted slice row');
    const x = bar.line.search(barGlyph) + 1;
    const y = bar.index + 1;
    const label = /Thu · gpt-5\.6-luna · 12h04m · 29\.1% of the day/;

    session.press(`\x1b[<35;${x};${y}M`);
    const hovered = lastFrame(session.output);
    assert.match(plain(hovered), label);

    session.press('\x1b[<35;1;2M');
    assert.doesNotMatch(plain(lastFrame(session.output)), label);
    session.press(`\x1b[<35;${x};${y}M`);
    session.press(`\x1b[<0;${x};${y}M`); // click pins the slice
    session.press('\x1b[<35;1;2M'); // motion does not clear a pin
    assert.match(plain(lastFrame(session.output)), label);
    session.press(ESC_KEY);
    assert.doesNotMatch(plain(lastFrame(session.output)), label);

    for (const line of paintedRows(lastFrame(session.output)).map(plain)) {
      assert.ok(line.length <= 55, `frame row exceeds 55 columns: ${line}`);
    }
    assert.equal(await session.quit(), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('every Stats bar and legend entry labels, pins and clears without changing the frame', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-18T00:00:00.000Z') });
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-stats-hover-'));
  try {
    mkdirSync(join(home, 'history'), { recursive: true });
    const rollup = (runId, project, pool, model, costUsd, minutes, day) => ({
      schemaVersion: 'bullswarm.workflow.rollup.v1', runId, shortId: runId, project, goal: runId,
      startedAt: `${day}T01:00:00.000Z`, finishedAt: `${day}T02:00:00.000Z`,
      status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
      minutes: { wall: minutes, agent: minutes },
      pools: { [pool]: { attempts: 1, minutes, costUsd, tokens: 1000, tokenSource: 'provider-reported' } },
      models: { [model]: { attempts: 1, minutes } }, legacy: false,
    });
    const records = [
      rollup('hover-a', 'project-a', 'relay', 'gpt-5.6-luna', 1, 60, '2026-09-17'),
      rollup('hover-b', 'project-b', 'codex', 'gpt-5.6-sol', 3, 30, '2026-09-17'),
    ];
    writeFileSync(join(home, 'history', 'runs.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const session = shellSession(home, { columns: 120, rows: 60 });
    session.press('s');
    session.press('v'); // use the measured worker-minute/model split for hover values
    const initial = lastFrame(session.output);
    const rows = paintedRows(initial).map(plain);
    const axisRow = rows.findIndex((line) => /┼.*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)/.test(line));
    assert.ok(axisRow > 0, 'the dated chart axis is visible');
    const chartGlyph = /[█▇▆▅▄▃▂▁]/;
    const chartRow = rows.map((line, index) => ({ line, index }))
      .filter(({ line, index }) => index < axisRow && chartGlyph.test(line)).at(-1);
    assert.ok(chartRow, 'the spend chart has a painted column');
    const chartX = chartRow.line.search(chartGlyph) + 1;
    const chartY = chartRow.index + 1;
    const chartBefore = rows[chartRow.index];

    session.press(`\x1b[<35;${chartX};${chartY}M`);
    const chartHover = lastFrame(session.output);
    assert.match(plain(chartHover), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*gpt-5\.6-(?:luna|sol).*\d+\.?\d*% of the day/);
    assert.equal(plain(chartHover).split('\n')[chartRow.index], chartBefore, 'hovering leaves the chart glyphs unchanged');
    const legendLine = chartHover.split('\n').find((line) => plain(line).startsWith('Legend') && /gpt-5\.6-luna/.test(plain(line)));
    assert.ok(legendLine, 'the legend is visible');
    assert.match(legendLine, /\x1b\[1mgpt-5\.6-(?:luna|sol)\x1b\[22m/, 'only the matching legend name is bold');

    session.press('\x1b[<35;1;2M');
    assert.doesNotMatch(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*gpt-5\.6-(?:luna|sol).*of the day/, 'moving outside clears an unpinned label');
    session.press(`\x1b[<35;${chartX};${chartY}M`);
    session.press(`\x1b[<0;${chartX};${chartY}M`);
    session.press('\x1b[<35;1;2M');
    assert.match(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*gpt-5\.6-(?:luna|sol).*of the day/, 'a column click pins the label');
    session.press(ESC_KEY);
    assert.doesNotMatch(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*gpt-5\.6-(?:luna|sol).*of the day/, 'Escape clears the pinned column label');

    const panelRow = paintedRows(chartHover).findIndex((line) => /gpt-5\.6-luna.*▓/.test(plain(line)));
    assert.ok(panelRow > 0, 'a breakdown share bar is visible');
    const panelX = plain(paintedRows(chartHover)[panelRow]).indexOf('▓') + 1;
    session.press(`\x1b[<35;${panelX};${panelRow + 1}M`);
    assert.match(plain(lastFrame(session.output)), /gpt-5\.6-luna.*of panel/);
    session.press(`\x1b[<0;${panelX};${panelRow + 1}M`);
    session.press('\x1b[<35;1;2M');
    assert.match(plain(lastFrame(session.output)), /gpt-5\.6-luna.*of panel/, 'a click pins the label');
    session.press(ESC_KEY);
    assert.doesNotMatch(plain(lastFrame(session.output)), /gpt-5\.6-luna.*of panel/, 'Escape clears a pinned label');

    const legendRow = paintedRows(lastFrame(session.output)).findIndex((line) => /^Legend/.test(plain(line)) && /gpt-5\.6-luna/.test(plain(line)));
    assert.ok(legendRow > 0, 'the legend entry is a hit target');
    const legendX = plain(paintedRows(lastFrame(session.output))[legendRow]).indexOf('gpt-5.6-luna') + 1;
    session.press(`\x1b[<35;${legendX};${legendRow + 1}M`);
    assert.match(plain(lastFrame(session.output)), /gpt-5\.6-luna.*of panel/, 'hovering the legend labels its series');
    session.press('\x1b[<35;1;2M');

    // The keyboard and click paths both use the same stack-by state.
    session.press('v');
    assert.match(plain(lastFrame(session.output)), /\[By Pool\] By Model/);
    const toggle = paintedRows(lastFrame(session.output)).findIndex((line) => /\[By Pool\] By Model/.test(plain(line)));
    const toggleX = plain(paintedRows(lastFrame(session.output))[toggle]).indexOf('By Model') + 1;
    session.press(`\x1b[<0;${toggleX};${toggle + 1}M`);
    assert.match(plain(lastFrame(session.output)), /\[By Model\] By Pool/);

    const model = dashboardModel(null, { rollups: records, nowMs: Date.parse('2026-09-18T00:00:00.000Z') });
    for (const [width, height] of [[55, 26], [120, 40]]) {
      const unhovered = renderDashboardPage(model, {
        page: 'stats', width, height, statsTab: 'spending', statsStackBy: 'pool', period: '7d',
      });
      const bar = unhovered.regions.find((region) => region.action.kind === 'slice' && region.action.payload?.kind === 'slice');
      assert.ok(bar, `a stacked slice region exists at ${width} columns`);
      const hovered = renderDashboardPage(model, {
        page: 'stats', width, height, statsTab: 'spending', statsStackBy: 'pool', period: '7d', slice: bar.action,
      });
      assert.equal(hovered.lines.length, unhovered.lines.length, `hovering preserves frame height at ${width} columns`);
    }
    assert.equal(await session.quit(), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('recent-list V2 selection opens that run on the Run page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    addV2HistoricalRun(home);
    const session = shellSession(home, { columns: 120, rows: 30 });
    session.press('r'); // Home -> Runs
    session.press('a'); // active -> all
    session.press('\u001b[B'); // active run -> newer V2 run
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · all/);
    assert.match(plain(lastFrame(session.output)), /v2n456.*Newer V2 dashboard run/);
    session.press('\r');
    assert.match(frameHeader(lastFrame(session.output)), /^ ✓ v2n456 · completed/);
    assert.match(plain(lastFrame(session.output)), /── plan · phase \d+ of \d+ ─/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('live dashboard navigation preserves V2 drilldowns, mobile panes, and empty active fallback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addV2HistoricalRun(home);

    // Desktop: the run page keeps its planner drilldown, Enter opens the Step,
    // and Escape walks the drilldown back out one page at a time.
    const desktop = shellSession(home, { columns: 120, rows: 30, token: 'abc234' });
    assert.match(plain(desktop.press('o')), /Workflow Planner · overview/);
    assert.match(plain(desktop.press('v')), /Workflow Planner · technical details/);
    desktop.press(ESC_KEY); // the planner pane closes, the Run page stays
    assert.match(frameHeader(desktop.press('\r')), /audit-files · abc234 · running/);
    desktop.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(desktop.output)), /abc234 · running/);
    assert.equal(await desktop.quit(), 0);

    // Mobile: Run v2 rule 2 folds the plan into one glyph strip and `p` opens
    // the boxes, which is the control the page's own footer names.
    const mobile = shellSession(home, { columns: 80, rows: 30, token: 'abc234' });
    assert.match(plain(lastFrame(mobile.output)), /^ plan  [✓▶○]+ /m);
    assert.match(plain(mobile.press('p')), /\[[✓▶○] 1 /);
    assert.doesNotMatch(plain(mobile.press('p')), /\[[✓▶○] 1 /);
    assert.match(plain(mobile.press('p')), /\[[✓▶○] 1 /);
    assert.equal(await mobile.quit(), 0);

    // Bare active view: the merged Runs page still shows the day table, and
    // `a` toggles to the all-runs filter.
    const emptyHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-empty-'));
    addV2HistoricalRun(emptyHome);
    const empty = shellSession(emptyHome, { columns: 120, rows: 30 });
    empty.press('r');
    assert.match(plain(lastFrame(empty.output)), /── active ─/);
    assert.match(plain(lastFrame(empty.output)), /nothing in flight/);
    empty.press('a');
    assert.match(plain(lastFrame(empty.output)), /v2n456.*Newer V2 dashboard run/);
    assert.equal(await empty.quit(), 0);
    rmSync(emptyHome, { recursive: true, force: true });
  } finally { cleanup(); }
});

test('the Runs active block uses the unified one-row columns', () => {
  // Runs uses the same columns for live workflows and live tasks.
  const { home, cleanup } = fixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const live = rows.filter((entry) => entry.ongoing);
    assert.equal(live.length, 1, 'the fixture must have one live run');
    const model = dashboardModel(live[0], { runs: live, rollups: readRollups(home) });
    const opts = { width: 120, height: 60, rows, allRows: rows, selectedRunId: live[0].runId };
    const runsFrame = renderDashboardPage(model, { ...opts, page: 'runs' }).lines.map(plain);

    const active = runsFrame.find((line) => line.includes('abc234'));
    assert.ok(active, runsFrame.join('\n'));
    assert.match(active, /^ ● abc234\s+/);
    assert.match(active, /Audit every file autonomously/);
    assert.match(active, /0\/2 steps/);
    assert.doesNotMatch(active, /phase|span|API|estimated|unmeasured/);
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
    assert.match(printed, /── timeline · \d+ phases? · \d+ attempts?/);
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

test('dashboard loads a legacy opencode2 attempt without rewriting its run history', () => {
  const { home, cleanup } = fixture();
  try {
    const statePath = join(home, 'workflows', 'wf-test', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.attempts.push({
      id: 'legacy-1', actionId: 'audit-files', ordinal: 1,
      pool: 'opencode2', model: 'kaihk/gpt-5.6-luna', status: 'succeeded',
    });
    writeFileSync(statePath, JSON.stringify(state));
    const before = readFileSync(statePath, 'utf8');
    const shown = dashboardJson(home, { token: 'abc234' });
    assert.equal(shown.state.attempts.at(-1).pool, 'opencode2');
    assert.ok(dashboardRows(home)[0], 'the dashboard still indexes the run');
    assert.equal(readFileSync(statePath, 'utf8'), before);
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
    // The live band names the running action, and the timeline row carries the
    // attempt's own pool · model · effort with its clock right-aligned.
    assert.match(plain(tui), /▶ audit-files · opencode2 · /);
    assert.match(plain(tui), /^ \d{2}:\d{2}  ▶ audit-files · opencode2 · relay\/gpt-5\.6-luna · — · running\s+\S+$/m);
    // Run v2 rule 3: the live block is the turn you would watch, read from the
    // attempt's own event stream. This attempt kept none, so the block says so
    // instead of replaying a single `lastAgentEvent` summary as if it were one.
    assert.match(plain(tui), /── live · audit-files · opencode2/);
    assert.match(plain(tui), /no event stream kept for this attempt/);
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

test('the interactive TUI takes the alternate screen with mouse reporting, and q only detaches', async () => {
  const { home, cleanup } = fixture();
  try {
    const session = shellSession(home, { columns: 110, rows: 26, token: 'abc234' });
    // SGR mouse reporting is asked for with the alternate screen.
    assert.equal(session.output.text.includes('\x1b[?1000h\x1b[?1003h\x1b[?1006h'), true);
    session.press('\r'); // run -> its agents
    session.press('\r'); // agents -> the selected step
    assert.match(frameHeader(lastFrame(session.output)), /audit-files · abc234/);
    session.press(ESC_KEY);
    assert.equal(await session.quit(), 0);
    assert.deepEqual(session.input.rawModes, [true, false]);
    assert.match(session.output.text, /\x1b\[\?1049h/);
    assert.match(session.output.text, /\x1b\[\?1049l/);
    // Leaving releases the mouse and shows the cursor again.
    assert.match(session.output.text, /\x1b\[\?1006l\x1b\[\?1003l\x1b\[\?1000l\x1b\[\?25h\x1b\[\?1049l/);
    // Detaching the viewer never asks the kernel to stop.
    assert.equal(existsSync(join(home, 'workflows', 'wf-test', 'cancellation.json')), false);
  } finally { cleanup(); }
});

test('bare workflow dashboard navigates active and recent runs on mobile', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-30T03:00:00.000Z') });
  const { home, cleanup } = fixture();
  try {
    addHistoricalRun(home);
    const session = shellSession(home, { columns: 60, rows: 26 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('r'); // Home -> Runs
    session.press('a'); // active -> all
    session.press('\u001b[B'); // select the historical run
    session.press('\r'); // open it on the Run page
    session.press(ESC_KEY); // back to Home
    session.press('r'); // and on to Runs, which owns the filter
    session.press('/');
    session.press('def');
    session.press('\r');
    assert.match(plain(lastFrame(session.output)), /Showing workflows matching “def”/);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · all/);
    // The project derives from the run's goal.json cwd (requirement 3), so the
    // temp fixture home names the row, not `unknown project`.
    // The record predates the active union, so the row keeps its recorded
    // span and says so; the elastic goal gives back the cells that label and
    // the duration take.
    assert.match(plain(lastFrame(session.output)), /✓ def345\s+bs-dashboard-.*Audit documentat.*5m\s+—/);
    assert.match(plain(session.output.text), /── timeline · \d+ phases? · \d+ attempts?/);
    assert.equal(await session.quit(), 0);
    assert.deepEqual(session.input.rawModes, [true, false]);
    assert.match(session.output.text, /\x1b\[\?1049l/);
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
      // No detached reprice/prune child against this temporary home.
      autoReprice: false, autoPrune: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    input.emit('data', Buffer.from('q'));
    assert.equal(await running, 0);
    assert.equal((output.text.match(/\x1b\[2J/g) ?? []).length, 1, 'alternate screen is cleared only once');
    // The first frame is written whole from cursor-home; every spinner tick
    // after it rewrites only the rows that changed, each addressed by row.
    // The alternate-screen clear and the first frame both start from cursor home; nothing after them does.
    assert.ok((output.text.match(/\x1b\[H/g) ?? []).length <= 2, 'only the opening writes start from cursor home');
    const rowWrites = output.text.match(/\x1b\[\d+;1H/g) ?? [];
    assert.ok(rowWrites.length >= 2, 'spinner ticks repaint by row');
    assert.ok(rowWrites.length < output.rows, 'a spinner tick does not rewrite the whole frame');
    assert.ok((output.text.match(/\x1b\[K/g) ?? []).length >= output.rows, 'each row is erased before it is painted');
    // Never an erase straight after a row's text: on a row that fills the
    // terminal the cursor sits on its last cell, and Ghostty's erase takes
    // that cell with it.
    const beforeErase = output.text.split('\x1b[K').slice(0, -1);
    assert.ok(beforeErase.every((chunk) => /(?:\x1b\[(?:\d+;1)?H|\n)$/.test(chunk)), 'an erase follows painted text');
  } finally { cleanup(); }
});

test('narrow interactive TUI opens on the timeline and p toggles the plan boxes', async () => {
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
    const session = shellSession(home, { columns: 80, rows: 26, token: 'abc234' });
    const timelineText = lastFrame(session.output);
    // The narrow run page opens on the timeline; ↓ selects its first segment.
    session.press('\u001b[B');
    const preflightText = lastFrame(session.output);
    session.press('\u001b[C'); // the selected Preflight opens the Workflow Planner
    const plannerText = lastFrame(session.output);
    session.press(ESC_KEY); // and back out to the timeline
    session.press('\u001b[B');
    session.press('\u001b[C'); // the selected phase opens its first step
    const agentsText = lastFrame(session.output);
    session.press(ESC_KEY);
    session.press('p');
    const planBoxesText = lastFrame(session.output);
    assert.equal(await session.quit(), 0);
    assert.match(plain(timelineText), /── timeline · \d+ phases? · \d+ attempts?/);
    // Run v2 rule 6: the phone timeline keeps its phase rules, each with the
    // span line under it; Preflight keeps the goal row only.
    assert.match(plain(preflightText), /── Preflight/);
    assert.match(plain(preflightText), /^ \d{2}:\d{2}  ● goal accepted · goal\.json$/m);
    assert.match(plain(preflightText), /^── ✓ Phase 1 · Implementation$/m);
    assert.match(plain(plannerText), /Workflow Planner · overview/);
    assert.match(plain(agentsText), /audit-files · abc234 · succeeded/);
    const visibleWidths = paintedRows(timelineText).map((line) => plain(line).length);
    assert.ok(visibleWidths.every((lineWidth) => lineWidth <= 80 - 1), 'mobile frames reserve the terminal wrap column');
    // Rule 2: the phone folds the plan to a glyph strip, and `p` opens the
    // boxes over it — `t`'s phase browser is gone with the old panes.
    assert.match(plain(timelineText), /^ plan  [✓▶○]+ /m);
    assert.match(plain(planBoxesText), /\[✓ 1 Implementation\]/);
    assert.doesNotMatch(plain(planBoxesText), /── phases · 2/);
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
  mkdirSync(join(home, 'history'), { recursive: true });
  writeFileSync(
    join(home, 'history', 'runs.jsonl'),
    `${rollupFixture().map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
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

// The painted rows of one frame: the clear/home escape a repaint opens with
// renders nothing, so the header is the first row and the nav the last.
function paintedRows(screen) {
  const rows = plain(screen).split('\n');
  if (rows[0] === '') rows.shift();
  return rows;
}

/** The page tab row: the first painted row of every frame. */
function tabRow(screen) {
  return plain(String(paintedRows(screen)[0] ?? '')).replace(/\s+$/, '');
}

/** The tabs the row actually painted, in order. */
function tabNames(screen) {
  return tabRow(screen).trim().split(/\s{2,}/).filter(Boolean);
}

/**
 * The sticky header: the row under the tab row, stripped of its colours. The
 * 0.35.1 colour pass paints the header's glyph, identity and clocks, so the
 * shell tests read the words and the colour rules are pinned in the Step and
 * Run view suites.
 */
function frameHeader(screen) {
  return plain(String(paintedRows(screen)[1] ?? '')).replace(/\s+$/, '');
}

/** The sticky bottom nav as its `[ label ]` buttons, marks included. */
function navButtons(screen) {
  const nav = plain(String(paintedRows(screen).at(-1) ?? ''));
  // A run button's digit (`[ 1.aaa111 ]`) is dropped: the tests name runs by id.
  return [...nav.matchAll(/\[ ([^\]]*?) \]/g)].map((match) => match[1].trim().replace(/^(● )?[1-9]\./, '$1'));
}

/** Every page the 0.33.0 shell has, in the order Help lists them. */
const DASHBOARD_PAGE_NAMES = ['home', 'runs', 'run', 'step', 'budget', 'stats', 'history', 'fleet', 'help'];

/** The tab the row painted inverted — the page the reader is on. */
function activeTab(screen) {
  const rows = String(screen).split('\n');
  const row = rows[0] === '' ? rows[1] : rows[0];
  const match = /\x1b\[7m(.*?)\x1b\[0m/.exec(String(row ?? ''));
  return match ? plain(match[1]) : '';
}

/**
 * Two rollup records, the shape `~/.bullswarm/history/runs.jsonl` holds: one
 * verified run with a recorded API-equivalent estimate, one that recorded
 * none. Nothing here declares a subscription price, which is the state every
 * pool on a real machine is in until an operator declares one.
 */
function rollupFixture(now = Date.now()) {
  const day = (back) => new Date(now - back * 86_400_000).toISOString();
  return [
    {
      schemaVersion: 'bullswarm.workflow.rollup.v1',
      runId: 'wf-zzz', shortId: 'zzz999', project: 'bullswarm', goal: 'Rebuild the dashboard shell',
      startedAt: day(0), finishedAt: day(0), status: 'completed', verified: true,
      requirements: { passed: 3, total: 3 }, minutes: { wall: 41, agent: 63 },
      pools: { relay: { attempts: 2, minutes: 40, costUsd: 0.42, tokens: 1200 } },
      models: { 'gpt-5.6-luna': { attempts: 2, minutes: 40 } }, legacy: false,
    },
    {
      schemaVersion: 'bullswarm.workflow.rollup.v1',
      runId: 'wf-yyy', shortId: 'yyy888', project: 'bulldemo', goal: 'Tidy the repo',
      startedAt: day(2), finishedAt: day(2), status: 'failed', verified: false,
      requirements: { passed: 1, total: 3 }, minutes: { wall: 12, agent: 15 },
      pools: { relay: { attempts: 1, minutes: 12, costUsd: null, tokens: null } },
      models: { 'gpt-5.6-mini': { attempts: 1, minutes: 12 } }, legacy: false,
    },
  ];
}

/**
 * The day rows `historyDays` returns for the same two runs. The keys are
 * local dates, because `dayKey` groups a run by the day it finished in the
 * reader's own zone, not in UTC.
 */
function dayFixture(now = Date.now()) {
  const key = (back) => {
    const at = new Date(now - back * 86_400_000);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  };
  // historyDays files each record under the day it belongs to and hands the
  // page that day's `rows`, so the fixture carries them the same way.
  const records = rollupFixture(now);
  const rowsOn = (back) => records.filter((record) => {
    const at = new Date(record.finishedAt);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` === key(back);
  });
  return [
    { date: key(0), runs: 1, finished: 1, verified: 1, verifiedShare: 1, spendUsd: 0.42, rows: rowsOn(0) },
    { date: key(1), runs: 0, finished: 0, verified: 0, verifiedShare: null, spendUsd: null, rows: [] },
    { date: key(2), runs: 1, finished: 1, verified: 0, verifiedShare: 0, spendUsd: null, rows: rowsOn(2) },
  ];
}

/** The last frame written to a fake output, with its leading paint escape. */
// The painter writes a full frame from cursor-home (`\x1b[H`) and then, for
// every later change, only the rows that differ (`\x1b[<row>;1H\x1b[K<line>`):
// each row is erased first, then painted. The screen a reader sees is the
// last full frame with those patches applied.
function lastFrame(output) {
  const frames = output.text.split('\x1b[H');
  const last = frames[frames.length - 1];
  const patchAt = last.search(/\x1b\[\d+;1H/);
  if (patchAt < 0) return last;
  const rows = last.slice(0, patchAt).split('\n').map((row) => row.replace(/^\x1b\[K/, ''));
  // `split` on the row address leaves [lead, row, content, row, content, …].
  const parts = last.slice(patchAt).split(/\x1b\[(\d+);1H/);
  for (let at = 1; at + 1 < parts.length; at += 2) {
    const row = Number(parts[at]) - 1;
    // A row is its SGR-painted text; the first other control sequence (the
    // exit escapes after the last patch) is not part of it.
    const content = parts[at + 1].replace(/^\x1b\[K/, '').replace(/\x1b\[(?![0-9;]*m)[\s\S]*$/, '');
    while (rows.length <= row) rows.push('');
    rows[row] = content;
  }
  return rows.map((row) => `\x1b[K${row}`).join('\n');
}

/** Clicks the first painted occurrence of `needle`, the way a mouse would. */
function clickOn(session, needle) {
  const rows = paintedRows(lastFrame(session.output)).map(plain);
  for (const [index, row] of rows.entries()) {
    const at = row.indexOf(needle);
    if (at < 0) continue;
    session.press(`\x1b[<0;${at + 1};${index + 1}M`);
    return { x: at + 1, y: index + 1 };
  }
  throw new Error(`"${needle}" is not painted in the frame:\n${rows.join('\n')}`);
}

/** The next macrotask, so an async usage read can land before an assertion. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('every page paints its tab row, its own sticky header, and a nav that marks the run', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    assert.ok(row, 'the fixture run is listed');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
      rollups: rollupFixture(),
      days: dayFixture(),
    });
    const page = (name, extra = {}) => renderDashboardPage(model, {
      page: name, width: 100, height: 30, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha', ...extra,
    }).lines.join('\n');

    // The tab row is the first row of every page, the active tab inverted;
    // the Step page's `overview · detail` toggle lives in its activity rule.
    for (const name of DASHBOARD_PAGE_NAMES) {
      assert.deepEqual(
        tabNames(page(name)),
        ['Home', 'Runs', 'Budget', 'Stats', 'Fleet'],
        `${name} painted the wrong tab row`,
      );
    }
    // Run and Step are read as Runs, so the tab row marks Runs on both.
    for (const [name, active] of [['home', 'Home'], ['runs', 'Runs'], ['run', 'Runs'], ['step', 'Runs'],
      ['budget', 'Budget'], ['stats', 'Stats'], ['history', 'Runs'], ['fleet', 'Fleet']]) {
      assert.ok(String(page(name)).includes(`\x1b[7m`), `${name} painted no active tab`);
      assert.ok(activeTab(page(name)).includes(active), `${name} marked ${activeTab(page(name))}, not ${active}`);
    }
    assert.equal(activeTab(page('help')), '', 'Help has no highlighted tab');

    // The header names the page: the product on Home, the run on Run, the step
    // on Step, the window on Budget, the tab on Stats.
    assert.match(frameHeader(page('home')), /^ bullswarm · home/);
    assert.match(frameHeader(page('runs')), /^ bullswarm · runs/);
    assert.match(frameHeader(page('run')), /^ ● aaa111 · running · 1 of 3 steps? done/);
    assert.match(frameHeader(page('step')), /^ .* build-alpha · aaa111/);
    assert.match(frameHeader(page('budget')), /^ Budget · /);
    assert.match(frameHeader(page('stats')), /^ Stats · spending/);
    assert.match(frameHeader(page('history')), /^ bullswarm · runs · \S+ · \d+ day/);
    assert.match(frameHeader(page('fleet')), /^ Fleet · by lane/);
    assert.match(frameHeader(page('help')), /^ bullswarm · help/);

    // One button per ongoing run, then help and quit, the current run marked.
    assert.deepEqual(navButtons(page('home')), ['● aaa111', 'bbb222', '?.help', 'quit']);
    // Run v2's footer is `[ back ] [ ● 1.<id> ]` plus the page's own hints, so
    // the sibling-run, help and quit buttons give their cells to the hint text.
    assert.deepEqual(navButtons(page('run')), ['back', '● aaa111']);
    assert.match(plain(page('run')).split('\n').at(-1), /Enter open step · p plan boxes · Space follow · \? help/);
    assert.deepEqual(navButtons(page('budget')), ['aaa111', 'bbb222', '?.help', 'quit']);
    assert.deepEqual(navButtons(page('help')), ['aaa111', 'bbb222', '● ?.help', 'quit']);
    // Step keeps only the way out and its selected-run context; its hints are
    // plain text in the sticky footer rather than extra shell buttons.
    assert.deepEqual(navButtons(page('step')), ['back', '● aaa111']);
    assert.match(plain(page('step')).split('\n').at(-1), /Enter expand turn · Esc close · v detail/);

    // A narrow footer keeps the selected run and accounts for every other
    // active run; desktop widths still paint every run in Runs-page order.
    const threeRows = [...rows, { ...rows[1], runId: 'wf-gamma', shortId: 'ccc333' }];
    const threeModel = dashboardModel(row, {
      runs: threeRows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
    });
    const narrowThree = renderDashboardPage(threeModel, {
      page: 'runs', width: 55, height: 30, rows: threeRows, allRows: threeRows,
      selectedRunId: 'wf-alpha',
    });
    assert.equal(
      plain(narrowThree.lines.at(-1)),
      ' [ ● 1.aaa111 ] [ +2 more ] [Top] [End] [?.Help] ',
    );
    const wideThree = renderDashboardPage(threeModel, {
      page: 'runs', width: 200, height: 30, rows: threeRows, allRows: threeRows,
      selectedRunId: 'wf-alpha',
    });
    assert.deepEqual(navButtons(wideThree.lines.join('\n')), ['● aaa111', 'bbb222', 'ccc333', '?.help', 'quit']);

    // One active run is the existing footer, byte-for-byte.
    const oneModel = dashboardModel(row, {
      runs: [row],
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
    });
    const one = renderDashboardPage(oneModel, {
      page: 'runs', width: 55, height: 30, rows: [row], allRows: [row],
      selectedRunId: 'wf-alpha',
    });
    assert.equal(plain(one.lines.at(-1)), ' [ ● 1.aaa111 ] [Top] [End] [?.Help] ');

    for (const name of DASHBOARD_PAGE_NAMES) {
      const frame = renderDashboardPage(model, {
        page: name, width: 100, height: 30, rows, allRows: rows, selectedRunId: 'wf-alpha',
      });
      assert.ok(frame.lines.length <= 30, `${name} painted ${frame.lines.length} rows`);
      // Run and Step end on their own footer (`[ back ] [ ● 1.<id> ]` plus the
      // page hints); a single task keeps only `[ back ]` plus its hints. Every
      // other page still ends on the shell's quit button.
      assert.match(
        plain(frame.lines.at(-1)),
        name === 'run' || name === 'step' ? /^ \[ back \] \[ [●\s]*1\.\w+ \]/
          : name === 'task' ? /^ \[ back \]/
            : /\[ quit \]/,
        `${name} lost its bottom nav`,
      );
    }
  } finally { cleanup(); }
});

test('every nav button is prefixed by its underlined key, and digits open runs in nav order', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
    });
    const frame = renderDashboardPage(model, {
      page: 'home', width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
    });
    const nav = String(frame.lines.at(-1));
    const key = (text) => `\x1b[4m${text}\x1b[24m`;
    assert.ok(nav.includes(`[ ● ${key('1')}.aaa111 ]`), 'the current run carries 1. inside its button');
    assert.ok(nav.includes(`[ ${key('2')}.bbb222 ]`), 'the second run carries 2. inside its button');
    assert.ok(nav.includes(`[ ${key('?')}.help ]`), 'help underlines its ?');
    assert.ok(nav.includes(`[ ${key('q')}uit ]`), 'quit underlines its q');
    // b is Budget now, so the way back out of a step carries no key letter.
    const step = renderDashboardPage(model, {
      page: 'step', width: 100, height: 26, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
    });
    assert.ok(String(step.lines.at(-1)).includes('[ back ]'), 'the step page keeps its way out');

    // The tab row underlines the key that opens each page.
    const tabs = String(frame.lines[0]);
    for (const [letter, label] of [['r', 'uns'], ['b', 'udget'], ['s', 'tats'], ['f', 'leet']]) {
      assert.ok(tabs.includes(`${key(letter.toUpperCase())}${label}`) || tabs.includes(`${key(letter)}${label}`),
        `the ${label} tab does not underline ${letter}`);
    }

    // The digit a button shows is the digit that opens that run.
    const session = shellSession(home, { columns: 100, rows: 24 });
    session.press('2');
    assert.match(frameHeader(lastFrame(session.output)), / ● bbb222 · running/);
    session.press('1');
    assert.match(frameHeader(lastFrame(session.output)), / ● aaa111 · running/);
    session.press('q');
  } finally { cleanup(); }
});

test('Budget, Fleet and Help open with no run selected: a fresh install, or only finished runs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-empty-'));
  try {
    mkdirSync(join(home, 'workflows'), { recursive: true });
    const session = shellSession(home, { columns: 100, rows: 24 });
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('b');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    session.press('f');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    session.press('?');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help/);
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, 'Budget');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no page paints past the terminal or comes up blank, at 120x40 and at 55x26', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows,
      usage: usageFixture(),
      integration: { ok: false, agents: [{ agent: 'codex', skill: { status: 'missing' }, awareness: false }] },
      rollups: rollupFixture(),
      days: dayFixture(),
    });

    // 55 columns is the phone layout; frameWidth() subtracts one below 100,
    // so the terminal paints 54 and every page must fit it.
    for (const [width, height] of [[120, 40], [54, 26], [32, 20], [60, 26], [80, 30], [99, 30], [200, 40]]) {
      for (const name of DASHBOARD_PAGE_NAMES) {
        for (const tab of ['spending', 'pool', 'model', 'project']) {
          const frame = renderDashboardPage(model, {
            page: name, width, height, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha',
            phaseIndex: 1, agentIndex: 0, statsTab: tab, metric: 'spend', period: '30d',
          });
          const screen = frame.lines.join('\n');
          const overflow = paintedRows(screen).filter((line) => [...line].length > width);
          assert.deepEqual(overflow, [], `width ${width} ${name}/${tab} overflowed`);
          // No page is blank: it paints a header, a body and the nav.
          assert.ok(frameHeader(screen).trim().length > 0, `width ${width} ${name} painted no header`);
          assert.ok(paintedRows(screen).filter((line) => line.trim()).length >= 3, `width ${width} ${name} came up blank`);
          assert.match(plain(paintedRows(screen).at(-1)), /\[/, `width ${width} ${name} lost its nav`);
          if (name !== 'stats') break;
        }
      }
    }
  } finally { cleanup(); }
});

test('at 55 columns Fleet leaves the tab row and the nav tail is [Top] [End] [Help]', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows[0], { runs: rows.filter((entry) => entry.ongoing), usage: usageFixture() });
    const narrow = renderDashboardPage(model, { page: 'home', width: 54, height: 26, rows, allRows: rows });
    // With History merged into Runs there is room for the whole tab row again;
    // Fleet only leaves below 38 columns.
    assert.deepEqual(tabNames(narrow.lines.join('\n')), ['Home', 'Runs', 'Budget', 'Stats', 'Fleet']);
    const nav = plain(narrow.lines.at(-1));
    assert.match(nav, /\[Top\] \[End\] \[\?\.Help\]\s*$/);
    assert.doesNotMatch(nav, /\[ quit \]/);
    // Fleet comes back the moment it is the page being read.
    const fleet = renderDashboardPage(model, { page: 'fleet', width: 54, height: 26, rows, allRows: rows });
    assert.ok(tabNames(fleet.lines.join('\n')).includes('Fleet'), 'the active page never leaves the tab row');
    // Every one of the three tail buttons is clickable.
    const tail = narrow.regions.filter((region) => region.y === narrow.lines.length);
    assert.deepEqual(tail.map((region) => region.action.kind).slice(-3), ['top', 'end', 'page']);
    // And the Help page says which layout the reader is looking at.
    const help = plain(renderDashboardPage(model, { page: 'help', width: 54, height: 60 }).lines.join('\n'));
    assert.match(help, /\[Top\] \[End\] \[\?\.Help\]/);
    assert.match(help, /Fleet leaves the tab row/);
  } finally { cleanup(); }
});

test('the nav records a hit region for every button, today row, chart bar and step row', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows, usage: usageFixture(), rollups: rollupFixture(), days: dayFixture(),
    });

    const runFrame = renderDashboardPage(model, {
      page: 'run', width: 100, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const nav = runFrame.regions.filter((region) => region.y === runFrame.lines.length);
    // Run v2's footer is `[ back ] [ ● 1.<id> ]` and then plain hint text, so
    // the only clickable buttons are the way out and the run itself.
    assert.deepEqual(nav.map((region) => region.action.kind), ['back', 'run']);
    assert.deepEqual(nav.map((region) => region.action.page).filter(Boolean), []);
    for (const region of nav) {
      const painted = plain(runFrame.lines[region.y - 1]).slice(region.x1 - 1, region.x2);
      assert.match(painted, /^\[ .+ \]$/, `${painted} is not a whole button`);
    }
    // Every phase box in the plan is one clickable unit pointing at that
    // phase's first step, and the box is numbered. The timeline below carries
    // its own step regions — an attempt row opens the step it ran — so a plan
    // box is identified by the bracket it is painted in, not by kind alone.
    const stepSlice = (region) => plain(runFrame.lines[region.y - 1]).slice(region.x1 - 1, region.x2);
    const steps = runFrame.regions.filter((region) => region.action.kind === 'step');
    const planBoxes = steps.filter((region) => stepSlice(region).startsWith('['));
    assert.ok(planBoxes.length >= 2, `expected a clickable box per phase: ${planBoxes.length}`);
    for (const region of planBoxes) {
      assert.match(stepSlice(region), /^\[[✓▶○×·] \d+ .+\]$/);
    }
    assert.deepEqual(
      [...new Set(planBoxes.map((region) => region.action.actionId))].sort(),
      ['build-alpha-evidence', 'scan'],
    );
    // A timeline attempt row is clickable too, and opens its own step.
    const timelineSteps = steps.filter((region) => !stepSlice(region).startsWith('['));
    for (const region of timelineSteps) {
      // Rule 6: an attempt row is `HH:MM  <glyph> <step> · <pool> · …`. A
      // phase rule that names its own steps (`── ▶ Phase 1 · scan · build-alpha ──`)
      // is clickable too and opens one of them.
      assert.match(
        stepSlice(region),
        /^(?: \d{2}:\d{2}  \S+ \S+ · |── [✓✗▶○⊘] Phase \d+ · )/,
        'a timeline step region covers its attempt row',
      );
    }
    assert.ok(
      timelineSteps.some((region) => /^ \d{2}:\d{2}  /.test(stepSlice(region))),
      'no attempt row recorded a step region',
    );

    // Home: the today band owns workflow/task rows, and the running section's
    // plan strip and live step bars keep their own hit regions. The owner's
    // second review round brought the period band back, so its spent-per-day
    // trend chart, Stats tiles and period buttons are on the page again.
    const homeFrame = renderDashboardPage(model, {
      page: 'home', width: 100, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    });
    const kinds = (frame, kind) => frame.regions.filter((region) => region.action.kind === kind);
    assert.ok(kinds(homeFrame, 'trend').some((region) => region.action.metric === 'spend'), 'Home lost the spend trend band');
    assert.deepEqual(
      [...new Set(kinds(homeFrame, 'period').map((region) => region.action.period))].sort(),
      ['30d', '7d', 'all'],
      'Home lost the period choices',
    );
    assert.ok(kinds(homeFrame, 'page').some((region) => region.action.page === 'budget' && region.action.pool === 'relay'),
      'the budget row opens Budget for its pool');
    const runRows = kinds(homeFrame, 'run').filter((region) => region.y !== homeFrame.lines.length);
    assert.ok(runRows.some((region) => region.action.runId === 'wf-alpha'));
    assert.ok(kinds(homeFrame, 'step').length >= 2, 'the per-run glyph strip is clickable');
    // Every region sits inside the line it was painted on.
    for (const frame of [homeFrame, runFrame]) {
      for (const region of frame.regions) {
        const line = plain(frame.lines[region.y - 1] ?? '');
        assert.ok(region.x1 >= 1 && region.x2 <= Math.max(1, line.length),
          `region ${JSON.stringify(region.action)} at ${region.x1}–${region.x2} is outside "${line}"`);
      }
    }

    // The page tab row opens its page from every page.
    const tabs = homeFrame.regions.filter((region) => region.action.kind === 'page' && region.y === 1);
    assert.deepEqual(tabs.map((region) => region.action.page), ['home', 'runs', 'budget', 'stats', 'fleet']);

    // Fleet's own tabs switch the grouping, and `[edit]` is the e key.
    const fleetFrame = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30 });
    const fleetTabs = fleetFrame.regions.filter((region) => region.action.kind === 'tab');
    assert.deepEqual(fleetTabs.map((region) => region.action.tab), ['lane', 'provider']);
    // fleet-view paints the row and records the regions; the shell only moves
    // them onto the frame, so each one still covers the words it was drawn on.
    const tabsRowText = plain(fleetFrame.lines[fleetTabs[0].y - 1]);
    assert.match(tabsRowText.slice(fleetTabs[0].x1 - 1, fleetTabs[0].x2), /by lane/);
    assert.match(tabsRowText.slice(fleetTabs[1].x1 - 1, fleetTabs[1].x2), /by provider/);
    const edit = fleetFrame.regions.find((region) => region.action.kind === 'edit');
    assert.match(plain(fleetFrame.lines[edit.y - 1]).slice(edit.x1 - 1, edit.x2), /edit/);

    // Stats' four sub-tabs are the same four Tab walks.
    const statsFrame = renderDashboardPage(model, { page: 'stats', width: 100, height: 30 });
    assert.deepEqual(
      statsFrame.regions.filter((region) => region.action.kind === 'tab').map((region) => region.action.tab),
      ['spending', 'pool', 'model', 'project'],
    );
    // Each new Stats surface retains its titled panels and share hit regions
    // at desktop and phone widths; row clicks are now hover/pin affordances,
    // not the old Budget/History fallbacks.
    for (const width of [120, 54]) {
      const statsPage = (tab) => renderDashboardPage(model, {
        page: 'stats', width, height: 80, rows, allRows: rows, selectedRunId: 'wf-alpha',
        statsTab: tab, period: '7d', statsStackBy: 'pool',
      });
      for (const [tab, title] of [['spending', 'Pool spend'], ['pool', 'Pool spend'], ['model', 'Model worker-minutes'], ['project', 'Project runs']]) {
        const frame = statsPage(tab);
        assert.ok(plain(frame.lines.join('\n')).includes(title), `${tab} surface missing at ${width}`);
        for (const region of frame.regions) {
          const line = plain(frame.lines[region.y - 1] ?? '');
          assert.ok(region.x1 >= 1 && region.x2 <= Math.max(1, line.length), `stats region overrun at ${width}`);
        }
      }
    }
    // History's run rows open that run.
    const historyFrame = renderDashboardPage(model, { page: 'history', width: 100, height: 30 });
    // The bottom nav's run buttons are the same { kind: 'run' } action, so a
    // body row is one that is not on the nav's own line.
    const historyRuns = historyFrame.regions.filter((region) => region.action.kind === 'run'
      && region.y !== historyFrame.lines.length);
    assert.ok(historyRuns.length >= 1, 'a History row opens its run');
    // The merged page opens with the active runs (aaa111), so pick the
    // finished run's region explicitly.
    const zzzRun = historyRuns.find((region) => region.action.runId === 'wf-zzz');
    assert.ok(zzzRun, 'a finished run row opens its run');
    assert.match(
      plain(historyFrame.lines[zzzRun.y - 1]).slice(zzzRun.x1 - 1, zzzRun.x2),
      /zzz999/,
    );
  } finally { cleanup(); }
});

// The two navigation moves that only exist in the input loop. Each keypress is
// delivered synchronously, so the returned repaint frame is exactly the screen
// that key produced — nothing else can have painted in between.
const ESC_KEY = String.fromCharCode(27);

/** Two pools and their rungs: the shape `loadUsage` hands the pages. */
function usageFixture(nowMs = Date.now()) {
  const at = (ms) => new Date(nowMs + ms).toISOString();
  return {
    pools: [
      {
        name: 'relay', enabled: true, usedPct: 32, elapsedPct: 27, pace: 5.4, pacingWindow: 'weekly',
        incumbentLane: ['build'], quarantine: null,
        meterSnapshot: {
          captured_at: at(-3 * 60_000), plan_type: 'max',
          five_hour: { utilization: 32, resets_at: at(3_600_000) },
          seven_day: { utilization: 55, resets_at: at(2 * 86_400_000) },
          monthly_quota: { used: 63.5, limit: 70, unit: 'credits' },
        },
      },
      {
        name: 'codex', enabled: false, usedPct: 81, elapsedPct: 60, pace: -21, pacingWindow: 'monthly',
        incumbentLane: [], quarantine: null, meterSnapshot: null, free: true, meterSource: 'none',
        connector: { meter: { type: 'none' }, modelProfiles: [{ match: '.*', free: true }] },
      },
    ],
    assignments: [{ pool: 'relay', actionId: 'build-alpha', lane: 'build' }],
    rungs: [
      { pool: 'relay', tier: 'high', model: 'vendor/gpt-5.6-luna', reasoning: 'high', dispatches: 3, okShare: 0.67, medianMinutes: 12 },
      { pool: 'relay', tier: 'medium', model: 'vendor/gpt-5.6-mini', reasoning: 'medium', dispatches: 0, okShare: null, medianMinutes: null },
    ],
    capturedAt: at(-3 * 60_000),
  };
}

function shellSession(home, {
  columns = 120, rows = 30, token = null, homeDir = home, openSetupTui = null, refreshMs = 60_000,
} = {}) {
  class FakeInput extends EventEmitter {
    isTTY = true;
    rawModes = [];
    setRawMode(value) { this.rawModes.push(value); }
    resume() {}
    pause() {}
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    text = '';
    constructor(width, height) { super(); this.columns = width; this.rows = height; }
    write(chunk) { this.text += chunk; }
  }
  const input = new FakeInput();
  const output = new FakeOutput(columns, rows);
  const running = runDashboard(home, {
    input, output, refreshMs, token, homeDir, openSetupTui,
    // No detached reprice/prune child against this temporary home.
    autoReprice: false, autoPrune: false,
  });
  // A key press answers with the screen the reader now sees. The painter
  // writes only the rows that changed, so the raw slice after a press is a
  // patch, not a screen; a press that painted nothing answers ''.
  const press = (key) => {
    const before = output.text.length;
    input.emit('data', Buffer.from(key));
    const written = output.text.slice(before);
    if (!/\x1b\[H|\x1b\[\d+;1H/.test(written)) return written;
    return lastFrame(output);
  };
  return { input, output, running, press, quit: () => { press('q'); return running; } };
}

test('Shift+Tab re-enters the sibling run at the page it was left on', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    session.press('\r'); // run -> its selected step
    const atStep = lastFrame(session.output);
    assert.match(frameHeader(atStep), /scan · aaa111 · succeeded/);

    // Shift+Tab is the key that cycles workflows, and it cycles, so two
    // presses come back here.
    const sibling = session.press(`${ESC_KEY}[Z`);
    assert.ok(sibling.length, 'Shift+Tab repainted the screen');
    // same page, the sibling workflow's own step, marked current in the nav
    assert.match(frameHeader(sibling), /scan · bbb222 · succeeded/);
    const buttons = navButtons(sibling);
    assert.equal(buttons[0], 'back', 'the sibling is entered at the same depth');
    assert.ok(buttons.includes('● bbb222'), `the sibling is the current run: ${buttons.join(' ')}`);
    assert.ok(!buttons.includes('● aaa111'));

    // and cycling on comes back the same way, still on the step page
    const back = session.press(`${ESC_KEY}[Z`);
    assert.match(frameHeader(back), /scan · aaa111 · succeeded/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Enter walks in and Esc walks out one page at a time', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    assert.match(frameHeader(lastFrame(session.output)), / ● aaa111 · running/);

    session.press('\r'); // run -> its selected step
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);
    assert.equal(navButtons(lastFrame(session.output))[0], 'back');

    const run = session.press(ESC_KEY); // step -> the run
    assert.match(frameHeader(run), / ● aaa111 · running/);
    // Run v2 keeps its own `[ back ]` out to Runs, so the page it landed on is
    // identified by its footer hints, not by the absence of that button.
    assert.match(plain(run).split('\n').at(-1), /Enter open step · p plan boxes/);
    assert.doesNotMatch(plain(run), /Enter expand turn/, 'the step page was left behind');
    assert.doesNotMatch(run, /bullswarm · home/);

    const list = session.press(ESC_KEY); // run -> home
    assert.match(frameHeader(list), /^ bullswarm · home/);
    assert.doesNotMatch(list, /Workflow timeline/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Step keyboard controls select, filter, follow, open detail, and jump sections', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    // The run page opens its phase's first step, so the stream belongs to the
    // scan attempt.
    writeFileSync(join(dir, 'stream-scan-attempt-1.jsonl'), [
      { seq: 1, at: '2026-08-29T00:02:01.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'started work' },
      { seq: 2, at: '2026-08-29T00:02:02.000Z', source: 'codex', providerType: 'item.started', kind: 'command_execution', status: 'running', summary: 'run tests', eventId: 'evt-2', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'npm test' } },
      { seq: 3, at: '2026-08-29T00:02:03.000Z', source: 'codex', providerType: 'item.completed', kind: 'command_execution', status: 'failed', summary: 'test failed', eventId: 'evt-3', toolCallId: 'call-1', toolName: 'shell', result: 'exit 1', durationMs: 1000 },
    ].map((event) => JSON.stringify(event)).join('\n'));
    // 200 columns: the toggle, the counts and the filter control all fit the
    // activity rule (in a narrower column the control gives way first).
    const session = shellSession(home, { token: 'wf-alpha', columns: 200, rows: 26 });
    session.press('\r'); // the run page opens the phase's first step
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);

    // Rule 9: one filter control. `t` cycles turns → tools → errors → all, and
    // the activity rule ends with the lens it is showing.
    assert.match(plain(lastFrame(session.output)), /── activity · overview · detail · .* showing turns · t to change ─/);
    assert.match(plain(session.press('t')), /showing tools/);
    assert.match(plain(session.press('t')), /showing errors/);
    assert.match(plain(session.press('t')), /showing turns/);
    // `e` keeps its own errors toggle, and comes back to the default lens.
    assert.match(plain(session.press('e')), /showing errors/);
    session.press('e'); // and back to all, so the turn is listed again
    // Rule 3: only the non-zero classes print, in singular or plural.
    assert.match(plain(lastFrame(session.output)), /1 command · 1 error/);
    assert.doesNotMatch(plain(lastFrame(session.output)), /0 files read/);
    // Overview is the default; Enter expands the selected turn in place and
    // Esc collapses it without leaving the page.
    const expanded = plain(session.press('\r'));
    assert.match(expanded, /^▶ 1  08:02 /m);
    assert.match(expanded, /08:02:02  \$ run tests\s+1s/);
    const collapsed = plain(session.press(ESC_KEY));
    assert.match(collapsed, /── activity · /);
    assert.doesNotMatch(collapsed, /^▶ 1 /m);
    // v switches the activity block to the transcript and back (step-v2 rule
    // 12); the footer names what each view holds, and the top bar marks it.
    const transcript = plain(session.press('v'));
    assert.match(transcript, /── transcript · overview · detail · 1 turn · /);
    assert.match(transcript, /08:02:02  \$ run tests\s+1s/);
    assert.match(plain(lastFrame(session.output)), /v overview \(latest turns\)/);
    // Enter on the tool row opens every field its two captures carried.
    session.press('\x1b[B'); // the cursor lands on the turn head
    session.press('\x1b[B'); // then on the `run tests` row
    const opened = plain(session.press('\r'));
    assert.match(opened, /kind command_execution · status running · eventId evt-2/);
    assert.match(opened, /toolCallId call-1 · tool shell/);
    assert.match(opened, /^ +"command": "npm test" +│/m);
    assert.match(opened, /status failed · eventId evt-3/);
    assert.match(opened, /duration 1000/);
    assert.match(opened, /^ +result +│.*\n +exit 1 +│/m);
    assert.doesNotMatch(plain(session.press(ESC_KEY)), /"command": "npm test"/, 'Esc closes the open row');
    assert.match(plain(session.press('v')), /v detail \(every turn in full\)/);

    // The section jumps land in the merged blocks of the five-block order.
    session.press('o');
    assert.match(plain(lastFrame(session.output)), /── result · /);
    session.press('p');
    assert.match(plain(lastFrame(session.output)), /── task · /);
    session.press('\t');
    assert.match(plain(lastFrame(session.output)), /── activity · /);
    // Rule 9: following is a single ● on the header, and `f` is the key that
    // turns it off on this page (Fleet keeps `f` everywhere else).
    assert.match(plain(lastFrame(session.output)), /── activity · /);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Up and Down on the Step page move one inverse cursor row through the turns', async () => {
  // Colour rules: the cursor row is inverse. The shell tracked the selected
  // turn on Up/Down but never drew it, so moving through turns showed nothing.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    writeFileSync(join(dir, 'stream-scan-attempt-1.jsonl'), [
      { seq: 1, at: '2026-08-29T00:02:01.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'first answer' },
      { seq: 2, at: '2026-08-29T00:02:05.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'second answer' },
      { seq: 3, at: '2026-08-29T00:02:09.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'third answer' },
    ].map((event) => JSON.stringify(event)).join('\n'));
    const session = shellSession(home, { token: 'wf-alpha', columns: 120, rows: 30 });
    // The body rows only: the tab row's current tab, the nav and the activity
    // rule's current view (`overview · detail`) are not cursors.
    const cursorRows = (screen) => {
      const rows = String(screen).split('\n');
      if (plain(rows[0]) === '') rows.shift();
      return rows.slice(1, -1).map((row, index) => [index, row])
        .filter(([, row]) => row.includes('\x1b[7m') && !/── \S+ · overview · detail/.test(plain(row)));
    };
    const run = lastFrame(session.output);
    assert.equal(cursorRows(run).length, 1, 'the Run page draws its selected phase box as the cursor');
    // The selected phase is the first, whose first step Enter opens next.
    assert.match(plain(/\x1b\[7m(.*?)\x1b\[27m/.exec(cursorRows(run)[0][1])[1]), /^\[\S 1 two writers 1\/2\]$/);

    session.press('\r'); // the run page opens the phase's first step
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);
    // Step-v2 rule 13: the overview opens with the cursor on the newest turn.
    const opening = cursorRows(lastFrame(session.output));
    assert.equal(opening.length, 1, 'one cursor when the page opens');
    assert.match(plain(opening[0][1]), /^ +3  \d{2}:\d{2}  third answer/);

    const seen = [opening[0][0]];
    for (const [number, text] of [[2, 'second answer'], [1, 'first answer']]) {
      const rows = cursorRows(session.press('\x1b[A'));
      assert.equal(rows.length, 1, `Up to turn ${number}: ${rows.map(([, row]) => plain(row)).join(' | ')}`);
      assert.match(plain(rows[0][1]), new RegExp(`^ +${number}  \\d{2}:\\d{2}  ${text}`));
      seen.push(rows[0][0]);
    }
    assert.ok(seen[0] > seen[1] && seen[1] > seen[2], `the cursor moved up the page: ${seen}`);
    const down = cursorRows(session.press('\x1b[B'));
    assert.equal(down.length, 1);
    assert.equal(down[0][0], seen[1], 'Down moves the cursor back one turn');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Step overview · detail: the latest-turns window, the fold line, the activity-rule toggle, turn-head clicks and tool rows', async () => {
  // Step-v2 rules 12–14 driven through the real shell with keys and SGR mouse
  // presses on a twelve-turn step: the overview shows the newest ten turns, the
  // fold line and the activity-rule toggle open the transcript, a click on a turn
  // head is Enter on it, and Enter on a transcript row opens its fields.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const events = [];
    for (let turn = 1; turn <= 12; turn += 1) {
      const at = (offset) => new Date(Date.parse('2026-08-29T00:02:00.000Z') + (turn * 10 + offset) * 1000).toISOString();
      events.push({ at: at(0), source: 'codex', providerType: 'item.completed', kind: 'response', status: 'completed', summary: `answer ${turn}` });
      events.push({ at: at(1), source: 'codex', providerType: 'item.started', kind: 'command_execution', status: 'running', summary: `run check ${turn}`, toolCallId: `call-${turn}`, arguments: { command: `check ${turn}` } });
      events.push({ at: at(3), source: 'codex', providerType: 'item.completed', kind: 'command_execution', status: 'completed', summary: `run check ${turn}`, toolCallId: `call-${turn}`, result: `exit 0 (check ${turn})`, durationMs: 2000 });
    }
    writeFileSync(join(dir, 'stream-scan-attempt-1.jsonl'), events.map((event, index) => JSON.stringify({ seq: index + 1, ...event })).join('\n'));
    const session = shellSession(home, { token: 'wf-alpha', columns: 120, rows: 40 });
    session.press('\r'); // the run page opens the phase's first step
    const rows = () => paintedRows(lastFrame(session.output)).map(plain);
    const raw = () => lastFrame(session.output).split('\n');
    const left = (line) => line.split(' │ ')[0].trimEnd();
    const heads = () => rows().map((line) => left(line).match(/^[ ▶]{0,2}(\d+) {2}\d\d:\d\d {2}answer/)?.[1]).filter(Boolean).map(Number);
    const cursorText = () => raw().slice(1, -1)
      .filter((line) => line.includes('\x1b[7m') && !/── \S+ · overview · detail/.test(plain(line)))
      .map((line) => left(plain(line)));

    // Rule 13: the newest ten turns under one fold line; the cursor on the newest.
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);
    assert.deepEqual(heads(), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.ok(rows().some((line) => left(line) === ' turns 1–2 · 2 commands · click for detail'), rows().join('\n'));
    assert.deepEqual(cursorText(), [' 12  08:04  answer 12 · 1 command']);
    // Rule 14: the toggle sits in the activity rule, straight after its heading
    // word, the current view marked; the top bar carries none of it.
    assert.match(rows()[0], /^ Home  Runs  Budget  Stats  Fleet\s*$/);
    const ruleAt = rows().findIndex((line) => /^── activity · overview · detail · /.test(line));
    assert.ok(ruleAt > 0, rows().join('\n'));
    assert.match(raw()[ruleAt], /activity · \x1b\[7moverview\x1b\[0m · detail · /);

    // Hovering a turn head lights its own words only: not the padding, not the
    // right column across the divider.
    const fiveAt = rows().findIndex((line) => left(line).startsWith('  5  '));
    session.press(`\x1b[<35;4;${fiveAt + 1}M`);
    const lit = raw()[fiveAt];
    assert.match(lit, /\x1b\[7m/);
    assert.equal(plain(lit), rows()[fiveAt], 'the hover keeps the text');
    assert.doesNotMatch(lit.split('│').slice(1).join('│'), /\x1b\[7m/, 'the right column is not lit');
    const leftRaw = lit.split('│')[0];
    const lastOff = leftRaw.lastIndexOf('\x1b[27m');
    assert.ok(lastOff > 0, 'the light closes inside the activity column');
    assert.equal(plain(leftRaw.slice(lastOff)).trim(), '', 'the light ends with the words, not the padding');
    assert.ok(plain(leftRaw.slice(0, lastOff)).trimEnd().endsWith('answer 5 · 1 command'), JSON.stringify(leftRaw));
    session.press('\x1b[<35;1;3M'); // off the row

    // Rule 14: a click on a turn head toggles it like Enter.
    clickOn(session, 'answer 5');
    assert.ok(rows().some((line) => /^▶ 5  08:02  answer 5/.test(line)), rows().join('\n'));
    assert.ok(rows().some((line) => /08:02:51  \$ run check 5\s+2s/.test(left(line))), rows().join('\n'));
    clickOn(session, 'answer 5');
    assert.equal(rows().some((line) => /^▶ 5 /.test(line)), false, 'a second click collapses it');

    // Rule 14: a click on `detail` in the activity rule opens the transcript
    // and marks it.
    clickOn(session, 'detail');
    const transcriptAt = rows().findIndex((line) => /^── transcript · overview · detail · 12 turns/.test(line));
    assert.ok(transcriptAt > 0, rows().join('\n'));
    assert.match(raw()[transcriptAt], /overview · \x1b\[7mdetail\x1b\[0m/);
    assert.match(rows().at(-1), /v overview \(latest turns\)/);
    // Rule 12: every turn, each expanded — the response, its counts, its rows.
    assert.deepEqual(heads().slice(0, 3), [1, 2, 3]);
    assert.ok(rows().some((line) => /^ {12}08:02:11  \$ run check 1\s+2s$/.test(left(line))), rows().join('\n'));
    clickOn(session, 'overview');
    assert.deepEqual(heads(), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.match(rows().at(-1), /v detail \(every turn in full\)/);

    // Rule 13: Up walks the window's turns, then lands on the fold line; Enter
    // there opens the transcript at its top. The cursor is still on turn 5,
    // where the click left it.
    assert.deepEqual(cursorText(), ['  5  08:02  answer 5 · 1 command']);
    for (let press = 0; press < 2; press += 1) session.press('\x1b[A');
    assert.deepEqual(cursorText(), ['  3  08:02  answer 3 · 1 command']);
    session.press('\x1b[A');
    assert.deepEqual(cursorText(), [' turns 1–2 · 2 commands · click for detail']);
    session.press('\r');
    assert.ok(rows().some((line) => /^── transcript · overview · detail · 12 turns/.test(line)), 'Enter on the fold line opens detail');
    assert.equal(heads()[0], 1, 'the transcript opens at its top');

    // Rule 12: the cursor walks the rows; Enter on a tool row opens every field
    // its two captures carried — arguments and the result in full.
    session.press('\x1b[B');
    assert.deepEqual(cursorText(), ['  1  08:02  answer 1']);
    session.press('\x1b[B');
    assert.match(cursorText()[0], /^ {12}08:02:11  \$ run check 1/);
    session.press('\r');
    const opened = rows().map(left).join('\n');
    assert.match(opened, /seq 2 · 2026-08-29T00:02:11\.000Z · codex · item\.started/);
    assert.match(opened, /"command": "check 1"/);
    assert.match(opened, /seq 3 · .* item\.completed/);
    assert.match(opened, /^ +exit 0 \(check 1\)$/m);
    session.press('\r');
    assert.doesNotMatch(rows().map(left).join('\n'), /"command": "check 1"/, 'Enter again closes the row');
    // A click on another tool row selects it and opens its fields.
    clickOn(session, 'run check 2');
    assert.match(rows().map(left).join('\n'), /"command": "check 2"/);
    assert.match(cursorText()[0], /\$ run check 2/);

    // The fold line is a click target too.
    session.press('v');
    assert.deepEqual(heads(), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    clickOn(session, 'click for detail');
    assert.ok(rows().some((line) => /^── transcript · overview · detail · 12 turns/.test(line)), 'a click on the fold line opens detail');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('the Step top bar carries only the page tabs; the toggle is not on it', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      integration: { ok: true, agents: [] },
      rollups: rollupFixture(),
      days: dayFixture(),
    });
    for (const width of [55, 100, 200]) for (const stepView of ['overview', 'detail']) {
      const result = renderDashboardPage(model, {
        page: 'step', width, height: 30, rows, allRows: rows, selected: 0, selectedRunId: 'wf-alpha', stepView,
      });
      const top = plain(result.lines[0]);
      assert.doesNotMatch(top, /overview|detail/, `${width}/${stepView}: ${top}`);
      assert.ok(result.regions.filter((region) => region.y === 1).every((region) => region.action.kind === 'page'),
        `${width}/${stepView}: every top-bar click opens a page`);
      // The toggle is on the activity rule instead, two click regions.
      const screen = result.lines.map(plain);
      const ruleAt = screen.findIndex((line) => /^── (activity|transcript) · overview · detail/.test(line));
      assert.ok(ruleAt > 0, `${width}/${stepView}: the toggle is on the activity rule\n${screen.join('\n')}`);
      const onRule = result.regions.filter((region) => region.y === ruleAt + 1 && region.action.kind === 'stepView');
      assert.deepEqual(onRule.map((region) => region.action.view), ['overview', 'detail']);
      assert.deepEqual(onRule.map((region) => screen[ruleAt].slice(region.x1 - 1, region.x2)), ['overview', 'detail']);
    }
  } finally { cleanup(); }
});

test('a click on either word of the activity rule switches the Step view, and a hover lights the word only', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    writeFileSync(join(dir, 'stream-scan-attempt-1.jsonl'), [
      { seq: 1, at: '2026-08-29T00:02:01.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'first answer' },
      { seq: 2, at: '2026-08-29T00:02:05.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'second answer' },
    ].map((event) => JSON.stringify(event)).join('\n'));
    for (const columns of [55, 200]) {
      const session = shellSession(home, { token: 'wf-alpha', columns, rows: 40 });
      session.press('\r'); // the run page opens the phase's first step
      const rows = () => paintedRows(lastFrame(session.output)).map(plain);
      const raw = () => lastFrame(session.output).split('\n');
      const ruleRow = (heading) => rows().findIndex((line) => line.startsWith(`── ${heading} · overview · detail`));
      const clickWord = (heading, word) => {
        const at = ruleRow(heading);
        assert.ok(at >= 0, `${columns}: the ${heading} rule is painted\n${rows().join('\n')}`);
        const x = rows()[at].indexOf(word, `── ${heading} · `.length) + 1;
        session.press(`\x1b[<0;${x};${at + 1}M`);
      };
      assert.ok(ruleRow('activity') > 0, `${columns}: opens in the overview`);
      assert.match(raw()[ruleRow('activity')], /activity · \x1b\[7moverview\x1b\[0m · detail/);

      // A hover on the plain word lights that word's text and nothing else.
      const at = ruleRow('activity');
      const x = rows()[at].indexOf('detail', '── activity · '.length) + 1;
      session.press(`\x1b[<35;${x + 1};${at + 1}M`);
      const lit = raw()[at];
      assert.match(lit, /· \x1b\[7mdetail\x1b\[27m/, `${columns}: ${JSON.stringify(lit)}`);
      assert.equal(plain(lit), rows()[at], `${columns}: the hover keeps the text`);
      session.press('\x1b[<35;1;3M'); // off the rule

      clickWord('activity', 'detail');
      assert.ok(ruleRow('transcript') > 0, `${columns}: a click on detail opens the transcript\n${rows().join('\n')}`);
      assert.match(raw()[ruleRow('transcript')], /transcript · overview · \x1b\[7mdetail\x1b\[0m/);
      assert.match(rows().at(-1), /v overview/);

      clickWord('transcript', 'overview');
      assert.ok(ruleRow('activity') > 0, `${columns}: a click on overview returns to the overview`);
      assert.match(raw()[ruleRow('activity')], /activity · \x1b\[7moverview\x1b\[0m · detail/);
      assert.match(rows().at(-1), /v detail/);
      assert.equal(await session.quit(), 0);
    }
  } finally { cleanup(); }
});

test('while following a running step the latest-turns window slides; once the reader stops it stays put', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    // The first step is still running, so its stream grows under the page.
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    Object.assign(state.actions[0], { status: 'running', finishedAt: null });
    Object.assign(state.attempts[0], { status: 'running', finishedAt: null });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const stream = join(dir, 'stream-scan-attempt-1.jsonl');
    const turnEvents = (turn) => {
      const at = (offset) => new Date(Date.parse('2026-08-29T00:02:00.000Z') + (turn * 10 + offset) * 1000).toISOString();
      return [
        { seq: turn * 3, at: at(0), source: 'codex', providerType: 'item.completed', kind: 'response', status: 'completed', summary: `answer ${turn}` },
        { seq: turn * 3 + 1, at: at(1), source: 'codex', providerType: 'item.started', kind: 'command_execution', status: 'running', summary: `run check ${turn}`, toolCallId: `call-${turn}` },
        { seq: turn * 3 + 2, at: at(3), source: 'codex', providerType: 'item.completed', kind: 'command_execution', status: 'completed', summary: `run check ${turn}`, toolCallId: `call-${turn}`, durationMs: 2000 },
      ].map((event) => JSON.stringify(event)).join('\n');
    };
    const write = (count) => writeFileSync(stream, `${Array.from({ length: count }, (_, index) => turnEvents(index + 1)).join('\n')}\n`);
    write(12);
    const session = shellSession(home, { token: 'wf-alpha', columns: 120, rows: 40 });
    session.press('\r');
    const rows = () => paintedRows(lastFrame(session.output)).map(plain).map((line) => line.split(' │ ')[0].trimEnd());
    const heads = () => rows().map((line) => line.match(/^[ ▶]{0,2}(\d+) {2}\d\d:\d\d {2}answer/)?.[1]).filter(Boolean).map(Number);
    const repaint = () => { session.press('e'); session.press('e'); }; // errors, then back to all
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · running/);
    assert.deepEqual(heads(), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Following: two new turns slide the window.
    write(14);
    repaint();
    assert.deepEqual(heads(), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.ok(rows().includes(' turns 1–4 · 4 commands · click for detail'), rows().join('\n'));

    // Up stops following: the window stays where the reader left it, and the
    // turns that arrive are named below it.
    session.press('\x1b[A');
    write(16);
    repaint();
    assert.deepEqual(heads(), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.ok(rows().includes(' turns 15–16 · f to follow'), rows().join('\n'));
    // Down past the newest shown turn slides the window onto them, one turn.
    session.press('\x1b[B');
    session.press('\x1b[B');
    assert.deepEqual(heads(), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.ok(rows().includes(' turn 16 · f to follow'), rows().join('\n'));
    // `f` follows again: the window is the newest ten.
    session.press('f');
    assert.deepEqual(heads(), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.equal(rows().some((line) => / · f to follow$/.test(line)), false);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('an expanded turn pages its newest tool rows, and f follows the tail', async () => {
  // The Step page shows the newest three tool rows of an expanded turn; Space,
  // PageUp and PageDown walk that window back through the older ones, and `f`
  // is the follow toggle on this page (Fleet keeps the key elsewhere).
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const events = [
      { seq: 1, at: '2026-08-29T00:02:01.000Z', source: 'codex', providerType: 'response', kind: 'response', status: 'completed', summary: 'started work' },
    ];
    for (let index = 0; index < 8; index += 1) {
      const at = new Date(Date.parse('2026-08-29T00:02:02.000Z') + index * 2000).toISOString();
      events.push({
        seq: 2 + index * 2, at, source: 'codex', providerType: 'item.started', kind: 'command_execution',
        status: 'running', summary: `step ${index}`, eventId: `evt-${index}-a`, toolCallId: `call-${index}`,
        toolName: 'shell', arguments: { command: `run step ${index}` },
      });
      events.push({
        seq: 3 + index * 2, at: new Date(Date.parse(at) + 1000).toISOString(), source: 'codex',
        providerType: 'item.completed', kind: 'command_execution', status: 'completed', summary: `step ${index}`,
        eventId: `evt-${index}-b`, toolCallId: `call-${index}`, toolName: 'shell', result: 'ok', durationMs: 1000,
      });
    }
    writeFileSync(join(dir, 'stream-scan-attempt-1.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
    const session = shellSession(home, { token: 'wf-alpha', columns: 120, rows: 30 });
    session.press('\r'); // the run page opens the phase's first step
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);
    // Rule 3: only the non-zero classes, in plural.
    assert.match(plain(lastFrame(session.output)), /8 commands/);

    // Enter expands the turn on its newest three tool rows, with the older
    // ones folded into one line above them.
    const expanded = plain(session.press('\r'));
    assert.match(expanded, /\u2191 5 earlier commands · Space page up/);
    assert.match(expanded, /\$ step 7/);
    assert.doesNotMatch(expanded, /\$ step 0/);

    // Space pages that window back; PageDown brings it forward again.
    const older = plain(session.press(' '));
    assert.match(older, /\$ step 4/);
    assert.doesNotMatch(older, /\$ step 7/);
    const newer = plain(session.press('\u001b[6~'));
    assert.match(newer, /\$ step 7/);

    // `f` toggles the follow on the Step page instead of opening Fleet.
    session.press('f');
    assert.match(frameHeader(lastFrame(session.output)), /scan · aaa111 · succeeded/);
    assert.doesNotMatch(plain(lastFrame(session.output)), /^ Fleet · /m);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('the Help page names every key, and the keys the nav buttons carry open them', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { token: 'wf-alpha' });
    session.press('?');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · help/);
    // The whole page, not just the window it opens on: every key the table
    // binds is named, and every click the pages record.
    const whole = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 100, height: 80 });
    const help = plain(whole.lines.join('\n'));
    for (const name of Object.keys(DASHBOARD_KEYS)) {
      assert.ok(help.includes(DASHBOARD_KEYS[name].keys), `the help page lost ${name} (${DASHBOARD_KEYS[name].keys})`);
    }
    for (const text of ['tile', 'bar', 'wheel', 'y confirms it', 'r was refresh', 'OSC 52']) {
      assert.ok(help.includes(text), `the help page lost ${text}`);
    }
    // And at 55 columns every row of it fits the 54 the frame paints.
    const narrowHelp = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 54, height: 80 });
    for (const line of narrowHelp.lines) assert.ok(plain(line).length <= 54, `help clipped at 55 columns: ${plain(line)}`);
    assert.ok(plain(narrowHelp.lines.join('\n')).includes('ctrl+s'), 'the narrow help page lost ctrl+s');
    // ? -> help -> Esc -> home -> b -> budget -> Esc -> home
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    session.press('b');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    // the digit a nav button carries opens that run
    session.press('2');
    assert.match(frameHeader(lastFrame(session.output)), / ● bbb222 · running/);
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
    // Run v2 replaced the phase pane with the plan boxes and the timeline, so
    // the page names every planned step there — and still never `undefined`.
    const runV2 = plain(renderWorkflowTui(row, { width: 120, height: 30, focus: 1 }));
    assert.doesNotMatch(runV2, /undefined/);
    assert.match(runV2, /\[▶ 1 two writers 0\/2\]/);
    assert.match(runV2, /── ▶ Phase 1 · shell-and-visual-system · space-and-spaces ─/);
    assert.match(runV2, /── ○ Phase 2 · Evidence ─/);

    // The role each step carries is what the agent detail pane prints, and it
    // is derived (never read off `action.kind`, which only drafts carry).
    const panel = workflowPanelModel(row);
    const planned = agentDetailLines(panel, 100, 0).join('\n');
    assert.doesNotMatch(planned, /undefined/);
    assert.match(planned, /shell-and-visual-system · work · running/);
    assert.match(planned, /space-and-spaces · work · pending/);
    const evidence = agentDetailLines(workflowPanelModel(row, { phaseIndex: 1 }), 100, 0).join('\n');
    assert.doesNotMatch(evidence, /undefined/);
    assert.match(evidence, /verify-surfaces · evidence · pending/);
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
    const screen = plain(renderWorkflowTui(row, { width, height: 40 }));
    // The phases are the program's dependency groups, never keyword-inferred
    // and never the saved stage label. Run v2 rule 2 names a level phase by
    // the writer group it is, so `Parallel work` is gone with the label it
    // replaced while the timeline rules still read out the steps themselves.
    assert.match(screen, /fast · slow/);
    assert.match(screen, /next/);
    assert.doesNotMatch(screen, /Parallel work/);
    assert.doesNotMatch(screen, /Documentation/);
    // Rule 2: the phone folds the plan to a glyph strip that names the running
    // phase and the next one; the desktop keeps the boxes.
    assert.match(screen, width < 120 ? /^ plan  [✓▶○]+  1 two writers running · then next$/m
      : /\[▶ 1 two writers 1\/2\] → \[▶ 2 next 0\/1\]/);
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
    // Rule 6: the rule counts phases and attempts, and the `started` filler
    // row is gone — an open phase with no attempt yet simply has no rows.
    const attemptCount = /── timeline · \d+ phases? · (\d+) attempts?/.exec(plain(before))[1];
    assert.deepEqual(segmentRows(before, 'Evidence'), []);

    // the worker starts 65 seconds ago and is still running
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    Object.assign(state.actions[1], { status: 'running', startedAt, attempts: 1 });
    state.attempts.push({ id: 'check-result-1', actionId: 'check-result', ordinal: 1, status: 'running', pool: 'relay:b', model: 'gpt-5.6-luna', startedAt, finishedAt: null, lastActivityAt: startedAt, outputBytesObserved: 42 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const running = renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 0 });
    const evidence = segmentRows(running, 'Evidence').map(normalizeRow);
    // Rule 6: the live attempt is one row — clock, glyph, the action, its own
    // pool · model · effort, the word `running`, and its clock at the end.
    assert.match(
      evidence[0],
      /^HH:MM ▶ check-result · relay:b · gpt-5\.6-luna · — · running 1m0[5-9]s$/,
      evidence.join('\n'),
    );
    // The row is the same at every spinner frame: `running` is a word on the
    // row now, not an animated glyph in a tree gutter.
    assert.deepEqual(
      segmentRows(renderWorkflowTui(row, { width: 120, height: 30, spinnerFrame: 3 }), 'Evidence').map(normalizeRow),
      evidence,
    );
    // The running attempt is a durable attempt row, so the rule counts it.
    assert.equal(
      Number(/── timeline · \d+ phases? · (\d+) attempts?/.exec(plain(running))[1]),
      Number(attemptCount) + 1,
    );
    // the level header counts the phase's active minutes, not a wall span,
    // in the same clock form v0.35.0 drew
    assert.match(timelineSegments(running).find((segment) => segment.label === 'Evidence').elapsed, /^1m0[5-9]s$/);

    // Rule 3: the live block leads with the running step, its route and its
    // elapsed time. Token usage only exists once the attempt finishes, so a
    // running worker's block carries no token count at all.
    const agents = plain(renderWorkflowTui(row, { width: 130, height: 22, focus: 1, spinnerFrame: 0 }));
    assert.match(agents, /── live · check-result · relay:b · gpt-5\.6-luna/);
    assert.match(segmentRows(agents, 'Evidence').map(normalizeRow).join('\n'), /▶ check-result · relay:b · gpt-5\.6-luna · — · running 1m0[5-9]s/);
    assert.doesNotMatch(agents, /check-result[^\n]*tok/);

    // once the worker finishes, its durable row replaces the live one
    const finishedAt = new Date().toISOString();
    Object.assign(state.actions[1], { status: 'succeeded', finishedAt });
    state.attempts[1] = { ...state.attempts[1], status: 'succeeded', finishedAt, usage: { tokens: { totalKnown: 1200 } } };
    emit('evidence.recorded', finishedAt, { actionId: 'check-result', requirements: ['result-correct'], statuses: { 'result-correct': 'passed' } });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const done = renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 120, height: 30 });
    const doneRows = segmentRows(done, 'Evidence').map(normalizeRow);
    assert.equal(doneRows.filter((line) => /^HH:MM ✓ check-result/.test(line)).length, 1, doneRows.join('\n'));
    assert.match(doneRows.join('\n'), /relay:b · gpt-5\.6-luna · — 1m0[5-9]s/);
    // A finished attempt keeps its route and its measured clock, and the live
    // block becomes `last finished`.
    assert.match(
      plain(renderWorkflowTui(dashboardRows(home, { all: true })[0], { width: 130, height: 22, focus: 1, phaseIndex: 1 })),
      /── last finished · check-result · relay:b · gpt/,
    );
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
      pool: 'relay:b', model: 'gpt-5.6-luna', startedAt: iso(6), finishedAt: null,
      reasoning: { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const live = renderWorkflowTui(row, { width: 120, height: 30 });
    // The live band names the running worker and its own clock; the timeline
    // row under it carries the attempt's pool · model · effort, clock last.
    assert.match(plain(live), /▶ check-result · relay:b · /);
    assert.match(plain(live), /^ \d{2}:\d{2}  ▶ check-result · relay:b · gpt-5\.6-luna · — · running\s+\S+$/m);
    // Phase 1 holds the finished attempt; its applied reasoning level reads
    // next to the model on the attempt row.
    // Rule 6: the finished attempt's row carries pool · model · effort with
    // its clock at the end.
    const phaseOne = renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 });
    assert.match(plain(phaseOne), /^ \d{2}:\d{2}  ✓ implement-result · relay · gpt-5\.6-luna · low\s+\S+$/m);
    // Step v2 rule 1: the header's third line is pool · model · effort ·
    // reasoning, so the applied level reads there, next to the model.
    const agentPane = plain(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(agentPane, /^ relay · gpt-5\.6-luna · low effort · reasoning max\b/m);
    // The durable record is what observation reads, so JSON carries it too.
    assert.deepEqual(
      dashboardJson(home, { token: 'v2r234' }).state.attempts.map((attempt) => attempt.reasoning.applied),
      ['max', 'high'],
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('attempts without a reasoning record mark the Step field unavailable', () => {
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
    assert.match(plain(live), /▶ implement-result · /);
    // The attempt row keeps the pool · model · effort with its clock at the
    // end; with no reasoning record there is no level to print beside the model.
    assert.match(plain(live), /^ \d{2}:\d{2}  ▶ implement-result · relay · gpt-5\.6-luna · — · running\s+\S+$/m);
    assert.doesNotMatch(plain(live), /gpt-5\.6-luna · (?:minimal|low|medium|high|xhigh|max)\b/);
    const pane = plain(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 1 }));
    assert.match(pane, /^ \d{2}:\d{2}  ▶ implement-result · relay · gpt-5\.6-luna · — · running/m);
    const agentPane = plain(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    // An attempt with no applied effort and no reasoning record keeps dashes
    // where the level would be, and never the word `reasoning`.
    assert.match(agentPane, /relay · gpt-5\.6-luna · —/);
    assert.doesNotMatch(agentPane, /reasoning (?:minimal|low|medium|high|xhigh|max)/);
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
    assert.equal(blockedLevel.label, 'Phase 3 · harden-core');
    assert.deepEqual(blockedLevel.blockedActions, [
      { id: 'harden-core', kind: 'action', blockedBy: ['verify-core'] },
    ]);
    // Never dispatched means no attempt, so the agent list is empty and the
    // pane must explain the absence rather than claim nothing started yet.
    assert.deepEqual(model.agents, []);
    assert.deepEqual(model.phases[0].blockedActions, []);
    assert.deepEqual(model.phases[1].blockedActions, []);

    // The Run v2 page folded the phase pane into the plan and the timeline;
    // the "never dispatched" sentence is what the agent detail pane prints.
    const agents = agentDetailLines(model, 100, 0).join('\n');
    assert.match(agents, /⊘ harden-core · work · never dispatched/);
    assert.match(agents, /blocked by verify-core/);
    assert.doesNotMatch(agents, /Not started yet/);

    // Drilling into the blocked action opens its Step page, which reports the
    // execution it recorded; the phase pane above names the dependency.
    // Step v2 rule 1: one header line — step, run, verdict.
    const detail = plain(renderWorkflowTui(row, { width: 120, height: 30, phaseIndex: 2, focus: 2 }));
    assert.match(detail, /harden-core · blk234 · blocked/i);
    assert.match(detail, /── result · blocked/);

    // The timeline names the blocked phase; a phase that never dispatched has
    // no attempt row to draw, so the phase rule carries its 0/1 instead.
    const timeline = timelinePaneRows(renderWorkflowTui(row, { width: 120, height: 40, phaseIndex: 2 }));
    assert.match(timeline.join('\n'), /── [✗⊘] Phase 3 · harden-core ─/);
    assert.match(timeline.join('\n'), /✗ verify-core/);
  } finally { run.cleanup(); }
});

test('the timeline opens one segment header per phase change instead of prefixing every event line', () => {
  const run = segmentedV2Run();
  try {
    const screen = renderWorkflowTui(run.row(), { width: 120, height: 44 });
    const pane = timelinePaneRows(screen);
    // One header per phase, in declared order, none repeated between two rows
    // of the same phase. Run v2 rule 2 names a level phase by its own steps.
    assert.deepEqual(segmentLabels(screen), [
      'Preflight', 'discover-a · discover-b', 'implement-a · implement-b', 'Evidence',
    ]);
    assert.equal(pane.filter((line) => /^─{2,} ✓ Phase 1 · discover-a · discover-b /.test(line)).length, 1);

    // The rows themselves never name their phase as a prefix.
    assert.deepEqual(pane.filter((line) => line.includes('[Phase:')), []);
    assert.deepEqual(pane.filter((line) => /\[(Discovery|Implementation|Preflight):? ?[^\]]*\]/.test(line)), []);

    // Rule 6: one row per attempt naming its action and its pool · model ·
    // effort with its own clock; the `started` and `completed` filler rows are
    // gone because the phase rule already carries start → end and done/total.
    // (timestamps render in the local zone, so only their shape is asserted)
    assert.deepEqual(segmentRows(screen, 'discover-a · discover-b').map(normalizeRow), [
      'HH:MM ✓ discover-a · relay · gpt-5.6-luna · — 1m00s',
      'HH:MM ✓ discover-b · relay · gpt-5.6-luna · — 1m10s',
    ]);

    // The running phase shows its live worker and reports no completion.
    const implementation = segmentRows(screen, 'implement-a · implement-b').join('\n');
    assert.match(implementation, /✓ implement-a · relay · gpt-5\.6-luna · —/);
    assert.match(implementation, /▶ implement-b · relay · gpt-5\.6-luna · — · running/);
    assert.deepEqual(segmentRows(screen, 'implement-a · implement-b').filter((line) => line.includes('completed')), []);
    // A live phase reports its active minutes, not the word `running`.
    assert.match(
      timelineSegments(screen).find((segment) => segment.label === 'implement-a · implement-b').elapsed,
      /^(?:\d+h\d+m|\d+m\d+s|\d+s)$/,
    );
    assert.equal(timelineSegments(screen).find((segment) => segment.label === 'discover-a · discover-b').elapsed, '1m10s');

    // Every blank separator inside the timeline introduces a segment header.
    pane.forEach((line, index) => {
      if (line.trim() || index === pane.length - 1) return;
      const next = pane[index + 1];
      assert.ok(!next.trim() || /^─{2,}/.test(next), `blank row ${index} is not a segment separator: ${next}`);
    });

    // A planned phase that never started keeps its rule but draws no rows.
    assert.equal(workflowPanelModel(run.row()).phases[2].label, 'Evidence');
    assert.deepEqual(segmentRows(screen, 'Evidence'), []);
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
    // Rule 2: a level phase is named by its own steps, never `Parallel work`.
    assert.deepEqual(segmentLabels(screen), [
      'Preflight', 'implement-a · implement-b', 'verify-a · verify-b',
    ]);
    assert.deepEqual(segmentRows(screen, 'implement-a · implement-b').map(normalizeRow), [
      'HH:MM ✓ implement-a · relay · gpt-5.6-luna · — 1m00s',
      'HH:MM ✓ implement-b · relay · gpt-5.6-luna · — 30s',
    ]);
    assert.deepEqual(segmentRows(screen, 'verify-a · verify-b').map(normalizeRow), [
      'HH:MM ✓ verify-a · relay · gpt-5.6-luna · — 30s',
      'HH:MM ✓ verify-b · relay · gpt-5.6-luna · — 30s',
    ]);
    // Phase 2 opened while phase 1 was still running: the clock column proves
    // the rows were grouped by declared phase, not by time.
    const clock = (label, index) => segmentRows(screen, label)[index].trim().slice(0, 5);
    assert.ok(
      clock('implement-a · implement-b', 1) > clock('verify-a · verify-b', 0),
      `level 1's second worker should postdate level 2's start:\n${timelinePaneRows(screen).join('\n')}`,
    );
    // A program's phases are its dependency groups: no keyword phase prefix.
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
  } finally { run.cleanup(); }
});

test('a long phase keeps one rule and one row per attempt, and the page carries the rest', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    // Run v2's timeline is a flat list the shell windows, so a phase is
    // introduced exactly once however tall the terminal is — the boxed panel's
    // `continued` header and its own scroll went with the panel.
    const tall = renderWorkflowTui(row, { width: 100, height: 60 });
    // Rule 6: a phase rule names the steps the phase holds, and a name longer
    // than the rule allows gives way to `…` before the phase's own facts do.
    const labels = segmentLabels(tall);
    assert.deepEqual([labels[0], labels.at(-1)], ['Preflight', 'Evidence']);
    assert.match(labels[1], /^work-0 · work-1 .*…$/);
    const rows = segmentRows(tall, labels[1]).map(normalizeRow);
    assert.equal(rows.length, 13, rows.join('\n'));
    assert.match(rows.at(-1), /^HH:MM ▶ work-tail · relay · gpt-5\.6-luna · — · running \S+$/);
    assert.deepEqual(timelinePaneRows(tall).filter((line) => line.includes('continued')), []);
    assert.deepEqual(timelinePaneRows(tall).filter((line) => line.includes('[Phase:')), []);

    // Rule 3: a short terminal still shows the running step, because the live
    // block sits above the timeline rather than at the end of it.
    const short = plain(renderWorkflowTui(row, { width: 100, height: 28 }));
    assert.match(short, /── live · work-tail · relay · gpt-5\.6-luna/);
  } finally { run.cleanup(); }
});

test('the live block follows the newest work, and the page body is what scrolls', () => {
  const run = longPhaseV2Run();
  try {
    const row = run.row();
    const following = renderWorkflowTui(row, { width: 100, height: 40 });
    const pane = timelinePaneRows(following);
    // Rule 3: following the newest work is the live block's job now. It names
    // the running step, its route, its clock and says it is following.
    assert.match(plain(following), /── live · work-tail · relay · gpt-5\.6-luna · — · \S+ · \d+ turns · \d+ events/);
    assert.match(plain(following), /Enter → the step page · following ●/);
    assert.match(frameHeader(following), /^ ● lng234 · running/);
    // The timeline keeps every attempt as its own row, in phase order, and
    // never claims there is a viewport marker to chase.
    assert.match(pane.filter((line) => line.trim()).at(-1), /── [✓✗▶○] Phase \d+ · Evidence ─/);
    assert.deepEqual(pane.filter((line) => /(?:newer|earlier) timeline rows/.test(line)), []);

    // The whole page is one body the shell windows, so a short terminal shows
    // its first rows and the reader pages down through the rest.
    const shortFrame = renderDashboardPage(
      dashboardModel(row, { runs: [row] }),
      { page: 'run', width: 100, height: 28, rows: [row], allRows: [row], selectedRunId: row.runId },
    );
    const scrolled = renderDashboardPage(
      dashboardModel(row, { runs: [row] }),
      { page: 'run', width: 100, height: 28, rows: [row], allRows: [row], selectedRunId: row.runId, bodyScroll: 8 },
    );
    assert.notEqual(plain(scrolled.lines.join('\n')), plain(shortFrame.lines.join('\n')),
      'the Run page body did not move when the shell scrolled it');
    assert.match(plain(scrolled.lines.join('\n')), /work-tail/);
  } finally { run.cleanup(); }
});

test('narrow timeline rendering keeps the segment headers and never overflows the pane', () => {
  const run = segmentedV2Run();
  const long = longPhaseV2Run();
  try {
    const row = run.row();
    // Tall enough that the whole timeline fits: nothing here is a scroll artifact.
    const screen = renderWorkflowTui(row, { width: 60, height: 60 });
    assert.deepEqual(segmentLabels(screen), [
      'Preflight', 'discover-a · discover-b', 'implement-a · implement-b', 'Evidence',
    ]);
    assert.deepEqual(timelinePaneRows(screen).filter((line) => line.includes('[Phase:')), []);
    // Even at 60 columns an attempt row keeps its action, its pool and its own
    // clock (rule 6 drops the model and the effort on the phone); a live phase
    // reports its active minutes rather than the word `running`.
    assert.match(segmentRows(screen, 'discover-a · discover-b').join('\n'), /✓ discover-a · relay/);
    assert.match(segmentRows(screen, 'discover-a · discover-b').join('\n'), /✓ discover-a · relay\s+1m00s/);
    assert.match(
      timelineSegments(screen).find((segment) => segment.label === 'implement-a · implement-b').elapsed,
      /^(?:\d+h\d+m|\d+m\d+s|\d+s)$/,
    );

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

    // A long phase stays inside the narrow width too: one rule, one row per
    // attempt, and the phone's second line carrying the phase span.
    const scrolled = renderWorkflowTui(long.row(), { width: 60, height: 28 });
    const narrowPane = timelinePaneRows(scrolled);
    assert.ok(narrowPane.some((line) => /^── [✓✗▶○] Phase 1 · work-0 · work-1 /.test(line)), narrowPane.join('\n'));
    assert.ok(narrowPane.some((line) => /^\d{2}:\d{2} → now · \S+ · 12\/13$/.test(line)), narrowPane.join('\n'));
    assert.deepEqual(overflow(scrolled, 60), []);
  } finally { run.cleanup(); long.cleanup(); }
});

test('a narrow terminal wraps the agent detail pane to its full width, not the sidebar remainder', () => {
  const { home, cleanup } = fixture();
  try {
    const row = dashboardRows(home)[0];
    const contentWidths = (screen) => plain(screen).split('\n').map((line) => line.trimEnd().length);
    const narrow = renderWorkflowTui(row, { width: 60, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 });
    // The step and the pool it ran on are both named: the identity in the Step
    // header, the route on the line under it.
    assert.match(plain(narrow), /audit-files · abc234 · running/);
    assert.match(plain(narrow), /planner-agent · planner-v1/);
    const widest = Math.max(...contentWidths(narrow));
    // 60 columns minus the 34-column sidebar minus padding is 22: the width the
    // detail used to wrap at even though the narrow pane spans the whole screen.
    assert.ok(widest > 22, `narrow detail still wraps at ${widest} columns`);
    assert.ok(widest <= 60, `narrow detail overflows the frame: ${widest} columns`);
    const wide = plain(renderWorkflowTui(row, { width: 120, height: 26, phaseIndex: 0, focus: 2, agentIndex: 0 }));
    assert.match(wide, /audit-files · abc234 · running/);
    assert.match(wide, /planner-agent · planner-v1/);
    // And no panel border survives on either: the page is flat rules now.
    for (const line of `${wide}\n${plain(narrow)}`.split('\n')) {
      assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
        `a panel border survived: ${line}`);
    }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The pages the mod asked for: the Usage page with its meter windows, rungs,
// tabs and read-only note; the Home install button; the mouse; and the setup
// hand-off. Each page is a pure function of a model, so every expectation
// below is a frame the terminal would paint verbatim.
// ---------------------------------------------------------------------------

test('the Budget page draws every window of every pool and no untrustworthy figure', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage, rollups: rollupFixture(), prices: { subscriptions: {} } });
  const frame = renderDashboardPage(model, { page: 'budget', width: 100, height: 40 });
  const text = plain(frame.lines.join('\n'));

  assert.match(frameHeader(text), /^ Budget · \d+ days to /);
  // The page the owner asked for on 2026-09-19: a heading per pool, one row
  // per window with its reset and pace, and nothing derived from a fitted
  // rate. The audit of 2026-09-18 found every one of those figures wrong.
  assert.match(text, /^relay$/m, 'the pool heading is the pool name alone');
  // Painted cells strip to spaces, so the plain row is label, bar area, percent.
  assert.match(text, /^7d\s+.*\s+\d+\.\d%$/m, 'a window row is label, bar and percent');
  assert.match(text, /resets .* · (?:on track|slow|fast) [+\u2212-]?\d+pp/);
  assert.match(text, /64 of 70 credits/, 'a credit meter survives even with no monthly window');
  assert.match(text, /Declare a price: bullswarm strategy set-subscription/);
  assert.match(text, /spend by run is on Home and Stats/);
  for (const retired of [/by bullswarm/, /other tools/, /more medium runs/, /of API-equivalent work/, /biggest:/]) {
    assert.doesNotMatch(text, retired, `Budget still draws ${retired}`);
  }
  // The notes sit above the nav, and the nav is still whole.
  assert.match(plain(frame.lines.at(-1)), /\[ quit \]/);
});

test('Home marks provider, transcript, estimated and unknown usage bases', () => {
  const nowMs = Date.parse('2026-09-18T12:00:00.000Z');
  // The money pair is strict: a provider-reported figure is bare, a summed one
  // carries ≈, an estimate carries ~, and a figure with no source is a dash.
  const cases = [
    ['provider-reported', 1.23, /\$1\.23/],
    ['transcript-summed', 1.23, /≈ \$1\.23/],
    ['estimated:utf8-bytes\/4', 1.23, /~ \$1\.23/],
    // No figure at all: the money pair is a dash rather than a zero or a guess.
    ['unknown', null, /API — · subscription —/],
  ];
  for (const [tokenSource, costUsd, expected] of cases) {
    const record = {
      schemaVersion: 'bullswarm.workflow.rollup.v1',
      runId: `wf-basis-${tokenSource}`, shortId: 'basis1', project: 'bullswarm', goal: 'basis labels',
      startedAt: '2026-09-18T10:00:00.000Z', finishedAt: '2026-09-18T11:00:00.000Z',
      status: 'completed', verified: true, minutes: { wall: 1, agent: 1 },
      pools: { relay: { attempts: 1, minutes: 1, costUsd, tokenSource } },
      models: { model: { attempts: 1, minutes: 1 } }, legacy: false,
    };
    const model = dashboardModel(record, {
      nowMs,
      rollups: [record],
      days: [{ date: '2026-09-18', rows: [record] }],
      usage: { pools: [{ name: 'relay', usedPct: 10, elapsedPct: 20 }] },
    });
    const text = plain(renderDashboardPage(model, { page: 'home', width: 120, height: 60, nowMs }).lines.join('\n'));
    assert.match(text, expected, tokenSource);
    if (costUsd == null) assert.doesNotMatch(text, /\$ ?1\.23/, tokenSource);
  }
});

test('Pool keeps the retained meter-history model separate from its rollup panels', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-dashboard-'));
  try {
    const historyDir = join(home, 'meters', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'relay.jsonl'), [
      JSON.stringify({ captured_at: '2026-09-14T12:00:00Z', weekly: { utilization: 20 } }),
      JSON.stringify({ captured_at: '2026-09-15T12:00:00Z', weekly: { utilization: 25 } }),
    ].join('\n'));
    const pools = [{ name: 'relay', enabled: true, pacingWindow: 'weekly', usedPct: 25, elapsedPct: 30 }];
    const rollups = [{ runId: 'wf-old', startedAt: '2026-08-20T00:00:00Z', finishedAt: '2026-08-20T01:00:00Z', pools: {} }];
    const history = readLicencePerDay(home, pools, {
      period: '30d', now: Date.parse('2026-09-16T12:00:00Z'), rollups,
    });
    assert.ok(history.rows.some((row) => row.date === '2026-09-14' && row.segments[0]?.value === 20));
    assert.ok(history.rows.some((row) => row.date === '2026-08-18' && row.segments.length === 0));
    assert.match(history.reason, /earlier days in 30d are blank/);

    const model = dashboardModel(null, {
      usage: { pools, assignments: [], rungs: [] }, rollups, period: '30d', meterHistory: history,
    });
    const text = plain(renderDashboardPage(model, {
      page: 'stats', statsTab: 'pool', period: '30d', width: 120, height: 100,
    }).lines.join('\n'));
    assert.match(text, /Pool spend/);
    assert.match(text, /Licence \/ reset history/);
    assert.doesNotMatch(text, /meter history is not loaded/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Pool retains quota-reset evidence while rendering the shared rollup surface', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-meter-reset-'));
  try {
    const historyDir = join(home, 'meters', 'history');
    mkdirSync(historyDir, { recursive: true });
    // The provider restates the same boundary with sub-second jitter on every
    // read; only the 09-16 line moves the window a week on, which is a reset.
    writeFileSync(join(historyDir, 'relay.jsonl'), [
      JSON.stringify({ captured_at: '2026-09-14T12:00:00Z', weekly: { utilization: 60, resets_at: '2026-09-16T05:00:00.449022+00:00' } }),
      JSON.stringify({ captured_at: '2026-09-15T12:00:00Z', weekly: { utilization: 90, resets_at: '2026-09-16T05:00:00.112700+00:00' } }),
      JSON.stringify({ captured_at: '2026-09-16T12:00:00Z', weekly: { utilization: 8, resets_at: '2026-09-23T05:00:00.803155+00:00' } }),
    ].join('\n'));
    const pools = [{ name: 'relay', enabled: true, pacingWindow: 'weekly', usedPct: 8, elapsedPct: 12 }];
    const history = readLicencePerDay(home, pools, {
      period: '7d', now: Date.parse('2026-09-16T18:00:00Z'), rollups: [],
    });
    const on = (date) => history.rows.find((row) => row.date === date)?.segments[0];
    assert.equal(on('2026-09-14')?.reset, undefined);
    assert.equal(on('2026-09-15')?.reset, undefined);
    assert.equal(on('2026-09-16')?.reset, true);
    assert.equal(on('2026-09-16')?.resetsAt, '2026-09-23T05:00:00.803155+00:00');

    const model = dashboardModel(null, {
      usage: { pools, assignments: [], rungs: [] }, rollups: [], period: '7d', meterHistory: history,
    });
    const text = plain(renderDashboardPage(model, {
      page: 'stats', statsTab: 'pool', period: '7d', width: 120, height: 100,
    }).lines.join('\n'));
    assert.match(text, /Pool spend/);
    assert.match(text, /Licence \/ reset history/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the Fleet page draws the rungs under its two tabs, with the read-only note', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage });
  const byLane = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30 });
  const text = plain(byLane.lines.join('\n'));
  assert.match(frameHeader(text), /^ Fleet · by lane$/);
  assert.match(text, /by lane\s+by provider\s+\[ edit \]/);
  assert.match(text, /read-only here · edit opens bullswarm setup/);
  assert.match(text, /gpt-5\.6-luna · high/);
  assert.match(text, /3 runs · 67% ok · p50 12m/);

  const byProvider = renderDashboardPage(model, { page: 'fleet', width: 100, height: 30, fleetBy: 'provider' });
  const providerText = plain(byProvider.lines.join('\n'));
  assert.match(frameHeader(providerText), /^ Fleet · by provider$/);
  assert.match(providerText, /by lane\s+by provider/);
  assert.match(providerText, /relay/);
});

test('meters are background-coloured cells on Budget, and no plain bar survives', () => {
  const usage = usageFixture();
  const model = dashboardModel(null, { usage, rollups: rollupFixture() });
  const budget = renderDashboardPage(model, { page: 'budget', width: 100, height: 40 }).lines.join('\n');
  // Since 0.33.1 the fill colour says pace, not severity: #b6bd73 on track,
  // #e9c880 slow, #bf6c69 burning ahead of the clock; the track stays #3a3a3a.
  assert.ok(
    budget.includes('\x1b[48;2;233;200;128m') || budget.includes('\x1b[48;2;191;108;105m'),
    'this fixture paces slow and fast, so its fills are the amber and red cells',
  );
  assert.ok(budget.includes('\x1b[48;2;58;58;58m'), 'the track is a background-coloured cell');
  assert.match(budget, /\x1b\[38;2;255;255;255m[▏▕]/, 'the elapsed mark is a white ▏');
});

test('the Runs integration line offers [install] until every agent is installed, then reads [installed ✓]', () => {
  const offered = renderDashboardPage(dashboardModel(null, {
    runs: [],
    integration: {
      ok: false,
      agents: [
        { agent: 'codex', skill: { status: 'installed' }, awareness: true },
        { agent: 'claude', skill: { status: 'missing' }, awareness: false, mod: { status: 'missing' }, hooksFlag: false },
      ],
    },
  }), { page: 'help', width: 100, height: 60 });
  const text = offered.lines.join('\n');
  // Requirement 7: the agents block lives on Help now, not Runs.
  assert.match(text, /agent integration\s+\[install\]/);
  assert.match(text, /codex\s+skill ✓ · awareness ✓/);
  assert.match(text, /claude\s+skill — · awareness — · mod — · hooks —/);
  const install = offered.regions.find((region) => region.action.kind === 'install');
  assert.equal(plain(offered.lines[install.y - 1]).slice(install.x1 - 1, install.x2), '[install]');

  const done = renderDashboardPage(dashboardModel(null, {
    runs: [],
    integration: {
      ok: true,
      agents: [{ agent: 'claude', skill: { status: 'installed' }, awareness: true, mod: { status: 'installed' }, hooksFlag: true }],
    },
  }), { page: 'help', width: 100, height: 60 });
  const doneText = done.lines.join('\n');
  assert.match(doneText, /\[installed ✓\]/);
  assert.match(doneText, /claude\s+skill ✓ · awareness ✓ · mod ✓ · hooks ✓/);
  assert.equal(done.regions.some((region) => region.action.kind === 'install'), false, 'the button is inert once everything is installed');
});

test('a mouse click runs the same action its key does, and the wheel moves the window', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // A short terminal, so the Home body is taller than its window.
    const session = shellSession(home, { columns: 100, rows: 14 });
    // The wheel walks the body window down and the header reports it.
    const before = frameHeader(lastFrame(session.output));
    session.press('\x1b[<65;10;6M');
    const scrolled = frameHeader(lastFrame(session.output));
    assert.match(scrolled, / · \d+–\d+\/\d+$/);
    assert.notEqual(scrolled, before);

    clickOn(session, '[ 2.bbb222 ]');
    assert.match(frameHeader(lastFrame(session.output)), / ● bbb222 · running/);
    // The tab row is clickable, and every tab opens the page its key opens.
    clickOn(session, 'Budget');
    assert.match(frameHeader(lastFrame(session.output)), /^ Budget · /);
    clickOn(session, 'Fleet');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · edit opens bullswarm setup/);
    // Fleet's own sub-tab click is the same move Tab makes.
    clickOn(session, 'by provider');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · by provider$/);
    session.press('\t');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · by lane$/);

    // Esc goes Home; its run rows are clickable, and so are its step glyphs.
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    clickOn(session, '1.aaa111');
    assert.match(frameHeader(lastFrame(session.output)), / ● aaa111 · running/);
    // The plan is one clickable box per phase, and the box opens that phase's
    // first step — the same move Enter makes on the Run page.
    // Rule 2 names a level of more than one step by its writer count, so the
    // box reads `two writers`.
    clickOn(session, '[▶ 1 two writers 1/2]');
    const step = lastFrame(session.output);
    assert.match(frameHeader(step), /scan · aaa111 · succeeded/);
    assert.equal(navButtons(step)[0], 'back');
    clickOn(session, '[ back ]');
    assert.match(frameHeader(lastFrame(session.output)), / ● aaa111 · running/);
    // Run v2's footer has no quit button, so the shell's own is reached from
    // a page that still paints one.
    session.press(ESC_KEY);
    clickOn(session, '[ quit ]');
    assert.equal(await session.running, 0);
  } finally { cleanup(); }
});

test('Runs history jump reaches the first day without creating an unbounded scroll area', () => {
  const model = dashboardModel(null, { days: dayFixture().slice(0, 1) });
  const options = { page: 'runs', width: 120, height: 50 };
  const first = renderDashboardPage(model, options);
  const offset = first.anchor.history - 1;
  const jumped = renderDashboardPage(model, { ...options, bodyScroll: offset });
  assert.equal(jumped.body.offset, offset);
  assert.match(plain(jumped.lines[2]), /^── .* ──/);
  const beyond = renderDashboardPage(model, { ...options, bodyScroll: 100000 });
  assert.equal(beyond.body.total, first.body.total);
  assert.equal(beyond.body.offset, offset);
});

test('a Spending chart column hovers and pins its dated value', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30 });
    session.press('s');
    const rows = paintedRows(lastFrame(session.output)).map(plain);
    const axisRow = rows.findIndex((line) => /[+┼].*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)/.test(line));
    assert.ok(axisRow > 0, 'the Spending chart has a dated axis');
    const chartRow = rows.map((line, index) => ({ line, index }))
      .filter(({ line, index }) => index < axisRow && /[█▇▆▅▄▃▂▁]/.test(line)).at(-1);
    assert.ok(chartRow, 'the Spending chart has a painted column');
    const x = chartRow.line.search(/[█▇▆▅▄▃▂▁]/) + 1;
    const y = chartRow.index + 1;
    session.press(`\x1b[<35;${x};${y}M`);
    assert.match(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*of the day/);
    session.press(`\x1b[<0;${x};${y}M`);
    session.press('\x1b[<35;1;2M');
    assert.match(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*of the day/);
    session.press(ESC_KEY);
    assert.doesNotMatch(plain(lastFrame(session.output)), /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat).*of the day/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

// Budget stopped listing runs on 2026-09-19: its money lines were the audit's
// untrustworthy figures, and a run is opened from Runs instead. What this test
// still guards is that a refresh does not clobber the opened selection.
test('a finished run opened from Runs remains selected across two refreshes', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // A legacy connector JSON is enough to give Budget one real pool without
    // loading any packaged providers in this isolated test home.
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'relay.json'), JSON.stringify({ name: 'relay', lanes: ['build'] }));
    const finishedAt = new Date().toISOString();
    writeV2Run(home, {
      runId: 'wf-zzz', shortId: 'zzz999', goal: 'Rebuild the dashboard shell', status: 'completed',
      startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt,
    });
    const session = shellSession(home, { columns: 120, rows: 36, refreshMs: 10 });
    session.press('r');
    await settle();
    assert.ok(plain(lastFrame(session.output)).includes('zzz999'), 'Runs did not paint the finished workflow');
    clickOn(session, 'zzz999');
    assert.match(frameHeader(lastFrame(session.output)), /zzz999 · completed/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.match(frameHeader(lastFrame(session.output)), /zzz999 · completed/, 'refresh lost the finished selection');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('the Runs [install] button installs the agent integration in-process', async () => {
  const { home, cleanup } = shellFixture();
  const agentHome = mkdtempSync(join(tmpdir(), 'bs-dashboard-integrate-'));
  try {
    const session = shellSession(home, { columns: 100, rows: 60, homeDir: agentHome });
    session.press('?');
    assert.match(plain(lastFrame(session.output)), /\[install\]/);
    session.press('i');
    const frame = plain(lastFrame(session.output));
    // The status line reflects it, and every agent's result is shown inline:
    // the skill, the awareness block, and for Claude the mod and hooks flag.
    assert.match(frame, /agent integration\s+\[installed ✓\]/);
    assert.match(frame, /install results/);
    assert.match(frame, /codex · skill installed · awareness installed/);
    assert.match(frame, /claude · skill installed · awareness installed · mod linked · hooks flag set/);
    assert.match(frame, /grok · skill installed · awareness installed/);
    assert.equal(await session.quit(), 0);
    assert.equal(existsSync(join(agentHome, '.codex', 'skills', 'bullswarm')), true);
  } finally { cleanup(); rmSync(agentHome, { recursive: true, force: true }); }
});

test('the [edit] button pauses the dashboard for setup and resumes on the Fleet page', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const handoffs = [];
    const openSetupTui = async ({ bullswarmDir, input, output }) => {
      handoffs.push({ bullswarmDir, isTTY: input.isTTY, painted: output.text.length });
    };
    const session = shellSession(home, { columns: 100, rows: 26, token: 'wf-alpha', openSetupTui });
    session.press('f');
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    const before = session.output.text.length;
    session.press('e');
    await settle();
    await settle();

    assert.equal(handoffs.length, 1, 'the injected control centre ran once');
    assert.equal(handoffs[0].bullswarmDir, home);
    const handover = session.output.text.slice(before);
    // The terminal is handed over cleanly: mouse reporting and the cursor
    // restored, the alternate screen left.
    assert.ok(handover.includes('\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?25h\x1b[?1049l'), 'the dashboard did not release the terminal');
    // And taken back: alternate screen, hidden cursor, mouse reporting on.
    assert.ok(handover.includes('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1000h\x1b[?1003h\x1b[?1006h'), 'the dashboard did not take the terminal back');
    assert.deepEqual(session.input.rawModes, [true, false, true]);
    // It returns to the Fleet page with the note and a fresh repaint.
    assert.match(frameHeader(lastFrame(session.output)), /^ Fleet · /);
    assert.match(plain(lastFrame(session.output)), /read-only here · edit opens bullswarm setup/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The three things the 0.33.0 acceptance asks of the shell: every key reaches
// its page or its action, every clickable atom runs the same action its key
// runs, and no money or licence figure is ever painted as a bare number.
// ---------------------------------------------------------------------------

test('every key in the table reaches its page or its action', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30 });
    const header = () => frameHeader(lastFrame(session.output));
    const screen = () => plain(lastFrame(session.output));

    // r b s y f ? — one key per page; y is Runs at its History table.
    for (const [key, expected] of [
      ['r', /^ bullswarm · runs/],
      ['b', /^ Budget · /],
      ['s', /^ Stats · spending/],
      ['y', /^ bullswarm · runs · /],
      ['f', /^ Fleet · by lane/],
      ['?', /^ bullswarm · help/],
    ]) {
      session.press(key);
      assert.match(header(), expected, `${key} did not open its page`);
      session.press(ESC_KEY);
      assert.match(header(), /^ bullswarm · home/, `Esc did not come back from ${key}`);
    }
    session.press('?');
    assert.match(header(), /^ bullswarm · help/);

    // 1–9 open the run that carries that digit in the nav.
    session.press('1');
    assert.match(header(), / ● aaa111 · running/);
    session.press('2');
    assert.match(header(), / ● bbb222 · running/);
    session.press('9');
    assert.match(screen(), /no run 9 in flight/);

    // Esc and the left arrow both walk out, step -> run -> home.
    session.press('\r'); // run -> the phase's first step
    assert.match(header(), /scan · bbb222 · succeeded/);
    session.press('\x1b[D');
    assert.match(header(), / ● bbb222 · running/);
    session.press(ESC_KEY);
    session.press(ESC_KEY);
    assert.match(header(), /^ bullswarm · home/);

    // Tab walks the sub-tabs of the pages that have them, and says so on the
    // pages that do not.
    session.press('s');
    assert.match(header(), /^ Stats · spending/);
    session.press('\t');
    assert.match(header(), /^ Stats · pool/);
    session.press('\t');
    assert.match(header(), /^ Stats · model/);
    session.press('f');
    session.press('\t');
    assert.match(header(), /^ Fleet · by provider/);
    session.press(ESC_KEY);
    session.press('\t');
    assert.match(screen(), /Tab walks the sub-tabs on Stats and Fleet/);

    // Shift+Tab still cycles workflows.
    session.press('1');
    assert.match(header(), / ● aaa111 · running/);
    session.press(`${ESC_KEY}[Z`);
    assert.match(header(), / ● bbb222 · running/);
    session.press(ESC_KEY);

    // p cycles the period, and every page drawn over one follows it.
    session.press('p');
    assert.match(screen(), /Period · Last 30 days/);
    session.press('p');
    assert.match(screen(), /Period · All time/);
    session.press('p');
    assert.match(screen(), /Period · Last 7 days/);

    // The movement keys walk the body window, and Home/End jump it. Home
    // itself is short now (cards, licence, running, budget), so Help is the
    // page long enough to scroll.
    session.press('?');
    const top = header();
    session.press('\x1b[B');
    session.press('j');
    const moved = header();
    assert.notEqual(moved, top, 'down/j did not move the window');
    session.press('\x1b[A');
    session.press('k');
    assert.equal(header(), top, 'up/k did not come back');
    session.press('\x1b[6~'); // PgDn
    assert.notEqual(header(), top, 'PgDn did not move the window');
    session.press('\x1b[H'); // Home
    assert.equal(header(), top, 'Home did not go back to the top');
    session.press('\x1b[F'); // End
    assert.match(header(), / · \d+–\d+\/\d+$/);
    session.press('\x1b[5~'); // PgUp
    session.press('\x1b[H');
    assert.equal(header(), top);

    // ctrl+s copies the painted screen, and says how it carried it.
    session.press('\x13');
    assert.match(screen(), /screen copied \(OSC 52\) · \d+ lines/);
    assert.match(session.output.text, /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);

    // q quits, and never asks a kernel to stop.
    assert.equal(await session.quit(), 0);
    assert.equal(existsSync(join(home, 'workflows', 'wf-alpha', 'cancellation.json')), false);
  } finally { cleanup(); }
});

test('a pending stop still takes y, and Help says so', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 30, token: 'wf-alpha' });
    session.press('c');
    assert.match(plain(lastFrame(session.output)), /Stop this workflow\? y confirm/);
    session.press('y');
    assert.match(plain(lastFrame(session.output)), /Stop requested for aaa111/);
    assert.equal(existsSync(join(home, 'workflows', 'wf-alpha', 'cancellation.json')), true);
    // And with no question on the screen, y is Runs at its History table.
    session.press('y');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · /);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('ctrl+s falls back to the local clipboard, and the message names the tool', () => {
  const calls = [];
  const run = (tool, args, options) => { calls.push({ tool, args, input: options.input }); return { status: 0 }; };
  assert.deepEqual(
    writeClipboard('two\nlines', { platform: 'darwin', env: {}, run }),
    { ok: true, tool: 'pbcopy' },
  );
  assert.deepEqual(calls, [{ tool: 'pbcopy', args: [], input: 'two\nlines' }]);

  const wayland = [];
  assert.deepEqual(
    writeClipboard('x', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run: (tool, args, options) => { wayland.push(tool); return { status: 0 }; },
    }),
    { ok: true, tool: 'wl-copy' },
  );
  assert.deepEqual(wayland, ['wl-copy']);

  // A machine with neither says so rather than claiming a copy that never was.
  const none = writeClipboard('x', { platform: 'linux', env: {}, run: () => ({ status: 1 }) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no pbcopy, wl-copy or xclip/);

  // A tool that fails is reported as a failure, not as a copy.
  const failing = writeClipboard('x', { platform: 'darwin', env: {}, run: () => ({ error: new Error('nope') }) });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /pbcopy failed/);
});

test('every clickable atom runs the same action its key runs', async () => {
  const { home, cleanup } = shellFixture();
  try {
    // Each pair is [what to click, the key that does the same thing].
    const session = shellSession(home, { columns: 120, rows: 30 });
    const header = () => frameHeader(lastFrame(session.output));
    for (const [needle, key, expected] of [
      ['Runs', 'r', /^ bullswarm · runs/],
      ['Budget', 'b', /^ Budget · /],
      ['Stats', 's', /^ Stats · spending/],
      ['Runs', 'y', /^ bullswarm · runs · /],
      ['Fleet', 'f', /^ Fleet · by lane/],
      ['Home', null, /^ bullswarm · home/],
    ]) {
      session.press(ESC_KEY);
      clickOn(session, needle);
      const clicked = header();
      assert.match(clicked, expected, `clicking ${needle} did not open its page`);
      if (!key) continue;
      session.press(ESC_KEY);
      session.press(key);
      if (key === 'y') {
        // y opens Runs at its first day header; the tab click opens it at the
        // top, so the pair is compared by page and filter, not scroll offset.
        assert.match(header(), /^ bullswarm · runs · /, `clicking ${needle} and pressing ${key} disagree`);
        assert.equal(header().replace(/ · [\d–]+\/\d+$/, ''), clicked.replace(/ · [\d–]+\/\d+$/, ''),
          `clicking ${needle} and pressing ${key} disagree`);
        continue;
      }
      assert.equal(header(), clicked, `clicking ${needle} and pressing ${key} disagree`);
    }

    // A run button and its digit are the same action.
    session.press(ESC_KEY);
    clickOn(session, '[ 2.bbb222 ]');
    const byClick = header();
    session.press(ESC_KEY);
    session.press('2');
    assert.equal(header(), byClick);

    // A Home licence table row opens Budget for that pool — the row's own
    // page action, now in the right half of the Today band.
    session.press(ESC_KEY);
    clickOn(session, ' relay  ');
    assert.match(header(), /^ Budget · /);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Home halves keep their clicks and hovers: a card opens its run, the chart its trend, a breakdown its Stats tab', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 120, rows: 90 });
    const header = () => frameHeader(lastFrame(session.output));
    const half = Math.floor((120 - 2) / 2);
    // Hovering a card's row lights that card's words and nothing in the
    // licence table beside it.
    const rows = paintedRows(lastFrame(session.output));
    const cardRow = rows.findIndex((line) => line.startsWith('│ ') && line.slice(half).includes('relay'));
    assert.ok(cardRow >= 0, `no card row beside the relay licence row:\n${rows.join('\n')}`);
    session.press(`\x1b[<35;4;${cardRow + 1}M`);
    const lit = lastFrame(session.output).split('\n')[cardRow];
    const litSpans = [...lit.matchAll(/\x1b\[7m([^\x1b]*)/g)].map((match) => match[1]).join('');
    assert.ok(litSpans.trim(), `the hovered card row is not lit: ${JSON.stringify(lit)}`);
    assert.doesNotMatch(litSpans, /relay|agent min/, 'the hover spilled into the licence table');
    session.press('\x1b[<35;1;2M');
    for (const [needle, expected] of [
      ['spent per day', /^ Stats · spending/],
      ['by pool', /^ Stats · pool/],
      ['by model', /^ Stats · model/],
      ['by project', /^ Stats · project/],
    ]) {
      session.press(ESC_KEY);
      assert.match(header(), /^ bullswarm · home/);
      clickOn(session, needle);
      assert.match(header(), expected, `clicking ${needle} did not open its page`);
    }
    // A card's own box opens its run, as Enter on it does.
    session.press(ESC_KEY);
    const where = clickOn(session, '┌─ sibling-run');
    assert.ok(where.x <= half, 'the card is not in the left half');
    const byClick = header();
    assert.doesNotMatch(byClick, /^ bullswarm · home/, 'clicking a card did not open its run');
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('with no declared price and no measured licence rate, no bare number is painted', () => {
  // The state of every pool on a real machine today: a live meter, no
  // `spend.pacing.ratePerMinute`, no declared subscription price, and
  // `normalizedQuota.estimatedPercent` null on every attempt.
  const usage = usageFixture();
  for (const pool of usage.pools) delete pool.spend;
  const rollups = rollupFixture().map((record) => ({
    ...record,
    pools: Object.fromEntries(Object.entries(record.pools)
      .map(([name, entry]) => [name, { ...entry, costUsd: null }])),
  }));
  const days = dayFixture().map((day) => ({
    ...day,
    spendUsd: null,
    rows: day.rows.map((record) => ({
      ...record,
      pools: Object.fromEntries(Object.entries(record.pools)
        .map(([name, entry]) => [name, { ...entry, costUsd: null }])),
    })),
  }));
  const model = dashboardModel(null, { usage, rollups, days, prices: { subscriptions: {} } });

  for (const page of ['home', 'budget', 'stats', 'history']) {
    for (const width of [120, 54]) {
      const text = plain(renderDashboardPage(model, { page, width, height: 40 }).lines.join('\n'));
      // Every money figure on screen carries its ≈ and its basis; a figure
      // with no source is a blank with the reason beside it.
      for (const match of text.matchAll(/\$\s?[\d.]+/g)) {
        const before = text.slice(Math.max(0, match.index - 2), match.index);
        assert.ok(before.includes('≈'), `${page} at ${width} painted a bare ${match[0]}: ${before}${match[0]}`);
      }
      // And no licence percent is claimed for a run or a pool without a rate.
      assert.doesNotMatch(text, /≈ \d+\.\d+% of its/, `${page} at ${width} claimed a licence share with no measured rate`);
    }
  }

  // Home says why the blank today figures are blank rather than printing a
  // zero. The phone layout gives the band its own rows, so the reason is
  // visible without a tile.
  const home = plain(renderDashboardPage(model, { page: 'home', width: 54, height: 40 }).lines.join('\n'));
  assert.match(home, /relay\s+.*—/);
  // Budget carries no money line at all since 2026-09-19: its share, room and
  // spend figures came from a fitted rate the audit disproved. What remains is
  // meters, resets, pace, and how to declare a price.
  const budget = plain(renderDashboardPage(model, { page: 'budget', width: 120, height: 40 }).lines.join('\n'));
  assert.doesNotMatch(budget, /\$\d/, 'Budget painted a bare number');
  assert.doesNotMatch(budget, /of API-equivalent work/);
  assert.match(budget, /Declare a price: bullswarm strategy set-subscription/);
  assert.match(budget, /spend by run is on Home and Stats/);
});

test('a run with no recorded estimate and no measured rate paints blanks, not zeroes', () => {
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) delete pool.spend;
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    const text = plain(renderDashboardPage(model, {
      page: 'run', width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    // Run v2 rule 5: with nothing measured the spend block is a dash and the
    // coverage that produced it, in words — never a manufactured zero. The
    // label column is ten cells, so the amount opens one cell after it.
    assert.match(text, /── spend · 0 of \d+ attempts measured ─/);
    assert.match(text, /API rate {3}—\s+\d+ (?:running|unmeasured)/);
    assert.match(text, /plans {6}—\s+0 attempts with a meter reading · \d+ without/);
    // Rules 4 and 7: the licence bars, the `so far` block and the ETA row all
    // left this page, so none of their words survive.
    assert.doesNotMatch(text, /free model · no licence meter/);
    assert.doesNotMatch(text, /ETA/);
    assert.doesNotMatch(text, /── so far ─/);
    assert.doesNotMatch(text, /\$0\.00/);
  } finally { cleanup(); }
});

test('the Step page writes an unmetered pool in words, never a dotted track', () => {
  // Requirement 8 applies to every page, not just Run: the owner's Step frame
  // showed `opencode ······················  — · —`.
  const { home, cleanup } = shellFixture();
  try {
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) delete pool.spend;
    usage.pools.push({
      name: 'opencode2', enabled: true, free: true, meterSource: 'none', pacingWindow: null,
      connector: { meter: { type: 'none' }, modelProfiles: [{ match: '.*', free: true }] },
    });
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    for (const width of [55, 120, 170, 200]) {
      const lines = plain(renderDashboardPage(model, {
        page: 'step', width, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
        phaseIndex: 0, agentIndex: 0,
      }).lines.join('\n')).split('\n');
      for (const line of lines) {
        assert.ok(!/·{6,}/.test(line), `${width} kept a dotted track: ${line}`);
      }
      // Step v2 rule 8: two rows, `API rate` and the pool's plan, each with its
      // amount and one line of basis. `budget —` is gone and `api` is never
      // said twice, so the block rule is just `cost`.
      const cost = lines.findIndex((line) => /── cost ─/.test(line));
      assert.ok(cost >= 0, lines.join('\n'));
      const costBlock = lines.slice(cost, cost + 4).join('\n');
      assert.match(costBlock, /API rate\s+—\s+no recorded rate/, `${width}: ${costBlock}`);
      assert.match(costBlock, /plan\s+—\s+no meter readin/, `${width}: ${costBlock}`);
      assert.doesNotMatch(costBlock, /budget/, `${width}: ${costBlock}`);
      assert.doesNotMatch(costBlock, /\$0\.00/, `${width}: ${costBlock}`);
    }
  } finally { cleanup(); }
});

test('a paused run\u2019s live block says how to continue it, not that it is waiting', () => {
  // Requirement 8: the owner's screenshot showed `waiting for the next
  // dispatch` under a run that was paused, which reads as \u201cany moment now\u201d.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    state.lifecycle.status = 'paused';
    delete state.lifecycle.finishedAt;
    for (const attempt of state.attempts ?? []) {
      if (attempt.status === 'running') attempt.status = 'cancelled';
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage: usageFixture() });
    // The band is three columns at 120, so the sentence needs the wide frame to
    // be read whole; both widths must have dropped `waiting for the next
    // dispatch`.
    const wide = plain(renderDashboardPage(model, {
      page: 'run', width: 200, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    assert.match(wide, /paused · bullswarm workflow resume \w+ continues it/, wide);
    for (const width of [55, 120, 200]) {
      const text = plain(renderDashboardPage(model, {
        page: 'run', width, height: 50, rows, allRows: rows, selectedRunId: 'wf-alpha',
      }).lines.join('\n'));
      assert.match(text, /paused · bullswarm workflow resume/, text);
      assert.doesNotMatch(text, /waiting for the next dispatch/, text);
    }
  } finally { cleanup(); }
});

test('an explicitly recorded "estimatedUsd: null" stays blank and is never counted as priced', () => {
  // The shape the real corpus actually writes: the attempt has a cost object
  // and the figure inside it is null.  Number(null) is 0 and Number.isFinite(0)
  // is true, so a bare Number() here paints "≈ $0.00 · 2 of 2 attempts priced"
  // for a run that priced nothing.  Observed live on 2026-09-17 against run
  // ahvsda, whose ten attempts all record estimatedUsd: null.
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    for (const attempt of state.attempts) {
      attempt.usage = { cost: { estimatedUsd: null, breakdown: null, basis: 'unknown: no model rate metadata' } };
      attempt.wallSec = null;
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const rows = dashboardRows(home, { all: true });
    const row = rows.find((entry) => entry.runId === 'wf-alpha');
    const usage = usageFixture();
    for (const pool of usage.pools) pool.spend = { pacing: { window: 'weekly', ratePerMinute: null, source: null, samples: 0 } };
    const model = dashboardModel(row, { runs: rows.filter((entry) => entry.ongoing), usage });
    for (const page of ['run', 'step']) {
      const text = plain(renderDashboardPage(model, {
        page, width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
      }).lines.join('\n'));
      assert.doesNotMatch(text, /\$0\.00/, `${page} manufactured a zero from a null estimate`);
      assert.doesNotMatch(text, /attempts priced/, `${page} counted a null estimate as priced`);
      if (page === 'run') assert.match(text, /API rate {3}—/, `${page} manufactured a money figure from a null estimate`);
      // Step v2 rule 11: a running attempt's cost block says it is measured
      // when the attempt finishes rather than printing a guess; a finished one
      // with no rate prints a dash and its reason.
      else assert.match(text, /(?:API rate\s+—|measured when the attempt finishes)/, `${page} manufactured a money figure from a null estimate`);
      // A null ratePerMinute is a blank share, never 0.00%.
      assert.doesNotMatch(text, /≈ 0\.00% of its/, `${page} claimed a zero licence share`);
    }
  } finally { cleanup(); }
});

const HOME_PAINT_CALIBRATION_ITERATIONS = 50_000_000;
function calibrateHomePaintBudget() {
  let checksum = 0;
  const start = process.hrtime.bigint();
  for (let index = 0; index < HOME_PAINT_CALIBRATION_ITERATIONS; index += 1) checksum = (checksum + index) | 0;
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(Number.isInteger(checksum), 'calibration loop completed');
  return elapsedMs;
}

test('Home paints within a calibrated budget with 293 run directories present', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-perf-'));
  try {
    // The corpus this machine actually has: 293 run directories, each with a
    // state.json far too big to parse on a 1 s timer, and the index that is
    // read instead.
    mkdirSync(join(home, 'history'), { recursive: true });
    const filler = 'x'.repeat(20_000);
    const records = [];
    for (let index = 0; index < 293; index += 1) {
      const runId = `wf-perf-${String(index).padStart(4, '0')}`;
      const shortId = `p${String(index).padStart(5, '0')}`;
      const dir = join(home, 'workflows', runId);
      mkdirSync(dir, { recursive: true });
      const finishedAt = new Date(Date.now() - index * 3_600_000).toISOString();
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId,
        lifecycle: { status: 'completed', startedAt: finishedAt, finishedAt },
        intent: { goal: `perf run ${index}`, cwd: '/tmp' },
        actions: [], attempts: [], planner: { status: 'completed', turns: 1, attempts: [] },
        presentation: { stages: [] }, ledger: { requirements: {} }, notes: filler,
      }));
      // A finished run writes rollup.json, which is how the refresh path knows
      // it never has to open that state.json again.
      writeFileSync(join(dir, 'rollup.json'), '{}');
      records.push(JSON.stringify({
        schemaVersion: 'bullswarm.workflow.rollup.v1', runId, shortId,
        project: 'bullswarm', goal: `perf run ${index}`, startedAt: finishedAt, finishedAt,
        status: 'completed', verified: index % 2 === 0, requirements: { passed: 1, total: 1 },
        minutes: { wall: 10 + (index % 30), agent: 12 },
        pools: { relay: { attempts: 1, minutes: 10, costUsd: 0.01, tokens: 100 } },
        models: { luna: { attempts: 1, minutes: 10 } }, legacy: false,
      }));
    }
    writeFileSync(join(home, 'history', 'runs.jsonl'), `${records.join('\n')}\n`);

    const runs = activeDashboardRows(home);
    assert.deepEqual(runs, [], 'a finished run is never parsed on the refresh path');
    const rollups = readRollups(home);
    assert.equal(rollups.length, 293, 'the index carries every finished run');

    // The measurement: one whole Home paint, model and render, over the index.
    const paint = () => renderDashboardPage(
      dashboardModel(null, { runs, rollups, days: [] }),
      { page: 'home', width: 120, height: 40 },
    );
    const frame = paint();
    assert.ok(frame.lines.length > 0, 'Home painted nothing');
    // Calibrate once on this machine while it has the same scheduler/load as
    // the paint. The budget is relative to a fixed pure-JS loop, not an idle
    // host's wall-clock speed; the absolute cap still rejects an unusable UI.
    const calibrationMs = calibrateHomePaintBudget();
    const samples = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const start = process.hrtime.bigint();
      paint();
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)];
    const calibratedBudgetMs = calibrationMs * 0.5;
    assert.ok(median < 250, `Home took ${median.toFixed(1)}ms with 293 run directories (absolute cap)`);
    assert.ok(median < calibratedBudgetMs, `Home took ${median.toFixed(1)}ms; calibrated budget was ${calibratedBudgetMs.toFixed(1)}ms (calibration ${calibrationMs.toFixed(1)}ms)`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an ascii terminal gets ascii: no substituted glyph survives on a page the shell draws', () => {
  const { home, cleanup } = shellFixture();
  const before = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows.find((entry) => entry.runId === 'wf-alpha'), {
      runs: rows.filter((entry) => entry.ongoing),
      usage: usageFixture(),
      rollups: rollupFixture(),
      days: dayFixture(),
    });
    // Fleet is left out: `[● by lane]` is fleet-view's own literal, reported
    // to the integrator rather than patched from another territory.
    for (const page of ['home', 'runs', 'run', 'step', 'budget', 'stats', 'history', 'help']) {
      for (const width of [120, 54]) {
        const text = plain(renderDashboardPage(model, {
          page, width, height: 40, rows, allRows: rows, selectedRunId: 'wf-alpha',
        }).lines.join('\n'));
        for (const glyph of SUBSTITUTED_GLYPHS) {
          assert.ok(!text.includes(glyph), `${page} at ${width} painted ${glyph} in ascii mode`);
        }
        for (const line of text.split('\n')) {
          assert.ok([...line].length <= width, `${page} at ${width} overflowed in ascii mode`);
        }
      }
    }
  } finally {
    if (before === undefined) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = before;
    cleanup();
  }
});

test('History loads seven more days each time the reader nears the bottom', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-history-'));
  try {
    // Thirty days of finished runs, one a day: more than the seven History
    // opens with, so scrolling has something to load.
    mkdirSync(join(home, 'history'), { recursive: true });
    mkdirSync(join(home, 'workflows'), { recursive: true });
    const records = [];
    for (let back = 0; back < 30; back += 1) {
      const at = new Date(Date.now() - back * 86_400_000).toISOString();
      records.push(JSON.stringify({
        schemaVersion: 'bullswarm.workflow.rollup.v1',
        runId: `wf-day-${back}`, shortId: `d${String(back).padStart(5, '0')}`,
        project: 'bullswarm', goal: `run ${back}`, startedAt: at, finishedAt: at,
        status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
        minutes: { wall: 10, agent: 12 },
        pools: { relay: { attempts: 1, minutes: 10, costUsd: 0.01, tokens: 10 } },
        models: { luna: { attempts: 1, minutes: 10 } }, legacy: false,
      }));
    }
    writeFileSync(join(home, 'history', 'runs.jsonl'), `${records.join('\n')}\n`);

    const session = shellSession(home, { columns: 100, rows: 20 });
    session.press('y');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · \S+ · 7 days/);
    // End is the bottom of what is loaded, so the next scroll asks for more.
    session.press('\x1b[F');
    session.press('\x1b[6~');
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · runs · \S+ · (14|21) days/);
    assert.equal(await session.quit(), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 0.33.0 visual fidelity: the composition the approved prototype frames draw.
//
// Home, Run, Step and Help are asserted against what the frames in
// docs/design/prototype-frames/ actually contain — the four-column breakdown
// band, the `── budget · this week ──` block, the flat Run page, the Step
// label/value table and the grouped Help rows — at the three widths the pass
// is judged at. The numbers stay the product's own; only the shape is pinned.
// ---------------------------------------------------------------------------

/** The model the fidelity assertions render, with real rollups and meters. */
function fidelityModel() {
  const { home, cleanup } = shellFixture();
  const rows = dashboardRows(home, { all: true });
  const row = rows.find((entry) => entry.runId === 'wf-alpha');
  const model = dashboardModel(row, {
    runs: rows.filter((entry) => entry.ongoing),
    usage: usageFixture(),
    rollups: rollupFixture(),
    days: dayFixture(),
    prices: { subscriptions: {} },
  });
  return { home, rows, row, model, cleanup };
}

const FIDELITY_SIZES = [[120, 40], [55, 26], [200, 50]];

test('phone Home keeps one licence table row per pool that worked today', () => {
  const f = fidelityModel();
  try {
    const names = ['claude-code:acme', 'claude-code', 'codex', 'grok'];
    f.model.budget.rows = names.map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    for (const width of [55, 60]) {
      const text = plain(renderDashboardPage(f.model, { page: 'home', width, height: 150 }).lines.join('\n'));
      // The licence table is one row per pool that worked today, under one
      // header that names each column and its unit.
      const licence = text.split('── licences · today')[1].split('── running')[0];
      assert.match(licence, /^ pool +agent min +/m, licence);
      // The share has no measured rate behind it, so it stays a dash (or its
      // all-dash column gives way on the phone), and the money keeps the whole
      // amount this legacy entry recorded: an entry with no coverage counts
      // must not be read as unpriced attempts.
      assert.match(licence, /^ relay +40\.0 +(— +)?~0\.42( +—)?$/m, licence);
      assert.doesNotMatch(licence, /unpriced/, licence);
      assert.doesNotMatch(licence, /wf % \(est\.\)|run min/, 'the licence row uses no abbreviations');
      assert.doesNotMatch(licence, /more metered pool|codex/, licence);
      // Every metered pool is still named, with its whole percent, in the
      // budget block below it.
      const budget = text.split('budget · this week')[1];
      for (const name of names) assert.ok(budget.includes(name), `${name} missing at ${width}`);
      assert.match(budget, /70% on track/, `${width}: the pool percent is whole`);
      for (const line of text.split('\n')) assert.ok([...line].length <= width, line);
    }
  } finally { f.cleanup(); }
});

test('the Home budget block says how many metered pools it left out', () => {
  const f = fidelityModel();
  try {
    const names = ['claude-code:acme', 'claude-code', 'codex', 'grok', 'command-code', 'opencode'];
    f.model.budget.rows = names.map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    for (const width of [55, 60, 120, 200]) {
      const text = plain(renderDashboardPage(f.model, { page: 'home', width, height: 150 }).lines.join('\n'));
      const block = text.split('budget · this week')[1].split('last 7 days')[0];
      // Four pools are drawn and the two it dropped are counted in words, so
      // the block never reads as “those are all my pools”.
      for (const name of names.slice(0, 4)) assert.ok(block.includes(name), `${name} missing at ${width}: ${block}`);
      assert.match(block, /\+2 more metered pools · b opens Budget/, `${width}: ${block}`);
    }
    // Exactly four: nothing was left out, so nothing is counted.
    f.model.budget.rows = names.slice(0, 4).map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    const four = plain(renderDashboardPage(f.model, { page: 'home', width: 55, height: 150 }).lines.join('\n'));
    assert.doesNotMatch(four.split('budget · this week')[1].split('last 7 days')[0], /more metered pool/);
    // Five: singular.
    f.model.budget.rows = names.slice(0, 5).map((name, index) => ({ name, usedPct: 70 - index, elapsedPct: 60 }));
    const five = plain(renderDashboardPage(f.model, { page: 'home', width: 55, height: 150 }).lines.join('\n'));
    assert.match(five.split('budget · this week')[1].split('last 7 days')[0], /\+1 more metered pool · b opens Budget/);
  } finally { f.cleanup(); }
});

test('no page paints past the width or comes up blank at 120x40, 55x26 and 200x50', () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      for (const name of DASHBOARD_PAGE_NAMES) {
        const frame = renderDashboardPage(f.model, {
          page: name, width, height, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
          phaseIndex: 0, agentIndex: 0,
        });
        const painted = paintedRows(frame.lines.join('\n'));
        for (const line of painted) {
          assert.ok([...line].length <= width, `${name} at ${width}x${height} painted ${[...line].length} columns: ${line}`);
        }
        assert.ok(painted.filter((line) => line.trim()).length >= 3, `${name} at ${width}x${height} came up blank`);
        assert.match(plain(painted.at(-1)), /\[/, `${name} at ${width}x${height} lost its nav`);
      }
    }
  } finally { f.cleanup(); }
});

test('Home today band and every live step keep their rows readable on a phone', () => {
  const f = fidelityModel();
  try {
    const running = f.model.runs[0];
    running.state.actions = [
      { ...running.state.actions[0], id: 'first-live-action', status: 'running' },
      { ...running.state.actions[0], id: 'second-live-action', status: 'running' },
    ];
    const frame = renderDashboardPage(f.model, {
      page: 'home', width: 54, height: 120, rows: f.rows, allRows: f.rows,
    });
    const lines = paintedRows(frame.lines.join('\n')).map(plain);
    const today = lines.slice(lines.findIndex((line) => /^Home · Today/.test(line)),
      lines.findIndex((line) => /── running/.test(line))).filter((line) => line.trim());
    // The cards stack one per row at 54 columns, and the licence table keeps
    // its header row on the phone.
    assert.equal(today.filter((line) => /^┌─ /.test(line)).length, 3, today.join('\n'));
    assert.ok(today.some((line) => /· completed · verified/.test(line)), today.join('\n'));
    assert.ok(today.some((line) => /^── licences · today/.test(line)), today.join('\n'));
    assert.ok(today.some((line) => /^ pool +agent min +.*API \$/.test(line)), today.join('\n'));
    for (const id of ['first-live-action', 'second-live-action']) {
      const row = lines.find((line) => line.includes(id));
      assert.ok(row, `missing ${id}`);
      assert.match(row, /░{4,}/, `missing indeterminate bar: ${row}`);
    }
    for (const line of lines) {
      assert.ok([...line].length <= 54, line);
      // Every inline API-equivalent figure carries its usage-basis marker; a
      // column header that names the unit (`API $`) is not a figure, and the
      // spend chart's `$0` baseline is the axis origin, exact by definition.
      for (const match of line.replace(/\$0 ┼/, '   ┼').matchAll(/\$(?=\s?\d)/g)) {
        // A figure carries its basis: an estimate glyph, or the spend block's
        // own `at least` where the scope holds attempts nobody priced.
        assert.match(line.slice(Math.max(0, match.index - 10), match.index), /[≈~]\s*$|at least\s*$/, line);
      }
    }
  } finally { f.cleanup(); }
});

test("Home's budget block meters every pool and prints no bare number with no declared price", () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      const text = plain(renderDashboardPage(f.model, {
        page: 'home', width, height: Math.max(height, 90), rows: f.rows, allRows: f.rows,
      }).lines.join('\n'));
      assert.match(text, /── budget · this week ─/, `no budget block at ${width}`);
      // Inside the block every money figure is either an estimate carrying its
      // ≈ or money at a declared subscription rate, and the block says which.
      const rows = text.split('\n');
      const from = rows.findIndex((line) => /── budget · this week ─/.test(line));
      const to = rows.findIndex((line, index) => index > from && /^── /.test(line));
      const block = rows.slice(from, to < 0 ? rows.length : to).join('\n');
      const declared = block.includes('at the declared subscription price');
      for (const match of block.matchAll(/\$\s?[\d.]+/g)) {
        const before = block.slice(Math.max(0, match.index - 2), match.index);
        assert.ok(before.includes('≈') || declared,
          `the budget block at ${width} painted a bare ${match[0]} with no basis`);
      }
      // The reason is said once for the block, not once per pool row.
      const reasons = block.split('\n').filter((line) => /no declared subscription price/.test(line));
      assert.equal(reasons.length, 1, `the declare-a-price reason was repeated at ${width}`);
      assert.match(block, /bullswarm strategy set-subscription/,
        `the block at ${width} did not say how to declare a price`);
    }
  } finally { f.cleanup(); }
});

test('Run and Step draw no box-drawing panel at any of the three widths', () => {
  const f = fidelityModel();
  try {
    for (const [width, height] of FIDELITY_SIZES) {
      for (const page of ['run', 'step']) {
        for (const focus of page === 'run' ? [0, 1] : [2]) {
          const text = plain(renderDashboardPage(f.model, {
            page, width, height, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
            focus, phaseIndex: 0, agentIndex: 0,
          }).lines.join('\n'));
          for (const line of text.split('\n')) {
            assert.ok(!/^[┌│└]/.test(line) || !/[┐│┘]$/.test(line.trimEnd()),
              `${page} at ${width} kept a panel border: ${line}`);
          }
        }
      }
    }
    // Run carries the prototype's triptych, and Step its label/value table.
    const run = plain(renderDashboardPage(f.model, {
      page: 'run', width: 120, height: 40, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
    }).lines.join('\n'));
    // Run v2 rules 4, 5 and 7: the licence and `so far` blocks are gone; the
    // band is `live` and `spend`, two columns of one row at 120.
    assert.match(run, /── live ·? ?.*│ ── spend · /, 'the Run triptych is not one row band');
    assert.doesNotMatch(run, /── licence this run used ─/);
    assert.doesNotMatch(run, /── so far ─/);
    assert.match(run, /── plan · phase \d+ of \d+ ─/);
    assert.match(run, /── timeline · \d+ phases? · \d+ attempts?/);
    // And the ETA row, whose only content was a duration nobody measured, is
    // gone with it.
    assert.doesNotMatch(run, /no recorded duration yet/);
    const step = plain(renderDashboardPage(f.model, {
      page: 'step', width: 120, height: 40, rows: f.rows, allRows: f.rows, selectedRunId: 'wf-alpha',
      focus: 2, phaseIndex: 0, agentIndex: 0,
    }).lines.join('\n'));
    // The five blocks in their fixed order, and the header's own lines for the
    // route and the purpose.
    // Step v2 rule 1 and the block order: header, activity, result, task, cost.
    for (const section of ['activity · ', 'result · ', 'task · ', 'cost ─']) {
      assert.match(step, new RegExp(`── ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `Step lost its ${section} block`);
    }
    // Rule 1: line 1 is the verdict, line 2 the purpose, line 3 the route.
    assert.match(step, /^ ✓ scan · aaa111 · succeeded/m, 'Step lost its verdict line');
    assert.match(step, /^ Scan the viewer$/m, 'Step lost the action purpose');
    assert.match(step, /^ opencode2 · luna · —/m, 'Step lost its pool · model · effort route');
  } finally { f.cleanup(); }
});

test('Help groups the keys that share a purpose and names every key the shell runs', () => {
  const rendered = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 120, height: 90 });
  const whole = plain(rendered.lines.join('\n'));
  // Every binding the shell reads is named on the page.
  for (const name of Object.keys(DASHBOARD_KEYS)) {
    assert.ok(whole.includes(DASHBOARD_KEYS[name].keys), `help lost ${name} (${DASHBOARD_KEYS[name].keys})`);
  }
  // The page keys are one row, the way the prototype groups them. With
  // History merged into Runs and h rebound to Home, the pages row is r b s f
  // and h and ? get their own rows.
  assert.match(whole, /^ r b s f\s+Runs · Budget · Stats · Fleet$/m);
  assert.match(whole, /^ h\s+Home$/m);
  // `y` is a jump into Runs' history table now, not a page of its own.
  assert.match(whole, /^ y\s+Runs, at the first day of its history$/m);
  assert.match(whole, /^ \?\s+this help$/m);
  assert.match(whole, /^ ↑\/k ↓\/j\s+scroll one line$/m);
  // Budget has no sub-tabs, so the page does not say it has.
  assert.doesNotMatch(whole, /sub-tab[^\n]*Budget/);
  assert.match(whole, /next sub-tab on Stats and Fleet/);
  // And the page stays compact. Requirement 7 moved the agents and `run it`
  // blocks here from Runs, so the bound now covers 49 rows: the thirty the
  // page had, plus the two moved blocks.
  const body = renderDashboardPage(dashboardModel(null, {}), { page: 'help', width: 120, height: 90 });
  assert.ok(body.body.total <= 52, `help is ${body.body.total} rows`);
  assert.ok(body.body.total >= 25, `help is only ${body.body.total} rows`);
  assert.match(rendered.lines.join('\n'), /\x1b\[38;2;124;127;138m/, 'Help secondary copy uses the shared grey role');
});

test('`workflow tui --overview` keeps the two shapes the Claude mod pane parses', () => {
  const { home, cleanup } = fixture();
  try {
    const snapshot = overviewSnapshot(home, 'abc234', { width: 100, height: 30 });
    const text = snapshot.lines.join('\n');
    // parseOverview reads `── ` section rules and `HH:MM ` milestones, and
    // strips the box border; all three are still what this command prints.
    assert.ok(snapshot.lines.some((line) => /^┌/.test(line)), 'the overview lost its box');
    const inner = snapshot.lines.map((line) => line.replace(/^│/, '').replace(/│$/, ''));
    assert.ok(inner.some((line) => /^── /.test(line)), 'the overview lost its section rules');
    assert.ok(inner.some((line) => /^\d{2}:\d{2}\s/.test(line)), 'the overview lost its milestones');
    // The goal preview only the Run page dropped is still here.
    assert.ok(inner.some((line) => /goal accepted/.test(line)));
    assert.ok(inner.some((line) => /Audit every file autonomously\./.test(line)),
      'the overview lost the goal text the mod pane shows');
  } finally { cleanup(); }
});

// Desktop plans now use presentation-stage columns. A fan remains grouped by
// its dependency phases, but connectors only join neighbouring phase headers;
// no step-to-step branch drawing survives in the plan strip.
test('the plan keeps a fan grouped into its dependency phases without step connectors', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-fan-'));
  try {
    const startedAt = '2026-09-17T06:46:00.000Z';
    const document = createV2GoalDocument({
      goal: 'fan and join', cwd: tmpdir(),
      requirements: [{ id: 'requirement-1', text: 'Both halves land.', mandatory: true }],
      settings: { scout: false, executionMode: 'program' },
    });
    let state = createV2State(document, { runId: 'wf-fan', shortId: 'fan111' });
    const step = (id, dependsOn, extra = {}) => ({
      id, purpose: `${id} purpose`, dependsOn, affects: ['requirement-1'], ownedFiles: [`${id}.md`], prompt: `${id}.`,
      lane: 'build', effort: 'low', evidenceFor: [], inputs: dependsOn, produces: [id], ...extra,
    });
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Fan then join.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        step('design-map', []),
        step('stream-persist', ['design-map']),
        step('handoff-preamble', ['design-map']),
        step('integrate', ['stream-persist', 'handoff-preamble']),
        step('verify', ['integrate'], { affects: [], evidenceFor: ['requirement-1'], lane: 'analyze', ownedFiles: [], produces: [] }),
      ] },
    });
    state.lifecycle = { status: 'running', startedAt, finishedAt: null, resultFile: null };
    for (const action of state.actions.slice(0, 3)) Object.assign(action, { status: 'succeeded', startedAt, finishedAt: startedAt, attempts: 1 });
    Object.assign(state.actions[3], { status: 'running', startedAt, attempts: 1 });
    state.attempts = state.actions.slice(0, 4).map((action, index) => ({
      id: `${action.id}-1`, actionId: action.id, ordinal: 1, pool: 'codex', model: 'luna',
      status: index < 3 ? 'succeeded' : 'running', startedAt, finishedAt: index < 3 ? startedAt : null,
    }));
    state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
    const dir = join(home, 'workflows', 'wf-fan');
    mkdirSync(dir, { recursive: true });
    appendEvent(dir, state, 'action.started', { actionId: 'design-map' });
    appendEvent(dir, state, 'action.finished', { actionId: 'design-map', status: 'succeeded' });
    for (const id of ['stream-persist', 'handoff-preamble']) appendEvent(dir, state, 'action.started', { actionId: id });
    for (const id of ['stream-persist', 'handoff-preamble']) appendEvent(dir, state, 'action.finished', { actionId: id, status: 'succeeded' });
    appendEvent(dir, state, 'action.started', { actionId: 'integrate' });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    const rows = dashboardRows(home, { all: true });
    const model = dashboardModel(rows[0], { runs: rows, usage: usageFixture() });
    const frame = renderDashboardPage(model, { page: 'run', width: 120, height: 40, rows, allRows: rows, selectedRunId: 'wf-fan' });
    const text = frame.lines.map(plain);
    const liveAt = text.findIndex((line) => /── live[ ·]/.test(line));
    assert.ok(liveAt > 0, text.join('\n'));
    const plan = text.slice(0, liveAt).join('\n');
    // One compact box per dependency group, each with its status glyph, name
    // and — where the count says something — its done/total. The fan's two
    // branches are one phase, so the plan never draws a step-to-step branch
    // connector. Rule 2 names that level by its writer count rather than
    // calling it `Parallel work`.
    assert.match(plan, /\[✓ 1 design-map\]/);
    assert.match(plan, /\[✓ 2 two writers 2\/2\]/);
    assert.match(plan, /\[▶ 3 integrate 0\/1\]/);
    assert.match(plan, /\[○ 4 verify\]/);
    assert.doesNotMatch(plan, /┬|└|├|┘|┴/);
    // The full chronology below keeps one segment per phase, the shared one
    // included.
    assert.deepEqual(segmentLabels(frame.lines.join('\n')).slice(0, 4), [
      'Preflight', 'design-map', 'stream-persist · handoff-preamble', 'integrate',
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the Run plan draws one box per phase, flowing across the width and stacking narrow', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-plan-phases-'));
  try {
    const startedAt = '2026-09-18T08:00:00.000Z';
    const document = createV2GoalDocument({
      goal: 'seven presentation phases', cwd: home,
      requirements: [{ id: 'requirement-1', text: 'The phases render.' }],
      settings: { scout: false, executionMode: 'program' },
    });
    let state = createV2State(document, { runId: 'wf-phases', shortId: 'phase7' });
    const action = (id, dependsOn = []) => ({
      id, purpose: `${id} work`, dependsOn, affects: ['requirement-1'], ownedFiles: [`${id}.md`],
      prompt: `${id}.`, lane: 'build', effort: 'medium', evidenceFor: [], inputs: dependsOn, produces: [id],
    });
    const actions = [
      action('p1'), action('p2', ['p1']), action('p3-done', ['p2']), action('p3-run', ['p2']),
      action('p4', ['p3-done', 'p3-run']), action('p5', ['p4']), action('p6', ['p5']), action('p7', ['p6']),
    ];
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Seven phases.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
    });
    state.lifecycle = { status: 'running', startedAt, finishedAt: null, resultFile: null };
    for (const [index, runtime] of state.actions.entries()) {
      const running = runtime.id === 'p3-run';
      Object.assign(runtime, { status: running ? 'running' : index < 2 || runtime.id === 'p3-done' ? 'succeeded' : 'pending', startedAt, attempts: running || index < 3 ? 1 : 0 });
    }
    state.attempts = [
      { id: 'p3-done-1', actionId: 'p3-done', ordinal: 1, status: 'succeeded', pool: 'codex', model: 'gpt-5.6-luna', startedAt, finishedAt: iso(30), wallSec: 30 },
      { id: 'p3-run-1', actionId: 'p3-run', ordinal: 1, status: 'running', pool: 'codex', model: 'gpt-5.6-luna', startedAt, finishedAt: null, outputBytesObserved: 128 },
    ];
    state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
    const dir = join(home, 'workflows', 'wf-phases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const row = dashboardRows(home)[0];
    const nowMs = Date.parse(startedAt) + 9 * 60_000;
    const desktop = plain(renderWorkflowTui(row, {
      width: 120, height: 100, nowMs,
      usage: { assignments: [{ runId: 'wf-phases', actionId: 'p3-run', expectedMinutes: 12, startedAt }] },
    }));
    const planAt = desktop.indexOf('── plan · ');
    const plan = desktop.slice(planAt).split(/── live[ ·]/)[0];
    // One numbered box per phase, in phase order, each with a glyph, its
    // position and a name; the done/total follows only where it says
    // something. Boxes wrap between whole boxes.
    assert.deepEqual(
      [...plan.matchAll(/\[([✓▶○×·]) ([^\]]+)\]/g)].map((match) => `${match[1]} ${match[2]}`),
      ['✓ 1 p1', '✓ 2 p2', '▶ 3 two writers 1/2', '○ 4 p4', '○ 5 p5', '○ 6 p6', '○ 7 p7'],
    );
    // No per-step rows and no branch connectors survive in the compact plan:
    // rule 2 names a level phase inside its own box, and nothing is drawn
    // under the boxes.
    assert.doesNotMatch(plan, /┬|└|├|┘/, plan);
    assert.deepEqual(
      plan.split('\n').filter((line) => /p3-run|p3-done/.test(line) && !line.includes('[')),
      [],
      plan,
    );
    // The running worker is named by the live band, which carries its clock.
    assert.match(desktop, /── live · p3-run · codex · /);
    assert.match(desktop, /▶ p3-run · codex · gpt-5\.6-luna · — · running/);

    const narrow = plain(renderWorkflowTui(row, {
      width: 55, height: 100, nowMs,
      usage: { assignments: [{ runId: 'wf-phases', actionId: 'p3-run', expectedMinutes: 12, startedAt }] },
    }));
    // Rule 2: at 55 columns the thirteen boxes become one glyph strip naming
    // the running phase and the next one; `p` opens the boxes, and there they
    // stack one per row in the same order.
    assert.match(narrow, /^ plan  [✓▶○]+  3 two writers running · then p4$/m);
    assert.doesNotMatch(narrow.slice(narrow.indexOf(' plan  ')).split(/── (?:live|last finished)[ ·]/)[0], /\[/);
    const narrowBoxesFrame = plain(renderDashboardPage(
      dashboardModel(row, { runs: [row] }),
      { page: 'run', width: 55, height: 100, nowMs, planBoxes: true, rows: [row], allRows: [row], selectedRunId: row.runId },
    ).lines.join('\n'));
    const narrowPlan = narrowBoxesFrame.split(/── (?:live|last finished)[ ·]/)[0];
    const narrowBoxes = [...narrowPlan.matchAll(/\[([✓▶○×·]) ([^\]]+)\]/g)];
    assert.deepEqual(narrowBoxes.map((match) => match[1]), ['✓', '✓', '▶', '○', '○', '○', '○']);
    for (const match of narrowBoxes) {
      assert.equal(plain(narrowPlan.split('\n').find((line) => line.includes(match[0])) ?? '').includes('] ['), false,
        `two boxes shared a row at 55: ${match[0]}`);
    }
    assert.match(narrow, /── live · p3-run · codex/);
    assert.match(narrow, /▶ p3-run · codex · running/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Home today lists only pools that worked today', () => {
  const nowMs = Date.parse('2026-09-18T12:00:00.000Z');
  const rollups = [{
    schemaVersion: 'bullswarm.workflow.rollup.v1', runId: 'wf-today', shortId: 'today1',
    startedAt: new Date(nowMs - 4 * 60_000).toISOString(), finishedAt: new Date(nowMs - 1 * 60_000).toISOString(),
    status: 'completed', verified: true, requirements: { passed: 1, total: 1 },
    minutes: { wall: 3, agent: 4 },
    pools: { 'worked-low': { attempts: 1, minutes: 4, costUsd: null, tokens: null } },
    models: { luna: { attempts: 1, minutes: 4 } }, legacy: false,
  }];
  const usage = { pools: [
    { name: 'idle-high', enabled: true, usedPct: 90, elapsedPct: 50 },
    { name: 'worked-low', enabled: true, usedPct: 10, elapsedPct: 50 },
    { name: 'idle-mid', enabled: true, usedPct: 50, elapsedPct: 50 },
  ], assignments: [], rungs: [] };
  const model = dashboardModel(null, { usage, rollups, nowMs });
  const text = plain(renderDashboardPage(model, { page: 'home', width: 120, height: 70, nowMs }).lines.join('\n'));
  // The licence table counts the pools with measured work today; the metered
  // pools that did nothing keep their meters in the budget block below it.
  const block = text.split('── licences · today')[1].split('── running')[0];
  assert.match(block, / worked-low +4\.0\b/, block);
  assert.doesNotMatch(block, /idle-high|idle-mid/);
});

test('Home today matches the approved 55/120 cards with a licence row per pool', () => {
  const nowMs = Date.parse('2026-09-18T12:00:00.000Z');
  const workflows = [
    {
      runId: 'wf-today-1', shortId: 'today1', project: 'bulldemo', goal: 'First today goal',
      startedAt: '2026-09-18T00:00:00.000Z', finishedAt: '2026-09-18T01:00:00.000Z',
      status: 'completed', verified: false, minutes: { wall: 104.9 },
      pools: { acme: { attempts: 1, minutes: 84, costUsd: 0.16 } },
    },
    {
      runId: 'wf-today-2', shortId: 'today2', project: 'bullswarm', goal: 'Second today goal',
      startedAt: '2026-09-18T01:00:00.000Z', finishedAt: '2026-09-18T02:00:00.000Z',
      status: 'completed', verified: false, minutes: { wall: 208.2 },
      pools: { codex: { attempts: 1, minutes: 161.8, costUsd: 0.03 }, grok: { attempts: 1, minutes: 26, costUsd: 0.01 } },
    },
    {
      runId: 'wf-today-3', shortId: 'today3', project: 'bulldemo', goal: 'Third today goal',
      startedAt: '2026-09-18T02:00:00.000Z', finishedAt: '2026-09-18T03:00:00.000Z',
      status: 'completed', verified: true, minutes: { wall: 542.7 },
      pools: { opencode: { attempts: 1, minutes: 634.6, costUsd: null } },
    },
  ];
  const task = {
    id: 'task1', project: 'bullswarm', pool: 'codex', model: 'gpt-5.6-luna',
    startedAt: '2026-09-18T04:00:00.000Z', endedAt: '2026-09-18T05:00:00.000Z',
    durationMs: 60 * 60 * 1000, ok: true,
  };
  const usage = {
    pools: [
      { name: 'acme', spend: { pacing: { ratePerMinute: 0.0345 } } },
      { name: 'codex', spend: { pacing: { ratePerMinute: 0.013 } } },
      { name: 'grok', spend: { pacing: { ratePerMinute: 0.165 } } },
      { name: 'opencode' },
    ],
  };
  const model = dashboardModel(null, {
    nowMs, rollups: workflows, usage, tasks: { finished: [task], inflight: [] },
    days: [{ date: '2026-09-18', rows: [...workflows, { ...task, kind: 'task' }] }],
  });

  for (const width of [55, 120]) {
    const frame = renderDashboardPage(model, { page: 'home', width, height: 40, nowMs });
    const lines = frame.lines.map(plain);
    const start = lines.findIndex((line) => line.startsWith('Home · Today'));
    const end = lines.findIndex((line, index) => index > start && line.startsWith('── running'));
    assert.ok(start >= 0 && end > start, `${width}: today band missing`);
    const band = lines.slice(start, end).filter((line) => line.trim());

    // Three cards, most recently finished first, each with project · status ·
    // verdict, active minutes, steps and the strict money pair. A finished
    // task is not a card: its row lives on Runs.
    // Three boxes, stacked: in the left half at 120, full width at 55.
    assert.equal((band.join('\n').match(/┌─ /g) ?? []).length, 3, band.join('\n'));
    assert.ok(band.every((line) => (line.match(/┌─ /g) ?? []).length <= 1), band.join('\n'));
    assert.match(band.join('\n'), /bulldemo · completed · verified/);
    assert.match(band.join('\n'), /bullswarm · completed · not verifi/);
    assert.match(band.join('\n'), /API — · subscription —/);
    assert.match(band.join('\n'), /API ~ \$0\.16 · subscription —/);
    assert.doesNotMatch(band.join('\n'), /task1/);

    // The licence table is one row per pool that worked today, in the order
    // the pools are named, under one header row that carries the units.
    const table = band.join('\n');
    assert.match(table, /── licences · today/);
    assert.match(table, / pool +agent min +weekly quota +API \$/, table);
    // The share is the pool's own measured rate times today's worker-minutes:
    // a pace estimate, marked `≈`, beside its bar. A pre-0.35.2 entry carries
    // no coverage counts, so its whole amount stays unqualified rather than
    // reading as a lower bound the records never claimed.
    assert.match(table, / acme +84\.0 +[▏▇░]+ +≈2\.9% +~0\.16\b/, table);
    assert.match(table, / codex +161\.8 +[▏▇░]+ +≈2\.1% +~0\.03\b/, table);
    assert.match(table, / grok +26\.0 +[▏▇░]+ +≈4\.3% +~0\.01\b/, table);
    assert.match(table, / opencode +634\.6 +— +—/, table);
    const order = ['acme', 'codex', 'grok', 'opencode'].map((name) => band.findIndex((line) => new RegExp(` ${name} +\\d`).test(line)));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${width}: pools out of order`);
    if (width === 120) {
      assert.match(band.join('\n'), /First today goal/);
      assert.match(band.join('\n'), /Second today goal/);
      assert.match(band.join('\n'), /Third today goal/);
    }
  }
});

test('Runs and Home show single-task ledger rows, and Enter opens task detail', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-dashboard-tasks-'));
  try {
    mkdirSync(join(home, 'assignments'), { recursive: true });
    // Relative to now, not a pinned date: "today" is what the band filters on,
    // so a hard-coded day made this test pass only on the day it was written.
    const taskEnded = new Date(Date.now() - 5 * 60_000);
    const taskStarted = new Date(taskEnded.getTime() - 125_000);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ decisionLog: [{
      kind: 'run', source: 'run', id: 'finished-task', lane: 'analyze', pool: 'echo', model: 'echo-local',
      project: 'bullswarm', taskFile: '/tmp/task-finished.md', outFile: '/tmp/out-finished.md',
      ok: false, reason: 'short failure', startedAt: taskStarted.toISOString(), endedAt: taskEnded.toISOString(), durationMs: 125000,
    }] }));
    writeFileSync(join(home, 'assignments', 'live-task.json'), JSON.stringify({
      id: 'live-task', source: 'run', lane: 'build', pool: 'echo', model: 'echo-local', project: 'bullswarm',
      taskFile: '/tmp/task-live.md', outFile: '/tmp/out-live.md', startedAt: new Date(Date.now() - 60_000).toISOString(),
      kernelPid: process.pid, workerPid: null,
    }));
    const session = shellSession(home, { columns: 80, rows: 30 });
    const homeText = plain(lastFrame(session.output));
    // Home leads with the finished task's own card and keeps the live task in
    // its running band.
    assert.match(homeText, /Home · Today · \d+ Sep · top 1 runs/);
    assert.match(homeText, /live-task/);
    const runs = session.press('r');
    assert.match(plain(runs), /hed-task/);
    assert.match(plain(runs), /ive-task/);
    assert.doesNotMatch(runs, /⚙/, 'tasks use the same result glyphs as workflows');
    assert.match(plain(runs), /0 runs · 1 task/, 'the day header counts the task apart from the workflows');
    const task = session.press('\r');
    // Enter opens the task through the same Step model and view: the five
    // blocks, the header and the same keys.
    // Requirement 5: a single task renders through the same Step header —
    // identity, short id, verdict — so the retired `Step ` prefix is gone.
    assert.match(frameHeader(task), /^ [●✓✗] build task · (?:live-task|finished-task) · /);
    // Step v2's blocks, on a live task: `now` stands in for the result that
    // does not exist yet (rule 11), then activity, task and cost.
    assert.match(plain(task), /── now · /);
    assert.match(plain(task), /── activity · /);
    assert.match(plain(task), /── task · /);
    assert.match(plain(task), /── cost ─/);
    assert.match(plain(task), /v detail/);
    const back = session.press(ESC_KEY);
    assert.match(frameHeader(back), /^ bullswarm · runs ·/);
    assert.equal(await session.quit(), 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Enter on a Home today workflow row opens that run', async () => {
  const { home, cleanup } = shellFixture();
  try {
    const session = shellSession(home, { columns: 55, rows: 30 });
    const before = plain(lastFrame(session.output));
    // The Today band is the three cards; the cursor starts on the first one
    // and Enter opens that run on the Run page.
    assert.match(before, /Home · Today · \d+ Sep · top 3 runs/);
    assert.match(before, /unified-shell/);
    const run = session.press('\r');
    assert.match(frameHeader(run), /^ [●✓✗] (?:aaa111|bbb222|zzz999) · /);
    assert.match(frameHeader(run), /running|completed/);
    // Esc comes back to Home with the band intact.
    session.press(ESC_KEY);
    assert.match(frameHeader(lastFrame(session.output)), /^ bullswarm · home/);
    assert.match(plain(lastFrame(session.output)), /Home · Today · \d+ Sep · top 3 runs/);
    assert.equal(await session.quit(), 0);
  } finally { cleanup(); }
});

test('Run draws durable output sparklines and neither page cuts a pool identity', () => {
  const { home, cleanup } = shellFixture();
  try {
    const dir = join(home, 'workflows', 'wf-alpha');
    const statePath = join(dir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const attempt = state.attempts.find((entry) => entry.status === 'running');
    attempt.pool = 'opencode-very-long-pool-name';
    attempt.outputSamples = [[Date.parse(attempt.startedAt), 0], [Date.parse(attempt.startedAt) + 1000, 1024], [Date.parse(attempt.startedAt) + 2000, 2048]];
    writeFileSync(statePath, JSON.stringify(state));
    const row = dashboardRows(home, { all: true }).find((entry) => entry.runId === 'wf-alpha');
    const model = dashboardModel(row, { runs: [row], usage: usageFixture() });
    const activePhase = workflowPanelModel(row).phases.findIndex((phase) =>
      phase.actions.some((action) => action.status === 'running'));
    const activeAgent = workflowPanelModel(row, { phaseIndex: activePhase }).agents
      .findIndex((agent) => agent.status === 'running');
    for (const width of [55, 120]) {
      const run = plain(renderDashboardPage(model, { page: 'run', width, height: 50, selectedRunId: 'wf-alpha' }).lines.join('\n'));
      // The live band draws the durable output sparkline beside the clock; the
      // three-column band clips its tail on the desktop, so only its start is
      // asserted there.
      // Run v2 rule 3 replaced the live rows' byte sparkline with the turn you
      // would watch, so the block names the step and its route and says when
      // no stream was kept rather than drawing an output trace.
      assert.doesNotMatch(run, /▁▅█|· output ▁/);
      assert.match(run, /── live · build-alpha · opencode-very/);
      // The pool is an identity: the timeline row keeps it whole, and the
      // phone, whose live rule has the room, keeps it whole there too.
      if (width === 55) assert.match(run, /── live · build-alpha · opencode-very-long-pool-name/);
      else assert.match(run, /▶ build-alpha · opencode-very-long-pool-name/);
      assert.doesNotMatch(run, /openc…/, `${width}: pool was cut in the plan/live rows`);
      const step = plain(renderDashboardPage(model, {
        page: 'step', width, height: 50, selectedRunId: 'wf-alpha', phaseIndex: activePhase, agentIndex: activeAgent,
      }).lines.join('\n'));
      // The Step page keeps the full pool identity too; its result block is
      // about the output content, which this attempt never wrote.
      assert.match(step, /opencode-very-long-pool-name/);
      assert.doesNotMatch(step, /openc…/, `${width}: pool was cut on the Step page`);
      // Step v2 rule 11: a running attempt leads with `now` on the phone and
      // says the result is `not yet` on the desk, instead of calling its
      // output unavailable.
      assert.match(step, width === 55 ? /── now · 0 events · /: /── result · not yet ─/);
      assert.match(step, width === 55 ? /no captured event yet/ : /attempt 1 running · 0 events so far/);
    }
  } finally { cleanup(); }
});

test('a task with no recorded id is listed and counted once, not once per source', async () => {
  // Observed on the owner's real home (2026-09-18): every finished task
  // appeared twice on the Runs day table and twice in Home's today band, and
  // the day header read `6 tasks` for three of them. Tasks arrive from two
  // places at once — historyDays already pushes them into `days[].rows`, and
  // the dashboard merges `tasks.finished` again — and a `bullswarm run`
  // recorded before the single-task ledger has neither `id` nor `taskFile`,
  // so the id-only dedupe matched nothing.
  const nowMs = Date.parse('2026-09-18T12:00:00.000Z');
  const legacy = {
    lane: 'build', pool: 'codex', model: 'gpt-5.6-luna', project: null,
    startedAt: null, taskFile: null, outFile: null,
    endedAt: '2026-09-18T03:05:07.960Z', ok: true, reason: null, durationMs: 60 * 60 * 1000,
  };
  const model = dashboardModel(null, {
    nowMs,
    rollups: [],
    usage: { pools: [{ name: 'codex' }] },
    tasks: { finished: [legacy], inflight: [] },
    // The same row the history index already placed on the day.
    days: [{ date: '2026-09-18', runs: 0, finished: 0, verified: 0, rows: [{ ...legacy, kind: 'task' }] }],
  });

  const runs = renderDashboardPage(model, { page: 'runs', width: 120, height: 40, nowMs });
  const runLines = runs.lines.map(plain);
  const taskRows = runLines.filter((line) => /✓ —\s+—\s+build task on codex\s+task\s+1h00m\s+—\s+\d{2}:\d{2}/.test(line));
  assert.equal(taskRows.length, 1, `task listed ${taskRows.length} times:\n${runLines.join('\n')}`);
  const header = runLines.find((line) => /Fri 18 Sep/.test(line));
  assert.ok(header, 'the day header is missing');
  assert.match(header, /\b1 task\b/);

  // Home's cards are runs, so the same task is not painted there as well; it
  // is never counted twice there either.
  const home = renderDashboardPage(model, { page: 'home', width: 120, height: 40, nowMs });
  const homeLines = home.lines.map(plain);
  assert.equal(homeLines.filter((line) => /⚙ task\b/.test(line)).length, 0, homeLines.join('\n'));
  assert.doesNotMatch(homeLines.join('\n'), /\d task\b/);
});

// The scrubbed in-repo home holds g6d6q2: twelve phases, finished, so phases
// 3–9 sit behind the timeline's fold line. The dashboard reads a copy of it.
const REAL_RUN_HOME = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
const FOLD_RUN = 'wf-mu6mv62z-cdcd5d';

function foldFixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-fold-'));
  cpSync(REAL_RUN_HOME, home, { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const timelineRows = (screen) => paintedRows(screen).filter((row) => /^ ?(── |\d{2}:\d{2}  |phases \d|click to )/.test(row));
const FOLD_LINE = 'phases 3–9 · 7 steps · 2h39m · 1 ✗ · click to expand';

// Run gbnq62 ran `verify` three times. An attempt row opens that attempt;
// the phase rule, which names no attempt, still opens the latest.
for (const columns of [55, 200]) {
  test(`a Run timeline attempt row opens its own attempt on the Step page at ${columns} columns`, async () => {
    const { home, cleanup } = foldFixture();
    try {
      const open = (needle) => {
        const session = shellSession(home, { token: 'wf-mu8j2hjn-58b8ec', columns, rows: 120 });
        clickOn(session, needle);
        return session;
      };
      const first = open('verify · grok');
      const firstHeader = paintedRows(lastFrame(first.output)).slice(0, 6).join('\n');
      assert.match(firstHeader, /✓ verify · gbnq62/);
      assert.match(firstHeader, /^ grok · grok-4\.6 · high/m);
      if (columns >= 100) assert.match(firstHeader, /attempt 1 of 3/);
      assert.equal(await first.quit(), 0);

      const rule = open('Phase 7 · Verify · verify');
      const ruleHeader = paintedRows(lastFrame(rule.output)).slice(0, 6).join('\n');
      assert.match(ruleHeader, /^ claude-code · claude-opus-5 · high/m);
      if (columns >= 100) assert.match(ruleHeader, /attempt 3 of 3/);
      assert.equal(await rule.quit(), 0);
    } finally { cleanup(); }
  });
}

for (const columns of [55, 200]) {
  for (const how of ['click', 'Enter']) {
    test(`the Run timeline's fold line opens and closes on a ${how} at ${columns} columns`, async () => {
      const { home, cleanup } = foldFixture();
      try {
        const session = shellSession(home, { token: FOLD_RUN, columns, rows: 90 });
        const folded = paintedRows(lastFrame(session.output));
        assert.ok(folded.some((row) => row.trimEnd() === FOLD_LINE), `the fold line is painted:\n${folded.join('\n')}`);
        assert.ok(!folded.some((row) => row.includes('click to fold')));
        assert.ok(!folded.some((row) => row.includes('Phase 4 · Build · e2e')), 'phase 4 is folded away');
        const foldedRules = folded.filter((row) => row.startsWith('── ✓ ')).length;

        if (how === 'click') clickOn(session, 'click to expand');
        else {
          // The cursor starts on phase 1 and Down walks it into the phases
          // the fold hides (on the phone it starts before Preflight: Preflight, 1, 2, then the fold
          // line). The fold line is then the row the cursor is on, drawn
          // inverse, and Enter opens it.
          for (let index = 0; index < (columns >= 100 ? 2 : 4); index += 1) session.press('\x1b[B');
          const onFold = lastFrame(session.output).split('\n').find((row) => plain(row).includes('click to expand'));
          assert.match(onFold, /\x1b\[7m/, 'the cursor is drawn on the fold line');
          session.press('\r');
        }
        const open = paintedRows(lastFrame(session.output));
        assert.ok(!open.some((row) => row.includes('click to expand')), 'the fold line is gone once open');
        assert.ok(open.some((row) => row.includes('Phase 4 · Build · e2e')), `phase 4 is back in place:\n${open.join('\n')}`);
        assert.ok(open.filter((row) => row.startsWith('── ✓ ')).length > foldedRules, 'the phase rules the fold hid are printed');
        const closing = open.findIndex((row) => row.trimEnd() === 'click to fold');
        assert.ok(closing > 0, 'one `click to fold` line closes the block');
        assert.ok(open[closing - 1].includes('ship-drag'), 'the block closes right after phase 9, the last phase it opened');
        assert.equal(open.filter((row) => row.includes('click to fold')).length, 1);

        if (how === 'click') clickOn(session, 'click to fold');
        else {
          // Enter opened the fold, so the cursor stays on the line it used.
          const onClose = lastFrame(session.output).split('\n').find((row) => plain(row).includes('click to fold'));
          assert.match(onClose, /\x1b\[7m/, 'the cursor is drawn on the `click to fold` line');
          session.press('\r');
        }
        const closed = paintedRows(lastFrame(session.output));
        assert.ok(closed.some((row) => row.trimEnd() === FOLD_LINE), 'folded again');
        assert.ok(!closed.some((row) => row.includes('click to fold') || row.includes('Phase 4 · Build · e2e')));
        assert.equal(await session.quit(), 0);
      } finally { cleanup(); }
    });
  }
}

/**
 * The screen a terminal shows for the bytes the dashboard wrote, under
 * Ghostty's rules for the two things that matter here: a character printed
 * into the last column leaves the cursor on that cell with a wrap pending,
 * and an erase to the end of the line starts at the cursor's own cell
 * (ghostty src/terminal/Terminal.zig, print and eraseLine). `\n` is a new
 * line, as the tty's output translation makes it.
 */
function ghosttyScreen(text, columns, rows) {
  const screen = Array.from({ length: rows }, () => Array(columns).fill(' '));
  let x = 0;
  let y = 0;
  let pending = false;
  for (let at = 0; at < text.length;) {
    if (text[at] === '\x1b') {
      const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(at, at + 32));
      if (!csi) { at += 1; continue; }
      const [all, params, final] = csi;
      if (final === 'H') {
        const [row, column] = params.split(';').map(Number);
        y = Math.max(0, (row || 1) - 1);
        x = Math.max(0, (column || 1) - 1);
        pending = false;
      } else if (final === 'K' && !params) {
        for (let column = x; column < columns; column += 1) screen[y][column] = ' ';
        pending = false;
      } else if (final === 'J' && params === '2') {
        for (const line of screen) line.fill(' ');
      }
      at += all.length;
      continue;
    }
    if (text[at] === '\n' || text[at] === '\r') {
      if (text[at] === '\n') y = Math.min(rows - 1, y + 1);
      x = 0;
      pending = false;
      at += 1;
      continue;
    }
    const glyph = String.fromCodePoint(text.codePointAt(at));
    if (pending) { x = 0; y = Math.min(rows - 1, y + 1); pending = false; }
    screen[y][x] = glyph;
    if (x === columns - 1) pending = true;
    else x += 1;
    at += glyph.length;
  }
  return screen.map((line) => line.join('').trimEnd());
}

// The owner read Home in Ghostty at 199–200 columns: every row that filled
// the terminal lost its last cell (`40` for `40%`, a single-digit count gone),
// because the painter erased the rest of each row after painting it.
for (const columns of [199, 200]) {
  test(`Home at ${columns} columns reaches a terminal whose erase starts at the cursor with every last cell intact`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00.000Z') });
    const { home, cleanup } = foldFixture();
    try {
      const session = shellSession(home, { columns, rows: 55 });
      const painted = paintedRows(lastFrame(session.output)).map((row) => row.trimEnd());
      const shown = ghosttyScreen(session.output.text, columns, 55);
      const full = painted.filter((row) => [...row].length === columns);
      assert.ok(full.some((row) => /[▇░] +\d+%$/.test(row)), `no by-pool row fills the page:\n${painted.join('\n')}`);
      assert.ok(full.some((row) => /[▇░] +\d$/.test(row)), 'no single-digit count ends a row');
      assert.deepEqual(shown, painted, 'the terminal shows something other than what was painted');
      assert.equal(await session.quit(), 0);
    } finally { cleanup(); }
  });
}

/** The body row the Runs cursor is drawn on: its 1-based screen row and text. */
function cursorRow(screen) {
  const raw = String(screen).split('\n');
  if (plain(raw[0] ?? '') === '') raw.shift();
  const at = raw.findIndex((row, index) => index >= 2 && index < raw.length - 1 && row.includes('\x1b[7m'));
  return at < 0 ? null : { y: at + 1, text: plain(raw[at]).trimEnd() };
}

/** The Runs cursor row's raw escapes, for checks on how the bar is painted. */
function cursorRaw(screen) {
  const raw = String(screen).split('\n');
  if (plain(raw[0] ?? '') === '') raw.shift();
  return raw.find((row, index) => index >= 2 && index < raw.length - 1 && row.includes('\x1b[7m')) ?? '';
}

// The owner's Runs page (0.35.2): on a day where single tasks sit between
// workflow rows, Enter on the workflow row under the cursor opened a task.
// Tasks recorded before the single-task ledger have no id, their rows were
// keyed `null`, and `null` is also "no task selected". The scrubbed home's
// Sat 19 Sep is that day: workflows qvh8e2 and 7e4w3i, seven tasks around
// them, four of those with no id.
for (const columns of [55, 200]) {
  test(`Runs: Enter and a click on each row of a day mixing workflows and tasks open that row's own item at ${columns} columns`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00.000Z') });
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Hong_Kong';
    const { home, cleanup } = foldFixture();
    try {
      const hhmm = (at) => {
        const date = new Date(at);
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      };
      const saturday = listTasks({ home, now: Date.now() }).finished
        .filter((task) => new Date(task.endedAt).getDate() === 19);
      /** What a row must open: the page's header, and for a task with no id the duration only it has. */
      const anonymous = saturday.filter((entry) => entry.id == null)
        .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
      const expected = (text, anonymousOrdinal = 0) => {
        const run = text.match(/^ ✓ ([a-z0-9]{6}) /);
        if (run) return { kind: 'run', header: new RegExp(`^ ✓ ${run[1]} · completed · `) };
        const task = text.match(/^ [✓✗] +(\S+)/);
        assert.ok(task, `not a run or task row: ${text}`);
        const [, id] = task;
        const record = id === '—'
          ? anonymous[anonymousOrdinal]
          : saturday.find((entry) => entry.id != null && String(entry.id).endsWith(id));
        assert.ok(record, `no ledger task matches ${id}`);
        const rowId = record.id == null ? '—' : String(record.id).slice(-8);
        assert.equal(id, rowId, `${text}: the row's id is not the ledger's`);
        const detailId = record.id == null ? 'task' : String(record.id).length > 14 ? String(record.id).slice(-8) : record.id;
        return { kind: 'task', header: new RegExp(`^ ✓ ${record.lane} task · ${detailId} · succeeded`), duration: record.id == null ? stepClockText(record.durationMs) : null };
      };
      const check = (screen, want, how) => {
        assert.match(frameHeader(screen), want.header, `${how}: opened the wrong item`);
        if (want.duration) assert.ok(paintedRows(screen)[2].includes(want.duration), `${how}: not the task that ran ${want.duration}\n${paintedRows(screen)[2]}`);
      };
      const session = shellSession(home, { columns, rows: 120 });
      const runs = session.press('r');
      const rows = paintedRows(runs);
      const start = rows.findIndex((row) => row.startsWith('── Sat 19 Sep'));
      const end = rows.findIndex((row, index) => index > start && row.startsWith('── '));
      const day = rows.slice(start + 1, end)
        .map((text, index) => ({ y: start + index + 2, text: text.trimEnd() }))
        .filter((row) => /^ [✓✗] /.test(row.text));
      assert.deepEqual(day.map((row) => row.text.match(/^ [✓✗] +(\S+)/)[1]), [
        'qvh8e2', 'c71e896e', '6a4e8085', 'a9e254cc',
        '—', '—', '—', '7e4w3i', '—',
      ]);

      // A click opens the row it lands on.
      for (const [index, row] of day.entries()) {
        const anonymousOrdinal = day.slice(0, index).filter((entry) => /^ [✓✗] +—\s/.test(entry.text)).length;
        const want = expected(row.text, anonymousOrdinal);
        session.press(`\x1b[<0;5;${row.y}M`);
        check(lastFrame(session.output), want, `click on ${row.text}`);
        session.press(ESC_KEY);
        session.press('r');
      }

      // Enter opens the row the cursor is drawn on: walk it down the list.
      let screen = lastFrame(session.output);
      for (const [index, row] of day.entries()) {
        const anonymousOrdinal = day.slice(0, index).filter((entry) => /^ [✓✗] +—\s/.test(entry.text)).length;
        const want = expected(row.text, anonymousOrdinal);
        for (let step = 0; step < 80 && cursorRow(screen)?.y !== row.y; step += 1) screen = session.press('\x1b[B');
        assert.deepEqual(cursorRow(screen), row, `the cursor never reached ${row.text}`);
        // Reverse video turns a cell's text colour into its background: past
        // the status glyph, a coloured or dim cell would be a band in the bar.
        const bar = cursorRaw(screen);
        assert.ok((bar.match(/\x1b\[38;/g) ?? []).length <= 1 && !/\x1b\[2m/.test(bar), `the cursor bar has coloured cells: ${JSON.stringify(bar)}`);
        check(session.press('\r'), want, `Enter on ${row.text}`);
        // Out again: a task returns to Runs with the cursor where it was; a
        // run returns to Home, and Runs opens on its first row.
        session.press(ESC_KEY);
        screen = want.kind === 'run' ? session.press('r') : lastFrame(session.output);
        if (want.kind === 'task') assert.deepEqual(cursorRow(screen), row, `Esc lost the cursor on ${row.text}`);
      }
      assert.equal(await session.quit(), 0);
    } finally {
      cleanup();
      if (tz == null) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
}
