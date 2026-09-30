// The retained meter log read as one row per local day (readLicencePerDay):
// each pool's paced window, its daily reading and the days its window reset.
import { join } from 'node:path';
import { readMeterHistoryDays } from '../meters/registry.js';
// N1: a missing measurement never becomes a confident zero. Number(null) is
// 0 and Number.isFinite(0) is true, so every reading below goes through this.
import { finiteOrNull } from '../lib/num.js';

function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
}

/** The quota window a pool's pacing reads, out of one retained meter sample. */
function pacedWindow(pool, sample) {
  const preferred = pool?.pacingWindow === 'monthly' ? 'monthly'
    : pool?.pacingWindow === 'five_hour' ? 'five_hour' : 'weekly';
  return sample?.[preferred] ?? sample?.weekly ?? sample?.monthly ?? sample?.five_hour;
}

/**
 * Providers restate the same window boundary with sub-second jitter on every
 * read (`12:00:00.645530Z`, then `12:00:00.200253Z`), so two readings count as
 * the same window unless the boundary moves by at least a minute. A real
 * rollover moves it by hours or days.
 */
const RESET_TOLERANCE_MS = 60_000;

/**
 * One reading per local day for a pool, and whether its quota window rolled
 * over on that day. A reset is a recorded `resets_at` moving to a new instant
 * — never a falling utilization, which is also what a refund or a corrected
 * reading looks like. The walk covers every retained sample in order, so a
 * reset that happened between two daily readings still lands on its own day.
 */
function poolDayReadings(pool, days) {
  const readings = new Map();
  let lastResetAtMs = null;
  for (const date of Object.keys(days).sort()) {
    const samples = [...days[date]].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    const reading = { value: null, resetsAt: null, reset: false };
    for (const sample of samples) {
      const window = pacedWindow(pool, sample);
      const resetsAt = typeof window?.resets_at === 'string' ? window.resets_at
        : typeof window?.resetsAt === 'string' ? window.resetsAt : null;
      const resetAtMs = resetsAt ? Date.parse(resetsAt) : NaN;
      if (Number.isFinite(resetAtMs)) {
        if (lastResetAtMs != null && Math.abs(resetAtMs - lastResetAtMs) >= RESET_TOLERANCE_MS) reading.reset = true;
        lastResetAtMs = resetAtMs;
      }
      const value = finiteOrNull(window?.utilization);
      if (value != null) {
        reading.value = value;
        reading.resetsAt = resetsAt;
      }
    }
    readings.set(date, reading);
  }
  return readings;
}

/** Read the retained per-pool meter log into one real row per local day. */
export function readLicencePerDay(bullswarmDir, pools, { period = '7d', now = Date.now(), rollups = [] } = {}) {
  const enabled = (Array.isArray(pools) ? pools : []).filter((pool) => pool?.name && pool.enabled !== false);
  const histories = enabled.map((pool) => {
    const days = readMeterHistoryDays(pool.name, { dir: join(bullswarmDir, 'meters') });
    return { pool, days, readings: poolDayReadings(pool, days) };
  });
  const recordedDays = histories.flatMap((entry) => Object.keys(entry.days));
  if (!recordedDays.length) return { period, rows: [], reason: 'meter history is not loaded' };

  const nowDay = dayStart(now);
  let requestedStart;
  if (period === '30d') requestedStart = nowDay - 29 * 86_400_000;
  else if (period === 'all') {
    const times = (Array.isArray(rollups) ? rollups : [])
      .map((record) => Date.parse(record?.finishedAt ?? record?.startedAt ?? ''))
      .filter(Number.isFinite);
    requestedStart = times.length ? dayStart(Math.min(...times)) : dayStart(Date.parse(recordedDays.sort()[0]));
  } else requestedStart = nowDay - 6 * 86_400_000;

  const firstRecorded = recordedDays.sort()[0];
  const rows = [];
  for (let at = requestedStart; at <= nowDay; at = new Date(new Date(at).setDate(new Date(at).getDate() + 1)).getTime()) {
    const date = localDayKey(at);
    const segments = [];
    for (const { pool, readings } of histories) {
      const reading = readings.get(date);
      if (!reading || reading.value == null) continue;
      // Stats Pools marks the reset day with `▏`; it needs the fact, not a
      // guess from a value that fell.
      const segment = { name: pool.name, value: reading.value };
      if (reading.resetsAt) segment.resetsAt = reading.resetsAt;
      if (reading.reset) segment.reset = true;
      segments.push(segment);
    }
    rows.push({ date, segments });
  }
  const reason = localDayKey(requestedStart) < firstRecorded
    ? `Meter logs retain data from ${firstRecorded}; earlier days in ${period} are blank.`
    : null;
  return { period, rows, reason };
}
