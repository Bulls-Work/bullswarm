import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The skill documents v3 programs (0.37.0). Every v3 program and fragment it
// prints must validate, and every `validate:` block must be what the CLI
// prints for it (without the launch line, which names the reader's paths).

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const V3 = 'bullswarm.workflow.program.v3';
const DOCS = ['skill/SKILL.md', 'skill/references/program.md', 'skill/references/patterns.md', 'skill/references/recovery.md'];
// The skill as a whole: the entry point and every reference it links.
const SKILL_FILES = ['skill/SKILL.md', ...readdirSync(join(repo, 'skill/references')).filter((name) => name.endsWith('.md')).sort().map((name) => `skill/references/${name}`)];
const skillWide = () => SKILL_FILES.map((path) => read(path)).join('\n').replace(/\s+/g, ' ');

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

// 0.38.3 split the skill: SKILL.md is the entry point a caller reads every
// time, and the rare paths are references it links (progressive disclosure).
test('the skill entry point is at most 15,000 bytes, and links every reference', () => {
  const size = statSync(join(repo, 'skill/SKILL.md')).size;
  assert.ok(size < 32_600);
  assert.ok(size <= 15_000, `SKILL.md is ${size} bytes`);
  const skill = read('skill/SKILL.md');
  for (const path of SKILL_FILES.slice(1)) assert.ok(skill.includes(`](${path.slice('skill/'.length)})`), `SKILL.md links ${path}`);
  assert.match(skill, /## 6\. Read this when/);
  assert.match(skill, /## 4\. Driving it well/);
});

// QA37: callers built a workflow for work one run holds (a 40-ticket triage,
// a research brief) and did worse on turns, time and triage accuracy.
test('the skill puts the run-or-workflow choice first, with the chunking rule, the loop rules and a foreground watch', () => {
  const entry = read('skill/SKILL.md').replace(/\s+/g, ' ');
  const choose = entry.slice(entry.indexOf('## 1. Choose the shape'), entry.indexOf('## 2. One step'));
  const skill = skillWide();
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
  assert.match(skill, /Never end your turn while a run you own is still running/);
  assert.match(skill, /`bullswarm workflow plan contract` \(no goal needed\)/);
  // The watch rules are the entry point's: a caller needs them on every run.
  for (const rule of [/run the watch in the foreground: it blocks until the wake/, /--until trouble --timeout 100/, /Never end your turn while a run you own is still running/]) assert.match(entry, rule);
});

test('the skill leads with v3 and mentions v2 only as old programs', () => {
  const skill = read('skill/SKILL.md');
  assert.ok(skill.includes(V3));
  // v2 is named once: old programs still run.
  assert.equal(skill.split('bullswarm.workflow.program.v2').length - 1, 1);
  assert.ok(skill.includes('Old v2 programs (`bullswarm.workflow.program.v2`) still run'));
  assert.doesNotMatch(skill, /a run never waits/i);
  for (const removed of ['keepOnClaude', 'incumbent', '--no-caller']) {
    for (const path of SKILL_FILES) {
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
  // The skill's draft-critique program is patterns.md 3 since 0.38.3 (the
  // entry point shows a build and review); its critique rule is program.md's.
  const critique = (program) => program.steps.find((step) => step.id === 'critique').prompt;
  for (const sentence of ['List only problems a line of sources/ shows', 'Answer passed true when you list none.']) {
    assert.ok(critique(example).includes(sentence), sentence);
    assert.ok(critique(documented).includes(sentence), sentence);
  }
  assert.ok(skillWide().includes('A critique asks only for what the sources can show.'));
  assert.equal(example.loops[0].maxRounds, documented.loops[0].maxRounds);
  assert.equal(example.loops[0].maxRounds, 2);
});

// A loop continued without --rounds ends continued, condition not met: never a pass.
test('operations.md says a loop continued without --rounds ends unmet, never that it passes as it stands', () => {
  const ops = read('skill/references/operations.md');
  assert.doesNotMatch(ops, /as it stands/);
  const line = ops.split('\n').find((row) => row.startsWith('bullswarm workflow continue <shortId> <loop>'));
  assert.match(line, /without --rounds it ends continued, condition not met/);
});

// 0.38.0 removed plan export/revise, --scout, the dispatched planner and the
// repair loop. The live guides teach the v3 way (loops, workflow add, step
// rerun) and name the old mechanisms only as a saved run's history.
test('the live guides teach no removed mechanism as current behaviour', () => {
  const flat = (path) => read(path).replace(/\s+/g, ' ');
  const patterns = flat('skill/references/patterns.md');
  assert.ok(!patterns.includes('plan export <run> --out'), 'patterns.md: a past run\'s shape uses plan export');
  assert.ok(patterns.includes('keep the program file you launched it with'));
  const playbook = flat('docs/guide/playbook.md');
  for (const gone of ['plan export <runId>', 'plan revise <runId>', 'planner checkpoint']) assert.ok(!playbook.includes(gone), `playbook.md: ${gone}`);
  assert.ok(playbook.includes('bullswarm workflow add <runId> --steps compat-fix.json'));
  assert.ok(playbook.includes('bullswarm workflow step rerun <runId> acceptance'));
  const result = flat('docs/reference/result.md');
  for (const gone of ['In a new run, a failed mandatory requirement gets one fix step', 'in a new program `defaults.verifyRounds`', 'or `plan revise` for those failures', 'Do not hand-add a fix step']) {
    assert.ok(!result.includes(gone), `result.md: ${gone}`);
  }
  assert.ok(result.includes('**Saved runs only.** 0.38.0 removed the kernel\'s repair loop'));
  assert.ok(result.includes('declare a loop in your program'));
  assert.ok(result.includes('| `add` | add | a v3 program run |'));
  const observing = flat('docs/guide/observing.md');
  for (const gone of ['`--program --scout`', '`workflow resume` runs the planner again', 'The preflight scout follows the same rule in runs started by this version']) {
    assert.ok(!observing.includes(gone), `observing.md: ${gone}`);
  }
  assert.ok(observing.includes('0.38.0 removed the preflight scout and the dispatched planner, so these lines come only from a run saved by 0.37.x'));
  assert.ok(observing.includes('`addSteps` (`workflow add <id> --steps part.json`, then `workflow wait <id> <added ids>`) in a v3 run'));
});

// Owner decision 2026-10-01: a review is placed by quota with blindTo and a
// strict prompt; route.independentOf is an opt-in the caller adds for its own reason.
test('default review examples carry no independentOf, and the opt-in is stated in SKILL.md and program.md', async () => {
  const { buildV3Contract } = await import('../src/workflow/contract-v3.js');
  const jsonBlocks = (path) => [...read(path).matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(jsonBlocks('skill/SKILL.md').length > 0);
  for (const block of jsonBlocks('skill/SKILL.md')) assert.ok(!block.includes('independentOf'), 'SKILL.md example');
  // Every patterns.md example is a default review/critique/check.
  for (const block of jsonBlocks('skill/references/patterns.md')) assert.ok(!block.includes('independentOf'), 'patterns.md example');
  const example = buildV3Contract({ goal: 'x', cwd: '/work/acme', next: {} }).example;
  assert.ok(!JSON.stringify(example).includes('independentOf'), 'contract example');
  for (const path of ['skill/SKILL.md', 'skill/references/program.md']) {
    const text = read(path).replace(/\s+/g, ' ');
    assert.match(text, /add `route\.independentOf` only for your own reason|`independentOf` is an opt-in, not the default for a review/, `${path}: opt-in sentence`);
    assert.match(text, /another provider may still serve the same model/, `${path}: same-model caveat`);
  }
});

// 0.38.12: the dry loop. `plan contract` prints pattern 6 as its second
// example; the skill says what "dry" means in plain words and what it costs.
test('the plan contract dry loop example is pattern 6 of patterns.md, and the skill defines dry and its cost', async () => {
  const { buildV3Contract } = await import('../src/workflow/contract-v3.js');
  const example = buildV3Contract({ goal: 'g', cwd: '/abs/workspace', next: {} }).dryLoopExample;
  const patterns = read('skill/references/patterns.md');
  const section = patterns.slice(patterns.indexOf('## 6. Fix until the review is dry'));
  const block = /```json\n([\s\S]*?)\n```/.exec(section)[1];
  assert.deepEqual(example, JSON.parse(block.replaceAll('/work/acme', '/abs/workspace')));
  assert.deepEqual(example.loops[0].until, { step: 'review', dry: 1 });
  const entry = read('skill/SKILL.md').replace(/\s+/g, ' ');
  assert.ok(entry.includes('("dry": a round that finds nothing new)'), 'SKILL.md defines dry');
  assert.ok(entry.includes('An area reviewer costs about one review per round, a fix round about five'), 'SKILL.md states the cost');
  const flat = patterns.replace(/\s+/g, ' ');
  assert.ok(flat.includes('"Dry" is that round: a review round that reports no new finding worth fixing.'));
  assert.ok(flat.includes('a round that finds something costs 3 × 40k + 200k = 320k, a clean round 120k'));
  const program = read('skill/references/program.md').replace(/\s+/g, ' ');
  assert.ok(program.includes('"Dry" is a review round that reports no new finding worth fixing'));
  assert.ok(program.includes('a round that finds something costs `P × 40k + 200k`, a clean round `P × 40k`'));
});

// The new advisories stay silent on the canonical examples (patterns 2, 3
// and 6, and both contract examples).
test('the review-loop advisories stay silent on the canonical examples', async () => {
  const { buildV3Contract } = await import('../src/workflow/contract-v3.js');
  const { programAdvisories } = await import('../src/workflow/action-validator.js');
  const { storedProgramV3 } = await import('../src/workflow/program-v3.js');
  const contract = buildV3Contract({ goal: 'g', cwd: '/abs/workspace', next: {} });
  const patterns = read('skill/references/patterns.md');
  const programs = [contract.example, contract.dryLoopExample];
  for (const heading of ['## 2. Fix until a check passes', '## 3. Draft, critique, approve, publish', '## 6. Fix until the review is dry']) {
    const section = patterns.slice(patterns.indexOf(heading));
    programs.push(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)[1]));
  }
  for (const program of programs) {
    const codes = programAdvisories(storedProgramV3(program)).map((item) => item.code);
    for (const code of ['review-loop-until-passed', 'dry-loop-too-short', 'review-one-area', 'dry-loop-fix-first', 'compile-check-only']) {
      assert.ok(!codes.includes(code), `${code} on ${JSON.stringify(program.loops ?? program.steps.map((step) => step.id))}`);
    }
  }
});

test('observing.md describes the repeated stale warnings, not one line per attempt', () => {
  const guide = read('docs/guide/observing.md').replace(/\s+/g, ' ');
  assert.ok(!guide.includes('prints one line per attempt'));
  assert.ok(guide.includes('`⚠ verify still looks stale (warning 2) · no file change for 45m00s: <reasons>`'));
  assert.ok(guide.includes('the next warning is still one level higher'));
  const recovery = read('skill/references/recovery.md').replace(/\s+/g, ' ');
  assert.ok(recovery.includes('restarts the window without a line, but not the level'));
});

test('the public reference teaches the dry loop: program.md has the third condition form and areas, cli.md the two contract examples', () => {
  const program = read('docs/reference/program.md').replace(/\s+/g, ' ');
  assert.ok(!program.includes('take one of two forms'));
  assert.ok(program.includes('`{"step": "<id>", "dry": 1}`'));
  assert.ok(program.includes('| `areas` | no |') && program.includes('| `areasPerRound` | no |'));
  assert.ok(program.includes('With a field or evidence `until`, every step of the loop runs in every round'));
  const cli = read('docs/reference/cli.md').replace(/\s+/g, ' ');
  assert.ok(!cli.includes('one worked example that validates'));
  assert.ok(cli.includes('`dryLoopExample`'));
  assert.ok(cli.includes('A dry loop (`until: {"step": "review", "dry": 1}`) stops after a review round that finds nothing new'));
});

test('the contract and its help say the dry form is for a loop only, never "the one condition form" of a gate', async () => {
  const { buildV3Contract } = await import('../src/workflow/contract-v3.js');
  const condition = buildV3Contract({ goal: 'g', cwd: '/abs/workspace', next: {} }).program.condition;
  assert.equal(condition.forms.length, 3);
  assert.doesNotMatch(condition.note, /the one condition form/);
  assert.match(condition.note, /a gate's when takes the field or evidence form; a loop's until takes any of the three/);
  const help = spawnSync(process.execPath, [join(repo, 'bin/bullswarm.js'), 'workflow', 'plan', 'contract', '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  assert.doesNotMatch(help, /the one condition form/);
  assert.match(help, /a gate's when takes the field or evidence form; a loop's until takes those or the dry form, which is for a loop only/);
});

test('observing.md says no file change alone is stale after 40 minutes and names the stop; recovery.md no longer promises 20 minutes always', () => {
  const guide = read('docs/guide/observing.md').replace(/\s+/g, ' ');
  assert.ok(guide.includes('| 1, and 2 (stale on its own) once it lasts 40 minutes |'));
  assert.ok(guide.includes('No file change alone reaches a score of 2 after 40 minutes'));
  assert.ok(guide.includes('`BULLSWARM_WORKER_NO_PROGRESS_SEC` seconds (default 3600'));
  const recovery = read('skill/references/recovery.md').replace(/\s+/g, ' ');
  assert.ok(!recovery.includes('its warning comes at least 20 minutes before the stop. Two cases'));
  assert.ok(recovery.includes('or at its fifth command since then if that comes later'));
});

test('the skill says the default claude-code pool has no MCP server or connector, and where an outward step that needs one goes', () => {
  const text = skillWide();
  assert.match(text, /default `claude-code` pool has no MCP server or connector/);
  assert.match(text, /names a named Claude home or another provider in `route\.pools\.use`/);
});
