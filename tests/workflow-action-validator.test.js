import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_KINDS, ActionValidationError, DEFAULT_EFFORT_BY_LANE, KIND_DEFAULTS,
  KIND_ROLES, PROGRAM_ADVISORY_CODES, programAdvisories, validateActionProgram,
} from '../src/workflow/action-validator.js';

const work = (over = {}) => ({
  id: 'build-result', purpose: 'Build the result', dependsOn: [], affects: ['result'],
  ownedFiles: ['src/result.js'], prompt: 'Implement the result', lane: 'build', effort: 'medium',
  evidenceFor: [], produces: ['result-artifact'], ...over,
});
const evidence = (over = {}) => ({
  id: 'check-result', purpose: 'Check the result', dependsOn: ['build-result'], affects: [],
  ownedFiles: [], prompt: 'Inspect the result', lane: 'analyze', effort: 'low', evidenceFor: ['result'],
  inputs: ['result-artifact'], ...over,
});
const program = (actions = [work(), evidence()]) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });

test('validates and defensively normalizes a V2 program', () => {
  const input = program([work({ ownedFiles: ['./src/result.js'] }), evidence()]);
  const result = validateActionProgram(input, { mandatoryRequirements: ['result'], maxActions: 2, maxParallel: 2 });
  assert.deepEqual(result.actions[0].ownedFiles, ['src/result.js']);
  input.actions[0].ownedFiles[0] = 'changed.js';
  assert.equal(result.actions[0].ownedFiles[0], 'src/result.js');
});

test('rejects unknown fields, planner control claims, and malformed IDs', () => {
  assert.throws(() => validateActionProgram(program([work({ type: 'verify', completion: true, id: 'Bad ID', extra: 1 })])), (error) => {
    assert.ok(error instanceof ActionValidationError);
    assert.ok(error.issues.some((issue) => issue.includes('extra')));
    assert.ok(error.issues.some((issue) => issue.includes('completion')));
    assert.ok(error.issues.some((issue) => issue.includes('valid kebab-case')));
    return true;
  });
});

test('rejects cycles, unknown references, duplicate artifacts, and unsafe paths', () => {
  assert.throws(() => validateActionProgram(program([
    work({ id: 'a', dependsOn: ['b'], produces: ['same'], ownedFiles: ['../secret'] }),
    work({ id: 'b', dependsOn: ['a'], produces: ['same'], ownedFiles: ['src/b.js'] }),
  ])), (error) => error.issues.some((issue) => issue.includes('cycle')) && error.issues.some((issue) => issue.includes('duplicate producers')));
});

test('requires evidence coverage and independence from every affected work action', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'other', affects: ['result'], ownedFiles: ['src/other.js'] }), evidence({ dependsOn: ['build-result'], inputs: [] })]), { mandatoryRequirements: ['result'] }), (error) => error.issues.some((issue) => issue.includes('other')));
  assert.throws(() => validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', actions: [work()] }, { mandatoryRequirements: ['result'] }), (error) => error.issues.some((issue) => issue.includes('no evidence action')));
});

test('requires justified work dependencies and enforces parallel/action bounds', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'a', affects: [], ownedFiles: ['a.js'], produces: [] }), work({ id: 'b', affects: [], ownedFiles: ['b.js'], produces: [] })]), { maxParallel: 1 }), (error) => error.issues.some((issue) => issue.includes('maxParallel')));
  assert.throws(() => validateActionProgram(program([work({ id: 'a', affects: [], ownedFiles: ['a.js'], produces: [] }), work({ id: 'b', dependsOn: ['a'], affects: [], ownedFiles: ['b.js'], produces: [] })]), { maxParallel: 2 }), (error) => error.issues.some((issue) => issue.includes('not justified')));
});

test('accepts ordered overlap, direct artifact dependencies, evidence inputs, and optional requirements', () => {
  const result = validateActionProgram(program([
    work({ id: 'first', affects: ['optional'], ownedFiles: ['src/shared.js'], produces: ['work-artifact'] }),
    work({ id: 'second', dependsOn: ['first'], affects: ['result'], ownedFiles: ['src/shared.js'], inputs: ['work-artifact'], produces: [] }),
    evidence({ id: 'check', dependsOn: ['second'], evidenceFor: ['result'], inputs: ['work-artifact'] }),
  ]), { requirements: [{ id: 'result', mandatory: true }, { id: 'optional', mandatory: false }] });
  assert.equal(result.actions.length, 3);
});

test('accepts a replan depending on a known producer and returns only new actions', () => {
  const knownWork = { id: 'known-work', affects: ['result'], ownedFiles: ['src/known.js'], produces: ['known-artifact'] };
  const result = validateActionProgram(program([
    evidence({ id: 'check-new', dependsOn: ['known-work'], evidenceFor: ['result'], inputs: ['known-artifact'] }),
  ]), {
    mandatoryRequirements: ['result'],
    knownActions: [knownWork],
    knownArtifacts: { 'known-artifact': 'known-work' },
  });
  assert.deepEqual(result.actions.map((action) => action.id), ['check-new']);
});

test('accepts mandatory coverage from fresh existing evidence', () => {
  const result = validateActionProgram(program([work()]), {
    mandatoryRequirements: ['result'],
    freshEvidenceRequirementIds: ['result'],
  });
  assert.equal(result.actions.length, 1);
});

