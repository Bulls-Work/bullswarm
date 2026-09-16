import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetLines, budgetNotes } from '../src/workflow/budget-view.js';

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

function budgetFixture(overrides = {}) {
  return {
    rows: [{
      name: 'claude-code', planType: 'max20', window: 'weekly',
      usedPct: 40, elapsedPct: 28.9, paceWord: 'on track',
      resetsText: 'Sat, 19 Sep, 20:00 GMT+8', timeZone: 'Asia/Hong_Kong',
      credits: { used: 66.41, limit: 70, unit: 'credits' },
      share: {
        workflows: 8, rest: 32, ratePerMinute: 0.1,
        basis: '≈ 0.1%/min × measured worker-minutes (rate source: meter-history)',
      },
      fits: 20, drawPerRunPct: 3, medianRunMinutes: 30,
      subscription: null,
      apiEquivalentUsd: 0.3,
      apiEquivalentBasis: 'recorded per-attempt API-equivalent estimates',
      biggestRuns: { byMinutes: [{ runId: 'wf-qv6242', shortId: 'qv6242', workerMinutes: 40 }] },
      ...overrides,
    }],
    notes: [],
  };
}

test('Budget renders measured meter, share, fit, biggest run and the two labelled money lines', () => {
  const result = budgetLines(budgetFixture(), { width: 120, ansi: false });
  const text = result.lines.join('\n');
  assert.match(text, /claude-code  Max 20x · weekly window/);
  assert.ok(result.lines.some((line) => line.length === 120), 'the licence meter owns the full line');
  assert.match(text, /Resets Sat, 19 Sep, 20:00 GMT\+8 \(Asia\/Hong_Kong\)/);
  assert.match(text, /66\.41 \/ 70 credits/);
  assert.match(text, /workflows 8% · rest 32%/);
  assert.match(text, /Biggest workflows/);
  assert.match(text, /qv6242 · 40 worker-minutes/);
  assert.match(text, /Subscription rate: —/);
  assert.match(text, /bullswarm strategy set-subscription <pool> --monthly-usd/);
  assert.match(text, /≈ \$0\.30 API-equivalent estimate/);
  assert.equal(result.regions.length, 1);
  const [region] = result.regions;
  assert.deepEqual(
    { x: region.x, width: region.width, action: region.action },
    { x: 3, width: 6, action: { kind: 'run', runId: 'wf-qv6242' } },
  );
  // The region names the row it was painted on, so the shell never has to
  // search the text for it.
  assert.equal(strip(result.lines[region.y - 1]).slice(2, 8), 'qv6242');
});

test('Budget draws no share bar and no "≈ —" for a pool with nothing recorded', () => {
  const budget = budgetFixture({
    share: { workflows: null, rest: null, ratePerMinute: null, basis: 'no measured %/minute rate' },
    apiEquivalentUsd: null,
  });
  const lines = budgetLines(budget, { width: 120, ansi: false }).lines;
  const text = lines.join('\n');
  assert.deepEqual(lines.filter((line) => /[▓░]/.test(line)), [], 'no share bar without a reading');
  assert.doesNotMatch(text, /≈ —/);
  assert.match(text, /Equivalent API rate: — \(no run in this window recorded an API-equivalent estimate/);
  assert.match(text, /workflows \/ rest: — \(no measured %\/minute rate\)/);
});

test('Budget still draws the full workflows bar when the measured share fills the meter', () => {
  const budget = budgetFixture({
    share: {
      workflows: 100, rest: 0, ratePerMinute: 0.155177, exceedsMeter: true, workflowMinutes: 723.06,
      basis: '≈ 0.155177%/min × measured worker-minutes (rate source: meter-history)',
    },
  });
  const result = budgetLines(budget, { width: 120, ansi: false });
  assert.ok(result.lines.some((line) => /^▓+$/.test(line)), 'a measured 100% share is a full bar');
  assert.match(result.lines.join('\n'), /≈ workflows exceeds the reported meter/);
});

test('Budget never splits a word when a line wraps at the phone width', () => {
  const basis = 'no measured %/minute rate was recorded, not an invoice';
  const budget = budgetFixture({
    share: { workflows: null, rest: null, ratePerMinute: null, basis },
    fits: null, fitsBasis: `not computable: ${basis}`,
    apiEquivalentUsd: null,
  });
  // Two lines carry the sentence — the share label and the fit line — so
  // rejoining the paint with single spaces must give it back twice.  A
  // mid-word break ("recorded, no" / "t an invoice") rejoins to
  // "recorded, no t an invoice" and the count drops.  Swept, because the
  // break lands mid-word only at the widths where a space falls just past
  // the frame, so any single width proves nothing.
  const occurrences = (text, needle) => text.split(needle).length - 1;
  for (let width = 40; width <= 90; width += 1) {
    const lines = budgetLines(budget, { width, ansi: false }).lines.map(strip);
    assert.ok(lines.every((line) => line.length <= width), `width ${width}`);
    assert.equal(occurrences(lines.join(' '), basis), 2, `a word is split at ${width} columns`);
  }
});

test('Budget and notes never paint past the supplied frame', () => {
  for (const width of [54, 55, 80, 100, 200]) {
    const result = budgetLines(budgetFixture(), { width, ansi: true });
    assert.ok(result.lines.length > 0);
    assert.deepEqual(result.lines.filter((line) => strip(line).length > width), [], `width ${width}`);
    assert.ok(result.regions.every((region) => region.x >= 1 && region.x + region.width - 1 <= width));
    const notes = budgetNotes(budgetFixture(), { width });
    assert.deepEqual(notes.filter((line) => strip(line).length > width), [], `notes width ${width}`);
  }
});

test('Budget lists disabled pools once in a dim footer, not as meter rows', () => {
  const result = budgetLines({
    ...budgetFixture(),
    disabledPools: ['claude-code:initech', 'echo'],
  }, { width: 120, ansi: true });
  const text = result.lines.join('\n');
  assert.match(text, /\x1b\[2mdisabled: claude-code:initech, echo\x1b\[0m/);
  assert.doesNotMatch(strip(text), /claude-code:initech\s+.*Licence meter/);
});
