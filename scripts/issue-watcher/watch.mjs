#!/usr/bin/env node
// bullswarm issue-watcher — poll GitHub for new issues, delegate triage (and
// one fix attempt for a clear fixable bug) through `bullswarm run`.
//
// Design constraints this file is written to:
//
//   W1. Idle costs ZERO model tokens. A pass that finds no new issue runs
//       `gh issue list` and nothing else — no delegate is ever spawned.
//   W2. Self-contained. `install.mjs` copies this file plus the two templates
//       into <dir>/bin so the launchd agent runs from a stable path that
//       survives any checkout moving, being deleted, or changing branch.
//       Therefore: zero imports from src/, zero dependencies, node >= 18.
//   W3. The watcher is the only thing holding GitHub credentials. Delegates
//       run with GH_TOKEN/GITHUB_TOKEN stripped and GH_CONFIG_DIR pointed at
//       an empty directory, so a worker cannot act as the owner on GitHub
//       even if the issue text talks it into trying.
//   W4. Issue text is untrusted input. It reaches a model only inside a
//       fenced block introduced as quoted material, and only after any run of
//       6+ backticks is defanged so it cannot close the fence.
//   W5. Never merge, never close, never force-push, never touch a branch
//       other than fix/issue-<n>. A maintainer merges.
//   W6. Exit code is not a success signal for a delegate — read `ok` from the
//       `bullswarm run --json` verdict (repo doctrine 1).

import {
  mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, renameSync,
  statSync, rmSync, utimesSync, realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATE_VERSION = 1;
export const TRIAGE_KINDS = ['bug', 'enhancement', 'question', 'invalid', 'duplicate'];
/** A triage that keeps producing junk is attempted this many times, then dropped. */
export const MAX_TRIAGE_ATTEMPTS = 3;
/** A lock directory older than this is assumed to belong to a dead pass. */
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const KEEP_COUNTER_DAYS = 30;
/** A delegate may legitimately take a long time; a hung one must not wedge the agent. */
const DISPATCH_TIMEOUT_MS = 90 * 60 * 1000;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 60 * 60 * 1000;

// --- configuration -----------------------------------------------------------

export function loadConfig(env = process.env) {
  const home = env.BULLSWARM_ISSUE_WATCHER_HOME || env.HOME || homedir();
  const dir = resolve(env.BULLSWARM_ISSUE_WATCHER_DIR || join(home, '.bullswarm', 'issue-watcher'));
  const num = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    dir,
    stateFile: join(dir, 'state.json'),
    lockDir: join(dir, 'lock'),
    pausedFile: join(dir, 'paused'),
    logDir: join(dir, 'log'),
    logFile: join(dir, 'log', 'watch.log'),
    repoDir: join(dir, 'repo'),
    tasksDir: join(dir, 'tasks'),
    // An empty GH config dir handed to every delegate (W3).
    ghEmptyDir: join(dir, 'gh-empty'),
    repo: env.BULLSWARM_ISSUE_WATCHER_REPO || null, // null -> state.json -> default
    defaultRepo: 'cowcow02/bullswarm',
    gh: env.BULLSWARM_ISSUE_WATCHER_GH || 'gh',
    bullswarm: env.BULLSWARM_ISSUE_WATCHER_BULLSWARM || 'bullswarm',
    testCommand: env.BULLSWARM_ISSUE_WATCHER_TEST_COMMAND || 'npm test',
    maxTriagesPerDay: num(env.BULLSWARM_ISSUE_WATCHER_MAX_TRIAGES_PER_DAY, 6),
    maxFixesPerDay: num(env.BULLSWARM_ISSUE_WATCHER_MAX_FIXES_PER_DAY, 2),
    noNotify: env.BULLSWARM_ISSUE_WATCHER_NO_NOTIFY === '1',
    templateDir: HERE,
    env,
  };
}

// --- logging -----------------------------------------------------------------

function logLine(cfg, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    if (existsSync(cfg.logFile) && statSync(cfg.logFile).size > LOG_ROTATE_BYTES) {
      renameSync(cfg.logFile, `${cfg.logFile}.1`);
    }
    appendFileSync(cfg.logFile, line);
  } catch { /* logging must never be the reason a pass dies */ }
  process.stdout.write(line);
}

// --- state -------------------------------------------------------------------

export function emptySeenEntry(status) {
  return {
    status,
    kind: null,
    triagedAt: null,
    attempts: 0,
    fixAttempts: 0,
    pool: null,
    model: null,
    prUrl: null,
  };
}

function emptyState(repo, nowIso) {
  return {
    version: STATE_VERSION,
    repo,
    installedAt: nowIso,
    lastPassAt: null,
    seen: {},
    counters: {},
  };
}

