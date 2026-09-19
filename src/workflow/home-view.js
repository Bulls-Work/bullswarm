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
  recordCostInfo,
  todayDateLabel,
  todayLicenceRows,
  todayMinutesNumberText,
  todayMinutesText,
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
import { formatMoney } from '../lib/usage-basis.js';

const BUDGET_WEEK_POOLS = 4;
const WEEKDAY_LETTERS = Object.freeze(['S', 'M', 'T', 'W', 'T', 'F', 'S']);

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
  const minutes = todayMinutesText(record?.minutes?.wall) ?? blank();
  const verdict = record?.verified === true ? 'verified' : 'unverified';
  const line = `${glyph} ${id.padEnd(6)}  ${project}  ${minutes.padStart(6)}  ${verdict}`;
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
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
  const labels = ['wf min', 'wf % (est.)', 'run min', 'API · sub'];
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
  return `${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`;
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
  return desktop
    ? [
      'wf % = pool window points drawn by workflows today',
      '— = not measured · API≈ basis: provider-reported · transcript-summed · estimated',
      'cost unknown means no usage measurement exists',
      'live window used% is on Budget, not in this table',
    ].map((line) => todayPadded(line, width))
    : [
      'wf % = pool window points drawn by workflows today',
      '— = not measured · API≈: provider-reported · transcript-summed · estimated',
      `cost unknown · audit ${date}`,
      'live window used% lives on Budget, not here',
    ].map((line) => todayPadded(line, width));
}

/** The approved Home today band: finished work on the left, licence draw right. */
function homeTodayBand(model, opts, body) {
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
  const spendTokenSource = (spend?.buckets ?? []).reduce((source, bucket) => (
    bucket?.value == null
      ? source
      : worstTokenSource(source, tokenSourceOf(bucket?.tokenSource, bucket?.value))
  ), null) ?? tokenSourceOf(spend?.tokenSource, spend?.total);
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
  const buckets = spend?.total == null ? [] : (spend?.buckets ?? []);
  const chartBuckets = buckets.filter((bucket) => (
    bucket?.value != null
    && tokenSourceOf(bucket?.tokenSource, bucket?.value) !== 'unknown'
  ));
  const chart = chartBuckets.length
    ? columnBars(
      [{ name: 'spent', values: chartBuckets.map((bucket) => bucket.value), color: METER_COLORS.cyan }],
      chartBuckets.map((bucket) => WEEKDAY_LETTERS[bucket.weekday] ?? String(bucket.label ?? '').slice(-2)),
      {
        width: cellWidth,
        rowCount: chartRowCount(opts.height ?? 36),
        col: Math.max(2, Math.floor((cellWidth - 7) / Math.max(1, chartBuckets.length))),
        barW: 3, unit: '$', mark: spendTokenSource === 'provider-reported' ? ''
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

function summaryBand(body, model, opts) {
  const { width, narrow } = opts;
  const overview = model.stats?.overview ?? null;
  const keys = overview?.keys ?? null;
  if (!keys) return;
  const projects = model.stats?.projects ?? null;
  const verified = (overview.breakdown?.projects ?? []).reduce((sum, row) => sum + (row.verified ?? 0), 0);
  const runs = keys.workflows ?? 0;
  const spent = projects?.totals?.apiEquivalentUsd ?? null;
  const money = moneyText({ ...keys, apiUsd: spent });
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
      `Median run: ${tint(minutesText(keys.medianRunMinutes) ?? blank(), 'orange')}`,
    ],
  ];
  body.push('');
  if (narrow) {
    for (const figure of figures.flat()) body.push(cut(` ${figure}`, width));
  } else {
    pushColumns(body, figures.map((rows) => ({ rows })), { width: width - 1, gap: 2 });
  }
  body.push('');
  const sentence = money && !money.includes('api unknown')
    ? `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded ${money} of API-equivalent work`
    : `Your ${runs} run${runs === 1 ? '' : 's'} in this period recorded no API-equivalent estimate`;
  body.push(cut(` ${tint(sentence, 'purple')}`, width));
}

function homePage(model, opts, body) {
  homeTodayBand(model, opts, body);
  activeRunLines(model, opts, body);
  return homeDetails(model, opts, body);
}

function activeRunLines(model, opts, body, title = 'running') {
  const { width, narrow, nowMs } = opts;
  const tasks = Array.isArray(model.tasks?.inflight) ? model.tasks.inflight : [];
  body.push('');
  body.push(rule(title, null, width));
  if (!model.runs.length && !tasks.length) {
    body.push(dimText(' nothing in flight · bullswarm workflow goal "<goal>" launches one', width));
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
  for (const record of recent) {
    const ok = record.verified === true ? tint(glyphs().ok, 'green') : record.status === 'completed' ? dimText(glyphs().pending, 2) : tint(glyphs().fail, 'red');
    const cost = recordCostInfo(record);
    const money = moneyText(cost);
    body.row(compactRow([
      { text: ` ${ok}`, width: 2 },
      { text: strong(record.shortId ?? record.runId), width: 7 },
      {
        text: cut(`${record.project ?? blank()} · ${String(record.goal ?? '').split('\n')[0]}`, Math.max(6, width - 34)),
        grow: true,
        min: 6,
        gap: 2,
      },
      { text: `${minutesText(record.minutes?.wall) ?? blank()} · ${money ?? blank()}`, width: 16, align: 'right', gap: 2 },
      { text: dimText(`${ageText(record.finishedAt, nowMs)} ago`, 12), width: 11, align: 'right', gap: 2 },
    ], { width }), { kind: 'run', runId: record.runId });
  }
  if (narrow) body.push(dimText(' ≈ API-equivalent estimates · click tiles for charts', width));
  return ' bullswarm · home';
}

export {
  homePage,
  homeTodayBand,
  homeDetails,
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
