import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { handoffBlock } from './v2-runtime.js';
import {
  LANES, PACING_FORECAST_BLOCK_PCT, expiringSoonView, pickPool, isFree,
} from '../lib/route.js';
import { windowSpent } from '../meters/framework.js';
import {
  assertDepthAllowed, childDepthEnv, loadState, updateState, upstreamGroupOf,
} from '../lib/state.js';
import { disabledModelsForPool, resolveDispatchModel, selectedModelsForTier, rungRecord } from '../lib/strategy.js';
import { isReasoningLevel, resolveReasoningLevel } from '../lib/reasoning.js';
import { watchOnce } from '../lib/watch.js';
import { MAX_THROTTLE_RETRIES, throttleBackoffMs } from '../lib/quota.js';
import {
  expectedMinutesFromSpendModel, registerAssignment, releaseAssignment, updateAssignment,
  withLedger,
} from '../lib/assignments.js';
import { attachForecast, forecastRecord, inflightPenaltyFrom } from '../lib/forecast.js';
import { probeFreeModel, shouldProbeFreeModel } from '../lib/probe.js';
import { MIN_DURATION_SAMPLES, MIN_EXPECTED_MINUTES } from '../lib/spend.js';
import { DEFAULT_EFFORT_BY_LANE } from './action-validator.js';
import { declaredDeliverable, declaredEvidence, failureClassOf, roleOf } from './step-vocabulary.js';
import { poolPassesRoute, routeUnavailableWhy } from './step-route.js';
import {
  evidenceEnv, evidenceFailureWhy, evidenceSchemaBaseline, evidenceScope, removeCreatedOutOfScope,
  restoreChangedOutOfScope, runStepEvidence,
} from './evidence-runner.js';

const MECHANICAL_KINDS = new Set(['auth', 'quota', 'throttle', 'provider', 'process', 'interrupted', 'schema', 'stalled']);
/** Kinds that make the SAME pool unusable, so a retry must move elsewhere. */
const POOL_FATAL_KINDS = new Set(['auth', 'quota']);
export const GATE_RETRY_PIN_SOURCE = 'the same pool (gate retry)';
// Marked runs: the longest wait a provider may name for a transient rate
// limit that is still sat out on the same pool. A longer one goes to the
// caller, told when the provider said to try again.
export const MARKED_THROTTLE_MAX_WAIT_MS = 2 * 60_000;

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
  if (verdict?.failureKind === 'not-produced') return 'not-produced';
  if (verdict?.failureKind === 'failed-evidence') return 'failed-evidence';
  // A usage limit is a healthy credential with an empty window, and only it
  // carries a real reset.
  if (verdict?.failureKind === 'quota') return 'quota';
  if (verdict?.failureKind === 'throttle') return 'throttle';
  if (verdict?.failureKind === 'auth') return 'auth';
  if (verdict?.failureKind === 'stalled' || verdict?.meta?.stalled) return 'stalled';
  if (verdict?.failureKind === 'provider' || verdict?.meta?.providerFailureType) return 'provider';
  if (verdict?.failureKind === 'schema') return 'schema';
  // A free endpoint that returned literally no answer is indistinguishable
  // from a dead provider for routing purposes. Keep semantic announcements and
  // other verifier judgments intact; only the explicit empty-output verdict is
  // eligible for the provider retry path. Check this before a non-zero
  // exit-code classification because some connectors terminate after emitting
  // an empty response and still need the provider fallback.
  if (pool?.free === true && verdict?.why === 'empty output') return 'provider';
  if (verdict?.failureKind === 'process' || (verdict?.meta?.exitCode != null && verdict.meta.exitCode !== 0)) return 'process';
  if (verdict?.meta?.signal) return 'interrupted';
  if (verdict?.meta?.timedOut || verdict?.meta?.spawnError) return 'provider';
  return 'semantic';
}

// Stage 3, marked runs only: a worker whose CLI never started did nothing,
// so its failure is a process failure (another pool, D4) and the one retry an
// act step may get (D32). classifyFailure keeps reading it as saved runs do.
function workerNeverStarted(verdict) {
  return verdict?.meta?.workerNotStarted === true || Boolean(verdict?.meta?.spawnError);
}

// A spent usage window arrives as `quota` from the worker's verdict itself:
// every dispatch under the usage-limit rules asks watchOnce for the
// limits-to-caller reading (`usageLimitsToCaller`).
function markedFailureKind(verdict, pool = null) {
  const kind = classifyFailure(verdict, pool);
  if (kind && kind !== 'cancelled' && workerNeverStarted(verdict) && failureClassOf(kind) !== 'process') return 'process';
  return kind;
}

// Marked usage-limit rules: when a rate limit names a wait too long to sit
// out, the time the provider said to try again (never slept), else null.
function longThrottleReturn(kind, verdict, finishedMs) {
  const wait = kind === 'throttle' && Number(verdict?.throttleWaitMs) > 0 ? Number(verdict.throttleWaitMs) : null;
  return wait != null && wait > MARKED_THROTTLE_MAX_WAIT_MS ? finishedMs + wait : null;
}

