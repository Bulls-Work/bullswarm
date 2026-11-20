// Concurrency caps: how many steps one caller (a lead) may have in flight at
// once, and how many attempts one pool may run at once (the backstop).
//
// Doctrine:
//   C1. One file, <BULLSWARM_HOME>/caps.json, written only through
//       `bullswarm caps` (the fleet's Pacer is its one writer). Every write is
//       atomic: temp file then rename. A missing or unreadable file means no
//       caps at all, never a refusal: caps slow work down, they never break it.
//   C2. A caller's group is found from its recorded identity (src/lib/caller.js):
//       an explicit name (`--caller`, BULLSWARM_CALLER) first, then a herdr pane
//       listed under a group, then the longest matching cwd prefix. No match:
//       the `default` cap when one is set, applied to that caller alone (its
//       pane, else its directory), otherwise uncapped.
//   C3. A capped step holds one slot file under <BULLSWARM_HOME>/caller-slots/
//       from the moment it asks until its dispatch ends (every attempt and
//       retry inside one slot). Slots are ordered by arrival (time, then id);
//       the first `max` live slots of a group run, the rest wait in that order.
//       Every process computes the same order from the same files, so no lock
//       is needed and two kernels can never both take the last slot.
//   C4. A crashed process must never hold a slot: a read prunes slots whose
//       kernel pid is gone and slots older than 12 hours, as the in-flight
//       ledger does (assignments.js A3).
//   C5. Nested work (a worker's own `bullswarm run`, BULLSWARM_DEPTH set) is
//       never capped: it would wait on the slot its own parent holds.
//   C6. The pool cap is a backstop read at every pick from the in-flight
//       ledger: a pool at its cap is left out of that pick. It is not
//       slot-ordered, so two picks in the same instant can pass it by one.

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from './assignments.js';

export const CAPS_SCHEMA = 'bullswarm.caps.v1';
export const SLOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_POLL_MS = 5_000;
/** A group or caller name: letters, digits, dot, dash, underscore; `default` is reserved. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_RE = /^w[A-Za-z0-9]+:p[0-9]+$/;
const MAX_CAP = 1000;

export function capsPath(bullswarmDir) {
  return join(bullswarmDir, 'caps.json');
}

export function slotsDir(bullswarmDir) {
  return join(bullswarmDir, 'caller-slots');
}

function capNumber(value) {
  // null, undefined and '' mean "no cap", never 0 (Number(null) is 0).
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_CAP ? n : null;
}

function absolutePrefix(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.length > 4096) return null;
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/** An empty caps document. */
export function emptyCaps() {
  return { schemaVersion: CAPS_SCHEMA, callers: {}, pools: {}, default: null, updatedAt: null };
}

/**
 * The caps document, normalized: unknown keys and invalid entries are dropped
 * (C1). Never throws; a missing or broken file reads as no caps.
 */
export function readCaps(bullswarmDir) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(capsPath(bullswarmDir), 'utf8')); } catch { return emptyCaps(); }
  return normalizeCaps(raw);
}

export function normalizeCaps(raw) {
  const caps = emptyCaps();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return caps;
  for (const [name, entry] of Object.entries(raw.callers ?? {})) {
    if (!NAME_RE.test(name) || name === 'default' || !entry || typeof entry !== 'object') continue;
    const max = capNumber(entry.max);
    if (max == null) continue;
    caps.callers[name] = {
      max,
      cwdPrefixes: [...new Set((Array.isArray(entry.cwdPrefixes) ? entry.cwdPrefixes : []).map(absolutePrefix).filter(Boolean))],
      panes: [...new Set((Array.isArray(entry.panes) ? entry.panes : []).filter((p) => typeof p === 'string' && PANE_RE.test(p)))],
    };
  }
  for (const [pool, value] of Object.entries(raw.pools ?? {})) {
    const max = capNumber(value);
    if (typeof pool === 'string' && pool && pool.length <= 128 && max != null) caps.pools[pool] = max;
  }
  caps.default = capNumber(raw.default);
  caps.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return caps;
}

