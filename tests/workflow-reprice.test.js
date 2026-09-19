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
    strategy: { subscriptions: { codex: { monthlyPriceUsd: 30, quotaWindow: 'weekly' } } },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function fixtureState(home, {
  // Smallest terminal V2 run selected from the copied /tmp/bsw-reprice home:
  // wf-mtsz2t1c-763f7c (shortId jrqubs).  The test keeps only the durable
  // fields needed for reprice and supplies its captured transcript separately.
  runId = 'wf-mtsz2t1c-763f7c',
  shortId = 'jrqubs',
  attempts = null,
} = {}) {
  const startedAt = '2026-09-19T15:15:01.830Z';
  const finishedAt = '2026-09-19T15:15:14.719Z';
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
    id: 'reprice-step', purpose: 'Reprice one captured provider attempt.', dependsOn: [],
    affects: [], ownedFiles: [], prompt: 'Inspect the captured usage.', lane: 'analyze',
    effort: 'low', evidenceFor: [], inputs: [], produces: [],
  };
  const defaultAttempt = {
    id: 'reprice-step-1', actionId: action.id, ordinal: 1, status: 'failed',
    pool: 'codex', model: 'gpt-5.6-luna', startedAt, finishedAt,
    outputFile: null, failureKind: 'semantic', why: 'fixture',
    usage: {
      model: 'gpt-5.6-luna',
      tokens: { standardRead: 12, cacheRead: null, cacheWrite: null, output: 3, reasoning: null, totalKnown: 15 },
      tokenSource: 'estimated:utf8-bytes/4',
      cost: { estimatedUsd: 0.0001, breakdown: null, basis: 'api-equivalent rate; subscription debit may differ' },
    },
    wallSec: 1,
  };
  state.lifecycle = {
    status: 'partial', startedAt, finishedAt, resultFile: join(runDir, 'result.json'),
  };
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [action] };
  state.presentation.stages = [{
    id: 'r1-reprice', label: 'Reprice', revision: 1, actionIds: [action.id],
    startedAt, completedAt: finishedAt,
  }];
  const durableAttempts = attempts ?? [defaultAttempt];
  state.actions = [{
    id: action.id, status: 'failed', attempts: durableAttempts.length, programRevision: 1,
    workRevision: 'work-1', startedAt, finishedAt, outputFile: null, artifactIds: [],
    lastFailure: { kind: 'semantic', message: 'fixture' },
  }];
  state.attempts = durableAttempts;
  state.planner.status = 'completed';
  state.ledger.requirements['requirement-1'].status = 'pending';
  state.budget = { agents: durableAttempts.length, seconds: durableAttempts.length, expansions: 0 };
  state.usage = { total: 15, byPool: { codex: 15 } };
  validateV2DurableState(state);
  const result = createV2ResultEnvelope(state, { finishedAt });
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
    const report = repriceRuns({
      bullswarmDir: home,
      connectors: connectorMap(),
      readTranscriptUsage: () => capturedCodexUsage(),
    });
    assert.equal(report.apply, false);
    assert.equal(report.scannedRuns, 1);
    assert.equal(report.scannedAttempts, 1);
    assert.equal(report.matched, 1);
    assert.equal(report.rows[0].tokenSource, 'transcript-summed');
    assert.equal(report.rows[0].totalKnown, 21089);
    assert.equal(report.rows[0].apiUsd, 0.00299364);
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
