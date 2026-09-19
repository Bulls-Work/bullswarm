import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetLines, budgetNotes } from '../src/workflow/budget-view.js';

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');
const visible = (value) => strip(value).length;

function windowRow({ key, usedPct, elapsedPct, resetsInMinutes = null, resetsAt = null } = {}) {
  return { key, usedPct, elapsedPct, resetsInMinutes, resetsAt };
}

function budgetRow(overrides = {}) {
  return {
    name: 'claude-code',
    detectedPlan: null,
    subscription: { monthlyPriceUsd: 200, origin: 'detected', detectedPlan: 'max 20x' },
    credits: null,
    windows: [
      windowRow({ key: '5h', usedPct: 25, elapsedPct: 30, resetsInMinutes: 90 }),
      windowRow({ key: '7d', usedPct: 73, elapsedPct: 54, resetsInMinutes: 2 * 1440 + 18 * 60 }),
      windowRow({ key: 'mo', usedPct: 79, elapsedPct: 83, resetsInMinutes: 11 * 1440 }),
    ],
    ...overrides,
  };
}

function budget(overrides = {}) {
  return { rows: [budgetRow(overrides)], notes: [] };
}

test('Budget is a clean per-window list with a bold pool heading and dim reset lines', () => {
  const result = budgetLines(budget(), { width: 120, ansi: false });
  assert.equal(result.lines[0], 'claude-code');
  assert.match(result.lines[1], /^5h\s+.*25\.0%$/);
  assert.match(result.lines[2], /^  resets 1h30m · on track \+5pp$/);
  assert.match(result.lines[3], /^7d\s+.*73\.0%$/);
  assert.match(result.lines[4], /^  resets 2d18h · fast −19pp$/);
  assert.match(result.lines[5], /^mo\s+.*79\.0%$/);
  assert.match(result.lines[6], /^  resets 11d · on track \+4pp$/);
  assert.equal(result.lines[7], 'plan · $200.00/mo detected max 20x');
  assert.equal(result.lines.join('\n').match(/by bullswarm|other tools|room|so far|biggest|Basis:|attempts measured/g), null);
  assert.ok(result.lines.every((line) => visible(line) <= 120));
});

