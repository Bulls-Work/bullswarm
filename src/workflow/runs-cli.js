// bullswarm workflow runs — instance management.
//
//   bullswarm workflow runs                       # list ongoing (default)
//   bullswarm workflow runs --all                 # list ongoing + historical
//   bullswarm workflow runs --historical          # only historical
//   bullswarm workflow runs --name <workflow>     # filter by workflow name
//   bullswarm workflow runs --limit N             # cap result count
//   bullswarm workflow runs show <id>             # dump state + report
//   bullswarm workflow runs delete <id> --yes     # remove the run directory
//
// `<id>` is a shortId (6 chars) or a full runId (`wf-...`). The
// resolver in short-id.js maps both to the run directory.

import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, resolveRunId, isOngoing } from './short-id.js';
import { BULLSWARM_DIR } from './cli.js';

function jsonOut(obj, opts) { if (opts.json) console.log(JSON.stringify(obj, null, 2)); }
function err(msg) { console.error(msg); return 1; }

export function cmdRuns(args) {
  const opts = parseRunsFlags(args);
  const [sub, idToken, ...rest] = opts._positional;
  if (!sub || sub === 'list') return runsList(opts);
  if (sub === 'show') return runsShow(idToken, opts);
  if (sub === 'delete') return runsDelete(idToken, opts, rest);
  console.error(runsUsage());
  return 2;
}

export function runsUsage() {
  return `usage:
  bullswarm workflow runs                       # list ongoing runs
  bullswarm workflow runs [--all | --historical] [--name <workflow>] [--limit N] [--json]
  bullswarm workflow runs show <id>             # <id> = shortId (6 chars) or full runId
  bullswarm workflow runs delete <id> --yes     # remove the run directory`;
}

function parseRunsFlags(argv) {
  const out = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--historical') out.historical = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._positional.push(a);
  }
  return out;
}

function runsList(opts) {
  const all = listRuns(BULLSWARM_DIR());
  let filtered = all;
  if (opts.name) filtered = filtered.filter((r) => r.state?.workflow === opts.name);
  // Default scope: ongoing only. `--all` includes historical.
  if (!opts.all && !opts.historical) {
    filtered = filtered.filter((r) => r.ongoing);
  } else if (opts.historical) {
    filtered = filtered.filter((r) => !r.ongoing);
  }
  // Newest first.
  filtered.sort((a, b) => {
    const ta = a.state?.startedAt ?? '';
    const tb = b.state?.startedAt ?? '';
    return tb.localeCompare(ta);
  });
  if (opts.limit && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

  if (opts.json) {
    jsonOut({
      ongoing: opts.all || !opts.historical,
      historical: opts.all || opts.historical,
      name: opts.name ?? null,
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
    const wf = r.state?.workflow ?? '?';
    const status = r.state?.status ?? (r.ongoing ? 'running' : 'unknown');
    const age = humanAge(r.state?.startedAt);
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
  if (!idToken) return err('usage: bullswarm workflow runs show <id>');
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir } = resolved;
  const statePath = join(runDir, 'state.json');
  const reportPath = join(runDir, 'report.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const ongoing = isOngoing(runDir, state);

  if (opts.json) {
    jsonOut({ runId, shortId: resolved.shortId, runDir, ongoing, state, report }, opts);
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

function runsDelete(idToken, opts, rest) {
  if (!idToken) return err('usage: bullswarm workflow runs delete <id> --yes');
  if (!opts.yes) return err(`refusing to delete run "${idToken}" without --yes`);
  const resolved = resolveRunId(BULLSWARM_DIR(), idToken);
  if (!resolved) return err(`no run found for "${idToken}"`);

  const { runId, runDir, shortId } = resolved;
  // Refuse to delete an ongoing run without --force. Half-finished
  // runs are usually a debugging target, not garbage.
  const statePath = join(runDir, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const ongoing = isOngoing(runDir, state);
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
  return {
    runId: r.runId,
    shortId: r.shortId,
    workflow: r.state?.workflow ?? null,
    status: r.state?.status ?? null,
    startedAt: r.state?.startedAt ?? null,
    finishedAt: r.state?.finishedAt ?? null,
    ongoing: r.ongoing,
    stepsOk: r.state?.steps?.filter((s) => s.ok).length ?? 0,
    stepsFailed: r.state?.steps?.filter((s) => s.ok === false).length ?? 0,
    stepsTotal: r.state?.steps?.length ?? 0,
    abortReason: r.state?.abortReason ?? null,
  };
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
