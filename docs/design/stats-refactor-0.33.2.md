# Stats refactor specification — 0.33.2

This is the design contract for the three implementation steps that follow this
action. It is deliberately a rendering and data contract, not an implementation
change. The only file delivered by this action is this report.

## Evidence and current shape

I read the current source and the owner artefacts before specifying the refactor:

- `src/workflow/stats-view.js:35-60` still defines five tabs (`Overview`,
  `Trends`, `Pools`, `Models`, `Projects`) and four trend metrics plus an
  optional licence metric.
- `src/workflow/stats-view.js:638-740` hand-builds the Overview figure grid;
  `:1022-1147` hand-builds trend columns, cumulative totals, legends and slice
  regions; `:1494-1604` hand-builds the Models chart/list; `:1608-1697`
  hand-builds Projects; and `:1752-1800` hand-builds the heatmap, period row,
  figures, money basis and the unsupported playful sentence. These paths must
  be removed from `stats-view.js`, not kept as a second drawing system.
- `src/workflow/stats-model.js:204-213` defines calendar `periodRange`;
  `:552-731` defines trend buckets and their basis; `:754-790`, `:801-818`
  and `:821-840` define pool, model and project rows; `:1020-1048` composes
  Overview. A null remains unmeasured, never zero.
- `src/workflow/dash-kit.js:242-309` provides `columns` with column metadata;
  `:445-475` provides `tabsRow` and `periodToggle`; `:536-574` provides
  `shareBar`; `:588-608` provides `sparkline`; `:643-668` provides
  `stackedBars`; `:700-1000` provides `columnBars` and its slice geometry; and
  `:1051-1066` provides `niceStep`.
- `src/workflow/dashboard.js:2275-2298` converts a view's relative
  `{x,y,width,action}` regions to shell hit regions. The Stats page is attached
  at `:4107-4120`.
- `src/workflow/dashboard.js:4448-4477` keeps ordinary row hover separate
  from Stats slice hover and defines the `textSpans` rule; `:4648-4654` paints
  only text spans; `:5252-5293` finds slice regions, moves the transient label,
  pins on click and clears on another click; `:5528-5570` clears the pin on
  Escape/Back.

The owner screenshot was opened from
`docs/design/owner-review-2026-09-19/stats-overview-current.png`. Its single
letter day labels (`S M T …`) are not acceptable date labels. The goal wording
is in `docs/plans/0.33.2-stats.goal.txt`.

### Rollup evidence used in this report

All figures in the frames and examples below came from a copy made before
reading:

```text
cp -Rp /Users/cowcow02/.bullswarm /tmp/stats-design-home.XG6mba/bullswarm
BULLSWARM_HOME=/tmp/stats-design-home.XG6mba/bullswarm
```

The copied index contained 307 records. At the snapshot time
`2026-09-18T17:27:28.856Z`, the `7d` model window contained 59 workflows from
13–19 Sep (59 is the `overview.keys.workflows` value). The source records have
these top-level fields: `runId`, `project`, `status`, `verified`,
`requirements`, `minutes`, `pools`, `models` and identity/timing fields. No
record has a `lane` field. `status` does exist (`completed`, `partial`,
`cancelled` in this window), and `minutes.wall` exists for the 59 records.

The pool map carries `attempts`, `minutes`, `costUsd` and `tokens`; the model
map carries only `attempts` and `minutes`. In particular, model cost is absent;
`stats-model.js:527-542` explicitly returns no spend-by-model segments and says
why. No cost may be prorated from model minutes or attempts.

The copied 7-day rollup-derived values used in the examples are:

| Measure | Value | Source |
| --- | ---: | --- |
| workflows | 59 | `overview.keys.workflows` |
| verified workflows | 30 (51%) | `overview.breakdown.*.verified`, or the verified trend total |
| worker-minutes | 7,018.74 | `overview.keys.totalWorkerMinutes` |
| API-equivalent total | $7.032817 (shown as $7.03) | pool/project `apiEquivalentUsd` totals |
| median wall duration | 54.49 min (shown as 54m) | `minutes.wall` median |
| longest wall duration | 542.69 min (shown as 9h03m) | `minutes.wall` maximum |
| status counts | completed 53, partial 2, cancelled 4 | `status` in the 59 records |
| requirements | 235 passed of 301 recorded | `requirements.passed/total` |

