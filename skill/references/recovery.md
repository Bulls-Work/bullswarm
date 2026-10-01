# Recovery: when a run needs you

Read this when a watch wakes you with trouble: a step that needs you, a usage
limit or no free pool, a rate limit, a step that looks stale, or a run that
ended `partial`; or when you want to pause, restart or stop. Every block below
is real output. In each case: choose one printed option, run it as printed,
then start the `next:` watch line again.

## The failure rule

A failed step gets one automatic retry in total, then it comes back to you in
a needs-you block. A process failure (crash, silence, sign-in failure
(failure kind `auth`), provider error, a worker that died at start) retries on another eligible pool
(the same pool when it is the only one, except after a sign-in failure). After
a sign-in failure the retry also skips every pool that shares that credential,
for that step only; nothing is stored. A gate failure (`failed-evidence`,
`not-produced`, `schema`, or `semantic`) retries on the same pool with the
failure attached; a gate retry spends the same one-step budget. A failed
check or deliverable whose report lists `- outside: <blocker>` under
`## Not done` (something the step may not change) skips its retry and comes
back at once.

A step with `retry: 0`, a started outward (`act`) step, a usage limit, a check
that could not run, and a step no pool can run come back at once (`not
retried`). Only a failed step's dependents wait; other branches finish. Runs
started earlier keep their saved rules.

## When a step needs you

A real block:

```text
✗ lint needs you · command evidence failed after 1 retry
  evidence  test -f LINT-OK.md → exit 1
  try 1  grok · grok-4.7 · 2m33s · 0 files
  try 2  same pool, failure attached · 1m33s · 0 files
  waiting on this: summary
  your call:
    retry here       bullswarm workflow step rerun hkbbbi lint
    add steps        bullswarm workflow add hkbbbi --steps part.json
      then wait      bullswarm workflow wait hkbbbi <added ids>
    take over        output: /private/tmp/v37e/home/workflows/wf-muli1jve-d48ab9/out-lint-attempt-2.md · diff: /private/tmp/v37e/home/workflows/wf-muli1jve-d48ab9/diff-lint-attempt-2.txt
    accept anyway    bullswarm workflow step accept hkbbbi lint --reason "…"
  next: bullswarm workflow watch hkbbbi --until trouble --after <sequence> --since <iso>
```

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another eligible pool may succeed | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>`; the pool stays excluded in the step's route |
| `retry here` | printed instead when no other pool could run the step | `bullswarm workflow step rerun <shortId> <step>` |
| `add steps` / `then wait` | the step must be done differently: a v3 run's steps are never edited, so add a new one | `bullswarm workflow add <shortId> --steps part.json`, then `bullswarm workflow wait <shortId> <added ids>` |
| `take over` | the rest is small or needs something only you have | read `output:` (and `diff:`) and do the work yourself |
| `accept anyway` | you keep the failed result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"`: recorded as your choice, never proof; rerunning the step undoes it |

A review block (a saved v2 run) names the check that judged the failing
requirement; another check that failed one follows as `also judged by
<check>:` with its own rerun and accept lines.

A `step rerun` or `resume` after a failure the pool caused (a sign-in failure,
a provider error, a worker that died before answering) starts on another pool
when one can take the step, and on the same pool only when none can; this
changes nothing in the route. A usage limit is not one of these: a rerun after
one is routed as usual, and `--avoid <pool>` keeps it off that pool.

## A usage limit or no free pool

A usage limit ends the step: a spent 5-hour, weekly or monthly window, or no
credit left. The step comes straight back to you in a needs-you block (`✗
<step> needs you · out of quota …`, failure kind `quota`), even when the notice
names no reset (its block then prints `back at` only when every pool that can
run the step is out and one of them has a known return). Nothing waits, moves
to another pool or retries by itself, and the rest of the run keeps going.
Bullswarm never remembers a spent or dead pool from one step to the next:
nothing pauses or benches a pool. The pool's meter is read again at once (when
it cannot be read, the pool counts as full until its reset only when the
provider named that reset or an earlier meter reading gave it), and a window
it shows at 100% keeps the pool out of later steps until that window resets.

The same happens when no pool that can run the step is free when it is picked
(each one is nearly spent, or at its 5-hour, weekly or monthly limit): the step
comes back as `quota` when every reason is a usage limit, else as
`unavailable`. Its `why` names every pool and its reason (`no pool with quota
to spare: <pool> at its 5-hour limit until <time>; …`, `<pool> at its weekly
limit until <time>` (or `monthly`), `<pool> nearly spent (forecast <n>%) until
<time>`, or `no pool free: …` when a reason is not a usage limit, and the
header then reads `no eligible pool`). A retry the step was promised (a
process or gate retry, or a backoff) that finds no free pool keeps its own
failure, and its `why` ends `· no retry: <pool> <reason>; …`. A pool about to
run out before its window resets is never given a step it would push over;
when another capable pool is free, routing picks it as usual.

