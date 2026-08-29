// bullswarm workflow CLI — run | validate | list.

import {
  existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync,
  openSync, closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { loadWorkflow, runWorkflow, newRunId } from './runner.js';
import { validateWorkflow, WorkflowValidationError } from './validate.js';
import { buildPools, buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { WorkflowTui } from './tui.js';
import { cmdDraft } from './draft-cli.js';
import { cmdRuns } from './runs-cli.js';
import { resolveRunId, reconcileInterruptedRuns } from './short-id.js';
import { runDashboard, dashboardJson, actionJson, decideApproval } from './dashboard.js';
import { readEvents } from './events.js';
import { buildGoalWorkflow } from './goal.js';
import { maybeRefreshStrategy } from '../strategy-cli.js';
import { loadState } from '../lib/state.js';
import { runWorkflowWatch } from './watch-cli.js';
import { queueSteering } from './steering.js';
import { isDeliveredWorkflowStatus } from './status.js';
import { helpText, usageLine } from '../help.js';

// BULLSWARM_DIR is read on every call so that changes to the
// BULLSWARM_HOME env var (e.g. set per-test) are honored, not
// captured at module load. (The previous module-level IIFE form
// silently broke resume-by-shortId for any run whose BULLSWARM_HOME
// differed from the one in effect when the module was first
// imported.)
function bullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h && h.length ? h : join(homedir(), '.bullswarm');
}
export const BULLSWARM_DIR = bullswarmDir; // back-compat for any external import

function workflowDirs() {
  const dir = bullswarmDir();
  return [
    join(process.cwd(), 'workflows'),
    join(dir, 'workflows'),
    join(dir, 'drafts'),
  ];
}

function discover() {
  const found = [];
  for (const dir of workflowDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const isDraft = statSync(p).isDirectory() && existsSync(join(p, 'workflow.json'));
      if (isDraft) {
        // Drafts are <draft>/workflow.json.
        const dp = join(p, 'workflow.json');
        try {
          const doc = JSON.parse(readFileSync(dp, 'utf8'));
          found.push({
            name: doc.name ?? f,
            path: dp,
            valid: null,
            draft: true,
          });
        } catch (err) {
          found.push({ name: f, path: dp, valid: `parse error: ${err.message}`, draft: true });
        }
        continue;
      }
      if (!statSync(p).isFile() || !f.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8'));
        found.push({ name: doc.name ?? f.replace(/\.json$/, ''), path: p, valid: null });
      } catch (err) {
        found.push({ name: f.replace(/\.json$/, ''), path: p, valid: `parse error: ${err.message}` });
      }
    }
  }
  return found;
}

