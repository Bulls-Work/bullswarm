import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRunHeartbeat } from '../src/lib/run-heartbeat.js';

test('direct-run heartbeat is compact and contains only aggregate progress', () => {
  assert.equal(formatRunHeartbeat({
    elapsedMs: 90_000,
    events: 12,
    bytes: 83 * 1024,
    idleMs: 4_000,
  }), 'bullswarm run · active 1m30s · 12 events · 83 KB · activity 4s ago');
});
