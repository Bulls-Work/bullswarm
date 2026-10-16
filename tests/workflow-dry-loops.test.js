// Loops that stop when a review is dry, and area reviewers that rotate
// (0.38.12, docs/design/0.38.12-dry-loops.md section 9). Pure functions
// first, then validation, the kernel with a fake worker, and two end-to-end
// runs with the echo provider in an isolated home. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2GoalDocument, deserializeV2DurableState, serializeV2DurableState, validateV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { implicitV3Requirements, normaliseProgramV3, storedProgramV3 } from '../src/workflow/program-v3.js';
import {
  FINDINGS_ANSWER, KNOWN_MAX, areaFor, dryVerdict, findingsToFixBlock, mergeRound, reviewRoundBlock, titleKey,
} from '../src/workflow/dry-loops.js';
import { applyContinueOffline, controlWatchEvent, readCondition, renderControlEvent, requestContinue } from '../src/workflow/gates-loops.js';
import { acceptV2Step, rerunV2Step } from '../src/workflow/cli-step-verbs.js';
import { acquireKernelLease } from '../src/workflow/v2-process.js';
import { addV3Steps, waitFactLines, waitFacts, waitV3Nodes } from '../src/workflow/cli-steps.js';
import { formatV2ProofLine, summarizeV2Result, validateV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import { programAdvisories } from '../src/workflow/action-validator.js';
import { notableWatchEvents, renderWatchEvent } from '../src/workflow/watch-cli.js';

const cli = resolve('bin/bullswarm.js');
const V3 = 'bullswarm.workflow.program.v3';
const eventsOf = (run, type) => readEvents(run.runDir).filter((event) => event.type === type);
const runtimeOf = (run, id) => run.state.actions.find((action) => action.id === id);
const node = (run, id) => run.state.controlNodes.find((record) => record.id === id);

const findingsAnswer = JSON.parse(JSON.stringify(FINDINGS_ANSWER));
const finding = (title, extra = {}) => ({ title, inScope: true, ...extra });

// --- 9.1 unit ----------------------------------------------------------------------

test('titleKey: case, spaces, a trailing dot and NFKC compare equal; merged titles are cut at 160', () => {
  assert.equal(titleKey('  Unary  minus binds LOOSER than ^.  '), 'unary minus binds looser than ^');
  assert.equal(titleKey('ｆｕｌｌ width'), 'full width');
  assert.equal(titleKey(''), '');
  const long = 'x'.repeat(300);
  const merged = mergeRound({ answers: [{ step: 'review', area: 0, value: { findings: [finding(long)] } }], round: 1 });
  assert.equal([...merged.known[0].title].length, 160);
});

test('mergeRound: new, repeated and reopened; one title from two reviewers counts once; blanks are ignored', () => {
  const round1 = mergeRound({
    answers: [
      { step: 'review-area-1', area: 0, value: { findings: [finding('Parser drops minus'), finding('Typo in docs', { inScope: false }), { title: '  ', inScope: true }] } },
      { step: 'review-area-2', area: 1, value: { findings: [finding('parser drops minus.'), finding('Join loses rows')] } },
    ],
    round: 1,
  });
  assert.deepEqual(round1.entry, { round: 1, reviewed: [0, 1], new: 2, reopened: 0, repeated: 1, outOfScope: 1, ignored: 1 });
  assert.deepEqual(round1.fix.map((item) => item.finding.title), ['Parser drops minus', 'Join loses rows']);
  assert.deepEqual(round1.known.map((entry) => [entry.title, entry.inScope, entry.area, entry.from]), [
    ['Parser drops minus', true, 0, 'review-area-1'], ['Typo in docs', false, 0, 'review-area-1'], ['Join loses rows', true, 1, 'review-area-2'],
  ]);
  const round2 = mergeRound({
    answers: [
      { step: 'review-area-1', area: 1, value: { findings: [finding('Join loses rows', { stillOpen: true }), finding('Typo in docs', { stillOpen: true }), finding('Brand new', { stillOpen: true })] } },
      { step: 'review-area-2', area: 0, value: undefined },
    ],
    known: round1.known, round: 2,
  });
  assert.deepEqual(round2.entry, { round: 2, reviewed: [1], new: 1, reopened: 1, repeated: 1, outOfScope: 0, ignored: 0 },
    'still open on a known in-scope title reopens it; on an out-of-scope one it repeats; on an unknown one it is new; no answer is no review');
  assert.deepEqual(round2.known.find((entry) => entry.title === 'Join loses rows').reopened, [2]);
  assert.deepEqual(round1.known.find((entry) => entry.title === 'Join loses rows').reopened, [], 'the input list is not changed');
});

test('mergeRound compares long titles whole: two that share a long beginning stay two; a repeat of either, or of its shown cut form, is known', () => {
  const prefix = `In src/query/engine.py, parse_expression() mishandles operator precedence when ${'a nested parenthesised '.repeat(4)}subexpression: `;
  const a = `${prefix}unary minus before ^ binds looser`;
  const b = `${prefix}NOT before = binds tighter`;
  const first = mergeRound({ round: 1, answers: [{ step: 'review', area: 0, value: { findings: [finding(a), finding(b)] } }] });
  assert.deepEqual([first.entry.new, first.entry.repeated, first.fix.length], [2, 0, 2]);
  assert.equal([...first.known[0].title].length, 160);
  assert.match(first.known[0].key, /^[0-9a-f]{16}$/);
  assert.notEqual(first.known[0].key, first.known[1].key);
  const again = mergeRound({ round: 2, known: first.known, answers: [{ step: 'review', area: 0, value: { findings: [finding(b), finding(first.known[0].title, { stillOpen: true })] } }] });
  assert.deepEqual([again.entry.new, again.entry.repeated, again.entry.reopened], [0, 1, 1]);
});

test('mergeRound keeps at most 500 known titles and counts the rest as dropped', () => {
  const many = Array.from({ length: KNOWN_MAX + 3 }, (_, index) => finding(`Problem ${index}`));
  const merged = mergeRound({ answers: [{ step: 'review', area: 0, value: { findings: many } }], round: 1 });
  assert.equal(merged.known.length, KNOWN_MAX);
  assert.equal(merged.knownDropped, 3);
  assert.equal(merged.entry.new, KNOWN_MAX + 3);
});

test('mergeRound: a title past the cap stays known by its key, so it is a repeat later and counted dropped once', () => {
  const many = Array.from({ length: KNOWN_MAX + 1 }, (_, index) => finding(`Problem ${index}`));
  const answers = [{ step: 'review', area: 0, value: { findings: many } }];
  const first = mergeRound({ answers, round: 1 });
  assert.deepEqual([first.knownDropped, first.dropped.length, first.dropped[0].round], [1, 1, 1]);
  assert.match(first.dropped[0].key, /^[0-9a-f]{16}$/);
  const second = mergeRound({ answers, known: first.known, knownDropped: first.knownDropped, dropped: first.dropped, round: 2 });
  assert.deepEqual([second.entry.new, second.entry.repeated, second.knownDropped, second.fix.length], [0, KNOWN_MAX + 1, 1, 0]);
});

test('mergeRound: two reviewers of one round disagree on scope: in scope wins in either order', () => {
  const out = { title: 'Unary minus precedence wrong', inScope: false };
  const inside = { title: 'unary minus precedence wrong.', inScope: true };
  for (const [a, b] of [[out, inside], [inside, out]]) {
    const merged = mergeRound({ round: 1, answers: [
      { step: 'review-area-1', area: 0, value: { findings: [a] } },
      { step: 'review-area-2', area: 1, value: { findings: [b] } },
    ] });
    assert.deepEqual([merged.entry.new, merged.entry.outOfScope, merged.entry.repeated, merged.fix.length, merged.known[0].inScope], [1, 0, 1, 1, true]);
    // Once in scope, a reviewer that still sees it in round 2 reopens it.
    const later = mergeRound({ round: 2, known: merged.known, answers: [{ step: 'review-area-1', area: 1, value: { findings: [{ ...inside, stillOpen: true }] } }] });
    assert.deepEqual([later.entry.reopened, later.fix.length], [1, 1]);
  }
});

test('mergeRound: a long title is the same finding as that title without its final period, in either order', () => {
  const dotted = `${'x'.repeat(160)}.`;
  const bare = 'x'.repeat(160);
  for (const [first, second] of [[dotted, bare], [bare, dotted]]) {
    const one = mergeRound({ round: 1, answers: [{ step: 'review', area: 0, value: { findings: [finding(first)] } }] });
    const two = mergeRound({ round: 2, known: one.known, answers: [{ step: 'review', area: 0, value: { findings: [finding(second)] } }] });
    assert.deepEqual([one.entry.new, two.entry.new, two.entry.repeated, two.fix.length], [1, 0, 1, 0]);
  }
});

test('mergeRound with reopen false (a loop with no fix step) reads stillOpen as a repeat', () => {
  const first = mergeRound({ round: 1, answers: [{ step: 'review', area: 0, value: { findings: [finding('P1')] } }] });
  const again = { step: 'review', area: 0, value: { findings: [finding('P1', { stillOpen: true })] } };
  assert.deepEqual(mergeRound({ round: 2, known: first.known, answers: [again], reopen: false }).entry, { round: 2, reviewed: [0], new: 0, reopened: 0, repeated: 1, outOfScope: 0, ignored: 0 });
});

test('dryVerdict: dry 1 and 2; an unvisited area or a round with no answer is not dry; a reopened finding counts as found', () => {
  const loop = (dry) => ({ until: { step: 'review', dry } });
  const record = (...rounds) => ({ findings: { rounds: rounds.map(([n, reviewed, found = 0, reopened = 0]) => ({ round: n, reviewed, new: found, reopened })) } });
  const plain = { areas: [] };
  const three = { areas: ['a', 'b', 'c'] };
  assert.equal(dryVerdict(loop(1), {}, plain), null);
  assert.equal(dryVerdict(loop(1), record([1, [0], 2], [2, [0]]), plain).dry, true);
  assert.equal(dryVerdict(loop(2), record([1, [0], 2], [2, [0]]), plain).dry, false);
  assert.equal(dryVerdict(loop(2), record([1, [0], 2], [2, [0]], [3, [0]]), plain).dry, true);
  assert.equal(dryVerdict(loop(1), record([1, [0], 2], [2, []]), plain).dry, false, 'a round nobody answered is not clean');
  const partial = dryVerdict(loop(1), record([1, [0, 1], 2], [2, [2, 0]]), three);
  assert.deepEqual([partial.dry, partial.unreviewed], [false, [1]]);
  assert.equal(dryVerdict(loop(1), record([1, [0, 1], 2], [2, [2, 0]], [3, [1, 2]]), three).dry, true);
  assert.equal(dryVerdict(loop(1), record([1, [0]], [2, [0], 0, 1]), plain).dry, false, 'round 2 reopened a finding');
});

test('areaFor: N=4, P=3 rotates through every area; P=N keeps each reviewer on its area; it depends only on the round', () => {
  const rounds = [1, 2, 3, 4].map((round) => [1, 2, 3].map((slot) => areaFor(slot, round, 3, 4)));
  assert.deepEqual(rounds, [[0, 1, 2], [3, 0, 1], [2, 3, 0], [1, 2, 3]]);
  assert.deepEqual([1, 2, 3].map((round) => areaFor(2, round, 3, 3)), [1, 1, 1]);
  assert.equal(areaFor(2, 3, 3, 4), areaFor(2, 3, 3, 4));
});

// A minimal state for the prompt blocks: a [review, fix] dry loop.
function blockState({ round = 1, areas = null, findings, answers = {} }) {
  const program = storedProgramV3({
    schemaVersion: V3,
    steps: [
      { id: 'build', lane: 'build', prompt: 'Build the acme parser.' },
      { id: 'review', dependsOn: ['build'], prompt: 'Review the acme parser.', answer: findingsAnswer, ...(areas ? { areas } : {}) },
      { id: 'fix', dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme parser.' },
    ],
    loops: [{ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry: 1, nonFunctional: false }, maxRounds: 4 }],
  });
  const attempts = [];
  const actions = program.actions.map((action) => {
    const value = answers[action.id];
    if (value === undefined) return { id: action.id, status: 'succeeded', attempts: 1 };
    attempts.push({ id: `att-${action.id}`, actionId: action.id, ordinal: 1, status: 'succeeded', answer: { ok: true, value, file: `/runs/acme/${action.id}.answer.json` } });
    return { id: action.id, status: 'succeeded', attempts: 1, answer: { attemptId: `att-${action.id}`, value } };
  });
  // A merged round names the attempt each reviewer answered in.
  const reviewers = program.actions.filter((action) => action.id.startsWith('review')).map((action) => action.id);
  const merged = findings && {
    ...findings,
    rounds: findings.rounds.map((entry) => entry.answers ? entry : {
      ...entry, answers: Object.fromEntries(reviewers.map((id) => [id, answers[id] === undefined ? null : `att-${id}`])),
    }),
  };
  return {
    program, actions, attempts,
    controlNodes: [{ id: 'harden', type: 'loop', status: 'pending', at: null, round, maxRounds: 4, ...(merged ? { findings: merged } : {}) }],
  };
}

test('reviewRoundBlock: the focus line only with areas, the known list only from round 2, out of scope marked', () => {
  const plainRound1 = reviewRoundBlock(blockState({}), { id: 'review' });
  assert.match(plainRound1, /## Review round \(loop harden, round 1 of 4\)/);
  assert.doesNotMatch(plainRound1, /Focus on this area/);
  assert.doesNotMatch(plainRound1, /Already known/);
  assert.match(plainRound1, /- title: one short line naming what is wrong and where, under 160 characters/);
  assert.doesNotMatch(plainRound1, /stillOpen|the list below/, 'round 1 has no known list to point at');
  const findings = {
    rounds: [{ round: 1, reviewed: [0, 1, 2], new: 1, reopened: 0, repeated: 0, outOfScope: 1, ignored: 0, fix: 'runs' }],
    known: [
      { title: 'Unary minus binds looser than ^ in expr.js', round: 1, area: 0, inScope: true, from: 'review-area-1', reopened: [] },
      { title: 'Error messages are not localised', round: 1, area: 1, inScope: false, from: 'review-area-2', reopened: [] },
    ],
    knownDropped: 0,
  };
  const state = blockState({ round: 2, areas: ['grammar and parsing', 'expressions and types', 'joins and subqueries', 'aggregates and ordering'], findings });
  const block = reviewRoundBlock(state, state.program.actions.find((action) => action.id === 'review-area-1'));
  assert.match(block, /Focus on this area: aggregates and ordering\. Other reviewers cover grammar and parsing and expressions and types this round;/);
  assert.match(block, /### Already known \(report one again only if it is still present\)/);
  assert.match(block, /- stillOpen: true only when you report a finding from the list below again/);
  assert.match(block, /Report one on the list again only when it is in scope and still present \(its fix did not hold\): use its exact title and stillOpen: true\./);
  assert.doesNotMatch(block, /do not report again|Report only findings/, 'a loop with a fixer never tells reviewers not to report a fix that did not hold');
  // Out-of-scope findings were never handed to the fixer, so they sit under their own heading.
  assert.match(block, /These were found in earlier rounds and handed to the fixer:\n- \[round 1 · grammar and parsing\] Unary minus binds looser than \^ in expr\.js\nThese were found in earlier rounds and recorded out of scope \(not fixed\):\n- \[round 1 · expressions and types\] Error messages are not localised\n/);
  assert.match(block, /Round 1's findings went to fix; check whether each fix holds\./);
  assert.equal(reviewRoundBlock(state, { id: 'fix' }), null, 'only reviewers get it');
  // A reviewer rerun in round 2 after round 2 merged is told only round 1's findings.
  const rerunState = blockState({ round: 2, findings: {
    rounds: [{ round: 1, reviewed: [0], new: 1, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs' }, { round: 2, reviewed: [0], new: 1, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs' }],
    known: [
      { title: 'Bug A in the acme lexer', round: 1, area: 0, inScope: true, from: 'review', reopened: [2] },
      { title: 'Bug B in the acme lexer', round: 2, area: 0, inScope: true, from: 'review', reopened: [] },
    ],
    knownDropped: 0,
  } });
  const rerunBlock = reviewRoundBlock(rerunState, { id: 'review' });
  assert.match(rerunBlock, /- \[round 1\] Bug A in the acme lexer/);
  assert.doesNotMatch(rerunBlock, /Bug B/, 'this round\'s own finding is not on the known list');
});

test('findingsToFixBlock lists the new and still-open findings in full, counts out-of-scope ones, and never reaches a reviewer', () => {
  const answer = { findings: [finding('Parser drops minus', { where: 'src/expr.js:88' }), finding('Typo', { inScope: false })] };
  const findings = {
    rounds: [{ round: 1, reviewed: [0], new: 1, reopened: 0, repeated: 0, outOfScope: 1, ignored: 0, fix: 'runs' }],
    known: [
      { title: 'Parser drops minus', round: 1, area: 0, inScope: true, from: 'review', reopened: [] },
      { title: 'Typo', round: 1, area: 0, inScope: false, from: 'review', reopened: [] },
    ],
    knownDropped: 0,
  };
  const state = blockState({ findings, answers: { review: answer, fix: { secret: 'the fixer says all is fine' } } });
  const block = findingsToFixBlock(state, { id: 'fix' });
  assert.match(block, /## Findings to fix \(loop harden, round 1 of 4\)/);
  assert.match(block, /The review found these in round 1 \(1 new\)\. Fix each one\./);
  assert.match(block, /1 out-of-scope finding was recorded and is not listed\./);
  assert.match(block, /1\. Parser drops minus\n {3}\{"title":"Parser drops minus","inScope":true,"where":"src\/expr\.js:88"\}/);
  assert.match(block, /Full answers: \/runs\/acme\/review\.answer\.json/);
  assert.doesNotMatch(block, /Typo\n/);
  assert.equal(findingsToFixBlock(state, { id: 'review' }), null);
  const review = reviewRoundBlock(blockState({ round: 2, findings, answers: { fix: { secret: 'the fixer says all is fine' } } }), { id: 'review' });
  assert.doesNotMatch(review, /the fixer says all is fine/, 'a reviewer never reads the fixer\'s answer, blindTo or not');
  const big = { findings: Array.from({ length: 40 }, (_, index) => finding(`Problem ${index}`, { detail: 'd'.repeat(2000) })) };
  const capped = findingsToFixBlock(blockState({ findings: { ...findings, known: [] }, answers: { review: big } }), { id: 'fix' });
  assert.ok(capped.length <= 24_000 + 2000, `the block is capped (${capped.length})`);
  assert.match(capped, /… \d+ more in the answer files below\./);
  assert.match(capped, /…"\}|…$/m, 'a long finding is cut at 1,500 characters');
});

test('findingsToFixBlock: a step that changes no file gets the list for reference; a files fixer is told leaving every finding fails it', () => {
  const answer = { findings: [finding('Parser drops minus')] };
  const findings = {
    rounds: [{ round: 1, reviewed: [0], new: 1, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs' }],
    known: [{ title: 'Parser drops minus', round: 1, area: 0, inScope: true, from: 'review', reopened: [] }],
    knownDropped: 0,
  };
  const state = blockState({ findings, answers: { review: answer } });
  const writer = findingsToFixBlock(state, state.program.actions.find((action) => action.id === 'fix'));
  assert.match(writer, /This step passes only when it changes a file: if you judge that none of them is a problem, change nothing and say why in your report; the step then stops as "no file changed" and goes to the caller\./);
  const check = findingsToFixBlock(state, { id: 'fix', lane: 'analyze' });
  assert.match(check, /^## Review findings \(loop harden, round 1 of 4\)\nThe review found these in round 1 \(1 new\)\. They are listed for reference: your step changes no file, so do what your prompt asks\./);
  assert.doesNotMatch(check, /Fix each one|Findings to fix/);
  assert.match(check, /1\. Parser drops minus/);
});

// --- 9.2 validation -----------------------------------------------------------------

// 0.38.12's rotation tests keep their areas as named: nonFunctional false
// (0.38.15 adds a non-functional area otherwise; tested on its own below).
// The 0.38.12 tests keep their semantics: no added non-functional area
// (0.38.15) and no yield stop (0.38.16) unless a test asks for one.
const dryProgram = ({ areas = null, areasPerRound, maxRounds = 4, dry = 1, order = ['review', 'fix'], review = {}, nonFunctional = false, yieldStop = false } = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'build', lane: 'build', prompt: 'Build the acme parser.' },
    {
      id: 'review', dependsOn: order[0] === 'review' ? ['build'] : ['fix'], blindTo: order[0] === 'review' ? ['build'] : ['fix'],
      prompt: 'Review the acme parser.', answer: findingsAnswer,
      ...(areas ? { areas } : {}), ...(areasPerRound !== undefined ? { areasPerRound } : {}), ...review,
    },
    { id: 'fix', dependsOn: order[0] === 'review' ? ['review'] : ['build'], lane: 'build', prompt: 'Fix the acme parser.' },
    { id: 'ship', dependsOn: ['harden'], prompt: 'Ship the acme parser.' },
  ],
  loops: [{ id: 'harden', steps: order, until: { step: 'review', dry, ...(nonFunctional === false ? { nonFunctional: false } : {}), ...(yieldStop === false ? { yield: false } : yieldStop === true ? {} : { yield: yieldStop }) }, maxRounds }],
});

const issuesOf = (program) => {
  try { normaliseProgramV3(program); return []; } catch (error) { return error.issues; }
};

test('the dry form is a loop until only; its range, its rounds and the findings schema are checked', () => {
  assert.deepEqual(issuesOf(dryProgram()), []);
  const gate = { ...dryProgram(), gates: [{ id: 'approve', dependsOn: ['harden'], when: { step: 'build', dry: 1 } }] };
  assert.ok(issuesOf(gate).includes('gates[0].when: the dry form ({step, dry}) is for a loop\'s until only'));
  assert.ok(issuesOf(dryProgram({ dry: 4 })).includes('loops[0].until.dry must be a whole number from 1 to 3'));
  assert.ok(issuesOf(dryProgram({ dry: 2, maxRounds: 1 })).includes('loops[0].until.dry is 2 but maxRounds is 1; the loop could never end dry'));
  const passedOnly = dryProgram({ review: { answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } } });
  assert.match(issuesOf(passedOnly).join('\n'), /^loops\[0\]\.until: the answer schema of step review must list findings, an array of objects whose required fields include title \(string\) and inScope \(boolean\); for example \{"type":"object"/m);
  const notRequired = dryProgram({ review: { answer: { ...findingsAnswer, properties: { findings: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, inScope: { type: 'boolean' } } } } } } } });
  assert.equal(issuesOf(notRequired).length, 1);
});

test('areas expand into area reviewers; references to the review are rewritten; the stored form normalises to itself', () => {
  const program = dryProgram({ areas: ['grammar', 'types', 'joins', 'aggregates'] });
  program.steps.push({ id: 'audit', dependsOn: ['harden'], route: { independentOf: ['build'] }, prompt: 'Audit the acme parser.' });
  const normal = normaliseProgramV3(program);
  const ids = normal.steps.map((step) => step.id);
  assert.deepEqual(ids, ['build', 'review-area-1', 'review-area-2', 'review-area-3', 'fix', 'ship', 'audit'], 'areasPerRound defaults to min(N, 3)');
  const reviewer = normal.steps[2];
  assert.deepEqual(reviewer.areaOf, { step: 'review', slot: 2, areas: ['grammar', 'types', 'joins', 'aggregates'] });
  assert.equal(reviewer.label, 'review · area reviewer 2 of 3');
  assert.deepEqual(reviewer.blindTo, ['build']);
  assert.deepEqual(normal.steps[4].dependsOn, ['review-area-1', 'review-area-2', 'review-area-3']);
  assert.deepEqual(normal.loops[0].steps, ['review-area-1', 'review-area-2', 'review-area-3', 'fix']);
  assert.deepEqual(normal.loops[0].until, { step: 'review', dry: 1, nonFunctional: false, yield: false });
  const all = normaliseProgramV3(dryProgram({ areas: ['grammar', 'types'] }));
  assert.equal(all.steps[1].label, 'review · grammar', 'with every area each round the label names it');
  const stored = storedProgramV3(program);
  assert.deepEqual(storedProgramV3(stored), stored);
  const edited = structuredClone(stored);
  edited.actions[2].prompt = 'Review something else.';
  assert.match(issuesOf(edited).join('\n'), /the area reviewers of review must be the same step but for their id and label; one was changed/);
});

test('areas: areasPerRound range, and refused on a step that is not a dry loop\'s review, on a build step, on an outward one', () => {
  assert.ok(issuesOf(dryProgram({ areas: ['a', 'b'], areasPerRound: 3 })).includes('steps[1].areasPerRound must be a whole number from 1 to 2 (the number of areas, at most 5)'));
  assert.ok(issuesOf(dryProgram({ areas: [] })).includes('steps[1].areas must be an array of 1 to 8 areas'));
  assert.ok(issuesOf(dryProgram({ areas: ['a', 'a'] })).includes('steps[1].areas names an area twice'));
  const notUntil = dryProgram();
  notUntil.steps[3] = { ...notUntil.steps[3], areas: ['a', 'b'] };
  assert.ok(issuesOf(notUntil).some((issue) => issue.startsWith('steps[3].areas: ship is not the until step of a loop that ends dry')));
  assert.ok(issuesOf(dryProgram({ areas: ['a', 'b'], review: { lane: 'build' } })).includes('steps[1].areas: an area review must be lane analyze; its reviewers run side by side and change no file'));
  assert.ok(issuesOf(dryProgram({ areas: ['a', 'b'], review: { deliverable: 'outward' } })).includes('steps[1].areas: an area review cannot have an outward deliverable'));
});

test('an authored id that collides with an area reviewer, and a step outside the loop that depends on the review group', () => {
  const clash = dryProgram({ areas: ['a', 'b', 'c'] });
  clash.steps.push({ id: 'review-area-2', prompt: 'Something else.' });
  assert.ok(issuesOf(clash).includes('id "review-area-2" is used twice; steps, gates and loops share one id space (review\'s areas use review-area-1 to review-area-3)'));
  const outside = dryProgram({ areas: ['a', 'b'] });
  outside.steps[3] = { ...outside.steps[3], dependsOn: ['review'] };
  assert.ok(issuesOf(outside).includes('ship depends on review inside loop harden; depend on the loop harden instead'));
  const gateOn = { ...dryProgram({ areas: ['a', 'b'] }), gates: [{ id: 'approve', dependsOn: ['harden'], when: { step: 'review', field: 'passed' } }] };
  assert.ok(issuesOf(gateOn).includes('gates[0].when: review is a group of area reviewers; only a loop\'s until may name it, in the dry form'));
});

test('areas that differ only in case or spacing name one area twice; a step on some of the reviewers is refused', () => {
  assert.ok(issuesOf(dryProgram({ areas: ['Grammar', 'grammar '] })).includes('steps[1].areas names an area twice'));
  const partial = dryProgram({ areas: ['grammar', 'types'] });
  partial.steps[2] = { ...partial.steps[2], dependsOn: ['review-area-1'] };
  assert.ok(issuesOf(partial).includes("fix depends on some of review's area reviewers; depend on review itself (all of review-area-1 to review-area-2)"));
  const whole = dryProgram({ areas: ['grammar', 'types'] });
  whole.steps[2] = { ...whole.steps[2], dependsOn: ['review-area-1', 'review-area-2'] };
  assert.deepEqual(issuesOf(whole), []);
});

test('rotating areas the loop could not cover within maxRounds are refused; a loop that leaves out some area reviewers says so; a later fixer in blindTo is refused with its reason', () => {
  const areas = (n) => Array.from({ length: n }, (_, index) => `area ${index + 1}`);
  assert.ok(issuesOf(dryProgram({ areas: areas(8), areasPerRound: 1, maxRounds: 5 })).includes("loops[0]: review's 8 areas take 8 rounds to review at 1 per round, but maxRounds is 5; the loop could never end dry. Raise areasPerRound to 2, or name fewer areas"));
  assert.ok(issuesOf(dryProgram({ areas: areas(6), areasPerRound: 2, maxRounds: 2 })).includes("loops[0]: review's 6 areas take 3 rounds to review at 2 per round, but maxRounds is 2; the loop could never end dry. Raise maxRounds to 3, or raise areasPerRound to 3, or name fewer areas"));
  assert.deepEqual(issuesOf(dryProgram({ areas: areas(6), areasPerRound: 2, maxRounds: 3 })), []);
  const partial = dryProgram({ areas: ['grammar', 'types'] });
  partial.loops[0].steps = ['review-area-1', 'fix'];
  const said = issuesOf(partial);
  assert.ok(said.includes('loops[0].steps must list every area reviewer of review (review-area-1 to review-area-2); it leaves out review-area-2. List review itself to include them all'), said.join('\n'));
  assert.ok(!said.some((issue) => issue.startsWith('loops[0].until.step must be one of')));
  const blind = dryProgram();
  blind.steps[1].blindTo = ['build', 'fix'];
  assert.deepEqual(issuesOf(blind), ['steps[1].blindTo names "fix", which runs after review in loop harden; a review of a loop that ends dry is never handed a fix step\'s output or answer, so remove fix from blindTo (keep the steps outside the loop that wrote the work)']);
});

test('a findings schema that allows no other field must list stillOpen when the loop has a fix step', () => {
  const closed = { type: 'object', required: ['findings'], additionalProperties: false, properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'inScope'], additionalProperties: false, properties: { title: { type: 'string' }, inScope: { type: 'boolean' } },
  } } } };
  assert.ok(issuesOf(dryProgram({ review: { answer: closed } })).includes('loops[0].until: the answer schema of step review must list stillOpen (boolean) among the properties of its findings, since they allow no other field: each review is told to mark a known finding that is still present with stillOpen: true'));
  const listed = JSON.parse(JSON.stringify(closed));
  listed.properties.findings.items.properties.stillOpen = { type: 'boolean' };
  assert.deepEqual(issuesOf(dryProgram({ review: { answer: listed } })), []);
  // A loop whose only step is the review never asks for stillOpen.
  const scan = dryProgram({ review: { answer: closed } });
  scan.loops[0].steps = ['review'];
  scan.steps[2].dependsOn = ['harden'];
  assert.deepEqual(issuesOf(scan), []);
});

