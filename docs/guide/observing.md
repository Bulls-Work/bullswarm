---
title: Observing runs
description: Follow a live Bullswarm run without polling, list and inspect past runs, read the result, and use the full-screen dashboard.
---

# Observing runs

After this page you can follow a live run without polling in a loop, list and inspect runs by id, read a finished run's result, use the dashboard and its keys, and fix a terminal that cannot draw the status glyphs.

## The 0.35.1 dashboard layout

The dashboard keeps the same evidence sources while making the primary pages
quicker to scan. Run, phase, Home, Runs, Stats, and Step summary durations use
`minutes.active`: the union of the run's attempt intervals, so overlapping work
counts once and idle time counts never. `minutes.span` (first start to last
finish) is retained as a secondary fact; the Run page may show it alongside
active minutes. A timeline attempt row uses that attempt's own clock; pool
`worker-minutes` still sums all attempt clocks.

The pages are arranged as follows.

| Page | 0.35.1 view |
| --- | --- |
| **Home** | Today leads with at most three cards: active runs first, then the most recently finished. Each card shows the run name, project, execution status, independent verdict, active minutes, steps done/total, and the API/subscription money pair. From 120 columns the cards sit left of the plain-word licence block (`pool · worker-minutes · weekly share · API · subscription`, one row per pool) and share its rows; they flow side by side inside that column when three of them fit (200 columns) and stack when they do not (120). At 55 the cards stack full width with the licence block beneath. Below `budget · this week`, `── last 7 days ──` (`Last 30 days`/`All time` cycle with `p`) charts spend per day beside the by-pool/by-model/by-project lists with Workflows/verified, Favourite pool/model, Spent, Median run and Busiest project, and `── recent ── history ›` lists the five newest runs; Running and Budget remain visible. |
| **Runs** | The full run list lives here. Home's compact cards do not replace the active and history records on Runs. |
| **Run** | The header says `done of total steps`, names running/waiting ids, and shows `active of span` minutes plus the start/finish clock. The plan is phase-only boxes on desktop (named step groups, never `Parallel work`) and a glyph strip on phones; `p` toggles the phone boxes. The live block is the selected running attempt's latest stream turn (or the last finished turn), and the spend block reports known API/plan subtotals with measured, estimated, running, and unmeasured coverage. The timeline has one phase rule with start → end, active duration and done/total, then one `clock · glyph · step · pool · model · effort` row per attempt; filler `started`/`completed` rows, licence bars, `so far`, and ETA rows are gone. |
| **Step** | One header, then turns, result, task and cost. Line 1 of the header is the verdict (step · run · status · independent verification · attempt), line 2 the purpose, line 3 `pool · model · effort · reasoning` beside one clock, then the route sentence. At 160 columns the activity holds the left column and the result, task and cost cards stack on the right; below that the page stacks result → activity → task → cost. |

The Step activity view is **turns by default**. Press `v` to switch between the
turn overview and the every-event detail log; the footer hints name the other
view once (`v detail (every event)` / `v overview (turns)`). A turn is one
response and the tools that led to it: the row carries its number, the response
clock, up to two lines of the response, and only the non-zero counts (`35
commands`, `14 commands · 3 edits`, `no tools`), counting a started/completed
pair once and mapping each provider's raw tool kinds to those categories (codex
`command_execution`/`file_change`, Claude Code `Bash`/`Read`/`Write`/`Edit`,
grok `run_terminal_command`/`read_file`/`grep`); a tool that fits no category is
still counted, named when it is the only kind. Select a turn with `↑`/`↓` and press `Enter` to expand its
full response and its tool rows in place; `Esc` collapses it. Detail is the
capture-order log for the current day, with filters (`t` cycles turns → tools →
errors → all), every technical field that was captured, and full artifact
paths. `f` and `Space` keep the selection following the tail.

