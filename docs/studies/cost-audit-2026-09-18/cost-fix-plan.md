# Run wf-mu6k5u8q-2b319f — 2026-09-18

# Cost fix plan — measured usage instead of estimated

Read-only. No file in `/home/dev/Repo/bullswork/bullswarm-cost` was modified, no commit made. Everything below was verified against source and live state in this worktree today; the per-attempt gap figures come from the dependency audits and are attributed.

---

## 1. Judgement: how far off is the recorded API≈

**Off by two to three orders of magnitude, in the same direction on every provider.** The recorded number is smaller than the real one every time, never larger.

| Provider / attempt | Recorded | Measured (published rates) | Ratio |
|---|---:|---:|---:|
| Claude Opus 5 · `integrate-2` | $0.089705 | $22.542275 (34,908,081 tok) | **251×** |
| Claude Opus 5 · `accept-3` | $0.01664 | $8.3322965 (10,007,108 tok) | **501×** |
| Claude Opus 5 · `accept-4` | $0.019115 | $9.2877945 (11,748,503 tok) | **486×** |
| Grok 4.6 · `verify-1` | $0.009668 | $7.783282 (9,400,999 tok) | **805×** |
| GPT-5.6 Luna · `widget-1` | $0.0006554 | $0.96434956 (37,677,530 tok) | **1,471×** |
| GPT-5.6 Sol · `integrate-1` | $0.016424 | $4.5087544 (8,853,907 tok) | **275×** |

(Source: `docs/studies/cost-audit-2026-09-18/claude-actual-vs-recorded.md` and `grok-codex-actual-vs-recorded.md`, with the readers under `scripts/cost-audit/`.)

### The two mechanisms, both of which I re-proved here

**Cause 1 — the byte fallback cannot see the cost.** `src/lib/usage.js:94-106` estimates `standardRead` from the task text and `output` from the answer at `Buffer.byteLength/4` (`src/lib/usage.js:14-17`), and leaves `cacheRead`/`cacheWrite` at `null`. Cache reads are the entire bill: 34.5M cache-read tokens on `integrate-2` alone price to $17.27 of its $22.54. A one-page task prompt can never estimate a 216-turn conversation whose prefix is re-read every turn.

**Cause 2 — `provider-reported` is an accident, and when it fires it is wrong.** It fires only when a connector's extraction falls back to raw stdout (`src/lib/watch.js:357-361`) and token-shaped text happens to survive. I ran the real parser on a real captured Claude `result` event from `/home/dev/.bullswarm/workflows/wf-mtcof6lr-187c3e/out-orchestrator-mtcof6mi.json`:

```
truth in that event:  input 2 · cache-write 30,253 · cache-read 0 · output 176 · total_cost_usd 0.61388
parseReportedUsage(): input 6 · cache-write 90,759 · cache-read 0 · output 528
```

Exactly **3× on every field** — `lastCounter` (`src/lib/usage.js:19-31`) sums each alias across the whole text, so `usage.*`, the nested `usage.iterations[]`, and the camelCase `modelUsage.*` are all added together. And the provider's own `$0.61388` is sitting three bytes away in the same object, unread.

**Cause 2b — cache writes cost nothing.** Priced against the real Opus profile:

```
tokens    {"standardRead":2,"cacheRead":0,"cacheWrite":30253,"output":176,"totalKnown":30431}
breakdown {"standardReadUsd":0.00001,"cacheReadUsd":0,"cacheWriteUsd":null,"outputUsd":0.0044}
```

`cacheWriteUsd: null`. `rtk rg -n cacheWriteUsdPerMillion src/ providers/` returns **no connector** — only `src/lib/openrouter-models.js:27` derives one. So `src/lib/usage.js:114` always evaluates to `null` for claude-code, codex, grok, and command-code. Even a perfectly counted cache write is billed at zero.

**Cause 3 — the session id is generated, used, and then thrown away.** `src/workflow/v2-dispatch.js:234-252` mints a UUID and `src/lib/watch.js:121-126` passes it as `claude --session-id <uuid>` (grok too; codex has no `conversation` block). But `normalizeAttempt` (`src/workflow/v2-runtime.js:442-475`) has no `session` passthrough, so `record.session` never reaches durable state. My scan of the live corpus:

```
files 311 · attempts 1804
tokenSource: {estimated:utf8-bytes/4: 1730, provider-reported: 33, missing: 41}
attemptsCarryingSessionId: 0
```

**Zero of 1,804.** That is why the Claude audit had to match transcripts by time window. The id already exists at spawn time; it is dropped one function later.

### What that does to Budget and Stats

- **Budget `so far ≈$3.06 of API-equivalent work`** — a whole-week, whole-pool figure. Three individually measured Claude attempts total $40.16. The page's five-pool week sums to roughly $6.61. So the Budget money line is low by at least an order of magnitude, probably two. (`src/workflow/budget-model.js:289-299`, rendered at `src/workflow/budget-view.js:138-149`.)
- **Budget `biggest: dahnys ≈$0.43`** — ranked by worker minutes, not money (`src/workflow/budget-model.js:501-565`), then labelled with an estimate. A genuinely expensive short run cannot appear.
- **Stats pool/project totals and spend trends** inherit the same rollup `costUsd` (`src/workflow/stats-model.js:328-336`). Model rows are honestly `null` because rollups carry no model cost — which is the one place today that already refuses to guess.
- **History daily spend** (`src/workflow/history.js:108-118`) is the same sum, correctly `null` rather than `0` on a costless day.
- **Nothing anywhere shows the basis.** `rtk rg -n tokenSource src/` hits exactly two lines: where it is produced (`src/lib/usage.js:129`) and `src/cli.js:594`, a single-run `bullswarm run` print. No dashboard page — Home, Runs, Stats, Budget, History — ever tells the reader that `≈$3.06` is a byte estimate.
- **`by bullswarm ≈129%` is a separate problem and this plan does not fix it.** It is `fitted meter-rate × worker minutes` (`src/workflow/budget-model.js:310-320`), unclamped, and it is not made of tokens at all. Measured tokens improve it only if the units can be reconciled; see §3.

---

## 2. The plan

All anchors are in `/home/dev/Repo/bullswork/bullswarm-cost/src` unless marked `[0.33.1]`.

### (a) Capture the provider's own totals at attempt end

The mechanism is already declarative — the connector describes its event stream and core applies rules. Extend that, do not special-case providers in core.

**Core.** `src/lib/agent-events.js:63-176` builds the decoder from `eventStream.rules` and `eventStream.output`. Add a third rule family, `eventStream.usage`, and a `usage()` accessor beside `output()` at `:168-175`. Each usage rule is `{ match, mode: 'last'|'sum'|'max', fields: { standardRead: <path>, cacheRead: <path>, cacheWrite5m: <path>, cacheWrite1h: <path>, output: <path>, costUsd: <path>, sessionId: <path>, model: <path> } }`, read with the existing `getPath`/`matches` helpers (`:6-20`). `mode: 'last'` is the cumulative-total case; `sum` is the per-request case. This is the fix for the triple-count: paths, not regex over text.

**Claude.** `src/providers/claude-code/connector.json:45-47` already spawns with `--output-format stream-json --verbose` (`:37`). Add beside the existing `output` rule:

```json
"usage": [{
  "match": { "path": "type", "equals": "result" },
  "mode": "last",
  "fields": {
    "sessionId": "session_id",
    "costUsd": "total_cost_usd",
    "standardRead": "usage.input_tokens",
    "cacheRead": "usage.cache_read_input_tokens",
    "cacheWrite5m": "usage.cache_creation.ephemeral_5m_input_tokens",
    "cacheWrite1h": "usage.cache_creation.ephemeral_1h_input_tokens",
    "output": "usage.output_tokens"
  }
}]
```

Every one of those paths is confirmed present in the real captured `result` event quoted in §1, including `modelUsage.<model>.costUsD` and `costBasis: "list"` if a per-model breakdown is wanted later.