// --- 9.3 the kernel (fake worker) ---------------------------------------------------

function v3Goal(cwd, goal = 'Harden the acme parser') {
  return createV2GoalDocument({
    goal, cwd, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 3 },
  });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-dry-loops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, workspace, bullswarmDir, goalDocument: v3Goal(workspace) };
}

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch with a fake worker. `script(actionId, turn, task)` returns
// {answer?, fail?, write?, raw?}; `turn` counts that step's worker runs from 1.
// A build step writes a file each turn so its deliverable is produced.
function fakeDispatch(script = () => ({}), { seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push({ actionId: options.action.id, task: options.taskText });
    return dispatchV2Action({
      ...options,
      pools: [connector('acme-pool')],
      dependencies: {
        watchOnce: async (_pool, task, targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn, task) ?? {};
          if (plan.delayMs) await new Promise((done) => setTimeout(done, plan.delayMs));
          if (options.action.lane === 'build') writeFileSync(join(targetDir, `${options.action.id}.txt`), `turn ${turn} ${Math.random()}\n`);
          writeFileSync(files.taskFile, task);
          const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
          if (named && plan.raw !== undefined) writeFileSync(named, plan.raw);
          else if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
          writeFileSync(files.outFile, `done ${options.action.id} turn ${turn}`);
          if (plan.fail) return { ok: false, why: 'the acme worker crashed', failureKind: plan.fail, meta: { exitCode: 1, wallSec: 1 } };
          const checked = opts.outputValidator ? opts.outputValidator('') : { ok: true };
          const structured = { ok: checked.ok, errors: checked.errors ?? [], ...(checked.value !== undefined ? { value: checked.value } : {}) };
          const usage = plan.tokens ? { tokens: plan.tokens } : null;
          return checked.ok
            ? { ok: true, why: 'structured output validated', structured, meta: { exitCode: 0, wallSec: 1, ...(usage ? { usage } : {}) } }
            : { ok: false, why: `structured output invalid: ${structured.errors.join('; ')}`, failureKind: 'schema', structured, meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
      },
    });
  };
}

const response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Dry loops.', program });

function launch(f, program, dispatch) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: response(program),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
  });
}