The spend trend buckets are `$0.080957`, `$2.933020`, `$0.361446`, `$1.175906`,
`$1.606565`, `$0.874923`, and null for 13–19 Sep respectively. Buckets whose
`tokenSource` is `unknown` render `—` in a chart; the numeric rollup total is
still retained with its mixed-basis note. The frames make that distinction
visible instead of silently presenting an exact price.

## 1. `src/workflow/stat-kit.js` API

`stat-kit.js` is the only renderer used by every Stats tab. It is pure: no
filesystem, clock, dashboard state or model arithmetic. Every exported drawing
function returns the same shape, even when it has no bars:

```js
{
  lines: string[],
  regions: Array<{
    kind: 'column' | 'slice' | 'share',
    row: number,                         // 1-based line in this result
    columns: { start: number, end: number }, // inclusive, visible cells
    payload: HoverPayload,
  }>,
  meta?: object,
}
```

The shell adapter converts `row` and the inclusive column span to its existing
`{x,y,width,action}` shape. Regions cover every visible cell of every bar the
function paints. Text labels, axis strokes, legends and summary text do not get
bar regions.

`HoverPayload` is the durable, formatting-independent data needed by the
hover label:

```js
{
  tab: 'spending' | 'pool' | 'model' | 'project',
  metric: 'spend' | 'minutes' | 'runs' | 'attempts' | 'verified' | 'outcome',
  period: '7d' | '30d' | 'all',
  bucketKey: string | null,
  bucketLabel: string | null,
  series: string | null,
  label: string | null,
  value: number | null,
  total: number | null,
  share: number | null,                  // 0..1; null means not measured
  unit: 'usd' | 'minutes' | 'runs' | 'attempts' | 'percent' | 'count',
  tokenSource: 'provider-reported' | 'transcript-summed' |
    'estimated:utf8-bytes/4' | 'unknown' | null,
  basis: string | null,
}
```

The exact exports and signatures are:

### `renderShareBar`

```js
renderShareBar({
  parts, width, colors = true, partialGlyph = null,
  tab, metric, period, bucketKey = null, bucketLabel = null,
  unit, basis = null,
}) -> Drawn
```

`parts` is an ordered array of `{ id, label, value, total, share, color,
tokenSource }`. The function wraps the existing allocation and glyph rules and
registers one `share` region for each painted part. A positive value that rounds
to no cell is either given a partial cell when `partialGlyph` is requested or
remains unpainted and is described as too small; it is never rounded up in the
payload.

### `renderPanel`

```js
renderPanel({
  title, rows, width, labelWidth = null, barWidth = null,
  tab, metric, period, unit, basis = null, colors = true,
}) -> Drawn
```

`rows` is `{ id, label, value, total, share, color, valueText?, note?,
missingReason? }[]`. The output is a title rule followed by one row per input,
each row containing its label, a `renderShareBar` bar and a sourced value/share
wording. A null row prints `—` plus `missingReason`, with no empty track and no
region. The returned regions are lifted from the child share bars and retain
the panel's `tab`, `metric`, `period` and row identity.

### `renderColumnChart`

```js
renderColumnChart({
  title, buckets, width, height, rowCount = null,
  unit, mark = '', totals = true, cumulative = false,
  tab, metric, period, basis = null, colors = true,
}) -> Drawn
```

`buckets` is `{ key, label, value, tokenSource, unit }[]`. Labels must already
be real date labels supplied by `dateLabel` below. The function calls the
existing `columnBars` primitive with one series, preserves its value axis,
nice ticks, totals and optional cumulative row, and registers a `column` region
for every painted column bar. A null bucket gets no bar region and its value
cell is `—`; the label remains so the reader can tell which date had no
measurement.

### `renderStackedColumnChart`

```js
renderStackedColumnChart({
  title, buckets, series, width, height, rowCount = null,
  unit, mark = '', totals = true, cumulative = false,
  tab, metric, period, basis = null, colors = true,
}) -> Drawn
```

