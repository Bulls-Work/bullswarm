import { updateState } from './lib/state.js';
import {
  STRATEGY_TIERS, setModelDisabled, setModelTierSelection, clearTierAssignment, setStrategyReasoning,
} from './lib/strategy.js';
import { formatMoney } from './lib/usage-basis.js';
import { glyphs, spinnerGlyph } from './lib/glyphs.js';

const ESC = '\x1b';
const CLEAR = '\x1b[2J\x1b[H';
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';
const INVERSE_ON = '\x1b[7m';
const INVERSE_OFF = '\x1b[27m';
const ANSI = /^\x1b\[[0-9;]*m/;

export function inputKeys(value) {
  const text = String(value ?? '');
  const keys = [];
  for (let index = 0; index < text.length;) {
    const sequence = text.slice(index, index + 3);
    if (/^\x1b\[[ABCD]$/.test(sequence)) {
      keys.push(sequence);
      index += 3;
    } else {
      keys.push(text[index]);
      index += 1;
    }
  }
  return keys;
}

function clip(value, width) {
  const text = String(value ?? '');
  if (visibleLength(text) <= width) return text;
  let output = '';
  let visible = 0;
  for (let index = 0; index < text.length && visible < Math.max(0, width - 1);) {
    const escape = text.slice(index).match(ANSI)?.[0];
    if (escape) {
      output += escape;
      index += escape.length;
    } else {
      output += text[index++];
      visible += 1;
    }
  }
  return `${output}${text.includes(INVERSE_ON) ? INVERSE_OFF : ''}…`;
}

function pad(value, width) {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function visibleLength(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;
}

function providerLines(inventory, selected, width) {
  const lines = inventory.providers.map((provider, index) => {
    const marker = index === selected ? '›' : ' ';
    const enabled = provider.enabled ? glyphs().ongoing : glyphs().pending;
    // Usage is what the meter last reported; in-flight is what this pool is
    // running right now, which routing subtracts before it compares pools.
    const load = provider.inflight ? ` ${provider.inflight}${glyphs().inflight}` : '';
    const usage = `${provider.usedPct == null ? '—' : `${provider.usedPct}%`}${load}`;
    return `${marker} ${enabled} ${pad(provider.name, Math.max(6, width - 14))} ${usage.padStart(9)}`;
  });
  const selectedFinish = selected === inventory.providers.length;
  lines.push('', `${selectedFinish ? '›' : ' '} ${selectedFinish ? INVERSE_ON : ''}${glyphs().ok} Finish setup${selectedFinish ? INVERSE_OFF : ''}`);
  return lines;
}

function effectiveModelTiers(model) {
  return model.disabled ? [] : model.effectiveTiers;
}

function modelEnabled(model) {
  return effectiveModelTiers(model).length > 0;
}

export function visibleModels(provider, query = '') {
  const needle = String(query).trim().toLowerCase();
  return [...(provider?.models ?? [])]
    .filter((model) => !needle || model.id.toLowerCase().includes(needle))
    .sort((a, b) => Number(modelEnabled(b)) - Number(modelEnabled(a)) || a.id.localeCompare(b.id));
}

function tierName(tier) {
  return `${tier[0].toUpperCase()}${tier.slice(1)}`;
}

function tierCell(model, tier, selected) {
  const enabled = effectiveModelTiers(model).includes(tier);
  const cell = `[${enabled ? glyphs().ok : ' '} ${tierName(tier)}]`;
  return selected ? `${INVERSE_ON}${cell}${INVERSE_OFF}` : cell;
}

function modelLines(models, selected, selectedTier, width, focused = true) {
  const tierWidth = 32;
  return models.map((model, index) => {
    const marker = focused && index === selected ? '›' : ' ';
    const cells = STRATEGY_TIERS.map((tier, tierIndex) => tierCell(
      model, tier, focused && index === selected && tierIndex === selectedTier,
    )).join(' ');
    // No family rule or profile gives this model a tier yet; say so rather
    // than show a row that looks like an ordinary unselected model.
    const label = model.ranking === 'unranked' ? `${model.id} (unranked)` : model.id;
    return `${marker} ${pad(label, Math.max(8, width - tierWidth))} ${cells}`;
  });
}

/**
 * The choices ←/→ steps through for one reasoning row: `null` (auto — no
 * level of its own, so the next layer down applies), each level the CLI
 * accepts, then `default` (pass nothing; the CLI decides). Empty when the CLI
 * has no reasoning setting at all.
 */
export function reasoningChoices(provider) {
  const levels = provider?.reasoningLevels ?? [];
  return levels.length ? [null, ...levels, 'default'] : [];
}

function tierModels(provider, tier) {
  return (provider?.models ?? []).filter((model) => effectiveModelTiers(model).includes(tier));
}

/**
 * The editable reasoning rows for one provider: each tier's own level, then
 * one row per model selected on that tier, whose level beats the tier's.
 */
export function reasoningRows(provider) {
  return STRATEGY_TIERS.flatMap((tier) => [
    { tier, model: null },
    ...tierModels(provider, tier).map((model) => ({ tier, model: model.id })),
  ]);
}

/**
 * What one row will run at and who chose it. `stored` is the level saved on
 * that exact row (null = auto, falling through to the layer below).
 */
export function tierReasoning(inventory, provider, tier, modelId = null) {
  const pool = provider?.name;
  if (modelId) {
    const stored = inventory.reasoning?.models?.[pool]?.[modelId]?.[tier] ?? null;
    const resolved = (provider?.models ?? []).find((model) => model.id === modelId)?.reasoning?.[tier];
    return { stored, level: resolved?.level ?? null, source: resolved?.source ?? 'none' };
  }
  const stored = inventory.reasoning?.pools?.[pool]?.[tier] ?? null;
  const effective = inventory.reasoning?.effective?.[pool]?.[tier] ?? { level: null, source: 'none' };
  return { stored, level: effective.level, source: effective.source };
}

function reasoningNote({ stored, source }, tier = null) {
  if (source === 'unsupported') return 'CLI has no setting';
  if (source === 'skipped-model') return 'model ignores it';
  if (stored === 'default') return 'you set: CLI decides';
  if (source === 'strategy-model') return 'you set for this model';
  if (source === 'recommendation') return 'recommended';
  // A model row with no level of its own runs whatever its tier row says.
  if (tier) return `same as ${tierName(tier)}`;
  if (source === 'strategy-pool') return 'you set this';
  if (source === 'strategy-tier') return 'auto (your all-provider level)';
  if (source === 'connector') return 'auto (Bullswarm default)';
  return 'auto (CLI decides)';
}

function tierLines(inventory, provider, selected, width) {
  const modelWidth = Math.max(12, Math.min(26, width - 48));
  const editable = reasoningChoices(provider).length > 0;
  const lines = [`  ${'Effort'.padEnd(8)}${pad('Model', modelWidth)}   ${'Reasoning'.padEnd(11)}`];
  for (const [index, row] of reasoningRows(provider).entries()) {
    const reasoning = tierReasoning(inventory, provider, row.tier, row.model);
    const focused = index === selected;
    const value = reasoning.source === 'unsupported' ? 'n/a' : (reasoning.level ?? 'CLI default');
    const cell = focused && editable ? `${INVERSE_ON}◂ ${value} ▸${INVERSE_OFF}` : `  ${value}  `;
    const models = tierModels(provider, row.tier);
    const label = row.model
      ? pad(`  ${row.model.split('/').at(-1)}`, modelWidth + 8)
      : `${tierName(row.tier).padEnd(8)}${pad(models.length ? 'tier default' : '— no model', modelWidth)}`;
    lines.push(`${focused ? '›' : ' '} ${label} ${pad(cell, 13)} ${reasoningNote(reasoning, row.model ? row.tier : null)}`);
  }
  return lines;
}

function providerSummary(provider) {
  if (!provider) return 'Setup ready · press Enter to finish';
  const usage = provider.usedPct == null ? 'usage unknown' : `${provider.usedPct}% used`;
  return `${provider.name} · ${provider.enabled ? 'on' : 'off (Space in the list turns it on)'} · ${usage} · ${provider.models.length} models`;
}

// The right-hand pane (or the whole screen when narrow): the provider's three
// rungs — model plus reasoning per effort tier — then its model matrix.
function detailLines(inventory, provider, {
  focus = null, tierIndex = 0, reasoningIndex = 0, modelIndex = 0, search = '', searching = false,
  width, height,
}) {
  const lines = [providerSummary(provider)];
  if (!provider) return lines;
  lines.push(
    '',
    ...tierLines(inventory, provider, focus === 'tiers' ? reasoningIndex : -1, width),
    '  Reasoning: how hard the model thinks. A model row beats its tier row.',
    '',
  );
  const models = visibleModels(provider, search);
  const filter = searching
    ? `Search: ${search}▏`
    : search ? `Filter: ${search} (/ to edit)` : '/ to search';
  lines.push(`Models for each tier · ${filter} · ${models.length}/${provider.models.length}`);
  const rows = models.length
    ? modelLines(models, modelIndex, tierIndex, width, focus === 'models')
    : ['  No matching models.'];
  lines.push(...selectedWindow(rows, modelIndex, Math.max(1, height - lines.length)));
  return lines;
}

function routeLines(inventory) {
  return STRATEGY_TIERS.map((tier) => {
    const route = inventory.routes[tier];
    const label = tierName(tier).padEnd(6);
    const depth = route?.reasoning?.level ? ` · reasoning ${route.reasoning.level}` : '';
    // Only a pin fixes a tier's pool; every other tier is re-picked by spare
    // quota at each dispatch, so the line says which it is.
    const pinned = route?.pin ? ` · pinned to ${route.pin.pool}` : ' · by spare quota';
    return route?.pool
      ? `${label} ${route.lane.padEnd(7)} → ${route.pool}/${route.model ?? 'provider default'} · surplus ${route.surplus ?? '?'}${depth}${pinned}`
      : `${label} ${route?.lane?.padEnd(7) ?? ''} → unavailable${route?.reason ? ` · ${route.reason}` : ''}`;
  });
}

function selectedWindow(lines, selected, count) {
  if (lines.length <= count) return lines;
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), lines.length - count));
  return lines.slice(start, start + count);
}

