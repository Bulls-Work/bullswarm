import { loadState, saveState } from './lib/state.js';
import { STRATEGY_TIERS, setModelDisabled, setModelTierSelection } from './lib/strategy.js';

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
    const enabled = provider.enabled ? '●' : '○';
    const meter = provider.usedPct == null ? 'usage ?' : `${provider.usedPct}% used`;
    return `${marker} ${enabled} ${pad(provider.name, Math.max(8, width - 25))} ${pad(meter, 10)} ${provider.models.length} models`;
  });
  const selectedFinish = selected === inventory.providers.length;
  lines.push(`${selectedFinish ? '›' : ' '} ${selectedFinish ? INVERSE_ON : ''}✓ Finish setup${selectedFinish ? INVERSE_OFF : ''}`);
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

function tierCell(model, tier, selected) {
  const enabled = effectiveModelTiers(model).includes(tier);
  const label = `${enabled ? '✓' : ' '} ${tier[0].toUpperCase()}${tier.slice(1)}`;
  const cell = `[${label}]`;
  return selected ? `${INVERSE_ON}${cell}${INVERSE_OFF}` : cell;
}

function modelLines(models, selected, selectedTier, width, focused = true) {
  const tierWidth = 32;
  return models.map((model, index) => {
    const marker = index === selected ? '›' : ' ';
    const cells = STRATEGY_TIERS.map((tier, tierIndex) => tierCell(
      model, tier, focused && index === selected && tierIndex === selectedTier,
    )).join(' ');
    return `${marker} ${pad(model.id, Math.max(8, width - tierWidth))} ${cells}`;
  });
}

function routeLines(inventory) {
  return STRATEGY_TIERS.map((tier) => {
    const route = inventory.routes[tier];
    const label = `${tier[0].toUpperCase()}${tier.slice(1)}`.padEnd(6);
    return route?.pool
      ? `${label} ${route.lane.padEnd(7)} → ${route.pool}/${route.model ?? 'provider default'} · surplus ${route.surplus ?? '?'}`
      : `${label} ${route?.lane?.padEnd(7) ?? ''} → unavailable${route?.reason ? ` · ${route.reason}` : ''}`;
  });
}

function selectedWindow(lines, selected, count) {
  if (lines.length <= count) return lines;
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), lines.length - count));
  return lines.slice(start, start + count);
}

