import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { argvWithModel } from '../src/lib/watch.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const connector = (name) => JSON.parse(readFileSync(join(REPO, 'connectors', `${name}.json`), 'utf8'));

function decode(name, rows) {
  const actions = [];
  const progress = [];
  const decoder = createAgentEventDecoder(connector(name).eventStream, {
    onEvent: (event) => actions.push(event),
    onProgress: (event) => progress.push(event),
  });
  const payload = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  // Deliberately split inside a JSON object to prove chunk boundaries are safe.
  decoder.push(payload.slice(0, 37), 'stdout', '2026-08-28T01:00:00.000Z');
  decoder.push(payload.slice(37), 'stdout', '2026-08-28T01:00:01.000Z');
  decoder.finish();
  return { actions, progress, output: decoder.output() };
}

test('connector adapters normalize semantic tool and response actions', () => {
  const fixtures = {
    codex: [
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'pwd' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'pwd' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'DONE' } },
    ],
    'claude-code': [
      { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE' }] } },
      { type: 'result', result: 'DONE' },
    ],
    grok: [
      { type: 'text', data: 'I will run it. ' },
      { type: 'tool_call', toolCallId: 't1', toolName: 'run_terminal_command', status: 'pending', rawInput: { command: 'pwd' } },
      { type: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { command: 'pwd' } },
      { type: 'text', data: 'DO' }, { type: 'text', data: 'NE' },
    ],
    'command-code': [
      { type: 'event', event: { type: 'model_request_start', model: 'gpt-5.6-sol' } },
      { type: 'event', event: { type: 'tool_queued', toolCallId: 't1', toolName: 'shell_command', input: { command: 'pwd' } } },
      { type: 'event', event: { type: 'tool_completed', toolCallId: 't1', toolName: 'shell_command' } },
      { type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'DONE' }] } },
      { type: 'result', finalText: 'DONE' },
    ],
    opencode2: [
      { type: 'tool_use', part: { callID: 't1', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' } } } },
      { type: 'text', part: { id: 'r1', text: 'DONE' } },
    ],
  };

  for (const [name, rows] of Object.entries(fixtures)) {
    const decoded = decode(name, rows);
    assert.ok(decoded.progress.length >= rows.length, `${name} progress`);
    assert.ok(decoded.actions.some((event) => event.summary === 'pwd'), `${name} command`);
    assert.ok(decoded.actions.some((event) => event.kind === 'response'), `${name} response`);
    assert.match(decoded.output, /DONE/, `${name} final output`);
    if (name === 'claude-code') assert.ok(decoded.progress.some((event) => event.model === 'claude-sonnet-5'));
    if (name === 'command-code') assert.ok(decoded.progress.some((event) => event.model === 'gpt-5.6-sol'));
  }
});

test('event stream CLI flags are connector-owned and appended to direct argv', () => {
  for (const name of ['codex', 'claude-code', 'grok', 'command-code', 'opencode2']) {
    const definition = connector(name);
    const argv = argvWithModel(definition, { taskFile: '/tmp/task.md', cwd: '/tmp' });
    for (const arg of definition.eventStream.args) assert.ok(argv.includes(arg), `${name}: ${arg}`);
  }
});
