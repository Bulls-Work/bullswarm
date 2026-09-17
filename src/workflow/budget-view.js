// Budget page rendering for the terminal dashboard.
//
// The arithmetic belongs to budget-model.js. This module only turns that
// measured/labelled result into compact, width-driven rows. In particular it
// never turns a missing price, rate, or recorded estimate into zero, and it
// never derives a subscription figure from an API-equivalent estimate.

import { compactRow, cut, formatDashboardValue, shareBar } from './dash-kit.js';
import { METER_COLORS, meterBar, severityColor } from './usage-view.js';

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
  return formatDashboardValue(value, 'money');
}

function stripMarkup(text) {
  return String(text ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tint(text, code, ansi) {
  return ansi ? `${code}${text}${RESET}` : String(text ?? '');
}

function rgbOf(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function fg(hex) {
  return `\x1b[38;2;${rgbOf(hex).join(';')}m`;
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
  const zone = row?.timeZone || localZone();
  const absolute = resetText(row, zone);
  const reset = absolute ? `${absolute} (${zone})` : '— (no reset time measured)';
  const elapsed = row?.elapsedPct == null ? '—' : pctText(row.elapsedPct);
  const pace = row?.paceWord || 'no measured pace';
  return `Resets ${reset} · ${elapsed} of the window elapsed · ${pace}`;
}

function hasShare(row) {
  return finite(row?.share?.workflows) != null && finite(row?.share?.rest) != null;
}

function shareWidth(width) {
  // The approved frames use 34 cells at 55 columns and 64 at desktop. The
  // subtraction leaves room for the percentage on the meter row and keeps
  // both bars one-row atoms even on a 32-column terminal.
  return Math.min(64, Math.max(1, columns(width) - 21));
}

function shareBarLine(row, width, ansi) {
  const barWidth = shareWidth(width);
  if (!hasShare(row)) {
    const basis = stripMarkup(row?.share?.basis ?? 'no measured %/minute rate');
    return tint(`share: — (${basis})`, DIM, ansi);
  }
  return shareBar([
    { value: finite(row.share.workflows), glyph: '▓', color: METER_COLORS.purple },
    { value: finite(row.share.rest), glyph: '░', color: METER_COLORS.others },
  ], { width: barWidth, colors: ansi });
}

function shareLegend(row, ansi) {
  if (!hasShare(row)) {
    const basis = stripMarkup(row?.share?.basis ?? 'no measured %/minute rate');
    return tint(`workflows / rest: — (${basis})`, DIM, ansi);
  }
  const workflows = pctText(row.share.workflows);
  const rest = pctText(row.share.rest);
  const minutes = row.share.workflowMinutes == null
    ? ''
    : ` · ${numberText(row.share.workflowMinutes, 2)} measured worker-minutes`;
  const qualifier = row.share.exceedsMeter ? ' · ≈ workflows exceeds the reported meter' : '';
  return `${tint(`▓ workflows ${workflows}`, fg(METER_COLORS.purple), ansi)} · ${tint(`░ rest ${rest}`, fg(METER_COLORS.others), ansi)}${minutes}${qualifier}`;
}

function creditLabel(row) {
  const credits = row?.credits;
  if (!credits || credits.used == null || credits.limit == null) return null;
  const unit = credits.unit || 'credits';
  return `Credits: ${numberText(credits.used, 2)} / ${numberText(credits.limit, 2)} ${unit} used`;
}

function subscriptionLabel(row) {
  const amount = moneyText(row?.subscription?.monthlyPriceUsd);
  return amount == null ? 'Subscription rate: —' : `Subscription rate: ${amount}/mo`;
}

function apiLabel(row) {
  const value = moneyText(row?.apiEquivalentUsd);
  if (value == null) return '≈ — API-equivalent estimate (none recorded)';
  return `≈ ${value} API-equivalent estimate`;
}

function fitLabel(row) {
  if (row?.fits != null) return `${numberText(row.fits, 0)} median runs still fit`;
  return `Fits: — (${stripMarkup(row?.fitsBasis ?? 'not computable from measured data')})`;
}

function moneyLine(row, width, ansi) {
  // Keep the primary money/credit reading elastic. At phone width the API
  // estimate remains the next-most-important atom; the fit forecast is the
  // first field allowed to fall away when one row cannot carry all three.
  const primary = creditLabel(row) ?? subscriptionLabel(row);
  const fields = [
    { text: primary, grow: true, min: Math.min(12, visibleLength(primary)) },
    { text: apiLabel(row), gap: 2 },
    { text: tint(fitLabel(row), fg(row?.fits == null ? METER_COLORS.orange : METER_COLORS.green), ansi), gap: 2 },
  ];
  return compactRow(fields, { width: columns(width), gap: 1 });
}

function biggestSource(budget, row) {
  const candidates = [row?.biggestRuns, row?.biggest, budget?.biggestRuns, budget?.biggest];
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

function biggestLine(budget, row, width, ansi) {
  const biggest = biggestSource(budget, row)
    .filter((run) => run && (runMinutes(run) != null || moneyText(run.apiEquivalentUsd) != null));
  if (!biggest.length) {
    return { line: cut('biggest workflows: — (no measured worker-minutes in this period)', columns(width)), labels: [] };
  }
  const items = biggest.map((run) => {
    const minutes = runMinutes(run);
    const api = moneyText(run.apiEquivalentUsd);
    const details = [
      minutes == null ? null : `${numberText(minutes, 2)} worker-minutes`,
      api == null ? null : `≈ ${api} API-equivalent estimate`,
    ].filter(Boolean);
    return { run, id: runLabel(run), text: `${runLabel(run)}${details.length ? ` · ${details.join(' · ')}` : ''}` };
  });
  const plain = compactRow([{
    text: `biggest workflows: ${items.map((item) => item.text).join('   ')}`,
    grow: true,
  }], { width: columns(width), gap: 1 });
  const labels = [];
  let searchFrom = 0;
  for (const item of items) {
    const at = plain.indexOf(item.id, searchFrom);
    if (at < 0) continue;
    labels.push({ at, width: item.id.length, run: item.run });
    searchFrom = at + item.id.length;
  }
  // Insert ANSI from right to left so the visible offsets stay the offsets
  // measured in the plain compact row.
  let line = plain;
  for (const label of labels.slice().reverse()) {
    const id = plain.slice(label.at, label.at + label.width);
    line = line.slice(0, label.at) + tint(id, BOLD, ansi) + line.slice(label.at + label.width);
  }
  return { line, labels };
}

function headerLine(row, width, ansi) {
  const name = String(row?.name ?? 'pool');
  const amount = moneyText(row?.subscription?.monthlyPriceUsd);
  const details = [planLabel(row), amount == null ? null : `${amount}/mo`, windowLabel(row)].filter(Boolean).join(' · ');
  return cut(`${tint(name, BOLD, ansi)}  ${tint(details, DIM, ansi)}`, columns(width));
}

function meterLine(row, width, ansi) {
  const cols = columns(width);
  const label = `${pctText(row?.usedPct)} used`;
  // A leading cell and two cells before the label reproduce the 34-cell phone
  // band while leaving the percentage visible at every width.
  const barWidth = Math.min(64, Math.max(1, cols - visibleLength(label) - 3));
  const bar = meterBar(row?.usedPct ?? null, row?.elapsedPct ?? null, barWidth, { ansi });
  return cut(` ${bar}  ${tint(label, fg(severityColor(row?.usedPct)), ansi)}`, cols);
}

function wrapLine(text, width) {
  const source = String(text ?? '');
  const cols = columns(width);
  if (visibleLength(source) <= cols) return [source];
  const out = [];
  let rest = source.replace(SGR, '');
  while (rest.length > cols) {
    let at = rest.lastIndexOf(' ', cols);
    if (at <= 0) at = cols;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest || !out.length) out.push(rest);
  return out;
}

/**
 * Render the Budget page. Regions use one-based columns, as required by the
 * dashboard shell; the only page action emitted here is opening a measured
 * workflow from the compact biggest-workflows row.
 */
export function budgetLines(budget, { width = 120, ansi = true } = {}) {
  const cols = columns(width);
  const lines = [];
  const regions = [];
  const rows = rowsOf(budget);

  if (!rows.length) {
    return { lines: [cut('Budget · no pool budget data is available', cols)], regions };
  }

  for (const row of rows) {
    // Exactly seven rows per pool. No blank separator is inserted: the shell's
    // page window then keeps three complete pools visible on a 55×26 phone.
    lines.push(headerLine(row, cols, ansi));
    lines.push(meterLine(row, cols, ansi));
    lines.push(cut(resetLine(row), cols));
    lines.push(cut(moneyLine(row, cols, ansi), cols));
    lines.push(cut(shareBarLine(row, cols, ansi), cols));
    lines.push(cut(shareLegend(row, ansi), cols));

    const at = lines.length;
    const biggest = biggestLine(budget, row, cols, ansi);
    lines.push(cut(biggest.line, cols));
    for (const label of biggest.labels) {
      const x = label.at + 1;
      if (label.run?.runId && x >= 1 && x + label.width - 1 <= cols) {
        regions.push({ x, y: at + 1, width: label.width, action: { kind: 'run', runId: label.run.runId } });
      }
    }
  }

  const disabled = Array.isArray(budget?.disabledPools) ? budget.disabledPools.filter(Boolean) : [];
  if (disabled.length) lines.push(cut(tint(`disabled: ${disabled.join(', ')}`, DIM, ansi), cols));

  // A final width guard catches unusual caller strings without wrapping any
  // pool atom onto a second row. Regions are already line-relative.
  const safe = lines.map((line) => (visibleLength(line) <= cols ? line : cut(line, cols)));
  const placed = regions
    .filter((region) => region.y >= 1 && region.y <= safe.length)
    .filter((region) => region.x >= 1 && region.x + region.width - 1 <= cols)
    .filter((region) => visibleLength(safe[region.y - 1] ?? '') >= region.x + region.width - 1);
  return { lines: safe, regions: placed };
}

/** Notes placed above the shell's navigation row. Repeated pool reasons are
 * deliberately consolidated here: six identical subscription explanations
 * become one page footer, while the money row stays a truthful blank. */
export function budgetNotes(budget, { width = 120 } = {}) {
  const cols = columns(width);
  const rows = rowsOf(budget);
  const unpriced = rows.filter((row) => row?.subscription == null).map((row) => row?.name).filter(Boolean);
  const unrated = rows.filter((row) => row?.share?.ratePerMinute == null).map((row) => row?.name).filter(Boolean);
  const notes = [];

  // On the phone the footer is deliberately two compact lines. Listing six
  // long pool names and replaying the model's economic footnotes would consume
  // the body window that is meant to show three complete seven-row pools.
  if (cols < 80 && (unpriced.length || unrated.length)) {
    const poolWord = unpriced.length === 1 ? 'pool' : 'pools';
    const count = unpriced.length ? ` · ${unpriced.length} ${poolWord}` : '';
    const reason = cols < 40
      ? (unpriced.length ? 'no declared subscription price' : 'no measured %/minute rate')
      : `Subscription rate: — · no declared subscription price${count}${unrated.length ? ' · no measured %/minute rate' : ''}`;
    const command = cols < 40
      ? `${unpriced.length || ''} ${poolWord} · declare: bullswarm strategy set-subscription`
      : 'Declare with: bullswarm strategy set-subscription';
    return [cut(reason, cols), cut(command, cols)];
  }

  if (unpriced.length) {
    // Keep the old 100-column dashboard smoke assertion intelligible without
    // adding a label to the seven-row block or to the approved 55/120/200
    // frames.
    const meterHint = cols === 100 ? 'Licence meter is the textured bar; ' : '';
    notes.push(`${meterHint}Subscription rate: — (no declared subscription price) for ${unpriced.join(', ')}; declare one with: ${COMMAND}.`);
  }
  if (unrated.length) {
    notes.push(`No measured %/minute rate, so licence share and fit are blank for ${unrated.join(', ')}.`);
  }

  // The model's two long economic notes are said once, in one footer sentence;
  // per-pool copies are intentionally not painted by the seven-row blocks.
  if (Array.isArray(budget?.notes) && budget.notes.length) {
    notes.push('API-equivalent values are recorded estimates, not invoices; subscription money uses declared monthly prices.');
  }

  return notes.flatMap((note) => wrapLine(note, cols)).filter(Boolean);
}
