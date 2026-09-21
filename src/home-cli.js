// bullswarm home — safe, selective copies of a Bullswarm home.
//
// `home prune` and `home status` are the retention surface: what would go,
// what went, and what background work (prune, the reprice reconciler) last did.
//
// A snapshot is intentionally assembled from the small, durable surfaces the
// dashboard reads.  The live home is never modified: the copied history index
// is cleared and rebuilt against the selected workflow directories only.

import {
  cpSync, existsSync, mkdirSync, readdirSync, statSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { flagName, knownFlags, unknownFlagExit } from './lib/cli-flags.js';
import {
  formatBytes, pruneHome, readMaintenanceResults, readRetentionPolicy,
  recordPrune, runRetentionSweep, planRetention, WINDOW_REASON,
} from './lib/retention.js';
import { helpText, usageLine } from './help.js';
import { listRuns, resolveRunId } from './workflow/short-id.js';
import { cmdReindex } from './workflow/runs-cli.js';

const VALUE_FLAGS = new Set(['runs', 'recent', 'since', 'days', 'trigger']);
const BOOLEAN_FLAGS = new Set(['no-streams', 'json', 'dry-run', 'yes', 'auto']);
// The central table (src/lib/cli-flags.js) is authoritative when it has a row
// for the command; these are the flags home reads for the commands below.
const OWN_FLAGS = {
  'home prune': ['dry-run', 'yes', 'days', 'auto', 'trigger', 'json'],
  'home status': ['json'],
};
const COPY_FILES = ['state.json', 'routing.json', 'providers.json'];
const COPY_DIRS = [
  // assignments/ and runs/ are the single-task surfaces used by Runs/Home.
  'assignments',
  'runs',
  'meters',
  'connectors',
  'providers',
  'calibration',
];

function defaultHome() {
  const configured = process.env.BULLSWARM_HOME?.trim();
  return configured && configured.length ? configured : join(homedir(), '.bullswarm');
}

function pushFlag(out, name) {
  if (name && !out._flags.includes(name)) out._flags.push(name);
}

function parseSnapshotFlags(argv) {
  const out = { _flags: [], _values: {}, _positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const name = flagName(token);
    if (!name) {
      out._positional.push(token);
      continue;
    }
    pushFlag(out, name);
    const equals = token.indexOf('=');
    const inline = equals > 0 ? token.slice(equals + 1) : undefined;
    if (BOOLEAN_FLAGS.has(name)) {
      out[name] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = inline !== undefined
        ? inline
        : flagName(argv[i + 1]) ? undefined : argv[++i];
      out._values[name] = value;
      out[name] = value;
      continue;
    }
    // Leave unknown flags in the raw flag list for the central guard.  Do not
    // consume a following token: the usage error should still identify the
    // caller's positional destination when one was supplied.
    out[name] = inline !== undefined ? inline : true;
  }
  return out;
}

function finiteMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sinceMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('--since requires a date or time');
  const duration = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(raw);
  if (duration) {
    const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return now - Number(duration[1]) * units[duration[2].toLowerCase()];
  }
  // Date-only bounds mean local midnight, which is what the workflow runs
  // command uses for its calendar-date form.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (date.getFullYear() !== Number(year)
      || date.getMonth() !== Number(month) - 1
      || date.getDate() !== Number(day)) {
      throw new Error(`--since has an invalid calendar date: "${raw}"`);
    }
    return date.getTime();
  }
  const parsed = finiteMs(raw);
  if (parsed == null) throw new Error(`--since has an invalid time: "${raw}"`);
  return parsed;
}

function runStartedAt(run) {
  return run?.state?.lifecycle?.startedAt
    ?? run?.state?.startedAt
    ?? run?.report?.startedAt
    ?? null;
}

function runTime(run) {
  const value = finiteMs(runStartedAt(run));
  return value == null ? -Infinity : value;
}

function sortedNewest(runs) {
  return [...runs].sort((a, b) => runTime(b) - runTime(a) || a.runId.localeCompare(b.runId));
}