function resume(f, runId, dispatch) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
  });
}

function continueOffline(run, nodeId, rounds = null) {
  const intent = requestContinue(run.runDir, { nodeId, rounds });
  const lease = acquireKernelLease(run.runDir);
  try {
    const state = deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
    const outcome = applyContinueOffline(state, intent, { runDir: run.runDir, at: new Date().toISOString() });
    writeFileSync(join(run.runDir, 'state.json'), serializeV2DurableState(state));
    return { outcome, state };
  } finally { lease.release(); }
}

const workerRuns = (seen, id) => seen.filter((entry) => entry.actionId === id);
const reviewAnswers = (byTurn) => (id, turn) => (id.startsWith('review') ? { answer: byTurn(turn, id) } : {});

test('[review, fix], dry 1: round 1 finds two, the fix runs; round 2 repeats them, the fix is skipped and the loop ends dry', async (t) => {
  const f = fixture(t);
  const seen = [];
  const both = { findings: [finding('Unary minus binds looser than ^'), finding('LEFT JOIN drops NULL keys')] };
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(() => both), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'fix', 'review', 'ship']);
  assert.equal(workerRuns(seen, 'fix').length, 1, 'the fixer had exactly one worker run');
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.new, round.repeated, round.fix]), [[1, 2, 0, 'runs'], [2, 0, 2, 'skipped']]);
  const fix = runtimeOf(run, 'fix');
  assert.deepEqual([fix.status, fix.skipped.loopId, fix.skipped.round, fix.skipped.why], ['succeeded', 'harden', 2, 'nothing new to fix']);
  // Skipped in round 2, it still points at the output of its round-1 run.
  assert.equal(fix.outputFile, join(run.runDir, 'out-fix-attempt-1.md'));
  const findingsEvents = eventsOf(run, 'loop.findings').map((event) => [event.payload.round, event.payload.new, event.payload.fix, event.payload.dry]);
  assert.deepEqual(findingsEvents, [[1, 2, 'runs', false], [2, 0, 'skipped', true]]);
  const skippedEvent = eventsOf(run, 'action.finished').find((event) => event.payload.skipped);
  assert.deepEqual(skippedEvent.payload, { actionId: 'fix', status: 'succeeded', skipped: { loopId: 'harden', round: 2, why: 'nothing new to fix' } });
  const passed = eventsOf(run, 'loop.passed')[0].payload;
  assert.deepEqual([passed.reason, passed.round, passed.known], ['dry', 2, 2]);
  // The round-2 review task lists both known titles and no fixer output.
  const round2Review = workerRuns(seen, 'review')[1].task;
  assert.match(round2Review, /### Already known \(report one again only if it is still present\)/);
  assert.match(round2Review, /- \[round 1\] Unary minus binds looser than \^/);
  assert.match(round2Review, /- \[round 1\] LEFT JOIN drops NULL keys/);
  assert.doesNotMatch(round2Review, /done fix turn/);
  assert.doesNotMatch(round2Review, /## Previous round/);
  // The fixer's task carries the findings.
  assert.match(workerRuns(seen, 'fix')[0].task, /## Findings to fix \(loop harden, round 1 of 4\)\nThe review found these in round 1 \(2 new\)/);
  assert.equal(validateV2DurableState(run.state), true);
  // The result and its proof line.
  const loop = run.result.loops[0];
  assert.deepEqual([loop.outcome, loop.findings.dryIn, loop.findings.known], ['passed', 2, ['Unary minus binds looser than ^', 'LEFT JOIN drops NULL keys']]);
  assert.match(run.result.reason, /^all 4 steps succeeded · loop harden ended dry in round 2 of 4 \(2 findings\)$/, 'the fixer ran in round 1');
  const fixRow = run.result.actions.find((action) => action.id === 'fix');
  assert.deepEqual(fixRow.skipped, { loopId: 'harden', round: 2, why: 'nothing new to fix' });
  assert.equal(fixRow.outputFile, join(run.runDir, 'out-fix-attempt-1.md'));
  validateV2ResultEnvelope(run.result);
  // Its round-1 run had no check, so the proof line reads it as that run was.
  const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir });
  assert.doesNotMatch(formatV2ProofLine(summary), /skipped \(nothing to fix\)/);
  assert.match(formatV2ProofLine(summary), /unproven: .*\bfix\b/);
});

test('a fix that ran and passed its check, then was skipped, keeps that run\'s proof and output in the result', async (t) => {
  const f = fixture(t);
  const program = dryProgram();
  program.steps[2].evidence = [{ type: 'command', cmd: 'test -f fix.txt' }];
  const answers = (turn) => ({ findings: [finding('Parser drops minus')] });
  const run = await launch(f, program, fakeDispatch(reviewAnswers(answers)));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const fixRow = run.result.actions.find((action) => action.id === 'fix');
  assert.deepEqual([fixRow.skipped?.round, fixRow.outputFile, fixRow.evidenceResults?.[0]?.status], [2, join(run.runDir, 'out-fix-attempt-1.md'), 'passed']);
  const line = formatV2ProofLine(summarizeV2Result(run.result, run.state, { runDir: run.runDir }));
  assert.match(line, /^proof: 1 step proven \(command 1\) · /, line);
  assert.doesNotMatch(line, /skipped|unproven: .*\bfix\b/);
});

test('[fix, review], dry 1: round 1\'s fix is the writer; round 2\'s fix runs only because round 1 found something; a clean round ends it', async (t) => {
  const f = fixture(t);
  const seen = [];
  const answers = (turn) => ({ findings: turn === 1 ? [finding('Parser drops minus')] : [finding('Parser drops minus')] });
  const run = await launch(f, dryProgram({ order: ['fix', 'review'] }), fakeDispatch(reviewAnswers(answers), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'fix', 'review', 'fix', 'review', 'ship']);
  assert.equal(workerRuns(seen, 'fix').length, 2, 'no third fix');
  assert.deepEqual([node(run, 'harden').reason, node(run, 'harden').round], ['dry', 2]);
  assert.match(workerRuns(seen, 'fix')[1].task, /## Findings to fix \(loop harden, round 2 of 4\)\nThe review found these in round 1 \(1 new\)/);
  // Round 1 runs it before any review: it is told there is nothing to fix yet.
  assert.match(workerRuns(seen, 'fix')[0].task, /## Findings to fix \(loop harden, round 1 of 4\)\nNo review has run yet in this loop, so this round has no findings to fix: fix runs before review\./);
  assert.equal(validateV2DurableState(run.state), true);
});

test('dry 2: a clean round skips the fixer and starts another review round', async (t) => {
  const f = fixture(t);
  const seen = [];
  const answers = (turn) => ({ findings: turn === 1 ? [finding('Parser drops minus')] : [] });
  const run = await launch(f, dryProgram({ dry: 2 }), fakeDispatch(reviewAnswers(answers), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'fix', 'review', 'review', 'ship']);
  assert.deepEqual([node(run, 'harden').reason, node(run, 'harden').round], ['dry', 3]);
  assert.deepEqual(eventsOf(run, 'loop.round').map((event) => [event.payload.round, event.payload.found]), [[2, { new: 1, reopened: 0 }], [3, { new: 0, reopened: 0 }]]);
});

test('areas N=3, P=2: round 2 is clean but one area was not reviewed since the finding, so round 3 decides; each reviewer gets its area', async (t) => {
  const f = fixture(t);
  const seen = [];
  const answers = (turn, id) => ({ findings: turn === 1 && id === 'review-area-1' ? [finding('Parser drops minus')] : [] });
  const program = dryProgram({ areas: ['grammar', 'types', 'joins'], areasPerRound: 2, maxRounds: 3 });
  const run = await launch(f, program, fakeDispatch(reviewAnswers(answers), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const record = node(run, 'harden');
  assert.deepEqual([record.reason, record.round], ['dry', 3]);
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.reviewed, round.new, round.fix]), [
    [1, [0, 1], 1, 'runs'], [2, [2, 0], 0, 'skipped'], [3, [1, 2], 0, 'skipped'],
  ]);
  assert.equal(workerRuns(seen, 'fix').length, 1);
  const focus = (id, k) => /Focus on this area: (\w+)\./.exec(workerRuns(seen, id)[k].task)[1];
  assert.deepEqual([0, 1, 2].map((k) => [focus('review-area-1', k), focus('review-area-2', k)]), [['grammar', 'types'], ['joins', 'grammar'], ['types', 'joins']]);
  const round2 = eventsOf(run, 'loop.findings')[1].payload;
  assert.deepEqual([round2.dry, round2.unreviewed], [false, ['types']]);
  assert.equal(validateV2DurableState(run.state), true);
});

test('stillOpen: a reopened finding keeps the loop going and reaches the fixer again', async (t) => {
  const f = fixture(t);
  const seen = [];
  const answers = (turn) => ({ findings: turn === 1 ? [finding('Parser drops minus')] : turn === 2 ? [finding('Parser drops minus', { stillOpen: true })] : [finding('Parser drops minus')] });
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(answers), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(workerRuns(seen, 'fix').length, 2);
  assert.match(workerRuns(seen, 'fix')[1].task, /found these in round 2 \(0 new, 1 still open\)[\s\S]*1\. \(still open\) Parser drops minus/);
  assert.deepEqual(node(run, 'harden').findings.known[0].reopened, [2]);
  assert.deepEqual([node(run, 'harden').reason, node(run, 'harden').round], ['dry', 3]);
});

test('a reviewer that fails twice blocks the loop; accepting it leaves its area unreviewed, so the loop cannot end dry on it', async (t) => {
  const f = fixture(t);
  const program = dryProgram({ areas: ['grammar', 'types'], maxRounds: 2 });
  const failing = fakeDispatch((id, turn) => (id === 'review-area-2' && turn <= 2 ? { fail: 'provider' } : id.startsWith('review') ? { answer: { findings: [] } } : {}));
  const run = await launch(f, program, failing);
  assert.equal(run.result.status, 'partial');
  assert.equal(node(run, 'harden').status, 'blocked');
  assert.equal(runtimeOf(run, 'fix').status, 'blocked');
  const refused = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review', waitMs: 0 });
  assert.match(refused.why ?? '', /review is a group of area reviewers \(review-area-1 to review-area-2\); name one of them/);
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review-area-2', reason: 'the acme types reviewer is down', waitMs: 0 });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch((id) => (id.startsWith('review') ? { answer: { findings: [] } } : {}), { seen }));
  const record = node(done, 'harden');
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.reviewed]), [[1, [0]], [2, [0, 1]]], 'round 1 reviewed grammar only');
  assert.deepEqual([record.status, record.reason], ['passed', 'dry'], 'round 2 reviewed both areas');
  assert.equal(workerRuns(seen, 'fix').length, 0);
  assert.equal(done.result.status, 'completed', done.result.reason);
});