function footer(view, focus, searching) {
  if (view === 'providers') return '↑/↓ provider · Space on/off · Enter/→ edit models and reasoning · F finish · Ctrl+R refresh';
  if (searching) return 'Type to filter models · Enter keep filter · Esc clear';
  if (focus === 'tiers') return '↑/↓ move · ←/→ change reasoning · Backspace back to auto · ↓ past the last row for models · Esc providers · F finish';
  return '↑/↓ model · ←/→ tier · Enter use/stop for tier · / search · Esc providers · F finish';
}

export function renderStrategyDashboard(inventory, {
  view = 'providers', providerIndex = 0, modelIndex = 0, width = 100, height = 30, message = '',
  title = 'Bullswarm strategy', tierIndex = 0, search = '', focus = 'models', reasoningIndex = 0,
  searching = false,
} = {}) {
  const narrow = width < 78;
  const provider = inventory.providers[providerIndex] ?? null;
  const lines = [
    `${title} · ${inventory.providers.filter((p) => p.enabled).length} of ${inventory.providers.length} providers on`,
    '',
  ];
  const bodyHeight = Math.max(4, height - 11);
  const detailFocus = view === 'providers' ? null : focus;
  const detail = (paneWidth) => detailLines(inventory, provider, {
    focus: detailFocus, tierIndex, reasoningIndex, modelIndex, search, searching, width: paneWidth, height: bodyHeight,
  });
  if (narrow) {
    if (view === 'providers') {
      lines.push('Providers');
      lines.push(...selectedWindow(providerLines(inventory, providerIndex, width), providerIndex, bodyHeight - 1));
    } else {
      lines.push(...detail(width));
    }
  } else {
    const longest = Math.max(8, ...inventory.providers.map((p) => p.name.length));
    const leftWidth = Math.min(Math.floor(width * 0.4), longest + 16);
    const rightWidth = width - leftWidth - 3;
    const left = [
      `Providers${view === 'providers' ? ' ‹' : ''}`,
      ...selectedWindow(providerLines(inventory, providerIndex, leftWidth), providerIndex, bodyHeight - 1),
    ];
    const right = detail(rightWidth);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(`${pad(left[i] ?? '', leftWidth)} │ ${clip(right[i] ?? '', rightWidth)}`);
    }
  }
  lines.push('', 'Routing now · by spare quota at each dispatch, unless pinned');
  lines.push(...routeLines(inventory));
  lines.push('', message || footer(view, focus, searching));
  return lines.slice(0, Math.max(8, height)).map((line) => clip(line, width)).join('\n');
}

