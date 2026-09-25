---
title: Concepts
description: The vocabulary Bullswarm uses — pools, lanes, surplus, windows, verdicts, quarantine, and run files.
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

Every pool has a **pacing window** — weekly or monthly, declared by its connector — and a **5-hour window**. Only the pacing window chooses who wins. The 5-hour window is a gate: at or above 75% it deprioritizes the pool, at or above 90% the pool is not dispatched at all, and a pool with no 5-hour reading counts as having headroom. See [Routing](/guide/routing) for the clock-relative rule behind the 75%.

## Verdict

A run ends with one **verdict** object. `ok` says whether the saved output passed the verify gate, `why` names the gate that decided it, and `keepOnClaude: true` means nothing ran because the router kept the task on the calling agent. `contentUsableDespiteExit: true` is the case where the process exited non-zero but the content still passed — read it before re-running. [Run one task](/guide/run) walks through every field.

## Quarantine

A **pause** (quarantine) takes a pool out of service after a failure instead of retrying it blind. A limit notice pauses a pool for quota only on proof: the pool's own meter reads 95% or more on a running window (paused until that window resets), or the provider's line says a usage window is spent and names its reset (paused until that reset). Every other limit notice — `Rate limit exceeded`, `429 Too Many Requests`, an overload, a window phrase with no reset — never pauses the pool. In a workflow started by this version a window phrase with no reset is still a usage limit, so the step comes back to you, and a throttle (too many requests, no usage window spent) backs off on the same pool at most twice (20 s, then 60 s, or a named wait of at most 2 minutes) before it comes back to you too. Neither ever moves to another pool, for a step, the dispatched planner or the preflight scout. A single `bullswarm run` makes one attempt and exits 1 on either, with no retry. Only a workflow started by an earlier version gives them a short bounded same-pool retry, then another pool for that attempt only. An upstream auth failure pauses a pool for a flat 10 minutes. A paused pool is skipped by every later dispatch until its deadline, then re-probes automatically. `bullswarm pools` shows `PAUSED until <time> · <proof, provider line and meter reading> · lift now: bullswarm pools resume <pool>`; `bullswarm pools resume <pool>` lifts it at once, and `bullswarm strategy set-pausing off` turns every automatic pause off — quota, auth, and the credential-group siblings an auth pause benches with it, plus the soft bench a second strike writes; `pools` then opens with `automatic pausing: off`, routing still reads meters, and a crashed or signed-out attempt still moves to another pool. The switch decides only whether a pool is paused for other work: in a workflow started by this version a spent usage window still ends the step and comes back to you, on or off.

## The run directory

Each `bullswarm run` writes two files under `~/.bullswarm/runs/`: `task-<stamp>.md`, the prompt handed to the delegate, and `out-<stamp>.md`, the output it produced. The verdict's `taskFile` and `outFile` are those paths, and `bullswarm health` re-judges every saved `out-*` file against the verify gate later.

## Next steps

- [Run one task](/guide/run) — the options and the outcomes.
- [Routing](/guide/routing) — the order in which the numbers above are compared.
- [Workflows](/guide/workflows) — the same concepts applied to a multi-step program.
