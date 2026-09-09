// Central unknown-flag rejection for every command path.
//
// Before 0.27.1 each parser accepted any `--flag` it did not recognize and
// silently dropped it, so `pools --bogus-flag` and
// `workflow goal "..." --porgram plan.json` both exited 0 — the second one
// launching a run the caller never asked for. Every dispatcher now declares
// the flags its command actually reads and routes them through
// unknownFlagExit() below, which prints one line per unknown flag plus the
// command's canonical usage line and returns exit code 2.
//
// KNOWN_FLAGS is keyed by help path (the same paths src/help.js exposes as
// HELP_PATHS), so tests/unknown-flags.test.js can assert both directions of
// the help/parser contract: every flag a command's Options block advertises
// must be accepted, and every accepted flag must either appear in that
// command's help text or be listed in UNDOCUMENTED_FLAGS with a reason.
import { usageLine } from '../help.js';

// Accepted everywhere: `--help` is resolved before dispatch, but several
// parsers still read opts.help on their own path.
const UNIVERSAL = ['help'];

// Flags a command reads but deliberately does not document, with the reason.
// Two kinds only:
//   internal — a detached-launch handshake flag no operator should type
//   refused  — recognized purely so the command can explain why it does not
//              apply here, instead of answering "unknown flag"
export const UNDOCUMENTED_FLAGS = Object.freeze({
  // Bare `bullswarm` dispatches to cmdSetup(), so it accepts setup's options.
  // The root help says so in the --yes description rather than repeating all
  // six labels at the top level.
  '': ['wizard', 'strategy', 'integrate', 'agents', 'json'],
  // The detached kernel re-invokes `workflow goal` with these three.
  'workflow goal': ['request', 'run-id', 'quiet', 'planner'],
  // `--planner` was removed in 0.27.0; the planning commands still recognize
  // it (and the dispatched-planner flags) so they can say what to use instead.
  'workflow plan contract': [
    'planner', 'orchestrator', 'orchestrator-model', 'orchestrator-strict',
    'strict-orchestrator', 'suggested-plan', 'planner-reasoning', 'program',
    'resume', 'request',
  ],
  'workflow plan validate': [
    'planner', 'orchestrator', 'orchestrator-model', 'orchestrator-strict',
    'strict-orchestrator', 'suggested-plan', 'planner-reasoning',
    'resume', 'request',
  ],
  // A resumed run keeps its durable planner mode and routing; these are
  // recognized so the refusal names the submit command to use instead.
  'workflow resume': [
    'program', 'orchestrator', 'strict-orchestrator', 'scout',
    'suggested-plan', 'isolation',
  ],
});

