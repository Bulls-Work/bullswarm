# Claude actual vs recorded cost — 2026-09-18

This audit compares the recorded Bullswarm estimate with the usage in the
Claude Code transcript selected by the attempt's time window. The recorded
values come from the attempt objects in the two `state.json` files below. The
actual values come from `scripts/cost-audit/claude-transcript-cost.mjs` run on
the matched transcript paths. No values below are inferred from the
human-readable duration in the task description. The attempt IDs, pool,
model, cwd, and time-window requirements are copied from
`/home/dev/.bullswarm/workflows/wf-mu6k5u8q-2b319f/task-claude-actual-cost-attempt-1.md`.

## Matching evidence

The transcript's first and last timestamps fall inside each recorded attempt
window. `lineCount` is the parent JSONL line count from the script output;
`sidechain raw/unique` is also from that output. No selected session had a
discovered `subagents/agent-*.jsonl` file or an `isSidechain` assistant row.

| Attempt (recorded state source) | Session ID; transcript path | Parent lines; first → last transcript timestamp | Sidechain raw / unique |
|---|---|---|---:|
| `fuyyca` `integrate-2` (`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json`) | `47b2c644-395f-40be-aef1-fba48f59da53`; `/home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-bullswarm-dashboard/47b2c644-395f-40be-aef1-fba48f59da53.jsonl` | `1,255`; `2026-09-17T20:40:01.927Z` → `2026-09-17T21:15:22.199Z` | `0 / 0` |
| `ipccf2` `accept-3` (`/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json`) | `fb6c9ea7-cc24-4e90-90f3-e3b6d5dec68a`; `/home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-project-a/fb6c9ea7-cc24-4e90-90f3-e3b6d5dec68a.jsonl` | `598`; `2026-09-17T18:21:16.833Z` → `2026-09-17T18:53:24.765Z` | `0 / 0` |
| `ipccf2` `accept-4` (`/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json`) | `04b1bcf6-87ef-4b8e-b62a-3322d16916db`; `/home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-project-a/04b1bcf6-87ef-4b8e-b62a-3322d16916db.jsonl` | `593`; `2026-09-17T19:24:21.887Z` → `2026-09-17T19:39:13.675Z` | `0 / 0` |

The matching command was a read-only recursive JSONL inventory over the two
project directories. The per-session values above are independently
reproduced by the script commands in the validation section.

## Pricing basis

The published Claude pricing page's exact model-pricing lines are:

> Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens
>
> Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok

