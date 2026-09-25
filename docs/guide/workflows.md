---
title: "Workflows: when a workflow beats a single run"
description: Write the program a Bullswarm workflow executes, validate and launch it, steer it while it runs, and act on what a finished run hands back.
---

# Workflows: when a workflow beats a single run

After this page you can tell when a workflow beats a single run, write the program it executes, validate and launch that program, change the plan while the run is live, and act on what a finished run hands back.

## When a workflow beats a single run

`bullswarm run` sends one bounded outcome to one agent: a review, a localized fix, a study with one deliverable.

Reach for a workflow instead when the work splits into parallel territories, when shared files need an integration step after the writers finish, or when acceptance must be judged by someone other than the author.

| Shape of the work | Entry point |
| --- | --- |
| One bounded outcome, one agent | `bullswarm run` — see [Run](/guide/run) |
| Parallel territories, integration, or independent acceptance | `bullswarm workflow goal` — the rest of this page |

## You are the planner

The calling agent writes the program. The **kernel** is Bullswarm's own runtime, not an agent: it validates the graph, applies each step's route, schedules dependencies, retries each step once, and computes the result.

Start from the contract, which prints the requirement IDs, rules, schema, and a worked example for your exact goal:

```bash
# the requirements, rules, program schema, and an example for this goal
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd /abs/path/to/repo --json
```

`workflow goal` never plans on your behalf unless you ask for it by name: with no `--program`, `--scout`, or `--orchestrator` it exits 2, launches nothing, and prints the three commands that come next.

| Flag | Meaning | Default |
| --- | --- | --- |
| `--program <file.json>` | the program you authored; validated against the exact requirements before launch, then executed with zero planner or scout dispatches | required unless `--scout` or `--orchestrator` is given |
| `--scout` | the kernel surveys the repository first and hands you advisory findings to plan from | off |
| `--orchestrator auto\|<pool>` | dispatch a Workflow Planner agent at every planning boundary instead of planning yourself | off (you are the planner) |
| `--isolation` | per-worker worktrees and strict exact-file ownership checks | off (shared workspace, advisory territories) |
| `--concurrency <n>` | maximum parallel dispatches | 4 |
| `--retry-attempts <0..3>` | automatic retries per step before it comes back to you | 1 |

## Decompose into actions with exact-file territories

Plan one action per bounded outcome a single worker can finish alone. Every writer gets an `ownedFiles` territory — exact repo-relative files, because validate refuses a directory or a glob there, and refuses a pinned pool that cannot run the step.

All workers share one tree, so make each prompt say it: preserve other workers' edits, and report any file needed outside the territory instead of editing it.

## Dependencies are inputs, not phases

`dependsOn` lists the actions whose outputs this one reads. Everything with no unmet dependency runs at once, and a dependent starts when its own inputs finish — not when unrelated siblings finish. Never add a dependency to fake a phase.

A failed action skips its dependents while other branches keep running. The graph ends `completed` when every action succeeded, or `partial` when some failed or were blocked.

## Integrate after parallel writers

After a parallel wave, plan one integrator (`kind: integration`, or a `combine` step with deliverable `files`) depending on all its writers, directly or through a digest. Give it `ownedFiles: []`, which on a build-lane action means no territory limit, and it runs alone.

Its prompt should read the worker outputs, apply cross-territory requests, reconcile shared files, and run the repository's acceptance commands.

## Verify with a check step

Acceptance is its own `check` step (or `kind: adversarial-acceptance` for high effort): empty `affects`, empty `ownedFiles`, `evidenceFor` set to the requirement IDs it judges, and `dependsOn` covering every writer that affects them. Describe what to inspect — the kernel owns the evidence format and rejects instructions such as "return only JSON".

`verified` is computed separately from `completed`: it records whether every mandatory requirement has fresh passing evidence, so a run can finish and still be unverified.

## Have Bullswarm run checks

