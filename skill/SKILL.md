---
name: bullswarm
description: Load before you hand work to another coding agent through the Bullswarm CLI, as one quota-routed task (bullswarm run) or a workflow you write from steps, phases, gates and loops (bullswarm workflow goal --program), and whenever you watch, answer, extend or recover such a run. Use for /bullswarm, offloading, independent checks or reviews, and requested multi-agent execution; not for work you are asked to do yourself.
---

# Bullswarm

You write the task. Bullswarm picks a worker by quota and capability, runs it,
judges it by facts (never by the worker's own report), and records it.

One model covers everything: a **step** is one agent task. `bullswarm run` is
a workflow with one step. A **workflow** composes steps with **phases**,
**gates** and **loops**, and you choose how closely to watch it.

Keep the user's scope and working directory. Delegate only authorized work;
permission to delegate does not authorize messages, releases, or other external
writes. If `BULLSWARM_DEPTH` is set you are already a worker: do the assigned
work directly unless it explicitly requires nested delegation.

## 1. Choose the shape

Decide first, from the request itself (there is no classifier command):

- **One worker can hold the whole input and make one deliverable** (triage a
  file of 40 tickets, a research brief, one feature, a review): `bullswarm
  run`, with `--answer-schema` when you need a checkable answer. Do not split
  an input into chunks unless one worker cannot hold it: chunks lose
  judgement across items (a 40-ticket triage split four ways scored 31-32/40
  on priority; one run scored 34/40, in fewer turns and less time).
- **A workflow** (`bullswarm workflow goal --program`) only for parallel
  territories, integrating several parts, a check by another agent, or a gate
  or loop you need.

## 2. One step: `bullswarm run`

```bash
bullswarm run --lane=analyze --add-dir=<abs-dir> --prompt='<task>' --json
```

Lanes: `analyze` reads, `build` changes files, `chore` makes mechanical
changes. Use `--task-file` for long text. Options you will use:

- `--answer-schema <file>`: a JSON schema. The worker writes its answer as JSON
  to a file Bullswarm names, and the verdict carries the checked `answer` (a
  mismatch is failure kind `schema`).
- `--no-retry`: one attempt. Without it the step gets its one automatic retry.
- `--avoid-pool`, `--use-provider`, `--avoid-provider`, `--model`: routing.
  `strategy set-free never --yes` stops free models being picked.
- `--timeout <seconds>`: kill the worker after that long (`timeout after
  <N>s`, failure kind `interrupted`; the retry still runs).

Read the verdict. `ok: true` means read `outFile` (and `answer`) and check the
content before you use it. `ok: false` means inspect and report the failure;
`failureKind` names it and `why` says it in one line. `pool` and `model` name
who ran it; `shortId` names the run; the last field, `details`, is the command
for its record and cost. A build or chore run that changes no file (files git
ignores count) fails `not-produced`, also outside git. Do not run `doctor`
unless dispatch reports a readiness problem.

## 3. A workflow: write, validate, launch, watch

| Block | What it is | Declared as |
|---|---|---|
| Step | one agent task | an entry in `steps`: `{id, prompt, dependsOn, …}` |
| Phase | a label that groups steps; the dashboard groups by it | `phase` on each step |
| Gate | the run stops there and waits for you, or only when an answer says so | an entry in `gates`: `{id, dependsOn, when?, note?}` |
| Loop | steps that repeat until one step's answer (or evidence) says stop, at most `maxRounds` (1-5) | an entry in `loops`: `{id, steps, until, maxRounds}` |

A build, then a strict review that does not read the builder's own account
(playbook rule 6):

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    { "id": "build", "lane": "build", "files": ["src/csv-writer.js", "tests/csv-writer.test.js"],
      "prompt": "In /work/acme, add src/csv-writer.js: writeCsv(rows) returns RFC 4180 CSV text. Add its tests in tests/csv-writer.test.js.",
      "evidence": [{ "type": "command", "cmd": "node --test tests/csv-writer.test.js", "timeoutSec": 300 }] },
    { "id": "review", "dependsOn": ["build"], "blindTo": ["build"],
      "prompt": "In /work/acme, review src/csv-writer.js against: 1. a field holding a comma, a quote or a line break is quoted, and a quote inside it is doubled; 2. every line ends with CRLF. Any difference is a finding, even if justified by the author. Record each check as holds true or false with its evidence. Answer passed true only when every check holds. Change no file.",
      "answer": { "type": "object", "required": ["checks", "passed"], "properties": {
        "checks": { "type": "array", "items": { "type": "object", "required": ["id", "holds", "evidence"], "properties": { "id": { "type": "string" }, "holds": { "type": "boolean" }, "evidence": { "type": "string" } } } },
        "passed": { "type": "boolean" } } } }
  ]
}
```

```text
validate:
✓ program v3 valid: 2 steps, 0 gates, 0 loops (nothing launched)
  build                    build/medium deliverable=files evidence=command
  review                   analyze/medium answer after build blind to build
  checks   not run · add --try-checks to run each command check once now against the current tree (it may take time and must not change files)
