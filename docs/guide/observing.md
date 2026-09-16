---
title: Observing runs
description: Follow a live Bullswarm run without polling, list and inspect past runs, read the result, and use the interactive workflow dashboard.
---

# Observing runs

After this page you can follow a live run without polling in a loop, list and inspect runs by id, read a finished run's result, use the interactive dashboard and its keys, and fix a terminal that cannot draw the status glyphs.

## Watch prints only events

`workflow watch` prints one attach line, then one line per notable event — an action finishing, failing, blocking or being cancelled, evidence recorded, a stage completed, a planner turn, a stall or recovery, cancellation — and stays silent while work is merely in progress. That silence is the signal: no line means nothing has happened that needs you.

```bash
# follow one run until it pauses or reaches a terminal status
bullswarm workflow watch ab12cd

# also print agent starts, mechanical retries, and steering delivery
bullswarm workflow watch ab12cd --verbose
```

A usage-limit failure prints whether or not `--verbose` is given: a `⚠ <actionId> usage limit on <pool>` line with the pause deadline, then a `↺ <actionId> now on <pool> · <model>` line once the retry lands on another pool.

## Wake on the next event

Use `--next` when the caller is an agent that should sleep until something happens, instead of holding a follower open. It prints no attach line, exits after the first notable event, and — while the run continues — ends with the line to relaunch from.

```bash
# print the next notable event and exit
bullswarm workflow watch ab12cd --next

# the relaunch: copy --after and --since verbatim from the previous next: line
bullswarm workflow watch ab12cd --next --after 42 --since 2026-09-08T10:15:00.000Z
```

Both values matter. `--after` resumes from the durable event sequence the previous watcher consumed, so events committed while nothing was attached are printed instead of skipped; `--since` is that watcher's exit time, so an agent whose silence it already reported does not produce a duplicate stall line.

Exit 0 while the run continues or when it delivered; exit 1 when it ended without delivering or no kernel is running. A pause or a terminal status exits immediately with its own `outcome:` and `next:` lines instead of a relaunch line.

## Watch options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--next` | print no attach line; exit after the first notable event | off (follows until terminal or paused) |
| `--after <sequence>` | start from this durable event sequence instead of the current high-water mark | attach at the high-water mark |
| `--since <iso-timestamp>` | the previous watcher's exit time, so an already-reported stall is not repeated | report every silent agent at attach |
| `--jsonl` | one JSON object per event, each carrying its `sequence`, and no relaunch line | off (human text) |
| `--once` | print one current snapshot and exit | off |
| `--verbose` | include started, retry, and steering-delivered lines | off |
| `--stall-after <seconds>` | report a running agent as silent after this long without activity | 300 |
| `--heartbeat <seconds>` | periodic line when nothing has changed; opt-in for event mode | off (60 with `--classic`) |
| `--classic` | the older heartbeat-based watcher instead of event mode | off |
| `--interval <seconds>` | poll interval | 2 |

Watching is read-only, and it never dispatches anything. `--classic` applies only to current-engine runs and cannot combine with `--next`.

## List and inspect runs

```bash
# ongoing runs only, the default listing
bullswarm workflow runs

# ongoing plus historical, filtered by exact goal text
bullswarm workflow runs --all --name audit-code

# runs initiated in the last week
bullswarm workflow runs --all --since 7d

# one run's durable state: status, requirements, actions, and attempts
bullswarm workflow runs show ab12cd
```

Every run has a 6-character shortId (no `0`, `1`, `i`, `l`, or `o`); the full `wf-…` runId is the durable handle, and both work anywhere an id is accepted. Time filters compare when a run was initiated and accept ISO timestamps, local `YYYY-MM-DD` dates, `today`, `yesterday`, `now`, or durations such as `30m`, `24h`, `7d`, and `2w`. Historical authored-graph runs appear as read-only `legacy` rows, and every driving command refuses them with exit 2.

## Read the result

```bash
# the compact status-loop envelope: status, verified, reason, actions, usage, next
bullswarm workflow runs result ab12cd --json --summary

# the full versioned document, for a failed or partial run or before judging evidence
bullswarm workflow runs result ab12cd --json
```