export function renderSetupChoice({ selected = 0, width = 100, height = 30, title = 'Bullswarm setup' } = {}) {
  const choices = [
    ['Analyze and recommend', 'Inspect live usage and available models, then suggest efficient defaults.'],
    ['Configure manually', 'Open the model matrix without replacing your current choices.'],
  ];
  const lines = [title, '', 'How would you like to configure routing?', ''];
  for (const [index, [label, detail]] of choices.entries()) {
    lines.push(`${index === selected ? '›' : ' '} ${label}${index === 0 ? ' (recommended)' : ''}`);
    lines.push(`    ${detail}`, '');
  }
  lines.push('↑/↓ choose · Enter continue · Q quit');
  return lines.slice(0, height).map((line) => clip(line, width)).join('\n');
}

export function renderAnalysisProgress({
  title = 'Bullswarm setup', label = 'Preparing setup', heading = 'Analyzing providers and models…',
  startedAt = Date.now(), width = 100, height = 30,
} = {}) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const spinner = spinnerGlyph(seconds);
  const lines = [
    title,
    '',
    heading,
    '',
    `${spinner} ${label}`,
    `  ${seconds}s elapsed · this may take a moment while provider CLIs respond`,
    '',
    heading.startsWith('Analyzing')
      ? 'Bullswarm will show the model matrix when analysis is complete.'
      : 'Bullswarm will show the model matrix when your settings are ready.',
  ];
  return lines.slice(0, height).map((line) => clip(line, width)).join('\n');
}

