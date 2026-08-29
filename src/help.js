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
  purpose: 'Route bounded work across coding-agent subscriptions (or keep it on the calling '
    + 'agent) and verify the result before treating it as done. Reach for a specific '
    + "command's --help for that command's full arguments, options, and defaults.",
  argsTitle: 'Commands',
  args: [
    { name: 'setup', desc: 'discover and configure installed coding agents' },
    { name: 'integrate', desc: 'register Bullswarm guidance with Codex, Claude, and Grok' },
    { name: 'run', desc: 'dispatch one bounded task' },
    { name: 'health', desc: 're-judge saved delegate outputs' },
    { name: 'pools', desc: 'show routing pools, meters, and quarantine state' },
    { name: 'strategy', desc: 'discover models and manage tier assignments' },
    { name: 'doctor', desc: 'report installation readiness' },
    { name: 'workflow', desc: 'create, execute, observe, and audit workflows' },
    { name: 'runs', desc: 'alias for workflow runs' },
    { name: 'version', desc: 'print the installed version' },
    { name: 'release', desc: 'create a version commit and tag' },
  ],
  options: [
    { flag: '--yes', desc: 'bare `bullswarm` only: skip the interactive wizard and auto-initialize with discovered defaults', default: 'prompts on a TTY; auto-initializes for a non-TTY caller' },
  ],
  safety: [
    'every command below except a --help/-h/help invocation self-initializes ~/.bullswarm/state.json (or $BULLSWARM_HOME) on first use',
    '--help/-h/help never reads or writes state, calls a network endpoint, or spawns a process, on any command',
  ],
  examples: [
    { cmd: 'bullswarm setup --yes && bullswarm run --lane analyze "audit this repo for TODOs"', note: 'one-time initialization, then one bounded task' },
  ],
  next: "bullswarm <command> --help for that command's full arguments, options, and defaults.",
});

// --- setup --------------------------------------------------------------------

const setupText = rich({
  usage: 'bullswarm setup [--yes] [--integrate] [--agents <list>] [--json]',
  purpose: 'Discover installed agent CLIs (codex, claude, grok, ...) and initialize local '
    + 'routing state. Without --yes on a TTY, opens the interactive wizard instead of '
    + 'applying discovered defaults automatically.',
  args: [],
  options: [
    { flag: '--yes', desc: 'skip the interactive wizard and initialize with discovered defaults', default: 'prompts on a TTY' },
    { flag: '--integrate', desc: 'also install agent integration (skill symlink + awareness block); requires --yes', default: 'off' },
    { flag: '--agents <list>', desc: 'comma-separated agent list for --integrate (codex, claude, grok)', default: 'all three' },
    { flag: '--json', desc: 'print a machine-readable result instead of human summary lines', default: 'human summary' },
  ],
  safety: [
    'writes ~/.bullswarm/state.json and routing.json (or $BULLSWARM_HOME equivalents)',
    'with --integrate --yes, also writes symlinks and awareness-block markers under each selected agent\'s global config directory (~/.codex, ~/.claude, ~/.grok)',
    'a non-TTY caller (the common case for an agent) auto-applies discovered defaults without prompting, even without --yes',
  ],
  examples: [
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
    { name: 'install', desc: 'symlink the skill and append the awareness block' },
    { name: 'remove', desc: 'remove only the Bullswarm-managed symlink and awareness block' },
    { name: 'retire-legacy', desc: 'recoverably archive the retired pre-Bullswarm offload skill' },
  ],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict the action to specific agents', default: 'all three' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    'install/remove write outside this repo, under each agent\'s home-dir config (~/.codex, ~/.claude, ~/.grok); status is read-only',
    'install refuses to replace a non-Bullswarm file found at the same path',
    'retire-legacy renames (moves), never deletes, the legacy skill directory',
  ],
  examples: [
    { cmd: 'bullswarm integrate status', note: 'check which agents already have the skill and awareness block installed' },
  ],
  next: 'bullswarm integrate install --yes to install for all discovered agents.',
});

const integrateStatusText = rich({
  usage: 'bullswarm integrate status [--agents codex,claude,grok] [--json]',
  purpose: 'Report, per agent, whether the packaged skill symlink and the awareness block are '
    + 'installed, and whether a legacy pre-Bullswarm offload skill needs retiring.',
  args: [],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict the report to specific agents', default: 'all three' },
    { flag: '--json', desc: 'machine-readable output', default: 'human summary lines' },
  ],
  safety: ['read-only: no files are written'],
  examples: [{ cmd: 'bullswarm integrate status --json' }],
  next: 'bullswarm integrate install --yes if anything reported is missing.',
});

