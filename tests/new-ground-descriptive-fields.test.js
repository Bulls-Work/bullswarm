// New ground ignores descriptive fields the model rewrites on every call:
// a Bash `description`, a Task `description`, a `timeout` or `run_in_background`
// never change what the call does, so a worker that repeats the same command
// with a reworded description is not making new ground. Run through the REAL
// packaged claude-code connector, as tests/new-ground-real-connector.test.js does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { createNewGroundTracker } from '../src/lib/new-ground.js';

const EVENT_STREAM = JSON.parse(
  readFileSync(new URL('../src/providers/claude-code/connector.json', import.meta.url), 'utf8'),
).eventStream;

const toolUse = (n, name, input) => JSON.stringify({
  type: 'assistant', uuid: `u${n}`,
  message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name, input }] },
});

// Feeds calls one per clock tick and returns lastAt() after each.
function lastAtAfterEach(calls) {
  let clock = 0;
  const tracker = createNewGroundTracker({ cwd: '/work', startedAtMs: 0, now: () => clock });
  const decoder = createAgentEventDecoder(EVENT_STREAM, { onEvent: (event, full) => tracker.observe(event, full) });
  return calls.map(([name, input], i) => {
    clock = (i + 1) * 1000;
    decoder.push(`${toolUse(i, name, input)}\n`);
    return tracker.lastAt();
  });
}

test('Bash with the same command and a reworded description is not new ground after the first', () => {
  const calls = ['attempt 1', 'attempt 2', 'attempt 3'].map((description) => ['Bash', { command: 'cat a.js', description }]);
  assert.deepEqual(lastAtAfterEach(calls), [1000, 1000, 1000]);
});

test('Task with the same prompt and a reworded description is not new ground after the first', () => {
  const calls = ['d1', 'd2'].map((description) => ['Task', { prompt: 'do x', subagent_type: 'Explore', description }]);
  assert.deepEqual(lastAtAfterEach(calls), [1000, 1000]);
});

test('Bash with a different command is new ground even when the description repeats', () => {
  const calls = [
    ['Bash', { command: 'cat a.js', description: 'read' }],
    ['Bash', { command: 'cat b.js', description: 'read' }],
  ];
  assert.deepEqual(lastAtAfterEach(calls), [1000, 2000]);
});

test('timeout and run_in_background do not make a repeated Bash call new ground', () => {
  const calls = [
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'npm test', timeout: 60000 }],
    ['Bash', { command: 'npm test', run_in_background: true }],
  ];
  assert.deepEqual(lastAtAfterEach(calls), [1000, 1000, 1000]);
});
