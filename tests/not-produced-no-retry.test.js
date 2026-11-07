// A step that changed no file comes back to the caller at once.
//
// Measured over 2026-10-03..11-07 from real run records: after a build or
// chore attempt failed `not-produced` ("no file changed") with no `outside:`
// blocker in its report, the automatic same-pool retry succeeded 1 time in 12
// (7 of 7 failed again in the last week). A `failed-evidence` same-pool retry
// succeeded 13 of 25 times, so that one stays, and a process failure still
// moves to another pool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { pickPool } from '../src/lib/route.js';
import { handoffBlock } from '../src/workflow/retry-handoff.js';

const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };
const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' }, medium: { pool: name, model: 'gpt-5.6-luna' } },
});

function harness(verdicts) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  const calls = [];
  return {
    calls,
    dependencies: {
      watchOnce: async (pool, task, _dir, paths, opts) => {
        calls.push({ pool: pool.name, task });
        const item = verdicts[index++];
        return typeof item === 'function' ? item({ paths, opts }) : item;
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-11-07T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => 'session-fixed',
    },
  };
}

function repoFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-noretry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'tickets'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, 'tickets', 'T-1001.md'), 'Refund not received\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { repo, home };
}

async function dispatch(f, action, watches, pools = ['sample-pool']) {
  const h = harness(watches);
  const result = await dispatchV2Action({
    failureRule: true,
    action, taskText: 'triage the tickets', targetDir: f.repo,
    paths: { taskFile: join(f.home, `task-${action.id}-attempt-1.md`), outFile: join(f.home, `out-${action.id}-attempt-1.md`) },
    pools: pools.map(connector), bullswarmDir: f.home, dependencies: h.dependencies,
  });
  return { result, calls: h.calls };
}

const build = (extra = {}) => ({ id: 'task', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, ownedFiles: [], ...extra });
const edit = (repo, text) => () => { writeFileSync(join(repo, 'tickets', 'T-1001.md'), text); return good; };
const SKIP_SUFFIX = ' · retry skipped: a step that changed no file rarely does on a rerun';

test('not-produced with no blocker: one attempt, failed, to the caller with the skip reason', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build(), [good, good]);
  assert.equal(calls.length, 1, 'no automatic retry ran');
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'not-produced');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, 'failed');
  assert.equal(result.attempts[0].willRetry, false);
  assert.equal(result.attempts[0].why, `no file changed${SKIP_SUFFIX}`);
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX));
  assert.equal(result.verdict.why, result.attempts[0].why);
});

test('a chore step that changed no file is not retried either', async (t) => {
  const f = repoFixture(t);
  const { result, calls } = await dispatch(f, build({ lane: 'chore' }), [good, good]);
  assert.equal(calls.length, 1);
  assert.equal(result.failureKind, 'not-produced');
  assert.ok(result.attempts[0].why.endsWith(SKIP_SUFFIX), result.attempts[0].why);
});

test('not-produced with an `outside:` blocker keeps the blocker suffix, one attempt', async (t) => {
  const f = repoFixture(t);
  const report = '## Done\n- read the tickets\n\n## Not done\n- outside: tickets/T-1001.md is not in my files\n\n## Suggested next step\n- add a step that owns it\n';
  const reporting = ({ paths }) => { writeFileSync(paths.outFile, report); return good; };
  const { result, calls } = await dispatch(f, build(), [reporting, good]);
  assert.equal(calls.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, 'failed');
  assert.equal(result.attempts[0].willRetry, false);
  assert.equal(result.attempts[0].why, 'no file changed · retry skipped: the worker reported a blocker outside this step: tickets/T-1001.md is not in my files');
});

test('a failed-evidence failure still retries once on the same pool', async (t) => {
  const f = repoFixture(t);
  const action = build({ evidence: [{ type: 'command', cmd: 'grep -q sent tickets/T-1001.md' }] });
  const { result, calls } = await dispatch(f, action, [edit(f.repo, 'Refund pending\n'), edit(f.repo, 'Refund sent\n')]);
  assert.equal(calls.length, 2, 'the gate retry ran');
  assert.equal(result.attempts[0].failureKind, 'failed-evidence');
  assert.equal(result.attempts[0].willRetry, true);
  assert.deepEqual(calls.map((call) => call.pool), ['sample-pool', 'sample-pool']);
  assert.equal(result.ok, true, result.attempts.at(-1)?.why);
});

