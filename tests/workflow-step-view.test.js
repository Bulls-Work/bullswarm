import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stepPageModel } from '../src/workflow/step-model.js';
import { foldLineText, overviewWindow, renderStepPage, stepViewToggle, toolRowWindow } from '../src/workflow/step-view.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';
import { seriesColor } from '../src/workflow/dash-kit.js';
import { METER_COLORS } from '../src/workflow/usage-view.js';

// The fixture's clocks were recorded in Hong Kong and the expectations quote
// them as HKT, so this file reads them there on any machine (CI runs in UTC).
process.env.TZ = 'Asia/Hong_Kong';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const fixtureDir = fileURLToPath(new URL('./fixtures/step-model/', import.meta.url));
const frameDir = '/tmp/bullswarm-step-frames-0.35.1';
const fixedNow = Date.parse('2026-09-19T18:10:00.000Z');
const realClaudeRun = fileURLToPath(new URL('./fixtures/home-351/workflows/wf-mu6mv62z-cdcd5d/', import.meta.url));

function stateFor({ actionId, actionStatus, lifecycleStatus, attempts, resultFile = null }) {
  return {
    runId: `wf-${actionId}-fixture`,
    shortId: `${actionId.slice(0, 3)}fx`,
    workflow: `${actionId} fixture`,
    intent: { goal: `exercise ${actionId}` },
    lifecycle: { status: lifecycleStatus, startedAt: '2026-09-19T17:50:19.595Z', finishedAt: lifecycleStatus === 'running' ? null : '2026-09-19T18:00:00.000Z', resultFile },
    planner: { status: 'completed', turns: 0, attempts: [], lastDecision: null },
    presentation: { stages: [{ id: 'phase', label: 'Phase', actionIds: [actionId], startedAt: '2026-09-19T17:50:19.595Z', completedAt: lifecycleStatus === 'running' ? null : '2026-09-19T18:00:00.000Z' }] },
    actions: [{ id: actionId, status: actionStatus, attempts: attempts.length, purpose: `Build the ${actionId} fixture`, startedAt: attempts[0]?.startedAt ?? null, finishedAt: attempts.at(-1)?.finishedAt ?? null, outputFile: 'output.md' }],
    attempts,
    outputs: { [actionId]: { outFile: 'output.md', bytes: 122 } },
    ledger: { requirements: { 'requirement-1': { id: 'requirement-1', status: lifecycleStatus === 'completed' ? 'passed' : lifecycleStatus === 'partial' ? 'pending' : 'unknown', mandatory: true, evidence: [] } } },
  };
}

function poolFor(name) {
  if (name === 'codex') return {
    name,
    free: false,
    meterSource: 'live',
    pacingWindow: 'weekly',
    connector: { meter: { type: 'reader', window: 'weekly' }, modelProfiles: [] },
  };
  return { name, free: null, meterSource: 'none', connector: { meter: { type: 'none' }, modelProfiles: [] } };
}

function runningAttempt() {
  return {
    id: 'step-view-1', actionId: 'step-view', ordinal: 1, status: 'running', pool: 'codex', model: 'gpt-5.6-luna',
    startedAt: '2026-09-19T17:50:19.886Z', finishedAt: null, taskFile: 'task.md', outputFile: 'output.md', streamFile: 'running-stream.jsonl',
    routing: { lane: 'build', effort: 'medium', reason: 'most-behind capable pool', candidates: [{ pool: 'codex', model: 'gpt-5.6-luna' }] }, usage: null,
  };
}

function finishedAttempt() {
  return {
    ...runningAttempt(), id: 'step-view-1', actionId: 'step-view', status: 'succeeded', startedAt: '2026-09-18T17:21:52.572Z', finishedAt: '2026-09-18T18:01:13.599Z', streamFile: null, wallSec: 2361,
    usage: { tokens: { standardRead: 1642, output: 190, totalKnown: 1832 }, tokenSource: 'estimated:utf8-bytes/4', pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 }, cost: { estimatedUsd: 0.0005564, breakdown: { standardReadUsd: 0.0003284, outputUsd: 0.000228 }, basis: 'legacy estimate' } },
  };
}

function failedAttempts() {
  const base = {
    ...runningAttempt(), actionId: 'cli', streamFile: null, pool: 'opencode2', model: 'kaihk-3/gpt-5.6-luna', failureKind: 'provider', why: 'provider stream reported error',
    usage: { tokens: { standardRead: 2407, output: 359, totalKnown: 2766 }, tokenSource: 'estimated:utf8-bytes/4', pricing: null, cost: { estimatedUsd: null, basis: 'unknown: no model rate metadata' } },
  };
  return [
    { ...base, id: 'cli-1', ordinal: 1, status: 'interrupted', startedAt: '2026-09-11T12:51:13.521Z', finishedAt: '2026-09-11T12:52:38.033Z', wallSec: 84.5 },
    { ...base, id: 'cli-2', ordinal: 2, status: 'interrupted', pool: 'opencode2', startedAt: '2026-09-11T12:52:38.231Z', finishedAt: '2026-09-11T12:53:57.480Z', wallSec: 79.2, usage: { ...base.usage, tokens: { standardRead: 2407, output: 358, totalKnown: 2765 } } },
  ];
}

function makeModels() {
  const running = (() => {
    const attempt = runningAttempt();
    const state = stateFor({ actionId: 'step-view', actionStatus: 'running', lifecycleStatus: 'running', attempts: [attempt] });
    return stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state, pools: [poolFor('codex')] }, { nowMs: fixedNow });
  })();
  const finished = (() => {
    const attempt = finishedAttempt();
    const state = stateFor({ actionId: 'step-view', actionStatus: 'succeeded', lifecycleStatus: 'completed', attempts: [attempt], resultFile: 'finished-result.json' });
    return stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state, pools: [poolFor('codex')] }, { nowMs: fixedNow });
  })();
  const failed = (() => {
    const attempts = failedAttempts();
    const state = stateFor({ actionId: 'cli', actionStatus: 'failed', lifecycleStatus: 'partial', attempts, resultFile: 'failed-result.json' });
    return stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state, pools: [poolFor('opencode2')] }, { nowMs: fixedNow });
  })();
  return { running, finished, failed };
}

