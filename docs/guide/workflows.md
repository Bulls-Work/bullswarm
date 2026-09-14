---
title: Workflows
permalink: /guide/workflows/
---

## Starting a workflow

For multi-step work, give Bullswarm the goal and the program you author for
it. The program is a JSON document of dependent actions, not a list of phases
the kernel walks in lockstep. The **kernel** is Bullswarm's own runtime: it
validates the graph, routes each action, and computes the result. It is not
an agent.

```bash
# 1. What the kernel will enforce: requirement IDs, rules, action schema, example.
bullswarm workflow plan contract \
  "1. Fix the failing tests with the smallest correct change. 2. Verify them." \
  --cwd ~/some-repo --json

# 2. Launch with your program. Starts independently, prints observation
#    commands, and returns. Add --watch to follow low-noise progress.
bullswarm workflow goal \
  "1. Fix the failing tests with the smallest correct change. 2. Verify them." \
  --cwd ~/some-repo --program plan.json --watch

# Don't want to plan? Ask for a Workflow Planner agent explicitly.
bullswarm workflow goal \
  "Audit and repair the parser, then run its acceptance tests" \
  --cwd ~/some-repo --orchestrator auto --watch
```

`workflow goal` needs a program: with neither `--program`, `--scout`, nor
`--orchestrator` it exits 2, launches nothing, and prints the commands above.
That is deliberate — the kernel never plans on the caller's behalf unless the
caller asks for it by name.

`--max-agents`, `--max-actions`, and `--max-expansion-rounds` are soft
planning targets for a dispatched planner. They encourage the Workflow
Planner to consolidate optional work, but the kernel never stops or rejects
essential work merely because a target was reached. `--concurrency` still
bounds simultaneous dispatches so the scheduler can batch a wider useful
program safely. There is no default wall-clock timeout: fresh
semantic/transport heartbeats allow a useful worker to continue, while
silence is inspected rather than blindly killed.

The caller authors a complete program, or explicitly asks for a dispatched
planner. The kernel validates the graph, executes it, and returns every action
result. Independent agents share the target worktree. `ownedFiles` describes
intended territory — the files that action is meant to edit — and lets the
scheduler serialize overlapping writers; it does not reject or discard edits.
A dependent starts as soon as its own inputs finish, without waiting for
unrelated siblings. A failed action skips its dependents while other branches
continue.

After a parallel implementation wave, plan one integrator depending on all its
writers. Give it `lane: "build"` and `ownedFiles: []` to run alone with permission
to fix any file. Its prompt should read worker outputs, apply cross-territory
requests, reconcile shared files, and run the repository acceptance commands.
Analyze actions remain read-only. Evidence actions are optional and report
independent judgments; negative evidence does not open another planner round.
The graph ends with `completed` when all actions succeeded, or `partial` when
some failed or were blocked. `verified` separately records whether all mandatory
requirements have fresh passing evidence. Read that qualification and the
actual outputs before claiming acceptance. Further repairs use a new program.

Lane and effort are separate decisions for every proposed action. `analyze` is
read-only investigation, judgment, or evidence; `build` is contextual product,
test, or documentation mutation; `chore` is deterministic mechanical mutation.
The kernel rejects evidence outside `analyze`, file ownership inside `analyze`,
and any `chore` above low effort. Low is for fixed-procedure checks and edits,
medium is the default for ordinary bounded work, and high is reserved for
architecture, ambiguous tradeoffs, cross-cutting integration, or genuinely
adversarial acceptance judgment. Merely being an analysis/evidence action or
part of a difficult goal never promotes an action to high. The selected effort
then resolves through the High/Medium/Low routes configured by `bullswarm setup`
(see [Strategy](./strategy.md) and [Routing](./routing.md)).

### Kinds

Stating lane and effort separately on every action means re-deciding two
fields for work whose nature already implies both. The optional `kind` field
names that nature once and derives them:

| `kind` | lane | effort |
| --- | --- | --- |
| `mechanical` | chore | low |
| `io-read` | analyze | low |
| `digest` | analyze | low |
| `check` | analyze | medium |
| `implement` | build | medium |
| `integration` | build | high |
| `architecture` | analyze | high |
| `adversarial-acceptance` | analyze | high |

`digest` is the one kind whose instructions the kernel supplies in full — your
prompt for it is focus guidance only. It condenses the
outputs of the actions it depends on — quoting each source's delivered items,
validation numbers, commands, unfinished work, and requests verbatim, one
section per source, with no verdicts of its own — so an expensive consumer
reads one artifact instead of many raw output files, and the digest entry in
that consumer's dependency artifacts still names every digested source for
drill-down. Use one when three or more writers feed a single integrator, or
when a consumer's dependency outputs would exceed roughly 20 KB. A digest must
depend on at least one action, owns no files, needs no `affects`, and no
evidence action may depend on one: evidence reads the real artifacts.

