// v3 runs on the dashboard (0.37.0, wave E): phases as groups, gates and loops
// as rows of their own, each attempt's checked answer, a waiting run's
// command, and a one-step run without an empty phase frame. The fixtures are
// two real runs made on grok (tests/fixtures/v3-runs):
//   2fne62 — phases research / writing / publish; loop `polish` (write, check)
//            passed in round 2 of 3 on check's evidence; gate `approve` left
//            waiting; each `count` and `check` attempt has a checked answer.
//   5r8jyi — `bullswarm run --answer-schema`: one step, answer {"words":13}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../src/workflow/events.js';
import { isOneStepRun, v3Stages } from '../src/workflow/v3-phases.js';
import { attemptAnswerFact, attemptRounds, controlRows, controlRowsByStage, waitingFacts } from '../src/workflow/v3-display.js';
import { projectV2DependencyStages } from '../src/workflow/v2-presentation.js';
import { workflowPanelModel } from '../src/workflow/run-model.js';
import { runPage, workflowTimelineLines } from '../src/workflow/run-view.js';
import { runTableLines } from '../src/workflow/history-view.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';
import { renderWorkflowOverviewPanel } from '../src/workflow/run-view.js';
import { isOneStepRecord, runCountText } from '../src/workflow/run-counts.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(ANSI, '');
const NOW = Date.parse('2026-09-28T17:40:00.000Z');
const home = fileURLToPath(new URL('./fixtures/v3-runs/', import.meta.url));
const GATED = join(home, 'wf-mulitifp-c82a30');
const SINGLE = join(home, 'wf-mulitn5f-6c56dd');

function realRow(runDir) {
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const resultFile = join(runDir, 'result.json');
  return {
    runId: state.runId, shortId: state.shortId, runDir, status: state.lifecycle.status, state,
    report: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null,
    events: readEvents(runDir), assignments: [], pools: [], liveness: { alive: false, reason: 'durable record' },
  };
}

function bodyBuilder() {
  const body = {
    lines: [], regions: [],
    push(text = '') { body.lines.push(text); return body; },
    row(text = '', action = null) {
      body.lines.push(text);
      if (action) body.regions.push({ x1: 1, x2: Math.max(1, visible(text).length), y: body.lines.length, action });
      return body;
    },
    parts(parts) {
      body.lines.push((parts ?? []).map((part) => String(part?.text ?? '')).join(''));
      return body;
    },
  };
  return body;
}

function runPageText(row, width) {
  const body = bodyBuilder();
  const header = runPage({ row, assignments: [], pools: [] }, {
    width, bodyHeight: 80, narrow: width < 100, nowMs: NOW, spinnerFrame: 0, focus: 0,
  }, body);
  return [header, ...body.lines].map(visible).join('\n');
}

test('a v3 run groups its steps by their declared phase, reading gates and loops as levels', () => {
  const { state } = realRow(GATED);
  const stages = v3Stages(state);
  assert.deepEqual(stages.map((stage) => [stage.label, stage.actionIds]), [
    ['Phase 1 · research', ['count']],
    ['Phase 2 · writing', ['write', 'check']],
    ['Phase 3 · publish', ['post']],
  ]);
  // The watch and the Run page read the same projection.
  assert.deepEqual(projectV2DependencyStages(state).map((stage) => stage.label), stages.map((stage) => stage.label));
  assert.equal(isOneStepRun(state), false);
  assert.equal(isOneStepRun(realRow(SINGLE).state), true);
});

test('v3 steps without a phase group by level, a step behind a gate one level later', () => {
  const { state } = realRow(GATED);
  const copy = structuredClone(state);
  for (const action of copy.program.actions) delete action.phase;
  assert.deepEqual(v3Stages(copy).map((stage) => [stage.label, stage.actionIds]), [
    ['Phase 1 · count', ['count']],
    ['Phase 2 · write', ['write']],
    ['Phase 3 · check', ['check']],
    ['Phase 4 · post', ['post']],
  ]);
});

