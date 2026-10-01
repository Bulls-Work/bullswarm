# Workflow program format (v3)

`plan.json` is the program `bullswarm workflow goal --program` runs. New
programs are v3: steps, with phases as labels, and gates and loops. This page
lists every field. The kernel you run prints the same format, the rules it
keeps and an example that validates:

```bash
bullswarm workflow plan contract            # the goal is optional
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

Check a file before launch with `bullswarm workflow plan validate '<goal>'
--cwd=<abs-dir> --program=<abs-path>`. Exit 2 lists `issues` (fix them
yourself); exit 0 prints each step, gate and loop and the launch line. Old v2
programs (`bullswarm.workflow.program.v2`, with `actions`, roles, kinds and
requirement IDs) are refused since 0.38.0, before any run folder exists, and a
run an earlier Bullswarm started is view-only: it stays listed, shown and
counted, but nothing drives it again.

## Program

| field | required | value |
|---|---|---|
| `schemaVersion` | yes | exactly `bullswarm.workflow.program.v3` |
| `steps` | yes | a non-empty array of steps |
| `gates` | no | an array of gates |
| `loops` | no | an array of loops |
| `defaults` | no | `lane`, `effort`, `reasoning`, `retry`, `timeBox`; a step's own field outranks it |

Steps, gates and loops share one id space: an id is kebab-case and used once.

## Step

| field | required | value |
|---|---|---|
| `id` | yes | kebab-case, unique |
| `prompt` | yes | the self-contained task; nothing is substituted, so write the absolute workspace path in |
| `dependsOn` | no | step, gate or loop ids that must finish first (default `[]`); depend on a loop by its id, never on a step inside it |
| `phase` | no | one-line label that groups steps; the dashboard groups by it; it changes nothing else |
| `label` | no | one-line display name (default: the id) |
| `lane` | no | `analyze` (reads; the default), `build` (changes files), `chore` (mechanical changes) |
| `effort` | no | `high`, `medium`, `low`; default by lane: analyze medium, build medium, chore low; a chore step must be low |
| `reasoning` | no | `low`, `medium`, `high`, `xhigh`, `max`, or `default` (pass nothing); how hard the picked model thinks |
| `model` | no | an exact model id; the step runs on that model, only on pools that list it (see Routing) |
| `route` | no | `{pools: {use, avoid}, providers: {use, avoid}, independentOf: [step ids]}`: a hard filter applied before quota pacing |
| `blindTo` | no | step ids this step depends on (directly or through others) whose output file and checked answer it is not handed; see "Reviews" |
| `answer` | no | a JSON schema; see "Answers" |
| `evidence` | no | up to 5 checks Bullswarm runs after the worker; see "Evidence" |
| `deliverable` | no | `files`, `report`, `data`, `media`, `outward`, or `{type, paths}`; see "Deliverables" |
| `files` | no | exact relative paths the step may change (no directory, no glob); steps whose files overlap run one after the other |
| `retry` | no | `1` (default) or `0`: the one automatic retry after a failure |
| `timeBox` | no | whole minutes 0-240: the soft time box written into the task (0 leaves it out); a guide, never a timeout |

`purpose`, `affects`, `evidenceFor`, `kind`, `role`, `inputs`, `produces` and
`defaults.verifyRounds` belonged to v2 programs and are refused
(`steps[0].kind is not a v3 field`). A check is an ordinary step with an
`answer` and/or `evidence`.

## Gate

| field | required | value |
|---|---|---|
| `id` | yes | kebab-case; steps behind the gate list it in `dependsOn` |
| `dependsOn` | no | the steps, gates or loops the gate follows |
| `when` | no | a condition: the gate waits only when it holds, and passes by itself otherwise |
| `note` | no | one line printed when it waits: what to look at before you continue |

When its dependencies succeeded, a gate waits for `bullswarm workflow continue
<run> <gate>`. Only the steps behind it wait; other branches keep running.
When a dependency failed, the gate is blocked like any dependent, and the
failure's own needs-you block is your wake-up.

## Loop

| field | required | value |
|---|---|---|
| `id` | yes | kebab-case; later steps depend on the loop id |
| `steps` | yes | the step ids that repeat, in order through their own `dependsOn`; a step is in at most one loop; no loop inside a loop |
| `until` | yes | a condition on one of the loop's steps: true ends the loop |
| `maxRounds` | yes | 1-5 |

Each round reruns the same step ids; earlier rounds stay on record as
superseded attempts. The condition is read when every step of the round has
succeeded, so every step runs in every round: put the deciding step last, and
give every writer work each round (a build or chore step that changes no file
fails `not-produced`). From round 2 on, each step's task carries a `Previous
round` block with what the loop's steps answered and their evidence. When the
rounds run out, the loop waits like a gate: `workflow continue <run> <loop>
--rounds <1-5>` gives it more; without `--rounds` the steps behind it run, and
the loop is recorded as `continued-unmet` (condition not met), never passed.
A step in the loop that fails (after its retry) blocks the loop.

## The condition form

A gate's `when` and a loop's `until` take one of two forms:

- `{"step": "<id>", "field": "<name>", "equals": true}`: a boolean field that
  the step's object answer schema lists in `required`; `equals` is `true` (the
  default) or `false`.
- `{"step": "<id>", "evidence": "passed"}`: every evidence check of that step
  passed. Inside a loop, a failed check on the step `until` names does not
  fail the step: the attempt is recorded "checked, not passed" and the
  condition reads false.

A gate's condition step must run before the gate, and a loop's must be one of
its steps. There are no expressions and no else.

## Answers

A step with `answer` is told to write its final answer as JSON to a file
Bullswarm names (`answer-<step>-attempt-<n>.json`, next to its output),
at most 256 KiB. Bullswarm checks that file, not the worker's reply, against
the schema. The schema uses the same subset as a schema check (see Evidence);
an unsupported keyword is refused at validate (`steps[0].answer: unsupported
keyword "patternProperties" at #`). A mismatch is failure kind `schema`, and
the step's one retry runs on the same pool with the errors attached. The
checked answer is stored on the attempt and the step, handed to dependent
steps (their task names the answer file beside the dependency's output,
unless the dependent is `blindTo` that step), read
by conditions, and printed by `workflow wait`, `watch` and `runs result`. An
`analyze` step with an answer has no deliverable unless you declare one.

