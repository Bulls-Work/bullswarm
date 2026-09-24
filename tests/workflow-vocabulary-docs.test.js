import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_KINDS, KIND_DEFAULTS, validateActionProgram } from '../src/workflow/action-validator.js';
import { KIND_ROLES, ROLES, ROLE_DEFAULT_DELIVERABLE, roleRouting } from '../src/workflow/step-vocabulary.js';
import { deliverableVerdict, snapshotPossible } from '../src/workflow/v2-dispatch.js';
import { VERIFY_LOOP_STOPS } from '../src/workflow/verify-rounds.js';
import { helpText } from '../src/help.js';

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
      // The example is written with roles: two produce steps, one combine
      // that merges files, and one check at high effort.
      assert.deepEqual(
        accepted.actions.map((action) => [action.role, action.deliverable?.type, action.lane, action.effort]),
        [
          ['produce', 'files', 'build', 'medium'],
          ['produce', 'files', 'build', 'medium'],
          ['combine', 'files', 'build', 'high'],
          ['check', 'report', 'analyze', 'high'],
        ],
        path,
      );
      assert.ok(program.actions.every((action) => action.kind === undefined), `${path}: the example uses roles, not kinds`);
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
  assert.match(helpText(['workflow', 'resume']), /a build-lane step with no declared deliverable that changed nothing\) is not rerun/);
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
