---
title: Observing runs
description: Follow a live Bullswarm run without polling, list and inspect past runs, read the result, and use the full-screen dashboard.
---

# Observing runs

After this page you can follow a live run without polling in a loop, list and inspect runs by id, read a finished run's result, use the dashboard and its keys, and fix a terminal that cannot draw the status glyphs.

## The dashboard

The dashboard is Bullswarm's main screen once setup is complete. Bare
`bullswarm` opens Home; `bullswarm --setup` or `bullswarm setup` opens setup;
`bullswarm workflow tui` is the explicit dashboard command. Pass a run id to
open that run directly.

```bash
# the main screen after setup
bullswarm

# return to the setup control centre
bullswarm --setup
bullswarm setup

# explicit dashboard forms
bullswarm workflow tui
bullswarm workflow tui ab12cd
```

Every page has a sticky header and a sticky bottom nav. The tab row opens the
page directly; the nav keeps run buttons and the narrow-layout `[Top] [End]
[Help]` tail visible. A long body shows its `first–last/total` row window
while it scrolls. The dashboard's Help page (`?`) prints the same page and key
map.

The pages answer different questions:

| Page | What it answers |
| --- | --- |
| **Home** | What happened today, what is verified, what API-equivalent/licence figures are available, and which workflows are active or recent? It also shows the period breakdown by pool, model, and project. |
| **Runs** | Which workflows are active or in the catalogue, and where are the integration and command actions? `/` filters, `a` switches active/all, and `i` installs the agent integration. |
| **Run** | Where is this workflow in its plan, which workers are live or next, and what are the current ETA and measured budget shares? |
| **Step** | What is this action doing — its model, reasoning, route, attempt, activity, verdict or failure, prompt, usage, events, output, and artifact paths? |
| **Budget** | What does each pool's quota window report, how much measured worker time is workflows versus rest, what money is measured or labelled, how many median runs fit, and which workflows used the most worker-minutes? |
| **Stats** | How do runs, spend, worker-minutes, and verification trend over 7 days, 30 days, or all time, broken down by pool, model, and project? Its sub-tabs are Overview, Trends, Pools, Models, and Projects. |
| **History** | Which workflows started or finished on each recorded date, with verification, duration, and measured or labelled spend; legacy rows are read-only and carry no figures. |
| **Fleet** | Which model and reasoning rung each pool uses by lane or provider, its run record and meter state, and where to open setup for edits. |
| **Help** | What every key, click, layout rule, and dashboard command does. |

The visual-fidelity pass keeps the same real data but composes it like the
approved prototype. `Home` puts its 7-day breakdown in four columns and adds a
`budget · this week` block; `Run` shows the plan strip with per-step bars and a
`budget` / `live` / `so far` band (stacked on the phone); `Budget` gives each
pool a seven-row block and one consolidated footer; `Stats` → `Trends` uses
coloured stacked columns; and `History` uses fixed columns. At 55 columns the
phone layouts keep one row per item — every `Home` today tile and per-step bar,
every `Stats` `Models` model, `Stats` `Projects` project and its sparkline,
every `Stats` `Pools` and `Fleet` pool row, and every `History` run row — rather
than wrapping an item into a second form. Three places deliberately keep more
than one row: `Budget`'s seven-row pool block, `Home`'s `budget · this week`
pool, which carries its reset line under the meter as the prototype frame does,
and the `Runs` list, which keeps a worker-count line and a phase line under each
run. `Stats` `Pools` charts licence per day with a reset mark instead of
repeating full-width rows, and at 200 columns every page composes to the frame
rather than staying at the 120-column composition — measured on the real binary,
the widest painted row is 200 cells on every page except `Fleet`, which reaches
188.

The shared keyboard table is:

| Key | Does |
| --- | --- |
| `r` | open Runs; the view refreshes itself, so `r` is no longer refresh |
| `b` | open Budget; it is no longer move-out |
| `s` | open Stats |
| `y` | open History, except that it confirms a pending stop |
| `f` | open Fleet |
| `h` / `?` | open Help |
| `1`–`9` | open that run from the nav |
| `Tab` | cycle the current page's sub-tabs (Stats and Fleet) |
| `Shift+Tab` | cycle workflows |
| `p` | cycle the page period (Home and Stats) |
| `Esc` / `←` | move out one page, then return to Home |
| `↑`/`k`, `↓`/`j` | move one line up or down |
| `Enter` / `→` / `l` | open the selected run, step, tab, or action |
| `PgUp` / `PgDn` | scroll up or down one screen |
| `Home` / `End` | jump to the top or bottom |
| `ctrl+s` | copy the screen through OSC 52, falling back to `pbcopy`, `wl-copy`, or `xclip` |
| `q` | quit the dashboard; workflows keep running |

Page-specific controls include `/` (filter), `a` (active/all), and `i`
(install) on Runs; `o`, `v`, and `t` on Run; and `e` on Fleet to open setup.
`c` requests a cooperative stop from Run, and `y` confirms it. Mouse reporting
is enabled while the dashboard is open: click any tab, tile, bar, run, step,
date, or control, and use the wheel to scroll the body.

::: tip
`r`, `b`, and `Tab` were rebound in 0.33.0: the view refreshes itself, Esc and
the left arrow move out, and Shift+Tab still cycles workflows. `q` quits the
dashboard and leaves the run going; only `c` stops it, and that asks the kernel
for a cooperative stop at its next safe checkpoint.
:::

## The history index and `workflow reindex`

Home, Budget, Stats, and History read a per-run rollup, written to
`<run dir>/rollup.json` when a run finishes and appended to the history index
at `~/.bullswarm/history/runs.jsonl`. Nothing rescans every run directory on
each frame. Runs finished before 0.33.0 have no rollup yet, so a freshly
upgraded home shows `no run has been rolled up yet · bullswarm workflow
reindex backfills them` until you run it once:

```bash
bullswarm workflow reindex
```

Legacy runs with no V2 state get a minimal record marked legacy; only runs
still in flight are skipped. The command is idempotent, so a second run
writes nothing new, and `--force` rewrites every record. See
[`workflow reindex`](/reference/cli#reindex) for the flags and the JSON it prints.

Budget's meter cells use the shared green (`#b6bd73`), amber (`#e9c880`), red
(`#bf6c69`), and dark-track (`#3a3a3a`) palette. The other shared roles are
`purple`, `orange`, `cyan`, `dim`, `others`, and a four-shade `heat` ramp. A
white `▏` marks elapsed time. Money and licence figures are measured when their
source supports it; otherwise they are blank or carry `≈` with their basis.
The Fleet `[edit]` action hands the terminal to setup and returns with fresh
data. Runs' `[install]` runs the same as `bullswarm integrate install --yes`;
once every agent is installed it reads `[installed ✓]` and is inert.

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

## The Claude Mod counterpart

Inside Claude Code, the Bullswarm mod (`mods/bullswarm`) is the dashboard's
read-only counterpart. Its pane shows **Run**, **Step**, and the **Usage/Pools**
page (meter windows and fleet rungs); it does not show **Home**, **Runs**,
**Budget**, **Stats**, **History**, **Fleet**, or **Help** as dashboard pages.
The strip remains the run list. The pane's bottom row is `back` (on a step), the
run buttons, `usage` and `close`, with no dashboard `[edit]` or `[install]`
actions. Its strip and pane re-read ongoing runs every 20 seconds; the full
details are in [Claude Code integration](/integrations/claude-code).


## Next steps

- [Workflows](/guide/workflows) — author the program a run executes.
- [Result envelope](/reference/result) — every field of the result document.
- [Claude Code integration](/integrations/claude-code) — the packaged skill, the MCP server, and the mod pane.