`series` is `{ id, label, values, color, tokenSource }[]`; `values` aligns to
`buckets`. The function calls `columnBars` unchanged, maps each
`meta.slices` geometry to one or more `slice` regions, and keeps
`sourceIndex/sourceNames` when `columnBars` has to collapse sub-eighth slices
into `other (...)`. A stacked slice's `total` is its column sum and `share` is
its exact value divided by that sum. The total column itself remains a
clickable `column` region when it has a measured value; slice regions win when
the pointer is over a slice cell.

### `renderLegend`

```js
renderLegend({ items, width, activeSeries = null, colors = true }) -> Drawn
```

`items` is `{ id, label, color }[]`. It wraps every name using the existing
legend policy and bolds only `activeSeries`. It returns `regions: []` because a
legend marker is not a data bar.

### `renderSummaryCard`

```js
renderSummaryCard({ title, items, width, tab, metric, period, basis = null }) -> Drawn
```

`items` is `{ id, label, value, valueText?, note?, missingReason? }[]`. It
prints measured values or `—` plus the reason, never a fabricated zero. It
returns `regions: []`; summary text is not a bar.

### `renderStatsSurface`

```js
renderStatsSurface({
  tab, period, width, height, stackBy = null,
  tabs, summary, chart, panels, legend, notes = [], ansi = true,
}) -> { lines, regions }
```

This is the sole composition entry point used by `stats-view.js`. It draws the
tab row, title/period/toggle row, one reserved hover-label row, the summary
card, then the main chart beside the two-by-two panel grid at desktop widths.
At narrow width it emits the same child order and spacing but stacks the chart
and panel cells one column. It remaps every child region to the surface's
relative `row` and `columns` coordinates. The reserved hover row is always
present, even when empty, so pointer movement never changes the layout.

### `formatHoverLabel` and `dateLabel`

```js
formatHoverLabel(payload) -> string
dateLabel(key, { width, bucketSpan = 1, newest = false }) -> string
```

`formatHoverLabel` is the one wording function used by the shell. `dateLabel`
implements the width rules below and never returns a weekday initial by itself.

## 2. dash-kit compatibility and additions

`stat-kit` wraps these existing exports without changing their signatures or
behaviour:

| Existing export | Use in `stat-kit` |
| --- | --- |
| `tabsRow` | the four Stats tabs and their tab hit regions |
| `periodToggle` | `7d` / `30d` / `all` row |
| `columns` | desktop chart/grid split and the nested two-by-two grid; use its `meta.columns` for offsets |
| `shareBar` | the visual share-bar glyph allocation |
| `stackedBars` | optional horizontal stacked summary rows where a panel needs a multi-part bar |
| `columnBars` | all vertical and stacked column charts; consume `meta.columns`, `meta.slices`, `meta.sums` |
| `seriesColor`, `seriesColors` | stable pool/model/project colours and the legend |
| `sparkline` | Pool licence-history and Project daily mini-series panels |
| `niceStep` | only for axis metadata or empty-chart decisions; `columnBars` remains the painter |
| `chartRowCount`, `compactRow`, `cut`, `formatDashboardValue`, `absentLine` | common sizing, value wording and honest null rows |

No existing export may change. Budget and other pages depend on the current
`shareBar`, `stackedBars`, `columnBars`, `columns`, `sparkline`, tab and period
behaviour.

The only new dash-kit exports needed are metadata siblings, so old callers do
not change:

```js
shareBarMeta(parts, options = {})
  -> { text: string, parts: [{ id, x, width, value, share }] }

stackedBarsMeta(rows, options = {})
  -> { lines: string[], rows: [{ row, segments: [{ id, x, width, value, share }] }] }

dateLabels(keys, { width, cellWidth, newest = false, bucketSpan = 1 } = {})
  -> string[]
```

`shareBarMeta` and `stackedBarsMeta` must use the exact allocation and visible
cell rules of their existing string-only siblings; they add geometry, not a
second allocator. `dateLabels` centralizes the date-label rule so the Stats
charts cannot regress to `S M T …`. If adding metadata to `columnBars` is more
convenient, add a new `columnBarsMeta` wrapper rather than changing the
existing return contract; current `columnBars.meta` is already sufficient for
the vertical slice regions.

