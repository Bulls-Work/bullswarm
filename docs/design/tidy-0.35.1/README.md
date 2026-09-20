# Dashboard tidy-up design record (0.35.1)

This began as the design handoff for the 0.35.1 dashboard tidy-up. The fifteen
unprefixed content frames in `frames/` remain bounded hand-drawn targets. The
implementation now also supplies the thirty-six `real-*.txt` renderer captures
required by the acceptance contract: Home, Run (running and finished), Step
(overview and detail × running/finished/failed), a single task page, and the
Stats Spending and Model pages, each at 55, 120 and 200 columns. Regenerate
them with `node scripts/render-tidy-0.35.1-frames.mjs`, which asserts every
line fits its width.

## Evidence used

All figures below come from `tests/fixtures/home-351`, the scrubbed fixture
`scripts/build-test-home.mjs` builds from a copied, read-only home (every id,
time, count and amount as recorded; prose and paths are marked placeholders),
and the current 0.35.1 worktree. The frames use the following recorded runs.

* `euqrni` (`wf-mu8thu2e-27c504`) is a completed, independently verified
  dashboard-page-split run: 3/3 actions, five attempts, API `$9.760216`, and
  115.92 active minutes from the union of its attempt intervals.
* `rw3dhi` (`wf-mu8radyf-bb49cc`) is completed but not independently verified:
  3/4 requirements, eight attempts, API `$16.155810`, and 98.02 active
  minutes.
* `va7k9a` (`wf-mu8ni8o4-f9baaf`) is completed and verified: 6/6
  requirements, ten attempts, API is unknown because the codex pool has only
  a known subtotal, and 165.87 active minutes.
* The Home cards' most-recent-first order for 19 Sep is `rensha` (project
  `project-b`, 9/9 actions, 58.61 active minutes), `euqrni` (project
  `project-a`, 5/5 actions, 115.92 active minutes), then `rw3dhi` (project
  `project-a`, 7/7 actions, 98.02 active minutes). The licence rows use all
  seven finished-today workflow records: codex 992.59 worker-minutes,
  `claude-code:acme` 58.43, grok 76.18, and `claude-code` 171.30.
* The Step overview record is action `study` in `qvh8e2` (`wf-mu8jg6cd-9d7b33`):
  `codex · gpt-5.6-sol · high`, 844.1 seconds, 6,095,515 known tokens,
  API `$3.8369688`, and a 96-event stream (6 responses and 90
  `command_execution` events).
* The Step detail record is action `step-model` attempt 1 in `va7k9a`:
  `codex · gpt-5.6-luna · medium`, 2,946.7 seconds, 35,971,504 known
  tokens, API `$0.95992824`, and a 325-event stream (15 responses, 240
  `command_execution`, and 70 `file_change` events).
* The task frame is the latest real single-task record
  `a58fb95e-6f73-4f3a-88d5-8a063155fb3c`: project `project-a`, lane
  `analyze`, pool `codex`, model `gpt-5.6-luna`, `ok: true`, and
  `durationMs: 1415854` (23.60 minutes). Its task and output paths and first
  lines are copied under `home-351/runs/`.

Active minutes in this record are derived from the real attempt timestamps,
not copied from the current `minutes.wall` field. The same derivation is what
the implementation must persist as `minutes.active`.

## 1. Duration contract

### Stored fields

Every run record and every phase record has these numeric fields:

* `minutes.active`: the union length of all attempt intervals, in minutes.
  Sort intervals by start, merge overlapping or touching intervals, and sum
  each merged interval once. A running attempt is `[startedAt, renderNow]` for
  the live projection; it contributes only the elapsed portion up to the
  current render and never contributes idle time. A terminal record uses its
  recorded `finishedAt` values. Missing or invalid endpoints remain unknown,
  not zero.
* `minutes.span`: the secondary wall span from the first attempt start to the
  last recorded attempt finish. It is `null` until a terminal last finish is
  known for a run/phase. It is never substituted for `active` in a duration
  label.

The interval union is independently computed per phase from that phase's
attempts. `worker-minutes` in each pool row remains the sum of individual
attempt clocks, so overlapping workers still count separately there.

### Readers that switch to `minutes.active`

The writer must change the following readers and labels together:

* Home's `todayWorkflowLine` and finished-today rows;
* Runs rows and the Run header;
* Run phase-header and timeline-phase duration text;
* Stats' `countRun` row, `finishRows` median, `keyValues` median/longest, and
  `outcomesModel` median/max duration fields;
* the rollup/reprice path that currently writes `minutes.wall`.

`minutes.span` may be shown only as an explicitly secondary “span” fact. A
timeline attempt row uses that attempt's own interval duration, not the phase
union. Thus three real `accept` attempts that each lasted 28m22s render three
28m22s rows while the phase header still shows the one active union. `workflow
reprice` must recompute both fields for old terminal records; this design does
not perform that mutation.

## 2. Home

The page order is navigation, Today cards beside the licence block, Running,
Budget, the last-7-days period band, and the recent list. The full run list is
removed from Home and remains on Runs; the recent block lists only the five
newest runs (three at 55 columns) as a shortcut into Runs and history.

