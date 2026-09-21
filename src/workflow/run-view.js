// Run page rendering and timeline views.
//
// Run-specific views consume the shell's shared ANSI/layout contract and the
// Run model projections. The shell imports these functions and re-exports the
// compatibility helpers that existing Step and CLI callers use.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { finiteOrNull } from '../lib/num.js';
import { formatMoney } from '../lib/usage-basis.js';
import { asciiGlyphsPreferred, glyphs, spinnerGlyph } from '../lib/glyphs.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { v2RunnerLiveness } from './short-id.js';
import { presentationStageStatus } from './v2-presentation.js';
import { absentLine, cut, progressBar, rule, seriesColor } from './dash-kit.js';
import {
  about,
  actionRoleLabel,
  agentDetailLines,
  blank,
  clamp,
  clockText,
  compactUsage,
  dimLine,
  dimText,
  durationText,
  formatBytes,
  inverseText,
  joinPanels,
  moneyText,
  outputSparkline,
  panelCell,
  panelWindow,
  pushColumns,
  reasoningText,
  renderPanel,
  runEconomics,
  runningMark,
  strong,
  SIDEBAR_WIDTH,
  selectLine,
  stateFinishedAt,
  stateStatus,
  statusIcon,
  TERMINAL_ACTIONS,
  tokenText,
  timelineText,
  tint,
  truncate,
  visibleLength,
  workflowPanelModel,
  workflowStatusIcon,
  wrapLines,
} from './dashboard.js';
import {
  planStageBoxParts,
  activeMinutesText,
  durationClockText,
  attemptDurationText,
  attemptRoutingText,
  phaseDurationFacts,
  runDurationFacts,
  planProgress,
  planStages,
  planStageName,
  stepTally,
  runClockText,
  runHeaderFacts,
  runSpendFacts,
  runTimelineFacts,
} from './run-model.js';
import { stepPageModel, turnCountsText } from './step-model.js';

/** Lines of the goal the Preflight segment shows before an ellipsis. */
const GOAL_PREVIEW_LINES = 5;
const ANSI_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RUN_DONE = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'skipped']);

function dimCell(value) {
  const text = String(value ?? '');
  return text ? dimText(text, Math.max(1, visibleLength(text))) : text;
}

function paintRule(line) {
  return String(line ?? '').replace(/─+/g, (dashes) => dimCell(dashes));
}

function dimCounts(value) {
  const text = String(value ?? '');
  const matcher = /\b[1-9]\d* (?:errors?|err)\b/g;
  let cursor = 0;
  let out = '';
  for (const match of text.matchAll(matcher)) {
    out += dimCell(text.slice(cursor, match.index));
    out += tint(match[0], 'red');
    cursor = match.index + match[0].length;
  }
  return cursor ? `${out}${dimCell(text.slice(cursor))}` : dimCell(text);
}

function paintMoney(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const prefix = text.match(/^(at least |[≈~](?: )?|—)/)?.[1] ?? '';
  const rest = text.slice(prefix.length);
  const prefixPaint = prefix ? dimCell(prefix.trimEnd()) + (prefix.endsWith(' ') ? ' ' : '') : '';
  return `${prefixPaint}${rest && rest !== '—' ? strong(rest) : rest ? dimCell(rest) : ''}`;
}

function paintPool(value) {
  const text = String(value ?? '');
  return text && text !== '—' ? tint(text, seriesColor(text)) : text;
}

function paintStatusGlyph(glyph, status) {
  const value = String(status ?? '').toLowerCase();
  if (['succeeded', 'completed', 'success', 'complete', 'done'].includes(value)) return tint(glyph, 'green');
  if (['running', 'active', 'started', 'start'].includes(value)) return tint(glyph, 'amber');
  if (['failed', 'blocked', 'cancelled', 'interrupted', 'skipped', 'partial'].includes(value)) return tint(glyph, 'red');
  return dimCell(glyph);
}

function paintStatusWord(value) {
  const text = String(value ?? '');
  const lower = text.toLowerCase();
  if (/(?:succeed|complete|verified|done)/.test(lower)) return tint(text, 'green');
  if (/(?:running|active|following|live)/.test(lower)) return tint(text, 'amber');
  if (/(?:fail|error|interrupted|cancelled|blocked|partial)/.test(lower)) return tint(text, 'red');
  return dimCell(text);
}

function paintRunHeader(line, headerFacts, activeGlyph) {
  let out = String(line ?? '');
  const glyph = String(activeGlyph ?? '');
  if (glyph) out = out.replace(glyph, paintStatusGlyph(glyph, headerFacts.status));
  if (headerFacts.shortId) out = out.replace(headerFacts.shortId, strong(headerFacts.shortId));
  out = out.replace(` · ${headerFacts.status} · `, ` · ${paintStatusWord(headerFacts.status)} · `);
  for (const id of [...headerFacts.running, ...headerFacts.waiting]) {
    if (id) out = out.replace(`(${id}`, `(${strong(id)}`).replace(`, ${id}`, `, ${strong(id)}`);
  }
  // Colour rules: the `<n> running` count reads as running, `<n> waiting` as pending.
  out = out.replace(/(\d+) running\b/, (_, n) => `${n} ${tint('running', 'amber')}`);
  out = out.replace(/(\d+) waiting\b/, (_, n) => `${n} ${dimCell('waiting')}`);
  return out;
}

function paintAttemptMix(header) {
  const parts = header.attemptMix.map((entry) => `${paintPool(entry.pool)} ${entry.count}`);
  return parts.join(` ${dimCell('·')} `);
}

function paintPhaseRule(line, phase) {
  const source = String(line ?? '');
  const spans = [];
  const add = (value, style, from = 0) => {
    const text = String(value ?? '');
    if (!text) return;
    let at = source.indexOf(text, from);
    while (at >= 0 && spans.some((span) => at < span.end && at + text.length > span.at)) {
      at = source.indexOf(text, at + 1);
    }
    if (at >= 0) spans.push({ at, end: at + text.length, style });
  };
  for (const match of source.matchAll(/─+/g)) spans.push({ at: match.index, end: match.index + match[0].length, style: dimCell });
  add(phase?.glyph, (value) => paintStatusGlyph(value, phase.status), source.indexOf('──') + 2);
  add(phase?.name, (value) => strong(value), source.indexOf(phase?.glyph ?? '') + 1);
  // The phase facts are built as four adjacent fields.  Locate each from the
  // preceding field instead of replacing the first repeated placeholder: a
  // waiting phase has `— → — · —`, and all three clocks/durations are meta.
  const start = phase?.startedAt ? clockText(phase.startedAt) : '—';
  const end = phase?.status === 'active' ? 'now' : phase?.finishedAt ? clockText(phase.finishedAt) : '—';
  const duration = runClockText(phase?.activeMinutes ?? phase?.spanMinutes);
  let factsFrom = 0;
  const addFact = (value) => {
    const text = String(value ?? '');
    if (!text) return;
    const at = source.indexOf(text, factsFrom);
    if (at < 0) return;
    spans.push({ at, end: at + text.length, style: dimCell });
    factsFrom = at + text.length;
  };
  addFact(start);
  addFact(end);
  addFact(duration);
  addFact(`${phase?.done ?? 0}/${phase?.total ?? 0}`);
  spans.sort((a, b) => a.at - b.at || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.at < cursor) continue;
    out += source.slice(cursor, span.at);
    out += span.style(source.slice(span.at, span.end));
    cursor = span.end;
  }
  return out + source.slice(cursor);
}

function paintTimelineAttempt(line, attempt, { phone = false, duration = null } = {}) {
  const text = String(line ?? '');
  const glyph = attempt?.glyph;
  let out = text;
  if (glyph) out = out.replace(glyph, paintStatusGlyph(glyph, attempt.status));
  if (attempt?.actionId) out = out.replace(attempt.actionId, strong(attempt.actionId));
  if (attempt?.pool) out = out.replace(attempt.pool, paintPool(attempt.pool));
  if (attempt?.startedAt) {
    const clock = clockText(attempt.startedAt);
    if (clock) out = out.replace(clock, dimCell(clock));
  }
  if (attempt?.status === 'running') out = out.replace(' · running', ` · ${tint('running', 'amber')}`);
  // The duration column is the clock the row prints at its right edge, which
  // alignRight put last; painting a field the row never shows left it plain.
  const clock = String(duration ?? '');
  if (clock && out.endsWith(clock)) out = `${out.slice(0, -clock.length)}${dimCell(clock)}`;
  return out;
}

function paintPlanPart(part) {
  const text = String(part?.text ?? '');
  // The selected box is the cursor: inverse as the tab row, its glyph left
  // uncoloured so the cell reads the same on every terminal.
  if (text.includes('\x1b[7m')) return { ...part, text: inverseText(text.replace(ANSI_SGR, '')) };
  if (!text || text.includes('\x1b[')) return part;
  const glyph = text.match(/[✓✗▶●○+x>o]/)?.[0] ?? null;
  if (!glyph) return part;
  const status = glyph === '✓' || glyph === '+' ? 'succeeded'
    : glyph === '✗' || glyph === 'x' ? 'failed'
      : glyph === '▶' || glyph === '>' ? 'running' : 'pending';
  return { ...part, text: text.replace(glyph, paintStatusGlyph(glyph, status)) };
}

