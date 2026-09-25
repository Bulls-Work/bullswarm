# Bullswarm operations reference

There are exactly two ways to start work: `bullswarm run` for one bounded
outcome, and `bullswarm workflow goal` for a program you author. A flow you
drive yourself is many `bullswarm run` steps with typed answers, route filters
(`--independent-of`, `--use-provider`, `--avoid-provider`, `--avoid-pool`) and
`run --batch` for many at once ([compose.md](compose.md)). Decide the shape
yourself — there is no preview or classifier command. Read this reference
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
failed or blocked steps, a last verify round that left a requirement failing,
rejected plan revisions and planning attempts, a planner or preflight scout
that stopped on a usage limit, pause requests and pause stops, stalled workers, stale
steps, and steering received. It exits on the first trouble line
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
limit on <pool>`, with `back at <time>` in it when the watch knows when the
pool is back. In a run started by this version it ends `back to you` and a
needs-you block follows (see "Retries, usage limits and the needs-you
block"); nothing waits for the pool or moves the step, and the block carries
the return time as `back at <time>` when it is known. In a run from an
earlier version it ends `retrying on another pool`,
then `↺ ... now on <pool> · <model>` prints once the mechanical retry lands on
another pool. Use `--verbose` only for diagnosis. `--classic` forces the older
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

## Program actions: role, kind, defaults, and advisories

The program format itself — fields, roles, kinds, deliverables, requirement
IDs, enforced rules
and an example — is in [program.md](program.md). The same rules are also served
live by the running kernel:

```bash
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

That contract carries the goal's derived requirement IDs, the exact validate
and launch commands with goal and `--cwd` filled in, and any run-wide
`reasoning` override. It is the brief a dispatched planner receives, and the
fallback for a caller whose `plan validate` rejects field names, roles or kinds
after an upgrade.

An action's `role` says what the step does, and its optional `deliverable`
says what it leaves behind (`files`, `report`, `data`, `media` or `outward`).
Both work only in program-mode runs. A role-only step takes its lane and effort
from the role and its deliverable:

| role | default deliverable | files | data or media | report | outward |
|---|---|---|---|---|---|
| `investigate` | report | build/medium | build/medium | analyze/medium | — |
| `produce` | files | build/medium | build/medium | analyze/medium | — |
| `transform` | files | chore/low | chore/low | analyze/low | — |
| `combine` | (required) | build/high | build/medium | analyze/medium | — |
| `check` | report | — | — | analyze/medium | — |
| `act` | outward | — | — | — | analyze/medium |

An action's `kind` names a more exact work nature. Each kind belongs to one
role and keeps its own lane, effort and gate, so a kind and its role alone do
not always route or gate the same way:

| kind | role | kind: lane/effort | role alone: lane/effort (default deliverable) | kind gate | role gate |
|---|---|---|---|---|---|
| `mechanical` | `transform` | chore/low | chore/low (files) | not judged | judged: a file change or a commit |
| `io-read` | `investigate` | analyze/low | analyze/medium (report) | not judged | report not empty |
| `architecture` | `investigate` | analyze/high | analyze/medium (report) | not judged | report not empty |
| `implement` | `produce` | build/medium | build/medium (files) | a file change or a commit | a file change or a commit |
| `integration` | `combine` | build/high | needs a deliverable | exempt | files: exempt; data/media: paths; report: not empty |
| `digest` | `combine` | analyze/low, kernel-written task | — | not judged | a role step never gets the digest task |
| `check` | `check` | analyze/medium | analyze/medium (report) | not judged | not judged with evidenceFor, else report not empty |
| `adversarial-acceptance` | `check` | analyze/high | analyze/medium (report) | not judged | same as check |

A step may give both only when the role is the kind's own; then only the kind
is stored, so annotating an exported plan changes nothing. The kind gate for
`implement` applies to runs started by this version.

Resolution is per field: an explicit `lane` or `effort` on the action wins,
then the kind table, else the role table, then an optional program-level
`defaults` object — which may set only `effort`, `reasoning`, `timeBox` and
`verifyRounds`, since lane follows the individual action — then the per-lane
default. A role or `kind` outside its closed list is a validation error, not a
runtime failure: `workflow plan validate` exits 2 and nothing launches. A
program written only with kinds or lanes validates exactly as before. One
behavior is new in runs started by this version: a build-lane step other than
`integration` that changes no file and makes no commit fails as
`not-produced`; 0.35.6 recorded it as succeeded. Runs started before this
version keep their original rules when resumed.

