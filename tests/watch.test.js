import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchOnce, argvWithModel } from '../src/lib/watch.js';
import { parseQuotaResetAt } from '../src/lib/quota.js';
import { resolveReasoningLevel } from '../src/lib/reasoning.js';

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
      { type: 'tool', model: 'fixture-model', id: 't1', name: 'shell', command: 'npm test', status: 'running' },
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
        modelPaths: ['model'],
        rules: [
          { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kindPaths: ['name'], summaryPaths: ['command'], statusPath: 'status' },
          { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        ],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
      modelProfiles: [{ match: '^fixture-model$', pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }],
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
    assert.equal(verdict.meta.usage.model, 'fixture-model');
    assert.ok(verdict.meta.usage.cost.estimatedUsd > 0);
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /^Completed the requested/);
  } finally {
    ctx.cleanup();
  }
});

test('connector-declared event-stream errors outrank a missing structured candidate', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'text', part: { text: 'I am preparing the durable candidate.' } },
      { type: 'error', error: { message: 'stream disconnected before completion' } },
    ];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: [],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        failureTypes: ['error'],
        output: [{ match: { path: 'type', equals: 'text' }, path: 'part.text', mode: 'concat' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Write and validate the candidate.', ctx.dir, ctx.paths, {
      outputValidator: () => ({ ok: false, errors: ['candidate file missing'] }),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failureKind, 'provider');
    assert.equal(verdict.meta.providerFailureType, 'error');
    assert.match(verdict.why, /provider stream reported error/);
    assert.doesNotMatch(verdict.why, /candidate file missing/);
  } finally {
    ctx.cleanup();
  }
});

test('event-stream tool output mentioning auth signatures does not kill a healthy agent', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'tool', id: 't1', name: 'read_file', status: 'completed', rawOutput: '27: /unauthorized/i' },
      { type: 'response', id: 'r1', text: 'Completed the requested verification. The source auth matcher was inspected and all acceptance checks passed with no concerns.' },
    ];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: ['unauthorized', 'authentication failed'],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        rules: [
          { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kindPaths: ['name'], statusPath: 'status' },
          { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        ],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Verify auth-related source code.', ctx.dir, ctx.paths);
    assert.equal(verdict.quarantineHint, undefined);
    assert.doesNotMatch(verdict.why, /auth\/throttle signature/);
    assert.equal(verdict.meta.signal, null);
  } finally {
    ctx.cleanup();
  }
});

test('event-stream semantic provider auth error still fails and quarantines', async () => {
  const ctx = makeCtx();
  try {
    const rows = [{ type: 'response', id: 'r1', text: 'Error: unauthorized. Please login again.' }];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: ['unauthorized'],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Do the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.quarantineHint, true);
    assert.match(verdict.why, /auth\/throttle signature/);
  } finally {
    ctx.cleanup();
  }
});

