// Wave E of 0.37.0: the words a caller reads about a v3 run. A completed v3
// run hands nothing back; printed commands carry the run's folder and the
// program file the caller named; refusals on a v3 run never point to plan
// revise (refused on v3 runs); `plan contract` describes v3; a build step
// outside a git repository is checked for a change; the help text describes
// the four blocks. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { implicitV3Requirements, normaliseProgramV3 } from '../src/workflow/program-v3.js';
import { formatV2HandbackLines, formatV2ProofLabel, formatV2ProofLine, summarizeV2Result } from '../src/workflow/v2-outcome.js';
import { readEvents } from '../src/workflow/events.js';
import { rerunV2Step, restartV2Step } from '../src/workflow/cli-step-verbs.js';
import { changeStepHint } from '../src/workflow/step-change-hint.js';
import { helpText } from '../src/help.js';

const cli = resolve('bin/bullswarm.js');
const REPO = resolve('.');
const V3 = 'bullswarm.workflow.program.v3';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-words-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goal = 'Check the acme notes';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch with a fake worker; `script(actionId)` returns {answer?, fail?}.
function fakeDispatch(script = () => ({})) {
  const core = { config: { depthLimit: 2 }, pools: {}, decisionLog: [] };
  return (options) => dispatchV2Action({
    ...options,
    pools: [connector('acme-pool'), connector('initech-pool')],
    dependencies: {
      watchOnce: async (_pool, task, _targetDir, files, opts) => {
        const plan = script(options.action.id) ?? {};
        writeFileSync(files.taskFile, task);
        const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
        if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
        writeFileSync(files.outFile, `done ${options.action.id}`);
        if (plan.fail) return { ok: false, why: 'the acme worker crashed', failureKind: plan.fail, meta: { exitCode: 1, wallSec: 1 } };
        const checked = opts.outputValidator ? opts.outputValidator('') : { ok: true };
        const structured = { ok: checked.ok, errors: checked.errors ?? [], ...(checked.value !== undefined ? { value: checked.value } : {}) };
        return checked.ok
          ? { ok: true, why: 'structured output validated', structured, meta: { exitCode: 0, wallSec: 1 } }
          : { ok: false, why: `structured output invalid: ${structured.errors.join('; ')}`, failureKind: 'schema', structured, meta: { exitCode: 0, wallSec: 1 } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => Date.now(),
      uuid: () => 'session-fixed',
    },
  });
}

const launch = (f, program, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
  initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Wave E.', program },
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
});

const cliEnv = (home) => {
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  return env;
};
const run = (home, args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cliEnv(home), ...options });

const countAnswer = { type: 'object', required: ['lines', 'short'], properties: { lines: { type: 'integer' }, short: { type: 'boolean' } } };
const oneStep = () => ({ schemaVersion: V3, steps: [{ id: 'count', prompt: 'Count the acme lines.', answer: countAnswer }] });

// --- a completed v3 run hands nothing back ------------------------------------

test('a completed v3 run hands nothing back: no handback in the result, no "your call:" in runs result or watch', async (t) => {
  const f = fixture(t);
  const done = await launch(f, oneStep(), fakeDispatch(() => ({ answer: { lines: 3, short: true } })));
  assert.equal(done.result.status, 'completed');
  assert.equal(Object.hasOwn(done.result, 'handback'), false, JSON.stringify(done.result.handback));
  assert.deepEqual(formatV2HandbackLines(summarizeV2Result(done.result, done.state)), []);
  const result = run(f.bullswarmDir, ['workflow', 'runs', 'result', done.shortId]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /your call:/);
  const watch = run(f.bullswarmDir, ['workflow', 'watch', done.shortId, '--until', 'outcome']);
  assert.match(watch.stdout, /^outcome: completed/m);
  assert.doesNotMatch(watch.stdout, /your call:/);
});

test('a partial v3 run still hands back its options, and its restart line names the run\'s folder', async (t) => {
  const f = fixture(t);
  const partial = await launch(f, oneStep(), fakeDispatch(() => ({ fail: 'provider' })));
  assert.equal(partial.result.status, 'partial');
  const summary = summarizeV2Result(partial.result, partial.state);
  assert.equal(summary.handback.options.restart, `start a new run: bullswarm workflow goal "<goal>" --cwd ${f.workspace} --program <file.json>`);
  assert.ok(formatV2HandbackLines(summary).includes('your call:'));
});

