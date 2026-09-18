import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  METER_COLORS, severityColor, meterBar, paceWord, poolWindows, untilText,
  poolSummaryLines, usageLines, loadUsage, parseMouse,
} from '../src/workflow/usage-view.js';
import { registerAssignment } from '../src/lib/assignments.js';

const NOW = Date.parse('2026-09-09T11:09:44.982Z');
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Run `fn` with the env vars set, restoring whatever was there before. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The command-code meter read live at 2026-09-09T10:45:28Z (the fixture
// tests/meters.test.js paces with): a monthly credit allocation that
// rate-limits weekly, so the two windows disagree about surplus.
const SNAPSHOT = {
  captured_at: '2026-09-09T11:09:44.982Z',
  pool: 'command-code',
  five_hour: { utilization: 25.2222, resets_at: '2026-09-09T13:24:01.942Z' },
  seven_day: { utilization: 73.11298889657142, resets_at: '2026-09-10T00:54:20.169Z' },
  monthly: { utilization: 79.38571428571429, resets_at: '2026-09-17T03:06:55.000Z' },
  monthly_quota: { used: 55.57, limit: 70, remaining: 14.43, unit: 'credits' },
  plan_type: 'GOAT',
};

const CODEX_SNAPSHOT = {
  captured_at: '2026-09-09T11:05:00.000Z',
  pool: 'codex',
  five_hour: { utilization: 12, resets_at: '2026-09-09T14:00:00.000Z' },
  seven_day: { utilization: 32, resets_at: '2026-09-12T18:00:00.000Z' },
  monthly_quota: null,
  plan_type: 'prolite',
};

const commandCode = (over = {}) => ({
  name: 'command-code',
  enabled: true,
  usedPct: 79.4,
  elapsedPct: 75.3,
  pace: -4.1,
  pacingWindow: 'monthly',
  incumbentLane: ['high'],
  quarantine: null,
  meterSnapshot: SNAPSHOT,
  ...over,
});

const codex = (over = {}) => ({
  name: 'codex',
  enabled: true,
  usedPct: 32,
  elapsedPct: 27,
  pace: 5,
  pacingWindow: 'weekly',
  incumbentLane: [],
  quarantine: null,
  meterSnapshot: CODEX_SNAPSHOT,
  ...over,
});

const RUNGS = [
  { pool: 'command-code', tier: 'high', model: 'anthropic/claude-opus-4-1', reasoning: 'high', dispatches: 3, okShare: 0.667, medianMinutes: 12.4 },
  { pool: 'command-code', tier: 'medium', model: 'anthropic/claude-sonnet-4-5', reasoning: null, dispatches: 0, okShare: null, medianMinutes: null },
  { pool: 'codex', tier: 'high', model: 'openai/gpt-5-codex', reasoning: 'medium', dispatches: 1, okShare: 1, medianMinutes: 3 },
  { pool: 'codex', tier: 'low', model: 'openai/gpt-5-mini', reasoning: null, dispatches: 8, okShare: null, medianMinutes: null },
];

// --- colour, bars, pace ------------------------------------------------------

test('the meter palette is the mod\'s truecolour set and the prototype\'s roles', () => {
  // The four the Claude Mod's status line draws with, unchanged:
  // mods/bullswarm/hooks/pool-rows.tsx holds its own copy of these.
  assert.equal(METER_COLORS.green, '#b6bd73');
  assert.equal(METER_COLORS.amber, '#e9c880');
  assert.equal(METER_COLORS.red, '#bf6c69');
  assert.equal(METER_COLORS.track, '#3a3a3a');
  // The roles added from the approved prototype's own CSS
  // (docs/design/dashboard-prototype.html: `:root` and `.t1`-`.t4`).
  assert.equal(METER_COLORS.purple, '#a99cf0', 'the prototype\'s --purple, its `.p` class');
  assert.equal(METER_COLORS.orange, '#d2856b', 'the prototype\'s --coral, its `.o` class');
  assert.equal(METER_COLORS.cyan, '#8fc7cf', 'the prototype\'s --cyan, its `.c` class');
  assert.equal(METER_COLORS.dim, '#7c7f8a', 'the prototype\'s --term-dim, its `.d` class');
  assert.equal(METER_COLORS.others, '#55575f', 'the prototype\'s --others share band');
  assert.equal(METER_COLORS.mark, '#ffffff', 'the prototype\'s .mark, the elapsed mark');
  assert.deepEqual(METER_COLORS.heat, ['#4a3f38', '#7a5a48', '#b07a5b', '#d2856b'], '.t1 to .t4, darkest first');
  // One palette, not two: every value is a hex the product can paint, and
  // nothing is added that the prototype does not name.
  assert.deepEqual(Object.keys(METER_COLORS).sort(), [
    'amber', 'cyan', 'dim', 'green', 'heat', 'mark', 'orange', 'others', 'purple', 'red', 'track',
  ]);
  for (const [role, value] of Object.entries(METER_COLORS)) {
    for (const hex of Array.isArray(value) ? value : [value]) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `${role} is a hex value`);
    }
  }
  assert.equal(Object.isFrozen(METER_COLORS), true);
  assert.equal(Object.isFrozen(METER_COLORS.heat), true);
});

