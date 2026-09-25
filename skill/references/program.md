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
| `defaults` | no | object with only `effort` (`high`, `medium`, `low`), `reasoning` (`low`, `medium`, `high`, `xhigh`, `max`, `default`), `timeBox` (whole minutes, 0-240) and `verifyRounds` (0-3); `effort`, `reasoning` and `timeBox` apply where neither the action nor its role or kind sets the field. `verifyRounds` counts fix-and-re-review cycles (default 1; 0 means review only). Saved runs keep their original 1-3 review-round limit |

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
| `route` | no | `{pools:{use,avoid}, providers:{use,avoid}, independentOf}` — where the step may run; a hard filter before pacing; program-mode runs only; lane stays its own field |
| `evidence` | no | up to 5 checks Bullswarm runs after the worker: `{type: "command", cmd, timeoutSec?}` or `{type: "schema", file, schema, format?, timeoutSec?}`; `$output` checks the step's final response; `format` is `json` or `jsonl`; refused on review and digest steps |
| `effort` | no | `high`, `medium`, `low`; overrides the role's or kind's effort |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, `default`; how hard the picked model thinks, outranks every configured level |
| `timeBox` | no | whole minutes, 0-240: the soft time box written into this step's task; `0` leaves it out. Omit it to take `defaults.timeBox`, else a box computed from this home's recorded attempts. A guide, never a timeout |
| `inputs`, `produces` | no | artifact IDs, kebab-case: the producer lists an ID in `produces`, its consumer in `inputs`; omit for ordinary dependencies. `produces` wires data between steps; it is not the deliverable |

## Failure and routing rules

| Failure | Automatic action | Then |
|---|---|---|
| `process` | `auth`, `provider`, `process`, `interrupted`, `stalled`: one retry on another eligible pool; the same pool if it is the only candidate (except `auth`) | You decide |
| `gate` | `not-produced`, `failed-evidence`, `schema`, `semantic`: one retry on the same pool with the failure attached | You decide |
| `wait` | `quota`: none. A usage limit (a spent 5-hour or weekly window, or no credit left) ends the step at once. `throttle`: at most two short backoffs on the same pool (20 s, then 60 s, or a named wait of at most 2 minutes), without spending the retry | You decide; the block shows `back at <time>` when the pool's return time is known |
| `caller` | `ownership`, `ownership-conflict`, `runtime`, `unavailable`, or any unknown kind: no automatic retry | You decide |
| `stop` | `cancelled`, `paused`, `restarted`, `superseded`: no failure retry | The caller controls what runs next |

Nothing waits for a pool. A limit notice is `quota` when it says a usage
window, a quota or a balance is spent, with or without a reset named and
whatever the pausing switch, or when the pool's meter shows the window full; a
`too many requests` notice is `throttle`. A throttle that names a wait longer
than 2 minutes, or whose pool is no longer free for its backoff, comes back to
you at once. When no pool that can run the step is free at its pick (nearly
spent, at its 5-hour limit, paused or benched), the step comes back to you as
`quota` when every reason is a usage limit, else as `unavailable`, and its
`why` names each pool and its reason.
The dispatched planner and the preflight scout follow the same rule: a
usage limit, a rate limit still there after its backoff, or no free pool
stops it and the run tells you, with no move to another pool.

An `act` step is never retried after its worker starts. A check that cannot run
also comes to you without a retry. A failed check in a new run gets one fix
step and one re-review; `defaults.verifyRounds` is 0–3 fix cycles, default 1.
Saved runs keep their original rules. One step gets one automatic retry in
total. Only its dependents wait; other steps keep running. Saved runs keep their
rules in `features.json`.

## Placing a step

Use `route` in program-mode runs to constrain which pools or providers may run a
step. `pools.use` and `providers.use` are allow-lists; `pools.avoid` and
`providers.avoid` are exclusions. `independentOf` names earlier steps whose
providers must not run this step, or uses `"writers"` on a step with
`evidenceFor` to exclude the providers of the work it reviews. A provider is
the model family; relay pools from one provider count as one. These are hard
filters before pacing. `route.lane` is not allowed: set the step's own `lane`.
If a route leaves no free pool, the step comes back to you at once: as no
eligible pool when no pool passes the route, else with each pool's reason. It
never waits for one.

For example, a check can use `route: { "independentOf": ["write-docs"] }`.