export function renderStrategyDashboard(inventory, {
  view = 'providers', providerIndex = 0, modelIndex = 0, width = 100, height = 30, message = '',
  title = 'Bullswarm strategy', tierIndex = 0, search = '',
} = {}) {
  const narrow = width < 78;
  const provider = inventory.providers[providerIndex] ?? null;
  const lines = [
    `${title} · ${inventory.providers.filter((p) => p.enabled).length}/${inventory.providers.length} providers on · live routing preview`,
    '',
  ];
  const bodyHeight = Math.max(4, height - 11);
  const models = visibleModels(provider, search);
  if (narrow) {
    if (view === 'providers') {
      lines.push('Providers · Space toggle · Enter/→ models');
      lines.push(...selectedWindow(providerLines(inventory, providerIndex, width), providerIndex, bodyHeight - 1));
    } else {
      lines.push(`Models · ${provider?.name ?? 'none'} · ${provider?.enabled ? 'provider on' : 'provider off'}`);
      lines.push(`Search: ${search || 'type to filter'} · ${models.length}/${provider?.models.length ?? 0} models`);
      const rows = models.length ? modelLines(models, modelIndex, tierIndex, width, view === 'models') : ['  No matching models.'];
      lines.push(...selectedWindow(rows, modelIndex, bodyHeight - 2));
    }
  } else {
    const leftWidth = Math.min(40, Math.floor(width * 0.38));
    const rightWidth = width - leftWidth - 3;
    const left = [
      `Providers${view === 'providers' ? ' · focused' : ''}`,
      ...selectedWindow(providerLines(inventory, providerIndex, leftWidth), providerIndex, bodyHeight - 1),
    ];
    const rows = models.length ? modelLines(models, modelIndex, tierIndex, rightWidth, view === 'models') : ['  No matching models.'];
    const right = [
      provider
        ? `Models · ${provider.name}${view === 'models' ? ' · focused' : ''} · Search: ${search || 'type to filter'}`
        : 'Setup ready · press Enter to finish',
      ...(provider ? selectedWindow(rows, modelIndex, bodyHeight - 1) : []),
    ];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(`${pad(left[i] ?? '', leftWidth)} │ ${clip(right[i] ?? '', rightWidth)}`);
    }
  }
  lines.push('', 'Effective choices now');
  lines.push(...routeLines(inventory));
  lines.push('', message || (view === 'providers'
    ? '↑/↓ select · Space enable/disable · Enter/→ open · F finish · Ctrl+R refresh'
    : '↑/↓ model · ←/→ tier · Enter toggle · type search · Backspace · Esc providers · F finish'));
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
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][seconds % 10];
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
  const external = candidate?.openRouter;
  if (!external) return 'local provider capability and cost profile';
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
    ? `$${input}/$${output} per 1M input/output tokens` : null;
  return [...qualityParts, price].filter(Boolean).join(' · ') || 'listed in the Bullswarm benchmark datapack';
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
        reason: recommendationReason(candidate),
      };
    }).filter(Boolean);
    if (!choices.length) continue;
    lines.push(`${provider.name}`);
    for (const choice of choices) {
      lines.push(`  ${choice.tier[0].toUpperCase()}  ${choice.model}`);
      lines.push(`     ${choice.reason}`);
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
    : 'Quality uses OpenRouter agentic, coding, and intelligence indices; API price guides budget.';
  const details = recommendationLines(inventory);
  const bodyHeight = Math.max(3, height - 9);
  const start = Math.max(0, Math.min(offset, Math.max(0, details.length - bodyHeight)));
  const shown = details.slice(start, start + bodyHeight);
  const lines = [
    title,
    '',
    'Recommended defaults · one model per provider and tier',
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

function persistProvider(bullswarmDir, pool, enabled) {
  const state = loadState(bullswarmDir);
  state.pools[pool] ??= {};
  state.pools[pool].enabled = enabled;
  saveState(bullswarmDir, state);
}

function persistModel(bullswarmDir, inventory, pool, model, tiers, changedTier = null, disabled = false) {
  const state = loadState(bullswarmDir);
  state.strategy ??= {};
  if (disabled) {
    setModelDisabled(state.strategy, pool, model, true);
    setModelTierSelection(state.strategy, pool, model, []);
    saveState(bullswarmDir, state);
    return;
  }
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
    if (state.strategy.assignments) delete state.strategy.assignments[tier];
  }
  saveState(bullswarmDir, state);
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
    view, providerIndex, modelIndex, tierIndex, search, message, title, ...dimensions(),
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
        const bodyHeight = Math.max(3, (output.rows ?? 30) - 9);
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
      if (key === 'f' || key === 'F') return finish();
      if (view === 'providers') {
        if (key === 'q' || key === 'Q') return finish();
        if (down) providerIndex = Math.min(inventory.providers.length, providerIndex + 1);
        if (up) providerIndex = Math.max(0, providerIndex - 1);
        if (right || enter) {
          if (providerIndex === inventory.providers.length) return finish();
          if (inventory.providers[providerIndex]) {
            view = 'models'; modelIndex = 0; tierIndex = 0; search = '';
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
        if (down) modelIndex = Math.min(Math.max(0, models.length - 1), modelIndex + 1);
        if (up) modelIndex = Math.max(0, modelIndex - 1);
        if (left) tierIndex = Math.max(0, tierIndex - 1);
        if (right) tierIndex = Math.min(STRATEGY_TIERS.length - 1, tierIndex + 1);
        if (key === ESC) {
          if (search) { search = ''; modelIndex = 0; }
          else view = 'providers';
        }
        if (key === '\x7f' || key === '\b') {
          search = search.slice(0, -1);
          modelIndex = 0;
        } else if (/^[a-zA-Z0-9._:/~-]$/.test(key)) {
          search += key;
          modelIndex = 0;
        }
        if (model && (enter || key === ' ')) {
          const tier = STRATEGY_TIERS[tierIndex];
          const current = effectiveModelTiers(model);
          const tiers = current.includes(tier)
            ? current.filter((entry) => entry !== tier)
            : [...current, tier];
          persistModel(bullswarmDir, inventory, provider.name, model.id, tiers, tier, tiers.length === 0);
          message = `${model.id}: ${tiers.length ? tiers.join(', ') : 'off'}`;
          await update();
          return;
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