Today chooses at most three records: active records first, then finished
records ordered by most recent `finishedAt`. Each card has exactly these data
fields: run name (the goal's first meaningful line, truncated only for
display), project, execution status, independent verdict (`verified`, `not
verified`, or `—`), `minutes.active`, `steps done/total`, and the strict money
pair (`API`, `subscription`). An unknown money slot is `—`; a known subtotal
does not become a complete total.

From 120 columns the cards and the licence block share the same rows: the
licence column sits on the right, sized to its own words (40 columns minimum,
never more than half the width), and the cards take the rest. Three cards flow
side by side inside that column when they fit (200 columns); at 120 the
remaining ~76 columns hold one card per row, so they stack inside the column.
At 55 columns the cards stack full width in the same ordering with the licence
block beneath. The narrow frames intentionally use short goal labels
(`sample goal for rensha`, `sample goal for euqrni`, and `sample goal for
rw3dhi`) that are prefixes of the recorded (placeholder) goals above.

The licence block has one row per pool and a plain-word header defining the
five dot-separated slots:

`pool · worker-minutes · weekly share · API · subscription`

Rows contain values in exactly that order. “weekly share” is the measured
share of the pool's weekly meter window; when the snapshot has no meter it is
`—`. Do not use labels such as `wf % (est.)`, `run min`, or `API · sub`.
Running and Budget remain visible even when the copied snapshot has no active
run; the frames say `none captured` rather than inventing a run.

Below `budget · this week` the period band returns: a period rule with the
`Last 7 days · Last 30 days · All time` toggle (`p` cycles it), a four-column
band of `spent per day` beside `by pool` / `by model` / `by project`, and the
summary lines `Workflows:`/verified, `Favourite pool:`, `Favourite model:`,
`Spent:`, `Median run:` and `Busiest project:`. A day whose attempts were only
partly priced still draws its recorded subtotal, and the axis carries `≈`.

## 3. Run

The Run header shows identity, project, execution status, independent
verification, `minutes.active`, and (secondarily) `minutes.span`. The plan is
one compact box per presentation phase, in phase order. A box contains only a
status glyph, the phase's position, the phase name, and `done/total`
(`[✓ 1. design-map 1/1]`); it never contains per-step rows. Consecutive boxes
on a row are joined with ` → `; boxes wrap only between whole boxes and no row
ends with an arrow. Glyphs are `✓` completed, `▶` active, `○` pending, and `×`
failed/blocked.

The real `euqrni` phase boxes are `[✓ 1. home-extraction 1/1]`,
`[✓ 2. runs-extraction 1/1]`, `[✓ 3. run-extraction 1/1]`,
`[✓ 4. integrate 1/1]`, and `[✓ 5. verify 1/1]`. Their active phase durations
are 28m25s, 30m32s, 31m52s, 4m38s, and 20m27s — the same active minutes the
design first wrote as 28.42m … 20.45m, in the clock form v0.35.0 drew.

The timeline is v0.35.0's tree, one group per phase:

```
── Phase 1 · home-extraction ── 28m25s ──
04:05  ├─ started
04:34  │  ├─✓ home-extraction · codex · gpt-5.6-luna · low        28m25s
04:34  └─✓ completed                                                 1/1
```

Each attempt row names the action that ran and appends
`pool · model · effort` from the attempt routing record (for example
`codex · gpt-5.6-luna · low` and `claude-code · claude-opus-5 · high`; a dash
where a field was never recorded), with that attempt's own clock right-aligned.
The phase header carries the phase's active minutes in clock form, never the
span across an idle gap.

## 4. Step information architecture

The final order is deliberately only five blocks:

1. **Header** — action/run identity, execution status and independent verdict,
   `pool · model · effort`, and action active duration.
2. **Task** — the current `prompt preview` and `task · first lines` content
   merged into one first-lines block with an expand affordance.
3. **Activity** — overview or detail mode, with follow state, selection, and
   filters.
4. **Result** — the current `output`, `artifacts`, and `outcome and
   verification` content merged into one block.
5. **Cost** — API/subscription money pair, token classes/source, and budget
   basis in one block.

The current renderer sections being merged are quoted exactly: `budget`,
`activity · capture order`, `selected event`, `attempt history`, `outcome and
verification`, `prompt preview`, `task · first lines`, `output`, and
`artifacts`. The new view keeps their data, but not their old visual order.

Overview is the default. `v` is the page toggle: the footer says `[v detail]`
in overview and `[v overview]` in detail. In overview, each `response` event
is one row. The following atomic events up to the next response become one
summary row, then the next response appears. `Enter` on a response expands
that response's intervening atomic events in place; `Esc` collapses it. The
existing arrow selection, `Space` follow-tail, `e` errors filter, and `t`
tools filter remain.

The summary counts only normalized event kinds that actually exist:

* `command_execution` increments **commands**;
* `file_read` increments **files read**;
* `file_change` increments **edits**;
* normalized error kinds or an event with an error status increments
  **errors**;
