// The Home page renderer.
//
// The model in home-model.js supplies the width-independent rows. This module
// paints those rows and keeps hit-region registration in the same body builder
// contract used by the dashboard shell.

import { asciiGlyphsPreferred, glyphs } from '../lib/glyphs.js';
import { finiteOrNull } from '../lib/num.js';
import { dayKey } from './history.js';
import { meterBar, paceWord, untilText } from './usage-view.js';
import {
  chartRowCount,
  compactRow,
  cut,
  formatDashboardValue,
  niceStep,
  periodToggle,
  progressBar,
  rule,
  seriesColor,
} from './dash-kit.js';
import {
  measuredTaskMinutes,
  cardDurationText,
  medianRunDuration,
  isFinishedRun,
  recordMoneyPair,
  runStatusMark,
  todayDateLabel,
  todayLicenceRows,
  todayMinutesNumberText,
  todayMinutesText,
  todayTopRuns,
  todayRows,
} from './home-model.js';
import {
  ageText,
  blank,
  dimText,
  meterAnsi,
  minutesText,
  moneyText,
  planProgress,
  planStripParts,
  PERIOD_ITEMS,
  pushColumns,
  runEconomics,
  stateStartedAt,
  strong,
  tint,
  tokenSourceOf,
  usageBasisText,
  visibleLength,
  workflowRunLabel,
} from './dashboard.js';
import { apiMoney, formatMoney } from '../lib/usage-basis.js';
import { honestApiTotalText, recordSpendFacts, spendFacts } from './spend-facts.js';

const BUDGET_WEEK_POOLS = 4;
// From this width up the Today band and the period band are each two halves
// of equal width; below it the page is one column: cards, licences, running,
// budget, chart, by pool, by model, by project.
const HALVES_WIDTH = 110;
const HALF_GAP = 2;
// Rows a breakdown section shows before it counts the rest as `+N more`.
const BREAKDOWN_ROWS = 4;
// The weekly-quota bar in the licence table: this wide when there is room, and
// never narrower than the minimum before a column is dropped instead.
const QUOTA_BAR_MAX = 10;
const QUOTA_BAR_MIN = 4;
const TABLE_GAP = 2;
const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTH_NAMES = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const EIGHTHS = Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);

function taskIdText(task) {
  const raw = String(task?.id ?? task?.taskFile ?? 'task');
  return raw.length > 14 ? raw.slice(-8) : raw;
}

function taskPoolModelText(task) {
  return [task?.pool, task?.model].filter((value) => value != null && String(value).trim()).join(' · ')
    || 'pool/model unavailable';
}

function taskElapsedText(task, nowMs) {
  return ageText(task?.startedAt, nowMs) || 'time pending';
}

function todayGoalLine(record, width) {
  const goal = String(record?.goal ?? '').split(/\r?\n/)[0].trim();
  return dimText(`  ${goal || 'goal unavailable'}`, width);
}

function todayWorkflowLine(record, width) {
  const glyph = record?.status === 'failed' ? glyphs().fail : glyphs().ok;
  const id = String(record?.shortId ?? record?.runId ?? '------');
  const project = cut(String(record?.project ?? 'unknown'), 10).padEnd(10);
  const minutes = todayMinutesText(record?.minutes?.active) ?? blank();
  const verdict = record?.verified === true ? 'verified' : record?.verified === false ? 'not verified' : blank();
  const line = `${glyph} ${id.padEnd(6)}  ${project}  active ${minutes.padStart(6)}  ${verdict}`;
  return todayPadded(line, width);
}

function todayTaskLine(task, width) {
  const id = taskIdText(task);
  const project = cut(String(task?.project ?? 'unknown'), 10).padEnd(10);
  const minutes = todayMinutesText(measuredTaskMinutes(task)) ?? blank();
  const result = task?.ok === false ? 'failed' : 'finished';
  const line = `${glyphs().inflight} ${id.padEnd(6)}  ${project}  ${minutes.padStart(6)}  ${result}`;
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
}

function todayPoolName(name, width) {
  const full = String(name ?? '');
  const suffix = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full;
  if (full.length <= width) return full;
  if (suffix.length <= width) return suffix;
  return cut(full, width);
}

function compactUsageBasisText(value, tokenSource, width = 20) {
  const text = value && typeof value === 'object'
    ? moneyText(value)
    : usageBasisText(value, tokenSource);
  if (text === 'cost unknown' || visibleLength(text) <= width) return text;
  return text
    .replace(' estimated', ' est')
    .replace(' summed', ' sum')
    .replace('$ ', '$')
    .slice(0, width);
}

function todayTableRow(row, width, { header = false } = {}) {
  const desktop = width >= 60;
  const nameWidth = desktop ? 14 : 13;
  const specs = desktop
    ? { wf: 6, wfPct: 4, run: 7, api: 17, gaps: [4, 3, 3, 0] }
    : { wf: 6, wfPct: 4, run: 6, api: 12, gaps: [3, 3, 3, 0] };
  const labels = ['worker-minutes', 'weekly share', 'API', 'subscription'];
  const values = header ? labels : [
    todayMinutesNumberText(row?.workflowMinutes) ?? blank(),
    row?.workflowPct == null ? blank() : `${row.workflowPct.toFixed(1)}%`,
    todayMinutesNumberText(row?.runMinutes) ?? blank(),
    // The cell is fixed-width: the honest amount (`at least $X` when the
    // pool's day holds unpriced attempts), billed against the subscription
    // fact it has. The block's own footnote names the coverage counts.
    row?.apiKnownSubtotalUsd == null && row?.apiUsd == null && row?.subscriptionUsd == null ? blank()
      : [licenceApiText(row), licenceMoney(row?.subscriptionUsd)]
        .filter((part) => part && part !== blank())
        .join(' · ') || blank(),
  ];
  const widths = [specs.wf, specs.wfPct, specs.run, specs.api];
  let line = header ? 'pool'.padEnd(nameWidth) : todayPoolName(row?.name, nameWidth).padEnd(nameWidth);
  if (header) {
    const headerWidths = desktop ? [6, 10, 7, 18] : [6, 10, 6, 13];
    values.forEach((value, index) => {
      line += String(value ?? '').padEnd(headerWidths[index]);
      line += ' '.repeat(index === values.length - 1 ? 0 : 1);
    });
  } else values.forEach((value, index) => {
    line += String(value ?? '').padStart(widths[index]);
    line += ' '.repeat(specs.gaps[index]);
  });
  return todayPadded(line, width);
}

function todayBareRule(width) {
  return '─'.repeat(Math.max(0, width));
}

function todayPadded(value, width) {
  const text = String(value ?? '');
  return `${cut(text, width)}${' '.repeat(Math.max(0, width - visibleLength(cut(text, width))))}`;
}

function todayLicenceFootnotes(nowMs, width, desktop = false) {
  const date = dayKey(nowMs) ?? 'today';
  return (desktop
    ? [
      'weekly share is the calibration ledger drop when it recorded one, else a labelled pace estimate',
      '— means the real snapshot supplied no measurement',
      'at least marks an API total that leaves unpriced attempts out of the sum',
      'API and subscription amounts keep their provider/estimate basis',
      'live window used share is on Budget',
    ]
    : [
      'weekly share is the ledger drop, else ≈ marks the pace estimate',
      '— means the real snapshot supplied no measurement',
      'at least marks an API total with unpriced attempts',
      `money audit for ${date} uses recorded values only`,
      'live window used share is on Budget',
    ]).map((line) => todayPadded(line, width));
}

function cardStatusText(status) {
  const value = String(status ?? '').replaceAll('_', ' ');
  if (value === 'completed') return 'completed';
  if (value === '—') return '—';
  return value || '—';
}

/** A card's money slot: the pair's own words, never a second rendering. */
function cardMoneySlot(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.startsWith('api unknown') || text.startsWith('sub unknown')) return blank();
  return text.replace(/ api( ·|$)/, '$1');
}