test('a v3 step whose answer passed its schema reads answer checked and is not counted as proven', async (t) => {
  const f = fixture(t);
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'count', prompt: 'Count the acme lines.', answer: countAnswer },
      { id: 'test', prompt: 'Test the acme notes.', answer: countAnswer, evidence: [{ type: 'command', cmd: 'true' }] },
      { id: 'note', prompt: 'Note the acme lines.' },
    ],
  };
  const done = await launch(f, program, fakeDispatch(() => ({ answer: { lines: 3, short: true } })));
  assert.equal(done.result.status, 'completed', done.result.reason);
  const proofOf = (id) => readEvents(done.runDir).find((event) => event.type === 'action.finished' && event.payload.actionId === id).payload.proof;
  // A checked answer is a well-formed claim, not proof (P2): only evidence
  // Bullswarm runs itself proves a step.
  assert.deepEqual(proofOf('count').by, ['answer']);
  assert.equal(formatV2ProofLabel(proofOf('count')), 'answer checked');
  assert.equal(formatV2ProofLabel(proofOf('test')), 'proven by command · answer checked');
  assert.equal(formatV2ProofLabel(proofOf('note')), 'unproven');
  const summary = summarizeV2Result(done.result, done.state);
  assert.equal(summary.proof.proven, 1);
  assert.equal(summary.proof.byType.answer, undefined);
  assert.equal(summary.proof.answerChecked, 1);
  assert.deepEqual(summary.proof.answerCheckedSteps, ['count']);
  assert.equal(formatV2ProofLine(summary), 'proof: 1 step proven (command 1) · 1 answer checked: count · 1 finished · unproven: note');
  const watch = run(f.bullswarmDir, ['workflow', 'watch', done.shortId, '--until', 'outcome']);
  assert.match(watch.stdout, /^proof: 1 step proven \(command 1\) · 1 answer checked: count · 1 finished · unproven: note$/m);
});

// --- refusals on a v3 run never point to plan revise --------------------------

test('changeStepHint: a v2 run changes a step with plan export and revise, a v3 run adds a step', () => {
  const v2 = { program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [] } };
  const v3 = { program: { schemaVersion: V3, actions: [], control: { gates: [], loops: [] } } };
  assert.equal(changeStepHint(v2, 'ab12cd'), 'bullswarm workflow plan export ab12cd --out plan.json, edit it, then bullswarm workflow plan revise ab12cd --program plan.json');
  assert.equal(changeStepHint(v3, 'ab12cd'), 'bullswarm workflow add ab12cd --steps part.json with a new step that does it the way you want (a v3 run\'s steps are never edited)');
});

test('step restart and step rerun refusals on a v3 run point to step rerun and workflow add, never to plan revise', async (t) => {
  const f = fixture(t);
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'count', prompt: 'Count the acme lines.', answer: countAnswer, route: { pools: { use: ['acme-pool'] } } },
      { id: 'note', dependsOn: ['approve'], prompt: 'Note the count.' },
    ],
    gates: [{ id: 'approve', dependsOn: ['count'], note: 'Decide' }],
  };
  const parked = await launch(f, program, fakeDispatch(() => ({ answer: { lines: 3, short: true } })));
  const state = JSON.parse(readFileSync(join(parked.runDir, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle.status, 'waiting');

  const restart = await restartV2Step({ bullswarmDir: f.bullswarmDir, token: parked.shortId, stepId: 'count', waitMs: 0 });
  assert.equal(restart.status, 'error');
  assert.match(restart.why, new RegExp(`step count is not running \\(succeeded\\); restart stops a running attempt\\. To run it again: bullswarm workflow step rerun ${parked.shortId} count`));
  assert.doesNotMatch(restart.why, /plan revise|plan export/);

  const rerun = await rerunV2Step({
    bullswarmDir: f.bullswarmDir, token: parked.shortId, stepId: 'count', avoid: ['acme-pool'],
    pools: [connector('acme-pool'), connector('initech-pool')], waitMs: 0,
  });
  assert.equal(rerun.status, 'error');
  assert.match(rerun.why, /step count may only use acme-pool \(route\.pools\.use\); avoiding it leaves nothing\./);
  assert.ok(rerun.why.includes(`bullswarm workflow add ${parked.shortId} --steps part.json`), rerun.why);
  assert.doesNotMatch(rerun.why, /plan revise|plan export/);

  const paused = run(f.bullswarmDir, ['workflow', 'pause', parked.shortId]);
  assert.doesNotMatch(paused.stdout + paused.stderr, /plan revise/);
});

