// New ground through the REAL packaged claude-code connector: the target of a
// tool call is the tool name plus its full arguments, so a Grep with a new
// pattern (even under the same path), a Read with a new offset, a WebSearch
// with a new query, a WebFetch with a new url and a Task with a new prompt are
// all new ground, and the exact same call repeated is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { createNewGroundTracker } from '../src/lib/new-ground.js';
import { saveState } from '../src/lib/state.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const EVENT_STREAM = JSON.parse(
  readFileSync(new URL('../src/providers/claude-code/connector.json', import.meta.url), 'utf8'),
).eventStream;

const toolUse = (n, name, input) => JSON.stringify({
  type: 'assistant', uuid: `u${n}`,
  message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name, input }] },
});

// Feeds calls one per clock tick and returns lastAt() after each.
function lastAtAfterEach(calls) {
  let clock = 0;
  const tracker = createNewGroundTracker({ cwd: '/work', startedAtMs: 0, now: () => clock });
  const decoder = createAgentEventDecoder(EVENT_STREAM, { onEvent: (event, full) => tracker.observe(event, full) });
  return calls.map(([name, input], i) => {
    clock = (i + 1) * 1000;
    decoder.push(`${toolUse(i, name, input)}\n`);
    return tracker.lastAt();
  });
}
const ticks = [1000, 2000, 3000, 4000, 5000];

test('Grep with a new pattern under the same path is new ground every time', () => {
  const calls = [1, 2, 3, 4, 5].map((i) => ['Grep', { pattern: `foo${i}`, path: 'src' }]);
  assert.deepEqual(lastAtAfterEach(calls), ticks);
});

test('WebSearch with a new query is new ground every time', () => {
  const calls = [1, 2, 3, 4, 5].map((i) => ['WebSearch', { query: `q${i}` }]);
  assert.deepEqual(lastAtAfterEach(calls), ticks);
});

test('WebFetch with a new url and Task with a new prompt are new ground', () => {
  assert.deepEqual(lastAtAfterEach([1, 2, 3, 4, 5].map((i) => ['WebFetch', { url: `https://x.test/${i}`, prompt: 'p' }])), ticks);
  assert.deepEqual(lastAtAfterEach([1, 2, 3, 4, 5].map((i) => ['Task', { description: 'd', prompt: `go ${i}` }])), ticks);
});

test('Read of one file with five distinct offsets is new ground every time', () => {
  const calls = [100, 200, 300, 400, 500].map((offset) => ['Read', { file_path: '/work/big.js', offset, limit: 100 }]);
  assert.deepEqual(lastAtAfterEach(calls), ticks);
});

test('the exact same Read repeated is not new ground, and key order or a relative path does not change it', () => {
  const calls = [
    ['Read', { file_path: '/work/a.js', offset: 1, limit: 50 }],
    ['Read', { file_path: '/work/a.js', offset: 1, limit: 50 }],
    ['Read', { limit: 50, offset: 1, file_path: 'a.js' }],
    ['Read', { file_path: '/work/a.js', offset: 1, limit: 50 }],
  ];
  assert.deepEqual(lastAtAfterEach(calls), [1000, 1000, 1000, 1000]);
});

test('an event with no arguments falls back to its kind and summary', () => {
  let clock = 0;
  const tracker = createNewGroundTracker({ cwd: '/work', startedAtMs: 0, now: () => clock });
  clock = 1000; tracker.observe({ kind: 'command', summary: 'ls' });
  clock = 2000; tracker.observe({ kind: 'command', summary: 'ls' });
  clock = 3000; tracker.observe({ kind: 'command', summary: 'pwd' });
  assert.equal(tracker.lastAt(), 3000);
});

test('the remembered set is bounded but new targets keep restarting the clock', () => {
  let clock = 0;
  const tracker = createNewGroundTracker({ cwd: '/work', startedAtMs: 0, now: () => clock });
  for (let i = 0; i < 20_050; i += 1) { clock = i + 1; tracker.observe({ kind: 'Grep', summary: 'src', arguments: { pattern: `p${i}` } }); }
  assert.equal(tracker.lastAt(), 20_050);
});

test('a worker repeating the exact same Read through the real connector is stopped; varied offsets are not', { timeout: 30_000 }, async (t) => {
  const run = async (input) => {
    const script = `let n = 0; const timer = setInterval(() => { n += 1; console.log(JSON.stringify({ type: 'assistant', uuid: 'u' + n, message: { id: 'm' + n, content: [{ type: 'tool_use', id: 't' + n, name: 'Read', input: ${input} }] } })); }, 100);`
      + " setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ type: 'result', result: 'Completed the requested analysis, read the affected files, and summarized the findings together with the remaining risks.' })); }, 3500);";
    const pool = {
      name: 'worker', enabled: true, lanes: ['analyze'],
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      spawn: { cmd: [process.execPath, '-e', script, '--', '{taskFile}'] },
      authSignatures: [], outputExtraction: { strategy: 'event-stream' }, eventStream: EVENT_STREAM,
      meter: { type: 'none' }, model: 'worker/model', modelSelection: { flag: '--model' },
      strategyAssignments: { low: { pool: 'worker', model: 'worker/model' } },
    };
    const home = mkdtempSync(join(tmpdir(), 'bs-new-ground-real-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    saveState(home, { version: 1, pools: { worker: { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } });
    return dispatchV2Action({
      action: { id: 'read', lane: 'analyze', effort: 'low' }, taskText: 'Read.', targetDir: home,
      paths: (o) => ({ taskFile: join(home, `task-${o}.md`), outFile: join(home, `out-${o}.md`) }),
      pools: [pool], bullswarmDir: home, silenceTimeoutSec: 30, noProgressTimeoutSec: 0,
      maxMechanicalRetries: 0, noNewGroundTimeoutSec: 1,
    });
  };
  const same = await run("{ file_path: 'a.js', offset: 1, limit: 50 }");
  assert.equal(same.attempts[0].failureKind, 'stalled');
  assert.equal(same.attempts[0].noNewGroundSec, 1);
  const paged = await run("{ file_path: 'a.js', offset: n * 50, limit: 50 }");
  assert.equal(paged.attempts[0].stalled, undefined);
  assert.equal(paged.ok, true);
});