test('the heat ramp brightens with the value, so a page reads it as a ramp', () => {
  const tints = METER_COLORS.heat.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)));
  for (let channel = 0; channel < 3; channel += 1) {
    const values = tints.map((tint) => tint[channel]);
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `channel ${String(channel)} brightens`);
  }
});

test('severityColor turns green at 50% used and red at 80%', () => {
  assert.equal(severityColor(0), METER_COLORS.green);
  assert.equal(severityColor(49.9), METER_COLORS.green);
  assert.equal(severityColor(50), METER_COLORS.amber);
  assert.equal(severityColor(79.9), METER_COLORS.amber);
  assert.equal(severityColor(80), METER_COLORS.red);
  assert.equal(severityColor(100), METER_COLORS.red);
  assert.equal(severityColor(null), METER_COLORS.track);
});

test('meterBar is exactly width cells, with the mark where elapsed falls', () => {
  // 32% used of a 10-cell bar is 3 filled; elapsed 27% marks the third cell.
  assert.equal(meterBar(32, 27, 10, { ansi: false }), '##|.......');
  assert.equal(meterBar(50, null, 4, { ansi: false }), '##..');
  assert.equal(meterBar(100, 100, 4, { ansi: false }), '###|');
  assert.equal(meterBar(null, 40, 6, { ansi: false }), '······');
  for (const width of [1, 4, 10, 24, 40]) {
    for (const [used, elapsed] of [[0, 0], [32.5, 27.2], [63.5, 41.2], [100, 99], [12, null]]) {
      assert.equal(meterBar(used, elapsed, width, { ansi: false }).length, width);
    }
  }
});

test('meterBar paints a glyph texture the reader sees without colour', () => {
  // The band used to be coloured blanks, which a terminal that drops colour
  // renders as an empty line. The glyphs carry the reading on their own.
  assert.equal(strip(meterBar(37, 28, 20)), '▇▇▇▇▇▏▇░░░░░░░░░░░░░');
  assert.equal(strip(meterBar(93, 100, 20)), '▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇░▕');
  assert.equal(strip(meterBar(0, null, 6)), '░░░░░░', 'nothing used is an empty track, not a blank line');
  assert.equal(strip(meterBar(null, 40, 6)), '······', 'no meter keeps its dotted track and no mark');
  withEnv({ BULLSWARM_ASCII: '1' }, () => {
    assert.equal(strip(meterBar(37, 28, 20)), '#####|#.............', 'an ascii terminal gets # . |');
    assert.equal(strip(meterBar(100, 100, 6)), '#####|');
    for (const glyph of ['▇', '░', '▏', '▕']) {
      assert.equal(meterBar(37, 28, 20).includes(glyph), false, `${glyph} reached an ascii terminal`);
    }
  });
  for (const width of [1, 4, 10, 24, 40, 64]) {
    for (const [used, elapsed] of [[0, 0], [32.5, 27.2], [100, 99], [12, null], [null, 50]]) {
      assert.equal(strip(meterBar(used, elapsed, width)).length, width, `${String(width)} cells`);
    }
  }
});