function cardLines(card, width, { task = false } = {}) {
  const inner = Math.max(1, width - 2);
  const goal = cut(String(card.name ?? 'run'), Math.max(1, inner - 3));
  const project = cut(String(card.project ?? blank()), Math.max(1, inner - 9));
  const status = cardStatusText(card.status);
  const verdict = String(card.verdict ?? '—');
  const duration = cardDurationText(card.minutes) ?? blank();
  const steps = card.steps?.done != null && card.steps?.total != null
    ? `${card.steps.done}/${card.steps.total}` : '—';
  const money = card.money ?? recordMoneyPair(card.record ?? {});
  // Each slot is the pair's own wording — the whole amount with its estimate
  // glyph, or `at least $X · N unmeasured` when the run holds attempts that
  // were never priced. The card never re-derives an amount of its own.
  const api = cardMoneySlot(money.apiSlotText ?? money.apiText);
  const subscription = cardMoneySlot(money.subscriptionText);
  const content = [
    task ? ` ${project} · task · ${status}` : ` ${project} · ${status} · ${verdict}`,
    ` ${duration} · steps ${steps}`,
    ` API ${api} · subscription ${subscription}`,
  ];
  const title = cut(goal, Math.max(1, inner - 3));
  return [
    `┌─ ${title}${'─'.repeat(Math.max(0, width - 4 - visibleLength(title)))}┐`,
    ...content.map((line) => `│${cut(line, inner).padEnd(inner)}│`),
    `└${'─'.repeat(Math.max(0, width - 2))}┘`,
  ].map((line) => `${line.slice(0, width)}${' '.repeat(Math.max(0, width - visibleLength(line)))}`);
}

function taskCardModel(task) {
  const minutes = measuredTaskMinutes(task);
  const record = {
    usage: task?.usage ?? null,
    apiEquivalentUsd: task?.apiUsd ?? task?.costUsd ?? null,
    tokenSource: task?.tokenSource ?? null,
  };
  return {
    record,
    id: task?.id ?? task?.taskFile ?? null,
    name: String(task?.goal ?? task?.lane ?? task?.id ?? task?.taskFile ?? 'task')
      .split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'task',
    project: task?.project ?? '—',
    status: task?.ok === false ? 'failed' : task?.endedAt || task?.finishedAt ? 'completed' : 'running',
    verdict: '—',
    minutes: { active: minutes, span: minutes, label: 'active' },
    steps: { done: task?.endedAt || task?.finishedAt ? 1 : 0, total: 1 },
    money: recordMoneyPair(record),
    active: !task?.endedAt && !task?.finishedAt,
  };
}

/** Two halves of equal width for a band `width` wide, and the gutter between. */
function bandHalves(width) {
  const half = Math.max(1, Math.floor((width - HALF_GAP) / 2));
  return { half, gap: Math.max(HALF_GAP, width - half * 2) };
}

/**
 * Two stacks of `{ text, action }` lines painted side by side, the right one
 * starting at the same column on every row. A stack that ends first leaves
 * blanks, so the taller one keeps its rows; each line keeps its own action,
 * so a click or a hover lands on the card, pool or chart it belongs to.
 */
function pushHalves(body, left, right, { half, gap }) {
  const rows = Math.max(left.length, right.length);
  for (let index = 0; index < rows; index += 1) {
    const l = left[index] ?? { text: '' };
    const r = right[index] ?? { text: '' };
    const leftText = cut(String(l.text ?? ''), half);
    const rightText = cut(String(r.text ?? ''), half);
    const parts = [{ text: leftText, action: l.action ?? null }];
    if (visibleLength(rightText)) {
      parts.push({ text: ' '.repeat(half - visibleLength(leftText) + gap) });
      parts.push({ text: rightText, action: r.action ?? null });
    }
    body.parts(parts);
  }
}

/** Stacked lines, full width: each clickable line keeps its own action. */
function pushStack(body, lines) {
  for (const line of lines) {
    if (line.action) body.row(line.text, line.action);
    else body.push(line.text);
  }
}

/** A card's painted lines, each carrying the action of the run it opens. */
function cardRows(card, width) {
  const action = card.task
    ? { kind: 'task', taskId: card.id }
    : { kind: 'run', runId: card.record?.runId ?? card.id };
  return cardLines(card, width, { task: card.task }).map((text) => ({ text, action }));
}

function licenceMoney(value, tokenSource = null) {
  // Either a plain amount or the shared money rule's verdict: a subtotal is
  // always marked `≈`, whatever the pool's worst token source says about the
  // attempts that recorded nothing.
  const money = value && typeof value === 'object' ? value : { usd: value, partial: false };
  if (money.usd == null) return blank();
  const formatted = formatMoney(money.usd);
  if (formatted === '-') return blank();
  if (money.partial) return `≈${formatted}`;
  return tokenSource === 'transcript-summed' ? `≈${formatted}`
    : tokenSource === 'estimated:utf8-bytes/4' ? `~${formatted}` : formatted;
}

/**
 * The licence row's API cell through the Run spend block's helper: the whole
 * amount with its estimate glyph, or `at least $X · N unmeasured` when the
 * pool's day holds attempts nobody priced. A row with no recorded amount is
 * blank here, the way a dash reads in the column.
 */
function licenceApiText(row) {
  const facts = row?.apiFacts ?? null;
  if (!facts) return blank();
  const text = honestApiTotalText(facts, {
    api: null,
    whole: licenceMoney(apiMoney(row), row?.tokenSource),
    counts: 'unmeasured',
  });
  return text === 'api unknown' || text === '—' ? blank() : text;
}

/**
 * A money figure as a table cell: two decimals behind the estimate glyph the
 * figure's basis earns, and no `$` — the column header carries the unit. A
 * partly-priced subtotal is always `≈`, whatever the worst token source says.
 * A recorded fraction of a cent reads `<0.01`, never a free-looking `0.00`.
 */
function tableMoney(value, tokenSource = null) {
  const money = value && typeof value === 'object' ? value : { usd: value, partial: false };
  const usd = finiteOrNull(money?.usd);
  if (usd == null) return null;
  const glyph = money.partial || tokenSource === 'transcript-summed' ? '≈'
    : tokenSource === 'estimated:utf8-bytes/4' ? '~' : '';
  return { usd, glyph };
}

const tableMoneyText = (money) => (money == null ? null
  : `${money.glyph}${money.usd > 0 && money.usd < 0.005 ? '<0.01' : money.usd.toFixed(2)}`);

/** The rougher of two estimate glyphs, for a total over both. */
const worseGlyph = (a, b) => (a === '~' || b === '~' ? '~' : a === '≈' || b === '≈' ? '≈' : '');

/**
 * One pool's licence facts as table cells, from the model's own fields:
 *
 *   agent min     `workerMinutes`, the pool entry's `minutes` summed over
 *                 today's finished workflows: the wall time their attempts ran
 *                 on this pool (the model's worker-minutes);
 *   weekly quota  `weeklyShare`, the percent of the pool's weekly window that
 *                 work used: the calibration ledger's measured drop, or the
 *                 pool's pace estimate (its measured %/minute rate times the
 *                 minutes), which is marked `≈`; unknown stays unknown;
 *   API $         the API-equivalent price, `≈` when some attempts went
 *                 unpriced and the figure is the priced attempts' subtotal;
 *   unpriced      the attempts that subtotal leaves out;
 *   plan $        the subscription money the rollups recorded.
 *
 * A null cell is unknown and paints as a dim dash.
 */
function licenceCells(row) {
  const minutes = finiteOrNull(row?.workerMinutes);
  const pct = finiteOrNull(row?.weeklyShare);
  const api = row?.apiFacts ? tableMoney(apiMoney(row), row?.tokenSource) : null;
  const plan = tableMoney(row?.subscriptionUsd);
  const unpriced = row?.countsIncomplete || finiteOrNull(row?.attempts) == null
    ? null : finiteOrNull(row?.apiFacts?.unmeasured);
  return {
    minutes,
    minutesText: minutes == null ? null : minutes.toFixed(1),
    pct,
    quotaText: pct == null ? null : `${row?.shareBasis === 'pace' ? '≈' : ''}${pct.toFixed(1)}%`,
    api,
    apiText: tableMoneyText(api),
    unpriced,
    unpricedText: unpriced == null ? null : String(unpriced),
    plan,
    planText: tableMoneyText(plan),
  };
}

