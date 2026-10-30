// `bullswarm place` — which Claude Code login a long-lived caller starts on.
// Pure decisions are placeCaller(); the CLI test feeds meters through a
// snapshot directory so the real bin never calls a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { formatPlace, placeCaller } from '../src/lib/place.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const NOW = Date.parse('2026-10-31T02:00:00.000Z');
const FIVE_H_MS = 5 * 3600_000;

function fiveReset(elapsedPct) {
  return new Date(NOW + FIVE_H_MS * (1 - elapsedPct / 100)).toISOString();
}

function pool(overrides = {}) {
  const name = overrides.name ?? 'claude-code';
  const tiers = overrides.strategyModelTiers ?? {
    [name]: {
      'claude-opus-5': ['high'],
      'claude-sonnet-5': ['medium'],
      'claude-haiku-4-5': ['low'],
    },
  };
  return {
    name,
    enabled: overrides.enabled ?? true,
    hold: overrides.hold ?? null,
    reserve: overrides.reserve ?? null,
    usedPct: overrides.usedPct ?? 20,
    elapsedPct: overrides.elapsedPct ?? 50,
    pacingWindow: overrides.pacingWindow ?? 'weekly',
    fiveHourUsedPct: overrides.fiveHourUsedPct ?? 10,
    fiveHourResetsAt: overrides.fiveHourResetsAt === undefined ? fiveReset(20) : overrides.fiveHourResetsAt,
    meterError: overrides.meterError ?? null,
    meterSnapshot: overrides.meterSnapshot === undefined
      ? { state: 'ok', stale: false }
      : overrides.meterSnapshot,
    connector: {
      bin: overrides.bin ?? 'claude',
      configDirs: overrides.configDirs ?? [`/tmp/${name}`],
    },
    strategyModelTiers: tiers,
  };
}

function place(pools, opts = {}) {
  return placeCaller(pools, { now: NOW, ...opts });
}

test('ranks claude logins by catch-up, then lower 5h use, then name', () => {
  const fast = pool({ name: 'claude-code:fast', usedPct: 10, elapsedPct: 50, fiveHourUsedPct: 40 });
  const slow = pool({ name: 'claude-code:slow', usedPct: 40, elapsedPct: 50, fiveHourUsedPct: 10 });
  const doc = place([slow, fast], { role: 'lead' });
  assert.deepEqual(doc.candidates.map((c) => c.login), ['fast', 'slow']);
  assert.equal(doc.pick.login, 'fast');
  assert.equal(doc.pick.pool, 'claude-code:fast');
  assert.equal(doc.pick.catchUp, 1.8);
  assert.equal(doc.pick.deficit, 40);
  assert.equal(doc.candidates[1].catchUp, 1.2);
  assert.equal(doc.pick.pacingWindow, 'weekly');
  assert.match(doc.pick.reason, /used 10%/);
  assert.match(doc.pick.reason, /elapsed 50%/);
  assert.match(doc.pick.reason, /weekly/);
  assert.match(doc.pick.reason, /catch-up 1\.8/);
  assert.match(doc.pick.reason, /5h used 40%/);

  const tiedLow = pool({ name: 'claude-code:b', usedPct: 20, elapsedPct: 50, fiveHourUsedPct: 30 });
  const tiedHigh = pool({ name: 'claude-code:a', usedPct: 20, elapsedPct: 50, fiveHourUsedPct: 10 });
  const tied = place([tiedLow, tiedHigh], { role: 'stage' });
  assert.deepEqual(tied.candidates.map((c) => c.login), ['a', 'b']);

  const sameMeterB = pool({ name: 'claude-code:m', usedPct: 20, elapsedPct: 50, fiveHourUsedPct: 10 });
  const sameMeterA = pool({ name: 'claude-code:k', usedPct: 20, elapsedPct: 50, fiveHourUsedPct: 10 });
  const byName = place([sameMeterB, sameMeterA], { role: 'watcher' });
  assert.deepEqual(byName.candidates.map((c) => c.login), ['k', 'm']);
});

