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
//       reset it announced, when it announced one. It is never `process` merely because the
//       CLI exited non-zero, never `auth` merely because it throttled, and
//       never `provider` merely because it arrived in a provider error event.
//   W6. A provider error event that names an upstream auth failure is `auth`,
//       not the generic `provider` kind. A dead credential fails every
//       following attempt on that pool, and on every pool that shares its
//       credential group, in seconds: the dispatch that sees `auth` never
//       moves to one of those (v2-dispatch.js), and `provider` would send it
//       straight there.
//   W7. Quota and auth signatures are matched against the PROVIDER'S ERROR
//       CHANNEL only: stderr, the events the provider flags as errors, and its
//       terminal `result` record. Never the assistant's reply, a tool result,
//       or the extracted answer — on 2026-09-21 a pool was taken out of
//       service with the reason `usage limit: "Codex's \`usage_credits_required\` is
//       spent-credit wording, not a throttle …"`, a sentence from an agent's
//       OWN REPORT quoting a quota signature. A connector with no declared
//       event stream has no provider events to separate, so its own transport
//       is the channel and the shape gate (quota.js Q2) decides what counts.

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { judgeContent } from './verify.js';
import * as usageLib from './usage.js';
import { artifactBesideTask } from './attempt-stream.js';
import { decideUsageLimit, findQuotaFailure } from './quota.js';
import { spawnRetentionSweep } from './retention.js';
import { findUpstreamAuthFailure } from './auth-signatures.js';
import { reasoningRecord } from './reasoning.js';
import { getMeterReading, refreshMeterAfterQuota } from '../meters/registry.js';
import { relayedQuotaNotice, matchLikelyAuthFailure } from './provider-errors.js';
import { followUpArgv } from './worker-argv.js';
import { FOLLOW_UP_PROMPT, derivedReport, outputIsTruncated, extractOutput } from './worker-report.js';
import {
  finiteNonNegative, usageApiUsd, usageSessionId, decoderUsageForEstimate, captureAtExit,
  safeSnapshot, snapshotsFor, cursorFor, ledgerWindow, attemptLedgerIntervals, fallbackSubscription,
  resolveTranscriptReader,
} from './attempt-usage.js';
import { runDelegate } from './run-delegate.js';

function selectedModelFor(connector, opts, observed) {
  return opts.model ?? observed?.detectedModel ?? observed?.reportedUsage?.model ?? connector.model ?? (() => {
    const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
    return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
  })();
}

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

/**
 * Watch one delegation end-to-end. Returns the standard verdict.
 */
