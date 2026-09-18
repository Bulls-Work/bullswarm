import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetLines, budgetNotes } from '../src/workflow/budget-view.js';

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');
const visible = (value) => strip(value).length;

function budgetRow(overrides = {}) {
  return {
    name: 'claude-code',
    planType: 'max20',
    window: 'weekly',
    usedPct: 40,
    elapsedPct: 28.9,
    paceWord: 'on track',
    resetsText: 'Sat, 19 Sep, 20:00 GMT+8',
    timeZone: 'Asia/Hong_Kong',
    credits: { used: 66.41, limit: 70, unit: 'credits' },
    share: {
      workflows: 8,
      rest: 32,
      ratePerMinute: 0.1,
      workflowMinutes: 80,
      basis: '≈ 0.1%/min × measured worker-minutes (rate source: meter-history)',
    },
    fits: 20,
    drawPerRunPct: 3,
    medianRunMinutes: 30,
    subscription: null,
    apiEquivalentUsd: 0.3,
    apiEquivalentBasis: 'recorded per-attempt API-equivalent estimates',
    biggestRuns: {
      byMinutes: [
        { runId: 'wf-qv6242', shortId: 'qv6242', workerMinutes: 40, apiEquivalentUsd: 0.3 },
        { runId: 'wf-gcxzza', shortId: 'gcxzza', workerMinutes: 22, apiEquivalentUsd: null },
      ],
    },
    ...overrides,
  };
}

function budget(overrides = {}) {
  return { rows: [budgetRow(overrides)], notes: [] };
}

test('Budget folds measured credits into the used row and preserves run links', () => {
  const result = budgetLines(budget(), { width: 170, ansi: false });
  assert.equal(result.lines.length, 5);
  assert.match(result.lines[0], /claude-code · weekly plan · resets Sat 19 Sep 20:00/);
  assert.match(result.lines[1], /^used\s+.*40% · 29% of the window gone → on track/);
  assert.match(result.lines[2], /^by bullswarm\s+.*≈ 8% \(80 min of work\) · other tools 32%/);
  assert.match(result.lines[3], /^room\s+about 20 more medium runs before the reset/);
  assert.match(result.lines[4], /biggest: qv6242 ≈ \$0.30, gcxzza/);
  assert.match(result.lines[1], /40% · 29% of the window gone → on track · 66 of 70 credits/);
  assert.equal(result.regions.length, 2);
  assert.ok(result.regions.every((region) => region.y === 5));
});

test('An undeclared subscription stays blank, while API money remains an explicitly marked estimate', () => {
  const result = budgetLines(budget({ credits: null, apiEquivalentUsd: 0.3 }), { width: 120, ansi: false });
  const money = result.lines[4];
  assert.doesNotMatch(result.lines.join('\n'), /Subscription rate|\/mo/);
  assert.match(money, /≈ \$0\.30 of API-equivalent work/);
  assert.doesNotMatch(money, /\$0\.60|\$0\.90|\$1\.20/);
});

test('A declared price prints only at the subscription rate and is never multiplied', () => {
  const result = budgetLines(budget({
    subscription: { monthlyPriceUsd: 200, basis: 'declared monthly subscription price' },
  }), { width: 120, ansi: false });
  const text = result.lines.join('\n');
  assert.match(text, /plan · \$200\/mo declared/);
  assert.doesNotMatch(text, /\$400\.00|\$600\.00/);
});

test('A missing share stays blank and the legend never invents a you term', () => {
  const result = budgetLines(budget({
    share: { workflows: null, rest: null, ratePerMinute: null, basis: 'no measured %/minute rate' },
    apiEquivalentUsd: null,
    fits: null,
    fitsBasis: 'not computable: no measured %/minute rate',
  }), { width: 120, ansi: false });
  const text = result.lines.join('\n');
  assert.doesNotMatch(text, /[▓░]/);
  assert.match(text, /by bullswarm\s+no measured usage rate yet/);
  assert.doesNotMatch(text, /you/);
  assert.match(text, /API estimate unrecorded/);
});