## 3. Four tabs and their fixed surface order

The only Stats tab ids and labels are, in this order:

```text
spending → Spending    pool → Pool    model → Model    project → Project
```

Every tab uses the same surface order and desktop geometry:

1. Four-tab row.
2. Page title, period toggle and (only on Spending) the `By Pool` / `By Model`
   toggle.
3. The one reserved hover-label row.
4. The summary card.
5. Main dated chart on the left half; a two-by-two grid of panels on the right
   half. At narrow width these are the same cells in one column.
6. Legend immediately below the chart/grid.
7. Basis/availability notes and the common footer. No page may add a bespoke
   chart before or after this sequence.

The panel slots are stable even when their data differs:

| Tab | Main chart | Cell 1 | Cell 2 | Cell 3 | Cell 4 |
| --- | --- | --- | --- | --- | --- |
| Spending | API-equivalent spend/day, stacked by selected basis | selected basis spend share | selected basis worker-minutes share | project run share | Outcome & duration |
| Pool | spend/day stacked by pool | pool spend share | pool worker-minutes share | pool attempts share | live licence/reset history |
| Model | worker-minutes/day stacked by model | model worker-minutes share | model attempts share | model verified/ok share | cost availability (`—`, with reason) |
| Project | runs/day stacked by project | project run share | project worker-minutes share | project API-equivalent share | Outcome & duration |

Rows are sorted using the model's existing ranking, then clipped with a visible
`+N more`/scroll note only when the panel cannot fit. A clipped row is not
silently counted as a total different from the model total.

### Overview and Trends migration

| Retired surface | Destination | Keep/drop decision |
| --- | --- | --- |
| Overview heatmap and measured span/max | Project chart and summary (`active days`, dated runs, busiest day) | Drop the heatmap glyph grid itself: it duplicates the dated chart and has no useful per-cell bar hover. Keep its measured day/span facts. |
| Overview workflows, verified share, API-equivalent spend, agent/worker minutes, median and longest wall duration | Spending summary card and Outcome & duration cell | Keep; null remains `—` with its reason. |
| Overview favourite pool | Pool summary card | Keep as the top attempts/minutes row. |
| Overview favourite model | Model summary card | Keep as the top attempts/minutes row. |
| Overview busiest project | Project summary card | Keep. |
| Overview pool/model/project breakdown rows | Pool, Model and Project cells | Keep through the shared `renderPanel` path. |
| Overview money-basis line | Spending basis note | Keep; it is required to explain `$` estimates. |
| Overview playful “about 3 working days” sentence (`stats-view.js:1797-1800`) | none | Drop: it is hard-coded and not a rollup measurement. |
| Trends `runs` and `spend` | Spending chart/toggle | Keep as dated columns and exact hover payloads. |
| Trends `minutes` | Model chart | Keep as measured worker-minutes; do not call it spend. |
| Trends `verified` | Spending Outcome cell and Project outcome rows | Keep as counts/share; no invented percentage for an empty period. |
| Trends `licence used` | Pool licence/reset-history cell | Keep when meter history exists; otherwise print the retained reason. |
| Trends cumulative row | Summary card period total | Keep the total once; do not add a second bespoke chart row. |
| Trends legend and bucket-to-History click | Shared legend and `column`/`slice` regions | Keep through stat-kit and the dashboard adapter. |
| Overview and Trends tab identities | four fixed tabs above | Drop both retired tab names. |

## 4. Spending layout and the data boundary

At 120 columns, `renderStatsSurface` gives the chart 56 visible columns, a
two-column gutter, and the grid the remaining 60 columns (the exact odd column
goes to the left cell through `columns`). At 200 columns it repeats the same
half/half rule. At 55 columns it emits the chart followed by the four grid cells
as one column; there is no horizontal scroll.

### Toggle behaviour

`stackBy` is part of the surface state and is either `pool` or `model`.

- `By Pool` calls `trendModel(..., { metric: 'spend', segmentBy: 'pool' })`.
  Cost slices are the recorded per-pool `costUsd` values. The visible grid's
  first two cells are pool spend and pool worker-minutes; the third is project
  run share; the fourth remains Outcome & duration.
