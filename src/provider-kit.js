// bullswarm provider kit — the helpers a provider.mjs builds pools and meter
// readings with. Also importable as `bullswarm/provider-kit`; a provider
// OUTSIDE the package cannot resolve that bare specifier and must use the
// `ctx.kit` object the loader hands every method (src/lib/providers.js).
//
// Doctrine:
//   K1. Vendor-neutral. Nothing here names a CLI, a host or a plan; a
//       provider supplies every vendor fact.
//   K2. Pure and synchronous except bearerJson, which is the one network
//       helper and reports failure as a MeterError, never a raw TypeError.
//   K3. Zero dependencies.

export { REASONING_LEVELS } from './lib/reasoning.js';
import { REASONING_LEVELS } from './lib/reasoning.js';
import { retryAfterMsFromHeaders } from './meters/framework.js';

/** A meter failure. `code` is informational; the core never branches on it. */
export class MeterError extends Error {
  constructor(message, code, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'MeterError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Put `model` behind `flag` in an argv template: replace the value after an
 * existing flag, else insert `flag model` before `{taskFile}` (or at the end
 * when the template has no task placeholder).
 */
function retargetModelFlag(cmd, flag, model) {
  const argv = [...(cmd ?? [])];
  const index = argv.indexOf(flag);
  if (index >= 0) {
    if (index + 1 < argv.length) argv[index + 1] = model;
    else argv.push(model);
    return argv;
  }
  const taskIndex = argv.indexOf('{taskFile}');
  argv.splice(taskIndex >= 0 ? taskIndex : argv.length, 0, flag, model);
  return argv;
}

/**
 * A new pool from a template: a deep copy, `overrides` shallow-merged over it,
 * never the caller pool, and — when `overrides.model` is given — the model
 * pinned in spawn.cmd through the template's `modelSelection.flag` (default
 * `--model`, replace-or-append), so the argv and `pool.model` agree.
 *
 * @param {object} template  a connector.json object, e.g. ctx.templates.opencode2
 * @param {object} [overrides]
 * @returns {object}
 */
export function clonePool(template, overrides = {}) {
  if (!template || typeof template !== 'object') {
    throw new TypeError('clonePool needs a template object');
  }
  const pool = { ...structuredClone(template), ...structuredClone(overrides ?? {}) };
  pool.flags = { ...(pool.flags ?? {}), isCaller: false };
  if (typeof overrides?.model === 'string' && overrides.model !== '' && pool.spawn?.cmd) {
    const flag = template.modelSelection?.flag || '--model';
    pool.spawn = { ...pool.spawn, cmd: retargetModelFlag(pool.spawn.cmd, flag, overrides.model) };
  }
  return pool;
}

/**
 * The OPENCODE_CONFIG_CONTENT value declaring every REASONING_LEVEL as a
 * variant on each listed model of one opencode provider id.
 *
 * opencode's `--variant <level>` only reaches the API when the config declares
 * that variant for that model; OPENCODE_CONFIG_CONTENT is merged OVER the
 * config file, so the file's own provider keys (including the API key) stay in
 * force. `models` is one id or a list; blank entries are dropped.
 *
 * @returns {string} e.g. {"provider":{"a":{"models":{"m":{"variants":{"low":{"reasoningEffort":"low"},…}}}}}}
 */
export function opencodeVariants(providerId, models) {
  const ids = (Array.isArray(models) ? models : [models])
    .filter((id) => typeof id === 'string' && id.trim() !== '');
  const entries = {};
  for (const id of ids) {
    const variants = {};
    for (const level of REASONING_LEVELS) variants[level] = { reasoningEffort: level };
    entries[id] = { variants };
  }
  return JSON.stringify({ provider: { [providerId]: { models: entries } } });
}

/**
 * GET a JSON endpoint with a bearer token.
 * Throws MeterError: `network` (fetch rejected), `http` (non-2xx; the message
 * carries the status), `parse` (body is not JSON). The token never appears in
 * a message.
 */
export async function bearerJson(url, token, { headers } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new MeterError(`Network error reaching ${url}: ${err?.message ?? err}`, 'network');
  }
  if (!res.ok) {
    throw new MeterError(`${url} returned ${res.status}`, 'http', {
      status: res.status,
      retryAfterMs: retryAfterMsFromHeaders(res.headers),
    });
  }
  try {
    return await res.json();
  } catch (err) {
    throw new MeterError(`Failed to parse ${url} response: ${err?.message ?? err}`, 'parse');
  }
}

const EMPTY_WINDOW = () => ({ utilization: null, resets_at: null });

/**
 * A meter snapshot in the shape pacing and display read: `captured_at` filled,
 * each absent window as `{ utilization: null, resets_at: null }`. Optional
 * fields (`monthly_quota`, `plan_type`, `used_usd`, anything else) pass
 * through only when given.
 */
export function snapshot({ pool, five_hour, seven_day, monthly, ...rest } = {}) {
  const out = {
    captured_at: new Date().toISOString(),
    pool: pool ?? null,
    five_hour: five_hour ?? EMPTY_WINDOW(),
    seven_day: seven_day ?? EMPTY_WINDOW(),
    monthly: monthly ?? EMPTY_WINDOW(),
  };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** used/cap as 0..100, clamped; null when cap is not a positive number or used is not a number. */
export function pct(used, cap) {
  const u = Number(used);
  const c = Number(cap);
  if (used == null || cap == null || !Number.isFinite(u) || !Number.isFinite(c) || c <= 0) return null;
  return Math.max(0, Math.min(100, (u / c) * 100));
}
