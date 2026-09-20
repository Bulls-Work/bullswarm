// The Home page renderer.
//
// The model in home-model.js supplies the width-independent rows. This module
// paints those rows and keeps hit-region registration in the same body builder
// contract used by the dashboard shell.

import { asciiGlyphsPreferred, glyphs } from '../lib/glyphs.js';
import { finiteOrNull } from '../lib/num.js';
import { dayKey } from './history.js';
import { METER_COLORS, meterBar, paceWord, untilText } from './usage-view.js';
import {
  chartRowCount,
  columnBars,
  compactRow,
  cut,
  formatDashboardValue,
  periodToggle,
  progressBar,
  rule,
  seriesColor,
} from './dash-kit.js';
import {
  measuredTaskMinutes,
  medianRunDuration,
  recordMoneyPair,
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
  worstTokenSource,
  workflowRunLabel,
} from './dashboard.js';
import { apiMoney, apiMoneyText, formatMoney } from '../lib/usage-basis.js';

const BUDGET_WEEK_POOLS = 4;
const WEEKDAY_LETTERS = Object.freeze(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
// The licence block's five slots, in plain words: the header names them, and a
// column too narrow for the whole sentence wraps the last three under the first.
const LICENCE_HEADER = 'licence · pool · worker-minutes · weekly share · API · subscription';
const LICENCE_HEADER_LINES = Object.freeze([
  'licence · pool · worker-minutes',
  '         weekly share · API · subscription',
]);
const LICENCE_MIN_WIDTH = 40;
// A card's own fields need this much before the box clips them; three cards
// that do not fit beside the licence column stack instead.
const MIN_CARD_WIDTH = 36;
const CARD_GAP = '  ';

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
    row?.apiUsd == null && row?.subscriptionUsd == null && !row?.tokenSource ? blank()
      : compactUsageBasisText({ apiUsd: row?.apiUsd, subscriptionUsd: row?.subscriptionUsd, tokenSource: row?.tokenSource, subscriptionBasis: row?.subscriptionBasis }, specs.api),
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
      'weekly share is measured worker-minutes against the pool window',
      '— means the real snapshot supplied no measurement',
      'API and subscription amounts keep their provider/estimate basis',
      'live window used share is on Budget',
    ]
    : [
      'weekly share is measured worker-minutes against the pool window',
      '— means the real snapshot supplied no measurement',
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

function cardMoneySlot(raw, value) {
  const text = String(raw ?? '');
  if (!text || text.startsWith('api unknown') || text.startsWith('sub unknown')) return blank();
  const amount = value?.usd == null ? null : formatMoney(value.usd, value.tokens ?? null);
  if (amount == null || amount === '-') return blank();
  const prefix = text.startsWith('≈ ') ? '≈ ' : text.startsWith('~ ') ? '~ ' : '';
  return `${prefix}${amount}`;
}

function cardLines(card, width, { task = false } = {}) {
  const inner = Math.max(1, width - 2);
  const goal = cut(String(card.name ?? 'run'), Math.max(1, inner - 3));
  const project = cut(String(card.project ?? blank()), Math.max(1, inner - 9));
  const status = cardStatusText(card.status);
  const verdict = String(card.verdict ?? '—');
  const minuteValue = card.minutes?.active == null ? blank() : `${Number(card.minutes.active).toFixed(2)}m`;
  const minuteLabel = 'active';
  const steps = card.steps?.done != null && card.steps?.total != null
    ? `${card.steps.done}/${card.steps.total}` : '—';
  const money = card.money ?? recordMoneyPair(card.record ?? {});
  const [apiRaw = '', subRaw = ''] = String(money.text ?? '').split(' · ');
  // The card's API slot shows whatever the pair's API side says: the strict
  // amount, or the recorded subtotal a partly-priced run really holds. The
  // `≈` in front of it comes from the pair's own wording.
  const apiAmount = apiMoney({
    apiUsd: money.api?.usd ?? null,
    apiKnownSubtotalUsd: money.apiKnownSubtotalUsd ?? null,
    apiCoverage: money.apiCoverage ?? null,
    tokenSource: money.tokenSource ?? null,
  });
  const api = cardMoneySlot(apiRaw, { usd: apiAmount?.usd ?? null, tokens: money.tokens });
  const subscription = cardMoneySlot(subRaw, { ...money.subscription, tokens: money.tokens });
  const content = [
    task ? ` ${project} · task · ${status}` : ` ${project} · ${status} · ${verdict}`,
    ` ${minuteLabel} ${minuteValue} · steps ${steps}`,
    ` API ${api} · subscription ${subscription}`,
  ];
  if (width >= 56 && card.minutes?.span != null) {
    content[1] += ` · span ${Number(card.minutes.span).toFixed(2)}m`;
  }
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

/** How many cards flow side by side in `width` columns without clipping. */
function cardColumnsFor(count, width) {
  if (count <= 1) return 1;
  const needed = count * MIN_CARD_WIDTH + (count - 1) * CARD_GAP.length;
  return width >= needed ? count : 1;
}

/**
 * The cards as part rows, `columns` across. Each painted line carries the
 * action of the card it belongs to, so a click lands on that card's run.
 */
function cardGridLines(cards, width, columns) {
  const count = Math.max(1, Math.min(columns, cards.length));
  const lines = [];
  for (let start = 0; start < cards.length; start += count) {
    const slice = cards.slice(start, start + count);
    const base = Math.max(1, Math.floor((width - CARD_GAP.length * (slice.length - 1)) / slice.length));
    const widths = slice.map((card, index) => (index === slice.length - 1
      ? Math.max(1, width - (base + CARD_GAP.length) * (slice.length - 1))
      : base));
    const rendered = slice.map((card, index) => cardLines(card, widths[index], { task: card.task }));
    const height = Math.max(...rendered.map((entry) => entry.length));
    for (let row = 0; row < height; row += 1) {
      const parts = [];
      rendered.forEach((entry, index) => {
        const card = slice[index];
        parts.push({
          text: entry[row] ?? ' '.repeat(widths[index]),
          action: card.task
            ? { kind: 'task', taskId: card.id }
            : { kind: 'run', runId: card.record?.runId ?? card.id },
        });
        if (index < rendered.length - 1) parts.push({ text: CARD_GAP });
      });
      lines.push(parts);
    }
  }
  return lines;
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

/** One pool's licence facts in plain words, without padding. */
function licenceRowText(row, width = null) {
  const name = width == null ? String(row?.name ?? '—') : todayPoolName(row?.name, Math.max(1, width));
  const worker = row?.workerMinutes == null ? blank() : Number(row.workerMinutes).toFixed(2);
  const share = row?.weeklyShare == null ? blank() : `${Number(row.weeklyShare).toFixed(1)}%`;
  const api = licenceMoney(apiMoney(row), row?.tokenSource);
  const subscription = licenceMoney(row?.subscriptionUsd);
  return `${name} · ${worker} · ${share} · ${api} · ${subscription}`;
}

function licenceLine(row, width) {
  return todayPadded(licenceRowText(row, width), width);
}

/** The header sentence, wrapped when the column cannot hold it in one row. */
function licenceHeaderLines(width) {
  return width != null && width < visibleLength(LICENCE_HEADER)
    ? LICENCE_HEADER_LINES : [LICENCE_HEADER];
}

/** The measured width a licence column wants: its words, never its own noise. */
function licenceColumnWidth(rows) {
  const widest = LICENCE_HEADER_LINES.reduce(
    (most, line) => Math.max(most, visibleLength(line)),
    LICENCE_MIN_WIDTH,
  );
  return rows.reduce((most, row) => Math.max(most, visibleLength(licenceRowText(row))), widest);
}

/** The licence block as its own column of rows, for the desktop band. */
function licenceColumnLines(rows, width) {
  const lines = licenceHeaderLines(width).map((line) => ({ text: todayPadded(line, width) }));
  if (!rows.length) lines.push({ text: todayPadded('none measured in the real snapshot', width) });
  for (const row of rows) {
    lines.push({
      text: todayPadded(licenceRowText(row, width), width),
      action: { kind: 'page', page: 'budget', pool: row.name },
    });
  }
  return lines;
}

function licenceBlock(rows, { width }, body) {
  for (const line of licenceHeaderLines(width)) body.push(todayPadded(line, width));
  if (!rows.length) body.push(todayPadded('none measured in the real snapshot', width));
  for (const row of rows) {
    body.row(licenceLine(row, width), { kind: 'page', page: 'budget', pool: row.name });
  }
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

/** Home's today block: three cards, beside the plain-words licence block. */
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
  if (!cards.length) body.push(todayPadded('no runs captured in the real snapshot', width));
  if (width >= 120) {
    // The owner's desktop note: the top three runs and licence usage share the
    // same rows. The licence column takes only the width its own words need,
    // so the cards keep the rest — side by side when three of them fit there,
    // stacked when they do not.
    const gap = 2;
    const licenceWidth = Math.max(LICENCE_MIN_WIDTH, Math.min(Math.floor(width / 2), licenceColumnWidth(licenceRows)));
    const cardsWidth = Math.max(1, width - licenceWidth - gap);
    const cardRows = cardGridLines(cards, cardsWidth, cardColumnsFor(cards.length, cardsWidth));
    const licenceLines = licenceColumnLines(licenceRows, licenceWidth);
    const rows = Math.max(cardRows.length, licenceLines.length);
    for (let row = 0; row < rows; row += 1) {
      const parts = [...(cardRows[row] ?? [{ text: ' '.repeat(cardsWidth) }])];
      parts.push({ text: ' '.repeat(gap) });
      parts.push(licenceLines[row] ?? { text: ' '.repeat(licenceWidth) });
      body.parts(parts);
    }
  } else {
    if (cards.length) {
      // The phone stacks one card per row and keeps the licence block under
      // it; a 100–119 column terminal still flows the cards across the width.
      if (narrow) {
        for (const card of cards) {
          for (const line of cardLines(card, width, { task: card.task })) {
            body.row(line, { kind: card.task ? 'task' : 'run', ...(card.task
              ? { taskId: card.id } : { runId: card.record?.runId ?? card.id }) });
          }
        }
      } else {
        for (const parts of cardGridLines(cards, width, cardColumnsFor(cards.length, width))) body.parts(parts);
      }
      body.push('');
    }
    licenceBlock(licenceRows, opts, body);
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

function breakdownCells(model, opts, { cellWidth }) {
  const { period } = opts;
  const breakdown = model.stats?.overview?.breakdown ?? { pools: [], models: [], projects: [] };
  const spend = model.stats?.spendPerDay ?? null;
  const rows = 4;
  // A day's recorded figure, through the shared money rule: the strict total
  // when every attempt in it was priced, else the sum over the attempts that
  // were. A partly-priced day has no strict total, and charting nothing there
  // would say the day cost nothing, which the rollups contradict. A day's
  // `tokenSource` is the worst of its attempts, so it may only blank a whole
  // figure — never the subtotal the priced attempts really recorded.
  const bucketSpend = (bucket) => apiMoney(bucket);
  const spendTokenSource = (spend?.buckets ?? []).reduce((source, bucket) => (
    bucketSpend(bucket) == null
      ? source
      : worstTokenSource(source, tokenSourceOf(bucket?.tokenSource, bucketSpend(bucket).usd))
  ), null) ?? tokenSourceOf(spend?.tokenSource, spend?.total ?? spend?.apiKnownSubtotalUsd);
  const barOf = (share, role, label, width) => {
    const value = Number(share);
    const raw = shareText(share) ?? blank();
    const text = raw.padStart(4);
    const bars = Math.max(3, width - visibleLength(label) - visibleLength(text) - 2);
    const bar = Number.isFinite(value) ? tint(progressBar(value, bars), role) : ' '.repeat(bars);
    return `${label} ${bar} ${text}`;
  };
  const listCell = (label, key, role, tab) => {
    const list = (breakdown[key] ?? []).slice(0, rows);
    const nameWidth = Math.min(
      Math.max(6, Math.floor(cellWidth / 2)),
      list.reduce((most, row) => Math.max(most, String(row.name ?? '?').length), 6),
    );
    return {
      action: { kind: 'tab', tab },
      rows: [
        dimText(label, cellWidth),
        ...(list.length
          ? list.map((row) => barOf(row.minutesShare, seriesColor(row.name ?? '?') ?? role, cut(String(row.name ?? '?'), nameWidth).padEnd(nameWidth), cellWidth))
          : [dimText('no finished run in this period', cellWidth)]),
      ],
    };
  };
  const buckets = spend?.buckets ?? [];
  const chartBuckets = buckets.filter((bucket) => bucketSpend(bucket) != null);
  // A chart that draws any subtotal is a lower bound throughout, so the whole
  // axis carries the `≈` mark rather than one bar claiming to be exact.
  const partialSpend = chartBuckets.some((bucket) => bucketSpend(bucket).partial);
  const chart = chartBuckets.length
    ? columnBars(
      [{ name: 'spent', values: chartBuckets.map((bucket) => bucketSpend(bucket).usd), color: METER_COLORS.cyan }],
      chartBuckets.map((bucket) => WEEKDAY_LETTERS[bucket.weekday] ?? String(bucket.label ?? '').slice(-2)),
      {
        width: cellWidth,
        rowCount: chartRowCount(opts.height ?? 36),
        col: Math.max(2, Math.floor((cellWidth - 7) / Math.max(1, chartBuckets.length))),
        barW: 3, unit: '$', mark: partialSpend ? '≈'
          : spendTokenSource === 'provider-reported' ? ''
            : spendTokenSource === 'transcript-summed' ? '≈'
              : spendTokenSource === 'estimated:utf8-bytes/4' ? '~' : '·',
        totals: false, colors: meterAnsi(),
      },
    )
    : [dimText((spend?.buckets ?? []).length
      ? 'no finished run recorded an estimate'
      : 'no finished run in this period', cellWidth)];
  return [
    {
      action: { kind: 'trend', metric: 'spend' },
      rows: [dimText(`spent per ${spend?.bucketBy === 'week' ? 'week' : 'day'}`, cellWidth), ...chart],
    },
    listCell('by pool', 'pools', 'green', 'pools'),
    listCell('by model', 'models', 'purple', 'models'),
    listCell('by project', 'projects', 'orange', 'projects'),
  ].map((cell) => ({ ...cell, period }));
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
  const spentMoney = apiMoney({
    apiUsd: totals?.apiEquivalentUsd ?? totals?.apiUsd ?? null,
    apiKnownSubtotalUsd: totals?.apiKnownSubtotalUsd ?? null,
    attempts: totals?.attempts ?? null,
    pricedAttempts: totals?.pricedAttempts ?? null,
    tokenSource: totals?.tokenSource ?? null,
  });
  const money = spentMoney?.partial
    ? [
      apiMoneyText(spentMoney, null, null, { coverage: true }),
      ...moneyText({ ...keys, apiUsd: null }).split(' · ').slice(1),
    ].join(' · ')
    : moneyText({ ...keys, apiUsd: spentMoney?.usd ?? null });
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
  const apiPart = money.split(' · ')[0];
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
      ? ' none captured in the real snapshot'
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
    const money = moneyText(economics);
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
  if (narrow) {
    for (const cell of breakdownCells(model, opts, { cellWidth: width - 1 })) {
      const base = body.lines.length;
      const rows = cell.rows;
      for (const line of rows) body.push(` ${cut(line, width - 1)}`);
      if (cell.action) {
        for (let row = base + 1; row <= body.lines.length; row += 1) {
          body.regions.push({ x1: 1, x2: width, y: row, action: cell.action });
        }
      }
    }
  } else {
    const gap = 2;
    const inner = Math.max(4, width - 1 - gap * 3);
    const cellWidth = Math.floor(inner / 4);
    pushColumns(body, breakdownCells(model, opts, { cellWidth }), { width: width - 1, gap });
  }
  if (!narrow) body.push(dimText(' spent per day carries the provider/transcript/estimate basis · share is measured worker-minutes · click a column for its Stats tab', width));

  summaryBand(body, model, opts);

  body.push('');
  body.push(rule('recent', 'history ›', width));
  const recent = [...(model.rollups ?? [])]
    .sort((a, b) => String(b.finishedAt ?? b.startedAt ?? '').localeCompare(String(a.finishedAt ?? a.startedAt ?? '')))
    .slice(0, narrow ? 3 : 5);
  if (!recent.length) {
    body.push(dimText(' no run has been rolled up yet · bullswarm workflow reindex backfills them', width));
  }
  // The duration cell carries the run's basis (`span` when the record proved
  // no active interval) beside its money, so the desktop cell is five columns
  // wider than the bare duration it replaced, not five columns of truncated money.
  const durationWidth = narrow ? 16 : 21;
  for (const record of recent) {
    const ok = record.verified === true ? tint(glyphs().ok, 'green') : record.status === 'completed' ? dimText(glyphs().pending, 2) : tint(glyphs().fail, 'red');
    // The same money rule the cards use: a partly-priced run shows the
    // recorded subtotal marked `≈` rather than a dash that reads as free.
    const money = recordMoneyPair(record).text;
    body.row(compactRow([
      { text: ` ${ok}`, width: 2 },
      { text: strong(record.shortId ?? record.runId), width: 7 },
      {
        text: cut(`${record.project ?? blank()} · ${String(record.goal ?? '').split('\n')[0]}`, Math.max(6, width - 34 - (durationWidth - 16))),
        grow: true,
        min: 6,
        gap: 2,
      },
      { text: `${recentDurationText(record)} · ${money ?? blank()}`, width: durationWidth, align: 'right', gap: 2 },
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
  cardGridLines,
  cardColumnsFor,
  licenceRowText,
  licenceLine,
  licenceBlock,
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
  summaryBand,
  activeRunLines,
  taskIdText,
  taskPoolModelText,
  taskElapsedText,
  stepBarText,
  assignmentOf,
  stepPool,
};