`digest` is the kernel-owned kind of combine: the runtime writes its task from a
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
must have empty `ownedFiles`, and no review step may list a digest in its
`dependsOn` — review reads the real artifacts. A consumer that depends on a
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
`runs show`, and `workflow action show` print `kind` (or `role` for a step
without one) next to lane and effort.

## The time box and the verify loop

Two kernel behaviours act on every program run, and both stay out of your way
until a step is late or a check fails.

**The soft time box.** Each work and review step's task ends with a
paragraph: the box in minutes, the start clock, a wrap-up point at 70% of the
box, and an invitation to stop and write `## Done`, `## Not done` (one line per
unfinished item, or `- none`) and `## Suggested next step`. The box is the
action's `timeBox`, else `defaults.timeBox` (whole minutes, 0-240), else
computed from this home's succeeded attempts: 1.5 x the median wall minutes for
the pool and kind (or role, for a step with no kind) when the pair has at
least 5, else for the kind or role alone, else 20,
rounded to 5 and kept within 10-60. `opencode` attempts never feed the
history. `timeBox: 0` leaves the paragraph out of that action; digests, planner
turns and the scout never carry one. The box is worked out per attempt, so a
retry on another pool gets its own clock. It is a guide: hard timeouts, stall
detection, cancellation and routing are unchanged, and nothing stops at the
box. `workflow action show <shortId> <step> --json` prints the attempt's
`timeBox` record, and the Step page shows `box 20m` (`box 20m · ran 34m` when
the attempt ran past it).

**Early return.** When a step's `## Not done` section lists items, the step
still succeeds. Its attempt records `returnedEarly: { count, items }`, the Step
page and the Run timeline read `returned early · N not done` and the selected
Run row and the Step header list the stored items, and a full watch
prints `◐ <step> returned early · N not done` instead of the finished line. The
items are quoted in the tasks of the verifiers that judge the requirements the
step affects. Nothing is retried and nothing fails: this is an honest partial
report, and the caller reads it only when the run ends not verified.

**The verify loop.** A program with a review step gets up to 3 verify
rounds; `defaults.verifyRounds` (1-3, default 3, 1 = a single round) sets the
cap. Round 1 judges every requirement. When a mandatory requirement fails or is
blocked and rounds remain, the kernel adds one step through a kernel-source
plan revision: `repair-<n>`, kind `implement`, given the failing requirements
with the verifier's evidence, the not-done items and durable handoffs of the
steps that affect them, and ownership of the union of those steps'
`ownedFiles` (an unrestricted integrator among them makes the repair
unrestricted, and it runs alone). When every step affecting the failing
requirements declares a `report` deliverable, the repair is instead a
read-only `analyze` step with deliverable `report` and no `ownedFiles`. A
requirement an `act` step affects is never repaired: it is handed back in
`callerDecision`, and when only such requirements fail the loop stops with
`stoppedBy: act-step`. Then it adds `verify-round-<n+1>`
(`adversarial-acceptance`, on a pool other than the repair's when one is
free). Round 2 re-checks the failures and does discovery: a regression in a
file the repair touched, or the same defect elsewhere, is reported as a
`Discovery:` concern and becomes an item the next repair must also handle.
Round 3 is final closure: it re-checks what is still open and adds nothing.
A requirement that passed carries forward and is judged again only when a
repair changed a file its evidence names; evidence that names no file is
workspace-wide and is re-opened by any repair that changed a file. There is
never a fourth round, and `repair` stays a field a program cannot declare.

The events are `workflow.verify-round` (`stage: started|finished`, with
`round`, `of`, `passed`, `failed`, `discovery`, `next` = `repair`, `finish` or
`caller`) and `workflow.repair` (`stage: started|finished`, `actionId`,
`requirements`, `ownedFiles`, `changedFiles`, `recheck`; `finished` is written
once the repair succeeded, while a failed repair ends the run `partial` with
`stoppedBy: step-failed`). The Run page shows
each round and each repair as its own phase (`verify · round 2 of 3 · 2 to
re-check`, `repair · round 1 · 2 requirements`), and Home and Runs show
`verify round 2/3` while a run is in its loop. `watch --until outcome` ends
only at the run's final outcome; the run stays `running` between rounds.

