// bullswarm CLI — verbs: setup (wizard), run, health, pools.

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pickPool } from './lib/route.js';
import { watchOnce } from './lib/watch.js';
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

export const BULLSWARM_DIR = join(homedir(), '.bullswarm');

function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (key === 'json') args.json = true;
      else if (i + 1 < argv.length) args[key] = argv[++i];
      else args[key] = true;
    } else rest.push(argv[i]);
  }
  return { ...args, rest };
}

// --- pools ----------------------------------------------------------------

async function cmdPools(opts) {
  const now = Date.now();
  const { state, pools } = await buildPoolsLive(BULLSWARM_DIR, now, {
    force: opts.force === true,
    getReadings: getAllMeterReadings,
  });
  const released = sweepQuarantines(state, now);
  if (released.length && !opts.json) {
    console.error(`quarantine expired, returned to service: ${released.join(', ')}`);
  }
  saveState(BULLSWARM_DIR, state);
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
    const status = !p.enabled
      ? 'disabled'
      : p.quarantine
        ? `QUARANTINED until ${new Date(p.quarantine.until).toLocaleTimeString()} (${p.quarantine.reason})`
        : `ready${burst}`;
    console.log(
      `${p.name.padEnd(14)} cost=${p.costRank} lanes=${p.lanes.join('/')} ${meter} surplus=${p.pace ?? '-'} ${status}`,
    );
  }
  return 0;
}

// --- run --------------------------------------------------------------------

async function cmdRun(opts) {
  const now = Date.now();
  const lane = opts.lane;
  const targetDir = resolve(opts['add-dir'] ?? process.cwd());

  // Recursion guard FIRST — core-owned, env handshake.
  let state = loadState(BULLSWARM_DIR);
  try {
    assertDepthAllowed(state);
  } catch (err) {
    const verdict = { ok: false, keepOnClaude: true, why: err.message };
    console.log(JSON.stringify(verdict, null, 2));
    return 1;
  }

  sweepQuarantines(state, now);

  const { pools } = await buildPoolsLive(BULLSWARM_DIR, now, {
    getReadings: getAllMeterReadings,
  });
  for (const p of pools) {
    p.incumbent = state.incumbents?.[lane] === p.name;
  }

  // Burst gate (M3): a pool whose 5h window is >=90% used is excluded from
  // dispatch entirely this run — it paces nothing, it's just out of burst room.
  const gated = pools.filter((p) => p.burstGate);
  const eligiblePools = gated.length ? pools.filter((p) => !p.burstGate) : pools;

  const route = pickPool(lane, eligiblePools, {
    callerEligible: opts['no-caller'] !== true,
    callerName: state.config.callerName ?? 'claude-code',
    now,
  });
  if (gated.length && route.pick) {
    route.why += ` (burst-gated: ${gated.map((g) => g.name).join(', ')})`;
  }

  if (!route.pick && route.keepOnClaude) {
    logDecision(state, { lane, picked: null, keepOnClaude: true, ok: null, why: route.why });
    saveState(BULLSWARM_DIR, state);
    emit({ ok: true, keepOnClaude: true, why: route.why, pick: { pool: null, command: null } }, opts);
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

  // Task text: --task-file content or stdin string.
  const taskText = opts['task-file']
    ? readFileSync(opts['task-file'], 'utf8')
    : opts.rest.join(' ');
  if (!taskText.trim()) {
    console.error('empty task: pass --task-file or the task as arguments');
    return 2;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const runDir = join(BULLSWARM_DIR, 'runs');
  mkdirSync(runDir, { recursive: true });
  const paths = {
    taskFile: join(runDir, `task-${stamp}.md`),
    outFile: join(runDir, `out-${stamp}.md`),
  };

  const verdict = await watchOnce(connector, taskText, targetDir, paths, {
    timeoutSec: Number(opts.timeout ?? connector.timeoutSec ?? 900),
    env: childDepthEnv(process.env),
  });

  // Persist incumbency on success; quarantine hint on auth failure.
  if (verdict.ok) {
    state.incumbents ??= {};
    state.incumbents[lane] = connector.name;
  } else if (verdict.quarantineHint) {
    quarantinePool(state, connector.name, verdict.why, now);
    verdict.quarantinedUntil = state.pools[connector.name]?.quarantine?.until;
  }

  logDecision(state, {
    lane,
    picked: connector.name,
    keepOnClaude: false,
    ok: verdict.ok,
    why: verdict.why,
    wallSec: verdict.meta?.wallSec,
    outFile: paths.outFile,
  });
  saveState(BULLSWARM_DIR, state);

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
    if (verdict.outFile) console.log(`output: ${verdict.outFile}`);
  }
}

// --- health -----------------------------------------------------------------

function cmdHealth(opts) {
  const state = loadState(BULLSWARM_DIR);
  const runsDir = join(BULLSWARM_DIR, 'runs');
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
    const r = autoSetup(BULLSWARM_DIR, { reason: opts.yes ? 'flag' : 'non-tty' });
    if (opts.json) console.log(JSON.stringify({ ok: true, mode: 'auto', ...r }, null, 2));
    else {
      console.log(`setup complete (${r.reason}): enabled ${r.enabledPools.join(', ')}`);
      if (r.repaired.length) console.log(`repaired connector files: ${r.repaired.join(', ')}`);
    }
    return 0;
  }
  return runWizard(BULLSWARM_DIR, opts);
}