An individual `bullswarm run` task uses the same Step model and view through a
task-record adapter. It has the same header, blocks, `v` toggle, turn
expansion, footer hints, and activity controls. The adapter preserves recorded
identity, project, lane, pool, model, timestamps, status, reason, and
task/output paths; it does not invent effort, usage, money, verification, a
result envelope, or an event stream. With no stream pointer it says `no event
stream path recorded`.

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
The Run page's footer is local: `[ back ] [ ● 1.<shortId> ]` followed by
`Enter open step · p plan boxes · Space follow · ? help`; other pages keep run
buttons and the narrow-layout `[Top] [End] [?.Help]` tail visible. A long body
shows its `first–last/total` row window
while it scrolls. The dashboard's Help page (`?`) prints the same page and key
map.

The pages answer different questions:

| Page | What it answers |
| --- | --- |
| **Home** | What happened today, which top runs are verified, what API-equivalent/licence figures are available, and which workflows are active or recent? |
| **Runs** | Which workflows are active or in the catalogue, in one `active` block above the History day table? `/` filters and `a` switches active/all; the agents and `run it` blocks moved to Help (`?`). |
| **Run** | Where is this workflow in its compact phase plan, what is each attempt's pool/model/effort, and what are the current active and span durations? |
| **Step** | What is this action doing — its header, turn activity, result, task, and cost, with model, effort, and active duration? |
| **Budget** | What does each pool's quota window report, how much measured worker time is workflows versus rest, what money is measured or labelled, how many median runs fit, and which workflows used the most worker-minutes? |
| **Stats** | How do runs, spend, worker-minutes, and verification trend over 7 days, 30 days, or all time? Its four tabs are Spending, Pool, Model, and Project. Spending puts the dated chart beside four breakdown panels; `By Pool` / `By Model` changes both the chart stacks and the visible breakdowns. |
| **Fleet** | Which model and reasoning rung each pool uses by lane or provider, its run record and meter state, and where to open setup for edits. |
| **Help** | What every key, click, layout rule, and dashboard command does. |

The other pages retain their existing period, budget, statistics, and fleet
controls. The 0.35.1 changes described above are the layout contract for Home,
Runs, Run, and Step; they do not turn an unavailable value into zero or replace
the full Runs catalogue with a Home card.

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
| `p` | cycle the page period (Home and Stats); on Run, toggle phase boxes |
| `Esc` / `←` | move out one page, then return to Home |
| `↑`/`k`, `↓`/`j` | move one line up or down |
| `Enter` / `→` / `l` | open the selected run, step, tab, or action |
| `PgUp` / `PgDn` | scroll up or down one screen |
| `Home` / `End` | jump to the top or bottom |
| `ctrl+s` | copy the screen through OSC 52, falling back to `pbcopy`, `wl-copy`, or `xclip` |
| `q` | quit the dashboard; workflows keep running |

Page-specific controls include `/` (filter), `a` (active/all), and `i`
(install) on Runs; `v` to switch the Step between its turn overview and the
every-event detail log; `Enter` to expand a selected turn and `Esc` to collapse
it; `t` to cycle the Step's activity filter and `f` to follow its tail (which
otherwise opens Fleet); `v` on Stats
Spending to switch `By Pool` / `By Model`; and `e` on Fleet to open setup.
On Run, `p` toggles the compact plan boxes and `Space` toggles following the
live stream; `Enter` opens the selected step. `c` requests a cooperative stop
from Run, and `y` confirms it. Mouse reporting
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

## Single `bullswarm run` tasks on the Runs page

A single task dispatched with `bullswarm run` is not a workflow, but it spends
the same quota, so the dashboard counts it the same way.

A task **in flight** is read from the live assignment ledger,
`$BULLSWARM_HOME/assignments/*.json` with `source: "run"`, and appears in the
`Runs` page's `active` block next to any running workflow. A **finished** task
is read from `state.json`'s `decisionLog`, where every `bullswarm run` dispatch
now records its `lane`, `taskFile` and `outFile` alongside the pool, model and
verdict it always recorded. Finished tasks appear as rows in the `Runs` history
day table:

```text
── Fri 18 Sep ─────────────────────────────────── 6 runs · 3 tasks · (cost unknown) ──
 ⚙  build · task · codex · gpt-5.6-luna                          ok  1h00m  11:05
 ⚙  build · task · opencode · openrouter/stealth/union-alpha  provider stream reporte…     0m  09:45
```

The `⚙` glyph is green for `ok`, red for a failure and cyan while the outcome is
unknown; the row then carries the lane, the task identity, `pool · model`, `ok`
or the short failure reason, the measured duration, and the time it ended. Each
day header counts them separately — `6 runs · 3 tasks` — and `Home`'s today
band counts tasks alongside workflow runs rather than ignoring them. Press
`Enter` on a task row to open the same Step page as a workflow action,
including the shared turn/detail toggle and activity controls.

The task adapter keeps the recorded lane, project, pool, model, timestamps,
duration, status/reason, and task/output paths. A task has no inferred effort,
verification verdict, usage, money, result envelope, or stream; missing values
remain unavailable and a missing stream is shown as `event stream unavailable`.

A task recorded before these fields existed has no id, task file or start time.
It still appears, showing `—` for what it does not have, and it is listed and
counted **once** even though the day page and the task ledger both offer it.

The Claude mod's pane shows a task in flight too, instead of the old
`No ongoing workflow run`.

## The output sparkline

Each attempt records how many bytes its output file held over time, so the
`Run` and `Step` pages can draw the shape of a worker's progress instead of
only its current size:

```text
 ● integrate · claude-code:acme · 19m · output ▁▁▂▃▃▄▆█ 14 KB
```

It is drawn on a **running** attempt: in the `Run` page's plan strip and live
agent list, and in the `Step` page header. The series is read from the attempt's
persisted event stream when the connector has one, and otherwise from
`outputSamples` on the durable attempt record — a bounded list of
`[atMs, bytes]` pairs, capped at 240 per attempt so a reader can redraw a run
without loading the transcript. An attempt with no samples draws no sparkline
rather than a flat line.

## The Step page: one header, turns, result, task, cost

Press `Enter` on a workflow action—or on a single-task row—to open the Step
page. The workflow action and the task record are normalized into the same
model and view. The page says the header once, then draws four blocks:

1. **Header** — line 1 is the verdict: the step, its run, the execution status,
   the independent verdict, and the selected attempt (`attempt 1 of 2`). Line 2
   is the purpose. Line 3 is `pool · model · effort · reasoning` on the left and
   the clock on the right; the route sentence follows as its own line. Nothing
   below the header repeats it.
2. **Activity** — the turns. A turn is one response and the tools that led to
   it; the rule carries the turn count and the totals, and the last cells of the
   rule are the filter control.
3. **Result** — the report's first lines, the paths the diff file recorded, the
   step's `Shared-file requests` when its report has that heading, and the
   artifact row. Execution success and independent verification stay separate
   facts.