Use command evidence for tests or other facts a command can check, and schema
evidence when output must match a JSON or JSONL shape. Keep commands scoped to
their step; put a whole-suite check on the step that runs alone or last. Checks
run after the deliverable gate and must not change the deliverable. A failure
gets one same-pool retry, then returns to you. A report can be checked with
`file: "$output"` or a command that reads `$BULLSWARM_STEP_OUTPUT`. A review
step (one with `evidenceFor`) and a digest take no evidence: put the commands a
reviewer must run in its prompt, or add a separate `check` step with evidence
and an empty `evidenceFor`. Such a step can also prove already-finished work
without rerunning it. Each check's result is in `runs result <id> --json` under
`actions[].evidenceResults`. See [Evidence in the program reference](/reference/program#evidence-command-and-schema).

## Condense with a digest

Use a `digest` action when three or more writers feed a single reader, or when a reader's dependency outputs would exceed roughly 20 KB. The kernel writes the whole digest task — your prompt is focus guidance only — and it quotes each source's delivered items, numbers, and shared-file requests verbatim, so the reader gets `digestOf` links instead of raw files.

A digest must depend on at least one action and owns no files. No review step depends on a digest: a reviewer reads the real artifacts.

## Effort comes from the role or kind

A `role` says what a step does, and an optional `deliverable` says what it leaves behind: `files`, a `report`, `data` or `media` at exact `paths`, or `outward` actions such as a sent message. A role-only step takes its lane and effort from both:

| role | default deliverable | files | data or media | report | outward |
| --- | --- | --- | --- | --- | --- |
| `investigate` | report | build/medium | build/medium | analyze/medium | — |
| `produce` | files | build/medium | build/medium | analyze/medium | — |
| `transform` | files | chore/low | chore/low | analyze/low | — |
| `combine` | (required) | build/high | build/medium | analyze/medium | — |
| `check` | report | — | — | analyze/medium | — |
| `act` | outward | — | — | — | analyze/medium |

A `kind` names a more exact nature. Each kind belongs to one role and keeps its own lane, effort and gate, so the two do not always match:

| kind | role | kind: lane/effort | role alone: lane/effort (default deliverable) | kind gate | role gate |
| --- | --- | --- | --- | --- | --- |
| `mechanical` | `transform` | chore/low | chore/low (files) | not judged | judged: a file change or a commit |
| `io-read` | `investigate` | analyze/low | analyze/medium (report) | not judged | report not empty |
| `architecture` | `investigate` | analyze/high | analyze/medium (report) | not judged | report not empty |
| `implement` | `produce` | build/medium | build/medium (files) | a file change or a commit | a file change or a commit |
| `integration` | `combine` | build/high | needs a deliverable | exempt | files: exempt; data/media: paths; report: not empty |
| `digest` | `combine` | analyze/low, kernel-written task | — | not judged | a role step never gets the digest task |
| `check` | `check` | analyze/medium | analyze/medium (report) | not judged | not judged with evidenceFor, else report not empty |
| `adversarial-acceptance` | `check` | analyze/high | analyze/medium (report) | not judged | same as check |

Give work steps a role. Keep commit, formatter and PR steps `kind: mechanical`, and use a kind for a `digest` or when you want its exact routing. A step whose declared deliverable was not produced fails as `not-produced`, and so does a build-lane step with no declared deliverable that changes no file and makes no commit. Stating `lane` and `effort` on every action is the other way to route; a role or `kind` outside these tables is a validation error, not a runtime failure. Reasoning depth is a third, independent decision: an action's optional `reasoning` field sets how hard the picked model thinks on that one action. Every field, default and gate is in [Program format](/reference/program#roles-and-deliverables).

## Validate, then launch

Validate is a dry run against the exact contract a launch would enforce — the same requirement ledger, the same validator. Exit 0 means valid; exit 2 prints every issue and launches nothing.

```bash
# check the program before launching; nothing is dispatched
bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd /abs/path/to/repo --program plan.json --json

# launch the same goal with the validated program; --watch follows progress here
bullswarm workflow goal "1. Fix the parser. 2. Update the docs." --cwd /abs/path/to/repo --program plan.json --watch
```

Use exactly the same goal text for validate and launch: requirements are derived from the goal, and numbered clauses (`1.`, `2.`) become `requirement-1`, `requirement-2`, and so on — a goal with no numbered items is one `requirement-1`. Exit 0 carries an `advisories` array — `all-writers-high`, `docs-at-high`, `requirement-unchecked` — which is advice, not refusal.

## A complete small program

Goal: `1. Add --since to runs list. 2. Document it in README. 3. Write the run records file.`

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    {
      "id": "since-flag",
      "role": "produce",
      "purpose": "Add --since to runs list with a unit test",
      "dependsOn": [],
      "affects": ["requirement-1"],
      "ownedFiles": ["src/workflow/runs-cli.js", "tests/runs-list.test.js"],
      "evidence": [{ "type": "command", "cmd": "node --test tests/runs-list.test.js" }],
      "evidenceFor": [],
      "prompt": "In <cwd>, add a --since <time> flag to `bullswarm workflow runs list` in src/workflow/runs-cli.js with a unit test in tests/runs-list.test.js. Others share this tree: preserve their edits and report any file you need outside your territory. Run `npm test` and quote the summary line."
    },
    {
      "id": "readme",
      "role": "produce",
      "purpose": "Document --since in README",
      "dependsOn": [],
      "affects": ["requirement-2"],
      "ownedFiles": ["README.md"],
      "evidenceFor": [],
      "prompt": "In <cwd>, document the --since <time> flag of `bullswarm workflow runs list` in the runs section of README.md, matching the style of the neighbouring flags. Edit README.md only."
    },
    {
      "id": "records",
      "role": "produce",
      "deliverable": { "type": "data", "paths": ["out/records.json"] },
      "purpose": "Write records that match the documented format",
      "dependsOn": [],
      "affects": ["requirement-3"],
      "ownedFiles": ["out/records.json"],
      "evidence": [{ "type": "schema", "file": "out/records.json", "schema": "schemas/record.json" }],
      "evidenceFor": [],
      "prompt": "In <cwd>, write out/records.json as records that match schemas/record.json."
    },
    {
      "id": "integrate",
      "role": "combine",
      "deliverable": "files",
      "purpose": "Reconcile both edits and run the full suite",
      "dependsOn": ["since-flag", "readme"],
      "affects": ["requirement-1", "requirement-2"],
      "ownedFiles": [],
      "evidenceFor": [],
      "prompt": "In <cwd>, read both dependency outputs, resolve any shared-file requests they raised, make the README wording match the flag as implemented, run `npm test`, and quote the summary line."
    },
    {
      "id": "verify",
      "role": "check",
      "route": { "independentOf": ["since-flag"] },
      "effort": "high",
      "purpose": "Independently confirm the flag works and is documented, and the records file exists",
      "dependsOn": ["since-flag", "readme", "records", "integrate"],
      "affects": [],
      "ownedFiles": [],
      "evidenceFor": ["requirement-1", "requirement-2", "requirement-3"],
      "prompt": "In <cwd>, exercise `bullswarm workflow runs list --since <time> --json` against a fixture home with runs on both sides of the bound, check that README.md describes the flag and its accepted time forms, and check that out/records.json exists. Inspect only; try to break it."
    }
  ]
}
```

`<cwd>` stands for your absolute repository path — nothing is substituted, so write the real path into every prompt. Three writers run at once, the integrator waits for the code and README writers, and the acceptance step runs last:

```bash
# validate the file above against the same goal text
bullswarm workflow plan validate "1. Add --since to runs list. 2. Document it in README. 3. Write the run records file." --cwd /abs/path/to/repo --program plan.json --json