function recommendationReason(candidate) {
  // A newest-generation stand-in for a stale family says why in one line.
  if (candidate?.fallback?.reason) return candidate.fallback.reason;
  // A newer family member with no benchmark or price of its own yet ranks on
  // its version; name that instead of an unrelated fallback line.
  const newest = candidate?.inheritsFrom
    ? `newest ${candidate.family} version (${candidate.version}), ranked above ${candidate.inheritsFrom}`
    : null;
  const external = candidate?.openRouter;
  if (!external) return newest ?? 'local provider capability and cost profile';
  const indices = external.indices ?? {};
  const ranks = external.ranks ?? {};
  const qualityParts = [
    Number.isFinite(Number(indices.agentic)) ? `agentic ${indices.agentic}`
      : Number.isFinite(Number(ranks.agentic)) ? `agentic #${ranks.agentic}` : null,
    Number.isFinite(Number(indices.coding)) ? `coding ${indices.coding}`
      : Number.isFinite(Number(ranks.coding)) ? `coding #${ranks.coding}` : null,
    Number.isFinite(Number(indices.intelligence)) ? `intelligence ${indices.intelligence}`
      : Number.isFinite(Number(ranks.intelligence)) ? `intelligence #${ranks.intelligence}` : null,
  ].filter(Boolean);
  const input = external.pricing?.inputUsdPerMillion;
  const output = external.pricing?.outputUsdPerMillion;
  const price = Number.isFinite(Number(input)) && Number.isFinite(Number(output))
    ? `${formatMoney(input)}/${formatMoney(output)} per 1M input/output tokens` : null;
  return [newest, ...qualityParts, price].filter(Boolean).join(' · ') || 'listed in the Bullswarm benchmark datapack';
}

