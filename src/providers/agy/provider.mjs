// bullswarm agy provider — the Google Antigravity CLI (`agy`). One login,
// two pools, one per AGY quota group:
//
//   agy         Gemini models ("Gemini Models" group). The default pool.
//   agy:claude  Claude and GPT-OSS models served through AGY ("Claude and
//               GPT models" group). Same CLI, same login.
//
// Both are metered by `agy -p /usage --output-format json`, which answers
// from AGY's own quota service without starting a model turn. Models come
// from `agy models`, whose ids carry the effort level as a suffix; discovery
// folds those into one base id with `reasoningLevels`.
//
// Bullswarm never reads ~/.gemini: the CLI owns its login. Under node --test
// neither the meter nor discovery spawns agy unless a test injects a runner.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MeterError, snapshot } from '../../provider-kit.js';
import { REASONING_LEVELS } from '../../lib/reasoning.js';
import { withPoolEnv } from '../../lib/worker-argv.js';

export const name = 'agy';
export const displayName = 'AGY';

const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'];
const USAGE_TIMEOUT_MS = 20_000;
// One `/usage` answer serves both pools: it reports every quota group.
export const USAGE_SHARE_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 20_000;

// Each pool's AGY quota group, as `/usage` names it.
const POOL_GROUPS = {
  agy: 'Gemini Models',
  'agy:claude': 'Claude and GPT models',
};

// The second pool: the template with this group's models. Everything else
// (spawn, stream, meter, credential group) is the template's.
const CLAUDE_POOL = {
  name: 'agy:claude',
  model: 'claude-sonnet-4-6',
  includePattern: '^(?:claude-|gpt-oss-)',
};

/** A failed agy meter read. Codes: no_bin, timeout, parse, no_group, cli_error, model_turn, test_guard. */
export class AgyMeterError extends MeterError {}

function regex(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

/** Whether a pool's discovery patterns keep this model id. */
function poolKeeps(pool, id) {
  const include = regex(pool?.modelDiscovery?.includePattern);
  const ignore = regex(pool?.modelDiscovery?.ignorePattern);
  return (!include || include.test(id)) && !(ignore && ignore.test(id));
}

/**
 * Whether an id's effort suffix is a level to fold: only on a pool that takes
 * `--effort` at all, and never on a model the connector skips for it
 * (`gpt-oss-120b-medium` is listed with its effort in the id).
 */
function foldsEffort(pool, id) {
  if (!pool?.reasoning) return false;
  return !(pool.reasoning.skipModels ?? []).some((pattern) => regex(pattern)?.test(id));
}

/** The pool's spawn with its default model pinned behind the model flag. */
function pinModel(spawn, flag, model) {
  const cmd = [...(spawn?.cmd ?? [])];
  const index = cmd.indexOf(flag);
  if (index >= 0 && index + 1 < cmd.length) cmd[index + 1] = model;
  else cmd.push(flag, model);
  return { ...spawn, cmd };
}

/**
 * The two pools. Each keeps only its own group's models in `knownModels`;
 * agy:claude pins its own default model and declares no reasoning, since
 * none of its models takes `--effort`.
 */
export function connectors(ctx = {}) {
  const template = ctx.template;
  if (!template) return [];
  const gemini = structuredClone(template);
  gemini.knownModels = (template.knownModels ?? []).filter((id) => poolKeeps(gemini, id));

  const claude = structuredClone(template);
  claude.name = CLAUDE_POOL.name;
  claude.model = CLAUDE_POOL.model;
  claude.modelDiscovery = {
    ...(template.modelDiscovery ?? {}),
    includePattern: CLAUDE_POOL.includePattern,
  };
  delete claude.modelDiscovery.ignorePattern;
  claude.knownModels = (template.knownModels ?? []).filter((id) => poolKeeps(claude, id));
  claude.spawn = pinModel(template.spawn, template.modelSelection?.flag ?? '--model', CLAUDE_POOL.model);
  delete claude.reasoning;
  claude.flags = { ...(template.flags ?? {}), isCaller: false };
  return [gemini, claude];
}

// --- model discovery -----------------------------------------------------------

const EFFORT_SUFFIX = new RegExp(`^(.+)-(${REASONING_LEVELS.join('|')})$`);

/**
 * `agy models` output (`<id>\t<label>` per line) as this pool's models.
 * An id ending in an effort level is folded into its base id, which lists
 * the levels it was offered at; on a pool without `--effort`, and for ids
 * the connector skips for reasoning (`gpt-oss-120b-medium`), ids are kept
 * as listed.
 */
export function parseAgyModels(output, pool) {
  const byId = new Map();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const [rawId, rawLabel] = line.split('\t');
    const id = rawId?.trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || rawLabel === undefined) continue;
    const label = rawLabel.trim();
    const suffix = foldsEffort(pool, id) ? id.match(EFFORT_SUFFIX) : null;
    const base = suffix ? suffix[1] : id;
    if (!poolKeeps(pool, base)) continue;
    const entry = byId.get(base) ?? {
      id: base,
      displayName: suffix ? label.replace(/\s*\([^)]*\)\s*$/, '') : label,
      ...(suffix ? { reasoningLevels: [] } : {}),
    };
    if (suffix && entry.reasoningLevels && !entry.reasoningLevels.includes(suffix[2])) {
      entry.reasoningLevels.push(suffix[2]);
    }
    byId.set(base, entry);
  }
  const models = [...byId.values()];
  for (const model of models) {
    if (model.reasoningLevels) {
      model.reasoningLevels = REASONING_LEVELS.filter((level) => model.reasoningLevels.includes(level));
    }
  }
  return models;
}