test('the default claude-code login reports configDir null and the login personal', () => {
  const doc = place([pool({
    name: 'claude-code',
    configDirs: ['/Users/someone/.claude'],
  })], { role: 'lead' });
  assert.equal(doc.pick.login, 'personal');
  assert.equal(doc.pick.configDir, null);
  assert.equal(doc.pick.pool, 'claude-code');
  assert.match(formatPlace(doc).split('\n')[0], /^personal\tCLAUDE_CONFIG_DIR=\(unset\)\tmodel claude-opus-5$/);
});

test('a named login keeps its config dir and a meter login overrides the pool suffix', () => {
  const doc = place([pool({
    name: 'claude-code:work',
    configDirs: ['/tmp/work-home'],
    meterSnapshot: { login: 'ada', state: 'ok', stale: false },
  })], { role: 'lead' });
  assert.equal(doc.pick.login, 'ada');
  assert.equal(doc.pick.configDir, '/tmp/work-home');
});

test('excludes disabled, held, reserved, meter-bad, over the 5h cap, spent, and avoided logins with reasons', () => {
  const healthy = pool({ name: 'claude-code:ok', usedPct: 10, fiveHourUsedPct: 10 });
  const pools = [
    pool({ name: 'claude-code:off', enabled: false }),
    pool({ name: 'claude-code:held', hold: { until: new Date(NOW + 3600_000).toISOString(), reason: 'maintenance' } }),
    pool({ name: 'claude-code:saved', reserve: { pct: 25, window: 'weekly' } }),
    pool({ name: 'claude-code:err', meterError: 'usage endpoint 401' }),
    pool({ name: 'claude-code:stale', meterSnapshot: { state: 'ok', stale: true } }),
    pool({ name: 'claude-code:bad', meterSnapshot: { state: 'error', stale: false } }),
    pool({ name: 'claude-code:hot', fiveHourUsedPct: 70 }),
    pool({ name: 'claude-code:spent', usedPct: 98, fiveHourUsedPct: 10 }),
    pool({ name: 'claude-code:skip', usedPct: 15 }),
    healthy,
    pool({ name: 'grok', bin: 'grok', usedPct: 0, elapsedPct: 90, fiveHourUsedPct: 0 }),
  ];
  const doc = place(pools, { role: 'lead', avoid: ['skip'] });
  assert.equal(doc.pick.login, 'ok');
  assert.equal(doc.candidates.length, 1);
  const reasons = Object.fromEntries(doc.excluded.map((row) => [row.login, row.reason]));
  assert.equal(reasons.off, 'disabled');
  assert.match(reasons.held, /held/);
  assert.match(reasons.held, /maintenance/);
  assert.equal(reasons.saved, 'reserved');
  assert.match(reasons.err, /usage endpoint 401/);
  assert.match(reasons.stale, /stale/);
  assert.match(reasons.bad, /error/);
  assert.match(reasons.hot, /70%/);
  assert.match(reasons.spent, /98%/);
  assert.match(reasons.skip, /avoid/);
  assert.equal(reasons.grok, undefined);
  assert.equal(JSON.stringify(doc).includes('grok'), false);
});

test('a pin of an excluded login is still the answer, with a warning', () => {
  const doc = place([
    pool({ name: 'claude-code', fiveHourUsedPct: 10, usedPct: 10 }),
    pool({ name: 'claude-code:pinned', fiveHourUsedPct: 95, usedPct: 10 }),
  ], { role: 'lead', pin: 'pinned' });
  assert.equal(doc.pick.login, 'pinned');
  assert.equal(doc.pick.pool, 'claude-code:pinned');
  assert.match(doc.warning, /95%/);
  assert.deepEqual(doc.candidates, []);
  assert.equal(doc.excluded.length, 1);
  assert.equal(doc.excluded[0].login, 'pinned');
  assert.match(formatPlace(doc), /warning: /);
});

test('a pin accepts the pool name as well as the login', () => {
  const doc = place([
    pool({ name: 'claude-code:work', usedPct: 40 }),
    pool({ name: 'claude-code', usedPct: 10 }),
  ], { role: 'stage', pin: 'claude-code:work' });
  assert.equal(doc.pick.login, 'work');
  assert.equal(doc.pick.model, 'claude-sonnet-5');
  assert.equal(doc.pick.tier, 'medium');
});