function runFrame(row, {
  width = 120, height = 36, focus = 0, phaseIndex = null, agentIndex = null,
  detailScroll = 0, message = null, confirmCancel = false,
  controlSelected = false, orchestratorDetail = false, orchestratorVerbose = false,
  workflowVerbose = false, mobileTimeline = true, timelineSelection = null,
  spinnerFrame = 0, bodyHeight: pageBodyHeight = null, nowMs = Date.now(),
} = {}) {
  width = Math.max(20, Number(width) || 120);
  height = Math.max(18, Number(height) || 36);
  const narrow = width < 100;
  const model = workflowPanelModel(row, { phaseIndex, agentIndex, nowMs });
  const state = model.state;
  const status = row?.status ?? stateStatus(state) ?? 'starting';
  const duration = runDurationFacts(row, { nowMs });
  const elapsed = activeMinutesText(duration.activeMinutes);
  const phaseComplete = model.selectedPhase.completed;
  const phaseTotal = model.selectedPhase.total;
  const attempts = state.attempts ?? [];
  const workerAttempts = attempts.filter((attempt) => attempt.actionId !== model.orchestrator.actionId);
  const finishedAgents = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const agentProgress = workerAttempts.length ? `${finishedAgents}/${workerAttempts.length} workers · ` : '';
  const terminalLabel = stateFinishedAt(state)
    ? ` · ${status === 'completed' ? 'done' : status}${isProgramWorkflow(state) && status === 'completed' ? hasPassingRequirementEvidence(state) ? ' · evidence passed' : ' · unverified' : ''}`
    : '';
  const runName = state.workflow ?? row?.shortId ?? state.shortId ?? row?.runId ?? 'workflow';
  // The page's sticky header names the run the way the nav's own button does;
  // the body below is the hierarchy, sized to the page's window.
  const bodyHeight = Math.max(6, Number(pageBodyHeight) || height - 8);

  const phaseLines = [];
  model.phases.forEach((phase, index) => {
    const icon = statusIcon(phase.status, spinnerFrame);
    const count = phase.total ? ` ${phase.completed}/${phase.total}` : '';
    phaseLines.push(selectLine(
      `${index + 1} ${icon} ${phase.label}${count}`,
      index === model.phaseIndex && !controlSelected,
      focus === 0 && !controlSelected,
      width,
    ));
  });

  const agentLines = [];
  if (!model.agents.length) {
    const blockedActions = model.selectedPhase.blockedActions ?? [];
    if (blockedActions.length) {
      for (const blocked of blockedActions) {
        agentLines.push(dimLine(
          `${glyphs().blocked} ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : 'a failed dependency'}`,
          width,
        ));
      }
    } else agentLines.push(dimLine('Not started yet', width));
  }
  model.agents.forEach((agent, index) => {
    const icon = statusIcon(agent.status, spinnerFrame);
    const attempt = agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1;
    const selected = index === model.agentIndex;
    const tokens = tokenText(agent.attempt?.usage);
    const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
    const age = attemptDurationText(agent.attempt ?? agent.active, { nowMs });
    agentLines.push(selectLine(
      `${icon} ${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${attempt}${tokens ? ` · ${tokens}` : ''}${age !== 'time pending' ? ` · ${age}` : ''}`,
      selected, focus === 1, width,
    ));
  });

  // Wide terminals keep the hierarchy and preview visible together. Narrow
  // terminals show one full-width pane at a time so mobile/SSH text remains
  // readable and explicit back navigation preserves the same hierarchy.
  const leftWidth = Math.min(SIDEBAR_WIDTH, Math.max(1, width - 3));
  const rightWidth = Math.max(1, width - leftWidth);
  // The detail text is wrapped once, before the layout below picks a body, so
  // it must wrap to the pane it will actually occupy: the full width on a
  // narrow terminal (one pane at a time), the right column beside the sidebar
  // otherwise. Wrapping to the right column on a 60-column phone left every
  // line at 22 characters inside a 58-character panel.
  const paneWidth = Math.max(20, (narrow ? width : rightWidth) - 4);
  const orchestrationLines = orchestratorDetailLines(model, paneWidth, spinnerFrame, { verbose: orchestratorVerbose });
  const detail = orchestratorDetail ? orchestrationLines : agentDetailLines(model, paneWidth, spinnerFrame);
  const technical = workflowTechnicalLines(model, paneWidth);
  const contentHeight = bodyHeight - 2;
  const scrollSource = workflowVerbose ? technical : detail;
  const maxScroll = Math.max(0, scrollSource.length - contentHeight);
  const scroll = clamp(detailScroll, 0, maxScroll);
  const visiblePhases = panelWindow(['', ...phaseLines], model.phaseIndex, 1, contentHeight).slice(1);
  const visibleAgents = panelWindow(['', ...agentLines], model.agentIndex, 1, contentHeight).slice(1);
  const visibleDetail = detail.slice(scroll, scroll + contentHeight);
  const phaseTitle = `Phases · ${model.phases.length}`;
  const orchestrationNavLines = model.orchestrator.autonomous
    ? [
      selectLine(
        `${model.orchestrator.active ? statusIcon('running', spinnerFrame)
          : stateFinishedAt(state) ? workflowStatusIcon({ status: stateStatus(state) }, spinnerFrame)
            : statusIcon(model.orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)}`,
        controlSelected,
        focus === 0 && !orchestratorDetail,
        leftWidth - 2,
      ),
      dimLine(
        [model.orchestrator.pool, model.orchestrator.model].filter(Boolean).join(' · ') || 'select to inspect',
        leftWidth - 2,
      ),
      dimLine(plannerUsageSummary(model), leftWidth - 2),
    ]
    : [];
  const narrowWorkflowLines = model.orchestrator.autonomous
    ? [...orchestrationNavLines, '', ...visiblePhases]
    : visiblePhases;
  const agentTitle = `${model.selectedPhase.label} · ${phaseComplete}/${phaseTotal} complete`;
  const detailTitle = model.selectedAgent
    ? `${model.selectedAgent.action.id} · ${model.selectedAgent.pool}`
    : 'Agent activity';

  let body;
  if (narrow) {
    if (orchestratorDetail) {
      body = renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, width, bodyHeight);
    } else if (workflowVerbose) {
      body = renderPanel('Workflow technical details', technical.slice(scroll, scroll + contentHeight), width, bodyHeight);
    } else if (focus === 0 && mobileTimeline) {
      const selectedTimelineSegment = timelineSelection === 0
        ? 'Preflight'
        : timelineSelection > 0 ? model.phases[timelineSelection - 1]?.label : null;
      body = renderWorkflowOverviewPanel(
        model, width, bodyHeight, spinnerFrame, detailScroll,
        selectedTimelineSegment, nowMs,
      );
    } else if (focus === 0) {
      body = renderPanel(phaseTitle, visiblePhases, width, bodyHeight);
    } else if (focus === 1) {
      body = renderPanel(agentTitle, visibleAgents, width, bodyHeight);
    } else {
      body = renderPanel(detailTitle, visibleDetail, width, bodyHeight);
    }
  } else if (orchestratorDetail) {
    body = joinPanels(
      renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, bodyHeight),
      renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, rightWidth, bodyHeight),
    );
  } else if (workflowVerbose) {
    const visibleTechnical = technical.slice(scroll, scroll + contentHeight);
    const left = model.orchestrator.autonomous
      ? [
        ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
        ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
      ]
      : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(left, renderPanel('Workflow technical details', visibleTechnical, rightWidth, bodyHeight));
  } else if (focus < 2) {
    const left = focus === 1
      ? renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight)
      : model.orchestrator.autonomous
        ? [
          ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
          ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
        ]
        : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(
         left,
        controlSelected
        ? renderPanel(`Workflow Planner · ${model.orchestrator.status}`, orchestrationLines.slice(0, contentHeight), rightWidth, bodyHeight)
        : focus === 0
          ? renderWorkflowOverviewPanel(model, rightWidth, bodyHeight, spinnerFrame, detailScroll, null, nowMs)
          : renderPanel(detailTitle, compactAgentPreviewLines(model, Math.max(20, rightWidth - 4), spinnerFrame), rightWidth, bodyHeight),
       );
  } else {
    body = joinPanels(
      renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight),
      renderPanel(detailTitle, visibleDetail, rightWidth, bodyHeight),
    );
  }

  return {
    body, model, state, status, elapsed, terminalLabel, agentProgress, runName, narrow,
  };
}

function renderWorkflowOverviewPanel(model, width, height, spinnerFrame, timelineScroll = 0, selectedTimelineSegment = null, nowMs = Date.now()) {
  const inner = Math.max(1, width - 2);
  const timeline = workflowTimelineLines(model, inner, spinnerFrame, { nowMs, foldHint: false });
  const live = workflowLiveLines(model, inner, spinnerFrame, nowMs);
  const next = workflowNextLines(model, inner);
  const contentRows = Math.max(3, height - 4); // outer border + two section dividers
  const nextRows = Math.min(next.length, 2);
  const liveRows = Math.min(live.lines.length, Math.max(2, Math.floor(contentRows * 0.42)));
  const timelineRows = Math.max(1, contentRows - liveRows - nextRows);
  const maxTimelineScroll = Math.max(0, timeline.lines.length - timelineRows);
  const selectedHeader = selectedTimelineSegment
    ? timeline.lines.findIndex((line) => line?.header && line.segment === selectedTimelineSegment)
    : -1;
  const scroll = clamp(timelineScroll, 0, maxTimelineScroll);
  const end = selectedHeader >= 0
    ? Math.min(timeline.lines.length, selectedHeader + timelineRows)
    : Math.max(0, timeline.lines.length - scroll);
  let start = selectedHeader >= 0
    ? selectedHeader
    : Math.max(0, end - timelineRows);
  if (start > 0 && selectedHeader < 0) {
    // Reserve one row for the continuation header while keeping the newest
    // timestamped milestone in view.
    start = Math.max(0, end - Math.max(0, timelineRows - 1));
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]).trimStart())) start += 1;
  }
   let visibleTimeline = timeline.lines.slice(start, end);
   if (start > 0 && selectedHeader < 0) {
     visibleTimeline.unshift(dimText(`↑ ${start} earlier timeline rows`, inner));
     const continuation = visibleTimeline.find((line) => line?.segment)?.segment
       ?? currentTimelineSegment(model);
     if (continuation) {
       const priorHeader = timeline.lines.find((line) => line?.header && line.segment === continuation);
       // A v2 phase rule carries the phase itself, so the continuation repeats
       // that phase's own name and glyph. The legacy elapsed cell does not
       // exist there, and defaulting it to `running` claimed a finished run
       // was still going.
       const priorPhase = priorHeader?.phase;
       const header = priorPhase
         ? {
           text: truncate(rule(`${priorPhase.glyph} ${priorPhase.index + 1} · ${priorPhase.name} · continued`, null, inner), inner),
           header: true,
           at: visibleTimeline.find((line) => line?.segment === continuation)?.at ?? null,
         }
         : continuationHeader(
           timelineSegmentDisplayName(continuation, model),
           priorHeader?.elapsed ?? 'running',
           inner,
           visibleTimeline.find((line) => line?.segment === continuation)?.at,
         );
       header.segment = continuation;
       visibleTimeline.splice(1, 0, header);
     }
    // Scrolled views already carry the upward marker and continuation header;
    // omit inter-segment spacer rows so the viewport retains the latest event.
    visibleTimeline = visibleTimeline.filter((line) => timelineText(line) !== '');
  }
  if (end < timeline.lines.length && visibleTimeline.length) {
    const marker = dimText(`↓ ${timeline.lines.length - end} newer timeline rows`, inner);
    if (visibleTimeline.length >= timelineRows) visibleTimeline[visibleTimeline.length - 1] = marker;
    else visibleTimeline.push(marker);
  }
   if (start > 0 && selectedHeader < 0 && visibleTimeline.length > timelineRows) {
     // The continuation marker and header are structural context, not
     // expendable event rows. Keep both and trim the oldest visible events.
     visibleTimeline = [visibleTimeline[0], visibleTimeline[1],
       ...visibleTimeline.slice(-(timelineRows - 2))];
   } else {
     visibleTimeline = visibleTimeline.slice(0, timelineRows);
   }
  if (selectedTimelineSegment) {
    visibleTimeline = visibleTimeline.map((line) => line?.header && line.segment === selectedTimelineSegment
      ? { ...line, text: `\x1b[7m${timelineText(line)}\x1b[0m` }
      : line);
  }
  // The Run page indents its own timeline rows one column inside the body.
  // This panel already draws a border, and the Claude mod's pane classifies a
  // row as a milestone only when the clock is flush against the border
  // (`^HH:MM `), so the page's margin comes off before the cell is drawn.
  const unindent = (line) => {
    const text = timelineText(line);
    if (!text.startsWith(' ')) return line;
    const trimmed = text.slice(1);
    return typeof line === 'string' ? trimmed : { ...line, text: trimmed };
  };
  visibleTimeline = visibleTimeline.map(unindent);
  const visibleLive = live.lines.slice(0, liveRows);
  const visibleNext = next.slice(0, nextRows);
  const title = ` Workflow timeline · ${timeline.milestoneCount} milestone${timeline.milestoneCount === 1 ? '' : 's'} `;
  const rows = [`┌${truncate(title, inner)}${'─'.repeat(Math.max(0, inner - truncate(title, inner).length))}┐`];
  for (const line of visibleTimeline) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 1 + timelineRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider(`Live · ${live.running} running`, inner));
  for (const line of visibleLive) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 2 + timelineRows + liveRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider('Next', inner));
  for (const line of visibleNext) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < height - 1) rows.push(`│${panelCell('', inner)}│`);
  rows.push(`└${'─'.repeat(inner)}┘`);
  return rows.slice(0, height);
}

function sectionDivider(label, inner) {
  const text = truncate(` ${label} `, inner);
  return `├${text}${'─'.repeat(Math.max(0, inner - text.length))}┤`;
}

