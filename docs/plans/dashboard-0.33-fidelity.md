# 0.33.0 — visual fidelity: the product against the approved prototype

Planning date: 2026-09-17, on branch `dashboard-0.33`, against the shipped
0.33.0 dashboard and the frame set in `docs/design/prototype-frames/`.

Source: the composition gap list measured on this machine at 55x26, 120x40 and
200x50 against a fixture home — every number below was counted from a capture,
not estimated. That action wrote only to `/tmp/bsw-fid-home` and `/tmp/prod*`;
the real `~/.bullswarm` was never written to, and no repository file was
changed.

Companions: `dashboard-0.33-fidelity.goal.txt` (the goal whose numbered items
are the requirements the run verifies) and `dashboard-0.33-fidelity.program.json`
(the program). The data and feasibility rules of `dashboard-0.33.md` section 2
still bind this pass:

> The prototype's numbers are illustrative; the product keeps its real figures
> and its `≈`/basis rules. Only the composition, density, colour and wording
> move to the prototype's.

## 1. The verdict in three measurements

**Colour is absent from 10 of the 12 screens.** Only Budget and Stats Overview
emit any colour code. `METER_COLORS` in `src/workflow/usage-view.js` holds
exactly four values (`#b6bd73` green, `#e9c880` amber, `#bf6c69` red,
`#3a3a3a` track) while the prototype paints seven roles — green, amber, red,
**purple**, **orange**, **cyan**, dim. Purple, orange and cyan do not exist in
the codebase.

**The product spends 2-3x the rows on the same content.** Home's 7-day
breakdown: prototype 6 rows, product 16. Home's phone `today` block: prototype
4 rows, product 10. History on the phone: the product's own pager reads
`1-22/170` for 85 runs — exactly 2 rows per run — against the prototype's
`1-23/54`, one row per run, 13 runs on screen against the product's 7.

**Two whole prototype blocks are missing and one is replaced by a different
idiom.** Home has no `── budget · this week ──` section. Run has no per-step
bars and no `budget`/`live`/`so far` triptych — it draws **31 box-drawing panel
rows** (`┌│└`) where the prototype draws zero.

The kit itself is built and correct; it is starved. `dash-kit.js` already
exports `rule`, `tabsRow`, `periodToggle`, `shareBar`, `stackedBars`,
`columnBars`, `sparkline`, `progressBar`, `heatRow`, `cut` and `niceStep`, and
its own header states that the prototype's accent, purple, grey and four heat
shades "are a request for the integrator, not a second palette to add here".
Almost every gap below reduces to one of three things it lacks: the colour
roles, a column layout helper, a compact phone row helper.

Consumers today: `stats-view.js` uses 9 kit functions, `dashboard.js` 8,
`history-view.js` 3, `budget-view.js` 2, `fleet-view.js` **0**.

## 2. Work items

One writer per file, always; no territory lists a directory or a glob. S = one
focused pass; M = one block re-laid-out plus colour; L = the page re-laid-out.

| # | Item | Territory | Size | Exact files (all owned) |
|---|---|---|---|---|
| F1 | Shared kit: palette roles, `columns()`, `compactRow()`, textured meter | `shared-kit` | M | `src/workflow/dash-kit.js`, `src/workflow/usage-view.js`, `tests/dash-kit.test.js`, `tests/workflow-usage-view.test.js` |
| F2 | Home | `dashboard-pages` | L | `src/workflow/dashboard.js`, `tests/workflow-dashboard.test.js` |
| F3 | Run + Step | `dashboard-pages` (with F2) | L | same two files |
| F4 | Stats Overview + Trends | `stats-pages` | L | `src/workflow/stats-view.js`, `tests/workflow-stats-view.test.js` |
| F5 | Stats Pools + Models + Projects | `stats-pages` (with F4) | M | same two files |
| F6 | Budget | `budget-page` | M | `src/workflow/budget-view.js`, `tests/workflow-budget-view.test.js` |
| F7 | History | `history-page` | M | `src/workflow/history-view.js`, `tests/workflow-history-view.test.js` |
| F8 | Fleet | `fleet-page` | S | `src/workflow/fleet-view.js`, `tests/workflow-fleet-view.test.js` |
| F8b | Help (part of the same goal item as Fleet) | `dashboard-pages` (with F2) | S | `src/workflow/dashboard.js`, `tests/workflow-dashboard.test.js` |
| F9 | Docs + changelog | `docs-changelog` | S | `docs/guide/observing.md`, `README.md`, `CHANGELOG.md` |
| — | Integration | `integration` | — | nothing (`ownedFiles: []`: the sole writer after the parallel writers) |
| — | Acceptance | `acceptance` | — | nothing (adversarial evidence) |

