import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actionNamedIn,
  flatTimelineLines,
  markStepRows,
  planDagLines,
  renderWorkflowOverviewPanel,
  runFrame,
  runPage,
  workflowTimelineLines,
} from '../src/workflow/run-view.js';
import {
  attemptRoutingText,
  durationClockText,
  phaseDurationFacts,
  workflowPanelModel,
} from '../src/workflow/run-model.js';
import { readEvents } from '../src/workflow/events.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(ANSI, '');
// Timestamps render in the local zone, so only their shape is asserted.
const normalizeRow = (line) => visible(line).replace(/^\d{2}:\d{2}/, 'HH:MM').replace(/\s+/g, ' ').trim();

// Two real runs from the read-only snapshot the design frames use:
//   g6d6q2 — the 14-action contract stream: 12 phases, five `accept` attempts
//            across two days, and a ten-hour idle gap between revisions.
//   euqrni — finished sequential run of the same shape as 8zgqei's tidy-fixes
//            tree (one attempt per phase, started / attempt / completed).
//            8zgqei itself is the live tidy-up workflow, not in this snapshot.
const realHome = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351/workflows';
const realRuns = {
  g6d6q2: join(realHome, 'wf-mu6mv62z-cdcd5d'),
  euqrni: join(realHome, 'wf-mu8thu2e-27c504'),
};

const minutesBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 60_000;
const glyphFor = (status) => (status === 'succeeded' ? '✓' : status === 'interrupted' ? '✗' : status === 'running' ? '▶' : null);

/** The row the dashboard builds for a durable run, read from the run itself. */
function realRow(runDir) {
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const resultFile = join(runDir, 'result.json');
  return {
    runId: state.runId, shortId: state.shortId, runDir, status: state.lifecycle.status, state,
    report: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null,
    events: readEvents(runDir), assignments: [], pools: [], liveness: { alive: false, reason: 'durable record' },
  };
}

function rowFixture() {
  const goal = createV2GoalDocument({
    goal: 'Audit and report the repository', cwd: '/tmp/repository',
    requirements: [{ id: 'report', text: 'A report exists.', mandatory: true }],
    settings: { scout: false, executionMode: 'program' },
  });
  let state = createV2State(goal, { runId: 'wf-view', shortId: 'view01' });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Audit then report.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'audit', purpose: 'Audit files', dependsOn: [], affects: ['report'], ownedFiles: ['audit.md'], prompt: 'Audit files.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['audit'] },
      { id: 'report', purpose: 'Write report', dependsOn: ['audit'], affects: [], ownedFiles: [], prompt: 'Write report.', lane: 'analyze', effort: 'low', evidenceFor: ['report'], inputs: ['audit'], produces: [] },
    ] },
  });
  state.lifecycle = { status: 'running', startedAt: '2026-09-20T11:55:00.000Z', finishedAt: null, resultFile: null };
  state.actions[0].status = 'succeeded';
  state.actions[1].status = 'running';
  state.actions[1].startedAt = '2026-09-20T11:58:00.000Z';
  state.attempts.push({ id: 'report-1', actionId: 'report', ordinal: 1, status: 'running', pool: 'codex', model: 'gpt-test', startedAt: '2026-09-20T11:58:00.000Z', lastActivityAt: '2026-09-20T11:59:00.000Z' });
  return { runId: state.runId, shortId: state.shortId, status: 'running', state, events: [], assignments: [], pools: [], liveness: { alive: true } };
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
      let text = '';
      for (const part of parts ?? []) text += String(part?.text ?? '');
      body.lines.push(text);
      return body;
    },
  };
  return body;
}

test('Run view keeps timeline, overview and plan rows within the requested width', () => {
  const row = rowFixture();
  const panel = workflowPanelModel(row);
  for (const width of [55, 120, 200]) {
    const frame = runFrame(row, { width, height: 30, bodyHeight: 20, spinnerFrame: 0 });
    assert.ok(frame.body.length > 0);
    assert.ok(frame.body.every((line) => visible(line).length <= width), `${width}: ${frame.body.join('\n')}`);
    const overview = renderWorkflowOverviewPanel(panel, width, 18, 0);
    assert.ok(overview.every((line) => visible(line).length <= width));
    const plan = planDagLines(row, { width, nowMs: NOW });
    assert.ok(plan.length > 0);
    assert.ok(plan.every((line) => visible(line.parts.map((part) => part.text).join('')).length <= width));
  }
});

test('Run view preserves timeline segments and step hit regions through the extracted page', () => {
  const row = rowFixture();
  const panel = workflowPanelModel(row);
  const timeline = workflowTimelineLines(panel, 100, 0, { goalPreview: false });
  assert.ok(timeline.lines.some((line) => line.header && line.segment));
  assert.ok(flatTimelineLines(panel, { width: 55, rows: 8 }).length <= 8);
  assert.equal(actionNamedIn('  ✓ report completed', row.state.actions).id, 'report');

  const body = bodyBuilder();
  const header = runPage({ row, assignments: [], pools: [] }, { width: 55, bodyHeight: 22, narrow: true, nowMs: NOW, spinnerFrame: 0, focus: 0 }, body);
  assert.match(header, /^ view01 running/);
  assert.ok(body.lines.some((line) => visible(line).includes('timeline')));
  markStepRows(body, body.lines, panel, row.runId);
  assert.ok(body.regions.some((region) => region.action?.kind === 'step'));
});

