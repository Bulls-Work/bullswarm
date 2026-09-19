#!/usr/bin/env node

/**
 * Sum Claude Code transcript usage without dependencies.
 *
 * The input is a parent session .jsonl file.  If Claude Code wrote
 * sibling subagent transcripts, <session-id>/subagents/agent-*.jsonl files
 * are included automatically and are reported as sidechain usage.
 */

import fs from "node:fs";
import path from "node:path";

const USAGE_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "cache_creation_5m_input_tokens",
  "cache_creation_1h_input_tokens",
];

function usageBlank() {
  return Object.fromEntries([
    ["messages", 0],
    ["tool_calls", 0],
    ...USAGE_FIELDS.map((field) => [field, 0]),
  ]);
}

function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) target[field] += number(usage?.[field]);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function sessionIdFromPath(filePath) {
  return path.basename(filePath).replace(/\.jsonl$/i, "");
}

function readJsonl(filePath, kind) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const assistant = [];
  let malformedLines = 0;
  let firstTimestamp;
  let lastTimestamp;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    let row;
    try {
      row = JSON.parse(lines[lineNumber]);
    } catch {
      malformedLines += 1;
      continue;
    }

    if (typeof row.timestamp === "string") {
      if (!firstTimestamp || row.timestamp < firstTimestamp) firstTimestamp = row.timestamp;
      if (!lastTimestamp || row.timestamp > lastTimestamp) lastTimestamp = row.timestamp;
    }
    if (row.type !== "assistant" || !row.message || typeof row.message !== "object") continue;

    const message = row.message;
    const messageId = typeof message.id === "string" ? message.id : null;
    const requestId = typeof row.requestId === "string" ? row.requestId : null;
    // project-n uses the same message.id:requestId identity across parent
    // and subagent files.  A missing id cannot be safely deduped, so retain
    // that physical line as a distinct message.
    const key = messageId
      ? `${messageId}:${requestId ?? ""}`
      : `${filePath}:line-${lineNumber + 1}`;
    assistant.push({
      key,
      filePath,
      lineNumber: lineNumber + 1,
      kind,
      row,
      message,
    });
  }

  return {
    filePath,
    kind,
    lineCount: lines.length,
    malformedLines,
    assistantRawCount: assistant.length,
    firstTimestamp,
    lastTimestamp,
    assistant,
  };
}

function sidechainFiles(parentPath) {
  const sessionDir = path.join(path.dirname(parentPath), sessionIdFromPath(parentPath), "subagents");
  if (!fs.existsSync(sessionDir)) return [];
  return fs.readdirSync(sessionDir)
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(sessionDir, name));
}

function toolBlocks(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((block) => block && block.type === "tool_use")
    : [];
}

function modelBucket(models, modelName) {
  if (!models[modelName]) {
    models[modelName] = {
      main: usageBlank(),
      sidechain: usageBlank(),
      total: usageBlank(),
    };
  }
  return models[modelName];
}