# once it validates, launch it
bullswarm workflow goal "1. Add --since to runs list. 2. Document it in README. 3. Write the run records file." --cwd /abs/path/to/repo --program plan.json --json
```

## Steer a live run

The plan is never frozen. Export the live plan, edit it into the whole program you want from now on — add, change, or delete actions — and revise:

```bash
# write the live plan as an editable revision document
bullswarm workflow plan export ab12cd --out plan.json

# apply your edited program; --rerun redoes finished steps, --summary says why
bullswarm workflow plan revise ab12cd --program plan.json --rerun write-docs --summary "Docs must cover the new flag"
```

The kernel matches the file to the live plan by action id within about a second, even while agents are running:

| In your file | What happens |
| --- | --- |
| a new id | added; runs once its dependencies succeed |
| an action left exactly as exported | kept: a finished result is reused, a running agent keeps going |
| an action with any field changed | amended: a running agent is stopped and the step starts over |
| an unchanged id listed in `rerun` | its finished result is discarded and it runs again |
| an action you deleted | removed: stopped if running, never run again, reported as `removed` |
| anything depending on an amended or rerun step | runs again, because its inputs change |

`revise` checks before it writes: an invalid program, an unknown rerun id, a revision that changes nothing, or a plan that moved since your export (`baseRevision`) exits 2 and leaves the run untouched. Files a stopped step already edited stay in the tree, so plan a repair step when that matters.

`workflow pause <shortId>` starts nothing new while running agents finish (`--now` stops them and reruns them after resume); revisions apply while paused, and only `workflow resume <shortId>` continues the run. Steering is the softer form: `workflow steer <shortId> --message "<guidance>"` queues guidance for the caller, and a run that finishes before anyone acts on it lists it as `steering not acted on`.

::: warning
A revision never lifts a pause, and a finished run that gets revised is reopened and finishes again. Revising is for changing the plan, not for restarting work you dislike.
:::

## When a run finishes

A run never waits for its caller: when nothing more can happen on its own it finishes and hands back what is left. The terminal lines give `outcome:` (`completed`, `partial`, or `cancelled`) plus whether the run is `verified`, `reason:` in one line, one `step …` / `requirement …` line per unfinished item, and then `your call:` with one command per option.

| Option | When it fits | What to do |
| --- | --- | --- |
| continue | the plan needs a fix, a new step, or a step redone | `bullswarm workflow plan export <shortId> --out plan.json`, edit it, then `bullswarm workflow plan revise <shortId> --program plan.json` (`--rerun <step ids>` runs finished steps again) |
| retry | a step stopped for a reason a retry fixes: a crashed or silent worker, no pool, a paused pool; or a usage limit or no free pool stopped the planner or scout and ended the run | `bullswarm workflow resume <shortId>`; it reruns exactly those steps and the steps blocked behind them, and that stopped planner or scout first |
| rerun | a step failed in a run started by this version | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>]` runs it again with its last attempt's handoff |
| accept | you choose to keep a failed step as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"`: recorded as your choice, never proof |
| take over | the rest is small, or needs something only you have | do it yourself; `bullswarm workflow runs result <shortId> --json` names every step's output |
| restart | the goal or the approach was wrong | start a new run: `bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` |