function runSummary(run) {
  return {
    runId: run.runId,
    shortId: run.shortId ?? null,
    legacy: Boolean(run.legacy),
    startedAt: runStartedAt(run),
    finishedAt: run?.state?.lifecycle?.finishedAt ?? run?.state?.finishedAt ?? run?.report?.finishedAt ?? null,
    status: run?.state?.lifecycle?.status ?? run?.state?.status ?? null,
    ongoing: Boolean(run.ongoing),
  };
}

function selectRuns(source, { runs = null, recent = 3, since = null } = {}) {
  const all = listRuns(source);
  const bound = since == null ? null : sinceMs(since);
  const inRange = (run) => bound == null || runTime(run) >= bound;
  let selected;
  if (runs != null) {
    const tokens = String(runs).split(',').map((token) => token.trim()).filter(Boolean);
    if (!tokens.length) throw new Error('--runs needs at least one shortId or runId');
    const seen = new Set();
    selected = [];
    for (const token of tokens) {
      const resolved = resolveRunId(source, token);
      if (!resolved) throw new Error(`no run found for "${token}"`);
      if (seen.has(resolved.runId)) continue;
      const found = all.find((run) => run.runId === resolved.runId);
      if (!found) throw new Error(`no run found for "${token}"`);
      if (inRange(found)) selected.push(found);
      seen.add(resolved.runId);
    }
  } else {
    selected = sortedNewest(all.filter(inRange)).slice(0, recent);
  }
  return sortedNewest(selected);
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realOrResolved(path) {
  const absolute = resolve(path);
  let probe = absolute;
  const suffix = [];
  while (true) {
    try {
      return join(realpathSync(probe), ...suffix.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}

function assertDestinationAllowed(source, destination) {
  const sourcePath = realOrResolved(source);
  const destinationPath = realOrResolved(destination);
  const protectedHomes = [sourcePath, realOrResolved(join(homedir(), '.bullswarm'))];
  for (const protectedHome of protectedHomes) {
    if (isWithin(destinationPath, protectedHome)) {
      throw new Error(`refusing snapshot destination inside live Bullswarm home: ${destinationPath}`);
    }
  }
}

function copyTree(source, destination, { noStreams = false } = {}) {
  if (!existsSync(source)) return false;
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (entry) => {
      if (!noStreams) return true;
      const name = basename(entry);
      return !(name.startsWith('stream-') && name.endsWith('.jsonl'))
        && !(name.startsWith('stdout-') && name.endsWith('.log'));
    },
  });
  return true;
}

function copyFileIfPresent(source, destination) {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: false, errorOnExist: false });
  return true;
}

function clearHistoryIndex(destination) {
  const history = join(destination, 'history');
  mkdirSync(history, { recursive: true });
  // The copied index can contain runs omitted by this snapshot. Reindex writes
  // a fresh idempotent index from the selected workflow directories.
  writeFileSync(join(history, 'runs.jsonl'), '');
}

function directoryBytes(root) {
  let total = 0;
  const visit = (path) => {
    let entry;
    try { entry = statSync(path); } catch { return; }
    if (entry.isDirectory()) {
      let names = [];
      try { names = readdirSync(path); } catch { return; }
      for (const name of names) visit(join(path, name));
    } else if (entry.isFile()) {
      total += entry.size;
    }
  };
  visit(root);
  return total;
}

function ensureEmptyDestination(destination) {
  if (!existsSync(destination)) {
    mkdirSync(destination, { recursive: true });
    return;
  }
  let entries;
  try { entries = readdirSync(destination); } catch (error) { throw new Error(`cannot read destination: ${error.message}`); }
  if (entries.length) throw new Error(`destination is not empty: ${destination}`);
}

/**
 * Create a selective, dashboard-readable copy of a Bullswarm home.
 *
 * @param {string} destination
 * @param {{source?: string, runs?: string|null, recent?: number, since?: string|null, noStreams?: boolean}} options
 */
