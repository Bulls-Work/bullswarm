// Run page rendering and timeline views.
//
// Run-specific views consume the shell's shared ANSI/layout contract and the
// Run model projections. The shell imports these functions and re-exports the
// compatibility helpers that existing Step and CLI callers use.

import { finiteOrNull } from '../lib/num.js';
import { formatMoney } from '../lib/usage-basis.js';
import { glyphs, spinnerGlyph } from '../lib/glyphs.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { v2RunnerLiveness } from './short-id.js';
import { cut, rule, seriesColor } from './dash-kit.js';
import {
  agentDetailLines,
  clamp,
  clockText,
  compactUsage,
  dimLine,
  dimText,
  durationText,
  formatBytes,
  inverseText,
  joinPanels,
  panelCell,
  panelWindow,
  reasoningText,
  renderPanel,
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
  attemptDurationText,
  runDurationFacts,
  planProgress,
  planStages,
  planStageName,
  runClockText,
  runHeaderFacts,
  runSpendFacts,
  runTimelineFacts,
} from './run-model.js';
import { stepPageModel, turnCountsText } from './step-model.js';
import { returnedEarlyItems, returnedEarlyText } from './time-box.js';
import { loopVerdictText } from './verify-rounds.js';
import { NEEDS_YOU_LABELS } from './step-vocabulary.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';

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
  // The facts sit after the label: a step named `now` is not the clock.
  const labelAt = phase?.name ? source.indexOf(phase.name) : -1;
  let factsFrom = labelAt >= 0 ? labelAt + phase.name.length : 0;
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