test('a malformed review answer gets the schema retry on the same pool, then the round merges', async (t) => {
  const f = fixture(t);
  const seen = [];
  const script = (id, turn) => {
    if (id !== 'review') return {};
    if (turn === 1) return { answer: { findings: [{ title: 'No inScope here' }] } };
    return { answer: { findings: [] } };
  };
  const run = await launch(f, dryProgram(), fakeDispatch(script, { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const attempts = run.state.attempts.filter((attempt) => attempt.actionId === 'review');
  assert.equal(attempts.length, 2, 'the correction runs inside the same dispatch');
  assert.equal(attempts[0].failureKind, 'schema');
  assert.equal(attempts[0].pool, attempts[1].pool);
  assert.deepEqual([node(run, 'harden').reason, node(run, 'harden').round], ['dry', 1]);
});

test('a loop step beside the review (lint on the build) still running: a dry round waits for it before the loop passes; its failure blocks the loop', async (t) => {
  const withLint = () => {
    const program = dryProgram();
    program.steps.splice(3, 0, { id: 'lint', dependsOn: ['build'], prompt: 'Lint the acme parser.' });
    program.loops[0].steps = ['review', 'fix', 'lint'];
    return program;
  };
  const f = fixture(t);
  const run = await launch(f, withLint(), fakeDispatch((id) => (id === 'lint' ? { delayMs: 400 } : id === 'review' ? { answer: { findings: [] } } : {})));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const events = readEvents(run.runDir);
  const at = (match) => events.findIndex(match);
  const lintDone = at((event) => event.type === 'action.finished' && event.payload.actionId === 'lint');
  const passed = at((event) => event.type === 'loop.passed');
  const shipStarted = at((event) => event.type === 'action.started' && event.payload.actionId === 'ship');
  assert.ok(lintDone >= 0 && lintDone < passed, 'the loop passes only after lint finished');
  assert.ok(passed < shipStarted, 'ship starts after the loop passed');
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason, node(run, 'harden').round], ['passed', 'dry', 1]);
  assert.equal(eventsOf(run, 'loop.passed')[0].payload.reason, 'dry');

  const g = fixture(t);
  const failed = await launch(g, withLint(), fakeDispatch((id) => (id === 'lint' ? { delayMs: 200, fail: 'provider' } : id === 'review' ? { answer: { findings: [] } } : {})));
  assert.equal(failed.result.status, 'partial');
  assert.equal(node(failed, 'harden').status, 'blocked', 'a dry review does not pass a loop whose step failed');
  assert.notEqual(failed.result.loops[0].outcome, 'passed');
  assert.notEqual(runtimeOf(failed, 'ship').status, 'succeeded');
  assert.equal(eventsOf(failed, 'loop.passed').length, 0);
});

test('a step beside the review fails before the review answers clean: the round still merges, the fixer never runs, and the loop passes dry once the step is accepted', async (t) => {
  const f = fixture(t);
  const program = dryProgram();
  program.steps.splice(3, 0, { id: 'lint', dependsOn: ['build'], retry: 0, prompt: 'Lint the acme parser.' });
  program.loops[0].steps = ['review', 'fix', 'lint'];
  const seen = [];
  const run = await launch(f, program, fakeDispatch((id) => (id === 'lint' ? { fail: 'provider' } : id === 'review' ? { delayMs: 400, answer: { findings: [] } } : {}), { seen }));
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'lint'], 'no fixer on a clean round');
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason], ['blocked', 'lint failed']);
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.new, round.fix]), [[1, 0, 'skipped']]);
  assert.deepEqual(runtimeOf(run, 'fix').skipped?.round, 1);
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'lint', reason: 'acme lint is flaky', waitMs: 0 });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const done = await resume(f, run.runId, fakeDispatch(() => ({}), { seen }));
  assert.deepEqual([node(done, 'harden').status, node(done, 'harden').reason], ['passed', 'dry']);
  assert.equal(done.state.attempts.filter((attempt) => attempt.actionId === 'fix').length, 0, 'the record says skipped and nothing ran');
  assert.deepEqual(done.result.actions.find((action) => action.id === 'fix').skipped, { loopId: 'harden', round: 1, why: 'nothing new to fix' });
});

test('a reviewer rerun after its loop passed dry: a new finding is learned and fixed, a clean answer leaves the loop passed', async (t) => {
  const f = fixture(t);
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(() => ({ findings: [] }))));
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason], ['passed', 'dry']);
  // The fixer never ran, so the reason does not call it succeeded.
  assert.match(run.result.reason, /^all 4 steps finished: 3 succeeded, 1 skipped \(nothing to fix\): fix · loop harden ended dry in round 1 of 4 \(0 findings\)$/);
  // Rerun with a clean answer: still dry, the fixer is skipped again, no second pass event.
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review', waitMs: 0 })).status, 'applied');
  const seenClean = [];
  const clean = await resume(f, run.runId, fakeDispatch(reviewAnswers(() => ({ findings: [] })), { seen: seenClean }));
  assert.deepEqual(seenClean.map((entry) => entry.actionId), ['review']);
  assert.deepEqual([node(clean, 'harden').status, node(clean, 'harden').reason, node(clean, 'harden').round], ['passed', 'dry', 1]);
  assert.equal(eventsOf(clean, 'loop.passed').length, 1);
  // Rerun with a new finding: the loop learns it, the fixer runs with it, and a clean round 2 ends it dry.
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review', waitMs: 0 })).status, 'applied');
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch((id, turn) => (id === 'review' ? { answer: { findings: turn === 1 ? [finding('Unary minus binds looser than ^')] : [] } } : {}), { seen }));
  assert.deepEqual(seen.map((entry) => entry.actionId), ['review', 'fix', 'review', 'ship']);
  assert.match(workerRuns(seen, 'fix')[0].task, /## Findings to fix \(loop harden, round 1 of 4\)\nThe review found these in round 1 \(1 new\)[\s\S]*1\. Unary minus binds looser than \^/);
  const record = node(done, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.new, round.fix]), [[1, 1, 'runs'], [2, 0, 'skipped']]);
  assert.equal(readCondition(done.state, { step: 'review', dry: 1 }), true, 'the record and its verdict agree');
  assert.deepEqual([done.result.loops[0].findings.dryIn, done.result.loops[0].findings.known], [2, ['Unary minus binds looser than ^']]);
  assert.equal(validateV2DurableState(done.state), true);
});

test('a rerun of the work a passed dry loop reviewed: the review\'s new finding reaches the fixer and the record', async (t) => {
  const f = fixture(t);
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(() => ({ findings: [] }))));
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason], ['passed', 'dry']);
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'build', waitMs: 0 })).status, 'applied');
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch((id, turn) => (id === 'review' ? { answer: { findings: turn === 1 ? [finding('New bug after the acme rebuild')] : [] } } : {}), { seen }));
  assert.deepEqual(seen.map((entry) => entry.actionId).slice(0, 4), ['build', 'review', 'fix', 'review']);
  assert.match(workerRuns(seen, 'fix')[0].task, /## Findings to fix[\s\S]*New bug after the acme rebuild/);
  const record = node(done, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  assert.match(done.result.reason, /loop harden ended dry in round 2 of 4 \(1 finding\)$/);
  assert.deepEqual(done.result.loops[0].findings.known, ['New bug after the acme rebuild']);
});

test('a loop ended by `workflow continue`, then its review (or the build upstream) rerun: the new finding reaches the fixer, not the old one', async (t) => {
  for (const rerunId of ['review', 'build']) {
    const f = fixture(t);
    const run = await launch(f, dryProgram({ maxRounds: 1 }), fakeDispatch(reviewAnswers(() => ({ findings: [finding('Old bug one')] }))));
    assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason], ['waiting', 'out-of-rounds']);
    continueOffline(run, 'harden');
    const ended = await resume(f, run.runId, fakeDispatch(() => ({})));
    assert.deepEqual([node(ended, 'harden').status, node(ended, 'harden').reason], ['passed', 'continued']);
    assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: rerunId, waitMs: 0 })).status, 'applied');
    const seen = [];
    const done = await resume(f, run.runId, fakeDispatch(reviewAnswers(() => ({ findings: [finding('Brand new bug two')] })), { seen }));
    const fixTask = workerRuns(seen, 'fix')[0].task;
    assert.match(fixTask, /1\. Brand new bug two/, `${rerunId}: the fixer is handed the new finding`);
    assert.doesNotMatch(fixTask, /Old bug one/, `${rerunId}: and not the one already fixed`);
    assert.match(fixTask, /answer-review-attempt-2\.json/, `${rerunId}: from the new review attempt`);
    const record = node(done, 'harden');
    // The round is merged again from the list before it, as for a loop that passed dry.
    assert.deepEqual(record.findings.known.map((item) => item.title), ['Brand new bug two']);
    // Out of rounds again (one round only): back with the caller, not silently passed.
    assert.deepEqual([record.status, record.reason], ['waiting', 'out-of-rounds']);
    // What ran behind the loop when it was continued was made before this fix.
    assert.equal(runtimeOf(done, 'ship').status, 'pending', `${rerunId}: ship waits for the loop again`);
    assert.equal(validateV2DurableState(done.state), true);
  }
});

test('a loop that passed in its last round and is reopened by a rerun: the steps behind it rerun after the new fix, not before it', async (t) => {
  // Passed dry in round 2 of 2, so no next round exists to rerun `ship`.
  const f = fixture(t);
  const seen = [];
  const run = await launch(f, dryProgram({ maxRounds: 2 }), fakeDispatch(reviewAnswers((turn) => ({ findings: turn === 1 ? [finding('Old bug one')] : [] })), { seen }));
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason, node(run, 'harden').round], ['passed', 'dry', 2]);
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'build', waitMs: 0 })).status, 'applied');
  const mid = await resume(f, run.runId, fakeDispatch(reviewAnswers(() => ({ findings: [finding('Brand new bug two')] })), { seen }));
  assert.deepEqual([node(mid, 'harden').status, node(mid, 'harden').reason], ['waiting', 'out-of-rounds']);
  assert.equal(runtimeOf(mid, 'ship').status, 'pending', 'ship made from the old result is reset while the loop is open');
  assert.equal(mid.state.lifecycle.status, 'waiting');
  continueOffline(mid, 'harden');
  const done = await resume(f, run.runId, fakeDispatch(() => ({}), { seen }));
  assert.equal(done.result.status, 'completed');
  const order = seen.map((entry) => entry.actionId);
  assert.equal(order.filter((id) => id === 'ship').length, 2, order.join(','));
  assert.equal(order.at(-1), 'ship', `ship reruns after the new fix: ${order.join(',')}`);
  assert.ok(order.lastIndexOf('ship') > order.lastIndexOf('fix'));
  assert.equal(validateV2DurableState(done.state), true);
});

test('a failed fixer the caller accepted, then a clean round that skips it: the accept stays on the step and in the result, and `wait` says so', async (t) => {
  {
    const f = fixture(t);
    // The fixer fails twice (its retry too); the review of the first round finds a bug, the next is clean.
    const runs = {};
    const script = (id) => {
      runs[id] = (runs[id] ?? 0) + 1; // counted across the resume, which restarts the dispatcher's own turns
      if (id === 'review') return { answer: { findings: runs[id] === 1 ? [finding('A bug')] : [] } };
      return id === 'fix' && runs[id] <= 2 ? { fail: 'provider' } : {};
    };
    const run = await launch(f, dryProgram({ maxRounds: 3 }), fakeDispatch(script));
    assert.equal(runtimeOf(run, 'fix').status, 'failed');
    const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'fix', reason: 'not a problem', waitMs: 0 });
    assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
    const done = await resume(f, run.runId, fakeDispatch(script));
    assert.equal(runs.review, 2);
    assert.equal(runs.fix, 2, 'the fixer never ran again');
    const fix = runtimeOf(done, 'fix');
    assert.deepEqual([fix.status, fix.skipped?.round, fix.acceptance?.reason, fix.acceptance?.attemptId], ['succeeded', 2, 'not a problem', 'fix-2']);
    assert.equal(done.result.status, 'completed');
    assert.match(done.result.reason, /1 step accepted by choice/);
    assert.doesNotMatch(done.result.reason, /skipped \(nothing to fix\)/, 'the accepted fixer is not reported as having nothing to fix');
    const proof = formatV2ProofLine(summarizeV2Result(done.result, done.state, { runDir: done.runDir }));
    assert.match(proof, /1 accepted by choice: fix/);
    assert.doesNotMatch(proof, /skipped \(nothing to fix\)/);
    assert.deepEqual(done.result.actions.find((action) => action.id === 'fix').acceptance.reason, 'not a problem');
    const [wait] = waitFacts(done.state, ['fix']).nodes;
    assert.match(waitFactLines(wait)[0], /^\S+ fix accepted by choice after provider · not a problem/);
    assert.equal(wait.deliverable.produced, null, 'no worker produced anything for it');
    assert.equal(validateV2DurableState(done.state), true);
    assert.doesNotThrow(() => validateV2ResultEnvelope(done.result));
  }
});

test('the accept is dropped when the fixer runs again after it: a fixer that ran and succeeded is not "accepted"', async (t) => {
  const f = fixture(t);
  const runs = {};
  const script = (id) => {
    runs[id] = (runs[id] ?? 0) + 1;
    if (id === 'review') return { answer: { findings: runs[id] <= 2 ? [finding(`Bug ${runs[id]}`)] : [] } };
    return id === 'fix' && runs[id] <= 2 ? { fail: 'provider' } : {};
  };
  const run = await launch(f, dryProgram({ maxRounds: 4 }), fakeDispatch(script));
  assert.equal((await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'fix', reason: 'not a problem', waitMs: 0 })).status, 'applied');
  const done = await resume(f, run.runId, fakeDispatch(script));
  const fix = runtimeOf(done, 'fix');
  // Round 2 found another bug, so the fixer ran again (its third attempt) and then round 3 was clean.
  assert.equal(done.state.attempts.filter((attempt) => attempt.actionId === 'fix').length >= 3, true);
  assert.equal(fix.acceptance, undefined);
  assert.doesNotMatch(done.result.reason, /accepted by choice/);
  assert.equal(validateV2DurableState(done.state), true);
});

test('the build inside the loop ([build, review, fix]): it runs in round 1 only, the fixer alone gets the findings, and a test run before the review still reruns', async (t) => {
  const f = fixture(t);
  const program = dryProgram({ maxRounds: 4 });
  program.loops[0].steps = ['build', 'review', 'fix'];
  const seen = [];
  const run = await launch(f, program, fakeDispatch(reviewAnswers((turn) => ({ findings: turn === 1 ? [finding('A is broken')] : [] })), { seen }));
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'fix', 'review', 'ship'], 'no second build');
  assert.match(workerRuns(seen, 'fix')[0].task, /## Findings to fix[\s\S]*1\. A is broken/);
  assert.doesNotMatch(workerRuns(seen, 'build')[0].task, /A is broken/);
  const roundTwo = workerRuns(seen, 'review')[1].task;
  assert.match(roundTwo, /Round 1's findings went to fix; check whether each fix holds\./, 'the reviewer is not told the build took them');
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  const build = runtimeOf(run, 'build');
  assert.deepEqual([build.status, build.skipped?.round, build.skipped?.loopId], ['succeeded', 2, 'harden']);
  assert.match(build.skipped.why, /findings go to the fix after it/);
  assert.equal(run.state.attempts.filter((attempt) => attempt.actionId === 'build').length, 1);
  assert.equal(validateV2DurableState(run.state), true);
  // A read-only step before the review is not a fixer: it runs again after each fix.
  const checked = dryProgram({ maxRounds: 4 });
  checked.steps.splice(1, 0, { id: 'check', dependsOn: ['build'], lane: 'analyze', prompt: 'Run the acme tests.' });
  checked.steps.find((step) => step.id === 'review').dependsOn = ['check'];
  checked.loops[0].steps = ['build', 'check', 'review', 'fix'];
  const seenChecked = [];
  const second = await launch(fixture(t), checked, fakeDispatch(reviewAnswers((turn) => ({ findings: turn === 1 ? [finding('B is broken')] : [] })), { seen: seenChecked }));
  assert.deepEqual(seenChecked.map((entry) => entry.actionId), ['build', 'check', 'review', 'fix', 'check', 'review', 'ship']);
  assert.deepEqual([node(second, 'harden').status, node(second, 'harden').reason], ['passed', 'dry']);
  assert.equal(validateV2DurableState(second.state), true);
});

