// Focused acceptance for `workflow reprice` (contract section H).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createV2DurableState, createV2GoalDocument, validateV2DurableState,
} from '../src/workflow/v2-state.js';
import { createV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { cmdReprice, repriceRuns, REPRICE_RETENTION_CAVEAT } from '../src/workflow/reprice.js';

const FIXTURE_DIR = new URL('./fixtures/transcripts/', import.meta.url).pathname;

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'bs-reprice-'));
  mkdirSync(join(home, 'workflows'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    strategy: {
      subscriptions: {
        codex: { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
        'claude-code': { monthlyPriceUsd: 30, quotaWindow: 'weekly' },
      },
    },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function fixtureState(home, {
  // Smallest terminal V2 run selected from the copied /tmp/bsw-reprice home:
  // wf-mtsz2t1c-763f7c (shortId jrqubs).  The test keeps only the durable
  // fields needed for reprice and supplies its captured transcript separately.
  runId = 'wf-mtsz2t1c-763f7c',
  shortId = 'jrqubs',
  lifecycleStatus = 'partial',
  actionStatus = lifecycleStatus === 'completed' ? 'succeeded' : 'failed',
  actionId = 'reprice-step',
  pool = 'codex',
  model = 'gpt-5.6-luna',
  startedAt = '2026-09-19T15:15:01.830Z',
  finishedAt = '2026-09-19T15:15:14.719Z',
  initialTotal = 15,
  attempts = null,
} = {}) {
  const goal = createV2GoalDocument({
    goal: 'Reprice one captured provider attempt.',
    cwd: '/tmp/bs-reprice-fixture',
    requirements: [{ id: 'requirement-1', text: 'The durable attempt is repriced.', mandatory: true }],
    settings: { scout: false, executionMode: 'program', workspaceMode: 'shared', plannerMode: 'caller' },
  });
  const state = createV2DurableState(goal, { runId, shortId });
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const action = {
    id: actionId, purpose: 'Reprice one captured provider attempt.', dependsOn: [],
    affects: [], ownedFiles: [], prompt: 'Inspect the captured usage.', lane: 'analyze',
    effort: 'low', evidenceFor: [], inputs: [], produces: [],
  };
  const defaultAttempt = {
    id: `${action.id}-1`, actionId: action.id, ordinal: 1, status: actionStatus,
    pool, model, startedAt, finishedAt,
    taskFile: join(runDir, 'task-implement-attempt-1.md'),
    outputFile: null, failureKind: 'semantic', why: 'fixture',
    usage: {
      model,
      tokens: { standardRead: 12, cacheRead: null, cacheWrite: null, output: 3, reasoning: null, totalKnown: 15 },
      tokenSource: 'estimated:utf8-bytes/4',
      cost: { estimatedUsd: 0.0001, breakdown: null, basis: 'api-equivalent rate; subscription debit may differ' },
    },
    wallSec: 1,
  };
  state.lifecycle = {
    // A real completed run has already published its envelope. Build the
    // fixture through the pre-publication state, then retain the published
    // resultFile so reprice exercises the completed-status branch.
    status: lifecycleStatus, startedAt, finishedAt,
    resultFile: lifecycleStatus === 'completed' ? null : join(runDir, 'result.json'),
  };
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [action] };
  state.presentation.stages = [{
    id: 'r1-reprice', label: 'Reprice', revision: 1, actionIds: [action.id],
    startedAt, completedAt: finishedAt,
  }];
  const durableAttempts = attempts ?? [defaultAttempt];
  state.actions = [{
    id: action.id, status: actionStatus, attempts: durableAttempts.length, programRevision: 1,
    workRevision: 'work-1', startedAt, finishedAt, outputFile: null, artifactIds: [],
    lastFailure: { kind: 'semantic', message: 'fixture' },
  }];
  state.attempts = durableAttempts;
  state.planner.status = 'completed';
  state.ledger.requirements['requirement-1'].status = 'pending';
  state.budget = { agents: durableAttempts.length, seconds: durableAttempts.length, expansions: 0 };
  state.usage = { total: initialTotal, byPool: { [pool]: initialTotal } };
  validateV2DurableState(state);
  const result = createV2ResultEnvelope(state, { finishedAt });
  if (lifecycleStatus === 'completed') state.lifecycle.resultFile = join(runDir, 'result.json');
  writeJsonAtomic(join(runDir, 'state.json'), state);
  writeJsonAtomic(join(runDir, 'result.json'), result);
  return { runDir, state, result };
}

function connectorMap() {
  return {
    codex: {
      name: 'codex', model: 'gpt-5.6-luna',
      subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
      modelProfiles: [{
        id: 'gpt-5.6-luna',
        pricing: { inputUsdPerMillion: 0.2, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
        pricingSource: 'fixture-rate-card', pricingUpdatedAt: '2026-08-27',
      }],
    },
    'claude-code': {
      name: 'claude-code', model: 'claude-sonnet-5',
      subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
      modelProfiles: [{
        id: 'claude-sonnet-5',
        pricing: {
          inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2,
          cacheWrite5mUsdPerMillion: 2.5, cacheWrite1hUsdPerMillion: 4,
          outputUsdPerMillion: 10,
        },
        pricingSource: 'fixture-rate-card', pricingUpdatedAt: '2026-09-19',
      }],
    },
  };
}

// Trimmed from the real completed run
// /tmp/bsw-repricefix/workflows/wf-mtxvrham-9b0ffe (gznxqs). The two
// attempts retain the copied run's real Claude model/pool and byte-estimate
// numbers; the second attempt uses the same real-run values from the adjacent
// completed Slack attempt so the fixture exercises aggregate step totals.
function realCompletedFixture(home) {
  const attempts = [
    {
      id: 'slack-live-proof-1', actionId: 'slack-live-proof', ordinal: 1, status: 'succeeded',
      pool: 'claude-code', model: 'claude-sonnet-5',
      startedAt: '2026-09-12T04:23:52.467Z', finishedAt: '2026-09-12T04:26:04.319Z',
      usage: {
        model: 'claude-sonnet-5', sessionId: 'real-claude-session-1',
        tokens: { standardRead: 889, cacheRead: null, cacheWrite: null, output: 334, totalKnown: 1223 },
        tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.005118 },
      },
      wallSec: 131.8,
    },
    {
      id: 'slack-live-proof-2', actionId: 'slack-live-proof', ordinal: 2, status: 'succeeded',
      pool: 'claude-code', model: 'claude-sonnet-5',
      startedAt: '2026-09-12T04:24:02.467Z', finishedAt: '2026-09-12T04:25:04.319Z',
      usage: {
        model: 'claude-sonnet-5', sessionId: 'real-claude-session-2',
        tokens: { standardRead: 1056, cacheRead: null, cacheWrite: null, output: 416, totalKnown: 1472 },
        tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.006272 },
      },
      wallSec: 61.8,
    },
  ];
  return fixtureState(home, {
    runId: 'wf-mtxvrham-9b0ffe', shortId: 'gznxqs', lifecycleStatus: 'completed',
    actionStatus: 'succeeded', actionId: 'slack-live-proof', pool: 'claude-code',
    model: 'claude-sonnet-5', startedAt: '2026-09-12T04:23:52.194Z',
    finishedAt: '2026-09-12T04:26:04.343Z', initialTotal: 2695, attempts,
  });
}

function capturedClaudeUsage(sessionId) {
  if (sessionId === 'real-claude-session-1') {
    // 115,017 * $2/M + 495,679 * $0.2/M + 20,000 * $10/M.
    return {
      tokens: {
        standardRead: 115017, cacheRead: 495679, cacheWrite5m: null,
        cacheWrite1h: null, cacheWrite: 0, output: 20000, reasoning: null,
        totalKnown: 630696,
      },
      model: 'claude-sonnet-5', sessionId, requests: [], confidence: 'window',
    };
  }
  return {
    tokens: {
      standardRead: 1056, cacheRead: null, cacheWrite5m: null,
      cacheWrite1h: null, cacheWrite: 0, output: 416, reasoning: null,
      totalKnown: 1472,
    },
    model: 'claude-sonnet-5', sessionId, requests: [], confidence: 'exact',
  };
}

function capturedCodexUsage() {
  // This is the real captured codex stdout excerpt under tests/fixtures; the
  // mock returns the totals derived from its turn.completed and rollout rows.
  assert.match(readFileSync(join(FIXTURE_DIR, 'codex-stdout.jsonl'), 'utf8'), /"input_tokens":21069/);
  assert.match(readFileSync(join(FIXTURE_DIR, 'codex-rollout.jsonl'), 'utf8'), /"total_token_usage"/);
  return {
    tokens: {
      standardRead: 14157, cacheRead: 6912, cacheWrite5m: null, cacheWrite1h: null,
      cacheWrite: 0, output: 7, reasoning: 13, totalKnown: 21089,
    },
    model: 'gpt-5.6-luna',
    sessionId: '01a0ba3c-3045-7013-928b-53a20891542b',
    file: join(FIXTURE_DIR, 'codex-rollout.jsonl'),
    firstAt: '2026-09-19T15:15:02.116Z', lastAt: '2026-09-19T15:15:14.719Z',
    requests: [], confidence: 'exact',
  };
}

test('dry-run is byte-identical and reports a transcript-summed real fixture', () => {
  const { home, cleanup } = tempHome();
  try {
    const { runDir } = fixtureState(home);
    const beforeState = readFileSync(join(runDir, 'state.json'));
    const beforeResult = readFileSync(join(runDir, 'result.json'));
    let transcriptArgs = null;
    const report = repriceRuns({
      bullswarmDir: home,
      connectors: connectorMap(),
      readTranscriptUsage: (args) => {
        transcriptArgs = args;
        return capturedCodexUsage();
      },
    });
    assert.equal(report.apply, false);
    assert.equal(report.scannedRuns, 1);
    assert.equal(report.scannedAttempts, 1);
    assert.equal(report.matched, 1);
    assert.equal(report.rows[0].tokenSource, 'transcript-summed');
    assert.equal(report.rows[0].totalKnown, 21089);
    assert.equal(report.rows[0].apiUsd, 0.00299364);
    assert.equal(transcriptArgs.taskFile, join(runDir, 'task-implement-attempt-1.md'));
    assert.equal(readFileSync(join(runDir, 'state.json')).equals(beforeState), true);
    assert.equal(readFileSync(join(runDir, 'result.json')).equals(beforeResult), true);
    assert.equal(existsSync(join(runDir, 'rollup.json')), false);
  } finally { cleanup(); }
});

test('--apply rewrites usage, result totals, rollup, and history through shared writers', () => {
  const { home, cleanup } = tempHome();
  try {
    const { runDir } = fixtureState(home);
    const report = repriceRuns({
      bullswarmDir: home,
      apply: true,
      connectors: connectorMap(),
      readTranscriptUsage: () => capturedCodexUsage(),
    });
    assert.equal(report.changedRuns, 1);
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const attempt = state.attempts[0];
    assert.equal(attempt.usage.tokenSource, 'transcript-summed');
    assert.equal(attempt.usage.tokens.totalKnown, 21089);
    assert.equal(attempt.usage.cost.estimatedUsd, 0.00299364);
    assert.equal(attempt.usage.api.usd, 0.00299364);
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(result.finishedAt, '2026-09-19T15:15:14.719Z');
    assert.equal(result.usage.totals.tokenSource, 'transcript-summed');
    assert.equal(result.usage.totals.apiUsd, 0.002994);
    assert.equal(existsSync(join(runDir, 'rollup.json')), true);
    assert.equal(existsSync(join(home, 'history', 'runs.jsonl')), true);
    assert.equal(JSON.parse(readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8')).runId, 'wf-mtsz2t1c-763f7c');
  } finally { cleanup(); }
});

test('--apply refreshes a completed real-run fixture without rebuilding its envelope', () => {
  const { home, cleanup } = tempHome();
  try {
    const { runDir } = realCompletedFixture(home);
    const beforeState = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const beforeResult = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    const report = repriceRuns({
      bullswarmDir: home,
      apply: true,
      connectors: connectorMap(),
      readTranscriptUsage: ({ sessionId }) => capturedClaudeUsage(sessionId),
    });
    assert.equal(report.changedRuns, 1);
    assert.equal(report.failures.length, 0);

    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.lifecycle, beforeState.lifecycle);
    assert.equal(state.attempts[0].usage.tokenSource, 'transcript-summed');
    assert.equal(state.attempts[0].usage.tokens.totalKnown, 630696);
    assert.equal(state.attempts[0].usage.api.usd, 0.5291698);
    assert.equal(state.attempts[0].usage.subscription.pool, 'claude-code');
    assert.equal(state.attempts[0].usage.subscription.basis, 'unknown:no-meter');

    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(result.status, beforeResult.status);
    assert.equal(result.verified, beforeResult.verified);
    assert.equal(result.reason, beforeResult.reason);
    assert.deepEqual(result.requirements, beforeResult.requirements);
    assert.equal(result.usage.totals.tokenSource, 'transcript-summed');
    assert.equal(result.usage.totals.tokens, 632168);
    assert.equal(result.usage.totals.apiUsd, 0.535442);
    assert.equal(result.usage.totals.subscriptionUsd, null);
    assert.equal(result.usage.steps['slack-live-proof'].tokens, 632168);
    assert.equal(result.actions[0].usage.apiUsd, 0.535442);
    assert.equal(result.actions[0].usage.subscriptionBasis, 'unknown:no-meter');

    const rollup = JSON.parse(readFileSync(join(runDir, 'rollup.json'), 'utf8'));
    assert.equal(rollup.pools['claude-code'].tokens, 632168);
    assert.equal(rollup.pools['claude-code'].costUsd, 0.535442);
    assert.equal(rollup.usage.tokenSource, 'transcript-summed');
    assert.equal(rollup.usage.apiUsd, 0.535442);
    const history = readFileSync(join(home, 'history', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(history.at(-1).runId, 'wf-mtxvrham-9b0ffe');
    assert.equal(history.at(-1).pools['claude-code'].tokens, 632168);
  } finally { cleanup(); }
});

test('completed-run dry-run leaves state and result bytes unchanged', () => {
  const { home, cleanup } = tempHome();
  try {
    const { runDir } = realCompletedFixture(home);
    const before = new Map(['state.json', 'result.json'].map((name) => [
      name, readFileSync(join(runDir, name)),
    ]));
    const report = repriceRuns({
      bullswarmDir: home,
      connectors: connectorMap(),
      readTranscriptUsage: ({ sessionId }) => capturedClaudeUsage(sessionId),
    });
    assert.equal(report.apply, false);
    assert.equal(report.failures.length, 0);
    assert.equal(report.changedRuns, 0);
    for (const [name, bytes] of before) assert.equal(readFileSync(join(runDir, name)).equals(bytes), true);
    assert.equal(existsSync(join(runDir, 'rollup.json')), false);
  } finally { cleanup(); }
});

test('ambiguous and missing matches become unknown with null cost rather than retaining estimates', () => {
  const { home, cleanup } = tempHome();
  try {
    const second = {
      id: 'reprice-step-2', actionId: 'reprice-step', ordinal: 2, status: 'failed',
      pool: 'codex', model: 'gpt-5.6-luna', startedAt: '2026-09-19T15:16:01.000Z',
      finishedAt: '2026-09-19T15:16:02.000Z', usage: {
        tokens: { standardRead: 99, output: 9, totalKnown: 108 },
        tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.5 },
      }, wallSec: 1,
    };
    const { runDir } = fixtureState(home, { attempts: [
      fixtureStateAttempt('reprice-step-1', '2026-09-19T15:15:01.830Z', '2026-09-19T15:15:14.719Z'),
      second,
    ] });
    const before = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const report = repriceRuns({
      bullswarmDir: home,
      apply: true,
      connectors: connectorMap(),
      readTranscriptUsage: ({ sessionId }) => ({
        tokens: { standardRead: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, totalKnown: 2 },
        model: 'gpt-5.6-luna', sessionId, requests: [],
        confidence: sessionId === 'ambiguous' ? 'ambiguous' : 'none',
      }),
    });
    assert.equal(report.ambiguous, 1);
    assert.equal(report.missing, 1);
    const after = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.equal(after.attempts[0].usage.tokens.totalKnown, null);
    assert.equal(after.attempts[0].usage.cost.estimatedUsd, null);
    assert.equal(after.attempts[1].usage.tokens.totalKnown, null);
    assert.equal(after.attempts[1].usage.cost.estimatedUsd, null);
    assert.notDeepEqual(after, before);
  } finally { cleanup(); }
});

function fixtureStateAttempt(id, startedAt, finishedAt) {
  return {
    id, actionId: 'reprice-step', ordinal: Number(id.endsWith('-2')) ? 2 : 1, status: 'failed',
    pool: 'codex', model: 'gpt-5.6-luna', startedAt, finishedAt,
    session: { sessionId: id.endsWith('-1') ? 'ambiguous' : 'missing' },
    usage: {
      tokens: { standardRead: 10, output: 2, totalKnown: 12 },
      tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.25 },
    }, wallSec: 1,
  };
}

test('CLI prints the exact retention caveat and supports --json without corrupting stdout', () => {
  const { home, cleanup } = tempHome();
  try {
    fixtureState(home);
    const stdout = [];
    const stderr = [];
    const code = cmdReprice(['--json', '--pool', 'codex'], {
      bullswarmDir: home,
      connectors: connectorMap(),
      readTranscriptUsage: () => ({ tokens: {}, confidence: 'none' }),
      log: (line) => stdout.push(line),
      error: (line) => stderr.push(line),
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout[0]).action, 'reprice');
    assert.equal(stderr.includes(REPRICE_RETENTION_CAVEAT), true);
  } finally { cleanup(); }
});