function paintTimelineAttempt(line, attempt, { phone = false, duration = null, early = null } = {}) {
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
  // An early return follows the duration: `34m03s · returned early · 2 not done`.
  const earlyTail = early ? ` · ${early}` : '';
  const hasEarly = Boolean(earlyTail) && out.endsWith(earlyTail);
  if (hasEarly) out = out.slice(0, -earlyTail.length);
  const clock = String(duration ?? '');
  if (clock && out.endsWith(clock)) out = `${out.slice(0, -clock.length)}${dimCell(clock)}`;
  if (hasEarly) out = `${out}${dimCell(' · ')}${tint(early, 'amber')}`;
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
       // that phase's own name and glyph. A phase rule has no elapsed cell, and
       // defaulting one to `running` claimed a finished run was still going.
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

// A marked run's Workflow Planner or preflight scout that ended on one of these
// stopped and went to the caller (watch-cli.js, the same set).
const LIMIT_STOP_KINDS = new Set(['quota', 'throttle', 'unavailable']);

function isoOrNull(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The attempt a planner.finished or preflight.scout_finished event closed: the
// last one finished by the time it was committed, as the watch reads it.
function attemptClosedAt(attempts, committedAt) {
  const at = Date.parse(committedAt ?? '');
  if (!Number.isFinite(at)) return attempts.at(-1) ?? null;
  return attempts.filter((attempt) => !(Date.parse(attempt?.finishedAt ?? attempt?.startedAt ?? '') > at)).at(-1) ?? null;
}

/**
 * The Run timeline's rows for a marked run whose Workflow Planner or preflight
 * scout stopped on a usage limit, a rate limit that did not clear, or no free
 * pool, worded as `bullswarm workflow watch` prints them:
 * `✗ [Workflow Planner] planner stopped · out of quota on codex · back at <iso>`
 * and `⚠ Scout stopped · rate limited on codex`. The stop is why the run ended,
 * so the timeline says it. A limit stop's event carries `retryAfter` (null when
 * unknown); a run's features.json `failureRule` marks it too, as the watch
 * reads it. Any other planner or scout failure, and every unmarked run, draws
 * no row here, as before. A first-turn planner stop sits under Preflight, a
 * later turn's under its own Planner rule after the phases.
 */
function limitStopRows(model) {
  const state = model.state ?? model.row?.state ?? {};
  let flags;
  const marked = () => (flags ??= runFeatureFlags(model.row?.runDir ? readRunFeatures(model.row.runDir) : {})).failureRule;
  const stopped = (payload) => LIMIT_STOP_KINDS.has(payload?.failureKind)
    && (Object.hasOwn(payload, 'retryAfter') || marked());
  const tail = (payload, pool) => `${NEEDS_YOU_LABELS[payload.failureKind]} on ${pool ?? 'no pool'}`
    + (isoOrNull(payload.retryAfter ?? null) ? ` · back at ${isoOrNull(payload.retryAfter)}` : '');
  const row = (at, glyph, status, text) => ` ${at ? dimCell(clockText(at)) : dimCell('--:--')}  ${paintStatusGlyph(glyph, status)} ${text}`;
  const rows = [];
  for (const event of model.events ?? []) {
    const payload = event?.payload ?? {};
    if (event?.type === 'preflight.scout_finished' && payload.status === 'failed' && stopped(payload)) {
      // `unavailable`: no scout attempt ran, so no pool is named.
      const pool = payload.pool ?? (payload.failureKind === 'unavailable'
        ? null : attemptClosedAt(state.preflight?.scout?.attempts ?? [], event.committedAt)?.pool ?? null);
      const runContinues = typeof payload.runContinues === 'boolean'
        ? payload.runContinues : (state.program?.actions ?? []).length > 0;
      rows.push({
        segment: 'Preflight', at: event.committedAt ?? null,
        text: row(event.committedAt, glyphs().warn, 'running', `Scout stopped · ${tail(payload, pool)}`
          + (runContinues ? ' · the run continues without its report' : '')),
      });
    }
    if (event?.type === 'planner.finished' && payload.ok === false && stopped(payload)) {
      const turn = Number.isInteger(payload.turn) ? payload.turn : null;
      const attempts = (state.planner?.attempts ?? []).filter((attempt) => turn == null || attempt?.turn === turn);
      // `unavailable`: no planner attempt ran, so no pool is named.
      const pool = payload.pool ?? (payload.failureKind === 'unavailable'
        ? null : attemptClosedAt(attempts, event.committedAt)?.pool ?? null);
      rows.push({
        segment: turn == null || turn === 1 ? 'Preflight' : 'Planner', at: event.committedAt ?? null,
        text: row(event.committedAt, glyphs().fail, 'failed', `[Workflow Planner] planner stopped · ${tail(payload, pool)}`),
      });
    }
  }
  return rows;
}

/**
 * Run v2's tree: phase facts plus one row per durable attempt.
 *
 * `foldOpen` shows the folded phases in place and closes them with a
 * `click to fold` line; `foldHint: false` drops the `click to expand` hint
 * for a reader (the mod pane) that has no pointer to click with.
 */
function workflowTimelineLines(model, width, spinnerFrame = 0, {
  goalPreview = true, nowMs = Date.now(), phone = Number(width) < 100, foldOpen = false, foldHint = true, selectedActionId = null,
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
  const stops = limitStopRows(model);
  for (const stop of stops.filter((item) => item.segment === 'Preflight')) {
    push(stop.text, { segment: 'Preflight', at: stop.at, milestone: true, limitStop: true });
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
    const tally = `${phase.done}/${phase.total}`;
    const right = `${start} → ${end} · ${duration} · ${tally}`;
    // The phone prints the facts on their own row under the rule.
    const rule = phaseRule(phaseTitle(phase), phaseStepsText(phase), phone ? [] : [right, `${duration} · ${tally}`, tally], safeWidth);
    // The name and the steps are bold, `Phase <n> · ` plain, as `<n> · ` was.
    const named = rule.label.slice(`${phase.glyph} Phase ${phase.index + 1}`.length).replace(/^ · /, '');
    push(paintPhaseRule(rule.line, { ...phase, name: named }), {
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
      const tier = attempt.effort ?? attempt.routing?.effort ?? '—';
      const reasoning = reasoningText(attempt);
      const routing = `tier ${tier}`;
      const runningText = attempt.status === 'running' ? ' · running' : '';
      const duration = attemptDurationText(attempt, { nowMs });
      const left = phone
        ? (() => {
          const prefix = ` ${clock}  ${glyph} `;
          const suffix = ` · ${routing}`;
          const available = Math.max(1, safeWidth - visibleLength(prefix) - visibleLength(suffix) - visibleLength(duration) - 1);
          return `${prefix}${truncate(`${attempt.actionId} · ${pool}${runningText}`, available)}${suffix}`;
        })()
        : ` ${clock}  ${glyph} ${attempt.actionId} · ${pool} · ${modelName}${reasoning ? ` · reasoning ${reasoning}` : ''} · ${routing}${runningText}`;
      // A succeeded attempt whose report listed `## Not done` items says so
      // after its duration; a phone has no room there and gives it a row.
      const early = returnedEarlyText(attempt);
      const right = early && !phone ? `${duration} · ${early}` : duration;
      const selected = selectedActionId === attempt.actionId;
      push(paintTimelineAttempt(alignRight(left, right, safeWidth), {
        ...attempt, glyph,
      }, { phone, duration, early: phone ? null : early }), {
        segment: phase.label, phaseIndex: phase.index, at, attempt, actionId: attempt.actionId, milestone: true,
      });
      if (early && phone) {
        push(`        ${tint(early, 'amber')}`, { segment: phase.label, phaseIndex: phase.index, at, attempt, actionId: attempt.actionId });
      }
      if (selected) {
        for (const item of returnedEarlyItems(attempt)) {
          push(`        ${truncate(item, Math.max(1, safeWidth - 8))}`, {
            segment: phase.label, phaseIndex: phase.index, at, attempt, actionId: attempt.actionId,
          });
        }
      }
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
  const plannerStops = stops.filter((item) => item.segment === 'Planner');
  if (plannerStops.length) {
    push(paintRule(phone ? '── Planner' : rule('Planner', null, safeWidth)), { header: true, segment: 'Planner', phaseIndex: -1 });
    for (const stop of plannerStops) push(stop.text, { segment: 'Planner', at: stop.at, milestone: true, limitStop: true });
  }
  if (!lines.length) push('no timeline recorded');
  return {
    lines,
    milestoneCount: lines.filter((line) => line.milestone || line.header).length,
    phases: phases.length,
    attempts: facts.attempts.length,
  };
}

/** `✓ Phase 2 · Build`: the phase's glyph, number and the name its kinds give it. */
function phaseTitle(phase) {
  return `${phase.glyph} Phase ${phase.index + 1}${phase.kindName ? ` · ${phase.kindName}` : ''}`;
}

/**
 * The step names a phase rule carries after its title. A kernel loop phase is
 * named by its round (`repair · round 1 · 2 requirements`); the title already
 * says `Repair`, so the round's own leading word is not said twice.
 */
function phaseStepsText(phase) {
  const name = String(phase.name ?? '').trim();
  // Only a round's label: a phase whose first step is named `build` keeps it.
  const lead = phase.stage?.loopLabel && phase.kindName ? `${phase.kindName.toLowerCase()} · ` : null;
  return lead && name.toLowerCase().startsWith(lead) ? name.slice(lead.length) : name;
}

/**
 * `── ✓ Phase 2 · Build · time-box · docs ──── <start> → <end> · <duration> · <done>/<total>`:
 * the v2 phase rule spends its dashes between the label and the facts and ends
 * on the tally, so the count is the last thing the row says. Rule 6 of the
 * run-v2 record draws it that way; `rule()` keeps its closing dashes for the
 * rules that have a right-hand label to fence off. `rights` are the facts from
 * the fullest down; the phone passes none, prints the facts on a row of their
 * own, and draws no dashes after the label.
 *
 * The phase number and name are never cut. A phase whose steps are named at
 * length gives way first — its step names shorten, then go — and only then
 * the facts, shortest last: the count, the clock and the duration are what the
 * rule is read for. Returns the line and the label it painted.
 */
function phaseRule(title, steps, rights, width) {
  const cols = Math.max(1, Number(width) || 1);
  const named = String(title ?? '');
  const stepText = String(steps ?? '');
  const fill = rights.length > 0;
  const tails = [...rights.map((right) => ` ${right}`), ''];
  const draw = (label, tail) => {
    const head = `── ${label}`;
    if (!fill) return visibleLength(head) <= cols ? head : null;
    const dashes = cols - visibleLength(head) - 1 - visibleLength(tail);
    return dashes >= (tail ? 2 : 0) ? `${head} ${'─'.repeat(dashes)}${tail}` : null;
  };
  for (const tail of tails) {
    const whole = stepText ? `${named} · ${stepText}` : named;
    const line = draw(whole, tail);
    if (line) return { line, label: whole };
    const room = cols - visibleLength(`── ${named} · `) - (fill ? 1 + (tail ? 2 : 0) + visibleLength(tail) : 0);
    if (stepText && room >= 4) {
      const label = `${named} · ${cut(stepText, room)}`;
      return { line: draw(label, tail), label };
    }
    const bare = draw(named, tail);
    if (bare) return { line: bare, label: named };
  }
  // Too narrow for the title itself: the one place a cut is left.
  return { line: cut(`── ${named}`, cols), label: named };
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
  const tier = attempt.effort ?? attempt.routing?.effort ?? '—';
  const reasoning = reasoningText(attempt);
  const routing = `${reasoning ? `reasoning ${reasoning} · ` : ''}tier ${tier}`;
  const status = live.running ? tint('live', 'amber') : dimCell('last finished');
  const liveCounts = `${live.turns ?? 0} turns · ${live.events ?? 0} events`;
  const title = `${status} · ${strong(attempt.actionId)} · ${paintPool(pool)}${phone ? '' : ` · ${modelName} · ${routing}`} · ${dimCell(duration)}${phone ? '' : ` · ${dimCounts(liveCounts)}`}`;
  const lines = [paintRule(rule(title, null, width))];
  if (pausedLine) lines.push(cut(` ${dimCell(pausedLine.trimStart())}`, width));
  // At phone width the model and its reasoning outrank the routing tier.
  if (phone) lines.push(cut(` ${modelName} · ${reasoning ? `reasoning ${reasoning}` : `tier ${tier}`} · ${dimCounts(liveCounts)}`, width));
  for (const item of live.step?.presentation?.header?.notDoneItems ?? []) {
    lines.push(cut(`  ${truncate(item, Math.max(1, width - 2))}`, width));
  }
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

/** The Run page: the one renderDashboardPage (dashboard.js) draws for page 'run'. */
function runPage(model, opts, body) {
  const width = Math.max(20, Number(opts.width) || 120);
  const phone = width < 100;
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const row = model.row;
  const state = row?.state ?? {};
  const rollup = runRollupFor(model);
  const headerFacts = runHeaderFacts(row, { nowMs, rollup });
  const status = headerFacts.status;
  // A finished run with a repair loop says its verdict beside its status:
  // `completed · verified`, or `completed · not verified · verify rounds 3/3`.
  const loopVerdict = loopVerdictText(state);
  const glyph = status === 'completed' || status === 'succeeded' ? glyphs().ok
    : ['failed', 'partial', 'cancelled', 'interrupted'].includes(status) ? glyphs().fail : glyphs().ongoing;
  const activeGlyph = status === 'running' && Number(opts.spinnerFrame) > 0
    ? spinnerGlyph(opts.spinnerFrame)
    : glyph;
  // On a phone the verdict takes its own row when the header cannot hold it
  // whole: a cut `verify rounds 3…` would hide the count the caller needs.
  const verdictOwnRow = Boolean(loopVerdict) && phone
    && ` ${activeGlyph} ${headerFacts.shortId} · ${status} · ${loopVerdict}`.length > width;
  const statusText = loopVerdict && !verdictOwnRow ? `${status} · ${loopVerdict}` : status;
  const runStatusParts = [
    `${activeGlyph} ${headerFacts.shortId}`,
    statusText,
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
      statusText,
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

  if (verdictOwnRow) body.push(cut(` ${loopVerdict}`, width));
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
  const timeline = workflowTimelineLines(panel, width, opts.spinnerFrame ?? 0, {
    goalPreview: false, nowMs, phone, foldOpen, selectedActionId: cursorId,
  });
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
    else if (line?.actionId) {
      // An attempt row opens the Step page on that attempt, not the latest:
      // the first of three `verify` rows is `attempt 1 of 3`.
      const ordinal = Number(line.attempt?.ordinal);
      body.row(text, {
        kind: 'step',
        actionId: line.actionId,
        ...(Number.isInteger(ordinal) && ordinal > 0 ? { attemptOrdinal: ordinal } : {}),
        ...(row?.runId ? { runId: row.runId } : {}),
      });
    } else body.push(text);
  }
  // A planner or scout stop row names no step: a word in it (`… without its
  // report`) that matches a step's id must not open that step's page.
  markStepRows(body, body.lines.slice(timelineStart).map((text, index) => (timeline.lines[index]?.limitStop ? '' : text)),
    workflowPanelModel(row), row?.runId ?? null);
  return header;
}

export {
  runFrame,
  renderWorkflowOverviewPanel,
  sectionDivider,
  timelineSegmentDisplayName,
  workflowTimelineLines,
  runTimelineFold,
  continuationHeader,
  currentTimelineSegment,
  timelineText,
  workflowLiveLines,
  workflowNextLines,
  workflowTechnicalLines,
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
  runLivePresentation,
  runLiveLinesV2,
  runSpendLinesV2,
  runPage,
  actionNamedIn,
  markStepRows,
};