export function readState(cfg) {
  if (!existsSync(cfg.stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cfg.stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    parsed.seen ??= {};
    parsed.counters ??= {};
    return parsed;
  } catch {
    return null;
  }
}

/** Temp file + rename: a concurrent reader never sees a half-written state. */
export function writeState(cfg, state) {
  mkdirSync(dirname(cfg.stateFile), { recursive: true });
  const tmp = `${cfg.stateFile}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, cfg.stateFile);
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function counters(state, day) {
  state.counters ??= {};
  state.counters[day] ??= { triages: 0, fixes: 0 };
  const days = Object.keys(state.counters).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_COUNTER_DAYS))) {
    delete state.counters[old];
  }
  return state.counters[day];
}

// --- process helpers ---------------------------------------------------------

function exec(cfg, file, args, { cwd, env, timeout = GIT_TIMEOUT_MS, quiet = false, shell = false } = {}) {
  if (!quiet) logLine(cfg, `cmd: ${shell ? file : [file, ...args].join(' ')}${cwd ? ` (cwd ${cwd})` : ''}`);
  // `shell: true` is only used for BULLSWARM_ISSUE_WATCHER_TEST_COMMAND, which
  // is a command STRING owned by the operator, never issue-derived text.
  const r = spawnSync(file, shell ? [] : args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    shell,
  });
  const out = { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
  out.ok = !out.error && out.status === 0;
  if (!out.ok && !quiet) {
    const detail = out.error ? out.error.message : (out.stderr || out.stdout).trim().split('\n')[0] ?? '';
    logLine(cfg, `  -> failed (status ${out.status}) ${detail}`);
  }
  return out;
}

/**
 * The environment every delegate and the verification test run gets: no GitHub
 * credentials at all, and no colour/config leakage from the launchd job (W3).
 */
export function workerEnv(cfg) {
  const env = { ...cfg.env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CONFIG_DIR', 'FORCE_COLOR', 'NO_COLOR']) {
    delete env[key];
  }
  mkdirSync(cfg.ghEmptyDir, { recursive: true });
  env.GH_CONFIG_DIR = cfg.ghEmptyDir;
  return env;
}

function notify(cfg, title, body) {
  if (cfg.noNotify || process.platform !== 'darwin') return;
  const escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  spawnSync('osascript', ['-e', `display notification "${escape(body)}" with title "${escape(title)}"`], {
    encoding: 'utf8', timeout: 10_000,
  });
  // Best effort by design: a failed notification is never a failed pass.
}

// --- templates ---------------------------------------------------------------

/**
 * Any run of 6 or more backticks in untrusted text is clipped to 5, so it can
 * never close the 6-backtick fence the templates quote issue text inside (W4).
 * Ordinary ``` code blocks in an issue body survive untouched.
 */
export function defang(text) {
  return String(text ?? '').replace(/`{6,}/g, '`````');
}

export function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (
    Object.hasOwn(values, key) ? defang(values[key]) : whole
  ));
}

function templateFor(cfg, name) {
  return readFileSync(join(cfg.templateDir, name), 'utf8');
}

// --- triage payload ----------------------------------------------------------

/** The LAST fenced json block in the worker's report is the machine answer. */
export function extractLastJsonBlock(markdown) {
  const re = /```[ \t]*json[ \t]*\r?\n([\s\S]*?)```/gi;
  let last = null;
  for (const m of String(markdown ?? '').matchAll(re)) last = m[1];
  if (last == null) return { ok: false, why: 'no fenced json block in the report' };
  try {
    return { ok: true, value: JSON.parse(last) };
  } catch (error) {
    return { ok: false, why: `last fenced json block does not parse: ${error.message}` };
  }
}

export function validateTriage(raw) {
  const bad = (why) => ({ ok: false, why });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('payload is not an object');
  if (!TRIAGE_KINDS.includes(raw.kind)) return bad(`kind ${JSON.stringify(raw.kind)} is not one of ${TRIAGE_KINDS.join('|')}`);
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)
    || raw.confidence < 0 || raw.confidence > 1) {
    return bad(`confidence ${JSON.stringify(raw.confidence)} is not a number in 0-1`);
  }
  const str = (key, cap) => {
    const v = raw[key];
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return null;
    if (v.length > cap) return null;
    return v;
  };
  const summary = str('summary', 400);
  if (summary === null) return bad('summary is not a string of at most 400 chars');
  const reproSteps = str('reproSteps', 800);
  if (reproSteps === null) return bad('reproSteps is not a string of at most 800 chars');
  const proposedFix = str('proposedFix', 800);
  if (proposedFix === null) return bad('proposedFix is not a string of at most 800 chars');
  if (!(raw.reproduced === true || raw.reproduced === false || raw.reproduced === null
    || raw.reproduced === undefined)) {
    return bad('reproduced is not true, false, or null');
  }
  if (!Array.isArray(raw.affectedFiles) || raw.affectedFiles.some((f) => typeof f !== 'string')) {
    return bad('affectedFiles is not an array of strings');
  }
  if (typeof raw.fixable !== 'boolean') return bad('fixable is not a boolean');
  let needsInfo = null;
  if (raw.needsInfo !== null && raw.needsInfo !== undefined) {
    if (typeof raw.needsInfo !== 'string' || raw.needsInfo.length > 300) {
      return bad('needsInfo is not null or a string of at most 300 chars');
    }
    needsInfo = raw.needsInfo.trim() === '' ? null : raw.needsInfo;
  }
  return {
    ok: true,
    value: {
      kind: raw.kind,
      confidence: raw.confidence,
      summary,
      reproduced: raw.reproduced === undefined ? null : raw.reproduced,
      reproSteps,
      affectedFiles: raw.affectedFiles,
      proposedFix,
      fixable: raw.fixable,
      needsInfo,
    },
  };
}