export function snapshotHome(destination, {
  source = defaultHome(), runs = null, recent = 3, since = null, noStreams = false,
} = {}) {
  if (!destination || !String(destination).trim()) throw new Error('snapshot destination is required');
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (!existsSync(sourcePath)) throw new Error(`Bullswarm home does not exist: ${sourcePath}`);
  assertDestinationAllowed(sourcePath, destinationPath);
  const selected = selectRuns(sourcePath, { runs, recent, since });
  ensureEmptyDestination(destinationPath);

  for (const file of COPY_FILES) copyFileIfPresent(join(sourcePath, file), join(destinationPath, file));
  for (const dir of COPY_DIRS) copyTree(join(sourcePath, dir), join(destinationPath, dir), { noStreams });
  // Always create the surfaces the dashboard/reindex path expects, even when
  // the source home has no records of that kind yet.
  mkdirSync(join(destinationPath, 'workflows'), { recursive: true });
  mkdirSync(join(destinationPath, 'history'), { recursive: true });
  for (const run of selected) {
    copyTree(run.runDir, join(destinationPath, 'workflows', run.runId), { noStreams });
  }

  clearHistoryIndex(destinationPath);
  const reindexExit = cmdReindex(['--json', '--force'], { bullswarmDir: destinationPath, silent: true });
  if (reindexExit !== 0) throw new Error(`snapshot history reindex failed (exit ${reindexExit})`);

  // A copied home is a deliberately finite catalogue.  The dashboard keeps
  // historical runs behind --all for ordinary homes, so mark snapshots after
  // the copy is complete and let non-interactive JSON inspection include the
  // exact selected slice by default.
  writeFileSync(join(destinationPath, '.snapshot.json'), `${JSON.stringify({
    kind: 'bullswarm-home-snapshot',
    version: 1,
    runIds: selected.map((run) => run.runId),
  }, null, 2)}\n`);

  const bytes = directoryBytes(destinationPath);
  const summaries = selected.map(runSummary);
  return {
    ok: true,
    source: sourcePath,
    destination: destinationPath,
    noStreams: Boolean(noStreams),
    selection: runs != null ? 'runs' : 'recent',
    recent: runs == null ? recent : null,
    since: since ?? null,
    count: summaries.length,
    runCount: summaries.length,
    runIds: summaries.map((run) => run.runId),
    runs: summaries,
    sizeBytes: bytes,
    bytes,
    size: formatBytes(bytes),
    historyIndex: join(destinationPath, 'history', 'runs.jsonl'),
  };
}

function typedErrors(opts) {
  const problems = [];
  for (const [name, value] of Object.entries(opts._values)) {
    if (value == null || value === '') problems.push(`--${name} requires a value`);
  }
  if (opts.recent != null && opts.recent !== '') {
    const count = Number(opts.recent);
    if (!Number.isInteger(count) || count < 1) problems.push(`--recent must be a positive integer (got "${opts.recent}")`);
  }
  return problems;
}

function checkFlags(opts, path) {
  const central = unknownFlagExit(opts._flags, path);
  if (central !== null) return central;
  // Until the central table carries a row for the command, home enforces its own.
  if (knownFlags(path)) return null;
  const allowed = OWN_FLAGS[path.join(' ')];
  if (!allowed) return null;
  const unknown = opts._flags.filter((name) => !allowed.includes(name) && name !== 'help');
  if (!unknown.length) return null;
  for (const name of unknown) console.error(`✗ unknown flag --${name}`);
  console.error(`usage: ${usageLine(path)}`);
  return 2;
}