test('role selects the first model whose tier list contains the effort', () => {
  const tiers = {
    'claude-code': {
      'claude-sonnet-5': ['medium', 'low'],
      'claude-opus-5': ['high'],
      'claude-haiku-4-5': ['low'],
    },
  };
  const pools = [pool({ strategyModelTiers: tiers })];
  assert.equal(place(pools, { role: 'lead' }).pick.model, 'claude-opus-5');
  assert.equal(place(pools, { role: 'lead' }).pick.tier, 'high');
  assert.equal(place(pools, { role: 'stage' }).pick.model, 'claude-sonnet-5');
  assert.equal(place(pools, { role: 'stage' }).pick.tier, 'medium');
  assert.equal(place(pools, { role: 'watcher' }).pick.model, 'claude-sonnet-5');
  assert.equal(place(pools, { role: 'watcher' }).pick.tier, 'low');
  const none = place([pool({ strategyModelTiers: { 'claude-code': { 'claude-opus-5': ['high'] } } })], { role: 'watcher' });
  assert.equal(none.pick.model, null);
  assert.match(formatPlace(none).split('\n')[0], /model default$/);
});

test('suggests a move when the current login is ahead of its 5h window, and stays when it is not', () => {
  const current = pool({
    name: 'claude-code',
    usedPct: 80,
    elapsedPct: 50,
    fiveHourUsedPct: 60,
    fiveHourResetsAt: fiveReset(20),
  });
  const better = pool({ name: 'claude-code:work', usedPct: 10, elapsedPct: 50, fiveHourUsedPct: 10 });
  const moved = place([current, better], { role: 'lead', current: 'personal' });
  assert.equal(moved.pick.login, 'work');
  assert.equal(moved.current.login, 'personal');
  assert.equal(moved.current.moveSuggested, true);
  assert.match(moved.current.moveReason, /60%/);
  assert.match(moved.current.moveReason, /20%/);
  assert.match(formatPlace(moved), /move suggested: /);

  const calm = pool({
    name: 'claude-code',
    usedPct: 40,
    elapsedPct: 50,
    fiveHourUsedPct: 30,
    fiveHourResetsAt: fiveReset(40),
  });
  const stayed = place([calm, better], { role: 'lead', current: 'claude-code' });
  assert.equal(stayed.pick.login, 'work');
  assert.equal(stayed.current.moveSuggested, false);
  assert.match(stayed.current.moveReason, /30%/);
  assert.match(stayed.current.moveReason, /40%/);
  assert.match(formatPlace(stayed), /stay: /);
});

test('does not suggest a move when the pick is the current login', () => {
  const only = pool({
    name: 'claude-code',
    usedPct: 10,
    fiveHourUsedPct: 90,
    fiveHourResetsAt: fiveReset(20),
  });
  // 90% is over the default 70% cap, so the cap is raised: the login can be the
  // pick and still be past the 85% move line. Same login means stay.
  const doc = place([only, pool({ name: 'claude-code:off', enabled: false })], {
    role: 'lead', current: 'personal', fiveHourCap: 100,
  });
  assert.equal(doc.pick.login, 'personal');
  assert.equal(doc.current.moveSuggested, false);
  assert.match(doc.current.moveReason, /90%/);
});

test('returns no pick when every claude login is excluded', () => {
  const doc = place([
    pool({ name: 'claude-code', fiveHourUsedPct: 90 }),
    pool({ name: 'claude-code:work', enabled: false }),
    pool({ name: 'grok', bin: 'grok' }),
  ], { role: 'watcher' });
  assert.equal(doc.pick, null);
  assert.deepEqual(doc.candidates, []);
  assert.equal(doc.excluded.length, 2);
  assert.match(formatPlace(doc), /skipped: personal/);
  assert.equal(formatPlace(doc).includes('grok'), false);
});

test('unknown role and unknown login are usage errors', () => {
  assert.throws(() => place([pool()], { role: 'boss' }), /role/);
  assert.throws(() => place([pool()], { role: 'lead', current: 'nobody' }), /nobody/);
  assert.throws(() => place([pool()], { role: 'lead', pin: 'grok' }), /grok/);
  assert.throws(() => place([pool()], { role: 'lead', avoid: ['personal', 'nope'] }), /nope/);
});