function render(model, width, options = {}) {
  const body = { lines: [], push(line = '') { this.lines.push(String(line)); } };
  const header = renderStepPage(model, { width, spinnerFrame: 0, nowMs: fixedNow, ...options }, body);
  return [header, ...body.lines];
}

function renderDashboardFrame(model, width, options = {}) {
  const input = model.modelInput;
  const row = {
    ...input,
    runId: input.runId ?? model.identity?.runId,
    shortId: input.shortId ?? model.identity?.shortId,
    status: model.identity?.workflowStatus ?? model.identity?.status,
    ongoing: model.identity?.status === 'running',
  };
  const dashboard = dashboardModel(row, { runs: [row], tasks: { inflight: [], finished: [] }, usage: { pools: input.pools ?? [] } });
  const height = width < 70 ? 30 : width >= 170 ? 28 : 30;
  return renderDashboardPage(dashboard, {
    page: 'step', width, height, rows: [row], allRows: [row], selectedRunId: row.runId,
    phaseIndex: 0, agentIndex: 0, ...options,
  }).lines.map(plain);
}

function plain(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The activity rule's current view is inverse like the active tab, never a cursor. */
const isToggleRule = (line) => /── \S+ · overview · detail/.test(plain(line));

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

test('real Step frames paint the approved cells and keep response prose plain', () => {
  assert.ok(existsSync(join(realClaudeRun, 'state.json')), 'the supplied real Step snapshot is present');
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realClaudeRun,
    state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow });
  const green = rgb(METER_COLORS.green);
  const reset = '\x1b[0m';
  for (const width of [55, 200]) {
    const raw = render(model, width).join('\n');
    assert.ok(raw.includes(`${green}✓${reset}`), `${width}: finished glyph is green`);
    assert.ok(raw.includes(`${green}verified by the workflow`), `${width}: verified verdict is green`);
    assert.ok(raw.includes('\x1b[2m'), `${width}: a clock/meta cell is dim`);
    assert.ok(raw.includes('\x1b[1m$'), `${width}: an amount is bold`);
    assert.ok(raw.includes('\x1b[2m──\x1b[0m'), `${width}: rule dashes are dim`);
    const pool = model.presentation.header.pool;
    assert.ok(raw.includes(`${rgb(seriesColor(pool))}${pool}${reset}`), `${width}: a pool keeps its series colour`);
    // Turn 1 sits in the transcript (every turn, rule 12); the overview opens
    // on the newest turns, so its oldest shown turn carries plain prose there.
    const response = model.presentation.activity.turns[0]?.text;
    assert.ok(response, 'real snapshot has a first response');
    const transcript = render(model, width, { stepView: 'detail' }).join('\n');
    const at = transcript.indexOf(response);
    assert.ok(at >= 0, `${width}: first response is present in the transcript`);
    assert.equal(transcript.slice(at, at + response.length).includes('\x1b['), false, `${width}: response text is plain`);
    const turns = model.presentation.activity.turns;
    const oldestShown = turns.at(-(width < 100 ? 5 : 10)).text.slice(0, 24);
    const lead = raw.indexOf(oldestShown);
    assert.ok(lead >= 0, `${width}: the window's oldest turn is present`);
    assert.equal(raw.slice(lead, lead + oldestShown.length).includes('\x1b['), false, `${width}: overview prose is plain`);
  }
});

test('the turn Up/Down selected is the one inverse row on real Step frames, in ASCII mode too', () => {
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId, shortId: state.shortId, runDir: realClaudeRun, state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow });
  const turns = model.presentation.activity.turns;
  assert.ok(turns.length >= 2, 'the real attempt has two turns to move between');
  const inverseRows = (lines) => lines.map((line, index) => [index, line]).filter(([, line]) => line.includes('\x1b[7m') && !isToggleRule(line));
  const check = (width) => {
    const untouched = render(model, width);
    // Step-v2 rule 13: the overview opens with the cursor on the newest turn.
    const opening = inverseRows(untouched);
    assert.equal(opening.length, 1, `${width}: one cursor when the page opens`);
    assert.match(plain(opening[0][1]), new RegExp(`^ +${turns.at(-1).number}  `), `${width}: ${plain(opening[0][1])}`);
    const at = [];
    for (const stepTurnIndex of [turns.length - 2, turns.length - 1]) {
      const lines = render(model, width, { stepTurnIndex });
      const rows = inverseRows(lines);
      assert.equal(rows.length, 1, `${width}/${stepTurnIndex}: ${rows.map(([, line]) => plain(line)).join(' | ')}`);
      const [index, line] = rows[0];
      // The head row of the selected turn: its number, its clock, its text.
      const inverse = plain(/\x1b\[7m(.*?)\x1b\[27m/.exec(line)[1]);
      assert.match(inverse, new RegExp(`^ +${turns[stepTurnIndex].number}  `), `${width}/${stepTurnIndex}: ${inverse}`);
      assert.ok(line.startsWith('\x1b[7m'), `${width}/${stepTurnIndex}: the whole row is inverse from its first cell`);
      // SGR only: every row keeps its text and width.
      assert.deepEqual(lines.map(plain), untouched.map(plain), `${width}/${stepTurnIndex}: the cursor changed text`);
      at.push(index);
    }
    assert.ok(at[1] > at[0], `${width}: the cursor did not move down with the selection (${at})`);
  };
  for (const width of [55, 200]) check(width);

  const previous = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    for (const width of [55, 200]) {
      const lines = render(model, width, { stepTurnIndex: turns.length - 2 });
      assert.equal(inverseRows(lines).length, 1, `ascii ${width}: the cursor survives ASCII mode`);
      const codes = lines.join('\n').match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
      assert.ok(codes.every((code) => /^\x1b\[(?:0|1|2|7|22|27)m$/.test(code)), codes.join(','));
    }
  } finally {
    if (previous == null) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = previous;
  }
});

