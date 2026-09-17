---
title: Routing
description: How Bullswarm picks a pool for a lane — the exact order it applies pace, headroom, urgency, load, and quarantine.
---

# Routing

After this page you can predict which pool a task will go to, read the reason line routing prints, and understand a surprising pick from the numbers in `bullswarm pools` instead of guessing.

## The order decisions are made

Routing runs the same six checks every time, in this order. Each one is a filter or a preference within the set that survived the one before it.

1. **Eligibility** — enabled, capable of the lane, not quarantined, not benched, not exhausted, and allowed a model for the effort tier.
2. **Forecast gate** — a pool projected at or above 90% of its 5-hour window is pushed to the back.
3. **5-hour headroom** — while any pool is below the near-limit line, only those are selectable.
4. **Free models** — while any surviving pool's model for this effort tier costs nothing, only those are selectable.
5. **Expiring-soon urgency** — while any pool's week or month is about to reset with quota left, only those are selectable.
6. **Preference inside the survivors** — an explicit tier assignment, then incumbency, then the highest effective surplus.

The rest of this page is those six steps in detail.

## Eligibility

A pool has to be enabled, declare the lane, hold any capabilities the work requires, not be quarantined, not be soft-benched, not be exhausted (100% of its window used), and have an allowed model for the effort tier. A disabled pool simply is not a candidate. Nothing in the later steps can rescue a pool that fails here.

## Pace and surplus

Pace compares a pool with itself: **surplus = elapsed% − used%** of its own subscription window. A pool that is 72% through its week having used 30% carries +42 points of quota that will expire unspent, and that is the number routing wants to spend. The weekly/monthly window declared by the connector is the pacing one; `bullswarm strategy set-subscription <pool> --quota-window weekly|monthly` overrides it, and `--resets-at <iso>` supplies an end date for a provider that reports usage but no reset.

## The 5-hour window

The rolling 5-hour window never paces — it only gates. A pool whose forecast is at or above 75% (`FIVE_HOUR_NEAR_LIMIT_PCT`) **and** above the share of that window already elapsed is tiered down: it is picked only when no eligible pool below the line exists for the lane. A pool at or above 90% (`BURST_BLOCK_PCT`) is left out of selection entirely, and that gate ignores the clock.

## Free models first

A model that costs nothing does not spend anyone's quota, so a pool holding one is ranked ahead of every metered pool. While any eligible pool's model for this effort tier is free, the metered pools are not selectable at all — they are not merely outscored, so the pick is not a close call that a surplus swing can flip.

Free-ness is a property of **(pool, effort tier)**, never of a pool: the same pool can hold a free model on `medium` and a paid one on `high`. It comes from the connector, which declares `"free": true` on the model profile that matches the selected model (`providers/*/connector.json`, `modelProfiles`); a discovered model whose name carries a standalone `free` segment — `openrouter/qwen:free` — counts as well.

The rest of the order is untouched. Free sits *below* the forecast gate and the 5-hour headroom tier, so a free pool at or above its 5-hour line still loses to a pool with headroom. It sits *above* expiring-soon urgency, which is a deliberate trade: while free work is available, a metered pool's expiring quota can expire unspent. And the ranking **among** metered pools is exactly what it was — the free tier is a constant across all of them, so their relative order is still decided by the existing keys.

The reason line says which rule applied, and names what it passed over:

```text
free pool first: opencode2 (free model opencode/union-alpha, 5h used 12.0%, 1 in flight) · metered pools ranked below free: codex 40.0, grok 12.3
```

## Soft bench: alive, but not producing

A free endpoint does not fail the way a metered one does. It has no usage meter, so it can never read as exhausted — when its free window ends the API starts erroring or falling silent rather than reporting 100%. The soft bench is the backstop.

Three failures count as a **strike** against a pool:

- **stall** — the worker wrote no output for longer than its silence threshold and was stopped;
- **provider** — the provider returned a server error;
- **empty output** — a free pool returned literally nothing. (An answer that has substance but the verifier judged thin stays a semantic failure and is not retried elsewhere; that is a verdict about the answer, not about the pool.)

