// Tests for the draft CLI — incremental workflow construction via
// `bullswarm workflow draft ...` subcommands.
//
// Two layers of coverage:
//   L1. Module-level: imports from `src/workflow/draft.js` and exercises
//       every mutation. Fast (no process spawn) and exhaustive.
//   L2. CLI-level: a few spawnSync tests for the actual `bullswarm`
//       command to lock in the user-facing contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bs-draft-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(join(home, 'workflows'), { recursive: true });
  for (const f of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(
      join(home, 'connectors', f),
      readFileSync(join(REPO, 'connectors', f)),
    );
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {},
    decisionLog: [], config: { depthLimit: 2, callerName: 'claude-code' },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: env.home, ...(env.extra ?? {}) },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const wf = (...args) => ['workflow', ...args];

// Import the module-level helpers once.
const draft = await import('../src/workflow/draft.js');
const {
  emptyDraft, emptyMeta, draftPaths, loadDraft, saveDraft,
  listDrafts, deleteDraft, addPhase, removePhase, addStep, removeStep,
  setField, setStepField, exportDraft, revalidateDraft, draftExists,
} = draft;

// -------------------------------------------------------------------------
// L1: module-level — fast, exhaustive
// -------------------------------------------------------------------------

test('L1: emptyDraft seeds a buildable empty workflow document', () => {
  const d = emptyDraft('demo');
  assert.equal(d.name, 'demo');
  assert.equal(typeof d.description, 'string');
  assert.deepEqual(d.inputs, {});
  assert.deepEqual(d.phases, []);
  // settings ship with safe defaults so the first phase you add
  // already has a sensible concurrency / escalation policy.
  assert.equal(d.settings.concurrency, 4);
  assert.equal(d.settings.escalateOnFail, true);
});

test('L1: draftExists / loadDraft / saveDraft round-trip', () => {
  const { home, cleanup } = sandbox();
  try {
    assert.equal(draftExists(home, 'demo'), false);
    const doc = emptyDraft('demo');
    saveDraft(home, 'demo', doc, emptyMeta('demo'));
    assert.equal(draftExists(home, 'demo'), true);
    const { doc: reloaded } = loadDraft(home, 'demo');
    assert.equal(reloaded.name, 'demo');
  } finally { cleanup(); }
});

test('L1: addPhase appends and re-validates', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    const r = addPhase(home, 'demo', { phaseName: 'p1' });
    assert.equal(r.doc.phases.length, 1);
    assert.equal(r.doc.phases[0].name, 'p1');
    assert.ok(r.validation);
  } finally { cleanup(); }
});

test('L1: addPhase is idempotent on duplicate name', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p1' });
    const r = addPhase(home, 'demo', { phaseName: 'p1' });
    assert.equal(r.doc.phases.length, 1);
  } finally { cleanup(); }
});

test('L1: addStep writes a run step with the given fields', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p1' });
    const r = addStep(home, 'demo', {
      phaseName: 'p1', stepId: 'go',
      step: { type: 'run', lane: 'chore', prompt: 'do it', addDir: '.' },
    });
    assert.equal(r.step.id, 'go');
    assert.equal(r.step.type, 'run');
    assert.equal(r.step.prompt, 'do it');
  } finally { cleanup(); }
});

test('L1: addStep refuses duplicate step id within a phase', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p1' });
    addStep(home, 'demo', {
      phaseName: 'p1', stepId: 'go',
      step: { type: 'run', prompt: 'x' },
    });
    assert.throws(
      () => addStep(home, 'demo', {
        phaseName: 'p1', stepId: 'go',
        step: { type: 'run', prompt: 'y' },
      }),
      /already exists/,
    );
  } finally { cleanup(); }
});

test('L1: addStep on missing phase throws a clear error', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    assert.throws(
      () => addStep(home, 'demo', {
        phaseName: 'nope', stepId: 'go',
        step: { type: 'run', prompt: 'x' },
      }),
      /phase "nope"/,
    );
  } finally { cleanup(); }
});

test('L1: setField patches a top-level field and re-validates', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    const r = setField(home, 'demo', { field: 'description', value: 'hello' });
    assert.equal(r.doc.description, 'hello');
  } finally { cleanup(); }
});

test('L1: setField JSON-decodes a quoted object value', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    const r = setField(home, 'demo', { field: 'settings', value: '{"concurrency":2}' });
    assert.deepEqual(r.doc.settings, { concurrency: 2 });
  } finally { cleanup(); }
});

test('L1: setStepField patches one field and keeps the rest', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p1' });
    addStep(home, 'demo', {
      phaseName: 'p1', stepId: 's',
      step: { type: 'run', lane: 'chore', prompt: 'old' },
    });
    const r = setStepField(home, 'demo', {
      phaseName: 'p1', stepId: 's', field: 'prompt', value: 'new',
    });
    const step = r.doc.phases[0].steps[0];
    assert.equal(step.prompt, 'new');
    assert.equal(step.type, 'run');   // unchanged
    assert.equal(step.lane, 'chore'); // unchanged
  } finally { cleanup(); }
});