test('the transcript cursor is one inverse tool row, and Enter opens its captured fields, in ASCII mode too', () => {
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId, shortId: state.shortId, runDir: realClaudeRun, state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow, follow: false, view: 'detail' });
  // Every turn carries its tool rows in the detail view (rule 12).
  const tools = model.presentation.activity.turns.flatMap((turn) => turn.toolRows);
  assert.ok(tools.length >= 3, 'the real transcript has tool rows to select');
  const inverseRows = (lines) => lines
    .map((line, index) => [index, line])
    .filter(([, line]) => line.includes('\x1b[7m') && !isToggleRule(line));
  const check = (width) => {
    const untouched = render(model, width, { stepView: 'detail' });
    assert.deepEqual(inverseRows(untouched), [], `${width}: the transcript has no cursor before navigation`);
    const selected = (tool, opened = false) => render(model, width, {
      stepView: 'detail', stepSelectedEventIndex: tool.index, stepDetail: opened,
    });
    const first = selected(tools[1]);
    const second = selected(tools[2]);
    const firstRows = inverseRows(first);
    const secondRows = inverseRows(second);
    assert.equal(firstRows.length, 1, `${width}: ${firstRows.map(([, line]) => plain(line)).join(' | ')}`);
    assert.equal(secondRows.length, 1, `${width}: ${secondRows.map(([, line]) => plain(line)).join(' | ')}`);
    const [firstIndex, firstLine] = firstRows[0];
    const [secondIndex, secondLine] = secondRows[0];
    assert.ok(firstLine.startsWith('\x1b[7m'), `${width}: the cursor starts at the row's first cell`);
    // The row is clock · kind · summary, as the expanded overview turn draws it.
    assert.match(plain(firstLine), new RegExp(`^ {12}${tools[1].clock}  `), `${width}: ${plain(firstLine)}`);
    assert.match(plain(secondLine), new RegExp(`^ {12}${tools[2].clock}  `), `${width}: ${plain(secondLine)}`);
    assert.ok(secondIndex > firstIndex, `${width}: the cursor moves down with the next row (${firstIndex}, ${secondIndex})`);
    assert.deepEqual(first.map(plain), untouched.map(plain), `${width}: the cursor changed transcript text`);
    // Enter opens every captured field of the row's events under it, nothing
    // the 0.35.1 atomic rows showed is lost: the same field names, in full.
    const opened = selected(tools[1], true).map(plain);
    const openedText = opened.join('\n');
    assert.equal(opened.length > untouched.length, true, `${width}: the open row added its fields`);
    const byIndex = new Map(model.activity.events.map((event) => [event.index, event]));
    for (const index of tools[1].eventIndices) {
      assert.match(openedText, new RegExp(`seq ${byIndex.get(index).seq} · `), `${width}: event ${index} opened`);
    }
    for (const name of ['kind', 'status', 'eventId', 'turnId', 'toolCallId', 'provider timestamp', 'duration', 'usage', 'parent/subagent', 'arguments', 'result', 'summary']) {
      assert.ok(openedText.includes(name), `${width}: the open row names ${name}`);
    }
    return secondIndex;
  };
  const positions = [55, 200].map(check);
  assert.ok(positions.every((position) => Number.isInteger(position)), `cursor rows: ${positions}`);

  const previous = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    const selected = render(model, 55, {
      stepView: 'detail', stepSelectedEventIndex: tools[1].index, stepDetail: true,
    }).join('\n');
    assert.match(selected, /\x1b\[7m {12}(?:\x1b\[[0-9;]*m)*\d\d:\d\d:\d\d/, 'ASCII mode keeps the inverse tool row');
    const codes = selected.match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
    assert.ok(codes.every((code) => /^\x1b\[(?:0|1|2|7|22|27)m$/.test(code)), codes.join(','));
  } finally {
    if (previous == null) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = previous;
  }
});

