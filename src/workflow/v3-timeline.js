// The Run timeline's extra rows for a v3 run (0.37.0): a gate or loop row in
// the phase it heads or closes, with the continue command under a waiting
// one; the checked answer under each attempt; the loop round an attempt ran
// in. run-view.js calls these from its phase renderer; a v2 run gets null and
// its timeline is unchanged.

import { cut } from './dash-kit.js';
import { clockText } from './dashboard-value-text.js';
import { dimText, tint, visibleLength } from './dashboard-ansi.js';
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

// Words wrapped to `room` columns; a word longer than the room is cut.
function wrapWords(text, room) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (visibleLength(next) <= room || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.map((entry) => cut(entry, room));
}

/**
 * One gate or loop row, and the command under a waiting one: [{text, at}].
 * A narrow page wraps them rather than cutting: the command is what the row
 * is read for.
 */
export function controlRowLines(row, width) {
  // A loop row heads its rounds, so it carries no clock of its own: the
  // time it passed would sit above the earlier rounds' clocks.
  const clock = row.at && row.type !== 'loop' ? clockText(row.at) : '     ';
  const glyph = ROLE_COLOUR[row.role] ? tint(row.glyph, ROLE_COLOUR[row.role]) : dim(row.glyph);
  const indent = '        ';
  const room = Math.max(10, width - indent.length);
  // The first row also carries the clock and the glyph: two more columns.
  const lines = wrapWords(row.text, room - 2).map((text, index) => ({
    text: index ? `${indent}${text}` : ` ${dim(clock)}  ${glyph} ${text}`, at: row.at,
  }));
  if (row.command) {
    const label = 'continue:';
    const whole = `${label} ${row.command}`;
    const parts = visibleLength(whole) <= room ? [whole] : [label, ...wrapWords(row.command, room)];
    for (const part of parts) {
      lines.push({ text: `${indent}${part.startsWith(label) ? `${dim(label)}${part.slice(label.length)}` : part}`, at: row.at });
    }
  }
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
