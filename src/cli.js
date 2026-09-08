// bullswarm CLI — verbs: setup (wizard), run, health, pools.

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pickPool } from './lib/route.js';
import { argvWithModel, watchOnce } from './lib/watch.js';
import {
  isReasoningLevel, REASONING_DEFAULT, REASONING_LEVELS, resolveReasoningLevel,
} from './lib/reasoning.js';
import {
  loadState, saveState, quarantinePool, sweepQuarantines,
  assertDepthAllowed, childDepthEnv,
} from './lib/state.js';
import { buildPools, buildPoolsLive } from './lib/config.js';
import { getAllMeterReadings } from './meters/registry.js';
import { judgeContent } from './lib/verify.js';
import { getVersion } from './lib/version.js';
import { release } from './lib/release.js';
import { cmdWorkflow } from './workflow/cli.js';
import { DEFAULT_EFFORT_BY_LANE } from './workflow/action-validator.js';
import {
  applyStrategyRecommendations, cmdStrategy, loadStrategyInventory, maybeRefreshStrategy,
} from './strategy-cli.js';
import { startStrategyDashboard } from './strategy-dashboard.js';
import { cmdIntegrate, installIntegration } from './integrate.js';
import { helpForArgs, usageLine } from './help.js';
import { disabledModelsForPool, resolveDispatchModel, selectedModelsForTier } from './lib/strategy.js';
import { createRunHeartbeat } from './lib/run-heartbeat.js';
import {
  describeAssignment, expectedMinutesFromSpendModel, listAssignments,
  registerAssignment, releaseAssignment, updateAssignment, withLedger,
} from './lib/assignments.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from './lib/forecast.js';

export function getBullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}

// Backwards-compatible snapshot for external imports. Internal CLI paths
// call getBullswarmDir() so BULLSWARM_HOME is honored at invocation time.
export const BULLSWARM_DIR = getBullswarmDir();

const BOOLEAN_FLAGS = new Set([
  'json', 'force', 'no-caller', 'yes', 'strategy', 'integrate', 'dry-run',
  'wizard',
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
  return { ...args, rest };
}

// --- pools ----------------------------------------------------------------

async function cmdPools(opts) {
  const now = Date.now();
  const { state, pools } = await buildPoolsLive(getBullswarmDir(), now, {
    force: opts.force === true,
    getReadings: getAllMeterReadings,
  });
  const released = sweepQuarantines(state, now);
  if (released.length && !opts.json) {
    console.error(`quarantine expired, returned to service: ${released.join(', ')}`);
  }
  saveState(getBullswarmDir(), state);
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
    const meter = src === 'none'
      ? 'unmetered'
      : `used ${p.usedPct ?? '?'}% elapsed ${p.elapsedPct ?? '?'}% [${src}]`;
    const burst = p.burstGate ? ' BURST-GATED' : '';
    // 5h is a gate, never a pace (doctrine M3): show the reading and whether
    // routing now deprioritizes this pool for it. When in-flight work makes
    // the projection differ from the reading, both are shown — routing decides
    // on the right-hand number.
    const readingPct = p.fiveHourUsedPct == null ? null : Math.round(p.fiveHourUsedPct * 10) / 10;
    const projectedPct = p.projectedFiveHourPct == null
      ? null
      : Math.round(p.projectedFiveHourPct * 10) / 10;
    const fiveHour = readingPct == null
      ? (projectedPct == null ? '' : ` 5h=?->${projectedPct}%`)
      : ` 5h=${readingPct}%${projectedPct != null && projectedPct !== readingPct ? `->${projectedPct}%` : ''}`;
    const nearLimit = p.nearFiveHourLimit === true ? ' NEAR-5H-LIMIT' : '';
    const status = !p.enabled
      ? 'disabled'
      : p.quarantine
        ? `QUARANTINED until ${new Date(p.quarantine.until).toLocaleTimeString()} (${p.quarantine.reason})`
        : `ready${burst}${nearLimit}`;
    console.log(
      `${p.name.padEnd(14)} cost=${p.costRank} lanes=${p.lanes.join('/')} ${meter} surplus=${p.pace ?? '-'} inflight=${p.inflight?.count ?? 0}${fiveHour} ${status}`,
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
      records.map((r) => ({ ...r, ...describeAssignment(r, now) })),
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
      `${r.pool.padEnd(14)} ${work.padEnd(14)} ${(r.source ?? '-').padEnd(11)} ${target} `
      + `age=${view.elapsedMinutes ?? '?'}m expected=${expected} `
      + `worker=${r.workerPid ?? 'spawning'}`,
    );
  }
  return 0;
}

