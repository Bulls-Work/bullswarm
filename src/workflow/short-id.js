import { withV2Cancellation } from './v2-cancellation.js';
// bullswarm short run IDs — friendly 6-character aliases for `wf-...` runIds.
//
// The full runId (e.g. `wf-mta0f0n-321bb7`) stays the durable handle
// on disk (state.json / report.json). The shortId is a separate
// field that the user can type instead of the full string.
//
// Alphabet: Crockford-style 32 symbols — no `0/1/i/l/o` to avoid
// visual ambiguity. 6 characters gives 32^6 = ~1.07 billion
// possible values, which is more than enough for one user's run
// history.
//
// Generation: random 5 bytes → 10 base32 chars; the first 6 are
// taken. Rejection sampling: if the first 6 happen to all be the
// same char, retry. In practice the chance of collision is small,
// and uniqueness across existing runs is enforced by the resolver,
// not the generator.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// The one predicate every reader uses to tell an authored-graph run from a V2
// one. 0.27.0 removed the authored-graph executor, so a run directory whose
// state.json lacks the V2 schemaVersion — or that has no state.json at all —
// is history: readable, listable, deletable, never driven.
export function isLegacyRunState(state) {
  return state?.schemaVersion !== 'bullswarm.workflow.state.v2';
}

// Whether the run directory at `runDir` holds a legacy run. A state.json that
// exists but will not parse is a torn read, not a legacy run: the writer is
// mid-rename, so the caller keeps its normal path instead of being told the
// run is history.
export function isLegacyRunDir(runDir) {
  const statePath = join(runDir, 'state.json');
  if (!existsSync(statePath)) return true;
  try { return isLegacyRunState(JSON.parse(readFileSync(statePath, 'utf8'))); }
  catch { return false; }
}

// The single sentence every command prints when asked to drive a legacy run.
export function legacyRunLine({ shortId = null, runId = null, runDir = null } = {}) {
  return `legacy authored-graph run ${shortId ?? runId}: its executor was removed in 0.27.0; files remain under ${runDir}`;
}

export function kernelStderrPath(runDir) {
  return join(dirname(dirname(runDir)), 'goals', basename(runDir), 'stderr.log');
}

export function readKernelStderrTail(runDir, lineCount = 20) {
  try {
    const lines = readFileSync(kernelStderrPath(runDir), 'utf8').split(/\r?\n/);
    while (lines.at(-1) === '') lines.pop();
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}

export const SHORT_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
export const SHORT_ID_LEN = 6;
const MAX_ATTEMPTS = 16;

const ALPHABET_INDEX = Object.create(null);
for (let i = 0; i < SHORT_ID_ALPHABET.length; i++) {
  ALPHABET_INDEX[SHORT_ID_ALPHABET[i]] = i;
}

export function isShortId(s) {
  return typeof s === 'string'
    && s.length === SHORT_ID_LEN
    && s.split('').every((c) => c in ALPHABET_INDEX);
}

export function toShortId(buf) {
  // buf: 5 random bytes → first 6 base32 chars.
  // We use the high 5 bits of each of 6 consecutive nibble-ish
  // extractions, packing 5 bytes (40 bits) → 6 × 5 = 30 bits → 6
  // base32 chars (each 5 bits). 30 bits > 6×5=30; use bits 0-4 of
  // each char from the byte stream.
  const out = new Array(SHORT_ID_LEN);
  for (let i = 0; i < SHORT_ID_LEN; i++) {
    const byte = buf[i] ?? 0;
    // Use 5 high bits of each byte in a 6-byte window — we have 5
    // bytes, so we pair each with the next and take 5 bits.
    const next = buf[i + 1] ?? 0;
    const bits = ((byte << 3) | (next >> 5)) & 0x1f;
    out[i] = SHORT_ID_ALPHABET[bits];
  }
  return out.join('');
}

export function generateShortId({ existing = [] } = {}) {
  const seen = new Set(existing);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = toShortId(randomBytes(6));
    if (!seen.has(id)) return id;
  }
  throw new Error('failed to generate a unique short runId after many attempts');
}

