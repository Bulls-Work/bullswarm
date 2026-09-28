// The Run timeline's extra rows for a v3 run (0.37.0): a gate or loop row in
// the phase it heads or closes, with the continue command under a waiting
// one; the checked answer under each attempt; the loop round an attempt ran
// in. run-view.js calls these from its phase renderer; a v2 run gets null and
// its timeline is unchanged.

import { cut } from './dash-kit.js';
import { clockText, dimText, tint, visibleLength } from './dashboard.js';
import { attemptAnswerFact, attemptRounds, controlRowsByStage } from './v3-display.js';
import { isOneStepRun, isV3State } from './v3-phases.js';

const ROLE_COLOUR = { waiting: 'amber', passed: 'green', skipped: 'green', blocked: 'red' };

const dim = (text) => (text ? dimText(text, Math.max(1, visibleLength(text))) : '');

/**
 * What the timeline needs to draw a v3 run's extras, or null for a v2 run:
 * {placed: Map(stageId -> {before, after}), rounds: Map(attemptId -> {round}),
 *  oneStep, token}.
 */
export function v3TimelineFacts(model, stages) {
  const state = model?.state ?? model?.row?.state;
  if (!isV3State(state)) return null;
  const token = state.shortId ?? model?.row?.shortId ?? state.runId;
  return {
    placed: controlRowsByStage(state, stages, { token }),
    rounds: attemptRounds(state, model?.events ?? model?.row?.events ?? []),
    oneStep: isOneStepRun(state),
    token,
  };
}

/** One gate or loop row, and the command under a waiting one: [{text, at}]. */
export function controlRowLines(row, width) {
  // A loop row heads its rounds, so it carries no clock of its own: the
  // time it passed would sit above the earlier rounds' clocks.
  const clock = row.at && row.type !== 'loop' ? clockText(row.at) : '     ';
  const glyph = ROLE_COLOUR[row.role] ? tint(row.glyph, ROLE_COLOUR[row.role]) : dim(row.glyph);
  const lines = [{ text: cut(` ${dim(clock)}  ${glyph} ${row.text}`, width), at: row.at }];
  if (row.command) lines.push({ text: cut(`        ${dim('continue:')} ${row.command}`, width), at: row.at });
  return lines;
}

/** The answer line under an attempt, or null when its step declares none. */
export function attemptAnswerLine(state, attempt, width) {
  const fact = attemptAnswerFact(state, attempt);
  if (!fact) return null;
  return cut(`        ${fact.ok ? dim(fact.text) : tint(fact.text, 'red')}`, width);
}

/** ` · round 2` after a loop body step's id, or '' outside a loop. */
export function roundTag(facts, attempt) {
  const round = facts?.rounds?.get(attempt?.id)?.round;
  return round ? ` · round ${round}` : '';
}
