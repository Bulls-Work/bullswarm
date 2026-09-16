// Central CLI help tree — the single source of truth for every command's
// synopsis, positional arguments, aliases, and public options. Both the
// `--help`/`-h`/`help` renderer below AND the real argument parsers in
// src/cli.js, src/strategy-cli.js, src/integrate.js, and src/workflow/*.js
// read usage text from this tree via usageLine()/helpText() instead of
// hand-typing their own copies, so the two can no longer drift apart.
//
// Help is resolved before setup or command dispatch (see helpForArgs() and
// its caller in src/cli.js's main()) so `--help` is side-effect free even
// for commands that normally touch state. This module must stay free of
// filesystem/network imports and side effects at load time to preserve that
// guarantee — it only builds plain strings from literals.

// --- rich-leaf renderer -----------------------------------------------------
// Used for the "core surface" commands (root, setup, integrate, run,
// strategy) per the CLI help richness bar: every leaf gets a purpose, its
// positional arguments, every public option (with default where
// applicable), safety/side-effect notes, a runnable example, and the
// natural next command. Hidden/internal flags are never listed here.

function fmtList(items) {
  if (!items.length) return '  (none)';
  const width = Math.max(...items.map((i) => i.label.length));
  return items.map((i) => `  ${i.label.padEnd(width)}  ${i.desc}`).join('\n');
}

function fmtOptions(options) {
  return fmtList(options.map((o) => ({
    label: o.flag,
    desc: o.default != null ? `${o.desc} (default: ${o.default})` : o.desc,
  })));
}

function fmtBullets(lines) {
  return lines.map((l) => `  - ${l}`).join('\n');
}

function fmtExamples(examples) {
  return examples.map((e) => `  $ ${e.cmd}${e.note ? `\n    # ${e.note}` : ''}`).join('\n');
}

function rich({ usage, purpose, argsTitle = 'Arguments', args = [], options = [], safety, examples, next }) {
  return [
    `Usage: ${usage}`,
    purpose,
    `${argsTitle}:\n${fmtList(args.map((a) => ({ label: a.name, desc: a.desc })))}`,
    `Options:\n${fmtOptions(options)}`,
    `Safety:\n${fmtBullets(Array.isArray(safety) ? safety : [safety])}`,
    `Example:\n${fmtExamples(examples)}`,
    `Next: ${next}`,
  ].join('\n\n');
}

// --- root -------------------------------------------------------------------

const top = rich({
  usage: 'bullswarm <command> [options]',
  purpose: 'Route work across coding-agent subscriptions and verify the result before treating '
    + 'it as done. There are exactly two ways to start work: `bullswarm run` dispatches one '
    + 'bounded task to a single agent, and `bullswarm workflow goal` executes a program you '
    + 'author across a coordinated multi-agent run. Bare `bullswarm` opens the dashboard — '
    + 'Home, Run, Step, Usage, Help — once this machine is configured, and the setup control '
    + "center when it is not. Reach for a specific command's --help for full options.",
  argsTitle: 'Commands',
  args: [
    { name: 'setup', desc: 'discover and configure installed coding agents' },
    { name: 'integrate', desc: 'register Bullswarm guidance with Codex, Claude, and Grok' },
    { name: 'run', desc: 'dispatch one bounded task' },
    { name: 'health', desc: 're-judge saved delegate outputs' },
    { name: 'pools', desc: 'show routing pools, meters, in-flight load, and quarantine state' },
    { name: 'assignments', desc: 'list the work in flight right now across every Bullswarm process' },
    { name: 'strategy', desc: 'discover models and manage tier assignments' },
    { name: 'provider', desc: 'list, enable, validate, scaffold, and probe the providers that define pools' },
    { name: 'doctor', desc: 'report installation readiness' },
    { name: 'workflow', desc: 'plan, execute, observe, and audit workflows' },
    { name: 'runs', desc: 'alias for workflow runs' },
    { name: 'version', desc: 'print the installed version' },
    { name: 'update', desc: 'upgrade the installed package to the latest published version' },
    { name: 'release', desc: 'create a version commit and tag' },
  ],
  options: [
    { flag: '--yes', desc: 'bare `bullswarm` only: skip the dashboard and the interactive wizard and auto-initialize with discovered defaults. It takes the `bullswarm setup` path, so it accepts every option that command documents', default: 'prompts on a TTY; auto-initializes for a non-TTY caller' },
    { flag: '--setup', desc: 'bare `bullswarm` only: open the interactive setup control center even when this machine is already configured', default: 'off — a configured terminal opens the dashboard' },
  ],
  safety: [
    'every command below except a --help/-h/help invocation self-initializes ~/.bullswarm/state.json (or $BULLSWARM_HOME) on first use',
    '--help/-h/help never reads or writes state, calls a network endpoint, or spawns a process, on any command',
    'an unrecognized option is a usage error on every command: Bullswarm prints "unknown flag --name" plus that '
      + "command's synopsis and exits 2, before self-initializing, routing, or spawning anything — a typo can no "
      + 'longer launch a run',
    'malformed option values are rejected at the same boundary with exit 2 (for example a missing --lane, or a '
      + '--limit that is not a positive integer)',
  ],
  examples: [
    { cmd: 'bullswarm', note: 'open the dashboard once this machine is configured; an unconfigured machine opens setup instead' },
    { cmd: 'bullswarm --setup && bullswarm workflow tui --json', note: 'force setup on a configured machine, then read the dashboard\'s run list non-interactively' },
    { cmd: 'bullswarm setup --yes && bullswarm run --lane analyze "audit this repo for TODOs"', note: 'one-time initialization, then one bounded task' },
    { cmd: 'bullswarm workflow goal "1. Fix the parser. 2. Add tests." --cwd . --program plan.json', note: 'author the program yourself, the kernel routes and verifies it' },
  ],
  next: "bullswarm <command> --help for that command's full arguments, options, and defaults.",
});

// --- setup --------------------------------------------------------------------

const setupText = rich({
  usage: 'bullswarm setup [--wizard] [--yes] [--strategy] [--integrate] [--agents <list>] [--json]',
  purpose: 'Discover installed agent CLIs (codex, claude, grok, ...) and initialize local '
    + 'routing state. Bare setup on a TTY opens the provider/model control center; agents '
    + 'and CI retain deterministic non-interactive setup. On a machine that is already '
    + 'configured, bare `bullswarm` opens the dashboard instead — `bullswarm --setup` forces '
    + 'this setup path from there, and the dashboard\'s Usage page reaches it with [edit].',
  args: [],
  options: [
    { flag: '--wizard', desc: 'open the comprehensive question-based wizard for worktree, reasoning-depth, and integration settings', default: 'off; bare setup opens the provider/model control center' },
    { flag: '--yes', desc: 'skip interactive setup and initialize with discovered defaults', default: 'interactive control center on a TTY' },
    { flag: '--strategy', desc: 'discover models, apply the recommended effort-tier routes, and enable strategy autopilot; requires --yes', default: 'off' },
    { flag: '--integrate', desc: 'also install agent integration (skill symlink + awareness block); requires --yes', default: 'off' },
    { flag: '--agents <list>', desc: 'comma-separated agent list for --integrate (codex, claude, grok)', default: 'all three' },
    { flag: '--json', desc: 'print a machine-readable result instead of human summary lines', default: 'human summary' },
  ],
  safety: [
    'writes ~/.bullswarm/state.json and routing.json (or $BULLSWARM_HOME equivalents)',
    'with --integrate --yes, also writes symlinks and awareness-block markers under each selected agent\'s global config directory (~/.codex, ~/.claude, ~/.grok)',
    'a non-TTY caller (the common case for an agent) auto-applies discovered defaults without prompting, even without --yes',
    '--wizard shows each suggested rung with its benchmark evidence and asks one reasoning level per configured effort tier; Enter keeps that connector\'s own default and writes nothing, and agents set the same values with bullswarm strategy set-reasoning or set-rung',
  ],
  examples: [
    { cmd: 'bullswarm --setup', note: 'open this same control center from a machine where bare `bullswarm` would open the dashboard' },
    { cmd: 'bullswarm setup', note: 'browse providers, models, effort tiers, meters, and effective routes interactively' },
    { cmd: 'bullswarm setup --wizard', note: 'use the broader question-based configuration flow, including reasoning depth per effort tier' },
    { cmd: 'bullswarm setup --yes --integrate --agents claude,codex', note: 'non-interactive initialization plus agent integration; safe in CI or from an agent' },
  ],
  next: 'bullswarm doctor to confirm readiness, then bullswarm run or bullswarm workflow goal to dispatch work.',
});

// --- integrate ----------------------------------------------------------------

const integrateText = rich({
  usage: 'bullswarm integrate <status|install|remove|retire-legacy> [options]',
  purpose: 'Manage the packaged Bullswarm skill and a short recursion-safe awareness rule '
    + "inside each installed coding agent's global configuration, so agents can discover "
    + 'Bullswarm on their own.',
  argsTitle: 'Commands',
  args: [
    { name: 'status', desc: 'report install state per agent (default when no subcommand is given)' },
    { name: 'install', desc: 'symlink the skill and append the awareness block; for Claude also link the Claude Mod and enable function hooks' },
    { name: 'remove', desc: 'remove only the Bullswarm-managed symlinks, awareness block and hooks flag' },
    { name: 'retire-legacy', desc: 'recoverably archive the retired pre-Bullswarm offload skill' },
  ],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict the action to specific agents', default: 'all three' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    'install/remove write outside this repo, under each agent\'s home-dir config (~/.codex, ~/.claude, ~/.grok); status only reads integration files, though the common CLI bootstrap may initialize ~/.bullswarm state on a fresh machine',
    'for Claude, install links ~/.claude/skills/bullswarm-mod to the packaged Claude Mod and sets env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS to "1" in ~/.claude/settings.json (function hooks are early access in Claude Code); remove unlinks the mod and clears that key',
    'install refuses to replace a non-Bullswarm file found at the same path',
    'retire-legacy renames (moves), never deletes, the legacy skill directory',
  ],
  examples: [
    { cmd: 'bullswarm integrate status', note: 'check which agents already have the skill, awareness block and (for Claude) the mod installed' },
  ],
  next: 'bullswarm integrate install --yes to install for all discovered agents.',
});

const integrateStatusText = rich({
  usage: 'bullswarm integrate status [--agents codex,claude,grok] [--json]',
  purpose: 'Report, per agent, whether the packaged skill symlink and the awareness block are '
    + 'installed (for Claude, also the Claude Mod link and the function-hooks flag), and whether '
    + 'a legacy pre-Bullswarm offload skill needs retiring.',
  args: [],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict the report to specific agents', default: 'all three' },
    { flag: '--json', desc: 'machine-readable output', default: 'human summary lines' },
  ],
  safety: ['does not change agent integration files; the common CLI bootstrap may initialize ~/.bullswarm state on a fresh machine'],
  examples: [{ cmd: 'bullswarm integrate status --json' }],
  next: 'bullswarm integrate install --yes if anything reported is missing.',
});

const integrateInstallText = rich({
  usage: 'bullswarm integrate install [--agents codex,claude,grok] --yes [--json]',
  purpose: "Symlink the packaged Bullswarm skill and append the awareness block marker into "
    + "each selected agent's global instructions file. For Claude, also link the Claude Mod "
    + "(mods/bullswarm) under ~/.claude/skills and set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in "
    + "~/.claude/settings.json so Claude Code loads it in every session.",
  args: [],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict install to specific agents', default: 'all three' },
    { flag: '--yes', desc: 'required — approves writing global agent configuration', default: 'none; the command refuses without it' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    "writes/symlinks under each agent's global config directory (~/.codex, ~/.claude, ~/.grok)",
    'refuses to replace a non-Bullswarm skill path instead of overwriting it',
    'edits only the env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS key of ~/.claude/settings.json and leaves a file that is not a JSON object alone, reporting it',
    'idempotent: re-running after a successful install makes no further changes',
  ],
  examples: [{ cmd: 'bullswarm integrate install --agents codex,claude --yes' }],
  next: 'bullswarm integrate status to confirm the install.',
});

const integrateRemoveText = rich({
  usage: 'bullswarm integrate remove [--agents codex,claude,grok] --yes [--json]',
  purpose: 'Remove only the Bullswarm-managed skill symlink and awareness marker block, '
    + "leaving any other content in the agent's configuration untouched.",
  args: [],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict removal to specific agents', default: 'all three' },
    { flag: '--yes', desc: 'required — approves editing global agent configuration', default: 'none; the command refuses without it' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    "writes under each agent's global config directory (~/.codex, ~/.claude, ~/.grok)",
    'only deletes the Bullswarm symlink and strips the marker block; a conflicting non-symlink path is left untouched, not deleted',
  ],
  examples: [{ cmd: 'bullswarm integrate remove --yes' }],
  next: 'bullswarm integrate status to confirm removal.',
});

