// BULLSWARM_METER_SNAPSHOT_DIR (an external sampler's meter files) and the
// single-flight provider read: parallel callers make one usage-endpoint call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getMeterReading, refreshMeterAfterQuota, SNAPSHOT_FRESH_MS,
} from '../src/meters/registry.js';
import { buildPoolsLive } from '../src/lib/config.js';

const NOW = Date.parse('2026-10-14T19:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 3_600_000;

function homes() {
  const root = mkdtempSync(join(tmpdir(), 'bs-meter-hook-'));
  const home = join(root, 'home');
  const snaps = join(root, 'snaps');
  mkdirSync(join(home, 'meters'), { recursive: true });
  mkdirSync(snaps, { recursive: true });
  return { root, home, snaps, done: () => rmSync(root, { recursive: true, force: true }) };
}

function withSnapshotDir(dir, fn) {
  const before = process.env.BULLSWARM_METER_SNAPSHOT_DIR;
  process.env.BULLSWARM_METER_SNAPSHOT_DIR = dir;
  const restore = () => {
    if (before === undefined) delete process.env.BULLSWARM_METER_SNAPSHOT_DIR;
    else process.env.BULLSWARM_METER_SNAPSHOT_DIR = before;
  };
  return Promise.resolve().then(fn).finally(restore);
}

function weekly(capturedMs, used) {
  return {
    captured_at: iso(capturedMs),
    five_hour: { utilization: 10, resets_at: iso(capturedMs + 3_600_000) },
    seven_day: { utilization: used, resets_at: iso(capturedMs + 2 * DAY) },
    monthly: null,
  };
}

function countingReader(snapshot, { delayMs = 0, fail = null } = {}) {
  const reader = async () => {
    reader.calls += 1;
    if (delayMs) await new Promise((r) => { setTimeout(r, delayMs); });
    if (fail) throw fail;
    return snapshot;
  };
  reader.calls = 0;
  return reader;
}

test('a sampler file under 10 minutes old answers without a provider call', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.snaps, 'p.json'), JSON.stringify({ ...weekly(NOW - 9 * 60_000, 42), state: 'ok', error: null }));
    const reader = countingReader(weekly(NOW, 99));
    const r = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader, nowMs: NOW }));
    assert.equal(reader.calls, 0);
    assert.equal(r.source, 'snapshot');
    assert.equal(r.snapshot.seven_day.utilization, 42);
    assert.equal(r.ageMs, 9 * 60_000);
    assert.equal(SNAPSHOT_FRESH_MS, 10 * 60_000);
  } finally { h.done(); }
});

test('an older, missing or undated sampler file falls back to the live read', async () => {
  const h = homes();
  try {
    for (const body of [weekly(NOW - 11 * 60_000, 42), null, { seven_day: { utilization: 1 } }]) {
      if (body) writeFileSync(join(h.snaps, 'p.json'), JSON.stringify(body));
      else rmSync(join(h.snaps, 'p.json'), { force: true });
      rmSync(join(h.home, 'meters', 'p.json'), { force: true });
      const reader = countingReader(weekly(NOW, 55));
      const r = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader, nowMs: NOW }));
      assert.equal(reader.calls, 1);
      assert.equal(r.source, 'live');
      assert.equal(r.snapshot.seven_day.utilization, 55);
    }
  } finally { h.done(); }
});

test('a window the sampler file lacks is taken from the cache until it resets', async () => {
  const h = homes();
  try {
    // Seen live: a status-line sample with seven_day missing made a weekly seat look 5h-only.
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify(weekly(NOW - 3 * 3_600_000, 25)));
    writeFileSync(join(h.snaps, 'p.json'), JSON.stringify({
      captured_at: iso(NOW - 60_000), five_hour: { utilization: 4, resets_at: iso(NOW + 3_600_000) }, seven_day: null,
    }));
    const reader = countingReader(weekly(NOW, 99));
    const r = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader, nowMs: NOW }));
    assert.equal(reader.calls, 0);
    assert.equal(r.snapshot.five_hour.utilization, 4);
    assert.equal(r.snapshot.seven_day.utilization, 25);
    assert.equal(r.snapshot.seven_day.source, 'cache');
    assert.deepEqual(r.snapshot.filled_from_cache, ['seven_day']);
    assert.equal(r.pacingWindow, 'weekly');

    // A cached window that already reset is not carried over.
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify({
      ...weekly(NOW - 3 * DAY, 25), seven_day: { utilization: 25, resets_at: iso(NOW - DAY) },
    }));
    const r2 = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader, nowMs: NOW }));
    assert.equal(r2.snapshot.seven_day, null);
  } finally { h.done(); }
});

test('the sampler error is surfaced; a 401 marks the sign-in failed', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.snaps, 'p.json'), JSON.stringify({ ...weekly(NOW - 60_000, 30), error: '429', state: 'stale' }));
    const r = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader: countingReader(null), nowMs: NOW }));
    assert.equal(r.source, 'snapshot');
    assert.equal(r.meterError, '429');
    assert.equal(r.signInFailed, undefined);
    writeFileSync(join(h.snaps, 'p.json'), JSON.stringify({ ...weekly(NOW - 60_000, 30), error: '401 sign-in', state: 'broken' }));
    const r2 = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader: countingReader(null), nowMs: NOW }));
    assert.equal(r2.signInFailed, true);
  } finally { h.done(); }
});

