---
name: bullswarm
description: Delegate bounded work through Bullswarm to one quota-routed coding agent or a shared-worktree workflow, and steer a running workflow by revising its plan (add, change, remove, or rerun steps; pause and resume). Use for /bullswarm, offloading, independent verification, or requested multi-agent execution.
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

One agent for one bounded outcome: a review, a localized fix, a study with one
deliverable. A workflow when the work splits into parallel territories, needs
integration, or needs independent acceptance. Decide from the request itself;
there is no classifier command.

## 2a. One agent

```bash
bullswarm run --lane=analyze --add-dir=<abs-dir> --prompt='<task>' --json
```

Lanes: `build` edits, `chore` mechanical edits, `analyze` read-only. Use
`--task-file` for long text. Read the result: `keepOnClaude: true` means do it
yourself; `ok: true` means read `outFile` and check its content before using
it; `ok: false` means inspect and report the failure. A clean exit code is not
proof of success. Do not run `doctor` unless dispatch reports a readiness
problem.

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
  still covers them, and `finished · unproven` otherwise. When you report the
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
that failed or was blocked, a last verify round that left a requirement
failing, a rejected plan revision, a pause, a stalled worker, a step that looks stale, or steering
left for you.

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
| `✗ <step> failed …` / `⊘ <step> blocked …` | the step did not succeed | read its output (`bullswarm workflow action show <shortId> <step>` names `outputFile`); revise the plan (section 4), or let the run finish and retry |
| `✗ verify round <r> of <max> · <k> failed · your decision` | the loop is done and left requirements failing | read the caller-decision block (see below) |
| `× plan revision rejected …` | your revision was not applied | fix the issues it lists and revise again |
| `⚠ <step> stalled on <pool> …` | the kernel stopped a silent worker | nothing: it retries on another pool or hands the step back |
| `⧖ pause requested …` | someone paused the run | `bullswarm workflow resume <shortId>` when it should go on |
| `⧖ steering received · …` | a person left guidance for you | decide what it means and revise the plan |
| `⚠ <step> looks stale: <reasons>` | the step may be stuck | see below |

A check that rejects a requirement while rounds remain is not trouble: the
kernel repairs it and the watch stays quiet. A full watch (without `--until
trouble`) prints one line per round, `◆ verify round 2 of 3 · 3 to re-check`,
`✗ verify round 1 of 3 · 2 failed · repair next`, `↻ repair round 1 · 2
requirements · repair-1`, and `◐ <step> returned early · N not done` for a step
that succeeded with unfinished items.

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
verified (`completed · not verified · verify rounds 3/3` means the loop ran to
its end); `reason:` says why in one line. `completed` means every step
succeeded. `verified` means every mandatory requirement passed its check,
which can still miss bugs. Anything short of verified is followed by what is
left: `step <id>: <status> (<kind>) — <why>` for each unfinished step,
`requirement <id>: <status> — <why>` for each open requirement, and `steering
not acted on:` for guidance that arrived too late. Then `your call:` gives one
command per option:

| Option | When | What to do |
|---|---|---|
| continue | the plan needs a fix, a new step, or a step redone | export, edit, and revise the plan (section 4) |
| retry | a step stopped for a reason a retry fixes: no pool, a paused pool, a crashed or silent worker | `bullswarm workflow resume <shortId>` |
| take over | the rest is small, or needs something only you have (a logged-in browser, a credential, a decision for the user) | do it yourself; `runs result <shortId> --json` names every step's output |
| restart | the goal or the approach was wrong | start a new `workflow goal` run (a whole new run; `step restart` reruns one running step) |

`retry` appears only when a step is retryable. `resume` on a finished run
reruns exactly those steps and the steps blocked behind them. When nothing is
retryable it prints `nothing to retry`, starts nothing, and exits 1. A step
whose pools were all paused shows `its pool is back at <time>`; resuming
before then fails it again at once.

A failed check is not yours to repair first. When a check rejects a mandatory
requirement, the kernel runs a bounded loop of at most 3 verify rounds: it adds
a `repair-<n>` step built from the verifier's evidence, the not-done items and
the handoffs of the steps that affect the requirement, then a
`verify-round-<n>` step that re-checks it. Round 1 judges everything; round 2
re-checks the failures and looks for regressions; round 3 is final closure. A
requirement that passed is judged again only when a repair touched a file its
evidence names. Do not hand-add a fix step for an ordinary failing check, and
do not revise the plan to fake a second round: the kernel counts the rounds, and
a revision never adds or refunds one. The steps it adds show in `plan export`;
keep them as they are. `defaults.verifyRounds` (1-3, default 3) sets the cap; in
a revision it sets it for the rest of the run.

The run ends as soon as nothing is failing (`completed · verified`) or after
round 3 (`completed · not verified · verify rounds 3/3`). In the second case
act on the **caller-decision block**, and only on it:

```bash
bullswarm workflow runs result <shortId> --json --summary
```

`callerDecision` lists each requirement still failing, the round that last
judged it, the first line of its latest evidence, and one suggested `next`
step. Choose one: take the work over, or add a step that fixes what `next`
names through a plan revision (section 4) and let the changed check run again.
`verifyRounds` in the same output gives each verify round and each repair its
wall minutes, pool and cost, so you can see what the loop spent. Every step's
`returnedEarly` items are in `action show`; a step that returned early left
its unfinished work in `## Not done`, which is where a manual fix starts.

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