// The durable run directory name. Unlike the shortId this is never typed by a
// user; it only has to be unique and sortable-ish.
export function newRunId() {
  return `wf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Resolve a short ID or a full runId to the full runId by scanning
 * `~/.bullswarm/workflows/`. The runs root holds one subdirectory per
 * run, named `wf-...`. We open each `state.json` and check the
 * recorded `shortId` field. The first match wins; collisions (two
 * runs with the same shortId) are a hard error.
 *
 * Returns `{ runId, shortId, runDir }` or `null` if no match.
 */
export function resolveRunId(bullswarmDir, token) {
  if (!token) return null;
  // Full runId: short-circuit (no scan needed), but backfill the
  // shortId from state.json so callers (and the `runs show` UI) get
  // a complete picture.
  if (token.startsWith('wf-') && !isShortId(token)) {
    const dir = join(bullswarmDir, 'workflows', token);
    if (!existsSync(dir)) return null;
    let shortId = null;
    const sf = join(dir, 'state.json');
    if (existsSync(sf)) {
      try { shortId = JSON.parse(readFileSync(sf, 'utf8'))?.shortId ?? null; }
      catch { /* corrupt state.json → leave shortId null */ }
    }
    return { runId: token, shortId, runDir: dir };
  }
  if (!isShortId(token) && !token.startsWith('wf-')) return null;
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return null;
  let match = null;
  for (const name of readdirSync(runsRoot)) {
    const dir = join(runsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const sf = join(dir, 'state.json');
    if (!existsSync(sf)) continue;
    let state;
    try { state = withV2Cancellation(JSON.parse(readFileSync(sf, 'utf8')), dir); }
    catch { continue; }
    if (state.shortId === token || name === token) {
      if (match) {
        throw new Error(`shortId "${token}" matches multiple runs: ${match.runId}, ${name}`);
      }
      match = { runId: name, shortId: state.shortId ?? null, runDir: dir };
    }
  }
  return match;
}

/**
 * Read all runs (one entry per `wf-...` subdir of `~/.bullswarm/workflows/`).
 *
 * A V2 run carries its whole `state.json` plus the `result.json`/`report.json`
 * summary. A legacy run is reduced to the five fields a read-only row needs —
 * status, startedAt, finishedAt, name and goal — and is marked `legacy: true`.
 * Nothing else in its state.json is read, and a missing field is never an
 * error: 0.27.0 only has to list these runs, never interpret them.
 */
export function listRuns(bullswarmDir) {
  const runsRoot = join(bullswarmDir, 'workflows');
  if (!existsSync(runsRoot)) return [];
  const out = [];
  for (const name of readdirSync(runsRoot).sort()) {
    const dir = join(runsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!name.startsWith('wf-')) continue;
    const sf = join(dir, 'state.json');
    let raw = null, torn = false;
    if (existsSync(sf)) {
      try { raw = JSON.parse(readFileSync(sf, 'utf8')); } catch { torn = true; }
    }
    if (!torn && isLegacyRunState(raw)) {
      out.push(legacyRunEntry(name, dir, raw));
      continue;
    }
    const state = withV2Cancellation(raw, dir);
    const resultFile = join(dir, 'result.json');
    const rf = existsSync(resultFile) ? resultFile : join(dir, 'report.json');
    let report = null;
    if (existsSync(rf)) {
      try { report = JSON.parse(readFileSync(rf, 'utf8')); } catch { /* corrupt */ }
    }
    out.push({
      runId: name,
      shortId: state?.shortId ?? null,
      runDir: dir,
      dir,
      legacy: false,
      state,
      report,
      ongoing: isOngoing(dir, state),
    });
  }
  return out;
}

// Only these five fields are read from a legacy state.json, and each one is
// optional: `workflow` was a bare string in early runs and an object later, so
// both shapes resolve to the same `name`.
function legacyRunEntry(runId, dir, raw) {
  const workflow = raw?.workflow;
  const name = typeof workflow === 'string'
    ? (workflow || null)
    : (typeof workflow?.name === 'string' ? workflow.name : null);
  return {
    runId,
    shortId: typeof raw?.shortId === 'string' ? raw.shortId : null,
    runDir: dir,
    dir,
    legacy: true,
    state: {
      status: typeof raw?.status === 'string' ? raw.status : null,
      startedAt: typeof raw?.startedAt === 'string' ? raw.startedAt : null,
      finishedAt: typeof raw?.finishedAt === 'string' ? raw.finishedAt : null,
      name,
      goal: typeof raw?.goal === 'string' ? raw.goal : null,
    },
    report: null,
    // Nothing in 0.27.0 can drive an authored-graph run, so no legacy run is
    // ever ongoing however fresh its state.json looks.
    ongoing: false,
  };
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Statuses that claim a kernel process is doing something right now. `waiting`
// is excluded on purpose: a caller-planner pause is durable and ownerless by
// design, so no process is expected to be alive there.
const V2_NEEDS_RUNNER = new Set(['queued', 'planning', 'running', 'ready-to-finalize']);
const RUNNER_GRACE_MS = 120_000;
// A V2 run started before kernels recorded heartbeats carries no pid; only a
// long silence can tell us it stopped.
const NO_HEARTBEAT_SILENCE_MS = 600_000;

// Whether a V2 run's kernel is still alive. A run whose process died keeps
// saying "running" in state.json forever, so every reader has to ask.
export function v2RunnerLiveness(state, { now = Date.now(), processAlive = isProcessAlive, runDir = null } = {}) {
  // Legacy runs are unchecked: no kernel was ever expected to own them.
  if (isLegacyRunState(state)) return { checked: false, alive: true, reason: null };
  const status = state.lifecycle?.status;
  if (status === 'interrupted') return { checked: true, alive: false, reason: 'kernel interrupted; resume to continue preserved work' };
  if (!V2_NEEDS_RUNNER.has(status)) return { checked: false, alive: true, reason: null };
  const pid = state.runner?.pid ?? null;
  const beat = Date.parse(state.runner?.lastHeartbeatAt ?? '');
  // Runs started before kernels recorded a heartbeat carry no pid to check. A
  // live V2 kernel rewrites state.json on every event and about once a second
  // while an agent streams, so a long silence is the only evidence available.
  // The threshold is deliberately generous: being wrong here would call a
  // working run dead.
  if (pid == null || !Number.isFinite(beat)) {
    if (!runDir) return { checked: false, alive: true, reason: null };
    let modifiedAt = 0;
    try { modifiedAt = statSync(join(runDir, 'state.json')).mtimeMs; } catch { return { checked: false, alive: true, reason: null }; }
    const silentMs = now - modifiedAt;
    if (silentMs < NO_HEARTBEAT_SILENCE_MS) return { checked: false, alive: true, reason: null };
    return {
      checked: true,
      alive: false,
      reason: `no heartbeat recorded and the run has not been written for ${Math.round(silentMs / 60000)}m; the kernel is not running`,
    };
  }
  if (processAlive(pid)) {
    if (now - beat < RUNNER_GRACE_MS) return { checked: true, alive: true, reason: null };
    return { checked: true, alive: false, reason: `runner process ${pid} has not updated the run for ${Math.round((now - beat) / 1000)}s` };
  }
  return { checked: true, alive: false, reason: `runner process ${pid} is gone; the run stopped before reaching a result` };
}

export function isOngoing(runDir, state) {
  // A legacy run has no executor left to be ongoing with.
  if (isLegacyRunState(state)) return false;
  if (['completed', 'partial', 'cancelled', 'failed', 'interrupted'].includes(state.lifecycle?.status)) return false;
  // A run whose kernel died is not ongoing, whatever state.json still claims.
  return v2RunnerLiveness(state, { runDir }).alive;
}
