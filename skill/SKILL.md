---
name: bullswarm
description: Delegate bounded work through Bullswarm to one quota-routed coding agent, a flow of such runs you drive with schema-checked JSON answers, or a shared-worktree workflow, and steer a running workflow by revising its plan (add, change, remove, or rerun steps; pause and resume). Use for /bullswarm, offloading, independent verification, or requested multi-agent execution.
---

# Bullswarm

You write the task. Bullswarm picks a worker by quota and capability, runs it,
and saves the output. For a workflow you are the planner: write the program,
launch it, and keep revising the plan while it runs whenever you learn
something that changes what it should do.

Keep the user's scope and working directory. Delegate only authorized work;
permission to delegate does not authorize messages, releases, or other external
writes. If `BULLSWARM_DEPTH` is set you are already a worker: do the assigned
work directly unless it explicitly requires nested delegation.

## 1. Choose the shape

One `bullswarm run` per bounded outcome: a review, a localized fix, a study
with one deliverable. When the work has stages, loops or one step per item,
you drive them: your own loop, or a Claude Code Workflow script whose agent
shells out to `bullswarm run`. Give each step `--answer-schema` so it
returns checked JSON you can branch on, and a checker `--independent-of
<earlier run>` so it never shares that run's provider (`--use-provider`,
`--avoid-provider` and `--avoid-pool` narrow the pick too; a filter that
leaves no pool exits 1). `run --batch tasks.jsonl --json` runs many steps
from one call, one attempt each, so one Workflow agent can launch them all;
[compose.md](references/compose.md) has three recipes. Use a workflow
(`workflow goal`) when the work must outlive this session, or when parallel
writers share one worktree and need an integration step. Decide from the
request itself; there is no classifier command.

## 2a. One run, or a flow of runs

```bash
bullswarm run --lane=analyze --add-dir=<abs-dir> --prompt='<task>' --json
```

Lanes: `build` edits, `chore` mechanical edits, `analyze` read-only. Use
`--task-file` for long text. Read the result: `keepOnClaude: true` means do it
yourself; `ok: true` means read `outFile` and check its content before using
it; `ok: false` means inspect and report the failure. A clean exit code is not
proof of success. Do not run `doctor` unless dispatch reports a readiness
problem.

Add `--answer-schema <file.json>` when you will branch on the result. The
worker writes its answer as JSON, Bullswarm checks it against the schema, and
the verdict carries `answer` and `answerCheck` (`ok`, `errors`). A missing or
invalid answer sets `ok: false` and exits 1, with the worker's own verdict in
`workerOk`. Nothing is retried: rerun, change the schema, or read `outFile`
yourself. In a flow of runs pass `--no-caller`, so no step comes back
`keepOnClaude: true` with no answer.

## 2b. A workflow

The program format lives in [program.md](references/program.md): fields, roles
and kinds (each kind belongs to one role), deliverables, requirement IDs,
enforced rules, and one example. This section is how to
author the graph.

- **Decompose.** One action per bounded outcome a single worker can finish
  alone. Every writer gets an `ownedFiles` territory. All workers share one
  tree, so tell each to preserve others' edits and to report any file it needs
  outside its territory instead of editing it.
- **Dependencies are inputs, not phases.** `dependsOn` lists the actions whose
  outputs this action reads and any file or contract a writer needs before it
  can compile or prove its change. Independent actions start up to the
  concurrency cap, and dependents start when their inputs are ready. A failed
  action skips its dependents; other branches continue. Never add a dependency
  just to group phases.
- **Keep a vertical slice.** Keep each behavior and its focused test in the
  same writer action. Writers should run the checks they own; do not tell every
  writer to skip those checks.
- **Integrate after parallel writers.** One integrator (`kind: integration`,
  or a `combine` step with deliverable `files`), depending on all of them,
  directly or through a digest, with `ownedFiles: []`, which on a build-lane
  action means no territory limit. It reads their outputs,
  resolves shared-file requests, and runs the repository's acceptance checks.
  It runs alone.