function groupedTimeline(events, model, width, workflowFinishedAt) {
  const chronological = (a, b) => Date.parse(a.at) - Date.parse(b.at)
    || Number(a.sequence ?? Number.MAX_SAFE_INTEGER) - Number(b.sequence ?? Number.MAX_SAFE_INTEGER);
  events.sort(chronological);
  // Phase blocks are a navigable program, so present adjacent phase activity in
  // the declared order even when parallel workers finish out of order. Planner
  // checkpoints remain chronological boundaries between separate programs.
  const phaseRank = new Map(model.phases.map((phase, index) => [phase.label, index]));
  const orderedEvents = [];
  for (let index = 0; index < events.length;) {
    if (!phaseRank.has(events[index].segment)) {
      orderedEvents.push(events[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < events.length && phaseRank.has(events[end].segment)) end += 1;
    orderedEvents.push(...events.slice(index, end).sort((a, b) =>
      phaseRank.get(a.segment) - phaseRank.get(b.segment) || chronological(a, b)));
    index = end;
  }
  const segments = new Map();
  for (const event of orderedEvents) {
    const name = event.segment ?? 'Workflow';
    const firstAt = event.startedAt ?? event.at;
    if (!segments.has(name)) segments.set(name, {
      name, events: [], first: firstAt, last: event.at,
      activeMinutes: event.activeMinutes ?? event.phaseActiveMinutes ?? null,
    });
    const segment = segments.get(name);
    segment.events.push(event);
    if (segment.activeMinutes == null && (event.activeMinutes ?? event.phaseActiveMinutes) != null) {
      segment.activeMinutes = event.activeMinutes ?? event.phaseActiveMinutes;
    }
    if (Date.parse(firstAt) < Date.parse(segment.first)) segment.first = firstAt;
    if (Date.parse(event.at) > Date.parse(segment.last)) segment.last = event.at;
  }
  const lines = [];
  let previousSegment = null;
  const openedSegments = new Set();
  for (const event of orderedEvents) {
    if (event.segment !== previousSegment) {
      if (lines.length) lines.push('');
      const segment = segments.get(event.segment ?? 'Workflow');
      const segmentFinishedAt = segment.last;
      const currentSegment = currentTimelineSegment(model);
      const running = !workflowFinishedAt && (segment.name === currentSegment
        || (model.dependencyGroups && model.phases.some((phase) => phase.label === segment.name && phase.status === 'active')));
      const elapsed = running
        ? (segment.activeMinutes == null ? 'running' : durationClockText(segment.activeMinutes))
        : segment.activeMinutes == null ? durationText(segment.first, segmentFinishedAt) : durationClockText(segment.activeMinutes);
      const displayName = timelineSegmentDisplayName(segment.name, model);
      const header = openedSegments.has(segment.name)
        ? continuationHeader(displayName, elapsed, width)
        : segmentHeader(displayName, elapsed, width);
      header.segment = segment.name;
      lines.push(header);
      openedSegments.add(segment.name);
      previousSegment = event.segment;
    }
    lines.push(...event.lines.map((line) => ({ text: line, segment: event.segment, at: event.at })));
  }
  if (!lines.length) lines.push({ text: 'Waiting for the first durable workflow milestone', segment: null });
  return { lines, milestoneCount: orderedEvents.filter((event) => !event.live).length };
}

function timelineSegmentDisplayName(name, model) {
  const raw = String(name ?? '');
  const text = raw.replace(/^Follow-up \d+: /, '') || raw;
  // Program stages already carry their level (`Phase 7 · tidy-fixes`). A
  // presentation category does not, so the header numbers it the way 0.35.0 did.
  if (model.dependencyGroups) return text;
  const phaseIndex = model.phases.findIndex((phase) => phase.label === name);
  if (phaseIndex < 0) return text;
  const short = text.replace(/^Phase \d+\s*·\s*/, '') || text;
  return `Phase ${phaseIndex + 1} · ${short}`;
}

function legacyWorkflowTimelineLines(model, width, spinnerFrame = 0, { goalPreview = true, nowMs = Date.now() } = {}) {
  const { state } = model;
  const rows = [];
  const add = (at, label, right = '', detail = null, segment = 'Workflow', startedAt = null, extra = {}) => {
    if (!at) return;
    const details = detail == null ? [] : Array.isArray(detail) ? detail : [detail];
    rows.push({
      at, startedAt, segment, ...extra,
      lines: [timelineRow(at, label, right, width), ...details.filter((line) => line != null && line !== '').map((line) => timelineDetail(line, width))],
    });
  };
  // Preflight opens with the goal itself, wrapped over a few lines, and the
  // file it was accepted from, so the reader never depends on a truncated
  // one-line header to know what the run is for.
  const runDir = model.row?.runDir ?? null;
  const goalText = String(state.intent?.goal ?? state.workflow ?? '').trim();
  const goalWidth = Math.max(20, width - 7);
  // A goal is often several lines (a sentence, then numbered deliverables);
  // wrap each of its own lines, or a line break would sit inside one row
  // and split the frame.
  const goalSource = goalText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const goalLines = wrapLines(goalSource, goalWidth).slice(0, GOAL_PREVIEW_LINES);
  if (goalLines.length === GOAL_PREVIEW_LINES && wrapLines(goalSource, goalWidth).length > GOAL_PREVIEW_LINES) {
    goalLines[GOAL_PREVIEW_LINES - 1] = truncate(`${goalLines[GOAL_PREVIEW_LINES - 1]} …`, goalWidth);
  }
  // The Run page prints the goal above the timeline, where the reader sees it
  // without scrolling; there it passes `goalPreview: false` so the same five
  // wrapped rows are not replayed inside the first milestone. The mod pane's
  // `--overview` frame keeps them.
  add(state.lifecycle.startedAt, `${glyphs().ongoing} Goal accepted`, '', [
    ...(goalPreview ? goalLines : []),
    runDir ? `goal file · ${join(runDir, 'goal.json')}` : null,
    model.dependencyGroups ? 'phases may overlap as actions become ready' : 'preparing repository reconnaissance',
  ], 'Preflight');
  const eventByType = new Map();
  for (const event of model.events) {
    if (!eventByType.has(event.type)) eventByType.set(event.type, []);
    eventByType.get(event.type).push(event);
  }
  for (const event of eventByType.get('preflight.scout_started') ?? []) add(event.committedAt, `${glyphs().ongoing} Scout started`, '', event.payload?.purpose, 'Preflight');
  for (const event of eventByType.get('preflight.scout_finished') ?? []) {
    const attempt = state.preflight.scout.attempts.at(-1);
    const detail = [attempt?.pool, attempt?.model, tokenText(attempt?.usage)].filter(Boolean).join(' · ');
    add(event.committedAt, `${event.payload?.status === 'succeeded' ? glyphs().ok : '×'} Scout ${event.payload?.status === 'succeeded' ? 'completed' : 'could not complete'}`, durationText(state.preflight.scout.startedAt, state.preflight.scout.finishedAt), detail, 'Preflight');
  }
  for (const event of eventByType.get('planner.finished') ?? []) {
    const turn = Number(event.payload?.turn ?? 1);
    // The first plan is implied by the levels that follow it, so its own
    // milestone only repeated them; later revisions and rejections stay,
    // since they change what the levels mean.
    if (event.payload?.ok && turn === 1) continue;
    const label = event.payload?.ok
      ? turn === 1 ? '[Workflow Planner] plan created' : `[Workflow Planner] plan updated #${turn}`
      : '[Workflow Planner] planning attempt rejected';
    const attempt = state.planner.attempts.findLast((item) => item.turn === turn);
    const programFile = runDir
      ? join(runDir, turn === 1 ? 'initial-planner-response.json' : `planner-response-turn-${turn}.json`)
      : null;
    const actionCount = (state.program?.actions ?? []).length;
    const levelCount = model.dependencyGroups ? model.stages.length : 0;
    const shape = event.payload?.ok && actionCount
      ? `${actionCount} action${actionCount === 1 ? '' : 's'}${levelCount ? ` in ${levelCount} phase${levelCount === 1 ? '' : 's'}` : ''}`
      : null;
    add(
      event.committedAt,
      `${event.payload?.ok ? glyphs().plan : '×'} ${label}`,
      attempt ? durationText(attempt.startedAt, attempt.finishedAt) : '',
      [
        shape && programFile && existsSync(programFile) ? `${shape} · plan file · ${programFile}` : shape,
        event.payload?.summary ?? event.payload?.why,
      ],
      turn === 1 ? 'Preflight' : 'Planner',
      attempt?.startedAt,
    );
  }
  const stageById = new Map(model.stages.map((stage) => [stage.id, stage]));
  const stageAttempts = new Map(model.stages.map((stage) => [stage.id,
    (state.attempts ?? model.row?.attempts ?? []).filter((attempt) => (stage.actionIds ?? []).includes(attempt.actionId))]));
  if (model.dependencyGroups) {
    for (const stage of model.stages) {
      const duration = phaseDurationFacts(model.row, stage, { nowMs });
      // The tree's opening row, as 0.35.0 drew it: every phase that started
      // announces itself, whether or not its workers left durable attempts.
      add(stage.startedAt, '├─ started', '', null, stage.label, null, { activeMinutes: duration.activeMinutes });
    }
  }
  for (const event of model.events) {
    if (!model.dependencyGroups && event.type === 'presentation.stage_started') {
      const stage = stageById.get(event.payload?.stageId);
      const duration = stage ? phaseDurationFacts(model.row, stage, { nowMs }) : null;
      add(event.committedAt, '├─ started', '', null, event.payload.label, null, { activeMinutes: duration?.activeMinutes ?? null });
    }
    if (event.type === 'action.finished' || event.type === 'evidence.recorded') {
      const actionId = event.payload?.actionId;
      const runtime = state.actions.find((action) => action.id === actionId);
      const stage = model.stages.find((item) => item.actionIds.includes(actionId));
      const status = runtime?.status === 'succeeded' ? glyphs().ok : runtime?.status === 'blocked' ? glyphs().blocked : '×';
      // The attempt row below carries the same step, its own clock and the
      // routing it ran on; drawing the action-only duplicate would repeat it.
      if ((stage && (stageAttempts.get(stage.id) ?? []).some((attempt) => attempt.actionId === actionId))) continue;
      const duration = stage ? phaseDurationFacts(model.row, stage, { nowMs }) : null;
      add(event.committedAt, `│  ├─${status} ${actionId}`, runtime?.startedAt ? durationText(runtime.startedAt, runtime.finishedAt) : '', null, stage?.label ?? 'Work', null, { activeMinutes: duration?.activeMinutes ?? null });
    }
    if (!model.dependencyGroups && event.type === 'presentation.stage_completed') {
      const stage = stageById.get(event.payload?.stageId);
      const ok = event.payload?.status === 'completed';
      const duration = stage ? phaseDurationFacts(model.row, stage, { nowMs }) : null;
      add(event.committedAt, `└─${ok ? glyphs().ok : '×'} completed`, `${event.payload.completed}/${event.payload.total}`, null, stage?.label ?? event.payload.label, null, { activeMinutes: duration?.activeMinutes ?? null });
    }
  }
  // One row per durable attempt, in the tree's own shape: the step's own clock
  // on the right and the pool · model · effort it ran on in the row. A retry is
  // intentionally visible as another row even when it belongs to the same
  // phase/action, and the phase header above them counts the phase's active
  // minutes, never the idle time between its attempts.
  for (const stage of model.stages) {
    const attempts = stageAttempts.get(stage.id) ?? [];
    if (!attempts.length) continue;
    const duration = phaseDurationFacts(model.row, stage, { nowMs });
    for (const attempt of attempts) {
      const clock = attemptDurationText(attempt, { nowMs });
      add(
        attempt.finishedAt ?? attempt.startedAt,
        `│  ├─${statusIcon(attempt.status, spinnerFrame)} ${attempt.actionId} · ${attemptRoutingText(attempt)}`,
        clock === 'time pending' ? '' : clock,
        null,
        stage.label,
        attempt.startedAt,
        { activeMinutes: duration.activeMinutes },
      );
    }
  }
  // A worker that is still running has no durable finish event yet, so the
  // timeline would otherwise show only its level's "started" row while the
  // Live pane reports the same worker with a ticking elapsed time. Present it
  // under its level with the spinner and the same live duration. It is not a
  // milestone, so it does not count toward the pane title.
  if (!state.lifecycle.finishedAt) {
    for (const runtime of state.actions) {
      if (runtime.status !== 'running' || !runtime.startedAt) continue;
      const stage = model.stages.find((item) => item.actionIds.includes(runtime.id));
      if (stage && (stageAttempts.get(stage.id) ?? []).some((attempt) => attempt.actionId === runtime.id)) continue;
      add(runtime.startedAt, `│  ├─${statusIcon('running', spinnerFrame)} ${runtime.id}`, durationText(runtime.startedAt), null, stage?.label ?? 'Work', null, { live: true });
    }
  }
  if (model.dependencyGroups) for (const stage of model.stages) {
    if (!stage.completedAt) continue;
    const progress = presentationStageStatus(stage, state.actions);
    // finishedAt precedes the durable action-finished event by a few ms.
    // A projected level closes after those events, never above its last worker.
    const at = [stage.completedAt, ...model.events.filter((event) =>
      ['action.finished', 'evidence.recorded'].includes(event.type) && stage.actionIds.includes(event.payload?.actionId))
      .map((event) => event.committedAt)].filter(Boolean).sort().at(-1);
    // The phase closes with its tally, as 0.35.0 drew it; a phase that ran
    // attempts does not lose its closing row to them.
    const duration = phaseDurationFacts(model.row, stage, { nowMs });
    add(at, `└─${progress.successful ? glyphs().ok : '×'} completed`, `${progress.completed}/${progress.total}`, null, stage.label, null, { activeMinutes: duration.activeMinutes });
  }
  if (state.lifecycle.finishedAt) {
    const status = state.lifecycle.status;
    const finalSegment = model.stages.findLast((stage) => stage.startedAt)?.label ?? 'Workflow';
    const runDuration = runDurationFacts(model.row, { nowMs });
    add(state.lifecycle.finishedAt, `${status === 'completed' ? glyphs().ok : status === 'partial' ? '!' : '×'} Workflow ${status === 'completed' ? 'complete - result is ready' : `${status} - result is ready`}`, activeMinutesText(runDuration.activeMinutes), null, finalSegment, null, { activeMinutes: runDuration.activeMinutes });
  }
  return groupedTimeline(rows, model, width, state.lifecycle.finishedAt);
}

/** Run v2's tree: phase facts plus one row per durable attempt. */
/**
 * Which phases the Run timeline folds into one line: everything between the
 * opening two and the closing three (the last completed phase, the phase
 * running now, and the one that waits on it). The running phase is an anchor,
 * never part of the fold: a reader who cannot see the step that is running has
 * lost the page's whole point. `{ start, end }` are phase indexes, `end`
 * exclusive; null when fewer than two phases would fold.
 */
function foldRangeOf(phases) {
  const activeIndex = phases.findIndex((phase) => phase.status === 'active');
  const tailStart = Math.max(0, (activeIndex >= 0 ? activeIndex : phases.length - 2) - 1);
  const candidateStart = 2;
  return tailStart - candidateStart >= 2 ? { start: candidateStart, end: tailStart } : null;
}

function runTimelineFold(row, { nowMs = Date.now() } = {}) {
  return foldRangeOf(runTimelineFacts(row, { nowMs }).phases);
}

/**
 * `foldOpen` shows the folded phases in place and closes them with a
 * `click to fold` line; `foldHint: false` drops the `click to expand` hint
 * for a reader (the mod pane) that has no pointer to click with.
 */
function workflowTimelineLines(model, width, spinnerFrame = 0, {
  goalPreview = true, nowMs = Date.now(), phone = Number(width) < 100, foldOpen = false, foldHint = true,
} = {}) {
  const facts = runTimelineFacts(model.row, { nowMs });
  const lines = [];
  const safeWidth = Math.max(20, Number(width) || 120);
  const push = (text, metadata = {}) => lines.push({ text: cut(String(text ?? ''), safeWidth), ...metadata });
  const preflight = facts.preflight;
  if (preflight.at) {
    push(paintRule(phone ? '── Preflight' : rule('Preflight', null, safeWidth)), { header: true, segment: 'Preflight', phaseIndex: -1 });
    push(` ${dimCell(clockText(preflight.at))}  ${dimCell(glyphs().ongoing)} ${preflight.label}`, { segment: 'Preflight', at: preflight.at, milestone: true });
    // The Run page prints the goal in its own header, so it asks for
    // `goalPreview: false`. The mod pane's `--overview` frame has no header of
    // its own and has always read the goal out of this first milestone; it
    // keeps them.
    if (goalPreview) {
      const goalText = String(model.state?.intent?.goal ?? model.state?.workflow ?? '').trim();
      const goalSource = goalText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const goalWidth = Math.max(20, safeWidth - 7);
      const wrapped = wrapLines(goalSource, goalWidth);
      const shown = wrapped.slice(0, GOAL_PREVIEW_LINES);
      if (shown.length === GOAL_PREVIEW_LINES && wrapped.length > GOAL_PREVIEW_LINES) {
        shown[GOAL_PREVIEW_LINES - 1] = truncate(`${shown[GOAL_PREVIEW_LINES - 1]} …`, goalWidth);
      }
      for (const line of shown) {
        const detail = timelineDetail(line, safeWidth);
        push(`${detail.startsWith('       ') ? '       ' : ''}${dimCell(detail.replace(/^       /, ''))}`, { segment: 'Preflight', at: preflight.at });
      }
    }
  }
  const phases = facts.phases;
  const fold = foldRangeOf(phases);
  const foldStart = fold ? fold.start : -1;
  const foldEnd = fold ? fold.end : -1;
  const folded = fold ? phases.slice(foldStart, foldEnd) : [];
  const renderPhase = (phase) => {
    const start = phase.startedAt ? clockText(phase.startedAt) : '—';
    const end = phase.status === 'active' ? 'now' : phase.finishedAt ? clockText(phase.finishedAt) : '—';
    const duration = runClockText(phase.activeMinutes ?? phase.spanMinutes);
    const right = `${start} → ${end} · ${duration} · ${phase.done}/${phase.total}`;
    const name = `${phase.glyph} ${phase.index + 1} · ${phase.name}`;
    const phaseLine = phone
      ? `── ${phase.glyph} ${phase.index + 1} · ${phase.name}`
      : phaseRule(name, right, safeWidth);
    push(phone ? paintPhaseRule(phaseLine, phase) : paintPhaseRule(phaseLine, phase), {
      header: true, segment: phase.label, phaseIndex: phase.index, phase,
    });
    if (phone) push(` ${dimCell(right)}`, { segment: phase.label, phaseIndex: phase.index, span: true });
    const attempts = phase.attempts.slice().sort((a, b) => (Date.parse(a.startedAt ?? '') || 0) - (Date.parse(b.startedAt ?? '') || 0));
    for (const attempt of attempts) {
      const at = attempt.startedAt ?? attempt.finishedAt;
      const clock = at ? clockText(at) : '--:--';
      const glyph = attempt.status === 'running' ? glyphs().started
        : ['succeeded', 'completed', 'success'].includes(attempt.status) ? glyphs().ok : glyphs().fail;
      const pool = attempt.pool ?? '—';
      const modelName = attempt.model ?? '—';
      const effort = attempt.effort ?? attempt.routing?.effort ?? '—';
      const runningText = attempt.status === 'running' ? ' · running' : '';
      const left = phone
        ? ` ${clock}  ${glyph} ${attempt.actionId} · ${pool}${runningText}`
        : ` ${clock}  ${glyph} ${attempt.actionId} · ${pool} · ${modelName} · ${effort}${runningText}`;
      const duration = attemptDurationText(attempt, { nowMs });
      push(paintTimelineAttempt(alignRight(left, duration, safeWidth), {
        ...attempt, glyph,
      }, { phone, duration }), {
        segment: phase.label, phaseIndex: phase.index, at, attempt, actionId: attempt.actionId, milestone: true,
      });
    }
  };
  phases.forEach((phase, index) => {
    if (foldStart >= 0 && index === foldStart && !foldOpen) {
      const stepCount = folded.reduce((sum, item) => sum + item.total, 0);
      const active = folded.reduce((sum, item) => sum + (finiteOrNull(item.activeMinutes) ?? 0), 0);
      const failed = folded.reduce((sum, item) => sum + item.attempts.filter((attempt) => !['succeeded', 'completed', 'success'].includes(attempt.status)).length, 0);
      const range = `phases ${folded[0].index + 1}–${folded.at(-1).index + 1}`;
      const tally = failed ? `${failed} ✗` : 'all ✓';
      const hint = foldHint ? ' · click to expand' : '';
      // The hint is what the line is for, so a narrow page gives up the step
      // count and then the clock before it lets the cut land inside the hint.
      const label = [
        `${range} · ${stepCount} steps · ${runClockText(active)} · ${tally}${hint}`,
        `${range} · ${runClockText(active)} · ${tally}${hint}`,
        `${range} · ${tally}${hint}`,
      ].find((candidate) => visibleLength(candidate) <= safeWidth) ?? `${range} · ${tally}${hint}`;
      push(dimCell(label), { folded: true, fold: foldHint ? 'expand' : null, segment: folded[0].label, phaseIndex: folded[0].index });
      return;
    }
    if (foldStart >= 0 && index > foldStart && index < foldEnd && !foldOpen) return;
    renderPhase(phase);
    if (foldStart >= 0 && foldOpen && foldHint && index === foldEnd - 1) {
      push(dimCell('click to fold'), { fold: 'collapse', segment: phase.label, phaseIndex: phase.index });
    }
  });
  if (!lines.length) push('no timeline recorded');
  return {
    lines,
    milestoneCount: lines.filter((line) => line.milestone || line.header).length,
    phases: phases.length,
    attempts: facts.attempts.length,
  };
}

/**
 * `── <glyph> <n> · <name> ──── <start> → <end> · <duration> · <done>/<total>`:
 * the v2 phase rule spends its dashes between the name and the facts and ends
 * on the tally, so the count is the last thing the row says. Rule 6 of the
 * run-v2 record draws it that way; `rule()` keeps its closing dashes for the
 * rules that have a right-hand label to fence off. A phase whose steps are
 * named at length gives way before its facts do: the count, the clock and the
 * duration are what the rule is read for.
 */
function phaseRule(name, right, width) {
  const cols = Math.max(1, Number(width) || 1);
  const label = String(name ?? '');
  const tail = right == null || `${right}` === '' ? '' : ` ${right}`;
  const room = cols - 3 - 1 - 2 - visibleLength(tail);
  if (visibleLength(`── ${label} `) + visibleLength(tail) < cols) {
    const head = `── ${label} `;
    return `${head}${'─'.repeat(cols - visibleLength(head) - visibleLength(tail))}${tail}`;
  }
  if (room < 1) return cut(`── ${label}${tail}`, cols);
  const head = `── ${cut(label, room)} `;
  return `${head}${'─'.repeat(Math.max(2, cols - visibleLength(head) - visibleLength(tail)))}${tail}`;
}

function segmentHeader(name, elapsed, width) {
  if (width < 40) {
    const suffix = ` ── ${elapsed} ──`;
    const available = width - suffix.length - 3;
    const text = available >= String(name).length
      ? `── ${name}${suffix}`
      : `── ${truncate(name, Math.max(1, available))}${suffix}`;
    return { text: truncate(text, width), segment: name, elapsed, header: true };
  }
  const text = `── ${name} `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${name} ──`, width), segment: name, elapsed, header: true };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment: name, elapsed, header: true };
}

function continuationHeader(segment, elapsed, width, at = null) {
  if (width < 40) {
    // Keep the segment name readable in the compact pane; the continuation
    // marker already distinguishes this header from the initial one.
    const text = `── ${segment} · continued ──`;
    return { text: truncate(text, width), segment, elapsed, header: true, at };
  }
  const text = `── ${segment} · continued `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${segment} · continued ──`, width), segment, elapsed, header: true, at };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment, elapsed, header: true, at };
}

