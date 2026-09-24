---
title: Workflow program
description: The plan.json fields, roles, kinds, deliverables, requirement IDs, and rules that workflow plan validate and workflow goal --program enforce.
---

# Workflow program

After this page you can author a `plan.json` that `bullswarm workflow plan validate` accepts, and know which field, role, kind, deliverable, or rule would make launch exit 2.

`plan.json` is the program `bullswarm workflow goal --program` executes. Validate it against the running kernel before launch. Exit 2 returns `issues` and a `next` block; fix the file yourself. Exit 0 returns the resolved program and an `advisories` array. How to decompose a goal into actions is in [Workflows](/guide/workflows).

```bash
# Print the live contract for this goal (requirements, rules, schema, example).
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
```

Fetch that contract only when an issue names an unknown field, role, kind, deliverable, or `schemaVersion`, which can only happen after an upgrade this page has not followed.

## Program

No other top-level field is accepted.

| Field | Required | Value |
|---|---|---|
| `schemaVersion` | yes | exactly `bullswarm.workflow.program.v2` |
| `actions` | yes | non-empty array of actions |
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`), `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`), `timeBox` (whole minutes, 0–240) and `verifyRounds` (1–3); `effort`, `reasoning` and `timeBox` apply where neither the action nor its role or kind sets the field, and `verifyRounds` is the run's cap on verify rounds |

You may also wrap the same program in a planner-response envelope (`schemaVersion: "bullswarm.workflow.planner-response.v2"`, `kind: "program"`, `summary`, `program`). `workflow goal --program` and `plan validate` accept either shape. `--summary` names a bare program.

## Action

Any other field is rejected. Resolution per field: the action's own `lane` or `effort`, then the kind table, else the role table, then `defaults`, then the lane default (`analyze` → `medium`, `build` → `medium`, `chore` → `low`). Reasoning on the action outranks `defaults.reasoning`, then the run-wide `--worker-reasoning`, then strategy, then the connector default.

| Field | Required | Value |
|---|---|---|
| `id` | yes | kebab-case, unique in the program |
| `purpose` | yes | one line: what this action delivers |
| `dependsOn` | yes | ids of actions whose outputs this one reads or whose files/contracts a writer needs first; `[]` if none |
| `affects` | yes | requirement IDs this action's work contributes to; an action with `ownedFiles` must list at least one |
| `ownedFiles` | yes | repo-relative paths this action may edit; `[]` on a build-lane action means no territory limit (the integrator); analyze-lane actions edit nothing |
| `prompt` | yes | the self-contained task text with the absolute workspace path written in (nothing is substituted); for a `digest`, one line of focus appended to the kernel-written task |
| `evidenceFor` | yes | requirement IDs this action judges; `[]` unless it is evidence |
| `role` | role, kind or lane | one of the roles below; program-mode runs only |
| `kind` | role, kind or lane | one of the kinds below; each belongs to one role and keeps its own routing and gate (table below) |
| `lane` | role, kind or lane | `analyze` (read-only), `build` (edits), `chore` (mechanical edits); only when there is no role or kind |
| `deliverable` | no | `files`, `report`, `data`, `media`, `outward`, or `{type, paths}`; data and media need `paths`; every path must be an exact file, not a directory, and be listed in `ownedFiles` when it is not empty (`files` paths too); an isolated run refuses a git-ignored path |
| `effort` | no | `high`, `medium`, `low`; overrides the role's or kind's effort |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, `default`; how hard the picked model thinks |
| `timeBox` | no | whole minutes, 0–240: the soft time box written into this step's task; `0` leaves the paragraph out. Omit it to take `defaults.timeBox`, else the box computed from this home's recorded attempts |
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies. `produces` wires data between steps; it is not the deliverable |

`dependsOn` is an input dependency: list an action when a writer needs its files or contract before it can compile or prove its change. It makes the writer wait for that input; it does not represent a phase. Keep each behavior and its focused test in one writer action, and have writers run the checks they own. After integration, put the full browser/e2e gate, commit, and PR in separate ordered steps, in that sequence. Give the browser/e2e step an explicit `timeBox` sized for the full suite. Make the browser/e2e gate a `check` step, and the commit and PR steps `kind: mechanical` (not judged, and with empty ownedFiles they run alone). A step whose declared deliverable was not produced fails as `not-produced`, and so does a build-lane step with no declared deliverable that changes no file and makes no commit. An integrator is not judged by files, so a clean integrator still passes. An `act` step is for outward actions such as sending messages; it is never judged by files.

::: warning
Never set `defaults.effort` to `high`. High belongs to a `combine` step that merges written code, a design step (`kind: architecture`), and an independent check (`kind: adversarial-acceptance`). A study that reads code and writes markdown is a `produce` step.
:::

## Time box

Every dispatched step's task (work, digest and evidence) ends with a time-box paragraph: the box in minutes, the start clock, a wrap-up point at 70% of the box, and an invitation to stop and write three sections, `## Done`, `## Not done` (one line per unfinished item, or `- none`) and `## Suggested next step`. It is a guide, not a limit. Hard timeouts, stall detection, cancellation and routing are unchanged, and nothing is stopped at the box. Planner turns and the scout get no paragraph. A digest carries one like any other step, and a `## Not done` section in a digest's output is a quotation of its sources, so a digest never counts as returned early.