// --- doctor -------------------------------------------------------------------
// Machine-readable readiness report for agents: what works, what's missing,
// exactly which command fixes each gap. Never prompts.

async function cmdDoctor(opts) {
  const { discoverConnectors, isConfigured, autoSetup } = await import('./setup.js');
  const checks = [];
  let configured = isConfigured(BULLSWARM_DIR);

  checks.push({
    id: 'config',
    ok: configured,
    detail: configured ? `${BULLSWARM_DIR}/state.json present` : 'no config yet',
    fix: 'bullswarm setup --yes   # or run any verb; it self-initializes',
  });

  // Self-heal before reporting when not configured — an agent calling
  // doctor should end up ready-to-use in the same invocation.
  if (!configured) {
    autoSetup(BULLSWARM_DIR, { reason: 'doctor' });
    configured = true;
    checks[0] = { ...checks[0], ok: true, detail: `initialized at ${BULLSWARM_DIR} (was missing)` };
  }

  const discovered = discoverConnectors();
  const found = discovered.filter((d) => d.discovered && !d.broken);
  checks.push({
    id: 'connectors',
    ok: found.length > 0,
    detail: `${found.length} agent CLI(s) found: ${found.map((d) => d.name).join(', ') || '(none)'}`,
    fix: found.length ? null : 'install at least one agent CLI (codex, grok, opencode…) — echo pool still works',
  });

  try {
    const { pools } = await buildPoolsLive(BULLSWARM_DIR, Date.now(), {
      getReadings: getAllMeterReadings,
    });
    const live = pools.filter((p) => p.meterSource === 'live' || p.meterSource === 'cache');
    const enabled = pools.filter((p) => p.enabled);
    checks.push({
      id: 'meters',
      ok: enabled.length > 0,
      detail: `${live.length}/${pools.length} pools with provider meters; ${enabled.length} enabled`,
      fix: enabled.length ? null : 'bullswarm setup --yes',
    });
    checks.push({
      id: 'offload-capable',
      ok: enabled.some((p) => p.name !== 'echo') || enabled.length > 0,
      detail: `enabled pools: ${enabled.map((p) => p.name).join(', ') || 'none'}`,
      fix: null,
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
  const [verb, ...rest] = argv;
  const opts = parseArgs(rest);
  const { ensureSetup } = await import('./setup.js');

  // Agent-friendly guarantee: EVERY verb works on a fresh machine. If config
  // is missing, self-initialize with discovered defaults (never prompts).
  ensureSetup(BULLSWARM_DIR);

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
    case 'doctor':
      return cmdDoctor(opts);
    case 'workflow':
      return cmdWorkflow(rest);
    case 'version':
      console.log(getVersion());
      return 0;
    case 'release':
      return cmdRelease(opts);
    default:
      console.error(
        `unknown verb "${verb}". try: setup | run | health | pools | doctor | workflow | version | release`,
      );
      return 2;
  }
}

// --- release -----------------------------------------------------------------

function cmdRelease(opts) {
  const kind = opts.rest[0];
  if (!['patch', 'minor', 'major'].includes(kind)) {
    console.error('usage: bullswarm release patch|minor|major [--dry-run]');
    return 2;
  }
  try {
    const r = release(kind, { dryRun: opts['dry-run'] === true });
    const label = r.dryRun ? 'would release' : 'released';
    console.log(`${label}: ${r.from} → ${r.to} (tag ${r.tag})`);
    if (!r.dryRun) {
      console.log('next: npm publish (or: npm publish --access public)');
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}
