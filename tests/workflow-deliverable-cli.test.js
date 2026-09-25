// The CLI's on-disk deliverable path checks. The validator cannot see the
// workspace, so `plan validate`, launch (`workflow goal --program`) and
// `plan revise` refuse a deliverable path that names an existing directory
// (it could never be produced), and, in an isolated run, a git-ignored
// deliverable path (isolation copies back only files git would track).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2DurableState, createV2GoalDocument } from '../src/workflow/v2-state.js';
import { readPlannerCandidate, v2PlannerContractRules, validateV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { STEP_EVIDENCE_TYPES, USABLE_EVIDENCE_TYPES } from '../src/workflow/step-vocabulary.js';
import { EVIDENCE_ENV_KEYS } from '../src/workflow/evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from '../src/workflow/schema-check.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const GOAL = '1. Write the summary data file.';
const DIRECTORY = 'program.actions[0].deliverable.paths[0] names a directory ("reports"); list the exact files step summary leaves behind';
const SCHEMA_DIRECTORY = 'program.actions[0].evidence[1].schema names a directory ("reports")';
const SCHEMA_INVALID = 'program.actions[0].evidence[1].schema is not valid JSON ("schemas/event.json")';
const SCHEMA_UNSUPPORTED = 'program.actions[0].evidence[1].schema uses unsupported keyword "if" at # ("schemas/event.json"); see the schema subset in docs/reference/program.md';
const IGNORED = 'program.actions[0].deliverable.paths[0] is git-ignored ("out/summary.json"); an isolated run copies back only files git would track';

const summary = (paths, ownedFiles = []) => ({
  id: 'summary', purpose: 'Write the summary data file', role: 'produce',
  deliverable: { type: 'data', paths }, dependsOn: [], affects: ['requirement-1'], ownedFiles, evidenceFor: [],
  prompt: 'Write the summary data file and report its content.',
});
const programOf = (...actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-deliverable-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'acme');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(join(workspace, 'reports'), { recursive: true });
  const echoConnector = JSON.parse(readFileSync(new URL('../src/providers/echo/connector.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify(echoConnector));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } }));
  const git = (...args) => {
    const run = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q');
  writeFileSync(join(workspace, '.gitignore'), 'out/\n');
  writeFileSync(join(workspace, 'reports', 'keep.md'), '# Reports\n');
  git('add', '-A');
  git('-c', 'user.name=Example', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'init');
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0', BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd: workspace, timeout: 60_000 });
  const write = (name, document) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(document));
    return path;
  };
  return { root, home, workspace, cli, write };
}

const issuesOf = (run) => {
  assert.equal(run.status, 2, run.stdout || run.stderr);
  return JSON.parse(run.stdout).issues;
};
const runsIn = (home) => (existsSync(join(home, 'workflows')) ? readdirSync(join(home, 'workflows')) : []);

test('plan validate and launch refuse a deliverable path that names a directory', (t) => {
  const f = fixture(t);
  const bad = f.write('dir.json', programOf(summary(['reports'])));
  assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', bad, '--json')), [DIRECTORY]);
  assert.deepEqual(issuesOf(f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--program', bad, '--json')), [DIRECTORY]);
  assert.deepEqual(runsIn(f.home), [], 'a refused launch starts no run');

  // The human line names the path too.
  const text = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', bad);
  assert.equal(text.status, 2);
  assert.match(text.stdout + text.stderr, /names a directory \("reports"\)/);

  // Control: an exact file under that directory is accepted, and the validate
  // line shows the role and the deliverable with its paths.
  const good = f.write('file.json', programOf(summary(['reports/summary.json'])));
  const valid = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', good);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /summary\s+build\/medium role=produce deliverable=data:reports\/summary\.json affects requirement-1/);
  const json = JSON.parse(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', good, '--json').stdout);
  assert.deepEqual(json.program.actions[0], {
    id: 'summary', role: 'produce', deliverable: { type: 'data', paths: ['reports/summary.json'] },
    lane: 'build', effort: 'medium', dependsOn: [], affects: ['requirement-1'], evidenceFor: [], ownedFiles: [],
  });
});

test('plan validate exposes evidence types and refuses existing invalid schema paths', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'schemas'), { recursive: true });
  writeFileSync(join(f.workspace, 'schemas', 'event.json'), JSON.stringify({ type: 'object', properties: { date: { type: 'string' } } }));
  const withEvidence = (schema = 'schemas/event.json') => programOf({
    id: 'summary', purpose: 'Write the summary data file', role: 'produce',
    evidence: [{ type: 'command', cmd: 'node --test tests/summary.test.js' }, { type: 'schema', file: 'out/summary.json', schema }],
    deliverable: { type: 'data', paths: ['reports/out.json'] }, dependsOn: [], affects: ['requirement-1'], ownedFiles: [], evidenceFor: [],
    prompt: 'Write the summary data file and report its content.',
  });
  const plan = f.write('evidence.json', withEvidence());
  const text = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan);
  assert.equal(text.status, 0, text.stderr || text.stdout);
  assert.match(text.stdout, /evidence=command,schema/);
  const json = JSON.parse(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan, '--json').stdout);
  assert.deepEqual(json.program.actions[0].evidence, [
    { type: 'command', cmd: 'node --test tests/summary.test.js' },
    { type: 'schema', file: 'out/summary.json', schema: 'schemas/event.json' },
  ]);

  assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', f.write('schema-dir.json', withEvidence('reports')), '--json')), [SCHEMA_DIRECTORY]);
  writeFileSync(join(f.workspace, 'schemas', 'event.json'), '{');
  const invalidJson = issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan, '--json'));
  assert.match(invalidJson[0], /^program\.actions\[0\]\.evidence\[1\]\.schema is not valid JSON/);
  writeFileSync(join(f.workspace, 'schemas', 'event.json'), JSON.stringify({ if: { type: 'string' } }));
  assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan, '--json')), [SCHEMA_UNSUPPORTED]);
});