test('exact failed-to-authenticate provider response is error-shaped and quarantines', async () => {
  const ctx = makeCtx();
  try {
    const rows = [{ type: 'response', id: 'r1', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: ['failed to authenticate'],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Do the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.quarantineHint, true);
    assert.match(verdict.why, /auth\/throttle signature/);
  } finally {
    ctx.cleanup();
  }
});

test('event-stream final report may discuss authentication failure without quarantine', async () => {
  const ctx = makeCtx();
  try {
    const report = 'Completed the source audit. The unauthorized matcher is a content scanner; source text containing that term is not itself an authentication failure, and the regression checks passed.';
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `console.log(JSON.stringify({type:'response', text:${JSON.stringify(report)}}))`] },
      authSignatures: ['unauthorized', 'authentication failed'],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Audit auth handling.', ctx.dir, ctx.paths);
    assert.equal(verdict.quarantineHint, undefined);
    assert.doesNotMatch(verdict.why, /auth\/throttle signature/);
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

test('connector-owned reasoning level is appended after the model, before the event-stream args', () => {
  const flagged = {
    name: 'flagged',
    spawn: { cmd: ['agent', '{taskFile}'] },
    modelSelection: { flag: '--model', mode: 'replace-or-append' },
    eventStream: { args: ['--json'] },
    reasoning: { flag: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  };
  assert.deepEqual(
    argvWithModel(flagged, { taskFile: '/t', cwd: '/c' }, 'opus', null, { applied: 'xhigh' }),
    ['agent', '/t', '--model', 'opus', '--effort', 'xhigh', '--json'],
  );
  // A bare level string is accepted as well as the resolved record.
  assert.deepEqual(
    argvWithModel(flagged, { taskFile: '/t', cwd: '/c' }, null, null, 'low'),
    ['agent', '/t', '--effort', 'low', '--json'],
  );
  // After the conversation arguments too, so resume flags stay adjacent.
  assert.deepEqual(
    argvWithModel({
      ...flagged,
      conversation: { newArgs: ['--session-id', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] },
    }, { taskFile: '/t', cwd: '/c' }, null, { sessionId: 'thread-1', resume: true }, { applied: 'max' }),
    ['agent', '/t', '--resume', 'thread-1', '--effort', 'max', '--json'],
  );
  // Nothing appended when the resolver applied no level.
  for (const nothing of [null, { applied: null }, { applied: 'default' }, 'default', { applied: 'bogus' }]) {
    assert.deepEqual(
      argvWithModel(flagged, { taskFile: '/t', cwd: '/c' }, null, null, nothing),
      ['agent', '/t', '--json'],
      JSON.stringify(nothing),
    );
  }
  // A connector with no reasoning block never receives an invented flag.
  assert.deepEqual(
    argvWithModel({ spawn: { cmd: ['agent', '{taskFile}'] } }, { taskFile: '/t', cwd: '/c' }, null, null, { applied: 'max' }),
    ['agent', '/t'],
  );
});

test('a level already pinned in the connector template is replaced, never duplicated', () => {
  const pinned = {
    name: 'pinned',
    spawn: { cmd: ['agent', '--effort', 'low', '{taskFile}'] },
    reasoning: { flag: '--effort', levels: ['low', 'medium', 'high'] },
  };
  assert.deepEqual(
    argvWithModel(pinned, { taskFile: '/t', cwd: '/c' }, null, null, { applied: 'high' }),
    ['agent', '--effort', 'high', '/t'],
  );
  // Trailing flag with no value: append the level rather than corrupt argv.
  assert.deepEqual(
    argvWithModel({ ...pinned, spawn: { cmd: ['agent', '{taskFile}', '--effort'] } },
      { taskFile: '/t', cwd: '/c' }, null, null, { applied: 'high' }),
    ['agent', '/t', '--effort', 'high'],
  );
});

test('the config-args reasoning form substitutes {level} verbatim', () => {
  const configured = {
    name: 'configured',
    spawn: { cmd: ['codex', 'exec', '{taskFile}'] },
    eventStream: { args: ['--json'] },
    reasoning: { args: ['-c', 'model_reasoning_effort={level}'], levels: ['low', 'medium', 'high'] },
  };
  assert.deepEqual(
    argvWithModel(configured, { taskFile: '/t', cwd: '/c' }, null, null, { applied: 'medium' }),
    ['codex', 'exec', '/t', '-c', 'model_reasoning_effort=medium', '--json'],
  );
  assert.deepEqual(
    argvWithModel(configured, { taskFile: '/t', cwd: '/c' }, null, null, { applied: null }),
    ['codex', 'exec', '/t', '--json'],
  );
});

test('a resolved reasoning level reaches the spawned process and is reported on the verdict', async () => {
  const ctx = makeCtx();
  try {
    // The fixture echoes its own argv into the answer, so this asserts the
    // flag reached a REAL process rather than only the argv builder.
    const worker = join(ctx.dir, 'argv-worker.mjs');
    writeFileSync(worker, [
      "const argv = process.argv.slice(2);",
      "console.log('## Completed\\n');",
      "console.log('Ran the bounded task and captured the spawn evidence below.\\n');",
      "console.log('- Spawned argv: ' + JSON.stringify(argv));",
      "console.log('- Read and executed every directive in ' + argv[0] + '.');",
      "console.log('- Ran the focused checks: all passed with exit code 0.');",
      "",
    ].join('\n'));
    const spec = {
      name: 'argv-fixture',
      spawn: { cmd: [process.execPath, worker, '{taskFile}'], cwdMode: 'task-file-dir' },
      authSignatures: [],
      quotaSignatures: [],
      outputExtraction: { strategy: 'stdout' },
      modelSelection: { flag: '--model', mode: 'replace-or-append' },
      reasoning: {
        flag: '--effort',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
      },
      subscription: {},
    };

    const reasoning = resolveReasoningLevel({ connector: spec, tier: 'high' });
    assert.deepEqual(reasoning, { requested: 'xhigh', applied: 'xhigh', source: 'connector', clamped: false });
    const v = await watchOnce(spec, 'Do the thing.', ctx.dir, ctx.paths, { timeoutSec: 60, reasoning });
    assert.equal(v.ok, true, v.why);
    const observed = JSON.parse(readFileSync(ctx.paths.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1]);
    assert.deepEqual(observed, [ctx.paths.taskFile, '--effort', 'xhigh']);
    assert.deepEqual(v.meta.reasoning, {
      requested: 'xhigh', applied: 'xhigh', source: 'connector', clamped: false,
    });

    // The same connector with no level resolved: the process sees no flag,
    // and the verdict says why nothing was sent.
    const silent = await watchOnce(spec, 'Do the thing.', ctx.dir, ctx.paths, {
      timeoutSec: 60,
      reasoning: resolveReasoningLevel({ connector: spec, tier: 'high', runOverride: 'default' }),
    });
    const silentArgv = JSON.parse(readFileSync(ctx.paths.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1]);
    assert.deepEqual(silentArgv, [ctx.paths.taskFile]);
    assert.deepEqual(silent.meta.reasoning, {
      requested: 'default', applied: null, source: 'run', clamped: false,
    });
  } finally {
    ctx.cleanup();
  }
});

test('a verdict always reports a reasoning record, even when nothing was asked', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(connector, 'Do the thing.', ctx.dir, ctx.paths, { timeoutSec: 60 });
    assert.deepEqual(v.meta.reasoning, { requested: null, applied: null, source: 'none', clamped: false });
  } finally {
    ctx.cleanup();
  }
});

test('connector-owned conversation arguments create then resume one session', () => {
  const conversational = {
    spawn: { cmd: ['agent', '-p', '{taskFile}'] },
    eventStream: { args: ['--json'] },
    conversation: {
      newArgs: ['--session-id', '{sessionId}'],
      resumeArgs: ['--resume', '{sessionId}'],
    },
  };
  assert.deepEqual(argvWithModel(conversational, { taskFile: '/t', cwd: '/c' }, null, {
    sessionId: 'thread-1', resume: false,
  }), ['agent', '-p', '/t', '--session-id', 'thread-1', '--json']);
  assert.deepEqual(argvWithModel(conversational, { taskFile: '/t', cwd: '/c' }, null, {
    sessionId: 'thread-1', resume: true,
  }), ['agent', '-p', '/t', '--resume', 'thread-1', '--json']);
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

// --- usage limits (requirement 1) ----------------------------------------

// The message Claude Code really returned in run wf-mtshxsjk-f91d0a, as the
// final stream-json result of attempt integrate-continuation-2.
const SESSION_LIMIT = "You've hit your session limit · resets 8:20pm (Asia/Hong_Kong)";

/** A claude-code-shaped stream-json connector driven by `node -e` rows. */
function streamJsonConnector(script, extra = {}) {
  return {
    name: 'fixture-claude',
    spawn: { cmd: [process.execPath, '-e', script] },
    authSignatures: ['unauthorized', 'authentication failed'],
    quotaSignatures: ['hit your session limit'],
    outputExtraction: { strategy: 'event-stream' },
    eventStream: {
      format: 'jsonl',
      modelPaths: ['model', 'message.model'],
      rules: [
        { rootMatch: { path: 'type', equals: 'assistant' }, forEach: 'message.content', match: { path: 'type', equals: 'text' }, kind: 'response', summaryPaths: ['text'], status: 'completed' },
        { rootMatch: { path: 'type', equals: 'user' }, forEach: 'message.content', match: { path: 'type', equals: 'tool_result' }, idPaths: ['tool_use_id'], kind: 'tool', defaultStatus: 'completed' },
      ],
      output: [{ match: { path: 'type', equals: 'result' }, path: 'result', mode: 'last' }],
    },
    ...extra,
  };
}

const rowsScript = (rows, tail = '') =>
  `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));${tail}`;

test('a stream-json usage limit kills a hanging CLI and quarantines until the parsed reset', async () => {
  const ctx = makeCtx();
  try {
    // Prints the limit as its final result, then hangs for a minute.
    const connector = streamJsonConnector(rowsScript(
      [{ type: 'result', subtype: 'success', is_error: false, result: SESSION_LIMIT }],
      ' setTimeout(() => {}, 60000);',
    ));
    const before = Date.now();
    const v = await watchOnce(connector, 'Do the work.', ctx.dir, ctx.paths);
    const elapsedMs = Date.now() - before;

    assert.equal(v.ok, false);
    assert.equal(v.failureKind, 'quota');
    assert.equal(v.quarantineHint, true);
    assert.equal(v.quarantineSource, 'message');
    // The reset is the next 20:20 in Hong Kong; bound it by the clock either
    // side of the run so the assertion cannot straddle that instant.
    const acceptable = new Set([
      parseQuotaResetAt(SESSION_LIMIT, { now: before }),
      parseQuotaResetAt(SESSION_LIMIT, { now: Date.now() }),
    ]);
    assert.ok(acceptable.has(v.quarantineUntil), `unexpected deadline ${v.quarantineUntil}`);
    assert.equal(
      v.why,
      `usage limit: "${SESSION_LIMIT}" · pool paused until ${new Date(v.quarantineUntil).toISOString()}`,
    );
    assert.equal(v.meta.signal, 'SIGTERM', 'the hanging child was terminated, not waited out');
    assert.equal(v.meta.timedOut, false);
    assert.ok(elapsedMs < 6000, `expected a prompt kill, took ${elapsedMs}ms`);
    assert.equal(v.contentUsableDespiteExit, false);
  } finally {
    ctx.cleanup();
  }
});

test('tool output quoting a usage limit neither kills nor quarantines', async () => {
  const ctx = makeCtx();
  try {
    const report = '## Completed\n\nAudited the quota matcher and its call sites.\n\n'
      + '- Read src/lib/quota.js and confirmed the signature list is the only place the phrases live.\n'
      + '- Ran the focused watcher suite: every check passed with no failures.\n';
    const connector = streamJsonConnector(rowsScript([
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `src/lib/quota.js:30:  'hit your session limit',` }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: report }] } },
      { type: 'result', subtype: 'success', is_error: false, result: report },
    ]));
    const v = await watchOnce(connector, 'Audit the quota matcher.', ctx.dir, ctx.paths);
    assert.equal(v.ok, true);
    assert.equal(v.failureKind, undefined);
    assert.equal(v.quarantineHint, undefined);
    assert.equal(v.quarantineUntil, undefined);
    assert.equal(v.meta.signal, null, 'a healthy agent must not be signalled');
  } finally {
    ctx.cleanup();
  }
});

