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
//   W5. A usage limit is reported as its own failure kind `quota` with the
//       reset deadline it announced. It is never `process` merely because the
//       CLI exited non-zero, and never `auth` merely because it throttled.
//   W6. A provider error event that names an upstream auth failure is `auth`
//       with a quarantine hint, not the generic `provider` kind. A dead
//       credential fails every following attempt on that pool in seconds; a
//       verdict that carries no hint sends the next attempt straight back.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeContent } from './verify.js';
import * as usageLib from './usage.js';
import { createAgentEventDecoder } from './agent-events.js';
import { captureLimits, createAttemptStreamSink } from './attempt-stream.js';
import { ERROR_SHAPED_LINE, findQuotaFailure, quotaQuarantineUntil } from './quota.js';
import { findUpstreamAuthFailure } from './auth-signatures.js';
import { appliedReasoningLevel, reasoningArgs, reasoningRecord } from './reasoning.js';
import { getMeterReading, refreshMeterAfterQuota } from '../meters/registry.js';
import { loadProviders, transcriptReaderFor } from './providers.js';

const BULLSWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The usage/subscription workers land their modules independently of this
// wiring action. Resolve them lazily so the watcher remains usable in a
// partially integrated checkout (and so focused tests can inject the exact
// seams they exercise). Once present, these are the contract modules, not
// alternate implementations.
let accountingModulesPromise = null;
async function accountingModules() {
  accountingModulesPromise ??= Promise.all([
    import('./quota-snapshot.js').catch(() => null),
    import('./subscription-cost.js').catch(() => null),
  ]).then(([quota, subscription]) => ({ quota, subscription }));
  return accountingModulesPromise;
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageApiUsd(usage) {
  return finiteNonNegative(usage?.api?.usd ?? usage?.cost?.estimatedUsd);
}

function usageSessionId(usage, reportedUsage, conversation) {
  return usage?.sessionId
    ?? reportedUsage?.sessionId
    ?? conversation?.sessionId
    ?? null;
}

function decoderUsageForEstimate(connector, reportedUsage) {
  if (!reportedUsage || typeof reportedUsage !== 'object') return reportedUsage;
  const rules = Array.isArray(connector?.eventStream?.usage)
    ? connector.eventStream.usage
    : connector?.eventStream?.usage ? [connector.eventStream.usage] : [];
  const inclusiveOutput = rules.some((rule) => (
    Array.isArray(rule?.inclusive?.output) && rule.inclusive.output.includes('reasoning')
  ));
  // agent-events applies declarative inclusive subtraction as it decodes the
  // stream. usage.js also accepts raw provider counters and subtracts there,
  // so restore the inclusive output only for this hand-off to avoid doing the
  // same subtraction twice at the canonical record boundary.
  if (inclusiveOutput
    && Number.isFinite(Number(reportedUsage.output))
    && Number.isFinite(Number(reportedUsage.reasoning))) {
    return {
      ...reportedUsage,
      output: Number(reportedUsage.output) + Number(reportedUsage.reasoning),
    };
  }
  return reportedUsage;
}

async function safeSnapshot(snapshotPool, poolName, home, now) {
  if (typeof snapshotPool !== 'function' || !poolName || !home) return null;
  try {
    return await snapshotPool(poolName, { home, now });
  } catch {
    return null;
  }
}

function snapshotDelta(quota, start, end) {
  if (typeof quota?.deltaBetween !== 'function') return null;
  try { return quota.deltaBetween(start, end); } catch { return null; }
}

function snapshotsFor(start, end) {
  return { start: start ?? null, end: end ?? null };
}

function fallbackSubscription({ poolName, subscription, start, end, quota }) {
  if (!poolName && !start && !end) return null;
  const delta = snapshotDelta(quota, start, end);
  const monthlyPriceUsd = finiteNonNegative(subscription?.monthlyPriceUsd);
  const window = subscription?.quotaWindow
    ?? (delta?.window === '5h' ? '5h' : delta?.window ?? null);
  const block = {
    pool: poolName ?? null,
    window,
    deltaPct: delta?.deltaPct ?? null,
    usd: null,
    monthlyPriceUsd,
    windowDays: null,
    basis: monthlyPriceUsd == null
      ? 'unknown:no-price'
      : delta?.deltaPct == null ? 'unknown:no-meter' : 'unknown:no-cost',
    snapshots: snapshotsFor(start, end),
  };
  return block;
}

async function resolveTranscriptReader(opts, poolName, home) {
  if (typeof opts.readTranscriptUsage === 'function') return opts.readTranscriptUsage;
  if (!poolName || !home) return null;
  try {
    const providers = opts.providers ?? loadProviders(home, { packaged: true }).providers;
    return transcriptReaderFor(providers, poolName);
  } catch {
    return null;
  }
}

// A worker's stdout is an agent transcript and can run to hundreds of
// megabytes (tool output echoed back by the CLI). Appending every chunk to one
// string eventually throws RangeError: Invalid string length inside the data
// handler, which kills the kernel and, with it, every worker it supervises
// (observed twice on 2026-09-09 with a command-code worker). Nothing reads the
// whole transcript: fatal signatures look at the last 4,000 characters, the
// event decoder consumes chunks as they arrive, and plain-text extraction
// wants the answer, which is never megabytes long. So keep the head and the
// tail of each stream up to a hard cap and count what was dropped.
export const MAX_CAPTURED_STREAM_BYTES = 32 * 1024 * 1024;

export class BoundedCapture {
  constructor(limit = MAX_CAPTURED_STREAM_BYTES) {
    this.limit = Math.max(2, Math.floor(limit));
    this.headLimit = Math.ceil(this.limit / 2);
    this.tailLimit = this.limit - this.headLimit;
    this.headText = '';
    this.tailText = '';
    this.dropped = 0;
    this.total = 0;
  }

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    this.total += text.length;
    let rest = text;
    if (this.headText.length < this.headLimit) {
      const room = this.headLimit - this.headText.length;
      if (rest.length <= room) { this.headText += rest; return; }
      this.headText += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest.length >= this.tailLimit) {
      this.dropped += this.tailText.length + (rest.length - this.tailLimit);
      this.tailText = rest.slice(-this.tailLimit);
      return;
    }
    const combined = this.tailText + rest;
    if (combined.length > this.tailLimit) {
      this.dropped += combined.length - this.tailLimit;
      this.tailText = combined.slice(-this.tailLimit);
    } else {
      this.tailText = combined;
    }
  }

  /** The last n characters actually kept (contiguous). */
  tail(n) {
    return this.dropped ? this.tailText.slice(-n) : (this.headText + this.tailText).slice(-n);
  }

  text() {
    if (!this.dropped) return this.headText + this.tailText;
    return `${this.headText}\n…[bullswarm: ${this.dropped} characters of this stream were not kept; ${this.total} total]…\n${this.tailText}`;
  }
}