Plan revisions stay accepted throughout, and only the kernel counts rounds. A
revision never adds, resets or refunds a round. Kernel steps are ordinary steps
in `plan export`: keep, amend or rerun one and the loop continues; delete the
step in progress and the loop stops (`stoppedBy: revision`) and the run
finishes at the next boundary with the caller-decision block. Evidence from a
verify step you added or reran belongs to the round the next boundary closes;
it is not a round. `defaults.verifyRounds` in a revision sets the cap for the
rest of the run, never below the rounds already closed; a revision that changes
only the cap is accepted. Reopening a finished
run keeps the record: a run stopped at `rounds` never gets another kernel
round, so your own verify steps and the next boundary finalize it, while a run
stopped at `step-failed` resumes its loop once that step succeeds.

**What the loop hands back.** The run ends as soon as nothing is failing
(`completed · verified`) or after round 3 (`completed · not verified · verify
rounds 3/3`). The result then carries `callerDecision`: each requirement still
failing, its latest evidence, and one suggested next step. Read it with
`bullswarm workflow runs result <shortId> --json --summary`. It also carries
`verifyRounds`, which lists per verify round and per repair its wall minutes,
pools and cost (`$X`, `at least $X · N unmeasured`, or `—`); the fields are in
`docs/reference/result.md`. Act on the decision block, not on the first failing
evidence line you see in the stream: ordinary failing checks are the loop's job,
and a hand-added fix step for one is the wrong move while rounds remain.

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

