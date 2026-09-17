import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureLimits,
  clipUtf8,
  createAttemptStreamSink,
  DEFAULT_FILE_BYTES,
  DEFAULT_RESPONSE_BYTES,
} from '../src/lib/attempt-stream.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STAMP = '2026-09-17T00:00:00.000Z';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-attempt-stream-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function parseJsonl(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw === '' ? [] : raw.replace(/\n$/, '').split('\n');
  return { raw, rows: lines.map((line) => JSON.parse(line)) };
}

test('core capture defaults are the numbers named in the connector schema', () => {
  assert.equal(DEFAULT_RESPONSE_BYTES, 64_000);
  assert.equal(DEFAULT_FILE_BYTES, 1_048_576);
  const schema = JSON.parse(readFileSync(join(REPO, 'src/providers/_schema.json'), 'utf8'));
  assert.equal(schema.eventStream.capture.responseBytes, DEFAULT_RESPONSE_BYTES);
  assert.equal(schema.eventStream.capture.fileBytes, DEFAULT_FILE_BYTES);
  assert.match(schema.eventStream['$comment-capture'], /64000/);
  assert.match(schema.eventStream['$comment-capture'], /1048576/);
  assert.deepEqual(captureLimits(undefined), {
    capBytes: DEFAULT_FILE_BYTES,
    responseBytes: DEFAULT_RESPONSE_BYTES,
  });
  assert.deepEqual(captureLimits({ format: 'jsonl' }), {
    capBytes: DEFAULT_FILE_BYTES,
    responseBytes: DEFAULT_RESPONSE_BYTES,
  });
});

test('a manifest capture block overrides the core defaults', () => {
  assert.deepEqual(captureLimits({
    format: 'jsonl',
    capture: { responseBytes: 12, fileBytes: 400 },
  }), { capBytes: 400, responseBytes: 12 });
  // Non-positive or non-integer values are not overrides; core defaults apply.
  assert.deepEqual(captureLimits({ capture: { responseBytes: 0, fileBytes: 1.5 } }), {
    capBytes: DEFAULT_FILE_BYTES,
    responseBytes: DEFAULT_RESPONSE_BYTES,
  });
});

test('clipUtf8 bounds by UTF-8 bytes, not string length', () => {
  assert.equal(clipUtf8('abcd', 4), 'abcd');
  assert.equal(clipUtf8('éééé', 4), 'éé');
  assert.equal(Buffer.byteLength(clipUtf8('éééé', 5), 'utf8'), 4);
  assert.equal(clipUtf8(null, 10), null);
});

test('jsonl under the cap is one object per line with the required fields and no marker', () => {
  const { dir, cleanup } = tmp();
  try {
    const streamFile = join(dir, 'stream.jsonl');
    const sink = createAttemptStreamSink({ streamFile, now: () => STAMP });
    sink.event({
      at: STAMP, source: 'stdout', providerType: 'item.completed',
      kind: 'tool', status: 'completed', summary: 'pwd',
    });
    sink.event({
      at: STAMP, source: 'stdout', providerType: 'item.completed',
      kind: 'response', status: 'completed', summary: 'DONE…',
    }, 'DONE — the full answer');
    const stats = sink.close();
    assert.equal(stats.streamFile, streamFile);
    assert.equal(stats.eventCount, 2);
    assert.equal(stats.dropped, 0);
    assert.equal(stats.lastResponse, 'DONE — the full answer');
    const { rows } = parseJsonl(streamFile);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      seq: 1, at: STAMP, source: 'stdout', providerType: 'item.completed',
      kind: 'tool', status: 'completed', summary: 'pwd',
    });
    assert.equal(rows[1].kind, 'response');
    assert.equal(rows[1].summary, 'DONE — the full answer');
    assert.equal(rows[1].seq, 2);
  } finally { cleanup(); }
});

test('a file that exceeds the cap is a head, one truncated marker, and a tail', () => {
  const { dir, cleanup } = tmp();
  try {
    const streamFile = join(dir, 'stream.jsonl');
    const sink = createAttemptStreamSink({
      streamFile,
      capBytes: 900,
      now: () => STAMP,
    });
    const total = 40;
    for (let i = 1; i <= total; i += 1) {
      sink.event({
        at: STAMP, source: 'stdout', providerType: 't',
        kind: 'tool', status: 'completed', summary: `cmd-${String(i).padStart(3, '0')}`,
      });
    }
    const stats = sink.close();
    const { raw, rows } = parseJsonl(streamFile);
    const markerAt = rows.findIndex((row) => row.truncated === true);
    assert.ok(markerAt > 0, 'head must be non-empty');
    assert.equal(rows[markerAt].dropped, stats.dropped);
    assert.ok(stats.dropped > 0);
    const head = rows.slice(0, markerAt);
    const tail = rows.slice(markerAt + 1);
    assert.ok(tail.length > 0, 'tail must be non-empty');
    assert.equal(head[0].seq, 1);
    assert.equal(tail.at(-1).seq, total);
    assert.equal(head.length + tail.length + rows[markerAt].dropped, total);
    assert.equal(Object.keys(rows[markerAt]).sort().join(','), 'dropped,truncated');
    for (const row of [...head, ...tail]) {
      assert.deepEqual(Object.keys(row).sort(), [
        'at', 'kind', 'providerType', 'seq', 'source', 'status', 'summary',
      ]);
    }
    // Marker line is extra; the event payload itself stays inside the cap.
    const eventBytes = Buffer.byteLength(raw, 'utf8')
      - Buffer.byteLength(`${JSON.stringify(rows[markerAt])}\n`, 'utf8');
    assert.ok(eventBytes <= 900, `event payload ${eventBytes} exceeded cap 900`);
  } finally { cleanup(); }
});