export function substituteArgv(cmdTemplate, { taskFile, cwd }) {
  return cmdTemplate.map((a) =>
    a
      .replaceAll('{taskFile}', taskFile)
      .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
      .replaceAll('{cwd}', cwd),
  );
}

function resolveAttemptStream(connector, opts = {}) {
  if (opts.attemptStream) return opts.attemptStream;
  const streamFile = opts.streamFile ?? null;
  const stdoutFile = opts.stdoutFile ?? null;
  if (!streamFile && !stdoutFile) return null;
  const { capBytes, responseBytes } = captureLimits(connector.eventStream);
  const jsonl = connector.eventStream?.format === 'jsonl';
  return createAttemptStreamSink({
    streamFile: jsonl ? streamFile : null,
    stdoutFile: jsonl ? null : (stdoutFile ?? streamFile),
    capBytes,
    responseBytes,
  });
}

/**
 * Build the argv this connector is spawned with.
 *
 * `reasoning` is the resolved record from resolveReasoningLevel (or a bare
 * level string). Its level is appended exactly like the model flag — after
 * the model and the conversation arguments, before the event-stream args —
 * and nothing is appended when the resolver applied no level.
 */
export function argvWithModel(connector, paths, model = null, conversation = null, reasoning = null) {
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
  const reasoningLevel = appliedReasoningLevel(reasoning);
  if (reasoningLevel) {
    const flag = connector.reasoning?.flag;
    const index = typeof flag === 'string' && flag ? argv.indexOf(flag) : -1;
    if (index >= 0) {
      // Replace-or-append, like the model flag: a connector template that
      // already pins a level must end up with ONE level, not two.
      if (index + 1 < argv.length) argv[index + 1] = reasoningLevel;
      else argv.push(reasoningLevel);
    } else {
      argv.push(...reasoningArgs(connector, reasoningLevel));
    }
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
  }, opts.model, opts.conversation, opts.reasoning ?? null);
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
      detached: opts.processGroup === true,
    });
    const stopChild = (signal) => {
      try {
        if (opts.processGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* delegate process group already exited */ }
    };
    try { opts.onSpawn?.(child.pid); }
    catch (error) {
      stopChild('SIGKILL');
      child.on('error', () => {});
      throw error;
    }

    const captureLimit = Number.isFinite(opts.maxCaptureBytes) && opts.maxCaptureBytes > 0
      ? opts.maxCaptureBytes
      : MAX_CAPTURED_STREAM_BYTES;
    const stdoutCapture = new BoundedCapture(captureLimit);
    const stderrCapture = new BoundedCapture(captureLimit);
    let captureError = null;
    let timedOut = false;
    let cancelled = false;
    let fatalSignature = null;
    let fatalKillTimer = null;
    let fatalForceKillTimer = null;
    let forceKillTimer = null;
    let detectedModel = null;
    let providerFailureType = null;
    let providerFailureAt = null;
    let providerFailureText = null;
    // Assistant prose only. Tool results are quoted file/command output and
    // routinely contain limit wording that says nothing about OUR quota.
    let responseText = '';
    const attemptStream = resolveAttemptStream(connector, opts);
    const eventDecoder = createAgentEventDecoder(connector.eventStream, {
      onEvent: (event, fullSummary) => {
        if (event?.kind === 'response' && typeof event.summary === 'string'
          // A truncation marker means a long answer, not a bare limit notice;
          // judging the collapsed head of a real report would kill a healthy
          // agent for discussing rate limits in its first sentence.
          && !event.summary.endsWith('\u2026')) {
          responseText = `${responseText}${event.summary}\n`.slice(-8000);
        }
        if ((connector.eventStream?.failureTypes ?? []).includes(event?.providerType)) {
          providerFailureText ??= typeof event?.summary === 'string' ? event.summary : null;
        }
        attemptStream?.event(event, fullSummary);
        opts.onAgentEvent?.(event, fullSummary);
      },
      onProgress: (event) => {
        if (event.model) detectedModel = event.model;
        if ((connector.eventStream?.failureTypes ?? []).includes(event.providerType)) {
          providerFailureType = event.providerType;
          providerFailureAt ??= event.at ?? null;
        }
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
      const eventStreamed = connector.outputExtraction?.strategy === 'event-stream';
      const transport = eventStreamed
        ? stderrCapture.tail(4000)
        : `${stdoutCapture.tail(4000)}\n${stderrCapture.tail(4000)}`;
      // Quota is classified BEFORE auth and is read from the semantic channels
      // too: a provider that exhausted its window answers with the limit
      // notice as its own response/result and may never exit on its own. Some
      // connectors list a usage phrase (codex `usage_credits_required`) among
      // their auth signatures — a throttle must still be reported as quota.
      const quotaTransport = eventStreamed
        ? [stderrCapture.tail(4000), responseText, (eventDecoder?.output() ?? '').slice(-4000)].join('\n')
        : transport.slice(-4000);
      const quota = findQuotaFailure(connector, quotaTransport);
      if (quota) {
        fatalSignature = { kind: 'quota', ...quota };
      } else {
        const authHit = matchAuthSignature(connector, transport.slice(-4000));
        if (authHit) fatalSignature = { kind: 'auth', signature: authHit, line: null, context: null };
      }
      if (!fatalSignature) return;
      // Give a well-behaved CLI a brief chance to exit with its own truthful
      // status, but do not wait indefinitely after a definitive auth/quota
      // signature has already made the attempt unusable.
      fatalKillTimer = setTimeout(() => {
        stopChild('SIGTERM');
        fatalForceKillTimer = setTimeout(() => stopChild('SIGKILL'), 2000);
      }, 100);
    };
    const timer = timeoutMs == null ? null : setTimeout(() => {
      timedOut = true;
      stopChild('SIGTERM');
      forceKillTimer = setTimeout(() => stopChild('SIGKILL'), 2000);
    }, timeoutMs);
    // Silence, not run time: the clock restarts on every byte the worker
    // writes, so only a worker that has gone completely quiet is stopped.
    const silenceMs = Number(opts.silenceTimeoutSec) > 0 ? Number(opts.silenceTimeoutSec) * 1000 : null;
    let stalled = false;
    let silenceTimer = null;
    const armSilence = () => {
      if (silenceMs == null || stalled) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        stalled = true;
        stopChild('SIGTERM');
        forceKillTimer ??= setTimeout(() => stopChild('SIGKILL'), 2000);
      }, silenceMs);
      silenceTimer.unref?.();
    };
    armSilence();
    const cancelPoll = typeof opts.shouldCancel === 'function' ? setInterval(() => {
      if (cancelled || !opts.shouldCancel()) return;
      cancelled = true;
      stopChild('SIGTERM');
      forceKillTimer ??= setTimeout(() => stopChild('SIGKILL'), 2000);
    }, 250) : null;

    // A throw inside a stream handler is an uncaught exception that ends the
    // kernel. Whatever goes wrong while reading a worker, the attempt fails and
    // the kernel lives.
    const onStream = (capture, stream) => (d) => {
      try {
        capture.push(d);
        armSilence();
        const at = new Date().toISOString();
        opts.onActivity?.({ stream, bytes: d.length, at });
        eventDecoder?.push(d, stream, at);
        if (!eventDecoder) {
          const text = typeof d === 'string' ? d : d.toString();
          attemptStream?.stdout(text, stream);
          opts.onStdoutChunk?.(text, stream);
        }
        stopOnFatalSignature();
      } catch (error) {
        captureError ??= error?.message ?? String(error);
        stopChild('SIGTERM');
      }
    };
    child.stdout.on('data', onStream(stdoutCapture, 'stdout'));
    child.stderr.on('data', onStream(stderrCapture, 'stderr'));
    const capturedStreams = () => ({
      stdout: stdoutCapture.text(),
      stderr: captureError
        ? `${stderrCapture.text()}\n[bullswarm] worker stream capture failed: ${captureError}`
        : stderrCapture.text(),
      // Keep the diagnostic tail available to callers that need to classify a
      // transport failure. The full bounded capture is intentionally retained
      // for existing consumers, while this small field crosses verdict
      // boundaries without requiring callers to know the capture internals.
      stderrTail: stderrCapture.tail(4000),
      captureTruncated: { stdout: stdoutCapture.dropped, stderr: stderrCapture.dropped },
    });
    const finishStream = () => {
      eventDecoder?.finish();
      return {
        streamStats: attemptStream?.close() ?? null,
        reportedUsage: eventDecoder?.usage() ?? null,
      };
    };
    child.on('error', (err) => {
      const finishedStream = finishStream();
      const streamStats = finishedStream.streamStats;
      if (timer) clearTimeout(timer);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (fatalKillTimer) clearTimeout(fatalKillTimer);
      if (fatalForceKillTimer) clearTimeout(fatalForceKillTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelPoll) clearInterval(cancelPoll);
      resolvePromise({
        exitCode: null,
        signal: null,
        ...capturedStreams(),
        stderr: `${capturedStreams().stderr}\n${err.message}`,
        timedOut,
        stalled,
        cancelled,
        fatalSignature,
        eventOutput: eventDecoder?.output() ?? '',
        reportedUsage: finishedStream.reportedUsage,
        detectedModel,
        providerFailureType,
        providerFailureAt,
        providerFailureText,
        spawnError: true,
        ...(streamStats?.streamFile ? { streamFile: streamStats.streamFile, streamStats } : {}),
      });
    });
    child.on('close', (code, signal) => {
      if (opts.processGroup && (cancelled || timedOut || stalled || fatalSignature || opts.shouldCancel?.())) stopChild('SIGKILL');
      const finishedStream = finishStream();
      const streamStats = finishedStream.streamStats;
      if (timer) clearTimeout(timer);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (fatalKillTimer) clearTimeout(fatalKillTimer);
      if (fatalForceKillTimer) clearTimeout(fatalForceKillTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelPoll) clearInterval(cancelPoll);
      resolvePromise({
        exitCode: code, signal, ...capturedStreams(), timedOut, stalled, cancelled, fatalSignature,
        eventOutput: eventDecoder?.output() ?? '',
        reportedUsage: finishedStream.reportedUsage,
        detectedModel,
        providerFailureType,
        providerFailureAt,
        providerFailureText,
        ...(streamStats?.streamFile ? { streamFile: streamStats.streamFile, streamStats } : {}),
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
  return ERROR_SHAPED_LINE.test(line) ? hit : null;
}

/**
 * How much of each raw stream a provider-stream failure is judged on, at each
 * end. A transcript runs to megabytes; a provider failure is always in the
 * head (it failed before working) or the tail (it failed after working).
 */
const PROVIDER_ERROR_SCAN_CHARS = 12000;

/**
 * The text an upstream auth failure is looked for in: the raw streams, not the
 * extracted output. Event-stream extraction keeps only the connector's
 * declared text parts, so the `{"type":"error",…}` event carrying the upstream
 * body never reaches `extractOutput`'s result at all.
 */
function providerErrorText(obs) {
  const bounded = (value) => {
    const text = String(value ?? '');
    if (text.length <= PROVIDER_ERROR_SCAN_CHARS * 2) return text;
    return `${text.slice(0, PROVIDER_ERROR_SCAN_CHARS)}\n${text.slice(-PROVIDER_ERROR_SCAN_CHARS)}`;
  };
  return `${bounded(obs.stdout)}\n${bounded(obs.stderr)}`;
}

/**
 * Watch one delegation end-to-end. Returns the standard verdict.
 */
export async function watchOnce(connector, taskText, targetDir, paths, opts = {}) {
  const loadedAccounting = await accountingModules();
  const quota = opts.quotaSnapshot ?? loadedAccounting.quota;
  const subscriptionCostModule = opts.subscriptionCost ?? loadedAccounting.subscription;
  const snapshotPool = opts.snapshotPool ?? quota?.snapshotPool;
  const deltaBetween = opts.deltaBetween ?? quota?.deltaBetween;
  // Keep the delta helper on the same object shape as the contract module so
  // the fallback formatter and injected focused tests follow one path.
  const quotaForAttempt = quota && deltaBetween === quota.deltaBetween
    ? quota
    : (deltaBetween ? { ...quota, deltaBetween } : quota);
  const home = opts.home ?? opts.bullswarmDir ?? process.env.BULLSWARM_HOME?.trim() ?? null;
  // Provider CLIs keep transcripts under the real user home, independently
  // of Bullswarm's relocatable state directory. Tests may override this seam.
  const transcriptHome = opts.transcriptHome ?? opts.userHome ?? homedir();
  const poolName = opts.poolName ?? connector.name ?? null;
  writeFileSync(paths.taskFile, taskText);
  const startedAt = Number.isFinite(Date.parse(opts.startedAt))
    ? Date.parse(opts.startedAt)
    : Date.now();
  // This is intentionally immediately before the child spawn. A meter cache
  // is a shared provider observation, so taking it earlier would charge work
  // that happened before this attempt.
  const startSnapshot = await safeSnapshot(snapshotPool, poolName, home, startedAt);
  const obs = await runDelegate(connector, paths.taskFile, targetDir, {
    ...opts,
    streamFile: opts.streamFile ?? paths.streamFile,
    stdoutFile: opts.stdoutFile ?? paths.stdoutFile,
  });
  const endedAt = Date.now();
  let endSnapshot = await safeSnapshot(snapshotPool, poolName, home, endedAt);
  // A stale end cache is not an observation of the attempt's end. One forced
  // provider read is allowed by the contract; a failed read deliberately
  // leaves the result unknown rather than fabricating a delta.
  if (endSnapshot?.ageMs != null && endSnapshot.ageMs > 60_000 && home && poolName) {
    try {
      await getMeterReading(poolName, { bullswarmDir: home, force: true });
    } catch { /* retain the stale cache, which yields no observed delta */ }
    endSnapshot = await safeSnapshot(snapshotPool, poolName, home, Date.now());
  }
  const wallSec = Math.round((endedAt - startedAt) / 100) / 10;

  const output = extractOutput(connector, obs);
  writeFileSync(paths.outFile, output);
  const selectedModel = opts.model ?? obs.detectedModel ?? obs.reportedUsage?.model ?? connector.model ?? (() => {
    const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
    return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
  })();
  let usage = usageLib.estimateInvocationUsage({
    taskText,
    outputText: output,
    connector,
    model: selectedModel,
    subscription: connector.subscription ?? null,
    reportedUsage: decoderUsageForEstimate(connector, obs.reportedUsage),
  });

  // A stream-reported session identity is authoritative. If a connector does
  // not emit one, a workflow conversation id still gives transcript readers a
  // direct lookup key (Claude/Grok); Codex can use cwd + time instead.
  usage.sessionId = usageSessionId(usage, obs.reportedUsage, opts.conversation);

  // Structured provider counters win. Only an estimated/unknown record may
  // consult durable transcripts, and only when the provider exposes the
  // optional hook. Ambiguous or missing transcript matches are ignored so the
  // byte estimate remains visible for the live attempt; `workflow reprice`
  // applies the stricter unknown policy to historical records.
  if (usage.tokenSource === 'estimated:utf8-bytes/4' || usage.tokenSource === 'unknown') {
    const reader = await resolveTranscriptReader(opts, poolName, home);
    if (reader) {
      try {
        const transcript = await reader({
          provider: poolName,
          sessionId: usage.sessionId,
          cwd: resolve(targetDir),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          home: transcriptHome,
        });
        const exact = transcript?.confidence === 'exact' || transcript?.confidence === 'window';
        const hasTokens = transcript?.tokens && typeof transcript.tokens === 'object'
          && Object.values(transcript.tokens).some((value) => finiteNonNegative(value) != null);
        if (exact && hasTokens) {
          const attach = usageLib.attachTranscriptUsage;
          if (typeof attach === 'function') {
            usage = await attach(usage, transcript) ?? usage;
          } else {
            // Compatibility bridge for a partially integrated checkout. The
            // subscription worker's attachTranscriptUsage supersedes this
            // branch once its richer v2 API is present.
            usage = usageLib.estimateInvocationUsage({
              taskText,
              outputText: output,
              connector,
              model: transcript.model ?? selectedModel,
              subscription: connector.subscription ?? null,
              reportedUsage: {
                ...transcript.tokens,
                model: transcript.model ?? selectedModel,
                sessionId: transcript.sessionId ?? usage.sessionId,
                tokenSource: 'transcript-summed',
              },
            });
          }
          usage.sessionId = usageSessionId(usage, transcript, opts.conversation);
        }
      } catch {
        // A provider-specific transcript store is optional and may be pruned;
        // preserve the live estimate when it cannot be read.
      }
    }
  }

  // Subscription accounting is deliberately a separate block from API-rate
  // pricing. The subscription worker owns the formulas and calibration ledger;
  // this call only supplies the attempt facts it needs.
  const subscriptionConfig = opts.subscription ?? connector.subscription ?? null;
  let subscription = null;
  const subscriptionCost = typeof subscriptionCostModule?.subscriptionCost === 'function'
    ? subscriptionCostModule.subscriptionCost
    : typeof subscriptionCostModule === 'function' ? subscriptionCostModule : null;
  if (subscriptionCost && poolName) {
    try {
      const result = await subscriptionCost({
        pool: poolName,
        poolName,
        subscription: subscriptionConfig,
        api: usage.api ?? null,
        apiUsd: usageApiUsd(usage),
        start: startSnapshot,
        end: endSnapshot,
        startSnapshot,
        endSnapshot,
        home,
        runId: opts.runId ?? null,
        attemptId: opts.attemptId ?? null,
        now: new Date(endedAt).toISOString(),
      });
      subscription = result?.subscription ?? result ?? null;
    } catch {
      subscription = null;
    }
  }
  subscription ??= fallbackSubscription({
    poolName,
    subscription: subscriptionConfig,
    start: startSnapshot,
    end: endSnapshot,
    quota: quotaForAttempt,
  });
  if (subscription) {
    subscription = {
      ...subscription,
      pool: subscription.pool ?? poolName,
      snapshots: subscription.snapshots ?? snapshotsFor(startSnapshot, endSnapshot),
    };
    usage.subscription = subscription;
  }
  const apiUsd = usageApiUsd(usage);
  if (subscription?.basis === 'observed:meter-delta' && apiUsd != null
    && typeof subscriptionCostModule?.appendCalibration === 'function' && poolName) {
    try {
      await subscriptionCostModule.appendCalibration(poolName, {
        at: new Date(endedAt).toISOString(),
        apiUsd,
        deltaPct: subscription.deltaPct,
        window: subscription.window ?? null,
        runId: opts.runId ?? null,
        attemptId: opts.attemptId ?? null,
      }, { home });
    } catch { /* calibration is best effort; the attempt record is durable */ }
  }

  // Gate order matters:
  //   timeout / spawn failure -> fail (nothing to trust)
  //   a provider error event naming an upstream auth phrase -> fail + auth +
  //     quarantine hint (W6), unless the same event is really a usage limit:
  //     a throttle keeps its own kind and its real reset deadline (W5).
  //   a quota-shaped usage-limit line -> fail + quarantine until the reset
  //     (checked before auth: a throttle is not a broken credential).
  //   an error-shaped auth signature in the extracted semantic response ->
  //     fail + quarantine hint (raw structured tool output is not evidence of
  //     provider auth health).
  //   else content judge decides; exit code only modulates flags.
  const head = output.slice(0, 2000);
  const fatalKind = obs.fatalSignature?.kind ?? null;
  const quotaFailure = fatalKind === 'quota'
    ? { signature: obs.fatalSignature.signature, line: obs.fatalSignature.line, context: obs.fatalSignature.context }
    : fatalKind === null ? findQuotaFailure(connector, head) : null;
  const authHit = fatalKind === 'auth'
    ? obs.fatalSignature.signature
    : quotaFailure ? null : matchLikelyAuthFailure(connector, head);
  // Read from the transport, and only once the provider itself declared a
  // stream failure: an upstream credential dies inside the error event, where
  // the semantic-output gates above can never see it (2026-09-11 — three pool
  // names fronting one dead Relay OAuth pool, re-picked attempt after attempt
  // because a stream error carried no quarantine hint).
  const upstreamAuth = obs.providerFailureType
    ? findUpstreamAuthFailure(connector, providerErrorText(obs))
    : null;
  const quotaDeadline = quotaFailure
    ? quotaQuarantineUntil({
        text: quotaFailure.context ?? quotaFailure.line ?? '',
        pool: connector.name ?? null,
        bullswarmDir: opts.bullswarmDir ?? null,
        now: endedAt,
      })
    : null;

  let verdict;
  let structured = null;
  let recoveredStructured = null;
  const canInspectRecoveredOutput = Boolean(
    obs.providerFailureType
      && obs.exitCode === 0
      && typeof output === 'string'
      && output.trim().length > 0
      && !upstreamAuth
      && !quotaFailure,
  );
  if (canInspectRecoveredOutput && typeof opts.outputValidator === 'function') {
    try {
      const checked = opts.outputValidator(output);
      if (!checked || typeof checked.ok !== 'boolean') throw new TypeError('outputValidator must return {ok, errors?, value?}');
      recoveredStructured = {
        ok: checked.ok,
        errors: Array.isArray(checked.errors) ? checked.errors.map(String) : [],
        ...(checked.value !== undefined ? { value: checked.value } : {}),
      };
    } catch {
      recoveredStructured = null;
    }
  }
  const recoveredOutputUsable = canInspectRecoveredOutput
    && (typeof opts.outputValidator === 'function'
      ? recoveredStructured?.ok === true
      : judgeContent(output, {
          expectWork: true,
          acceptVerifyJson: opts.acceptVerifyJson === true,
        }).verdict === 'pass');
  if (obs.cancelled) {
    verdict = { ok: false, why: 'workflow cancellation requested', cancelled: true };
  } else if (obs.stalled) {
    const quiet = Number(opts.silenceTimeoutSec) >= 60 ? `${Math.round(Number(opts.silenceTimeoutSec) / 60)} min` : `${opts.silenceTimeoutSec} s`;
    verdict = { ok: false, why: `stalled: the worker wrote nothing for ${quiet} and was stopped`, failureKind: 'stalled' };
  } else if (obs.timedOut) {
    verdict = { ok: false, why: `timeout after ${opts.timeoutSec}s` };
  } else if (obs.spawnError) {
    verdict = { ok: false, why: `spawn failed: ${obs.stderr.trim().split('\n')[0]}` };
  } else if (upstreamAuth && !quotaFailure) {
    // The phrase is sliced so the whole sentence stays inside the 160-character
    // budget every `why` is held to, with the matched phrase named in full for
    // anything short enough to be a real signature.
    verdict = {
      ok: false,
      failureKind: 'auth',
      quarantineHint: true,
      why: `upstream auth failure: "${String(upstreamAuth.signature).slice(0, 110)}" (provider stream error)`,
    };
  } else if (obs.providerFailureType) {
    if (recoveredOutputUsable) {
      structured = recoveredStructured;
      verdict = typeof opts.outputValidator === 'function'
        ? { ok: true, why: 'structured output validated' }
        : { ok: true, why: 'verified' };
    } else {
      verdict = { ok: false, why: `provider stream reported ${obs.providerFailureType}`, failureKind: 'provider' };
    }
  } else if (quotaFailure) {
    verdict = {
      ok: false,
      failureKind: 'quota',
      quarantineHint: true,
      quarantineUntil: quotaDeadline.until,
      quarantineSource: quotaDeadline.source,
      why: `usage limit: "${(quotaFailure.line ?? quotaFailure.signature).slice(0, 160)}" `
        + `· pool paused until ${new Date(quotaDeadline.until).toISOString()}`,
    };
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

  // A quota verdict invalidates the cache even when it was technically fresh:
  // the provider just refused this attempt, so routing must not trust the
  // low percentage that happened to be captured before it. Force one meter
  // read now; when that read is unavailable, registry.js persists a truthful
  // 100% quota-refusal marker for the shortest window instead.
  let meterRefresh = null;
  if (verdict.failureKind === 'quota' && poolName && home) {
    const meterReader = opts.meterReader ?? opts.readMeter ?? opts.reader;
    meterRefresh = await refreshMeterAfterQuota(poolName, {
      bullswarmDir: home,
      reader: meterReader,
      providers: opts.providers,
      connector,
      subscription: subscriptionConfig,
      nowMs: endedAt,
      resetAtMs: quotaDeadline?.source === 'message' ? quotaDeadline.until : null,
      reason: quotaFailure?.line ?? quotaFailure?.signature ?? verdict.why,
    });
  }

  const usableDespite =
    !verdict.ok &&
    typeof opts.outputValidator !== 'function' &&
    !obs.spawnError &&
    !obs.timedOut &&
    !obs.stalled &&
    !authHit &&
    !upstreamAuth &&
    !quotaFailure &&
    obs.exitCode !== 0 &&
    judgeContent(output, {
      expectWork: true,
      acceptVerifyJson: opts.acceptVerifyJson === true,
    }).verdict === 'pass';

  const notes = verdict.ok && recoveredOutputUsable
    ? [{
        at: obs.providerFailureAt ?? new Date().toISOString(),
        kind: 'recovered-stream-error',
        text: String(
          `provider stream reported ${obs.providerFailureType}`
          + (obs.providerFailureText ? `: ${obs.providerFailureText}` : ''),
        ).slice(0, 500),
      }]
    : [];

  return {
    ...verdict,
    ...(notes.length ? { notes } : {}),
    ok: verdict.ok,
    keepOnClaude: false,
    pick: { pool: connector.name, model: selectedModel, command: connector.spawn.cmd },
    contentUsableDespiteExit: usableDespite,
    ...(structured ? { structured } : {}),
    ...(meterRefresh ? {
      meterRefresh: {
        source: meterRefresh.source,
        quotaRefusal: meterRefresh.quotaRefusal ?? null,
        capturedAt: meterRefresh.snapshot?.captured_at ?? null,
      },
    } : {}),
    meta: {
      pool: connector.name,
      exitCode: obs.exitCode,
      signal: obs.signal,
      timedOut: obs.timedOut,
      stalled: obs.stalled ?? false,
      cancelled: obs.cancelled,
      providerFailureType: obs.providerFailureType,
      providerFailureAt: obs.providerFailureAt,
      providerFailureText: obs.providerFailureText,
      wallSec,
      outBytes: output.length,
      ...(obs.streamFile ? { streamFile: obs.streamFile } : {}),
      usage,
      // The level this attempt actually ran at, exactly as resolved. Reported
      // even when nothing was appended, so a record can say WHY it was silent.
      reasoning: reasoningRecord(opts.reasoning ?? null),
    },
    ...(obs.stderrTail ? { stderrTail: obs.stderrTail } : {}),
    outFile: paths.outFile,
    taskFile: paths.taskFile,
  };
}
