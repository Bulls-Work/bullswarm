import { withV2Cancellation } from './v2-cancellation.js';
// bullswarm workflow runs — instance management.
//
//   bullswarm workflow runs                       # list ongoing (default)
//   bullswarm workflow runs --all                 # list ongoing + historical
//   bullswarm workflow runs --historical          # only historical
//   bullswarm workflow runs --name <workflow>     # filter by workflow name
//   bullswarm workflow runs --all --since 7d      # initiated in the last 7 days
//   bullswarm workflow runs --all --since yesterday --until today
//   bullswarm workflow runs --limit N             # cap result count
//   bullswarm workflow runs show <id>             # dump state + report
//   bullswarm workflow runs delete <id> --yes     # remove the run directory
//
// `<id>` is a shortId (6 chars) or a full runId (`wf-...`). The
// resolver in short-id.js maps both to the run directory.
//
// Legacy (pre-0.27.0 authored-graph) runs are read-only history: they list as
// one row marked `legacy`, `show`/`result` refuse them with a single line and
// exit 2, and `delete` still removes the directory.

import { existsSync, rmSync, readFileSync } from 'node:fs';
import { readJsonSafe } from '../lib/fsjson.js';
import { join } from 'node:path';
import { listRuns, resolveRunId, isOngoing, isLegacyRunDir, legacyRunLine, v2RunnerLiveness, readKernelStderrTail } from './short-id.js';
import { BULLSWARM_DIR } from './cli.js';
import { deserializeV2ResultEnvelope, summarizeV2Result } from './v2-outcome.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';

function jsonOut(obj, opts) {
  if (!(opts.json || opts.summary)) return;
  // Summary is budgeted against compact JSON.stringify; --json alone stays pretty.
  console.log(opts.summary ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
}
function err(msg, code = 1) { console.error(msg); return code; }

// Every command that would drive a legacy run answers with the same sentence
// and the same exit code, so a script never has to parse a special case.
function refuseLegacy({ runId, shortId, runDir }, opts) {
  const message = legacyRunLine({ shortId, runId, runDir });
  if (opts.json || opts.summary) console.log(JSON.stringify({ legacy: true, runId, shortId: shortId ?? null, dir: runDir, message }, null, 2));
  else console.error(message);
  return 2;
}

// `alias` is the help root the caller actually typed: the top-level `runs`
// shorthand renders its own synopsis rather than the canonical one.
export function cmdRuns(args, { alias = ['workflow', 'runs'] } = {}) {
  const opts = parseRunsFlags(args);
  const [sub, idToken, ...rest] = opts._positional;
  const SUBS = ['list', 'show', 'result', 'delete'];
  if (sub && !SUBS.includes(sub)) {
    console.error(runsUsage());
    return 2;
  }
  // Same gate as every other command path, against this subcommand's row of
  // the table: `runs list --bogus` is an error, not a silent no-op.
  const path = [...alias, ...(sub ? [sub] : [])];
  const flagExit = unknownFlagExit(opts._flags, path);
  if (flagExit !== null) return flagExit;
  const typedExit = typedFlagErrors(opts, path);
  if (typedExit !== null) return typedExit;
  if (!sub || sub === 'list') return runsList(opts);
  if (sub === 'show') return runsShow(idToken, opts);
  if (sub === 'result') return runsResult(idToken, opts);
  return runsDelete(idToken, opts, rest);
}

// Typed inputs are validated at the boundary, before any run directory is
// read: `--limit nope` used to parse to NaN, fail the `opts.limit > 0` test
// in runsList(), and quietly return the unlimited list with exit 0.
function typedFlagErrors(opts, path) {
  const problems = [];
  for (const [flag, raw] of Object.entries(opts._values ?? {})) {
    if (raw === true || raw === undefined || raw === '') {
      problems.push(`--${flag} requires a value`);
      continue;
    }
    if (flag === 'limit') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        problems.push(`--limit must be a positive integer (got "${raw}")`);
      }
    }
  }
  if (!problems.length) return null;
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`usage: ${usageLine(path)}`);
  return 2;
}

export function runsUsage() {
  return helpText(['workflow', 'runs']);
}

