---
title: Routing
description: How Bullswarm picks a pool for a lane — the exact order it applies pace, headroom, urgency, load, and quarantine.
---

# Routing

After this page you can predict which pool a task will go to, read the reason line routing prints, and understand a surprising pick from the numbers in `bullswarm pools` instead of guessing.

## The order decisions are made

Routing runs the same five checks every time, in this order. Each one is a filter or a preference within the set that survived the one before it.

1. **Eligibility** — enabled, capable of the lane, not quarantined, not exhausted, and allowed a model for the effort tier.
2. **Forecast gate** — a pool projected at or above 90% of its 5-hour window is pushed to the back.
3. **5-hour headroom** — while any pool is below the near-limit line, only those are selectable.
4. **Expiring-soon urgency** — while any pool's week or month is about to reset with quota left, only those are selectable.
5. **Preference inside the survivors** — an explicit tier assignment, then incumbency, then the highest effective surplus.

The rest of this page is those five steps in detail.

## Eligibility

A pool has to be enabled, declare the lane, hold any capabilities the work requires, not be quarantined, not be exhausted (100% of its window used), and have an allowed model for the effort tier. A disabled pool simply is not a candidate. Nothing in the later steps can rescue a pool that fails here.

## Pace and surplus

Pace compares a pool with itself: **surplus = elapsed% − used%** of its own subscription window. A pool that is 72% through its week having used 30% carries +42 points of quota that will expire unspent, and that is the number routing wants to spend. The weekly/monthly window declared by the connector is the pacing one; `bullswarm strategy set-subscription <pool> --quota-window weekly|monthly` overrides it, and `--resets-at <iso>` supplies an end date for a provider that reports usage but no reset.

## The 5-hour window

The rolling 5-hour window never paces — it only gates. A pool whose forecast is at or above 75% (`FIVE_HOUR_NEAR_LIMIT_PCT`) **and** above the share of that window already elapsed is tiered down: it is picked only when no eligible pool below the line exists for the lane. A pool at or above 90% (`BURST_BLOCK_PCT`) is left out of selection entirely, and that gate ignores the clock.

## Expiring-soon urgency

A pool whose pacing window resets within 24 hours (weekly) or 3 days (monthly) is ranked on urgency — its surplus divided by the fraction of the window still to run — instead of on the surplus alone. While any urgent pool can still spend its quota, it is the only one selectable, which is how a pool with two hours left beats a pool with three days left. A pool forecast at or above 95% of its pacing window *and* ahead of the window's own clock (forecast above the elapsed share) is `draining` and goes last; a pool at 96% with 98% of its month gone is spending at its own pace, not draining, and keeps its quota in play until the reset.

## In-flight load

Work already dispatched is charged against a pool before the next pick: each pool's effective surplus is its pace minus what its in-flight agents and the candidate are expected to spend. When the pacing window has a measured rate, each timed in-flight record is charged at `rate × remaining minutes` with no floor. A pool with no measured rate uses the flat `config.inflightPenaltyPct` tie-breaker in `~/.bullswarm/state.json` (default 3; `0` turns it off); a measured pool uses that value only for an in-flight record whose remaining duration is unknown. A busier pool therefore yields to a quieter one at similar pace.

## Assignments and incumbency

Two preferences apply only among pools that survived the steps above. An explicit effort-tier assignment (`bullswarm strategy assign <tier> --pool <p> --model <m>`) wins if that pool is selectable — it is a preference, never a bypass of eligibility, quarantine, or the gates. Otherwise the pool that last succeeded in that lane keeps it, unless a challenger beats its effective surplus by 10 points and is no more expensive; an incumbent at −20 surplus or worse forfeits that protection, and one carrying more in-flight work than the challenger loses it too.

## The caller

The agent CLI that invoked Bullswarm competes as a pool like any other, and `keepOnClaude: true` in a verdict means it won or nothing else was eligible. It is never protected: it has to win on merit. `--no-caller` removes it from the field, so the task must go to a delegate or fail.

## Quarantine on a usage limit

