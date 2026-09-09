import { loadState, updateState } from './lib/state.js';
import { loadConnectors, buildPools, buildPoolsLive } from './lib/config.js';
import { getAllMeterReadings } from './meters/registry.js';
import {
  discoverAllModels, buildStrategy, normalizeExcludedModels, resolveDispatchModel,
  selectedModelsForTier, setModelTierSelection, STRATEGY_TIERS,
  disabledModelsForPool, setModelDisabled,
  getStrategyReasoning, setStrategyReasoning, clearStrategyReasoning,
  reasoningEffective, assertReasoningTier, assertReasoningLevel,
  rungsFor, setRung, configuredModel, formatRungEvidence,
  TIER_LANES, clearTierAssignment,
} from './lib/strategy.js';
import { isReasoningLevel, REASONING_LEVELS, resolveReasoningLevel } from './lib/reasoning.js';
import { pickPool } from './lib/route.js';
import { attachForecast, inflightPenaltyFrom } from './lib/forecast.js';
import { expectedMinutesFor } from './lib/spend.js';
import { helpText, usageLine } from './help.js';
import { flagName, unknownFlagExit } from './lib/cli-flags.js';
import { startStrategyDashboard } from './strategy-dashboard.js';
import { loadOpenRouterCatalog } from './lib/openrouter-models.js';
import { loadEpochBenchmarks, rungEvidence } from './lib/epoch-benchmarks.js';

