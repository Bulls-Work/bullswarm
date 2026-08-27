import { loadState, saveState } from './lib/state.js';
import { loadConnectors, buildPoolsLive } from './lib/config.js';
import { getAllMeterReadings } from './meters/registry.js';
import { discoverAllModels, buildStrategy } from './lib/strategy.js';

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
  lines.push('', 'Use --json for models, pricing sources, benchmarks, and caveats.');
  return lines.join('\n');
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

export async function cmdStrategy(args, { bullswarmDir }) {
  const [sub = 'show', ...rest] = args;
  const opts = parseFlags(rest);
  try {
    if (sub === 'refresh' || sub === 'recommend') {
      const report = await refreshStrategy(bullswarmDir);
      console.log(opts.json ? JSON.stringify(report, null, 2) : render(report));
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
    throw new Error('usage: bullswarm strategy <show|refresh|recommend|set-subscription|assign|clear-assignment>');
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}