A removed or reset review step's records turn stale
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
Steps a cancellation stopped return to pending (`reopened.requeued`), except
an `act` step whose worker had started: it may have acted, so it stays
cancelled (`reopened.keptCancelled`, printed by `step rerun`, `step accept`
and the watch's reopened line). Failed steps stay failed unless the revision
names them in `rerun`. A revision also
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

While Bullswarm runs a step's declared checks, only quiet counts, read from
the checks' heartbeat (`no check heartbeat for <N>m`).

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

## Retries, usage limits and the needs-you block

In new runs, each step gets one automatic retry in total. A process failure
(crash, silence, sign-in failure, provider error, a worker that died at start)
retries on another eligible pool (the same pool when it is the only one, except
after a sign-in failure). After a sign-in failure the retry also skips every
pool that shares that credential, for that step only; nothing is stored. A gate failure (`failed-evidence`, `not-produced`,
`schema`, or `semantic`) retries on the same pool with the failure attached. A
gate retry spends the same one-step budget. A started `act` step is never
retried automatically; a check that could not run also comes straight back to
you. Only dependents wait; unrelated steps keep running. Runs started earlier
keep their saved rules.

A usage limit ends the step: a spent 5-hour or weekly window, or no credit
left. The step comes straight back to you as `quota`; nothing waits, moves to
another pool or retries by itself. That holds for a limit notice that names
no reset too (its block then prints `back at` only when every pool that can
run the step is out and one of them has a known return). Bullswarm never
remembers a spent or dead pool from one step to the next: nothing pauses or
benches a pool. The pool's meter is read again at once (when it cannot be read, the pool counts as full until its reset only when the provider named that reset or an earlier meter reading gave it), and
later steps route on that reading: a window it shows at 100% keeps the pool
out until that window resets. A short "too many requests" rate limit is not a usage
limit: it backs off on the same pool at most twice (20 s, then 60 s, or the
wait it names when that is at most 2 minutes), then comes back to you as
`throttle`. One that names a longer wait comes back to
you at once, with `back at` at the end of that wait. One whose pool is no
longer free for the backoff (it reached its 5-hour, weekly or monthly limit,
or is nearly spent) comes back to you at once too: as `quota`
when that pool is out on a usage limit, with `back at` its return when that is
known. A try after a backoff reads `· after a rate-limit backoff`, and the
block's header counts the backoffs (`backed off twice`). When no
pool that can run a step is free at its pick (each one is nearly spent, or at
its 5-hour, weekly or monthly limit), the step comes back to you too: as
`quota` when every reason is a usage limit, else as `unavailable`. Its `why`
names each pool: `<pool> at its 5-hour limit until <time>`, `<pool> at its
weekly limit until <time>` (or `monthly`), `<pool> nearly spent (forecast
<n>%) until <time>`. A retry the step was promised
(a process or gate retry, or a backoff) that finds no free pool keeps its own
failure kind, except as above, and its `why` ends `· no retry: <pool>
<reason>; …`. A pool about to run out before its window resets is never given
a step it would push over, nor the dispatched planner or the preflight scout.
When another capable pool is free, routing picks it as usual.

The dispatched planner (`--orchestrator`) and the preflight scout (`--scout`,
or the scout before a dispatched planner) follow the same rule in a run
started by this version: a usage limit, a rate limit still there after its
short backoff, or no free pool at its pick stops it and tells you; it never
moves to another pool by itself. A sign-in failure, a provider error or a
worker that died at start still moves it to another pool, and a report or
program that fails validation still gets its one correction. That correction,
and the one retry on the same pool it gets when no other pool can run it, never
go back to a pool that has become nearly spent: the correction moves to
another free pool, and with none free it stops and tells you, with that pool's
`nearly spent` reason. The
`planner.finished` and `preflight.scout_finished` events of such a stop carry
`failureKind`, `why` and `retryAfter` (the return time, or null); the scout's
also carries `runContinues` (true when the run goes on without its report,
false when it finishes there). A stopped
planner finishes the run with `the workflow planner stopped on a usage limit:
<why> · back at <time> · your call: resume after <time> with bullswarm workflow
resume <id>, plan it yourself with bullswarm workflow plan revise <id>
--program <file.json>, or start a new run`;
it reads `stopped: no pool free` when a pool was out for a reason that is not
a usage limit, or when no pool can run it at all, and drops `back at` when no
return time is known, reading `bullswarm workflow resume <id> once a pool is
free` instead. A scout
with no program after it (`--scout` alone, or before a dispatched planner)
finishes the run the same way, as `the preflight scout stopped on a usage
limit: …`. After the `back at` time, `workflow resume <id>` runs the stopped
planner or scout again (`✓ reopened the partial run <id>; running again: the
workflow planner`, or `the preflight scout`); before then it can stop the same
way, and resume adds `note: <who> stopped with its pool back at <time>; run
before then, it can fail the same way again`. With `--json`, `reopened.requeued`
lists `workflow-planner` or `preflight-scout` first. `plan revise` with your
program (it reopens the run and runs your program) and a new run stay the
other choices. With your program (`--program --scout`) the run
goes on without the report, and the watch prints `⚠ preflight scout stopped ·
<label> on <pool> · back at <time> · the run continues without its report`
(`<label>` is `out of quota`, `rate limited` or `no eligible pool`; `no pool`
when none was picked); `--until trouble` wakes on it, and `workflow resume`
does not run that scout again. A stopped planner prints
`✗ planner stopped · <label> on <pool> · back at <time>` with the same labels,
and `--until trouble` wakes on it too; any other planner failure still prints
`× planning attempt rejected · <why>`. The scout's or the
planner's own usage-limit line before it ends `no retry left`, and no
needs-you block follows it. Runs started earlier keep moving the planner and
the scout to another pool.

A `step rerun` or `resume` after a failure the pool caused (a sign-in failure,
a provider error, a worker that died before answering) starts on another pool
when one can take the step, and on the same pool only when none can; this
changes nothing in the route. A usage limit is not one of these: a rerun after
one is routed as usual, and `--avoid <pool>` keeps it off that pool.

When the watch prints a needs-you block, choose one of its `your call` lines,
run that command as printed, and relaunch the exact `next:` watch line:

| Choice | What to do |
|---|---|
| Rerun elsewhere | Run `bullswarm workflow step rerun <id> <step> --avoid <last-pool>`; the pool stays excluded in the step's route |
| Wait for it | Printed when a return time is known (after a usage limit, a rate limit that named a longer wait, or with no free pool): `after <time>: bullswarm workflow step rerun <id> <step>`. Run that rerun yourself once the `back at` time has passed |
| Change the step | Run `bullswarm workflow plan export <id> --out plan.json`, edit the step, then `bullswarm workflow plan revise <id> --program plan.json` |
| Take over | Open the absolute `output:` path from the block and finish the work yourself |
| Accept anyway | Run `bullswarm workflow step accept <id> <step> --reason "…"`; this records `choice`, never proof, and rerunning undoes it |

When no other pool could run the step, the first line reads `retry here` with a
plain `step rerun`. A review block names the check that judged the failing
requirement; another check that failed one follows as `also judged by
<check>:` with its own rerun and accept lines.

After a usage limit a full watch prints `⚠ <step> usage limit on <pool> ·
back to you` (the attempt carries no return time, so the line names none),
then the needs-you block, which carries the return time as `back at <time>`
when it is known. The block's
`why` is the provider's limit notice, or, when no pool was free, every capable
pool with its reason (`no pool with quota to spare: <pool> at its 5-hour limit
until <time>; …`, or `no pool free: …`). When a return time is known, after
any failure, it adds `back at <time>`: the failed pool's reset, the end of a
rate limit's named wait, or, when no pool was free, the earliest known return
among the pools that can run the step. With `--jsonl` these are `backAt` and
`options.waitForIt`. Runs started earlier print no `back at`. To stop the
whole run instead, run `bullswarm workflow cancel <id>`.

## When a run finishes: the handback

A run never waits for its caller, for a silent worker, or for a pool to come
back. A step that no pool can run now comes back to you, with its return time
when one is known, and the rest of the run goes on. The run finishes
as soon as nothing more can happen on its own. The result
carries a `handback` whenever it is not verified or has steering nobody acted
on:

- `handback.unfinished[]`: `{id, status, failureKind, why, retryAfter?,
  retryable, retries?}` for every step that did not succeed. `retryable` says
  whether `workflow resume` would run it again. `retries` (runs started by this
  version) counts the automatic retries the current definition spent. `retryAfter` is set when a
  return time is known: the failed pool's reset after a usage limit, the end
  of a rate limit's named wait, or, when every pool able to run the step was
  out, the earliest known time one is back.
- `handback.unresolvedRequirements[]`: `{id, status, why}` with the latest
  evidence line, or `no evidence recorded for the current work`.
- `handback.unreadSteering[]`: `{id, message, queuedAt}`.

A `failed-evidence` result means a declared command or schema check failed.
Bullswarm retries once on the same pool with the check output attached; after
the retry the step comes back to you in a needs-you block. Failed checks on `act` steps and checks that
cannot run go to you without a retry. Signal deaths of checks are failures;
a kernel stop, pause or revision is not a failed check. Full output is saved
in `evidence-<step>-attempt-<n>-<k>.log`. `workflow resume` does not rerun
`failed-evidence`; fix or amend the step, or add a check step with its own
evidence to prove finished work without rerunning it. A step whose worker
failed first ran no check: its handback line and watch's failed line read
`evidence not run`, and `evidenceResults` is `null`. Each check's `status`,
`exit`, `tail` and `why` are in `runs result <id> --json` under
`actions[].evidenceResults`, and in `workflow action show <id> <step>`. New
runs label finished steps `proven by command`, `proven by schema` or `proven
by review`; a step without evidence reads `review pending` while a review step
still covers its requirements, and `finished · unproven` otherwise. A step
accepted with `step accept` reads `accepted by choice`, never proven. Watch
and result summaries include a `proof:` count line, which counts accepted
steps apart (`N accepted by choice: <steps>`).

`runs result --summary` adds `handback.options`, one command per choice:
`continue`, `retry` when a step is retryable, `rerun` and `accept` when a run
started by this version has a failed step, `rerunReview` and
`acceptRequirement` (printed as `rerun` and `accept`, naming the check and
`--requirement <id>`) when its review loop left a requirement failing, then
`takeOver` and `restart`. An accepted requirement prints as `requirement <id>:
failed · accepted by choice "<reason>"`. An open
requirement keeps its `why` for as long as the 4 KB budget allows; concerns and
per-step detail shrink first. The `workflow.finished` event carries
`unfinished` and `unreadSteering` counts. The reason line says what happened:
`all 4 steps succeeded, but no step checked the requirements, so the result is
not verified`, `2 of 5 steps did not succeed: build-api failed (stalled), …`, or
`… but not verified after verify rounds 2/2: …`, which comes with the
`callerDecision` block.

Where a run used to wait, it now finishes:

| Situation | What happens |
|---|---|
| `--scout` with no program | `partial`: `no program to run (the scout report is at …)`; add steps with `plan revise` |
| a launch program the kernel cannot accept | `partial`: the reason lists the issues; nothing ran |
| requirements open with nothing left to run (older verified-mode runs) | `partial` with gaps |
| steering unread when the last step ends | the run finishes; `unreadSteering` lists it |
| a usage limit on the pool running a step | the step fails as `quota` at once and comes back to you, with `retryAfter` when the reset is known; the rest of the run goes on |
| no pool that can run a step is free (nearly spent, or at its 5-hour, weekly or monthly limit) | the step fails as `quota` when every reason is a usage limit, else as `unavailable`; `why` names each pool's reason, and `retryAfter` is the earliest known return |
| no capable pool exists | the step fails as `unavailable` |
| a usage limit, or no free pool, on the dispatched planner | `partial`: `the workflow planner stopped on a usage limit: …` with its `your call` (`workflow resume` after the `back at` time runs the planner again; or plan it yourself with `plan revise`; or start a new run) |
| a usage limit, or no free pool, on the scout with no program after it | `partial`: `the preflight scout stopped on a usage limit: …`, with the same `your call` |
| a usage limit, or no free pool, on the scout before your program | the run goes on without the report; the watch prints `⚠ preflight scout stopped · …` |
| a worker writes nothing for 60 minutes | stopped as `stalled`, retried once mechanically, then handed back |
| the kernel throws | the run is marked `interrupted` with `kernel stopped on an error: …`; `resume` continues it |

Resume on a finished run reopens pending and cancelled steps, and failed
steps that its saved run rules allow it to retry, plus the steps blocked behind
them (in a run started by this version, also a planner or scout whose stop on
a usage limit or no free pool ended the run, which runs first); moves `result.json` to
`result-before-resume-<n>.json`; writes `workflow.reopened` with `source:
resume`; and relaunches the kernel. In new runs, gate failures such as
`failed-evidence` and `not-produced` stay failed: use `step rerun`, `step
accept`, or `plan revise`. Saved runs retain
their original resume rules. With nothing retryable, resume prints
`nothing to retry`, lists the steps that need you, starts nothing, and exits 1.

| Failure | What happens |
|---|---|
| `failed-evidence` | In a new run, it uses the step's one retry on the same pool with the check output attached; then the needs-you block returns it to you. An `act` step or a check that cannot run goes to you without a retry. `workflow resume` does not rerun it. Saved runs keep their old rules. |
| Evidence killed by a signal | The check fails (`killed by SIG…`); a kernel stop, pause or revision is not a failed check. |
| Evidence log | Full output is saved as `evidence-<step>-attempt-<n>-<k>.log`. |

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

Automatic routing chooses the most-behind capable eligible pool, honors the
spent-window gates, and applies only explicitly approved model choices and
exclusions. `strategy apply` sets each pool's model per tier and pins no tier;
a tier goes to one pool only when someone pinned it with `strategy assign`
(`strategy clear-assignment` removes it). A pool with any metered window at
100% (5-hour, weekly or monthly) is never picked until that window resets. A
pool at or above 75% of its 5-hour window is still eligible: it is ordered
after another eligible pool that is behind pace, a soft penalty, not a skip;
`bullswarm pools` shows the reading as `5h=<n>%` with a `NEAR-5H-LIMIT` label,
and meters are re-read before every dispatch rather than frozen at launch.
Nothing else about a pool carries over from an earlier failure.

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
  the layer that chose it (`action` > `run` > `strategy-pool` or
  `recommendation` > `strategy-tier` > `connector`; `recommendation` is a
  per-pool level an applied suggestion wrote, such as codex medium at `max`
  while there is no gpt-6 terra), the dated benchmark evidence for that model at that level, and
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
  mile: <pool> 88.1% of 5h, a limit mid-attempt goes back to the caller`:
  nothing retries it at the wall, and a limit it hits there is a usage limit.
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

- An auth signature is failure kind `auth`: the step's retry skips every pool
  that shares that credential, for that step only. Nothing is stored, so a
  later step can pick the pool again.
- A provider usage limit is the distinct failure kind `quota`: the attempt is
  killed at once. In a workflow started by this version and in a single
  `bullswarm run`, the pool's meter is read again at once (when it cannot be read, the pool counts as full until its reset only when the provider named that reset or an earlier meter reading gave it), and
  a window it shows at 100% keeps the pool out of later steps until that
  window resets. Nothing else is remembered about the pool. In a workflow
  started by this version the step then comes back to you at once, with
  `retryAfter` (its `back at` time) when the reset is known; nothing moves it
  or waits for the reset. Runs started earlier move the action to a pool that
  still has quota. Discussing usage limits in a report is not a usage limit.
- A preferred orchestrator already quota-gated at its pick falls back unless it
  was strictly pinned for QA. In a run started by this version a usage limit
  it hits while it plans stops the run instead (see "Retries, usage limits and
  the needs-you block").
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
  ledger; on a program run the kernel then starts its own repair round (see
  "The time box and the verify loop"): one fix and one re-review by default
  (`defaults.verifyRounds` fix cycles, 0-3), and hands the rest back in the
  needs-you block and `callerDecision`. Nothing outside those rounds repairs.
- Concerns remain evidence data. A passed requirement with concerns remains
  passed unless its requirement contract explicitly says otherwise.
- Use cancellation only for a genuinely hung or no-longer-authorized run.
