import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { parseAttemptStream, taskStepModel, toolCallUpdates } from '../src/workflow/step-model.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const connector = JSON.parse(readFileSync(join(repo, 'src/providers/grok/connector.json'), 'utf8'));

// Real capture: run muakbr, `verify` attempt 3 on grok 1.0.13 (grok-4.6),
// 2026-09-21 03:24–03:38Z, scrubbed with the Scrubber of
// scripts/build-test-home.mjs. 575 events: 85 tool_call, 197 tool_call_update
// (all captured as the nameless `agent`), 264 text, 28 usage, one `end`, and
// the stream's own truncation marker after seq 293 (86 events dropped).
const stream = join(repo, 'tests/fixtures/streams/grok-verify-2026-09-21.jsonl');
const NOW = Date.parse('2026-09-21T04:00:00.000Z');
const GAP_AFTER_SEQ = 293;

function grokStep(expandedTurn = null) {
  return taskStepModel({
    id: 'grok-verify', pool: 'grok', model: 'grok-4.6', ok: true,
    startedAt: '2026-09-21T03:24:00.000Z', endedAt: '2026-09-21T03:38:16.000Z', streamFile: stream,
  }, { nowMs: NOW, expandedTurn });
}

/** Every tool row of every turn, each turn opened in turn. */
function allToolRows() {
  const base = grokStep();
  return base.presentation.activity.turns.flatMap((turn) => (
    grokStep(turn.index).presentation.activity.turns.find((entry) => entry.index === turn.index).toolRows
  ));
}

test('grok captures tool_call_update as a result of its call, never the nameless `agent`', () => {
  const events = [];
  const decoder = createAgentEventDecoder(connector.eventStream, { onEvent: (event) => events.push(event) });
  decoder.push(readFileSync(join(repo, 'tests/fixtures/stream/grok.jsonl'), 'utf8'), 'stdout', '2026-09-19T17:30:00.000Z');
  decoder.finish('2026-09-19T17:30:02.000Z');
  const call = events.find((event) => event.providerType === 'tool_call');
  const updates = events.filter((event) => event.providerType === 'tool_call_update');
  assert.equal(call.kind, 'run_terminal_command');
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map((event) => [event.kind, event.toolCallId]), updates.map(() => ['tool', call.toolCallId]));
  assert.ok(!events.some((event) => event.kind === 'agent'));
  // The update rule is the only one that changed kind; the call keeps its name.
  assert.deepEqual(connector.eventStream.toolKinds, {
    run_terminal_command: 'command', read_file: 'read', write: 'edit', search_replace: 'edit', grep: 'search', list_dir: 'search',
  });
});

test('grok tool_call_update events fold into the tool_call with the same id: one named row per call, each counted once', () => {
  const parsed = parseAttemptStream(stream);
  assert.equal(parsed.events.length, 575);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.dropped, 86);
  const calls = parsed.events.filter((event) => event.providerType === 'tool_call');
  const updateEvents = parsed.events.filter((event) => event.providerType === 'tool_call_update');
  assert.equal(calls.length, 85);
  assert.equal(updateEvents.length, 197);
  assert.ok(updateEvents.every((event) => event.kind === 'agent' && event.toolName === undefined));
  // Before the gap the stream holds 49 calls and 94 updates: before 0.35.2
  // those 94 printed as 94 extra nameless `agent` rows (116 across the file).
  assert.equal(calls.filter((event) => event.seq <= GAP_AFTER_SEQ).length, 49);
  assert.equal(updateEvents.filter((event) => event.seq <= GAP_AFTER_SEQ).length, 94);

  // Every update folds into the call that carries its id.
  const byIndex = new Map(parsed.events.map((event) => [event.index, event]));
  const updates = toolCallUpdates(parsed.events);
  for (const [update, call] of updates) {
    assert.equal(byIndex.get(call).providerType, 'tool_call');
    assert.equal(byIndex.get(call).toolCallId, byIndex.get(update).toolCallId);
  }

  const rows = allToolRows();
  assert.equal(rows.length, 85, 'one row per tool call');
  assert.equal(rows.filter((row) => row.kind === 'agent').length, 0, 'no nameless agent row');
  // Each row is named after its call and stands for it once.
  const callByIndex = new Map(calls.map((event) => [event.index, event]));
  assert.ok(rows.every((row) => callByIndex.get(row.index)?.toolName === row.kind), 'every row is a tool_call, named after it');
  assert.equal(new Set(rows.map((row) => callByIndex.get(row.index).toolCallId)).size, 85);
  assert.equal(rows.filter((row) => byIndex.get(row.index).seq <= GAP_AFTER_SEQ).length, 49);

  // The call takes its status and result from the completion that closes it:
  // 81 calls completed; the 4 opened just before the gap lost theirs to it.
  const step = grokStep();
  const pairs = step.activity.pairs;
  assert.equal(pairs.length, 81);
  for (const pair of pairs) {
    const start = byIndex.get(pair.startIndex);
    const complete = byIndex.get(pair.completeIndex);
    assert.equal(start.providerType, 'tool_call');
    assert.equal(complete.toolCallId, start.toolCallId);
    assert.equal(complete.status, 'completed');
    assert.ok(complete.result && typeof complete.result === 'object');
  }
  const unpaired = calls.filter((event) => !pairs.some((pair) => pair.startIndex === event.index));
  assert.deepEqual(unpaired.map((event) => event.seq), [282, 286, 288, 290]);

  // The detail view reaches every captured event: a call's row stands for the
  // call, its updates and its completion (the backgrounded command at seq 457
  // kept streaming after grok completed it: 20 captures, one row), and the
  // update whose call the gap dropped (seq 380) sits with its turn head.
  const detail = taskStepModel({
    id: 'grok-verify', pool: 'grok', model: 'grok-4.6', ok: true,
    startedAt: '2026-09-21T03:24:00.000Z', endedAt: '2026-09-21T03:38:16.000Z', streamFile: stream,
  }, { nowMs: NOW, view: 'detail' }).presentation.activity;
  const reached = new Set();
  for (const turn of detail.turns) {
    for (const index of turn.headEventIndices) reached.add(index);
    for (const row of turn.toolRows) for (const index of row.eventIndices) reached.add(index);
  }
  for (const index of detail.prelude?.headEventIndices ?? []) reached.add(index);
  for (const row of detail.prelude?.toolRows ?? []) for (const index of row.eventIndices) reached.add(index);
  assert.deepEqual(parsed.events.filter((event) => !reached.has(event.index)).map((event) => event.seq), []);
  const background = detail.turns.flatMap((turn) => turn.toolRows).find((row) => byIndex.get(row.index).seq === 457);
  assert.equal(background.eventIndices.length, 20);
  assert.ok(background.eventIndices.every((index) => byIndex.get(index).toolCallId === byIndex.get(background.index).toolCallId));
  const orphan = parsed.events.find((event) => event.seq === 380);
  assert.ok(detail.turns.some((turn) => turn.headEventIndices.includes(orphan.index)));

  // The counts follow the grok connector's toolKinds, each tool once.
  const total = (field) => step.activity.turns.reduce((sum, turn) => sum + turn.summary[field], 0);
  assert.deepEqual(
    ['commands', 'filesRead', 'searches', 'edits', 'otherTools', 'errors', 'total'].map((field) => total(field)),
    [7, 50, 22, 2, 4, 0, 85],
  );
  for (const turn of step.presentation.activity.turns) assert.doesNotMatch(turn.countsText, /\bagent\b/);
});