test('meterBar keeps the truecolour cells and the white mark', () => {
  const bar = meterBar(32, 27, 10);
  assert.equal(strip(bar).length, 10);
  assert.ok(bar.includes('\x1b[48;2;182;189;115m'), 'green fill for 32% used');
  assert.ok(bar.includes('\x1b[48;2;58;58;58m'), 'the dark track');
  assert.ok(bar.includes(`\x1b[38;2;255;255;255m▏`), 'a white elapsed mark');
  assert.ok(bar.endsWith('\x1b[0m'));

  const hot = meterBar(85, 60, 6);
  assert.ok(hot.includes('\x1b[48;2;191;108;105m'), 'red fill from 80% used');

  // A fully elapsed window marks the last cell with the right half-bar.
  const done = meterBar(100, 100, 6);
  assert.ok(done.includes('▕'));
  assert.equal(strip(done).length, 6);

  // No meter: a dotted track, and no mark even when elapsed is known.
  const unmetered = meterBar(null, 40, 4);
  assert.equal(strip(unmetered), '····');
});

test('paceWord switches at 15 points either way', () => {
  assert.deepEqual(paceWord(35, 50), { text: 'slow +15pp', color: METER_COLORS.amber });
  assert.deepEqual(paceWord(50, 35), { text: 'hot −15pp', color: METER_COLORS.red });
  assert.deepEqual(paceWord(40, 45), { text: 'on track +5pp', color: METER_COLORS.green });
  assert.deepEqual(paceWord(45, 40), { text: 'on track −5pp', color: METER_COLORS.green });
  assert.deepEqual(paceWord(20, 34), { text: 'on track +14pp', color: METER_COLORS.green });
  assert.deepEqual(paceWord(32, null), { text: '', color: METER_COLORS.track });
});

// --- windows -----------------------------------------------------------------

test('poolWindows reads every window, pacing the pool\'s own window from the pool', () => {
  const pool = commandCode();
  const windows = poolWindows(pool, NOW);
  assert.deepEqual(windows.map((w) => w.key), ['5h', '7d', 'mo']);
  assert.equal(windows[0].usedPct, 25.2222);
  assert.equal(windows[0].resetsAt, '2026-09-09T13:24:01.942Z');
  // 5h: 8_056_960ms left of 18_000_000ms → 55.24% elapsed.
  assert.ok(Math.abs(windows[0].elapsedPct - 55.239) < 0.01);
  // 7d: 49_475_187ms left of 604_800_000ms → 91.82% elapsed.
  assert.ok(Math.abs(windows[1].elapsedPct - 91.82) < 0.01);
  // The monthly window is the pool's pacing window: the pool's own number wins.
  assert.equal(windows[2].elapsedPct, 75.3);
  assert.deepEqual(windows.credits, { used: 55.57, limit: 70, unit: 'credits' });
});

