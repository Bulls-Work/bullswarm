import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');

function runCli(home, argv) {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: {
      ...process.env,
      BULLSWARM_HOME: home,
      BULLSWARM_DISABLE_CLAUDE_PROFILES: '1',
    },
    encoding: 'utf8',
    input: '',
  });
}

const NO_STATE_CASES = [
  { argv: ['--version'], code: 0 },
  { argv: ['version'], code: 0 },
  { argv: ['--help'], code: 0 },
  { argv: ['help'], code: 0 },
  { argv: ['bogus'], code: 2 },
  { argv: ['pools', '--bogus'], code: 2 },
  { argv: ['pools', 'bogus'], code: 2 },
  { argv: ['pools', 'label'], code: 2 },
  { argv: ['assignments', '--max-age', 'nope'], code: 2 },
  { argv: ['run', '--dry-run', 'probe'], code: 2 },
  { argv: ['workflow', '--bogus'], code: 2 },
  { argv: ['workflow', 'bogus'], code: 2 },
  { argv: ['workflow', 'goal'], code: 2 },
  { argv: ['workflow', 'runs', 'bogus'], code: 2 },
  { argv: ['workflow', 'plan', 'bogus'], code: 2 },
  { argv: ['workflow', 'reprice', '--bogus'], code: 2 },
  { argv: ['workflow', 'watch', 'foo', '--until', 'bogus'], code: 2 },
  { argv: ['workflow', 'watch', 'foo', '--interval', '0'], code: 2 },
  { argv: ['workflow', 'watch', 'foo', '--classic', '--next'], code: 2 },
  { argv: ['workflow', 'events', 'foo', '--after', 'nope'], code: 2 },
  { argv: ['workflow', 'continue', 'foo', 'bar', '--rounds', '99'], code: 2 },
  { argv: ['workflow', 'continue', 'foo', 'bar', 'baz'], code: 2 },
  { argv: ['workflow', 'wait', 'foo'], code: 2 },
  { argv: ['workflow', 'wait', 'foo', 'bar', '--timeout', 'nope'], code: 2 },
  { argv: ['workflow', 'add', 'foo', '--steps', 'a.json', '--from-answer', 's1'], code: 2 },
  { argv: ['workflow', 'step', 'accept', 'foo', 'bar'], code: 2 },
  { argv: ['workflow', 'resume', 'foo', '--watch', '--json'], code: 2 },
  { argv: ['strategy', '--bogus'], code: 2 },
  { argv: ['strategy', 'bogus'], code: 2 },
  { argv: ['strategy', 'set-provider'], code: 2 },
  { argv: ['provider', '--bogus'], code: 2 },
  { argv: ['provider', 'bogus'], code: 2 },
  { argv: ['provider', 'enable'], code: 2 },
  { argv: ['integrate', 'bogus'], code: 2 },
];