test('L1: removeStep drops only the named step', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p1' });
    addStep(home, 'demo', { phaseName: 'p1', stepId: 'a', step: { type: 'run', prompt: 'x' } });
    addStep(home, 'demo', { phaseName: 'p1', stepId: 'b', step: { type: 'run', prompt: 'y' } });
    removeStep(home, 'demo', { phaseName: 'p1', stepId: 'a' });
    const { doc } = loadDraft(home, 'demo');
    assert.equal(doc.phases[0].steps.length, 1);
    assert.equal(doc.phases[0].steps[0].id, 'b');
  } finally { cleanup(); }
});

test('L1: removePhase drops the phase and its steps', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'a' });
    addPhase(home, 'demo', { phaseName: 'b' });
    addStep(home, 'demo', { phaseName: 'a', stepId: 'x', step: { type: 'run', prompt: 'x' } });
    removePhase(home, 'demo', { phaseName: 'a' });
    const { doc } = loadDraft(home, 'demo');
    assert.equal(doc.phases.length, 1);
    assert.equal(doc.phases[0].name, 'b');
  } finally { cleanup(); }
});

test('L1: listDrafts shows every draft with phase/step counts', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'a', emptyDraft('a'), emptyMeta('a'));
    saveDraft(home, 'b', emptyDraft('b'), emptyMeta('b'));
    addPhase(home, 'a', { phaseName: 'p1' });
    addPhase(home, 'a', { phaseName: 'p2' });
    addStep(home, 'a', { phaseName: 'p1', stepId: 's', step: { type: 'run', prompt: 'x' } });
    const list = listDrafts(home);
    assert.equal(list.length, 2);
    const a = list.find((d) => d.name === 'a');
    assert.equal(a.phases, 2);
    assert.equal(a.steps, 1);
  } finally { cleanup(); }
});

test('L1: exportDraft writes the workflow JSON to the given path', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', { ...emptyDraft('demo'), description: 'exp' }, emptyMeta('demo'));
    const out = join(home, 'workflows', 'demo.json');
    const r = exportDraft(home, 'demo', out);
    const exported = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(exported.name, 'demo');
    assert.equal(exported.description, 'exp');
    assert.equal(r.outPath, out);
  } finally { cleanup(); }
});

test('L1: revalidateDraft returns issues for a broken draft and persists them on meta', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    addPhase(home, 'demo', { phaseName: 'p' });
    // Add a step with a bogus lane — invalid.
    addStep(home, 'demo', {
      phaseName: 'p', stepId: 'bad',
      step: { type: 'run', lane: 'vibes', prompt: 'x' },
    });
    const v = revalidateDraft(home, 'demo');
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.includes('vibes')));
    // meta.lastValidation is persisted.
    const metaRaw = readFileSync(join(home, 'drafts/demo/meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.lastValidation.ok, false);
  } finally { cleanup(); }
});

test('L1: deleteDraft removes the draft directory', () => {
  const { home, cleanup } = sandbox();
  try {
    saveDraft(home, 'demo', emptyDraft('demo'), emptyMeta('demo'));
    assert.equal(draftExists(home, 'demo'), true);
    assert.equal(deleteDraft(home, 'demo'), true);
    assert.equal(draftExists(home, 'demo'), false);
  } finally { cleanup(); }
});

// -------------------------------------------------------------------------
// L2: CLI-level — spawn `bullswarm` and check exit codes + output
// -------------------------------------------------------------------------

test('L2: draft create writes the doc to disk', () => {
  const { home, cleanup } = sandbox();
  try {
    const r = run(wf('draft', 'create', 'demo'), { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /created draft "demo"/);
    assert.equal(draftExists(home, 'demo'), true);
  } finally { cleanup(); }
});

test('L2: draft create with --input wraps values as input declarations', () => {
  const { home, cleanup } = sandbox();
  try {
    const r = run(wf('draft', 'create', 'demo', '--input', 'targetDir=.'), { home });
    assert.equal(r.status, 0, r.stderr);
    const { doc } = loadDraft(home, 'demo');
    assert.deepEqual(doc.inputs.targetDir, { default: '.' });
  } finally { cleanup(); }
});

test('L2: draft phase add appends and re-validates', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    const r = run(wf('draft', 'phase', 'add', 'demo', 'p1'), { home });
    assert.equal(r.status, 0, r.stderr);
    const { doc } = loadDraft(home, 'demo');
    assert.equal(doc.phases.length, 1);
  } finally { cleanup(); }
});

test('L2: draft step add accepts a configured pinned pool during incremental validation', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    run(wf('draft', 'phase', 'add', 'demo', 'p1'), { home });
    const r = run(wf(
      'draft', 'step', 'add', 'demo', 'p1', 'pinned',
      '--type', 'run', '--prompt', 'do bounded work', '--pool', 'echo',
    ), { home });
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const { meta } = loadDraft(home, 'demo');
    assert.equal(meta.lastValidation.ok, true);
  } finally { cleanup(); }
});

