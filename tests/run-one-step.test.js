// `bullswarm run` is a one-step v3 workflow (0.37.0, design section 6): the
// flags become a one-step program, the kernel routes and runs it in the
// foreground with no scout and no planner, the run is recorded under
// workflows/<id>/, and the verdict JSON keeps its old keys plus runId,
// shortId, answer and answerCheck. Keep-on-caller and incumbency are gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStepGoal, runStepProgram, runStepRequest } from '../src/lib/run-step.js';
import { normaliseProgramV3 } from '../src/workflow/program-v3.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function fixture(t, { state = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bs-run-step-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(repo);
  for (const file of ['connector.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file === 'connector.json' ? 'echo.json' : file), readFileSync(join(REPO, 'src', 'providers', 'echo', file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: { analyze: 'acme' }, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true }, ...state,
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, home, repo };
}

function bullswarm(f, args, env = {}) {
  const childEnv = { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', ...env };
  if (!('BULLSWARM_DEPTH' in env)) delete childEnv.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: f.repo, env: childEnv, encoding: 'utf8', timeout: 60_000 });
}

const readState = (f) => JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
const runState = (f, runId) => JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'), 'utf8'));
const stepAttempts = (f, runId) => runState(f, runId).attempts.filter((attempt) => attempt.actionId === 'task');

// --- the translation --------------------------------------------------------

test('run-step: the flags become a one-step v3 program the v3 validator accepts', () => {
  const parsed = runStepRequest({
    lane: 'build', effort: 'high', reasoning: 'low', prompt: 'Fix the acme parser', rest: [],
    'no-retry': true, 'avoid-pool': 'grok,codex', 'use-provider': 'acme', 'avoid-provider': 'initech',
  }, { cwd: '/tmp' });
  assert.equal(parsed.error, undefined);
  const program = runStepProgram(parsed.request);
  assert.deepEqual(program, {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{
      id: 'task', label: 'Fix the acme parser', prompt: 'Fix the acme parser',
      lane: 'build', effort: 'high', retry: 0,
      route: { pools: { avoid: ['grok', 'codex'] }, providers: { use: ['acme'], avoid: ['initech'] } },
    }],
  });
  assert.equal(normaliseProgramV3(program).steps.length, 1);
  // --reasoning is the run-wide level, on the goal's worker routing (source "run").
  assert.deepEqual(runStepGoal(parsed.request).config.workerRouting, { reasoning: 'low' });
});

test('run-step: the default retry is 1, the lane default effort applies, and an answer schema is the step answer', () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  const parsed = runStepRequest({ lane: 'analyze', rest: ['count', 'the', 'files'] }, { cwd: '/tmp', answerSchema: schema });
  const [step] = runStepProgram(parsed.request).steps;
  assert.equal(step.retry, 1);
  assert.equal(step.effort, 'medium');
  assert.deepEqual(step.answer, schema);
  assert.equal(step.route, undefined);
});

test('run-step: usage errors name the flag and never build a program', () => {
  const cases = [
    [{ rest: ['x'] }, /--lane is required/],
    [{ lane: 'deploy', rest: ['x'] }, /--lane must be analyze, build, chore/],
    [{ lane: 'build', effort: 'huge', rest: ['x'] }, /--effort must be high, medium, or low/],
    [{ lane: 'build', rest: [] }, /empty task/],
    [{ lane: 'build', prompt: 'x', rest: ['y'] }, /choose one/],
    [{ lane: 'build', heartbeat: '0', rest: ['x'] }, /heartbeat.*greater than or equal to 1/],
    [{ lane: 'build', 'avoid-pool': true, rest: ['x'] }, /--avoid-pool requires/],
    [{ lane: 'build', 'answer-schema': true, rest: ['x'] }, /--answer-schema requires a file/],
  ];
  for (const [opts, message] of cases) {
    const parsed = runStepRequest(opts, { cwd: '/tmp' });
    assert.equal(parsed.request, undefined, JSON.stringify(opts));
    assert.match(parsed.error, message);
  }
});

// --- the command ------------------------------------------------------------