/**
 * The licence table's columns. `drop` orders what goes when the half cannot
 * hold them all: the highest first, and a column no pool measured before any
 * column that carries a number. The pool name is never dropped.
 */
const LICENCE_COLUMNS = Object.freeze([
  Object.freeze({ key: 'pool', head: 'pool', drop: 0 }),
  Object.freeze({ key: 'minutes', head: 'agent min', text: 'minutesText', drop: 3 }),
  Object.freeze({ key: 'quota', head: 'weekly quota', text: 'quotaText', drop: 2, bar: true }),
  Object.freeze({ key: 'api', head: 'API $', text: 'apiText', drop: 1 }),
  Object.freeze({ key: 'unpriced', head: 'unpriced', text: 'unpricedText', drop: 5 }),
  Object.freeze({ key: 'plan', head: 'plan $', text: 'planText', drop: 4 }),
]);

/** The total row's cells: a column is summed only when every row knows it. */
function licenceTotals(cells) {
  const all = (key) => cells.length > 1 && cells.every((cell) => cell[key] != null);
  const money = (key) => {
    if (!all(key)) return null;
    return tableMoneyText({
      usd: cells.reduce((sum, cell) => sum + cell[key].usd, 0),
      glyph: cells.reduce((glyph, cell) => worseGlyph(glyph, cell[key].glyph), ''),
    });
  };
  const totals = {
    // Each pool's weekly quota is its own window: a sum of their percents
    // measures nothing, so the quota column never has a total.
    minutesText: all('minutes') ? cells.reduce((sum, cell) => sum + cell.minutes, 0).toFixed(1) : null,
    apiText: money('api'),
    unpricedText: all('unpriced') ? String(cells.reduce((sum, cell) => sum + cell.unpriced, 0)) : null,
    planText: money('plan'),
  };
  return Object.values(totals).some((value) => value != null) ? totals : null;
}

/**
 * The `── licences · today ──` block: a rule in the same style as the page's
 * other blocks, one header row naming each column and its unit, one row per
 * pool that worked today with its name in the colour the `by pool` bars use,
 * numbers right-aligned so their decimals line up, a total row where a column
 * is known for every pool, and one dim legend line. A half too narrow for
 * every column shrinks the quota bar first and then drops whole columns —
 * never a number cut short. Returns `{ text, action }` lines `width` wide.
 */
function licenceTableLines(rows, width) {
  const lines = [{ text: rule('licences · today', null, width) }];
  if (!rows.length) {
    lines.push({ text: dimText(' no measured pool work today', width) });
    return lines;
  }
  const content = Math.max(1, width - 1);
  const cells = rows.map(licenceCells);
  const totals = licenceTotals(cells);
  const textsOf = (column) => [
    ...cells.map((cell) => cell[column.text]),
    ...(totals ? [totals[column.text]] : []),
  ];
  const known = (column) => column.key === 'pool' || cells.some((cell) => cell[column.text] != null);
  const valueWidth = (column) => textsOf(column).reduce((most, text) => Math.max(most, visibleLength(text ?? blank())), 0);
  const anyBar = cells.some((cell) => cell.pct != null);
  const names = rows.map((row) => String(row?.name ?? blank()));
  const nameWidth = Math.max(4, ...names.map((name) => name.length), totals ? 5 : 0);

  // Widest first: every column with the longest bar, then a shorter bar, then
  // one column fewer — the least useful, an all-unknown one before any other.
  let kept = LICENCE_COLUMNS.filter((column) => column.key !== 'unpriced'
    || cells.some((cell) => (cell.unpriced ?? 0) > 0));
  const widthOf = (column, bar) => {
    if (column.key === 'pool') return nameWidth;
    const value = valueWidth(column);
    return Math.max(column.head.length, column.bar && anyBar && bar ? bar + 1 + value : value);
  };
  const total = (columns, bar) => columns.reduce((sum, column, index) => sum + (index ? TABLE_GAP : 0) + widthOf(column, bar), 0);
  let bar = QUOTA_BAR_MAX;
  for (;;) {
    bar = QUOTA_BAR_MAX;
    while (bar > QUOTA_BAR_MIN && total(kept, bar) > content) bar -= 1;
    if (total(kept, bar) <= content || kept.length <= 2) break;
    const rank = (column) => column.drop + (known(column) ? 0 : 10);
    const victim = kept.reduce((worst, column) => (rank(column) > rank(worst) ? column : worst), kept[0]);
    kept = kept.filter((column) => column !== victim);
  }
  if (kept.some((column) => column.bar) && total(kept, bar) > content) bar = 0;
  // The quota bar takes whatever the kept columns leave, up to its cap.
  const spare = content - total(kept, bar);
  if (bar > 0 && spare > 0) bar = Math.min(QUOTA_BAR_MAX, bar + spare);
  const widths = kept.map((column) => widthOf(column, bar));
  // Names only give way when even the two narrowest columns cannot fit.
  const over = total(kept, bar) - content;
  if (over > 0) widths[0] = Math.max(1, widths[0] - over);

  const dash = dimText(blank(), 1);
  const paintRow = (values) => ` ${values.map((value, index) => {
    const text = value ?? dash;
    const fill = ' '.repeat(Math.max(0, widths[index] - visibleLength(text)));
    return `${index ? ' '.repeat(TABLE_GAP) : ''}${index ? `${fill}${text}` : `${text}${fill}`}`;
  }).join('')}`.replace(/ +$/, '');

  lines.push({ text: dimText(paintRow(kept.map((column) => column.head)), width) });
  rows.forEach((row, at) => {
    const cell = cells[at];
    const values = kept.map((column, index) => {
      if (column.key === 'pool') {
        const name = cut(names[at], widths[index]);
        return tint(name, seriesColor(names[at]));
      }
      const text = cell[column.text];
      if (text == null) return null;
      if (!column.bar || !bar || cell.pct == null) return text;
      // One track length for every row, so the bars compare and the
      // percents still line up at the column's right edge.
      const track = tint(progressBar(cell.pct / 100, bar), seriesColor(names[at]));
      return `${track} ${text.padStart(valueWidth(column))}`;
    });
    lines.push({ text: paintRow(values), action: { kind: 'page', page: 'budget', pool: row.name } });
  });
  if (totals) {
    lines.push({ text: paintRow(kept.map((column) => (column.key === 'pool' ? 'total' : totals[column.text] ?? ''))) });
  }
  const legend = ['≈ ~ estimates (~ is rougher)', `${blank()} not measured`, 'a pool row opens Budget'];
  let legendText = ` ${legend.join(' · ')}`;
  while (visibleLength(legendText) > width && legend.length > 1) {
    legend.pop();
    legendText = ` ${legend.join(' · ')}`;
  }
  lines.push({ text: dimText(legendText, width) });
  return lines;
}

