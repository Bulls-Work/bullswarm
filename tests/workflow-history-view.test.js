import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  historyLines, historyNote, runTableLayout, runTableLines, taskDescription,
} from '../src/workflow/history-view.js';

const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line) => String(line ?? '').replace(SGR, '');
const WIDTHS = [32, 54, 55, 80, 100, 120, 200];

const days = [
  {
    date: '2026-09-15',
    runs: [
      { runId: 'wf-old111', shortId: 'old111', project: 'bullswarm', goal: 'older goal', status: 'completed', minutes: { wall: 4 }, apiEquivalentUsd: 0.1, finishedAt: '2026-09-15T09:00:00Z' },
      { runId: 'wf-new222', shortId: 'new222', project: 'kitdemo', goal: 'newer goal', status: 'completed', minutes: { wall: 12 }, apiEquivalentUsd: 0.25, finishedAt: '2026-09-15T13:00:00Z' },
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
  assert.match(text, /2 runs · ~\$0\.35/);
  assert.match(text, /12m\s+~\$0\.25/);
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
  assert.match(rows.find((line) => line.includes('fin001')), /~\$0\.25/);
  assert.match(rows.find((line) => line.includes('run002')), /●/);
  assert.match(rows.find((line) => line.includes('leg003')), /legacy g/);
});

test('History never paints money for a run or day with no recorded estimate', () => {
  for (const width of [55, 120]) {
    const view = historyLines([{
      date: '2026-09-17',
      runs: [{ runId: 'wf-no-cost-000001', shortId: 'nocost', project: 'bullswarm', goal: 'no estimate', status: 'completed', minutes: { wall: 2 }, finishedAt: '2026-09-17T09:00:00Z' }],
    }], { width, ansi: false });
    const text = view.lines.join('\n');
    assert.equal(text.includes('$'), false, `${width}: no money without an estimate`);
    assert.match(text, /1 unpriced/);
    assert.match(view.lines.find((line) => line.includes('nocost')), /—/);
  }
});

test('History keeps identity and trailing metric columns at stable x positions on desktop', () => {
  const view = historyLines([{
    date: '2026-09-16',
    runs: [
      { runId: 'wf-first-000001', shortId: 'first1', project: 'bullswarm', goal: 'short summary', status: 'completed', minutes: { wall: 4 }, apiEquivalentUsd: 0.1, finishedAt: '2026-09-16T09:00:00Z' },
      { runId: 'wf-second-000002', shortId: 'second', project: 'kitdemo', goal: 'a much longer summary that still fits the elastic field', status: 'failed', minutes: { wall: 42 }, apiEquivalentUsd: 1.2, finishedAt: '2026-09-16T10:00:00Z' },
    ],
  }], { width: 120, ansi: false });
  const rows = view.lines.filter((line) => /(?:first1|second)/.test(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((line) => line.indexOf('bullswarm') >= 0 ? line.indexOf('bullswarm') : line.indexOf('kitdemo')), [13, 13]);
  assert.deepEqual(rows.map((line) => line.slice(3, 11).trim()).sort(), ['first1', 'second']);
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
    assert.ok(rows.every((line) => !line.includes('3h2…') && !line.includes('12h3…')));
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
  assert.match(text, /38;2;210;133;107m≥\$0\.20/);
  assert.match(text, /38;2;124;127;138m~\$0\.20/);
});

test('History renders finished single tasks beside workflows with fixed duration and time', () => {
  const task = {
    kind: 'task', id: 'task-001', lane: 'build', pool: 'echo', model: 'echo-local',
    project: 'bullswarm', startedAt: '2026-09-18T11:40:00Z', endedAt: '2026-09-18T11:42:05Z',
    durationMs: 125000, ok: true, reason: null, taskFile: '/tmp/task.md',
    taskText: '# Build the aligned Runs table\n\nMore detail.',
  };
  for (const width of [55, 120]) {
    const view = historyLines([{ date: '2026-09-18', runs: 0, finished: 0, rows: [task] }], { width, ansi: false });
    const text = view.lines.join('\n');
    const row = view.lines.find((line) => line.includes('task-001'));
    assert.ok(row, `${width}: task row missing`);
    assert.match(text, /0 runs · 1 task/);
    assert.match(row, /Build th…|Build the aligned Runs table/);
    assert.match(row, /task/);
    assert.match(row, /2m/);
    assert.match(row, /\d{2}:40/);
    assert.equal(view.regions.filter((region) => region.action.kind === 'task').length, 1);
    assert.ok(view.lines.every((line) => visible(line).length <= width), `${width}: task row overran frame`);
  }
});
test('History labels provider, transcript, estimated and unknown daily spend bases', () => {
  const cases = [
    ['provider-reported', /\$1\.23/],
    ['transcript-summed', /≈\$1\.23/],
    ['estimated:utf8-bytes\/4', /~\$1\.23/],
    ['unknown', /~\$1\.23/],
  ];
  for (const [tokenSource, expected] of cases) {
    const view = historyLines([{
      date: '2026-09-18',
      tokenSource,
      spendUsd: 1.23,
      runs: [{
        runId: 'wf-basis-123', shortId: 'basis1', project: 'bullswarm',
        goal: 'basis', status: 'completed', minutes: { wall: 2 },
        apiEquivalentUsd: 1.23, tokenSource, finishedAt: '2026-09-18T09:00:00Z',
      }],
    }], { width: 120, ansi: false });
    assert.match(view.lines.join('\n'), expected, tokenSource);
  }
});

test('Runs rows share columns across interleaved workflows and tasks, including legacy task gaps', () => {
  const rows = [
    {
      runId: 'wf-align-1', shortId: 'align1', project: 'bullswarm', goal: 'Align every row', status: 'completed',
      steps: { done: 7, total: 7 }, minutes: { active: 94 }, apiEquivalentUsd: 65.56,
      tokenSource: 'provider-reported', startedAt: '2026-09-21T09:10:00Z', finishedAt: '2026-09-21T10:44:00Z',
    },
    {
      kind: 'task', id: 'a938c8b5', cwd: '/tmp/customer-portal', taskText: '## Repair the customer import\nbody',
      startedAt: '2026-09-21T08:00:00Z', endedAt: '2026-09-21T08:26:00Z', durationMs: 1_560_000,
      apiEquivalentUsd: 25.87, tokenSource: 'estimated:utf8-bytes/4', ok: true,
    },
    {
      kind: 'task', id: null, project: 'legacy-project', taskText: null,
      startedAt: '2026-09-21T07:00:00Z', endedAt: '2026-09-21T07:03:00Z', durationMs: 180_000, ok: false,
    },
  ];
  const view = historyLines([{ date: '2026-09-21', rows }], { width: 200, ansi: false });
  const rendered = view.lines.filter((line) => /align1|a938c8b5|legacy-project/.test(line));
  assert.equal(rendered.length, 3);
  for (const pattern of [/\b1h34m\b/, /\b26m\b/, /\b3m\b/]) assert.match(rendered.join('\n'), pattern);
  assert.match(rendered[0], /7\/7 steps/);
  assert.match(rendered[1], /Repair the customer import/);
  assert.match(rendered[2], /—/);
  const timeEnds = rendered.map((line) => line.indexOf('m', line.indexOf('steps') >= 0 ? line.indexOf('steps') : line.indexOf('task')));
  assert.equal(new Set(timeEnds).size, 1, rendered.join('\n'));
  const costColumn = rendered[0].indexOf('$65.56');
  assert.equal(rendered[1].indexOf('$25.87'), costColumn);
  assert.equal(rendered[2][costColumn + 5], '—');
  assert.ok(rendered.every((line) => /\d{2}:\d{2}$/.test(line)), rendered.join('\n'));
  assert.equal(new Set(rendered.map((line) => line.length - 5)).size, 1);
  assert.match(view.lines[0], /1 run · 2 tasks · ≥\$91\.43 · 1 unpriced/);
  for (const row of rendered) assert.doesNotMatch(row, /span|API|summed|estimated|unmeasured/);
});

test('Runs table never overflows at any width from 40 through 260', () => {
  for (let width = 40; width <= 260; width += 1) {
    const view = historyLines(days, { width, ansi: false });
    assert.ok(view.lines.every((line) => visible(line).length <= width), `overflow at ${width}`);
  }
});

test('Runs shares one column layout across active and two loaded days', () => {
  const active = [{
    kind: 'task', id: 'active01', project: 'tiny', taskText: '# Active subject',
    startedAt: '2026-09-22T01:02:00Z', durationMs: 60_000, apiEquivalentUsd: 0.32,
    tokenSource: 'provider-reported',
  }];
  const days = [{
    date: '2026-09-21', rows: [{
      runId: 'wf-day-one', shortId: 'day001', project: 'orchard-inventory-system-with-a-long-name',
      goal: 'First day subject', status: 'completed', minutes: { active: 12 },
      apiEquivalentUsd: 4.01, tokenSource: 'transcript-summed',
      startedAt: '2026-09-21T03:04:00Z', finishedAt: '2026-09-21T03:16:00Z',
    }],
  }, {
    date: '2026-09-20', rows: [{
      kind: 'task', id: 'older002', project: 'middle-project', taskText: '# Older subject',
      startedAt: '2026-09-20T05:06:00Z', endedAt: '2026-09-20T05:16:00Z',
      durationMs: 600_000, apiEquivalentUsd: 138.12, tokenSource: 'provider-reported', ok: true,
    }],
  }];
  const all = [...active, ...days.flatMap((day) => day.rows)];
  const layout = runTableLayout(all, { width: 200 });
  const activeLine = runTableLines(active, { width: 200, ansi: false, layout }).lines[0];
  const history = historyLines(days, { width: 200, ansi: false, layout });
  const rendered = [activeLine, ...history.lines.filter((line) => /day001|older002/.test(line))];
  assert.equal(rendered.length, 3);
  assert.ok(rendered.some((line) => line.includes('orchard-inventory…')), rendered.join('\n'));
  const descriptions = ['Active subject', 'First day subject', 'Older subject'];
  assert.equal(new Set(rendered.map((line, index) => line.indexOf(descriptions[index]))).size, 1, rendered.join('\n'));
  const times = ['1m', '12m', '10m'];
  assert.equal(new Set(rendered.map((line, index) => line.indexOf(times[index]) + times[index].length)).size, 1, rendered.join('\n'));
  const costs = ['$0.32', '≈$4.01', '$138.12'];
  assert.equal(new Set(rendered.map((line, index) => line.indexOf(costs[index]) + costs[index].length)).size, 1, rendered.join('\n'));
  assert.equal(new Set(rendered.map((line) => line.length - 5)).size, 1, rendered.join('\n'));
});

test('task descriptions prefer headings and skip worker/worktree preambles', () => {
  const cases = [
    ['You are a Bullswarm worker, not the interactive session. Workspace: /opt/example (open-source checkout). Repair the invoice parser.', 'Repair the invoice parser.'],
    ['Workspace: /srv/demo-release (git worktree, branch sample, HEAD 123abcd). Edit only src/widget.js to keep retries bounded.', 'Edit only src/widget.js to keep retries bounded.'],
    ['Read-only. Repository: /var/tmp/study. Compare the two queue policies.', 'Compare the two queue policies.'],
    ['/made/up/project Fix the cache invalidation bug.', 'Fix the cache invalidation bug.'],
    ['Preamble text.\n\n## Ship the useful heading\n\nMore detail.', 'Ship the useful heading'],
    // Standing rules are not the subject; the first sentence after them is.
    ['Workspace: /srv/demo (git worktree, branch sample). Edit ONLY docs/notes.md. Do not commit. A review found three stale dates in the notes.', 'A review found three stale dates in the notes.'],
    ['You are a worker. Workspace: /opt/example. Run every command yourself, including the browser suite. Never read or write the live home.\n\nOutcome: one pull request that renames the export button.', 'One pull request that renames the export button.'],
    // A labelled subject wins; a clock inside the label is not its colon.
    ['Workspace: /srv/demo. Real data only.\n\nBug reported from a phone at 02:31 HKT: the legend shows short model names.\n\nDeliver: a fix.', 'The legend shows short model names.'],
    ['Read-only study. Workspace: /srv/demo. Edit nothing.\n\nQuestion: which retry policy drops fewer jobs?', 'Which retry policy drops fewer jobs?'],
    ['Workspace: /srv/demo. Never touch the live home.\n\nDeliver two designs: (A) retention of old copies, (B) a size report.', 'Retention of old copies, (B) a size report.'],
    ['Read-only. Workspace: /srv/demo. Edit nothing.', 'Edit nothing.'],
  ];
  for (const [taskText, expected] of cases) assert.equal(taskDescription({ taskText }), expected);
});

test('Runs money is cents-only, including lower bounds and sub-cent estimates', () => {
  const rows = [
    { runId: 'wf-money-1', shortId: 'money1', project: 'sample', goal: 'measured', status: 'completed', minutes: { active: 1 }, apiEquivalentUsd: 0.321, tokenSource: 'provider-reported', finishedAt: '2026-09-21T01:00:00Z' },
    { runId: 'wf-money-2', shortId: 'money2', project: 'sample', goal: 'summed', status: 'completed', minutes: { active: 1 }, apiEquivalentUsd: 4.006, tokenSource: 'transcript-summed', finishedAt: '2026-09-21T02:00:00Z' },
    { runId: 'wf-money-3', shortId: 'money3', project: 'sample', goal: 'partial', status: 'completed', minutes: { active: 1 }, apiEquivalentUsd: 138.124, tokenSource: 'provider-reported', usage: { attempts: 2, pricedAttempts: 1, measuredAttempts: 1, apiKnownSubtotalUsd: 138.124 }, finishedAt: '2026-09-21T03:00:00Z' },
    { runId: 'wf-money-4', shortId: 'money4', project: 'sample', goal: 'tiny', status: 'completed', minutes: { active: 1 }, apiEquivalentUsd: 0.000661, tokenSource: 'estimated:utf8-bytes/4', finishedAt: '2026-09-21T04:00:00Z' },
  ];
  const lines = historyLines([{ date: '2026-09-21', rows }], { width: 200, ansi: false }).lines;
  const text = lines.join('\n');
  assert.match(text, /\$0\.32/);
  assert.match(text, /≈\$4\.01/);
  assert.match(text, /≥\$138\.12/);
  assert.match(text, /~<\$0\.01/);
  assert.match(lines[0], /≥\$142\.45/);
  assert.doesNotMatch(text, /0\.000661|138\.124|4\.006/);
});

test('legacy anonymous tasks derive start and describe known lane, pool and cwd project', () => {
  const endedAt = '2026-09-18T03:05:07.960Z';
  const durationMs = 19 * 60_000;
  const expectedDate = new Date(Date.parse(endedAt) - durationMs);
  const expectedClock = `${String(expectedDate.getHours()).padStart(2, '0')}:${String(expectedDate.getMinutes()).padStart(2, '0')}`;
  const task = {
    kind: 'task', id: null, taskText: null, lane: 'build', pool: 'codex',
    cwd: '/made/up/sample-project', endedAt, durationMs, ok: true,
  };
  const row = historyLines([{ date: '2026-09-18', rows: [task] }], { width: 120, ansi: false })
    .lines.find((line) => line.includes('build task on codex'));
  assert.ok(row);
  assert.match(row, /sample-project/);
  assert.ok(row.endsWith(expectedClock), row);
  assert.doesNotMatch(row, /task\s+19m\s+—\s+—$/);
});

test('55-column day headers keep full run and task words', () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, index) => ({
      runId: `wf-header-${index}`, shortId: `head0${index}`, project: 'sample', goal: 'header run',
      status: 'completed', minutes: { active: 1 }, finishedAt: `2026-09-21T0${index + 1}:00:00Z`,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      kind: 'task', id: `task-0${index}`, project: 'sample', taskText: '# Header task', durationMs: 60_000,
      endedAt: `2026-09-21T1${index}:00:00Z`, ok: true,
    })),
  ];
  const header = historyLines([{ date: '2026-09-21', rows }], { width: 55, ansi: false }).lines[0];
  assert.match(header, /2 runs · 7 tasks/);
  assert.doesNotMatch(header, /\b2r\b|\b7t\b/);
  assert.ok(header.length <= 55);
});
