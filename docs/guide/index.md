---
title: Introduction
description: What Bullswarm is, the two ways to start work, and the four rules it never breaks.
---

# Introduction

By the end of this page you will know what Bullswarm does, which of its two starting commands fits the work in front of you, and the four rules that decide how it behaves.

## What Bullswarm is

Bullswarm is a CLI that sends a coding task to whichever of your installed agent CLIs — Claude Code, Codex, Grok, OpenCode, or Command Code — has the most unspent subscription quota right now. It waits for that delegate to finish and then judges the saved output by its content, never by its exit code. It runs on Node.js 22.12 or later and is installed with `npm i -g bullswarm`.

## Two ways to start work

There are exactly two entry points, and you choose the shape yourself — there is no preview or classifier step between them. `bullswarm run` sends one bounded task to one delegate and prints one verdict. `bullswarm workflow goal` executes a program you author across several pools.

```bash
# one bounded outcome: route, dispatch, verify, print one verdict
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json

# several dependent steps: you author plan.json, the kernel executes it
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --program plan.json
```

Use `run` when the work ends in one answer you could describe in a paragraph. Use `workflow goal` when it has parallel territories, an integration step, or acceptance you want judged on its own — see [Workflows](/guide/workflows).

## The four rules

These are the non-negotiable rules the rest of the tool is built on. Everything else on this site follows from them.

- **Content decides, never the exit code.** Every delegate CLI can exit 0 having done nothing, and a non-zero exit is never called success on its own. After a dispatch, `ok: true` means the saved output passed verification.
- **Quota pace picks the pool.** Surplus is `elapsed% − used%` of a pool's own subscription window, and the pool furthest behind its pace wins, because unused quota expires with the clock. Lanes describe the work, never a fixed lane-to-pool map.
- **Delegate output is evidence, not authority.** A delegate can propose; only the kernel — Bullswarm's own runtime, not an agent — validates a program, accepts evidence, and computes completion.
- **Quarantine always lifts.** A pool benched for a usage limit comes back at the reset the provider named, then re-probes on its own; a lane never stays down because one pool is out.

## Where to go next

| Page | What you get |
|---|---|
| [Getting started](/guide/getting-started) | Install, verify readiness, and read your first verdict |
| [Concepts](/guide/concepts) | Pools, lanes, surplus, windows, verdicts, quarantine |
| [Run one task](/guide/run) | Every `run` option, and what each verdict means |
| [Routing](/guide/routing) | The order in which a pool is picked, with the numbers |
| [Workflows](/guide/workflows) | Authoring the program that `workflow goal` executes |

For the CLI surface itself, [CLI reference](/reference/cli) lists every verb and nested subcommand.

## Next steps

- [Getting started](/guide/getting-started) — install Bullswarm and complete one run.
- [Concepts](/guide/concepts) — the vocabulary every other page assumes.
- [Run one task](/guide/run) — the full `bullswarm run` surface.
