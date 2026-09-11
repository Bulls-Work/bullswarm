// `bullswarm update`: install-shape detection, registry read, and the three
// upgrade paths, each exercised without a network, an npm, or a git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions, detectInstall, fetchLatestVersion, readInstalledVersion, runUpdate,
} from '../src/lib/update.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

/** A fake exec that records every call and answers from a table. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key.startsWith(pattern)) {
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer() : answer;
      }
    }
    return '';
  };
  return { calls, exec };
}

function quiet() {
  const out = [];
  const err = [];
  return { out, err, log: (l) => out.push(String(l)), warn: (l) => err.push(String(l)) };
}

test('compareVersions: numeric triples, suffixes ignored, unknowns are null', () => {
  assert.equal(compareVersions('0.28.7', '0.28.8'), -1);
  assert.equal(compareVersions('0.28.10', '0.28.9'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0);
  assert.equal(compareVersions(null, '1.0.0'), null);
  assert.equal(compareVersions('latest', '1.0.0'), null);
});

test('detectInstall: checkout beats global; posix and windows global layouts yield the prefix', () => {
  const exists = (p) => p === '/home/u/Repo/bullswarm/.git';
  assert.deepEqual(detectInstall({ packageRoot: '/home/u/Repo/bullswarm', exists }), {
    kind: 'checkout', root: '/home/u/Repo/bullswarm', prefix: null,
  });
  // An npm link: the global path resolves into the checkout → still a checkout.
  assert.equal(detectInstall({ packageRoot: '/home/u/Repo/bullswarm', exists }).kind, 'checkout');
  assert.deepEqual(detectInstall({ packageRoot: '/home/u/.local/lib/node_modules/bullswarm', exists: () => false }), {
    kind: 'global', root: '/home/u/.local/lib/node_modules/bullswarm', prefix: '/home/u/.local',
  });
  assert.deepEqual(detectInstall({ packageRoot: '/nvm/versions/node/v22.0.0/lib/node_modules/bullswarm', exists: () => false }).prefix,
    '/nvm/versions/node/v22.0.0');
  assert.deepEqual(detectInstall({ packageRoot: 'C:/Users/u/AppData/Roaming/npm/node_modules/bullswarm', exists: () => false }), {
    kind: 'global', root: 'C:/Users/u/AppData/Roaming/npm/node_modules/bullswarm', prefix: 'C:/Users/u/AppData/Roaming/npm',
  });
  assert.equal(detectInstall({ packageRoot: '/opt/somewhere/bullswarm', exists: () => false }).kind, 'unknown');
});

test('fetchLatestVersion: reads the dist-tag, and reports HTTP, shape and network failures without throwing', async () => {
  assert.deepEqual(await fetchLatestVersion({ fetchImpl: async () => okJson({ version: '0.28.8' }) }), { version: '0.28.8', error: null });
  assert.equal((await fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 503 }) })).error, 'registry returned HTTP 503');
  assert.equal((await fetchLatestVersion({ fetchImpl: async () => okJson({}) })).error, 'registry reply carried no version');
  const net = await fetchLatestVersion({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.equal(net.version, null);
  assert.match(net.error, /ENOTFOUND/);
});

test('readInstalledVersion: the package.json on disk, or null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-update-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bullswarm', version: '0.28.8' }));
    assert.equal(readInstalledVersion(dir), '0.28.8');
    assert.equal(readInstalledVersion(join(dir, 'missing')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('update: a global install behind the registry is upgraded into its own prefix and verified on disk', async () => {
  const root = '/home/u/.local/lib/node_modules/bullswarm';
  let onDisk = '0.28.7';
  const { calls, exec } = fakeExec({
    'npm install': () => { onDisk = '0.28.8'; return ''; },
    'sh -c command -v bullswarm': '',
  });
  const io = quiet();
  const code = await runUpdate({
    packageRoot: root, exists: () => false, currentVersion: '0.28.7',
    fetchImpl: async () => okJson({ version: '0.28.8' }),
    exec, readVersion: () => onDisk, lookupShellBinary: false, ...io,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [[
    'npm', 'install', '-g', 'bullswarm@0.28.8', '--prefix', '/home/u/.local', '--no-fund', '--no-audit',
  ]]);
  assert.match(io.out.join('\n'), /updated bullswarm 0\.28\.7 → 0\.28\.8/);
  assert.equal(io.err.length, 0);
});

test('update: npm exit 0 without the version changing on disk is a failure, not a success', async () => {
  const root = '/home/u/.local/lib/node_modules/bullswarm';
  const { exec } = fakeExec({ 'npm install': '' });
  const io = quiet();
  const code = await runUpdate({
    packageRoot: root, exists: () => false, currentVersion: '0.28.7',
    fetchImpl: async () => okJson({ version: '0.28.8' }),
    exec, readVersion: () => '0.28.7', lookupShellBinary: false, json: true, ...io,
  });
  assert.equal(code, 1);
  const result = JSON.parse(io.out.at(-1));
  assert.equal(result.updated, false);
  assert.match(result.error, /npm exited 0 but .*package\.json now reads 0\.28\.7, not 0\.28\.8/);
});

test('update: already at the latest version runs nothing; --check never installs; an unreachable registry is exit 1', async () => {
  const root = '/home/u/.local/lib/node_modules/bullswarm';
  const latest = async () => okJson({ version: '0.28.8' });

  let f = fakeExec();
  let io = quiet();
  assert.equal(await runUpdate({
    packageRoot: root, exists: () => false, currentVersion: '0.28.8', fetchImpl: latest,
    exec: f.exec, readVersion: () => '0.28.8', lookupShellBinary: false, ...io,
  }), 0);
  assert.deepEqual(f.calls, []);
  assert.match(io.out.join('\n'), /already the latest published version/);

  f = fakeExec();
  io = quiet();
  assert.equal(await runUpdate({
    check: true, json: true, packageRoot: root, exists: () => false, currentVersion: '0.28.7',
    fetchImpl: latest, exec: f.exec, readVersion: () => '0.28.7', lookupShellBinary: false, ...io,
  }), 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(io.out.at(-1)).upToDate, false);

  f = fakeExec();
  io = quiet();
  assert.equal(await runUpdate({
    packageRoot: root, exists: () => false, currentVersion: '0.28.7',
    fetchImpl: async () => { throw new Error('offline'); },
    exec: f.exec, readVersion: () => '0.28.7', lookupShellBinary: false, ...io,
  }), 1);
  assert.deepEqual(f.calls, []);
  assert.match(io.err.join('\n'), /npm registry.*offline/);
});

test('update: a source checkout is pulled fast-forward when clean and refused when dirty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-update-checkout-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bullswarm', version: '0.28.7' }));
    const latest = async () => okJson({ version: '0.28.8' });

    // Dirty: nothing is pulled, npm is never touched, exit 1 names the fix.
    let f = fakeExec({ 'git -C': (() => ' M src/cli.js\n') });
    let io = quiet();
    assert.equal(await runUpdate({ packageRoot: dir, currentVersion: '0.28.7', fetchImpl: latest, exec: f.exec, ...io }), 1);
    assert.deepEqual(f.calls, [['git', '-C', dir, 'status', '--porcelain']]);
    assert.match(io.err.join('\n'), /local changes.*git -C .* pull --ff-only/);

    // Clean: git pull --ff-only, and the version is re-read from disk.
    f = fakeExec({
      [`git -C ${dir} status`]: '',
      [`git -C ${dir} pull --ff-only`]: () => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bullswarm', version: '0.28.8' }));
        return 'Updating 3b7caa9..abc1234\nFast-forward\n';
      },
    });
    io = quiet();
    assert.equal(await runUpdate({ packageRoot: dir, currentVersion: '0.28.7', fetchImpl: latest, exec: f.exec, json: true, ...io }), 0);
    assert.deepEqual(f.calls.map((c) => c.slice(3)), [['status', '--porcelain'], ['pull', '--ff-only']]);
    const result = JSON.parse(io.out.at(-1));
    assert.equal(result.install.kind, 'checkout');
    assert.equal(result.updated, true);
    assert.equal(result.after, '0.28.8');
    assert.ok(!f.calls.some((c) => c[0] === 'npm'), 'a checkout must never be handed to npm');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('update: an unrecognized install shape prints the manual command and exits 1', async () => {
  const f = fakeExec();
  const io = quiet();
  assert.equal(await runUpdate({
    packageRoot: '/opt/elsewhere/bullswarm', exists: () => false, currentVersion: '0.28.7',
    fetchImpl: async () => okJson({ version: '0.28.8' }), exec: f.exec, readVersion: () => '0.28.7', ...io,
  }), 1);
  assert.deepEqual(f.calls, []);
  assert.match(io.err.join('\n'), /npm install -g bullswarm@latest/);
});