test('a forced read and a newer quota refusal bypass the sampler file', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.snaps, 'p.json'), JSON.stringify(weekly(NOW - 60_000, 30)));
    const reader = countingReader(weekly(NOW, 77));
    const forced = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader, nowMs: NOW, force: true }));
    assert.equal(reader.calls, 1);
    assert.equal(forced.source, 'live');

    // A refusal recorded after the sampler's capture is the stronger evidence.
    const failing = countingReader(null, { fail: Object.assign(new Error('boom'), { status: 503 }) });
    await refreshMeterAfterQuota('p', {
      bullswarmDir: h.home, reader: failing, nowMs: NOW, resetAtMs: NOW + DAY, reason: 'usage limit',
    });
    const after = await withSnapshotDir(h.snaps, () => getMeterReading('p', { bullswarmDir: h.home, reader: failing, nowMs: NOW + 1000 }));
    assert.equal(after.source, 'quota-refusal');
  } finally { h.done(); }
});

test('parallel forced reads in one process make one provider call', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify(weekly(Date.now() - 10 * 60_000, 20)));
    const reader = countingReader(weekly(Date.now(), 21), { delayMs: 300 });
    const results = await Promise.all(Array.from({ length: 10 }, () => getMeterReading('p', {
      bullswarmDir: h.home, reader, force: true,
    })));
    assert.equal(reader.calls, 1);
    for (const r of results) {
      assert.equal(r.source, 'live');
      assert.equal(r.snapshot.seven_day.utilization, 21);
    }
    assert.equal(results.filter((r) => r.shared).length, 9);
    assert.equal(existsSync(join(h.home, 'meters', 'p.fetch.lock')), false);
    const log = readFileSync(join(h.home, 'meters', 'reads.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
  } finally { h.done(); }
});

test('a quota refresh does not take a reading from before the refusal', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify(weekly(Date.now() - 5_000, 20)));
    const reader = countingReader(weekly(Date.now(), 100));
    const r = await refreshMeterAfterQuota('p', { bullswarmDir: h.home, reader });
    assert.equal(reader.calls, 1);
    assert.equal(r.snapshot.seven_day.utilization, 100);
  } finally { h.done(); }
});

test('callers that waited take the hold a failed read left, not a second call', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify(weekly(Date.now() - 20 * 60_000, 20)));
    const fail = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 60_000 });
    const reader = countingReader(null, { delayMs: 200, fail });
    const results = await Promise.all(Array.from({ length: 8 }, () => getMeterReading('p', {
      bullswarmDir: h.home, reader, force: true,
    })));
    assert.equal(reader.calls, 1);
    for (const r of results) {
      assert.equal(r.source, 'stale');
      assert.equal(r.meterError, '429');
    }
  } finally { h.done(); }
});

test('a lock left by a dead process is taken over', async () => {
  const h = homes();
  try {
    writeFileSync(join(h.home, 'meters', 'p.fetch.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: iso(Date.now()) }));
    const reader = countingReader(weekly(Date.now(), 33));
    const started = Date.now();
    const r = await getMeterReading('p', { bullswarmDir: h.home, reader });
    assert.equal(reader.calls, 1);
    assert.equal(r.source, 'live');
    assert.ok(Date.now() - started < 5_000);
  } finally { h.done(); }
});

test('ten processes reading at once make one provider call', async () => {
  const h = homes();
  try {
    const calls = join(h.root, 'calls.log');
    writeFileSync(join(h.home, 'meters', 'p.json'), JSON.stringify(weekly(Date.now() - 10 * 60_000, 20)));
    const registry = new URL('../src/meters/registry.js', import.meta.url).href;
    const child = `
      import { getMeterReading } from ${JSON.stringify(registry)};
      import { appendFileSync } from 'node:fs';
      const reader = async () => {
        appendFileSync(${JSON.stringify(calls)}, process.pid + '\\n');
        await new Promise((r) => setTimeout(r, 400));
        return ${JSON.stringify(weekly(Date.now(), 24))};
      };
      const r = await getMeterReading('p', { bullswarmDir: ${JSON.stringify(h.home)}, reader, force: true });
      process.stdout.write(JSON.stringify({ source: r.source, used: r.snapshot.seven_day.utilization }));
    `;
    const outs = await Promise.all(Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    })));
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    for (const o of outs) assert.deepEqual(o, { source: 'live', used: 24 });
  } finally { h.done(); }
});

test('buildPoolsLive reads only the pools named in `only`', async () => {
  const h = homes();
  try {
    let asked = null;
    const { pools } = await buildPoolsLive(h.home, NOW, {
      packaged: true,
      only: ['grok'],
      getReadings: async (names) => { asked = names; return {}; },
    });
    assert.ok(asked.every((name) => name === 'grok'));
    assert.ok(pools.every((p) => p.name === 'grok'));
  } finally { h.done(); }
});
