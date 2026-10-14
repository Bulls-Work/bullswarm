// Operator limits on a pool that routing obeys before it ranks anything:
// a hold (out of routing for a reason, until a date) and a reserve (opt-in
// headroom the router never spends). Both live in state.pools[<pool>] and are
// attached to the pool by config.js buildPools.
//
// Doctrine (BS-kernel-5h, Charlie 2026-10-14):
//   - A reserve is OFF unless set. With none, every pool is burned to 100% by
//     pace; nothing here time-boxes a task or ends it early before a reset.
//   - A hold ends by itself at its `until`; no command is needed to lift it.

import { finiteOrNull as num } from './num.js';

export const RESERVE_WINDOWS = ['5h', 'weekly', 'monthly', 'all'];

/** The pool's hold while it is active at `now`, else null. */
export function activeHold(pool, now = Date.now()) {
  const hold = pool?.hold;
  if (!hold || typeof hold !== 'object') return null;
  const until = Date.parse(hold.until ?? '');
  if (!Number.isFinite(until) || until <= now) return null;
  return {
    reason: typeof hold.reason === 'string' && hold.reason.trim() ? hold.reason.trim() : 'on hold',
    until: new Date(until).toISOString(),
    setAt: typeof hold.setAt === 'string' ? hold.setAt : null,
  };
}

/** The pool's reserve setting ({pct, window, ceiling}), or null when off. */
export function reserveOf(pool) {
  const raw = pool?.reserve;
  if (!raw || typeof raw !== 'object') return null;
  const pct = num(raw.pct);
  if (pct == null || pct <= 0 || pct >= 100) return null;
  const window = RESERVE_WINDOWS.includes(raw.window) ? raw.window : 'all';
  return { pct, window, ceiling: 100 - pct };
}

/**
 * The window whose reading (or projection, when in-flight work is attached)
 * has reached the reserve ceiling, or null. A reserve on `all` covers the 5h
 * window and the pacing window; `5h`, `weekly` or `monthly` covers that one.
 * The projection counts work already in flight, so a burst of parallel picks
 * stops at the ceiling instead of overshooting it.
 */
export function reserveReached(pool) {
  const reserve = reserveOf(pool);
  if (!reserve) return null;
  const checks = [];
  if (reserve.window === 'all' || reserve.window === '5h') {
    checks.push(['5h', num(pool.fiveHourUsedPct), num(pool.projectedFiveHourPct)]);
  }
  const pacing = pool.pacingWindow ?? null;
  if (pacing && pacing !== '5h' && (reserve.window === 'all' || reserve.window === pacing)) {
    checks.push([pacing, num(pool.usedPct), num(pool.projectedPacingPct)]);
  }
  for (const [window, used, projected] of checks) {
    const level = Math.max(used ?? -Infinity, projected ?? -Infinity);
    if (Number.isFinite(level) && level >= reserve.ceiling) {
      return { window, levelPct: Math.round(level * 10) / 10, ceiling: reserve.ceiling, pct: reserve.pct };
    }
  }
  return null;
}

/** Why a pool is out of routing by an operator limit, or null. */
export function operatorLimit(pool, now = Date.now()) {
  const hold = activeHold(pool, now);
  if (hold) return { kind: 'hold', ...hold };
  const reserve = reserveReached(pool);
  if (reserve) return { kind: 'reserve', ...reserve };
  return null;
}

/** One line for reasons and `pools`: `held until … (reason)` / `at reserve …`. */
export function operatorLimitText(pool, limit) {
  if (!limit) return '';
  if (limit.kind === 'hold') return `${pool.name} held until ${limit.until} (${limit.reason})`;
  return `${pool.name} at its reserve: ${limit.window} ${limit.levelPct}% >= ${limit.ceiling}% (reserve ${limit.pct}%)`;
}

/**
 * Parse a hold end: an ISO date/time, or a duration from now (`90m`, `24h`,
 * `3d`). Returns epoch ms or null.
 */
export function parseHoldUntil(text, now = Date.now()) {
  const value = String(text ?? '').trim();
  const duration = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(value);
  if (duration) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2].toLowerCase()];
    return now + Number(duration[1]) * unit;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
