// Spawning one worker process and capturing everything it does (watch.js
// W1-W3): the binary directly with no shell, the connector's cwd mode, an
// optional timeout, the decoded event stream, and the process tree ended on
// cancellation.

import { spawn } from 'node:child_process';
import { writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgentEventDecoder } from './agent-events.js';
import { resolveAttemptStream } from './attempt-stream.js';
import { findQuotaFailure } from './quota.js';
import {
  matchAuthSignature, PROVIDER_ERROR_SCAN_CHARS, ERROR_RECORD_MAX_CHARS, ERROR_CHANNEL_MAX_CHARS, replyOpening,
  mirrorsAgentReply, providerErrorRecords,
} from './provider-errors.js';
import { MAX_CAPTURED_STREAM_BYTES, BoundedCapture } from './bounded-capture.js';
import { argvWithModel, workerEnv } from './worker-argv.js';

function toolOrCommandEvent(event) {
  const kind = `${event?.kind ?? ''} ${event?.providerType ?? ''}`
    .toLowerCase().replace(/[_-]/g, ' ');
  return /\btool\b|\bcommand\b|\bfunction\b|\bshell\b/.test(kind);
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
  const argv = opts.argv ?? argvWithModel(connector, {
    taskFile,
    cwd: resolve(targetDir),
  }, opts.model, opts.conversation, opts.reasoning ?? null);
  // realpath: getcwd() resolves symlinks (macOS /var -> /private/var), so an
  // unresolved PWD would disagree with cwd and defeat wrong-repo detection.
  const resolvedDir = realpathSync(resolve(targetDir));

  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: resolvedDir,
      env: workerEnv(connector, opts.env, resolvedDir),
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
    let eventSequence = 0;
    let lastResponseSequence = 0;
    let lastToolSequence = 0;
    // Assistant prose only. Tool results are quoted file/command output and
    // routinely contain limit wording that says nothing about OUR quota.
    let responseText = '';
    // W7: the provider's own records about its own failure — the events it
    // declares as failures and its terminal `result`. Together with stderr
    // (and, for a connector with no event stream, its own transport) this is
    // the whole error channel; nothing the agent wrote ever enters it.
    const eventStreamed = connector.outputExtraction?.strategy === 'event-stream';
    const declaredFailureTypes = new Set((connector.eventStream?.failureTypes ?? []).map(String));
    let providerRecords = '';
    // The pane keeps a long reply shortened (`…`) and responseText skips
    // those, so the openings of every full reply are kept for the mirror
    // checks alone: a long report repeated in the terminal record is still
    // the agent's words (2026-09-25: a review quoting `unauthorized` was
    // failed as a sign-in failure on a healthy pool).
    let replyOpenings = '';
    const noteProviderRecord = (text) => {
      const value = typeof text === 'string' ? text.trim() : '';
      if (!value) return;
      providerRecords = `${providerRecords}${value.slice(0, ERROR_RECORD_MAX_CHARS)}\n`
        .slice(-ERROR_CHANNEL_MAX_CHARS);
    };
    // A provider that mirrors the agent's final message into its terminal
    // record (Claude Code's `result`) is repeating the agent's own words: that
    // text is a reply, not a provider report, and the gate must not be fooled
    // by it. A genuine limit notice shares no such opening.
    const mirrorsReply = (text) => mirrorsAgentReply(text, `${responseText}\n${replyOpenings}`);
    const errorChannelText = (full = false) => {
      if (!eventStreamed) return `${stdoutCapture.tail(4000)}\n${stderrCapture.tail(4000)}`.trim();
      return [
        stderrCapture.tail(4000),
        providerErrorRecords(
          full ? stdoutCapture.text() : stdoutCapture.tail(PROVIDER_ERROR_SCAN_CHARS),
          declaredFailureTypes,
          { agentText: `${responseText}\n${replyOpenings}` },
        ),
        providerRecords,
      ].filter(Boolean).join('\n');
    };
    // The channel a plan refusal (`modelPlanSignatures`) is read on: what the
    // provider itself wrote as a failure. A connector with no event stream
    // has the agent's reply on stdout, so only its stderr is the provider's;
    // on an event stream, stderr and the records the provider flags as errors
    // (never a clean terminal record, which mirrors the agent's reply), so a
    // refusal is read whatever the exit code and a reply quoting the code is
    // not.
    const planChannelText = () => (eventStreamed
      ? [
        stderrCapture.tail(4000),
        providerErrorRecords(stdoutCapture.text(), declaredFailureTypes, { failuresOnly: true }),
      ].filter(Boolean).join('\n').trim()
      : stderrCapture.tail(4000).trim());
    const attemptStream = resolveAttemptStream(connector, opts);
    const liveOutFile = opts.outFile ?? null;
    let lastLiveOutput = null;
    const persistLiveOutput = () => {
      if (!liveOutFile) return;
      const strategy = connector.outputExtraction?.strategy ?? 'stdout';
      const text = strategy === 'event-stream'
        ? (eventDecoder?.output() || stdoutCapture.text() || '')
        : strategy === 'stdout-tail'
          ? (stdoutCapture.text() || '').split('\n').slice(-80).join('\n')
          : (stdoutCapture.text() || stderrCapture.text() || '');
      if (!text || text === lastLiveOutput) return;
      lastLiveOutput = text;
      try { writeFileSync(liveOutFile, text); } catch { /* live tail is best-effort */ }
    };
    const eventDecoder = createAgentEventDecoder(connector.eventStream, {
      onEvent: (event, fullSummary) => {
        eventSequence += 1;
        if (event?.kind === 'response') lastResponseSequence = eventSequence;
        if (toolOrCommandEvent(event)) lastToolSequence = eventSequence;
        if (event?.kind === 'response' && typeof event.summary === 'string'
          // A truncation marker means a long answer, not a bare limit notice;
          // judging the collapsed head of a real report would kill a healthy
          // agent for discussing rate limits in its first sentence.
          && !event.summary.endsWith('\u2026')) {
          responseText = `${responseText}${event.summary}\n`.slice(-8000);
        }
        if (event?.kind === 'response' && typeof fullSummary === 'string' && fullSummary.trim()) {
          replyOpenings = `${replyOpenings}${replyOpening(fullSummary)}\n`.slice(-8000);
        }
        const recordText = typeof fullSummary === 'string' ? fullSummary : event?.summary;
        if (declaredFailureTypes.has(String(event?.providerType ?? ''))) {
          providerFailureText ??= typeof event?.summary === 'string' ? event.summary : null;
          noteProviderRecord(recordText);
        } else if (event?.kind === 'result' && !mirrorsReply(recordText)) {
          noteProviderRecord(recordText);
        }
        attemptStream?.event(event, fullSummary);
        persistLiveOutput();
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
      // W7: the provider's error channel, never the agent's words. Structured
      // stdout is an agent transcript — a reply or a tool result that quotes a
      // limit phrase is not evidence about this pool's quota or credential
      // (2026-09-21: a report quoting `usage_credits_required` took one out).
      const channel = errorChannelText();
      // Quota is classified BEFORE auth. Some connectors list a usage phrase
      // (codex `usage_credits_required`) among their auth signatures — a
      // throttle must still be reported as quota.
      const quota = findQuotaFailure(connector, channel);
      if (quota) {
        fatalSignature = { kind: 'quota', ...quota };
      } else {
        const authHit = matchAuthSignature(connector, channel);
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
          persistLiveOutput();
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
    // Called synchronously the moment the worker is gone, before anything
    // slow (meter reads, transcript lookup) can run, so the caller can make
    // what the provider reported durable first. A failing sink never costs
    // the attempt its verdict.
    let exitReported = false;
    const reportExit = (exitCode, signal, finishedStream, extra = {}) => {
      if (exitReported || typeof opts.onDelegateExit !== 'function') return;
      exitReported = true;
      try {
        opts.onDelegateExit({
          exitCode, signal, reportedUsage: finishedStream.reportedUsage, detectedModel, ...extra,
        });
      } catch { /* the capture is best effort; the verdict still resolves */ }
    };
    child.on('error', (err) => {
      // No pid: the CLI never started, so the worker did nothing at all.
      const workerNotStarted = child.pid == null;
      const finishedStream = finishStream();
      reportExit(null, null, finishedStream, { spawnError: true });
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
        eventTimeline: { lastResponseSequence, lastToolSequence },
        detectedModel,
        providerFailureType,
        providerFailureAt,
        providerFailureText,
        errorChannel: errorChannelText(true),
        planChannel: planChannelText(),
        spawnError: true,
        ...(workerNotStarted ? { workerNotStarted: true } : {}),
        ...(streamStats?.streamFile ? { streamFile: streamStats.streamFile, streamStats } : {}),
      });
    });
    child.on('close', (code, signal) => {
      if (opts.processGroup && (cancelled || timedOut || stalled || fatalSignature || opts.shouldCancel?.())) stopChild('SIGKILL');
      const finishedStream = finishStream();
      reportExit(code, signal, finishedStream);
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
        eventTimeline: { lastResponseSequence, lastToolSequence },
        detectedModel,
        providerFailureType,
        providerFailureAt,
        providerFailureText,
        errorChannel: errorChannelText(true),
        planChannel: planChannelText(),
        ...(streamStats?.streamFile ? { streamFile: streamStats.streamFile, streamStats } : {}),
      });
    });
  });
}