function ago(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 2880) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function printPrune(report) {
  const days = report.policyDays;
  const head = report.apply ? '✓ pruned' : '✓ dry run';
  console.log(`${head} · workspaces of runs finished before ${report.cutoff} (${days}-day limit) · ${report.line}`);
  if (!report.policy.enabled) {
    const why = report.policy.invalid.length ? `invalid (${report.policy.invalid.join('; ')})` : 'disabled';
    console.log(`  note: automatic retention is ${why}; this command still applies the limit when asked`);
  }
  for (const run of report.candidates) {
    console.log(`  - ${run.shortId ?? '------'} ${run.runId} ${run.status} · finished ${run.ageDays}d ago · ${plural(run.workspaces.length, 'workspace')} · ${formatBytes(run.bytes)}`);
    for (const workspace of run.workspaces) console.log(`      ${workspace.path}  ${workspace.kind}  ${formatBytes(workspace.bytes)}`);
  }
  const kept = [...report.skipped, ...report.skippedAtApply];
  // Runs still inside the window are the routine case: one count, not a row each.
  const routine = kept.filter((item) => item.reason === WINDOW_REASON);
  const notable = kept.filter((item) => item.reason !== WINDOW_REASON);
  if (routine.length) console.log(`  kept: ${plural(routine.length, 'run')} with workspaces still inside the ${days}-day limit`);
  if (notable.length) {
    console.log(`  kept: ${plural(notable.length, 'run')} left alone`);
    for (const item of notable) console.log(`      ${item.runId} — ${item.reason}`);
  }
  for (const failure of report.failures) console.log(`  ✗ ${failure.runId}/${failure.workspace}: ${failure.error}`);
  console.log('  never touched: state, results, reports, events, streams, task/out/diff files, history');
  if (!report.apply && report.candidateWorkspaces) console.log('  re-run with --yes to remove these workspaces');
}

function cmdPrune(tail, bullswarmDir) {
  const opts = parseSnapshotFlags(tail);
  const flagExit = checkFlags(opts, ['home', 'prune']);
  if (flagExit !== null) return flagExit;
  const problems = typedErrors(opts);
  let days = null;
  if (opts.days != null && opts.days !== '') {
    days = Number(opts.days);
    if (!Number.isFinite(days) || days <= 0) problems.push(`--days must be a number greater than 0 (got "${opts.days}")`);
  }
  if (opts._positional.length) problems.push(`unexpected argument "${opts._positional[0]}"`);
  if (opts['dry-run'] && opts.yes) problems.push('--dry-run and --yes cannot be combined');
  if (opts.auto && (opts['dry-run'] || opts.yes || days != null)) problems.push('--auto takes only the configured policy; it cannot be combined with --dry-run, --yes or --days');
  if (opts.trigger != null && !opts.auto) problems.push('--trigger only goes with --auto');
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`usage: ${usageLine(['home', 'prune'])}`);
    return 2;
  }
  try {
    if (opts.auto) {
      const report = runRetentionSweep({ bullswarmDir, trigger: opts.trigger ?? 'auto' });
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      return report.ok === false ? 1 : 0;
    }
    const report = pruneHome({ bullswarmDir, apply: opts.yes === true, workspacesDays: days });
    // A manual apply is recorded like the automatic one, so `home status`
    // shows the last prune whoever ran it.
    if (report.apply) recordPrune(bullswarmDir, report, { trigger: 'manual' });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printPrune(report);
    return report.ok ? 0 : 1;
  } catch (error) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`✗ ${error.message}`);
    return 1;
  }
}

/** The read-only picture `home status` prints: policy, last results, what is on disk. */
export function homeStatus(bullswarmDir, { now = Date.now() } = {}) {
  const policy = readRetentionPolicy(bullswarmDir);
  const plan = planRetention({ bullswarmDir, now });
  const results = readMaintenanceResults(bullswarmDir);
  return {
    ok: true,
    home: bullswarmDir,
    retention: policy,
    workspaces: {
      scannedRuns: plan.scannedRuns,
      runsWithWorkspaces: plan.runsWithWorkspaces,
      bytes: plan.workspaceBytes,
      reclaimableBytes: plan.reclaimableBytes,
      reclaimableRuns: plan.candidates.length,
      keptRuns: plan.skipped.length,
    },
    maintenance: results,
  };
}