const integrateRetireLegacyText = rich({
  usage: 'bullswarm integrate retire-legacy --yes [--json]',
  purpose: 'Recoverably archive the retired pre-Bullswarm ~/.claude/skills/offload skill so it '
    + 'stops shadowing Bullswarm guidance for Claude.',
  args: [],
  options: [
    { flag: '--yes', desc: 'required — approves moving a user skill directory', default: 'none; the command refuses without it' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    'renames (moves) the directory into ~/.claude/skills-archive/; it is never deleted',
    'a no-op, reported as such, if the legacy skill is not installed',
  ],
  examples: [{ cmd: 'bullswarm integrate retire-legacy --yes' }],
  next: 'bullswarm integrate status to confirm.',
});

// --- run ------------------------------------------------------------------------

const runText = rich({
  usage: 'bullswarm run --lane <analyze|build|chore> --add-dir <dir> (--task-file <file> | --prompt <text> | <task text...>) [options]',
  purpose: 'Dispatch one bounded task to the best-available delegate pool (or keep it on the '
    + 'calling agent when nothing suitable is eligible), then verify the saved output before '
    + 'reporting a verdict.',
  args: [
    { name: '<task text...>', desc: 'the task prompt, as trailing words; mutually exclusive with --prompt and --task-file' },
  ],
  options: [
    { flag: '--lane <analyze|build|chore>', desc: 'which routing lane to use: analyze (exploratory/large), build (implementation), chore (small/cheap)', default: 'required — omitting it, or passing anything else, exits 2' },
    { flag: '--add-dir <dir>', desc: 'working directory the delegate operates in', default: 'current directory' },
    { flag: '--task-file <file>', desc: 'read the task text from a file instead of trailing words' },
    { flag: '--prompt <text>', desc: 'pass the task text inline as one flag value' },
    { flag: '--effort <high|medium|low>', desc: 'override the effort tier used for model-tier routing', default: 'derived from --lane (analyze→medium, build→medium, chore→low)' },
    { flag: '--reasoning <low|medium|high|xhigh|max|default>', desc: "run-wide thinking-level override, clamped to what the picked pool's connector accepts; `default` passes nothing and lets the delegate CLI's own configuration decide", default: 'strategy reasoning setting for the effort tier, else the connector default' },
    { flag: '--timeout <seconds>', desc: 'hard wall-clock kill timer for the delegate process', default: 'none — the delegate is allowed to run to completion' },
    { flag: '--heartbeat <seconds>', desc: 'print one compact progress heartbeat to stderr per interval without streaming delegate output', default: 'off' },
    { flag: '--dry-run', desc: 'print the routing decision, the forecast it was made on, and the exact command that would be spawned (including the resolved reasoning flag) without spawning it, registering an in-flight assignment, or writing the decision log', default: 'off (dispatches for real)' },
    { flag: '--no-caller', desc: 'exclude the calling agent from routing, so the task must go to a delegate pool or fail', default: 'off — the caller competes for the lane like any other pool' },
    { flag: '--json', desc: 'print the machine-readable verdict document', default: 'human-readable summary line' },
  ],
  safety: [
    'spawns a real external coding-agent CLI process rooted at --add-dir (never with --dry-run)',
    'writes ~/.bullswarm/state.json (decision log, pool incumbency) on completion; --dry-run writes neither',
    'registers the picked pool in the shared in-flight ledger (~/.bullswarm/assignments/) for the life of the run and releases it when the attempt ends; --dry-run registers nothing',
    'may quarantine a pool for a period after an authentication failure',
  ],
  examples: [
    { cmd: 'bullswarm run --lane analyze --add-dir . "List every TODO comment in src/ with file:line"', note: 'routes one bounded analysis task and prints the verdict' },
    { cmd: 'bullswarm run --lane build --add-dir . --reasoning max --dry-run --json "Refactor the loader"', note: 'shows the exact argv, including the clamped reasoning flag, without dispatching' },
    { cmd: 'bullswarm run --lane build --add-dir . --dry-run "Refactor the loader"', note: 'prints a `forecast:` line — inflight count, projected 5h percent before and after this assignment, its expected minutes, the measured burn rate, and the basis of that estimate' },
  ],
  next: 'bullswarm health to re-judge saved outputs, or bullswarm pools to check routing/quota state before the next run.',
});

// --- version & release ---------------------------------------------------------
// Not part of item 4's five core surfaces, but classified THIN in the
// inventory (cli-help-inventory.md §2), so brought up to the same bar here.

const versionText = rich({
  usage: 'bullswarm version',
  purpose: 'Print the installed bullswarm package version. `bullswarm --version` is an '
    + 'equivalent alias handled the same way by the command dispatcher.',
  args: [],
  options: [],
  safety: ['self-initializes ~/.bullswarm/state.json (or $BULLSWARM_HOME) on first use, like every other non-help command — see the root command\'s Safety note'],
  examples: [{ cmd: 'bullswarm version' }],
  next: 'bullswarm doctor to check installation readiness.',
});

const updateText = rich({
  usage: 'bullswarm update [--check] [--json]',
  purpose: 'Upgrade this installation of bullswarm to the latest version published on npm, in '
    + 'place. A global npm install is upgraded with `npm install -g bullswarm@<latest> --prefix '
    + '<its own prefix>`, so the copy that is running is the one replaced even when several Node '
    + 'installs are on PATH. A global pnpm install lives in a per-version store directory that is '
    + 'not a prefix, so it is upgraded with `pnpm add -g bullswarm@<latest>` and verified through '
    + 'the link under the pnpm global node_modules. A source checkout (a clone, or a global '
    + 'install that is an `npm link` into one) is pulled with `git pull --ff-only` instead and is '
    + 'refused while it has local changes. The result is verified by re-reading package.json on '
    + 'disk, never by the package manager\'s exit code.',
  args: [],
  options: [
    { flag: '--check', desc: 'only compare the installed version with the latest published one; changes nothing', default: 'off (upgrades)' },
    { flag: '--json', desc: 'machine-readable result: install {kind: global|pnpm-global|checkout|unknown, root, prefix}, verifiedAt (the copy `after` was read from — install.root is where the RUNNING copy was found, which pnpm leaves on its old store directory), before, latest, after, upToDate, updated, error, notes[]', default: 'human-readable lines' },
  ],
  safety: [
    'reads https://registry.npmjs.org/bullswarm/latest (8s timeout); without --check, runs npm install -g into the running install\'s own prefix, pnpm add -g for a pnpm global install, or git pull --ff-only in a source checkout',
    'a source checkout with uncommitted changes is left untouched and the exit is 1',
    'exit 0 = at the latest published version afterwards (or --check reported); exit 1 = registry, npm, pnpm or git refused, or the install shape is unknown',
    'the running process keeps its old version; the next bullswarm command runs the new one',
  ],
  examples: [
    { cmd: 'bullswarm update --check', note: 'is a newer version published?' },
    { cmd: 'bullswarm update', note: 'upgrade in place' },
  ],
  next: 'bullswarm version to confirm, then bullswarm integrate status if a skill link looks stale.',
});

const releaseText = rich({
  usage: 'bullswarm release <patch|minor|major> [--dry-run]',
  purpose: 'Bump the package.json version, commit that change, and create an annotated git '
    + 'tag locally. For maintainers cutting a bullswarm release, not for routine use.',
  args: [
    { name: '<patch|minor|major>', desc: 'semver bump kind: patch for fixes, minor for new verbs/connectors/behavior, major for verdict-contract or config-format breaking changes' },
  ],
  options: [
    { flag: '--dry-run', desc: 'compute and print the resulting version/tag without writing or committing anything', default: 'off (writes for real)' },
  ],
  safety: [
    'refuses if the working tree is not clean (git status --porcelain must be empty)',
    'without --dry-run: writes package.json, and runs `git commit` and `git tag -a` locally',
    'never pushes or publishes — `git push`/`git push --tags`/`npm publish` are separate, manual steps (the command prints the exact push command to run next)',
  ],
  examples: [{ cmd: 'bullswarm release patch --dry-run' }],
  next: 'git push && git push --tags once ready to publish (CI publishes to npm via trusted publishing).',
});

// --- health, pools, doctor -----------------------------------------------------
// Classified "RICH (minimal)" in the inventory (already had a one-line body,
// not THIN/MISSING/SHADOWED), but the goal is every leaf at the same bar and
// each of these three has an undocumented state-write side effect — worth
// disclosing even though this trio wasn't the task's explicit trigger list.

const healthText = rich({
  usage: 'bullswarm health [--json]',
  purpose: 'Re-judge every saved delegate output against the real verify gate and report where '
    + 'a logged FAIL verdict re-judges as a pass (the "gate ate real work" signal), plus any '
    + 'pool quarantine clustering.',
  args: [],
  options: [
    { flag: '--json', desc: 'print the machine-readable health report', default: 'human-readable summary of the same facts' },
  ],
  safety: [
    'reads every out-* file under ~/.bullswarm/runs/ and re-runs the verify judge over each — cost scales with run history size',
    'if any pool quarantine has expired, writes the released state back to state.json (same sweep other commands perform); otherwise read-only',
  ],
  examples: [
    { cmd: 'bullswarm health' },
    { cmd: 'bullswarm health --json', note: 'the same facts as a JSON document; exit 1 means unhealthy, not a crash' },
  ],
  next: 'bullswarm pools to see current routing/quarantine state directly.',
});

const poolsText = rich({
  usage: 'bullswarm pools [--force] [--json]',
  purpose: 'Show every configured pool: cost rank, lanes, live meter usage/elapsed percentage, '
    + 'pace surplus, in-flight assignment count, projected 5-hour utilization, and '
    + 'quarantine/burst-gate status. The 5-hour column reads `5h=<reading>%` alone when '
    + 'nothing is in flight and `5h=<reading>%-><projected>%` when in-flight work is '
    + 'expected to push the window further; routing decides on the right-hand number. '
    + 'A trailing `(<n>% elapsed)` is how much of that 5-hour window has already run: '
    + 'routing only deprioritizes a near-limit pool whose usage is ahead of its clock. '
    + 'A pool whose weekly window resets within 24 hours, or whose monthly window resets '
    + 'within 3 days, ends its line with `resets in <Nd Nh|Nh Nm|Nm> EXPIRING-SOON '
    + 'urgency=<n>`: quota about to be lost, scored as surplus divided by the fraction '
    + 'of the window still to run, which is what routing ranks it on.',
  args: [],
  options: [
    { flag: '--force', desc: 'bypass the meter cache and re-read live usage for every pool', default: 'off (cached meter readings reused within their TTL)' },
    { flag: '--json', desc: 'machine-readable pool array, each entry carrying inflight {count, minutes, remainingMinutes, unknownExpected, records[]}, spend {fiveHour, weekly, monthly, pacing} rates with their source and sample count, pacingWindow, paceResetsAt, resetSource (provider | declared | null), and projectedFiveHourPct / projectedWeeklyPct / projectedMonthlyPct / projectedPacingPct', default: 'human-readable aligned table' },
  ],
  safety: [
    'calls each connector\'s live usage meter (network request per metered pool) to compute used/elapsed percentages',
    'always writes state.json after sweeping expired quarantines back into service, even in --json mode',
    'reading the in-flight ledger prunes entries left behind by crashed processes (dead pids, or older than 12 hours)',
  ],
  examples: [{ cmd: 'bullswarm pools --force' }],
  next: 'bullswarm assignments to see which run and action each in-flight entry belongs to.',
});

const assignmentsText = rich({
  usage: 'bullswarm assignments [--json]',
  purpose: 'List the work in flight RIGHT NOW across every Bullswarm process — one line per '
    + 'live assignment with its pool, lane/effort, source, run/action, age in minutes, expected '
    + 'duration, and worker pid. This is the shared ledger `bullswarm pools` counts as '
    + 'inflight=<n>, so a run started by another terminal or kernel appears here too.',
  args: [],
  options: [
    { flag: '--json', desc: 'machine-readable array of live assignment records', default: 'one human-readable line per assignment' },
  ],
  safety: [
    'reads ~/.bullswarm/assignments/ only — no meters, no network, no pool build',
    'prunes entries whose kernel and worker processes are both gone, and entries older than 12 hours, so a crashed process leaves no phantom load',
  ],
  examples: [
    { cmd: 'bullswarm assignments' },
    { cmd: 'bullswarm assignments --json', note: 'each record carries pool, source, runId, actionId, kernelPid, workerPid, startedAt, elapsedMinutes, expectedMinutes, remainingMinutes' },
  ],
  next: 'bullswarm pools to see that same load next to each pool\'s meter and pace surplus.',
});

const doctorText = rich({
  usage: 'bullswarm doctor [--json]',
  purpose: 'Report installation readiness — config present, at least one agent CLI discovered, '
    + 'meters reachable, at least one delegate pool enabled — with the exact fix command for '
    + 'anything failing.',
  args: [],
  options: [
    { flag: '--json', desc: 'machine-readable { version, configured, ok, checks[], nextActions[] }', default: 'human-readable checklist with ✓/✗ per check' },
  ],
  safety: [
    'self-heals: if ~/.bullswarm is not yet configured, runs the same auto-setup as any other verb before reporting, so it writes state.json/connector files on a fresh machine',
    'calls each connector\'s live usage meter to populate the "meters" check (network request per metered pool)',
    'exit code is 0 when every check passes, 1 if any check fails',
  ],
  examples: [{ cmd: 'bullswarm doctor --json' }],
  next: 'bullswarm setup --yes to apply the fix commands doctor prints under nextActions.',
});

// --- strategy -----------------------------------------------------------------

const strategyText = rich({
  usage: 'bullswarm strategy [command] [options]',
  purpose: 'Open the provider/model strategy control center on a terminal. Toggle whole providers, '
    + 'assign each detected model to any combination of high/medium/low effort, and preview the live route.',
  argsTitle: 'Commands',
  args: [
    { name: 'tui', desc: 'open the interactive strategy control center (default on a TTY)' },
    { name: 'inventory', desc: 'machine-readable providers, models, selections, meters, and effective routes' },
    { name: 'routes', desc: 'print only the currently effective high/medium/low choices' },
    { name: 'rungs', desc: 'list every pool/tier rung with its model, reasoning, evidence, and local record' },
    { name: 'set-provider', desc: 'enable or disable one provider pool non-interactively' },
    { name: 'set-model', desc: 'assign one model to multiple effort tiers or turn it off' },
    { name: 'set-rung', desc: 'set one pool/tier model and reasoning level in one atomic write' },
    { name: 'reset-tier', desc: 'return one tier from an explicit allow-list to automatic routing' },
    { name: 'set-reasoning', desc: 'set how hard one effort tier thinks, globally or for one pool' },
    { name: 'reset-reasoning', desc: 'return reasoning depth to the connector defaults' },
    { name: 'configure', desc: 'atomically apply an agent-authored JSON strategy file' },
    { name: 'refresh', desc: 'discover models and recommend tiers (recommend is an alias)' },
    { name: 'apply', desc: 'approve the last discovered recommendations' },
    { name: 'show', desc: 'print the last captured strategy report' },
    { name: 'assign', desc: 'pin an explicit pool/model for one tier' },
    { name: 'clear-assignment', desc: 'remove one tier pin' },
    { name: 'exclude-model', desc: 'persistently block a model from any dispatch' },
    { name: 'include-model', desc: 'remove a model exclusion' },
    { name: 'set-subscription', desc: 'record known plan economics for a pool' },
    { name: 'auto', desc: 'inspect or disable the auto-apply-on-refresh policy' },
  ],
  options: [
    { flag: '--json', desc: 'machine-readable output where the subcommand supports it' },
  ],
  safety: [
    'refresh/apply/assign/clear-assignment/exclude-model/include-model/set-subscription/set-reasoning/reset-reasoning/set-rung all mutate ~/.bullswarm/state.json',
    'refresh (and a cold show) perform live discovery calls against every installed agent CLI and the public OpenRouter model API',
  ],
  examples: [
    { cmd: 'bullswarm strategy', note: 'browse and configure interactively' },
    { cmd: 'bullswarm strategy inventory --json', note: 'inspect everything from another agent' },
  ],
  next: 'Use arrows and Enter in the TUI, or inventory --json plus configure --file for an agent.',
});

const strategyTuiText = rich({
  usage: 'bullswarm strategy tui',
  purpose: 'Open the full-screen provider and model strategy control center. Analysis previews one OpenRouter-backed default per provider/tier before Y applies it.', args: [], options: [],
  safety: ['Provider Space toggles and model-tier Enter toggles persist immediately; select Finish setup or press F to exit'],
  examples: [{ cmd: 'bullswarm strategy tui' }], next: 'Use bullswarm strategy routes --json to inspect the effective result.',
});
const strategyInventoryText = rich({
  usage: 'bullswarm strategy inventory [--refresh]',
  purpose: 'Return detected provider pools, models, selections, live meters, and effective routes for an agentic caller. The output is always JSON.', args: [],
  options: [{ flag: '--json', desc: 'accepted so agents can pass it uniformly; it selects nothing, because this command has no human renderer', default: 'output is always JSON, with or without the flag' }, { flag: '--refresh', desc: 'rerun model discovery and meters' }],
  safety: ['read-only apart from refreshing the cached discovery report'], examples: [{ cmd: 'bullswarm strategy inventory --json --refresh' }],
  next: 'Use set-provider, set-model, or configure --file to change the policy.',
});
const strategyRoutesText = rich({
  usage: 'bullswarm strategy routes [--refresh]', purpose: 'Show the live effective choice for high/analyze, medium/build, and low/chore. The output is always JSON.',
  args: [], options: [{ flag: '--json', desc: 'accepted so agents can pass it uniformly; it selects nothing, because this command has no human renderer', default: 'output is always JSON, with or without the flag' }, { flag: '--refresh', desc: 'refresh meters first' }],
  safety: ['read-only apart from refreshing cached discovery'], examples: [{ cmd: 'bullswarm strategy routes --json' }], next: 'Run bullswarm strategy to adjust the choices.',
});
const strategySetProviderText = rich({
  usage: 'bullswarm strategy set-provider <pool> <on|off> --yes', purpose: 'Enable or disable one detected provider/account as a whole.',
  args: [{ name: '<pool>', desc: 'exact pool name from strategy inventory' }, { name: '<on|off>', desc: 'new state' }],
  options: [{ flag: '--yes', desc: 'required approval' }], safety: ['changes routing immediately for new dispatches'],
  examples: [{ cmd: 'bullswarm strategy set-provider relay:b off --yes' }], next: 'Use strategy routes --json to confirm.',
});
const strategySetModelText = rich({
  usage: 'bullswarm strategy set-model <pool> <model> --tiers <high,medium,low|off> --yes', purpose: 'Assign one model to one or more effort tiers.',
  args: [{ name: '<pool>', desc: 'exact pool name' }, { name: '<model>', desc: 'exact detected model ID' }],
  options: [{ flag: '--tiers <list|off>', desc: 'comma-separated multi-selection or off' }, { flag: '--yes', desc: 'required approval' }],
  safety: ['a configured tier becomes an allow-list; leaving it with no enabled models makes that tier unavailable'],
  examples: [{ cmd: 'bullswarm strategy set-model relay a/gpt-5.6-sol --tiers high,medium,low --yes' }], next: 'Use strategy routes --json to confirm.',
});
const strategyConfigureText = rich({
  usage: 'bullswarm strategy configure --file <json> --yes',
  purpose: 'Atomically apply provider toggles, model tier combinations, and reasoning depth from an agent-authored JSON file.',
  args: [],
  options: [
    { flag: '--file <json>', desc: 'object with optional providers, models, and reasoning maps; '
      + 'reasoning is { "tiers": { "high": "xhigh" }, "pools": { "codex": { "high": "high" } } } '
      + 'where each level is low, medium, high, xhigh, max, default, or null to remove it' },
    { flag: '--yes', desc: 'required approval' },
  ],
  safety: [
    'validates the complete document before saving routing state',
    'an invalid reasoning section rejects the whole document; nothing is written',
  ],
  examples: [{ cmd: 'bullswarm strategy configure --file strategy.json --yes' }], next: 'Use strategy inventory --json to verify the applied state.',
});
const strategyResetTierText = rich({
  usage: 'bullswarm strategy reset-tier <high|medium|low> --yes', purpose: 'Remove the explicit model allow-list for one effort tier and return it to automatic routing.',
  args: [{ name: '<high|medium|low>', desc: 'tier to restore' }], options: [{ flag: '--yes', desc: 'required approval' }],
  safety: ['removes that tier from every model selection and clears its legacy pin'],
  examples: [{ cmd: 'bullswarm strategy reset-tier low --yes' }], next: 'Use strategy routes --json to confirm the automatic route.',
});

const strategySetReasoningText = rich({
  usage: 'bullswarm strategy set-reasoning --tier <high|medium|low> --level <low|medium|high|xhigh|max|default> [--pool <name>] --yes',
  purpose: 'Set how hard one effort tier thinks. This is a separate dimension from the model: '
    + 'the tier chooses WHICH model runs, reasoning chooses HOW DEEPLY it thinks before answering.',
  args: [],
  options: [
    { flag: '--tier <high|medium|low>', desc: 'effort tier to configure' },
    { flag: '--level <level>', desc: 'low, medium, high, xhigh, max, or default (pass nothing and let the worker CLI decide)' },
    { flag: '--pool <name>', desc: 'apply to one provider pool only', default: 'every pool' },
    { flag: '--yes', desc: 'required approval' },
  ],
  safety: [
    'changes what every later dispatch on that tier sends to the worker CLI',
    'a level a CLI cannot express is clamped down to the strongest level it accepts, never up',
  ],
  examples: [{ cmd: 'bullswarm strategy set-reasoning --tier high --level xhigh --yes' }],
  next: 'Use strategy inventory --json to see the effective level and its source per pool.',
});

const strategyResetReasoningText = rich({
  usage: 'bullswarm strategy reset-reasoning [--tier <high|medium|low>] [--pool <name>] --yes',
  purpose: 'Remove configured reasoning levels so the affected tiers fall back to each connector\'s own defaults.',
  args: [],
  options: [
    { flag: '--tier <high|medium|low>', desc: 'clear one effort tier everywhere', default: 'every tier' },
    { flag: '--pool <name>', desc: 'clear one provider pool only', default: 'the global tier defaults too' },
    { flag: '--yes', desc: 'required approval' },
  ],
  safety: [
    'with no --tier and no --pool this clears every configured reasoning level at once',
    '--tier alone also removes that tier from every per-pool override',
  ],
  examples: [{ cmd: 'bullswarm strategy reset-reasoning --tier low --yes' }],
  next: 'Use strategy routes --json to confirm the level each tier now resolves to.',
});

const strategyRungsText = rich({
  usage: 'bullswarm strategy rungs [--json] [--pool <name>]',
  purpose: 'List every rung: one pool\'s model plus its reasoning level for one effort tier, with the '
    + 'dated benchmark evidence for that exact pair and what this machine actually recorded for it.',
  args: [],
  options: [
    { flag: '--json', desc: 'machine-readable rows (the same rows strategy inventory --json carries under "rungs")' },
    { flag: '--pool <name>', desc: 'limit the table to one provider pool', default: 'every enabled pool' },
  ],
  safety: [
    'read-only: writes no state, spawns no model discovery, and downloads no meter or datapack',
    'a rung with no benchmark row prints "no evidence" and one with no matching attempt prints "no dispatches" — neither is ever estimated',
  ],
  examples: [
    { cmd: 'bullswarm strategy rungs' },
    { cmd: 'bullswarm strategy rungs --json --pool codex', note: 'one pool, machine-readable' },
  ],
  next: 'bullswarm strategy set-rung <pool> <tier> --model <model> --reasoning <level> to change one.',
});

const strategySetRungText = rich({
  usage: 'bullswarm strategy set-rung <pool> <tier> --model <model> [--reasoning <low|medium|high|xhigh|max|default>] [--force]',
  purpose: 'Set one rung — the model AND the reasoning level a pool uses for one effort tier — in a single '
    + 'atomic state save, so the two halves can never land separately.',
  args: [
    { name: '<pool>', desc: 'exact pool name from strategy rungs or strategy inventory' },
    { name: '<tier>', desc: 'effort tier: high, medium, or low' },
  ],
  options: [
    { flag: '--model <model>', desc: 'model to run on that tier; must appear in the pool\'s cached discovery unless --force' },
    { flag: '--reasoning <level>', desc: 'low, medium, high, xhigh, max, or default (append nothing and let the worker CLI decide)', default: 'leaves the configured level untouched' },
    { flag: '--force', desc: 'accept a model the cached discovery has not seen', default: 'off' },
  ],
  safety: [
    'changes what every later dispatch on that pool and tier sends to the worker CLI',
    'a rung is singular per pool and tier: the tier moves off whichever model held it, and that model keeps its other tiers',
    'a level the connector cannot express is clamped down to the strongest level it accepts, and the clamp is printed under "notes"',
    'never spawns model discovery — an unknown pool, tier, or model exits 2 instead',
  ],
  examples: [{ cmd: 'bullswarm strategy set-rung codex high --model gpt-5.6-sol --reasoning xhigh' }],
  next: 'bullswarm strategy rungs to read the rung back with its evidence and local record.',
});

const strategyRefreshText = rich({
  usage: 'bullswarm strategy refresh [--json] [--apply --yes] [--refresh-hours <n>]',
  purpose: 'Run live model discovery against every installed agent CLI and recompute '
    + 'high/medium/low tier recommendations from capability and cost.',
  args: [],
  options: [
    { flag: '--json', desc: 'print the full report as JSON', default: 'human-readable summary' },
    { flag: '--apply', desc: 'also approve and persist the resulting recommendations; requires --yes', default: 'off (discovery only)' },
    { flag: '--yes', desc: 'required alongside --apply — approves changing routing', default: 'none; --apply refuses without it' },
    { flag: '--refresh-hours <n>', desc: 'auto-refresh cadence to record when combined with --apply', default: '24' },
  ],
  safety: [
    'executes each installed agent CLI\'s discovery/list command and live meter/usage network calls',
    'writes the resulting report to state.json; with --apply --yes also writes tier assignments and enables the auto-refresh policy',
  ],
  examples: [{ cmd: 'bullswarm strategy refresh --json' }],
  next: 'bullswarm strategy show to review, or add --apply --yes to approve immediately.',
});

const strategyRecommendText = rich({
  usage: 'bullswarm strategy recommend [--json] [--apply --yes] [--refresh-hours <n>]',
  purpose: 'Alias for strategy refresh — identical options and behavior.',
  args: [],
  options: [
    { flag: '--json', desc: 'print the full report as JSON', default: 'human-readable summary' },
    { flag: '--apply', desc: 'also approve and persist the resulting recommendations; requires --yes', default: 'off (discovery only)' },
    { flag: '--yes', desc: 'required alongside --apply — approves changing routing', default: 'none; --apply refuses without it' },
    { flag: '--refresh-hours <n>', desc: 'auto-refresh cadence to record when combined with --apply', default: '24' },
  ],
  safety: ['identical to strategy refresh — see bullswarm strategy refresh --help'],
  examples: [{ cmd: 'bullswarm strategy recommend --apply --yes' }],
  next: 'bullswarm strategy show to review what was applied.',
});

const strategyApplyText = rich({
  usage: 'bullswarm strategy apply --yes [--refresh-hours <n>]',
  purpose: 'Approve and persist the most recently discovered recommendations (from the last '
    + 'refresh or show) without running discovery again.',
  args: [],
  options: [
    { flag: '--yes', desc: 'required — approves changing routing', default: 'none; the command refuses without it' },
    { flag: '--refresh-hours <n>', desc: 'auto-refresh cadence to record', default: '24' },
  ],
  safety: ['writes state.strategy.assignments and the auto-refresh policy'],
  examples: [{ cmd: 'bullswarm strategy apply --yes' }],
  next: 'bullswarm strategy show to confirm the applied assignments.',
});

const strategyShowText = rich({
  usage: 'bullswarm strategy show [--json]',
  purpose: 'Print the last captured strategy report (subscriptions, tier suggestions, '
    + 'exclusions); runs a first discovery pass automatically if none is cached yet.',
  args: [],
  options: [{ flag: '--json', desc: 'print the full report as JSON', default: 'human-readable summary' }],
  safety: ['does not change approved routing assignments; a cold cache runs model discovery and persists the resulting strategy report'],
  examples: [{ cmd: 'bullswarm strategy show --json' }],
  next: 'bullswarm strategy assign <tier> --pool <pool> --model <model> to override a suggestion.',
});

const strategyAssignText = rich({
  usage: 'bullswarm strategy assign <high|medium|low> --pool <pool> --model <model>',
  purpose: 'Force one specific pool/model for an effort tier, overriding auto-discovery for '
    + 'that tier only.',
  args: [{ name: '<high|medium|low>', desc: 'the effort tier to pin' }],
  options: [
    { flag: '--pool <pool>', desc: 'connector/pool name to assign', default: 'required; no default' },
    { flag: '--model <model>', desc: 'exact model identifier to assign', default: 'required; no default' },
  ],
  safety: ['writes state.strategy.assignments[tier] and invalidates the cached report'],
  examples: [{ cmd: 'bullswarm strategy assign high --pool claude-code --model claude-opus-5' }],
  next: 'bullswarm strategy clear-assignment high to release the pin later.',
});

const strategyClearAssignmentText = rich({
  usage: 'bullswarm strategy clear-assignment <high|medium|low>',
  purpose: 'Remove an explicit tier pin so that tier falls back to the latest discovery '
    + 'recommendation.',
  args: [{ name: '<high|medium|low>', desc: 'the effort tier to unpin' }],
  options: [],
  safety: ['writes state and invalidates the cached report'],
  examples: [{ cmd: 'bullswarm strategy clear-assignment high' }],
  next: 'bullswarm strategy refresh to see the recommendation that now applies.',
});

const strategyExcludeModelText = rich({
  usage: 'bullswarm strategy exclude-model <model>',
  purpose: 'Persistently prevent this exact model from orchestration and worker dispatch, even '
    + 'if it would otherwise be recommended or assigned.',
  args: [{ name: '<model>', desc: 'exact model identifier to block' }],
  options: [],
  safety: ['writes state.strategy.excludedModels and invalidates the cached report'],
  examples: [{ cmd: 'bullswarm strategy exclude-model gpt-5.4-mini' }],
  next: 'bullswarm strategy include-model <model> to reverse it.',
});

const strategyIncludeModelText = rich({
  usage: 'bullswarm strategy include-model <model>',
  purpose: 'Remove a previously persisted model exclusion.',
  args: [{ name: '<model>', desc: 'exact model identifier to unblock' }],
  options: [],
  safety: ['writes state.strategy.excludedModels and invalidates the cached report'],
  examples: [{ cmd: 'bullswarm strategy include-model gpt-5.4-mini' }],
  next: 'bullswarm strategy show to confirm.',
});

const strategySetSubscriptionText = rich({
  usage: 'bullswarm strategy set-subscription <pool> [--plan <name>] [--monthly-usd <n|unknown>] [--included-usd <n|unknown>] [--quota-window <weekly|monthly|unknown>] [--resets-at <iso|unknown>]',
  purpose: "Record known subscription pricing for a pool so refresh's value-multiple math "
    + '(included value vs. monthly cost) is accurate, choose the quota window '
    + 'routing paces this pool by, and declare when that window ends for a '
    + 'provider that reports usage but no reset date.',
  args: [{ name: '<pool>', desc: 'connector/pool name to record economics for' }],
  options: [
    { flag: '--plan <name>', desc: 'plan label to record', default: 'unchanged' },
    { flag: '--monthly-usd <n|unknown>', desc: 'monthly subscription price', default: 'unchanged' },
    { flag: '--included-usd <n|unknown>', desc: 'estimated included usage value', default: 'unchanged' },
    { flag: '--quota-window <weekly|monthly>', desc: 'the subscription window that PACES routing for this pool (used% vs elapsed% of it); unknown clears it back to the connector default', default: 'unchanged' },
    { flag: '--resets-at <iso|unknown>', desc: 'the date-time this pool\'s quota window next ends, used ONLY when the provider reports usage but no reset (for example a reseller wallet whose usage endpoint reports no reset date); pacing rolls it forward one window at a time once it passes and bullswarm pools labels the row declared-reset. A provider-reported reset always wins; unknown clears it', default: 'unchanged' },
  ],
  safety: ['writes state.strategy.subscriptions[pool] and invalidates the cached report'],
  examples: [
    { cmd: 'bullswarm strategy set-subscription claude --plan max --monthly-usd 200 --included-usd 1000' },
    { cmd: 'bullswarm strategy set-subscription opencode2 --resets-at 2026-09-17T01:46:01Z', note: 'a wallet whose usage is reported but whose refill date is not' },
  ],
  next: 'bullswarm strategy refresh to recompute recommendations with the new economics.',
});

const strategyAutoText = rich({
  usage: 'bullswarm strategy auto <status|off> [--yes]',
  purpose: 'Inspect or disable the policy that re-applies discovery recommendations '
    + 'automatically on a cadence, set by a prior apply or refresh --apply.',
  argsTitle: 'Commands',
  args: [
    { name: 'status', desc: 'show whether the policy is enabled and its cadence' },
    { name: 'off', desc: 'disable the policy; requires --yes' },
  ],
  options: [{ flag: '--yes', desc: 'required for off — approves changing routing policy', default: 'not needed for status' }],
  safety: ['status is read-only; off writes state.strategy.policy'],
  examples: [{ cmd: 'bullswarm strategy auto status' }],
  next: 'bullswarm strategy auto off --yes to disable, or bullswarm strategy apply --yes to (re)enable via a fresh approval.',
});

const strategyAutoStatusText = rich({
  usage: 'bullswarm strategy auto status',
  purpose: 'Show whether auto-apply-on-refresh is enabled and its refresh cadence.',
  args: [],
  options: [],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm strategy auto status' }],
  next: 'bullswarm strategy auto off --yes to disable it.',
});

const strategyAutoOffText = rich({
  usage: 'bullswarm strategy auto off --yes',
  purpose: 'Disable the auto-apply-on-refresh policy; the last-applied tier assignments are '
    + 'kept as-is.',
  args: [],
  options: [{ flag: '--yes', desc: 'required — approves changing routing policy', default: 'none; the command refuses without it' }],
  safety: ['writes state.strategy.policy'],
  examples: [{ cmd: 'bullswarm strategy auto off --yes' }],
  next: 'bullswarm strategy apply --yes to re-enable later.',
});

// --- workflow -------------------------------------------------------------------
// A few leaves below document an option (`--json`) that the real parser accepts
// without error but the command body never reads, so it has no effect — the
// underlying implementation already always prints JSON. Rather than hide the
// flag (which would make `--json` look like a parse error, and it isn't), each
// such leaf says so explicitly: "accepted ... but has no effect". Confirmed by
// reading src/workflow/cli.js (wfCapabilities, wfEvents, wfAction) — none of
// them branch on opts.json.

const workflowText = rich({
  usage: 'bullswarm workflow [<command>] [options]',
  purpose: 'Plan, execute, observe, and audit durable multi-agent workflows with the '
    + 'single V2 action/evidence engine. With no command on a TTY, opens the dashboard '
    + '(Home, Run, Step, Usage, Help) — the same screen bare `bullswarm` opens on a '
    + 'configured machine.',
  argsTitle: 'Commands',
  args: [
    { name: 'goal "<goal>"', desc: 'run a V2 autonomous goal from your program (--program), a kernel scout that finishes with its report (--scout), or an explicitly dispatched Workflow Planner (--orchestrator); a run never waits, it finishes and hands back what is left' },
    { name: 'plan ...', desc: 'you are the Workflow Planner: read the planning contract, validate a program, export and revise a live or finished run\'s plan at any time, and answer a run an older version left waiting' },
    { name: 'pause <runId>', desc: 'stop starting new steps (--now also stops running ones); resume continues' },
    { name: 'cancel <runId>', desc: 'stop a run cooperatively; a run stopped by pause, or left waiting by an older version, is finalized immediately' },
    { name: 'resume <runId>', desc: 'lift a pause, continue an interrupted run, or retry a finished run\'s retryable steps, with its durable planner mode and routing' },
    { name: 'capabilities', desc: 'show pools, lanes, models, meters, and routing constraints' },
    { name: 'runs ...', desc: 'search ongoing and historical workflow instances' },
    { name: 'tui [runId]', desc: 'open the dashboard (Home, Run, Step, Usage, Help) or one run timeline; bare `bullswarm` opens the same dashboard once configured, and bare workflow is equivalent on a TTY' },
    { name: 'watch <runId>', desc: 'follow low-noise progress until terminal' },
    { name: 'events <runId>', desc: 'replay durable events after a sequence cursor' },
    { name: 'steer <runId>', desc: 'queue guidance for the next planner checkpoint' },
    { name: 'action show ...', desc: 'inspect one action and all of its attempts' },
  ],
  options: [],
  safety: [
    'bare bullswarm workflow opens a read-only active/recent run dashboard only when stdin and '
      + 'stdout are TTYs; non-interactive callers receive this help text instead',
    'goal dispatches real coding-agent CLI processes and writes durable state under '
      + '~/.bullswarm/workflows/<runId>/',
    'capabilities, tui, watch, events, and action show are read-only; cancel, steer, plan submit, '
      + 'and runs delete are the exceptions — see their own --help',
    'legacy authored-graph runs are read-only; driving commands fail closed before dispatch',
    'plan contract, plan validate, plan show, and plan export are read-only; plan submit and plan revise write the accepted program into the run and relaunch its kernel when none is running',
    'pause writes a pause request the kernel honors within about a second; resume lifts it',
  ],
  examples: [
    { cmd: 'bullswarm workflow', note: 'open the human workflow home: runs, live preview, timeline, agents, and activity' },
    { cmd: 'bullswarm workflow goal "Audit this repository for TODOs" --cwd . --program plan.json', note: 'autonomous goal, launched independently; goal needs --program, --scout, or --orchestrator or it exits 2' },
    { cmd: 'bullswarm workflow goal "1. Fix the parser. 2. Verify it." --cwd . --program plan.json', note: 'caller-planner goal: you author the program, the kernel routes, verifies, and completes' },
    { cmd: 'bullswarm workflow runs --all --since 7d', note: 'list every run started in the last week' },
  ],
  next: "bullswarm workflow <command> --help for that command's full arguments, options, and defaults.",
});

const workflowGoalText = rich({
  usage: 'bullswarm workflow goal "<goal>" (--program <file.json> [--scout] | --scout | --orchestrator auto|<pool>) '
    + '[--cwd <dir>] [--watch|--foreground] [--json] [planning options]  ·  bullswarm workflow goal --resume <shortId|runId>',
  purpose: 'Run an autonomous V2 goal end to end. You are the Workflow Planner: pass the program you '
    + 'authored (--program, from `workflow plan contract`) and the kernel validates it against the exact '
    + 'requirements, schedules the dependency graph in a shared workspace, and returns every action result. '
    + 'File territories guide coordination; exact-file enforcement and worktree copying require --isolation. '
    + 'Completion means all actions succeeded; verified separately reports requirement evidence. There are no automatic gap rounds. '
    + 'Without a program the command refuses (exit 2, nothing launched) and prints '
    + 'the next commands; --scout alone has the kernel survey the repository and finish with the report, '
    + 'which you plan from and add with plan revise; --orchestrator explicitly dispatches a Workflow Planner '
    + 'agent instead of planning yourself. A run never waits for its caller: when nothing more can run on its '
    + 'own it finishes, and its result hands back every unfinished step, open requirement, and unread '
    + 'steering with the commands to continue, retry, take over, or restart. '
    + 'Launches independently by default so the caller is not blocked.',
  args: [
    { name: '"<goal>"', desc: 'the goal text, as one argument; not used (and not required) with --resume or the internal --request relaunch mode' },
  ],
  options: [
    { flag: '--cwd <dir>', desc: 'working directory the goal executes in', default: 'current directory' },
    { flag: '--isolation', desc: 'opt into per-worker worktrees and strict exact-file ownership checks; saved runs retain their original workspace policy on resume', default: 'off (shared workspace, advisory territories)' },
    { flag: '--watch', desc: 'immediately follow low-noise progress until terminal; only valid for a new human-readable independent launch — cannot combine with --detach, --foreground, --json, --resume, or --request', default: 'off' },
    { flag: '--foreground', desc: 'keep execution attached to this terminal instead of detaching', default: 'off (detaches into a background process)' },
    { flag: '--json', desc: 'print the launch/report document as JSON', default: 'human-readable launch instructions' },
    { flag: '--program <file.json>', desc: 'your program: a bullswarm.workflow.planner-response.v2 envelope or a bare bullswarm.workflow.program.v2 document; validated against the exact requirement ledger before anything launches (exit 2 with the issues and nothing launched when invalid), then executed with zero planner or scout dispatches', default: 'required unless --scout or --orchestrator is given' },
    { flag: '--summary <text>', desc: 'one-line summary recorded for a bare --program document', default: 'derived from the action purposes' },
    { flag: '--scout', desc: 'with --program: run the kernel scout first and hand its units to you as advisory context; alone: survey the repository, then finish partial with the scout report and the plan revise command that adds your program', default: 'off' },
    { flag: '--orchestrator <auto|pool>', desc: 'dispatch a Workflow Planner agent at every planning boundary instead of planning yourself: auto lets the kernel route it, a pool name prefers that pool and falls back when it is quota-gated or unavailable', default: 'off (you are the planner)' },
    { flag: '--orchestrator-model <model|auto>', desc: 'with --orchestrator: pin the exact model used by the dispatched planner; only pools that can guarantee it remain eligible', default: 'auto (effort-tier strategy or connector default)' },
    { flag: '--orchestrator-strict', desc: 'with --orchestrator <pool>: require exactly that pool for controlled provider QA; fails if it is unavailable rather than silently substituting', default: 'off' },
    { flag: '--strict-orchestrator <pool>', desc: 'deprecated alias for --orchestrator <pool> --orchestrator-strict', default: 'off' },
    { flag: '--suggested-plan <text>', desc: 'with --orchestrator: persist a caller-imagined conceptual execution shape for the dispatched planner to consider; when you are the planner, the plan is the program', default: 'none' },
    { flag: '--worker-pool <pool|auto>', desc: 'pin every non-planner dispatch, including scout, work actions, and evidence actions, to one pool', default: 'auto (normal routing)' },
    { flag: '--worker-model <model|auto>', desc: 'pin the exact model for every non-planner dispatch; only pools that can guarantee it remain eligible', default: 'auto (effort-tier strategy or connector default)' },
    { flag: '--worker-reasoning <level>', desc: 'run-wide reasoning depth for every non-planner dispatch: low|medium|high|xhigh|max, or default to pass nothing and let each worker CLI decide; outranks the configured strategy level, and a per-action `reasoning` field outranks this; clamped to the nearest level the picked connector supports', default: 'the configured strategy level, else the connector default' },
    { flag: '--planner-reasoning <level>', desc: 'with --orchestrator: the same run-wide reasoning depth for every dispatched Workflow Planner turn', default: 'the configured strategy level, else the connector default' },
    { flag: '--max-agents <n>', desc: 'soft planning target for total scout, planner, work, evidence, and correction dispatches; essential work may exceed it', default: '30' },
    { flag: '--max-expansion-rounds <n>', desc: 'legacy planning target retained for compatibility; new programs do not generate gap rounds', default: '2' },
    { flag: '--max-actions <n>', desc: 'soft planning target for total actions across planner revisions; essential actions may exceed it', default: '100' },
    { flag: '--no-scout', desc: 'with --orchestrator: skip the read-only repository reconnaissance before the dispatched planner creates its first program', default: 'the scout runs first for a dispatched planner' },
    { flag: '--concurrency <n>', desc: 'max parallel dispatches; dependency-ready file-disjoint actions run concurrently up to this cap', default: '4' },
    { flag: '--retry-attempts <0..3>', desc: 'bounded retries for mechanical failures only; semantic evidence never auto-repairs', default: '1' },
    { flag: '--resume <shortId|runId>', desc: 'resume a V2 autonomous run; old autonomous runs fail closed before dispatch; mutually exclusive with new goal text', default: 'starts a new goal' },
    { flag: '--detach', desc: 'rarely needed — explicitly requests the default independent-launch behavior; cannot combine with --watch', default: 'the default launch already detaches' },
  ],
  safety: [
    'default launch writes ~/.bullswarm/goals/<runId>/ (request.json, launcher.json, stdout.log, '
      + 'stderr.log) and spawns a detached background '
      + '`bullswarm workflow goal --request ... --run-id ...` child process that keeps running '
      + 'after this command returns',
    'writes durable workflow state under ~/.bullswarm/workflows/<runId>/ throughout execution '
      + '(state.json, events, attempts)',
    'dispatches real coding-agent CLI processes per generic action, the same as bullswarm run',
    'the goal, action graph, routing lanes, and any declared structured evidence are validated; shared workspace file territories are advisory',
    'workers keep their edits even when their action fails; failed dependencies skip downstream actions and independent branches finish',
    'saved V2 runs keep their original completion and isolation policy when resumed',
    'there is no V1 autonomous migration or fallback; explicitly resuming an old run dispatches nothing',
  ],
  examples: [
    { cmd: 'bullswarm workflow goal "1. Fix src/parser.js. 2. Update docs." --cwd . --program plan.json --watch', note: 'you are the planner: author plan.json from `workflow plan contract`, then the kernel routes, owns, verifies, and completes' },
    { cmd: 'bullswarm workflow goal "1. Fix src/parser.js. 2. Update docs." --cwd . --scout', note: 'kernel surveys and finishes with the report; add your program with plan revise' },
    { cmd: 'bullswarm workflow goal "Audit this repo for TODOs and file a one-page summary" --cwd . --orchestrator auto', note: 'dispatch a Workflow Planner agent instead of planning yourself' },
    { cmd: 'bullswarm workflow goal "Implement and verify the change" --cwd . --orchestrator codex --orchestrator-strict --orchestrator-model gpt-5.6-sol --worker-pool relay --worker-model a/gpt-5.6-luna', note: 'controlled Sol-planner/Luna-worker run' },
    { cmd: 'bullswarm workflow goal "1. Fix src/parser.js. 2. Update docs." --cwd . --program plan.json --worker-reasoning high --json', note: 'every worker thinks at high unless an action sets its own reasoning field' },
  ],
  next: 'bullswarm workflow watch <shortId> --next to follow progress, bullswarm workflow runs result <shortId> --json --summary once it finishes, or bare bullswarm workflow for the interactive workflow home.',
});

// --- workflow plan ---------------------------------------------------------
// The caller-as-planner surface. A capable calling agent (Claude Code, Codex,
// any frontier model with the repository in context) authors the V2 program
// directly instead of paying for a dispatched scout and planner. The kernel
// keeps everything it owns: validation, routing, ownership, evidence, ledger,
// completion, and the stable result envelope.

const workflowPlanText = rich({
  usage: 'bullswarm workflow plan <contract|validate|show|submit|export|revise> [options]',
  purpose: 'You are the Workflow Planner. contract prints the exact planning contract (requirement IDs, '
    + 'rules, program schema, example, and the run-wide reasoning levels your optional per-action '
    + '`reasoning` field would override) for a goal before any run exists; validate checks a program against '
    + 'that contract without launching; export and revise change the plan of a live or finished run. '
    + 'show and submit answer only a run an older version left waiting for its caller: show prints its '
    + 'planner request, submit validates the next program (or an exhausted decision) against that exact run '
    + 'state and relaunches the kernel. Launch the initial program with workflow goal --program.',
  argsTitle: 'Commands',
  args: [
    { name: 'contract "<goal>"', desc: 'print the planning contract for a goal: requirements, constraints, rules, program schema (including the optional per-action `reasoning` level), example, and the launch line' },
    { name: 'validate "<goal>" --program <file>', desc: 'dry-run a program against the contract: exit 0 with the accepted actions, or exit 2 with the validator issues; nothing is launched' },
    { name: 'show <runId>', desc: 'print the pending planner request of a run an older version left waiting' },
    { name: 'submit <runId>', desc: 'answer a run an older version left waiting with the next program (or --exhausted at a gaps boundary) and relaunch it' },
    { name: 'export <runId>', desc: 'write the live plan of a running, paused, or finished run as an editable revision document' },
    { name: 'revise <runId> --program <file>', desc: 'replace the live plan at any time: add, amend, remove, or rerun steps; running agents whose steps change are stopped and restarted' },
  ],
  options: [],
  safety: [
    'contract, validate, and show never change run state (show may rewrite the request document to list steering queued since the pause)',
    'submit validates before writing; a rejected program leaves the run state unchanged and exits 2',
    'submit relaunches the waiting kernel as a detached process by default (same as workflow goal)',
  ],
  examples: [
    { cmd: 'bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json' },
    { cmd: 'bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json' },
    { cmd: 'bullswarm workflow plan export ab12cd --out plan.json' },
    { cmd: 'bullswarm workflow plan revise ab12cd --program plan.json --json' },
  ],
  next: 'bullswarm workflow goal "<goal>" --program <file.json> to launch with your initial program; bullswarm workflow watch <runId> --next after a revise.',
});

const workflowPlanValidateText = rich({
  usage: 'bullswarm workflow plan validate "<goal>" --program <file.json> [--cwd <dir>] [--summary <text>] [--json]',
  purpose: 'Check a program you authored against the exact contract a launch would enforce, without '
    + 'creating a run: the same requirement ledger, the same validator, and the same preview state as '
    + 'workflow goal --program. Exit 0 prints the accepted actions and the launch line; exit 2 prints '
    + 'every validator issue so you can fix the file and re-run.',
  args: [{ name: '"<goal>"', desc: 'the goal text exactly as it will be passed to workflow goal' }],
  options: [
    { flag: '--program <file.json>', desc: 'planner response envelope or bare bullswarm.workflow.program.v2 document', default: 'required' },
    { flag: '--cwd <dir>', desc: 'working directory the goal will execute in (must exist)', default: 'current directory' },
    { flag: '--summary <text>', desc: 'one-line summary recorded for a bare program document', default: 'derived from the action purposes' },
    { flag: '--json', desc: 'print the acceptance document ({action: "plan-valid", requirements, program, next}) or the refusal ({error: "program-invalid", issues, next}) as JSON', default: 'human summary' },
    { flag: '--isolation', desc: 'validate against strict per-worker worktree isolation', default: 'off (shared workspace)' },
    { flag: '--scout', desc: 'validate against a run that scouts before your program', default: 'off for a caller-authored program' },
    { flag: '--worker-pool <pool|auto>', desc: 'pin the worker pool the preview routes with', default: 'auto (routing decides per action)' },
    { flag: '--worker-model <model|auto>', desc: 'pin the worker model the preview routes with', default: 'auto' },
    { flag: '--worker-reasoning <level>', desc: 'run-wide worker thinking level for the preview', default: 'the strategy setting for the action effort tier' },
    { flag: '--max-agents <n>', desc: 'advisory dispatch target for the previewed run', default: '30' },
    { flag: '--max-actions <n>', desc: 'advisory action target for the previewed run', default: '100' },
    { flag: '--max-expansion-rounds <n>', desc: 'advisory gap-round target for the previewed run', default: '2' },
    { flag: '--concurrency <n>', desc: 'execution concurrency for the previewed run', default: '4' },
    { flag: '--retry-attempts <0..3>', desc: 'mechanical retry allowance for the previewed run', default: '1' },
  ],
  safety: ['read-only — nothing is launched, dispatched, or written; the exit code is the verdict (0 valid, 2 invalid, 1 bad cwd)'],
  examples: [{ cmd: 'bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json' }],
  next: 'bullswarm workflow goal "<same goal>" --cwd <dir> --program plan.json once it validates.',
});

const workflowCancelText = rich({
  usage: 'bullswarm workflow cancel <runId> [--json]',
  purpose: 'Stop a run. A running kernel is asked to stop cooperatively and does so at its next safe '
    + 'checkpoint (active workers are never killed mid-write). A run with no kernel alive — stopped by '
    + 'workflow pause, or left waiting for its caller by an older version — is finalized here and now: the cancelled result '
    + 'envelope is written, the pause record is cleared, and no program can be submitted afterwards. A plan '
    + 'revision can still reopen a cancelled run.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId' }],
  options: [{ flag: '--json', desc: 'print {action: "cancel", finalized, status, result|next} as JSON', default: 'one human line' }],
  safety: [
    'writes the cancellation request into state.json and an event; for a run with no live kernel it also writes result.json (status cancelled) without dispatching anything',
    'idempotent: an already-terminal run reports alreadyFinished and exits 0',
  ],
  examples: [{ cmd: 'bullswarm workflow cancel ab12cd --json' }],
  next: 'bullswarm workflow watch <runId> for a running kernel, or bullswarm workflow runs result <runId> --json once finalized.',
});