`independentOf` names an earlier dependency, so include that step in
`dependsOn` directly or through another step. Pool lists use configured pool
ids, not display labels. Pool/provider names cannot appear in both `use` and
`avoid`; `writers` is accepted only on a step with `evidenceFor`. A route that
names an unknown or later step is rejected. An empty route is dropped.

A repair step the kernel adds takes the routes of the steps it repairs: the
avoid lists together, and a `use` list only when every one of those steps has
one, as the names they share. When they share no name, the kernel refuses its
own repair (`program.revision_rejected`, `route cannot be inherited: …`) and
the loop stops at `revision` rather than widen the route; change one of those
routes or accept the requirement. Under a `--worker-pool` pin every step runs
on the pinned pool, so a route with `independentOf` is refused at validate,
launch and revise when a step it names did or will do its work on that pool's
provider.

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

Every work and review step's task ends with a time-box paragraph: the box in
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

When a mandatory requirement fails its check, the kernel adds one fix step
from the check's findings and one re-review. Both appear in `plan export`; never
author a repair step or your own retry loop for an ordinary failing check. What
still fails comes back to you in the needs-you block and `callerDecision`.
`defaults.verifyRounds` counts fix-and-re-review cycles (0-3, default 1); 0
means review only. Runs started before this version keep their original limit
of up to 3 review rounds.

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
produce it fails as `not-produced`. In runs started by this version that
failure gets one retry on the same pool in a fresh session with the failure
attached, then comes back to you; runs started earlier do not retry it.
`workflow resume` never reruns it: use `step rerun`, `step accept` or plan
revise.

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

## Evidence: command and schema

A program step may declare up to five checks in `evidence`. Bullswarm runs them
in order after the worker and after the `not-produced` gate passes. If the
worker fails first, no check runs: the step's handback line and watch's failed
line read `evidence not run`, and the result has `evidenceResults: null`.
Otherwise every item runs unless an earlier item changed the deliverable or the
run was stopped. A failed check gives `failed-evidence` and one retry on the
same pool with its output attached. After the retry, the step waits for you. A
failed check on an `act` step, or a check that cannot run, goes straight to you
without a retry. `workflow resume` does not retry `failed-evidence`.

`evidence` is refused on a review step (one with `evidenceFor`), on a `digest`
(the kernel writes its report), in a run that is not program mode, and from a
dispatched planner: only the caller declares checks. So a review step and a
digest take no `evidence`. Put the commands a reviewer must run in its prompt,
or add a separate `check` step with `evidence` and an empty `evidenceFor`.

| Type | Passes when | Fields |
|---|---|---|
| `command` | The one-line shell command exits 0 | `cmd`; optional `timeoutSec` |
| `schema` | The file matches the supported JSON Schema subset | `file`, `schema`; optional `format` (`json` or `jsonl`) and `timeoutSec` |

`timeoutSec` is an integer from 1 to 600, default 120. A top-level action
`timeoutSec` is refused. Schema files use the subset in this section: asserted
keywords `type`, `enum`, `const`, `properties`, `required`,
`additionalProperties`, `minProperties`, `maxProperties`, `items`, `minItems`,
`maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`,
`maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `allOf`,
`anyOf`, `oneOf`, `not`, and `$ref`. Ignored annotations and containers are
`$schema`, `$id`, `$comment`, `$defs`, `definitions`, `title`, `description`,
`default`, `examples`, `deprecated`, `readOnly`, `writeOnly` and `format`.
Local `#` references work, and every `$ref` target is checked as a schema.
`format` is not checked; unsupported keywords and non-local references are
refused, never skipped. `jsonl` checks each non-empty line; a JSONL file with
no records fails with `no records`, so a step that may produce nothing should
declare a JSON array. `file: "$output"` checks the step's saved final response;
one fenced JSON block is unwrapped. Run the checker by hand with `node
<package>/bin/check-schema.js <file> <schema>`; put `--` before a path that
starts with `-`.

Validate, launch and revise read each schema file. A refused keyword reads
`…schema uses unsupported keyword …`; any other problem reads `…schema is not a
supported schema ("P"): <reason>`. With `--isolation`, a git-ignored path is
refused, because the isolated copy will not contain it: `…schema is git-ignored
("P"); the isolated copy will not contain it, so the check could not run`, and,
for a `file` other than `$output`, `…file is git-ignored ("P"); the isolated
copy will not contain it, and an isolated run copies back only files git would
track`.

