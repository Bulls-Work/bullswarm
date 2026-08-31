import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelegateInvocation, classifyTask, cmdDelegate, inferLane,
} from '../src/delegate.js';

test('task classifier keeps one bounded outcome on a single agent', () => {
  const explanation = classifyTask({ task: 'Explain src/workflow/result.js and cite the exported functions.' });
  assert.equal(explanation.mode, 'single');
  assert.equal(explanation.lane, 'analyze');
  assert.match(explanation.reason, /one bounded outcome/);
  assert.deepEqual(explanation.phases.map((phase) => phase.name), ['Delegate']);

  const localizedFix = classifyTask({ task: 'Fix the typo in README.md and run the focused markdown check.' });
  assert.equal(localizedFix.mode, 'single');
  assert.equal(localizedFix.lane, 'build');

  const longButBounded = classifyTask({
    task: `Explain the ownership and failure behavior of src/workflow/result.js for a reviewer who has not seen the repository before. ${'Include relevant context without changing files. '.repeat(16)}`,
  });
  assert.equal(longButBounded.mode, 'single');

  const readOnly = classifyTask({ task: 'Read-only: inspect the CLI and do not modify any files.' });
  assert.equal(readOnly.mode, 'single');
  assert.equal(readOnly.lane, 'analyze');

  for (const task of [
    'Read-only: inspect how to add a new connector; do not change files.',
    'Do not modify files; explain the add-connector process.',
    'Do not add, create, or delete any files; explain the workflow.',
    'Do not add or create anything; only inspect and report.',
    'Inspect how to add a connector without changing code or files.',
  ]) {
    const decision = classifyTask({ task });
    assert.equal(decision.lane, 'analyze', task);
  }

  const mixedIntent = classifyTask({ task: 'Do not modify tests; implement the production fix.' });
  assert.equal(mixedIntent.lane, 'build', 'a scoped prohibition must not hide a later positive mutation');
});

test('task classifier selects workflows for explicit deliverables and coordination', () => {
  const numbered = classifyTask({ task: `Improve the release flow.
1. Implement the command.
2. Add focused tests.
3. Update documentation.
Finally independently verify the release.` });
  assert.equal(numbered.mode, 'workflow');
  assert.equal(numbered.lane, null);
  assert.match(numbered.reason, /numbered deliverables/);
  assert.deepEqual(numbered.phases.map((phase) => phase.name), ['Discover', 'Execute', 'Verify', 'Deliver']);

  const broad = classifyTask({ task: 'Audit every command and subcommand for rich help, then report the gaps.' });
  assert.equal(broad.mode, 'workflow');
  assert.match(broad.reason, /broad repeated inspection/);

  const inline = classifyTask({ task: 'Deliver the interface. 1. Classify requests. 2. Show the plan. 3. Execute the selected engine.' });
  assert.equal(inline.mode, 'workflow');
  assert.match(inline.reason, /3 numbered deliverables/);

  const lifecycle = classifyTask({ task: 'Implement the feature, add tests, update docs, and independently verify it.' });
  assert.equal(lifecycle.mode, 'workflow');
});

test('explicit mode and lane overrides are transparent and validated', () => {
  const forced = classifyTask({ task: 'Explain one file.', mode: 'workflow', lane: 'chore' });
  assert.equal(forced.mode, 'workflow');
  assert.equal(forced.source, 'caller-override');
  assert.equal(forced.confidence, 'high');
  assert.match(forced.reason, /explicitly selected workflow/);
  assert.throws(() => classifyTask({ task: 'x', mode: 'many' }), /--mode/);
  assert.throws(() => classifyTask({ task: 'x', lane: 'fast' }), /--lane/);
  assert.equal(inferLane('Convert this table to CSV.'), 'chore');
});

test('delegate invocation sends the conceptual plan to workflow goal', () => {
  const decision = classifyTask({
    task: 'Implement, document, and independently verify the new API.',
    mode: 'workflow',
    plan: 'Discover; implement; verify; deliver.',
  });
  const invocation = buildDelegateInvocation(decision, { task: 'Do the work.', cwd: '/tmp' });
  assert.equal(invocation.verb, 'workflow');
  assert.deepEqual(invocation.argv.slice(0, 2), ['workflow', 'goal']);
  assert.equal(invocation.argv[invocation.argv.indexOf('--suggested-plan') + 1], decision.suggestedPlan);

  const single = buildDelegateInvocation(classifyTask({ task: 'Review this diff.' }), {
    task: 'Review this diff.', cwd: '/tmp', effort: 'low', timeout: 30, noCaller: true,
  });
  assert.equal(single.verb, 'run');
  assert.ok(single.argv.includes('--no-caller'));
  assert.equal(single.argv[single.argv.indexOf('--effort') + 1], 'low');
});