test('poolWindows measures a monthly window that does not pace against 30 days', () => {
  const windows = poolWindows(codex(), NOW);
  const byKey = Object.fromEntries(windows.map((w) => [w.key, w]));
  assert.deepEqual(windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(byKey['7d'].elapsedPct, 27, 'the weekly pacing window is the pool\'s');
  // 5h: 10_215_018ms left of 18_000_000ms → 43.25% elapsed.
  assert.ok(Math.abs(byKey['5h'].elapsedPct - 43.25) < 0.01);
  assert.equal(windows.credits, null, 'no credit meter, no credits');

  const monthly = poolWindows(commandCode({ pacingWindow: 'weekly', elapsedPct: 27 }), NOW);
  const mo = monthly.find((w) => w.key === 'mo');
  // 662_230_018ms left of a 30-day window → 74.45% elapsed.
  assert.ok(Math.abs(mo.elapsedPct - 74.45) < 0.01);
});

test('poolWindows reports nothing without a meter snapshot, or for a null window', () => {
  const none = poolWindows({ name: 'plain', enabled: true, pacingWindow: null }, NOW);
  assert.equal(none.length, 0);
  assert.equal(none.credits, null);

  const partial = poolWindows({
    name: 'partial',
    pacingWindow: null,
    meterSnapshot: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 40, resets_at: null } },
  }, NOW);
  assert.deepEqual(partial.map((w) => w.key), ['7d']);
  assert.equal(partial[0].elapsedPct, null, 'no reset time is no elapsed estimate');
});

test('untilText rounds to the window\'s own vocabulary', () => {
  const at = (mins) => new Date(NOW + mins * 60_000).toISOString();
  assert.equal(untilText(at(101), NOW), '1h41m');
  assert.equal(untilText(at(45), NOW), '45m');
  assert.equal(untilText(at(2 * 24 * 60 + 9 * 60), NOW), '2d9h');
  assert.equal(untilText(at(-1), NOW), 'now');
  assert.equal(untilText(null, NOW), '');
});

// --- compact pool rows -------------------------------------------------------

test('poolSummaryLines draws one row per enabled pool', () => {
  const pools = [
    { name: 'alpha', enabled: true, usedPct: 32, elapsedPct: 27, pace: 35.9, incumbentLane: ['high', 'medium'], quarantine: null },
    { name: 'beta', enabled: false, usedPct: 10, elapsedPct: 5, pace: 0, incumbentLane: [] },
    { name: 'gamma', enabled: true, usedPct: null, elapsedPct: null, pace: null, incumbentLane: [] },
  ];
  const assignments = [
    { pool: 'alpha', actionId: 'build-app', lane: 'high' },
    { pool: 'alpha', actionId: null, lane: 'check' },
    { pool: 'beta', actionId: 'hidden', lane: 'low' },
  ];
  const lines = poolSummaryLines(pools, assignments, { width: 100, ansi: false });
  assert.deepEqual(lines, [
    'alpha           ##|.......  32%/27%  +35.9  build-app, check  ← high/medium',
    'gamma           ··········   —  no meter',
  ]);
});

test('poolSummaryLines colours the pace by severity and the work in cyan', () => {
  const pools = [{ name: 'alpha', enabled: true, usedPct: 32, elapsedPct: 27, pace: 35.9, incumbentLane: [], quarantine: null }];
  const [line] = poolSummaryLines(pools, [{ pool: 'alpha', actionId: 'build-app', lane: 'high' }]);
  assert.ok(line.includes('\x1b[48;2;182;189;115m'), 'a green bar at 32% used');
  assert.ok(line.includes('\x1b[38;2;182;189;115m'), 'green pace');
  assert.ok(line.includes('\x1b[36m'), 'cyan running ids');
  assert.ok(strip(line).endsWith('  32%/27%  +35.9  build-app'));

  const [quarantined] = poolSummaryLines([
    { name: 'alpha', enabled: true, usedPct: 91, elapsedPct: 60, pace: null, incumbentLane: [], quarantine: { until: NOW + 60_000, reason: 'quota', kind: 'auto' } },
  ]);
  assert.ok(quarantined.includes('quarantined'));
  assert.ok(quarantined.includes('\x1b[38;2;191;108;105m'), 'red state word');
});

test('poolSummaryLines clips a row to the width it is given', () => {
  const pools = [{ name: 'alpha', enabled: true, usedPct: 32, elapsedPct: 27, pace: 35.9, incumbentLane: [], quarantine: null }];
  const [line] = poolSummaryLines(pools, [{ pool: 'alpha', actionId: 'a-very-long-action-id', lane: 'high' }], { width: 30, ansi: false });
  assert.equal(line.length, 30);
});