export function recommendationLines(inventory) {
  const providers = inventory.providers.filter((provider) => provider.enabled);
  const lines = [];
  for (const provider of providers) {
    const suggestions = inventory.recommendations?.[provider.name] ?? {};
    const choices = STRATEGY_TIERS.map((tier) => {
      const recommendation = suggestions[tier]?.recommended;
      if (!recommendation) return null;
      const candidate = suggestions[tier]?.candidates?.find((entry) => entry.model === recommendation.model);
      return {
        tier,
        model: recommendation.model,
        // The level a fallback runs at is part of the choice being approved.
        reasoning: recommendation.why && recommendation.reasoning ? recommendation.reasoning : null,
        reason: recommendationReason(candidate),
      };
    }).filter(Boolean);
    // Counted, not listed: a pool with no family rules can list hundreds.
    const unranked = (provider.models ?? []).filter((model) => model.ranking === 'unranked').length;
    if (!choices.length && !unranked) continue;
    lines.push(`${provider.name}`);
    for (const choice of choices) {
      lines.push(`  ${choice.tier[0].toUpperCase()}  ${choice.model}${choice.reasoning ? ` · ${choice.reasoning} reasoning` : ''}`);
      lines.push(`     ${choice.reason}`);
    }
    if (unranked) {
      lines.push(`  unranked: ${unranked} model${unranked === 1 ? '' : 's'} · never recommended · strategy show --json lists them`);
    }
  }
  return lines;
}

export function renderRecommendationReview(inventory, {
  title = 'Bullswarm setup', width = 100, height = 30, offset = 0,
} = {}) {
  const hasBenchmarkData = Object.values(inventory.recommendations ?? {}).some((tiers) => (
    Object.values(tiers ?? {}).some((suggestion) => (suggestion?.candidates ?? []).some((candidate) => (
      candidate.openRouter && (Object.keys(candidate.openRouter.indices ?? {}).length
        || Object.keys(candidate.openRouter.ranks ?? {}).length)
    )))
  ));
  const source = inventory.openRouter?.error
    ? hasBenchmarkData
      ? `Using cached benchmark data; latest refresh unavailable (${inventory.openRouter.error}).`
      : `Benchmark datapack unavailable (${inventory.openRouter.error}); local metadata was used.`
    : 'Quality is the connector rank, newest version first in a family; OpenRouter indices break equal ranks; API price guides budget.';
  const details = recommendationLines(inventory);
  const bodyHeight = Math.max(3, height - 10);
  const start = Math.max(0, Math.min(offset, Math.max(0, details.length - bodyHeight)));
  const shown = details.slice(start, start + bodyHeight);
  const lines = [
    title,
    '',
    'Recommended defaults · one model per provider and tier',
    'No tier is pinned: each dispatch picks the provider by spare quota and runs its model below.',
    source,
    `Datapack captured ${inventory.openRouter?.capturedAt ?? 'at an unknown time'}; the CLI uses no OpenRouter key.`,
    '',
    ...(start > 0 ? [`↑ ${start} earlier lines`] : []),
    ...shown,
    ...(start + bodyHeight < details.length ? [`↓ ${details.length - start - bodyHeight} more lines`] : []),
    '',
    'Apply these defaults?  Y yes · N keep current choices · ↑/↓ scroll · Q quit',
  ];
  return lines.slice(0, height).map((line) => clip(line, width)).join('\n');
}

// The TUI writers (S5). An operator sits in the dashboard for minutes between
// keystrokes, so a keystroke must never save a state copy loaded when the
// screen was drawn — each one mutates a fresh load under the lock.
function persistProvider(bullswarmDir, pool, enabled) {
  updateState(bullswarmDir, (state) => {
    state.pools[pool] ??= {};
    state.pools[pool].enabled = enabled;
  });
}