// --- comment bodies ----------------------------------------------------------

const REVIEW_NOTE = 'A maintainer reviews every automated action.';

export function footer(verb, pool, model, wallSec) {
  return `— automated ${verb} by bullswarm issue-watcher (${pool}/${model}, ${wallSec} s). ${REVIEW_NOTE}`;
}

export function triageComment(t, { pool, model, wallSec }) {
  const reproduced = t.reproduced === true ? 'yes' : t.reproduced === false ? 'no' : 'not attempted';
  const parts = [];
  parts.push(t.summary || 'Triage produced no summary line.');
  parts.push(`**Reproduced:** ${reproduced}`);
  if (t.reproSteps) parts.push(t.reproSteps);
  parts.push(t.affectedFiles.length
    ? `**Affected files:** ${t.affectedFiles.map((f) => `\`${f}\``).join(', ')}`
    : '**Affected files:** none identified');
  if (t.needsInfo) parts.push(`**Question for the reporter:** ${t.needsInfo}`);
  else parts.push(`**Proposed fix:** ${t.proposedFix || 'none proposed; a maintainer should decide.'}`);
  parts.push(footer('triage', pool, model, wallSec));
  return `${parts.join('\n\n')}\n`;
}

export function prBody({ number, changed, report, summary, testLine, pool, model, wallSec }) {
  const parts = [];
  parts.push('## What changed');
  parts.push(changed.trim() ? `\`\`\`\n${changed.trim()}\n\`\`\`` : '(no file list available)');
  if (report.trim()) {
    parts.push('The delegate reported:');
    parts.push(`\`\`\`text\n${defang(report.trim().slice(0, 1200))}\n\`\`\``);
  }
  parts.push('## Triage summary');
  parts.push(summary || '(none recorded)');
  parts.push(`Verified by the watcher: the test suite passed in the watcher's own clone (\`${testLine}\`) and the diff is non-empty.`);
  parts.push(`Fixes #${number}`);
  parts.push(footer('fix', pool, model, wallSec));
  return `${parts.join('\n\n')}\n`;
}

// --- git / gh ----------------------------------------------------------------

function repoName(cfg, state) {
  return cfg.repo || state?.repo || cfg.defaultRepo;
}

function ghJson(cfg, args) {
  const r = exec(cfg, cfg.gh, args, { timeout: GIT_TIMEOUT_MS });
  if (!r.ok) return { ok: false, why: (r.stderr || r.stdout).trim().split('\n')[0] || `gh exited ${r.status}` };
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch (error) {
    return { ok: false, why: `gh output is not JSON: ${error.message}` };
  }
}

function ensureClone(cfg, repo) {
  if (!existsSync(join(cfg.repoDir, '.git'))) {
    mkdirSync(cfg.dir, { recursive: true });
    const cloned = exec(cfg, cfg.gh, ['repo', 'clone', repo, 'repo'], { cwd: cfg.dir, timeout: 30 * 60_000 });
    if (!cloned.ok) return { ok: false, why: 'clone failed' };
  }
  const fetched = exec(cfg, 'git', ['-C', cfg.repoDir, 'fetch', '--prune', 'origin']);
  if (!fetched.ok) return { ok: false, why: 'fetch failed' };
  const checked = exec(cfg, 'git', ['-C', cfg.repoDir, 'checkout', '-q', '--detach', 'origin/main']);
  if (!checked.ok) return { ok: false, why: 'checkout origin/main failed' };
  return { ok: true };
}

// --- delegation --------------------------------------------------------------

