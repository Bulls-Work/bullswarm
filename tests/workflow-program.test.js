import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { acceptCallerPlannerResponse, runV2AutonomousWorkflow, submitCallerPlannerResponse } from '../src/workflow/v2-runtime.js';
import { deserializeV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import { readEvents } from '../src/workflow/events.js';
import { requestCancel } from '../src/workflow/dashboard.js';
import { v2RunnerLiveness } from '../src/workflow/short-id.js';
import { captureWorkspaceStatus } from '../src/workflow/workspace-report.js';
import { queueSteering } from '../src/workflow/steering.js';
import { validateV2PlannerResponse } from '../src/workflow/v2-planner.js';

const cli = resolve('bin/bullswarm.js');
const action = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Implement ${id} and run its focused checks.`, lane: 'build', effort: 'low',
  evidenceFor: [], inputs: [], produces: [], ...options,
});
const program = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Execute the graph and return its results.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

function fixture(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-program-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2, ...settings },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

function dispatcher(handler) {
  return async (options) => {
    const files = options.paths(1);
    const record = {
      ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    const response = await handler(options, files);
    writeFileSync(files.outFile, 'Implemented the requested slice and checked its observable output.');
    const result = { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile }, ...response };
    Object.assign(record, { status: result.ok ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), failureKind: result.failureKind ?? null });
    options.onAttempt?.('finished', record);
    return { attempts: [record], ...result };
  };
}

function run(f, actions, handler, dependencies = {}) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [],
    initialPlannerResponse: program(actions),
    dependencies: {
      dispatchV2Action: dispatcher(handler),
      captureWorkspaceManifest: () => { throw new Error('shared program must never scan a manifest'); },
      createIsolatedWorkspace: () => { throw new Error('shared program must never copy a workspace'); },
      ...dependencies,
    },
  });
}

test('new CLI planning contracts use shared program execution and isolation is explicit', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bullswarmDir, 'state.json'), JSON.stringify({ version: 1, config: { worktreeIsolation: 'required' } }));
  const contract = (...flags) => JSON.parse(execFileSync(process.execPath, [cli, 'workflow', 'plan', 'contract', 'Create a report', '--json', ...flags], { encoding: 'utf8', env: { ...process.env, BULLSWARM_HOME: f.bullswarmDir } }));
  const shared = contract();
  assert.equal(shared.settings.executionMode, 'program');
  assert.equal(shared.settings.workspaceMode, 'shared');
  assert.equal(contract('--isolation').settings.workspaceMode, 'isolated');
  assert.match(contract('--isolation').launch.command, /--isolation/);
  assert.match(shared.rules.join('\n'), /integrator/i);
  assert.doesNotMatch(shared.program.validation.join('\n'), /mandatory needs at least one evidence/);
});

test('shared program preserves all edits, accepts new files, and completes without evidence or a planner round', async (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.workspace]);
  writeFileSync(join(f.workspace, 'existing.txt'), 'pre-existing user work');
  const result = await run(f, [action('write')], async (options) => {
    assert.equal(options.targetDir, f.workspace);
    assert.match(options.taskText, /territor/i);
    assert.doesNotMatch(options.taskText, /absolute mutation boundary|own exactly these files/);
    writeFileSync(join(options.targetDir, 'write.txt'), 'done');
    writeFileSync(join(options.targetDir, 'new-test.txt'), 'new useful regression');
  });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.verified, false);
  assert.equal(result.state.planner.turns, 1);
  assert.equal(result.state.planner.awaiting, null);
  assert.equal(readFileSync(join(f.workspace, 'new-test.txt'), 'utf8'), 'new useful regression');
  assert.equal(readFileSync(join(f.workspace, 'existing.txt'), 'utf8'), 'pre-existing user work');
  assert.deepEqual(result.result.workspace.changedFiles, ['existing.txt', 'new-test.txt', 'write.txt']);
  assert.deepEqual(result.result.workspace.baselineChangedFiles, ['existing.txt']);
  assert.ok(result.result.workspace.warnings.some((message) => message.includes('new-test.txt')));
  assert.deepEqual(deserializeV2ResultEnvelope(readFileSync(join(result.runDir, 'result.json'), 'utf8')), result.result);
});

test('ready dependents start before a slower sibling finishes in the same shared tree', { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  let finishSlow;
  const slow = new Promise((resolve) => { finishSlow = resolve; });
  const order = [];
  const result = await run(f, [action('fast'), action('slow'), action('next', { dependsOn: ['fast'] })], async ({ action: current, targetDir }) => {
    assert.equal(targetDir, f.workspace);
    order.push(`start-${current.id}`);
    await Promise.resolve();
    if (current.id === 'slow') await slow;
    if (current.id === 'next') finishSlow();
    order.push(`end-${current.id}`);
  });
  assert.equal(result.result.status, 'completed');
  assert.ok(order.indexOf('start-slow') < order.indexOf('end-fast'));
  assert.ok(order.indexOf('start-next') < order.indexOf('end-slow'));
});

test('overlapping territories serialize automatically and an unrestricted integrator runs alone', async (t) => {
  const f = fixture(t);
  const order = [];
  let active = 0;
  const result = await run(f, [
    action('first', { ownedFiles: ['shared.txt'] }),
    action('second', { ownedFiles: ['shared.txt'] }),
    action('integrate', { dependsOn: ['first', 'second'], ownedFiles: [] }),
  ], async (options) => {
    assert.equal(active++, 0);
    order.push(options.action.id);
    await Promise.resolve();
    if (options.action.id === 'integrate') assert.match(options.taskText, /any file/i);
    active--;
  });
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(order, ['first', 'second', 'integrate']);
});

test('a thrown worker error is an action failure; siblings finish, dependents skip, and written files survive', async (t) => {
  const f = fixture(t);
  const ran = [];
  const result = await run(f, [action('bad'), action('good'), action('dependent', { dependsOn: ['bad'] })], async ({ action: current }) => {
    ran.push(current.id);
    writeFileSync(join(f.workspace, `${current.id}.txt`), 'retained');
    if (current.id === 'bad') throw new Error('fixture process failed');
  });
  assert.equal(result.result.status, 'partial');
  assert.equal(result.state.planner.turns, 1);
  assert.deepEqual(ran.sort(), ['bad', 'good']);
  assert.deepEqual(result.result.actions.map((entry) => entry.status), ['failed', 'succeeded', 'blocked']);
  assert.match(result.result.actions[0].failure.message, /fixture process failed/);
  assert.equal(readFileSync(join(f.workspace, 'bad.txt'), 'utf8'), 'retained');
  assert.equal(result.state.attempts[0].status, 'failed');
  assert.equal(readEvents(result.runDir).at(-1).type, 'workflow.finished');
});

test('negative evidence is reported without an automatic gap round or a verified claim', async (t) => {
  const f = fixture(t);
  const result = await run(f, [action('write'), action('inspect', {
    dependsOn: ['write'], affects: [], ownedFiles: [], evidenceFor: ['deliver'], lane: 'analyze',
  })], async (options) => {
    if (options.action.id !== 'inspect') return;
    const candidate = options.taskText.match(/exact durable path: '([^']+)'/)[1];
    writeFileSync(candidate, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.evidence.v2',
      requirements: { deliver: { status: 'failed', evidence: ['The gate found an unfinished item.'], concerns: ['Needs another edit.'] } },
    }));
    return { verdict: { ok: true, structured: options.outputValidator('') } };
  });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.verified, false);
  assert.equal(result.result.requirements[0].status, 'failed');
  assert.equal(result.result.gaps.requirements[0].status, 'failed');
  assert.equal(result.state.planner.turns, 1);
  assert.equal(result.state.planner.awaiting, null);
});

test('resuming a completed program returns its durable result without rerunning workers', async (t) => {
  const f = fixture(t);
  const first = await run(f, [action('write')], async () => {});
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: first.runId, pools: [],
    dependencies: { dispatchV2Action: () => { throw new Error('must not dispatch'); } },
  });
  assert.deepEqual(resumed.result, first.result);
  assert.ok(existsSync(first.result.actions[0].outputFile));
});

test('quiet workers keep a live heartbeat and duplicate in-process resume is refused', async (t) => {
  const f = fixture(t);
  let tick;
  let cleared = false;
  let at = Date.now();
  const result = await run(f, [action('quiet')], async (_options, files) => {
    const runDir = dirname(files.outFile);
    const runId = basename(runDir);
    const original = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    at += 180_000;
    tick();
    const current = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.notEqual(current.runner.lastHeartbeatAt, original.runner.lastHeartbeatAt);
    assert.equal(v2RunnerLiveness(current, { now: at, processAlive: () => true }).alive, true);
    await assert.rejects(runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [] }), /already has an active kernel/);
  }, {
    now: () => new Date(at).toISOString(),
    setInterval: (callback) => { tick = callback; return { unref() {} }; },
    clearInterval: () => { cleared = true; },
  });
  assert.equal(result.result.status, 'completed');
  assert.equal(cleared, true);
});

test('cancellation drains active workers, retains their files, and cancels queued actions', async (t) => {
  const f = fixture(t);
  const finishes = [];
  let endFirst;
  const first = new Promise((resolve) => { endFirst = resolve; });
  const result = await run(f, [action('first'), action('second'), action('queued', { dependsOn: ['first'] })], async (options, files) => {
    const id = options.action.id;
    writeFileSync(join(f.workspace, `${id}.txt`), 'preserved');
    if (id === 'first') await first;
    else {
      requestCancel(f.bullswarmDir, basename(dirname(files.outFile)));
      endFirst();
    }
    assert.equal(options.shouldCancel(), true);
    finishes.push(id);
    return { ok: false, status: 'cancelled', failureKind: 'cancelled', verdict: { ok: false, why: 'operator cancelled' } };
  });
  assert.equal(result.result.status, 'cancelled');
  assert.deepEqual(finishes.sort(), ['first', 'second']);
  assert.deepEqual(result.result.actions.map((entry) => entry.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(existsSync(join(f.workspace, 'queued.txt')), false);
  assert.equal(readFileSync(join(f.workspace, 'first.txt'), 'utf8'), 'preserved');
  assert.equal(readEvents(result.runDir).at(-1).type, 'workflow.finished');
});

test('recovery skips successful actions and retries only the interrupted action in the original shared tree', async (t) => {
  const f = fixture(t);
  const runId = 'wf-recovery-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  let state = createV2State(f.goalDocument, { runId, shortId: 'rec123' });
  state = acceptCallerPlannerResponse(state, program([action('done'), action('interrupted', { dependsOn: ['done'] })]), { boundary: 'initial', runDir }).state;
  const outFile = join(runDir, 'done.md');
  writeFileSync(outFile, 'Durable first result');
  Object.assign(state.actions[0], { status: 'succeeded', outputFile: outFile });
  Object.assign(state.actions[1], { status: 'running', startedAt: new Date().toISOString() });
  state.lifecycle.status = 'running';
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goalDocument));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  const seen = [];
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: dispatcher(async ({ action: current, targetDir, taskText }) => {
      seen.push(current.id);
      assert.equal(targetDir, f.workspace);
      assert.ok(taskText.includes(outFile));
    }) },
  });
  assert.deepEqual(seen, ['interrupted']);
  assert.equal(resumed.result.status, 'completed');
  assert.equal(resumed.result.actions[0].outputFile, outFile);
  assert.equal(resumed.state.planner.turns, 1);
});

test('workspace inventory handles literal bracket, whitespace and newline paths and cannot fail execution', async (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.workspace]);
  const paths = ['[slug].txt', 'a b.txt', 'line\nbreak.txt'];
  for (const path of paths) writeFileSync(join(f.workspace, path), 'data');
  assert.deepEqual(captureWorkspaceStatus(f.workspace).changedFiles, paths.sort());
  const nested = join(f.workspace, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'local.txt'), 'data');
  assert.deepEqual(captureWorkspaceStatus(nested).changedFiles, ['local.txt']);
  const result = await run(f, [action('write')], async () => {}, {
    captureWorkspaceStatus: () => { throw new Error('git inventory unavailable'); },
  });
  assert.equal(result.result.status, 'completed');
  assert.ok(result.result.workspace.warnings.length);
});

test('a failed optional scout does not stop an already authored program', async (t) => {
  const f = fixture(t, { scout: true });
  const seen = [];
  const result = await run(f, [action('write')], async (options) => {
    seen.push(options.action.id);
    if (options.action.id === 'preflight-scout') return { ok: false, status: 'failed', failureKind: 'provider', verdict: { ok: false, why: 'scout unavailable' } };
  });
  assert.deepEqual(seen, ['preflight-scout', 'write']);
  assert.equal(result.state.preflight.scout.status, 'failed');
  assert.equal(result.result.status, 'completed');
});

test('explicit isolation keeps strict ownership and reports rejection as a partial program', async (t) => {
  const f = fixture(t, { workspaceMode: 'isolated' });
  writeFileSync(join(f.workspace, 'untouched.txt'), 'user data');
  const result = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], initialPlannerResponse: program([action('write')]),
    dependencies: { dispatchV2Action: dispatcher(async ({ targetDir, taskText }) => {
      assert.notEqual(targetDir, f.workspace);
      assert.match(taskText, /own exactly these files/);
      writeFileSync(join(targetDir, 'write.txt'), 'owned');
      writeFileSync(join(targetDir, 'outside.txt'), 'undeclared');
    }) },
  });
  assert.equal(result.result.status, 'partial');
  assert.equal(result.result.actions[0].failure.kind, 'ownership');
  assert.equal(result.state.planner.turns, 1);
  assert.equal(existsSync(join(f.workspace, 'outside.txt')), false);
  assert.equal(readFileSync(join(f.workspace, 'untouched.txt'), 'utf8'), 'user data');
});

test('explicit isolation refuses an unrestricted writer before it can touch the shared tree', (t) => {
  const f = fixture(t, { workspaceMode: 'isolated' });
  const state = createV2State(f.goalDocument, { runId: 'wf-isolation-abcdef', shortId: 'iso123' });
  assert.throws(() => validateV2PlannerResponse(program([action('integrate', { ownedFiles: [] })]), state), (error) => error.issues.some((issue) => /isolated writers must declare non-empty ownedFiles/.test(issue)));
});

test('real CLI runs A1/A2/A3 → integrator B1 → C1/C2 through routed local worker processes', { timeout: 20_000 }, (t) => {
  const f = fixture(t);
  const tracePath = join(f.root, 'trace.jsonl');
  const workerPath = join(f.root, 'worker.mjs');
  writeFileSync(workerPath, `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const task = readFileSync(process.argv[2], 'utf8');
const id = task.match(/Bullswarm program action: (\\S+)/)?.[1];
if (!id) throw new Error('unexpected planner or scout dispatch');
const trace = ${JSON.stringify(tracePath)};
const record = (event) => appendFileSync(trace, JSON.stringify({id, event, cwd: process.cwd(), depth: process.env.BULLSWARM_DEPTH}) + '\\n');
record('start');
if (id.startsWith('a')) {
  // A real barrier in the fixture proves these are simultaneous child
  // processes, not a scheduler mock that merely reported concurrency.
  const deadline = Date.now() + 3000;
  while (readFileSync(trace, 'utf8').trim().split('\\n').map(JSON.parse).filter((e) => e.event === 'start' && e.id.startsWith('a')).length < 3) {
    if (Date.now() > deadline) throw new Error('writers did not run concurrently');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(id + '.txt', 'ready');
  writeFileSync(id + '.test.txt', 'new regression file retained');
} else if (id === 'b1') {
  for (const name of ['a1', 'a2', 'a3']) if (readFileSync(name + '.txt', 'utf8') !== 'ready') throw new Error('missing writer output');
  writeFileSync('integrated.txt', 'a1,a2,a3');
} else if (!existsSync('integrated.txt') || readFileSync('integrated.txt', 'utf8') !== 'a1,a2,a3') {
  throw new Error('integrated acceptance failed');
}
record('finish');
process.stdout.write('Completed ' + id + ': delivered the requested files or inspection, read the concrete dependency files, and verified that their content matches the required acceptance values.');
`);
  mkdirSync(join(f.bullswarmDir, 'connectors'));
  writeFileSync(join(f.bullswarmDir, 'connectors', 'program-agent.json'), JSON.stringify({
    name: 'program-agent', bin: 'node', configDirs: [],
    spawn: { cmd: ['node', workerPath, '{taskFile}'], cwdMode: 'add-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
    costRank: 1, lanes: ['analyze', 'build', 'chore'], capabilities: ['code-reading', 'file-editing'],
    knownModels: ['fixture-model'], modelSelection: { flag: '--model', mode: 'replace-or-append' },
  }));
  writeFileSync(join(f.bullswarmDir, 'state.json'), JSON.stringify({
    version: 1, pools: { 'program-agent': { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, worktreeIsolation: 'required' },
  }));
  const actions = [
    ...['a1', 'a2', 'a3'].map((id) => action(id, { affects: ['requirement-1'] })),
    action('b1', { dependsOn: ['a1', 'a2', 'a3'], affects: ['requirement-1'], ownedFiles: [] }),
    ...['c1', 'c2'].map((id) => action(id, { dependsOn: ['b1'], lane: 'analyze', affects: [], ownedFiles: [] })),
  ];
  const programPath = join(f.root, 'program.json');
  writeFileSync(programPath, JSON.stringify(program(actions).program));
  const executed = spawnSync(process.execPath, [cli, 'workflow', 'goal', 'Create three files, integrate them, then inspect the output.', '--cwd', f.workspace, '--program', programPath, '--concurrency', '3', '--foreground', '--json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, false);
  assert.equal(result.actions.length, 6);
  assert.ok(result.actions.every((entry) => entry.status === 'succeeded' && existsSync(entry.outputFile)));
  for (const id of ['a1', 'a2', 'a3']) assert.equal(readFileSync(join(f.workspace, `${id}.test.txt`), 'utf8'), 'new regression file retained');
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse);
  let active = 0, peak = 0;
  const finished = new Set();
  for (const event of trace) {
    assert.equal(event.depth, '1');
    if (event.event === 'start') {
      if (event.id === 'b1') { assert.equal(active, 0); assert.ok(['a1', 'a2', 'a3'].every((id) => finished.has(id))); }
      if (event.id.startsWith('c')) assert.ok(finished.has('b1'));
      peak = Math.max(peak, ++active);
    } else { active--; finished.add(event.id); }
  }
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(new Set(trace.map((event) => event.cwd)).size, 1);
  assert.equal(existsSync(join(f.bullswarmDir, 'workflows', result.runId, 'workspaces')), false);
  const state = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', result.runId, 'state.json'), 'utf8'));
  assert.equal(state.planner.attempts.length, 0);
  assert.equal(state.attempts.length, 6);
});

test('steering waits for active siblings before pausing and resumes without losing their results', async (t) => {
  const f = fixture(t);
  const paused = await run(f, [action('fast'), action('slow')], async (options, files) => {
    const runDir = dirname(files.outFile);
    if (options.action.id === 'fast') queueSteering(f.bullswarmDir, basename(runDir), 'Add the integration output after both workers.');
    else {
      await new Promise((resolve) => setImmediate(resolve));
      const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
      assert.equal(state.actions[0].status, 'succeeded');
      assert.equal(state.planner.awaiting, null, 'planner must not replace state while a sibling still runs');
    }
  });
  assert.equal(paused.result, null);
  assert.equal(paused.awaiting.boundary, 'steering');
  assert.deepEqual(paused.state.actions.map((entry) => entry.status), ['succeeded', 'succeeded']);
  const submitted = submitCallerPlannerResponse({
    bullswarmDir: f.bullswarmDir, runId: paused.runId,
    response: program([action('integrate', { dependsOn: ['fast', 'slow'], ownedFiles: [] })]),
  });
  assert.equal(submitted.ok, true);
  const seen = [];
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: paused.runId, pools: [],
    dependencies: { dispatchV2Action: dispatcher(async ({ action: current }) => { seen.push(current.id); }) },
  });
  assert.deepEqual(seen, ['integrate']);
  assert.equal(resumed.result.status, 'completed');
  assert.equal(resumed.state.steering.length, 1);
  assert.equal(resumed.state.planner.turns, 2);
});

test('resume recovers an already published program result after interrupted final state persistence', async (t) => {
  const f = fixture(t);
  let runId;
  await assert.rejects(run(f, [action('write')], async () => {}, {
    writeResultAtomic: (path, result) => {
      runId = result.runId;
      writeFileSync(path, JSON.stringify(result));
      throw new Error('interruption after result publication');
    },
  }), /interruption after result publication/);
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: () => { throw new Error('must not replay a published result'); } },
  });
  assert.equal(resumed.result.status, 'completed');
  assert.equal(resumed.result.verified, false);
  assert.equal(resumed.state.lifecycle.status, 'completed');
  assert.equal(resumed.state.planner.status, 'completed');
  assert.equal(resumed.state.attempts.length, 1);
});
