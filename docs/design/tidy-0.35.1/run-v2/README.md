# Run page v2 — design record (0.35.1)

Owner-approved 2026-09-20. Source of truth for the `run-v2` writer. `before-*.txt` is what
the release-0.35.1 renderer drew for run `8zgqei` at 15:44 HKT on 2026-09-20 (55 and 200 columns; the licence block
says "free model · no licence meter" only because the renderer was fed no pool meter). `after-*.txt` is the target,
built from the same record. Same grammar as the Step page v2 record in ../step-v2/README.md: reuse its helpers
(turn row, h/m/s clock, money words, footer) rather than writing new ones.

## Rules

1. **Header in the Step grammar.** One verdict line (`running · 18 of 20 steps done · 1 running · 1 waiting`) with the clock on the right as `6h02m active of 7h44m · since 07:59 HKT`; goal on one line, expandable; a third line with the attempt mix per pool and the project. No more `362.45m` or `18/20 actions`.
2. **The plan folds on the phone.** Thirteen boxes became one glyph strip `✓✓✓✓✓✓✓✓✓✓✓▶○` plus the running and next phase by name. `p` opens the boxes. On the desktop the boxes stay, but level phases are named by their steps ("five writers", "task-page · step-json") instead of "Parallel work".
3. **"live" shows the turn you would watch.** The running step's latest response as a Step-page turn row: number, clock, two lines, tool counts. Today that slot is an empty `↳ event` although the stream holds 151 events. Enter jumps to the step page.
4. **"so far" is gone.** Its steps and time were already in the header; its spend moved into one honest block.
5. **Spend tells the truth about partial data.** `API rate at least $92.25` with the per-pool split, `plans at least $1.99`, and the count of attempts that were measured, estimated, or still running. Today the same record shows `api unknown · sub unknown` next to "19 of 26 attempts measured" and a footnote saying no measurement exists.
6. **Timeline keeps the tree, loses the filler.** Each phase rule carries start → end, duration and done/total, so the "started" and "completed" rows go; one row per attempt with clock · glyph · step · pool · model · effort · duration. Phases between the first and the current fold into one line with their totals. The fold line ends `· click to expand` and opens on a click or Enter; the opened block ends with one dim `click to fold` line that folds it back. Truncated cells like `1/`, `(no meter/ca` and `ETA — —` disappear because nothing prints without room.
7. **The licence bars leave this page.** The five `≈ 4% of the weekly plan` bars are the pace estimate 0.35.2 will make real; until then Budget owns pool views and this page shows the run's own spend.

## Layout numbers

- Header: line 1 = `● <shortId> · <status> · <done> of <total> steps done · <n> running (<ids>) · <n> waiting (<ids>)` left, clock right (`6h02m active of 7h44m · since 07:59 HKT · 20 Sep 2026`; span omitted when equal to active; finished runs say `6h02m active of 7h44m · 07:59 → 15:44 HKT`). Line 2 = goal, one line at ≥120, two lines at 55, `…` truncation, Enter on it expands. Line 3 = `<n> attempts  <pool> <count> · …` left, `project <name> · <cwd>` right (desktop only).
- Plan: at <120 columns one row `plan  <glyph strip>  <phase n> <name> running · then <next>`; `p` toggles the boxes. At ≥120 the boxes as today, phase label = the step name when the phase has one step, else `<n> writers <done>/<total>` (two writers → `two writers`), with the step list on hover/select.
- Live band: at ≥120 two columns, live = width − 82, ` │ `, spend = 79. At 55 stacked: live then spend. Live rule = `live · <step> · <pool> · <model> · <effort> · <duration> · <turns> turns · <events> events`; body = the latest turn as a Step-page turn row (number, HH:MM, 2-line cap, non-zero counts appended on desktop / third row on phone), then `Enter → the step page · following ●`. When no stream exists: `no event stream kept for this attempt`. When nothing runs: the block is titled `last finished · <step>` and shows that step's final turn row.
- Spend: `API rate  at least $X` when any attempt is unmeasured or running, plain `$X` when all are measured, `≈$X` when every measured one is estimated, `—` when none; suffix words: `<n> estimated · <n> running · <n> unmeasured` (only non-zero). Desktop adds the per-pool split (`codex $11.45 · claude-code $55.56 · acme $22.55`; `≈` on estimated pools). `plans  at least $Y  <n> attempts with a meter reading · <n> without`. No licence bars, no `so far`, no ETA row.
- Timeline: phase rule `── <glyph> <n> · <name> ─── <start> → <end|now> · <duration> · <done>/<total>` (phone: rule line + a second dim line with the span). One row per attempt `HH:MM  <glyph> <step> · <pool> · <model> · <effort>[ · running]` with the duration right-aligned; phone drops model and effort. No `started`/`completed` rows. Phases between the first and the current-or-last two fold into `phases a–b · <steps> steps · <duration> · all ✓ · click to expand` (or `· <n> ✗` for `all ✓`); a click or Enter on it opens them in place and one `click to fold` line closes the block. Preflight keeps the `● goal accepted · goal.json` row only.
- Footer: `[ back ] [ ● 1.<shortId> ]  Enter open step · p plan boxes · Space follow · ? help`.

