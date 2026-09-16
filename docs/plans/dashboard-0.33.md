# 0.33.0 — the dashboard release: effort breakdown and data feasibility

Planning date: 2026-09-16, against bullswarm **0.32.0** on branch
`dashboard-0.33`. Baseline for every claim below: `npm test` → **918 pass,
0 fail, 21.9 s**. The measurements quoted here come from the gap analysis of
the same date, taken on this machine.

Companion files: `dashboard-0.33.goal.txt` (the goal text whose numbered items
are the requirements the run verifies) and `dashboard-0.33.program.json` (the
workflow program). `program-format.md` in this directory is the format
contract.

## 1. Scope

In scope (the approved prototype, `docs/design/dashboard-prototype.html`):
Home, Runs, Run, Step, Budget, Stats, History, Fleet, Help; the prototype's
keys, clicks and phone layout; the Claude Mod pane keeps working.

Out of scope by explicit direction: **routing, steering, and the dispatch
mechanism**. Nothing in this program edits `src/workflow/v2-dispatch.js`,
`src/lib/steering.js`, or the routing tables in `src/lib/strategy.js`.

## 2. Data feasibility — the verdicts implementers must obey

Three classes. **Real** may be printed as a measured number. **Labelled** must
carry `≈` and a stated basis, or a blank when the basis is missing. **Out** is
not shown at all.

### 2.1 Real (measured on this machine, 2026-09-16)

| Statistic | Source | Evidence |
|---|---|---|
| pool, model, reasoning per attempt | `state.attempts[]` | top models: `claude-opus-5` 217 attempts, `kaihk/gpt-5.6-luna` 164, `claude-sonnet-5` 115, `grok-4.6` 113 |
| minutes: wall, agent-seconds, per-attempt `wallSec` | `lifecycle.startedAt/finishedAt`, `budget.seconds` | total agent time **124.8 h** across the 181 finished/indexed runs (`budget.seconds`); 128.8 h across all 189 V2 runs; `attempt.wallSec` sums 123.9 h; 105 legacy runs record neither. The 187 h in the planning draft is not reproducible and must not be printed — corrected 2026-09-17 by the aggregation-models measurement |
| verified, requirements passed/total | `result.verified`, `result.requirements[]` | 180 of 188 V2 runs carry a result; 94 are `verified: true` |
| pool used %, elapsed %, pace, resets_at, reset source | `pool.usedPct`, `pool.elapsedPct`, `pool.paceResetsAt`, `pool.resetSource` | read now: claude-code 41/28.9, codex 30/49, grok 77/75.1, command-code 94.9/98.1 |
| credits meter | `snapshot` credits | real: `66.41 / 70 credits` |
| licence used per pool per day | `~/.bullswarm/meters/history/<pool>.jsonl` | real per pool per day, **but only ~10 days of retention** (measured 10.1 days claude-code, 9.8 command-code at the 500-line cap) |
| run counts, ok share, p50 minutes per model and per project | `state.attempts` | `rungRecord` keys on pool × tier; per-model aggregation over the same fields is new but real |
| active days, longest run, median run, most active day | run lifecycle | V2 history spans 15 distinct days, 2026-08-31 → 2026-09-16 |

### 2.2 Labelled (`≈`, with its basis on screen)

| Statistic | Why it is not a measurement |
|---|---|
| **any `$` figure** | `estimateInvocationUsage` prices the task file text and the output file text only (`utf8-bytes/4`), with **no cache split**. 849 of 877 V2 attempts used that path; the 20 "provider-reported" ones read the last counter in a streaming log, not the total. Total across all 188 V2 runs, all time: **$12.85**, with 75 runs carrying no figure at all. Every `$` renders as `≈ $X API-equivalent estimate`, and the `N×` multiple the prototype prints is **dropped** — it divides a subscription cost that does not exist by a number that is wrong by an order of magnitude. |
| licence percent per run | `normalizedQuota.estimatedPercent` is null on **877 of 877** attempts. A run's draw may only be shown as `≈ ratePerMinute × its worker-minutes on that pool`, using `pool.spend.pacing.{ratePerMinute, source, samples}`; blank where `ratePerMinute` is null; never plain. |
| subscription-rate money | `state.strategy.subscriptions[pool].monthlyPriceUsd` exists as a field and is **null on every pool** on this machine, and there is no plan-price table in the repo. It becomes real per machine through `bullswarm strategy set-subscription <pool> --monthly-usd …`; a sourced table may add published prices, dated and cited, and nothing may be invented to fill it. |