`retry` appears only when a step is retryable, or, in a run started by this version, when a usage limit or no free pool stopped the planner or scout and ended the run; then it reads `bullswarm workflow resume <shortId> after <time> (reruns the workflow planner)` (`the preflight scout` for the scout; no `after <time>` when no return time is known). When nothing is retryable, `resume` prints `nothing to retry`, starts nothing and exits 1. A step with a known return time shows `its pool is back at <time>`; resuming before then can fail it again (at once when no other pool is free). `rerun` and `accept` appear only in runs started by this version that have a failed step.

When the review loop left a requirement failing in a run started by this version, `your call:` also offers the check that judged it: `rerun` is `bullswarm workflow step rerun <shortId> <check> --avoid <pool>` (it judges again on another pool), and `accept` is `bullswarm workflow step accept <shortId> <check> --requirement <id> --reason "…"`. An accepted requirement then reads `requirement <id>: failed · accepted by choice "<reason>"`: it stays failed and the run stays not verified.

## The failure rule and needs-you block

Each step gets one automatic retry in total. A process failure (a crash, a
silent worker, a sign-in failure, a provider error, or a worker that died at
start) retries on another eligible pool; a gate failure retries on the same
pool with the failure attached. A started `act` step is never retried
automatically. A usage limit is never retried, moved or waited out: the step
comes back to you (see below). Only dependents wait; unrelated steps keep
running. Saved runs keep their original rules.