// --- the Usage body ----------------------------------------------------------

test('usageLines renders every window, its pace, the credits and the rungs by lane', () => {
  const lines = usageLines([commandCode(), codex()], RUNGS, { width: 80, nowMs: NOW, ansi: false });

  assert.equal(lines[0], 'command-code · GOAT');
  const fiveHour = lines.find((line) => line.startsWith('5h '));
  assert.equal(fiveHour.length, 4 + 68 + 7, 'key label + full-width bar + the used percentage');
  assert.ok(fiveHour.endsWith('  25.2%'));
  assert.ok(lines.includes('    resets 2h14m · slow +30pp'));
  assert.ok(lines.includes('    resets 13h45m · slow +19pp'));
  assert.ok(lines.includes('    resets 7d15h · on track −4pp'));
  assert.ok(lines.includes('    55.57 / 70 credits'));
  assert.ok(lines.includes('codex · prolite'));
  assert.ok(lines.includes(`7d  ${meterBar(32, 27, 68, { ansi: false })}  32.0%`));
  assert.equal(lines.filter((line) => line.startsWith('mo ')).length, 1, 'only the monthly-paced pool reports one');

  assert.ok(lines.includes('Rungs · model · reasoning · record, per lane and pool'));
  assert.ok(lines.includes('[● by lane] [by provider]'));
  assert.ok(lines.includes('high · integration · architecture · adversarial-acceptance'));
  assert.ok(lines.includes('medium · implement · check (the ordinary writers)'));
  assert.ok(lines.includes('low · mechanical · io-read · digest'));
  assert.ok(lines.includes('  command-code    claude-opus-4-1 · high'));
  assert.ok(lines.includes('  command-code    claude-sonnet-4-5'));
  assert.ok(lines.includes('  codex           gpt-5-codex · medium'));
  assert.ok(lines.includes('                  3 runs · 67% ok · p50 12m'));
  assert.ok(lines.includes('                  1 run · 100% ok · p50 3m'));
  assert.ok(lines.includes('                  no runs yet'));
});

test('usageLines groups by provider when the second tab is active', () => {
  const lines = usageLines([commandCode(), codex()], RUNGS, { width: 80, rungsBy: 'provider', nowMs: NOW, ansi: false });
  assert.ok(lines.includes('[by lane] [● by provider]'));
  assert.ok(lines.includes('command-code · monthly window · 79% used of 75% elapsed · incumbent for high'));
  assert.ok(lines.includes('codex · weekly window · 32% used of 27% elapsed'));
  assert.ok(lines.includes('  high            claude-opus-4-1 · high'));
  assert.ok(lines.includes('  high            gpt-5-codex · medium'));
  assert.ok(lines.includes('  medium          claude-sonnet-4-5'));
  assert.ok(lines.includes('  low             gpt-5-mini'));
  assert.ok(!lines.includes('high · integration · architecture · adversarial-acceptance'), 'no lane blurbs when grouped by provider');
});

// The Usage body exactly as 0.33.0 shipped it, captured from the tree at
// commit 433b4bf before the render kit gained the prototype's palette roles
// and the meter gained its texture. The Claude Mod pane and the Home and Run
// pages read these lines, so the palette work must not move one cell of them.
const USAGE_BODY_55 = Object.freeze([
    "command-code · GOAT",
    "5h  ##########.............|...................  25.2%",
    "    resets 2h14m · slow +30pp",
    "7d  ###############################........|...  73.1%",
    "    resets 13h45m · slow +19pp",
    "mo  ################################|#.........  79.4%",
    "    resets 7d15h · on track −4pp",
    "    55.57 / 70 credits",
    "",
    "codex · prolite",
    "5h  #####.............|........................  12.0%",
    "    resets 2h50m · slow +31pp",
    "7d  ###########|#..............................  32.0%",
    "    resets 3d6h · on track −5pp",
    "",
    "Rungs · model · reasoning · record, per lane and pool",
    "[● by lane] [by provider]",
    "",
    "high · integration · architecture · adversarial-accepta",
    "  command-code    claude-opus-4-1 · high",
    "                  3 runs · 67% ok · p50 12m",
    "  codex           gpt-5-codex · medium",
    "                  1 run · 100% ok · p50 3m",
    "",
    "medium · implement · check (the ordinary writers)",
    "  command-code    claude-sonnet-4-5",
    "                  no runs yet",
    "",
    "low · mechanical · io-read · digest",
    "  codex           gpt-5-mini",
    "                  8 runs",
]);