test('gates and loops are rows placed in the phase they head or close', () => {
  const { state } = realRow(GATED);
  const rows = controlRows(state);
  const loop = rows.find((row) => row.id === 'polish');
  const gate = rows.find((row) => row.id === 'approve');
  assert.equal(loop.text, "loop polish · passed in round 2 of 3 · check's evidence passed");
  assert.equal(gate.text, 'gate approve · waiting for you · Read NOTE.md and decide whether to write DONE.md');
  assert.equal(gate.command, 'bullswarm workflow continue 2fne62 approve');
  const placed = controlRowsByStage(state, v3Stages(state));
  const [research, writing, publish] = v3Stages(state).map((stage) => placed.get(stage.id));
  assert.deepEqual(research, { before: [], after: [] });
  assert.deepEqual(writing.before.map((row) => row.id), ['polish']);
  assert.deepEqual(publish.before.map((row) => row.id), ['approve']);

  // Other states of the same nodes, in the same words.
  const other = structuredClone(state);
  other.controlNodes = [
    { id: 'polish', type: 'loop', status: 'waiting', at: null, round: 3, maxRounds: 3, reason: 'out-of-rounds' },
    { id: 'approve', type: 'gate', status: 'passed', at: null, reason: 'continued' },
  ];
  const [otherLoop, otherGate] = controlRows(other);
  assert.equal(otherLoop.text, "loop polish · out of rounds (3 of 3) · check's evidence passed did not hold");
  assert.equal(otherLoop.command, 'bullswarm workflow continue 2fne62 polish --rounds <1-5>');
  assert.equal(otherGate.text, 'gate approve · passed · continued by the caller');
  other.program.control.gates[0].when = { step: 'count', field: 'short', equals: false };
  other.controlNodes[1] = { id: 'approve', type: 'gate', status: 'passed', at: null, reason: 'when-false' };
  assert.equal(controlRows(other)[1].text, 'gate approve · skipped · count.short is false does not hold');
  other.controlNodes = [{ id: 'polish', type: 'loop', status: 'pending', at: null, round: 2, maxRounds: 3 }];
  assert.equal(controlRows(other)[0].text, "loop polish · round 2 of 3 · until check's evidence passed · round 1: did not hold");
});

test('each attempt carries its checked answer and its loop round', () => {
  const row = realRow(GATED);
  const byId = new Map(row.state.attempts.map((attempt) => [attempt.id, attempt]));
  assert.deepEqual(attemptAnswerFact(row.state, byId.get('count-1')), { ok: true, text: 'answer {"lines":4,"short":true}' });
  assert.deepEqual(attemptAnswerFact(row.state, byId.get('check-1')), { ok: true, text: 'answer {"lines":1,"passed":false}' });
  assert.equal(attemptAnswerFact(row.state, byId.get('write-1')), null, 'a step with no answer declared claims none');
  const failed = { ...byId.get('count-1'), answer: { ok: false, errors: ['lines must be integer'], file: 'x' } };
  assert.deepEqual(attemptAnswerFact(row.state, failed), { ok: false, text: 'answer check failed · lines must be integer' });
  const rounds = attemptRounds(row.state, row.events);
  assert.deepEqual(['write-1', 'check-1', 'write-2', 'check-2'].map((id) => rounds.get(id)?.round), [1, 1, 2, 2]);
  assert.equal(rounds.has('count-1'), false);
});

test('a waiting run names what it waits at and the command that moves it', () => {
  const { state } = realRow(GATED);
  assert.deepEqual(waitingFacts(state), {
    label: 'waiting at gate approve',
    nodes: state.lifecycle.waitingFor,
    commands: ['bullswarm workflow continue 2fne62 approve'],
  });
  assert.equal(waitingFacts(realRow(SINGLE).state), null);
});