function dispatch(cfg, { lane, effort, taskFile }) {
  const args = [
    'run', '--lane', lane, '--effort', effort, '--no-caller',
    '--add-dir', cfg.repoDir, '--task-file', taskFile, '--json',
  ];
  const startedAt = Date.now();
  const r = exec(cfg, cfg.bullswarm, args, { env: workerEnv(cfg), timeout: DISPATCH_TIMEOUT_MS });
  const wallSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  let verdict = null;
  try {
    verdict = JSON.parse(r.stdout.trim());
  } catch {
    // A CLI that printed a banner around the object still yields the object.
    const first = r.stdout.indexOf('{');
    const last = r.stdout.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { verdict = JSON.parse(r.stdout.slice(first, last + 1)); } catch { verdict = null; }
    }
  }
  if (!verdict || typeof verdict !== 'object') {
    return { ok: false, why: 'bullswarm printed no parsable verdict', pool: 'unknown', model: 'unknown', wallSec, outFile: null, verdict: null };
  }
  return {
    // Doctrine 1 / W6: the exit code is not the signal, `ok` is.
    ok: verdict.ok === true,
    why: verdict.why ?? (verdict.ok === true ? 'verified' : 'no reason given'),
    failureKind: verdict.failureKind ?? null,
    pool: verdict.pick?.pool ?? 'unknown',
    model: verdict.pick?.model ?? 'unknown',
    outFile: verdict.outFile ?? null,
    wallSec: Number.isFinite(verdict.meta?.wallSec) ? Math.round(verdict.meta.wallSec) : wallSec,
    verdict,
  };
}

// --- triage ------------------------------------------------------------------

function issueFields(issue) {
  const comments = Array.isArray(issue.comments)
    ? issue.comments.map((c) => `@${c.author?.login ?? 'unknown'} wrote:\n${c.body ?? ''}`).join('\n\n---\n\n')
    : '';
  return {
    number: String(issue.number),
    title: String(issue.title ?? '').replace(/[\r\n]+/g, ' ').trim(),
    url: String(issue.url ?? ''),
    author: String(issue.author?.login ?? 'unknown'),
    body: String(issue.body ?? '').trim() || '(the issue body is empty)',
    comments: comments || '(no comments)',
  };
}

function runTriage(cfg, state, repo, number, entry) {
  const viewed = ghJson(cfg, [
    'issue', 'view', String(number), '--repo', repo,
    '--json', 'number,title,body,author,labels,comments,url',
  ]);
  if (!viewed.ok) {
    logLine(cfg, `#${number}: issue view failed (${viewed.why}); leaving state untouched for the next pass`);
    return { outcome: 'skip' };
  }
  const issue = viewed.value;
  const cloned = ensureClone(cfg, repo);
  if (!cloned.ok) {
    logLine(cfg, `#${number}: ${cloned.why}; leaving state untouched for the next pass`);
    return { outcome: 'skip' };
  }

  mkdirSync(cfg.tasksDir, { recursive: true });
  const taskFile = join(cfg.tasksDir, `issue-${number}-triage.md`);
  const fields = issueFields(issue);
  writeFileSync(taskFile, renderTemplate(templateFor(cfg, 'triage-task.md'), {
    ...fields, repoDir: cfg.repoDir,
  }));

  const run = dispatch(cfg, { lane: 'analyze', effort: 'medium', taskFile });
  counters(state, dayKey()).triages += 1;
  entry.attempts += 1;
  entry.pool = run.pool;
  entry.model = run.model;

  const fail = (why) => {
    entry.status = 'triage-failed';
    logLine(cfg, `#${number}: triage attempt ${entry.attempts}/${MAX_TRIAGE_ATTEMPTS} failed — ${why}`);
    if (entry.attempts >= MAX_TRIAGE_ATTEMPTS) {
      logLine(cfg, `#${number}: triage retry cap reached (${MAX_TRIAGE_ATTEMPTS} attempts); leaving this issue alone, nothing posted`);
    }
    return { outcome: 'triage-failed' };
  };

  if (!run.ok) return fail(`bullswarm run not ok: ${run.why}${run.failureKind ? ` (${run.failureKind})` : ''}`);
  if (!run.outFile || !existsSync(run.outFile)) return fail(`verdict named no readable outFile (${run.outFile ?? 'null'})`);

  const block = extractLastJsonBlock(readFileSync(run.outFile, 'utf8'));
  if (!block.ok) return fail(block.why);
  const checked = validateTriage(block.value);
  if (!checked.ok) return fail(`invalid triage payload: ${checked.why}`);
  const triage = checked.value;

  const labelled = exec(cfg, cfg.gh, ['issue', 'edit', String(number), '--repo', repo, '--add-label', triage.kind]);
  if (!labelled.ok) logLine(cfg, `#${number}: add-label ${triage.kind} failed; continuing to the comment`);

  const bodyFile = join(cfg.tasksDir, `issue-${number}-triage-comment.md`);
  writeFileSync(bodyFile, triageComment(triage, run));
  const commented = exec(cfg, cfg.gh, ['issue', 'comment', String(number), '--repo', repo, '--body-file', bodyFile]);
  if (!commented.ok) logLine(cfg, `#${number}: posting the triage comment failed`);

  entry.status = 'triaged';
  entry.kind = triage.kind;
  entry.triagedAt = new Date().toISOString();
  logLine(cfg, `#${number}: triaged as ${triage.kind} (confidence ${triage.confidence}, fixable ${triage.fixable}) by ${run.pool}/${run.model} in ${run.wallSec}s`);
  notify(cfg, 'bullswarm issue-watcher', `#${number} triaged as ${triage.kind}`);
  return { outcome: 'triaged', triage, run, fields };
}