test('rejects known ID and artifact collisions, stale coverage, and unsafe NUL paths', () => {
  assert.throws(() => validateActionProgram(program([work({ id: 'known-work' })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', produces: ['known-artifact'] })],
    knownArtifacts: { 'known-artifact': 'known-work' },
  }), (error) => error.issues.some((issue) => issue.includes('collides with known action')));
  assert.throws(() => validateActionProgram(program([work({ produces: ['known-artifact'] }), evidence({ dependsOn: ['build-result'], inputs: ['known-artifact'] })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', produces: ['known-artifact'] })],
  }), (error) => error.issues.some((issue) => issue.includes('duplicate producers')));
  assert.throws(() => validateActionProgram(program([work()]), {
    mandatoryRequirements: ['result'],
    freshEvidenceRequirementIds: [],
  }), (error) => error.issues.some((issue) => issue.includes('no evidence action')));
  assert.throws(() => validateActionProgram(program([work({ ownedFiles: ['src/\0bad.js'] })])), (error) => error.issues.some((issue) => issue.includes('NUL')));
});

test('rejects evidence that misses a known affecting work ancestor and handles malformed entries', () => {
  assert.throws(() => validateActionProgram(program([evidence({ dependsOn: [], inputs: [] })]), {
    mandatoryRequirements: ['result'],
    knownActions: [work({ id: 'known-work', affects: ['result'] })],
  }), (error) => error.issues.some((issue) => issue.includes('known-work')));
  assert.throws(() => validateActionProgram(program([null, 3, 'bad']), { mandatoryRequirements: ['result'] }), (error) => {
    assert.ok(error.issues.some((issue) => issue.includes('actions[0] must be an object')));
    assert.ok(error.issues.some((issue) => issue.includes('actions[1] must be an object')));
    return true;
  });
});

test('rejects planner-owned output contracts in evidence prompts before dispatch', () => {
  for (const prompt of [
    'Inspect the result. Return JSON exactly in the form {"ok":true,"concerns":[],"summary":"done"}.',
    'Check the requirement and respond with an object containing the verdict.',
    'Inspect the files, then emit an evidence envelope with your findings.',
  ]) {
    assert.throws(
      () => validateActionProgram(program([work(), evidence({ prompt })]), { mandatoryRequirements: ['result'] }),
      (error) => error.issues.some((issue) => issue.includes('kernel')),
    );
  }
  assert.equal(
    validateActionProgram(program([work(), evidence({ prompt: 'Inspect the result, run the focused tests, and cite concrete findings.' })]), { mandatoryRequirements: ['result'] }).actions.length,
    2,
  );
});

test('accepts evidence inspecting product output without mistaking it for the verifier response', () => {
  for (const prompt of [
    'Run every command README shows and compare its documented output and exit codes with the actual output; documented JSON/markdown output must match the real stdout exactly.',
    'Check that the CLI can emit JSON and that its output matches the documented schema.',
    'Inspect the API return values and compare them with the expected object shape.',
    'Inspect the report. Do not return your own JSON envelope; the kernel supplies the evidence contract.',
  ]) {
    assert.equal(
      validateActionProgram(program([work(), evidence({ prompt })]), { mandatoryRequirements: ['result'] }).actions.length,
      2,
      prompt,
    );
  }
});

test('enforces structural lane and effort invariants before dispatch', () => {
  assert.throws(
    () => validateActionProgram(program([work({ lane: 'analyze' }), evidence()])),
    (error) => error.issues.some((issue) => issue.includes('analyze actions must not own workspace files')),
  );
  assert.throws(
    () => validateActionProgram(program([work(), evidence({ lane: 'build' })])),
    (error) => error.issues.some((issue) => issue.includes('evidence actions must use lane analyze')),
  );
  assert.throws(
    () => validateActionProgram(program([work({ lane: 'chore', effort: 'medium' }), evidence()])),
    (error) => error.issues.some((issue) => issue.includes('chore actions are deterministic mechanical work and must use low effort')),
  );
  assert.equal(
    validateActionProgram(program([work({ lane: 'chore', effort: 'low' }), evidence()]), { mandatoryRequirements: ['result'] }).actions[0].lane,
    'chore',
  );
});

test('can replay a historical program without retroactively applying routing policy', () => {
  const historical = validateActionProgram(
    program([work({ lane: 'chore', effort: 'medium' }), evidence()]),
    { mandatoryRequirements: ['result'], enforceRoutingPolicy: false },
  );
  assert.equal(historical.actions[0].effort, 'medium');
});

test('optional per-action reasoning is accepted on the common scale and survives normalization', () => {
  const accepted = validateActionProgram(
    program([work({ reasoning: 'xhigh' }), evidence({ reasoning: 'default' })]),
    { mandatoryRequirements: ['result'] },
  );
  assert.equal(accepted.actions[0].reasoning, 'xhigh');
  assert.equal(accepted.actions[1].reasoning, 'default');
  // Omitting the field must stay omitted, not become a level the caller never
  // asked for: absent means "use the configured level".
  const omitted = validateActionProgram(program(), { mandatoryRequirements: ['result'] });
  assert.equal(Object.hasOwn(omitted.actions[0], 'reasoning'), false);
  for (const level of ['low', 'medium', 'high', 'max']) {
    assert.equal(
      validateActionProgram(program([work({ reasoning: level }), evidence()]), { mandatoryRequirements: ['result'] }).actions[0].reasoning,
      level,
    );
  }
});

test('rejects a reasoning value that is not on the common scale', () => {
  for (const bad of ['ultra', 'HIGH', 'auto', '', 3, null, true]) {
    assert.throws(
      () => validateActionProgram(program([work({ reasoning: bad }), evidence()]), { mandatoryRequirements: ['result'] }),
      (error) => {
        assert.ok(error instanceof ActionValidationError, `expected ActionValidationError for ${JSON.stringify(bad)}`);
        assert.ok(
          error.issues.includes('actions[0].reasoning must be low|medium|high|xhigh|max|default'),
          `missing reasoning issue for ${JSON.stringify(bad)}: ${error.issues.join('; ')}`,
        );
        return true;
      },
    );
  }
});

// --- kind, program defaults, and advisories ---------------------------------

// The exact bytes today's validator produces for an existing fixture program.
// `kind` and `defaults` must not perturb a program that uses neither.
const LEGACY_FIXTURE = {
  schemaVersion: 'bullswarm.workflow.program.v2',
  actions: [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
  ],
};
const LEGACY_FIXTURE_NORMALIZED = '{"schemaVersion":"bullswarm.workflow.program.v2","actions":[{"id":"write-report","purpose":"Write report","dependsOn":[],"affects":["report-correct"],"ownedFiles":["report.md"],"prompt":"Write READY to report.md.","lane":"build","effort":"low","evidenceFor":[],"inputs":[],"produces":["report"]},{"id":"inspect-report","purpose":"Inspect report","dependsOn":["write-report"],"affects":[],"ownedFiles":[],"prompt":"Inspect report.md.","lane":"analyze","effort":"low","evidenceFor":["report-correct"],"inputs":["report"],"produces":[]}]}';

// A writer that names only its nature. `affects` and `ownedFiles` stay so the
// graph rules that predate kinds still apply unchanged.
const kindWork = (kind, over = {}) => {
  const { id = `work-${kind}`, ...rest } = over;
  return {
    id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['result'],
    ownedFiles: [`src/${id}.js`], prompt: `Implement ${id}.`, kind,
    evidenceFor: [], inputs: [], produces: [], ...rest,
  };
};
const relaxed = { mandatoryRequirements: ['result'], requireMandatoryEvidence: false, relaxedGraph: true };

test('kind derives the documented lane and effort for every value in the closed set', () => {
  assert.deepEqual(ACTION_KINDS, ['mechanical', 'io-read', 'digest', 'check', 'implement', 'integration', 'architecture', 'adversarial-acceptance']);
  assert.deepEqual(KIND_DEFAULTS, {
    mechanical: { lane: 'chore', effort: 'low' },
    'io-read': { lane: 'analyze', effort: 'low' },
    digest: { lane: 'analyze', effort: 'low' },
    check: { lane: 'analyze', effort: 'medium' },
    implement: { lane: 'build', effort: 'medium' },
    integration: { lane: 'build', effort: 'high' },
    architecture: { lane: 'analyze', effort: 'high' },
    'adversarial-acceptance': { lane: 'analyze', effort: 'high' },
  });
  for (const [kind, expected] of Object.entries(KIND_DEFAULTS)) {
    // An analyze kind cannot own workspace files, so drop ownedFiles for those.
    const over = expected.lane === 'analyze' ? { ownedFiles: [] } : {};
    // A digest has nothing to condense without a dependency, and delivers no
    // acceptance slice of its own, so it is validated against a peer writer.
    const peers = kind === 'digest' ? [kindWork('implement', { id: 'source' })] : [];
    const digestOver = kind === 'digest' ? { dependsOn: ['source'], affects: [] } : {};
    const action = validateActionProgram(
      { schemaVersion: 'bullswarm.workflow.program.v2', actions: [...peers, kindWork(kind, { ...over, ...digestOver })] },
      relaxed,
    ).actions.at(-1);
    assert.equal(action.kind, kind, kind);
    assert.equal(action.lane, expected.lane, kind);
    assert.equal(action.effort, expected.effort, kind);
  }
});

test('lane and effort resolve action field, then kind, then program defaults, then the lane table', () => {
  const validate = (program) => validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', ...program }, relaxed).actions[0];
  // Explicit action fields outrank the kind table.
  const explicit = validate({ actions: [kindWork('mechanical', { lane: 'build', effort: 'high' })] });
  assert.deepEqual([explicit.lane, explicit.effort], ['build', 'high']);
  // Kind outranks program defaults.
  const kindWins = validate({ defaults: { effort: 'high' }, actions: [kindWork('implement')] });
  assert.deepEqual([kindWins.lane, kindWins.effort], ['build', 'medium']);
  // Program defaults apply when neither the action nor a kind supplies effort.
  const fromDefaults = validate({ defaults: { effort: 'high' }, actions: [kindWork('implement', { kind: undefined, lane: 'build' })] });
  assert.deepEqual([fromDefaults.lane, fromDefaults.effort], ['build', 'high']);
  // The lane table is the last fallback and stays the single source of truth.
  const fromLane = validate({ actions: [kindWork('implement', { kind: undefined, lane: 'analyze', ownedFiles: [] })] });
  assert.equal(fromLane.effort, DEFAULT_EFFORT_BY_LANE.analyze);
  assert.deepEqual(DEFAULT_EFFORT_BY_LANE, { analyze: 'medium', build: 'medium', chore: 'low' });
  // No lane and no kind is still the same rejection it has always been.
  assert.throws(
    () => validate({ actions: [kindWork('implement', { kind: undefined })] }),
    (error) => error.issues.includes('actions[0].lane must be analyze|build|chore'),
  );
});

test('reasoning resolves action field then program defaults, and stays absent otherwise', () => {
  const validate = (program) => validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', ...program }, relaxed).actions[0];
  assert.equal(validate({ defaults: { reasoning: 'xhigh' }, actions: [kindWork('implement')] }).reasoning, 'xhigh');
  assert.equal(validate({ defaults: { reasoning: 'xhigh' }, actions: [kindWork('implement', { reasoning: 'max' })] }).reasoning, 'max');
  assert.equal(Object.hasOwn(validate({ actions: [kindWork('implement')] }), 'reasoning'), false);
});

test('an unknown kind is a validation error naming the allowed values', () => {
  for (const bad of ['implementation', 'IO-READ', 'chore', '', 3, null]) {
    assert.throws(
      () => validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', actions: [kindWork('implement', { kind: bad })] }, relaxed),
      (error) => {
        assert.ok(error instanceof ActionValidationError, `expected ActionValidationError for ${JSON.stringify(bad)}`);
        assert.ok(
          error.issues.includes(`actions[0].kind must be ${ACTION_KINDS.join('|')}`),
          `missing kind issue for ${JSON.stringify(bad)}: ${error.issues.join('; ')}`,
        );
        return true;
      },
    );
  }
});

test('program defaults allow only effort, reasoning, timeBox and verifyRounds', () => {
  const withDefaults = (defaults) => validateActionProgram(
    { schemaVersion: 'bullswarm.workflow.program.v2', defaults, actions: [kindWork('implement')] },
    relaxed,
  );
  assert.throws(() => withDefaults({ lane: 'build' }), (error) => error.issues.includes('program.defaults.lane is not allowed; only effort, reasoning, timeBox and verifyRounds'));
  assert.throws(() => withDefaults({ kind: 'implement' }), (error) => error.issues.includes('program.defaults.kind is not allowed; only effort, reasoning, timeBox and verifyRounds'));
  assert.throws(() => withDefaults({ effort: 'ultra' }), (error) => error.issues.includes('program.defaults.effort must be high|medium|low'));
  assert.throws(() => withDefaults({ reasoning: 'ultra' }), (error) => error.issues.includes('program.defaults.reasoning must be low|medium|high|xhigh|max|default'));
  assert.throws(() => withDefaults('high'), (error) => error.issues.includes('program.defaults must be an object'));
  assert.equal(withDefaults({ effort: 'low', reasoning: 'low' }).actions.length, 1);
  // `defaults` is resolved into the actions, never echoed into the accepted
  // program, so the durable program schema is unchanged.
  assert.deepEqual(Object.keys(withDefaults({ effort: 'low' })), ['schemaVersion', 'actions']);
});

test('timeBox is whole minutes 0–240 on an action or in defaults, folded onto each action like effort', () => {
  const run = (defaults, over = {}) => validateActionProgram(
    { schemaVersion: 'bullswarm.workflow.program.v2', ...(defaults ? { defaults } : {}), actions: [kindWork('implement', over)] },
    relaxed,
  );
  for (const bad of [-1, 241, 12.5, '20', null, true]) {
    assert.throws(() => run(null, { timeBox: bad }), (error) => {
      assert.ok(error.issues.includes('actions[0].timeBox must be a whole number of minutes from 0 to 240'), `${JSON.stringify(bad)}: ${error.issues.join('; ')}`);
      return true;
    });
    assert.throws(() => run({ timeBox: bad }), (error) => {
      assert.ok(error.issues.includes('program.defaults.timeBox must be a whole number of minutes from 0 to 240'), `${JSON.stringify(bad)}: ${error.issues.join('; ')}`);
      return true;
    });
  }
  // Used as given at both ends of the range; 0 is a real value (no paragraph).
  assert.equal(run(null, { timeBox: 0 }).actions[0].timeBox, 0);
  assert.equal(run(null, { timeBox: 240 }).actions[0].timeBox, 240);
  // The default folds onto an action that names none; an action's own wins.
  assert.equal(run({ timeBox: 15 }).actions[0].timeBox, 15);
  assert.equal(run({ timeBox: 15 }, { timeBox: 0 }).actions[0].timeBox, 0);
  // No box anywhere: the field stays absent and the kernel computes one.
  assert.equal(Object.hasOwn(run(null).actions[0], 'timeBox'), false);
  // An accepted program re-validates to itself (every durable reload does).
  const accepted = run({ timeBox: 15 });
  assert.deepEqual(run(null, { timeBox: accepted.actions[0].timeBox }).actions, accepted.actions);
});

test('defaults.verifyRounds is 1–3 and is returned beside the actions, never folded onto them', () => {
  const run = (defaults) => validateActionProgram(
    { schemaVersion: 'bullswarm.workflow.program.v2', defaults, actions: [kindWork('implement')] },
    relaxed,
  );
  for (const bad of [0, 4, 2.5, '3', null]) {
    assert.throws(() => run({ verifyRounds: bad }), (error) => error.issues.includes('program.defaults.verifyRounds must be 1, 2 or 3'));
  }
  for (const rounds of [1, 2, 3]) {
    const accepted = run({ verifyRounds: rounds });
    assert.equal(accepted.verifyRounds, rounds);
    assert.equal(Object.hasOwn(accepted.actions[0], 'verifyRounds'), false);
  }
  // Absent stays absent, so a revision without it leaves the run's budget alone.
  assert.equal(Object.hasOwn(run({ effort: 'low' }), 'verifyRounds'), false);
});

test('a program without kind or defaults normalizes to byte-identical actions', () => {
  const before = JSON.parse(JSON.stringify(LEGACY_FIXTURE));
  const normalized = validateActionProgram(LEGACY_FIXTURE, { mandatoryRequirements: ['report-correct'] });
  assert.equal(JSON.stringify(normalized), LEGACY_FIXTURE_NORMALIZED);
  assert.deepEqual(LEGACY_FIXTURE, before, 'the input program must not be mutated');
  // Re-normalizing an accepted program is a fixed point, which is what every
  // durable-state reload does.
  assert.equal(
    JSON.stringify(validateActionProgram(normalized, { mandatoryRequirements: ['report-correct'] })),
    LEGACY_FIXTURE_NORMALIZED,
  );
});

test('ownedFiles name exact files, and a requirement no step checks is an advisory', () => {
  const writer = (ownedFiles, over = {}) => ({
    id: 'w', purpose: 'Write it', dependsOn: [], affects: ['result'], ownedFiles, prompt: 'Write the file.',
    lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...over,
  });
  const programOf = (...actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });
  // A directory or glob used to pass here and then stop the kernel right after launch.
  for (const bad of ['src/', 'src\\', 'src/*.js', 'file?.txt']) {
    assert.throws(
      () => validateActionProgram(programOf(writer([bad])), relaxed),
      (error) => error.issues.some((issue) => issue.includes(`must name one exact file, not a directory or glob ("${bad}")`)),
      bad,
    );
  }
  assert.equal(validateActionProgram(programOf(writer(['src/index.js'])), relaxed).actions[0].ownedFiles[0], 'src/index.js');

  const requirements = [{ id: 'result', text: 'x' }, { id: 'docs', text: 'y' }];
  const none = programAdvisories(programOf(writer(['a.txt'])), { requirements });
  assert.deepEqual(none.map((advisory) => [advisory.code, advisory.actionId]), [['requirement-unchecked', null]]);
  assert.match(none[0].message, /^no step checks any requirement \(result, docs\); the run can finish but never be verified/);
  const checker = writer([], { id: 'check', lane: 'analyze', affects: [], evidenceFor: ['result'] });
  const one = programAdvisories(programOf(writer(['a.txt']), checker), { requirements });
  assert.match(one[0].message, /^no step gives evidence for docs; the run can finish but that requirement stays unverified/);
  assert.deepEqual(programAdvisories(programOf(writer(['a.txt']), { ...checker, evidenceFor: ['result', 'docs'] }), { requirements }), []);
  assert.deepEqual(programAdvisories(programOf(writer(['a.txt']))), [], 'no requirements given, no advisory');
});

test('advisories report the two effort smells and never change validity', () => {
  assert.deepEqual([...PROGRAM_ADVISORY_CODES], ['all-writers-high', 'docs-at-high', 'requirement-unchecked']);
  const writers = (efforts) => ({
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: efforts.map((effort, index) => kindWork('implement', { id: `w-${index}`, effort })),
  });
  // Three or more build/chore actions with none below high.
  const all = programAdvisories(writers(['high', 'high', 'high']));
  assert.deepEqual(all.map((advisory) => [advisory.code, advisory.actionId]), [['all-writers-high', null]]);
  assert.match(all[0].message, /all 3 build\/chore actions run at high effort/);
  // Two writers, or one writer below high, is not a smell.
  assert.deepEqual(programAdvisories(writers(['high', 'high'])), []);
  assert.deepEqual(programAdvisories(writers(['high', 'high', 'medium'])), []);
  // Analyze actions are not writers and never count toward the threshold.
  assert.deepEqual(programAdvisories({
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      kindWork('implement', { id: 'w-0', effort: 'high' }),
      kindWork('architecture', { id: 'a-0', ownedFiles: [] }),
      kindWork('architecture', { id: 'a-1', ownedFiles: [] }),
    ],
  }), []);
  // Markdown-only ownership at high effort, named per action.
  const docs = programAdvisories({
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [kindWork('integration', { id: 'write-docs', ownedFiles: ['README.md', 'docs/guide.md'] })],
  });
  assert.deepEqual(docs.map((advisory) => [advisory.code, advisory.actionId]), [['docs-at-high', 'write-docs']]);
  assert.match(docs[0].message, /README\.md, docs\/guide\.md/);
  // One non-markdown owned path, a non-high effort, or empty ownedFiles: no advisory.
  for (const over of [
    { ownedFiles: ['README.md', 'src/a.js'] },
    { ownedFiles: ['README.md'], effort: 'medium' },
    { ownedFiles: [] },
  ]) {
    assert.deepEqual(programAdvisories({
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [kindWork('integration', { id: 'write-docs', ...over })],
    }), [], JSON.stringify(over));
  }
  // Advisories are computed from resolved effort, so program defaults reach them.
  assert.deepEqual(programAdvisories({
    schemaVersion: 'bullswarm.workflow.program.v2',
    defaults: { effort: 'high' },
    actions: [0, 1, 2].map((index) => kindWork('implement', { id: `w-${index}`, kind: undefined, lane: 'build' })),
  }).map((advisory) => advisory.code), ['all-writers-high']);
  // A program that earns both advisories still validates and normalizes.
  const smelly = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      kindWork('integration', { id: 'write-docs', ownedFiles: ['README.md'] }),
      kindWork('integration', { id: 'w-1' }),
      kindWork('integration', { id: 'w-2' }),
    ],
  };
  assert.equal(validateActionProgram(smelly, relaxed).actions.length, 3);
  assert.deepEqual(programAdvisories(smelly).map((advisory) => advisory.code), ['all-writers-high', 'docs-at-high']);
  assert.deepEqual(programAdvisories(null), []);
  assert.deepEqual(programAdvisories({ schemaVersion: 'bullswarm.workflow.program.v2' }), []);
});