test('Run timeline: phases by name, the loop and gate rows, rounds and answers', () => {
  const row = realRow(GATED);
  for (const width of [200, 120]) {
    const lines = workflowTimelineLines(workflowPanelModel(row, { nowMs: NOW }), width, 0, { goalPreview: false, nowMs: NOW, phone: false })
      .lines.map((line) => visible(line.text));
    const text = lines.join('\n');
    assert.match(text, /── ✓ Phase 1 · research · count ─/, `${width}: research phase`);
    assert.match(text, /── ✓ Phase 2 · writing · write · check ─/, `${width}: writing phase`);
    assert.match(text, /── ○ Phase 3 · publish · post ─/, `${width}: publish phase`);
    assert.match(text, /✓ loop polish · passed in round 2 of 3 · check's evidence passed/);
    assert.match(text, /⧖ gate approve · waiting for you · Read NOTE\.md/);
    assert.match(text, /continue: bullswarm workflow continue 2fne62 approve/);
    assert.match(text, /answer \{"lines":4,"short":true\}/);
    assert.match(text, /answer \{"lines":2,"passed":true\}/);
    assert.match(text, /✓ write · round 2 · grok/);
    // The loop row heads its phase; the gate row heads the phase behind it.
    const at = (pattern) => lines.findIndex((line) => pattern.test(line));
    assert.ok(at(/Phase 2 · writing/) < at(/loop polish/) && at(/loop polish/) < at(/✓ write · round 1/));
    assert.ok(at(/Phase 3 · publish/) < at(/gate approve/));
  }
  const phone = workflowTimelineLines(workflowPanelModel(row, { nowMs: NOW }), 55, 0, { goalPreview: false, nowMs: NOW, phone: true })
    .lines.map((line) => visible(line.text));
  assert.ok(phone.every((line) => line.length <= 55), 'the phone timeline fits 55 columns');
  assert.ok(phone.some((line) => line.includes('gate approve')), 'the phone keeps the gate row');
});

test('Run page of a waiting run: the header says where it waits and the next command', () => {
  for (const width of [200, 120, 55]) {
    const text = runPageText(realRow(GATED), width);
    assert.match(text.split('\n')[0], /2fne62 · waiting at gate approve/, `${width}: header`);
    assert.match(text, /bullswarm workflow continue 2fne62 approve/, `${width}: command`);
    assert.doesNotMatch(text, /Kernel not running|resume it/, `${width}: a parked run is not a dead kernel`);
  }
});

test('Run page of a one-step run: no plan strip and no phase frame, the answer shown', () => {
  for (const width of [200, 120, 55]) {
    const text = runPageText(realRow(SINGLE), width);
    assert.doesNotMatch(text, /Phase 1 · task/, `${width}: no phase frame`);
    assert.doesNotMatch(text, /── plan ·/, `${width}: no plan strip`);
    assert.match(text, /✓ task · grok/, `${width}: the attempt row`);
    assert.match(text, /answer \{"words":13\}/, `${width}: the answer`);
    assert.doesNotMatch(text, /not verified|unverified/, `${width}: a v3 run claims no verification verdict`);
  }
});

test('Runs table: a waiting run reads waiting with the command that continues it', () => {
  const row = realRow(GATED);
  const record = { ...row, ongoing: false };
  const out = runTableLines([record], { width: 120, ansi: false, nowMs: NOW });
  const text = out.lines.map(visible).join('\n');
  assert.match(text, /⧖ 2fne62/);
  assert.match(text, /waiting at gate approve · bullswarm workflow continue 2fne62 approve/);
});

test('overview panel (the mod pane): Live and Next name the gate and the continue command', () => {
  const row = realRow(GATED);
  const panel = renderWorkflowOverviewPanel(workflowPanelModel(row, { nowMs: NOW }), 100, 34, 0, 0, null, NOW).map(visible).join('\n');
  assert.match(panel, /⧖ No live agents · waiting at gate approve/);
  assert.match(panel, /⧖ bullswarm workflow continue 2fne62 approve/);
  assert.doesNotMatch(panel, /Starting the next dependency-ready actions|Waiting for the next dispatch/);
});

test('Home: a waiting card and running row name the gate and command; a v3 card claims no verdict', () => {
  const gated = { ...realRow(GATED), ongoing: true };
  const single = JSON.parse(readFileSync(join(SINGLE, 'rollup.json'), 'utf8'));
  const model = dashboardModel(null, {
    runs: [gated], rollups: [single], nowMs: NOW, usage: { pools: [], assignments: [] }, days: [],
  });
  const text = renderDashboardPage(model, { page: 'home', width: 200, height: 200, nowMs: NOW }).lines.map(visible).join('\n');
  assert.match(text, /we-proj · waiting at gate approve · bullswarm workflow continue 2fne62 approve/);
  assert.match(text, /⧖ 1\.2fne62 .*waiting at gate approve/);
  assert.match(text, /next: bullswarm workflow continue 2fne62 approve/);
  assert.match(text, /│ we-proj · completed +│/, 'the one-step run card has no verdict slot');
  assert.doesNotMatch(text, /not verified/);
});

test('Stats and Home count one-step runs as runs, apart from workflows', () => {
  assert.equal(runCountText(3, 0), '3 workflows');
  assert.equal(runCountText(1, 1), '1 run');
  assert.equal(runCountText(8, 3), '3 runs · 5 workflows');
  const single = JSON.parse(readFileSync(join(SINGLE, 'rollup.json'), 'utf8'));
  assert.equal(single.oneStep, true);
  assert.equal(single.programFormat, 3);
  assert.equal(isOneStepRecord(single), true);
  assert.equal(isOneStepRecord({ kind: 'task', source: 'run' }), true, 'a legacy single run');
  assert.equal(isOneStepRecord({ runId: 'wf-x', steps: { done: 1, total: 1 } }), false, 'a v2 workflow of one step stays a workflow');
  const model = dashboardModel(null, { rollups: [single], nowMs: NOW, usage: { pools: [], assignments: [] }, days: [] });
  const home = renderDashboardPage(model, { page: 'home', width: 200, height: 200, nowMs: NOW }).lines.map(visible).join('\n');
  assert.match(home, /Runs: 1\b/);
  assert.doesNotMatch(home, /Workflows: 1/);
  const stats = renderDashboardPage(model, { page: 'stats', width: 200, height: 120, nowMs: NOW }).lines.map(visible).join('\n');
  assert.match(stats, /\b1 run\b/);
  assert.doesNotMatch(stats, /1 workflow\b/);
});

test('workflow runs --json lists what a parked run waits at (the mod reads it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-v3-runs-'));
  try {
    cpSync(GATED, join(dir, 'workflows', 'wf-mulitifp-c82a30'), { recursive: true });
    const bin = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));
    const out = spawnSync(process.execPath, [bin, 'workflow', 'runs', '--json'], {
      env: { ...process.env, BULLSWARM_HOME: dir, BULLSWARM_DEPTH: '' }, encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    const [run] = JSON.parse(out.stdout).runs;
    assert.equal(run.status, 'waiting');
    assert.deepEqual(run.waitingFor.map((node) => [node.type, node.id]), [['gate', 'approve']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
