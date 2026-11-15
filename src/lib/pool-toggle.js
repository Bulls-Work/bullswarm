// Pool toggle records: who turned a pool on or off for routing, when, and why.
//
// Every writer of `state.pools[<pool>].enabled` goes through setPoolEnabled()
// inside its own updateState() mutator (state.js S5), so the record lands in
// the same locked, atomic write as the toggle itself. The record lives in
// state.json under `strategy.poolToggles[<pool>]`:
//
//   { latest: <record>, history: [<record>, ...] }   (history: last 20, newest last)
//   record = { enabled, at (ISO), by, reason|null, via, caller }
//
// `by` is the OS user name. `caller` is the existing caller identity
// (caller.js): a herdr pane id and a Claude Code session id, each validated
// by shape. No other environment value is read or recorded.

import { userInfo } from 'node:os';
import { callerIdentity } from './caller.js';

export const POOL_TOGGLE_HISTORY = 20;

/** The OS user name, or null when the system cannot say. */
export function toggleActor() {
  try {
    const name = userInfo().username;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

function toggleCaller() {
  const { herdrPane, claudeSession } = callerIdentity();
  return { herdrPane, claudeSession };
}

/**
 * Set a pool's routing switch on a state loaded under the lock, and record
 * the change. `onlyIfChanged` skips the record when the
 * pool is already in that state (configure and setup rewrite every pool);
 * `defaultEnabled` is what an unset switch means (false for a test fixture).
 *
 * @returns the record written, or null when nothing changed.
 */
export function setPoolEnabled(state, pool, enabled, {
  via, reason = null, onlyIfChanged = false, defaultEnabled = true,
  now = Date.now(), by = toggleActor(),
} = {}) {
  state.pools ??= {};
  state.pools[pool] ??= {};
  const current = state.pools[pool].enabled;
  const before = typeof current === 'boolean' ? current : defaultEnabled;
  // The switch is written either way, as every writer did before records.
  state.pools[pool].enabled = enabled;
  if (onlyIfChanged && before === enabled) return null;
  const record = {
    enabled,
    at: new Date(now).toISOString(),
    by,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
    via,
    caller: toggleCaller(),
  };
  state.strategy ??= {};
  state.strategy.poolToggles ??= {};
  const previous = state.strategy.poolToggles[pool];
  const history = Array.isArray(previous?.history) ? previous.history : [];
  state.strategy.poolToggles[pool] = {
    latest: record,
    history: [...history, record].slice(-POOL_TOGGLE_HISTORY),
  };
  return record;
}

/** The latest toggle record for a pool, or null when none was ever written. */
export function latestPoolToggle(state, pool) {
  const latest = state?.strategy?.poolToggles?.[pool]?.latest;
  return latest && typeof latest === 'object' && !Array.isArray(latest) ? { ...latest } : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `11 Nov 03:00Z` for an ISO time, in UTC; null when it does not parse. */
export function toggleStamp(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const mm = String(when.getUTCMinutes()).padStart(2, '0');
  return `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${hh}:${mm}Z`;
}

/**
 * What `bullswarm pools` adds after `disabled` for a pool whose latest record
 * is the disable: ` since 11 Nov 03:00Z by alice: <reason>`. Empty otherwise.
 */
export function disabledSinceText(toggle) {
  if (!toggle || toggle.enabled !== false) return '';
  const stamp = toggleStamp(toggle.at);
  const since = stamp ? ` since ${stamp}` : '';
  const by = toggle.by ? ` by ${toggle.by}` : '';
  return `${since}${by}: ${toggle.reason || 'no reason recorded'}`;
}