test('L2: draft step add with --step-template JSON parses and embeds', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    run(wf('draft', 'phase', 'add', 'demo', 'fan'), { home });
    const r = run(wf('draft', 'step', 'add', 'demo', 'fan', 'per-file',
      '--type', 'fanout', '--items-from', 'inputs.items',
      '--step-template', '{"lane":"analyze","prompt":"Review {{item}}"}'), { home });
    assert.equal(r.status, 0, r.stderr);
    const { doc } = loadDraft(home, 'demo');
    assert.deepEqual(doc.phases[0].steps[0].stepTemplate, {
      lane: 'analyze', prompt: 'Review {{item}}',
    });
  } finally { cleanup(); }
});

test('L2: draft step remove drops the step', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    run(wf('draft', 'phase', 'add', 'demo', 'p'), { home });
    run(wf('draft', 'step', 'add', 'demo', 'p', 's', '--type', 'run', '--prompt', 'x'), { home });
    const r = run(wf('draft', 'step', 'remove', 'demo', 'p', 's'), { home });
    assert.equal(r.status, 0, r.stderr);
    const { doc } = loadDraft(home, 'demo');
    assert.equal(doc.phases[0].steps.length, 0);
  } finally { cleanup(); }
});

test('L2: draft delete refuses without --yes', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    const r = run(wf('draft', 'delete', 'demo'), { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /refusing to delete/);
    assert.equal(draftExists(home, 'demo'), true);
  } finally { cleanup(); }
});

test('L2: draft delete with --yes removes the draft', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    const r = run(wf('draft', 'delete', 'demo', '--yes'), { home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(draftExists(home, 'demo'), false);
  } finally { cleanup(); }
});

test('L2: workflow run <draft-name> uses the drafts directory', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'myrun'), { home });
    run(wf('draft', 'phase', 'add', 'myrun', 'p'), { home });
    run(wf('draft', 'step', 'add', 'myrun', 'p', 'go',
      '--type', 'run', '--lane', 'chore', '--prompt', 'go', '--timeout', '60'), { home });
    const r = run(wf('run', 'myrun', '--json', '--quiet'), { home });
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    // The pretty-printed report is the only object that mentions
    // `schemaVersion: "bullswarm.workflow.report.v1"`. Walk back to
    // the opening `{` from the `schemaVersion` line.
    const marker = '"schemaVersion"';
    const markerIdx = r.stdout.indexOf(marker);
    assert.ok(markerIdx > 0, `no schemaVersion in stdout: ${r.stdout.slice(0, 200)}`);
    const start = r.stdout.lastIndexOf('{', markerIdx);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < r.stdout.length; i++) {
      const c = r.stdout[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
    }
    const report = JSON.parse(r.stdout.slice(start, end + 1));
    assert.equal(report.status, 'completed');
  } finally { cleanup(); }
});

test('L2: draft export writes the workflow JSON to the given path', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo', '--description', 'exp test'), { home });
    const out = join(home, 'workflows', 'demo.json');
    const r = run(wf('draft', 'export', 'demo', out), { home });
    assert.equal(r.status, 0, r.stderr);
    const exported = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(exported.description, 'exp test');
  } finally { cleanup(); }
});

test('L2: draft step add accepts documented equals-style camelCase flags', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo', '--input=targetDir=.'), { home });
    run(wf('draft', 'phase', 'add', 'demo', 'review'), { home });
    const r = run(wf(
      'draft', 'step', 'add', 'demo', 'review', 'per-file',
      '--type=fanout',
      '--itemsFrom=inputs.items',
      '--lane=chore',
      '--concurrency=2',
      '--step-template={"lane":"chore","prompt":"Process {{item}}"}',
    ), { home });
    assert.equal(r.status, 0, r.stderr);
    const { doc } = loadDraft(home, 'demo');
    assert.equal(doc.inputs.targetDir.default, '.');
    assert.equal(doc.phases[0].steps[0].itemsFrom, 'inputs.items');
    assert.equal(doc.phases[0].steps[0].concurrency, 2);
  } finally { cleanup(); }
});

test('L2: draft run accepts equals-style JSON input arrays', () => {
  const { home, cleanup } = sandbox();
  try {
    run(wf('draft', 'create', 'demo'), { home });
    run(wf('draft', 'phase', 'add', 'demo', 'review'), { home });
    run(wf(
      'draft', 'step', 'add', 'demo', 'review', 'per-file',
      '--type=fanout', '--itemsFrom=inputs.items', '--lane=chore',
      '--concurrency=2',
      '--step-template={"lane":"chore","prompt":"Process {{item}}"}',
    ), { home });
    const r = run(wf(
      'draft', 'run', 'demo', '--input=items=["alpha","beta"]', '--json', '--quiet',
    ), { home });
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const runDir = readdirSync(join(home, 'workflows')).sort().pop();
    const report = JSON.parse(readFileSync(join(home, 'workflows', runDir, 'report.json'), 'utf8'));
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.fanoutOk, 2);
  } finally { cleanup(); }
});