test('[fix, review] out of rounds: the last round\'s findings are not fixed yet, and the watch and the note say so', async (t) => {
  const f = fixture(t);
  const seen = [];
  const run = await launch(f, dryProgram({ order: ['fix', 'review'], maxRounds: 1 }), fakeDispatch(reviewAnswers(() => ({ findings: [finding('Parser drops minus')] })), { seen }));
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'fix', 'review']);
  const note = run.state.lifecycle.waitingFor.find((item) => item.id === 'harden').note;
  assert.match(note, /round 1 found 1 new, not fixed yet, the fix runs first in another round/);
  assert.doesNotMatch(note, /its fix was not reviewed/);
  const lines = readEvents(run.runDir).filter((event) => ['loop.findings', 'loop.out-of-rounds'].includes(event.type))
    .map((event) => renderControlEvent(controlWatchEvent(event, { token: 'acme01' })));
  assert.match(lines[0], /· 1 known · fix needs another round$/);
  assert.match(lines[1], /round 1 found 1 new \(not fixed yet, the fix runs first in another round\)/);
  // Mid-loop the same order says the fix runs next round.
  const mid = controlWatchEvent({ type: 'loop.findings', payload: { loopId: 'harden', round: 1, of: 3, new: 1, known: 1, fix: 'next' } }, { token: 'acme01' });
  assert.match(renderControlEvent(mid), /fix runs next round$/);
});

test('a reviewer rerun after its round merged: the round is merged again, so the record, the fixer and the waiting note agree', async (t) => {
  const f = fixture(t);
  const program = dryProgram({ areas: ['grammar', 'types'], maxRounds: 1 });
  const failing = fakeDispatch((id, turn) => (id === 'review-area-2' && turn <= 2 ? { fail: 'provider' } : id.startsWith('review') ? { answer: { findings: [] } } : {}));
  const run = await launch(f, program, failing);
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review-area-2', reason: 'the acme types reviewer is down', waitMs: 0 });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const parked = await resume(f, run.runId, fakeDispatch((id) => (id.startsWith('review') ? { answer: { findings: [] } } : {})));
  const before = node(parked, 'harden');
  assert.deepEqual([before.status, before.reason, before.findings.rounds[0].answers['review-area-2']], ['waiting', 'out-of-rounds', null]);
  const rerun = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review-area-2', waitMs: 0 });
  assert.equal(rerun.status, 'applied', JSON.stringify(rerun));
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch((id) => (id === 'review-area-2' ? { answer: { findings: [finding('Types: CAST drops precision')] } } : {}), { seen }));
  const record = node(done, 'harden');
  const round = record.findings.rounds[0];
  assert.deepEqual([round.round, round.reviewed, round.new, round.fix], [1, [0, 1], 1, 'runs'], 'the record learns the new answer');
  assert.deepEqual(record.findings.known.map((entry) => entry.title), ['Types: CAST drops precision']);
  assert.equal(workerRuns(seen, 'fix').length, 1);
  assert.match(workerRuns(seen, 'fix')[0].task, /The review found these in round 1 \(1 new\)[\s\S]*1\. \[types\] Types: CAST drops precision/);
  assert.equal(record.status, 'waiting');
  const note = done.state.lifecycle.waitingFor.find((item) => item.id === 'harden').note;
  assert.match(note, /round 1 found 1 new and its fix was not reviewed/);
  assert.doesNotMatch(note, /found nothing new/);
  assert.equal(validateV2DurableState(done.state), true);
});

test('a fix step before the review is never handed an older round\'s answer of a reviewer accepted without one', async (t) => {
  const f = fixture(t);
  const program = dryProgram({ areas: ['grammar', 'types'], order: ['fix', 'review'], maxRounds: 4 });
  // Round 1: types finds C. Round 2: grammar finds G, types fails twice (accepted).
  const script = (id, turn) => {
    if (id === 'review-area-1') return { answer: { findings: turn === 2 ? [finding('Grammar: G')] : [] } };
    if (id === 'review-area-2') return turn === 1 ? { answer: { findings: [finding('Types: C', { stillOpen: true })] } } : turn <= 3 ? { fail: 'provider' } : { answer: { findings: [] } };
    return {};
  };
  const seen = [];
  const run = await launch(f, program, fakeDispatch(script, { seen }));
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review-area-2', reason: 'the acme types reviewer is down', waitMs: 0 });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const done = await resume(f, run.runId, fakeDispatch(script, { seen }));
  const round2 = node(done, 'harden').findings.rounds.find((entry) => entry.round === 2);
  assert.deepEqual([round2.reviewed, round2.new, round2.reopened, round2.answers['review-area-2']], [[0], 1, 0, null]);
  const third = workerRuns(seen, 'fix').find((entry) => /round 3 of 4/.test(entry.task)).task;
  assert.match(third, /The review found these in round 2 \(1 new\)\./);
  assert.doesNotMatch(third, /Types: C|\(still open\)|review-area-2-attempt-1/);
  assert.match(third, /- review-area-2: no answer in round 2 \(accepted without one\)/);
});

test('a fixer that ran in round 1 and was skipped in round 2 keeps its checked answer in the result', async (t) => {
  const f = fixture(t);
  const program = dryProgram();
  program.steps[2].answer = { type: 'object', required: ['fixed'], properties: { fixed: { type: 'array', items: { type: 'string' } } } };
  const run = await launch(f, program, fakeDispatch((id, turn) => (id === 'review' ? { answer: { findings: turn === 1 ? [finding('Parser drops minus')] : [] } } : id === 'fix' ? { answer: { fixed: ['Parser drops minus'] } } : {})));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const fix = runtimeOf(run, 'fix');
  assert.deepEqual([fix.skipped?.round, fix.answer?.value], [2, { fixed: ['Parser drops minus'] }]);
  assert.deepEqual(run.result.actions.find((action) => action.id === 'fix').answer?.value, { fixed: ['Parser drops minus'] });
});

test('out of rounds: the event says what the last round found; continue --rounds 1 runs one more review and keeps the known list', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const script = (id) => {
    if (id !== 'review') return {};
    calls += 1;
    return { answer: { findings: calls <= 2 ? [finding(`Problem ${calls}`)] : [] } };
  };
  const run = await launch(f, dryProgram({ maxRounds: 2 }), fakeDispatch(script));
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['harden']);
  assert.match(run.waiting[0].note, /out of rounds \(2 of 2\); the review did not run dry; round 2 found 1 new and its fix was not reviewed/);
  const event = eventsOf(run, 'loop.out-of-rounds')[0].payload;
  assert.deepEqual(event.findings, { lastNew: { round: 2, new: 1, reopened: 0, fix: 'runs' }, known: 2, unreviewed: [], perRound: [1, 1] });
  const line = renderControlEvent(controlWatchEvent(eventsOf(run, 'loop.out-of-rounds')[0], { token: 'acme01' }));
  assert.match(line, /loop harden out of rounds \(2 of 2\) · round 2 found 1 new \(its fix was not reviewed\) · new per round 1, 1 · continue: bullswarm workflow continue acme01 harden --rounds <n>/);
  continueOffline(run, 'harden', 1);
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch(script, { seen }));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['review', 'ship'], 'one more review round, no fix');
  const record = node(done, 'harden');
  assert.deepEqual([record.reason, record.round, record.findings.known.length], ['dry', 3, 2]);
  assert.match(seen[0].task, /- \[round 1\] Problem 1\n- \[round 2\] Problem 2/);
});

test('resume after the merge is saved: no second merge, the fixer runs once', async (t) => {
  const f = fixture(t);
  // The kernel is signalled the moment the fixer's first dispatch starts, and
  // that worker does not finish (retry 0: nothing runs it again in place).
  const answers = reviewAnswers(() => ({ findings: [finding('Parser drops minus')] }));
  const dispatch = fakeDispatch((id, turn) => (id === 'fix' ? { fail: 'provider' } : answers(id, turn)));
  const dying = (options) => {
    if (options.action.id === 'fix') process.emit('SIGTERM');
    return dispatch(options);
  };
  const program = dryProgram();
  program.steps[2] = { ...program.steps[2], retry: 0 };
  const first = await launch(f, program, dying);
  assert.equal(first.state.lifecycle.status, 'interrupted');
  const record = first.state.controlNodes.find((entry) => entry.id === 'harden');
  assert.equal(record.findings.rounds.length, 1, 'merged once before the fixer');
  const seen = [];
  const done = await resume(f, first.runId, fakeDispatch(answers, { seen }));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.equal(workerRuns(seen, 'fix').length, 1);
  assert.equal(workerRuns(seen, 'review').length, 1, 'round 1 is not reviewed again');
  assert.deepEqual(node(done, 'harden').findings.rounds.map((round) => round.round), [1, 2]);
  assert.equal(eventsOf(done, 'loop.findings').length, 2);
});

test('state checks: findings and skipped validate, bad shapes are refused, and a rerun of a skipped step clears the marker', async (t) => {
  const f = fixture(t);
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(() => ({ findings: [] }))));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(validateV2DurableState(run.state), true);
  const refused = (mutate, pattern) => {
    const copy = structuredClone(run.state);
    mutate(copy);
    assert.throws(() => validateV2DurableState(copy), pattern);
  };
  refused((s) => { s.controlNodes[0].findings.rounds[0].round = 7; }, /findings\.rounds\[0\]\.round must be after the round before it and not past the loop's round/);
  refused((s) => { s.controlNodes[0].findings.rounds[0].reviewed = [3]; }, /reviewed\[0\] must be an area index from 0 to 0/);
  refused((s) => { s.controlNodes[0].findings.extra = 1; }, /findings\.extra is not allowed/);
  refused((s) => { runtimeOf({ state: s }, 'fix').status = 'failed'; }, /skipped is only for a succeeded step/);
  refused((s) => { runtimeOf({ state: s }, 'fix').skipped.round = 0; }, /skipped\.round must be a positive integer/);
  assert.ok(runtimeOf(run, 'fix').skipped);
  const rerun = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'fix', waitMs: 0 });
  assert.equal(rerun.status, 'applied', JSON.stringify(rerun));
  const after = deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  assert.equal(after.actions.find((action) => action.id === 'fix').skipped, undefined);
  assert.equal(validateV2DurableState(after), true);
});

test('old until forms run exactly as before: a field loop never skips and writes no findings', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'fix', lane: 'build', prompt: 'Fix the acme widget.' },
      { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme widget.', answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
    ],
    loops: [{ id: 'polish', steps: ['fix', 'check'], until: { step: 'check', field: 'passed' }, maxRounds: 3 }],
  };
  const run = await launch(f, program, fakeDispatch((id, turn) => (id === 'check' ? { answer: { passed: turn >= 2 } } : {}), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['fix', 'check', 'fix', 'check']);
  assert.equal(node(run, 'polish').findings, undefined);
  assert.equal(node(run, 'polish').reason, undefined);
  assert.equal(run.state.actions.some((action) => action.skipped), false);
  assert.equal(eventsOf(run, 'loop.findings').length, 0);
  assert.deepEqual(run.result.loops, [{ id: 'polish', outcome: 'passed', rounds: 2, maxRounds: 3 }]);
  assert.match(seen[2].task, /## Previous round \(loop polish, now round 2 of 3\)/);
  assert.match(seen[2].task, /check\.passed is true did not hold after round 1/);
});

test('workflow add: a fragment adds a dry loop with areas; a step on an existing group is told to depend on the loop; blocks cannot name a reviewer', async (t) => {
  const f = fixture(t);
  const run = await launch(f, dryProgram({ areas: ['grammar', 'types'] }), fakeDispatch(reviewAnswers(() => ({ findings: [] }))));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const fragment = {
    steps: [
      { id: 'audit', dependsOn: ['harden'], prompt: 'Audit the acme docs.', answer: findingsAnswer, areas: ['docs', 'tests'] },
      { id: 'patch', dependsOn: ['audit'], lane: 'build', prompt: 'Patch the acme docs.' },
    ],
    loops: [{ id: 'tidy', steps: ['audit', 'patch'], until: { step: 'audit', dry: 1 }, maxRounds: 2 }],
  };
  const added = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.runId, fragment, waitMs: 0 });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  assert.deepEqual([added.steps, added.control], [['audit-area-1', 'audit-area-2', 'patch'], ['tidy']]);
  const seen = [];
  const done = await resume(f, run.runId, fakeDispatch((id) => (id.startsWith('audit') ? { answer: { findings: [] } } : {}), { seen }));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual([node(done, 'tidy').status, node(done, 'tidy').reason], ['passed', 'dry']);
  assert.deepEqual(seen.map((entry) => entry.actionId).sort(), ['audit-area-1', 'audit-area-2']);
  const late = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.runId, fragment: { steps: [{ id: 'late', dependsOn: ['review'], prompt: 'Late.' }] }, waitMs: 0 });
  assert.equal(late.status, 'rejected');
  assert.ok(late.issues.includes('late depends on review inside loop harden; depend on the loop harden instead'), JSON.stringify(late.issues));
  const blocks = await addV3Steps({ bullswarmDir: f.bullswarmDir, token: run.runId, fragment: { steps: [{ id: 'pre', prompt: 'Before.' }], blocks: { pre: ['review-area-1'] } }, waitMs: 0 });
  assert.equal(blocks.status, 'rejected');
  assert.match(blocks.issues.join('\n'), /fragment\.blocks\.pre names step review-area-1/);
});

test('workflow wait on the group id waits for every reviewer; the loop fact carries its findings', async (t) => {
  const f = fixture(t);
  const run = await launch(f, dryProgram({ areas: ['grammar', 'types'] }), fakeDispatch(reviewAnswers(() => ({ findings: [] }))));
  const waited = await waitV3Nodes({ bullswarmDir: f.bullswarmDir, token: run.runId, ids: ['review', 'harden'], pollMs: 10 });
  assert.equal(waited.status, 'settled', JSON.stringify(waited));
  assert.deepEqual(waited.nodes.map((fact) => fact.id), ['review-area-1', 'review-area-2', 'harden']);
  assert.deepEqual(waited.nodes[2].findings, { known: [], outOfScope: [], rounds: [0], dryIn: 1 });
});

