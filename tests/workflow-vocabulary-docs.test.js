import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_KINDS, KIND_DEFAULTS, validateActionProgram } from '../src/workflow/action-validator.js';
import { EVIDENCE_ENV_KEYS, EVIDENCE_MAX_TIMEOUT_SEC, runStepEvidence } from '../src/workflow/evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from '../src/workflow/schema-check.js';
import { FAILURE_CLASSES, KIND_ROLES, ROLES, ROLE_DEFAULT_DELIVERABLE, STEP_EVIDENCE_TYPES, evidenceResultsIssues, poolCausedFailure, roleRouting } from '../src/workflow/step-vocabulary.js';
import { formatV2HandbackLines, formatV2ProofLabel, formatV2ProofLine, stepProof, summarizeV2Result } from '../src/workflow/v2-outcome.js';
import { needsYouFacts, needsYouJson, renderNeedsYou } from '../src/workflow/needs-you.js';
import { notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { reopenV2RunForRetry, reviseV2Program, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { createRevisionRequest } from '../src/workflow/v2-revision.js';
import { THROTTLE_BACKOFF_MS, THROTTLE_MAX_WAIT_MS } from '../src/lib/quota.js';
import { STAGE3_RUN_FEATURES } from '../src/workflow/run-features.js';
import { deliverableVerdict, snapshotPossible } from '../src/workflow/v2-dispatch.js';
import * as dispatchModule from '../src/workflow/v2-dispatch.js';
import { v2PlannerContractRules } from '../src/workflow/v2-planner.js';
import { VERIFY_LOOP_STOPS } from '../src/workflow/verify-rounds.js';
import { helpText } from '../src/help.js';
import { extractGoalRequirements } from '../src/workflow/goal.js';

// Stage 1 docs drift check: the role, kind and difference tables in the docs
// must say what the code tables say, and the example programs must validate.

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const TABLE_DOCS = [
  'skill/references/program.md',
  'docs/reference/program.md',
  'skill/references/operations.md',
  'docs/guide/workflows.md',
];
const PROGRAM_REFERENCES = ['skill/references/program.md', 'docs/reference/program.md'];
const KIND_TABLE_DOCS = PROGRAM_REFERENCES;
const ALIAS_DOCS = [...TABLE_DOCS, 'skill/SKILL.md', 'docs/guide/concepts.md', 'docs/reference/result.md'];

const ROLE_HEADER = ['role', 'default deliverable', 'files', 'data or media', 'report', 'outward'];
const KIND_HEADER = ['kind', 'role', 'lane', 'effort', 'use for'];
const DIFFERENCE_HEADER = ['kind', 'role', 'kind: lane/effort', 'role alone: lane/effort (default deliverable)', 'kind gate', 'role gate'];

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replaceAll('`', ''));

function tables(text) {
  const found = [];
  let block = [];
  for (const line of [...text.split('\n'), '']) {
    if (line.trim().startsWith('|')) block.push(line);
    else if (block.length) {
      if (block.length >= 2) {
        found.push({
          header: cellsOf(block[0]).map((cell) => cell.toLowerCase()),
          rows: block.slice(2).map(cellsOf),
        });
      }
      block = [];
    }
  }
  return found;
}

function tablesWithHeader(path, header) {
  return tables(read(path)).filter((table) => JSON.stringify(table.header) === JSON.stringify(header));
}

const route = (routing) => (routing ? `${routing.lane}/${routing.effort}` : '—');

test('each doc carries one role table that matches ROLE_ROUTING and the default deliverables', () => {
  for (const path of TABLE_DOCS) {
    const found = tablesWithHeader(path, ROLE_HEADER);
    assert.equal(found.length, 1, `${path}: expected one role table`);
    const { rows } = found[0];
    assert.deepEqual(rows.map((row) => row[0]), [...ROLES], `${path}: role rows`);
    for (const [role, deliverable, files, dataOrMedia, report, outward] of rows) {
      const at = `${path} ${role}`;
      assert.equal(deliverable, ROLE_DEFAULT_DELIVERABLE[role] ?? '(required)', `${at}: default deliverable`);
      assert.equal(files, route(roleRouting(role, 'files')), `${at}: files`);
      assert.deepEqual(roleRouting(role, 'data'), roleRouting(role, 'media'), `${at}: data and media route alike`);
      assert.equal(dataOrMedia, route(roleRouting(role, 'data')), `${at}: data or media`);
      assert.equal(report, route(roleRouting(role, 'report')), `${at}: report`);
      assert.equal(outward, route(roleRouting(role, 'outward')), `${at}: outward`);
    }
  }
});

test('the kind tables match KIND_DEFAULTS and KIND_ROLES', () => {
  for (const path of KIND_TABLE_DOCS) {
    const found = tablesWithHeader(path, KIND_HEADER);
    assert.equal(found.length, 1, `${path}: expected one kind table`);
    const { rows } = found[0];
    assert.deepEqual(rows.map((row) => row[0]), [...ACTION_KINDS], `${path}: kind rows`);
    for (const [kind, role, lane, effort] of rows) {
      assert.equal(role, KIND_ROLES[kind], `${path} ${kind}: role`);
      assert.equal(lane, KIND_DEFAULTS[kind].lane, `${path} ${kind}: lane`);
      assert.equal(effort, KIND_DEFAULTS[kind].effort, `${path} ${kind}: effort`);
    }
  }
});

test('each doc carries one kind and role difference table that matches the code and the other docs', () => {
  const byDoc = new Map();
  for (const path of TABLE_DOCS) {
    const found = tablesWithHeader(path, DIFFERENCE_HEADER);
    assert.equal(found.length, 1, `${path}: expected one difference table`);
    const { rows } = found[0];
    assert.deepEqual(rows.map((row) => row[0]).sort(), [...ACTION_KINDS].sort(), `${path}: kind rows`);
    for (const [kind, role, kindRoute, roleAlone] of rows) {
      const at = `${path} ${kind}`;
      assert.equal(role, KIND_ROLES[kind], `${at}: role`);
      const { lane, effort } = KIND_DEFAULTS[kind];
      assert.ok(kindRoute === `${lane}/${effort}` || kindRoute.startsWith(`${lane}/${effort},`), `${at}: kind lane/effort is ${kindRoute}`);
      const defaultDeliverable = ROLE_DEFAULT_DELIVERABLE[role];
      if (defaultDeliverable) {
        assert.equal(roleAlone, `${route(roleRouting(role, defaultDeliverable))} (${defaultDeliverable})`, `${at}: role alone`);
      } else {
        assert.doesNotMatch(roleAlone, /(analyze|build|chore)\//, `${at}: a role with no default deliverable has no default route`);
      }
    }
    byDoc.set(path, rows.map((row) => row.join(' | ')).join('\n'));
  }
  const [first, ...rest] = [...byDoc.entries()];
  for (const [path, rows] of rest) assert.equal(rows, first[1], `${path} differs from ${first[0]}`);
});

test('no doc calls a kind an alias', () => {
  const kindWords = new RegExp(`\\bkinds?\\b|\\broles?\\b|${ACTION_KINDS.map((kind) => `\`${kind}\``).join('|')}`, 'i');
  for (const path of ALIAS_DOCS) {
    const sentences = read(path).replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/);
    const offenders = sentences.filter((sentence) => /\balias(es|ed)?\b/i.test(sentence) && kindWords.test(sentence));
    assert.deepEqual(offenders, [], `${path} calls a kind or role an alias`);
  }
});

function examplePrograms(path) {
  return [...read(path).matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((value) => value?.schemaVersion === 'bullswarm.workflow.program.v2');
}

test('the example programs in both program references validate in program mode', () => {
  for (const path of [...PROGRAM_REFERENCES, 'docs/guide/workflows.md']) {
    const programs = examplePrograms(path);
    assert.ok(programs.length >= 1, `${path}: no example program`);
    for (const program of programs) {
      const requirements = [...new Set(program.actions.flatMap((action) => [...action.affects, ...action.evidenceFor]))];
      const accepted = validateActionProgram(structuredClone(program), { relaxedGraph: true, requirements });
      assert.equal(accepted.actions.length, program.actions.length, path);
      // The example is written with roles: three produce steps, one combine
      // that merges files, and one check at high effort. The full ordered
      // list is pinned, so a moved, added or dropped step fails here.
      const actions = accepted.actions;
      assert.deepEqual(
        actions.map((action) => [action.id, action.role, action.deliverable?.type, action.lane, action.effort, action.dependsOn, action.affects, action.evidenceFor, action.route]),
        [
          ['since-flag', 'produce', 'files', 'build', 'medium', [], ['requirement-1'], [], undefined],
          ['readme', 'produce', 'files', 'build', 'medium', [], ['requirement-2'], [], undefined],
          ['records', 'produce', 'data', 'build', 'medium', [], ['requirement-3'], [], undefined],
          ['integrate', 'combine', 'files', 'build', 'high', ['since-flag', 'readme'], ['requirement-1', 'requirement-2'], [], undefined],
          ['verify', 'check', 'report', 'analyze', 'high', ['since-flag', 'readme', 'records', 'integrate'], [], ['requirement-1', 'requirement-2', 'requirement-3'], { independentOf: ['since-flag'] }],
        ],
        path,
      );
      assert.ok(program.actions.every((action) => action.kind === undefined), `${path}: the example uses roles, not kinds`);
      // One command item and one schema item, each on a step whose prompt
      // makes the file the check reads.
      assert.deepEqual(
        actions.filter((action) => action.evidence).map((action) => [action.id, action.evidence]),
        [
          ['since-flag', [{ type: 'command', cmd: 'node --test tests/runs-list.test.js' }]],
          ['records', [{ type: 'schema', file: 'out/records.json', schema: 'schemas/record.json' }]],
        ],
        `${path}: example evidence`,
      );
      const records = actions.find((action) => action.id === 'records');
      assert.deepEqual(records.deliverable, { type: 'data', paths: ['out/records.json'] }, `${path}: schema example data deliverable`);
      assert.match(records.prompt, /write out\/records\.json/, `${path}: the records prompt writes the file its check reads`);
      const goal = read(path).match(/Goal: `([^`]+)`/)[1];
      assert.equal(extractGoalRequirements(goal).length, 3, `${path}: the goal numbers every requirement the example uses`);
      for (const action of actions.filter((item) => item.evidence)) {
        assert.ok(action.evidence.every((item) => STEP_EVIDENCE_TYPES.includes(item.type)), `${path}: normalized evidence types`);
      }
    }
  }
});

// Review findings docs-privacy-0..5: each claim below is checked against the
// code first, then against the docs that state it.

const flat = (path) => read(path).replace(/\s+/g, ' ');
const program = (actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });
function validate(actions) {
  const check = { id: 'verify', purpose: 'v', prompt: 'inspect', role: 'check', dependsOn: actions.map((action) => action.id), affects: [], ownedFiles: [], evidenceFor: ['requirement-1'] };
  try {
    return validateActionProgram(program([...actions, check]), { relaxedGraph: true, requirements: ['requirement-1'] });
  } catch (error) {
    throw new Error((error.issues ?? [error.message]).join('; '));
  }
}
const step = { purpose: 'p', prompt: 'x', dependsOn: [], affects: ['requirement-1'], ownedFiles: [], evidenceFor: [] };

test('program references document evidence keywords and the public command environment', () => {
  const keywordTable = (path, heading) => {
    const text = read(path);
    const start = text.indexOf(heading);
    assert.notEqual(start, -1, `${path}: evidence section`);
    const end = text.indexOf('## ', start + heading.length);
    return text.slice(start, end < 0 ? undefined : end);
  };
  for (const path of PROGRAM_REFERENCES) {
    const section = keywordTable(path, '## Evidence: command and schema');
    for (const keyword of SCHEMA_ASSERTED_KEYWORDS) assert.ok(section.includes(`\`${keyword}\``), `${path}: asserted ${keyword}`);
    for (const keyword of SCHEMA_IGNORED_KEYWORDS) assert.ok(section.includes(`\`${keyword}\``), `${path}: ignored ${keyword}`);
    assert.deepEqual([...section.matchAll(/`(BULLSWARM_[A-Z_]+)(?:=1)?`/g)].map((match) => match[1]), EVIDENCE_ENV_KEYS, `${path}: public evidence env`);
    for (const type of STEP_EVIDENCE_TYPES) assert.ok(section.includes(`\`${type}\``), `${path}: evidence type ${type}`);
  }
});