const workflowResumeText = rich({
  usage: 'bullswarm workflow resume <runId> [--foreground|--watch] [--json]',
  purpose: 'Resume a V2 run with its durable planner mode and routing: a run stopped by workflow pause '
    + 'continues (a pause still draining is withdrawn and its live kernel carries on), an interrupted kernel '
    + 'continues where its state says, and a run with a pending cancellation records the cancelled result. '
    + 'On a finished run (completed, partial, or cancelled) resume is a retry: it reopens the run for its '
    + 'pending and cancelled steps, failed steps whose failure kind a retry fixes (provider, quota, auth, '
    + 'process, unavailable, interrupted, runtime, schema, stalled), and the steps blocked behind them; the '
    + 'previous result moves to result-before-resume-<n>.json. With nothing retryable it prints nothing to '
    + 'retry, starts nothing, and exits 1. A run an older version left waiting for its caller finishes and '
    + 'hands back what is left instead of waiting again. '
    + 'Detaches by default like workflow goal; this is the verb form of workflow goal --resume.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId of a V2 run' }],
  options: [
    { flag: '--foreground', desc: 'run the kernel attached to this terminal; combines with --json to print the result or pause document', default: 'off (detaches)' },
    { flag: '--watch', desc: 'detach, then follow human-readable progress until terminal or paused; cannot combine with --foreground or --json', default: 'off' },
    { flag: '--json', desc: 'print the relaunch document (or, with --foreground, the final result or pause document) as JSON', default: 'human launch instructions' },
  ],
  safety: [
    'planner mode, routing pins, and settings are durable; --program, --orchestrator, --scout, and --suggested-plan are rejected here (use workflow plan revise to change the plan)',
    'dispatches real coding-agent CLI processes for any unfinished actions, the same as workflow goal',
    'a failed step whose failure is about the work itself (a check that failed it, a semantic failure) is not rerun; add a fix step or name it in plan revise --rerun',
  ],
  examples: [
    { cmd: 'bullswarm workflow resume ab12cd --watch' },
    { cmd: 'bullswarm workflow resume ab12cd --json', note: 'retry a partial run whose step failed on a paused pool, once the handback\'s retryAfter time has passed' },
  ],
  next: 'bullswarm workflow watch <runId>, then bullswarm workflow runs result <runId> --json when terminal.',
});