## Reviews

A review is an ordinary step with an `answer`. Write it strictly: state the
contract as numbered checks, say that any difference from the contract is a
finding even if it looks harmless, intended or justified by the author (you
decide, not the reviewer), and have it record each check as `holds` true or
false with its evidence. `passed` is true only when every check holds.

`blindTo` names upstream steps whose own account of their work the step must
not read: their output file and checked answer are left out of its task, and
out of a loop's `Previous round` block (which still says they ran, their
status and their evidence). The dependency still orders the step. Put it on a
review of a build step: a builder's answer can explain a deviation away with
a credible reason, and a reviewer that reads it tends to accept it, most of
all on a large change. It names steps like `route.independentOf` does (steps
this one depends on, directly or through others), and is separate from it:
`independentOf` is an opt-in that picks another provider and hides nothing. Leave `blindTo` off
a check that works from another step's list (find, then check each finding):
hiding that answer would hide what it checks.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    { "id": "build", "lane": "build", "files": ["src/csv-writer.js", "tests/csv-writer.test.js"],
      "prompt": "In /work/acme, add src/csv-writer.js: writeCsv(rows) returns RFC 4180 CSV text. Add its tests in tests/csv-writer.test.js." },
    { "id": "review", "dependsOn": ["build"], "blindTo": ["build"],
      "prompt": "In /work/acme, review src/csv-writer.js and tests/csv-writer.test.js against this contract: 1. src/csv-writer.js exports writeCsv(rows), which returns a string; 2. a field holding a comma, a quote or a line break is quoted, and a quote inside it is doubled; 3. every line ends with CRLF; 4. the tests cover checks 2 and 3. Any difference from the contract is a finding, even if it looks harmless, intended or justified by the author: the caller decides. Record each check as holds true or false, with the line that shows it as evidence. Answer passed true only when every check holds. Change no file.",
      "answer": { "type": "object", "required": ["checks", "passed"], "properties": {
        "checks": { "type": "array", "items": { "type": "object", "required": ["id", "holds", "evidence"], "properties": { "id": { "type": "string" }, "holds": { "type": "boolean" }, "evidence": { "type": "string" } } } },
        "passed": { "type": "boolean" } } } }
  ]
}
```

```text
validate:
✓ program v3 valid: 2 steps, 0 gates, 0 loops (nothing launched)
  build                    build/medium deliverable=files
  review                   analyze/medium answer after build blind to build