4. **Task** — the author's own first lines, then `owns`/`after`/`affects` as
   short facts. The kernel wrapper (workspace rules, dependency list, "read
   every dependency output…") lives behind the block, with its size stated.
5. **Cost** — two rows, API rate and the pool's plan, each with its amount and
   one line of basis, plus the token classes under the API amount. Unknown money
   stays `—` with its reason, never an invented zero.

At 160 columns and wider the activity takes the left column and result, task
and cost stack on the right, so a finished step fits one screen. At 120 the
right column narrows to 40 columns; below that the page stacks like the phone,
in the order result → activity → task → cost, so the answer is on top and the
task, which you already know, is at the bottom. While a step runs the phone
leads with `now` (the newest captured fact) instead of the result.

### The clock: active minutes, span only when it differs

The header prints one clock in h/m/s (`49m07s`). The span across an idle gap
appears only when it differs from the active time, as `49m07s active of 1h02m`.
While an attempt is live the clock runs from the attempt's start and the header
adds `turn 8` and `last event 02:20:26 HKT, 3s ago`; a finished step prints
`49m07s · 01:50 → 02:39 HKT · 20 Sep 2026` instead.

Execution success and verification remain deliberately separate. An action can
be `succeeded` while a workflow is still unverified; a result says
`verified 6/6` only when the durable evidence gate says so. While an action is
running, verification is pending, not false. Retry records retain the pool,
model, ordinal, status, timing, route, failure, output bytes, token source, and
money pair for every attempt; they are not an inferred transcript.

### Turns are the unit

The overview prints one row per turn: the turn's number, the capture clock of
its response, up to two lines of that response, and only the non-zero tool
counts (`35 commands`, `14 commands · 3 edits`, `no tools`). On the desk the
counts sit at the end of the second line; on the phone they take their own row.
The started and completed halves of one operation count once, classed by the
real event kind through a table that normalises every provider's tool names
(codex `command_execution`, Claude Code `Bash`, grok `run_terminal_command` all
count as commands), and never inferred from command prose. When the `other
tools` class is a single kind the row names it (`2 grep`). A still-streaming
response is one turn whose text is the chunks captured so far; a chunk is never
a row of its own. The last turn is the result: its row reads `→ the report,
shown under result` instead of printing the report twice.

`Enter` on a turn expands it in place: the whole response, its counts with
`Esc closes`, and its **newest** three tool rows with their own clock and
measured duration. Older rows fold into one line above them —
`↑ 6 earlier commands · Space page up` — and `Space`, `PageUp` and `PageDown`
walk that three-row window back and forward through them. Opening, collapsing
or moving to another turn resets the window to the newest rows. `Esc` collapses
the turn again.

A tool that has not finished keeps its place at the bottom of that window: it
draws a spinner and the time it has been running so far, and it is counted in
the collapsed turn's counts like any other. A tool that finished in under a
second prints no duration at all rather than a misleading `0s`, and a capture
that carried no summary is named by its event kind instead of reading `summary
unavailable`. While the step is running and the page is following, the current
turn is expanded by default, so the newest tool rows are on screen without a
keypress; `f` stops the follow and leaves the page where you put it.

Press `v` for detail: the current-day capture-order log with every technical
field (seq, capture time, source, provider type, kind, status, event/turn/tool
identifiers, provider timestamp, duration, usage, parent/subagent, arguments,
result, summary) and the full artifact paths. Missing optional fields are
labelled as unavailable. Without a structured stream the page says `event
stream unavailable`; task or answer prose never creates synthetic activity.

### Money in plain words

The two rows answer different questions:

```text
API rate    $0.96   36.0M tokens · OpenAI rate card, 20 Sep
                    35.2M cache read · 713k input · 58k output
codex plan  —       no meter reading for this attempt
                    $100/mo · weekly window
measured from the codex transcript
```

API is the dated model-rate equivalent (or a transcript sum/byte estimate),
while the plan row is a measured or calibrated quota-window debit. An exact
amount prints plain, an estimate gets `≈`, and an unknown gets `—` with its
reason. The row's basis phrase and the closing `measured from…` line are word
maps over the finite basis and tokenSource codes in
`src/lib/usage-basis.js`, so a new code prints itself rather than a blank.
Token classes print only when the capture recorded them, so grok shows
reasoning and Claude shows cache write. A live attempt says `measured when the
attempt finishes (codex transcript)` instead of guessing.

Every missing layer has a named state rather than a blank that looks complete:

| What is missing | Step page says |
| --- | --- |
| No stream file, or a historical attempt whose stream was not retained | `event stream unavailable`; turns, tools, timing, and event usage cannot be reconstructed |
| Plain stdout fallback | `plain stdout capture has no structured events` |
| Bad JSONL lines | the parse-error count and `malformed stream lines ignored` |
| Bounded capture | `truncated` and the dropped-event count |
| No stable turn ids | `turns not captured` |
| No tool id/name/arguments/result | the corresponding detail field is `unavailable` |
| No provider timestamp or duration | capture time is shown; provider time/duration is `unavailable` |
| No parent or subagent ids | subagent structure is `not captured` |
| Live attempt without usage | `measured when the attempt finishes`, not a guess |
| No API rate, subscription meter, plan price, or calibration | the amount is `—` with its reason (`no meter reading for this attempt`) |
| No durable result envelope | `no report was written for this step`; a separate verification stays separate |
| No verification verdict or requirement evidence | `not verified (0/1 requirements)` or `verification unavailable` |
| No task, output, stream, or result path | the artifact row names only what was recorded, else `no artifact paths recorded` |

### Step keys

| Key | Does on Step |
| --- | --- |
| `v` | switch between the turn overview (the default) and the every-event detail log |
| `↑`/`↓` | select the next or previous turn (overview) or captured event (detail) |
| `Enter` | expand or collapse the selected turn, or the selected event's detail |
| `t` | cycle the activity filter: turns → tools → errors → all |
| `f` | follow or stop following the activity tail |
| `Space` | page an expanded turn's tool window back through its older rows, or toggle the follow when no turn is expanded |
| `PageUp`/`PageDown` | the same tool window, older and newer |
| `Esc` | collapse an expanded turn, or leave the page |

The footer carries the hints once: `Enter expand turn · Esc close · v detail
(every event) · t filter · f follow · ? help` on the desk, and the short form on
the phone.

## Budget: every window a pool reports

`Budget` no longer shows one window per pool. It shows every window the
provider actually reported — the rolling 5-hour window, the 7-day window, and
the monthly window where a pool has one — each with its local reset time and
its pace:

```text
command-code · monthly plan · resets Sat 17 Oct 11:06 (in 28d 16h)
windows 5-hour (5h) · 1% used · resets 20:56 GMT+8 · behind by 44 pts
        7-day (7d) · 1% used · resets 12:26 GMT+8 · behind by 16 pts
        monthly (mo) · 1% used · resets 11:06 GMT+8 · behind by 4 pts
```

Pace is `behind by <n> pts` / `ahead by <n> pts` / `on track`, comparing that
window's used share with the share of it already elapsed. A window nobody
reported is absent, not zero — `codex` above it shows only `7-day (7d)`, and
the cards fold onto one row when the width allows. The page header says how old
the numbers are:

```text
 Budget · 7 days to Asia/Hong_Kong · sampled 5m ago
```

The age is `just now` under a minute, then `5m ago`, `2h ago`, `3d ago`. A
reading with no capture time shows no age at all rather than implying
freshness — a stale meter can no longer be misread as a live one.

## Budget: detected plan prices

Money per pool needs a monthly subscription price. You can still declare one
with `bullswarm strategy set-subscription <pool> --monthly-usd <amount>`, but
each provider now also reports the plan name it can detect for itself: Claude's
`subscriptionType` / `rateLimitTier` from `~/.claude/.credentials.json`, Codex's
`plan_type`, Command Code's plan, and opencode's plan.

`data/plan-prices.json` maps a plan name to a monthly USD figure **only** where
a vendor page was actually read; each entry quotes the page URL and the exact
line the number came from. A plan with no citable price stays `null` and Budget
says the price is unavailable rather than inventing one.

A detected price is spent exactly like a declared one, and the plan line says
which it is, so your own figure is never confused with an inferred one:

```text
plan · $100/mo detected max 5x
plan · $20/mo declared
```

The provider half of the lookup is the **provider**, not the pool: a discovered
per-account pool such as `claude-code:acme` resolves against `claude-code`'s
plan table, so one login per account still gets its price.

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

### Testing with a copied home

When a dashboard render or an observation bug needs a real home, prefer a
selective snapshot over `cp -Rp ~/.bullswarm`. It keeps the routing, meters,
provider files, single-task ledger, and a small workflow slice, then rebuilds
the copied history index. The source is never written, and `--no-streams`
drops the large per-attempt stream and stdout files:

```bash
bullswarm home snapshot /tmp/bsw-snapshot --recent 3 --no-streams --json
BULLSWARM_HOME=/tmp/bsw-snapshot bullswarm workflow tui --json
```

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
