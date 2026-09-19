import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { handoffBlock } from './v2-runtime.js';
import { pickPool, isBenched, isFree, isQuarantined } from '../lib/route.js';
import {
  assertDepthAllowed, childDepthEnv, clearPoolStrikes, loadState, quarantinePool,
  quarantineUpstreamSiblings, recordPoolStrike, updateState, upstreamGroupOf,
} from '../lib/state.js';
import { disabledModelsForPool, resolveDispatchModel, selectedModelsForTier, rungRecord } from '../lib/strategy.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { watchOnce } from '../lib/watch.js';
import {
  expectedMinutesFromSpendModel, registerAssignment, releaseAssignment, updateAssignment,
  withLedger,
} from '../lib/assignments.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { probeFreeModel, shouldProbeFreeModel } from '../lib/probe.js';
import { MIN_DURATION_SAMPLES, MIN_EXPECTED_MINUTES } from '../lib/spend.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';

const MECHANICAL_KINDS = new Set(['auth', 'quota', 'provider', 'process', 'interrupted', 'schema', 'stalled']);
/** Kinds that make the SAME pool unusable, so a retry must move elsewhere. */
const POOL_FATAL_KINDS = new Set(['auth', 'quota']);

// A worker that writes nothing at all for this long is stalled: its process is
// stopped and the attempt fails as `stalled`. Metered failures use the bounded
// mechanical retry allowance; a free stall can advance through each untried
// eligible pool once without spending that allowance. It bounds silence, not
// run time: the clock restarts on every byte, so an agent that keeps working is
// never cut off. Without it one hung worker kept its whole run open forever.
export const DEFAULT_WORKER_SILENCE_SEC = 60 * 60;
// A free pool is stopped after one recorded rung median of silence. The floor
// remains the spend model's minimum assignment length; callers may pass an
// explicit silenceTimeoutSec (including a short fixture value) to override the
// derived threshold for a probe or operator-directed run.
export const FREE_STALL_P50_FACTOR = 1;