// Only a real keyword refusal reads "uses unsupported keyword"; any other
// problem keeps the checker's own precise reason, never a made-up keyword.
test('validate, launch and revise print each schema problem with its own precise reason', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'schemas'), { recursive: true });
  const schemaAt = 'schemas/event.json';
  const plan = f.write('precise.json', programOf({
    id: 'summary', purpose: 'Write the summary data file', role: 'produce',
    evidence: [{ type: 'schema', file: 'reports/out.json', schema: schemaAt }],
    deliverable: { type: 'data', paths: ['reports/out.json'] }, dependsOn: [], affects: ['requirement-1'], ownedFiles: [], evidenceFor: [],
    prompt: 'Write the summary data file and report its content.',
  }));
  const at = 'program.actions[0].evidence[0].schema';
  const precise = (message) => `${at} is not a supported schema ("${schemaAt}"): ${message}; see the schema subset in docs/reference/program.md`;
  let deep = { type: 'object' };
  for (let level = 0; level < 70; level += 1) deep = { not: deep };
  const cases = [
    [{ properties: { x: { $ref: 'http://example.com/s.json' } } }, [precise('$ref "http://example.com/s.json" is not local')]],
    [{ properties: { x: { type: 'str' } } }, [precise('type at #/properties/x must name object, array, string, number, integer, boolean or null')]],
    [{ $ref: '#/$defs/missing' }, [precise('$ref "#/$defs/missing" does not resolve at #')]],
    [[1, 2], [precise('schema at # must be an object or a boolean')]],
    [{ minLength: -1 }, [precise('minLength at # must be a non-negative integer')]],
    [{ required: 'id' }, [precise('required at # must be an array of strings')]],
    [{ if: { type: 'string' } }, [`${at} uses unsupported keyword "if" at # ("${schemaAt}"); see the schema subset in docs/reference/program.md`]],
  ];
  for (const [schema, expected] of cases) {
    writeFileSync(join(f.workspace, schemaAt), JSON.stringify(schema));
    assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan, '--json')), expected, JSON.stringify(schema));
  }
  writeFileSync(join(f.workspace, schemaAt), JSON.stringify(deep));
  const tooDeep = issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', plan, '--json'));
  assert.equal(tooDeep.length, 1);
  assert.match(tooDeep[0], /is not a supported schema \("schemas\/event\.json"\): /);
  assert.doesNotMatch(tooDeep.join('\n'), /unsupported keyword|\$depth|\$schema-value/);

  // Launch and revise print the same precise reason.
  writeFileSync(join(f.workspace, schemaAt), JSON.stringify({ properties: { x: { type: 'str' } } }));
  const badType = [precise('type at #/properties/x must name object, array, string, number, integer, boolean or null')];
  assert.deepEqual(issuesOf(f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--program', plan, '--json')), badType);
  assert.deepEqual(runsIn(f.home), [], 'a refused launch starts no run');
  const { done, document } = await finishedRun(f, 'wf-prcsch-abcdef', 'shared');
  const revised = structuredClone(document);
  revised.program.actions[0].evidence = [{ type: 'schema', file: '$output', schema: schemaAt }];
  const issues = reviseIssues(f, done.shortId, revised, 'rev-precise.json');
  assert.deepEqual(issues, badType);
});

