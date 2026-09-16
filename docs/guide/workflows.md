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

The calling agent writes the program. The **kernel** is Bullswarm's own runtime, not an agent: it validates the graph, routes each action to a pool, schedules dependencies, retries mechanical failures, and computes the result.

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
| `--retry-attempts <0..3>` | bounded retries for mechanical failures | 1 |

## Decompose into actions with exact-file territories

Plan one action per bounded outcome a single worker can finish alone. Every writer gets an `ownedFiles` territory — exact repo-relative files, because validate refuses a directory or a glob there, and refuses a pinned pool that cannot run the step.

All workers share one tree, so make each prompt say it: preserve other workers' edits, and report any file needed outside the territory instead of editing it.

## Dependencies are inputs, not phases

`dependsOn` lists the actions whose outputs this one reads. Everything with no unmet dependency runs at once, and a dependent starts when its own inputs finish — not when unrelated siblings finish. Never add a dependency to fake a phase.

A failed action skips its dependents while other branches keep running. The graph ends `completed` when every action succeeded, or `partial` when some failed or were blocked.

## Integrate after parallel writers

After a parallel wave, plan one `integration` action depending on all its writers, directly or through a digest. Give it `ownedFiles: []`, which on a build-lane action means no territory limit, and it runs alone.

Its prompt should read the worker outputs, apply cross-territory requests, reconcile shared files, and run the repository's acceptance commands.

## Verify with an adversarial acceptance step

Acceptance is its own action of kind `adversarial-acceptance`: empty `affects`, empty `ownedFiles`, `evidenceFor` set to the requirement IDs it judges, and `dependsOn` covering every writer that affects them. Describe what to inspect — the kernel owns the evidence format and rejects instructions such as "return only JSON".

`verified` is computed separately from `completed`: it records whether every mandatory requirement has fresh passing evidence, so a run can finish and still be unverified.

## Condense with a digest

Use a `digest` action when three or more writers feed a single reader, or when a reader's dependency outputs would exceed roughly 20 KB. The kernel writes the whole digest task — your prompt is focus guidance only — and it quotes each source's delivered items, numbers, and shared-file requests verbatim, so the reader gets `digestOf` links instead of raw files.

A digest must depend on at least one action and owns no files. Evidence never depends on a digest: evidence reads the real artifacts.

## Effort comes from the kind

`kind` names the nature of the work once and derives lane and effort:

| `kind` | lane | effort | use for |
| --- | --- | --- | --- |
| `mechanical` | chore | low | renames, formatting, generated edits |
| `io-read` | analyze | low | fetch or read something and report it |
| `digest` | analyze | low | condense dependency outputs; the kernel writes the task |
| `check` | analyze | medium | a read-only inspection with a report |
| `implement` | build | medium | ordinary edits and writing, including docs written from code study |
| `integration` | build | high | the sole writer after parallel writers; `ownedFiles: []` |
| `architecture` | analyze | high | a read-only cross-cutting judgment a later action consumes |
| `adversarial-acceptance` | analyze | high | independent evidence |

Stating `lane` and `effort` on every action is the other way to say the same thing; a `kind` outside this table is a validation error, not a runtime failure. Reasoning depth is a third, independent decision: an action's optional `reasoning` field sets how hard the picked model thinks on that one action. Every field and default is in [Program format](/reference/program).

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

Goal: `1. Add --since to runs list. 2. Document it in README.`

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    {
      "id": "since-flag",
      "kind": "implement",
      "purpose": "Add --since to runs list with a unit test",
      "dependsOn": [],
      "affects": ["requirement-1"],
      "ownedFiles": ["src/workflow/runs-cli.js", "tests/runs-list.test.js"],
      "evidenceFor": [],
      "prompt": "In <cwd>, add a --since <time> flag to `bullswarm workflow runs list` in src/workflow/runs-cli.js with a unit test in tests/runs-list.test.js. Others share this tree: preserve their edits and report any file you need outside your territory. Run `npm test` and quote the summary line."
    },
    {
      "id": "readme",
      "kind": "implement",
      "purpose": "Document --since in README",
      "dependsOn": [],
      "affects": ["requirement-2"],
      "ownedFiles": ["README.md"],
      "evidenceFor": [],
      "prompt": "In <cwd>, document the --since <time> flag of `bullswarm workflow runs list` in the runs section of README.md, matching the style of the neighbouring flags. Edit README.md only."
    },
    {
      "id": "integrate",
      "kind": "integration",
      "purpose": "Reconcile both edits and run the full suite",
      "dependsOn": ["since-flag", "readme"],
      "affects": ["requirement-1", "requirement-2"],
      "ownedFiles": [],
      "evidenceFor": [],
      "prompt": "In <cwd>, read both dependency outputs, resolve any shared-file requests they raised, make the README wording match the flag as implemented, run `npm test`, and quote the summary line."
    },
    {
      "id": "verify",
      "kind": "adversarial-acceptance",
      "purpose": "Independently confirm the flag works and is documented",
      "dependsOn": ["since-flag", "readme", "integrate"],
      "affects": [],
      "ownedFiles": [],
      "evidenceFor": ["requirement-1", "requirement-2"],
      "prompt": "In <cwd>, exercise `bullswarm workflow runs list --since <time> --json` against a fixture home with runs on both sides of the bound, and check that README.md describes the flag and its accepted time forms. Inspect only; try to break it."
    }
  ]
}
```

`<cwd>` stands for your absolute repository path — nothing is substituted, so write the real path into every prompt. Two writers run at once, the integrator waits for both, and the acceptance step runs last:

```bash
# validate the file above against the same goal text
bullswarm workflow plan validate "1. Add --since to runs list. 2. Document it in README." --cwd /abs/path/to/repo --program plan.json --json

# once it validates, launch it
bullswarm workflow goal "1. Add --since to runs list. 2. Document it in README." --cwd /abs/path/to/repo --program plan.json --json
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
| continue | the plan needs a fix, a new step, or a step redone | export, edit, and revise the plan |
| retry | a step stopped for a reason a retry fixes, such as a quota or a crashed worker | `bullswarm workflow resume <shortId>` |
| take over | the rest is small, or needs something only you have | do it yourself; `runs result` names every step's output |
| restart | the goal or the approach was wrong | start a new `workflow goal` run |

A failed check is a plan problem, not a retry: export the plan, add a step that fixes what the evidence names, and add that step's id to the check's `dependsOn`, so the check runs again after the fix.

```bash
# the compact result: status, verified, reason, every action, usage, and next
bullswarm workflow runs result ab12cd --json --summary
```

## Next steps

- [Program format](/reference/program) — every program field, kind, and enforced rule.
- [Observing runs](/guide/observing) — watch the run, wake on events, and read the TUI.
- [Run](/guide/run) — when one bounded task is all you need.
