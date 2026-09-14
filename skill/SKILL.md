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
validate again. Exit 0 always carries an `advisories` array. Each entry names
an action whose effort is above what its work warrants (`all-writers-high`,
`docs-at-high`): lower that action's kind and validate again, or write the
reason it needs high into its `purpose`. An empty array means launch now, with
the same goal, `--cwd` and absolute `--program` (validate's `next.launch` line
is this command):

```bash
bullswarm workflow goal "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json --json
```

The launch detaches and returns `shortId`; report it.

## 3. Observe and judge

```bash
bullswarm workflow watch <shortId> --next
bullswarm workflow runs result <shortId> --json --summary
```

Run `watch --next` in a background terminal. When it exits, act on the printed
event and relaunch with the exact `next: bullswarm workflow watch <shortId>
--next --after <sequence> --since <iso>` line it printed, until the outcome
line reports a pause or a terminal status. A pause is not completion.

Each wake-up is a decision point: read the output of the step that just
finished (`bullswarm workflow action show <shortId> <actionId>` names its
`outputFile`) and decide whether the rest of the plan still fits. If it does,
relaunch the watcher. If it does not, revise the plan (section 4) before
relaunching.

Then read the real outputs and artifacts and probe the important edge cases
yourself. `completed` means the graph ran. `verified` means evidence passed,
which can still miss bugs. `partial` exposes failed or skipped branches; revise
the plan to repair them (a revision reopens a finished run). Shared files
remain after failure or cancellation. Exit 0 can mean launched, paused, or
completed, so always inspect the returned status.

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
- `watch --next` wakes on `plan revised`, `plan revision rejected`, pause lines,
  and `steering received`. Steering a person queued never halts work: decide
  what it means for the plan and revise. The exported file lists pending
  steering in `steeringIds`, and a revision from that file marks it delivered.
  A run about to finish with unread steering pauses for it instead.

[operations.md](references/operations.md) covers the revision details, pause
and resume, cancellation, scouting, a dispatched planner, isolation, watch
flags, reasoning depth, digest details, the live planning contract, and routing
diagnosis.