// --- plan contract describes v3; plan validate names the program file --------

const V2_WORDS = /\brole\b|role=|\bkind\b|kind=|\bact steps?\b|\bactions?\b|evidenceFor|check step/;

test('plan contract prints the v3 contract; --v2 was removed in 0.38.0', (t) => {
  const f = fixture(t);
  const out = run(f.bullswarmDir, ['workflow', 'plan', 'contract', 'Audit the acme notes', '--cwd', f.workspace, '--json']);
  assert.equal(out.status, 0, out.stderr);
  const contract = JSON.parse(out.stdout);
  assert.equal(contract.action, 'plan-contract');
  assert.equal(contract.schemaVersion, 'bullswarm.workflow.contract.v3');
  assert.equal(contract.program.schemaVersion, V3);
  for (const field of ['id', 'prompt', 'dependsOn', 'phase', 'label', 'lane', 'effort', 'reasoning', 'route', 'answer', 'evidence', 'deliverable', 'files', 'retry', 'timeBox']) {
    assert.equal(typeof contract.program.stepFields[field], 'string', `step field ${field}`);
  }
  assert.deepEqual(Object.keys(contract.program.gateFields), ['id', 'dependsOn', 'when', 'note']);
  assert.deepEqual(Object.keys(contract.program.loopFields), ['id', 'steps', 'until', 'maxRounds']);
  assert.ok(contract.program.condition.forms.length === 2);
  assert.ok(contract.rules.length >= 5);
  // The example validates as a v3 program.
  assert.equal(normaliseProgramV3(contract.example).steps.length, contract.example.steps.length);
  assert.match(contract.next.validate, /^bullswarm workflow plan validate 'Audit the acme notes' --program plan\.json --cwd /);
  assert.match(contract.next.launch, /--program plan\.json --json$/);
  assert.equal(existsSync(join(f.bullswarmDir, 'workflows')), false, 'contract must not create a run');

  const old = run(f.bullswarmDir, ['workflow', 'plan', 'contract', 'Audit the acme notes', '--cwd', f.workspace, '--json', '--v2']);
  assert.equal(old.status, 2, old.stderr);
  assert.equal(JSON.parse(old.stdout).message, '--v2 was removed in 0.38.0: bullswarm workflow plan contract prints the v3 format; bullswarm.workflow.program.v2 is no longer accepted for a new run');
});

// QA37 (0.37.0): SKILL.md tells callers to run `plan contract` bare, which
// exited 2 with a usage line. The v3 contract needs no goal.
test('plan contract with no goal prints the v3 contract with goal null and placeholder next commands; --v2 is removed', (t) => {
  const f = fixture(t);
  const out = run(f.bullswarmDir, ['workflow', 'plan', 'contract', '--cwd', f.workspace]);
  assert.equal(out.status, 0, out.stderr);
  const contract = JSON.parse(out.stdout);
  assert.equal(contract.schemaVersion, 'bullswarm.workflow.contract.v3');
  assert.equal(contract.goal, null);
  assert.equal(normaliseProgramV3(contract.example).steps.length, contract.example.steps.length);
  assert.match(contract.next.validate, /^bullswarm workflow plan validate '<goal>' --program plan\.json --cwd /);
  assert.equal(existsSync(join(f.bullswarmDir, 'workflows')), false, 'contract must not create a run');
  const old = run(f.bullswarmDir, ['workflow', 'plan', 'contract', '--cwd', f.workspace, '--v2']);
  assert.equal(old.status, 2);
  assert.match(old.stderr, /^✗ --v2 was removed in 0\.38\.0: /m);
});