The same page defines “MTok = Million tokens.” Source: [Claude Platform
pricing](https://platform.claude.com/docs/en/about-claude/pricing), model-pricing
table lines 57–65 and note at line 84 (retrieved 2026-09-18).

The calculation therefore uses:

```text
actual USD = (input × 5 + cache-write-5m × 6.25 + cache-write-1h × 10
             + cache-read × 0.50 + output × 25) / 1,000,000
```

The transcript exposes both aggregate `cache_creation_input_tokens` and the
nested 5m/1h split. All three selected sessions report `0` 5m and all their
cache-write tokens in the 1h bucket, so the 1h rate is used for those writes.

## Recorded estimate vs actual transcript

Recorded tokens are shown as `standardRead + output = totalKnown`; the state
objects report `cacheRead=null` and `cacheWrite=null` for all three attempts.
`tokenSource` is the literal state value `estimated:utf8-bytes/4`. Actual
classes and totals are from the script output; actual USD and the ratio are
from the arithmetic command shown below.

| Attempt / session | Recorded tokens; tokenSource; recorded USD | Actual input tokens [T] | Actual cache write tokens (5m / 1h) [T] | Actual cache-read tokens [T] | Actual output tokens [T] | Actual total tokens [T] | Actual USD [C] | Actual / recorded [C] |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `integrate-2` / `47b2c644-395f-40be-aef1-fba48f59da53` | `2,521 + 3,084 = 5,605`; `estimated:utf8-bytes/4`; `$0.089705` (state: `/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json`) | `432` | `0 / 276,924` | `34,530,500` | `100,225` | `34,908,081` | `$22.542275` | `251.29340616×` |
| `accept-3` / `fb6c9ea7-cc24-4e90-90f3-e3b6d5dec68a` | `2,528 + 160 = 2,688`; `estimated:utf8-bytes/4`; `$0.01664` (state: `/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json`) | `180` | `0 / 176,124` | `9,763,263` | `67,541` | `10,007,108` | `$8.3322965` | `500.73897236×` |
| `accept-4` / `04b1bcf6-87ef-4b8e-b62a-3322d16916db` | `2,748 + 215 = 2,963`; `estimated:utf8-bytes/4`; `$0.019115` (state: `/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json`) | `172` | `0 / 199,651` | `11,486,799` | `61,881` | `11,748,503` | `$9.2877945` | `485.89037405×` |

## Turns, tool calls, and sidechains

The script defines a turn as a unique assistant message after streaming
deduplication. Tool calls are unique `tool_use.id` values across all streaming
rows; `finalDedupedTotal` is the diagnostic count from only each retained last
assistant row. This distinction matters when one response contains multiple
tool blocks. These counters (`[T]`) are from the same three script outputs:

| Attempt | Unique turns (main / sidechain / total) | Tool calls (unique main / sidechain / total; final-row diagnostic) |
|---|---:|---:|
| `integrate-2` | `216 / 0 / 216` | `215 / 0 / 215; 215` |
| `accept-3` | `90 / 0 / 90` | `120 / 0 / 120; 89` |
| `accept-4` | `86 / 0 / 86` | `112 / 0 / 112; 85` |

## What drives the gap

The recorded estimate is a small UTF-8/4 fallback and explicitly has no cache
read or cache-write counters (`null`) in each attempt object. The transcript
has a large cache-read prefix on every turn: `34,530,500 / 216 =
159,863.425926` tokens per turn for `integrate-2`, `9,763,263 / 90 =
108,480.700000` for `accept-3`, and `11,486,799 / 86 = 133,567.430233` for
`accept-4`. At the published `$0.50 / MTok` cache-hit rate, those reads alone
cost `$17.26525000`, `$4.88163150`, and `$5.74339950`, respectively. In other
words, cache reads multiplied by turns dominate the actual cost; the 1h cache
writes and Opus output add the remainder. The ratios are therefore a
comparison of provider-reported transcript usage with a deliberately
under-specified local estimate, not a claim about the subscription debit.

## Implementation and evidence commands

The reusable script is [`scripts/cost-audit/claude-transcript-cost.mjs`](../../scripts/cost-audit/claude-transcript-cost.mjs), documented in
[`scripts/cost-audit/README.md`](https://github.com/Bulls-Work/bullswarm/blob/main/scripts/cost-audit/README.md).

Its dedupe and sidechain choices follow project-n's parser:

- `/home/dev/project-n/packages/parser/src/claude-code.ts:263-289`
  documents the shared `message.id:requestId` dedup identity and sums the four
  usage fields.
- `:293-323` shares that dedup set across the parent and its subagent files.
- `:415-425` locates the sibling `<session-id>/subagents` directory.

The recorded values were extracted with this read-only command (paths are the
sources for every recorded token and USD value in the table):

```sh
jq -r '.attempts[] | select(.id=="integrate-2") | ...' \
  /home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json
jq -r '.attempts[] | select(.id=="accept-3" or .id=="accept-4") | ...' \
  /home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json
```

The actual token values, session IDs, line counts, turns, tool calls, and
sidechain zeros (`[T]`) were produced by these exact commands:

```sh
node scripts/cost-audit/claude-transcript-cost.mjs \
  /home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-bullswarm-dashboard/47b2c644-395f-40be-aef1-fba48f59da53.jsonl \
  > /tmp/claude-integrate-2.json
node scripts/cost-audit/claude-transcript-cost.mjs \
  /home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-project-a/fb6c9ea7-cc24-4e90-90f3-e3b6d5dec68a.jsonl \
  > /tmp/claude-accept-3.json
node scripts/cost-audit/claude-transcript-cost.mjs \
  /home/dev/.claude-acme/projects/-home-dev-Repo-bullswork-project-a/04b1bcf6-87ef-4b8e-b62a-3322d16916db.jsonl \
  > /tmp/claude-accept-4.json
```

The USD and ratio columns (`[C]`) were calculated from those three JSON
outputs with the published rates above. The exact arithmetic command used the
token fields in `/tmp/claude-integrate-2.json`, `/tmp/claude-accept-3.json`,
and `/tmp/claude-accept-4.json`, plus the recorded USD values extracted from
the state files:

```sh
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const attempts = [
  ['integrate-2', '/tmp/claude-integrate-2.json', 0.089705],
  ['accept-3', '/tmp/claude-accept-3.json', 0.01664],
  ['accept-4', '/tmp/claude-accept-4.json', 0.019115],
];
const rates = { input_tokens: 5, cache_creation_5m_input_tokens: 6.25,
  cache_creation_1h_input_tokens: 10, cache_read_input_tokens: 0.5,
  output_tokens: 25 };
for (const [id, file, recordedUsd] of attempts) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = r.totals.total;
  const totalTokens = t.input_tokens + t.cache_creation_input_tokens
    + t.cache_read_input_tokens + t.output_tokens;
  const usd = (t.input_tokens * rates.input_tokens
    + t.cache_creation_5m_input_tokens * rates.cache_creation_5m_input_tokens
    + t.cache_creation_1h_input_tokens * rates.cache_creation_1h_input_tokens
    + t.cache_read_input_tokens * rates.cache_read_input_tokens
    + t.output_tokens * rates.output_tokens) / 1_000_000;
  console.log({ id, totalTokens, actualUsd: usd, ratio: usd / recordedUsd });
}
NODE
```
