---
title: Entry points and verbs
permalink: /guide/entry-points/
---

## Entry points

There are exactly two ways to start work:

```bash
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --program plan.json
```

`bullswarm run` is the single-agent entry point: route, dispatch, watch,
verify, one JSON verdict. `bullswarm workflow goal` is the workflow entry
point: you author the bounded action program and the kernel — Bullswarm's own
runtime, not an agent — executes it to the end. `--lane analyze` tags the
work as read-only analysis; the other lanes are `build` (edits) and `chore`
(mechanical edits). For agents, `/bullswarm` (or `$bullswarm` where skills
use that syntax) reads the packaged skill and goes straight to one of those
two. The calling agent decides the shape itself from the request — one
bounded outcome takes `run`, parallel territories, integration, or
independent acceptance take `workflow goal`. There is no preview, classifier,
or dispatcher command between them.

Every command and nested subcommand supports contextual `-h` / `--help`
without initializing state or executing the command:

```bash
bullswarm --help
bullswarm workflow goal --help
bullswarm workflow runs show --help
```

`workflow goal` launches a durable background runner, prints operating commands,
and returns by default. Add `--watch` to immediately follow low-noise progress
until terminal, or `--foreground` to keep execution owned by the initiating
terminal. Open the unified workflow home with bare `bullswarm workflow`, or
jump directly to one run with `bullswarm workflow tui <shortId>`. The default
detail view is a human timeline with Live agents and a plain-language Next
line; `v` reveals technical state. Wide terminals use a workflow sidebar plus
detail pane, while narrow/mobile terminals show one pane at a time. `q`
detaches safely.

## Verbs

| Verb | Purpose |
|---|---|
| `setup` | Discover installed agent CLIs, show quota state, toggle pools, suggest a routing table, write config. Approval-gated, idempotent. |
| `integrate` | Register or remove the canonical Bullswarm skill and global awareness rules for Codex, Claude, and Grok. |
| `run` | route → dispatch → watch → verify → one JSON verdict |
| `health` | Re-judge saved outputs against their verdicts; surface verify-gate failures and quarantine clusters |
| `pools` | Show each pool's meter state, pace position, 5-hour utilization (`5h=<n>%`, flagged `NEAR-5H-LIMIT` at or above 75%), quarantine status |
| `strategy` | Interactive provider/model control center with live high/medium/low route previews and an agent-facing JSON API |
| `doctor` | Machine-readable readiness report; self-heals on first call |
| `workflow` | Plan, execute, observe, and operate one autonomous workflow engine and its live instances. |
| `runs` | Short alias for `workflow runs`, including list, show, result, and delete operations. |
| `version` / `--version` | Print the installed Bullswarm version. |
| `release` | Run the guarded local version-bump, commit, and tag workflow used before CI publishes to npm. |

A **pool** is one installed agent CLI, or one account of that CLI. `setup`
discovers them; `pools` shows their quota; routing picks among them at
dispatch time. See [Routing](./routing.md).

`workflow goal --request <path>` and `--run-id <id>` are internal detached-runner
resume plumbing. Normal callers should provide a goal or use `--resume <shortId|runId>`.

See [Routing](./routing.md) for how a pool is chosen, [Workflows](./workflows.md)
for how to author a program, and [Operations](./operations.md) for the verbs
that manage a run once it exists.