function parseRunsFlags(argv) {
  const out = { _positional: [], _flags: [], _values: {} };
  const valueFlags = new Map([
    ['name', 'name'],
    ['limit', 'limit'],
    ['since', 'since'],
    ['started-after', 'since'],
    ['from', 'since'],
    ['until', 'until'],
    ['started-before', 'until'],
    ['to', 'until'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const seen = flagName(a);
    if (seen && !out._flags.includes(seen)) out._flags.push(seen);
    if (a === '--json') out.json = true;
    else if (a === '--summary') out.summary = true;
    else if (a === '--all') out.all = true;
    else if (a === '--historical') out.historical = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq > 0 ? eq : undefined);
      const target = valueFlags.get(key);
      if (target) {
        // A value flag whose next token is another flag (or nothing) got the
        // flag itself as its value before; keep the raw text for the boundary
        // check so the error names what was actually typed.
        const next = eq > 0 ? a.slice(eq + 1) : (flagName(argv[i + 1]) ? undefined : argv[++i]);
        out._values[key] = next;
        out[target] = target === 'limit' ? Number(next) : next;
      } else {
        out[key] = eq > 0 ? a.slice(eq + 1) : true;
      }
    }
    else out._positional.push(a);
  }
  return out;
}

function runsList(opts) {
  let initiatedRange;
  try {
    initiatedRange = resolveInitiatedRange(opts);
  } catch (error) {
    return err(error.message, 2);
  }
  const all = listRuns(BULLSWARM_DIR());
  let filtered = all;
  if (opts.name) filtered = filtered.filter((r) => (r.legacy ? legacyRunName(r) : r.state?.intent?.goal) === opts.name);
  // Default scope: ongoing only. `--all` includes historical.
  if (!opts.all && !opts.historical) {
    filtered = filtered.filter((r) => r.ongoing);
  } else if (opts.historical) {
    filtered = filtered.filter((r) => !r.ongoing);
  }
  if (initiatedRange.sinceMs != null) {
    filtered = filtered.filter((r) => {
      const startedMs = Date.parse(runStartedAt(r) ?? '');
      return Number.isFinite(startedMs) && startedMs >= initiatedRange.sinceMs;
    });
  }
  if (initiatedRange.untilMs != null) {
    filtered = filtered.filter((r) => {
      const startedMs = Date.parse(runStartedAt(r) ?? '');
      return Number.isFinite(startedMs) && startedMs < initiatedRange.untilMs;
    });
  }
  // Newest first.
  filtered.sort((a, b) => {
    const ta = runStartedAt(a) ?? '';
    const tb = runStartedAt(b) ?? '';
    return tb.localeCompare(ta);
  });
  if (opts.limit && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

  if (opts.json) {
    jsonOut({
      ongoing: opts.all || !opts.historical,
      historical: opts.all || opts.historical,
      name: opts.name ?? null,
      initiatedRange: {
        field: 'startedAt',
        sinceInclusive: initiatedRange.sinceMs == null
          ? null
          : new Date(initiatedRange.sinceMs).toISOString(),
        untilExclusive: initiatedRange.untilMs == null
          ? null
          : new Date(initiatedRange.untilMs).toISOString(),
      },
      count: filtered.length,
      runs: filtered.map(summarize),
    }, opts);
    return 0;
  }

  if (filtered.length === 0) {
    if (opts.historical) {
      console.log('no historical runs');
    } else if (opts.all) {
      console.log('no runs');
    } else {
      console.log('no ongoing runs (try --all to see historical)');
    }
    return 0;
  }
  for (const r of filtered) {
    if (r.legacy) {
      // One read-only row: no step or action progress is claimed, because
      // 0.27.0 never reads far enough into a legacy state.json to know it.
      console.log(
        `○  ${(r.shortId ?? '------').padEnd(8)} ${r.runId.padEnd(28)} ` +
        `${String(legacyRunName(r)).slice(0, 28).padEnd(28)} ${String(r.state?.status ?? 'unknown').padEnd(10)} ` +
        `${humanAge(runStartedAt(r))}  legacy`,
      );
      continue;
    }
    // lifecycle.status is what the kernel last wrote; if the kernel is gone
    // that word is stale, so say the run stopped rather than repeat it.
    const durable = r.state.lifecycle?.status;
    const status = !r.ongoing && ['queued', 'planning', 'running', 'ready-to-finalize'].includes(durable)
      ? 'interrupted' : durable ?? (r.ongoing ? 'running' : 'unknown');
    const completed = r.state.actions?.filter((action) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(action.status)).length ?? 0;
    const total = r.state.actions?.length ?? 0;
    console.log(`${r.ongoing ? '●' : '○'}  ${(r.shortId ?? '------').padEnd(8)} ${r.runId.padEnd(28)} ${(r.state.intent?.goal ?? '?').slice(0, 28).padEnd(28)} ${status.padEnd(10)} ${`${completed}/${total}`.padStart(5)} actions  ${humanAge(runStartedAt(r))}`);
  }
  return 0;
}

// The name a legacy run is listed under: whatever workflow name it recorded,
// else its goal, else nothing to say.
function legacyRunName(r) {
  return r.state?.name ?? r.state?.goal ?? '?';
}

// One line per program action showing the routing acceptance resolved, with
// `kind` next to lane/effort whenever the author supplied one. Programs
// written before kinds existed print exactly what they printed before.
function printV2ProgramRouting(state) {
  const actions = Array.isArray(state?.program?.actions) ? state.program.actions : [];
  if (!actions.length) return;
  const status = new Map((state.actions ?? []).map((entry) => [entry.id, entry.status]));
  for (const action of actions) {
    const kind = action.kind ? `  kind ${action.kind}` : '';
    console.log(`  ${String(action.id).padEnd(24)} ${action.lane ?? '?'}/${action.effort ?? '?'}${kind}  ${status.get(action.id) ?? 'unknown'}`);
  }
}

// Advice recorded when the program was accepted. Advisories never changed the
// outcome; they are shown so the author sees what the launch already said.
function printV2Advisories(state) {
  const advisories = Array.isArray(state?.advisories) ? state.advisories : [];
  if (!advisories.length) return;
  console.log(`# advisories  ${advisories.length}`);
  for (const advisory of advisories) {
    console.log(`  advisory: ${advisory.code}${advisory.actionId ? ` ${advisory.actionId}` : ''} — ${advisory.message}`);
  }
}

function runsShow(idToken, opts) {
  if (!idToken) return err(`usage: ${usageLine(['workflow', 'runs', 'show'])}`, 2);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir } = resolved;
  const statePath = join(runDir, 'state.json');
  const reportPath = join(runDir, 'report.json');
  if (isLegacyRunDir(runDir)) return refuseLegacy(resolved, opts);
  const state = withV2Cancellation(readJsonSafe(statePath), runDir);
  const report = readJsonSafe(reportPath);
  const ongoing = isOngoing(runDir, state);
  const liveness = v2RunnerLiveness(state, { runDir });
  const kernelStderrTail = !liveness.alive ? readKernelStderrTail(runDir) : [];

  if (opts.json) {
    jsonOut({ runId, shortId: resolved.shortId, runDir, ongoing, state, report, ...(kernelStderrTail.length ? { kernelStderrTail } : {}) }, opts);
    return 0;
  }
  console.log(`# run  ${runId}  (${resolved.shortId ?? 'no shortId'})`);
  console.log(`# dir  ${runDir}`);
  console.log(`# goal  ${state.intent?.goal ?? '?'}`);
  console.log(`# status  ${state.lifecycle?.status ?? 'unknown'}  ${ongoing ? '(ongoing)' : '(terminal)'}`);
  console.log(`# started  ${state.lifecycle?.startedAt ?? '?'}`);
  console.log(`# finished ${state.lifecycle?.finishedAt ?? '—'}`);
  console.log(`# requirements  ${Object.values(state.ledger?.requirements ?? {}).filter((requirement) => requirement.status === 'passed').length}/${Object.keys(state.ledger?.requirements ?? {}).length} passed`);
  console.log(`# actions  ${state.actions?.filter((action) => action.status === 'succeeded').length ?? 0}/${state.actions?.length ?? 0} succeeded`);
  printV2ProgramRouting(state);
  // One line per attempt, so the pool, model and the reasoning level it
  // actually ran at are visible in text mode too — --json already carries
  // the whole record. Older runs have no reasoning and print none.
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  if (attempts.length) {
    console.log(`# attempts  ${attempts.length}`);
    for (const attempt of attempts) {
      const applied = attempt.reasoning?.applied;
      const reasoning = applied
        ? `  reasoning ${applied} (${attempt.reasoning.source ?? 'unknown'}${attempt.reasoning.clamped ? ', clamped' : ''})`
        : '';
      console.log(`  ${attempt.actionId ?? '?'} #${attempt.ordinal ?? '?'}  ${attempt.status ?? '?'}  ${attempt.pool ?? '—'}  ${attempt.model ?? 'connector model'}${reasoning}${attemptBytesText(attempt.bytes)}`);
    }
  }
  printV2Advisories(state);
  if (kernelStderrTail.length) {
    console.log('kernel log:');
    for (const line of kernelStderrTail) console.log(`  ${line}`);
  }
  return 0;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value}B`;
  const units = ['K', 'M', 'G'];
  let scaled = value;
  let unit = 'B';
  for (const next of units) {
    scaled /= 1024;
    unit = next;
    if (scaled < 1024 || next === units.at(-1)) break;
  }
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

function attemptBytesText(bytes) {
  if (!bytes || typeof bytes !== 'object') return '';
  const values = [bytes.taskFile, bytes.dependencyInputs, bytes.output];
  if (!values.some((value) => Number.isFinite(value) && value >= 0)) return '';
  return `  in ${formatBytes(bytes.taskFile)}/${formatBytes(bytes.dependencyInputs)} out ${formatBytes(bytes.output)}`;
}

function runsResult(idToken, opts) {
  if (!idToken) return err(`usage: ${usageLine(['workflow', 'runs', 'result'])}`, 2);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir } = resolved;
  if (isLegacyRunDir(runDir)) return refuseLegacy(resolved, opts);
  const state = withV2Cancellation(readJsonSafe(join(runDir, 'state.json')), runDir);
  const ongoing = isOngoing(runDir, state);
  const liveness = v2RunnerLiveness(state, { runDir });
  const kernelStderrTail = !liveness.alive ? readKernelStderrTail(runDir) : [];
  const stablePath = join(runDir, 'result.json');
  if (!existsSync(stablePath)) {
    if ((opts.json || opts.summary) && kernelStderrTail.length) {
      jsonOut({ runId, shortId: resolved.shortId, status: 'interrupted', reason: liveness.reason, kernelStderrTail }, opts);
      return 1;
    }
    if (state.planner?.awaiting) return err(`workflow ${resolved.shortId ?? runId} is waiting for its caller planner (${state.planner.awaiting.boundary} boundary); next: bullswarm workflow plan show ${resolved.shortId ?? runId} --json`);
    return err(ongoing ? `workflow ${resolved.shortId ?? runId} is still running; watch it with bullswarm workflow watch ${resolved.shortId ?? runId}` : `V2 result is unavailable for ${resolved.shortId ?? runId}`);
  }
  let stable;
  try { stable = deserializeV2ResultEnvelope(readFileSync(stablePath, 'utf8')); }
  catch (error) { return err(`V2 result is invalid for ${resolved.shortId ?? runId}: ${error.message}`); }
  if (stable.runId !== runId || stable.shortId !== state.shortId || stable.intentId !== state.intentId) {
    return err(`V2 result does not match durable state for ${resolved.shortId ?? runId}`);
  }
  if (opts.summary) {
    jsonOut(summarizeV2Result(stable, state, { runDir }), { ...opts, json: true });
    return 0;
  }
  if (opts.json) {
    jsonOut(kernelStderrTail.length ? { ...stable, kernelStderrTail } : stable, opts);
    return 0;
  }
  console.log(`# workflow result  ${stable.runId}  (${stable.shortId ?? 'no shortId'})`);
  console.log(`# status  ${stable.status}  result ready`);
  console.log(`# verified  ${stable.verified ? 'yes' : 'no'}`);
  console.log(`# outcome  ${stable.reason}`);
  console.log(`# requirements  ${stable.requirements.filter((requirement) => requirement.status === 'passed').length}/${stable.requirements.length} passed`);
  if (stable.gaps?.summary) console.log(`# gaps  ${stable.gaps.summary}`);
  // The stable envelope records outcomes, not routing. The durable state
  // next to it holds the accepted program, so the routing each action ran
  // on — including its `kind` — is reported from there.
  if (Array.isArray(state?.program?.actions) && state.program.actions.length) {
    console.log(`# actions  ${state.program.actions.length}`);
    printV2ProgramRouting(state);
  }
  printV2Advisories(state);
  return stable.status === 'completed' ? 0 : 1;
}

