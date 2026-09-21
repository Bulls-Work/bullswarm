# Bullswarm operations reference

There are exactly two ways to start work: `bullswarm run` for one bounded
outcome, and `bullswarm workflow goal` for a program you author. Decide the
shape yourself — there is no preview or classifier command. Read this reference
only after that decision, when the task needs direct commands, workflow
operation, or recovery.

Unrecognized `--flags` are a usage error on every command: Bullswarm prints
`unknown flag --name` plus that command's synopsis and exits 2, before
self-initializing, routing, or spawning anything.

## Autonomous workflow execution

`workflow goal` needs a program: the calling agent is the Workflow Planner
unless it asks for a dispatched one. The three ways to start:

```bash
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --program plan.json --json  # you plan (see below)
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --scout                     # kernel surveys, then finishes and hands you the report
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --orchestrator auto \
  --suggested-plan='<conceptual plan>' --json                                # dispatch a planner agent
```

With none of those the command exits 2, launches nothing, and prints the next
commands (`{"error": "program-required", "next": {...}}` under `--json`).

The default launch detaches and returns `shortId`, exact observation commands,
and log paths. Normal callers should leave pool/model selection automatic.
Pins such as `--orchestrator <pool> --orchestrator-strict`,
`--orchestrator-model`, `--worker-pool`, and `--worker-model` are for
controlled QA, not ordinary routing. `--suggested-plan`, `--no-scout`, and the
`--orchestrator-*` pins apply only with `--orchestrator`; when you are the
planner, the plan is the program. `--strict-orchestrator <pool>` is a
deprecated alias for `--orchestrator <pool> --orchestrator-strict`.

Observe and consume:

```bash
bullswarm workflow watch <shortId> --until trouble                     # the standard: one background watch per run
bullswarm workflow watch <shortId> --until trouble --after <sequence> --since <iso-timestamp>
bullswarm workflow watch <shortId> --until outcome                     # trouble lines print; only the outcome ends it
bullswarm workflow watch <shortId> --next
bullswarm workflow watch <shortId>
bullswarm workflow step restart <shortId> <step> [--pool <pool>]       # your answer to a `looks stale` line
bullswarm workflow tui <shortId>
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow runs result <shortId> --json --summary
```

Use the compact summary in the status loop. Read the full envelope with `--json` alone when the run is failed or partial, or before judging evidence.

Watch without waste. Start one `bullswarm workflow watch <shortId> --until
trouble` per run in the background and do nothing about the run until it
exits. It prints no attach line and no routine lines. It prints only trouble:
failed or blocked steps, evidence that rejected a requirement, rejected plan
revisions and planning attempts, pause requests and pause stops, stalled
workers, stale steps, and steering received. It exits on the first trouble line
while the run goes on (exit 0). It also exits on the outcome: finished, paused,
waiting, or interrupted, with the usual exit codes. Each exit is one wake: read
it in one tool call, act, and start the printed
`next: bullswarm workflow watch <shortId> --until trouble --after <sequence> --since <iso>`
again. Do not poll between wakes, do not read the run directory, and do not
send a status reply per step. `--until outcome` prints the same lines but ends
only at the outcome. `--until` cannot combine with `--next`, `--once`,
`--classic` or `--heartbeat`. Under `--until`, the raw `silent for` line is
replaced by the stale score, because a long command is not silence.

