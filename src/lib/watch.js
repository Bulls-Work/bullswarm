// bullswarm watch — spawn a delegate directly, capture everything, judge.
//
// Doctrine:
//   W1. Spawn the binary DIRECTLY (no shell) so no pipeline can swallow a
//       real non-zero exit.
//   W2. PWD quirk: connectors declaring cwdMode "pwd" get env.PWD set to
//       the target dir AND are spawned with cwd = target dir. Otherwise
//       they silently analyse the WRONG repository and exit 0.
//   W3. Delegates have no implicit wall-clock timeout. A caller may opt into
//       an explicit timeout; cancellation always terminates the process tree.
//   W4. A non-zero exit is never a success — but when content verification
//       passes anyway, report contentUsableDespiteExit instead of
//       discarding completed work.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeContent } from './verify.js';
import { estimateInvocationUsage } from './usage.js';
import { createAgentEventDecoder } from './agent-events.js';

const BULLSWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function substituteArgv(cmdTemplate, { taskFile, cwd }) {
  return cmdTemplate.map((a) =>
    a
      .replaceAll('{taskFile}', taskFile)
      .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
      .replaceAll('{cwd}', cwd),
  );
}

export function argvWithModel(connector, paths, model = null, conversation = null) {
  const argv = substituteArgv(connector.spawn.cmd, paths);
  if (model && connector.modelSelection?.flag) {
    const flag = connector.modelSelection.flag;
    const index = argv.indexOf(flag);
    if (index >= 0) {
      if (index + 1 < argv.length) argv[index + 1] = model;
      else argv.push(model);
    } else {
      argv.push(flag, model);
    }
  }
  if (conversation?.sessionId && connector.conversation) {
    const template = conversation.resume
      ? connector.conversation.resumeArgs
      : connector.conversation.newArgs;
    argv.push(...(template ?? []).map((arg) => String(arg).replaceAll('{sessionId}', conversation.sessionId)));
  }
  argv.push(...(connector.eventStream?.args ?? []));
  return argv;
}

/**
 * Run one delegate and return the raw observation.
 * @returns Promise<{exitCode, signal, stdout, stderr, timedOut, cancelled}>
 */
