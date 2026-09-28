import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The skill documents v3 programs (0.37.0). Every v3 program and fragment it
// prints must validate, and every `validate:` block must be what the CLI
// prints for it (without the launch line, which names the reader's paths).

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const V3 = 'bullswarm.workflow.program.v3';
const DOCS = ['skill/SKILL.md', 'skill/references/program.md', 'skill/references/patterns.md'];

// Each ```json block in order, with the ```text block that follows it before
// the next json block when that text block starts with `validate`.
function examples(text) {
  const blocks = [...text.matchAll(/```(json|text)\n([\s\S]*?)```/g)].map((match) => ({ lang: match[1], body: match[2] }));
  const found = [];
  blocks.forEach((block, index) => {
    if (block.lang !== 'json') return;
    const next = blocks.slice(index + 1).find((entry) => entry.lang === 'json' || entry.body.startsWith('validate'));
    found.push({ value: JSON.parse(block.body), validate: next?.lang === 'text' ? next.body : null });
  });
  return found;
}

// A fragment {steps, gates?, loops?} is shown after the program it extends.
function programOf(value, previous) {
  if (value.schemaVersion === V3) return value;
  assert.ok(previous, 'a fragment follows the program it extends');
  return {
    ...previous,
    steps: [...previous.steps, ...(value.steps ?? [])],
    ...(previous.gates || value.gates ? { gates: [...(previous.gates ?? []), ...(value.gates ?? [])] } : {}),
    ...(previous.loops || value.loops ? { loops: [...(previous.loops ?? []), ...(value.loops ?? [])] } : {}),
  };
}

function echoHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'echo.json'), read('src/providers/echo/connector.json'));
  writeFileSync(join(home, 'connectors', 'echo-worker.mjs'), read('src/providers/echo/echo-worker.mjs'));
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return home;
}

function validateCli(program) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-docs-'));
  try {
    const home = echoHome(root);
    const cwd = join(root, 'work');
    mkdirSync(cwd);
    const file = join(root, 'plan.json');
    writeFileSync(file, JSON.stringify(program));
    // One local fixture pool, so a routed step has a pool to check against.
    const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
    delete env.BULLSWARM_DEPTH;
    const run = spawnSync(process.execPath, [join(repo, 'bin/bullswarm.js'), 'workflow', 'plan', 'validate', 'Docs example', `--cwd=${cwd}`, `--program=${file}`], { env, encoding: 'utf8' });
    return { status: run.status, lines: run.stdout.split('\n').filter((line) => line && !line.startsWith('  launch ')), stderr: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every v3 program and fragment in the skill validates, and each validate block is what the CLI prints', { timeout: 120_000 }, () => {
  let programs = 0;
  let quoted = 0;
  for (const path of DOCS) {
    let previous = null;
    for (const { value, validate } of examples(read(path))) {
      const program = programOf(value, previous);
      if (value.schemaVersion === V3) previous = program;
      const result = validateCli(program);
      assert.equal(result.status, 0, `${path}: ${JSON.stringify(value).slice(0, 80)}\n${result.stderr}`);
      programs += 1;
      if (validate) {
        assert.deepEqual(result.lines, validate.trimEnd().split('\n').slice(1), `${path}: the validate block matches the CLI`);
        quoted += 1;
      }
    }
  }
  assert.ok(programs >= 8, `programs checked: ${programs}`);
  assert.ok(quoted >= 6, `validate blocks checked: ${quoted}`);
});

test('the skill stays shorter than the 0.36 skill (32.6K)', () => {
  assert.ok(statSync(join(repo, 'skill/SKILL.md')).size < 32_600);
});

test('the skill leads with v3 and mentions v2 only as old programs', () => {
  const skill = read('skill/SKILL.md');
  assert.ok(skill.includes(V3));
  // v2 is named once: old programs still run.
  assert.equal(skill.split('bullswarm.workflow.program.v2').length - 1, 1);
  assert.ok(skill.includes('Old v2 programs (`bullswarm.workflow.program.v2`) still run'));
  assert.doesNotMatch(skill, /a run never waits/i);
  for (const removed of ['keepOnClaude', 'incumbent', '--no-caller']) {
    for (const path of ['skill/SKILL.md', 'skill/references/program.md', 'skill/references/patterns.md', 'skill/references/operations.md']) {
      assert.ok(!read(path).includes(removed), `${path} names ${removed}`);
    }
  }
});