The box for an attempt is the first of these that applies:

1. the action's `timeBox`, in minutes (`0` leaves the paragraph out for that action);
2. `defaults.timeBox`;
3. 1.5 × the median wall minutes of the succeeded attempts in this home for the same pool and kind (or role, for a step with no kind), when that pair has at least 5, else for the kind or role alone when it has at least 5, else 20. It is rounded to a multiple of 5 and kept within 10–60. `opencode` attempts never feed it, because that pool runs a slow free model.

The box is resolved for each attempt, so a retry on another pool gets its own clock. A step whose report lists items under `## Not done` still succeeds. Its attempt records `returnedEarly` with the count and the items, the Step page reads `returned early · N not done` (and `box 20m · ran 34m` when the attempt ran past its box) and lists the stored items in the header, the selected Run timeline row and the Run live block list them too, `workflow watch` prints `◐ <step> returned early · N not done`, and the items are quoted to the verifiers that judge the requirements the step affects.

## Verify rounds

When a mandatory requirement fails its evidence step, the kernel does not wait for you. It runs a bounded repair loop of at most 3 verify rounds:

| Round | What it judges | What follows a failure |
|---|---|---|
| 1 | every declared requirement: those an evidence step names are judged; one no evidence step names is recorded as `not judged · no evidence step covers it` | a `repair-1` step: the failed requirements with the verifier's evidence, the not-done items and handoffs of the steps that affect them, and ownership of the union of those steps' `ownedFiles`; when every affecting step declares a `report`, a read-only `analyze` step with deliverable `report` and no files instead. A requirement an `act` step affects gets no repair and comes back to you; when only those fail, the loop stops with `stoppedBy: act-step` |
| 2 (`verify-round-2`) | the failed requirements again, plus any passed requirement whose evidence names a file the repair changed; it also looks for regressions in the repaired files and the same defect elsewhere | a `repair-2` step that also fixes what round 2 discovered |
| 3 (`verify-round-3`) | final closure: only whether each open requirement now passes; it adds nothing new | none: the run ends |

