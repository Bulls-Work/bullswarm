// Typed answers for `bullswarm run`: the caller hands a JSON Schema, the worker
// is told to write its final answer as JSON to a file, and the verdict carries
// the parsed answer plus the schema check. No retry: a missing or invalid
// answer exits 1 and the caller decides what to do next.
//
// The check is the stage-2 validator (workflow/schema-check.js), so a run and a
// workflow step accept exactly the same schema subset.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkSchemaFiles, schemaSubsetIssues, SCHEMA_MAX_SCHEMA_BYTES, unwrapOneFence,
} from '../workflow/schema-check.js';
import { EMPTY_OUTPUT, NO_SUBSTANCE } from './verify.js';

const NOT_REWRITTEN = 'answer file not rewritten by this run';

/**
 * Read and vet the schema before routing, so a bad schema is a usage error and
 * never a dispatched worker whose answer cannot be checked. Returns `{ text }`
 * (the schema, pretty-printed) or `{ error }`.
 */
export function loadAnswerSchema(file) {
  let text;
  try { text = readFileSync(resolve(file), 'utf8'); } catch (err) {
    return { error: `--answer-schema unreadable: ${err.message}` };
  }
  if (Buffer.byteLength(text) > SCHEMA_MAX_SCHEMA_BYTES) {
    return { error: '--answer-schema too large (limit 1 MiB)' };
  }
  let schema;
  try { schema = JSON.parse(text); } catch (err) {
    return { error: `--answer-schema is not JSON: ${err.message}` };
  }
  const issues = schemaSubsetIssues(schema);
  if (issues.length) return { error: `--answer-schema: ${issues[0].message}` };
  return { text: JSON.stringify(schema, null, 2) };
}

/** The section appended to the worker's task text. */
export function answerInstruction(schemaText, answerFile) {
  return [
    '',
    '---',
    '## Required: typed final answer',
    `When you are done, write your final answer as a single JSON value to this file: ${answerFile}`,
    'The file must contain only JSON (no prose, no code fence) and must satisfy this JSON Schema:',
    '```json',
    schemaText,
    '```',
    'Write the file even if you also answer in prose.',
    '',
  ].join('\n');
}

/** When the file was last written, or null when there is no file. */
export function answerFileMtime(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

/**
 * After the worker exits: read, parse and schema-check the answer file.
 * Returns `{ answer, answerCheck: { ok, errors, file, why } }`. `answer` is the
 * parsed value even when it breaks the schema, and null when there is nothing
 * to parse. A file that existed before the run (`mtimeBefore`) and was not
 * written since is stale, never an answer.
 */
export function checkAnswer({ answerFile, schemaFile, mtimeBefore = null }) {
  if (mtimeBefore != null && answerFileMtime(answerFile) === mtimeBefore) {
    return { answer: null, answerCheck: { ok: false, errors: [NOT_REWRITTEN], file: answerFile, why: NOT_REWRITTEN } };
  }
  const result = checkSchemaFiles({ file: answerFile, schema: schemaFile, format: 'json', unfence: true });
  // Exit 2 is "could not check": missing, unreadable, not JSON, or too large.
  let answer = null;
  if (result.exit !== 2) {
    try {
      const raw = readFileSync(answerFile, 'utf8');
      answer = JSON.parse(unwrapOneFence(raw) ?? raw);
    } catch { answer = null; }
  }
  const ok = result.exit === 0;
  return {
    answer,
    answerCheck: {
      ok,
      errors: result.errors.length ? result.errors : (ok ? [] : [result.why]),
      file: answerFile,
      why: ok ? null : result.why,
      ...(result.notes.length ? { notes: result.notes } : {}),
    },
  };
}

/**
 * The worker failed only the prose gate: it exited 0 and its reply was empty
 * or had no result in it. With a typed answer the result is the answer file,
 * so a terse reply beside a valid answer is not a failure. A non-zero exit,
 * failure words, a limit or a sign-in failure still fail the worker.
 */
function failedOnlyOnProse(verdict) {
  return verdict.ok === false
    && verdict.failureKind == null
    && verdict.meta?.exitCode === 0
    && (verdict.why === EMPTY_OUTPUT || verdict.why === NO_SUBSTANCE);
}

/**
 * Fold the answer check into the worker's verdict. `ok` needs both; `workerOk`
 * keeps the worker's own verdict as a separate fact. A worker that already
 * failed keeps its own `why`, because that is the cause to act on, unless the
 * only failure was a thin reply and the answer passed its check.
 */
export function withAnswerCheck(verdict, { answer, answerCheck }) {
  if (answerCheck.ok && failedOnlyOnProse(verdict)) {
    return { ...verdict, ok: true, workerOk: true, why: `answer valid (reply: ${verdict.why})`, answer, answerCheck };
  }
  const out = { ...verdict, workerOk: verdict.ok, answer, answerCheck };
  if (verdict.ok && !answerCheck.ok) {
    out.ok = false;
    out.why = [`answer check failed (${answerCheck.why})`, verdict.why].filter(Boolean).join(' · ');
  }
  return out;
}