### 2.3 Out (must not be rendered)

| Prototype element | Why |
|---|---|
| `you, interactive` share of a pool | no source in the CLI at all; the mod reads `$.session.usage()`, which has no CLI equivalent |
| `runs / you / free` three-way bar | reframe to **workflows (measured worker-minutes) / rest** |
| the `7.7×` / `6.4×` multiple | see above; dropped |
| plain licence % per run on the claude pools | 0 of 0 usable history pairs today: Anthropic returns a fresh sub-second `resets_at` every poll — **382 distinct values in 382 samples** — and the S4 equality test in `src/lib/spend.js` discards every pair |
| `the four plans together allow $650 this week` | needs plan prices nobody has declared |
| Budget's This month / All time tabs | the meter history keeps ~10 days |
| months-wide heatmap at full width | 15 days of V2 history would render three-quarters empty; ship it sized to the history that exists |

### 2.4 The one recording fix that unblocks measured licence numbers

`src/lib/spend.js:296` compares `from.resetsAt !== to.resetsAt` to detect a
window rollover. Normalising `resets_at` to the second before that comparison
turns the claude pools from 0 usable pairs into a measurable series. This is
in scope (recording, not dispatch); it ships in the measurement item below.

## 3. What is recorded, and where

| Path | Contents |
|---|---|
| `<runDir>/rollup.json` | one record per finished run, written at finish |
| `~/.bullswarm/history/runs.jsonl` | the append-only index the dashboard reads; never `listRuns` per refresh |

`listRuns` parses every `state.json` — measured **293 directories, 22 MB,
~100 ms**, against a 1,000 ms refresh timer. Home, Stats and History must read
the index instead; Home must paint in under 50 ms with 293 directories present.

Rollup record:

```js
{
  schemaVersion: 'bullswarm.workflow.rollup.v1',
  runId, shortId, project, goal, cwd,
  startedAt, finishedAt, status, verified,
  requirements: { passed, total },
  minutes: { wall, agent },
  pools:  { [pool]:  { attempts, minutes, costUsd, tokens } },
  models: { [model]: { attempts, minutes } },
  legacy: false,
}
```

105 of 293 run directories are legacy with no V2 `state.json`: History lists
them as read-only rows with no numbers, and the rollup index carries no entry
for them.

## 4. Frozen interfaces

Parallel writers never share a file, so these signatures are fixed here and
repeated in every prompt. Consume them; do not renegotiate them.

### `src/workflow/dash-kit.js` (render kit)

```js
rule(title, right, width)                          // '── title ──────── right ──'
tabsRow(tabs, { active, width, hidden = [] })      // { text, regions }
periodToggle(periods, { active })                  // { text, regions }
shareBar(parts, { width, colors = true })          // parts: [{ value, glyph }] → '▓▓▒▒░░'
sparkline(values, width)                           // '▁▂▄▆█' with an ASCII fallback
progressBar(fraction, width)                       // '▇▇▇░░░░'
stackedBars(rows, { width, colors = true })        // rows: [{ label, segments: [{ value, color }] }]
heatRow(cells, { width, ansi = true })             // cells are 0..1
niceStep(max, ticks = 4)                           // axis step
cut(text, width)                                   // truncate to width with '…'
```

Every one honours `asciiGlyphsPreferred()` from `src/lib/glyphs.js` and never
paints past `width`. A region is `{ x, width, action }`; `action` is a plain
object the shell maps in one switch.

### `src/workflow/rollup.js`

```js
rollupRecord(state, result, { project = null, now = Date.now() } = {})
writeRunRollup(runDir, state, result, { now } = {})   // rollup.json + index append
readRollup(runDir)                                     // record | null
rollupIndexPath(bullswarmDir)                          // <dir>/history/runs.jsonl
appendRollupIndex(bullswarmDir, record)                // idempotent by runId
readRollups(bullswarmDir, { since = null, until = null, limit = null, now = Date.now() } = {})
```

