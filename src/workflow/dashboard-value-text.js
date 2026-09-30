// The short texts one value is painted as: a clock, bytes, a duration, money,
// minutes, an age, an attempt's usage and tokens, and its reasoning level.
import { formatDashboardValue } from './dash-kit.js';
import { formatMoneyPair } from '../lib/usage-basis.js';
import { tokenSourceOf } from './metrics.js';

function compactUsage(usage) {
  if (!usage) return 'usage pending';
  const tokens = usage.tokens ?? {};
  const tokenText = `tokens read=${tokens.standardRead ?? '?'} cache-read=${tokens.cacheRead ?? '?'} cache-write=${tokens.cacheWrite ?? '?'} output=${tokens.output ?? '?'}`;
  const cost = formatMoneyPair({
    api: usage.api ?? { usd: usage.cost?.estimatedUsd ?? null, tokenSource: usage.tokenSource },
    subscription: usage.subscription,
    tokenSource: usage.tokenSource,
    tokens,
  });
  const quota = usage.normalizedQuota?.estimatedPercent == null
    ? usage.normalizedQuota?.knownSubtotalPercent != null
      ? `quota≥${usage.normalizedQuota.knownSubtotalPercent}% (partial)` : 'quota=?'
    : `quota≈${usage.normalizedQuota.estimatedPercent}%`;
  return `${tokenText} · ${cost} · ${quota}`;
}

function tokenText(usage) {
  const tokens = usage?.tokens;
  if (!tokens) return '';
  const reported = tokens.totalKnown;
  const total = Number.isFinite(reported)
    ? reported
    : ['standardRead', 'cacheRead', 'cacheWrite', 'output']
      .map((key) => tokens[key])
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
  if (!total) return '';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

// The reasoning level an attempt actually ran at, shown next to the model
// because they answer two different questions: which brain, and how hard it
// thought. Absent (older runs, connectors with no reasoning control, or a
// `default` that deliberately passes nothing) renders nothing at all.
export function reasoningText(attempt) {
  const applied = attempt?.reasoning?.applied;
  return typeof applied === 'string' && applied ? applied : '';
}

export function clockText(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function durationText(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return 'time pending';
  const end = Date.parse(finishedAt ?? '') || Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Money, always as the estimate it is. `estimateInvocationUsage` prices the
 * task and output text at API rates with no cache split, so every `$` on this
 * dashboard is an API-equivalent estimate and says so; an amount nobody
 * recorded is null, and the caller paints a blank with the reason.
 */
export function moneyText(value, tokenSource) {
  if (value && typeof value === 'object') {
    if (value.api || Object.hasOwn(value, 'apiUsd') || Object.hasOwn(value, 'apiEquivalentUsd')) {
      return formatMoneyPair({
        api: value.api ?? { usd: value.apiUsd ?? value.apiEquivalentUsd ?? null, tokenSource: value.tokenSource },
        subscription: value.subscription ?? {
          usd: value.subscriptionUsd ?? null,
          deltaPct: value.subscriptionDeltaPct ?? null,
          window: value.subscriptionWindow ?? null,
          basis: value.subscriptionBasis ?? 'unknown:no-meter',
        },
        tokenSource: value.tokenSource,
        tokens: value.tokens ?? null,
      });
    }
    return formatMoneyPair(value);
  }
  return formatMoneyPair({
    api: { usd: value, tokenSource: tokenSourceOf(tokenSource, value) },
    subscription: null,
  });
}

export function minutesText(value) {
  return formatDashboardValue(value, 'minutes');
}

/** `42m` / `2h05m` since an ISO time. */
function ageText(iso, nowMs) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins)) return '';
  return minutesText(mins) ?? '';
}

/** `19:22` in the reader's own zone, for an ETA or a milestone. */
function clockAt(ms) {
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export {
  compactUsage,
  tokenText,
  ageText,
  clockAt,
};