// --- roles and deliverables -------------------------------------------------

const roleStep = (role, over = {}) => ({
  id: `step-${role}`, purpose: `Do ${role}`, dependsOn: [], affects: ['result'],
  ownedFiles: [], prompt: `Do the ${role} work.`, role, evidenceFor: [], inputs: [], produces: [],
  ...over,
});
const accept = (actions, runtime = relaxed) => validateActionProgram(
  { schemaVersion: 'bullswarm.workflow.program.v2', actions },
  runtime,
).actions.at(-1);
const issuesOf = (actions, runtime = relaxed) => {
  try {
    validateActionProgram({ schemaVersion: 'bullswarm.workflow.program.v2', actions }, runtime);
    assert.fail('expected validation to fail');
  } catch (error) {
    assert.ok(error instanceof ActionValidationError);
    return error.issues;
  }
};

test('a role-only step resolves lane, effort and the default deliverable', () => {
  const defaults = {
    investigate: ['analyze', 'medium', 'report'],
    produce: ['build', 'medium', 'files'],
    transform: ['chore', 'low', 'files'],
    check: ['analyze', 'medium', 'report'],
    act: ['analyze', 'medium', 'outward'],
  };
  for (const [role, [lane, effort, type]] of Object.entries(defaults)) {
    const ownedFiles = lane === 'build' || lane === 'chore' ? [`${role}.js`] : [];
    const action = accept([roleStep(role, { ownedFiles })]);
    assert.deepEqual([action.lane, action.effort, action.deliverable], [lane, effort, { type }], role);
    assert.equal(action.role, role);
    assert.equal(Object.hasOwn(action, 'kind'), false, role);
  }
  assert.deepEqual(
    [accept([roleStep('produce', { deliverable: 'report' })]).lane, accept([roleStep('produce', { deliverable: 'report' })]).effort],
    ['analyze', 'medium'],
  );
  const data = accept([roleStep('transform', {
    deliverable: { type: 'data', paths: ['out/rows.json'] },
    ownedFiles: ['out/rows.json'],
  })]);
  assert.deepEqual([data.lane, data.effort], ['chore', 'low']);
  assert.deepEqual(
    [accept([roleStep('combine', { deliverable: 'files', ownedFiles: ['src/a.js'] })]).lane,
      accept([roleStep('combine', { deliverable: 'files', ownedFiles: ['src/a.js'] })]).effort],
    ['build', 'high'],
  );
  const combinedData = accept([roleStep('combine', {
    deliverable: { type: 'data', paths: ['out/rows.json'] },
    ownedFiles: ['out/rows.json'],
  })]);
  assert.deepEqual([combinedData.lane, combinedData.effort], ['build', 'medium']);
  const combinedReport = accept([roleStep('combine', { deliverable: 'report' })]);
  assert.deepEqual([combinedReport.lane, combinedReport.effort, combinedReport.deliverable], ['analyze', 'medium', { type: 'report' }]);
  assert.ok(issuesOf([roleStep('combine', { lane: 'build', effort: 'high' })]).includes(
    'actions[0] combine steps must declare a deliverable: files (merging written work, build/high), data or media (build/medium), or report (condensing or comparing results, analyze/medium)',
  ));
  const checked = accept([roleStep('check', { affects: [], evidenceFor: ['result'] })]);
  assert.deepEqual(checked.evidenceFor, ['result']);
  assert.deepEqual(checked.deliverable, { type: 'report' });
});