test('J.1: --version, --help and usage errors never initialize an empty BULLSWARM_HOME', () => {
  const base = mkdtempSync(join(tmpdir(), 'bs-lag-j1-empty-'));
  try {
    for (const [index, { argv, code }] of NO_STATE_CASES.entries()) {
      const home = join(base, `case-${index}`);
      const res = runCli(home, argv);
      assert.equal(res.status, code, `${argv.join(' ')}: expected ${code}, got ${res.status} (${res.stderr})`);
      assert.equal(existsSync(home), false, `${argv.join(' ')} must not create BULLSWARM_HOME`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('J.1: --version, --help and usage errors never load or migrate an existing unmigrated home', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-lag-j1-unmigrated-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify({
      name: 'echo', flags: { testFixture: true }, lanes: ['analyze', 'build', 'chore'],
    }));
    const rawState = `${JSON.stringify({
      version: 1,
      pools: { opencode2: { enabled: true }, echo: {} },
      decisionLog: [],
      config: {},
    }, null, 2)}\n`;
    writeFileSync(join(home, 'state.json'), rawState);
    const filesBefore = readdirSync(home).sort();

    for (const { argv, code } of NO_STATE_CASES) {
      const res = runCli(home, argv);
      assert.equal(res.status, code, `${argv.join(' ')}: expected ${code}, got ${res.status}`);
      assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), rawState, `${argv.join(' ')} must not migrate state.json`);
      assert.deepEqual(readdirSync(home).sort(), filesBefore, `${argv.join(' ')} must not write files in home`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('J.2: homeMigrationNeeded persists an on-disk marker so subsequent processes skip rescanning', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-lag-j2-'));
  const stateMod = new URL('../src/lib/state.js', import.meta.url).href;
  try {
    mkdirSync(join(home, 'meters'), { recursive: true });
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({
      version: 1, pools: { codex: { enabled: true } }, decisionLog: [], config: { depthLimit: 2 },
    }, null, 2)}\n`);
    writeFileSync(join(home, 'providers.json'), `${JSON.stringify({ enabled: ['codex'] }, null, 2)}\n`);

    // Process 1: checks the clean home once and records the persistent marker.
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { loadState } from ${JSON.stringify(stateMod)};
      loadState(${JSON.stringify(home)});
    `], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(join(home, '.migrations.json')), true, 'persistent migration marker written');

    // Plant a migratable entry in providers.json after the marker exists: a new
    // process consulting the marker must skip homeMigrationNeededUncached.
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ enabled: ['opencode2'] }));
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { migratePoolNameHome } from ${JSON.stringify(stateMod)};
      process.stdout.write(String(migratePoolNameHome(${JSON.stringify(home)})));
    `], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, 'false', 'second process skipped full home scan via persistent marker');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')).enabled, ['opencode2']);

    // Removing the marker restores the full scan and migrates the home.
    rmSync(join(home, '.migrations.json'));
    const third = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { migratePoolNameHome } from ${JSON.stringify(stateMod)};
      process.stdout.write(String(migratePoolNameHome(${JSON.stringify(home)})));
    `], { encoding: 'utf8' });
    assert.equal(third.status, 0, third.stderr);
    assert.equal(third.stdout, 'true');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')).enabled, ['opencode']);
    assert.equal(existsSync(join(home, '.migrations.json')), true, 'marker recorded after migration completes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('J.3: migrateTestFixturePools skips parsing state.json once the lightweight marker is recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-lag-j3-'));
  const setupMod = new URL('../src/setup.js', import.meta.url).href;
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'echo.json'), JSON.stringify({
      name: 'echo', flags: { testFixture: true }, lanes: ['analyze', 'build', 'chore'],
    }));
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: { echo: { enabled: false } }, decisionLog: [],
      config: { depthLimit: 2, testFixturesMigrated: true },
    }));

    // First process: sees testFixturesMigrated in state.json and records the marker.
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { migrateTestFixturePools } from ${JSON.stringify(setupMod)};
      migrateTestFixturePools(${JSON.stringify(home)});
    `], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const marker = JSON.parse(readFileSync(join(home, '.migrations.json'), 'utf8'));
    assert.equal(marker.testFixturesMigrated, true);

    // Replace state.json with an unmigrated copy: a subsequent process consulting
    // the lightweight marker must not parse or rewrite state.json.
    const rawUnmigrated = `${JSON.stringify({ version: 1, pools: { echo: {} }, config: {} })}\n`;
    writeFileSync(join(home, 'state.json'), rawUnmigrated);
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { migrateTestFixturePools } from ${JSON.stringify(setupMod)};
      process.stdout.write(JSON.stringify(migrateTestFixturePools(${JSON.stringify(home)})));
    `], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, '[]');
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), rawUnmigrated);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('J.4: decisionLog overflows into append-only archive and all readers see archive + live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-lag-j4-'));
  try {
    const stateMod = await import('../src/lib/state.js');
    const { loadState, updateState, DECISION_LOG_LIVE_LIMIT, decisionLogArchivePath, readDecisionLog } = stateMod;
    const { expectedMinutesFor, workerMinutesForPool } = await import('../src/lib/spend.js');
    const { attachForecast } = await import('../src/lib/forecast.js');
    const { rungRecord } = await import('../src/lib/strategy.js');
    const { listTasks } = await import('../src/lib/tasks.js');
    const { readLegacyTaskRecords } = await import('../src/workflow/metrics-legacy.js');
    const { repriceRuns } = await import('../src/workflow/reprice.js');

    assert.equal(typeof DECISION_LOG_LIVE_LIMIT, 'number');
    assert.equal(typeof decisionLogArchivePath, 'function');
    assert.equal(typeof readDecisionLog, 'function');

    mkdirSync(join(home, 'runs'), { recursive: true });
    const archivedOut = join(home, 'runs', 'out-archived-1.md');
    writeFileSync(archivedOut, '## Completed\n\nVerified concrete result from archived single task.\n');

    const baseMs = Date.parse('2026-11-10T00:00:00.000Z');
    const totalInitial = DECISION_LOG_LIVE_LIMIT + 50;
    const rows = Array.from({ length: totalInitial }, (_, i) => {
      const startMs = baseMs + i * 60_000;
      const endMs = startMs + 120_000;
      return {
        id: `task-row-${i}`,
        kind: i === 0 ? 'run' : 'workflow',
        source: i === 0 ? 'run' : 'workflow',
        ts: new Date(endMs).toISOString(),
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        lane: 'build',
        effort: 'high',
        picked: i < 10 ? 'agy' : 'codex',
        pool: i < 10 ? 'agy' : 'codex',
        model: i < 10 ? 'gemini-4-carbon' : 'gpt-5',
        ok: true,
        wallSec: 120,
        why: 'paced'.padEnd(200, '.'),
        ...(i === 0 ? {
          outFile: archivedOut,
          cwd: ROOT,
          project: 'bullswarm',
          usage: { tokens: { standardRead: 100, output: 50, totalKnown: 150 }, tokenSource: 'estimated' },
        } : {}),
      };
    });

    updateState(home, (s) => {
      s.pools = { agy: { enabled: true }, codex: { enabled: true } };
      s.config.testFixturesMigrated = true;
      s.decisionLog = rows;
    });

    const liveAfterFirst = loadState(home);
    assert.equal(liveAfterFirst.decisionLog.length, DECISION_LOG_LIVE_LIMIT, 'live state.json decisionLog is capped');
    const archivePath = decisionLogArchivePath(home);
    assert.equal(existsSync(archivePath), true, 'archive file created');
    const archiveLines1 = readFileSync(archivePath, 'utf8').trim().split('\n');
    assert.equal(archiveLines1.length, 50, 'older 50 rows moved to archive');

    // Push 5 more rows: archive appends 5 more without duplicating prior 50.
    updateState(home, (s) => {
      for (let j = 0; j < 5; j++) {
        const idx = totalInitial + j;
        const startMs = baseMs + idx * 60_000;
        const endMs = startMs + 120_000;
        s.decisionLog.push({
          id: `task-row-${idx}`,
          kind: 'workflow',
          ts: new Date(endMs).toISOString(),
          startedAt: new Date(startMs).toISOString(),
          endedAt: new Date(endMs).toISOString(),
          lane: 'build',
          effort: 'high',
          picked: 'codex',
          ok: true,
          wallSec: 120,
        });
      }
    });
    assert.equal(loadState(home).decisionLog.length, DECISION_LOG_LIVE_LIMIT);
    const archiveLines2 = readFileSync(archivePath, 'utf8').trim().split('\n');
    assert.equal(archiveLines2.length, 55, 'append-only archive grew by 5 rows');

    const combined = readDecisionLog(home);
    assert.equal(combined.length, totalInitial + 5);
    assert.equal(combined[0].id, 'task-row-0');
    assert.equal(combined.at(-1).id, `task-row-${totalInitial + 4}`);

    // Readers see the archived rows (e.g. 'agy' only appears in the archived first 10 rows!):
    const stateForReaders = loadState(home);
    const agyMinutes = workerMinutesForPool('agy', baseMs, baseMs + 20 * 60_000, {
      decisionLog: stateForReaders.decisionLog,
    });
    assert.equal(agyMinutes, 20, 'spend workerMinutesForPool includes archived rows');
    const expected = expectedMinutesFor({ lane: 'build', effort: 'high' }, {
      decisionLog: stateForReaders.decisionLog,
    });
    assert.equal(expected.samples, totalInitial + 5, 'expectedMinutesFor sees archived + live samples');
    const agyRung = rungRecord(stateForReaders.decisionLog, 'agy', 'high');
    assert.equal(agyRung.dispatches, 10, 'strategy rungRecord scorecard sees archived rows');

    const pools = [{ name: 'agy', enabled: true, pacingWindow: 'weekly' }];
    attachForecast(pools, home, { now: baseMs + 30 * 60_000, decisionLog: stateForReaders.decisionLog });
    assert.ok(pools[0].spend, 'attachForecast works with archived decisionLog');

    // Tasks & legacy metrics readers find the archived 'run' entry (row 0):
    const tasks = listTasks({ home });
    assert.equal(tasks.finished.length, 1);
    assert.equal(tasks.finished[0].id, 'task-row-0');

    const legacyRecords = readLegacyTaskRecords(home);
    assert.equal(legacyRecords.length, 1);
    assert.equal(legacyRecords[0].runId, 'task:task-row-0');

    // Reprice scans and updates the archived single-task row:
    const repriced = repriceRuns({
      bullswarmDir: home,
      sinceMs: null,
      apply: true,
      connectors: { agy: { name: 'agy' } },
      readTranscriptUsage: () => ({
        tokens: { standardRead: 400, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0, totalKnown: 500 },
        model: 'gemini-4-carbon',
        requests: [],
        confidence: 'exact',
      }),
    });
    assert.equal(repriced.scannedTasks, 1, 'reprice scanned archived single task');
    assert.equal(repriced.changedTasks, 1, 'reprice updated archived single task');
    assert.equal(readDecisionLog(home)[0].usage.tokens.totalKnown, 500, 'archived row updated on disk');

    // CLI health and workflow task show see archived entries too:
    const health = runCli(home, ['health', '--json']);
    assert.equal(health.status, 0, health.stderr);
    assert.equal(JSON.parse(health.stdout).decisionLogSize, totalInitial + 5);

    const shown = runCli(home, ['workflow', 'task', 'show', 'task-row-0', '--json']);
    assert.equal(shown.status, 0, shown.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('J.4: scorecard reads archived decisionLog rows alongside state.json without mutating home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-lag-j4-scorecard-'));
  try {
    const { updateState, readDecisionLog, DECISION_LOG_LIVE_LIMIT } = await import('../src/lib/state.js');
    const { scorecard } = await import('../bench/eval-suite/scorecard.mjs');

    const baseMs = Date.parse('2026-11-10T00:00:00.000Z');
    const total = DECISION_LOG_LIVE_LIMIT + 10;
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `sc-row-${i}`,
      kind: 'workflow',
      ts: new Date(baseMs + i * 60_000).toISOString(),
      lane: 'build',
      effort: 'high',
      picked: i < 10 ? 'agy' : 'codex',
      ok: true,
      wallSec: 60,
      routing: {
        fiveHourUsedPct: 20,
        candidates: [
          { pool: 'agy', effectiveSurplus: i < 10 ? 15 : -5 },
          { pool: 'codex', effectiveSurplus: i < 10 ? 5 : 10 },
        ],
      },
    }));

    updateState(home, (s) => {
      s.pools = { agy: { enabled: true }, codex: { enabled: true } };
      s.decisionLog = rows;
    });
    assert.equal(readDecisionLog(home).length, total);
    rmSync(join(home, '.migrations.json'), { force: true });
    const filesBefore = readdirSync(home).sort();

    const card = scorecard({ home, days: 14, until: '2026-11-18T00:00:00.000Z' });
    assert.equal(card.routing.dispatches, total);
    assert.equal(card.routing.byPool.agy, 10);
    assert.equal(card.routing.byPool.codex, DECISION_LOG_LIVE_LIMIT);
    assert.equal(card.routing.judged, total);
    assert.equal(card.routing.matchedPacer, total);
    assert.deepEqual(readdirSync(home).sort(), filesBefore, 'scorecard must remain read-only');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('J.1-J.4: docs/reference/configuration.md documents live decisionLog cap, archive, migration marker, and no-state CLI paths', async () => {
  const { DECISION_LOG_LIVE_LIMIT } = await import('../src/lib/state.js');
  const doc = readFileSync(join(ROOT, 'docs/reference/configuration.md'), 'utf8');

  assert.doesNotMatch(doc, /Every non-help command self-initializes/i);
  assert.match(doc, /`--help`.*`--version`.*usage errors/i);

  const homeSection = doc.slice(doc.indexOf('## Home directory'), doc.indexOf('## state.json'));
  assert.match(homeSection, /\|\s*`decision-log-archive\.jsonl`\s*\|/);
  assert.match(homeSection, /\|\s*`\.migrations\.json`\s*\|/);

  const stateSection = doc.slice(doc.indexOf('## state.json'), doc.indexOf('## Retention'));
  const decisionLogRow = stateSection.split('\n').find((line) => line.startsWith('| `decisionLog` |')) ?? '';
  assert.doesNotMatch(decisionLogRow, /last 500 dispatch records/i);
  assert.ok(decisionLogRow.includes(String(DECISION_LOG_LIVE_LIMIT)), 'decisionLog row names DECISION_LOG_LIVE_LIMIT');
  assert.ok(decisionLogRow.includes('decision-log-archive.jsonl'), 'decisionLog row names decision-log-archive.jsonl');
});
