import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateLabel,
  formatHoverLabel,
  renderColumnChart,
  renderLegend,
  renderPanel,
  renderShareBar,
  renderStackedColumnChart,
  renderStatsSurface,
  renderSummaryCard,
} from '../src/workflow/stat-kit.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (text) => String(text ?? '').replace(SGR, '');
const visibleLength = (text) => visible(text).length;
const WIDTHS = [55, 120, 200];

function assertBounded(drawn, width) {
  assert.ok(drawn && Array.isArray(drawn.lines));
  for (const line of drawn.lines) assert.ok(visibleLength(line) <= width, `${width}: ${visible(line)}`);
  for (const region of drawn.regions ?? []) {
    assert.ok(['column', 'slice', 'share'].includes(region.kind));
    assert.ok(region.row >= 1 && region.row <= drawn.lines.length);
    assert.ok(region.columns.start >= 1);
    assert.ok(region.columns.end >= region.columns.start);
    assert.ok(region.columns.end <= width, `${width}: ${JSON.stringify(region)}`);
    assert.ok(region.payload && 'bucketKey' in region.payload);
  }
}

const buckets = [
  { key: '2026-09-13', value: 0.08, tokenSource: 'estimated:utf8-bytes/4' },
  { key: '2026-09-14', value: 2.93, tokenSource: 'estimated:utf8-bytes/4' },
  { key: '2026-09-15', value: 0.36, tokenSource: 'estimated:utf8-bytes/4' },
  { key: '2026-09-16', value: null, tokenSource: 'unknown' },
  { key: '2026-09-17', value: 1.17, tokenSource: 'estimated:utf8-bytes/4' },
  { key: '2026-09-18', value: null, tokenSource: 'unknown' },
  { key: '2026-09-19', value: null, tokenSource: 'unknown' },
];

test('every shared component stays inside 55, 120 and 200 columns', () => {
  for (const width of WIDTHS) {
    assertBounded(renderShareBar({
      parts: [{ id: 'pool-a', label: 'pool-a', value: 3, total: 10, share: 0.3 }, { id: 'pool-b', label: 'pool-b', value: 7, total: 10, share: 0.7 }],
      width, tab: 'spending', metric: 'spend', period: '7d', unit: 'usd', colors: false,
    }), width);
    assertBounded(renderPanel({
      title: 'Pool spend', width, rows: [
        { id: 'pool-a', label: 'pool-a', value: 3, total: 10, share: 0.3 },
        { id: 'pool-b', label: 'pool-b', value: 7, total: 10, share: 0.7 },
      ], tab: 'pool', metric: 'spend', period: '7d', unit: 'usd', colors: false,
    }), width);
    assertBounded(renderColumnChart({ title: 'Spend / day', buckets, width, unit: 'usd', mark: '≈', tab: 'spending', metric: 'spend', period: '7d', colors: false }), width);
    assertBounded(renderStackedColumnChart({
      title: 'Spend / day', buckets, width, unit: 'usd', mark: '≈', tab: 'spending', metric: 'spend', period: '7d',
      series: [
        { id: 'pool-a', values: buckets.map((bucket) => bucket.value == null ? null : bucket.value * 0.4) },
        { id: 'pool-b', values: buckets.map((bucket) => bucket.value == null ? null : bucket.value * 0.6) },
      ], colors: false,
    }), width);
    assertBounded(renderLegend({ items: [{ id: 'pool-a', label: 'a very long pool name' }, { id: 'pool-b', label: 'another pool' }], width, colors: false }), width);
    assertBounded(renderSummaryCard({ title: 'Summary', width, items: [{ id: 'workflows', label: 'workflows', value: 59 }, { id: 'spend', label: 'spend', value: 7.03, unit: 'usd' }] }), width);
  }
});

test('share regions tile a bar with no gaps or overlap', () => {
  const drawn = renderShareBar({
    parts: [
      { id: 'a', label: 'A', value: 1, total: 7, share: 1 / 7 },
      { id: 'b', label: 'B', value: 2, total: 7, share: 2 / 7 },
      { id: 'c', label: 'C', value: 4, total: 7, share: 4 / 7 },
    ], width: 55, tab: 'pool', metric: 'minutes', period: '7d', unit: 'minutes', colors: false,
  });
  const cells = new Map();
  for (const region of drawn.regions) {
    for (let x = region.columns.start; x <= region.columns.end; x += 1) cells.set(x, (cells.get(x) ?? 0) + 1);
  }
  assert.equal(cells.size, 55);
  assert.ok([...cells.values()].every((count) => count === 1));
});

