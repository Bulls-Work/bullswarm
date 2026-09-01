import { loadState, saveState } from './lib/state.js';
import { STRATEGY_TIERS, setModelDisabled, setModelTierSelection } from './lib/strategy.js';

const ESC = '\x1b';
const CLEAR = '\x1b[2J\x1b[H';
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';

function clip(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value, width) {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function tierMark(model, tier) {
  return model.tiers.includes(tier) ? tier[0].toUpperCase() : '·';
}

function providerLines(inventory, selected, width) {
  return inventory.providers.map((provider, index) => {
    const marker = index === selected ? '›' : ' ';
    const enabled = provider.enabled ? '●' : '○';
    const meter = provider.usedPct == null ? 'usage ?' : `${provider.usedPct}% used`;
    return `${marker} ${enabled} ${pad(provider.name, Math.max(8, width - 25))} ${pad(meter, 10)} ${provider.models.length} models`;
  });
}

function modelLines(provider, selected, width) {
  return provider.models.map((model, index) => {
    const marker = index === selected ? '›' : ' ';
    const tiers = model.disabled ? 'OFF' : STRATEGY_TIERS.map((tier) => tierMark(model, tier)).join('');
    const automatic = model.effectiveTiers.filter((tier) => !model.tiers.includes(tier));
    const current = automatic.length ? `auto:${automatic.map((tier) => tier[0].toUpperCase()).join('')}` : '';
    return `${marker} [${tiers}] ${pad(model.id, Math.max(10, width - 22))} ${current}`.trimEnd();
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
  title = 'Bullswarm strategy',
} = {}) {
  const narrow = width < 78;
  const provider = inventory.providers[providerIndex] ?? null;
  const lines = [
    `${title} · ${inventory.providers.filter((p) => p.enabled).length}/${inventory.providers.length} providers on · live routing preview`,
    '',
  ];
  const bodyHeight = Math.max(4, height - 11);
  if (narrow) {
    if (view === 'providers') {
      lines.push('Providers · Space toggle · Enter/→ models');
      lines.push(...selectedWindow(providerLines(inventory, providerIndex, width), providerIndex, bodyHeight - 1));
    } else {
      lines.push(`Models · ${provider?.name ?? 'none'} · ${provider?.enabled ? 'provider on' : 'provider off'}`);
      lines.push('H/M/L toggle tiers · X turns model off');
      const models = provider?.models.length ? modelLines(provider, modelIndex, width) : ['  No models detected.'];
      lines.push(...selectedWindow(models, modelIndex, bodyHeight - 2));
    }
  } else {
    const leftWidth = Math.min(40, Math.floor(width * 0.38));
    const rightWidth = width - leftWidth - 3;
    const left = [
      `Providers${view === 'providers' ? ' · focused' : ''}`,
      ...selectedWindow(providerLines(inventory, providerIndex, leftWidth), providerIndex, bodyHeight - 1),
    ];
    const models = provider?.models.length ? modelLines(provider, modelIndex, rightWidth) : ['  No models detected.'];
    const right = [
      `Models · ${provider?.name ?? 'none'}${view === 'models' ? ' · focused' : ''}`,
      ...selectedWindow(models, modelIndex, bodyHeight - 1),
    ];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(`${pad(left[i] ?? '', leftWidth)} │ ${clip(right[i] ?? '', rightWidth)}`);
    }
  }
  lines.push('', 'Effective choices now');
  lines.push(...routeLines(inventory));
  lines.push('', message || (view === 'providers'
    ? '↑/↓ select · Space enable/disable · Enter/→ models · R refresh · Q quit'
    : '↑/↓ select · H/M/L assign · X off · Esc/← providers · R refresh · Q quit'));
  return lines.slice(0, Math.max(8, height)).map((line) => clip(line, width)).join('\n');
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
  title = 'Bullswarm strategy',
} = {}) {
  output.write(`${ALT_ON}${CLEAR}${title}\n\nDiscovering providers, models, and live usage…`);
  input.setRawMode?.(true);
  input.resume?.();
  let inventory;
  try {
    inventory = await loadInventory({ force: true });
  } catch (error) {
    input.setRawMode?.(false);
    input.pause?.();
    output.write(ALT_OFF);
    throw error;
  }
  let view = 'providers';
  let providerIndex = 0;
  let modelIndex = 0;
  let message = '';
  const render = () => output.write(`${CLEAR}${renderStrategyDashboard(inventory, {
    view, providerIndex, modelIndex, width: output.columns ?? 100, height: output.rows ?? 30, message, title,
  })}`);
  const update = async (refresh = false) => {
    inventory = await loadInventory({ force: refresh });
    providerIndex = Math.min(providerIndex, Math.max(0, inventory.providers.length - 1));
    modelIndex = Math.min(modelIndex, Math.max(0, (inventory.providers[providerIndex]?.models.length ?? 1) - 1));
    render();
  };
  render();
  return await new Promise((resolve) => {
    const finish = () => {
      input.off?.('data', onData);
      input.setRawMode?.(false);
      input.pause?.();
      output.write(ALT_OFF);
      resolve(0);
    };
    const onData = async (chunk) => {
      const key = String(chunk);
      if (key === 'q' || key === 'Q' || key === '\x03') return finish();
      const down = key === '\x1b[B';
      const up = key === '\x1b[A';
      const right = key === '\x1b[C' || key === '\r' || key === '\n';
      const left = key === '\x1b[D' || key === ESC;
      if (view === 'providers') {
        if (down) providerIndex = Math.min(inventory.providers.length - 1, providerIndex + 1);
        if (up) providerIndex = Math.max(0, providerIndex - 1);
        if (right && inventory.providers[providerIndex]) { view = 'models'; modelIndex = 0; }
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
        const model = provider?.models[modelIndex];
        if (down) modelIndex = Math.min((provider?.models.length ?? 1) - 1, modelIndex + 1);
        if (up) modelIndex = Math.max(0, modelIndex - 1);
        if (left) view = 'providers';
        const tier = ({ h: 'high', H: 'high', m: 'medium', M: 'medium', l: 'low', L: 'low' })[key];
        if (model && (tier || key === 'x' || key === 'X')) {
          const tiers = key === 'x' || key === 'X'
            ? []
            : model.tiers.includes(tier) ? model.tiers.filter((entry) => entry !== tier) : [...model.tiers, tier];
          persistModel(bullswarmDir, inventory, provider.name, model.id, tiers, tier, key === 'x' || key === 'X');
          message = `${model.id}: ${tiers.length ? tiers.join(', ') : 'off'}`;
          await update();
          return;
        }
      }
      if (key === 'r' || key === 'R') {
        message = 'Refreshing providers, models, and meters…'; render();
        await update(true); message = 'Live discovery refreshed'; render(); return;
      }
      render();
    };
    input.on('data', onData);
  });
}
