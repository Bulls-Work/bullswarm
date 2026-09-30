# Workflow patterns

Five workflows to copy, each written from the four blocks (steps, phases,
gates, loops). Every program below passes `bullswarm workflow plan validate`
exactly as printed here; each `validate:` block is the command's real output
without its last line (the launch command). A fragment passed to `workflow
add` follows the program it extends; the two were validated together as one
program. Replace `/work/acme` with
your absolute workspace path, and write your own prompts.

Caller turns are estimates, not measurements.

Check first whether you need a workflow at all. When one worker can hold the
whole input and make one deliverable (a file of 40 tickets, a research brief,
one feature), one `bullswarm run` with `--answer-schema` is faster, takes
fewer turns, and keeps judgement across items that chunks lose. Use these
patterns for parallel territories, integration, an independent check, or a
gate or loop you need.

## 1. Find, then check each finding

Use it for an audit or a review: one broad search, then one independent check
per finding. The checks depend on what `find` answers, so you add them after
it. About 3-4 caller turns.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    {
      "id": "find",
      "prompt": "In /work/acme, read src/ and README.md (README.md says what each module must do). List every candidate bug. Give each a kebab-case id such as f1. Change no file.",
      "answer": {
        "type": "object", "required": ["findings"],
        "properties": { "findings": { "type": "array", "items": {
          "type": "object", "required": ["id", "file", "claim"],
          "properties": { "id": { "type": "string" }, "file": { "type": "string" }, "claim": { "type": "string" } }
        } } }
      }
    }
  ]
}
```

```text
validate:
✓ program v3 valid: 1 step, 0 gates, 0 loops (nothing launched)
  find                     analyze/medium answer
```

1. Launch, then `bullswarm workflow wait <run> find`: it prints the findings.
2. Write one check per finding into `checks.json` and add them. Each check
   depends on `find` and runs on another provider than `find` did:

```json
{
  "steps": [
    {
      "id": "check-f1", "dependsOn": ["find"], "route": { "independentOf": ["find"] },
      "prompt": "In /work/acme, try to reproduce this claimed bug with a concrete input: src/parse.js drops the last field of a quoted line. Change no file.",
      "answer": { "type": "object", "required": ["confirmed", "repro"], "properties": { "confirmed": { "type": "boolean" }, "repro": { "type": "string" } } }
    },
    {
      "id": "check-f2", "dependsOn": ["find"], "route": { "independentOf": ["find"] },
      "prompt": "In /work/acme, try to reproduce this claimed bug with a concrete input: src/sum.js counts an empty line as zero. Change no file.",
      "answer": { "type": "object", "required": ["confirmed", "repro"], "properties": { "confirmed": { "type": "boolean" }, "repro": { "type": "string" } } }
    }
  ]
}
```

```text
validate (find and the checks as one program):
✓ program v3 valid: 3 steps, 0 gates, 0 loops (nothing launched)
  find                     analyze/medium answer
  check-f1                 analyze/medium answer after find route: independent of find
  check-f2                 analyze/medium answer after find route: independent of find
```

3. `bullswarm workflow add <run> --steps checks.json`, then `bullswarm
   workflow wait <run> check-f1 check-f2`, and report the confirmed ones.

The checks are not blind to `find` (no `blindTo`): a check works from what
`find` listed, so hiding `find`'s answer would hide the list it checks.

`independentOf` needs a second provider. With one provider enabled, `workflow
add` refuses the fragment and changes nothing (real output):

```text
✗ nothing added to jcefns (run unchanged)
  - step check-first: its route is independent of find, whose work ran on provider grok, and every enabled pool that could run it (analyze/medium work) uses that provider; enable a pool of another provider or drop independentOf