test('response text is persisted in full up to responseBytes, not the pane clip', () => {
  const { dir, cleanup } = tmp();
  try {
    const streamFile = join(dir, 'stream.jsonl');
    const full = `Completed the requested work. ${'x'.repeat(400)}`;
    const sink = createAttemptStreamSink({
      streamFile,
      responseBytes: 80,
      now: () => STAMP,
    });
    sink.event({
      at: STAMP, source: 'stdout', providerType: 'response',
      kind: 'response', status: 'completed', summary: `${full.slice(0, 179)}…`,
    }, full);
    sink.close();
    const { rows } = parseJsonl(streamFile);
    assert.equal(rows[0].kind, 'response');
    assert.notEqual(rows[0].summary, `${full.slice(0, 179)}…`);
    assert.equal(rows[0].summary, clipUtf8(full, 80));
    assert.ok(Buffer.byteLength(rows[0].summary, 'utf8') <= 80);
  } finally { cleanup(); }
});

test('a connector with no eventStream writes a bounded plain stdout log, no json marker', () => {
  const { dir, cleanup } = tmp();
  try {
    const stdoutFile = join(dir, 'stdout.log');
    const sink = createAttemptStreamSink({ stdoutFile, capBytes: 40 });
    sink.stdout('HEAD-MARK\n');
    sink.stdout('x'.repeat(200));
    sink.stdout('\nTAIL-MARK\n');
    const stats = sink.close();
    const body = readFileSync(stdoutFile);
    assert.equal(stats.streamFile, stdoutFile);
    assert.ok(body.length <= 40, `kept ${body.length} bytes for cap 40`);
    // The stdout fallback is a bounded TAIL, not the head+marker+tail the
    // JSONL stream gets: a plain log has no line structure to put a marker
    // between, and the end is where a failing worker says what went wrong.
    assert.match(body.toString('utf8'), /TAIL-MARK/);
    assert.doesNotMatch(body.toString('utf8'), /HEAD-MARK/);
    assert.doesNotMatch(body.toString('utf8'), /"truncated":true/);
    assert.ok(stats.dropped > 0);
  } finally { cleanup(); }
});

test('a kernel SIGKILL after the first event still leaves that event on disk', { timeout: 20_000 }, async () => {
  const { dir, cleanup } = tmp();
  try {
    const streamFile = join(dir, 'stream.jsonl');
    const child = `
      import { createAttemptStreamSink } from '${join(REPO, 'src/lib/attempt-stream.js')}';
      const sink = createAttemptStreamSink({ streamFile: ${JSON.stringify(streamFile)} });
      sink.event({
        source: 'stdout', providerType: 'item.completed',
        kind: 'response', status: 'completed', summary: 'LAST WORDS',
      });
      process.kill(process.pid, 'SIGKILL');
    `;
    const childFile = join(dir, 'probe.mjs');
    writeFileSync(childFile, child);
    const [code, signal] = await once(spawn(process.execPath, [childFile], { stdio: 'ignore' }), 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const { rows } = parseJsonl(streamFile);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'response');
    assert.equal(rows[0].summary, 'LAST WORDS');
    assert.equal(rows[0].seq, 1);
    assert.ok(!existsSync(`${streamFile}.tail`), 'no tail segment is created under the cap');
  } finally { cleanup(); }
});

test('over the cap the tail segment flushes on the bounded cadence and close folds head, marker and tail', { timeout: 20_000 }, async () => {
  const { dir, cleanup } = tmp();
  try {
    const streamFile = join(dir, 'stream.jsonl');
    const sink = createAttemptStreamSink({ streamFile, capBytes: 900, now: () => STAMP });
    for (let i = 1; i <= 80; i += 1) {
      sink.event({
        at: STAMP, source: 'stdout', providerType: 't',
        kind: 'tool', status: 'completed', summary: `cmd-${String(i).padStart(3, '0')}`,
      });
    }
    // The cadence counts events after the head fills; this many events is
    // enough to cross the 32-event flush boundary regardless of line width.
    assert.ok(existsSync(`${streamFile}.tail`), 'the tail segment flushes every 32 events over the cap');
    const stats = sink.close();
    assert.ok(!existsSync(`${streamFile}.tail`), 'close removes the segment');
    const { raw, rows } = parseJsonl(streamFile);
    const marker = rows.find((row) => row.truncated === true);
    assert.ok(marker, 'the folded file keeps the truncated marker');
    assert.equal(marker.dropped, stats.dropped);
    assert.match(raw, /cmd-080/, 'the final fold still ends at the newest event');
  } finally { cleanup(); }
});

test('a stdout log over the cap also flushes a tail segment a SIGKILL can still find', { timeout: 20_000 }, async () => {
  const { dir, cleanup } = tmp();
  try {
    const stdoutFile = join(dir, 'stdout.log');
    const sink = createAttemptStreamSink({ stdoutFile, capBytes: 40 });
    sink.stdout('HEAD-MARK\n');
    for (let i = 0; i < 32; i += 1) sink.stdout('x'.repeat(200));
    sink.stdout('\nTAIL-MARK\n');
    assert.ok(existsSync(`${stdoutFile}.tail`), 'the flushed segment exists');
    const segment = readFileSync(`${stdoutFile}.tail`, 'utf8');
    assert.match(segment, /x/);
    const stats = sink.close();
    assert.ok(!existsSync(`${stdoutFile}.tail`), 'close removes the segment');
    const body = readFileSync(stdoutFile, 'utf8');
    assert.equal(stats.streamFile, stdoutFile);
    assert.match(body, /TAIL-MARK/);
    assert.doesNotMatch(body, /HEAD-MARK/);
  } finally { cleanup(); }
});