test('workflow wait on a loop out of rounds because of a still-open finding says so in its findings line', async (t) => {
  const f = fixture(t);
  const answers = (turn) => ({ findings: [finding('Parser drops minus', turn === 1 ? {} : { stillOpen: true })] });
  const run = await launch(f, dryProgram({ maxRounds: 2 }), fakeDispatch(reviewAnswers(answers)));
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').reason], ['waiting', 'out-of-rounds']);
  const waited = await waitV3Nodes({ bullswarmDir: f.bullswarmDir, token: run.runId, ids: ['harden'], pollMs: 10 });
  assert.deepEqual(waited.nodes[0].findings, { known: ['Parser drops minus'], outOfScope: [], rounds: [1, 0], stillOpen: [0, 1] });
  assert.equal(waitFactLines(waited.nodes[0])[1], '  findings 1 known · new per round 1, 0 · still open per round 0, 1');
  // The result carries the same counts once the caller ends the loop.
  continueOffline(run, 'harden');
  const done = await resume(f, run.runId, fakeDispatch(() => ({})));
  assert.deepEqual(done.result.loops[0].findings.stillOpen, [0, 1]);
  validateV2ResultEnvelope(done.result);
});

test('watch lines: the findings line, the skipped line and the dry verdict line', () => {
  const findings = controlWatchEvent({ type: 'loop.findings', payload: { loopId: 'harden', round: 2, of: 4, new: 3, reopened: 1, repeated: 4, outOfScope: 0, known: 12, areas: ['grammar and parsing', 'expressions and types'], unreviewed: [], fix: 'runs' } }, { token: 'acme01' });
  assert.equal(renderControlEvent(findings), '· loop harden round 2 of 4 · review (grammar and parsing, expressions and types): 3 new, 1 still open, 4 repeated · 12 known · fix runs');
  const dry = controlWatchEvent({ type: 'loop.passed', payload: { loopId: 'harden', round: 3, of: 4, reason: 'dry', known: 12, areas: true } }, { token: 'acme01' });
  assert.match(renderControlEvent(dry), /loop harden dry in round 3 of 4 · no new findings, every area reviewed · 12 found in all$/);
  assert.equal(renderWatchEvent({ type: 'action.finished', actionId: 'fix', status: 'succeeded', skipped: { loopId: 'harden', round: 3, why: 'nothing new to fix' } }),
    '· fix skipped · loop harden round 3: nothing new to fix');
});

test('a loop whose only step is the review ends dry though a reviewer still sees a finding: nothing fixes it, so stillOpen is not asked for', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'build', lane: 'build', prompt: 'Build the acme parser.' },
      { id: 'review', dependsOn: ['build'], prompt: 'Review the acme parser.', answer: findingsAnswer },
      { id: 'ship', dependsOn: ['scan'], prompt: 'Ship the acme parser.' },
    ],
    loops: [{ id: 'scan', steps: ['review'], until: { step: 'review', dry: 1 }, maxRounds: 3 }],
  };
  const answers = (turn) => ({ findings: [finding('P1', turn > 1 ? { stillOpen: true } : {})] });
  const run = await launch(f, program, fakeDispatch(reviewAnswers(answers), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const record = node(run, 'scan');
  assert.deepEqual(record.findings.rounds.map((round) => [round.round, round.new, round.reopened, round.repeated, round.fix]), [[1, 1, 0, 0, 'none'], [2, 0, 0, 1, 'none']]);
  assert.deepEqual([record.reason, record.round], ['dry', 2]);
  const task = workerRuns(seen, 'review')[1].task;
  assert.doesNotMatch(task, /stillOpen|handed to the fixer/);
  assert.match(task, /These were found in earlier rounds:\n- \[round 1\] P1/);
  assert.match(task, /ignoring case, extra spaces and a final period/);
});

test('a fixer blind to the review is told its findings are not listed, and gets no answer file', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram();
  program.steps[2].blindTo = ['review'];
  const answers = (turn) => ({ findings: turn === 1 ? [finding('Secret detail XYZZY', { where: 'src/acme.js:9' })] : [] });
  await launch(f, program, fakeDispatch(reviewAnswers(answers), { seen }));
  const task = workerRuns(seen, 'fix')[0].task;
  assert.doesNotMatch(task, /XYZZY|answer-review-attempt/);
  assert.match(task, /## Findings to fix \(loop harden, round 1 of 4\)\nYou are blind to review \(blindTo\), so its findings are not listed here/);
});

test('[fix, review] without blindTo: the reviewer is never handed the fixer\'s output', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram({ order: ['fix', 'review'] });
  delete program.steps[1].blindTo;
  const answers = (turn) => ({ findings: turn === 1 ? [finding('P1')] : [] });
  await launch(f, program, fakeDispatch(reviewAnswers(answers), { seen }));
  for (const { task } of workerRuns(seen, 'review')) {
    assert.match(task, /Dependency artifacts:\n\[\{"actionId":"fix","artifactIds":\[\],"blind":true\}\]/);
    assert.match(task, /You judge the work of fix without its own account of it/);
    assert.doesNotMatch(task, /out-fix-attempt/);
  }
});

test('a kernel that stops right after the next round\'s rerun is saved: the round number and the skip are in that save', async (t) => {
  const f = fixture(t);
  const program = dryProgram({ order: ['fix', 'review'], dry: 2 });
  const clean = reviewAnswers(() => ({ findings: [] }));
  let stopped = false;
  await assert.rejects(runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: response(program),
    onEvent: (event) => {
      if (!stopped && event.type === 'program.revised' && event.payload?.requestId?.startsWith('loop-harden-round-2')) {
        stopped = true;
        throw new Error('acme kernel stopped');
      }
    },
    dependencies: { refreshPools: async () => null, dispatchV2Action: fakeDispatch(clean), controlPollMs: 20 },
  }), /acme kernel stopped/);
  const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
  const saved = deserializeV2DurableState(readFileSync(join(f.bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
  const record = saved.controlNodes.find((entry) => entry.id === 'harden');
  const fix = saved.actions.find((action) => action.id === 'fix');
  assert.deepEqual([record.round, fix.status, fix.skipped?.round], [2, 'succeeded', 2]);
  const seen = [];
  const done = await resume(f, runId, fakeDispatch(clean, { seen }));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['review', 'ship'], 'the skipped fixer never runs');
  assert.match(workerRuns(seen, 'review')[0].task, /## Review round \(loop harden, round 2 of 4\)/);
});

test('after a skipped round the fixer\'s Previous round block says it was skipped; a replayed finish keeps its duration', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram({ areas: ['grammar', 'types', 'joins'], areasPerRound: 2, maxRounds: 4 });
  const answers = (turn, id) => ({ findings: id === 'review-area-1' && turn === 1 ? [finding('P1')] : id === 'review-area-1' && turn === 3 ? [finding('P2')] : [] });
  const run = await launch(f, program, fakeDispatch(reviewAnswers(answers), { seen }));
  assert.deepEqual(node(run, 'harden').findings.rounds.map((round) => [round.round, round.fix]), [[1, 'runs'], [2, 'skipped'], [3, 'runs'], [4, 'skipped']]);
  const round3 = workerRuns(seen, 'fix')[1].task;
  assert.match(round3, /What its steps produced in round 2:[\s\S]*\n- fix: skipped in round 2 \(nothing new to fix\)\n/);
  assert.doesNotMatch(round3, /fix \(attempt fix-1/);
  // The watch replays fix's round-1 finish with that attempt's own duration.
  const { notable } = notableWatchEvents({ events: readEvents(run.runDir), state: run.state, runDir: run.runDir });
  const finishes = notable.filter((event) => event.type === 'action.finished' && event.actionId === 'fix' && !event.skipped);
  assert.equal(finishes.length, 2);
  assert.ok(finishes.every((event) => Number.isInteger(event.durationSec)), JSON.stringify(finishes));
});

// --- 9.5 advisories -----------------------------------------------------------------

test('a reviewer rerun in round 2 after the round merged is not told that round\'s findings were known, so the fixer gets them', async (t) => {
  const f = fixture(t);
  const seen = [];
  const script = (id, turn, task) => {
    if (id === 'review') {
      if (turn === 1) return { answer: { findings: [finding('Bug A in the acme lexer')] } };
      // A reviewer that follows its prompt leaves out what the known list names.
      return { answer: { findings: /- \[round \d+\] Bug B in the acme lexer/.test(task) ? [] : [finding('Bug B in the acme lexer')] } };
    }
    return id === 'fix' && (turn === 2 || turn === 3) ? { fail: 'provider' } : {};
  };
  const dispatch = fakeDispatch(script, { seen });
  const run = await launch(f, dryProgram(), dispatch);
  assert.deepEqual([node(run, 'harden').status, node(run, 'harden').round], ['blocked', 2]);
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: run.runId, stepId: 'review', waitMs: 0 })).status, 'applied');
  const done = await resume(f, run.runId, dispatch);
  const rerunTask = workerRuns(seen, 'review')[2].task;
  assert.match(rerunTask, /- \[round 1\] Bug A in the acme lexer/);
  assert.doesNotMatch(rerunTask, /- \[round 2\] Bug B/);
  const record = node(done, 'harden');
  assert.deepEqual(record.findings.known.map((entry) => entry.title), ['Bug A in the acme lexer', 'Bug B in the acme lexer']);
  assert.deepEqual(record.findings.rounds.find((round) => round.round === 2).new, 1);
  assert.match(workerRuns(seen, 'fix').at(-1).task, /Bug B in the acme lexer/, 'the fixer that finally succeeds is handed Bug B');
});

