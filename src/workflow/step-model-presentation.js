// The Step page v2 presentation: the design record's blocks, said once.
//
// The blocks below are the design record's own vocabulary: one header said
// once, turn rows with non-zero counts, a result card read from structured
// data only, the task's author prompt beside the kernel wrapper's size, and
// two plain-word cost rows. Every string here is either a captured field or a
// word map over a finite code (a basis, a token source, an event kind); no
// value is parsed out of prose and an unknown stays a dash.

import { basename } from 'node:path';
import { finiteOrNull } from '../lib/num.js';
import { REFUSAL_TEXT, wasRefusedAtStart } from './step-vocabulary.js';
import { routeSummary } from './step-route.js';
import { returnedEarlyItems, returnedEarlyText, timeBoxText } from './time-box.js';
import { costRows } from './step-model-cost.js';
import { reportLeadLines, diffChangedPaths, sharedFileRequests } from './step-model-report.js';
import {
  stepClockText,
  stepTimeText,
  stepTimeSecText,
  stepDateText,
  stepBytesText,
} from './step-model-text.js';
import { stepTurns, preludeRows } from './step-model-turn-rows.js';
import { textOrNull, clone, dateMs } from './step-model-values.js';

function shortHomePath(path, homeDir) {
  const value = textOrNull(path);
  if (!value) return null;
  if (homeDir && value.startsWith(homeDir)) return `~${value.slice(homeDir.length)}`;
  return value;
}

/** The route sentence, with the picked pool named beside the ones it beat. */
function routeSentence(routeReason, candidates) {
  const reason = textOrNull(routeReason);
  if (!reason) return null;
  const head = reason.split(/,\s*forecast\b/)[0].trim();
  const others = (candidates ?? []).slice(1).map((candidate) => textOrNull(candidate?.pool)).filter(Boolean);
  const picked = others.length ? ` · picked over ${others.join(', ')}` : '';
  // A trailing comma left by the trimmed forecast clause is the only edit.
  return `${head.replace(/,\s*$/, '')}${picked}`;
}

function attemptCountText(attempts, selected) {
  const total = attempts?.length ?? 0;
  const ordinal = finiteOrNull(selected?.ordinal) ?? (total ? 1 : null);
  if (ordinal == null) return null;
  // A gate retry (stage-3 D5) ran on the same pool with the failure attached.
  const retry = wasRefusedAtStart(selected, attempts)
    ? ` · refused at start: ${REFUSAL_TEXT[selected.failureKind] ?? selected.failureKind ?? 'refused'} · picked again`
    : selected?.retryOf?.how === 'same-pool' ? ' · same pool, failure attached' : '';
  return `${total > 1 ? `attempt ${ordinal} of ${total}` : `attempt ${ordinal} of ${total || 1}`}${retry}`;
}

function verificationSummary(requirements) {
  const list = Array.isArray(requirements) ? requirements : [];
  const passed = list.filter((entry) => entry?.status === 'passed').length;
  return { total: list.length, passed, complete: list.length > 0 && passed === list.length };
}