/** The approved Home today band: finished work on the left, licence draw right. */
function legacyHomeTodayBand(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  const today = todayRows(model, nowMs);
  const workflowCount = today.workflows.length;
  const taskCount = today.tasks.length;
  const verified = today.workflows.filter((record) => record.verified === true).length;
  const workflowNoun = `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`;
  const taskNoun = `${taskCount} task${taskCount === 1 ? '' : 's'}`;
  const countText = `${workflowNoun} finished${taskCount ? ` · ${taskNoun} finished` : ''} · ${verified} verified`;
  // The phone has one line for the whole band. Once tasks are present, drop
  // the repeated word "finished" so the three required counts remain
  // visible instead of truncating the verification count.
  const narrowCountText = taskCount
    ? `${workflowNoun} · ${taskNoun} · ${verified} verified`
    : countText;
  const desktopCountText = `${workflowNoun}${taskCount ? ` · ${taskNoun}` : ''} · ${verified} verified`;
  const date = todayDateLabel(today.date, { year: !narrow });
  const licenceRows = todayLicenceRows(model, today, nowMs);
  const runIds = today.workflows.map((record) => record.runId ?? record.shortId).filter(Boolean);
  const taskIds = today.tasks.map((task) => task.id ?? task.taskFile).filter(Boolean);

  if (narrow) {
    body.push(todayPadded(`today · ${date} · ${narrowCountText}`, width));
    body.push(todayBareRule(width));
    if (!today.workflows.length && !today.tasks.length) body.push(todayPadded('no finished workflows or tasks today', width));
    for (const record of today.workflows) body.row(todayWorkflowLine(record, width), { kind: 'run', runId: record.runId ?? record.shortId });
    for (const task of today.tasks) body.row(todayTaskLine(task, width), { kind: 'task', taskId: task.id ?? task.taskFile });
    body.push(todayPadded('Enter on a run → its goal, steps and spend', width));
    body.push(todayBareRule(width));
    body.push(todayPadded('licence spent today · measured worker minutes', width));
    body.push(todayTableRow(null, width, { header: true }));
    if (!licenceRows.length) body.push(todayPadded('no measured pool work today', width));
    for (const row of licenceRows) {
      body.row(todayTableRow(row, width), { kind: 'page', page: 'budget', pool: row.name });
    }
    for (const line of todayLicenceFootnotes(nowMs, width, false)) body.push(line);
  } else {
    const leftWidth = 57;
    const rightWidth = Math.max(1, width - leftWidth - 2);
    body.push(todayPadded(`today · ${date}`, width));
    const left = [
      todayPadded(`finished today · ${desktopCountText}`, leftWidth),
      `${'─'.repeat(Math.max(0, leftWidth - 1))} `,
    ];
    if (!today.workflows.length && !today.tasks.length) left.push(todayPadded('no finished workflows or tasks today', leftWidth));
    for (const record of today.workflows) {
      left.push(todayWorkflowLine(record, leftWidth));
      left.push(todayGoalLine(record, leftWidth));
    }
    for (const task of today.tasks) left.push(todayTaskLine(task, leftWidth));
    left.push(todayPadded('Enter on a run → its steps and spend', leftWidth));
    const right = [
      todayPadded('licence spent today · measured worker minutes', rightWidth),
      todayBareRule(rightWidth),
      todayTableRow(null, rightWidth, { header: true }),
      ...licenceRows.map((row) => todayTableRow(row, rightWidth)),
      ...todayLicenceFootnotes(nowMs, rightWidth, true),
    ];
    const rows = Math.max(left.length, right.length);
    for (let index = 0; index < rows; index += 1) {
      const l = todayPadded(left[index] ?? '', leftWidth);
      const r = todayPadded(right[index] ?? '', rightWidth);
      const action = index >= 2 && index < 2 + today.workflows.length * 2
        && index % 2 === 0
        ? { kind: 'run', runId: today.workflows[(index - 2) / 2]?.runId ?? today.workflows[(index - 2) / 2]?.shortId }
        : index >= 2 + today.workflows.length * 2 && index < 2 + today.workflows.length * 2 + today.tasks.length
          ? { kind: 'task', taskId: today.tasks[index - (2 + today.workflows.length * 2)]?.id ?? today.tasks[index - (2 + today.workflows.length * 2)]?.taskFile }
          : null;
      const rightStart = 2;
      const poolIndex = index - rightStart;
      const rightAction = poolIndex >= 1 && poolIndex <= licenceRows.length
        ? { kind: 'page', page: 'budget', pool: licenceRows[poolIndex - 1]?.name }
        : null;
      body.parts([{ text: l, action }, { text: '│ ' }, { text: r, action: rightAction }]);
    }
  }
  // Capture only this band's rows before the running/recent sections append
  // their own click targets below it.
  body.runRows = body.regions
    .filter((region) => region.action?.kind === 'run')
    .map((region) => ({ runId: region.action.runId, y: region.y }));
  body.taskRows = body.regions
    .filter((region) => region.action?.kind === 'task')
    .map((region) => ({ taskId: region.action.taskId, y: region.y }));
  const desiredTask = opts.selectedTaskId;
  const desiredRun = opts.selectedRunId;
  const selectedTask = desiredTask && taskIds.includes(desiredTask) ? desiredTask : null;
  const selectedRun = desiredRun && runIds.includes(desiredRun) ? desiredRun : runIds[0] ?? null;
  body.cursorAction = selectedTask
    ? { kind: 'task', taskId: selectedTask }
    : selectedRun ? { kind: 'run', runId: selectedRun } : null;
  return { workflowCount, taskCount, verified };
}

/**
 * Home's today block. From 110 columns up it is two equal halves: the top
 * three runs stacked on the left, each card as wide as its half, and the
 * licence table on the right. Below that the cards stack full width and the
 * table reads under them.
 */
function homeTodayBand(model, opts, body) {
  const width = Number(opts.width) || 120;
  const narrow = opts.narrow ?? width < 100;
  const nowMs = opts.nowMs ?? Date.now();
  const today = todayRows(model, nowMs);
  const cards = todayTopRuns(model, nowMs, { limit: 3 });
  const used = new Set(cards.map((card) => card.id));
  // Standalone `bullswarm run` records fill an unused card slot only when
  // fewer than three workflows are available. The real snapshot has seven
  // workflows, so it remains workflow-only while a task-only home is useful.
  for (const task of today.tasks) {
    if (cards.length >= 3) break;
    const id = task?.id ?? task?.taskFile;
    if (!id || used.has(id)) continue;
    const card = taskCardModel(task);
    card.task = true;
    cards.push(card);
    used.add(id);
  }
  const date = todayDateLabel(today.date, { year: !narrow });
  body.push(todayPadded(`Home · Today · ${date} · top ${cards.length} runs (active first)`, width));
  const licenceRows = todayLicenceRows(model, today, nowMs);
  const noCards = { text: dimText(' no runs captured in the real snapshot', width) };
  if (width >= HALVES_WIDTH) {
    const halves = bandHalves(width);
    const left = cards.length ? cards.flatMap((card) => cardRows(card, halves.half)) : [noCards];
    pushHalves(body, left, licenceTableLines(licenceRows, halves.half), halves);
  } else {
    pushStack(body, cards.length ? cards.flatMap((card) => cardRows(card, width)) : [noCards]);
    body.push('');
    pushStack(body, licenceTableLines(licenceRows, width));
  }
  const uniqueRows = (kind, key) => {
    const seen = new Set();
    return body.regions
      .filter((region) => region.action?.kind === kind)
      .map((region) => ({ [key]: region.action[key], y: region.y }))
      .filter((row) => {
        if (row[key] == null || seen.has(row[key])) return false;
        seen.add(row[key]);
        return true;
      });
  };
  body.runRows = uniqueRows('run', 'runId');
  body.taskRows = uniqueRows('task', 'taskId');
  body.cursorAction = body.runRows[0]
    ? { kind: 'run', runId: body.runRows[0].runId }
    : body.taskRows[0] ? { kind: 'task', taskId: body.taskRows[0].taskId } : null;
  const result = {
    workflowCount: today.workflows.length,
    taskCount: today.tasks.length,
    verified: today.workflows.filter((record) => record.verified === true).length,
  };
  Object.defineProperty(result, 'cards', { value: cards, enumerable: false });
  return result;
}

function percentText(value, digits = 0) {
  const amount = Number(value);
  if (value == null || !Number.isFinite(amount)) return null;
  return `${amount.toFixed(digits)}%`;
}

function shareText(value) {
  const amount = Number(value);
  if (value == null || !Number.isFinite(amount)) return null;
  return `${Math.round(amount * 100)}%`;
}

function paceOnly(text) {
  const word = String(text ?? '').replace(/\s*[+\u2212-]\d+pp$/, '').trim();
  return word || blank();
}

function quotaRefusalText(row, nowMs = Date.now()) {
  const marker = row?.quotaRefusal;
  if (row?.meterSource !== 'quota-refusal' && !marker) return null;
  const raw = row?.quotaRefusedAt
    ?? marker?.refusedAt
    ?? marker?.refused_at
    ?? null;
  const at = Date.parse(raw ?? '');
  if (!Number.isFinite(at)) return 'blocked · refused recently';
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  return minutes < 1 ? 'blocked · refused just now' : `blocked · refused ${minutes}m ago`;
}

