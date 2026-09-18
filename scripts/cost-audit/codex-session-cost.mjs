#!/usr/bin/env node

/**
 * Read Codex rollout JSONL files without dependencies.
 *
 * Codex writes cumulative usage in event_msg/token_count events.  The final
 * total_token_usage object is therefore the session total; token_count events
 * must not be summed.  `turns` is the number of unique root turn IDs in the
 * token_usage_record events.  The user-message counters are diagnostics for
 * rollouts whose prompt envelopes are response_item/message records.
 */

import fs from "node:fs";
import path from "node:path";

const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function blankUsage() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function parseRollout(inputPath) {
  const filePath = path.resolve(inputPath);
  if (!fs.statSync(filePath).isFile()) throw new Error(`not a file: ${filePath}`);

  const rows = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const usage = blankUsage();
  const rootTurnIds = new Set();
  const turnIds = new Set();
  let sessionMeta = {};
  let model = null;
  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let tokenCountEvents = 0;
  let eventMessageUserCount = 0;
  let responseItemUserCount = 0;
  let malformedLines = 0;
  let nonEmptyLines = 0;
  let taskStartedEvents = 0;

  for (const line of rows) {
    if (!line.trim()) continue;
    nonEmptyLines += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    if (typeof row.timestamp === "string") {
      if (!firstTimestamp || row.timestamp < firstTimestamp) firstTimestamp = row.timestamp;
      if (!lastTimestamp || row.timestamp > lastTimestamp) lastTimestamp = row.timestamp;
    }

    if (row.type === "session_meta" && row.payload && typeof row.payload === "object") {
      sessionMeta = row.payload;
      if (typeof row.payload.cwd === "string") cwd = row.payload.cwd;
    }
    if (row.type === "turn_context" && row.payload && typeof row.payload === "object") {
      if (typeof row.payload.model === "string") model = row.payload.model;
      if (typeof row.payload.cwd === "string") cwd = row.payload.cwd;
    }
    if (row.type === "event_msg" && row.payload?.type === "task_started") taskStartedEvents += 1;
    if (row.type === "event_msg" && row.payload?.type === "user_message") {
      eventMessageUserCount += 1;
    }
    if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      responseItemUserCount += 1;
    }
    if (row.type === "token_usage_record") {
      const payload = row.payload;
      if (typeof payload?.turn_id === "string") turnIds.add(payload.turn_id);
      if (typeof payload?.root_turn_id === "string") rootTurnIds.add(payload.root_turn_id);
    }
    if (row.type !== "event_msg" || row.payload?.type !== "token_count") continue;

    tokenCountEvents += 1;
    const total = row.payload?.info?.total_token_usage;
    if (!total || typeof total !== "object") continue;
    for (const field of TOKEN_FIELDS) {
      if (typeof total[field] === "number" && Number.isFinite(total[field])) {
        usage[field] = total[field];
      }
    }
  }

  // Current rollouts carry one root turn ID.  The fallback keeps older files
  // useful when they have task_started but no token_usage_record event.
  const turns = rootTurnIds.size || turnIds.size || taskStartedEvents;
  return {
    path: filePath,
    sessionId: typeof sessionMeta.session_id === "string" ? sessionMeta.session_id : null,
    model,
    cwd,
    firstTimestamp,
    lastTimestamp,
    lineCount: nonEmptyLines,
    malformedLines,
    tokenCountEvents,
    turns,
    uniqueTurnIds: turnIds.size,
    uniqueRootTurnIds: rootTurnIds.size,
    userMessages: {
      eventMsg: eventMessageUserCount,
      responseItems: responseItemUserCount,
      total: eventMessageUserCount + responseItemUserCount,
    },
    finalCumulativeTotals: usage,
  };
}

function usage() {
  const command = path.basename(process.argv[1] ?? "codex-session-cost.mjs");
  console.error(`Usage: node ${command} <rollout.jsonl> [rollout.jsonl ...]`);
  process.exit(2);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const inputs = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (inputs.length === 0) usage();

try {
  const sessions = inputs.map(parseRollout);
  console.log(JSON.stringify(sessions.length === 1 ? sessions[0] : { sessions }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
