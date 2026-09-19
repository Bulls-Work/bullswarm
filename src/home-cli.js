// bullswarm home — safe, selective copies of a Bullswarm home.
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
import { flagName, unknownFlagExit } from './lib/cli-flags.js';
import { helpText, usageLine } from './help.js';
import { listRuns, resolveRunId } from './workflow/short-id.js';
import { cmdReindex } from './workflow/runs-cli.js';

const VALUE_FLAGS = new Set(['runs', 'recent', 'since']);
const BOOLEAN_FLAGS = new Set(['no-streams', 'json']);
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

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 'B';
  for (const candidate of units) {
    scaled /= 1024;
    unit = candidate;
    if (scaled < 1024 || candidate === units.at(-1)) break;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${unit}`;
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

export function cmdHome(args, { bullswarmDir = defaultHome() } = {}) {
  const [sub, ...tail] = args;
  if (flagName(sub)) return unknownFlagExit([flagName(sub)], ['home']);
  if (!sub) {
    console.error(helpText(['home']));
    return 2;
  }
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