`--summary` implies `--json` and is the form to poll with; read the full envelope when something failed or before you judge evidence. `next.runDir` and each action's `outFile` point at the durable artifacts, and `workflow runs show` remains the low-level debugging surface.

## Inspect one action

```bash
# one action's ledger entry, every attempt, its output, and its events
bullswarm workflow action show ab12cd write-a

# replay the durable event log after a sequence cursor
bullswarm workflow events ab12cd --after 0
```

`action show` names the action's `outputFile` — read it before deciding the rest of the plan still fits. `events` is the machine-oriented replay; page through it by passing the last returned `sequence` to `--after`.

## The interactive dashboard

```bash
# the workflow home: active and recent runs with a live preview
bullswarm workflow

# open one run's detail view directly
bullswarm workflow tui ab12cd
```

The detail view is a timestamped timeline — Preflight, planner checkpoints, level transitions, worker results — above two live sections. **Live** shows the waiting or running work with each agent's latest action and stream heartbeat; **Next** holds planned work that has not started, kept separate so it cannot be mistaken for execution evidence. Below 100 columns the view opens on a full-width timeline.

| Key | Does |
| --- | --- |
| `j` / `k`, arrows | move the selection |
| `Enter` | open the selection: timeline to agents to activity |
| `Esc` | move back out |
| `o` | the planner overview: what it is doing now, its latest decision, and why |
| `v` | technical state; from the planner, provider session, usage, and artifact paths |
| `t` | below 100 columns, toggle Timeline and Phases |
| `/` , `a` | filter the run list; switch between active and all runs |
| `Tab` / `Shift+Tab` | switch runs |
| `c` | request a confirmed cooperative stop |
| `r` | refresh |
| `q` | detach — the workflow keeps running |

::: tip
`q` detaches and leaves the run going; only `c` stops it, and that asks the kernel for a cooperative stop at its next safe checkpoint.
:::

## One frame for a caller

```bash
# one plain-text frame (timeline, Live, Next) with no escape codes, for embedding
bullswarm workflow tui ab12cd --overview --width 90 --height 24

# the run list as JSON, ongoing plus historical
bullswarm workflow tui --json --all

# one run's state, report, and events as JSON
bullswarm workflow tui --json ab12cd
```

These are the non-interactive forms. Without a TTY, `workflow tui <runId>` prints one static text tree instead of opening the browser, so a caller that only needs the current picture still gets it.

## Glyphs in your terminal

The live views draw a Braille spinner and symbol marks (`●`, `✓`, `✗`, `⧖`, `⚠`). macOS Terminal.app ships no monospace font that can draw the spinner or `⧖`, so those cells repaint as flashing `?` — the terminal cannot tell Bullswarm which font is loaded.

Apple Terminal is detected and given a one-column ASCII table instead; a non-UTF-8 locale, `TERM=dumb`, and `TERM=linux` also select ASCII. Override the detection either way:

```bash
# force ASCII when your terminal shows ? for the glyphs
BULLSWARM_ASCII=1 bullswarm workflow

# force Unicode when the detection guessed wrong
BULLSWARM_UNICODE=1 bullswarm workflow
```

## The Claude Mod pane

Inside Claude Code, the Bullswarm mod (`mods/bullswarm`) adds a strip above the prompt with one row per ongoing run; a digit in front of a row, or `[w]`, opens a pane docked beside the transcript. The pane draws the same overview as `workflow tui <id> --overview` — Preflight, every dependency level, Live workers with their latest activity, and Next — and re-reads it every 20 seconds while the run is in flight. `q` closes the pane, `r` re-reads, and a digit switches runs.

Installation and the mod's other hooks are covered in [Claude Code integration](/integrations/claude-code).

## Next steps

- [Workflows](/guide/workflows) — author the program a run executes.
- [Result envelope](/reference/result) — every field of the result document.
- [Claude Code integration](/integrations/claude-code) — the packaged skill, the MCP server, and the mod pane.