const workflowPlanContractText = rich({
  usage: 'bullswarm workflow plan contract "<goal>" [--cwd <dir>] [--json]',
  purpose: 'Print everything a caller planner needs to author a valid initial program for a goal: '
    + 'the requirement IDs the kernel will derive from the goal text (numbered clauses become '
    + 'requirement-1..n), read-only constraints, the planning rules, the generic action fields, the '
    + 'validation the kernel enforces, the response envelope, and one worked example.',
  args: [{ name: '"<goal>"', desc: 'the goal text exactly as it will be passed to workflow goal; numbering clauses 1. 2. 3. yields one requirement per clause' }],
  options: [
    { flag: '--cwd <dir>', desc: 'working directory the goal will execute in', default: 'current directory' },
    { flag: '--isolation', desc: 'describe strict per-worker worktree isolation and retain the flag in launch guidance', default: 'off (shared workspace)' },
    { flag: '--json', desc: 'accepted for consistency; the contract is always printed as JSON', default: 'JSON' },
    { flag: '--max-agents <n>', desc: 'advisory dispatch target recorded in the contract settings', default: '30' },
    { flag: '--max-actions <n>', desc: 'advisory action target recorded in the contract settings', default: '100' },
    { flag: '--max-expansion-rounds <n>', desc: 'advisory gap-round target recorded in the contract settings', default: '2' },
    { flag: '--concurrency <n>', desc: 'execution concurrency recorded in the contract settings', default: '4' },
    { flag: '--retry-attempts <0..3>', desc: 'mechanical retry allowance recorded in the contract settings', default: '1' },
    { flag: '--scout', desc: 'describe a kernel scout ahead of your program and retain the flag in launch guidance', default: 'off for a caller-authored program' },
    { flag: '--worker-pool <pool|auto>', desc: 'pin the worker pool the contract echoes back', default: 'auto (routing decides per action)' },
    { flag: '--worker-model <model|auto>', desc: 'pin the worker model the contract echoes back', default: 'auto' },
    { flag: '--worker-reasoning <level>', desc: 'run-wide worker thinking level the contract echoes back', default: 'the strategy setting for the action effort tier' },
  ],
  safety: [
    'read-only — derives the contract from the goal text and local state; nothing is launched, dispatched, or written',
    'rejects launch-only and dispatched-planner flags (--program, --planner dispatched, --orchestrator*) so the contract cannot silently describe a different run',
  ],
  examples: [{ cmd: 'bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json' }],
  next: 'author plan.json, then bullswarm workflow goal "<same goal>" --cwd <dir> --program plan.json',
});

