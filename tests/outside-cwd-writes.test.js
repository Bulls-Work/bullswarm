// A worker that edits files outside the run's cwd (Second Mate, 2026-10-14:
// six runs with a cwd in one repository edited another and failed
// `not-produced: no file changed` though the work landed). Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markOutsideFalseFailures, outsideWrites } from '../src/workflow/outside-writes.js';
import { deliverableVerdict } from '../src/workflow/dispatch-deliverable.js';
import { rungRecord } from '../src/lib/strategy.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { acceptCallerPlannerResponse } from '../src/workflow/caller-planner.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { STAGE3_RUN_FEATURES, withProgramFormat } from '../src/workflow/run-features.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const bash = (command) => ({ toolName: 'Bash', arguments: { command } });
const stream = (file, events) => writeFileSync(file, events.map((event) => JSON.stringify({ type: 'tool', ...event })).join('\n') + '\n');
const old = (path) => utimesSync(path, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-outside-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'acme-desk');
  const other = join(root, 'acme-hands', 'atlas');
  const run = join(root, 'run');
  for (const dir of [cwd, other, run]) mkdirSync(dir, { recursive: true });
  return { root, cwd, other, run };
}

test('edits made through shell commands in another folder are found; unnamed and old files are not', (t) => {
  const { cwd, other, run } = fixture(t);
  const startedAtMs = Date.now() - 1000;
  writeFileSync(join(other, 'effort-atlas.html'), '<p>edited</p>');
  writeFileSync(join(other, 'sibling-note.md'), 'another agent wrote this');
  writeFileSync(join(other, 'stale.json'), '{}');
  old(join(other, 'stale.json'));
  writeFileSync(join(cwd, 'inside.txt'), 'in the cwd');
  const streamFile = join(run, 'stream-task-attempt-1.jsonl');
  stream(streamFile, [
    bash(`cat ${run}/task-task-attempt-1.md`),
    bash(`cd ${other}; F=effort-atlas.html; python3 - <<'PY'\nopen('effort-atlas.html','w').write('x')\nPY\ngrep -c stale.json $F`),
    bash(`cd ${cwd} && cat inside.txt`),
  ]);
  assert.deepEqual(outsideWrites({ streamFile, targetDir: cwd, startedAtMs }), [join(other, 'effort-atlas.html')]);
  // A file-tool edit names its path directly.
  const calls = [{ tool: 'Edit', args: { file_path: join(other, 'sibling-note.md') } }];
  assert.deepEqual(outsideWrites({ calls, targetDir: cwd, startedAtMs }), [join(other, 'sibling-note.md')]);
  // Nothing named outside, or everything older than the start: nothing.
  assert.deepEqual(outsideWrites({ calls: [{ tool: 'Bash', args: { command: `cd ${cwd} && ls` } }], targetDir: cwd, startedAtMs }), []);
  assert.deepEqual(outsideWrites({ streamFile, targetDir: cwd, startedAtMs: Date.now() + 60_000 }), []);
  // A loose scratch file straight in a temp folder is not work.
  assert.deepEqual(outsideWrites({ calls: [{ tool: 'Write', args: { file_path: join(other, 'effort-atlas.html') } }], targetDir: cwd, startedAtMs, scratchDirs: [other] }), []);
});

test('the deliverable gate credits outside changes instead of failing no file changed', () => {
  const outsideChanged = ['/work/acme-hands/atlas/effort-atlas.html'];
  const legacy = { id: 'task', lane: 'build' };
  assert.equal(deliverableVerdict({ action: legacy, verdict: { ok: true }, snapshotOk: true }).failWhy, 'no file changed');
  assert.deepEqual(deliverableVerdict({ action: legacy, verdict: { ok: true }, snapshotOk: true, outsideChanged }),
    { fact: { type: 'files', gated: true, produced: true, outsideCwd: outsideChanged }, failWhy: null });
  const files = { id: 'task', lane: 'build', deliverable: { type: 'files' } };
  assert.equal(deliverableVerdict({ action: files, verdict: { ok: true }, snapshotOk: true }).failWhy, 'no file changed');
  assert.deepEqual(deliverableVerdict({ action: files, verdict: { ok: true }, snapshotOk: true, outsideChanged }).fact.outsideCwd, outsideChanged);
});

test('a false not-produced and the retry it caused do not count against the pool; a real one does', () => {
  const row = (ok, extra = {}) => ({ ts: '2026-10-14T22:00:00Z', picked: 'echo', lane: 'build', ok, wallSec: 60, reasoning: { effort: 'medium' }, routing: { effort: 'medium' }, ...extra });
  const rows = [row(true), row(false, { failureKind: 'not-produced', falseFailure: 'changed outside cwd: 2 files' }), row(false, { failureKind: 'not-produced' })];
  assert.equal(rungRecord(rows, 'echo', 'medium').okShare, 0.5);
  assert.equal(rungRecord(rows, 'echo', 'medium').dispatches, 3);
});

