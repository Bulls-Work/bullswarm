# bullswarm — Goal Statement

> Historical (2026-08-21): accurate when written; see CHANGELOG for what changed since.

**Status:** HISTORICAL PROTOTYPE CHARTER · **Owner:** cowcow02 · **Created:** 2026-08-21

## One sentence

A standalone CLI that lets *any* coding agent offload work to *any other* coding
agent CLI on the same machine — routing by lane, pacing by subscription meter,
and verifying by content — so no provider's quota expires unused and no agent's
"success" is taken at face value.

## Why this exists

Every agent CLI assumes it is the center of the universe. Multi-subscription
developers (Claude Max + Codex + Grok + …) watch quota expire on some pools
while others are exhausted mid-task, and every delegate CLI can exit 0 while
having done nothing. No existing router treats subscription windows as the
scheduling resource; proxy routers spend API credits instead of subscriptions;
prompt-policy layers can't compel dispatch. bullswarm sits *above* all agents as
the neutral coordinator vendors will never build.

## Outcome

A working prototype installed at `~/.bullswarm/` with:

1. **`bullswarm` CLI** with four verbs (`setup` detailed in #8):
   - `setup` — interactive front door: discover → enable → route → write
   - `run` — route → dispatch → watch → verify → one JSON verdict
     (`ok`, `keepOnClaude`, `why`, `pick.command`, `contentUsableDespiteExit`)
   - `health` — re-judge saved outputs against verdicts; surface gate failures
     and quarantine clusters after every round
   - `pools` — show each pool's meter state, pace position, quarantine status
2. **Connector registry** (`~/.bullswarm/connectors/*.json`): declarative per-CLI
   spawn command, auth-failure signatures, output extraction, verify contract,
   quirk fields (e.g. PWD resolution). Seeded with codex, grok,
   command-code, opencode2 — extracted from the proven `/offload` skill.
3. **Meter layer**: per-pool window definition (5h / weekly / none) with
   programmatic readers where providers expose usage, manual declaration
   (`--meter pool=window,pct`) where they don't. Unmetered pools pace as
   time-proportional and are labeled as such.
4. **Pacing brain**: time-adjusted pace (elapsed% − used%; most-behind wins),
   incumbency margin, cost guard (pace may only promote a cheaper pool),
   lanes by work nature (analyze/build/chore) — never a hard-coded lane→pool map.
5. **Verify gate**: content-based judgment ported intact from delegate-watch —
   exit code never trusted alone, announcement-vs-work splitting, failure
   patterns scoped to first 400 chars (whole text under 600), fixture suite
   green before any release.
6. **Recursion guard**: depth limit owned by the core; an offloaded agent that
   calls bullswarm cannot exceed configured depth.
7. **MCP server**: exposes `run`/`health`/`pools` so Claude Code, Codex, Cursor
   or any MCP client can offload without shell plumbing.
8. **Setup wizard as the front door**: bare `bullswarm` with no config (or
   `bullswarm setup`) launches an interactive guide that:
   - **discovers** installed agent CLIs (binary on PATH + config dir present +
     cheap auth probe — never credential entry), showing quota/burn-rate state
     per pool immediately; burn rate starts empty and is labeled "learning"
     until the decision log fills it;
   - lets the user **toggle which discovered pools to enable**;
   - **suggests a routing table** (lane → pool defaults from enabled pools)
     presented as an editable artifact, not a questionnaire;
   - writes `~/.bullswarm/` config + connectors, idempotent and re-runnable
     (`bullswarm setup` repairs);
   - can generate an agent-facing integration block for CLAUDE.md / AGENTS.md,
     shown as a diff with explicit approval before any write, delimited by
     versioned `bullswarm:begin/end` markers (pilotfish pattern);
   - a thin companion skill (`bullswarm-setup`) ships alongside so agents can
     recommend running `/bullswarm:setup` to users — the skill nudges, the CLI
     owns the flow.

## Success proofs

The prototype is done when ALL hold:

- [x] `bullswarm run --lane analyze --add-dir <repo> --task-file t.md --json`
      returns a verdict whose shape matches the delegate-watch contract, using
      a real pool, end to end, on this machine.
- [x] The verify gate passes its full fixture suite (≥17 fixtures:
      true failures AND real outputs) unchanged in behavior vs. `/offload`.
- [x] `bullswarm pools` reflects a manually declared meter change within one
      run, and pace ordering flips the pick when a pool crosses the margin.
- [x] A wrong-repo scenario (stale PWD) produces a correct-repo dispatch for
      every connector whose quirk field declares it.
- [x] `bullswarm health` flags a planted FAILED-verdict-but-good-output case
      and a two-quarantine cluster.
- [x] An MCP client (Claude Code) completes one offload round via the MCP
      server with zero shell commands.
- [x] Recursion guard stops a self-calling delegate at the configured depth.
- [x] Bare `bullswarm` on a machine with no `~/.bullswarm/` launches the
      wizard; discovery lists at least the four seeded connectors with correct
      found/not-found status, and completing it produces a working `run`.
- [x] The wizard's CLAUDE.md/AGENTS.md integration step shows a diff and
      writes nothing without explicit approval; re-running setup is idempotent
      (no duplicate marker blocks).
- [x] `bullswarm setup` on an already-configured machine reports current state
      and repairs a deliberately broken connector file.

## Invariants

- Judge by CONTENT, not exit code. A non-zero exit is never a success;
  `ok:true` requires passing verification.
- Never hard-code lane→pool mappings; pools serve lanes only via runtime
  selection over declared capability.
- Delegate output is input to verify, never the answer. Final synthesis,
  architecture decisions, and anything needing live conversation context stay
  with the caller.
- Quarantine must have a re-probe path; a recovered pool must return to
  service automatically (this fixes the known `/offload` gap).
- Connector quirks live in connector files, never in core logic.
- Stealth/retention-hostile models are opt-in per connector, flagged in the
  registry, never defaults.

## Non-goals (prototype)

- No hosted service, no daemon required for basic operation.
- No per-host hook integrations beyond MCP.
- No measured routing table yet (smart-router-style pass@k benchmarking is
  post-prototype).
- No savings ledger yet (post-prototype).
- Windows support deferred; macOS/Linux first.

## Authority envelope

Build freely inside `~/Repo/bullswarm`. Installing to `~/.bullswarm/` and
reading existing `~/.claude/skills/offload/*` sources for extraction is
authorized. Do NOT modify the live `/offload` skill during extraction — copy,
never move. No publishing (npm/GitHub push) without explicit instruction.

## Provenance

Extracted from the working `/offload` system (~/.claude/skills/offload/):
delegate-route.mjs (routing brain), delegate-watch.mjs (verify+watch),
delegate-health.mjs (re-judging), SKILL.md (operational doctrine). The four
2026-08-21 failure modes (wrong-repo silence, three verify-gate bugs, invisible
workflow health, exit-1-after-success) are the regression baseline this
prototype must never reintroduce.
