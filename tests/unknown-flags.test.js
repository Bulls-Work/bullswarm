// The command surface's input gate, exercised against the real binary.
//
// Before 0.27.1 every parser silently dropped a flag it did not recognize:
// `pools --bogus-flag` and `workflow goal "..." --porgram plan.json` both
// exited 0, the second one launching a run nobody asked for. Three layers:
//   L1. spawnSync against bin/bullswarm.js — five commands (one per parser)
//       reject a bogus flag with exit 2 and name the flag.
//   L2. spawnSync — the two typed-input cases the audit recorded as wrong.
//   L3. in-process — the known-flag table and src/help.js cannot drift apart,
//       and every command form README/SKILL/operations.md documents is
//       accepted by the table for its own command path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HELP_PATHS, helpText, usageLine } from '../src/help.js';
import { KNOWN_FLAGS, UNDOCUMENTED_FLAGS, flagName, flagNames, unknownFlagExit } from '../src/lib/cli-flags.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

function run(argv) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-flags-'));
  try {
    return spawnSync(process.execPath, [BIN, ...argv], {
      cwd: ROOT,
      env: {
        ...process.env,
        BULLSWARM_HOME: home,
        BULLSWARM_DISABLE_CLAUDE_PROFILES: '1',
        BULLSWARM_DISABLE_OPENCODE_RELAY: '1',
      },
      encoding: 'utf8',
      input: '',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// One command per parser: src/cli.js (pools, run), src/strategy-cli.js
// (strategy rungs), src/workflow/runs-cli.js (workflow runs list),
// src/workflow/cli.js (workflow goal). Every one of these exited 0 before.
const BOGUS_CASES = [
  { argv: ['pools', '--bogus-flag'], usage: ['pools'] },
  { argv: ['assignments', '--bogus-flag'], usage: ['assignments'] },
  { argv: ['run', '--lane', 'analyze', '--bogus-flag', '--dry-run', 'probe'], usage: ['run'] },
  { argv: ['strategy', 'rungs', '--bogus-flag'], usage: ['strategy', 'rungs'] },
  { argv: ['workflow', 'runs', 'list', '--bogus-flag'], usage: ['workflow', 'runs', 'list'] },
  { argv: ['workflow', 'goal', 'probe goal', '--bogus-flag'], usage: ['workflow', 'goal'] },
];

test('every command path rejects an unknown flag with exit 2 and names it', () => {
  for (const { argv, usage } of BOGUS_CASES) {
    const label = argv.join(' ');
    const result = run(argv);
    assert.equal(result.status, 2, `${label}: expected exit 2, got ${result.status} (stdout: ${result.stdout})`);
    assert.match(result.stderr, /unknown flag --bogus-flag/, label);
    assert.ok(
      result.stderr.includes(usageLine(usage)),
      `${label}: error must carry the command's own usage line, got: ${result.stderr}`,
    );
  }
});

test('a bogus flag is rejected before any state directory is initialized', () => {
  const base = mkdtempSync(join(tmpdir(), 'bullswarm-flags-nostate-'));
  const home = join(base, 'must-not-be-created');
  try {
    const result = spawnSync(process.execPath, [BIN, 'pools', '--bogus-flag'], {
      cwd: ROOT, env: { ...process.env, BULLSWARM_HOME: home }, encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      spawnSync('test', ['-e', home]).status, 1,
      'rejecting a flag must not self-initialize ~/.bullswarm',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The two malformed-value cases the 2026-09-09 audit reproduced: one exited 0
// and silently ignored the input, the other exited 1 with a routing message.
test('workflow runs list --limit nope is a usage error, not a silent full list', () => {
  const result = run(['workflow', 'runs', 'list', '--limit', 'nope']);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stdout: ${result.stdout})`);
  assert.match(result.stderr, /--limit must be a positive integer \(got "nope"\)/);
  assert.ok(result.stderr.includes(usageLine(['workflow', 'runs', 'list'])), result.stderr);
});

test('run without --lane is a usage error that names the fix', () => {
  const result = run(['run', '--add-dir', '.', '--dry-run', 'probe']);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stdout: ${result.stdout})`);
  assert.match(result.stderr, /--lane is required \(analyze\|build\|chore\)/);
  assert.doesNotMatch(result.stderr, /unknown lane undefined/);
});

test('a lane that is not a routing lane is rejected at the boundary too', () => {
  const result = run(['run', '--lane', 'nope', '--dry-run', 'probe']);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stdout: ${result.stdout})`);
  assert.match(result.stderr, /--lane must be analyze, build, chore \(got "nope"\)/);
});

test('a value flag with no value is still a usage error, not a silent default', () => {
  const result = run(['workflow', 'runs', 'list', '--limit']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /--limit requires a value/);
});

// --- the table itself -------------------------------------------------------

test('the known-flag table covers exactly the routed command tree', () => {
  const helpKeys = HELP_PATHS.map((p) => p.join(' ')).sort();
  assert.deepEqual(Object.keys(KNOWN_FLAGS).sort(), helpKeys,
    'every help path needs a known-flag row, and no row may name a path that does not exist');
});

// Two-way drift guard, the reason the table is keyed by help path: help can
// no longer advertise an option the parser rejects, and the parser can no
// longer accept an option nothing documents without saying why in
// UNDOCUMENTED_FLAGS.
test('the known-flag table and src/help.js cannot drift apart', () => {
  for (const path of HELP_PATHS) {
    const key = path.join(' ');
    const label = key || '(root)';
    const text = helpText(path);
    const optionsSection = text.split('\n\n')[3];
    const advertised = optionsSection.split('\n').slice(1)
      .map((line) => (line.match(/^ {2}(--[a-zA-Z][\w-]*)/) ?? [])[1])
      .filter(Boolean)
      .map((flag) => flag.slice(2));
    const accepted = KNOWN_FLAGS[key];
    const excused = UNDOCUMENTED_FLAGS[key] ?? [];

    for (const flag of advertised) {
      assert.ok(accepted.includes(flag), `${label}: help advertises --${flag} but the parser would reject it`);
    }
    for (const flag of accepted) {
      if (flag === 'help' || excused.includes(flag)) continue;
      assert.ok(text.includes(`--${flag}`), `${label}: --${flag} is accepted but appears nowhere in its help text`);
    }
    for (const flag of excused) {
      assert.ok(accepted.includes(flag), `${label}: UNDOCUMENTED_FLAGS lists --${flag}, which is not accepted`);
    }
  }
});

// Every command form the shipped documentation shows must survive the gate.
// A flag that is real, used, and simply missing from a table would turn a
// documented command into exit 2 — the one regression this change could cause.
test('every command form README/SKILL/operations.md documents is accepted', () => {
  const sources = [
    'README.md',
    join('skill', 'SKILL.md'),
    join('skill', 'references', 'operations.md'),
  ];
  const helpKeys = new Set(HELP_PATHS.map((p) => p.join(' ')));
  let checked = 0;

  for (const source of sources) {
    const raw = readFileSync(join(ROOT, source), 'utf8').replace(/\\\n\s*/g, ' ');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('bullswarm ') && trimmed !== 'bullswarm') continue;
      // Documented forms carry trailing `# what this does` notes, which are
      // prose, not argv — and several of those notes name flags.
      const command = trimmed.split(/\s+#\s/)[0].trim();
      const argv = tokenize(command).slice(1);
      const path = [];
      for (const token of argv) {
        if (token.startsWith('-')) break;
        if (!helpKeys.has([...path, token].join(' '))) break;
        path.push(token);
      }
      const accepted = KNOWN_FLAGS[path.join(' ')];
      assert.ok(accepted, `${source}: "${command}" resolved to no known command path`);
      for (const flag of flagNames(argv)) {
        assert.ok(
          accepted.includes(flag),
          `${source}: documented form "${command}" passes --${flag}, which "bullswarm ${path.join(' ')}" would reject with exit 2`,
        );
      }
      checked++;
    }
  }
  assert.ok(checked >= 100, `expected the docs to yield at least 100 command forms, got ${checked}`);
});

// Shell-ish tokenizer: the documented forms quote goal text and messages.
function tokenize(line) {
  const out = [];
  let current = '';
  let quote = null;
  let quoted = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if (ch === ' ') {
      if (current || quoted) { out.push(current); current = ''; quoted = false; }
      continue;
    }
    current += ch;
  }
  if (current || quoted) out.push(current);
  return out;
}

test('flag-shaped tokens are recognized without swallowing operands', () => {
  assert.equal(flagName('--lane'), 'lane');
  assert.equal(flagName('--cwd=/tmp/x'), 'cwd');
  assert.equal(flagName('-h'), null, 'single-dash tokens are not long flags');
  assert.equal(flagName('--'), null, 'a bare -- keeps whatever meaning the parser gave it');
  assert.equal(flagName('-5'), null);
  assert.deepEqual(flagNames(['--json', 'x', '--json', '--limit=3']), ['json', 'limit']);
});

test('unknownFlagExit reports every unknown flag once, then the usage line', () => {
  const lines = [];
  const exit = unknownFlagExit(['json', 'nope', 'alsonope'], ['pools'], { error: (l) => lines.push(l) });
  assert.equal(exit, 2);
  assert.deepEqual(lines, [
    '✗ unknown flag --nope',
    '✗ unknown flag --alsonope',
    `usage: ${usageLine(['pools'])}`,
  ]);
  assert.equal(unknownFlagExit(['json', 'force'], ['pools'], { error: () => {} }), null);
  assert.equal(unknownFlagExit(['anything'], null, { error: () => {} }), null,
    'a path with no table is not flag-checked');
});
