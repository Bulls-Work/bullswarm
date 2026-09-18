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

Every page has a sticky header and a sticky bottom nav. The tab row is five
tabs — Home, Runs, Budget, Stats, Fleet — and opens the page directly; `Run`
and `Step` mark `Runs`, and `Help` appears in the row only while it is open.
The nav keeps run buttons and the narrow-layout `[Top] [End] [?.Help]` tail
visible. A long body shows its `first–last/total` row window
while it scrolls. The dashboard's Help page (`?`) prints the same page and key
map.

The pages answer different questions:

| Page | What it answers |
| --- | --- |
| **Home** | What happened today, what is verified, what API-equivalent/licence figures are available, and which workflows are active or recent? It also shows the period breakdown by pool, model, and project. |
| **Runs** | Which workflows are active or in the catalogue, in one `active` block above the History day table? `/` filters and `a` switches active/all; the agents and `run it` blocks moved to Help (`?`). |
| **Run** | Where is this workflow in its plan, which workers are live or next, and what are the current ETA and measured budget shares? |
| **Step** | What is this action doing — its model, reasoning, route, attempt, activity, verdict or failure, prompt, usage, events, output, and artifact paths? |
| **Budget** | What does each pool's quota window report, how much measured worker time is workflows versus rest, what money is measured or labelled, how many median runs fit, and which workflows used the most worker-minutes? |
| **Stats** | How do runs, spend, worker-minutes, and verification trend over 7 days, 30 days, or all time, broken down by pool, model, and project? Its sub-tabs are Overview, Trends, Pools, Models, and Projects. |
| **Fleet** | Which model and reasoning rung each pool uses by lane or provider, its run record and meter state, and where to open setup for edits. |
| **Help** | What every key, click, layout rule, and dashboard command does. |

The visual-fidelity pass keeps the same real data but composes it like the
approved prototype. `Home` puts its 7-day breakdown in four columns and adds a
`budget · this week` block; `Run` shows the plan strip with per-step bars and a
`budget` / `live` / `so far` band (stacked on the phone); `Budget` gives each
pool a header over four labelled rows (`used`, `by bullswarm`, `room`,
`so far`) and one consolidated footer; `Stats` → `Trends` uses coloured stacked
columns drawn to eighth-block precision; and the `Runs` history table uses
fixed columns. At 55 columns the phone layouts keep one row per item — every
`Home` today tile and per-step bar, every `Stats` `Models` model, `Stats`
`Projects` project and its sparkline, every `Stats` `Pools` and `Fleet` pool
row, and every run row in the `Runs` history table — rather than wrapping an
item into a second form. Three places deliberately keep more than one row:
`Budget`'s per-pool block, `Home`'s `budget · this week` pool, which carries its
reset line under the meter as the prototype frame does, and the `Runs`
`active` entry, which keeps a plan strip and a per-step bar under each run.
`Stats` `Pools` gives every pool its own seven-day sparkline on its own row,
with `▏` on a day the quota window rolled over, instead of one shared chart;
and at 200 columns every page composes to the frame rather than staying at the
120-column composition.

The shared keyboard table is:

| Key | Does |
| --- | --- |
| `r` | open Runs; the view refreshes itself, so `r` is no longer refresh |
| `b` | open Budget; it is no longer move-out |
| `s` | open Stats |
| `y` | open Runs at its History table (the first day header), except that it confirms a pending stop |
| `f` | open Fleet |
| `h` | open Home |
| `?` | open Help |
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
date, or control, and use the wheel to scroll the body. The row or button
under the pointer lights up in reverse video, so you can see what a click
will open before you click.

::: tip
`r`, `b`, `Tab`, and `h` were rebound in 0.33.0: the view refreshes itself, Esc
and the left arrow move out, Shift+Tab still cycles workflows, and `h` opens
Home (`?` alone opens Help; in 0.32.0 both keys opened Help). `q` quits the
dashboard and leaves the run going; only `c` stops it, and that asks the kernel
for a cooperative stop at its next safe checkpoint.
:::

## The history index and `workflow reindex`

Home, Runs, Budget, and Stats read a per-run rollup, written to
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

## What one attempt leaves on disk

Every attempt writes its normalized event stream into the run directory
(`~/.bullswarm/workflows/<runId>/`, or `$BULLSWARM_HOME/workflows/<runId>/`)
next to its task and output files:

| File | Written when |
| --- | --- |
| `task-<action>-attempt-<n>.md` | the task text the attempt was handed |
| `out-<action>-attempt-<n>.md` | its final answer, or the partial text a stalled worker left |
| `stream-<action>-attempt-<n>.jsonl` | the connector declares an `eventStream` |
| `stdout-<action>-attempt-<n>.log` | it does not: a bounded plain tail instead |
| `diff-<action>-attempt-<n>.txt` | `git diff --stat` of the step's territory, taken the moment the worker exited |

The stream is one JSON object per line with `seq`, `at` (ISO, stamped by the
kernel, not by the provider), `source`, `providerType`, `kind`, `status`, and
`summary`. A `response` event keeps its text here up to `responseBytes` — the
live pane's 180-character clip is a display choice, not the record:

```json
{"seq":1,"at":"2026-09-17T08:30:46.101Z","source":"stdout","providerType":"item.started","kind":"command_execution","status":"running","summary":"ls src/workflow"}
{"seq":3,"at":"2026-09-17T08:30:46.102Z","source":"stdout","providerType":"item.completed","kind":"response","status":"completed","summary":"Read the task file and enumerated 3 candidate files."}
{"seq":7,"at":"2026-09-17T08:30:46.102Z","source":"stdout","providerType":"item.completed","kind":"response","status":"completed","summary":"## Partial\n\nRead the task file and enumerated 3 candidate files before going quiet."}
```

The JSONL stream is bounded as a head, then one
`{"truncated":true,"dropped":<n>}` marker line, then a tail. The fallback for
a connector with no `eventStream` is different: `stdout-…-attempt-….log` is a
marker-free bounded plain tail. Core allows 1048576 bytes per file and 64000
bytes per `response` event; a connector may raise or lower either in its
`eventStream.capture` block (see [providers](../reference/providers.md)).

The sink appends head records synchronously. Once a cap is exceeded, its
in-memory tail is flushed to the sibling `.tail` segment every 32 events or
2 seconds, whichever comes first; `close()` folds the head, marker, and tail
back into the final JSONL file (or the marker-free stdout tail). If the kernel
is killed outright (`SIGKILL`) the head records are already on disk and the
final file holds them; whatever the tail segment had flushed stays in the
orphan `.tail` sibling, which nothing reads back or folds in, and the events
still in memory are lost.

`action show` reports the paths and the byte counts on every attempt, failed
ones included, plus `handoff` on an attempt that inherited a predecessor:

```json
{
  "id": "edit-owned-1", "ordinal": 1, "pool": "staller", "status": "interrupted",
  "failureKind": "stalled",
  "outputFile": ".../out-edit-owned-attempt-1.md", "outputBytes": 83,
  "streamFile": ".../stream-edit-owned-attempt-1.jsonl",
  "diffFile": ".../diff-edit-owned-attempt-1.txt", "changedFileCount": 1,
  "lastResponse": "## Partial\n\nRead the task file and enumerated 3 candidate files before going quiet."
}
{
  "id": "edit-owned-2", "ordinal": 2, "pool": "answerer", "status": "succeeded",
  "handoff": { "from": "edit-owned-1", "bytes": 1108 }
}
```

`handoff.bytes` is the size of the block the attempt was handed; it varies
with the run directory's path length, so the figure above is one measurement,
not a constant.

## The next attempt is told what the last one did

When an attempt ends without success and the step is retried — on another pool
or the same one — the task the next worker receives ends with a
`## Prior attempt on this step` block built from those files. (The bounded
schema-correction path keeps its own block and never gets this one.) A real
block, from a two-step fixture run whose first pool went silent:

````markdown
## Prior attempt on this step

- Pool: staller
- Model: zen/union-free
- Started: 2026-09-17T08:30:46.056Z
- Finished: 2026-09-17T08:30:54.133Z
- Duration: 8s
- Failure: stalled — stalled: the worker wrote nothing for 8 s and was stopped
- Files changed inside this step's territory: owned.txt
- Diff stat at the moment it ended:
```
owned.txt | 1 +
 1 file changed, 1 insertion(+)
```
- Diff snapshot: .../diff-edit-owned-attempt-1.txt
- Final answer / partial output: .../out-edit-owned-attempt-1.md (83 bytes)
- Stream file: .../stream-edit-owned-attempt-1.jsonl
- Last response events:
  - 2026-09-17T08:30:46.102Z: Read the task file and enumerated 3 candidate files.
  - 2026-09-17T08:30:46.102Z: Editing owned.txt with the first pass before checking the tests.
  - 2026-09-17T08:30:46.102Z: ## Partial Read the task file and enumerated 3 candidate files before going quiet.
- Those edits are unverified. You decide whether to keep, fix or revert them, and you must report which.
````

The diff stat is frozen at the moment the worker exited, so edits a sibling
step makes afterwards are never blamed on it. The stream is named by path and
never pasted in. `workflow watch` prints the same handoff as one line:

```text
↪ edit-owned handed off from staller · 1 files · last said "## Partial Read the task file and enumerated 3 candidate files before going quiet."
```

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
**Budget**, **Stats**, **Fleet**, or **Help** as dashboard pages.
The strip remains the run list. The pane's bottom row is `back` (on a step), the
run buttons, `usage` and `close`, with no dashboard `[edit]` or `[install]`
actions. Its strip and pane re-read ongoing runs every 20 seconds; the full
details are in [Claude Code integration](/integrations/claude-code).


## Next steps

- [Workflows](/guide/workflows) — author the program a run executes.
- [Result envelope](/reference/result) — every field of the result document.
- [Claude Code integration](/integrations/claude-code) — the packaged skill, the MCP server, and the mod pane.