test('run: the run is a one-step v3 workflow under workflows/<id>/ and the verdict keeps its keys plus runId and shortId', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--add-dir', f.repo, '--prompt', 'Summarise the acme readme']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true, verdict.why);
  assert.match(verdict.runId, /^wf-[a-z0-9]+-[a-f0-9]{6}$/);
  assert.match(verdict.shortId, /^[a-z0-9]{6}$/);
  assert.equal(verdict.pick.pool, 'echo');
  assert.equal(verdict.pick.model, 'echo-local');
  assert.ok(Array.isArray(verdict.pick.command));
  assert.ok(verdict.outFile.startsWith(join(f.home, 'workflows', verdict.runId)), verdict.outFile);
  assert.ok(existsSync(verdict.outFile));
  assert.equal(verdict.failureKind, null);
  assert.equal(verdict.retryAfter, null);
  assert.equal(verdict.answer, null);
  assert.equal(verdict.answerCheck, null);
  assert.equal(Object.hasOwn(verdict, 'keepOnClaude'), false, 'keepOnClaude is gone');
  // The recorded run: program v3, one step, no scout, no planner.
  const features = JSON.parse(readFileSync(join(f.home, 'workflows', verdict.runId, 'features.json'), 'utf8'));
  assert.equal(features.programFormat, 3);
  const state = runState(f, verdict.runId);
  assert.equal(state.program.schemaVersion, 'bullswarm.workflow.program.v3');
  assert.deepEqual(state.program.actions.map((action) => action.id), ['task']);
  assert.equal(state.preflight.scout.status, 'skipped');
  assert.equal(state.planner.attempts.length, 0);
  assert.equal(state.lifecycle.status, 'completed');
  assert.ok(existsSync(join(f.home, 'workflows', verdict.runId, 'result.json')));
  // One decision-log entry, the workflow attempt's; no separate task entry,
  // and incumbency is neither read nor written.
  const core = readState(f);
  assert.deepEqual(core.decisionLog.map((entry) => entry.source), ['workflow-v2']);
  assert.equal(core.decisionLog.some((entry) => entry.kind === 'run'), false);
  assert.deepEqual(core.incumbents, { analyze: 'acme' });
  // The run is listed with the workflows.
  const runs = bullswarm(f, ['workflow', 'runs', '--all', '--json']);
  assert.equal(runs.status, 0, runs.stderr);
  assert.ok(JSON.stringify(JSON.parse(runs.stdout)).includes(verdict.runId), runs.stdout);
});

test('run: a build step passes when it changed a file, and fails not-produced when it changed none', (t) => {
  const f = fixture(t);
  const wrote = JSON.parse(bullswarm(f, ['run', '--lane', 'build', '--json', '--add-dir', f.repo, '--prompt', 'Add the notes file TOUCH:notes.md']).stdout);
  assert.equal(wrote.ok, true, wrote.why);
  assert.ok(existsSync(join(f.repo, 'notes.md')));
  const none = bullswarm(f, ['run', '--lane', 'build', '--json', '--add-dir', f.repo, '--prompt', 'Change nothing']);
  assert.equal(none.status, 1);
  const verdict = JSON.parse(none.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureKind, 'not-produced', verdict.why);
});

test('run --answer-schema: a matching answer is in the verdict with its check', (t) => {
  const f = fixture(t);
  const schemaFile = join(f.root, 'count.schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--add-dir', f.repo, '--answer-schema', schemaFile, '--prompt', 'Count the files ANSWER_JSON:{"n":3}']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true, verdict.why);
  assert.deepEqual(verdict.answer, { n: 3 });
  assert.equal(verdict.answerCheck.ok, true);
  assert.deepEqual(verdict.answerCheck.errors, []);
  assert.match(verdict.answerCheck.file, /answer-task-attempt-1\.json$/);
});

