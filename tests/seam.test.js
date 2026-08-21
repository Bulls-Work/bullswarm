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
    // grok at 100% used via a stale-but-valid reading injected as a live one
    writeState(dir, {
      grok: { enabled: true },
      codex: { enabled: true },
    });
    const readings = {
      grok: {
        source: 'cache',
        pacing: { usedPct: 100, elapsedPct: 50, surplus: -50, resetsAt: new Date().toISOString() },
        burstGate: false,
      },
      codex: {
        source: 'cache',
        pacing: { usedPct: 20, elapsedPct: 50, surplus: 30, resetsAt: new Date().toISOString() },
        burstGate: false,
      },
    };
    const { pools } = buildPools(dir, Date.now(), readings);
    assert.equal(isExhausted(pools.find((p) => p.name === 'grok')), true);
    const r = pickPool('chore', pools, { callerEligible: false });
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
    const r = pickPool('chore', pools, { callerEligible: false });
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
    const r = pickPool('chore', pools, { callerEligible: false });
    assert.equal(r.pick.pool, 'grok');
    assert.equal(r.keepOnClaude, false);
  } finally {
    cleanup();
  }
});

test('caller pool winning on merit returns keepOnClaude, never self-dispatch', () => {
  const { dir, cleanup } = fixture();
  try {
    writeConnector(dir, 'claude-code', {
      flags: { isCaller: true },
      lanes: ['analyze', 'build', 'chore'],
    });
    writeState(dir, { 'claude-code': { enabled: true } });
    const readings = {
      'claude-code': {
        source: 'cache',
        pacing: { usedPct: 5, elapsedPct: 50, surplus: 45, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        burstGate: false,
      },
    };
    const { pools } = buildPools(dir, Date.now(), readings);
    const r = pickPool('chore', pools, { callerEligible: true, callerName: 'claude' });
    assert.equal(r.pick, null);
    assert.equal(r.keepOnClaude, true);
    assert.match(r.why, /keep work in-session/);
  } finally {
    cleanup();
  }
});

test('distressed incumbent forfeits cost protection; equal-rank may displace', () => {
  const pools = [
    { name: 'cheap-incumbent', costRank: 1, lanes: ['chore'], incumbent: true,
      usedPct: 99, meterSource: 'cache' },           // surplus via flat pace below
    { name: 'pricier-fresh', costRank: 3, lanes: ['chore'] },
  ];
  pools[0].pace = -49;  // distressed
  pools[1].pace = 30;
  const r = pickPool('chore', pools, { callerEligible: false });
  assert.equal(r.pick.pool, 'pricier-fresh'); // distress voids the cost guard
});

test('paceScore never returns NaN on malformed usedPct', () => {
  assert.equal(paceScore({ meter: { type: 'weekly', windowStart: Date.now(), usedPct: 'n/a' } }), 0);
  assert.equal(paceScore({}), 0);
});

test("callerName fallback matches pool name without flags (reviewer residual)", () => {
  // The default caller name must equal the claude-code connector's pool name,
  // so even if flags.isCaller is lost, self-dispatch cannot happen.
  const pools = [
    { name: 'claude-code', costRank: 4, lanes: ['chore'], pace: 45, meterSource: 'cache' },
    { name: 'grok', costRank: 2, lanes: ['chore'], pace: -10 },
  ];
  const r = pickPool('chore', pools, { callerEligible: true }); // no explicit callerName
  assert.equal(r.pick, null);
  assert.equal(r.keepOnClaude, true);
});

test('equal-cost challenger displaces distressed incumbent (true equal rank)', () => {
  const pools = [
    { name: 'a', costRank: 2, lanes: ['chore'], incumbent: true, pace: -25 },
    { name: 'b', costRank: 2, lanes: ['chore'], pace: -10 },
  ];
  const r = pickPool('chore', pools, { callerEligible: false });
  assert.equal(r.pick.pool, 'b'); // same costRank: distress valve allows displacement
});
