# Claude transcript cost audit

`claude-transcript-cost.mjs` is a dependency-free Node script for measuring
the token usage recorded in a Claude Code JSONL transcript.

```sh
node scripts/cost-audit/claude-transcript-cost.mjs \
  <claude-config-dir>/projects/<project-slug>/<session-id>.jsonl
```

The output is JSON. The parent file is always included. If Claude Code has a
`<session-id>/subagents/agent-*.jsonl` directory beside it, those files are
included automatically and reported as `sidechain` files. This makes the
`totals.main`, `totals.sidechain`, and `totals.total` buckets directly usable
for pricing. `models` repeats the same buckets per model.

## Counting rules

- Only `type: "assistant"` rows contribute token usage.
- Streaming rows are deduplicated by `message.id:requestId`; the last row
  wins. This follows project-n's documented identity and usage rule in
  `project-n/packages/parser/src/claude-code.ts:263-289`.
  Rows without a message id remain distinct physical lines.
- A row from a discovered `subagents/` file, or a row with
  `isSidechain: true`, is sidechain usage. The sidechain usage is included in
  the total as well as shown separately, following the parent-plus-subagent
  traversal in
  `project-n/packages/parser/src/claude-code.ts:293-323` and
  its sibling `subagents` layout at lines `415-425`.
- `turns` is the number of unique assistant messages after deduplication.
- `toolCalls.total` counts each unique `tool_use.id` across all streaming
  rows. `toolCalls.finalDedupedTotal` is a diagnostic count from only the
  retained last row for each assistant message; it can be lower when one API
  response streamed multiple tool blocks.
- The four required token fields are `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, and
  `output_tokens`. The output also exposes nested five-minute and one-hour
  cache-write totals so a price calculation can select the correct published
  rate.

The script does not infer pricing or subscription debits. Price the JSON
totals with a dated rate card and keep the rate source beside the calculation.