// An isolated copy holds only files git would track, so a git-ignored schema
// (or data file) is not there: the check could only fail after the worker ran.
test('an isolated run refuses a git-ignored evidence schema or file path; a shared run accepts it', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'out'), { recursive: true });
  writeFileSync(join(f.workspace, 'out', 's.json'), JSON.stringify({ type: 'object' }));
  const withSchema = (item) => programOf({
    id: 'survey', purpose: 'Report the data files', role: 'investigate', evidence: [item],
    dependsOn: [], affects: ['requirement-1'], ownedFiles: [], evidenceFor: [],
    prompt: 'List the data files and do not modify anything.',
  });
  const ignoredSchema = f.write('ignored-schema.json', withSchema({ type: 'schema', file: '$output', schema: 'out/s.json' }));
  const ignoredFile = f.write('ignored-file.json', withSchema({ type: 'schema', file: 'out/data.json', schema: 'reports/keep.md' }));
  const SCHEMA_IGNORED = 'program.actions[0].evidence[0].schema is git-ignored ("out/s.json"); the isolated copy will not contain it, so the check could not run';
  const FILE_IGNORED = 'program.actions[0].evidence[0].file is git-ignored ("out/data.json"); the isolated copy will not contain it, and an isolated run copies back only files git would track';
  assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignoredSchema, '--json')), [SCHEMA_IGNORED]);
  assert.deepEqual(issuesOf(f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignoredSchema, '--json')), [SCHEMA_IGNORED]);
  assert.deepEqual(runsIn(f.home), [], 'a refused launch starts no run');
  const human = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignoredSchema);
  assert.equal(human.status, 2);
  assert.match(human.stdout + human.stderr, /the isolated copy will not contain it/);
  const fileIssues = issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignoredFile, '--json'));
  assert.equal(fileIssues[0], FILE_IGNORED);
  // A shared run works in the real tree, where the file exists.
  const shared = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', ignoredSchema, '--json');
  assert.equal(shared.status, 0, shared.stdout || shared.stderr);
  // Revise of an isolated run refuses it too, and leaves the run unchanged.
  const isolated = await finishedRun(f, 'wf-evdign-abcdef', 'isolated');
  const revised = structuredClone(isolated.document);
  revised.program.actions[0].evidence = [{ type: 'schema', file: '$output', schema: 'out/s.json' }];
  assert.deepEqual(reviseIssues(f, isolated.done.shortId, revised, 'rev-ignored-schema.json'), [SCHEMA_IGNORED]);
  const state = JSON.parse(readFileSync(join(f.home, 'workflows', isolated.done.runId, 'state.json'), 'utf8'));
  assert.equal(state.program.revision, 1, 'a refused revision leaves the run unchanged');
});

test('foreground launch prints the proof line for a step with passing command evidence', (t) => {
  const f = fixture(t);
  const program = programOf({
    id: 'summary', purpose: 'Write the summary data file', kind: 'io-read', effort: 'low',
    evidence: [{ type: 'command', cmd: 'node -e "process.exit(0)"' }],
    dependsOn: [], affects: ['requirement-1'], ownedFiles: [], evidenceFor: [],
    prompt: 'Return a short report.',
  });
  const programPath = f.write('foreground-evidence.json', program);
  const result = f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--program', programPath, '--foreground');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /proof: 1 steps? proven \(command 1\)/);
});

