// BULLSWARM_CLAUDE_CACHE_5M: opt-in 5-minute prompt-cache writes for Claude
// Code workers. A fake worker records the FORCE_PROMPT_CACHING_5M it was
// launched with, through the real dispatch spawn path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { saveState } from '../src/lib/state.js';

const WORKER = new URL('./fixtures/env-dump-connector.mjs', import.meta.url).pathname;

async function launch({ poolName = 'claude-code', lane, setting }) {
  const home = mkdtempSync(join(tmpdir(), 'bs-cache5m-'));
  try {
    const pool = {
      name: poolName, enabled: true, lanes: ['analyze', 'build', 'chore'],
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      spawn: { cmd: [process.execPath, WORKER, '{taskFile}'] },
      outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
      model: 'm', modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: poolName, model: 'm' } },
    };
    saveState(home, { version: 1, pools: { [poolName]: { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } });
    const parentEnv = { ...process.env, BS_ENV_DUMP: join(home, 'env-dump.txt') };
    delete parentEnv.FORCE_PROMPT_CACHING_5M;
    delete parentEnv.BULLSWARM_CLAUDE_CACHE_5M;
    if (setting !== undefined) parentEnv.BULLSWARM_CLAUDE_CACHE_5M = setting;
    const started = [];
    const result = await dispatchV2Action({
      action: { id: `step-${lane}`, lane, effort: 'low' },
      taskText: 'do the bounded step',
      targetDir: home,
      paths: { taskFile: join(home, 'task.md'), outFile: join(home, 'out.md') },
      pools: [pool], bullswarmDir: home, parentEnv, maxMechanicalRetries: 0,
      onAttempt: (stage, record) => { if (stage === 'started') started.push(record); },
    });
    assert.equal(result.ok, true, JSON.stringify(result.attempts?.map((a) => a.why)));
    return { seen: readFileSync(join(home, 'env-dump.txt'), 'utf8'), recorded: started[0].claudeCache5m };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('analyze mode sets the variable for an analyze attempt and not for a build attempt', async () => {
  assert.deepEqual(await launch({ lane: 'analyze', setting: 'analyze' }), { seen: '1', recorded: 'analyze' });
  assert.deepEqual(await launch({ lane: 'build', setting: 'analyze' }), { seen: 'unset', recorded: undefined });
});

test('all mode sets the variable for both lanes', async () => {
  assert.deepEqual(await launch({ lane: 'analyze', setting: 'all' }), { seen: '1', recorded: 'all' });
  assert.deepEqual(await launch({ lane: 'build', setting: 'all' }), { seen: '1', recorded: 'all' });
});

test('off and unset set it for neither lane', async () => {
  for (const setting of ['off', undefined]) {
    for (const lane of ['analyze', 'build']) {
      assert.deepEqual(await launch({ lane, setting }), { seen: 'unset', recorded: undefined });
    }
  }
});

test('a pool that is not claude-code never gets it', async () => {
  assert.deepEqual(await launch({ poolName: 'codex', lane: 'analyze', setting: 'all' }), { seen: 'unset', recorded: undefined });
});

test('an invalid value reads as off, like the other BULLSWARM_ settings', async () => {
  assert.deepEqual(await launch({ lane: 'analyze', setting: 'sometimes' }), { seen: 'unset', recorded: undefined });
});
