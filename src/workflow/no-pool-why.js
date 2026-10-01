// Why no pool can take a step now, in one wording (0.37.0).
//
// dispatchV2Action says it when a step fails before, or instead of, an
// attempt; `bullswarm run --dry-run` (pick-preview.js) says the same thing
// before anything runs. A capable pool that cannot take the step is "held",
// with its reason and when it is back; a window at its limit is the first
// reason, so a spent pool never reads as a missing tier model.

import { windowSpent } from '../meters/framework.js';
import { meterSignInDead, meterSignInText } from './dispatch-pools.js';

function toMs(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A pool's window at its limit as a held reason `[text, backMs, limit]`, or null. */
export function spentWindowPart(pool, at) {
  const spent = windowSpent(pool, at);
  return spent ? [`at its ${spent.window} limit`, toMs(spent.resetsAt), true] : null;
}

/** A pool whose latest meter read says its sign-in is dead, as a held reason, or null. */
export function signInPart(pool) {
  return meterSignInDead(pool) ? [meterSignInText(pool), null, false] : null;
}

/** A pool the forecast says would run out mid-step (`{ until, forecast }`) as a held reason. */
export function drainingPart(view) {
  return [`nearly spent (forecast ${Number(view.forecast).toFixed(1)}%)`, view.until, true];
}

/**
 * One held pool from its reasons (`[text, backMs|null, limit]`): the reason
 * that keeps it out longest when any is timed, else the first. Returns
 * `{ pool, text, limit, back }`, or null when there is no reason.
 */
export function heldEntry(name, parts) {
  if (!parts.length) return null;
  const timed = parts.filter(([, ms]) => ms != null);
  const [reason, back, limit] = timed.length
    ? timed.reduce((latest, part) => (part[1] > latest[1] ? part : latest))
    : parts[0];
  return { pool: name, text: back != null ? `${name} ${reason} until ${new Date(back).toISOString()}` : `${name} ${reason}`, limit, back };
}

/** With no attempt: a usage limit on every capable pool reads as quota. */
export function noPoolFailureKind(capableCount, held) {
  return held.length && held.length === capableCount && held.every((entry) => entry.limit) ? 'quota' : 'unavailable';
}

/**
 * The reason no pool can take the step. `capableCount` counts the pools that
 * could run it were none at a limit; `held` the ones that cannot now;
 * `offTier` the reasons a pool that would have the tier lacks it now: free
 * models off for it (`strategy set-free never`), or a plan seen not to
 * include the tier's model (tierOffReasons in v2-dispatch.js).
 */
export function noPoolWhy({ capableCount, held, failureKind, strictPool = null, lane, effort, offTier = [] }) {
  if (!capableCount) {
    const off = offTier.length ? `; ${offTier.join('; ')}` : '';
    return strictPool
      ? `no eligible pool: the pinned pool ${strictPool} cannot run ${lane}/${effort} work (it is disabled or has no model on the ${effort} tier)${off}`
      : `no eligible pool: no enabled pool has a model on the ${effort} tier for ${lane} work${off}`;
  }
  return held.length
    ? `${failureKind === 'quota' ? 'no pool with quota to spare' : 'no pool free'}: ${held.map((entry) => entry.text).join('; ')}`
    : 'no eligible pool';
}