- **Finish after integration.** Put the full browser/e2e gate, commit, and PR
  in separate ordered steps after integration, in that sequence. Give the
  browser/e2e step an explicit `timeBox` sized for the full suite. Make the
  browser/e2e gate a `check` step with an empty `evidenceFor` and declare its
  suite as `evidence` so Bullswarm runs it, when the suite finishes within 10
  minutes (`timeoutSec` is at most 600); otherwise split it into several items
  or keep the command in the gate's prompt. Keep the commit and PR steps `kind:
  mechanical` (not judged, and with empty ownedFiles they run alone). A step
  whose declared deliverable was not produced fails as `not-produced`, and so
  does a build-lane step with no declared deliverable that changes no file and
  makes no commit. An integrator is not judged by files, so a clean integrator
  still passes. An `act` step is for outward actions such as sending messages;
  it is never judged by files.
- **Evidence: checks Bullswarm runs.** Add a command or schema check for
  anything a machine can check. Scope commands to the step; put a whole-suite
  command on the step that runs alone or last. Checks are read-only: a change
  to the deliverable fails the item. Untracked by-products are reported as
  `touched`, not failed; declare a new file as a deliverable path to protect it.
  Each check has a timeout (default 120 seconds); choose a generous value and
  run it once by hand before launch, because fixing a wrong check reruns the
  worker. Watch-mode test runners need `--run` or `CI=1` in the command. A report
  can be checked with `file: "$output"` or a command reading
  `$BULLSWARM_STEP_OUTPUT`. Checks see `BULLSWARM_EVIDENCE=1`,
  `BULLSWARM_STEP_ID`, `BULLSWARM_STEP_OUTPUT` and `BULLSWARM_RUN_DIR`; the
  first tells a script Bullswarm is running it. One failed check gets one
  same-pool retry with output attached, then the step returns to you. If the
  worker fails first, no check runs: the step's handback line and watch's
  failed line read `evidence not run`, and the JSON has
  `evidenceResults: null`. A failed check on an `act` step or a check that
  cannot run comes straight to you. Only the caller declares checks; a
  dispatched planner cannot. A review step (non-empty `evidenceFor`) and a
  digest take no `evidence`: put the commands a reviewer must run in its
  prompt, or add a separate `check` step with `evidence` and an empty
  `evidenceFor`. Each check's result is in `runs result <id> --json` under
  `actions[].evidenceResults` (`status`, `exit`, `tail`, `why`) and in
  `workflow action show <id> <step>`. Passing checks read `proven by command`
  or `proven by schema`; a step without checks reads `proven by review` once
  a review passes every requirement it affects, `review pending` while one
  still covers them, and `finished · unproven` otherwise. A step you accepted
  reads `accepted by choice`, and the proof line counts it apart (`N accepted
  by choice: <steps>`): a choice never counts as proven. When you report the
  outcome, quote the run's proof line as printed (`proof: …` at the end of
  watch, `# proof` in `runs result`) instead of paraphrasing it. Add a `check`
  step with its own evidence to prove finished work without rerunning it. An
  old kernel refuses `evidence`: pause, revise, resume.
- **Check independently when acceptance matters.** One `check` step (or
  `kind: adversarial-acceptance` for high effort) with empty `affects` and
  `ownedFiles`, `evidenceFor` set to the
  requirement IDs it judges, depending on every writer that affects them.
  Describe what to inspect; the kernel supplies the evidence format. A
  requirement may be covered by evidence alone: a "verification" deliverable
  is the evidence report in the run result, not a file, so its deliverable
  type is `report`.
- **Digest when outputs pile up.** A `digest` (the kernel-written kind of
  combine) when three or more outputs
  feed one reader, or a reader's inputs exceed about 20 KB. The reader depends
  on the digest instead of the raw writers and gets `digestOf` links to them;
  the digest keeps every shared-file request. No review step depends on a
  digest.
- **Placing a step.** Use the optional `route` to choose pools or providers,
  avoid pools, or keep a review independent of earlier work. `independentOf`
  names earlier steps, or use `"writers"` on a check with `evidenceFor`.
  For example: `"route": { "independentOf": ["build-parser"] }`. Routes are
  hard filters before quota pacing; `lane` remains its own field. Saved runs
  keep the old automatic writer avoidance.