export async function watchOnce(connector, taskText, targetDir, paths, opts = {}) {
  const loadedAccounting = await accountingModules();
  const quota = opts.quotaSnapshot ?? loadedAccounting.quota;
  const subscriptionCostModule = opts.subscriptionCost ?? loadedAccounting.subscription;
  const snapshotPool = opts.snapshotPool ?? quota?.snapshotPool;
  const meterReading = opts.getMeterReading ?? getMeterReading;
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
  let startSnapshot = await safeSnapshot(snapshotPool, poolName, home, startedAt, 'cache');
  // MeterCache is shared state, and a start reading older than the delta
  // guard would make a real attempt look unmeasurable. Refresh once before
  // spawning, then re-read through the same compact snapshot helper so the
  // recorded source distinguishes the forced provider read from a cache hit.
  if (startSnapshot?.ageMs != null && startSnapshot.ageMs > 60_000 && home && poolName) {
    try {
      const refreshed = await meterReading(poolName, { bullswarmDir: home, force: true });
      if (refreshed?.source === 'live' || refreshed?.source === 'forced') {
        startSnapshot = await safeSnapshot(snapshotPool, poolName, home, Date.now(), 'forced');
      }
    } catch { /* retain the stale cache, which yields no observed delta */ }
  }
  const startCursor = cursorFor(startSnapshot, new Date(startedAt).toISOString());
  let capture = null;
  const obs = await runDelegate(connector, paths.taskFile, targetDir, {
    ...opts,
    streamFile: opts.streamFile ?? paths.streamFile ?? artifactBesideTask(paths.taskFile, 'stream', '.jsonl'),
    stdoutFile: opts.stdoutFile ?? paths.stdoutFile,
    outFile: opts.outFile ?? paths.outFile,
    // Worker exit: hand the caller what the provider reported before the
    // end meter read and the transcript lookup below, either of which can
    // take long enough for the kernel to die in between.
    onDelegateExit: (exit) => {
      const captured = captureAtExit(connector, exit, {
        model: selectedModelFor(connector, opts, exit),
        conversation: opts.conversation ?? null,
      });
      capture = captured.capture;
      opts.onCapture?.(
        JSON.parse(JSON.stringify(capture)),
        captured.usage ? JSON.parse(JSON.stringify(captured.usage)) : null,
      );
    },
  });
  const endedAt = Date.now();
  let endSnapshot = await safeSnapshot(snapshotPool, poolName, home, endedAt, 'cache');
  // A stale end cache is not an observation of the attempt's end. One forced
  // provider read is allowed by the contract; a failed read deliberately
  // leaves the result unknown rather than fabricating a delta.
  if (endSnapshot?.ageMs != null && endSnapshot.ageMs > 60_000 && home && poolName) {
    try {
      const refreshed = await meterReading(poolName, { bullswarmDir: home, force: true });
      if (refreshed?.source === 'live' || refreshed?.source === 'forced') {
        endSnapshot = await safeSnapshot(snapshotPool, poolName, home, Date.now(), 'forced');
      } else {
        endSnapshot = null;
      }
    } catch {
      // A stale end reading is not an observation of this attempt. Drop it
      // after a failed refresh so a coincidentally unchanged counter cannot
      // become a fabricated observed zero.
      endSnapshot = null;
    }
  }
  const endCursor = cursorFor(endSnapshot, new Date(endedAt).toISOString());
  const subscriptionConfig = opts.subscription ?? connector.subscription ?? null;
  const resolvedLedgerWindow = ledgerWindow(subscriptionConfig?.window)
    ?? ledgerWindow(subscriptionConfig?.quotaWindow)
    ?? ledgerWindow(endSnapshot?.window)
    ?? ledgerWindow(startSnapshot?.window)
    ?? null;
  const ledgerIntervals = attemptLedgerIntervals({
    opts,
    poolName,
    home,
    startSnapshot,
    endSnapshot,
    startCursor,
    endCursor,
    startedAt,
    endedAt,
    window: resolvedLedgerWindow,
  });
  const wallSec = Math.round((endedAt - startedAt) / 100) / 10;

  const initialOutput = extractOutput(connector, obs);
  const outputTruncated = outputIsTruncated(initialOutput, obs.eventTimeline);
  let output = initialOutput;
  let outputSource = null;
  if (outputTruncated) {
    const sessionId = obs.reportedUsage?.sessionId ?? opts.conversation?.sessionId ?? null;
    const followUp = connector.conversation?.followUp;
    const followUpCommand = followUpArgv(connector, {
      taskFile: paths.taskFile,
      cwd: resolve(targetDir),
      sessionId,
      prompt: FOLLOW_UP_PROMPT,
    });
    if (followUpCommand) {
      const originalStreamFile = opts.streamFile ?? paths.streamFile ?? null;
      const originalStdoutFile = opts.stdoutFile ?? paths.stdoutFile ?? null;
      const followUpObs = await runDelegate(connector, paths.taskFile, targetDir, {
        ...opts,
        argv: followUpCommand,
        conversation: null,
        onDelegateExit: null,
        attemptStream: null,
        streamFile: originalStreamFile ? `${originalStreamFile}.follow-up` : null,
        stdoutFile: originalStdoutFile ? `${originalStdoutFile}.follow-up` : null,
      });
      const followUpOutput = extractOutput(connector, followUpObs);
      if (followUpOutput.trim()) {
        output = followUpOutput;
        outputSource = 'follow-up';
      } else {
        output = derivedReport(targetDir, obs, paths);
        outputSource = 'derived';
      }
    } else {
      output = derivedReport(targetDir, obs, paths);
      outputSource = 'derived';
    }
  }
  writeFileSync(paths.outFile, output);
  const selectedModel = selectedModelFor(connector, opts, obs);
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
  let transcriptReaderFound = false;
  if (usage.tokenSource === 'estimated:utf8-bytes/4' || usage.tokenSource === 'unknown') {
    const reader = await resolveTranscriptReader(opts, poolName, home);
    transcriptReaderFound = Boolean(reader);
    if (reader) {
      try {
        const transcript = await reader({
          provider: poolName,
          sessionId: usage.sessionId,
          cwd: resolve(targetDir),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          // The delegate's first message quotes this path (or carries this
          // text), which resolves parallel attempts in one cwd.
          taskFile: paths.taskFile,
          taskText,
          home: transcriptHome,
        });
        const exact = ['exact', 'window', 'task-text'].includes(transcript?.confidence);
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
  let subscription = null;
  const subscriptionCost = typeof subscriptionCostModule?.subscriptionCost === 'function'
    ? subscriptionCostModule.subscriptionCost
    : typeof subscriptionCostModule === 'function' ? subscriptionCostModule : null;
  if (subscriptionCost && poolName) {
    try {
      const suppliedAttempts = (Array.isArray(opts.attempts ?? opts.activeAttempts)
        ? (opts.attempts ?? opts.activeAttempts)
        : []).filter((attempt) => !attempt?.pool || attempt.pool === poolName);
      const ledgerAttempt = {
        id: opts.attemptId ?? null,
        attemptId: opts.attemptId ?? null,
        pool: poolName,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(endedAt).toISOString(),
        apiUsd: usageApiUsd(usage),
        api: usage.api ?? null,
      };
      const result = await subscriptionCost({
        pool: {
          name: poolName,
          meterSnapshot: endSnapshot ?? startSnapshot,
        },
        poolName,
        subscription: subscriptionConfig,
        api: usage.api ?? null,
        apiUsd: usageApiUsd(usage),
        start: startSnapshot,
        end: endSnapshot,
        startSnapshot,
        endSnapshot,
        ledgerIntervals,
        meterIntervals: ledgerIntervals,
        attempts: suppliedAttempts,
        activeAttempts: suppliedAttempts,
        ledgerAttempt,
        startedAt: ledgerAttempt.startedAt,
        finishedAt: ledgerAttempt.finishedAt,
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
      ...(startCursor || endCursor || ledgerIntervals ? {
        attribution: {
          startCursor,
          endCursor,
          historyCursor: { start: startCursor, end: endCursor },
          attemptId: opts.attemptId ?? null,
          runId: opts.runId ?? null,
          window: subscription.window ?? resolvedLedgerWindow ?? null,
          intervals: Array.isArray(ledgerIntervals) ? ledgerIntervals : [],
          ledgerRows: Array.isArray(subscription.ledgerRows) ? subscription.ledgerRows : [],
          deltaPct: subscription.deltaPct ?? null,
          conservedDeltaPct: subscription.conservedDeltaPct ?? null,
          resolutionPct: subscription.resolutionPct ?? null,
          basis: subscription.basis ?? null,
        },
      } : {}),
    };
    usage.subscription = subscription;
    usage.normalizedQuota = {
      ...(usage.normalizedQuota && typeof usage.normalizedQuota === 'object' ? usage.normalizedQuota : {}),
      estimatedPercent: subscription.deltaPct ?? null,
      deltaPct: subscription.deltaPct ?? null,
      window: subscription.window ?? null,
      basis: subscription.basis ?? 'unknown:no-meter',
      ...(subscription.resolutionPct != null ? { resolutionPct: subscription.resolutionPct } : {}),
    };
  }
  const apiUsd = usageApiUsd(usage);
  if (subscription?.basis === 'observed:meter-ledger' && apiUsd != null
    && typeof subscriptionCostModule?.appendCalibrationFromResult === 'function' && poolName) {
    try {
      await subscriptionCostModule.appendCalibrationFromResult(poolName, subscription, {
        home,
        apiUsd,
        runId: opts.runId ?? null,
        attemptId: opts.attemptId ?? null,
      });
    } catch { /* calibration is best effort; the attempt record is durable */ }
  } else if (subscription?.basis === 'observed:meter-delta' && apiUsd != null
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

  // Usage is final. A caller that prices unmeasured work later (a single run
  // starts the detached reconciler) is told once; nothing here waits for it.
  if (typeof opts.onUsageFinalized === 'function') {
    try {
      opts.onUsageFinalized({
        usage,
        poolName: poolName ?? null,
        // False when the pool's provider keeps no transcript a later pass could read.
        transcriptReader: transcriptReaderFound,
        taskFile: paths.taskFile ?? null,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
      });
    } catch { /* pricing is best effort */ }
  }
  if (opts.bullswarmDir) spawnRetentionSweep({ bullswarmDir: opts.bullswarmDir, trigger: 'watch' });

  // Gate order matters:
  //   timeout / spawn failure -> fail (nothing to trust)
  //   a provider error event naming an upstream auth phrase -> fail + auth
  //     (W6), unless the same event is really a usage limit: a throttle keeps
  //     its own kind and its real reset (W5).
  //   a quota-shaped usage-limit line -> fail as `quota` or `throttle`, with
  //     the reset when Q6 knows it (checked before auth: a throttle is not a
  //     broken credential).
  //   any other provider stream failure -> fail as `provider`, unless the
  //     worker exited 0 with a usable answer (recovered).
  //   an error-shaped auth signature on the provider's error channel ->
  //     fail + auth (an agent's report ABOUT auth work is not evidence of
  //     provider auth health — W7).
  //   else content judge decides; exit code only modulates flags.
  // W7: every signature below is matched against the PROVIDER'S ERROR CHANNEL
  // — stderr, the provider's own error events and its terminal record — never
  // the assistant's reply, a tool result or the extracted answer.
  const errorChannel = obs.errorChannel ?? '';
  const fatalKind = obs.fatalSignature?.kind ?? null;
  // A provider that answers a refused turn with its own limit notice as the
  // reply (Claude Code: `You've hit your session limit · resets …`, usage all
  // zero) mirrors it into its terminal record, which W7 reads as the agent's
  // words. That reply is the provider's notice only when its whole trimmed
  // text is the one quota-shaped line and the provider reported a turn that
  // produced nothing; a reply quoting the line inside an answer stays a reply.
  const relayedNotice = fatalKind === null
    ? relayedQuotaNotice(connector, initialOutput, obs.reportedUsage)
    : null;
  const quotaChannel = relayedNotice ? `${errorChannel}\n${relayedNotice}` : errorChannel;
  const quotaFailure = fatalKind === 'quota'
    ? {
        signature: obs.fatalSignature.signature,
        line: obs.fatalSignature.line,
        context: obs.fatalSignature.context,
        transient: obs.fatalSignature.transient === true,
        waitMs: obs.fatalSignature.waitMs ?? null,
      }
    : fatalKind === null ? findQuotaFailure(connector, quotaChannel, { now: endedAt }) : null;
  const authHit = fatalKind === 'auth'
    ? obs.fatalSignature.signature
    : quotaFailure ? null : matchLikelyAuthFailure(connector, errorChannel);
  // Read from the provider's error channel, and only once the provider itself
  // declared a stream failure: an upstream credential dies inside the error
  // event, where the semantic-output gates above can never see it (2026-09-11
  // — three pool names fronting one dead Relay OAuth pool, re-picked attempt
  // after attempt because a stream error was read as a provider failure).
  const upstreamAuth = obs.providerFailureType
    ? findUpstreamAuthFailure(connector, errorChannel)
    : null;
  // quota.js Q6 — the one rule for when a limit resets: the pool's own meter
  // at >= 95% on a running window, or a provider line that says a usage
  // window is spent AND names its reset. The decision (line, meter reading,
  // reset) travels on the verdict as `usageLimit`; nothing is stored (Q7).
  const usageLimit = quotaFailure
    ? decideUsageLimit({
        connector,
        failure: quotaFailure,
        pool: poolName,
        bullswarmDir: home,
        now: endedAt,
      })
    : null;
  const knownReset = usageLimit?.until ?? null;
  // A limit whose reset is known is `quota`. A caller under the
  // limits-to-caller rule (`usageLimitsToCaller`: a marked workflow step, the
  // planner and scout of a marked run, `bullswarm run`) also reads a notice
  // worded as a spent window as `quota`; for any other caller (a run started
  // by an earlier version) that one is a throttle, as it always was.
  const spentLimit = Boolean(usageLimit && (knownReset != null
    || (opts.usageLimitsToCaller === true && usageLimit.limit === 'window')));

  let verdict;
  let structured = null;
  let recoveredStructured = null;
  // A validator that reads a file the worker wrote (a v3 answer file,
  // workflow/answers.js) does not need a reply: a valid, fresh answer file is
  // usable output on its own.
  const readsFile = typeof opts.outputValidator === 'function' && opts.outputValidator.readsFile === true;
  // A v3 step with no answer declared passes an accept-all validator
  // (workflow/answers.js): it checks nothing, so no verdict may say an answer
  // was validated, and whether the content is usable after a non-zero exit
  // is the content judge's call, as for a step with no validator.
  const noAnswer = typeof opts.outputValidator === 'function' && opts.outputValidator.checksNoAnswer === true;
  const passedWhy = noAnswer ? 'exited 0 · no answer declared' : 'structured output validated';
  const canInspectRecoveredOutput = Boolean(
    obs.providerFailureType
      && obs.exitCode === 0
      && ((typeof output === 'string' && output.trim().length > 0) || readsFile)
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
      why: `upstream auth failure: "${String(upstreamAuth.signature).slice(0, 110)}" (provider stream error)`,
    };
  } else if (quotaFailure && !spentLimit) {
    verdict = {
      ok: false,
      failureKind: 'throttle',
      throttleWaitMs: quotaFailure.waitMs ?? null,
      throttleRetrySamePool: usageLimit.retrySamePool,
      usageLimit,
      why: usageLimit.why,
    };
  } else if (quotaFailure) {
    verdict = {
      ok: false,
      failureKind: 'quota',
      // When to try this pool again, when that is known (Q6).
      ...(knownReset != null ? { retryAfter: new Date(knownReset).toISOString() } : {}),
      usageLimit,
      why: usageLimit.why,
    };
  } else if (obs.providerFailureType) {
    // After the limit gates: a usage limit inside the provider's error event
    // keeps its throttle or quota kind. A recovered output is only inspected
    // when no limit was found (canInspectRecoveredOutput).
    if (recoveredOutputUsable) {
      structured = recoveredStructured;
      verdict = typeof opts.outputValidator === 'function'
        ? { ok: true, why: passedWhy }
        : { ok: true, why: 'verified' };
    } else {
      verdict = { ok: false, why: `provider stream reported ${obs.providerFailureType}`, failureKind: 'provider' };
    }
  } else if (authHit) {
    verdict = {
      ok: false,
      failureKind: 'auth',
      why: `auth/throttle signature: "${authHit}"`,
    };
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
        ? { ok: true, why: passedWhy }
        : {
            ok: false,
            why: checked.ok
              ? noAnswer ? 'process exited non-zero · no answer declared' : 'structured output validated but process exited non-zero'
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
  // read now; when that read is unavailable, registry.js persists a 100%
  // quota-refusal marker for the shortest window instead, until the known
  // reset when there is one (named by the provider, or measured by the
  // meter), else until a reset registry.js guesses from the last reading —
  // a guessed one keeps no pool out (framework.js windowSpent).
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
      resetAtMs: knownReset,
      resetSource: usageLimit?.rule === 'meter' ? 'measured' : 'named',
      reason: quotaFailure?.line ?? quotaFailure?.signature ?? verdict.why,
    });
  }

  // Usable despite the exit: a declared answer that validated, else (no
  // validator, or no answer declared) content the judge passes.
  const usableDespite =
    !verdict.ok &&
    !obs.spawnError &&
    !obs.timedOut &&
    !obs.stalled &&
    !authHit &&
    !upstreamAuth &&
    !quotaFailure &&
    obs.exitCode !== 0 &&
    (typeof opts.outputValidator === 'function' && !noAnswer
      ? structured?.ok === true
      : judgeContent(output, {
          expectWork: true,
          acceptVerifyJson: opts.acceptVerifyJson === true,
        }).verdict === 'pass');

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
    ...(outputTruncated ? { outputTruncated: true, outputSource } : {}),
    ...(notes.length ? { notes } : {}),
    ok: verdict.ok,
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
      // Stage 3: read only by the failure rule of marked runs (a process
      // failure, and the one retry an act step may get). classifyFailure
      // never reads it, so saved runs classify a spawn failure as before.
      ...(obs.workerNotStarted ? { workerNotStarted: true } : {}),
      providerFailureType: obs.providerFailureType,
      providerFailureAt: obs.providerFailureAt,
      providerFailureText: obs.providerFailureText,
      wallSec,
      outBytes: output.length,
      ...(outputTruncated ? { outputTruncated: true, ...(outputSource ? { outputSource } : {}) } : {}),
      ...(obs.streamFile ? { streamFile: obs.streamFile } : {}),
      usage,
      ...(capture ? { capture } : {}),
      // The level this attempt actually ran at, exactly as resolved. Reported
      // even when nothing was appended, so a record can say WHY it was silent.
      reasoning: reasoningRecord(opts.reasoning ?? null),
    },
    ...(obs.stderrTail ? { stderrTail: obs.stderrTail } : {}),
    outFile: paths.outFile,
    taskFile: paths.taskFile,
  };
}
