// Answers for program v3 steps (0.37.0), ported from the flex branch's
// src/lib/answer.js (proven live there with no false failures, where the
// final-response convention failed correct runs).
//
// A step that declares an `answer` (a JSON schema) is told to write its final
// answer as JSON to answer-<attempt>.json, next to the attempt's output file.
// The check runs inside watchOnce's outputValidator hook, so a mismatch is
// failure kind `schema` and the dispatcher's same-pool correction (worded for
// the answer here) shares the step's one retry. The parsed answer is stored on
// the attempt (`answer`), and on the step as its current answer once the step
// succeeds.
//
// Every v3 step passes by facts only: exit, deliverable, evidence and, when
// declared, the answer. A step without an answer passes an accept-all
// validator, so the prose heuristic (judgeContent) never decides for v3. With
// a validator watchOnce never computes judgeContent's informational flags, so
// "no output" and "no changes" are recorded here, as attempt notes.
//
// The check is the stage-2 schema checker (schema-check.js), so an answer and
// a schema evidence item accept exactly the same schema subset.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkSchemaFiles, unwrapOneFence } from './schema-check.js';

const NOT_REWRITTEN = 'answer file not rewritten by this run';
const ERRORS_KEPT = 100;

const attemptStem = (outFile) => basename(outFile).replace(/^out-/, '').replace(/\.[^.]+$/, '');

/** answer-<step>-attempt-<n>.json, next to out-<step>-attempt-<n>.md. */
export function answerFileFor(outFile) {
  return join(dirname(outFile), `answer-${attemptStem(outFile)}.json`);
}

// The step's schema, written beside the answer so the check and a caller
// reading the run folder use the same file.
function answerSchemaFileFor(outFile) {
  return join(dirname(outFile), `answer-${attemptStem(outFile)}.schema.json`);
}

/** The paragraph appended to the attempt's task. */
export function answerInstruction(schemaText, answerFile) {
  return [
    '## Required: typed final answer',
    `When you are done, write your final answer as a single JSON value to this file: ${answerFile}`,
    'The file must contain only JSON (no prose, no code fence) and must satisfy this JSON Schema:',
    '```json',
    schemaText,
    '```',
    'Write the file even if you also answer in prose. Bullswarm checks the file, not your reply.',
  ].join('\n');
}