test('a process failure with another pool free still moves to the other pool', async (t) => {
  const f = repoFixture(t);
  const processFail = { ok: false, failureKind: 'process', why: 'worker exited 1', meta: { exitCode: 1, wallSec: 1 } };
  const { result, calls } = await dispatch(f, build(), [processFail, edit(f.repo, 'Refund sent\n')], ['pool-a', 'pool-b']);
  assert.equal(calls.length, 2, 'the process retry ran');
  assert.equal(result.attempts[0].willRetry, true);
  assert.notEqual(calls[0].pool, calls[1].pool);
  assert.equal(result.ok, true, result.attempts.at(-1)?.why);
});

test('an analyze step with an empty report keeps its same-pool retry, forced, in a fresh session, with the failure attached', async (t) => {
  const f = repoFixture(t);
  const conversational = (name, pace) => ({
    ...connector(name), pace,
    conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] },
  });
  const launch = [conversational('pool-a', 90), conversational('pool-b', -90)];
  const flipped = [conversational('pool-a', -90), conversational('pool-b', 90)];
  // Without the pin the router would move the retry to pool-b.
  assert.equal(pickPool('analyze', flipped, { effortTier: 'medium' }).pick.pool, 'pool-b');
  const refreshCalls = [];
  const tasks = [];
  const facts = [];
  let session = 0;
  const h = harness([() => good, ({ paths }) => { writeFileSync(paths.outFile, 'T-1001: refund pending\n'); return good; }]);
  const inner = h.dependencies.watchOnce;
  const action = { id: 'report', role: 'investigate', lane: 'analyze', effort: 'medium', deliverable: { type: 'report' }, retry: 1 };
  const result = await dispatchV2Action({
    failureRule: true,
    action, taskText: 'triage the tickets', targetDir: f.repo,
    paths: (ordinal) => ({ taskFile: join(f.home, `task-report-attempt-${ordinal}.md`), outFile: join(f.home, `out-report-attempt-${ordinal}.md`) }),
    pools: launch, bullswarmDir: f.home,
    refreshPools: async (opts) => { refreshCalls.push(opts); return refreshCalls.length === 1 ? launch : flipped; },
    handoffBlock: (value) => { facts.push(value); return handoffBlock(value); },
    dependencies: {
      ...h.dependencies,
      uuid: () => `session-${++session}`,
      watchOnce: async (c, task, dir, p, o) => { tasks.push(task); return inner(c, task, dir, p, o); },
    },
  });
  assert.equal(result.ok, true, result.attempts.at(-1)?.why);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['pool-a', 'pool-a']);
  const [first, second] = result.attempts;
  assert.equal(first.failureKind, 'not-produced');
  assert.equal(first.status, 'failed');
  assert.equal(first.willRetry, true);
  assert.ok(!first.why.includes('retry skipped'), first.why);
  assert.deepEqual(second.retryOf, { attempt: 'report-1', how: 'same-pool' });
  assert.match(second.routeWhy, /^pinned to pool-a \(the same pool \(gate retry\)\)/);
  assert.notEqual(second.session.sessionId, first.session.sessionId);
  assert.notEqual(second.continued, true);
  assert.deepEqual(refreshCalls, [{ force: false }, { force: true }]);
  assert.match(tasks[1], /## Prior attempt on this step/);
  assert.match(tasks[1], /- Failure: not-produced/);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].gate, true, 'the gate line is asked for (§2.3)');
  assert.equal(facts[0].failureKind, 'not-produced');
});

test('a build step that changed files but missed its declared path keeps its same-pool retry', async (t) => {
  // The 1-in-12 figure measured "no file changed" only; a step that wrote
  // something keeps the retry with the missing path attached.
  const f = repoFixture(t);
  const action = build({ deliverable: { type: 'files', paths: ['out/a.txt'] }, retry: 1 });
  const writeDeclared = () => { mkdirSync(join(f.repo, 'out'), { recursive: true }); writeFileSync(join(f.repo, 'out', 'a.txt'), 'done\n'); return good; };
  const { result, calls } = await dispatch(f, action, [edit(f.repo, 'Refund pending\n'), writeDeclared]);
  assert.equal(calls.length, 2, 'the automatic retry ran');
  assert.equal(result.attempts[0].failureKind, 'not-produced');
  assert.match(result.attempts[0].why, /^declared files missing: out\/a\.txt/);
  assert.ok(!result.attempts[0].why.includes('retry skipped'), result.attempts[0].why);
  assert.equal(result.attempts[0].willRetry, true);
  assert.deepEqual(result.attempts[1].retryOf, { attempt: 'task-1', how: 'same-pool' });
});
