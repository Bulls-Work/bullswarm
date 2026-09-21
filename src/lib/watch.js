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
//   W7. Quota and auth signatures are matched against the PROVIDER'S ERROR
//       CHANNEL only: stderr, the events the provider flags as errors, and its
//       terminal `result` record. Never the assistant's reply, a tool result,
//       or the extracted answer — on 2026-09-21 a pool was paused with the
//       reason `usage limit: "Codex's \`usage_credits_required\` is
//       spent-credit wording, not a throttle …"`, a sentence from an agent's
//       OWN REPORT quoting a quota signature. A connector with no declared
//       event stream has no provider events to separate, so its own transport
//       is the channel and the shape gate (quota.js Q2) decides what counts.
//       With `strategy.pausing: "off"` (quota.js Q7) no verdict asks for a
//       pause at all; an auth failure is reported as the `provider` failure it
//       also is, so the attempt still moves to another pool.

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeContent } from './verify.js';
import * as usageLib from './usage.js';
import { createAgentEventDecoder } from './agent-events.js';
import { captureLimits, createAttemptStreamSink } from './attempt-stream.js';
import { ERROR_SHAPED_LINE, decideQuotaPause, findQuotaFailure, readPausing } from './quota.js';
import { spawnRetentionSweep } from './retention.js';
import { JSON_ERROR_EVENT_LINE, findUpstreamAuthFailure } from './auth-signatures.js';
import { appliedReasoningLevel, reasoningArgs, reasoningRecord } from './reasoning.js';
import {
  getMeterReading,
  refreshMeterAfterQuota,
  meterHistoryIntervals,
} from '../meters/registry.js';
import { loadProviders, transcriptReaderFor } from './providers.js';

const BULLSWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const FOLLOW_UP_PROMPT = 'Your previous turn ended without a final report. Write it now: what you changed per file, the test summary lines, contract deviations, shared-file requests.';
const TRUNCATED_OUTPUT_MAX = 500;

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

function selectedModelFor(connector, opts, observed) {
  return opts.model ?? observed?.detectedModel ?? observed?.reportedUsage?.model ?? connector.model ?? (() => {
    const index = connector.spawn?.cmd?.indexOf('--model') ?? -1;
    return index >= 0 ? connector.spawn.cmd[index + 1] ?? null : null;
  })();
}

const CAPTURE_TOKEN_FIELDS = [
  'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output', 'reasoning', 'totalKnown',
];

/**
 * The attempt's `capture` block: what the provider itself said when the worker
 * exited, built from the decoded stream alone — no transcript, meter or rate
 * card is consulted, so it is ready the instant the process ends. Token
 * classes are canonical (exclusive) and present only when the provider
 * reported counters; a stream with no counters is `unknown`, never an
 * estimate. The session id is the provider's own when the stream carries
 * one, else the id Bullswarm handed the CLI on its command line.
 */
export function attemptCapture(connector, exit = {}, options = {}) {
  return captureAtExit(connector, exit, options).capture;
}