test('a role step the role table cannot route reports its own issue, not a generic lane or effort one', () => {
  const generic = (issue) => /\.(lane|effort) must be/.test(issue);
  for (const [step, expected] of [
    [roleStep('combine'), 'actions[0] combine steps must declare a deliverable: files (merging written work, build/high), data or media (build/medium), or report (condensing or comparing results, analyze/medium)'],
    [roleStep('ship'), 'actions[0].role must be investigate|produce|transform|combine|check|act'],
    [roleStep('check', { deliverable: 'files' }), 'actions[0].deliverable files is not allowed for role check; check takes report'],
  ]) {
    const issues = issuesOf([step]);
    assert.ok(issues.includes(expected), issues.join('; '));
    assert.equal(issues.some(generic), false, issues.join('; '));
  }
  // A lane the step sets itself is still checked.
  assert.ok(issuesOf([roleStep('investigate', { lane: 'fast' })]).includes('actions[0].lane must be analyze|build|chore'));
});

test('explicit lane or effort outranks the role, and the role outranks defaults.effort', () => {
  const laneWins = accept([roleStep('transform', { deliverable: 'files', lane: 'build', ownedFiles: ['a.js'] })]);
  assert.deepEqual([laneWins.lane, laneWins.effort], ['build', 'low']);
  const effortWins = accept([roleStep('produce', { effort: 'high', ownedFiles: ['a.js'] })]);
  assert.deepEqual([effortWins.lane, effortWins.effort], ['build', 'high']);
  const roleWins = validateActionProgram({
    schemaVersion: 'bullswarm.workflow.program.v2',
    defaults: { effort: 'high' },
    actions: [roleStep('produce', { ownedFiles: ['a.js'] })],
  }, relaxed).actions[0];
  assert.deepEqual([roleWins.lane, roleWins.effort], ['build', 'medium']);
});

