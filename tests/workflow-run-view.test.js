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
  runSpendLinesV2,
  workflowTimelineLines,
} from '../src/workflow/run-view.js';
import {
  attemptRoutingText,
  durationClockText,
  phaseDurationFacts,
  runSpendFacts,
  workflowPanelModel,
} from '../src/workflow/run-model.js';
import { historicalProjection } from '../scripts/render-tidy-0.35.1-frames.mjs';
import { seriesColor } from '../src/workflow/dash-kit.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';
import { readEvents } from '../src/workflow/events.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (value) => String(value ?? '').replace(ANSI, '');
const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
};
// Timestamps render in the local zone, so only their shape is asserted.
const normalizeRow = (line) => visible(line).replace(/^\s*\d{2}:\d{2}/, 'HH:MM').replace(/\s+/g, ' ').trim();

// Two real runs from the read-only snapshot the design frames use:
//   g6d6q2 — the 14-action contract stream: 12 phases, five `accept` attempts
//            across two days, and a ten-hour idle gap between revisions.
//   euqrni — finished sequential run of the same shape as 8zgqei's tidy-fixes
//            tree (one attempt per phase, started / attempt / completed).
//            8zgqei itself is the live tidy-up workflow, not in this snapshot.
//   va7k9a — the real Step-page run: six phases, eight steps.
const realHome = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351/workflows';
const realRuns = {
  g6d6q2: join(realHome, 'wf-mu6mv62z-cdcd5d'),
  euqrni: join(realHome, 'wf-mu8thu2e-27c504'),
  va7k9a: join(realHome, 'wf-mu8ni8o4-f9baaf'),
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

test('real Run frames paint verdicts, clocks, amounts, rules, and pool identity', () => {
  assert.ok(existsSync(join(realRuns.g6d6q2, 'state.json')), 'the supplied real Run snapshot is present');
  const row = realRow(realRuns.g6d6q2);
  for (const width of [55, 200]) {
    const body = bodyBuilder();
    const header = runPage({ row, assignments: [], pools: [] }, {
      width, bodyHeight: 70, narrow: width < 100, nowMs: NOW, spinnerFrame: 0, focus: 0,
    }, body);
    const raw = [header, ...body.lines].join('\n');
    assert.ok(raw.includes(`${rgb(METER_COLORS.green)}✓\x1b[0m`), `${width}: finished glyph is green`);
    assert.ok(raw.includes('\x1b[1m'), `${width}: identity or amount is bold`);
    assert.ok(raw.includes('\x1b[2m'), `${width}: clocks/meta are dim`);
    assert.ok(raw.includes('\x1b[2m──\x1b[0m'), `${width}: rule dashes are dim`);
    assert.ok(raw.includes(`${rgb(seriesColor('codex'))}codex\x1b[0m`), `${width}: codex keeps its series colour`);
    assert.ok(raw.includes('\x1b[1m$'), `${width}: spend amount is bold`);
  }

  const running = rowFixture();
  const body = bodyBuilder();
  const header = runPage({ row: running, assignments: [], pools: [] }, {
    width: 120, bodyHeight: 40, narrow: false, nowMs: NOW, spinnerFrame: 0, focus: 0,
  }, body);
  assert.ok([header, ...body.lines].join('\n').includes(`${rgb(METER_COLORS.amber)}▶\x1b[0m`), 'running glyph is amber');
  if (/\d+ .*waiting/.test(header.replace(/\x1b\[[0-9;]*m/g, ''))) {
    assert.match(header, /\d+ \x1b\[2mwaiting\x1b\[0m/, 'the header count word `waiting` is dim');
  }
});

test('Run ASCII mode removes truecolour and leaves only attribute SGR', () => {
  const previous = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    const row = rowFixture();
    const body = bodyBuilder();
    const header = runPage({ row, assignments: [], pools: [] }, {
      width: 55, bodyHeight: 40, narrow: true, nowMs: NOW, spinnerFrame: 0, focus: 0,
    }, body);
    const raw = [header, ...body.lines].join('\n');
    assert.doesNotMatch(raw, /\x1b\[38;2;/);
    const codes = raw.match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
    assert.ok(codes.every((code) => /^\x1b\[(?:0|1|2|7|22|27)m$/.test(code)), codes.join(','));
    assert.ok(raw.includes('\x1b[1m'), 'ASCII mode keeps bold identity');
    assert.ok(raw.includes('\x1b[7m'), 'ASCII mode keeps the inverse cursor');
    assert.match(raw, /\x1b\[2m\d+m\d{2}s\x1b\[0m$/m, 'ASCII mode keeps the dim attempt clock');
  } finally {
    if (previous == null) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = previous;
  }
});

test('Run timeline dims the attempt clock it prints and draws the selected phase as the one inverse cursor', () => {
  const row = realRow(realRuns.euqrni);
  const page = (width, options = {}) => {
    const body = bodyBuilder();
    runPage({ row, assignments: [], pools: [] }, {
      width, bodyHeight: 70, narrow: width < 100, nowMs: NOW, spinnerFrame: 0, focus: 0, ...options,
    }, body);
    return body.lines;
  };
  for (const width of [55, 200]) {
    // The per-attempt duration column is dim: the clock alignRight printed,
    // not a durationText field the projection leaves null.
    const lines = page(width);
    for (const clock of ['28m25s', '30m32s', '31m52s']) {
      const attemptRow = lines.find((line) => visible(line).endsWith(clock) && !visible(line).includes('→'));
      assert.ok(attemptRow, `${width}: an attempt row prints ${clock}`);
      assert.ok(attemptRow.endsWith(`\x1b[2m${clock}\x1b[0m`), `${width}: ${JSON.stringify(attemptRow)}`);
    }
    // One cursor, on the phase Up/Down selected; it moves with the selection
    // and only SGR changes — the text and width of every row are kept.
    for (const [phaseIndex, name] of [[0, 'home-extraction'], [4, 'verify']]) {
      const selected = page(width, { phaseIndex });
      const cursor = selected.filter((line) => line.includes('\x1b[7m'));
      assert.equal(cursor.length, 1, `${width}/${phaseIndex}: ${cursor.map(visible).join(' | ')}`);
      assert.ok(cursor[0].includes('\x1b[27m'), JSON.stringify(cursor[0]));
      const inverse = visible(/\x1b\[7m(.*)\x1b\[27m/.exec(cursor[0])[1]);
      if (width >= 100) assert.equal(inverse, `[✓ ${phaseIndex + 1} ${name}]`);
      else assert.equal(inverse, `── ✓ ${phaseIndex + 1} · ${name}`);
      assert.deepEqual(selected.map(visible), lines.map(visible), `${width}/${phaseIndex}: the cursor changed text`);
    }
    // A reader inside the agent list has no phase cursor on the plan.
    assert.ok(page(width, { focus: 1 }).every((line) => !line.includes('\x1b[7m')), `${width}: focus 1 kept a phase cursor`);
  }
});

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
  assert.match(visible(header), /^ ● view01 · running · 1 of 2 steps · 1 running/);
  assert.ok(body.lines.some((line) => visible(line).includes('timeline')));
  markStepRows(body, body.lines, panel, row.runId);
  assert.ok(body.regions.some((region) => region.action?.kind === 'step'));
});

test('Run view paints numbered phase boxes and v2 attempt routing metadata', () => {
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
  assert.deepEqual(rows, ['[✓ 1 audit] → [▶ 2 report 0/1]']);
  const timeline = workflowTimelineLines(workflowPanelModel(row), 120, 0, { goalPreview: false, nowMs: NOW });
  const text = timeline.lines.map((line) => visible(line.text ?? line)).join('\n');
  // One v2 row per attempt, its own clock on the right and the routing it ran
  // on beside the step's name. Phase start/completed filler is gone.
  assert.match(text, /\d{2}:\d{2}\s+✓ report · codex · gpt-test · high\s+1m30s/);
  assert.doesNotMatch(text, /phase active|├─ started|└─✓ completed/);
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

test('the real g6d6q2 run draws v2 phase rules and pool · model · effort per attempt', { skip: !existsSync(join(realRuns.g6d6q2, 'state.json')) }, () => {
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
  // The clock is h/m/s everywhere, which is why the header below reads 2h04m.
  assert.equal(durationClockText(duration.activeMinutes), '2h04m');
  assert.ok(spanMinutes > duration.activeMinutes * 10, 'the phase idled for hours between revisions');
  const acceptHeader = headers.find((line) => String(line.segment).endsWith(' · accept') || String(line.segment) === 'accept');
  // Rule 6 of the run-v2 record: the rule spends its dashes between the phase
  // name and the facts and ends on the tally — no closing `──`.
  assert.match(visible(acceptHeader.text), /^── ✓ 12 · accept \S.*2h04m · 1\/1$/);
  assert.ok(!visible(acceptHeader.text).trimEnd().endsWith('──'), visible(acceptHeader.text));
  assert.doesNotMatch(visible(acceptHeader.text), new RegExp(`${Math.round(spanMinutes)}m`));

  // One row per attempt, each carrying its own clock — the same figure the
  // attempt's own record computes — and the routing it ran on.
  for (const attempt of accept) {
    assert.ok(glyphFor(attempt.status), `unexpected accept status ${attempt.status}`);
    const own = durationClockText(minutesBetween(attempt.startedAt, attempt.finishedAt));
    const expected = `HH:MM ${glyphFor(attempt.status)} accept · ${attemptRoutingText(attempt)} ${own}`;
    assert.ok(lines.includes(expected), `missing attempt row:\n  ${expected}\nin:\n${lines.join('\n')}`);
  }
  // Distinct clocks, not one shared phase duration: the goal's own complaint
  // was several attempts all reporting the same time.
  const clocks = accept.map((attempt) => durationClockText(minutesBetween(attempt.startedAt, attempt.finishedAt)));
  assert.deepEqual(clocks, ['28m31s', '26m09s', '6m37s', '34m31s', '28m21s']);

  // The phase rule carries the tally/duration; filler started/completed rows
  // and the old phase-active rows must not return.
  assert.ok(lines.some((line) => line.match(/^↑ phases 3–\d+ ·/)));
  assert.ok(lines.every((line) => !line.includes('├─ started') && !line.includes('└─✓ completed')));
  assert.deepEqual(lines.filter((line) => line.includes('phase active')), []);
});

test('the real euqrni run draws one v2 phase rule per sequential phase', { skip: !existsSync(join(realRuns.euqrni, 'state.json')) }, () => {
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
    const expected = `HH:MM ✓ ${actionId} · ${attemptRoutingText(attempt)} ${own}`;
    assert.ok(lines.includes(expected), `missing attempt row:\n  ${expected}\nin:\n${lines.join('\n')}`);
    const header = timeline.lines.find((line) => line?.header && (String(line.segment).endsWith(` · ${actionId}`) || String(line.segment) === actionId));
    const duration = phaseDurationFacts(row, panel.stages.find((stage) => (stage.actionIds ?? []).includes(actionId)), { nowMs: NOW });
    assert.match(visible(header.text), new RegExp(`^── ✓ \\d+ · ${actionId} \\S.*${durationClockText(duration.activeMinutes)} · 1/1$`));
  }
  assert.ok(lines.every((line) => !line.includes('├─ started') && !line.includes('└─✓ completed')));
});

test('waiting phase rules dim every clock and duration placeholder', { skip: !existsSync(join(realRuns.euqrni, 'state.json')) }, () => {
  const source = realRow(realRuns.euqrni);
  const projected = historicalProjection(source, 'integrate', 1, 'running');
  const panel = workflowPanelModel(projected.row);
  const timeline = workflowTimelineLines(panel, 200, 0, {
    goalPreview: false,
    nowMs: projected.nowMs,
  });
  const waiting = timeline.lines.find((line) => visible(line?.text).includes('○ 5 · verify'));
  assert.ok(waiting, 'the projected real run has a waiting verify phase');
  assert.match(
    waiting.text,
    /\x1b\[2m—\x1b\[0m → \x1b\[2m—\x1b\[0m · \x1b\[2m—\x1b\[0m · \x1b\[2m0\/1\x1b\[0m$/,
    JSON.stringify(waiting.text),
  );
  const emDashes = waiting.text.match(/—/g) ?? [];
  const dimmedDashes = waiting.text.match(/\x1b\[2m—\x1b\[0m/g) ?? [];
  assert.equal(emDashes.length, 3, 'the waiting facts contain start, end, and duration placeholders');
  assert.equal(dimmedDashes.length, 3, 'all three placeholders carry dim SGR');
});

test('the spend block draws the record\u2019s columns, and the 55-column form stays two short rows', () => {
  // The run the run-v2 record was drawn from: 26 attempts, 19 measured, 6
  // estimated (command-code) and 1 still running (command-code), of which 17
  // recorded a plan amount.
  const rowsFor = (pool, count, { amount = 0, estimated = false, running = false, plans = 0, planAmount = 0 } = {}) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${pool}-${index + 1}`, actionId: `${pool}-step`, ordinal: index + 1, pool,
      status: running ? 'running' : 'succeeded',
      startedAt: '2026-09-20T10:00:00.000Z',
      finishedAt: running ? null : '2026-09-20T10:10:00.000Z',
      usage: running ? null : {
        api: { usd: index === 0 ? amount : 0 },
        tokenSource: estimated ? 'estimated:utf8-bytes/4' : 'provider-reported',
        ...(index < plans ? { subscription: { usd: index === 0 ? planAmount : 0 } } : {}),
      },
    }));
  const record = {
    state: {
      attempts: [
        ...rowsFor('codex', 11, { amount: 11.45, plans: 11, planAmount: 1.99 }),
        ...rowsFor('claude-code', 5, { amount: 55.56, plans: 5 }),
        ...rowsFor('claude-code:acme', 2, { amount: 22.55 }),
        ...rowsFor('grok', 1, { amount: 2.68, plans: 1 }),
        ...rowsFor('command-code', 6, { amount: 0.01, estimated: true }),
        ...rowsFor('command-code', 1, { running: true }),
      ],
    },
  };
  const spend = runSpendFacts(record);
  assert.equal(spend.coverageText, '19 of 26 attempts measured');

  const wide = runSpendLinesV2(spend, 79, { phone: false });
  // The amount opens the split on the API row, the pools that do not fit keep
  // the same column under it, and the run's own counts close the last row.
  assert.match(visible(wide[1]), /^ API rate   at least \$92\.25 {3}claude-code \$55\.56 · acme \$22\.55 · codex \$11\.45$/);
  assert.equal(visible(wide[1]).indexOf('claude-code'), 30);
  assert.match(visible(wide[2]), /^ {30}grok \$2\.68 · command-code ≈\$0\.01 \(6 estimated\)$/);
  assert.equal(visible(wide[2]).indexOf('grok'), 30);
  // `claude-code:acme` is the qualified name of one pool: the split says
  // `acme`, the way the record's own row does.
  assert.doesNotMatch(wide.join('\n'), /claude-code:acme/);
  assert.match(visible(wide[3]), /^ plans      at least \$1\.99 {4}17 attempts with a meter reading · 9 without$/);
  assert.equal(visible(wide[3]).indexOf('17 attempts'), 30);
  assert.ok(wide.every((line) => visible(line).length <= 79), wide.join('\n'));

  // The 55-column form is the record's two short rows: the amount keeps its
  // own coverage words, and the meter phrase shortens rather than cutting off.
  const phone = runSpendLinesV2(spend, 54, { phone: true });
  assert.equal(visible(phone[1]), ' API rate  at least $92.25  6 estimated · 1 running');
  assert.equal(visible(phone[2]), ' plans     at least $1.99   17 with a meter reading');
  assert.ok(phone.every((line) => visible(line).length <= 54));

  // The real euqrni run: two priced pools share the amount's own row, and the
  // meter phrase fits whole at this width.
  const real = realRow(realRuns.euqrni);
  const realLines = runSpendLinesV2(runSpendFacts(real), 79, { phone: false });
  assert.match(visible(realLines[1]), /^ API rate   \$9\.76 {13}claude-code \$6\.78 · codex \$2\.98$/);
  assert.equal(visible(realLines[1]).indexOf('claude-code'), 30);
  assert.match(visible(realLines[2]), /^ plans      — {17}0 attempts with a meter reading · 5 without$/);
  assert.equal(visible(realLines[2]).indexOf('0 attempts'), 30);
});

test('the phone plan strip counts real phases, not their steps', { skip: !existsSync(join(realRuns.va7k9a, 'state.json')) }, () => {
  const row = realRow(realRuns.va7k9a);
  assert.equal(row.state.presentation.stages.length, 6);
  assert.equal(row.state.actions.length, 8);
  const body = bodyBuilder();
  runPage({ row, assignments: [], pools: [] }, {
    width: 55, bodyHeight: 70, narrow: true, nowMs: NOW, spinnerFrame: 0, focus: 0,
  }, body);
  const strip = body.lines.find((line) => visible(line).startsWith(' plan  '));
  assert.equal(visible(strip), ' plan  ✓✓✓✓✓✓  6 verify done · then —');
  assert.equal((visible(strip).match(/[✓▶✗○]/g) ?? []).length, 6);
});

test('plan boxes are numbered, chained with arrows, and never leave a trailing arrow', () => {
  const row = rowFixture();
  const stages = planDagLines(row, { width: 200, nowMs: NOW });
  assert.equal(stages.length, 1);
  const wide = visible(stages[0].parts.map((part) => part.text).join(''));
  assert.equal(wide, '[✓ 1 audit] → [▶ 2 report 0/1]');
  assert.ok(!wide.trimEnd().endsWith('→'), wide);

  const narrow = planDagLines(row, { width: 55, nowMs: NOW }).map((line) => visible(line.parts.map((part) => part.text).join('')));
  assert.deepEqual(narrow, ['[✓ 1 audit]', '[▶ 2 report 0/1]']);
  assert.ok(narrow.every((line) => !line.endsWith('→')));

  const real = realRow(realRuns.g6d6q2);
  const wrapped = planDagLines(real, { width: 120, nowMs: NOW }).map((line) => visible(line.parts.map((part) => part.text).join('')));
  assert.ok(wrapped.length > 1, 'the real 12-phase plan wraps at 120 columns');
  assert.ok(wrapped.every((line) => !line.trimEnd().endsWith('→')), wrapped.join('\n'));
  const numbers = wrapped.join(' ').match(/\[[✓▶○✗] (\d+) /g).map((match) => Number(match.replace(/\D+/g, '')));
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1));
  assert.ok(!wrapped.join(' ').includes('. '), wrapped.join('\n'));
});
