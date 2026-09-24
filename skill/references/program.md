# Workflow program format

`plan.json` is the program that `bullswarm workflow goal` executes. Before
launch, `bullswarm workflow plan validate` checks it against the running
kernel. Exit 2 returns `issues` and a `next` block; fix the issues yourself.
Exit 0 returns the resolved program and an `advisories` array. This file
ships with the kernel it describes; fetch the live contract only when an issue
names an unknown field, role, kind, deliverable, or `schemaVersion`, which can
only happen after an upgrade this file has not followed:

```bash
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

## Program

| field | required | value |
|---|---|---|
| `schemaVersion` | yes | exactly `bullswarm.workflow.program.v2` |
| `actions` | yes | non-empty array of actions |
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`), `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`), `timeBox` (whole minutes, 0-240) and `verifyRounds` (1-3); `effort`, `reasoning` and `timeBox` apply where neither the action nor its role or kind sets the field. `verifyRounds` is the most verify rounds the kernel runs before handing the rest to you (default 3; 1 keeps a single round) |

No other top-level field is accepted.

## Action

| field | required | value |
|---|---|---|
| `id` | yes | kebab-case, unique in the program |
| `purpose` | yes | one line: what this action delivers |
| `dependsOn` | yes | ids of actions whose outputs this one reads or whose files/contracts a writer needs first; `[]` if none |
| `affects` | yes | requirement IDs this action's work contributes to; an action with `ownedFiles` must list at least one |
| `ownedFiles` | yes | repo-relative paths this action may edit; `[]` on a build-lane action means no territory limit (the integrator); analyze-lane actions edit nothing |
| `prompt` | yes | the self-contained task text with the absolute workspace path written in (nothing is substituted; `<cwd>` in the example is a placeholder); for a `digest`, one line of focus appended to the kernel-written task |
| `evidenceFor` | yes | requirement IDs this action judges; `[]` unless it is evidence |
| `role` | role, kind or lane | one of the roles below; program-mode runs only |
| `kind` | role, kind or lane | one of the kinds below; each belongs to one role and keeps its own routing and gate (table below) |
| `lane` | role, kind or lane | `analyze` (read-only), `build` (edits), `chore` (mechanical edits); only when there is no role or kind |
| `deliverable` | no | `files`, `report`, `data`, `media`, `outward`, or `{type, paths}`; data and media need `paths`; every path must be an exact file, not a directory, and be listed in `ownedFiles` when it is not empty (`files` paths too); an isolated run refuses a git-ignored path |
| `effort` | no | `high`, `medium`, `low`; overrides the role's or kind's effort |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, `default`; how hard the picked model thinks, outranks every configured level |
| `timeBox` | no | whole minutes, 0-240: the soft time box written into this step's task; `0` leaves it out. Omit it to take `defaults.timeBox`, else a box computed from this home's recorded attempts. A guide, never a timeout |
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies. `produces` wires data between steps; it is not the deliverable |

Any other field is rejected. Resolution per field: the action's own `lane` or
`effort`, then the kind table, else the role table, then `defaults`, then the
lane default.

`dependsOn` is an input dependency: list an action when a writer needs its
files or contract before it can compile or prove its change. It makes the
writer wait for that input; it does not represent a phase. Keep each behavior
and its focused test in one writer action, and have writers run the checks they
own. After integration, put the full browser/e2e gate, commit, and PR in
separate ordered steps, in that sequence. Give the browser/e2e step an explicit
`timeBox` sized for the full suite. Make the browser/e2e gate a `check` step,
and the commit and PR steps `kind: mechanical` (not judged, and with empty
ownedFiles they run alone). A step whose declared deliverable was not produced
fails as `not-produced`, and so does a build-lane step with no declared
deliverable that changes no file and makes no commit. An integrator is not
judged by files, so a clean integrator still passes. An `act` step is for
outward actions such as sending messages; it is never judged by files.

