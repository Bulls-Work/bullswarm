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

// --- thin-leaf renderer ------------------------------------------------------
// Used for every other command today. These are candidates for the same
// rich bar in a follow-up pass; this pass only consolidates their existing
// text into this one tree so nothing is declared twice.

const leaf = (usage, body = '') => `Usage: ${usage}${body ? `\n\n${body}` : ''}`;

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
  health: { _text: leaf('bullswarm health [--json]', 'Re-judge saved outputs and report failed gates or quarantine clusters.') },
  pools: { _text: leaf('bullswarm pools [--force] [--json]', 'Show live meter, quota-surplus, burst-gate, and quarantine state.') },
  doctor: { _text: leaf('bullswarm doctor [--json]', 'Self-initialize if needed and report readiness without dispatching work.') },
  version: { _text: leaf('bullswarm version') },
  release: { _text: leaf('bullswarm release <patch|minor|major> [--dry-run]') },
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
    _text: leaf('bullswarm workflow <command> [options]',
      `Create, execute, observe, and audit durable multi-agent workflows.

Build and execute:
  goal <goal>        autonomously plan, execute, verify, and replan a goal
  run <workflow>     run an existing workflow file or saved draft
  draft ...          incrementally build a fixed workflow graph
  validate <target>  validate without executing
  inspect <target>   show the document, semantics, and validation details
  list               list available workflow definitions

Observe and control:
  runs               search ongoing and historical workflow instances
  tui [runId]        full-screen phase → agent → step/detail browser
  watch <runId>      follow low-noise progress until terminal
  events <runId>     replay durable events after a sequence cursor
  action show ...    inspect one action and all of its attempts
  steer <runId>      queue guidance for the next planner checkpoint
  approval ...       approve or reject a waiting decision gate

Execution fabric:
  capabilities       show pools, lanes, models, meters, and routing constraints

Common examples:
  bullswarm workflow goal "Audit this repository" --cwd=.
  bullswarm workflow runs --all --since=7d
  bullswarm workflow tui <shortId>
  bullswarm workflow draft --help

Run bullswarm workflow <command> --help for complete command options.`),
    goal: { _text: leaf('bullswarm workflow goal "<goal>" [--cwd <dir>] [--watch|--foreground] [--json] [planning options]',
      'Default: launch independently, print operating instructions, and return; --detach explicitly requests this default (rarely needed). --watch immediately follows low-noise progress until terminal. --foreground keeps execution terminal-owned. Use --resume <shortId|runId> to resume. Planning options include --orchestrator, --max-agents, --max-expansion-rounds, --max-actions, --max-items-per-expansion, --max-workflow-seconds, --concurrency, and --retry-attempts.') },
    run: { _text: leaf('bullswarm workflow run <file-or-name> [--input k=v]... [--resume <shortId|runId>] [--json] [--quiet]') },
    validate: { _text: leaf('bullswarm workflow validate <file-or-name>') },
    list: { _text: leaf('bullswarm workflow list [--json]') },
    capabilities: { _text: leaf('bullswarm workflow capabilities [--json]') },
    inspect: { _text: leaf('bullswarm workflow inspect <file-or-name>') },
    tui: { _text: leaf('bullswarm workflow tui [<runId>] [--json] [--all] [--show <runId>] [--cancel <runId>]',
      'Interactive mode opens a full-screen phase → agent → step/detail browser. Up/down selects, Enter drills in, Esc goes back, q detaches without stopping work, and c requests explicit cancellation confirmation.') },
    watch: { _text: leaf('bullswarm workflow watch <runId> [--interval <seconds>] [--heartbeat <seconds>] [--jsonl] [--once] [--verbose]', 'Human output is compact by default; --verbose preserves per-agent action details.') },
    events: { _text: leaf('bullswarm workflow events <runId> [--after <sequence>] [--json]') },
    steer: { _text: leaf('bullswarm workflow steer <runId> --message <guidance> [--json]') },
    action: {
      _text: leaf('bullswarm workflow action <command> ...', 'Commands: show.'),
      show: { _text: leaf('bullswarm workflow action show <runId> <actionId> [--json]') },
    },
    approval: {
      _text: leaf('bullswarm workflow approval <approve|reject> <runId> [--json]'),
      approve: { _text: leaf('bullswarm workflow approval approve <runId> [--json]') },
      reject: { _text: leaf('bullswarm workflow approval reject <runId> [--json]') },
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
    _text: leaf('bullswarm workflow runs [list] [--all|--historical] [--name <workflow>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
      `Commands: show <shortId|runId> [--json], result <shortId|runId> [--json], delete <shortId|runId> --yes [--force] [--json].
Time filters compare the workflow initiation timestamp (startedAt): --since/--from/--started-after (inclusive lower bound) and --until/--to/--started-before (exclusive upper bound). Values accept ISO timestamps, local dates, today/yesterday/tomorrow/now, or relative durations such as 30m, 24h, 7d, and 2w.`),
    list: { _text: leaf('bullswarm workflow runs list [--all|--historical] [--name <workflow>] [--since <time>] [--until <time>] [--limit <n>] [--json]') },
    show: { _text: leaf('bullswarm workflow runs show <shortId|runId> [--json]') },
    result: { _text: leaf('bullswarm workflow runs result <shortId|runId> [--json]',
      'Return the stable caller-facing delivery, verification verdict, progress, and usage envelope.') },
    delete: { _text: leaf('bullswarm workflow runs delete <shortId|runId> --yes [--force] [--json]') },
  };
}

