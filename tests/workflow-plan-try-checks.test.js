// plan validate --try-checks (0.38.4): validate runs nothing by default and
// says so when the program has command checks; with --try-checks it runs each
// command check once in the workspace, the way a step runs it, and reports
// the exit, the last output line and any files the check changed. The results
// never change the exit code. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PROGRAM_V3_SCHEMA_VERSION } from '../src/workflow/program-v3.js';
import { buildV3Contract } from '../src/workflow/contract-v3.js';
import { helpText } from '../src/help.js';

const cli = resolve('bin/bullswarm.js');
const V3 = PROGRAM_V3_SCHEMA_VERSION;

function fixture(t, { git: useGit = true, env: extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-try-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'acme');
  mkdirSync(home);
  mkdirSync(workspace);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n');
  if (useGit) {
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.email=dev@acme.test', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  }
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  Object.assign(env, extraEnv);
  const file = join(root, 'plan.json');
  const validate = (program, ...flags) => {
    writeFileSync(file, JSON.stringify(program));
    return spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Build acme', `--program=${file}`, `--cwd=${workspace}`, ...flags], { encoding: 'utf8', env });
  };
  return { root, home, workspace, validate };
}

const checkedProgram = () => ({
  schemaVersion: V3,
  steps: [
    {
      id: 'build',
      prompt: 'Build acme.',
      evidence: [
        { type: 'command', cmd: 'echo starting; echo MODULE_NOT_FOUND tests; exit 1' },
        { type: 'command', cmd: 'echo made > made.txt' },
        { type: 'command', cmd: 'test -s "$BULLSWARM_STEP_OUTPUT"' },
        { type: 'schema', file: 'out.json', schema: 'out.schema.json' },
      ],
    },
    { id: 'lint', dependsOn: ['build'], prompt: 'Lint acme.', evidence: [{ type: 'command', cmd: 'echo lint clean' }] },
  ],
});

const NOT_RUN = '  checks   not run · add --try-checks to run each command check once now against the current tree (it may take time and must not change files)';

test('without --try-checks validate runs no check and prints the not-run line', (t) => {
  const { workspace, validate } = fixture(t);
  const out = validate(checkedProgram());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const lines = out.stdout.split('\n');
  assert.ok(lines.includes(NOT_RUN), out.stdout);
  // After the step lines, before the launch line.
  assert.ok(lines.indexOf(NOT_RUN) > lines.findIndex((line) => line.startsWith('  lint ')), out.stdout);
  assert.ok(lines.indexOf(NOT_RUN) < lines.findIndex((line) => line.startsWith('  launch ')), out.stdout);
  assert.doesNotMatch(out.stdout, /^ {2}try /m);
  assert.equal(existsSync(join(workspace, 'made.txt')), false, 'the check that writes a file did not run');
  const json = JSON.parse(validate(checkedProgram(), '--json').stdout);
  assert.deepEqual(json.checks, { tried: false, commands: 4 });
  assert.equal(existsSync(join(workspace, 'made.txt')), false);
});

test('--try-checks prints one try line per command check and keeps exit 0 when a check fails', (t) => {
  const { home, workspace, validate } = fixture(t);
  const out = validate(checkedProgram(), '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const lines = out.stdout.split('\n');
  const tries = lines.filter((line) => /^ {2}try /.test(line));
  assert.deepEqual(tries, [
    '  try      echo starting; echo MODULE_NOT_FOUND tests; exit 1 → exit 1',
    '  try      echo made > made.txt → exit 0 · changed files: made.txt',
    '  try      test -s "$BULLSWARM_STEP_OUTPUT" → not tried: it reads the step\'s output',
    '  try      echo lint clean → exit 0 · lint clean',
  ]);
  // A failed check's output follows its try line, indented under it.
  assert.deepEqual(lines.slice(lines.indexOf(tries[0]) + 1, lines.indexOf(tries[0]) + 3), ['           starting', '           MODULE_NOT_FOUND tests']);
  // Each try line sits under its own step.
  const build = lines.findIndex((line) => line.startsWith('  build '));
  const lint = lines.findIndex((line) => line.startsWith('  lint '));
  assert.ok(lines.indexOf(tries[0]) === build + 1 && lines.indexOf(tries[3]) === lint + 1, out.stdout);
  assert.ok(!lines.includes(NOT_RUN));
  assert.ok(existsSync(join(workspace, 'made.txt')), 'the check ran in the workspace; nothing is restored');
  assert.equal(existsSync(join(home, 'workflows')) && readdirSync(join(home, 'workflows')).length > 0, false, 'no run folder');
});

test('--try-checks --json carries the tried results', (t) => {
  const { validate } = fixture(t);
  const out = validate(checkedProgram(), '--try-checks', '--json');
  assert.equal(out.status, 0, out.stderr);
  const { checks } = JSON.parse(out.stdout);
  assert.equal(checks.tried, true);
  assert.deepEqual(checks.results.map(({ step, index, cmd, exit, timedOut, changedFiles }) => ({ step, index, cmd, exit, timedOut, changedFiles })), [
    { step: 'build', index: 1, cmd: 'echo starting; echo MODULE_NOT_FOUND tests; exit 1', exit: 1, timedOut: false, changedFiles: [] },
    { step: 'build', index: 2, cmd: 'echo made > made.txt', exit: 0, timedOut: false, changedFiles: ['made.txt'] },
    { step: 'build', index: 3, cmd: 'test -s "$BULLSWARM_STEP_OUTPUT"', exit: null, timedOut: false, changedFiles: [] },
    { step: 'lint', index: 1, cmd: 'echo lint clean', exit: 0, timedOut: false, changedFiles: [] },
  ]);
  assert.equal(checks.results[0].tail, 'starting\nMODULE_NOT_FOUND tests');
  assert.equal(checks.results[2].notTried, 'it reads the step\'s output');
});

test('--try-checks reports a timed-out check with its own timeout', (t) => {
  const { validate } = fixture(t);
  const program = { schemaVersion: V3, steps: [{ id: 'build', prompt: 'Build acme.', evidence: [{ type: 'command', cmd: 'sleep 20', timeoutSec: 1 }] }] };
  const out = validate(program, '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^ {2}try {6}sleep 20 → timed out after 1s$/m);
});

test('a program with no command checks prints nothing new, with or without --try-checks', (t) => {
  const { validate } = fixture(t);
  const program = { schemaVersion: V3, steps: [{ id: 'build', prompt: 'Build acme.', evidence: [{ type: 'schema', file: 'out.json', schema: 'out.schema.json' }] }] };
  for (const flags of [[], ['--try-checks']]) {
    const out = validate(program, ...flags);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /^ {2}(checks|try) /m);
    assert.equal(Object.hasOwn(JSON.parse(validate(program, ...flags, '--json').stdout), 'checks'), false);
  }
});

test('help and the v3 contract describe --try-checks', () => {
  const help = helpText(['workflow', 'plan', 'validate']);
  assert.match(help, /--try-checks/);
  assert.match(help, /safe to run now/);
  assert.match(help, /never change the exit code/);
  const contract = buildV3Contract({ goal: 'g', cwd: '/work/acme', next: {} });
  assert.match(contract.program.evidence.note, /plan validate --try-checks runs each command check once/);
});

const oneStep = (...cmds) => ({
  schemaVersion: V3,
  steps: [{ id: 'build', prompt: 'Build acme.', evidence: cmds.map((cmd) => ({ type: 'command', cmd })) }],
});

// Every file under a folder → its bytes, to prove a run left it byte-identical.
function contents(dir) {
  const files = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path.slice(dir.length)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return files;
}

test('--try-checks runs each check once, with the evidence shell, folder and environment', (t) => {
  const { root, workspace, validate } = fixture(t, { env: { BULLSWARM_DEPTH: '3', ACME_KEPT: 'kept' } });
  const program = oneStep(
    'echo x >> ../count-a; printf "shell=%s evidence=%s step=%s depth=%s kept=%s pwd=%s\\n" "$0" "$BULLSWARM_EVIDENCE" "$BULLSWARM_STEP_ID" "$BULLSWARM_DEPTH" "$ACME_KEPT" "$(pwd -P)"',
    'echo x >> ../count-b; exit 7',
  );
  const out = validate(program, '--try-checks', '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const { results } = JSON.parse(out.stdout).checks;
  assert.equal(results[0].tail, `shell=/bin/sh evidence=1 step=build depth=4 kept=kept pwd=${realpathSync(workspace)}`);
  assert.equal(results[1].exit, 7);
  assert.equal(readFileSync(join(root, 'count-a'), 'utf8'), 'x\n', 'the first check ran once');
  assert.equal(readFileSync(join(root, 'count-b'), 'utf8'), 'x\n', 'the second check ran once');
});

test('a check that reads $output is not tried and does not run', (t) => {
  const { workspace, validate } = fixture(t);
  const out = validate(oneStep('cat "$output" > seen.txt'), '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^ {2}try {6}cat "\$output" > seen\.txt → not tried: it reads the step's output$/m);
  assert.equal(existsSync(join(workspace, 'seen.txt')), false);
});

test('the try line keeps the whole last output line', (t) => {
  const { validate } = fixture(t);
  const long = 'A'.repeat(130);
  const out = validate(oneStep(`echo first; echo ${long}; echo`), '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  // The label may be shortened; the last output line is not.
  assert.match(out.stdout, new RegExp(`→ exit 0 · ${long}$`, 'm'));
});

test('changedFiles names ignored files, and files in a folder outside git', (t) => {
  for (const git of [true, false]) {
    const { workspace, validate } = fixture(t, { git });
    const out = validate(oneStep('printf hidden > ignored.txt; printf new > sub-new.txt; rm README.md'), '--try-checks', '--json');
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.deepEqual(JSON.parse(out.stdout).checks.results[0].changedFiles, ['README.md', 'ignored.txt', 'sub-new.txt'], `git=${git}`);
    assert.ok(existsSync(join(workspace, 'ignored.txt')) && !existsSync(join(workspace, 'README.md')), 'nothing is restored');
    const human = validate(oneStep('printf again >> ignored.txt'), '--try-checks');
    assert.match(human.stdout, /^ {2}try {6}printf again >> ignored\.txt → exit 0 · changed files: ignored\.txt$/m, `git=${git}`);
  }
});

test('--try-checks writes nothing into the Bullswarm home', (t) => {
  const { home, validate } = fixture(t);
  // The first command on a fresh home sets it up, with or without the flag.
  assert.equal(validate(oneStep('echo ok')).status, 0);
  const before = contents(home);
  const out = validate(oneStep('echo ok', 'echo more'), '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^ {2}try /m);
  assert.deepEqual(contents(home), before);
});

test('the skill and changelog describe --try-checks and accept inside a loop', () => {
  const skill = readFileSync('skill/SKILL.md', 'utf8');
  assert.ok(Buffer.byteLength(skill) <= 15_000);
  const rule5 = skill.slice(skill.indexOf('5. **Checks are facts.**'), skill.indexOf('6. **'));
  assert.match(rule5, /workflow plan validate … --try-checks/);
  assert.match(rule5.replace(/\s+/g, ' '), /not ones that write, deploy, call paid services or take long/);
  assert.match(rule5.replace(/\s+/g, ' '), /missing module or command means the check itself is wrong/);
  assert.doesNotMatch(rule5, /by hand/);
  for (const text of [skill, readFileSync('skill/references/recovery.md', 'utf8')]) {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /step accept` on a failed step inside a loop does not end the loop \(the next round still starts\)/);
    assert.match(flat, /let it run out of rounds \(`maxRounds`\), then `(bullswarm )?workflow continue <shortId> <loop>`/);
  }
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const unreleased = changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 1));
  assert.match(unreleased, /^- plan validate: `--try-checks`/m);
  assert.match(unreleased, /^- docs: `workflow step accept` on a failed step inside a loop/m);
});

const oneStepCmd = (cmd) => ({ schemaVersion: V3, steps: [{ id: 'build', prompt: 'Build acme.', evidence: [{ type: 'command', cmd }] }] });
const INDENT = ' '.repeat(11);

test('a long failed check shows its first 14 lines, a hidden-lines marker, its last 12 lines and the log path', (t) => {
  const { validate } = fixture(t);
  // An error line first, then 40 lines: 41 in all, so 15 are hidden.
  const out = validate(oneStepCmd('echo "Error: Cannot find module acme"; for i in $(seq 1 40); do echo "  line $i"; done; exit 1'), '--try-checks', '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const { log } = JSON.parse(out.stdout).checks.results[0];
  assert.ok(log && existsSync(log), 'the log file is kept');
  t.after(() => rmSync(dirname(log), { recursive: true, force: true }));
  const human = validate(oneStepCmd('echo "Error: Cannot find module acme"; for i in $(seq 1 40); do echo "  line $i"; done; exit 1'), '--try-checks');
  const lines = human.stdout.split('\n');
  const head = lines.findIndex((line) => /^ {2}try {6}.* → exit 1$/.test(line));
  assert.ok(head >= 0, human.stdout);
  const logPath = lines.find((line) => line.startsWith(`${INDENT}full output: `)).slice(INDENT.length + 'full output: '.length);
  t.after(() => rmSync(dirname(logPath), { recursive: true, force: true }));
  const expected = [
    'Error: Cannot find module acme',
    ...Array.from({ length: 13 }, (_, i) => `  line ${i + 1}`),
    '… 15 more lines …',
    ...Array.from({ length: 12 }, (_, i) => `  line ${i + 29}`),
  ].map((line) => `${INDENT}${line}`);
  assert.deepEqual(lines.slice(head + 1, head + 1 + expected.length), expected);
  assert.equal(lines[head + 1 + expected.length], `${INDENT}full output: ${logPath}`);
  const logged = readFileSync(logPath, 'utf8');
  assert.ok(logged.includes('Error: Cannot find module acme\n') && logged.includes('  line 15\n') && logged.includes('  line 40\n'), 'the log holds every line');
});

test('a short failed check shows all its lines and the log path', (t) => {
  const { validate } = fixture(t);
  const out = validate(oneStepCmd('for i in 1 2 3 4 5; do echo "  row $i"; done; exit 1'), '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const lines = out.stdout.split('\n');
  const head = lines.findIndex((line) => /^ {2}try {6}.* → exit 1$/.test(line));
  assert.ok(head >= 0, out.stdout);
  assert.deepEqual(lines.slice(head + 1, head + 6), [1, 2, 3, 4, 5].map((i) => `${INDENT}  row ${i}`));
  assert.match(lines[head + 6], /^ {11}full output: .+\.log$/);
  assert.doesNotMatch(out.stdout, /more lines/);
  t.after(() => rmSync(dirname(lines[head + 6].trim().slice('full output: '.length)), { recursive: true, force: true }));
});

test('a check that exits 0 stays one line, without a log path', (t) => {
  const { validate } = fixture(t);
  const out = validate(oneStepCmd('echo a; echo b'), '--try-checks');
  assert.match(out.stdout, /→ exit 0 · b$/m);
  assert.doesNotMatch(out.stdout, /^ {11}/m);
  assert.doesNotMatch(out.stdout, /full output/);
});

test('a timed-out check shows the end of its output under the try line', (t) => {
  const { validate } = fixture(t);
  const program = { schemaVersion: V3, steps: [{ id: 'build', prompt: 'Build acme.', evidence: [{ type: 'command', cmd: 'echo about-to-hang; sleep 30', timeoutSec: 1 }] }] };
  const out = validate(program, '--try-checks');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /→ timed out after 1s\n {11}about-to-hang$/m);
});

test('node --test on a folder shows why it failed (MODULE_NOT_FOUND) in the printed text', (t) => {
  // Outside the outer test runner's context, so the inner node --test runs as a top-level one.
  const { workspace, validate } = fixture(t, { env: { NODE_TEST_CONTEXT: undefined } });
  mkdirSync(join(workspace, 'tests'));
  writeFileSync(join(workspace, 'tests', 'a.test.js'), "import { test } from 'node:test';\ntest('a', () => {});\n");
  const out = validate(oneStepCmd('node --test tests/'), '--try-checks', '--json');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const [result] = JSON.parse(out.stdout).checks.results;
  t.after(() => result.log && rmSync(dirname(result.log), { recursive: true, force: true }));
  if (result.exit === 0) return; // this Node reads a folder: the check passes
  const human = validate(oneStepCmd('node --test tests/'), '--try-checks');
  const logPath = /full output: (.+)$/m.exec(human.stdout)?.[1];
  if (logPath) t.after(() => rmSync(dirname(logPath), { recursive: true, force: true }));
  assert.match(human.stdout, /^ {11}.*MODULE_NOT_FOUND/m);
});