test('the resolved lane must fit the deliverable', () => {
  const expectIssue = (actions, message) => assert.ok(issuesOf(actions).includes(message), issuesOf(actions).join('; '));
  expectIssue(
    [kindWork('implement', { deliverable: 'report' })],
    'actions[0] a report deliverable is for analyze steps; build and chore steps deliver files, data or media',
  );
  expectIssue(
    [roleStep('investigate', { lane: 'build', ownedFiles: ['notes.md'] })],
    'actions[0] a report deliverable is for analyze steps; build and chore steps deliver files, data or media',
  );
  expectIssue(
    [roleStep('check', { lane: 'build' })],
    'actions[0] a report deliverable is for analyze steps; build and chore steps deliver files, data or media',
  );
  expectIssue(
    [kindWork('io-read', { deliverable: 'files', ownedFiles: [] })],
    'actions[0] a files deliverable needs lane build or chore; analyze steps are read-only',
  );
});

test('a matching role is deleted and the step matches the kind-only step', () => {
  for (const kind of ACTION_KINDS) {
    const role = KIND_ROLES[kind];
    const analyze = KIND_DEFAULTS[kind].lane === 'analyze';
    const peers = kind === 'digest' ? [kindWork('implement', { id: 'source' })] : [];
    const over = {
      ...(analyze ? { ownedFiles: [] } : {}),
      ...(kind === 'digest' ? { dependsOn: ['source'], affects: [] } : {}),
    };
    const withRole = accept([...peers, kindWork(kind, { ...over, role })], relaxed);
    const kindOnly = accept([...peers, kindWork(kind, over)], relaxed);
    assert.deepEqual(withRole, kindOnly, kind);
    if (analyze && kind !== 'digest') {
      const evidenceOver = { ownedFiles: [], affects: [], evidenceFor: ['result'] };
      assert.deepEqual(
        accept([kindWork(kind, { ...evidenceOver, role })]),
        accept([kindWork(kind, evidenceOver)]),
        `${kind} evidenceFor`,
      );
    }
  }
  assert.ok(issuesOf([kindWork('check', { role: 'produce', ownedFiles: [] })]).includes(
    'actions[0].role "produce" does not match kind "check" (kind check is role check); give one of them',
  ));
});

test('deliverable paths must be a subset of non-empty ownedFiles', () => {
  assert.ok(issuesOf([roleStep('produce', {
    deliverable: { type: 'data', paths: ['keep.js', 'a', 'b'] },
    ownedFiles: ['keep.js'],
  })]).includes('actions[0].deliverable.paths must be listed in ownedFiles (missing: a, b)'));
  const inside = accept([roleStep('produce', {
    deliverable: { type: 'data', paths: ['./out/a.json'] },
    ownedFiles: ['./out/a.json'],
  })]);
  assert.deepEqual(inside.deliverable, { type: 'data', paths: ['out/a.json'] });
  const open = accept([roleStep('produce', {
    deliverable: { type: 'data', paths: ['out/a.json'] },
    ownedFiles: [],
  })]);
  assert.deepEqual(open.deliverable, { type: 'data', paths: ['out/a.json'] });
});

test('role and deliverable need a program-mode run; kind-only verified programs stay put', () => {
  const verified = { mandatoryRequirements: ['result'], requireMandatoryEvidence: false, relaxedGraph: false };
  assert.ok(issuesOf([roleStep('investigate')], verified).includes('actions[0].role and deliverable need a program-mode run'));
  assert.ok(issuesOf([kindWork('implement', { deliverable: 'files' })], verified).includes('actions[0].role and deliverable need a program-mode run'));
  const kindOnly = validateActionProgram(LEGACY_FIXTURE, { mandatoryRequirements: ['report-correct'], relaxedGraph: false });
  assert.equal(JSON.stringify(kindOnly), LEGACY_FIXTURE_NORMALIZED);
});

