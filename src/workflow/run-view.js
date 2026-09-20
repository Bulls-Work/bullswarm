// Run page rendering and timeline views.
//
// Run-specific views consume the shell's shared ANSI/layout contract and the
// Run model projections. The shell imports these functions and re-exports the
// compatibility helpers that existing Step and CLI callers use.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { asciiGlyphsPreferred, glyphs } from '../lib/glyphs.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { v2RunnerLiveness } from './short-id.js';
import { presentationStageStatus } from './v2-presentation.js';
import { absentLine, cut, progressBar, rule } from './dash-kit.js';
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
  stepTally,
} from './run-model.js';

/** Lines of the goal the Preflight segment shows before an ellipsis. */
const GOAL_PREVIEW_LINES = 5;
const ANSI_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;

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
  const timeline = workflowTimelineLines(model, inner, spinnerFrame, { nowMs });
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
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]))) start += 1;
  }
   let visibleTimeline = timeline.lines.slice(start, end);
   if (start > 0 && selectedHeader < 0) {
     visibleTimeline.unshift(dimText(`↑ ${start} earlier timeline rows`, inner));
     const continuation = visibleTimeline.find((line) => line?.segment)?.segment
       ?? currentTimelineSegment(model);
     if (continuation) {
       const priorHeader = timeline.lines.find((line) => line?.header && line.segment === continuation);
       const header = continuationHeader(
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

function workflowTimelineLines(model, width, spinnerFrame = 0, { goalPreview = true, nowMs = Date.now() } = {}) {
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

function alignRight(left, right, width) {
  const suffix = right ? String(right) : '';
  // Preserve the actionable event label in the compact preview; dropping a
  // duration is preferable to turning the action name into an ellipsis.
  if (width < 30) return truncate(left, width);
  if (!suffix) return truncate(left, width);
  const room = Math.max(1, width - suffix.length - 1);
  const lhs = truncate(left, room);
  return `${lhs}${' '.repeat(Math.max(1, width - lhs.length - suffix.length))}${suffix}`;
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
  lines.forEach((line, index) => {
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
  const timeline = workflowTimelineLines(panel, width, spinnerFrame, { goalPreview: false, nowMs });
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
function runPage(model, opts, body) {
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

export {
  runFrame,
  renderWorkflowOverviewPanel,
  sectionDivider,
  groupedTimeline,
  timelineSegmentDisplayName,
  workflowTimelineLines,
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
  runPage,
  actionNamedIn,
  markStepRows,
};
