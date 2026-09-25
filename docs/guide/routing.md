---
title: Routing
description: How Bullswarm picks a pool for a lane — the exact order it applies pace, headroom, urgency, and load.
---

# Routing

After this page you can predict which pool a task will go to, read the reason line routing prints, and understand a surprising pick from the numbers in `bullswarm pools` instead of guessing.

## Pacing in one minute

Bullswarm tries to spend included quota before its clock throws that quota
away. For each eligible pool it calculates:

`surplus = subscription window elapsed% − quota used%`

A larger positive surplus means the pool is further behind its own pace. If
70% of a week has elapsed and a pool has used 40%, its surplus is `70 − 40 =
+30`. Another pool 50% through its month with 45% used has `+5`. With the
same higher-priority gates and no urgent reset, the weekly pool is preferred:
it has 30 points at risk of going unused, versus 5.

Now suppose the monthly pool has only two hours until reset and still has
spendable quota, while the weekly pool has three days. The reset-soon pool can
win even with the smaller raw surplus, because its remaining opportunity
expires first. Five-hour exhaustion, eligibility, free-model routing, forecast
protection, current load, and explicit pins still apply; the worked numbers
explain the pacing preference inside those rules.

## The order decisions are made

Routing runs the same six checks every time, in this order. Each one is a filter or a preference within the set that survived the one before it.

1. **Eligibility** — enabled, capable of the lane, no metered window at 100%, and allowed a model for the effort tier.
2. **Forecast ordering** — a pool forecast past 100% of its 5-hour window stays eligible but is ordered last.
3. **5-hour last mile** — a pool at or above the near-limit line gets a soft ordering penalty only when another eligible pool is behind pace.
4. **Free models** — while any surviving pool's model for this effort tier costs nothing, only those are selectable.
5. **Expiring-soon urgency** — while any pool's week or month is about to reset with quota left, only those are selectable.
6. **Preference inside the survivors** — an explicit tier assignment, then incumbency, then the highest effective surplus.

The rest of this page is those six steps in detail.

## Eligibility

A pool has to be enabled, declare the lane, hold any capabilities the work requires, not be exhausted (a metered window — 5-hour, weekly or monthly — at 100% until that window resets), and have an allowed model for the effort tier. A disabled pool simply is not a candidate. Nothing in the later steps can rescue a pool that fails here. Nothing else from a pool's past counts: Bullswarm never pauses or benches a pool after a failure, so a pool that failed one step is a candidate for the next whenever its meters allow it. When a single `bullswarm run` still picks a pool, it names the pools it left out for a spent window at the end of its reason — `(burst-gated: pool-a, pool-b at its weekly limit)`, where a bare name is at its 5-hour limit.

## Pace and surplus

Pace compares a pool with itself: **surplus = elapsed% − used%** of its own subscription window. A pool that is 72% through its week having used 30% carries +42 points of quota that will expire unspent, and that is the number routing wants to spend. The weekly/monthly window declared by the connector is the pacing one; `bullswarm strategy set-subscription <pool> --quota-window weekly|monthly` overrides it, and `--resets-at <iso>` supplies an end date for a provider that reports usage but no reset.

## The 5-hour window

The rolling 5-hour window never paces — it only protects the last mile. A recorded reading at 100% (`BURST_BLOCK_PCT`) means the pool is at its limit until the window resets, and the same holds for a weekly or monthly reading at 100%: such a pool is never picked. The 75% (`FIVE_HOUR_NEAR_LIMIT_PCT`) line is no longer a cutoff: when another eligible pool is behind pace, a near-limit pool is ordered after it; when no such alternative exists, the near-limit pool remains selectable. A forecast above 100% is also selectable, ordered last. If the provider refuses the run at the wall, that attempt ends as a usage limit: in a workflow started by this version nothing retries it and the step comes back to you, and a single `bullswarm run` exits 1. Only a workflow started by an earlier version still moves that attempt to another pool.

The change follows the 2026-09-10 observation that `claude-code:acme` was at 81% with 23 minutes left (92.3% of its 5-hour window elapsed). The old guard sent a high-tier task to another account, while 34% of acme's weekly quota expired in the remaining 13% of that week. The last-mile rule lets the task use that quota; the risk it takes is one attempt that may stop at the wall and come back to the caller.

## Free models first