## 3. What moves, per item

### F1 — the shared kit (`shared-kit`, blocks everything)

- **The palette.** `METER_COLORS` in `src/workflow/usage-view.js` gains the
  prototype's purple, orange, cyan and grey/dim roles and a four-shade heat
  ramp in place of the two-step `track → amber` blend at `dash-kit.js:571`.
  Values are lifted from the prototype's own CSS in
  `docs/design/dashboard-prototype.html`, named by role, and added to the one
  palette the product has — `mods/bullswarm/hooks/pool-rows.tsx` keeps its own
  copy of the three meter colours and the integrator keeps the two in step.
- **`columns(cells, { width, gap })`** — N cells of `{ rule, rows }` laid across
  the width, returning one text block. Home's four-column breakdown, Run's
  `budget`/`live`/`so far` triptych and Stats Overview's three-column figures
  are the same problem three times.
- **`compactRow(fields, { width })`** — one row with an elastic middle field
  from a label, a value and a trailing metric. History's 2-rows-per-run, Home's
  2-rows-per-tile and Budget's 17-rows-per-pool are the same problem three
  times.
- **`meterBar()`** emits `▇` glyphs with a `▏` elapsed mark over the track
  instead of a full-width band of coloured blanks, so the meter is legible with
  and without colour — the shape `mods/bullswarm/hooks/pool-rows.tsx:30`
  already draws.
- Every atom stays width-driven, honours `asciiGlyphsPreferred()` from
  `src/lib/glyphs.js`, and never paints past the width from 32 to 200 columns.
- `usageLines`, `poolSummaryLines`, `paceWord`, `severityColor`, `poolWindows`,
  `untilText`, `loadUsage` and `parseMouse` keep their names and signatures:
  the Claude Mod pane and `tests/workflow-usage-view.test.js` read them.

### F2 — Home (`dashboard-pages`)

- The 7-day breakdown becomes **four columns on one row band** (spent per day,
  by pool, by model, by project). The cause of today's stacking is one line in
  the breakdown band, `const barWidth = Math.max(4, width - label - 12);`
  (line 2253 today), which lets a bar claim every remaining column. Bars are
  proportional to the percentage printed beside them.
- A new `── budget · this week ──` block: per pool a meter row plus one dim
  reset/pace row. Where no subscription price is declared the money column
  renders `—` with the declare-a-price reason, never a figure.
- Running rows: two rows per run carrying the plan DAG, both per-step bars and
  the cost, replacing four rows with no bars.
- A three-column summary band (workflows/verified/favourite pool/spent,
  busiest project/favourite model/median run) and the closing sentence.
- Colour throughout: sparklines orange, `✓`/`✗` green/red, run markers cyan,
  by-pool bars green, by-model purple, by-project orange, spent-per-day cyan,
  key figures orange, share/cost purple, secondary text dim.
- At 55 columns each tile is one row with its context inline (4 rows, not 10),
  and the `money:` note is shortened rather than wrapped to nothing.

### F3 — Run + Step (`dashboard-pages`)

- Replace **31 box-drawing rows with zero**: flat rules, and the
  `budget`/`live`/`so far` triptych on one row band of three 36-column rules.
- The plan strip gains branch topology (`─┬─ … ─┘`) where the plan has real
  fan-out, per-step progress bars, and the pool/model row under the steps; the
  linear `▶──○` stays the fallback where it does not.
- Step becomes a label/value table — Status, Pool, Purpose, Route, Time — then
  `── budget ──`, `── task · first lines ──`, `── output ──` with a live
  sparkline in the rule, `── artifacts ──`.
