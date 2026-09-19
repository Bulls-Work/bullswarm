import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOnce } from '../src/lib/watch.js';
import {
  createV2GoalDocument, createV2State,
  deserializeV2DurableState, serializeV2DurableState,
} from '../src/workflow/v2-state.js';

const CLAUDE_RESULT = JSON.parse(
  readFileSync(new URL('./fixtures/transcripts/claude-result-event.json', import.meta.url), 'utf8'),
);

function connector(home, { updateMeter = true } = {}) {
  const meterPath = join(home, 'meters', 'wiring-pool.json');
  const event = JSON.stringify(CLAUDE_RESULT);
  const writeEnd = updateMeter
    ? `require('node:fs').writeFileSync(${JSON.stringify(meterPath)}, ${JSON.stringify(JSON.stringify({
      captured_at: new Date().toISOString(),
      pool: 'wiring-pool',
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: 41.5, resets_at: '2099-01-08T00:00:00.000Z' },
      monthly: null,
    }, null, 2))});`
    : '';
  return {
    name: 'wiring-pool',
    model: 'claude-fable-5',
    spawn: {
      cmd: [process.execPath, '-e', `${writeEnd} console.log(${JSON.stringify(event)})`],
    },
    outputExtraction: { strategy: 'event-stream' },
    eventStream: {
      format: 'jsonl',
      usage: [{
        match: { path: 'type', equals: 'result' },
        mode: 'last',
        fields: {
          sessionId: 'session_id',
          standardRead: 'usage.input_tokens',
          cacheRead: 'usage.cache_read_input_tokens',
          cacheWrite5m: 'usage.cache_creation.ephemeral_5m_input_tokens',
          cacheWrite1h: 'usage.cache_creation.ephemeral_1h_input_tokens',
          output: 'usage.output_tokens',
          reasoning: 'usage.output_tokens_details.thinking_tokens',
        },
        inclusive: { output: ['reasoning'] },
      }],
      output: [{ match: { path: 'type', equals: 'result' }, path: 'type', mode: 'last' }],
    },
    modelProfiles: [{
      match: '^claude-fable-5$',
      pricing: {
        inputUsdPerMillion: 10,
        cacheReadUsdPerMillion: 1,
        cacheWrite5mUsdPerMillion: 12.5,
        cacheWrite1hUsdPerMillion: 20,
        outputUsdPerMillion: 50,
      },
      pricingSource: 'fixture:claude-fable-5',
      pricingUpdatedAt: '2026-09-18',
    }],
    subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
  };
}

function fixtureHome({ meter = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-wiring-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    strategy: { subscriptions: { 'wiring-pool': { quotaWindow: 'weekly', monthlyPriceUsd: 30 } } },
  }));
  if (meter) {
    writeFileSync(join(home, 'meters', 'wiring-pool.json'), JSON.stringify({
      captured_at: new Date().toISOString(),
      pool: 'wiring-pool',
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: 40, resets_at: '2099-01-08T00:00:00.000Z' },
      monthly: null,
    }));
  }
  return home;
}

function paths(home) {
  return { taskFile: join(home, 'task.md'), outFile: join(home, 'out.md') };
}