// The capture plus, when the provider reported counters, the canonical usage
// envelope priced from them (the same record watchOnce ends with, minus the
// meter-side subscription block that needs the end snapshot).
function captureAtExit(connector, exit = {}, {
  model = null, conversation = null, at = new Date().toISOString(),
} = {}) {
  const reported = exit?.reportedUsage && typeof exit.reportedUsage === 'object' ? exit.reportedUsage : null;
  const usage = reported ? usageLib.estimateInvocationUsage({
    connector,
    model,
    subscription: null,
    reportedUsage: decoderUsageForEstimate(connector, reported),
  }) : null;
  const counted = usage?.tokenSource === 'provider-reported'
    && CAPTURE_TOKEN_FIELDS.some((field) => field !== 'totalKnown' && finiteNonNegative(usage.tokens?.[field]) != null);
  const reportedSessionId = typeof reported?.sessionId === 'string' && reported.sessionId ? reported.sessionId : null;
  const template = conversation?.resume ? connector?.conversation?.resumeArgs : connector?.conversation?.newArgs;
  const assignedSessionId = typeof conversation?.sessionId === 'string' && conversation.sessionId
    && Array.isArray(template) && template.some((arg) => String(arg).includes('{sessionId}'))
    ? conversation.sessionId
    : null;
  const capture = {
    capturedAt: at,
    source: connector?.eventStream?.format === 'jsonl' ? 'event-stream' : 'exit-status',
    providerSessionId: reportedSessionId ?? assignedSessionId,
    sessionSource: reportedSessionId ? 'provider-stream' : assignedSessionId ? 'bullswarm-assigned' : null,
    model: model ?? null,
    tokens: counted
      ? Object.fromEntries(CAPTURE_TOKEN_FIELDS.map((field) => [field, finiteNonNegative(usage.tokens[field])]))
      : null,
    tokenSource: counted ? 'provider-reported' : 'unknown',
    providerCostUsd: finiteNonNegative(reported?.costUsd),
    exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
    signal: typeof exit?.signal === 'string' && exit.signal ? exit.signal : null,
  };
  if (counted) usage.sessionId = capture.providerSessionId;
  return { capture, usage: counted ? usage : null };
}

