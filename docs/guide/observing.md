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

Every page has a sticky header and a sticky bottom nav. The header names the
page and, on Run and Usage, keeps the current run or meter sample in view. The
bottom nav has one `[ <run> ]` button per ongoing run, followed by
`[ usage ] [ help ] [ quit ]`. Every button shows its key underlined: inside
the label (the `u` of `usage`, the `h` of `help`, the `q` of `quit`), and a
run's digit ahead of its id inside the button (`[ 1.aaa111 ] [ 2.bbb222 ]`),
so the keys are read off the nav itself. `?` opens Help too. The current run or page is marked `●`.
Step adds `[ back ]` at the front, its `b` underlined. A long body shows its
`first–last/total` row window while it scrolls.

The pages are Home, Run, Step, Usage, and Help:

- **Home** — ongoing runs, compact pool rows, agent-integration status with
  `[install]`, and the one-line commands that operate Bullswarm.
- **Run** — the Preflight and timeline, Live workers, Next work, and compact
  pool rows last; each step row opens Step.
- **Step** — the selected action's status, model and reasoning, attempt,
  route, activity, verdict or failure, prompt, usage, events, output, and
  artifact paths.
- **Usage** — every enabled pool's 5h, 7d, and monthly windows, credits when
  reported, and model rungs grouped by lane or provider.
- **Help** — the dashboard's controls and the page-specific actions.

Every page shares these keys — the dashboard's own Help page (`?`) prints the
same table:

| Key | Does |
| --- | --- |
| `↑`/`k`, `↓`/`j` | move up, move down |
| `Enter`, `→`, `l` | open the selected run, step, or tab |
| `Esc`, `←`, `b` | move out one page |
| `Tab` / `Shift+Tab` | next / previous run |
| `1`–`9` | open that run from the nav |
| `u`, `h` or `?` | open Usage, open Help |
| `q` | quit the dashboard; a workflow keeps running |

And these are page-specific:

| Page | Keys |
| --- | --- |
| Home | `/` filter · `a` active/all · `r` refresh · `i` install the agent integration |
| Run | `t` phases/timeline · `o` planner · `v` technical details · `c` stop the workflow · `PgUp`/`PgDn` scroll |
| Step | the agent panel; `Esc`/`b` goes back |
| Usage | `l` by lane · `p` by provider · `e` edit (`bullswarm setup`) |

Mouse reporting is enabled while the dashboard is open: click any button,
tab, run, or step, and use the wheel to scroll the body.

::: tip
`q` quits the dashboard and leaves the run going; only `c` stops it, and that
asks the kernel for a cooperative stop at its next safe checkpoint.
:::

Usage draws full-width background-coloured meter cells: green (`#b6bd73`)
below 50% used, amber (`#e9c880`) from 50%, red (`#bf6c69`) from 80%, and a
dark track (`#3a3a3a`). A white `▏` marks where each window's elapsed time
falls. Each window includes its reset time and pace, followed by a credit
meter where the provider reports one, then the rung's model, reasoning, and
local record. The page note reads `read-only here · [edit] opens bullswarm setup`;
`[edit]` hands the terminal to setup and returns to Usage with the rungs
re-read. Home's `[install]` runs the same as `bullswarm integrate install --yes`; once every agent is installed it reads
`[installed ✓]` and is inert.

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
read-only counterpart. Its strip above the prompt is the run list, and its pane
mirrors the dashboard's Run, Step, and Usage pages with the same meter colours
and the same click-and-wheel navigation. Its bottom row is `back` (on a step), the
run buttons, `usage` and `close`: there is no Home or Help page, and none of
the dashboard's `[edit]` or `[install]` actions. Its strip and pane re-read
ongoing runs every 20 seconds; the full details are in [Claude Code integration](/integrations/claude-code).


## Next steps

- [Workflows](/guide/workflows) — author the program a run executes.
- [Result envelope](/reference/result) — every field of the result document.
- [Claude Code integration](/integrations/claude-code) — the packaged skill, the MCP server, and the mod pane.