### `src/workflow/history.js`

```js
dayKey(iso)                                                       // 'YYYY-MM-DD', local zone
historyDays(bullswarmDir, { before = null, days = 7, now = Date.now() } = {})
// → [{ date, runs, finished, verified, verifiedShare, spendUsd }], newest first,
//   strictly before `before` when given; reads the index, never listRuns
```

### `src/lib/project.js`

```js
projectOf(cwd, { remote = true } = {})   // { name, remote, toplevel }; git toplevel + origin remote, else basename; never throws
projectName(cwd)                         // projectOf(cwd).name
```

### `src/lib/prices.js`

```js
planPrices({ file = null } = {})                          // parsed data/plan-prices.json
priceFor(pool, { subscriptions = {} } = {})               // per-machine override wins; else the table; else null
subscriptionCostUsd(price, { days = 7 } = {})             // pro-rated from monthlyPriceUsd, else null
```

### `src/workflow/stats-model.js`

```js
PERIODS, TREND_METRICS                                    // ['7d','30d','all'], ['runs','spend','minutes','verified']
periodRange(period, now)                                  // { from, to }
overviewModel(rollups, pools, { period = '7d', now })
trendModel(rollups, { metric, period = '7d', now })       // { buckets, total, cumulative, max }
poolsModel(rollups, pools, { period = '7d', now })
modelsModel(rollups, { period = '7d', now })
projectsModel(rollups, { period = '7d', now })
```

### `src/workflow/budget-model.js`

```js
poolBudget(pool, { rollups, prices, now })                // one pool's row
budgetModel(pools, { rollups, prices = null, period = 'week', now })
biggestRuns(rollups, { pool, period = 'week', now, limit = 5 })
```

Row: `{ name, planType, window, usedPct, elapsedPct, pace, paceWord, resetsAt,
resetSource, resetsText, credits, share: { workflows, rest }, subscription:
{ monthlyPriceUsd, includedValueUsd, source, updatedAt } | null,
apiEquivalentUsd, fits }`. `share` counts **measured worker-minutes**; there is
no `you` term. `subscription` is null unless a price is declared.

### Views

```js
// src/workflow/budget-view.js
budgetLines(budget, { width = 120, ansi = true } = {})    // { lines, regions }
budgetNotes(budget, { width = 120 } = {})                 // note lines above the nav

// src/workflow/fleet-view.js
fleetLines(pools, rungs, { width = 120, by = 'lane', nowMs = Date.now(), ansi = true } = {})

// src/workflow/stats-view.js
statsLines(stats, { width = 120, tab = 'overview', period = '7d', metric = 'runs', ansi = true } = {})

// src/workflow/history-view.js
historyLines(days, { width = 120, ansi = true } = {})
historyNote(days, { width = 120 } = {})
```

`src/workflow/usage-view.js` keeps `usageLines`, `poolSummaryLines`, `meterBar`,
`paceWord`, `severityColor`, `poolWindows`, `untilText`, `loadUsage` and
`parseMouse` exported with their current signatures: the Claude Mod pane and
the existing test read them.

## 5. Work items

S ≈ under half a day of agent work · M ≈ one focused pass · L ≈ its own pass
plus tests. The numbers here are work items (W1–W8); the **requirements** the
run verifies are the numbered items of `dashboard-0.33.goal.txt`.

