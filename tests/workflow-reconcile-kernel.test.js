// The kernel prices its own finished attempts with no user command
// (0.35.2 requirement 1). The worker is a stub; its transcript is the real
// Codex rollout fixture plus the prompt row the codex connector sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { reconcileRunState } from '../src/workflow/reconcile.js';

const FIXTURES = new URL('./fixtures/transcripts/', import.meta.url).pathname;
const STARTED_AT = '2026-09-19T15:15:02.116Z';
const FINISHED_AT = '2026-09-19T15:15:14.719Z';

function rollout(transcriptHome, taskFile) {
  const [meta, context, ...rest] = readFileSync(join(FIXTURES, 'codex-rollout.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const prompt = {
    timestamp: context.timestamp, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read ${taskFile} and follow the instructions.` }] },
  };
  const dir = join(transcriptHome, '.codex', 'sessions', '2026', '09', '19');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-09-19T23-15-01-${meta.payload.id}.jsonl`),
    `${[meta, context, prompt, ...rest].map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('a program run prices an attempt that finished without usage before its result is written', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-reconcile-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  const transcripts = join(root, 'transcripts');
  mkdirSync(workspace); mkdirSync(bullswarmDir); mkdirSync(transcripts);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver one file', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the file.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller' },
  });
  const connectors = {
    codex: {
      name: 'codex', model: 'gpt-5.6-luna',
      modelProfiles: [{
        id: 'gpt-5.6-luna',
        pricing: { inputUsdPerMillion: 0.2, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
        pricingSource: 'fixture-rate-card', pricingUpdatedAt: '2026-09-19',
      }],
    },
  };
  const result = await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [],
    initialPlannerResponse: {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'One step.',
      program: {
        schemaVersion: 'bullswarm.workflow.program.v2',
        actions: [{
          id: 'write', purpose: 'Deliver write', dependsOn: [], affects: ['deliver'], ownedFiles: ['write.txt'],
          prompt: 'Implement write.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
        }],
      },
    },
    dependencies: {
      dispatchV2Action: async (options) => {
        const files = options.paths(1);
        writeFileSync(files.taskFile, options.taskText);
        // The delegate's own log: its first message quotes the task file.
        rollout(transcripts, files.taskFile);
        const record = {
          ordinal: 1, pool: 'codex', model: 'gpt-5.6-luna', status: 'running',
          startedAt: STARTED_AT, taskFile: files.taskFile, outFile: files.outFile,
        };
        options.onAttempt?.('started', record);
        writeFileSync(files.outFile, 'Implemented write.');
        Object.assign(record, { status: 'succeeded', finishedAt: FINISHED_AT, failureKind: null });
        options.onAttempt?.('finished', record);
        return { attempts: [record], ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile } };
      },
      captureWorkspaceManifest: () => { throw new Error('shared program must never scan a manifest'); },
      reconcileCurrentRun: (state, options) => reconcileRunState(state, { ...options, transcriptHome: transcripts, connectors }),
    },
  });
  const attempt = result.state.attempts[0];
  assert.equal(attempt.usage.tokenSource, 'transcript-summed');
  assert.equal(attempt.usage.tokens.totalKnown, 21089);
  const durable = JSON.parse(readFileSync(join(result.runDir, 'state.json'), 'utf8'));
  assert.equal(durable.usage.total, 21089);
  const published = JSON.parse(readFileSync(join(result.runDir, 'result.json'), 'utf8'));
  assert.equal(published.usage.totals.tokens, 21089);
  const rollup = JSON.parse(readFileSync(join(result.runDir, 'rollup.json'), 'utf8'));
  assert.equal(rollup.pools.codex.tokenSource, 'transcript-summed');
});
