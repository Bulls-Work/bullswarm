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

test('Budget composes each pool as seven rows and puts the percentage on the textured meter row', () => {
  const result = budgetLines(budget(), { width: 120, ansi: false });
  assert.equal(result.lines.length, 7);
  assert.match(result.lines[0], /claude-code  Max 20x · weekly window/);
  assert.match(result.lines[1], /40% used/);
  assert.ok(/[#$|.]/.test(result.lines[1]), 'the meter row carries a visible texture');
  assert.doesNotMatch(result.lines.join('\n'), /Licence meter/);
  assert.match(result.lines[2], /28.9% of the window elapsed/);
  assert.match(result.lines[4], /[▓#]/);
  assert.match(result.lines[5], /workflows 8% · [░.#|] rest 32%/);
  assert.doesNotMatch(result.lines.join('\n'), /you/);
  assert.match(result.lines[6], /biggest workflows: qv6242/);
  assert.match(result.lines[6], /gcxzza/);
  assert.equal(result.regions.length, 2);
  assert.ok(result.regions.every((region) => region.y === 7));
});

test('An undeclared subscription stays blank, while API money remains an explicitly marked estimate', () => {
  const result = budgetLines(budget({ credits: null, apiEquivalentUsd: 0.3 }), { width: 120, ansi: false });
  const money = result.lines[3];
  assert.match(money, /Subscription rate: —/);
  assert.match(money, /≈ \$0\.30 API-equivalent estimate/);
  assert.doesNotMatch(money.replace('≈ $0.30 API-equivalent estimate', ''), /\$\d/);
  assert.doesNotMatch(money, /\$0\.60|\$0\.90|\$1\.20/);
});

test('A declared price prints only at the subscription rate and is never multiplied', () => {
  const result = budgetLines(budget({
    subscription: { monthlyPriceUsd: 200, basis: 'declared monthly subscription price' },
  }), { width: 120, ansi: false });
  const text = result.lines.join('\n');
  assert.match(text, /\$200\.00\/mo/);
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
  assert.match(text, /workflows \/ rest: — \(no measured %\/minute rate\)/);
  assert.doesNotMatch(text, /you/);
  assert.match(text, /≈ — API-equivalent estimate/);
});

test('Every pool atom and hit region stays inside widths from 32 through 200 columns', () => {
  for (const width of [32, 54, 55, 80, 100, 200]) {
    const result = budgetLines(budget(), { width, ansi: true });
    assert.ok(result.lines.every((line) => visible(line) <= width), `line overflow at ${width}`);
    assert.ok(result.regions.every((region) => region.x >= 1
      && region.x + region.width - 1 <= width
      && region.y >= 1
      && region.y <= result.lines.length), `region overflow at ${width}`);
    assert.equal(result.lines.length, 7);
  }
});

test('The page footer says the undeclared-price reason once for six pools', () => {
  const rows = Array.from({ length: 6 }, (_, index) => budgetRow({
    name: ['claude-code', 'codex', 'grok', 'command-code', 'gemini', 'relay'][index],
    share: { workflows: 1, rest: 2, ratePerMinute: 0.1 },
  }));
  const notes = budgetNotes({ rows, notes: [] }, { width: 120 });
  const text = notes.join('\n');
  assert.equal((text.match(/no declared subscription price/g) ?? []).length, 1);
  assert.match(text, /bullswarm strategy set-subscription <pool> --monthly-usd <amount>/);
});

test('Disabled pools remain one footer row rather than becoming pool blocks', () => {
  const result = budgetLines({ ...budget(), disabledPools: ['codex', 'echo'] }, { width: 120, ansi: true });
  const text = result.lines.join('\n');
  assert.match(text, /disabled: codex, echo/);
  assert.equal(result.lines.length, 8);
});
