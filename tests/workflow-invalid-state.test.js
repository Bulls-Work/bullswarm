import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

const BIN = join(new URL('..', import.meta.url).pathname.replace(/\/$/, ''), 'bin', 'bullswarm.js');
const RUN_ID = 'wf-invalidstate-abcdef';
const SHORT = 'inv234';

// A parked v3 run on disk whose state.json is then broken one of two ways.
function brokenRun(t, how) {
  const home = mkdtempSync(join(tmpdir(), 'bs-invalid-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, 'repo');
  const runDir = join(home, 'workflows', RUN_ID);
  mkdirSync(cwd); mkdirSync(runDir, { recursive: true }); mkdirSync(join(home, 'connectors'));
  const goal = createV2GoalDocument({
    goal: 'Invalid state', cwd, requirements: [{ id: 'requirement-1', text: 'It is loud' }], settings: { scout: false },
  });
  let state = createV2State(goal, { runId: RUN_ID, shortId: SHORT });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Run it.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{
        id: 'inspect', purpose: 'Inspect', dependsOn: [], affects: ['requirement-1'], ownedFiles: [],
        prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [],
      }, {
        id: 'verify', purpose: 'Verify', dependsOn: ['inspect'], affects: [], ownedFiles: [],
        prompt: 'Verify the requirement.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: [], produces: [],
      }],
    },
  });
  state.lifecycle = { status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: null, resultFile: null };
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(goal));
  writeFileSync(join(runDir, 'features.json'), JSON.stringify({ programFormat: 3 }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, pools: {}, incumbents: {}, decisionLog: [], config: { depthLimit: 2, callerName: 'test' } }));
  const file = join(runDir, 'state.json');
  if (how === 'bogus') { state.lifecycle.status = 'bogus-status'; writeFileSync(file, JSON.stringify(state)); }
  else writeFileSync(file, '{"lifecycle": ');
  // A state that is not JSON has no readable shortId, so only the full runId names it.
  return { home, runDir, file, token: how === 'bogus' ? SHORT : RUN_ID, message: how === 'bogus' ? 'state.lifecycle.status is invalid' : 'serialized state must be valid JSON' };
}

function cli(home, args, timeout = 30_000) {
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  return spawnSync(process.execPath, [BIN, 'workflow', ...args], { env, encoding: 'utf8', timeout });
}

const untouched = (r) => {
  assert.equal(existsSync(join(r.runDir, 'cancellation.json')), false, 'no cancellation.json written');
  assert.equal(existsSync(join(r.home, 'goals', RUN_ID)), false, 'no kernel was launched');
  assert.equal(existsSync(join(r.runDir, 'steering.json')), false, 'no steering written');
};

for (const how of ['bogus', 'not-json']) {
  test(`${how} state: resume, cancel, steer, continue and add exit 1 naming the file, and write only the marker`, (t) => {
    const r = brokenRun(t, how);
    const before = readFileSync(r.file, 'utf8');
    writeFileSync(join(r.home, 'part.json'), JSON.stringify({ steps: [{ id: 'more', prompt: 'More.' }] }));
    const T = r.token;
    const verbs = [
      ['resume', T], ['cancel', T], ['steer', T, '--message', 'hi'], ['continue', T, 'review'],
      ['add', T, '--steps', join(r.home, 'part.json'), '--wait', '0'],
    ];
    for (const args of verbs) {
      const out = cli(r.home, args);
      assert.equal(out.status, 1, `${args.join(' ')}: ${out.stdout}${out.stderr}`);
      assert.ok(out.stderr.includes(`✗ run ${r.token} has invalid saved state: `), `${args.join(' ')}: ${out.stderr}`);
      assert.ok(out.stderr.includes(r.message), out.stderr);
      assert.ok(out.stderr.includes(`(file: ${r.file})`), out.stderr);
      assert.doesNotMatch(out.stdout, /✓/);
    }
    untouched(r);
    assert.equal(readFileSync(r.file, 'utf8'), before, 'the state is not repaired');
    const marker = JSON.parse(readFileSync(join(r.runDir, 'state-invalid.json'), 'utf8'));
    assert.ok(marker.message.includes(r.message), marker.message);
    assert.ok(marker.at && !Number.isNaN(Date.parse(marker.at)));
    assert.ok(['resume', 'cancel', 'steer', 'continue', 'add'].includes(marker.by), marker.by);
  });
  test(`${how} state with a marker: watch exits 1 at once, show and result report it`, (t) => {
    const r = brokenRun(t, how);
    writeFileSync(join(r.runDir, 'state-invalid.json'), JSON.stringify({ message: r.message, at: new Date().toISOString(), by: 'resume' }));
    const started = Date.now();
    for (const args of [['watch', r.token, '--until', 'outcome', '--timeout', '30'], ['watch', r.token, '--once'], ['runs', 'result', r.token]]) {
      const out = cli(r.home, args, 20_000);
      assert.equal(out.status, 1, `${args.join(' ')}: ${out.stdout}${out.stderr}`);
      assert.ok(`${out.stdout}${out.stderr}`.includes(`✗ run ${r.token} has invalid saved state: ${r.message}`), `${args.join(' ')}: ${out.stdout}${out.stderr}`);
    }
    assert.ok(Date.now() - started < 15_000, 'returned within a few seconds');
    const shown = cli(r.home, ['runs', 'show', r.token]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /invalid state/);
    assert.ok(shown.stdout.includes(r.message), shown.stdout);
    const list = cli(r.home, ['runs', '--all']);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /invalid state/);
  });

  test(`${how} state with NO marker: runs show and the list do not validate (as on main)`, (t) => {
    const r = brokenRun(t, how);
    const shown = cli(r.home, ['runs', 'show', r.token]);
    assert.doesNotMatch(shown.stdout + shown.stderr, /invalid state|invalid saved state/);
    const list = cli(r.home, ['runs', '--all']);
    assert.doesNotMatch(list.stdout + list.stderr, /invalid state|invalid saved state/);
    const watched = cli(r.home, ['watch', r.token, '--until', 'outcome', '--timeout', '2'], 20_000);
    assert.doesNotMatch(watched.stdout + watched.stderr, /invalid saved state/);
    assert.equal(existsSync(join(r.runDir, 'state-invalid.json')), false);
  });

  test(`${how} state: a kernel started on it writes the marker before exiting`, (t) => {
    const r = brokenRun(t, how);
    const out = cli(r.home, ['goal', '--resume', r.token, '--json', '--quiet']);
    assert.notEqual(out.status, 0, `${out.stdout}${out.stderr}`);
    const marker = JSON.parse(readFileSync(join(r.runDir, 'state-invalid.json'), 'utf8'));
    assert.equal(marker.by, 'kernel');
    assert.ok(marker.message.includes(r.message), marker.message);
  });
}

test('a verb that loads a repaired state removes the marker', (t) => {
  const r = brokenRun(t, 'bogus');
  assert.equal(cli(r.home, ['steer', r.token, '--message', 'hi']).status, 1);
  assert.ok(existsSync(join(r.runDir, 'state-invalid.json')));
  const state = JSON.parse(readFileSync(r.file, 'utf8'));
  state.lifecycle.status = 'running';
  writeFileSync(r.file, JSON.stringify(state));
  cli(r.home, ['steer', r.token, '--message', 'hi']);
  assert.equal(existsSync(join(r.runDir, 'state-invalid.json')), false);
});
