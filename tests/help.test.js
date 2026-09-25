// Two layers of coverage:
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
  assert.match(helpForArgs(['workflow', 'runs', 'show', 'abc234', '-h']), /runs show <shortId\|runId>/);
  assert.match(helpForArgs(['workflow', 'runs', 'result', 'abc234', '-h']), /runs result <shortId\|runId>/);
});

test('help command syntax and aliases resolve without executing commands', () => {
  assert.match(helpForArgs(['help']), /Commands:/);
  assert.match(helpForArgs(['help', 'workflow', 'watch']), /workflow watch <runId>/);
  assert.match(helpForArgs(['runs', 'delete', '--help']), /^Usage: bullswarm runs delete/);
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
// The exact count changes as the command tree evolves.
test('HELP_PATHS enumerates the full routed command tree', () => {
  assert.ok(
    HELP_PATHS.length >= 60,
    `expected at least 60 routed paths (root + every top-level and nested subcommand), got ${HELP_PATHS.length}`,
  );
  assert.deepEqual(HELP_PATHS[0], [], 'first path must be the root node');
  assert.ok(HELP_PATHS.some((p) => p.join(' ') === 'workflow runs result'), 'a known leaf must be present');
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
test('every "runs" alias path mirrors canonical help while showing alias syntax', () => {
  const aliasPaths = HELP_PATHS.filter((p) => p[0] === 'runs');
  assert.ok(aliasPaths.length >= 5, 'expected the runs/list/show/result/delete alias subtree');
  for (const path of aliasPaths) {
    const canonical = ['workflow', ...path];
    const aliasText = helpForArgs([...path, '--help']);
    const canonicalText = helpForArgs([...canonical, '--help']);
    assert.equal(
      aliasText.replaceAll('bullswarm runs', 'bullswarm workflow runs'),
      canonicalText,
      `${path.join(' ')} must mirror ${canonical.join(' ')} after syntax normalization`,
    );
    assert.match(aliasText, /Usage: bullswarm runs/);
    assert.doesNotMatch(aliasText, /Usage: bullswarm workflow runs/);
  }
});

// Regression tests for the two specific parser/help-text divergences
// discovered and fixed in this help unification (see
// test-and-docs-map.md §3): help.js's hand-typed text had fallen behind
// what the real parsers (runs-cli.js, workflow/cli.js) actually accept.
test('previously-drifted flags are present in --help now that help.js is canonical', () => {
  assert.match(helpForArgs(['setup', '--help']), /--strategy/);
  assert.equal(
    helpForArgs(['setup', '--strategy', 'help']),
    helpForArgs(['setup', '--help']),
    'a trailing positional help token must remain side-effect-free even after options',
  );
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

// 0.27.1 aligned four help texts with what the parsers actually do. Each
// assertion below pins one of those four to the behaviour it now describes,
// so help cannot quietly drift back.
test('help describes the 0.27.1 command-surface behaviour it is now paired with', () => {
  const runHelp = helpForArgs(['run', '--help']);
  assert.match(runHelp, /--no-caller/, 'run --help must document --no-caller (read by cmdRun since 0.24)');
  assert.match(runHelp, /--lane .*required/s, 'run --help must say --lane is required');

  // The bare example used to be `workflow goal "..." --cwd .`, which the real
  // parser refuses with exit 2 for having no program, scout, or orchestrator.
  const workflowHelp = helpForArgs(['workflow', '--help']);
  const goalExamples = workflowHelp.split('\n').filter((l) => l.includes('bullswarm workflow goal'));
  assert.ok(goalExamples.length > 0, 'workflow --help must show a goal example');
  for (const example of goalExamples) {
    assert.match(
      example, /--program|--scout|--orchestrator/,
      `workflow --help example would exit 2 as written: ${example.trim()}`,
    );
  }

  // Three verbs have no human renderer. Usage, options and behaviour now
  // agree: the synopsis does not offer --json, the options block says the
  // flag selects nothing, and the purpose says the output is always JSON.
  for (const path of [['strategy', 'inventory'], ['strategy', 'routes'], ['workflow', 'capabilities']]) {
    const text = helpText(path);
    assert.doesNotMatch(
      text.split('\n')[0], /--json/,
      `${path.join(' ')}: the usage line must not advertise a flag that selects nothing`,
    );
    assert.match(text, /always JSON/, `${path.join(' ')}: help must say the output is always JSON`);
    assert.match(text, /--json/, `${path.join(' ')}: --json is still accepted and must stay documented`);
  }

  // health is the opposite case: --json used to be inert there too, and now
  // selects between a human summary and the machine-readable report.
  const healthHelp = helpText(['health']);
  assert.match(healthHelp, /--json .*machine-readable health report/);
  assert.match(healthHelp, /human-readable summary/);
  assert.doesNotMatch(healthHelp, /has no effect|always JSON/);

  // The root help is where an agent learns the input contract.
  const rootHelp = helpText([]);
  assert.match(rootHelp, /unknown flag --name/);
  assert.match(rootHelp, /exits 2/);
});

// Item 4 of the dashboard goal: bare `bullswarm` opens the dashboard once the
// installation is configured and the setup control center when it is not, and
// `--setup` forces setup from a configured machine. The three help texts a
// reader reaches that decision from must say so.
test('help describes the bare command as the dashboard with setup as the fallback', () => {
  const root = helpText([]);
  assert.match(root, /Bare `bullswarm` opens the dashboard/);
  assert.match(root, /the setup control center when it is not/);
  const rootOptions = root.split('\n\n')[3];
  assert.match(
    rootOptions,
    /--setup\s+bare `bullswarm` only: open the interactive setup control center/,
    'the root Options block must advertise --setup',
  );
  assert.match(root.split('\n\n')[5], /\$ bullswarm\n/, 'the root Example block shows the bare command');

  const setupHelp = helpText(['setup']);
  assert.match(setupHelp, /bare `bullswarm` opens the dashboard instead/);
  assert.match(setupHelp, /`bullswarm --setup` forces this setup path/);
  assert.match(setupHelp, /\$ bullswarm --setup\n/, 'setup --help shows the forcing form as an example');

  const tuiHelp = helpText(['workflow', 'tui']);
  assert.match(tuiHelp, /the same screen bare `bullswarm` opens on a configured terminal/);
  assert.match(tuiHelp, /sticky header/);
  assert.match(tuiHelp, /sticky bottom nav/);
  for (const page of ['Home (today', 'Runs (the workflow', 'Run (plan', 'Step (one action', 'Budget (quota', 'Stats (Overview', 'Fleet (lane/provider', 'and Help.']) {
    assert.ok(tuiHelp.includes(page), `workflow tui --help must describe the ${page.split(' ')[0]} page`);
  }
  // 0.33.0 merged History into Runs, so the tab row is five tabs and the help
  // names the day table rather than a History page.
  assert.ok(tuiHelp.includes('The tab row is Home, Runs, Budget, Stats, Fleet'), tuiHelp);
  assert.ok(tuiHelp.includes('History is the day table inside Runs'), tuiHelp);
  assert.ok(!/History \(a dated/.test(tuiHelp), tuiHelp);
  for (const key of ['q quits', 'h Home', '? Help', 'r Runs', 'b Budget', 's Stats', 'y the first day of the Runs history', 'f Fleet', 'Tab cycles sub-tabs', 'Shift+Tab cycles workflows', 'ctrl+s copies']) {
    assert.ok(tuiHelp.includes(key), `workflow tui --help must document the ${key.split(' ')[0]} key`);
  }
  assert.ok(!tuiHelp.includes('h or ? Help'), 'h no longer opens Help');
  assert.match(tuiHelp, /The mouse clicks tabs, tiles, bars, runs, steps, dates, and controls/);
  assert.match(tuiHelp, /the explicit form of the same dashboard/);

  // The workflow command list points at the same dashboard, with the same
  // pages named.
  assert.match(helpText(['workflow']), /open the dashboard \(Home, Runs, Run, Step, Budget, Stats, Fleet, Help\)/);
});

test('workflow help documents failed evidence and the planner contract evidence field', () => {
  const resume = helpText(['workflow', 'resume']);
  // Stage 3 rewords the resume safety line and points at the caller verbs;
  // the stage-1 clause (a build-lane step that changed nothing) still holds.
  assert.ok(resume.includes('a failed step whose failure is about the work itself (declared evidence, a deliverable not produced, a check that failed it, output judged failed, or a build-lane step with no declared deliverable that changed nothing) is not rerun; use step rerun, step accept, or plan revise'), resume);
  const contract = helpText(['workflow', 'plan', 'contract']);
  assert.match(contract, /evidence checks Bullswarm runs after steps/);
});

test('workflow reindex help exposes the exact usage line and flags', () => {
  const text = helpText(['workflow', 'reindex']);
  assert.equal(text.split('\n')[0], 'Usage: bullswarm workflow reindex [--json] [--force]');
  assert.match(text, /--json/);
  assert.match(text, /--force/);
  assert.match(helpForArgs(['workflow', 'reindex', '--help']), /Usage: bullswarm workflow reindex \[--json\] \[--force\]/);
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
    ['workflow', 'runs', 'show'],
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

test('workflow --help lists every workflow command that has its own help, reprice included', () => {
  const workflow = helpText(['workflow']);
  const commands = workflow.slice(workflow.indexOf('Commands:'), workflow.indexOf('\n\n', workflow.indexOf('Commands:')));
  const listed = new Set(commands.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]));
  const verbs = HELP_PATHS.filter((path) => path[0] === 'workflow' && path.length === 2).map((path) => path[1]);
  assert.ok(verbs.includes('reprice'));
  for (const verb of verbs) assert.ok(listed.has(verb), `workflow --help lists ${verb}`);
  assert.ok(commands.includes("reprice                      recompute past attempts' tokens and money from provider totals or transcripts; a dry run unless --apply"));
});

test('workflow step help lists restart, rerun and accept, each with its own entry', () => {
  const step = helpText(['workflow', 'step']);
  for (const verb of ['restart <runId> <step>', 'rerun <runId> <step>', 'accept <runId> <step>']) assert.ok(step.includes(verb), verb);
  assert.ok(step.includes("run a failed or finished step again with its last attempt's handoff; --avoid keeps it off pools and stays in the step's route"));
  assert.ok(step.includes('accept a failed step, or a check\'s failing requirements, by your choice (--reason); dependents run; recorded as evidence "choice", never proof'));
  const workflow = helpText(['workflow']);
  assert.ok(workflow.includes('step rerun <runId> <step>'));
  assert.ok(workflow.includes('step accept <runId> <step>'));

  const rerun = helpText(['workflow', 'step', 'rerun']);
  assert.equal(rerun.split('\n')[0], 'Usage: bullswarm workflow step rerun <runId> <step> [--avoid <pool>]... [--wait <seconds>] [--json]');
  assert.match(rerun, /--avoid <pool>/);
  assert.match(rerun, /route\.pools\.avoid/);
  assert.match(rerun, /bullswarm workflow step rerun ab12cd write-report --avoid pool-a/);
  assert.match(helpForArgs(['workflow', 'step', 'rerun', '--help']), /^Usage: bullswarm workflow step rerun /);
  // No step waits for a pool in a new run: only a saved run can hold a waiting step.
  assert.ok(rerun.replace(/\s+/g, ' ').includes('Run a failed, cancelled, interrupted, or finished step of a program run again (also a waiting step, which only a run saved by an earlier version can have).'));

  const accept = helpText(['workflow', 'step', 'accept']);
  assert.equal(accept.split('\n')[0], 'Usage: bullswarm workflow step accept <runId> <step> --reason "<why>" [--requirement <id>]... [--wait <seconds>] [--json]');
  for (const flag of ['--reason <text>', '--requirement <id>', '--wait <seconds>', '--json']) assert.ok(accept.includes(flag), flag);
  assert.match(accept, /never as proof/);
  assert.match(accept, /undo: bullswarm workflow step rerun <runId> <step>/);
});

test('--retry-attempts reads as automatic retries per step in all three places', () => {
  const wording = 'automatic retries per step before it comes back to you (process failures on another pool, gate failures on the same pool with the failure attached)';
  for (const path of [['workflow', 'goal'], ['workflow', 'plan', 'validate'], ['workflow', 'plan', 'contract']]) {
    const text = helpText(path);
    assert.ok(text.includes(`--retry-attempts <0..3>`), path.join(' '));
    assert.ok(text.includes(wording), path.join(' '));
    assert.ok(!text.includes('mechanical retry allowance'), path.join(' '));
  }
});

test('workflow goal help says a usage limit stops the dispatched planner or the scout and hands back the call', () => {
  const goal = helpText(['workflow', 'goal']).replace(/\s+/g, ' ');
  assert.ok(goal.includes('In a run started by this version a usage limit, a rate limit still there after its short backoff, or no free pool stops the dispatched planner or the scout, with no move to another pool: the run finishes with the reason (`the workflow planner stopped on a usage limit: …`) and your call: after its back at time, workflow resume runs the stopped planner or scout again (before then it can stop the same way); or plan it yourself with plan revise; or start a new run. A scout before your own program lets the run go on without its report, and resume does not run that scout again.'), goal);
  // Resume runs a stopped planner or scout again (it used to find nothing to retry).
  assert.match(goal, /stopped on a usage limit[^.]*workflow resume runs the stopped planner or scout again/);
  const resume = helpText(['workflow', 'resume']).replace(/\s+/g, ' ');
  assert.ok(resume.includes('In a run started by this version where a usage limit or no free pool stopped the dispatched planner or preflight scout and ended the run, it runs that planner or scout again first and prints `running again: the workflow planner` (or `the preflight scout`); run it after the back at time, or it can stop the same way. A scout the run went on without (one before your own program) is not run again.'), resume);
  // A preferred planner pool falls back only when it is out at the pick; a
  // usage limit it hits while it plans stops the run.
  const flag = 'a pool name prefers that pool and falls back when it is already quota-gated or unavailable at the pick; in a run started by this version a usage limit it hits while it plans stops the run instead';
  assert.ok(goal.includes(flag));
  assert.ok(!goal.includes('falls back when it is quota-gated or unavailable'));
  const cliReference = readFileSync(new URL('../docs/reference/cli.md', import.meta.url), 'utf8');
  assert.ok(cliReference.includes(`| \`--orchestrator <auto\\|pool>\` | dispatch a Workflow Planner agent at every planning boundary: \`auto\` lets the kernel route it, ${flag} |`));
});

test('watch --until lists needs you as trouble (a usage limit is one), and blocked dependents inside the block', () => {
  const watch = helpText(['workflow', 'watch']);
  assert.match(watch, /first needs you, failed, rejected, paused, stalled, stale or steering line \(a usage limit or no free pool is a needs-you block\), or at a planner or preflight scout stopped on a usage limit;/);
  assert.match(watch, /blocked dependents are listed inside the needs-you block/);
  // A marked run's scout stopped by a usage limit has its own line, and the
  // usage-limit line names no pause: nothing pauses a pool.
  const flatWatch = watch.replace(/\s+/g, ' ');
  assert.ok(flatWatch.includes('`⚠ preflight scout stopped · <label> on <pool> · back at <time>`, ending `· the run continues without its report` when the run has your program'));
  assert.ok(flatWatch.includes('(needs you, failed, rejected, scout stopped, planner stopped, paused, stalled, stale, steering)'));
  assert.ok(flatWatch.includes('A dispatched planner stopped the same way prints `✗ planner stopped · <label> on <pool> · back at <time>` and the run finishes; any other planner failure still prints `× planning attempt rejected · <why>`.'));
  assert.ok(flatWatch.includes('and the block carries `back at <time>` and a `wait for it` rerun when the reset is known'));
  assert.ok(!flatWatch.includes('not paused') && !flatWatch.includes('paused until <deadline>'));
  // No step waits for a pool, so there is no waiting line to wake on or replay at attach.
  assert.doesNotMatch(watch, /waiting \(more than 30 min\)/);
  assert.doesNotMatch(watch, /already waiting/);
});