/** The assignment a run's step was dispatched under, if one was recorded. */
function assignmentOf(model, runId, actionId) {
  return (model.assignments ?? []).find((entry) => entry.runId === runId && entry.actionId === actionId) ?? null;
}

/** The pool a step's newest attempt ran on, for the `step@pool` label. */
function stepPool(row, actionId) {
  const attempt = (row?.state?.attempts ?? []).findLast((entry) => entry.actionId === actionId);
  return attempt?.pool ?? null;
}

/**
 * `widget-lib@cmd ▇▇▇▇▇▇░░░░ 15m/17m`, the per-step bar the prototype draws
 * beside the plan strip.
 */
function stepBarText(action, assignment, { width = 24, nowMs = Date.now(), pool = null } = {}) {
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedMs = Date.parse(assignment?.startedAt ?? action?.startedAt ?? '');
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : null;
  const short = pool == null ? null : String(pool).split(':').pop();
  const actionName = String(action.id);
  const clock = elapsed == null ? blank() : minutesText(elapsed);
  const measured = expected != null && expected > 0 && elapsed != null;
  const timing = `${clock}/${measured ? minutesText(expected) : blank()}`;
  // Pool names are identity labels. Keep the full `action@pool` only when it
  // can fit beside the timing and minimum bar; otherwise drop the pool as a
  // whole instead of letting compactRow paint an `openc…` fragment.
  const fullName = short ? `${actionName}@${short}` : actionName;
  const name = short && visibleLength(fullName) + visibleLength(timing) + 2 + 4 <= width
    ? fullName : actionName;
  const bars = Math.max(4, Math.min(10, width - visibleLength(name) - visibleLength(timing) - 2));
  const bar = measured
    ? tint(progressBar(elapsed / expected, bars), 'green')
    : tint((asciiGlyphsPreferred() ? '.' : '░').repeat(bars), 'dim');
  return {
    measured,
    text: compactRow([
      { text: name, grow: true, min: 1 },
      bar,
      timing,
    ], { width }),
  };
}

/** The `── budget · this week ──` block: one meter row per pool and one dim
 * reset/pace row beneath it. */
function budgetWeekLines(body, model, { width, narrow, nowMs }) {
  const metered = (model.budget?.rows ?? [])
    .filter((row) => row.usedPct != null)
    .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0));
  const rows = metered.slice(0, BUDGET_WEEK_POOLS);
  const leftOut = metered.length - rows.length;
  body.push('');
  body.push(rule('budget · this week', null, width));
  if (!rows.length) {
    body.push(dimText(' no pool reported a licence meter · bullswarm doctor checks the meters', width));
    return;
  }
  const nameWidth = Math.min(16, rows.reduce((most, row) => Math.max(most, String(row.name).length), 0));
  const unpriced = [];
  for (const row of rows) {
    const name = cut(String(row.name), nameWidth).padEnd(nameWidth);
    const used = percentText(row.usedPct) ?? blank();
    const pace = paceWord(row.usedPct, row.elapsedPct);
    const refused = quotaRefusalText(row, nowMs);
    const money = row.subscription?.windowUsd == null
      ? blank()
      : formatMoney(row.subscription.windowUsd);
    if (row.subscription?.windowUsd == null) unpriced.push(row.name);
    const fits = row.fits == null
      ? null
      : `${row.fits} medium run${row.fits === 1 ? '' : 's'} fit${row.fits === 1 ? 's' : ''}`;
    const tail = narrow
      ? visibleLength(`${name} ${used} `) + 12
      : visibleLength(`${name} `) + 46;
    // The meter is capped: past 64 cells a longer bar says nothing more, so
    // the extra width at 200 columns goes to the row's words instead.
    const bar = meterBar(row.usedPct, row.elapsedPct, Math.max(4, Math.min(64, width - tail - 2)), { ansi: meterAnsi() });
    const severity = refused ? 'red' : row.usedPct >= 80 ? 'red' : row.usedPct >= 50 ? 'amber' : 'green';
    body.row(
      narrow
        ? compactRow([
          { text: ` ${name}`, width: nameWidth + 1 },
          bar,
          { text: strong(used), width: 4, align: 'right' },
          { text: tint(refused ?? paceOnly(pace.text), severity), grow: true, min: 3 },
        ], { width })
        : compactRow([
          { text: ` ${name}`, width: nameWidth + 1 },
          bar,
          { text: `${strong(used)} used`, width: 10, align: 'right', gap: 2 },
          { text: money, width: 8, align: 'right', gap: 2 },
          { text: tint(fits ?? blank(), severity), grow: true, min: 6, gap: 2 },
        ], { width }),
      { kind: 'page', page: 'budget', pool: row.name },
    );
    const reset = narrow
      ? `resets ${row.resetsAt ? untilText(row.resetsAt, nowMs) : blank()}`
      : `resets ${row.resetsText ?? blank()}`;
    const elapsed = percentText(row.elapsedPct);
    body.push(dimText(
      `   ${[reset, ...(narrow ? [row.subscription?.windowUsd == null ? null : money] : [elapsed ? `${elapsed} elapsed` : null, refused ?? pace.text ?? null])].filter(Boolean).join(' · ')}`,
      width,
    ));
  }
  if (leftOut > 0) {
    body.push(dimText(
      ` +${leftOut} more metered pool${leftOut === 1 ? '' : 's'} · b opens Budget`,
      width,
    ));
  }
  if (unpriced.length) {
    if (narrow) {
      body.push(dimText(` ${blank()} money: no declared subscription price`, width));
      body.push(dimText('   bullswarm strategy set-subscription', width));
    } else {
      body.push(dimText(
        ` ${blank()} money: no declared subscription price for ${unpriced.join(', ')} · bullswarm strategy set-subscription <pool> --monthly-usd`,
        width,
      ));
    }
  }
  if (unpriced.length < rows.length) {
    body.push(dimText(' money at the declared subscription price, pro-rated over the window', width));
  }
}

/** The local midnight `days` after the day `ms` falls on. */
function dayStart(ms, days = 0) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * The chart's slots, oldest first. A day period has one slot for every day in
 * it, today included, so a day nothing ran on is a drawn zero rather than a
 * missing column; `All time` keeps the model's weekly buckets. A slot is
 * `{ from, usd, partial, source, unpriced, unknown }`: `usd` null with
 * `unknown` set is a day whose runs recorded no price at all.
 */
function spendSlots(spend, periodId, nowMs) {
  const buckets = spend?.buckets ?? [];
  const slotOf = (bucket, from) => {
    const money = bucket ? apiMoney(bucket) : null;
    const ran = (bucket?.runs ?? 0) > 0;
    const attempts = finiteOrNull(bucket?.attempts);
    const priced = finiteOrNull(bucket?.pricedAttempts);
    return {
      from,
      usd: money ? money.usd : ran ? null : 0,
      partial: Boolean(money?.partial),
      source: money ? tokenSourceOf(bucket?.tokenSource, money.usd) : null,
      unpriced: money?.partial && attempts != null && priced != null ? Math.max(0, attempts - priced) : 0,
      unknown: !money && ran,
    };
  };
  if (spend?.bucketBy === 'week') return buckets.map((bucket) => slotOf(bucket, bucket.from));
  const days = periodId === '30d' ? 30 : 7;
  const byKey = new Map(buckets.map((bucket) => [String(bucket.key ?? dayKey(bucket.from)), bucket]));
  return Array.from({ length: days }, (_, index) => {
    const from = dayStart(nowMs, index - (days - 1));
    return slotOf(byKey.get(dayKey(from)) ?? null, from);
  });
}

/**
 * Three or four ticks from $0, a whole number of dollars apart: the step is
 * the nice number that reaches the tallest day in three intervals or fewer,
 * and at least two intervals are drawn so the axis always has three labels.
 */
function spendTicks(max) {
  const top = Number(max) > 0 ? Number(max) : 1;
  const step = Math.max(1, niceStep(top, 3).step);
  const intervals = Math.max(2, Math.ceil(Number((top / step).toPrecision(12))));
  return Array.from({ length: intervals + 1 }, (_, index) => index * step);
}