test('usageLines still renders, line for line, what it rendered before the palette work', () => {
  const lines = usageLines([commandCode(), codex()], RUNGS, { width: 55, nowMs: NOW, ansi: false });
  assert.deepEqual(lines, [...USAGE_BODY_55]);
  // And the styled rendering differs from the plain one only in its escapes
  // and in the meter's own cells: same lines, same visible width, same words.
  const styled = usageLines([commandCode(), codex()], RUNGS, { width: 55, nowMs: NOW });
  assert.equal(styled.length, USAGE_BODY_55.length);
  const meterCells = (text) => strip(text).replace(/[#.|\u2587\u2591\u258f\u2595]+/g, '\u2588');
  styled.forEach((line, index) => {
    assert.equal(strip(line).length, USAGE_BODY_55[index].length, `line ${String(index)} changed width`);
    assert.equal(meterCells(line), meterCells(USAGE_BODY_55[index]), `line ${String(index)} changed text`);
  });
});

test('usageLines reads as the page does with ansi, and says so without a meter', () => {
  const pool = { ...commandCode(), meterSnapshot: null };
  const plain = usageLines([pool], [], { width: 60, nowMs: NOW, ansi: false });
  assert.ok(plain.includes('command-code'));
  assert.ok(plain.includes('  no meter reported'));
  assert.ok(plain.includes('  reading rungs…'));

  const styled = usageLines([commandCode()], RUNGS, { width: 80, nowMs: NOW });
  assert.ok(styled[0].includes('\x1b[1mcommand-code\x1b[0m'), 'bold pool name');
  assert.ok(styled.some((l) => l.includes('\x1b[48;2;182;189;115m')), 'a truecolour daily bar');
  assert.ok(styled.some((l) => l.includes('\x1b[36m')), 'cyan model');
  for (const line of styled) assert.ok(strip(line).length <= 80);
});

// --- the loader --------------------------------------------------------------

/** A fixture home: two local connectors, strategy state, a fresh meter cache. */
function fixtureHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-usage-view-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  writeFileSync(join(dir, 'connectors/alpha.json'), JSON.stringify({
    name: 'alpha',
    costRank: 2,
    lanes: ['analyze', 'build'],
    modelSelection: { flag: '--model' },
    meter: { type: 'reader', window: 'monthly' },
  }));
  writeFileSync(join(dir, 'connectors/beta.json'), JSON.stringify({
    name: 'beta',
    costRank: 2,
    lanes: ['analyze'],
    meter: { type: 'reader', window: 'weekly' },
  }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    pools: {},
    incumbents: { high: 'alpha' },
    decisionLog: [
      { ts: '2026-09-09T10:00:00.000Z', picked: 'alpha', effort: 'high', ok: true, wallSec: 600 },
      { ts: '2026-09-09T10:30:00.000Z', picked: 'alpha', effort: 'high', ok: false, wallSec: 300 },
    ],
    strategy: {
      configuredTiers: ['high'],
      modelTiers: { alpha: { 'opus-large': ['high'] } },
    },
  }));
  mkdirSync(join(dir, 'meters'), { recursive: true });
  writeFileSync(join(dir, 'meters/alpha.json'), JSON.stringify(SNAPSHOT));
  return dir;
}