```

## 2. Fix until a check passes

Use it when a machine can say "done": tests, a linter, a build. Submit once
and wait on the loop. About 2 caller turns.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    {
      "id": "fix", "lane": "build",
      "prompt": "In /work/acme, `npm test` fails. Find the cause in src/ and fix it; keep the tests as they are. From round 2 on, the Previous round block lists what the last check saw: fix that."
    },
    {
      "id": "check", "dependsOn": ["fix"],
      "prompt": "In /work/acme, run `npm test` and list every failing test with its first error line. Change no file.",
      "answer": { "type": "object", "required": ["problems"], "properties": { "problems": { "type": "array", "items": { "type": "string" } } } },
      "evidence": [{ "type": "command", "cmd": "npm test", "timeoutSec": 300 }]
    }
  ],
  "loops": [
    { "id": "until-green", "steps": ["fix", "check"], "until": { "step": "check", "evidence": "passed" }, "maxRounds": 3 }
  ]
}
```

```text
validate:
✓ program v3 valid: 2 steps, 0 gates, 1 loop (nothing launched)
  fix                      build/medium deliverable=files
  check                    analyze/medium evidence=command answer after fix
  loop until-green         steps fix, check · until check's evidence passed · at most 3 rounds
```

`fix` runs first in every round, so start the loop only when the check fails
now: a `fix` that has nothing to change fails `not-produced` and blocks the
loop. Inside the loop, a failed `npm test` does not fail `check`; it makes the
condition false and starts the next round, whose `fix` sees the failures. After
3 rounds the loop waits for you: `bullswarm workflow continue <run>
until-green --rounds 2`, or take over.

## 3. Draft, critique, approve, publish

