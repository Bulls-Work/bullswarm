// The `bullswarm workflow` flag grammar: parse argv into options, report a
// verb's flag errors, and name the help node whose usage line a verb prints.

import { usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';

// The help path whose usage line explains this workflow verb. Returns null
// for a verb with no help node — the dispatcher's default branch already
// answers those with guidance and exit 2.
export function workflowHelpPath(sub, opts) {
  if (!sub) return ['workflow'];
  if (sub === 'action') return opts.rest[0] === 'show' ? ['workflow', 'action', 'show'] : ['workflow', 'action'];
  if (sub === 'task') return opts.rest[0] === 'show' ? ['workflow', 'task', 'show'] : ['workflow', 'task'];
  if (sub === 'step') return ['restart', 'rerun', 'accept'].includes(opts.rest[0]) ? ['workflow', 'step', opts.rest[0]] : ['workflow', 'step'];
  const LEAVES = ['goal', 'cancel', 'pause', 'resume', 'capabilities', 'tui', 'events', 'watch', 'steer', 'reindex', 'reprice', 'continue', 'add', 'wait'];
  return LEAVES.includes(sub) ? ['workflow', sub] : null;
}

export function parseFlags(argv) {
  const out = { inputs: {}, rest: [], flags: [] };
  const valueFlags = new Set([
    'resume', 'after', 'cwd', 'orchestrator', 'strict-orchestrator', 'orchestrator-model',
    'worker-pool', 'worker-model', 'worker-reasoning', 'planner-reasoning', 'request', 'run-id',
    'suggested-plan', 'planner', 'program', 'summary', 'reason',
    'max-agents', 'max-expansion-rounds', 'max-actions', 'concurrency',
    'retry-attempts', 'interval', 'heartbeat', 'stall-after', 'since', 'message',
    'out', 'rerun', 'base-revision', 'wait', 'width', 'height', 'until', 'pool',
    'avoid', 'requirement', 'rounds', 'steps', 'from-answer', 'timeout',
  ]);
  // Repeatable value flags collect every value (step rerun --avoid, step
  // accept --requirement).
  const listFlags = new Set(['avoid', 'requirement']);
  const assign = (key, value) => {
    if (listFlags.has(key)) out[key] = [...(out[key] ?? []), value];
    else out[key] = value;
  };
  // A value flag with no value (end of argv, or the next token is another
  // flag) is a usage error, never a silent default: a bare --program must not
  // launch a dispatched-planner run.
  const errors = [];
  const missingValue = (i) => argv[i + 1] === undefined || /^--./.test(argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Record every flag-shaped token exactly as typed so the unknown-flag
    // gate sees `--porgram`, not the normalized key this switch produces.
    const name = flagName(a);
    if (name && !out.flags.includes(name)) out.flags.push(name);
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--no-scout') out.noScout = true;
    else if (a === '--resume' || a === '--after' || a === '--input') {
      if (missingValue(i)) { errors.push(`${a} requires a value`); continue; }
      if (a === '--resume') { out.resume = argv[++i]; continue; }
      if (a === '--after') { out.after = argv[++i]; continue; }
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const key = kv.slice(0, eq);
        const raw = kv.slice(eq + 1);
        // Accept JSON for non-string values: --input items='["a","b"]' or
        // --input count=3. Falls back to the raw string on parse failure
        // so a literal value with a colon doesn't silently lose data.
        let v = raw;
        if (raw.length && '[{"\''.includes(raw[0])) {
          try { v = JSON.parse(raw); } catch { v = raw; }
        }
        out.inputs[key] = v;
      }
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq > 0 ? eq : undefined);
      if (eq > 0) assign(key, a.slice(eq + 1));
      else if (valueFlags.has(key)) {
        if (missingValue(i)) errors.push(`--${key} requires a value`);
        else assign(key, argv[++i]);
      } else out[key] = true;
    } else out.rest.push(a);
  }
  if (errors.length) out.errors = errors;
  return out;
}

// Report flag-parsing errors for one command and return its exit code, or
// null when the flags parsed cleanly.
export function flagErrors(opts, path) {
  const unknown = unknownFlagExit(opts.flags, path);
  if (unknown !== null) return unknown;
  if (!opts.errors?.length) return null;
  for (const error of opts.errors) console.error(`✗ ${error}`);
  console.error(`usage: ${usageLine(path)}`);
  return 2;
}
