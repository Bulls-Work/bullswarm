import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyLines, historyNote } from '../src/workflow/history-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line) => String(line ?? '').replace(SGR, '');
const WIDTHS = [32, 54, 55, 80, 100, 120, 200];

const days = [
  {
    date: '2026-09-15',
    runs: [
      { runId: 'wf-old111', shortId: 'old111', project: 'bullswarm', goal: 'older goal', status: 'completed', minutes: { wall: 4 }, apiEquivalentUsd: 0.1, finishedAt: '2026-09-15T09:00:00Z' },
      { runId: 'wf-new222', shortId: 'new222', project: 'kipwise', goal: 'newer goal', status: 'completed', minutes: { wall: 12 }, apiEquivalentUsd: 0.25, finishedAt: '2026-09-15T13:00:00Z' },
    ],
    finished: 2,
    spendUsd: 0.35,
  },
  {
    date: '2026-09-13',
    runs: [{ runId: 'legacy-333', shortId: 'leg333', legacy: true, project: 'old-project', goal: 'old goal', finishedAt: '2026-09-13T13:00:00Z' }],
    finished: 1,
    spendUsd: null,
  },
];

test('History dates and workflows are newest first, with a run hit region', () => {
  const view = historyLines(days, { width: 120, ansi: false });
  const text = view.lines.join('\n');
  assert.ok(text.indexOf('Tue 15 Sep') < text.indexOf('Sun 13 Sep'));
  assert.ok(text.indexOf('new222') < text.indexOf('old111'));
  assert.match(text, /\(≈ \$0\.35 API\)/);
  assert.match(text, /12m\s+·\s+\(≈ \$0\.25 API\)/);
  assert.match(text, /✓ new222/);
  const runs = view.regions.filter((region) => region.action.kind === 'run');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].action.runId, 'wf-new222');
});

test('a legacy-only day never prints a money figure and explains read-only state', () => {
  const view = historyLines([{
    ...days[1],
    runs: [{ ...days[1].runs[0], costUsd: 99, apiEquivalentUsd: 99 }],
  }], { width: 120, ansi: false });
  const text = view.lines.join('\n');
  assert.equal(text.includes('$'), false);
  assert.match(text, /read-only/);
  assert.match(text, /no recorded API-equivalent cost/);
});

test('History lines and regions fit every required width', () => {
  for (const width of WIDTHS) {
    const view = historyLines(days, { width, ansi: false });
    for (const line of view.lines) assert.ok(visible(line).length <= width, `${width}: ${line}`);
    for (const region of view.regions) {
      assert.ok(region.x + region.width - 1 <= width, `${width}: region overrun`);
    }
  }
});

test('History with no loaded days is explicit, and its note describes scroll paging', () => {
  const empty = historyLines([], { width: 54, ansi: false });
  assert.match(empty.lines.join('\n'), /No workflow history loaded/);
  assert.deepEqual(historyNote(days, { width: 120 }), ['2 days loaded · older days load as you scroll']);
});

test('History keeps finished, running and legacy runs to one primary row at 55 columns', () => {
  const view = historyLines([{
    date: '2026-09-17',
    runs: [
      { runId: 'wf-finished-000001', shortId: 'fin001', project: 'bullswarm', goal: 'finished goal', status: 'completed', minutes: { wall: 4 }, apiEquivalentUsd: 0.25, finishedAt: '2026-09-17T09:00:00Z' },
      { runId: 'wf-running-000002', shortId: 'run002', project: 'bullswarm', goal: 'running goal', unfinished: true, running: true, elapsedMinutes: 3, startedAt: '2026-09-17T10:00:00Z' },
      { runId: 'wf-legacy-000003', shortId: 'leg003', project: 'old-project', goal: 'legacy goal', legacy: true, status: 'completed', minutes: { wall: 2 }, finishedAt: '2026-09-17T08:00:00Z' },
    ],
  }], { width: 55, ansi: false });
  const rows = view.lines.filter((line) => /(?:fin001|run002|leg003)/.test(line));
  assert.equal(rows.length, 3);
  assert.equal(view.regions.filter((region) => region.action.kind === 'run').length, 3);
  assert.match(rows.find((line) => line.includes('fin001')), /✓/);
  assert.match(rows.find((line) => line.includes('fin001')), /\(≈ \$0\.25 API\)/);
  assert.match(rows.find((line) => line.includes('run002')), /●/);
  assert.match(rows.find((line) => line.includes('leg003')), /legacy · read-only/);
});