test('the default 5h cap is 70 and a caller can lower it', () => {
  const pools = [pool({ name: 'claude-code', fiveHourUsedPct: 65 })];
  assert.equal(place(pools, { role: 'lead' }).pick.login, 'personal');
  const capped = place(pools, { role: 'lead', fiveHourCap: 60 });
  assert.equal(capped.pick, null);
  assert.match(capped.excluded[0].reason, /65%/);
});

function connector(name, extra = {}) {
  return {
    name,
    bin: extra.bin ?? 'claude',
    configDirs: extra.configDirs ?? [`/tmp/${name}`],
    spawn: { cmd: ['claude', '-p', 'x'], cwdMode: 'add-dir' },
    authSignatures: [],
    quotaSignatures: [],
    throttleSignatures: [],
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'reader', window: 'weekly+5h' },
    costRank: 4,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: [],
    model: 'claude-sonnet-5',
    knownModels: ['claude-sonnet-5'],
    subscription: { quotaWindow: 'weekly' },
  };
}

function snapshot(used, fiveHour) {
  const now = Date.now();
  return {
    captured_at: new Date(now).toISOString(),
    state: 'ok',
    stale: false,
    five_hour: {
      utilization: fiveHour,
      resets_at: new Date(now + 4 * 3600_000).toISOString(),
    },
    seven_day: {
      utilization: used,
      resets_at: new Date(now + 3.5 * 24 * 3600_000).toISOString(),
    },
  };
}

function cliHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-place-'));
  const snaps = mkdtempSync(join(tmpdir(), 'bullswarm-place-snaps-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'claude-code.json'), JSON.stringify(connector('claude-code', { configDirs: ['/tmp/default-claude'] })));
  writeFileSync(join(home, 'connectors', 'claude-work.json'), JSON.stringify(connector('claude-code:work', { configDirs: ['/tmp/work-claude'] })));
  writeFileSync(join(home, 'connectors', 'grok.json'), JSON.stringify(connector('grok', { bin: 'grok' })));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: {},
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
    strategy: {
      modelTiers: {
        'claude-code': { 'claude-opus-5': ['high'], 'claude-sonnet-5': ['medium'], 'claude-haiku-4-5': ['low'] },
        'claude-code:work': { 'claude-opus-5': ['high'], 'claude-sonnet-5': ['medium'], 'claude-haiku-4-5': ['low'] },
      },
    },
  }));
  writeFileSync(join(snaps, 'claude-code.json'), JSON.stringify(snapshot(20, 10)));
  writeFileSync(join(snaps, 'claude-code:work.json'), JSON.stringify(snapshot(50, 10)));
  return { home, snaps };
}

function runPlace(home, snaps, argv) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      BULLSWARM_HOME: home,
      BULLSWARM_NO_PACKAGED_PROVIDERS: '1',
      BULLSWARM_DISABLE_CLAUDE_PROFILES: '1',
      BULLSWARM_METER_SNAPSHOT_DIR: snaps,
    },
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
}

test('place --help is read-only and names the verb', () => {
  const result = spawnSync(process.execPath, [BIN, 'place', '--role', 'lead', '--help'], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: join(tmpdir(), 'bullswarm-place-help-missing') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: bullswarm place /);
  assert.match(result.stdout, /changes no routing, state or cache/);
  assert.match(result.stdout, /--max-age/);
  assert.match(result.stdout, /--role/);
  assert.match(result.stdout, /--five-hour-cap/);
});