function draftHelp() {
  return {
    _text: leaf('bullswarm workflow draft <command> [options]',
      `Commands:
  create <name> [--description <text>] [--input k=v]... [--required <keys>] [--json]
  show <name> [--json]
  list [--json]
  phase add <name> <phase> [--json]
  phase remove <name> <phase> [--json]
  step add <name> <phase> <step-id> [--type run|fanout|verify|decide] [--lane <lane>]
    [--pool <pool>] [--prompt <text>] [--task-file <path>] [--add-dir <dir>]
    [--items-from <path>] [--review <path>] [--concurrency N] [--timeout N]
    [--on-error continue|fail|skip-phase] [--step-template <json>] [--input k=v]...
  step remove <name> <phase> <step-id> [--json]
  step set <name> <phase> <step-id> <field> --value <text> [--json]
  set <name> <field> --value <text> [--json]
  validate <name> [--json]
  export <name> <out-file> [--json]
  delete <name> --yes [--json]
  run <name> [--input k=v]... [--resume <shortId|runId>] [--json] [--quiet]`),
    create: { _text: leaf('bullswarm workflow draft create <name> [--description <text>] [--input k=v]... [--required <keys>] [--json]') },
    show: { _text: leaf('bullswarm workflow draft show <name> [--json]') },
    list: { _text: leaf('bullswarm workflow draft list [--json]') },
    phase: {
      _text: leaf('bullswarm workflow draft phase <add|remove> <draft> <phase> [--json]'),
      add: { _text: leaf('bullswarm workflow draft phase add <draft> <phase> [--json]') },
      remove: { _text: leaf('bullswarm workflow draft phase remove <draft> <phase> [--json]') },
    },
    step: {
      _text: leaf('bullswarm workflow draft step <add|remove|set> <draft> <phase> <step-id> [options]'),
      add: { _text: leaf('bullswarm workflow draft step add <draft> <phase> <step-id> [--type <run|fanout|verify|decide>] [--lane <lane>] [--prompt <text>] [step options]') },
      remove: { _text: leaf('bullswarm workflow draft step remove <draft> <phase> <step-id> [--json]') },
      set: { _text: leaf('bullswarm workflow draft step set <draft> <phase> <step-id> <field> --value <text> [--json]') },
    },
    set: { _text: leaf('bullswarm workflow draft set <draft> <field> --value <text> [--json]') },
    validate: { _text: leaf('bullswarm workflow draft validate <name> [--json]') },
    export: { _text: leaf('bullswarm workflow draft export <name> <out-file> [--json]') },
    delete: { _text: leaf('bullswarm workflow draft delete <name> --yes [--json]') },
    run: { _text: leaf('bullswarm workflow draft run <name> [--input k=v]... [--resume <shortId|runId>] [--json] [--quiet]') },
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
