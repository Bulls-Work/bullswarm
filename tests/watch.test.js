import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchOnce } from '../src/lib/watch.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-watch-'));
  return {
    dir,
    paths: {
      taskFile: join(dir, 'task.md'),
      outFile: join(dir, 'out.md'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const connector = JSON.parse(
  readFileSync(join(REPO_ROOT, 'connectors/echo.json'), 'utf8'),
);
const BULLSWARM_DIR = REPO_ROOT;

// The connector cmd references {bullswarmDir}; substitute for tests.
connector.spawn.cmd = [
  'node',
  join(BULLSWARM_DIR, 'connectors/echo-worker.mjs'),
  '{taskFile}',
];

test('happy path: echo worker completes and passes verification', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(connector, 'Do the thing.', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.equal(v.ok, true);
    assert.equal(v.why, 'verified');
    assert.equal(v.meta.exitCode, 0);
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /Completed/);
  } finally {
    ctx.cleanup();
  }
});

test('lying exit 0 with auth failure is caught by signature gate', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(connector, 'FAIL:auth please', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.equal(v.ok, false);
    assert.match(v.why, /auth\/throttle signature/);
    assert.equal(v.quarantineHint, true);
    assert.equal(v.meta.exitCode, 0); // the lie itself
  } finally {
    ctx.cleanup();
  }
});

test('exit-1-after-success sets contentUsableDespiteExit', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(connector, 'FAIL:exit please', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.equal(v.ok, false); // non-zero exit is never a success
    assert.equal(v.contentUsableDespiteExit, true); // ...but read the file
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /Refactor complete/);
  } finally {
    ctx.cleanup();
  }
});

test('intent-only output fails even though exit is 0', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(connector, 'INTENT: summarize', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.equal(v.ok, false);
    assert.match(v.why, /announcement without substance/);
  } finally {
    ctx.cleanup();
  }
});

test('PWD quirk mode: env.PWD is set to the resolved target dir', async () => {
  const ctx = makeCtx();
  try {
    const pwdConnector = {
      ...connector,
      spawn: { cmd: connector.spawn.cmd, cwdMode: 'pwd' },
    };
    const v = await watchOnce(pwdConnector, 'PWD: report', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.equal(v.ok, true);
    const out = readFileSync(ctx.paths.outFile, 'utf8');
    // realpath: /var symlinks to /private/var on macOS; both lines must agree
    const real = realpathSync(ctx.dir);
    const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      out,
      new RegExp(`PWD environment variable: ${escaped}\\n- getcwd`),
    );
    assert.match(out, new RegExp(`process.cwd\\(\\): ${escaped}`));
  } finally {
    ctx.cleanup();
  }
});
