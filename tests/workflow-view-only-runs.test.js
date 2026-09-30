// 0.38.0 (design D1, D3): only a run marked `programFormat: 3` is driven. A v2
// run, a stage-1/2/3 run and a legacy run were started by an earlier Bullswarm
// and are view-only: resume, pause, steer and step rerun/accept/restart answer
// with one sentence and exit 2 and write nothing; `workflow cancel` still
// finalizes a v2 run that never finished. A legacy run's show, result, watch
// and tui print a short summary from its own files instead of refusing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { legacyRunLine } from '../src/workflow/short-id.js';
import { viewOnlyRunLine } from '../src/workflow/cli-run-lookup.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const GOAL = 'Deliver the requested files';
const STAGE2 = { deliverableGate: 1, proofLabels: 1 };
const message = (token) => `run ${token} was started by an earlier Bullswarm and is view-only; start a new run: bullswarm workflow goal "<goal>" --cwd <run folder> --program <file.json>`;

const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.', program });
const v2Program = () => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions: [work('build'), work('docs', { dependsOn: ['build'] }), work('side')] });
const v3Program = () => ({ schemaVersion: 'bullswarm.workflow.program.v3', steps: [{ id: 'side', prompt: 'Write side.txt.' }] });

// `build` fails its check, `docs` (after build) is blocked, every other step succeeds.
async function dispatch(options) {
  const id = options.action.id;
  const files = options.paths(1);
  const record = {
    ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'running',
    startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
  };
  writeFileSync(files.taskFile, options.taskText);
  options.onAttempt?.('started', record);
  if (id === 'build') {
    const why = 'command evidence failed: npm test → exit 1';
    writeFileSync(files.outFile, `tried ${id}`);
    Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'failed-evidence', why, changedFileCount: 1 });
    options.onAttempt?.('finished', record, { ok: false, why });
    return { ok: false, status: 'failed', failureKind: 'failed-evidence', attempts: [record], verdict: { ok: false, why } };
  }
  writeFileSync(join(options.targetDir, `${id}.txt`), options.action.prompt);
  writeFileSync(files.outFile, `delivered ${id}`);
  Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
  options.onAttempt?.('finished', record);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
}

// A finished run. `marker` undefined keeps the features.json the launch
// wrote, null removes it (a run saved by 0.35.6), an object replaces it.
// `interrupted` leaves a run whose kernel stopped before its result.
async function savedRun(t, { runId, program = v2Program(), marker, interrupted = false }) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-view-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(workspace); mkdirSync(home);
  const v3 = program.schemaVersion.endsWith('.v3');
  const goalDocument = createV2GoalDocument({
    goal: GOAL, cwd: workspace,
    requirements: v3 ? implicitV3Requirements(GOAL) : [{ id: 'deliver', text: 'Deliver the requested files.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const launch = runV2AutonomousWorkflow({
    bullswarmDir: home, goalDocument, pools: [], runId, initialPlannerResponse: response(program),
    dependencies: {
      dispatchV2Action: dispatch,
      ...(interrupted ? { writeResultAtomic: () => { throw new Error('disk full'); } } : {}),
    },
  });
  if (interrupted) await assert.rejects(launch, /disk full/);
  else await launch;
  const runDir = join(home, 'workflows', runId);
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  if (marker === null) rmSync(join(runDir, 'features.json'));
  else if (marker) writeFileSync(join(runDir, 'features.json'), `${JSON.stringify(marker)}\n`);
  return { root, home, workspace, runDir, runId, token: state.shortId, status: state.lifecycle.status };
}

// A pre-0.27.0 authored-graph run: its state.json has no v2 schemaVersion.
function legacyRun(t) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-view-only-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runId = 'wf-legacy-abc123';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    runId, shortId: 'kgc234', workflow: 'smoke-two-step', status: 'completed',
    steps: [{ phase: 'first', stepId: 'step-one', type: 'run', ok: true }],
    startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:53:08.084Z',
  }, null, 2));
  return { home, runDir, runId, token: 'kgc234' };
}

// Every file under the run's folder and its goal folder, with its bytes.
function snapshot(home, runId) {
  const out = {};
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(join(home, 'workflows', runId), 'run/');
  walk(join(home, 'goals', runId), 'goal/');
  return out;
}