Resolution is per field: an explicit `lane` or `effort` on the action wins,
then the kind table, then an optional program-level `defaults` object — which
may set only `effort` and `reasoning`, because lane follows the individual
action — then the per-lane default table. A `kind` outside that closed list is
a validation error, not a runtime failure: it is a typo in your program, so
`workflow plan validate` exits 2 and nothing launches. A program that uses
neither `kind` nor `defaults` and states `lane` and `effort` on every action
validates and runs exactly as before; the one widening is that `effort` is now
optional and falls back to the per-lane default instead of being rejected.

Two advisories report effort smells without ever rejecting anything.
`all-writers-high` fires when three or more `build`/`chore` actions run and
none is below high effort; `docs-at-high` fires when a `build`/`chore` action
owns only `*.md` files at high effort. `workflow plan validate` includes them
as `advisories` in `--json` and prints `advisory:` lines otherwise, `workflow
goal` prints the same lines at launch, and both keep their exit codes. The
kernel stores them on the run, so `workflow runs show` lists them afterwards,
and `runs result`, `runs show`, and `workflow action show` print `kind` next to
lane and effort.

Reasoning depth is a third, independent decision. An action may carry an
optional `reasoning` field — `low`, `medium`, `high`, `xhigh`, `max`, or
`default` — that sets how hard the picked model thinks on that one action and
outranks every configured level for it. `default` passes nothing and lets the
worker CLI's own setting decide. Omitting the field keeps the configured level.
It never changes the pool, model, or effort tier, so a `low`-effort mechanical
step can still be given `xhigh` thinking and a `high`-effort action can be told
to think cheaply. A connector that does not accept the requested level gets the
nearest level it supports.

The planner does not author phases or declare success/failure. The kernel
derives stable presentation stages for the TUI and computes the final result.
Saved runs of the current engine (V2) retain their original execution and
workspace policy on resume. Earlier autonomous run directories (V1) are not
migrated or resumed; explicitly naming one fails before any paid dispatch.

The detached response includes a short ID and exact observation commands:

```bash
bullswarm workflow runs show <shortId>
bullswarm workflow watch <shortId>        # V2: attach, then one line per notable event
bullswarm workflow watch <shortId> --next # print the next notable event and exit
                                          # relaunch with the --after/--since it prints
bullswarm workflow runs result <shortId> --json --summary  # compact status-loop envelope once terminal
bullswarm workflow                         # unified human workflow home
bullswarm workflow tui <shortId>          # jump directly to one run timeline
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow action show --json <shortId> <actionId>
```

Manage a run with first-class verbs:

```bash
bullswarm workflow plan export <shortId> --out plan.json      # the live plan, editable
bullswarm workflow plan revise <shortId> --program plan.json  # change the plan while it runs
bullswarm workflow pause  <shortId> [--now]                   # start nothing new; resume continues
bullswarm workflow resume <shortId> --watch                   # lift a pause; verb form of goal --resume
bullswarm workflow steer  <shortId> --message "<guidance>"    # guidance for whoever plans the run
bullswarm workflow cancel <shortId> --json                    # a run with no kernel is finalized here
```

### Changing the plan of a live run

A caller-planned program run can be re-planned at any time: while agents are
working, while it is paused, or after it finished. Export the live plan, edit
it into the whole program you want from now on, and revise:

```bash
bullswarm workflow plan export ab12cd --out plan.json
bullswarm workflow plan revise ab12cd --program plan.json --rerun write-docs --summary "Docs must cover the new flag"
```

The kernel matches the file to the live plan by action id within about a
second. A new id is added. An action left as exported is kept: its finished
result is reused and a running agent keeps going. An action with any field
changed is amended: if its agent is running it is stopped, and the step starts
over with the new definition. An id in `rerun` discards its finished result and
runs again. An action missing from the file is removed: stopped if running,
never run again, and reported as `removed` in the result instead of counting
against it. Every step that depends on an amended or rerun step runs again,
because its inputs change. A removed or rerun evidence step's judgment stops
counting until it is judged again.

`plan revise` checks the revision before writing anything and exits 2 with
the issues for an invalid program, an unknown rerun id, a revision that changes
nothing, or a plan that moved since the export (`baseRevision`). Files a stopped
step already edited stay in the tree, so plan a repair step when that matters.
Revising a finished run reopens it: the earlier `result.json` is archived as
`result-before-revision-<n>.json` and the run finishes again. `workflow pause`
lets running agents finish and starts nothing new (`--now` stops them and runs
those steps again after resume); revisions apply while paused, and only
`workflow resume` continues the run.


`--orchestrator <pool>` expresses a preference and immediately falls back to
another eligible pool if that provider is quota-gated or unavailable; plain
`--orchestrator auto` leaves selection to the kernel. For controlled provider
QA only, add `--orchestrator-strict` to require that exact pool and fail if it
is not available. Controlled comparisons can additionally pin the exact planner
and worker routes without changing global strategy:

```bash
bullswarm workflow goal "Implement and verify the change" --cwd . \
  --orchestrator codex --orchestrator-strict --orchestrator-model gpt-5.6-sol \
  --worker-pool opencode2 --worker-model relay/gpt-5.6-luna
```

These pins, plus `--suggested-plan` and `--no-scout`, apply only with
`--orchestrator`. When you are the planner, the plan is the program.

The worker lock covers scout, work actions, and evidence actions. A pool that cannot guarantee
the requested model is ineligible rather than silently substituting another
model.

Reasoning depth can be pinned for a whole run the same way, without touching
global strategy:

```bash
bullswarm workflow goal "Implement and verify the change" --cwd . \
  --program plan.json --worker-reasoning high --json
bullswarm run --lane build --reasoning xhigh --prompt '<task>' --json
```

`--worker-reasoning` covers scout, work actions, and evidence actions;
`--planner-reasoning` covers a dispatched Workflow Planner and applies only
with `--orchestrator`. Exactly one level is resolved per attempt, and the
first layer that sets one wins — not the strongest: the action's own
`reasoning` field, then the run-wide flag (`--worker-reasoning`,
`--planner-reasoning`, `bullswarm run --reasoning`), then the configured
`strategy.reasoning` level for that pool and tier, then the same for the tier
globally, then the connector's own default for the effort tier, and otherwise
nothing is appended. So an action asking for `low` beats a run-wide `max`.
`default` at any layer stops there and passes nothing, letting the worker
CLI's own setting decide; a connector with no `reasoning` block, or a model it
marks as skipped, never receives a flag. The applied level is recorded on
every attempt with the layer that set it and displayed next to the model, so a
run that thought more cheaply than requested is visible rather than inferred.

The `opencode2` connector itself does not require a Relay provider: its base
spawn command carries no hardcoded model, so a plain OpenCode installation
dispatches with OpenCode's own configured default. When
`~/.config/opencode/opencode.json` has one or more Relay providers configured,
Bullswarm discovers them and pins an explicit `--model <providerId>/gpt-5.6-luna`
per provider — the first as the primary `opencode2` pool, each additional one
as its own `opencode2:<id>` pool — which is what the `--worker-model
relay/gpt-5.6-luna` example above locks onto.

New goal runs use the shared workspace regardless of the older setup
worktree-isolation preference. Add `--isolation` to `workflow goal` when you
explicitly want per-worker worktrees and strict ownership before integration.
Pass it to `workflow plan contract` and `workflow plan validate` as well so the
contract describes that run. Shared execution does no manifest scan, copying,
integration, or rollback. Its final Git inventory is advisory, includes
pre-existing/concurrent changes, and never prevents completion if unavailable.

## Building a workflow from the shell

### You are the planner: `--program` and `workflow plan`

This is the default. The calling agent (Claude Code, Codex, or any frontier
model with the repository in context) is the Workflow Planner, instead of the
kernel paying for a dispatched scout and planner that cannot see the
conversation. The kernel handles graph validation, quota routing, scheduling,
mechanical retries, optional evidence, durable recovery, and the result envelope while the
caller supplies the program, exactly the division of labour Claude Code's
`Workflow` tool uses between the authoring model and its harness.

```bash
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
#   → requirement IDs (requirement-1..n), rules, action fields, validation, example
bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json
#   → dry run against that contract; exit 0 valid, exit 2 with the issues; nothing launches
bullswarm workflow goal "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --watch
#   → validated before launch; executes with zero planner/scout dispatches
bullswarm workflow plan show <shortId> --json      # initial scout or explicit steering pause
bullswarm workflow plan submit <shortId> --program plan-2.json --watch
```

Exit codes are a contract: **0** done or paused durably for you (nothing is
running), **1** the run ended without completing, **2** usage or validation
error with nothing launched. Every refusal names the commands that come next.

For foreground execution, exit 0 means the graph ran successfully or paused
durably; it does not imply independent verification. An independent launch
also returns 0 before the workers finish. Consume its eventual result.

`--program` accepts the planner response envelope or a bare
`bullswarm.workflow.program.v2` document. An invalid program exits 2 with the
validator's issues and nothing is launched. When the kernel reaches a planning
boundary (an initial plan, or a run about to finish with queued steering still
unread), it writes `planner-request-turn-N.json`, sets the run to `waiting`,
exits, and `watch` prints the `plan show` command. A submitted program contains
only new actions and is validated against the exact durable state at that
boundary. Steering queued while work is still running does not stop it: watch
prints `steering received` and the caller answers with `plan revise` (see
[Changing the plan of a live run](#changing-the-plan-of-a-live-run)). Older saved V2
runs still support their original gap boundaries and `--exhausted` submissions.
`--scout` without
`--program` runs the kernel scout first and pauses at the initial boundary so
the caller plans against a real survey; scout units are advisory for a caller
planner.

An action's result envelope is covered in [Operations](./operations.md#result-envelope);
the JSON example program shape (writers, a digest, and one integrator) is in
[Operations, Context diet](./operations.md#context-diet).