`defaults.verifyRounds` sets the cap from 1 to 3 (default 3; `1` keeps today's single round). A requirement that passed carries forward and is not judged again unless a repair touched a file its evidence names. The run ends as soon as nothing is failing, as `completed · verified`, or after round 3 as `completed · not verified · verify rounds 3/3` with a `callerDecision` block on the [result envelope](/reference/result). There is never a fourth round.

A requirement no evidence step covers is never judged and never counts as passed. Round 1 records it as `not judged · no evidence step covers it`, it does not start a repair by itself (only a failed or blocked requirement does), and it appears in the `callerDecision` block of the [result](/reference/result) and in `runs result --summary` when the run ends. A mandatory one keeps the run from being `verified`; an optional one leaves the verdict to the mandatory requirements, and the block still names it. To have it judged, add an evidence step whose `evidenceFor` names it.

The `repair-<n>` and `verify-round-<n>` steps are ordinary program steps that the kernel adds, so they appear in `plan export`, cost and pages like any other step. You never write one, and a `repair` field or type is rejected. A plan revision during the loop is still accepted, but only the kernel counts rounds: a revision never adds, resets or refunds one, and deleting the kernel step in progress stops the loop. `defaults.verifyRounds` in a revision sets the cap for the rest of the run, never below the rounds already closed, and a revision that changes only the cap is accepted.

## Roles and deliverables

A `role` says what a step does, and a `deliverable` says what it leaves behind. Both are optional and work only in program-mode runs. In new programs, give work steps a role and a deliverable. Use a kind for commit, formatter and PR steps (`mechanical`), for `digest`, or when you want a kind's exact routing.

- `investigate`: find something out and report it.
- `produce`: make new work: code, documents, data or media.
- `transform`: reshape existing work.
- `combine`: merge or condense the work of earlier steps.
- `check`: judge work; the step that names requirements in `evidenceFor`.
- `act`: act outside the workspace: send, post, publish, deploy.

A role-only step takes its lane and effort from the role and its deliverable (omit `deliverable` to take the default):

| Role | Default deliverable | files | data or media | report | outward |
|---|---|---|---|---|---|
| `investigate` | report | build/medium | build/medium | analyze/medium | — |
| `produce` | files | build/medium | build/medium | analyze/medium | — |
| `transform` | files | chore/low | chore/low | analyze/low | — |
| `combine` | (required) | build/high | build/medium | analyze/medium | — |
| `check` | report | — | — | analyze/medium | — |
| `act` | outward | — | — | — | analyze/medium |

A `combine` step must name its deliverable: `files` to merge written work, `data` or `media` to merge data or assemble media, or `report` to condense or compare results. A dash means the role does not take that deliverable. `files`, `data` and `media` need lane `build` or `chore`; `report` and `outward` need lane `analyze`, whatever set the lane. Do not restate `lane` or `effort` on a step with a role or kind. When you change `role` in an exported plan, delete the written-back `lane`, `effort` and `deliverable` too, unless you mean to keep that deliverable. When you change `deliverable`, delete `lane` and `effort`.

Each kind belongs to one role and keeps its own lane, effort and gate:

| Kind | Role | Lane | Effort | Use for |
|---|---|---|---|---|
| `mechanical` | `transform` | chore | low | renames, formatting, generated edits, commit and PR steps |
| `io-read` | `investigate` | analyze | low | fetch or read something and report it |
| `digest` | `combine` | analyze | low | condense dependency outputs verbatim; the kernel writes its task |
| `check` | `check` | analyze | medium | a read-only inspection with a report |
| `implement` | `produce` | build | medium | ordinary edits and writing, including docs written from code study |
| `integration` | `combine` | build | high | the sole writer after parallel writers; `ownedFiles: []` |
| `architecture` | `investigate` | analyze | high | a read-only cross-cutting judgment; its report feeds a later action |
| `adversarial-acceptance` | `check` | analyze | high | independent evidence; empty `affects` and `ownedFiles`, `evidenceFor` set |

So a kind and its role alone do not always route or gate the same way:

| Kind | Role | Kind: lane/effort | Role alone: lane/effort (default deliverable) | Kind gate | Role gate |
|---|---|---|---|---|---|
| `mechanical` | `transform` | chore/low | chore/low (files) | not judged | judged: a file change or a commit |
| `io-read` | `investigate` | analyze/low | analyze/medium (report) | not judged | report not empty |
| `architecture` | `investigate` | analyze/high | analyze/medium (report) | not judged | report not empty |
| `implement` | `produce` | build/medium | build/medium (files) | a file change or a commit | a file change or a commit |
| `integration` | `combine` | build/high | needs a deliverable | exempt | files: exempt; data/media: paths; report: not empty |
| `digest` | `combine` | analyze/low, kernel-written task | — | not judged | a role step never gets the digest task |
| `check` | `check` | analyze/medium | analyze/medium (report) | not judged | not judged with evidenceFor, else report not empty |
| `adversarial-acceptance` | `check` | analyze/high | analyze/medium (report) | not judged | same as check |

A step may give both a kind and a role only when the role is the kind's own; then only the kind is stored. The kind gate for `implement` applies to runs started by this version.

When a step ends, Bullswarm checks its deliverable. A step that did not produce it fails as `not-produced`. That failure is not retried automatically, and `workflow resume` leaves it to you.

| Deliverable | Produced when |
|---|---|
| none (kind or lane only) | a build-lane step other than `integration` changed a file or made a commit; other steps are not judged |
| `files` | a file changed (the `ownedFiles`, or any workspace file when there are none) or a commit was made; a `combine` step is not judged; a workspace git cannot see (not a repository, or a folder the repository ignores) is judged only on exact `ownedFiles` |
| `files`, `data` or `media` with `paths` | every path exists at the end, and at least one was written during the step; checked without git, so a git-ignored file counts in a shared workspace; an isolated run refuses a git-ignored deliverable path at validate |
| `report` | the step's final response is not empty |
| `outward` | not judged yet |

A step with `evidenceFor`, and a `digest`, are never judged. The rule for a step with no deliverable applies only to runs started by this version; saved runs keep their original rules when resumed. "During the step" covers every attempt of the step, so a retry, resume or rerun that finds its work already done is not failed. A rerun of a step that failed `not-produced` is judged again. In an isolated run, only work from a step that succeeded counts.

An `act` step works outside the workspace. It runs on lane `analyze`, its `ownedFiles` and `evidenceFor` are empty, and its deliverable is `outward`. Its task says not to modify workspace files and not to stage, commit, stash, check out or reset anything, and to list every action it took. It is never judged by files. It may list requirements in `affects`, but the kernel never repairs a requirement an act step affects: a failing one comes back to you. It is allowed in a read-only goal, because it does not change the workspace.

Use a `digest` when three or more writers feed one reader, or a reader's inputs would exceed about 20 KB. The reader depends on the digest, not the raw writers, and receives `digestOf` links to them. Evidence never depends on a digest.

## Requirement IDs

The kernel derives requirements from the goal text. Each numbered item, `1.` or `1)` at the start of a line or inline in one line counting from 1, becomes `requirement-N` in order. A goal with no numbered items is one `requirement-1`. Number distinct deliverables in the goal to get one verdict each, and use exactly the same goal text for validate and launch.

A requirement needs no writer: coverage by `evidenceFor` alone is accepted, and evidence itself is optional. `verified` on the [result envelope](/reference/result) is separate from every action succeeding.

## Enforced rules

Validate and launch apply the same rules. A kind outside the table, a lane outside `analyze|build|chore`, or an effort outside `high|medium|low` exits 2 before anything runs. So does a role outside the six, a role that disagrees with the kind, a deliverable a role does not take, a deliverable whose lane does not fit, or a data or media deliverable without paths, and `role` or `deliverable` in a run that is not program mode.

- A goal that starts with `read-only`, or says repository files must not be modified, forbids mutation: every `ownedFiles` must be `[]`.
- Kind `digest`, the kernel-written combine, needs at least one `dependsOn`, empty `evidenceFor`, empty `ownedFiles`, and no evidence action may list it in `dependsOn`. Only the direct dependency is checked; evidence may depend on an action that itself read a digest.
- An evidence action's prompt describes what to inspect only. A directive such as "return only JSON" is rejected; the kernel owns the evidence format.
- `ownedFiles` must name exact files, not a directory or a glob. Validate also refuses a pinned pool that cannot run a step.
- A deliverable path must be an exact file, not a directory. When `ownedFiles` is not empty, every deliverable path, `files` paths included, must be listed in it. An isolated run refuses a git-ignored deliverable path, because it copies back only files git would track.
- `timeBox` is a whole number of minutes from 0 to 240 and `verifyRounds` a whole number from 1 to 3; anything else, and any `repair` field, exits 2.

Exit 0 always carries `advisories`. `all-writers-high` and `docs-at-high` name an action whose effort is above what its work warrants. `requirement-unchecked` names a requirement no step lists in `evidenceFor`: the run can finish but never verify it.

## Example

Goal: `1. Add --since to runs list. 2. Document it in README.` Replace `<cwd>` in each prompt with the absolute workspace path; nothing is substituted at dispatch.

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
      "effort": "high",
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

```bash
# Dry-run the program against the same contract launch will enforce.
bullswarm workflow plan validate "1. Add --since to runs list. 2. Document it in README." --cwd . --program plan.json --json
```

## Next steps

- [Workflows](/guide/workflows) — how to author the graph this format describes
- [CLI reference](/reference/cli) — `workflow plan` and `workflow goal` flags
- [Result envelope](/reference/result) — what a finished run returns