test('stacked slice regions tile each painted column without overlap', () => {
  const drawn = renderStackedColumnChart({
    title: 'Minutes', width: 120, unit: 'minutes', colors: false,
    buckets: [{ key: '2026-09-13', value: 10 }, { key: '2026-09-14', value: 20 }],
    series: [{ id: 'opus', values: [4, 8] }, { id: 'luna', values: [6, 12] }],
  });
  const slices = drawn.regions.filter((region) => region.kind === 'slice');
  assert.ok(slices.length > 0);
  const cells = new Map();
  for (const region of slices) {
    for (let x = region.columns.start; x <= region.columns.end; x += 1) {
      const key = `${region.row}:${x}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...cells.values()].every((count) => count === 1));
  assert.ok(slices.every((region) => region.payload.share >= 0 && region.payload.share <= 1));
});

test('dated axis labels use concrete calendar dates at every target width', () => {
  assert.equal(dateLabel('2026-09-13', { width: 55 }), 'Sep13');
  assert.equal(dateLabel('2026-09-13', { width: 120 }), '13 Sep');
  assert.equal(dateLabel('2026-09-13', { width: 200 }), 'Sun 13 Sep');
  for (const width of WIDTHS) {
    const chart = renderColumnChart({ title: 'Spend', buckets: buckets.slice(0, 3), width, unit: 'usd', mark: '≈', colors: false });
    const text = chart.lines.map(visible).join('\n');
    assert.match(text, width === 55 ? /Sep13/ : width === 120 ? /13 Sep/ : /Sun 13 Sep/);
    assert.doesNotMatch(text, /(?:^|\s)[SMTWF]\s/);
  }
});

test('panel rows keep fixed label/bar/value columns and cut a label only once', () => {
  const panel = renderPanel({
    title: 'Pool spend', width: 29, labelWidth: 14, barWidth: 6, unit: 'usd', colors: false,
    rows: [
      { label: 'claude-code', value: 3.12, total: 7.48, share: 0.418 },
      { label: 'codex', value: 0.27, total: 7.48, share: 0.036 },
      { label: 'claude-code:acme', value: 3.29, total: 7.48, share: 0.44 },
    ],
  });
  const rows = panel.lines.slice(1).map(visible);
  const barStarts = rows.map((line) => line.search(/[▓▒░█#]/));
  assert.equal(new Set(barStarts).size, 1, rows.join('\n'));
  assert.ok(rows.every((line) => line.length === 29));
  assert.ok(rows.every((line) => line.includes('$') && /%$/.test(line)));
  assert.match(rows[2], /claude-co…/);
  assert.doesNotMatch(rows[2], /claude-co….*claude-code/);
});

test('panel hit regions cover the complete drawn track, including zero-filled values', () => {
  const panel = renderPanel({
    title: 'Pool spend', width: 55, labelWidth: 14, barWidth: 6, unit: 'usd', colors: false,
    rows: [
      { label: 'large', value: 3, total: 10, share: 0.3 },
      { label: 'tiny', value: 0.01, total: 100, share: 0.0001 },
      { label: 'zero', value: 0, total: 100, share: 0 },
    ],
  });
  const rows = panel.lines.slice(1).map(visible);
  const regions = panel.regions;
  assert.equal(regions.length, 3);
  assert.deepEqual(regions.map((region) => region.columns.end - region.columns.start + 1), [6, 6, 6]);
  for (const region of regions) {
    const line = rows[region.row - 2];
    for (let x = region.columns.start; x <= region.columns.end; x += 1) {
      assert.match(line[x - 1], /[▓▒░█#.|]/, `${region.payload.label} cell ${x} is not drawn`);
    }
  }
  assert.equal(regions[1].payload.value, 0.01);
  assert.equal(regions[2].payload.value, 0);
});

test('a narrow panel drops its bars before it cuts a value or missing reason', () => {
  const panel = renderPanel({
    title: 'Outcome', width: 28, labelWidth: 14, barWidth: 6, unit: 'runs', colors: false,
    rows: [
      { label: 'Status', value: 59, valueText: 'completed 53 · partial 2' },
      { label: 'Requirements', value: 235, total: 301, share: 235 / 301, valueText: '235/301 passed' },
      { label: '+2 more', value: null, missingReason: 'scroll for more' },
    ],
  });
  const rows = panel.lines.slice(1).map(visible);
  assert.match(rows[0], /completed 53 · partial 2$/);
  assert.match(rows[1], /235\/301 passed 78\.1%$/);
  assert.match(rows[2], /— scroll for more$/);
  assert.ok(rows.every((line) => !/[▓▒░█#]/.test(line)), rows.join('\n'));
});

test('neighbouring dated axis and value labels never touch', () => {
  for (const width of [55, 59, 120]) {
    const chart = renderColumnChart({
      title: 'Spend', width, unit: 'usd', mark: '≈', colors: false,
      buckets: buckets.map((bucket) => ({ ...bucket, value: bucket.value ?? 0.12 })),
    });
    const axis = chart.lines.find((line) => /[+┼].*(?:Sep\d|\d+ Sep)/.test(visible(line)));
    assert.ok(axis, `${width}: missing dated axis`);
    const labels = [...visible(axis).matchAll(/(?:Sep\d{1,2}|\d{1,2} Sep)/g)];
    for (let index = 1; index < labels.length; index += 1) {
      assert.ok(labels[index - 1].index + labels[index - 1][0].length < labels[index].index, `${width}: ${axis}`);
    }
    const values = chart.lines.find((line) => /(?:\$|≈\$)/.test(visible(line)) && !visible(line).startsWith('──'));
    assert.ok(values, `${width}: missing value row`);
    const valueTokens = [...visible(values).matchAll(/≈?\$\d+\.\d{2}/g)];
    for (let index = 1; index < valueTokens.length; index += 1) {
      assert.ok(valueTokens[index - 1].index + valueTokens[index - 1][0].length < valueTokens[index].index, `${width}: ${values}`);
    }
  }
});

test('null and empty series render an honest panel without a zero bar', () => {
  const panel = renderPanel({ title: 'Pool spend', width: 55, colors: false, rows: [{ id: 'unknown', label: 'unknown', value: null, missingReason: 'cost not recorded' }] });
  assert.match(panel.lines.join('\n'), /cost not recorded/);
  assert.deepEqual(panel.regions, []);
  const chart = renderColumnChart({ title: 'Spend', width: 55, unit: 'usd', mark: '≈', colors: false, buckets: [{ key: '2026-09-13', value: null }, { key: '2026-09-14', value: null }] });
  assert.deepEqual(chart.regions, []);
  assert.match(chart.lines.join('\n'), /no measured values/);
  assert.doesNotMatch(chart.lines.slice(1).join('\n'), /[█▇▓▒░]/);
});

test('surface keeps the hover row and child regions at desktop and phone widths', () => {
  for (const width of WIDTHS) {
    const surface = renderStatsSurface({
      tab: 'spending', period: '7d', width, stackBy: 'pool', ansi: false,
      summary: { title: 'Summary', items: [{ label: 'workflows', value: 59 }, { label: 'spend', value: 7.03, unit: 'usd' }] },
      chart: { title: 'Spend / day', buckets: buckets.slice(0, 4), unit: 'usd', mark: '≈', metric: 'spend', colors: false },
      panels: [
        { title: 'Spend share', rows: [{ label: 'pool-a', value: 3, total: 10, share: 0.3 }], unit: 'usd', colors: false },
        { title: 'Minutes share', rows: [{ label: 'pool-a', value: 7, total: 10, share: 0.7 }], unit: 'minutes', colors: false },
        { title: 'Runs', rows: [{ label: 'pool-a', value: 5, total: 10, share: 0.5 }], unit: 'runs', colors: false },
        { title: 'Outcome', rows: [{ label: 'completed', value: 5, total: 10, share: 0.5 }], unit: 'runs', colors: false },
      ],
      legend: { items: [{ id: 'pool-a', label: 'pool-a' }], colors: false },
      notes: ['basis: provider-reported or byte estimate'],
    });
    assertBounded(surface, width);
    assert.equal(surface.lines[2].trim(), '', 'reserved hover row remains present and blank');
    assert.ok(surface.meta.controls.length >= 4);
  }
});

test('hover wording is unit-aware and honest for missing measurements', () => {
  assert.equal(formatHoverLabel({ kind: 'column', bucketLabel: '13 Sep', value: 2.93, share: 1, unit: 'usd' }), '13 Sep · total · $2.93 · 100% of day');
  assert.equal(formatHoverLabel({ kind: 'slice', bucketLabel: '13 Sep', series: 'pool-a', value: 30, share: 0.3, unit: 'minutes' }), '13 Sep · pool-a · 30m · 30% of day');
  assert.equal(formatHoverLabel({ kind: 'share', label: 'pool-a', value: null, share: null, unit: 'usd' }), 'pool-a · value unavailable · share unavailable of panel');
  assert.equal(formatHoverLabel({ kind: 'slice', bucketLabel: '14 Sep', series: 'pool-a', value: null, share: 0.2, unit: 'usd' }), '14 Sep · pool-a · not measured · 20% of the day');
});

test('stacked slices keep the measured bucket value when a series-wide source is unknown', () => {
  const chart = renderStackedColumnChart({
    title: 'Spend', width: 120, unit: 'usd', mark: '≈', colors: false,
    buckets: [{ key: '2026-09-14', label: '14 Sep', value: 10, tokenSource: 'estimated:utf8-bytes/4' }],
    series: [{ id: 'pool-a', values: [6], tokenSource: 'unknown' }, { id: 'pool-b', values: [4], tokenSource: 'unknown' }],
  });
  const slices = chart.regions.filter((region) => region.kind === 'slice');
  assert.ok(slices.length > 0);
  assert.deepEqual(new Set(slices.map((region) => region.payload.value)), new Set([6, 4]));
  assert.ok(slices.every((region) => region.payload.tokenSource === 'estimated:utf8-bytes/4'));
  assert.ok(slices.every((region) => !formatHoverLabel({ ...region.payload, kind: 'slice' }).includes('value unavailable')));
});
