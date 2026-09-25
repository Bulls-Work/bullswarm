import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOnce } from '../src/lib/watch.js';
import { windowSpent } from '../src/meters/framework.js';

function limitChild(line) {
  return {
    name: 'fixture-limit',
    spawn: { cmd: [process.execPath, '-e', `console.log(${JSON.stringify(line)}); setTimeout(() => {}, 60000);`] },
    authSignatures: ['unauthorized'],
    outputExtraction: { strategy: 'stdout' },
  };
}

// A window-worded limit notice that names no reset, on a pool with no meter
// reader, writes a refusal marker whose reset is guessed (up to 7 days or a
// month out). A guessed reset must not keep the pool out: only a named or
// measured one does.
test('a limit notice with no named reset on a pool with no meter reader must not wall the pool for a guessed week', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  const home = mkdtempSync(join(tmpdir(), 'rv-home-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  try {
    const verdict = await watchOnce(limitChild("You've hit your usage limit"), 'Do the work.', dir,
      { taskFile: join(dir, 't.md'), outFile: join(dir, 'o.md') },
      { bullswarmDir: home, poolName: 'fixture-limit', usageLimitsToCaller: true });
    assert.equal(verdict.failureKind, 'quota');
    const snap = JSON.parse(readFileSync(join(home, 'meters', 'fixture-limit.json'), 'utf8'));
    assert.equal(snap.quota_refusal?.reset_source, 'guessed');
    const pool = { name: 'fixture-limit', meterSnapshot: snap };
    const spent = windowSpent(pool);
    const days = spent?.resetsAt ? (Date.parse(spent.resetsAt) - Date.now()) / 86400_000 : null;
    assert.ok(!(spent && days > 1), `pool kept out ${days?.toFixed(2)} days on a reset nobody named`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