test('loadUsage builds the pools, the ledger and the flattened rungs', async () => {
  const dir = fixtureHome();
  const previous = process.env.BULLSWARM_HOME;
  process.env.BULLSWARM_HOME = dir;
  try {
    registerAssignment(dir, { pool: 'alpha', lane: 'high', actionId: 'build-app', expectedMinutes: 5 });
    const usage = await loadUsage(dir, NOW);

    assert.deepEqual(usage.pools.map((p) => p.name), ['alpha', 'beta']);
    const alpha = usage.pools.find((p) => p.name === 'alpha');
    assert.equal(alpha.meterSnapshot.captured_at, SNAPSHOT.captured_at);
    assert.equal(alpha.incumbentLane.includes('high'), true);

    assert.equal(usage.assignments.length, 1);
    assert.equal(usage.assignments[0].actionId, 'build-app');
    assert.equal(usage.assignments[0].pool, 'alpha');

    assert.deepEqual(usage.rungs, [
      {
        pool: 'alpha',
        tier: 'high',
        model: 'opus-large',
        reasoning: null,
        dispatches: 2,
        okShare: 0.5,
        medianMinutes: 7.5,
      },
      {
        pool: 'beta',
        tier: 'high',
        model: null,
        reasoning: null,
        dispatches: 0,
        okShare: null,
        medianMinutes: null,
      },
    ]);

    assert.equal(usage.capturedAt, SNAPSHOT.captured_at);

    // The body the Usage page draws from the same load: alpha's windows and
    // rung, beta's honest "no meter reported", no rung without a model.
    const lines = usageLines(usage.pools, usage.rungs, { width: 80, nowMs: NOW, ansi: false });
    assert.ok(lines.some((line) => line.startsWith('alpha')));
    assert.ok(lines.includes('    55.57 / 70 credits'));
    assert.ok(lines.includes('beta'));
    assert.ok(lines.includes('  no meter reported'));
    assert.ok(lines.includes('  alpha           opus-large'));
    assert.ok(!lines.some((line) => line.includes('beta            ')), 'a model-less rung is not drawn');
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUsage answers an empty home with an empty page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-usage-view-empty-'));
  const previous = process.env.BULLSWARM_HOME;
  process.env.BULLSWARM_HOME = dir;
  try {
    const usage = await loadUsage(dir, NOW);
    assert.deepEqual(usage.pools, []);
    assert.deepEqual(usage.assignments, []);
    assert.deepEqual(usage.rungs, []);
    assert.equal(usage.capturedAt, null);
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- mouse -------------------------------------------------------------------

test('parseMouse reads press, release and wheel SGR sequences', () => {
  assert.deepEqual(parseMouse('\x1b[<0;10;5M'), { kind: 'press', x: 10, y: 5 });
  assert.deepEqual(parseMouse('\x1b[<0;10;5m'), { kind: 'release', x: 10, y: 5 });
  assert.deepEqual(parseMouse('\x1b[<3;7;2m'), { kind: 'release', x: 7, y: 2 });
  assert.deepEqual(parseMouse('\x1b[<64;3;7M'), { kind: 'wheel-up', x: 3, y: 7 });
  assert.deepEqual(parseMouse('\x1b[<65;3;7M'), { kind: 'wheel-down', x: 3, y: 7 });
  assert.deepEqual(parseMouse('\x1b[<0;80;24Mq'), { kind: 'press', x: 80, y: 24 });
  // Motion with no button held (35) is a move; a drag (32, button 0 held) is not.
  assert.deepEqual(parseMouse('\x1b[<35;12;9M'), { kind: 'move', x: 12, y: 9 });
  assert.equal(parseMouse('\x1b[<32;12;9M'), null);
});

test('parseMouse ignores what is not a click', () => {
  assert.equal(parseMouse('q'), null);
  assert.equal(parseMouse(''), null);
  assert.equal(parseMouse(null), null);
  assert.equal(parseMouse('\x1b[<1;4;4M'), null, 'the middle button is not a page action');
  assert.equal(parseMouse('\x1b[<32;4;4M'), null, 'a drag is not a click');
});
