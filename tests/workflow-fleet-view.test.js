import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetLines } from '../src/workflow/fleet-view.js';

const pools = [
  {
    name: 'command-code', enabled: true, usedPct: 79.4, elapsedPct: 75.3,
    pacingWindow: 'monthly', paceResetsAt: '2026-09-19T12:00:00.000Z',
    incumbentLane: ['high'],
  },
  { name: 'codex', enabled: true, usedPct: 32, elapsedPct: 27, pacingWindow: 'weekly' },
];
const rungs = [
  { pool: 'command-code', tier: 'high', model: 'anthropic/claude-opus-4-1', reasoning: 'high', dispatches: 3, okShare: 0.667, medianMinutes: 12.4 },
  { pool: 'command-code', tier: 'medium', model: 'anthropic/claude-sonnet-4-5', reasoning: null, dispatches: 0 },
  { pool: 'codex', tier: 'high', model: 'openai/gpt-5-codex', reasoning: 'medium', dispatches: 1, okShare: 1, medianMinutes: 3 },
];

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');

test('Fleet groups rungs by lane and exposes the read-only edit control', () => {
  const result = fleetLines(pools, rungs, { width: 120, by: 'lane', ansi: false });
  const text = result.lines.join('\n');
  assert.match(result.lines[0], /^ by lane  by provider   \[ edit \] read-only here · edit opens bullswarm setup$/);
  assert.match(text, /high · integration · architecture · adversarial-acceptance/);
  assert.match(text, /command-code    claude-opus-4-1 · high/);
  assert.match(text, /3 runs · 67% ok · p50 12m/);
  assert.match(text, /no runs yet/);
  // The regions name the row they were painted on: the shell places them
  // there rather than searching the paint for a bracketed tab.
  assert.deepEqual(result.regions, [
    { x: 2, y: 1, width: 7, action: { kind: 'tab', tab: 'lane' } },
    { x: 11, y: 1, width: 11, action: { kind: 'tab', tab: 'provider' } },
    { x: 25, y: 1, width: 8, action: { kind: 'edit' } },
  ]);
});

test('Fleet groups rungs by provider with meter/reset blurbs', () => {
  const result = fleetLines(pools, rungs, {
    width: 120, by: 'provider', ansi: false,
    nowMs: Date.parse('2026-09-16T12:00:00.000Z'),
  });
  const text = result.lines.join('\n');
  assert.match(result.lines[0], /^ by lane  by provider   \[ edit \] read-only here · edit opens bullswarm setup$/);
  assert.match(text, /command-code · monthly window · 79% used of 75% elapsed · resets 3d0h · incumbent for high/);
  assert.match(text, /high            claude-opus-4-1 · high/);
  assert.match(text, /medium          claude-sonnet-4-5/);
  assert.match(text, /codex · weekly window · 32% used of 27% elapsed/);
});

test('Fleet uses the prototype cyan for every model name', () => {
  const result = fleetLines(pools, rungs, { width: 120, by: 'lane', ansi: true });
  const cyan = '\x1b[38;2;143;199;207m';
  for (const model of ['claude-opus-4-1', 'claude-sonnet-4-5', 'gpt-5-codex']) {
    const line = result.lines.find((entry) => plain(entry).includes(model));
    assert.ok(line, `model ${model} was painted`);
    assert.ok(line.includes(`${cyan}${model}\x1b[0m`), `model ${model} is cyan`);
  }
});

test('Fleet keeps the sub-tabs and every row inside every supported width', () => {
  for (const by of ['lane', 'provider']) {
    for (const width of [32, 54, 55, 80, 100, 200]) {
      const result = fleetLines(pools, rungs, { width, by, ansi: true });
      const visibleLines = result.lines.map(plain);
      assert.ok(result.lines.length > 0);
      assert.deepEqual(visibleLines.filter((line) => line.length > width), [], `${by} width ${width}`);
      assert.ok(result.regions.every((region) => (
        region.x >= 1 && region.x + region.width - 1 <= width
      )), `${by} regions at ${width}`);
      assert.equal(visibleLines[0].split('\n').length, 1, `${by} sub-tabs at ${width}`);
    }
  }
  const phone = fleetLines(pools, rungs, { width: 55, by: 'lane', ansi: false });
  assert.equal(phone.lines[2], 'high · integration · architecture · adversarial-accept…');
  assert.notEqual(phone.lines[3], 'architecture · adversarial-acceptance');
});

test('Fleet shows a free-model probe strike reason in the provider blurb', () => {
  const result = fleetLines([
    { name: 'opencode', enabled: true, bench: { until: null, reason: 'probe: 404', count: 1 } },
  ], [
    { pool: 'opencode', tier: 'low', model: 'zen/union-free', dispatches: 0 },
  ], { width: 120, by: 'provider', ansi: false });
  assert.match(result.lines.join('\n'), /strike \(probe: 404\)/);
});

test('Fleet lane view keeps the probe reason beside the rung', () => {
  const result = fleetLines([
    { name: 'opencode', enabled: true, bench: { until: null, reason: 'probe: provider error', count: 1 } },
  ], [
    { pool: 'opencode', tier: 'low', model: 'zen/union-free', dispatches: 0 },
  ], { width: 120, by: 'lane', ansi: false });
  assert.match(result.lines.join('\n'), /probe: provider error/);
});