function stepPresentation({
  identity, verdict, action, selected, attempts, runDir, homeDir, activity, route,
  duration, meta, money, prompt, promptPath, outText, outFile, streamFile, diffFile,
  diffText, resultPath, requirements, nowMs, follow, v3 = false, answer = null,
} = {}) {
  const execution = verdict?.execution ?? {};
  const running = execution.status === 'running';
  // A step whose check failed and that the caller accepted is not a plain
  // success: the header and result say the choice, as the proof line does.
  const acceptedByChoice = execution.succeeded === true && action?.acceptance && typeof action.acceptance === 'object'
    && !Array.isArray(action.acceptance.requirements);
  const statusWord = acceptedByChoice ? 'accepted by choice' : execution.status ?? 'unknown';
  // A v3 step is judged by facts (its answer, evidence, deliverable), never
  // by the run's implicit requirement: it has no verification verdict.
  const verification = verificationSummary(v3 ? [] : requirements);
  const attemptText = attemptCountText(attempts, selected);
  const startMs = dateMs(selected?.startedAt ?? action?.startedAt);
  const finishMs = dateMs(selected?.finishedAt ?? selected?.endedAt);
  const lastEvent = activity?.events?.at(-1) ?? null;
  const lastEventMs = dateMs(lastEvent?.at);
  const presentedTurns = stepTurns(activity, {
    outText,
    expandedTurn: activity?.expandedTurn ?? null,
    nowMs,
    allTools: activity?.view === 'detail',
  });
  const runningCommand = running
    ? presentedTurns.flatMap((turn) => turn.toolRows ?? []).findLast((tool) => tool?.inFlight && tool?.command)
    : null;
  const verdictText = v3 ? (answer ? (answer.ok ? 'answer checked' : 'answer check failed') : null)
    : verification.total
    ? `${verification.complete ? 'verified by the workflow' : 'not verified'} (${verification.passed}/${verification.total} requirements)`
    : identity?.verified === true ? 'verified' : identity?.verified === false ? 'not verified' : null;
  // Rule 2: one clock, and the span appears only when it differs from the
  // active time. `49m07s active of 1h02m` is the only shape that says both.
  const activeText = stepClockText(duration?.activeMs);
  const spanText = finiteOrNull(duration?.spanMs) != null && finiteOrNull(duration?.spanMs) !== finiteOrNull(duration?.activeMs)
    ? stepClockText(duration.spanMs)
    : null;
  return {
    header: {
      // The verdict of line 1 as a state; the view picks the glyph the terminal
      // can actually draw (a shell in ascii mode has no `●` or `✓`).
      state: execution.succeeded ? 'ok' : execution.terminal ? 'fail' : 'running',
      actionId: identity?.actionId ?? null,
      shortId: identity?.shortId ?? null,
      status: statusWord,
      succeeded: execution.succeeded === true,
      running,
      verdictText,
      attemptText,
      purpose: identity?.purpose ?? null,
      pool: meta?.pool ?? null,
      model: meta?.model ?? null,
      effort: meta?.effort ?? null,
      reasoning: meta?.reasoning ?? null,
      activeText,
      spanText,
      clockText: spanText ? `${activeText} active of ${spanText}` : activeText,
      startedClock: stepTimeText(startMs),
      finishedClock: stepTimeText(finishMs),
      dateText: stepDateText(finishMs ?? startMs),
      lastEventClock: stepTimeSecText(lastEventMs),
      // A raw instant, not a rendered age: "3s ago" is a fact about the screen
      // that draws it, so the view derives it from its own clock.
      lastEventMs,
      turnNumber: activity?.turns?.length ?? 0,
      following: Boolean(follow),
      route: routeSentence(route?.reason, route?.candidates),
      // The soft time box: `returned early · 2 not done` when the attempt's
      // report listed unfinished items, and `box 20m · ran 34m` once it ran
      // past its box (`box 20m` otherwise). Null when the attempt had none.
      earlyText: returnedEarlyText(selected),
      notDoneItems: returnedEarlyItems(selected),
      boxText: timeBoxText(selected, { durationMs: selected?.durationMs }),
    },
    activity: {
      available: Boolean(activity?.available),
      reason: activity?.reason ?? null,
      events: activity?.events?.length ?? 0,
      turns: presentedTurns,
      prelude: preludeRows(activity),
      totals: activityTotals(activity?.turns ?? []),
      filter: activity?.filter ?? 'all',
      running,
      following: Boolean(follow),
      runningCommand: runningCommand ? {
        text: runningCommand.text,
        startedAt: runningCommand.startedAt,
      } : null,
    },
    result: {
      running,
      title: statusWord,
      verification,
      verdictText,
      attemptNumber: finiteOrNull(selected?.ordinal),
      failure: textOrNull(selected?.failureReason),
      events: activity?.events?.length ?? 0,
      lastResponse: (() => {
        const last = activity?.turns?.at(-1) ?? null;
        const text = textOrNull(last?.responseText);
        return text ? { clock: stepTimeText(last.response?.at ?? last.responseEvent?.at), text } : null;
      })(),
      verdictText,
      reportLines: reportLeadLines(outText),
      changed: diffChangedPaths(diffText),
      asks: sharedFileRequests(outText),
      runDir: shortHomePath(runDir, homeDir),
      runDirShort: runDir ? basename(runDir) : null,
      artifacts: {
        task: shortHomePath(promptPath, homeDir),
        output: shortHomePath(outFile, homeDir),
        stream: shortHomePath(streamFile, homeDir),
        diff: shortHomePath(diffFile, homeDir),
        result: shortHomePath(resultPath, homeDir),
      },
      fullPaths: {
        task: promptPath ?? null,
        output: outFile ?? null,
        stream: streamFile ?? null,
        diff: diffFile ?? null,
        result: resultPath ?? null,
      },
      reportBytesText: stepBytesText(typeof outText === 'string' ? Buffer.byteLength(outText, 'utf8') : null),
      streamEvents: activity?.events?.length ?? 0,
      // A step that declares an answer shows the attempt's checked answer.
      ...(answer ? { answer } : {}),
    },
    task: {
      kind: textOrNull(action?.kind),
      // Only a step that stores a role carries the field, so kind-only
      // presentations stay byte-identical.
      ...(textOrNull(action?.role) ? { role: textOrNull(action.role) } : {}),
      // Stage 3: where the step may run, and the caller's choice to accept
      // it; present only when set, so older presentations stay byte-identical.
      ...(routeSummary(action?.route) ? { route: routeSummary(action.route) } : {}),
      ...(action?.acceptance && typeof action.acceptance === 'object' ? { acceptance: acceptanceModel(action.acceptance) } : {}),
      lane: textOrNull(action?.lane),
      promptLines: String(prompt ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3),
      owns: basenames(action?.ownedFiles),
      after: (Array.isArray(action?.dependsOn) ? action.dependsOn : []).map((id) => textOrNull(id)).filter(Boolean),
      affects: (Array.isArray(action?.affects) ? action.affects : []).map((id) => requirementWords(id)).filter(Boolean),
      bytes: selected?.bytes && typeof selected.bytes === 'object' ? clone(selected.bytes) : null,
    },
    cost: costRows(money, { running, attempts, selected }),
  };
}

function acceptanceModel(value) {
  return {
    reason: textOrNull(value.reason),
    at: textOrNull(value.at),
    attemptId: textOrNull(value.attemptId),
    failureKind: textOrNull(value.failureKind),
    requirements: Array.isArray(value.requirements) ? value.requirements.map((entry) => textOrNull(entry?.id)).filter(Boolean) : null,
  };
}

function basenames(list) {
  return (Array.isArray(list) ? list : []).map((entry) => textOrNull(entry)).filter(Boolean).map((entry) => basename(entry));
}

function requirementWords(id) {
  const value = textOrNull(id);
  if (!value) return null;
  return value.replace(/^requirement[-_ ]?(\d+)$/i, 'requirement $1');
}

function activityTotals(turns) {
  const totals = { commands: 0, filesRead: 0, searches: 0, edits: 0, otherTools: 0, errors: 0 };
  for (const turn of turns) {
    for (const field of Object.keys(totals)) totals[field] += finiteOrNull(turn?.summary?.[field]) ?? 0;
  }
  return totals;
}

export {
  stepPresentation,
};