A model that costs nothing does not spend anyone's quota, so a pool holding one is ranked ahead of every metered pool. While any eligible pool's model for this effort tier is free, the metered pools are not selectable at all — they are not merely outscored, so the pick is not a close call that a surplus swing can flip.

Free-ness is a property of **(pool, effort tier)**, never of a pool: the same pool can hold a free model on `medium` and a paid one on `high`. It comes from the connector, which declares `"free": true` on the model profile that matches the selected model (`providers/*/connector.json`, `modelProfiles`); a discovered model whose name carries a standalone `free` segment — `openrouter/qwen:free` — counts as well.

The rest of the order is untouched. Free sits *below* the forecast-over-wall and last-mile ordering keys, so a free pool that is near its 5-hour line still yields to a healthy pool when the soft penalty applies. It sits *above* expiring-soon urgency, which is a deliberate trade: while free work is available, a metered pool's expiring quota can expire unspent. And the ranking **among** metered pools is exactly what it was — the free tier is a constant across all of them, so their relative order is still decided by the existing keys.

The reason line says which rule applied, and names what it passed over:

```text
free pool first: opencode (free model opencode/union-alpha, 5h used 12.0%, 1 in flight) · metered pools ranked below free: codex 40.0, grok 12.3
```

### Free-model liveness probe

Before a real dispatch uses a free model that an effort-tier rung explicitly
names, Bullswarm sends the one-word `PONG` probe through that pool's own CLI.
The answer is cached per pool and model for 15 minutes. A rung that uses the
connector's CLI default is never probed, paid models are never probed, and
Bullswarm does not scan a model catalogue or silently choose a replacement.

If the probe reports `404`, a provider error, or a timeout, the pool is left
out of this pick and routing continues with the next eligible rung (including
a metered pool). The reason `probe: <reason>` is in the route explanation.
A successful probe does not alter the selected model.

## Stall fallback

The silence clock bounds silence, not run time: it restarts on every byte a worker writes. A metered pool keeps the one-hour default. A **free** pool is stopped after the median wall time its own recorded runs at that (pool, effort) rung actually took — the `p50` in `bullswarm strategy`, and only once at least 3 runs have been recorded there — with a floor of 5 minutes. Stalled attempts are excluded from that median, so a pool cannot tighten its own threshold by stalling. `BULLSWARM_WORKER_SILENCE_SEC` overrides it for a probe.

When an attempt stalls, the run does not stop and the work is not lost:

- the worker's process is ended and **whatever it had already written stays on disk** — the retry writes a new `out-<action>-attempt-<n>` file beside it, never over it;
- the in-flight ledger entry is released, so the next pick sees the pool as idle;
- the same action is re-dispatched on the next eligible pool **in the same run**, and its reason line is prefixed with where it came from.

In a workflow started by this version a stall is a process failure like any
other: it gets the step's one automatic retry (`--retry-attempts`, default 1)
on another eligible pool (the same pool when it is the only one), then comes
back to you. In a workflow started by an
earlier version `--retry-attempts` caps mechanical retries for metered
failures, and a stall on a free pool (or its empty answer) does not spend that
allowance: the dispatcher advances through eligible pools, trying each pool at
most once for the action.

```text
fallback from opencode after stall 300s · most-behind capable pool (surplus 40)
```

The run's events carry the same facts: `attempt.finished` gains `stalled`,
`partialOutput`, `silentSec` and `willRetry`. `bullswarm workflow
watch` renders `retrying on another pool` only when `willRetry` is true;
otherwise it says `no retry left`.

## Placing a review

