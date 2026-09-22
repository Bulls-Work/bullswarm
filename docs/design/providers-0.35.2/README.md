# Bullswarm 0.35.2 provider-history design record

This record is the documentation companion to the 0.35.2 provider work. It
preserves what the real stores proved on 2026-09-20 and separates recoverable
history from records that do not exist. The study counted 594 attempts in the
supplied snapshot: 478 on `opencode2*` pools and 116 on `command-code`.

## 1. Evidence boundary

The source data was read-only:

- OpenCode's store was `/home/dev/.local/share/opencode/opencode.db`, a
  3.3 GB WAL-mode SQLite database. It was opened in place with Node 22's
  `node:sqlite`; it was not copied or modified.
- Command Code's store was `~/.commandcode/projects`. The study inspected 751
  UUID-named conversation files and found 7,347 usage objects across the real
  store. The 116 supplied Bullswarm attempts, however, map to 27 project-slug
  directories containing 112 checkpoint files and no usage-bearing session
  transcript for those attempts.
- The supplied workflow snapshot had 131 JSONL files and zero
  `stream-*.jsonl` files. Workflow events and `lastAgentEvent` summaries name
  the provider and model but do not carry token usage.

That snapshot absence was an evidence limit, not evidence that the CLIs' own
streams carry no usage: direct 2026-09-20 captures of `opencode run --format
json` and `command-code -p --output-format json` (checked in as
`tests/fixtures/streams/opencode-hello.jsonl` and
`tests/fixtures/streams/command-code-hello.jsonl`) do carry token counters, and
both contrib connectors now declare `eventStream.usage` rules against them.

## 2. What each store contains

### OpenCode SQLite

The relevant tables are `session`, `message`, and `part`:

- `session.directory` is the attempt cwd; `time_created` and `time_updated`
  bracket the session. The row also carries the model, aggregate token
  columns, and provider-reported cost. In the representative mapping, the
  session started 2.520 seconds after the attempt and ended 56 ms before it.
- Assistant `message.data` is JSON containing `tokens.input`,
  `tokens.output`, `tokens.reasoning`, `tokens.cache.read`,
  `tokens.cache.write`, `modelID`, `providerID`, `path.cwd`, and created/
  completed timestamps. Session aggregate token columns equal the assistant
  message sums.
- `part` rows are not required for token totals. The first user part is useful
  for identity, but in the real mapping it contained only the task-file path,
  not the complete task-file text; a later tool-result part contained the
  text after OpenCode read the file.

The query used to re-derive one real session was:

```sql
SELECT
  SUM(COALESCE(json_extract(data, '$.tokens.input'), 0)) AS standardRead,
  SUM(COALESCE(json_extract(data, '$.tokens.cache.read'), 0)) AS cacheRead,
  SUM(COALESCE(json_extract(data, '$.tokens.cache.write'), 0)) AS cacheWrite,
  SUM(COALESCE(json_extract(data, '$.tokens.output'), 0)) AS output,
  SUM(COALESCE(json_extract(data, '$.tokens.reasoning'), 0)) AS reasoning,
  MIN(json_extract(data, '$.modelID')) AS modelID,
  MIN(json_extract(data, '$.providerID')) AS providerID,
  MIN(json_extract(data, '$.path.cwd')) AS cwd,
  MIN(COALESCE(json_extract(data, '$.time.created'), time_created)) AS firstAt,
  MAX(COALESCE(
    json_extract(data, '$.time.completed'),
    time_updated,
    time_created
  )) AS lastAt
FROM message
WHERE session_id = ?
  AND json_extract(data, '$.role') = 'assistant';
```

For the observed `wf-mthe1rm0-364da1` mapping the query returned
`standardRead 368554`, `cacheRead 1597440`, `cacheWrite 0`, `output 6104`,
`reasoning 2214`, model `gpt-5.6-luna`, provider `orbit`, cwd
`/home/dev/Repo/bullswarm`, and the attempt's first/last message times.

The reader therefore matches by exact cwd and the inclusive attempt window,
then uses the first user part's task path/text when several sessions fit. One
candidate is a window match; multiple candidates stay ambiguous with null
tokens; no candidate stays `none`. A recorded session ID is an exact match.

### Command Code JSONL