test('delegate dry-run explains the deterministic choice without executing work', async () => {
  const out = [];
  const calls = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: 'auto', cwd: '/tmp', 'dry-run': true, json: true, rest: [],
  }, {
    execute: async (argv) => {
      calls.push(argv);
      return {
        status: 0,
        stdout: JSON.stringify({ response: '{"mode":"single","reason":"Still bounded."}' }),
        stderr: '',
      };
    },
    writeOut: (value) => out.push(value),
    writeErr: (value) => out.push(value),
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[0][calls[0].indexOf('--lane') + 1], 'analyze');
  const envelope = JSON.parse(out.join('\n'));
  assert.equal(envelope.action, 'planned');
  assert.equal(envelope.decision.mode, 'single');
  assert.equal(envelope.decision.source, 'llm-classifier');
  assert.equal(envelope.execution, undefined);
});

test('delegate rejects malformed values before dispatch', async () => {
  for (const [overrides, message] of [
    [{ prompt: true }, /--prompt requires a value/],
    [{ effort: 'maximum' }, /--effort/],
    [{ timeout: 'never' }, /--timeout/],
    [{ cwd: '/definitely/not/a/bullswarm/directory' }, /--cwd/],
  ]) {
    const errors = [];
    let executed = false;
    const status = await cmdDelegate({
      prompt: 'Explain one module.', cwd: '/tmp', 'dry-run': true, rest: [], ...overrides,
    }, {
      execute: async () => { executed = true; return { status: 0, stdout: '{}', stderr: '' }; },
      writeOut: () => {},
      writeErr: (value) => errors.push(value),
    });
    assert.equal(status, 2);
    assert.equal(executed, false);
    assert.match(errors.join('\n'), message);
  }
});

test('delegate execution returns one composable envelope for both engines', async () => {
  for (const [mode, childResult] of [
    ['single', { ok: true, why: 'verified', outFile: '/tmp/out.md' }],
    ['workflow', { action: 'goal-launched', shortId: 'abc234', observe: { watch: 'bullswarm workflow watch abc234' } }],
  ]) {
    const out = [];
    let argv = null;
    const status = await cmdDelegate({
      prompt: 'Complete the bounded request.', mode, cwd: '/tmp', json: true, rest: [],
    }, {
      execute: async (value) => {
        argv = value;
        return { status: 0, stdout: JSON.stringify(childResult), stderr: '' };
      },
      writeOut: (value) => out.push(value),
      writeErr: (value) => out.push(value),
    });
    assert.equal(status, 0);
    const envelope = JSON.parse(out.join('\n'));
    assert.equal(envelope.decision.mode, mode);
    assert.deepEqual(envelope.execution, childResult);
    assert.equal(argv[0], mode === 'single' ? 'run' : 'workflow');
  }
});

test('human output reports caller fallback before the generic ok flag', async () => {
  const out = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: 'single', cwd: '/tmp', rest: [],
  }, {
    execute: async () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, keepOnClaude: true, why: 'caller has the best eligible route' }),
      stderr: '',
    }),
    writeOut: (value) => out.push(value),
    writeErr: (value) => out.push(value),
  });
  assert.equal(status, 0);
  assert.match(out.join('\n'), /Delegate result · keep on caller/);
  assert.doesNotMatch(out.join('\n'), /Delegate result · verified/);
});

// --- LLM-refined classification (R2) ----------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function classificationFixture(content) {
  const outFile = join(mkdtempSync(join(tmpdir(), 'bullswarm-classify-')), 'out.md');
  writeFileSync(outFile, content);
  return outFile;
}