In new runs, Bullswarm does not move a review away from a writer on its own.
Place it with the step's optional `route`; `route` is a hard filter before
quota pacing. Use `independentOf` to avoid providers that worked on named
upstream steps, or use `"writers"` on a check with `evidenceFor`. Use
`providers.use` / `providers.avoid` to select provider families, or
`pools.use` / `pools.avoid` for exact pool ids. Accounts served by one provider
count as one family. A route that leaves no free pool sends the step back to
you at once, as no eligible pool or with each pool's reason; it never waits.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    { "id": "write-docs", "role": "produce", "purpose": "Write docs", "dependsOn": [], "affects": ["requirement-1"], "ownedFiles": ["README.md"], "evidenceFor": [], "prompt": "Write README.md." },
    { "id": "review-docs", "role": "check", "purpose": "Review docs", "dependsOn": ["write-docs"], "affects": [], "ownedFiles": [], "evidenceFor": ["requirement-1"], "route": { "independentOf": ["write-docs"] }, "prompt": "Check README.md against the requirement." }
  ]
}
```

Saved runs keep the former automatic writer avoidance, including its independence
tie-breaker and urgency waiver. A selected gate retry says `pinned to <pool>
(the same pool (gate retry))`; a manual restart says `pinned to <pool> (step
restart)`. Route constraints appear as `route: <summary>` in the reason.

## A pinned pool says it was pinned

`bullswarm workflow goal --worker-pool <pool>` reduces the candidate list to one pool before routing runs, so no comparison happens. The reason opens with the pin rather than describing a choice:

```text
pinned to codex (--worker-pool) · surplus 12.3, 5h used 44%
```

Before this, a pinned evidence step read `evidence step: only the writer pool codex is eligible` (seen on run `uamgfi`, attempt `accept-1`), which blamed eligibility for what the operator had chosen.

## Expiring-soon urgency

A pool whose pacing window resets within 24 hours (weekly) or 3 days (monthly) is ranked on urgency — its surplus divided by the fraction of the window still to run — instead of on the surplus alone. While any urgent pool can still spend its quota, it is the only one selectable, which is how a pool with two hours left beats a pool with three days left. A pool forecast at or above 95% of its pacing window *and* ahead of the window's own clock (forecast above the elapsed share) is `draining` and goes last; a pool at 96% with 98% of its month gone is spending at its own pace, not draining, and keeps its quota in play until the reset. In a workflow started by this version a `draining` pool does not go last: it is never given a step, the dispatched planner or the preflight scout, even as the only pool left, unless you pinned it. The work goes to another pool that can run it, or comes back to you with `<pool> nearly spent (forecast <n>%) until <time>` in its `why`.

## In-flight load

Work already dispatched is charged against a pool before the next pick: each pool's effective surplus is its pace minus what its in-flight agents and the candidate are expected to spend. When the pacing window has a measured rate, each timed in-flight record is charged at `rate × remaining minutes` with no floor. A pool with no measured rate uses the flat `config.inflightPenaltyPct` tie-breaker in `~/.bullswarm/state.json` (default 3; `0` turns it off); a measured pool uses that value only for an in-flight record whose remaining duration is unknown. A busier pool therefore yields to a quieter one at similar pace.

## Assignments and incumbency

Two preferences apply only among pools that survived the steps above. An explicit effort-tier assignment (`bullswarm strategy assign <tier> --pool <p> --model <m>`) wins if that pool is selectable — it is a preference, never a bypass of eligibility or the gates. Only `assign` makes one: `strategy apply` and `setup --yes --strategy` set each pool's model per tier and pin nothing, so an unpinned tier is picked by surplus at every dispatch. Otherwise the pool that last succeeded in that lane keeps it, unless a challenger beats its effective surplus by 10 points and is no more expensive; an incumbent at −20 surplus or worse forfeits that protection, and one carrying more in-flight work than the challenger loses it too.

## The caller

The agent CLI that invoked Bullswarm competes as a pool like any other, and `keepOnClaude: true` in a verdict means it won or nothing else was eligible. It is never protected: it has to win on merit. `--no-caller` removes it from the field, so the task must go to a delegate or fail.

## When a pool runs out

Bullswarm never remembers a spent or dead pool from one step to the next:
nothing pauses or benches a pool. Every pick reads the live meters instead, so
a window at 100% keeps a pool out until that window resets, and nothing else
does.

In a workflow started by this version, nothing waits for a pool. A usage limit
ends the step and sends it back to you at once: a limit notice that says a
usage window, a quota or a balance is spent (with or without a reset named), or
the pool's meter showing its window full. There is no wait, no move to another
pool and no retry, and the rest of the run keeps going. The needs-you block
shows `back at <time>` when the pool's reset is known.

A transient rate limit (`Too many requests`, `Rate limit exceeded`, with no
usage window spent) backs off on the same pool at most twice, after 20 s and
then 60 s, or after the wait the provider named when that is at most 2
minutes. It spends no retry. Then the step comes back to you. One that names a
longer wait comes back to you at once, with `back at` at the end of that wait.
When the pool is no longer free for the backoff (it reached a 5-hour, weekly
or monthly limit, or it is nearly spent), the step comes back to you instead
of moving.

After a usage limit (here and in a single `bullswarm run`) the pool's meter is
read again at once. When it cannot be read, the pool counts as full until its
reset, but only when the provider named that reset or an earlier meter reading
gave it; with no known reset nothing keeps the pool out. Later steps route on
that reading: a window it shows at 100% keeps the pool out until that window
resets, while a lower reading leaves the pool eligible.

When no pool that can run the step is free at its pick (each one is nearly
spent, or at a 5-hour, weekly or monthly limit), the step comes back to you as
well: as `quota` when every reason is a usage limit, else as `unavailable`. Its
`why` names each pool and its reason, for example `no pool with quota to
spare: pool-a at its 5-hour limit until <time>; pool-b at its weekly limit
until <time>`, and `back at` is the earliest known return among them. A retry
the step was promised (after a crash, a sign-in failure or a failed gate) that
finds no free pool keeps its own failure and ends its `why` with `· no retry:
<pool> <reason>; …`. When another pool that can run the step is free, routing
picks it as usual.

The dispatched Workflow Planner (`--orchestrator`) and the preflight scout
(`--scout`, or the scout before a dispatched planner) follow the same rule: a
usage limit, a rate limit still there after its short backoff, or no free pool
at the pick stops it and tells you, with no move to another pool. The run
finishes with `the workflow planner stopped on a usage limit: …` (or `the
preflight scout stopped on a usage limit: …`) and your call: after its `back
at` time, `workflow resume` runs it again. A scout that ran before your own
program lets the run go on without its report. A sign-in
failure, a provider error or a worker that died at start still moves the
planner or the scout to another pool.

A single `bullswarm run` makes one attempt: a usage limit ends it with exit 1,
with no retry and no move. Workflows started by an earlier version keep their
rules: a usage limit moves the attempt to another pool, and a throttle retries
the same pool and then moves, as below.

## Throttles and exhausted windows

A limit notice that says a usage window is spent is failure kind `quota`
(never `process` or `auth`). In a workflow started by an earlier version that
holds only when the reset is known — the provider's line named it, or the
pool's own meter reads 95% or more on a window still running — and without one
the notice is a throttle there. The attempt is killed immediately even if the
CLI would otherwise hang, and the pool's meter is read again as above. In a
workflow started by this version the step then comes back to you; in one
started by an earlier version the action moves elsewhere.

Every other limit notice — `Rate limit exceeded. Please wait a moment and try again.`, `429 Too Many Requests`, an overload — is failure kind `throttle`. In a workflow started by an earlier version the dispatcher retries the same pool up to twice, after 20 s and then 60 s (or after the wait the provider named), without a mechanical-retry charge; after that the attempt moves to another pool. A throttle that names a wait longer than 15 minutes skips the same-pool retry and moves at once. In a workflow started by this version a window phrase with no reset is a usage limit instead (`quota`), and a throttle never moves: it backs off at most twice, for at most 2 minutes each time, and then comes back to you (see above). A single `bullswarm run` records the throttle but does not retry it. Detection is shape-gated to provider notices, so an agent writing *about* rate limits does not trigger either path.

## A sign-in failure upstream

A relayed credential fails upstream, not in the CLI. When a provider's event stream reports `auth_unavailable`, `authentication_error`, `invalidated oauth token`, `no available channel for model`, or a phrase the connector declares in `authSignatures`, the verdict is failure kind `auth`. The step's one automatic retry then goes to a pool that does not share that credential: every pool in the same credential group (`credentialGroup` in the connector) is skipped for the rest of that step, so the retry never walks from one name to the next on the same dead credential. Nothing is stored: the next step routes as usual and can pick that pool again. A usage limit skips no other pool, because one seat's window says nothing about the next.

## How the decision shows its work

`bullswarm pools` prints one line per pool: `cost=`, `lanes=`, the meter it is paced from, `surplus=`, `inflight=`, the 5-hour column as `5h=<reading>%-><projected>%` with `(<n>% elapsed)`, `free=<model>` when its model costs nothing, then `ready`, `disabled`, `NEAR-5H-LIMIT`, `BURST-GATED`, or `resets in … EXPIRING-SOON urgency=<n>`. `pools` names no lane and therefore no effort tier, so when free-ness differs per tier the column names each one — `free=medium:opencode/union-alpha`. A stale meter held after a failed poll is marked `[stale · <status-or-kind>, retry in <time>]`; `pools --json` carries the same `meterError` and `meterHoldUntil` fields.

### Pool display labels

Pool ids are durable because credentials, meters, routing pins, history and
workflow records refer to them. To shorten only what people see, set a unique
per-home label:

```bash
bullswarm pools label claude-code:acme claude-code:a
bullswarm pools label --list
bullswarm pools label claude-code:acme --clear
```

Labels contain no spaces, cannot equal another pool id, and are stored in
`$BULLSWARM_HOME/pool-labels.json` (default `~/.bullswarm/pool-labels.json`).
Human CLI output, progress lines, every dashboard page, and the Claude Mod use
the label. Commands that take a pool accept either the label or id. JSON keeps
the durable `pool` id and adds `poolLabel` beside it on pool-bearing list rows.

```text
answerer       cost=3 lanes=analyze/build/chore unmetered surplus=0 inflight=0 ready
opencode       cost=1 lanes=analyze/build/chore unmetered surplus=0 inflight=0 free=opencode/union-alpha ready
```

```bash
# every pool, with its meter, pace, load, and any spent window
bullswarm pools
# what is in flight right now, across every Bullswarm process
bullswarm assignments
# the pick this task would get, with the forecast behind it
bullswarm run --lane analyze --add-dir . --dry-run "Explain the parser"
```

`bullswarm run --json` carries the candidate rows that decided the pick, in preference order: `pace`, `effectiveSurplus`, `inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `ratePerMinute`, `estimateSource`, `nearFiveHourPenalty`, `forecastOverLimit`, the compatibility `forecastGated` flag (always false now), and the urgency fields. `bullswarm pools --json` reports the same numbers per pool, plus the spend rates they came from. Those rates pair retained meter readings with dispatched worker-minutes; until at least 5 worker-minutes are attributable to a window there is no rate at all, and routing falls back to the flat penalty.

