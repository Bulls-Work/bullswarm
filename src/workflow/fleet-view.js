// Fleet page rendering: the read-only strategy rungs grouped by lane or
// provider. Setup remains the edit control centre; this page emits the
// documented { kind: 'edit' } region and the existing tab actions for it.

import { STRATEGY_TIERS } from '../lib/strategy.js';
import { METER_COLORS, untilText } from './usage-view.js';
import { columns, compactRow, cut, tabsRow } from './dash-kit.js';

const SGR = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const UNDERLINE = '\x1b[4m';
const NO_UNDERLINE = '\x1b[24m';

const FLEET_TABS = Object.freeze([
  { id: 'lane', label: 'by lane', key: null },
  { id: 'provider', label: 'by provider', key: null },
]);

const LANE_BLURB = Object.freeze({
  high: 'integration · architecture · adversarial-acceptance',
  medium: 'implement · check (the ordinary writers)',
  low: 'mechanical · io-read · digest',
});

function widthOf(width) {
  const value = Number(width);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 120;
}

function visibleLength(text) {
  return String(text ?? '').replace(SGR, '').length;
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberText(value, places = 0) {
  const number = finite(value);
  if (number == null) return null;
  return number.toFixed(places).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function tint(text, code, ansi) {
  return ansi ? `${code}${text}${RESET}` : String(text ?? '');
}

function rgbOf(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function fgOf(hex) {
  return `\x1b[38;2;${rgbOf(hex).join(';')}m`;
}

function painted(text, color, ansi) {
  return tint(text, fgOf(color), ansi);
}

function clean(text, ansi) {
  return ansi ? String(text ?? '') : String(text ?? '').replace(SGR, '');
}

function fleetPhoneRow(sub, model, reasoning, record, cols, ansi) {
  return compactRow([
    { text: ` ${sub}`, width: Math.min(15, Math.floor(cols / 4)) },
    { text: painted(`${model}${reasoning ? ` · ${reasoning}` : ''}`, METER_COLORS.cyan, ansi), width: Math.max(8, Math.floor(cols / 3)) },
    { text: painted(record, METER_COLORS.dim, ansi), grow: true, min: 4 },
  ], { width: cols, gap: 1 });
}

function fit(text, width, ansi) {
  return clean(cut(text, width), ansi);
}

function underlined(text, ansi) {
  return ansi ? `${UNDERLINE}${text}${NO_UNDERLINE}` : String(text ?? '');
}

function enabledPools(pools) {
  return (Array.isArray(pools) ? pools : [])
    .filter((pool) => pool && pool.enabled !== false);
}

function rungFor(rungs, pool, tier) {
  return (Array.isArray(rungs) ? rungs : []).find((rung) => (
    rung?.pool === pool?.name && rung?.tier === tier
  )) ?? null;
}

function modelOf(rung) {
  return rung?.model ?? rung?.modelName ?? null;
}

function shortModel(model) {
  return model ? String(model).split('/').pop() : '—';
}

function reasoningOf(rung) {
  return rung?.reasoning?.applied ?? rung?.reasoning ?? rung?.level ?? null;
}

function recordOf(rung) {
  const record = rung?.record && typeof rung.record === 'object' ? rung.record : rung;
  const dispatches = finite(record?.dispatches);
  const okShare = finite(record?.okShare);
  const medianMinutes = finite(record?.medianMinutes);
  if (!(dispatches > 0)) return 'no runs yet';
  const parts = [`${numberText(dispatches)} run${dispatches === 1 ? '' : 's'}`];
  if (okShare != null) parts.push(`${numberText(okShare * 100)}% ok`);
  if (medianMinutes != null) parts.push(`p50 ${numberText(medianMinutes)}m`);
  return parts.join(' · ');
}

function benchReasonOf(pool) {
  return pool?.bench?.reason ? String(pool.bench.reason) : null;
}

function poolBlurb(pool, nowMs) {
  const window = pool?.pacingWindow === 'monthly' || pool?.pacingWindow === 'weekly'
    ? `${pool.pacingWindow} window`
    : null;
  const used = pool?.usedPct == null ? null : `${numberText(pool.usedPct)}% used`;
  const elapsed = pool?.elapsedPct == null ? null : `${numberText(pool.elapsedPct)}% elapsed`;
  const resetAt = pool?.paceResetsAt ?? pool?.resetsAt ?? null;
  const reset = resetAt ? `resets ${untilText(resetAt, nowMs)}` : null;
  const lanes = Array.isArray(pool?.incumbentLane) && pool.incumbentLane.length
    ? `incumbent for ${pool.incumbentLane.join('/')}`
    : null;
  const bench = pool?.bench?.reason
    ? (pool.bench.until != null
      ? `benched (${pool.bench.reason})`
      : `strike (${pool.bench.reason})`)
    : null;
  return [
    window,
    used && elapsed ? `${used} of ${elapsed}` : (used || elapsed || 'no meter'),
    reset,
    pool?.quarantine ? 'quarantined' : null,
    bench,
    lanes,
  ].filter(Boolean).join(' · ');
}

function laneGroups(pools, rungs) {
  const groups = [];
  for (const tier of STRATEGY_TIERS) {
    const rows = pools
      .map((pool) => ({ sub: pool.name, pool, rung: rungFor(rungs, pool, tier) }))
      .filter(({ rung }) => modelOf(rung));
    if (rows.length) groups.push({ title: tier, blurb: LANE_BLURB[tier] ?? '', rows });
  }
  return groups;
}

function providerGroups(pools, rungs, nowMs) {
  const groups = [];
  for (const pool of pools) {
    const rows = STRATEGY_TIERS
      .map((tier) => ({ sub: tier, rung: rungFor(rungs, pool, tier) }))
      .filter(({ rung }) => modelOf(rung));
    if (rows.length) groups.push({ title: pool.name, blurb: poolBlurb(pool, nowMs), rows });
  }
  return groups;
}

/**
 * Render Fleet. The shell still owns keyboard navigation, while this view
 * records the same tab actions for mouse hits and keeps the edit control's
 * existing action kind.
 */
export function fleetLines(
  pools,
  rungs,
  { width = 120, by = 'lane', nowMs = Date.now(), ansi = true } = {},
) {
  const cols = widthOf(width);
  const lines = [];
  const regions = [];
  const visible = enabledPools(pools);
  const byLane = by === 'provider' ? 'provider' : 'lane';
  const groups = byLane === 'provider'
    ? providerGroups(visible, rungs, nowMs)
    : laneGroups(visible, rungs);
  const sideBySide = cols >= 200;

  // `tabsRow` owns the same 1-based region arithmetic as every other page.
  // Fleet's prototype uses plain labels (the active one is still inverted by
  // the kit), not bracketed labels, and puts the edit affordance on this same
  // row.  The note is intentionally omitted in the phone layout: the button
  // itself is the complete hint at 55 columns, as in the captured frame.
  const nav = tabsRow(FLEET_TABS, {
    active: by === 'provider' ? 'provider' : 'lane',
    width: sideBySide ? 100 : cols,
    action: (item) => ({ kind: 'tab', tab: item.id }),
  });
  const navText = clean(nav.text, ansi);
  const editText = `[ ${underlined('e', ansi)}dit ]`;
  const note = cols >= 100
    ? ` ${painted('read-only here · edit opens bullswarm setup', METER_COLORS.dim, ansi)}`
    : '';
  const editX = visibleLength(navText) + 3 + 1;
  const subTabs = fit(`${navText}${' '.repeat(3)}${editText}${note}`, cols, ansi);
  lines.push(subTabs);
  for (const region of nav.regions) {
    if (region.x + region.width - 1 <= visibleLength(subTabs)) {
      regions.push({ x: region.x, y: lines.length, width: region.width, action: region.action });
    }
  }
  if (editX + 8 - 1 <= visibleLength(subTabs)) {
    regions.push({ x: editX, y: lines.length, width: 8, action: { kind: 'edit' } });
  }
  lines.push('');

  if (!groups.length) {
    lines.push(fit('No configured fleet rungs are available.', cols, ansi));
    return { lines, regions };
  }

  // The phone keeps one row per pool — pool, model and record share it, cut
  // rather than wrapped, as the prototype's own frame does.  At 200 the two
  // tab views sit beside each other so the frame's width is not wasted.
  if (cols < 80) {
    for (const group of groups) {
      const heading = `${tint(group.title, BOLD, ansi)}${group.blurb
        ? ` ${painted(`· ${group.blurb}`, METER_COLORS.dim, ansi)}`
        : ''}`;
      lines.push(fit(heading, cols, ansi));
      for (const row of group.rows) {
        const sub = String(row.sub ?? '');
        const model = shortModel(modelOf(row.rung));
        const reasoning = reasoningOf(row.rung);
        const bench = benchReasonOf(row.pool);
        const record = bench ? `${recordOf(row.rung)} · ${bench}` : recordOf(row.rung);
        lines.push(fit(fleetPhoneRow(sub, model, reasoning, record, cols, ansi), cols, ansi));
      }
      lines.push('');
    }
    return { lines, regions };
  }

  const groupLines = (group, width) => {
    const out = [];
    const heading = `${tint(group.title, BOLD, ansi)}${group.blurb
      ? ` ${painted(`· ${group.blurb}`, METER_COLORS.dim, ansi)}`
      : ''}`;
    out.push(fit(heading, width, ansi));
    const subWidth = Math.max(16, ...group.rows.map((row) => String(row.sub ?? '').length + 1));
    for (const row of group.rows) {
      const sub = String(row.sub ?? '').padEnd(subWidth).slice(0, subWidth);
      const model = painted(shortModel(modelOf(row.rung)), METER_COLORS.cyan, ansi);
      const reasoning = reasoningOf(row.rung);
      const bench = benchReasonOf(row.pool);
      out.push(fit(`  ${sub}${model}${reasoning ? ` · ${reasoning}` : ''}${bench ? ` · ${bench}` : ''}`, width, ansi));
      out.push(fit(painted(`${' '.repeat(subWidth + 2)}${recordOf(row.rung)}`, METER_COLORS.dim, ansi), width, ansi));
    }
    return out;
  };

  if (sideBySide && byLane === 'lane') {
    // The 200-column frame shows both compositions at once: by lane on the
    // left, by provider beside it, neither one capped below the frame width.
    const laneLines = laneGroups(visible, rungs).map((group) => groupLines(group, Math.floor(cols / 2) - 2, ansi));
    const providerLines = providerGroups(visible, rungs, nowMs).map((group) => groupLines(group, Math.floor(cols / 2) - 2, ansi));
    const left = laneLines.flat();
    const right = providerLines.flat();
    const rows = Math.max(left.length, right.length);
    for (let index = 0; index < rows; index += 1) {
      lines.push(fit(compactRow([
        { text: left[index] ?? '', width: Math.floor(cols / 2) - 2 },
        { text: right[index] ?? '', grow: true, min: 1 },
      ], { width: cols, gap: 4 }), cols, ansi));
    }
  } else {
    for (const group of groups) lines.push(...groupLines(group, cols, ansi));
  }

  return { lines, regions };
}
