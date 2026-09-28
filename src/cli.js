// bullswarm CLI — verbs: setup (wizard), run, health, pools.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expiringSoonView, fiveHourElapsedPct, formatResetsIn } from './lib/route.js';
import { loadState, assertDepthAllowed } from './lib/state.js';
import { buildPoolsLive, loadConnectors } from './lib/config.js';
import { getAllMeterReadings } from './meters/registry.js';
import { refusalResetKnown } from './meters/framework.js';
import { judgeContent } from './lib/verify.js';
import { getVersion } from './lib/version.js';
import { runUpdate } from './lib/update.js';
import { cmdWorkflow } from './workflow/cli.js';
import { cmdStrategy, maybeRefreshStrategy } from './strategy-cli.js';
import { cmdIntegrate, installIntegration } from './integrate.js';
import { cmdProvider } from './provider-cli.js';
import { helpForArgs, usageLine } from './help.js';
import { flagNames, unknownFlagExit } from './lib/cli-flags.js';
import { describeAssignment, listAssignments } from './lib/assignments.js';
import { attachForecast } from './lib/forecast.js';
import {
  clearPoolLabel, poolLabel, poolLabelEntries, resolvePoolId, setPoolLabel, withPoolLabels,
} from './lib/pool-labels.js';
import { NO_CALLER_NOTICE, runStepProgram, runStepRequest } from './lib/run-step.js';
import { normaliseProgramV3 } from './workflow/program-v3.js';
import { previewStepPick } from './workflow/pick-preview.js';
import { runOneStep } from './workflow/run-one-step.js';
import { runVerdictJson, runVerdictLines } from './workflow/run-verdict.js';

export function getBullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

// Backwards-compatible snapshot for external imports. Internal CLI paths
// call getBullswarmDir() so BULLSWARM_HOME is honored at invocation time.
export const BULLSWARM_DIR = getBullswarmDir();

const BOOLEAN_FLAGS = new Set([
  'overview',
  'json', 'force', 'no-caller', 'no-retry', 'yes', 'setup', 'strategy', 'integrate', 'dry-run',
  'wizard', 'check',
]);

export function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const eq = argv[i].indexOf('=');
      const key = argv[i].slice(2, eq > 0 ? eq : undefined);
      if (BOOLEAN_FLAGS.has(key)) args[key] = true;
      else if (eq > 0) args[key] = argv[i].slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else rest.push(argv[i]);
  }
  // `_flags` is what the caller literally typed, in order: the unknown-flag
  // gate needs the raw names, not the normalized `args` keys (which lose the
  // difference between an unknown flag and a value that happens to collide).
  return { ...args, rest, _flags: flagNames(argv) };
}

// --- pools ----------------------------------------------------------------

/** The bracketed meter source shown by `bullswarm pools`. */
export function meterSourceLabel(pool, nowMs = Date.now()) {
  const source = pool?.meterSource ?? 'none';
  if (source === 'quota-refusal' || pool?.quotaRefusal) {
    const refusedAt = Date.parse(
      pool?.quotaRefusedAt
        ?? pool?.quotaRefusal?.refusedAt
        ?? pool?.quotaRefusal?.refused_at
        ?? '',
    );
    const ageMs = Number.isFinite(refusedAt) ? Math.max(0, nowMs - refusedAt) : null;
    let age = 'recently';
    if (ageMs != null) {
      const minutes = Math.floor(ageMs / 60_000);
      if (minutes < 1) age = 'just now';
      else if (minutes < 60) age = `${minutes}m ago`;
      else {
        const hours = Math.floor(minutes / 60);
        age = hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
      }
    }
    // A marker whose reset was guessed keeps no pool out (framework.js).
    return refusalResetKnown(pool?.quotaRefusal ?? pool?.meterSnapshot?.quota_refusal)
      ? `blocked · refused ${age}`
      : `refused ${age} · reset unknown`;
  }
  if (source === 'stale' && pool?.meterError) {
    const holdUntil = Number(pool.meterHoldUntil);
    const remainingMs = holdUntil - nowMs;
    const retry = Number.isFinite(remainingMs) && remainingMs > 0
      ? `, retry in ${remainingMs < 60_000
        ? `${Math.ceil(remainingMs / 1000)}s`
        : `${Math.ceil(remainingMs / 60_000)}m`}`
      : '';
    return `stale · ${pool.meterError}${retry}`;
  }
  const resetTag = pool?.resetSource === 'declared' ? ' declared-reset' : '';
  return `${source}${resetTag}`;
}

