---
title: The doctrine and the verdict
permalink: /guide/doctrine/
---

## The doctrine (non-negotiable)

A **pool** is one installed agent CLI, or one account of that CLI. A **lane**
is the nature of the work: `analyze` (read-only), `build` (edits), or
`chore` (mechanical edits). The **kernel** is Bullswarm's own runtime, not an
agent.

1. **Judge by CONTENT, not exit code.** Every delegate CLI can exit 0 while
   having done nothing. A non-zero exit is never a success. After a dispatch,
   `ok:true` requires passing verification (see the verdict shape below).
2. **Pace by meter.** The scheduling resource is the subscription window:
   elapsed% minus used%, most-behind pool wins. Pace may only promote a
   *cheaper* pool. Lanes are work-nature, never hard-coded to pools. Which
   window paces one pool is the subscription window that pool's connector
   declares (`quotaWindow`: weekly for claude-code, codex and grok; monthly
   for command-code and the relay pools), overridable per pool with
   `bullswarm strategy set-subscription <pool> --quota-window <weekly|monthly>`
   — `bullswarm pools` names it in the meter column. The
   5-hour window never paces — it gates. A pool whose 5-hour forecast is at
   or above 75% *and* ahead of the share of that window already elapsed is
   chosen only when no eligible pool below that line exists; a pool whose
   forecast is at or above 90% is not dispatched at all. The 90% burst gate
   ignores the clock.
3. **Delegate output is evidence, never authority.** The Workflow Planner may
   propose actions, but only the deterministic kernel validates the program,
   accepts requirement-scoped evidence, and computes completion.
4. **Quarantine re-probes.** A benched pool must be able to return to service
   automatically; a lane is never allowed to silently go down. A pool benched
   for a usage limit waits for the reset the provider named, not a flat
   guess — and never longer.

The full routing mechanics behind rules 2 and 4 — pace, 5-hour headroom,
expiring-soon urgency, in-flight load, and quarantine — are gathered in
[Routing](./routing.md).

## The verdict

```json
{
  "ok": true,
  "keepOnClaude": false,
  "why": "verified",
  "pick": { "pool": "grok", "command": ["grok", "-p", "..."] },
  "contentUsableDespiteExit": false,
  "outFile": "/tmp/dlg.out"
}
```

- `keepOnClaude: true` — router says do it in-session; nothing ran (`ok` is
  also true in this case, but there is no `outFile` to read)
- `ok: true` and `keepOnClaude: false` — verified output, read the file
- `ok: false` — `why` names the failed gate
- `contentUsableDespiteExit: true` — non-zero exit but complete output; read
  before re-running