const workflowPlanShowText = rich({
  usage: 'bullswarm workflow plan show <runId> [--json]',
  purpose: 'For a run an older version left waiting for its caller (current versions never wait), print the durable planner request it left for you: the '
    + 'boundary (initial, gaps, or steering), the planner context (intent, known actions and their status, '
    + 'consolidated gaps with evidence and concerns, scout report, pending steering), the rules, and the exact submit '
    + 'command. Exits 1 when the run is not waiting for a submission (including once it is terminal).',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId' }],
  options: [{ flag: '--json', desc: 'print the full request document', default: 'compact human summary' }],
  safety: [
    'never changes run state; when steering was queued after the pause it rewrites the request document so it lists every pending instruction (requestRefreshed: true)',
    'after a cancellation request it prints the finalize command instead of a submit command',
  ],
  examples: [{ cmd: 'bullswarm workflow plan show ab12cd --json' }],
  next: 'bullswarm workflow plan submit <runId> --program <file.json> (or, at a gaps boundary, --exhausted --reason <text>)',
});

const workflowPlanSubmitText = rich({
  usage: 'bullswarm workflow plan submit <runId> (--program <file.json> | --exhausted --reason <text>) [--summary <text>] [--foreground [--json] | --watch | --json]',
  purpose: 'Submit your planner response to a run an older version left waiting for its caller (current '
    + 'versions never wait; change a current run with plan revise). The program is validated against '
    + 'the exact durable state and boundary the kernel recorded (same validator as a dispatched planner), '
    + 'accepted as the next program revision, and the kernel is relaunched. --exhausted records that no '
    + 'useful bounded action remains, so the kernel finalizes a partial result with its gaps.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId of a run whose plan show reports awaiting' }],
  options: [
    { flag: '--program <file.json>', desc: 'planner response envelope or bare program document with the new actions only (known actions are already in the run)', default: 'none' },
    { flag: '--exhausted', desc: 'declare that no further useful bounded action exists; valid only at a gaps boundary (the initial boundary needs a program, steering needs an update)', default: 'off' },
    { flag: '--reason <text>', desc: 'required with --exhausted: the concrete reason', default: 'none' },
    { flag: '--summary <text>', desc: 'one-line summary recorded for a bare program document', default: 'derived from the action purposes' },
    { flag: '--foreground', desc: 'resume the kernel attached to this terminal instead of detaching; combines with --json', default: 'off (detaches)' },
    { flag: '--watch', desc: 'detach, then follow human-readable low-noise progress until the run is terminal or paused; cannot combine with --foreground or --json', default: 'off' },
    { flag: '--json', desc: 'print the acceptance and relaunch document (or, with --foreground, the final result) as JSON', default: 'human summary plus operating commands' },
  ],
  safety: [
    'validates before writing: a rejected program exits 2 and leaves the run untouched; a run with a pending cancellation refuses every submission (resume it once to finalize)',
    'steering listed in the request (plan show) is marked delivered by the submission; steering queued after that stays pending; if nothing acts on it the run finishes and lists it as steering not acted on',
    'writes the accepted candidate and a planner.finished event into the run directory, then spawns `bullswarm workflow goal --resume <runId>` detached (or runs it in the foreground)',
    'dispatches real coding-agent CLI processes for the new actions, the same as workflow goal',
  ],
  examples: [
    { cmd: 'bullswarm workflow plan submit ab12cd --program plan-2.json --watch' },
    { cmd: 'bullswarm workflow plan submit ab12cd --exhausted --reason "the remaining gap needs a credential the workspace does not have"' },
  ],
  next: 'bullswarm workflow watch <runId>, then bullswarm workflow runs result <runId> --json when terminal.',
});

