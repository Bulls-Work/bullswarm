import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { createAttemptStreamSink } from '../src/lib/attempt-stream.js';
import { argvWithModel } from '../src/lib/watch.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
// A first-class template ships in src/providers/, a contrib one in providers/contrib/.
const connector = (name) => {
  const firstClass = join(REPO, 'src', 'providers', name, 'connector.json');
  const file = existsSync(firstClass) ? firstClass : join(REPO, 'providers', 'contrib', name, 'connector.json');
  return JSON.parse(readFileSync(file, 'utf8'));
};

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
  return { actions, progress, output: decoder.output(), usage: decoder.usage() };
}

const VENDOR_LINES = {
  codex: [
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'pwd' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'pwd' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'DONE' } },
  ],
  'claude-code': [
    { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE' }] } },
    {
      type: 'result',
      result: 'DONE',
      session_id: 'claude-session-1',
      total_cost_usd: 0.61388,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
        output_tokens: 6,
      },
    },
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
  opencode: [
    { type: 'tool_use', part: { callID: 't1', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' } } } },
    { type: 'text', part: { id: 'r1', text: 'DONE' } },
  ],
};

test('connector adapters normalize semantic tool and response actions', () => {
  const fixtures = VENDOR_LINES;

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

test('Claude result usage is decoded once with provider cost and session id', () => {
  const decoded = decode('claude-code', VENDOR_LINES['claude-code']);
  assert.deepEqual(decoded.usage, {
    sessionId: 'claude-session-1',
    costUsd: 0.61388,
    standardRead: 2,
    cacheRead: 3,
    cacheWrite5m: 4,
    cacheWrite1h: 5,
    output: 6,
  });
});

test('event stream CLI flags are connector-owned and appended to direct argv', () => {
  for (const name of ['codex', 'claude-code', 'grok', 'command-code', 'opencode']) {
    const definition = connector(name);
    const argv = argvWithModel(definition, { taskFile: '/tmp/task.md', cwd: '/tmp' });
    for (const arg of definition.eventStream.args) assert.ok(argv.includes(arg), `${name}: ${arg}`);
  }
});

test('each vendor line shape persists as jsonl with seq/at/source/providerType/kind/status/summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-vendor-stream-'));
  try {
    for (const [name, rows] of Object.entries(VENDOR_LINES)) {
      const streamFile = join(dir, `${name}.jsonl`);
      const sink = createAttemptStreamSink({
        streamFile,
        now: () => '2026-08-28T01:00:00.000Z',
      });
      const decoder = createAgentEventDecoder(connector(name).eventStream, {
        onEvent: (event, full) => sink.event(event, full),
      });
      decoder.push(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'stdout', '2026-08-28T01:00:00.000Z');
      decoder.finish('2026-08-28T01:00:01.000Z');
      const stats = sink.close();
      const persisted = readFileSync(streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.ok(persisted.length >= 1, name);
      assert.equal(persisted[0].seq, 1, name);
      assert.ok(persisted.some((row) => row.kind === 'response'), `${name} response`);
      assert.ok(persisted.some((row) => row.summary === 'pwd' || row.kind === 'response'), `${name} command or response`);
      assert.equal(stats.streamFile, streamFile);
      for (const row of persisted) {
        if (row.truncated) continue;
        for (const key of ['seq', 'at', 'source', 'providerType', 'kind', 'status', 'summary']) {
          assert.ok(Object.hasOwn(row, key), `${name} missing ${key}`);
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('onEvent keeps the compact pane summary and hands full response text as the second argument', () => {
  const long = `Completed the requested work. ${'x'.repeat(250)}`;
  const pane = [];
  const fulls = [];
  const decoder = createAgentEventDecoder({
    format: 'jsonl',
    rules: [{
      rootMatch: { path: 'type', equals: 'response' },
      kind: 'response',
      summaryPaths: ['text'],
      status: 'completed',
    }],
  }, {
    onEvent: (event, full) => { pane.push(event); fulls.push(full); },
  });
  decoder.push(`${JSON.stringify({ type: 'response', text: long })}\n`);
  decoder.finish();
  assert.equal(pane.length, 1);
  assert.equal(pane[0].kind, 'response');
  assert.equal(pane[0].summary.length, 180);
  assert.equal(pane[0].summary.endsWith('\u2026'), true);
  assert.equal(fulls[0], long);
});
