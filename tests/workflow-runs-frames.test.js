import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildRunsFrames, FRAME_DIR, WIDTHS } from '../scripts/render-runs-0.35.4-frames.mjs';

test('the committed 0.35.4 Runs frames match the fixture and fit', () => {
  const frames = buildRunsFrames();
  for (const width of WIDTHS) {
    const name = `runs-${width}.txt`;
    const lines = frames.get(name);
    const committed = readFileSync(new URL(name, FRAME_DIR), 'utf8').replace(/\n$/, '').split('\n');
    assert.deepEqual(committed, lines);
    assert.ok(lines.every((line) => [...line].length <= width));
  }
  const wide = frames.get('runs-200.txt').join('\n');
  assert.match(wide, /\d+ runs · \d+ tasks · [≥≈~]?\$[\d.]+ · \d+ unpriced/);
  assert.doesNotMatch(wide.split('\n').filter((line) => /^ [✓✗●■·]/.test(line)).join('\n'), /span|API|summed|estimated|unmeasured/);
});
