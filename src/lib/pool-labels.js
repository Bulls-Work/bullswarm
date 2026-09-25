// Per-home display labels for pool ids. Pool ids remain the durable routing,
// credential and history keys; this module is the only presentation/input
// translation boundary.

import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsjson.js';

export const POOL_LABELS_FILE = 'pool-labels.json';

const cache = new Map();

function normalized(raw) {
  const source = raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
    ? raw.labels : {};
  return Object.fromEntries(Object.entries(source)
    .filter(([pool, label]) => typeof pool === 'string' && pool && typeof label === 'string' && label));
}

export function loadPoolLabels(home) {
  const key = String(home);
  if (!cache.has(key)) cache.set(key, normalized(readJsonSafe(join(key, POOL_LABELS_FILE), {})));
  return cache.get(key);
}

export function poolLabel(poolId, home) {
  if (typeof poolId !== 'string' || !poolId) return poolId;
  return loadPoolLabels(home)[poolId] ?? poolId;
}

/** Resolve either a durable pool id or its unique per-home display label. */
export function resolvePoolId(value, home) {
  if (typeof value !== 'string' || !value) return value;
  const labels = loadPoolLabels(home);
  if (Object.prototype.hasOwnProperty.call(labels, value)) return value;
  return Object.entries(labels).find(([, label]) => label === value)?.[0] ?? value;
}

export function poolLabelEntries(home) {
  return Object.entries(loadPoolLabels(home))
    .map(([pool, label]) => ({ pool, poolLabel: label }))
    .sort((a, b) => a.pool.localeCompare(b.pool));
}

export function setPoolLabel(home, pool, label, knownPoolIds) {
  const known = new Set(knownPoolIds ?? []);
  if (!known.has(pool)) throw new Error(`unknown pool "${pool}" — bullswarm pools lists them`);
  if (typeof label !== 'string' || !label || /\s/.test(label)) {
    throw new Error('pool label must be non-empty and contain no spaces');
  }
  if (known.has(label) && label !== pool) {
    throw new Error(`pool label "${label}" is another pool's id`);
  }
  const labels = { ...loadPoolLabels(home) };
  const collision = Object.entries(labels).find(([id, existing]) => id !== pool && existing === label);
  if (collision) throw new Error(`pool label "${label}" is already used by ${collision[0]}`);
  labels[pool] = label;
  writeJsonAtomic(join(home, POOL_LABELS_FILE), { version: 1, labels });
  cache.set(String(home), labels);
  return { pool, poolLabel: label };
}

export function clearPoolLabel(home, pool, knownPoolIds) {
  const labels = { ...loadPoolLabels(home) };
  const known = new Set(knownPoolIds ?? []);
  if (!known.has(pool) && !Object.prototype.hasOwnProperty.call(labels, pool)) {
    throw new Error(`unknown pool "${pool}" — bullswarm pools lists them`);
  }
  const removed = labels[pool] ?? null;
  delete labels[pool];
  writeJsonAtomic(join(home, POOL_LABELS_FILE), { version: 1, labels });
  cache.set(String(home), labels);
  return { pool, poolLabel: removed, cleared: removed !== null };
}

/** Replace pool ids inside human prose, longest first to avoid prefix damage. */
export function withPoolLabels(text, home) {
  let out = String(text ?? '');
  for (const [pool, label] of Object.entries(loadPoolLabels(home)).sort((a, b) => b[0].length - a[0].length)) {
    if (pool !== label) out = out.split(pool).join(label);
  }
  return out;
}

/** Add a sibling poolLabel without changing a JSON contract's pool id. */
export function withPoolLabel(record, home, field = 'pool') {
  if (!record || typeof record !== 'object' || typeof record[field] !== 'string') return record;
  return { ...record, [`${field}Label`]: poolLabel(record[field], home) };
}

/** Test/process helper for a home whose files were replaced externally. */
export function clearPoolLabelCache(home = null) {
  if (home == null) cache.clear();
  else cache.delete(String(home));
}