test('wires provider usage, observed meter delta, and one calibration sample', async () => {
  const home = fixtureHome();
  try {
    const verdict = await watchOnce(
      connector(home),
      'Implement and verify the requested change.',
      home,
      paths(home),
      {
        bullswarmDir: home,
        poolName: 'wiring-pool',
        runId: 'wf-wiring-abcdef',
        attemptId: 'wire-1',
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        outputValidator: () => ({ ok: true }),
      },
    );
    assert.equal(verdict.ok, true, verdict.why);
    const usage = verdict.meta.usage;
    assert.deepEqual(usage.tokens, {
      standardRead: 2,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 30253,
      cacheWrite: 30253,
      output: 155,
      reasoning: 21,
      totalKnown: 30431,
    });
    assert.equal(usage.tokenSource, 'provider-reported');
    assert.equal(usage.sessionId, CLAUDE_RESULT.session_id);
    assert.equal(usage.subscription.basis, 'observed:meter-delta');
    assert.equal(usage.subscription.deltaPct, 1.5);
    assert.equal(usage.subscription.snapshots.start.usedPct, 40);
    assert.equal(usage.subscription.snapshots.end.usedPct, 41.5);
    const ledgerPath = join(home, 'calibration', 'wiring-pool.json');
    assert.equal(existsSync(ledgerPath), true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.samples.length, 1);
    assert.equal(ledger.samples[0].deltaPct, 1.5);
    assert.equal(ledger.samples[0].attemptId, 'wire-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('forces a stale start meter before spawning and records both sources', async () => {
  const home = fixtureHome();
  const meterPath = join(home, 'meters', 'wiring-pool.json');
  try {
    writeFileSync(meterPath, JSON.stringify({
      captured_at: new Date(Date.now() - 120_000).toISOString(),
      pool: 'wiring-pool',
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: 39, resets_at: '2099-01-08T00:00:00.000Z' },
      monthly: null,
    }));
    let forcedCalls = 0;
    const verdict = await watchOnce(
      connector(home),
      'Implement and verify the requested change.',
      home,
      paths(home),
      {
        bullswarmDir: home,
        poolName: 'wiring-pool',
        runId: 'wf-wiring-abcdef',
        attemptId: 'wire-stale-start',
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        getMeterReading: async (_pool, options) => {
          assert.equal(options.force, true);
          forcedCalls += 1;
          writeFileSync(meterPath, JSON.stringify({
            captured_at: new Date().toISOString(),
            pool: 'wiring-pool',
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 40, resets_at: '2099-01-08T00:00:00.000Z' },
            monthly: null,
          }));
          return { source: 'live' };
        },
        outputValidator: () => ({ ok: true }),
      },
    );
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(forcedCalls, 1);
    assert.equal(verdict.meta.usage.subscription.basis, 'observed:meter-delta');
    assert.equal(verdict.meta.usage.subscription.snapshots.start.source, 'forced');
    assert.equal(verdict.meta.usage.subscription.snapshots.end.source, 'cache');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing meter preserves API usage but leaves subscription dollars unknown', async () => {
  const home = fixtureHome({ meter: false });
  try {
    const verdict = await watchOnce(
      connector(home, { updateMeter: false }),
      'Implement and verify the requested change.',
      home,
      paths(home),
      {
        bullswarmDir: home,
        poolName: 'wiring-pool',
        runId: 'wf-wiring-abcdef',
        attemptId: 'wire-2',
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        outputValidator: () => ({ ok: true }),
      },
    );
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.usage.tokenSource, 'provider-reported');
    assert.equal(verdict.meta.usage.subscription.basis, 'unknown:no-meter');
    assert.equal(verdict.meta.usage.subscription.usd, null);
    assert.equal(verdict.meta.usage.subscription.snapshots.start, null);
    assert.equal(verdict.meta.usage.subscription.snapshots.end, null);
    assert.equal(existsSync(join(home, 'calibration', 'wiring-pool.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('round-trips the complete v2 usage and provider session on a durable attempt', async () => {
  const home = fixtureHome();
  try {
    const verdict = await watchOnce(
      connector(home),
      'Implement and verify the requested change.',
      home,
      paths(home),
      {
        bullswarmDir: home,
        poolName: 'wiring-pool',
        runId: 'wf-wiring-abcdef',
        attemptId: 'wire-3',
        subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
        outputValidator: () => ({ ok: true }),
      },
    );
    const goal = createV2GoalDocument({
      goal: 'Persist measured usage', cwd: home,
      requirements: [{ id: 'usage-recorded', text: 'The measured usage persists' }],
    });
    const state = createV2State(goal, { runId: 'wf-wiring-abcdef', shortId: 'wir234' });
    state.program = {
      schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
      actions: [{
        id: 'measure', purpose: 'Persist the measured usage', dependsOn: [], affects: [],
        ownedFiles: [], prompt: 'Persist the measured usage.', lane: 'analyze', effort: 'low',
        evidenceFor: [], inputs: [], produces: [],
      }],
    };
    state.actions = [{ id: 'measure', status: 'succeeded', attempts: 1, programRevision: 1 }];
    state.presentation = {
      stages: [{ id: 'measure-stage', label: 'Measure', revision: 1, actionIds: ['measure'], startedAt: null, completedAt: null }],
    };
    state.attempts = [{
      id: 'measure-1', actionId: 'measure', ordinal: 1, status: 'succeeded',
      pool: 'wiring-pool', model: verdict.meta.usage.model,
      startedAt: '2026-09-19T00:00:00.000Z', finishedAt: '2026-09-19T00:00:01.000Z',
      usage: verdict.meta.usage,
      session: {
        pool: 'wiring-pool', model: verdict.meta.usage.model,
        sessionId: verdict.meta.usage.sessionId, generation: 1,
        startedAt: '2026-09-19T00:00:00.000Z', lastUsedAt: '2026-09-19T00:00:01.000Z',
      },
    }];
    state.budget.agents = 1;
    const loaded = deserializeV2DurableState(serializeV2DurableState(state));
    assert.equal(loaded.attempts[0].usage.tokenSource, 'provider-reported');
    assert.equal(loaded.attempts[0].usage.api.basis, 'rate-card:complete');
    assert.equal(loaded.attempts[0].usage.subscription.basis, 'observed:meter-delta');
    assert.equal(loaded.attempts[0].usage.subscription.snapshots.end.usedPct, 41.5);
    assert.deepEqual(loaded.attempts[0].session, state.attempts[0].session);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
