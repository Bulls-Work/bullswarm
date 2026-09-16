// Budget page rendering for the terminal dashboard.
//
// The arithmetic belongs to budget-model.js.  This module only turns that
// measured/labelled result into lines.  In particular, it never turns a
// missing price, rate, or recorded estimate into zero, and it never derives a
// subscription figure from an API-equivalent estimate.

import { shareBar } from './dash-kit.js';
import { meterBar } from './usage-view.js';

const SGR = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const COMMAND = 'bullswarm strategy set-subscription <pool> --monthly-usd <amount>';

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

function numberText(value, places = 2) {
  const number = finite(value);
  if (number == null) return null;
  return number.toFixed(places).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function pctText(value) {
  const text = numberText(value, 2);
  return text == null ? '—' : `${text}%`;
}

function moneyText(value) {
  const text = numberText(value, 6);
  return text == null ? null : `$${text}`;
}

function stripMarkup(text) {
  return String(text ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wrap a line without ever painting past the requested frame.  Page atoms
 * that contain ANSI are already whole-width (meters and share bars); the
 * prose lines are plain, so cutting at a word boundary is sufficient here.
 */
function wrapLine(text, width) {
  const source = String(text ?? '');
  const cols = columns(width);
  if (visibleLength(source) <= cols) return [source];
  const out = [];
  let rest = source;
  while (visibleLength(rest) > cols) {
    const visible = rest.replace(SGR, '');
    // Break on the last space that still fits.  Searching from `cols + 1`
    // used to accept a space one column past the frame and then fall back to
    // a hard cut at `cols`, which split a word ("recorded, no" / "t an
    // invoice").  Only a single word longer than the frame is cut now.
    let at = visible.lastIndexOf(' ', cols);
    if (at <= 0) at = cols;
    out.push(visible.slice(0, at).trimEnd());
    rest = visible.slice(at).trimStart();
  }
  if (rest || !out.length) out.push(rest);
  return out;
}

function pushText(lines, text, width) {
  for (const line of wrapLine(text, width)) lines.push(line);
}

function tint(text, code, ansi) {
  return ansi ? `${code}${text}${RESET}` : String(text ?? '');
}

function rowsOf(budget) {
  if (Array.isArray(budget)) return budget;
  if (Array.isArray(budget?.rows)) return budget.rows;
  if (budget?.rows && typeof budget.rows === 'object') return Object.values(budget.rows);
  if (Array.isArray(budget?.pools)) return budget.pools;
  return [];
}

function planLabel(row) {
  const raw = row?.planType ?? row?.plan ?? row?.subscription?.plan ?? null;
  if (raw == null || String(raw).trim() === '') return 'plan not declared';
  const text = String(raw).trim();
  const max = text.match(/^max[-_ ]?(\d+)x?$/i);
  if (max) return `Max ${max[1]}x`;
  return text.length ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function windowLabel(row) {
  const text = row?.window ?? row?.pacingWindow ?? null;
  return text == null || String(text).trim() === '' ? 'window not measured' : `${text} window`;
}

function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function resetText(row, zone) {
  if (row?.resetsText) return String(row.resetsText);
  if (!row?.resetsAt) return null;
  const ms = Date.parse(row.resetsAt);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function resetLine(row) {
  const resolvedZone = row?.timeZone || localZone();
  const absolute = resetText(row, resolvedZone);
  const reset = absolute
    ? `${absolute} (${resolvedZone})`
    : '— (no reset time measured)';
  const elapsed = row?.elapsedPct == null ? '—' : pctText(row.elapsedPct);
  const pace = row?.paceWord || 'no measured pace';
  return `Resets ${reset} · ${elapsed} of the window elapsed · ${pace}`;
}

// True only when both halves were measured.  A pool with no meter reading has
// no share to draw: filling the bar from a single half would paint a full
// `▓▓▓…` row that reads as "100% workflows" when the truth is "no reading".
function hasShare(row) {
  return finite(row?.share?.workflows) != null && finite(row?.share?.rest) != null;
}

function shareParts(row, ansi) {
  const workflows = finite(row?.share?.workflows);
  const rest = finite(row?.share?.rest);
  const width = row?._shareWidth ?? 1;
  return shareBar([
    { value: workflows ?? 0, glyph: '▓' },
    { value: rest ?? 0, glyph: '░' },
  ], { width, colors: ansi });
}

function shareLabel(row) {
  const share = row?.share ?? null;
  if (!share || share.workflows == null || share.rest == null) {
    return `workflows / rest: — (${stripMarkup(share?.basis ?? 'no measured %/minute rate')})`;
  }
  const qualifier = share.exceedsMeter ? ' · ≈ workflows exceeds the reported meter' : '';
  const minutes = share.workflowMinutes == null ? '' : ` · ${numberText(share.workflowMinutes, 2)} measured worker-minutes`;
  return `≈ workflows ${pctText(share.workflows)} · rest ${pctText(share.rest)}${minutes}${qualifier} · ${stripMarkup(share.basis ?? 'measured rate × measured worker-minutes')}`;
}

function fitLine(row) {
  if (row?.fits != null) {
    const draw = row.drawPerRunPct == null ? null : pctText(row.drawPerRunPct);
    const minutes = row.medianRunMinutes == null ? null : numberText(row.medianRunMinutes, 2);
    const basis = draw && minutes
      ? ` (≈ ${draw}/run from ${minutes} measured worker-minutes)`
      : '';
    return `Fits: ${numberText(row.fits, 0)} median runs${basis}`;
  }
  return `Fits: — (${stripMarkup(row?.fitsBasis ?? 'not computable from measured data')})`;
}

function creditLine(row) {
  const credits = row?.credits;
  if (!credits || credits.used == null || credits.limit == null) return null;
  const unit = credits.unit || 'credits';
  return `${numberText(credits.used, 2)} / ${numberText(credits.limit, 2)} ${unit}`;
}

function subscriptionLine(row) {
  const subscription = row?.subscription;
  if (subscription?.monthlyPriceUsd != null) {
    const amount = moneyText(subscription.monthlyPriceUsd);
    if (amount != null) {
      const basis = stripMarkup(subscription.basis ?? 'declared monthly subscription price');
      return [`Subscription rate: ${amount}/mo (${basis})`];
    }
  }
  const reason = stripMarkup(row?.nulls?.includes?.('subscription')
    ? 'no declared subscription price'
    : 'no declared subscription price');
  // Keep the command as its own atom: it remains copyable at desktop widths,
  // while the ordinary wrapper can still split it on a phone frame.
  return [`Subscription rate: — (${reason})`, `Declare one with: ${COMMAND}`];
}

function apiLine(row) {
  const value = moneyText(row?.apiEquivalentUsd);
  const basis = stripMarkup(row?.apiEquivalentBasis ?? 'recorded per-attempt estimates');
  // `≈` marks an estimate. With nothing recorded there is no estimate to
  // qualify, so the line is a plain blank and the reason it is blank.
  return value == null
    ? `Equivalent API rate: — (no run in this window recorded an API-equivalent estimate; ${basis})`
    : `Equivalent API rate: ≈ ${value} API-equivalent estimate (${basis})`;
}

function biggestSource(budget, row) {
  const candidates = [
    row?.biggestRuns,
    row?.biggest,
    budget?.biggestRuns,
    budget?.biggest,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.byMinutes)) return candidate.byMinutes;
    if (Array.isArray(candidate?.runs)) return candidate.runs;
    const named = candidate?.[row?.name];
    if (Array.isArray(named)) return named;
    if (Array.isArray(named?.byMinutes)) return named.byMinutes;
    if (Array.isArray(named?.runs)) return named.runs;
  }
  return [];
}

function runLabel(run) {
  return String(run?.shortId ?? run?.runId ?? 'run');
}

function runMinutes(run) {
  return finite(run?.workerMinutes ?? run?.minutes ?? run?.agentMinutes);
}

/**
 * Render the Budget page.  Regions are line-relative, one-based columns, as
 * required by dash-kit and parseMouse; the only page action emitted here is
 * opening a measured workflow from the biggest-workflows list.
 */
export function budgetLines(budget, { width = 120, ansi = true } = {}) {
  const cols = columns(width);
  const lines = [];
  const regions = [];
  const rows = rowsOf(budget);

  if (!rows.length) {
    pushText(lines, 'Budget · no pool budget data is available', cols);
    return { lines, regions };
  }

  for (const row of rows) {
    const name = row?.name ?? 'pool';
    pushText(lines, `${tint(name, BOLD, ansi)}  ${tint(`${planLabel(row)} · ${windowLabel(row)}`, DIM, ansi)}`, cols);
    pushText(lines, tint('Licence meter', DIM, ansi), cols);
    // This is deliberately the complete line: the meter itself owns every
    // cell of the available frame, including its elapsed mark.
    lines.push(meterBar(row?.usedPct ?? null, row?.elapsedPct ?? null, cols, { ansi }));
    pushText(lines, resetLine(row), cols);

    const credits = creditLine(row);
    if (credits) pushText(lines, `Credits: ${credits}`, cols);

    // No measured share means no bar at all — a blank and its reason, never
    // a bar that implies a reading nobody took.
    if (hasShare(row)) {
      lines.push(shareParts({ ...row, _shareWidth: Math.max(1, cols) }, ansi));
    }
    pushText(lines, shareLabel(row), cols);
    pushText(lines, fitLine(row), cols);

    const biggest = biggestSource(budget, row);
    if (biggest.length) {
      pushText(lines, 'Biggest workflows · measured worker-minutes', cols);
      for (const run of biggest) {
        const minutes = runMinutes(run);
        if (minutes == null) continue;
        const label = runLabel(run);
        const text = `  ${label} · ${numberText(minutes, 2)} worker-minutes`;
        const at = lines.length;
        pushText(lines, text, cols);
        // A run line is intentionally kept short enough for its hit region to
        // remain wholly inside the frame after wrapping.  `y` names the row
        // the id was painted on, counted from 1 and remapped below if the
        // defensive wrap pass splits an earlier line.
        if (run?.runId && at < lines.length && visibleLength(lines[at]) >= label.length + 2) {
          regions.push({ x: 3, y: at + 1, width: label.length, action: { kind: 'run', runId: run.runId } });
        }
      }
    } else {
      pushText(lines, 'Biggest workflows: — (no measured worker-minutes in this period)', cols);
    }

    // Exactly two money lines.  Keep them adjacent so a caller can place the
    // block below the meter on a phone layout without inventing a third total.
    for (const line of subscriptionLine(row)) pushText(lines, line, cols);
    pushText(lines, apiLine(row), cols);
    lines.push('');
  }

  // A final defensive pass catches unusual caller strings while preserving
  // the meter/share bars, which are already exactly `cols` visible cells.
  // Splitting a line moves every row below it, so each region's `y` is
  // remapped onto the first row its original line became.
  const safe = [];
  const movedTo = [];
  for (const line of lines) {
    movedTo.push(safe.length + 1);
    for (const part of visibleLength(line) <= cols ? [line] : wrapLine(line, cols)) safe.push(part);
  }
  const placed = regions
    .map((region) => ({ ...region, y: movedTo[region.y - 1] ?? region.y }))
    .filter((region) => region.x >= 1 && region.x + region.width - 1 <= cols
      && visibleLength(safe[region.y - 1] ?? '') >= region.x + region.width - 1);
  return { lines: safe, regions: placed };
}

/** Notes placed above the shell's navigation row. */
export function budgetNotes(budget, { width = 120 } = {}) {
  const cols = columns(width);
  const notes = Array.isArray(budget?.notes) ? budget.notes : [];
  const rows = rowsOf(budget);
  const derived = [];
  if (!notes.length) {
    const unpriced = rows.filter((row) => row?.subscription == null).map((row) => row?.name).filter(Boolean);
    if (unpriced.length) derived.push(`No declared subscription price for ${unpriced.join(', ')}; declare one with ${COMMAND}.`);
    const unrated = rows.filter((row) => row?.share?.ratePerMinute == null).map((row) => row?.name).filter(Boolean);
    if (unrated.length) derived.push(`No measured %/minute rate for ${unrated.join(', ')}; licence share and fit are blank.`);
  }
  const source = notes.length ? notes : derived;
  return source.flatMap((note) => wrapLine(stripMarkup(note), cols)).filter(Boolean);
}
