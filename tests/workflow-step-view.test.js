import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stepPageModel } from '../src/workflow/step-model.js';
import { renderStepPage } from '../src/workflow/step-view.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const fixtureDir = fileURLToPath(new URL('./fixtures/step-model/', import.meta.url));
const frameDir = '/tmp/bullswarm-step-frames-0.35.1';
const fixedNow = Date.parse('2026-09-19T18:10:00.000Z');

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
  const header = renderStepPage(model, { width, spinnerFrame: 0, ...options }, body);
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
      assert.match(direct.map(plain).join('\n'), view === 'overview' ? /\[v detail\]/ : /\[v overview\]/);
      writeFileSync(join(frameDir, `rendered-${state}-${view}-${width}.txt`), `${lines.map(plain).join('\n')}\n`);
    }
  }
});

test('running activity exposes turn overview, selection, follow, and filters', () => {
  const base = makeModels().running;
  const model = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 3, follow: false, activityFilter: 'tools' });
  const selected = render(model, 120, { stepSelectedEventIndex: 3, stepFollow: false, stepFilter: 'tools' });
  const text = selected.map(plain).join('\n');
  assert.match(text, /events/);
  assert.match(text, /overview/);
  assert.match(text, /paused/);
  assert.match(text, /\[tools\]/);
  assert.match(text, /2 commands · 0 files read · 0 edits · 0 errors/);
  const detailModel = stepPageModel(base.modelInput, { nowMs: fixedNow, selectedEventIndex: 6, follow: false });
  const detail = render(detailModel, 55, { stepDetail: true, stepSelectedEventIndex: 6, stepFollow: false });
  assert.match(detail.map(plain).join('\n'), /today's capture-order|seq 7/i);
  assert.match(detail.map(plain).join('\n'), /eventId|toolCallId|duration/i);

  const expanded = render(stepPageModel(base.modelInput, { nowMs: fixedNow, expandedTurn: 0 }), 120);
  assert.match(expanded.map(plain).join('\n'), /COMMAND · running|COMMAND · completed/);
});

test('money is rendered once and the header carries pool, model, and effort', () => {
  const running = render(makeModels().running, 120).map(plain).join('\n');
  assert.equal((running.match(/API — pending · subscription — pending/g) ?? []).length, 1);
  assert.match(running, /codex · gpt-5\.6-luna · medium/);
  assert.doesNotMatch(running, /compatibility ·/);
  assert.doesNotMatch(running, /UNAVAILABLE|level unavailable/);
});

test('historical and failed frames state unavailable fields and preserve money bases', () => {
  const { finished, failed } = makeModels();
  const historical = render(finished, 120).map(plain).join('\n');
  assert.match(historical, /event stream unavailable/i);
  assert.match(historical, /VERIFIED/);
  assert.match(historical, /estimated/);
  assert.match(historical, /~ \$0\.00/);
  const retry = render(failed, 120).map(plain).join('\n');
  assert.match(retry, /attempt history|2 attempts/);
  assert.match(retry, /attempt history 2 attempts/);
  assert.match(retry, /API —/);
  assert.doesNotMatch(retry, /\$0\.00/);
  assert.match(retry, /tool identity|event stream unavailable/i);
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