test('auto mode refines the deterministic guess through one analyze/low classification dispatch', async () => {
  const outFile = classificationFixture('{"mode":"workflow","reason":"Hidden coordination across services."}');
  const calls = [];
  const out = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: 'auto', cwd: '/tmp', json: true, rest: [],
  }, {
    execute: async (argv) => {
      calls.push(argv);
      if (calls.length === 1) {
        return { status: 0, stdout: JSON.stringify({ ok: true, why: 'verified', outFile }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify({ action: 'goal-launched', shortId: 'abc123' }), stderr: '' };
    },
    writeOut: (value) => out.push(value),
    writeErr: (value) => out.push(value),
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  const [classification, main] = calls;
  assert.equal(classification[0], 'run');
  assert.equal(classification[classification.indexOf('--lane') + 1], 'analyze');
  assert.equal(classification[classification.indexOf('--effort') + 1], 'low');
  assert.equal(classification[classification.indexOf('--timeout') + 1], '90');
  assert.ok(classification.includes('--no-caller'));
  const prompt = classification[classification.indexOf('--prompt') + 1];
  assert.match(prompt, /Explain one module\./);
  assert.match(prompt, /Deterministic guess: single/);
  assert.match(prompt, /Deterministic score: 0/);
  assert.match(prompt, /Deterministic signals: \(none\)/);
  assert.match(prompt, /\{"mode":"single"\|"workflow","reason":"<one short sentence>"\}/);
  assert.equal(main[0], 'workflow');
  const envelope = JSON.parse(out.join('\n'));
  assert.equal(envelope.decision.mode, 'workflow');
  assert.equal(envelope.decision.source, 'llm-classifier');
  assert.equal(envelope.decision.reason, 'Hidden coordination across services.');
  assert.deepEqual(envelope.decision.deterministic, {
    mode: 'single',
    score: 0,
    signals: [],
    reason: 'This request has one bounded outcome and does not need a planning round or multiple coordinated agents.',
  });
});

test('classification failures visibly fall back to the deterministic decision', async () => {
  const failures = [
    ['timeout with empty output', async () => ({
      status: 1,
      stdout: JSON.stringify({ ok: false, why: 'timeout after 90s', outFile: classificationFixture('') }),
      stderr: '',
    })],
    ['unusable non-JSON answer', async () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, outFile: classificationFixture('maybe single? maybe not.') }),
      stderr: '',
    })],
    ['dispatch rejection', async () => { throw new Error('spawn failed'); }],
    ['no pool available (keep-on-caller)', async () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, keepOnClaude: true, why: 'caller has the best eligible route' }),
      stderr: '',
    })],
    ['non-JSON verdict', async () => ({ status: 0, stdout: 'not json', stderr: '' })],
  ];
  for (const [label, first] of failures) {
    const calls = [];
    const out = [];
    const status = await cmdDelegate({
      prompt: 'Explain one module.', mode: 'auto', cwd: '/tmp', json: true, rest: [],
    }, {
      execute: async (argv) => {
        calls.push(argv);
        if (calls.length === 1) return first();
        return { status: 0, stdout: JSON.stringify({ ok: true, why: 'verified', outFile: '/tmp/out.md' }), stderr: '' };
      },
      writeOut: (value) => out.push(value),
      writeErr: (value) => out.push(value),
    });
    assert.equal(status, 0, label);
    assert.equal(calls.length, 2, label);
    assert.equal(calls[1][0], 'run', label);
    const envelope = JSON.parse(out.join('\n'));
    assert.equal(envelope.decision.mode, 'single', label);
    assert.equal(envelope.decision.source, 'deterministic-classifier', label);
    assert.equal(envelope.decision.classifier.attempted, true, label);
    assert.equal(envelope.decision.classifier.outcome, 'fallback', label);
    assert.match(envelope.decision.classifier.why, /classification|spawn failed|non-JSON|no delegate pool|timeout/, label);
  }
});

test('--classify=deterministic never dispatches a classification request', async () => {
  const calls = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: 'auto', classify: 'deterministic', cwd: '/tmp', json: true, rest: [],
  }, {
    execute: async (argv) => {
      calls.push(argv);
      return { status: 0, stdout: JSON.stringify({ ok: true, why: 'verified' }), stderr: '' };
    },
    writeOut: () => {},
    writeErr: () => {},
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'run');
});

test('explicit mode never dispatches classification, even with --classify=llm', async () => {
  for (const mode of ['single', 'workflow']) {
    const calls = [];
    const status = await cmdDelegate({
      prompt: 'Explain one module.', mode, classify: 'llm', cwd: '/tmp', json: true, rest: [],
    }, {
      execute: async (argv) => {
        calls.push(argv);
        return { status: 0, stdout: JSON.stringify({ ok: true, action: 'goal-launched' }), stderr: '' };
      },
      writeOut: () => {},
      writeErr: () => {},
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], mode === 'single' ? 'run' : 'workflow');
  }
});

test('pinned re-execute with an explicit preview mode never re-classifies', async () => {
  const preview = classifyTask({ task: 'Explain one module.' });
  const calls = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: preview.mode, cwd: '/tmp', json: true, rest: [],
  }, {
    execute: async (argv) => {
      calls.push(argv);
      return { status: 0, stdout: JSON.stringify({ ok: true, why: 'verified' }), stderr: '' };
    },
    writeOut: () => {},
    writeErr: () => {},
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'run');
});

test('--classify=llm fails clearly when classification cannot succeed', async () => {
  const errors = [];
  const calls = [];
  const status = await cmdDelegate({
    prompt: 'Explain one module.', mode: 'auto', classify: 'llm', cwd: '/tmp', json: true, rest: [],
  }, {
    execute: async (argv) => {
      calls.push(argv);
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, keepOnClaude: true, why: 'caller has the best eligible route' }),
        stderr: '',
      };
    },
    writeOut: () => {},
    writeErr: (value) => errors.push(value),
  });
  assert.equal(status, 2);
  assert.equal(calls.length, 1, 'the main invocation must not run after a required-LLM failure');
  assert.match(errors.join('\n'), /--classify=llm failed: no delegate pool available for classification/);
});

test('delegate rejects malformed --classify values before dispatch', async () => {
  for (const [value, message] of [
    ['vibes', /--classify must be deterministic or llm/],
    [true, /--classify requires a value/],
  ]) {
    const errors = [];
    let executed = false;
    const status = await cmdDelegate({
      prompt: 'Explain one module.', mode: 'auto', classify: value, cwd: '/tmp', rest: [],
    }, {
      execute: async () => { executed = true; return { status: 0, stdout: '{}', stderr: '' }; },
      writeOut: () => {},
      writeErr: (v) => errors.push(v),
    });
    assert.equal(status, 2);
    assert.equal(executed, false);
    assert.match(errors.join('\n'), message);
  }
});
