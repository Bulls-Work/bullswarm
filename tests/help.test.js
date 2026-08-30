// Two layers of coverage, matching the split documented in
// tests/workflow-draft.test.js:
//   L1. In-process: walks HELP_PATHS (the same programmatic enumeration
//       helpForArgs()/usageLine()/helpText() are built on) against
//       helpForArgs()/helpText() directly. Fast and exhaustive — every path
//       the tree actually contains gets a content assertion, with no
//       hardcoded second list to drift from HELP_PATHS itself.
//   L2. spawnSync: a small sample against the real `bullswarm` binary, to
//       lock in the user-facing contract (real exit code, real stdio, real
//       environment) that in-process calls can't observe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HELP_PATHS, helpForArgs, helpText, usageLine } from '../src/help.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

test('every documented command and nested subcommand accepts --help', () => {
  const base = mkdtempSync(join(tmpdir(), 'bullswarm-help-'));
  const bullswarmHome = join(base, 'must-not-be-created');
  try {
    for (const path of HELP_PATHS) {
      const result = spawnSync(process.execPath, [BIN, ...path, '--help'], {
        cwd: ROOT,
        env: { ...process.env, BULLSWARM_HOME: bullswarmHome },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${path.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage: bullswarm/m, path.join(' '));
      assert.equal(result.stderr, '', path.join(' '));
    }
    assert.equal(existsSync(bullswarmHome), false, 'help must not initialize Bullswarm state');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('help remains contextual when operands precede the flag', () => {
  assert.match(helpForArgs(['workflow', 'run', 'demo', '--help']), /workflow run <file-or-name>/);
  assert.match(helpForArgs(['workflow', 'runs', 'show', 'abc234', '-h']), /runs show <shortId\|runId>/);
  assert.match(helpForArgs(['workflow', 'runs', 'result', 'abc234', '-h']), /runs result <shortId\|runId>/);
  assert.match(helpForArgs(['workflow', 'draft', 'step', 'add', 'd', 'p', 's', '--help']), /draft step add/);
});

test('help command syntax and aliases resolve without executing commands', () => {
  assert.match(helpForArgs(['help']), /Commands:/);
  assert.match(helpForArgs(['help', 'workflow', 'watch']), /workflow watch <runId>/);
  assert.match(helpForArgs(['runs', 'delete', '--help']), /workflow runs delete/);
  assert.match(helpForArgs(['--version', '--help']), /^Usage: bullswarm version/);
  assert.equal(helpForArgs(['workflow', 'list']), null);
});

test('help stays contextual with operands, flags, and quoted text ahead of --help', () => {
  assert.match(
    helpForArgs(['run', '--lane', 'analyze', '--add-dir', '.', 'do the thing', '--help']),
    /^Usage: bullswarm run /,
  );
  assert.match(
    helpForArgs(['strategy', 'assign', 'high', '--pool', 'x', '--model', 'y', '--help']),
    /^Usage: bullswarm strategy assign/,
  );
});

// HELP_PATHS is the single enumeration hook for "every routed command and
// nested subcommand" (src/help.js's collectPaths() walk of the HELP tree).
// This is a floor, not an exact count, so adding a command doesn't break
// this test — but a large drop (a subtree silently unwired from HELP) would.
// The exact count at the time this test was written was 68 (verified via
// `HELP_PATHS.length` — see tests-and-docs.md for the derivation).
test('HELP_PATHS enumerates the full routed command tree', () => {
  assert.ok(
    HELP_PATHS.length >= 65,
    `expected at least 65 routed paths (root + every top-level and nested subcommand), got ${HELP_PATHS.length}`,
  );
  assert.deepEqual(HELP_PATHS[0], [], 'first path must be the root node');
  assert.ok(HELP_PATHS.some((p) => p.join(' ') === 'workflow draft step add'), 'a known leaf must be present');
});

// Richness bar (item 2 of the help work): every leaf must be Usage / Purpose
// / Arguments-or-Commands / Options / Safety / Example / Next, not just a
// Usage line. This walks every HELP_PATHS entry in-process (fast, exhaustive
// — no separate hardcoded list of commands to expect content for) and checks
// structure, not just presence of a "Usage:" prefix.
test('every routed leaf renders the full 7-section richness bar, not just a Usage line', () => {
  // A bare "Usage: bullswarm <cmd>" line is well under 100 chars; the
  // shortest real leaf in this tree is ~270 chars. 200 sits strictly between
  // the two, so this floor rejects a regression to a bare usage line without
  // being fragile against trimming a verbose leaf.
  const BARE_USAGE_LINE_CEILING = 200;
  const RESERVED_HEADERS = /^(Usage|Arguments|Commands|Options|Safety|Example|Next):/;

  for (const path of HELP_PATHS) {
    const label = path.join(' ') || '(root)';
    const text = helpForArgs([...path, '--help']);

    // Every path must resolve to its OWN node's text, not silently fall
    // back to a parent or the root — this is what would happen if a leaf
    // were mistakenly left out of the HELP tree while still appearing in
    // HELP_PATHS's walk of some other structure.
    assert.equal(text, helpText(path), `${label}: helpForArgs must match helpText for the same path`);

    const sections = text.split('\n\n');
    assert.equal(sections.length, 7, `${label}: expected 7 sections, got ${sections.length}`);
    const [usageS, purposeS, argsOrCommandsS, optionsS, safetyS, exampleS, nextS] = sections;

    assert.equal(usageS, `Usage: ${usageLine(path)}`, `${label}: Usage section must match usageLine()`);
    assert.ok(
      purposeS.length >= 15 && !RESERVED_HEADERS.test(purposeS),
      `${label}: purpose section missing or too thin: ${JSON.stringify(purposeS)}`,
    );
    assert.match(argsOrCommandsS, /^(Arguments|Commands):/, `${label}: missing Arguments/Commands section`);
    assert.match(optionsS, /^Options:/, `${label}: missing Options section`);
    assert.match(safetyS, /^Safety:/, `${label}: missing Safety section`);
    assert.match(exampleS, /^Example:\n\s*\$ /, `${label}: missing a concrete "$ ..." example line`);
    assert.match(nextS, /^Next: \S/, `${label}: missing a next-command section`);
    assert.ok(
      text.length >= BARE_USAGE_LINE_CEILING,
      `${label}: help text (${text.length} chars) is no richer than a bare usage line`,
    );

    // Every flag named in the Usage synopsis must also appear in the
    // Options section — catches one leaf's usage/options pair drifting
    // apart (e.g. a flag added to the synopsis but not documented, or
    // vice versa), without duplicating help.js's option tables in this
    // test file.
    const usageFlags = new Set(usageS.match(/--[a-zA-Z][\w-]*/g) ?? []);
    for (const flag of usageFlags) {
      assert.ok(optionsS.includes(flag), `${label}: Usage names ${flag} but Options section omits it`);
    }
  }
});

// The top-level `runs` alias is documented (README/SKILL) as behaving
// identically to `workflow runs`. Walk every alias path exhaustively
// (rather than spot-checking one) so a future alias leaf that's added to
// one side but not the other is caught.
test('every "runs" alias path resolves to identical text as its "workflow runs" counterpart', () => {
  const aliasPaths = HELP_PATHS.filter((p) => p[0] === 'runs');
  assert.ok(aliasPaths.length >= 5, 'expected the runs/list/show/result/delete alias subtree');
  for (const path of aliasPaths) {
    const canonical = ['workflow', ...path];
    assert.equal(
      helpForArgs([...path, '--help']),
      helpForArgs([...canonical, '--help']),
      `${path.join(' ')} must resolve to the same text as ${canonical.join(' ')}`,
    );
  }
});

// Regression tests for the two specific parser/help-text divergences
// discovered and fixed in this help unification (see
// test-and-docs-map.md §3): help.js's hand-typed text had fallen behind
// what the real parsers (runs-cli.js, workflow/cli.js) actually accept.
test('previously-drifted flags are present in --help now that help.js is canonical', () => {
  assert.match(helpForArgs(['setup', '--help']), /--strategy/);
  const goalHelp = helpForArgs(['workflow', 'goal', '--help']);
  assert.match(goalHelp, /--detach/, 'workflow goal --help must document --detach (accepted by the real parser)');
  for (const flag of ['--orchestrator-model', '--worker-pool', '--worker-model']) {
    assert.ok(goalHelp.includes(flag), `workflow goal --help must document ${flag}`);
  }

  const runsHelp = helpForArgs(['workflow', 'runs', '--help']);
  for (const alias of ['--from', '--started-after', '--to', '--started-before']) {
    assert.ok(
      runsHelp.includes(alias),
      `workflow runs --help must document the ${alias} time-filter alias (accepted by runs-cli.js)`,
    );
  }
});

// Preserved behavior: --help must never spawn a delegate coding-agent CLI
// process. Exercising this against the real binary with PATH stripped to
// nothing but the node executable's own directory is a real, executable
// check — if any of these commands attempted to spawn codex/claude/grok (or
// any other external binary), resolution would fail and the process would
// exit non-zero or print to stderr. A representative sample of the
// heaviest-side-effect commands is used rather than the full 68-path sweep,
// to keep this test fast; the full sweep in the "accepts --help" test above
// already re-confirms no state directory is created for every path.
test('help never spawns a delegate CLI process, even for the heaviest commands', () => {
  const restrictedPath = dirname(process.execPath);
  const heavy = [
    [],
    ['run'],
    ['workflow', 'goal'],
    ['strategy', 'refresh'],
    ['workflow', 'draft', 'step', 'add'],
    ['pools'],
    ['setup'],
  ];
  for (const path of heavy) {
    const result = spawnSync(process.execPath, [BIN, ...path, '--help'], {
      cwd: ROOT,
      env: { PATH: restrictedPath },
      encoding: 'utf8',
    });
    const label = path.join(' ') || '(root)';
    assert.equal(result.status, 0, `${label}: exited ${result.status} with a hostile PATH — stderr: ${result.stderr}`);
    assert.equal(result.stderr, '', `${label}: unexpected stderr with a hostile PATH`);
    assert.match(result.stdout, /^Usage: bullswarm/m, label);
  }
});

// Drift guard: src/help.js is meant to be the ONLY place a command synopsis
// is declared (see the file's own header comment and
// help-core-implementation.md §3). This scans every other .js/.mjs file
// under src/, bin/, and mcp/ for a hand-typed "usage: bullswarm ..." /
// "Usage: bullswarm ..." string — the pattern every real duplicate-site
// used before the usageLine()/helpText() redirect. Comment-only lines are
// skipped so a stale doc comment (not user-facing output) doesn't count.
test('no command synopsis is hand-typed outside src/help.js', () => {
  const HELP_JS = join(ROOT, 'src', 'help.js');
  const roots = ['src', 'bin', 'mcp'].map((d) => join(ROOT, d)).filter((d) => existsSync(d));

  function collectJsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) collectJsFiles(full, out);
      else if (/\.(js|mjs)$/.test(name)) out.push(full);
    }
    return out;
  }

  const files = roots.flatMap((r) => collectJsFiles(r)).filter((f) => f !== HELP_JS);
  assert.ok(files.length > 10, 'sanity check: the scan should find many source files');

  const driftHits = [];
  let redirectCallSites = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//')) return;
      if (/usageLine\(|helpText\(/.test(line)) redirectCallSites++;
      if (/usage:\s*bullswarm|Usage:\s*bullswarm/i.test(line)) {
        driftHits.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(driftHits, [], 'hand-typed command synopsis found outside src/help.js');
  // Positive check: the redirect mechanism must actually be in use. Without
  // this, deleting every usageLine()/helpText() call and hand-typing
  // synopses in a style this regex doesn't happen to match would pass the
  // guard vacuously.
  assert.ok(
    redirectCallSites >= 30,
    `expected at least 30 usageLine()/helpText() redirect call sites outside help.js, found ${redirectCallSites}`,
  );
});
