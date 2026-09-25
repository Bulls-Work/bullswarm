---
title: Concepts
description: The vocabulary Bullswarm uses — pools, lanes, surplus, windows, verdicts, limits, and run files.
---

# Concepts

After this page you can read a `bullswarm pools` line or a verdict without guessing: each term below is defined where it first appears, in the order the tool uses it.

## Pool

A **pool** is one installed agent CLI, or one account of that CLI. Two Claude accounts are two pools, named `claude-code` and `claude-code:<home>`, and routing treats them as separate quota budgets. Pools come from provider plugins: `bullswarm provider list` shows what loaded, `bullswarm pools` shows what each one currently has left.

## Lane

A **lane** is the nature of the work, never a pool. `analyze` is read-only exploration, `build` is implementation that edits files, and `chore` is small mechanical edits. `bullswarm run` requires one with `--lane`, and the router picks among the pools whose connector declares that lane — there is no fixed lane-to-pool table.

## Role and deliverable

In a workflow program, a step's **role** says what it does — `investigate`, `produce`, `transform`, `combine`, `check` or `act` — and its **deliverable** says what it leaves behind: `files`, a `report`, `data` or `media` at exact paths, or `outward` actions such as a sent message. The role and deliverable set the step's lane and effort. A step whose declared deliverable was not produced fails as `not-produced`. Each kind (`implement`, `check`, …) belongs to one role and keeps its own routing. [Program format](/reference/program#roles-and-deliverables) has the tables.

## Evidence

**Evidence** is a command or schema check Bullswarm runs after a workflow
worker finishes. A passing check backs the step's `proven by command` or
`proven by schema` label. In new runs, a finished step without evidence reads
`proven by review` once a review passes every requirement it affects,
`review pending` while a review step still covers them, and
`finished · unproven` otherwise. Review remains a separate check step. A caller may accept a failed step or
failing requirement as `choice`; that records a decision, never proof.
[Program format](/reference/program#evidence-command-and-schema) explains the
check rules and result details.

## Quota pace and surplus

**Surplus** is `elapsed% − used%` for a pool's own subscription window, both numbers read from the provider's usage meter. A positive surplus means quota is piling up unspent, and quota that is not spent by the reset is lost — so the pool furthest behind its pace wins the lane. `bullswarm pools` prints it as `surplus=`.

## The two windows

Every pool has a **pacing window** — weekly or monthly, declared by its connector — and a **5-hour window**. Only the pacing window chooses who wins. The 5-hour window is a gate: at or above 75% it deprioritizes the pool when another eligible pool is behind pace, at 100% the pool is not dispatched at all, and a pool with no 5-hour reading counts as having headroom. Any metered window at 100% — 5-hour, weekly or monthly — keeps the pool out of every pick until that window resets. See [Routing](/guide/routing) for the clock-relative rule behind the 75%.

## Verdict

A run ends with one **verdict** object. `ok` says whether the saved output passed the verify gate, `why` names the gate that decided it, and `keepOnClaude: true` means nothing ran because the router kept the task on the calling agent. `contentUsableDespiteExit: true` is the case where the process exited non-zero but the content still passed — read it before re-running. [Run one task](/guide/run) walks through every field.

## Limits and failed pools

Bullswarm never remembers a spent or dead pool from one step to the next: nothing pauses or benches a pool. Each step, and each `bullswarm run`, routes on the live meters, so a window at 100% keeps a pool out until that window resets, and a pool that failed one step is a candidate for the next whenever its meters allow it.

A **usage limit** is a limit notice that says a usage window, a quota or a balance is spent (with or without a reset named), or a meter showing the window full. It goes to the caller: in a workflow started by this version the step comes back to you at once, with no wait, no move to another pool and no retry, and a single `bullswarm run` exits 1. The pool's meter is then read again at once, so the next pick sees a window it shows at 100%; when it cannot be read, the pool counts as full until its reset only when the provider named that reset or an earlier meter reading gave it. A **throttle** (too many requests, no usage window spent) backs off on the same pool at most twice (20 s, then 60 s, or a named wait of at most 2 minutes) before it comes back to you too. Neither ever moves to another pool, for a step, the dispatched planner or the preflight scout. Only a workflow started by an earlier version gives them a short bounded same-pool retry, then another pool for that attempt only.

A **sign-in failure** (failure kind `auth`) gets the step's one automatic retry on a pool that does not share the dead credential: every pool in the same credential group is skipped for the rest of that step. Nothing is stored, so a later step can pick that pool again.

## The run directory

Each `bullswarm run` writes three files under `~/.bullswarm/runs/`: `task-<stamp>.md`, the prompt handed to the delegate; `out-<stamp>.md`, the output it produced; and the CLI's raw capture — `stream-<stamp>.jsonl` for a CLI that streams JSON events, `stdout-<stamp>.log` for any other. The verdict's `taskFile` and `outFile` are the first two paths, and `bullswarm health` re-judges every saved `out-*` file against the verify gate later.

## Next steps

- [Run one task](/guide/run) — the options and the outcomes.
- [Routing](/guide/routing) — the order in which the numbers above are compared.
- [Workflows](/guide/workflows) — the same concepts applied to a multi-step program.