test('a read-only step in the loop (a test run) is no fixer: the reviewer that depends on it is not blinded to it', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram();
  program.steps.splice(1, 0, { id: 'tests', dependsOn: ['build'], prompt: 'Run the acme tests.', answer: { type: 'object', required: ['failing'], properties: { failing: { type: 'array' } } } });
  program.steps.find((step) => step.id === 'review').dependsOn = ['build', 'tests'];
  program.loops[0].steps = ['tests', 'review', 'fix'];
  assert.deepEqual(issuesOf(program), []);
  const run = await launch(f, program, fakeDispatch((id) => (id === 'tests' ? { answer: { failing: ['acme_test_minus'] } } : id === 'review' ? { answer: { findings: [] } } : {}), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const task = workerRuns(seen, 'review')[0].task;
  assert.doesNotMatch(task, /"actionId":"tests","artifactIds":\[\],"blind":true/);
  assert.match(task, /"actionId":"tests","outputFile":/);
  assert.match(task, /You judge the work of build without its own account of it/, 'only its own blindTo');
});

test('a "find until dry" loop with a read-only step beside the review asks no stillOpen and ends dry', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram({ maxRounds: 3 });
  program.steps = program.steps.filter((step) => step.id !== 'fix');
  program.steps.splice(2, 0, { id: 'lint', dependsOn: ['build'], prompt: 'Lint the acme parser.' });
  program.loops[0].steps = ['review', 'lint'];
  const script = (id, turn, task) => {
    if (id !== 'review') return {};
    if (turn === 1) return { answer: { findings: [finding('Parser drops minus')] } };
    // A reviewer asked for stillOpen reports the unfixed finding again.
    return { answer: { findings: /stillOpen: true/.test(task) ? [finding('Parser drops minus', { stillOpen: true })] : [] } };
  };
  const run = await launch(f, program, fakeDispatch(script, { seen }));
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  const round2 = workerRuns(seen, 'review')[1].task;
  assert.match(round2, /### Already known \(do not report again\)\nThese were found in earlier rounds:\n- \[round 1\] Parser drops minus/);
  assert.doesNotMatch(round2, /went to lint|handed to the fixer|stillOpen/);
  assert.equal(eventsOf(run, 'loop.findings')[0].payload.fix, 'none', 'the watch says no fix runs');
});

const adviceOf = (program) => programAdvisories(storedProgramV3(program)).map((item) => item.code);

test('advisories: a long loop until passed, a dry loop too short for its areas, one area, and a compile-only check', () => {
  const passedLoop = (maxRounds) => ({
    schemaVersion: V3,
    steps: [
      { id: 'fix', lane: 'build', prompt: 'Fix the acme parser.' },
      { id: 'review', dependsOn: ['fix'], prompt: 'Review it.', answer: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
    ],
    loops: [{ id: 'harden', steps: ['fix', 'review'], until: { step: 'review', field: 'passed' }, maxRounds }],
  });
  assert.deepEqual(adviceOf(passedLoop(2)), [], 'two rounds: the caller planned to take over');
  const long = programAdvisories(storedProgramV3(passedLoop(4)));
  assert.deepEqual(long.map((item) => item.code), ['review-loop-until-passed']);
  assert.match(long[0].message, /^loop harden ends only when review\.passed is true; a strict review of a large change rarely passes outright/);
  const short = programAdvisories(storedProgramV3(dryProgram({ areas: ['a', 'b', 'c', 'd'], areasPerRound: 3, maxRounds: 2 })));
  assert.deepEqual(short.map((item) => item.code), ['dry-loop-too-short']);
  assert.equal(short[0].message, 'loop harden can end dry only if no round finds anything: after a round with findings it needs 2 clean rounds to review all 4 areas again; raise maxRounds to 3 or areasPerRound to 4');
  assert.deepEqual(adviceOf(dryProgram({ areas: ['a', 'b', 'c', 'd'], areasPerRound: 3, maxRounds: 3 })), []);
  // Every area is reviewed each round: the clean rounds come from until.dry, and the advice names it.
  const byDry = programAdvisories(storedProgramV3(dryProgram({ areas: ['a', 'b', 'c'], dry: 2, maxRounds: 2 })));
  assert.equal(byDry[0].message, 'loop harden can end dry only if no round finds anything: after a round with findings it needs 2 clean rounds (until.dry is 2); raise maxRounds to 3 or lower until.dry to 1');
  const both = programAdvisories(storedProgramV3(dryProgram({ areas: ['a', 'b', 'c', 'd'], areasPerRound: 2, dry: 2, maxRounds: 2 })));
  assert.equal(both[0].message, 'loop harden can end dry only if no round finds anything: after a round with findings it needs 2 clean rounds (until.dry is 2, and reviewing all 4 areas again takes as many); raise maxRounds to 3');
  assert.deepEqual(adviceOf(dryProgram({ areas: ['grammar'] })), ['review-one-area']);
  const compile = (cmd) => adviceOf({
    schemaVersion: V3,
    steps: [{ id: 'tests', lane: 'build', files: ['test_acme.py'], prompt: 'Write the acme tests.', evidence: [{ type: 'command', cmd }] }],
  });
  assert.deepEqual(compile('python -m py_compile test_acme.py'), ['compile-check-only']);
  assert.deepEqual(compile('cd /work/acme && node --check test_acme.py'), ['compile-check-only']);
  assert.deepEqual(compile('python -m py_compile test_acme.py && python -m pytest test_acme.py'), []);
  assert.deepEqual(compile('python -m pytest test_acme.py'), []);
});


test('advisory dry-loop-fix-first: a fix before the review, on work built outside the loop', () => {
  const advice = programAdvisories(storedProgramV3(dryProgram({ order: ['fix', 'review'] })));
  assert.deepEqual(advice.map((item) => [item.code, item.actionId]), [['dry-loop-fix-first', 'fix']]);
  assert.match(advice[0].message, /^loop harden runs fix before review, so in round 1 no review has run yet and fix has nothing to fix\. To fix what the review finds, put the review first/);
  assert.deepEqual(adviceOf(dryProgram()), []);
  // A writer before the review (nothing built outside the loop) is the draft pattern: silent.
  const writer = dryProgram({ order: ['fix', 'review'] });
  writer.steps[2].dependsOn = [];
  assert.deepEqual(adviceOf(writer), []);
  // A read-only lint on the build beside the review fixes nothing: silent.
  const lint = dryProgram();
  lint.steps.splice(3, 0, { id: 'lint', dependsOn: ['build'], prompt: 'Lint the acme parser.' });
  lint.loops[0].steps = ['review', 'fix', 'lint'];
  assert.deepEqual(adviceOf(lint), []);
  // The advice keeps every loop step: the review first, then the rest.
  const three = dryProgram({ order: ['fix', 'review'] });
  three.steps.splice(3, 0, { id: 'lint', dependsOn: ['build'], prompt: 'Lint the acme parser.' });
  three.loops[0].steps = ['fix', 'review', 'lint'];
  const advice3 = programAdvisories(storedProgramV3(three));
  assert.deepEqual(advice3.map((item) => [item.code, item.actionId]), [['dry-loop-fix-first', 'fix']]);
  assert.match(advice3[0].message, /steps \[review, fix, lint\] \(patterns\.md 6\)$/);
});
// --- 9.4 end to end (echo provider, isolated home) ------------------------------------

function echoRun(t, program) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-dry-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'acme');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  const echo = JSON.parse(readFileSync(new URL('../src/providers/echo/connector.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify(echo));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } }));
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify(program));
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0', BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const bullswarm = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, cwd: workspace, timeout: 90_000 });
  return { home, workspace, plan, bullswarm };
}

const echoProgram = ({ areas, areasPerRound, maxRounds }) => ({
  schemaVersion: V3,
  steps: [
    { id: 'build', lane: 'build', prompt: 'Build the acme parser. TOUCH:built.txt' },
    {
      id: 'review', dependsOn: ['build'], blindTo: ['build'], areas, ...(areasPerRound ? { areasPerRound } : {}),
      prompt: 'Review the acme parser. ANSWER_JSON:{"findings":[{"title":"acme-parser-drops-minus","inScope":true}]}',
      answer: findingsAnswer,
    },
    { id: 'fix', dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme parser. TOUCH:fixed.txt' },
  ],
  loops: [{ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry: 1, nonFunctional: false }, maxRounds }],
});

test('end to end with the echo worker: the finding is carried forward, the fixer runs once, the loop ends dry in round 2', { timeout: 120_000 }, (t) => {
  const e = echoRun(t, echoProgram({ areas: ['grammar and parsing', 'joins'], maxRounds: 3 }));
  const goal = e.bullswarm('workflow', 'goal', 'Harden the acme parser', '--cwd', e.workspace, '--program', e.plan, '--foreground', '--json');
  assert.equal(goal.status, 0, goal.stdout + goal.stderr);
  const launched = JSON.parse(goal.stdout);
  const token = launched.shortId ?? launched.runId;
  const result = JSON.parse(e.bullswarm('workflow', 'runs', 'result', token, '--json').stdout);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.loops[0].outcome, 'passed');
  assert.equal(result.loops[0].findings.dryIn, 2);
  assert.deepEqual(result.loops[0].findings.known, ['acme-parser-drops-minus'], 'two reviewers, one finding');
  const fix = result.actions.find((action) => action.id === 'fix');
  assert.deepEqual(fix.skipped, { loopId: 'harden', round: 2, why: 'nothing new to fix' });
  const runDir = join(e.home, 'workflows', result.runId);
  const state = deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.attempts.filter((attempt) => attempt.actionId === 'fix').length, 1, 'the fixer ran once');
  for (const id of ['review-area-1', 'review-area-2']) {
    const tasks = state.attempts.filter((attempt) => attempt.actionId === id).map((attempt) => readFileSync(attempt.taskFile, 'utf8'));
    assert.equal(tasks.length, 2);
    assert.doesNotMatch(tasks[0], /Already known/);
    assert.match(tasks[1], /### Already known \(report one again only if it is still present\)\nThese were found in earlier rounds and handed to the fixer:\n- \[round 1 · grammar and parsing\] acme-parser-drops-minus/);
  }
  const fixTask = readFileSync(state.attempts.find((attempt) => attempt.actionId === 'fix').taskFile, 'utf8');
  assert.match(fixTask, /## Findings to fix \(loop harden, round 1 of 3\)/);
  const watch = e.bullswarm('workflow', 'watch', token, '--next', '--after', '0');
  assert.match(watch.stdout, /· loop harden round 1 of 3 · review \(grammar and parsing, joins\): 1 new, 1 repeated · 1 known · fix runs/);
  assert.match(watch.stdout, /· fix skipped · loop harden round 2: nothing new to fix/);
  assert.match(watch.stdout, /loop harden dry in round 2 of 3 · no new findings, every area reviewed · 1 found in all/);
});

test('end to end with rotating areas: round 2 is clean but one area was not reviewed, the run parks; one more round ends it dry', { timeout: 120_000 }, (t) => {
  const e = echoRun(t, echoProgram({ areas: ['grammar', 'types', 'joins'], areasPerRound: 2, maxRounds: 2 }));
  const goal = e.bullswarm('workflow', 'goal', 'Harden the acme parser', '--cwd', e.workspace, '--program', e.plan, '--foreground');
  assert.equal(goal.status, 0, goal.stdout + goal.stderr);
  assert.match(goal.stdout, /outcome: waiting/);
  assert.match(goal.stdout, /waiting: loop harden · out of rounds \(2 of 2\); the review did not run dry; round 2 found nothing new; not reviewed since the last finding: types/);
  const token = /continue (\S+) harden/.exec(goal.stdout)[1];
  const more = e.bullswarm('workflow', 'continue', token, 'harden', '--rounds', '1', '--wait', '60');
  assert.equal(more.status, 0, more.stdout + more.stderr);
  const waited = e.bullswarm('workflow', 'wait', token, 'harden', '--timeout', '60');
  assert.match(waited.stdout, /loop harden ended dry in round 3 of 3 \(1 finding\)/);
  const result = JSON.parse(e.bullswarm('workflow', 'runs', 'result', token, '--json').stdout);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.loops[0].findings.dryIn, 3);
});

test('end to end: a fixer the loop skipped is reported skipped by `workflow wait` and `runs show`, never as having produced files', { timeout: 120_000 }, (t) => {
  const program = echoProgram({ areas: ['grammar and parsing', 'joins'], maxRounds: 3 });
  program.steps.find((step) => step.id === 'review').prompt = 'Review the acme parser. ANSWER_JSON:{"findings":[]}';
  const e = echoRun(t, program);
  const goal = e.bullswarm('workflow', 'goal', 'Harden the acme parser', '--cwd', e.workspace, '--program', e.plan, '--foreground', '--json');
  assert.equal(goal.status, 0, goal.stdout + goal.stderr);
  const token = JSON.parse(goal.stdout).shortId;
  const wait = e.bullswarm('workflow', 'wait', token, 'fix');
  assert.match(wait.stdout, /^✓ fix skipped \(nothing to fix, loop harden round 1\)/);
  assert.doesNotMatch(wait.stdout, /produced/);
  const fact = JSON.parse(e.bullswarm('workflow', 'wait', token, 'fix', '--json').stdout).nodes[0];
  assert.deepEqual(fact.skipped, { loopId: 'harden', round: 1, why: 'nothing new to fix' });
  assert.equal(fact.deliverable.produced, null, 'no worker ran, so nothing was produced');
  assert.equal(fact.attempts, 0);
  const show = e.bullswarm('workflow', 'runs', 'show', token).stdout;
  assert.match(show, /^# actions  4\/4 succeeded \(1 skipped, nothing to fix: fix\)$/m);
  assert.match(show, /^  fix\s+build\/medium\s+skipped \(nothing to fix\)$/m);
});

// --- a passed loop reopened while a step behind it runs, or behind a gate -----------

// Start the run without awaiting it; resolves once `ship` has a worker running.
async function startUntilShip(f, program, script, seen) {
  const running = launch(f, program, fakeDispatch(script, { seen }));
  for (let i = 0; i < 200 && !seen.some((entry) => entry.actionId === 'ship'); i += 1) await new Promise((done) => setTimeout(done, 25));
  assert.ok(seen.some((entry) => entry.actionId === 'ship'), 'ship started');
  const token = readdirSync(join(f.bullswarmDir, 'workflows')).find((name) => !name.includes('.'));
  return { running, token };
}

test('a reviewer rerun with a new finding while `ship` still runs behind a dry loop waits for ship, then reruns it; the kernel does not crash', { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const seen = [];
  let reviews = 0;
  const script = (id) => {
    if (id === 'review') { reviews += 1; return { answer: { findings: reviews === 1 ? [finding('Old bug one')] : reviews === 3 ? [finding('Brand new bug two')] : [] } }; }
    return id === 'ship' ? { delayMs: 800 } : {};
  };
  const { running, token } = await startUntilShip(f, dryProgram({ maxRounds: 2 }), script, seen);
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'review', waitMs: 3000 })).status, 'applied');
  const run = await running;
  assert.notEqual(run.state.lifecycle.status, 'interrupted');
  // The new finding was merged once ship had finished, and ship was reset with the loop reopened.
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'fix', 'review', 'ship', 'review', 'fix']);
  assert.equal(runtimeOf(run, 'ship').status, 'pending', 'ship made from the old result waits for the loop');
  assert.equal(run.state.lifecycle.status, 'waiting');
  continueOffline(run, 'harden');
  const done = await resume(f, run.runId, fakeDispatch(script, { seen }));
  assert.equal(done.result.status, 'completed');
  assert.equal(workerRuns(seen, 'ship').length, 2, 'ship ran again after the new fix');
  assert.equal(seen.at(-1).actionId, 'ship');
});

test('a loop the caller continued, then a reviewer rerun with a finding while `ship` runs: the same wait, no crash', { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const seen = [];
  let reviews = 0;
  const script = (id) => {
    if (id === 'review') { reviews += 1; return { answer: { findings: reviews === 1 ? [finding('Old bug one')] : [finding('Brand new bug two')] } }; }
    return id === 'ship' ? { delayMs: 800 } : {};
  };
  const first = await launch(f, dryProgram({ maxRounds: 1 }), fakeDispatch(script, { seen }));
  assert.equal(node(first, 'harden').status, 'waiting');
  continueOffline(first, 'harden');
  const resumed = resume(f, first.runId, fakeDispatch(script, { seen }));
  for (let i = 0; i < 200 && !seen.some((entry) => entry.actionId === 'ship'); i += 1) await new Promise((done) => setTimeout(done, 25));
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: first.runId, stepId: 'review', waitMs: 3000 })).status, 'applied');
  const run = await resumed;
  assert.notEqual(run.state.lifecycle.status, 'interrupted');
  assert.equal(node(run, 'harden').status, 'waiting');
  assert.equal(runtimeOf(run, 'ship').status, 'pending');
});

test('a gate between the loop and a later step: reopening the loop makes the gate wait again and reruns the step behind it', { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = dryProgram({ maxRounds: 4 });
  program.steps.find((step) => step.id === 'ship').dependsOn = ['approve'];
  program.gates = [{ id: 'approve', dependsOn: ['harden'] }];
  let phase = 1;
  const script = reviewAnswers((turn) => ({ findings: phase === 1 ? (turn === 1 ? [finding('Old bug one')] : []) : [finding('Brand new bug two')] }));
  const first = await launch(f, program, fakeDispatch(script, { seen }));
  assert.equal(node(first, 'approve').status, 'waiting');
  continueOffline(first, 'approve');
  const shipped = await resume(f, first.runId, fakeDispatch(script, { seen }));
  assert.equal(shipped.result.status, 'completed');
  assert.equal(workerRuns(seen, 'ship').length, 1);
  phase = 2;
  assert.equal((await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: first.runId, stepId: 'build', waitMs: 0 })).status, 'applied');
  const mid = await resume(f, first.runId, fakeDispatch(script, { seen }));
  // The new review found something while the loop had passed: the approval of the old result does not stand.
  assert.equal(node(mid, 'harden').status, 'passed');
  assert.equal(node(mid, 'approve').status, 'waiting', 'the caller approves the new result again');
  assert.equal(runtimeOf(mid, 'ship').status, 'pending');
  assert.equal(workerRuns(seen, 'ship').length, 1, 'ship has not run on the new result yet');
  assert.notEqual(mid.result?.status, 'completed');
  continueOffline(mid, 'approve');
  const last = await resume(f, first.runId, fakeDispatch(script, { seen }));
  assert.equal(last.result.status, 'completed');
  assert.equal(workerRuns(seen, 'ship').length, 2, 'ship ran again on the new result');
  const gateEvents = eventsOf(last, 'gate.reopened');
  assert.ok(gateEvents.length >= 1);
  assert.deepEqual([gateEvents[0].payload.gateId, gateEvents[0].payload.loopId], ['approve', 'harden']);
  assert.match(renderControlEvent(controlWatchEvent(gateEvents[0], { token: 'x' })), /gate approve waits again/);
});