function parseFlags(argv) {
  const flags = { rest: [], _flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { flags.rest.push(token); continue; }
    const seen = flagName(token);
    if (seen && !flags._flags.includes(seen)) flags._flags.push(seen);
    const [raw, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[raw] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[raw] = argv[++i];
    else flags[raw] = true;
  }
  return flags;
}

// The help path whose usage line explains this strategy verb, or null when
// the verb has no help node — cmdStrategy already answers those with the full
// command list and exit 2.
function strategyHelpPath(sub, opts) {
  if (sub === 'auto') {
    const mode = opts.rest[0];
    return ['status', 'off'].includes(mode) ? ['strategy', 'auto', mode] : ['strategy', 'auto'];
  }
  const LEAVES = [
    'tui', 'inventory', 'routes', 'set-provider', 'set-model', 'reset-tier',
    'set-reasoning', 'rungs', 'set-rung', 'reset-reasoning', 'configure',
    'refresh', 'recommend', 'apply', 'show', 'assign', 'clear-assignment',
    'exclude-model', 'include-model', 'set-subscription',
  ];
  return LEAVES.includes(sub) ? ['strategy', sub] : null;
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

function render(report, reasoning = null) {
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
  if (reasoning) lines.push('', ...reasoningLines(reasoning));
  lines.push('', 'Use --json for models, pricing sources, benchmarks, and caveats.');
  return lines.join('\n');
}

// Reasoning depth is a routing fact, so the human report states both what the
// user configured and what each pool would actually receive — a configured
// level a CLI cannot express is visible here, not only in --json.
function reasoningLines(reasoning) {
  // A null level means two different things: the CLI takes no reasoning flag,
  // or someone answered `default` on purpose. Say which.
  const configured = (pool, tier) => reasoning.pools?.[pool]?.[tier] ?? reasoning.tiers?.[tier] ?? null;
  const cell = (pool, tier, entry) => {
    const source = entry?.source ?? 'none';
    if (entry?.level) return `${entry.level} (${source})`;
    if (configured(pool, tier) === 'default' && source !== 'unsupported' && source !== 'skipped-model') {
      return `CLI decides (${source})`;
    }
    return `\u2014 (${source})`;
  };
  const lines = ['reasoning levels:'];
  lines.push(`  configured tiers: ${STRATEGY_TIERS
    .map((tier) => `${tier}=${reasoning.tiers?.[tier] ?? 'connector default'}`).join(' \u00b7 ')}`);
  for (const [pool, tiers] of Object.entries(reasoning.pools ?? {})) {
    lines.push(`  ${pool} override: ${STRATEGY_TIERS.filter((tier) => tiers[tier])
      .map((tier) => `${tier}=${tiers[tier]}`).join(' \u00b7 ')}`);
  }
  const width = Math.max(0, ...Object.keys(reasoning.effective ?? {}).map((pool) => pool.length));
  for (const [pool, tiers] of Object.entries(reasoning.effective ?? {})) {
    lines.push(`  ${pool.padEnd(width)}  ${STRATEGY_TIERS
      .map((tier) => `${tier}=${cell(pool, tier, tiers[tier])}`).join(' \u00b7 ')}`);
  }
  return lines;
}

function reasoningReport(bullswarmDir) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const pools = Object.values(connectors)
    .map((connector) => ({ name: connector.name, connector }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...getStrategyReasoning(state.strategy),
    effective: reasoningEffective(pools, state.strategy ?? {}),
  };
}

// An agent-authored strategy document is validated in full before anything is
// written, so a typo in one tier cannot leave half a policy applied. `null`
// removes a level, which is how a document expresses "back to the default".
function validateReasoningSection(section, connectors) {
  if (section == null) return null;
  const levels = [...REASONING_LEVELS, 'default'].join(', ');
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error('reasoning must be an object with optional tiers and pools maps');
  }
  const tierMap = (value, label) => {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must map high, medium, or low to a reasoning level`);
    }
    const out = {};
    for (const [tier, level] of Object.entries(value)) {
      if (!STRATEGY_TIERS.includes(tier)) {
        throw new Error(`${label}.${tier} is not an effort tier (${STRATEGY_TIERS.join(', ')})`);
      }
      if (level === null) { out[tier] = null; continue; }
      if (!isReasoningLevel(level)) throw new Error(`${label}.${tier} must be ${levels}`);
      out[tier] = level;
    }
    return out;
  };
  const pools = {};
  if (section.pools != null) {
    if (typeof section.pools !== 'object' || Array.isArray(section.pools)) {
      throw new Error('reasoning.pools must map a pool name to its tier levels');
    }
    for (const [pool, value] of Object.entries(section.pools)) {
      if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
      pools[pool] = tierMap(value, `reasoning.pools.${pool}`);
    }
  }
  return { tiers: tierMap(section.tiers, 'reasoning.tiers'), pools };
}

function applyReasoningSection(strategy, reasoning) {
  if (!reasoning) return;
  for (const [tier, level] of Object.entries(reasoning.tiers)) {
    setStrategyReasoning(strategy, { tier, level, pool: null });
  }
  for (const [pool, tiers] of Object.entries(reasoning.pools)) {
    for (const [tier, level] of Object.entries(tiers)) {
      setStrategyReasoning(strategy, { tier, level, pool });
    }
  }
}

function reasoningFlag(value, sub) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`usage: ${usageLine(['strategy', sub])}`);
  return value.trim().toLowerCase();
}

function strategyUsage() {
  return helpText(['strategy']);
}

// The synopsis is never hand-typed here: src/help.js owns it and the drift
// guard in tests/help.test.js proves it.
function rungUsage(missing) {
  return `${missing}: ${usageLine(['strategy', 'set-rung'])}`;
}

function providerLabel(name) {
  const base = String(name ?? '').split(':')[0];
  const labels = {
    'claude-code': 'Claude',
    codex: 'Codex',
    'command-code': 'Command Code',
    grok: 'Grok',
    echo: 'Echo',
    opencode2: 'OpenCode',
  };
  const suffix = String(name ?? '').includes(':') ? ` (${String(name).split(':').slice(1).join(':')})` : '';
  return `${labels[base] ?? base}${suffix}`;
}

export async function refreshStrategy(bullswarmDir, {
  executor, getReadings = getAllMeterReadings, onProgress = () => {},
  useOpenRouter = false, openRouterCatalog = null, openRouterLoader = loadOpenRouterCatalog,
} = {}) {
  const state = loadState(bullswarmDir);
  const connectors = loadConnectors(bullswarmDir);
  const providerCount = Object.keys(connectors).length;
  onProgress(`[0/${providerCount}] Preparing provider usage checks`);
  const { pools } = await buildPoolsLive(bullswarmDir, Date.now(), {
    getReadings,
    onProviderProgress: ({ stage, pool, index, completed, total }) => {
      onProgress(stage === 'start'
        ? `[${index}/${total}] Checking usage for ${providerLabel(pool)}`
        : `[${completed}/${total}] Usage checked for ${providerLabel(pool)}`);
    },
  });
  onProgress('Discovering available models');
  const discoveries = discoverAllModels(connectors, executor ? { executor } : {});
  let externalCatalog = openRouterCatalog;
  if (useOpenRouter && !externalCatalog) {
    onProgress('Downloading the public Bullswarm benchmark datapack');
    externalCatalog = await openRouterLoader({ bullswarmDir, force: true });
  }
  onProgress('Comparing capability, quality, budget, and quota');
  const report = buildStrategy({
    connectors, pools, state, discoveries, openRouterCatalog: externalCatalog,
  });
  // Under the lock (S5): discovery and live meter calls above take seconds, so
  // the copy loaded at the top of this function is stale by now. Only the two
  // report fields are written, onto a FRESH load — a `strategy set-provider`
  // that landed meanwhile survives.
  updateState(bullswarmDir, (fresh) => {
    fresh.strategy ??= {};
    fresh.strategy.lastReport = report;
    fresh.strategy.lastRefreshedAt = report.capturedAt;
  });
  return report;
}

function modelsForPool(pool, discovery, state) {
  const providerId = pool.connector?.profile?.providerId ?? null;
  const modelIndex = pool.connector?.spawn?.cmd?.indexOf('--model') ?? -1;
  const configured = modelIndex >= 0 ? pool.connector.spawn.cmd[modelIndex + 1] ?? null : null;
  let models = discovery?.models ?? [];
  if (providerId) {
    const prefix = `${providerId}/`;
    models = models.filter((model) => model.id.startsWith(prefix) || model.id === configured);
  }
  const explicit = state.strategy?.modelTiers?.[pool.name] ?? {};
  const disabledModels = disabledModelsForPool(state.strategy, pool.name);
  return models.map((model) => {
    const tiers = STRATEGY_TIERS.filter((tier) => (explicit[model.id] ?? []).includes(tier));
    const disabled = disabledModels.includes(model.id.toLowerCase());
    const effectiveTiers = disabled ? [] : STRATEGY_TIERS.filter((tier) => (
      (state.strategy?.configuredTiers ?? []).includes(tier) ? tiers.includes(tier) : model.tier === tier
    ));
    return { ...model, tiers, effectiveTiers, disabled };
  });
}

// --- rungs -------------------------------------------------------------------
// One read/write view over the two halves of a tier choice: which model runs
// and how hard it thinks. Reading never spawns discovery — a rung table is
// assembled from persisted state, the connector files, and the decision log.

/**
 * The dated benchmark datapack, when it is installed. A missing or unreadable
 * datapack is not an error here: every rung simply reports `no evidence`.
 */
export async function loadRungEvidence(bullswarmDir) {
  try {
    // Offline on purpose: a rung table is a read-only view, so it uses the
    // cached or bundled datapack and never downloads one. Refreshing the
    // datapack is scripts/refresh-epoch-benchmarks.mjs's job.
    const datapack = await loadEpochBenchmarks({ bullswarmDir, fetchImpl: null });
    if (!datapack) return null;
    return { datapack, rungEvidence };
  } catch {
    return null;
  }
}

/** Every rung, or one pool's rungs. Read-only: no discovery, no meter calls. */
export async function rungRows(bullswarmDir, { pool = null } = {}) {
  const { state, connectors, pools } = buildPools(bullswarmDir);
  if (pool != null && !connectors[pool]) throw new Error(`unknown pool "${pool}"`);
  return rungsFor({
    pools,
    connectors,
    strategy: state.strategy ?? {},
    decisionLog: state.decisionLog ?? [],
    evidence: await loadRungEvidence(bullswarmDir),
    pool,
  });
}

/**
 * The models set-rung will accept without --force: whatever the last
 * persisted discovery report saw for this pool, plus what the connector file
 * itself declares. `configure` refreshes a cold cache through
 * loadStrategyInventory(); set-rung deliberately does not, so writing one
 * rung can never fan out into live CLI calls.
 */
function cachedPoolModels(state, connector) {
  const cached = state.strategy?.lastReport?.discoveries?.[connector.name]?.models ?? [];
  return [...new Set([
    ...cached.map((model) => model.id),
    ...(connector.knownModels ?? []),
    configuredModel(connector),
  ].filter(Boolean))];
}

function rungEvidenceCell(evidence) {
  return formatRungEvidence(evidence) || 'no evidence';
}

function rungRecordCell(record) {
  if (!record?.dispatches) return 'no dispatches';
  return [
    `${record.dispatches} dispatch${record.dispatches === 1 ? '' : 'es'}`,
    record.medianMinutes != null ? `p50 ${record.medianMinutes}m` : 'p50 unknown',
    record.okShare != null ? `${Math.round(record.okShare * 100)}% ok` : 'ok unknown',
  ].join(' · ');
}

// A configured level the connector cannot express is a routing fact, so the
// cell says what was actually applied and who decided it — never the level
// someone asked for.
function rungReasoningCell(reasoning) {
  if (reasoning?.applied) {
    return `${reasoning.applied} (${reasoning.source})${reasoning.clamped ? ', clamped' : ''}`;
  }
  return `— (${reasoning?.source ?? 'none'})`;
}

export function renderRungs(rows) {
  if (!rows.length) {
    return 'no rungs yet: enable a provider pool and configure an effort tier '
      + '(strategy set-model or strategy apply --yes), then run strategy rungs again.';
  }
  const header = ['pool', 'tier', 'model', 'reasoning', 'evidence', 'record'];
  const body = rows.map((row) => [
    row.pool,
    row.tier,
    row.model ?? `— (${row.modelSource})`,
    rungReasoningCell(row.reasoning),
    rungEvidenceCell(row.evidence),
    rungRecordCell(row.record),
  ]);
  const widths = header.map((label, index) => Math.max(
    label.length,
    ...body.map((cells) => cells[index].length),
  ));
  const line = (cells) => cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
    .join('  ')
    .trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

export function strategyInventory({ pools, state, report, evidence = null }) {
  const visible = pools
    .filter((pool) => !(pool.testFixture === true && pool.enabled === false))
    .sort((a, b) => a.name.localeCompare(b.name));
  const providers = visible
    .map((pool) => ({
      name: pool.name,
      enabled: pool.enabled !== false,
      usedPct: pool.usedPct ?? null,
      surplus: pool.pace ?? null,
      // How many agents this pool is running right now, across every
      // Bullswarm process — the same count `bullswarm pools` reports.
      inflight: pool.inflight?.count ?? 0,
      projectedFiveHourPct: pool.projectedFiveHourPct ?? null,
      meterSource: pool.meterSource,
      lanes: pool.lanes ?? [],
      capabilities: pool.capabilities ?? [],
      models: modelsForPool(pool, report.discoveries?.[pool.name], state),
    }));
  const routes = {};
  for (const tier of STRATEGY_TIERS) {
    // No report yet: fall back to the derived tier -> lane map (C1) rather than
    // a third hand-written copy of it. Capabilities stay empty here on purpose
    // — with no suggestions to read, the preview must not invent requirements
    // that would make every pool look ineligible.
    const context = report.suggestions?.[tier]?.requirements
      ?? { lane: TIER_LANES[tier], capabilities: [] };
    const assignment = state.strategy?.assignments?.[tier] ?? null;
    const candidates = pools.map((pool) => ({
      ...pool,
      modelPolicy: resolveDispatchModel(pool.connector ?? pool, tier, {
        assignment,
        excludedModels: [
          ...(state.strategy?.excludedModels ?? []),
          ...disabledModelsForPool(state.strategy, pool.name),
        ],
        allowedModels: selectedModelsForTier(state.strategy, pool.name, tier),
      }),
    }));
    // Not pre-filtered on modelPolicy.eligible: pickPool applies that filter
    // itself and needs the rejects to tell an empty candidate list caused by
    // the tier allow-list apart from one caused by capabilities (D7).
    const route = pickPool(context.lane, candidates, {
      callerEligible: false,
      callerSession: false,
      requiredCapabilities: context.capabilities,
      preferredPool: assignment?.pool ?? null,
      effortTier: tier,
      // The preview routes on the same forecast a real dispatch would (the
      // caller attaches it to `pools` before building the inventory), so the
      // control center never shows a pick the next dispatch would not make.
      candidateMinutes: expectedMinutesFor({ lane: context.lane, effort: tier }, {
        decisionLog: state.decisionLog ?? [],
      }).minutes,
      inflightPenaltyPct: inflightPenaltyFrom(state),
    });
    if (!route.pick) {
      routes[tier] = { lane: context.lane, pool: null, model: null, reasoning: null, reason: route.why };
      continue;
    }
    const picked = route.pick.connector;
    const model = picked.modelPolicy?.model ?? null;
    // Report the depth the picked pool would actually receive, including the
    // selected model, so a skipped or clamped level is visible in the route.
    const reasoning = resolveReasoningLevel({
      connector: picked.connector ?? picked, tier, model, strategy: state.strategy ?? {},
    });
    routes[tier] = {
      lane: context.lane,
      pool: route.pick.pool,
      model,
      surplus: picked.pace ?? null,
      reasoning: { level: reasoning.applied, source: reasoning.source },
      reason: route.why,
    };
  }
  return {
    schemaVersion: 'bullswarm.strategy.inventory.v1',
    capturedAt: report.capturedAt,
    configuredTiers: state.strategy?.configuredTiers ?? [],
    providers,
    routes,
    // The same rows `strategy rungs` prints, so one inventory call answers
    // both "what would route" and "what did each rung actually cost".
    rungs: rungsFor({
      pools: visible,
      strategy: state.strategy ?? {},
      decisionLog: state.decisionLog ?? [],
      evidence,
    }),
    reasoning: {
      ...getStrategyReasoning(state.strategy),
      effective: reasoningEffective(visible, state.strategy ?? {}),
    },
    recommendations: report.providerSuggestions ?? {},
    openRouter: report.openRouter ?? null,
    excludedModels: normalizeExcludedModels(state.strategy?.excludedModels),
  };
}

export async function loadStrategyInventory(bullswarmDir, {
  force = false, executor, getReadings = getAllMeterReadings, onProgress = () => {},
  useOpenRouter = false, openRouterCatalog = null, openRouterLoader = loadOpenRouterCatalog,
} = {}) {
  let state = loadState(bullswarmDir);
  const report = force || !state.strategy?.lastReport
    ? await refreshStrategy(bullswarmDir, {
      executor, getReadings, onProgress, useOpenRouter, openRouterCatalog, openRouterLoader,
    })
    : state.strategy.lastReport;
  state = loadState(bullswarmDir);
  const { pools } = buildPools(bullswarmDir);
  const subscriptions = Object.fromEntries((report.subscriptions ?? []).map((entry) => [entry.pool, entry]));
  for (const pool of pools) {
    const live = subscriptions[pool.name];
    if (!live) continue;
    pool.usedPct = live.usedPct;
    pool.pace = live.surplus;
    pool.meterSource = live.meterSource;
  }
  // The control center previews real routing, so it reads the same live
  // in-flight ledger and spend rates every dispatch path does.
  attachForecast(pools, bullswarmDir, { decisionLog: state.decisionLog ?? [] });
  return strategyInventory({
    pools, state, report, evidence: await loadRungEvidence(bullswarmDir),
  });
}

function setProviderEnabled(bullswarmDir, pool, enabled) {
  const connectors = loadConnectors(bullswarmDir);
  if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
  // Under the lock (S5): this is the writer an operator reaches for while a
  // run is in flight, and it is the exact out-of-band write the D5 race test
  // uses. Loading outside the lock would let a concurrent post-worker update
  // land between this load and its save, silently dropping one of the two.
  updateState(bullswarmDir, (state) => {
    state.pools[pool] ??= {};
    state.pools[pool].enabled = enabled;
  });
  return { action: 'provider-updated', pool, enabled };
}

function materializeTier(strategy, inventory, tier) {
  if ((strategy.configuredTiers ?? []).includes(tier)) return;
  for (const provider of inventory.providers) {
    for (const candidate of provider.models) {
      if (!candidate.effectiveTiers.includes(tier) || candidate.disabled) continue;
      const existing = strategy.modelTiers?.[provider.name]?.[candidate.id] ?? [];
      setModelTierSelection(strategy, provider.name, candidate.id, [...existing, tier]);
    }
  }
}

function setModelTiers(bullswarmDir, pool, model, tiers, inventory) {
  const connectors = loadConnectors(bullswarmDir);
  if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
  if (!tiers.length) {
    updateState(bullswarmDir, (state) => {
      state.strategy ??= {};
      setModelDisabled(state.strategy, pool, model, true);
      setModelTierSelection(state.strategy, pool, model, []);
    });
    return { action: 'model-tiers-updated', pool, model, tiers: [], disabled: true };
  }
  // The caller spent a full inventory load getting here; the selection is
  // written under the lock (S5) on a fresh load so that wait cannot cost a
  // concurrent operator's write.
  let selected = [];
  updateState(bullswarmDir, (state) => {
    state.strategy ??= {};
    setModelDisabled(state.strategy, pool, model, false);
    for (const tier of tiers) materializeTier(state.strategy, inventory, tier);
    selected = setModelTierSelection(state.strategy, pool, model, tiers);
    state.strategy.configuredTiers = [...new Set([...(state.strategy.configuredTiers ?? []), ...tiers])];
    for (const tier of tiers) clearTierAssignment(state.strategy, tier);
  });
  return { action: 'model-tiers-updated', pool, model, tiers: selected };
}

export function applyStrategyRecommendations(bullswarmDir, report, {
  refreshHours = 24, enableAutoRefresh = true,
} = {}) {
  const approvedRefreshHours = enableAutoRefresh ? refreshHoursValue(refreshHours) : null;
  const applied = {};
  // Under the lock (S5): apply always follows a refresh (seconds of discovery)
  // or a TUI session, so it rewrites assignments on a fresh load and reports
  // the policy the mutator actually wrote.
  const written = updateState(bullswarmDir, (state) => {
    state.strategy ??= {};
    state.strategy.assignments ??= {};
    for (const tier of ['high', 'medium', 'low']) {
      const recommended = report?.suggestions?.[tier]?.recommended ?? null;
      if (!recommended) continue;
      state.strategy.assignments[tier] = { ...recommended };
      applied[tier] = { ...recommended };
    }
    state.strategy.modelTiers = {};
    state.strategy.configuredTiers = [...STRATEGY_TIERS];
    for (const [pool, tiers] of Object.entries(report?.providerSuggestions ?? {})) {
      for (const tier of STRATEGY_TIERS) {
        const model = tiers?.[tier]?.recommended?.model ?? null;
        if (!model) continue;
        const existing = state.strategy.modelTiers?.[pool]?.[model] ?? [];
        setModelTierSelection(state.strategy, pool, model, [...existing, tier]);
      }
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
  });
  return { applied, policy: written.strategy.policy };
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
    const report = await refreshStrategy(bullswarmDir, { useOpenRouter: true, ...opts });
    return {
      report,
      ...applyStrategyRecommendations(bullswarmDir, report, { refreshHours: hours }),
    };
  } catch (err) {
    // Discovery is advisory and must never turn an otherwise routable run into
    // an outage. Keep the last approved assignments and expose the failure.
    const failed = updateState(bullswarmDir, (state) => {
      state.strategy ??= {};
      state.strategy.policy ??= policy;
      state.strategy.policy.lastRefreshErrorAt = new Date().toISOString();
      state.strategy.policy.lastRefreshError = err.message;
    });
    return { error: err.message, retainedAssignments: failed.strategy.assignments ?? {} };
  }
}

export async function cmdStrategy(args, {
  bullswarmDir, input = process.stdin, output = process.stdout,
} = {}) {
  // A leading flag means no subcommand was given: `strategy --json` reads the
  // default report, it does not name a subcommand called "--json".
  const [head, ...tail] = args;
  const sub = head === undefined || flagName(head) ? 'show' : head;
  const opts = parseFlags(head !== undefined && flagName(head) ? args : tail);
  try {
    if (sub === 'help' || sub === '--help' || opts.help) {
      console.log(strategyUsage());
      return 0;
    }
    const flagExit = unknownFlagExit(opts._flags, strategyHelpPath(sub, opts));
    if (flagExit !== null) return flagExit;
    if (sub === 'tui') {
      if (!input.isTTY || !output.isTTY) throw new Error('strategy tui requires an interactive terminal');
      return await startStrategyDashboard({
        bullswarmDir, input, output,
        loadInventory: ({ force, onProgress, analyze }) => loadStrategyInventory(bullswarmDir, {
          force, onProgress, useOpenRouter: analyze,
        }),
        applyRecommendations: () => {
          const report = loadState(bullswarmDir).strategy?.lastReport;
          if (report) applyStrategyRecommendations(bullswarmDir, report);
        },
      });
    }
    if (sub === 'rungs') {
      const pool = opts.pool === undefined ? null : String(opts.pool).trim();
      if (pool === '') throw new Error('missing --pool name for strategy rungs');
      const rows = await rungRows(bullswarmDir, { pool });
      console.log(opts.json
        ? JSON.stringify({
          schemaVersion: 'bullswarm.strategy.rungs.v1',
          capturedAt: new Date().toISOString(),
          rungs: rows,
        }, null, 2)
        : renderRungs(rows));
      return 0;
    }
    if (sub === 'set-rung') {
      const [pool, tier] = opts.rest;
      if (!pool || !tier) throw new Error(rungUsage('missing <pool> and <tier>'));
      const connectors = loadConnectors(bullswarmDir);
      if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
      if (!STRATEGY_TIERS.includes(tier)) {
        throw new Error(`unknown tier "${tier}" (${STRATEGY_TIERS.join(', ')})`);
      }
      const model = typeof opts.model === 'string' ? opts.model.trim() : '';
      if (!model) throw new Error(rungUsage('missing --model <model>'));
      let level = null;
      if (opts.reasoning !== undefined) {
        level = typeof opts.reasoning === 'string' ? opts.reasoning.trim().toLowerCase() : '';
        if (!isReasoningLevel(level)) {
          throw new Error(`--reasoning must be ${[...REASONING_LEVELS, 'default'].join(', ')}`);
        }
      }
      // Validated before the lock is taken, on its own read of the cached
      // discovery report: a rejected model must not make a waiter queue.
      const known = cachedPoolModels(loadState(bullswarmDir), connectors[pool]);
      if (!known.includes(model) && opts.force !== true) {
        throw new Error(`unknown model "${model}" for pool "${pool}" — cached discovery knows `
          + `${known.length ? known.join(', ') : 'no models yet; run bullswarm strategy refresh'}`
          + '. Pass --force to select it anyway.');
      }
      // One atomic save under the lock (S5): the model half and the reasoning
      // half of a rung can never land separately, and the notes below report
      // the state the mutator actually wrote.
      const state = updateState(bullswarmDir, (fresh) => {
        fresh.strategy ??= {};
        setRung(fresh.strategy, { pool, tier, model, reasoning: level });
      });
      const applied = resolveReasoningLevel({
        connector: connectors[pool], tier, model, strategy: state.strategy,
      });
      const notes = [];
      if (level != null && applied.clamped) {
        notes.push(`${pool} cannot set ${level}; clamped to ${applied.applied}`);
      }
      if (level != null && level !== 'default' && applied.source === 'unsupported') {
        notes.push(`${pool} declares no reasoning levels, so ${level} is recorded but nothing is appended to its CLI`);
      }
      if (level != null && applied.source === 'skipped-model') {
        notes.push(`${pool} skips the reasoning flag for model ${model}`);
      }
      if (!known.includes(model)) notes.push(`${model} is not in the cached discovery for ${pool} (--force)`);
      if (!(state.strategy.configuredTiers ?? []).includes(tier)) {
        notes.push(`tier "${tier}" is not a configured allow-list yet, so ${tier} routing still picks models automatically`);
      }
      if (disabledModelsForPool(state.strategy, pool).includes(model.toLowerCase())) {
        notes.push(`${model} is disabled for ${pool}; strategy set-model re-enables it`);
      }
      console.log(JSON.stringify({
        action: 'rung-set',
        pool,
        tier,
        model,
        reasoning: {
          requested: level,
          applied: applied.applied,
          source: applied.source,
          clamped: applied.clamped,
        },
        modelTiers: state.strategy.modelTiers?.[pool] ?? {},
        notes,
      }, null, 2));
      return 0;
    }
    if (sub === 'inventory' || sub === 'routes') {
      const inventory = await loadStrategyInventory(bullswarmDir, {
        force: opts.refresh === true, useOpenRouter: opts.refresh === true,
      });
      const value = sub === 'routes' ? { capturedAt: inventory.capturedAt, routes: inventory.routes } : inventory;
      // Always JSON: `--json` is accepted for agents that pass it, but there is
      // no human renderer for either verb, so it selects nothing.
      console.log(JSON.stringify(value, null, 2));
      return 0;
    }
    if (sub === 'set-provider') {
      if (opts.yes !== true) throw new Error('set-provider changes routing; pass --yes to approve');
      const pool = opts.rest[0];
      const mode = opts.rest[1];
      if (!pool || !['on', 'off'].includes(mode)) throw new Error(`usage: ${usageLine(['strategy', 'set-provider'])}`);
      console.log(JSON.stringify(setProviderEnabled(bullswarmDir, pool, mode === 'on'), null, 2));
      return 0;
    }
    if (sub === 'set-model') {
      if (opts.yes !== true) throw new Error('set-model changes routing; pass --yes to approve');
      const [pool, model] = opts.rest;
      const raw = String(opts.tiers ?? '').trim().toLowerCase();
      if (!pool || !model || !raw) throw new Error(`usage: ${usageLine(['strategy', 'set-model'])}`);
      const tiers = raw === 'off' ? [] : raw.split(',').map((tier) => tier.trim());
      if (tiers.some((tier) => !STRATEGY_TIERS.includes(tier))) throw new Error('--tiers must be high,medium,low or off');
      const inventory = await loadStrategyInventory(bullswarmDir);
      const provider = inventory.providers.find((entry) => entry.name === pool);
      if (!provider?.models.some((entry) => entry.id === model)) throw new Error(`unknown model "${model}" for pool "${pool}"`);
      console.log(JSON.stringify(setModelTiers(bullswarmDir, pool, model, tiers, inventory), null, 2));
      return 0;
    }
    if (sub === 'reset-tier') {
      if (opts.yes !== true) throw new Error('reset-tier changes routing; pass --yes to approve');
      const tier = opts.rest[0];
      if (!STRATEGY_TIERS.includes(tier)) throw new Error(`usage: ${usageLine(['strategy', 'reset-tier'])}`);
      updateState(bullswarmDir, (state) => {
        state.strategy ??= {};
        state.strategy.configuredTiers = (state.strategy.configuredTiers ?? []).filter((entry) => entry !== tier);
        for (const [pool, models] of Object.entries(state.strategy.modelTiers ?? {})) {
          for (const [model, tiers] of Object.entries(models)) {
            setModelTierSelection(state.strategy, pool, model, tiers.filter((entry) => entry !== tier));
          }
        }
        clearTierAssignment(state.strategy, tier);
      });
      console.log(JSON.stringify({ action: 'tier-reset-to-automatic', tier }, null, 2));
      return 0;
    }
    if (sub === 'set-reasoning' || sub === 'reset-reasoning') {
      if (opts.yes !== true) throw new Error(`strategy ${sub} changes routing; pass --yes to approve`);
      const pool = reasoningFlag(opts.pool, sub);
      if (pool !== null && !loadConnectors(bullswarmDir)[pool]) throw new Error(`unknown pool "${pool}"`);
      if (sub === 'set-reasoning') {
        const tier = assertReasoningTier(reasoningFlag(opts.tier, sub));
        const level = assertReasoningLevel(reasoningFlag(opts.level, sub));
        let reasoning = null;
        updateState(bullswarmDir, (state) => {
          state.strategy ??= {};
          reasoning = setStrategyReasoning(state.strategy, { tier, level, pool });
        });
        console.log(JSON.stringify({ action: 'reasoning-updated', tier, level, pool, reasoning }, null, 2));
        return 0;
      }
      const tier = opts.tier === undefined ? null : assertReasoningTier(reasoningFlag(opts.tier, sub));
      let reasoning = null;
      updateState(bullswarmDir, (state) => {
        state.strategy ??= {};
        reasoning = clearStrategyReasoning(state.strategy, { tier, pool });
      });
      console.log(JSON.stringify({ action: 'reasoning-reset', tier, pool, reasoning }, null, 2));
      return 0;
    }
    if (sub === 'configure') {
      if (opts.yes !== true) throw new Error('strategy configure changes routing; pass --yes to approve');
      if (!opts.file) throw new Error(`usage: ${usageLine(['strategy', 'configure'])}`);
      const { readFileSync } = await import('node:fs');
      const config = JSON.parse(readFileSync(opts.file, 'utf8'));
      const connectors = loadConnectors(bullswarmDir);
      const reasoning = validateReasoningSection(config.reasoning, connectors);
      const inventory = await loadStrategyInventory(bullswarmDir);
      // The whole document is validated INSIDE the mutator (S5): a throw
      // half way through aborts before updateState writes anything, so a
      // typo in one tier still cannot leave half a policy applied — and
      // the load it validates against is the one it writes back.
      const written = updateState(bullswarmDir, (state) => {
        state.strategy ??= {};
        for (const [pool, enabled] of Object.entries(config.providers ?? {})) {
          if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
          if (typeof enabled !== 'boolean') throw new Error(`provider ${pool} must be true or false`);
          state.pools[pool] ??= {};
          state.pools[pool].enabled = enabled;
        }
        const configured = new Set(state.strategy.configuredTiers ?? []);
        for (const [pool, models] of Object.entries(config.models ?? {})) {
          if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
          const detected = new Set(inventory.providers.find((entry) => entry.name === pool)?.models.map((entry) => entry.id) ?? []);
          for (const [model, value] of Object.entries(models ?? {})) {
            if (!detected.has(model)) throw new Error(`unknown model "${model}" for pool "${pool}"`);
            const tiers = value === 'off' ? [] : value;
            if (!Array.isArray(tiers) || tiers.some((tier) => !STRATEGY_TIERS.includes(tier))) {
              throw new Error(`model ${pool}/${model} tiers must be an array of high, medium, low or "off"`);
            }
            if (!tiers.length) {
              setModelDisabled(state.strategy, pool, model, true);
              setModelTierSelection(state.strategy, pool, model, []);
            } else {
              setModelDisabled(state.strategy, pool, model, false);
              setModelTierSelection(state.strategy, pool, model, tiers);
              for (const tier of tiers) configured.add(tier);
            }
          }
        }
        state.strategy.configuredTiers = [...configured];
        for (const tier of configured) clearTierAssignment(state.strategy, tier);
        applyReasoningSection(state.strategy, reasoning);
      });
      console.log(JSON.stringify({
        action: 'strategy-configured',
        configuredTiers: written.strategy.configuredTiers,
        reasoning: getStrategyReasoning(written.strategy),
      }, null, 2));
      return 0;
    }
    if (sub === 'refresh' || sub === 'recommend') {
      if (opts.apply && opts.yes !== true) throw new Error('--apply changes routing; pass --yes to approve');
      const report = await refreshStrategy(bullswarmDir, { useOpenRouter: true });
      const applied = opts.apply
        ? applyStrategyRecommendations(bullswarmDir, report, {
          refreshHours: refreshHoursValue(opts['refresh-hours']),
        }) : null;
      console.log(opts.json
        ? JSON.stringify(applied ? { report, ...applied } : report, null, 2)
        : render(report, reasoningReport(bullswarmDir)));
      return 0;
    }
    if (sub === 'show') {
      const state = loadState(bullswarmDir);
      const report = state.strategy?.lastReport ?? await refreshStrategy(bullswarmDir, { useOpenRouter: true });
      console.log(opts.json ? JSON.stringify(report, null, 2) : render(report, reasoningReport(bullswarmDir)));
      return 0;
    }
    if (sub === 'set-subscription') {
      const pool = opts.rest[0];
      if (!pool) throw new Error(`usage: ${usageLine(['strategy', 'set-subscription'])}`);
      const connectors = loadConnectors(bullswarmDir);
      if (!connectors[pool]) throw new Error(`unknown pool "${pool}"`);
      // Flag validation first, so a bad number fails before any lock is taken.
      const monthlyPriceUsd = numberOrNull(opts['monthly-usd'], 'monthly-usd');
      const includedValueUsd = numberOrNull(opts['included-usd'], 'included-usd');
      const state = updateState(bullswarmDir, (fresh) => {
        fresh.strategy ??= {};
        fresh.strategy.subscriptions ??= {};
        const current = fresh.strategy.subscriptions[pool] ?? {};
        fresh.strategy.subscriptions[pool] = {
          ...current,
          ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
          ...(monthlyPriceUsd !== undefined ? { monthlyPriceUsd } : {}),
          ...(includedValueUsd !== undefined ? { includedValueUsd } : {}),
          ...(opts['quota-window'] !== undefined ? { quotaWindow: opts['quota-window'] } : {}),
        };
        delete fresh.strategy.lastReport;
      });
      console.log(JSON.stringify({ action: 'subscription-updated', pool, subscription: state.strategy.subscriptions[pool] }, null, 2));
      return 0;
    }
    if (sub === 'assign') {
      const tier = opts.rest[0];
      if (!['high', 'medium', 'low'].includes(tier)) throw new Error(`usage: ${usageLine(['strategy', 'assign'])}`);
      if (!opts.pool || !opts.model) throw new Error('assignment needs --pool and --model');
      const connectors = loadConnectors(bullswarmDir);
      if (!connectors[opts.pool]) throw new Error(`unknown pool "${opts.pool}"`);
      const state = updateState(bullswarmDir, (fresh) => {
        fresh.strategy ??= {};
        fresh.strategy.assignments ??= {};
        fresh.strategy.assignments[tier] = { pool: opts.pool, model: opts.model };
        delete fresh.strategy.lastReport;
      });
      console.log(JSON.stringify({ action: 'tier-assigned', tier, assignment: state.strategy.assignments[tier] }, null, 2));
      return 0;
    }
    if (sub === 'exclude-model' || sub === 'include-model') {
      const model = opts.rest[0];
      if (!model) throw new Error(`usage: ${usageLine(['strategy', sub])}`);
      const normalized = String(model).trim().toLowerCase();
      const state = updateState(bullswarmDir, (fresh) => {
        fresh.strategy ??= {};
        const current = normalizeExcludedModels(fresh.strategy.excludedModels);
        fresh.strategy.excludedModels = sub === 'exclude-model'
          ? normalizeExcludedModels([...current, normalized])
          : current.filter((entry) => entry !== normalized);
        delete fresh.strategy.lastReport;
      });
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
      const report = state.strategy?.lastReport ?? await refreshStrategy(bullswarmDir, { useOpenRouter: true });
      const result = applyStrategyRecommendations(bullswarmDir, report, {
        refreshHours: refreshHoursValue(opts['refresh-hours']),
      });
      console.log(JSON.stringify({ action: 'strategy-applied', ...result }, null, 2));
      return 0;
    }
    if (sub === 'auto') {
      const mode = opts.rest[0] ?? 'status';
      if (mode === 'off') {
        if (opts.yes !== true) throw new Error('strategy auto off changes routing policy; pass --yes to approve');
        const written = updateState(bullswarmDir, (state) => {
          state.strategy ??= {};
          state.strategy.policy ??= {};
          state.strategy.policy.autoApplyRecommendations = false;
          state.strategy.policy.disabledAt = new Date().toISOString();
        });
        console.log(JSON.stringify({ action: 'strategy-auto', policy: written.strategy.policy }, null, 2));
        return 0;
      }
      if (mode !== 'status') throw new Error(`usage: ${usageLine(['strategy', 'auto'])}`);
      // `status` writes nothing, so it stays a plain read and never queues
      // behind the lock: the empty policy it reports is a default, not a save.
      console.log(JSON.stringify({
        action: 'strategy-auto',
        policy: loadState(bullswarmDir).strategy?.policy ?? {},
      }, null, 2));
      return 0;
    }
    if (sub === 'clear-assignment') {
      const tier = opts.rest[0];
      if (!['high', 'medium', 'low'].includes(tier)) throw new Error(`usage: ${usageLine(['strategy', 'clear-assignment'])}`);
      updateState(bullswarmDir, (state) => {
        clearTierAssignment(state.strategy, tier);
        delete state.strategy?.lastReport;
      });
      console.log(JSON.stringify({ action: 'tier-assignment-cleared', tier }, null, 2));
      return 0;
    }
    throw new Error(strategyUsage());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    const usage = /^(usage:|missing |assignment needs |--apply changes|(?:strategy )?(?:apply|auto off|configure|set-provider|set-model|reset-tier|set-reasoning|reset-reasoning) changes|--tiers? must be|--level must be|--reasoning must be|reasoning(?:\.|\s)|refresh-hours must be|.* must be a non-negative number|unknown phase|unknown command|unknown pool|unknown tier|unknown model)/i.test(err.message);
    return usage ? 2 : 1;
  }
}
