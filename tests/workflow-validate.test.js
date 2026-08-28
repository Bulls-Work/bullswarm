import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, WorkflowValidationError, templateRefs } from '../src/workflow/validate.js';
import { renderTemplate, isTemplateRef } from '../src/workflow/template.js';

const POOLS = ['codex', 'grok', 'command-code', 'opencode2', 'claude-code', 'echo'];

function baseDoc(over = {}) {
  return {
    name: 'test-wf',
    description: 'x',
    inputs: {},
    settings: {},
    phases: [
      { name: 'p1', steps: [{ id: 's1', type: 'run', lane: 'chore', prompt: 'hi' }] },
    ],
    ...over,
  };
}

test('valid minimal workflow passes', () => {
  const r = validateWorkflow(baseDoc(), { poolNames: POOLS });
  assert.equal(r.name, 'test-wf');
  assert.deepEqual(r.warnings, []);
});

test('rejects bad lane and unknown pinned pool', () => {
  assert.throws(
    () => validateWorkflow(baseDoc({ phases: [{ name: 'p', steps: [{ id: 'a', type: 'run', lane: 'vibes', prompt: 'x' }] }] }), { poolNames: POOLS }),
    WorkflowValidationError,
  );
  assert.throws(
    () => validateWorkflow(baseDoc({ phases: [{ name: 'p', steps: [{ id: 'a', type: 'run', lane: 'chore', pool: 'nope', prompt: 'x' }] }] }), { poolNames: POOLS }),
    (err) => err instanceof WorkflowValidationError && err.issues.some((i) => i.includes('pool "nope"')),
  );
});

test('duplicate step ids rejected', () => {
  const doc = baseDoc({
    phases: [
      { name: 'a', steps: [{ id: 'dup', type: 'run', prompt: '1' }] },
      { name: 'b', steps: [{ id: 'dup', type: 'run', prompt: '2' }] },
    ],
  });
  assert.throws(
    () => validateWorkflow(doc, { poolNames: POOLS }),
    (err) => err.issues.some((i) => i.includes('duplicate step id')),
  );
});

test('template ref to unknown output rejected; known prior step ok', () => {
  const bad = baseDoc({
    phases: [
      { name: 'a', steps: [{ id: 'one', type: 'run', prompt: '{{outputs.nope}}' }] },
    ],
  });
  assert.throws(
    () => validateWorkflow(bad, { poolNames: POOLS }),
    (err) => err.issues.some((i) => i.includes('{{outputs.nope}}')),
  );

  const good = baseDoc({
    phases: [
      { name: 'a', steps: [
        { id: 'one', type: 'run', lane: 'chore', prompt: 'list files' },
        { id: 'two', type: 'run', lane: 'chore', prompt: 'summarize {{outputs.one.outFile}}' },
      ] },
    ],
  });
  const r = validateWorkflow(good, { poolNames: POOLS });
  assert.equal(r.name, 'test-wf');
});

test('{{item}} allowed only inside fanout stepTemplate', () => {
  const bad = baseDoc({
    phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'review {{item}}' }] }],
  });
  assert.throws(
    () => validateWorkflow(bad, { poolNames: POOLS }),
    (err) => err.issues.some((i) => i.includes('{{item}}') && i.includes('cannot resolve')),
  );

  const good = baseDoc({
    phases: [{ name: 'p', steps: [{
      id: 'fan', type: 'fanout', itemsFrom: 'outputs.src',
      stepTemplate: { lane: 'chore', prompt: 'review {{item}}' },
    }] }],
  });
  // itemsFrom points at outputs.src which doesn't exist as a step → must fail on that
  assert.throws(
    () => validateWorkflow(good, { poolNames: POOLS }),
    (err) => err.issues.some((i) => i.includes('itemsFrom') || i.includes('src')),
  );
});

test('undeclared input usage is a warning, not an error', () => {
  const doc = baseDoc({
    phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'go to {{inputs.wherever}}' }] }],
  });
  const r = validateWorkflow(doc, { poolNames: POOLS });
  assert.ok(r.warnings.some((w) => w.includes('inputs.wherever')));
});

test('declared input with default resolves without warning', () => {
  const doc = baseDoc({
    inputs: { targetDir: { default: '.' } },
    phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', addDir: '{{inputs.targetDir}}', prompt: 'x' }] }],
  });
  const r = validateWorkflow(doc, { poolNames: POOLS });
  assert.deepEqual(r.warnings, []);
});

test('templateRefs extracts tokens', () => {
  assert.deepEqual(templateRefs('a {{inputs.x}} b {{ outputs.y.z }}'), ['inputs.x', 'outputs.y.z']);
});

test('double-brace prompt text that is not a ref is left literal, real refs still resolve or throw', () => {
  const scope = { outputs: { 'module-slugify': { outFile: '/tmp/out.md' } }, runId: 'r1' };
  const prompt = 'Options are `{{maxLength?: number}}`; see {{outputs.module-slugify.outFile}} (run {{runId}}). '
    + 'Mustache stays: {{#each items}}{{name}}{{/each}}; JS stays: `${{ a: 1 }}`.';
  assert.equal(
    renderTemplate(prompt, scope),
    'Options are `{{maxLength?: number}}`; see /tmp/out.md (run r1). '
    + 'Mustache stays: {{#each items}}{{name}}{{/each}}; JS stays: `${{ a: 1 }}`.',
  );
  assert.throws(() => renderTemplate('{{outputs.missing.outFile}}', scope), /unresolved at render time/);
  assert.equal(isTemplateRef('outputs.step-1.outFile'), true);
  assert.equal(isTemplateRef('item.path.to.field'), true);
  assert.equal(isTemplateRef('maxLength?: number'), false);
  assert.equal(isTemplateRef('name'), false);
  assert.deepEqual(templateRefs('{{outputs.a.outFile}} {{maxLength?: number}} {{name}}'), ['outputs.a.outFile']);
  // A static document whose prompt carries literal braces validates cleanly.
  const doc = baseDoc();
  doc.phases[0].steps[0].prompt = 'Type the options as {{maxLength?: number}} and stop.';
  assert.doesNotThrow(() => validateWorkflow(doc, { poolNames: POOLS }));
});
