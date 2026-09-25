import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_KINDS, KIND_DEFAULTS, validateActionProgram } from '../src/workflow/action-validator.js';
import { EVIDENCE_ENV_KEYS, EVIDENCE_MAX_TIMEOUT_SEC, runStepEvidence } from '../src/workflow/evidence-runner.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from '../src/workflow/schema-check.js';
import { FAILURE_CLASSES, KIND_ROLES, ROLES, ROLE_DEFAULT_DELIVERABLE, STEP_EVIDENCE_TYPES, evidenceResultsIssues, roleRouting } from '../src/workflow/step-vocabulary.js';
import { formatV2ProofLabel, stepProof } from '../src/workflow/v2-outcome.js';
import { deliverableVerdict, snapshotPossible } from '../src/workflow/v2-dispatch.js';
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
