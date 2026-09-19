# Saved Spending frames

`spending-55.txt` and `spending-120.txt` are the Stats Spending tab rendered at
those exact widths from real rollups, with the colour codes stripped and
nothing else changed. They are regenerated, never transcribed:

```sh
cp -Rp ~/.bullswarm /tmp/bsw-frames
BULLSWARM_HOME=/tmp/bsw-frames node scripts/stats-frames.mjs docs/design/stats-frames-0.33.2
```

The copy matters: the generator refuses to read the live `~/.bullswarm`, and a
workflow writing into the live home while a frame is captured would make the
frame unreproducible.

Because the frames come from a real home, the figures move with the data. What
should not move without a code change is the layout: the 55-column frame is one
column of full-width panels, the 120-column frame is the dated chart on the
left and the two-by-two panel grid on the right, and no line exceeds its width
(the generator exits non-zero if one does).

Last regenerated 2026-09-19, after small readings stopped rounding down to an
empty bar: `codex` at 4.3%, `command-code` at 1% and `grok` at 6% now each draw
a one-cell sliver instead of a blank track.