export function runDelegate(connector, taskFile, targetDir, opts = {}) {
  const configuredTimeout = opts.timeoutSec == null ? null : Number(opts.timeoutSec);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout * 1000
    : null;
  const argv = argvWithModel(connector, {
    taskFile,
    cwd: resolve(targetDir),
  }, opts.model, opts.conversation);
  const usePwdMode = connector.spawn.cwdMode === 'pwd';
  // realpath: getcwd() resolves symlinks (macOS /var -> /private/var), so an
  // unresolved PWD would disagree with cwd and defeat wrong-repo detection.
  const resolvedDir = realpathSync(resolve(targetDir));

  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: resolvedDir,
      // PWD: ALWAYS sync to the spawned cwd (stale-PWD is the wrong-repo
      // hazard). Caller-supplied opts.env takes precedence over
      // process.env so the runtime can inject BULLSWARM_DEPTH (recursion
      // guard) and other core-owned env contracts.
      env: {
        ...process.env,
        ...(connector.env ?? {}),
        ...(opts.env ?? {}),
        PWD: resolvedDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onSpawn?.(child.pid);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let fatalSignature = null;
    let fatalKillTimer = null;
    let fatalForceKillTimer = null;
    let forceKillTimer = null;
    let detectedModel = null;
    const eventDecoder = createAgentEventDecoder(connector.eventStream, {
      onEvent: opts.onAgentEvent,
      onProgress: (event) => {
        if (event.model) detectedModel = event.model;
        opts.onAgentProgress?.(event);
      },
    });
    const stopOnFatalSignature = () => {
      if (fatalSignature) return;
      // Structured stdout is an agent transcript. It routinely contains file
      // contents, grep matches, and shell output, so matching fatal words in
      // that transport can kill a healthy agent merely for reading auth code.
      // Provider diagnostics on stderr remain safe to terminate on. Plain-text
      // connectors retain the legacy combined-stream fast-fail behavior.
      const transport = connector.outputExtraction?.strategy === 'event-stream'
        ? stderr
        : `${stdout}\n${stderr}`;
      fatalSignature = matchAuthSignature(connector, transport.slice(-4000));
      if (!fatalSignature) return;
      // Give a well-behaved CLI a brief chance to exit with its own truthful
      // status, but do not wait indefinitely after a definitive auth/quota
      // signature has already made the attempt unusable.
      fatalKillTimer = setTimeout(() => {
        child.kill('SIGTERM');
        fatalForceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      }, 100);
    };
    const timer = timeoutMs == null ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);
    const cancelPoll = typeof opts.shouldCancel === 'function' ? setInterval(() => {
      if (cancelled || !opts.shouldCancel()) return;
      cancelled = true;
      child.kill('SIGTERM');
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    }, 250) : null;

    child.stdout.on('data', (d) => {
      stdout += d;
      const at = new Date().toISOString();
      opts.onActivity?.({ stream: 'stdout', bytes: d.length, at });
      eventDecoder?.push(d, 'stdout', at);
      stopOnFatalSignature();
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      const at = new Date().toISOString();
      opts.onActivity?.({ stream: 'stderr', bytes: d.length, at });
      eventDecoder?.push(d, 'stderr', at);
      stopOnFatalSignature();
    });
    child.on('error', (err) => {
      eventDecoder?.finish();
      if (timer) clearTimeout(timer);
      if (fatalKillTimer) clearTimeout(fatalKillTimer);
      if (fatalForceKillTimer) clearTimeout(fatalForceKillTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelPoll) clearInterval(cancelPoll);
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        cancelled,
        fatalSignature,
        eventOutput: eventDecoder?.output() ?? '',
        detectedModel,
        spawnError: true,
      });
    });
    child.on('close', (code, signal) => {
      eventDecoder?.finish();
      if (timer) clearTimeout(timer);
      if (fatalKillTimer) clearTimeout(fatalKillTimer);
      if (fatalForceKillTimer) clearTimeout(fatalForceKillTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelPoll) clearInterval(cancelPoll);
      resolvePromise({
        exitCode: code, signal, stdout, stderr, timedOut, cancelled, fatalSignature,
        eventOutput: eventDecoder?.output() ?? '',
        detectedModel,
      });
    });
  });
}

function extractOutput(connector, obs) {
  switch (connector.outputExtraction?.strategy ?? 'stdout') {
    case 'event-stream':
      return obs.eventOutput || obs.stdout || obs.stderr || '';
    case 'stdout':
      return obs.stdout || obs.stderr || '';
    case 'stdout-tail':
      return (obs.stdout || '').split('\n').slice(-80).join('\n') || obs.stderr;
    case 'file': {
      // Connectors that write their full transcript to a file (e.g.
      // a long-running agent that streams to a log) declare a glob/path
      // in outputExtraction.field. We read it directly, sidestepping
      // the spawn-pipe buffer limit (~64 KB on macOS). The field is
      // treated as a literal path; if missing, fall back to stdout.
      const field = connector.outputExtraction?.field;
      if (!field) return obs.stdout || obs.stderr || '';
      try {
        return readFileSync(field, 'utf8');
      } catch {
        return obs.stdout || obs.stderr || '';
      }
    }
    default:
      return obs.stdout || obs.stderr || '';
  }
}

function matchAuthSignature(connector, text) {
  const sigs = connector.authSignatures ?? [];
  return sigs.find((s) => text.toLowerCase().includes(s.toLowerCase())) ?? null;
}

