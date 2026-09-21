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

The program format lives in [program.md](references/program.md): fields, kinds,
requirement IDs, enforced rules, and one example. This section is how to
author the graph.

- **Decompose.** One action per bounded outcome a single worker can finish
  alone. Every writer gets an `ownedFiles` territory. All workers share one
  tree, so tell each to preserve others' edits and to report any file it needs
  outside its territory instead of editing it.
- **Dependencies are inputs, not phases.** `dependsOn` lists the actions whose
  outputs this action reads. Everything with no unmet dependency runs at once.
  A phase is simply the set of actions that become ready together; never add a
  dependency to fake one.
- **Integrate after parallel writers.** One `integration` action that depends
  on all of them, directly or through a digest, with `ownedFiles: []`, which
  on a build-lane action means no territory limit. It reads their outputs,
  resolves shared-file requests, and runs the repository's acceptance checks.
  It runs alone.
- **Check independently when acceptance matters.** One `adversarial-acceptance`
  action with empty `affects` and `ownedFiles`, `evidenceFor` set to the
  requirement IDs it judges, depending on every writer that affects them.
  Describe what to inspect; the kernel supplies the evidence format. A
  requirement may be covered by evidence alone: a "verification" deliverable
  is the evidence report in the run result, not a file.
- **Digest when outputs pile up.** A `digest` action when three or more outputs
  feed one reader, or a reader's inputs exceed about 20 KB. The reader depends
  on the digest instead of the raw writers and gets `digestOf` links to them;
  the digest keeps every shared-file request. Evidence never depends on a
  digest.
- **Effort.** Writers are `implement`. High belongs to exactly three kinds:
  `integration` (the sole writer after parallel work), `architecture` (a
  read-only judgment whose report a later action consumes), and
  `adversarial-acceptance` (independent evidence). A study that reads code and
  writes markdown is `implement`. When a judgment must land in a file, keep it
  `implement`, or split it into an `architecture` action plus a writer that
  records its report. Never set `defaults.effort` to `high`, and do not
  restate `lane` or `effort` on an action that has a `kind`.
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
effort is above what its work warrants: lower that action's kind, or write the
reason it needs high into its `purpose`. `requirement-unchecked` names a
requirement no step lists in `evidenceFor`: the run can finish but never
verify it, so add it to an `adversarial-acceptance` step, or launch knowing the
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
that failed or was blocked, a check that rejected a requirement, a rejected
plan revision, a pause, a stalled worker, a step that looks stale, or steering
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
| `◆ <step> evidence · <id> failed` | a check rejected a requirement | a plan problem: add a step that fixes what the evidence names (see below) |
| `× plan revision rejected …` | your revision was not applied | fix the issues it lists and revise again |
| `⚠ <step> stalled on <pool> …` | the kernel stopped a silent worker | nothing: it retries on another pool or hands the step back |
| `⧖ pause requested …` | someone paused the run | `bullswarm workflow resume <shortId>` when it should go on |
| `⧖ steering received · …` | a person left guidance for you | decide what it means and revise the plan |
| `⚠ <step> looks stale: <reasons>` | the step may be stuck | see below |

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
verified; `reason:` says why in one line. `completed` means every step
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

A failed check is a plan problem, not a retry. When the check step reports a
requirement failed, keep the same run: export the plan, add a step that fixes
what the evidence names, and add that step's id to the check's `dependsOn`.
The changed check runs again after the fix, and the run finishes again.

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
