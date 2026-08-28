import { loadState, saveState } from './lib/state.js';
import { loadConnectors, buildPoolsLive } from './lib/config.js';
import { getAllMeterReadings } from './meters/registry.js';
import { discoverAllModels, buildStrategy } from './lib/strategy.js';
import { normalizeExcludedModels } from './lib/strategy.js';

function parseFlags(argv) {
  const flags = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { flags.rest.push(token); continue; }
    const [raw, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[raw] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[raw] = argv[++i];
    else flags[raw] = true;
  }
  return flags;
}

function numberOrNull(value, label) {
  if (value === undefined) return undefined;
  if (value === 'unknown' || value === 'null') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number or unknown`);
  return n;
}

function refreshHoursValue(value) {
  const hours = Number(value ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('refresh-hours must be a positive number');
  return hours;
}

function render(report) {
  const lines = [`bullswarm strategy · ${report.capturedAt}`, '', 'subscriptions:'];
  for (const sub of report.subscriptions) {
    const value = sub.monthlyPriceUsd == null || sub.includedValueUsd == null
      ? 'value unknown'
      : `$${sub.monthlyPriceUsd}/mo → ~$${sub.includedValueUsd} included (${sub.valueMultiple}×)`;
    lines.push(`  ${sub.pool}: ${sub.plan ?? 'plan unknown'} · ${value} · ${sub.usedPct ?? '?'}% used · surplus ${sub.surplus ?? '?'}`);
  }
  lines.push('', 'tier suggestions:');
  for (const [tier, suggestion] of Object.entries(report.suggestions)) {
    const selected = suggestion.assignment ?? suggestion.recommended;
    lines.push(`  ${tier}: ${selected ? `${selected.pool}/${selected.model}` : 'no classified model'}${suggestion.assignment ? ' (assigned)' : ' (recommended)'}`);
    lines.push(`    ${suggestion.basis}`);
  }
  lines.push('', `excluded models: ${report.excludedModels?.length ? report.excludedModels.join(', ') : 'none'}`);
  lines.push('', 'Use --json for models, pricing sources, benchmarks, and caveats.');
  return lines.join('\n');
}

function strategyUsage() {
  return `usage: bullswarm strategy <command> [options]

commands:
  refresh [--json]                         discover models and recommend tiers
  refresh --apply --yes [--refresh-hours] discover, approve, and enable refresh
  apply --yes [--refresh-hours <n>]        approve the last recommendations
  auto status                              inspect the approved refresh policy
  auto off --yes                           disable automatic re-application
  show [--json]                            show the last strategy report
  assign <high|medium|low> --pool --model  set one explicit preference
  clear-assignment <tier>                  remove one preference
  exclude-model <model>                    prevent this model from any dispatch
  include-model <model>                    remove a model exclusion
  set-subscription <pool> [value flags]    record user-known plan economics`;
}

export async function refreshStrategy(bullswarmDir, { executor, getReadings = getAllMeterReadings } = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const { pools } = await buildPoolsLive(bullswarmDir, Date.now(), {
    getReadings,
  });
  const discoveries = discoverAllModels(connectors, executor ? { executor } : {});
  const report = buildStrategy({ connectors, pools, state, discoveries });
  state.strategy ??= {};
  state.strategy.lastReport = report;
  state.strategy.lastRefreshedAt = report.capturedAt;
  saveState(bullswarmDir, state);
  return report;
}

export function applyStrategyRecommendations(bullswarmDir, report, {
  refreshHours = 24, enableAutoRefresh = true,
} = {}) {
  const approvedRefreshHours = enableAutoRefresh ? refreshHoursValue(refreshHours) : null;
  const state = loadState(bullswarmDir);
  state.strategy ??= {};
  state.strategy.assignments ??= {};
  const applied = {};
  for (const tier of ['high', 'medium', 'low']) {
    const recommended = report?.suggestions?.[tier]?.recommended ?? null;
    if (!recommended) continue;
    state.strategy.assignments[tier] = { ...recommended };
    applied[tier] = { ...recommended };
  }
  state.strategy.policy = {
    ...(state.strategy.policy ?? {}),
    autoApplyRecommendations: enableAutoRefresh,
    refreshHours: approvedRefreshHours,
    approvedAt: new Date().toISOString(),
    source: 'explicit-user-approval',
  };
  state.strategy.lastAppliedAt = new Date().toISOString();
  // Keep the persisted report aligned with the assignments just applied.
  if (report) {
    for (const tier of ['high', 'medium', 'low']) {
      if (report.suggestions?.[tier]) report.suggestions[tier].assignment = applied[tier] ?? null;
    }
    state.strategy.lastReport = report;
  }
  saveState(bullswarmDir, state);
  return { applied, policy: state.strategy.policy };
}

export async function maybeRefreshStrategy(bullswarmDir, opts = {}) {
  const state = loadState(bullswarmDir);
  const policy = state.strategy?.policy ?? {};
  if (policy.autoApplyRecommendations !== true) return null;
  try {
    const hours = refreshHoursValue(policy.refreshHours);
    const captured = Date.parse(state.strategy?.lastRefreshedAt ?? '');
    const stale = !Number.isFinite(captured) || (Date.now() - captured) >= hours * 3600_000;
    if (!stale) return null;
    const report = await refreshStrategy(bullswarmDir, opts);
    return {
      report,
      ...applyStrategyRecommendations(bullswarmDir, report, { refreshHours: hours }),
    };
  } catch (err) {
    // Discovery is advisory and must never turn an otherwise routable run into
    // an outage. Keep the last approved assignments and expose the failure.
    const failed = loadState(bullswarmDir);
    failed.strategy ??= {};
    failed.strategy.policy ??= policy;
    failed.strategy.policy.lastRefreshErrorAt = new Date().toISOString();
    failed.strategy.policy.lastRefreshError = err.message;
    saveState(bullswarmDir, failed);
    return { error: err.message, retainedAssignments: failed.strategy.assignments ?? {} };
  }
}

export async function cmdStrategy(args, { bullswarmDir }) {
  const [sub = 'show', ...rest] = args;
  const opts = parseFlags(rest);
  try {
    if (sub === 'help' || sub === '--help' || opts.help) {
      console.log(strategyUsage());
      return 0;
    }
    if (sub === 'refresh' || sub === 'recommend') {
      if (opts.apply && opts.yes !== true) throw new Error('--apply changes routing; pass --yes to approve');
      const report = await refreshStrategy(bullswarmDir);
      const applied = opts.apply
        ? applyStrategyRecommendations(bullswarmDir, report, {
          refreshHours: refreshHoursValue(opts['refresh-hours']),
        }) : null;
      console.log(opts.json ? JSON.stringify(applied ? { report, ...applied } : report, null, 2) : render(report));
      return 0;
    }
    if (sub === 'show') {
      const state = loadState(bullswarmDir);
      const report = state.strategy?.lastReport ?? await refreshStrategy(bullswarmDir);
      console.log(opts.json ? JSON.stringify(report, null, 2) : render(report));
      return 0;
    }
    if (sub === 'set-subscription') {
      const pool = opts.rest[0];
      if (!pool) throw new Error('usage: bullswarm strategy set-subscription <pool> [--plan name] [--monthly-usd n] [--included-usd n] [--quota-window name]');
      const connectors = loadConnectors(bullswarmDir);
      if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
      const state = loadState(bullswarmDir);
      state.strategy ??= {};
      state.strategy.subscriptions ??= {};
      const current = state.strategy.subscriptions[pool] ?? {};
      const monthlyPriceUsd = numberOrNull(opts['monthly-usd'], 'monthly-usd');
      const includedValueUsd = numberOrNull(opts['included-usd'], 'included-usd');
      state.strategy.subscriptions[pool] = {
        ...current,
        ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
        ...(monthlyPriceUsd !== undefined ? { monthlyPriceUsd } : {}),
        ...(includedValueUsd !== undefined ? { includedValueUsd } : {}),
        ...(opts['quota-window'] !== undefined ? { quotaWindow: opts['quota-window'] } : {}),
      };
      delete state.strategy.lastReport;
      saveState(bullswarmDir, state);
      console.log(JSON.stringify({ action: 'subscription-updated', pool, subscription: state.strategy.subscriptions[pool] }, null, 2));
      return 0;
    }
    if (sub === 'assign') {
      const tier = opts.rest[0];
      if (!['high', 'medium', 'low'].includes(tier)) throw new Error('usage: bullswarm strategy assign <high|medium|low> --pool <pool> --model <model>');
      if (!opts.pool || !opts.model) throw new Error('assignment needs --pool and --model');
      const connectors = loadConnectors(bullswarmDir);
      if (!connectors[opts.pool]) throw new Error(`unknown pool "${opts.pool}"`);
      const state = loadState(bullswarmDir);
      state.strategy ??= {};
      state.strategy.assignments ??= {};
      state.strategy.assignments[tier] = { pool: opts.pool, model: opts.model };
      delete state.strategy.lastReport;
      saveState(bullswarmDir, state);
      console.log(JSON.stringify({ action: 'tier-assigned', tier, assignment: state.strategy.assignments[tier] }, null, 2));
      return 0;
    }
    if (sub === 'exclude-model' || sub === 'include-model') {
      const model = opts.rest[0];
      if (!model) throw new Error(`usage: bullswarm strategy ${sub} <model>`);
      const state = loadState(bullswarmDir);
      state.strategy ??= {};
      const current = normalizeExcludedModels(state.strategy.excludedModels);
      const normalized = String(model).trim().toLowerCase();
      state.strategy.excludedModels = sub === 'exclude-model'
        ? normalizeExcludedModels([...current, normalized])
        : current.filter((entry) => entry !== normalized);
      delete state.strategy.lastReport;
      saveState(bullswarmDir, state);
      console.log(JSON.stringify({
        action: sub === 'exclude-model' ? 'model-excluded' : 'model-included',
        model: normalized,
        excludedModels: state.strategy.excludedModels,
      }, null, 2));
      return 0;
    }
    if (sub === 'apply') {
      if (opts.yes !== true) throw new Error('strategy apply changes routing; pass --yes to approve');
      const state = loadState(bullswarmDir);
      const report = state.strategy?.lastReport ?? await refreshStrategy(bullswarmDir);
      const result = applyStrategyRecommendations(bullswarmDir, report, {
        refreshHours: refreshHoursValue(opts['refresh-hours']),
      });
      console.log(JSON.stringify({ action: 'strategy-applied', ...result }, null, 2));
      return 0;
    }
    if (sub === 'auto') {
      const mode = opts.rest[0] ?? 'status';
      const state = loadState(bullswarmDir);
      state.strategy ??= {};
      state.strategy.policy ??= {};
      if (mode === 'off') {
        if (opts.yes !== true) throw new Error('strategy auto off changes routing policy; pass --yes to approve');
        state.strategy.policy.autoApplyRecommendations = false;
        state.strategy.policy.disabledAt = new Date().toISOString();
        saveState(bullswarmDir, state);
      } else if (mode !== 'status') {
        throw new Error('usage: bullswarm strategy auto <status|off> [--yes]');
      }
      console.log(JSON.stringify({ action: 'strategy-auto', policy: state.strategy.policy }, null, 2));
      return 0;
    }
    if (sub === 'clear-assignment') {
      const tier = opts.rest[0];
      if (!['high', 'medium', 'low'].includes(tier)) throw new Error('usage: bullswarm strategy clear-assignment <high|medium|low>');
      const state = loadState(bullswarmDir);
      if (state.strategy?.assignments) delete state.strategy.assignments[tier];
      delete state.strategy?.lastReport;
      saveState(bullswarmDir, state);
      console.log(JSON.stringify({ action: 'tier-assignment-cleared', tier }, null, 2));
      return 0;
    }
    throw new Error(strategyUsage());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    const usage = /^(usage:|missing |assignment needs |--apply changes|strategy (?:apply|auto off) changes|refresh-hours must be|.* must be a non-negative number|unknown phase|unknown command|unknown pool)/i.test(err.message);
    return usage ? 2 : 1;
  }
}