- `By Model` changes the visible grid's first two cells to model worker-minutes
  and model attempts, and the legend to model names. The model map contains no
  cost (`stats-model.js:527-542`), so a truthful current-data chart cannot draw
  coloured per-model dollar slices. The chart keeps the measured daily total,
  draws one neutral `model cost unavailable`/unallocated slice, and states
  `no split: the rollup records cost per pool, not per model`; the payload's
  `value` and `share` are null for that placeholder. It must never prorate a
  pool dollar value by model minutes. If a future rollup adds per-model cost,
  the same `stackBy: 'model'` path may replace the neutral slice with real
  model slices without a layout change.

The fourth Spending cell is **Outcome & duration**. This is not a guessed lane
breakdown: the copied rollups have no lane field, but they do carry `status`,
`verified`, `requirements` and `minutes.wall`. It therefore shows status counts
(completed/partial/cancelled/failed when present), verified count/share,
requirements passed/total, median wall duration and maximum wall duration. A
missing status or duration is `—` with a reason.

### Date-label rule

The chart labels are calendar dates derived from each bucket key, never a bare
weekday initial:

| Frame width | Label rule | Example |
| ---: | --- | --- |
| 55 | Every visible day uses a compact month+day token; if a 30-day window cannot fit every token, show every stride but keep the full token on the shown ticks. | `Sep13`, `Sep14`, `Sep15` |
| 120 | Use `D Mon` whenever the cell has six visible columns; for a long window stride the ticks rather than cutting a date. | `13 Sep`, `14 Sep` |
| 200 | Use `D Mon`; when a cell has at least ten columns prefix the weekday word, never only its initial. | `Sat 13 Sep` |

Merged buckets use a range such as `13–19 Sep`. The newest date may be called
`today` only in the hover prose after its concrete axis label is present. An
empty spend bucket stays labelled and shows `—`, so a reader can distinguish a
quiet date from an unmeasured amount.

## 5. Hover contract

The stat-kit regions are the source of truth; the dashboard continues to map
them through `pushView` and its existing mouse parser.

| Bar kind | Region | Label text |
| --- | --- | --- |
| `column` | the painted cells of an unstacked/total column | `<date> · total · <value> · 100% of day` |
| `slice` | every painted row of one stacked slice, including a partial eighth | `<date> · <series> · <value> · <share>% of the day` |
| `share` | the exact horizontal cells allocated to a panel row part | `<label> · <value> · <share>% of <panel total>` |

Formatting is unit-aware: dollars keep their API-equivalent basis mark and
wording, minutes use the shared duration formatter, counts say `run(s)` or
`attempt(s)`, and null values say `value unavailable · share unavailable`.
Unknown cost never becomes `$0.00`.

The reserved label row is one full-width line immediately below the chart/grid
and before the legend. It is present and blank when no bar is under the pointer;
its height never changes. A pointer move updates only that line and the active
legend name. Bars keep their glyphs and colours; no reverse-video or recolour is
applied to a bar. The ordinary dashboard `textSpans` rule continues to reverse
only non-bar words for row hover.

A click on a bar copies its payload to `slicePinned` and leaves the label fixed
while the pointer moves. Escape clears the pin and transient hover, repaints the
blank reserved row, and then performs the existing page-back behaviour only if
there was no pin. Any other click first clears a pin; a click on another bar
immediately replaces it with that bar's payload. Switching tab, period, metric,
or leaving Stats clears both states. A click on a share row never navigates to a
made-up detail page; it only pins the label unless the row also has an explicit
page action.

## 6. Ordered implementation steps

1. Add `stat-kit.js`, the metadata-only dash-kit siblings, and focused unit
   tests for width safety, nulls, region tiling, date labels and hover payloads.
2. Replace every hand-drawn Stats path in `stats-view.js` with
   `renderStatsSurface` and the four tab data adapters. Add the `stackBy` state,
   fourth Outcome & duration model data, and the dashboard region adapter while
   preserving the existing dashboard hover/pin semantics.
