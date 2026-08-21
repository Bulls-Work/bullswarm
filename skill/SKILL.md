---
name: bullswarm-setup
description: Use when the user wants to offload work to other coding-agent subscriptions, asks about bullswarm, or wants quota-aware routing across agent CLIs. bullswarm is fully self-initializing — any agent can use it with no human setup.
---

# bullswarm agent guide

bullswarm routes bounded tasks to whichever coding-agent CLI subscription has
the most quota headroom, then verifies every delegate's output by content.
**It requires no human setup.** Every verb self-initializes on first use.

## Quick start (zero-touch)

```bash
# 1. Check readiness (also self-heals a missing config):
bullswarm doctor --json

# 2. See pools with live quota meters:
bullswarm pools

# 3. Offload a task:
bullswarm run --lane <analyze|build|chore> \
  --add-dir /abs/path/to/repo --task-file /abs/task.md --json

# 4. After every offload round:
bullswarm health
```

## Reading the verdict

- `ok:true` → read `outFile`; it passed content verification
- `keepOnClaude:true` → do it in-session; no pool could take it
- `ok:false` → `why` names the failed gate. `contentUsableDespiteExit:true`
  means the file is complete despite a non-zero exit — read before re-running.

## Rules for agents

- Delegate output is INPUT you verify, never the answer you present. Final
  synthesis, architecture decisions, and live-context work stay with you.
- Lanes are work nature: `analyze` (root-cause, review), `build`
  (implement, tests), `chore` (summarize, convert, smoke-check).
- Run `bullswarm health` after every round; investigate any `gateFailures`.
- Never edit `~/.bullswarm/state.json` directly; use the CLI.
- No TTY needed anywhere: every verb works in scripts and CI.

## Human customization (optional)

Humans can rerun `bullswarm setup` interactively to pick specific pools or
approve CLAUDE.md/AGENTS.md integration blocks. Agents should never do this
on the user's behalf without asking — but never *require* it either.
