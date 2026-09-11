# bullswarm

Bullswarm is a CLI that sends a coding task to whichever of your installed
agent CLIs — Claude Code, Codex, Grok, OpenCode, or Command Code — currently
has unused subscription quota, then checks the result by its content.

One command runs one task. A second command runs a graph of dependent tasks
across those same CLIs. Every result is judged by what was actually written,
not by whether the process exited 0.

For an agent already working in a repo, the packaged `bullswarm` skill
(`/bullswarm`, or `$bullswarm` where a skill uses that syntax) goes straight
to `bullswarm run` or `bullswarm workflow goal`. A skill here is a short
instruction file the agent CLI loads. There is no separate preview or
classifier command to learn first.

## Why it exists

Subscription quota expires on a clock, whether you spend it or not, and a
single coding agent's judgment on whether its own work is done should not be
the only check in the loop. Bullswarm picks whichever installed agent CLI has
the most unused quota right now, and treats every delegate's output as
evidence to be verified — never as an authority to be trusted on its word.

The same problem compounds on multi-step goals: one agent planning and
executing everything serially leaves every other installed CLI's quota idle,
and having that same agent be the sole judge of whether the whole goal is
done multiplies the risk instead of dividing it. Bullswarm's workflow engine
runs a graph of dependent actions across whichever pools have quota to spare
— a pool is one installed agent CLI, or one account of that CLI — and
computes completion from evidence the graph itself required, not from any one
delegate's own say-so.

## Install

```bash
npm i -g bullswarm
bullswarm setup
```

Requires Node.js 18 or later. `bullswarm setup` walks through detecting your
installed agent CLIs, showing their quota state, and writing a routing
configuration. See
[Getting started](https://cowcow02.github.io/bullswarm/guide/getting-started/)
for integrating Bullswarm's skill into Codex, Claude, and Grok, and for the
full quick-start command list.

## Quick start

One bounded outcome — a task with a clear finish line:

```bash
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json
```

`--lane analyze` tags the work as read-only analysis. The other lanes are
`build` (edits) and `chore` (mechanical edits). This routes the prompt to
whichever pool is eligible, dispatches it, watches it to completion, verifies
the output, and prints one JSON verdict — nothing else runs and nothing is
left in the background.

Multi-step work, where you author the plan. The kernel — Bullswarm's own
runtime, not an agent — validates that program and executes it:

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    { "id": "fix", "kind": "implement", "purpose": "Fix the failing tests",
      "dependsOn": [], "ownedFiles": ["src/parser.js"], "affects": ["requirement-1"],
      "evidenceFor": [], "prompt": "In ~/some-repo, fix the failing tests with the smallest correct change." }
  ]
}
```

```bash
# 1. Write plan.json — the bounded action program the kernel will enforce.
bullswarm workflow plan validate "Fix the failing tests and verify the change" \
  --cwd ~/some-repo --program plan.json --json     # exit 0 valid, exit 2 with the issues; nothing launches
bullswarm workflow goal "Fix the failing tests and verify the change" \
  --cwd ~/some-repo --program plan.json             # launches, prints a short ID and observation commands, returns
```

`workflow goal` starts a durable background run and returns immediately by
default; add `--watch` to follow its low-noise progress in the same terminal
instead.

## How it picks a pool

- Work is tagged by lane — read-only analysis, ordinary build work, or
  mechanical chores — not assigned to a fixed pool ahead of time.
- Among the pools that can do the work, the one furthest behind its own quota
  pace (the most unspent surplus) wins, so quota doesn't expire unused.
- A pool that's about to hit its rolling 5-hour usage ceiling is passed over in
  favor of one with headroom, based on where the clock actually is in that
  window, not a flat percentage.
- A pool whose weekly or monthly subscription window is about to reset gets
  priority for its remaining surplus, so quota doesn't run out the clock
  unspent.
- A pool already busy with other in-flight work yields to a quieter pool at a
  similar pace, so a burst of parallel work spreads out instead of piling onto
  one pool.
- A pool that reports a usage-limit error is benched until the provider's own
  reset time and automatically re-tried after that — never left down for good,
  and never retried early.

The full mechanics behind each of these are in
[Routing](https://cowcow02.github.io/bullswarm/guide/routing/).

## What you get back

`bullswarm run` prints a JSON verdict when it finishes:

- `keepOnClaude: true` — the router says do this in-session; nothing ran
- `ok: true` (and `keepOnClaude` is false) — the output passed verification;
  read `outFile`
- `ok: false` — `why` names the gate that failed
- `contentUsableDespiteExit: true` — the process exited non-zero but the
  content still verified; read it before re-running

A non-zero exit from the delegate is never treated as success on its own. See
[Doctrine](https://cowcow02.github.io/bullswarm/guide/doctrine/) for the full
verdict shape.

A workflow produces a durable, versioned result envelope — a JSON document
with `runId` / `shortId`, status, per-requirement evidence, per-action
outcomes, and usage — instead of leaving you to parse a transcript.

```bash
bullswarm workflow watch <shortId> --next                  # wait for the next notable event, then exit
bullswarm workflow runs result <shortId> --json --summary  # compact status once the run is terminal
```

`workflow watch --next` prints one line per event and relaunches itself with
the exact flags to keep polling; `runs result --summary` is what to read once
a run finishes, and `runs result --json` (no `--summary`) gives the full
envelope for a failed or partial run. See
[Operations](https://cowcow02.github.io/bullswarm/guide/operations/) for the
full shape of both.

## Documentation

The full documentation is published at
[cowcow02.github.io/bullswarm](https://cowcow02.github.io/bullswarm/) once
GitHub Pages is enabled for this repository (Settings → Pages → deploy from
branch `main`, folder `/docs`). Until then, the same pages are readable
directly under [`docs/guide/`](docs/guide/) in this repository.

| Page | What it covers |
|---|---|
| [Entry points](https://cowcow02.github.io/bullswarm/guide/entry-points/) | `run` vs `workflow goal`, and every top-level verb |
| [Doctrine](https://cowcow02.github.io/bullswarm/guide/doctrine/) | The non-negotiable rules, and the result verdict shape |
| [Getting started](https://cowcow02.github.io/bullswarm/guide/getting-started/) | Install, agent integration, quick-start commands |
| [Strategy](https://cowcow02.github.io/bullswarm/guide/strategy/) | Model/provider configuration, rungs (model plus reasoning level per effort tier), benchmark evidence |
| [Workflows](https://cowcow02.github.io/bullswarm/guide/workflows/) | Authoring a program, kinds, advisories, plan contract/validate/goal |
| [Operations](https://cowcow02.github.io/bullswarm/guide/operations/) | Listing/inspecting runs, the result envelope, context diet |
| [Dashboard](https://cowcow02.github.io/bullswarm/guide/dashboard/) | `workflow watch`, the interactive TUI, terminal glyph fallback |
| [Repository operations](https://cowcow02.github.io/bullswarm/guide/repository-operations/) | The issue-watcher launchd agent |
| [Routing](https://cowcow02.github.io/bullswarm/guide/routing/) | How a pool is picked: pace, headroom, urgency, load, quarantine |

## License

MIT
