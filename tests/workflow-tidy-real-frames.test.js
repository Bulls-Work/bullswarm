import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRealFrames, WIDTHS } from '../scripts/render-tidy-0.35.1-frames.mjs';

test('the supplied snapshot renders every 0.35.1 real frame within its width', () => {
  const frames = buildRealFrames();
  assert.equal(frames.size, 36);
  for (const width of WIDTHS) {
    for (const name of [
      'home', 'run-running', 'run-finished',
      'step-overview-running', 'step-overview-finished', 'step-overview-failed',
      'step-detail-running', 'step-detail-finished', 'step-detail-failed', 'task',
      // The owner's second review round reads the Stats pages on a wide
      // terminal, so those frames are captured at every width too.
      'stats-spending', 'stats-model',
    ]) {
      const key = `real-${name}-${width}.txt`;
      const lines = frames.get(key);
      assert.ok(lines?.length, `${key} was not rendered`);
      assert.ok(lines.every((line) => [...line].length <= width), `${key} overflowed`);
    }
  }
  assert.match(frames.get('real-run-running-120.txt').join('\n'), /running/i);
  assert.match(frames.get('real-run-finished-120.txt').join('\n'), /completed/i);
  assert.match(frames.get('real-step-overview-running-120.txt').join('\n'), /\[v detail\]/);
  assert.match(frames.get('real-step-detail-failed-120.txt').join('\n'), /\[v overview\]/);
  assert.match(frames.get('real-task-120.txt').join('\n'), /Step a58fb95e/);
  // The partly-priced period publishes its recorded subtotal, marked, with the
  // coverage that produced it — never a whole-scope total it does not have.
  assert.match(frames.get('real-stats-spending-200.txt').join('\n'), /≈ \$299\.87 api · 83\/149 priced/);
  assert.match(frames.get('real-stats-model-200.txt').join('\n'), /── Model worker-minutes ─/);
});
