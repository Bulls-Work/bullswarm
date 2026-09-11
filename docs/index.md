---
layout: home
title: Bullswarm
titleTemplate: Route coding work by quota. Verify it by content.
description: Bullswarm routes a bounded coding task to whichever installed agent CLI has unused subscription quota, then verifies the result by its content.

hero:
  name: Bullswarm
  text: Route coding work by quota. Verify it by content.
  tagline: Bullswarm is a CLI that sends a coding task to whichever of your installed agent CLIs — Claude Code, Codex, Grok, OpenCode, or Command Code — currently has unused subscription quota, then checks the result by its content.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Concepts
      link: /guide/concepts
    - theme: alt
      text: CLI reference
      link: /reference/cli

features:
  - title: Quota-paced routing across pools
    details: A pool is one installed agent CLI, or one account of that CLI. Work is tagged by lane — analyze, build, or chore — and the pool furthest behind its own quota pace wins. A pool at its 5-hour ceiling yields to one with headroom, and a pool whose weekly window is about to reset gets priority for its remaining surplus, so quota never runs out the clock unspent.
  - title: Verdict by content, never exit code
    details: Every delegate's output is evidence to be verified, never an authority to be trusted on its word. A non-zero exit is never success on its own — the JSON verdict's ok, why, and contentUsableDespiteExit say what was actually written before you re-run anything.
  - title: Workflows you author, with independent acceptance
    details: One agent planning and judging its own serial work leaves every other pool idle and multiplies the risk. You author the program; the kernel validates and runs the graph of dependent actions across whichever pools have quota to spare, and computes completion from evidence the graph itself required.
  - title: Works inside Claude Code, Codex and Grok
    details: The packaged bullswarm skill goes straight to bullswarm run or bullswarm workflow goal from the agent CLI you are already in — no separate preview or classifier command to learn first.

## Documentation

- [Cost and usage](/guide/cost) — the measured, transcript, estimated, and unknown bases behind token and subscription figures.
- [CLI reference](/reference/cli) — every command, including workflow repricing.
- [Result envelope](/reference/result) — the JSON fields for per-step and total cost.
---