export function writeCaps(bullswarmDir, caps, { now = Date.now() } = {}) {
  const doc = { ...normalizeCaps(caps), updatedAt: new Date(now).toISOString() };
  mkdirSync(bullswarmDir, { recursive: true });
  const path = capsPath(bullswarmDir);
  const temp = join(bullswarmDir, `.caps.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  try { renameSync(temp, path); } catch (err) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  return doc;
}

function underPrefix(dir, prefix) {
  if (typeof dir !== 'string') return false;
  return prefix === '/' || dir === prefix || dir.startsWith(`${prefix}/`);
}

/**
 * The group a caller belongs to and its cap (C2), or `{group: null, max: null}`
 * when nothing caps it. `source` says how the group was found.
 *
 * @param {object} caps   normalized caps
 * @param {object|null} caller  {herdrPane, claudeSession, cwd, name?, nested?}
 */
export function callerCap(caps, caller) {
  const none = { group: null, max: null, source: null };
  if (!caller || caller.nested === true) return { ...none, source: caller?.nested ? 'nested' : null };
  const callers = caps?.callers ?? {};
  // The default cap is per caller, never one shared pool of slots: an unnamed
  // caller is its own group, keyed by its pane, else its directory.
  const own = caller.herdrPane ? `pane:${caller.herdrPane}` : caller.cwd ? `cwd:${caller.cwd}` : null;
  const fallback = (group, source) => (caps?.default != null && (group ?? own)
    ? { group: group ?? own, max: caps.default, source }
    : { ...none, group: group ?? null, source });
  if (typeof caller.name === 'string' && NAME_RE.test(caller.name)) {
    const entry = callers[caller.name];
    return entry ? { group: caller.name, max: entry.max, source: 'name' } : fallback(caller.name, 'name');
  }
  if (caller.herdrPane) {
    for (const [name, entry] of Object.entries(callers)) {
      if (entry.panes.includes(caller.herdrPane)) return { group: name, max: entry.max, source: 'pane' };
    }
  }
  let best = null;
  for (const [name, entry] of Object.entries(callers)) {
    for (const prefix of entry.cwdPrefixes) {
      if (underPrefix(caller.cwd, prefix) && (!best || prefix.length > best.prefix.length)) best = { name, prefix, max: entry.max };
    }
  }
  if (best) return { group: best.name, max: best.max, source: 'cwd' };
  return fallback(null, 'default');
}

// --- slots -------------------------------------------------------------------

function slotKey(slot) {
  return `${String(slot.at).padStart(16, '0')}:${slot.id}`;
}

/** Live slots, every group, in arrival order; prunes dead and stale ones (C4). */
export function listSlots(bullswarmDir, { now = Date.now(), alive = isProcessAlive } = {}) {
  const dir = slotsDir(bullswarmDir);
  if (!existsSync(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const live = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const path = join(dir, file);
    let slot = null;
    try { slot = JSON.parse(readFileSync(path, 'utf8')); } catch { slot = null; }
    if (!slot || typeof slot.group !== 'string' || !Number.isFinite(slot.at)) {
      try { if (now - statSync(path).mtimeMs > SLOT_MAX_AGE_MS) unlinkSync(path); } catch { /* gone */ }
      continue;
    }
    const mine = slot.pid === process.pid;
    if (!mine && (now - slot.at > SLOT_MAX_AGE_MS || !alive(slot.pid))) {
      try { unlinkSync(path); } catch { /* another reader pruned it */ }
      continue;
    }
    live.push(slot);
  }
  return live.sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
}

/** Running and waiting counts per group: a slot runs when it is among the first `max`. */
export function slotSummary(bullswarmDir, caps, opts = {}) {
  const byGroup = new Map();
  for (const slot of listSlots(bullswarmDir, opts)) {
    if (!byGroup.has(slot.group)) byGroup.set(slot.group, []);
    byGroup.get(slot.group).push(slot);
  }
  const out = {};
  for (const [group, slots] of byGroup) {
    const max = caps?.callers?.[group]?.max ?? caps?.default ?? null;
    const running = max == null ? slots.length : Math.min(max, slots.length);
    out[group] = { max: max ?? null, running, waiting: slots.length - running, slots };
  }
  return out;
}

function writeSlot(bullswarmDir, slot) {
  const dir = slotsDir(bullswarmDir);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${slot.id}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(slot)}\n`);
  renameSync(temp, join(dir, `${slot.id}.json`));
}