A short "too many requests" rate limit is not a usage limit (failure kind
`throttle`). It backs off on the same pool at most twice (20 s, then 60 s, or
the wait it names when that is at most 2 minutes), then comes back to you (`✗
<step> needs you · rate limited · backed off twice`). A try after a backoff
reads `· after a rate-limit backoff`, and the block's header counts the
backoffs (`backed off twice`); a backoff never spends the retry. One that
names a longer wait comes back to you at once, with `back at` at the end of
that wait. One whose pool is no longer free for the backoff (at its 5-hour,
weekly or monthly limit, or nearly spent in the meantime) comes back to you at
once too: as `out of quota` when that pool is out on a usage limit, with `back
at` its return when that is known. A sign-in failure, a provider error or a
worker that died at start still gets the step's one automatic retry by itself,
on another free pool when there is one. After a sign-in failure that retry
skips every pool that shares the credential; nothing is stored, so a later
step can pick that pool again. A model the pool's plan lacks (`model not in
plan`) retries on another pool, and that pool never gets that model again
until `strategy include-model <model>`.

After a usage limit a full watch prints `⚠ <step> usage limit on <pool> · back
to you` (the attempt carries no return time, so the line names none), then the
needs-you block, which carries the return time as `back at <time>` when it is
known. When a return time is known, for this or any other failure, the block
prints `back at <time>`: the failed pool's reset, the end of a rate limit's
named wait, or, when no pool was free, the earliest known return among the
pools that can run the step. It then adds one option:

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another pool can run the step now | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>` |
| `wait for it` | the step should run on that pool, or nothing else can run it | `after <time>: bullswarm workflow step rerun <shortId> <step>`: run that rerun yourself after the `back at` time; before then the pool is still out |
| `accept anyway` | you keep the step's result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"` |

`add steps` and `take over` are printed too. With `--jsonl` these are `backAt`
and `options.waitForIt`. Runs started earlier print no `back at`. To stop the
whole run instead, run `bullswarm workflow cancel <shortId>`.

A saved run from 0.37.x may show a stopped dispatched planner or preflight
scout (`✗ planner stopped · …`, `⚠ preflight scout stopped · …`, or a result
reading `the workflow planner stopped on a usage limit: …`). 0.38.0 removed
both, and the run is view-only: its `your call:` text was written when it
finished, so start a new v3 run instead of following it.

## A step that looks stale

For each running attempt the watcher computes a stale score. It uses the
attempt's persisted event stream (`stream-<step>-attempt-<n>.jsonl` and its
`.tail` segment) and the modification times of the step's `files`:

| Signal | Fires when | Weight |
|---|---|---|
| quiet | no event for 10 minutes while no command is in flight (a command still running is excluded; without an event stream it is plain output silence) | 2 |
| no file change | a step that writes (it owns files or is `build`, and is not a check) changed no file for 20 minutes while at least 5 commands ran | 1 |
| repeat | the same command 3 times in a row with no file change between | 1 |
| wall | running longer than 3× the router's expected minutes for its lane and effort (`routing.forecast.expectedMinutes`) | 1 |

While Bullswarm runs a step's declared checks, only quiet counts, read from
the checks' heartbeat: `no check heartbeat for <N>m`.

At a score of 2 the watcher prints `⚠ <step> looks stale: <reasons>` once per
attempt. The line wakes `--next` and `--until trouble`, and the human `next:`
block adds `or restart: bullswarm workflow step restart <shortId> <step>`. The
`attempt.stale` JSONL object carries `reasons`, `score` and `staleSince`.
Nothing is stopped for you: let it run (start the `next:` watch again), or
restart that one step rather than cancelling the run.

`bullswarm workflow step restart <shortId> <step> [--pool <pool>] [--wait <seconds>] [--json]`
writes `restart-<step>.json` next to the run. The live kernel applies it within
about a second. It stops that step's running attempt only; the attempt ends
`cancelled` with `failureKind: restarted`. The step goes straight back to
pending, never through a terminal state, and the kernel emits `step.restarted`.
The next attempt carries the stopped attempt's `## Prior attempt on this step`
handoff block (pool, times, files changed, diff stat, output so far, last
response events), the same block a mechanical retry carries. `--pool` pins
that next attempt to one configured pool; when that pool cannot run the step,
the step fails with no eligible pool rather than moving elsewhere. The intent
file is removed once the next attempt starts, so a kernel that dies in between
still hands off on resume. The command exits 1 and writes nothing when the run
is finished, the step is not running, or the kernel is not running (`resume`
restarts interrupted steps with their handoff). A step that finished before the
kernel took the request is refused (`step.restart_refused`, exit 1). In a
shared workspace the stopped attempt's edits stay. In an isolated one, its
workspace is retained for review and the new attempt starts fresh with the
handoff.