```

## Deliverables

What a step must leave behind. The default is `files` for build and chore
steps, `report` for an analyze step without an answer, and none for an analyze
step with one.

| type | lane | produced when |
|---|---|---|
| `files` | build, chore | a file changed, files git ignores included, or a commit was made (with `files`: one of those files changed, ignored or not) |
| `data`, `media` | build, chore | every path in `paths` exists and one of them was written; `paths` is required and must be listed in `files` |
| `report` | analyze | the final response is not empty |
| `outward` | analyze | nothing to check: the step acts outside the workspace (sending, publishing) and is never retried once its worker started |

A deliverable not produced is failure kind `not-produced`, and the step gets
its same-pool retry. Outside a git repository Bullswarm lists the folder itself
(up to 5,000 files and 64 MiB, `.git` and `node_modules` skipped) to see a
change; in a larger folder, name the files the step changes. Inside a git
repository, files git ignores (an `out/` in `.gitignore`) count too when
their bytes change, up to 20,000 of them. Tool caches and build output
(`__pycache__`, `.venv`, `dist`, `build`, `coverage`, `target`, `*.log`,
`*.tsbuildinfo`) do not count; name such a file in `files` when it is the
deliverable. With more ignored files than that, they are left out and the
check runs on the other files. No worker prompt names a commit as a way to
produce.

## Evidence: command and schema

A step may declare up to five checks in `evidence`. Bullswarm runs them in
order after the worker and after the deliverable check passes. If the worker
fails first, no check runs: the step's handback line and watch's failed line
read `evidence not run`, and the result has `evidenceResults: null`. A failed
check gives `failed-evidence` and the step's one retry on the same pool with
its output attached; then the step comes back to you. A check that cannot run
(a missing or unsupported schema) comes straight to you.

| Type | Passes when | Fields |
|---|---|---|
| `command` | the one-line shell command exits 0 | `cmd`; optional `timeoutSec` |
| `schema` | the file matches the supported JSON Schema subset | `file`, `schema`; optional `format` (`json` or `jsonl`) and `timeoutSec` |

`timeoutSec` is an integer from 1 to 600, default 120. Schema subset: asserted
keywords `type`, `enum`, `const`, `properties`, `required`,
`additionalProperties`, `minProperties`, `maxProperties`, `items`, `minItems`,
`maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`,
`maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `allOf`,
`anyOf`, `oneOf`, `not`, and `$ref`; ignored annotations `$schema`, `$id`,
`$comment`, `$defs`, `definitions`, `title`, `description`, `default`,
`examples`, `deprecated`, `readOnly`, `writeOnly` and `format`. Local `#`
references work; unsupported keywords and non-local references are refused.
`file: "$output"` checks the step's saved final response (one fenced JSON
block is unwrapped). Run the checker by hand with `node
<package>/bin/check-schema.js <file> <schema>`.