function runsDelete(idToken, opts, rest) {
  if (!idToken) return err(`usage: ${usageLine(['workflow', 'runs', 'delete'])}`, 2);
  if (!opts.yes) return err(`refusing to delete run "${idToken}" without --yes`, 2);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir, shortId } = resolved;
  // Refuse to delete an ongoing run without --force. Half-finished
  // runs are usually a debugging target, not garbage.
  const statePath = join(runDir, 'state.json');
  // Delete guard: an unreadable (mid-write) state means the run may be live —
  // treat it as ongoing rather than deleting a live run; --force still wins.
  let state = null;
  let stateUnreadable = false;
  if (existsSync(statePath)) {
    state = readJsonSafe(statePath, undefined);
    if (state === undefined) { state = null; stateUnreadable = true; }
  }
  const ongoing = stateUnreadable ? true : isOngoing(runDir, state);
  if (ongoing && !opts.force) {
    return err(
      `refusing to delete ongoing run "${runId}" (shortId ${shortId ?? '?'}); ` +
      `pass --force to delete anyway`,
    );
  }
  rmSync(runDir, { recursive: true, force: true });
  if (opts.json) jsonOut({ ok: true, runId, shortId, runDir, deleted: true }, opts);
  else console.log(`✓ deleted run ${runId} (${shortId ?? 'no shortId'})`);
  return 0;
}

