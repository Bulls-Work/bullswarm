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

Start from the contract. It prints the program v3 format (`bullswarm.workflow.contract.v3`: the step, gate and loop fields, the rules, and an example that validates) as JSON. `--v2` prints the contract of old v2 programs instead, with the requirement IDs derived from your goal:

```bash
# the v3 program format, its rules and an example that validates
bullswarm workflow plan contract "Make the acme tests pass" --cwd /abs/path/to/acme --json

# the v2 contract: requirement IDs, rules, schema and an example for this goal
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd /abs/path/to/repo --v2 --json
```

`workflow goal` never plans on your behalf unless you ask for it by name: with no `--program`, `--scout`, or `--orchestrator` it exits 2, launches nothing, and prints the three commands that come next.

| Flag | Meaning | Default |
| --- | --- | --- |
| `--program <file.json>` | the program you authored (v3, or an old v2 one); validated against its contract before launch, then executed with zero planner or scout dispatches | required unless `--scout` or `--orchestrator` is given |
| `--scout` | the kernel surveys the repository first and hands you advisory findings to plan from | off |
| `--orchestrator auto\|<pool>` | dispatch a Workflow Planner agent at every planning boundary instead of planning yourself | off (you are the planner) |
| `--isolation` | per-worker worktrees and strict exact-file ownership checks | off (shared workspace, advisory territories) |
| `--concurrency <n>` | maximum parallel dispatches | 4 |
| `--retry-attempts <0..3>` | automatic retries per step before it comes back to you | 1 |

## Program v3: steps, gates and loops

New work is written as a v3 program (`bullswarm.workflow.program.v3`). It has
four blocks:

- `steps`: the work. Each step is a run: `id`, `prompt`, `dependsOn`, and
  optional `phase`, `label`, `lane`, `effort`, `reasoning`, `route`, `answer`,
  `evidence`, `deliverable`, `files`, `retry` (0 or 1) and `timeBox`.
- `phase`: a label on a step that groups steps on the dashboard. It changes
  nothing else.
- `gates`: `{id, dependsOn, when?, note?}`. The steps behind a gate wait until
  you run `bullswarm workflow continue <run> <gate>`. With `when`, the gate
  waits only when its condition holds and passes by itself otherwise.
- `loops`: `{id, steps, until, maxRounds}` (1-5 rounds). The loop runs every
  one of its steps in every round and reads `until` when the round is over.

A step passes by facts: its worker ended cleanly, its deliverable was
produced, its evidence passed, and its answer (when it declares one) matched
the schema. An `answer` is a JSON schema: the worker writes JSON to a file
Bullswarm names, and the file is checked, handed to the steps that depend on
it, and read by conditions. A check is an ordinary step with an `answer`
and/or `evidence`. v3 has no requirement IDs, `evidenceFor`, roles, kinds or
`verifyRounds`: validate refuses them, and a v3 run reports facts per step,
never `verified`.

There is one condition form, for a gate's `when` and a loop's `until`:
`{"step": "critique", "field": "passed"}` reads a boolean the step's answer
schema requires (add `"equals": false` to invert it), and
`{"step": "check", "evidence": "passed"}` reads whether the step's evidence
passed. When `until` is the evidence form, a failed check on that step reads
as "not passed" and the loop goes on; with the field form, a failed check
fails the step as it would outside a loop.

A loop that fixes until the tests pass:

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    {
      "id": "fix",
      "lane": "build",
      "prompt": "In /private/tmp/v37fix/acme, `npm test` fails. Find the cause in src/ and fix it; do not change tests/. From round 2 on, the Previous round block lists what the last check saw: fix that."
    },
    {
      "id": "check",
      "dependsOn": ["fix"],
      "prompt": "In /private/tmp/v37fix/acme, run `npm test` and list every failing test with its first error line. Change no file.",
      "answer": {
        "type": "object",
        "required": ["problems"],
        "properties": { "problems": { "type": "array", "items": { "type": "string" } } }
      },
      "evidence": [{ "type": "command", "cmd": "npm test", "timeoutSec": 120 }]
    }
  ],
  "loops": [
    { "id": "until-green", "steps": ["fix", "check"], "until": { "step": "check", "evidence": "passed" }, "maxRounds": 3 }
  ]
}
```

```bash
bullswarm workflow plan validate "Make the acme tests pass" --cwd=/private/tmp/v37fix/acme --program=/private/tmp/v37fix/loop.json
```

```text
✓ program v3 valid: 2 steps, 0 gates, 1 loop (nothing launched)
  fix                      build/medium deliverable=files
  check                    analyze/medium evidence=command answer after fix
  loop until-green         steps fix, check · until check's evidence passed · at most 3 rounds
  launch   bullswarm workflow goal 'Make the acme tests pass' --cwd /private/tmp/v37fix/acme --program /private/tmp/v37fix/loop.json --json
```

A gate that stops before publishing, validated the same way:

```text
✓ program v3 valid: 2 steps, 1 gate, 0 loops (nothing launched)
  count                    analyze/medium answer
  post                     build/medium deliverable=files after approve
  gate approve             after count · waits for you · Read the count and decide whether to write DONE.md
  launch   bullswarm workflow goal 'Count and publish' --cwd /private/tmp/v37fix/proj --program /private/tmp/v37fix/gate.json --json