Use it for anything written for others: research in parallel, rewrite the
draft until an independent critique passes, stop for your approval, then
publish once. Submit once; you are woken at `approve`. About 2-3 caller turns.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "defaults": { "lane": "analyze", "effort": "medium" },
  "steps": [
    { "id": "search-a", "phase": "research", "prompt": "In /work/acme, collect the claims sources/a.md makes about acme widgets.",
      "answer": { "type": "object", "required": ["claims"], "properties": { "claims": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "search-b", "phase": "research", "prompt": "In /work/acme, collect the claims sources/b.md makes about acme widgets.",
      "answer": { "type": "object", "required": ["claims"], "properties": { "claims": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "draft", "phase": "writing", "dependsOn": ["search-a", "search-b"], "lane": "build", "files": ["brief.md"],
      "prompt": "In /work/acme, write brief.md from the claims your dependencies answered. From round 2 on, fix the problems the previous critique listed." },
    { "id": "critique", "phase": "writing", "dependsOn": ["draft"], "route": { "independentOf": ["draft"] }, "blindTo": ["draft"],
      "prompt": "In /work/acme, check brief.md against this contract: 1. every claim in brief.md is stated by a line of sources/; 2. no claim in brief.md contradicts a line of sources/; 3. every number and date in brief.md is as sources/ gives it. Any difference from the contract is a problem, even if it looks harmless, intended or justified by the author: the caller decides. List only problems a line of sources/ shows (quote it); a claim that something is missing from sources/ is not a problem. Record each check as holds true or false with its evidence. Answer passed true when you list none. passed is true only when every check holds.",
      "answer": { "type": "object", "required": ["checks", "passed", "problems"], "properties": {
        "checks": { "type": "array", "items": { "type": "object", "required": ["id", "holds", "evidence"], "properties": { "id": { "type": "string" }, "holds": { "type": "boolean" }, "evidence": { "type": "string" } } } },
        "passed": { "type": "boolean" }, "problems": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "post", "phase": "publish", "dependsOn": ["approve"], "deliverable": "outward", "retry": 0,
      "prompt": "Publish /work/acme/brief.md to the acme wiki, and list the page you created." }
  ],
  "loops": [{ "id": "polish", "steps": ["draft", "critique"], "until": { "step": "critique", "field": "passed" }, "maxRounds": 2 }],
  "gates": [{ "id": "approve", "dependsOn": ["polish"], "note": "Read brief.md and decide whether to publish it" }]
}
```

```text
validate:
✓ program v3 valid: 5 steps, 1 gate, 1 loop (nothing launched)
  search-a                 analyze/medium answer
  search-b                 analyze/medium answer
  draft                    build/medium deliverable=files after search-a, search-b
  critique                 analyze/medium answer after draft route: independent of draft blind to draft
  post                     analyze/medium deliverable=outward after approve
  gate approve             after polish · waits for you · Read brief.md and decide whether to publish it
  loop polish              steps draft, critique · until critique.passed is true · at most 2 rounds
```

The writer comes first in the loop on purpose: the loop reads `critique.passed`
only after every step of the round. A `revise` step after the critique would
have nothing to change when the first critique passes, and fail. `post` has
`retry: 0` and an `outward` deliverable, so it never runs twice. Read
`brief.md` when the watch wakes you at `approve`, then `bullswarm workflow
continue <run> approve`, or cancel the run.

The critique is strict on purpose. It states its contract as numbered checks,
counts every difference as a problem even when the writer had a reason, and
records each check with its evidence, so passing means every check held.
`blindTo: ["draft"]` keeps the draft step's own answer and report out of the
critique's task (and out of its Previous round block): it judges `brief.md`
itself, and a convincing reason in the writer's report cannot talk it out of a
problem. That matters most on a large change. `route.independentOf` is a
separate choice: it picks another provider, and hides nothing.

The critique asks only for what the sources can show: a critique that wants a
citation for "the sources do not say X" can never pass. Two rounds are
enough when each is a full rewrite and review. Decide before launch what you
do if `polish` runs out of rounds: take over the last draft, or `bullswarm
workflow continue <run> polish`, which the run records as `continued-unmet`
(`→ loop polish continued by the caller after 2 of 2 rounds (condition not
met)`), never as passed.

## 4. Parallel slices, then a check

Use it for a change too large for one worker: a planning step answers the
slices, you add one build step per slice and a check, and the slices run in
parallel. About 4-5 caller turns.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    {
      "id": "plan", "effort": "high",
      "prompt": "In /work/acme, plan how to add CSV export. Split the work into slices that touch different files. Change no file.",
      "answer": {
        "type": "object", "required": ["slices"],
        "properties": { "slices": { "type": "array", "items": {
          "type": "object", "required": ["id", "files", "task"],
          "properties": { "id": { "type": "string" }, "files": { "type": "array", "items": { "type": "string" } }, "task": { "type": "string" } }
        } } }
      }
    }
  ],
  "gates": [
    { "id": "pick-slices", "dependsOn": ["plan"], "note": "Read the slices, add one build step per slice and a check, then continue" }
  ]
}
```

```text
validate:
✓ program v3 valid: 1 step, 1 gate, 0 loops (nothing launched)
  plan                     analyze/high answer
  gate pick-slices         after plan · waits for you · Read the slices, add one build step per slice and a check, then continue
```

When the watch wakes you at `pick-slices`, read the slices with `bullswarm
workflow wait <run> plan`, add the steps, then `bullswarm workflow continue
<run> pick-slices`:

```json
{
  "steps": [
    { "id": "slice-writer", "phase": "build", "dependsOn": ["pick-slices"], "lane": "build", "files": ["src/csv-writer.js", "tests/csv-writer.test.js"],
      "prompt": "In /work/acme, add src/csv-writer.js (rows to CSV text, RFC 4180 quoting) with its tests in tests/csv-writer.test.js. Other workers edit other files at the same time: keep their edits." },
    { "id": "slice-command", "phase": "build", "dependsOn": ["pick-slices"], "lane": "build", "files": ["src/cli.js", "tests/cli.test.js"],
      "prompt": "In /work/acme, add an `export --csv <file>` command to src/cli.js that calls writeCsv from src/csv-writer.js, with tests in tests/cli.test.js. Other workers edit other files at the same time: keep their edits." },
    { "id": "check", "phase": "check", "dependsOn": ["slice-writer", "slice-command"], "retry": 0,
      "prompt": "In /work/acme, run `npm test` and report every failing test with its first error line. Change no file.",
      "evidence": [{ "type": "command", "cmd": "npm test", "timeoutSec": 300 }] }
  ]
}
```

```text
validate (plan and the added steps as one program):
✓ program v3 valid: 4 steps, 1 gate, 0 loops (nothing launched)
  plan                     analyze/high answer
  slice-writer             build/medium deliverable=files after pick-slices
  slice-command            build/medium deliverable=files after pick-slices
  check                    analyze/medium deliverable=report evidence=command after slice-writer, slice-command
  gate pick-slices         after plan · waits for you · Read the slices, add one build step per slice and a check, then continue
```

When `check` passes, you are done. When it fails, it comes back to you at once
(`retry: 0`: rerunning the same tests would say the same). Add a fix loop
(pattern 2) whose steps depend on the slices, not on the failed check, since a
failed step blocks what depends on it.

## 5. A non-code task: triage tickets

Most triage is one `bullswarm run`: one worker reads every ticket and answers
with the whole table, checked against your schema. Priority is a comparison
across tickets, so keep them in one worker; split into chunks only when one
worker cannot hold them all (a 40-ticket triage split four ways scored 31-32
of 40 on priority, one run 34 of 40, in fewer turns). About 1-2 caller turns:

```bash
bullswarm run --lane=analyze --add-dir=/work/support --task-file=/work/support/task.md --answer-schema=/work/support/triage.schema.json --json
```

Use a workflow only when you want to rule on the uncertain tickets before the
report is written: one step classifies every ticket, a gate stops for you only
when that step found one it could not label. Submit once. About 1-3 caller
turns.

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    { "id": "classify", "prompt": "Read every ticket in /work/support/tickets.jsonl. Label each bug, question, feature or unsure, and list the unsure ones.",
      "answer": { "type": "object", "required": ["labels", "uncertain", "hasUncertain"], "properties": {
        "labels": { "type": "array", "items": { "type": "object", "required": ["ticket", "label"], "properties": { "ticket": { "type": "integer" }, "label": { "enum": ["bug", "question", "feature", "unsure"] } } } },
        "uncertain": { "type": "array", "items": { "type": "integer" } }, "hasUncertain": { "type": "boolean" } } } },
    { "id": "report", "dependsOn": ["rule"], "lane": "build", "files": ["triage.md"],
      "prompt": "In /work/support, write triage.md: one table of every ticket and its label, using the classify answer and any rulings in tickets-ruled.json." }
  ],
  "gates": [
    { "id": "rule", "dependsOn": ["classify"], "when": { "step": "classify", "field": "hasUncertain" }, "note": "Rule on the uncertain tickets in tickets-ruled.json, then continue" }
  ]
}
```

```text
validate:
✓ program v3 valid: 2 steps, 1 gate, 0 loops (nothing launched)
  classify                 analyze/medium answer
  report                   build/medium deliverable=files after rule
  gate rule                after classify · waits when classify.hasUncertain is true · Rule on the uncertain tickets in tickets-ruled.json, then continue
```

When `classify.hasUncertain` is false, the gate `rule` passes by itself and
the report is written without you.

## Other shapes

- **Everything up front, no gates:** a fully unattended run. Watch with
  `--until trouble`; you are woken only by a failure or the end.
- **One step at a time:** a program of one step, then `workflow wait` and
  `workflow add` for each next step.
- **A planner step:** a step whose `answer` is itself a fragment `{steps,
  gates?, loops?}`; read it with `workflow wait`, then add it with `bullswarm
  workflow add <run> --from-answer <step>`.
- **A past run's shape:** keep the program file you launched it with. Check
  it again with `bullswarm workflow plan validate` and launch it as a new run;
  to grow the same run instead, `workflow add` appends steps, and `workflow
  step rerun` runs a finished step again. (`plan export` and `plan revise`
  were removed in 0.38.0 and exit 2.)