// --- run --------------------------------------------------------------------

async function cmdRun(opts) {
  const now = Date.now();
  const lane = opts.lane;
  const heartbeatSec = opts.heartbeat == null || opts.heartbeat === true ? null : Number(opts.heartbeat);
  if (opts.heartbeat === true || (heartbeatSec != null && (!Number.isFinite(heartbeatSec) || heartbeatSec < 1))) {
    console.error('--heartbeat must be a number of seconds greater than or equal to 1');
    return 2;
  }
  const effortTier = opts.effort ?? (DEFAULT_EFFORT_BY_LANE[lane] ?? null);
  if (effortTier && !['high', 'medium', 'low'].includes(effortTier)) {
    console.error('--effort must be high, medium, or low');
    return 2;
  }
  // The run-wide reasoning override. Validated here so a typo is a usage
  // error, never a silently-ignored preference that the record then claims.
  if (opts.reasoning === true) {
    console.error('usage: --reasoning requires a value');
    return 2;
  }
  if (opts.reasoning != null && !isReasoningLevel(opts.reasoning)) {
    console.error(`--reasoning must be one of ${[...REASONING_LEVELS, REASONING_DEFAULT].join(', ')}`);
    return 2;
  }
  const targetDir = resolve(opts['add-dir'] ?? process.cwd());

  // Validate task input before routing so malformed invocations never fall
  // through to the caller-session path.
  if (opts['task-file'] === true || opts.prompt === true ||
      (opts['task-file'] != null && typeof opts['task-file'] !== 'string') ||
      (opts.prompt != null && typeof opts.prompt !== 'string')) {
    console.error('usage: --prompt and --task-file require a value');
    return 2;
  }
  if (opts['task-file'] && opts.prompt != null) {
    console.error('usage: choose one of --prompt, --task-file, or trailing task text');
    return 2;
  }
  if (opts['task-file'] && opts.rest.length) {
    console.error('usage: choose one of --task-file or trailing task text');
    return 2;
  }
  if (opts.prompt != null && opts.rest.length) {
    console.error('usage: choose one of --prompt or trailing task text');
    return 2;
  }
  const taskText = opts['task-file']
    ? readFileSync(opts['task-file'], 'utf8')
    : opts.prompt ?? opts.rest.join(' ');
  if (!taskText.trim()) {
    console.error('empty task: pass --task-file, --prompt, or the task as arguments');
    return 2;
  }

  // Recursion guard FIRST — core-owned, env handshake.
  let state = loadState(getBullswarmDir());
  try {
    assertDepthAllowed(state);
  } catch (err) {
    const verdict = { ok: false, keepOnClaude: true, why: err.message };
    console.log(JSON.stringify(verdict, null, 2));
    return 1;
  }

  // Only an explicitly approved strategy policy may change assignments.
  // Once approved, refresh capability-aware recommendations on its TTL.
  await maybeRefreshStrategy(getBullswarmDir());
  state = loadState(getBullswarmDir());

  sweepQuarantines(state, now);

  const { pools } = await buildPoolsLive(getBullswarmDir(), now, {
    getReadings: getAllMeterReadings,
  });
  for (const p of pools) {
    p.incumbent = state.incumbents?.[lane] === p.name;
  }
  // Route on the forecast, not on the reading: what every Bullswarm process
  // has in flight right now, and how fast each pool burns its windows. Read
  // before the eligible-pool copies are made so the fields survive the spread.
  attachForecast(pools, getBullswarmDir(), { now, decisionLog: state.decisionLog ?? [] });
  // The duration this assignment is booked for — the same number the ledger
  // will publish for it (F3), so routing and every other process agree.
  const expected = await expectedMinutesFromSpendModel(
    { lane, effort: effortTier },
    { decisionLog: state.decisionLog ?? [] },
  );

  // Burst gate (M3): a pool whose 5h window is >=90% used is excluded from
  // dispatch entirely this run — it paces nothing, it's just out of burst room.
  const gated = pools.filter((p) => p.burstGate);
  const ungatedPools = gated.length ? pools.filter((p) => !p.burstGate) : pools;
  const assignment = state.strategy?.assignments?.[effortTier] ?? null;
  const eligiblePools = ungatedPools.map((pool) => ({
    ...pool,
    modelPolicy: resolveDispatchModel(pool.connector ?? pool, effortTier, {
      assignment,
      excludedModels: [
        ...(state.strategy?.excludedModels ?? []),
        ...disabledModelsForPool(state.strategy, pool.name),
      ],
      allowedModels: selectedModelsForTier(state.strategy, pool.name, effortTier),
    }),
  })).filter((pool) => pool.modelPolicy.eligible);

  const route = pickPool(lane, eligiblePools, {
    callerEligible: opts['no-caller'] !== true,
    callerName: state.config.callerName ?? 'claude-code',
    now,
    preferredPool: state.strategy?.assignments?.[effortTier]?.pool ?? null,
    effortTier,
    candidateMinutes: expected.expectedMinutes,
    inflightPenaltyPct: inflightPenaltyFrom(state),
  });
  if (gated.length && route.pick) {
    route.why += ` (burst-gated: ${gated.map((g) => g.name).join(', ')})`;
  }

  const dryRun = opts['dry-run'] === true;
  if (!route.pick && route.keepOnClaude) {
    // A preview never writes: the decision log records dispatches, not what
    // an operator merely asked to see.
    if (!dryRun) {
      logDecision(state, {
        lane, picked: null, keepOnClaude: true, ok: null, why: route.why,
        forecast: forecastRecord(route, null),
      });
      saveState(getBullswarmDir(), state);
    }
    emit({
      ok: true, keepOnClaude: true, ...(dryRun ? { dryRun: true } : {}),
      why: route.why, pick: { pool: null, command: null },
      forecast: forecastRecord(route, null), candidates: route.candidates,
    }, opts);
    return 0;
  }
  if (!route.pick) {
    emit({ ok: false, keepOnClaude: false, why: route.why }, opts);
    return 1;
  }

  // pick.connector is the pool VIEW (config.js buildPools entry); the real
  // connector spec lives one level down.
  const poolView = route.pick.connector ?? { name: route.pick.pool };
  const connector = poolView.connector ?? poolView;
  const selectedModel = poolView.modelPolicy?.model
    ?? (assignment?.pool === connector.name ? assignment.model : null);
  const runtimeConnector = {
    ...connector,
    subscription: poolView.subscription ?? connector.subscription ?? null,
  };

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const runDir = join(getBullswarmDir(), 'runs');
  mkdirSync(runDir, { recursive: true });
  const paths = {
    taskFile: join(runDir, `task-${stamp}.md`),
    outFile: join(runDir, `out-${stamp}.md`),
  };

  // One resolution per attempt, from the connector that will actually be
  // spawned, the effort tier that picked the model, and the live strategy.
  const reasoning = resolveReasoningLevel({
    connector: runtimeConnector,
    tier: effortTier,
    model: selectedModel,
    strategy: state.strategy ?? null,
    runOverride: opts.reasoning ?? null,
  });

  if (dryRun) {
    // Preview through argvWithModel — the same builder runDelegate uses — so
    // the printed command can never drift from the one that would be spawned.
    // The forecast is reported exactly as a real dispatch would route on it;
    // F1 keeps the preview a pure read — no ledger entry, no decision log.
    emit({
      ok: true,
      dryRun: true,
      keepOnClaude: false,
      why: route.why,
      forecast: forecastRecord(route, connector.name),
      candidates: route.candidates,
      pick: {
        pool: connector.name,
        model: selectedModel,
        command: argvWithModel(
          runtimeConnector,
          { taskFile: paths.taskFile, cwd: targetDir },
          selectedModel,
          null,
          reasoning,
        ),
      },
      reasoning,
    }, opts);
    return 0;
  }

  const heartbeat = createRunHeartbeat({ intervalSec: heartbeatSec });
  heartbeat.start();
  // Registered the moment the pool is picked, before the worker exists, so no
  // other process sees this pool as idle while the CLI is still spawning. The
  // expectation is the one routing already booked this assignment for (F3).
  const ledgerEntry = withLedger(() => registerAssignment(getBullswarmDir(), {
    pool: connector.name,
    model: selectedModel ?? connector.model ?? null,
    lane: lane ?? null,
    effort: effortTier ?? null,
    source: 'run',
    ...expected,
  }));
  let verdict;
  try {
    verdict = await watchOnce(runtimeConnector, taskText, targetDir, paths, {
      // Long-running coding agents are allowed to finish by default. `--timeout`
      // remains an explicit operator escape hatch; connector metadata no longer
      // imposes a hidden wall-clock kill timer.
      timeoutSec: opts.timeout == null ? null : Number(opts.timeout),
      env: childDepthEnv(process.env),
      model: selectedModel,
      reasoning,
      // Lets a usage-limit verdict fall back to this pool's cached 5h meter
      // reset when the provider's message named no reset time of its own.
      bullswarmDir: getBullswarmDir(),
      onActivity: (event) => heartbeat.activity(event),
      onAgentEvent: () => heartbeat.event(),
      onSpawn: (pid) => {
        if (ledgerEntry) withLedger(() => updateAssignment(getBullswarmDir(), ledgerEntry.id, { workerPid: pid }));
      },
    });
  } finally {
    heartbeat.stop();
    if (ledgerEntry) withLedger(() => releaseAssignment(getBullswarmDir(), ledgerEntry.id));
  }

  // Persist incumbency on success; quarantine hint on auth failure.
  if (verdict.ok) {
    state.incumbents ??= {};
    state.incumbents[lane] = connector.name;
  } else if (verdict.quarantineHint) {
    // A usage limit carries its own deadline (the reset the provider named);
    // an auth failure keeps the flat re-probe window.
    quarantinePool(state, connector.name, verdict.why, now, {
      until: verdict.quarantineUntil ?? null,
      kind: verdict.failureKind === 'quota' ? 'quota' : 'auth',
    });
    verdict.quarantinedUntil = state.pools[connector.name]?.quarantine?.until;
  }

  logDecision(state, {
    lane,
    picked: connector.name,
    keepOnClaude: false,
    ok: verdict.ok,
    why: verdict.why,
    wallSec: verdict.meta?.wallSec,
    model: verdict.pick?.model ?? null,
    reasoning,
    usage: verdict.meta?.usage ?? null,
    outFile: paths.outFile,
    // The forecast this pick was made on — the numbers pickPool compared, so a
    // later reader can replay the decision instead of re-deriving it. The full
    // candidate list stays out of the log: 500 entries of it would bloat the
    // state file the spend model has to read on every dispatch.
    forecast: forecastRecord(route, connector.name),
  });
  saveState(getBullswarmDir(), state);

  verdict.reasoning = reasoning;
  emit(verdict, opts);
  return verdict.ok ? 0 : 1;
}