A provider reporting a usage limit is its own failure kind, `quota`, never `process` or `auth`. The attempt is killed immediately even if the CLI would otherwise hang, and the pool is benched until the reset the message named — falling back to its cached 5-hour `resets_at`, then to 30 minutes. The pool is excluded from every later dispatch until that deadline, the action is re-dispatched on another pool, and it is never retried on the one that hit the limit. Detection is shape-gated to lines that look like a provider notice, so an agent writing *about* rate limits is not quarantined.

## Quarantine on an upstream auth failure

A relayed credential fails upstream, not in the CLI. When a provider's event stream reports `auth_unavailable`, `authentication_error`, `invalidated oauth token`, `no available channel for model`, or a phrase the connector declares in `authSignatures`, the verdict is `auth` with a quarantine hint, and the pool is benched for the flat 10-minute re-probe window. Pools that share a credential group are benched together on the same deadline, with the reason reading `sibling of <pool>: <why>`; a quota quarantine never spreads, because one seat's window says nothing about the next.

## How the decision shows its work

`bullswarm pools` prints one line per pool: `cost=`, `lanes=`, the meter it is paced from, `surplus=`, `inflight=`, the 5-hour column as `5h=<reading>%-><projected>%` with `(<n>% elapsed)`, then `ready`, `disabled`, `QUARANTINED until …`, `NEAR-5H-LIMIT`, `BURST-GATED`, or `resets in … EXPIRING-SOON urgency=<n>`.

```bash
# every pool, with its meter, pace, load, and quarantine state
bullswarm pools
# what is in flight right now, across every Bullswarm process
bullswarm assignments
# the pick this task would get, with the forecast behind it
bullswarm run --lane analyze --add-dir . --dry-run "Explain the parser"
```

`bullswarm run --json` carries the candidate rows that decided the pick, in preference order: `pace`, `effectiveSurplus`, `inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `ratePerMinute`, `estimateSource`, `forecastGated`, and the urgency fields. `bullswarm pools --json` reports the same numbers per pool, plus the spend rates they came from. Those rates pair retained meter readings with dispatched worker-minutes; until at least 5 worker-minutes are attributable to a window there is no rate at all, and routing falls back to the flat penalty.

## Worked example

Four of the lines from `bullswarm pools` on a machine with two Claude accounts, a Grok subscription, a Codex CLI with no usage reader, and a disabled echo pool:

```text
claude-code      cost=4 lanes=analyze/build/chore weekly used 31% elapsed 26.3% [cache] surplus=-4.7 inflight=0 5h=27% (54% elapsed) ready
claude-code:wati cost=4 lanes=analyze/build/chore weekly used 30% elapsed 65.6% [cache] surplus=35.6 inflight=0 5h=15% (44% elapsed) ready
codex            cost=3 lanes=analyze/build/chore unmetered surplus=- inflight=0 disabled
grok             cost=2 lanes=analyze/build/chore weekly used 74% elapsed 72.5% [cache] surplus=-1.5 inflight=0 ready
```

`claude-code` has used more of its week than the week has run, so its surplus is negative; `claude-code:wati` is 65.6% through the week having spent 30%, so it holds +35.6 points of expiring quota. `codex` has no reader, so it is `unmetered` (`surplus=-`) rather than assumed idle, and it does not dispatch while disabled.

A dry run against this state picked grok and said why:

```text
OK [grok] most-behind capable pool (surplus -2.1)
forecast: inflight=0 5h ?%->?% expected=5.67m rate=unmeasured basis=bootstrap
```

Grok won because it was the only pool left: this `analyze` task resolves to the medium effort tier, whose allow-list names a model only on grok and codex, and codex is disabled — eligibility runs before any pace comparison, so the +35.6 on `claude-code:wati` never entered the race.

When a pool is passed over, the reason says so in the same line — `skipped near 5h limit (projected): claude-code:wati 88.1% (92.3% elapsed)`, `forecast-gated at/above 90%: …`, `expiring but draining (forecast >= 95% and past its clock): grok 99.5% (98.8% elapsed)`, or `preferred over busier: … (2 in flight)`.

## Next steps

- [Run one task](/guide/run) — the command whose routing this page explains.
- [Concepts](/guide/concepts) — surplus, windows, and quarantine as definitions.
- [Observing runs](/guide/observing) — watching a run once it is dispatched.
