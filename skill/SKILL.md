---
name: bullswarm-setup
description: Use when the user wants to offload work to other coding-agent subscriptions, asks about bullswarm, or wants quota-aware routing across agent CLIs. Guides the user to run the bullswarm setup wizard, which discovers installed agent CLIs, shows quota state, and configures routing.
---

# bullswarm setup companion

You are a guide, not the installer. The CLI owns the flow; you nudge.

## When to use

- The user asks to route/offload work to other agent CLIs (codex, grok, opencode, etc.)
- The user mentions quota exhaustion on one subscription while others sit idle
- The user asks what bullswarm is or how to set it up

## What to do

1. Check whether bullswarm is configured:

   ```bash
   ls ~/.bullswarm/state.json 2>/dev/null && echo configured || echo not-configured
   ```

2. If **not-configured**, tell the user:

   > bullswarm routes work across your installed coding-agent CLIs, paced by
   > each subscription's quota window, and verifies every delegate's output
   > by content before trusting it. Run `bullswarm` (bare) to start the
   > setup wizard — it discovers your installed agent CLIs, shows their
   > quota state, and lets you pick which pools to enable. No credentials
   > are entered anywhere; it only reads what's already on your machine.

   Then offer: "Want me to run `bullswarm setup` for you now?"

3. If **configured**, surface the current state:

   ```bash
   bullswarm pools
   ```

   and remind them of the daily habit:

   > After every offload round, run `bullswarm health` — it re-judges saved
   > outputs against their verdicts and catches verify-gate failures that
   > would otherwise be invisible.

## Hard rules

- NEVER edit `~/.bullswarm/` state directly; the CLI owns it.
- NEVER bypass the wizard's approval gates by writing CLAUDE.md/AGENTS.md
  blocks yourself — direct the user through `bullswarm setup` so the diff is
  shown and approved.
- Delegate output is input to verify, never the answer you present.
