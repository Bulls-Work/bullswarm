import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyLines, historyNote } from '../src/workflow/history-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line) => String(line ?? '').replace(SGR, '');
const WIDTHS = [54, 55, 80, 100, 200];

const days = [
  {
    date: '2026-09-15',
    runs: [
      { runId: 'wf-old111', shortId: 'old111', project: 'bullswarm', goal: 'older goal', minutes: { wall: 4 }, apiEquivalentUsd: 0.1, finishedAt: '2026-09-15T09:00:00Z' },
      { runId: 'wf-new222', shortId: 'new222', project: 'project-b', goal: 'newer goal', minutes: { wall: 12 }, apiEquivalentUsd: 0.25, finishedAt: '2026-09-15T13:00:00Z' },
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
  assert.match(text, /≈ \$0\.35 API-equivalent estimate/);
  assert.match(text, /12m · ≈ \$0\.25 API-equivalent estimate/);
  const runs = view.regions.filter((region) => region.action.kind === 'run');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].action.runId, 'wf-new222');
});

test('a legacy-only day never prints a money figure and explains read-only state', () => {
  const view = historyLines([days[1]], { width: 120, ansi: false });
  const text = view.lines.join('\n');
  assert.equal(text.includes('$'), false);
  assert.match(text, /read-only/);
  assert.match(text, /no V2 state|no workflow state/);
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
