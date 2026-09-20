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
  // Step v2 moved the toggle out of the header and into the footer hints, and
  // names what each view holds (step-v2 record, rule 1 and the key list).
  assert.match(frames.get('real-step-overview-running-120.txt').join('\n'), /v detail \(every event\)/);
  assert.match(frames.get('real-step-detail-failed-120.txt').join('\n'), /── detail · today's capture-order log/);
  // A single task renders through the same Step header: identity, short id,
  // verdict — no `Step ` prefix (requirement 5, step-v2 record rule 1).
  assert.match(frames.get('real-task-120.txt').join('\n'), /a58fb95e-6f73-4f3a-88d5-8a063155fb3c · a58fb9 · succeeded/);
  // The partly-priced period publishes its recorded subtotal, marked, with the
  // coverage that produced it — never a whole-scope total it does not have.
  assert.match(frames.get('real-stats-spending-200.txt').join('\n'), /≈ \$299\.87 api · 83\/149 priced/);
  assert.match(frames.get('real-stats-model-200.txt').join('\n'), /── Model worker-minutes ─/);

  // 120 columns: the top three cards flow side by side across the width, each
  // about (width − 4)/3 wide, and the licence block reads below them.
  const home120 = frames.get('real-home-120.txt');
  const cardTops = home120.map((line, index) => (line.includes('┌─ ') ? index : -1)).filter((index) => index >= 0);
  const licenceAt = home120.findIndex((line) => line.includes('licence · pool · worker-minutes'));
  assert.equal(cardTops.length, 1, home120.join('\n'));
  assert.equal((home120[cardTops[0]].match(/┌─ /g) ?? []).length, 3, home120[cardTops[0]]);
  assert.equal(home120[cardTops[0]].indexOf('┐') - home120[cardTops[0]].indexOf('┌') + 1, Math.floor((120 - 4) / 3));
  assert.ok(licenceAt > cardTops[0], 'the 120-column licence block did not move below the cards');
  assert.match(home120.join('\n'), /…/, 'a 120-column card field was clipped without an ellipsis');

  // 200 columns: the plan boxes drop both the number's period and the counts
  // that repeat the glyph, and the v2 phase rule ends on its own tally.
  const run200 = frames.get('real-run-running-200.txt');
  assert.match(run200.join('\n'), /\[✓ 1 home-extraction\] → \[✓ 2 runs-extraction\] → \[✓ 3 run-extraction\] → \[▶ 4 integrate 0\/1\] → \[○ 5 verify\]/);
  assert.doesNotMatch(run200.join('\n'), /\[\S+ \d+\. /);
  const phaseRule = run200.find((line) => line.startsWith('── ✓ 1 · home-extraction '));
  assert.match(phaseRule, / · 1\/1$/, phaseRule);
  const spendRows = run200
    .filter((line) => line.includes('API rate') || /│ {2}plans /.test(line))
    .map((line) => line.slice(line.indexOf('│') + 2));
  // The 79-column spend cell: the amount opens the split at the record's own
  // column, and the meter coverage starts there under it.
  assert.match(spendRows[0], /^ API rate   at least \$1\.77 {4}codex \$1\.77$/);
  assert.equal(spendRows[0].indexOf('codex'), 30);
  assert.match(spendRows[1], /^ plans      — {17}0 attempts with a meter reading · 4 without$/);
  assert.equal(spendRows[1].indexOf('0 attempts'), 30);

  // 55 columns: the spend block stays the record's two short rows, with the
  // meter phrase shortened rather than cut off.
  const run55 = frames.get('real-run-running-55.txt').join('\n');
  assert.match(run55, /^ API rate  at least \$1\.77  1 running$/m);
  assert.match(run55, /^ plans     —   0 with a meter reading$/m);
});
