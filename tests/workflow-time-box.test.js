// The soft time box and the honest early return (0.35.2, requirements 1, 2
// and 7 of step economy; docs/design/step-economy-0.35.2/README.md sections 1
// and 2). History figures come from the scrubbed real-data fixture
// tests/fixtures/home-351; the kernel test runs the real dispatcher with a
// scripted worker in place of the provider CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clearTimeBoxHistoryCache, medianOf, parseNotDone, readTimeBoxHistory, resolveTimeBox,
  returnedEarlyItems, returnedEarlyText, timeBoxForAttempt, timeBoxHistory, timeBoxParagraph, timeBoxText,
} from '../src/workflow/time-box.js';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { notableWatchEvents, renderWatchEvent } from '../src/workflow/watch-cli.js';

const FIXTURE = resolve(new URL('./fixtures/home-351', import.meta.url).pathname);
const history = readTimeBoxHistory(FIXTURE);

test('the fixture box for (codex, implement): 80 succeeded attempts, median 18.86 min, box 1.5 × 18.86 = 28.29 → 30', () => {
  const sample = history.pairs.get('codex|implement');
  assert.equal(sample.length, 80);
  assert.equal(Math.round(medianOf(sample) * 100) / 100, 18.86);
  assert.deepEqual(resolveTimeBox({ action: { kind: 'implement' }, pool: 'codex', history }), {
    minutes: 30, wrapUpMinutes: 21, source: 'pair', n: 80, medianMinutes: 18.86,
  });
});

test('fallbacks: a pair under 5 uses its kind, a kind under 5 or no kind uses 20', () => {
  // grok ran `implement` twice in the fixture: the kind's 82 attempts decide.
  assert.equal(history.pairs.get('grok|implement').length, 2);
  assert.deepEqual(resolveTimeBox({ action: { kind: 'implement' }, pool: 'grok', history }), {
    minutes: 25, wrapUpMinutes: 18, source: 'kind', n: 82, medianMinutes: 18.26,
  });
  // `check` ran twice in the whole fixture (D1: the kind needs 5 too).
  assert.equal(history.kinds.get('check').length, 2);
  assert.deepEqual(resolveTimeBox({ action: { kind: 'check' }, pool: 'grok', history }), {
    minutes: 20, wrapUpMinutes: 14, source: 'fallback', n: null, medianMinutes: null,
  });
  assert.equal(resolveTimeBox({ action: { lane: 'build' }, pool: 'codex', history }).source, 'fallback');
  assert.equal(resolveTimeBox({ action: { kind: 'implement' }, pool: 'codex', history: { pairs: new Map(), kinds: new Map() } }).minutes, 20);
});

test('a role-only step keys history by its role; a kind step keeps its kind even when it also names a role', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-time-box-role-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'workflows', 'wf-acme-role'), { recursive: true });
  const attempts = [10, 12, 14, 16, 18].flatMap((minutes, index) => [
    { actionId: 'draft', status: 'succeeded', pool: 'codex', wallSec: minutes * 60, attempt: index + 1 },
    { actionId: 'build', status: 'succeeded', pool: 'codex', wallSec: 40 * 60, attempt: index + 1 },
  ]);
  writeFileSync(join(home, 'workflows', 'wf-acme-role', 'state.json'), JSON.stringify({
    program: { actions: [
      { id: 'draft', role: 'produce', lane: 'build', effort: 'medium' },
      { id: 'build', kind: 'implement', role: 'produce', lane: 'build', effort: 'medium' },
    ] },
    attempts,
  }));
  const read = readTimeBoxHistory(home);
  assert.deepEqual(read.kinds.get('produce'), [10, 12, 14, 16, 18]);
  assert.deepEqual(read.pairs.get('codex|produce'), [10, 12, 14, 16, 18]);
  assert.equal(read.kinds.get('implement').length, 5);
  // 1.5 × median 14 = 21 → 20. The source label stays `pair`: no new source.
  assert.deepEqual(resolveTimeBox({ action: { role: 'produce' }, pool: 'codex', history: read }), {
    minutes: 20, wrapUpMinutes: 14, source: 'pair', n: 5, medianMinutes: 14,
  });
  assert.equal(resolveTimeBox({ action: { role: 'produce' }, pool: 'grok', history: read }).source, 'kind');
  // The kind wins over the role, so kind-authored steps read kind history.
  assert.equal(resolveTimeBox({ action: { kind: 'implement', role: 'produce' }, pool: 'codex', history: read }).medianMinutes, 40);
});