// --- fix ---------------------------------------------------------------------

export function qualifiesForFix(triage, entry) {
  return triage.kind === 'bug'
    && triage.fixable === true
    && triage.confidence >= 0.7
    && entry.fixAttempts === 0;
}

function cleanClone(cfg) {
  exec(cfg, 'git', ['-C', cfg.repoDir, 'checkout', '-q', '--', '.']);
  exec(cfg, 'git', ['-C', cfg.repoDir, 'clean', '-fdq']);
}

function testLineFrom(output) {
  // Prefer the TAP totals line ("# tests N"); a per-test "ok N - ..." line is
  // only a fallback, since it names one test rather than the whole run.
  const lines = String(output).split('\n').map((raw) => raw.trimEnd());
  const totals = lines.find((line) => /^# tests\b/.test(line));
  if (totals) return totals.trim();
  const first = lines.find((line) => /^ok\b/.test(line));
  if (first) return first.trim();
  return 'exit 0, no TAP summary line';
}

function runFix(cfg, state, repo, number, entry, { triage, fields }) {
  const branch = `fix/issue-${number}`;
  const branched = exec(cfg, 'git', ['-C', cfg.repoDir, 'checkout', '-q', '-B', branch, 'origin/main']);
  if (!branched.ok) {
    logLine(cfg, `#${number}: could not create ${branch}; skipping the fix attempt`);
    return;
  }

  const taskFile = join(cfg.tasksDir, `issue-${number}-fix.md`);
  writeFileSync(taskFile, renderTemplate(templateFor(cfg, 'fix-task.md'), {
    ...fields,
    repoDir: cfg.repoDir,
    summary: triage.summary || '(none)',
    reproSteps: triage.reproSteps || '(not reproduced)',
    proposedFix: triage.proposedFix || '(none proposed)',
    affectedFiles: triage.affectedFiles.length ? triage.affectedFiles.join(', ') : '(none named)',
  }));

  const run = dispatch(cfg, { lane: 'build', effort: 'high', taskFile });
  counters(state, dayKey()).fixes += 1;
  entry.fixAttempts += 1;
  entry.pool = run.pool;
  entry.model = run.model;

  const giveUp = (why) => {
    logLine(cfg, `#${number}: fix attempt abandoned — ${why}`);
    cleanClone(cfg);
    const bodyFile = join(cfg.tasksDir, `issue-${number}-fix-failed.md`);
    writeFileSync(bodyFile, 'An automated fix attempt did not pass the test suite (or produced no change); left for a maintainer.\n');
    exec(cfg, cfg.gh, ['issue', 'comment', String(number), '--repo', repo, '--body-file', bodyFile]);
    exec(cfg, cfg.gh, ['issue', 'edit', String(number), '--repo', repo, '--add-label', 'help wanted']);
    entry.status = 'fix-failed';
  };

  if (!run.ok) return giveUp(`bullswarm run not ok: ${run.why}`);

  // The watcher verifies on its own. The delegate's own claim is not evidence.
  const tested = exec(cfg, cfg.testCommand, [], {
    cwd: cfg.repoDir, env: workerEnv(cfg), timeout: TEST_TIMEOUT_MS, shell: true,
  });
  if (!tested.ok) return giveUp(`the test command (${cfg.testCommand}) exited ${tested.status}`);
  const testLine = testLineFrom(`${tested.stdout}\n${tested.stderr}`);

  const dirty = exec(cfg, 'git', ['-C', cfg.repoDir, 'status', '--porcelain'], { quiet: true });
  if (!dirty.ok || dirty.stdout.trim() === '') return giveUp('the delegate left an empty diff');

  exec(cfg, 'git', ['-C', cfg.repoDir, 'add', '-A']);
  const stat = exec(cfg, 'git', ['-C', cfg.repoDir, 'diff', '--cached', '--stat'], { quiet: true });
  const committed = exec(cfg, 'git', ['-C', cfg.repoDir, 'commit',
    '-m', `fix: ${fields.title} (#${number})`,
    '-m', `Built by bullswarm issue-watcher: ${run.pool}/${run.model}; tests: ${testLine}.`,
    '-m', `Fixes #${number}`,
  ]);
  if (!committed.ok) return giveUp('git commit failed');

  const pushed = exec(cfg, 'git', ['-C', cfg.repoDir, 'push', '-u', 'origin', branch], { timeout: 15 * 60_000 });
  if (!pushed.ok) return giveUp('git push failed');

  const report = run.outFile && existsSync(run.outFile) ? readFileSync(run.outFile, 'utf8') : '';
  const prFile = join(cfg.tasksDir, `issue-${number}-pr.md`);
  writeFileSync(prFile, prBody({
    number, changed: stat.stdout, report, summary: triage.summary, testLine, ...run,
  }));
  const pr = exec(cfg, cfg.gh, ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
    '--title', `Fix #${number}: ${fields.title}`, '--body-file', prFile]);
  if (!pr.ok) return giveUp('gh pr create failed');

  const prUrl = (pr.stdout.match(/https?:\/\/\S+/g) ?? []).pop() ?? null;
  const noteFile = join(cfg.tasksDir, `issue-${number}-pr-comment.md`);
  writeFileSync(noteFile, `An automated fix attempt is open for review: ${prUrl ?? '(URL not reported by gh)'}\n\n`
    + `${footer('fix', run.pool, run.model, run.wallSec)}\n`);
  exec(cfg, cfg.gh, ['issue', 'comment', String(number), '--repo', repo, '--body-file', noteFile]);

  entry.status = 'fix-open';
  entry.prUrl = prUrl;
  logLine(cfg, `#${number}: pull request opened ${prUrl ?? '(url unknown)'} from ${branch}`);
  notify(cfg, 'bullswarm issue-watcher', `#${number} fix PR opened`);
  return undefined;
}