**Codex.** `src/providers/codex/connector.json:34-39` spawns `codex exec --json`. The session id is in the rollout header, not necessarily on stdout: the real rollout's first line is `{"type":"session_meta","payload":{"session_id":"01a0b2b4-…","cwd":"…"}}`. Codex has no `conversation` block (contrast `src/providers/claude-code/connector.json:70-73`), so there is no bullswarm-minted id either. Two options, in order of preference: (i) if `codex exec --json` emits a thread/session event on stdout, map it with the same `usage` rule; (ii) otherwise fall back to §(c)'s rollout lookup keyed on `session_meta.cwd` + the attempt's start second, which is how `scripts/cost-audit/codex-session-cost.mjs` already resolves it. Token totals come from the last `event_msg/token_count` → `payload.info.total_token_usage` (cumulative — summing every event overcounts; the audit documents this).

**Grok.** `src/providers/grok/connector.json:144-153` already has `conversation.newArgs: ["--session-id", "{sessionId}"]`, so bullswarm mints and knows grok's id too, once (b) is fixed. Grok's `--output-format streaming-json` stdout was not observed to carry token counters; the durable record is `~/.grok/logs/unified.jsonl`, one `shell.turn.inference_done` per request with `ctx.{prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_tokens}` (real record verified today). That is a **summed** source, and it is per-request so the ≥200K long-context tier is resolvable — `scripts/cost-audit/grok-session-cost.mjs` already does this. The credits meter (`src/providers/grok/provider.mjs:168-214`) is a weekly pool, not a per-attempt ledger; do not use meter deltas for attribution here.

**Where it lands.** `src/lib/watch.js:433-445` currently calls `estimateInvocationUsage({ taskText, outputText: output, … })`. Add the decoder's `usage()` as a new first-class input, e.g. `reported: obs.reportedUsage`, threaded out of `runDelegate` alongside `eventOutput` at `src/lib/watch.js:332` and `:349`. In `src/lib/usage.js:97`, prefer that structured object over `parseReportedUsage(outputText)`. Keep the text parser as the last resort, but **fix its double-count** by making it take the last match per alias rather than the sum (its own name, `lastCounter`, says what it was meant to do).

### (b) Store `sessionId` and `tokenSource` on the attempt

