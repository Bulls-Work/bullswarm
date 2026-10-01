// CLI leaf for `bullswarm workflow reprice`: parses its flags, runs the
// re-pricing pass (reprice.js) or, with --incremental, the automatic pricing
// pass (reconcile.js), and prints the rows.

import { homedir } from 'node:os';
import { helpText } from '../help.js';
import { resolvePoolId, withPoolLabels } from '../lib/pool-labels.js';
import { indexedTranscriptReader, readTranscriptUsage as defaultReadTranscriptUsage } from '../lib/transcripts/index.js';
import { formatMoney } from '../lib/usage-basis.js';
import { reconcilePricing } from './reconcile.js';
import { defaultBullswarmDir, nonNegative, REPRICE_RETENTION_CAVEAT, repriceRuns, timeMs } from './reprice.js';

function parseArgs(args) {
  const opts = {
    apply: false, json: false, since: null, pool: null, all: false,
    incremental: false, trigger: null, 'transcript-home': null, 'delay-ms': null,
  };
  const values = new Set(['since', 'pool', 'trigger', 'transcript-home', 'delay-ms']);
  const switches = new Set(['apply', 'dry-run', 'json', 'all', 'incremental']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--incremental') opts.incremental = true;
    else if (values.has(typeof arg === 'string' ? arg.slice(2) : '') && arg.startsWith('--')) {
      if (index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      opts[arg.slice(2)] = args[++index];
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = arg.slice(2, equals > 0 ? equals : undefined);
      if (!values.has(name) && !switches.has(name)) {
        throw new Error(`unknown flag --${name} for workflow reprice`);
      }
      if (equals > 0) opts[name] = arg.slice(equals + 1);
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  const sinceMs = opts.since == null ? null : timeMs(opts.since);
  if (opts.since != null && sinceMs == null) throw new Error(`--since must be an ISO-compatible date: ${opts.since}`);
  if (opts.pool != null && !String(opts.pool).trim()) throw new Error('--pool must be a non-empty pool name');
  if (opts.all && opts.since != null) throw new Error('--all cannot be combined with --since');
  if (opts.incremental && (opts.all || opts.since != null || opts.pool != null)) {
    throw new Error('--incremental prices every unmeasured attempt; it takes no --since, --all or --pool');
  }
  if (!opts.incremental && (opts.trigger != null || opts['delay-ms'] != null)) {
    throw new Error('--trigger and --delay-ms apply only to --incremental');
  }
  if (opts['delay-ms'] != null && !/^\d{1,6}$/.test(String(opts['delay-ms']))) {
    throw new Error('--delay-ms must be a whole number of milliseconds up to 999999');
  }
  if (opts.trigger != null && !/^[a-z][a-z0-9-]*$/.test(opts.trigger)) throw new Error('--trigger must be a kebab-case name');
  return { ...opts, sinceMs };
}

function money(value, tokens = null) {
  return formatMoney(nonNegative(value), tokens);
}

function table(rows) {
  const columns = [
    ['run', (row) => row.shortId ?? row.runId],
    ['action', (row) => row.actionId],
    ['try', (row) => row.ordinal],
    ['pool', (row) => row.pool ?? '-'],
    ['model', (row) => row.model ?? '-'],
    ['project', (row) => row.project ?? 'unknown'],
    ['old tokenSource', (row) => row.oldTokenSource],
    ['old cost', (row) => money(row.oldCost, row.totalKnown)],
    ['new tokenSource', (row) => row.tokenSource],
    ['new api usd', (row) => money(row.apiUsd, row.totalKnown)],
    ['subscription usd', (row) => money(row.subscriptionUsd, row.totalKnown)],
    ['confidence', (row) => row.confidence],
  ];
  const values = rows.map((row) => columns.map(([, value]) => String(value(row) ?? '-')));
  const widths = columns.map(([header], index) => Math.max(header.length, ...values.map((line) => line[index].length)));
  const format = (line) => line.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [format(columns.map(([header]) => header)), format(widths.map((width) => '-'.repeat(width))), ...values.map(format)].join('\n');
}

/** CLI leaf for `bullswarm workflow reprice`. */
export function cmdReprice(args = [], {
  bullswarmDir = defaultBullswarmDir(),
  transcriptHome = homedir(),
  readTranscriptUsage = defaultReadTranscriptUsage,
  connectors = null,
  providers = null,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    log(helpText(['workflow', 'reprice']));
    return 0;
  }
  let opts;
  try { opts = parseArgs(args); }
  catch (err) {
    error(`✗ ${err.message}`);
    return 2;
  }
  if (opts.pool) opts.pool = resolvePoolId(opts.pool, bullswarmDir);
  const home = opts['transcript-home'] ?? transcriptHome;
  if (opts.incremental) {
    // The automatic path, run by hand or as the dashboard's detached child:
    // it always applies, and only to attempts that are still unmeasured.
    // A watch-triggered child waits for the finished task's record (written
    // just after the watch returns) and for the provider to flush its log.
    const delay = Number(opts['delay-ms'] ?? 0);
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    let pass;
    try {
      pass = reconcilePricing({ bullswarmDir, transcriptHome: home, connectors, providers, trigger: opts.trigger ?? 'manual' });
    } catch (err) {
      error(`✗ ${err.message}`);
      return 1;
    }
    if (opts.json) log(JSON.stringify({ type: 'reconcile', ...pass }));
    else if (pass.status === 'busy') log('another pricing pass is running; nothing to do');
    else if (pass.status !== 'complete') log(`nothing to price: ${pass.reason}`);
    else log(`✓ ${pass.line} · ${(pass.elapsedMs / 1000).toFixed(1)}s`);
    return pass.failures?.length ? 1 : 0;
  }
  let report;
  try {
    const effectiveSince = opts.all
      ? null
      : opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const liveReader = readTranscriptUsage === defaultReadTranscriptUsage
      ? indexedTranscriptReader({ home, bullswarmDir, providers })
      : readTranscriptUsage;
    const streamRows = readTranscriptUsage === defaultReadTranscriptUsage;
    report = repriceRuns({
      bullswarmDir,
      transcriptHome: home,
      apply: opts.apply,
      since: effectiveSince,
      pool: opts.pool,
      readTranscriptUsage: liveReader,
      connectors,
      providers,
      onRow: streamRows ? (row) => log(opts.json
        ? JSON.stringify({ type: 'attempt', ...row })
        : withPoolLabels(`${row.shortId ?? row.runId}  ${row.actionId}  try ${row.ordinal}  ${row.pool ?? '-'}  ${row.tokenSource}  api=${money(row.apiUsd)}  sub=${money(row.subscriptionUsd)}  ${row.confidence}`, bullswarmDir)) : null,
    });
  } catch (err) {
    error(`✗ ${err.message}`);
    return 1;
  }
  if (opts.json) {
    // Keep stdout valid JSON for scripts; the required caveat is still part of
    // the command's output on stderr.
    error(REPRICE_RETENTION_CAVEAT);
    const summary = readTranscriptUsage === defaultReadTranscriptUsage
      ? { ...report, rows: undefined }
      : report;
    log(JSON.stringify({ type: 'summary', ...summary }));
  } else {
    log(withPoolLabels(table(report.rows), bullswarmDir));
    log(REPRICE_RETENTION_CAVEAT);
    log(`✓ reprice: ${report.rows.length} record${report.rows.length === 1 ? '' : 's'}, ${report.changedRuns} run${report.changedRuns === 1 ? '' : 's'} changed, ${report.minutesChanged} duration record${report.minutesChanged === 1 ? '' : 's'} stale (${report.minutesRecomputed} recomputed), ${report.changedProjects} project${report.changedProjects === 1 ? '' : 's'} backfilled, ${(report.elapsedMs / 1000).toFixed(1)}s elapsed`);
    for (const failure of report.failures) error(`✗ ${failure.runId}: ${failure.error}`);
  }
  return report.failures.length ? 1 : 0;
}