test('every role and deliverable message has a case', () => {
  const has = (actions, message, runtime = relaxed) => {
    const issues = issuesOf(actions, runtime);
    assert.ok(issues.includes(message), `${message}\n---\n${issues.join('\n')}`);
  };
  has([roleStep('investigate')], 'actions[0].role and deliverable need a program-mode run', { mandatoryRequirements: ['result'], requireMandatoryEvidence: false });
  has([roleStep('investigate', { role: 'ship', lane: 'analyze', effort: 'medium' })], 'actions[0].role must be investigate|produce|transform|combine|check|act');
  has(
    [kindWork('implement', { role: 'check', ownedFiles: ['src/work-implement.js'] })],
    'actions[0].role "check" does not match kind "implement" (kind implement is role produce); give one of them',
  );
  has([kindWork('implement', { deliverable: 'nope' })], 'actions[0].deliverable must be files|report|data|media|outward, or an object {type, paths}');
  has([kindWork('implement', { deliverable: { type: 'files', note: true } })], 'actions[0].deliverable.note is not allowed');
  has([kindWork('implement', { deliverable: { type: 'data', paths: [] } })], 'actions[0].deliverable.paths is required for data');
  has([kindWork('implement', { deliverable: { type: 'media', paths: [] } })], 'actions[0].deliverable.paths is required for media');
  has([roleStep('investigate', { deliverable: { type: 'report', paths: ['r.md'] } })], 'actions[0].deliverable.paths is not allowed for report');
  has([roleStep('act', { deliverable: { type: 'outward', paths: ['x'] } })], 'actions[0].deliverable.paths is not allowed for outward');
  has(
    [roleStep('produce', { deliverable: { type: 'data', paths: ['a', 'b'] }, ownedFiles: ['a.js'] })],
    'actions[0].deliverable.paths must be listed in ownedFiles (missing: a, b)',
  );
  has([roleStep('check', { deliverable: 'files', lane: 'build' })], 'actions[0].deliverable files is not allowed for role check; check takes report');
  has([roleStep('act', { deliverable: 'files', lane: 'analyze' })], 'actions[0].deliverable files is not allowed for role act; act takes outward');
  has([roleStep('produce', { deliverable: 'outward', lane: 'analyze' })], 'actions[0].deliverable outward needs role act');
  has(
    [roleStep('combine', { lane: 'build', effort: 'high' })],
    'actions[0] combine steps must declare a deliverable: files (merging written work, build/high), data or media (build/medium), or report (condensing or comparing results, analyze/medium)',
  );
  has([kindWork('io-read', { deliverable: 'data', ownedFiles: [] })], 'actions[0] a data deliverable needs lane build or chore; analyze steps are read-only');
  has([kindWork('implement', { deliverable: 'outward' })], 'actions[0] a outward deliverable is for analyze steps; build and chore steps deliver files, data or media');
  has([roleStep('act', { lane: 'build', effort: 'medium' })], 'actions[0] act steps use lane analyze; they do not write workspace files');
  has([roleStep('act', { evidenceFor: ['result'], affects: [] })], 'actions[0] act steps must have empty ownedFiles and evidenceFor');
  has(
    [kindWork('digest', { deliverable: 'report', ownedFiles: [], affects: [], dependsOn: ['source'] }), kindWork('implement', { id: 'source' })].reverse(),
    'actions[1] digest actions take no deliverable; the kernel writes their report',
  );
  has([roleStep('investigate', { evidenceFor: ['result'], affects: [] })], 'actions[0] only check steps take evidenceFor');
  has(
    [kindWork('check', { deliverable: 'files', ownedFiles: [], affects: [], evidenceFor: ['result'] })],
    'actions[0] steps with evidenceFor take no deliverable other than report',
  );
  has(
    [kindWork('implement', { evidence: [{ type: 'review' }] })],
    'actions[0].evidence[0].type must be command or schema; review evidence is a check step with evidenceFor, and a choice is recorded by the caller',
  );
});

test('string deliverables normalise to objects and empty file paths are dropped', () => {
  assert.deepEqual(accept([roleStep('investigate', { deliverable: 'report' })]).deliverable, { type: 'report' });
  const dropped = accept([kindWork('implement', { deliverable: { type: 'files', paths: [] } })]);
  assert.deepEqual(dropped.deliverable, { type: 'files' });
  assert.equal(Object.hasOwn(dropped.deliverable, 'paths'), false);
  assert.ok(issuesOf([kindWork('implement', { deliverable: { type: 'data', paths: [] } })]).includes('actions[0].deliverable.paths is required for data'));
});

test('act is accepted when the goal forbids workspace mutation; outward is only for act', () => {
  const forbidden = { relaxedGraph: true, workspaceMutation: 'forbidden', requireMandatoryEvidence: false, mandatoryRequirements: ['result'] };
  const act = accept([roleStep('act')], forbidden);
  assert.equal(act.lane, 'analyze');
  assert.deepEqual(act.deliverable, { type: 'outward' });
  assert.equal(act.role, 'act');
  const rejected = issuesOf([roleStep('produce', { ownedFiles: ['a.js'] })], forbidden);
  assert.ok(rejected.some((issue) => issue.includes('must use analyze because the goal forbids workspace mutation')));
  assert.ok(issuesOf([roleStep('transform', { deliverable: 'outward', lane: 'analyze' })]).includes('actions[0].deliverable outward needs role act'));
});

test('evidence is accepted, and proofs is still an unknown field', () => {
  assert.deepEqual(accept([kindWork('implement', { evidence: [{ type: 'command', cmd: 'npm test' }] })]).evidence, [{ type: 'command', cmd: 'npm test' }]);
  assert.ok(issuesOf([kindWork('implement', { evidence: { type: 'review' } })]).includes('actions[0].evidence must be an array of at most 5 items'));
  assert.ok(issuesOf([kindWork('implement', { proofs: ['review'] })]).includes('actions[0].proofs is not allowed'));
});

test('normalising a role-only program and a mixed program twice is a fixed point', () => {
  const roleProgram = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      roleStep('produce', { id: 'make', ownedFiles: ['src/make.js'], deliverable: { type: 'files', paths: ['./src/make.js'] } }),
      roleStep('check', { id: 'look', dependsOn: ['make'], affects: [], evidenceFor: ['result'] }),
    ],
  };
  const once = validateActionProgram(roleProgram, relaxed);
  assert.equal(JSON.stringify(validateActionProgram(once, relaxed)), JSON.stringify(once));
  assert.deepEqual(once.actions[0].deliverable, { type: 'files', paths: ['src/make.js'] });
  const mixed = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      kindWork('implement', { id: 'impl', role: 'produce' }),
      roleStep('investigate', { id: 'read' }),
    ],
  };
  const mixedOnce = validateActionProgram(mixed, relaxed);
  assert.equal(JSON.stringify(validateActionProgram(mixedOnce, relaxed)), JSON.stringify(mixedOnce));
  assert.equal(Object.hasOwn(mixedOnce.actions[0], 'role'), false);
  assert.equal(mixedOnce.actions[1].role, 'investigate');
  assert.deepEqual(mixedOnce.actions[1].deliverable, { type: 'report' });
});

test('three produce steps at high effort raise all-writers-high', () => {
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: ['a', 'b', 'c'].map((id) => roleStep('produce', { id, effort: 'high', ownedFiles: [`${id}.js`] })),
  };
  assert.deepEqual(programAdvisories(program).map((advisory) => advisory.code), ['all-writers-high']);
});