- **Effort.** Writers are `produce` steps. High belongs to three kinds of
  step: a `combine` step that merges written code (the sole writer after
  parallel work), a design step (`kind: architecture`, a read-only judgment
  whose report a later action consumes), and an independent check
  (`kind: adversarial-acceptance`). A study that reads code and writes
  markdown is a `produce` step. When a judgment must land in a file, keep it
  `produce`, or split it into an `architecture` step plus a writer that
  records its report. Never set `defaults.effort` to `high`, and do not
  restate `lane` or `effort` on a step with a role or kind.
- **Time box.** Every step's task carries a soft time box with a wrap-up point
  and an invitation to stop and report `## Done`, `## Not done` and
  `## Suggested next step`. The kernel computes the box from this home's
  history; set `timeBox` (minutes) on an action, or `defaults.timeBox`, when you
  know better, and `timeBox: 0` to leave it out of one step. It is a guide,
  never a timeout. A step that lists items under `## Not done` still succeeds
  and reads `returned early · N not done`; write prompts as an ordered list of
  items so an early return leaves a clean cut.
- **Prompts are self-contained.** Each names the absolute workspace path
  (nothing is substituted), the outcome, the relevant files, the dependency
  outputs to read, and the concrete checks to run.
- **Plan only what you know.** You can add phases later (section 4), so a first
  program may stop where your understanding stops, for example at an
  investigation whose report decides the implementation.

### Validate, read, adjust, then launch

Keep the goal in a file and pass it as `"$(cat goal.txt)"` to both commands,
so validate and launch get identical text, apostrophes and line breaks
included.

```bash
bullswarm workflow plan validate "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json --json
```

Exit 2 means the program is invalid: the JSON lists `issues`; fix them and
validate again. Validate also refuses what would only fail after launch: an
`ownedFiles` entry that is a directory or a glob (name exact files), and, with
a pinned pool, a step that pool cannot run. Exit 0 always carries an
`advisories` array. `all-writers-high` and `docs-at-high` name an action whose
effort is above what its work warrants: lower that action's role or kind, or
write the reason it needs high into its `purpose`. `requirement-unchecked` names a
requirement no step lists in `evidenceFor`: the run can finish but never
verify it, so add it to a `check` step's `evidenceFor`, or launch knowing the
result will be unverified. An empty array means launch now, with the same
goal, `--cwd` and absolute `--program` (validate's `next.launch` line is this
command):

```bash
bullswarm workflow goal "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json --json
```

The launch detaches and returns `shortId`; report it.

## 3. Observe and judge

A run never waits for you. It runs until nothing more can happen on its own,
then finishes, and its result hands back whatever is left with your options.
What happens next is your decision.

The standard is one background watch per run:

```bash
bullswarm workflow watch <shortId> --until trouble
```

Start it in the background right after launch, then leave the run alone. It
prints nothing while work goes well: no attach line, no line per finished
step. It exits on the first trouble, or on the run's outcome. Trouble is a step
that needs you (after its one retry, or at once for a usage limit or when no
pool is free), a review that still fails after a fix, a rejected plan
revision, a planner or scout that stopped on a usage limit, a pause, a stale
step, or steering left for you. Blocked dependents are listed inside the needs-you
block; they are not separate trouble.

Each exit is one wake. Read the output in one tool call, then act:

- Trouble lines followed by `next: bullswarm workflow watch <shortId> --until
  trouble --after <sequence> --since <iso>`: decide what to do, do it, and start
  that exact line in the background again. The cursor means nothing is
  missed or printed twice.
- `outcome:`: the run finished, paused, or was interrupted, and the output
  already holds what you need (see "When it finishes").

Between wakes, do nothing about the run. Do not poll, do not read files in the
run directory, do not run `runs show` or `tui`, and do not send the user a
status reply per step: while the watch is quiet there is nothing to report.
Use `--until outcome` when only the end matters. Trouble lines still print, but
only the outcome ends the watch. Use `--next` instead when your plan depends on
what an early step finds, because it also wakes on every finished step.

A trouble line is a decision point:

| Line | What it means | What to do |
|---|---|---|
| `✗ <step> needs you · …` | the step failed after its one automatic retry | choose one option in its `your call` block (see "When a step needs you"), run it, and start the printed `next:` watch again |
| `✗ <step> needs you · review failed …` | the fix and re-review still leave requirements failing | the same: choose one option for the check it names |
| `✗ <step> needs you · out of quota …` | a usage limit ended the step, or no pool that can run it had quota to spare; nothing waits or moves by itself | choose one option in its `your call` block (see "A usage limit or no free pool") |
| `× plan revision rejected …` | your revision was not applied | fix the issues it lists and revise again |
| `⚠ preflight scout stopped · …` | a usage limit, or no free pool, stopped the `--scout` survey; with your program the line ends `the run continues without its report` | nothing: your steps run without the report. Without a program the run finishes and its `reason:` gives your call (see "A usage limit or no free pool") |
| `✗ planner stopped · …` | a usage limit, or no free pool, stopped the dispatched planner (`--orchestrator`); the run finishes | read the outcome's `reason:` and choose its call: `workflow resume` after the `back at` time runs the planner again, or plan it yourself with `plan revise`, or start a new run (see "A usage limit or no free pool") |
| `⚠ <step> stalled on <pool> …` | the kernel stopped a silent worker | nothing: the retry runs; if it fails too, a needs-you block follows |
| `⧖ pause requested …` | someone paused the run | `bullswarm workflow resume <shortId>` when it should go on |
| `⧖ steering received · …` | a person left guidance for you | decide what it means and revise the plan |
| `⚠ <step> looks stale: <reasons>` | the step may be stuck | see below |

A check that rejects a requirement while a fix cycle remains is not trouble:
the kernel adds one fix and one re-review, and the watch stays quiet. In a new
run `defaults.verifyRounds` counts fix cycles (0-3, default 1); 0 means review
only. Runs started before this version keep up to 3 review rounds. A full watch
(without `--until trouble`) prints one line per round, `◆ verify round 2 of 3 · 3 to re-check`,
`✗ verify round 1 of 3 · 2 failed · repair next`, `↻ repair round 1 · 2
requirements · repair-1`, and `◐ <step> returned early · N not done` for a step
that succeeded with unfinished items.

### When a step needs you

A needs-you block is what the watch prints when a step comes back to you: it
failed after its one automatic retry (or the header says `not retried`: an
`act` step, a check that could not run, a usage limit, or no retry allowed), or
a review still fails after its fix. It names what
failed, each try, what is still running and what waits on it, then gives four
options under `your call:` and the `next:` watch to start again. Choose one:

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another eligible pool may succeed | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>`; the pool stays in the step's route until a plan revise removes it |
| `retry here` | printed instead when no other pool could run the step | `bullswarm workflow step rerun <shortId> <step>` |
| `change the step` / `then edit it` | its prompt, evidence, dependencies or route needs changing | `bullswarm workflow plan export <shortId> --out plan.json`, edit plan.json, then `bullswarm workflow plan revise <shortId> --program plan.json` |
| `take over` | the rest is small or needs something only you have | the line is `output: <path>` (and `diff: <path>` when there is one): read it and do the work yourself |
| `accept anyway` | you choose to keep the failed result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"`: recorded as your choice; the run is not verified by it; rerunning the step undoes it |

In a review block the step is the check that judged the failing requirement.
When another check also failed one, it follows as `also judged by <check>:`
with its own rerun and `accept anyway` lines. Run one option, then start the
printed `next:` line again.

### A usage limit or no free pool

A usage limit ends the step: a spent 5-hour or weekly window, or no credit
left. The step comes straight back to you in a needs-you block (`✗ <step> needs
you · out of quota …`), even when the notice names no reset. Nothing waits,
moves to another pool or retries by itself, and the rest of the run keeps
going. Bullswarm never remembers a spent or dead pool from one step to the
next: nothing pauses or benches a pool. The pool's meter is read again at
once, and a window it shows at 100% keeps the pool out of later steps until
that window resets. The same
happens when no pool that can run the step is free when it is picked: each one
is nearly spent, or at its 5-hour, weekly or monthly limit. Its `why` names
every pool and its reason (`no pool with quota to spare: <pool> at its 5-hour
limit until <time>; …`, `<pool> at its weekly limit until <time>`, or `no pool
free: …` when a reason is not a usage limit, and the header then reads `no
eligible pool`). When another pool that can run the step is free, routing picks it and
nothing comes back to you. A retry the step was promised (after a crash, a
sign-in failure or a failed gate) that finds no free pool keeps its own
failure, and its `why` ends `· no retry: <pool> <reason>; …`.