/** A tick in whole dollars; `~` marks an axis whose bars are approximate. */
function tickText(value, mark) {
  const dollars = `$${Math.round(value).toLocaleString('en-US')}`;
  return value === 0 ? dollars : `${mark}${dollars}`;
}

/**
 * Labels under the columns: every one when they fit, else as many as fit in
 * `room` cells — the newest always among them.
 */
function slotLabelLine(slots, { cell, weekly, room }) {
  const labels = slots.map((slot) => {
    const date = new Date(slot.from);
    return !weekly && slots.length <= 7
      ? DAY_NAMES[date.getDay()]
      : `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
  });
  let line = '';
  let free = 0;
  const place = (index) => {
    const label = labels[index];
    const at = index * cell + Math.max(0, Math.floor((cell - label.length) / 2));
    if (at < free || at + label.length > room) return;
    line = `${line}${' '.repeat(at - line.length)}${label}`;
    free = at + label.length + 1;
  };
  if (labels.every((label) => label.length < cell)) labels.forEach((_, index) => place(index));
  else {
    // Too many columns to name each: name the newest, then every column the
    // gaps leave room for, counting back so the latest day is always named.
    const widest = Math.max(...labels.map((label) => label.length)) + 1;
    const every = Math.max(1, Math.ceil(widest / Math.max(1, cell)));
    const picks = [];
    for (let index = slots.length - 1; index >= 0; index -= every) picks.unshift(index);
    for (const index of picks) place(index);
  }
  return line;
}

/**
 * The spent-per-day chart, `width` wide: one bar per slot from a $0 baseline,
 * a tick every few rows labelled in whole dollars (`~$400` when the bars are
 * approximate — an estimate, or a day with unpriced attempts left out — and
 * `$400` when every bar is a provider-reported whole), the day under each
 * bar, and at most one dim line saying what the bars leave out.
 */
function spendChartLines(model, opts, width) {
  const spend = model.stats?.spendPerDay ?? null;
  const period = PERIOD_ITEMS.find((item) => item.id === opts.period) ?? PERIOD_ITEMS[0];
  const weekly = spend?.bucketBy === 'week';
  const slots = spendSlots(spend, period.id, opts.nowMs ?? Date.now());
  const drawn = slots.filter((slot) => slot.usd != null && slot.usd > 0);
  if (!drawn.length) {
    return [dimText(slots.some((slot) => slot.unknown)
      ? ' no finished run recorded an estimate'
      : ' no finished run in this period', width)];
  }
  const approximate = drawn.some((slot) => slot.partial || slot.source !== 'provider-reported');
  const mark = approximate ? '~' : '';
  const ticks = spendTicks(Math.max(...drawn.map((slot) => slot.usd)));
  const top = ticks.at(-1);
  const intervals = ticks.length - 1;
  const perTick = Math.max(2, Math.round(chartRowCount(opts.height ?? 36) / intervals));
  const rows = intervals * perTick;
  const gutter = Math.max(...ticks.map((tick) => tickText(tick, mark).length));
  const ascii = asciiGlyphsPreferred();
  const plot = Math.max(slots.length, width - gutter - 3);
  const cell = Math.max(1, Math.floor(plot / slots.length));
  const barWidth = cell <= 2 ? 1 : Math.max(1, Math.min(8, Math.round(cell * 0.6)));
  const lead = Math.max(0, Math.floor((cell - barWidth) / 2));
  // A day that spent anything keeps at least one eighth, so it never reads
  // as the zero a day with no run draws.
  const eighths = slots.map((slot) => (slot.usd > 0
    ? Math.max(1, Math.round((slot.usd / top) * rows * 8)) : 0));
  const lines = [];
  for (let row = rows; row >= 1; row -= 1) {
    const tick = row % perTick === 0 ? ticks[row / perTick] : null;
    const axis = tick == null ? (ascii ? '|' : '│') : (ascii ? '|' : '┤');
    let line = ` ${(tick == null ? '' : tickText(tick, mark)).padStart(gutter)} ${dimText(axis, 1)}`;
    slots.forEach((slot, index) => {
      const filled = Math.max(0, Math.min(8, eighths[index] - (row - 1) * 8));
      const glyph = filled ? (ascii ? (filled >= 4 ? '#' : '.') : EIGHTHS[filled - 1]) : null;
      let painted = glyph ? tint(glyph.repeat(barWidth), 'cyan') : ' '.repeat(barWidth);
      // A day whose runs recorded no price at all is unknown, not zero.
      if (!glyph && row === 1 && slot.unknown) painted = `${dimText(blank(), 1)}${' '.repeat(barWidth - 1)}`;
      line += `${' '.repeat(lead)}${painted}${' '.repeat(Math.max(0, cell - lead - barWidth))}`;
    });
    lines.push(line.replace(/ +$/, ''));
  }
  const baseline = `${ascii ? '+' : '┼'}${(ascii ? '-' : '─').repeat(cell * slots.length)}`;
  lines.push(` ${tickText(0, mark).padStart(gutter)} ${dimText(baseline, baseline.length)}`);
  lines.push(`${' '.repeat(gutter + 3)}${slotLabelLine(slots, { cell, weekly, room: Math.max(cell * slots.length, plot) })}`);
  const unpriced = slots.reduce((sum, slot) => sum + slot.unpriced, 0);
  const unknownDays = slots.filter((slot) => slot.unknown).length;
  const notes = [
    unpriced ? `~ bars leave ${unpriced} unpriced attempt${unpriced === 1 ? '' : 's'} out` : null,
    unknownDays ? `${blank()} no price recorded` : null,
  ].filter(Boolean);
  if (notes.length) lines.push(dimText(` ${notes.join(' · ')}`, width));
  return lines;
}

/**
 * One breakdown section, `width` wide: its dim label, then up to four rows of
 * name, bar and figure across the whole width, then `+N more` when the period
 * holds more. Pools and models read their share of the period's agent
 * minutes; projects read their run count, the bar that count's share.
 */
function breakdownSection(label, list, { width, role, runs = false, nameWidth }) {
  const shown = list.slice(0, BREAKDOWN_ROWS);
  const more = list.length - shown.length;
  const allRuns = list.reduce((sum, row) => sum + (finiteOrNull(row.runs) ?? 0), 0);
  const figures = shown.map((row) => (runs
    ? (finiteOrNull(row.runs) == null ? null : String(row.runs))
    : shareText(row.minutesShare)));
  const figureWidth = Math.max(4, ...figures.map((text) => visibleLength(text ?? blank())));
  const bars = Math.max(3, width - 1 - nameWidth - 1 - figureWidth - 1);
  const rows = shown.map((row, index) => {
    const name = String(row.name ?? '?');
    const share = runs
      ? (allRuns > 0 ? (finiteOrNull(row.runs) ?? 0) / allRuns : null)
      : finiteOrNull(row.minutesShare);
    const bar = share == null ? ' '.repeat(bars) : tint(progressBar(share, bars), seriesColor(name) ?? role);
    const figure = (figures[index] ?? blank()).padStart(figureWidth);
    return ` ${cut(name, nameWidth).padEnd(nameWidth)} ${bar} ${figure}`;
  });
  return [
    dimText(` ${label}`, width),
    ...(rows.length ? rows : [dimText(' no finished run in this period', width)]),
    ...(more > 0 ? [dimText(` +${more} more`, width)] : []),
  ];
}

/**
 * The period band's cells: the spent-per-day chart, then `by pool`,
 * `by model` and `by project`, each `{ action, rows }` and `cellWidth` wide.
 * The breakdowns share one name column, so their bars start together.
 */
function breakdownCells(model, opts, { cellWidth }) {
  const breakdown = model.stats?.overview?.breakdown ?? { pools: [], models: [], projects: [] };
  const spend = model.stats?.spendPerDay ?? null;
  const lists = {
    pools: breakdown.pools ?? [], models: breakdown.models ?? [], projects: breakdown.projects ?? [],
  };
  const longest = Object.values(lists)
    .flatMap((list) => list.slice(0, BREAKDOWN_ROWS))
    .reduce((most, row) => Math.max(most, String(row.name ?? '?').length), 6);
  const nameWidth = Math.min(longest, Math.max(6, Math.floor((cellWidth - 1) * 0.45)));
  const section = (label, key, role, tab, runs = false) => ({
    action: { kind: 'tab', tab },
    rows: breakdownSection(label, lists[key], { width: cellWidth, role, runs, nameWidth }),
  });
  return [
    {
      action: { kind: 'trend', metric: 'spend' },
      rows: [
        dimText(` spent per ${spend?.bucketBy === 'week' ? 'week' : 'day'}`, cellWidth),
        ...spendChartLines(model, opts, cellWidth),
      ],
    },
    // The Stats tab each section opens: its `pool`, `model` and `project`
    // views (STATS_TABS in dashboard.js).
    section('by pool · share of agent minutes', 'pools', 'green', 'pool'),
    section('by model · share of agent minutes', 'models', 'purple', 'model'),
    section('by project · runs', 'projects', 'orange', 'project', true),
  ];
}

/**
 * The period band under its toggle: the chart in the left half and the three
 * breakdowns stacked in the right one, a blank row between them; below 110
 * columns the four read one under another. Each line keeps its cell's action,
 * so a click on the chart opens the spend trend and one on a section its tab.
 */
function periodBand(model, opts, body) {
  const { width } = opts;
  const split = width >= HALVES_WIDTH;
  const halves = split ? bandHalves(width) : null;
  const [chart, ...sections] = breakdownCells(model, opts, { cellWidth: split ? halves.half : width });
  const linesOf = (cell) => cell.rows.map((text) => ({ text, action: cell.action }));
  const stacked = sections.flatMap((cell, index) => [
    ...(index ? [{ text: '' }] : []),
    ...linesOf(cell),
  ]);
  if (split) pushHalves(body, linesOf(chart), stacked, halves);
  else {
    pushStack(body, linesOf(chart));
    body.push('');
    pushStack(body, stacked);
  }
}

/**
 * The period's median run, with the basis it was measured on: active minutes,
 * or the span a period with no provable active interval falls back to — said
 * as `span`, because a span is never passed off as active time.
 */
function medianRunText(model) {
  const overview = model.stats?.overview ?? null;
  const median = medianRunDuration(model.rollups ?? [], {
    from: overview?.from ?? null,
    to: overview?.to ?? null,
  });
  if (median.minutes == null) return blank();
  return median.basis === 'span' ? `span ${minutesText(median.minutes)}` : minutesText(median.minutes);
}

/** A run row's duration: active minutes, else the span it recorded, said so. */
function recentDurationText(record) {
  const active = finiteOrNull(record?.minutes?.active);
  if (active != null && active >= 0) return minutesText(active);
  const span = finiteOrNull(record?.minutes?.span ?? record?.minutes?.wall);
  return span == null || span < 0 ? blank() : `span ${minutesText(span)}`;
}

function summaryBand(body, model, opts) {
  const { width, narrow } = opts;
  const overview = model.stats?.overview ?? null;
  const keys = overview?.keys ?? null;
  if (!keys) return;
  const projects = model.stats?.projects ?? null;
  const verified = (overview.breakdown?.projects ?? []).reduce((sum, row) => sum + (row.verified ?? 0), 0);
  const runs = keys.workflows ?? 0;
  // The period's spend through the shared money rule: the strict total when
  // every attempt was priced, else the recorded subtotal named with its
  // coverage, so this line can never say `unknown` while the chart above it
  // draws three bars.
  const totals = projects?.totals ?? null;
  // The period's spend through the Run spend block's own helper: a partial
  // scope reads `at least $X api · N unmeasured`, a whole one keeps its
  // provider/estimate words. It can never say `unknown` while the chart
  // above it draws three bars.
  const spentFacts = spendFacts({
    attempts: totals?.attempts ?? null,
    pricedAttempts: totals?.pricedAttempts ?? null,
    measuredAttempts: totals?.measuredAttempts ?? null,
    apiKnownSubtotalUsd: totals?.apiKnownSubtotalUsd ?? null,
    subscriptionKnownSubtotalUsd: totals?.subscriptionKnownSubtotalUsd ?? null,
    subscriptionPricedAttempts: totals?.subscriptionPricedAttempts ?? null,
  });
  const wholePair = moneyText({ ...keys, apiUsd: totals?.apiUsd ?? keys.apiUsd ?? null });
  const wholeApi = wholePair.split(' · ')[0];
  const apiPart = spentFacts ? honestApiTotalText(spentFacts, { whole: wholeApi }) : wholeApi;
  const money = [apiPart, ...wholePair.split(' · ').slice(1)].join(' · ');
  const share = runs ? shareText(verified / runs) : null;
  const named = (row) => (row?.name ? String(row.name) : blank());
  const figures = [
    [
      `Workflows: ${strong(tint(String(runs), 'orange'))} · verified ${tint(String(verified), 'orange')}${share ? ` (${share})` : ''}`,
      `Busiest project: ${tint(named(keys.busiestProject), 'orange')}${keys.busiestProject ? ` (${keys.busiestProject.runs})` : ''}`,
    ],
    [
      `Favourite pool: ${tint(named(keys.favouritePool), 'orange')}`,
      `Favourite model: ${tint(named(keys.favouriteModel), 'orange')}`,
    ],
    [
      `Spent: ${tint(money, 'orange')}`,
      `Median run: ${tint(medianRunText(model), 'orange')}`,
    ],
  ];
  body.push('');
  if (narrow) {
    for (const figure of figures.flat()) body.push(cut(` ${figure}`, width));
  } else {
    pushColumns(body, figures.map((rows) => ({ rows })), { width: width - 1, gap: 2 });
  }
  body.push('');
  const sentence = apiPart && !apiPart.includes('api unknown')
    ? `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded ${apiPart} of API-equivalent work`
    : `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded no API-equivalent estimate`;
  body.push(cut(` ${tint(sentence, 'purple')}`, width));
}

function homePage(model, opts, body) {
  const normalized = {
    ...opts,
    width: Number(opts.width) || 120,
    narrow: opts.narrow ?? (Number(opts.width) || 120) < 100,
    nowMs: opts.nowMs ?? Date.now(),
  };
  homeTodayBand(model, normalized, body);
  activeRunLines(model, normalized, body);
  return homeDetails(model, normalized, body);
}

function activeRunLines(model, opts, body, title = 'running') {
  const { width, narrow, nowMs } = opts;
  const tasks = Array.isArray(model.tasks?.inflight) ? model.tasks.inflight : [];
  body.push('');
  body.push(rule(title, null, width));
  if (!model.runs.length && !tasks.length) {
    body.push(dimText(title === 'running'
      ? ' nothing running right now'
      : ' nothing in flight · bullswarm workflow goal "<goal>" launches one', width));
  }
  const unratedPools = new Set();
  model.runs.forEach((run, index) => {
    const progress = planProgress(run, { assignments: model.assignments, nowMs });
    const elapsed = ageText(stateStartedAt(run.state), nowMs);
    const right = [
      progress.phases ? `phase ${progress.phase}/${progress.phases}` : null,
      `${progress.done}/${progress.total}`,
      elapsed || null,
    ].filter(Boolean).join(' · ');
    const label = ` ${tint(glyphs().ongoing, 'cyan')} ${index < 9 ? `${index + 1}.` : ''}${run.shortId ?? run.runId}`;
    const titleText = `  ${cut(workflowRunLabel(run), Math.max(8, width - visibleLength(label) - visibleLength(right) - 4))}`;
    const head = `${label}${strong('')}${titleText}`;
    body.parts([
      { text: head, action: { kind: 'run', runId: run.runId } },
      { text: ' '.repeat(Math.max(1, width - visibleLength(head) - visibleLength(right) - 1)) },
      { text: dimText(right, width) },
    ]);

    const economics = runEconomics(run, model.pools, nowMs);
    for (const pool of economics.pools) if (pool.sharePct == null) unratedPools.add(pool.name);
    const draw = economics.pools.reduce(
      (sum, pool) => (pool.sharePct == null ? sum : (sum ?? 0) + pool.sharePct),
      null,
    );
    // A live run's own attempts answer for the money: `at least $X api · N
    // unmeasured` while some attempt has no price yet, through the Run spend
    // block's helper.
    const pair = moneyText(economics);
    const liveFacts = recordSpendFacts(run);
    const money = [honestApiTotalText(liveFacts, { whole: pair.split(' · ')[0] }), ...pair.split(' · ').slice(1)].join(' · ');
    const cost = `${tint(draw == null ? blank() : formatDashboardValue(draw, 'percent'), 'purple')} · ${tint(money ?? blank(), 'purple')}`;

    const live = (run.state?.actions ?? []).filter((action) => action.status === 'running');
    const bars = live.map((action) => {
      const bar = stepBarText(action, assignmentOf(model, run.runId, action.id), {
        width: narrow ? width - 4 : 30, nowMs, pool: stepPool(run, action.id),
      });
      return { action, ...bar };
    });

    if (narrow) {
      // The phone keeps the prototype's shape: the strip, one row per live
      // step, then the run's own draw and cost.
      body.parts([{ text: '   ' }, ...planStripParts(run, { runId: run.runId })]);
      for (const bar of bars) {
        body.row(`   ${bar.text}`, { kind: 'step', runId: run.runId, actionId: bar.action.id });
      }
      body.push(cut(`   ${cost}`, width));
    } else {
      // Two rows per run: the head above, and the strip, the per-step bars
      // and the cost on one band here.
      const strip = planStripParts(run, { runId: run.runId });
      const stripWidth = strip.reduce((sum, part) => sum + visibleLength(part.text), 0);
      const parts = [{ text: '   ' }, ...strip];
      let used = 3 + stripWidth;
      const room = width - visibleLength(cost) - 2;
      for (const bar of bars) {
        const span = visibleLength(bar.text) + 2;
        if (used + span > room) break;
        parts.push({ text: '  ' });
        parts.push({ text: bar.text, action: { kind: 'step', runId: run.runId, actionId: bar.action.id } });
        used += span;
      }
      parts.push({ text: ' '.repeat(Math.max(1, width - used - visibleLength(cost) - 1)) });
      parts.push({ text: cost });
      body.parts(parts);
    }
  });
  for (const task of tasks) {
    const label = `${glyphs().inflight} ${task?.lane ?? 'lane unavailable'} · ${taskPoolModelText(task)}`;
    const project = task?.project ? ` · ${task.project}` : '';
    const elapsed = taskElapsedText(task, nowMs);
    const line = compactRow([
      { text: ` ${label}`, grow: true, min: 8 },
      { text: `${taskIdText(task)}${project}`, grow: true, min: 4, gap: 2 },
      { text: elapsed, width: Math.max(5, visibleLength(elapsed)), align: 'right', gap: 2 },
      { text: ' ', width: 1, gap: 0 },
    ], { width });
    body.row(line, { kind: 'task', taskId: task?.id ?? task?.taskFile ?? null });
  }
  if (unratedPools.size) {
    body.push(dimText(` ${blank()} no measured %/minute rate for ${[...unratedPools].join(', ')}, so no licence draw`, width));
  }
}