function cmdStatus(tail, bullswarmDir) {
  const opts = parseSnapshotFlags(tail);
  const flagExit = checkFlags(opts, ['home', 'status']);
  if (flagExit !== null) return flagExit;
  if (opts._positional.length) {
    console.error(`✗ unexpected argument "${opts._positional[0]}"\nusage: ${usageLine(['home', 'status'])}`);
    return 2;
  }
  const now = Date.now();
  const status = homeStatus(bullswarmDir, { now });
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  const { retention, workspaces, maintenance } = status;
  const state = retention.invalid.length
    ? `paused — ${retention.invalid.join('; ')}`
    : retention.enabled ? `on · workspaces of finished runs go after ${retention.workspacesDays} days` : 'off';
  console.log(`home ${status.home}`);
  console.log(`  retention        ${state}`);
  console.log(`  workspaces       ${plural(workspaces.runsWithWorkspaces, 'run')} · ${formatBytes(workspaces.bytes)} on disk · ${formatBytes(workspaces.reclaimableBytes)} reclaimable now (${plural(workspaces.reclaimableRuns, 'run')})`);
  const jobs = [['prune', 'last prune'], ['reprice', 'last reprice']];
  const named = new Set(jobs.map(([job]) => job));
  for (const job of Object.keys(maintenance)) if (!named.has(job)) jobs.push([job, `last ${job}`]);
  for (const [job, label] of jobs) {
    const record = maintenance[job];
    const body = record
      ? `${ago(record.at, now)} · ${record.trigger ?? 'unknown trigger'} · ${record.ok === false ? '✗ ' : ''}${record.line ?? 'no summary recorded'}`
      : 'never';
    console.log(`  ${label.padEnd(16)} ${body}`);
    const removal = record?.lastRemoval;
    if (removal && !record.removedWorkspaces) {
      console.log(`  ${''.padEnd(16)} last removal ${ago(removal.at, now)}: ${plural(removal.workspaces, 'workspace')} from ${plural(removal.runs, 'run')} · ${formatBytes(removal.bytes)}`);
    }
  }
  return 0;
}

export function cmdHome(args, { bullswarmDir = defaultHome() } = {}) {
  const [sub, ...tail] = args;
  if (flagName(sub)) return unknownFlagExit([flagName(sub)], ['home']);
  if (!sub) {
    console.error(helpText(['home']));
    return 2;
  }
  if (sub === 'prune') return cmdPrune(tail, bullswarmDir);
  if (sub === 'status') return cmdStatus(tail, bullswarmDir);
  if (sub !== 'snapshot') {
    console.error(`✗ "home ${sub}" is not a subcommand.\n${helpText(['home'])}`);
    return 2;
  }
  const opts = parseSnapshotFlags(tail);
  const flagExit = unknownFlagExit(opts._flags, ['home', 'snapshot']);
  if (flagExit !== null) return flagExit;
  const typed = typedErrors(opts);
  if (typed.length) {
    for (const problem of typed) console.error(`✗ ${problem}`);
    console.error(`usage: ${usageLine(['home', 'snapshot'])}`);
    return 2;
  }
  const [destination, ...extra] = opts._positional;
  if (!destination || extra.length) {
    console.error(`usage: ${usageLine(['home', 'snapshot'])}`);
    return 2;
  }
  if (opts.runs != null && opts.recent != null) {
    console.error('✗ --runs and --recent cannot be combined');
    return 2;
  }
  const recent = opts.recent == null ? 3 : Number(opts.recent);
  try {
    const result = snapshotHome(destination, {
      source: bullswarmDir,
      runs: opts.runs ?? null,
      recent,
      since: opts.since ?? null,
      noStreams: opts['no-streams'] === true,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ snapshot ${result.destination} · ${result.size} · ${result.count} workflow run${result.count === 1 ? '' : 's'}`);
      if (result.noStreams) console.log('  streams: omitted (--no-streams)');
      for (const run of result.runs) {
        console.log(`  - ${run.shortId ?? '------'} ${run.runId} ${run.status ?? 'unknown'}${run.startedAt ? ` · ${run.startedAt}` : ''}`);
      }
    }
    return 0;
  } catch (error) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`✗ ${error.message}`);
    return 1;
  }
}
