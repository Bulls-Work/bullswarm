#!/usr/bin/env node
// Install (or remove) the bullswarm issue-watcher as a launchd user agent.
//
// Idempotent by design: run it as often as you like. It copies the watcher and
// its templates into <dir>/bin so the agent runs from a stable path that does
// not depend on this checkout still existing, seeds state.json so today's
// backlog is never mistaken for new work, and re-bootstraps the launchd job.
//
//   node scripts/issue-watcher/install.mjs [--dir <dir>] [--repo owner/name]
//                                          [--interval 300] [--uninstall]
//                                          [--dry-run]
//
// Everything that touches the outside world goes through the injected `run`,
// and the LaunchAgents location comes from BULLSWARM_ISSUE_WATCHER_HOME, so a
// test can exercise the whole installer without touching the real ~/Library.

import {
  mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, renameSync, rmSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LABEL = 'com.bullswarm.issue-watcher';
export const DEFAULT_REPO = 'cowcow02/bullswarm';
export const DEFAULT_INTERVAL = 300;
const COPIED = ['watch.mjs', 'triage-task.md', 'fix-task.md'];

const USAGE = `Usage: node scripts/issue-watcher/install.mjs [options]

  --dir <path>       watcher root (default ~/.bullswarm/issue-watcher)
  --repo owner/name  repository to watch (default ${DEFAULT_REPO})
  --interval <sec>   launchd StartInterval (default ${DEFAULT_INTERVAL})
  --uninstall        bootout and remove the plist; state and logs are kept
  --dry-run          print the plist and every command; write nothing
  --help             this text
`;

export function parseArgs(argv) {
  const opts = { dir: null, repo: DEFAULT_REPO, interval: DEFAULT_INTERVAL, uninstall: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--dir') opts.dir = need('--dir');
    else if (arg === '--repo') opts.repo = need('--repo');
    else if (arg === '--interval') {
      const raw = need('--interval');
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 10) throw new Error(`--interval ${raw} is not a number of seconds >= 10`);
      opts.interval = Math.round(n);
    } else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return opts;
}

export function defaultRun(file, args, { cwd, env } = {}) {
  const r = spawnSync(file, args, { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ?? null,
  };
}

const xml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistXml({ label, argv, interval, env, stdout, stderr }) {
  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  const argEntries = argv.map((a) => `      <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argEntries}
    </array>
    <key>StartInterval</key>
    <integer>${interval}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(stderr)}</string>
  </dict>
</plist>
`;
}

/**
 * The PATH the agent gets. launchd hands a user agent a minimal PATH, so the
 * plist has to carry the installing shell's own PATH, plus wherever this node
 * came from — that is how `gh`, `git`, `bullswarm` and the worker CLIs stay
 * findable from a daemon (derived here, never hard-coded).
 */
export function agentPath(env, execPath) {
  const nodeDir = dirname(execPath);
  const parts = String(env.PATH ?? '').split(':').filter(Boolean);
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  return parts.join(':');
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function install({
  argv = [],
  env = process.env,
  run = defaultRun,
  out = (line) => process.stdout.write(`${line}\n`),
  execPath = process.execPath,
  sourceDir = HERE,
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    out(String(error.message));
    out('');
    out(USAGE.trimEnd());
    return 2;
  }
  if (opts.help) { out(USAGE.trimEnd()); return 0; }

  const home = env.BULLSWARM_ISSUE_WATCHER_HOME || env.HOME || homedir();
  const dir = resolve(opts.dir || env.BULLSWARM_ISSUE_WATCHER_DIR || join(home, '.bullswarm', 'issue-watcher'));
  const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const domain = `gui/${uid}`;
  const gh = env.BULLSWARM_ISSUE_WATCHER_GH || 'gh';

  const plist = plistXml({
    label: LABEL,
    argv: [execPath, join(dir, 'bin', 'watch.mjs'), '--once'],
    interval: opts.interval,
    env: {
      PATH: agentPath(env, execPath),
      HOME: home,
      BULLSWARM_ISSUE_WATCHER_DIR: dir,
    },
    stdout: join(dir, 'log', 'launchd.out.log'),
    stderr: join(dir, 'log', 'launchd.err.log'),
  });

  if (opts.uninstall) {
    out(`uninstalling ${LABEL} (state and logs under ${dir} are kept)`);
    if (opts.dryRun) {
      out(`would run: launchctl bootout ${domain} ${plistPath}`);
      out(`would remove: ${plistPath}`);
      return 0;
    }
    const booted = run('launchctl', ['bootout', domain, plistPath]);
    out(`ran: launchctl bootout ${domain} ${plistPath}${booted.ok ? '' : ` (ignored, exited ${booted.status})`}`);
    if (existsSync(plistPath)) { rmSync(plistPath, { force: true }); out(`removed ${plistPath}`); }
    else out(`${plistPath} was not present`);
    out(`state kept at ${join(dir, 'state.json')} — re-installing resumes where it left off`);
    return 0;
  }

  if (opts.dryRun) {
    out(`DRY RUN — nothing written, launchctl not called`);
    out(`dir       ${dir}`);
    out(`repo      ${opts.repo}`);
    out(`plist     ${plistPath}`);
    out(`interval  ${opts.interval}s`);
    out('');
    out(`would create ${dir}/{bin,tasks,log}`);
    for (const file of COPIED) out(`would copy ${join(sourceDir, file)} -> ${join(dir, 'bin', file)}`);
    out(`would clone ${opts.repo} into ${join(dir, 'repo')} if it is missing:`);
    out(`  ${gh} repo clone ${opts.repo} ${join(dir, 'repo')}`);
    out(`would seed ${join(dir, 'state.json')} with installedAt=<now> and every open issue as pre-existing:`);
    out(`  ${gh} issue list --repo ${opts.repo} --state open --json number`);
    out(`would write ${plistPath}:`);
    out('');
    out(plist.trimEnd());
    out('');
    out(`would run: launchctl bootout ${domain} ${plistPath}   # failure ignored`);
    out(`would run: launchctl bootstrap ${domain} ${plistPath}`);
    out(`check status with: launchctl print ${domain}/${LABEL}`);
    out(`log: ${join(dir, 'log', 'watch.log')}`);
    return 0;
  }

  for (const sub of ['bin', 'tasks', 'log']) mkdirSync(join(dir, sub), { recursive: true });
  out(`created ${dir}/{bin,tasks,log}`);
  for (const file of COPIED) {
    copyFileSync(join(sourceDir, file), join(dir, 'bin', file));
    out(`copied ${file} -> ${join(dir, 'bin', file)}`);
  }

  const repoDir = join(dir, 'repo');
  if (!existsSync(join(repoDir, '.git'))) {
    out(`ran: ${gh} repo clone ${opts.repo} ${repoDir}`);
    const cloned = run(gh, ['repo', 'clone', opts.repo, repoDir]);
    if (!cloned.ok) {
      out(`clone failed (${(cloned.stderr || cloned.stdout).trim().split('\n')[0] || `exit ${cloned.status}`})`);
      out('the watcher clones on its first pass, so this is not fatal — continuing');
    }
  } else {
    out(`clone already present at ${repoDir}`);
  }

  const stateFile = join(dir, 'state.json');
  const nowIso = new Date().toISOString();
  let state = null;
  if (existsSync(stateFile)) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = null; }
  }
  const listed = run(gh, ['issue', 'list', '--repo', opts.repo, '--state', 'open', '--json', 'number']);
  out(`ran: ${gh} issue list --repo ${opts.repo} --state open --json number`);
  let open = [];
  if (listed.ok) {
    try { open = JSON.parse(listed.stdout); } catch { open = []; }
    if (!Array.isArray(open)) open = [];
  } else {
    out(`could not list open issues (${(listed.stderr || listed.stdout).trim().split('\n')[0] || `exit ${listed.status}`}); seeding an empty seen map`);
  }

  if (state && typeof state === 'object' && state.seen) {
    // Idempotent re-install: the existing history is the point of the state
    // file, so installedAt and every seen entry survive. Anything open that is
    // not yet recorded joins as pre-existing so it is never mistaken for new.
    let added = 0;
    for (const issue of open) {
      const key = String(issue.number);
      if (!state.seen[key]) { state.seen[key] = preExistingEntry(); added += 1; }
    }
    state.repo = opts.repo;
    out(`state.json already exists: kept installedAt=${state.installedAt}, ${Object.keys(state.seen).length} seen entries (${added} newly recorded as pre-existing)`);
  } else {
    state = {
      version: 1,
      repo: opts.repo,
      installedAt: nowIso,
      lastPassAt: null,
      seen: Object.fromEntries(open.map((i) => [String(i.number), preExistingEntry()])),
      counters: {},
    };
    out(`wrote state.json: installedAt=${nowIso}, ${open.length} open issue(s) recorded as pre-existing`);
  }
  writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  writeAtomic(plistPath, plist);
  out(`wrote ${plistPath}`);

  const booted = run('launchctl', ['bootout', domain, plistPath]);
  out(`ran: launchctl bootout ${domain} ${plistPath}${booted.ok ? '' : ` (ignored, exited ${booted.status})`}`);
  const bootstrapped = run('launchctl', ['bootstrap', domain, plistPath]);
  out(`ran: launchctl bootstrap ${domain} ${plistPath}`);
  if (!bootstrapped.ok) {
    out(`bootstrap failed (exit ${bootstrapped.status}): ${(bootstrapped.stderr || bootstrapped.stdout).trim().split('\n')[0]}`);
    out('the plist is written; fix the error above and re-run the installer');
  }

  out('');
  out(`status:    launchctl print ${domain}/${LABEL}`);
  out(`log:       ${join(dir, 'log', 'watch.log')}`);
  out(`state:     ${stateFile}`);
  out(`by hand:   ${execPath} ${join(dir, 'bin', 'watch.mjs')} --status`);
  out(`dry run:   ${execPath} ${join(dir, 'bin', 'watch.mjs')} --dry-run`);
  out(`pause:     touch ${join(dir, 'paused')}   (resume: rm it)`);
  out(`uninstall: ${execPath} ${join(HERE, 'install.mjs')} --uninstall --dir ${dir}`);
  return bootstrapped.ok ? 0 : 1;
}

function preExistingEntry() {
  return { status: 'pre-existing', kind: null, triagedAt: null, attempts: 0, fixAttempts: 0, pool: null, model: null, prUrl: null };
}

// Real paths, not strings: node resolves a module URL through symlinks.
function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(moduleUrl));
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = install({ argv: process.argv.slice(2) });
}
