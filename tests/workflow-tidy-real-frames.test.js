import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildRealFrames,
  COLOUR_DIR,
  COLOUR_FRAMES,
  COLOUR_WIDTHS,
  displayCells,
  FRAME_DIR,
  WIDTHS,
} from '../scripts/render-tidy-0.35.1-frames.mjs';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripped = (line) => String(line ?? '').replace(SGR, '').replace(/\s+$/, '');

/** The frame as it is committed under `docs/design/tidy-0.35.1/frames/`. */
function committed(dir, name) {
  return readFileSync(new URL(name, dir), 'utf8').replace(/\n$/, '').split('\n');
}

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
  // verdict — no `Step ` prefix (requirement 5, step-v2 record rule 1). 0.35.1
  // names it as the Runs list does: `<lane> task · <8-char id>`.
  assert.match(frames.get('real-task-120.txt').join('\n'), /analyze task · 3155fb3c · succeeded/);
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

// Requirement 5: the same screens are kept a second time with their SGR codes,
// so a reviewer greps a colour instead of taking a screenshot's word for it.
test('the colour frames are the same screens with their SGR kept, and each line fits its width', () => {
  const colour = buildRealFrames({ colour: true });
  const plainFrames = buildRealFrames();
  assert.equal(colour.size, COLOUR_FRAMES.length * COLOUR_WIDTHS.length);

  for (const width of COLOUR_WIDTHS) {
    for (const name of COLOUR_FRAMES) {
      const key = `real-${name}-${width}.txt`;
      const lines = colour.get(key);
      assert.ok(lines?.length, `${key} was not rendered in colour`);
      // A colour frame is only useful if it carries codes to grep for.
      assert.ok(lines.some((line) => line.includes('\x1b[')), `${key} carries no SGR code`);
      // Display cells, escapes excluded: a frame never reaches past its width.
      for (const [index, line] of lines.entries()) {
        assert.ok(
          displayCells(line) <= width,
          `${key}:${index + 1} is ${displayCells(line)} cells at width ${width}`,
        );
      }
      // The painted frame is the plain frame plus colour: same screen, one
      // render, so a colour frame is never a second arithmetic.
      assert.deepEqual(lines.map(stripped), plainFrames.get(key).map(stripped), `${key} drifted from its plain frame`);
    }
  }

  // Both committed sets are what the current code renders, so a reviewer reads
  // the repository rather than rerunning the script to find out.
  for (const [name, lines] of plainFrames) {
    assert.deepEqual(committed(FRAME_DIR, name), lines, `${name} on disk is stale — rerun scripts/render-tidy-0.35.1-frames.mjs`);
  }
  for (const [name, lines] of colour) {
    assert.deepEqual(committed(COLOUR_DIR, name), lines, `colour/${name} on disk is stale — rerun scripts/render-tidy-0.35.1-frames.mjs --colour`);
  }

  // The rules the records name, read off the committed wide Step frame: a green
  // verdict, a dim clock, a bold identity and a pool in its own series colour.
  const step200 = committed(COLOUR_DIR, 'real-step-overview-finished-200.txt').join('\n');
  assert.match(step200, /\x1b\[38;2;182;189;115msucceeded\x1b\[0m/);
  assert.match(step200, /\x1b\[1mstep-model\x1b\[22m/);
  assert.match(step200, /\x1b\[2m49m07s · 01:50 → 02:39 HKT · 20 Sep 2026\x1b\[0m/);
  assert.match(step200, /\x1b\[38;2;127;163;224mcodex\x1b\[0m/);
  // A running Step paints its mark amber.
  assert.match(committed(COLOUR_DIR, 'real-step-overview-running-200.txt').join('\n'), /\x1b\[38;2;233;200;128m/);
});

// Verify #2 found three cells of the colour table unpainted on these frames:
// the Run timeline's per-attempt duration, the cursor, and the footer hints.
test('the colour frames dim the attempt clocks and the footer hints, and draw the cursor inverse', () => {
  const colour = buildRealFrames({ colour: true });
  const frame = (name) => colour.get(name);
  const tabRowless = (lines) => lines.slice(1);

  for (const width of COLOUR_WIDTHS) {
    // The duration the row prints at its right edge is a clock: dim.
    const run = frame(`real-run-running-${width}.txt`);
    const attempt = run.find((line) => stripped(line).includes('home-extraction · codex') && stripped(line).endsWith('28m25s'));
    assert.ok(attempt, `run-running-${width}: the home-extraction attempt row is painted`);
    assert.ok(attempt.endsWith('\x1b[2m28m25s\x1b[0m'), `run-running-${width}: ${JSON.stringify(attempt)}`);

    // One cursor on the Run page — the selected phase — drawn inverse.
    const cursorRows = tabRowless(run).filter((line) => line.includes('\x1b[7m'));
    assert.equal(cursorRows.length, 1, `run-running-${width}: ${cursorRows.map(stripped).join(' | ')}`);
    if (width >= 100) assert.ok(cursorRows[0].includes('\x1b[7m[▶ 4 integrate 0/1]\x1b[27m'), JSON.stringify(cursorRows[0]));
    else {
      // The phone shows the glyph strip, so the cursor is the phase's timeline rule.
      assert.equal(stripped(cursorRows[0]), '── ▶ 4 · integrate');
      assert.ok(cursorRows[0].startsWith('\x1b[7m') && cursorRows[0].endsWith('\x1b[27m'), JSON.stringify(cursorRows[0]));
    }

    // The footer hints are meta: dim prose after buttons that keep their faces.
    for (const name of ['run-running', 'run-finished', 'step-overview-finished', 'step-detail-finished', 'task']) {
      const nav = frame(`real-${name}-${width}.txt`).at(-1);
      const hint = /\x1b\[2m( ?Enter [^\x1b]*)\x1b\[0m$/.exec(nav);
      assert.ok(hint, `${name}-${width}: the footer hint is not dim: ${JSON.stringify(nav)}`);
      assert.match(hint[1], /\? help$/);
      assert.doesNotMatch(nav.slice(0, hint.index), /\x1b\[2m/, `${name}-${width}: a button went dim`);
    }
  }
});