test('Window bars use pace colours and keep the percentage at the right edge at both review widths', () => {
  for (const width of [55, 120]) {
    const result = budgetLines(budget(), { width, ansi: false });
    const rows = result.lines.filter((line) => /^(?:5h|7d|mo)\s/.test(line));
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(visible(row), width);
      assert.match(row, /[#.|]/, 'the plain-text bar uses # fill, . track and | elapsed mark');
      assert.match(row.slice(-6), /\d+\.0%$/);
    }
    assert.equal(rows[0].slice(-5), '25.0%');
    assert.equal(rows[1].slice(-5), '73.0%');
    assert.equal(rows[2].slice(-5), '79.0%');
  }
  // Painted, the bar is background-coloured cells rather than glyphs, so the
  // fill reads as one solid block at any font (the owner's 0.33.0 review), and
  // the elapsed mark stays a white ▏ on top of whichever cell it lands in.
  const ansi = budgetLines(budget(), { width: 120, ansi: true });
  assert.match(ansi.lines[3], /\x1b\[48;2;191;108;105m/, 'fast bars fill with the red meter colour');
  assert.match(ansi.lines[1], /\x1b\[48;2;182;189;115m/, 'on-track bars fill with the green meter colour');
  assert.match(ansi.lines[1], /\x1b\[48;2;58;58;58m/, 'the unused track is a background-coloured cell');
  assert.match(ansi.lines[1], /\x1b\[38;2;255;255;255m[▏▕]/, 'the elapsed mark is a white ▏');
});

test('Budget renders a pool with one window and never fabricates siblings', () => {
  const result = budgetLines(budget({
    windows: [windowRow({ key: '7d', usedPct: 33, elapsedPct: 100, resetsInMinutes: 54 })],
  }), { width: 120, ansi: false });
  const text = result.lines.join('\n');
  assert.match(text, /7d\s+.*33\.0%/);
  assert.match(text, /resets 54m · slow \+67pp/);
  assert.ok(!result.lines.some((line) => /^(?:5h|mo)\s/.test(line)));
});

test('A window with no reset time omits an invented pace when elapsed time is also unavailable', () => {
  const result = budgetLines(budget({
    windows: [windowRow({ key: '7d', usedPct: 33, elapsedPct: null })],
  }), { width: 55, ansi: false });
  assert.equal(result.lines[2], '  reset time unavailable');
  assert.doesNotMatch(result.lines[2], /pace|on track|slow|fast/);
});

test('Credits stay attached to the monthly row, while plan and disabled lines remain dim page metadata', () => {
  const result = budgetLines({
    rows: [budgetRow({
      subscription: null,
      detectedPlan: 'team',
      credits: { used: 1, limit: 70, unit: 'credits' },
      windows: [windowRow({ key: 'mo', usedPct: 1, elapsedPct: 5, resetsInMinutes: 28 * 1440 + 10 * 60 })],
    })],
    disabledPools: ['echo'],
  }, { width: 120, ansi: false });
  // The percent column is shared by every pool on the page, so the credits
  // ride on the monthly window's reset line instead of widening that column.
  assert.match(result.lines[1], /^mo\s+.*\s+1\.0%$/);
  assert.match(result.lines[2], /resets 28d10h · .* · 1 of 70 credits$/);
  assert.equal(result.lines[3], 'plan team · price unknown');
  assert.equal(result.lines[4], 'disabled: echo');
});

test('Footer keeps the price declaration hint and names Home and Stats as the spend location', () => {
  const rows = ['claude-code', 'codex', 'grok', 'command-code', 'gemini', 'relay']
    .map((name) => budgetRow({ name, subscription: null }));
  const notes = budgetNotes({ rows }, { width: 120 });
  const text = notes.join('\n');
  assert.equal((text.match(/Declare a price:/g) ?? []).length, 1);
  assert.match(text, /bullswarm strategy set-subscription <pool> --monthly-usd <amount>/);
  assert.match(text.replace(/\n/g, ' '), /no price for claude-code, codex, grok, command-code, gemini, relay/);
  assert.match(text, /spend by run is on Home and Stats/);
  assert.doesNotMatch(text, /Basis:|attempts measured|invoice|estimated work/);
});

test('The view never overflows narrow or wide frames and retains pool spacing', () => {
  const result = budgetLines({ rows: [budgetRow({ name: 'first' }), budgetRow({ name: 'second' })] }, { width: 55, ansi: true });
  assert.ok(result.lines.every((line) => visible(line) <= 55));
  assert.ok(result.lines.includes(''));
  assert.deepEqual(result.regions, []);
});

test('a window that has spent anything at all keeps at least one filled cell', () => {
  // Rounding a live 1% down to an empty track reads as "this pool was never
  // touched", which is a different fact from "barely touched".
  const rows = budgetLines(budget({
    windows: [
      windowRow({ key: '5h', usedPct: 0, elapsedPct: 10, resetsInMinutes: 60 }),
      windowRow({ key: '7d', usedPct: 2, elapsedPct: 40, resetsInMinutes: 5000 }),
      windowRow({ key: 'mo', usedPct: 0.4, elapsedPct: 50, resetsInMinutes: 20000 }),
    ],
  }), { width: 60, ansi: false }).lines;
  const bar = (key) => rows.find((line) => line.startsWith(`${key} `)).replace(/^\S+\s+/, '');
  assert.equal(bar('5h').includes('#'), false);
  assert.equal(bar('7d').split('').filter((cell) => cell === '#').length, 1);
  assert.equal(bar('mo').split('').filter((cell) => cell === '#').length, 1);
  // The mark still lands where the clock is, not where the fill ends.
  assert.match(bar('7d'), /^#\.*\|\./);
});