```

A goal over 120 characters, or with a line break, shows as `"<goal>"` in the
launch line: put your goal back in its place before you run it.

### A run that waits for you

A gate stops only the steps behind it; other branches keep running. When only
waiting gates or loops are left (a gate waiting, or a loop out of rounds), the
run parks with status `waiting`. `bullswarm workflow watch <run> --until
trouble` wakes on it, and `runs result` prints where it waits:

```text
outcome: waiting
waiting: gate approve · Read NOTE.md and decide whether to write DONE.md
next: bullswarm workflow continue 2fne62 approve
```

`bullswarm workflow wait <run> <id...>` reads until the named steps, gates or
loops settle, and prints their facts and checked answers (exit 0, 1 when one
failed or the run stopped short, 2 on a timeout or an unknown id):

```text
✓ count succeeded · grok · grok-4.7 · 35s
  output   /private/tmp/we-home/workflows/wf-mulitifp-c82a30/out-count-attempt-1.md
  answer
    {
      "lines": 4,
      "short": true
    }
⧖ gate approve waiting · Read NOTE.md and decide whether to write DONE.md
  continue bullswarm workflow continue 2fne62 approve
```

What moves a waiting run:

| You want | Command |
| --- | --- |
| pass a waiting gate | `bullswarm workflow continue <run> <gate>` |
| give a loop out of rounds more rounds | `bullswarm workflow continue <run> <loop> --rounds <1-5>` (without `--rounds` the loop passes as it stands) |
| add work that depends on an answer | `bullswarm workflow add <run> --steps part.json` (or `--from-answer <step>` when the step's answer is itself a fragment `{steps, gates?, loops?}`), then `bullswarm workflow wait <run> <added ids>` |

A v3 run's steps, gates and loops are never edited: `plan revise` on a v3 run
accepts only reruns. `workflow add` appends steps, gates and loops without
changing anything the run has, and reopens a finished run.

## v2 programs

The rest of this page describes v2 programs (`bullswarm.workflow.program.v2`):
actions with requirement IDs, roles and kinds, and a review loop. They still
validate, run and replay as before; write new work in v3.

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

The plan is never frozen. In a v3 run you add steps with `workflow add` (above), and `plan revise` only reruns steps. In a v2 run, export the live plan, edit it into the whole program you want from now on — add, change, or delete actions — and revise:

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

A v2 run never waits for its caller: when nothing more can happen on its own it finishes and hands back what is left. A v3 run finishes the same way, except that it parks with status `waiting` at a gate or at a loop out of rounds (see [A run that waits for you](#a-run-that-waits-for-you)), and a completed v3 run hands nothing back. The terminal lines give `outcome:` (`completed`, `partial`, or `cancelled`) plus, for a v2 run, whether the run is `verified`, `reason:` in one line, one `step …` / `requirement …` line per unfinished item, and then `your call:` with one command per option.

| Option | When it fits | What to do |
| --- | --- | --- |
| continue | the plan needs a fix, a new step, or a step redone | `bullswarm workflow plan export <shortId> --out plan.json`, edit it, then `bullswarm workflow plan revise <shortId> --program plan.json` (`--rerun <step ids>` runs finished steps again) |
| retry | a step stopped for a reason a retry fixes: a crashed or silent worker, a usage limit, or no pool free; or a usage limit or no free pool stopped the planner or scout and ended the run | `bullswarm workflow resume <shortId>`; it reruns exactly those steps and the steps blocked behind them, and that stopped planner or scout first |
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
left. The step comes back to you at once. Bullswarm does not wait for the
pool, move the step to another pool, or retry it, and the rest of the run
keeps going. Nothing about the pool is remembered either: Bullswarm reads the
pool's meter again at once (when it cannot be read, the pool counts as full until its reset only when the provider named that reset or an earlier meter reading gave it), and later steps route on that
reading, so a window it shows at 100% keeps the pool out until that window
resets. A limit notice that names no
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
each one is nearly spent, or at its 5-hour, weekly or monthly limit. The
`why` line then names every pool and its reason, for example `no pool with
quota to spare: pool-a at its 5-hour limit until <time>; pool-b at its weekly
limit until <time>; pool-c nearly spent (forecast 97.0%) until <time>`.
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
is at most 2 minutes), then comes back to you. Its header reads `rate limited · backed off twice` (`once` after one
backoff; a backoff is never counted as the retry), and a try after a backoff
reads `· after a rate-limit backoff`. One that names a longer wait comes back to you
at once, with `back at` at the end of that wait. One whose pool is no longer
free for the backoff (at its 5-hour, weekly or monthly limit, or nearly
spent in the meantime) comes back to you at once too: as `out of
quota` when that pool is out on a usage limit, with `back at` its return when
that is known. A sign-in failure, a provider error or a worker that died at
start still gets the step's one automatic retry by itself, on another free
pool when there is one. After a sign-in failure that retry skips every pool
that shares the credential; nothing is stored, so a later step can pick that
pool again.

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
# the compact result: status, verified (v2), reason, every action with a v3 step's answer, usage, and next
bullswarm workflow runs result ab12cd --json --summary
```

On a finished v3 run, the text form prints each step's checked answer:

```text
# workflow result  wf-mulitn5f-6c56dd  (5r8jyi)
# status  completed  result ready
# outcome  all 1 step succeeded
# proof  1 finished · unproven: task
# answer  task  {"words":13}
# actions  1
  task                     analyze/medium  succeeded
```

## Next steps

- [Program format](/reference/program) — every program field, kind, and enforced rule.
- [Observing runs](/guide/observing) — watch the run, wake on events, and read the TUI.
- [Run](/guide/run) — when one bounded task is all you need.