/**
 * A pool's status word: `disabled`, else `ready` with the 5-hour flags. No
 * pool is ever paused or benched (state.js S1); a window at its limit shows in
 * its meter columns.
 */
export function poolStatusText(p) {
  if (!p.enabled) return 'disabled';
  const burst = p.burstGate ? ' BURST-GATED' : '';
  const nearLimit = p.nearFiveHourLimit === true ? ' NEAR-5H-LIMIT' : '';
  return `ready${burst}${nearLimit}`;
}

function knownPoolIds(home) {
  return [...new Set([
    ...Object.keys(loadConnectors(home, { packaged: true })),
    ...Object.keys(loadState(home).pools ?? {}),
  ])];
}

function cmdPoolsLabel(opts) {
  const home = getBullswarmDir();
  if (opts.list === true) {
    if (opts.rest.length !== 1) {
      console.error(`usage: ${usageLine(['pools', 'label'])}`);
      return 2;
    }
    const entries = poolLabelEntries(home);
    if (opts.json) console.log(JSON.stringify({ labels: entries }, null, 2));
    else if (!entries.length) console.log('no pool labels configured');
    else for (const entry of entries) console.log(`${entry.pool}  ${entry.poolLabel}`);
    return 0;
  }
  const typed = opts.rest[1];
  const pool = resolvePoolId(typed, home);
  try {
    let result;
    if (opts.clear === true) {
      if (!typed || opts.rest.length !== 2) throw new Error(`usage: ${usageLine(['pools', 'label'])}`);
      result = clearPoolLabel(home, pool, knownPoolIds(home));
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.cleared ? `cleared label for ${pool}` : `${pool} had no label`);
      return 0;
    }
    const label = opts.rest[2];
    if (!typed || !label || opts.rest.length !== 3) throw new Error(`usage: ${usageLine(['pools', 'label'])}`);
    result = setPoolLabel(home, pool, label, knownPoolIds(home));
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.pool} displays as ${result.poolLabel}`);
    return 0;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 2;
  }
}

async function cmdPools(opts) {
  if (opts.rest[0] === 'label') return cmdPoolsLabel(opts);
  if (opts.rest.length) {
    console.error(`✗ unknown pools subcommand "${opts.rest[0]}"`);
    console.error(`usage: ${usageLine(['pools'])}`);
    return 2;
  }
  const now = Date.now();
  const { state, pools } = await buildPoolsLive(getBullswarmDir(), now, {
    packaged: true,
    force: opts.force === true,
    getReadings: getAllMeterReadings,
  });
  // Current cross-process load, from the shared ledger rather than this
  // process's own memory: work another Bullswarm started still shows here —
  // plus the spend rates that turn that load into a projected utilization.
  attachForecast(pools, getBullswarmDir(), { now, decisionLog: state.decisionLog ?? [] });
  if (opts.json) {
    console.log(JSON.stringify({ pools }, null, 2));
    return 0;
  }
  for (const p of pools) {
    const src = p.meterSource;
    // Name the window the numbers came from: `used`/`elapsed` mean different
    // things for a weekly-paced and a monthly-paced pool, and the surplus
    // routing compares is this window's. Only a real window reading is
    // labeled — a declared meter has a number but no window.
    const window = p.pacingWindow && p.elapsedPct != null ? `${p.pacingWindow} ` : '';
    // A window whose end the operator declared (the provider reported none)
    // is paced from that date and says so; the used% is still the provider's.
    const meter = src === 'none'
      ? 'unmetered'
      : `${window}used ${p.usedPct ?? '?'}% elapsed ${p.elapsedPct ?? '?'}% [${meterSourceLabel(p, now)}]`;
    // 5h is a gate, never a pace (doctrine M3): show the reading and whether
    // routing now deprioritizes this pool for it. When in-flight work makes
    // the projection differ from the reading, both are shown — routing decides
    // on the right-hand number.
    const readingPct = p.fiveHourUsedPct == null ? null : Math.round(p.fiveHourUsedPct * 10) / 10;
    const projectedPct = p.projectedFiveHourPct == null
      ? null
      : Math.round(p.projectedFiveHourPct * 10) / 10;
    // R10: the same reading means different things at different points in the
    // window, so show where the window stands when the provider reported it.
    const elapsed = fiveHourElapsedPct(p);
    const clock = elapsed == null ? '' : ` (${Math.round(elapsed)}% elapsed)`;
    const fiveHour = readingPct == null
      ? (projectedPct == null ? '' : ` 5h=?->${projectedPct}%${clock}`)
      : ` 5h=${readingPct}%${projectedPct != null && projectedPct !== readingPct ? `->${projectedPct}%` : ''}${clock}`;
    // R11: a pacing window about to reset is quota about to be lost, so say
    // when it closes and how urgent what is left has become. Pools whose
    // window is not closing soon print nothing extra.
    const expiring = expiringSoonView(p, { now });
    const expiringNote = expiring.expiringSoon
      ? ` resets in ${formatResetsIn(expiring.minutesToReset)} EXPIRING-SOON`
        + ` urgency=${Math.round(expiring.urgency)}`
      : '';
    // R12: the model this pool would run costs nothing, so routing puts it
    // ahead of every metered pool while it is healthy. `pools` names no lane
    // and therefore no effort tier, and free-ness is per tier — so the tiers
    // that hold a free model are named one by one rather than collapsed into a
    // single claim that would be untrue on the others.
    const freeTiers = Object.entries(p.freeTiers ?? {});
    const free = p.free === true
      ? ` free=${p.freeModel ?? '?'}`
      : freeTiers.length
        ? ` free=${freeTiers.map(([tier, model]) => `${tier}:${model}`).join(',')}`
        : '';
    const display = p.poolLabel ?? poolLabel(p.name, getBullswarmDir());
    const status = poolStatusText(p);
    console.log(
      `${display.padEnd(14)} cost=${p.costRank} lanes=${p.lanes.join('/')} ${meter} surplus=${p.pace ?? '-'} inflight=${p.inflight?.count ?? 0}${fiveHour}${free} ${status}${expiringNote}`,
    );
  }
  return 0;
}

// --- assignments --------------------------------------------------------------
// The in-flight ledger, read straight from disk: no meters, no network, no
// pool build — just what is running right now across every Bullswarm process.

function cmdAssignments(opts) {
  const now = Date.now();
  const records = listAssignments(getBullswarmDir(), { now });
  if (opts.json) {
    console.log(JSON.stringify(
      records.map((r) => ({ ...r, poolLabel: poolLabel(r.pool, getBullswarmDir()), ...describeAssignment(r, now) })),
      null,
      2,
    ));
    return 0;
  }
  if (!records.length) {
    console.log('no in-flight assignments');
    return 0;
  }
  for (const r of records) {
    const view = describeAssignment(r, now);
    const work = `${r.lane ?? '?'}/${r.effort ?? '?'}`;
    const target = [r.runId, r.actionId].filter(Boolean).join('/') || '-';
    const expected = view.expectedMinutes == null ? 'unknown' : `${view.expectedMinutes}m`;
    console.log(
      `${poolLabel(r.pool, getBullswarmDir()).padEnd(14)} ${work.padEnd(14)} ${(r.source ?? '-').padEnd(11)} ${target} `
      + `age=${view.elapsedMinutes ?? '?'}m expected=${expected} `
      + `worker=${r.workerPid ?? 'spawning'}`,
    );
  }
  return 0;
}

// --- run --------------------------------------------------------------------
// A one-step v3 workflow (0.37.0): src/lib/run-step.js reads the flags,
// src/workflow/run-one-step.js runs the kernel, run-verdict.js prints.

async function cmdRun(opts) {
  const parsed = runStepRequest(opts);
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  const { request } = parsed;
  if (!existsSync(request.targetDir) || !statSync(request.targetDir).isDirectory()) {
    console.error(`--add-dir is not an existing directory: ${request.targetDir}`);
    return 2;
  }
  if (request.noCaller) console.error(NO_CALLER_NOTICE);
  const home = getBullswarmDir();
  // Recursion guard FIRST — core-owned, env handshake.
  const state = loadState(home);
  try {
    assertDepthAllowed(state);
  } catch (err) {
    emitRun({ ok: false, failureKind: 'depth', why: err.message }, opts);
    return 1;
  }
  let verdict;
  if (request.dryRun) {
    // A preview is a pure read (D3): no strategy refresh, no ledger entry, no
    // decision log, no run folder.
    const { pools } = await buildPoolsLive(home, Date.now(), { getReadings: getAllMeterReadings });
    const [action] = normaliseProgramV3(runStepProgram(request)).steps;
    verdict = await previewStepPick({
      action, pools, bullswarmDir: home, coreState: state, targetDir: request.targetDir, runReasoning: request.reasoning,
    });
  } else {
    // Only an explicitly approved strategy policy may change assignments.
    await maybeRefreshStrategy(home);
    const { pools } = await buildPoolsLive(home, Date.now(), { getReadings: getAllMeterReadings });
    verdict = await runOneStep({ bullswarmDir: home, request, pools });
  }
  emitRun(verdict, opts);
  return verdict.ok ? 0 : 1;
}

function emitRun(verdict, opts) {
  if (opts.json) console.log(runVerdictJson(verdict, getBullswarmDir()));
  else for (const line of runVerdictLines(verdict, getBullswarmDir())) console.log(line);
}

// --- health -----------------------------------------------------------------

function cmdHealth(opts) {
  // An observation command: it reads state.json and never writes it.
  const state = loadState(getBullswarmDir());
  const runsDir = join(getBullswarmDir(), 'runs');
  const findings = [];

  // Correlate each logged decision with its saved output: the doctrine
  // signal is "verdict said FAIL but the file re-judges OK" — that means
  // the verify gate ate real work. Verdict-FAIL files that still re-judge
  // pass are exactly the planted case; verdict-OK files are expected passes.
  if (existsSync(runsDir)) {
    const byOut = new Map(
      (state.decisionLog ?? [])
        .filter((d) => d.outFile)
        .map((d) => [d.outFile, d]),
    );
    for (const f of readdirSync(runsDir)) {
      if (!f.startsWith('out-')) continue;
      const outPath = join(runsDir, f);
      const out = readFileSync(outPath, 'utf8');
      if (!out.trim()) continue;
      const j = judgeContent(out);
      const decision = byOut.get(outPath);
      findings.push({
        file: f,
        savedVerdict: decision ? (decision.ok ? 'OK' : 'FAIL') : 'unlogged',
        rejudge: j.verdict,
        gateAteWork:
          decision != null && decision.ok === false && j.verdict === 'pass',
      });
    }
  }

  const report = {
    // Healthy is the absence of the defect this command can actually see: a
    // verify gate that ate real work. An empty decision log means nothing has
    // been dispatched yet, which is a fresh home rather than a fault, so it
    // is reported (below) but never counted against health.
    healthy: findings.every((f) => !f.gateAteWork),
    gateFailures: findings.filter((f) => f.gateAteWork),
    decisionLogSize: state.decisionLog?.length ?? 0,
  };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.healthy ? 0 : 1;
  }
  // Same facts as the JSON document, one line each, so `--json` selects a
  // format instead of being the inert flag it used to be.
  console.log(`bullswarm health — ${report.healthy ? 'HEALTHY' : 'UNHEALTHY'}`);
  console.log(`  decision log: ${report.decisionLogSize} entr${report.decisionLogSize === 1 ? 'y' : 'ies'}`);
  console.log(`  gate failures: ${report.gateFailures.length}`);
  for (const f of report.gateFailures) {
    console.log(`    ✗ ${f.file}: saved ${f.savedVerdict}, re-judges ${f.rejudge} — the verify gate ate real work`);
  }
  if (!report.healthy) console.log('  fix: bullswarm health --json for the machine-readable report');
  return report.healthy ? 0 : 1;
}

// --- setup ------------------------------------------------------------------

/**
 * What bare `bullswarm` does, as a pure decision so the dispatch is testable
 * without a terminal. `tty` means both streams are terminals (the dashboard
 * cannot be drawn otherwise); `configured` is state.json existing BEFORE this
 * invocation self-initialized, else a fresh machine could never reach setup.
 * Returns:
 *   dashboard  — configured interactive terminal: the dashboard's Home page
 *   setup      — not configured yet, or --setup: the interactive control center
 *   setup-auto — --yes or no terminal: discovered defaults, never prompts
 */
export function decideBareCommand({
  tty = false, yes = false, setup = false, configured = false,
} = {}) {
  if (setup) return 'setup';
  if (yes || !tty) return 'setup-auto';
  return configured ? 'dashboard' : 'setup';
}

async function cmdSetup(opts) {
  const { runWizard, autoSetup, openSetupTui } = await import('./setup.js');
  // Agent-friendly: --yes (or no TTY on stdin) initializes with discovered
  // defaults and never prompts.
  if (opts.yes || !process.stdin.isTTY) {
    const r = autoSetup(getBullswarmDir(), { reason: opts.yes ? 'flag' : 'non-tty' });
    let strategy = null;
    if (opts.yes && opts.strategy) {
      const { refreshStrategy, applyStrategyRecommendations } = await import('./strategy-cli.js');
      const report = await refreshStrategy(getBullswarmDir(), { useOpenRouter: true });
      strategy = applyStrategyRecommendations(getBullswarmDir(), report);
    }
    let integration = null;
    if (opts.yes && opts.integrate) {
      integration = installIntegration({
        agents: opts.agents,
        approved: true,
      });
    }
    if (opts.json) console.log(JSON.stringify({ ok: true, mode: 'auto', ...r, strategy, integration }, null, 2));
    else {
      console.log(withPoolLabels(`setup complete (${r.reason}): enabled ${r.enabledPools.join(', ')}`, getBullswarmDir()));
      if (r.repaired.length) console.log(`retired older connector copies (the packaged connectors load instead): ${r.repaired.join(', ')}`);
      console.log(`model strategy: ${r.strategyCommand} (discovers models and refreshes tier suggestions)`);
      if (strategy) {
        const { applySummaryLines } = await import('./strategy-cli.js');
        for (const line of applySummaryLines(strategy)) console.log(withPoolLabels(line, getBullswarmDir()));
        const { recommendedReasoningLines } = await import('./setup.js');
        for (const line of recommendedReasoningLines(strategy.reasoning)) console.log(line);
      }
      if (integration) console.log('agent integration: installed (inspect with bullswarm integrate status)');
    }
    return 0;
  }
  if (!opts.json && !opts.wizard && !opts.integrate) {
    // The control center's own options live in src/setup.js (openSetupTui) so
    // the dashboard's `[edit]` hand-off opens the same screen with the same
    // title, analysis prompt, inventory loader and apply hook — no second copy
    // to drift.
    return openSetupTui({
      bullswarmDir: getBullswarmDir(), input: process.stdin, output: process.stdout,
    });
  }
  return runWizard(getBullswarmDir(), opts);
}

// --- doctor -------------------------------------------------------------------
// Machine-readable readiness report for agents: what works, what's missing,
// exactly which command fixes each gap. Never prompts.

async function cmdDoctor(opts) {
  const { discoverConnectors, isConfigured, autoSetup } = await import('./setup.js');
  const checks = [];
  let configured = isConfigured(getBullswarmDir());

  checks.push({
    id: 'config',
    ok: configured,
    detail: configured ? `${getBullswarmDir()}/state.json present` : 'no config yet',
    fix: 'bullswarm setup --yes   # or run any verb; it self-initializes',
  });

  // Self-heal before reporting when not configured — an agent calling
  // doctor should end up ready-to-use in the same invocation.
  if (!configured) {
    autoSetup(getBullswarmDir(), { reason: 'doctor' });
    configured = true;
    checks[0] = { ...checks[0], ok: true, detail: `initialized at ${getBullswarmDir()} (was missing)` };
  }

  const discovered = discoverConnectors();
  const found = discovered.filter((d) => d.discovered && !d.broken && !d.testFixture);
  checks.push({
    id: 'connectors',
    ok: found.length > 0,
    detail: `${found.length} agent CLI(s) found: ${found.map((d) => d.name).join(', ') || '(none)'}`,
    fix: found.length ? null : 'install at least one agent CLI (codex, grok, opencode…)',
  });

  // Copies of packaged connectors an older install left in <home>/connectors/
  // (src/lib/connector-copies.js). Unmodified ones were retired by the
  // first-use pass that ran before this verb; an edited copy is kept, and
  // this check names its stale fields. A warning, never a failed readiness.
  try {
    const {
      inspectConnectorCopies, connectorCopyWarnings, retiredConnectorCopies,
    } = await import('./lib/connector-copies.js');
    const copies = inspectConnectorCopies(getBullswarmDir());
    const warnings = connectorCopyWarnings(copies);
    const retired = retiredConnectorCopies(getBullswarmDir());
    checks.push({
      id: 'connector-copies',
      ok: true,
      warn: warnings.length > 0,
      detail: warnings.length
        ? `${warnings.length} connector cop${warnings.length === 1 ? 'y' : 'ies'} in ${getBullswarmDir()}/connectors ${warnings.length === 1 ? 'differs' : 'differ'} from the package`
        : `no copies of packaged connectors in use${retired.length ? `; retired: ${retired.join(', ')} (connectors/retired/)` : ''}`,
      lines: warnings,
      fix: warnings.length
        ? 'compare each copy with the packaged connector.json; move it into connectors/retired/ to use the package'
        : null,
      copies: copies.map(({ file, provider, pool, status, staleFields, editedFields, read, servedBy }) => ({
        file, provider, pool, status, staleFields, editedFields, read, servedBy,
      })),
      retired,
    });
  } catch (err) {
    checks.push({ id: 'connector-copies', ok: true, warn: true, detail: `could not inspect connector copies: ${err.message}`, fix: null });
  }

  try {
    const { pools } = await buildPoolsLive(getBullswarmDir(), Date.now(), {
    packaged: true,
      getReadings: getAllMeterReadings,
    });
    const live = pools.filter((p) => p.meterSource === 'live' || p.meterSource === 'cache');
    const enabled = pools.filter((p) => p.enabled);
    const delegates = enabled.filter((p) => !p.testFixture);
    checks.push({
      id: 'meters',
      ok: enabled.length > 0,
      detail: `${live.length}/${pools.length} pools with provider meters; ${enabled.length} enabled`,
      fix: enabled.length ? null : 'bullswarm setup --yes',
    });
    checks.push({
      id: 'offload-capable',
      ok: delegates.length > 0,
      detail: `enabled delegate pools: ${delegates.map((p) => p.name).join(', ') || 'none'}`,
      fix: delegates.length ? null : 'install an agent CLI and run bullswarm setup --yes',
    });
  } catch (err) {
    checks.push({ id: 'meters', ok: false, detail: err.message, fix: 'check network / re-run' });
  }

  const report = {
    version: getVersion(),
    configured,
    ok: checks.every((c) => c.ok),
    checks,
    nextActions: checks.filter((c) => !c.ok && c.fix).map((c) => c.fix),
  };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`bullswarm doctor (v${report.version}) — ${report.ok ? 'READY' : 'DEGRADED'}`);
    for (const c of checks) {
      console.log(withPoolLabels(`  ${c.ok ? (c.warn ? '!' : '✓') : '✗'} ${c.id}: ${c.detail}`, getBullswarmDir()));
      for (const line of c.lines ?? []) console.log(withPoolLabels(`      ${line}`, getBullswarmDir()));
      if ((!c.ok || c.warn) && c.fix) console.log(`      fix: ${c.fix}`);
    }
  }
  return report.ok ? 0 : 1;
}

// --- main ---------------------------------------------------------------------

// Which help path explains the verb this argv is dispatching to, i.e. which
// row of the known-flag table applies. Returns null for the verbs that own
// their own parser (workflow/runs/strategy/provider/home) and for an unrecognized verb,
// which the dispatcher already answers with exit 2.
function topLevelHelpPath(verb, opts) {
  const OWN_PARSER = new Set(['workflow', 'runs', 'strategy', 'provider', 'home']);
  if (verb === undefined) return [];
  if (verb === '--version') return ['version'];
  if (OWN_PARSER.has(verb)) return null;
  if (verb === 'pools' && opts.rest[0] === 'label') return ['pools', 'label'];
  if (verb === 'integrate') {
    const sub = opts.rest[0] ?? 'status';
    return ['status', 'install', 'remove', 'retire-legacy'].includes(sub)
      ? ['integrate', sub]
      : ['integrate'];
  }
  return [verb];
}

export async function main(argv) {
  // Bare `bullswarm workflow` is the human workflow home on a terminal.
  // Non-TTY callers still receive side-effect-free help, exactly as before.
  const bareWorkflowDashboard = argv.length === 1
    && argv[0] === 'workflow'
    && process.stdin.isTTY
    && process.stdout.isTTY;
  const bareStrategyDashboard = argv.length === 1
    && argv[0] === 'strategy'
    && process.stdin.isTTY
    && process.stdout.isTTY;
  const help = bareWorkflowDashboard || bareStrategyDashboard ? null : helpForArgs(argv);
  if (help) {
    console.log(help);
    return 0;
  }
  // A leading flag means the root command: `bullswarm --yes` is bare
  // bullswarm with its documented option, not a verb named "--yes".
  const [head, ...tail] = argv;
  const verb = head !== undefined && /^--[A-Za-z]/.test(head) && head !== '--version'
    ? undefined
    : head;
  const opts = parseArgs(verb === undefined && head !== undefined ? argv : tail);

  // Unknown flags are a usage error before anything else happens — before
  // setup self-initializes, before a pool is built, before a delegate is
  // spawned. `workflow`, `runs`, `strategy`, `provider` and `home` re-parse their own argv, so
  // they run the same gate inside their own dispatchers.
  const flagExit = unknownFlagExit(opts._flags, topLevelHelpPath(verb, opts));
  if (flagExit !== null) return flagExit;

  const { ensureSetup, isConfigured } = await import('./setup.js');

  // Read BEFORE ensureSetup() below: that call self-initializes a fresh home,
  // and a home that only exists because of this very invocation has not been
  // configured by anyone yet — that difference is exactly what decides between
  // setup and the dashboard for a bare `bullswarm`.
  const wasConfigured = isConfigured(getBullswarmDir());

  // Agent-friendly guarantee: EVERY verb works on a fresh machine. If config
  // is missing, self-initialize with discovered defaults (never prompts).
  // Home snapshots are explicitly read-only against their source home. Do
  // not run the normal first-use metadata migration before the snapshot
  // command gets a chance to read it.
  if (verb !== 'home') ensureSetup(getBullswarmDir());

  switch (verb) {
    case undefined: {
      // Bare bullswarm: the dashboard on a configured terminal, the setup
      // control center when nothing is configured, and the historical
      // auto-setup for --yes or any non-TTY caller (agents, scripts).
      const decision = decideBareCommand({
        tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
        yes: opts.yes === true,
        setup: opts.setup === true,
        configured: wasConfigured,
      });
      if (decision === 'dashboard') {
        // Lazy: a terminal UI no other verb needs, and nothing a non-dashboard
        // caller should pay to load.
        const { runDashboard } = await import('./workflow/dashboard.js');
        return runDashboard(getBullswarmDir(), { input: process.stdin, output: process.stdout });
      }
      if (decision === 'setup-auto') return cmdSetup({ ...opts, yes: true });
      return cmdSetup(opts);
    }
    case 'setup':
      return cmdSetup(opts);
    case 'run':
      return cmdRun(opts);
    case 'health':
      return cmdHealth(opts);
    case 'pools':
      return cmdPools(opts);
    case 'assignments':
      return cmdAssignments(opts);
    case 'doctor':
      return cmdDoctor(opts);
    case 'workflow':
      return cmdWorkflow(tail);
    case 'runs':
      return cmdWorkflow(['runs', ...tail], { runsAlias: ['runs'] });
    case 'strategy':
      return cmdStrategy(bareStrategyDashboard ? ['tui'] : tail, {
        bullswarmDir: getBullswarmDir(), input: process.stdin, output: process.stdout,
      });
    case 'integrate':
      return cmdIntegrate(opts);
    case 'provider':
      return cmdProvider(tail, { bullswarmDir: getBullswarmDir() });
    case 'home': {
      const { cmdHome } = await import('./home-cli.js');
      return cmdHome(tail, { bullswarmDir: getBullswarmDir() });
    }
    case 'version':
    case '--version':
      console.log(getVersion());
      return 0;
    case 'update':
      // Registry, npm and git are the sources of truth; the exit code says
      // whether the package is at the latest published version afterwards.
      return runUpdate({
        check: opts.check === true, json: opts.json === true, currentVersion: getVersion(),
      });
    default:
      console.error(`unknown verb "${verb}". Run "bullswarm --help" for the list of commands.`);
      return 2;
  }
}