test('Run view paints numbered phase boxes chained with arrows and attempt routing metadata', () => {
  const row = rowFixture();
  row.state.attempts[0].status = 'succeeded';
  row.state.attempts[0].finishedAt = '2026-09-20T11:59:30.000Z';
  row.state.attempts[0].effort = 'high';
  row.state.attempts[0].routing = { effort: 'high' };
  for (const width of [55, 120, 200]) {
    const lines = planDagLines(row, { width, nowMs: NOW }).map((line) => line.parts.map((part) => part.text).join(''));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visible(line).length <= width));
    assert.ok(lines.every((line) => !line.includes('codex') && !line.includes('gpt-test')));
  }
  const firstBox = planDagLines(row, { width: 55 })[0].parts.find((part) => part.action);
  assert.equal(firstBox.action.actionId, 'audit');
  const rows = planDagLines(row, { width: 120, nowMs: NOW }).map((line) => visible(line.parts.map((part) => part.text).join('')));
  assert.deepEqual(rows, ['[✓ 1. audit 1/1] → [▶ 2. report 0/1]']);
  const timeline = workflowTimelineLines(workflowPanelModel(row), 120, 0, { goalPreview: false, nowMs: NOW });
  const text = timeline.lines.map((line) => line.text ?? line).join('\n');
  // The 0.35.0 tree row: one line per attempt, its own clock on the right and
  // the routing it ran on beside the step's name. No `phase active` extra row.
  assert.match(text, /│  ├─✓ report · codex · gpt-test · high\s+1m30s/);
  assert.doesNotMatch(text, /phase active/);
});

test('the real g6d6q2 and euqrni runs stay inside 55, 120 and 200 columns', { skip: !existsSync(join(realRuns.g6d6q2, 'state.json')) || !existsSync(join(realRuns.euqrni, 'state.json')) }, () => {
  const measured = {};
  for (const [name, runDir] of Object.entries(realRuns)) {
    const row = realRow(runDir);
    for (const width of [55, 120, 200]) {
      const body = bodyBuilder();
      const header = runPage({ row, assignments: [], pools: [] }, {
        width, bodyHeight: 70, narrow: width < 100, nowMs: NOW, spinnerFrame: 0, focus: 0,
      }, body);
      assert.ok(visible(header).length <= width, `${name}@${width} header`);
      assert.ok(body.lines.length > 0, `${name}@${width} painted nothing`);
      let longest = visible(header).length;
      for (const line of body.lines) {
        const length = visible(line).length;
        assert.ok(length <= width, `${name}@${width}: "${visible(line)}"`);
        if (length > longest) longest = length;
      }
      for (const line of planDagLines(row, { width, nowMs: NOW })) {
        const text = visible(line.parts.map((part) => part.text).join(''));
        assert.ok(text.length <= width, `${name}@${width} plan: "${text}"`);
        if (text.length > longest) longest = text.length;
      }
      measured[`${name}@${width}`] = longest;
    }
  }
  // The painted page uses the width it is given: 55-col frames stay on the
  // phone, 120/200 fill past a half-width leftover.
  assert.ok(measured['g6d6q2@55'] <= 55);
  assert.ok(measured['euqrni@55'] <= 55);
  assert.ok(measured['g6d6q2@120'] > 60 && measured['g6d6q2@120'] <= 120);
  assert.ok(measured['euqrni@120'] > 60 && measured['euqrni@120'] <= 120);
  assert.ok(measured['g6d6q2@200'] > 120 && measured['g6d6q2@200'] <= 200);
  assert.ok(measured['euqrni@200'] > 120 && measured['euqrni@200'] <= 200);
});

