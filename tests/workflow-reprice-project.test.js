// Project/cwd backfill acceptance for workflow and standalone run records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTranscriptUsage } from '../src/lib/transcripts/index.js';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { createV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import { createV2DurableState, createV2GoalDocument, validateV2DurableState } from '../src/workflow/v2-state.js';
import { repriceRuns } from '../src/workflow/reprice.js';

const FIXTURE_DIR = new URL('./fixtures/transcripts/', import.meta.url).pathname;
const CODEX_ID = '01a0ba3c-3045-7013-928b-53a20891542b';
const CODEX_CWD = '/private/tmp/bsw-design/codex-probe';
const STARTED_AT = '2026-09-19T15:15:02.116Z';
const FINISHED_AT = '2026-09-19T15:15:14.719Z';

// Quoted from the copied real home: history/runs.jsonl record
// wf-mt42x54k-100cf0 had project:null and cwd:null. The fixture below keeps
// that real id while adding the smallest V2 attempt needed to exercise the
// backfill path.
const REAL_UNKNOWN_RUN_ID = 'wf-mt42x54k-100cf0';

function connectorMap() {
  return {
    codex: {
      name: 'codex', model: 'gpt-5.6-luna',
      subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
      modelProfiles: [{
        id: 'gpt-5.6-luna',
        pricing: { inputUsdPerMillion: 0.2, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
        pricingSource: 'fixture-rate-card', pricingUpdatedAt: '2026-09-19',
      }],
    },
  };
}

function fixtureHome({ task = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-reprice-project-'));
  const runDir = join(home, 'workflows', REAL_UNKNOWN_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(home, '.codex', 'sessions', '2026', '09', '19'), { recursive: true });
  cpSync(join(FIXTURE_DIR, 'codex-rollout.jsonl'), join(
    home, '.codex', 'sessions', '2026', '09', '19',
    `rollout-2026-09-19T23-15-01-${CODEX_ID}.jsonl`,
  ));

  const goal = createV2GoalDocument({
    goal: 'Backfill the project from a captured transcript.',
    cwd: CODEX_CWD,
    requirements: [{ id: 'backfill-project', text: 'The project is recorded.', mandatory: true }],
    settings: { scout: false, executionMode: 'program', workspaceMode: 'shared', plannerMode: 'caller' },
  });
  const state = createV2DurableState(goal, { runId: REAL_UNKNOWN_RUN_ID, shortId: 'unknwn' });
  state.lifecycle = { status: 'partial', startedAt: STARTED_AT, finishedAt: FINISHED_AT, resultFile: null };
  const action = {
    id: 'backfill-project', purpose: 'Backfill the project.', dependsOn: [], affects: [], ownedFiles: [],
    prompt: 'Use the captured transcript.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  };
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [action] };
  state.actions = [{
    id: action.id, status: 'succeeded', attempts: 1, programRevision: 1, workRevision: 'work-1',
    startedAt: STARTED_AT, finishedAt: FINISHED_AT, outputFile: null, artifactIds: [], lastFailure: null,
  }];
  state.presentation.stages = [{
    id: 'backfill-stage', label: 'Backfill', revision: 1, actionIds: [action.id],
    startedAt: STARTED_AT, completedAt: FINISHED_AT,
  }];
  state.attempts = [{
    id: 'backfill-project-1', actionId: action.id, ordinal: 1, status: 'succeeded',
    pool: 'codex', model: 'gpt-5.6-luna', startedAt: STARTED_AT, finishedAt: FINISHED_AT,
    usage: {
      model: 'gpt-5.6-luna',
      tokens: { standardRead: 12, cacheRead: null, cacheWrite: null, output: 3, reasoning: null, totalKnown: 15 },
      tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.0001 },
    },
    wallSec: 1,
  }];
  state.planner.status = 'completed';
  state.budget = { agents: 1, seconds: 1, expansions: 0 };
  state.usage = { total: 15, byPool: { codex: 15 } };
  validateV2DurableState(state);
  writeJsonAtomic(join(runDir, 'state.json'), state);
  const result = createV2ResultEnvelope(state, { finishedAt: FINISHED_AT });
  state.lifecycle.resultFile = join(runDir, 'result.json');
  writeJsonAtomic(join(runDir, 'state.json'), state);
  writeJsonAtomic(join(runDir, 'result.json'), result);

  const rootState = {
    strategy: { subscriptions: { codex: { monthlyPriceUsd: 30, quotaWindow: 'weekly' } } },
    decisionLog: task ? [{
      ts: FINISHED_AT, kind: 'run', source: 'run', id: 'single-task-unknown', lane: 'analyze',
      picked: 'codex', pool: 'codex', model: 'gpt-5.6-luna', ok: true, wallSec: 12.6,
      usage: {
        model: 'gpt-5.6-luna',
        tokens: { standardRead: 10, cacheRead: null, cacheWrite: null, output: 2, totalKnown: 12 },
        tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.0002 },
      },
      startedAt: STARTED_AT, endedAt: FINISHED_AT, project: null,
      outFile: '/tmp/single-task-unknown.md',
    }] : [],
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify(rootState));
  return { home, runDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('project backfill is dry-run byte-identical and --apply persists cwd/project for both records', () => {
  const fixture = fixtureHome();
  try {
    const before = new Map([
      [join(fixture.runDir, 'state.json'), readFileSync(join(fixture.runDir, 'state.json'))],
      [join(fixture.runDir, 'result.json'), readFileSync(join(fixture.runDir, 'result.json'))],
      [join(fixture.home, 'state.json'), readFileSync(join(fixture.home, 'state.json'))],
    ]);
    const dry = repriceRuns({
      bullswarmDir: fixture.home,
      transcriptHome: fixture.home,
      connectors: connectorMap(),
      readTranscriptUsage,
    });
    assert.equal(dry.changedProjects, 2);
    assert.equal(dry.rows.filter((row) => row.project === 'unknown → codex-probe').length, 2);
    for (const [path, bytes] of before) assert.equal(readFileSync(path).equals(bytes), true, path);

    const applied = repriceRuns({
      bullswarmDir: fixture.home,
      transcriptHome: fixture.home,
      connectors: connectorMap(),
      readTranscriptUsage,
      apply: true,
    });
    assert.equal(applied.changedProjects, 2);
    const runState = JSON.parse(readFileSync(join(fixture.runDir, 'state.json'), 'utf8'));
    assert.equal(runState.attempts[0].cwd, CODEX_CWD);
    assert.equal(runState.attempts[0].project, 'codex-probe');
    const rootState = JSON.parse(readFileSync(join(fixture.home, 'state.json'), 'utf8'));
    assert.equal(rootState.decisionLog[0].cwd, CODEX_CWD);
    assert.equal(rootState.decisionLog[0].project, 'codex-probe');
  } finally { fixture.cleanup(); }
});

test('a matched transcript with no cwd leaves an unknown project', () => {
  const fixture = fixtureHome({ task: true });
  try {
    const report = repriceRuns({
      bullswarmDir: fixture.home,
      transcriptHome: fixture.home,
      connectors: connectorMap(),
      readTranscriptUsage: () => ({
        confidence: 'exact', sessionId: CODEX_ID, model: 'gpt-5.6-luna', cwd: null,
        tokens: { standardRead: 1, cacheRead: null, cacheWrite: null, output: 1, reasoning: null, totalKnown: 2 },
        requests: [],
      }),
      apply: true,
    });
    const taskRow = report.rows.find((row) => row.actionId === 'single-task');
    assert.equal(taskRow.project, 'unknown');
    assert.equal(taskRow.projectChanged, false);
    const state = JSON.parse(readFileSync(join(fixture.home, 'state.json'), 'utf8'));
    assert.equal(state.decisionLog[0].project, null);
    assert.equal(state.decisionLog[0].cwd, undefined);
  } finally { fixture.cleanup(); }
});
