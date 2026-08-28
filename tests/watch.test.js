import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchOnce, argvWithModel } from '../src/lib/watch.js';

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
    assert.equal(v.meta.usage.model, 'echo-local');
    assert.equal(v.meta.usage.cost.estimatedUsd, 0);
    assert.equal(v.meta.usage.tokenSource, 'estimated:utf8-bytes/4');
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /Completed/);
  } finally {
    ctx.cleanup();
  }
});

test('event-stream connector extracts final content and emits normalized actions', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'tool', id: 't1', name: 'shell', command: 'npm test', status: 'running' },
      { type: 'tool', id: 't1', name: 'shell', command: 'npm test', status: 'completed' },
      { type: 'response', id: 'r1', text: 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.' },
    ];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: [],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        rules: [
          { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kindPaths: ['name'], summaryPaths: ['command'], statusPath: 'status' },
          { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        ],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
      subscription: {},
    };
    const actions = [];
    const progress = [];
    const verdict = await watchOnce(streamed, 'Implement and verify the requested change.', ctx.dir, ctx.paths, {
      onAgentEvent: (event) => actions.push(event),
      onAgentProgress: (event) => progress.push(event),
    });
    assert.equal(verdict.ok, true);
    assert.equal(actions.length, 3);
    assert.equal(actions[1].status, 'completed');
    assert.equal(actions[2].kind, 'response');
    assert.equal(progress.length, 3);
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /^Completed the requested/);
  } finally {
    ctx.cleanup();
  }
});

test('connector timeout metadata is advisory unless the caller explicitly opts in', async () => {
  const ctx = makeCtx();
  try {
    const activity = [];
    const v = await watchOnce(
      { ...connector, timeoutSec: 0.01 },
      'SLEEP_MS:80 finish the requested work.',
      ctx.dir,
      ctx.paths,
      { onActivity: (event) => activity.push(event) },
    );
    assert.equal(v.ok, true);
    assert.equal(v.meta.timedOut, false);
    assert.ok(v.meta.wallSec >= 0.08);
    assert.ok(activity.some((event) => event.stream === 'stdout' && event.bytes > 0));
  } finally {
    ctx.cleanup();
  }
});

test('an explicit caller timeout remains an opt-in termination control', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(
      connector,
      'SLEEP_MS:100 finish the requested work.',
      ctx.dir,
      ctx.paths,
      { timeoutSec: 0.02 },
    );
    assert.equal(v.ok, false);
    assert.equal(v.meta.timedOut, true);
    assert.match(v.why, /timeout after 0\.02s/);
  } finally {
    ctx.cleanup();
  }
});

test('connector-owned model selection replaces or appends the declared flag', () => {
  const base = {
    spawn: { cmd: ['agent', '--model', 'old', '{taskFile}'] },
    modelSelection: { flag: '--model', mode: 'replace-or-append' },
  };
  assert.deepEqual(argvWithModel(base, { taskFile: '/t', cwd: '/c' }, 'new'),
    ['agent', '--model', 'new', '/t']);
  assert.deepEqual(argvWithModel({ ...base, spawn: { cmd: ['agent', '{taskFile}'] } },
    { taskFile: '/t', cwd: '/c' }, 'new'), ['agent', '/t', '--model', 'new']);
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

test('a streamed auth or quota signature terminates a provider that would otherwise hang', async () => {
  const ctx = makeCtx();
  try {
    const startedAt = Date.now();
    const v = await watchOnce(connector, 'FAIL:auth-hang please', ctx.dir, ctx.paths);
    assert.equal(v.ok, false);
    assert.match(v.why, /auth\/throttle signature/);
    assert.equal(v.quarantineHint, true);
    assert.ok(Date.now() - startedAt < 2000);
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