test('running Step marks and ASCII mode obey the colour contract', () => {
  const running = structuredClone(makeModels().running);
  running.presentation.activity.turns[0].expanded = true;
  const raw = render(running, 200).join('\n');
  assert.ok(raw.includes(`${rgb(METER_COLORS.amber)}▶\x1b[0m`), 'running turn mark is amber');

  const previous = process.env.BULLSWARM_ASCII;
  try {
    process.env.BULLSWARM_ASCII = '1';
    const ascii = render(makeModels().finished, 55).join('\n');
    const codes = ascii.match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
    assert.ok(codes.every((code) => /^\x1b\[(?:0|1|2|7|22|27)m$/.test(code)), codes.join(','));
    assert.doesNotMatch(ascii, /\x1b\[38;2;/);
    // At 200 the block rules are wide enough to build the `following *` matcher;
    // the ASCII ongoing glyph is a regex quantifier and once threw here.
    for (const model of [makeModels().finished, makeModels().running]) {
      const wide = render(model, 200).join('\n');
      const wideCodes = wide.match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
      assert.ok(wideCodes.every((code) => /^\x1b\[(?:0|1|2|7|22|27)m$/.test(code)), wideCodes.join(','));
      assert.ok(wide.includes('\x1b[1m'), 'ASCII mode keeps bold identity');
    }
  } finally {
    if (previous == null) delete process.env.BULLSWARM_ASCII;
    else process.env.BULLSWARM_ASCII = previous;
  }
});

test('running, finished, and failed Step frames stay width-bounded in both views', () => {
  const models = makeModels();
  mkdirSync(frameDir, { recursive: true });
  for (const [state, model] of Object.entries(models)) {
    for (const view of ['overview', 'detail']) for (const width of [55, 120, 200]) {
      const lines = renderDashboardFrame(model, width, { stepView: view });
      for (const line of lines) assert.ok([...plain(line)].length <= width, `${state}-${width}: ${plain(line)}`);
      const direct = render(model, width, { stepView: view });
      // The shell footer owns the toggle hint once and names the other view;
      // the direct body no longer spends a scrollable row on it.
      const wider = width >= 120;
      assert.doesNotMatch(direct.map(plain).join('\n'), view === 'overview'
        ? (wider ? /v detail \(every turn in full\)/ : /v detail/)
        : (wider ? /v overview \(latest turns\)/ : /v overview/));
      const dashboard = renderDashboardFrame(model, width, { stepView: view }).join('\n');
      assert.match(dashboard, view === 'overview'
        ? (wider ? /v detail \(every turn in full\)/ : /v detail/)
        : (wider ? /v overview \(latest turns\)/ : /v overview/));
      // Rule 14: the toggle sits in the activity rule, the top bar has none.
      assert.doesNotMatch(plain(dashboard.split('\n')[0]), /overview|detail/);
      assert.match(dashboard.split('\n').map(plain).join('\n'), view === 'overview'
        ? /^── activity · overview · detail/m : /^── transcript · overview · detail/m);
      writeFileSync(join(frameDir, `rendered-${state}-${view}-${width}.txt`), `${lines.map(plain).join('\n')}\n`);
    }
  }
});

test('the desk draws two columns and the phone stacks result → activity → task → cost', () => {
  const { running, finished } = makeModels();
  const desk = render(running, 200).map(plain);
  const rule = desk.find((line) => line.startsWith('── activity ·'));
  assert.ok(rule, 'the activity rule is on the desk');
  assert.match(rule, / ── result · not yet /);
  assert.match(rule.slice(0, 132), /^── activity · overview · detail · 2 turns so far · 3 commands · 0 edits · 0 errors ─+ showing turns · t to change ── following ●$/);
  assert.equal([...rule.slice(0, 132)].length, 132);
  assert.ok(desk.some((line) => /^── task /.test(line.slice(135))), 'task card on the right');
  assert.ok(desk.some((line) => /^── cost /.test(line.slice(135))), 'cost card on the right');
  const finishedDesk = render(finished, 200).map(plain);
  assert.ok(finishedDesk.some((line) => /^── result · succeeded · verified 1\/1 /.test(line.slice(135))));
  // 120 keeps the two columns with the narrower right column; 55 stacks.
  const narrow = render(running, 120).map(plain);
  const narrowRule = narrow.find((line) => line.startsWith('── activity ·'));
  assert.ok(narrowRule, '120 columns keeps the two columns');
  assert.equal([...narrowRule.slice(0, 77)].length, 77);
  // The toggle is never cut; the filter control gave way to it first.
  assert.match(narrowRule.slice(0, 77), /^── activity · overview · detail · 2 turns so far · 3 cmds · 0 edits ─+$/);
  assert.ok(narrow.filter((line) => line.includes(' │ ')).every((line) => [...line].length <= 120));
  assert.equal(render(finished, 55).map(plain).some((line) => line.includes(' │ ')), false);
});

test('running activity leads with the now block and keeps the filter control', () => {
  const base = makeModels().running;
  const model = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 3, follow: false, activityFilter: 'tools' });
  const selected = render(model, 120, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  const text = selected.map(plain).join('\n');
  assert.match(text, /● step-view · stefx · running · attempt 1 of 1/);
  // The control and the last zero count gave way to the toggle in the 77-cell column.
  assert.match(text, /── activity · overview · detail · 2 turns so far · 3 cmds · 0 edits ─/);
  // The control has room beside the toggle on the wide desk.
  const wide = render(model, 200, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  assert.match(wide.map(plain).join('\n'), /── activity · overview · detail · .* showing tools · t to change/);
  assert.doesNotMatch(text, /following ●/);
  assert.match(text, /· 1 command\b/);
  const filtered = render(model, 55, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  assert.match(filtered.map(plain).join('\n'), /now · 7 events · 3 cmds · 0 edits · 0 err/);

  const detailModel = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 6, follow: false, view: 'detail' });
  const detail = render(detailModel, 55, { stepView: 'detail', stepDetail: true, stepSelectedEventIndex: 6, stepFollow: false });
  assert.match(detail.map(plain).join('\n'), /── transcript · overview · detail · 2 turns ─/);
  assert.match(detail.map(plain).join('\n'), /seq 7 · 2026-09-19T17:51/);
  assert.match(detail.map(plain).join('\n'), /eventId|toolCallId|duration/i);

  const expanded = render(stepPageModel(base.modelInput, { nowMs: fixedNow, expandedTurn: 0 }), 120);
  const expandedText = expanded.map(plain).join('\n');
  assert.match(expandedText, /▶ 1  01:50  sample dolor qui excepteur amet non sit/);
  assert.match(expandedText, /2 commands · Esc closes/);
  assert.match(expandedText, /01:50:35  \$ inspect task and repository guidance/);
  assert.match(expandedText, /01:50:46  \$ inspect dependency reports and stream contract/);
  assert.doesNotMatch(expandedText, /\s0s(?:\s|$)/);
  // The captured shell wrapper never reaches the row: the command itself does.
  assert.doesNotMatch(expandedText, /\/bin\/zsh -lc/);
});

test('expanded turns pin the newest tool window and fold earlier rows first', () => {
  const model = structuredClone(makeModels().running);
  const activity = model.presentation.activity;
  const turn = activity.turns[0];
  turn.expanded = true;
  turn.toolRows = [
    { index: 1, clock: '01:50:01', kind: 'command_execution', command: true, text: 'command 1', durationText: '1s', inFlight: false },
    { index: 2, clock: '01:50:02', kind: 'command_execution', command: true, text: 'command 2', durationText: '1s', inFlight: false },
    { index: 3, clock: '01:50:03', kind: 'command_execution', command: true, text: 'command 3', durationText: '1s', inFlight: false },
    { index: 4, clock: '01:50:04', kind: 'command_execution', command: true, text: 'command 4', durationText: '1s', inFlight: false },
    { index: 5, clock: '01:50:05', kind: 'command_execution', command: true, text: 'command 5', durationText: '1s', inFlight: false },
    { index: 6, clock: '01:50:06', kind: 'command_execution', command: true, text: 'command 6', durationText: '1s', inFlight: false },
    { index: 7, clock: '01:50:07', kind: 'command_execution', command: true, text: 'command 7', durationText: '1s', inFlight: false },
    { index: 8, clock: '01:50:08', kind: 'command_execution', command: true, text: 'command 8', durationText: '1s', inFlight: false },
    { index: 9, clock: '01:50:09', kind: 'command_execution', command: true, text: 'command 9', durationText: '1s', inFlight: true },
  ];
  activity.expandedTurn = turn.index;
  activity.following = false;
  activity.running = true;

  const newest = render(model, 120, { stepToolPage: 0 }).map(plain).join('\n');
  assert.match(newest, /↑ 6 earlier commands · Space page up/);
  assert.ok(newest.indexOf('command 7') < newest.indexOf('command 8'));
  assert.ok(newest.indexOf('command 8') < newest.indexOf('command 9'));
  assert.doesNotMatch(newest, /command 1/);

  const older = render(model, 120, { stepToolPage: 1 }).map(plain).join('\n');
  assert.match(older, /↑ 3 earlier commands · Space page up/);
  assert.ok(older.indexOf('command 4') < older.indexOf('command 5'));
  assert.ok(older.indexOf('command 5') < older.indexOf('command 6'));
  assert.doesNotMatch(older, /command 9/);

  const forcedNewest = toolRowWindow(turn, { page: 99, running: true, following: true });
  assert.equal(forcedNewest.page, 0);
  assert.deepEqual(forcedNewest.rows.map((row) => row.text), ['command 7', 'command 8', 'command 9']);
  activity.following = true;
  const followed = render(model, 120, { stepToolPage: 99 }).map(plain).join('\n');
  assert.ok(followed.indexOf('command 7') < followed.indexOf('command 8'));
  assert.ok(followed.indexOf('command 8') < followed.indexOf('command 9'));
  assert.doesNotMatch(followed, /command 1/);
});

test('the earlier-row fold noun agrees for commands, edits, and mixed tools', () => {
  const categories = { command_execution: 'command', file_change: 'edit' };
  const rows = (items) => items.map((entry, index) => ({
    index,
    kind: entry.kind,
    category: categories[entry.kind] ?? 'other',
    command: entry.kind === 'command_execution',
    text: entry.text,
    inFlight: false,
  }));
  const renderFold = (items) => {
    const model = structuredClone(makeModels().running);
    const activity = model.presentation.activity;
    const turn = activity.turns[0];
    turn.expanded = true;
    turn.toolRows = rows(items);
    activity.expandedTurn = turn.index;
    activity.following = false;
    activity.running = false;
    return render(model, 120).map(plain).join('\n');
  };
  const commandWindow = toolRowWindow({ toolRows: rows([
    { kind: 'command_execution', text: 'one' },
    { kind: 'command_execution', text: 'two' },
    { kind: 'command_execution', text: 'three' },
    { kind: 'command_execution', text: 'four' },
  ]) });
  assert.equal(commandWindow.earlierCount, 1);
  assert.match(renderFold([
    { kind: 'command_execution', text: 'one' },
    { kind: 'command_execution', text: 'two' },
    { kind: 'command_execution', text: 'three' },
    { kind: 'command_execution', text: 'four' },
  ]), /↑ 1 earlier command · Space page up/);
  const editWindow = toolRowWindow({ toolRows: rows([
    { kind: 'file_change', text: 'one' },
    { kind: 'file_change', text: 'two' },
    { kind: 'file_change', text: 'three' },
    { kind: 'file_change', text: 'four' },
    { kind: 'file_change', text: 'five' },
  ]) });
  assert.equal(editWindow.earlierCount, 2);
  assert.match(renderFold([
    { kind: 'file_change', text: 'one' },
    { kind: 'file_change', text: 'two' },
    { kind: 'file_change', text: 'three' },
    { kind: 'file_change', text: 'four' },
    { kind: 'file_change', text: 'five' },
  ]), /↑ 2 earlier edits · Space page up/);
  const mixedWindow = toolRowWindow({ toolRows: rows([
    { kind: 'command_execution', text: 'one' },
    { kind: 'file_change', text: 'two' },
    { kind: 'WebFetch', text: 'three' },
    { kind: 'WebFetch', text: 'four' },
    { kind: 'WebFetch', text: 'five' },
  ]) });
  assert.equal(mixedWindow.earlierCount, 2);
  assert.equal(new Set(mixedWindow.rows.map((row) => row.text)).size, 3);
  assert.match(renderFold([
    { kind: 'command_execution', text: 'one' },
    { kind: 'file_change', text: 'two' },
    { kind: 'WebFetch', text: 'three' },
    { kind: 'WebFetch', text: 'four' },
    { kind: 'WebFetch', text: 'five' },
  ]), /↑ 2 earlier tools · Space page up/);
});

test('money is said once in two plain-word rows under one header', () => {
  // A live attempt with no usage says when the figure will exist rather than
  // printing a guess; the plan row still names the pool's meter state.
  const running = render(makeModels().running, 120).map(plain).join('\n');
  assert.equal((running.match(/API rate/g) ?? []).length, 0);
  assert.match(running, /measured when the attempt finishes/);
  assert.match(running, /codex · gpt-5\.6-luna · medium effort/);
  assert.doesNotMatch(running, /compatibility ·/);
  assert.doesNotMatch(running, /UNAVAILABLE|level unavailable/);

  const finished = render(makeModels().finished, 200).map(plain).join('\n');
  assert.equal((finished.match(/API rate/g) ?? []).length, 1);
  assert.match(finished, / API rate    ≈ \$0\.000556\s+2k tokens · legacy estimate/);
  assert.match(finished, /codex plan  —       no meter reading for this attempt/);
  assert.match(finished, /estimated from the codex output bytes/);
});

test('the rendered multi-attempt cost block names cards, selected share, and pool plans', () => {
  assert.ok(existsSync(join(realClaudeRun, 'state.json')), `real snapshot missing: ${realClaudeRun}`);
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realClaudeRun,
    state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow });
  const text = render(model, 200).map(plain).join('\n');
  assert.match(text, /── cost · 5 attempts /);
  assert.ok(text.includes('xAI + Anthropic rate cards,'));
  assert.ok(text.includes('20 Sep'));
  assert.ok(text.includes('this attempt $28.21 · 45.95M tokens · Anthropic rate'));
  assert.ok(text.includes('card'));
  assert.match(text, /plans\s+—\s+grok \$30\/mo · claude-code \$200\/mo/);
  assert.doesNotMatch(text, /\$660\/mo/);
  assert.match(text, /measured from the recorded attempts/);
});