function report(inputPath) {
  const parentPath = path.resolve(inputPath);
  if (!fs.statSync(parentPath).isFile()) throw new Error(`not a file: ${parentPath}`);

  const files = [
    readJsonl(parentPath, "main"),
    ...sidechainFiles(parentPath).map((filePath) => readJsonl(filePath, "sidechain")),
  ];

  // Map assignment deliberately keeps the last streaming row for each
  // message.id:requestId, as required for final usage state.
  const deduped = new Map();
  for (const file of files) {
    for (const entry of file.assistant) {
      deduped.set(entry.key, entry);
    }
  }

  // Tool-use blocks can arrive in earlier streaming rows and disappear from
  // the final row. Count each tool_use id once across all rows, while usage
  // remains strictly last-row/deduped.
  const toolUses = new Map();
  const anonymousToolUses = [];
  for (const file of files) {
    for (const entry of file.assistant) {
      for (const block of toolBlocks(entry.message)) {
        const sidechain = entry.kind === "sidechain" || entry.row.isSidechain === true;
        const model = typeof entry.message.model === "string" && entry.message.model.length > 0
          ? entry.message.model
          : "unknown";
        const record = { model, bucket: sidechain ? "sidechain" : "main" };
        if (typeof block.id === "string" && block.id.length > 0) toolUses.set(block.id, record);
        else anonymousToolUses.push(record);
      }
    }
  }

  const models = {};
  const totals = { main: usageBlank(), sidechain: usageBlank(), total: usageBlank() };
  let mainTurns = 0;
  let sidechainTurns = 0;
  let uniqueSidechainMessages = 0;
  for (const { row, message, kind } of deduped.values()) {
    const sidechain = kind === "sidechain" || row.isSidechain === true;
    const bucketName = sidechain ? "sidechain" : "main";
    const modelName = typeof message.model === "string" && message.model.length > 0
      ? message.model
      : "unknown";
    const usage = {
      input_tokens: number(message.usage?.input_tokens),
      cache_creation_input_tokens: number(message.usage?.cache_creation_input_tokens),
      cache_read_input_tokens: number(message.usage?.cache_read_input_tokens),
      output_tokens: number(message.usage?.output_tokens),
      cache_creation_5m_input_tokens: number(message.usage?.cache_creation?.ephemeral_5m_input_tokens),
      cache_creation_1h_input_tokens: number(message.usage?.cache_creation?.ephemeral_1h_input_tokens),
    };
    const model = modelBucket(models, modelName);
    model[bucketName].messages += 1;
    addUsage(model[bucketName], usage);
    model.total.messages += 1;
    addUsage(model.total, usage);
    totals[bucketName].messages += 1;
    addUsage(totals[bucketName], usage);
    totals.total.messages += 1;
    addUsage(totals.total, usage);
    if (sidechain) {
      sidechainTurns += 1;
      uniqueSidechainMessages += 1;
    } else {
      mainTurns += 1;
    }
  }

  // Tool calls are counted from unique tool_use ids across all streaming rows;
  // this preserves calls whose block was only present in an intermediate row.
  for (const record of [...toolUses.values(), ...anonymousToolUses]) {
    totals[record.bucket].tool_calls += 1;
    totals.total.tool_calls += 1;
    modelBucket(models, record.model)[record.bucket].tool_calls += 1;
    modelBucket(models, record.model).total.tool_calls += 1;
  }
  const finalToolCounts = { main: 0, sidechain: 0 };
  for (const { row, message, kind } of deduped.values()) {
    const bucket = kind === "sidechain" || row.isSidechain === true ? "sidechain" : "main";
    finalToolCounts[bucket] += toolBlocks(message).length;
  }
  const fileReport = files.map((file) => ({
    path: file.filePath,
    kind: file.kind,
    lineCount: file.lineCount,
    assistantRawCount: file.assistantRawCount,
    malformedLines: file.malformedLines,
    firstTimestamp: file.firstTimestamp ?? null,
    lastTimestamp: file.lastTimestamp ?? null,
  }));

  return {
    path: parentPath,
    sessionId: sessionIdFromPath(parentPath),
    lineCount: files[0].lineCount,
    firstTimestamp: files[0].firstTimestamp ?? null,
    lastTimestamp: files[0].lastTimestamp ?? null,
    files: fileReport,
    assistantMessages: {
      raw: files.reduce((sum, file) => sum + file.assistantRawCount, 0),
      unique: deduped.size,
      sidechainRaw: files.filter((file) => file.kind === "sidechain")
        .reduce((sum, file) => sum + file.assistantRawCount, 0)
        + files[0].assistant.filter((entry) => entry.row.isSidechain === true).length,
      sidechainUnique: uniqueSidechainMessages,
    },
    turns: { main: mainTurns, sidechain: sidechainTurns, total: mainTurns + sidechainTurns },
    toolCalls: {
      main: totals.main.tool_calls,
      sidechain: totals.sidechain.tool_calls,
      total: totals.total.tool_calls,
      finalDedupedTotal: finalToolCounts.main + finalToolCounts.sidechain,
      finalDedupedMain: finalToolCounts.main,
      finalDedupedSidechain: finalToolCounts.sidechain,
    },
    models,
    totals,
  };
}

function usage() {
  const command = path.basename(process.argv[1] ?? "claude-transcript-cost.mjs");
  console.error(`Usage: node ${command} <transcript.jsonl>`);
  process.exit(2);
}

const input = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (!input || process.argv.includes("--help") || process.argv.includes("-h")) usage();

try {
  console.log(JSON.stringify(report(input), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
