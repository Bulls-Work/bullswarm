# Runs table 0.35.4

The Runs page uses one row grammar for workflow runs and standalone tasks in
both the active section and dated history sections:

```text
status  id        project  what                         kind       time    cost      start
✓       gbnq62    bullswarm unify the Runs table         7/7 steps  1h34m   $65.56   09:10
✓       a938c8b5  portal    repair the customer import   task         26m  ~$25.87   08:00
```

The status vocabulary and palette are shared: `✓` succeeded/verified, `✗`
failed, `●` running, and the existing stopped/pending marks where applicable.
Workflow ids use their short id; task ids use the stable eight-character tail.
Projects use the same recorded-project/cwd derivation for both kinds. `what`
is the workflow goal or a task's first Markdown heading; without a heading it
is the first labelled subject line (`Outcome:`, `Goal:`, `Task:`, `Question:`,
`Problem:`, `Defect:`, `Bug:`, then `Deliver:`), and otherwise the first
sentence that is neither worker, workspace or worktree setup prose nor a
standing rule such as `Edit only …`, `Do not commit.` or `Never …`.
Missing legacy task text becomes a dim description from the recorded lane and
pool, such as `build task on codex`.

Time is active time. A legacy record that can prove only wall time keeps that
number in the same dimmed cell; the row never prints `span`. A legacy task's
start is reconstructed from its recorded finish and duration when the old
record omitted `startedAt`. Cost is one right-aligned, cents-only cell: `$`
provider-measured, `≈$` transcript-summed, `~$` estimated, `≥$` a known lower
bound, `<$0.01` for a positive sub-cent amount, and a dim dash when unknown.
The row does not spell out API, summed, estimated, unmeasured or unpriced.

The page computes one column layout from the active rows and every loaded day,
then shares it across every section. Loading older days may widen it. Project
is capped at 18 cells with an ellipsis. The description is elastic and
contracts first. If it reaches its useful floor, start drops, then kind, then
project. Status, the eight-cell id slot, time and cost remain at every width;
40–260 columns are one line per item with no overflow. At 55 columns the row
stays one line because keeping interleaving and numeric alignment is more
useful than a second description line.

Day rules always spell out `runs` and `tasks`. When a narrow rule cannot carry
every fact it drops the money first, then the unpriced count; it never
abbreviates the nouns to `r` and `t`.

The day rule is the only coverage sentence:

```text
── Mon 21 Sep ──── 6 runs · 7 tasks · ≥$374.85 · 3 unpriced ──
```

It sums workflow attempts and standalone tasks. Unknown attempts contribute to
the unpriced count, while the displayed amount remains the known lower bound.
Click and Enter resolve through the same row action, and hover reverses only
the row text. The cursor row is one inverse band: inside it only the status
glyph keeps its colour, because reverse video paints a coloured cell's text
colour as its background. Paging, search and active/all filtering are unchanged.

Reproducible frames are under `frames/`; run
`node scripts/render-runs-0.35.4-frames.mjs` to regenerate them from
`tests/fixtures/home-351` in the pinned Hong Kong timezone.