```

Keep the goal in a file and pass it as `"$(cat goal.txt)"` to both commands,
so validate and launch get identical text. `bullswarm workflow plan contract`
(no goal needed) prints the format with an example that validates.

```bash
bullswarm workflow plan validate "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json
bullswarm workflow goal "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json --json
bullswarm workflow watch <shortId> --until trouble
```

Validate exit 2 lists the `issues`: fix them and validate again. Advisories
never block; with `--json` they are in the JSON (`advisories`). Exit 0 prints
the launch line; run it. A goal over 120 characters, or with a line break,
shows as `"<goal>"` in that line (`launch   bullswarm workflow goal "<goal>"
--cwd …`): put `"$(cat goal.txt)"` in its place. The launch detaches and
returns `shortId`; report it.

Old v2 programs (`bullswarm.workflow.program.v2`) still run? No: since 0.38.0
a new run refuses them, and runs they started are view-only.

Start one watch right after launch; it prints nothing until a wake (a gate
waiting, a loop out of rounds, a step that needs you, a pause, a stale step,
steering, the end). Each exit is one wake: read the output, act, and start the
printed `next:` line again. If your harness cannot wake you when a background
process ends, run the watch in the foreground: it blocks until the wake; give
it a `--timeout` under your tool's time limit (`--until trouble --timeout 100`
for 2 minutes). A restart without `--after` attaches at the newest event and
skips wakes in between. Never end your turn while a run you own is still
running. At a gate: `bullswarm workflow continue <shortId> <gate>`; a loop out
of rounds takes `--rounds <1-5>`. `workflow step accept` on a failed step
inside a loop does not end the loop (the next round still starts); to stop a
loop early let it run out of rounds (`maxRounds`), then
`workflow continue <shortId> <loop>`, recorded as condition not met.
`watch --until trouble` also wakes on
`steering received` (a person left guidance: decide what it means and add
steps).

## 4. Driving it well

Lessons from real runs; each holds for this version.

1. **One worker beats chunks.** Split only when one worker cannot hold the
   input (the triage above): priority and consistency are judgements across
   items, and chunks cannot make them.
2. **Write the judgement down.** A step whose decisions are spelled out (a
   numbered spec, the rulings) runs well at `effort` `medium` or `low`; open
   design needs `high`. Capability is model and reasoning together: the
   effort tier picks both per pool (`bullswarm strategy rungs --json` shows
   each rung), and a step's `reasoning` overrides only the level.
3. **A contract first.** When parallel steps must fit together, a first step
   that writes the shared shape (types, an event format), which the others
   depend on, keeps the join short; without it the integrator becomes the
   author.
4. **Files decide parallelism.** Steps whose `files` overlap run one after
   the other. Give each writer its own files and tell it to keep other
   workers' edits; keep a breaking rename in one step, not parallel with its
   consumers, which would build against the old name.
5. **Checks are facts.** Put anything a machine can say in `evidence`. When
   the checks are safe to run now (not ones that write, deploy, call paid
   services or take long), run `bullswarm workflow plan validate … --try-checks`
   before launch and read each `try` line: an error such as a missing module
   or command means the check itself is wrong, and fixing a wrong check later
   reruns the worker. Workers share one tree, so a later step can undo what an earlier
   step's check proved; put the final check where nothing runs after it
   (after integration, or on the step a gate waits behind).
6. **Reviews that hold.** State the contract as numbered checks, make any
   difference a finding even when the author justifies it, have it record
   `holds` and evidence per check with `passed` true only when every check
   holds, and add `blindTo` the author: a builder's credible reason talks a
   reviewer who reads it out of a real finding. Let Bullswarm place the review
   by quota as for any step; add `route.independentOf` only for your own
   reason (another model family's view, the owner asked, a compliance rule),
   knowing another provider may still serve the same model, so name
   `providers`/`pools` when the model family matters. Keep the brief consistent
   with the repository's own rules: a brief that contradicts a repo test cannot
   pass honestly.
7. **Plan ahead, add later.** Declare the steps, gates and loops you can see.
   Where the next part depends on an answer (one check per finding, one build
   step per slice), stop there and add it with `workflow add` when the answer
   arrives. Put a gate before expensive or outward work, and after a design
   step the owner must approve.
8. **Watch by wake-ups.** One `watch --until trouble` per run. Between wakes
   do not poll, read the run directory, or send per-step status replies. At a
   needs-you block, pick one printed option and run it as printed.
9. **The worker's report is not proof.** Read the output and the diff.
   `ok: true` and `proven by command` mean the checks passed, not that the
   work is right; `answer checked` is a well-formed claim.
10. **Retries are for flakes.** The one automatic retry covers a crash or a
    failed check. A refusal at start (a sign-in failure or a model the plan
    does not include, before any work) is picked again and does not use it.
    A pool whose meter read says the sign-in failed is out of picks until a
    later read succeeds.
    A worker whose check or deliverable failed and whose report
    lists `- outside: <blocker>` under `## Not done` comes back at once. Fix
    the cause with `workflow add` rather than rerunning the same step.