function currentTimelineSegment(model) {
  const { state } = model;
  const activeAction = state.actions.find((action) => action.status === 'running');
  return model.stages.find((stage) => stage.actionIds.includes(activeAction?.id))?.label
    ?? (state.preflight?.scout?.status === 'running' ? 'Preflight'
      : state.planner.status === 'running'
        ? (state.actions.length ? 'Planner' : 'Preflight')
        : 'Workflow');
}

function workflowLiveLines(model, width, spinnerFrame, nowMs = Date.now()) {
  const { state, orchestrator } = model;
  const runningAttempts = state.attempts.filter((attempt) => attempt.status === 'running');
  const lines = [];
  const plannerRunning = orchestrator.active;
  // The planner appears here only while it is actually planning. Between
  // programs it is merely waiting on the workers listed below, which the
  // Next section already says; a "waiting" row of its own told nothing.
  if (plannerRunning) {
    lines.push(alignRight(`${statusIcon('planning', spinnerFrame)} [Workflow Planner] · ${orchestrator.pool} · ${orchestrator.model}`, 'planning', width));
    lines.push('   Choosing the next bounded program');
    const event = plannerRunning.lastAgentEvent;
    if (event) lines.push(`   ${glyphs().detail} ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
    const stream = streamActivityLine(plannerRunning);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  for (const attempt of runningAttempts) {
    const reasoning = reasoningText(attempt);
    lines.push(alignRight(`${statusIcon('running', spinnerFrame)} ${attempt.actionId} · ${attempt.pool ?? 'unassigned'} · ${attempt.model ?? 'connector model'}${reasoning ? ` · ${reasoning}` : ''}`, attemptDurationText(attempt, { nowMs }), width));
    const event = attempt.lastAgentEvent;
    lines.push(event
      ? `   ${glyphs().detail} ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`
      : `   ${glyphs().detail} waiting for the first semantic action event`);
    const stream = streamActivityLine(attempt);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  if (!lines.length) {
    const liveness = model.row?.liveness ?? v2RunnerLiveness(state, { runDir: model.row?.runDir });
    lines.push(stateFinishedAt(state)
      ? `${glyphs().ok} No live agents · workflow ${state.lifecycle.status}`
      : liveness.alive ? `${glyphs().waiting} Waiting for the next dispatch`
      : `${glyphs().fail} Kernel not running · ${liveness.reason}`);
    if (!stateFinishedAt(state) && !liveness.alive) {
      lines.push(`  resume it · bullswarm workflow resume ${state.shortId ?? state.runId}`);
    }
  }
  if (model.row?.kernelStderrTail?.length) lines.push('  kernel log: available');
  return { lines, running: runningAttempts.length + (plannerRunning ? 1 : 0) };
}

function workflowNextLines(model, width) {
  const { state } = model;
  if (stateFinishedAt(state)) return [truncate(`${glyphs().ok} Workflow ${state.lifecycle.status === 'completed' ? 'complete' : state.lifecycle.status} - result is ready`, width)];
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  if (running.length) return [truncate(`${glyphs().pending} Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`, width)];
  if (state.planner.status === 'running') return [`${glyphs().pending} Workflow Planner is creating the next bounded program`];
  if (state.planner.awaiting) {
    const token = state.shortId ?? state.runId;
    if (state.cancellation?.requested) return [truncate(`${glyphs().waiting} Cancellation requested while paused · bullswarm workflow cancel ${token} finalizes it`, width)];
    return [truncate(`${glyphs().waiting} Waiting for the caller planner (${state.planner.awaiting.boundary}) · bullswarm workflow plan show ${token}`, width)];
  }
  if (state.actions.some((action) => ['pending', 'ready'].includes(action.status))) return [`${glyphs().pending} Starting the next dependency-ready actions`];
  return [`${glyphs().pending} Workflow Planner will reassess remaining gaps`];
}

function workflowTechnicalLines(model, width) {
  const { state } = model;
  return wrapLines([
    `Schema · ${state.schemaVersion}`,
    `Status · ${state.lifecycle.status}`,
    `Started · ${state.lifecycle.startedAt ?? '—'}`,
    `Usage · ${state.usage.total} known tokens`,
    '', 'Action program',
    ...state.actions.map((action) => `${statusIcon(action.status)} ${action.id} · revision ${action.programRevision} · ${action.status}`),
    '', 'Requirement ledger',
    ...Object.values(state.ledger.requirements).map((requirement) => `${statusIcon(requirement.status)} ${requirement.id} · ${requirement.status}`),
    '', 'Recent durable events',
    ...model.events.slice(-12).map((event) => `#${event.sequence} ${event.type}`),
  ], width);
}