export async function cmdWorkflow(args) {
  reconcileInterruptedRuns(BULLSWARM_DIR());
  const [sub, ...rest] = args;
  const opts = parseFlags(rest);

  switch (sub) {
    case 'goal':
      return wfGoal(opts);
    case 'run':
      return wfRun(opts);
    case 'validate':
      return wfValidate(opts);
    case 'list':
      return wfList(opts);
    case 'draft':
      return cmdDraft(rest);
    case 'runs':
      return cmdRuns(rest);
    case 'capabilities':
      return wfCapabilities(opts);
    case 'inspect':
      return wfInspect(opts);
    case 'tui':
      try {
        if (opts.json || opts.cancel || opts.show || opts.all) {
          const token = opts.rest[0] ?? opts.show;
          const result = dashboardJson(BULLSWARM_DIR(), {
            all: opts.all,
            token,
            cancel: opts.cancel,
          });
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        return await runDashboard(BULLSWARM_DIR(), { token: opts.rest[0] ?? null });
      }
      catch (err) { console.error(`✗ ${err.message}`); return 1; }
    case 'events':
      return wfEvents(opts);
    case 'watch':
      return wfWatch(opts);
    case 'steer':
      return wfSteer(opts);
    case 'action':
      return wfAction(opts);
    case 'approval':
      return wfApproval(opts);
    default: {
      // Smart error: if the user typed a `runs` subcommand under
      // `workflow run ...` (e.g. `workflow run show jd3uki`), point
      // them at the right verb. Same for `workflow list` vs
      // `workflow runs list` confusion.
      const runsSubcommands = new Set(['show', 'delete']);
      if (sub && runsSubcommands.has(sub)) {
        console.error(
          `✗ "workflow ${sub}" is not a subcommand. ` +
          `Did you mean "workflow runs ${sub} <id>"?`,
        );
        return 2;
      }
      console.error(helpText(['workflow']));
      return 2;
    }
  }
}

function goalSettings(opts) {
  const mappings = {
    'max-agents': 'maxAgents',
    'max-expansion-rounds': 'maxExpansionRounds',
    'max-actions': 'maxActions',
    'max-items-per-expansion': 'maxItemsPerExpansion',
    'max-workflow-seconds': 'maxWorkflowSeconds',
    concurrency: 'concurrency',
    'retry-attempts': 'retryAttempts',
  };
  return Object.fromEntries(Object.entries(mappings)
    .filter(([flag]) => opts[flag] != null)
    .map(([flag, setting]) => [setting, opts[flag]]));
}

function goalUsage() {
  return helpText(['workflow', 'goal']);
}

async function executeGoalDocument({ doc, pools, opts, runId, resumeRunId }) {
  const tui = new WorkflowTui({ quiet: opts.quiet, json: opts.json });
  const result = await runWorkflow({
    bullswarmDir: BULLSWARM_DIR(),
    doc,
    pools,
    runId,
    resumeRunId,
    onEvent: opts.json ? undefined : (event) => tui.handle(event),
  });
  if (opts.json) console.log(JSON.stringify(result.report, null, 2));
  return isDeliveredWorkflowStatus(result.report.status) ? 0 : 1;
}

async function launchDetachedGoal(doc, opts) {
  const runId = newRunId();
  const goalDir = join(BULLSWARM_DIR(), 'goals', runId);
  mkdirSync(goalDir, { recursive: true });
  const requestPath = join(goalDir, 'request.json');
  const stdoutPath = join(goalDir, 'stdout.log');
  const stderrPath = join(goalDir, 'stderr.log');
  writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 'bullswarm.goal.request.v1',
    runId,
    document: doc,
  }, null, 2)}\n`);

  const stdoutFd = openSync(stdoutPath, 'a');
  const stderrFd = openSync(stderrPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [
      resolve(process.argv[1]), 'workflow', 'goal',
      '--request', requestPath,
      '--run-id', runId,
      '--json', '--quiet',
    ], {
      cwd: doc.intent.cwd,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  writeFileSync(join(goalDir, 'launcher.json'), `${JSON.stringify({
    schemaVersion: 'bullswarm.goal.launcher.v1',
    runId,
    pid: child.pid,
    launchedAt: new Date().toISOString(),
    requestPath,
    stdoutPath,
    stderrPath,
  }, null, 2)}\n`);

  let state = null;
  const statePath = join(BULLSWARM_DIR(), 'workflows', runId, 'state.json');
  // A detached child can take a few seconds to publish state when the host is
  // busy (for example while several provider/test processes are starting).
  // Keep the launch handoff deterministic before --watch resolves the run.
  for (let i = 0; i < 400 && !state; i++) {
    if (existsSync(statePath)) {
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* atomic state write in progress */ }
    }
    if (!state) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const launch = {
    action: 'goal-launched',
    runId,
    shortId: state?.shortId ?? null,
    status: state?.status ?? 'starting',
    pid: child.pid,
    goal: doc.intent.goal,
    cwd: doc.intent.cwd,
    requestedOrchestrator: doc.intent.requestedOrchestrator,
    observe: {
      watch: `bullswarm workflow watch ${state?.shortId ?? runId}`,
      summary: `bullswarm workflow runs show ${state?.shortId ?? runId}`,
      result: `bullswarm workflow runs result ${state?.shortId ?? runId} --json`,
      dashboard: `bullswarm workflow tui ${state?.shortId ?? runId}`,
      inspect: `bullswarm workflow tui --json ${state?.shortId ?? runId}`,
      events: `bullswarm workflow events --json ${state?.shortId ?? runId} --after 0`,
    },
    logs: { stdout: stdoutPath, stderr: stderrPath },
  };
  launch.instructions = goalLaunchInstructions(launch.observe);
  if (!opts.silentLaunch && opts.json) console.log(JSON.stringify(launch, null, 2));
  else if (!opts.silentLaunch) {
    printGoalLaunchInstructions(launch);
  }
  return launch;
}

function goalLaunchInstructions(observe) {
  return {
    agentInspect: {
      purpose: 'Obtain a machine-readable snapshot for an agentic caller.',
      command: observe.inspect,
    },
    watch: {
      purpose: 'Follow low-noise semantic progress until the workflow is terminal.',
      command: observe.watch,
    },
    humanTui: {
      purpose: 'Open the interactive Phase → Agent → Activity browser; q detaches safely.',
      command: observe.dashboard,
    },
    result: {
      purpose: 'After completion, obtain the stable delivery and verification envelope.',
      command: observe.result,
    },
  };
}

function printGoalLaunchInstructions(launch) {
  console.log(`workflow ${launch.shortId ?? launch.runId} continues independently; next commands:`);
  for (const [name, instruction] of Object.entries(launch.instructions)) {
    console.log(`  ${name.padEnd(13)} ${instruction.command}`);
    console.log(`                 ${instruction.purpose}`);
  }
}

export function shouldAutoWatchGoal(opts) {
  return opts.watch === true && opts.detach !== true && opts.foreground !== true &&
    opts.json !== true && opts.resume == null && opts.request == null;
}

export function applyResumeOrchestratorOverride(doc, requested) {
  if (!requested) return doc;
  const pool = requested === 'auto' ? null : requested;
  doc.intent ??= {};
  doc.orchestration ??= {};
  doc.intent.requestedOrchestrator = pool ?? 'auto';
  doc.orchestration.requestedPool = pool;
  doc.orchestration.selection = pool
    ? 'user-pinned-for-testing'
    : 'capability-strategy-and-quota';
  for (const phase of doc.phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.type !== 'decide') continue;
      if (pool) step.pool = pool;
      else delete step.pool;
    }
  }
  return doc;
}

async function wfGoal(opts) {
  if (opts.help) {
    console.log(goalUsage());
    return 0;
  }
  if (opts.watch && (opts.detach || opts.foreground || opts.json || opts.resume || opts.request)) {
    console.error('✗ --watch is only valid for a new human-readable independent launch; do not combine it with --detach, --foreground, --json, --resume, or --request');
    return 2;
  }
  const { names, pools } = await livePoolNames();
  let doc;
  let resumeRunId = null;

  if (opts.resume) {
    const resolvedRun = resolveRunId(BULLSWARM_DIR(), opts.resume);
    if (!resolvedRun) {
      console.error(`✗ --resume token "${opts.resume}" did not match any run`);
      return 1;
    }
    resumeRunId = resolvedRun.runId;
    const workflowPath = join(resolvedRun.runDir, 'workflow.json');
    const statePath = join(resolvedRun.runDir, 'state.json');
    try {
      doc = existsSync(workflowPath)
        ? JSON.parse(readFileSync(workflowPath, 'utf8'))
        : readJsonForUpdate(statePath, 'workflow state')._doc;
    } catch (err) {
      console.error(`✗ cannot load durable workflow for ${resumeRunId}: ${err.message}`);
      return 1;
    }
    applyResumeOrchestratorOverride(doc, opts.orchestrator);
  } else if (opts.request) {
    try {
      const request = JSON.parse(readFileSync(resolve(opts.request), 'utf8'));
      if (request.schemaVersion !== 'bullswarm.goal.request.v1' || !request.document) {
        throw new Error('invalid goal request schema');
      }
      if (request.runId !== opts['run-id']) throw new Error('goal request runId mismatch');
      doc = request.document;
    } catch (err) {
      console.error(`✗ cannot load goal request: ${err.message}`);
      return 1;
    }
  } else {
    const goal = opts.rest.join(' ').trim();
    if (!goal) {
      console.error(goalUsage());
      return 2;
    }
    const orchestrator = opts.orchestrator && opts.orchestrator !== 'auto'
      ? opts.orchestrator : null;
    try {
      doc = buildGoalWorkflow({
        goal,
        cwd: opts.cwd ?? process.cwd(),
        orchestrator,
        settings: goalSettings(opts),
        scout: !opts.noScout,
        worktreeIsolation: loadState(BULLSWARM_DIR()).config?.worktreeIsolation ?? 'agent-decides',
      });
    } catch (err) {
      console.error(`✗ invalid goal options: ${err.message}`);
      return 2;
    }
  }

  const targetDir = doc?.intent?.cwd;
  if (typeof targetDir !== 'string' || !existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.error(`✗ goal cwd is not an existing directory: ${targetDir ?? '(missing)'}`);
    return 1;
  }

  try {
    validateWorkflow(doc, { poolNames: names });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error('✗ autonomous workflow invalid (nothing ran):');
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }

  if (!opts.foreground && !resumeRunId && !opts.request) {
    const launch = await launchDetachedGoal(doc, opts);
    if (shouldAutoWatchGoal(opts)) {
      // The detached child writes state.json asynchronously; give it a
      // bounded grace period instead of failing the handoff on a slow host.
      return runWorkflowWatch(BULLSWARM_DIR(), launch.runId ?? launch.shortId, { waitForRunMs: 30_000 });
    }
    return 0;
  }
  return executeGoalDocument({
    doc,
    pools,
    opts,
    runId: opts['run-id'] ?? undefined,
    resumeRunId,
  });
}

async function wfCapabilities(opts) {
  const { pools } = await livePoolNames();
  const coreState = loadState(BULLSWARM_DIR());
  const result = {
    lanes: ['analyze', 'build', 'chore'],
    stepTypes: ['run', 'fanout', 'verify', 'decide'],
    workflowFeatures: {
      sequentialPhases: true,
      dynamicFanout: true,
      dynamicGraphExpansion: true,
      autonomousGoalBootstrap: true,
      detachedGoalRunner: true,
      boundedObservePlanExecute: true,
      durableOrderedEvents: true,
      firstClassAttempts: true,
      capabilityAwareRouting: true,
      boundedRetries: true,
      maxRetryAttempts: 3,
      resume: true,
      cooperativeCancellation: true,
      cooperativeSignalInterruption: true,
      staleOwnerReconciliation: true,
      adversarialVerification: true,
    },
    routing: {
      automatic: true,
      selection: 'approved effort-tier assignment when eligible; otherwise highest time-adjusted quota surplus among lane/capability/model-policy-eligible, enabled, non-quarantined, non-burst-gated pools',
      modelSelection: 'connector-declared discovery and model flag; approved assignments may select a model; excluded models are never dispatched and force an allowed tier fallback when supported',
      strategyPolicy: coreState.strategy?.policy ?? null,
      assignments: coreState.strategy?.assignments ?? {},
      excludedModels: coreState.strategy?.excludedModels ?? [],
    },
    worktreeIsolation: {
      policy: coreState.config?.worktreeIsolation ?? 'agent-decides',
      enforcement: 'optional agent execution-style preference; Bullswarm does not impose repository topology',
    },
    pools: pools.map((p) => ({
      name: p.name,
      enabled: p.enabled !== false,
      lanes: p.lanes ?? p.connector?.lanes ?? [],
      capabilities: p.capabilities ?? p.connector?.capabilities ?? [],
      command: p.connector?.profile?.command ?? p.connector?.spawn?.cmd?.[0] ?? null,
      configDir: p.connector?.profile?.configDir ?? p.connector?.env?.CLAUDE_CONFIG_DIR ?? null,
      model: (() => {
        const cmd = p.connector?.spawn?.cmd ?? [];
        const i = cmd.indexOf('--model');
        return i >= 0 ? cmd[i + 1] ?? null : null;
      })(),
      meter: p.meter ?? { type: p.connector?.meter?.type ?? 'none' },
      usedPct: p.usedPct ?? null,
      pace: p.pace ?? null,
      burstGate: p.burstGate === true,
      quarantined: Boolean(p.quarantine),
    })),
  };
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function wfEvents(opts) {
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'events'])}`);
    return 2;
  }
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) {
    console.error(`✗ no run found for "${token}"`);
    return 1;
  }
  const after = Number(opts.after ?? 0);
  if (!Number.isInteger(after) || after < 0) {
    console.error('✗ --after must be a non-negative integer');
    return 2;
  }
  const events = readEvents(resolved.runDir, { after });
  console.log(JSON.stringify({ action: 'events', runId: resolved.runId, shortId: resolved.shortId, after, count: events.length, events }, null, 2));
  return 0;
}

