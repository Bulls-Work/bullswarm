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
  // A digest quotes its sources: a `## Not done` line in it is a quotation,
  // not the digest returning early.
  condense: '## build\n- Not done (quoted): the phone frame\n\n## Not done\n- the phone frame (quoted from build)\n',
};

test('the kernel boxes every work and evidence task, records the box and the early return, and hands the not-done items to verify', async (t) => {
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
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const work = (id, over = {}) => ({
    id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
    prompt: `Write ${id}.txt.`, kind: 'implement', evidenceFor: [], inputs: [], produces: [], ...over,
  });
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      work('build'),
      work('unboxed', { timeBox: 0, dependsOn: ['build'], ownedFiles: ['unboxed.txt', 'build.txt'] }),
      { id: 'condense', purpose: 'Condense the build report', dependsOn: ['build'], affects: [], ownedFiles: [], prompt: 'Focus on what build delivered.', kind: 'digest', evidenceFor: [], inputs: [], produces: [] },
      { id: 'verify', purpose: 'Check the delivery', dependsOn: ['build', 'unboxed'], affects: [], ownedFiles: [], prompt: 'Inspect the delivered files.', kind: 'adversarial-acceptance', evidenceFor: ['deliver'], inputs: [], produces: [] },
    ],
  };
  const tasks = {};
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let clock = Date.parse('2026-09-21T02:04:37Z');
  // Stands in for the provider CLI: writes the task file as watchOnce does,
  // then the report (work) or the evidence candidate (verify).
  const worker = async (_connector, task, targetDir, files, opts) => {
    const id = opts.attemptId.replace(/-\d+$/, '');
    tasks[id] = task;
    writeFileSync(files.taskFile, task);
    const meta = { exitCode: 0, wallSec: id === 'build' ? 34 * 60 : 60 };
    if (id === 'verify') {
      const candidatePath = task.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify({
        schemaVersion: 'bullswarm.workflow.evidence.v2',
        requirements: { deliver: { status: 'passed', evidence: ['build.txt and unboxed.txt are present'], concerns: [] } },
      }));
      writeFileSync(files.outFile, 'evidence recorded');
      return { ok: true, why: 'structured output validated', structured: opts.outputValidator('prose'), meta };
    }
    if (id !== 'condense') writeFileSync(join(targetDir, `${id}.txt`), 'done');
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
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, true, 'an early return still succeeds, and the run still verifies');

  // Requirement 1: the paragraph closes the work task, from the fixture pair.
  const byAction = Object.fromEntries(run.state.attempts.map((attempt) => [attempt.actionId, attempt]));
  assert.deepEqual(byAction.build.timeBox, { minutes: 30, wrapUpMinutes: 21, source: 'pair', n: 80, medianMinutes: 18.86, startClock: byAction.build.timeBox.startClock });
  const start = byAction.build.startedAt.slice(11, 19);
  assert.equal(byAction.build.timeBox.startClock, start);
  assert.ok(tasks.build.endsWith(timeBoxParagraph({ minutes: 30, startedAt: byAction.build.startedAt, timeZone: 'UTC' })), tasks.build.slice(-400));
  assert.equal(readFileSync(byAction.build.taskFile, 'utf8'), tasks.build);
  assert.equal(byAction.build.bytes.taskFile, Buffer.byteLength(tasks.build));
  // `timeBox: 0` leaves the paragraph out and records no box.
  assert.doesNotMatch(tasks.unboxed, /Time box:/);
  assert.equal(Object.hasOwn(byAction.unboxed, 'timeBox'), false);
  // Evidence: (codex, adversarial-acceptance) has 3 in the fixture, so the
  // kind's 22 decide: median 14.75 → 22.1 → 20.
  assert.deepEqual([byAction.verify.timeBox.minutes, byAction.verify.timeBox.source, byAction.verify.timeBox.n], [20, 'kind', 22]);
  // A digest task carries the paragraph like every other dispatched step:
  // the (codex, digest) pair has 6 succeeded attempts in the fixture, median
  // 3.96 → 5.94 → 5 → floor 10.
  assert.deepEqual(
    [byAction.condense.timeBox.minutes, byAction.condense.timeBox.wrapUpMinutes, byAction.condense.timeBox.source, byAction.condense.timeBox.n],
    [10, 7, 'pair', 6],
  );
  assert.ok(tasks.condense.startsWith('Bullswarm digest action: condense'));
  assert.ok(tasks.condense.endsWith(timeBoxParagraph({ minutes: 10, startedAt: byAction.condense.startedAt, timeZone: 'UTC' })), tasks.condense.slice(-400));
  assert.match(tasks.condense, /Time box: 10 minutes, starting at \d{2}:\d{2}:\d{2}\./);
  assert.equal(readFileSync(byAction.condense.taskFile, 'utf8'), tasks.condense);
  assert.equal(byAction.condense.bytes.taskFile, Buffer.byteLength(tasks.condense));
  assert.equal(Object.hasOwn(byAction.condense, 'returnedEarly'), false, 'a digest\'s quoted `## Not done` is not an early return');
  assert.match(tasks.verify, /Time box: 20 minutes, starting at \d{2}:\d{2}:\d{2}\.[^\n]*finish the evidence preflight with what you have/);

  // Requirement 2: the build report's `## Not done` is recorded, reaches
  // verify, and the event says it; `- none` is not an early return.
  assert.deepEqual(byAction.build.returnedEarly, { count: 2, items: ['the phone frame', 'the watch line'] });
  assert.equal(Object.hasOwn(byAction.unboxed, 'returnedEarly'), false);
  assert.match(tasks.verify, /Steps that returned early \(their own `## Not done`, quoted; judge each requirement as the workspace stands\):\n- build · 2 not done: the phone frame; the watch line\n/);
  const events = readEvents(run.runDir);
  const finished = events.filter((event) => event.type === 'action.finished').map((event) => [event.payload.actionId, event.payload.returnedEarly ?? null]);
  assert.deepEqual(finished.filter(([id]) => id !== 'condense'), [['build', { count: 2 }], ['unboxed', null]]);
  assert.deepEqual(finished.find(([id]) => id === 'condense'), ['condense', null]);
  const lines = notableWatchEvents({ events, state: run.state, nowMs: clock }).notable
    .filter((event) => event.type === 'action.finished')
    .map((event) => renderWatchEvent(event, { now: clock }));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^(◐|-) build returned early · 2 not done$/);
  assert.equal(lines.filter((line) => /^(✓|\+) unboxed finished · /.test(line)).length, 1);
});