function matchLikelyAuthFailure(connector, text) {
  const hit = matchAuthSignature(connector, text);
  if (!hit) return null;
  const lower = String(text).toLowerCase();
  const index = lower.indexOf(hit.toLowerCase());
  const lineStart = lower.lastIndexOf('\n', index) + 1;
  const lineEnd = lower.indexOf('\n', index);
  const line = lower.slice(lineStart, lineEnd < 0 ? lower.length : lineEnd).trim();
  // A semantic result may legitimately discuss auth handling. Require the
  // matched line to look like a provider failure instead of source/report text.
  const errorShaped = /^(?:error|fatal)(?:\b|:)|^(?:authentication failed|failed to authenticate|not authenticated|invalid api key|rate limit(?:ed| exceeded)?|cmd login)(?:[.!:]|$)|\b(?:http\s*(?:401|403|429)|status\s*(?:401|403|429)|login required|please login|access denied|quota exceeded)\b/i.test(line);
  return errorShaped ? hit : null;
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
  const selectedModel = opts.model ?? obs.detectedModel ?? connector.model ?? (() => {
    const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
    return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
  })();
  const usage = estimateInvocationUsage({
    taskText,
    outputText: output,
    connector,
    model: selectedModel,
    subscription: connector.subscription ?? null,
  });

  // Gate order matters:
  //   timeout / spawn failure -> fail (nothing to trust)
  //   an error-shaped auth signature in the extracted semantic response ->
  //     fail + quarantine hint (raw structured tool output is not evidence of
  //     provider auth health).
  //   else content judge decides; exit code only modulates flags.
  const authHit = obs.fatalSignature ?? matchLikelyAuthFailure(connector, output.slice(0, 2000));

  let verdict;
  let structured = null;
  if (obs.cancelled) {
    verdict = { ok: false, why: 'workflow cancellation requested', cancelled: true };
  } else if (obs.timedOut) {
    verdict = { ok: false, why: `timeout after ${opts.timeoutSec}s` };
  } else if (obs.spawnError) {
    verdict = { ok: false, why: `spawn failed: ${obs.stderr.trim().split('\n')[0]}` };
  } else if (authHit) {
    verdict = { ok: false, why: `auth/throttle signature: "${authHit}"`, quarantineHint: true };
  } else if (typeof opts.outputValidator === 'function') {
    try {
      const checked = opts.outputValidator(output);
      if (!checked || typeof checked.ok !== 'boolean') throw new TypeError('outputValidator must return {ok, errors?, value?}');
      structured = {
        ok: checked.ok,
        errors: Array.isArray(checked.errors) ? checked.errors.map(String) : [],
        ...(checked.value !== undefined ? { value: checked.value } : {}),
      };
      verdict = checked.ok && obs.exitCode === 0
        ? { ok: true, why: 'structured output validated' }
        : {
            ok: false,
            why: checked.ok
              ? 'structured output validated but process exited non-zero'
              : `structured output invalid: ${structured.errors.join('; ') || 'validator rejected it'}`,
            failureKind: checked.ok ? 'process' : 'schema',
          };
    } catch (error) {
      structured = { ok: false, errors: [error.message] };
      verdict = { ok: false, why: `structured output invalid: ${error.message}`, failureKind: 'schema' };
    }
  } else {
    const j = judgeContent(output, {
      exitCode: obs.exitCode,
      acceptVerifyJson: opts.acceptVerifyJson === true,
    });
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
    typeof opts.outputValidator !== 'function' &&
    !obs.spawnError &&
    !obs.timedOut &&
    !authHit &&
    obs.exitCode !== 0 &&
    judgeContent(output, {
      expectWork: true,
      acceptVerifyJson: opts.acceptVerifyJson === true,
    }).verdict === 'pass';

  return {
    ...verdict,
    ok: verdict.ok,
    keepOnClaude: false,
    pick: { pool: connector.name, model: selectedModel, command: connector.spawn.cmd },
    contentUsableDespiteExit: usableDespite,
    ...(structured ? { structured } : {}),
    meta: {
      pool: connector.name,
      exitCode: obs.exitCode,
      signal: obs.signal,
      timedOut: obs.timedOut,
      cancelled: obs.cancelled,
      wallSec,
      outBytes: output.length,
      usage,
    },
    outFile: paths.outFile,
    taskFile: paths.taskFile,
  };
}