test('workflow capabilities exposes step evidence schema and environment details', (t) => {
  const f = fixture(t);
  const capabilities = f.cli('workflow', 'capabilities');
  assert.equal(capabilities.status, 0, capabilities.stderr || capabilities.stdout);
  const engine = JSON.parse(capabilities.stdout).engines.autonomousV2;
  assert.deepEqual(engine.evidenceTypes.usable, [...USABLE_EVIDENCE_TYPES]);
  assert.deepEqual(engine.stepEvidence.fieldTypes, [...STEP_EVIDENCE_TYPES]);
  assert.equal(engine.stepEvidence.maxItems, 5);
  assert.deepEqual(engine.stepEvidence.timeoutSec, { default: 120, max: 600 });
  assert.deepEqual(engine.stepEvidence.schemaKeywords, [...SCHEMA_ASSERTED_KEYWORDS]);
  assert.deepEqual(engine.stepEvidence.schemaIgnored, [...SCHEMA_IGNORED_KEYWORDS]);
  assert.deepEqual(engine.stepEvidence.schemaFormats, ['json', 'jsonl']);
  assert.equal(engine.stepEvidence.outputFile, '$output');
  assert.deepEqual(engine.stepEvidence.env, [...EVIDENCE_ENV_KEYS]);
  assert.equal(engine.stepEvidence.actRetry, false);
  assert.equal(typeof engine.stepEvidence.checker, 'string');
});

