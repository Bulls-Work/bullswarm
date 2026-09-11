---
title: Routing
permalink: /guide/routing/
---

This page gathers every routing rule that decides which pool runs a given
piece of work — pace, 5-hour headroom, expiring-soon urgency, in-flight load,
and quarantine — in one place. A **pool** is one installed agent CLI, or one
account of that CLI. A **lane** is the nature of the work (`analyze`, `build`,
or `chore`). The source of truth is the numbered doctrine comment at the top
of `src/lib/route.js`; this page restates it in prose.

## The rules

- **Lanes are work nature, never a hard-coded map.** `analyze`, `build`, and
  `chore` describe what kind of work an action is; pools declare what they can
  do, and the runtime picks among capable pools at dispatch time — there is no
  fixed lane-to-pool table.
- **Pace is time-adjusted: surplus = elapsed% of the window − used%.** The
  pool furthest behind its own pace (highest surplus) wins, because quota
  piling up unspent is expiring money.
- **Incumbency margin.** A pool already doing the work keeps it unless a
  challenger beats its surplus by a fixed margin (`INCUMBENCY_MARGIN`, 10
  points) — this stops the router from flapping between two pools of similar
  pace.
- **Cost guard.** On the incumbency path only, pace may move work to a
  challenger pool solely when that challenger is also cheaper.
- **The caller wins its own lane only when nothing else is eligible.** The
  caller is the agent CLI that invoked Bullswarm. It has to win on the merits,
  not be protected by default.
- **Exhaustion and quarantine.** A pool at 100% used is exhausted. A
  quarantined pool is ineligible until its quarantine expires, at which point
  it re-probes automatically — a lane is never allowed to silently stay down
  because one pool is benched.
- **5-hour headroom outranks pace.** A pool at or above the near-limit line of
  its rolling 5-hour window, *and* ahead of that window's own elapsed share
  (see the clock-relative rule below), is chosen only when no eligible pool
  below the line exists for the lane; this outranks even an explicit
  assignment or incumbency, because dispatching to a near-limit pool anyway
  just spends the next attempt on a quota failure.
- **Route on the forecast, not the last reading.** A meter reading is already
  stale by the time it is read — quota spent seconds ago has not been
  reported yet, and the work being routed now will spend more. So the 5-hour
  and pace tiers apply to a projection: the reading, plus what a pool's
  in-flight work is still expected to burn, plus this candidate's own expected
  consumption. A pool whose projection crosses the block line is left out of
  selection entirely; if every capable pool is projected over the line,
  routing still names the least-loaded one rather than stranding the action,
  and says so in the reason. A pool with no measured rate is never penalized
  for a number nobody produced.
- **Load beats incumbency.** Within a tier, a pool already carrying in-flight
  work yields to a quieter pool of similar pace: each pool's surplus is
  reduced by the quota its in-flight agents (and this new assignment) are
  expected to spend, and by at least a flat 3 surplus points per in-flight
  agent as a floor — under a third of the 10-point incumbency margin, so it
  separates pools of similar pace without ever overturning a real quota
  difference; a six-minute agent, at real rates, projects to well under one
  point, which is why the floor is what actually spreads work. The charge is
  labeled `penalty` when the floor set it and carries its measured basis
  (`history`, `bootstrap`) when the projection was larger. An incumbent
  carrying more in-flight work than a challenger keeps neither its 10-point
  margin nor its cost guard, so a burst of parallel actions spreads across
  pools instead of stacking on the single most-behind one.
- **The near-limit line is clock-relative.** Being at 88% of the 5-hour
  window with 23 minutes left in it is a pool about to get a fresh window, not
  a pool in danger; being at 77% with four hours left is a pool heading for
  the wall. So a pool is only tiered down when its forecast is at or above the
  near-limit threshold *and* above the percentage of the window already
  elapsed. Spend that would land after a window's reset is credited to the
  next window instead of the current one when charging the forecast; the
  underlying pacing penalty (weekly/monthly) is never clipped this way.