## 5. Read the outcome

`outcome:` is `completed`, `partial` or `cancelled`, and `reason:` says why in
one line. A completed v3 run hands nothing back: every step succeeded. The
proof line says what backs each step: `proven by command` or `proven by
schema` (a check Bullswarm ran passed), `answer checked` (its answer passed
its schema: a well-formed claim, not proof, so it is not counted as proven),
`finished · unproven` (neither), and `accepted by choice` (your decision,
never verification). When you report the outcome, quote the run's proof line
as printed (`proof: …` at the end of watch, `# proof` in `runs result`)
instead of paraphrasing it. Then read the real outputs and answers
(`bullswarm workflow runs result <shortId> --json` names every step's output)
and probe the important edge cases yourself. A `partial` run lists what is
unfinished and your options: see recovery.md.

## 6. Read this when

| Situation | Read |
|---|---|
| a step needs you (a needs-you block), a rate limit, a usage limit or no free pool | [recovery.md](references/recovery.md) |
| a step looks stale; pause, restart or cancel; a run ended `partial` | [recovery.md](references/recovery.md) |
| writing a program: every field, conditions, answers, evidence, deliverables | [program.md](references/program.md) |
| a review: the strict form and `blindTo` | [program.md](references/program.md) "Reviews", [patterns.md](references/patterns.md) 3 |
| copying a workflow: find then check, fix until green, draft to publish, parallel slices, triage | [patterns.md](references/patterns.md) |
| `workflow add` and `blocks`, `wait`, `continue`, watch modes and flags, handback fields, routing and reasoning diagnosis, view-only saved runs | [operations.md](references/operations.md) |
| adding a provider | [providers.md](references/providers.md) |