// --- pass --------------------------------------------------------------------

function selectIssues(state, issues) {
  const installedAt = Date.parse(state.installedAt ?? '') || 0;
  const work = [];
  const skipped = [];
  const preExisting = [];
  for (const issue of issues) {
    const key = String(issue.number);
    const entry = state.seen[key];
    if (entry) {
      if (entry.status === 'triage-failed' && (entry.attempts ?? 0) < MAX_TRIAGE_ATTEMPTS) {
        work.push({ issue, reason: `retry ${entry.attempts + 1}/${MAX_TRIAGE_ATTEMPTS}` });
      } else {
        skipped.push({ issue, reason: `seen: ${entry.status}${entry.status === 'triage-failed' ? ' (retry cap reached)' : ''}` });
      }
      continue;
    }
    if ((Date.parse(issue.createdAt ?? '') || 0) < installedAt) {
      preExisting.push(issue);
      skipped.push({ issue, reason: 'created before the watcher was installed' });
      continue;
    }
    work.push({ issue, reason: 'new' });
  }
  work.sort((a, b) => (Date.parse(a.issue.createdAt ?? '') || 0) - (Date.parse(b.issue.createdAt ?? '') || 0)
    || a.issue.number - b.issue.number);
  return { work, skipped, preExisting };
}

function acquireLock(cfg) {
  mkdirSync(cfg.dir, { recursive: true });
  try {
    mkdirSync(cfg.lockDir);
    writeFileSync(join(cfg.lockDir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`);
    return { ok: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let ageMs = 0;
  try { ageMs = Date.now() - statSync(cfg.lockDir).mtimeMs; } catch { ageMs = Infinity; }
  if (ageMs > STALE_LOCK_MS) {
    logLine(cfg, `lock is ${Math.round(ageMs / 60000)} min old (stale past ${STALE_LOCK_MS / 60000} min); taking it over`);
    try { writeFileSync(join(cfg.lockDir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`); } catch { /* ignore */ }
    try { utimesSync(cfg.lockDir, new Date(), new Date()); } catch { /* ignore */ }
    return { ok: true, tookOver: true };
  }
  return { ok: false, ageMs };
}

