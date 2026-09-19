// Per-attempt persisted event stream (JSONL) or plain stdout tail.
//
// Caps are core defaults; a connector may override them in eventStream.capture.
// Byte budgets use Buffer.byteLength — BoundedCapture in watch.js counts
// characters, which is the wrong unit for these files.

import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// Chosen because none existed: the 180-char pane clip and the 32 MiB live
// capture cap are the wrong units for a durable per-attempt file.
export const DEFAULT_RESPONSE_BYTES = 64_000;
export const DEFAULT_FILE_BYTES = 1_048_576;

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function captureLimits(eventStream) {
  const capture = eventStream?.capture && typeof eventStream.capture === 'object' && !Array.isArray(eventStream.capture)
    ? eventStream.capture
    : {};
  return {
    capBytes: positiveInt(capture.fileBytes) ?? DEFAULT_FILE_BYTES,
    responseBytes: positiveInt(capture.responseBytes) ?? DEFAULT_RESPONSE_BYTES,
  };
}

/** Clip `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function clipUtf8(text, maxBytes) {
  if (typeof text !== 'string') return null;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo -= 1;
  return text.slice(0, lo);
}

function createLineBag(capBytes) {
  const limit = Math.max(2, Math.floor(capBytes));
  const markerReserve = Buffer.byteLength('{"truncated":true,"dropped":9007199254740991}\n');
  const payloadLimit = Math.max(0, limit - markerReserve);
  const headLimit = Math.ceil(payloadLimit / 2);
  const tailLimit = payloadLimit - headLimit;
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let dropped = 0;
  let headFull = false;

  const push = (encoded) => {
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (!headFull && headBytes + bytes <= headLimit) {
      head.push(encoded);
      headBytes += bytes;
      return true;
    }
    headFull = true;
    tail.push(encoded);
    tailBytes += bytes;
    while (tail.length && tailBytes > tailLimit) {
      const removed = tail.shift();
      tailBytes -= Buffer.byteLength(removed, 'utf8');
      dropped += 1;
    }
    return false;
  };

  const serialize = () => {
    if (dropped === 0) return head.concat(tail).join('');
    return `${head.join('')}{"truncated":true,"dropped":${dropped}}\n${tail.join('')}`;
  };

  return {
    push, serialize,
    serializeTail: () => `${dropped ? `{"truncated":true,"dropped":${dropped}}\n` : ''}${tail.join('')}`,
    dropped: () => dropped,
  };
}

function createByteBag(capBytes) {
  const limit = Math.max(1, Math.floor(capBytes));
  let tail = Buffer.alloc(0);
  let dropped = 0;
  const push = (text) => {
    const chunk = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
    const combined = chunk.length >= limit ? chunk : Buffer.concat([tail, chunk]);
    dropped += Math.max(0, tail.length + chunk.length - limit);
    tail = Buffer.from(combined.subarray(-limit));
  };
  return { push, serialize: () => tail, dropped: () => dropped };
}

function persistRecord(event, fullSummary, seq, responseBytes, stamp) {
  const kind = event?.kind ?? 'agent';
  let summary = event?.summary ?? null;
  if (kind === 'response') {
    const full = typeof fullSummary === 'string' ? fullSummary
      : (typeof event?.summary === 'string' ? event.summary : null);
    summary = clipUtf8(full, responseBytes);
  }
  const record = {
    seq,
    at: stamp(),
    source: event?.source ?? 'stdout',
    providerType: event?.providerType ?? null,
    kind,
    status: event?.status ?? null,
    summary,
  };
  // Keep the original seven fields stable and append only provider-proven
  // optional fields. Older streams simply do not have these keys, so readers
  // can continue to decode them unchanged.
  for (const field of [
    'turnId', 'eventId', 'toolCallId', 'toolName', 'arguments', 'result',
    'providerAt', 'durationMs', 'usage', 'parentId', 'subagentId',
  ]) {
    if (event?.[field] !== undefined && event?.[field] !== null) record[field] = event[field];
  }
  return record;
}

export function createAttemptStreamSink({
  streamFile = null,
  stdoutFile = null,
  capBytes = DEFAULT_FILE_BYTES,
  responseBytes = DEFAULT_RESPONSE_BYTES,
  now = () => new Date().toISOString(),
} = {}) {
  // Append-as-you-go: the file is created empty the moment the sink exists and
  // every event under the head cap is appended synchronously, so a kernel
  // SIGKILL leaves the head on disk. Over the cap the in-memory tail is
  // flushed to a sibling `.tail` segment at most one window behind (32 events
  // or 2 s, whichever first); close() folds head + marker + tail into the
  // final file and removes the segment.
  const fileCap = positiveInt(capBytes) ?? DEFAULT_FILE_BYTES;
  const eventCap = positiveInt(responseBytes) ?? DEFAULT_RESPONSE_BYTES;
  const jsonl = createLineBag(fileCap);
  const raw = createByteBag(fileCap);
  let seq = 0;
  let eventCount = 0;
  let lastResponse = null;
  let closed = false;
  let writeError = null;
  let wroteStream = false;
  let wroteStdout = false;

  let pending = 0;
  let timer = null;
  let stdoutBytes = 0;
  let stdoutFull = false;

  const perform = (operation) => {
    try {
      operation();
      return true;
    } catch (error) {
      writeError ??= error?.message ?? String(error);
      return false;
    }
  };
  const write = (path, body) => perform(() => {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  });
  const flushTail = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    if (streamFile) write(`${streamFile}.tail`, jsonl.serializeTail());
    if (stdoutFile && stdoutFull) write(`${stdoutFile}.tail`, raw.serialize());
    pending = 0;
  };
  const scheduleTail = () => {
    pending += 1;
    if (pending >= 32) flushTail();
    else if (!timer) {
      timer = setTimeout(flushTail, 2000);
      timer.unref();
    }
  };
  if (streamFile) perform(() => writeFileSync(streamFile, ''));
  if (stdoutFile) perform(() => writeFileSync(stdoutFile, ''));

  return {
    event(event, fullSummary) {
      if (closed || !streamFile) return;
      seq += 1;
      eventCount += 1;
      const record = persistRecord(event, fullSummary, seq, eventCap, now);
      if (record.kind === 'response') lastResponse = record.summary;
      const line = `${JSON.stringify(record)}\n`;
      if (jsonl.push(line)) perform(() => appendFileSync(streamFile, line));
      else scheduleTail();
    },
    stdout(chunk) {
      if (closed || !stdoutFile) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      raw.push(bytes);
      if (!stdoutFull && stdoutBytes + bytes.length <= fileCap) {
        perform(() => appendFileSync(stdoutFile, bytes));
        stdoutBytes += bytes.length;
      } else {
        stdoutFull = true;
        scheduleTail();
      }
    },
    close() {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        if (streamFile) {
          wroteStream = write(streamFile, jsonl.serialize());
          if (wroteStream) perform(() => rmSync(`${streamFile}.tail`, { force: true }));
        }
        if (stdoutFile) {
          wroteStdout = write(stdoutFile, raw.serialize());
          if (wroteStdout) perform(() => rmSync(`${stdoutFile}.tail`, { force: true }));
        }
      }
      return {
        streamFile: wroteStream ? streamFile : (wroteStdout ? stdoutFile : (streamFile || stdoutFile || null)),
        stdoutFile: stdoutFile || null,
        eventCount,
        dropped: streamFile ? jsonl.dropped() : raw.dropped(),
        lastResponse,
        writeError,
      };
    },
    streamPath() {
      return streamFile || stdoutFile || null;
    },
    stdoutPath() {
      return stdoutFile || null;
    },
  };
}