function cli(home, args) {
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

const DRIVING = (token) => [
  ['resume', ['workflow', 'resume', token]],
  ['pause', ['workflow', 'pause', token]],
  ['steer', ['workflow', 'steer', token, 'also do x']],
  ['step rerun', ['workflow', 'step', 'rerun', token, 'build']],
  ['step accept', ['workflow', 'step', 'accept', token, 'build', '--reason', 'good enough']],
  ['step restart', ['workflow', 'step', 'restart', token, 'build']],
];

function assertRefusesDriving(f, label) {
  const line = message(f.token);
  assert.equal(viewOnlyRunLine(f.token), line);
  const before = snapshot(f.home, f.runId);
  for (const [verb, args] of DRIVING(f.token)) {
    const text = cli(f.home, args);
    assert.deepEqual([text.status, text.stdout, text.stderr], [2, '', `${line}\n`], `${label}: ${args.join(' ')}`);
    const json = cli(f.home, [...args, '--json']);
    assert.equal(json.status, 2, `${label}: ${args.join(' ')} --json: ${json.stderr}`);
    assert.deepEqual(JSON.parse(json.stdout), { viewOnly: true, verb, runId: f.runId, shortId: f.token, dir: f.runDir, message: line }, `${label}: ${verb}`);
  }
  assert.deepEqual(snapshot(f.home, f.runId), before, `${label}: a refusal writes nothing`);
}

test('a v2 run refuses every driving verb with one line and exit 2, writes nothing, and still shows', async (t) => {
  for (const [label, marker, runId] of [
    ['stage-3 marker', undefined, 'wf-vwstg3-abcdef'], ['stage-2 marker', STAGE2, 'wf-vwstg2-abcdef'], ['no marker (0.35.6)', null, 'wf-vwnone-abcdef'],
  ]) {
    const f = await savedRun(t, { runId, marker });
    assert.equal(f.status, 'partial', label);
    assertRefusesDriving(f, label);
    const before = snapshot(f.home, f.runId);
    for (const args of [
      ['workflow', 'runs', 'show', f.token],
      ['workflow', 'runs', 'result', f.token, '--json'],
      ['workflow', 'runs', 'result', f.token, '--summary'],
      ['workflow', 'watch', f.token, '--once'],
      ['workflow', 'action', 'show', f.token, 'build'],
    ]) {
      const shown = cli(f.home, args);
      assert.equal(shown.status, 0, `${label}: ${args.join(' ')}: ${shown.stderr}`);
      assert.doesNotMatch(shown.stdout + shown.stderr, /was started by an earlier Bullswarm/, `${label}: ${args.join(' ')}`);
    }
    assert.equal(JSON.parse(cli(f.home, ['workflow', 'runs', 'result', f.token, '--json']).stdout).status, 'partial');
    // A finished view-only run: cancel says it is already finished.
    const cancel = cli(f.home, ['workflow', 'cancel', f.token, '--json']);
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).alreadyFinished, true);
    assert.deepEqual(snapshot(f.home, f.runId), before, `${label}: showing writes nothing`);
  }
});

test('a legacy run refuses every driving verb with the same sentence; cancel keeps its legacy line', (t) => {
  const f = legacyRun(t);
  assertRefusesDriving(f, 'legacy');
  const before = snapshot(f.home, f.runId);
  const legacyLine = legacyRunLine({ shortId: f.token, runId: f.runId, runDir: f.runDir });
  for (const args of [['workflow', 'cancel', f.token], ['workflow', 'tui', f.token, '--cancel']]) {
    const refused = cli(f.home, args);
    assert.deepEqual([refused.status, `${refused.stdout}${refused.stderr}`.trim()], [2, legacyLine], args.join(' '));
  }
  assert.deepEqual(snapshot(f.home, f.runId), before);
});

