import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKER_PATH, EVIDENCE_ENV_KEYS, EVIDENCE_LOG_BYTES, EVIDENCE_TAIL_BYTES,
  evidenceBriefLines, evidenceEnv, evidenceSchemaBaseline, evidenceFailureWhy, evidenceItemLabel, evidenceScope,
  removeCreatedOutOfScope, rewriteEvidenceCwd, runEvidenceItem, runStepEvidence, stripAnsi, tailLines,
} from '../src/workflow/evidence-runner.js';

const GIT_ID = ['-c', 'user.email=dev@example.com', '-c', 'user.name=AcmeDev', '-c', 'commit.gpgsign=false'];
const COMMIT = `git ${GIT_ID.join(' ')} commit -q --allow-empty -m check`;

function tempDir(t, prefix = 'acme-evidence-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, body) {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

const git = (cwd, ...args) => execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A temp repository with a first commit. Returns { root, runDir, outFile }.
function gitRepo(t, files = {}, { ignore = 'dist/\n' } = {}) {
  const root = tempDir(t, 'acme-repo-');
  git(root, 'init', '-q');
  write(root, '.gitignore', ignore);
  for (const [name, body] of Object.entries({ 'README.md': 'initech\n', ...files })) write(root, name, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  return { root, ...runFiles(t) };
}

function runFiles(t) {
  const runDir = tempDir(t, 'acme-run-');
  const outFile = write(runDir, 'out-step-attempt-1.md', 'the final response\n');
  return { runDir, outFile };
}

function stepOptions(cwd, runDir, outFile, extra = {}) {
  return {
    cwd,
    env: evidenceEnv(process.env, { cwd, stepId: 'step', outFile, runDir }),
    outFile,
    logFileFor: (k) => join(runDir, `evidence-step-attempt-1-${k}.log`),
    ...extra,
  };
}

const cmd = (text, extra = {}) => ({ type: 'command', cmd: text, ...extra });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scoped(t, mode, repo, items, { ownedFiles = [], declaredPaths = [], cwd = repo.root, ...extra } = {}) {
  const scope = evidenceScope({ mode, cwd, ownedFiles, declaredPaths, outFile: repo.outFile });
  return runStepEvidence(items, stepOptions(cwd, repo.runDir, repo.outFile, { scope, ...extra }));
}

// ---------------------------------------------------------------------------

test('exit 0 passes; exit 3 fails with why "exit 3"', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const run = await runStepEvidence([cmd('true'), cmd('echo nope; exit 3')], stepOptions(cwd, runDir, outFile));
  assert.deepEqual(run.results.map((r) => [r.status, r.exit, r.why]), [['passed', 0, null], ['failed', 3, 'exit 3']]);
  assert.equal(run.failed, true);
  assert.equal(run.stopped, false);
  assert.equal(run.why, 'echo nope; exit 3 → exit 3: nope');
  assert.deepEqual(Object.keys(run.results[1]), ['type', 'cmd', 'timeoutSec', 'status', 'exit', 'durationMs', 'tail', 'log', 'why']);
  assert.equal(run.results[1].timeoutSec, 120);
});

test('a deadline sends SIGTERM to the group and fails with timedOut', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const started = Date.now();
  const run = await runStepEvidence([cmd('sleep 5', { timeoutSec: 1 })], stepOptions(tempDir(t), runDir, outFile));
  const elapsed = Date.now() - started;
  assert.deepEqual(pick(run.results[0], ['status', 'exit', 'timedOut', 'why']), { status: 'failed', exit: null, timedOut: true, why: 'timed out after 1s' });
  assert.equal(run.results[0].timeoutSec, 1);
  assert.ok(elapsed < 1000 + 2000 + 500, `took ${elapsed}ms`);
  assert.equal(run.why, 'sleep 5 → timed out after 1s');
  // A shell that ignores SIGTERM is killed by the SIGKILL that follows.
  const stubborn = await runEvidenceItem(cmd("trap '' TERM; sleep 5; sleep 5", { timeoutSec: 1 }), { cwd: tempDir(t), killGrace: 300 });
  assert.equal(stubborn.timedOut, true);
  assert.ok(stubborn.durationMs < 1000 + 300 + 1500, `took ${stubborn.durationMs}ms`);
});

