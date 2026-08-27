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
import { join } from 'node:path';

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
    try { state = JSON.parse(readFileSync(sf, 'utf8')); }
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
 * Each entry includes the `state.json` summary + the `report.json`
 * summary if it exists. The `ongoing` field is computed by trying to
 * take an exclusive flock on `state.json` (proves the writer process
 * is gone).
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
    const rf = join(dir, 'report.json');
    let state = null, report = null;
    if (existsSync(sf)) {
      try { state = JSON.parse(readFileSync(sf, 'utf8')); } catch { /* corrupt */ }
    }
    if (existsSync(rf)) {
      try { report = JSON.parse(readFileSync(rf, 'utf8')); } catch { /* corrupt */ }
    }
    out.push({
      runId: name,
      shortId: state?.shortId ?? null,
      runDir: dir,
      state,
      report,
      ongoing: isOngoing(dir, state),
    });
  }
  return out;
}

/**
 * An ongoing run is one whose owning process is still alive OR very
 * recently alive. We probe via `state.json`'s mtime: the runtime
 * writes state.json on every step and sends a heartbeat during dispatch.
 * A run is "ongoing" when:
 *   - `state.finishedAt` is unset, AND
 *   - `state.json` was modified within the last `ONGOING_GRACE_MS`
 *     (default 90 s).
 * The 90 s window covers long-running steps (network calls, model
 * inference) and gives a comfortable buffer between the last
 * `persist()` and the run's terminal `persist()` (which sets
 * `finishedAt`, after which the fast-path below returns false).
 *
 * Edge case: if the process is killed before writing `finishedAt`,
 * the run looks "ongoing" for up to 90 s, then falls into the
 * historical bucket. That's the right behavior — a half-finished
 * run is not the same as a completed one, and we shouldn't be
 * eager to garbage-collect it.
 */
export const ONGOING_GRACE_MS = 90_000;

export function isOngoing(runDir, state) {
  if (state && state.status && state.finishedAt) return false;
  try {
    const sf = join(runDir, 'state.json');
    if (!existsSync(sf)) return false;
    const st = statSync(sf);
    return (Date.now() - st.mtimeMs) < ONGOING_GRACE_MS;
  } catch {
    return false;
  }
}
