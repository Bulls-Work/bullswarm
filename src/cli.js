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
import { buildPools } from './lib/config.js';
import { judgeContent } from './lib/verify.js';

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

function cmdPools(opts) {
  const now = Date.now();
  const { state, pools } = buildPools(BULLSWARM_DIR, now);
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
    const meter =
      p.meter.type === 'none'
        ? 'unmetered'
        : `used ${p.usedPct ?? '?'}% of ${p.meter.window} (elapsed ${p.elapsedPct ?? '?'}%)`;
    const status = !p.enabled
      ? 'disabled'
      : p.quarantine
        ? `QUARANTINED until ${new Date(p.quarantine.until).toLocaleTimeString()} (${p.quarantine.reason})`
        : 'ready';
    console.log(
      `${p.name.padEnd(14)} cost=${p.costRank} lanes=${p.lanes.join('/')} ${meter} pace=${p.pace ?? '-'} ${status}`,
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

  const { pools } = buildPools(BULLSWARM_DIR, now);
  for (const p of pools) {
    p.incumbent = state.incumbents?.[lane] === p.name;
  }

  const route = pickPool(lane, pools, {
    callerEligible: opts['no-caller'] !== true,
    callerName: state.config.callerName ?? 'claude',
    now,
  });

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
  const { runWizard } = await import('./setup.js');
  return runWizard(BULLSWARM_DIR, opts);
}

// --- main ---------------------------------------------------------------------

export async function main(argv) {
  const [verb, ...rest] = argv;
  const opts = parseArgs(rest);

  if (!verb || verb === 'setup') {
    if (!existsSync(join(BULLSWARM_DIR, 'state.json')) || verb === 'setup') {
      return cmdSetup(opts);
    }
  }
  switch (verb) {
    case undefined:
      return cmdSetup(opts); // bare bullswarm with config present still guides
    case 'setup':
      return cmdSetup(opts);
    case 'run':
      return cmdRun(opts);
    case 'health':
      return cmdHealth(opts);
    case 'pools':
      return cmdPools(opts);
    default:
      console.error(`unknown verb "${verb}". try: setup | run | health | pools`);
      return 2;
  }
}