- The goal prompt no longer replays inside the timeline panel (7 wrapped rows),
  and `no expected duration recorded` is said once, not twice.
- `ETA —` and `spend —` keep their reasons: the runs record no expected
  duration and no per-attempt estimate.
- Colour: `running` cyan, `✓` green / `▶` cyan / `○` dim, per-step bars green,
  live sparklines cyan, budget percentages purple, phase rules dim.

### F4 — Stats Overview + Trends (`stats-pages`)

- The heatmap is sized to the history that exists (15 distinct V2 days today)
  with month labels and the prototype's four-shade ramp, replacing 5 cells per
  weekday row.
- The nine single-column figure rows become **three columns of four**, and the
  four absent figures come back where the data is real: most active day,
  current streak, longest streak, longest run — with the UK spelling
  `Favourite pool` / `Favourite model` the prototype uses.
- Trends: the stacked columns are coloured per pool (the only thing that makes
  a stack readable — today all eight legend marks are the same `█` in the same
  colour), the running-total row is drawn, and the legend is capped.
- Trend chips carry the prototype's words (`runs finished`, `verified share`,
  `spent`) and a `licence used` metric only where the meter history reaches.

### F5 — Stats Pools + Models + Projects (`stats-pages`)

- Pools: a real licence-per-day line chart with severity colour and a `▏ reset`
  marker, replacing seven identical full-width `█` rows that convey nothing.
- Models: a spend-per-day line chart, and a coloured `●` per model that keys
  the row to its line; the ok-rate returns beside the attempt count.
- Projects: a sparkline beside the project name and one context row per
  project (`11 runs · ✓ 91% · ≈ $5.10 API · 38m median`), not three.
- The `≈`/basis label shrinks but never disappears, and three pools that
  legitimately show `meter unavailable` keep their dotted track.

### F6 — Budget (`budget-page`)

- The percentage returns to the meter row (`% used` appears zero times on the
  page today), the meter is textured, and `Licence meter` loses its own row.
- Seven rows per pool: plan and window, meter, reset/pace, money, composition
  bar with its legend, biggest workflows **on one row**.
- The six page footnotes and the per-pool subscription reason — identical for
  all six pools — become one page footer, which is what fixes the phone: today
  one 26-row screen shows 1 pool and 10 rows of footnotes pinned to the bottom
  against the prototype's 3 complete pools.
- `Max 20x · $200/mo` (no declared price) stays a blank with its reason, and
  the meter band is capped at 64 columns so the extra width at 200 columns goes
  to the biggest-workflows row rather than to bar length.
- The period control stays the product's `p` cycle: the meter history keeps
  ~10 days, so there is no `This month` / `All time` tab (dashboard-0.33.md
  section 2.3).

### F7 — History (`history-page`)

- **Fixed columns** — mark, id, project, summary, then duration/cost/time
  right-aligned — replacing flow layout where the ellipsis lands in a different
  column on every row.
- The `✓`/`✗` result mark returns to the row start; marks and day totals take
  their colour.
- One row per run at 55 columns, where the pager currently proves 2 (and 3 for
  a running run).
- `API-equivalent estimate` (16 characters on every one of 85 rows) becomes
  `(≈ $X API)`, and the day rule with it.
- `unknown project` and `■ interrupted · no result recorded` are honest states:
  they get a one-row form, not removal.

### F8 — Fleet and F8b — Help

- Fleet: the sub-tab row on one line with the `[ edit ]` hint beside it, and
  cyan model names — `fleet-view.js` currently imports **nothing** from
  `dash-kit.js`.
- Help: keys that share a purpose go on one row (`r b s y f  →  Runs · Budget ·
  Stats · History · Fleet`), key names are bold, and the page drops from ~55
  rows to the prototype's ~30.
- Help's wording claims `Budget sub-tabs`, which the product does not have:
  say what exists.

### F9 — Docs + changelog (`docs-changelog`)

- `docs/guide/observing.md` and `README.md` describe the composition the pages
  now use, and what stayed a product blank rather than a prototype number.