When a step needs you, the watch gives one block with the failure, each try,
steps still running, dependents waiting on it, and four commands. For example:

```text
✗ variants needs you · command evidence failed after 1 retry
  evidence  node check-assets.mjs out/ → exit 1
            banner-b.png has the wrong dimensions
  try 1  pool-a · image model · 11m00s · 3 files
  try 2  same pool, failure attached · 7m00s · 3 files
  still running: copy · waiting on this: pick
  your call:
    rerun elsewhere  bullswarm workflow step rerun <id> variants --avoid pool-a
    change the step  bullswarm workflow plan export <id> --out plan.json
      then edit it   bullswarm workflow plan revise <id> --program plan.json
    take over        output: <absolute output path>
    accept anyway    bullswarm workflow step accept <id> variants --reason "…"
  next: bullswarm workflow watch <id> --until trouble --after <sequence> --since <iso>
```

Choose one `your call` command, then relaunch the exact `next:` line. When no
other pool could run the step, the first option reads `retry here` with a plain
`step rerun`. Rerunning with `--avoid` keeps that pool excluded in the step's
route. Accepting records `choice`, never proof; rerunning the step undoes
acceptance. When a review still fails after its fix, the block names the check
that judged the failing requirement; another check that failed one gets its
own `also judged by <check>:` lines with its rerun and accept.

A usage limit ends the step: a spent 5-hour or weekly window, or no credit
left. The step comes back to you at once, whatever the automatic pausing
switch. Bullswarm does not wait for the pool, move the step to another pool,
or retry it, and the rest of the run keeps going. A limit notice that names no
reset ends the step too; its block then prints `back at` only when every pool
that can run the step is out and one of them has a known return. When the
reset is known, the block says when the pool is back and adds a `wait for it`
option:

```text
✗ build needs you · out of quota · not retried
  why       <the provider's limit notice>
  back at   2026-09-25T14:00:00.000Z
  try 1  pool-a · model-a · 4m00s · 0 files
  your call:
    rerun elsewhere  bullswarm workflow step rerun <id> build --avoid pool-a
    wait for it      after 2026-09-25T14:00:00.000Z: bullswarm workflow step rerun <id> build
    change the step  bullswarm workflow plan export <id> --out plan.json
      then edit it   bullswarm workflow plan revise <id> --program plan.json
    take over        output: <absolute output path>
    accept anyway    bullswarm workflow step accept <id> build --reason "…"
  next: bullswarm workflow watch <id> --until trouble --after <sequence> --since <iso>
```

The same happens when no pool that can run the step is free when it is picked:
each one is nearly spent, at its 5-hour limit, paused (for quota, or after a
sign-in failure), or benched after repeated failures. The `why` line then
names every pool and its reason, for example `no pool with quota to spare:
pool-a paused for quota until <time>; pool-b at its 5-hour limit until <time>`.
When one of the reasons is not a usage limit it reads `no pool free: …`, and
the header reads `no eligible pool`. `back at` is then the earliest known
return among those pools; a pool whose return is unknown is skipped. When
another pool that can run the step is free, routing picks it and nothing comes
back to you. A retry the step was promised (after a crash, a sign-in failure or
a failed gate) that finds no free pool keeps its own failure, and its `why`
ends `· no retry: <pool> <reason>; …`.

Your choices after a usage limit, or with no pool free:

- rerun elsewhere: `bullswarm workflow step rerun <id> <step> --avoid <pool>`,
  when another pool can run the step now;
- wait for it: after the `back at` time, run the printed `bullswarm workflow
  step rerun <id> <step>` yourself; nothing reruns it for you;
- accept anyway, change the step, or take over, as for any other failure;
- cancel the run: `bullswarm workflow cancel <id>`.

