// Shared fixtures for the program v3 tests (0.37.0 wave A). Made-up names
// only. `section2Example` is the example program from the 0.37.0 design,
// section 2, with its placeholders filled in; `v2V3Fixtures` holds the v2
// inputs whose outputs must stay byte-identical once v3 exists.

export function section2Example() {
  return {
    schemaVersion: 'bullswarm.workflow.program.v3',
    defaults: { lane: 'analyze', effort: 'medium', retry: 1, timeBox: 30 },
    steps: [
      {
        id: 'search-a', phase: 'research', prompt: 'Search the acme archive for claims about the widget launch.',
        answer: { type: 'object', required: ['claims'], properties: { claims: { type: 'array' } } },
      },
      {
        id: 'search-b', phase: 'research', prompt: 'Search the initech archive for claims about the widget launch.',
        answer: { type: 'object', required: ['claims'], properties: { claims: { type: 'array' } } },
      },
      {
        id: 'merge', phase: 'research', dependsOn: ['search-a', 'search-b'],
        prompt: 'Merge both claim lists into brief.md.',
        deliverable: { type: 'files', paths: ['brief.md'] }, lane: 'build',
      },
      {
        id: 'critique', phase: 'quality', dependsOn: ['merge'], route: { independentOf: ['merge'] },
        answer: {
          type: 'object', required: ['passed', 'problems'],
          properties: { passed: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
        },
        prompt: 'Critique brief.md and list its problems.',
      },
      {
        id: 'revise', phase: 'quality', dependsOn: ['critique'], lane: 'build', files: ['brief.md'],
        prompt: 'Fix the problems the critique listed in brief.md.',
      },
      {
        id: 'post', phase: 'publish', dependsOn: ['approve'], deliverable: 'outward', retry: 0,
        prompt: 'Post brief.md to the acme board.',
      },
    ],
    loops: [{ id: 'polish', steps: ['critique', 'revise'], until: { step: 'critique', field: 'passed' }, maxRounds: 3 }],
    gates: [{ id: 'approve', dependsOn: ['polish'], note: 'Read brief.md and decide whether to publish' }],
  };
}

// A one-step v3 program with an answer and no gates or loops: what wave A
// launches.
export function oneStepV3(over = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{
      id: 'count', prompt: 'Count the markdown files in this folder.',
      answer: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
      ...over,
    }],
  };
}

const v2Action = (id, over = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Implement ${id} and run its focused checks.`, lane: 'build', effort: 'low',
  evidenceFor: [], inputs: [], produces: [], ...over,
});

export function v2V3Fixtures() {
  const actions = [
    v2Action('write', { kind: 'implement', evidence: [{ type: 'command', cmd: 'node --test tests/write.test.js' }] }),
    v2Action('shape', { dependsOn: ['write'], role: 'produce', deliverable: { type: 'files', paths: ['shape.txt'] }, ownedFiles: ['shape.txt'], lane: undefined, effort: undefined }),
    {
      id: 'review', purpose: 'Review the delivered files', dependsOn: ['write', 'shape'], affects: [], ownedFiles: [],
      prompt: 'Review write.txt and shape.txt against the requirement.', kind: 'check', evidenceFor: ['deliver'],
      inputs: [], produces: [], route: { independentOf: ['write'] },
    },
  ].map((action) => Object.fromEntries(Object.entries(action).filter(([, value]) => value !== undefined)));
  const v2Program = { schemaVersion: 'bullswarm.workflow.program.v2', defaults: { timeBox: 20 }, actions };
  return {
    v2Program,
    // The v3 fields a v2 program must keep refusing, word for word.
    v2WithV3Fields: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{ ...actions[0], phase: 'build', answer: { type: 'object' }, retry: 0, files: ['write.txt'], label: 'Write' }],
    },
    runtime: {
      requirements: [{ id: 'deliver', mandatory: true }], relaxedGraph: true, requireMandatoryEvidence: false,
      enforceMaxActions: false, enforceMaxParallel: false,
    },
    goal: {
      goal: 'Deliver the requested files', cwd: '/tmp/acme-repo',
      requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
      settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
    },
    response: {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write, shape and review.',
      program: v2Program,
    },
  };
}