test('a substantive report discussing usage limits still passes', async () => {
  const ctx = makeCtx();
  try {
    const report = '## Completed\n\nImplemented the recovery path and verified it end to end.\n\n'
      + 'The dispatcher now treats a worker that answers usage limit reached as its own failure '
      + 'kind, so the run moves the action to a pool that still has window left.\n\n'
      + '- A provider answering rate limit exceeded is no longer recorded as a process crash.\n'
      + '- Core state carries the reset deadline the provider named, so the pool returns by itself.\n'
      + '- Ran the focused suites: 11 quota checks and 3 watcher checks passed with no failures.\n';
    const connector = streamJsonConnector(rowsScript([
      { type: 'assistant', message: { content: [{ type: 'text', text: report }] } },
      { type: 'result', subtype: 'success', is_error: false, result: report },
    ]));
    const v = await watchOnce(connector, 'Implement usage-limit recovery.', ctx.dir, ctx.paths);
    assert.equal(v.failureKind, undefined);
    assert.equal(v.quarantineHint, undefined);
    assert.doesNotMatch(v.why, /usage limit:/);
    assert.equal(v.ok, true);
  } finally {
    ctx.cleanup();
  }
});

test('a plain-stdout connector reports a usage limit as quota, not auth', async () => {
  const ctx = makeCtx();
  try {
    const plain = {
      name: 'fixture-plain',
      spawn: { cmd: [process.execPath, '-e', "console.log('Error: rate limit exceeded, resets in 2 hours'); setTimeout(() => {}, 60000);"] },
      authSignatures: ['unauthorized', 'rate limit'],
      outputExtraction: { strategy: 'stdout' },
    };
    const before = Date.now();
    const v = await watchOnce(plain, 'Do the work.', ctx.dir, ctx.paths);
    assert.equal(v.ok, false);
    assert.equal(v.failureKind, 'quota', 'a throttle is not a broken credential');
    assert.equal(v.quarantineSource, 'message');
    assert.ok(v.quarantineUntil >= before + 2 * 60 * 60_000 - 5000);
    assert.ok(v.quarantineUntil <= Date.now() + 2 * 60 * 60_000);
    assert.doesNotMatch(v.why, /auth\/throttle signature/);
  } finally {
    ctx.cleanup();
  }
});
