// Which lanes a pool serves: the operator's setting (`strategy set-lanes`,
// stored at state.strategy.laneOverrides[pool]) when there is one, else the
// lanes its connector ships. buildPools resolves it once (resolvePoolLanes);
// every reader of a built pool asks lanesOf, so routing, `bullswarm pools`,
// capabilities, strategy inventory and the workflow pin checks agree.
//
// This module imports nothing, so any layer may use it without a cycle.

export const LANES = Object.freeze(['analyze', 'build', 'chore']);

/** The override stored for one pool, in lane order, or null when it has none (or it is not valid). */
export function laneOverrideFor(strategy, poolName) {
  const stored = strategy?.laneOverrides?.[poolName];
  if (!Array.isArray(stored)) return null;
  const lanes = LANES.filter((lane) => stored.includes(lane));
  return lanes.length ? lanes : null;
}

/**
 * The lanes a pool serves and where they came from: {lanes, source}, source
 * 'override' (strategy set-lanes) or 'connector'. A connector that declares
 * no lanes keeps `lanes` undefined, as before, so readers keep their own
 * fallback.
 */
export function resolvePoolLanes(connector, strategy, poolName) {
  const override = laneOverrideFor(strategy, poolName);
  if (override) return { lanes: override, source: 'override' };
  return { lanes: connector?.lanes, source: 'connector' };
}

/** A built pool's lanes (`fallback` when neither the pool nor its connector names any). */
export function lanesOf(pool, fallback = LANES) {
  return pool?.lanes ?? pool?.connector?.lanes ?? fallback;
}

/** Whether a built pool serves `lane`. */
export function servesLane(pool, lane) {
  return lanesOf(pool).includes(lane);
}

/** The pool's lanes for `bullswarm pools`: `analyze/build`, plus ` (set-lanes)` when the operator set them. */
export function poolLanesText(pool) {
  const text = lanesOf(pool, []).join('/') || 'none';
  return pool?.lanesSource === 'override' ? `${text} (set-lanes)` : text;
}

/**
 * Who limited a pool's lanes, for a refusal: `strategy set-lanes limits it to
 * analyze (bullswarm strategy set-lanes grok default --yes clears it)`, or
 * `its connector lists analyze`.
 */
export function offLaneReason(pool) {
  const name = pool?.name ?? String(pool);
  const lanes = lanesOf(pool, []);
  const list = lanes.length ? lanes.join(', ') : 'no lane';
  return pool?.lanesSource === 'override'
    ? `strategy set-lanes limits it to ${list} (bullswarm strategy set-lanes ${name} default --yes clears it)`
    : `its connector lists ${list}`;
}

/** Why a pool does not serve `lane`, in one line: `grok does not serve build work: <offLaneReason>`. */
export function offLaneText(pool, lane) {
  return `${pool?.name ?? String(pool)} does not serve ${lane} work: ${offLaneReason(pool)}`;
}

/**
 * Parse the `<lane,...|default>` argument: an array of lanes in lane order,
 * or null for `default`. Throws "usage: ..." or "unknown lane ..." (exit 2).
 */
export function parseLanesArg(raw, usage) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) throw new Error(usage);
  if (text === 'default') return null;
  const named = text.split(',').map((lane) => lane.trim()).filter(Boolean);
  if (!named.length) throw new Error(usage);
  const unknown = named.find((lane) => !LANES.includes(lane));
  if (unknown) throw new Error(`unknown lane "${unknown}" (lanes are ${LANES.join(', ')}, or default)`);
  return LANES.filter((lane) => named.includes(lane));
}

/** Write (or with null, drop) one pool's override on a strategy object. */
export function setLaneOverride(strategy, poolName, lanes) {
  if (lanes) {
    strategy.laneOverrides ??= {};
    strategy.laneOverrides[poolName] = [...lanes];
    return;
  }
  if (!strategy.laneOverrides) return;
  delete strategy.laneOverrides[poolName];
  if (!Object.keys(strategy.laneOverrides).length) delete strategy.laneOverrides;
}