test('a role step gets one message for one mistake, not a cascade from the role defaults', () => {
  const stepIssues = (actions) => issuesOf(actions).filter((issue) => issue.startsWith('actions[0]'));
  // act with a non-outward deliverable resolves no lane; the author set none.
  for (const deliverable of ['report', 'files', { type: 'data', paths: ['out/a.json'] }, { type: 'media', paths: ['out/a.png'] }]) {
    const type = typeof deliverable === 'string' ? deliverable : deliverable.type;
    assert.deepEqual(stepIssues([roleStep('act', { deliverable })]), [
      `actions[0].deliverable ${type} is not allowed for role act; act takes outward`,
    ]);
  }
  // An explicit wrong lane on act is still the author's to fix.
  assert.ok(stepIssues([roleStep('act', { lane: 'build' })]).includes('actions[0] act steps use lane analyze; they do not write workspace files'));
  // evidenceFor on a non-check role with no declared deliverable and no lane.
  for (const role of ['investigate', 'produce', 'transform']) {
    assert.deepEqual(stepIssues([roleStep(role, { evidenceFor: ['result'], affects: [] })]), [
      'actions[0] only check steps take evidenceFor',
    ], role);
  }
  assert.deepEqual(stepIssues([roleStep('act', { evidenceFor: ['result'], affects: [] })]), [
    'actions[0] act steps must have empty ownedFiles and evidenceFor',
  ]);
  // A deliverable or lane the author did write is still judged.
  assert.ok(stepIssues([roleStep('produce', { evidenceFor: ['result'], affects: [], deliverable: 'files' })])
    .includes('actions[0] steps with evidenceFor take no deliverable other than report'));
  assert.ok(stepIssues([roleStep('produce', { evidenceFor: ['result'], affects: [], lane: 'build' })])
    .includes('actions[0] evidence actions must use lane analyze'));
});