test('show, result, watch and tui print a legacy run\'s summary from its own files, exit 0, and write nothing', (t) => {
  const f = legacyRun(t);
  const before = snapshot(f.home, f.runId);
  const legacyLine = legacyRunLine({ shortId: f.token, runId: f.runId, runDir: f.runDir });
  const lines = [
    `# run  ${f.runId}  (${f.token})  legacy`,
    `# dir  ${f.runDir}`,
    '# goal  smoke-two-step',
    '# status  completed',
    '# started  2026-08-22T07:51:08.084Z',
    '# finished 2026-08-22T07:53:08.084Z',
    '# times from  state',
    '# minutes  2 span, active unknown · cost unknown',
    legacyLine,
  ].join('\n');
  for (const args of [
    ['workflow', 'runs', 'show', f.token],
    ['workflow', 'runs', 'result', f.token],
    ['workflow', 'watch', f.token],
    ['workflow', 'tui', f.token],
  ]) {
    const shown = cli(f.home, args);
    assert.deepEqual([shown.status, shown.stdout, shown.stderr], [0, `${lines}\n`, ''], args.join(' '));
  }
  const expected = {
    legacy: true, runId: f.runId, shortId: f.token, dir: f.runDir,
    project: null, goal: 'smoke-two-step', status: 'completed',
    startedAt: '2026-08-22T07:51:08.084Z', finishedAt: '2026-08-22T07:53:08.084Z', timeSource: 'state',
    minutes: { active: null, span: 2 }, cost: null, message: legacyLine,
  };
  for (const args of [
    ['workflow', 'runs', 'show', f.token, '--json'],
    ['workflow', 'runs', 'result', f.token, '--json'],
    ['workflow', 'runs', 'result', f.token, '--summary'],
    ['workflow', 'watch', f.token, '--jsonl'],
    ['workflow', 'tui', f.token, '--json'],
  ]) {
    const shown = cli(f.home, args);
    assert.equal(shown.status, 0, `${args.join(' ')}: ${shown.stderr}`);
    assert.deepEqual(JSON.parse(shown.stdout), expected, args.join(' '));
  }
  assert.deepEqual(snapshot(f.home, f.runId), before);
});

test('a legacy run with no state.json summarises from its file times and leaves unknowns unknown', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-view-only-orphan-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runDir = join(home, 'workflows', 'wf-orphan-000001');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'workflow.json'), JSON.stringify({ name: 'ancient' }));
  const shown = cli(home, ['workflow', 'watch', 'wf-orphan-000001', '--jsonl']);
  assert.equal(shown.status, 0, shown.stderr);
  const summary = JSON.parse(shown.stdout);
  assert.deepEqual([summary.legacy, summary.shortId, summary.status, summary.timeSource, summary.minutes, summary.cost],
    [true, null, null, 'directory', { active: null, span: null }, null]);
  assert.equal(summary.message, legacyRunLine({ shortId: null, runId: 'wf-orphan-000001', runDir }));
  const text = cli(home, ['workflow', 'runs', 'show', 'wf-orphan-000001']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^# status  unknown$/m);
  assert.match(text.stdout, /^# minutes  unknown, active unknown · cost unknown$/m);
});