* response, tool, and other kinds do not get silently reclassified.

For example, the real `study` stream has response groups followed by 2, 20,
60, 4, and 4 `command_execution` events, with zero normalized file reads,
edits, and errors. The real `step-model` detail stream has 15 responses, 240
commands, and 70 edits. The summary must say those zeros rather than infer
file work from a shell command's prose.

Detail mode is a capture-order log for the current day. It exposes every
normalized technical field when present (`seq`, provider timestamp, capture
time, source, provider type, kind, status, event/turn/tool identifiers,
arguments, result, usage, duration, parent/subagent IDs), and explicitly
labels missing optional fields. Filters apply to the same log. Artifact rows
show the full task, output, stream, result, and run-directory paths; no path is
invented when the record has none.

## 5. Single-task adapter

The old thin `task`/`artifacts` page is replaced by the same Step model/view.
The adapter is pure and maps the normalized `listTasks` record as follows:

| Task record | Step model field | Rule |
| --- | --- | --- |
| `id` | `identity.actionId` | Use the id; if absent use the task-file basename. |
| `project` | `identity.project` | Preserve `null` when the ledger has no project. |
| `lane` | `route.lane` | The lane is not an effort value. |
| `pool` | selected-attempt pool | Preserve the recorded pool. |
| `model` | selected-attempt model | Preserve the recorded model. |
| no effort field | selected-attempt effort | `—`; never infer effort from lane/model. |
| `startedAt`, `endedAt`, `durationMs` | attempt timestamps and duration | One task is one attempt; duration is active duration. |
| `ok` | execution status | `true` → succeeded, `false` → failed, null → unknown. |
| `reason` | result reason | Keep the exact reason; it is not independent verification. |
| no `verified`/workflow result | verdict/workflow status | unavailable (`—`). |
| `taskFile` | prompt path/first lines and artifact task path | Read only the retained file. |
| `outFile` | output path/first lines and artifact output path | Empty or missing stays unavailable. |
| no stream pointer in a task row | activity | `event stream unavailable`; no synthetic response or command rows. |
| no usage, budget, or meter fields | cost | API, subscription, tokens, and budget are `—`. |

The adapter may preserve full artifact paths, but may not construct a result
envelope, requirement evidence, verification verdict, effort, usage, or
stream from task prose. It must use the same `v` toggle, `Enter` expansion,
footer hints, and five-block order as a workflow Step.

## 6. Shared-file requests for integration

The design action owns only this README and its fifteen frames. The integrator
must apply these requests in the implementation territories:

1. **`src/workflow/rollup.js` and reprice:** add `minutes.active` and
   `minutes.span` to run and phase rollups; union open intervals against
   render time; reprice terminal historical records; preserve pool
   worker-minutes. Replace readers of `minutes.wall` listed in section 1.
2. **`src/workflow/home-model.js` / `home-view.js`:** implement the three-card
   ordering and the five-slot plain-word licence rows; lay the cards beside
   the licence block from 120 columns; retain Running, Budget, the period band
   and the five-row recent list, and remove the full run list from Home.
3. **`src/workflow/run-model.js` / `run-view.js`:** render phase boxes and
   timeline rows using active/attempt durations and routing effort.
4. **`src/workflow/step-model.js` / `step-view.js`:** implement the five-block
   order, `v` mode toggle, turn grouping and `Enter` in-place expansion.
5. **`src/workflow/dashboard.js`:** route both workflow Steps and single tasks
   through the same adapter/view; add the `v` key and preserve arrows,
   filters, follow, and `Esc` behavior. The current handler only toggles a
   selected-event detail on `Enter`, so it must gain the mode/turn behavior.
6. **`src/workflow/stats-model.js`:** use active duration for median/longest
   fields while retaining worker-minute aggregates.

Exact key contract for the shared handler:

`v` mode toggle; `Enter` expand/collapse selected overview turn; `↑/↓`
select; `Space` follow; `e` errors; `t` tools; `Esc` collapse detail or leave
the page.

## 7. Validation and boundaries

The design action ran read-only source/snapshot inspection, a real-record
active-union calculation, and a width assertion over all fifteen design
frames. Integration renders thirty additional frames from the same snapshot
with `scripts/render-tidy-0.35.1-frames.mjs`: Home and task at three widths;
running and finished Run at three widths; and overview/detail Step in running,
finished, and failed states at three widths. Every generated line is asserted
against its requested width. Historical running and failed screens are
projections bounded by recorded attempt timestamps; they do not invent events,
durations, routing, money, or outcomes. No live `~/.bullswarm` state is read or
changed, and no commit is created.

### Contract deviations

The original design action delivered fifteen unprefixed targets. Integration
also delivers the exact thirty `real-*.txt` state/width variants requested by
the final action contract. Because the supplied snapshot contains no live run,
the running and failed captures project real recorded intervals at historical
instants; the failed Step is an interrupted attempt within a run that later
completed and verified. No other requirement is intentionally reduced.
