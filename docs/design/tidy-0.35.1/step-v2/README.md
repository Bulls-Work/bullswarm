# Step page v2 — design record (0.35.1)

Owner-approved 2026-09-20. Source of truth for the `step-v2` writer. Frames in this
directory are exact terminal output at 55 and 200 columns, built from one real record: run `va7k9a`,
step `step-model`, attempt 1 (codex, gpt-5.6-luna). Times are Asia/Hong_Kong. The `*-running-*` frames
are that finished record drawn as it looked at its 202nd event (02:20 HKT). `*-detail-*` is turn 2
opened with Enter.

Frames: phone-finished.txt · desktop-finished.txt · phone-running.txt · desktop-running.txt ·
phone-detail.txt · desktop-detail.txt (55 = phone, 200 = desktop; 120 follows the desktop layout with
the right column at 40 columns, or stacks like the phone when the left column would drop under 72).

0.35.2 frames (rules 12–14), rendered by `scripts/render-tidy-0.35.1-frames.mjs` from the scrubbed fixture
`tests/fixtures/home-351` — the same 15-turn `step-model` step of run `va7k9a`, attempt 1, at 55 and 200:

| rule | before (0.35.1, kept as drawn) | after |
|---|---|---|
| 12 transcript | `0.35.2-before-detail-finished-{55,200}.txt` | `0.35.2-detail-finished-{55,200}.txt`, `0.35.2-detail-tool-open-{55,200}.txt` (Enter on turn 2's first tool row) |
| 13 latest turns | `0.35.2-before-overview-finished-{55,200}.txt` | `0.35.2-overview-finished-{55,200}.txt`, `0.35.2-overview-running-{55,200}.txt` (the attempt at its midpoint, following) |
| 14 toggle | the footer's `v detail (every event)` in the before frames | the activity rule of every after frame (heading word, then `overview · detail`) |

## Rules

1. **One header, said once.** Line 1 is the verdict: step, run, succeeded, verified. Line 2 is the purpose. Line 3 is pool · model · effort · reasoning on the left and the clock on the right. Nothing is repeated below it, and the toggle hint moved to the footer.
2. **One clock.** `49m07s · 01:50 → 02:39 HKT`. Span shows only when it differs from active time, as `49m07s active of 1h02m`.
3. **Turns are the unit.** A turn is one response and the tools that led to it. Each turn takes two rows on the desk, three on the phone: number, clock, up to two lines of response, then only the non-zero tool counts (`35 commands`, `14 commands · 3 edits`, `no tools`). On the desk the counts sit at the end of the second line; on the phone they get their own row. Zero segments never print.
4. **The last turn is the result.** Turn 15's response is the report, so the activity row says `→ shown under result` instead of printing it twice.
5. **Result reads like a summary card, from structured data only.** The report's first three non-empty lines (markdown links collapse to their label), then *changed* from the diff file's paths, *asks* only when the report carries the "Shared-file requests" heading the kernel prompt asks for, then *files* as the run directory once plus task · out · stream · diff. Nothing is parsed out of prose. Enter opens the full report. "verified true" became `verified by the workflow (6/6 requirements)`; a single run, which has no workflow verdict, says only succeeded.
6. **Every row has a source and an absence rule.** owns / after / affects come from the action record and vanish when empty (single runs). Token classes print only when non-null, so grok shows reasoning and Claude shows cache write. The plan row's reason and the "measured from…" line are word maps over the finite basis and tokenSource codes in usage-basis.js. The event count drops out when no stream was kept.
7. **Task shows the task.** The author's own first lines, then *owns*, *after*, *affects* as short facts from the program. The kernel wrapper (workspace rules, dependency artifact list, "read every dependency output…") lives behind Enter with its size stated.
8. **Cost in plain words.** Two rows, API rate and the pool's plan, each with its amount and one line of basis. An exact amount prints plain, an estimate gets `≈`, an unknown gets a dash with the reason (`no meter reading for this attempt`). With multiple attempts the rule says `cost · N attempts`, the API basis names each rate card once (for example `xAI + Anthropic rate cards, 20 Sep`), and a dim line under the API amount gives the selected attempt's share (`this attempt $28.21 · 45.95M tokens · Anthropic rate card`). A plan price belongs to a pool, never to an attempt: one pool shows its first recorded monthly price, while mixed pools show `plans — grok $30/mo · claude-code $200/mo` once each (or a dash when a price is absent). "budget —" is gone; "api" is never said twice; token classes sit under the amount in dim text.
9. **One filter control.** The activity rule ends with `showing turns · t to change`; pressing `t` cycles turns → tools → errors → all. Following is a single ● on the header line while the step runs.
10. **Desktop uses the width.** Activity takes the left 132 columns; result, task and cost stack on the right 65, so the whole finished step fits one screen at 200×50. The phone stacks in the order result → activity → task → cost, so the answer is on top and the task, which you already know, is at the bottom.
11. **Running steps lead with now.** The header says `running · 30m07s · turn 8 · last event 3s ago`; the result block says *not yet* and shows the last response; cost says it is measured when the attempt finishes rather than printing a guess.

### Added in 0.35.2 (owner, 2026-09-21)

[owner request, paraphrased] the detail view was too dense; it should list every turn, expand each turn to show its commands in a
scrollable list, and, on a phone with a 58-turn step, default to the last few turns because that is what matters in most cases.

12. **Detail is the transcript.** The detail view no longer lists atomic events in capture order. Its rule reads
    `── transcript · 15 turns · 120 commands · 35 edits · 0 errors ── showing all · t to change ──`, and below it
    every turn in order, each expanded: the head row (number, clock, first line), the rest of the response in
    full with its own line breaks, the turn's counts (dim), then one row per command or tool call exactly as an
    expanded overview turn draws it — `01:51:12  $ <command>` with its measured duration at the right edge, a
    spinner while it runs. The last turn prints in full here (rule 4 is an overview rule). Captures before the
    first response get a `before the first response · <counts>` row and their own tool rows. The page scrolls
    like any other. The cursor (inverse, as in 0.35.1) walks the turn heads and tool rows; Enter opens every
    field the 0.35.1 atomic rows printed for the captures behind the row — `seq · at · source · providerType`,
    then kind, status, eventId, turnId, toolCallId, tool, provider timestamp, duration, usage, parent/subagent,
    and arguments, result and summary in full (JSON pretty-printed, strings with their line breaks). A tool
    row stands for its call and its completion; a turn head for its response, streamed chunks and envelope
    captures; so every captured event is reachable from exactly the rows above. `t` narrows the transcript:
    `tools` keeps turns with tool rows, `errors` keeps only error rows and their turns.
13. **The overview opens on the latest turns.** The newest 10 turns on the desk, the newest 5 below 100 columns,
    newest at the bottom, the cursor on the newest. One dim line above them stands for the rest:
    `turns 1–10 · 95 commands · 25 edits · click for detail` (only non-zero classes, in the turn rows' order;
    `turn 1 · 3 commands · click for detail` for one). A narrow column drops count segments from the end, never
    `click for detail`. A click on it, or Enter with the cursor on it (Up from the oldest shown turn), opens the
    transcript at its top. While a running step is followed the window slides with each new turn; once the
    reader moves, it stays where it was and names what arrived below it (`turns 15–16 · f to follow`), Down past
    its newest turn slides it one turn, and `f` follows again.
14. **One visible toggle.** The toggle sits in the activity block's heading rule, straight after the heading
    word and before the counts — `── activity · overview · detail · 9 turns · 13 cmds · 0 edits · 0 err ──── showing
    turns · t to change ──` (the heading word is `transcript` in the detail view) — the current view inverted like
    the active tab. Owner, 2026-09-21: the toggle in the far top-right corner of the tab bar was hard to find; it
    belongs beside the activity label. Each word is a click region that switches to its view, hover lights the
    word's text only, and `v` still toggles. The top tab bar carries nothing of it. When the rule is too narrow the
    filter control and the dashes give way first (as in rule 9), then count segments drop from the end; the heading
    word and the toggle are never cut, at 55 columns included. The footer says `v detail (every turn in full)` in the overview and `v overview (latest turns)` in
    detail; Help lists `v · t · f` for the Step page and both clicks. Detail opens on the turn the overview's
    cursor was on (the page scrolled to it), or at the top from the fold line. Standalone tasks get the same
    page. A click on an overview turn head toggles it like Enter, and hover lights its own words only — never
    the padding or the right column; a click on a transcript row selects it and opens its fields.

## Layout numbers

- Desktop (≥ 160 columns): left column = width − 68; divider ` │ `; right column 65. Header rows span the full width.
- Turn row gutter: 12 cells = mark(1) + number right-aligned(2) + 2 spaces + HH:MM(5) + 2 spaces. Continuation rows indent 12.
- Response cap: 2 lines. Desktop appends ` · <counts>` to the second line, truncating the text with `…` to make room. Phone puts the counts on a third row.
- Counts: paired started/completed events count once; print only non-zero classes in the order commands · files read · edits · <named other tool> · errors; `no tools` when all zero. When "other tools" is a single kind, name it (`2 grep`).
- Final turn whose response equals the out file: row 2 reads `→ the report, shown under result`.
- Clock: `49m07s` (h/m/s, no decimals). `span` appears only when it differs from active: `49m07s active of 1h02m`.
- Cost: `API rate` and `<pool> plan` rows; amount plain when basis is exact/complete, `≈` when estimated, `—` when unknown; one basis phrase per row from a word map over the finite basis codes and tokenSource values (usage-basis.js); token classes only when non-null.
- Result: first 3 non-empty report lines (markdown links → label); `changed` = paths from the diff file; `asks` only when the report has a "Shared-file requests" heading; `files` = run dir once + task · out · stream (N events, when a stream exists) · diff. Single runs (no workflow verdict) show only succeeded/failed.
- Task: author prompt (action.prompt for workflow steps; the task body for single runs) 3 lines; `owns` / `after` / `affects` rows only when non-empty; `Enter on task: full text N KB · kernel wrapper N KB` from attempt.bytes when present.
- Keys: Enter expand/collapse turn (or open result/task when the cursor is there; on the fold line it opens detail; in detail it opens the row's captured fields) · Esc close · v overview · detail (also the toggle in the activity rule) · t cycle turns → tools → errors → all · f follow · Space page · ? help. Footer carries the hints once.
- Overview window (0.35.2): newest 10 turns at ≥ 100 columns, newest 5 below; fold line above, `· f to follow` line below a pinned window. Cursor stops: the fold line, then the window's turn heads.
- Transcript rows (0.35.2): head row (gutter 12) · response lines at indent 12 · counts at indent 12 · tool rows at indent 12 (clock `HH:MM:SS`, two spaces, `$ ` before a command, duration right-aligned). An opened row's fields sit at indent 12 on the desk and 1 on the phone, each field block indented 2 more.
- Toggle (0.35.2): `overview · detail` in the activity rule right after the heading word, before the counts (17 cells). Narrow rules shed the filter control and dashes, then count segments from the end; the tab row keeps only the tabs.
- Phone block order: header → result (or `now` while running) → activity → task → cost. Desktop: activity left; result → task → cost right.

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
| meta | clocks (`01:50`, `49m07s`, `01:50 → 02:39 HKT`), turn counts rows, `no tools`, row labels (`owns`, `after`, `affects`, `changed`, `files`, `API rate`, `<pool> plan`, `plans`), basis words (`OpenAI rate card, 20 Sep`, `no meter reading for this attempt`, `measured from the codex transcript`), `Enter …` hint lines, the footer hints, `↑ N earlier commands`, `→ the report, shown under result`, the fold line `phases 3–10 … · click to expand` and the `click to fold` line, the Step fold line `turns 1–10 · … · click for detail`, `turns 15–16 · f to follow`, `before the first response · …`, an opened row's `seq · at · source · providerType` line | dim | `dimText(text)` |
| money glyphs | `≈`, `~`, `—` | dim (the amount after them stays bold) | `dimText(glyph)` |
| block rules | the `──` dashes of `── activity · … ──`; the label between them stays plain | dim | `tint(dashes, 'dim')` |
| pool names | in `pool · model · effort`, the attempt mix (`codex 11 · claude-code 5`), the spend split (`codex $11.45`), timeline rows, the live rule | the pool's series colour, as Home's bars | `tint(pool, seriesColor(pool))` |
| model · effort · reasoning | `gpt-5.6-luna · medium effort · reasoning max` | plain | — |
| response text, task text, report lines, command text | — | plain | — |
| tool-row glyphs | `$` before a command, the `·` separators | dim | `dimText(glyph)` |
| plan glyph strip | each glyph by its phase state | green / amber / red / dim per the rows above | as above |
| cursor row | the selected turn, tool row, plan box or timeline row | inverse, as the tab row | `\x1b[7m … \x1b[27m` |
| tab row | unchanged | underline hotkey, inverse current tab | unchanged |
| view toggle | `overview · detail` in the Step activity rule | inverse current view, the other plain | `periodToggle` |

Tests pin, on a real snapshot frame at 200 and 55: the header `✓` and `verified` carry the green SGR, a running frame's `▶` carries amber,
one clock carries dim, one amount carries bold, one block rule's dashes carry dim, one pool name carries `seriesColor(pool)`, and the
response text of turn 1 carries no SGR at all. In ASCII mode the same frame carries only bold, dim and inverse.

Step page specifics: the `v`/`t`/`f` state words in the activity rule (`showing turns`) are meta; the result headline (first report line) is plain; the `cost` amounts are bold and their basis phrases dim; `Enter on result/task: …` lines are meta.
