import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_KINDS, ActionValidationError, DEFAULT_EFFORT_BY_LANE, KIND_DEFAULTS,
  PROGRAM_ADVISORY_CODES, programAdvisories, validateActionProgram,
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
  assert.deepEqual(ACTION_KINDS, ['mechanical', 'io-read', 'check', 'implement', 'integration', 'architecture', 'adversarial-acceptance']);
  assert.deepEqual(KIND_DEFAULTS, {
    mechanical: { lane: 'chore', effort: 'low' },
    'io-read': { lane: 'analyze', effort: 'low' },
    check: { lane: 'analyze', effort: 'medium' },
    implement: { lane: 'build', effort: 'medium' },
    integration: { lane: 'build', effort: 'high' },
    architecture: { lane: 'analyze', effort: 'high' },
    'adversarial-acceptance': { lane: 'analyze', effort: 'high' },
  });
  for (const [kind, expected] of Object.entries(KIND_DEFAULTS)) {
    // An analyze kind cannot own workspace files, so drop ownedFiles for those.
    const over = expected.lane === 'analyze' ? { ownedFiles: [] } : {};
    const [action] = validateActionProgram(
      { schemaVersion: 'bullswarm.workflow.program.v2', actions: [kindWork(kind, over)] },
      relaxed,
    ).actions;
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

test('program defaults allow only effort and reasoning', () => {
  const withDefaults = (defaults) => validateActionProgram(
    { schemaVersion: 'bullswarm.workflow.program.v2', defaults, actions: [kindWork('implement')] },
    relaxed,
  );
  assert.throws(() => withDefaults({ lane: 'build' }), (error) => error.issues.includes('program.defaults.lane is not allowed; only effort and reasoning'));
  assert.throws(() => withDefaults({ kind: 'implement' }), (error) => error.issues.includes('program.defaults.kind is not allowed; only effort and reasoning'));
  assert.throws(() => withDefaults({ effort: 'ultra' }), (error) => error.issues.includes('program.defaults.effort must be high|medium|low'));
  assert.throws(() => withDefaults({ reasoning: 'ultra' }), (error) => error.issues.includes('program.defaults.reasoning must be low|medium|high|xhigh|max|default'));
  assert.throws(() => withDefaults('high'), (error) => error.issues.includes('program.defaults must be an object'));
  assert.equal(withDefaults({ effort: 'low', reasoning: 'low' }).actions.length, 1);
  // `defaults` is resolved into the actions, never echoed into the accepted
  // program, so the durable program schema is unchanged.
  assert.deepEqual(Object.keys(withDefaults({ effort: 'low' })), ['schemaVersion', 'actions']);
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

test('advisories report the two effort smells and never change validity', () => {
  assert.deepEqual([...PROGRAM_ADVISORY_CODES], ['all-writers-high', 'docs-at-high']);
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