Without `--until`, V2 watch prints one attach line, then one line per notable
event, and stays silent while work is merely in progress. `--next` prints no
attach line, exits after the first poll that printed a notable event (a
finished step included), and ends with
`next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>`.
Relaunch with those exact `--after` and `--since` values. Events committed
while no watcher was attached are then printed rather than skipped, and an
already-reported stall or stale step does not fire again (a stall's recovery
still prints). With `--jsonl` that line is absent: take `--after` from the
`sequence` field carried by every emitted object. `--heartbeat` is opt-in for V2 (legacy still
defaults to 60s). `--stall-after` (default 300s) reports a silent running
agent. A usage-limit failure always prints, verbose or not: `⚠ ... usage
limit on <pool> · paused until <deadline> · retrying on another pool`, then
`↺ ... now on <pool> · <model>` once the mechanical retry lands on another
pool. Use `--verbose` only for diagnosis. `--classic` forces the older
heartbeat-based watcher (transition-on-change snapshots plus a periodic
heartbeat) instead of event mode; it applies only to V2 runs. A legacy
authored-graph run cannot be watched at all: the watcher prints the legacy
line and exits 2 before polling. `--classic` cannot combine with `--next`.
The result command is the stable delivery/verification envelope; do not scrape
task files or assume the last provider response is the deliverable. A finished
run's watch output ends with `outcome: <status> · verified|not verified`,
`reason:`, the handback lines and `your call:` options (see "When a run
finishes" below); under `--jsonl` the `finished` object carries `verified`,
`reason` and `handback`.

Manage a live run:

```bash
bullswarm workflow plan export <shortId> --out plan.json           # the live plan as an editable revision document
bullswarm workflow plan revise <shortId> --program plan.json --json # replace the plan at any time (see below)
bullswarm workflow pause   <shortId> [--now]                       # start nothing new; --now also stops running agents
bullswarm workflow resume  <shortId> [--foreground|--watch]        # lift a pause, continue an interrupted run, or retry a finished one
bullswarm workflow steer   <shortId> --message '<guidance>'        # guidance for whoever plans the run
bullswarm workflow cancel  <shortId> --json                        # cooperative; a run with no kernel is finalized here
```

Resume keeps the run's durable planner mode, routing pins, and settings;
`--program`, `--orchestrator`, `--scout`, and `--suggested-plan` are rejected
there (change the plan with `plan revise`). Autonomous resume is
V2-only. An old autonomous run ID fails before dispatch; there is no migration
or fallback executor. `bullswarm workflow goal --resume <shortId>` and
`bullswarm workflow tui --cancel <shortId>` remain as aliases.

Legacy authored-graph runs are listed as read-only rows marked `legacy`; driving
commands fail closed with their short ID and retained run directory.

## Program actions: `kind`, `defaults`, and advisories

The program format itself — fields, kinds, requirement IDs, enforced rules
and an example — is in [program.md](program.md). The same rules are also served
live by the running kernel:

```bash
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

That contract carries the goal's derived requirement IDs, the exact validate
and launch commands with goal and `--cwd` filled in, and any run-wide
`reasoning` override. It is the brief a dispatched planner receives, and the
fallback for a caller whose `plan validate` rejects field names or kinds after
an upgrade.

An action's `kind` names what the work IS and derives its `lane` and `effort`,
so a program states the nature once instead of re-deciding two routing fields:

| `kind` | lane | effort |
|---|---|---|
| `mechanical` | chore | low |
| `io-read` | analyze | low |
| `digest` | analyze | low |
| `check` | analyze | medium |
| `implement` | build | medium |
| `integration` | build | high |
| `architecture` | analyze | high |
| `adversarial-acceptance` | analyze | high |

Resolution is per field: an explicit `lane` or `effort` on the action wins,
then the kind table, then an optional program-level `defaults` object — which
may set only `effort` and `reasoning`, since lane follows the individual action
— then the per-lane default. A `kind` outside that closed list is a validation
error, not a runtime failure: `workflow plan validate` exits 2 and nothing
launches. A program using neither `kind` nor `defaults` validates and runs
exactly as before.

`digest` is the one kernel-owned kind: the runtime writes its task from a
template, so the action's own `prompt` is appended as focus guidance only. A
digest reads every dependency output in full and re-emits it condensed and
verbatim — each source's delivered items, validation results with their
numbers, commands and outputs, unfinished work and every shared-file request,
one section per source headed by that source's absolute output path, no
verdicts and no recommendations — targeting at most a quarter of the input
bytes or 8 KB, whichever is larger. Use one when three or more writers feed a
single integrator, or when a consumer's dependency outputs exceed roughly
20 KB. Four rules are enforced at `plan validate` and at launch, each exit 2:
a digest must depend on at least one action, must have empty `evidenceFor`,
must have empty `ownedFiles`, and no evidence action may list a digest in its
`dependsOn` — evidence reads the real artifacts. A consumer that depends on a
digest gets the digest entry in its `Dependency artifacts` list plus a
`digestOf` array naming each digested source, so it can still open the
originals.

Three advisories, none of which rejects anything. `all-writers-high` fires
when three or more `build`/`chore` actions run and none is below high effort;
`docs-at-high` fires when a `build`/`chore` action owns only `*.md` files at
high effort; `requirement-unchecked` fires when a requirement is in no action's
`evidenceFor`, so the run can finish but never verify it. `plan validate --json` carries them under
`advisories` and its human output prints `advisory:` lines; `workflow goal`
prints the same lines at launch. Exit codes are unchanged, and the kernel stores
them on the run, so `workflow runs show` lists them afterwards. `runs result`,
`runs show`, and `workflow action show` print `kind` next to lane and effort.

## Revising a live plan

`plan revise` replaces the plan of a caller-planned program run at any moment:
while agents run, while it is paused, or after it finished. Start from the
export so kept actions compare equal:

```bash
bullswarm workflow plan export <shortId> --out plan.json         # or --json for status + document
bullswarm workflow plan revise <shortId> --program plan.json --json
bullswarm workflow plan revise <shortId> --program plan.json --rerun a,b --summary 'why' --base-revision 3 --wait 30
```

The document is `{schemaVersion, baseRevision, summary, rerun, steeringIds,
program}`; a bare program file also works, with the flags supplying the rest.
Flags override the file. The kernel diffs `program.actions` against the live
plan by id:

- **added**: a new id. **restored**: an id that an earlier revision removed.
- **kept**: normalized definition unchanged. A succeeded result is reused; a
  running attempt continues untouched.
- **amended**: any field differs. A running attempt is stopped (watch prints
  `stopped · replaced by a plan revision`) and ignored even if it finishes
  afterwards; the step becomes pending with the new definition.
- **rerun**: an id in `rerun` whose definition is unchanged and that is not
  pending. Its result is discarded and it becomes pending.
- **removed**: absent from the file. Stopped if running, status `removed`,
  never scheduled, excluded from `completed`/`partial` counting. Its outputs are
  no longer offered to dependents.
- **invalidated**: every kept, non-pending action downstream of an amended,
  restored, or rerun action in the new graph. It becomes pending and runs again
  once its inputs succeed.

A removed or reset evidence action's records turn stale
(`staleReason: revision-discarded`) and the requirement status is recomputed.

Validation happens twice, in the CLI before anything is written and in the
kernel when it applies, and a failure changes nothing (exit 2 with `issues`).
The whole live graph must validate as one program, including dependencies on
finished actions. A revision is rejected when `baseRevision` differs from the
live `program.revision` (another revision landed after your export), when a
`rerun` id is unknown or pending, when the run has a pending cancellation, when
the run is not in program mode, or when the revision changes nothing. The
exception to that last rule: a revision whose only effect is to acknowledge
`steeringIds` is accepted.

Timing: with a kernel alive the request is queued under
`<runDir>/revisions/` and applied within about a second (`--wait` bounds how
long the CLI waits for the record; `queued` just means not yet). A running step
being replaced is stopped before the new plan is committed
(`program.revision_stopping`, then `program.revised`). With no kernel alive, the
CLI applies the revision itself under the kernel lease and relaunches the
kernel detached, unless the run is paused. A finished run is reopened: its
`result.json` moves to `result-before-revision-<n>.json`, a
`workflow.reopened` event is written, and the new plan runs to a new result.
Steps a cancellation stopped return to pending (`reopened.requeued`); failed
steps stay failed unless the revision names them in `rerun`. A revision also
answers a run an older version left waiting for its caller.

Stopping a process does not undo its edits in the shared tree. When a stopped
or removed step's partial changes must go, amend it or add a step whose prompt
says what to revert or repair.

### Pause and resume

```bash
bullswarm workflow pause  <shortId>          # drain: running agents finish, nothing new starts
bullswarm workflow pause  <shortId> --now    # stop running agents too; they requeue
bullswarm workflow resume <shortId>          # lift the pause and continue
```

A pause is an intent file the kernel honors at its next loop (`workflow.pause_requested`,
then `workflow.paused`), after which the kernel exits and watchers print
`outcome: paused`. Steps stopped by `--now` finish as cancelled with
`failureKind: paused` and return to pending. While paused, revise as often as
needed; only `resume` continues the run. `resume` before the kernel reached the
pause withdraws the request (`workflow.unpaused`) and the run never stops.
`cancel` on a paused run finalizes it inline. A pause on a finished run is
refused.

### Stale steps and `step restart`

For each running attempt the watcher computes a stale score. It uses the
attempt's persisted event stream (`stream-<step>-attempt-<n>.jsonl` and its
`.tail` segment) and the modification times of the step's `ownedFiles`:

| Signal | Fires when | Weight |
|---|---|---|
| quiet | no event for 10 minutes while no command is in flight (a command still running is excluded; without an event stream it is plain output silence) | 2 |
| no file change | a step that writes (it owns files or is `build`, and is not a check) changed no file for 20 minutes while at least 5 commands ran | 1 |
| repeat | the same command 3 times in a row with no file change between | 1 |
| wall | running longer than 3× the router's expected minutes for its lane and effort (`routing.forecast.expectedMinutes`) | 1 |

At a score of 2 the watcher prints `⚠ <step> looks stale: <reasons>` once per
attempt. The line wakes `--next` and `--until trouble`, and the human `next:`
block adds `or restart: bullswarm workflow step restart <shortId> <step>`. The
`attempt.stale` JSONL object carries `reasons`, `score` and `staleSince`.
Nothing restarts automatically.

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

### Steering in a caller-planned run

`workflow steer` in a program run does not halt anything. Watchers wake on
`steering received`; the caller decides what the message means and revises.
`plan export` lists undelivered steering under `pendingSteering` (with `--json`)
and puts its ids in the document's `steeringIds`, so a revision from the export
marks it delivered (`steering.delivered`, `source: revision`). A run never
waits for steering: if the graph finishes first, the result lists it under
`handback.unreadSteering` and watch prints `steering not acted on`. Revise the
finished run from a fresh export to deliver it; that reopens the run.

## When a run finishes: the handback

A run never waits: not for its caller, not for a paused pool, not for a silent
worker. It finishes as soon as nothing more can happen on its own. The result
carries a `handback` whenever it is not verified or has steering nobody acted
on:

- `handback.unfinished[]`: `{id, status, failureKind, why, retryAfter?,
  retryable}` for every step that did not succeed. `retryable` says whether
  `workflow resume` would run it again. `retryAfter` is set when every pool
  able to run the step was paused: the earliest time one is back.
- `handback.unresolvedRequirements[]`: `{id, status, why}` with the latest
  evidence line, or `no evidence recorded for the current work`.
- `handback.unreadSteering[]`: `{id, message, queuedAt}`.

`runs result --summary` adds `handback.options`, one command per choice
(`continue`, `retry` when a step is retryable, `takeOver`, `restart`). An open
requirement keeps its `why` for as long as the 4 KB budget allows; concerns and
per-step detail shrink first. The `workflow.finished` event carries
`unfinished` and `unreadSteering` counts. The reason line says what happened:
`all 4 steps succeeded, but no step checked the requirements, so the result is
not verified`, or `2 of 5 steps did not succeed: build-api failed (stalled), …`.

Where a run used to wait, it now finishes:

| Situation | What happens |
|---|---|
| `--scout` with no program | `partial`: `no program to run (the scout report is at …)`; add steps with `plan revise` |
| a launch program the kernel cannot accept | `partial`: the reason lists the issues; nothing ran |
| requirements open with nothing left to run (older verified-mode runs) | `partial` with gaps |
| steering unread when the last step ends | the run finishes; `unreadSteering` lists it |
| every pool able to run a step is paused | the step fails at once (`unavailable` or `quota`) with `retryAfter` |
| a worker writes nothing for 60 minutes | stopped as `stalled`, retried once mechanically, then handed back |
| the kernel throws | the run is marked `interrupted` with `kernel stopped on an error: …`; `resume` continues it |

Resume on a finished run is a retry. It reopens the run for pending and
cancelled steps, failed steps whose kind a retry fixes (`provider`, `quota`,
`auth`, `process`, `unavailable`, `interrupted`, `runtime`, `schema`,
`stalled`), and the steps blocked behind them; moves `result.json` to
`result-before-resume-<n>.json`; writes `workflow.reopened` with `source:
resume`; and relaunches the kernel. A step that failed for any other reason
(the worker reported failure, `ownership`) stays failed: change the plan with
`plan revise`. With nothing retryable, resume prints `nothing to retry`, lists
the steps that need you, starts nothing, and exits 1.

The silence cutoff is `BULLSWARM_WORKER_SILENCE_SEC` (default 3600). It
measures silence, not run time: every byte a worker writes restarts it.

A `--program` supplied at launch is kept as `initial-planner-response.json` in
the run directory until applied, so an interruption during an opt-in `--scout`
does not lose it. Bare value flags (`--program` with no file, `--orchestrator`
with no pool) are usage errors (exit 2); nothing launches in a different mode.

### Runs an older version left waiting

Runs started before 0.30.0 may still sit at a planning boundary; `watch`
prints `waiting for the caller planner`. Either answer it (`plan show
<shortId> --json`, then `plan submit <shortId> --program plan-2.json`, or
`--exhausted --reason '<why>'` at a `gaps` boundary; a `plan revise` also
answers it), or run `workflow resume <shortId>`, which finishes it and hands
back what is left. `plan show` refreshes the request with steering queued
since, and a submission marks exactly the listed steering delivered.
`workflow cancel <id>` finalizes a waiting run inline; once cancellation is
recorded, `plan submit` refuses every submission. `plan submit` checks the goal
directory before touching state.

## Workspace and concurrency options

New programs share the target tree. Add `--concurrency=3` at launch when a
specific fan-out cap is useful; it does not bypass overlap serialization or
the sole-integrator rule.

Choose strict per-worker worktrees explicitly with `--isolation`, using it for
both `plan contract`/`plan validate` and `workflow goal`. In this mode writers
must list exact files in `ownedFiles`; undeclared files can fail the action and
are not integrated. An unrestricted writer with `ownedFiles: []` is invalid.
Existing runs preserve their saved mode on resume.

## Adversarial verification

An action that names requirement IDs in `evidenceFor` is dispatched under the
kernel-owned evidence contract and writes a
`bullswarm.workflow.evidence.v2` envelope — `requirements: { <id>: { status,
evidence, concerns } }` — to the durable path the task file names. It judges the
artifact its dependency produced, so give it `dependsOn` and no `ownedFiles`;
the kernel validates the envelope after dispatch and a schema-invalid one gets
one bounded correction. Do not ask a worker to return a `{ok, concerns,
summary}` verdict or any other hand-rolled JSON shape: the program validator
rejects response-format directives, and that older verdict shape is refused
outright. `kind: 'adversarial-acceptance'` routes such an action to analyze/high.

## Routing and model policy

Inspect current capability and quota evidence with:

```bash
bullswarm workflow capabilities --json
bullswarm pools --json
bullswarm strategy inventory --json
bullswarm strategy routes --json
```

Automatic routing chooses the most-behind capable eligible pool among those
with 5-hour headroom, honors burst gates and quarantine, and applies only
explicitly approved model assignments and exclusions. A pool at or above 75%
of its 5-hour window is picked only when no eligible pool below that line
exists; `bullswarm pools` shows the reading as `5h=<n>%` with a
`NEAR-5H-LIMIT` label, and meters and quarantines are re-read before every
dispatch rather than frozen at launch.

Those thresholds apply to the forecast, not to the reading: a pool's
projection (its reading plus what its in-flight agents will still spend) plus
the expected consumption of the assignment being routed. Diagnose a surprising
pick with the numbers, in this order:

```bash
bullswarm assignments --json   # what is running right now, in every process
bullswarm pools --json         # inflight {count, minutes, records[]} per pool
bullswarm workflow runs show <id> --json   # routing reason + candidates
```

- `bullswarm assignments` is the ledger itself — no meters, no network. Each
  record names the pool, source (`run` / `workflow-v2`), run
  and action, `startedAt`, `elapsedMinutes`, `expectedMinutes` and
  `remainingMinutes`. An empty list with work apparently running means the
  dispatching process never registered it; a stale-looking entry is pruned on
  the next read once its process is gone.
- Legacy authored-graph rows are read-only. Every driving command fails closed
  with the executor-removed message and leaves the historical run directory untouched.
- `bullswarm pools` carries `inflight=<n>` next to each pool's `5h=<n>%`
  reading; `--json` adds the full `inflight` block (`count`, elapsed
  `minutes`, `remainingMinutes`, `unknownExpected`, `records[]`) and each
  pool's `spend.fiveHour` / `spend.weekly` / `spend.monthly` / `spend.pacing`
  rates with `projectedFiveHourPct` / `projectedWeeklyPct` /
  `projectedMonthlyPct` / `projectedPacingPct`.
- The meter column names the window the pool is paced by, e.g.
  `command-code   cost=1 lanes=analyze/build/chore monthly used 79.4% elapsed
  75.3% [cache] surplus=-4.1 ...`. That window is the connector's declared
  `quotaWindow` (monthly for command-code and the relay pools, weekly for
  claude-code, codex and grok), overridable with `bullswarm strategy
  set-subscription <pool> --quota-window <weekly|monthly>`; `pools --json`
  carries it as `pacingWindow`, and `used%`/`elapsed%`/`surplus` are that
  window's. The 5h reading still only gates.
- `bullswarm strategy rungs --json` answers "what would this pool actually run
  on this tier, and what did it cost last time" in one row per pool and effort
  tier: the effective model and its source, the effective reasoning level and
  the layer that chose it (`action` > `run` > `strategy-pool` > `strategy-tier`
  > `connector`), the dated benchmark evidence for that model at that level, and
  the local record from the decision log (dispatches, median wall minutes, ok
  share). Use it when a pick looks right but the *result* was wrong — a rung
  whose reasoning shows `clamped` sent the worker a weaker level than you
  configured, and a rung whose `record.okShare` is low is failing at a level
  `bullswarm strategy set-rung <pool> <tier> --model <model> --reasoning <level>`
  changes in one write. Reading spawns no discovery and downloads nothing.
- Candidate rows (in the decision log, `workflow runs show --json`, and
  `run --json`) explain the pick number by number: `pace` is the raw quota
  surplus, `effectiveSurplus` is that surplus after subtracting the work the
  pool is already carrying, `inflight` is the agent count behind it,
  `projectedFiveHourPct` is the reading plus in-flight spend,
  `forecastFiveHourPct` adds this assignment, `ratePerMinute` is the measured
  5-hour burn rate, and `estimateSource` says what the adjustment was based on
  — `history` or `bootstrap` (the measured projection exceeded the floor),
  `penalty` (the flat 3-points-per-in-flight-agent floor set the charge, either
  because no rate is measured or because the projection was smaller), `none`
  (nothing to charge). An incumbent carrying more in-flight agents than a
  challenger loses its incumbency margin and cost guard, so `why` can name a
  pricier pool when the incumbent is the one that is loaded.
- `forecastGated` is always `false` now, and `forecast.gated` is always empty:
  a forecast past the wall no longer excludes a pool. `forecastOverLimit: true`
  means the pool's forecast runs past 100% of its 5-hour window, so it is
  ranked last but stays eligible — the reason says `forecast over 100% (still
  eligible; ranked last): …`. `nearFiveHourPenalty: true` means the pool is at
  or above 75% of that window and another eligible pool is behind pace, which
  is a soft ordering penalty only; when it wins anyway the reason says `last
  mile: <pool> 88.1% of 5h, handoff covers the wall`.
  `forecast.candidateMinutes` is still the duration the pick was made against.
- A `null` projection or `ratePerMinute` is a pool nobody has measured yet —
  it is deliberately never gated or deprioritized for it, so unmeasured pools
  can look "lucky" until the model has readings for them. A rate also stays
  `null` until at least `MIN_RATE_MINUTES` (5) of dispatch is attributable to
  the window: percentage points divided by six seconds of work is not a rate,
  and forecasting on it would gate every pool the moment it took its first
  assignment.

Live meter readings are retained as a capped per-pool series at
`~/.bullswarm/meters/history/<pool>.jsonl` (500 lines) — the snapshot cache
keeps only the newest reading, and a rate needs two. The log starts empty on
every machine, so rates read `bootstrap` (or `null`) until enough live
readings with dispatch between them accumulate. The flat per-in-flight-agent
penalty is `config.inflightPenaltyPct` in `~/.bullswarm/state.json` (default
3, `0` disables the tie-breaker).

Humans can use bare `bullswarm strategy` to toggle providers
and multi-select high/medium/low per model. Agents should consume the inventory
and apply validated changes with `strategy set-provider`, `strategy set-model`,
or one atomic `strategy configure --file <json> --yes`. Never weaken those
controls in a prompt.

Reasoning depth is a separate axis from routing: the lane and effort tier
choose the pool and model, and the reasoning level chooses how hard that model
thinks. The first layer that sets a level wins — not the strongest — in this
order: an action's own `reasoning` field, then the run-wide
`--worker-reasoning` / `--planner-reasoning` (`bullswarm run --reasoning`),
then the configured `strategy.reasoning` level for that pool and tier, then
the same for the tier globally, then the connector default. An action asking
for `low` therefore beats a run-wide `max`. `default` at any layer means "pass
nothing and let the worker CLI's own setting decide", and a connector that does
not accept the requested level gets the nearest level it supports. The applied
level is recorded per attempt and shown next to the model in `workflow runs
show` (text and `--json`), `workflow runs result --json`, the TUI attempt rows,
and the agent pane, so an unexpectedly cheap or expensive turn is visible
rather than inferred.

Configure the standing levels the same way as the rest of strategy — no
interactive UI required:

```bash
bullswarm strategy set-reasoning --tier high --level xhigh --yes
bullswarm strategy set-reasoning --tier high --level high --pool codex --yes
bullswarm strategy reset-reasoning --tier high --yes
bullswarm strategy inventory --json   # reasoning.tiers, .pools, .effective
```

`inventory --json` reports `reasoning.effective['<pool>'][tier]` as
`{ level, source }` through the same resolver dispatch uses, so what it shows
is what a run will send. `strategy configure --file <json> --yes` takes the
same values as a `reasoning` section; an invalid section rejects the whole
document and writes nothing.

## Recovery and stopping rules

- Auth signatures quarantine the affected pool for a 10-minute re-probe
  window; later dispatches use another eligible pool.
- A provider usage limit is the distinct failure kind `quota`: the attempt is
  killed at once, the pool is quarantined until the reset the message named
  (else its cached 5-hour `resets_at`, else 30 minutes), and the action moves
  to a pool that still has quota. The quarantine holds across runs until it
  expires. When no pool able to run the step is left, the step fails at once
  with `retryAfter` and the run hands it back; nothing waits for the reset.
  Discussing usage limits in a report is not a usage limit.
- A quota-gated preferred orchestrator falls back unless it was strictly pinned
  for QA.
- A worker silent for `BULLSWARM_WORKER_SILENCE_SEC` (default 60 minutes) is
  stopped as `stalled`. Shorter silence is evidence to inspect, not proof of a
  hang. The watcher's `looks stale` line gives its reasons; restart that one
  step with `bullswarm workflow step restart <shortId> <step>` rather than
  cancelling the run.
- `ownedFiles` naming a directory or a glob is refused at `plan validate` and
  at launch, and so is a pinned pool that cannot run a step's lane and effort.
  Both used to fail only after launch.
- A malformed V2 planner program receives one compact deterministic correction
  request. Repeated invalidity ends planning before worker budget is spent.
- Schema-invalid evidence receives a bounded correction in the same physical
  agent conversation. Schema-valid semantic failure updates the requirement
  ledger and never starts an automatic repair loop.
- Concerns remain evidence data. A passed requirement with concerns remains
  passed unless its requirement contract explicitly says otherwise.
- Use cancellation only for a genuinely hung or no-longer-authorized run.