Each item ends with a `status` and a `why`:

- `passed`: the command exited 0, or the file matched the schema, and the
  deliverable did not change.
- `failed`: `exit <n>`; `timed out after <n>s`; `killed by <SIGNAL>` (a crash
  such as `SIGABRT`, never a kernel stop, pause or revision); `could not start:
  <message>`; the schema checker's reason, such as `not valid: 1 error`; or
  `changed the deliverable: <paths>`.
- `not-run`: `not run: an earlier item changed the deliverable`, or `stopped`
  when a pause, revision, cancel or kernel stop ended the checks. A kernel stop
  leaves the step `interrupted`, and `workflow resume` runs it again. An `act`
  step is the exception, because its worker may already have acted: when a
  kernel stop or crash, `pause --now`, `step restart` or `workflow cancel` ends
  its checks, it comes back to you as `failed-evidence`. `workflow resume` does
  not rerun it, a `step restart` during its checks is refused, and `plan revise
  --rerun` runs it again.

A schema item that cannot be checked is split by whose fault it is. A missing
or unparsable data file (`file missing: out/x.json`, `not JSON: …`) is the
worker's: the item fails and the step gets its same-pool retry. A missing,
unreadable or unsupported schema, or a file too large to check, is the check's:
the item records `fault: "check"`, the step's reason starts `check could not
run:`, and the step comes straight to you without a retry. Fix the check with
`plan revise`.

Checks receive `BULLSWARM_EVIDENCE=1`, `BULLSWARM_STEP_ID`,
`BULLSWARM_STEP_OUTPUT` (absolute path to this attempt's response), and
`BULLSWARM_RUN_DIR`. The kernel's depth limit also applies to commands. In an
isolated run, commands run in the isolated copy.

Checks must be read-only. Before the first item and after each one, Bullswarm
hashes the deliverable: the step's `ownedFiles`, declared deliverable paths and
saved response, plus every tracked file and HEAD in an isolated copy or for a
build or chore step with no `ownedFiles` (it runs alone). A change fails the
item with `changed the deliverable: …`, and the later items do not run.
Untracked by-products there are recorded as `touched` rather than failed;
declare a new file as a deliverable path when it must be protected. In an
isolated copy, after the last item, Bullswarm removes the files the checks
created and puts back untracked files they rewrote or deleted (up to 16 MB in
total), so none of them is merged back. One it cannot put back is named in an
attempt note, `check by-product not restored: <paths>`, and is left out of the
ownership check and the merge-back. Elsewhere HEAD is not compared: when it
moves while an item runs (another step may have committed), the item records
`headMoved: true` as a fact and does not fail.

Scope a command to its step. Put a whole-suite command on a step that runs
alone or last, and pass `--run` or `CI=1` yourself when a test runner watches
files. Run every check once by hand before launch and give it a generous
timeout: changing a wrong check amends the step and reruns its worker. A suite
that runs longer than 600 seconds cannot be one item: split it into several
items or keep it in the step's prompt. To prove finished work without rerunning
it, add a `check` step with its own `evidence`; it does not rerun the work. An
old kernel refuses `evidence`; pause, revise, then resume.

Each check's result is in the full `bullswarm workflow runs result <id> --json`
envelope (not `--summary`) under `actions[].evidenceResults`: `status`, `exit`,
`tail`, `why` and the log path. `bullswarm workflow action show <id> <step>`
shows the same for each attempt under `attempts[].evidenceResults`. Each item's
full output is in `evidence-<step>-attempt-<n>-<k>.log` in the run directory.

Each finished step in a new run carries a proof label. Passing checks label it
`proven by command` or `proven by schema`, and a review that passes every
requirement the step affects adds `review`. A step without evidence reads
`proven by review` once that review passes, `review pending` at the end of the
run while a review step still covers its requirements, and `finished ·
unproven` otherwise. A step that did not pass a check is not labelled proven.
Labels are derived, not saved: runs started before this version show labels
only on steps that declare evidence.

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
  empty `evidenceFor`, empty `ownedFiles`, and no review step may list it
  in `dependsOn`. Only the direct dependency is checked; a review step may depend on
  an action that itself read a digest.
- A requirement needs no writer: coverage by `evidenceFor` alone is accepted,
  and evidence itself is optional.
- A review step's prompt describes what to inspect only. A directive such
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
  number from 0 to 3; anything else, and any `repair` field or type, exits 2.

## Example

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
