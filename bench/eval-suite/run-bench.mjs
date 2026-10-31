#!/usr/bin/env node
// The frozen benchmark: run each task in tasks/ through Bullswarm on a fresh
// copy of its fixture, then score it with the task's hidden tests.
//
//   node bench/eval-suite/run-bench.mjs --out <dir> [--tasks t1,t2] [--bullswarm <cmd>]
//     [--run-flags "<flags for bullswarm run>"] [--goal-flags "<flags for workflow goal>"]
//   node bench/eval-suite/run-bench.mjs --check-kits
//
// Each task directory holds task.json ({mode: "run"|"program", lane?,
// timeoutSec}), prompt.md, fixture/, hidden/, reference/, check.sh and, for
// mode "program", program.json. {cwd} in prompt.md and program.json is
// replaced by the task's working copy. The agent under test sees only the
// working copy: hidden/ and reference/ never enter it.
//
// Per task it records correctness (the hidden-test SCORE), worker tokens (all
// and output), wall-clock minutes, attempts, and human interventions: each
// time the run stopped for a person (a needs-you block, a loop out of rounds)
// counts one. The runner answers a loop out of rounds by ending the loop
// (`workflow continue`, recorded as condition not met) and never rescues a
// failed step, so a run that needed a person scores as it stood.
//
// --check-kits proves every kit without Bullswarm: hidden tests mostly fail on
// the fixture and all pass on fixture + reference.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(SUITE, 'tasks');

function args(argv) {
  const out = { out: null, tasks: null, bullswarm: 'bullswarm', runFlags: '', goalFlags: '', checkKits: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === '--out') out.out = value();
    else if (flag === '--tasks') out.tasks = value().split(',').filter(Boolean);
    else if (flag === '--bullswarm') out.bullswarm = value();
    else if (flag === '--run-flags') out.runFlags = value();
    else if (flag === '--goal-flags') out.goalFlags = value();
    else if (flag === '--check-kits') out.checkKits = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.checkKits && !out.out) throw new Error('--out <dir> is required');
  return out;
}

const words = (text) => text.split(/\s+/).filter(Boolean);
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const bullswarmHome = () => process.env.BULLSWARM_HOME || join(homedir(), '.bullswarm');

function taskIds(selected) {
  const all = readdirSync(TASKS).filter((name) => existsSync(join(TASKS, name, 'task.json'))).sort();
  return selected ? all.filter((id) => selected.includes(id)) : all;
}