const integrateInstallText = rich({
  usage: 'bullswarm integrate install [--agents codex,claude,grok] --yes [--json]',
  purpose: "Symlink the packaged Bullswarm skill and append the awareness block marker into "
    + "each selected agent's global instructions file.",
  args: [],
  options: [
    { flag: '--agents codex,claude,grok', desc: 'restrict install to specific agents', default: 'all three' },
    { flag: '--yes', desc: 'required — approves writing global agent configuration', default: 'none; the command refuses without it' },
    { flag: '--json', desc: 'machine-readable output' },
  ],
  safety: [
    "writes/symlinks under each agent's global config directory (~/.codex, ~/.claude, ~/.grok)",
    'refuses to replace a non-Bullswarm skill path instead of overwriting it',
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
    { flag: '--lane <analyze|build|chore>', desc: 'which routing lane to use: analyze (exploratory/large), build (implementation), chore (small/cheap)', default: 'required; no default' },
    { flag: '--add-dir <dir>', desc: 'working directory the delegate operates in', default: 'current directory' },
    { flag: '--task-file <file>', desc: 'read the task text from a file instead of trailing words' },
    { flag: '--prompt <text>', desc: 'pass the task text inline as one flag value' },
    { flag: '--effort <high|medium|low>', desc: 'override the effort tier used for model-tier routing', default: 'derived from --lane (analyze→high, build→medium, chore→low)' },
    { flag: '--timeout <seconds>', desc: 'hard wall-clock kill timer for the delegate process', default: 'none — the delegate is allowed to run to completion' },
    { flag: '--json', desc: 'print the machine-readable verdict document', default: 'human-readable summary line' },
  ],
  safety: [
    'spawns a real external coding-agent CLI process rooted at --add-dir',
    'writes ~/.bullswarm/state.json (decision log, pool incumbency) on completion',
    'may quarantine a pool for a period after an authentication failure',
  ],
  examples: [
    { cmd: 'bullswarm run --lane analyze --add-dir . "List every TODO comment in src/ with file:line"', note: 'routes one bounded analysis task and prints the verdict' },
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
    { flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON regardless of this flag' },
  ],
  safety: [
    'reads every out-* file under ~/.bullswarm/runs/ and re-runs the verify judge over each — cost scales with run history size',
    'if any pool quarantine has expired, writes the released state back to state.json (same sweep other commands perform); otherwise read-only',
  ],
  examples: [{ cmd: 'bullswarm health' }],
  next: 'bullswarm pools to see current routing/quarantine state directly.',
});

const poolsText = rich({
  usage: 'bullswarm pools [--force] [--json]',
  purpose: 'Show every configured pool: cost rank, lanes, live meter usage/elapsed percentage, '
    + 'pace surplus, and quarantine/burst-gate status.',
  args: [],
  options: [
    { flag: '--force', desc: 'bypass the meter cache and re-read live usage for every pool', default: 'off (cached meter readings reused within their TTL)' },
    { flag: '--json', desc: 'machine-readable pool array', default: 'human-readable aligned table' },
  ],
  safety: [
    'calls each connector\'s live usage meter (network request per metered pool) to compute used/elapsed percentages',
    'always writes state.json after sweeping expired quarantines back into service, even in --json mode',
  ],
  examples: [{ cmd: 'bullswarm pools --force' }],
  next: 'bullswarm doctor for a pass/fail readiness report instead of raw pool state.',
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
  usage: 'bullswarm strategy <command> [options]',
  purpose: 'Discover which models each installed agent CLI can currently use, recommend a '
    + 'high/medium/low effort-tier assignment per pool, and manage explicit overrides.',
  argsTitle: 'Commands',
  args: [
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
    'refresh/apply/assign/clear-assignment/exclude-model/include-model/set-subscription all mutate ~/.bullswarm/state.json',
    'refresh (and a cold show) perform live discovery calls against every installed agent CLI',
  ],
  examples: [
    { cmd: 'bullswarm strategy refresh', note: 'discover models and print tier recommendations without changing routing' },
  ],
  next: 'bullswarm strategy show to review, then bullswarm strategy apply --yes to approve.',
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
  safety: ['read path is safe; a cold cache triggers the same discovery I/O as refresh'],
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
  examples: [{ cmd: 'bullswarm strategy assign high --pool claude --model claude-opus-5' }],
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
  usage: 'bullswarm strategy set-subscription <pool> [--plan <name>] [--monthly-usd <n|unknown>] [--included-usd <n|unknown>] [--quota-window <name>]',
  purpose: "Record known subscription pricing for a pool so refresh's value-multiple math "
    + '(included value vs. monthly cost) is accurate.',
  args: [{ name: '<pool>', desc: 'connector/pool name to record economics for' }],
  options: [
    { flag: '--plan <name>', desc: 'plan label to record', default: 'unchanged' },
    { flag: '--monthly-usd <n|unknown>', desc: 'monthly subscription price', default: 'unchanged' },
    { flag: '--included-usd <n|unknown>', desc: 'estimated included usage value', default: 'unchanged' },
    { flag: '--quota-window <name>', desc: 'label for the quota reset window', default: 'unchanged' },
  ],
  safety: ['writes state.strategy.subscriptions[pool] and invalidates the cached report'],
  examples: [{ cmd: 'bullswarm strategy set-subscription claude --plan max --monthly-usd 200 --included-usd 1000' }],
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
// reading src/workflow/cli.js (wfCapabilities, wfEvents, wfAction) and
// src/workflow/dashboard.js (decideApproval's caller in wfApproval) — none of
// them branch on opts.json.

const workflowText = rich({
  usage: 'bullswarm workflow <command> [options]',
  purpose: 'Create, execute, observe, and audit durable multi-agent workflows: autonomous '
    + 'goals, fixed workflow files, and incrementally-built drafts all run through the same '
    + 'durable, resumable execution engine.',
  argsTitle: 'Commands',
  args: [
    { name: 'goal "<goal>"', desc: 'autonomously plan, execute, verify, and replan a goal' },
    { name: 'run <file-or-name>', desc: 'run an existing workflow file or saved draft' },
    { name: 'draft ...', desc: 'incrementally build a fixed workflow graph' },
    { name: 'validate <file-or-name>', desc: 'validate without executing' },
    { name: 'inspect <file-or-name>', desc: 'show the document, semantics, and validation details' },
    { name: 'list', desc: 'list available workflow definitions' },
    { name: 'capabilities', desc: 'show pools, lanes, models, meters, and routing constraints' },
    { name: 'runs ...', desc: 'search ongoing and historical workflow instances' },
    { name: 'tui [runId]', desc: 'full-screen phase → agent → step/detail browser' },
    { name: 'watch <runId>', desc: 'follow low-noise progress until terminal' },
    { name: 'events <runId>', desc: 'replay durable events after a sequence cursor' },
    { name: 'steer <runId>', desc: 'queue guidance for the next planner checkpoint' },
    { name: 'action show ...', desc: 'inspect one action and all of its attempts' },
    { name: 'approval <approve|reject> ...', desc: 'approve or reject a waiting decision gate' },
  ],
  options: [],
  safety: [
    'reconcileInterruptedRuns() runs before every workflow subcommand dispatch — including a '
      + 'mistyped bare "help" argument, since only --help/-h/leading "help" bypass dispatch '
      + 'entirely — and can rewrite state.json for any run whose heartbeat looks stale',
    'goal/run/draft run dispatch real coding-agent CLI processes and write durable state under '
      + '~/.bullswarm/workflows/<runId>/; validate/inspect/list/capabilities/tui/watch/events are '
      + 'read-only (tui --cancel, steer, approval, and "runs delete" are the exceptions — see '
      + 'their own --help)',
  ],
  examples: [
    { cmd: 'bullswarm workflow goal "Audit this repository for TODOs" --cwd .', note: 'autonomous goal, launched independently' },
    { cmd: 'bullswarm workflow runs --all --since 7d', note: 'list every run started in the last week' },
  ],
  next: "bullswarm workflow <command> --help for that command's full arguments, options, and defaults.",
});

const workflowGoalText = rich({
  usage: 'bullswarm workflow goal "<goal>" [--cwd <dir>] [--watch|--foreground] [--json] '
    + '[--resume <shortId|runId>] [planning options]',
  purpose: 'Autonomously plan, execute, verify, and replan a goal end to end: an orchestrator '
    + 'expands the goal into phases and steps, dispatches them to delegate pools, and adapts '
    + 'the plan as results come in. Launches independently by default so the calling agent is '
    + 'not blocked.',
  args: [
    { name: '"<goal>"', desc: 'the goal text, as one argument; not used (and not required) with --resume or the internal --request relaunch mode' },
  ],
  options: [
    { flag: '--cwd <dir>', desc: 'working directory the goal executes in', default: 'current directory' },
    { flag: '--watch', desc: 'immediately follow low-noise progress until terminal; only valid for a new human-readable independent launch — cannot combine with --detach, --foreground, --json, --resume, or --request', default: 'off' },
    { flag: '--foreground', desc: 'keep execution attached to this terminal instead of detaching', default: 'off (detaches into a background process)' },
    { flag: '--json', desc: 'print the launch/report document as JSON', default: 'human-readable launch instructions' },
    { flag: '--orchestrator <pool|auto>', desc: 'prefer this orchestrator pool for a new goal or resumed run, falling back immediately when it is quota-gated, ineligible, or unavailable', default: 'auto (capability- and quota-based selection)' },
    { flag: '--strict-orchestrator <pool>', desc: 'require exactly this orchestrator pool for controlled provider QA; waits when that pool is quota-gated instead of falling back; mutually exclusive with --orchestrator', default: 'off' },
    { flag: '--max-agents <n>', desc: 'planning target for total dispatched agents (soft, not a hard stop)', default: '30 (max 500)' },
    { flag: '--max-expansion-rounds <n>', desc: 'planning target for planner replanning rounds', default: '8 (max 50)' },
    { flag: '--max-actions <n>', desc: 'planning target for total dispatched actions', default: '40 (max 1000)' },
    { flag: '--max-items-per-expansion <n>', desc: 'cap on fanout items per planner round, inline or resolved from itemsFrom at execution time', default: '24 (max 100)' },
    { flag: '--no-scout', desc: 'skip the read-only scout action that surveys the repository (tree, manifest, test status, units of work) before the orchestrator compiles its first program', default: 'scout runs first' },
    { flag: '--max-workflow-seconds <n>', desc: 'planning target for total wall-clock seconds', default: '3600 (max 86400)' },
    { flag: '--concurrency <n>', desc: 'max parallel dispatches; dependency-ready actions from one decision run concurrently up to this cap', default: '8 (max 16)' },
    { flag: '--retry-attempts <0..3>', desc: 'same-pool retries per failed action', default: '1' },
    { flag: '--resume <shortId|runId>', desc: 'resume a previously started run instead of starting a new goal; mutually exclusive with typing new goal text', default: 'starts a new goal' },
    { flag: '--detach', desc: 'rarely needed — explicitly requests the default independent-launch behavior; cannot combine with --watch', default: 'the default launch already detaches' },
  ],
  safety: [
    'default launch writes ~/.bullswarm/goals/<runId>/ (request.json, launcher.json, stdout.log, '
      + 'stderr.log) and spawns a detached background '
      + '`bullswarm workflow goal --request ... --run-id ...` child process that keeps running '
      + 'after this command returns',
    'writes durable workflow state under ~/.bullswarm/workflows/<runId>/ throughout execution '
      + '(state.json, events, attempts)',
    'dispatches real coding-agent CLI processes per planned step, the same as bullswarm run',
    'the goal document is validated before anything launches; an invalid goal is rejected and nothing runs',
  ],
  examples: [
    { cmd: 'bullswarm workflow goal "Audit this repo for TODOs and file a one-page summary" --cwd .' },
  ],
  next: 'bullswarm workflow watch <shortId> to follow progress, or bullswarm workflow tui for the interactive browser.',
});

const workflowRunText = rich({
  usage: 'bullswarm workflow run <file-or-name> [--input k=v]... [--resume <shortId|runId>] [--json] [--quiet]',
  purpose: 'Run an existing workflow file or saved draft to completion (or resume one already '
    + 'in progress), dispatching each planned step to a delegate pool.',
  args: [
    { name: '<file-or-name>', desc: 'a workflow JSON file path, or a bare name resolved against ./workflows, ~/.bullswarm/workflows, and ~/.bullswarm/drafts' },
  ],
  options: [
    { flag: '--input k=v', desc: 'declare or override a workflow input value; JSON-decoded when the value starts with [, {, ", or \' (repeatable)', default: 'none' },
    { flag: '--resume <shortId|runId>', desc: 'resume a previous run of this workflow instead of starting fresh', default: 'starts a new run' },
    { flag: '--json', desc: 'print the machine-readable report document', default: 'human-readable progress (compact TUI-style lines)' },
    { flag: '--quiet', desc: 'suppress human progress output even without --json', default: 'off' },
  ],
  safety: [
    'dispatches real coding-agent CLI processes per step (same routing/spend as bullswarm run)',
    'writes durable workflow state under ~/.bullswarm/workflows/<runId>/',
    'validated against live pools before running; an invalid document is rejected and nothing runs',
  ],
  examples: [{ cmd: 'bullswarm workflow run my-workflow.json --input target=src/ --json' }],
  next: 'bullswarm workflow runs show <shortId> to check progress, or bullswarm workflow watch <shortId> to follow it live.',
});

const workflowValidateText = rich({
  usage: 'bullswarm workflow validate <file-or-name>',
  purpose: 'Load a workflow file or saved draft and check it against the schema and live pool '
    + 'names, without running anything.',
  args: [{ name: '<file-or-name>', desc: 'same resolution as workflow run' }],
  options: [],
  safety: ['read-only — performs live pool discovery to check pool-name references, but nothing is dispatched or written'],
  examples: [{ cmd: 'bullswarm workflow validate my-workflow.json' }],
  next: 'bullswarm workflow run <file-or-name> once it reports valid.',
});

const workflowListText = rich({
  usage: 'bullswarm workflow list [--json]',
  purpose: 'List discoverable workflow files and drafts.',
  args: [],
  options: [{ flag: '--json', desc: 'print a machine-readable array of {name, path, valid, draft}', default: 'human-readable one-line-per-workflow summary' }],
  safety: ['read-only — scans ./workflows, ~/.bullswarm/workflows, and ~/.bullswarm/drafts; nothing is written'],
  examples: [{ cmd: 'bullswarm workflow list' }],
  next: 'bullswarm workflow validate <name> to check one before running.',
});

const workflowCapabilitiesText = rich({
  usage: 'bullswarm workflow capabilities',
  purpose: 'Report the lanes, step types, workflow engine features, current routing policy, '
    + 'and live pool/model/meter state available for planning a goal or workflow.',
  args: [],
  options: [{ flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON regardless of this flag' }],
  safety: ['read-only — performs live pool discovery to populate pool/meter state; nothing is written'],
  examples: [{ cmd: 'bullswarm workflow capabilities' }],
  next: 'bullswarm workflow goal "<goal>" --orchestrator <pool> to prefer one of the reported pools with fallback, or bullswarm strategy show to review model tier assignments.',
});

const workflowInspectText = rich({
  usage: 'bullswarm workflow inspect <file-or-name>',
  purpose: 'Load a workflow document and print its structure, resolved per-step-type '
    + 'semantics, and full validation result as JSON — deeper detail than validate.',
  args: [{ name: '<file-or-name>', desc: 'same resolution as workflow run' }],
  options: [],
  safety: ['read-only — performs live pool discovery to populate availablePools; nothing is written'],
  examples: [{ cmd: 'bullswarm workflow inspect my-workflow.json' }],
  next: 'bullswarm workflow validate <file-or-name> for a concise pass/fail check, or bullswarm workflow run <file-or-name> to execute it.',
});

const workflowTuiText = rich({
  usage: 'bullswarm workflow tui [<runId>] [--json] [--all] [--show <runId>] [--cancel <runId>]',
  purpose: 'Open the interactive full-screen workflow timeline with Workflow Planner, phase, '
    + 'live-agent, and technical drill-down views for ongoing and historical runs, or print a '
    + 'static/JSON snapshot for a non-interactive caller.',
  args: [{ name: '[<runId>]', desc: 'shortId or runId to open directly in detail view; omit to see the run picker' }],
  options: [
    { flag: '--json', desc: "print a JSON snapshot instead of opening the interactive browser (list of ongoing runs, or one run's state/report/events when a runId is given)", default: "opens the interactive browser on a TTY; without a TTY, a given runId instead prints one static text detail tree" },
    { flag: '--all', desc: 'with --json and no runId, include historical (finished) runs, not just ongoing ones', default: 'ongoing only' },
    { flag: '--show <runId>', desc: 'equivalent to passing <runId> positionally; forces the --json code path for that one run', default: 'none' },
    { flag: '--cancel <runId>', desc: 'request cooperative cancellation of that run instead of viewing it', default: 'none' },
  ],
  safety: [
    'interactive mode and the --json/--show/--all views are read-only',
    '--cancel writes state.json (cancelRequested=true, status=cancelling) — cooperative, not a force-kill: the workflow stops at its next safe checkpoint',
    'inside the interactive browser, q detaches without stopping the underlying workflow; c requests the same cancellation with a confirmation prompt',
    'the default timeline is derived from durable state and events; press v for raw action-ledger and event evidence',
  ],
  examples: [
    { cmd: 'bullswarm workflow tui', note: 'interactive run picker' },
    { cmd: 'bullswarm workflow tui --json --all' },
  ],
  next: 'bullswarm workflow watch <runId> for a low-noise non-interactive follow, or bullswarm workflow approval approve <runId> if it is waiting on a decision gate.',
});

const workflowWatchText = rich({
  usage: 'bullswarm workflow watch <runId> [--interval <seconds>] [--heartbeat <seconds>] [--jsonl] [--once] [--verbose]',
  purpose: "Follow one run's progress with low noise: prints only semantic changes plus a "
    + 'periodic heartbeat, then a timing breakdown at completion. Each line shows two silences: '
    + '"quiet" is time since the last durable workflow event, "agent output … ago" is time since a '
    + 'live agent last produced output, so a thinking agent and a dead one look different. Distinct from the '
    + 'full-screen tui and the machine-oriented events replay.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [
    { flag: '--interval <seconds>', desc: 'poll interval while following', default: '2' },
    { flag: '--heartbeat <seconds>', desc: 'max gap between heartbeat lines when nothing has changed', default: '60' },
    { flag: '--jsonl', desc: 'emit one JSON object per line instead of human text', default: 'off (human text)' },
    { flag: '--once', desc: 'print a single current snapshot and exit immediately instead of following', default: 'off (follows until terminal)' },
    { flag: '--verbose', desc: 'include per-agent action detail lines', default: 'off (compact)' },
  ],
  safety: [
    'read-only — polls durable state/events on a timer; writes nothing',
    'exits 0 if the run reaches a delivered status (or on --once), 1 if it reaches a non-delivered terminal status',
  ],
  examples: [{ cmd: 'bullswarm workflow watch ab12cd --heartbeat 30' }],
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
    + 'checkpoint, without interrupting the currently active step.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [
    { flag: '--message <guidance>', desc: 'the guidance text; if omitted, all words after <runId> are joined and used instead', default: 'required, in one of the two forms' },
    { flag: '--json', desc: 'machine-readable confirmation', default: 'human-readable confirmation line' },
  ],
  safety: [
    "appends an entry to the run's steering log; delivered only at the next not-yet-started planner/decision checkpoint — the currently active worker or step is unaffected",
    'refuses if the run is already terminal, or has no decide step (nothing to steer)',
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

const workflowApprovalText = rich({
  usage: 'bullswarm workflow approval <approve|reject> <runId> [--json]',
  purpose: 'Approve or reject a workflow that is paused waiting for a decision gate.',
  argsTitle: 'Commands',
  args: [
    { name: 'approve <runId>', desc: "approve the waiting gate; the workflow resumes" },
    { name: 'reject <runId>', desc: 'reject the waiting gate; the workflow is cancelled' },
  ],
  options: [{ flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON' }],
  safety: ["writes state.json for the target run; only valid while the run's status is waiting_for_approval"],
  examples: [{ cmd: 'bullswarm workflow approval approve ab12cd' }],
  next: 'bullswarm workflow watch <runId> to confirm the run resumed (or stopped).',
});

const workflowApprovalApproveText = rich({
  usage: 'bullswarm workflow approval approve <runId> [--json]',
  purpose: "Approve a waiting decision gate; the run's status moves to paused and continues at "
    + 'the next orchestration step.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [{ flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON' }],
  safety: ['writes state.json; fails if the run is not currently waiting_for_approval'],
  examples: [{ cmd: 'bullswarm workflow approval approve ab12cd' }],
  next: 'bullswarm workflow watch ab12cd to confirm it resumed.',
});

const workflowApprovalRejectText = rich({
  usage: 'bullswarm workflow approval reject <runId> [--json]',
  purpose: 'Reject a waiting decision gate; the run is marked cancelled and stops.',
  args: [{ name: '<runId>', desc: 'shortId or runId' }],
  options: [{ flag: '--json', desc: 'accepted for consistency with other commands, but has no effect', default: 'output is always JSON' }],
  safety: ['writes state.json (status: cancelled, finishedAt set); fails if the run is not currently waiting_for_approval'],
  examples: [{ cmd: 'bullswarm workflow approval reject ab12cd' }],
  next: 'bullswarm workflow runs show ab12cd to review why it was rejected.',
});

// --- workflow runs ----------------------------------------------------------

const workflowRunsListOptions = [
  { flag: '--all', desc: 'include both ongoing and historical runs', default: 'ongoing only' },
  { flag: '--historical', desc: 'only historical (finished) runs', default: 'ongoing only' },
  { flag: '--name <workflow>', desc: 'filter by workflow name', default: 'no filter' },
  { flag: '--since <time>', desc: 'lower bound on start time (inclusive); aliases --from, --started-after', default: 'no lower bound' },
  { flag: '--until <time>', desc: 'upper bound on start time (exclusive); aliases --to, --started-before', default: 'no upper bound' },
  { flag: '--limit <n>', desc: 'cap the number of results', default: 'no cap' },
  { flag: '--json', desc: 'machine-readable output', default: 'human-readable one-line-per-run summary' },
];

const runsTimeFilterNote = 'Time filters compare each run\'s initiation timestamp and accept ISO '
  + 'timestamps, local dates (YYYY-MM-DD), today/yesterday/tomorrow/now, or relative durations '
  + 'such as 30m, 24h, 7d, 2w.';

const workflowRunsText = rich({
  usage: 'bullswarm workflow runs [list] [--all|--historical] [--name <workflow>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
  purpose: 'Search ongoing and historical workflow run instances (goals, workflow runs, and '
    + `draft runs all share this index), or drill into one with show/result/delete. ${runsTimeFilterNote}`,
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
  usage: 'bullswarm workflow runs list [--all|--historical] [--name <workflow>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
  purpose: 'Search ongoing and/or historical workflow runs by name and initiation-time window. '
    + `Explicit form of the runs default. ${runsTimeFilterNote}`,
  args: [],
  options: workflowRunsListOptions,
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow runs list --historical --limit 20' }],
  next: 'bullswarm workflow runs show <shortId> to inspect one result.',
});

const workflowRunsShowText = rich({
  usage: 'bullswarm workflow runs show <shortId|runId> [--json]',
  purpose: "Dump one run's durable state.json and report.json (status, timestamps, step summary).",
  args: [{ name: '<shortId|runId>', desc: 'run identifier' }],
  options: [{ flag: '--json', desc: 'print the full state/report as JSON', default: 'human-readable summary lines' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow runs show ab12cd' }],
  next: 'bullswarm workflow runs result ab12cd --json for the stable delivery/verification envelope.',
});

const workflowRunsResultText = rich({
  usage: 'bullswarm workflow runs result <shortId|runId> [--json]',
  purpose: 'Print the stable, caller-facing delivery content, verification verdict, progress, '
    + 'and usage envelope for one run — the intended integration point for scripts and agents.',
  args: [{ name: '<shortId|runId>', desc: 'run identifier' }],
  options: [{ flag: '--json', desc: 'print the full result document as JSON', default: 'human-readable summary (delivery preview truncated to 64KB)' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow runs result ab12cd --json' }],
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

// --- workflow draft ----------------------------------------------------------

const workflowDraftText = rich({
  usage: 'bullswarm workflow draft <command> [options]',
  purpose: 'Incrementally build a fixed workflow graph — phases, then steps — by CLI calls '
    + 'instead of hand-writing the whole JSON document at once, then validate and run it.',
  argsTitle: 'Commands',
  args: [
    { name: 'create <name>', desc: 'start a new, empty draft' },
    { name: 'show <name>', desc: "print a draft's current document and validation state" },
    { name: 'list', desc: 'list saved drafts' },
    { name: 'phase add|remove', desc: 'add or remove a phase' },
    { name: 'step add|remove|set', desc: 'add, remove, or edit one field of a step' },
    { name: 'set', desc: 'edit one draft-level field' },
    { name: 'validate <name>', desc: 'validate without executing' },
    { name: 'export <name> <out-file>', desc: "write the draft's workflow.json to a file" },
    { name: 'delete <name>', desc: 'permanently delete a draft' },
    { name: 'run <name>', desc: 'run the draft like workflow run' },
  ],
  options: [],
  safety: [
    'create/phase/step/set write ~/.bullswarm/drafts/<name>/ (workflow.json, meta.json) on '
      + 'every call; each mutation re-validates and stores the result, but never rolls back a '
      + 'resulting invalid document — fix it with more phase/step/set calls',
    'run dispatches real coding-agent CLI processes and writes durable state under '
      + '~/.bullswarm/workflows/<runId>/, same as workflow run',
    'delete is irreversible',
  ],
  examples: [{ cmd: 'bullswarm workflow draft create audit-repo --description "Audit repo for TODOs"' }],
  next: 'bullswarm workflow draft phase add <name> <phase> to add the first phase.',
});

const workflowDraftCreateText = rich({
  usage: 'bullswarm workflow draft create <name> [--description <text>] [--input k=v]... [--required <keys>] [--json]',
  purpose: 'Create a new, empty draft workflow (no phases yet) under ~/.bullswarm/drafts/<name>/.',
  args: [{ name: '<name>', desc: 'draft name; refuses if a draft with this name already exists' }],
  options: [
    { flag: '--description <text>', desc: 'human-readable description stored on the document', default: '"New draft workflow — describe what it does."' },
    { flag: '--input k=v', desc: "declare an input with a default value (repeatable); JSON-decoded when the value starts with [, {, \", or '", default: 'none' },
    { flag: '--required <keys>', desc: 'comma-separated subset of the --input keys to mark required', default: 'none required' },
    { flag: '--json', desc: 'machine-readable confirmation', default: 'human confirmation line' },
  ],
  safety: ['writes ~/.bullswarm/drafts/<name>/workflow.json and meta.json'],
  examples: [{ cmd: 'bullswarm workflow draft create audit-repo --input target=src/ --required target' }],
  next: 'bullswarm workflow draft phase add audit-repo <phase-name>.',
});

const workflowDraftShowText = rich({
  usage: 'bullswarm workflow draft show <name> [--json]',
  purpose: "Print a draft's current workflow document plus its last validation result.",
  args: [{ name: '<name>', desc: 'draft name' }],
  options: [{ flag: '--json', desc: 'print {doc, meta} as JSON', default: 'human-readable header plus the full document JSON' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow draft show audit-repo' }],
  next: 'bullswarm workflow draft validate audit-repo before running it.',
});

const workflowDraftListText = rich({
  usage: 'bullswarm workflow draft list [--json]',
  purpose: 'List saved drafts with their phase/step counts and validity.',
  args: [],
  options: [{ flag: '--json', desc: 'machine-readable array', default: 'human-readable one-line-per-draft summary' }],
  safety: ['read-only'],
  examples: [{ cmd: 'bullswarm workflow draft list' }],
  next: 'bullswarm workflow draft show <name> to inspect one.',
});

const workflowDraftPhaseText = rich({
  usage: 'bullswarm workflow draft phase <add|remove> <draft> <phase> [--json]',
  purpose: 'Add or remove a phase (an ordered group of steps) on a draft.',
  argsTitle: 'Commands',
  args: [
    { name: 'add <draft> <phase>', desc: 'append a new phase' },
    { name: 'remove <draft> <phase>', desc: 'remove a phase and its steps' },
  ],
  options: [{ flag: '--json', desc: 'machine-readable confirmation with the resulting validation', default: 'human confirmation line plus any validation issues/warnings' }],
  safety: ["writes the draft's workflow.json and re-validates it (does not roll back an invalid result)"],
  examples: [{ cmd: 'bullswarm workflow draft phase add audit-repo scan' }],
  next: 'bullswarm workflow draft step add audit-repo scan <step-id> to add a step to the phase.',
});

const workflowDraftPhaseAddText = rich({
  usage: 'bullswarm workflow draft phase add <draft> <phase> [--json]',
  purpose: 'Append a new, empty phase to a draft.',
  args: [{ name: '<draft>', desc: 'draft name' }, { name: '<phase>', desc: 'new phase name' }],
  options: [{ flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' }],
  safety: ["writes the draft's workflow.json and re-validates it"],
  examples: [{ cmd: 'bullswarm workflow draft phase add audit-repo scan' }],
  next: 'bullswarm workflow draft step add audit-repo scan <step-id>.',
});

const workflowDraftPhaseRemoveText = rich({
  usage: 'bullswarm workflow draft phase remove <draft> <phase> [--json]',
  purpose: 'Remove a phase and every step inside it from a draft.',
  args: [{ name: '<draft>', desc: 'draft name' }, { name: '<phase>', desc: 'phase to remove' }],
  options: [{ flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' }],
  safety: ["writes the draft's workflow.json and re-validates it; removing a phase also deletes its steps"],
  examples: [{ cmd: 'bullswarm workflow draft phase remove audit-repo scan' }],
  next: 'bullswarm workflow draft show audit-repo to confirm.',
});

const workflowDraftStepText = rich({
  usage: 'bullswarm workflow draft step <add|remove|set> <draft> <phase> <step-id> [options]',
  purpose: "Add, remove, or edit one field of a step within a draft's phase.",
  argsTitle: 'Commands',
  args: [
    { name: 'add', desc: 'add a new step to the phase' },
    { name: 'remove', desc: 'remove a step from the phase' },
    { name: 'set', desc: 'edit one field of an existing step' },
  ],
  options: [],
  safety: ["writes the draft's workflow.json and re-validates it"],
  examples: [{ cmd: 'bullswarm workflow draft step add audit-repo scan find-todos --type run --lane analyze --prompt "List every TODO with file:line"' }],
  next: 'bullswarm workflow draft validate <draft> once every phase has steps.',
});

const workflowDraftStepAddText = rich({
  usage: 'bullswarm workflow draft step add <draft> <phase> <step-id> [--type <run|fanout|verify|decide>] '
    + '[--lane <lane>] [--pool <pool>] [--prompt <text>] [--task-file <path>] [--add-dir <dir>] '
    + '[--items-from <path>] [--review <path>] [--concurrency <n>] [--timeout <n>] '
    + '[--on-error <continue|fail|skip-phase>] [--step-template <json>] [--json]',
  purpose: 'Add one step to an existing phase of a draft.',
  args: [
    { name: '<draft>', desc: 'draft name' },
    { name: '<phase>', desc: 'phase to add the step to (must already exist)' },
    { name: '<step-id>', desc: 'unique step id within the phase' },
  ],
  options: [
    { flag: '--type <run|fanout|verify|decide>', desc: 'the step type', default: 'run' },
    { flag: '--lane <lane>', desc: 'routing lane (analyze|build|chore) for run/fanout steps' },
    { flag: '--pool <pool>', desc: 'pin a specific pool instead of routing by lane' },
    { flag: '--prompt <text>', desc: 'the task prompt; JSON-decoded when it starts with [, {, ", or \'' },
    { flag: '--task-file <path>', desc: 'read the prompt from a file instead of --prompt' },
    { flag: '--add-dir <dir>', desc: 'working directory the delegate operates in' },
    { flag: '--items-from <path>', desc: 'fanout steps only — inputs.<name> or outputs.<priorStepId> supplying the array to fan out over', default: 'required for fanout' },
    { flag: '--review <path>', desc: 'verify steps only — outputs.<priorStepId>.outFile to review', default: 'required for verify' },
    { flag: '--concurrency <n>', desc: 'fanout steps only — max parallel dispatches', default: "falls back to the draft's settings.concurrency (4 for a fresh draft)" },
    { flag: '--timeout <n>', desc: 'per-step wall-clock timeout in seconds', default: 'none' },
    { flag: '--on-error <continue|fail|skip-phase>', desc: 'what to do if this step fails', default: 'continue' },
    { flag: '--step-template <json>', desc: 'required for fanout steps — a JSON object describing the per-item step, supporting {{item}}/{{item.*}} placeholders' },
    { flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' },
  ],
  safety: ["writes the draft's workflow.json and re-validates it; refuses if the phase does not exist yet"],
  examples: [{ cmd: 'bullswarm workflow draft step add audit-repo scan find-todos --type run --lane analyze --prompt "List every TODO with file:line"' }],
  next: 'bullswarm workflow draft validate audit-repo once the phase has the steps you want.',
});

const workflowDraftStepRemoveText = rich({
  usage: 'bullswarm workflow draft step remove <draft> <phase> <step-id> [--json]',
  purpose: 'Remove one step from a phase.',
  args: [
    { name: '<draft>', desc: 'draft name' },
    { name: '<phase>', desc: 'phase containing the step' },
    { name: '<step-id>', desc: 'step to remove' },
  ],
  options: [{ flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' }],
  safety: ["writes the draft's workflow.json and re-validates it"],
  examples: [{ cmd: 'bullswarm workflow draft step remove audit-repo scan find-todos' }],
  next: 'bullswarm workflow draft show audit-repo to confirm.',
});

const workflowDraftStepSetText = rich({
  usage: 'bullswarm workflow draft step set <draft> <phase> <step-id> <field> --value <text> [--json]',
  purpose: 'Edit one field of an existing step in place, without removing and re-adding it.',
  args: [
    { name: '<draft>', desc: 'draft name' },
    { name: '<phase>', desc: 'phase containing the step' },
    { name: '<step-id>', desc: 'step to edit' },
    { name: '<field>', desc: 'step field name, e.g. prompt, lane, pool, onError' },
  ],
  options: [
    { flag: '--value <text>', desc: "the new value; JSON-decoded when it starts with [, {, \", or '", default: 'required; no default' },
    { flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' },
  ],
  safety: ["writes the draft's workflow.json and re-validates it"],
  examples: [{ cmd: 'bullswarm workflow draft step set audit-repo scan find-todos onError --value skip-phase' }],
  next: 'bullswarm workflow draft show audit-repo to confirm the change.',
});

const workflowDraftSetText = rich({
  usage: 'bullswarm workflow draft set <draft> <field> --value <text> [--json]',
  purpose: 'Edit one draft-level field (e.g. description, settings.concurrency) in place.',
  args: [{ name: '<draft>', desc: 'draft name' }, { name: '<field>', desc: 'draft field name' }],
  options: [
    { flag: '--value <text>', desc: "the new value; JSON-decoded when it starts with [, {, \", or '", default: 'required; no default' },
    { flag: '--json', desc: 'machine-readable confirmation with validation', default: 'human confirmation line' },
  ],
  safety: ["writes the draft's workflow.json and re-validates it"],
  examples: [{ cmd: 'bullswarm workflow draft set audit-repo description "Audit repo for TODOs"' }],
  next: 'bullswarm workflow draft show audit-repo to confirm.',
});

const workflowDraftValidateText = rich({
  usage: 'bullswarm workflow draft validate <name> [--json]',
  purpose: 'Validate a draft against the schema and live pool names, without running it '
    + '(alias behavior for workflow validate, scoped to drafts).',
  args: [{ name: '<name>', desc: 'draft name' }],
  options: [{ flag: '--json', desc: 'machine-readable {ok, issues|warnings}', default: 'human-readable pass/fail plus warnings' }],
  safety: ['read-only aside from live pool discovery; nothing is written'],
  examples: [{ cmd: 'bullswarm workflow draft validate audit-repo' }],
  next: 'bullswarm workflow draft run audit-repo once it validates.',
});

const workflowDraftExportText = rich({
  usage: 'bullswarm workflow draft export <name> <out-file> [--json]',
  purpose: "Write a draft's workflow.json to a standalone file, so it can be run with workflow "
    + 'run/validate outside the drafts directory, checked into version control, etc.',
  args: [{ name: '<name>', desc: 'draft name' }, { name: '<out-file>', desc: 'destination file path' }],
  options: [{ flag: '--json', desc: 'machine-readable confirmation with the written path', default: 'human confirmation line' }],
  safety: ['writes <out-file>; does not modify or delete the draft'],
  examples: [{ cmd: 'bullswarm workflow draft export audit-repo ./workflows/audit-repo.json' }],
  next: 'bullswarm workflow validate ./workflows/audit-repo.json to confirm the exported copy.',
});

const workflowDraftDeleteText = rich({
  usage: 'bullswarm workflow draft delete <name> --yes [--json]',
  purpose: 'Permanently delete a draft.',
  args: [{ name: '<name>', desc: 'draft name' }],
  options: [
    { flag: '--yes', desc: 'required — approves the deletion', default: 'none; the command refuses without it' },
    { flag: '--json', desc: 'machine-readable confirmation', default: 'human confirmation line' },
  ],
  safety: ['irreversible — deletes ~/.bullswarm/drafts/<name>/ from disk'],
  examples: [{ cmd: 'bullswarm workflow draft delete audit-repo --yes' }],
  next: 'bullswarm workflow draft list to confirm it is gone.',
});

const workflowDraftRunText = rich({
  usage: 'bullswarm workflow draft run <name> [--input k=v]... [--resume <shortId|runId>] [--json] [--quiet]',
  purpose: 'Run a draft the same way workflow run executes a workflow file — dispatching each '
    + 'step to a delegate pool.',
  args: [{ name: '<name>', desc: 'draft name' }],
  options: [
    { flag: '--input k=v', desc: 'declare or override a workflow input value (repeatable)', default: 'none' },
    { flag: '--resume <shortId|runId>', desc: 'resume a previous run of this draft instead of starting fresh', default: 'starts a new run' },
    { flag: '--json', desc: 'print the machine-readable report document', default: 'human-readable progress' },
    { flag: '--quiet', desc: 'suppress human progress output even without --json', default: 'off' },
  ],
  safety: [
    'dispatches real coding-agent CLI processes per step (same routing/spend as bullswarm run)',
    'writes durable workflow state under ~/.bullswarm/workflows/<runId>/',
    'the draft is re-validated against live pools immediately before running; an invalid draft is rejected and nothing runs',
  ],
  examples: [{ cmd: 'bullswarm workflow draft run audit-repo --input target=src/' }],
  next: 'bullswarm workflow runs show <shortId> to check progress.',
});

// --- HELP tree ----------------------------------------------------------------

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
  doctor: { _text: doctorText },
  version: { _text: versionText },
  release: { _text: releaseText },
  strategy: {
    _text: strategyText,
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
  workflow: {
    _text: workflowText,
    goal: { _text: workflowGoalText },
    run: { _text: workflowRunText },
    validate: { _text: workflowValidateText },
    list: { _text: workflowListText },
    capabilities: { _text: workflowCapabilitiesText },
    inspect: { _text: workflowInspectText },
    tui: { _text: workflowTuiText },
    watch: { _text: workflowWatchText },
    events: { _text: workflowEventsText },
    steer: { _text: workflowSteerText },
    action: {
      _text: workflowActionText,
      show: { _text: workflowActionShowText },
    },
    approval: {
      _text: workflowApprovalText,
      approve: { _text: workflowApprovalApproveText },
      reject: { _text: workflowApprovalRejectText },
    },
    runs: runsHelp(),
    draft: draftHelp(),
  },
};

// Top-level `runs` is a documented alias and gets the same nested help.
HELP.runs = HELP.workflow.runs;

export const HELP_PATHS = Object.freeze(collectPaths(HELP));

export function helpForArgs(argv) {
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
  if (!wantsHelp) return null;
  const tokens = argv[0] === 'help' ? argv.slice(1) : argv;
  let node = HELP;
  for (const token of tokens) {
    if (token === '--help' || token === '-h' || token.startsWith('-')) continue;
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

function draftHelp() {
  return {
    _text: workflowDraftText,
    create: { _text: workflowDraftCreateText },
    show: { _text: workflowDraftShowText },
    list: { _text: workflowDraftListText },
    phase: {
      _text: workflowDraftPhaseText,
      add: { _text: workflowDraftPhaseAddText },
      remove: { _text: workflowDraftPhaseRemoveText },
    },
    step: {
      _text: workflowDraftStepText,
      add: { _text: workflowDraftStepAddText },
      remove: { _text: workflowDraftStepRemoveText },
      set: { _text: workflowDraftStepSetText },
    },
    set: { _text: workflowDraftSetText },
    validate: { _text: workflowDraftValidateText },
    export: { _text: workflowDraftExportText },
    delete: { _text: workflowDraftDeleteText },
    run: { _text: workflowDraftRunText },
  };
}

function collectPaths(node, prefix = []) {
  const paths = prefix.length ? [prefix] : [[]];
  for (const [name, child] of Object.entries(node)) {
    if (name === '_text') continue;
    paths.push(...collectPaths(child, [...prefix, name]));
  }
  return paths;
}