- `CHANGELOG.md` carries the entry in the file's established voice. Do not bump
  `package.json`; `bullswarm release` owns the version.

## 4. Shared modules and the sequencing rules

Three shared modules several pages need, all delivered by F1 alone:

1. **The palette** — used by every page.
2. **A column layout helper** — Home, Run, Stats Overview.
3. **A compact phone row helper** — History, Home, Budget.

`src/workflow/dash-kit.js` and `src/workflow/usage-view.js` are touched by F1
and read by everything: **F1 lands first, alone.**

Two files force their page families together, and the program says so rather
than splitting them:

- **`src/workflow/dashboard.js`** carries Home, Runs, Run, Step and Help. The
  page functions are disjoint (`homePage` 2108, `runsPage` 2301, `runPage`
  2361, `stepPage` 2454, `helpPage` 2554) but it is one file with shared header
  and nav helpers (`pageTabs()` 1816, `navParts()` 1831), so it is **one
  territory**. The goal's Fleet-and-Help item is therefore covered by two
  writers: Fleet in `fleet-view.js`, Help in `dashboard.js`.
- **`src/workflow/stats-view.js`** carries both Stats page families behind one
  frozen `statsLines()` signature, so it is **one writer** holding two goal
  items.

Order: F1 alone; then F2/F3, F4/F5, F6, F7, F8 in parallel on disjoint files;
F8b travels with F2/F3 inside `dashboard.js`; then F9 against what shipped; a
digest condenses the seven writer outputs for the integrator, which runs alone
with no territory limit; the acceptance action then renders the real product to
PNG and judges it against the frames.

## 5. Keep the blank, never invent

Each of these is a prototype element with no real source on this machine, and
each keeps the product's blank-plus-reason:

| Prototype element | Why it stays blank |
|---|---|
| `ETA 19:03`, per-step `15m/17m` | the runs record no expected duration (`2 of 2 remaining steps recorded no expected duration`) |
| `Max 20x · $200/mo`, `$18.50 of $50 used`, `worth ≈ $212 at API rates` | `monthlyPriceUsd` is null on every pool: `no declared subscription price: claude-code, claude-code:wati, codex, grok, command-code, opencode2` |
| `2.7%` / `1.2%` per-run licence draw | `normalizedQuota.estimatedPercent` is null on 877 of 877 attempts |
| per-model `(52%)` share of a pool | no plan prices per model exist |
| months-wide heatmap, Budget `This month` / `All time` | the meter history keeps ~10 days; V2 history spans 15 days |
| `you, interactive` share, `7.7x` multiple | no CLI source; the share stays `workflows / rest` |

Two inputs are missing rather than blank, and the pass must not invent targets
for them:

- **No prototype frame exists for the Runs list.** It is not a requirement of
  this goal: the runs page keeps its behaviour and only adopts the shared
  vocabulary.
- **No prototype frame exists at 200 columns.** The owner's screenshots are a
  200-column window rendering the 120-column composition, so the 200-column
  judgement is "the extra width is not wasted on longer grey bars".

## 6. Validation and acceptance

Validate the program against the running kernel before any launch:

```bash
bullswarm workflow plan validate "$(cat /Users/cowcow02/Repo/bullswork/bullswarm-dashboard/docs/plans/dashboard-0.33-fidelity.goal.txt)" \
  --cwd=/Users/cowcow02/Repo/bullswork/bullswarm-dashboard \
  --program=/Users/cowcow02/Repo/bullswork/bullswarm-dashboard/docs/plans/dashboard-0.33-fidelity.program.json --json
```

Exit 0 is required, with the advisories quoted. Each writer runs `npm test`
and quotes the summary line; the baseline on this tree is **1112 pass, 0 fail**
(measured 2026-09-17 — the 918 in `dashboard-0.33.md` is the 0.32.0 figure and
is stale). Acceptance renders every page at 55x26, 120x40 and 200x50 with
`scripts/tui-shot.py` against a fixture home, places each PNG and text capture
beside its prototype frame and screenshot, and judges composition, density and
colour — not the presence of features, which the product already has.
