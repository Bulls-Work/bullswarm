---
title: Getting started
description: Install and set up Bullswarm, run one bounded task, launch a workflow, and open the dashboard.
---

# Getting started

After this page you will have Bullswarm installed, your agent CLIs discovered,
one finished task, one workflow program ready to launch, and the dashboard open.

## Install

Bullswarm runs on Node.js 22.12 or later.

```bash
# install the CLI, then print the installed version
npm i -g bullswarm
bullswarm version
```

Later, `bullswarm update` upgrades that install in place to the latest published version, and `bullswarm update --check` only reports whether a newer one exists.

## Set up the fleet

`bullswarm setup` discovers the agent CLIs installed on this machine, shows
their quota state, and opens the provider/model control center. Its three
effort tiers — `high`, `medium`, and `low` — each resolve to a provider pool,
model, and reasoning level. They are separate from the work lanes `analyze`,
`build`, and `chore`: a lane says what kind of work this is; an effort tier
says which model rung it needs.

```bash
# open the interactive provider/model control center
bullswarm setup

# agent or CI setup: discover and accept deterministic defaults
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

## Or ask your agent to set it up

Bullswarm ships with an agent-facing skill. You can ask your main agent to use
the packaged Bullswarm skill and set up the fleet, or install the integration
yourself. The integration symlinks the skill into each supported agent's global
config and adds the awareness rule that lets it discover Bullswarm. Installed
agents see it as `/bullswarm` (or `$bullswarm`).

```bash
# symlink the skill and append the awareness block
bullswarm integrate install --yes
# report install state per agent
bullswarm integrate status
```

`--agents codex,claude,grok` limits the action to a subset; the default is all three. The awareness rule is also what stops an agent Bullswarm launched from re-delegating into a recursive swarm. `bullswarm integrate remove --yes` reverses the install.

## Your first run

Use `bullswarm run` for one bounded outcome. This read-only example asks for a
machine-checkable answer, routes it to one eligible pool, and prints the full
verdict.

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

## Your first workflow

A workflow starts from a program you author. Ask for the contract, create a
`plan.json` that divides the goal into actions and evidence, validate it, then
launch it. The workflow guide includes a complete program you can copy.

```bash
# get the exact program schema for this goal
bullswarm workflow plan contract "Add a status command, document it, and verify both" --cwd . --json

# after writing plan.json, reject structural or requirement gaps before launch
bullswarm workflow plan validate "Add a status command, document it, and verify both" --cwd . --program plan.json --json

# run ready actions across the fleet and follow low-noise progress
bullswarm workflow goal "Add a status command, document it, and verify both" --cwd . --program plan.json --watch
```

Start with [the worked workflow program](/guide/workflows), then use the
[playbook](/guide/playbook) to decide what belongs with your main agent and
what should fan out.

## Open the dashboard

Once setup exists, bare `bullswarm` opens Home. You can also use the explicit
workflow form, optionally with a run id.

```bash
bullswarm
bullswarm workflow tui
bullswarm workflow tui <runId>
```

Home summarizes current and recent work. Runs opens the catalogue; Run and
Step expose progress and evidence; Budget, Stats, and Fleet explain quota,
history, and routing. The dashboard is read-only for normal browsing, and
quitting it does not stop workflows. See [Observing runs](/guide/observing)
for the screenshots and controls.

## Next steps

- [Run one task](/guide/run) — every `bullswarm run` option and what each verdict asks you to do.
- [Workflows](/guide/workflows) — when one delegate is not enough, author a program for `workflow goal`.
- [Playbook](/guide/playbook) — the day-to-day planning, steering, and sign-off rhythm.
- [Routing](/guide/routing) — why this run went to that pool.