test('workflow cancel still finalizes a v2 run its kernel left unfinished, and writes no marker', async (t) => {
  const f = await savedRun(t, { runId: 'wf-vwcanc-abcdef', marker: null, interrupted: true });
  assert.equal(f.status, 'interrupted');
  const refused = cli(f.home, ['workflow', 'resume', f.token]);
  assert.deepEqual([refused.status, refused.stderr], [2, `${message(f.token)}\n`]);
  const cancel = cli(f.home, ['workflow', 'cancel', f.token, '--json']);
  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.deepEqual([payload.finalized, payload.status], [true, 'cancelled']);
  assert.equal(JSON.parse(readFileSync(join(f.runDir, 'state.json'), 'utf8')).lifecycle.status, 'cancelled');
  assert.equal(JSON.parse(readFileSync(join(f.runDir, 'result.json'), 'utf8')).status, 'cancelled');
  assert.equal(existsSync(join(f.runDir, 'features.json')), false, 'no marker is written for it');
  const result = cli(f.home, ['workflow', 'runs', 'result', f.token, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'cancelled');
  assert.equal(cli(f.home, ['workflow', 'resume', f.token]).status, 2);
});

test('a v2 run an earlier kernel still drives: cancel asks it to stop and names cancel, never resume, as the way to finish', async (t) => {
  const f = await savedRun(t, { runId: 'wf-vwlive-abcdef', interrupted: true });
  const statePath = join(f.runDir, 'state.json');
  const setRunner = (pid) => {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.lifecycle.status = 'running';
    state.runner = { ...(state.runner ?? {}), pid, lastHeartbeatAt: new Date().toISOString() };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  // This test process stands in for the earlier version's live kernel.
  setRunner(process.pid);
  const asked = cli(f.home, ['workflow', 'cancel', f.token, '--json']);
  assert.equal(asked.status, 0, asked.stderr);
  const payload = JSON.parse(asked.stdout);
  assert.deepEqual([payload.finalized, payload.alreadyFinished], [false, false]);
  assert.deepEqual(payload.next, { watch: `bullswarm workflow watch ${f.token}`, cancel: `bullswarm workflow cancel ${f.token} --json` });
  assert.equal(payload.note, 'cooperative: the running kernel stops at its next safe checkpoint; if it stops first, run this cancel again to finalize the run');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lifecycle.status, 'running', 'a live kernel is left to stop itself');
  // Its kernel stops before it records the cancellation: the cancel the payload names finalizes the run.
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  setRunner(Number(gone.stdout));
  const again = cli(f.home, ['workflow', 'cancel', f.token]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `✓ workflow ${f.token} had no kernel running; cancelled and finalized (cancelled); result: bullswarm workflow runs result ${f.token} --json\n`);
  assert.equal(JSON.parse(readFileSync(join(f.runDir, 'result.json'), 'utf8')).status, 'cancelled');
});

test('a run marked programFormat 3 stays drivable', async (t) => {
  const f = await savedRun(t, { runId: 'wf-vwprg3-abcdef', program: v3Program() });
  assert.equal(f.status, 'completed');
  assert.equal(JSON.parse(readFileSync(join(f.runDir, 'features.json'), 'utf8')).programFormat, 3);
  // Resume on a completed run is a retry with nothing to retry: it says so.
  const resumed = cli(f.home, ['workflow', 'resume', f.token, '--json']);
  assert.equal(resumed.status, 1, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.equal(payload.status, 'nothing-to-retry');
  assert.deepEqual(payload.next, {
    result: `bullswarm workflow runs result ${f.token} --json --summary`,
    add: `bullswarm workflow add ${f.token} --steps part.json`, rerun: `bullswarm workflow step rerun ${f.token} <step>`,
  });
  for (const args of [
    ['workflow', 'pause', f.token],
    ['workflow', 'steer', f.token, 'also do x'],
    ['workflow', 'step', 'restart', f.token, 'side'],
  ]) {
    const run = cli(f.home, args);
    assert.doesNotMatch(run.stdout + run.stderr, /was started by an earlier Bullswarm/, args.join(' '));
    assert.notEqual(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
  }
  // Pause reads a v3 run's status: a finished one is already terminal.
  const pause = cli(f.home, ['workflow', 'pause', f.token]);
  assert.equal(pause.status, 1, pause.stderr);
  assert.match(pause.stderr, /already terminal/);
});

test('resume of a v3 run whose step failed its check has nothing a retry fixes and names the step', async (t) => {
  const program = { schemaVersion: 'bullswarm.workflow.program.v3', steps: [{ id: 'build', prompt: 'Write build.txt.' }, { id: 'side', prompt: 'Write side.txt.' }] };
  const f = await savedRun(t, { runId: 'wf-vwprgp-abcdef', program });
  assert.equal(f.status, 'partial');
  const before = snapshot(f.home, f.runId);
  const resumed = cli(f.home, ['workflow', 'resume', f.token, '--json']);
  assert.equal(resumed.status, 1, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.equal(payload.status, 'nothing-to-retry');
  assert.deepEqual(payload.needsCaller.map((entry) => [entry.id, entry.failureKind]), [['build', 'failed-evidence']]);
  const text = cli(f.home, ['workflow', 'resume', f.token]);
  assert.equal(text.status, 1, text.stdout);
  assert.match(text.stderr, new RegExp(`^✗ nothing to retry in ${f.token} \\(partial\\)`));
  assert.match(text.stderr, /^ {2}build {2}failed \(failed-evidence\)$/m);
  assert.deepEqual(snapshot(f.home, f.runId), before, 'nothing was relaunched');
});