function releaseLock(cfg) {
  try { rmSync(cfg.lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function onePass(cfg, { dryRun = false } = {}) {
  if (existsSync(cfg.pausedFile)) {
    logLine(cfg, `paused: ${cfg.pausedFile} exists; nothing polled, nothing dispatched`);
    return 0;
  }

  if (!dryRun) {
    const lock = acquireLock(cfg);
    if (!lock.ok) {
      logLine(cfg, `another pass holds ${cfg.lockDir} (age ${Math.round(lock.ageMs / 1000)}s); exiting so passes do not overlap`);
      return 0;
    }
  }

  try {
    return pass(cfg, { dryRun });
  } finally {
    if (!dryRun) releaseLock(cfg);
  }
}

function pass(cfg, { dryRun }) {
  let state = readState(cfg);
  const nowIso = new Date().toISOString();
  let fresh = false;
  if (!state) {
    // Never seen this directory before. Everything currently open is treated as
    // pre-existing so a first run cannot fire fifty delegations at once.
    state = emptyState(cfg.repo || cfg.defaultRepo, nowIso);
    fresh = true;
    logLine(cfg, `no readable state.json; initialising with installedAt=${nowIso} (every open issue becomes pre-existing)`);
  }
  const repo = repoName(cfg, state);

  const listed = ghJson(cfg, [
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,createdAt,updatedAt,author,labels',
  ]);
  if (!listed.ok) {
    logLine(cfg, `gh issue list failed (${listed.why}); state left untouched, exiting 0 so launchd retries next interval`);
    return 0;
  }
  const issues = Array.isArray(listed.value) ? listed.value : [];
  logLine(cfg, `${repo}: ${issues.length} open issue(s)`);

  if (fresh) {
    for (const issue of issues) state.seen[String(issue.number)] = emptySeenEntry('pre-existing');
    if (!dryRun) writeState(cfg, state);
    logLine(cfg, `recorded ${issues.length} pre-existing issue(s); nothing triaged on the first pass`);
    return 0;
  }

  const { work, skipped, preExisting } = selectIssues(state, issues);
  for (const s of skipped) logLine(cfg, `#${s.issue.number}: skipped (${s.reason})`);

  if (dryRun) {
    process.stdout.write('DRY RUN — nothing was posted, nothing was dispatched, state.json untouched\n');
    for (const s of skipped) process.stdout.write(`would skip #${s.issue.number} (${s.reason})\n`);
    const day = state.counters?.[dayKey()] ?? { triages: 0, fixes: 0 };
    let budget = cfg.maxTriagesPerDay - day.triages;
    for (const w of work) {
      if (budget <= 0) {
        process.stdout.write(`would defer #${w.issue.number} (daily triage limit ${cfg.maxTriagesPerDay} reached)\n`);
        continue;
      }
      budget -= 1;
      process.stdout.write(`would triage #${w.issue.number} ${JSON.stringify(w.issue.title ?? '')} (${w.reason})\n`);
      process.stdout.write(`  would write ${join(cfg.tasksDir, `issue-${w.issue.number}-triage.md`)}\n`);
      process.stdout.write(`  would run ${[cfg.bullswarm, 'run', '--lane', 'analyze', '--effort', 'medium', '--no-caller', '--add-dir', cfg.repoDir, '--task-file', join(cfg.tasksDir, `issue-${w.issue.number}-triage.md`), '--json'].join(' ')}\n`);
      process.stdout.write(`  would then label and comment on ${repo}#${w.issue.number}, and open one fix PR only for a fixable bug at confidence >= 0.7\n`);
    }
    if (!work.length) process.stdout.write('would triage nothing: no new issue this pass\n');
    process.stdout.write(`today ${dayKey()} UTC: triages ${day.triages}/${cfg.maxTriagesPerDay}, fixes ${day.fixes}/${cfg.maxFixesPerDay}\n`);
    return 0;
  }

  // A pre-existing issue that was closed at install time and later reopened is
  // recorded, never triaged: the installedAt gate is what defines "new".
  if (preExisting.length) {
    for (const issue of preExisting) state.seen[String(issue.number)] = emptySeenEntry('pre-existing');
    writeState(cfg, state);
  }

  for (const { issue, reason } of work) {
    const day = counters(state, dayKey());
    if (day.triages >= cfg.maxTriagesPerDay) {
      logLine(cfg, `daily triage limit reached (${day.triages}/${cfg.maxTriagesPerDay}); deferring #${issue.number} and everything after it to a later day`);
      break;
    }
    const key = String(issue.number);
    const entry = state.seen[key] ?? emptySeenEntry('new');
    state.seen[key] = entry;
    logLine(cfg, `#${issue.number}: ${reason} — triaging`);

    const result = runTriage(cfg, state, repo, issue.number, entry);
    if (result.outcome === 'skip') {
      // Nothing was dispatched and nothing was decided: leave state as it was.
      if (entry.attempts === 0 && state.seen[key]?.status === 'new') delete state.seen[key];
      writeState(cfg, state);
      continue;
    }
    writeState(cfg, state);
    if (result.outcome !== 'triaged') continue;

    if (!qualifiesForFix(result.triage, entry)) {
      logLine(cfg, `#${issue.number}: no fix attempt (kind ${result.triage.kind}, fixable ${result.triage.fixable}, confidence ${result.triage.confidence}, fixAttempts ${entry.fixAttempts})`);
      continue;
    }
    const day2 = counters(state, dayKey());
    if (day2.fixes >= cfg.maxFixesPerDay) {
      logLine(cfg, `#${issue.number}: qualifies for a fix but the daily fix limit is reached (${day2.fixes}/${cfg.maxFixesPerDay}); left triaged`);
      continue;
    }
    runFix(cfg, state, repo, issue.number, entry, result);
    writeState(cfg, state);
  }

  state.lastPassAt = new Date().toISOString();
  writeState(cfg, state);
  return 0;
}

// --- status ------------------------------------------------------------------

function status(cfg) {
  const state = readState(cfg);
  const out = [];
  out.push('bullswarm issue-watcher');
  out.push(`dir           ${cfg.dir}`);
  out.push(`repo          ${repoName(cfg, state)}`);
  out.push(`gh            ${cfg.gh}`);
  out.push(`bullswarm     ${cfg.bullswarm}`);
  out.push(`test command  ${cfg.testCommand}`);
  out.push(`paused        ${existsSync(cfg.pausedFile) ? `yes (${cfg.pausedFile})` : 'no'}`);
  if (existsSync(cfg.lockDir)) {
    let age = '?';
    try { age = `${Math.round((Date.now() - statSync(cfg.lockDir).mtimeMs) / 1000)}s old`; } catch { /* ignore */ }
    out.push(`lock          held (${age}, stale past ${STALE_LOCK_MS / 60000} min)`);
  } else {
    out.push('lock          free');
  }
  out.push(`clone         ${existsSync(join(cfg.repoDir, '.git')) ? cfg.repoDir : `${cfg.repoDir} (missing; cloned on the next pass)`}`);
  out.push(`log           ${cfg.logFile}${existsSync(cfg.logFile) ? '' : ' (not written yet)'}`);
  out.push(`state         ${cfg.stateFile}`);
  if (!state) {
    out.push('');
    out.push('state.json is missing or unreadable: this directory has not been installed.');
    out.push('Run: node scripts/issue-watcher/install.mjs --dir <dir>');
    out.push('The next pass would initialise it and record every open issue as pre-existing.');
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }
  out.push(`installedAt   ${state.installedAt ?? '(unset)'}`);
  out.push(`lastPassAt    ${state.lastPassAt ?? '(never)'}`);
  const tally = {};
  for (const entry of Object.values(state.seen ?? {})) {
    tally[entry.status] = (tally[entry.status] ?? 0) + 1;
  }
  const total = Object.keys(state.seen ?? {}).length;
  out.push(`seen          ${total} issue(s)${total ? `: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
  const day = state.counters?.[dayKey()] ?? { triages: 0, fixes: 0 };
  out.push(`today ${dayKey()}  triages ${day.triages}/${cfg.maxTriagesPerDay}, fixes ${day.fixes}/${cfg.maxFixesPerDay} (UTC day)`);
  const open = Object.entries(state.seen ?? {}).filter(([, e]) => e.status === 'fix-open');
  for (const [n, e] of open) out.push(`  #${n} fix open: ${e.prUrl ?? '(url unknown)'}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

// --- cli ---------------------------------------------------------------------

const USAGE = `Usage: node watch.mjs [--once] [--dry-run] [--status]

  --once      run one pass and exit (the default; what launchd runs)
  --dry-run   poll and print every action it WOULD take; posts nothing,
              dispatches nothing, writes no state
  --status    print a state summary and exit
  --help      this text

Environment:
  BULLSWARM_ISSUE_WATCHER_DIR                 state/clone/log root (default ~/.bullswarm/issue-watcher)
  BULLSWARM_ISSUE_WATCHER_REPO                owner/name (default cowcow02/bullswarm, else state.json)
  BULLSWARM_ISSUE_WATCHER_GH                  gh binary (default gh)
  BULLSWARM_ISSUE_WATCHER_BULLSWARM           bullswarm binary (default bullswarm)
  BULLSWARM_ISSUE_WATCHER_TEST_COMMAND        fix verification command (default npm test)
  BULLSWARM_ISSUE_WATCHER_MAX_TRIAGES_PER_DAY default 6
  BULLSWARM_ISSUE_WATCHER_MAX_FIXES_PER_DAY   default 2
  BULLSWARM_ISSUE_WATCHER_NO_NOTIFY=1         skip the macOS notification
`;

export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(moduleUrl));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const flags = { once: false, dryRun: false, status: false };
  for (const arg of argv) {
    if (arg === '--once') flags.once = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--status') flags.status = true;
    else if (arg === '--help' || arg === '-h') { process.stdout.write(USAGE); return 0; }
    else { process.stderr.write(`unknown flag: ${arg}\n\n${USAGE}`); return 2; }
  }
  const cfg = loadConfig(env);
  if (flags.status) return status(cfg);
  try {
    return onePass(cfg, { dryRun: flags.dryRun });
  } catch (error) {
    logLine(cfg, `pass aborted: ${error?.stack ?? error}`);
    return 1;
  }
}

// Compare REAL paths: node resolves a module URL through symlinks, so under a
// symlinked root (/var -> /private/var on macOS) a plain string compare says
// "not the entry point" and the agent runs, prints nothing, and exits 0.
if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
