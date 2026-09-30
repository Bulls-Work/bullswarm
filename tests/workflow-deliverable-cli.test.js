// The CLI's on-disk deliverable path checks. The validator cannot see the
// workspace, so `plan validate` and launch (`workflow goal --program`) refuse
// a deliverable path that names an existing directory (it could never be
// produced), and, in an isolated run, a git-ignored deliverable path
// (isolation copies back only files git would track).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2DurableState, createV2GoalDocument } from '../src/workflow/v2-state.js';
import { readPlannerCandidate, v2PlannerContractRules, validateV2PlannerResponse } from '../src/workflow/v2-planner.js';
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

// 0.38.0 launches v3 programs only; the path checks are the same for both.
const summary = (paths, files = []) => ({
  id: 'summary', lane: 'build', deliverable: { type: 'data', paths }, files,
  prompt: 'Write the summary data file and report its content.',
});
const programOf = (...steps) => ({ schemaVersion: 'bullswarm.workflow.program.v3', steps });
// The kernel still validates a stored v2 program the same way.
const v2Summary = (paths, ownedFiles = []) => ({
  id: 'summary', purpose: 'Write the summary data file', role: 'produce',
  deliverable: { type: 'data', paths }, dependsOn: [], affects: ['requirement-1'], ownedFiles, evidenceFor: [],
  prompt: 'Write the summary data file and report its content.',
});
const v2ProgramOf = (...actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });

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
  // line shows the deliverable with its paths.
  const good = f.write('file.json', programOf(summary(['reports/summary.json'])));
  const valid = f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', good);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /summary\s+build\/medium deliverable=data:reports\/summary\.json$/m);
  const json = JSON.parse(f.cli('workflow', 'plan', 'validate', GOAL, '--cwd', f.workspace, '--program', good, '--json').stdout);
  assert.deepEqual(json.program.actions[0], {
    id: 'summary', deliverable: { type: 'data', paths: ['reports/summary.json'] },
    lane: 'build', effort: 'medium', dependsOn: [], affects: ['goal'], evidenceFor: [], ownedFiles: [], retry: 1, files: [],
  });
});

test('plan validate exposes evidence types and refuses existing invalid schema paths', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'schemas'), { recursive: true });
  writeFileSync(join(f.workspace, 'schemas', 'event.json'), JSON.stringify({ type: 'object', properties: { date: { type: 'string' } } }));
  const withEvidence = (schema = 'schemas/event.json') => programOf({
    ...summary(['reports/out.json']),
    evidence: [{ type: 'command', cmd: 'node --test tests/summary.test.js' }, { type: 'schema', file: 'out/summary.json', schema }],
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
test('validate and launch print each schema problem with its own precise reason', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'schemas'), { recursive: true });
  const schemaAt = 'schemas/event.json';
  const plan = f.write('precise.json', programOf({
    ...summary(['reports/out.json']),
    evidence: [{ type: 'schema', file: 'reports/out.json', schema: schemaAt }],
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

  // Launch prints the same precise reason.
  writeFileSync(join(f.workspace, schemaAt), JSON.stringify({ properties: { x: { type: 'str' } } }));
  const badType = [precise('type at #/properties/x must name object, array, string, number, integer, boolean or null')];
  assert.deepEqual(issuesOf(f.cli('workflow', 'goal', GOAL, '--cwd', f.workspace, '--program', plan, '--json')), badType);
  assert.deepEqual(runsIn(f.home), [], 'a refused launch starts no run');
});

// An isolated copy holds only files git would track, so a git-ignored schema
// (or data file) is not there: the check could only fail after the worker ran.
test('an isolated run refuses a git-ignored evidence schema or file path; a shared run accepts it', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'out'), { recursive: true });
  writeFileSync(join(f.workspace, 'out', 's.json'), JSON.stringify({ type: 'object' }));
  const withSchema = (item) => programOf({
    id: 'survey', evidence: [item], prompt: 'List the data files and do not modify anything.',
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
});

test('foreground launch prints the proof line for a step with passing command evidence', (t) => {
  const f = fixture(t);
  const program = programOf({
    id: 'summary', effort: 'low',
    evidence: [{ type: 'command', cmd: 'node -e "process.exit(0)"' }],
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

test('the dispatched planner response and candidate get the same on-disk path checks', async (t) => {
  const f = fixture(t);
  const stateFor = (workspaceMode, executionMode = 'program') => createV2DurableState(createV2GoalDocument({
    goal: GOAL, cwd: f.workspace, requirements: [{ id: 'requirement-1', text: 'Write the summary data file.' }],
    settings: { executionMode, workspaceMode, scout: false, plannerMode: 'dispatched' },
  }), { runId: 'wf-dsppln-abcdef', shortId: 'dsppln' });
  const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the summary file.', program });
  const isolated = stateFor('isolated');
  const ignored = response(v2ProgramOf(v2Summary(['out/summary.json'], ['out/summary.json'])));
  const directory = response(v2ProgramOf(v2Summary(['reports'])));

  assert.throws(() => validateV2PlannerResponse(ignored, isolated, { boundary: 'initial' }), (error) => error.issues.includes(IGNORED));
  const candidate = f.write('candidate.json', ignored);
  assert.deepEqual(readPlannerCandidate(candidate, isolated, { boundary: 'initial' }), { ok: false, errors: [IGNORED] });

  // A shared run accepts the ignored path; a tracked exact file passes anywhere.
  const shared = stateFor('shared');
  assert.equal(validateV2PlannerResponse(ignored, shared, { boundary: 'initial' }).kind, 'program');
  assert.throws(() => validateV2PlannerResponse(directory, shared, { boundary: 'initial' }), (error) => error.issues.includes(DIRECTORY));
  // A verified-mode run never takes a deliverable, so it is not checked here.
  assert.throws(() => validateV2PlannerResponse(directory, stateFor('shared', 'verified'), { boundary: 'initial' }), (error) => !error.issues.includes(DIRECTORY));
  const tracked = response(v2ProgramOf(v2Summary(['reports/summary.json'], ['reports/summary.json'])));
  assert.equal(readPlannerCandidate(f.write('tracked.json', tracked), isolated, { boundary: 'initial' }).ok, true);
  // The isolated program-mode rules tell the planner before it writes one.
  const rules = v2PlannerContractRules({ executionMode: 'program', workspaceMode: 'isolated' }).join('\n');
  assert.match(rules, /Deliverable paths must be files git would track: a git-ignored path is refused/);
  assert.doesNotMatch(v2PlannerContractRules({ executionMode: 'program', workspaceMode: 'shared' }).join('\n'), /git-ignored path is refused/);
});