test('a background child is killed with the group once the shell exits', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const started = Date.now();
  const run = await runStepEvidence([cmd('sleep 30 & echo $! > bg.pid; exit 0')], stepOptions(cwd, runDir, outFile));
  // Without the group kill the background sleep would hold stdout open and the
  // wait for 'close' would last 30 s; the run must end well inside that.
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`);
  assert.equal(run.results[0].status, 'passed');
  const pid = Number(readFileSync(join(cwd, 'bg.pid'), 'utf8'));
  assert.ok(pid > 0);
  const deadline = Date.now() + 2500;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(50);
  assert.equal(pidAlive(pid), false, `background pid ${pid} is still running`);
});

test('env: BULLSWARM_* variables, depth + 1, PWD is the realpath, stdin is closed', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const env = evidenceEnv({ ...process.env, BULLSWARM_DEPTH: '2' }, { cwd, stepId: 'report', outFile, runDir });
  assert.deepEqual(EVIDENCE_ENV_KEYS, ['BULLSWARM_EVIDENCE', 'BULLSWARM_STEP_ID', 'BULLSWARM_STEP_OUTPUT', 'BULLSWARM_RUN_DIR']);
  assert.equal(env.CI, process.env.CI);
  const script = [
    'printf "%s\\n" "$BULLSWARM_EVIDENCE" "$BULLSWARM_STEP_ID" "$BULLSWARM_STEP_OUTPUT" "$BULLSWARM_RUN_DIR" "$BULLSWARM_DEPTH" "$PWD" "$(pwd -P)" > env.txt',
    'read x; echo "read=$?" >> env.txt',
  ].join('; ');
  const started = Date.now();
  const result = await runEvidenceItem(cmd(script), { cwd, env, outFile });
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.status, 'passed');
  const lines = readFileSync(join(cwd, 'env.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(0, 7), ['1', 'report', outFile, runDir, '3', cwd, cwd]);
  assert.match(lines[7], /^read=[1-9]/);
  assert.equal(evidenceEnv({}, { cwd, stepId: 's', outFile, runDir }).BULLSWARM_DEPTH, '1');
});

test('PWD is the realpath when the workspace is reached through a symlink', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const real = tempDir(t);
  const linkParent = tempDir(t);
  const link = join(linkParent, 'ws');
  execFileSync('ln', ['-s', real, link]);
  const env = evidenceEnv(process.env, { cwd: link, stepId: 's', outFile, runDir });
  const result = await runEvidenceItem(cmd('echo "$PWD" > pwd.txt'), { cwd: link, env, outFile });
  assert.equal(result.status, 'passed');
  assert.equal(readFileSync(join(real, 'pwd.txt'), 'utf8').trim(), real);
});

test('onSpawn and onWorkerExit get the same pid; shouldCancel stops the item and kills the group', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const spawned = [];
  const exited = [];
  const passed = await runStepEvidence([cmd('true')], stepOptions(cwd, runDir, outFile, {
    onSpawn: (pid) => spawned.push(pid), onWorkerExit: (pid) => exited.push(pid),
  }));
  assert.equal(passed.results[0].status, 'passed');
  assert.equal(spawned.length, 1);
  assert.deepEqual(exited, spawned);

  let cancel = false;
  setTimeout(() => { cancel = true; }, 300);
  const started = Date.now();
  const stopped = await runStepEvidence([cmd('sleep 30 & echo $! > bg.pid; wait'), cmd('true')], stepOptions(cwd, runDir, outFile, {
    shouldCancel: () => cancel, pollMs: 50,
  }));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  assert.deepEqual(stopped.results.map((r) => [r.status, r.exit, r.why]), [['not-run', null, 'stopped'], ['not-run', null, 'stopped']]);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.failed, false);
  assert.equal(stopped.why, 'evidence stopped');
  const pid = Number(readFileSync(join(cwd, 'bg.pid'), 'utf8'));
  const deadline = Date.now() + 2500;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(50);
  assert.equal(pidAlive(pid), false);

  // Already stopped before the first item: nothing runs.
  let ran = 0;
  const none = await runStepEvidence([cmd('true')], stepOptions(cwd, runDir, outFile, { shouldCancel: () => true, onSpawn: () => { ran += 1; } }));
  assert.equal(ran, 0);
  assert.equal(none.results[0].why, 'stopped');
});

test('signal deaths the runner did not send are failures that name the signal', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const node = JSON.stringify(process.execPath);
  const abort = await runStepEvidence([cmd(`${node} -e "process.abort()"`)], stepOptions(cwd, runDir, outFile, { env: { ...process.env, NODE_OPTIONS: '' } }));
  assert.deepEqual(pick(abort.results[0], ['status', 'exit', 'signal', 'why']), { status: 'failed', exit: null, signal: 'SIGABRT', why: 'killed by SIGABRT' });
  assert.equal(abort.stopped, false);
  const segv = await runStepEvidence([cmd(`${node} -e "process.kill(process.pid,'SIGSEGV')"`)], stepOptions(cwd, runDir, outFile));
  assert.deepEqual(pick(segv.results[0], ['status', 'exit', 'signal', 'why']), { status: 'failed', exit: null, signal: 'SIGSEGV', why: 'killed by SIGSEGV' });

  const term = await runStepEvidence([cmd('sleep 10')], stepOptions(cwd, runDir, outFile, {
    onSpawn: (pid) => setTimeout(() => process.kill(-pid, 'SIGTERM'), 100),
  }));
  assert.deepEqual(pick(term.results[0], ['status', 'exit', 'signal', 'why']), { status: 'failed', exit: null, signal: 'SIGTERM', why: 'killed by SIGTERM' });
  assert.equal(term.why, 'sleep 10 → killed by SIGTERM');

  let killed = false;
  const kernelStop = await runStepEvidence([cmd('sleep 10'), cmd('true')], stepOptions(cwd, runDir, outFile, {
    onSpawn: (pid) => setTimeout(() => { killed = true; process.kill(-pid, 'SIGTERM'); }, 100),
    shouldCancel: () => killed,
    pollMs: 60_000,
  }));
  assert.deepEqual(kernelStop.results.map((r) => [r.status, r.why]), [['not-run', 'stopped'], ['not-run', 'stopped']]);
  assert.equal(kernelStop.results[0].signal, undefined);
  assert.equal(kernelStop.stopped, true);
});

test('the heartbeat fires on the injected interval', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const events = [];
  await runStepEvidence([cmd('sleep 0.3')], stepOptions(tempDir(t), runDir, outFile, { heartbeatMs: 20, onEvidence: (event) => events.push(event) }));
  const running = events.filter((event) => event.stage === 'running');
  assert.ok(running.length >= 3, `only ${running.length} heartbeats`);
  assert.deepEqual(events[0], { stage: 'started', index: 1, of: 1, type: 'command', label: 'sleep 0.3' });
  assert.deepEqual(pick(events.at(-1), ['stage', 'index', 'of', 'status', 'why']), { stage: 'finished', index: 1, of: 1, status: 'passed', why: null });
  assert.equal(typeof events.at(-1).durationMs, 'number');
});

test('output: merged streams, ANSI-free tail within 2048 bytes, bounded log with header and footer', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const node = JSON.stringify(process.execPath);
  const script = `${node} -e "for (let i = 0; i < 400; i++) console.log('\\x1b[31mline ' + i + ' ✓ ok\\x1b[0m'); console.error('to stderr'); process.exit(1)"`;
  const run = await runStepEvidence([cmd(script)], stepOptions(cwd, runDir, outFile));
  const [result] = run.results;
  assert.ok(Buffer.byteLength(result.tail) <= EVIDENCE_TAIL_BYTES);
  assert.equal(result.tail.includes('\x1b'), false);
  assert.match(result.tail, /^line \d+ ✓ ok\n/);
  assert.match(result.tail, /line 399 ✓ ok\nto stderr$/);
  assert.equal(result.log, join(runDir, 'evidence-step-attempt-1-1.log'));
  const log = readFileSync(result.log, 'utf8').split('\n');
  assert.equal(log[0], `$ ${script}`);
  assert.equal(log[1], `cwd: ${cwd}`);
  assert.equal(log[2], 'timeout: 120s');
  assert.match(log.at(-2), /^exit 1 after \d+\.\ds$/);
  assert.equal(run.why, `${script.slice(0, 78).slice(0, script.slice(0, 79).lastIndexOf(' ')).trimEnd()}… → exit 1: to stderr`);

  const big = await runStepEvidence([cmd(`${node} -e "process.stdout.write('x'.repeat(3 * 1024 * 1024))"`)], stepOptions(cwd, runDir, outFile));
  assert.equal(big.results[0].status, 'passed');
  const size = statSync(big.results[0].log).size;
  assert.ok(size <= EVIDENCE_LOG_BYTES + 1024, `log is ${size} bytes`);
  assert.ok(size >= EVIDENCE_LOG_BYTES - 1024);
  assert.ok(Buffer.byteLength(big.results[0].tail) <= EVIDENCE_TAIL_BYTES);
});

test('tailLines and stripAnsi', () => {
  assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m\r\nnext\rover'), 'ok\nnext\nover');
  assert.equal(tailLines('short', 10), 'short');
  assert.equal(tailLines('aaaa\nbbbb\ncccc', 8), 'cccc');
  assert.equal(tailLines('aaaa\nbbbb\ncccc', 10), 'bbbb\ncccc');
  const emoji = tailLines('😀😀😀', 5);
  assert.equal(emoji, '😀');
  assert.equal(tailLines('x'.repeat(50), 8), 'x'.repeat(8));
});

test('a spawn failure is "could not start"', async (t) => {
  const { outFile } = runFiles(t);
  const result = await runEvidenceItem(cmd('true'), { cwd: tempDir(t), outFile, spawn: () => { throw new Error('EAGAIN'); } });
  assert.deepEqual(pick(result, ['status', 'exit', 'why']), { status: 'failed', exit: null, why: 'could not start: EAGAIN' });
  const missing = await runEvidenceItem(cmd('true'), { cwd: join(tempDir(t), 'gone'), outFile });
  assert.equal(missing.status, 'failed');
  assert.match(missing.why, /^could not start: /);
});

// ---------------------------------------------------------------------------
// Side-effect scopes (§2.5)

test('restricted: an owned edit fails, untracked files are no fact, a commit is headMoved', async (t) => {
  const repo = gitRepo(t, { 'src/a.txt': 'a\n', 'src/other.txt': 'o\n' });
  const owned = { ownedFiles: ['src/a.txt'] };
  const edited = await scoped(t, 'restricted', repo, [cmd('echo changed >> src/a.txt'), cmd('true')], owned);
  assert.deepEqual(pick(edited.results[0], ['status', 'exit', 'changed', 'why']), { status: 'failed', exit: 0, changed: ['src/a.txt'], why: 'changed the deliverable: src/a.txt' });
  assert.deepEqual(edited.results[1], {
    type: 'command', cmd: 'true', timeoutSec: 120, status: 'not-run', exit: null, durationMs: 0, tail: '',
    why: 'not run: an earlier item changed the deliverable',
  });
  assert.equal(edited.why, 'echo changed >> src/a.txt → changed the deliverable: src/a.txt');

  const untracked = await scoped(t, 'restricted', repo, [cmd('echo x > scratch.txt; echo y >> src/other.txt')], owned);
  assert.equal(untracked.results[0].status, 'passed');
  assert.equal('touched' in untracked.results[0], false);
  assert.equal('changed' in untracked.results[0], false);

  const commit = await scoped(t, 'restricted', repo, [cmd(COMMIT)], owned);
  assert.deepEqual(pick(commit.results[0], ['status', 'headMoved', 'changed']), { status: 'passed', headMoved: true, changed: undefined });
  assert.match(readFileSync(commit.results[0].log, 'utf8'), /also: HEAD moved while it ran \(another step may have committed\)\n$/);
});

test('restricted works outside git by hashing the owned files directly', async (t) => {
  const root = tempDir(t);
  write(root, 'notes.md', 'n\n');
  const repo = { root, ...runFiles(t) };
  const run = await scoped(t, 'restricted', repo, [cmd('echo more >> notes.md')], { ownedFiles: ['notes.md'] });
  assert.deepEqual(run.results[0].changed, ['notes.md']);
});

test('unrestricted: tracked edits fail; untracked by-products are touched; ignored files are not; a commit changes HEAD', async (t) => {
  const repo = gitRepo(t, { 'src/app.js': 'x\n' });
  write(repo.root, 'notes.local', 'before\n');

  const tracked = await scoped(t, 'unrestricted', repo, [cmd('echo y >> src/app.js')]);
  assert.deepEqual(tracked.results[0].changed, ['src/app.js']);
  git(repo.root, 'checkout', '--', 'src/app.js');

  const created = await scoped(t, 'unrestricted', repo, [cmd('echo {} > tsconfig.tsbuildinfo')]);
  assert.deepEqual(pick(created.results[0], ['status', 'touched']), { status: 'passed', touched: ['tsconfig.tsbuildinfo'] });
  assert.deepEqual(created.createdOutOfScope, []);
  assert.ok(existsSync(join(repo.root, 'tsconfig.tsbuildinfo')), 'nothing is removed in a shared workspace');
  assert.match(readFileSync(created.results[0].log, 'utf8'), /also: touched tsconfig\.tsbuildinfo\n$/);

  const rewritten = await scoped(t, 'unrestricted', repo, [cmd('echo after > notes.local')]);
  assert.deepEqual(pick(rewritten.results[0], ['status', 'touched']), { status: 'passed', touched: ['notes.local'] });

  const ignored = await scoped(t, 'unrestricted', repo, [cmd('mkdir -p dist && echo b > dist/bundle.js')]);
  assert.equal(ignored.results[0].status, 'passed');
  assert.equal('touched' in ignored.results[0], false);

  const commit = await scoped(t, 'unrestricted', repo, [cmd(COMMIT), cmd('true')]);
  assert.deepEqual(pick(commit.results[0], ['status', 'changed', 'why']), { status: 'failed', changed: ['HEAD'], why: 'changed the deliverable: HEAD moved' });
  assert.equal(commit.results[1].status, 'not-run');
  assert.equal('headMoved' in commit.results[0], false);
});

test('a workspace in a subfolder of the repository lists paths relative to the workspace', async (t) => {
  const repo = gitRepo(t, { 'pkg/app/main.js': 'm\n', 'pkg/app/lib.js': 'l\n', 'top.txt': 't\n' });
  const cwd = join(repo.root, 'pkg', 'app');
  const scope = evidenceScope({ mode: 'unrestricted', cwd, outFile: repo.outFile });
  assert.equal(scope.mode, 'unrestricted');
  assert.deepEqual(scope.paths().filter((path) => !path.startsWith('/')).sort(), ['lib.js', 'main.js']);

  const edit = await scoped(t, 'unrestricted', repo, [cmd('echo z >> lib.js')], { cwd });
  assert.deepEqual(edit.results[0].changed, ['lib.js']);
  git(repo.root, 'checkout', '--', '.');

  const outside = await scoped(t, 'unrestricted', repo, [cmd('echo z >> ../../top.txt; echo n > new.txt')], { cwd });
  assert.deepEqual(pick(outside.results[0], ['status', 'touched']), { status: 'passed', touched: ['new.txt'] });

  const priv = await scoped(t, 'private', repo, [cmd('mkdir -p cache/deep && echo c > cache/deep/x.bin')], { cwd, ownedFiles: ['main.js'] });
  assert.deepEqual(priv.createdOutOfScope, ['cache/deep/x.bin']);
});

test('a workspace folder that its repository ignores counts as outside git', async (t) => {
  const repo = gitRepo(t, {}, { ignore: 'scratch/\n' });
  const cwd = join(repo.root, 'scratch');
  mkdirSync(cwd);
  write(cwd, 'draft.md', 'd\n');
  const scope = evidenceScope({ mode: 'unrestricted', cwd, outFile: repo.outFile });
  assert.deepEqual([scope.git, scope.mode, scope.head()], [false, 'other', null]);
});

test('private copy: created by-products are touched and listed for removal; tracked edits fail; outside git every file counts', async (t) => {
  const repo = gitRepo(t, { 'src/owned.js': 'o\n', 'src/shared.js': 's\n' });
  const owned = { ownedFiles: ['src/owned.js'] };

  const byproduct = await scoped(t, 'private', repo, [cmd('mkdir -p test-results && echo r > test-results/junit.xml')], owned);
  assert.deepEqual(pick(byproduct.results[0], ['status', 'touched']), { status: 'passed', touched: ['test-results/junit.xml'] });
  assert.deepEqual(byproduct.createdOutOfScope, ['test-results/junit.xml']);
  assert.deepEqual(removeCreatedOutOfScope(repo.root, byproduct.createdOutOfScope), ['test-results/junit.xml']);
  assert.equal(existsSync(join(repo.root, 'test-results')), false, 'the emptied directory is removed too');

  write(repo.root, 'leftover.txt', 'worker\n');
  const existing = await scoped(t, 'private', repo, [cmd('echo more >> leftover.txt')], owned);
  assert.deepEqual(existing.results[0].touched, ['leftover.txt']);
  assert.deepEqual(existing.createdOutOfScope, [], 'a file present at item 1 is never listed for removal');

  const tracked = await scoped(t, 'private', repo, [cmd('echo y >> src/shared.js')], owned);
  assert.deepEqual(tracked.results[0].changed, ['src/shared.js']);
  git(repo.root, 'checkout', '--', '.');

  const commit = await scoped(t, 'private', repo, [cmd(COMMIT)], owned);
  assert.deepEqual(commit.results[0].changed, ['HEAD']);

  const plain = tempDir(t);
  write(plain, 'data.csv', 'a,b\n');
  const plainRepo = { root: plain, ...runFiles(t) };
  const noGit = await scoped(t, 'private', plainRepo, [cmd('echo 1,2 >> data.csv')]);
  assert.deepEqual(noGit.results[0].changed, ['data.csv']);
  const noGitNew = await scoped(t, 'private', plainRepo, [cmd('echo x > made.tmp')]);
  assert.deepEqual(pick(noGitNew.results[0], ['status', 'touched']), { status: 'passed', touched: ['made.tmp'] });
  assert.deepEqual(noGitNew.createdOutOfScope, ['made.tmp']);
});

test('other (analyze): a declared path edit fails; a commit is headMoved', async (t) => {
  const repo = gitRepo(t, { 'report.md': 'r\n', 'src/x.js': 'x\n' });
  const declared = { declaredPaths: ['report.md'] };
  const edit = await scoped(t, 'other', repo, [cmd('echo more >> report.md')], declared);
  assert.deepEqual(edit.results[0].changed, ['report.md']);
  git(repo.root, 'checkout', '--', '.');
  const free = await scoped(t, 'other', repo, [cmd('echo y >> src/x.js')], declared);
  assert.equal(free.results[0].status, 'passed');
  git(repo.root, 'checkout', '--', '.');
  const commit = await scoped(t, 'other', repo, [cmd(COMMIT)], declared);
  assert.deepEqual(pick(commit.results[0], ['status', 'headMoved', 'changed']), { status: 'passed', headMoved: true, changed: undefined });
  const unknownMode = evidenceScope({ mode: 'bogus', cwd: repo.root });
  assert.equal(unknownMode.mode, 'other');
});

test('the out file edited by a check fails in every mode', async (t) => {
  for (const mode of ['private', 'restricted', 'unrestricted', 'other']) {
    const repo = gitRepo(t, { 'a.txt': 'a\n' });
    const run = await scoped(t, mode, repo, [cmd('echo tampered >> "$BULLSWARM_STEP_OUTPUT"'), cmd('true')], { ownedFiles: mode === 'restricted' || mode === 'private' ? ['a.txt'] : [] });
    assert.deepEqual(run.results[0].changed, [repo.outFile], mode);
    assert.equal(run.results[1].status, 'not-run', mode);
  }
});

test('two restricted scopes in one repository: a sibling commit is headMoved, never changed', async (t) => {
  const repo = gitRepo(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const other = runFiles(t);
  const [slow, committing] = await Promise.all([
    scoped(t, 'restricted', repo, [cmd('sleep 0.8')], { ownedFiles: ['a.txt'] }),
    (async () => {
      await sleep(200);
      return scoped(t, 'restricted', { root: repo.root, ...other }, [cmd(`echo bb >> b.txt && git add b.txt && ${COMMIT}`)], { ownedFiles: ['b.txt'] });
    })(),
  ]);
  assert.deepEqual(pick(slow.results[0], ['status', 'headMoved', 'changed']), { status: 'passed', headMoved: true, changed: undefined });
  assert.deepEqual(committing.results[0].changed, ['b.txt']);
});

test('all items run after a plain failure', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const run = await runStepEvidence([cmd('exit 1'), cmd('echo two; exit 2'), cmd('true')], stepOptions(tempDir(t), runDir, outFile));
  assert.deepEqual(run.results.map((r) => r.status), ['failed', 'failed', 'passed']);
  assert.equal(run.why, 'exit 1 → exit 1 (+1 more failed)');
  assert.deepEqual(run.results.map((r) => r.log), [1, 2, 3].map((k) => join(runDir, `evidence-step-attempt-1-${k}.log`)));
});

// ---------------------------------------------------------------------------
// Schema items

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

test('schema items: pass, fail with errors, schemaChanged against the baseline', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  const schemaText = JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'integer' }, at: { format: 'date' } } });
  write(cwd, 'schemas/row.json', schemaText);
  write(cwd, 'out/good.json', '{"id":1}');
  write(cwd, 'out/bad.json', '{"id":"x"}');
  const items = [
    { type: 'schema', file: 'out/good.json', schema: 'schemas/row.json' },
    { type: 'schema', file: 'out/bad.json', schema: 'schemas/row.json', format: 'json' },
  ];
  const run = await runStepEvidence(items, stepOptions(cwd, runDir, outFile, { schemaBaseline: { 'schemas/row.json': sha1('older schema') } }));
  const [good, bad] = run.results;
  assert.deepEqual(pick(good, ['type', 'file', 'schema', 'format', 'status', 'exit', 'notes', 'schemaChanged', 'why']), {
    type: 'schema', file: 'out/good.json', schema: 'schemas/row.json', format: undefined, status: 'passed', exit: 0,
    notes: ['format is not checked (1 place)'], schemaChanged: true, why: null,
  });
  assert.deepEqual(pick(bad, ['format', 'status', 'exit', 'errorCount', 'errors', 'why']), {
    format: 'json', status: 'failed', exit: 1, errorCount: 1, errors: ['$.id must be integer (got string)'], why: 'not valid: 1 error',
  });
  assert.deepEqual(Object.keys(bad), ['type', 'file', 'schema', 'format', 'timeoutSec', 'status', 'exit', 'durationMs', 'errorCount', 'errors', 'notes', 'schemaChanged', 'tail', 'log', 'why']);
  assert.equal(run.why, 'schema schemas/row.json on out/bad.json → not valid: 1 error: $.id must be integer (got string)');

  const same = await runStepEvidence(items.slice(0, 1), stepOptions(cwd, runDir, outFile, { schemaBaseline: new Map([['schemas/row.json', sha1(schemaText)]]) }));
  assert.equal('schemaChanged' in same.results[0], false);

  const baseline = evidenceSchemaBaseline([...items, { type: 'schema', file: 'x.json', schema: 'schemas/none.json' }, cmd('true')], cwd);
  assert.deepEqual(baseline, { 'schemas/row.json': sha1(schemaText), 'schemas/none.json': null });
  writeFileSync(join(cwd, 'schemas/row.json'), JSON.stringify({ type: 'object' }));
  const weakened = await runStepEvidence(items.slice(0, 1), stepOptions(cwd, runDir, outFile, { schemaBaseline: baseline }));
  assert.equal(weakened.results[0].schemaChanged, true);
  assert.equal(weakened.results[0].status, 'passed');
});

test('schema on $output: a fenced JSON response passes with the note; commands see the response bytes', async (t) => {
  const { runDir } = runFiles(t);
  const cwd = tempDir(t);
  write(cwd, 'schemas/report.json', JSON.stringify({ type: 'object', required: ['claims'] }));
  const outFile = write(runDir, 'out-report-attempt-2.md', '```json\n{"claims":[]}\n```\n');
  const run = await runStepEvidence([
    { type: 'schema', file: '$output', schema: 'schemas/report.json' },
    cmd('cat "$BULLSWARM_STEP_OUTPUT" > seen.md'),
  ], stepOptions(cwd, runDir, outFile, { scope: evidenceScope({ mode: 'other', cwd, outFile }) }));
  assert.deepEqual(pick(run.results[0], ['file', 'status', 'notes']), { file: '$output', status: 'passed', notes: ['unwrapped one fenced code block'] });
  assert.equal(run.results[1].status, 'passed');
  assert.equal(readFileSync(join(cwd, 'seen.md'), 'utf8'), '```json\n{"claims":[]}\n```\n');

  writeFileSync(outFile, 'Here is the JSON: {"claims":[]}');
  const prose = await runStepEvidence([{ type: 'schema', file: '$output', schema: 'schemas/report.json' }], stepOptions(cwd, runDir, outFile));
  assert.equal(prose.results[0].status, 'failed');
  assert.equal(prose.results[0].exit, 2);
  assert.equal('fault' in prose.results[0], false);
  assert.match(prose.why, /^schema schemas\/report\.json on your final response → not JSON: /);
  assert.equal(prose.checkFault, false);
});

test('schema exit 2: a missing data file has no fault key; a missing schema is fault check', async (t) => {
  const { runDir, outFile } = runFiles(t);
  const cwd = tempDir(t);
  write(cwd, 's.json', '{}');
  const run = await runStepEvidence([
    { type: 'schema', file: 'out/x.json', schema: 's.json' },
    { type: 'schema', file: 's.json', schema: 'missing.json' },
  ], stepOptions(cwd, runDir, outFile));
  assert.deepEqual(pick(run.results[0], ['status', 'exit', 'fault', 'why']), { status: 'failed', exit: 2, fault: undefined, why: 'file missing: out/x.json' });
  assert.equal('fault' in run.results[0], false);
  assert.deepEqual(pick(run.results[1], ['status', 'exit', 'fault', 'why']), { status: 'failed', exit: 2, fault: 'check', why: 'schema missing: missing.json' });
  assert.equal(run.checkFault, true);
  assert.equal(run.why, 'schema s.json on out/x.json → file missing: out/x.json (+1 more failed)');

  const onlyCheck = await runStepEvidence([{ type: 'schema', file: 'out/x.json', schema: 's2.json' }], stepOptions(cwd, runDir, outFile));
  assert.equal(onlyCheck.why, 'check could not run: schema s2.json on out/x.json → schema missing: s2.json');
});

// ---------------------------------------------------------------------------
// The why, labels, briefs

test('evidenceFailureWhy: cutting, more-failed, schema form, no tail after changed/timed out, check prefix, kept suffix', () => {
  const failed = (extra) => ({ type: 'command', cmd: 'npm test', status: 'failed', exit: 1, tail: 'ok 1\n\nnot ok 2 - slug joins words\n\n', why: 'exit 1', ...extra });
  assert.equal(evidenceFailureWhy([failed()]), 'npm test → exit 1: not ok 2 - slug joins words');
  assert.equal(evidenceFailureWhy([{ type: 'command', cmd: 'x', status: 'passed' }]), null);
  assert.equal(evidenceFailureWhy([failed({ why: 'killed by SIGABRT', exit: null, tail: 'Abort trap' })]), 'npm test → killed by SIGABRT: Abort trap');
  assert.equal(evidenceFailureWhy([failed({ tail: '' })]), 'npm test → exit 1');
  assert.equal(evidenceFailureWhy([failed({ why: 'changed the deliverable: log.md', exit: 0 })]), 'npm test → changed the deliverable: log.md');
  assert.equal(evidenceFailureWhy([failed({ why: 'timed out after 5s', exit: null })]), 'npm test → timed out after 5s');
  assert.equal(evidenceFailureWhy([failed({ why: 'could not start: EAGAIN', exit: null })]), 'npm test → could not start: EAGAIN');
  assert.equal(evidenceFailureWhy([failed(), failed(), { status: 'not-run' }, failed()]), 'npm test → exit 1: not ok 2 - slug joins words (+2 more failed)');
  assert.equal(evidenceFailureWhy([{
    type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', status: 'failed', exit: 1,
    errors: ['$.events[1].date must match pattern ^\\d{4}$'], why: 'not valid: 2 errors',
  }]), 'schema schemas/event.json on out/events.json → not valid: 2 errors: $.events[1].date must match pattern ^\\d{4}$');
  assert.equal(evidenceFailureWhy([{ type: 'schema', file: 'out/x.json', schema: 's.json', status: 'failed', exit: 2, fault: 'check', why: 'schema missing: s.json' }]),
    'check could not run: schema s.json on out/x.json → schema missing: s.json');

  const longLine = `FAIL ${'x'.repeat(300)}`;
  const cutLine = evidenceFailureWhy([failed({ tail: longLine })]);
  assert.equal(cutLine, `npm test → exit 1: ${longLine.slice(0, 99)}…`);

  const longCmd = `node --test ${Array.from({ length: 30 }, (_, i) => `tests/case-${i}.test.js`).join(' ')}`;
  const label = evidenceItemLabel({ type: 'command', cmd: longCmd });
  assert.ok(label.length <= 80);
  assert.ok(label.endsWith('.js…'), label);
  assert.ok(longCmd.startsWith(label.slice(0, -1)));

  const act = ' · act steps are not retried';
  const manyPaths = `changed the deliverable: ${Array.from({ length: 20 }, (_, i) => `src/module-${i}/index.js`).join(', ')}`;
  const huge = evidenceFailureWhy([failed({ cmd: longCmd, why: manyPaths }), failed()], { suffix: act });
  assert.equal(huge.length, 240);
  assert.ok(huge.endsWith(`… (+1 more failed)${act}`), huge);
  assert.equal(evidenceFailureWhy([failed({ cmd: "grep -q 'confirmed 42' /tmp/outbox.txt", tail: '' })], { suffix: act }),
    "grep -q 'confirmed 42' /tmp/outbox.txt → exit 1 · act steps are not retried");
});

test('labels and the brief paragraph', () => {
  assert.equal(evidenceItemLabel({ type: 'schema', file: 'out/x.json', schema: 's.json' }), 'schema s.json on out/x.json');
  assert.equal(evidenceItemLabel({ type: 'schema', file: '$output', schema: 's.json' }), 'schema s.json on your final response');
  const items = [
    { type: 'command', cmd: 'npm test -- --run' },
    { type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', timeoutSec: 30 },
    { type: 'schema', file: 'out/rows.json', schema: 'schemas/row.json', format: 'jsonl' },
    { type: 'schema', file: '$output', schema: 'schemas/report.json' },
    { type: 'schema', file: '$output', schema: 'schemas/row.json', format: 'jsonl' },
  ];
  assert.deepEqual(evidenceBriefLines(items, { targetDir: '/work/acme', role: 'act', privateWorkspace: true }), [
    'Bullswarm will run these after you finish, in /work/acme, and fails this step if any of them fails:',
    '- command: `npm test -- --run` (passes on exit code 0; stopped after 120s)',
    `- schema: out/events.json must match the JSON schema schemas/event.json (check it yourself: node ${CHECKER_PATH} out/events.json schemas/event.json)`,
    `- schema: out/rows.json must match the JSON schema schemas/row.json (check it yourself: node ${CHECKER_PATH} --format jsonl out/rows.json schemas/row.json)`,
    '- schema: your final response must be only JSON that matches the JSON schema schemas/report.json; Bullswarm checks the saved response',
    '- schema: your final response must be only JSON Lines, one record per line, that matches the JSON schema schemas/row.json; Bullswarm checks the saved response',
    'Run them yourself before you finish and fix what fails. Do not change what they check (tests, schemas, scripts) to make them pass. A check that modifies your deliverable fails.',
    'Checks that read your final response ($BULLSWARM_STEP_OUTPUT) can only run after you finish; make your final response exactly what they expect.',
    'Never repeat an action to make a check pass; a failed check goes to the caller, not back to you.',
    'Only your territory files are merged back. Delete any file a check you ran created outside them before you finish, or the step fails as out of scope.',
  ]);
  assert.deepEqual(evidenceBriefLines([{ type: 'command', cmd: 'make check', timeoutSec: 600 }], { targetDir: '/w', role: 'produce' }), [
    'Bullswarm will run these after you finish, in /w, and fails this step if any of them fails:',
    '- command: `make check` (passes on exit code 0; stopped after 600s)',
    'Run them yourself before you finish and fix what fails. Do not change what they check (tests, schemas, scripts) to make them pass. A check that modifies your deliverable fails.',
  ]);
  assert.equal(evidenceBriefLines([{ type: 'command', cmd: 'grep -q ok "$BULLSWARM_STEP_OUTPUT"' }], { targetDir: '/w' })[3],
    'Checks that read your final response ($BULLSWARM_STEP_OUTPUT) can only run after you finish; make your final response exactly what they expect.');
  assert.deepEqual(evidenceBriefLines([], { targetDir: '/w' }), []);
});

test('rewriteEvidenceCwd replaces the caller cwd in commands only', () => {
  const items = [cmd('node /src/acme/scripts/check.mjs /src/acme/out'), { type: 'schema', file: 'o.json', schema: 's.json' }];
  const rewritten = rewriteEvidenceCwd(items, '/src/acme', '/copies/acme-1');
  assert.deepEqual(rewritten, [cmd('node /copies/acme-1/scripts/check.mjs /copies/acme-1/out'), items[1]]);
  assert.equal(items[0].cmd, 'node /src/acme/scripts/check.mjs /src/acme/out');
  assert.equal(rewriteEvidenceCwd(items, '/src/acme', '/src/acme'), items);
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object?.[key]]));
}