function freshCopy(id, root, withReference = false) {
  const dir = join(root, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(TASKS, id, 'fixture'), dir, { recursive: true });
  if (withReference) cpSync(join(TASKS, id, 'reference'), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}

function score(id, dir) {
  const run = spawnSync('bash', [join(TASKS, id, 'check.sh'), dir], { encoding: 'utf8' });
  const match = /SCORE (\d+)\/(\d+)\s*$/.exec(run.stdout ?? '');
  return match ? { passed: Number(match[1]), total: Number(match[2]) } : { passed: 0, total: null, error: (run.stderr || run.stdout || '').slice(-400) };
}

function checkKits(ids) {
  const root = mkdtempSync(join(tmpdir(), 'bench-kits-'));
  let ok = true;
  for (const id of ids) {
    const before = score(id, freshCopy(id, join(root, 'fixture')));
    const after = score(id, freshCopy(id, join(root, 'reference'), true));
    const good = after.total > 0 && after.passed === after.total && before.passed < before.total;
    ok &&= good;
    console.log(`${good ? '✓' : '✗'} ${id}: fixture ${before.passed}/${before.total}, reference ${after.passed}/${after.total}`);
  }
  rmSync(root, { recursive: true, force: true });
  return ok ? 0 : 1;
}

// Worker tokens and wall time of one run, from its saved state.
function runFacts(runId) {
  const state = readJson(join(bullswarmHome(), 'workflows', runId, 'state.json'));
  if (!state) return null;
  const attempts = state.attempts ?? [];
  const tokens = attempts.reduce((n, a) => n + (a.usage?.tokens?.totalKnown ?? 0), 0);
  const output = attempts.reduce((n, a) => n + (a.usage?.tokens?.output ?? 0) + (a.usage?.tokens?.reasoning ?? 0), 0);
  const usd = attempts.reduce((n, a) => n + (a.usage?.api?.usd ?? 0), 0);
  const started = Date.parse(state.lifecycle?.startedAt ?? '');
  const finished = Date.parse(state.lifecycle?.finishedAt ?? '');
  return {
    status: state.lifecycle?.status ?? null,
    attempts: attempts.length,
    pools: [...new Set(attempts.map((a) => a.pool).filter(Boolean))],
    models: [...new Set(attempts.map((a) => a.model).filter(Boolean))],
    tokens,
    outputTokens: output,
    apiUsdEquivalent: Math.round(usd * 100) / 100,
    wallMin: Number.isFinite(started) && Number.isFinite(finished) ? Math.round((finished - started) / 600) / 100 : null,
  };
}

function lastJson(text) {
  const start = text.lastIndexOf('\n{');
  for (const from of [start + 1, text.indexOf('{')]) {
    if (from < 0) continue;
    try { return JSON.parse(text.slice(from)); } catch { /* try the next */ }
  }
  return null;
}

function runTask(id, opts, workRoot, log) {
  const task = readJson(join(TASKS, id, 'task.json'));
  const dir = freshCopy(id, workRoot);
  const render = (file) => readFileSync(join(TASKS, id, file), 'utf8').replaceAll('{cwd}', dir);
  const taskFile = join(workRoot, `${id}.prompt.md`);
  writeFileSync(taskFile, render('prompt.md'));
  const startedAt = Date.now();
  let runId = null;
  let interventions = 0;
  const notes = [];
  if (task.mode === 'run') {
    const run = spawnSync(opts.bullswarm, ['run', `--lane=${task.lane ?? 'build'}`, `--add-dir=${dir}`, `--task-file=${taskFile}`, '--json',
      `--timeout=${task.timeoutSec ?? 3600}`, ...words(opts.runFlags)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const verdict = lastJson(run.stdout ?? '');
    runId = verdict?.runId ?? null;
    if (!verdict?.ok) { interventions += 1; notes.push(`run ended ok=false: ${verdict?.why ?? (run.stderr ?? '').slice(-200)}`); }
  } else {
    const program = join(workRoot, `${id}.program.json`);
    writeFileSync(program, render('program.json'));
    const launch = spawnSync(opts.bullswarm, ['workflow', 'goal', `bench ${id}`, `--cwd=${dir}`, `--program=${program}`, '--json', ...words(opts.goalFlags)], { encoding: 'utf8' });
    const doc = lastJson(launch.stdout ?? '');
    runId = doc?.runId ?? null;
    const shortId = doc?.shortId ?? runId;
    if (!shortId) notes.push(`launch failed: ${(launch.stderr || launch.stdout || '').slice(-300)}`);
    const deadline = startedAt + (task.timeoutSec ?? 4 * 3600) * 1000;
    while (shortId && Date.now() < deadline) {
      const left = Math.max(60, Math.round((deadline - Date.now()) / 1000));
      const watch = spawnSync(opts.bullswarm, ['workflow', 'watch', shortId, '--until', 'outcome', '--timeout', String(Math.min(left, 3000))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const text = `${watch.stdout ?? ''}`;
      log(`${id}: ${text.trim().split('\n').slice(-3).join(' | ')}`);
      if (/watch timed out/.test(text)) continue;
      const loopWaits = [...text.matchAll(/loop (\S+) out of rounds/g)].map((m) => m[1]);
      if (/outcome: waiting/.test(text) && loopWaits.length) {
        for (const loop of new Set(loopWaits)) {
          interventions += 1;
          notes.push(`loop ${loop} out of rounds: ended it (condition not met)`);
          spawnSync(opts.bullswarm, ['workflow', 'continue', shortId, loop], { encoding: 'utf8' });
        }
        continue;
      }
      if (/outcome: waiting/.test(text)) { interventions += 1; notes.push('run waiting for a person; left as is'); break; }
      if (/needs you|back to you/i.test(text)) { interventions += 1; notes.push('a step came back to a person; not rescued'); }
      break;
    }
    if (Date.now() >= deadline) notes.push('runner deadline reached');
  }
  const facts = runId ? runFacts(runId) : null;
  const result = score(id, dir);
  return { id, mode: task.mode, runId, score: result, interventions, notes, runnerMinutes: Math.round((Date.now() - startedAt) / 600) / 100, ...facts };
}

function markdown(results, meta) {
  const lines = [`# Benchmark ${meta.at.slice(0, 10)} · bullswarm ${meta.version}`, '', `Flags: run \`${meta.runFlags || '(none)'}\`, goal \`${meta.goalFlags || '(none)'}\`.`, '',
    '| task | hidden tests | interventions | wall (min) | worker tokens (all) | output tokens | API-equivalent USD | attempts | pools · models | run | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.score.passed}/${r.score.total ?? '?'} | ${r.interventions} | ${r.wallMin ?? r.runnerMinutes} | ${r.tokens?.toLocaleString('en-US') ?? '—'} | ${r.outputTokens?.toLocaleString('en-US') ?? '—'} | ${r.apiUsdEquivalent ?? '—'} | ${r.attempts ?? '—'} | ${(r.pools ?? []).join(', ')} · ${(r.models ?? []).join(', ')} | ${r.runId ?? '—'} | ${r.notes.join('; ').replace(/\|/g, '\\|') || '—'} |`);
  }
  return `${lines.join('\n')}\n`;
}

const opts = args(process.argv.slice(2));
const ids = taskIds(opts.tasks);
if (opts.checkKits) process.exit(checkKits(ids));
mkdirSync(opts.out, { recursive: true });
const workRoot = join(opts.out, 'work');
mkdirSync(workRoot, { recursive: true });
const version = spawnSync(opts.bullswarm, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? 'unknown';
const meta = { at: new Date().toISOString(), version, runFlags: opts.runFlags, goalFlags: opts.goalFlags };
const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
const results = [];
for (const id of ids) {
  log(`${id}: start`);
  results.push(runTask(id, opts, workRoot, log));
  writeFileSync(join(opts.out, 'bench.json'), `${JSON.stringify({ meta, results }, null, 2)}\n`);
  log(`${id}: done ${JSON.stringify(results.at(-1).score)}`);
}
const text = markdown(results, meta);
writeFileSync(join(opts.out, 'bench.md'), text);
process.stdout.write(text);