test('the changelog and operations reference say what is new against 0.35.6', () => {
  // The code: a lane-only build step that changed nothing fails in a run started by this version.
  const buildStep = { ...step, lane: 'build', ownedFiles: ['a.js'] };
  assert.equal(deliverableVerdict({ action: buildStep, verdict: { ok: true }, snapshotOk: true }).failWhy, 'no file changed and no commit made');
  assert.equal(deliverableVerdict({ action: buildStep, verdict: { ok: true }, snapshotOk: true, legacyGate: false }).failWhy, null);
  const truth = [
    'A program written only with kinds or lanes validates exactly as before.',
    'One behavior is new in runs started by this version: a build-lane step other than `integration` that changes no file and makes no commit fails as `not-produced`; 0.35.6 recorded it as succeeded.',
    'Runs started before this version keep their original rules when resumed.',
  ];
  for (const path of ['CHANGELOG.md', 'skill/references/operations.md']) {
    const text = flat(path);
    for (const sentence of truth) assert.ok(text.includes(sentence), `${path}: ${sentence}`);
    assert.doesNotMatch(text, /keeps the lane rule|runs exactly as before|still works unchanged/, path);
  }
});

test('the changelog exempts only combine steps with a files deliverable and no paths', () => {
  const combine = { ...step, role: 'combine' };
  assert.equal(deliverableVerdict({ action: { ...combine, lane: 'analyze', deliverable: { type: 'report' } }, verdict: { ok: true }, outputBytes: 0, snapshotOk: true }).failWhy, 'report is empty');
  assert.equal(deliverableVerdict({ action: { ...combine, lane: 'build', deliverable: { type: 'files' } }, verdict: { ok: true }, snapshotOk: true }).failWhy, null);
  const text = flat('CHANGELOG.md');
  assert.ok(text.includes('`combine` steps with a `files` deliverable and no paths, are not judged'));
  assert.doesNotMatch(text, /`combine` steps without paths/);
});

test('changing a role in an exported plan needs the written-back deliverable deleted too', () => {
  const [exported] = validate([{ ...step, id: 'study', role: 'produce', ownedFiles: ['notes.md'] }]).actions;
  assert.deepEqual(exported.deliverable, { type: 'files' });
  const changed = { ...structuredClone(exported), role: 'investigate', ownedFiles: [] };
  delete changed.lane; delete changed.effort;
  // Deleting only lane and effort keeps the old files deliverable and its build routing.
  assert.equal(validate([structuredClone(changed)]).actions[0].lane, 'build');
  delete changed.deliverable;
  const [redone] = validate([changed]).actions;
  assert.deepEqual([redone.lane, redone.effort, redone.deliverable], ['analyze', 'medium', { type: 'report' }]);
  const advice = [
    ['docs/reference/program.md', 'When you change `role` in an exported plan, delete the written-back `lane`, `effort` and `deliverable` too'],
    ['skill/references/program.md', 'When you change `role` in an exported plan, delete the written-back `lane`, `effort` and `deliverable` too'],
    ['skill/SKILL.md', 'after a `role` change delete the written-back `lane`, `effort` and `deliverable`'],
  ];
  for (const [path, sentence] of advice) {
    assert.ok(flat(path).includes(sentence), `${path}: ${sentence}`);
    assert.doesNotMatch(flat(path), /delete the written-back `lane` and `effort` too/, path);
  }
});

test('the repair rules for act and report steps are documented', () => {
  const source = read('src/workflow/verify-rounds.js');
  const template = source.match(/next = `(an act step affects \$\{id\}; [^`]*)`/)[1];
  const actNext = template.replace('${id}', '<id>').replace('${runToken}', '<shortId>');
  assert.ok(flat('docs/reference/result.md').includes(actNext), 'result.md quotes the act next text');
  assert.ok(VERIFY_LOOP_STOPS.includes('act-step'));
  for (const path of ['docs/reference/result.md', 'skill/references/operations.md', 'docs/reference/program.md', 'CHANGELOG.md']) {
    const text = flat(path);
    assert.match(text, /read-only `analyze` step (with|whose) deliverable (is )?`report`/, `${path}: report repair`);
    assert.match(text, /act` step affects (is never repaired|gets no repair)/, `${path}: no act repair`);
  }
});

test('the enforced rules and field rows name the deliverable path refusals', () => {
  assert.throws(() => validate([{ ...step, id: 'a', role: 'produce', ownedFiles: ['README.md'], deliverable: { type: 'files', paths: ['CHANGELOG.md'] } }]), /deliverable\.paths must be listed in ownedFiles/);
  for (const path of PROGRAM_REFERENCES) {
    const text = flat(path);
    const rules = text.slice(text.indexOf('## Enforced rules'), text.indexOf('## Example'));
    assert.ok(rules.includes('A deliverable path must be an exact file, not a directory.'), `${path}: directory rule`);
    assert.ok(rules.includes('every deliverable path, `files` paths included, must be listed in it'), `${path}: ownedFiles rule`);
    assert.ok(rules.includes('An isolated run refuses a git-ignored deliverable path'), `${path}: git-ignored rule`);
    const row = text.match(/\| `deliverable` \| no \| [^\n]*?\|(?= \|)/)[0];
    assert.match(row, /not a directory/, `${path}: field row`);
    assert.match(row, /`files` paths too/, `${path}: field row`);
    assert.match(row, /git-ignored/, `${path}: field row`);
    assert.ok(text.includes('so a git-ignored file counts in a shared workspace; an isolated run refuses'), `${path}: gate table`);
  }
});

