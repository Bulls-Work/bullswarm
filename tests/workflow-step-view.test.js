import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stepPageModel } from '../src/workflow/step-model.js';
import { renderStepPage, toolRowWindow } from '../src/workflow/step-view.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const fixtureDir = fileURLToPath(new URL('./fixtures/step-model/', import.meta.url));
const frameDir = '/tmp/bullswarm-step-frames-0.35.1';
const fixedNow = Date.parse('2026-09-19T18:10:00.000Z');
const realClaudeRun = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351/workflows/wf-mu6mv62z-cdcd5d';

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

test('running, finished, and failed Step frames stay width-bounded in both views', () => {
  const models = makeModels();
  mkdirSync(frameDir, { recursive: true });
  for (const [state, model] of Object.entries(models)) {
    for (const view of ['overview', 'detail']) for (const width of [55, 120, 200]) {
      const lines = renderDashboardFrame(model, width, { stepView: view });
      for (const line of lines) assert.ok([...plain(line)].length <= width, `${state}-${width}: ${plain(line)}`);
      const direct = render(model, width, { stepView: view });
      // The toggle hint lives in the footer, once, and names the other view;
      // the phone drops the parenthetical so the hint fits its line.
      const wider = width >= 120;
      assert.match(direct.map(plain).join('\n'), view === 'overview'
        ? (wider ? /v detail \(every event\)/ : /v detail/)
        : (wider ? /v overview \(turns\)/ : /v overview/));
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
  assert.match(rule.slice(0, 132), /showing turns · t to change ── following ●$/);
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
  assert.match(narrowRule.slice(0, 77), /showing turns/);
  assert.ok(narrow.filter((line) => line.includes(' │ ')).every((line) => [...line].length <= 120));
  assert.equal(render(finished, 55).map(plain).some((line) => line.includes(' │ ')), false);
});

test('running activity leads with the now block and keeps the filter control', () => {
  const base = makeModels().running;
  const model = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 3, follow: false, activityFilter: 'tools' });
  const selected = render(model, 120, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  const text = selected.map(plain).join('\n');
  assert.match(text, /● step-view · stefx · running · attempt 1 of 1/);
  assert.match(text, /showing tools/);
  assert.match(text, /2 turns so far · 3 cmds · 0 edits · 0 err/);
  assert.doesNotMatch(text, /following ●/);
  assert.match(text, /· 1 command\b/);
  const filtered = render(model, 55, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  assert.match(filtered.map(plain).join('\n'), /showing tools/);
  assert.match(filtered.map(plain).join('\n'), /now · 7 events · 3 cmds · 0 edits · 0 err/);

  const detailModel = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 6, follow: false });
  const detail = render(detailModel, 55, { stepDetail: true, stepSelectedEventIndex: 6, stepFollow: false });
  assert.match(detail.map(plain).join('\n'), /detail · today's capture-order log · all · 7 events/);
  assert.match(detail.map(plain).join('\n'), /seq 7 · 2026-09-19T17:51/);
  assert.match(detail.map(plain).join('\n'), /eventId|toolCallId|duration/i);

  const expanded = render(stepPageModel(base.modelInput, { nowMs: fixedNow, expandedTurn: 0 }), 120);
  const expandedText = expanded.map(plain).join('\n');
  assert.match(expandedText, /▶ 1  01:50  I’ll inspect the task-step file/);
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
  const rows = (items) => items.map((entry, index) => ({
    index,
    kind: entry.kind,
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