function logDecision(state, d) {
  state.decisionLog ??= [];
  state.decisionLog.push({ ts: new Date().toISOString(), ...d });
  if (state.decisionLog.length > 500) {
    state.decisionLog = state.decisionLog.slice(-500);
  }
}

function emit(verdict, opts) {
  if (opts.json) console.log(JSON.stringify(verdict, null, 2));
  else {
    const line = [
      verdict.ok ? 'OK' : 'FAIL',
      verdict.keepOnClaude ? '(keep-on-caller)' : '',
      verdict.pick?.pool ? `[${verdict.pick.pool}]` : '',
      verdict.why ?? '',
    ].filter(Boolean).join(' ');
    console.log(line);
    if (Array.isArray(verdict.pick?.command) && verdict.dryRun) {
      console.log(`command: ${verdict.pick.command.join(' ')}`);
    }
    // The forecast the pick was made on, so a preview explains itself without
    // --json: what the pool is already carrying, where its 5h window is headed
    // once this assignment runs, and what that estimate is based on.
    if (verdict.forecast && verdict.dryRun) {
      const f = verdict.forecast;
      console.log(
        `forecast: inflight=${f.inflight} `
        + `5h ${f.projectedFiveHourPct ?? '?'}%->${f.forecastFiveHourPct ?? '?'}% `
        + `expected=${f.expectedMinutes == null ? 'unknown' : `${f.expectedMinutes}m`} `
        + `rate=${f.ratePerMinute == null ? 'unmeasured' : `${f.ratePerMinute}%/min`} `
        + `basis=${f.estimateSource ?? 'none'}`,
      );
    }
    if (verdict.reasoning?.applied) {
      const clamped = verdict.reasoning.clamped ? ', clamped' : '';
      console.log(`reasoning: ${verdict.reasoning.applied} (${verdict.reasoning.source}${clamped})`);
    }
    if (verdict.outFile) console.log(`output: ${verdict.outFile}`);
    const usage = verdict.meta?.usage;
    if (usage) {
      const t = usage.tokens ?? {};
      console.log(`usage: read=${t.standardRead ?? '?'} cache-read=${t.cacheRead ?? '?'} cache-write=${t.cacheWrite ?? '?'} output=${t.output ?? '?'} tokens (${usage.tokenSource})`);
      console.log(`cost: ${usage.cost?.estimatedUsd == null ? 'unknown' : `~$${usage.cost.estimatedUsd}`} · quota: ${usage.normalizedQuota?.estimatedPercent == null ? 'unknown' : `~${usage.normalizedQuota.estimatedPercent}%`}`);
    }
  }
}