function timelineRow(at, label, right, width) {
  if (width < 40) return label;
  return alignRight(`${clockText(at)}  ${label}`, right, width);
}

function timelineDetail(text, width) {
  return truncate(`       ${text}`, width);
}

// Both sides arrive painted, so every measurement and cut here counts display
// cells and keeps escapes whole: `truncate` would score an SGR run as text and
// could slice a colour in half.
function alignRight(left, right, width) {
  const suffix = right ? String(right) : '';
  const suffixCells = visibleLength(suffix);
  // Preserve the actionable event label in the compact preview; dropping a
  // duration is preferable to turning the action name into an ellipsis.
  if (width < 30) return cut(left, width);
  if (!suffix) return cut(left, width);
  const room = Math.max(1, width - suffixCells - 1);
  const lhs = cut(left, room);
  return `${lhs}${' '.repeat(Math.max(1, width - visibleLength(lhs) - suffixCells))}${suffix}`;
}

function streamActivityLine(agent) {
  if (!agent) return '';
  const at = agent.lastEventAt ?? agent.lastActivityAt;
  if (!at) return 'stream waiting for the first provider event';
  return `stream active ${durationText(at)} ago · ${formatBytes(agent.outputBytesObserved ?? 0)} observed`;
}

function humanStatus(value) {
  return String(value ?? 'waiting').replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());
}

function plannerDisplayStatus(model) {
  const { orchestrator, state } = model;
  if (stateFinishedAt(state)) return state.lifecycle.status === 'completed' ? 'Completed' : humanStatus(state.lifecycle.status);
  if (orchestrator.active) return 'Creating or updating plan';
  if (state.attempts.some((attempt) => attempt.status === 'running')) return 'Waiting for workers';
  return humanStatus(state.planner.status);
}

function plannerUsageSummary(model) {
  return `Checkpoints ${model.orchestrator.attempts.length} · ${model.state.usage.total || 0} tok`;
}