A short "too many requests" rate limit is not a usage limit. It backs off on
the same pool at most twice (20 s, then 60 s, or the wait it names when that
is at most 2 minutes), then comes back to you (`✗ <step> needs you · rate
limited · backed off twice`). A try after a
backoff reads `· after a rate-limit backoff`. One that names a longer wait comes back to you
at once, with `back at` at the end of that wait. One whose pool is no longer
free for the backoff (at its 5-hour, weekly or monthly limit, or nearly
spent in the meantime) comes back to you at once too: as `out of
quota` when that pool is out on a usage limit, with `back at` its return when
that is known. A sign-in failure, a provider error or a worker that died at
start still gets the step's one automatic retry by itself, on another free
pool when there is one. After a sign-in failure that retry skips every pool
that shares the credential; nothing is stored, so a later step can pick that
pool again.

When a return time is known, for this or any other failure, the block prints
`back at <time>` (the failed pool's reset, the end of a rate limit's named
wait, or, when no pool was free, the earliest known return among them) and
adds one option:

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another pool can run the step now | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>` |
| `wait for it` | the step should run on that pool, or nothing else can run it | `after <time>: bullswarm workflow step rerun <shortId> <step>`: run that rerun yourself after the `back at` time; before then the pool is still out |
| `accept anyway` | you keep the step's result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"` |

`change the step` and `take over` are printed too. To stop the whole run
instead, run `bullswarm workflow cancel <shortId>`. Then start the `next:`
watch again.

A dispatched planner (`--orchestrator`) and the preflight scout (`--scout`, or
the scout before a dispatched planner) follow the same rule: a usage limit, a
rate limit still there after its short backoff, or no free pool stops it and
tells you; it never moves to another pool by itself. A sign-in failure, a
provider error or a worker that died at start still moves it to another pool.
A nearly spent pool is never given to either of them unless you pinned it
(`--orchestrator <pool> --orchestrator-strict`, `--worker-pool`), and their
schema correction or same-pool retry never goes back to one: the correction
moves to another free pool, and with none free it stops and tells you. When the planner stops,
the watch prints `✗ planner stopped · out of quota on <pool> · back at <time>`
and the run finishes with `reason: the workflow planner
stopped on a usage limit: <why> · back at <time> · your call: resume after
<time> with bullswarm workflow resume <shortId>, plan it yourself with
bullswarm workflow plan revise <shortId> --program <file.json>, or start a new
run` (`stopped: no pool free` when a pool was out for another reason or no
pool can run it at all; no `back at`, and `bullswarm workflow resume <shortId>
once a pool is free`, when no return time is known). A scout with no
program after it ends the run the same way, as `the preflight scout stopped on
a usage limit: …`. After the `back at` time, `bullswarm workflow resume
<shortId>` runs the stopped planner or scout again (`running again: the
workflow planner`); before then it can stop the same way. Plan revise and a new
run stay the other choices. With your program (`--program
--scout`) the run goes on without the report, and the watch prints `⚠
preflight scout stopped · out of quota on <pool> · back at <time> · the run
continues without its report`; `workflow resume` does not run that scout again.

### A step that looks stale

The watcher scores each running step and prints `⚠ <step> looks stale:
<reasons>` once per attempt when the score crosses its threshold:

- `quiet 12m with no command running`: the agent produced nothing and no
  command is in flight. A long test run is not quiet.
- `no file change in 25m while 14 commands ran`: a step that writes keeps
  running commands but changes nothing.
- `same command 3× in a row: <command>`: the same command three times with no
  file change in between.
- `running 47m, over 3× the expected 15m`: well past what the router expected.

Quiet alone is enough to print the line; otherwise two reasons must hold.
While Bullswarm runs a step's declared checks, only quiet counts, read from
the checks' heartbeat: `no check heartbeat for <N>m`.
Nothing is stopped for you. Choose one:

- Let it run: start the `next:` watch again. This attempt is not reported a
  second time.
- Restart it: `bullswarm workflow step restart <shortId> <step>` (the watch
  prints it as `or restart:`). This stops that step only and runs it again. The
  new attempt gets a handoff block with the files changed, the diff stat, the
  output so far and the last thing the agent said. Add `--pool <pool>` to move
  the step to another pool.
- Change it: revise the plan (section 4).

