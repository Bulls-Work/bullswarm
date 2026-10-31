// `workflow reprice --apply` must change the home state.json only under the
// state lock (updateState), so a decision row appended by a concurrent
// dispatch between reprice's read and its write is never lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { updateState } from '../src/lib/state.js';
import { repriceRuns } from '../src/workflow/reprice.js';

const ENDED_AT = '2026-09-19T15:15:14.719Z';
const STARTED_AT = '2026-09-19T15:15:02.116Z';

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

function taskRow(id) {
  return {
    ts: ENDED_AT, kind: 'run', source: 'run', id, lane: 'analyze',
    picked: 'codex', pool: 'codex', model: 'gpt-5.6-luna', ok: true, wallSec: 12,
    usage: {
      model: 'gpt-5.6-luna',
      tokens: { standardRead: 1, cacheRead: null, cacheWrite: null, output: 1, totalKnown: 2 },
      tokenSource: 'estimated:utf8-bytes/4', cost: { estimatedUsd: 0.0001 },
    },
    startedAt: STARTED_AT, endedAt: ENDED_AT, project: null, outFile: `/tmp/${id}.md`,
  };
}

const exactReader = () => ({
  confidence: 'exact', sessionId: 'sess', model: 'gpt-5.6-luna', cwd: '/tmp/lock-probe',
  tokens: { standardRead: 500, cacheRead: null, cacheWrite: null, output: 7, reasoning: null, totalKnown: 507 },
  requests: [],
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-reprice-lock-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    strategy: { subscriptions: { codex: { monthlyPriceUsd: 30, quotaWindow: 'weekly' } } },
    decisionLog: [taskRow('row-a'), taskRow('row-b'), taskRow('row-c')],
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const run = (home, extra) => repriceRuns({
  bullswarmDir: home, transcriptHome: home, connectors: connectorMap(),
  readTranscriptUsage: exactReader, apply: true, ...extra,
});
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));

test('a row appended mid-reprice survives and repriced rows get new usage', () => {
  const f = fixture();
  try {
    let injected = false;
    const report = run(f.home, {
      onRow: () => {
        if (injected) return;
        injected = true;
        updateState(f.home, (s) => { s.decisionLog.push(taskRow('row-new')); });
      },
    });
    assert.equal(report.failures.length, 0);
    const log = stateOf(f.home).decisionLog;
    assert.deepEqual(log.map((r) => r.id), ['row-a', 'row-b', 'row-c', 'row-new']);
    for (const id of ['row-a', 'row-b', 'row-c']) {
      const row = log.find((r) => r.id === id);
      assert.equal(row.usage.tokens.standardRead, 500, id);
      assert.equal(row.cwd, '/tmp/lock-probe', id);
    }
    assert.equal(log.find((r) => r.id === 'row-new').usage.tokens.standardRead, 1);
  } finally { f.cleanup(); }
});

test('a row removed mid-reprice is reported as a failure and not resurrected', () => {
  const f = fixture();
  try {
    let injected = false;
    const report = run(f.home, {
      onRow: () => {
        if (injected) return;
        injected = true;
        updateState(f.home, (s) => { s.decisionLog = s.decisionLog.filter((r) => r.id !== 'row-b'); });
      },
    });
    const log = stateOf(f.home).decisionLog;
    assert.deepEqual(log.map((r) => r.id), ['row-a', 'row-c']);
    assert.equal(log[0].usage.tokens.standardRead, 500);
    assert.equal(log[1].usage.tokens.standardRead, 500);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].error, /row-b/);
  } finally { f.cleanup(); }
});