function toMs(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

function providerIdFromModel(model) {
  if (typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

function preparePools(pools, action, effort, {
  preferredModel = null, strictPool = null, now = Date.now(),
  // Which pools COULD run this action were none at its limit: a pool with a
  // window at its limit (framework.js windowSpent) is still capable (it comes
  // back at its reset). Used to say when work can be retried, and to refuse
  // a pin or a route that can never run it.
  ignoreBurstGate = false,
  // The step's route (step-route.js resolveRouteFilter): a hard filter on
  // every list this builds, before any ranking (D18).
  routeFilter = null,
} = {}) {
  const available = [];
  for (const pool of pools) {
    if (pool.enabled === false || (!ignoreBurstGate && windowSpent(pool, now))) continue;
    if (routeFilter && !poolPassesRoute(pool, routeFilter)) continue;
    const connector = pool.connector ?? pool;
    // A discovered provider clone represents one concrete credential and its
    // meter. Retargeting it to another provider-qualified model would make the
    // pool label and quota attribution untrue. An exact
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

// `evidence-<step>-attempt-<n>-<k>.log` beside the task. `<n>` comes from the
// task file, which carries the run-wide attempt number (a resumed step's
// first attempt in this dispatch is not attempt 1 of the step).
function evidenceLogFile(taskFile, actionId, ordinal, index) {
  const name = basename(taskFile);
  const stem = name.startsWith('task-') ? name.slice(5).replace(/\.[^.]+$/, '') : `${actionId}-attempt-${ordinal}`;
  return join(dirname(taskFile), `evidence-${stem}-${index}.log`);
}

function withAttemptArtifacts(files) {
  return {
    ...files,
    streamFile: files.streamFile ?? artifactBesideTask(files.taskFile, 'stream', '.jsonl'),
    stdoutFile: files.stdoutFile ?? artifactBesideTask(files.taskFile, 'stdout', '.log'),
    diffFile: files.diffFile ?? artifactBesideTask(files.taskFile, 'diff', '.txt'),
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
  const files = withAttemptArtifacts({ taskFile });
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

// Null when git cannot see the workspace: `git ls-files` fails, or the
// workspace folder itself is ignored by its repository (a scratch folder in
// .gitignore lists nothing and hides every write). Both count as outside git.
function trackedFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '-z'], targetDir);
  if (output == null) return null;
  if (gitText(execFile, ['check-ignore', '-q', '.'], targetDir) != null) return null;
  return new Set(output.split('\0').filter(Boolean));
}

// Untracked, not ignored files, relative to the workspace like `ls-files`.
// `git status` prints repository-root paths, which are wrong when the
// workspace is a subfolder of the repository.
function unignoredUntrackedFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '--others', '--exclude-standard', '-z'], targetDir);
  return output == null ? null : new Set(output.split('\0').filter(Boolean));
}

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || !path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// `git` is false when git cannot see the workspace (trackedFiles). A declared
// deliverable then hashes its exact owned files and extra paths directly
// (D21); a legacy step does not.
function territoryFiles(targetDir, ownedFiles, execFile, extraPaths = [], { directWhenUngit = false } = {}) {
  const declared = Array.isArray(ownedFiles) ? ownedFiles.filter(Boolean) : [];
  const extras = uniquePaths(extraPaths);
  const tracked = trackedFiles(targetDir, execFile);
  if (tracked == null) {
    if (!directWhenUngit) return { ok: false, files: new Set(), tracked: new Set(), git: false };
    const direct = uniquePaths([...declared, ...extras]);
    if (!direct.length) return { ok: false, files: new Set(), tracked: new Set(), git: false };
    return { ok: true, files: new Set(direct), tracked: new Set(), git: false };
  }
  if (declared.length) {
    const files = new Set(uniquePaths([...declared, ...extras]));
    return {
      ok: true,
      files,
      tracked: new Set([...files].filter((file) => tracked.has(file))),
      git: true,
    };
  }
  const untracked = unignoredUntrackedFiles(targetDir, execFile);
  if (untracked == null) return { ok: false, files: new Set(), tracked, git: true };
  return {
    ok: true,
    files: new Set([...tracked, ...untracked, ...extras]),
    tracked,
    git: true,
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

// The commit HEAD points at, or null outside git or before the first commit.
// A commit step changes no file bytes but moves HEAD.
function headCommit(targetDir, execFile) {
  return gitText(execFile, ['rev-parse', '--verify', '-q', 'HEAD'], targetDir)?.trim() || null;
}

// Direct file stats. Never calls git. A directory is not a produced file.
export function statDeliverablePaths(targetDir, paths) {
  const stats = new Map();
  for (const path of uniquePaths(paths)) {
    let exists = false;
    let sha1 = null;
    let mtimeMs = null;
    try {
      const stat = statSync(join(targetDir, path));
      if (stat.isFile()) {
        exists = true;
        sha1 = fileDigest(targetDir, path);
        mtimeMs = stat.mtimeMs;
      }
    } catch { /* missing or unreadable */ }
    stats.set(path, { exists, sha1, mtimeMs });
  }
  return stats;
}

// Git works, or the step names exact owned files or deliverable paths (D21).
export function snapshotPossible(targetDir, action) {
  if (trackedFiles(targetDir, execFileSync) != null) return true;
  const owned = Array.isArray(action?.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
  return owned.length > 0 || (declaredDeliverable(action)?.paths?.length ?? 0) > 0;
}

function pathStat(table, path) {
  if (!table) return null;
  if (typeof table.get === 'function') return table.get(path) ?? null;
  return Object.prototype.hasOwnProperty.call(table, path) ? table[path] : null;
}

// Created, bytes changed, or mtime changed. A missing file was not written.
function pathWasWritten(before, after) {
  if (!after?.exists) return false;
  if (!before?.exists) return true;
  return before.sha1 !== after.sha1 || before.mtimeMs !== after.mtimeMs;
}

function ownedStatsWritten(before, after) {
  const keys = new Set([
    ...(typeof before?.keys === 'function' ? before.keys() : Object.keys(before ?? {})),
    ...(typeof after?.keys === 'function' ? after.keys() : Object.keys(after ?? {})),
  ]);
  for (const path of keys) {
    if (pathWasWritten(pathStat(before, path), pathStat(after, path))) return true;
  }
  return false;
}

function compareDeclaredPaths(paths, before, after) {
  const written = [];
  const missing = [];
  for (const path of paths) {
    const next = pathStat(after, path);
    if (!next?.exists) missing.push(path);
    else if (pathWasWritten(pathStat(before, path), next)) written.push(path);
  }
  return { written, missing };
}

function nameList(paths) {
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

function gateBaselinePaths(action, gitWorks) {
  const declared = declaredDeliverable(action);
  if (!declared) return [];
  if (declared.paths?.length) return declared.paths;
  if (gitWorks) return [];
  return Array.isArray(action?.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
}

// The gate measures the whole step (D19), and only when the content verdict
// is ok. A step with no declared deliverable keeps the legacy lane rule.
// `changed` is the union of this dispatch's attempts; heads and path stats
// are the step baseline. Returns `{ fact, failWhy }`. `fact` is null when
// the action declares no deliverable.
export function deliverableVerdict({
  action,
  verdict,
  legacyGate = true,
  snapshotOk = false,
  changed = [],
  headBefore = null,
  headAfter = null,
  pathsBefore = null,
  pathsAfter = null,
  outputBytes = null,
  earlierWork = { produced: false, unknown: false },
} = {}) {
  const declared = declaredDeliverable(action);
  const contentOk = verdict?.ok !== false;
  const evidence = Array.isArray(action?.evidenceFor) && action.evidenceFor.length > 0;
  const changedList = Array.isArray(changed) ? changed : [];
  const headMoved = headBefore !== headAfter;
  const paths = declared?.paths ?? [];
  const compared = paths.length ? compareDeclaredPaths(paths, pathsBefore, pathsAfter) : { written: [], missing: [] };
  const statWrite = paths.length
    ? compared.written.length > 0
    : ownedStatsWritten(pathsBefore, pathsAfter);
  // For a path deliverable, "this dispatch changed nothing" (D19 3) means no
  // declared path was written: a resumed worker that only reruns its checks
  // may leave a log behind without redoing the deliverable.
  const dispatchChanged = paths.length ? statWrite : changedList.length > 0 || headMoved || statWrite;
  const earlierHit = !dispatchChanged && (earlierWork?.produced === true || earlierWork?.unknown === true);
  const quiet = (fact, failWhy) => ({ fact, failWhy: contentOk ? failWhy : null });

  if (!declared) {
    if (action?.kind === 'digest' || evidence || legacyGate === false) return { fact: null, failWhy: null };
    const judged = action?.lane === 'build' && action?.kind !== 'integration' && snapshotOk === true;
    if (!judged || earlierHit) return { fact: null, failWhy: null };
    if (!dispatchChanged) return quiet(null, 'no file changed and no commit made');
    return { fact: null, failWhy: null };
  }

  const type = declared.type;
  if (action?.kind === 'digest' || evidence) return { fact: { type, gated: false, produced: null }, failWhy: null };
  if (type === 'outward') return { fact: { type: 'outward', gated: false, produced: null }, failWhy: null };
  if (type === 'report') {
    const produced = Number(outputBytes) > 0;
    return quiet(
      { type: 'report', gated: true, produced },
      produced ? null : 'report is empty',
    );
  }
  if (paths.length) {
    const factPaths = {
      written: compared.written.slice(0, 50),
      missing: compared.missing.slice(0, 50),
    };
    if (compared.missing.length) {
      return quiet(
        { type, gated: true, produced: false, ...factPaths, ...(earlierHit ? { carried: true } : {}) },
        `declared ${type} missing: ${nameList(compared.missing)}`,
      );
    }
    if (!compared.written.length) {
      if (earlierHit) {
        return { fact: { type, gated: true, produced: true, written: [], missing: [], carried: true }, failWhy: null };
      }
      return quiet(
        { type, gated: true, produced: false, written: [], missing: [] },
        `declared ${type} not written: ${nameList(paths)}`,
      );
    }
    return { fact: { type, gated: true, produced: true, ...factPaths }, failWhy: null };
  }

  // files, no paths. combine is exempt. No snapshot means the promise cannot
  // be checked (D21), so the attempt is recorded and not failed.
  const role = roleOf(action);
  if (role === 'combine' || snapshotOk !== true) {
    return {
      fact: { type: 'files', gated: false, produced: null, ...(earlierHit ? { carried: true } : {}) },
      failWhy: null,
    };
  }
  if (earlierHit) return { fact: { type: 'files', gated: false, produced: null, carried: true }, failWhy: null };
  if (!dispatchChanged) return quiet({ type: 'files', gated: true, produced: false }, 'no file changed and no commit made');
  return { fact: { type: 'files', gated: true, produced: true }, failWhy: null };
}

/**
 * Compare byte hashes taken immediately before and after the attempt. This
 * deliberately does not subtract the pre-attempt dirty set: a further edit
 * to a pre-dirty file is a change during this attempt, while new and deleted
 * paths compare against a missing hash. The stat is captured at this same
 * boundary, before sibling callbacks can edit the territory.
 */
function captureDiffSnapshot(targetDir, ownedFiles, before, execFile = execFileSync, extraPaths = [], options = {}) {
  if (!before?.ok) return { ok: false, statText: '', changedFiles: [] };
  const afterTerritory = territoryFiles(targetDir, ownedFiles, execFile, extraPaths, options);
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
    // Only when the attempt ran its checks, so every other handoff stays
    // byte-identical.
    ...(Array.isArray(attempt.evidenceResults) ? { evidenceResults: clone(attempt.evidenceResults) } : {}),
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

// --- Caller-driven step restart ----------------------------------------------
// `bullswarm workflow step restart <run> <step> [--pool <pool>]` never edits a
// live kernel's state: like pause, it writes one intent next to the run. The
// kernel stops that step's running attempt (stop kind `restarted`), puts the
// step straight back in the queue, and the step's next attempt carries the
// stopped attempt's durable handoff block — on the named pool when one was
// given. The intent stays on disk until that next attempt starts, so a kernel
// that dies in between still hands off (and pins the pool) on resume. Nothing
// ever restarts a step automatically.

const STEP_ID = /^[a-z0-9][a-z0-9-]*$/;
const RESTART_FILE = /^restart-([a-z0-9][a-z0-9-]*)\.json$/;

export function stepRestartPath(runDir, actionId) {
  if (!STEP_ID.test(actionId ?? '')) throw new TypeError(`step id must be a kebab-case ID (got "${actionId}")`);
  return join(runDir, `restart-${actionId}.json`);
}

function writeRestart(path, request) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Record a restart intent for one step. A newer request replaces an older one.
 * `step rerun` (stage 3, D20) writes one already applied (`appliedAt`), with
 * `source: 'step-rerun'` and the `revisionRequestId` of the revision it
 * belongs to; it counts only once that revision is applied.
 */
export function requestStepRestart(runDir, {
  actionId, attemptId = null, pool = null, source = 'cli',
  now = () => new Date().toISOString(), id = null,
  revisionRequestId = null, appliedAt = null,
} = {}) {
  const request = {
    schemaVersion: 1,
    id: id ?? `restart-${randomUUID().slice(0, 8)}`,
    actionId, attemptId, pool: pool || null, source,
    ...(revisionRequestId ? { revisionRequestId } : {}),
    requestedAt: now(), appliedAt: appliedAt || null,
  };
  writeRestart(stepRestartPath(runDir, actionId), request);
  return request;
}

/** Every restart intent in the run directory, oldest first. */
export function readStepRestarts(runDir) {
  let names = [];
  try { names = readdirSync(runDir); } catch { return []; }
  const requests = [];
  for (const name of names) {
    const match = RESTART_FILE.exec(name);
    if (!match) continue;
    try {
      const request = JSON.parse(readFileSync(join(runDir, name), 'utf8'));
      if (request?.actionId === match[1]) requests.push(request);
    } catch { /* a half-written intent is read on the next poll */ }
  }
  return requests.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

/** The kernel has stopped and requeued the step; the intent now waits for its next attempt. */
export function markStepRestartApplied(runDir, request, { at, attemptId = request.attemptId } = {}) {
  const applied = { ...request, attemptId: attemptId ?? null, appliedAt: at };
  writeRestart(stepRestartPath(runDir, request.actionId), applied);
  return applied;
}

export function clearStepRestart(runDir, actionId) {
  try { rmSync(stepRestartPath(runDir, actionId), { force: true }); } catch { /* already gone */ }
}

/**
 * Put a restarted step back in the queue. The kernel calls this once the
 * step's running attempt has stopped (or when no attempt was running, e.g. a
 * resume after the kernel died). Returns {requeued, why, attemptId, stoppedPool}.
 */
export function requeueRestartedStep(state, request) {
  const runtime = (state.actions ?? []).find((entry) => entry.id === request.actionId);
  if (!runtime) return { requeued: false, why: `the plan has no step ${request.actionId}` };
  if (runtime.status === 'succeeded') return { requeued: false, why: 'it finished before the restart took effect' };
  if (runtime.status === 'removed') return { requeued: false, why: 'a plan revision removed it' };
  if (runtime.status === 'running') return { requeued: false, why: 'its attempt is still running' };
  const stopped = (request.attemptId ? (state.attempts ?? []).find((attempt) => attempt.id === request.attemptId) : null)
    ?? (state.attempts ?? []).findLast((attempt) => attempt.actionId === request.actionId);
  if (['cancelled', 'interrupted', 'failed', 'blocked'].includes(runtime.status)) {
    Object.assign(runtime, { status: 'pending', finishedAt: null, lastFailure: null });
  }
  return { requeued: true, why: null, attemptId: stopped?.id ?? null, stoppedPool: stopped?.pool ?? null };
}

// D20: a `step rerun` intent is live only once its revision is applied. A
// queued revision the kernel later rejected must not hand a stale handoff to
// a later `plan revise --rerun`.
function stepRerunRevisionApplied(state, revisionRequestId) {
  if (typeof revisionRequestId !== 'string' || !revisionRequestId) return false;
  return (state?.revisions ?? []).some((record) => record?.id === revisionRequestId && record.status === 'applied');
}

/**
 * The applied restart intent for a step about to be dispatched, and the
 * handoff block its next attempt carries (built from the stopped attempt's
 * durable facts, exactly as a mechanical retry's would be).
 */
export function appliedStepRestart(state, runDir, actionId, formatHandoff = handoffBlock) {
  const request = readStepRestarts(runDir).find((entry) => entry.actionId === actionId && entry.appliedAt
    && (entry.source !== 'step-rerun' || stepRerunRevisionApplied(state, entry.revisionRequestId)));
  if (!request) return null;
  const stopped = request.attemptId
    ? (state.attempts ?? []).find((attempt) => attempt.id === request.attemptId)
    : (state.attempts ?? []).findLast((attempt) => attempt.actionId === actionId);
  return { request, pool: request.pool ?? null, attempt: stopped ?? null, handoff: stopped ? durableAttemptHandoff(stopped, runDir, formatHandoff) : null };
}

/**
 * Append this attempt's decision to shared core state. Concurrent actions in
 * one workflow all write this file, so the whole read-modify-write happens
 * inside updateCoreState's cross-process lock on a fresh load — a plain
 * load/push/save dropped sibling entries (S5, D5). The decision log is all a
 * dispatch writes there: no pool is paused or benched (state.js S1).
 */
function appendDecision(bullswarmDir, record, { updateCoreState } = {}) {
  updateCoreState(bullswarmDir, (state) => {
    state.decisionLog ??= [];
    state.decisionLog.push(record);
  });
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
  ledgerAttempts = [],
  dependencies = {},
  resumeAttempt = null,
  resumeHandoff = null,
  runDir = null,
  // `({ pool, startedAt }) => ({ text, record }) | null`: the soft time box
  // for one attempt (src/workflow/time-box.js). Resolved per attempt, because
  // a retry can land on another pool and always starts its own clock.
  timeBox = null,
  // The D16 marker. Saved runs pass false and keep the old unjudged lane rule.
  legacyGate = true,
  earlierWork = { produced: false, unknown: false },
  extraSnapshotPaths = [],
  // Stage 2 (E14): false once an attempt of the step's current definition
  // already failed with failed-evidence, so the one evidence retry survives a
  // kernel restart. The checks themselves are read from `action.evidence`.
  evidenceRetryAvailable = true,
  // `(event) => void` for each evidence item's started / running / finished.
  onEvidence = null,
  // The step runs in an isolated copy of its own (E5): the private-copy scope.
  privateWorkspace = false,
  // Stage 3 (§2.1, marked runs only): one automatic retry per step, then the
  // caller. False keeps every rule above byte for byte (saved runs, planner,
  // scout, `bullswarm run`).
  failureRule = false,
  // Stage 3, the Workflow Planner and preflight scout of a marked run (owner
  // decision, 2026-09-25): the usage-limit rules of the failure rule and
  // nothing else. A usage limit ends the dispatch with no retry and no move;
  // a transient rate limit backs off on its own pool only (20 s, then 60 s,
  // or a named wait up to two minutes), then ends it; a nearly spent
  // (draining) pool is never fed, as for a marked step; no pool that can take
  // the work now ends it at once; the end reports each capable pool's reason
  // as a marked step does. Crashes, sign-in failures, provider errors and the
  // output corrections keep the unmarked rules. Ignored when failureRule is
  // true.
  usageLimitsToCaller = false,
  // Counted retries (`retryOf.how` other-pool or same-pool) the step's current
  // definition already started, so a kernel resume never refunds the budget.
  retriesAlready = 0,
  // step-route.js resolveRouteFilter: a hard filter on every pool list (D18).
  routeFilter = null,
  // Who pinned `strictPool` (D30): null reads `--worker-pool`.
  pinSource = null,
  // Stage 3: `[{pool, failureKind}]`, the pools the step's earlier attempts
  // failed on because of the pool (step-vocabulary.js poolCausedPools). The
  // first pick of this dispatch takes another pool when one can take the
  // step now.
  leavePools = null,
} = {}) {
  if (!action || typeof action.id !== 'string') throw new TypeError('action is required');
  if (typeof taskText !== 'string' || !taskText) throw new TypeError('taskText is required');
  if (!Array.isArray(pools)) throw new TypeError('pools must be an array');
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  const watch = dependencies.watchOnce ?? watchOnce;
  const runEvidence = dependencies.runStepEvidence ?? runStepEvidence;
  const choosePool = dependencies.pickPool ?? pickPool;
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
  const backoff = dependencies.sleep ?? ((ms) => new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - started >= ms || shouldCancel?.()) {
        clearInterval(tick);
        resolve();
      }
    }, Math.min(250, Math.max(1, ms)));
  }));
  const callerSilenceOverride = silenceTimeoutSec !== null && silenceTimeoutSec !== undefined;
  const envSilenceOverride = Number.isFinite(Number(parentEnv?.BULLSWARM_WORKER_SILENCE_SEC))
    && Number(parentEnv.BULLSWARM_WORKER_SILENCE_SEC) > 0;
  const silenceOverride = callerSilenceOverride || envSilenceOverride;
  const configuredSilenceTimeoutSec = callerSilenceOverride
    ? silenceTimeoutSec
    : workerSilenceTimeoutSec(parentEnv);
  const effort = action.effort ?? DEFAULT_EFFORT_BY_LANE[action.lane] ?? 'medium';
  const failedProbes = new Set();
  // `limitsOnly`: the usage-limit rules without the rest of the failure rule
  // (the planner and scout of a marked run). `limitsRule`: either one, for
  // what the two share (the worker reads a spent window as quota, the end
  // names each pool's reason and when to try again).
  const limitsOnly = usageLimitsToCaller === true && !failureRule;
  const limitsRule = failureRule || limitsOnly;
  const failureKindOf = failureRule ? markedFailureKind : classifyFailure;
  // Credential groups a sign-in failure in THIS dispatch showed dead: no
  // later pick of this dispatch takes a pool in one, however many pool names
  // front it (the 2026-09-11 bug: a retry walked three names for one dead
  // credential). Nothing is stored; the next dispatch starts clean (state.js
  // S1) and learns of a dead credential only by trying it.
  const deadGroups = new Set();
  const inLiveGroup = (pool) => !deadGroups.size || !deadGroups.has(upstreamGroupOf(pool));
  // Stage 3 (marked runs): a pool the router calls "expiring but draining"
  // (its pacing window closes soon and this step would take it past the
  // wall) is never given the step, even when nothing else can take it; the
  // router alone would pick it as a last resort. The step goes to another
  // pool, or to the caller when none can take it, and the picture is read
  // again at every pick. The Workflow Planner and preflight scout of a marked
  // run follow the same rule (`limitsRule`): one rule everywhere. A pool the
  // caller named (the run's pin, or a route that allows only it) is exempt.
  // Unmarked runs keep the router's last-resort pick. Map: pool name ->
  // {until, forecast, elapsed}.
  const namedPool = strictPool ?? (routeFilter?.usePools?.length === 1 ? routeFilter.usePools[0] : null);
  const drainingAt = (poolList, at) => {
    const found = new Map();
    if (!limitsRule || !poolList.length) return found;
    const viewed = attachForecast(poolList.map((pool) => ({ ...pool })), bullswarmDir, { now: at, decisionLog: coreDecisionLog() });
    for (const pool of viewed) {
      if (pool.name === namedPool) continue;
      const view = expiringSoonView(pool, { now: at, candidateMinutes: expected.expectedMinutes, inflightPenaltyPct });
      if (view.state !== 'draining') continue;
      const elapsed = Number(pool.elapsedPct);
      found.set(pool.name, { until: toMs(pool.paceResetsAt), forecast: view.forecast, elapsed: Number.isFinite(elapsed) ? elapsed : null });
    }
    return found;
  };
  // The draining pools the last prepare() kept out, for the pick's reason.
  let keptOffDraining = new Map();
  // The pools that can take work now and, among them, the draining ones,
  // read live; prepare() keeps the draining ones out.
  const preparedView = (poolList) => {
    const at = now();
    const prepared = preparePools(poolList, action, effort, {
      preferredModel, strictPool, now: at, routeFilter,
    }).filter((pool) => !failedProbes.has(pool.name) && inLiveGroup(pool));
    return { prepared, draining: drainingAt(prepared, at) };
  };
  const prepare = (poolList) => {
    const { prepared, draining } = preparedView(poolList);
    keptOffDraining = draining;
    return keptOffDraining.size ? prepared.filter((pool) => !keptOffDraining.has(pool.name)) : prepared;
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
  // The unfiltered list, kept current across refreshes.
  let allPools = pools;
  const configuredAssignment = pools.find((pool) => pool.strategyAssignments?.[effort])
    ?.strategyAssignments?.[effort] ?? null;
  const effectivePreferredPool = preferredPool ?? configuredAssignment?.pool ?? null;
  const remaining = [...candidates];
  const attempts = [];
  let correctionUsed = false;
  let retriesUsed = 0;
  let throttleRetries = 0;
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
  // Step baseline (D19): HEAD and path stats once, at the first attempt.
  // `stepChanged` is the union the gate judges. Each attempt still records
  // its own diff.
  const declaredForSnapshot = declaredDeliverable(action);
  const snapshotExtras = uniquePaths([
    ...(declaredForSnapshot?.paths ?? []),
    ...(Array.isArray(extraSnapshotPaths) ? extraSnapshotPaths : []),
  ]);
  const territoryOptions = { directWhenUngit: declaredForSnapshot != null };
  const stepEarlier = {
    produced: earlierWork?.produced === true,
    unknown: earlierWork?.unknown === true,
  };
  let stepHeadBefore = null;
  let baselinePaths = [];
  let stepPathsBefore = new Map();
  const stepChanged = new Set();
  let stepBaselineReady = false;
  // Stage 2 evidence (E14): the checks, the schema hashes at the step
  // baseline (E26), and the one same-pool retry. `pinNext` pins exactly one
  // pick; `pendingRefresh` is the forced refresh that decided the pool was
  // still eligible, reused by that pick; `pinnedRecord` is the attempt the
  // pinned pick retries, corrected in place if the pick finds no pool.
  const evidenceItems = declaredEvidence(action);
  let schemaBaseline = null;
  let evidenceRetryUsed = false;
  let pinNext = null;
  let pendingRefresh = null;
  let pinnedRecord = null;
  let pinnedResults = null;
  // Paths the checks left changed in a private copy that could not be put
  // back (E11): the ownership gate reads them as check by-products, not as
  // the worker's edits.
  const checkByProducts = new Set();
  // Stage 3 (§2.1), marked runs only. The budget is the step's, not this
  // call's: it starts from the counted retries already stored and is spent
  // when a counted retry STARTS. `pendingRetry` ({attempt, pool, how}) is the
  // retry decided after a failure; the next attempt's record carries it as
  // `retryOf`, and the failed attempt never does. `leftAfterProcessFailure`
  // are pools the step left after a process-class failure (a crash, a stall,
  // a provider error, a sign-in failure and that credential's siblings): a
  // retry never goes back to them. `gatePin` is a gate retry's pool until an
  // attempt starts: the pick is forced onto it whenever it can take work (D5,
  // decided at the pick that starts the retry); `gateBlocked` is set when the
  // router refused it. A step never waits for a pool: a usage limit, or no
  // capable pool free now, sends it to the caller (owner decision,
  // 2026-09-25); only a transient rate limit backs off, on the same pool and
  // only while that pool can take the step. `backoffBlocked` names the pool
  // whose backoff could not be taken or replayed (under the usage-limit rules
  // alone, also the pool a correction or same-pool retry could not replay);
  // `namedReturn` is when a provider said to try again after a wait too long
  // to sit out. Both are read by the usage-limit rules alone too
  // (`limitsOnly`), where `limitsBackoff` marks the next pick as a backoff's
  // replay of its pool, and `limitsReplayFor` ({how, record}) as a schema
  // correction's (`correction`) or the one bounded same-pool retry's
  // (`same-pool`) replay of the pool the attempt `record` failed on.
  const retryBudget = Math.max(0, (Number(maxMechanicalRetries) || 0) - (Number(retriesAlready) || 0));
  let retriesStarted = 0;
  let pendingRetry = null;
  let promisedRecord = null;
  const leftAfterProcessFailure = new Set();
  let gatePin = null;
  let gateBlocked = false;
  let backoffBlocked = null;
  let namedReturn = null;
  let limitsBackoff = false;
  let limitsReplayFor = null;
  let leaveFirst = failureRule && Array.isArray(leavePools) && leavePools.length
    ? new Map(leavePools.map((entry) => [entry.pool, entry.failureKind ?? null]))
    : null;
  const correctPinnedRetry = (poolName) => {
    const why = evidenceFailureWhy(pinnedResults, { suffix: ` · no retry: ${poolName} is no longer eligible` })
      ?? `${pinnedRecord.why ?? 'failed evidence'} · no retry: ${poolName} is no longer eligible`;
    Object.assign(pinnedRecord, { status: 'failed', willRetry: false, why });
    onAttempt?.('corrected', clone(pinnedRecord));
    return {
      ok: false, status: 'failed', failureKind: 'failed-evidence', attempts,
      verdict: { ...(last ?? {}), ok: false, failureKind: 'failed-evidence', why },
    };
  };

  while (failureRule || remaining.length || (last && retriesUsed < maxMechanicalRetries) || pinNext) {
    if (shouldCancel?.()) return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts, verdict: last };
    const replay = replayPool;
    replayPool = null;
    // Stage 3: this pick replays a transient rate limit's backoff (a marked
    // step, or the planner or scout of a marked run).
    const backoffReplay = failureRule && replay != null && pendingRetry?.how === 'wait';
    const limitsReplay = limitsOnly && replay != null && limitsBackoff;
    limitsBackoff = false;
    const replayFor = replay != null ? limitsReplayFor : null;
    limitsReplayFor = null;
    const pin = pinNext;
    pinNext = null;
    // Meters move while an action is in flight. Re-read them
    // before every pick so a pool that just hit its limit — here or in another
    // run — is no longer a candidate. A forced refresh already taken to decide
    // an evidence retry is this pick's refresh (E14).
    if (typeof refreshPools === 'function' || pendingRefresh) {
      let refreshed = null;
      if (pendingRefresh) refreshed = pendingRefresh;
      else {
        try { refreshed = await refreshPools({ force: forceRefresh }); }
        catch { refreshed = null; }
      }
      pendingRefresh = null;
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
    // Stage 3: the pick's pool list, rebuilt from the live picture every time
    // (prepare() re-reads the meters). A gate retry is forced onto its
    // pool whenever that pool can take work at this pick, and otherwise this
    // pick falls back to the untried eligible pools; the pin stays until an
    // attempt starts. A backoff replays its own pool only: when that pool can
    // no longer take the step (a window at its limit, or draining)
    // the step goes to the caller, never to another pool.
    let gatePick = null;
    let markedPools = null;
    if (failureRule) {
      candidates = prepare(allPools);
      remaining.length = 0;
      const replayed = replay ? candidates.find((candidate) => candidate.name === replay.name) : null;
      if (backoffReplay && !replayed) {
        backoffBlocked = replay.name;
        break;
      }
      if (replayed) remaining.push(replayed);
      for (const candidate of backoffReplay ? [] : candidates) {
        if (candidate.name !== replayed?.name && !tried.has(candidate.name)) remaining.push(candidate);
      }
      const pinned = gatePin && !gateBlocked
        ? candidates.find((candidate) => candidate.name === gatePin)
        : null;
      gatePick = pinned ? pinned.name : null;
      // A rerun after a failure the pool caused starts elsewhere when it can;
      // the same pool is used only when nothing else can take the step now.
      const left = leaveFirst && !pinned && remaining.some((candidate) => !leaveFirst.has(candidate.name))
        ? remaining.filter((candidate) => leaveFirst.has(candidate.name)).map((candidate) => candidate.name)
        : [];
      if (left.length) {
        for (let i = remaining.length - 1; i >= 0; i -= 1) if (leaveFirst.has(remaining[i].name)) remaining.splice(i, 1);
        const note = `moved off ${left.map((name) => `${name} (${leaveFirst.get(name) ?? 'pool'})`).join(', ')}: `
          + `${left.length === 1 ? 'an earlier attempt' : 'earlier attempts'} failed there on the pool`;
        if (!fallbackWhy?.includes(note)) fallbackWhy = fallbackWhy ? `${note} · ${fallbackWhy}` : note;
      }
      markedPools = pinned ? [pinned] : remaining;
      // Nothing can take the step now: it goes to the caller with each capable
      // pool's reason and return time (the failure below), never a wait.
      if (!markedPools.length) break;
    }
    // The usage-limit rules alone: a backoff replays its own pool, read live,
    // and goes to the caller when that pool can no longer take the work.
    let backoffPools = null;
    if (limitsReplay) {
      const replayed = prepare(allPools).find((candidate) => candidate.name === replay.name);
      if (!replayed) {
        backoffBlocked = replay.name;
        break;
      }
      backoffPools = [replayed];
    }
    // The usage-limit rules alone: a schema correction, or the one bounded
    // same-pool retry, replays its pool only while that pool is not nearly
    // spent (draining) at this pick, read live as every first pick reads it.
    // A nearly spent pool is not fed: the correction moves, with its
    // correction task, to another free pool that is not nearly spent (a
    // correction is not a move after a limit); the same-pool retry has no
    // other pool. With none, the dispatch goes to the caller as quota, with
    // that pool's reason and reset (the failure below).
    let movedPools = null;
    if (replayFor) {
      const view = preparedView(allPools);
      if (view.draining.has(replay.name)) {
        keptOffDraining = view.draining;
        candidates = view.prepared.filter((candidate) => !view.draining.has(candidate.name));
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (remaining[index].name === replay.name) remaining.splice(index, 1);
        }
        movedPools = replayFor.how === 'correction'
          ? candidates.filter((candidate) => candidate.name !== replay.name && !tried.has(candidate.name))
          : [];
        // The attempt promised this retry: corrected at the end unless an
        // attempt starts.
        promisedRecord = replayFor.record;
        if (!movedPools.length) {
          backoffBlocked = replay.name;
          break;
        }
        const note = `correction moved: ${replay.name} is nearly spent`;
        fallbackWhy = fallbackWhy ? `${fallbackWhy} · ${note}` : note;
      }
    }
    // An evidence retry is pinned to its pool for this one pick: the router
    // ranks every pool it is given, so re-queuing alone would move it. The
    // fallback list may predate a sign-in failure in this dispatch (no
    // refresh since), so its dead credential groups are dropped here too.
    const routePools = markedPools ?? backoffPools ?? movedPools ?? (pin
      ? prepare(allPools).filter((candidate) => candidate.name === pin)
      : remaining.length ? remaining : candidates.filter(inLiveGroup));
    const onlyPool = pin ?? gatePick;
    const pickStrictPool = onlyPool ?? strictPool;
    const pickAt = now();
    const routingPools = routePools
      .filter((candidate) => !failedProbes.has(candidate.name) && (!onlyPool || candidate.name === onlyPool));
    // The ledger is re-read HERE, before every pick and every retry, not on
    // the refresher's 15s throttle: up to four kernel actions start within
    // milliseconds of each other, and each has to see the assignments the
    // others just registered. Cheap by construction — a directory read, no
    // meter poll and no network.
    attachForecast(routingPools, bullswarmDir, { now: pickAt, decisionLog: coreDecisionLog() });
    const route = choosePool(action.lane ?? 'chore', routingPools, {
      callerEligible: false,
      callerSession: false,
      preferredPool: effectivePreferredPool,
      // `routingPools` is already filtered to the pin; the router needs the
      // name so routeWhy says the pick was pinned, not compared.
      strictPool: pickStrictPool,
      effortTier: effort,
      now: pickAt,
      candidateMinutes: expected.expectedMinutes,
      inflightPenaltyPct,
      evidence,
      pinSource: gatePick ? GATE_RETRY_PIN_SOURCE : pinSource,
      routeNote: routeFilter?.summary || null,
    });
    if (route.pick && keptOffDraining.size) {
      // The router never saw the pools kept off above; say so in its words.
      const kept = [...keptOffDraining].map(([name, view]) => `${name} ${Number(view.forecast).toFixed(1)}%${
        view.elapsed != null ? ` (${view.elapsed.toFixed(1)}% elapsed)` : ''}`).join(', ');
      route.why = `${route.why} · expiring but draining (forecast >= ${PACING_FORECAST_BLOCK_PCT}% and past its clock), kept off: ${kept}`;
    }
    // The pool was eligible on the forced refresh, but the pinned pick still
    // found none (a race inside the pick): the stored attempt promised a retry
    // that does not happen, so it is corrected, and no other pool is tried.
    if (!route.pick && pin) return correctPinnedRetry(pin);
    // Stage 3: the router refused the gate retry's pool (off its lane, or its
    // live meter is at its limit): the retry falls back to the other untried
    // pools at the next pick.
    if (!route.pick && gatePick) {
      gateBlocked = true;
      continue;
    }
    if (!route.pick) {
      // The router refused a backoff's own pool, or every pool a correction
      // moved to off its nearly spent pool (off the lane, or a live window at
      // its limit): the caller, as above.
      if (backoffReplay || limitsReplay || movedPools) backoffBlocked = replay.name;
      break;
    }
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
        // A pinned evidence retry never moves to another pool, and neither
        // does a backoff: its step goes to the caller.
        if (pin) return correctPinnedRetry(pin);
        if (backoffReplay || limitsReplay) {
          backoffBlocked = pool.name;
          break;
        }
        // A gate retry's pool that fails its probe cannot take work: this
        // step never picks it again, so the retry moves.
        fallbackWhy = fallbackWhy
          ? `${fallbackWhy} · ${reason} on ${pool.name}`
          : `${reason} on ${pool.name}`;
        last = { ok: false, why: reason, failureKind: 'provider', meta: { exitCode: null } };
        continue;
      }
    }
    const ordinal = attempts.length + 1;
    const files = withAttemptArtifacts(attemptPaths(paths, ordinal));
    const territory = territoryFiles(targetDir, action.ownedFiles, execFile, snapshotExtras, territoryOptions);
    const beforeAttempt = hashTerritory(targetDir, territory);
    // A workspace git cannot see (D21) has no HEAD of its own; a commit in
    // the repository that ignores it is not this step's work.
    const seesHead = territory.git !== false;
    const headAtStart = seesHead ? headCommit(targetDir, execFile) : null;
    let headAfter = headAtStart;
    if (!stepBaselineReady) {
      stepHeadBefore = headAtStart;
      baselinePaths = gateBaselinePaths(action, territory.git === true);
      stepPathsBefore = statDeliverablePaths(targetDir, baselinePaths);
      // E26: a schema file that changes after this point is recorded as a fact.
      schemaBaseline = evidenceItems.length ? evidenceSchemaBaseline(evidenceItems, targetDir) : null;
      stepBaselineReady = true;
    }
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
    // A gate retry that starts on another pool says so (D5): the move is a
    // fact of the pick that starts it, not of an earlier look.
    const gateMoved = failureRule && gatePin && pool.name !== gatePin
      ? `gate retry moved: ${gatePin} cannot take work now`
      : null;
    const routeWhy = [gateMoved, fallbackWhy, route.why].filter(Boolean).join(' · ');
    fallbackWhy = null;
    // The box paragraph closes this attempt's task, after any handoff or
    // correction block, and never enters `nextTask`: the next attempt gets a
    // paragraph with its own clock instead of two. A guide only — nothing
    // below reads it to stop, time out or reroute the attempt.
    const box = typeof timeBox === 'function' ? timeBox({ pool: pool.name, startedAt }) : null;
    const attemptTask = box?.text ? `${nextTask}\n\n${box.text}` : nextTask;
    // D3: the retry becomes a fact only when its attempt starts. A counted
    // retry is `same-pool` when it landed where the failure happened (a
    // planned same-pool retry that fell back reads `other-pool`).
    const retryOf = failureRule && pendingRetry
      ? {
        attempt: pendingRetry.attempt,
        how: pendingRetry.how === 'wait' ? 'wait' : pool.name === pendingRetry.pool ? 'same-pool' : 'other-pool',
      }
      : null;
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
      ...(retryOf ? { retryOf } : {}),
      ...(box?.record ? { timeBox: clone(box.record) } : {}),
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
    if (retryOf && retryOf.how !== 'wait') retriesStarted += 1;
    pendingRetry = null;
    promisedRecord = null;
    gatePin = null;
    leaveFirst = null;
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
    let deliverableFact = null;
    try {
      verdict = await watch(runtimeConnector, attemptTask, targetDir, files, {
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
        // A spent usage window is `quota`, even with no reset named.
        ...(limitsRule ? { usageLimitsToCaller: true } : {}),
        runId: runId ?? runIdFromPaths(files),
        attemptId: `${action.id}-${ordinal}`,
        startedAt,
        subscription: pool.subscription ?? connector.subscription ?? null,
        attempts: (Array.isArray(ledgerAttempts) ? ledgerAttempts : [])
          .filter((attempt) => attempt?.id !== `${action.id}-${ordinal}`
            && (!attempt?.pool || attempt.pool === pool.name)),
        onCapture: (capture, usage) => {
          record.capture = clone(capture);
          onAttempt?.('captured', clone({ ...record, ...(usage ? { usage } : {}) }));
        },
      });
      // Capture before releasing the in-flight ledger entry or invoking the
      // worker-exit callback. Either can let a sibling begin editing this
      // territory, which must not be attributed to the attempt that ended.
      snapshot = captureDiffSnapshot(targetDir, action.ownedFiles, beforeAttempt, execFile, snapshotExtras, territoryOptions);
      headAfter = seesHead ? headCommit(targetDir, execFile) : null;
    } finally {
      if (ledgerEntry) withLedger(() => releaseAssignment(bullswarmDir, ledgerEntry.id));
      if (workerPid) onWorkerExit?.(workerPid);
    }
    // The worker's end (E17): spend, time boxes and phase minutes read the
    // attempt window, and the checks below must not inflate it.
    const workerFinishedAt = new Date(now()).toISOString();
    if (snapshot.ok) {
      for (const file of snapshot.changedFiles) stepChanged.add(file);
    }
    // The saved file is the attribution record; later sibling edits are not
    // replayed into it. Written before the gate and the checks (E4), so a
    // kernel that dies mid-check still leaves it for the durable handoff.
    if (snapshot.ok) writeFileIfChanged(files.diffFile, snapshot.statText ? `${snapshot.statText}\n` : '');
    const outputBytes = fileBytes(files.outFile);
    const pathsAfter = statDeliverablePaths(targetDir, baselinePaths);
    // E30: on a step that declares evidence, a verdict whose only failure is
    // the text heuristic does not skip the checks; the facts decide.
    const textVerdictWhy = evidenceItems.length && failureKindOf(verdict, pool) === 'semantic'
      ? String(verdict?.why ?? 'no reason recorded')
      : null;
    const gateVerdict = textVerdictWhy != null ? { ...verdict, ok: true } : verdict;
    const judged = deliverableVerdict({
      action,
      verdict: gateVerdict,
      legacyGate,
      snapshotOk: snapshot.ok,
      changed: [...stepChanged].sort(),
      headBefore: stepHeadBefore,
      headAfter,
      pathsBefore: stepPathsBefore,
      pathsAfter,
      outputBytes,
      earlierWork: stepEarlier,
    });
    if (gateVerdict?.ok && judged.failWhy) {
      verdict = { ...verdict, ok: false, why: judged.failWhy, failureKind: 'not-produced' };
    }
    deliverableFact = judged.fact;
    // Evidence (E4, E15): only when the verdict is still (provisionally) ok.
    // A stop that arrived as the worker finished records every item as
    // stopped instead of letting the step succeed with its checks unrun.
    let evidenceRun = null;
    if (evidenceItems.length && gateVerdict?.ok && !judged.failWhy) {
      const realTarget = (() => { try { return realpathSync(targetDir); } catch { return targetDir; } })();
      const owned = Array.isArray(action.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
      const lane = action.lane ?? 'chore';
      const mode = privateWorkspace
        ? 'private'
        : owned.length
          ? 'restricted'
          : (lane === 'build' || lane === 'chore') && trackedFiles(realTarget, execFile) != null
            ? 'unrestricted'
            : 'other';
      const taskDir = dirname(files.taskFile);
      evidenceRun = await runEvidence(evidenceItems, {
        cwd: realTarget,
        env: evidenceEnv(parentEnv, { cwd: realTarget, stepId: action.id, outFile: files.outFile, runDir: taskDir }),
        outFile: files.outFile,
        logFileFor: (k) => evidenceLogFile(files.taskFile, action.id, ordinal, k),
        scope: evidenceScope({
          mode,
          cwd: realTarget,
          ownedFiles: owned,
          declaredPaths: declaredDeliverable(action)?.paths ?? [],
          extraPaths: uniquePaths(Array.isArray(extraSnapshotPaths) ? extraSnapshotPaths : []),
          outFile: files.outFile,
          execFile,
        }),
        schemaBaseline,
        // The kernel's own registry, not the ledger wrapper: a kernel stop
        // must reach a running check's process group.
        onSpawn,
        onWorkerExit,
        shouldCancel: () => Boolean(shouldCancel?.()),
        onEvidence: onEvidence ? (event) => onEvidence({ actionId: action.id, ...event }) : null,
        now,
      });
      // What the checks created outside a private copy's scope never reaches
      // the ownership gate or the merge-back, and a pre-existing untracked
      // file they rewrote or deleted is put back (E11). The step is alone in
      // its copy, so neither can undo a sibling's work.
      let leftover = [];
      if (mode === 'private') {
        const removal = evidenceRun.createdOutOfScope?.length
          ? removeCreatedOutOfScope(realTarget, evidenceRun.createdOutOfScope)
          : null;
        const restoral = evidenceRun.changedOutOfScope?.length
          ? restoreChangedOutOfScope(realTarget, evidenceRun)
          : null;
        leftover = uniquePaths([...(removal?.unremoved ?? []), ...(restoral?.unrestored ?? [])]).sort();
        for (const path of leftover) checkByProducts.add(path);
      }
      const results = clone(evidenceRun.results ?? []);
      const note = textVerdictWhy != null
        ? {
          at: new Date(now()).toISOString(),
          kind: 'text-verdict',
          text: evidenceRun.failed
            ? `the output read as failed (${textVerdictWhy}); the evidence ran anyway, and an item failed`
            : `the output read as failed (${textVerdictWhy}); every evidence item passed`,
        }
        : null;
      if (evidenceRun.stopped) {
        verdict = { ...verdict, ok: false, cancelled: true, why: 'evidence stopped', evidenceResults: results };
      } else if (evidenceRun.failed) {
        verdict = {
          ...verdict, ok: false, failureKind: 'failed-evidence',
          why: evidenceRun.why ?? evidenceFailureWhy(results), evidenceResults: results,
        };
      } else {
        // A text-only failure the checks overruled keeps its reason in the
        // note, not as the why of a succeeded attempt.
        verdict = {
          ...verdict, ok: true, evidenceResults: results,
          ...(textVerdictWhy != null ? { why: 'every evidence item passed' } : {}),
        };
      }
      // The note says the facts outranked the text; it stays on a failure too.
      if (note && !evidenceRun.stopped) {
        verdict.notes = [...(Array.isArray(verdict.notes) ? verdict.notes : []), note];
      }
      if (leftover.length) {
        verdict.notes = [...(Array.isArray(verdict.notes) ? verdict.notes : []), {
          at: new Date(now()).toISOString(),
          kind: 'check-by-product',
          text: `check by-product not restored: ${leftover.join(', ')}`,
        }];
      }
    }
    const evidenceResults = evidenceRun ? verdict.evidenceResults : null;
    const streamFile = verdict?.meta?.streamFile
      ?? (files.streamFile && existsSync(files.streamFile) ? files.streamFile : null)
      ?? (files.stdoutFile && existsSync(files.stdoutFile) ? files.stdoutFile : null);
    const lastEvents = lastResponseEvents(streamFile);
    const finishedAt = workerFinishedAt;
    const kind = failureKindOf(verdict, pool);
    // The one evidence retry (E14), decided before the record is built so the
    // stored attempt never promises a retry that does not happen. (e) first:
    // an act step or a check that could not run goes to the caller at once.
    let canRetryEvidence = false;
    // Stage 3 (D5): in marked runs §2.1 below replaces E14; an act step's
    // failed checks still say why they go to the caller.
    if (failureRule && kind === 'failed-evidence' && roleOf(action) === 'act' && !evidenceRun?.checkFault) {
      const suffix = ' · act steps are not retried';
      verdict = { ...verdict, why: evidenceFailureWhy(evidenceResults, { suffix }) ?? `${verdict.why ?? 'failed evidence'}${suffix}` };
    }
    if (!failureRule && kind === 'failed-evidence') {
      let suffix = '';
      if (roleOf(action) === 'act') suffix = ' · act steps are not retried';
      else if (!evidenceRun?.checkFault && evidenceRetryAvailable && maxMechanicalRetries > 0 && !evidenceRetryUsed) {
        // (d): a forced refresh, reused by the pinned pick (an empty or failed
        // refresh keeps the current list, and the pick does not refresh again).
        if (typeof refreshPools === 'function') {
          let refreshed = null;
          try { refreshed = await refreshPools({ force: true }); }
          catch { refreshed = null; }
          pendingRefresh = Array.isArray(refreshed) ? refreshed : [];
        }
        // The pinned pick's own filter: prepare() drops a pool whose live
        // meter is at its limit (windowSpent), the usual way a pool stops
        // being eligible after a finished worker, and pickPool one off its lane.
        const lane = action.lane ?? 'chore';
        const eligibleNow = prepare(pendingRefresh?.length ? pendingRefresh : allPools)
          .filter((candidate) => (candidate.lanes ?? LANES).includes(lane));
        if (eligibleNow.some((candidate) => candidate.name === pool.name)) canRetryEvidence = true;
        else {
          pendingRefresh = null;
          suffix = ` · no retry: ${pool.name} is no longer eligible`;
        }
      }
      if (suffix) {
        verdict = { ...verdict, why: evidenceFailureWhy(evidenceResults, { suffix }) ?? `${verdict.why ?? 'failed evidence'}${suffix}` };
      }
    }
    // One dead upstream credential is ONE outage however many pool names front
    // it: the next attempt of THIS action must not walk from one pool name to
    // the next sibling on the same credential into the same failure, as it
    // did on 2026-09-11. The group is dropped from the untried list now, and
    // prepare() keeps it out of every later pick of this dispatch, a refresh
    // included (`deadGroups`).
    const deadGroup = kind === 'auth' ? upstreamGroupOf(pool) : null;
    if (deadGroup) {
      deadGroups.add(deadGroup);
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (upstreamGroupOf(remaining[i]) === deadGroup) remaining.splice(i, 1);
      }
    }
    // The pools that can take work now, read live once for what follows this
    // failure under the usage-limit rules.
    let liveNow = null;
    const pickableLive = () => (liveNow ??= prepare(allPools));
    // The usage-limit rules (`limitsRule`: a marked step, or the planner or
    // scout of a marked run), one decision for a rate limit. A wait the
    // provider named that is too long to sit out is never slept: the caller is
    // told when to try again. A transient one backs off on the same pool, never
    // counted, only while that pool can still take the work; otherwise the
    // caller, with that pool's reason. A usage limit is never retried, moved or
    // waited out: the caller decides (owner decision, 2026-09-25). A marked act
    // step whose worker started is not backed off either (D32).
    let limitsBackoffNow = false;
    if (limitsRule && !verdict.ok && kind !== 'cancelled') {
      namedReturn = longThrottleReturn(kind, verdict, toMs(workerFinishedAt) ?? now());
      backoffBlocked = null;
      const actStarted = failureRule && roleOf(action) === 'act' && !workerNeverStarted(verdict);
      if (kind === 'throttle' && namedReturn == null && throttleRetries < MAX_THROTTLE_RETRIES && !actStarted) {
        if (!leftAfterProcessFailure.has(pool.name) && pickableLive().some((candidate) => candidate.name === pool.name)) {
          limitsBackoffNow = true;
        } else {
          backoffBlocked = pool.name;
        }
      }
    }
    // Stage 3 §2.1 (marked runs): what follows this failure, decided before
    // the record is built so the stored attempt never promises a retry that
    // does not happen. Null sends the step to the caller (D10).
    let next = null;
    // F23: a transient rate limit's short backoff on the same pool records
    // `quotaNext: 'wait'` on the attempt. A usage limit records none: it goes
    // to the caller.
    let quotaNext = null;
    if (failureRule && !verdict.ok && kind !== 'cancelled') {
      const failureClass = failureClassOf(kind);
      const hasBudget = retriesStarted < retryBudget;
      if (deadGroup) {
        for (const candidate of allPools) {
          if (candidate.name !== pool.name && upstreamGroupOf(candidate) === deadGroup) {
            leftAfterProcessFailure.add(candidate.name);
            tried.add(candidate.name);
          }
        }
      }
      // The pools the next pick could take now (§2.1): the live untried
      // candidates, plus the pool that just failed unless the step left it
      // after a process failure. `others`, the sole-candidate rule and the
      // backoff read the same set (D2, D4).
      const pickableNow = pickableLive().filter((candidate) => (candidate.name === pool.name
        ? !leftAfterProcessFailure.has(candidate.name)
        : !tried.has(candidate.name)));
      const others = pickableNow.filter((candidate) => candidate.name !== pool.name);
      const soleCandidate = pickableNow.length === 1 && pickableNow[0].name === pool.name;
      if (roleOf(action) === 'act' && !workerNeverStarted(verdict)) {
        // D32: once its worker started, an act step may have acted.
        next = null;
      } else if (kind === 'failed-evidence' && evidenceRun?.checkFault) {
        // E19: the worker cannot fix a check that could not run.
        next = null;
      } else if (failureClass === 'process') {
        if (hasBudget && others.length) next = { how: 'other-pool' };
        else if (hasBudget && soleCandidate && kind !== 'auth') next = { how: 'same-pool', replay: true };
      } else if (failureClass === 'gate') {
        if (hasBudget && kind === 'schema') {
          if (typeof correctionTask === 'function') next = { how: 'same-pool', correction: true };
        } else if (hasBudget) {
          next = { how: 'same-pool', gate: true, fresh: kind === 'not-produced' };
        }
      } else if (limitsBackoffNow) {
        // The transient rate limit's backoff decided above.
        next = { how: 'wait', sameBackoff: true };
        quotaNext = 'wait';
      }
    }
    // The usage-limit rules alone (the planner and scout of a marked run): a
    // usage limit, and a rate limit that is not backed off, end the dispatch
    // below with no retry and no move.
    const limitKind = limitsOnly && (kind === 'quota' || kind === 'throttle');
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
    const canRetryMechanically = !limitKind
      && MECHANICAL_KINDS.has(kind)
      && kind !== 'schema'
      && (freeBudgetExempt
        ? hasUntriedPool
        : hasRetryBudget && (hasUntriedPool || canRetrySamePool));
    // A throttle that named a wait longer than THROTTLE_MAX_WAIT_MS is not
    // sat out on the same pool: the attempt falls over instead (quota.js Q6).
    // The usage-limit rules alone back off as decided above, and never fall
    // over.
    const canRetryThrottle = limitsOnly
      ? limitsBackoffNow
      : kind === 'throttle'
        && verdict?.throttleRetrySamePool !== false
        && throttleRetries < MAX_THROTTLE_RETRIES;
    const willRecover = failureRule
      ? next != null
      : canCorrectSchema || canRetryThrottle || canRetryMechanically || canRetryEvidence;
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
      ...(quotaNext ? { quotaNext } : {}),
      outputFile: files.outFile,
      ...(outputBytes != null ? { outputBytes } : {}),
      ...(deliverableFact ? { deliverable: deliverableFact } : {}),
      // Only when the checks ran (E15): absence is the exact fact.
      ...(evidenceResults ? { evidenceResults: clone(evidenceResults) } : {}),
      ...(streamFile ? { streamFile } : {}),
      // The path list itself (at most 200; the count stays complete): the
      // repair loop's carry-forward rule and the durable handoff read it.
      ...(snapshot.ok ? { diffFile: files.diffFile, changedFileCount: snapshot.changedFiles.length, changedFiles: snapshot.changedFiles.slice(0, 200) } : {}),
      lastResponse: lastEvents.at(-1)?.summary ?? null,
      ...(verdict.outputTruncated === true ? {
        outputTruncated: true,
        ...(verdict.outputSource ? { outputSource: verdict.outputSource } : {}),
      } : {}),
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
    // A failed check follows a finished worker turn too: its retry continues
    // that conversation with the check output attached.
    const sessionEstablished = verdict.ok || kind === 'schema' || kind === 'semantic' || kind === 'failed-evidence';
    if (session && sessionEstablished) {
      record.session.lastUsedAt = finishedAt;
      currentSession = clone(record.session);
    }
    last = verdict;
    appendDecision(bullswarmDir, {
      ts: finishedAt, lane: action.lane ?? 'chore', picked: pool.name,
      keepOnClaude: false, ok: verdict.ok, failureKind: verdict.ok ? null : kind, why: verdict.why ?? null,
      wallSec: verdict.meta?.wallSec ?? null, model: record.model,
      reasoning: clone(reasoning),
      usage: verdict.meta?.usage ?? null, routing: record.routing,
      forecast: record.routing.forecast,
      outFile: files.outFile, source: 'workflow-v2', actionId: action.id,
    }, { updateCoreState });
    onAttempt?.('finished', clone(record), verdict);
    // A quota failure invalidates this run's meter picture: poll live before
    // choosing where the work goes next.
    if (kind === 'quota') forceRefresh = true;
    if (verdict.ok) {
      return {
        ok: true, status: 'succeeded', attempts, verdict, session: currentSession,
        ...(checkByProducts.size ? { checkByProducts: [...checkByProducts].sort() } : {}),
      };
    }
    if (kind === 'cancelled') return { ok: false, status: 'cancelled', failureKind: kind, attempts, verdict };
    if (failureRule) {
      // D10: a failure that will not be retried goes to the caller; the
      // dispatcher never walks on to another pool by itself.
      if (!next) break;
      pendingRetry = { attempt: `${action.id}-${ordinal}`, pool: pool.name, how: next.how };
      promisedRecord = record;
      const index = remaining.findIndex((candidate) => candidate.name === pool.name);
      if (index >= 0) remaining.splice(index, 1);
      if (failureClassOf(kind) === 'process' && !next.replay) leftAfterProcessFailure.add(pool.name);
      if (next.correction) {
        // `schema`: today's same-conversation correction, now the step's one
        // retry, forced onto the same pool.
        nextTask = correctionTask(verdict, { originalTask: baseTaskText, attempt: ordinal });
        gatePin = pool.name;
        forceRefresh = true;
        continue;
      }
      const block = formatHandoff({
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
        ...(evidenceResults ? { evidenceResults: clone(evidenceResults) } : {}),
        // §2.3: the gate retry's extra line.
        ...(next.gate ? { gate: true } : {}),
      });
      nextTask = `${baseTaskText}\n\n${block}`;
      priorHandoff = {
        from: `${action.id}-${ordinal}`,
        bytes: Buffer.byteLength(block, 'utf8'),
      };
      if (next.gate) {
        // D5: the same pool, forced, after a live look at whether it can
        // still take work. `not-produced` starts a fresh session (D7).
        gatePin = pool.name;
        forceRefresh = true;
        if (next.fresh) currentSession = null;
      } else if (next.replay) {
        replayPool = pool;
      } else if (next.sameBackoff) {
        throttleRetries += 1;
        replayPool = pool;
        await backoff(throttleBackoffMs(throttleRetries, { waitMs: verdict.throttleWaitMs }));
      } else if (kind === 'stalled') {
        fallbackWhy = `fallback from ${pool.name} after stall ${Math.round(attemptSilenceSec)}s`;
      }
      continue;
    }
    if (canRetryEvidence) {
      // One retry on the same pool with the check output attached (E14). It
      // does not spend the mechanical allowance.
      evidenceRetryUsed = true;
      const block = formatHandoff({
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
        partialOutput: null,
        outputBytes,
        streamFile,
        hasEventStream: connector.eventStream != null,
        lastEvents,
        evidenceResults: clone(evidenceResults),
      });
      nextTask = `${baseTaskText}\n\n${block}`;
      priorHandoff = {
        from: `${action.id}-${ordinal}`,
        bytes: Buffer.byteLength(block, 'utf8'),
      };
      pinNext = pool.name;
      pinnedRecord = record;
      pinnedResults = clone(evidenceResults);
      fallbackWhy = 'retry on the same pool after failed evidence';
      continue;
    }
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
      // The usage-limit rules: the next pick replays this pool only while it
      // is not nearly spent (above).
      if (limitsRule) limitsReplayFor = { how: 'correction', record };
      continue;
    }
    if (canRetryMechanically || canRetryThrottle) {
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
    if (canRetryThrottle) {
      throttleRetries += 1;
      remaining.unshift(pool);
      replayPool = pool;
      if (limitsOnly) {
        // The next pick replays this pool only; the record's promised retry
        // is corrected at the end when that pool can no longer take it.
        limitsBackoff = true;
        promisedRecord = record;
      }
      await backoff(throttleBackoffMs(throttleRetries, { waitMs: verdict.throttleWaitMs }));
      continue;
    }
    // The usage-limit rules alone: a usage limit, or a rate limit that is not
    // backed off, goes to the caller (the failure below).
    if (limitKind) break;
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
      // The usage-limit rules: never on this pool once it is nearly spent.
      if (limitsRule) limitsReplayFor = { how: 'same-pool', record };
    }
  }

  // The step fails now rather than waiting for a pool: a run never sits open
  // on quota. Marked runs name each capable pool's reason (a usage limit, a
  // window at its limit, nearly spent, a process failure here) and when it is
  // back, take a spent usage window as quota, and say why a promised retry or
  // a backoff did not happen; so do the planner and scout of a marked run
  // (`limitsRule`).
  const lane = action.lane ?? 'chore';
  // In marked runs a pool with a window at its limit is still capable: it
  // comes back at that window's reset, so the reason is the limit, never a
  // missing tier (§2.1). A pool off the step's lane is not capable there.
  const onLane = (pool) => !limitsRule || (pool.lanes ?? LANES).includes(lane);
  const capable = preparePools(allPools, action, effort, {
    preferredModel, strictPool, now: now(), routeFilter,
    ...(limitsRule ? { ignoreBurstGate: true } : {}),
  }).filter((pool) => !failedProbes.has(pool.name) && onLane(pool));
  const endAt = now();
  const lastKind = last ? failureKindOf(last, lastPool) : null;
  // The failed pool's own reset, when its usage window is spent and the
  // reset is known (quota.js Q6).
  const lastReset = limitsRule && lastKind === 'quota' && lastPool
    ? toMs(last.retryAfter) ?? toMs(last.usageLimit?.until)
    : null;
  const draining = limitsRule ? drainingAt(capable, endAt) : new Map();
  // Under the usage-limit rules, each capable pool that cannot take the step
  // now, as {pool, text, limit (a usage limit), back (when it is back)}: a
  // spent window (known reset or not), a metered window at its limit and a
  // nearly spent window keep the pool out, even when their return is unknown.
  const held = [];
  for (const pool of limitsRule ? capable : []) {
    const parts = [];
    if (pool.name === lastPool?.name && lastKind === 'quota') {
      if (lastReset == null) parts.push(['out of quota', null, true]);
      else if (lastReset > endAt) parts.push(['out of quota', lastReset, true]);
    }
    const spent = windowSpent(pool, endAt);
    if (spent) parts.push([`at its ${spent.window} limit`, toMs(spent.resetsAt), true]);
    if (draining.has(pool.name)) {
      const view = draining.get(pool.name);
      parts.push([`nearly spent (forecast ${Number(view.forecast).toFixed(1)}%)`, view.until, true]);
    }
    if (!parts.length) {
      // A pool the step left after a process failure cannot take its retry.
      if (failureRule && leftAfterProcessFailure.has(pool.name)) held.push({ pool: pool.name, text: `${pool.name} already failed on this step`, limit: false, back: null });
      continue;
    }
    const timed = parts.filter(([, ms]) => ms != null);
    const [reason, back, limit] = timed.length
      ? timed.reduce((latest, part) => (part[1] > latest[1] ? part : latest))
      : parts[0];
    held.push({ pool: pool.name, text: back != null ? `${pool.name} ${reason} until ${new Date(back).toISOString()}` : `${pool.name} ${reason}`, limit, back });
  }
  // No capable pool can take the step now: the earliest known return among
  // them (a pool whose return is unknown is skipped).
  const known = held.map((entry) => entry.back).filter((ms) => ms != null);
  const comesBack = capable.length && held.length === capable.length && known.length ? Math.min(...known) : null;
  // The pool a backoff could not be taken or replayed on: its usage limit
  // makes the step's failure quota, and its return is when to try again.
  const blocked = limitsRule && backoffBlocked ? held.find((entry) => entry.pool === backoffBlocked) ?? null : null;
  const returnAt = lastReset ?? namedReturn ?? blocked?.back ?? comesBack;
  const retryAfter = returnAt == null ? null : new Date(returnAt).toISOString();
  // No attempt: a usage limit on every capable pool reads as quota.
  const failureKind = last ? (blocked?.limit ? 'quota' : lastKind)
    : limitsRule && held.length && held.length === capable.length && held.every((entry) => entry.limit) ? 'quota'
      : 'unavailable';
  // A promised retry, or a backoff, that no pool could take keeps the
  // attempt's failure and says why nothing ran after it.
  let noRetry = null;
  if (limitsRule && last && (backoffBlocked || promisedRecord?.willRetry)) {
    const texts = held.map((entry) => entry.text);
    if (backoffBlocked && !blocked) texts.unshift(`${backoffBlocked} cannot take work now`);
    noRetry = ` · no retry: ${texts.length ? texts.join('; ') : 'no pool can take it now'}`;
  }
  // Stage 3: an attempt that promised a retry no pool could take is corrected
  // (the step goes to the caller); it adds no usage and settles nothing.
  if (limitsRule && promisedRecord?.willRetry) {
    Object.assign(promisedRecord, {
      status: 'failed', willRetry: false, ...(noRetry ? { why: `${promisedRecord.why ?? promisedRecord.failureKind}${noRetry}` } : {}),
    });
    onAttempt?.('corrected', clone(promisedRecord));
    promisedRecord = null;
  }
  let why = !capable.length
    ? strictPool
      ? `no eligible pool: the pinned pool ${strictPool} cannot run ${lane}/${effort} work (it is disabled or has no model on the ${effort} tier)`
      : `no eligible pool: no enabled pool has a model on the ${effort} tier for ${lane} work`
    : held.length
      ? `${failureKind === 'quota' ? 'no pool with quota to spare' : 'no pool free'}: ${held.map((entry) => entry.text).join('; ')}`
      : 'no eligible pool';
  if (!capable.length && routeFilter) {
    // §2.4: the route, not the tier or the pin, emptied the capable set.
    const unrouted = preparePools(allPools, action, effort, {
      preferredModel, strictPool, now: now(),
      ...(limitsRule ? { ignoreBurstGate: true } : {}),
    }).filter((pool) => !failedProbes.has(pool.name) && onLane(pool));
    if (unrouted.length) {
      const withoutIndependence = { ...routeFilter, independentProviders: [] };
      const sharedProvider = (routeFilter.independentProviders ?? []).length > 0
        && unrouted.some((pool) => poolPassesRoute(pool, withoutIndependence));
      why = routeUnavailableWhy(routeFilter, { lane, effort, sharedProvider });
    }
  }
  return {
    ok: false,
    status: 'failed',
    failureKind,
    // Marked runs carry a return time for any failure: it is set only when
    // trying again then is the real next step. The planner and scout of a
    // marked run carry one for a rate limit too.
    ...(retryAfter && (failureRule || ['quota', 'auth', 'unavailable'].includes(failureKind)
      || (limitsOnly && failureKind === 'throttle')) ? { retryAfter } : {}),
    attempts,
    verdict: last
      ? noRetry ? { ...last, why: `${last.why ?? lastKind}${noRetry}` } : last
      : { ok: false, why, meta: { exitCode: null } },
  };
}

export { classifyFailure as classifyV2DispatchFailure, preparePools as prepareV2DispatchPools, trackedStat as trackedDiffStatForTests };
