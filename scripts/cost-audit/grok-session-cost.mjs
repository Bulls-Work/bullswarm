#!/usr/bin/env node

/**
 * Measure one Grok CLI session from ~/.grok/logs/unified.jsonl.
 *
 * The Grok CLI writes per-inference prompt, cache, completion, and reasoning
 * counts to shell.turn.inference_done records.  This script sums those
 * per-request records for one sid, while reading the session's durable
 * events.jsonl/summary.json when --session-dir is supplied.  It also reports
 * a token-rate API-equivalent cost using the xAI Grok 4.6 rate card; this is
 * not a claim about a Grok Build subscription debit.
 */

import fs from "node:fs";
import path from "node:path";

const LONG_CONTEXT_THRESHOLD = 200_000;
const RATES = {
  short: { input: 2, cached: 0.5, completion: 6, reasoning: 6 },
  long: { input: 4, cached: 1, completion: 12, reasoning: 12 },
};

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function bucketBlank() {
  return { requests: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0, apiEquivalentUsd: 0 };
}

function addInference(bucket, ctx) {
  const promptTokens = number(ctx.prompt_tokens);
  const cachedPromptTokens = Math.min(promptTokens, number(ctx.cached_prompt_tokens));
  const completionTokens = number(ctx.completion_tokens);
  const reasoningTokens = number(ctx.reasoning_tokens);
  const rate = RATES[bucket.name];
  bucket.requests += 1;
  bucket.promptTokens += promptTokens;
  bucket.cachedPromptTokens += cachedPromptTokens;
  bucket.completionTokens += completionTokens;
  bucket.reasoningTokens += reasoningTokens;
  bucket.apiEquivalentUsd += (
    (promptTokens - cachedPromptTokens) * rate.input
    + cachedPromptTokens * rate.cached
    + completionTokens * rate.completion
    + reasoningTokens * rate.reasoning
  ) / 1_000_000;
}

function readJsonl(filePath, onRow) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let malformedLines = 0;
  let nonEmptyLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmptyLines += 1;
    try {
      onRow(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }
  return { lineCount: nonEmptyLines, malformedLines };
}

function sessionDetails(sessionDir) {
  if (!sessionDir) return { turns: null, inferenceLoops: null, summary: null };
  const details = { turns: 0, inferenceLoops: 0, summary: null };
  const eventsPath = path.join(sessionDir, "events.jsonl");
  if (fs.existsSync(eventsPath)) {
    readJsonl(eventsPath, (row) => {
      if (row.type === "turn_started") details.turns += 1;
      if (row.type === "loop_started") details.inferenceLoops += 1;
    });
  }
  const summaryPath = path.join(sessionDir, "summary.json");
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    details.summary = {
      cwd: summary.info?.cwd ?? null,
      createdAt: summary.created_at ?? null,
      updatedAt: summary.updated_at ?? null,
      currentModel: summary.current_model_id ?? null,
      sessionKind: summary.session_kind ?? null,
      messageCount: summary.num_messages ?? null,
      chatMessageCount: summary.num_chat_messages ?? null,
    };
  }
  return details;
}

function report(logPath, sessionId, sessionDir) {
  const sourcePath = path.resolve(logPath);
  if (!fs.statSync(sourcePath).isFile()) throw new Error(`not a file: ${sourcePath}`);
  if (!sessionId) throw new Error("missing --session-id");

  const short = { name: "short", ...bucketBlank() };
  const long = { name: "long", ...bucketBlank() };
  const inferences = [];
  const meta = { model: null, cwd: null, firstTimestamp: null, lastTimestamp: null };
  const fileStats = readJsonl(sourcePath, (row) => {
    if (row.sid !== sessionId) return;
    if (typeof row.ts === "string") {
      if (!meta.firstTimestamp || row.ts < meta.firstTimestamp) meta.firstTimestamp = row.ts;
      if (!meta.lastTimestamp || row.ts > meta.lastTimestamp) meta.lastTimestamp = row.ts;
    }
    if (row.msg === "session created") meta.cwd = row.ctx?.cwd ?? meta.cwd;
    if (row.msg === "model changed") meta.model = row.ctx?.model ?? meta.model;
    if (row.msg !== "shell.turn.inference_done" || !row.ctx) return;
    const ctx = row.ctx;
    const name = number(ctx.prompt_tokens) >= LONG_CONTEXT_THRESHOLD ? "long" : "short";
    addInference(name === "long" ? long : short, { ...ctx });
    inferences.push({
      loopIndex: ctx.loop_index ?? null,
      promptTokens: number(ctx.prompt_tokens),
      cachedPromptTokens: Math.min(number(ctx.prompt_tokens), number(ctx.cached_prompt_tokens)),
      completionTokens: number(ctx.completion_tokens),
      reasoningTokens: number(ctx.reasoning_tokens),
    });
  });

  if (inferences.length === 0) throw new Error(`no inference records for session ${sessionId}`);
  const total = [short, long].reduce((out, bucket) => {
    for (const key of ["requests", "promptTokens", "cachedPromptTokens", "completionTokens", "reasoningTokens", "apiEquivalentUsd"]) {
      out[key] += bucket[key];
    }
    return out;
  }, bucketBlank());
  const details = sessionDetails(sessionDir ? path.resolve(sessionDir) : null);
  return {
    logPath: sourcePath,
    sessionId,
    model: meta.model ?? details.summary?.currentModel ?? null,
    cwd: meta.cwd ?? details.summary?.cwd ?? null,
    firstTimestamp: meta.firstTimestamp,
    lastTimestamp: meta.lastTimestamp,
    log: fileStats,
    turns: details.turns,
    inferenceLoops: details.inferenceLoops ?? inferences.length,
    usage: {
      promptTokens: total.promptTokens,
      cachedPromptTokens: total.cachedPromptTokens,
      uncachedPromptTokens: total.promptTokens - total.cachedPromptTokens,
      completionTokens: total.completionTokens,
      reasoningTokens: total.reasoningTokens,
      totalBilledTokens: total.promptTokens + total.completionTokens + total.reasoningTokens,
      inferenceRecords: total.requests,
    },
    contextBuckets: { short, long },
    apiEquivalentUsd: total.apiEquivalentUsd,
    pricingBasis: {
      vendor: "xAI",
      model: "grok-4.6",
      shortContextThresholdTokens: LONG_CONTEXT_THRESHOLD,
      shortRatesUsdPerMillion: RATES.short,
      longRatesUsdPerMillion: RATES.long,
      reasoningChargedAtCompletionRate: true,
      subscriptionDebitMeasured: false,
    },
    session: details.summary,
  };
}

function usage() {
  const command = path.basename(process.argv[1] ?? "grok-session-cost.mjs");
  console.error(`Usage: node ${command} --log <unified.jsonl> --session-id <sid> [--session-dir <dir>]`);
  process.exit(2);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const logPath = option("--log");
const sessionId = option("--session-id");
const sessionDir = option("--session-dir");
if (!logPath || !sessionId) usage();

try {
  console.log(JSON.stringify(report(logPath, sessionId, sessionDir), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