- **Expiring-soon urgency.** A plain pace surplus is a point difference and
  says nothing about how long a pool has left to spend it. A pool whose own
  pacing window (not the 5-hour window) resets within a fixed lead time —
  about a seventh of a week for weekly pools, a tenth of a month for monthly
  ones — is ranked on *urgency* (its surplus divided by the fraction of its
  window still left to run) instead of on raw surplus. An urgent pool with
  spend still forecast to land under the block line ranks ahead of every pool
  that isn't expiring soon; one already forecast over the line ranks last and
  is picked only as a fallback; one that's merely expiring soon but still
  ahead of pace ranks normally. Urgency overrides incumbency and a configured
  effort assignment, but never overrides a strict pin, and never rescues a
  pool already tiered down by the 5-hour rules.

## How dispatch shows its work

An assignment from `bullswarm strategy assign` is only a preference:
quarantine, exhaustion, burst gates, 5-hour headroom, and capability checks
still win. Routing prefers pools that are not near-limit over pools that
are, ahead of pace, an approved assignment, and incumbency. A pool is
near-limit when its 5-hour forecast is at or above `FIVE_HOUR_NEAR_LIMIT_PCT`
(75) *and* ahead of that window's elapsed share. A near-limit pool is still
picked when it is the only eligible one, and a pool with no 5-hour reading
counts as having headroom.
The routing reason and every candidate row name the utilization that decided
the pick, and meters and quarantines are re-read before each dispatch — and
again, live, right after a usage limit — so a long run never routes off the
snapshot it launched with.

Those thresholds apply to the forecast, not the last reading: a pool
projected at or above 75% *and* ahead of the window's elapsed share drops to
the near-limit tier even while its reading is lower, and one projected at or
above `BURST_BLOCK_PCT` (90) is left out of selection entirely as
forecast-gated. The 90% burst gate ignores the clock.

`bullswarm pools` shows each pool's `inflight=<n>` count and its 5-hour column
as `5h=<reading>%-><projected>%` whenever in-flight work is expected to move
it, `bullswarm assignments` lists what those agents are, `bullswarm run
--dry-run` prints the forecast the pick was made on without registering
anything, and every candidate row carries `pace`, `effectiveSurplus`,
`inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `ratePerMinute`,
`estimateSource` and `forecastGated`, so a surprising pick can be read back
number by number.

The rates behind pace and forecasting come from real records: every live meter
reading is retained as a capped per-pool series
(`~/.bullswarm/meters/history/<pool>.jsonl`) and paired with the worker-minutes
dispatched between readings. Until at least five worker-minutes of dispatch are
attributable to a window there is no rate at all — `null`, not a ratio of
percentage points to seconds — so a fresh machine routes on pace and the flat
penalty until it has measured something. That penalty is
`config.inflightPenaltyPct` in `~/.bullswarm/state.json` (default 3; `0` turns
the tie-breaker off).

## Quarantine on a usage limit

A provider that reports a usage limit — `You've hit your session limit ·
resets 8:20pm (Asia/Hong_Kong)`, `usage_credits_required`, `rate limit
exceeded`, `quota exceeded` — is its own mechanical failure kind, `quota`,
never `process`, `semantic`, or `auth`. The attempt is killed immediately
even if the CLI would otherwise hang, and the pool is quarantined until the
reset time parsed from the message, falling back to that pool's cached 5-hour
`resets_at` and then to 30 minutes. The quarantine record carries
`kind: 'quota'` and excludes the pool from every later dispatch, in this run
and in others, until it expires; the action is immediately re-dispatched on
another pool with quota and never retried on the one that hit the limit. An
agent report that merely discusses usage limits, or tool output that quotes
them, is not a limit: detection is shape-gated to lines that look like a
provider notice. (`bullswarm workflow watch` surfaces this live — see
[Dashboard](./dashboard.md).)