test('a kind-only validate payload and line carry no role or deliverable', (t) => {
  const f = fixture(t);
  const path = f.write('kind.json', programOf({
    id: 'readme', purpose: 'Append a line to README.md', kind: 'implement', dependsOn: [], affects: ['requirement-1'],
    ownedFiles: ['README.md'], evidenceFor: [], prompt: 'Append one line to README.md.',
  }));
  const text = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', path);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /readme\s+build\/medium kind=implement affects requirement-1/);
  assert.doesNotMatch(text.stdout, /role=|deliverable=/);
  const [action] = JSON.parse(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', path, '--json').stdout).program.actions;
  assert.equal('role' in action || 'deliverable' in action, false);
});

test('an isolated run refuses a git-ignored deliverable path; a shared run accepts it', (t) => {
  const f = fixture(t);
  const ignored = f.write('ignored.json', programOf(summary(['out/summary.json'], ['out/summary.json'])));
  assert.deepEqual(issuesOf(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignored, '--json')), [IGNORED]);
  assert.deepEqual(issuesOf(f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--isolation', '--program', ignored, '--json')), [IGNORED]);
  assert.deepEqual(runsIn(f.home), [], 'a refused launch starts no run');
  const shared = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', ignored, '--json');
  assert.equal(shared.status, 0, shared.stdout || shared.stderr);
  // A tracked path is fine in an isolated run.
  const tracked = f.write('tracked.json', programOf(summary(['reports/summary.json'], ['reports/summary.json'])));
  const isolated = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--isolation', '--program', tracked, '--json');
  assert.equal(isolated.status, 0, isolated.stdout || isolated.stderr);
});

// A finished program-mode run whose only step is read-only, so no worker or
// isolated worktree is needed; its plan is then revised through the CLI.
async function finishedRun(f, runId, workspaceMode) {
  const survey = {
    id: 'survey', purpose: 'Report the data files', role: 'investigate', dependsOn: [], affects: [], ownedFiles: [],
    evidenceFor: [], prompt: 'List the data files and do not modify anything.',
  };
  const dispatch = async (options) => {
    const files = options.paths(1);
    writeFileSync(files.taskFile, options.taskText);
    writeFileSync(files.outFile, 'surveyed');
    const record = { ordinal: 1, pool: 'fixture', model: 'fixture', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
    options.onAttempt?.('started', record);
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
  const done = await runV2AutonomousWorkflow({
    bullswarmDir: f.home, pools: [], runId,
    goalDocument: createV2GoalDocument({
      goal: GOAL, cwd: f.workspace, requirements: [{ id: 'requirement-1', text: 'Write the summary data file.' }],
      settings: { executionMode: 'program', workspaceMode, scout: false, plannerMode: 'caller', concurrency: 2 },
    }),
    initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Survey.', program: programOf(survey) },
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  assert.equal(done.result.status, 'completed');
  const exported = f.cli('workflow', 'plan', 'export', done.shortId, '--out', join(f.root, `${runId}.json`));
  assert.equal(exported.status, 0, exported.stderr);
  const document = JSON.parse(readFileSync(join(f.root, `${runId}.json`), 'utf8'));
  return { done, document };
}

const reviseIssues = (f, token, document, name) => {
  const run = f.cli('workflow', 'plan', 'revise', token, '--program', f.write(name, document), '--json');
  assert.equal(run.status, 2, run.stdout || run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, 'rejected');
  return payload.issues;
};

test('plan export and action show carry role and deliverable only for a step that stored them', async (t) => {
  const f = fixture(t);
  const { done } = await finishedRun(f, 'wf-dlvshw-abcdef', 'shared');
  const exported = JSON.parse(f.cli('workflow', 'plan', 'export', done.shortId, '--json').stdout);
  assert.equal(exported.actions[0].role, 'investigate');
  assert.equal('role' in exported.document.program.actions[0], true, 'the document is the stored action, verbatim');
  const shown = f.cli('workflow', 'action', 'show', done.shortId, 'survey', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  const record = JSON.parse(shown.stdout).actionRecord;
  assert.equal(record.role, 'investigate');
  assert.deepEqual(record.deliverable, { type: 'report' });
  assert.equal('kind' in record, false);
  assert.deepEqual([record.lane, record.effort], ['analyze', 'medium']);
});

test('plan revise refuses a directory deliverable path, and a git-ignored one in an isolated run', async (t) => {
  const f = fixture(t);
  const shared = await finishedRun(f, 'wf-dlvsha-abcdef', 'shared');
  const withDirectory = structuredClone(shared.document);
  withDirectory.program.actions.unshift(summary(['reports']));
  assert.deepEqual(reviseIssues(f, shared.done.shortId, withDirectory, 'rev-dir.json'), [DIRECTORY]);
  // A shared run accepts the ignored path at the precheck: the revision is
  // applied (the finished run reopens), so only the refusal cases are exact.
  const isolated = await finishedRun(f, 'wf-dlviso-abcdef', 'isolated');
  const withIgnored = structuredClone(isolated.document);
  withIgnored.program.actions.unshift(summary(['out/summary.json'], ['out/summary.json']));
  assert.deepEqual(reviseIssues(f, isolated.done.shortId, withIgnored, 'rev-ignored.json'), [IGNORED]);
  const state = JSON.parse(readFileSync(join(f.home, 'workflows', isolated.done.runId, 'state.json'), 'utf8'));
  assert.equal(state.program.revision, 1, 'a refused revision leaves the run unchanged');
  assert.equal(state.lifecycle.status, 'completed');
});

// `plan submit` recovers a run an older version left waiting for its caller
// planner: an empty program-mode run is finished, then held at its initial
// boundary the way that version would have left it.
async function awaitingRun(f, runId, workspaceMode) {
  const done = await runV2AutonomousWorkflow({
    bullswarmDir: f.home, pools: [], runId,
    goalDocument: createV2GoalDocument({
      goal: GOAL, cwd: f.workspace, requirements: [{ id: 'requirement-1', text: 'Write the summary data file.' }],
      settings: { executionMode: 'program', workspaceMode, scout: false, plannerMode: 'caller', concurrency: 2 },
    }),
    dependencies: { dispatchV2Action: async () => { throw new Error('no step may run'); }, controlPollMs: 10 },
  });
  const statePath = join(done.runDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const turn = state.planner.turns + 1;
  state.lifecycle = { ...state.lifecycle, status: 'waiting', finishedAt: null, resultFile: null };
  state.planner.status = 'waiting';
  state.planner.awaiting = {
    boundary: 'initial', turn, since: new Date().toISOString(),
    requestPath: join(done.runDir, `planner-request-turn-${turn}.json`),
    candidatePath: join(done.runDir, `candidate-workflow-planner-turn-${turn}.json`),
  };
  rmSync(join(done.runDir, 'result.json'), { force: true });
  writeFileSync(statePath, JSON.stringify(state));
  return done;
}

test('plan submit refuses a directory deliverable path, and a git-ignored one in an isolated run', async (t) => {
  const f = fixture(t);
  const submitIssues = (token, program, name) => {
    const run = f.cli('workflow', 'plan', 'submit', token, '--program', f.write(name, program), '--json');
    assert.equal(run.status, 2, run.stdout || run.stderr);
    assert.match(run.stderr, /rejected at the initial boundary \(run state unchanged\)/);
    return run.stderr;
  };
  const shared = await awaitingRun(f, 'wf-sbmsha-abcdef', 'shared');
  assert.ok(submitIssues(shared.shortId, programOf(summary(['reports'])), 'sub-dir.json').includes(DIRECTORY));
  const isolated = await awaitingRun(f, 'wf-sbmiso-abcdef', 'isolated');
  assert.ok(submitIssues(isolated.shortId, programOf(summary(['out/summary.json'], ['out/summary.json'])), 'sub-ignored.json').includes(IGNORED));
  const state = JSON.parse(readFileSync(join(f.home, 'workflows', isolated.runId, 'state.json'), 'utf8'));
  assert.equal(state.program.revision, 0, 'a refused submission leaves the run unchanged');
  assert.equal(state.planner.awaiting?.boundary, 'initial');
});

test('the dispatched planner response and candidate get the same on-disk path checks', async (t) => {
  const f = fixture(t);
  const stateFor = (workspaceMode, executionMode = 'program') => createV2DurableState(createV2GoalDocument({
    goal: GOAL, cwd: f.workspace, requirements: [{ id: 'requirement-1', text: 'Write the summary data file.' }],
    settings: { executionMode, workspaceMode, scout: false, plannerMode: 'dispatched' },
  }), { runId: 'wf-dsppln-abcdef', shortId: 'dsppln' });
  const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the summary file.', program });
  const isolated = stateFor('isolated');
  const ignored = response(programOf(summary(['out/summary.json'], ['out/summary.json'])));
  const directory = response(programOf(summary(['reports'])));

  assert.throws(() => validateV2PlannerResponse(ignored, isolated, { boundary: 'initial' }), (error) => error.issues.includes(IGNORED));
  const candidate = f.write('candidate.json', ignored);
  assert.deepEqual(readPlannerCandidate(candidate, isolated, { boundary: 'initial' }), { ok: false, errors: [IGNORED] });

  // A shared run accepts the ignored path; a tracked exact file passes anywhere.
  const shared = stateFor('shared');
  assert.equal(validateV2PlannerResponse(ignored, shared, { boundary: 'initial' }).kind, 'program');
  assert.throws(() => validateV2PlannerResponse(directory, shared, { boundary: 'initial' }), (error) => error.issues.includes(DIRECTORY));
  // A verified-mode run never takes a deliverable, so it is not checked here.
  assert.throws(() => validateV2PlannerResponse(directory, stateFor('shared', 'verified'), { boundary: 'initial' }), (error) => !error.issues.includes(DIRECTORY));
  const tracked = response(programOf(summary(['reports/summary.json'], ['reports/summary.json'])));
  assert.equal(readPlannerCandidate(f.write('tracked.json', tracked), isolated, { boundary: 'initial' }).ok, true);
  // The isolated program-mode rules tell the planner before it writes one.
  const rules = v2PlannerContractRules({ executionMode: 'program', workspaceMode: 'isolated' }).join('\n');
  assert.match(rules, /Deliverable paths must be files git would track: a git-ignored path is refused/);
  assert.doesNotMatch(v2PlannerContractRules({ executionMode: 'program', workspaceMode: 'shared' }).join('\n'), /git-ignored path is refused/);
});