const workflowPlanExportText = rich({
  usage: 'bullswarm workflow plan export <runId> [--out <file.json>] [--json]',
  purpose: 'Write the live plan of a program-mode run as an editable revision document: every action still '
    + 'in the plan exactly as the kernel stores it, the program revision it was exported at (baseRevision), '
    + 'and the ids of pending steering you have now been shown. Edit it and pass it to plan revise. Works at '
    + 'any time: while agents run, while paused, or after the run finished.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId of a program-mode run' }],
  options: [
    { flag: '--out <file.json>', desc: 'write the revision document to this file and print a status summary', default: 'print the revision document itself on stdout' },
    { flag: '--json', desc: 'print {programRevision, status, actions[] with each status, pendingSteering, document|out, next}', default: 'the document (no --out) or a human summary (--out)' },
  ],
  safety: ['read-only for the run; --out writes only the named file'],
  examples: [
    { cmd: 'bullswarm workflow plan export ab12cd --out plan.json' },
    { cmd: 'bullswarm workflow plan export ab12cd --json' },
  ],
  next: 'edit the file, then bullswarm workflow plan revise <runId> --program plan.json',
});

const workflowPlanReviseText = rich({
  usage: 'bullswarm workflow plan revise <runId> --program <file.json> [--rerun <id,...>] [--summary <text>] [--base-revision <n>] [--wait <seconds>] [--json]',
  purpose: 'Replace the plan of a program-mode run with the complete program you want now, at any time. The '
    + 'kernel compares it with the live plan by action id: a new id is added; an unchanged action keeps its '
    + 'result or keeps running; a changed action is stopped if running and starts over; an action missing from '
    + 'the program is removed (stopped if running, never run again, no longer counted); ids in --rerun discard '
    + 'their finished result and run again; and every step depending on a changed or rerun step runs again too. '
    + 'A finished run is reopened and continues with the new plan; a paused run stays paused until resume.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId of a program-mode run' }],
  options: [
    { flag: '--program <file.json>', desc: 'the whole desired program: a document from plan export, a bare program, or a planner response envelope', default: 'required' },
    { flag: '--rerun <id,...>', desc: 'comma-separated action ids whose finished results are discarded so they run again (merged with the document\'s rerun list)', default: 'none' },
    { flag: '--summary <text>', desc: 'why the plan changed, recorded on the revision and shown by watch', default: 'the document summary, else "Plan revision <n>"' },
    { flag: '--base-revision <n>', desc: 'refuse the revision if the run is no longer at program revision n (plan export records it for you)', default: 'the document\'s baseRevision; none for a bare program' },
    { flag: '--wait <seconds>', desc: 'how long to wait for a running kernel to apply or reject it; 0 returns once it is queued', default: '120' },
    { flag: '--json', desc: 'print {status: applied|rejected|queued, programRevision, changes, appliedBy, reopened, relaunch}', default: 'human summary of the changes' },
  ],
  safety: [
    'checked against the run before anything is written: an invalid program, an unknown rerun id, a stale base revision, or a revision that changes nothing exits 2 and leaves the run untouched',
    'a running agent whose step is amended, removed, rerun, or downstream of such a step is stopped; files it already changed stay in the workspace, so plan a step that repairs or reverts them when that matters',
    'with no live kernel (paused, left waiting by an older version, interrupted, or finished) the revision is applied here and the kernel is relaunched detached, except for a paused run',
  ],
  examples: [
    { cmd: 'bullswarm workflow plan revise ab12cd --program plan.json' },
    { cmd: 'bullswarm workflow plan revise ab12cd --program plan.json --rerun write-docs --summary "Docs must cover the new flag"' },
  ],
  next: 'bullswarm workflow watch <runId> --next; it prints a "plan revised" line when the kernel applies it.',
});

const workflowPauseText = rich({
  usage: 'bullswarm workflow pause <runId> [--now] [--json]',
  purpose: 'Pause a run: the kernel starts no new step. By default running agents finish first and their results '
    + 'are kept; with --now they are stopped and those steps run again after resume. Once nothing is running the '
    + 'kernel records the pause and exits. The plan can be exported and revised while paused; bullswarm workflow '
    + 'resume continues.',
  args: [{ name: '<runId>', desc: 'shortId (6 chars) or full wf-... runId' }],
  options: [
    { flag: '--now', desc: 'stop running agents instead of letting them finish, and wait up to 60s for the pause to take effect', default: 'off (running agents finish)' },
    { flag: '--json', desc: 'print {status: paused|pausing, mode, appliedBy, next}', default: 'one human line' },
  ],
  safety: [
    'writes pause.json in the run directory; a run with no live kernel is marked paused immediately',
    '--now stops agents mid-step; files they already changed stay in the workspace',
    'refuses a terminal run',
  ],
  examples: [
    { cmd: 'bullswarm workflow pause ab12cd' },
    { cmd: 'bullswarm workflow pause ab12cd --now --json' },
  ],
  next: 'bullswarm workflow plan export <runId> --out plan.json to revise, then bullswarm workflow resume <runId>.',
});

const workflowCapabilitiesText = rich({
  usage: 'bullswarm workflow capabilities',
  purpose: 'Report the workflow engine, current routing policy, and live '
    + 'pool/model/meter state.',
  args: [],
  options: [{ flag: '--json', desc: 'accepted so agents can pass it uniformly; it selects nothing, because this command has no human renderer', default: 'output is always JSON, with or without the flag' }],
  safety: ['read-only — performs live pool discovery to populate pool/meter state; nothing is written'],
  examples: [{ cmd: 'bullswarm workflow capabilities' }],
  next: 'bullswarm workflow goal "<goal>" to plan and execute a workflow, or bullswarm strategy show to review model tier assignments.',
});


const workflowTuiText = rich({
  usage: 'bullswarm workflow tui [<runId>] [--json] [--all] [--show <runId>] [--cancel <runId>] [--overview [--width <cols>] [--height <rows>]]',
  purpose: 'Open the dashboard — the same screen bare `bullswarm` opens on a configured terminal, here as the '
    + 'explicit command. A sticky header names the selected run and a sticky bottom nav carries every ongoing run '
    + '([ 1.<run> ], the current one marked ●) plus [ usage ], [ help ] and [ quit ], each button\'s key '
    + 'underlined inside its label. The pages are Home (ongoing '
    + 'runs, the compact pool rows, the agent-integration status with an [install] button, and the commands that '
    + 'operate the product), Run (the selected run\'s timeline with its Live and Next overview), Step (one agent\'s '
    + 'panel, with [back]), Usage (every meter window per enabled pool, the rungs with their local record, the '
    + 'read-only note, and [edit], which hands the terminal to bullswarm setup) and Help. Keys: q quit, ? help, '
    + 'u usage, e edit, i install, l and p switch the Usage grouping, the arrows/PgUp/PgDn/Enter move and open, '
    + 'Esc goes back; the mouse clicks any button, tab, run or step and the wheel scrolls. A non-interactive '
    + 'caller gets a static/JSON snapshot instead.',
  args: [{ name: '[<runId>]', desc: 'shortId or runId to open directly in detail view; omit to see the run picker' }],
  options: [
    { flag: '--json', desc: "print a JSON snapshot instead of opening the interactive browser (list of ongoing runs, or one run's state/report/events when a runId is given)", default: "opens the interactive browser on a TTY; without a TTY, a given runId instead prints one static text detail tree" },
    { flag: '--all', desc: 'print the JSON run list including historical (finished) runs; implies --json and cannot be combined with a runId', default: 'ongoing only' },
    { flag: '--show <runId>', desc: 'equivalent to passing <runId> positionally; forces the --json code path for that one run', default: 'none' },
    { flag: '--cancel <runId>', desc: 'request cooperative cancellation of that run instead of viewing it', default: 'none' },
    { flag: '--overview', desc: "print one static frame of the run's overview panel (Workflow timeline, Live, Next) as plain text with no escape codes, sized by --width and --height, for a caller that embeds it; with --json, the same lines in a document with the run ids; needs a runId", default: 'off' },
    { flag: '--width <cols>', desc: 'columns of the --overview frame, at least 40', default: '100' },
    { flag: '--height <rows>', desc: 'rows of the --overview frame, at least 12', default: '30' },
  ],
  safety: [
    'interactive mode and the --json/--show/--all/--overview views are read-only',
    '--cancel writes state.json (cancelRequested=true, status=cancelling) — cooperative, not a force-kill: the workflow stops at its next safe checkpoint',
    'inside the interactive browser, q detaches without stopping the underlying workflow; c requests the same cancellation with a confirmation prompt',
    'the mouse (SGR reporting, 1000h/1006h) is enabled on entry and released on exit, so a detach never leaves the terminal capturing clicks',
    '[edit] on the Usage page hands the terminal to the same provider/model control center `bullswarm setup` opens and returns to the Usage page when it exits; [install] on Home runs the same install as `bullswarm integrate install --yes`',
    'the default timeline is derived from durable state and events; press v for raw action-ledger and event evidence',
    'below 100 columns the timeline remains full-width; press t to toggle Timeline and Phases, then Enter/Esc to drill into agents and activity',
  ],
  examples: [
    { cmd: 'bullswarm', note: 'the dashboard by its shortest name, once this machine is configured' },
    { cmd: 'bullswarm workflow tui', note: 'the explicit form of the same dashboard' },
    { cmd: 'bullswarm workflow tui --json --all' },
    { cmd: 'bullswarm workflow tui ab12cd --overview --width 90 --height 24', note: 'one plain-text frame of the timeline, live and next sections' },
  ],
  next: 'bullswarm workflow watch <runId> for a low-noise non-interactive follow, or bullswarm workflow runs result <runId> --json once it finishes.',
});

