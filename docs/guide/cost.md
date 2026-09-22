---
title: Cost and usage
description: Read Bullswarm's token sources, API-rate cost, subscription measurement, and money-pair glyphs.
---

# Cost and usage

Bullswarm keeps two different answers beside an attempt: what the provider's
tokens cost at a dated API rate card, and what share of the pool's subscription
window the attempt consumed. They are related evidence, not the same invoice.

## Active minutes and span

Durations in the dashboard use the run or phase's `minutes.active` value. It is
the union of all attempt intervals: sort the intervals, merge overlapping or
touching work, and count each minute once. A running attempt contributes only
through the current render time, and an interval with a missing or invalid end
point stays unknown rather than becoming zero. The same union is computed per
phase.

`minutes.span` is the secondary wall-span fact from the first attempt start to
the last recorded attempt finish. It is not substituted for active time in
Home or Runs rows, the Run header, phase headers, timeline phase durations, or
Stats median/longest duration fields. The Run header may show span explicitly
as a secondary value. A timeline attempt row shows that attempt's own duration,
while `worker-minutes` remains the sum of all individual attempt clocks, so
overlapping workers still count separately there.

Every one of those clocks is written the same way: h/m/s, never a raw minute
count. `30s`, `38m17s`, `2h04m` - so a phase that ran for two hours reads
`2h04m` on the Run header, on its timeline rule and on the Step page alike.

On the Run page the plan is one box per phase on a wide terminal and one glyph
strip below 120 columns; `p` opens the boxes over the strip and closes them
again. The strip and the boxes both count phases, not steps: the step counts
that used to sit in the plan rule now live in the header
(`18 of 20 steps done`), beside the run's own active-of-span clock.

`workflow reprice` recomputes both stored minute fields for terminal historical
runs as it refreshes their pricing data. Use `--apply` when the dry-run rows
are the changes you want persisted; unknown endpoints remain unknown. This
corrects older records that counted idle gaps without changing worker-minute
aggregates.

## The three token sources

Every attempt labels its token classes with one of these sources, in descending
order of confidence:

- `provider-reported` — the provider's structured completion or turn record.
- `transcript-summed` — a durable provider transcript matched by session ID or
  by the attempt's cwd and inclusive time window.
- `estimated:utf8-bytes/4` — the bounded fallback when neither structured
  counters nor a transcript is available.

`unknown` is a deliberate fourth state for a value that cannot be measured; it
is never silently changed to zero. Token classes are exclusive: a provider's
inclusive input or output counter is reduced by its cache or reasoning subset
before `totalKnown` is calculated.

The 2026-09-18 audit shows why the label matters. The Claude `integrate-2`
attempt recorded `5,605` estimated tokens and `$0.089705`, while its matched
transcript contained `34,908,081` tokens and priced to `$22.542275` after cache
reads and writes were counted. See [Claude actual vs recorded](../studies/cost-audit-2026-09-18/claude-actual-vs-recorded.md).

## What the API-rate figure means

`api.usd` is a local calculation from the model's dated rate card. It prices
standard reads, cache reads, 5-minute and 1-hour cache writes, output, and
reasoning separately; the breakdown keeps a null for any positive class with no
rate. A complete figure is still an API-equivalent figure: it answers “what
would these measured tokens cost at this card?”

It does not claim that a subscription provider will debit that exact amount.
The Grok/Codex audit explicitly calls its measured dollar values API-equivalent
published-rate calculations, not a Grok Build or ChatGPT subscription debit;
for example, one Grok attempt measured `9,400,999` tokens and `$7.783282` while
the recorded estimate was `$0.009668`. See [Grok and Codex actual versus
recorded](../studies/cost-audit-2026-09-18/grok-codex-actual-vs-recorded.md).

The compatibility fields remain available: `cost.estimatedUsd` mirrors
`api.usd`, `cost.breakdown` mirrors `api.breakdown`, and `cost.basis` mirrors
the API basis. A provider-reported total cost may be retained as diagnostic
evidence, but it does not replace the dated local calculation.

## Subscription cost

Subscription cost is measured from the pool's quota meter, not inferred from
worker minutes. Bullswarm snapshots the declared subscription window immediately
before and after the attempt. When both snapshots are fresh, in the same window,
and the counter did not reset or decrease, the difference is an observed
`deltaPct` and the basis is `observed:meter-delta`.