// `level` null clears that row's own level, so the layer below applies
// again — the same write as `strategy set-reasoning --pool [--model]`.
function persistReasoning(bullswarmDir, pool, tier, level, model = null) {
  updateState(bullswarmDir, (state) => {
    state.strategy ??= {};
    setStrategyReasoning(state.strategy, { tier, level, pool, model });
  });
}

function persistModel(bullswarmDir, inventory, pool, model, tiers, changedTier = null, disabled = false) {
  if (disabled) {
    updateState(bullswarmDir, (state) => {
      state.strategy ??= {};
      setModelDisabled(state.strategy, pool, model, true);
      setModelTierSelection(state.strategy, pool, model, []);
    });
    return;
  }
  updateState(bullswarmDir, (state) => {
    state.strategy ??= {};
    setModelDisabled(state.strategy, pool, model, false);
    if (changedTier && !(state.strategy.configuredTiers ?? []).includes(changedTier)) {
      for (const provider of inventory.providers) {
        for (const candidate of provider.models) {
          if (!candidate.effectiveTiers.includes(changedTier) || candidate.disabled) continue;
          const existing = state.strategy.modelTiers?.[provider.name]?.[candidate.id] ?? [];
          setModelTierSelection(state.strategy, provider.name, candidate.id, [...existing, changedTier]);
        }
      }
    }
    setModelTierSelection(state.strategy, pool, model, tiers);
    state.strategy.configuredTiers = [...new Set([
      ...(state.strategy.configuredTiers ?? []),
      ...(changedTier ? [changedTier] : STRATEGY_TIERS),
    ])].filter((tier) => STRATEGY_TIERS.includes(tier));
    for (const tier of (changedTier ? [changedTier] : STRATEGY_TIERS)) {
      clearTierAssignment(state.strategy, tier);
    }
  });
}

