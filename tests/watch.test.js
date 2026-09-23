import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactBesideTask, attemptCapture, watchOnce, argvWithModel, runDelegate, BoundedCapture, providerErrorRecords } from '../src/lib/watch.js';
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
  readFileSync(join(REPO_ROOT, 'src/providers/echo/connector.json'), 'utf8'),
);
const BULLSWARM_DIR = REPO_ROOT;

// The connector cmd references {bullswarmDir}; substitute for tests.
connector.spawn.cmd = [
  'node',
  join(BULLSWARM_DIR, 'src/providers/echo/echo-worker.mjs'),
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

test('watcher exposes the bounded stderr tail on a failed verdict', async () => {
  const ctx = makeCtx();
  try {
    const failing = {
      name: 'fixture-stderr',
      spawn: {
        cmd: [process.execPath, '-e', "process.stderr.write('API error: 404 model not found\\n'); process.exit(1)"],
      },
    };
    const verdict = await watchOnce(failing, 'Probe the selected model.', ctx.dir, ctx.paths, {
      outputValidator: () => ({ ok: true }),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.meta.exitCode, 1);
    assert.match(verdict.stderrTail, /API error: 404 model not found/);
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

test('a provider auth failure on its own error channel still fails and quarantines', async () => {
  const ctx = makeCtx();
  try {
    const streamed = {
      name: 'fixture-events',
      spawn: {
        cmd: [process.execPath, '-e', "process.stderr.write('Error: unauthorized. Please login again.\\n')"],
      },
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

test('a declared provider failure event naming auth is upstream auth: fail and quarantine', async () => {
  const ctx = makeCtx();
  try {
    const rows = [{ type: 'error', error: { message: 'Failed to authenticate: OAuth session expired and could not be refreshed' } }];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: ['failed to authenticate'],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        failureTypes: ['error'],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Do the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failureKind, 'auth');
    assert.equal(verdict.quarantineHint, true);
    assert.match(verdict.why, /upstream auth failure: "failed to authenticate"/);
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
    const v = await watchOnce(pwdConnector, 'PWD: sample report', ctx.dir, ctx.paths, { timeoutSec: 60 });
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

test('watch records structured Claude usage before text parsing', async () => {
  const ctx = makeCtx();
  try {
    const report = '## Completed\n\nImplemented and verified the requested change.';
    const connector = streamJsonConnector(rowsScript([
      { type: 'assistant', message: { content: [{ type: 'text', text: report }] } },
      {
        type: 'result', result: report, session_id: 'session-claude-1', total_cost_usd: 0.61388,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
          output_tokens: 6,
        },
      },
    ]));
    connector.model = 'claude-opus-5';
    connector.modelProfiles = [{
      match: '^claude-opus-5$',
      pricing: {
        inputUsdPerMillion: 5,
        cacheReadUsdPerMillion: 0.5,
        cacheWrite5mUsdPerMillion: 6.25,
        cacheWrite1hUsdPerMillion: 10,
        outputUsdPerMillion: 25,
      },
    }];
    connector.eventStream.usage = [{
      match: { path: 'type', equals: 'result' },
      mode: 'last',
      fields: {
        sessionId: 'session_id',
        costUsd: 'total_cost_usd',
        standardRead: 'usage.input_tokens',
        cacheRead: 'usage.cache_read_input_tokens',
        cacheWrite5m: 'usage.cache_creation.ephemeral_5m_input_tokens',
        cacheWrite1h: 'usage.cache_creation.ephemeral_1h_input_tokens',
        output: 'usage.output_tokens',
      },
    }];

    const verdict = await watchOnce(connector, 'Implement and verify the change.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.usage.tokenSource, 'provider-reported');
    assert.equal(verdict.meta.usage.costSource, 'local-rate-card');
    assert.equal(verdict.meta.usage.sessionId, 'session-claude-1');
    assert.equal(verdict.meta.usage.cost.estimatedUsd, 0.0002365);
    assert.equal(verdict.meta.usage.tokens.totalKnown, 20);
  } finally {
    ctx.cleanup();
  }
});

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
    // The why is the Q6 decision in plain words: the proof, the line, the reset.
    assert.equal(v.quotaPause.rule, 'message');
    assert.equal(v.quotaPause.line, SESSION_LIMIT);
    assert.equal(v.why, v.quotaPause.why);
    assert.match(v.why, /^usage window spent: provider said "You've hit your session limit · resets 8:20pm \(Asia\/Hong_Kong\)" · paused until .+ \(the reset it named\)/);
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

test('a plain-stdout rate limit is a transient throttle, not auth and not a pause', async () => {
  const ctx = makeCtx();
  try {
    const plain = {
      name: 'fixture-plain',
      spawn: { cmd: [process.execPath, '-e', "console.log('Error: rate limit exceeded, resets in 2 hours'); setTimeout(() => {}, 60000);"] },
      authSignatures: ['unauthorized', 'rate limit'],
      outputExtraction: { strategy: 'stdout' },
    };
    const v = await watchOnce(plain, 'Do the work.', ctx.dir, ctx.paths);
    assert.equal(v.ok, false);
    // `rate limit exceeded` names no spent window (quota.js Q6): a reset two
    // hours out is a wait too long to sit out on this pool, never a pause.
    assert.equal(v.failureKind, 'throttle', 'a throttle is not a broken credential');
    assert.equal(v.quarantineHint, undefined);
    assert.equal(v.quarantineUntil, undefined);
    assert.equal(v.throttleRetrySamePool, false);
    assert.equal(v.quotaPause.rule, 'transient');
    assert.doesNotMatch(v.why, /auth\/throttle signature/);
  } finally {
    ctx.cleanup();
  }
});

test('BoundedCapture keeps everything under its limit and the head plus tail above it', () => {
  const small = new BoundedCapture(10);
  small.push('abc');
  small.push(Buffer.from('def'));
  assert.equal(small.text(), 'abcdef');
  assert.equal(small.dropped, 0);
  assert.equal(small.tail(2), 'ef');

  const big = new BoundedCapture(10);
  big.push('0123456789');
  big.push('ABCDEFGHIJ');
  big.push('klmno');
  assert.equal(big.headText, '01234');
  assert.equal(big.tailText, 'klmno');
  assert.equal(big.dropped, 15);
  assert.equal(big.total, 25);
  assert.equal(big.tail(3), 'mno');
  assert.match(big.text(), /^01234\n…\[bullswarm: 15 characters of this stream were not kept; 25 total\]…\nklmno$/);
});

test('a worker that floods stdout cannot outgrow the kernel: the capture is bounded and nothing throws', async () => {
  const ctx = makeCtx();
  try {
    writeFileSync(ctx.paths.taskFile, 'flood');
    const script = "process.stdout.write('HEAD-MARK\\n'); const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 4096; i++) process.stdout.write(line); process.stdout.write('TAIL-MARK\\n');";
    const flood = {
      name: 'fixture-flood',
      spawn: { cmd: ['node', '-e', script, '{taskFile}'] },
      outputExtraction: { strategy: 'stdout' },
    };
    const limit = 64 * 1024;
    const obs = await runDelegate(flood, ctx.paths.taskFile, ctx.dir, { maxCaptureBytes: limit });
    assert.equal(obs.exitCode, 0);
    assert.ok(obs.stdout.length < limit + 200, `kept ${obs.stdout.length} chars for a ${limit} limit`);
    assert.match(obs.stdout, /^HEAD-MARK\n/);
    assert.match(obs.stdout, /TAIL-MARK\n$/);
    assert.match(obs.stdout, /characters of this stream were not kept/);
    // 4 MiB written, 64 KiB kept: the rest is counted, not lost silently.
    assert.ok(obs.captureTruncated.stdout > 4 * 1024 * 1024 - limit - 1024, `dropped ${obs.captureTruncated.stdout}`);
    assert.equal(obs.captureTruncated.stderr, 0);
  } finally {
    ctx.cleanup();
  }
});

// --- upstream auth failure inside a provider error event --------------------
// The real relay bodies of 2026-09-11, captured from the incident artifacts
// (~/.bullswarm/workflows/wf-mtwyg33h-a19ccd/out-cli-attempt-1.md for the 503).
// The whole event is ONE JSONL line on stdout, and the upstream body it wraps
// is the only place the credential failure is ever stated.

const RELAY_401_EVENT = {
  type: 'error',
  timestamp: 1789130671000,
  sessionID: 'ses_f6f7a4d33ffexfyPWv6ovkXBUh',
  error: {
    name: 'APIError',
    data: {
      message: 'Encountered invalidated oauth token for user, failing request',
      statusCode: 401,
      isRetryable: false,
      responseBody: '{"error":{"message":"Encountered invalidated oauth token for user, failing request","type":"authentication_error","param":"","code":"auth_unavailable"}}',
      metadata: { url: 'https://relay.example/v1/chat/completions' },
    },
  },
};

const RELAY_503_EVENT = {
  type: 'error',
  timestamp: 1789131157930,
  sessionID: 'ses_f6f7a4d33ffexfyPWv6ovkXBUh',
  error: {
    name: 'APIError',
    data: {
      message: 'auth_unavailable: no auth available (providers=codex, model=gpt-5.6-luna; last upstream error: auth_unavailable: Encountered invalidated oauth token: [REDACTED])',
      statusCode: 503,
      isRetryable: true,
      responseBody: '{"error":{"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-luna; last upstream error: auth_unavailable: Encountered invalidated oauth token: [REDACTED])","type":"server_error","param":"","code":"internal_server_error"}}',
      metadata: { url: 'https://relay.example/v1/chat/completions' },
    },
  },
};

const RELAY_NO_CHANNEL_EVENT = {
  type: 'error',
  error: {
    name: 'APIError',
    data: {
      message: 'No available channel for model claude-fable-5-1 under group default (distributor)',
      statusCode: 503,
      metadata: { url: 'https://relay.example/v1/chat/completions' },
    },
  },
};

// The SHIPPED connector, with only its command replaced: the phrases the
// verdict matches are the ones the installation really carries.
const packagedOpenCode2 = JSON.parse(
  readFileSync(join(REPO_ROOT, 'providers/contrib/opencode/connector.json'), 'utf8'),
);
// `--` closes node's own option list: the connector appends its real
// event-stream args (`--format json`), which node would otherwise reject.
const streamingEvent = (event, overrides = {}) => ({
  ...packagedOpenCode2,
  spawn: {
    ...packagedOpenCode2.spawn,
    cmd: [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(event))}); process.exit(1)`, '--'],
  },
  ...overrides,
});

test('a provider error event carrying the real relay 401 body is an auth failure with a quarantine hint', async () => {
  const ctx = makeCtx();
  try {
    const verdict = await watchOnce(streamingEvent(RELAY_401_EVENT), 'Do the thing.', ctx.dir, ctx.paths, {});
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failureKind, 'auth');
    assert.equal(verdict.quarantineHint, true);
    assert.equal(verdict.why, 'upstream auth failure: "auth_unavailable" (provider stream error)');
    assert.ok(verdict.why.length <= 160, `why is ${verdict.why.length} chars`);
    // Still recorded as what the stream said, so the incident stays readable.
    assert.equal(verdict.meta.providerFailureType, 'error');
    assert.equal(verdict.contentUsableDespiteExit, false);
  } finally {
    ctx.cleanup();
  }
});

test('the relay 503 no-auth-available body is the same auth failure, not a retryable provider blip', async () => {
  const ctx = makeCtx();
  try {
    const verdict = await watchOnce(streamingEvent(RELAY_503_EVENT), 'Do the thing.', ctx.dir, ctx.paths, {});
    assert.equal(verdict.failureKind, 'auth');
    assert.equal(verdict.quarantineHint, true);
    assert.match(verdict.why, /^upstream auth failure: "auth_unavailable"/);
  } finally {
    ctx.cleanup();
  }
});

test('a model the relay has no channel for is an auth failure once its provider declares that wording', async () => {
  const ctx = makeCtx();
  try {
    // One reseller's own outage wording is not a shared default: the provider
    // that fronts it declares the phrase through `authSignatures`.
    const declared = { authSignatures: ['no available channel for model'] };
    const verdict = await watchOnce(streamingEvent(RELAY_NO_CHANNEL_EVENT, declared), 'Do the thing.', ctx.dir, ctx.paths, {});
    assert.equal(verdict.failureKind, 'auth');
    assert.equal(verdict.quarantineHint, true);
    assert.equal(verdict.why, 'upstream auth failure: "no available channel for model" (provider stream error)');
    const undeclared = await watchOnce(
      streamingEvent(RELAY_NO_CHANNEL_EVENT, { authSignatures: [] }), 'Do the thing.', ctx.dir, ctx.paths, {},
    );
    assert.notEqual(undeclared.failureKind, 'auth');
    assert.notEqual(undeclared.quarantineHint, true);
  } finally {
    ctx.cleanup();
  }
});

test('the shared default phrases match even when the connector declares none of them', async () => {
  const ctx = makeCtx();
  try {
    const verdict = await watchOnce(
      streamingEvent(RELAY_401_EVENT, { authSignatures: [] }),
      'Do the thing.', ctx.dir, ctx.paths, {},
    );
    assert.equal(verdict.failureKind, 'auth');
    assert.equal(verdict.quarantineHint, true);
  } finally {
    ctx.cleanup();
  }
});

test('a provider error event with unrelated wording stays a provider failure with no quarantine hint', async () => {
  const ctx = makeCtx();
  try {
    const event = {
      type: 'error',
      error: { name: 'APIError', data: { message: 'stream disconnected before completion', statusCode: 502 } },
    };
    const verdict = await watchOnce(streamingEvent(event), 'Do the thing.', ctx.dir, ctx.paths, {});
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failureKind, 'provider');
    assert.equal(verdict.quarantineHint, undefined);
    assert.equal(verdict.why, 'provider stream reported error');
  } finally {
    ctx.cleanup();
  }
});

test('a generic provider stream error is recovered when a usable answer follows and the worker exits 0', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'response', id: 'r1', text: 'Completed the requested implementation, updated the affected files, and verified the relevant tests with no remaining failures.' },
      { type: 'error', error: { message: 'stream disconnected after the answer was flushed' } },
    ];
    const streamed = {
      name: 'fixture-events',
      spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
      authSignatures: [],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        failureTypes: ['error'],
        rules: [
          { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        ],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const verdict = await watchOnce(streamed, 'Implement and verify the requested change.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.failureKind, undefined);
    assert.equal(verdict.notes?.length, 1);
    assert.equal(verdict.notes[0].kind, 'recovered-stream-error');
    assert.match(verdict.notes[0].text, /provider stream reported error/);
    assert.ok(Number.isFinite(Date.parse(verdict.notes[0].at)));
    assert.equal(verdict.meta.providerFailureType, 'error');
  } finally {
    ctx.cleanup();
  }
});

test('an agent that merely reads auth source is not an upstream failure: no error event, no hint', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'text', part: { text: 'Inspected the matcher: an auth_unavailable body from the relay is an authentication_error, and src/lib/auth-signatures.js matches it only on a provider error event. All requested checks were completed and verified.' } },
    ];
    const connectorWithoutError = {
      ...packagedOpenCode2,
      spawn: {
        ...packagedOpenCode2.spawn,
        cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`, '--'],
      },
    };
    const verdict = await watchOnce(connectorWithoutError, 'Inspect the matcher.', ctx.dir, ctx.paths, {});
    assert.equal(verdict.ok, true);
    assert.equal(verdict.quarantineHint, undefined);
  } finally {
    ctx.cleanup();
  }
});

test('watchOnce persists the normalized event stream and reports streamFile on the verdict', async () => {
  const ctx = makeCtx();
  try {
    const long = `Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures. ${'x'.repeat(80)}`;
    const rows = [
      { type: 'tool', model: 'fixture-model', id: 't1', name: 'shell', command: 'npm test', status: 'completed' },
      { type: 'response', id: 'r1', text: long },
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
      model: 'fixture-model',
    };
    const pane = [];
    const streamFile = join(ctx.dir, 'stream-act-attempt-1.jsonl');
    const verdict = await watchOnce(streamed, 'Implement and verify the requested change.', ctx.dir, ctx.paths, {
      streamFile,
      onAgentEvent: (event) => pane.push(event),
    });
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.streamFile, streamFile);
    const persisted = readFileSync(streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].kind, 'shell');
    assert.equal(persisted[0].summary, 'npm test');
    const paneResponse = pane.find((event) => event.kind === 'response');
    const fileResponse = persisted.find((event) => event.kind === 'response');
    assert.equal(paneResponse.summary.length, 180);
    assert.equal(paneResponse.summary.endsWith('\u2026'), true);
    assert.equal(fileResponse.summary, long);
    assert.equal(fileResponse.seq, 2);
    assert.equal(typeof fileResponse.at, 'string');
    assert.ok(Number.isFinite(Date.parse(fileResponse.at)));
  } finally {
    ctx.cleanup();
  }
});

test('eventStream.capture.responseBytes overrides the core per-event bound', async () => {
  const ctx = makeCtx();
  try {
    const long = `Completed the requested implementation. ${'y'.repeat(200)}`;
    const streamed = {
      name: 'fixture-capture',
      spawn: { cmd: [process.execPath, '-e', `console.log(JSON.stringify({type:'response',id:'r1',text:${JSON.stringify(long)}}))`] },
      authSignatures: [],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        capture: { responseBytes: 24, fileBytes: 4096 },
        rules: [
          { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        ],
        output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
      },
    };
    const streamFile = join(ctx.dir, 'stream.jsonl');
    const verdict = await watchOnce(streamed, 'Do the thing.', ctx.dir, { ...ctx.paths, streamFile });
    assert.equal(verdict.ok, true, verdict.why);
    const persisted = JSON.parse(readFileSync(streamFile, 'utf8').trimEnd().split('\n')[0]);
    assert.equal(persisted.kind, 'response');
    assert.ok(Buffer.byteLength(persisted.summary, 'utf8') <= 24);
    assert.notEqual(persisted.summary, long);
  } finally {
    ctx.cleanup();
  }
});

test('a connector with no eventStream persists a bounded stdout log instead of jsonl', async () => {
  const ctx = makeCtx();
  try {
    const stdoutFile = join(ctx.dir, 'stdout-act-attempt-1.log');
    const v = await watchOnce(connector, 'Do the thing.', ctx.dir, ctx.paths, {
      timeoutSec: 60,
      stdoutFile,
    });
    assert.equal(v.ok, true, v.why);
    assert.equal(v.meta.streamFile, stdoutFile);
    const body = readFileSync(stdoutFile, 'utf8');
    assert.match(body, /Completed/);
    assert.doesNotMatch(body, /"truncated":true/);
  } finally {
    ctx.cleanup();
  }
});

test('artifactBesideTask names stream/out/stdout from a task- prefix', () => {
  assert.equal(
    artifactBesideTask('/tmp/runs/task-1789888532139-4y8sg.md', 'stream', '.jsonl'),
    '/tmp/runs/stream-1789888532139-4y8sg.jsonl',
  );
  assert.equal(artifactBesideTask('/tmp/runs/task.md', 'stream', '.jsonl'), null);
  assert.equal(artifactBesideTask(null, 'stream', '.jsonl'), null);
});

function streamedConnector(rows) {
  return {
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
    model: 'fixture-model',
  };
}

test('watchOnce derives stream-<id>.jsonl from a task-<id>.md path and writes from the first event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-watch-stream-'));
  const paths = {
    taskFile: join(dir, 'task-act-1.md'),
    outFile: join(dir, 'out-act-1.md'),
  };
  const streamFile = join(dir, 'stream-act-1.jsonl');
  try {
    const rows = [
      { type: 'tool', id: 't1', name: 'shell', command: 'npm test', status: 'completed' },
      { type: 'response', id: 'r1', text: 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.' },
    ];
    const verdict = await watchOnce(streamedConnector(rows), 'Do the thing.', dir, paths, { timeoutSec: 60 });
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.streamFile, streamFile);
    assert.equal(existsSync(streamFile), true, 'the stream file is created beside the task file');
    const persisted = readFileSync(streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(persisted[0].kind, 'shell');
    assert.equal(persisted[1].kind, 'response');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchOnce writes the live out-*.md tail as events arrive', async () => {
  const ctx = makeCtx();
  try {
    const rows = [
      { type: 'response', id: 'r1', text: 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.' },
    ];
    let live = '';
    const verdict = await watchOnce(streamedConnector(rows), 'Do the thing.', ctx.dir, ctx.paths, {
      timeoutSec: 60,
      onAgentEvent: () => {
        if (existsSync(ctx.paths.outFile)) live = readFileSync(ctx.paths.outFile, 'utf8');
      },
    });
    assert.equal(verdict.ok, true, verdict.why);
    assert.match(live, /^Completed the requested/);
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /^Completed the requested/);
  } finally {
    ctx.cleanup();
  }
});

// ── attempt.capture: what the provider reported, taken at worker exit ────────

const CAPTURE_REPORT = 'Completed the requested implementation, updated the affected files, and verified the full local test suite successfully with no remaining failures.';

test('the capture is handed over at worker exit, before the end meter read and the transcript lookup', async () => {
  const ctx = makeCtx();
  try {
    const order = [];
    const captures = [];
    const connector = streamJsonConnector(rowsScript([
      { type: 'assistant', message: { content: [{ type: 'text', text: CAPTURE_REPORT }] } },
      { type: 'result', result: CAPTURE_REPORT },
    ]));
    const verdict = await watchOnce(connector, 'Implement and verify the change.', ctx.dir, ctx.paths, {
      home: ctx.dir,
      poolName: 'fixture-claude',
      snapshotPool: async () => { order.push('meter'); return null; },
      readTranscriptUsage: () => { order.push('transcript'); return null; },
      onCapture: (capture, usage) => { order.push('capture'); captures.push(capture); assert.equal(usage, null); },
    });
    assert.equal(verdict.ok, true, verdict.why);
    assert.deepEqual(order, ['meter', 'capture', 'meter', 'transcript']);
    // No counters in the stream: the capture says unknown, never an estimate,
    // while the verdict keeps its labelled byte estimate as before.
    assert.equal(captures.length, 1);
    assert.equal(captures[0].tokenSource, 'unknown');
    assert.equal(captures[0].tokens, null);
    assert.equal(captures[0].providerCostUsd, null);
    assert.equal(captures[0].providerSessionId, null);
    assert.equal(captures[0].sessionSource, null);
    assert.equal(captures[0].exitCode, 0);
    assert.equal(captures[0].signal, null);
    assert.equal(captures[0].source, 'event-stream');
    assert.ok(Number.isFinite(Date.parse(captures[0].capturedAt)));
    assert.equal(verdict.meta.usage.tokenSource, 'estimated:utf8-bytes/4');
    assert.deepEqual(verdict.meta.capture, captures[0]);
  } finally {
    ctx.cleanup();
  }
});

test('usage-finalized says once whether a transcript reader could price the attempt later', async () => {
  const ctx = makeCtx();
  try {
    const connector = streamJsonConnector(rowsScript([
      { type: 'assistant', message: { content: [{ type: 'text', text: CAPTURE_REPORT }] } },
      { type: 'result', result: CAPTURE_REPORT },
    ]));
    const seen = [];
    const run = (extra) => watchOnce(connector, 'Implement and verify the change.', ctx.dir, ctx.paths, {
      home: ctx.dir, poolName: 'fixture-claude', snapshotPool: async () => null,
      onUsageFinalized: (facts) => seen.push(facts), ...extra,
    });
    // A pool with a reader: a detached pass may find its transcript later.
    assert.equal((await run({ readTranscriptUsage: () => null })).ok, true);
    // A pool no provider keeps a transcript for: nothing later could price it.
    assert.equal((await run({ providers: [] })).ok, true);
    assert.deepEqual(seen.map((facts) => [facts.usage.tokenSource, facts.transcriptReader, facts.poolName]), [
      ['estimated:utf8-bytes/4', true, 'fixture-claude'],
      ['estimated:utf8-bytes/4', false, 'fixture-claude'],
    ]);
  } finally {
    ctx.cleanup();
  }
});

test('a capture carries provider counters, provider cost and the provider session id', async () => {
  const ctx = makeCtx();
  try {
    const captures = [];
    const connector = streamJsonConnector(rowsScript([
      { type: 'assistant', message: { content: [{ type: 'text', text: CAPTURE_REPORT }] } },
      {
        type: 'result', result: CAPTURE_REPORT, session_id: 'session-capture-1', total_cost_usd: 0.61388,
        usage: { input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } },
      },
    ]));
    connector.eventStream.usage = [{
      match: { path: 'type', equals: 'result' },
      mode: 'last',
      fields: {
        sessionId: 'session_id', costUsd: 'total_cost_usd', standardRead: 'usage.input_tokens',
        cacheRead: 'usage.cache_read_input_tokens', output: 'usage.output_tokens',
        reasoning: 'usage.output_tokens_details.thinking_tokens',
      },
      inclusive: { output: ['reasoning'] },
    }];
    connector.conversation = { newArgs: ['--session-id', '{sessionId}'] };
    connector.spawn.cmd.push('--'); // the appended session flags go to the script, not node
    const usages = [];
    const verdict = await watchOnce(connector, 'Implement and verify the change.', ctx.dir, ctx.paths, {
      conversation: { sessionId: 'bullswarm-assigned-1', resume: false },
      onCapture: (capture, usage) => { captures.push(capture); usages.push(usage); },
    });
    assert.equal(verdict.ok, true, verdict.why);
    // The provider-reported usage envelope rides along, already the record
    // the verdict ends with (minus the end-of-attempt meter accounting).
    assert.equal(usages[0].tokenSource, 'provider-reported');
    assert.equal(usages[0].sessionId, 'session-capture-1');
    assert.deepEqual(usages[0].tokens, verdict.meta.usage.tokens);
    assert.equal(captures[0].tokenSource, 'provider-reported');
    assert.deepEqual(captures[0].tokens, {
      standardRead: 2, cacheRead: 3, cacheWrite5m: null, cacheWrite1h: null, cacheWrite: null,
      output: 5, reasoning: 4, totalKnown: 14,
    });
    assert.equal(captures[0].providerCostUsd, 0.61388);
    // The stream's own id outranks the one Bullswarm put on the command line.
    assert.equal(captures[0].providerSessionId, 'session-capture-1');
    assert.equal(captures[0].sessionSource, 'provider-stream');
    assert.deepEqual(verdict.meta.usage.tokens, captures[0].tokens);
  } finally {
    ctx.cleanup();
  }
});

test('a capture names the session id Bullswarm handed the CLI only when the argv carried it', () => {
  const connector = { name: 'fixture', eventStream: { format: 'jsonl' }, conversation: { newArgs: ['--session-id', '{sessionId}'] } };
  const conversation = { sessionId: 'assigned-1', resume: false };
  const handed = attemptCapture(connector, { exitCode: 1, signal: null, reportedUsage: null }, { conversation, at: '2026-09-21T00:00:00.000Z' });
  assert.equal(handed.providerSessionId, 'assigned-1');
  assert.equal(handed.sessionSource, 'bullswarm-assigned');
  assert.equal(handed.exitCode, 1);
  const notHanded = attemptCapture({ ...connector, conversation: { followUp: { cmd: ['x', '{sessionId}'] } } }, { exitCode: 0 }, { conversation });
  assert.equal(notHanded.providerSessionId, null);
  assert.equal(notHanded.sessionSource, null);
  // A stream that reported only its session id reported no counters.
  const idOnly = attemptCapture(connector, { exitCode: 0, reportedUsage: { sessionId: 'provider-1' } }, { conversation });
  assert.equal(idOnly.providerSessionId, 'provider-1');
  assert.equal(idOnly.tokenSource, 'unknown');
  assert.equal(idOnly.tokens, null);
  // A killed worker reports its signal and no exit code.
  const killed = attemptCapture(connector, { exitCode: null, signal: 'SIGTERM' }, {});
  assert.deepEqual([killed.exitCode, killed.signal, killed.source], [null, 'SIGTERM', 'event-stream']);
});

test('a capture sink that throws never costs the attempt its verdict', async () => {
  const ctx = makeCtx();
  try {
    const verdict = await watchOnce(connector, 'Do the thing.', ctx.dir, ctx.paths, {
      timeoutSec: 60,
      onCapture: () => { throw new Error('kernel lease lost'); },
    });
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.meta.capture.source, 'exit-status');
    assert.equal(verdict.meta.capture.exitCode, 0);
  } finally {
    ctx.cleanup();
  }
});

test('command-code is spawned without --no-session so its transcript persists', () => {
  const commandCode = JSON.parse(readFileSync(join(REPO_ROOT, 'providers/contrib/command-code/connector.json'), 'utf8'));
  const argv = argvWithModel(commandCode, { taskFile: '/tmp/task.md', cwd: '/tmp' });
  assert.equal(argv.includes('--no-session'), false);
  assert.equal(argv.includes('--tools-all'), false);
  assert.ok(argv.includes('--yolo'));
  assert.deepEqual(argv.slice(0, 2), ['command-code', '-p']);
  assert.ok(argv.includes('--output-format'));
});

// quota.js Q6 end to end: a real child prints the provider's own line, and
// the verdict carries the pause decision the quarantine will record.

const REAL_TRANSIENT = 'Error: Rate limit exceeded. Please wait a moment and try again.';

function limitChild(line) {
  return {
    name: 'fixture-limit',
    spawn: { cmd: [process.execPath, '-e', `console.log(${JSON.stringify(line)}); setTimeout(() => {}, 60000);`] },
    authSignatures: ['unauthorized'],
    outputExtraction: { strategy: 'stdout' },
  };
}

function limitHome({ usedPct = 48, pausing = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-watch-limit-'));
  mkdirSync(join(home, 'meters'), { recursive: true });
  const ahead = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  writeFileSync(join(home, 'meters', 'fixture-limit.json'), JSON.stringify({
    captured_at: new Date().toISOString(), pool: 'fixture-limit',
    five_hour: { utilization: 48, resets_at: ahead(2) },
    seven_day: { utilization: usedPct, resets_at: ahead(50) },
  }));
  if (pausing) writeFileSync(join(home, 'state.json'), JSON.stringify({ strategy: { pausing } }));
  return home;
}

test('the real transient line is a throttle with no pause while the meter reads below 95%', async () => {
  const ctx = makeCtx();
  const home = limitHome({ usedPct: 78 });
  try {
    const v = await watchOnce(limitChild(REAL_TRANSIENT), 'Do the work.', ctx.dir, ctx.paths, {
      bullswarmDir: home, poolName: 'fixture-limit',
    });
    assert.equal(v.failureKind, 'throttle');
    assert.equal(v.quarantineHint, undefined);
    assert.equal(v.quotaPause.rule, 'transient');
    assert.equal(v.quotaPause.line, REAL_TRANSIENT);
    assert.match(v.why, /^rate limited \(transient\): "Error: Rate limit exceeded\. Please wait a moment and try again\." · pool not paused \(meter 5h 48% · weekly 78%, below 95%/);
  } finally {
    ctx.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the same line pauses when the pool\'s own meter reads 96%, until that window resets', async () => {
  const ctx = makeCtx();
  const home = limitHome({ usedPct: 96 });
  try {
    const v = await watchOnce(limitChild(REAL_TRANSIENT), 'Do the work.', ctx.dir, ctx.paths, {
      bullswarmDir: home, poolName: 'fixture-limit',
    });
    assert.equal(v.failureKind, 'quota');
    assert.equal(v.quarantineHint, true);
    assert.equal(v.quotaPause.rule, 'meter');
    assert.equal(v.quotaPause.meterWindow.usedPct, 96);
    assert.equal(v.quarantineUntil, v.quotaPause.until);
    assert.equal(v.quarantineSource, 'meter');
  } finally {
    ctx.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('with automatic pausing off even a spent window with a reset is retried, not paused', async () => {
  const ctx = makeCtx();
  const home = limitHome({ usedPct: 100, pausing: 'off' });
  try {
    const v = await watchOnce(limitChild("You've hit your session limit · resets in 2 hours"), 'Do the work.', ctx.dir, ctx.paths, {
      bullswarmDir: home, poolName: 'fixture-limit',
    });
    assert.equal(v.failureKind, 'throttle');
    assert.equal(v.quarantineHint, undefined);
    assert.equal(v.quotaPause.rule, 'off');
    assert.match(v.why, /pool not paused: automatic pausing is off/);
  } finally {
    ctx.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- the provider's error channel (W7) -------------------------------------
// The false positive of 2026-09-21: a pool was paused with the reason
// `usage limit: "Codex's `usage_credits_required` is spent-credit wording, not
// a throttle …"` — a sentence from the agent's OWN reply. The classifiers read
// the provider's channel only: its stderr, its error events and its terminal
// record.

const AGENT_QUOTE = "Codex's `usage_credits_required` is spent-credit wording, not a throttle";

/** A codex-shaped stream: the phrase is both a quota and an auth signature. */
function codexShaped(rows) {
  return {
    name: 'fixture-codex',
    spawn: { cmd: [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
    authSignatures: ['usage_credits_required'],
    quotaSignatures: ['usage_credits_required', 'usage limit'],
    outputExtraction: { strategy: 'event-stream' },
    eventStream: {
      format: 'jsonl',
      rules: [
        { rootMatch: { path: 'type', equals: 'item.completed' }, idPaths: ['item.id'], kindPaths: ['item.type'], kindMap: { agent_message: 'response' }, summaryPaths: ['item.text'], status: 'completed' },
      ],
      output: [{ match: { path: 'type', equals: 'item.completed' }, path: 'item.text', mode: 'last' }],
    },
  };
}

test('a quota-shaped sentence in the agent\'s own reply never pauses a pool', async () => {
  const ctx = makeCtx();
  try {
    const report = [
      '## Completed',
      '',
      `${AGENT_QUOTE}, so the matcher was audited and the message channel left alone.`,
      '',
      '- Read src/lib/quota.js and confirmed the classifier reads only the provider error channel.',
      '- Ran the focused watcher suite: every check passed with no failures.',
    ].join('\n');
    const v = await watchOnce(codexShaped([
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: report } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]), 'Audit the matcher.', ctx.dir, ctx.paths);
    assert.equal(v.ok, true, v.why);
    assert.equal(v.failureKind, undefined);
    assert.equal(v.quarantineHint, undefined);
    assert.equal(v.quotaPause, undefined);
    assert.equal(v.meta.signal, null, 'a healthy agent must not be signalled');
  } finally {
    ctx.cleanup();
  }
});

test('the same sentence on the provider\'s error event is classified, not ignored', async () => {
  const ctx = makeCtx();
  try {
    const v = await watchOnce(codexShaped([
      { type: 'error', message: `${AGENT_QUOTE}, so this request was refused.` },
    ]), 'Audit the matcher.', ctx.dir, ctx.paths);
    assert.equal(v.ok, false);
    // The phrase names no reset, so it is a transient throttle (quota.js Q6):
    // the attempt backs off here and then moves on, and the pool is not paused.
    assert.equal(v.failureKind, 'throttle');
    assert.equal(v.quarantineHint, undefined);
    // The provider's own record carries the words, so the pause reason names
    // the sentence rather than dropping a failure the provider did report.
    assert.match(v.quotaPause.line, /usage_credits_required/);
  } finally {
    ctx.cleanup();
  }
});

test('with automatic pausing off a dead credential is a provider failure, not a bench', async () => {
  const ctx = makeCtx();
  const authChild = () => ({
    name: 'fixture-auth',
    spawn: { cmd: [process.execPath, '-e', "process.stderr.write('Error: unauthorized. Please login again.\\n'); process.exit(1)"] },
    authSignatures: ['unauthorized'],
    outputExtraction: { strategy: 'stdout' },
  });
  const on = limitHome({ pausing: null });
  const off = limitHome({ pausing: 'off' });
  try {
    const benched = await watchOnce(authChild(), 'Do the work.', ctx.dir, ctx.paths, {
      bullswarmDir: on, poolName: 'fixture-limit',
    });
    assert.equal(benched.quarantineHint, true, 'on: the dead credential asks for a bench');
    assert.doesNotMatch(benched.why, /automatic pausing is off/);

    const moving = await watchOnce(authChild(), 'Do the work.', ctx.dir, ctx.paths, {
      bullswarmDir: off, poolName: 'fixture-limit',
    });
    assert.equal(moving.quarantineHint, undefined, 'off: no verdict asks for a pause');
    assert.equal(moving.failureKind, 'provider', 'off: a mechanical failure that retries elsewhere');
    assert.match(moving.why, /auth\/throttle signature: "unauthorized" · automatic pausing is off, pool not paused/);
  } finally {
    ctx.cleanup();
    rmSync(on, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  }
});

test('the error-channel scan keeps provider records and drops agent prose', () => {
  const kept = providerErrorRecords([
    '{"type":"item.completed","item":{"id":"a1","type":"agent_message","text":"usage_credits_required is spent-credit wording"}}',
    '{"type":"error","error":{"message":"auth_unavailable: no auth available"}}',
    '{"type":"result","result":"You\'ve hit your session limit · resets 8:20pm"}',
    'plain prose mentioning rate limit exceeded',
  ].join('\n'), ['error']);
  assert.match(kept, /auth_unavailable: no auth available/, 'an error event is evidence');
  assert.match(kept, /You've hit your session limit · resets 8:20pm/, 'the terminal record is evidence');
  assert.doesNotMatch(kept, /agent_message/, 'an agent message is not a provider record');
  assert.doesNotMatch(kept, /plain prose/, 'non-JSON transport lines are not provider records');
  // A terminal record that mirrors the agent's own reply is the reply, not the
  // provider's report (Claude Code writes the final message into `result`).
  const mirrored = providerErrorRecords(
    '{"type":"result","result":"Completed the audit and verified every check passed."}',
    [],
    { agentText: 'Completed the audit and verified every check passed.\nMore detail follows.' },
  );
  assert.equal(mirrored, '', 'a mirrored reply is not evidence');
});