/**
 * The rest of Home: the week's budget, the period band below it with the
 * spent-per-day chart and the three breakdown lists, the period's key figures
 * and the recent-run list. Home leads with the today cards and the licence
 * block above all of this.
 */
function homeDetails(model, opts, body) {
  const { width, narrow, nowMs } = opts;
  budgetWeekLines(body, model, { width, narrow, nowMs });

  const period = PERIOD_ITEMS.find((item) => item.id === opts.period) ?? PERIOD_ITEMS[0];
  body.push('');
  const toggle = periodToggle(PERIOD_ITEMS, { active: period.id, width: narrow ? width - 2 : Math.max(10, width - 24) });
  if (narrow) {
    body.push(rule(period.label.toLowerCase(), null, width));
    body.kit({ text: ` ${toggle.text}`, regions: toggle.regions.map((region) => ({ ...region, x: region.x + 1 })) });
  } else {
    const head = rule(period.label.toLowerCase(), null, Math.max(4, width - visibleLength(toggle.text) - 2));
    body.kit({ text: `${head} ${toggle.text} `, regions: toggle.regions.map((region) => ({ ...region, x: region.x + visibleLength(head) + 1 })) });
  }
  periodBand(model, opts, body);

  summaryBand(body, model, opts);

  body.push('');
  body.push(rule('recent', 'history ›', width));
  // Finished runs only: a live run, and a run a plan revision reopened (its
  // index row says running), sit in the running block above, whatever their
  // failed steps or earlier finish.
  const recent = (model.rollups ?? []).filter(isFinishedRun)
    .sort((a, b) => String(b.finishedAt ?? b.startedAt ?? '').localeCompare(String(a.finishedAt ?? a.startedAt ?? '')))
    .slice(0, narrow ? 3 : 5);
  if (!recent.length) {
    body.push(dimText(' no run has been rolled up yet · bullswarm workflow reindex backfills them', width));
  }
  // The duration cell carries the run's basis (`span` when the record proved
  // no active interval) beside its money, so the desktop cell is wider than
  // the bare duration it replaced rather than five columns of truncated money.
  // A partly-priced run's total also has to fit the coverage that makes it a
  // lower bound (`at least $X · N unmeasured`), so the cell takes the width
  // its own five records need, bounded so the goal keeps its own column.
  const recentCells = recent.map((record) => {
    const money = recordMoneyPair(record);
    return {
      record,
      duration: recentDurationText(record),
      // The phone has one short cell for the duration and the money, so it
      // keeps the API phrase alone (`at least $9.52`); the counts it belongs
      // to are named on the card above and in the period band below.
      money: narrow ? money.apiSlotText ?? blank() : money.text ?? blank(),
    };
  });
  const durationWidth = Math.max(
    narrow ? 16 : 21,
    ...recentCells.map((cell) => visibleLength(`${cell.duration} · ${cell.money}`)),
  );
  const moneyWidth = Math.min(durationWidth, narrow ? 21 : 44);
  for (const { record, duration, money } of recentCells) {
    // The Run page header's own mark for this status (runStatusMark).
    const { glyph, tone } = runStatusMark(record);
    const ok = tone ? tint(glyphs()[glyph], tone) : dimText(glyphs()[glyph], 2);
    body.row(compactRow([
      { text: ` ${ok}`, width: 2 },
      { text: strong(record.shortId ?? record.runId), width: 7 },
      {
        text: cut(`${record.project ?? blank()} · ${String(record.goal ?? '').split('\n')[0]}`, Math.max(6, width - 34 - (moneyWidth - 16))),
        grow: true,
        min: 6,
        gap: 2,
      },
      { text: `${duration} · ${money}`, width: moneyWidth, align: 'right', gap: 2 },
      { text: dimText(`${ageText(record.finishedAt, nowMs)} ago`, 12), width: 11, align: 'right', gap: 2 },
    ], { width }), { kind: 'run', runId: record.runId });
  }
  if (narrow) body.push(dimText(' ≈ API-equivalent estimates · click tiles for charts', width));
  return ' bullswarm · home';
}

export {
  homePage,
  homeTodayBand,
  cardStatusText,
  cardMoneySlot,
  cardLines,
  taskCardModel,
  licenceCells,
  licenceTableLines,
  homeDetails,
  medianRunText,
  recentDurationText,
  todayGoalLine,
  todayWorkflowLine,
  todayTaskLine,
  todayPoolName,
  todayTableRow,
  todayBareRule,
  todayPadded,
  todayLicenceFootnotes,
  paceOnly,
  budgetWeekLines,
  breakdownCells,
  spendChartLines,
  spendTicks,
  periodBand,
  summaryBand,
  activeRunLines,
  taskIdText,
  taskPoolModelText,
  taskElapsedText,
  stepBarText,
  assignmentOf,
  stepPool,
};