test('run --answer-schema: a mismatch is failure kind schema, corrected once by default, never with --no-retry', (t) => {
  const f = fixture(t);
  const schemaFile = join(f.root, 'count.schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
  const args = ['run', '--lane', 'analyze', '--json', '--add-dir', f.repo, '--answer-schema', schemaFile, '--prompt', 'Count the files ANSWER_JSON:{"n":"three"}'];
  const retried = bullswarm(f, args);
  assert.equal(retried.status, 1);
  const verdict = JSON.parse(retried.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureKind, 'schema', verdict.why);
  assert.equal(verdict.answerCheck.ok, false);
  assert.deepEqual(verdict.answer, { n: 'three' }, 'what the worker wrote is kept beside the errors');
  assert.equal(stepAttempts(f, verdict.runId).length, 2, 'the step default retry: one correction');
  const once = JSON.parse(bullswarm(f, [...args, '--no-retry']).stdout);
  assert.equal(once.failureKind, 'schema');
  assert.equal(stepAttempts(f, once.runId).length, 1, '--no-retry gives one attempt');
});

test('run --answer-schema: an unreadable or invalid schema is a usage error before anything runs', (t) => {
  const f = fixture(t);
  const missing = bullswarm(f, ['run', '--lane', 'analyze', '--answer-schema', join(f.root, 'nope.json'), '--prompt', 'x']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read --answer-schema/);
  const bad = join(f.root, 'bad.json');
  writeFileSync(bad, '"yes"');
  const invalid = bullswarm(f, ['run', '--lane', 'analyze', '--answer-schema', bad, '--prompt', 'x']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /answer must be a JSON schema object/);
  assert.equal(existsSync(join(f.home, 'workflows')) && readdirSync(join(f.home, 'workflows')).some((name) => name.startsWith('wf-')), false);
});

test('run: a usage limit goes to the caller at once, never retried', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--add-dir', f.repo, '--prompt', 'FAIL:quota']);
  assert.equal(result.status, 1);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.failureKind, 'quota', verdict.why);
  assert.match(verdict.retryAfter, /^20\d\d-/);
  assert.equal(stepAttempts(f, verdict.runId).length, 1);
});

test('run --dry-run prints the kernel pick and writes nothing', (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.home, 'state.json'));
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--dry-run', '--json', '--add-dir', f.repo, '--prompt', 'hi']);
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dryRun, true);
  assert.equal(verdict.pick.pool, 'echo');
  assert.equal(verdict.pick.model, 'echo-local');
  assert.ok(Array.isArray(verdict.pick.command));
  assert.equal(Object.hasOwn(verdict, 'keepOnClaude'), false);
  assert.deepEqual(readFileSync(join(f.home, 'state.json')), before, 'a preview writes nothing');
  assert.equal(existsSync(join(f.home, 'workflows')) && readdirSync(join(f.home, 'workflows')).some((name) => name.startsWith('wf-')), false, 'no run is recorded');
  // The route filters are the kernel's: avoiding the only pool leaves none.
  const avoided = bullswarm(f, ['run', '--lane', 'analyze', '--dry-run', '--json', '--avoid-pool', 'echo', '--prompt', 'hi']);
  assert.equal(avoided.status, 1);
  const refused = JSON.parse(avoided.stdout);
  assert.equal(refused.ok, false);
  assert.equal(refused.pick, undefined);
  assert.match(refused.why, /avoid echo/);
});

test('run --no-caller is accepted with a one-line notice that it is ignored', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--no-caller', '--dry-run', '--json', '--prompt', 'hi']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), 'bullswarm run: --no-caller is ignored; the calling agent is never a pool of its own run (removed in 0.37.0)');
  assert.equal(JSON.parse(result.stdout).pick.pool, 'echo');
});

test('run at the depth limit is a plain refusal: ok false, failure kind depth', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--prompt', 'hi'], { BULLSWARM_DEPTH: '2' });
  assert.equal(result.status, 1);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureKind, 'depth');
  assert.match(verdict.why, /depth/);
  assert.equal(Object.hasOwn(verdict, 'keepOnClaude'), false);
});

test('run --timeout stops the worker and reports the timeout', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--no-retry', '--timeout', '1', '--add-dir', f.repo, '--prompt', 'SLEEP_MS:8000 slow']);
  assert.equal(result.status, 1);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.meta.timedOut, true, JSON.stringify(verdict));
});

test('run --heartbeat prints kernel progress on stderr and keeps stdout one JSON document', (t) => {
  const f = fixture(t);
  const result = bullswarm(f, ['run', '--lane', 'analyze', '--json', '--heartbeat', '1', '--add-dir', f.repo, '--prompt', 'SLEEP_MS:2500 slow']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.match(result.stderr, /^bullswarm run · active \d+s · \d+ events? · \d+ B · activity \d+s ago$/m);
});