export async function startStrategyDashboard({
  bullswarmDir, loadInventory, input = process.stdin, output = process.stdout,
  title = 'Bullswarm strategy', promptForAnalysis = false, applyRecommendations = null,
} = {}) {
  output.write(ALT_ON);
  input.setRawMode?.(true);
  input.resume?.();
  let inventory = null;
  let screen = promptForAnalysis ? 'choice' : 'loading';
  let choiceIndex = 0;
  let view = 'providers';
  let providerIndex = 0;
  let modelIndex = 0;
  let tierIndex = 0;
  let search = '';
  let searching = false;
  // In the provider detail, the cursor is on either the reasoning rows (one
  // per tier) or the model matrix below them.
  let focus = 'tiers';
  let reasoningIndex = 0;
  let recommendationOffset = 0;
  let message = '';
  let busy = false;
  let progressLabel = 'Preparing setup';
  let progressHeading = 'Analyzing providers and models…';
  let progressStartedAt = Date.now();
  let progressTimer = null;
  const dimensions = () => ({ width: output.columns ?? 100, height: output.rows ?? 30 });
  const renderChoice = () => output.write(`${CLEAR}${renderSetupChoice({
    selected: choiceIndex, title, ...dimensions(),
  })}`);
  const renderProgress = () => output.write(`${CLEAR}${renderAnalysisProgress({
    title, label: progressLabel, heading: progressHeading, startedAt: progressStartedAt, ...dimensions(),
  })}`);
  const renderRecommendations = () => output.write(`${CLEAR}${renderRecommendationReview(inventory, {
    title, offset: recommendationOffset, ...dimensions(),
  })}`);
  const render = () => output.write(`${CLEAR}${renderStrategyDashboard(inventory, {
    view, providerIndex, modelIndex, tierIndex, search, message, title, focus, reasoningIndex, searching,
    ...dimensions(),
  })}`);
  const update = async (refresh = false, showProgress = false, analyze = false, renderAfter = true) => {
    const selectedId = visibleModels(inventory?.providers?.[providerIndex], search)[modelIndex]?.id ?? null;
    if (showProgress) {
      screen = 'loading';
      progressStartedAt = Date.now();
      renderProgress();
    }
    inventory = await loadInventory({
      force: refresh,
      analyze,
      onProgress: (label) => {
        progressLabel = label;
        if (showProgress) renderProgress();
      },
    });
    providerIndex = Math.min(providerIndex, Math.max(0, inventory.providers.length - 1));
    const models = visibleModels(inventory.providers[providerIndex], search);
    const preservedIndex = selectedId ? models.findIndex((model) => model.id === selectedId) : -1;
    modelIndex = preservedIndex >= 0 ? preservedIndex : Math.min(modelIndex, Math.max(0, models.length - 1));
    if (renderAfter) {
      screen = 'dashboard';
      render();
    }
  };
  return await new Promise((resolve, reject) => {
    const finish = (error = null) => {
      if (progressTimer) clearInterval(progressTimer);
      input.off?.('data', onData);
      input.setRawMode?.(false);
      input.pause?.();
      output.write(ALT_OFF);
      if (error) reject(error);
      else resolve(0);
    };
    const beginLoad = async (force, label, analyze = true) => {
      if (busy) return;
      busy = true;
      screen = 'loading';
      progressStartedAt = Date.now();
      progressLabel = label;
      progressHeading = analyze ? 'Analyzing providers and models…' : 'Loading provider and model settings…';
      renderProgress();
      progressTimer = setInterval(renderProgress, 1000);
      try {
        await update(force, true, analyze, !analyze);
        if (analyze) {
          screen = 'recommendations';
          recommendationOffset = 0;
          renderRecommendations();
        }
      } catch (error) {
        finish(error);
      } finally {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        busy = false;
      }
    };
    const handleKey = async (key) => {
      if (key === '\x03') return finish();
      const down = key === '\x1b[B';
      const up = key === '\x1b[A';
      const right = key === '\x1b[C';
      const left = key === '\x1b[D';
      const enter = key === '\r' || key === '\n';
      if (screen === 'choice') {
        if (key === 'q' || key === 'Q') return finish();
        if (down) choiceIndex = Math.min(1, choiceIndex + 1);
        if (up) choiceIndex = Math.max(0, choiceIndex - 1);
        if (enter || right) {
          void beginLoad(
            choiceIndex === 0,
            choiceIndex === 0
              ? 'Starting provider and model analysis'
              : 'Loading current choices for manual configuration',
            choiceIndex === 0,
          );
          return;
        }
        renderChoice();
        return;
      }
      if (screen === 'recommendations') {
        if (key === 'q' || key === 'Q') return finish();
        const details = recommendationLines(inventory);
        const bodyHeight = Math.max(3, (output.rows ?? 30) - 10);
        if (down) recommendationOffset = Math.min(Math.max(0, details.length - bodyHeight), recommendationOffset + 1);
        if (up) recommendationOffset = Math.max(0, recommendationOffset - 1);
        if (key === 'y' || key === 'Y') {
          if (typeof applyRecommendations === 'function') {
            screen = 'loading';
            progressHeading = 'Applying recommended defaults…';
            progressLabel = 'Saving one recommended model per provider and tier';
            progressStartedAt = Date.now();
            renderProgress();
            await applyRecommendations();
            await update(false, false, false, true);
            message = 'Recommended defaults applied; adjust any model with arrows and Enter';
            render();
          }
          return;
        }
        if (key === 'n' || key === 'N') {
          screen = 'dashboard';
          message = 'Recommendations not applied; current choices kept';
          render();
          return;
        }
        renderRecommendations();
        return;
      }
      if (screen === 'loading' || !inventory) return;
      // A saved-change note lasts until the next key, then the key help returns.
      message = '';
      if (searching) {
        if (key === ESC) { search = ''; searching = false; modelIndex = 0; }
        else if (enter || down || up) searching = false;
        else if (key === '\x7f' || key === '\b') { search = search.slice(0, -1); modelIndex = 0; }
        else if (/^[ -~]$/.test(key)) { search += key; modelIndex = 0; }
        render();
        return;
      }
      if (key === 'f' || key === 'F') return finish();
      if (view === 'providers') {
        if (key === 'q' || key === 'Q') return finish();
        if (down) providerIndex = Math.min(inventory.providers.length, providerIndex + 1);
        if (up) providerIndex = Math.max(0, providerIndex - 1);
        if (right || enter) {
          if (providerIndex === inventory.providers.length) return finish();
          if (inventory.providers[providerIndex]) {
            view = 'models'; modelIndex = 0; tierIndex = 0; search = ''; focus = 'tiers'; reasoningIndex = 0;
          }
        }
        if (key === ' ') {
          const provider = inventory.providers[providerIndex];
          if (provider) {
            persistProvider(bullswarmDir, provider.name, !provider.enabled);
            message = `${provider.name} ${provider.enabled ? 'disabled' : 'enabled'}`;
            await update();
            return;
          }
        }
      } else {
        const provider = inventory.providers[providerIndex];
        const models = visibleModels(provider, search);
        const model = models[modelIndex];
        if (key === ESC) {
          if (search) { search = ''; modelIndex = 0; }
          else view = 'providers';
        }
        if (key === '/') {
          focus = 'models';
          searching = true;
          render();
          return;
        }
        if (focus === 'tiers') {
          const rows = reasoningRows(provider);
          reasoningIndex = Math.min(reasoningIndex, rows.length - 1);
          if (up) reasoningIndex = Math.max(0, reasoningIndex - 1);
          if (down) {
            if (reasoningIndex < rows.length - 1) reasoningIndex += 1;
            else if (models.length) { focus = 'models'; modelIndex = 0; }
          }
          const back = key === '\x7f' || key === '\b';
          if (left || right || back) {
            const { tier, model: rowModel } = rows[reasoningIndex];
            const choices = reasoningChoices(provider);
            if (!choices.length) {
              message = `${provider.name} has no reasoning setting to change`;
              render();
              return;
            }
            // Step from the level the row shows, so → on "auto (xhigh)" gives
            // max, not the first choice; Backspace returns the row to auto.
            const shown = tierReasoning(inventory, provider, tier, rowModel);
            const from = shown.stored ?? (choices.includes(shown.level) ? shown.level : null);
            const current = Math.max(0, choices.indexOf(from));
            const next = back ? null : choices[Math.max(1, Math.min(choices.length - 1, current + (right ? 1 : -1)))];
            if (next !== shown.stored) {
              persistReasoning(bullswarmDir, provider.name, tier, next, rowModel);
              const where = rowModel ? `${provider.name}/${rowModel} ${tier}` : `${provider.name} ${tier}`;
              message = `${where}: reasoning ${next ?? (rowModel ? `same as ${tier}` : 'auto')} (saved)`;
              await update();
              return;
            }
          }
        } else {
          if (down) modelIndex = Math.min(Math.max(0, models.length - 1), modelIndex + 1);
          if (up) {
            if (modelIndex > 0) modelIndex -= 1;
            else { focus = 'tiers'; reasoningIndex = reasoningRows(provider).length - 1; }
          }
          if (left) tierIndex = Math.max(0, tierIndex - 1);
          if (right) tierIndex = Math.min(STRATEGY_TIERS.length - 1, tierIndex + 1);
          if (model && (enter || key === ' ')) {
            const tier = STRATEGY_TIERS[tierIndex];
            const current = effectiveModelTiers(model);
            const tiers = current.includes(tier)
              ? current.filter((entry) => entry !== tier)
              : [...current, tier];
            persistModel(bullswarmDir, inventory, provider.name, model.id, tiers, tier, tiers.length === 0);
            message = `${model.id}: ${tiers.length ? tiers.join(', ') : 'off'} (saved)`;
            await update();
            return;
          }
        }
      }
      if (key === '\x12') {
        await beginLoad(true, 'Refreshing providers, models, and live usage');
        message = 'Live analysis refreshed'; render(); return;
      }
      render();
    };
    const onData = async (chunk) => {
      for (const key of inputKeys(chunk)) await handleKey(key);
    };
    input.on('data', onData);
    if (screen === 'choice') renderChoice();
    else void beginLoad(true, 'Starting provider and model analysis');
  });
}