- `src/workflow/v2-runtime.js:442-475` — add `...(record.session !== undefined ? { session: clone(record.session) } : {})` to `normalizeAttempt`. One line. It makes the already-minted Claude and Grok session ids durable for every future attempt.
- `src/lib/usage.js:126-139` — widen `tokenSource` from two values to four: `provider-reported` (the provider's own final totals, structurally parsed), `transcript-summed` (back-filled from a session file), `estimated:utf8-bytes/4`, `unknown`. Add sibling fields `sessionId`, `costSource` (`provider-billed` when `total_cost_usd` was read, `local-rate-card` otherwise), and `pricedFields` naming which of the four token classes were actually priced.
- `src/workflow/v2-dispatch.js:556` and `:577` already clone `verdict.meta.usage` onto the attempt and the decision-log entry — no change needed there. `src/cli.js:537` does the same for single runs.
- `src/workflow/rollup.js:83-112` — carry `tokenSource` into the pool record as a worst-of rollup (`unknown` < `estimated` < `summed` < `reported`) so a mixed run degrades honestly, and add `cacheRead`/`cacheWrite` to the pool token totals rather than collapsing to `totalKnown`.
- `src/workflow/v2-runtime.js:477-483` — `addUsage` reads only `totalKnown`; it can stay, but note it silently drops the basis.

### (c) Back-fill command

Add `bullswarm workflow reprice` beside the existing `reindex` leaf (`src/workflow/cli.js:95`, registered in `LEAVES` at `:1859`). It is the natural sibling: `reindex` already rewrites `rollup.json` and the `~/.bullswarm/history/runs.jsonl` index from durable state (`src/workflow/rollup.js:252-260`, `:223`).

Behaviour, per attempt in `~/.bullswarm/workflows/*/state.json`:

1. If the attempt now has `session.sessionId`, look the session up directly.
2. Otherwise resolve by `(pool, cwd, startedAt→finishedAt)` window against the provider's store — Claude `~/.claude*/projects/<slug>/<id>.jsonl`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl`, Grok `~/.grok/logs/unified.jsonl` filtered by `sid`. Require the transcript's first and last timestamps to fall inside the attempt window — the discipline the Claude audit used, and the reason it could name its three matches with confidence.
3. On a match, re-price with the model's rate card and write `tokenSource: 'transcript-summed'`.
4. On **no** match, or an ambiguous multi-candidate match, write `tokenSource: 'unknown'` and `cost.estimatedUsd: null`. **Do not leave the old byte estimate in place** — a wrong number that looks like a measurement is worse than a gap, and `src/workflow/history.js:113-116` already establishes the house rule that unknown stays `null` and never becomes `0`.
5. Then re-run the existing rollup/index rewrite so Stats, Budget, and History pick it up.

The three readers already exist and are validated: `scripts/cost-audit/claude-transcript-cost.mjs`, `codex-session-cost.mjs`, `grok-session-cost.mjs`. Promote them from `scripts/` into `src/lib/transcripts/<provider>.js` with their dedup rules intact (Claude dedups streaming rows on `message.id:requestId` and traverses `subagents/`; Codex takes the last cumulative `total_token_usage`; Grok sums per-request and applies the long-context tier). Flags: `--dry-run` (print the diff, change nothing — this should be the default), `--since <date>`, `--pool <name>`.

Caveat to state in the command's own output: provider transcripts are pruned. Attempts older than the retention window will resolve to `unknown`, and the honest dashboard consequence is a visible gap in the history chart, not a silent zero.

### (d) Show the basis, never an estimate dressed as a measurement

One shared formatter — new `src/lib/usage-basis.js`, so Home, Runs, Stats, Budget, and History cannot drift:

| `tokenSource` | Glyph | Money rendered as | Meaning |
|---|---|---|---|
| `provider-reported` | `$` | `$3.06` | the provider's own final totals |
| `transcript-summed` | `≈` | `≈ $3.06 summed` | added up from the session file |
| `estimated:utf8-bytes/4` | `~` | `~ $3.06 estimated` | byte guess — **floor, not a bill** |
| `unknown` | `·` | `cost unknown` | no measurement exists |

Call sites: `src/workflow/budget-view.js:138-149` (the `so far` line and each `biggest` entry), `src/workflow/stats-model.js:328-336` plus its view, `src/workflow/dashboard.js:2187-2188` and `:2202` (`runEconomics` already counts `pricedAttempts` — surface it), `src/workflow/history-view.js:141-169`. The notes block at `src/workflow/budget-model.js:467-477` is the right place to add "N of M attempts measured".

Hard rule to encode in a test: a row whose worst attempt basis is `estimated` may never render the bare `$` form, and a pool whose basis is `unknown` renders `cost unknown`, not `$0.00`.

### (e) Cache-write pricing

Add `cacheWriteUsdPerMillion` to every profile that declares `pricing`:

- `src/providers/claude-code/connector.json:74-79` — Opus 5 `$6.25` (5m) / `$10` (1h); Sonnet 5 and Haiku 4.5 likewise from the same dated page already cited at `pricingSource`. The two tiers matter: all three audited sessions put **100%** of their cache writes in the 1h bucket, which is the more expensive one. This argues for `pricing.cacheWrite5mUsdPerMillion` and `cacheWrite1hUsdPerMillion` with `cacheWriteUsdPerMillion` retained as the single-rate fallback, and matching `cacheWrite5m`/`cacheWrite1h` token fields from §(a).
- `src/providers/codex/connector.json:141-200` and `src/providers/grok/connector.json:154-172` — both vendors' observed records show `cache write 0`, so declare the rate only where the vendor publishes one and leave it absent (→ `null`, honestly unpriced) otherwise.
- `src/provider-cli.js:259-270` validates `modelProfiles`; extend it to **warn** when a profile declares `pricing` without a cache-write rate, so this class of silent zero cannot return.
- Re-stamp `pricingUpdatedAt` (currently `2026-08-27` across the board) when the rates are re-read.

---

## 3. Budget page

The running 0.33.1 work already changed this page, and the redesign is unowned. My plan sits beside both.

**Already landed in `bullswarm-0.33.1`** (verified against that worktree, commits `dbc42a0..77e60d5`): `poolWindows()` gives each pool every meter window with its own reset and pace; `budget-view.js` renders them as `windows` cards; `capturedAtOf`/`sampleAgeText` add the sample-age header; `planPriceFor` adds `plan · $X/mo detected <plan>` with an `origin` annotation so a detected price is never shown as an operator declaration (`budget-view.js:222-225`). **Do not redo any of that.**

**Unowned:** the Budget verdict redesign exists only as ASCII frames — `docs/design/prototype-frames-0.33.1/budget-{120,55}-v2.txt`, commit `77e60d5`, awaiting the owner. Notably those frames show meter bars only; `by bullswarm`, `room`, and `so far ≈$` are **not on the v2 frame** — they move behind `Enter on a pool`. So the money work below should be built to render in a pool's drill-down, which survives whichever frame the owner picks.

Line by line:

| Line today (`budget-view.js`) | Today's basis | Once usage is measured |
|---|---|---|
| `used 64% · 54% of the window gone → on track` (`:98-110`) | Provider meter snapshot. **Trustworthy.** | **Unchanged.** Tokens do not replace a meter. Keep it, and keep 0.33.1's per-window cards. |
| `by bullswarm ≈36% (1065 min of work) · other tools 64%` (`:111-124`) | `fitted rate × minutes` (`budget-model.js:310-320`), unclamped, whole-run boundary attribution. **Not trustworthy** — Grok renders `≈129%` against a `99%` meter. | Prefer **measured tokens against the plan's normalized quota**, not meter deltas. Meter deltas cannot be attributed: the meter is shared with the owner's interactive sessions, moves in quantized steps, and lags. Tokens are attributable to an attempt by construction. So: sum measured tokens per attempt whose interval falls in the meter's window, convert with `normalizedQuota` (`usage.js:140-149`), and show `by bullswarm ≈N% (measured)`. **Only when the pool declares `subscription.includedValueUsd`** — all four shipped connectors currently declare `null` (`claude-code:81`, `codex:201-206`, `grok:173-178`), so on day one this renders `share unknown · no declared plan value`, which the view already handles at `:111-114`. Keep the minutes-based fit as a clearly separate `by minutes ≈N% (inferred)` second line, or drop it; never let the two share one number. |
| `other tools 64%` (`:119-120`) | `max(0, used − workflows)`. Not an observation. | Render only when the Bullswarm share is `measured` **and** its unit reconciles with the meter. Otherwise `other usage unknown`. |
| `room about 41 more medium runs before the reset` (`:125-137`) | `rate × median run minutes`; "medium" is a UI word (`budget-model.js:322-330`). | Recompute from the **measured token distribution** per run, with a minimum-sample gate (say 5 measured runs) and the median named in the label — `about N more runs like your median (measured over 12 runs)`. Below the gate, keep the existing honest `no measured usage rate yet` (`:127`). |
| `so far ≈ $3.06 of API-equivalent work` (`:138-149`) | Sum of `attempt.usage.cost.estimatedUsd`. **Low by 1–2 orders of magnitude.** | Sum measured per-attempt input/cache-read/cache-write/output at the model rate card, and carry the §(d) basis glyph. Where the provider gave its own `total_cost_usd` (Claude does), show **that** as the primary figure and the locally-computed rate-card number as the check. Keep subscription debit a separate line — it already is (`budget-model.js:334-340`). |
| `biggest: dahnys ≈$0.43, w6p38i ≈$0.46` (`:139-147`, built at `budget-model.js:501-565`) | Top runs **by worker minutes**, labelled with an estimate. | Rank by measured cost. A run with no measurement must appear as `(cost unrecorded)` — the formatter already has that string at `:143` — rather than sorting to the bottom as if it were cheap. |
| `0 of 70 credits` (`:99-101`) | Measured credit endpoint. **Trustworthy.** | Unchanged. Never convert credits into a share percentage without a measured rate. |
| `plan · $X/mo detected <plan>` `[0.33.1]` | Declared or detected price, origin-annotated. | Unchanged. |

**Hide until a measurement exists:** the `by bullswarm` percentage, `other tools`, `room`, and the `biggest` ranking. Each already has a null path and an honest wording in `budget-view.js:111-137` — the change is to route the not-measured case into those paths rather than into a number.

**New header line, cheap and high-value:** `N of M attempts measured · K unknown`, next to 0.33.1's sample-age header. It is the single line that tells the owner how much of the page to believe.

---

## 4. Sizing: 0.33.1 plan revise vs 0.33.2

Run `u9d48s` (`wf-mu6h8obw-baa03e`, worktree `bullswarm-0.33.1`) is `running`. Its plan today: `plan-strip-phases` running; `digest-all`, `integrate`, `verify`, `chart-hover-labels` pending; everything else succeeded. A revise must insert before `digest-all`, or it will not be integrated or verified.

**Fits a 0.33.1 revise — small, additive, no schema migration:**

1. **(b) the one-line session passthrough** in `normalizeAttempt`. It costs nothing, breaks nothing, and every attempt from that moment on becomes back-fillable by id instead of by time window. Highest value per byte in this whole plan.
2. **(e) cache-write rates** on the connector profiles, plus the `provider-cli` validate warning. Pure data + one check. Turns a structural $0 into a real number the moment tokens are counted.
3. **(a) Claude only** — the `eventStream.usage` rule family in `agent-events.js`, the `usage()` accessor, threading it through `watch.js`, and the claude-code connector block. Claude is the largest pool by spend and its `result` event carries `total_cost_usd`, `usage`, and `session_id` in one object; every path is confirmed against a real captured artifact. Codex and Grok need transcript lookup, which is the expensive half.
4. **(d) the basis label**, at minimum on the Budget `so far` line and the Stats totals, using the four-value `tokenSource`. This is the promise not to show an estimate as a measurement, and it should ship with the first real measurement rather than after it.
5. **Fix `lastCounter`'s sum→last** so the legacy text path stops triple-counting.

**Trade-off of taking these now:** the run is at its dashboard-and-integration steps, so anything added competes with `integrate` and `verify` for the same worktree and the same acceptance gate. Items 1, 2 and 5 are a handful of lines with existing test files (`tests/usage.test.js`, `tests/providers.test.js`, `tests/workflow-v2-runtime.test.js`). Item 3 touches `agent-events.js` and `watch.js`, which `c9146fc` already modified in this release — a second concurrent edit there is the real integration risk, and it argues for making the usage rules purely additive: a new key the existing rule loop never reads. Item 4 touches view code the 0.33.1 dashboard steps are already editing; if `integrate` is close, defer item 4 to 0.33.2 and accept one release where the number is right but unlabelled — **or** ship item 4 and defer item 3, so the page honestly says `estimated` until 0.33.2 measures. I would ship 1, 2, 4, 5 and hold 3 if `plan-strip-phases` finishes before the revise lands.

**Belongs in 0.33.2 — new surface area, new failure modes:**

- **(c) the `reprice` back-fill.** It reads three providers' private on-disk formats, needs window-matching rules, an ambiguity policy, and a `--dry-run` default. It rewrites 1,804 durable attempt records and the whole history index. That is a release of its own, with its own reversibility story (write to a sidecar first, promote on confirmation).
- **(a) for Codex and Grok.** Both need transcript readers in `src/lib/`, not just a connector rule. Codex additionally needs a session-identity answer because it has no `conversation` block — either add one, or match on `session_meta.cwd` plus time.
- **The Budget share redesign** (`by bullswarm` from measured tokens, `room` from a measured distribution, `biggest` ranked by cost). This depends on `subscription.includedValueUsd` being declared, which no shipped connector does today, so it needs the plan-price work from 0.33.1 to mature first — and it lands on the page the owner is still deciding.

**The honest trade-off, in words:** the cheap 0.33.1 items make *new* attempts measurable and stop the page lying about what it is showing. They do **not** make the existing $3.06 correct — the 1,771 already-recorded attempts stay wrong until the back-fill runs, and after the back-fill the historical spend chart will jump by one to two orders of magnitude and grow visible gaps where transcripts have been pruned. That jump is the fix working, and it should be announced in the changelog rather than discovered. The alternative — holding everything for 0.33.2 so the page changes once — buys a cleaner story at the cost of another release's worth of attempts recorded with no session id, which are then permanently only time-window-matchable.

---

## 5. Validation and what is unfinished

**Validation run for this action** (read-only; commands and outputs verbatim):

- `rtk node --input-type=module -e '…parseReportedUsage…'` on the real captured `result` event in `/home/dev/.bullswarm/workflows/wf-mtcof6lr-187c3e/out-orchestrator-mtcof6mi.json` → `{"standardReadTokens":6,"cacheReadTokens":0,"cacheWriteTokens":90759,"outputTokens":528}` against a ground truth of `2 / 0 / 30253 / 176`. Confirms the 3× count.
- `estimateInvocationUsage(…, model:'claude-opus-5')` → `breakdown {"standardReadUsd":0.00001,"cacheReadUsd":0,"cacheWriteUsd":null,"outputUsd":0.0044}`. Confirms cache writes price to nothing.
- `rtk rg -n cacheWriteUsdPerMillion src/ providers/ tests/` → 4 hits, none in a connector. Confirms it repo-wide.
- State scan of `~/.bullswarm/workflows/*/state.json` → `files 311 · attempts 1804 · {estimated:utf8-bytes/4: 1730, provider-reported: 33, missing: 41} · attemptsCarryingSessionId: 0`. Confirms the session id is never persisted.
- `rtk rg -n tokenSource src/` → 2 hits, neither in a dashboard view. Confirms the basis is never shown.
- Source read of `src/workflow/v2-runtime.js:442-475` — no `session` key in `normalizeAttempt`. Confirms where it is dropped.
- `git log v0.33.0..HEAD` and file reads in `/home/dev/Repo/bullswork/bullswarm-0.33.1` — confirms `windows`/`sampledAt`/`planPriceFor` landed, `src/lib/attempt-stream.js` exists there and **not** in this worktree, and that its persisted records are `{seq, at, source, providerType, kind, status, summary}` with **no usage field**.
- Run state read of `wf-mu6h8obw-baa03e` — `u9d48s`, `running`, `plan-strip-phases` in flight, `digest-all`/`integrate`/`verify`/`chart-hover-labels` pending.

**I did not run the repository test suite.** This action is read-only and changes nothing, so there is no behaviour of mine to exercise; the dependency audits already report its state, and it is not currently green — `rtk npm test` was reported at 1,228 tests, 1,200 passing, 28 failing in `tests/dash-kit.test.js` (Unicode glyphs rendering as ASCII under `FORCE_COLOR`), plus 3 pre-existing `workflow-history-view` glyph failures in the focused set. Those are environment-sensitive rendering assertions unrelated to usage accounting, but **any implementer of this plan should not treat a red suite as pre-existing without re-checking** — the basis-label work in §(d) touches view code in the same neighbourhood as those failures.

**Unfinished / out of scope, stated plainly:**

- Whether `codex exec --json` emits a session identifier on stdout is **unverified** — I confirmed only that the rollout file's `session_meta.payload.session_id` exists. §(a) branches on this and the branch must be settled before implementation.
- Whether Grok's `--output-format streaming-json` carries token counters on stdout is **unverified**; I confirmed only the `~/.grok/logs/unified.jsonl` record shape.
- Nothing here converts API-equivalent dollars into a **subscription debit**. No provider CLI exposes one. That boundary is unchanged and every label must keep saying so.
- The `by bullswarm ≈129%` attribution is diagnosed, not fixed. It needs a declared `includedValueUsd` per pool before measured tokens can replace the minutes heuristic.

**Requests for the integrator:**

1. This is a read-only report; the artifact is this response. No file to merge.
2. If a 0.33.1 plan revise is made, insert before `digest-all` and scope it to items 1, 2, 4, 5 of §4 — item 3 touches `src/lib/agent-events.js` and `src/lib/watch.js`, which `c9146fc` already rewrote in this release, so it needs a conflict check against `plan-strip-phases`'s territory first.
3. The three readers under `scripts/cost-audit/` are validated and should be promoted into `src/lib/transcripts/` by the 0.33.2 back-fill work rather than rewritten.
4. `bullswarm workflow reprice` must default to `--dry-run` and must write `unknown`, never a retained stale estimate, on a failed match.