The durable conversation shape is
`~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl`. The slug is made by
lowercasing the absolute cwd, replacing runs of non-alphanumeric characters
with `-`, and trimming the ends. Files contain `session`, `session_info`, and
`message` records (and, in the wider store, model/effort/compaction records).
Assistant message records can contain model plus:
`usage.inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and
`costUsd`. One real assistant row contained:

```json
{"usage":{"inputTokens":16801,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":16798,"costUsd":0.0042061},"model":"gpt-5.6-luna"}
```

`inputTokens` is inclusive, so the exclusive fresh-input class is
`inputTokens - cacheReadTokens - cacheWriteTokens`. `sessions/` hook logs
record hook activity, not conversation usage; `history.jsonl` is prompt
recall without a session ID, model, or usage ledger.

The current connector passes `--no-session`. That explains why every one of
the 116 historical Command Code attempts has checkpoints but no matching
usage-bearing `<session-id>.jsonl`. The reader can recover a future attempt
only when session persistence produces a matching JSONL file; otherwise it
returns null usage with `reason: "no matching command-code transcript"`. A
matching file with no usage rows is also explicit:
`reason: "command-code transcripts record no token usage"`.

## 3. Recovery policy

The complete operator-facing matrix is in
[Cost and usage](../../guide/cost.md#durable-history-recovery-matrix). In
short:

- OpenCode `opencode2*` and account pools can recover from SQLite sessions
  when cwd/time matching is unique.
- Command Code can recover from a persisted usage-bearing JSONL session, but
  the supplied `--no-session` attempts cannot be reconstructed from
  checkpoints, hook logs, or history.
- Grok attempts before 2026-09-14 cannot be recovered from supported durable
  history; later attempts still require a matching transcript.
- Any pool with no transcript (or an ambiguous match) remains `unknown`.
  Unknown is never a zero-dollar claim.

## 4. Models and price evidence

The model counts and public-card findings from the snapshot are:

| Pool/model observed | Attempts | Price evidence as of 2026-09-20 |
|---|---:|---|
| `opencode2`: `orbit/gpt-5.6-luna` | 244 | No public price card for the `orbit` relay. The underlying OpenAI card lists $0.20/M fresh input, $0.02/M cached input, $0.25/M cache writes, and $1.20/M output, but those rates are **not** assigned to an unidentified relay. [OpenAI GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |
| `opencode2`: `opencode/union-alpha` | 4 | No public price card located for this identifier; API cost stays unknown. |
| `opencode2:orbit-2`: `orbit-2/gpt-5.6-luna` | 117 | No public `orbit-2` relay card; do not substitute the underlying OpenAI card. |
| `opencode2:orbit-3`: `orbit-3/gpt-5.6-luna` | 112 | No public `orbit-3` relay card; do not substitute the underlying OpenAI card. |
| `opencode2:orbit-3`: `orbit/gpt-5.6-luna` | 1 | No public `orbit` relay card. |
| `command-code`: `deepseek/deepseek-v4.1-flash` | 69 | Command Code card: off-peak $0.15/M input, $0.003/M cache read, $0.60/M output; peak weekday windows are $0.30/M input and $1.20/M output. [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) |
| `command-code`: `gpt-5.6-luna` | 44 | Command Code card: $0.20/M input, $0.02/M cache read, $0.25/M cache write, $1.20/M output. [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) |
| `command-code`: `meta/muse-spark-1.3-contributor` | 3 | Command Code card: $0.10/M input, $0.002/M cache read, $0.20/M output. [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) |

The observed Command Code models are not free-tier models. A free model is
priced at `$0` only when the cited card says it is free; a provider's general
free tier never turns an unpriced or relayed model into zero.

The linked public cards and the absence checks in this table were verified on
2026-09-20. A later rate-card change needs a new dated observation before an
API figure is applied.

## 5. Registry contract

The provider loader already exposes `providerFor(providers, pool)` and
`transcriptReaderFor(providers, pool)`. The 0.35.2 integration routes
`src/lib/transcripts/index.js` and `workflow reprice` through those helpers;
the watcher already follows the same provider-owned path. This removes the
old hard-coded Claude/Codex/Grok reader list while retaining those readers'
behaviour byte-for-byte. Each provider can supply its own index and matching
rules, so `opencode2*`, `opencode2:orbit-*`, and `command-code` are resolved by
the provider that actually owns the pool.

The accounting fallback remains ordered and explicit:

```text
provider-reported > transcript-summed > estimated:utf8-bytes/4 > unknown
```

Both contrib connectors add `eventStream.usage` rules to that ladder: their
2026-09-20 live captures
(`tests/fixtures/streams/opencode-hello.jsonl` and
`tests/fixtures/streams/command-code-hello.jsonl`) carry token counters, so a
live value is provider-reported before either durable reader is consulted.