const workflowWatchText = rich({
  usage: 'bullswarm workflow watch <runId> [--classic] [--interval <seconds>] [--heartbeat <seconds>] [--stall-after <seconds>] [--next [--after <sequence>] [--since <iso-timestamp>]] [--jsonl] [--once] [--verbose]',
  purpose: "Follow one V2 run by printing one attach line, then one line per notable event "
    + '(action finished/failed/blocked/cancelled, evidence, stage completion, stall/recovery, planning, '
    + 'cancellation) and staying silent while work is merely in progress. A usage-limit failure always '
    + 'prints, verbose or not: an `⚠ ... usage limit on <pool> · paused until <deadline> · retrying on '
    + 'another pool` line, then an `↺ ... now on <pool> · <model>` line once the mechanical retry lands. '
    + '`--classic` forces the older heartbeat-based watcher instead (transition-on-change snapshots plus '
    + 'a periodic heartbeat); it applies only to V2 runs. A legacy authored-graph run cannot be watched at '
    + 'all: the watcher prints the legacy line and exits 2 before polling. `--next` prints no '
    + 'attach line and returns after the first notable event, or immediately at a pause or terminal status '
    + '(event mode only — it cannot combine with `--classic`). '
    + 'Every `--next` exit that leaves the run going prints a `next:` relaunch line carrying `--after` and '
    + '`--since`; pass those two values back on the relaunch so events committed while no watcher was '
    + 'attached are printed instead of skipped and an already-reported stall does not fire again. '
    + '`--heartbeat` is opt-in for event mode; `--classic` keeps the historical 60s heartbeat by '
    + 'default. Distinct from the full-screen tui and the machine-oriented events replay.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [
    { flag: '--classic', desc: 'force the older heartbeat-based watcher (transition-on-change snapshots plus a periodic heartbeat) instead of event mode; V2 runs only; cannot combine with --next', default: 'off (event mode)' },
    { flag: '--interval <seconds>', desc: 'poll interval while following', default: '2' },
    { flag: '--heartbeat <seconds>', desc: 'print a periodic heartbeat line when nothing has changed; opt-in for V2, must be >= 1', default: 'off in event mode, 60 with --classic' },
    { flag: '--stall-after <seconds>', desc: 'report a running agent as silent after this many seconds without activity; must be >= 1', default: '300' },
    { flag: '--next', desc: 'print no attach line; exit after the first poll that printed a notable event, or immediately at a pause or terminal status', default: 'off (follows until terminal or pause)' },
    { flag: '--after <sequence>', desc: 'start from this durable event sequence instead of the current high-water mark, so events committed since the previous watcher exited are printed; use the value from the previous `next:` line (in --jsonl, the `sequence` field of the last object)', default: 'attach at the current high-water mark' },
    { flag: '--since <iso-timestamp>', desc: 'the previous watcher\'s exit time; a running agent already silent at attach is reported only if its silence crossed --stall-after at or after this time, so no duplicate stall line prints (its recovery still does); use the value from the previous `next:` line', default: 'report every agent silent past --stall-after at attach' },
    { flag: '--jsonl', desc: 'emit one JSON object per line instead of human text; every object carries the `sequence` it was emitted at, and the `next:` relaunch line is not printed', default: 'off (human text)' },
    { flag: '--once', desc: 'print a single current snapshot and exit immediately instead of following', default: 'off (follows until terminal)' },
    { flag: '--verbose', desc: 'include started, retry, and steering-delivered lines in event mode, and per-agent action detail with --classic', default: 'off (compact)' },
  ],
  safety: [
    'read-only — polls durable state/events on a timer; writes nothing',
    'exits 0 if the run reaches a delivered status (or on --once), 1 if it reaches a non-delivered terminal status',
    '--next exits 0 while the run continues or when it delivered, 1 when it ended without delivering or the kernel is not running',
    'for a V2 run, a --next exit that leaves the run going ends with `next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>`; pause, terminal and interrupted exits keep their own outcome/next lines',
    '--classic --next is rejected with exit 2: --next only applies to event mode',
    'a legacy authored-graph run exits 2 with the legacy line before any polling; nothing drives it',
  ],
  examples: [
    { cmd: 'bullswarm workflow watch ab12cd --next', note: 'print the next notable event and exit; relaunch until outcome reports a pause or a terminal status' },
    { cmd: 'bullswarm workflow watch ab12cd --next --after 42 --since 2026-09-08T10:15:00.000Z', note: 'the relaunch: copy both values from the `next:` line the previous exit printed' },
    { cmd: 'bullswarm workflow watch ab12cd --stall-after 120 --heartbeat 30' },
    { cmd: 'bullswarm workflow watch ab12cd --classic', note: 'the older heartbeat-based watcher instead of event mode' },
  ],
  next: 'bullswarm workflow runs result <runId> --json once it finishes, or bullswarm workflow tui <runId> for the interactive view.',
});

const workflowEventsText = rich({
  usage: 'bullswarm workflow events <runId> [--after <sequence>] [--json]',
  purpose: "Replay one run's durable, ordered event log from a sequence cursor — the "
    + 'machine-oriented alternative to watch/tui.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [
    { flag: '--after <sequence>', desc: 'only return events with a sequence number greater than this cursor', default: '0 (all events)' },
    { flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON' },
  ],
  safety: ['read-only — writes nothing'],
  examples: [{ cmd: 'bullswarm workflow events ab12cd --after 0' }],
  next: 'increase --after with the last returned sequence number to page through further events, or bullswarm workflow watch <runId> for a human-friendly view.',
});

const workflowSteerText = rich({
  usage: 'bullswarm workflow steer <runId> --message <guidance> [--json]',
  purpose: "Queue free-text guidance for a running goal/workflow's next orchestration "
    + 'checkpoint, without interrupting the currently active step. In a caller-planned program run the '
    + 'guidance never halts work: watch prints it at once, and the caller acts on it with plan export and '
    + 'plan revise (which marks it delivered). A run that finishes before anyone acts on it lists it as '
    + 'steering not acted on; revising the finished run delivers it and reopens the run. To change the plan '
    + 'yourself, use plan revise directly.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [
    { flag: '--message <guidance>', desc: 'the guidance text; if omitted, all words after <runId> are joined and used instead', default: 'required, in one of the two forms' },
    { flag: '--json', desc: 'machine-readable confirmation', default: 'human-readable confirmation line' },
  ],
  safety: [
    "appends an entry to the run's steering log; delivered only at the next not-yet-started planner checkpoint — the currently active worker or action is unaffected",
    'refuses if the run is already terminal, and refuses a legacy authored-graph run with the legacy line and exit 2',
  ],
  examples: [{ cmd: 'bullswarm workflow steer ab12cd --message "Focus only on the auth module"' }],
  next: 'bullswarm workflow watch <runId> to see when the guidance takes effect.',
});

const workflowActionText = rich({
  usage: 'bullswarm workflow action <command> ...',
  purpose: 'Inspect one dispatched action and every attempt made at it.',
  argsTitle: 'Commands',
  args: [{ name: 'show <runId> <actionId>', desc: "print the action record, its attempts, output, and related events" }],
  options: [],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow action show ab12cd act-3' }],
  next: 'bullswarm workflow action show <runId> <actionId> for the full detail.',
});

