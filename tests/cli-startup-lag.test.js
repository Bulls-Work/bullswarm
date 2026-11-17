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
