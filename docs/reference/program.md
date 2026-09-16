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
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`) and `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`); applies where neither the action nor its kind sets the field |

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
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies |

::: warning
Never set `defaults.effort` to `high`. High belongs to `integration`, `architecture`, and `adversarial-acceptance`. A study that reads code and writes markdown is `implement`.
:::

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