test('the backfill marks old false failures from their streams and leaves real ones', (t) => {
  const { cwd, other, run } = fixture(t);
  const end = Date.now();
  writeFileSync(join(other, 'effort-atlas.html'), 'edited');
  writeFileSync(join(run, 'project.json'), JSON.stringify({ cwd }));
  stream(join(run, 'stream-task-attempt-1.jsonl'), [bash(`cd ${other} && sed -i '' s/a/b/ effort-atlas.html`)]);
  stream(join(run, 'stream-task-attempt-2.jsonl'), [bash(`cd ${other} && grep b effort-atlas.html`)]);
  const realRun = join(run, '..', 'run-real');
  mkdirSync(realRun);
  writeFileSync(join(realRun, 'project.json'), JSON.stringify({ cwd }));
  stream(join(realRun, 'stream-task-attempt-1.jsonl'), [bash(`cd ${cwd} && ls`)]);
  const failed = (dir, n, ts) => ({ ts: new Date(ts).toISOString(), wallSec: 120, failureKind: 'not-produced', ok: false, actionId: 'task', outFile: join(dir, `out-task-attempt-${n}.md`) });
  const log = [failed(run, 1, end), failed(run, 2, end + 30_000), failed(realRun, 1, end), { ts: 'x', ok: true }];
  assert.equal(markOutsideFalseFailures(log), 2);
  assert.equal(log[0].falseFailure, 'changed outside cwd: 1 file');
  assert.equal(log[1].falseFailure, 'retry after a false not-produced');
  assert.equal(log[2].falseFailure, undefined);
  assert.equal(log[0].ok, false, 'the recorded verdict is kept');
  assert.equal(markOutsideFalseFailures(log), 0, 'running it again changes nothing');
});

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

test('a build step whose worker edits only another folder succeeds, says where, and logs an ok decision', async (t) => {
  const { root, cwd, other } = fixture(t);
  execFileSync('git', ['init', '-q', cwd]);
  writeFileSync(join(cwd, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', cwd, 'add', '.']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const bullswarmDir = join(root, 'home');
  const runId = 'wf-outsd1-abcdef';
  const runDir = join(bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const goal = 'Update the atlas page';
  const goalDocument = createV2GoalDocument({
    goal, cwd, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  let state = createV2State(goalDocument, { runId, shortId: 'outsd1' });
  state = acceptCallerPlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Edit the atlas.',
    program: { schemaVersion: 'bullswarm.workflow.program.v3', steps: [{ id: 'task', prompt: `Edit ${other}/effort-atlas.html.`, lane: 'build', effort: 'low', retry: 0 }] },
  }, { boundary: 'initial', runDir }).state;
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(goalDocument));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(runDir, 'features.json'), `${JSON.stringify(withProgramFormat(STAGE3_RUN_FEATURES, { v3: true }), null, 2)}\n`);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: (options) => dispatchV2Action({
        ...options,
        pools: [connector('codex')],
        dependencies: {
          watchOnce: async (_pool, task, _targetDir, files) => {
            writeFileSync(files.taskFile, task);
            writeFileSync(join(other, 'effort-atlas.html'), '<p>new</p>');
            stream(files.streamFile, [bash(`cd ${other}; python3 edit.py effort-atlas.html`)]);
            writeFileSync(files.outFile, 'Edited the atlas page.');
            return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
          },
          loadState: () => structuredClone(core),
          saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
          now: () => Date.now(),
          uuid: () => 'session-fixed',
        },
      }),
    },
  });
  const attempt = run.state.attempts[0];
  assert.equal(attempt.status, 'succeeded', attempt.why);
  assert.deepEqual(attempt.deliverable, { type: 'files', gated: true, produced: true, outsideCwd: [join(other, 'effort-atlas.html')] });
  const decision = core.decisionLog.at(-1);
  assert.equal(decision.ok, true);
  assert.equal(decision.changedOutsideCwd, 1);
});

test('CLI: strategy recheck-not-produced lists without --yes and marks with it', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { updateState, loadState } = await import('../src/lib/state.js');
  const { cwd, other, run, root } = fixture(t);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(other, 'effort-atlas.html'), 'edited');
  writeFileSync(join(run, 'project.json'), JSON.stringify({ cwd }));
  stream(join(run, 'stream-task-attempt-1.jsonl'), [bash(`cd ${other} && perl -pi -e s/a/b/ effort-atlas.html`)]);
  updateState(home, (state) => {
    state.decisionLog = [{ ts: new Date().toISOString(), picked: 'echo', lane: 'build', ok: false, wallSec: 60, failureKind: 'not-produced', actionId: 'task', outFile: join(run, 'out-task-attempt-1.md') }];
  });
  const bin = new URL('../bin/bullswarm.js', import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, 'strategy', 'recheck-not-produced', ...args], {
    env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_METER_SNAPSHOT_DIR: '' }, encoding: 'utf8',
  });
  const preview = cli();
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), { action: 'preview', count: 1, rows: [{ ts: loadState(home).decisionLog[0].ts, pool: 'echo', run: 'run', falseFailure: 'changed outside cwd: 1 file' }] });
  assert.equal(loadState(home).decisionLog[0].falseFailure, undefined, 'a preview writes nothing');
  assert.equal(JSON.parse(cli('--yes').stdout).action, 'marked');
  assert.equal(loadState(home).decisionLog[0].falseFailure, 'changed outside cwd: 1 file');
  assert.equal(JSON.parse(cli('--yes').stdout).count, 0);
});