function orchestratorDetailLines(model, width, spinnerFrame, { verbose = false } = {}) {
  const { orchestrator, state } = model;
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  const now = orchestrator.active
    ? 'Creating or updating the bounded action program'
    : running.length ? `Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`
      : stateFinishedAt(state) ? 'Workflow finished' : 'Reviewing requirement gaps';
  const lines = [
    `${statusIcon(orchestrator.active ? 'planning' : orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)} · ${orchestrator.pool} · ${orchestrator.model}`,
    '', `Now · ${now}`,
    `Progress · ${state.actions.filter((action) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(action.status)).length}/${state.actions.length} actions settled · ${orchestrator.attempts.length} planning checkpoint${orchestrator.attempts.length === 1 ? '' : 's'}`,
    `Latest plan · ${state.planner.lastDecision?.summary ?? 'not created yet'}`,
  ];
  const event = orchestrator.active?.lastAgentEvent;
  if (event) lines.push(`Latest action · ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
  if (!verbose) {
    lines.push('', 'Recent activity');
    for (const attempt of orchestrator.attempts.slice(-3)) lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push('', 'Press v for checkpoint prompts, sessions, usage, and artifact paths.');
    return wrapLines(lines, width);
  }
  lines.push('', `Session · ${state.planner.session?.sessionId ?? 'pending'}${state.planner.session ? ' · resumable' : ''}`);
  for (const attempt of orchestrator.attempts) {
    const reasoning = reasoningText(attempt);
    lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${attempt.pool ?? '—'} · ${attempt.model ?? '—'}${reasoning ? ` · ${reasoning}` : ''} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push(`  task: ${attempt.taskFile ?? '—'}`, `  output: ${attempt.outputFile ?? '—'}`);
  }
  return wrapLines(lines, width);
}

function friendlyActionKind(kind) {
  return ({
    read_file: 'Read file',
    write_file: 'Write file',
    response: 'Response',
    tool: 'Tool',
    bash: 'Command',
  })[kind] ?? String(kind ?? 'Action').replaceAll('_', ' ');
}

function friendlyActionSummary(action) {
  const summary = String(action.summary ?? '').replace(/\s+/g, ' ').trim();
  if (action.kind === 'response' && /workflow\.decision|"decision"|needs_more_work/.test(summary)) {
    return 'Planner decision recorded';
  }
  return truncate(summary, 180);
}

function compactAgentPreviewLines(model, width, spinnerFrame) {
  const agent = model.selectedAgent;
  if (!agent) return [
    `${model.selectedPhase.label} · ${model.selectedPhase.completed}/${model.selectedPhase.total} complete`,
    ...(model.selectedPhase.blockedActions ?? []).map((blocked) =>
      `${glyphs().blocked} ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.join(', ')}`),
    ...agentDetailLines(model, width, spinnerFrame),
  ];
  const liveActions = agent.active?.lastActions ?? agent.attempt?.lastActions ?? [];
  // Token usage only arrives when an attempt finishes, so a running worker
  // used to read "#1 · pending" here; its elapsed time is what is known now.
  const startedAt = agent.attempt?.startedAt ?? agent.active?.startedAt;
  const elapsed = startedAt ? durationText(startedAt, agent.attempt?.finishedAt) : '';
  const tokens = tokenText(agent.attempt?.usage);
  const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
  const lines = [
    `${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}${elapsed ? ` · ${elapsed}` : ''}${tokens ? ` · ${tokens}` : ''}`,
    `${statusIcon(agent.status, spinnerFrame)} ${agent.status} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''}`,
    `${agent.pool} · attempt ${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}`,
    `Tokens · ${tokenText(agent.attempt?.usage) || 'pending'}`,
    compactUsage(agent.attempt?.usage),
    '',
    'Recent steps',
  ];
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  for (const step of liveActions.slice(-4)) {
    lines.push(`${statusIcon(step.status, spinnerFrame)} ${friendlyActionKind(step.kind)}${step.summary ? ` · ${friendlyActionSummary(step)}` : ''}`);
  }
  return wrapLines(lines, width);
}

function actionNamedIn(text, actions) {
  let best = null;
  for (const action of actions) {
    const at = text.indexOf(action.id);
    if (at < 0) continue;
    const before = at === 0 ? ' ' : text[at - 1];
    const after = text[at + action.id.length] ?? ' ';
    if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(after)) continue;
    if (!best || action.id.length > best.id.length) best = action;
  }
  return best;
}

/** One clickable row per step the painted lines name. */
function markStepRows(builder, lines, model, runId = null) {
  const actions = model.state.actions ?? [];
  if (!actions.length) return;
  const from = builder.lines.length - lines.length;
  const alreadyMarked = new Set(builder.regions
    .filter((region) => region.action?.kind === 'step')
    .map((region) => region.y));
  lines.forEach((line, index) => {
    // An attempt row records its own region as it is painted; marking it a
    // second time here would put two hit regions on one row.
    if (alreadyMarked.has(from + index + 1)) return;
    const action = actionNamedIn(String(line).replace(ANSI_SGR, ''), actions);
    if (action) {
      builder.regions.push({
        x1: 1, x2: Math.max(1, visibleLength(line)), y: from + index + 1,
        action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
      });
    }
  });
}

function planDagLines(row, {
  width, runId = null, assignments = [], nowMs = Date.now(), pools = true, selectedId = null, maxRows = null,
} = {}) {
  const { stages } = planStages(row);
  if (!stages.length) return [];
  // The plan is intentionally phase-only. A box is one clickable unit whose
  // action points at that phase's first step; the full attempt chronology is
  // rendered by the timeline below it. Consecutive boxes on one row are chained
  // with an arrow, so a wrapped row ends on its last box and the last box of
  // the plan never trails one.
  const boxes = stages.map((stage, index) => {
    const parts = planStageBoxParts(stage, index, { runId, selectedId });
    return { parts, text: parts.map((part) => part.text).join(''), width: visibleLength(parts.map((part) => part.text).join('')) };
  });
  const limit = Math.max(1, Number(width) || 1);
  // Phones stack one box per row so a phase name never gets squeezed into a
  // misleading ellipsis. Wider terminals flow as many whole boxes as fit.
  const maxBoxes = limit < 80 ? 1 : boxes.length;
  const arrow = ' → ';
  const arrowWidth = visibleLength(arrow);
  const out = [];
  let line = [];
  let used = 0;
  const flush = () => {
    if (!line.length) return;
    out.push({ parts: line.flatMap((box, index) => [
      ...(index ? [{ text: arrow }] : []),
      ...box.parts,
    ]) });
    line = [];
    used = 0;
  };
  for (const box of boxes) {
    const gap = line.length ? arrowWidth : 0;
    if (line.length >= maxBoxes || (line.length && used + gap + box.width > limit)) flush();
    line.push(box);
    used += (line.length > 1 ? arrowWidth : 0) + box.width;
  }
  flush();
  return out;
}

/**
 * The timeline, flat: the same rows the mod pane reads, windowed to the space
 * the page has for them and with no box drawn around them.
 *
 * `renderWorkflowOverviewPanel` still draws the boxed frame for
 * `bullswarm workflow tui <id> --overview`, untouched; this is the page's own
 * reading of the same lines.
 */
function flatTimelineLines(panel, { width, rows, scroll = 0, selectedSegment = null, spinnerFrame = 0, nowMs = Date.now() } = {}) {
  const timeline = workflowTimelineLines(panel, width, spinnerFrame, { goalPreview: false, nowMs, foldHint: false });
  const room = Math.max(1, Number(rows) || 1);
  const selectedHeader = selectedSegment
    ? timeline.lines.findIndex((line) => line?.header && line.segment === selectedSegment)
    : -1;
  const maxScroll = Math.max(0, timeline.lines.length - room);
  const at = clamp(scroll, 0, maxScroll);
  // The newest rows fill the window, which is what a reader watching a run
  // wants; a selected segment only re-anchors it when that segment has
  // already scrolled out of view, so choosing a phase never empties the page.
  let end = Math.max(0, timeline.lines.length - at);
  let start = Math.max(0, end - room);
  const anchored = selectedHeader >= 0 && (selectedHeader < start || selectedHeader >= end);
  if (anchored) {
    start = selectedHeader;
    end = Math.min(timeline.lines.length, selectedHeader + room);
  }
  if (start > 0 && !anchored) {
    start = Math.max(0, end - Math.max(0, room - 1));
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]))) start += 1;
  }
  let visible = timeline.lines.slice(start, end);
  if (start > 0 && !anchored) {
    visible.unshift(dimText(`↑ ${start} earlier timeline rows`, width));
    const continuation = visible.find((line) => line?.segment)?.segment ?? currentTimelineSegment(panel);
    if (continuation) {
      const prior = timeline.lines.find((line) => line?.header && line.segment === continuation);
      const header = continuationHeader(
        timelineSegmentDisplayName(continuation, panel),
        prior?.elapsed ?? 'running',
        width,
        visible.find((line) => line?.segment === continuation)?.at,
      );
      header.segment = continuation;
      visible.splice(1, 0, header);
    }
    visible = visible.filter((line) => timelineText(line) !== '');
  }
  if (end < timeline.lines.length && visible.length && !anchored) {
    const marker = dimText(`↓ ${timeline.lines.length - end} newer timeline rows`, width);
    if (visible.length >= room) visible[visible.length - 1] = marker;
    else visible.push(marker);
  }
  visible = visible.length > room
    ? [visible[0], visible[1], ...visible.slice(-(room - 2))]
    : visible;
  const out = visible.slice(0, room).map((line) => {
    const text = timelineText(line);
    if (line?.header) {
      return line.segment === selectedSegment ? `\x1b[7m${text}\x1b[0m` : dimText(text, width);
    }
    return text;
  });
  // The milestone count the panel used to carry in its title; the mod pane and
  // the tests both read it, and a live row is still not a milestone.
  Object.defineProperty(out, 'milestones', { enumerable: false, value: timeline.milestoneCount });
  return out;
}

/** The `budget` cell of the Run page's triptych: one row per pool it drew on. */
function runBudgetRows(economics, { width }) {
  if (!economics.pools.length) return [absentLine('', 'no attempt has recorded a pool yet', { width })];
  if (economics.pools.every((pool) => pool.sharePct == null)) {
    return [absentLine('', 'free model · no licence meter', { width })];
  }
  return economics.pools.flatMap((pool) => {
    if (pool.sharePct == null) return [absentLine(pool.name, 'free model · no licence meter', { width })];
    const percent = pool.sharePct > 0 && pool.sharePct < 1 ? pool.sharePct.toFixed(1) : String(Math.round(pool.sharePct));
    const window = pool.window === 'monthly' ? 'monthly' : pool.window === 'five_hour' ? 'five-hour' : 'weekly';
    const share = `${about()} ${percent}% of the ${window} plan`;
    const name = String(pool.name);
    const bars = Math.min(20, width - visibleLength(name) - visibleLength(share) - 2);
    if (bars < 4) return [cut(name, width), cut(`${tint(progressBar(pool.sharePct / 100, 4, { partialGlyph: '▏' }), 'purple')} ${share}`, width)];
    return [`${name} ${tint(progressBar(pool.sharePct / 100, bars, { partialGlyph: '▏' }), 'purple')} ${share}`];
  });
}

/** The `live` cell: what is running now and the last thing each one did. */
function runLiveRows(panel, { width, nowMs, limit = 3 }) {
  const running = (panel.state.attempts ?? []).filter((attempt) => attempt.status === 'running');
  // A run whose kernel is gone says so, and says the two things a reader can
  // do about it — the same words `renders` and `workflow runs show` use.
  const dead = [];
  if (!stateFinishedAt(panel.state)) {
    const liveness = panel.row?.liveness ?? v2RunnerLiveness(panel.state, { runDir: panel.row?.runDir });
    if (!liveness.alive) {
      dead.push(dimText(cut(`${glyphs().fail} kernel not running · ${liveness.reason}`, width), width + 8));
      dead.push(dimText(cut(`  resume it · bullswarm workflow resume ${panel.state.shortId ?? panel.state.runId}`, width), width + 8));
    }
  }
  if (panel.row?.kernelStderrTail?.length) dead.push(dimText('  kernel log: available', width + 8));
  if (!running.length) {
    return [dimText(stateFinishedAt(panel.state)
      ? `no live agents · workflow ${panel.state.lifecycle.status}`
      : panel.state.lifecycle?.status === 'paused'
        ? `paused · bullswarm workflow resume ${panel.state.shortId ?? panel.state.runId} continues it`
        : 'waiting for the next dispatch', width), ...dead];
  }
  const rows = [...dead];
  for (const attempt of running.slice(0, limit)) {
    const elapsed = attemptDurationText(attempt, { nowMs });
    const spark = outputSparkline(attempt, panel.row?.runDir, 8);
    const total = spark ? ` · output ${spark}` : '';
    const action = `${runningMark()} ${attempt.actionId}`;
    const pool = attempt.pool == null ? 'unassigned' : String(attempt.pool);
    const suffix = `· ${elapsed}${total}`;
    const full = `${action} · ${pool} ${suffix}`;
    // A pool is an identity, not prose. Keep it whole when the live cell has
    // room; otherwise omit it before the final line cut so a narrow Run page
    // cannot paint a misleading `openc…` name.
    const line = visibleLength(full) <= width
      ? full
      : `${action} ${suffix}`;
    rows.push(cut(dimText(line, width + 24), width));
    const event = attempt.lastAgentEvent;
    rows.push(dimText(cut(`  ${glyphs().detail} ${event
      ? `${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`
      : 'waiting for the first semantic action event'}`, width), width + 8));
  }
  return rows;
}

/** The `so far` cell: the steps, the time, the spend and what is not measured. */
function runSoFarRows(row, panel, progress, economics, { width, nowMs }) {
  const money = moneyText(economics);
  const elapsed = activeMinutesText(runDurationFacts(panel.row, { nowMs }).activeMinutes);
  const label = (name, value) => `${name.padEnd(9)}${value}`;
  return [
    label('steps', stepTally(row)),
    label('time', `${elapsed}${progress.eta ? ` · ETA ${progress.eta}` : ` · ETA ${blank()}`}`),
    label('spent', tint(money, 'purple')),
    dimText(cut(`${economics.measuredAttempts} of ${economics.attempts} attempts measured`, width), width + 8),
  ];
}

/** Why the triptych's blanks are blank, once, across the page's own width. */
function runBlankReasons(economics, progress) {
  return [
    economics.apiEquivalentUsd == null ? 'cost unknown: no usage measurement exists' : null,
    !progress.eta && progress.unmeasured?.length
      ? `ETA ${blank()}: ${progress.unmeasured.join(', ')} ${progress.unmeasured.length === 1 ? 'has' : 'have'} no recorded duration yet`
      : null,
  ].filter(Boolean);
}

function runRollupFor(model) {
  return (model?.rollups ?? []).find((record) => record?.runId === model?.row?.runId) ?? null;
}

function runLivePresentation(model, { nowMs = Date.now(), runFollow = true } = {}) {
  const state = model?.state ?? model?.row?.state ?? {};
  const attempts = (state.attempts ?? []).filter((attempt) => attempt?.actionId);
  const running = attempts.findLast((attempt) => attempt.status === 'running');
  const selected = running ?? attempts
    .filter((attempt) => attempt.finishedAt || attempt.status !== 'running')
    .sort((a, b) => (Date.parse(a.finishedAt ?? a.startedAt ?? '') || 0) - (Date.parse(b.finishedAt ?? b.startedAt ?? '') || 0))
    .at(-1) ?? null;
  if (!selected) return { attempt: null, action: null, step: null, turn: null, event: null, running: false, stream: false };
  let step = null;
  try {
    step = stepPageModel({ row: model.row, assignments: model.assignments ?? [], pools: model.pools ?? [] }, {
      actionId: selected.actionId,
      attemptOrdinal: selected.ordinal,
      nowMs,
      follow: runFollow,
      view: 'overview',
    });
  } catch { step = null; }
  const activity = step?.activity ?? null;
  const presentationActivity = step?.presentation?.activity ?? null;
  const turn = presentationActivity?.turns?.at(-1) ?? activity?.turns?.at(-1) ?? null;
  const event = activity?.events?.at(-1) ?? null;
  return {
    attempt: selected,
    action: step?.action ?? (state.actions ?? []).find((action) => action.id === selected.actionId) ?? null,
    step,
    turn,
    event,
    running: selected.status === 'running',
    stream: Boolean(presentationActivity?.available ?? activity?.available),
    events: Array.isArray(activity?.events) ? activity.events.length : (presentationActivity?.events ?? 0),
    turns: presentationActivity?.turns?.length ?? activity?.turns?.length ?? 0,
  };
}

function runTurnPreviewLines(live, width, { phone = width < 100 } = {}) {
  // The Step page's turn-row gutter: mark(1) + number(2) + 2 + HH:MM(5) + 2.
  const gutter = 12;
  const indent = ' '.repeat(gutter);
  const room = Math.max(8, width - gutter);
  const turn = live?.turn;
  if (!turn) {
    const summary = live?.event?.summary ? String(live.event.summary).replace(/\s+/g, ' ').trim() : null;
    return summary ? [` ↳ ${cut(summary, width - 4)}`] : [];
  }
  const text = String(turn.text ?? 'response summary unavailable').replace(/\s+/g, ' ').trim();
  const head = ` ${tint(glyphs().started, 'amber')}${String(turn.number ?? 1).padStart(2, ' ')}  ${dimCell(turn.clock ?? '--:--')}  `;
  const counts = turn.countsText ?? turnCountsText(turn.summary);
  const hasCounts = Boolean(counts) && counts !== 'no tools';
  // Desktop appends ` · <counts>` to the second line and truncates the TEXT to
  // make room, so the counts always survive; the phone gives them a third row.
  const tail = hasCounts && !phone ? ` ${dimCell('·')} ${dimCounts(counts)}` : '';
  const all = wrapLines([text], room);
  const wrapped = all.slice(0, 2);
  const overflow = all.length > 2;
  if (wrapped.length) {
    const last = wrapped.length - 1;
    const textRoom = room - visibleLength(tail);
    if (overflow || visibleLength(wrapped[last]) > textRoom) wrapped[last] = cut(`${wrapped[last]}${overflow ? '…' : ''}`, Math.max(1, textRoom));
    wrapped[last] = `${wrapped[last]}${tail}`;
  }
  const lines = wrapped.length
    ? wrapped.map((line, index) => (index === 0 ? `${head}${line}` : `${indent}${line}`))
    : [`${head}response summary unavailable${tail}`];
  if (hasCounts && phone) lines.push(`${indent}${dimCounts(counts)}`);
  return lines.map((line) => cut(line, width));
}

function runLiveLinesV2(live, width, { phone = width < 100, runFollow = true, nowMs = Date.now(), paused = null } = {}) {
  const attempt = live?.attempt;
  // A paused run has nothing running and will not start anything on its own,
  // so the block says how to continue it rather than leaving the reader to
  // read `last finished` as "any moment now" (requirement 8).
  const pausedLine = paused ? ` paused · bullswarm workflow resume ${paused} continues it` : null;
  if (!attempt) {
    return [rule('live', null, width), ...(pausedLine ? [cut(pausedLine, width)] : []), ' no event stream kept for this attempt'];
  }
  const duration = attemptDurationText(attempt, { nowMs });
  const pool = attempt.pool ?? '—';
  const modelName = attempt.model ?? '—';
  const effort = attempt.effort ?? attempt.routing?.effort ?? '—';
  const status = live.running ? tint('live', 'amber') : dimCell('last finished');
  const liveCounts = `${live.turns ?? 0} turns · ${live.events ?? 0} events`;
  const title = `${status} · ${strong(attempt.actionId)} · ${paintPool(pool)}${phone ? '' : ` · ${modelName} · ${effort}`} · ${dimCell(duration)}${phone ? '' : ` · ${dimCounts(liveCounts)}`}`;
  const lines = [paintRule(rule(title, null, width))];
  if (pausedLine) lines.push(cut(` ${dimCell(pausedLine.trimStart())}`, width));
  if (phone) lines.push(` ${modelName} · ${effort} · ${dimCounts(liveCounts)}`);
  if (!live.stream) {
    lines.push(` ${dimCell('no event stream kept for this attempt')}`);
  } else {
    lines.push(...runTurnPreviewLines(live, width, { phone }));
  }
  const followGlyph = runFollow ? tint(glyphs().ongoing, 'amber') : dimCell(glyphs().pending);
  lines.push(cut(` ${dimCell('Enter → the step page · following')} ${followGlyph}`, width));
  return lines;
}

// The spend block's two labels are one 10-cell column, and on the desktop the
// amount opens a second field at a fixed column so the per-pool split starts
// under the first pool on every continuation row it wraps onto.
const SPEND_LABEL_WIDTH = 10;
const SPEND_DETAIL_COLUMN = 30;
const SPEND_DETAIL_GAP = 3;

/** `╴<label>╴╴<amount>` — the label column the spend block is read down. */
function spendHead(label, amount, { gap = 1 } = {}) {
  const rawLabel = String(label);
  const text = ` ${dimCell(rawLabel)}${' '.repeat(Math.max(0, SPEND_LABEL_WIDTH - visibleLength(rawLabel)))}`;
  return `${text}${amount == null || amount === '' ? '' : `${' '.repeat(gap)}${paintMoney(amount)}`}`;
}

/**
 * One row whose second field opens at the detail column: the amount, then the
 * split or the coverage words it belongs to.
 */
function spendDetailRow(head, tail, width) {
  const opener = `${head}${' '.repeat(Math.max(0, Math.max(SPEND_DETAIL_COLUMN, visibleLength(head) + SPEND_DETAIL_GAP) - visibleLength(head)))}`;
  return cut(`${opener}${tail ? dimCell(tail) : ''}`, width);
}

/** A pool's name in the split: the vendor-qualified suffix, as `acme` is. */
function spendPoolName(name) {
  const full = String(name ?? '');
  return full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full;
}

/** `codex $11.45`, or `command-code ≈$0.01` when its subtotal is a sum of estimates. */
function spendPoolToken(entry) {
  const amount = formatMoney(entry.apiKnownSubtotalUsd);
  const money = entry.estimated > 0 ? `≈${amount}` : amount;
  return `${paintPool(spendPoolName(entry.pool))} ${paintMoney(money)}`;
}

/**
 * The counts that qualify a split, in the phone form's own words: how many of
 * the run's attempts were estimated and how many recorded nothing at all. A
 * running attempt is the live block's news, not the split's.
 */
function spendSplitCounts(spend) {
  return [
    spend.estimated ? `${spend.estimated} estimated` : null,
    spend.unmeasured ? `${spend.unmeasured} unmeasured` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The pool split flowed from the detail column: the amount row opens it, the
 * pools that do not fit continue under it at the same column, and the run's
 * own counts close the last row in parentheses.
 */
function spendSplitRows(head, tokens, counts, width) {
  const indent = ' '.repeat(SPEND_DETAIL_COLUMN);
  const opener = `${head}${' '.repeat(Math.max(0, Math.max(SPEND_DETAIL_COLUMN, visibleLength(head) + SPEND_DETAIL_GAP) - visibleLength(head)))}`;
  const units = tokens.map((text, index) => ({ text, gap: index ? ' · ' : '' }));
  if (counts) units.push({ text: dimCell(`(${counts})`), gap: ' ' });
  const rows = [];
  let text = opener;
  let fresh = true;
  for (const unit of units) {
    if (fresh) text = rows.length ? indent : opener;
    const gap = fresh ? '' : unit.gap;
    if (!fresh && visibleLength(text) + gap.length + visibleLength(unit.text) > width) {
      rows.push(text);
      text = indent;
      fresh = true;
    }
    text = fresh ? `${text}${unit.text}` : `${text}${gap}${unit.text}`;
    fresh = false;
  }
  rows.push(text);
  return rows;
}

/** `<n> attempts with a meter reading · <n> without`, shortened when the row
 *  cannot hold the whole phrase — the 55-column record reads `<n> with a
 *  meter reading` rather than a cut-off sentence. */
function planCoverageText(spend, room) {
  const short = `${spend.planMeter} with a meter reading`;
  const full = `${spend.planMeter} attempts with a meter reading · ${spend.planUnmetered} without`;
  if (visibleLength(full) <= room) return full;
  return visibleLength(short) <= room ? short : full;
}

function runSpendLinesV2(spend, width, { phone = width < 100 } = {}) {
  const lines = [paintRule(rule(`spend · ${spend.coverageText}`, null, width))];
  const suffix = spend.suffix ? `  ${dimCell(spend.suffix)}` : '';
  const pools = spend.pools.filter((entry) => entry.apiKnownSubtotalUsd != null);
  if (phone) {
    // The phone has one row per fact: the amount with its own coverage words,
    // then the plan row the width can hold whole.
    lines.push(cut(`${spendHead('API rate', spend.apiText, { gap: 0 })}${suffix}`, width));
    const head = spendHead('plans', spend.plansText, { gap: 0 });
    lines.push(cut(`${head}   ${dimCell(planCoverageText(spend, Math.max(0, width - visibleLength(head) - 3)))}`, width));
    return lines;
  }
  const head = spendHead('API rate', spend.apiText);
  if (!pools.length) {
    // Nothing was priced, so there is no split to flow: the row keeps the
    // amount in the block's own label column and the coverage words after it.
    lines.push(cut(`${head}${suffix}`, width));
  } else {
    for (const row of spendSplitRows(head, pools.map(spendPoolToken), spendSplitCounts(spend), width)) {
      lines.push(cut(row, width));
    }
  }
  const plansHead = spendHead('plans', spend.plansText);
  const column = Math.max(SPEND_DETAIL_COLUMN, visibleLength(plansHead) + SPEND_DETAIL_GAP);
  lines.push(spendDetailRow(plansHead, planCoverageText(spend, Math.max(0, width - column)), width));
  return lines;
}

function runPlanGlyphStrip(row) {
  const { stages } = planStages(row);
  return stages.map((stage) => {
    const actions = stage.actions ?? [];
    // The narrow strip is a phase summary, not a second step list. Running
    // wins over failure so a phase with one retry in flight still reads live;
    // otherwise a failed/blocked phase is red, a wholly successful phase is
    // done, and an untouched or mixed phase remains pending.
    if (actions.some((action) => action.status === 'running')) return tint(glyphs().started, 'amber');
    if (actions.some((action) => ['failed', 'blocked', 'cancelled', 'interrupted'].includes(action.status))) return tint(glyphs().fail, 'red');
    if (actions.length > 0 && actions.every((action) => action.status === 'succeeded')) return tint(glyphs().ok, 'green');
    return dimCell(glyphs().pending);
  }).join('');
}

function runAttemptMixText(header) {
  return header.attemptMix.map((entry) => `${entry.pool} ${entry.count}`).join(' · ');
}

/**
 * Run: the goal, the plan with its topology and its bars, the budget / live /
 * so far triptych, and the timeline — all flat, with no panel borders.
 *
 * The boxed frame `bullswarm workflow tui <id> --overview` prints is
 * `renderWorkflowOverviewPanel`, which this function no longer calls and did
 * not change; the Claude mod's `parseOverview` still reads exactly what it
 * read before. The `o` planner view and the `v` technical view keep their
 * panels: the prototype has no frame for either, and they are diagnostic
 * sub-views a reader opens deliberately.
 */
function legacyRunPage(model, opts, body) {
  const { width, bodyHeight, nowMs, narrow, spinnerFrame } = opts;
  const row = model.row;
  const panel = workflowPanelModel(row, { phaseIndex: opts.phaseIndex, agentIndex: opts.agentIndex, nowMs });
  const state = panel.state;
  const status = row?.status ?? stateStatus(state) ?? 'starting';
  const shortId = state.shortId ?? row?.shortId ?? row?.runId ?? '------';
  const done = (state.actions ?? []).filter((action) => action.status === 'succeeded').length;
  const total = (state.actions ?? []).length;
  const runDuration = runDurationFacts(row, { nowMs });
  const elapsed = activeMinutesText(runDuration.activeMinutes);
  const activeLabel = ` · active ${elapsed}`;
  const spanLabel = runDuration.spanMinutes == null ? '' : ` · secondary span ${activeMinutesText(runDuration.spanMinutes)}`;
  const terminalLabel = stateFinishedAt(state)
    ? ` · ${status === 'completed' ? 'done' : status}${isProgramWorkflow(state) && status === 'completed' ? hasPassingRequirementEvidence(state) ? ' · evidence passed' : ' · unverified' : ''}`
    : '';
  const header = truncate(` ${shortId} ${status}${activeLabel}${spanLabel} · ${done}/${total} actions${terminalLabel}`, width);

  // The planner and technical views keep the panels they always drew: the
  // prototype has no frame for either and both are opened deliberately.
  if (opts.orchestratorDetail || opts.workflowVerbose) {
    const frame = runFrame(row, { ...opts, focus: opts.focus === 1 ? 1 : 0, bodyHeight });
    for (const line of frame.body) body.push(line);
    markStepRows(body, frame.body, frame.model);
    return header;
  }

  // The goal, above the timeline rather than replayed inside it.
  const goal = String(state.intent?.goal ?? state.workflow ?? '').trim();
  const goalRows = wrapLines(goal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), width - 2)
    .slice(0, narrow ? 2 : 2);
  for (const line of goalRows) body.push(cut(` ${line}`, width));

  const progress = planProgress(row, { assignments: model.assignments, nowMs });
  const right = [
    progress.phases ? `phase ${progress.phase} of ${progress.phases}` : null,
    `${progress.done}/${progress.total} steps`,
    progress.eta ? `ETA ${progress.eta}` : progress.remaining ? `ETA ${blank()}` : null,
  ].filter(Boolean).join(' · ');
  body.push(rule('plan', right, width));
  const selectedId = opts.focus === 1 ? panel.selectedAgent?.action?.id ?? null : null;
  // Keep a small reserve for the licence/live band, its explanations, and a
  // few timeline rows. The plan itself reports any action rows that could not
  // fit, while all phase headers remain visible in their authored order.
  const planRowBudget = Math.max(1, (Number(bodyHeight) || 24) - body.lines.length - 12);
  for (const line of planDagLines(row, {
    width, runId: row?.runId ?? null, assignments: model.assignments, nowMs, pools: !narrow, selectedId,
    maxRows: planRowBudget,
  })) body.parts(line.parts);

  // The prototype's budget / live / so far triptych: one row band at the
  // desktop widths, three stacked sections on the phone.
  const economics = runEconomics(row, model.pools, nowMs);
  body.push('');
  if (narrow) {
    // The phone spends the prototype's rows: the budget, one `so far` line
    // under it, then what is live — and leaves the timeline the rest.
    body.push(rule('licence this run used', null, width));
    for (const line of runBudgetRows(economics, { width: width - 2 })) body.push(` ${cut(line, width - 1)}`);
    const money = moneyText(economics);
    body.push(cut(` so far ${tint(money, 'purple')} · ${economics.measuredAttempts} of ${economics.attempts} attempts measured · ${stepTally(row)} · ${activeMinutesText(runDuration.activeMinutes)}${progress.eta ? ` · ETA ${progress.eta}` : ` · ETA ${blank()}`}`, width));
    body.push('');
    body.push(rule('live', null, width));
    for (const line of runLiveRows(panel, { width: width - 2, nowMs, limit: 2 })) body.push(` ${cut(line, width - 1)}`);
  } else {
    const gap = 2;
    const inner = Math.max(9, width - gap * 2);
    const cellWidth = Math.floor(inner / 3);
    // The rules sit on the page's own left margin; the rows under them are
    // indented one column, the way every other section on the page is.
    const inset = (rows) => rows.map((line) => ` ${cut(line, cellWidth - 1)}`);
    pushColumns(body, [
      { rule: 'licence this run used', rows: inset(runBudgetRows(economics, { width: cellWidth - 1 })), action: { kind: 'page', page: 'budget' } },
      { rule: 'live', rows: inset(runLiveRows(panel, { width: cellWidth - 1, nowMs })) },
      { rule: 'so far', rows: inset(runSoFarRows(row, panel, progress, economics, { width: cellWidth - 1, nowMs })) },
    ], { width, gap, indent: 0 });
  }
  // Every blank in the three cells above, and the reason for it, once.
  for (const reason of runBlankReasons(economics, progress)) {
    body.push(dimText(` ${blank()} ${reason}`, width));
  }

  body.push('');
  // What fills the rest of the body: the timeline, the phase list `t` shows
  // instead of it, or the selected phase's steps once Enter has walked in.
  const used = body.lines.length;
  const rows = Math.max(3, Math.max(6, Number(bodyHeight) || 24) - used - 1);
  if (opts.focus === 1) {
    const phase = panel.selectedPhase;
    body.push(rule(`${phase.label} · ${phase.completed}/${phase.total} complete · active ${activeMinutesText(phase.activeMinutes)}`, null, width));
    if (!panel.agents.length) {
      const blocked = phase.blockedActions ?? [];
      for (const entry of blocked) {
        body.push(dimText(` ${glyphs().blocked} ${entry.id} · never dispatched · blocked by ${entry.blockedBy.length ? entry.blockedBy.join(', ') : 'a failed dependency'}`, width));
      }
      // No agent has been dispatched, so the phase says what it plans to run
      // and the role the kernel gave each step — never `undefined`.
      body.push(dimText(' no agent has started in this phase yet', width));
      body.push(dimText(' planned steps in this phase:', width));
      for (const entry of phase.actions) {
        if (blocked.some((item) => item.id === entry.id)) continue;
        body.row(
          cut(` ${statusIcon(entry.status, spinnerFrame)} ${entry.id} · ${actionRoleLabel(entry)} · ${entry.status}`, width),
          { kind: 'step', actionId: entry.id },
        );
      }
      if (!phase.actions.length) body.push(dimText(' waiting for the planner to add work', width));
    }
    panel.agents.forEach((agent, index) => {
      const reasoning = reasoningText(agent.attempt) || reasoningText(agent.active);
      const age = durationText(agent.attempt?.startedAt ?? agent.active?.startedAt, agent.attempt?.finishedAt);
      const tokens = tokenText(agent.attempt?.usage);
      body.row(
        selectLine(
          `${statusIcon(agent.status, spinnerFrame)} ${agent.action.id} · ${agent.pool} · ${agent.model}${reasoning ? ` · ${reasoning}` : ''} · #${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}${tokens ? ` · ${tokens}` : ''}${age !== 'time pending' ? ` · ${age}` : ''}`,
          index === panel.agentIndex, true, width,
        ),
        { kind: 'step', actionId: agent.action.id },
      );
    });
    // Whatever the step list leaves goes back to the timeline rather than to
    // blank rows: the reader is still reading a run.
    const left = rows - (body.lines.length - used) - 2;
    if (left >= 4) {
      body.push('');
      const tail = flatTimelineLines(panel, {
        width: width - 1, rows: left - 1, scroll: opts.detailScroll ?? 0, spinnerFrame, nowMs,
      });
      body.push(rule('timeline', `${tail.milestones} milestone${tail.milestones === 1 ? '' : 's'}`, width));
      const from = body.lines.length;
      for (const line of tail) body.push(` ${cut(line, width - 1)}`);
      markStepRows(body, body.lines.slice(from), panel, row?.runId ?? null);
    }
  } else if (opts.mobileTimeline === false) {
    body.push(rule(`phases · ${panel.phases.length}`, null, width));
    panel.phases.forEach((phase, index) => {
      body.push(selectLine(
        `${index + 1} ${statusIcon(phase.status, spinnerFrame)} ${phase.label}${phase.total ? ` ${phase.completed}/${phase.total}` : ''}`,
        index === panel.phaseIndex, true, width,
      ));
    });
  } else {
    // The timeline follows the newest event by default. It only re-anchors on
    // a phase the reader chose — `phaseIndex` is null while the page is
    // following the active one — so choosing nothing never stops the follow.
    const selectedSegment = opts.mobileTimeline !== false && opts.timelineSelection != null
      ? (opts.timelineSelection === 0 ? 'Preflight' : panel.phases[opts.timelineSelection - 1]?.label ?? null)
      : opts.phaseIndex != null ? panel.phases[panel.phaseIndex]?.label ?? null : null;
    const lines = flatTimelineLines(panel, {
      width: width - 1, rows: rows - 1, scroll: opts.detailScroll ?? 0, selectedSegment, spinnerFrame, nowMs,
    });
    body.push(rule('timeline', `${lines.milestones} milestone${lines.milestones === 1 ? '' : 's'}`, width));
    const from = body.lines.length;
    for (const line of lines) body.push(` ${cut(line, width - 1)}`);
    markStepRows(body, body.lines.slice(from), panel, row?.runId ?? null);
  }
  return header;
}