test('opencode attempts never feed a default, as a pair or inside a kind', () => {
  // The fixture holds three succeeded opencode `implement` attempts (28.51,
  // 115.22 and 27.32 min). Counted, the kind would read 85 attempts with a
  // median of 19.05 min and a box of 30; excluded, 82 and 18.26 → 25.
  assert.equal([...history.pairs.keys()].some((key) => key.startsWith('opencode')), false);
  assert.equal(history.kinds.get('implement').length, 82);
  const box = resolveTimeBox({ action: { kind: 'implement' }, pool: 'opencode', history });
  assert.deepEqual([box.minutes, box.source, box.n], [25, 'kind', 82]);
  // The prefix covers the older opencode2* names and provider clones too.
  const synthetic = { pairs: new Map([['opencode2|implement', [50, 50, 50, 50, 50]]]), kinds: new Map() };
  assert.equal(resolveTimeBox({ action: { kind: 'implement' }, pool: 'opencode2', history: synthetic }).source, 'fallback');
});

test('the box rounds to 5 and stays within 10–60; an authored box is used as given and 0 means none', () => {
  const only = (minutes) => ({ pairs: new Map([['p|implement', minutes]]), kinds: new Map() });
  // Median 4.95 (the snapshot's codex digest median) → 7.4 → 5 → floor 10.
  assert.equal(resolveTimeBox({ action: { kind: 'implement' }, pool: 'p', history: only([4.95, 4.95, 4.95, 4.95, 4.95]) }).minutes, 10);
  assert.equal(resolveTimeBox({ action: { kind: 'implement' }, pool: 'p', history: only([50, 50, 50, 50, 50]) }).minutes, 60);
  // An even sample takes the mean of the two middles: (10 + 12) / 2 × 1.5 = 16.5 → 15.
  assert.equal(resolveTimeBox({ action: { kind: 'implement' }, pool: 'p', history: only([8, 9, 10, 12, 13, 14]) }).minutes, 15);
  assert.deepEqual(resolveTimeBox({ action: { kind: 'implement', timeBox: 45 }, pool: 'codex', history }), {
    minutes: 45, wrapUpMinutes: 32, source: 'program', n: null, medianMinutes: null,
  });
  assert.equal(resolveTimeBox({ action: { kind: 'implement', timeBox: 0 }, pool: 'codex', history }), null);
  assert.equal(timeBoxForAttempt({ action: { timeBox: 0 }, pool: 'codex', startedAt: '2026-09-21T02:04:37Z', history }), null);
});