A worker silent for `BULLSWARM_WORKER_SILENCE_SEC` (default 3600 seconds) is
stopped as `stalled`. The cutoff measures silence, not run time: every byte a
worker writes restarts it. Shorter silence is evidence to inspect, not proof
of a hang.

## Pause, resume and cancel

```bash
bullswarm workflow pause  <shortId>          # drain: running agents finish, nothing new starts
bullswarm workflow pause  <shortId> --now    # stop running agents too; they requeue
bullswarm workflow resume <shortId>          # lift the pause and continue
bullswarm workflow cancel <shortId>          # stop the run
```

A pause is an intent file the kernel honors at its next loop
(`workflow.pause_requested`, then `workflow.paused`), after which the kernel
exits and watchers print `outcome: paused`. Steps stopped by `--now` finish as
cancelled with `failureKind: paused` and return to pending. While paused, add
steps as often as needed with `workflow add`; only `resume` continues the run.
`resume` before the kernel reached the pause withdraws the request
(`workflow.unpaused`) and the run never stops. `cancel` on a paused run
finalizes it inline. A pause on a finished run is refused. `watch --until
trouble` wakes on a pause.

Use cancellation only for a genuinely hung or no-longer-authorized run. A
stopped step's file edits stay in the shared tree; when they must not remain,
add a step that reverts them. Exit 0 can mean launched, waiting, paused or
completed, so always read the returned status.

## When it finishes

A partial run lists each unfinished step (`step <id>: <status> (<kind>) —
<why>`, with `its pool is back at <time>` when that is known) and your options
under `your call:` (real output):

```text
  step lint: failed (failed-evidence) after 1 retry — test -f LINT-OK.md → exit 1
  step summary: blocked (dependency) — failed dependency
your call:
  add       bullswarm workflow add hkbbbi --steps part.json, then bullswarm workflow wait hkbbbi <added ids> (appends steps, gates or loops and reopens the run)
  rerun     bullswarm workflow step rerun hkbbbi lint [--avoid <pool>] (runs it again with its last attempt's handoff)
  accept    bullswarm workflow step accept hkbbbi lint --reason "…" (recorded as your choice, never proof)
  take over do the unfinished work yourself; bullswarm workflow runs result hkbbbi --json names every step's output
  restart   start a new run: bullswarm workflow goal "<goal>" --cwd /private/tmp/v37e/acme --program <file.json>
```

| Printed option | When | What to do |
|---|---|---|
| `add` | new work is needed, or a step must be done differently | `bullswarm workflow add <shortId> --steps part.json`, then `bullswarm workflow wait <shortId> <added ids>`; the run reopens |
| `retry` | a step stopped for a reason a retry fixes: a crashed or silent worker, a usage limit, or no pool free | `bullswarm workflow resume <shortId>` (run it after its `back at` time) |
| `rerun` | a step failed | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>]` |
| `accept` | you keep a failed step as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"` |
| `take over` | the rest is small, or needs something only you have | do it yourself; `bullswarm workflow runs result <shortId> --json` names every step's output |
| `restart` | the goal or the approach was wrong | `bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` |

`retry` appears only when a step is retryable. When nothing is retryable,
`resume` prints `nothing to retry`, starts nothing, and exits 1. The handback
fields behind these lines are in [operations.md](operations.md) ("When a run
finishes: the handback").

**An accept is a choice, never proof.** `step accept` lets the step's
dependents run, and the step reads `accepted by choice` and is counted apart
in the proof line (`N accepted by choice: <steps>`). Report it as your
decision, never as verification. `step accept` on a failed step inside a
loop does not end the loop (the next round still starts); to stop a loop
early let it run out of rounds (`maxRounds`), then
`bullswarm workflow continue <shortId> <loop>`, which is recorded as
condition not met.

## Other stopping rules

- A provider usage limit is the distinct failure kind `quota`: the attempt is
  killed at once. In a single `bullswarm run` too, the pool's meter is read
  again at once and a window it shows at 100% keeps the pool out of later
  work until that window resets; nothing else is remembered about the pool.
  Runs started earlier moved the action to a pool that still had quota.
  Discussing usage limits in a report is not a usage limit.
- A step's answer that fails its schema, or evidence that fails, uses the
  step's one retry, then the needs-you block hands it back. Nothing repairs on
  its own: fixing until a check passes is a loop you declare.
- `files` naming a directory or a glob is refused at `plan validate` and at
  launch, and so is a pinned pool that cannot run a step's lane and effort.