Strikes are **consecutive**. The first one is recorded without taking the pool out of service. The second benches it for a 10-minute cooldown — the same re-probe window a quarantine uses — after which it returns automatically. The count survives that cooldown and is cleared only by a success, so a pool that stalls again straight after coming back is benched again immediately.

A bench is not a quarantine, and it changes nothing about auth. An upstream auth failure still quarantines, still spreads across a credential group, and its deadline is never shortened by a bench. A benched pool also keeps having its meter read, because it is coming back in ten minutes.

## Stall fallback

The silence clock bounds silence, not run time: it restarts on every byte a worker writes. A metered pool keeps the one-hour default. A **free** pool is stopped after the median wall time its own recorded runs at that (pool, effort) rung actually took — the `p50` in `bullswarm strategy`, and only once at least 3 runs have been recorded there — with a floor of 5 minutes. Stalled attempts are excluded from that median, so a pool cannot tighten its own threshold by stalling. `BULLSWARM_WORKER_SILENCE_SEC` overrides it for a probe.

When an attempt stalls, the run does not stop and the work is not lost:

- the worker's process is ended and **whatever it had already written stays on disk** — the retry writes a new `out-<action>-attempt-<n>` file beside it, never over it;
- the in-flight ledger entry is released, so the next pick sees the pool as idle;
- the same action is re-dispatched on the next eligible pool **in the same run**, and its reason line is prefixed with where it came from;
- the second consecutive stall benches the pool, so later actions in that run do not each wait out the threshold.

`--retry-attempts` (default 1) caps mechanical retries for metered failures. A
stall on a free pool (and its literally-empty-output provider reclassification)
does not spend that allowance: the dispatcher advances through eligible pools,
trying each pool at most once for the action, so the tried-set remains the
termination bound. A stall on a metered pool keeps the mechanical accounting.

```text
fallback from opencode2 after stall 300s · most-behind capable pool (surplus 40)
benched (stall, back at 2026-09-17T02:40:36.911Z): opencode2
```

The run's events carry the same facts: `attempt.finished` gains `stalled`,
`partialOutput`, `silentSec` and `willRetry`, and a `pool.benched` event names
the pool, the reason, the strike count and the deadline. `bullswarm workflow
watch` renders `retrying on another pool` only when `willRetry` is true;
otherwise it says `no retry left`.

## Evidence steps keep normal routing

An evidence or acceptance step is never pushed onto the free pool: the free tier is switched off for it, and it routes on pace like any other action. It does get one preference — **a pool that wrote the work being judged is chosen last**. While any other eligible pool exists, the writer is not selected; when it is the only one left, it runs and the reason says so rather than failing the step.

```text
evidence step: normal routing (free tier not applied)
evidence step: only the writer pool answerer is eligible
```

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

`bullswarm pools` prints one line per pool: `cost=`, `lanes=`, the meter it is paced from, `surplus=`, `inflight=`, the 5-hour column as `5h=<reading>%-><projected>%` with `(<n>% elapsed)`, `free=<model>` when its model costs nothing, then `ready`, `disabled`, `QUARANTINED until …`, `BENCHED until … (<reason>, <n> strikes)`, `NEAR-5H-LIMIT`, `BURST-GATED`, or `resets in … EXPIRING-SOON urgency=<n>`. A pool carrying an uncounted-out strike prints `strikes=<n>(<reason>)` beside `ready`. `pools` names no lane and therefore no effort tier, so when free-ness differs per tier the column names each one — `free=medium:opencode/union-alpha`.

```text
answerer       cost=3 lanes=analyze/build/chore unmetered surplus=0 inflight=0 ready
opencode2      cost=1 lanes=analyze/build/chore unmetered surplus=0 inflight=0 free=opencode/union-alpha BENCHED until 10:40:36 AM (stall, 2 strikes)
```

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