// 0.38.15 benchmark crash (yr6rri, 2026-10-15 01:14Z): the kernel stopped on
// `findings.rounds[0].belowFloor is not allowed`. The floor's own fields
// must survive the durable-state check on a real run, not only in mergeRound.
test('severity floor through a real run: below-floor counts and known severities pass the durable-state check', async (t) => {
  const f = fixture(t);
  const seen = [];
  const byTurn = (turn) => (turn === 1
    ? { findings: [finding('LIKE escape ignored', { severity: 'edge' }), finding('Collation of NUL bytes', { severity: 'obscure' })] }
    : { findings: [finding('Rounding of 1e308 * 10', { severity: 'obscure' })] });
  const run = await launch(f, dryProgram(), fakeDispatch(reviewAnswers(byTurn), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'dry', 2]);
  assert.deepEqual(record.findings.rounds.map((round) => [round.new, round.belowFloor ?? 0, round.fix]), [[1, 1, 'runs'], [0, 1, 'skipped']]);
  assert.deepEqual(record.findings.known.map((entry) => [entry.severity, entry.belowFloor === true]), [['edge', false], ['obscure', true], ['obscure', true]]);
  assert.equal(validateV2DurableState(run.state), true);
  assert.equal(validateV2DurableState(deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'))), true);
});

// --- 0.38.16 (benchmark-0.38.15-report.md, Second Mate's GO) ---------------------

test('0.38.16 non-functional areas: whole words, and every part of the area must be past correctness', async () => {
  const { isNonFunctionalArea, NON_FUNCTIONAL_AREA } = await import('../src/workflow/dry-loops.js');
  for (const area of [NON_FUNCTIONAL_AREA, 'query speed on 100k rows', 'performance and tests', 'code structure / readability', 'test coverage']) {
    assert.equal(isNonFunctionalArea(area), true, area);
  }
  // The benchmark's third area, and the unanchored 0.38.15 matches.
  for (const area of ['errors, constraints, all-or-nothing, transactions, performance', 'scalar functions', 'test of NULL handling', 'semantics: NULLs, types, affinity, comparisons, functions, aggregates', 'grammar']) {
    assert.equal(isNonFunctionalArea(area), false, area);
  }
  // The benchmark's three areas now get the non-functional area added.
  const areas = ['semantics: NULLs, types, affinity, comparisons, functions, aggregates', 'queries: joins, subqueries, GROUP BY/HAVING, ORDER BY, UNION, LIMIT', 'errors, constraints, all-or-nothing, transactions, performance'];
  const normal = normaliseProgramV3(dryProgram({ areas, nonFunctional: true }));
  assert.deepEqual(normal.steps.find((step) => step.areaOf).areaOf.areas, [...areas, NON_FUNCTIONAL_AREA]);
});

test('0.38.16 yield stop: two reviewed rounds in a row that each found 1 or 2 end the loop; a still-open finding, a clean round, a fixer first or yield false do not', () => {
  const loop = { id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry: 1 } };
  const group = { id: 'review', steps: ['review'], areas: [], perRound: 1 };
  const round = (n, found, extra = {}) => ({ round: n, reviewed: [0], new: found, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs', ...extra });
  const verdict = (rounds, l = loop, g = group) => dryVerdict(l, { findings: { rounds, known: [], knownDropped: 0 } }, g);
  assert.deepEqual([verdict([round(1, 9), round(2, 2), round(3, 1)]).dry, verdict([round(1, 9), round(2, 2), round(3, 1)]).by], [true, 'yield']);
  // The benchmark's sequence never qualifies (4, then 3, then 5).
  assert.equal(verdict([9, 4, 2, 4, 3, 5].map((n, i) => round(i + 1, n))).dry, false);
  assert.equal(verdict([round(1, 9), round(2, 2), round(3, 3)]).dry, false, 'over max');
  assert.equal(verdict([round(1, 2), round(2, 1, { reopened: 1 })]).dry, false, 'a fix that did not hold keeps it going');
  assert.equal(verdict([round(1, 2)]).dry, false, 'one round is not two');
  assert.equal(verdict([round(1, 2), round(2, 1)], { ...loop, until: { ...loop.until, yield: false } }).dry, false);
  assert.equal(verdict([round(1, 2), round(2, 1)], loop, { ...group, fixFirst: true }).dry, false);
  const three = { ...loop, until: { ...loop.until, yield: { max: 3, rounds: 3 } } };
  assert.equal(verdict([round(1, 3), round(2, 3)], three).dry, false);
  assert.equal(verdict([round(1, 3), round(2, 3), round(3, 1)], three).by, 'yield');
  // With areas, the rounds in the tail must cover every area.
  const areaGroup = { id: 'review', steps: ['review-area-1'], areas: ['a', 'b', 'c'], perRound: 1 };
  assert.equal(verdict([round(1, 1, { reviewed: [0] }), round(2, 1, { reviewed: [1] })], loop, areaGroup).dry, false);
  // dry 2 still needs its clean rounds: a clean round is not a low-yield round.
  const dry2 = { ...loop, until: { ...loop.until, dry: 2 } };
  assert.equal(verdict([round(1, 2), round(2, 0)], dry2).dry, false);
});

test('0.38.16 yield is validated on the dry until', () => {
  assert.deepEqual(issuesOf(dryProgram({ yieldStop: { max: 1, rounds: 3 } })), []);
  assert.deepEqual(normaliseProgramV3(dryProgram({ yieldStop: { max: 1 } })).loops[0].until.yield, { max: 1 });
  assert.equal(normaliseProgramV3(dryProgram({ yieldStop: true })).loops[0].until.yield, undefined, 'the default is not stored');
  assert.ok(issuesOf(dryProgram({ yieldStop: { max: 11 } })).some((issue) => /yield\.max must be a whole number from 0 to 10/.test(issue)));
  assert.ok(issuesOf(dryProgram({ yieldStop: { rounds: 1 } })).some((issue) => /yield\.rounds must be a whole number from 2/.test(issue)));
  assert.ok(issuesOf(dryProgram({ yieldStop: { when: 2 } })).some((issue) => /yield\.when is not allowed/.test(issue)));
  assert.ok(issuesOf(dryProgram({ yieldStop: 'soon' })).some((issue) => /yield must be false or \{max, rounds\}/.test(issue)));
});

test('0.38.16 yield stop through a real run: the fixer runs on the last findings, the loop passes as yield, and the run state passes the durable check', async (t) => {
  const f = fixture(t);
  const seen = [];
  const counts = [3, 2, 1];
  const byTurn = (turn) => ({ findings: Array.from({ length: counts[turn - 1] ?? 0 }, (_, k) => finding(`Round ${turn} finding ${k + 1} in the acme parser`, { severity: 'edge' })) });
  const run = await launch(f, dryProgram({ yieldStop: true, maxRounds: 5 }), fakeDispatch(reviewAnswers(byTurn), { seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const record = node(run, 'harden');
  assert.deepEqual([record.status, record.reason, record.round], ['passed', 'yield', 3]);
  assert.deepEqual(seen.map((entry) => entry.actionId), ['build', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'ship'], 'round 3\'s fixer ran before the loop ended');
  const passed = eventsOf(run, 'loop.passed')[0];
  assert.deepEqual([passed.payload.reason, passed.payload.perRound, passed.payload.yieldRule], ['yield', [3, 2, 1], { max: 2, rounds: 2 }]);
  assert.match(renderControlEvent(controlWatchEvent(passed, { token: 'acme01' })), /loop harden stopped on low yield in round 3 of 5 · new per round 3, 2, 1 · the last 2 found at most 2 each · 6 found in all/);
  assert.equal(run.result.loops[0].findings.yieldIn, 3);
  assert.equal(validateV2ResultEnvelope(run.result), true);
  assert.match(run.result.reason, /loop harden ended on low yield in round 3 of 5 \(6 findings\)/);
  assert.equal(validateV2DurableState(run.state), true);
  assert.equal(validateV2DurableState(deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'))), true);
});

test('0.38.16 out of rounds: the event and the watch line name new per round and the loop\'s worker tokens so far', async (t) => {
  const f = fixture(t);
  const byTurn = (turn) => ({ findings: [finding(`Round ${turn} finding in the acme parser`)] });
  const tokens = { output: 1200, reasoning: 800 };
  const script = (id, turn, task) => ({ ...reviewAnswers(byTurn)(id, turn, task), tokens });
  const run = await launch(f, dryProgram({ maxRounds: 2 }), fakeDispatch(script));
  const event = eventsOf(run, 'loop.out-of-rounds')[0];
  assert.deepEqual([event.payload.findings.perRound, event.payload.findings.tokens], [[1, 1], 8000], '2 reviews and 2 fixes at 2,000 each');
  assert.match(renderControlEvent(controlWatchEvent(event, { token: 'acme01' })), /· new per round 1, 1 · 8k worker tokens so far · continue:/);
  assert.equal(validateV2DurableState(run.state), true);
});

// Fix 4: every field a dry loop's record can carry goes through the durable
// check on a real kernel run (e12c114 found `belowFloor` was refused only when
// the benchmark's kernel saved its first severity round).
test('0.38.16 every findings field a real run writes passes the durable-state check', async (t) => {
  const f = fixture(t);
  const long = `Unary minus binds looser than ^ in the acme expression parser when ${'the operand is parenthesised and '.repeat(6)}nested`;
  const byTurn = (turn) => ({ findings: turn === 1
    ? [finding(long, { severity: 'edge' }), finding('Collation of NUL bytes', { severity: 'obscure' }), finding('Error text is not localised', { inScope: false })]
    : turn === 2
      ? [finding(long, { severity: 'edge', stillOpen: true }), finding('LIKE escape ignored', { severity: 'everyday' })]
      : [] });
  const run = await launch(f, dryProgram({ maxRounds: 4, yieldStop: true }), fakeDispatch(reviewAnswers(byTurn)));
  const findings = node(run, 'harden').findings;
  const roundKeys = new Set(findings.rounds.flatMap((round) => Object.keys(round)));
  const knownKeys = new Set(findings.known.flatMap((entry) => Object.keys(entry)));
  for (const key of ['belowFloor', 'reopened', 'outOfScope', 'answers']) assert.ok(roundKeys.has(key), `round field ${key} was written`);
  for (const key of ['key', 'severity', 'belowFloor', 'reopened', 'inScope']) assert.ok(knownKeys.has(key), `known field ${key} was written`);
  assert.equal(validateV2DurableState(run.state), true);
  assert.equal(validateV2DurableState(deserializeV2DurableState(readFileSync(join(run.runDir, 'state.json'), 'utf8'))), true);
});

test('0.38.16 an area named plainly "structure" (or design, readability, refactoring, code quality) counts, so no second non-functional area is added', async () => {
  const { isNonFunctionalArea, NON_FUNCTIONAL_AREA } = await import('../src/workflow/dry-loops.js');
  for (const area of ['structure', 'structure, tests', 'structural quality', 'design', 'code design', 'readability', 'refactoring', 'code quality', 'architecture', 'maintainability', 'tests']) {
    assert.equal(isNonFunctionalArea(area), true, area);
  }
  for (const area of ['data structures and NULL handling', 'data structure correctness', 'schema design', 'table structure and constraints', 'database design', 'table design']) assert.equal(isNonFunctionalArea(area), false, area);
  const areas = ['grammar and parsing', 'joins and subqueries', 'structure, tests'];
  const normal = normaliseProgramV3(dryProgram({ areas, nonFunctional: true }));
  assert.deepEqual(normal.steps.find((step) => step.areaOf).areaOf.areas, areas, 'nothing added');
  assert.ok(!normal.steps.find((step) => step.areaOf).areaOf.areas.includes(NON_FUNCTIONAL_AREA));
});

// --- 0.38.17 (benchmark-0.38.16-report.md, Second Mate's order 2026-10-16) ---------

// The 0.38.16 benchmark loop (run 65xiua): 3 reviewers over 4 areas (the 4th
// non-functional, reviewed every round), new per round 3, 4, 6, 3, 3, 1, and a
// finding reported still open in rounds 3 and 4.
const BENCH_REVIEWED = [[0, 1, 3], [2, 0, 3], [1, 2, 3], [0, 1, 3], [2, 0, 3], [1, 2, 3]];
const benchRounds = (news, reopened = []) => news.map((found, i) => ({
  round: i + 1, reviewed: BENCH_REVIEWED[i % BENCH_REVIEWED.length], new: found, reopened: reopened[i] ?? 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs',
}));
const benchLoop = { id: 'harden', steps: ['review-area-1', 'review-area-2', 'review-area-3', 'fix'], until: { step: 'review', dry: 1 } };
const benchGroup = { id: 'review', steps: ['review-area-1', 'review-area-2', 'review-area-3'], areas: ['grammar', 'expressions', 'joins', 'performance and tests'], perRound: 3 };
const benchVerdict = (rounds) => dryVerdict(benchLoop, { findings: { rounds, known: [], knownDropped: 0 } }, benchGroup);

test('0.38.17 default yield {max 3, rounds 2}: the benchmark\'s 3, 4, 6, 3, 3, 1 stops after round 6 and not before', async () => {
  const { YIELD_DEFAULT } = await import('../src/workflow/dry-loops.js');
  assert.deepEqual(YIELD_DEFAULT, { max: 3, rounds: 2 });
  const news = [3, 4, 6, 3, 3, 1];
  const reopened = [0, 0, 1, 1, 0, 0];
  for (let n = 1; n <= 5; n += 1) assert.equal(benchVerdict(benchRounds(news.slice(0, n), reopened)).dry, false, `not after round ${n}`);
  const six = benchVerdict(benchRounds(news, reopened));
  assert.deepEqual([six.dry, six.by, six.yieldRule], [true, 'yield', { max: 3, rounds: 2 }]);
});

test('0.38.17 the yield stop does not fire early: 3, 4, 6, 5, 4 keeps going, and a round with a fix that did not hold never counts', () => {
  for (const news of [[3, 4, 6, 5], [3, 4, 6, 5, 4], [6, 4, 5, 6]]) {
    for (let n = 1; n <= news.length; n += 1) assert.equal(benchVerdict(benchRounds(news.slice(0, n))).dry, false, `${news.slice(0, n)}`);
  }
  // 3, 3 qualifies on counts, but round 2's still-open finding keeps it going.
  assert.equal(benchVerdict(benchRounds([3, 3], [0, 1])).dry, false);
  assert.equal(benchVerdict(benchRounds([3, 3])).by, 'yield');
});

test('0.38.17 one perRound definition: new findings only, reopened carried beside it, the same in the event, the loop record and the result', async (t) => {
  const f = fixture(t);
  // Round 1 finds 2; round 2 finds 1 new and reports round 1's first finding still open.
  const byTurn = (turn) => ({ findings: turn === 1
    ? [finding('Parser drops unary minus', { severity: 'edge' }), finding('LIKE ignores escape', { severity: 'edge' })]
    : [finding('Parser drops unary minus', { severity: 'edge', stillOpen: true }), finding('ORDER BY position off by one', { severity: 'edge' })] });
  const run = await launch(f, dryProgram({ maxRounds: 2, yieldStop: false }), fakeDispatch(reviewAnswers(byTurn)));
  const event = eventsOf(run, 'loop.out-of-rounds')[0];
  assert.deepEqual([event.payload.findings.perRound, event.payload.findings.reopenedPerRound], [[2, 1], [0, 1]]);
  assert.deepEqual(run.result.loops[0].findings.rounds, event.payload.findings.perRound, 'the result\'s rounds and the event\'s perRound agree');
  assert.deepEqual(run.result.loops[0].findings.stillOpen, [0, 1]);
  assert.match(renderControlEvent(controlWatchEvent(event, { token: 'acme01' })), /· new per round 2, 1 · reopened per round 0, 1 ·/);
  assert.match(run.waiting[0].note, /new per round: 2, 1; reopened per round: 0, 1/);
  assert.equal(validateV2DurableState(run.state), true);
});
