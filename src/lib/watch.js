// bullswarm watch — spawn a delegate directly, capture everything, judge.
//
// Doctrine:
//   W1. Spawn the binary DIRECTLY (no shell) so no pipeline can swallow a
//       real non-zero exit.
//   W2. PWD quirk: connectors declaring cwdMode "pwd" get env.PWD set to
//       the target dir AND are spawned with cwd = target dir. Otherwise
//       they silently analyse the WRONG repository and exit 0.
//   W3. Timeout kills the process tree; partial output is still judged.
//   W4. A non-zero exit is never a success — but when content verification
//       passes anyway, report contentUsableDespiteExit instead of
//       discarding completed work.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeContent } from './verify.js';

const BULLSWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function substituteArgv(cmdTemplate, { taskFile, cwd }) {
  return cmdTemplate.map((a) =>
    a
      .replaceAll('{taskFile}', taskFile)
      .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
      .replaceAll('{cwd}', cwd),
  );
}

/**
 * Run one delegate and return the raw observation.
 * @returns Promise<{exitCode, signal, stdout, stderr, timedOut}>
 */
export function runDelegate(connector, taskFile, targetDir, opts = {}) {
  const timeoutMs = (opts.timeoutSec ?? connector.timeoutSec ?? 900) * 1000;
  const argv = substituteArgv(connector.spawn.cmd, {
    taskFile,
    cwd: resolve(targetDir),
  });
  const usePwdMode = connector.spawn.cwdMode === 'pwd';
  // realpath: getcwd() resolves symlinks (macOS /var -> /private/var), so an
  // unresolved PWD would disagree with cwd and defeat wrong-repo detection.
  const resolvedDir = realpathSync(resolve(targetDir));

  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: resolvedDir,
      // ALWAYS sync PWD to the spawned cwd (not only for declared pwd-mode
      // connectors): an inherited stale PWD is the wrong-repo hazard.
      env: { ...process.env, PWD: resolvedDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        spawnError: true,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

function extractOutput(connector, obs) {
  switch (connector.outputExtraction?.strategy ?? 'stdout') {
    case 'stdout':
      return obs.stdout || obs.stderr || '';
    case 'stdout-tail':
      return (obs.stdout || '').split('\n').slice(-80).join('\n') || obs.stderr;
    default:
      return obs.stdout || obs.stderr || '';
  }
}

function matchAuthSignature(connector, text) {
  const sigs = connector.authSignatures ?? [];
  return sigs.find((s) => text.toLowerCase().includes(s.toLowerCase())) ?? null;
}

/**
 * Watch one delegation end-to-end. Returns the standard verdict.
 */
export async function watchOnce(connector, taskText, targetDir, paths, opts = {}) {
  writeFileSync(paths.taskFile, taskText);
  const startedAt = Date.now();
  const obs = await runDelegate(connector, paths.taskFile, targetDir, opts);
  const wallSec = Math.round((Date.now() - startedAt) / 100) / 10;

  const output = extractOutput(connector, obs);
  writeFileSync(paths.outFile, output);

  // Gate order matters:
  //   timeout / spawn failure -> fail (nothing to trust)
  //   auth signature anywhere in the first 2000 chars -> fail + quarantine
  //     hint (checked BEFORE generic failure patterns so the specific cause
  //     wins; codex-style CLIs log auth errors after banner noise, so a
  //     fixed 400-char head misses them).
  //   else content judge decides; exit code only modulates flags.
  const authHit = matchAuthSignature(connector, output.slice(0, 2000));

  let verdict;
  if (obs.timedOut) {
    verdict = { ok: false, why: `timeout after ${opts.timeoutSec ?? connector.timeoutSec}s` };
  } else if (obs.spawnError) {
    verdict = { ok: false, why: `spawn failed: ${obs.stderr.trim().split('\n')[0]}` };
  } else if (authHit) {
    verdict = { ok: false, why: `auth/throttle signature: "${authHit}"`, quarantineHint: true };
  } else {
    const j = judgeContent(output, { exitCode: obs.exitCode });
    if (j.verdict === 'pass') {
      verdict = {
        ok: obs.exitCode === 0,
        why: obs.exitCode === 0
          ? 'verified'
          : 'verified content but non-zero exit',
      };
    } else {
      verdict = { ok: false, why: j.why };
    }
  }

  const usableDespite =
    !verdict.ok &&
    !obs.spawnError &&
    !obs.timedOut &&
    !authHit &&
    obs.exitCode !== 0 &&
    judgeContent(output, { expectWork: true }).verdict === 'pass';

  return {
    ...verdict,
    ok: verdict.ok,
    keepOnClaude: false,
    pick: { pool: connector.name, command: connector.spawn.cmd },
    contentUsableDespiteExit: usableDespite,
    meta: {
      pool: connector.name,
      exitCode: obs.exitCode,
      signal: obs.signal,
      timedOut: obs.timedOut,
      wallSec,
      outBytes: output.length,
    },
    outFile: paths.outFile,
    taskFile: paths.taskFile,
  };
}