async function wfWatch(opts) {
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'watch'])}`);
    return 2;
  }
  const intervalSec = Number(opts.interval ?? 2);
  const heartbeatSec = Number(opts.heartbeat ?? 60);
  if (!Number.isFinite(intervalSec) || intervalSec < 0.1 ||
      !Number.isFinite(heartbeatSec) || heartbeatSec < 1) {
    console.error('✗ --interval must be >= 0.1 seconds and --heartbeat must be >= 1 second');
    return 2;
  }
  try {
    return await runWorkflowWatch(BULLSWARM_DIR(), token, {
      intervalMs: intervalSec * 1000,
      heartbeatMs: heartbeatSec * 1000,
      once: opts.once === true,
      jsonl: opts.jsonl === true,
      verbose: opts.verbose === true,
    });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function wfSteer(opts) {
  const token = opts.rest[0];
  const message = opts.message ?? opts.rest.slice(1).join(' ');
  if (!token || !message) {
    console.error(`usage: ${usageLine(['workflow', 'steer'])}`);
    return 2;
  }
  try {
    const result = queueSteering(BULLSWARM_DIR(), token, message);
    const payload = {
      action: 'steer',
      runId: result.runId,
      shortId: result.shortId,
      steering: result.entry,
      currentStep: result.state.currentStep ?? null,
      note: 'queued for the next not-yet-started orchestration checkpoint; the active worker is unchanged',
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`✓ steering ${result.entry.id} queued for ${result.shortId ?? result.runId}; active work is unchanged`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function wfAction(opts) {
  const [sub, token, actionId] = opts.rest;
  if (sub !== 'show' || !token || !actionId) {
    console.error(`usage: ${usageLine(['workflow', 'action', 'show'])}`);
    return 2;
  }
  try {
    console.log(JSON.stringify(actionJson(BULLSWARM_DIR(), token, actionId), null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function wfApproval(opts) {
  const [decision, token] = opts.rest;
  if (!['approve', 'reject'].includes(decision) || !token) {
    console.error(`usage: ${usageLine(['workflow', 'approval'])}`);
    return 2;
  }
  try {
    console.log(JSON.stringify({ action: 'approval', ...decideApproval(BULLSWARM_DIR(), token, decision) }, null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

async function wfInspect(opts) {
  const target = opts.rest[0];
  if (!target) {
    console.error(`usage: ${usageLine(['workflow', 'inspect'])}`);
    return 2;
  }
  try {
    const { doc, path } = loadWorkflow(target, workflowDirs());
    const { names } = await livePoolNames();
    const validation = validateWorkflow(doc, { poolNames: names });
    console.log(JSON.stringify({
      action: 'inspect-workflow', path, document: doc, validation,
      availablePools: names,
      semantics: {
        phases: 'ordered and sequential',
        run: 'one dispatch',
        fanout: 'one dispatch per runtime item, bounded by concurrency',
        verify: 'review artifact and require JSON ok:true',
        retries: 'settings.retryAttempts adds same-pool retries; escalateOnFail may try alternate pools',
        decide: 'planner proposal is validated, bounded, appended, executed, observed, and replanned',
        dynamicGraphExpansion: doc.phases.some((phase) => phase.steps?.some((step) => step.type === 'decide')),
      },
    }, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(JSON.stringify({ action: 'inspect-workflow', ok: false, issues: err.issues }, null, 2));
      return 1;
    }
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function parseFlags(argv) {
  const out = { inputs: {}, rest: [] };
  const valueFlags = new Set([
    'resume', 'after', 'cwd', 'orchestrator', 'request', 'run-id',
    'max-agents', 'max-expansion-rounds', 'max-actions',
    'max-items-per-expansion', 'max-workflow-seconds', 'concurrency',
    'retry-attempts', 'interval', 'heartbeat', 'message',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--no-scout') out.noScout = true;
    else if (a === '--resume') out.resume = argv[++i];
    else if (a === '--after') out.after = argv[++i];
    else if (a === '--input') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const key = kv.slice(0, eq);
        const raw = kv.slice(eq + 1);
        // Accept JSON for non-string values: --input items='["a","b"]' or
        // --input count=3. Falls back to the raw string on parse failure
        // so a literal value with a colon doesn't silently lose data.
        let v = raw;
        if (raw.length && '[{"\''.includes(raw[0])) {
          try { v = JSON.parse(raw); } catch { v = raw; }
        }
        out.inputs[key] = v;
      }
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq > 0 ? eq : undefined);
      if (eq > 0) out[key] = a.slice(eq + 1);
      else if (valueFlags.has(key)) out[key] = argv[++i];
      else out[key] = true;
    } else out.rest.push(a);
  }
  return out;
}

async function wfValidate(opts) {
  const target = opts.rest[0];
  if (!target) {
    console.error(`usage: ${usageLine(['workflow', 'validate'])}`);
    return 2;
  }
  let doc, path;
  try {
    ({ doc, path } = loadWorkflow(target, workflowDirs()));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
  const poolsInfo = await livePoolNames();
  try {
    const r = validateWorkflow(doc, { poolNames: poolsInfo.names });
    console.log(`✓ ${path} is valid (${doc.phases?.length ?? 0} phases)`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    return 0;
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(`✗ ${path}:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }
}

