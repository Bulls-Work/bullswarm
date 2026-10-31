// A sign-in failure at dispatch holds the pool for later runs.
//
// A worker CLI can be signed out while its meter read keeps succeeding (the
// decision log of 2026-10-25/27/28: 18 runs, 7-15 s apart, each re-picked the
// pool the run before had just found signed out). When an attempt ends with
// failure kind `auth`, the dispatch records the fact in the state file:
//   state.pools[<pool>].authHold = { at, until, level }
// It holds the pool, and every pool in its credential group (upstreamGroupOf),
// out of picks for 15 minutes, then 30, then 60 (the cap) for each further
// auth failure after the hold ran out. A successful attempt clears it; a
// successful meter read does not (meter and worker sign-in can disagree).
// Pinned pools are still dispatched (dispatch-pools.js preparePools).

import { upstreamGroupOf } from './state.js';

export const AUTH_HOLD_MINUTES = [15, 30, 60];

const toMs = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/** Record an auth failure of `pool` at `at` (epoch ms) on a state object. */
export function recordAuthFailure(state, pool, at) {
  state.pools ??= {};
  const record = state.pools[pool] ??= {};
  const earlier = record.authHold;
  const earlierLevel = Number.isInteger(earlier?.level) ? earlier.level : null;
  const earlierUntil = toMs(earlier?.until);
  // A failure after the hold ran out escalates; one during it (a pinned
  // dispatch) keeps the level and starts the window again.
  const level = earlierLevel == null ? 0
    : Math.min(earlierLevel + (earlierUntil != null && at >= earlierUntil ? 1 : 0), AUTH_HOLD_MINUTES.length - 1);
  record.authHold = {
    at: new Date(at).toISOString(),
    until: new Date(at + AUTH_HOLD_MINUTES[level] * 60_000).toISOString(),
    level,
  };
  return record.authHold;
}

/** Forget the hold of every named pool (a successful attempt on the credential). */
export function clearAuthHolds(state, pools) {
  let changed = false;
  for (const name of pools) {
    if (state.pools?.[name]?.authHold) {
      delete state.pools[name].authHold;
      changed = true;
    }
  }
  return changed;
}

/**
 * The hold each named pool is under at `now`, its own or a credential-group
 * mate's: `{ [pool]: { at, until, via } }`. Pools not held are absent.
 * `connectors` maps pool name to connector; `records` is `state.pools`.
 */
export function activeAuthHolds(records, connectors, now) {
  const own = [];
  for (const [name, record] of Object.entries(records ?? {})) {
    const until = toMs(record?.authHold?.until);
    if (until != null && until > now && connectors[name]) own.push({ name, hold: record.authHold, until });
  }
  const held = {};
  for (const name of Object.keys(connectors)) {
    const group = upstreamGroupOf(connectors[name]);
    const found = own
      .filter((entry) => entry.name === name || (group && upstreamGroupOf(connectors[entry.name]) === group))
      .sort((a, b) => b.until - a.until)[0];
    if (found) held[name] = { at: found.hold.at, until: found.hold.until, via: found.name };
  }
  return held;
}

function ageText(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

/** `sign-in failed at dispatch 3m ago, retry after 2026-10-31T13:20:00.000Z` */
export function authHoldText(hold, now = Date.now()) {
  const at = toMs(hold?.at);
  const age = at == null ? '' : ` ${ageText(now - at)} ago`;
  return `sign-in failed at dispatch${age}, retry after ${hold?.until}`;
}
