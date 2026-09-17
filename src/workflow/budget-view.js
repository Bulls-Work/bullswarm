import { absentLine, cut, formatDashboardValue, progressBar } from './dash-kit.js';
import { METER_COLORS, meterBar } from './usage-view.js';

const SGR = /\x1b\[[0-9;]*m/g;
const COMMAND = 'bullswarm strategy set-subscription <pool> --monthly-usd <amount>';

function columns(width) {
  return Number.isFinite(Number(width)) ? Math.max(1, Math.trunc(Number(width))) : 120;
}

function visible(text) {
  return String(text ?? '').replace(SGR, '');
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function money(value) {
  return formatDashboardValue(value, 'money');
}

function paint(text, hex, ansi) {
  if (!ansi) return visible(text);
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[0m`;
}

function rowsOf(budget) {
  if (Array.isArray(budget)) return budget;
  if (Array.isArray(budget?.rows)) return budget.rows;
  if (budget?.rows && typeof budget.rows === 'object') return Object.values(budget.rows);
  return Array.isArray(budget?.pools) ? budget.pools : [];
}

function missing(label, reason, width, ansi, labelWidth = 0) {
  const line = absentLine(label, reason, { width, labelWidth });
  return ansi ? line : visible(line);
}

function resetLabel(row, narrow) {
  const minutes = finite(row.resetsInMinutes);
  const relative = minutes == null ? null : minutes <= 0 ? 'reset due' : `in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  let absolute = row.resetsText;
  if (row.resetsAt && Number.isFinite(Date.parse(row.resetsAt))) {
    try {
      absolute = new Intl.DateTimeFormat('en-GB', {
        timeZone: row.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(row.resetsAt));
    } catch { absolute = row.resetsAt; }
  }
  absolute = absolute ? String(absolute).replace(/,/g, '').replace(/\s+(?:GMT|UTC).*$/, '') : null;
  if (narrow && relative) return `resets ${relative}`;
  return absolute ? `resets ${absolute}${relative ? ` (${relative})` : ''}` : relative ? `resets ${relative}` : 'reset time unavailable';
}

function biggestSource(budget, row) {
  for (const candidate of [row.biggestRuns, row.biggest, budget?.biggestRuns, budget?.biggest]) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.byMinutes)) return candidate.byMinutes;
    if (Array.isArray(candidate?.runs)) return candidate.runs;
    const named = candidate?.[row.name];
    if (Array.isArray(named)) return named;
    if (Array.isArray(named?.byMinutes)) return named.byMinutes;
    if (Array.isArray(named?.runs)) return named.runs;
  }
  return [];
}

function wrap(text, width) {
  let rest = visible(text);
  const lines = [];
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width);
    const at = space > 0 ? space : width;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

export function budgetLines(budget, { width = 120, ansi = true } = {}) {
  const cols = columns(width);
  const narrow = cols < 80;
  const lines = [];
  const regions = [];
  const rows = rowsOf(budget);
  if (!rows.length) return { lines: [cut('Budget · no pool budget data is available', cols)], regions };
  const labelWidth = narrow ? 7 : 13;
  const labelled = (label, text) => `${label.padEnd(labelWidth)}${text}`;
  for (const row of rows) {
    const plan = row.window ? `${row.window} plan` : 'plan window unavailable';
    const header = `${row.name ?? 'pool'} · ${plan} · ${resetLabel(row, narrow)}`;
    lines.push(cut(ansi ? `\x1b[1m${header}\x1b[0m` : header, cols));
    const used = finite(row.usedPct);
    if (used == null) {
      lines.push(missing('used', 'meter unavailable', cols, ansi, labelWidth));
    } else {
      const elapsed = finite(row.elapsedPct);
      const pace = row.paceWord || 'pace unavailable';
      const tail = `${Math.round(used)}% · ${elapsed == null ? 'window age unavailable' : `${Math.round(elapsed)}% ${narrow ? 'gone' : 'of the window gone'}`} → ${pace}`;
      const barWidth = Math.max(1, Math.min(40, cols - labelWidth - tail.length - 1));
      lines.push(labelled('used', `${meterBar(used, elapsed, barWidth, { ansi })} ${tail}`));
    }
    if (used == null || finite(row.share?.workflows) == null || finite(row.share?.rest) == null) {
      lines.push(missing(narrow ? 'by bsw' : 'by bullswarm', used == null ? 'no licence meter' : 'no measured usage rate yet', cols, ansi, labelWidth));
    } else {
      const share = row.share;
      const minutes = finite(share.workflowMinutes);
      const tail = narrow
        ? `≈ ${Math.round(share.workflows)}%${minutes == null ? '' : ` (${Math.round(minutes)} min)`} · other ${Math.round(share.rest)}%`
        : `≈ ${Math.round(share.workflows)}%${minutes == null ? '' : ` (${Math.round(minutes)} min of work)`} · other tools ${Math.round(share.rest)}%`;
      const barWidth = Math.max(1, Math.min(40, cols - labelWidth - tail.length - 1));
      const bar = progressBar(Math.min(used, Math.max(0, share.workflows)) / 100, barWidth, { partialGlyph: '▏' });
      lines.push(labelled(narrow ? 'by bsw' : 'by bullswarm', `${paint(bar, METER_COLORS.purple, ansi)} ${tail}`));
    }
    if (finite(row.fits) == null) {
      const reason = used == null ? 'no licence meter' : finite(row.share?.ratePerMinute) == null ? 'no measured usage rate yet' : finite(row.medianRunMinutes) == null ? 'no recorded run duration yet' : 'no measured usage per run yet';
      lines.push(missing('room', reason, cols, ansi, labelWidth));
    } else {
      const fits = Math.round(row.fits);
      const runWord = fits === 1 ? 'run' : 'runs';
      lines.push(labelled('room', narrow ? `about ${fits} medium ${runWord} before reset` : `about ${fits} more medium ${runWord} before the reset`));
    }
    const api = money(row.apiEquivalentUsd);
    const biggest = biggestSource(budget, row).slice(0, 2);
    const items = biggest.map((run) => {
      const id = String(run.shortId ?? run.runId ?? 'run');
      const value = money(run.apiEquivalentUsd);
      const figure = value == null ? '(cost unrecorded)' : `≈${narrow ? '' : ' '}${value}`;
      return { run, id, text: `${id}${narrow && value != null ? '' : ' '}${figure}` };
    });
    const primary = api == null ? 'API estimate unrecorded' : narrow ? `≈${api} API` : `≈ ${api} of API-equivalent work`;
    const detail = items.length ? `${narrow ? ' · ' : ' · biggest: '}${items.map((item) => item.text).join(', ')}` : '';
    const plain = cut(labelled('so far', `${primary}${detail}`), cols);
    lines.push(paint(plain, METER_COLORS.purple, ansi));
    let from = 0;
    for (const item of items) {
      const at = plain.indexOf(item.id, from);
      if (at >= 0 && item.run.runId) {
        regions.push({ x: at + 1, y: lines.length, width: item.id.length, action: { kind: 'run', runId: item.run.runId } });
        from = at + item.id.length;
      }
    }
    if (finite(row.credits?.used) != null && finite(row.credits?.limit) != null) {
      lines.push(labelled('credits', `${Math.round(row.credits.used)} / ${Math.round(row.credits.limit)} ${row.credits.unit || 'credits'} used`));
    }
    const price = finite(row.subscription?.monthlyPriceUsd);
    if (price != null) lines.push(`plan · $${Number.isInteger(price) ? price : price.toFixed(2)}/mo declared`);
  }
  if (budget?.disabledPools?.length) lines.push(`disabled: ${budget.disabledPools.join(', ')}`);
  return { lines: lines.map((line) => cut(line, cols)), regions };
}

export function budgetNotes(budget, { width = 120 } = {}) {
  const cols = columns(width);
  const rows = rowsOf(budget);
  const notes = ['≈ means estimated work, not an invoice; licence share uses measured work time.'];
  if (rows.some((row) => row.share?.exceedsMeter)) notes.push("bullswarm's own measurement is above what the meter reports; the meter lags");
  if (rows.some((row) => finite(row.subscription?.monthlyPriceUsd) == null)) notes.push(`Declare a price: ${COMMAND}`);
  return notes.flatMap((note) => wrap(note, cols));
}
