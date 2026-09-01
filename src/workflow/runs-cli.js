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

import { existsSync, rmSync, readFileSync } from 'node:fs';
import { readJsonSafe } from './fsjson.js';
import { join } from 'node:path';
import { listRuns, resolveRunId, isOngoing } from './short-id.js';
import { BULLSWARM_DIR } from './cli.js';
import { buildWorkflowResult } from './result.js';
import { deserializeV2ResultEnvelope } from './v2-outcome.js';
import { helpText, usageLine } from '../help.js';

function jsonOut(obj, opts) { if (opts.json) console.log(JSON.stringify(obj, null, 2)); }
function err(msg, code = 1) { console.error(msg); return code; }

export function cmdRuns(args) {
  const opts = parseRunsFlags(args);
  const [sub, idToken, ...rest] = opts._positional;
  if (!sub || sub === 'list') return runsList(opts);
  if (sub === 'show') return runsShow(idToken, opts);
  if (sub === 'result') return runsResult(idToken, opts);
  if (sub === 'delete') return runsDelete(idToken, opts, rest);
  console.error(runsUsage());
  return 2;
}

export function runsUsage() {
  return helpText(['workflow', 'runs']);
}

function parseRunsFlags(argv) {
  const out = { _positional: [] };
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
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--historical') out.historical = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq > 0 ? eq : undefined);
      const target = valueFlags.get(key);
      if (target) {
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        out[target] = target === 'limit' ? Number(value) : value;
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
  if (opts.name) filtered = filtered.filter((r) => r.state?.workflow === opts.name);
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
    if (r.state?.schemaVersion === 'bullswarm.workflow.state.v2') {
      const status = r.state.lifecycle?.status ?? (r.ongoing ? 'running' : 'unknown');
      const completed = r.state.actions?.filter((action) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(action.status)).length ?? 0;
      const total = r.state.actions?.length ?? 0;
      console.log(`${r.ongoing ? '●' : '○'}  ${(r.shortId ?? '------').padEnd(8)} ${r.runId.padEnd(28)} ${(r.state.intent?.goal ?? '?').slice(0, 28).padEnd(28)} ${status.padEnd(10)} ${`${completed}/${total}`.padStart(5)} actions  ${humanAge(runStartedAt(r))}`);
      continue;
    }
    const wf = r.state?.workflow ?? '?';
    const status = r.state?.status ?? (r.ongoing ? 'running' : 'unknown');
    const age = humanAge(runStartedAt(r));
    const phases = `${r.state?.steps?.filter((s) => s.ok).length ?? 0}/${r.state?.steps?.length ?? 0}`;
    console.log(
      `${r.ongoing ? '●' : '○'}  ${(r.shortId ?? '------').padEnd(8)} ` +
      `${r.runId.padEnd(28)} ${wf.padEnd(20)} ${status.padEnd(10)} ` +
      `${phases.padStart(4)} steps  ${age}`,
    );
  }
  return 0;
}

function runsShow(idToken, opts) {
  if (!idToken) return err(`usage: ${usageLine(['workflow', 'runs', 'show'])}`, 2);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir } = resolved;
  const statePath = join(runDir, 'state.json');
  const reportPath = join(runDir, 'report.json');
  const state = readJsonSafe(statePath);
  const report = readJsonSafe(reportPath);
  const ongoing = isOngoing(runDir, state);

  if (opts.json) {
    jsonOut({ runId, shortId: resolved.shortId, runDir, ongoing, state, report }, opts);
    return 0;
  }
  if (state?.schemaVersion === 'bullswarm.workflow.state.v2') {
    console.log(`# run  ${runId}  (${resolved.shortId ?? 'no shortId'})`);
    console.log(`# dir  ${runDir}`);
    console.log(`# goal  ${state.intent?.goal ?? '?'}`);
    console.log(`# status  ${state.lifecycle?.status ?? 'unknown'}  ${ongoing ? '(ongoing)' : '(terminal)'}`);
    console.log(`# started  ${state.lifecycle?.startedAt ?? '?'}`);
    console.log(`# finished ${state.lifecycle?.finishedAt ?? '—'}`);
    console.log(`# requirements  ${Object.values(state.ledger?.requirements ?? {}).filter((requirement) => requirement.status === 'passed').length}/${Object.keys(state.ledger?.requirements ?? {}).length} passed`);
    console.log(`# actions  ${state.actions?.filter((action) => action.status === 'succeeded').length ?? 0}/${state.actions?.length ?? 0} succeeded`);
    return 0;
  }
  console.log(`# run  ${runId}  (${resolved.shortId ?? 'no shortId'})`);
  console.log(`# dir  ${runDir}`);
  console.log(`# workflow  ${state?.workflow ?? '?'}`);
  console.log(`# status  ${state?.status ?? (ongoing ? 'running' : 'unknown')}  ${ongoing ? '(ongoing)' : '(historical)'}`);
  console.log(`# started  ${state?.startedAt ?? '?'}`);
  console.log(`# finished ${state?.finishedAt ?? '—'}`);
  if (state?.abortReason) console.log(`# abort   ${state.abortReason}`);
  if (report?.summary) {
    const s = report.summary;
    console.log(`# summary steps ✓${s.stepsOk}/✗${s.stepsFailed}, fanout ✓${s.fanoutOk}/✗${s.fanoutFailed}`);
  }
  return 0;
}