3. Integrate the four-tab navigation and observing/help wording, save the two
   real-data frames, run the focused tests and the full repository gate, and
   reconcile the exact diff/acceptance evidence before delivery.

## Shared-file requests

These are requests for the integrator; this action did not edit them.

| File | Exact change | Why |
| --- | --- | --- |
| `src/workflow/stats-view.js` | Import `renderStatsSurface`, delete its per-chart/panel drawing helpers, normalize the four new tab ids, and pass `stackBy`, models and active hover payload. | Requirement 1 says stat-kit is the single Stats renderer. |
| `src/workflow/stats-model.js` | Add an `outcomes` aggregate to `overviewModel` (or an exported `outcomesModel`) with `statusCounts`, `verified`, `requirementsPassed`, `requirementsTotal`, `medianWallMinutes`, `maxWallMinutes`, `period`, `from`, `to`, `nulls`; do not add lane or inferred model cost. | The fourth cell needs a model-owned outcome/duration breakdown; status and `minutes.wall` are present, lane is not. |
| `src/workflow/dash-kit.js` | Add only `shareBarMeta`, `stackedBarsMeta` and `dateLabels` (or equivalent new exports with the signatures above). Leave every current export's output unchanged. | Stat-kit needs exact horizontal geometry and one shared date-label rule. |
| `src/workflow/dashboard.js` | Change `STATS_TABS` to `['spending','pool','model','project']`; carry `statsStackBy`; pass it to Stats; preserve `textSpans`, `sliceHover`, `slicePinned`, region precedence and Escape/other-click clearing. | Navigation and shell state are outside this report's territory. |
| `docs/guide/observing.md` | Describe the four tabs, period/toggle controls, dated labels, and column/slice/share hover wording plus pin clearing. | Required user-facing documentation. |
| `CHANGELOG.md` | Under `## Unreleased`, add the one plain-words bullet below. | Required release note; this action must not edit CHANGELOG. |
| `docs/design/stats-frames-0.33.2/` | Save the two frames below as the implementation's verified 55/120 outputs, and add a 200-column width check. | The goal requires durable real-data frames. |

## Text frame: Spending, 120×40 snapshot

Snapshot source: the copied 7-day rollups described above. `cc`, `wati` and
`cmd` are visual cuts of the full pool names; the source names remain in the
legend/hover payload. The right side is the two-by-two grid represented in a
compact text frame. The chart values with `≈` are the byte-estimate buckets;
`—` is an unknown/no-measurement bucket.

```text
 Spending  Pool  Model  Project
 Spending · Last 7 days                         [By Pool]  By Model
 hover: move over any bar for value/share; click pins · Esc clears
 SUMMARY API≈ $7.03 mixed basis · 59 workflows · 30 verified (51%)
 SUMMARY p50 54m · longest 9h03m · 6 active days · req 235/301 passed

 Spending · API-equivalent / day · stack: pool          │ POOL SPEND / POOL MINUTES
 $3.0 ┤                         ▄                       │ cc $3.00 42.6%  |  codex 1,995m 28.4%
 $2.0 ┤       ▄                                         │ wati $3.27 46.6% |  cc:wati 1,258m 17.9%
 $1.0 ┤             ▄   ▄  ▄                            │ codex $0.27 3.8%  |  opencode 1,082m 15.4%
 $0.0 ┼▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄              │ cmd $0.07 1.0% | cmd-code 1,009m
      13 Sep  14 Sep  15 Sep  16 Sep  17 Sep  18 Sep  19 Sep │ grok $0.42 6.0% · opencode —
      —       ~$2.93   ~$0.36   ~$1.18   —       —       —  │ POOL ATTEMPTS / OUTCOME
      plotted ≈$4.47 · total $7.03                      │ attempts: cc 106 24.9% · codex 97 22.8%
      — unknown basis · ≈ byte estimate                 │ wati 74 17.4% · cmd 68 16.0%
                                                        │ grok 52 12.2% · opencode 24 5.6%
                                                        │ completed 53 · partial 2 · cancelled 4
                                                        │ verified 30/59 · p50 54m · max 9h03m
                                                        │ no lane field; status + minutes.wall fill this cell
                                                        │ pool: claude-code / codex / wati
                                                        │ pool: command-code / grok / opencode
                                                        │ model: cost unavailable in rollup
                                                        │ project: agentic-knowledge-system 20 runs
                                                        │ project: bullswarm 15 · bullseye 11
                                                        │ model minutes: opus 31.1% · luna 25.5%
                                                        │ spend basis: provider or byte estimate
                                                        │ null spend: date label stays visible
                                                        │ reserved row stays blank until hover
                                                        │ narrow mode stacks chart then four cells
                                                        │ period: 7d · 30d · all

 Legend  # = share bar · dates are calendar dates, not weekday initials
 Basis   API≈ recorded estimates; model cost is not measured (—)
 Hover   column: date · total · value · 100% of day
 Hover   slice: date · series · value · share of day
 Hover   row: label · value · share of panel
 Toggle  By Model keeps totals but shows model cost unavailable; grid rows switch to model data
 Period  p cycles 7d · 30d · all; the same component spacing is retained
 Data    307 copied rollups scanned · 59 records in this 7d window
 Footer  [Top] [End] [?.Help]
```