async function safeSnapshot(snapshotPool, poolName, home, now, source = 'cache') {
  if (typeof snapshotPool !== 'function' || !poolName || !home) return null;
  try {
    const snapshot = await snapshotPool(poolName, { home, now });
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    // snapshotPool keeps cursor/precision markers non-enumerable for legacy
    // cache-only reads. Preserve them explicitly when crossing this seam;
    // otherwise the ledger cannot bracket the delegate even though the
    // production snapshot reader found the row.
    return {
      ...snapshot,
      ...(snapshot.historyCursor ? { historyCursor: snapshot.historyCursor } : {}),
      ...(snapshot.history_cursor ? { history_cursor: snapshot.history_cursor } : {}),
      ...(snapshot.resolutionPct != null ? { resolutionPct: snapshot.resolutionPct } : {}),
      source: source ?? snapshot.source ?? 'cache',
    };
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

function cursorFor(snapshot, fallbackAt = null) {
  const cursor = snapshot?.historyCursor ?? snapshot?.history_cursor;
  if (cursor && typeof cursor === 'object') return { ...cursor };
  const at = snapshot?.at ?? fallbackAt;
  return at ? { at, window: snapshot?.window ?? null, index: null, source: snapshot?.source ?? null } : null;
}

function epochMs(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function ledgerWindow(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (name === '5h' || name === 'five_hour' || name === 'five-hour') return '5h';
  if (name === 'weekly' || name === 'seven_day' || name === 'seven-day') return 'weekly';
  if (name === 'monthly') return 'monthly';
  return null;
}

/**
 * Read only the ledger rows observed between the start and end cursors. The
 * cursor indexes are preferred because a meter interval may begin before the
 * delegate starts but be observed during it; timestamps are the fallback for
 * cache/history fixtures that predate cursor metadata.
 */
function attemptLedgerIntervals({
  opts, poolName, home, startSnapshot, endSnapshot, startCursor, endCursor,
  startedAt, endedAt, window = null,
}) {
  const reader = opts.meterHistoryIntervals ?? meterHistoryIntervals;
  if (typeof reader !== 'function' || !poolName) return null;
  if (!home && !opts.meterHistoryDir && !opts.historyDir && !opts.ledgerDir) return null;
  try {
    const rows = reader(poolName, {
      dir: opts.meterHistoryDir ?? opts.historyDir ?? opts.ledgerDir ?? join(home, 'meters'),
      window,
    });
    if (!Array.isArray(rows)) return null;
    const callerPassedWindow = window !== null && window !== undefined;
    const resolvedWindow = ledgerWindow(window);
    const startIndex = Number.isInteger(startCursor?.index) ? startCursor.index : null;
    const endIndex = Number.isInteger(endCursor?.index) ? endCursor.index : null;
    const startMs = epochMs(startSnapshot?.at ?? startCursor?.at ?? startedAt);
    const endMs = epochMs(endSnapshot?.at ?? endCursor?.at ?? endedAt);
    return rows.filter((row) => {
      const rowWindowValue = row?.window;
      const rowHasWindow = rowWindowValue !== null
        && rowWindowValue !== undefined
        && String(rowWindowValue).trim() !== '';
      if (callerPassedWindow) {
        if (resolvedWindow == null || !rowHasWindow || ledgerWindow(rowWindowValue) !== resolvedWindow) {
          return false;
        }
      } else if (rowHasWindow) {
        return false;
      }
      const rowIndex = Number.isInteger(row?.row) ? row.row : null;
      if (startIndex != null && endIndex != null && rowIndex != null) {
        return rowIndex > startIndex && rowIndex <= endIndex;
      }
      const at = epochMs(row?.at ?? row?.captured_at ?? row?.to);
      return at != null && (startMs == null || at >= startMs) && (endMs == null || at <= endMs);
    });
  } catch {
    return null;
  }
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
    const loaded = opts.providers ?? loadProviders(home, { packaged: true });
    const providers = Array.isArray(loaded) ? loaded : loaded?.providers;
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

function substituteFollowUpArgv(cmdTemplate, { taskFile, cwd, sessionId, prompt }) {
  return cmdTemplate.map((arg) => String(arg)
    .replaceAll('{taskFile}', taskFile)
    .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
    .replaceAll('{cwd}', cwd)
    .replaceAll('{sessionId}', sessionId)
    .replaceAll('{prompt}', prompt));
}

function followUpArgv(connector, { taskFile, cwd, sessionId, prompt }) {
  const followUp = connector.conversation?.followUp;
  if (!Array.isArray(followUp?.cmd) || !followUp.cmd.length || !sessionId) return null;
  const argv = substituteFollowUpArgv(followUp.cmd, { taskFile, cwd, sessionId, prompt });
  const streamArgs = Array.isArray(followUp.eventStreamArgs)
    ? followUp.eventStreamArgs
    : (connector.eventStream?.args ?? []);
  return argv.concat(streamArgs.map(String));
}

function toolOrCommandEvent(event) {
  const kind = `${event?.kind ?? ''} ${event?.providerType ?? ''}`
    .toLowerCase().replace(/[_-]/g, ' ');
  return /\btool\b|\bcommand\b|\bfunction\b|\bshell\b/.test(kind);
}

function streamTextFor(obs, paths) {
  const file = obs?.streamFile ?? paths?.streamFile ?? null;
  if (file && existsSync(file)) {
    try { return readFileSync(file, 'utf8'); } catch { /* use captured transport below */ }
  }
  return [obs?.eventOutput, obs?.stdout, obs?.stderr].filter(Boolean).join('\n');
}

function decodedStreamLines(text) {
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(line);
    try {
      const row = JSON.parse(line);
      for (const value of [
        row?.summary,
        row?.text,
        row?.result,
        row?.message,
        row?.command,
        row?.item?.text,
        row?.item?.command,
        row?.content,
      ]) {
        if (typeof value === 'string') lines.push(...value.split(/\r?\n/));
      }
    } catch { /* plain transport line */ }
  }
  return lines;
}

function testSummaryFromStream(text) {
  const lines = decodedStreamLines(text);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+tests\b/i.test(trimmed)) {
      if (current.length) blocks.push(current);
      current = [trimmed];
      continue;
    }
    if (current.length && /^#\s+(?:pass|fail)\b/i.test(trimmed)) {
      current.push(trimmed);
      continue;
    }
    if (current.length && trimmed && !/^#\s+(?:skip|skipped|todo)\b/i.test(trimmed)) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks.at(-1)?.join('\n') ?? '';
}

function gitSummary(targetDir, command) {
  try {
    return execFileSync('git', command, {
      cwd: resolve(targetDir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch { return ''; }
}

function derivedReport(targetDir, obs, paths) {
  const status = gitSummary(targetDir, ['status', '--short']);
  const diffStat = gitSummary(targetDir, ['diff', '--stat']);
  const tests = testSummaryFromStream(streamTextFor(obs, paths));
  return [
    'Derived report: the worker ended without a final report, so Bullswarm reconstructed the durable workspace evidence.',
    '',
    'Workspace status:',
    status || '(no status output)',
    '',
    'Diff stat:',
    diffStat || '(no diff stat output)',
    '',
    'Test summary:',
    tests || '(no # tests/# pass/# fail block found in the captured stream)',
  ].join('\n');
}

function outputIsTruncated(output, eventTimeline) {
  if (typeof output !== 'string' || output.trim().length >= TRUNCATED_OUTPUT_MAX) return false;
  return Number(eventTimeline?.lastToolSequence ?? 0) > Number(eventTimeline?.lastResponseSequence ?? 0);
}

/**
 * Sibling of a `task-<id>.md` file. Workflow attempts and single tasks share
 * this name: `stream-<id>.jsonl`, `out-<id>.md`, `stdout-<id>.log`. A task
 * file that does not use the `task-` prefix returns null so a test that
 * writes a bare `task.md` does not grow extra capture files.
 */
export function artifactBesideTask(taskFile, kind, ext) {
  if (typeof taskFile !== 'string' || !taskFile) return null;
  const name = basename(taskFile);
  const trimmed = name.startsWith('task-') ? name.slice(5).replace(/\.[^.]+$/, '') : '';
  return trimmed ? join(dirname(taskFile), `${kind}-${trimmed}${ext}`) : null;
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
  const argv = opts.argv ?? argvWithModel(connector, {
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
    const mirrorsReply = (text) => mirrorsAgentReply(text, responseText);
    const errorChannelText = (full = false) => {
      if (!eventStreamed) return `${stdoutCapture.tail(4000)}\n${stderrCapture.tail(4000)}`.trim();
      return [
        stderrCapture.tail(4000),
        providerErrorRecords(
          full ? stdoutCapture.text() : stdoutCapture.tail(PROVIDER_ERROR_SCAN_CHARS),
          declaredFailureTypes,
          { agentText: responseText },
        ),
        providerRecords,
      ].filter(Boolean).join('\n');
    };
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
      // (2026-09-21: a report quoting `usage_credits_required` paused one).
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
        spawnError: true,
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
  // A provider error event is a machine record of a failure and counts as
  // error-shaped however it reads (auth-signatures.js A2); anything else must
  // look like a provider failure rather than report or source text.
  if (JSON_ERROR_EVENT_LINE.test(line)) return hit;
  return ERROR_SHAPED_LINE.test(line) ? hit : null;
}

/**
 * How much of the raw stdout an error-channel scan reads in the live path (the
 * verdict-time read uses the whole capture). A provider failure is at the
 * failure point, so the tail is where its record is.
 */
const PROVIDER_ERROR_SCAN_CHARS = 64 * 1024;
/** Longest single provider record kept as evidence. */
const ERROR_RECORD_MAX_CHARS = 4000;
/** Bound on the concatenated error channel. */
const ERROR_CHANNEL_MAX_CHARS = 8000;
/**
 * Characters compared to tell a provider's terminal record from the agent's
 * own reply it mirrors (Claude Code's `result` repeats the final message).
 */
const MIRRORED_REPLY_CHARS = 60;

function declaredFailureSet(declared) {
  return declared instanceof Set ? declared : new Set((declared ?? []).map(String));
}

/**
 * Does `text` open the same way as something the agent itself wrote? A
 * provider that mirrors the agent's final message into its terminal record
 * (Claude Code's `result`) is repeating the agent's own words, and the gate
 * must not be fooled by the copy. A genuine limit notice shares no opening.
 */
export function mirrorsAgentReply(text, agentText) {
  const head = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MIRRORED_REPLY_CHARS);
  return Boolean(head) && String(agentText ?? '').replace(/\s+/g, ' ').includes(head);
}

/**
 * A record type a CLI uses for its OWN summary of the finished turn: Claude
 * Code and Command Code write `result`, Codex writes `turn.completed`, grok
 * writes `end`. The agent's own events are `assistant` / `item.completed` /
 * `message_end` / `text`, never one of these — that separation is what makes
 * the record evidence and a reply not.
 */
const TERMINAL_RECORD_TYPE =
  /^(?:result|turn[._](?:completed|failed|end)|run[._](?:end|complete[d]?)|end|done)$/i;

/** Longest string leaf of a terminal record that still enters the channel. */
const TERMINAL_RECORD_MAX_STRINGS = 6;

/**
 * Keys whose values are identifiers or enums, never the provider's words. The
 * token itself is still available through the record's raw line.
 */
const RECORD_META_KEYS = new Set([
  'type', 'subtype', 'kind', 'status', 'level', 'severity', 'code', 'id', 'uuid',
  'model', 'sessionid', 'session_id', 'thread_id', 'requestid', 'request_id', 'timestamp', 'at',
]);

/** Bounded string leaves of a provider record, in order. */
function providerRecordStrings(value) {
  const out = [];
  const walk = (node, depth) => {
    if (out.length >= TERMINAL_RECORD_MAX_STRINGS || depth > 4) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text) out.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (RECORD_META_KEYS.has(key.toLowerCase())) continue;
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * Is this decoded JSONL line a record the PROVIDER flagged as its own failure?
 * Top-level markers only: an `error` field nested inside a tool result is the
 * tool talking, and an assistant message is never a provider failure record.
 */
export function isProviderErrorRecord(value, declared = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = typeof value.type === 'string' ? value.type : '';
  if (declaredFailureSet(declared).has(type)) return true;
  if (value.is_error === true || value.isError === true || value.status === 'error') return true;
  if (typeof value.subtype === 'string' && /error|fail/i.test(value.subtype)) return true;
  if (/^(?:error|error[._-]|stream[._-]error|turn[._-]failed)/i.test(type)) return true;
  return value.error != null && (typeof value.error === 'object' || typeof value.error === 'string');
}

/**
 * The records in `text` the provider itself wrote about this attempt: the
 * events it flags as errors and its terminal summary. Each is reduced to the
 * provider's own strings — so a pause records the sentence the provider wrote,
 * not a JSON blob — and a terminal record's strings that repeat the agent's
 * reply are dropped (the CLI mirrors the final message into `result`). Raw
 * error lines are kept as well, because an upstream body is a machine record
 * of a failure whatever it reads like. Only complete lines that parse as JSON
 * objects are read, so an agent's prose cannot enter the error channel (W7).
 */
export function providerErrorRecords(text, declared = [], { agentText = '' } = {}) {
  const types = declaredFailureSet(declared);
  const kept = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 2 || trimmed.length > ERROR_RECORD_MAX_CHARS || trimmed[0] !== '{') continue;
    let value;
    try { value = JSON.parse(trimmed); } catch { continue; }
    const failure = isProviderErrorRecord(value, types);
    if (!failure && !TERMINAL_RECORD_TYPE.test(typeof value?.type === 'string' ? value.type : '')) {
      continue;
    }
    // The raw record comes first for an error event: an upstream body is a
    // machine record of a failure, and the auth table is matched against it
    // (auth-signatures.js A1/A2). Its own strings follow, so a signature the
    // raw line cannot carry still has the provider's words to match.
    if (failure) kept.push(trimmed);
    for (const leaf of providerRecordStrings(value)) {
      if (!failure && mirrorsAgentReply(leaf, agentText)) continue;
      kept.push(leaf);
    }
  }
  return kept.join('\n').slice(-ERROR_CHANNEL_MAX_CHARS);
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
  //   a provider error event naming an upstream auth phrase -> fail + auth +
  //     quarantine hint (W6), unless the same event is really a usage limit:
  //     a throttle keeps its own kind and its real reset deadline (W5).
  //   a quota-shaped usage-limit line -> fail + quarantine until the reset
  //     (checked before auth: a throttle is not a broken credential).
  //   an error-shaped auth signature on the provider's error channel ->
  //     fail + quarantine hint (an agent's report ABOUT auth work is not
  //     evidence of provider auth health — W7).
  //   else content judge decides; exit code only modulates flags.
  // W7: every signature below is matched against the PROVIDER'S ERROR CHANNEL
  // — stderr, the provider's own error events and its terminal record — never
  // the assistant's reply, a tool result or the extracted answer.
  const errorChannel = obs.errorChannel ?? '';
  const fatalKind = obs.fatalSignature?.kind ?? null;
  const quotaFailure = fatalKind === 'quota'
    ? {
        signature: obs.fatalSignature.signature,
        line: obs.fatalSignature.line,
        context: obs.fatalSignature.context,
        transient: obs.fatalSignature.transient === true,
        waitMs: obs.fatalSignature.waitMs ?? null,
      }
    : fatalKind === null ? findQuotaFailure(connector, errorChannel, { now: endedAt }) : null;
  const authHit = fatalKind === 'auth'
    ? obs.fatalSignature.signature
    : quotaFailure ? null : matchLikelyAuthFailure(connector, errorChannel);
  // Read from the provider's error channel, and only once the provider itself
  // declared a stream failure: an upstream credential dies inside the error
  // event, where the semantic-output gates above can never see it (2026-09-11
  // — three pool names fronting one dead Relay OAuth pool, re-picked attempt
  // after attempt because a stream error carried no quarantine hint).
  const upstreamAuth = obs.providerFailureType
    ? findUpstreamAuthFailure(connector, errorChannel)
    : null;
  // Q7: with automatic pausing off no pool is paused, so no verdict asks for
  // one. The failure keeps an honest kind and the attempt still moves on —
  // an auth failure is then reported as the generic provider failure it also
  // is, a mechanical retry, rather than a bench.
  const pausing = opts.pausing ?? (home ? readPausing(home) : true);
  // quota.js Q6 — the one pause rule: the pool's own meter at >= 95% on a
  // running window, or a provider line that says a usage window is spent AND
  // names its reset. Every other limit notice is transient: retried, never a
  // pause. The decision (line, meter reading, reset) travels on the verdict
  // so the quarantine that records it can say why.
  const quotaPause = quotaFailure
    ? decideQuotaPause({
        connector,
        failure: quotaFailure,
        pool: poolName,
        bullswarmDir: home,
        now: endedAt,
        pausing,
      })
    : null;
  const quotaDeadline = quotaPause?.pause ? { until: quotaPause.until, source: quotaPause.rule } : null;

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
    // anything short enough to be a real signature. With pausing off the pool
    // is not benched, so the failure is reported as what it mechanically is.
    verdict = {
      ok: false,
      failureKind: pausing ? 'auth' : 'provider',
      ...(pausing ? { quarantineHint: true } : {}),
      why: `upstream auth failure: "${String(upstreamAuth.signature).slice(0, 110)}" (provider stream error)`
        + (pausing ? '' : ' · automatic pausing is off, pool not paused'),
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
  } else if (quotaFailure && !quotaPause.pause) {
    verdict = {
      ok: false,
      failureKind: 'throttle',
      throttleWaitMs: quotaFailure.waitMs ?? null,
      throttleRetrySamePool: quotaPause.retrySamePool,
      quotaPause,
      why: quotaPause.why,
    };
  } else if (quotaFailure) {
    verdict = {
      ok: false,
      failureKind: 'quota',
      quarantineHint: true,
      quarantineUntil: quotaDeadline.until,
      quarantineSource: quotaDeadline.source,
      quotaPause,
      why: quotaPause.why,
    };
  } else if (authHit) {
    verdict = {
      ok: false,
      why: `auth/throttle signature: "${authHit}"`
        + (pausing ? '' : ' · automatic pausing is off, pool not paused'),
      ...(pausing ? { quarantineHint: true } : { failureKind: 'provider' }),
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
      resetAtMs: quotaDeadline?.until ?? null,
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
    ...(outputTruncated ? { outputTruncated: true, outputSource } : {}),
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