| # | Item | Size | Files (exact) | Needs |
|---|---|---|---|---|
| W1 | **Data floor** — rollup writer, history index, project identity, `workflow reindex`, plus the finish-path hook | **L** | `src/workflow/rollup.js`, `src/workflow/history.js`, `src/lib/project.js`, `src/workflow/v2-runtime.js`, `src/workflow/goal.js`, `src/workflow/runs-cli.js`, `tests/workflow-rollup.test.js`, `tests/workflow-history.test.js`, `tests/project.test.js`, `tests/workflow-v2-runtime.test.js`, `tests/workflow-goal.test.js`, `tests/workflow-runs.test.js` | — |
| W2 | **Render kit** — rules, tabs, period toggle, share bar, sparkline, progress, stacked bars, heat, `niceStep`, `cut`; ASCII fallbacks throughout | **M** | `src/workflow/dash-kit.js`, `tests/dash-kit.test.js` | — |
| W3 | **Measurement & prices** — `resets_at` normalisation for the S4 pair test, meter-history access, the plan-price table and resolver, `lastCounter` sums its counters | **M** | `src/lib/spend.js`, `src/meters/registry.js`, `src/lib/prices.js`, `data/plan-prices.json`, `src/strategy-cli.js`, `src/lib/usage.js`, `tests/spend.test.js`, `tests/meters.test.js`, `tests/prices.test.js`, `tests/usage.test.js`, `tests/strategy-cli.test.js` | — |
| W4 | **Aggregation models** — stats and budget maths over rollups + live pools + prices | **M** | `src/workflow/stats-model.js`, `src/workflow/budget-model.js`, `tests/workflow-stats-model.test.js`, `tests/workflow-budget-model.test.js` | W1, W3 |
| W5 | **Budget & Fleet views** — the meter half moved out of `usageLines`, money, fit, absolute reset with the local zone, biggest runs; the rung half named Fleet, two tabs, `[edit]` | **M** | `src/workflow/budget-view.js`, `src/workflow/fleet-view.js`, `src/workflow/usage-view.js`, `tests/workflow-budget-view.test.js`, `tests/workflow-fleet-view.test.js`, `tests/workflow-usage-view.test.js` | W2, W4 |
| W6 | **Stats & History views** — 5 tabs, 4 metrics × 3 periods, clickable bars, per-date timeline with older days loaded on scroll | **M** | `src/workflow/stats-view.js`, `src/workflow/history-view.js`, `tests/workflow-stats-view.test.js`, `tests/workflow-history-view.test.js` | W2, W4 |
| W7 | **Shell, Home, Run/Step, keys, narrow layout** — page enum, tab row, key table, tile/bar click actions, Home rebuild, plan DAG strip, ETA, share bars, Help page | **L** | `src/workflow/dashboard.js`, `tests/workflow-dashboard.test.js` | W2, W4, W5, W6 |
| W8 | **Docs & changelog** — the page list, the key table, the new command | **S** | `docs/guide/observing.md`, `docs/reference/cli.md`, `README.md`, `src/help.js`, `mods/bullswarm/README.md`, `CHANGELOG.md` | all |

W7's four sub-parts all own `src/workflow/dashboard.js` and are therefore
**one** territory: splitting a 2,654-line file across writers guarantees an
integration conflict.

## 6. Territories and waves

One writer per file, always. No territory lists a directory or a glob.

| Territory | Item | Wave | Owns |
|---|---|---|---|
| `data-floor` | W1 | 0 | `rollup.js`, `history.js`, `project.js`, `v2-runtime.js`, `goal.js`, `runs-cli.js` + tests |
| `render-kit` | W2 | 0 | `dash-kit.js` + test |
| `measure-prices` | W3 | 0 | `spend.js`, `registry.js`, `prices.js`, `plan-prices.json`, `strategy-cli.js`, `usage.js` + tests |
| `aggregation-models` | W4 | 1 | `stats-model.js`, `budget-model.js` + tests |
| `budget-fleet-views` | W5 | 2 | `budget-view.js`, `fleet-view.js`, `usage-view.js` + tests |
| `stats-history-views` | W6 | 2 | `stats-view.js`, `history-view.js` + tests |
| `shell-home` | W7 | 3 | `dashboard.js` + test |
| `docs-changelog` | W8 | 4 | `observing.md`, `cli.md`, `README.md`, `src/help.js`, `mods/bullswarm/README.md`, `CHANGELOG.md` |
| integration | — | 5 | nothing (`ownedFiles: []`): reconcile, apply the requests below |
| acceptance | — | 6 | nothing: adversarial evidence |

Wave 0 runs three ways in parallel. `aggregation-models` waits on two of them;
the two view territories wait on the models; the shell waits on the views (a
digest condenses their four outputs, because four outputs feed one reader);
docs waits on everything that writes; integration then acceptance.

### Key decisions the shell owns (settle once, then document)

