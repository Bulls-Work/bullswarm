// Operator limits on a pool that routing obeys before it ranks anything:
// a hold (out of routing for a reason, until a date) and a reserve (opt-in
// headroom the router never spends). Both live in state.pools[<pool>] and are
// attached to the pool by config.js buildPools.
//
// Doctrine (BS-kernel-5h, Charlie 2026-10-14):
//   - A reserve is OFF unless set. With none, every pool is burned to 100% by
//     pace; nothing here time-boxes a task or ends it early before a reset.
//   - A hold ends by itself at its `until`; no command is needed to lift it.
//   - A hold set with --allow-pinned (`allowPinned: true`) keeps the pool out
//     of every pick routing makes on its own, but a caller who pins the pool
//     on purpose may still use it (holdPins / poolIsPinned below). A plain
//     hold keeps pinned picks out too.

import { finiteOrNull as num } from './num.js';
import { modelFamilyOf } from './model-family.js';

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
    allowPinned: hold.allowPinned === true,
  };
}

/**
 * The pins a caller made on purpose, which an allow-pinned hold lets through.
 * One rule for every place a hold is enforced (route.js R14, the dispatch's
 * no-pool reason, the pick preview, plan validate). A pool counts as pinned
 * when:
 *   - it is the run's or step's pin (`strictPool`: --worker-pool, a step
 *     restart onto a pool); a gate retry that keeps the pool it ran on is not
 *     passed here, since routing chose that pool, not the caller;
 *   - the step's route lists it in `pools.use`, or lists its provider (the
 *     pool name up to the first colon) in `providers.use`
 *     (`bullswarm run --use-provider command-code`).
 * An avoid list (`--avoid-pool`, `--avoid-provider`, `pools.avoid`,
 * `providers.avoid`) and `independentOf` only narrow routing's own choice:
 * they never pin, even when they leave the held pool the only one.
 */
export function holdPins({ strictPool = null, routeFilter = null } = {}) {
  const names = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : []);
  return {
    pools: [...new Set([...(typeof strictPool === 'string' && strictPool ? [strictPool] : []), ...names(routeFilter?.usePools)])],
    providers: [...new Set(names(routeFilter?.useProviders).map((name) => name.toLowerCase()))],
  };
}

/** Whether `pins` (holdPins) name this pool or its provider. */
export function poolIsPinned(pool, pins) {
  if (!pins || !pool) return false;
  if ((pins.pools ?? []).includes(pool.name)) return true;
  const provider = modelFamilyOf(pool);
  return Boolean(provider) && (pins.providers ?? []).includes(provider);
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

/**
 * Why a pool is out of routing by an operator limit, or null. `pinned` says
 * the caller pinned this pool (poolIsPinned): an allow-pinned hold then does
 * not keep it out, though a reserve still does.
 */
export function operatorLimit(pool, now = Date.now(), { pinned = false } = {}) {
  const hold = activeHold(pool, now);
  if (hold && !(hold.allowPinned && pinned)) return { kind: 'hold', ...hold };
  const reserve = reserveReached(pool);
  if (reserve) return { kind: 'reserve', ...reserve };
  return null;
}

export const PINNED_ALLOWED = 'pinned runs allowed';

/** `held until <date> (<reason>)`, with ` · pinned runs allowed` for an allow-pinned hold. */
export function holdText(hold) {
  return `held until ${hold.until} (${hold.reason})${hold.allowPinned ? ` · ${PINNED_ALLOWED}` : ''}`;
}

/** One line for reasons and `pools`: `held until … (reason)` / `at reserve …`. */
export function operatorLimitText(pool, limit) {
  if (!limit) return '';
  if (limit.kind === 'hold') return `${pool.name} ${holdText(limit)}`;
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
