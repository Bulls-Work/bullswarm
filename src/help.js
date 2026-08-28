// Central CLI help tree. Help is resolved before setup or command dispatch so
// `--help` is side-effect free even for commands that normally touch state.

const top = `Usage: bullswarm <command> [options]

Route bounded work across coding-agent subscriptions and verify the result.

Commands:
  setup        discover and configure installed coding agents
  integrate    register Bullswarm guidance with Codex, Claude, and Grok
  run          dispatch one bounded task
  health       re-judge saved delegate outputs
  pools        show routing pools, meters, and quarantine state
  strategy     discover models and manage tier assignments
  doctor       report installation readiness
  workflow     create, execute, observe, and audit workflows
  runs         alias for workflow runs
  version      print the installed version
  release      create a version commit and tag

Run bullswarm <command> --help for command-specific help.`;

const leaf = (usage, body = '') => `Usage: ${usage}${body ? `\n\n${body}` : ''}`;

const HELP = {
  _text: top,
  setup: { _text: leaf('bullswarm setup [--yes] [--integrate] [--agents <list>] [--json]',
    'Discover installed agent CLIs and initialize routing. Without --yes on a TTY, opens the interactive wizard.') },
  integrate: {
    _text: leaf('bullswarm integrate <status|install|remove|retire-legacy> [options]',
      'Manage the canonical Bullswarm skill and recursion-safe global awareness rules.'),
    status: { _text: leaf('bullswarm integrate status [--agents codex,claude,grok] [--json]') },
    install: { _text: leaf('bullswarm integrate install [--agents codex,claude,grok] --yes [--json]') },
    remove: { _text: leaf('bullswarm integrate remove [--agents codex,claude,grok] --yes [--json]') },
    'retire-legacy': { _text: leaf('bullswarm integrate retire-legacy --yes [--json]',
      'Recoverably archive the retired Claude offload skill.') },
  },
  run: { _text: leaf('bullswarm run --lane <analyze|build|chore> --add-dir <dir> (--task-file <file> | --prompt <text> | <task text...>) [options]',
    'Options: --effort <high|medium|low>, --timeout <seconds>, --json. Routes one task and verifies its content.') },
  health: { _text: leaf('bullswarm health [--json]', 'Re-judge saved outputs and report failed gates or quarantine clusters.') },
  pools: { _text: leaf('bullswarm pools [--force] [--json]', 'Show live meter, quota-surplus, burst-gate, and quarantine state.') },
  doctor: { _text: leaf('bullswarm doctor [--json]', 'Self-initialize if needed and report readiness without dispatching work.') },
  version: { _text: leaf('bullswarm version') },
  release: { _text: leaf('bullswarm release <patch|minor|major> [--dry-run]') },
  strategy: {
    _text: leaf('bullswarm strategy <command> [options]',
      'Commands: refresh, apply, show, assign, clear-assignment, exclude-model, include-model, set-subscription, auto.'),
    refresh: { _text: leaf('bullswarm strategy refresh [--json] [--apply --yes] [--refresh-hours <n>]') },
    recommend: { _text: leaf('bullswarm strategy recommend [--json] [--apply --yes]', 'Alias for strategy refresh.') },
    apply: { _text: leaf('bullswarm strategy apply --yes [--refresh-hours <n>]') },
    show: { _text: leaf('bullswarm strategy show [--json]') },
    assign: { _text: leaf('bullswarm strategy assign <high|medium|low> --pool <pool> --model <model>') },
    'clear-assignment': { _text: leaf('bullswarm strategy clear-assignment <high|medium|low>') },
    'exclude-model': { _text: leaf('bullswarm strategy exclude-model <model>', 'Persistently prevent this exact model from orchestration and worker dispatches.') },
    'include-model': { _text: leaf('bullswarm strategy include-model <model>', 'Remove a persisted model exclusion.') },
    'set-subscription': { _text: leaf('bullswarm strategy set-subscription <pool> [--plan <name>] [--monthly-usd <n|unknown>] [--included-usd <n|unknown>] [--quota-window <name>]') },
    auto: {
      _text: leaf('bullswarm strategy auto <status|off> [--yes]'),
      status: { _text: leaf('bullswarm strategy auto status') },
      off: { _text: leaf('bullswarm strategy auto off --yes') },
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
      'Default: launch independently, print operating instructions, and return. --watch immediately follows low-noise progress until terminal. --foreground keeps execution terminal-owned. Use --resume <shortId|runId> to resume. Planning options include --orchestrator, --max-agents, --max-expansion-rounds, --max-actions, --max-items-per-expansion, --max-workflow-seconds, --concurrency, and --retry-attempts.') },
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

function runsHelp() {
  return {
    _text: leaf('bullswarm workflow runs [list] [--all|--historical] [--name <workflow>] [--since <time>] [--until <time>] [--limit <n>] [--json]',
      'Commands: show <id>, result <id>, delete <id> --yes. Time filters use the workflow initiation timestamp.'),
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
      'Commands: create, show, list, phase, step, set, validate, export, delete, run.'),
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