test('History never paints money for a run or day with no recorded estimate', () => {
  for (const width of [55, 120]) {
    const view = historyLines([{
      date: '2026-09-17',
      runs: [{ runId: 'wf-no-cost-000001', shortId: 'nocost', project: 'bullswarm', goal: 'no estimate', status: 'completed', minutes: { wall: 2 }, finishedAt: '2026-09-17T09:00:00Z' }],
    }], { width, ansi: false });
    const text = view.lines.join('\n');
    assert.equal(text.includes('$'), false, `${width}: no money without an estimate`);
    assert.match(text, /no recorded API-equivalent cost/);
  }
});

test('History keeps identity and trailing metric columns at stable x positions on desktop', () => {
  const view = historyLines([{
    date: '2026-09-16',
    runs: [
      { runId: 'wf-first-000001', shortId: 'first1', project: 'bullswarm', goal: 'short summary', status: 'completed', minutes: { wall: 4 }, apiEquivalentUsd: 0.1, finishedAt: '2026-09-16T09:00:00Z' },
      { runId: 'wf-second-000002', shortId: 'second', project: 'kipwise', goal: 'a much longer summary that still fits the elastic field', status: 'failed', minutes: { wall: 42 }, apiEquivalentUsd: 1.2, finishedAt: '2026-09-16T10:00:00Z' },
    ],
  }], { width: 120, ansi: false });
  const rows = view.lines.filter((line) => /(?:first1|second)/.test(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((line) => line.indexOf('bullswarm') >= 0 ? line.indexOf('bullswarm') : line.indexOf('kipwise')), [11, 11]);
  assert.deepEqual(rows.map((line) => line.match(/\d{2}:\d{2}/)?.index), [114, 114]);
  assert.deepEqual(rows.map((line) => line.slice(3, 9).trim()).sort(), ['first1', 'second']);
});

test('History never truncates visible duration text on phone widths', () => {
  for (const width of [55, 60]) {
    const view = historyLines([{
      date: '2026-09-17',
      runs: [
        { runId: 'wf-duration-000001', shortId: 'dur001', project: 'bullswarm', goal: 'short', status: 'completed', duration: '3h21m', finishedAt: '2026-09-17T09:00:00Z' },
        { runId: 'wf-duration-000002', shortId: 'dur002', project: 'bullswarm', goal: 'long', status: 'completed', duration: '12h34m', finishedAt: '2026-09-17T10:00:00Z' },
      ],
    }], { width, ansi: false });
    const rows = view.lines.filter((line) => line.includes('dur00'));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((line) => !line.includes('…')));
    assert.ok(rows.some((line) => line.includes('3h21m')));
    assert.ok(rows.some((line) => line.includes('12h34m')));
  }
});

test('History emits the shared palette roles for marks, estimates and day totals', () => {
  const view = historyLines([{
    date: '2026-09-17',
    runs: [
      { runId: 'wf-colour-000001', shortId: 'colour', project: 'bullswarm', goal: 'coloured', status: 'completed', minutes: { wall: 1 }, apiEquivalentUsd: 0.2, finishedAt: '2026-09-17T09:00:00Z' },
      { runId: 'wf-failed-000002', shortId: 'failed', project: 'bullswarm', goal: 'failed', status: 'failed', minutes: { wall: 1 }, finishedAt: '2026-09-17T08:00:00Z' },
      { runId: 'wf-running-000003', shortId: 'active3', project: 'bullswarm', goal: 'active', unfinished: true, running: true, elapsedMinutes: 1, startedAt: '2026-09-17T07:00:00Z' },
    ],
  }], { width: 120, ansi: true });
  const text = view.lines.join('\n');
  assert.match(text, /38;2;182;189;115m✓/);
  assert.match(text, /38;2;191;108;105m✗/);
  assert.match(text, /38;2;143;199;207m●/);
  assert.equal((text.match(/38;2;210;133;107m\(≈ \$0\.20 API\)/g) ?? []).length, 1);
  assert.match(text, /38;2;124;127;138m.*\(≈ \$0\.20 API\)/);
});
