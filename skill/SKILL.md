---
name: bullswarm
description: Delegate bounded work through Bullswarm, one quota-routed task (bullswarm run) or a workflow you write from steps, phases, gates and loops (bullswarm workflow goal --program); watch it as closely as you choose, and extend it with workflow add. Use for /bullswarm, offloading, independent checks, or requested multi-agent execution.
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
- `--avoid-pool`, `--use-provider`, `--avoid-provider`: where it may run.
- `--timeout <seconds>`: kill the worker after that long (`timeout after
  <N>s`, failure kind `interrupted`; the retry still runs).

Read the verdict. `ok: true` means read `outFile` (and `answer`) and check the
content before you use it. `ok: false` means inspect and report the failure;
`failureKind` names it and `why` says it in one line. `shortId` names the run;
the last field, `details`, is the command for its record and cost. A
build or chore run that changes no file (files git ignores count) fails
`not-produced`, also outside git. Do not run `doctor` unless dispatch reports
a readiness problem.

## 3. A workflow: four blocks

| Block | What it is | Declared as |
|---|---|---|
| Step | one agent task | an entry in `steps`: `{id, prompt, dependsOn, …}` |
| Phase | a label that groups steps; the dashboard groups by it | `phase` on each step |
| Gate | the run stops there and waits for you, or only when an answer says so | an entry in `gates`: `{id, dependsOn, when?, note?}` |
| Loop | steps that repeat until one step's answer (or evidence) says stop, at most `maxRounds` (1-5) | an entry in `loops`: `{id, steps, until, maxRounds}` |

A program that researches in parallel, rewrites a brief until an independent
critique passes, waits for you, then publishes (`plan validate` accepts it: 5
steps, 1 gate, 1 loop):

```json
{
  "schemaVersion": "bullswarm.workflow.program.v3",
  "steps": [
    { "id": "search-a", "phase": "research", "prompt": "In /work/acme, collect the claims sources/a.md makes about widgets.", "answer": { "type": "object", "required": ["claims"], "properties": { "claims": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "search-b", "phase": "research", "prompt": "In /work/acme, collect the claims sources/b.md makes about widgets.", "answer": { "type": "object", "required": ["claims"], "properties": { "claims": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "draft", "phase": "writing", "dependsOn": ["search-a", "search-b"], "lane": "build", "files": ["brief.md"], "prompt": "In /work/acme, write brief.md from the claims your dependencies answered. From round 2 on, fix the problems the previous critique listed." },
    { "id": "critique", "phase": "writing", "dependsOn": ["draft"], "route": { "independentOf": ["draft"] }, "prompt": "In /work/acme, check every claim in brief.md against sources/. List only problems a line of sources/ shows. Answer passed true when you list none.", "answer": { "type": "object", "required": ["passed", "problems"], "properties": { "passed": { "type": "boolean" }, "problems": { "type": "array", "items": { "type": "string" } } } } },
    { "id": "post", "phase": "publish", "dependsOn": ["approve"], "deliverable": "outward", "retry": 0, "prompt": "Publish /work/acme/brief.md to the acme wiki, and list the page you created." }
  ],
  "loops": [{ "id": "polish", "steps": ["draft", "critique"], "until": { "step": "critique", "field": "passed" }, "maxRounds": 2 }],
  "gates": [{ "id": "approve", "dependsOn": ["polish"], "note": "Read brief.md and decide whether to publish it" }]
}
```

[program.md](references/program.md) lists every field.
[patterns.md](references/patterns.md) has five workflows to copy: find then
check each finding, fix until a check passes, draft to publish, parallel
slices, and a triage (usually one run).

### Writing the program

- **Plan as far ahead as you know.** Declare the steps, gates and loops you can
  see now. Where the next part depends on an answer (one check per finding, one
  build step per slice), stop there and add it later with `workflow add`.
- **A step passes by facts.** Its worker ended cleanly, its deliverable was
  produced, its evidence passed, and its answer (when declared) matched the
  schema. Declare an `answer` whenever you, a later step or a condition needs
  data from the step; a dependent step is handed its dependencies' checked
  answer files.
