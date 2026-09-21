---
title: Workflow program
description: The plan.json fields, kinds, requirement IDs, and rules that workflow plan validate and workflow goal --program enforce.
---

# Workflow program

After this page you can author a `plan.json` that `bullswarm workflow plan validate` accepts, and know which field, kind, or rule would make launch exit 2.

`plan.json` is the program `bullswarm workflow goal --program` executes. Validate it against the running kernel before launch. Exit 2 returns `issues` and a `next` block; fix the file yourself. Exit 0 returns the resolved program and an `advisories` array. How to decompose a goal into actions is in [Workflows](/guide/workflows).

```bash
# Print the live contract for this goal (requirements, rules, schema, example).
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
```

Fetch that contract only when an issue names an unknown field, kind, or `schemaVersion`, which can only happen after an upgrade this page has not followed.

## Program

No other top-level field is accepted.

| Field | Required | Value |
|---|---|---|
| `schemaVersion` | yes | exactly `bullswarm.workflow.program.v2` |
| `actions` | yes | non-empty array of actions |
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`), `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`), `timeBox` (whole minutes, 0–240) and `verifyRounds` (1–3); `effort`, `reasoning` and `timeBox` apply where neither the action nor its kind sets the field, and `verifyRounds` is the run's cap on verify rounds |

You may also wrap the same program in a planner-response envelope (`schemaVersion: "bullswarm.workflow.planner-response.v2"`, `kind: "program"`, `summary`, `program`). `workflow goal --program` and `plan validate` accept either shape. `--summary` names a bare program.

## Action

Any other field is rejected. Resolution per field: the action's own `lane` or `effort`, then the kind table, then `defaults`, then the lane's default (`analyze` → `medium`, `build` → `medium`, `chore` → `low`). Reasoning on the action outranks `defaults.reasoning`, then the run-wide `--worker-reasoning`, then strategy, then the connector default.

| Field | Required | Value |
|---|---|---|
| `id` | yes | kebab-case, unique in the program |
| `purpose` | yes | one line: what this action delivers |
| `dependsOn` | yes | ids of the actions whose outputs this one reads; `[]` if none |
| `affects` | yes | requirement IDs this action's work contributes to; an action with `ownedFiles` must list at least one |
| `ownedFiles` | yes | repo-relative paths this action may edit; `[]` on a build-lane action means no territory limit (the integrator); analyze-lane actions edit nothing |
| `prompt` | yes | the self-contained task text with the absolute workspace path written in (nothing is substituted); for a `digest`, one line of focus appended to the kernel-written task |
| `evidenceFor` | yes | requirement IDs this action judges; `[]` unless it is evidence |
| `kind` | kind or lane | one of the kinds below |
| `lane` | kind or lane | `analyze` (read-only), `build` (edits), `chore` (mechanical edits); only when there is no kind |
| `effort` | no | `high`, `medium`, `low`; overrides the kind's effort |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, `default`; how hard the picked model thinks |
| `timeBox` | no | whole minutes, 0–240: the soft time box written into this step's task; `0` leaves the paragraph out. Omit it to take `defaults.timeBox`, else the box computed from this home's recorded attempts |
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies |

::: warning
Never set `defaults.effort` to `high`. High belongs to `integration`, `architecture`, and `adversarial-acceptance`. A study that reads code and writes markdown is `implement`.
:::

## Time box

Every dispatched step's task (work, digest and evidence) ends with a time-box paragraph: the box in minutes, the start clock, a wrap-up point at 70% of the box, and an invitation to stop and write three sections, `## Done`, `## Not done` (one line per unfinished item, or `- none`) and `## Suggested next step`. It is a guide, not a limit. Hard timeouts, stall detection, cancellation and routing are unchanged, and nothing is stopped at the box. Planner turns and the scout get no paragraph. A digest carries one like any other step, and a `## Not done` section in a digest's output is a quotation of its sources, so a digest never counts as returned early.

The box for an attempt is the first of these that applies:

1. the action's `timeBox`, in minutes (`0` leaves the paragraph out for that action);
2. `defaults.timeBox`;
3. 1.5 × the median wall minutes of the succeeded attempts in this home for the same pool and kind, when that pair has at least 5, else for the kind alone when it has at least 5, else 20. It is rounded to a multiple of 5 and kept within 10–60. `opencode` attempts never feed it, because that pool runs a slow free model.

The box is resolved for each attempt, so a retry on another pool gets its own clock. A step whose report lists items under `## Not done` still succeeds. Its attempt records `returnedEarly` with the count and the items, the Step page reads `returned early · N not done` (and `box 20m · ran 34m` when the attempt ran past its box), `workflow watch` prints `◐ <step> returned early · N not done`, and the items are quoted to the verifiers that judge the requirements the step affects.

## Verify rounds

When a mandatory requirement fails its evidence step, the kernel does not wait for you. It runs a bounded repair loop of at most 3 verify rounds:

| Round | What it judges | What follows a failure |
|---|---|---|
| 1 | every declared requirement: those an evidence step names are judged; one no evidence step names is recorded as `not judged · no evidence step covers it` | a `repair-1` step: the failed requirements with the verifier's evidence, the not-done items and handoffs of the steps that affect them, and ownership of the union of those steps' `ownedFiles` |
| 2 (`verify-round-2`) | the failed requirements again, plus any passed requirement whose evidence names a file the repair changed; it also looks for regressions in the repaired files and the same defect elsewhere | a `repair-2` step that also fixes what round 2 discovered |
| 3 (`verify-round-3`) | final closure: only whether each open requirement now passes; it adds nothing new | none: the run ends |

`defaults.verifyRounds` sets the cap from 1 to 3 (default 3; `1` keeps today's single round). A requirement that passed carries forward and is not judged again unless a repair touched a file its evidence names. The run ends as soon as nothing is failing, as `completed · verified`, or after round 3 as `completed · not verified · verify rounds 3/3` with a `callerDecision` block on the [result envelope](/reference/result). There is never a fourth round.

A requirement no evidence step covers is never judged and never counts as passed. Round 1 records it as `not judged · no evidence step covers it`, it does not start a repair by itself (only a failed or blocked requirement does), and it appears in the `callerDecision` block of the [result](/reference/result) and in `runs result --summary` when the run ends. A mandatory one keeps the run from being `verified`; an optional one leaves the verdict to the mandatory requirements, and the block still names it. To have it judged, add an evidence step whose `evidenceFor` names it.

The `repair-<n>` and `verify-round-<n>` steps are ordinary program steps that the kernel adds, so they appear in `plan export`, cost and pages like any other step. You never write one, and a `repair` field or type is rejected. A plan revision during the loop is still accepted, but only the kernel counts rounds: a revision never adds, resets or refunds one, and deleting the kernel step in progress stops the loop. `defaults.verifyRounds` in a revision sets the cap for the rest of the run, never below the rounds already closed, and a revision that changes only the cap is accepted.

## Kinds

An analyze-lane action edits nothing; its deliverable is the report a dependent reads. Do not restate `lane` or `effort` on an action that has a `kind`.

| Kind | Lane | Effort | Use for |
|---|---|---|---|
| `mechanical` | chore | low | renames, formatting, generated edits |
| `io-read` | analyze | low | fetch or read something and report it |
| `digest` | analyze | low | condense dependency outputs verbatim; the kernel writes its task |
| `check` | analyze | medium | a read-only inspection with a report |
| `implement` | build | medium | ordinary edits and writing, including docs written from code study |
| `integration` | build | high | the sole writer after parallel writers; `ownedFiles: []` |
| `architecture` | analyze | high | a read-only cross-cutting judgment; its report feeds a later action |
| `adversarial-acceptance` | analyze | high | independent evidence; empty `affects` and `ownedFiles`, `evidenceFor` set |

Use a `digest` when three or more writers feed one reader, or a reader's inputs would exceed about 20 KB. The reader depends on the digest, not the raw writers, and receives `digestOf` links to them. Evidence never depends on a digest.

## Requirement IDs

The kernel derives requirements from the goal text. Each numbered item, `1.` or `1)` at the start of a line or inline in one line counting from 1, becomes `requirement-N` in order. A goal with no numbered items is one `requirement-1`. Number distinct deliverables in the goal to get one verdict each, and use exactly the same goal text for validate and launch.

A requirement needs no writer: coverage by `evidenceFor` alone is accepted, and evidence itself is optional. `verified` on the [result envelope](/reference/result) is separate from every action succeeding.

## Enforced rules

Validate and launch apply the same rules. A kind outside the table, a lane outside `analyze|build|chore`, or an effort outside `high|medium|low` exits 2 before anything runs.

- A goal that starts with `read-only`, or says repository files must not be modified, forbids mutation: every `ownedFiles` must be `[]`.
- A `digest` needs at least one `dependsOn`, empty `evidenceFor`, empty `ownedFiles`, and no evidence action may list it in `dependsOn`. Only the direct dependency is checked; evidence may depend on an action that itself read a digest.
- An evidence action's prompt describes what to inspect only. A directive such as "return only JSON" is rejected; the kernel owns the evidence format.
- `ownedFiles` must name exact files, not a directory or a glob. Validate also refuses a pinned pool that cannot run a step.
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

```bash
# Dry-run the program against the same contract launch will enforce.
bullswarm workflow plan validate "1. Add --since to runs list. 2. Document it in README." --cwd . --program plan.json --json
```

## Next steps

- [Workflows](/guide/workflows) — how to author the graph this format describes
- [CLI reference](/reference/cli) — `workflow plan` and `workflow goal` flags
- [Result envelope](/reference/result) — what a finished run returns