test('historical and failed frames state unavailable fields and preserve money bases', () => {
  const { finished, failed } = makeModels();
  const historical = render(finished, 120).map(plain).join('\n');
  assert.match(historical, /event stream unavailable/);
  assert.match(historical, /succeeded · verified 1\/1/);
  assert.match(historical, /verified by the workflow \(1\/1 requirements\)/);
  assert.match(historical, /≈ \$0\.000556/);
  const retry = render(failed, 120).map(plain).join('\n');
  assert.match(retry, /attempt 2 of 2/);
  assert.match(retry, /failed · not verified 0\/1/);
  assert.match(retry, /not verified \(0\/1 requirements\)/);
  assert.match(retry, /API rate {4}—/);
  assert.doesNotMatch(retry, /\$0\.00/);
  assert.match(retry, /event stream unavailable/);
  assert.match(retry, /failed   provider stream reported error/);
});

test('estimated figures always carry a basis marker and never become bare dollars', () => {
  const { finished, failed } = makeModels();
  for (const text of [render(finished, 55).map(plain).join('\n'), render(failed, 55).map(plain).join('\n')]) {
    for (const match of text.matchAll(/\$/g)) {
      const before = text.slice(Math.max(0, match.index - 2), match.index);
      assert.ok(before.includes('~') || before.includes('≈'), `bare dollar in ${text.slice(Math.max(0, match.index - 15), match.index + 8)}`);
    }
  }
});