test('not-produced covers a build-lane step that changed nothing, and stoppedBy lists every stop', () => {
  const result = flat('docs/reference/result.md');
  assert.ok(result.includes('`not-produced` (a declared deliverable was not produced, or, in a run started by this version, a build-lane step with no declared deliverable changed no file and made no commit)'));
  // F18: help and the result reference list the same not-rerun cases (stage 3
  // reworded the list and points to step rerun, step accept or plan revise).
  const notRerun = '(declared evidence, a deliverable not produced, a check that failed it, output judged failed, or a build-lane step with no declared deliverable that changed nothing) is not rerun';
  assert.ok(helpText(['workflow', 'resume']).includes(`${notRerun}; use step rerun, step accept, or plan revise`));
  assert.ok(result.includes(`${notRerun} by \`workflow resume\``));
  const row = result.match(/\| `stoppedBy` \| ([^\n]*) \|/)[1];
  const listed = [...row.matchAll(/`([a-z-]+)` \(/g)].map((match) => match[1]);
  assert.deepEqual(listed, [...VERIFY_LOOP_STOPS]);
  // Each entry after the first follows a comma or the final "or".
  const gaps = row.split(/`(?:passed|rounds|revision|step-failed|act-step)` \(/).slice(1, -1).map((part) => part.slice(part.lastIndexOf(')')));
  for (const gap of gaps) assert.match(gap, /^\)(, | or )$/, `stoppedBy separator: ${JSON.stringify(gap)}`);
});

test('a rerun after not-produced is judged again, and a workspace git cannot see is judged only on ownedFiles', () => {
  const data = { ...step, id: 'd', role: 'produce', ownedFiles: ['out/d.json'], deliverable: { type: 'data', paths: ['out/d.json'] } };
  const unchanged = { 'out/d.json': { exists: true, sha1: 'x', mtimeMs: 1 } };
  const judge = (earlierWork) => deliverableVerdict({ action: data, verdict: { ok: true }, snapshotOk: true, pathsBefore: unchanged, pathsAfter: unchanged, earlierWork });
  assert.equal(judge({ produced: false, unknown: false }).failWhy, 'declared data not written: out/d.json');
  assert.equal(judge({ produced: true, unknown: false }).fact.carried, true);
  const plain = mkdtempSync(join(tmpdir(), 'bullswarm-docs-plain-'));
  try {
    assert.equal(snapshotPossible(plain, { ...step, role: 'produce', deliverable: { type: 'files' } }), false);
    assert.equal(snapshotPossible(plain, { ...step, role: 'produce', ownedFiles: ['a.txt'], deliverable: { type: 'files' } }), true);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  for (const path of PROGRAM_REFERENCES) {
    const text = flat(path);
    assert.ok(text.includes('A rerun of a step that failed `not-produced` is judged again. In an isolated run, only work from a step that succeeded counts.'), `${path}: rerun rule`);
    assert.ok(text.includes('a workspace git cannot see (not a repository, or a folder the repository ignores) is judged only on exact `ownedFiles`'), `${path}: files row`);
  }
  assert.ok(flat('CHANGELOG.md').includes('a rerun of a step that failed `not-produced` is judged again'));
});

test('program references document the failure classes and validate routed examples', () => {
  for (const path of PROGRAM_REFERENCES) {
    const [table] = tablesWithHeader(path, ['failure', 'automatic action', 'then']);
    assert.ok(table, `${path}: failure-rule table`);
    assert.deepEqual(table.rows.map((row) => row[0]), Object.keys(FAILURE_CLASSES), `${path}: failure classes`);
    for (const [failureClass, kinds] of Object.entries(FAILURE_CLASSES)) {
      assert.ok(table.rows.find((row) => row[0] === failureClass), `${path}: ${failureClass}`);
      for (const kind of kinds) assert.ok(flat(path).includes(`\`${kind}\``), `${path}: ${kind}`);
    }
    for (const example of examplePrograms(path)) {
      const verified = example.actions.find((action) => action.id === 'verify');
      assert.deepEqual(verified.route, { independentOf: ['since-flag'] }, `${path}: routed check example`);
      assert.ok(verified.dependsOn.includes('since-flag'), `${path}: route target is a dependency`);
    }
    const text = flat(path);
    assert.ok(text.includes('one automatic retry in total'), `${path}: retry budget`);
    assert.ok(text.includes('Only its dependents wait; other steps keep running.'), `${path}: dependents`);
  }
});

// Stage-2 docs review (F22-F34, F19) and the fresh-caller run: each claim is
// checked against the code first, then against the docs that state it.

const EVIDENCE_HEADING = '## Evidence: command and schema';
const issuesOf = (actions, options) => {
  try {
    validateActionProgram(program(actions), options);
    return '';
  } catch (error) {
    return (error.issues ?? [error.message]).join('; ');
  }
};
function evidenceSection(path) {
  const text = read(path);
  const start = text.indexOf(EVIDENCE_HEADING);
  assert.notEqual(start, -1, `${path}: evidence section`);
  const end = text.indexOf('\n## ', start + EVIDENCE_HEADING.length);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
}

test('the design doc replay table carries the measured counts and states the counting rule', () => {
  const path = 'docs/design/redesign-mechanics-principles-options.md';
  const [table] = tablesWithHeader(path, ['run', 'defects', 'caught, observed', 'caught, argued', 'not caught', 'inconclusive']);
  assert.ok(table, `${path}: replay table`);
  assert.deepEqual(table.rows, [
    ['a 23-step release batch', '9', '5', '1', '1', '2'],
    ['a 9-writer prototype', '6', '3', '0', '3', '0'],
    ['a 27-step dashboard tidy-up', '44', '11', '12', '20', '1'],
    ['Total', '59', '19', '13', '24', '3'],
  ]);
  const numbers = table.rows.map((row) => row.slice(1).map(Number));
  for (const [defects, ...parts] of numbers) assert.equal(parts.reduce((a, b) => a + b, 0), defects, 'each row adds up');
  for (let column = 0; column < 5; column += 1) assert.equal(numbers.slice(0, 3).reduce((sum, row) => sum + row[column], 0), numbers[3][column], 'totals add up');
  const text = flat(path);
  assert.doesNotMatch(text, /Observed replay counts: pending|section 7\.6|stage-2 spec/, `${path}: no pending line or pointer to an untracked spec`);
  assert.ok(text.includes('A defect counts as caught, observed only when a check that could have been declared when the owning step ran failed on the defect tree and passed on the fixed tree; argued when no tree pair exists or the check depends on a file the fix changed; not caught when it needs a browser or a judgment or no step owned the file; and inconclusive when the fixed tree fails too.'), `${path}: counting rule`);
  assert.ok(text.includes('The earlier estimates (7 of 7; 5 caught and 1 not; 25 caught and 6 not) were not supported by the replay.'), `${path}: estimates retracted`);
  assert.ok(text.includes('18 of the 19 observed catches needed a new check the caller would write from the step\'s prompt, and only 1 came from a check already in the repository.'), `${path}: where catches came from`);
});

test('review steps and digests take no evidence, and the docs say where to put reviewer commands', () => {
  const review = { ...step, id: 'rev', role: 'check', affects: [], evidenceFor: ['requirement-1'], evidence: [{ type: 'command', cmd: 'true' }] };
  assert.match(issuesOf([{ ...step, id: 'w', role: 'produce', ownedFiles: ['a.js'] }, { ...review, dependsOn: ['w'] }], { relaxedGraph: true, requirements: ['requirement-1'] }),
    /review steps \(evidenceFor\) take no evidence; put the commands the reviewer must run in its prompt/);
  const digest = { ...step, id: 'dg', kind: 'digest', affects: [], dependsOn: ['w'], evidence: [{ type: 'command', cmd: 'true' }] };
  assert.throws(() => validate([{ ...step, id: 'w', role: 'produce', ownedFiles: ['a.js'] }, digest]), /digest steps take no evidence/);
  assert.match(issuesOf([{ ...step, id: 'w', lane: 'build', ownedFiles: ['a.js'], evidence: [{ type: 'command', cmd: 'true' }] }], { requirements: ['requirement-1'] }), /evidence needs a program-mode run/);
  // A separate check step with evidence and no evidenceFor is accepted.
  const [, reprove] = validate([{ ...step, id: 'w', role: 'produce', ownedFiles: ['a.js'] }, { ...step, id: 'reprove', role: 'check', affects: [], dependsOn: ['w'], evidence: [{ type: 'command', cmd: 'npm test' }] }]).actions;
  assert.deepEqual(reprove.evidence, [{ type: 'command', cmd: 'npm test' }]);
  for (const path of PROGRAM_REFERENCES) {
    const section = evidenceSection(path);
    assert.ok(section.includes('`evidence` is refused on a review step (one with `evidenceFor`), on a `digest` (the kernel writes its report), in a run that is not program mode, and from a dispatched planner'), `${path}: where evidence is refused`);
    assert.ok(section.includes('Put the commands a reviewer must run in its prompt, or add a separate `check` step with `evidence` and an empty `evidenceFor`.'), `${path}: what to do instead`);
    assert.match(flat(path), /\| `evidence` \| no \| [^\n]*refused on review and digest steps \|/, `${path}: field row`);
  }
  assert.ok(flat('skill/SKILL.md').includes('A review step (non-empty `evidenceFor`) and a digest take no `evidence`: put the commands a reviewer must run in its prompt, or add a separate `check` step with `evidence` and an empty `evidenceFor`.'));
  assert.ok(flat('docs/guide/workflows.md').includes('A review step (one with `evidenceFor`) and a digest take no evidence'));
});

test('the docs say where each check result is', () => {
  const where = /`(?:bullswarm workflow )?runs result <id> --json`[^.]* under `actions\[\]\.evidenceResults`/;
  for (const path of ['skill/SKILL.md', ...PROGRAM_REFERENCES, 'skill/references/operations.md', 'docs/guide/workflows.md', 'CHANGELOG.md']) {
    assert.match(flat(path), where, `${path}: result location`);
  }
  for (const path of ['skill/SKILL.md', ...PROGRAM_REFERENCES, 'skill/references/operations.md']) {
    assert.match(flat(path), /`(?:bullswarm )?workflow action show <id> <step>`/, `${path}: action show`);
  }
  assert.match(flat('skill/SKILL.md'), /`actions\[\]\.evidenceResults` \(`status`, `exit`, `tail`, `why`\)/);
});

test('evidence not run: the docs name the display line and the null result field', () => {
  // The result field: a step that declares evidence and whose worker failed
  // first carries evidenceResults: null (E15).
  assert.match(read('src/workflow/v2-outcome.js'), /evidenceResults: clone\(attempt\?\.evidenceResults \?\? null\)/);
  // The display: the handback line and watch's failed line (E15).
  assert.match(read('src/workflow/v2-outcome.js'), /' · evidence not run'/);
  assert.match(read('src/workflow/watch-cli.js'), /' · evidence not run'/);
  const skill = flat('skill/SKILL.md');
  assert.doesNotMatch(skill, /the result says `evidence not run`/);
  assert.ok(skill.includes("If the worker fails first, no check runs: the step's handback line and watch's failed line read `evidence not run`, and the JSON has `evidenceResults: null`."));
  for (const path of PROGRAM_REFERENCES) assert.ok(evidenceSection(path).includes("If the worker fails first, no check runs: the step's handback line and watch's failed line read `evidence not run`, and the result has `evidenceResults: null`."), path);
  assert.ok(flat('docs/reference/result.md').includes('when the worker failed first and no check ran, the value is `null`, and the step\'s handback line reads `evidence not run`'));
});

test('the Evidence section follows the act and digest paragraphs in both program references', () => {
  for (const path of PROGRAM_REFERENCES) {
    const text = read(path);
    const roles = text.indexOf('## Roles and deliverables');
    const act = text.indexOf('An `act` step works outside the workspace.');
    const evidence = text.indexOf(EVIDENCE_HEADING);
    const requirements = text.indexOf('## Requirement IDs');
    assert.ok(roles < act && act < evidence && evidence < requirements, `${path}: act paragraph under Roles and deliverables, then Evidence, then Requirement IDs`);
    const digest = text.indexOf('Use a `digest` when');
    if (digest !== -1) assert.ok(roles < digest && digest < evidence, `${path}: digest paragraph under Roles and deliverables`);
  }
  // A step that declares evidence may depend on a digest; the rule is about review steps.
  const writers = ['a', 'b', 'c'].map((id) => ({ ...step, id, role: 'produce', ownedFiles: [`${id}.js`] }));
  const dg = { ...step, id: 'dg', kind: 'digest', affects: [], dependsOn: ['a', 'b', 'c'] };
  const merge = { ...step, id: 'merge', role: 'combine', deliverable: 'files', dependsOn: ['dg'], evidence: [{ type: 'command', cmd: 'npm test' }] };
  const review = { ...step, id: 'verify', role: 'check', affects: [], evidenceFor: ['requirement-1'] };
  assert.equal(issuesOf([...writers, dg, merge, { ...review, dependsOn: ['a', 'b', 'c', 'merge'] }], { relaxedGraph: true, requirements: ['requirement-1'] }), '');
  assert.match(issuesOf([...writers, dg, merge, { ...review, dependsOn: ['a', 'b', 'c', 'dg', 'merge'] }], { relaxedGraph: true, requirements: ['requirement-1'] }), /must not depend on digest dg/);
  for (const path of [...PROGRAM_REFERENCES, 'skill/SKILL.md', 'docs/guide/workflows.md']) {
    assert.doesNotMatch(flat(path), /Evidence never depends on a digest/, `${path}: digest rule names review steps`);
  }
  assert.ok(flat('docs/reference/program.md').includes('No review step depends on a digest.'));
  assert.ok(flat('skill/SKILL.md').includes('No review step depends on a digest.'));
});

test('the operations handback list names unreadSteering once, before the failed-evidence paragraph', () => {
  const text = read('skill/references/operations.md');
  assert.equal(text.split('- `handback.unreadSteering[]`').length - 1, 1);
  assert.ok(text.indexOf('- `handback.unreadSteering[]`') < text.indexOf('A `failed-evidence` result means'));
});

test('proof labels for a step without evidence read as stepProof computes them', () => {
  const def = { id: 'w', role: 'produce', affects: ['requirement-1'], ownedFiles: ['a.js'], evidenceFor: [], dependsOn: [] };
  const reviewer = { id: 'rev', role: 'check', affects: [], ownedFiles: [], evidenceFor: ['requirement-1'], dependsOn: ['w'] };
  const state = (requirementStatus) => ({
    actions: [{ id: 'w', status: 'succeeded' }, { id: 'rev', status: 'pending' }],
    attempts: [{ actionId: 'w', status: 'succeeded' }],
    ledger: { requirements: { 'requirement-1': { status: requirementStatus } } },
    program: { actions: [def, reviewer] },
  });
  const features = { proofLabels: 1 };
  assert.equal(formatV2ProofLabel(stepProof(state('passed'), def, { features })), 'proven by review');
  assert.equal(formatV2ProofLabel(stepProof(state('pending'), def, { atFinish: true, features })), 'review pending');
  assert.equal(formatV2ProofLabel(stepProof({ ...state('pending'), program: { actions: [def] } }, def, { atFinish: true, features })), 'unproven');
  // Runs without the proofLabels marker show no label on a step without evidence.
  assert.equal(stepProof(state('passed'), def, { features: {} }), null);
  for (const path of ['skill/SKILL.md', ...PROGRAM_REFERENCES, 'skill/references/operations.md', 'docs/design/redesign-mechanics-principles-options.md', 'CHANGELOG.md']) {
    const text = flat(path);
    assert.ok(text.includes('`review pending`'), `${path}: review pending`);
    assert.ok(text.includes('`finished · unproven`'), `${path}: unproven`);
    assert.doesNotMatch(text, /Older runs keep their saved labels|Without evidence, a finished step in a new run reads `finished · unproven`\./, `${path}: labels are derived`);
  }
  for (const path of PROGRAM_REFERENCES) {
    assert.ok(evidenceSection(path).includes('A step without evidence reads `proven by review` once that review passes, `review pending` at the end of the run while a review step still covers its requirements, and `finished · unproven` otherwise.'), path);
    assert.ok(evidenceSection(path).includes('Labels are derived, not saved: runs started before this version show labels only on steps that declare evidence.'), path);
  }
});

test('both Evidence sections cover item outcomes, headMoved and the fault split', async () => {
  // The code: the runner's item outcomes, the headMoved fact, and fault: check.
  const runner = read('src/workflow/evidence-runner.js');
  for (const fact of ['timed out after', 'killed by ${signal}', 'could not start: ', 'not run: an earlier item changed the deliverable', 'changed the deliverable: ', "entry.headMoved = true", "fault === 'check'"]) {
    assert.ok(runner.includes(fact), `runner: ${fact}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-docs-fault-'));
  try {
    writeFileSync(join(dir, 'd.json'), '{}');
    const noSchema = await runStepEvidence([{ type: 'schema', file: 'd.json', schema: 'missing.json' }], { cwd: dir, outFile: join(dir, 'o.md') });
    assert.equal(noSchema.results[0].fault, 'check');
    assert.equal(noSchema.checkFault, true);
    const noData = await runStepEvidence([{ type: 'schema', file: 'absent.json', schema: 'd.json' }], { cwd: dir, outFile: join(dir, 'o.md') });
    assert.equal(noData.results[0].fault, undefined);
    assert.equal(noData.checkFault, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const path of PROGRAM_REFERENCES) {
    const section = evidenceSection(path);
    for (const phrase of ['`exit <n>`', '`timed out after <n>s`', '`killed by <SIGNAL>`', '`could not start: <message>`', '`changed the deliverable: <paths>`', '`not run: an earlier item changed the deliverable`', '`stopped`', '`headMoved: true`', '`touched`', '`fault: "check"`', '`check could not run:`', '`file missing: out/x.json`']) {
      assert.ok(section.includes(phrase), `${path}: ${phrase}`);
    }
  }
});

test('the evidenceResults example in the result reference is a real runner result', async () => {
  const block = read('docs/reference/result.md').match(/```json\n(\{"type":"schema"[^\n]*\})\n```/)[1];
  const documented = JSON.parse(block);
  assert.deepEqual(evidenceResultsIssues([documented], 'evidenceResults'), []);
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-docs-result-'));
  try {
    mkdirSync(join(dir, 'out'));
    mkdirSync(join(dir, 'schemas'));
    writeFileSync(join(dir, 'out/records.json'), '[{"date":20260901}]\n');
    writeFileSync(join(dir, 'schemas/record.json'), JSON.stringify({ type: 'array', items: { type: 'object', properties: { date: { type: 'string' } } } }));
    const { results } = await runStepEvidence([{ type: 'schema', file: 'out/records.json', schema: 'schemas/record.json' }], {
      cwd: dir, outFile: join(dir, 'o.md'), logFileFor: (k) => join(dir, `evidence-records-attempt-1-${k}.log`),
    });
    const real = { ...results[0], log: `<runDir>/${results[0].log.split('/').pop()}` };
    assert.deepEqual({ ...documented, durationMs: 0 }, { ...real, durationMs: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the changelog describes what ships, without internal stage names', () => {
  const text = read('CHANGELOG.md');
  const unreleased = text.slice(text.indexOf('## Unreleased'), text.indexOf('\n## ', text.indexOf('## Unreleased') + 5));
  assert.doesNotMatch(unreleased, /\bstage[ -]?[0-9]\b/i);
});

test('the e2e gate advice names the 600-second cap', () => {
  assert.equal(EVIDENCE_MAX_TIMEOUT_SEC, 600);
  assert.throws(() => validate([{ ...step, id: 'gate', role: 'check', affects: [], evidence: [{ type: 'command', cmd: 'npm run e2e', timeoutSec: 601 }] }]), /timeoutSec must be an integer from 1 to 600/);
  const skill = flat('skill/SKILL.md');
  const gate = skill.slice(skill.indexOf('**Finish after integration.**'), skill.indexOf('**Evidence: checks Bullswarm runs.**'));
  assert.ok(gate.includes('when the suite finishes within 10 minutes (`timeoutSec` is at most 600); otherwise split it into several items or keep the command in the gate\'s prompt'), 'skill gate paragraph');
  for (const path of PROGRAM_REFERENCES) assert.ok(evidenceSection(path).includes('A suite that runs longer than 600 seconds cannot be one item'), path);
});

test('every JSON example with evidence in the docs validates on a program step', () => {
  const docs = ['skill/references/program.md', 'docs/reference/program.md', 'docs/guide/workflows.md', 'docs/design/redesign-mechanics-principles-options.md'];
  let checked = 0;
  for (const path of docs) {
    for (const [, body] of read(path).matchAll(/```json\n([\s\S]*?)```/g)) {
      const value = JSON.parse(body);
      const steps = value.schemaVersion ? value.actions : [value];
      for (const example of steps.filter((item) => item.evidence)) {
        const writer = { ...step, id: 'w', role: 'produce', ownedFiles: ['out/records.json', 'tests/probe.test.js'], deliverable: { type: 'data', paths: ['out/records.json'] }, evidence: example.evidence };
        assert.deepEqual(validate([writer]).actions[0].evidence, example.evidence, `${path}: ${JSON.stringify(example.evidence)}`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 7, 'two evidence steps in each program example and the design doc fragment');
});

test('the docs carry the fix round: no-record JSONL, $ref targets, on-disk schema messages, act-step stops, restored by-products, the check heartbeat', () => {
  // Each documented string is one the code really prints.
  const source = (path) => read(path);
  assert.match(source('src/workflow/schema-check.js'), /why: 'no records'/);
  assert.match(source('src/workflow/v2-planner.js'), /schema is not a supported schema \(/);
  assert.match(source('src/workflow/v2-planner.js'), /schema is git-ignored \("\$\{item\.schema\}"\); the isolated copy will not contain it, so the check could not run/);
  assert.match(source('src/workflow/v2-dispatch.js'), /check by-product not restored: /);
  assert.match(source('src/lib/stale.js'), /no check heartbeat for /);
  assert.match(source('src/workflow/v2-outcome.js'), /evidenceNotRun: true/);
  for (const path of PROGRAM_REFERENCES) {
    const section = evidenceSection(path);
    for (const phrase of [
      'every `$ref` target is checked as a schema',
      'a JSONL file with no records fails with `no records`',
      'put `--` before a path that starts with `-`',
      '`…schema is not a supported schema ("P"): <reason>`',
      '`…schema is git-ignored ("P"); the isolated copy will not contain it, so the check could not run`',
      'An `act` step is the exception',
      'a `step restart` during its checks is refused',
      '`check by-product not restored: <paths>`',
    ]) assert.ok(section.includes(phrase), `${path}: ${phrase}`);
  }
  for (const path of ['skill/SKILL.md', 'skill/references/operations.md', 'docs/guide/observing.md']) {
    assert.ok(flat(path).includes("While Bullswarm runs a step's declared checks, only quiet counts, read from the checks' heartbeat"), path);
    assert.ok(flat(path).includes('no check heartbeat for <N>m'), path);
  }
  assert.ok(flat('docs/reference/result.md').includes('adds `evidenceNotRun: true`'));
  assert.ok(flat('docs/guide/concepts.md').includes('`review pending` while a review step still covers them'), 'concepts: labels as stepProof computes them (F27)');
  assert.ok(flat('skill/SKILL.md').includes("quote the run's proof line as printed"), 'Run E: the caller quotes the proof line');
});

// Stage-3 fix round (F31, F33-F38): every option the skill tells a caller to
// choose is printed by the code with those words, in the order a caller meets
// them: the needs-you block, a usage limit's block, the end-of-run handback,
// and the accept that is a choice, never proof.

// A skill section: from its heading to the next heading of the same depth.
function section(path, heading) {
  const text = read(path);
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${path}: ${heading}`);
  const depth = heading.match(/^#+/)[0];
  const after = text.slice(start + heading.length + 2);
  const end = after.search(new RegExp(`\\n${depth} `));
  return (end < 0 ? after : after.slice(0, end)).replace(/\s+/g, ' ');
}

// The `your call:` lines of a needs-you block as [label, command] pairs.
function blockOptions(lines) {
  const from = lines.indexOf('  your call:');
  return lines.slice(from + 1).filter((line) => /^ {4}\S/.test(line) || /^ {6}then/.test(line))
    .map((line) => [line.slice(4, 21).trim(), line.slice(21)]);
}

function needsYouState(candidates) {
  return {
    runId: 'wf-docs', shortId: '<shortId>',
    program: { actions: [{ id: '<step>', kind: 'implement', dependsOn: [] }] },
    actions: [{ id: '<step>', status: 'failed' }],
    attempts: [{
      id: 'a1', actionId: '<step>', ordinal: 1, pool: '<pool>', model: 'model-a', routeCandidates: candidates,
      startedAt: '2026-09-24T01:00:00.000Z', finishedAt: '2026-09-24T01:05:00.000Z', outputFile: '<path>',
    }],
  };
}

test('the skill names the needs-you options renderNeedsYou prints, with the commands it prints', () => {
  const skill = section('skill/SKILL.md', '### When a step needs you');
  const event = { type: 'action.finished', committedAt: '2026-09-24T01:06:00.000Z', payload: { actionId: '<step>', status: 'failed', failureKind: 'process', why: 'exit 1' } };
  const render = (candidates) => {
    const facts = needsYouFacts(needsYouState(candidates), event, { features: STAGE3_RUN_FEATURES });
    return blockOptions(renderNeedsYou(facts, { next: 'bullswarm workflow watch <shortId> --until trouble' }));
  };
  const elsewhere = render(['<pool>', 'pool-b']);
  const here = render(['<pool>']);
  assert.deepEqual(elsewhere.map(([label]) => label), ['rerun elsewhere', 'change the step', 'then edit it', 'take over', 'accept anyway']);
  assert.equal(here[0][0], 'retry here');
  for (const [label, command] of [...elsewhere, here[0]]) {
    assert.ok(skill.includes(`\`${label}\``), `the skill names the printed option \`${label}\``);
    assert.ok(skill.includes(`\`${command}\``), `the skill gives the printed command for ${label}: ${command}`);
  }
  // The review variant's extra check is named as printed.
  assert.ok(skill.includes('`also judged by <check>:`'));
  assert.match(read('src/workflow/needs-you.js'), /`    also judged by \$\{other\.step\}:`/);
  assert.ok(skill.includes('four options'));
});

test('the workflows guide shows the needs-you block exactly as renderNeedsYou prints it', () => {
  const guide = read('docs/guide/workflows.md');
  const example = guide.slice(guide.indexOf('## The failure rule and needs-you block')).match(/```text\n([\s\S]*?)\n```/)[1];
  const facts = {
    variant: 'step', token: '<id>', actionId: 'variants', label: 'command evidence failed', retries: 1, notRetried: null,
    evidence: [{ type: 'command', cmd: 'node check-assets.mjs out/', exit: 1, why: 'exit 1', tail: 'banner-b.png has the wrong dimensions' }],
    attempts: [
      { pool: 'pool-a', model: 'image model', durationSec: 660, files: 3 },
      { pool: 'pool-a', model: 'image model', durationSec: 420, files: 3, retryOf: 'same-pool' },
    ],
    stillRunning: ['copy'], waitingOnThis: ['pick'],
    options: {
      rerunElsewhere: 'bullswarm workflow step rerun <id> variants --avoid pool-a',
      takeOver: 'output: <absolute output path>',
      acceptAnyway: 'bullswarm workflow step accept <id> variants --reason "…"',
    },
  };
  assert.equal(example, renderNeedsYou(facts, { next: 'bullswarm workflow watch <id> --until trouble --after <sequence> --since <iso>' }).join('\n'));
});

// A marked run's step that a usage limit (or no free pool) sent back to the
// caller, with placeholder names: the facts needsYouFacts builds from the
// step's finish event. `attempts: false` is a step no pool could take.
const BACK_AT = '2026-09-25T14:00:00.000Z';
function limitFacts({ stepId = '<step>', token = '<shortId>', failureKind = 'quota', why = '<the provider\'s limit notice>', attempts = true } = {}) {
  const state = {
    runId: 'wf-docs', shortId: token,
    program: { actions: [{ id: stepId, kind: 'implement', dependsOn: [] }] },
    actions: [{ id: stepId, status: 'failed' }],
    attempts: attempts ? [{
      id: 'a1', actionId: stepId, ordinal: 1, pool: 'pool-a', model: 'model-a', routeCandidates: ['pool-a', 'pool-b'],
      status: 'failed', failureKind, changedFileCount: 0, outputFile: '<absolute output path>',
      startedAt: '2026-09-25T09:00:00.000Z', finishedAt: '2026-09-25T09:04:00.000Z',
    }] : [],
  };
  const event = {
    type: 'action.finished', committedAt: '2026-09-25T09:05:00.000Z',
    payload: { actionId: stepId, status: 'failed', failureKind, why, retryAfter: BACK_AT },
  };
  return needsYouFacts(state, event, { token, features: STAGE3_RUN_FEATURES });
}

// The same sentence in every page that explains the transient backoff.
const THROTTLE_SENTENCE = 'backs off on the same pool at most twice (20 s, then 60 s, or the wait it names when that is at most 2 minutes), then comes back to you';

test('the skill says a usage limit or no free pool comes back to you, with the back-at time and the options the block prints', () => {
  const skill = section('skill/SKILL.md', '### A usage limit or no free pool');
  const whole = flat('skill/SKILL.md');
  // A usage limit: straight back to the caller, not retried, with its return time.
  const lines = renderNeedsYou(limitFacts(), { next: 'bullswarm workflow watch <shortId> --until trouble' });
  assert.match(lines[0], / <step> needs you · out of quota · not retried$/);
  assert.ok(whole.includes('`✗ <step> needs you · out of quota …`'));
  assert.ok(skill.includes('The step comes straight back to you'));
  assert.ok(skill.includes('Nothing waits, moves to another pool or retries by itself, and the rest of the run keeps going.'));
  assert.ok(lines.includes(`  back at   ${BACK_AT}`));
  assert.ok(skill.includes('`back at <time>`'));
  // Every option the block prints is named, and the new ones give the printed command.
  const options = new Map(blockOptions(lines));
  assert.deepEqual([...options.keys()], ['rerun elsewhere', 'wait for it', 'change the step', 'then edit it', 'take over', 'accept anyway']);
  for (const label of ['rerun elsewhere', 'wait for it', 'accept anyway', 'change the step', 'take over']) {
    assert.ok(skill.includes(`\`${label}\``), `the section names \`${label}\``);
  }
  const placeholders = (command) => command.replace(BACK_AT, '<time>').replace('--avoid pool-a', '--avoid <pool>');
  for (const label of ['rerun elsewhere', 'wait for it', 'accept anyway']) {
    assert.ok(skill.includes(`\`${placeholders(options.get(label))}\``), `the section gives ${label}: ${options.get(label)}`);
  }
  for (const label of ['change the step', 'then edit it']) assert.ok(whole.includes(`\`${options.get(label)}\``), label);
  assert.ok(skill.includes('`bullswarm workflow cancel <shortId>`'));
  // The machine form carries the same time and command.
  const json = needsYouJson(limitFacts());
  assert.equal(json.backAt, BACK_AT);
  assert.equal(json.options.waitForIt, `after ${BACK_AT}: bullswarm workflow step rerun <shortId> <step>`);
  // No pool free: the why names each pool's reason, as the dispatcher words it.
  const dispatch = read('src/workflow/v2-dispatch.js');
  for (const words of ["'no pool with quota to spare'", "'no pool free'", "'paused for quota'", '· no retry: ']) {
    assert.ok(dispatch.includes(words), `the dispatcher writes ${words}`);
  }
  assert.ok(skill.includes('`· no retry: <pool> <reason>; …`'));
  assert.ok(skill.includes('`no pool with quota to spare: <pool> paused for quota until <time>; …`'));
  assert.ok(skill.includes('`no pool free: …`'));
  const noPool = renderNeedsYou(limitFacts({ attempts: false, why: `no pool with quota to spare: pool-a paused for quota until ${BACK_AT}` }));
  assert.match(noPool[0], / <step> needs you · out of quota · not retried$/);
  assert.ok(noPool.includes(`  back at   ${BACK_AT}`));
  const notFree = renderNeedsYou(limitFacts({ attempts: false, failureKind: 'unavailable', why: 'no pool free: pool-a already failed on this step' }));
  assert.match(notFree[0], / <step> needs you · no eligible pool · not retried$/);
  assert.ok(skill.includes('the header then reads `no eligible pool`'));
  // A transient rate limit is not a usage limit: two bounded backoffs, then the caller.
  assert.deepEqual(THROTTLE_BACKOFF_MS, [20_000, 60_000]);
  // A marked run sits out a named wait of at most 2 minutes; the 15-minute cap
  // is the one runs started earlier keep.
  assert.equal(dispatchModule.MARKED_THROTTLE_MAX_WAIT_MS, 2 * 60_000);
  assert.equal(THROTTLE_MAX_WAIT_MS, 15 * 60_000);
  assert.ok(skill.includes(`It ${THROTTLE_SENTENCE}`));
  assert.ok(skill.includes('with automatic pausing on or off'));
  assert.ok(skill.includes('even when the notice names no reset'));
  assert.ok(skill.includes('One that names a longer wait comes back to you at once, with `back at` at the end of that wait.'));
  // A backoff whose pool is out comes back at once, with that pool's own return.
  const backoffLost = 'One whose pool is no longer free for the backoff (paused, at its 5-hour limit, nearly spent or benched in the meantime) comes back to you at once too: as `out of quota` when that pool is out on a usage limit, with `back at` its return when that is known.';
  // A process failure retries by itself, on the same pool when it is the only
  // one (except after a sign-in failure): the pages never say it always moves.
  const processRetry = 'A sign-in failure, a provider error or a worker that died at start still gets the step\'s one automatic retry by itself, on another free pool when there is one.';
  for (const [path, text] of [['skill/SKILL.md', skill], ['docs/guide/workflows.md', flat('docs/guide/workflows.md')]]) {
    assert.ok(text.includes(backoffLost), path);
    assert.ok(text.includes(processRetry), path);
    assert.ok(!text.includes('still moves to another free pool by itself'), path);
  }
});

test('the workflows guide shows a usage limit\'s block exactly as renderNeedsYou prints it, and names every choice', () => {
  const guide = read('docs/guide/workflows.md');
  const from = guide.indexOf('A usage limit ends the step');
  assert.ok(from > guide.indexOf('## The failure rule and needs-you block'), 'the usage-limit paragraph is in the failure-rule section');
  const example = guide.slice(from).match(/```text\n([\s\S]*?)\n```/)[1];
  const facts = limitFacts({ stepId: 'build', token: '<id>' });
  assert.equal(example, renderNeedsYou(facts, { next: 'bullswarm workflow watch <id> --until trouble --after <sequence> --since <iso>' }).join('\n'));
  const text = flat('docs/guide/workflows.md');
  assert.ok(text.includes('`bullswarm workflow step rerun <id> <step> --avoid <pool>`'));
  assert.ok(text.includes('nothing reruns it for you'));
  assert.ok(text.includes('`bullswarm workflow cancel <id>`'));
  assert.ok(text.includes(`It ${THROTTLE_SENTENCE}`));
  assert.ok(flat('skill/references/operations.md').includes(`it ${THROTTLE_SENTENCE}`));
  // back at: the earliest known return; a pool with none is skipped.
  assert.ok(text.includes('`back at` is then the earliest known return among those pools; a pool whose return is unknown is skipped.'));
  assert.ok(text.includes('A limit notice that names no reset ends the step too; its block then prints `back at` only when every pool that can run the step is out and one of them has a known return.'));
  // A rerun leaves a pool only after a sign-in, provider or died-at-start
  // failure; a usage limit is routed as usual.
  assert.ok(text.includes('Pool-caused failures are a sign-in failure, a provider error, or a worker that exited with an error before it answered or changed a file.'));
  assert.ok(text.includes('A usage limit is not one of these: a rerun after one is routed as usual'));
  const attempt = (failureKind) => ({ pool: 'pool-a', status: 'failed', failureKind });
  assert.equal(poolCausedFailure(attempt('quota')), false);
  assert.equal(poolCausedFailure(attempt('throttle')), false);
  for (const kind of ['auth', 'provider', 'process']) assert.equal(poolCausedFailure(attempt(kind)), true, kind);
});

test('the watch pages give the usage-limit line and the needs-you JSONL fields the code prints', async () => {
  const quotaLine = (fields) => renderWatchEvent({ type: 'attempt.quota', actionId: '<step>', pool: '<pool>', proof: null, willRetry: false, failureRule: true, ...fields });
  assert.match(quotaLine({ until: BACK_AT }), / <step> usage limit on <pool> · paused until \S+ · back to you$/);
  // A marked run's pool that was not paused for it: `not paused` (a notable
  // that carried a return time would print it; the runtime's never does).
  assert.match(quotaLine({ until: null, paused: false, backAt: BACK_AT }), new RegExp(` <step> usage limit on <pool> · back at ${BACK_AT} · back to you$`));
  assert.match(quotaLine({ until: null }), / <step> usage limit on <pool> · not paused · back to you$/);
  // A real marked run whose step hit a usage limit with its return time known
  // and no pause: the attempt's event carries no return time, so the line
  // reads `not paused`, and the needs-you block after it carries `back at`.
  const run = await limitStopRun({ mode: 'program' });
  const stepEvents = run.events.filter((event) => event.payload?.actionId === 'write-report');
  const attemptFinished = stepEvents.find((event) => event.type === 'attempt.finished');
  assert.equal(Object.hasOwn(attemptFinished.payload, 'retryAfter'), false, 'attempt events carry no retryAfter');
  const [limitNotable] = notableWatchEvents({ events: [attemptFinished], state: run.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.equal(renderWatchEvent(limitNotable).replace(/^\S+ /, '⚠ '), '⚠ write-report usage limit on pool-a · not paused · back to you');
  const stepFinished = stepEvents.find((event) => event.type === 'action.finished');
  assert.equal(stepFinished.payload.retryAfter, BACK_AT);
  assert.ok(renderNeedsYou(needsYouFacts(run.state, stepFinished, { token: '<id>', features: STAGE3_RUN_FEATURES })).includes(`  back at   ${BACK_AT}`));
  assert.ok(flat('skill/references/operations.md').includes('(`not paused` in place of the pause when the pool was not paused for it: the line carries no return time), then the needs-you block, which carries the return time as `back at <time>` when it is known'));
  assert.ok(flat('docs/guide/observing.md').includes('the line reads `not paused` in place of the pause deadline (`⚠ <actionId> usage limit on <pool> · not paused · back to you`): the attempt\'s event carries no return time. The needs-you block that follows carries it instead, as its `back at <time>` line, when the return time is known.'));
  assert.ok(helpText(['workflow', 'watch']).replace(/\s+/g, ' ').includes('a pool that was not paused for it reads `not paused` in place of the pause, and the needs-you block after it carries the `back at <time>` line'));
  // A saved stage-3 attempt that promised a retry.
  assert.match(renderWatchEvent({ type: 'attempt.quota', actionId: '<step>', pool: '<pool>', until: null, willRetry: true, failureRule: true }), / · no retry spent$/);
  const operations = flat('skill/references/operations.md');
  assert.ok(operations.includes('`⚠ <step> usage limit on <pool> · paused until <time> · … · back to you`'));
  assert.ok(operations.includes('`backAt` and `options.waitForIt`'));
  const observing = flat('docs/guide/observing.md');
  assert.ok(observing.includes('the line ends `back to you`'));
  assert.ok(observing.includes('reads `no retry spent`'));
  assert.ok(observing.includes('`waitForIt` (`after <time>: step rerun <id> <step>`)'));
  assert.ok(observing.includes('carries `backAt`'));
});

test('the pages give the try line a rate-limit backoff prints, and back at only in runs started by this version', () => {
  const stepId = '<step>';
  const tries = (secondPool) => ({
    runId: 'wf-docs', shortId: '<shortId>',
    program: { actions: [{ id: stepId, kind: 'implement', dependsOn: [] }] },
    actions: [{ id: stepId, status: 'failed' }],
    attempts: [
      { id: 'a1', actionId: stepId, ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'failed', failureKind: 'throttle', changedFileCount: 0, startedAt: '2026-09-25T09:00:00.000Z', finishedAt: '2026-09-25T09:01:00.000Z' },
      { id: 'a2', actionId: stepId, ordinal: 2, pool: secondPool, model: 'model-a', status: 'failed', failureKind: 'throttle', changedFileCount: 0, retryOf: { how: 'wait' }, startedAt: '2026-09-25T09:01:20.000Z', finishedAt: '2026-09-25T09:02:00.000Z' },
    ],
  });
  const event = { type: 'action.finished', committedAt: '2026-09-25T09:03:00.000Z', payload: { actionId: stepId, status: 'failed', failureKind: 'throttle', why: '<the provider\'s rate-limit notice>', retryAfter: BACK_AT } };
  const marked = needsYouFacts(tries('pool-a'), event, { token: '<shortId>', features: STAGE3_RUN_FEATURES });
  const lines = renderNeedsYou(marked);
  assert.match(lines[0], / <step> needs you · rate limited/);
  assert.match(lines.find((line) => line.startsWith('  try 2 ')), / · after a rate-limit backoff$/);
  // A rate limit that named a longer wait carries its return: back at, in a marked run only.
  assert.ok(lines.includes(`  back at   ${BACK_AT}`));
  assert.equal(needsYouJson(marked).options.waitForIt, `after ${BACK_AT}: bullswarm workflow step rerun <shortId> <step>`);
  const earlier = needsYouFacts(tries('pool-a'), event, { token: '<shortId>', features: {} });
  assert.equal(earlier.backAt, undefined);
  assert.ok(!renderNeedsYou(earlier).some((line) => line.startsWith('  back at') || line.includes('wait for it')));
  // A saved stage-3 run's move after a usage limit keeps its own words.
  assert.match(renderNeedsYou(needsYouFacts(tries('pool-b'), event, { token: '<shortId>', features: STAGE3_RUN_FEATURES })).find((line) => line.startsWith('  try 2 ')), / · moved after a usage limit$/);
  for (const path of ['skill/SKILL.md', 'docs/guide/workflows.md', 'skill/references/operations.md', 'docs/guide/observing.md']) {
    assert.ok(flat(path).includes('`· after a rate-limit backoff`'), path);
  }
  // A backoff is never the step's retry: the header counts the backoffs.
  assert.match(lines[0], / <step> needs you · rate limited · backed off once$/);
  const twice = { ...tries('pool-a') };
  twice.attempts = [...twice.attempts, { ...twice.attempts[1], id: 'a3', ordinal: 3 }];
  assert.match(renderNeedsYou(needsYouFacts(twice, event, { token: '<shortId>', features: STAGE3_RUN_FEATURES }))[0], / <step> needs you · rate limited · backed off twice$/);
  assert.ok(flat('skill/SKILL.md').includes('(`✗ <step> needs you · rate limited · backed off twice`)'));
  assert.ok(flat('docs/guide/workflows.md').includes('Its header reads `rate limited · backed off twice` (`once` after one backoff; a backoff is never counted as the retry)'));
  assert.ok(flat('skill/references/operations.md').includes('the block\'s header counts the backoffs (`backed off twice`)'));
  assert.ok(flat('skill/SKILL.md').includes('When a return time is known, for this or any other failure, the block prints `back at <time>`'));
  assert.ok(flat('skill/references/operations.md').includes('Runs started earlier print no `back at`.'));
});

test('workflow capabilities states the failure rule the docs give', { timeout: 60_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-docs-caps-'));
  try {
    const cli = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));
    const run = spawnSync(process.execPath, [cli, 'workflow', 'capabilities'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0' },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const rule = JSON.parse(run.stdout).routing.failureRule;
    assert.deepEqual(Object.keys(rule), ['retriesPerStep', 'processFailure', 'gateFailure', 'quota', 'throttle', 'noFreePool', 'plannerAndScout', 'then', 'savedRuns']);
    // The planner and the scout follow the same rule; the planner mode says so too.
    assert.match(rule.plannerAndScout, /^the dispatched planner and the preflight scout follow the quota, throttle and noFreePool rules: .* stops them with no move to another pool; /);
    // Nearly spent pools are never fed to the planner or the scout either.
    assert.match(rule.plannerAndScout, /stops them with no move to another pool; a nearly spent pool \(its window closes soon and the dispatch would push it past its limit\) is never given to them either, unless the caller named it; the run finishes partial/);
    assert.match(rule.plannerAndScout, /"the workflow planner stopped on a usage limit: <why>" \(or "the preflight scout stopped on a usage limit: <why>" for a scout with no program after it; "stopped: no pool free" when a pool was out for another reason or no pool can run it at all\)/);
    assert.match(rule.plannerAndScout, /a sign-in failure, a provider error or a worker that died at start still moves them to another pool$/);
    // Resume after the return time runs the stopped planner turn or scout
    // again; a scout the run went on without is not run again.
    assert.match(rule.plannerAndScout, /back at retryAfter when known, and the caller's options \(bullswarm workflow resume after retryAfter runs the stopped planner turn or scout again; plan it yourself with plan revise; or start a new run\); a scout before a caller program lets the run go on without its report, and resume does not run that scout again; /);
    assert.ok(!/nothing to retry|resume does not run the planner/.test(rule.plannerAndScout));
    const modes = JSON.parse(run.stdout).engines.autonomousV2.plannerModes;
    assert.match(modes.dispatched, /a usage limit or no free pool stops the planner \(or the scout before it\) with no move to another pool/);
    assert.match(modes.dispatched, /a nearly spent pool is never given to either/);
    // The guides say the same: a draining pool is never fed, not even last.
    assert.ok(flat('docs/guide/workflows.md').includes('The dispatched planner and the preflight scout are never given such a pool either; only a pool you pinned is exempt (`--orchestrator <pool> --orchestrator-strict` for the planner, `--worker-pool` for the scout).'));
    assert.ok(flat('docs/guide/routing.md').includes('In a workflow started by this version a `draining` pool does not go last: it is never given a step, the dispatched planner or the preflight scout, even as the only pool left, unless you pinned it.'));
    assert.match(rule.quota, /ends the step and goes to the caller at once, whatever the pausing switch; never waited out, moved or retried; retryAfter is the reset when it is known, else the earliest known return when no capable pool is free$/);
    assert.match(rule.quota, /with or without a reset, or a full meter/);
    assert.match(rule.throttle, /backs off on the same pool at most twice without spending the retry \(20 s, then 60 s, or a named wait of at most 2 minutes\), then goes to the caller/);
    assert.match(rule.throttle, /a longer named wait goes to the caller at once, with retryAfter at its end; a backoff whose pool is no longer free goes to the caller at once, as quota when that pool is out on a usage limit, with retryAfter its known return$/);
    assert.match(rule.noFreePool, /the step goes to the caller, as quota when every reason is a usage limit, else unavailable; why names each pool and its reason; retryAfter is the earliest known return; /);
    // A promised retry keeps its own kind (the dispatcher's no-retry tail).
    assert.match(rule.noFreePool, /a promised retry that finds no free pool keeps the last failure's kind and its why ends "· no retry: <pool> <reason>; …"$/);
    assert.equal(rule.savedRuns, 'keep their original retry and review rules');
    for (const [key, text] of Object.entries(rule)) {
      assert.ok(!/wait for a known return time|move without spending the retry/.test(String(text)), key);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('no skill page, guide, reference or help text describes a step that waits for a pool', () => {
  const stale = [
    'waiting for quota', 'waiting for a pool', 'quota wait', 'wait for a known return time', 'waits for a known return time',
    'makes the step wait', 'already waiting', 'more than 30 min', 'starts again by itself', 'Quota moves to another eligible pool',
    'move to another eligible pool without spending the retry', 'never fails for quota', 'waits for one to come back',
    'the step becomes `waiting`', 'including `waiting`', 'waits on a paused pool', 'waited on a pool', 'up to 15 minutes',
    'printed only when each of them has a known return time', 'when every one is known', 'resuming before then fails it again at once',
    'while a return time is known', 'moves the step by itself',
  ];
  const unreleased = (text) => text.slice(text.indexOf('## Unreleased'), text.indexOf('\n## ', text.indexOf('## Unreleased') + 1));
  const pages = [
    'skill/SKILL.md', 'skill/references/operations.md', 'skill/references/program.md', 'docs/reference/program.md',
    'docs/guide/workflows.md', 'docs/guide/observing.md', 'docs/guide/routing.md', 'docs/reference/cli.md',
    'docs/reference/result.md', 'AGENTS.md',
  ];
  for (const path of pages) {
    const text = flat(path);
    for (const phrase of stale) assert.ok(!text.includes(phrase), `${path}: ${phrase}`);
  }
  const changelog = unreleased(read('CHANGELOG.md')).replace(/\s+/g, ' ');
  assert.ok(changelog.length > 1000, 'the Unreleased section is read');
  for (const phrase of stale) assert.ok(!changelog.includes(phrase), `CHANGELOG Unreleased: ${phrase}`);
  // The contract a planner reads, and the resume note, say the same.
  const contract = v2PlannerContractRules({ executionMode: 'program', plannerMode: 'caller' }).join(' ');
  for (const phrase of [...stale, 'A pool out of quota makes the step wait']) assert.ok(!contract.includes(phrase), `planner contract: ${phrase}`);
  assert.ok(!read('src/workflow/cli.js').includes('waited on a pool'));
  const watch = helpText(['workflow', 'watch']);
  for (const phrase of stale) assert.ok(!watch.includes(phrase), `workflow watch --help: ${phrase}`);
  assert.ok(watch.includes('it ends `back to you` and a needs-you block follows'));
  assert.ok(helpText(['strategy', 'set-pausing']).includes('a spent usage window still ends the step and sends it back to the caller, whatever the switch'));
  assert.ok(flat('docs/reference/cli.md').includes('a spent usage window still ends the step and comes back to you, whatever the switch'));
});

// A marked program run with one failed retryable step, one failed gate step,
// and a requirement the review loop left failing, all with placeholder names.
function handbackEnvelope({ accepted = false } = {}) {
  return {
    runId: 'wf-docs', shortId: '<shortId>', status: 'partial', verified: false, executionMode: 'program',
    reason: 'not verified', finishedAt: '2026-09-24T01:10:00Z', goal: 'Ship the acme report',
    requirements: [{
      id: '<id>', text: 'totals are right', mandatory: true, status: 'failed', workRevision: 2,
      evidence: [{ sourceAction: '<check>', status: 'failed', evidence: ['the empty week still totals 1'], reviewer: { pool: '<pool>', model: 'model-b', provider: null } }],
      ...(accepted ? { accepted: { step: '<check>', reason: '<reason>', at: '2026-09-24T01:20:00Z' } } : {}),
    }],
    actions: [
      { id: '<step>', status: 'failed', outputFile: '/runs/acme/out-step-attempt-2.md' },
      { id: '<check>', status: 'succeeded', outputFile: '/runs/acme/out-check-attempt-1.md' },
    ],
    usage: { total: 2, byPool: { 'pool-a': 1, 'pool-b': 1 } },
    verifyRounds: { max: 2, used: 2, stoppedBy: 'rounds', phases: [] },
    ...(accepted ? {} : {
      callerDecision: { verifyRounds: '2/2', requirements: [{ id: '<id>', status: 'failed', round: 2, evidence: 'the empty week still totals 1', next: 'fix it with a step' }] },
    }),
    handback: {
      unfinished: [{ id: '<step>', status: 'failed', failureKind: 'process', why: 'exit 1', retryable: true, retries: 1 }],
      unresolvedRequirements: [{ id: '<id>', status: 'failed', why: 'the empty week still totals 1' }], unreadSteering: [],
    },
  };
}

// The runnable command inside one handback option text.
function optionCommands(key, text) {
  const bare = text.replace(/ \([^()]*\)$/, '');
  if (key === 'continue') return bare.split(', edit it, then ');
  if (key === 'retry') return [bare.replace(/ after \S+$/, '')];
  if (key === 'takeOver') return [bare.match(/(bullswarm workflow runs result \S+ --json)/)[1]];
  if (key === 'restart') return [bare.replace(/^start a new run: /, '')];
  return [bare];
}

test('the skill and the result reference list the handback options formatV2HandbackLines prints', () => {
  const summary = summarizeV2Result(handbackEnvelope(), null, { runDir: '/runs/acme', features: STAGE3_RUN_FEATURES });
  const options = summary.handback.options;
  assert.deepEqual(Object.keys(options), ['continue', 'retry', 'rerun', 'accept', 'rerunReview', 'acceptRequirement', 'takeOver', 'restart']);
  const lines = formatV2HandbackLines(summary);
  const printed = lines.slice(lines.indexOf('your call:') + 1).map((line) => line.slice(2, 11).trim());
  assert.deepEqual(printed, ['continue', 'retry', 'rerun', 'accept', 'rerun', 'accept', 'take over', 'restart']);
  const finish = section('skill/SKILL.md', '### When it finishes');
  const result = flat('docs/reference/result.md');
  const operations = flat('skill/references/operations.md');
  Object.entries(options).forEach(([key, text], index) => {
    assert.ok(finish.includes(`| \`${printed[index]}\` |`), `the skill's your-call tables have a \`${printed[index]}\` row`);
    for (const command of optionCommands(key, text)) assert.ok(finish.includes(`\`${command}\``), `the skill gives ${key}: ${command}`);
    assert.ok(result.includes(`| \`${key}\` | ${printed[index]} |`), `result.md lists ${key}, printed as ${printed[index]}`);
    if (key !== 'retry') assert.ok(result.includes(`\`${text}\``), `result.md gives ${key} as printed: ${text}`);
    assert.ok(operations.includes(`\`${key}\``), `operations.md lists ${key}`);
  });
  assert.ok(!result.includes('`changeStep`'), 'no handback option is called changeStep');
  // The retry guidance stays with the retry row.
  for (const path of ['skill/SKILL.md', 'docs/guide/workflows.md', 'docs/reference/result.md']) {
    assert.ok(flat(path).includes('`nothing to retry`'), path);
  }
  assert.match(read('src/workflow/v2-outcome.js'), /its pool is back at \$\{entry\.retryAfter\}/);
  assert.ok(flat('skill/SKILL.md').includes('`its pool is back at <time>`'));
  // The needs-you options are not the end-of-run options (F33).
  assert.ok(!finish.includes('`rerun elsewhere`') && !finish.includes('`accept anyway`'));
  // Order: the needs-you block, a usage limit's block, the end of the run, the accept.
  const skill = read('skill/SKILL.md');
  const at = ['### When a step needs you', '### A usage limit or no free pool', '### When it finishes', '**An accept is a choice, never proof.**'].map((text) => skill.indexOf(text));
  assert.ok(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1])), `skill order: ${at}`);
});

test('an accept reads as the code prints it and the skill says it is a choice, never proof', () => {
  const summary = summarizeV2Result(handbackEnvelope({ accepted: true }), null, { runDir: '/runs/acme', features: STAGE3_RUN_FEATURES });
  const line = formatV2HandbackLines(summary).find((text) => text.includes('accepted by choice'));
  assert.equal(line, '  requirement <id>: failed · accepted by choice "<reason>"');
  const proof = formatV2ProofLine({ proof: { proven: 0, byType: {}, unproven: 0, unprovenSteps: [], accepted: 1, acceptedSteps: ['<steps>'] } });
  assert.equal(proof, 'proof: 1 accepted by choice: <steps>');
  assert.equal(formatV2ProofLabel({ by: ['choice'] }), 'accepted by choice');
  const skill = flat('skill/SKILL.md');
  assert.ok(skill.includes('**An accept is a choice, never proof.**'));
  assert.ok(skill.includes(`\`${line.trim()}\``));
  assert.ok(skill.includes('`N accepted by choice: <steps>`'));
  assert.ok(skill.includes('reads `accepted by choice`'));
  for (const path of ['docs/guide/workflows.md', 'skill/references/operations.md']) assert.ok(flat(path).includes(`\`${line.trim()}\``), path);
});

test('the result reference reads independent and requirements[].next as the code computes them (F34, F35)', () => {
  const result = flat('docs/reference/result.md');
  assert.ok(result.includes("`independent` is `true` when no provider that did work on the judged steps is the reviewer's provider, `false` when one is, and `null` when no writer is known or the reviewer's or a writer's provider is unknown."));
  assert.ok(!result.includes('says whether its provider also did work'));
  const outcome = read('src/workflow/v2-outcome.js');
  assert.match(outcome, /if \(reviewer\?\.provider && writers\.some\(\(writer\) => writer\?\.provider === reviewer\.provider\)\) return false;/);
  assert.match(outcome, /if \(!reviewer\?\.provider \|\| writers\.some\(\(writer\) => !writer\?\.provider\)\) return null;/);
  // The marked `next` text, from the template in verify-rounds.js.
  const source = read('src/workflow/verify-rounds.js');
  const fill = (text) => text.replace(/\$\{runToken\}/g, '<shortId>').replace(/\$\{reviewer\}/g, '<check>').replace(/\$\{pool\}/g, '<pool>').replace(/\$\{id\}/g, '<id>');
  const fix = fill(source.match(/const fix = `(fix it with a step \([^`]*\))`;/)[1]);
  const rerun = fill(source.match(/const rerun = `(rerun the review elsewhere \([^`]*\))`;/)[1]);
  const accept = fill(source.match(/\? `\$\{fix\}, \$\{rerun\}, (or accept it \([^`]*\))`/)[1]);
  assert.ok(result.includes(`\`${fix}, ${rerun}, ${accept}\``), `${fix}, ${rerun}, ${accept}`);
  assert.ok(!result.includes('add a step that fixes'));
  assert.ok(!source.includes('add a step that fixes'));
});

test('docs do not overstate the failure rule: not-produced gets its gate retry, a usage limit goes to the caller (F31, F36, F38)', () => {
  for (const path of PROGRAM_REFERENCES) {
    const text = flat(path);
    assert.ok(!/not-produced`\. That failure is not retried automatically/.test(text), path);
    assert.ok(text.includes('that failure gets one retry on the same pool in a fresh session with the failure attached, then comes back to you'), path);
    assert.ok(!text.includes('Quota never fails only because it is exhausted'), path);
    // A usage limit, or no free pool, goes to the caller; only a rate limit backs off.
    assert.ok(text.includes('`quota`: none. A usage limit (a spent 5-hour or weekly window, or no credit left) ends the step at once. `throttle`: at most two short backoffs on the same pool (20 s, then 60 s, or a named wait of at most 2 minutes), without spending the retry'), path);
    assert.ok(text.includes('Nothing waits for a pool. A limit notice is `quota` when it says a usage window, a quota or a balance is spent, with or without a reset named and whatever the pausing switch'), path);
    assert.ok(text.includes('the step comes back to you as `quota` when every reason is a usage limit, else as `unavailable`'), path);
    assert.ok(text.includes('If a route leaves no free pool, the step comes back to you at once'), path);
  }
  // The planner contract says the same (program mode, either planner).
  for (const plannerMode of ['caller', 'dispatched']) {
    const rules = v2PlannerContractRules({ executionMode: 'program', plannerMode }).join(' ');
    assert.ok(rules.includes('A usage limit (a spent 5-hour or weekly window, or no credit left), or no free pool that can run the step, sends it back to you at once, with the time its pool is back when that is known; no step waits for a pool, and a usage limit never moves a step to another pool by itself. A transient rate limit (too many requests) backs off on the same pool at most twice, then comes back to you.'), plannerMode);
    assert.ok(rules.includes('a step it leaves without a free pool comes back to you at once (no eligible pool, or each pool\'s reason) and never waits for one.'), plannerMode);
  }
  const operations = flat('skill/references/operations.md');
  assert.ok(!operations.includes('A run never waits: not for its caller, not for a paused pool'));
  // No step waits inside a run for a pool (owner decision, 2026-09-25).
  assert.ok(!operations.includes('A step may wait inside the run for a pool whose return time is known'));
  assert.ok(operations.includes('A run never waits for its caller, for a silent worker, or for a pool to come back.'));
  assert.ok(operations.includes('retryable, retries?}'));
  // The same-pool process retry is never used after a sign-in failure.
  assert.match(read('src/workflow/v2-dispatch.js'), /soleCandidate && kind !== 'auth'\) next = \{ how: 'same-pool'/);
  const changelog = flat('CHANGELOG.md');
  assert.ok(changelog.includes('(the same pool when it is the only one, except after a sign-in failure)'));
  assert.ok(!changelog.includes('A pool out of quota is not a failure'));
  const agents = flat('AGENTS.md');
  assert.ok(!agents.includes('never fail, whatever the pausing switch'));
  assert.ok(!agents.includes('it never fails for quota while a return time is known'));
  assert.ok(agents.includes('ends the step and sends it to the caller, whatever the pausing switch: no wait, no automatic move, no retry.'));
});

// A marked run whose dispatched planner or preflight scout a usage limit
// stopped, run through the real kernel with a dispatcher that answers every
// dispatch with the same limit. `mode`: planner (a dispatched planner, no
// scout), scout (the scout before a dispatched planner), or program (the
// scout before the caller's own program). `after`: then take one way on from
// the finished run, 'resume' (workflow resume reopens it; no kernel is
// relaunched) or 'revise' (plan revise with a program).
async function limitStopRun({ mode = 'planner', failureKind = 'quota', retryAfter = BACK_AT, after = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-docs-limit-'));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir);
  mkdirSync(workspace);
  const settings = mode === 'planner' ? { scout: false } : mode === 'scout' ? { scout: true } : { scout: true, plannerMode: 'caller' };
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver a correct report', cwd: workspace, requirements: [{ id: 'report-correct', text: 'report.md exists' }],
    settings: { concurrency: 1, executionMode: 'program', ...settings },
  });
  const seen = [];
  const dispatch = async (options) => {
    seen.push({ id: options.action.id, usageLimitsToCaller: options.usageLimitsToCaller === true });
    const files = options.paths(1);
    const startedAt = '2026-09-01T09:00:00.000Z';
    options.onAttempt?.('started', { ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {} });
    const record = {
      ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'failed', startedAt, finishedAt: '2026-09-01T09:01:00.000Z',
      taskFile: files.taskFile, outFile: files.outFile, failureKind, why: '<why>', usage: null, wallSec: 60, routing: {},
    };
    options.onAttempt?.('finished', record);
    return { ok: false, status: 'failed', failureKind, ...(retryAfter ? { retryAfter } : {}), attempts: [record], verdict: { ok: false, why: '<why>' } };
  };
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [{ id: 'write-report', purpose: 'Write the report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] }],
  };
  try {
    const run = await runV2AutonomousWorkflow({
      bullswarmDir, goalDocument, pools: [], runId: 'wf-docslimit-abcdef', dependencies: { dispatchV2Action: dispatch },
      ...(mode === 'program' ? { initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the report.', program } } : {}),
    });
    const events = readEvents(run.runDir);
    const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir, features: STAGE3_RUN_FEATURES });
    let resumed = null;
    let revised = null;
    if (after === 'resume') {
      const outcome = reopenV2RunForRetry({ bullswarmDir, runId: 'wf-docslimit-abcdef' });
      resumed = { status: outcome.status, requeued: outcome.requeued ?? null, dispatch: outcome.dispatch ?? null };
    }
    if (after === 'revise') {
      const request = createRevisionRequest({ program, summary: 'Plan it myself.' }, { source: 'cli' });
      revised = await reviseV2Program({ bullswarmDir, runId: 'wf-docslimit-abcdef', request, waitMs: 0 });
    }
    return { result: run.result, state: run.state, shortId: run.state.shortId, seen, events, summary, resumed, revised };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// A marked run whose dispatched planner no pool can run at all: the real
// dispatcher with no pools. The reason comes back with `<id>` for the run.
async function noPoolPlannerRun() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-docs-nopool-'));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir);
  mkdirSync(workspace);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver a correct report', cwd: workspace, requirements: [{ id: 'report-correct', text: 'report.md exists' }],
    settings: { concurrency: 1, executionMode: 'program', scout: false },
  });
  try {
    const run = await runV2AutonomousWorkflow({
      bullswarmDir, goalDocument, pools: [], runId: 'wf-docsnopool-abcdef', parentEnv: {},
      dependencies: { refreshPools: async () => null },
    });
    return { status: run.result.status, reason: run.result.reason.replaceAll(run.state.shortId, '<id>') };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('the pages give the reason a planner or scout stopped by a usage limit finishes the run with', async () => {
  const planner = await limitStopRun({ after: 'revise' });
  assert.deepEqual(planner.seen, [{ id: 'workflow-planner', usageLimitsToCaller: true }], 'one planner dispatch, told to leave usage limits to the caller');
  assert.equal(planner.result.status, 'partial');
  const named = (text, token) => text.replaceAll(planner.shortId, token).replaceAll(BACK_AT, '<time>');
  const reason = named(planner.result.reason, '<id>');
  assert.equal(reason, 'the workflow planner stopped on a usage limit: <why> · back at <time> · your call: resume after <time> with bullswarm workflow resume <id>, plan it yourself with bullswarm workflow plan revise <id> --program <file.json>, or start a new run');
  // Each command it names works on the finished run. plan revise runs the
  // caller's program:
  assert.equal(planner.revised.status, 'applied');
  assert.equal(planner.revised.reopened.previousStatus, 'partial');
  assert.deepEqual(planner.revised.state.program.actions.map((action) => action.id), ['write-report']);
  // and resume reopens the run to run the stopped planner again.
  const plannerResumed = await limitStopRun({ after: 'resume' });
  assert.deepEqual(plannerResumed.resumed, {
    status: 'reopened', requeued: ['workflow-planner'],
    dispatch: { id: 'workflow-planner', who: 'the workflow planner', retryAfter: BACK_AT },
  });
  // The result's retry option names it, with the time to wait for.
  assert.equal(named(planner.summary.handback.options.retry, '<shortId>'), 'bullswarm workflow resume <shortId> after <time> (reruns the workflow planner)');
  assert.ok(flat('docs/guide/workflows.md').includes('`bullswarm workflow resume <shortId> after <time> (reruns the workflow planner)`'));
  assert.ok(flat('CHANGELOG.md').includes('`bullswarm workflow resume <run> after <time> (reruns the workflow planner)`'));
  // What resume prints (cli.js reopenFinishedRun), as the pages quote it.
  const cli = read('src/workflow/cli.js');
  assert.ok(cli.includes('console.log(`✓ reopened the ${outcome.previousStatus} run ${id}; running again: ${running.join(\', \')}`);'));
  assert.ok(cli.includes('console.log(`  note: ${dispatch.who} stopped with its pool back at ${dispatch.retryAfter}; run before then, it can fail the same way again`);'));
  for (const path of ['skill/SKILL.md', 'skill/references/operations.md', 'docs/guide/workflows.md', 'docs/reference/cli.md', 'CHANGELOG.md']) {
    const page = flat(path);
    assert.ok(!page.includes('does not run the planner or the scout again') && !page.includes('does not run a stopped planner'), path);
    assert.ok(page.includes('runs the stopped planner or scout again') || page.includes('runs it again'), path);
    assert.ok(page.includes('running again: the workflow planner'), path);
  }
  for (const path of ['skill/references/operations.md', 'docs/guide/workflows.md', 'docs/reference/cli.md', 'CHANGELOG.md']) {
    assert.ok(flat(path).includes('reopened the partial run <'), path);
  }
  for (const path of ['skill/references/operations.md', 'docs/guide/workflows.md']) {
    assert.ok(flat(path).includes('stopped with its pool back at <time>; run before then, it can fail the same way again`'), path);
  }
  // The guide shows the reason verbatim; the skill, the CLI reference and the
  // changelog give it with their own run placeholder.
  assert.ok(read('docs/guide/workflows.md').includes(`\`\`\`text\n${reason}\n\`\`\``));
  const withShort = named(planner.result.reason, '<shortId>');
  assert.ok(flat('skill/SKILL.md').includes(`\`reason: ${withShort}\``));
  assert.ok(flat('docs/reference/cli.md').includes(`\`${withShort}\``));
  assert.ok(flat('CHANGELOG.md').includes(`\`${named(planner.result.reason, '<run>')}\``));
  assert.ok(flat('skill/references/operations.md').includes(`\`${reason}\``));
  const finished = planner.events.find((event) => event.type === 'planner.finished');
  assert.deepEqual([finished.payload.failureKind, finished.payload.retryAfter], ['quota', BACK_AT]);
  assert.ok(flat('skill/references/operations.md').includes('The `planner.finished` and `preflight.scout_finished` events of such a stop carry `failureKind`, `why` and `retryAfter`'));
  // The watch prints the planner's stop as its own line, and wakes on it.
  const plannerNotable = notableWatchEvents({ events: [finished], state: planner.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.equal(plannerNotable.length, 1);
  const plannerLine = renderWatchEvent(plannerNotable[0]).replace(/^\S+ /, '✗ ').replaceAll(BACK_AT, '<time>').replaceAll('pool-a', '<pool>');
  assert.equal(plannerLine, '✗ planner stopped · out of quota on <pool> · back at <time>');
  assert.equal(watchTrouble(plannerNotable[0], { program: true }), 'planner-limit');
  for (const path of ['skill/SKILL.md', 'docs/guide/workflows.md', 'CHANGELOG.md']) {
    assert.ok(flat(path).includes(`\`${plannerLine}\``), path);
  }
  const plannerGeneral = '`✗ planner stopped · <label> on <pool> · back at <time>`';
  for (const path of ['docs/guide/observing.md', 'skill/references/operations.md', 'docs/reference/cli.md']) {
    assert.ok(flat(path).includes(plannerGeneral), path);
  }
  assert.ok(helpText(['workflow', 'watch']).replace(/\s+/g, ' ').includes(`prints ${plannerGeneral} and the run finishes`));
  // An unmarked run keeps the rejected planning line; so does any other planner failure (below).
  assert.deepEqual(notableWatchEvents({ events: [finished], state: planner.state, features: {} }).notable.map((event) => renderWatchEvent(event)), ['× planning attempt rejected · <why>']);
  assert.ok(flat('docs/guide/observing.md').includes('A planner turn that fails for any other reason, and every planner failure in a run from an earlier version, still prints `× planning attempt rejected · <why>`'));
  for (const path of ['skill/references/operations.md', 'docs/reference/cli.md']) {
    assert.ok(flat(path).includes('planner failure still prints `× planning attempt rejected · <why>`'), path);
  }
  assert.ok(flat('CHANGELOG.md').includes('(it used to read `× planning attempt rejected · …`)'));
  // Before it, the planner attempt's own usage-limit line, which ends `no
  // retry left` and brings no needs-you block. The pool was not paused and
  // the attempt's event carries no return time: `not paused`.
  const everyLine = notableWatchEvents({ events: planner.events, state: planner.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.deepEqual(everyLine.map((event) => event.type), ['attempt.quota', 'planner.finished']);
  assert.match(renderWatchEvent(everyLine[0]), / workflow-planner usage limit on pool-a · not paused · no retry left$/);
  assert.equal(watchTrouble(everyLine[0], { program: true }), null);
  assert.ok(flat('docs/guide/observing.md').includes('a scout or planner attempt that hit a usage limit prints its own usage-limit line, which ends `no retry left` there (`⚠ preflight-scout usage limit on <pool> · … · no retry left`) and is followed by no needs-you block'));
  assert.ok(flat('skill/references/operations.md').includes('The scout\'s or the planner\'s own usage-limit line before it ends `no retry left`, and no needs-you block follows it.'));
  assert.ok(helpText(['workflow', 'watch']).replace(/\s+/g, ' ').includes('The scout\'s or the planner\'s own usage-limit line ends `no retry left`, and no needs-you block follows it.'));
  // A planner failure that is not a limit carries no return time.
  const signIn = await limitStopRun({ failureKind: 'auth', retryAfter: null });
  const signInFinished = signIn.events.find((event) => event.type === 'planner.finished');
  assert.equal(Object.hasOwn(signInFinished.payload, 'retryAfter'), false);
  // Not a limit: the marked run's watch keeps the rejected planning line.
  const signInNotable = notableWatchEvents({ events: [signInFinished], state: signIn.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.deepEqual(signInNotable.map((event) => renderWatchEvent(event)), ['× planning attempt rejected · <why>']);
  assert.equal(watchTrouble(signInNotable[0], { program: true }), 'rejected');
  assert.match(signIn.result.reason, /^the workflow planner could not produce a mechanically valid program: /);
  // No return time: no back at, no "after that time".
  const unknown = await limitStopRun({ retryAfter: null });
  assert.equal(unknown.result.reason.replaceAll(unknown.shortId, '<id>'), 'the workflow planner stopped on a usage limit: <why> · your call: bullswarm workflow resume <id> once a pool is free, plan it yourself with bullswarm workflow plan revise <id> --program <file.json>, or start a new run');
  assert.equal(unknown.summary.handback.options.retry.replaceAll(unknown.shortId, '<id>'), 'bullswarm workflow resume <id> (reruns the workflow planner)');
  for (const path of ['skill/references/operations.md', 'docs/guide/workflows.md']) {
    assert.ok(flat(path).includes('drops `back at` when no return time is known'), path);
    assert.ok(flat(path).includes('`bullswarm workflow resume <id> once a pool is free`'), path);
  }
  assert.ok(flat('docs/reference/cli.md').includes('`bullswarm workflow resume <shortId> once a pool is free`'));
  assert.ok(flat('CHANGELOG.md').includes('`bullswarm workflow resume <run> once a pool is free`'));
  // No pool free for a reason that is not a usage limit.
  const noPool = await limitStopRun({ failureKind: 'unavailable' });
  assert.match(noPool.result.reason, /^the workflow planner stopped: no pool free: <why> · back at /);
  for (const path of ['skill/SKILL.md', 'skill/references/operations.md', 'docs/guide/workflows.md', 'docs/reference/result.md', 'CHANGELOG.md']) {
    assert.ok(flat(path).includes('`stopped: no pool free`'), path);
    assert.ok(flat(path).includes('no pool can run it at all'), path);
  }
  // No pool can run the planner at all (the real dispatcher, no pools): the
  // same stop, with the dispatcher's own reason.
  const none = await noPoolPlannerRun();
  assert.equal(none.reason, 'the workflow planner stopped: no pool free: no eligible pool: no enabled pool has a model on the high tier for analyze work · your call: bullswarm workflow resume <id> once a pool is free, plan it yourself with bullswarm workflow plan revise <id> --program <file.json>, or start a new run');
  // A scout with no program after it ends the run the same way.
  const scout = await limitStopRun({ mode: 'scout', after: 'revise' });
  assert.deepEqual(scout.seen, [{ id: 'preflight-scout', usageLimitsToCaller: true }], 'no planner runs after the stopped scout');
  assert.equal(scout.result.reason.replaceAll(scout.shortId, '<id>').replaceAll(BACK_AT, '<time>'), reason.replace('the workflow planner', 'the preflight scout'));
  assert.equal(scout.revised.status, 'applied');
  assert.equal(scout.summary.handback.options.retry.replaceAll(scout.shortId, '<id>').replaceAll(BACK_AT, '<time>'), 'bullswarm workflow resume <id> after <time> (reruns the preflight scout)');
  const scoutResumed = await limitStopRun({ mode: 'scout', after: 'resume' });
  assert.deepEqual(scoutResumed.resumed, {
    status: 'reopened', requeued: ['preflight-scout'],
    dispatch: { id: 'preflight-scout', who: 'the preflight scout', retryAfter: BACK_AT },
  });
  // A scout the run went on without (before the caller's program) is not run again.
  const goneOn = await limitStopRun({ mode: 'program', after: 'resume' });
  // Resume reopens the run for the program's step (it failed on the same
  // limit), never for the scout.
  assert.deepEqual(goneOn.resumed, { status: 'reopened', requeued: ['write-report'], dispatch: null });
  assert.equal(goneOn.summary.handback.options.retry.replaceAll(goneOn.shortId, '<id>').replaceAll(BACK_AT, '<time>'), 'bullswarm workflow resume <id> after <time> (reruns write-report)');
  for (const path of ['skill/SKILL.md', 'skill/references/operations.md', 'docs/guide/workflows.md', 'docs/reference/cli.md']) {
    assert.ok(/resume`? does not run that scout again/.test(flat(path)), path);
  }
  // Where a page says what resume does, it runs the planner or scout again
  // only when that stop ended the run.
  assert.ok(flat('docs/reference/cli.md').includes('where a usage limit or no free pool stopped the dispatched planner or the scout and ended the run, it runs that planner or scout again first (`running again: the workflow planner`); run it after the `back at` time, or it can stop the same way. A scout the run went on without (one before your own program) is not run again.'));
  assert.ok(flat('skill/references/operations.md').includes('also a planner or scout whose stop on a usage limit or no free pool ended the run, which runs first'));
  for (const path of ['skill/SKILL.md', 'docs/guide/workflows.md']) {
    assert.ok(flat(path).includes('or a usage limit or no free pool stopped the planner or scout and ended the run'), path);
  }
  assert.ok(flat('skill/SKILL.md').includes('`retry` appears only when a step is retryable, or when a usage limit or no free pool stopped the planner or scout and ended the run.'));
  for (const path of ['skill/SKILL.md', 'skill/references/operations.md', 'docs/guide/workflows.md', 'docs/guide/routing.md', 'docs/reference/cli.md', 'docs/reference/result.md', 'CHANGELOG.md']) {
    assert.ok(flat(path).includes('`the preflight scout stopped on a usage limit: …`'), path);
  }
});

test('the pages give the line the watch prints for a scout a usage limit stopped, and --until trouble wakes on it', async () => {
  const withProgram = await limitStopRun({ mode: 'program' });
  const lineFor = (run) => {
    const scoutEvent = run.events.find((event) => event.type === 'preflight.scout_finished');
    assert.equal(scoutEvent.payload.retryAfter, BACK_AT);
    const { notable } = notableWatchEvents({ events: [scoutEvent], state: run.state, features: STAGE3_RUN_FEATURES });
    assert.equal(notable.length, 1);
    assert.equal(watchTrouble(notable[0], { program: true }), 'scout-limit');
    return renderWatchEvent(notable[0]).replace(/^\S+ /, '⚠ ').replaceAll(BACK_AT, '<time>').replaceAll('pool-a', '<pool>');
  };
  const line = lineFor(withProgram);
  assert.equal(line, '⚠ preflight scout stopped · out of quota on <pool> · back at <time> · the run continues without its report');
  assert.deepEqual(withProgram.seen.map((entry) => entry.id), ['preflight-scout', 'write-report'], 'the caller\'s program runs without the report');
  for (const path of ['skill/SKILL.md', 'docs/guide/workflows.md', 'CHANGELOG.md']) {
    assert.ok(flat(path).includes(`\`${line}\``), path);
  }
  // Before it, the scout attempt's own usage-limit line, ending `no retry left`.
  const everyLine = notableWatchEvents({ events: withProgram.events, state: withProgram.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.deepEqual(everyLine.slice(0, 2).map((event) => event.type), ['attempt.quota', 'preflight.scout_finished']);
  assert.match(renderWatchEvent(everyLine[0]), / preflight-scout usage limit on pool-a · .* · no retry left$/);
  // Without a program the line has no tail, and the run finishes instead.
  const scoutOnly = await limitStopRun({ mode: 'scout' });
  assert.equal(lineFor(scoutOnly), '⚠ preflight scout stopped · out of quota on <pool> · back at <time>');
  // No pool free: no pool is named, and no return time is left out.
  const unpicked = await limitStopRun({ mode: 'program', failureKind: 'unavailable', retryAfter: null });
  const unpickedEvent = unpicked.events.find((event) => event.type === 'preflight.scout_finished');
  const [unpickedLine] = notableWatchEvents({ events: [unpickedEvent], state: unpicked.state, features: STAGE3_RUN_FEATURES }).notable;
  assert.equal(renderWatchEvent(unpickedLine).replace(/^\S+ /, '⚠ '), '⚠ preflight scout stopped · no eligible pool on no pool · the run continues without its report');
  assert.ok(flat('docs/guide/observing.md').includes('`<pool>` reads `no pool` when none was picked; `back at` is left out when no return time is known'));
  const general = '`⚠ preflight scout stopped · <label> on <pool> · back at <time>`';
  assert.ok(flat('docs/guide/observing.md').includes(general));
  assert.ok(flat('skill/references/operations.md').includes('`⚠ preflight scout stopped · <label> on <pool> · back at <time> · the run continues without its report`'));
  assert.ok(helpText(['workflow', 'watch']).includes(general));
  // The labels are the needs-you block's.
  for (const label of ['out of quota', 'rate limited', 'no eligible pool']) {
    for (const path of ['docs/guide/observing.md', 'skill/references/operations.md']) assert.ok(flat(path).includes(`\`${label}\``), `${path}: ${label}`);
  }
  // An unmarked run prints nothing new.
  const scoutEvent = withProgram.events.find((event) => event.type === 'preflight.scout_finished');
  assert.deepEqual(notableWatchEvents({ events: [scoutEvent], state: withProgram.state, features: {} }).notable, []);
  // The event carries the kernel's decision, and the pages name the field:
  // the run went on with the caller's program, and finished without one.
  assert.equal(scoutEvent.payload.runContinues, true);
  assert.equal(scoutOnly.events.find((event) => event.type === 'preflight.scout_finished').payload.runContinues, false);
  assert.ok(flat('skill/references/operations.md').includes('the scout\'s also carries `runContinues` (true when the run goes on without its report, false when it finishes there)'));
  assert.ok(flat('CHANGELOG.md').includes('(the scout\'s also `runContinues`: whether the run goes on without its report)'));
  // Trouble lists in the watch pages and help name it.
  // A planner stopped the same way is trouble too (watchTrouble 'planner-limit').
  assert.ok(flat('skill/SKILL.md').includes('a planner or scout that stopped on a usage limit'));
  assert.ok(flat('docs/guide/observing.md').includes('a planner or preflight scout that stopped on a usage limit'));
  assert.ok(flat('skill/references/operations.md').includes('a planner or preflight scout that stopped on a usage limit'));
  assert.ok(flat('docs/reference/cli.md').includes('a planner or scout stopped on a usage limit'));
  assert.ok(helpText(['workflow', 'watch']).includes('or at a planner or preflight scout stopped on a usage limit'));
});