const workflowActionShowText = rich({
  usage: 'bullswarm workflow action show <runId> <actionId> [--json]',
  purpose: "Print one action's full record — its ledger entry, every dispatch attempt, its "
    + 'saved output, and the events tied to it.',
  args: [
    { name: '<runId>', desc: 'shortId or runId' },
    { name: '<actionId>', desc: "action id from the run's action ledger (see workflow runs show or tui)" },
  ],
  options: [{ flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow action show ab12cd act-3' }],
  next: 'bullswarm workflow watch <runId> or bullswarm workflow tui <runId> to see actions in context.',
});

// --- workflow runs ----------------------------------------------------------

const workflowRunsListOptions = [
  { flag: '--all', desc: 'include both ongoing and historical runs', default: 'ongoing only' },
  { flag: '--historical', desc: 'only historical (finished) runs', default: 'ongoing only' },
  { flag: '--name <goal>', desc: 'filter by exact goal text (a legacy row matches on its recorded workflow name)', default: 'no filter' },
  { flag: '--since <time>', desc: 'lower bound on start time (inclusive); aliases --from, --started-after', default: 'no lower bound' },
  { flag: '--until <time>', desc: 'upper bound on start time (exclusive); aliases --to, --started-before', default: 'no upper bound' },
  { flag: '--limit <n>', desc: 'cap the number of results; must be a positive integer, and anything else exits 2', default: 'no cap' },
  { flag: '--json', desc: 'machine-readable output', default: 'human-readable one-line-per-run summary' },
];

const runsTimeFilterNote = 'Time filters compare each run\'s initiation timestamp and accept ISO '
  + 'timestamps, local dates (YYYY-MM-DD), today/yesterday/tomorrow/now, or relative durations '
  + 'such as 30m, 24h, 7d, 2w.';
const legacyRunNote = 'Legacy authored-graph runs are listed as read-only rows marked `legacy`; every '
  + 'driving command prints `legacy authored-graph run <shortId>: its executor was removed in 0.27.0; '
  + 'files remain under <dir>` and exits 2.';

const workflowRunsText = rich({
  usage: 'bullswarm workflow runs [list] [--all|--historical] [--name <goal>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
  purpose: 'Search ongoing and historical workflow run instances, including read-only legacy '
    + `rows, or drill into one with show/result/delete. ${legacyRunNote} ${runsTimeFilterNote}`,
  argsTitle: 'Commands',
  args: [
    { name: 'list', desc: 'search/list runs (default when no subcommand is given)' },
    { name: 'show <shortId|runId>', desc: "dump one run's state and report" },
    { name: 'result <shortId|runId>', desc: 'print the stable caller-facing delivery/verification/usage envelope' },
    { name: 'delete <shortId|runId>', desc: "remove a run's directory" },
  ],
  options: workflowRunsListOptions,
  safety: ['read-only (list/show/result); delete is irreversible — see workflow runs delete --help'],
  examples: [{ cmd: 'bullswarm workflow runs --all --since 7d' }],
  next: 'bullswarm workflow runs show <shortId> to inspect one, or bullswarm workflow runs result <shortId> --json once it is done.',
});

const workflowRunsListText = rich({
  usage: 'bullswarm workflow runs list [--all|--historical] [--name <goal>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
  purpose: 'Search ongoing and/or historical workflow runs, including read-only legacy rows, by '
    + `name and initiation-time window. ${legacyRunNote} Explicit form of the runs default. ${runsTimeFilterNote}`,
  args: [],
  options: workflowRunsListOptions,
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow runs list --historical --limit 20' }],
  next: 'bullswarm workflow runs show <shortId> to inspect one result.',
});

const workflowRunsShowText = rich({
  usage: 'bullswarm workflow runs show <shortId|runId> [--json]',
  purpose: "Show one run's durable state and status summary. V2 reports the goal, requirements, "
    + `and generic actions; a legacy row reports its read-only status. ${legacyRunNote}`,
  args: [{ name: '<shortId|runId>', desc: 'run identifier' }],
  options: [{ flag: '--json', desc: 'print the full state/report as JSON', default: 'human-readable summary lines' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow runs show ab12cd' }],
  next: 'bullswarm workflow runs result ab12cd --json for the stable delivery/verification envelope.',
});

const workflowRunsResultText = rich({
  usage: 'bullswarm workflow runs result <shortId|runId> [--json] [--summary]',
  purpose: 'Print the stable caller envelope. V2 returns the kernel-computed goal, requirement '
    + `ledger, action outcomes, and unresolved gaps; a legacy row remains read-only. ${legacyRunNote} `
    + 'This is the intended integration point for scripts and agents. Use --summary for the compact status-loop envelope; read the full envelope on failed or partial runs and before judging evidence.',
  args: [{ name: '<shortId|runId>', desc: 'run identifier' }],
  options: [
    { flag: '--json', desc: 'print the full versioned result document as JSON', default: 'human-readable result summary' },
    { flag: '--summary', desc: 'print the compact JSON status-loop envelope; implies --json', default: 'full result envelope' },
  ],
  safety: ['read-only'],
  examples: [
    { cmd: 'bullswarm workflow runs result ab12cd --json' },
    { cmd: 'bullswarm workflow runs result ab12cd --json --summary', note: 'compact status-loop result; read the full envelope for failed/partial runs or before judging evidence' },
  ],
  next: 'bullswarm workflow runs delete ab12cd --yes once you no longer need the run directory.',
});

const workflowRunsDeleteText = rich({
  usage: 'bullswarm workflow runs delete <shortId|runId> --yes [--force] [--json]',
  purpose: "Permanently remove one run's directory (state, report, events, logs).",
  args: [{ name: '<shortId|runId>', desc: 'run identifier' }],
  options: [
    { flag: '--yes', desc: 'required — approves the deletion', default: 'none; the command refuses without it' },
    { flag: '--force', desc: 'also delete an ongoing run', default: 'refuses to delete an ongoing run' },
    { flag: '--json', desc: 'machine-readable confirmation', default: 'human confirmation line' },
  ],
  safety: ['irreversible — recursively deletes ~/.bullswarm/workflows/<runId>/ from disk; refuses on an ongoing run unless --force is also given'],
  examples: [{ cmd: 'bullswarm workflow runs delete ab12cd --yes' }],
  next: 'bullswarm workflow runs --historical to confirm it is gone.',
});

// --- HELP tree ----------------------------------------------------------------

// --- provider -----------------------------------------------------------------

const providerText = rich({
  usage: 'bullswarm provider <list|enable|disable|validate|scaffold|probe> [options]',
  purpose: 'Manage providers, the plugins that define pools. A provider is a directory with a connector.json '
    + 'and/or a provider.mjs: first-class ones ship in src/providers/, contrib ones in providers/contrib/ and load '
    + 'only once enabled, local ones live in ~/.bullswarm/providers/. Bare `bullswarm provider` runs list.',
  argsTitle: 'Commands',
  args: [
    { name: 'list', desc: 'every provider with its tier, loading state, pools, skipped pools, and load error' },
    { name: 'enable', desc: 'load a contrib provider (writes ~/.bullswarm/providers.json)' },
    { name: 'disable', desc: 'stop loading a contrib provider' },
    { name: 'validate', desc: 'check a provider directory against the contract and the pool schema' },
    { name: 'scaffold', desc: 'write a commented provider directory to start from' },
    { name: 'probe', desc: 'spawn one pool with a one-word task and read its usage once' },
  ],
  options: [
    { flag: '--json', desc: 'machine-readable output where the subcommand supports it' },
  ],
  safety: [
    'enable and disable write only ~/.bullswarm/providers.json (or $BULLSWARM_HOME), never state.json',
    'loading is not routing: whether a loaded pool gets work stays bullswarm strategy set-provider <pool> on|off --yes',
    'probe spawns a real agent CLI once and reads its usage meter once',
  ],
  examples: [
    { cmd: 'bullswarm provider list', note: 'see what loaded and what failed' },
    { cmd: 'bullswarm provider scaffold relay && bullswarm provider validate relay && bullswarm provider probe relay', note: 'author a local provider' },
  ],
  next: 'bullswarm provider <command> --help for its arguments and options.',
});
const providerListText = rich({
  usage: 'bullswarm provider list [--json]',
  purpose: 'Show every provider, first-class, contrib, and local, with its tier, whether it is loaded, the pools it '
    + 'returned, the pools the loader skipped (name outside its prefix, or already defined), its load error, and '
    + 'whether it exports readUsage.',
  args: [],
  options: [{ flag: '--json', desc: 'print the report as JSON', default: 'human table' }],
  safety: ['read-only; loads every provider module and calls connectors() for the loaded ones'],
  examples: [{ cmd: 'bullswarm provider list --json' }],
  next: 'bullswarm provider enable <name> for a contrib provider, or bullswarm provider validate <name> for one that failed.',
});
const providerEnableText = rich({
  usage: 'bullswarm provider enable <name>',
  purpose: 'Load a contrib provider: add its directory name to ~/.bullswarm/providers.json. Its pools appear on the '
    + 'next bullswarm start.',
  args: [{ name: '<name>', desc: 'a directory name under providers/contrib/' }],
  options: [],
  safety: [
    'writes ~/.bullswarm/providers.json (or $BULLSWARM_HOME) only; state.json is never touched',
    'refuses a name with no contrib directory, and a name a local provider already claims',
    'enabling loads the pools; routing them stays bullswarm strategy set-provider <pool> on|off --yes',
  ],
  examples: [{ cmd: 'bullswarm provider enable command-code' }],
  next: 'bullswarm provider list to confirm its pools loaded.',
});
const providerDisableText = rich({
  usage: 'bullswarm provider disable <name>',
  purpose: 'Stop loading a contrib provider: remove its name from ~/.bullswarm/providers.json.',
  args: [{ name: '<name>', desc: 'a contrib provider name listed in providers.json' }],
  options: [],
  safety: ['writes ~/.bullswarm/providers.json (or $BULLSWARM_HOME) only; a name that is not listed writes nothing'],
  examples: [{ cmd: 'bullswarm provider disable command-code' }],
  next: 'bullswarm provider list to confirm.',
});
const providerValidateText = rich({
  usage: 'bullswarm provider validate <dir|name> [--json]',
  purpose: 'Import a provider directory, check name and the export types, call connectors() with the real shipped '
    + 'templates, and check the prefix rule and every returned pool against src/providers/_schema.json (required '
    + 'fields and allowed values), reporting per pool.',
  args: [{ name: '<dir|name>', desc: 'a provider directory path, or a provider name looked up in the local, contrib, then first-class directories' }],
  options: [{ flag: '--json', desc: 'print the report as JSON', default: 'human report' }],
  safety: ['runs the provider\'s module and its connectors(); never spawns the CLI or reads usage', 'exits 2 on any failure; warnings alone exit 0'],
  examples: [{ cmd: 'bullswarm provider validate ~/.bullswarm/providers/relay' }],
  next: 'bullswarm provider probe <pool> to run it for real.',
});
const providerScaffoldText = rich({
  usage: 'bullswarm provider scaffold <name> [--from <template>] [--dir <path>]',
  purpose: 'Write a commented provider directory: a provider.mjs skeleton showing every export and, with --from, a '
    + 'connector.json copied from that shipped template and renamed. The result passes validate unchanged.',
  args: [{ name: '<name>', desc: 'provider name: lowercase letters, digits, and dashes' }],
  options: [
    { flag: '--from <template>', desc: 'copy this shipped provider\'s connector.json (a reader meter is set to none until you export readUsage)', default: 'no connector.json; the pool is written inline' },
    { flag: '--dir <path>', desc: 'the provider directory to create', default: '~/.bullswarm/providers/<name>/' },
  ],
  safety: ['writes only inside the target directory, and refuses one that already exists and is not empty'],
  examples: [{ cmd: 'bullswarm provider scaffold relay --from opencode2', note: 'a reseller that runs through opencode' }],
  next: 'bullswarm provider validate <name>, then bullswarm provider probe <name>.',
});
const providerProbeText = rich({
  usage: 'bullswarm provider probe <pool> [--json] [--timeout <sec>]',
  purpose: 'Spawn one pool\'s CLI directly with the task "Reply with the single word PONG and nothing else" through '
    + 'the dispatcher\'s own runner, then, when its provider exports readUsage, read usage once with the pool\'s '
    + 'declared subscription. Prints the argv, the extracted output, the elapsed time, and the snapshot or error. '
    + 'This is the acceptance step for a provider.',
  args: [{ name: '<pool>', desc: 'a pool name; contrib providers are probed even when not enabled' }],
  options: [
    { flag: '--json', desc: 'print the result as JSON', default: 'human report' },
    { flag: '--timeout <sec>', desc: 'kill the CLI after this many seconds', default: '300' },
  ],
  safety: [
    'spawns the real CLI once in a throwaway directory, with no routing, quota gate, or assignment ledger, and ignores BULLSWARM_DEPTH',
    'values from the pool\'s env are redacted from everything printed',
    'exits 1 when the reply does not contain PONG or readUsage threw',
  ],
  examples: [{ cmd: 'bullswarm provider probe relay:b --json' }],
  next: 'bullswarm provider enable <name> for a contrib provider, then bullswarm strategy set-provider <pool> on --yes.',
});

const HELP = {
  _text: top,
  setup: { _text: setupText },
  integrate: {
    _text: integrateText,
    status: { _text: integrateStatusText },
    install: { _text: integrateInstallText },
    remove: { _text: integrateRemoveText },
    'retire-legacy': { _text: integrateRetireLegacyText },
  },
  run: { _text: runText },
  health: { _text: healthText },
  pools: { _text: poolsText },
  assignments: { _text: assignmentsText },
  doctor: { _text: doctorText },
  version: { _text: versionText },
  update: { _text: updateText },
  release: { _text: releaseText },
  strategy: {
    _text: strategyText,
    tui: { _text: strategyTuiText },
    inventory: { _text: strategyInventoryText },
    routes: { _text: strategyRoutesText },
    'set-provider': { _text: strategySetProviderText },
    'set-model': { _text: strategySetModelText },
    'reset-tier': { _text: strategyResetTierText },
    'set-reasoning': { _text: strategySetReasoningText },
    rungs: { _text: strategyRungsText },
    'set-rung': { _text: strategySetRungText },
    'reset-reasoning': { _text: strategyResetReasoningText },
    configure: { _text: strategyConfigureText },
    refresh: { _text: strategyRefreshText },
    recommend: { _text: strategyRecommendText },
    apply: { _text: strategyApplyText },
    show: { _text: strategyShowText },
    assign: { _text: strategyAssignText },
    'clear-assignment': { _text: strategyClearAssignmentText },
    'exclude-model': { _text: strategyExcludeModelText },
    'include-model': { _text: strategyIncludeModelText },
    'set-subscription': { _text: strategySetSubscriptionText },
    auto: {
      _text: strategyAutoText,
      status: { _text: strategyAutoStatusText },
      off: { _text: strategyAutoOffText },
    },
  },
  provider: {
    _text: providerText,
    list: { _text: providerListText },
    enable: { _text: providerEnableText },
    disable: { _text: providerDisableText },
    validate: { _text: providerValidateText },
    scaffold: { _text: providerScaffoldText },
    probe: { _text: providerProbeText },
  },
  workflow: {
    _text: workflowText,
    goal: { _text: workflowGoalText },
    plan: {
      _text: workflowPlanText,
      contract: { _text: workflowPlanContractText },
      validate: { _text: workflowPlanValidateText },
      show: { _text: workflowPlanShowText },
      submit: { _text: workflowPlanSubmitText },
      export: { _text: workflowPlanExportText },
      revise: { _text: workflowPlanReviseText },
    },
    pause: { _text: workflowPauseText },
    capabilities: { _text: workflowCapabilitiesText },
    tui: { _text: workflowTuiText },
    watch: { _text: workflowWatchText },
    events: { _text: workflowEventsText },
    steer: { _text: workflowSteerText },
    cancel: { _text: workflowCancelText },
    resume: { _text: workflowResumeText },
    action: {
      _text: workflowActionText,
      show: { _text: workflowActionShowText },
    },
    runs: runsHelp(),
  },
};

// Top-level `runs` is a documented alias. Keep its content aligned while
// rendering the syntax the caller actually invoked.
HELP.runs = aliasRunsHelp(HELP.workflow.runs);

export const HELP_PATHS = Object.freeze(collectPaths(HELP));

export function helpForArgs(argv) {
  const positionalHelp = argv.at(-1) === 'help';
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help' || positionalHelp;
  if (!wantsHelp) return null;
  if (argv.includes('--version')) return HELP.version._text;
  const tokens = argv[0] === 'help' ? argv.slice(1) : argv;
  let node = HELP;
  for (const token of tokens) {
    if (token === 'help' || token === '--help' || token === '-h' || token.startsWith('-')) continue;
    if (!node[token]) break;
    node = node[token];
  }
  return node._text ?? HELP._text;
}

// Canonical usage-line lookup for the real argument parsers. Every hand-typed
// `usage: bullswarm ...` string in src/cli.js, src/strategy-cli.js,
// src/integrate.js, and src/workflow/*.js should instead call this (or
// helpText() for a full multi-command block) so there is exactly one place
// that declares a command's synopsis. Returns the first line of the node's
// _text with the "Usage: " prefix stripped, e.g. `bullswarm strategy show
// [--json]`. Unlike helpForArgs() (user input, must degrade gracefully),
// this is only ever called with a hardcoded path, so an unknown path is a
// bug in the caller and throws immediately instead of silently rendering
// the wrong command's text.
export function usageLine(path) {
  return helpText(path).split('\n')[0].replace(/^Usage:\s*/, '');
}

// Full canonical help text for a path — used where a duplicate site prints
// an entire command-list block (e.g. on an unrecognized subcommand) rather
// than a single synopsis line.
export function helpText(path) {
  let node = HELP;
  for (const token of path) {
    if (!node[token]) throw new Error(`help.js: no such help path "${path.join(' ')}"`);
    node = node[token];
  }
  return node._text;
}

function runsHelp() {
  return {
    _text: workflowRunsText,
    list: { _text: workflowRunsListText },
    show: { _text: workflowRunsShowText },
    result: { _text: workflowRunsResultText },
    delete: { _text: workflowRunsDeleteText },
  };
}

function aliasRunsHelp(node) {
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    key === '_text'
      ? value.replaceAll('bullswarm workflow runs', 'bullswarm runs')
      : aliasRunsHelp(value),
  ]));
}

function collectPaths(node, prefix = []) {
  const paths = prefix.length ? [prefix] : [[]];
  for (const [name, child] of Object.entries(node)) {
    if (name === '_text') continue;
    paths.push(...collectPaths(child, [...prefix, name]));
  }
  return paths;
}