test('plan validate prints a launch line with the program file the caller named', (t) => {
  const f = fixture(t);
  const file = join(f.root, 'my-plan.json');
  writeFileSync(file, JSON.stringify(oneStep()));
  const out = run(f.bullswarmDir, ['workflow', 'plan', 'validate', 'Count the acme lines', '--cwd', f.workspace, '--program', file, '--json']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).next.launch, `bullswarm workflow goal 'Count the acme lines' --cwd ${f.workspace} --program ${file} --json`);
  // A relative path is printed absolute, so the line works from any folder.
  const relative = run(f.bullswarmDir, ['workflow', 'plan', 'validate', 'Count the acme lines', '--cwd', f.workspace, '--program', 'my-plan.json'], { cwd: f.root });
  assert.equal(relative.status, 0, relative.stderr);
  assert.ok(relative.stdout.includes(`--program ${join(realpathSync(f.root), 'my-plan.json')} --json`), relative.stdout);
});

test('a v3 step with files and an outward deliverable or lane analyze is refused in step words, blamed once', () => {
  const issuesOf = (step) => {
    try { normaliseProgramV3({ schemaVersion: V3, steps: [{ id: 'post', prompt: 'Post the acme notes.', ...step }] }); }
    catch (error) { return error.issues; }
    assert.fail('the program was accepted');
  };
  const outward = issuesOf({ deliverable: 'outward', files: ['NOTES.md'] });
  assert.deepEqual(outward, ['steps[0] an outward step must have empty files; it does not write workspace files']);
  const analyze = issuesOf({ lane: 'analyze', files: ['NOTES.md'] });
  assert.deepEqual(analyze, ['steps[0] analyze steps must have empty files; use lane build or chore for a step that writes files']);
  for (const issue of [...outward, ...analyze]) assert.doesNotMatch(issue, V2_WORDS, issue);
});

test('plan validate on a v3 program speaks of steps: no v2 role or kind words, in the lines, the JSON, the advisories or the issues', (t) => {
  const f = fixture(t);
  const file = join(f.root, 'plan.json');
  const validate = (program, json = false) => {
    writeFileSync(file, JSON.stringify(program));
    return run(f.bullswarmDir, ['workflow', 'plan', 'validate', 'Ship the acme notes', '--cwd', f.workspace, '--program', file, ...(json ? ['--json'] : [])]);
  };
  const valid = {
    schemaVersion: V3,
    steps: [
      { id: 'notes', prompt: 'Write the acme notes.', lane: 'build', effort: 'high', files: ['NOTES.md'] },
      { id: 'index', prompt: 'Write the acme index.', lane: 'build', effort: 'high' },
      { id: 'links', prompt: 'Write the acme links.', lane: 'build', effort: 'high' },
      { id: 'post', dependsOn: ['notes'], prompt: 'Post the acme notes.', deliverable: 'outward' },
    ],
  };
  const human = validate(valid);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /post {20} analyze\/medium deliverable=outward after notes/);
  assert.match(human.stdout, /advisory: all-writers-high — all 3 build\/chore steps run at high effort/);
  assert.doesNotMatch(human.stdout, V2_WORDS, human.stdout);
  const json = JSON.parse(validate(valid, true).stdout);
  for (const step of json.program.actions) {
    assert.equal(Object.hasOwn(step, 'role'), false, `${step.id} has no role`);
    assert.equal(Object.hasOwn(step, 'kind'), false, `${step.id} has no kind`);
  }
  assert.doesNotMatch(json.advisories.map((item) => item.message).join('\n'), V2_WORDS);

  const refused = validate({
    schemaVersion: V3,
    steps: [
      { id: 'post', prompt: 'Post the acme notes.', lane: 'build', deliverable: 'outward' },
      { id: 'tidy', prompt: 'Tidy the acme notes.', lane: 'chore', effort: 'high' },
      { id: 'look', prompt: 'Look at the acme notes.', evidence: [{ type: 'review' }] },
      { id: 'send', prompt: 'Send the acme notes.', deliverable: 'outward', files: ['OUT.md'] },
    ],
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /steps\[0\] a outward deliverable is for analyze steps; build and chore steps deliver files, data or media/);
  assert.match(refused.stderr, /steps\[1\] chore steps are deterministic mechanical work and must use low effort/);
  assert.match(refused.stderr, /steps\[3\] an outward step must have empty files; it does not write workspace files/);
  assert.doesNotMatch(refused.stderr, /steps\[3\] analyze/);
  assert.match(refused.stderr, /steps\[2\]\.evidence\[0\]\.type must be command or schema; a check is an ordinary step with an answer and\/or evidence/);
  assert.doesNotMatch(refused.stderr, V2_WORDS, refused.stderr);
});