/**
 * Run page v2.  The legacy renderer above remains as a compatibility helper
 * for the extracted TUI panels; the dashboard page itself uses this grammar.
 */
function runPage(model, opts, body) {
  const width = Math.max(20, Number(opts.width) || 120);
  const phone = width < 100;
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const row = model.row;
  const state = row?.state ?? {};
  const rollup = runRollupFor(model);
  const headerFacts = runHeaderFacts(row, { nowMs, rollup });
  const status = headerFacts.status;
  const glyph = status === 'completed' || status === 'succeeded' ? glyphs().ok
    : ['failed', 'partial', 'cancelled', 'interrupted'].includes(status) ? glyphs().fail : glyphs().ongoing;
  const activeGlyph = status === 'running' && Number(opts.spinnerFrame) > 0
    ? spinnerGlyph(opts.spinnerFrame)
    : glyph;
  const runStatusParts = [
    `${activeGlyph} ${headerFacts.shortId}`,
    status,
    `${headerFacts.done} of ${headerFacts.total} steps done`,
    headerFacts.running.length ? `${headerFacts.running.length} running (${headerFacts.running.join(', ')})` : null,
    headerFacts.waiting.length ? `${headerFacts.waiting.length} waiting (${headerFacts.waiting.join(', ')})` : null,
  ].filter(Boolean);
  const runStatus = (() => {
    const full = runStatusParts.join(' · ');
    if (!phone || full.length <= width) return full;
    const countsOnly = runStatusParts.slice(0, 3).concat([
      headerFacts.running.length ? `${headerFacts.running.length} running` : null,
      headerFacts.waiting.length ? `${headerFacts.waiting.length} waiting` : null,
    ].filter(Boolean)).join(' · ');
    const noWaiting = runStatusParts.slice(0, 3).concat(
      headerFacts.running.length ? [`${headerFacts.running.length} running`] : [],
    ).join(' · ');
    const shortDone = [
      `${activeGlyph} ${headerFacts.shortId}`,
      status,
      `${headerFacts.done} of ${headerFacts.total} steps`,
      headerFacts.running.length ? `${headerFacts.running.length} running` : null,
    ].filter(Boolean).join(' · ');
    // The phone target keeps the verdict scannable before it spends the last
    // cells on parenthesised ids; the full ids remain on the desktop header.
    return [shortDone, noWaiting, countsOnly, full].find((candidate) => candidate.length <= width) ?? shortDone;
  })();
  const clock = headerFacts.activeMinutes == null ? null : [
    `${headerFacts.activeText} active${headerFacts.spanText !== headerFacts.activeText ? ` of ${headerFacts.spanText}` : ''}`,
    status === 'running'
      ? (headerFacts.startedClock ? `since ${headerFacts.startedClock} HKT` : null)
      : headerFacts.startedClock && headerFacts.finishedClock ? `${headerFacts.startedClock} → ${headerFacts.finishedClock} HKT` : null,
    phone ? `${headerFacts.attempts} attempts` : null,
    !phone && width >= 160 ? headerFacts.dateText : null,
  ].filter(Boolean).join(' · ');
  const paintedRunStatus = paintRunHeader(runStatus, headerFacts, activeGlyph);
  const paintedClock = clock ? dimCell(clock) : '';
  const header = phone ? cut(` ${paintedRunStatus}`, width) : alignRight(` ${paintedRunStatus}`, paintedClock, width);

  if (opts.orchestratorDetail || opts.workflowVerbose) {
    const frame = runFrame(row, { ...opts, focus: opts.focus === 1 ? 1 : 0, bodyHeight: opts.bodyHeight });
    for (const line of frame.body) body.push(cut(line, width));
    markStepRows(body, frame.body, frame.model);
    return header;
  }

  const goalSource = headerFacts.goal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const goalLines = wrapLines(goalSource, Math.max(1, width - 2));
  if (goalLines.length) {
    const shown = goalLines.slice(0, phone ? 2 : 1);
    if (goalLines.length > shown.length) shown[shown.length - 1] = `${cut(shown.at(-1), Math.max(1, width - 4))}…`;
    for (const line of shown) body.push(cut(` ${line}`, width));
  }
  if (phone && clock) body.push(cut(` ${dimCell(clock)}`, width));
  if (!phone) {
    const project = headerFacts.project ?? '—';
    const cwd = headerFacts.cwd ?? '—';
    const attemptsLabel = `${dimCell(`${headerFacts.attempts} attempts`)}  ${paintAttemptMix(headerFacts)}`;
    body.push(cut(alignRight(` ${attemptsLabel}`, dimCell(`project ${project} · ${cwd}`), width), width));
  }
  body.push('');

  const progress = planProgress(row, { assignments: model.assignments, nowMs });
  // The cursor: Up/Down move the selected phase and Enter opens its first
  // step, so that phase's plan box — or, on a phone showing the glyph strip,
  // its timeline rule — is drawn inverse.
  const panel = workflowPanelModel(row, { phaseIndex: opts.phaseIndex, agentIndex: opts.agentIndex, nowMs });
  const cursorOn = (Number(opts.focus) || 0) === 0 && !opts.controlSelected;
  const cursorId = cursorOn ? panel.selectedPhase?.actions?.[0]?.id ?? null : null;
  const cursorInTimeline = cursorOn && phone && !opts.planBoxes;
  if (!phone) body.push(paintRule(rule(`plan · phase ${progress.phase} of ${progress.phases}`, null, width)));
  if (phone && !opts.planBoxes) {
    const { stages } = planStages(row);
    const current = stages[Math.max(0, progress.phase - 1)];
    const next = stages.slice(Math.max(0, progress.phase)).find((stage) => (stage.actions ?? []).some((action) => !RUN_DONE.has(action.status)));
    const currentName = current ? planStageName(current, progress.phase - 1) : 'starting';
    const currentState = current?.actions?.some((action) => action.status === 'running') ? 'running'
      : current?.actions?.every((action) => RUN_DONE.has(action.status)) ? 'done' : 'waiting';
    const nextName = next ? planStageName(next, stages.indexOf(next)) : '—';
    body.push(cut(` ${dimCell('plan')}  ${runPlanGlyphStrip(row)}  ${progress.phase} ${strong(currentName)} ${paintStatusWord(currentState)} · then ${nextName}`, width));
  } else {
    for (const line of planDagLines(row, {
      width: Math.max(1, width - 1), runId: row?.runId ?? null, assignments: model.assignments, nowMs,
      pools: !phone, selectedId: cursorId,
    })) body.parts([{ text: ' ' }, ...line.parts.map((part) => paintPlanPart(part))]);
  }
  body.push('');

  const live = runLivePresentation(model, { nowMs, runFollow: opts.runFollow !== false });
  const spend = runSpendFacts(row, { rollup });
  const pausedId = state.lifecycle?.status === 'paused'
    ? (state.shortId ?? row?.shortId ?? state.runId ?? row?.runId ?? null)
    : null;
  if (width >= 120) {
    const liveWidth = Math.max(20, width - 82);
    const left = runLiveLinesV2(live, liveWidth, { phone: false, nowMs, runFollow: opts.runFollow !== false, paused: pausedId });
    const right = runSpendLinesV2(spend, 79, { phone: false });
    const count = Math.max(left.length, right.length);
    // The band is one column: every left cell is padded out to the divider so
    // the `│` sits in the same place on every row (`live` / `spend` are two
    // columns of one rule in the Run v2 record, not two ragged blocks).
    const cell = (text) => {
      const trimmed = cut(text ?? '', liveWidth);
      return `${trimmed}${' '.repeat(Math.max(0, liveWidth - visibleLength(trimmed)))}`;
    };
    for (let index = 0; index < count; index += 1) {
      body.push(`${cell(left[index])} │ ${cut(right[index] ?? '', 79)}`);
    }
  } else {
    for (const line of runLiveLinesV2(live, width, { phone, nowMs, runFollow: opts.runFollow !== false, paused: pausedId })) body.push(cut(line, width));
    body.push('');
    for (const line of runSpendLinesV2(spend, width, { phone })) body.push(cut(line, width));
  }
  if (row?.kernelStderrTail?.length) body.push(' kernel log: available');
  body.push('');

  const foldOpen = opts.foldOpen === true;
  const timeline = workflowTimelineLines(panel, width, opts.spinnerFrame ?? 0, { goalPreview: false, nowMs, phone, foldOpen });
  const cursorSegment = !cursorInTimeline || opts.timelineSelection === 'fold' ? null
    : opts.timelineSelection === 0 ? 'Preflight' : panel.selectedPhase?.label ?? null;
  const foldRange = foldRangeOf(runTimelineFacts(row, { nowMs }).phases);
  const foldCursor = cursorOn && foldRange
    ? (foldOpen ? opts.foldStop === true : (opts.foldStop === true
      || (phone ? opts.timelineSelection === 'fold'
        : panel.phaseIndex >= foldRange.start && panel.phaseIndex < foldRange.end)))
    : false;
  body.push(paintRule(rule(`timeline · ${timeline.phases} phases · ${timeline.attempts} attempts${phone ? '' : ' · Enter on a step opens it'}`, null, width)));
  const timelineStart = body.lines.length;
  for (const line of timeline.lines) {
    const plain = cut(timelineText(line), width);
    const text = (cursorSegment && line?.header && line.segment === cursorSegment) || (foldCursor && line?.fold)
      ? inverseText(plain) : plain;
    if (line?.fold) body.row(text, { kind: 'fold', ...(row?.runId ? { runId: row.runId } : {}) });
    else if (line?.actionId) body.row(text, { kind: 'step', actionId: line.actionId, ...(row?.runId ? { runId: row.runId } : {}) });
    else body.push(text);
  }
  markStepRows(body, body.lines.slice(timelineStart), workflowPanelModel(row), row?.runId ?? null);
  return header;
}

export {
  runFrame,
  renderWorkflowOverviewPanel,
  sectionDivider,
  groupedTimeline,
  timelineSegmentDisplayName,
  workflowTimelineLines,
  runTimelineFold,
  segmentHeader,
  continuationHeader,
  currentTimelineSegment,
  timelineText,
  workflowLiveLines,
  workflowNextLines,
  workflowTechnicalLines,
  timelineRow,
  timelineDetail,
  alignRight,
  orchestratorDetailLines,
  humanStatus,
  plannerDisplayStatus,
  plannerUsageSummary,
  friendlyActionKind,
  friendlyActionSummary,
  compactAgentPreviewLines,
  planDagLines,
  flatTimelineLines,
  runBudgetRows,
  runLiveRows,
  runSoFarRows,
  runBlankReasons,
  runLivePresentation,
  runLiveLinesV2,
  runSpendLinesV2,
  runPage,
  actionNamedIn,
  markStepRows,
};
