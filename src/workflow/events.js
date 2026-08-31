// Durable, ordered workflow events. The JSONL file is the replay source of
// truth; state.json only stores the last committed sequence for quick display.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_SCHEMA_VERSION = 1;

export function eventsPath(runDir) {
  return join(runDir, 'events.jsonl');
}

export function readEvents(runDir, { after = 0 } = {}) {
  const path = eventsPath(runDir);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number(event.sequence) > Number(after || 0)) out.push(event);
    } catch {
      // A crash may leave one incomplete final line. It is not a committed
      // event and must never be replayed as if it were one.
    }
  }
  return out;
}

export function appendEvent(runDir, state, type, payload = {}) {
  const lockPath = join(runDir, 'events.lock');
  const deadline = Date.now() + 2_000;
  let lockFd;
  while (lockFd == null) {
    try {
      lockFd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5_000) unlinkSync(lockPath);
      } catch { /* another writer released it */ }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring workflow event lock: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const diskLast = readEvents(runDir).at(-1)?.sequence ?? 0;
    const sequence = Math.max(Number(state.events?.sequence ?? state.eventSequence ?? 0), diskLast) + 1;
    const event = {
      sequence,
      type,
      schemaVersion: EVENT_SCHEMA_VERSION,
      payload,
      committedAt: new Date().toISOString(),
    };
    // One append call writes one complete line. Readers ignore any malformed
    // trailing line left by an interrupted filesystem write.
    appendFileSync(eventsPath(runDir), `${JSON.stringify(event)}\n`, { flag: 'a' });
    if (state.events && typeof state.events === 'object') {
      state.events.sequence = sequence;
      state.events.last = { sequence, type, committedAt: event.committedAt };
    } else {
      state.eventSequence = sequence;
      state.lastEvent = { sequence, type, committedAt: event.committedAt };
    }
    return event;
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); } catch { /* stale-lock recovery handles it */ }
  }
}
