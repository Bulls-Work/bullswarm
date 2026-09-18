# First-class providers

Every directory here is a provider that always loads: `claude-code`, `codex`,
`grok`, and `echo`. `_schema.json` is the annotated pool template — it is not a
JSON Schema and nothing validates against it at runtime; it is the authoring
reference, and `bullswarm provider validate <dir|name>` is the checker.
Contributed providers live in [`providers/contrib/`](../../providers/contrib/README.md);
the field-by-field contract is
[docs/reference/providers.md](../../docs/reference/providers.md).

## `eventStream`: the declarative JSONL adapter

A connector whose CLI can stream machine-readable JSON declares the shape here
instead of adding code to core. `format: "jsonl"` turns the adapter on; `rules`
say which lines become which normalized events (`idPaths`, `kindPaths`,
`kindMap`, `summaryPaths`, `status`/`statusPath`/`statusMap`), `output` says
which line carries the final answer, and `args` are the flags that make the CLI
emit it. `src/lib/agent-events.js` applies those rules; provider quirks never
leave the manifest.

## `eventStream.capture`: how much of the stream is kept

Every attempt's decoded events are persisted to
`stream-<actionId>-attempt-<n>.jsonl` in the run directory — one JSON object
per line with `seq`, `at`, `source`, `providerType`, `kind`, `status`, and
`summary` — and the attempt record names the file. A connector with no
`eventStream` gets a bounded plain `stdout-<actionId>-attempt-<n>.log` instead.
The JSONL file is bounded as a head, one
`{"truncated":true,"dropped":<n>}` marker line, and a tail. The plain stdout
fallback is a marker-free bounded tail, because it has no JSON event structure.
The sink appends the head synchronously, then flushes the in-memory tail to a
sibling `.tail` segment every 32 events or 2 seconds, whichever comes first;
`close()` folds it into the final file. After a kernel `SIGKILL` the head is on
disk, the flushed `.tail` sibling is left as an orphan that nothing folds back
in, and the still-unflushed events are lost.

`capture` is optional and exists only to change the two byte budgets:

```json
"eventStream": {
  "format": "jsonl",
  "rules": [],
  "capture": {
    "responseBytes": 64000,
    "fileBytes": 1048576
  }
}
```

| key | default | what it bounds |
|---|---|---|
| `responseBytes` | `64000` | the text kept for one `response` event. The live pane still shows the 180-character summary; this is the durable copy |
| `fileBytes` | `1048576` | the whole `stream-…jsonl` (or `stdout-…log`) file |

The defaults are `DEFAULT_RESPONSE_BYTES` and `DEFAULT_FILE_BYTES` in
[`src/lib/attempt-stream.js`](../lib/attempt-stream.js). Omit the block and a
connector takes part with no code at all — set a key only when this CLI's
answers or event volume make the default the wrong size. Both values must be
positive integers; anything else, or an unknown key inside `capture`, fails
`bullswarm provider validate` with exit 2.

What the stream is used for: when a step's attempt fails and the next attempt
starts, the task it receives ends with a `## Prior attempt on this step` block
whose last three `response` events are read back out of this file. See
[docs/guide/observing.md](../../docs/guide/observing.md).