test('estimated figures always carry a basis marker and never become bare dollars', () => {
  const { finished, failed } = makeModels();
  for (const text of [render(finished, 55).map(plain).join('\n'), render(failed, 55).map(plain).join('\n')]) {
    for (const match of text.matchAll(/\$/g)) {
      const before = text.slice(Math.max(0, match.index - 2), match.index);
      assert.ok(before.includes('~') || before.includes('≈'), `bare dollar in ${text.slice(Math.max(0, match.index - 15), match.index + 8)}`);
    }
  }
});

// Step-v2 rules 12–14 (0.35.2): the transcript, the latest-turns window and
// the one toggle, on the 31-turn real claude-code attempt.
function realClaudeModel(options = {}) {
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  return stepPageModel({
    runId: state.runId, shortId: state.shortId, runDir: realClaudeRun, state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow, ...options });
}

/** A body like the shell's: lines, click regions, anchors. */
function regionBody() {
  return { lines: [], regions: [], push(line = '') { this.lines.push(String(line)); } };
}

test('the overview opens on the newest ten turns on the desk and five on the phone, under one fold line', () => {
  const model = realClaudeModel();
  const turns = model.presentation.activity.turns;
  assert.equal(turns.length, 31);
  for (const [width, limit] of [[200, 10], [55, 5]]) {
    // The activity column only: on the desk the right column follows the divider.
    const lines = render(model, width).map(plain).map((line) => (width >= 160 ? line.slice(0, 132).trimEnd() : line));
    const heads = lines.map((line) => line.match(/^ {0,2}(\d+) {2}\d\d:\d\d {2}/)?.[1]).filter(Boolean).map(Number);
    const newest = turns.slice(-limit).map((turn) => turn.number);
    assert.deepEqual(heads, newest, `${width}: the window is the newest ${limit} turns, newest at the bottom`);
    // One dim line above them stands for the rest, with their own counts.
    const hidden = turns.slice(0, -limit);
    const fold = lines.find((line) => /^ turns 1–\d+ · /.test(line));
    assert.ok(fold, `${width}: the fold line is drawn`);
    assert.match(fold, new RegExp(`^ turns 1–${hidden.at(-1).number} · .*click for detail$`));
    const sum = (field) => hidden.reduce((total, turn) => total + (turn.summary?.[field] ?? 0), 0);
    if (width === 200) assert.ok(fold.includes(`${sum('commands')} commands`), fold);
    assert.ok(lines.indexOf(fold) < lines.findIndex((line) => line.startsWith(`${String(newest[0]).padStart(3)}  `)),
      `${width}: the fold line sits above the window`);
  }
  // The fold line's text is dim meta, and zero classes never print.
  const raw = render(model, 200).join('\n');
  assert.match(raw, /\x1b\[2mturns 1–21 · [^\x1b]*click for detail\x1b\[0m/);
  assert.doesNotMatch(render(model, 200).map(plain).find((line) => line.startsWith(' turns 1–')), / 0 /);
});

test('the fold line keeps `click for detail`, dropping counts to fit, and names a single turn', () => {
  const turn = (number, summary, otherKinds = []) => ({ number, summary, otherKinds });
  const hidden = [
    turn(1, { commands: 300, filesRead: 0, edits: 12, otherTools: 0, errors: 0 }),
    turn(2, { commands: 12, filesRead: 4, edits: 8, otherTools: 2, errors: 1 }, ['web search']),
  ];
  assert.equal(foldLineText(hidden), 'turns 1–2 · 312 commands · 4 files read · 20 edits · 2 web search · 1 error · click for detail');
  assert.equal(foldLineText(hidden, 50), 'turns 1–2 · 312 commands · click for detail');
  assert.equal(foldLineText(hidden, 10), 'turns 1–2 · click for detail');
  assert.equal(foldLineText([turn(1, {})]), 'turn 1 · click for detail');
  // Searches count in the fold as they do in each turn row (gbnq62 verify: 17 searches were missing).
  assert.equal(foldLineText([turn(1, { commands: 3, filesRead: 35, searches: 17, errors: 1 })]), 'turn 1 · 3 commands · 35 files read · 17 searches · 1 error · click for detail');
  assert.equal(foldLineText([]), null);
});

test('the window slides while a running step is followed and stays put once the reader stops', () => {
  const turns = Array.from({ length: 14 }, (_, index) => ({ index, number: index + 1 }));
  const numbers = (window) => window.shown.map((turn) => turn.number);
  assert.deepEqual(numbers(overviewWindow(turns, { limit: 10, following: true })), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  // Two more turns arrive: following slides the window, a pinned one does not.
  const grown = turns.concat([{ index: 14, number: 15 }, { index: 15, number: 16 }]);
  assert.deepEqual(numbers(overviewWindow(grown, { limit: 10, following: true })), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const pinned = overviewWindow(grown, { limit: 10, windowEnd: 14, following: false });
  assert.deepEqual(numbers(pinned), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(pinned.hidden.map((turn) => turn.number), [1, 2, 3, 4]);
  assert.equal(pinned.end, 14);
  // Following again wins over the pin; a short step shows every turn.
  assert.deepEqual(numbers(overviewWindow(grown, { limit: 10, windowEnd: 14, following: true })).at(-1), 16);
  assert.deepEqual(numbers(overviewWindow(turns.slice(0, 3), { limit: 5 })), [1, 2, 3]);
});

test('the overview cursor can sit on the fold line, and turn heads and the fold are click regions lit on their text only', () => {
  const model = realClaudeModel();
  for (const width of [55, 200]) {
    const body = regionBody();
    renderStepPage(model, { width, nowMs: fixedNow, stepView: 'overview' }, body);
    const anchor = body.anchor.step;
    const fold = anchor.rows.find((row) => row.kind === 'fold');
    const heads = anchor.rows.filter((row) => row.kind === 'turn');
    assert.equal(heads.length, width < 100 ? 5 : 10);
    // The cursor starts on the newest turn.
    assert.equal(anchor.cursorTurn, 30);
    assert.equal(anchor.cursor, heads.at(-1).y);
    // A click on a turn head is Enter on it; on the fold line it opens detail.
    const regionAt = (y) => body.regions.find((region) => region.y === y);
    assert.deepEqual(regionAt(fold.y).action, { kind: 'stepView', view: 'detail', fromFold: true });
    for (const head of heads) {
      const region = regionAt(head.y);
      assert.deepEqual(region.action, { kind: 'stepTurn', turnIndex: head.turnIndex });
      const text = plain(body.lines[head.y - 1]);
      // Text only: the region ends where the turn head's own words end, never
      // on the padding or across the divider into the right column.
      const own = width >= 160 ? text.slice(0, 132) : text;
      assert.equal(region.x1, 1);
      assert.equal(region.x2, own.replace(/\s+$/, '').length, `${width}: ${text}`);
    }
    const onFold = render(model, width, { stepTurnIndex: -1 });
    const inverse = onFold.filter((line) => line.includes('\x1b[7m') && !isToggleRule(line));
    assert.equal(inverse.length, 1, `${width}: one cursor on the fold line`);
    assert.match(plain(inverse[0]), /^ turns 1–\d+ · /);
  }
});

test('the transcript lists every turn in full with one row per tool, and every row is a click region', () => {
  const model = realClaudeModel({ view: 'detail' });
  const turns = model.presentation.activity.turns;
  const body = regionBody();
  renderStepPage(model, { width: 200, nowMs: fixedNow, stepView: 'detail' }, body);
  const lines = body.lines.map(plain);
  assert.match(lines.find((line) => line.startsWith('── transcript ·')), /── transcript · overview · detail · 31 turns · /);
  const anchor = body.anchor.step;
  assert.equal(anchor.view, 'detail');
  assert.deepEqual(anchor.rows.filter((row) => row.kind === 'turn').map((row) => row.number), turns.map((turn) => turn.number));
  const toolRows = anchor.rows.filter((row) => row.kind === 'tool');
  assert.equal(toolRows.length, turns.reduce((total, turn) => total + turn.toolRows.length, 0));
  // The last turn is printed in full here, not pointed at the result card.
  assert.equal(lines.some((line) => line.includes('→ the report, shown under result')), false);
  assert.ok(lines.some((line) => line.includes(turns.at(-1).text.split('\n')[0].slice(0, 40))));
  // Rows are head → text → counts → tools, in turn order down the page.
  const ys = anchor.rows.map((row) => row.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  for (const row of anchor.rows) {
    const region = body.regions.find((entry) => entry.y === row.y);
    assert.deepEqual(region.action, { kind: 'stepTool', eventIndex: row.index });
  }
  // No row falls outside the activity column.
  assert.ok(body.regions.every((region) => region.x2 <= 132));
});

test('the transcript filter narrows to tool turns or error rows', () => {
  const model = realClaudeModel({ view: 'detail', activityFilter: 'errors' });
  const turns = model.presentation.activity.turns;
  const lines = render(model, 200, { stepView: 'detail' }).map(plain);
  const errorRows = turns.flatMap((turn) => turn.toolRows.filter((tool) => tool.error));
  const shownHeads = lines.filter((line) => /^ {0,2}\d+ {2}\d\d:\d\d {2}/.test(line));
  assert.equal(shownHeads.length, turns.filter((turn) => turn.toolRows.some((tool) => tool.error)).length);
  const toolLines = lines.filter((line) => /^ {12}\d\d:\d\d:\d\d  /.test(line));
  assert.equal(toolLines.length, errorRows.length);
});

test('the toggle marks the current view and each word switches to its view', () => {
  for (const view of ['overview', 'detail']) {
    const toggle = stepViewToggle(view);
    assert.equal(plain(toggle.text), 'overview · detail');
    const inverse = /\x1b\[7m(.*?)\x1b\[0m/.exec(toggle.text)?.[1];
    assert.equal(inverse, view);
    assert.deepEqual(toggle.regions.map((region) => region.action), [
      { kind: 'stepView', view: 'overview' },
      { kind: 'stepView', view: 'detail' },
    ]);
    assert.deepEqual(toggle.regions.map((region) => [region.x, region.width]), [[1, 8], [12, 6]]);
  }
});

test('the activity rule carries the toggle at 55 and 200, both views, running and finished, never dropped or cut', () => {
  const { running, finished } = makeModels();
  const words = { overview: 'overview', detail: 'detail' };
  for (const [state, model] of Object.entries({ running, finished })) for (const view of ['overview', 'detail']) for (const width of [55, 200]) {
    const label = `${state}/${view}/${width}`;
    const body = regionBody();
    const header = renderStepPage(model, { width, nowMs: fixedNow, stepView: view }, body);
    // Every line fits its width in display cells, on the desk's two columns too.
    for (const line of [header, ...body.lines]) assert.ok([...plain(line)].length <= width, `${label}: ${plain(line)}`);
    const at = body.lines.findIndex((line) => /^(\x1b\[2m)?──(\x1b\[0m)? (activity|transcript) · /.test(line));
    assert.ok(at >= 0, `${label}: the activity rule is painted`);
    const raw = body.lines[at];
    const text = plain(raw);
    const column = width >= 160 ? text.slice(0, 132) : text;
    // The heading word, then the toggle straight after it, before any count.
    assert.match(column, new RegExp(`^── ${view === 'detail' ? 'transcript' : 'activity'} · overview · detail( · |\\s|─)`), label);
    // The current view is inverse, the other word plain.
    const inverse = view === 'overview' ? '\x1b[7moverview\x1b[0m · detail' : 'overview · \x1b[7mdetail\x1b[0m';
    assert.ok(raw.includes(inverse), `${label}: ${JSON.stringify(raw.slice(0, 120))}`);
    assert.equal(raw.match(/\x1b\[7m/g).length, 1, `${label}: exactly one inverse word`);
    // Each word is a click region over exactly its own cells.
    const regions = body.regions.filter((region) => region.y === at + 1);
    assert.deepEqual(regions.map((region) => region.action), [
      { kind: 'stepView', view: 'overview' },
      { kind: 'stepView', view: 'detail' },
    ], label);
    assert.deepEqual(regions.map((region) => column.slice(region.x1 - 1, region.x2)), [words.overview, words.detail], label);
    assert.ok(regions.every((region) => region.x2 <= (width >= 160 ? 132 : width)), `${label}: regions stay in the column`);
  }
});

test('a narrow rule sheds the control and dashes first, then counts, and keeps the toggle whole', () => {
  const model = realClaudeModel();
  const ruleAt = (width, view = 'overview') => render(model, width, { stepView: view })
    .map(plain).map((line) => (width >= 160 ? line.slice(0, 132).trimEnd() : line)).find((line) => /^── (activity|transcript) · /.test(line));
  // Wide: counts, the whole control, dashes.
  assert.match(ruleAt(200), /^── activity · overview · detail · 31 turns · 231 commands · 1 edit · 1 error ─+ showing turns · t to change ─+$/);
  assert.match(ruleAt(200, 'detail'), /^── transcript · overview · detail · 31 turns · 231 commands · 1 edit · 1 error ─+ showing all · t to change ─+$/);
  // The 78-cell desk column: the control goes before any count does.
  assert.match(render(model, 120).map(plain).find((line) => line.startsWith('── activity ·')).slice(0, 77), /^── activity · overview · detail · 31 turns · 231 cmds · 1 edit · 1 err ─+$/);
  // The phone: counts shorten from the end while the toggle stays whole.
  assert.match(ruleAt(55), /^── activity · overview · detail · 31 turns ─+$/);
  assert.match(ruleAt(55, 'detail'), /^── transcript · overview · detail · 31 turns ─+$/);
  assert.match(ruleAt(40), /^── activity · overview · detail ─+$/);
  for (const width of [55, 40, 34]) {
    for (const view of ['overview', 'detail']) {
      const rule = ruleAt(width, view);
      assert.ok(rule.includes('overview · detail'), `${width}/${view}: ${rule}`);
      assert.ok([...rule].length <= width, `${width}/${view}: ${rule}`);
    }
  }
});

test('the Step v2 record quotes the transcript frames the code renders, beside the 0.35.1 frames it replaced', async () => {
  const { buildTranscriptFrames, STEP_V2_DIR, TRANSCRIPT_WIDTHS } = await import('../scripts/render-tidy-0.35.1-frames.mjs');
  const frames = buildTranscriptFrames();
  const committed = (name) => readFileSync(new URL(name, STEP_V2_DIR), 'utf8').replace(/\n$/, '').split('\n');
  assert.equal(frames.size, 8);
  for (const [name, lines] of frames) {
    assert.deepEqual(committed(name), lines, `${name} on disk is stale — rerun scripts/render-tidy-0.35.1-frames.mjs`);
  }
  for (const width of TRANSCRIPT_WIDTHS) {
    const before = committed(`0.35.2-before-overview-finished-${width}.txt`).join('\n');
    const after = frames.get(`0.35.2-overview-finished-${width}.txt`).join('\n');
    // Before: every turn, the toggle only in the footer. After: the window,
    // its fold line and the toggle in the activity rule.
    assert.match(before, /^ {0,2}1 {2}01:50 {2}/m);
    assert.match(before, width < 100 ? /v detail/ : /v detail \(every event\)/);
    assert.equal(before.split('\n')[0], ' Home  Runs  Budget  Stats  Fleet');
    assert.doesNotMatch(after, /^ {0,2}1 {2}01:50 {2}/m);
    assert.match(after, /^ turns 1–(5|10) · .*click for detail/m);
    assert.equal(after.split('\n')[0], ' Home  Runs  Budget  Stats  Fleet');
    assert.match(after, /^── activity · overview · detail · /m);
    assert.match(committed(`0.35.2-before-detail-finished-${width}.txt`).join('\n'), /detail · today's capture-order log/);
    assert.match(frames.get(`0.35.2-detail-finished-${width}.txt`).join('\n'), /── transcript · overview · detail · 15 turns/);
    assert.match(frames.get(`0.35.2-detail-tool-open-${width}.txt`).join('\n'), /seq \d+ · 2026-09-19T17:51:12\.686Z/);
  }
});