## Colour rules (approved 2026-09-21)

The pages paint with the helpers that already colour Home: `strong()` (bold), `dimText()` (dim), `tint(text, role)`
with the `METER_COLORS` roles in src/workflow/usage-view.js (`green #b6bd73`, `amber #e9c880`, `red #bf6c69`,
`purple #a99cf0`, `dim #7c7f8a`) and `seriesColor(pool)` from src/workflow/dash-kit.js for pool identity. Truecolour
is gated by `meterAnsi()`: when ASCII glyphs are preferred only bold, dim and inverse remain. Nothing else on
these pages carries an SGR code.

| element | examples | style | helper |
|---|---|---|---|
| good verdict | `✓`, `succeeded`, `verified`, `completed`, `verified by the workflow (6/6)` | green | `tint(text, 'green')` |
| running | `▶`, `●`, `running`, `following ●`, the spinner, `⠋ running 12m03s` | amber | `tint(text, 'amber')` |
| failure | `✗`, `failed`, `interrupted`, an error count above zero (`1 error`) | red | `tint(text, 'red')` |
| pending | `○`, `waiting`, `not yet` | dim | `dimText(text)` |
| identity | the step or task name, the run shortId, every money amount (`$0.96`, `at least $92.25`) | bold | `strong(text)` |
| meta | clocks (`01:50`, `49m07s`, `01:50 → 02:39 HKT`), turn counts rows, `no tools`, row labels (`owns`, `after`, `affects`, `changed`, `files`, `API rate`, `<pool> plan`, `plans`), basis words (`OpenAI rate card, 20 Sep`, `no meter reading for this attempt`, `measured from the codex transcript`), `Enter …` hint lines, the footer hints, `↑ N earlier commands`, `→ the report, shown under result`, the fold line `phases 3–10 … · click to expand` and the `click to fold` line | dim | `dimText(text)` |
| money glyphs | `≈`, `~`, `—` | dim (the amount after them stays bold) | `dimText(glyph)` |
| block rules | the `──` dashes of `── activity · … ──`; the label between them stays plain | dim | `tint(dashes, 'dim')` |
| pool names | in `pool · model · effort`, the attempt mix (`codex 11 · claude-code 5`), the spend split (`codex $11.45`), timeline rows, the live rule | the pool's series colour, as Home's bars | `tint(pool, seriesColor(pool))` |
| model · effort · reasoning | `gpt-5.6-luna · medium effort · reasoning max` | plain | — |
| response text, task text, report lines, command text | — | plain | — |
| tool-row glyphs | `$` before a command, the `·` separators | dim | `dimText(glyph)` |
| plan glyph strip | each glyph by its phase state | green / amber / red / dim per the rows above | as above |
| cursor row | the selected turn, tool row, plan box or timeline row | inverse, as the tab row | `\x1b[7m … \x1b[27m` |
| tab row | unchanged | underline hotkey, inverse current tab | unchanged |

Tests pin, on a real snapshot frame at 200 and 55: the header `✓` and `verified` carry the green SGR, a running frame's `▶` carries amber,
one clock carries dim, one amount carries bold, one block rule's dashes carry dim, one pool name carries `seriesColor(pool)`, and the
response text of turn 1 carries no SGR at all. In ASCII mode the same frame carries only bold, dim and inverse.

Run page specifics: the goal line is plain; the attempt-mix line paints each pool name in its series colour and the counts plain; `spend` amounts bold with `at least` dim; the live block's turn row follows the Step rules; phase rules paint their glyph by state and their dashes dim; the per-attempt duration column is dim.
