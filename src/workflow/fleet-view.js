// Fleet page rendering: the read-only strategy rungs grouped by lane or
// provider.  Setup remains the edit control centre; this page emits only the
// documented { kind: 'edit' } region for it.

import { glyphs } from '../lib/glyphs.js';
import { STRATEGY_TIERS } from '../lib/strategy.js';
import { untilText } from './usage-view.js';

const SGR = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

const LANE_BLURB = Object.freeze({
  high: 'integration · architecture · adversarial-acceptance',
  medium: 'implement · check (the ordinary writers)',
  low: 'mechanical · io-read · digest',
});

function columns(width) {
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

function wrapLine(text, width) {
  const source = String(text ?? '');
  const cols = columns(width);
  if (visibleLength(source) <= cols) return [source];
  const out = [];
  let rest = source.replace(SGR, '');
  while (rest.length > cols) {
    // The last space that still fits; a hard cut only for a single word
    // longer than the frame.  See the same fix in budget-view.js.
    let at = rest.lastIndexOf(' ', cols);
    if (at <= 0) at = cols;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest || !out.length) out.push(rest);
  return out;
}

function pushText(lines, text, width) {
  for (const line of wrapLine(text, width)) lines.push(line);
}

// The defensive wrap pass can split a line and push every row below it down,
// so each region's `y` is remapped onto the first row its line became, and a
// region whose row no longer reaches it is dropped rather than misplaced.
function placed(lines, regions, cols) {
  const safe = [];
  const movedTo = [];
  for (const line of lines) {
    movedTo.push(safe.length + 1);
    for (const part of wrapLine(line, cols)) safe.push(part);
  }
  return {
    lines: safe,
    regions: regions
      .map((region) => ({ ...region, y: movedTo[region.y - 1] ?? region.y }))
      .filter((region) => region.x >= 1 && region.x + region.width - 1 <= cols
        && visibleLength(safe[region.y - 1] ?? '') >= region.x + region.width - 1),
  };
}

function tint(text, code, ansi) {
  return ansi ? `${code}${text}${RESET}` : String(text ?? '');
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
  return [
    window,
    used && elapsed ? `${used} of ${elapsed}` : (used || elapsed || 'no meter'),
    reset,
    pool?.quarantine ? 'quarantined' : null,
    lanes,
  ].filter(Boolean).join(' · ');
}

function laneGroups(pools, rungs) {
  const groups = [];
  for (const tier of STRATEGY_TIERS) {
    const rows = pools
      .map((pool) => ({ sub: pool.name, rung: rungFor(rungs, pool, tier) }))
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
 * Render Fleet.  Tabs are keyboard-controlled by the shell, so this module
 * does not invent a tab action kind; the edit control is the sole non-run
 * region emitted by the page.
 */
export function fleetLines(
  pools,
  rungs,
  { width = 120, by = 'lane', nowMs = Date.now(), ansi = true } = {},
) {
  const cols = columns(width);
  const lines = [];
  const regions = [];
  const visible = enabledPools(pools);
  const groups = by === 'provider'
    ? providerGroups(visible, rungs, nowMs)
    : laneGroups(visible, rungs);

  // The active marker comes from the shared glyph table, so ASCII mode
  // substitutes it here exactly as it does on every other page.
  const mark = glyphs().ongoing;
  pushText(lines, by === 'provider' ? `[by lane] [${mark} by provider]` : `[${mark} by lane] [by provider]`, cols);
  // Keeping the edit button on its own line makes its hit region stable on a
  // 55-column terminal and leaves the note visibly attached to it.
  lines.push('[edit] read-only here · edit opens bullswarm setup');
  regions.push({ x: 1, y: lines.length, width: 6, action: { kind: 'edit' } });
  lines.push('');

  if (!groups.length) {
    pushText(lines, 'No configured fleet rungs are available.', cols);
    return placed(lines, regions, cols);
  }

  const subWidth = Math.max(16, ...groups.flatMap((group) => (
    group.rows.map((row) => String(row.sub ?? '').length + 1)
  )));
  for (const group of groups) {
    pushText(lines, tint(`${group.title}${group.blurb ? ` · ${group.blurb}` : ''}`, BOLD, ansi), cols);
    for (const row of group.rows) {
      const sub = String(row.sub ?? '').padEnd(subWidth).slice(0, subWidth);
      const model = tint(shortModel(modelOf(row.rung)), CYAN, ansi);
      const reasoning = reasoningOf(row.rung);
      pushText(lines, `  ${sub}${model}${reasoning ? ` · ${reasoning}` : ''}`, cols);
      pushText(lines, tint(`${' '.repeat(subWidth + 2)}${recordOf(row.rung)}`, DIM, ansi), cols);
    }
    lines.push('');
  }

  return placed(lines, regions, cols);
}