// --- health -----------------------------------------------------------------

function cmdHealth(opts) {
  const state = loadState(getBullswarmDir());
  const released = sweepQuarantines(state, Date.now());
  if (released.length) saveState(getBullswarmDir(), state);
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

  const quarantined = Object.entries(state.pools ?? {})
    .filter(([, v]) => v.quarantine)
    .map(([k, v]) => ({ pool: k, until: v.quarantine.until, reason: v.quarantine.reason }));

  const report = {
    healthy:
      findings.every((f) => !f.gateAteWork) &&
      quarantined.length < 2 &&
      (state.decisionLog?.length ?? 0) > 0,
    gateFailures: findings.filter((f) => f.gateAteWork),
    quarantineCluster: quarantined.length >= 2 ? quarantined : [],
    quarantined,
    decisionLogSize: state.decisionLog?.length ?? 0,
  };
  console.log(JSON.stringify(report, null, 2));
  return report.healthy ? 0 : 1;
}

// --- setup ------------------------------------------------------------------

async function cmdSetup(opts) {
  const { runWizard, autoSetup } = await import('./setup.js');
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
      console.log(`setup complete (${r.reason}): enabled ${r.enabledPools.join(', ')}`);
      if (r.repaired.length) console.log(`repaired connector files: ${r.repaired.join(', ')}`);
      console.log(`model strategy: ${r.strategyCommand} (discovers models and refreshes tier suggestions)`);
      if (strategy) console.log(`strategy autopilot: applied ${Object.keys(strategy.applied).join(', ')} tiers; refresh every ${strategy.policy.refreshHours}h`);
      if (integration) console.log('agent integration: installed (inspect with bullswarm integrate status)');
    }
    return 0;
  }
  if (!opts.json && !opts.wizard && !opts.integrate) {
    return startStrategyDashboard({
      bullswarmDir: getBullswarmDir(), input: process.stdin, output: process.stdout,
      title: 'Bullswarm setup',
      promptForAnalysis: true,
      loadInventory: ({ force, onProgress, analyze }) => loadStrategyInventory(getBullswarmDir(), {
        force, onProgress, useOpenRouter: analyze,
      }),
      applyRecommendations: () => {
        const report = loadState(getBullswarmDir()).strategy?.lastReport;
        if (report) applyStrategyRecommendations(getBullswarmDir(), report);
      },
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

  try {
    const { pools } = await buildPoolsLive(getBullswarmDir(), Date.now(), {
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
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`);
      if (!c.ok && c.fix) console.log(`      fix: ${c.fix}`);
    }
  }
  return report.ok ? 0 : 1;
}

// --- main ---------------------------------------------------------------------

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
  const [verb, ...rest] = argv;
  const opts = parseArgs(rest);
  const { ensureSetup } = await import('./setup.js');

  // Agent-friendly guarantee: EVERY verb works on a fresh machine. If config
  // is missing, self-initialize with discovered defaults (never prompts).
  ensureSetup(getBullswarmDir());

  switch (verb) {
    case undefined:
      // Bare bullswarm: interactive wizard for humans on a TTY, auto-setup
      // + status for everyone else (agents, scripts).
      if (opts.yes || !process.stdin.isTTY) return cmdSetup({ ...opts, yes: true });
      return cmdSetup(opts);
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
      return cmdWorkflow(rest);
    case 'runs':
      return cmdWorkflow(['runs', ...rest]);
    case 'strategy':
      return cmdStrategy(bareStrategyDashboard ? ['tui'] : rest, {
        bullswarmDir: getBullswarmDir(), input: process.stdin, output: process.stdout,
      });
    case 'integrate':
      return cmdIntegrate(opts);
    case 'version':
    case '--version':
      console.log(getVersion());
      return 0;
    case 'release':
      return cmdRelease(opts);
    default:
      console.error(`unknown verb "${verb}". Run "bullswarm --help" for the list of commands.`);
      return 2;
  }
}

// --- release -----------------------------------------------------------------

function cmdRelease(opts) {
  const kind = opts.rest[0];
  if (!['patch', 'minor', 'major'].includes(kind)) {
    console.error(`usage: ${usageLine(['release'])}`);
    return 2;
  }
  try {
    const r = release(kind, { dryRun: opts['dry-run'] === true });
    const label = r.dryRun ? 'would release' : 'released';
    console.log(`${label}: ${r.from} → ${r.to} (tag ${r.tag})`);
    if (!r.dryRun) {
      console.log('next: git push && git push --tags (CI publishes to npm via trusted publishing)');
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}