function answerFileMtime(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Read, parse and schema-check an answer file. Returns
 * `{ answer, answered, answerCheck: { ok, errors, file, why } }`. `answer` is
 * the parsed value even when it breaks the schema, and null when there is
 * nothing to parse. A file that existed before the attempt (`mtimeBefore`)
 * and was not written since is stale, never an answer.
 */
export function checkAnswer({ answerFile, schemaFile, mtimeBefore = null }) {
  if (mtimeBefore != null && answerFileMtime(answerFile) === mtimeBefore) {
    return { answer: null, answered: false, answerCheck: { ok: false, errors: [NOT_REWRITTEN], file: answerFile, why: NOT_REWRITTEN } };
  }
  const result = checkSchemaFiles({ file: answerFile, schema: schemaFile, format: 'json', unfence: true });
  // Exit 2 is "could not check": missing, unreadable, not JSON, or too large.
  let answer = null;
  let answered = false;
  if (result.exit !== 2) {
    try {
      const raw = readFileSync(answerFile, 'utf8');
      answer = JSON.parse(unwrapOneFence(raw) ?? raw);
      answered = true;
    } catch { answer = null; }
  }
  const ok = result.exit === 0;
  return {
    answer,
    answered,
    answerCheck: {
      ok,
      errors: result.errors.length ? result.errors : (ok ? [] : [result.why]),
      file: answerFile,
      why: ok ? null : result.why,
      ...(result.notes.length ? { notes: result.notes } : {}),
    },
  };
}

// The same-pool correction for an answer that failed its check. The next
// attempt's own answer paragraph (with its new file) follows it.
function answerCorrectionTask(verdict, { originalTask }) {
  const errors = verdict?.structured?.errors?.length ? verdict.structured.errors : [verdict?.why ?? 'the answer did not match its schema'];
  return `${originalTask}\n\nYour answer file failed its schema check:\n${errors.map((error) => `- ${error}`).join('\n')}\nWrite a corrected answer to the new answer file named below; keep the rest of your work.`;
}

// The verdict is exit, deliverable and evidence; the reply is not judged.
const acceptAll = () => ({ ok: true, errors: [] });

/**
 * The dispatch hooks for one v3 step. `attempt()` returns the attempt record
 * that is running now; the validator stores the checked answer on it.
 * Returns `{ outputValidator, correctionTask, answerBrief, briefBytes }`:
 * `answerBrief({ files })` names this attempt's answer file (and writes the
 * schema beside it) and returns the task paragraph; `briefBytes()` is what
 * that paragraph added to the task, for the byte ledger.
 */
export function stepAnswerHooks(action, { attempt = () => null } = {}) {
  if (action?.answer === undefined) return { outputValidator: acceptAll, correctionTask: null, answerBrief: null, briefBytes: () => 0 };
  const schemaText = JSON.stringify(action.answer, null, 2);
  let current = null;
  let bytes = 0;
  const answerBrief = ({ files }) => {
    const answerFile = answerFileFor(files.outFile);
    const schemaFile = answerSchemaFileFor(files.outFile);
    writeFileSync(schemaFile, `${schemaText}\n`);
    current = { answerFile, schemaFile, mtimeBefore: answerFileMtime(answerFile) };
    const text = answerInstruction(schemaText, answerFile);
    bytes = Buffer.byteLength(`\n\n${text}`, 'utf8');
    return text;
  };
  const outputValidator = () => {
    if (!current) return { ok: false, errors: ['no answer file was named for this attempt'] };
    const checked = checkAnswer(current);
    const record = {
      file: current.answerFile,
      ok: checked.answerCheck.ok,
      value: checked.answer,
      errors: checked.answerCheck.errors.slice(0, ERRORS_KEPT).map(String),
    };
    const target = attempt();
    if (target) target.answer = record;
    return { ok: record.ok, errors: record.errors, ...(record.ok ? { value: checked.answer } : {}) };
  };
  // The validator reads the answer file, not the reply, so a provider stream
  // error after a valid fresh answer is recovered even when the reply is
  // empty (watchOnce canInspectRecoveredOutput).
  outputValidator.readsFile = true;
  return { outputValidator, correctionTask: answerCorrectionTask, answerBrief, briefBytes: () => bytes };
}

const FLAGS = Object.freeze({
  'no-output': 'the worker gave no text reply',
  'no-changes': 'the worker changed no file',
});

// judgeContent's flags as facts, never as the verdict.
function recordFlags(attempt, action) {
  if (!attempt.finishedAt) return;
  const kinds = [];
  if (attempt.outputBytes === 0) kinds.push('no-output');
  if ((action.lane === 'build' || action.lane === 'chore') && attempt.changedFileCount === 0) kinds.push('no-changes');
  const had = new Set((attempt.notes ?? []).map((note) => note.kind));
  const fresh = kinds.filter((kind) => !had.has(kind)).map((kind) => ({ at: attempt.finishedAt, kind, text: FLAGS[kind] }));
  if (fresh.length) attempt.notes = [...(attempt.notes ?? []), ...fresh];
}

/**
 * After a v3 step's dispatch: record the informational flags on its attempts,
 * and set the step's current answer from the attempt that finished it (or
 * clear it when the step did not succeed).
 */
export function settleStepAnswer(state, runtime, action, result, firstOrdinal = 0) {
  const attempts = state.attempts.filter((item) => item.actionId === action.id && item.ordinal > firstOrdinal);
  for (const attempt of attempts) recordFlags(attempt, action);
  const last = attempts.findLast((item) => item.status === 'succeeded');
  if (result?.ok && action.answer !== undefined && last?.answer?.ok) {
    runtime.answer = { attemptId: last.id, value: JSON.parse(JSON.stringify(last.answer.value)) };
  } else delete runtime.answer;
}

/**
 * The result envelope's `answer` for one step: present only on a step that
 * declares an answer (so v2 and answer-less envelopes keep their shape), the
 * step's current checked answer `{attemptId, value}`, or null when no attempt
 * produced a valid one.
 */
export function resultAnswerField(definition, runtime) {
  if (definition?.answer === undefined) return {};
  const current = runtime?.answer;
  return { answer: current ? { attemptId: current.attemptId, value: JSON.parse(JSON.stringify(current.value)) } : null };
}

/** The issue with a result action's `answer`, or null when it is well formed. */
export function resultAnswerIssue(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return `${name}.answer must be null or an object`;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'attemptId,value') return `${name}.answer must hold exactly attemptId and value`;
  if (typeof value.attemptId !== 'string' || !value.attemptId) return `${name}.answer.attemptId must be a non-empty string`;
  return null;
}
