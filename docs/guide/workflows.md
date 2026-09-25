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
| retry | a step stopped for a reason a retry fixes: a crashed or silent worker, no pool, a paused pool | `bullswarm workflow resume <shortId>`; it reruns exactly those steps and the steps blocked behind them |
| rerun | a step failed in a run started by this version | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>]` runs it again with its last attempt's handoff |
| accept | you choose to keep a failed step as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"`: recorded as your choice, never proof |
| take over | the rest is small, or needs something only you have | do it yourself; `bullswarm workflow runs result <shortId> --json` names every step's output |
| restart | the goal or the approach was wrong | start a new run: `bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` |

`retry` appears only when a step is retryable. When nothing is, `resume` prints `nothing to retry`, starts nothing and exits 1. A step whose pools were all paused shows `its pool is back at <time>`; resuming before then fails it again at once. `rerun` and `accept` appear only in runs started by this version that have a failed step.

When the review loop left a requirement failing in a run started by this version, `your call:` also offers the check that judged it: `rerun` is `bullswarm workflow step rerun <shortId> <check> --avoid <pool>` (it judges again on another pool), and `accept` is `bullswarm workflow step accept <shortId> <check> --requirement <id> --reason "…"`. An accepted requirement then reads `requirement <id>: failed · accepted by choice "<reason>"`: it stays failed and the run stays not verified.

## The failure rule and needs-you block

Each step gets one automatic retry in total. A process failure retries on
another eligible pool; a gate failure retries on the same pool with the failure
attached. A started `act` step is never retried automatically. Quota moves to
another eligible pool without spending the retry, or makes the step wait for a
known return time. Only dependents wait; unrelated steps keep running. Saved
runs keep their original rules.

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

A step with no pool to run on until a known time prints one line, `⧖ <step>
waiting for quota · <pool> back at <time> (in <duration>)`, and starts again by
itself when the pool is back. `--until trouble` wakes on it only when the wait
is longer than 30 minutes; then it adds the printed options: change the step
(the two plan commands), lift the pause with `bullswarm pools resume <pool>`
when a paused pool causes the wait, or run it elsewhere with `step rerun
--avoid` for a hold or 5-hour limit when the step's route allows another pool.

```bash
# the compact result: status, verified, reason, every action, usage, and next
bullswarm workflow runs result ab12cd --json --summary
```

## Next steps

- [Program format](/reference/program) — every program field, kind, and enforced rule.
- [Observing runs](/guide/observing) — watch the run, wake on events, and read the TUI.
- [Run](/guide/run) — when one bounded task is all you need.