function summarize(r) {
  if (r.legacy) return {
    runId: r.runId, shortId: r.shortId, legacy: true, dir: r.runDir,
    workflow: r.state?.name ?? null, goal: r.state?.goal ?? null,
    status: r.state?.status ?? null, startedAt: r.state?.startedAt ?? null,
    finishedAt: r.state?.finishedAt ?? null, ongoing: false,
  };
  return {
    runId: r.runId, shortId: r.shortId, legacy: false, workflow: 'autonomous-v2', goal: r.state.intent?.goal ?? null,
    status: r.state.lifecycle?.status ?? null, startedAt: runStartedAt(r), finishedAt: r.state.lifecycle?.finishedAt ?? null,
    ongoing: r.ongoing, actionsSucceeded: r.state.actions?.filter((action) => action.status === 'succeeded').length ?? 0,
    actionsTotal: r.state.actions?.length ?? 0,
  };
}

function runStartedAt(run) {
  return run.state?.lifecycle?.startedAt ?? run.state?.startedAt ?? run.report?.startedAt ?? null;
}

function resolveInitiatedRange(opts, nowMs = Date.now()) {
  const sinceMs = opts.since == null ? null : parseTimeBound(opts.since, nowMs, '--since');
  const untilMs = opts.until == null ? null : parseTimeBound(opts.until, nowMs, '--until');
  if (sinceMs != null && untilMs != null && sinceMs >= untilMs) {
    throw new Error('initiated-time range is empty: --since must be earlier than --until');
  }
  return { sinceMs, untilMs };
}

function parseTimeBound(value, nowMs, flag) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${flag} requires a time value`);
  const normalized = raw.toLowerCase();

  if (normalized === 'now') return nowMs;
  if (['yesterday', 'today', 'tomorrow'].includes(normalized)) {
    const date = new Date(nowMs);
    date.setHours(0, 0, 0, 0);
    if (normalized === 'yesterday') date.setDate(date.getDate() - 1);
    if (normalized === 'tomorrow') date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  const duration = normalized.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/);
  if (duration) {
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2]];
    return nowMs - Number(duration[1]) * unitMs;
  }

  const localDate = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (localDate) {
    const [, year, month, day] = localDate;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (date.getFullYear() !== Number(year)
      || date.getMonth() !== Number(month) - 1
      || date.getDate() !== Number(day)) {
      throw new Error(`${flag} has an invalid calendar date: "${raw}"`);
    }
    return date.getTime();
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} has an invalid time: "${raw}"`);
  }
  return parsed;
}

function humanAge(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