## Time box and verify rounds

Every work and evidence step's task ends with a time-box paragraph: the box in
minutes, the start clock, a wrap-up point at 70% of the box, and an invitation
to stop and report `## Done`, `## Not done` (one line per unfinished item) and
`## Suggested next step`. It is a guide: nothing is stopped at the box, and
timeouts, stall detection and routing are unchanged. Set `timeBox` on an action
when you know its size better than the history does, `defaults.timeBox` for the
whole program, or `timeBox: 0` to leave the paragraph out of one step. The
computed box is 1.5 x the median wall minutes of succeeded attempts for the
same pool and kind (or role, for a step with no kind) when there are 5 or
more attempts, else the kind or role alone, else 20; rounded to 5 and kept
within 10-60.

A step whose `## Not done` lists items still succeeds. It is recorded as
`returned early · N not done`, and the items go to the verifiers with the rest
of the evidence.

When a mandatory requirement fails its check, the kernel repairs it itself, at
most 3 verify rounds in all: it adds a `repair-<n>` step and a
`verify-round-<n>` step to the program, which you will see in `plan export`.
Never author a repair step, and do not add a fix step for an ordinary failing
check. `defaults.verifyRounds` (1-3, default 3) sets the cap. What is still
failing after the last round comes back in the result's caller-decision block.

## Roles and deliverables

A `role` says what a step does, and a `deliverable` says what it leaves
behind. Both are optional and work only in program-mode runs. In new programs,
give work steps a role and a deliverable. Use a kind for commit, formatter and
PR steps (`mechanical`), for `digest`, or when you want a kind's exact routing.

- `investigate`: find something out and report it.
- `produce`: make new work: code, documents, data or media.
- `transform`: reshape existing work.
- `combine`: merge or condense the work of earlier steps.
- `check`: judge work; the step that names requirements in `evidenceFor`.
- `act`: act outside the workspace: send, post, publish, deploy.

A role-only step takes its lane and effort from the role and its deliverable
(omit `deliverable` to take the default):

| role | default deliverable | files | data or media | report | outward |
|---|---|---|---|---|---|
| `investigate` | report | build/medium | build/medium | analyze/medium | — |
| `produce` | files | build/medium | build/medium | analyze/medium | — |
| `transform` | files | chore/low | chore/low | analyze/low | — |
| `combine` | (required) | build/high | build/medium | analyze/medium | — |
| `check` | report | — | — | analyze/medium | — |
| `act` | outward | — | — | — | analyze/medium |

A `combine` step must name its deliverable: `files` to merge written work,
`data` or `media` to merge data or assemble media, or `report` to condense or
compare results. A dash means the role does not take
that deliverable. `files`, `data` and `media` need lane `build` or `chore`;
`report` and `outward` need lane `analyze`, whatever set the lane. Do not
restate `lane` or `effort` on a step with a role or kind. When you change
`role` in an exported plan, delete the written-back `lane`, `effort` and
`deliverable` too, unless you mean to keep that deliverable. When you change
`deliverable`, delete `lane` and `effort`.

Each kind belongs to one role and keeps its own lane, effort and gate:

| kind | role | lane | effort | use for |
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

| kind | role | kind: lane/effort | role alone: lane/effort (default deliverable) | kind gate | role gate |
|---|---|---|---|---|---|
| `mechanical` | `transform` | chore/low | chore/low (files) | not judged | judged: a file change or a commit |
| `io-read` | `investigate` | analyze/low | analyze/medium (report) | not judged | report not empty |
| `architecture` | `investigate` | analyze/high | analyze/medium (report) | not judged | report not empty |
| `implement` | `produce` | build/medium | build/medium (files) | a file change or a commit | a file change or a commit |
| `integration` | `combine` | build/high | needs a deliverable | exempt | files: exempt; data/media: paths; report: not empty |
| `digest` | `combine` | analyze/low, kernel-written task | — | not judged | a role step never gets the digest task |
| `check` | `check` | analyze/medium | analyze/medium (report) | not judged | not judged with evidenceFor, else report not empty |
| `adversarial-acceptance` | `check` | analyze/high | analyze/medium (report) | not judged | same as check |