If a same-window meter pair is unavailable, a known API amount can be added to
the pool's calibration ledger. Eligible samples have a non-negative API amount
and a positive meter delta; a compatible ledger becomes usable after at least
three samples and keeps the newest 500. The resulting basis is
`calibrated:usd-per-pct`. Calibration is a measurement aid, not a claim that the
provider exposes a per-run subscription invoice.

With a declared monthly price, the formulas are:

```text
windowDays("5h")      = 5 / 24
windowDays("weekly")  = 7
windowDays("monthly") = calendar duration from one UTC month before resetsAt
                         through resetsAt, in days

windowPriceUsd = monthlyPriceUsd × windowDays / 30.4375
subscriptionUsdFromPct = windowPriceUsd × pct / 100
```

The divisor `30.4375` (365.25 / 12, `DAYS_PER_MONTH` in `src/lib/prices.js`)
is intentional: it normalizes a monthly price to the average calendar month.
Since 0.35.2 it is the only month length anywhere — subscription cost, window
prices and Budget's monthly window all use it. A changed quota-window kind starts
a fresh calibration for that pool. If there is no plan price, no meter, or no
API amount for calibration, the subscription basis stays explicitly unknown.

## Declare a plan price

Record a monthly price for a pool with the strategy command. The explicit value
overrides a bundled or detected plan price, and `unknown` clears it back to an
unknown price:

```bash
bullswarm strategy set-subscription <pool> --monthly-usd <amount>
```

The value is stored in `state.strategy.subscriptions[pool].monthlyPriceUsd`.
The quota-window declaration, when needed, is kept alongside it; it does not
change the API rate card.

## Prices arrive on their own

Each attempt keeps what its provider reported: when the worker exits, the
attempt records an immutable `capture` block (provider session id, model,
exclusive token classes, provider-reported cost when present, exit code and
signal) before any meter read or transcript lookup. Provider-reported usage is
never replaced by a later sum; an estimate or an unknown can be upgraded.

An attempt that ended unknown or estimated is priced later by an incremental
reconciler, with no command:

- the kernel prices its own run whenever no worker is streaming and once more
  before it writes the result and rollup;
- a single `bullswarm run` with unmeasured usage starts a detached pass 30 s
  after it ends, when the pool's provider keeps transcripts;
- the dashboard starts one detached pass after its first paint (at most one
  every 5 minutes, one at a time) and shows `pricing N older records…` while
  it runs.

The reconciler matches a transcript by session id, then by task text (the task
file's path or exact text in the delegate's first message), then by cwd and
time window. More than one candidate stays unknown. Its ledger,
`$BULLSWARM_HOME/pricing/reconcile.json`, records every try: a recent attempt is
retried after 1 and 10 minutes, an older one gets one try, and a closed attempt
reopens only when a new or grown transcript covers its window, so a second pass
does nothing. A pass never makes an attempt worse: no match leaves it as it
was. `bullswarm home status` prints the last pass as `last reprice`.

## Reprice old attempts

Use `workflow reprice` when rate cards or transcript readers have improved; it
is the manual full backfill, and `workflow reprice --incremental` runs the
automatic pass by hand:

```bash
bullswarm workflow reprice [--apply] [--since <date>|--all] [--pool <name>] [--json]
```

The default is a dry run over terminal V2 runs. `--since` is inclusive on
`startedAt`; `--pool` is an exact pool-name filter. Provider-reported tokens are
kept and repriced against the current card. The default scan covers the last
30 days; pass `--all` to override it. A single bounded head/tail index is built
for each transcript store, rows stream as attempts are decided, and only a
matched transcript is read in full. Other attempts try the provider's
transcript hook; an exact or window match becomes `transcript-summed`, while a
missing or ambiguous match becomes `unknown` with null totals and API cost.
Historical repricing reads calibration but never appends samples. Add
`--apply` only when the dry-run rows are the changes you want persisted.

## Durable-history recovery matrix

Transcript recovery is a property of the pool's provider store, not a promise
that every old attempt has a record. The 0.35.2 provider study (2026-09-20)
found the following:

| Pool or attempt | Durable source | What can be recovered | What never can be recovered |
|---|---|---|---|
| `claude-code`, `codex` | The provider's existing transcript store | A unique session, task-text, or cwd/time-window match is summed as `transcript-summed` | An attempt whose provider transcript was deleted, never written, or remains ambiguous |
| `grok` started before 2026-09-14 | No supported durable transcript record for that period | Nothing from transcript history | Those pre-2026-09-14 attempts cannot be backfilled; later attempts still require a matching transcript |
| `opencode2*`, including `opencode2:orbit-*` | `~/.local/share/opencode/opencode.db` (`session`, `message`, and `part`) | Token classes, model, cwd, and time bounds when one session matches the attempt window; a task-file path/text disambiguates multiple candidates | No session, or more than one unresolved candidate, stays unknown |
| `command-code` with a persisted session | `~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl` | Assistant message usage and model when that JSONL transcript exists and matches | Historical attempts made with `--no-session` have no usage-bearing transcript and cannot be backfilled; since 0.35.2 Bullswarm leaves sessions enabled |
| Any pool with no durable transcript | None | A provider-reported stream value may still win when the stream actually carries usage | No transcript means no historical sum: the result is `unknown`, never `$0` |

The OpenCode matcher uses the attempt's exact cwd and inclusive time window,
then the first user part/task-file path when necessary; ambiguity is retained
as ambiguity. Command Code's `inputTokens` is inclusive, so a persisted row's
fresh input is `inputTokens - cacheReadTokens - cacheWriteTokens`. The
`sessions/` and `history.jsonl` side stores are not substitutes for a
conversation transcript.

Both contrib connectors now declare `eventStream.usage` rules proven by real
captures made on 2026-09-20 and checked in as
`tests/fixtures/streams/opencode-hello.jsonl` and
`tests/fixtures/streams/command-code-hello.jsonl`. OpenCode reports disjoint
`part.tokens` counters on each `step_finish` step; Command Code reports
inclusive `inputTokens` on its final `result` line. A live provider-reported
value now wins before the durable reader, then the normal estimate/unknown
ladder above.

## Reading the money pair

Every surface uses the same pair: API cost first, subscription cost second.
The glyph tells you how each side was established:

| Glyph | Meaning |
|---|---|
| `$` | measured provider tokens or an observed meter delta |
| `≈` | transcript sum or calibration |
| `~` | UTF-8-byte estimate |
| `·` | unknown |

Examples of the exact basis labels are `$0.42 api`, `≈ $0.42 api summed`,
`~ $0.42 api estimated`, `1.2% wk $0.84 sub`, and
`1.2% wk ≈ $0.84 sub`. An unknown side says why, such as
`· sub unknown (no plan price)`, `· sub unknown (no meter/calibration)`, or
`· sub unknown (no API cost)`.

The same formatter is used by `run`, Home, Run, Stats, workflow results, and
the single-run CLI, so a glyph never changes meaning from one view to another.

## Partly priced scopes: totals and subtotals

A total is only a total when every attempt in its scope carried a price. A run,
a day, a pool or a period whose attempts were priced in part keeps two separate
fields: the strict total, which stays unknown, and `apiKnownSubtotalUsd` — the
recorded sum over the attempts that did carry a price.

Surfaces print the subtotal rather than a dash, because a dash beside a figure
the rollups hold reads as "this was free". It is always named as the lower
bound it is:

- a Home card or recent row shows `at least $9.52 · 6 unmeasured`;
- a Stats panel row shows `at least $63.16 api 21.1%`, and the Spending page
  states the coverage once: `Coverage · 66 of 149 attempts recorded no price;
  every spend total over this scope reads at least $X · 66 unmeasured.`;
- a hover label words it in full:
  `20 Sep · codex · at least $8.28 · 3 unmeasured · 12% of day`;
- Home's `spent per day` chart draws each day's recorded figure, marking the
  whole axis `at least` when any bar is a subtotal.

A subtotal is never summed into a strict total, so no surface claims a
whole-scope number it does not have. A scope with no recorded amount at all
still says `api unknown`.

The Stats fourth panel reads the same way for time: `Median run` and
`Longest run` state their basis (`1h45m median · span 15/15`) and the page
notes `Durations · 15 of 15 runs recorded no active interval union; their span
stands in until workflow reprice fills it.` A period whose records all carry an
active union carries no such note.

## Next steps

- [Result envelope](/reference/result) — per-attempt, per-step, and total JSON fields.
- [CLI reference](/reference/cli) — `workflow reprice` and `runs result --json`.
- [Cost audit](../studies/cost-audit-2026-09-18/cost-fix-plan.md) — the evidence that motivated measured usage.