## Worked example

Four of the lines from `bullswarm pools` on a machine with two Claude accounts, a Grok subscription, a Codex CLI with no usage reader, and a disabled echo pool:

```text
claude-code      cost=4 lanes=analyze/build/chore weekly used 31% elapsed 26.3% [cache] surplus=-4.7 inflight=0 5h=27% (54% elapsed) ready
claude-code:acme cost=4 lanes=analyze/build/chore weekly used 30% elapsed 65.6% [cache] surplus=35.6 inflight=0 5h=15% (44% elapsed) ready
codex            cost=3 lanes=analyze/build/chore unmetered surplus=- inflight=0 disabled
grok             cost=2 lanes=analyze/build/chore weekly used 74% elapsed 72.5% [cache] surplus=-1.5 inflight=0 ready
```

`claude-code` has used more of its week than the week has run, so its surplus is negative; `claude-code:acme` is 65.6% through the week having spent 30%, so it holds +35.6 points of expiring quota. `codex` has no reader, so it is `unmetered` (`surplus=-`) rather than assumed idle, and it does not dispatch while disabled.

A dry run against this state picked grok and said why:

```text
OK [grok] most-behind capable pool (surplus -2.1)
forecast: inflight=0 5h ?%->?% expected=5.67m rate=unmeasured basis=bootstrap
```

Grok won because it was the only pool left: this `analyze` task resolves to the medium effort tier, whose allow-list names a model only on grok and codex, and codex is disabled — eligibility runs before any pace comparison, so the +35.6 on `claude-code:acme` never entered the race.

When a pool is near its line and still gets the work, the reason says so in the same line — `last mile: claude-code:acme 88.1% of 5h, a limit mid-attempt goes back to the caller`. A forecast beyond the wall is explicit too — `forecast over 100% (still eligible; ranked last): …`. Other explanations remain in the same line, such as `expiring but draining (forecast >= 95% and past its clock): grok 99.5% (98.8% elapsed)` or `preferred over busier: … (2 in flight)`.

## Next steps

- [Run one task](/guide/run) — the command whose routing this page explains.
- [Concepts](/guide/concepts) — surplus, windows, and verdicts as definitions.
- [Observing runs](/guide/observing) — watching a run once it is dispatched.