Then start the watch again.

### When it finishes

`outcome:` gives `completed`, `partial` or `cancelled` and whether the run is
verified (`completed · not verified · verify rounds 2/2` is the default loop cap); `reason:` says why in one line. `completed` means every step
succeeded. `verified` means every mandatory requirement passed its check,
which can still miss bugs. Anything short of verified is followed by what is
left: `step <id>: <status> (<kind>) — <why>` for each unfinished step,
`requirement <id>: <status> — <why>` for each open requirement, and `steering
not acted on:` for guidance that arrived too late. Then `your call:` gives one
command per option:

| Printed option | When | What to do |
|---|---|---|
| `continue` | the plan needs a fix, a new step, or a step redone | `bullswarm workflow plan export <shortId> --out plan.json`, edit it, then `bullswarm workflow plan revise <shortId> --program plan.json` |
| `retry` | a step stopped for a reason a retry fixes: a crashed or silent worker, a usage limit, or no pool free; or a usage limit or no free pool stopped the planner or scout and ended the run (run it after its `back at` time) | `bullswarm workflow resume <shortId>` |
| `rerun` | a step failed (runs started by this version) | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>]`, with its last attempt's handoff |
| `accept` | you keep a failed step as it is (runs started by this version) | `bullswarm workflow step accept <shortId> <step> --reason "…"` |
| `take over` | the rest is small, or needs something only you have (a logged-in browser, a credential, a decision for the user) | do it yourself; `bullswarm workflow runs result <shortId> --json` names every step's output |
| `restart` | the goal or the approach was wrong | start a new run: `bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` (`step restart` reruns one running step) |

`retry` appears only when a step is retryable, or when a usage limit or no
free pool stopped the planner or scout and ended the run. `resume` on a
finished run reruns exactly those steps and the steps blocked behind them, and
that stopped planner or scout first. When nothing is
retryable it prints `nothing to retry`, starts nothing, and exits 1. A step
with a known return time shows `its pool is back at <time>`; resuming before
then can fail it again (at once when no other pool is free).

`resume` keeps the run's saved rules. It is not the way to rerun a failed gate
in a new run: use `step rerun`, `step accept`, or plan revise. Nothing inside a
run waits for a pool to come back: after a usage limit, rerun the step once its
`back at` time has passed, or elsewhere now.

A failed check is not yours to fix first. In a new run, the kernel adds one fix
step from the check's findings and one re-review. Do not write a repair step or
a retry loop yourself. `defaults.verifyRounds` counts fix cycles (0-3, default
1); 0 means review only. Remaining failures come back in a needs-you block. Runs
started before this version keep their original limit of up to 3 review rounds.
An `act` step is never retried automatically after its worker starts; its
needs-you block says `not retried: act step`, and a rerun is your deliberate
choice.

The run ends as soon as nothing is failing (`completed · verified`) or after
the configured fix cycles (the default failure outcome is `completed · not
verified · verify rounds 2/2`). In the second case
act on the **caller-decision block**, and only on it:

```bash
bullswarm workflow runs result <shortId> --json --summary
```

`callerDecision` lists each requirement still failing, the round that last
judged it, the first line of its latest evidence, and a `next` line with your
options. The text handback's `your call:` adds two for the check that judged
it (runs started by this version):

| Printed option | When | What to do |
|---|---|---|
| `rerun` | the reviewer may be wrong; judge it again on another pool | `bullswarm workflow step rerun <shortId> <check> --avoid <pool>` |
| `accept` | you choose to keep the requirement as it is | `bullswarm workflow step accept <shortId> <check> --requirement <id> --reason "…"` |

Or fix it: add a step that fixes what `next` names through a plan revision
(section 4) and let the changed check run again, or take the work over.
`verifyRounds` in the same output gives each verify round and each repair its
wall minutes, pool and cost, so you can see what the loop spent. Every step's
`returnedEarly` items are in `action show`; a step that returned early left
its unfinished work in `## Not done`, which is where a manual fix starts.