// Every flag each command path accepts, without the leading `--`.
// A command absent from this table is not flag-checked (its dispatcher owns
// the decision), so adding a command means adding its row here.
const TABLE = {
  // --- src/cli.js ---------------------------------------------------------
  // Bare `bullswarm` dispatches to cmdSetup(), so it accepts setup's flags.
  '': ['wizard', 'yes', 'strategy', 'integrate', 'agents', 'json'],
  setup: ['wizard', 'yes', 'strategy', 'integrate', 'agents', 'json'],
  run: [
    'lane', 'add-dir', 'task-file', 'prompt', 'effort', 'reasoning', 'timeout',
    'heartbeat', 'dry-run', 'json', 'no-caller',
  ],
  health: ['json'],
  pools: ['force', 'json'],
  assignments: ['json'],
  doctor: ['json'],
  version: [],
  release: ['dry-run'],

  // --- src/integrate.js ---------------------------------------------------
  integrate: ['agents', 'json'],
  'integrate status': ['agents', 'json'],
  'integrate install': ['agents', 'yes', 'json'],
  'integrate remove': ['agents', 'yes', 'json'],
  'integrate retire-legacy': ['yes', 'json'],

  // --- src/strategy-cli.js ------------------------------------------------
  strategy: ['json'],
  'strategy tui': [],
  'strategy inventory': ['json', 'refresh'],
  'strategy routes': ['json', 'refresh'],
  'strategy set-provider': ['yes'],
  'strategy set-model': ['tiers', 'yes'],
  'strategy reset-tier': ['yes'],
  'strategy set-reasoning': ['tier', 'level', 'pool', 'yes'],
  'strategy reset-reasoning': ['tier', 'pool', 'yes'],
  'strategy rungs': ['json', 'pool'],
  'strategy set-rung': ['model', 'reasoning', 'force'],
  'strategy configure': ['file', 'yes'],
  'strategy refresh': ['json', 'apply', 'yes', 'refresh-hours'],
  'strategy recommend': ['json', 'apply', 'yes', 'refresh-hours'],
  'strategy apply': ['yes', 'refresh-hours'],
  'strategy show': ['json'],
  'strategy assign': ['pool', 'model'],
  'strategy clear-assignment': [],
  'strategy exclude-model': [],
  'strategy include-model': [],
  'strategy set-subscription': ['plan', 'monthly-usd', 'included-usd', 'quota-window'],
  'strategy auto': ['yes'],
  'strategy auto status': [],
  'strategy auto off': ['yes'],

  // --- src/workflow/cli.js ------------------------------------------------
  workflow: [],
  'workflow goal': [
    'cwd', 'isolation', 'watch', 'foreground', 'json', 'program', 'summary',
    'scout', 'no-scout', 'orchestrator', 'orchestrator-model',
    'orchestrator-strict', 'strict-orchestrator', 'suggested-plan',
    'worker-pool', 'worker-model', 'worker-reasoning', 'planner-reasoning',
    'max-agents', 'max-expansion-rounds', 'max-actions', 'concurrency',
    'retry-attempts', 'resume', 'detach',
  ],
  'workflow plan': [],
  'workflow plan contract': [
    'cwd', 'isolation', 'json', 'scout', 'worker-pool', 'worker-model',
    'worker-reasoning', 'max-agents', 'max-actions', 'max-expansion-rounds',
    'concurrency', 'retry-attempts',
  ],
  'workflow plan validate': [
    'program', 'cwd', 'summary', 'json', 'isolation', 'scout', 'worker-pool',
    'worker-model', 'worker-reasoning', 'max-agents', 'max-actions',
    'max-expansion-rounds', 'concurrency', 'retry-attempts',
  ],
  'workflow plan show': ['json'],
  'workflow plan submit': [
    'program', 'exhausted', 'reason', 'summary', 'foreground', 'watch', 'json',
  ],
  'workflow capabilities': ['json'],
  'workflow tui': ['json', 'all', 'show', 'cancel'],
  'workflow watch': [
    'classic', 'interval', 'heartbeat', 'stall-after', 'next', 'after',
    'since', 'jsonl', 'once', 'verbose',
  ],
  'workflow events': ['after', 'json'],
  'workflow steer': ['message', 'json'],
  'workflow cancel': ['json'],
  'workflow resume': ['foreground', 'watch', 'json'],
  'workflow action': [],
  'workflow action show': ['json'],

  // --- src/workflow/runs-cli.js -------------------------------------------
  // --from/--started-after and --to/--started-before are documented in the
  // --since/--until option descriptions rather than as their own labels.
  'workflow runs': [
    'all', 'historical', 'name', 'since', 'started-after', 'from', 'until',
    'started-before', 'to', 'limit', 'json',
  ],
  'workflow runs list': [
    'all', 'historical', 'name', 'since', 'started-after', 'from', 'until',
    'started-before', 'to', 'limit', 'json',
  ],
  'workflow runs show': ['json'],
  'workflow runs result': ['json', 'summary'],
  'workflow runs delete': ['yes', 'force', 'json'],
};

// The top-level `runs` alias routes into the same parser as `workflow runs`.
for (const [key, flags] of Object.entries(TABLE)) {
  if (key === 'workflow runs' || key.startsWith('workflow runs ')) {
    TABLE[key.replace('workflow ', '')] = flags;
  }
}

export const KNOWN_FLAGS = Object.freeze(Object.fromEntries(
  Object.entries(TABLE).map(([key, flags]) => [
    key,
    Object.freeze([...new Set([...flags, ...(UNDOCUMENTED_FLAGS[key] ?? []), ...UNIVERSAL])]),
  ]),
));

export function knownFlags(path) {
  return KNOWN_FLAGS[pathKey(path)] ?? null;
}

function pathKey(path) {
  return Array.isArray(path) ? path.join(' ') : String(path);
}

// A token is flag-shaped only when it starts with `--` followed by a letter:
// a bare `--`, `--5`, or a negative number keeps whatever meaning the parser
// already gave it rather than becoming a new error class.
export function flagName(token) {
  if (typeof token !== 'string' || !/^--[A-Za-z]/.test(token)) return null;
  const eq = token.indexOf('=');
  return token.slice(2, eq > 0 ? eq : undefined);
}

// Collect the flag names a raw argv carries, in first-seen order.
export function flagNames(argv) {
  const seen = [];
  for (const token of argv) {
    const name = flagName(token);
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

// THE central check. `names` is what the caller typed (from flagNames() or a
// parser's own record), `path` is the help path whose usage line explains the
// command. Returns 2 after printing, or null when every flag is known.
export function unknownFlagExit(names, path, { error = console.error } = {}) {
  const known = knownFlags(path);
  if (!known || !names?.length) return null;
  const unknown = names.filter((name) => !known.includes(name));
  if (!unknown.length) return null;
  for (const name of unknown) error(`✗ unknown flag --${name}`);
  error(`usage: ${usageLine(path)}`);
  return 2;
}
