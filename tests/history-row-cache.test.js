import test from 'node:test';
import assert from 'node:assert/strict';
import { runTableLines } from '../src/workflow/history-view.js';

// 28 Nov profile of the Runs tab: every paint (the 400 ms spinner included)
// rebuilt the table model of every listed run, over 1,200 of them, although a
// finished run's row never changes.

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

function counted(record, counter) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    Object.defineProperty(out, key, { enumerable: true, get() { counter.reads += 1; return value; } });
  }
  return out;
}

const finished = (i) => ({
  runId: `wf-row-${i}`, shortId: `r${i}`, status: 'completed', ongoing: false,
  goal: `finished run ${i}`, project: 'bullswarm',
  startedAt: '2026-11-20T01:00:00.000Z', finishedAt: '2026-11-20T01:10:00.000Z',
  minutes: { wall: 10 },
});

test('a finished run row is modelled once and reused on later paints', () => {
  const counter = { reads: 0 };
  const records = [0, 1, 2].map((i) => counted(finished(i), counter));
  const first = runTableLines(records, { width: 120, ansi: false, nowMs: Date.parse('2026-11-28T00:00:00Z') });
  const afterFirst = counter.reads;
  assert.ok(afterFirst > 0);
  const second = runTableLines(records, { width: 120, ansi: false, nowMs: Date.parse('2026-11-28T00:00:05Z') });
  assert.equal(counter.reads, afterFirst, 'the second paint reads nothing from the finished records');
  assert.deepEqual(second.lines, first.lines);
});

test('a run still going is modelled again on every paint, so its clock moves', () => {
  const running = {
    runId: 'wf-row-live', shortId: 'live01', status: 'running', ongoing: true, running: true,
    goal: 'live run', startedAt: '2026-11-28T00:00:00.000Z',
    state: {
      schemaVersion: 'bullswarm.workflow.state.v2',
      lifecycle: { status: 'running', startedAt: '2026-11-28T00:00:00.000Z' },
      actions: [], attempts: [{ status: 'running', startedAt: '2026-11-28T00:00:00.000Z' }],
    },
  };
  const a = runTableLines([running], { width: 120, ansi: false, nowMs: Date.parse('2026-11-28T00:05:00Z') });
  const b = runTableLines([running], { width: 120, ansi: false, nowMs: Date.parse('2026-11-28T00:25:00Z') });
  assert.notDeepEqual(a.lines, b.lines, 'the elapsed time of a live run follows the clock');
});