**An accept is a choice, never proof.** `step accept` records evidence
`choice`: the step's dependents run, but it never counts as proven, and an
accepted requirement stays failed, so the run stays not verified. It reads
`accepted by choice` on the step's line, `requirement <id>: failed · accepted
by choice "<reason>"` in the handback, and `N accepted by choice` in the proof
line. Report it as your decision, never as verification. Rerunning the step
undoes it.

Then read the real outputs and artifacts and probe the important edge cases
yourself. Shared files remain after failure or cancellation. Exit 0 can mean
launched, paused, or completed, so always inspect the returned status.

## 4. Steer a running workflow

The plan is never frozen. When an output shows the approach is wrong, the user
adds or drops a requirement, a step is no longer needed, or a result must be
redone, change the plan of the run you have. Do not cancel it and do not start
a second run.

```bash
bullswarm workflow plan export <shortId> --out plan.json   # the live plan, editable
# edit plan.json: add, change, or delete actions; put finished ids to redo in "rerun"
bullswarm workflow plan revise <shortId> --program plan.json --json
```

`plan.json` holds the whole program you want from now on, plus `baseRevision`,
`summary` (say why the plan changed), `rerun`, and `steeringIds`. The kernel
compares it with the live plan by action id and applies it within about a
second, even while agents are running:

| In your file | What happens |
|---|---|
| a new id | added; runs once its dependencies succeed |
| an action left exactly as exported | kept: a finished result is reused, a running agent keeps going |
| an action with any field changed (prompt, dependsOn, ownedFiles, kind…) | amended: a running agent is stopped and the step starts over with the new definition |
| a step you annotate with the role its kind belongs to | kept (the stored step keeps the kind) |
| changing `role` or `deliverable` in an exported plan | amended; after a `role` change delete the written-back `lane`, `effort` and `deliverable` (unless you set the deliverable on purpose); after a `deliverable` change delete `lane` and `effort` |
| an unchanged id listed in `rerun` | its finished result is discarded and it runs again |
| an action you deleted | removed: stopped if running, never runs again, reported as `removed` and not counted against the result |
| anything that depends on an amended or rerun step | runs again, because its inputs change |
| adding or changing `route` | amends the step and reruns it |
| `step rerun --avoid <pool>` | adds that pool to `route.pools.avoid`; remove it with a plan revise |

Rules that matter when you edit:

- The id is the identity. Renaming an id removes one step and adds another.
  Leave an action you want to keep byte-for-byte as exported.
- New steps may depend on existing ones, including finished ones. That is how you
  add a phase after work that already ran.
- `revise` exits 2 and changes nothing when the program is invalid, `rerun`
  names an id not in the program, the revision changes nothing, or the plan
  moved since your export (`baseRevision` mismatch). Export again, redo the
  edit, and revise again.
- The JSON says `status`: `applied` (with `changes` listing added, amended,
  restored, removed, rerun, and invalidated ids), `rejected` (with `issues`),
  or `queued` (the kernel had not taken it within `--wait`; watch prints `plan
  revised` when it does).
- Replacing a kind with a role reruns the step. A run whose kernel started
  before an upgrade rejects `role` and `deliverable`: pause, revise, resume.
- The kernel never repairs a requirement an `act` step affects; it hands it
  back to you.
- A stopped or removed step's file edits stay in the shared tree. When they
  must not remain, give a new or amended step the job of reverting or repairing
  them.
- Revising a finished run (`completed`, `partial`, `cancelled`) reopens it: the
  new plan runs and the run finishes again with a new result. Steps a
  cancellation stopped run again; failed steps run again only when named in
  `rerun`.
- To think without new work starting, pause first: `bullswarm workflow pause
  <shortId>` starts nothing new and lets running agents finish (`--now` stops
  them; they run again after resume). Export and revise while paused, then
  `bullswarm workflow resume <shortId>`. A revision never lifts a pause.
- `watch --until trouble` wakes on `plan revision rejected`, pause requests,
  and `steering received`; `watch --next` also wakes on `plan revised`. Steering a person queued never halts work: decide
  what it means for the plan and revise. The exported file lists pending
  steering in `steeringIds`, and a revision from that file marks it delivered.
  A run that finishes before you act on steering lists it as `steering not
  acted on`; revising the finished run from a fresh export delivers it and
  reopens the run.

[operations.md](references/operations.md) covers the revision details, pause
and resume, cancellation, scouting, a dispatched planner, isolation, watch
flags, reasoning depth, digest details, the live planning contract, and routing
diagnosis.