- **The one condition form.** A gate's `when` and a loop's `until` read one
  value: `{"step": "critique", "field": "passed"}` (a boolean the step's answer
  schema requires; add `"equals": false` to invert it) or `{"step": "check",
  "evidence": "passed"}`. No expressions and no else: anything more is your
  call, with `workflow wait` and `workflow add`.
- **Loops run every step in every round**, and read their condition when the
  round is over. Put the deciding step last, and give every writer in the loop
  work each round: a build or chore step that changes no file fails
  `not-produced` (rewrite the draft from the critique; do not put a revise
  step after a critique that may pass the first time). From round 2 on, each
  step's task carries a `Previous round` block with the last round's answers
  and evidence. When a loop's `until` is the evidence form (`{"step": "check",
  "evidence": "passed"}`), a failed check on that step reads as "not passed"
  and the loop goes on. With the field form, a failed check fails the step as
  it would outside a loop.
- **A critique asks only for what the sources can show.** A claim that
  something is missing cannot cite a line, so a critique that demands one
  never passes. Cap `maxRounds` at 2 unless a round is cheap, and decide up
  front what you do when it runs out (continuing it is recorded as unmet).
- **Gates stop only what is behind them.** Other branches keep running. When
  only waiting gates or loops are left, the run parks with status `waiting`.
- **Independent checks.** `route.independentOf` names steps this step depends
  on (directly or through others) whose provider it must not use, so a check
  independent of `find` also depends on `find`. It needs a second provider:
  with only one enabled, validate and `workflow add` refuse it (`every enabled
  pool that could run it … uses that provider; enable a pool of another
  provider or drop independentOf`). The other provider needs a model on the
  step's tier: a no-pool refusal names each pool's reason.
- **Shared folder.** All workers share one tree. Name each writer's exact
  files in `files` (steps whose files overlap run one after the other) and tell
  it to keep other workers' edits.
- **Evidence: checks Bullswarm runs.** Add a command or schema check for
  anything a machine can check (`"evidence": [{"type": "command", "cmd": "npm
  test", "timeoutSec": 300}]`, at most 5 items). Each check has a timeout
  (default 120 seconds, at most 600); a suite that runs longer cannot be one
  item: split it, or have the step run it and answer with the result. Run a
  check by hand before launch, because fixing a wrong check reruns the worker.
  Checks are read-only: a change to the deliverable fails the item. If the
  worker fails first, no check runs: the step's handback line and watch's
  failed line read `evidence not run`, and the JSON has `evidenceResults:
  null`. Each check's result is in `runs result <id> --json` under
  `actions[].evidenceResults` (`status`, `exit`, `tail`, `why`) and in
  `workflow action show <id> <step>`.
- **Steps that must not repeat.** Sending or publishing is `"deliverable":
  "outward"` with `"retry": 0`; an outward step is never retried once its worker
  started.
- **Prompts are self-contained.** Nothing is substituted: name the absolute
  workspace path, the outcome, the files, what to read from dependencies, and
  the checks to run. Every task carries a soft time box (`timeBox` minutes, a
  guide, never a timeout); a step that lists items under `## Not done` still
  succeeds and reads `returned early · N not done`.

Old v2 programs (`bullswarm.workflow.program.v2`) still run as before; write
new work in v3.

### Validate, then launch

Keep the goal in a file and pass it as `"$(cat goal.txt)"` to both commands,
so validate and launch get identical text. `bullswarm workflow plan contract`
(no goal needed) prints the format with an example that validates.

```bash
bullswarm workflow plan validate "$(cat goal.txt)" --cwd=<abs-dir> --program=<abs-dir>/plan.json
```

```text
✓ program v3 valid: 2 steps, 0 gates, 1 loop (nothing launched)
  fix                      build/medium deliverable=files
  check                    analyze/medium evidence=command answer after fix
  loop until-green         steps fix, check · until check's evidence passed · at most 3 rounds
  launch   bullswarm workflow goal 'Make the acme tests pass' --cwd /private/tmp/v37e/acme --program /private/tmp/v37e/loop.json --json
```

Exit 2 lists the `issues`: fix them and validate again. Exit 0 prints the
launch line; run it. A goal over 120 characters, or with a line break, shows
as `"<goal>"` in that line (`launch   bullswarm workflow goal "<goal>" --cwd
…`): put `"$(cat goal.txt)"` in its place before you run it. The launch
detaches and returns `shortId`; report it.

## 4. Watch: choose how close

| Mode | Wakes you on | Command |
|---|---|---|
| Wake-ups only (the default choice) | a gate waiting, a loop out of rounds, a step that needs you (after its retry, or at once for a usage limit), a pause, a stale step, steering, the end; each loop that finished since the last wake is printed too, without waking | `bullswarm workflow watch <shortId> --until trouble` |
| Every step | each finished step with its answer, loop rounds, plus every wake-up | `bullswarm workflow watch <shortId>` (or `--next` for one step at a time) |
| Named steps | only the steps, gates or loops you name | `bullswarm workflow wait <shortId> <id...>` |

Start one watch right after launch; it prints `watching <shortId> until
trouble · <n> steps` and then nothing until a wake. Each exit is one wake:
read the output, act, and start the printed `next:` line again. If your
harness cannot wake you when a background process ends (a subagent's turn
ends when it replies), run the watch in the foreground: it blocks until the
wake; give it a `--timeout` under your tool's time limit (`--until trouble
--timeout 100` for 2 minutes). A restart without `--after` attaches at the
newest event and skips wakes in between. Never end your turn while a run you
own is still running. Between wakes do not poll, read the run directory, or
send per-step status replies.

A gate wake-up after a loop (real output of the fix-until-green loop above,
with a gate `ship` after it). The loop's line
comes with the wake, so you need no `workflow wait` to learn how it ended:

```text
✓ loop until-green passed in round 1 of 3 · check's evidence passed
⧖ gate ship waiting · Read the fix and decide whether to write CHANGES.md · continue: bullswarm workflow continue m39i62 ship
outcome: waiting
waiting: gate ship · Read the fix and decide whether to write CHANGES.md
next: bullswarm workflow continue m39i62 ship
```

`workflow wait` returns each named step's facts and checked answer (exit 0
when none failed, 1 when one failed or the run stopped short, 2 on a timeout),
after a line for each loop the named ids wait behind:

```text
✓ loop until-green passed · round 1 of 3
⧖ gate ship waiting · Read the fix and decide whether to write CHANGES.md
  continue bullswarm workflow continue m39i62 ship
```

A watch of every step also prints each finished step with its answer and
proof (`✓ check finished · proven by command · answer checked · 56s`, then
`answer {…}`) and each phase (steps without a `phase` group by dependency
level).

### Gates and loops that wait for you

`bullswarm workflow continue <shortId> <gate>` passes a waiting gate, and the
steps behind it start. A loop out of rounds waits the same way:
`bullswarm workflow continue <shortId> <loop> --rounds <1-5>` gives it more
rounds; without `--rounds` the steps behind it run, and it reads `→ loop <loop>
continued by the caller after N of N rounds (condition not met)`, never
passed. Before you continue you may add steps. The command relaunches the kernel when none is running:

```text
✓ gate ship passed in m39i62; kernel relaunched
  watch    bullswarm workflow watch m39i62 --until trouble
```

### When a step needs you

The one failure rule: a failed step gets one automatic retry (a process
failure on another eligible pool, a failed check on the same pool with the
failure attached), then it comes back to you in a needs-you block. A step with
`retry: 0`, a started outward step, a usage limit, and a step no pool can run
come back at once (`not retried`). Nothing else is automatic except what you
declared (the retry, loop rounds, gates) and the rate-limit backoff below.
Only a failed step's dependents wait; other branches finish. A real block:

```text
✗ lint needs you · command evidence failed after 1 retry
  evidence  test -f LINT-OK.md → exit 1
  try 1  grok · grok-4.7 · 2m33s · 0 files
  try 2  same pool, failure attached · 1m33s · 0 files
  waiting on this: summary
  your call:
    retry here       bullswarm workflow step rerun hkbbbi lint
    add steps        bullswarm workflow add hkbbbi --steps part.json
      then wait      bullswarm workflow wait hkbbbi <added ids>
    take over        output: /private/tmp/v37e/home/workflows/wf-muli1jve-d48ab9/out-lint-attempt-2.md · diff: /private/tmp/v37e/home/workflows/wf-muli1jve-d48ab9/diff-lint-attempt-2.txt
    accept anyway    bullswarm workflow step accept hkbbbi lint --reason "…"
  next: bullswarm workflow watch hkbbbi --until trouble --after <sequence> --since <iso>
```

Choose one option, run it, then start the `next:` watch again:

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another eligible pool may succeed | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>`; the pool stays in the step's route |
| `retry here` | printed instead when no other pool could run the step | `bullswarm workflow step rerun <shortId> <step>` |
| `add steps` / `then wait` | the step must be done differently: a v3 run's steps are never edited, so add a new one | `bullswarm workflow add <shortId> --steps part.json`, then `bullswarm workflow wait <shortId> <added ids>` |
| `take over` | the rest is small or needs something only you have | read `output:` (and `diff:`) and do the work yourself |
| `accept anyway` | you keep the failed result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"`: recorded as your choice, never proof; rerunning the step undoes it |

### A usage limit or no free pool

A usage limit ends the step: a spent 5-hour, weekly or monthly window, or no
credit left. The step comes straight back to you in a needs-you block (`✗
<step> needs you · out of quota …`), even when the notice names no reset.
Nothing waits, moves to another pool or retries by itself, and the rest of the
run keeps going. Bullswarm never remembers a spent or dead pool from one step
to the next: the pool's meter is read again at once, and a window it shows at
100% keeps the pool out of later steps until that window resets. The same
happens when no pool that can run the step is free when it is picked. Its
`why` names every pool and its reason (`no pool with quota to spare: <pool> at
its 5-hour limit until <time>; …`, `<pool> at its weekly limit until <time>`,
or `no pool free: …` when a reason is not a usage limit, and the header then
reads `no eligible pool`). A retry the step was promised that finds no free
pool keeps its own failure, and its `why` ends `· no retry: <pool> <reason>;
…`.

A short "too many requests" rate limit is not a usage limit. It backs off on
the same pool at most twice (20 s, then 60 s, or the wait it names when that
is at most 2 minutes), then comes back to you (`✗ <step> needs you · rate
limited · backed off twice`). A try after a backoff reads `· after a
rate-limit backoff`. One that names a longer wait comes back to you at once,
with `back at` at the end of that wait. One whose pool is no longer free for
the backoff (at its 5-hour, weekly or monthly limit, or nearly spent in the
meantime) comes back to you at once too: as `out of quota` when that pool is
out on a usage limit, with `back at` its return when that is known. A sign-in
failure, a provider error or a worker that died at start still gets the step's
one automatic retry by itself, on another free pool when there is one. After a
sign-in failure that retry skips every pool that shares the credential;
nothing is stored, so a later step can pick that pool again.

When a return time is known, for this or any other failure, the block prints
`back at <time>` and adds one option:

| Printed option | When to choose it | What it runs |
|---|---|---|
| `rerun elsewhere` | another pool can run the step now | `bullswarm workflow step rerun <shortId> <step> --avoid <pool>` |
| `wait for it` | the step should run on that pool, or nothing else can run it | `after <time>: bullswarm workflow step rerun <shortId> <step>`: run that rerun yourself after the `back at` time; before then the pool is still out |
| `accept anyway` | you keep the step's result as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"` |

`add steps` and `take over` are printed too. To stop the whole run instead,
run `bullswarm workflow cancel <shortId>`.

### A step that looks stale

The watcher prints `⚠ <step> looks stale: <reasons>` once per attempt when a
running step's score crosses its threshold: `quiet 12m with no command
running`, `no file change in 25m while 14 commands ran`, `same command 3× in a
row: <command>`, or `running 47m, over 3× the expected 15m`. Quiet alone is
enough; otherwise two reasons must hold. While Bullswarm runs a step's declared
checks, only quiet counts, read from the checks' heartbeat: `no check heartbeat
for <N>m`. Nothing is stopped for you: let it run (start the `next:` watch
again), or restart it with `bullswarm workflow step restart <shortId> <step>
[--pool <pool>]`, which stops that step only and runs it again with a handoff
of what the stopped attempt did.

### When it finishes

`outcome:` is `completed`, `partial` or `cancelled`, and `reason:` says why in
one line. A completed v3 run hands nothing back: every step succeeded. The
proof line says what backs each step: `proven by command` or `proven by
schema` (a check Bullswarm ran passed), `answer checked` (its answer passed
its schema: a well-formed claim, not proof, so it is not counted as proven),
`finished · unproven` (neither), and `accepted by choice`. When you report the outcome, quote the run's proof line
as printed (`proof: …` at the end of watch, `# proof` in `runs result`)
instead of paraphrasing it. Then read the real outputs and answers
(`bullswarm workflow runs result <shortId> --json` names every step's output)
and probe the important edge cases yourself.

A partial run lists each unfinished step (`step <id>: <status> (<kind>) —
<why>`, with `its pool is back at <time>` when that is known) and your options
under `your call:` (real output):

```text
  step lint: failed (failed-evidence) after 1 retry — test -f LINT-OK.md → exit 1
  step summary: blocked (dependency) — failed dependency
your call:
  add       bullswarm workflow add hkbbbi --steps part.json, then bullswarm workflow wait hkbbbi <added ids> (appends steps, gates or loops and reopens the run)
  rerun     bullswarm workflow step rerun hkbbbi lint [--avoid <pool>] (runs it again with its last attempt's handoff)
  accept    bullswarm workflow step accept hkbbbi lint --reason "…" (recorded as your choice, never proof)
  take over do the unfinished work yourself; bullswarm workflow runs result hkbbbi --json names every step's output
  restart   start a new run: bullswarm workflow goal "<goal>" --cwd /private/tmp/v37e/acme --program <file.json>
```

| Printed option | When | What to do |
|---|---|---|
| `add` | new work is needed, or a step must be done differently | `bullswarm workflow add <shortId> --steps part.json`, then `bullswarm workflow wait <shortId> <added ids>`; the run reopens |
| `retry` | a step stopped for a reason a retry fixes: a crashed or silent worker, a usage limit, or no pool free | `bullswarm workflow resume <shortId>` (run it after its `back at` time) |
| `rerun` | a step failed | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>]` |
| `accept` | you keep a failed step as it is | `bullswarm workflow step accept <shortId> <step> --reason "…"` |
| `take over` | the rest is small, or needs something only you have | do it yourself |
| `restart` | the goal or the approach was wrong | `bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` |

`retry` appears only when a step is retryable. When nothing is retryable,
`resume` prints `nothing to retry`, starts nothing, and exits 1.

**An accept is a choice, never proof.** `step accept` lets the step's
dependents run, and the step reads `accepted by choice` and is counted apart
in the proof line (`N accepted by choice: <steps>`). Report it as your
decision, never as verification.

## 5. Extend or steer a workflow

A v3 run's steps, gates and loops are never edited. You change what happens
next by adding to it:

- `bullswarm workflow add <shortId> --steps part.json` appends a fragment
  `{steps, gates?, loops?}`. New steps may depend on existing steps, gates and
  loops, finished or not (on a loop's steps only through the loop's id).
  Nothing the run has changes, and a finished run reopens. Added steps do not
  take the program's `defaults`: set `lane` and `effort` on each.
  `--from-answer <step>` adds the fragment a step answered (read it with
  `wait` first). Real output:

  ```text
  ✓ added to jcefns · revision 2 (applied directly; kernel relaunched)
    reopened the completed run; its earlier result is archived
    added    step check-first
    wait     bullswarm workflow wait jcefns check-first
  ```

- `bullswarm workflow step rerun <shortId> <step>` runs a step again with its
  last attempt's handoff; `step accept` keeps a failed one; `step restart`
  stops a running one and runs it again.
- `bullswarm workflow pause <shortId>` starts nothing new (`--now` also stops
  running steps); `bullswarm workflow resume <shortId>` lifts it.
  `bullswarm workflow cancel <shortId>` stops the run.
- `watch --until trouble` also wakes on `steering received` (a person left
  guidance for you: decide what it means and add steps) and on a pause.

A stopped step's file edits stay in the shared tree; when they must not
remain, add a step that reverts them. Exit 0 can mean launched, waiting,
paused or completed, so always read the returned status.

[operations.md](references/operations.md) covers the details: add and wait,
continue, reruns and accepts, pause and resume, watch flags, the handback
fields, routing diagnosis, and old v2 runs (plan revise, the verify loop, the
scout and a dispatched planner).