test('the real bin picks from snapshot meters and writes neither state nor the pools cache', () => {
  const { home, snaps } = cliHome();
  try {
    const before = readFileSync(join(home, 'state.json'), 'utf8');
    const bad = runPlace(home, snaps, ['place', '--role', 'boss']);
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stderr, /role/);

    const unknown = runPlace(home, snaps, ['place', '--role', 'lead', '--current', 'nobody']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /nobody/);

    const result = runPlace(home, snaps, ['place', '--role', 'lead', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.role, 'lead');
    assert.equal(doc.pick.login, 'personal');
    assert.equal(doc.pick.pool, 'claude-code');
    assert.equal(doc.pick.configDir, null);
    assert.equal(doc.pick.model, 'claude-opus-5');
    assert.equal(doc.pick.tier, 'high');
    assert.equal(JSON.stringify(doc).includes('grok'), false);
    assert.equal(doc.candidates.some((row) => row.login === 'work'), true);

    const plain = runPlace(home, snaps, ['place', '--role', 'lead', '--current', 'work']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^personal\tCLAUDE_CONFIG_DIR=\(unset\)\tmodel claude-opus-5\n/);
    assert.match(plain.stdout, /move suggested: |stay: /);

    writeFileSync(join(snaps, 'claude-code.json'), JSON.stringify(snapshot(20, 90)));
    writeFileSync(join(snaps, 'claude-code:work.json'), JSON.stringify(snapshot(50, 91)));
    const none = runPlace(home, snaps, ['place', '--role', 'watcher']);
    assert.equal(none.status, 3, none.stdout);
    assert.match(none.stdout, /skipped: personal/);
    assert.match(none.stdout, /skipped: work/);
    assert.equal(none.stdout.includes('grok'), false);

    const pinned = runPlace(home, snaps, ['place', '--role', 'lead', '--pin', 'work', '--json']);
    assert.equal(pinned.status, 0, pinned.stderr);
    const pinnedDoc = JSON.parse(pinned.stdout);
    assert.equal(pinnedDoc.pick.login, 'work');
    assert.equal(pinnedDoc.pick.configDir, '/tmp/work-claude');
    assert.match(pinnedDoc.warning, /91%/);

    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before);
    assert.equal(existsSync(join(home, 'cache', 'pools.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snaps, { recursive: true, force: true });
  }
});

// --- what place reads, and what it must never touch --------------------------

function metersFiles(home) {
  const dir = join(home, 'meters');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function readsLog(home) {
  const path = join(home, 'meters', 'reads.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

function cachedPool(name, bin, used, fiveHour) {
  return {
    ...pool({ name, bin, usedPct: used, fiveHourUsedPct: fiveHour, fiveHourResetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() }),
    meterSnapshot: { state: 'ok', stale: false },
  };
}

function writePoolsCacheFile(home, savedAt, pools) {
  mkdirSync(join(home, 'cache'), { recursive: true });
  writeFileSync(join(home, 'cache', 'pools.json'), JSON.stringify({
    schema: 'bullswarm.pools-cache.v1', savedAt, pools,
  }));
}

// Stand-in providers: each readUsage appends its pool to stub-reads.log and
// returns a fresh reading, so a live read is visible and no real provider is
// ever called.
function stubProviders(home) {
  const dirs = { 'claude-code': ['/tmp/default-claude', 'claude'], codex: [undefined, 'codex'], grok: [undefined, 'grok'] };
  for (const [name, [configDir, bin]] of Object.entries(dirs)) {
    // The provider's own connector.json replaces the plain one cliHome wrote.
    rmSync(join(home, 'connectors', `${name}.json`), { force: true });
    mkdirSync(join(home, 'providers', name), { recursive: true });
    writeFileSync(join(home, 'providers', name, 'connector.json'), JSON.stringify(connector(name, { bin, ...(configDir ? { configDirs: [configDir] } : {}) })));
    writeFileSync(join(home, 'providers', name, 'provider.mjs'), `
import { appendFileSync } from 'node:fs';
export const name = '${name}';
export async function readUsage(pool) {
  appendFileSync(${JSON.stringify(join(home, 'stub-reads.log'))}, String(pool?.name ?? pool) + '\\n');
  const now = Date.now();
  return {
    captured_at: new Date(now).toISOString(), state: 'ok', stale: false,
    five_hour: { utilization: 10, resets_at: new Date(now + 4 * 3600_000).toISOString() },
    seven_day: { utilization: String(pool?.name ?? pool) === 'claude-code' ? 20 : 50, resets_at: new Date(now + 3.5 * 24 * 3600_000).toISOString() },
  };
}
`);
  }
}

function stubReads(home) {
  const path = join(home, 'stub-reads.log');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).sort() : [];
}

function runNoSnaps(home, argv) {
  // No snapshot dir. A throwaway HOME hides real credentials, and node:test's
  // context is dropped so the stub providers under <home>/providers load.
  const env = { ...process.env, HOME: home, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' };
  for (const key of ['BULLSWARM_METER_SNAPSHOT_DIR', 'FORCE_COLOR', 'NO_COLOR', 'NODE_TEST_CONTEXT']) delete env[key];
  return spawnSync(process.execPath, [BIN, ...argv], { cwd: ROOT, env, encoding: 'utf8', input: '', timeout: 60_000 });
}

test('a usage error reads no meter and creates no meter file', () => {
  const { home, snaps } = cliHome();
  try {
    stubProviders(home);
    for (const argv of [
      ['place', '--role', 'bogus'],
      ['place', '--role', 'lead', '--five-hour-cap', 'x'],
      ['place', '--role', 'lead', '--avoid', ' , '],
      ['place', '--role', 'lead', '--max-age', 'soon'],
    ]) {
      const result = runNoSnaps(home, argv);
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
    }
    assert.deepEqual(stubReads(home), []);
    assert.deepEqual(metersFiles(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snaps, { recursive: true, force: true });
  }
});

test('a fresh pools cache answers without a live read, and says so', () => {
  const { home, snaps } = cliHome();
  try {
    stubProviders(home);
    writePoolsCacheFile(home, Date.now() - 42_000, [
      cachedPool('claude-code', 'claude', 20, 10),
      cachedPool('claude-code:work', 'claude', 50, 10),
      cachedPool('grok', 'grok', 5, 5),
    ]);
    const json = runNoSnaps(home, ['place', '--role', 'lead', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.pick.login, 'personal');
    assert.equal(doc.source, 'cache');
    assert.ok(doc.cacheAgeSeconds >= 42 && doc.cacheAgeSeconds < 60, String(doc.cacheAgeSeconds));
    assert.equal(JSON.stringify(doc).includes('grok'), false);
    const plain = runNoSnaps(home, ['place', '--role', 'lead']);
    assert.match(plain.stdout, /\nmeters: cache, \d+s old\n$/);
    assert.deepEqual(stubReads(home), []);
    assert.deepEqual(metersFiles(home), []);

    const off = runNoSnaps(home, ['place', '--role', 'lead', '--max-age', '0', '--json']);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(JSON.parse(off.stdout).source, 'live');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snaps, { recursive: true, force: true });
  }
});

test('a stale cache leads to a live read that never polls a non-Claude pool', () => {
  const { home, snaps } = cliHome();
  try {
    stubProviders(home);
    const cacheFile = join(home, 'cache', 'pools.json');
    writePoolsCacheFile(home, Date.now() - 3600_000, [cachedPool('claude-code', 'claude', 99, 99)]);
    const stale = readFileSync(cacheFile, 'utf8');
    const result = runNoSnaps(home, ['place', '--role', 'lead', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.source, 'live');
    assert.equal(doc.pick.login, 'personal');
    assert.ok(stubReads(home).includes('claude-code'), 'the stale cache led to a live read of the claude pool');
    for (const log of [stubReads(home), readsLog(home).map((row) => row.pool)]) {
      assert.deepEqual(log.filter((name) => !name.startsWith('claude-code')), []);
    }
    assert.equal(readFileSync(cacheFile, 'utf8'), stale);
    const plain = runNoSnaps(home, ['place', '--role', 'lead', '--max-age', '0']);
    assert.match(plain.stdout, /\nmeters: live read\n$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snaps, { recursive: true, force: true });
  }
});

test('no eligible pick still explains the move numbers for a current login past its limit', () => {
  const over = pool({ name: 'claude-code:a', fiveHourUsedPct: 90, fiveHourResetsAt: fiveReset(40) });
  const doc = place([over], { role: 'lead', current: 'a' });
  assert.equal(doc.pick, null);
  assert.equal(doc.current.moveSuggested, false);
  assert.match(doc.current.moveReason, /past its limit/);
  assert.match(doc.current.moveReason, /nothing better is free/);
  assert.match(doc.current.moveReason, /90% used/);
});
