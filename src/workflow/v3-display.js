// What a v3 run shows beyond its steps (0.37.0): each gate and loop as a row
// of its own, the checked answer of each attempt, the loop round an attempt
// ran in, and the command that moves a waiting run. The dashboard (Run, Runs,
// Home) and the mod read these, so the words are the same everywhere.
// Pure: reads state and events, returns plain facts and text.

import { glyphs } from '../lib/glyphs.js';
import { CONTINUED_MARK, CONTINUE_MAX_ROUNDS, controlRecords, describeCondition, parkedWaitingFor, readCondition } from './gates-loops.js';
import { declaredControl, isV3State } from './v3-phases.js';

const ANSWER_CHARS = 160;

function cutText(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// --- gates and loops ------------------------------------------------------------

/** The command that moves one waiting gate or loop. */
export function continueCommand(token, node) {
  return node?.type === 'loop'
    ? `bullswarm workflow continue ${token} ${node.id} --rounds <1-${CONTINUE_MAX_ROUNDS}>`
    : `bullswarm workflow continue ${token} ${node?.id}`;
}

function gateFacts(state, gate, record, token) {
  const g = glyphs();
  const when = gate.when ? describeCondition(gate.when) : null;
  const note = gate.note ? ` · ${gate.note}` : '';
  switch (record?.status) {
    case 'waiting':
      return { glyph: g.waiting, role: 'waiting', text: `gate ${gate.id} · waiting for you${note}`, command: continueCommand(token, { id: gate.id, type: 'gate' }) };
    case 'passed':
      return record.reason === 'when-false'
        ? { glyph: g.ok, role: 'skipped', text: `gate ${gate.id} · skipped · ${when ?? 'its condition'} does not hold` }
        : { glyph: g.ok, role: 'passed', text: `gate ${gate.id} · passed · continued by the caller` };
    case 'blocked':
      return { glyph: g.blocked, role: 'blocked', text: `gate ${gate.id} · blocked · ${record.reason ?? 'a dependency did not succeed'}` };
    default:
      return {
        glyph: g.pending, role: 'pending',
        text: `gate ${gate.id} · waits after ${(gate.dependsOn ?? []).join(', ') || 'its dependencies'}${when ? ` when ${when}` : ''}${note}`,
      };
  }
}

function loopFacts(state, loop, record, token) {
  const g = glyphs();
  const round = record?.round ?? 1;
  const of = record?.maxRounds ?? loop.maxRounds;
  const until = describeCondition(loop.until);
  const holds = readCondition(state, loop.until);
  switch (record?.status) {
    case 'passed':
      return record.reason === 'continued' || holds !== true
        ? { glyph: CONTINUED_MARK, role: 'passed', text: `loop ${loop.id} · continued by the caller after ${round} of ${of} rounds (condition not met)` }
        : { glyph: g.ok, role: 'passed', text: `loop ${loop.id} · passed in round ${round} of ${of} · ${until}` };
    case 'waiting':
      return {
        glyph: g.waiting, role: 'waiting',
        text: `loop ${loop.id} · out of rounds (${round} of ${of}) · ${until} did not hold`,
        command: continueCommand(token, { id: loop.id, type: 'loop' }),
      };
    case 'blocked':
      return { glyph: g.blocked, role: 'blocked', text: `loop ${loop.id} · blocked in round ${round} of ${of} · ${record.reason ?? 'a step did not succeed'}` };
    default: {
      // Between rounds the condition read is the last round's: it did not hold.
      const last = round > 1 ? ` · round ${round - 1}: did not hold` : '';
      return { glyph: g.retry, role: 'pending', text: `loop ${loop.id} · round ${round} of ${of} · until ${until}${last}` };
    }
  }
}

/**
 * Every gate and loop of a v3 run as a display row:
 * [{id, type, status, at, glyph, role, text, command?, steps (loop body),
 *   dependsOn (gate)}]. Empty for a v2 run or a v3 run with neither.
 */
export function controlRows(state, { token = state?.shortId ?? state?.runId ?? '<run>' } = {}) {
  if (!isV3State(state)) return [];
  const { gates, loops } = declaredControl(state);
  if (!gates.length && !loops.length) return [];
  const records = new Map(controlRecords(state).map((record) => [record.id, record]));
  return [
    ...loops.map((loop) => {
      const record = records.get(loop.id);
      return { id: loop.id, type: 'loop', status: record?.status ?? 'pending', at: record?.at ?? null, steps: [...(loop.steps ?? [])], ...loopFacts(state, loop, record, token) };
    }),
    ...gates.map((gate) => {
      const record = records.get(gate.id);
      return { id: gate.id, type: 'gate', status: record?.status ?? 'pending', at: record?.at ?? null, dependsOn: [...(gate.dependsOn ?? [])], ...gateFacts(state, gate, record, token) };
    }),
  ];
}

/**
 * Which stage each gate and loop row belongs to: a loop heads the stage of
 * its first body step; a gate heads the stage of the first step behind it, or
 * closes the stage of its latest dependency when no step waits on it.
 * Returns Map(stageId -> {before: rows, after: rows}).
 */
export function controlRowsByStage(state, stages, options = {}) {
  const rows = controlRows(state, options);
  const placed = new Map((stages ?? []).map((stage) => [stage.id, { before: [], after: [] }]));
  if (!rows.length) return placed;
  const stageOf = (id) => (stages ?? []).find((stage) => (stage.actionIds ?? []).includes(id)) ?? null;
  const loopBody = new Map(rows.filter((row) => row.type === 'loop').map((row) => [row.id, row.steps]));
  const program = state.program?.actions ?? [];
  const stepsBehind = (id) => program.filter((step) => (step.dependsOn ?? []).includes(id)).map((step) => step.id);
  // A dependency that is a loop or gate stands for its own place.
  const anchorStep = (id, seen = new Set()) => {
    if (seen.has(id)) return null;
    seen.add(id);
    if (stageOf(id)) return id;
    if (loopBody.has(id)) return loopBody.get(id).at(-1) ?? null;
    const gate = rows.find((row) => row.type === 'gate' && row.id === id);
    return gate ? gate.dependsOn.map((dep) => anchorStep(dep, seen)).filter(Boolean).at(-1) ?? null : null;
  };
  const indexOf = (stage) => (stages ?? []).indexOf(stage);
  for (const row of rows) {
    if (row.type === 'loop') {
      const stage = stageOf(row.steps[0]);
      if (stage) placed.get(stage.id).before.push(row);
      continue;
    }
    const behind = stepsBehind(row.id).map(stageOf).filter(Boolean).sort((a, b) => indexOf(a) - indexOf(b))[0];
    if (behind) { placed.get(behind.id).before.push(row); continue; }
    const deps = row.dependsOn.map((dep) => stageOf(anchorStep(dep))).filter(Boolean).sort((a, b) => indexOf(a) - indexOf(b));
    if (deps.length) placed.get(deps.at(-1).id).after.push(row);
  }
  return placed;
}

// --- answers --------------------------------------------------------------------

/**
 * One attempt's checked answer as a display fact, or null for a step that
 * declares no answer or an attempt that recorded no check:
 * {ok: true, text: 'answer {"lines":4}'} or
 * {ok: false, text: 'answer check failed · <first error>'}.
 */
export function attemptAnswerFact(state, attempt) {
  const definition = (state?.program?.actions ?? []).find((action) => action.id === attempt?.actionId);
  if (definition?.answer === undefined) return null;
  const answer = attempt?.answer;
  if (!answer || typeof answer !== 'object') return null;
  if (answer.ok === true && answer.value !== undefined) {
    return { ok: true, text: `answer ${cutText(JSON.stringify(answer.value), ANSWER_CHARS)}` };
  }
  const first = Array.isArray(answer.errors) && answer.errors.length ? answer.errors[0] : null;
  const why = typeof first === 'string' ? first : first?.message ?? (answer.value === undefined ? 'no answer file' : 'does not match the schema');
  return { ok: false, text: `answer check failed · ${cutText(why, ANSWER_CHARS)}` };
}

/**
 * The loop round each attempt of a loop body ran in, from the run's
 * loop.round events: Map(attemptId -> {loopId, round}). Empty for a run with
 * no loop.
 */
export function attemptRounds(state, events = []) {
  const out = new Map();
  const { loops } = declaredControl(state);
  if (!isV3State(state) || !loops.length) return out;
  for (const loop of loops) {
    const starts = (events ?? [])
      .filter((event) => event?.type === 'loop.round' && event.payload?.loopId === loop.id)
      .map((event) => Date.parse(event.committedAt ?? ''))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (const attempt of state.attempts ?? []) {
      if (!loop.steps.includes(attempt.actionId)) continue;
      const at = Date.parse(attempt.startedAt ?? '');
      if (!Number.isFinite(at)) continue;
      out.set(attempt.id, { loopId: loop.id, round: 1 + starts.filter((start) => start <= at).length });
    }
  }
  return out;
}

// --- a waiting run ----------------------------------------------------------------

/**
 * A parked run's waiting nodes in words, or null for a run that is not
 * waiting: {label: 'waiting at gate approve', nodes, commands}.
 */
export function waitingFacts(state, { token = state?.shortId ?? state?.runId ?? '<run>' } = {}) {
  const nodes = parkedWaitingFor(state);
  if (!nodes) return null;
  const named = nodes.map((node) => (node.type === 'loop' ? `loop ${node.id} (out of rounds)` : `gate ${node.id}`));
  return {
    label: `waiting at ${named.join(', ')}`,
    nodes,
    commands: nodes.map((node) => continueCommand(token, node)),
  };
}
