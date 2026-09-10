# Workflow program format

`plan.json` is the program that `bullswarm workflow goal` executes. Before
launch, `bullswarm workflow plan validate` checks it against the running
kernel. Exit 2 returns `issues` and a `next` block; fix the issues yourself.
Exit 0 returns the resolved program and an `advisories` array. This file
ships with the kernel it describes; fetch the live contract only when an issue
names an unknown field, kind, or `schemaVersion`, which can only happen after
an upgrade this file has not followed:

```bash
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

## Program

| field | required | value |
|---|---|---|
| `schemaVersion` | yes | exactly `bullswarm.workflow.program.v2` |
| `actions` | yes | non-empty array of actions |
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`) and `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`); applies where neither the action nor its kind sets the field |

No other top-level field is accepted.

## Action

| field | required | value |
|---|---|---|
| `id` | yes | kebab-case, unique in the program |
| `purpose` | yes | one line: what this action delivers |
| `dependsOn` | yes | ids of the actions whose outputs this one reads; `[]` if none |
| `affects` | yes | requirement IDs this action's work contributes to; an action with `ownedFiles` must list at least one |
| `ownedFiles` | yes | repo-relative paths this action may edit; `[]` on a build-lane action means no territory limit (the integrator); analyze-lane actions edit nothing |
| `prompt` | yes | the self-contained task text with the absolute workspace path written in (nothing is substituted; `<cwd>` in the example is a placeholder); for a `digest`, one line of focus appended to the kernel-written task |
| `evidenceFor` | yes | requirement IDs this action judges; `[]` unless it is evidence |
| `kind` | kind or lane | one of the kinds below |
| `lane` | kind or lane | `analyze` (read-only), `build` (edits), `chore` (mechanical edits); only when there is no kind |
| `effort` | no | `high`, `medium`, `low`; overrides the kind's effort |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, `default`; how hard the picked model thinks, outranks every configured level |
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies |

Any other field is rejected. Resolution per field: the action's own `lane` or
`effort`, then the kind table, then `defaults`, then the lane's default.

## Kinds

| kind | lane | effort | use for |
|---|---|---|---|
| `mechanical` | chore | low | renames, formatting, generated edits |
| `io-read` | analyze | low | fetch or read something and report it |
| `digest` | analyze | low | condense dependency outputs verbatim; the kernel writes its task |
| `check` | analyze | medium | a read-only inspection with a report |
| `implement` | build | medium | ordinary edits and writing, including docs written from code study |
| `integration` | build | high | the sole writer after parallel writers; `ownedFiles: []` |
| `architecture` | analyze | high | a read-only cross-cutting judgment; its report feeds a later action |
| `adversarial-acceptance` | analyze | high | independent evidence; empty `affects` and `ownedFiles`, `evidenceFor` set |

An analyze-lane action edits nothing; its deliverable is the report a
dependent reads.

## Requirement IDs

The kernel derives requirements from the goal text. Each numbered item, `1.`
or `1)` at the start of a line or inline in one line counting from 1, becomes
`requirement-N` in order. A goal with no numbered items is one
`requirement-1`. Number distinct deliverables in the goal to get one verdict
each, and use exactly the same goal text for validate and launch.

## Enforced rules

- A goal that starts with `read-only`, or says repository files must not be
  modified, forbids mutation: every `ownedFiles` must be `[]`.
- A `digest` needs at least one `dependsOn`, empty `evidenceFor`, empty
  `ownedFiles`, and no evidence action may list it in `dependsOn`. Only the
  direct dependency is checked; evidence may depend on an action that itself
  read a digest.
- A requirement needs no writer: coverage by `evidenceFor` alone is accepted,
  and evidence itself is optional.
- An evidence action's prompt describes what to inspect only. A directive such
  as "return only JSON" is rejected; the kernel owns the evidence format.
- A kind outside the table, a lane outside `analyze|build|chore`, or an effort
  outside `high|medium|low` exits 2 before anything runs.

## Example

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