// --- a build step outside a git repository is checked for a change -----------

function echoHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const file of ['connector.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file === 'connector.json' ? 'echo.json' : file), readFileSync(join(REPO, 'src', 'providers', 'echo', file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return home;
}

test('run --lane build outside a git repository fails not-produced when it changed nothing, and passes when it wrote a file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-nogit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = echoHome(root);
  const folder = join(root, 'notes');
  mkdirSync(folder);
  writeFileSync(join(folder, 'README.md'), 'acme\n');
  const env = { ...cliEnv(home), BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const none = spawnSync(process.execPath, [cli, 'run', '--lane', 'build', '--json', '--no-retry', '--add-dir', folder, '--prompt', 'Change nothing'], { cwd: folder, env, encoding: 'utf8' });
  assert.equal(none.status, 1, none.stdout + none.stderr);
  const failed = JSON.parse(none.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.failureKind, 'not-produced', failed.why);
  const wrote = spawnSync(process.execPath, [cli, 'run', '--lane', 'build', '--json', '--no-retry', '--add-dir', folder, '--prompt', 'Add the notes TOUCH:notes.md'], { cwd: folder, env, encoding: 'utf8' });
  assert.equal(wrote.status, 0, wrote.stdout + wrote.stderr);
  assert.equal(JSON.parse(wrote.stdout).ok, true);
  assert.ok(existsSync(join(folder, 'notes.md')));
});

// --- help describes the four blocks -------------------------------------------

test('help: the top level, run, workflow and workflow goal describe v3 and the four blocks, and no run "never waits"', () => {
  const pages = { top: helpText([]), run: helpText(['run']), workflow: helpText(['workflow']), goal: helpText(['workflow', 'goal']) };
  for (const [name, text] of Object.entries(pages)) {
    assert.doesNotMatch(text, /never waits/, `${name}: never waits`);
  }
  for (const name of ['top', 'workflow', 'goal']) {
    for (const word of ['steps', 'phases', 'gates', 'loops']) assert.ok(pages[name].includes(word), `${name}: ${word}`);
  }
  assert.match(pages.run, /one-step workflow/);
  assert.match(pages.goal, /bullswarm\.workflow\.program\.v3/);
  assert.match(pages.goal, /workflow continue/);
  assert.match(pages.workflow, /workflow add/);
  assert.match(pages.workflow, /workflow wait/);
  assert.doesNotMatch(pages.workflow, /single V2 action\/evidence engine/);
});

test('walkFolderFiles lists a folder\'s files, skips .git and node_modules, and gives up on a folder too large to list', async (t) => {
  const { walkFolderFiles } = await import('../src/workflow/folder-walk.js');
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'README.md'), 'acme\n');
  writeFileSync(join(root, 'docs', 'notes.md'), 'initech\n');
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'x');
  writeFileSync(join(root, '.git', 'HEAD'), 'x');
  assert.deepEqual(walkFolderFiles(root), ['README.md', 'docs/notes.md']);
  assert.equal(walkFolderFiles(root, { maxFiles: 1 }), null);
  assert.equal(walkFolderFiles(root, { maxBytes: 5 }), null);
  assert.equal(walkFolderFiles(join(root, 'missing')), null);
});

test('run --timeout: the worker is killed, the failure kind is interrupted, and the one retry runs unless --no-retry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = echoHome(root);
  const folder = join(root, 'notes');
  mkdirSync(folder);
  const env = { ...cliEnv(home), BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const verdictOf = (extra) => JSON.parse(spawnSync(process.execPath, [cli, 'run', '--lane', 'analyze', '--json', '--timeout', '1', ...extra, '--add-dir', folder, '--prompt', 'SLEEP_MS:8000 slow'], { cwd: folder, env, encoding: 'utf8', timeout: 60_000 }).stdout);
  const retried = verdictOf([]);
  assert.deepEqual([retried.ok, retried.why, retried.failureKind, retried.attempts, retried.meta.timedOut], [false, 'timeout after 1s', 'interrupted', 2, true]);
  const once = verdictOf(['--no-retry']);
  assert.deepEqual([once.failureKind, once.attempts], ['interrupted', 1]);
  const help = helpText(['run']);
  assert.ok(help.includes('the verdict reads `timeout after <N>s` with failure kind interrupted'), help);
});