function removeSlot(bullswarmDir, id) {
  try { unlinkSync(join(slotsDir(bullswarmDir), `${id}.json`)); return true; } catch { return false; }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Wait for this caller's turn under its group cap (C3) and hold the slot until
 * `release()`. Returns `{release, group, max, waitedMs, queued}`. An uncapped
 * caller gets a no-op release at once. `shouldCancel()` true while waiting
 * gives up the place and returns `{cancelled: true}`.
 *
 * `onQueued({group, max, ahead, running})` is called when the step first has to
 * wait and again whenever its place changes; `onAdmitted({waitedMs})` once when
 * it may start after waiting.
 */
export async function acquireCallerSlot({
  bullswarmDir, caller, runId = null, actionId = null,
  shouldCancel = null, onQueued = null, onAdmitted = null,
  now = Date.now, sleep = defaultSleep, pollMs = DEFAULT_POLL_MS, alive = isProcessAlive,
  readCapsFn = readCaps,
} = {}) {
  const noop = { release() {}, group: null, max: null, waitedMs: 0, queued: false };
  let caps = readCapsFn(bullswarmDir);
  let cap = callerCap(caps, caller);
  if (!cap.group || cap.max == null) return noop;
  const slot = {
    id: randomUUID(), group: cap.group, pid: process.pid, at: now(),
    runId, actionId, herdrPane: caller?.herdrPane ?? null,
  };
  try { writeSlot(bullswarmDir, slot); } catch { return noop; }
  const startedWaiting = now();
  let queued = false;
  let lastAhead = null;
  for (;;) {
    const mine = listSlots(bullswarmDir, { now: now(), alive }).filter((s) => s.group === slot.group);
    const position = mine.findIndex((s) => s.id === slot.id);
    // A slot that vanished (pruned by mistake, a cleared home) is rewritten in place.
    if (position < 0) { try { writeSlot(bullswarmDir, slot); } catch { return noop; } continue; }
    if (cap.max == null || position < cap.max) break;
    if (shouldCancel?.()) {
      removeSlot(bullswarmDir, slot.id);
      return { ...noop, cancelled: true, group: slot.group, max: cap.max, waitedMs: now() - startedWaiting, queued };
    }
    // Steps waiting in front of this one (0: it starts at the next free slot).
    const ahead = position - cap.max;
    if (!queued || ahead !== lastAhead) {
      queued = true;
      lastAhead = ahead;
      try { onQueued?.({ group: slot.group, max: cap.max, ahead, running: Math.min(cap.max, mine.length) }); } catch { /* display only */ }
    }
    await sleep(pollMs);
    // The Pacer may change the cap while this step waits.
    caps = readCapsFn(bullswarmDir);
    const next = callerCap(caps, caller);
    cap = next.group === slot.group ? next : { ...cap, max: null };
  }
  const waitedMs = now() - startedWaiting;
  if (queued) { try { onAdmitted?.({ group: slot.group, max: cap.max, waitedMs }); } catch { /* display only */ } }
  let released = false;
  return {
    release() { if (!released) { released = true; removeSlot(bullswarmDir, slot.id); } },
    group: slot.group, max: cap.max, waitedMs, queued,
  };
}

/** Pools at or over their cap given live in-flight counts: `Map(pool -> {count, max})`. */
export function poolsAtCap(caps, inflightCounts) {
  const full = new Map();
  for (const [pool, max] of Object.entries(caps?.pools ?? {})) {
    const count = Number(inflightCounts.get?.(pool) ?? inflightCounts[pool] ?? 0);
    if (count >= max) full.set(pool, { count, max });
  }
  return full;
}

/**
 * `--caller <name>` on `run` and `workflow goal`: this launch's caller name,
 * set as BULLSWARM_CALLER for the launching process so callerIdentity()
 * records it (src/lib/caller.js). Returns an error line, or null.
 */
export function applyCallerFlag(value, env = process.env) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === 'default' || !NAME_RE.test(value)) {
    return '✗ --caller takes a name: letters, digits, dot, dash or underscore, up to 64 characters (not "default")';
  }
  env.BULLSWARM_CALLER = value;
  return null;
}

/**
 * `--no-wait`: the refusal line when this caller's group has no free slot now,
 * otherwise null. A launch check only: a workflow's later steps still queue.
 */
export function noWaitRefusal(bullswarmDir, caller, opts = {}) {
  const caps = (opts.readCapsFn ?? readCaps)(bullswarmDir);
  const cap = callerCap(caps, caller);
  if (!cap.group || cap.max == null) return null;
  const inUse = listSlots(bullswarmDir, opts).filter((slot) => slot.group === cap.group).length;
  if (inUse < cap.max) return null;
  return `✗ not started (--no-wait): caller ${cap.group} already has ${inUse} step${inUse === 1 ? '' : 's'} running or queued`
    + ` and its cap is ${cap.max} (bullswarm caps show). Run it again without --no-wait to queue it.`;
}