test('the real g6d6q2 run draws the 0.35.0 tree with pool · model · effort per attempt', { skip: !existsSync(join(realRuns.g6d6q2, 'state.json')) }, () => {
  const row = realRow(realRuns.g6d6q2);
  const panel = workflowPanelModel(row);
  const timeline = workflowTimelineLines(panel, 200, 0, { goalPreview: false, nowMs: NOW });
  const lines = timeline.lines.map((line) => normalizeRow(typeof line === 'string' ? line : line.text));
  const headers = timeline.lines.filter((line) => line?.header);
  const accept = row.state.attempts.filter((attempt) => attempt.actionId === 'accept');
  assert.equal(accept.length, 5);

  // The phase header names the phase's level and counts its active minutes —
  // the five accept attempts are disjoint, so the union is their exact sum,
  // not the span across the idle time between them.
  const acceptStage = panel.stages.find((stage) => (stage.actionIds ?? []).includes('accept'));
  const duration = phaseDurationFacts(row, acceptStage, { nowMs: NOW });
  const spanMinutes = minutesBetween(accept[0].startedAt, accept.at(-1).finishedAt);
  assert.equal(durationClockText(duration.activeMinutes), '124m09s');
  assert.ok(spanMinutes > duration.activeMinutes * 10, 'the phase idled for hours between revisions');
  const acceptHeader = headers.find((line) => String(line.segment).endsWith(' · accept') || String(line.segment) === 'accept');
  assert.match(visible(acceptHeader.text), /^── Phase 12 · accept ─+ 124m09s ──$/);
  assert.doesNotMatch(visible(acceptHeader.text), new RegExp(`${Math.round(spanMinutes)}m`));

  // One row per attempt, each carrying its own clock — the same figure the
  // attempt's own record computes — and the routing it ran on.
  for (const attempt of accept) {
    assert.ok(glyphFor(attempt.status), `unexpected accept status ${attempt.status}`);
    const own = durationClockText(minutesBetween(attempt.startedAt, attempt.finishedAt));
    const expected = `HH:MM │ ├─${glyphFor(attempt.status)} accept · ${attemptRoutingText(attempt)} ${own}`;
    assert.ok(lines.includes(expected), `missing attempt row:\n  ${expected}\nin:\n${lines.join('\n')}`);
  }
  // Distinct clocks, not one shared phase duration: the goal's own complaint
  // was several attempts all reporting the same time.
  const clocks = accept.map((attempt) => durationClockText(minutesBetween(attempt.startedAt, attempt.finishedAt)));
  assert.deepEqual(clocks, ['28m31s', '26m09s', '6m37s', '34m31s', '28m21s']);

  // The tree opens and closes each phase, and never repeats itself with the
  // three-line `phase active` entries the owner rejected.
  assert.ok(lines.includes('HH:MM ├─ started'));
  assert.ok(lines.includes('HH:MM └─✓ completed 1/1'));
  assert.deepEqual(lines.filter((line) => line.includes('phase active')), []);
});

test('the real euqrni run draws one 0.35.0 tree per sequential phase', { skip: !existsSync(join(realRuns.euqrni, 'state.json')) }, () => {
  const row = realRow(realRuns.euqrni);
  const panel = workflowPanelModel(row);
  const timeline = workflowTimelineLines(panel, 200, 0, { goalPreview: false, nowMs: NOW });
  const lines = timeline.lines.map((line) => normalizeRow(typeof line === 'string' ? line : line.text));
  assert.deepEqual(lines.filter((line) => line.includes('phase active')), []);
  const sequential = ['home-extraction', 'runs-extraction', 'run-extraction', 'integrate', 'verify'];
  for (const actionId of sequential) {
    const attempt = row.state.attempts.find((entry) => entry.actionId === actionId);
    assert.ok(attempt, `missing ${actionId} attempt`);
    const own = durationClockText(minutesBetween(attempt.startedAt, attempt.finishedAt));
    const expected = `HH:MM │ ├─✓ ${actionId} · ${attemptRoutingText(attempt)} ${own}`;
    assert.ok(lines.includes(expected), `missing attempt row:\n  ${expected}\nin:\n${lines.join('\n')}`);
    const header = timeline.lines.find((line) => line?.header && (String(line.segment).endsWith(` · ${actionId}`) || String(line.segment) === actionId));
    const duration = phaseDurationFacts(row, panel.stages.find((stage) => (stage.actionIds ?? []).includes(actionId)), { nowMs: NOW });
    assert.match(visible(header.text), new RegExp(`^── Phase \\d+ · ${actionId} ─+ ${durationClockText(duration.activeMinutes)} ──$`));
  }
  assert.ok(lines.includes('HH:MM ├─ started'));
  assert.ok(lines.includes('HH:MM └─✓ completed 1/1'));
});

test('plan boxes are numbered, chained with arrows, and never leave a trailing arrow', () => {
  const row = rowFixture();
  const stages = planDagLines(row, { width: 200, nowMs: NOW });
  assert.equal(stages.length, 1);
  const wide = visible(stages[0].parts.map((part) => part.text).join(''));
  assert.equal(wide, '[✓ 1. audit 1/1] → [▶ 2. report 0/1]');
  assert.ok(!wide.trimEnd().endsWith('→'), wide);

  const narrow = planDagLines(row, { width: 55, nowMs: NOW }).map((line) => visible(line.parts.map((part) => part.text).join('')));
  assert.deepEqual(narrow, ['[✓ 1. audit 1/1]', '[▶ 2. report 0/1]']);
  assert.ok(narrow.every((line) => !line.endsWith('→')));

  const real = realRow(realRuns.g6d6q2);
  const wrapped = planDagLines(real, { width: 120, nowMs: NOW }).map((line) => visible(line.parts.map((part) => part.text).join('')));
  assert.ok(wrapped.length > 1, 'the real 12-phase plan wraps at 120 columns');
  assert.ok(wrapped.every((line) => !line.trimEnd().endsWith('→')), wrapped.join('\n'));
  const numbers = wrapped.join(' ').match(/\[[✓▶○✗] (\d+)\./g).map((match) => Number(match.replace(/\D+/g, '')));
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1));
});