test('A zero measured rate names the unknown share and room instead of drawing a bar', () => {
  const result = budgetLines(budget({
    share: { workflows: null, rest: null, workflowMinutes: 922, ratePerMinute: 0, rateSamples: 32, rateNote: 'meter did not move during 32 measured runs' },
    rateNote: 'meter did not move during 32 measured runs',
    fits: null,
    credits: null,
  }), { width: 120, ansi: false });
  assert.match(result.lines.find((line) => line.startsWith('by bullswarm')), /share unknown · meter did not move during 32 measured runs/);
  assert.match(result.lines.find((line) => line.startsWith('room')), /unknown · meter did not move during 32 measured runs/);
  assert.doesNotMatch(result.lines.find((line) => line.startsWith('by bullswarm')), /▇|░|#/);
});

test('Every pool atom and hit region stays inside widths from 32 through 200 columns', () => {
  for (const width of [32, 54, 55, 80, 100, 200]) {
    const result = budgetLines(budget(), { width, ansi: true });
    assert.ok(result.lines.every((line) => visible(line) <= width), `line overflow at ${width}`);
    assert.ok(result.regions.every((region) => region.x >= 1
      && region.x + region.width - 1 <= width
      && region.y >= 1
      && region.y <= result.lines.length), `region overflow at ${width}`);
    assert.equal(result.lines.length, 5);
  }
});

test('The page footer says the undeclared-price reason once for six pools', () => {
  const rows = Array.from({ length: 6 }, (_, index) => budgetRow({
    name: ['claude-code', 'codex', 'grok', 'command-code', 'gemini', 'relay'][index],
    share: { workflows: 1, rest: 2, ratePerMinute: 0.1 },
  }));
  const notes = budgetNotes({ rows, notes: [] }, { width: 120 });
  const text = notes.join('\n');
  assert.equal((text.match(/Declare a price:/g) ?? []).length, 1);
  assert.match(text, /≈ means estimated work, not an invoice/);
  assert.match(text, /bullswarm strategy set-subscription <pool> --monthly-usd <amount>/);
});

test('Budget caps an excessive measured share at the meter and explains it once', () => {
  const row = budgetRow({ credits: null, usedPct: 40, share: { workflows: 131.24, rest: 0, workflowMinutes: 799.95, ratePerMinute: 0.1, exceedsMeter: true } });
  const rendered = budgetLines({ rows: [row] }, { width: 200, ansi: false });
  const bar = rendered.lines[2].trim().split(/\s+/)[2];
  assert.equal([...bar].filter((glyph) => glyph === '▇').length, 16);
  assert.match(rendered.lines[2], /≈ 131% \(800 min of work\) · other tools 0%$/);
  const notes = budgetNotes({ rows: [row, row] }, { width: 200 }).join('\n');
  assert.equal((notes.match(/the meter lags/g) ?? []).length, 1);
});

test('Budget never draws missing meters and retains complete rounded figures at review widths', () => {
  for (const width of [55, 60, 170, 200]) {
    const result = budgetLines(budget({ credits: null, usedPct: null, fits: null }), { width, ansi: false });
    assert.match(result.lines[1], /meter unavailable/);
    assert.match(result.lines[2], /no licence meter/);
    assert.doesNotMatch(result.lines.slice(1, 4).join('\n'), /[░▇▓]|\.{2,}/);
  }
  for (const width of [170, 200]) {
    const result = budgetLines(budget({ credits: null, elapsedPct: 46.4, resetsInMinutes: 3960, share: { workflows: 1.02, rest: 58.98, workflowMinutes: 41.77 }, biggestRuns: [
      { shortId: 'dahnys', runId: 'wf-dahnys', apiEquivalentUsd: 0.43 },
      { shortId: 'w6p38i', runId: 'wf-w6p38i', apiEquivalentUsd: 0.46 },
    ] }), { width, ansi: false });
    assert.match(result.lines[0], /\(in 2d 18h\)$/);
    assert.match(result.lines[2], /≈ 1% \(42 min of work\) · other tools 59%$/);
    assert.match(result.lines[4], /biggest: dahnys ≈ \$0.43, w6p38i ≈ \$0.46$/);
    assert.equal(result.regions.length, 2);
    for (const region of result.regions) assert.equal(result.lines[region.y - 1].slice(region.x - 1, region.x - 1 + region.width), region.action.runId.slice(3));
  }
});

test('Disabled pools remain one footer row rather than becoming pool blocks', () => {
  const result = budgetLines({ ...budget(), disabledPools: ['codex', 'echo'] }, { width: 120, ansi: true });
  const text = result.lines.join('\n');
  assert.match(text, /disabled: codex, echo/);
  assert.equal(result.lines.length, 6);
});

test('an absent Budget row keeps the label column, and one run reads as one run', () => {
  // A pool with no meter: every row is words, and each word starts in the same
  // column as `used` on a pool that does have one, so the block reads as rows.
  const metered = budgetLines(budget(), { width: 170, ansi: false }).lines;
  // Every metered row puts its value in the same column; the absent rows must too.
  const labelColumn = metered.find((line) => line.startsWith('room')).indexOf('about');
  assert.equal(labelColumn, 13);
  const absent = budgetLines(budget({
    usedPct: null, elapsedPct: null, share: null, fits: null, credits: null,
    apiEquivalentUsd: null, biggestRuns: { byMinutes: [] },
  }), { width: 170, ansi: false }).lines;
  const used = absent.find((line) => line.startsWith('used'));
  const bullswarm = absent.find((line) => line.startsWith('by bullswarm'));
  const room = absent.find((line) => line.startsWith('room'));
  assert.equal(used, `used         meter unavailable`);
  assert.equal(bullswarm, `by bullswarm no licence meter`);
  assert.equal(room, `room         no licence meter`);
  for (const [line, reason] of [[used, 'meter unavailable'], [bullswarm, 'no licence meter'], [room, 'no licence meter']]) {
    assert.equal(line.indexOf(reason), labelColumn, line);
  }

  // `about 1 more medium run`, not `1 more medium runs`.
  const one = budgetLines(budget({ fits: 1 }), { width: 170, ansi: false }).lines;
  assert.match(one.find((line) => line.startsWith('room')), /about 1 more medium run before the reset$/);
  const many = budgetLines(budget({ fits: 4 }), { width: 170, ansi: false }).lines;
  assert.match(many.find((line) => line.startsWith('room')), /about 4 more medium runs before the reset$/);
  const none = budgetLines(budget({ fits: 0 }), { width: 170, ansi: false }).lines;
  assert.match(none.find((line) => line.startsWith('room')), /no room left before the reset$/);

  // A run with no recorded cost gets one space before its reason, not two.
  const soFar = metered.find((line) => line.startsWith('so far'));
  assert.match(soFar, /gcxzza \(cost unrecorded\)/);
  assert.doesNotMatch(soFar, /gcxzza {2,}\(cost unrecorded\)/);
});
