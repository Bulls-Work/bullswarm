import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSetup } from '../src/setup.js';
import { loadState } from '../src/lib/state.js';
import { refreshStrategy, cmdStrategy } from '../src/strategy-cli.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-strategy-cli-'));
  autoSetup(dir, { reason: 'test' });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('strategy refresh persists honest discovery and tier suggestions', async () => {
  const f = fixture();
  try {
    const report = await refreshStrategy(f.dir, {
      executor: (command) => command.includes('grok') ? '* grok-4.6 (default)\n' : 'gpt-5.6-luna  low\n',
      getReadings: async () => ({}),
    });
    assert.equal(report.schemaVersion, 'bullswarm.strategy.v1');
    assert.ok(report.discoveries.grok.models.some((model) => model.id === 'grok-4.6'));
    assert.equal(loadState(f.dir).strategy.lastReport.capturedAt, report.capturedAt);
    assert.match(report.caveats.join(' '), /does not invent/i);
  } finally { f.cleanup(); }
});

test('strategy subscription metadata and assignments are explicit persisted user choices', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await cmdStrategy([
      'set-subscription', 'command-code', '--plan', 'Go', '--monthly-usd', '10',
      '--included-usd', '70', '--quota-window', 'monthly',
    ], { bullswarmDir: f.dir }), 0);
    assert.equal(await cmdStrategy([
      'assign', 'low', '--pool', 'command-code', '--model', 'gpt-5.6-luna',
    ], { bullswarmDir: f.dir }), 0);
    const state = loadState(f.dir);
    assert.deepEqual(state.strategy.subscriptions['command-code'], {
      plan: 'Go', monthlyPriceUsd: 10, includedValueUsd: 70, quotaWindow: 'monthly',
    });
    assert.deepEqual(state.strategy.assignments.low, {
      pool: 'command-code', model: 'gpt-5.6-luna',
    });
  } finally {
    console.log = originalLog;
    f.cleanup();
  }
});