test('kind and role match only through a real kind; prototype keys are unknown kinds', () => {
  for (const kind of ['bogus', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const issues = issuesOf([kindWork(kind, { role: 'produce' })]);
    assert.ok(issues.includes(`actions[0].kind must be ${ACTION_KINDS.join('|')}`), kind);
    assert.equal(issues.some((issue) => issue.includes('does not match kind')), false, `${kind}: ${issues.join(' / ')}`);
  }
  assert.ok(issuesOf([kindWork('implement', { role: 'check' })]).includes(
    'actions[0].role "check" does not match kind "implement" (kind implement is role produce); give one of them',
  ));
});

test('a data or media deliverable with non-array paths says must be an array, like files', () => {
  for (const type of ['data', 'media', 'files']) {
    for (const paths of ['out/a.png', null, { a: 1 }]) {
      const issues = issuesOf([roleStep('produce', { deliverable: { type, paths } })]);
      assert.ok(issues.includes('actions[0].deliverable.paths must be an array'), `${type} ${JSON.stringify(paths)}: ${issues.join(' / ')}`);
      assert.equal(issues.includes(`actions[0].deliverable.paths is required for ${type}`), false);
    }
  }
  for (const type of ['data', 'media']) {
    assert.ok(issuesOf([roleStep('produce', { deliverable: { type } })]).includes(`actions[0].deliverable.paths is required for ${type}`));
    assert.ok(issuesOf([roleStep('produce', { deliverable: { type, paths: [] } })]).includes(`actions[0].deliverable.paths is required for ${type}`));
  }
});

// --- evidence (stage 2) -------------------------------------------------------

const command = (cmd = 'node --test tests/slug.test.js', over = {}) => ({ type: 'command', cmd, ...over });
const schemaItem = (over = {}) => ({ type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', ...over });
const evidenceIssues = (evidence, over = {}, runtime = relaxed) => issuesOf([kindWork('implement', { evidence, ...over })], runtime);
const hasIssue = (issues, message) => assert.ok(issues.includes(message), `${message}\n---\n${issues.join('\n')}`);

test('evidence shapes normalise: cmd trimmed, paths normalised, author keys kept, defaults not written back', () => {
  const step = accept([kindWork('implement', {
    evidence: [
      { cmd: '  node --test tests/slug.test.js  ', type: 'command' },
      command('npm run lint', { timeoutSec: 600 }),
      schemaItem({ file: './out//events.json', schema: 'schemas//event.json', timeoutSec: 1 }),
      schemaItem({ file: 'out/rows.jsonl', format: 'jsonl' }),
      schemaItem({ file: '$output', schema: 'schemas/report.json' }),
    ],
  })]);
  assert.deepEqual(step.evidence, [
    { type: 'command', cmd: 'node --test tests/slug.test.js' },
    { type: 'command', cmd: 'npm run lint', timeoutSec: 600 },
    { type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', timeoutSec: 1 },
    { type: 'schema', file: 'out/rows.jsonl', schema: 'schemas/event.json', format: 'jsonl' },
    { type: 'schema', file: '$output', schema: 'schemas/report.json' },
  ]);
  assert.equal(Object.hasOwn(step.evidence[0], 'timeoutSec'), false);
  assert.equal(Object.hasOwn(step.evidence[2], 'format'), false);
  assert.equal(Object.hasOwn(step.evidence[4], 'format'), false);
});

test('normalising a program with evidence twice is a fixed point, and evidence: [] is dropped', () => {
  const input = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      kindWork('implement', { id: 'make', evidence: [command(' npm test '), schemaItem({ file: './out/a.json', format: 'json' })] }),
      roleStep('check', { id: 'gate', dependsOn: ['make'], affects: [], evidence: [command('npm run e2e', { timeoutSec: 300 })] }),
      kindWork('implement', { id: 'plain', evidence: [] }),
    ],
  };
  const once = validateActionProgram(input, relaxed);
  assert.equal(JSON.stringify(validateActionProgram(once, relaxed)), JSON.stringify(once));
  assert.deepEqual(once.actions[0].evidence, [{ type: 'command', cmd: 'npm test' }, { type: 'schema', file: 'out/a.json', schema: 'schemas/event.json', format: 'json' }]);
  assert.equal(Object.hasOwn(once.actions[2], 'evidence'), false);
  const withoutField = validateActionProgram({ ...input, actions: [input.actions[0], input.actions[1], kindWork('implement', { id: 'plain' })] }, relaxed);
  assert.equal(JSON.stringify(withoutField), JSON.stringify(once));
  // The caller's input is never mutated.
  assert.equal(input.actions[0].evidence[0].cmd, ' npm test ');
});

test('an action without evidence normalises exactly as before', () => {
  const step = accept([kindWork('implement')]);
  assert.equal(Object.hasOwn(step, 'evidence'), false);
});

test('evidence needs a program-mode run; digest and review steps refuse it', () => {
  const verified = { mandatoryRequirements: ['result'], requireMandatoryEvidence: false };
  hasIssue(evidenceIssues([command()], {}, verified), 'actions[0].evidence needs a program-mode run');
  // An empty list is dropped wherever it appears.
  assert.equal(Object.hasOwn(accept([kindWork('implement', { evidence: [] })], verified), 'evidence'), false);
  hasIssue(
    issuesOf([kindWork('implement', { id: 'source' }), kindWork('digest', { dependsOn: ['source'], ownedFiles: [], affects: [], evidence: [command()] })]),
    'actions[1] digest steps take no evidence; the kernel writes their report',
  );
  hasIssue(
    issuesOf([roleStep('check', { affects: [], evidenceFor: ['result'], evidence: [command()] })]),
    'actions[0] review steps (evidenceFor) take no evidence; put the commands the reviewer must run in its prompt',
  );
  hasIssue(
    issuesOf([kindWork('check', { ownedFiles: [], affects: [], evidenceFor: ['result'], evidence: [schemaItem()] })]),
    'actions[0] review steps (evidenceFor) take no evidence; put the commands the reviewer must run in its prompt',
  );
});

test('kind steps, act steps and a check step without evidenceFor accept evidence', () => {
  assert.equal(accept([kindWork('mechanical', { evidence: [command()] })]).evidence.length, 1);
  assert.equal(accept([kindWork('io-read', { ownedFiles: [], evidence: [schemaItem({ file: '$output' })] })]).evidence.length, 1);
  const act = accept([roleStep('act', { evidence: [command("grep -q 'confirmed 42' /tmp/outbox.txt")] })]);
  assert.equal(act.role, 'act');
  assert.deepEqual(act.evidence, [{ type: 'command', cmd: "grep -q 'confirmed 42' /tmp/outbox.txt" }]);
  const gate = accept([roleStep('check', { affects: [], evidence: [command('npm test', { timeoutSec: 600 })] })]);
  assert.deepEqual(gate.evidenceFor, []);
  assert.deepEqual(gate.evidence, [{ type: 'command', cmd: 'npm test', timeoutSec: 600 }]);
  assert.equal(accept([kindWork('check', { ownedFiles: [], affects: [], evidence: [command()] })]).evidence.length, 1);
});

test('every evidence field message', () => {
  hasIssue(evidenceIssues({ type: 'command', cmd: 'x' }), 'actions[0].evidence must be an array of at most 5 items');
  hasIssue(evidenceIssues('npm test'), 'actions[0].evidence must be an array of at most 5 items');
  hasIssue(evidenceIssues([1, 2, 3, 4, 5, 6].map((n) => command(`echo ${n}`))), 'actions[0].evidence must be an array of at most 5 items');
  assert.equal(accept([kindWork('implement', { evidence: [1, 2, 3, 4, 5].map((n) => command(`echo ${n}`)) })]).evidence.length, 5);
  hasIssue(evidenceIssues(['npm test']), 'actions[0].evidence[0] must be an object {type, …}');
  hasIssue(evidenceIssues([command(), null]), 'actions[0].evidence[1] must be an object {type, …}');
  const typeMessage = (k) => `actions[0].evidence[${k}].type must be command or schema; review evidence is a check step with evidenceFor, and a choice is recorded by the caller`;
  hasIssue(evidenceIssues([{ type: 'review' }]), typeMessage(0));
  hasIssue(evidenceIssues([command(), { type: 'choice', note: 'ok' }]), typeMessage(1));
  hasIssue(evidenceIssues([{ cmd: 'npm test' }]), typeMessage(0));
  hasIssue(evidenceIssues([command('npm test', { file: 'a.json' })]), 'actions[0].evidence[0].file is not allowed for a command item');
  hasIssue(evidenceIssues([command('npm test', { format: 'json' })]), 'actions[0].evidence[0].format is not allowed for a command item');
  hasIssue(evidenceIssues([schemaItem({ cmd: 'npm test' })]), 'actions[0].evidence[0].cmd is not allowed for a schema item');
  hasIssue(evidenceIssues([schemaItem({ expectExit: 1 })]), 'actions[0].evidence[0].expectExit is not allowed for a schema item');
  const cmdMessage = 'actions[0].evidence[0].cmd must be one line of 1 to 2000 bytes';
  for (const cmd of [undefined, '', '   ', 'npm test\nnpm run lint', 'npm test\rx', 'a\0b', 'x'.repeat(2001), 'é'.repeat(1001), 42]) {
    hasIssue(evidenceIssues([cmd === undefined ? { type: 'command' } : command(cmd)]), cmdMessage);
  }
  assert.equal(accept([kindWork('implement', { evidence: [command('x'.repeat(2000))] })]).evidence[0].cmd.length, 2000);
  assert.equal(accept([kindWork('implement', { evidence: [command(`  ${'x'.repeat(2000)}  `)] })]).evidence[0].cmd.length, 2000);
  hasIssue(evidenceIssues([schemaItem({ format: 'yaml' })]), 'actions[0].evidence[0].format must be json or jsonl');
  const timeoutMessage = 'actions[0].evidence[0].timeoutSec must be an integer from 1 to 600 (default 120)';
  for (const timeoutSec of [0, 601, 1.5, '120', null, -1]) {
    hasIssue(evidenceIssues([command('npm test', { timeoutSec })]), timeoutMessage);
    hasIssue(evidenceIssues([schemaItem({ timeoutSec })]), timeoutMessage);
  }
  hasIssue(evidenceIssues([command('npm test', { timeoutSec: 601 })]), timeoutMessage);
});

test('evidence file and schema paths use the ownedFiles rules; $output is kept verbatim', () => {
  assert.equal(accept([kindWork('implement', { evidence: [schemaItem({ file: '$output' })] })]).evidence[0].file, '$output');
  assert.equal(accept([kindWork('implement', { evidence: [schemaItem({ file: '$outputs' })] })]).evidence[0].file, '$outputs');
  assert.equal(accept([kindWork('implement', { evidence: [schemaItem({ file: '$output/x' })] })]).evidence[0].file, '$output/x');
  hasIssue(
    evidenceIssues([schemaItem({ file: './$output' })]),
    'actions[0].evidence[0].file "./$output" names a workspace file called $output; write "$output" exactly for your final response',
  );
  for (const [field, label] of [['file', 'file'], ['schema', 'schema']]) {
    const at = `actions[0].evidence[0].${label}`;
    hasIssue(evidenceIssues([schemaItem({ [field]: undefined })]), `${at} must be a non-empty relative path`);
    hasIssue(evidenceIssues([schemaItem({ [field]: '' })]), `${at} must be a non-empty relative path`);
    hasIssue(evidenceIssues([schemaItem({ [field]: '/etc/passwd' })]), `${at} must be relative`);
    hasIssue(evidenceIssues([schemaItem({ [field]: '../up.json' })]), `${at} must not contain dot-dot traversal`);
    hasIssue(evidenceIssues([schemaItem({ [field]: 'out/*.json' })]), `${at} must name one exact file, not a directory or glob ("out/*.json")`);
    hasIssue(evidenceIssues([schemaItem({ [field]: 'out/' })]), `${at} must name one exact file, not a directory or glob ("out/")`);
    hasIssue(evidenceIssues([schemaItem({ [field]: 'a\0b' })]), `${at} must not contain NUL bytes`);
  }
  // The reserved value is only for file; a schema literally named $output is an ordinary path.
  assert.equal(accept([kindWork('implement', { evidence: [schemaItem({ schema: '$output' })] })]).evidence[0].schema, '$output');
});

test('evidenceAllowed: false refuses any non-empty evidence with the dispatched-planner message', () => {
  const planner = { ...relaxed, evidenceAllowed: false };
  hasIssue(
    evidenceIssues([command()], {}, planner),
    "actions[0].evidence is the caller's to declare; a dispatched planner cannot add checks (the caller adds them with bullswarm workflow plan revise)",
  );
  assert.equal(Object.hasOwn(accept([kindWork('implement', { evidence: [] })], planner), 'evidence'), false);
  assert.equal(accept([kindWork('implement', { evidence: [command()] })], { ...relaxed, evidenceAllowed: true }).evidence.length, 1);
});

test('a top-level timeoutSec points to the evidence item', () => {
  const issues = issuesOf([kindWork('implement', { timeoutSec: 300 })]);
  hasIssue(issues, 'actions[0].timeoutSec is not allowed in V2; a time limit belongs on an evidence item (evidence[].timeoutSec)');
  hasIssue(issuesOf([kindWork('implement', { pool: 'acme' })]), 'actions[0].pool is not allowed in V2');
});
