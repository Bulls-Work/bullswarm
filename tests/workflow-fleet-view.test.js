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
  assert.match(text, /\[● by lane\] \[by provider\]/);
  assert.match(text, /\[edit\] read-only here · edit opens bullswarm setup/);
  assert.match(text, /high · integration · architecture · adversarial-acceptance/);
  assert.match(text, /command-code    claude-opus-4-1 · high/);
  assert.match(text, /3 runs · 67% ok · p50 12m/);
  assert.match(text, /no runs yet/);
  // The region names the row it was painted on: the shell places it there
  // rather than searching the paint for '[edit]'.
  assert.deepEqual(result.regions, [{ x: 1, y: 2, width: 6, action: { kind: 'edit' } }]);
  assert.match(plain(result.lines[1]).slice(0, 6), /^\[edit\]$/);
});

test('Fleet groups rungs by provider with meter/reset blurbs', () => {
  const result = fleetLines(pools, rungs, {
    width: 120, by: 'provider', ansi: false,
    nowMs: Date.parse('2026-09-16T12:00:00.000Z'),
  });
  const text = result.lines.join('\n');
  assert.match(text, /\[by lane\] \[● by provider\]/);
  assert.match(text, /command-code · monthly window · 79% used of 75% elapsed · resets 3d0h · incumbent for high/);
  assert.match(text, /high            claude-opus-4-1 · high/);
  assert.match(text, /medium          claude-sonnet-4-5/);
  assert.match(text, /codex · weekly window · 32% used of 27% elapsed/);
});

test('Fleet fits the phone and desktop frame widths', () => {
  for (const width of [54, 55, 80, 100, 200]) {
    const result = fleetLines(pools, rungs, { width, by: 'lane', ansi: true });
    assert.ok(result.lines.length > 0);
    assert.deepEqual(result.lines.filter((line) => plain(line).length > width), [], `width ${width}`);
    assert.ok(result.regions.every((region) => region.x >= 1 && region.x + region.width - 1 <= width));
  }
});

