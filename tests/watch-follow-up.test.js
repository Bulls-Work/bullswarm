import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchOnce, FOLLOW_UP_PROMPT } from '../src/lib/watch.js';

function context() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-watch-follow-up-'));
  return {
    dir,
    paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const shortOpening = 'I inspected the requested workspace and started the implementation.';
const longReport = [
  '## Completed',
  '',
  'Implemented the requested recovery behavior and verified the durable report path.',
  '',
  '- Changed src/lib/watch.js and preserved the original event stream.',
  '- Ran the focused watcher checks and confirmed every assertion passed.',
  '- No contract deviations or shared-file requests remain.',
].join('\n');

function rowsScript(rows) {
  return `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));`;
}

function connector({ followUp = false, report = longReport } = {}) {
  const initialRows = [
    { type: 'thread.started', thread_id: 'thread-follow-up-1' },
    { type: 'response', id: 'r1', text: shortOpening },
    { type: 'tool', id: 't1', command: 'npm test', status: 'completed' },
  ];
  const spec = {
    name: 'fixture-follow-up',
    spawn: { cmd: [process.execPath, '-e', rowsScript(initialRows)] },
    authSignatures: [],
    outputExtraction: { strategy: 'event-stream' },
    eventStream: {
      format: 'jsonl',
      rules: [
        { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
        { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kind: 'tool', summaryPaths: ['command'], statusPath: 'status' },
      ],
      usage: [{ match: { path: 'type', equals: 'thread.started' }, mode: 'last', fields: { sessionId: 'thread_id' } }],
      output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
    },
    subscription: {},
  };
  if (followUp) {
    spec.conversation = {
      followUp: {
        cmd: [
          process.execPath,
          '-e',
          `console.log(JSON.stringify({type:'response', id:'r2', text:${JSON.stringify(report)}}));`,
          '{sessionId}',
          '{prompt}',
        ],
      },
    };
  }
  return spec;
}

test('truncated event-stream output uses one connector-declared follow-up turn', async () => {
  const ctx = context();
  try {
    const verdict = await watchOnce(connector({ followUp: true }), 'Implement the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.ok, true, verdict.why);
    assert.equal(verdict.outputTruncated, true);
    assert.equal(verdict.outputSource, 'follow-up');
    assert.equal(verdict.meta.outputTruncated, true);
    assert.equal(verdict.meta.outputSource, 'follow-up');
    assert.match(readFileSync(ctx.paths.outFile, 'utf8'), /Implemented the requested recovery behavior/);
    assert.doesNotMatch(readFileSync(ctx.paths.outFile, 'utf8'), /I inspected the requested workspace/);
    assert.equal(FOLLOW_UP_PROMPT, 'Your previous turn ended without a final report. Write it now: what you changed per file, the test summary lines, contract deviations, shared-file requests.');
  } finally {
    ctx.cleanup();
  }
});

test('truncated output without follow-up is replaced by a derived workspace report', async () => {
  const ctx = context();
  try {
    const spec = connector();
    spec.spawn.cmd = [
      process.execPath,
      '-e',
      rowsScript([
        { type: 'thread.started', thread_id: 'thread-derived-1' },
        { type: 'response', id: 'r1', text: shortOpening },
        { type: 'tool', id: 't1', command: 'npm test\n# tests 2\n# pass 2\n# fail 0', status: 'completed' },
      ]),
    ];
    const verdict = await watchOnce(spec, 'Implement the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.outputTruncated, true);
    assert.equal(verdict.outputSource, 'derived');
    const output = readFileSync(ctx.paths.outFile, 'utf8');
    assert.match(output, /Derived report:/);
    assert.match(output, /Workspace status:/);
    assert.match(output, /Diff stat:/);
    assert.match(output, /Test summary:/);
    assert.match(output, /# tests 2/);
    assert.match(output, /# pass 2/);
    assert.match(output, /# fail 0/);
  } finally {
    ctx.cleanup();
  }
});

test('a non-truncated response is untouched and does not trigger recovery', async () => {
  const ctx = context();
  try {
    const report = `${longReport}\n${'Verified. '.repeat(80)}`;
    const spec = connector({ report });
    spec.spawn.cmd = [
      process.execPath,
      '-e',
      rowsScript([
        { type: 'thread.started', thread_id: 'thread-complete-1' },
        { type: 'tool', id: 't1', command: 'npm test', status: 'completed' },
        { type: 'response', id: 'r1', text: report },
      ]),
    ];
    const verdict = await watchOnce(spec, 'Implement the task.', ctx.dir, ctx.paths);
    assert.equal(verdict.outputTruncated, undefined);
    assert.equal(verdict.outputSource, undefined);
    assert.equal(readFileSync(ctx.paths.outFile, 'utf8'), report);
  } finally {
    ctx.cleanup();
  }
});
