// Published plan prices and operator-declared subscription economics.
//
// This module is intentionally offline. A plan price is money, so an absent
// or malformed source is represented by null rather than a guessed number.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAN_PRICES_SCHEMA = 'bullswarm.plan-prices.v1';
const DEFAULT_FILE = fileURLToPath(new URL('../../data/plan-prices.json', import.meta.url));
const cache = new Map();

/**
 * The month length every pro-rated subscription amount is divided by.
 *
 * 30.4375 is the average Gregorian month — 365.25 / 12 — so a monthly price
 * spread over a window returns the whole price when twelve windows of one
 * month's days are summed. A flat 30-day month is 1.4% short: it prices a
 * week 1.4% high, every week. One exported constant, so every surface
 * (prices.js, subscription-cost.js, the Budget model) divides by the same
 * number instead of each carrying its own month.
 */
export const DAYS_PER_MONTH = 30.4375;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegative(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sourceValue(source) {
  if (typeof source === 'string') return source;
  if (object(source)) return source.url ?? source.href ?? source.name ?? null;
  return null;
}

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function planKey(provider, plan) {
  const p = textValue(provider);
  const n = textValue(plan);
  return p && n ? `${p}:${n}` : null;
}

function planKeyVariants(provider, plan) {
  const p = textValue(provider);
  const n = textValue(plan);
  if (!p || !n) return [];
  const out = new Set();
  const add = (value) => {
    const text = textValue(value);
    if (!text) return;
    out.add(text);
    out.add(text.toLowerCase());
    out.add(text.toLowerCase().replace(/\s+/g, '-'));
    out.add(text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
    out.add(text.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  };
  add(planKey(p, n));
  // The credentials and usage readers use a few different spellings for the
  // same human plan. Keep lookup aliases here rather than teaching each
  // provider about the shape of the bundled table.
  const lower = n.toLowerCase();
  const max = lower.match(/max[^0-9]*(5|10|20)\s*x?/i);
  if (max) {
    const tier = max[1];
    add(planKey(p, `max${tier}x`));
    add(planKey(p, `max ${tier}x`));
    add(planKey(p, `max_${tier}x`));
    add(planKey(p, `default_${p.replace(/[^a-z0-9]+/gi, '_')}_max_${tier}x`));
  }
  const teamsPro = /\bteams?[\s_-]+pro\b/i.test(n);
  if (teamsPro) add(planKey(p, 'team pro'));
  if (/default_claude_pro/i.test(n) || (!teamsPro && /claude_pro|\bpro\b/i.test(n))) {
    add(planKey(p, 'pro'));
  }
  const codexPro = lower.match(/\bpro[^0-9]*(100|200)\b/i);
  if (codexPro) {
    add(planKey(p, `pro ${codexPro[1]}`));
    add(planKey(p, `pro${codexPro[1]}`));
  }
  if (/\bplus\b/i.test(n)) add(planKey(p, 'plus'));
  if (/\bfree\b/i.test(n)) add(planKey(p, 'free'));
  return [...out];
}

function updatedAtValue(source) {
  return object(source) ? source.updatedAt ?? source.retrievedAt ?? null : null;
}

function tableEntries(table) {
  if (!object(table)) return {};
  for (const key of ['prices', 'plans', 'pools', 'subscriptions', 'entries']) {
    if (object(table[key])) return table[key];
    if (Array.isArray(table[key])) {
      return Object.fromEntries(table[key]
        .filter((entry) => object(entry) && (entry.pool ?? entry.name ?? entry.id))
        .map((entry) => [entry.pool ?? entry.name ?? entry.id, entry]));
    }
  }
  // A small custom table may use pool names at the top level. Do not mistake
  // metadata for a plan record.
  const metadata = new Set(['schemaVersion', 'source', 'updatedAt', 'basis', 'notes', 'missingReason']);
  return Object.fromEntries(Object.entries(table).filter(([key, value]) => (
    !metadata.has(key) && object(value)
  )));
}

function planEntries(table) {
  if (!object(table?.plans)) return {};
  const out = {};
  for (const [provider, value] of Object.entries(table.plans)) {
    if (!object(value)) continue;
    // Accept both a flat `provider:plan` map and a provider → plan map. The
    // latter is easier for people to author; the former keeps lookups
    // explicit in JSON diffs.
    const nested = Object.entries(value).some(([, entry]) => object(entry)
      || entry === null || typeof entry === 'number' || typeof entry === 'string');
    if (nested && !provider.includes(':')) {
      for (const [plan, entry] of Object.entries(value)) {
        if (object(entry) || entry === null || typeof entry === 'number' || typeof entry === 'string') {
          const key = planKey(provider, plan);
          out[key] = entry;
          out[key.toLowerCase()] = entry;
        }
      }
    } else {
      out[provider] = value;
      out[provider.toLowerCase()] = value;
    }
  }
  return out;
}

function fileKey(file) {
  return file ? resolve(String(file)) : DEFAULT_FILE;
}

/**
 * Load the bundled plan-price table once per file path. A custom file is
 * useful for an operator or a fixture; it is still parsed without network
 * access. An absent or malformed file returns null so callers can render an
 * explicit missing-price reason.
 */
export function planPrices({ file = null } = {}) {
  const path = fileKey(file);
  let fingerprint = null;
  try {
    const stat = statSync(path);
    fingerprint = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = cache.get(path);
  if (cached?.fingerprint === fingerprint) return cached.value;
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(value)) return null;
    if (value.schemaVersion != null && value.schemaVersion !== PLAN_PRICES_SCHEMA) return null;
    cache.set(path, { fingerprint, value });
    return value;
  } catch {
    return null;
  }
}

function resolvedPrice(record, { source = null, updatedAt = null, basis = null } = {}) {
  if (!object(record)) return null;
  const monthlyPriceUsd = nonNegative(record.monthlyPriceUsd);
  // No monthly price means there is no subscription-rate amount to return.
  // `includedValueUsd` by itself is not a price and must not become a guess.
  if (monthlyPriceUsd == null) return null;
  const includedValueUsd = nonNegative(record.includedValueUsd);
  const value = {
    monthlyPriceUsd,
    includedValueUsd,
    source: sourceValue(record.source) ?? source,
    updatedAt: record.updatedAt ?? updatedAtValue(record.source) ?? updatedAt ?? null,
    basis: record.basis ?? basis ?? 'declared monthly subscription price',
  };
  // Plan records carry stronger provenance than the legacy `prices` table.
  // Keep those fields when present, while preserving the old return shape for
  // callers and fixtures that only have source/updatedAt.
  if (Object.hasOwn(record, 'quotedLine')) value.quotedLine = textValue(record.quotedLine);
  if (Object.hasOwn(record, 'checkedAt')) value.checkedAt = textValue(record.checkedAt);
  if (Object.hasOwn(record, 'plan')) value.plan = textValue(record.plan);
  if (Object.hasOwn(record, 'provider')) value.provider = textValue(record.provider);
  return value;
}

function hasPriceOverride(record) {
  return object(record) && (
    Object.prototype.hasOwnProperty.call(record, 'monthlyPriceUsd')
    || Object.prototype.hasOwnProperty.call(record, 'includedValueUsd')
  );
}

/**
 * Resolve one pool's monthly subscription economics. State overrides are
 * checked first, including an explicit null (which intentionally suppresses
 * a table value). Otherwise the bundled published table is consulted.
 */
export function priceFor(pool, { subscriptions = {}, file = null } = {}) {
  const name = typeof pool === 'string'
    ? pool.trim()
    : String(pool?.name ?? pool?.pool ?? '').trim();
  if (!name) return null;
  const override = subscriptions?.[name];
  if (hasPriceOverride(override)) {
    const declared = resolvedPrice(override, {
      source: sourceValue(override?.source) ?? 'user-declared',
      updatedAt: override?.updatedAt ?? null,
      basis: override?.basis ?? 'state.strategy.subscriptions override',
    });
    // An explicit override with no monthly amount is an intentional unknown;
    // do not silently replace it with a bundled pool-table figure.
    return declared;
  }

  const table = planPrices({ file });
  const entry = tableEntries(table)[name];
  return resolvedPrice(entry, {
    source: sourceValue(entry?.source) ?? sourceValue(table?.source),
    updatedAt: entry?.updatedAt ?? updatedAtValue(entry?.source)
      ?? table?.updatedAt ?? updatedAtValue(table?.source) ?? null,
    basis: entry?.basis ?? table?.basis ?? 'published plan price',
  });
}

// The plan table is keyed by PROVIDER, never by pool: `claude-code:max 5x`,
// not `claude-code:acme:max 5x`. A discovered per-account clone carries its
// full pool name on `connector.name` (`claude-code:acme`), so every candidate
// is cut at the first colon — without this, the pools where a detected plan
// matters most (one login per account) silently lost their price.
function providerOf(value) {
  const text = textValue(value);
  return text ? text.split(':', 1)[0] : null;
}

function providerNameOf(pool, explicit = null) {
  const supplied = providerOf(explicit);
  if (supplied) return supplied;
  if (pool && typeof pool === 'object') {
    const provider = providerOf(
      pool.connector?.profile?.providerId
      ?? pool.provider ?? pool.providerName ?? pool.connector?.name,
    );
    if (provider) return provider;
  }
  return providerOf(typeof pool === 'string' ? pool : pool?.name ?? pool?.pool);
}

function planNamesOf(value) {
  const source = value && typeof value === 'object' ? value : {};
  const snapshot = source.meterSnapshot ?? source.snapshot ?? {};
  const candidates = [
    source.detectedPlan,
    source.planName,
    source.plan_name,
    snapshot.plan_name,
    snapshot.planName,
    source.plan_type,
    source.planType,
    snapshot.plan_type,
    snapshot.planType,
  ];
  const detected = candidates.map(textValue).find(Boolean);
  return detected ? [detected] : [];
}

/**
 * Resolve a published monthly price for a provider-reported plan. The plan
 * table is deliberately offline: a missing or malformed record remains null.
 * `plan` may be a single name, an array, or a pool object carrying the meter
 * snapshot metadata.
 */
export function planPriceFor(provider, plan, { file = null } = {}) {
  const providerName = providerNameOf(provider);
  // A caller may pass the historical candidate-array shape, but only its
  // first detected billing plan is authoritative. Later values are commonly
  // subscription_type or rate_limit_tier usage metadata and must not select a
  // different consumer price for a team or enterprise seat.
  const candidates = Array.isArray(plan) ? plan : [plan];
  const plans = [];
  for (const entry of candidates) {
    const detected = entry && typeof entry === 'object' ? planNamesOf(entry)[0] : textValue(entry);
    if (detected) {
      plans.push(detected);
      break;
    }
  }
  if (!providerName || !plans.length) return null;
  const table = planPrices({ file });
  const entries = planEntries(table);
  for (const candidate of plans) {
    for (const key of planKeyVariants(providerName, candidate)) {
      const record = entries[key] ?? entries[key.toLowerCase()];
      const resolved = resolvedPrice(record, {
        source: sourceValue(record?.source) ?? sourceValue(table?.source),
        updatedAt: record?.updatedAt ?? updatedAtValue(record?.source)
          ?? table?.updatedAt ?? updatedAtValue(table?.source) ?? null,
        basis: record?.basis ?? `published ${providerName} plan price`,
      });
      if (resolved) {
        return {
          ...resolved,
          plan: textValue(record?.plan) ?? textValue(candidate),
          provider: providerName,
        };
      }
    }
  }
  return null;
}

/**
 * Pro-rate a declared monthly price over a window using the shared
 * DAYS_PER_MONTH length. Accepts either the object returned by priceFor or a
 * monthly numeric value for small model callers.
 */
export function subscriptionCostUsd(price, { days = 7 } = {}) {
  const monthlyPriceUsd = nonNegative(object(price) ? price.monthlyPriceUsd : price);
  const windowDays = nonNegative(days);
  if (monthlyPriceUsd == null || windowDays == null) return null;
  return Math.round((monthlyPriceUsd * windowDays / DAYS_PER_MONTH) * 1e8) / 1e8;
}