function runsResult(idToken, opts) {
  if (!idToken) return err(`usage: ${usageLine(['workflow', 'runs', 'result'])}`, 2);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir } = resolved;
  const statePath = join(runDir, 'state.json');
  const reportPath = join(runDir, 'report.json');
  const state = readJsonSafe(statePath);
  const report = readJsonSafe(reportPath);
  const ongoing = isOngoing(runDir, state);
  if (state?.schemaVersion === 'bullswarm.workflow.state.v2') {
    const stablePath = join(runDir, 'result.json');
    if (!existsSync(stablePath)) return err(ongoing ? `workflow ${resolved.shortId ?? runId} is still running; watch it with bullswarm workflow watch ${resolved.shortId ?? runId}` : `V2 result is unavailable for ${resolved.shortId ?? runId}`);
    let stable;
    try { stable = deserializeV2ResultEnvelope(readFileSync(stablePath, 'utf8')); }
    catch (error) { return err(`V2 result is invalid for ${resolved.shortId ?? runId}: ${error.message}`); }
    if (stable.runId !== runId || stable.shortId !== state.shortId || stable.intentId !== state.intentId) {
      return err(`V2 result does not match durable state for ${resolved.shortId ?? runId}`);
    }
    if (opts.json) { jsonOut(stable, opts); return 0; }
    console.log(`# workflow result  ${stable.runId}  (${stable.shortId ?? 'no shortId'})`);
    console.log(`# status  ${stable.status}  result ready`);
    console.log(`# verified  ${stable.verified ? 'yes' : 'no'}`);
    console.log(`# outcome  ${stable.reason}`);
    console.log(`# requirements  ${stable.requirements.filter((requirement) => requirement.status === 'passed').length}/${stable.requirements.length} passed`);
    if (stable.gaps?.summary) console.log(`# gaps  ${stable.gaps.summary}`);
    return stable.status === 'completed' ? 0 : 1;
  }
  const result = buildWorkflowResult({
    state, report, runId, shortId: resolved.shortId, ongoing,
  });

  if (opts.json) {
    jsonOut(result, opts);
    return 0;
  }
  console.log(`# workflow result  ${result.runId}  (${result.shortId ?? 'no shortId'})`);
  console.log(`# status  ${result.status}${result.ready ? '  ready' : ''}`);
  console.log(`# verified  ${result.verified === true ? 'yes' : 'no'}`);
  if (result.outcome?.reason) console.log(`# outcome  ${result.outcome.reason}`);
  if (Array.isArray(result.outcome?.concerns) && result.outcome.concerns.length > 0) {
    console.log('# concerns');
    for (const concern of result.outcome.concerns) console.log(`- ${concern}`);
  }
  if (result.goal) console.log(`# goal  ${result.goal}`);
  console.log(`# agents  ${result.agentProgress.completed}/${result.agentProgress.total}`);
  if (result.delivery) {
    console.log(`# delivery  ${result.delivery.actionId}`);
    console.log(`# artifact  ${result.delivery.outFile ?? 'unavailable'}`);
    if (result.delivery.content != null) {
      const rendered = result.delivery.format === 'json'
        ? JSON.stringify(result.delivery.content, null, 2)
        : String(result.delivery.content);
      if (result.delivery.truncated || rendered.length > MAX_HUMAN_RESULT_CHARS) {
        console.log(`# preview  first ${MAX_HUMAN_RESULT_CHARS} characters; use --json and outFile for the durable artifact`);
      }
      console.log(rendered.slice(0, MAX_HUMAN_RESULT_CHARS));
    }
  } else {
    console.log('# delivery  not available yet');
  }
  if (result.verification?.verdict) {
    console.log(`# verification  ${result.verification.actionId}  ${result.verification.verdict.ok ? 'passed' : 'failed'}`);
    if (result.verification.verdict.summary) console.log(result.verification.verdict.summary);
  }
  return 0;
}

const MAX_HUMAN_RESULT_CHARS = 64 * 1024;

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
  if (r.state?.schemaVersion === 'bullswarm.workflow.state.v2') return {
    runId: r.runId, shortId: r.shortId, workflow: 'autonomous-v2', goal: r.state.intent?.goal ?? null,
    status: r.state.lifecycle?.status ?? null, startedAt: runStartedAt(r), finishedAt: r.state.lifecycle?.finishedAt ?? null,
    ongoing: r.ongoing, actionsSucceeded: r.state.actions?.filter((action) => action.status === 'succeeded').length ?? 0,
    actionsTotal: r.state.actions?.length ?? 0,
  };
  return {
    runId: r.runId,
    shortId: r.shortId,
    workflow: r.state?.workflow ?? null,
    status: r.state?.status ?? null,
    startedAt: runStartedAt(r),
    finishedAt: r.state?.finishedAt ?? r.report?.finishedAt ?? null,
    ongoing: r.ongoing,
    stepsOk: r.state?.steps?.filter((s) => s.ok).length ?? 0,
    stepsFailed: r.state?.steps?.filter((s) => s.ok === false).length ?? 0,
    stepsTotal: r.state?.steps?.length ?? 0,
    abortReason: r.state?.abortReason ?? null,
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
