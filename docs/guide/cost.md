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

The divisor `30.4375` is intentional: it normalizes a monthly price to the
average calendar month used by the contract. A changed quota-window kind starts
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

## Reprice old attempts

Use `workflow reprice` when rate cards or transcript readers have improved:

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

## Next steps

- [Result envelope](/reference/result) — per-attempt, per-step, and total JSON fields.
- [CLI reference](/reference/cli) — `workflow reprice` and `runs result --json`.
- [Cost audit](../studies/cost-audit-2026-09-18/cost-fix-plan.md) — the evidence that motivated measured usage.
