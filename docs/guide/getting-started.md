---
title: Getting started
description: Install Bullswarm, verify your pools, and read the verdict from your first run.
---

# Getting started

After this page you will have Bullswarm installed, your agent CLIs discovered, the packaged skill registered with them, and one finished run whose JSON verdict you can read field by field.

## Install

Bullswarm runs on Node.js 22.12 or later.

```bash
# install the CLI, then print the installed version
npm i -g bullswarm
bullswarm version
```

Later, `bullswarm update` upgrades that install in place to the latest published version, and `bullswarm update --check` only reports whether a newer one exists.

## Configure your pools

`bullswarm setup` discovers the agent CLIs installed on this machine, shows their quota state, and writes the routing configuration. On a terminal, bare `bullswarm setup` opens the provider/model control center; `--yes` takes the discovered defaults without prompting, which is what an agent or a CI job wants.

```bash
# discover installed CLIs and write routing config without prompting
bullswarm setup --yes
```

## Check readiness

`bullswarm doctor` reports one line per check — config present, at least one agent CLI discovered, meters reachable, at least one delegate pool enabled — and prints the exact fix command for anything failing.

```bash
# human checklist, with a fix command per failed check
bullswarm doctor
# the same facts as { version, configured, ok, checks[], nextActions[] }
bullswarm doctor --json
```

The exit code is 0 when every check passes and 1 when one fails, so `doctor` works as a gate in a script.

## Register the skill with your agents

The integration step symlinks the packaged `bullswarm` skill into each agent's global config and appends a short awareness rule, so an agent that has never seen Bullswarm can still discover it. Installed agents see it as `/bullswarm` (or `$bullswarm`).

```bash
# symlink the skill and append the awareness block
bullswarm integrate install --yes
# report install state per agent
bullswarm integrate status
```

`--agents codex,claude,grok` limits the action to a subset; the default is all three. The awareness rule is also what stops an agent Bullswarm launched from re-delegating into a recursive swarm. `bullswarm integrate remove --yes` reverses the install.

## Your first run

```bash
# one read-only analysis task, routed to the best pool and verified
bullswarm run --lane analyze --add-dir . --prompt "Print a JSON array of the file names in src/lib that start with route or verify, and nothing else." --json
```

The command prints exactly one verdict document when the delegate finishes, trimmed here to the fields this page explains:

```json
{
  "ok": true,
  "why": "verified",
  "keepOnClaude": false,
  "pick": {
    "pool": "grok",
    "model": "grok-4.6",
    "command": ["grok", "-p", "{taskFile}"]
  },
  "contentUsableDespiteExit": false,
  "meta": { "pool": "grok", "exitCode": 0, "wallSec": 148.5 },
  "outFile": "~/.bullswarm/runs/out-1789546447796-qkr32.md",
  "taskFile": "~/.bullswarm/runs/task-1789546447796-qkr32.md"
}
```

## Reading the verdict

| Field | Meaning |
|---|---|
| `ok` | Whether the saved output passed the verify gate. `true` means the content was judged real work. |
| `why` | The gate that decided it: `verified`, or the reason it failed, such as `announcement without substance`. |
| `keepOnClaude` | `true` means the router kept the task on the calling agent and nothing ran. |
| `pick` | The pool and model that ran it, and the argv template that was spawned (`{taskFile}` is filled with the task file path). |
| `contentUsableDespiteExit` | `true` when the process exited non-zero but its content still passed; read the output before re-running. |
| `outFile` | The saved delegate output; `taskFile` is the prompt that produced it. |
| `meta` | Exit code, wall time, output bytes, token/cost usage, and the reasoning level actually applied. |

```bash
# read the output the verdict points at
cat ~/.bullswarm/runs/out-<stamp>.md
```

::: warning
A delegate exiting 0 is not success. One real run answered a two-line request with `I'll read that scratchpad file first …` plus the two lines, and the gate failed it as `announcement without substance`. When the answer is small, ask for a shape you can check — a JSON array, one fact per line.
:::

## Next steps

- [Run one task](/guide/run) — every `bullswarm run` option and what each verdict asks you to do.
- [Workflows](/guide/workflows) — when one delegate is not enough, author a program for `workflow goal`.
- [Routing](/guide/routing) — why this run went to that pool.