async function livePoolNames() {
  try {
    await maybeRefreshStrategy(BULLSWARM_DIR());
    const { pools } = await buildPoolsLive(BULLSWARM_DIR(), Date.now(), {
      getReadings: getAllMeterReadings,
    });
    return { names: pools.map((p) => p.name), pools };
  } catch (err) {
    const { pools } = buildPools(BULLSWARM_DIR(), Date.now());
    return { names: pools.map((p) => p.name), pools, meterWarning: err.message };
  }
}

async function wfRun(opts) {
  const target = opts.rest[0];
  if (!target) {
    console.error(`usage: ${usageLine(['workflow', 'run'])}`);
    return 2;
  }

  // Smart redirect: if the user typed `workflow run <subcommand> ...`
  // (e.g. `workflow run show jd3uki`), the second positional is a
  // subcommand of `runs`, not a workflow name. Surface a helpful
  // pointer instead of failing with "workflow not found".
  const runsSubcommands = new Set(['show', 'delete']);
  if (runsSubcommands.has(target)) {
    console.error(
      `✗ "workflow run ${target}" is not a subcommand. ` +
      `Did you mean "workflow runs ${target} <id>"?`,
    );
    return 2;
  }

  // Pre-flight: resolve --resume token BEFORE loading the workflow.
  // A bogus shortId should fail fast, regardless of whether the named
  // workflow exists. Accepts a shortId (6 chars) or a full `wf-...`
  // runId; rejects anything that looks like neither.
  let resumeRunId = opts.resume;
  if (resumeRunId) {
    const resolved = resolveRunId(BULLSWARM_DIR(), resumeRunId);
    if (resolved) {
      resumeRunId = resolved.runId;
    } else if (resumeRunId.startsWith('wf-')) {
      // already a runId, leave as-is (loadWorkflow will surface ENOENT)
    } else {
      console.error(`✗ --resume token "${resumeRunId}" did not match any run`);
      return 1;
    }
  }

  let doc, path;
  try {
    ({ doc, path } = loadWorkflow(target, workflowDirs()));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }

  const { names, pools } = await livePoolNames();
  try {
    validateWorkflow(doc, { poolNames: names });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(`✗ workflow invalid (nothing ran):`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }

  const tui = new WorkflowTui({ quiet: opts.quiet, json: opts.json });
  const result = await runWorkflow({
    bullswarmDir: BULLSWARM_DIR(),
    doc,
    pools,
    inputs: opts.inputs,
    resumeRunId,
    // --json is a report protocol, not JSONL event streaming. Events are
    // still rendered for the human TUI, but agents get exactly one document.
    onEvent: opts.json ? undefined : (ev) => tui.handle(ev),
  });

  if (opts.json) {
    console.log(JSON.stringify(result.report, null, 2));
  }
  return isDeliveredWorkflowStatus(result.report.status) ? 0 : 1;
}

function wfList(opts) {
  const found = discover();
  if (opts.json) {
    console.log(JSON.stringify({ workflows: found }, null, 2));
    return 0;
  }
  if (found.length === 0) {
    console.log(`no workflows found in: ${workflowDirs().join(', ')}`);
    return 0;
  }
  for (const w of found) {
    const mark = w.valid ? `✗ ${w.valid}` : '✓';
    const tag = w.draft ? '(draft)' : '';
    console.log(`${mark}  ${w.name.padEnd(24)} ${tag.padEnd(8)} ${w.path}`);
  }
  return 0;
}
