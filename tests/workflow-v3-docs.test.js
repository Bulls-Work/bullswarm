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

test('every v3 program in the public docs validates, and the validate output shown after it is what the CLI prints', { timeout: 120_000 }, () => {
  let programs = 0;
  let quoted = 0;
  for (const path of ['docs/guide/workflows.md', 'docs/reference/program.md']) {
    const blocks = [...read(path).matchAll(/```(json|text)\n([\s\S]*?)```/g)].map((match) => ({ lang: match[1], body: match[2] }));
    blocks.forEach((block, index) => {
      if (block.lang !== 'json') return;
      const value = JSON.parse(block.body);
      if (value.schemaVersion !== V3) return;
      const result = validateCli(value);
      assert.equal(result.status, 0, `${path}: ${JSON.stringify(value).slice(0, 80)}\n${result.stderr}`);
      programs += 1;
      const later = blocks.slice(index + 1);
      const end = later.findIndex((entry) => entry.lang === 'json');
      const shown = (end === -1 ? later : later.slice(0, end)).find((entry) => entry.lang === 'text' && /^(\$ bullswarm workflow plan validate .*\n)?✓ program v3 valid/.test(entry.body));
      if (shown) {
        const lines = shown.body.trimEnd().split('\n').filter((line) => !line.startsWith('$ ') && !line.startsWith('  launch '));
        assert.deepEqual(result.lines, lines, `${path}: the validate output matches the CLI`);
        quoted += 1;
      }
    });
  }
  assert.equal(programs, 2, 'the loop in the guide and the gate in the reference');
  assert.equal(quoted, 2);
});

test('the skill stays shorter than the 0.36 skill (32.6K), and no longer than the 0.37.0 candidate QA37 graded (25,132 bytes)', () => {
  const size = statSync(join(repo, 'skill/SKILL.md')).size;
  assert.ok(size < 32_600);
  assert.ok(size <= 25_132, `SKILL.md is ${size} bytes`);
});

// QA37: callers built a workflow for work one run holds (a 40-ticket triage,
// a research brief) and did worse on turns, time and triage accuracy.
test('the skill puts the run-or-workflow choice first, with the chunking rule, the loop rules and a foreground watch', () => {
  const skill = read('skill/SKILL.md').replace(/\s+/g, ' ');
  const choose = skill.slice(skill.indexOf('## 1. Choose the shape'), skill.indexOf('## 2. One step'));
  assert.match(choose, /One worker can hold the whole input and make one deliverable/);
  assert.match(choose, /Do not split an input into chunks unless one worker cannot hold it/);
  assert.match(choose, /--answer-schema/);
  assert.match(skill, /A critique asks only for what the sources can show/);
  assert.match(skill, /Cap `maxRounds` at 2 unless a round is cheap/);
  assert.match(skill, /run the watch in the foreground: it blocks until the wake/);
  // A foreground tool call is killed after a few minutes: the watch must end
  // in time and relaunch from its cursor (--after), or wakes are lost.
  assert.match(skill, /--until trouble --timeout 100/);
  assert.match(skill, /A restart without `--after` attaches at the newest event and skips/);
  const guide = read('docs/guide/observing.md').replace(/\s+/g, ' ');
  assert.match(guide, /--timeout/);
  const mod = read('mods/bullswarm/hooks/verdict.ts');
  assert.match(mod, /--timeout/);
  assert.match(skill, /Never end your turn while a run you own is still running/);
  assert.match(skill, /`bullswarm workflow plan contract` \(no goal needed\)/);
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

test('the README bullets describe v3 (steps, phases, gates, loops, answers), and "verified" only as a v2 word', () => {
  const readme = read('README.md');
  const bullets = readme.split('\n').filter((line) => line.startsWith('- **'));
  const text = bullets.join('\n');
  for (const word of [/\bsteps?\b/, /\bphases?\b/, /\bgates?\b/, /\bloops?\b/, /\banswers?\b/]) assert.match(text, word);
  assert.match(text, /workflow add/);
  // Every sentence of the README that says verified names v2.
  const sentences = readme.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/).filter((sentence) => /\bverified\b/i.test(sentence));
  assert.ok(sentences.length >= 1, 'the README says what verified means');
  for (const sentence of sentences) assert.match(sentence, /\bv2\b/, sentence);
  assert.doesNotMatch(text, /change, remove or rerun steps/, 'v3 steps are added, never edited or removed');
});

// `plan contract` prints the draft, critique, approve, publish example: it
// must teach the critique and round cap the skill and patterns.md teach.
test('the plan contract example is the draft-critique program of patterns.md, and keeps the skill\'s critique rule and round cap', async () => {
  const { buildV3Contract } = await import('../src/workflow/contract-v3.js');
  const example = buildV3Contract({ goal: 'g', cwd: '/abs/workspace', next: {} }).example;
  const patterns = read('skill/references/patterns.md');
  const section = patterns.slice(patterns.indexOf('## 3. Draft, critique, approve, publish'));
  const block = /```json\n([\s\S]*?)\n```/.exec(section)[1];
  const documented = JSON.parse(block.replaceAll('/work/acme', '/abs/workspace'));
  assert.deepEqual(example, documented);
  const skill = read('skill/SKILL.md');
  const skillProgram = JSON.parse(/```json\n(\{\n  "schemaVersion": "bullswarm\.workflow\.program\.v3"[\s\S]*?)\n```/.exec(skill)[1]);
  const critique = (program) => program.steps.find((step) => step.id === 'critique').prompt;
  for (const sentence of ['List only problems a line of sources/ shows', 'Answer passed true when you list none.']) {
    assert.ok(critique(example).includes(sentence), sentence);
    assert.ok(critique(skillProgram).includes(sentence), sentence);
  }
  assert.equal(example.loops[0].maxRounds, skillProgram.loops[0].maxRounds);
  assert.equal(example.loops[0].maxRounds, 2);
});

// A loop continued without --rounds ends continued, condition not met: never a pass.
test('operations.md says a loop continued without --rounds ends unmet, never that it passes as it stands', () => {
  const ops = read('skill/references/operations.md');
  assert.doesNotMatch(ops, /as it stands/);
  const line = ops.split('\n').find((row) => row.startsWith('bullswarm workflow continue <shortId> <loop>'));
  assert.match(line, /without --rounds it ends continued, condition not met/);
});