## Text frame: Spending, 55×26 snapshot

The phone uses the same component order, but stacks the chart and grid cells. It
uses compact real dates (`Sep13`, not `S`) and keeps the reserved hover row.

```text
 Spending  Pool  Model  Project
 Spending · 7d · [By Pool] By Model
 hover: move over a bar · click pins · Esc clears
 SUMMARY API≈ $7.03 · 59 runs · 30 verified (51%)
 p50 54m · 6 active days · req 235/301 passed
 Spend/day API≈ by pool
 $3.0┤                         ▄
 $2.0┤       ▄
 $1.0┤             ▄   ▄  ▄
 $0.0┼──────────────
      Sep13 Sep14 Sep15 Sep16 Sep17 Sep18 Sep19
      —     ~$2.93 ~$0.36 ~$1.18 —     —     —
 plotted ≈$4.47 · total $7.03 · — unknown basis
 POOL SPEND
 claude-code $3.00 42.6%
 wati $3.27 46.6% · codex $0.27 3.8%
 opencode — (cost not recorded)
 POOL MINUTES
 codex 28.4% · wati 17.9% · opencode 15.4%
 OUTCOME & DURATION
 completed 53 · partial 2 · cancelled 4
 verified 30/59 · p50 54m · max 9h03m
 By Model: model cost —
 panels use model minutes/attempts
 Data 307 copied rollups · 59 in 7d
 Footer [Top] [End] [Help]
```

## Changelog bullet

`- Refactor Stats into shared, hoverable Spending, Pool, Model and Project views with dated bars and honest rollup bases.`

## Validation and unfinished work

No code, test, CHANGELOG, package, budget file or git state was changed by this
action. The existing focused checks were exercised as a baseline:

- `node --test tests/workflow-stats-model.test.js`: **31 passed, 0 failed, 0
  cancelled**.
- `node --test tests/workflow-stats-view.test.js`: **37 passed, 0 failed, 0
  cancelled**.
- `node --test tests/dash-kit.test.js`: **54 passed, 0 failed, 0 cancelled**.
- `node --test tests/workflow-dashboard.test.js`: the existing suite reported a
  **87 passed and 1 failed across 88 emitted subtests**. The failure is
  `Runs and Home show single-task ledger rows, and Enter opens task detail`
  (expected `0 workflows · 1 task · 0 verified`, but the rendered frame omitted
  the task count). The runner then stayed alive on the existing dashboard live
  handle, so it did not print its final summary; this is baseline evidence, not
  a claim that the refactor is accepted.
- `npm test` and `npm test -- --test-force-exit` were attempted more than once.
  The same dashboard lifecycle prevents a final repository summary. A bounded
  `timeout 60 npm test` returned **124** after emitting output through subtest
  727; the full gate is therefore unverified and remains an integrator task.

The implementation steps remain unfinished: `stat-kit.js`, the metadata
siblings, the four-tab navigation/state, the model-owned outcome aggregate,
the observing guide and durable frame files still need to be delivered and
re-run by the integrator. No acceptance claim is made from the baseline tests
or from this design document alone.