Checks receive `BULLSWARM_EVIDENCE=1`, `BULLSWARM_STEP_ID`,
`BULLSWARM_STEP_OUTPUT` (the attempt's response) and `BULLSWARM_RUN_DIR`.
Checks must be read-only: a check that changes the step's files fails with
`changed the deliverable: <paths>`, and untracked by-products are recorded as
`touched`. Scope a command to its step, put a whole-suite command on a step
that runs last, and pass `--run` or `CI=1` when a test runner watches files. A
step with `files` whose command names none of them (no path, glob or file-name
stem among its arguments, such as a bare `npm test`) gets the advisory
`suite-wider-than-files`: a failure elsewhere in the suite would fail a step
that cannot fix it. A
suite that runs longer than 600 seconds cannot be one item: split it into
several items, or have the step run it and answer with the result.

Each check's result is in `bullswarm workflow runs result <id> --json` under
`actions[].evidenceResults` (`status`, `exit`, `tail`, `why`), and per attempt
in `bullswarm workflow action show <id> <step>`. A finished step reads `proven
by command` or `proven by schema` when its checks passed, `answer checked`
when only its answer passed its schema (a well-formed claim, not proof: it is
not counted as proven), and `finished · unproven` when it has neither.

## Advisories

`plan validate` and `workflow goal` also report advisories: authoring advice
that never refuses a program, changes an exit code or changes dispatch
(`all-writers-high`, `docs-at-high`, `suite-wider-than-files`). In human mode
each prints once on stderr as `advisory: <code> [<step>] — <message>`. With `--json`
nothing is printed; the JSON carries them as `advisories: [{code, actionId,
message}]` (the detached launch JSON always, a foreground result when there
are any).

## Routing and independence

`lane` and `effort` choose the model tier; routing picks the pool with the most
quota to spare among the pools that can run it. A step that needs one exact
model names it in `model`: only pools whose model discovery (`strategy
refresh`) lists it stay eligible, quota still picks among them, and no other
model is substituted. Validate refuses a model no enabled pool can run, and a
step whose model has no free pool at its pick comes back to you. Use it only
when the step needs that model; `effort` and `reasoning` cover the usual case
and leave routing more pools to pace across. `route` narrows that first:
`pools.use`/`pools.avoid` name pool ids, `providers.use`/`providers.avoid` name
providers (claude-code, codex, grok, …), and `independentOf` names steps this
step depends on (directly or through others) whose providers it must not use.
A route that leaves no free pool sends the step back to you at once.

`independentOf` is an opt-in, not the default for a review: add it only for your
own reason (you want a different model family's view, the owner asked for it, a
compliance rule). It keeps the step off the providers that did the named work,
but another provider may still serve the same model, so name `providers` or
`pools` when the model family matters. Without it, Bullswarm places the review
by quota like any step, and `blindTo` plus numbered checks is what makes it hold. With a single
provider enabled, an `independentOf` route cannot be served, and validate and
`workflow add` refuse it.

## The failure rule

One automatic retry per step (`retry: 1`): a process failure (`auth`,
`provider`, `process`, `interrupted`, `stalled`) moves to another eligible pool
when there is one; a failed check (`not-produced`, `failed-evidence`,
`schema`) retries on the same pool with the failure attached. Then the step
comes back to you. A failed check whose report lists a `## Not done` item that
starts with `outside:` (`- outside: tests/router.test.js fails on main before
this change`: a blocker the step may not change) skips that retry and comes
back at once, its `why` ending `retry skipped: the worker reported a blocker
outside this step: <item>`. `model-not-in-plan` (the provider said the pool's
plan does not include the model) is a process failure whose retry never goes
back to that pool; the pool is not given that model again (`strategy show`
lists it under `not in plan:`) until `strategy include-model <model>`, a
changed `strategy set-subscription`, or turning the model back on for that
pool. A usage limit (`quota`) comes back at once; a rate limit
(`throttle`) backs off at most twice on the same pool first. A `--timeout`
kill of `bullswarm run` reads `interrupted`. Only the failed step's dependents
wait; other branches finish.

## Writing a program

Rules the fields above do not show on their own:

- **A step passes by facts.** Its worker ended cleanly, its deliverable was
  produced, its evidence passed, and its answer (when declared) matched the
  schema. Declare an `answer` whenever you, a later step or a condition needs
  data from the step; a dependent step is handed its dependencies' checked
  answer files.
- **One condition, no expressions and no else.** Anything more is your call,
  with `workflow wait` and `workflow add`.
- **Loops run every step in every round**, and read their condition when the
  round is over. Put the deciding step last, and give every writer in the loop
  work each round (rewrite the draft from the critique; do not put a revise
  step after a critique that may pass the first time). When a loop's `until`
  is the evidence form (`{"step": "check", "evidence": "passed"}`), a failed
  check on that step reads as "not passed" and the loop goes on. With the
  field form, a failed check fails the step as it would outside a loop.
- **A critique asks only for what the sources can show.** A claim that
  something is missing cannot cite a line, so a critique that demands one
  never passes. Cap `maxRounds` at 2 unless a round is cheap, and decide up
  front what you do when it runs out (continuing it is recorded as unmet).
- **Gates stop only what is behind them.** Other branches keep running. When
  only waiting gates or loops are left, the run parks with status `waiting`.
- **Opting into `independentOf` needs a second provider.** With only one
  enabled, validate and `workflow add` refuse `independentOf` (`… enable a pool of
  another provider or drop independentOf`). The other provider needs a model
  on the step's tier: a no-pool refusal names each pool's reason. A review of
  a build step also takes `"blindTo": ["build"]` and numbered checks (see
  "Reviews", and patterns.md 3).
- **Shared folder.** All workers share one tree. Name each writer's exact
  files in `files` (steps whose files overlap run one after the other) and
  tell it to keep other workers' edits.
- **Evidence: checks Bullswarm runs.** Add a command or schema check for
  anything a machine can check (`"evidence": [{"type": "command", "cmd": "npm
  test", "timeoutSec": 300}]`, at most 5 items). Try the checks before
  launch with `bullswarm workflow plan validate … --try-checks` when they are
  safe to run now (it runs each command check once in the workspace and
  prints a `try` line; a check that reads `$output` is not tried), because
  fixing a wrong check reruns the worker.
- **Steps that must not repeat.** Sending or publishing is `"deliverable":
  "outward"` with `"retry": 0`; an outward step is never retried once its
  worker started.
- **Prompts are self-contained.** Nothing is substituted: name the absolute
  workspace path, the outcome, the files, what to read from dependencies, and
  the checks to run. Every task carries a soft time box (`timeBox` minutes, a
  guide, never a timeout); a step that lists items under `## Not done` still
  succeeds and reads `returned early · N not done`. A failed step whose report
  lists `- outside: <blocker>` (something it may not change) skips its retry
  (see "The failure rule").

## Enforced rules

`plan validate`, `workflow goal` and `workflow add` refuse, with these
messages:

- a v2 field: `steps[0].kind is not a v3 field`; a derived one:
  `steps[0].purpose is derived from label or id in v3; remove it`
- an id used twice: `id "a" is used twice; steps, gates and loops share one id
  space`
- a dependency into a loop: `b depends on a inside loop l; depend on the loop l
  instead`
- a condition field that is not a required boolean: `gates[0].when.field "n"
  must be a boolean in the answer schema of step a`, `… must be listed in the
  required fields of step a's answer schema`
- a condition on a later step: `gates[0].when.step must run before gate g; a is
  not one of its dependencies`
- `loops[0].maxRounds must be a whole number from 1 to 5`,
  `steps[0].retry must be 0 or 1`
- an independence the graph cannot give: `steps[1].route.independentOf names
  "a", which does not run before this step; add it to dependsOn (directly or
  through another step)`; the same for `blindTo`: `steps[1].blindTo
  names "a", which does not run before this step; …`, `steps[1].blindTo
  cannot name the step itself`, `steps[1].blindTo must be an array of step ids`
- a directory or glob in `files`: `steps[0].files[0] must name one exact file,
  not a directory or glob ("src/")`
- lane mismatches: `steps[0] analyze actions must not own workspace files; use
  build or chore for mutations`, `steps[0] a outward deliverable is for
  analyze steps; build and chore steps deliver files, data or media`,
  `steps[0] chore actions are deterministic mechanical work and must use low
  effort`
- `steps[0].deliverable.paths is required for data`,
  `steps[0].deliverable.paths must be listed in files (missing: b.md)`
