// Grok's final usage, decoded from a real stream.
//
// tests/fixtures/stream/grok-capture.jsonl is a real one-line run of the argv
// the grok connector spawns (`grok -p <taskFile> --model grok-4.6 --session-id
// <uuid> --output-format streaming-json`, grok 1.0.13, 2026-09-21), scrubbed
// with scripts/build-test-home.mjs's Scrubber: prose, thoughts and tool output
// are placeholder text, owner paths are /home/dev/…, and the owner's installed
// tool and command names on the `available_commands` lines are numbered
// placeholders (no connector rule reads those lines). Every id, count and cost
// is as the provider wrote it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { attemptCapture, watchOnce } from '../src/lib/watch.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = join(REPO_ROOT, 'tests/fixtures/stream/grok-capture.jsonl');
const OLDER = join(REPO_ROOT, 'tests/fixtures/stream/grok.jsonl');
const grok = () => JSON.parse(readFileSync(join(REPO_ROOT, 'src/providers/grok/connector.json'), 'utf8'));
const rows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function decode(file) {
  const decoder = createAgentEventDecoder(grok().eventStream);
  decoder.push(readFileSync(file, 'utf8'));
  decoder.finish();
  return decoder.usage();
}

test('the real grok end line decodes to its session id, cost and exclusive token classes', () => {
  assert.deepEqual(decode(CAPTURE), {
    sessionId: 'e234e1cf-0e09-410a-b3dd-b47698e29c62',
    costUsd: 0.0590206,
    standardRead: 85680,
    cacheRead: 1280,
    cacheWrite: 0,
    // output_tokens 265 includes reasoning_tokens 156.
    output: 109,
    reasoning: 156,
  });
});

test('grok input excludes cache reads and output includes reasoning, as observed on the real stream', () => {
  const stream = rows(CAPTURE);
  const end = stream.find((row) => row.type === 'end');
  const requests = stream.filter((row) => row.type === 'usage').map((row) => row.usage);
  assert.equal(requests.length, 2);
  // The end line is the sum of the per-request usage lines.
  for (const field of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'reasoning_tokens']) {
    assert.equal(requests.reduce((sum, usage) => sum + usage[field], 0), end.usage[field], field);
  }
  // total_tokens adds cache reads to input (so input excludes them) and does
  // not add reasoning on top of output (so output already includes it).
  assert.equal(end.usage.input_tokens + end.usage.cache_read_input_tokens + end.usage.output_tokens, end.usage.total_tokens);
  // The second request's only visible text was the one word `DONE`: its
  // output count is its reasoning count plus that word.
  const texts = stream.filter((row) => row.type === 'text').map((row) => row.data);
  assert.equal(texts.at(-1), 'DONE');
  assert.deepEqual([requests[1].output_tokens, requests[1].reasoning_tokens], [124, 123]);
});

test('the capture block carries what grok reported and its token total equals the provider total', () => {
  const connector = grok();
  const capture = attemptCapture(connector, { exitCode: 0, signal: null, reportedUsage: decode(CAPTURE) }, {
    model: 'grok-4.6',
    conversation: { sessionId: 'e234e1cf-0e09-410a-b3dd-b47698e29c62', resume: false },
    at: '2026-09-21T05:40:00.000Z',
  });
  assert.deepEqual(capture, {
    capturedAt: '2026-09-21T05:40:00.000Z',
    source: 'event-stream',
    providerSessionId: 'e234e1cf-0e09-410a-b3dd-b47698e29c62',
    sessionSource: 'provider-stream',
    model: 'grok-4.6',
    tokens: {
      standardRead: 85680,
      cacheRead: 1280,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: 0,
      output: 109,
      reasoning: 156,
      totalKnown: 87225,
    },
    tokenSource: 'provider-reported',
    providerCostUsd: 0.0590206,
    exitCode: 0,
    signal: null,
  });
  const end = rows(CAPTURE).find((row) => row.type === 'end');
  assert.equal(capture.tokens.totalKnown, end.usage.total_tokens);
});

test('the older grok fixture decodes the same way', () => {
  const capture = attemptCapture(grok(), { exitCode: 0, reportedUsage: decode(OLDER) }, { model: 'grok-4.6' });
  assert.equal(capture.providerSessionId, '01a0bab7-596a-73d2-9a39-979da77755b8');
  assert.equal(capture.providerCostUsd, 0.03546948);
  assert.deepEqual(
    [capture.tokens.standardRead, capture.tokens.cacheRead, capture.tokens.output, capture.tokens.reasoning, capture.tokens.totalKnown],
    [41373, 42240, 35, 41, 83689],
  );
});

test('a grok attempt replaying the real stream is provider-reported and captured at worker exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-grok-capture-'));
  try {
    const connector = grok();
    // The real connector with its binary swapped for a replay of the stream;
    // `--` hands the model and session flags it appends to the replay script.
    connector.spawn = {
      ...connector.spawn,
      cmd: [process.execPath, '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(CAPTURE)}, 'utf8'))`, '--'],
    };
    connector.eventStream = { ...connector.eventStream, args: [] };
    const captures = [];
    let transcriptReads = 0;
    const verdict = await watchOnce(connector, 'Reply with one word.', dir, {
      taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md'),
    }, {
      model: 'grok-4.6',
      // A throwaway home and no meter reads: the test never touches a real one.
      home: dir,
      snapshotPool: async () => null,
      readTranscriptUsage: () => { transcriptReads += 1; return null; },
      onCapture: (capture) => captures.push(capture),
    });
    assert.equal(captures.length, 1);
    assert.equal(transcriptReads, 0, 'a provider-reported attempt never needs its transcript');
    assert.equal(verdict.meta.usage.tokenSource, 'provider-reported');
    assert.equal(verdict.meta.usage.sessionId, 'e234e1cf-0e09-410a-b3dd-b47698e29c62');
    assert.deepEqual(verdict.meta.usage.tokens, captures[0].tokens);
    assert.deepEqual(verdict.meta.capture, captures[0]);
    assert.equal(captures[0].providerCostUsd, 0.0590206);
    assert.equal(captures[0].exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