A short "too many requests" rate limit is not a usage limit. It backs off on
the same pool at most twice (20 s, then 60 s, or the wait it names when that
is at most 2 minutes), then comes back to you, with automatic pausing on or
off. Its header reads `rate limited · backed off twice` (`once` after one
backoff; a backoff is never counted as the retry), and a try after a backoff
reads `· after a rate-limit backoff`. One that names a longer wait comes back to you
at once, with `back at` at the end of that wait. One whose pool is no longer
free for the backoff (paused, at its 5-hour limit, nearly spent or benched in
the meantime) comes back to you at once too: as `out of quota` when that pool
is out on a usage limit, with `back at` its return when that is known. A
sign-in failure, a provider error or a worker that died at start still gets
the step's one automatic retry by itself, on another free pool when there is
one.

A pool whose weekly or monthly window closes soon and that this step would
push past its limit (the router's "expiring but draining") is never given the
step, even when it is the only pool left. The step takes another pool that can
run it, or comes back to you with `<pool> nearly spent (forecast <n>%) until
<time>` in its `why`. A pool you named (the run's `--worker-pool`, or a route
that allows only that pool) is exempt. The dispatched planner and the
preflight scout are never given such a pool either; only a pool you pinned is
exempt (`--orchestrator <pool> --orchestrator-strict` for the planner,
`--worker-pool` for the scout). Their schema correction, and the one retry on
the same pool they get when no other pool can run them, never go back to a
pool that has become nearly spent either: the correction moves to another free
pool, and with none free the planner or scout stops and tells you, with that
pool's `nearly spent` reason.

A `step rerun` (or a `resume`) after a failure the pool caused starts on
another pool when one can take the step now. Pool-caused failures are a
sign-in failure, a provider error, or a worker that exited with an error before
it answered or changed a file. The rerun prints `pool  starts on another pool
than <pool> …`, and the attempt's route reason starts with `moved off <pool>`.
The same pool runs it only when nothing else can. Unlike `--avoid`, this
changes nothing in the step's route. A usage limit is not one of these: a rerun
after one is routed as usual, so add `--avoid <pool>` to keep it off that pool.

A dispatched planner (`--orchestrator`) and the preflight scout (`--scout`, or
the scout before a dispatched planner) follow the same rule: a usage limit, a
rate limit still there after its short backoff, or no free pool stops it and
tells you; it never moves to another pool by itself. A sign-in failure, a
provider error or a worker that died at start still moves it to another pool.
When the planner stops, the watch prints `✗ planner stopped · out of quota on
<pool> · back at <time>` (`rate limited` or `no eligible pool` in place of
`out of quota`, `no pool` when none was picked), `--until trouble` wakes on
it, and the run finishes `partial` with this reason:

```text
the workflow planner stopped on a usage limit: <why> · back at <time> · your call: resume after <time> with bullswarm workflow resume <id>, plan it yourself with bullswarm workflow plan revise <id> --program <file.json>, or start a new run
```

It reads `stopped: no pool free` when a pool was out for a reason that is not a
usage limit, or when no pool can run it at all. It drops `back at` when no
return time is known, and then reads `bullswarm workflow resume <id> once a
pool is free` in place of `resume after <time> with …`. A scout with no program after it (`--scout` alone, or before a
dispatched planner) ends the run the same way, as `the preflight scout stopped
on a usage limit: …`. After the `back at` time, `bullswarm workflow resume
<id>` runs the stopped planner or scout again: it prints `✓ reopened the
partial run <id>; running again: the workflow planner` (or `the preflight
scout`), and the run goes on from there. Before then it can stop the same way,
and resume adds `note: the workflow planner stopped with its pool back at
<time>; run before then, it can fail the same way again`. `plan revise` with
your own program and a new run stay the other choices: `plan revise` reopens
the run and runs your program instead. With your program (`--program --scout`) the run goes on
without the report, and the watch prints `⚠ preflight scout stopped · out of
quota on <pool> · back at <time> · the run continues without its report`;
resume does not run that scout again. Runs
started by an earlier version keep moving the planner and the scout to another
pool.

```bash
# the compact result: status, verified, reason, every action, usage, and next
bullswarm workflow runs result ab12cd --json --summary
```

## Next steps

- [Program format](/reference/program) — every program field, kind, and enforced rule.
- [Observing runs](/guide/observing) — watch the run, wake on events, and read the TUI.
- [Run](/guide/run) — when one bounded task is all you need.