export function workerSilenceTimeoutSec(env = process.env) {
  const raw = Number(env?.BULLSWARM_WORKER_SILENCE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_SILENCE_SEC;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function recordedRung(decisionLog, poolName, effort) {
  // A stall is a transport failure, not a real duration sample. Excluding it
  // here keeps the free-pool threshold from tightening after each timeout even
  // when an older strategy.js has not yet applied the same guard.
  const usable = (decisionLog ?? []).filter((entry) => entry?.failureKind !== 'stalled');
  return rungRecord(usable, poolName, effort);
}

function attemptSilenceTimeoutSec(pool, effort, decisionLog, configuredSilenceSec, explicitOverride = false) {
  if (pool?.free !== true) return configuredSilenceSec;
  const configured = Number(configuredSilenceSec);
  // An explicit value is an operator/test override. The default 3600-second
  // watcher clock is replaced by the spend-derived free-pool threshold below.
  if (explicitOverride && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  const rung = recordedRung(decisionLog, pool.name, effort);
  const trusted = rung && rung.dispatches >= MIN_DURATION_SAMPLES && rung.medianMinutes != null;
  const medianSec = trusted
    ? Math.round(Number(rung.medianMinutes) * 60 * FREE_STALL_P50_FACTOR)
    : 0;
  return Math.max(MIN_EXPECTED_MINUTES * 60, medianSec);
}

function classifyFailure(verdict, pool = null) {
  if (verdict?.ok) return null;
  if (verdict?.cancelled || verdict?.meta?.cancelled) return 'cancelled';
  // Quota outranks the quarantine hint: a usage limit also asks for a
  // quarantine, but it is a healthy credential with an empty window, and only
  // it carries a real reset deadline.
  if (verdict?.failureKind === 'quota') return 'quota';
  if (verdict?.quarantineHint) return 'auth';
  if (verdict?.failureKind === 'stalled' || verdict?.meta?.stalled) return 'stalled';
  if (verdict?.failureKind === 'provider' || verdict?.meta?.providerFailureType) return 'provider';
  if (verdict?.failureKind === 'schema') return 'schema';
  // A free endpoint that returned literally no answer is indistinguishable
  // from a dead provider for routing purposes. Keep semantic announcements and
  // other verifier judgments intact; only the explicit empty-output verdict is
  // eligible for the provider retry/bench path. Check this before a non-zero
  // exit-code classification because some connectors terminate after emitting
  // an empty response and still need the provider fallback.
  if (pool?.free === true && verdict?.why === 'empty output') return 'provider';
  if (verdict?.failureKind === 'process' || (verdict?.meta?.exitCode != null && verdict.meta.exitCode !== 0)) return 'process';
  if (verdict?.meta?.signal) return 'interrupted';
  if (verdict?.meta?.timedOut || verdict?.meta?.spawnError) return 'provider';
  return 'semantic';
}

function providerIdFromModel(model) {
  if (typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

function preparePools(pools, action, effort, {
  preferredModel = null, strictPool = null, now = Date.now(),
  liveQuarantine = null,
  liveBench = null,
  // Which pools COULD run this action were none of them paused: used to say
  // when work can be retried, and to refuse a pin that can never run it.
  ignoreQuarantine = false,
  ignoreBench = false,
} = {}) {
  const available = [];
  for (const pool of pools) {
    if (pool.enabled === false || pool.burstGate === true) continue;
    if (!ignoreQuarantine && isQuarantined(pool, now)) continue;
    if (!ignoreBench && isBenched(pool, now)) continue;
    // The pool object may predate a quarantine written by another action or
    // another run. Core state is the shared record, so consult it directly.
    const live = !ignoreQuarantine && typeof liveQuarantine === 'function' ? liveQuarantine(pool.name) : null;
    if (live && isQuarantined({ quarantine: live }, now)) continue;
    const liveBenchRecord = !ignoreBench && typeof liveBench === 'function' ? liveBench(pool.name) : null;
    if (liveBenchRecord && isBenched({ bench: liveBenchRecord }, now)) continue;
    const connector = pool.connector ?? pool;
    // A discovered provider clone represents one concrete credential and its
    // meter. Retargeting it to another provider-qualified model would make the
    // pool label, quota attribution, and quarantine target untrue. An exact
    // model pin may therefore use only the clone for that provider ID.
    const pinnedProvider = providerIdFromModel(preferredModel);
    if (pinnedProvider && connector.profile?.providerId
      && connector.profile.providerId !== pinnedProvider) continue;
    const assignment = pool.strategyAssignments?.[effort] ?? null;
    const modelPolicy = resolveDispatchModel(connector, effort, {
      assignment,
      excludedModels: [
        ...(pool.strategyExcludedModels ?? []),
        ...disabledModelsForPool({ disabledModels: pool.strategyDisabledModels }, pool.name),
      ],
      allowedModels: selectedModelsForTier({
        modelTiers: pool.strategyModelTiers,
        configuredTiers: pool.strategyConfiguredTiers,
      }, pool.name, effort),
    });
    if (!modelPolicy.eligible) continue;
    // Free-ness is a property of the model selected for THIS effort tier, not
    // of the connector's launch-time default. The pool list may have been
    // built without an effortTier (workflow refreshes do that), so re-evaluate
    // against the resolved policy before the stall clock and router see it.
    const selectedModelForTier = modelPolicy.model ?? pool.freeModel ?? connector.model ?? null;
    const free = selectedModelForTier == null
      ? pool.free === true
      : isFree({
        ...pool,
        free: undefined,
        freeModel: selectedModelForTier,
        modelPolicy,
      });
    available.push({ ...pool, modelPolicy, free, freeModel: selectedModelForTier });
  }
  // A strict pin defines the complete dispatch universe.
  return strictPool
    ? available.filter((pool) => pool.name === strictPool)
    : available;
}

/**
 * The run id an artifact path belongs to. The kernel owns the id and should
 * pass it explicitly; deriving it from the run directory keeps the ledger
 * honest for callers that have not been updated yet, without inventing one.
 */
function runIdFromPaths(files) {
  const match = /(?:^|[\\/])(wf-[a-z0-9]+-[a-f0-9]{6})(?:[\\/]|$)/.exec(files?.taskFile ?? '');
  return match ? match[1] : null;
}

function attemptPaths(base, ordinal) {
  if (typeof base === 'function') return base(ordinal);
  if (!base?.taskFile || !base?.outFile) throw new TypeError('paths must provide taskFile and outFile');
  if (ordinal === 1) return base;
  const suffix = `-attempt-${ordinal}`;
  const insert = (path) => path.replace(/(\.[^./]+)?$/, `${suffix}$1`);
  return {
    taskFile: insert(base.taskFile),
    outFile: insert(base.outFile),
    ...(base.streamFile ? { streamFile: insert(base.streamFile) } : {}),
    ...(base.stdoutFile ? { stdoutFile: insert(base.stdoutFile) } : {}),
    ...(base.diffFile ? { diffFile: insert(base.diffFile) } : {}),
  };
}

function artifactBesideTask(taskFile, kind, ext) {
  const name = basename(taskFile);
  const trimmed = name.startsWith('task-') ? name.slice(5).replace(/\.[^.]+$/, '') : 'attempt';
  return join(dirname(taskFile), `${kind}-${trimmed}${ext}`);
}

function withAttemptArtifacts(files, actionId, ordinal) {
  return {
    ...files,
    streamFile: files.streamFile ?? artifactBesideTask(files.taskFile, 'stream', '.jsonl'),
    stdoutFile: files.stdoutFile ?? artifactBesideTask(files.taskFile, 'stdout', '.log'),
    diffFile: files.diffFile ?? join(dirname(files.taskFile), `diff-${actionId}-attempt-${ordinal}.txt`),
  };
}

/**
 * The artifacts an attempt left beside its task file, read back from disk by
 * the same naming `withAttemptArtifacts` writes with. Used when the kernel
 * itself died mid-attempt and the record never reached `attempt.finished`, so
 * a resume can still say where the partial output and the stream are.
 */
export function attemptArtifactsOnDisk(taskFile, actionId, ordinal) {
  if (!taskFile) return {};
  const files = withAttemptArtifacts({ taskFile }, actionId, ordinal);
  const outputFile = artifactBesideTask(taskFile, 'out', '.md');
  const streamFile = existsSync(files.streamFile) ? files.streamFile
    : existsSync(files.stdoutFile) ? files.stdoutFile
      : null;
  const outputBytes = existsSync(outputFile) ? fileBytes(outputFile) : null;
  return {
    ...(existsSync(outputFile) ? { outputFile } : {}),
    ...(outputBytes != null ? { outputBytes } : {}),
    ...(streamFile ? { streamFile } : {}),
    ...(existsSync(files.diffFile) ? { diffFile: files.diffFile } : {}),
  };
}

const GIT_OPTS = {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  maxBuffer: 16 * 1024 * 1024,
};

function gitText(execFile, args, cwd) {
  try {
    return execFile('git', args, { cwd, ...GIT_OPTS });
  } catch {
    return null;
  }
}

function parseGitZPaths(output) {
  if (typeof output !== 'string') return [];
  return output.split('\0')
    .filter(Boolean)
    .map((entry) => entry.length >= 3 && entry[2] === ' ' ? entry.slice(3) : entry)
    .filter(Boolean);
}

function trackedFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '-z'], targetDir);
  return output == null ? null : new Set(output.split('\0').filter(Boolean));
}

function unignoredStatusFiles(targetDir, execFile) {
  const output = gitText(execFile, [
    'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all',
  ], targetDir);
  return output == null ? null : new Set(parseGitZPaths(output));
}

function territoryFiles(targetDir, ownedFiles, execFile) {
  const declared = Array.isArray(ownedFiles) ? ownedFiles.filter(Boolean) : [];
  const tracked = trackedFiles(targetDir, execFile);
  if (tracked == null) return { ok: false, files: new Set(), tracked: new Set() };
  if (declared.length) {
    return {
      ok: true,
      files: new Set(declared),
      tracked: new Set(declared.filter((file) => tracked.has(file))),
    };
  }
  const status = unignoredStatusFiles(targetDir, execFile);
  if (status == null) return { ok: false, files: new Set(), tracked };
  return {
    ok: true,
    files: new Set([...tracked, ...status]),
    tracked,
  };
}

function fileDigest(targetDir, relativePath) {
  try {
    const bytes = readFileSync(join(targetDir, relativePath));
    return createHash('sha1').update(bytes).digest('hex');
  } catch {
    // A missing file is represented by null. A directory or an unreadable
    // path is treated the same way: if it becomes readable, the bytes differ
    // and the path is attributed; if it stays that way, there is no change to
    // report.
    return null;
  }
}

function hashTerritory(targetDir, territory) {
  const hashes = new Map();
  for (const file of territory.files) hashes.set(file, fileDigest(targetDir, file));
  return {
    ok: territory.ok,
    files: new Set(territory.files),
    tracked: new Set(territory.tracked),
    hashes,
  };
}

function lineCount(path) {
  try {
    const body = readFileSync(path, 'utf8');
    if (!body) return 0;
    return body.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(body) ? 1 : 0);
  } catch {
    return null;
  }
}

function trackedStat(targetDir, files, execFile) {
  if (!files.length) return '';
  // HEAD includes both staged and unstaged bytes. Fall back to the plain diff
  // (and its cached counterpart) for repositories whose initial commit has
  // not been created yet.
  const args = ['--stat', 'HEAD', '--', ...files];
  const fromHead = gitText(execFile, ['diff', ...args], targetDir);
  if (fromHead != null) return fromHead.replace(/\s+$/, '');
  return [
    gitText(execFile, ['diff', '--stat', '--cached', '--', ...files], targetDir),
    gitText(execFile, ['diff', '--stat', '--', ...files], targetDir),
  ].filter((text) => text != null).map((text) => text.replace(/\s+$/, '')).filter(Boolean).join('\n');
}

function untrackedStat(targetDir, files) {
  return files.map((file) => {
    const lines = lineCount(join(targetDir, file));
    return lines == null
      ? `${file} | deleted (untracked)`
      : `${file} | +${lines} lines (new)`;
  }).join('\n');
}

/**
 * Compare byte hashes taken immediately before and after the attempt. This
 * deliberately does not subtract the pre-attempt dirty set: a further edit
 * to a pre-dirty file is a change during this attempt, while new and deleted
 * paths compare against a missing hash. The stat is captured at this same
 * boundary, before sibling callbacks can edit the territory.
 */
function captureDiffSnapshot(targetDir, ownedFiles, before, execFile = execFileSync) {
  if (!before?.ok) return { ok: false, statText: '', changedFiles: [] };
  const afterTerritory = territoryFiles(targetDir, ownedFiles, execFile);
  if (!afterTerritory.ok) return { ok: false, statText: '', changedFiles: [] };
  const after = hashTerritory(targetDir, afterTerritory);
  const files = new Set([...before.files, ...after.files]);
  const changedFiles = [...files].filter((file) => before.hashes.get(file) !== after.hashes.get(file)).sort();
  const tracked = changedFiles.filter((file) => before.tracked.has(file) || after.tracked.has(file));
  const untracked = changedFiles.filter((file) => !before.tracked.has(file) && !after.tracked.has(file));
  const pieces = [
    trackedStat(targetDir, tracked, execFile),
    untrackedStat(targetDir, untracked),
  ].filter(Boolean);
  return { ok: true, statText: pieces.join('\n'), changedFiles };
}

function writeFileIfChanged(path, body) {
  try {
    if (readFileSync(path, 'utf8') === body) return;
  } catch { /* first write */ }
  try { writeFileSync(path, body); } catch { /* best effort */ }
}

function fileBytes(path) {
  try { return statSync(path).size; } catch { return null; }
}

function lastResponseEvents(streamFile, limit = 3) {
  if (!streamFile) return [];
  try {
    const events = [];
    for (const line of readFileSync(streamFile, 'utf8').split('\n')) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.truncated === true) continue;
      if (parsed?.kind === 'response') {
        events.push({
          at: parsed.at ?? null,
          kind: 'response',
          summary: parsed.summary ?? parsed.response ?? null,
        });
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

function durableArtifactPath(runDir, path) {
  if (!path) return null;
  return isAbsolute(path) || !runDir ? path : join(runDir, path);
}

function durableHandoffFacts(attempt, runDir) {
  if (!attempt || typeof attempt !== 'object') return null;
  const streamFile = durableArtifactPath(runDir, attempt.streamFile);
  const diffFile = durableArtifactPath(runDir, attempt.diffFile);
  const outputFile = durableArtifactPath(runDir, attempt.outputFile ?? attempt.partialOutput);
  const diffStatText = diffFile && existsSync(diffFile)
    ? (() => { try { return readFileSync(diffFile, 'utf8').trimEnd(); } catch { return ''; } })()
    : '';
  const outputBytes = attempt.outputBytes ?? (outputFile ? fileBytes(outputFile) : null);
  const lastEvents = lastResponseEvents(streamFile);
  if (!lastEvents.length && typeof attempt.lastResponse === 'string' && attempt.lastResponse) {
    lastEvents.push({ at: attempt.finishedAt ?? null, kind: 'response', summary: attempt.lastResponse });
  }
  return {
    pool: attempt.pool,
    model: attempt.model,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    failureKind: attempt.failureKind,
    why: attempt.why,
    diffStatText,
    diffFile,
    changedFiles: Array.isArray(attempt.changedFiles) ? attempt.changedFiles : [],
    outputFile,
    partialOutput: durableArtifactPath(runDir, attempt.partialOutput),
    outputBytes,
    streamFile,
    hasEventStream: Boolean(streamFile && streamFile.endsWith('.jsonl')),
    lastEvents,
  };
}

function durableHandoff(attempt, runDir, formatHandoff) {
  const facts = durableHandoffFacts(attempt, runDir);
  if (!facts) return null;
  const block = formatHandoff(facts);
  if (typeof block !== 'string' || !block) return null;
  return {
    block,
    from: attempt.id ?? `${attempt.actionId ?? 'attempt'}-${attempt.ordinal ?? 1}`,
    bytes: Buffer.byteLength(block, 'utf8'),
  };
}

export function durableAttemptHandoff(attempt, runDir, formatHandoff = handoffBlock) {
  return durableHandoff(attempt, runDir, formatHandoff);
}

export { handoffBlock };

/**
 * Append this attempt's decision to shared core state. Concurrent actions in
 * one workflow all write this file, so the whole read-modify-write happens
 * inside updateCoreState's cross-process lock on a fresh load — a plain
 * load/push/save dropped sibling entries and undid quarantines (S5, D5).
 */
function appendDecision(bullswarmDir, record, {
  updateCoreState, quarantine = null, strike = null, clearStrikes: clearPool = null,
} = {}) {
  let benchResult = null;
  updateCoreState(bullswarmDir, (state) => {
    state.decisionLog ??= [];
    state.decisionLog.push(record);
    if (quarantine) {
      const kind = quarantine.kind ?? 'auth';
      const until = quarantinePool(state, quarantine.pool, quarantine.reason, quarantine.now, {
        until: quarantine.until ?? null,
        kind,
      });
      // Siblings of a dead credential are benched inside the SAME locked
      // update, on the deadline quarantinePool just computed — one upstream,
      // one deadline, no second window opened a millisecond later.
      quarantineUpstreamSiblings(state, quarantine.groupPools ?? [], {
        pool: quarantine.pool,
        group: quarantine.group ?? null,
        reason: quarantine.reason,
        now: quarantine.now,
        until,
        kind,
      });
    }
    if (clearPool) clearPoolStrikes(state, clearPool);
    if (strike?.pool) {
      const until = recordPoolStrike(state, strike.pool, strike.reason, strike.now);
      const bench = state.pools?.[strike.pool]?.bench ?? null;
      benchResult = {
        pool: strike.pool,
        reason: bench?.reason ?? strike.reason ?? null,
        count: Number(bench?.count ?? 1),
        until: bench?.until ?? until ?? null,
      };
    }
  });
  return benchResult;
}

function selectedModel(pool, effort, preferredModel = null) {
  if (preferredModel && !(pool.strategyExcludedModels ?? []).includes(preferredModel)) return preferredModel;
  const assignment = pool.strategyAssignments?.[effort] ?? null;
  return pool.modelPolicy?.model
    ?? (assignment?.pool === pool.name ? assignment.model : null)
    ?? null;
}

function sessionFor(connector, pool, model, current, now, uuid) {
  if (!connector.conversation) return null;
  if (current?.pool === pool.name && current?.model === (model ?? current.model)) {
    return {
      durable: clone(current),
      invocation: { sessionId: current.sessionId, resume: true },
    };
  }
  const at = new Date(now).toISOString();
  const durable = {
    pool: pool.name,
    model: model ?? connector.model ?? 'provider-default',
    sessionId: uuid(),
    generation: Number(current?.generation ?? 0) + 1,
    startedAt: at,
    lastUsedAt: at,
  };
  return { durable, invocation: { sessionId: durable.sessionId, resume: false } };
}

/**
 * Dispatch one autonomous V2 action.
 *
 * The dispatcher owns only mechanical concerns. Semantic rejection is
 * returned after one observation; it never creates a repair/retry loop.
 */
export async function dispatchV2Action({
  action,
  taskText,
  targetDir,
  paths,
  pools,
  refreshPools = null,
  bullswarmDir,
  runId = null,
  parentEnv = process.env,
  preferredPool = null,
  preferredModel = null,
  strictPool = null,
  reasoningOverride = null,
  runReasoning = null,
  outputValidator = null,
  correctionTask = null,
  handoffBlock: formatHandoff = handoffBlock,
  currentSession = null,
  maxMechanicalRetries = 1,
  silenceTimeoutSec = null,
  shouldCancel = null,
  onAttempt = null,
  onSpawn = null,
  onWorkerExit = null,
  onActivity = null,
  onAgentEvent = null,
  onAgentProgress = null,
  evidence = null,
  dependencies = {},
  resumeAttempt = null,
  resumeHandoff = null,
  runDir = null,
} = {}) {
  if (!action || typeof action.id !== 'string') throw new TypeError('action is required');
  if (typeof taskText !== 'string' || !taskText) throw new TypeError('taskText is required');
  if (!Array.isArray(pools)) throw new TypeError('pools must be an array');
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const watch = dependencies.watchOnce ?? watchOnce;
  const execFile = dependencies.execFile ?? execFileSync;
  const loadCoreState = dependencies.loadState ?? loadState;
  // Injectable for tests; the default is the locked read-modify-write. A test
  // that only stubs loadState/saveState still gets a locked update built from
  // its own stubs, so its recorded writes stay observable.
  const updateCoreState = dependencies.updateState
    ?? (dependencies.loadState || dependencies.saveState
      ? (dir, mutator) => {
        const state = loadCoreState(dir);
        if (mutator(state) !== false) (dependencies.saveState ?? (() => {}))(dir, state);
        return state;
      }
      : updateState);
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const callerSilenceOverride = silenceTimeoutSec !== null && silenceTimeoutSec !== undefined;
  const envSilenceOverride = Number.isFinite(Number(parentEnv?.BULLSWARM_WORKER_SILENCE_SEC))
    && Number(parentEnv.BULLSWARM_WORKER_SILENCE_SEC) > 0;
  const silenceOverride = callerSilenceOverride || envSilenceOverride;
  const configuredSilenceTimeoutSec = callerSilenceOverride
    ? silenceTimeoutSec
    : workerSilenceTimeoutSec(parentEnv);
  const effort = action.effort ?? DEFAULT_EFFORT_BY_LANE[action.lane] ?? 'medium';
  const failedProbes = new Set();
  const liveQuarantines = dependencies.liveQuarantines ?? (() => {
    try { return loadCoreState(bullswarmDir).pools ?? {}; }
    catch { return {}; }
  });
  const prepare = (poolList) => {
    const live = liveQuarantines();
    return preparePools(poolList, action, effort, {
      preferredModel, strictPool, now: now(),
      liveQuarantine: (name) => live[name]?.quarantine ?? null,
      liveBench: (name) => live[name]?.bench ?? null,
    }).filter((pool) => !failedProbes.has(pool.name));
  };
  const safeCoreState = () => {
    try { return loadCoreState(bullswarmDir); } catch { return null; }
  };
  const coreDecisionLog = () => safeCoreState()?.decisionLog ?? [];
  // Operator-configurable, read once: the flat surplus cost of an in-flight
  // agent on a pool whose pacing-window spend rate nobody has measured yet.
  const inflightPenaltyPct = inflightPenaltyFrom(safeCoreState());
  // One expectation for the whole action: lane and effort do not change
  // between attempts, and the spend model is memoized per process anyway. The
  // decision log makes it a measured median instead of a documented default.
  const spendDecisionLog = coreDecisionLog().filter((entry) => entry?.failureKind !== 'stalled');
  const expected = await expectedMinutesFromSpendModel(
    { lane: action.lane ?? 'chore', effort },
    { decisionLog: spendDecisionLog },
  );
  let candidates = prepare(pools);
  // The unfiltered list, kept current across refreshes: a sibling benched for
  // a shared upstream may itself be ineligible for THIS action (wrong lane,
  // blocked model) and still has to be taken out of service for every other.
  let allPools = pools;
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])
    ?.strategyAssignments?.[effort] ?? null;
  const effectivePreferredPool = preferredPool ?? configuredAssignment?.pool ?? null;
  const remaining = [...candidates];
  const attempts = [];
  let correctionUsed = false;
  let retriesUsed = 0;
  let nextTask = taskText;
  let last = null;
  const tried = new Set();
  let forceRefresh = false;
  let replayPool = null;
  let fallbackWhy = null;
  let lastPool = null;
  // The prior attempt's durable facts, carried into the next attempt's task as
  // a `## Prior attempt on this step` handoff block. Null on the first attempt.
  const resumedHandoff = resumeHandoff ?? (resumeAttempt ? durableHandoff(resumeAttempt, runDir, formatHandoff) : null);
  const resumedSuffix = resumedHandoff ? `\n\n${resumedHandoff.block}` : '';
  const baseTaskText = resumedSuffix && taskText.endsWith(resumedSuffix)
    ? taskText.slice(0, -resumedSuffix.length)
    : taskText;
  let priorHandoff = resumedHandoff ? { from: resumedHandoff.from, bytes: resumedHandoff.bytes } : null;
  if (resumedHandoff && !nextTask.includes(resumedHandoff.block)) nextTask = `${nextTask}\n\n${resumedHandoff.block}`;

  while (remaining.length || (last && retriesUsed < maxMechanicalRetries)) {
    if (shouldCancel?.()) return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts, verdict: last };
    const replay = replayPool;
    replayPool = null;
    // Meters and quarantines move while an action is in flight. Re-read them
    // before every pick so a pool that just hit its limit — here or in another
    // run — is no longer a candidate.
    if (typeof refreshPools === 'function') {
      let refreshed = null;
      try { refreshed = await refreshPools({ force: forceRefresh }); }
      catch { refreshed = null; }
      forceRefresh = false;
      if (Array.isArray(refreshed) && refreshed.length) {
        allPools = refreshed;
        candidates = prepare(refreshed);
        remaining.length = 0;
        // A pool deliberately re-queued for a same-pool retry survives the
        // rebuild; every other already-tried pool stays out.
        if (replay) remaining.push(replay);
        for (const candidate of candidates) {
          if (!tried.has(candidate.name) && candidate.name !== replay?.name) remaining.push(candidate);
        }
      }
    }
    const routePools = remaining.length ? remaining : candidates;
    const pickAt = now();
    // Keep active benches in the router's view even though they cannot be
    // selected. Route owns the human explanation (benched with its deadline);
    // the dispatch candidate list still excludes them so retry mechanics never
    // mistake a paused pool for an available fallback.
    const live = liveQuarantines();
    const routeBenchCandidates = preparePools(allPools, action, effort, {
      preferredModel, strictPool, now: pickAt,
      liveQuarantine: (name) => live[name]?.quarantine ?? null,
      ignoreBench: true,
    }).filter((candidate) => {
      const bench = live[candidate.name]?.bench ?? candidate.bench;
      return isBenched({ bench }, pickAt);
    }).map((candidate) => ({
      ...candidate,
      bench: live[candidate.name]?.bench ?? candidate.bench,
    }));
    const liveBenchedNames = new Set(routeBenchCandidates.map((candidate) => candidate.name));
    const routingPools = [
      ...routePools.filter((candidate) => !liveBenchedNames.has(candidate.name)),
      ...routeBenchCandidates,
    ].filter((candidate) => !failedProbes.has(candidate.name));
    // The ledger is re-read HERE, before every pick and every retry, not on
    // the refresher's 15s throttle: up to four kernel actions start within
    // milliseconds of each other, and each has to see the assignments the
    // others just registered. Cheap by construction — a directory read, no
    // meter poll and no network.
    attachForecast(routingPools, bullswarmDir, { now: pickAt, decisionLog: coreDecisionLog() });
    const route = pickPool(action.lane ?? 'chore', routingPools, {
      callerEligible: false,
      callerSession: false,
      preferredPool: effectivePreferredPool,
      // `routingPools` is already filtered to the pin; the router needs the
      // name so routeWhy says the pick was pinned, not compared.
      strictPool,
      effortTier: effort,
      now: pickAt,
      candidateMinutes: expected.expectedMinutes,
      inflightPenaltyPct,
      evidence,
    });
    if (!route.pick) break;
    const pool = route.pick.connector;
    lastPool = pool;
    const connector = pool.connector ?? pool;
    const model = selectedModel(pool, effort, preferredModel);
    const probe = dependencies.probeFreeModel ?? probeFreeModel;
    // A caller-supplied watchOnce is the dispatcher's worker-test seam. It is
    // not the provider CLI that a liveness probe must exercise, so leave
    // probes disabled for those legacy harnesses unless they explicitly
    // inject a probe function of their own.
    const probeEnabled = !dependencies.watchOnce || typeof dependencies.probeFreeModel === 'function';
    if (probeEnabled && shouldProbeFreeModel(pool, model)) {
      const liveness = await probe({
        pool,
        model,
        home: bullswarmDir,
        timeoutMs: 30_000,
        now: pickAt,
      });
      if (!liveness.ok) {
        const reason = `probe: ${liveness.reason}`;
        failedProbes.add(pool.name);
        tried.add(pool.name);
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (remaining[index].name === pool.name) remaining.splice(index, 1);
        }
        updateCoreState(bullswarmDir, (fresh) => {
          recordPoolStrike(fresh, pool.name, reason, pickAt);
        });
        fallbackWhy = fallbackWhy
          ? `${fallbackWhy} · ${reason} on ${pool.name}`
          : `${reason} on ${pool.name}`;
        last = { ok: false, why: reason, failureKind: 'provider', meta: { exitCode: null } };
        continue;
      }
    }
    const ordinal = attempts.length + 1;
    const files = withAttemptArtifacts(attemptPaths(paths, ordinal), action.id, ordinal);
    const beforeAttempt = hashTerritory(
      targetDir,
      territoryFiles(targetDir, action.ownedFiles, execFile),
    );
    const incomingHandoff = priorHandoff;
    priorHandoff = null;
    const session = sessionFor(connector, pool, model, currentSession, now(), uuid);
    const coreState = loadCoreState(bullswarmDir);
    assertDepthAllowed(coreState, parentEnv);
    const attemptSilenceSec = attemptSilenceTimeoutSec(
      pool,
      effort,
      coreState?.decisionLog ?? coreDecisionLog(),
      configuredSilenceTimeoutSec,
      silenceOverride,
    );
    // Resolved per attempt, not per action: a retry lands on another pool with
    // another connector and another model, so the level is recomputed against
    // whatever this attempt actually spawns, reading the LIVE core strategy.
    const reasoning = resolveReasoningLevel({
      connector,
      tier: effort,
      model,
      strategy: coreState.strategy ?? null,
      runOverride: runReasoning,
      actionOverride: reasoningOverride
        ?? (isReasoningLevel(action.reasoning) ? action.reasoning : null),
    });
    const startedAt = new Date(now()).toISOString();
    const routeWhy = fallbackWhy ? `${fallbackWhy} · ${route.why}` : route.why;
    fallbackWhy = null;
    const record = {
      ordinal, pool: pool.name, model: model ?? connector.model ?? null,
      routeWhy,
      routeCandidates: route.candidates.map((candidate) => ({
        pool: candidate.pool,
        effectiveSurplus: candidate.effectiveSurplus,
        urgencyState: candidate.urgencyState,
        forecastPacingPct: candidate.forecastPacingPct,
      })),
      startedAt, finishedAt: null, status: 'running', taskFile: files.taskFile,
      outFile: files.outFile, outputFile: files.outFile, reasoning,
      ...(incomingHandoff ? { handoff: { from: incomingHandoff.from, bytes: incomingHandoff.bytes } } : {}),
      routing: {
        reason: routeWhy, candidates: route.candidates, effort,
        lane: action.lane ?? 'chore', fiveHourUsedPct: pool.fiveHourUsedPct ?? null,
        // What this attempt was routed on: the pool's load and where its 5h
        // window is projected to land once this assignment has run.
        forecast: forecastRecord(route, pool.name),
      },
      ...(session ? { session: clone(session.durable), continued: session.invocation.resume } : {}),
    };
    attempts.push(record);
    tried.add(pool.name);
    onAttempt?.('started', clone(record));
    const runtimeConnector = { ...connector, subscription: pool.subscription ?? connector.subscription ?? null };
    // In-flight the instant the pool is picked — before the spawn, so four
    // concurrent kernel actions cannot all read this pool as idle.
    const ledgerEntry = withLedger(() => registerAssignment(bullswarmDir, {
      pool: pool.name, model: record.model, lane: action.lane ?? 'chore', effort,
      source: 'workflow-v2', runId: runId ?? runIdFromPaths(files),
      actionId: action.id, attempt: ordinal, startedAt, ...expected,
    }));
    let workerPid = null;
    let verdict;
    let snapshot = { ok: false, statText: '', changedFiles: [] };
    try {
      verdict = await watch(runtimeConnector, nextTask, targetDir, files, {
        env: childDepthEnv(parentEnv),
        model,
        reasoning,
        conversation: session?.invocation ?? null,
        shouldCancel,
        silenceTimeoutSec: attemptSilenceSec,
        processGroup: true,
        onSpawn: (pid) => {
          workerPid = pid;
          if (ledgerEntry) withLedger(() => updateAssignment(bullswarmDir, ledgerEntry.id, { workerPid: pid }));
          onSpawn?.(pid);
        },
        outputValidator,
        onActivity,
        onAgentEvent,
        onAgentProgress,
        bullswarmDir,
        poolName: pool.name,
        runId: runId ?? runIdFromPaths(files),
        attemptId: `${action.id}-${ordinal}`,
        startedAt,
        subscription: pool.subscription ?? connector.subscription ?? null,
      });
      // Capture before releasing the in-flight ledger entry or invoking the
      // worker-exit callback. Either can let a sibling begin editing this
      // territory, which must not be attributed to the attempt that ended.
      snapshot = captureDiffSnapshot(targetDir, action.ownedFiles, beforeAttempt, execFile);
    } finally {
      if (ledgerEntry) withLedger(() => releaseAssignment(bullswarmDir, ledgerEntry.id));
      if (workerPid) onWorkerExit?.(workerPid);
    }
    // The saved file is the attribution record; later sibling edits are not
    // replayed into it.
    if (snapshot.ok) writeFileIfChanged(files.diffFile, snapshot.statText ? `${snapshot.statText}\n` : '');
    const outputBytes = fileBytes(files.outFile);
    const streamFile = verdict?.meta?.streamFile
      ?? (files.streamFile && existsSync(files.streamFile) ? files.streamFile : null)
      ?? (files.stdoutFile && existsSync(files.stdoutFile) ? files.stdoutFile : null);
    const lastEvents = lastResponseEvents(streamFile);
    const finishedAt = new Date(now()).toISOString();
    const kind = classifyFailure(verdict, pool);
    // One dead upstream credential is ONE outage however many pool names front
    // it. The in-memory candidate list predates the quarantine written below,
    // and a refresher is optional, so the group is dropped here as well — the
    // next attempt of THIS action must not walk from one pool name to the next
    // sibling on the same credential into the same failure, as it did on
    // 2026-09-11.
    const benchedGroup = verdict.quarantineHint && kind === 'auth' ? upstreamGroupOf(pool) : null;
    if (benchedGroup) {
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (upstreamGroupOf(remaining[i]) === benchedGroup) remaining.splice(i, 1);
      }
    }
    const remainingAfterAttempt = remaining.filter((candidate) => candidate.name !== pool.name);
    const canCorrectSchema = kind === 'schema' && !correctionUsed && typeof correctionTask === 'function';
    // A free stall (and the provider-shaped verdict for literally empty free
    // output) is bounded by the tried-set, not by the mechanical retry budget:
    // it may move on to every other eligible pool even after a metered failure
    // has spent today's allowance, but it is never replayed on the same pool.
    const freeBudgetExempt = pool.free === true
      && (kind === 'stalled' || (kind === 'provider' && verdict?.why === 'empty output'));
    const hasUntriedPool = remainingAfterAttempt.length > 0;
    const hasRetryBudget = retriesUsed < maxMechanicalRetries;
    const canRetrySamePool = hasRetryBudget && candidates.length === 1 && !POOL_FATAL_KINDS.has(kind);
    const canRetryMechanically = MECHANICAL_KINDS.has(kind)
      && kind !== 'schema'
      && (freeBudgetExempt
        ? hasUntriedPool
        : hasRetryBudget && (hasUntriedPool || canRetrySamePool));
    const willRecover = canCorrectSchema || canRetryMechanically;
    Object.assign(record, {
      finishedAt,
      status: verdict.ok
        ? 'succeeded'
        : kind === 'cancelled'
          ? 'cancelled'
          : willRecover
            ? 'interrupted'
            : 'failed',
      failureKind: kind,
      why: verdict.why ?? null,
      usage: clone(verdict.meta?.usage ?? null),
      wallSec: verdict.meta?.wallSec ?? null,
      willRetry: willRecover,
      outputFile: files.outFile,
      ...(outputBytes != null ? { outputBytes } : {}),
      ...(streamFile ? { streamFile } : {}),
      ...(snapshot.ok ? { diffFile: files.diffFile, changedFileCount: snapshot.changedFiles.length } : {}),
      lastResponse: lastEvents.at(-1)?.summary ?? null,
      ...(Array.isArray(verdict.notes) && verdict.notes.length ? { notes: clone(verdict.notes) } : {}),
      ...(kind === 'stalled'
        ? { stalled: true, partialOutput: files.outFile, silentSec: attemptSilenceSec }
        : {}),
    });
    // The provider's own session id (when its stream/transcript reports one)
    // is the durable lookup key. Conversation-capable connectors already have
    // a generated session record; update that record in place so reprice can
    // resolve the same provider session without guessing by time window.
    const measuredSessionId = verdict.meta?.usage?.sessionId ?? null;
    if (measuredSessionId && record.session) {
      record.session.sessionId = measuredSessionId;
    }
    // A schema-invalid answer still completed a real provider turn. Resume
    // that same physical conversation for the bounded correction instead of
    // opening a second session and losing the model's immediate context.
    const sessionEstablished = verdict.ok || kind === 'schema' || kind === 'semantic';
    if (session && sessionEstablished) {
      record.session.lastUsedAt = finishedAt;
      currentSession = clone(record.session);
    }
    last = verdict;
    const bench = appendDecision(bullswarmDir, {
      ts: finishedAt, lane: action.lane ?? 'chore', picked: pool.name,
      keepOnClaude: false, ok: verdict.ok, failureKind: verdict.ok ? null : kind, why: verdict.why ?? null,
      wallSec: verdict.meta?.wallSec ?? null, model: record.model,
      reasoning: clone(reasoning),
      usage: verdict.meta?.usage ?? null, routing: record.routing,
      forecast: record.routing.forecast,
      outFile: files.outFile, source: 'workflow-v2', actionId: action.id,
    }, {
      updateCoreState,
      clearStrikes: verdict.ok ? pool.name : null,
      strike: !verdict.ok && (kind === 'stalled' || kind === 'provider')
        ? { pool: pool.name, reason: kind === 'stalled' ? 'stall' : 'provider', now: now() }
        : null,
      quarantine: verdict.quarantineHint ? {
        pool: pool.name, reason: verdict.why, now: now(),
        until: verdict.quarantineUntil ?? null,
        kind: kind === 'quota' ? 'quota' : 'auth',
        group: upstreamGroupOf(pool), groupPools: allPools,
      } : null,
    });
    if (bench) record.bench = clone(bench);
    onAttempt?.('finished', clone(record), verdict);
    // A quota failure invalidates this run's meter picture: poll live before
    // choosing where the work goes next.
    if (kind === 'quota') forceRefresh = true;
    if (verdict.ok) return { ok: true, status: 'succeeded', attempts, verdict, session: currentSession };
    if (kind === 'cancelled') return { ok: false, status: 'cancelled', failureKind: kind, attempts, verdict };
    if (!MECHANICAL_KINDS.has(kind)) return { ok: false, status: 'failed', failureKind: kind, attempts, verdict };

    if (kind === 'stalled' && canRetryMechanically) {
      fallbackWhy = `fallback from ${pool.name} after stall ${Math.round(attemptSilenceSec)}s`;
    }

    const index = remaining.findIndex((candidate) => candidate.name === pool.name);
    if (index >= 0) remaining.splice(index, 1);
    if (canCorrectSchema) {
      correctionUsed = true;
      nextTask = correctionTask(verdict, { originalTask: baseTaskText, attempt: ordinal });
      // Schema correction continues the same physical conversation when the
      // connector supports it. Put the same pool first without widening the
      // total correction allowance.
      remaining.unshift(pool);
      replayPool = pool;
      continue;
    }
    if (canRetryMechanically) {
      const facts = {
        pool: pool.name,
        model: record.model,
        startedAt,
        finishedAt,
        failureKind: kind,
        why: verdict.why ?? null,
        diffStatText: snapshot.statText,
        diffFile: snapshot.ok ? files.diffFile : null,
        changedFiles: snapshot.changedFiles,
        outputFile: files.outFile,
        partialOutput: kind === 'stalled' ? files.outFile : null,
        outputBytes,
        streamFile,
        hasEventStream: connector.eventStream != null,
        lastEvents,
      };
      const block = formatHandoff(facts);
      nextTask = `${baseTaskText}\n\n${block}`;
      priorHandoff = {
        from: `${action.id}-${ordinal}`,
        bytes: Buffer.byteLength(block, 'utf8'),
      };
    }
    // Free transport failures do not spend the mechanical retry budget. The
    // selected pool was already removed above; continue only when an untried
    // eligible pool remains, so a free-only action still terminates.
    if (freeBudgetExempt) {
      if (canRetryMechanically) continue;
      break;
    }
    if (retriesUsed >= maxMechanicalRetries) break;
    retriesUsed += 1;
    // Prefer a different eligible pool. If no alternative exists, one bounded
    // same-pool retry is permitted for transient process/provider failure.
    if (!remaining.length && candidates.length === 1 && !POOL_FATAL_KINDS.has(kind)) {
      remaining.push(pool);
      replayPool = pool;
    }
  }

  // The step fails now rather than waiting for a pool: a run never sits open
  // on quota. When every pool that can run it is paused, say when the first one
  // comes back, so the caller knows when `workflow resume` will get through.
  const lane = action.lane ?? 'chore';
  const capable = preparePools(allPools, action, effort, {
    preferredModel, strictPool, now: now(), ignoreQuarantine: true, ignoreBench: true,
  }).filter((pool) => !failedProbes.has(pool.name));
  const live = liveQuarantines();
  let comesBack = null;
  for (const pool of capable) {
    const deadlines = [
      pool.quarantine?.until,
      live[pool.name]?.quarantine?.until,
      pool.bench?.until,
      live[pool.name]?.bench?.until,
    ]
      .map((value) => (typeof value === 'string' ? Date.parse(value) : Number(value)))
      .filter((value) => Number.isFinite(value) && value > now());
    // A capable pool that is not paused gives no single time to wait for.
    if (!deadlines.length) { comesBack = null; break; }
    const back = Math.max(...deadlines);
    comesBack = comesBack == null ? back : Math.min(comesBack, back);
  }
  const retryAfter = comesBack == null ? null : new Date(comesBack).toISOString();
  const failureKind = last ? classifyFailure(last, lastPool) : 'unavailable';
  const why = !capable.length
    ? strictPool
      ? `no eligible pool: the pinned pool ${strictPool} cannot run ${lane}/${effort} work (it is disabled or has no model on the ${effort} tier)`
      : `no eligible pool: no enabled pool has a model on the ${effort} tier for ${lane} work`
    : retryAfter
      ? `no eligible pool: every pool that can run this step is paused until ${retryAfter}`
      : 'no eligible pool';
  return {
    ok: false,
    status: 'failed',
    failureKind,
    ...(retryAfter && ['quota', 'auth', 'unavailable'].includes(failureKind) ? { retryAfter } : {}),
    attempts,
    verdict: last ?? { ok: false, why, meta: { exitCode: null } },
  };
}

export { classifyFailure as classifyV2DispatchFailure, preparePools as prepareV2DispatchPools, trackedStat as trackedDiffStatForTests };