test('history is read from <home>/workflows once and kept in memory per home', () => {
  clearTimeBoxHistoryCache();
  const first = timeBoxHistory(FIXTURE, { now: 1_000 });
  assert.equal(timeBoxHistory(FIXTURE, { now: 1_000 + 9 * 60_000 }), first);
  assert.notEqual(timeBoxHistory(FIXTURE, { now: 1_000 + 11 * 60_000 }), first);
  assert.deepEqual(first.pairs.get('codex|implement'), history.pairs.get('codex|implement'));
  // A home with no workflows yet has no history, and says so without throwing.
  const empty = mkdtempSync(join(tmpdir(), 'bullswarm-timebox-empty-'));
  try { assert.equal(readTimeBoxHistory(empty).pairs.size, 0); } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('the work and evidence paragraphs name the box, the start clock, the wrap-up point and the three sections', () => {
  const work = timeBoxParagraph({ minutes: 30, startedAt: '2026-09-21T02:04:37Z', timeZone: 'UTC' });
  assert.equal(work, 'Time box: 30 minutes, starting at 02:04:37. It is a guide, not a hard stop. Run `date +%T` every few turns to keep track. '
    + 'Work through the items in order and finish each before starting the next. At about 21 minutes (02:25), stop starting new work and wrap up: '
    + 'make what you have consistent and its tests passing. At 30 minutes (02:34), stop and write the report with three sections: `## Done`, '
    + '`## Not done` (one line per unfinished item, or `- none`), and `## Suggested next step`. An honest partial report, with unfinished items '
    + 'listed under `## Not done`, is better than running long, and much better than calling unfinished work done.');
  const evidence = timeBoxParagraph({ minutes: 20, startedAt: '2026-09-21T23:50:00Z', evidence: true, timeZone: 'Asia/Hong_Kong' });
  assert.match(evidence, /^Time box: 20 minutes, starting at 07:50:00\. It is a guide, not a hard stop\./);
  assert.match(evidence, /At about 14 minutes \(08:04\), stop opening new lines of inspection/);
  assert.match(evidence, /At 20 minutes \(08:10\), finish the evidence preflight with what you have: a requirement you could not finish inspecting is `blocked`/);
  assert.match(evidence, /`## Done`, `## Not done` and `## Suggested next step`/);
  const boxed = timeBoxForAttempt({ action: { kind: 'implement' }, pool: 'codex', startedAt: '2026-09-21T02:04:37Z', history, timeZone: 'UTC' });
  assert.deepEqual(boxed.record, { minutes: 30, wrapUpMinutes: 21, source: 'pair', n: 80, medianMinutes: 18.86, startClock: '02:04:37' });
  assert.equal(boxed.text, work);
});

test('parseNotDone reads the last `Not done` section: top-level items only, `none` is not an item', () => {
  assert.deepEqual(parseNotDone('## Done\n- all of it\n\n## Suggested next step\n- ship'), { count: 0, items: [] });
  assert.deepEqual(parseNotDone('## Done\n- a\n## Not done\n- none\n## Suggested next step\n- ship'), { count: 0, items: [] });
  for (const empty of ['- nothing.', '- N/A', '* —', '- -', '-', '1. None']) {
    assert.equal(parseNotDone(`### Not done\n${empty}`).count, 0, empty);
  }
  const report = [
    '# Report',
    '## Not done',
    '- stale early item from a quoted draft',
    '## Done',
    '- time-box.js',
    '```md',
    '## Not done',
    '- inside a fence: not an item',
    '```',
    '### not done:',
    '- the 55-column frame',
    '  - nested detail is not an item',
    '  continuation text is not an item',
    '* the watch line',
    '2) run the suite',
    '   - three spaces in is nested',
    '',
    '## Suggested next step',
    '- integrate',
  ].join('\n');
  assert.deepEqual(parseNotDone(report), { count: 3, items: ['the 55-column frame', 'the watch line', 'run the suite'] });
  const many = ['## Not done', ...Array.from({ length: 23 }, (_, index) => `- item ${index + 1} ${'word '.repeat(index === 0 ? 80 : 1)}`)].join('\n');
  const parsed = parseNotDone(many);
  assert.equal(parsed.count, 23);
  assert.equal(parsed.items.length, 20);
  assert.ok(parsed.items[0].length <= 300 && parsed.items[0].endsWith('word…'), parsed.items[0]);
  assert.equal(parsed.items[19], 'item 20 word');
});

// Real `## Not done` lines from 0.37 QA runs (QA-REPORT-3, B2): a worker that
// says "none" and explains why did nothing short, and is not flagged.
test('parseNotDone: `none`, `nothing` or `n/a` with a reason or a scope is not an item; real items still count', () => {
  const notItems = [
    "- none for this build step. The independent review rounds and `review-log.json` from TASK.md belong to other workflow actions, so I didn't do them here.",
    '- none. `review-log.json` and the reviewer rounds are separate workflow steps, not part of this one.',
    '- None.',
    '- None — all done.',
    '- none for this step',
    '- nothing left',
    '- Nothing remaining.',
    '- N/A: this step is read-only.',
    '- none - everything in scope is finished',
    '- **None.**',
    '- none (the review is another step)',
    '- Nothing left undone in this action.',
  ];
  for (const line of notItems) assert.equal(parseNotDone(`## Not done\n${line}`).count, 0, line);
  const items = [
    '- f10 and f11 are still unconfirmed.',
    "- The dependency report’s f11 candidate remains unconfirmed and outside this check’s scope.",
    '- **Message-queue report (`report.md` in `runs/s3-research-v037b-r2/proj`) not written.** The task file gives three instructions that cannot all be followed:',
    '- none of the tests pass yet',
    '- nothing handles the empty separator',
    '- None, except the README update.',
    '- none — but the migration is still unwritten',
    '- nonexistent config path is not handled',
  ];
  for (const line of items) assert.equal(parseNotDone(`## Not done\n${line}`).count, 1, line);
  // The p2 build report as the worker wrote it: nothing short.
  const build = [
    '## Done', '- src/slugify.js', '',
    '## Not done',
    "- none for this build step. The independent review rounds and `review-log.json` from TASK.md belong to other workflow actions, so I didn't do them here.",
    '', '## Suggested next step', 'Run the independent reviewer against rules 1–12.',
  ].join('\n');
  assert.deepEqual(parseNotDone(build), { count: 0, items: [] });
});

test('the display strings: returned early, box, and ran only past the box', () => {
  assert.equal(returnedEarlyText({ returnedEarly: { count: 2, items: ['a', 'b'] } }), 'returned early · 2 not done');
  assert.deepEqual(returnedEarlyItems({ returnedEarly: { count: 2, items: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(returnedEarlyItems({ returnedEarly: { count: 2 } }), []);
  assert.equal(returnedEarlyText({}), null);
  assert.equal(timeBoxText({ timeBox: { minutes: 20 }, wallSec: 34 * 60 + 10 }), 'box 20m · ran 34m');
  assert.equal(timeBoxText({ timeBox: { minutes: 20 }, wallSec: 20 * 60 + 20 }), 'box 20m');
  assert.equal(timeBoxText({ timeBox: { minutes: 20 } }, { durationMs: 25 * 60_000 }), 'box 20m · ran 25m');
  assert.equal(timeBoxText({ wallSec: 600 }), null);
});

// --- the kernel, through the real dispatcher --------------------------------

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

const REPORT = {
  build: '## Done\n- build.txt\n\n## Not done\n- the phone frame\n- the watch line\n\n## Suggested next step\n- finish the frames',
  unboxed: '## Done\n- unboxed.txt\n\n## Not done\n- none\n\n## Suggested next step\n- nothing',
};

test('the kernel boxes every step of a v3 program, records the box and the early return, and the dependent reads the report', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-timebox-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace);
  // This home's history is the fixture's: its recorded runs, state only.
  for (const run of readdirSync(join(FIXTURE, 'workflows'))) {
    mkdirSync(join(bullswarmDir, 'workflows', run), { recursive: true });
    cpSync(join(FIXTURE, 'workflows', run, 'state.json'), join(bullswarmDir, 'workflows', run, 'state.json'));
  }
  clearTimeBoxHistoryCache();
  const goal = 'Deliver the requested files';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [
      { id: 'build', lane: 'build', timeBox: 30, prompt: 'Write build.txt.' },
      { id: 'unboxed', lane: 'build', timeBox: 0, dependsOn: ['build'], files: ['unboxed.txt', 'build.txt'], prompt: 'Write unboxed.txt.' },
      {
        id: 'check', dependsOn: ['build', 'unboxed'], prompt: 'Inspect the delivered files.',
        answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } },
      },
    ],
  };
  const tasks = {};
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let clock = Date.parse('2026-09-21T02:04:37Z');
  // Stands in for the provider CLI: writes the task file as watchOnce does,
  // then the report (work) or the answer (check).
  const worker = async (_connector, task, targetDir, files, opts) => {
    const id = opts.attemptId.replace(/-\d+$/, '');
    tasks[id] = task;
    writeFileSync(files.taskFile, task);
    const meta = { exitCode: 0, wallSec: id === 'build' ? 34 * 60 : 60 };
    if (id === 'check') {
      writeFileSync(/to this file: (\S+)/.exec(task)[1], JSON.stringify({ passed: true }));
      writeFileSync(files.outFile, 'checked');
      return { ok: true, why: 'structured output validated', structured: opts.outputValidator(''), meta };
    }
    writeFileSync(join(targetDir, `${id}.txt`), 'done');
    writeFileSync(files.outFile, REPORT[id]);
    return { ok: true, why: 'ok', meta };
  };
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [], runId: 'wf-timebox-abcdef', parentEnv: {},
    initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.', program },
    dependencies: {
      refreshPools: async () => null,
      timeBoxTimeZone: 'UTC',
      dispatchV2Action: (options) => dispatchV2Action({
        ...options,
        pools: [connector('codex')],
        dependencies: {
          watchOnce: worker,
          loadState: () => structuredClone(core),
          saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
          now: () => (clock += 60_000),
          uuid: () => 'session-fixed',
        },
      }),
    },
  });
  assert.equal(run.result.status, 'completed', run.result.reason);

  // Requirement 1: the paragraph closes the step's task, from its own box.
  const byAction = Object.fromEntries(run.state.attempts.map((attempt) => [attempt.actionId, attempt]));
  assert.deepEqual(byAction.build.timeBox, { minutes: 30, wrapUpMinutes: 21, source: 'program', n: null, medianMinutes: null, startClock: byAction.build.timeBox.startClock });
  const start = byAction.build.startedAt.slice(11, 19);
  assert.equal(byAction.build.timeBox.startClock, start);
  assert.ok(tasks.build.endsWith(timeBoxParagraph({ minutes: 30, startedAt: byAction.build.startedAt, timeZone: 'UTC' })), tasks.build.slice(-400));
  assert.equal(readFileSync(byAction.build.taskFile, 'utf8'), tasks.build);
  assert.equal(byAction.build.bytes.taskFile, Buffer.byteLength(tasks.build));
  // `timeBox: 0` leaves the paragraph out and records no box.
  assert.doesNotMatch(tasks.unboxed, /Time box:/);
  assert.equal(Object.hasOwn(byAction.unboxed, 'timeBox'), false);
  // A v3 step has no kind, so the home's history has nothing to key it on:
  // with no box of its own it gets the 20-minute fallback.
  assert.deepEqual([byAction.check.timeBox.minutes, byAction.check.timeBox.source, byAction.check.timeBox.n], [20, 'fallback', null]);
  assert.ok(tasks.check.endsWith(timeBoxParagraph({ minutes: 20, startedAt: byAction.check.startedAt, timeZone: 'UTC' })), tasks.check.slice(-400));

  // Requirement 2: the build report's `## Not done` is recorded and the event
  // says it; `- none` is not an early return. The step still succeeds, and the
  // step after it reads the report, its `## Not done` included.
  assert.deepEqual(byAction.build.returnedEarly, { count: 2, items: ['the phone frame', 'the watch line'] });
  assert.equal(Object.hasOwn(byAction.unboxed, 'returnedEarly'), false);
  assert.equal(run.state.actions.find((action) => action.id === 'build').status, 'succeeded');
  assert.ok(tasks.check.includes(`"actionId":"build","outputFile":"${byAction.build.outputFile}"`), tasks.check);
  const events = readEvents(run.runDir);
  const finished = events.filter((event) => event.type === 'action.finished').map((event) => [event.payload.actionId, event.payload.returnedEarly ?? null]);
  assert.deepEqual(finished, [['build', { count: 2 }], ['unboxed', null], ['check', null]]);
  const lines = notableWatchEvents({ events, state: run.state, nowMs: clock }).notable
    .filter((event) => event.type === 'action.finished')
    .map((event) => renderWatchEvent(event, { now: clock }));
  assert.equal(lines.length, 3);
  // A step with no answer, evidence or deliverable proves nothing (E23).
  assert.match(lines[0], /^(◐|-) build returned early · 2 not done · unproven$/);
  assert.equal(lines.filter((line) => /^(✓|\+) unboxed finished · /.test(line)).length, 1);
});