- `r` Runs, `b` Budget, `s` Stats, `y` History, `f` Fleet, `h`/`?` Help, `1`–`9`
  open run, `Tab`/`Shift+Tab` cycle sub-tabs, `p` cycle period, `Esc`/`←` back
  then Home, `↑`/`↓`/`j`/`k` one line, `PgUp`/`PgDn`, `Home`/`End`, `ctrl+s`
  copy the screen, `q` quit.
- `r` (refresh), `b` (move out) and `Tab` (next workflow) change meaning. The
  1 s refresh timer stays, so nothing is lost by rebinding `r`; `Esc`/`←`
  still moves out; `Shift+Tab` still cycles workflows. This is a behaviour
  change and belongs in the changelog.
- `y` confirms a pending stop (as today) and is History otherwise; Help says so.
- `ctrl+s` copies through OSC 52 with a `pbcopy`/`wl-copy` fallback, and says
  which one it used.
- `frameWidth()` subtracts one column below 100, so a 55-column terminal paints
  54. The phone layout is specified at **55 columns and must fit 54**; do not
  change the subtraction, and make every atom width-driven so 56–99 columns
  stay defined.
- At 55 columns keep the prototype's `[Top] [End] [Help]` tail rather than
  today's `● N runs`; Help says which.

## 7. Validation and acceptance

Per item, the writer runs `npm test` (baseline **918 pass, 0 fail**) and quotes
the summary line. The integration action runs the full suite and the four
commands that must keep their shapes. The acceptance action runs the real
`node bin/bullswarm.js` dashboard in tmux at **120×40 and 55×26** against a
fixture `~/.bullswarm` home, walks every key and every click, and compares the
result with the prototype:

1. no painted line exceeds the frame width on any page at either size, and no
   page is blank;
2. every key in the list reaches its page or action, and Help names every one;
3. every clickable atom records a hit region and runs the same action its key
   runs;
4. every money and licence figure is measured or carries `≈` with its basis —
   with no declared price and `estimatedPercent: null`, the dashboard renders a
   blank and says why, never a number;
5. `bullswarm workflow tui <id> --overview` still parses under
   `mods/bullswarm/hooks/overview.ts` `parseOverview`, and `pools --json`,
   `workflow runs --json`, `assignments --json`, `strategy rungs --json`,
   `workflow runs show --json`, `workflow action show --json` keep their shapes;
6. Home paints in under 50 ms with 293 run directories present.

## 8. Deferred past 0.33.0

| Deferred | Reason |
|---|---|
| `runs / you / free` split | no CLI source for "you, interactive"; ship `workflows / rest` |
| plain licence draw per run on the claude pools | needs per-attempt meter sampling, which lives in the dispatch path — out of scope |
| `meterBefore`/`meterAfter` around each attempt | same: a dispatch change, deferred with the routing freeze |
| Budget's This month / All time tabs | meter history retains ~10 days |
| Stats › Pools and Models line charts | a second chart renderer for what stacked bars already carry |
| months-wide heatmap at full width | 15 days of V2 history |
| decision-log cap fix in `src/cli.js` (`logDecision` trims to 500, `appendDecision` does not) | Stats, History and Budget read rollups and state, not the decision log; the fix touches a shared file with no 0.33.0 consumer |
| per-model `(52%)` share of a pool's licence | needs plan prices per model, which nobody publishes |

## 9. Requests the integrator applies (shared files, one writer each)

| File | Change | For |
|---|---|---|
| `docs/guide/observing.md`, `docs/reference/cli.md`, `README.md`, `src/help.js`, `mods/bullswarm/README.md` | the page list, the new key table, `bullswarm workflow reindex` | docs-changelog |
| `CHANGELOG.md` | the 0.33.0 entry, including the `r`/`b`/`Tab` rebinding | docs-changelog |
| `mods/bullswarm/hooks/pool-rows.tsx` | keeps its own copy of the meter palette; if `budget-fleet-views` changes `METER_COLORS`, the integrator keeps the two in step or reports the drift | integration |

The version number is bumped by `node bin/bullswarm.js release minor`, which
creates the commit and the tag; the program writes the changelog entry only.
