import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  adaptTaskRecord,
  taskRecordToStepInput,
  taskStepInput,
  taskStepModel,
} from '../src/workflow/task-step.js';
import { renderStepPage } from '../src/workflow/step-view.js';
import { runDashboard } from '../src/workflow/dashboard.js';

const REAL_HOME = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
const REAL_RUNS = join(REAL_HOME, 'runs');
const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');
const ANSWERING = join(REPO, 'tests', 'fixtures', 'answering-connector.mjs');

function bodyFor() {
  return { lines: [], push(line = '') { this.lines.push(String(line)); } };
}

function plain(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  pause() {}
  resume() {}
  press(key) { this.emit('data', key); }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 32;
  text = '';
  write(value) { this.text += String(value); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The painted rows a chunk of terminal output positions, as `[row, text]`. */
function positionedRows(chunk) {
  const parts = String(chunk).split(/\x1b\[(\d+);1H/);
  const rows = [];
  for (let at = 1; at < parts.length; at += 2) rows.push([Number(parts[at]), parts[at + 1]]);
  return rows;
}

test('task adapter reads the record and copied sibling artifacts without following source-home paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-'));
  try {
    const recordPath = join(root, 'task-record.json');
    writeFileSync(join(root, 'task-copy.md'), 'Inspect the copied task.\nKeep unknowns honest.\n');
    writeFileSync(join(root, 'out-copy.md'), 'copied output\n');
    writeFileSync(recordPath, JSON.stringify({
      id: 'copied-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
      project: 'bullswarm', startedAt: '2026-09-19T23:58:00.000Z',
      endedAt: '2026-09-20T00:00:00.000Z', durationMs: 120000, ok: true,
      taskFile: '/source-home/runs/task-copy.md', outFile: '/source-home/runs/out-copy.md',
    }));
    const input = taskStepInput(recordPath, { runsDir: root });
    assert.equal(input.row.state.attempts[0].pool, 'codex');
    assert.equal(input.row.state.attempts[0].effort, null);
    assert.equal(input.row.state.attempts[0].taskFile, join(root, 'task-copy.md'));
    assert.equal(input.row.state.attempts[0].outputFile, join(root, 'out-copy.md'));
    assert.equal(input.row.state.attempts[0].streamFile, null);
    assert.equal(input.row.state.attempts[0].usage, null);
    assert.equal(adaptTaskRecord, taskStepInput);
    assert.equal(taskRecordToStepInput, taskStepInput);

    const model = taskStepModel(recordPath, { runsDir: root, nowMs: NOW });
    assert.deepEqual(model.task.lines, ['Inspect the copied task.', 'Keep unknowns honest.']);
    assert.deepEqual(model.resultBlock.output.lines, ['copied output', '']);
    assert.equal(model.header.activeDurationMs, 120000);
    assert.equal(model.identity.workflowStatus, null);
    assert.equal(model.identity.verified, null);
    assert.equal(model.availability.verificationAvailable, false);
    assert.ok(model.artifacts.task.startsWith(root));
    assert.equal(model.artifacts.record, recordPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task adapter carries only supplied effort, usage, and structured stream facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-stream-'));
  try {
    writeFileSync(join(root, 'task.md'), 'Run the bounded task.\n');
    writeFileSync(join(root, 'out.md'), 'result text\n');
    writeFileSync(join(root, 'stream.jsonl'), [
      JSON.stringify({ at: '2026-09-19T23:58:10.000Z', kind: 'response', status: 'completed', summary: 'starting' }),
      JSON.stringify({ at: '2026-09-19T23:58:20.000Z', kind: 'command_execution', status: 'completed', summary: 'npm test' }),
    ].join('\n'));
    const record = {
      id: 'stream-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
      taskFile: 'task.md', outFile: 'out.md', streamFile: 'stream.jsonl',
      startedAt: '2026-09-19T23:58:00.000Z', endedAt: '2026-09-20T00:00:00.000Z', ok: true,
      usage: { tokens: { standardRead: 12, output: 4, totalKnown: 16 }, tokenSource: 'recorded' },
    };
    const model = taskStepModel(record, { runsDir: root, nowMs: NOW });
    assert.equal(model.header.effort, 'medium');
    assert.equal(model.tokens.totalKnown, 16);
    assert.equal(model.activity.available, true);
    assert.equal(model.activity.turns.length, 1);
    assert.equal(model.activity.turns[0].summary.commands, 1);
    assert.equal(model.verdict.verification.verdict, null);
    assert.equal(model.verdict.workflow.status, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real snapshot task records render through the Step blocks at 55, 120, and 200 columns', () => {
  if (!existsSync(join(REAL_HOME, 'state.json'))) return;
  const state = JSON.parse(readFileSync(join(REAL_HOME, 'state.json'), 'utf8'));
  const records = (state.decisionLog ?? [])
    .filter((entry) => entry?.kind === 'run' && entry.taskFile)
    .slice(0, 3)
    .map((entry) => ({
      ...entry,
      taskFile: join(REAL_RUNS, basename(entry.taskFile)),
      outFile: entry.outFile ? join(REAL_RUNS, basename(entry.outFile)) : null,
    }));
  assert.ok(records.length, 'snapshot has no task records');
  for (const record of records) {
    const model = taskStepModel(record, { nowMs: NOW });
    for (const width of [55, 120, 200]) {
      const body = bodyFor();
      const header = renderStepPage(model, { width, stepView: 'overview' }, body);
      for (const line of body.lines) assert.ok([...plain(line)].length <= width, `${width}: ${plain(line)}`);
      const text = body.lines.map(plain).join('\n');
      assert.match(text, /── task · build|── task · /);
      assert.match(text, /── result · /);
      assert.match(text, /── cost/);
      if (width === 200) {
        const expectedId = String(record.id ?? record.taskFile).length > 14
          ? String(record.id ?? record.taskFile).slice(-8)
          : String(record.id ?? record.taskFile);
        assert.match(
          plain(header),
          new RegExp(`^ [✓✗●] ${record.lane} task · ${expectedId} · succeeded · attempt 1 of 1`),
        );
        assert.doesNotMatch(plain(header), new RegExp(String(record.id)));
      }
    }
  }
});

test('dashboard task route uses the Step toggle and Esc leaves the task page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-task-dashboard-'));
  const runs = join(home, 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'task-key.md'), 'Use the shared task view.\n');
  writeFileSync(join(runs, 'out-key.md'), 'done\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ decisionLog: [{
    kind: 'run', source: 'run', id: 'key-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
    project: 'bullswarm', taskFile: join(runs, 'task-key.md'), outFile: join(runs, 'out-key.md'),
    ok: true, startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date(Date.now() - 60000).toISOString(), durationMs: 60000,
  }] }));
  const input = new FakeInput();
  const output = new FakeOutput();
  const dashboard = runDashboard(home, {
    input, output, refreshMs: 100000, spinnerMs: 100000, autoReprice: false, autoPrune: false,
  });
  try {
    await settle();
    input.press('r');
    await settle();
    const beforeOpen = output.text.length;
    input.press('\r');
    await settle();
    assert.match(plain(output.text.slice(beforeOpen)), /build task · key-task/);
    assert.match(plain(output.text.slice(beforeOpen)), /── result · succeeded/);
    // A standalone task gets the same page: the toggle sits in the activity
    // rule after its heading word, and the top bar carries none of it.
    const opened = output.text.slice(beforeOpen);
    assert.equal(positionedRows(output.text).filter(([row, text]) => row === 1 && /overview|detail/.test(plain(text))).length, 0);
    assert.match(opened, /activity · \x1b\[7moverview\x1b\[0m · detail · 0 turns/);
    const beforeToggle = output.text.length;
    input.press('v');
    await settle();
    // 80 columns stacks like the phone, whose footer keeps the short hint.
    assert.match(plain(output.text.slice(beforeToggle)), /v overview/);
    assert.match(output.text.slice(beforeToggle), /transcript · overview · \x1b\[7mdetail\x1b\[0m/);
    // A click on `overview` in the transcript rule switches back.
    const [ruleRow, ruleText] = positionedRows(output.text.slice(beforeToggle))
      .find(([, text]) => plain(text).startsWith('── transcript · overview · detail'));
    const beforeClick = output.text.length;
    input.press(`\x1b[<0;${plain(ruleText).indexOf('overview') + 1};${ruleRow}M`);
    await settle();
    assert.match(output.text.slice(beforeClick), /\x1b\[7moverview\x1b\[0m · detail/);
    assert.match(plain(output.text.slice(beforeClick)), /v detail/);
    const beforeBack = output.text.length;
    input.press('\x1b');
    await settle();
    assert.match(plain(output.text.slice(beforeBack)), /bullswarm · runs/);
  } finally {
    input.press('q');
    await dashboard;
    rmSync(home, { recursive: true, force: true });
  }
});

test('records that predate stream persistence keep the honest missing-stream reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-predate-'));
  try {
    writeFileSync(join(root, 'task.md'), 'Inspect the copied task.\n');
    writeFileSync(join(root, 'out.md'), 'copied output\n');
    const record = {
      id: 'predate-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
      taskFile: join(root, 'task.md'), outFile: join(root, 'out.md'),
      startedAt: '2026-09-19T23:50:00.000Z', endedAt: '2026-09-20T00:00:00.000Z',
      ok: true,
    };
    const model = taskStepModel(record, { runsDir: root, nowMs: NOW });
    assert.equal(model.activity.available, false);
    assert.equal(model.activity.reason, 'no event stream path recorded');
    const body = bodyFor();
    renderStepPage(model, { width: 120, stepView: 'overview' }, body);
    assert.match(plain(body.lines.join('\n')), /no event stream path recorded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a running task with streamFile and a live out-*.md tail renders turns and output', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-live-'));
  try {
    writeFileSync(join(root, 'task-live.md'), 'Run the bounded task.\n');
    writeFileSync(join(root, 'out-live.md'), 'live output tail from the worker\n');
    writeFileSync(join(root, 'stream-live.jsonl'), [
      JSON.stringify({ at: '2026-09-19T23:50:10.000Z', kind: 'response', status: 'completed', summary: 'starting the work' }),
      JSON.stringify({ at: '2026-09-19T23:50:20.000Z', kind: 'command_execution', status: 'completed', summary: 'npm test' }),
      JSON.stringify({ at: '2026-09-19T23:51:00.000Z', kind: 'response', status: 'completed', summary: 'still running the checks' }),
    ].join('\n'));
    const record = {
      id: 'live-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
      taskFile: join(root, 'task-live.md'), outFile: join(root, 'out-live.md'),
      streamFile: join(root, 'stream-live.jsonl'),
      startedAt: '2026-09-19T23:50:00.000Z',
    };
    const model = taskStepModel(record, { runsDir: root, nowMs: NOW });
    assert.equal(model.identity.executionStatus, 'running');
    assert.equal(model.activity.available, true);
    assert.equal(model.activity.turns.length, 2);
    assert.equal(model.activity.turns[0].summary.commands, 1);
    assert.match(model.resultBlock.output.lines.join('\n'), /live output tail from the worker/);
    const body = bodyFor();
    renderStepPage(model, { width: 120, stepView: 'overview' }, body);
    const text = plain(body.lines.join('\n'));
    assert.match(text, /starting the work/);
    assert.match(text, /last response \d\d:\d\d {2}still running the/);
    assert.match(text, /live output tail from the worker/);
    assert.doesNotMatch(text, /no event stream path recorded/);
    assert.doesNotMatch(text, /output unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real snapshot task records without a stream pointer stay honest', () => {
  if (!existsSync(join(REAL_HOME, 'state.json'))) return;
  const state = JSON.parse(readFileSync(join(REAL_HOME, 'state.json'), 'utf8'));
  const record = (state.decisionLog ?? []).find((entry) => (
    entry?.kind === 'run' && entry.taskFile && !entry.streamFile
  ));
  assert.ok(record, 'snapshot has no pre-stream task record');
  const model = taskStepModel({
    ...record,
    taskFile: join(REAL_RUNS, basename(record.taskFile)),
    outFile: record.outFile ? join(REAL_RUNS, basename(record.outFile)) : null,
  }, { nowMs: NOW, runsDir: REAL_RUNS });
  assert.equal(model.activity.available, false);
  assert.equal(model.activity.reason, 'no event stream path recorded');
  const body = bodyFor();
  renderStepPage(model, { width: 120, stepView: 'overview' }, body);
  assert.match(plain(body.lines.join('\n')), /no event stream path recorded/);
});

test('a fake-provider run persists stream-<id>.jsonl beside the task file and the Step page renders its turns', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-fake-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'fake-stream.json'), `${JSON.stringify({
      name: 'fake-stream',
      bin: 'node',
      spawn: { cmd: [process.execPath, ANSWERING, '{taskFile}'], cwdMode: 'task-file-dir' },
      authSignatures: [],
      quotaSignatures: [],
      outputExtraction: { strategy: 'event-stream' },
      eventStream: {
        format: 'jsonl',
        args: [],
        rules: [
          {
            rootMatch: { path: 'type', equals: 'item.started' },
            idPaths: ['item.id'],
            kindPaths: ['item.type'],
            kindMap: { agent_message: 'response' },
            summaryPaths: ['item.command', 'item.text'],
            status: 'running',
          },
          {
            rootMatch: { path: 'type', equals: 'item.completed' },
            idPaths: ['item.id'],
            kindPaths: ['item.type'],
            kindMap: { agent_message: 'response' },
            summaryPaths: ['item.command', 'item.text'],
            status: 'completed',
          },
        ],
        output: [{ match: { path: 'type', equals: 'item.completed' }, path: 'item.text', mode: 'last' }],
      },
      meter: { type: 'none' },
      costRank: 5,
      lanes: ['analyze', 'build', 'chore'],
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      model: 'fake-local',
      knownModels: ['fake-local'],
      modelProfiles: [{
        id: 'fake-local', tier: 'low', qualityRank: 1, free: true,
        pricing: { inputUsdPerMillion: 0, cacheReadUsdPerMillion: 0, outputUsdPerMillion: 0 },
        pricingSource: 'local deterministic fixture',
        pricingUpdatedAt: '2026-08-27',
      }],
      flags: { stealth: false, testFixture: true },
    }, null, 2)}\n`);
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({
      version: 1,
      pools: { 'fake-stream': { enabled: true } },
      incumbents: {},
      decisionLog: [],
      config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [BIN, 'run', '--lane', 'build', '--json', '--no-caller', '--add-dir', REPO, '--prompt', 'persist the event stream'], {
      env: {
        ...process.env,
        BULLSWARM_HOME: home,
        BULLSWARM_NO_PACKAGED_PROVIDERS: '1',
        BULLSWARM_FIXTURE_EVENTS: 'jsonl',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    const entry = state.decisionLog.at(-1);
    assert.equal(entry.kind, 'run');
    assert.equal(entry.ok, true);
    assert.match(entry.taskFile, /\/runs\/task-/);
    assert.match(entry.streamFile, /\/runs\/stream-/);
    assert.equal(
      entry.streamFile.replace(/stream-/, 'task-').replace(/\.jsonl$/, '.md'),
      entry.taskFile,
    );
    assert.equal(existsSync(entry.streamFile), true, 'the stream file exists next to the task file');
    const rows = readFileSync(entry.streamFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.kind === 'response'), 'the fake provider recorded response turns');
    assert.ok(readdirSync(join(home, 'runs')).includes(basename(entry.streamFile)));

    const model = taskStepModel(entry, { runsDir: join(home, 'runs'), nowMs: NOW });
    assert.equal(model.activity.available, true);
    assert.ok(model.activity.turns.length >= 1);
    const body = bodyFor();
    renderStepPage(model, { width: 120, stepView: 'overview' }, body);
    const text = plain(body.lines.join('\n'));
    assert.match(text, /── activity · overview · detail · 2 turns/);
    assert.match(text, /Reviewed the prior attempt block/);
    assert.match(text, /The answering fixture completed the bounded dispatch/);
    assert.doesNotMatch(text, /no event stream path recorded/);
    assert.doesNotMatch(text, /output unavailable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
