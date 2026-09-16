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

## Quota pace and surplus

**Surplus** is `elapsed% − used%` for a pool's own subscription window, both numbers read from the provider's usage meter. A positive surplus means quota is piling up unspent, and quota that is not spent by the reset is lost — so the pool furthest behind its pace wins the lane. `bullswarm pools` prints it as `surplus=`.

## The two windows

Every pool has a **pacing window** — weekly or monthly, declared by its connector — and a **5-hour window**. Only the pacing window chooses who wins. The 5-hour window is a gate: at or above 75% it deprioritizes the pool, at or above 90% the pool is not dispatched at all, and a pool with no 5-hour reading counts as having headroom. See [Routing](/guide/routing) for the clock-relative rule behind the 75%.

## Verdict

A run ends with one **verdict** object. `ok` says whether the saved output passed the verify gate, `why` names the gate that decided it, and `keepOnClaude: true` means nothing ran because the router kept the task on the calling agent. `contentUsableDespiteExit: true` is the case where the process exited non-zero but the content still passed — read it before re-running. [Run one task](/guide/run) walks through every field.

## Quarantine

A **quarantine** benches a pool after a failure instead of retrying it blind. A usage limit benches it until the reset the provider named — falling back to the pool's cached 5-hour reset, then to 30 minutes — and an upstream auth failure benches it for a flat 10 minutes. A quarantined pool is skipped by every later dispatch until that deadline, then re-probes automatically, so a lane never stays down. `bullswarm pools` shows `QUARANTINED until <time> (<reason>)`.

## The run directory

Each `bullswarm run` writes two files under `~/.bullswarm/runs/`: `task-<stamp>.md`, the prompt handed to the delegate, and `out-<stamp>.md`, the output it produced. The verdict's `taskFile` and `outFile` are those paths, and `bullswarm health` re-judges every saved `out-*` file against the verify gate later.

## Next steps

- [Run one task](/guide/run) — the options and the outcomes.
- [Routing](/guide/routing) — the order in which the numbers above are compared.
- [Workflows](/guide/workflows) — the same concepts applied to a multi-step program.