function underTest(env = process.env) {
  return Boolean(env?.NODE_TEST_CONTEXT);
}

function runAgy({ command, args, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: error ? error.code : 0 });
    });
    // No prompt is ever answered: a CLI that waits on stdin sees it closed.
    child.stdin?.end();
  });
}

export async function discoverModels(pool, { executor = null } = {}) {
  const command = pool?.bin ?? 'agy';
  const args = ['models'];
  const timeoutMs = Math.min(Number(pool?.modelDiscovery?.timeoutMs) || DISCOVERY_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS);
  if (!executor && underTest()) {
    throw new Error('agy model discovery is not run under node --test without an injected executor');
  }
  const run = executor ?? (async (request) => {
    const { stdout, exitCode, stderr } = await runAgy(request);
    if (exitCode !== 0) throw new Error(`agy models exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    return stdout;
  });
  const output = await run({ command, args, env: withPoolEnv(process.env, pool), timeoutMs });
  const models = parseAgyModels(typeof output === 'string' ? output : output?.stdout, pool);
  if (!models.length) throw new Error('agy models listed no model for this pool');
  return { command: [command, ...args], models };
}

// --- the usage meter ---------------------------------------------------------------

function windowFrom(bucket) {
  if (!bucket) return null;
  const remaining = Number(bucket.remaining_fraction);
  if (bucket.remaining_fraction == null || !Number.isFinite(remaining)) {
    throw new AgyMeterError(`agy /usage bucket ${bucket.id ?? '?'} has no remaining_fraction`, 'parse');
  }
  const used = Math.min(100, Math.max(0, (1 - remaining) * 100));
  const resetMs = Date.parse(bucket.reset_time ?? '');
  return {
    utilization: Math.round(used * 10) / 10,
    resets_at: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
  };
}

/**
 * The snapshot for one pool from `agy -p /usage --output-format json` output:
 * its group's 5h bucket as five_hour and weekly bucket as seven_day,
 * utilization = used share of the bucket, rounded to 0.1.
 */
export function parseAgyUsage(text, poolName = 'agy') {
  let body;
  try {
    body = JSON.parse(String(text ?? '').trim());
  } catch {
    throw new AgyMeterError('agy /usage did not print JSON', 'parse');
  }
  if (!body || typeof body !== 'object') throw new AgyMeterError('agy /usage printed no object', 'parse');
  if (body.status === 'ERROR') {
    throw new AgyMeterError(`agy /usage failed: ${String(body.error ?? 'unknown error').split('\n')[0]}`, 'cli_error');
  }
  // A meter read must never spend quota: /usage answers with no model turn.
  if (body.num_turns != null && Number(body.num_turns) !== 0) {
    throw new AgyMeterError(`agy /usage ran ${body.num_turns} model turn(s); refusing the reading`, 'model_turn');
  }
  const groups = body.command?.data?.groups;
  if (!Array.isArray(groups)) throw new AgyMeterError('agy /usage has no quota groups', 'parse');
  const wanted = POOL_GROUPS[poolName] ?? POOL_GROUPS.agy;
  const group = groups.find((entry) => String(entry?.name ?? '').toLowerCase() === wanted.toLowerCase());
  if (!group) throw new AgyMeterError(`agy /usage has no "${wanted}" group`, 'no_group');
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const fiveHour = windowFrom(buckets.find((bucket) => bucket?.window === '5h'));
  const weekly = windowFrom(buckets.find((bucket) => bucket?.window === 'weekly'));
  if (!fiveHour && !weekly) throw new AgyMeterError(`agy /usage "${wanted}" has no 5h or weekly bucket`, 'parse');
  return snapshot({
    pool: poolName,
    five_hour: fiveHour ?? undefined,
    seven_day: weekly ?? undefined,
    monthly: null,
    plan_type: null,
  });
}

// The shared `/usage` answers: runner -> (login key -> { at, result }).
// Keyed by the runner so an injected one never sees another's answer, and by
// the login (command and environment, hashed: no value is kept in clear) so
// two homes never share one.
const usageShares = new WeakMap();

function loginKey(command, env) {
  const entries = Object.entries(env ?? {}).filter(([, value]) => value != null).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([command, entries])).digest('hex');
}

/**
 * Run `agy -p /usage` once for every pool on one login: a read within
 * USAGE_SHARE_MS of an earlier one (or while it is still running) takes its
 * answer, so refreshing agy and agy:claude spawns agy once. `maxAgeMs`
 * narrows the window; 0 always spawns (the read after a quota refusal must
 * not be a reading from before it). A failed read is not kept.
 */
function sharedUsage(run, request, { maxAgeMs = USAGE_SHARE_MS, now = Date.now } = {}) {
  let shares = usageShares.get(run);
  if (!shares) usageShares.set(run, (shares = new Map()));
  const key = loginKey(request.command, request.env);
  const at = now();
  const window = Math.min(USAGE_SHARE_MS, Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs)) : USAGE_SHARE_MS);
  const forget = (entry) => () => { if (shares.get(key) === entry) shares.delete(key); };
  const held = shares.get(key);
  if (held && window > 0 && at - held.at <= window) return { result: held.result, forget: forget(held) };
  const entry = { at, result: Promise.resolve().then(() => run(request)) };
  shares.set(key, entry);
  entry.result.catch(forget(entry));
  return { result: entry.result, forget: forget(entry) };
}

/**
 * `ctx.runner` (or `ctx.opts.usageRunner`) replaces the spawn:
 * `({ command, args, env, timeoutMs }) => { stdout, stderr, exitCode }`.
 * `ctx.maxAgeMs` is the oldest shared answer the caller takes (the meter
 * registry passes 0 for a read that must be taken now); `ctx.now` the clock.
 */
export async function readUsage(pool, ctx = {}) {
  const poolName = (typeof pool === 'string' ? pool : pool?.name) ?? 'agy';
  const runner = ctx.runner ?? ctx.opts?.usageRunner ?? null;
  if (!runner && underTest()) {
    throw new AgyMeterError('the agy meter is not read under node --test without an injected runner', 'test_guard');
  }
  const command = (typeof pool === 'object' && pool?.bin) || 'agy';
  let result;
  let shared = null;
  try {
    shared = sharedUsage(runner ?? runAgy, {
      command,
      args: USAGE_ARGS,
      env: withPoolEnv(ctx.env ?? process.env, typeof pool === 'object' ? pool : null),
      timeoutMs: USAGE_TIMEOUT_MS,
    }, {
      maxAgeMs: ctx.maxAgeMs ?? USAGE_SHARE_MS,
      now: typeof ctx.now === 'function' ? ctx.now : Date.now,
    });
    result = await shared.result;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new AgyMeterError('agy is not on PATH', 'no_bin');
    if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      throw new AgyMeterError(`agy /usage took longer than ${USAGE_TIMEOUT_MS / 1000} s`, 'timeout');
    }
    throw new AgyMeterError(`agy /usage could not run: ${error?.message ?? error}`, 'cli_error');
  }
  if (result?.exitCode != null && result.exitCode !== 0) {
    shared.forget();
    try {
      const body = JSON.parse(String(result?.stdout ?? '').trim());
      if (body && typeof body === 'object' && body.status === 'ERROR') {
        throw new AgyMeterError(`agy /usage failed: ${String(body.error ?? 'unknown error').split('\n')[0]}`, 'cli_error');
      }
    } catch (error) {
      if (error instanceof AgyMeterError) throw error;
    }
    const detail = String(result?.stderr || result?.stdout || '').trim().split(/\r?\n/)[0];
    throw new AgyMeterError(`agy /usage exited ${result.exitCode}${detail ? `: ${detail}` : ''}`, 'cli_error');
  }
  // An answer that does not parse is not shared: the next read spawns again.
  try {
    return parseAgyUsage(result?.stdout, poolName);
  } catch (error) {
    if (error?.code !== 'no_group') shared.forget();
    throw error;
  }
}
