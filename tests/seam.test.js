// Integration seam: buildPools output → pickPool. The unit tests hand-build
// pool shapes; this file certifies the shape production actually produces.
// (Added after a delegate code-review found paceScore/isExhausted read
// pool.meter while buildPools writes flat fields — 61 green tests missed it.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPools } from '../src/lib/config.js';
import { pickPool, isExhausted, paceScore } from '../src/lib/route.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-seam-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeConnector(dir, name, over = {}) {
  writeFileSync(
    join(dir, 'connectors', `${name}.json`),
    JSON.stringify({ name, costRank: 2, lanes: ['chore'], ...over }),
  );
}

function writeState(dir, pools) {
  const state = {
    version: 1,
    pools,
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2 },
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

test('SEAM: exhausted pool (usedPct 100 via state) is excluded from picks', () => {
  const { dir, cleanup } = fixture();
  try {
    writeConnector(dir, 'grok');
    writeConnector(dir, 'codex');
    // grok's weekly window at 100% used until its reset, through a cached reading
    writeState(dir, {
      grok: { enabled: true },
      codex: { enabled: true },
    });
    const resetsAt = new Date(Date.now() + 3 * 86400_000).toISOString();
    const readings = {
      grok: {
        source: 'cache',
        pacingWindow: 'weekly',
        pacing: { usedPct: 100, elapsedPct: 50, surplus: -50, resetsAt },
        burstGate: false,
      },
      codex: {
        source: 'cache',
        pacingWindow: 'weekly',
        pacing: { usedPct: 20, elapsedPct: 50, surplus: 30, resetsAt },
        burstGate: false,
      },
    };
    const { pools } = buildPools(dir, Date.now(), readings);
    assert.equal(isExhausted(pools.find((p) => p.name === 'grok')), true);
    const r = pickPool('chore', pools, {});
    assert.equal(r.pick.pool, 'codex'); // NOT grok
  } finally {
    cleanup();
  }
});

test('SEAM: highest-surplus pool wins without any meter-shaped input', () => {
  const { dir, cleanup } = fixture();
  try {
    writeConnector(dir, 'grok');
    writeConnector(dir, 'command-code', { costRank: 1 });
    writeState(dir, { grok: { enabled: true }, 'command-code': { enabled: true } });
    const now = Date.now();
    const readings = {
      grok: {
        source: 'live',
        pacing: { usedPct: 10, elapsedPct: 60, surplus: 50, resetsAt: new Date(now + 3 * 86400_000).toISOString() },
        burstGate: false,
      },
      'command-code': {
        source: 'live',
        pacing: { usedPct: 80, elapsedPct: 64, surplus: -16, resetsAt: new Date(now + 2 * 3600_000).toISOString() },
        burstGate: false,
      },
    };
    const { pools } = buildPools(dir, now, readings);
    const r = pickPool('chore', pools, {});
    assert.equal(r.pick.pool, 'grok'); // surplus 50 beats -16 despite higher costRank
  } finally {
    cleanup();
  }
});

test('SEAM: no readings at all → declared meters still rank by headroom', () => {
  const { dir, cleanup } = fixture();
  try {
    writeConnector(dir, 'grok');
    writeState(dir, { grok: { enabled: true, meter: { usedPct: 95 } } });
    const { pools } = buildPools(dir, Date.now(), {});
    assert.equal(pools[0].meterSource, 'declared');
    assert.equal(pools[0].pace, -95);
    const r = pickPool('chore', pools, {});
    assert.equal(r.pick.pool, 'grok');
  } finally {
    cleanup();
  }
});

test('paceScore never returns NaN on malformed usedPct', () => {
  assert.equal(paceScore({ meter: { type: 'weekly', windowStart: Date.now(), usedPct: 'n/a' } }), 0);
  assert.equal(paceScore({}), 0);
});

test('a pool flagged as the caller is picked as a worker like any other', () => {
  const pools = [
    { name: 'claude-code', costRank: 4, lanes: ['chore'],
      connector: { flags: { isCaller: true } }, pace: 45, meterSource: 'cache' },
    { name: 'grok', costRank: 2, lanes: ['chore'], pace: 5 },
  ];
  const r = pickPool('chore', pools, {});
  assert.equal(r.pick.pool, 'claude-code'); // highest surplus wins, dispatched as worker
});