A step may give both a kind and a role only when the role is the kind's own;
then only the kind is stored. The kind gate for `implement` applies to runs
started by this version.

When a step ends, Bullswarm checks its deliverable. A step that did not
produce it fails as `not-produced`. That failure is not retried
automatically, and `workflow resume` leaves it to you.

| deliverable | produced when |
|---|---|
| none (kind or lane only) | a build-lane step other than `integration` changed a file or made a commit; other steps are not judged |
| `files` | a file changed (the `ownedFiles`, or any workspace file when there are none) or a commit was made; a `combine` step is not judged; a workspace git cannot see (not a repository, or a folder the repository ignores) is judged only on exact `ownedFiles` |
| `files`, `data` or `media` with `paths` | every path exists at the end, and at least one was written during the step; checked without git, so a git-ignored file counts in a shared workspace; an isolated run refuses a git-ignored deliverable path at validate |
| `report` | the step's final response is not empty |
| `outward` | not judged yet |

A step with `evidenceFor`, and a `digest`, are never judged. The rule for a
step with no deliverable applies only to runs started by this version; saved
runs keep their original rules when resumed. "During the step" covers every
attempt of the step, so a retry, resume or rerun that finds its work already
done is not failed. A rerun of a step that failed `not-produced` is judged
again. In an isolated run, only work from a step that succeeded counts.

An `act` step works outside the workspace. It runs on lane `analyze`, its
`ownedFiles` and `evidenceFor` are empty, and its deliverable is `outward`.
Its task says not to modify workspace files and not to stage, commit, stash,
check out or reset anything, and to list every action it took. It is never
judged by files. It may list requirements in `affects`, but the kernel never
repairs a requirement an act step affects: a failing one comes back to you.
It is allowed in a read-only goal, because it does not change the workspace.

## Requirement IDs

The kernel derives requirements from the goal text. Each numbered item, `1.`
or `1)` at the start of a line or inline in one line counting from 1, becomes
`requirement-N` in order. A goal with no numbered items is one
`requirement-1`. Number distinct deliverables in the goal to get one verdict
each, and use exactly the same goal text for validate and launch.

## Enforced rules

- A goal that starts with `read-only`, or says repository files must not be
  modified, forbids mutation: every `ownedFiles` must be `[]`.
- Kind `digest`, the kernel-written combine, needs at least one `dependsOn`,
  empty `evidenceFor`, empty `ownedFiles`, and no evidence action may list it
  in `dependsOn`. Only the direct dependency is checked; evidence may depend on
  an action that itself read a digest.
- A requirement needs no writer: coverage by `evidenceFor` alone is accepted,
  and evidence itself is optional.
- An evidence action's prompt describes what to inspect only. A directive such
  as "return only JSON" is rejected; the kernel owns the evidence format.
- A kind outside the table, a lane outside `analyze|build|chore`, or an effort
  outside `high|medium|low` exits 2 before anything runs.
- A role outside the six, a role that disagrees with the kind, a deliverable a
  role does not take, a deliverable whose lane does not fit, or a data or
  media deliverable without paths exits 2. So do `role` and `deliverable` in
  a run that is not program mode.
- A deliverable path must be an exact file, not a directory. When
  `ownedFiles` is not empty, every deliverable path, `files` paths included,
  must be listed in it. An isolated run refuses a git-ignored deliverable
  path, because it copies back only files git would track.
- `timeBox` must be a whole number from 0 to 240 and `verifyRounds` a whole
  number from 1 to 3; anything else, and any `repair` field or type, exits 2.

## Example

Goal: `1. Add --since to runs list. 2. Document it in README.`

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
