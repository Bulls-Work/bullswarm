---
title: Run one task
description: Every bullswarm run option, how to read the verdict it prints, and how to re-judge saved outputs.
---

# Run one task

After this page you can dispatch one bounded task with `bullswarm run`, pick the right option for a long prompt, a different working directory, a timeout, or a dry run, and know what to do for each verdict it can print.

## What a run does

`bullswarm run` routes the task to one eligible pool, spawns that agent CLI in the working directory, watches it to completion, saves the output, and prints exactly one verdict. Nothing is left in the background.

```bash
# one read-only analysis task, routed and verified
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json
```

`--lane` is required: `analyze` for read-only exploration, `build` for edits, `chore` for small mechanical work. Omitting it, or passing anything else, exits 2 before anything is routed or spawned.

## Options

| Flag | Meaning | Default |
|---|---|---|
| `--lane <analyze\|build\|chore>` | Which routing lane to use: analyze (exploratory/large), build (implementation), chore (small/cheap). | required — omitting it exits 2 |
| `--add-dir <dir>` | Working directory the delegate operates in. | current directory |
| `--task-file <file>` | Read the task text from a file instead of trailing words. | — (one task source required) |
| `--prompt <text>` | Pass the task text inline as one flag value. | — (one task source required) |
| `--batch <tasks.jsonl>` | Run each line of a JSONL file as its own run and print one array of verdicts. See [Many tasks in one call](/reference/cli#many-tasks-in-one-call). | off — one task |
| `--concurrency <n>` | With `--batch`: how many tasks run at once. | 4 |
| `--effort <high\|medium\|low>` | Override the effort tier used for model-tier routing. | derived from `--lane` (analyze→medium, build→medium, chore→low) |
| `--reasoning <low\|medium\|high\|xhigh\|max\|default>` | Run-wide thinking-level override, clamped to what the picked pool's connector accepts; `default` passes nothing. | the strategy reasoning setting for the effort tier, else the connector default |
| `--timeout <seconds>` | Hard wall-clock kill timer for the delegate process. | none — the delegate may run to completion |
| `--heartbeat <seconds>` | Print one compact progress heartbeat to stderr per interval, without streaming delegate output. | off |
| `--dry-run` | Print the routing decision, the forecast, and the exact command that would be spawned, without spawning or registering anything. | off (dispatches for real) |
| `--no-caller` | Exclude the calling agent from routing, so the task must go to a delegate pool or fail. | off — the caller competes for the lane |
| `--avoid-pool`, `--use-provider`, `--avoid-provider`, `--independent-of` | Route filters: keep this run off a pool or provider, or off the provider that ran an earlier run. See [Route filters](/reference/cli#route-filters). | none |
| `--json` | Print the machine-readable verdict document. | human-readable summary line |

The task itself is also accepted as trailing words: `bullswarm run --lane analyze "list every TODO in src/"`.

## Long prompts

Use `--task-file` when the prompt is longer than a command line should hold. It is mutually exclusive with `--prompt` and with trailing task words; passing two sources exits 2 rather than guessing.

```bash
# hand the delegate a task written in a file
bullswarm run --lane build --add-dir ~/some-repo --task-file /tmp/refactor.md --json
```

## Working directory

`--add-dir` is the directory the delegate is spawned in, so `--add-dir .` analyses the repository you are standing in. With no `--add-dir`, the current directory is used.

## Preview without dispatching

`--dry-run` prints the pick, the forecast the pick was made on, and the resolved argv, then returns without spawning a process, registering an in-flight assignment, or writing the decision log.

```bash
# see which pool would get this build task, and the exact command
bullswarm run --lane build --add-dir . --dry-run "Refactor the loader"
```

```text
OK [grok] most-behind capable pool (surplus -2.1)
command: grok -p ~/.bullswarm/runs/task-1789546399287-2pxqk.md --model grok-4.6 --reasoning-effort high --output-format streaming-json
forecast: inflight=0 5h ?%->?% expected=5.67m rate=unmeasured basis=bootstrap
reasoning: high (connector)
```

`forecast` is the projection routing decided on: how many agents that pool already carries, where its 5-hour window is expected to land after this task, how many minutes the task is expected to take, the measured burn rate, and where the estimate came from.

## What each verdict asks you to do

| Verdict | What it means | What to do |
|---|---|---|
| `keepOnClaude: true` | Nothing ran; routing kept the task on the calling agent. | Do the task in this session, or add `--no-caller` to force a delegate pool. |
| `ok: true`, `keepOnClaude: false` | The output passed the verify gate. | Read `outFile`; the work is done. |
| `ok: false` | `why` names the gate that failed. | Read `outFile` before re-running — the delegate may still have written something usable. |
| `contentUsableDespiteExit: true` | The process exited non-zero, but the content still verified. | Read `outFile` first; re-run only if it is incomplete. |

```bash
# the human-readable form, when you are watching one run
bullswarm run --lane analyze --add-dir . --prompt "Summarize the verify gate"
```

The human line is `OK`/`FAIL`, the pool, and `why`; with `--json` you also get `pick`, `meta` (exit code, wall time, token and cost usage, the reasoning level actually applied), and the file paths. A `why` of `announcement without substance` means the delegate promised work instead of doing it — ask for a checkable shape next time.

::: tip
`keepOnClaude: true` is not an error. It means no delegate was eligible or worth spending, so the task is yours to do in this session. Add `--no-caller` to force it to a delegate pool instead.
:::

## Re-judge saved outputs

`bullswarm health` re-runs the verify gate over every saved `out-*` file and reports outputs logged as failures that now pass.

```bash
# human summary
bullswarm health
# the same facts as JSON; exit 1 means unhealthy, not a crash
bullswarm health --json
```

## Next steps

- [Routing](/guide/routing) — why the task went to that pool, in the order the code decides.
- [Workflows](/guide/workflows) — several dependent tasks in one durable run.
- [Concepts](/guide/concepts) — pools, lanes, surplus, and limits in one place.
- [Result envelope](/reference/result) — every field of the verdict, listed.
