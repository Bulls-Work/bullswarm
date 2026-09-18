# Budget verdict prototype frames

These are plain-text, no-code frames for the redesigned Budget verdict page. The
55-column frame is exactly 26 rows; the 120-column frame is exactly 40 rows.
Every enabled pool has a verbal verdict followed by one text meter bar. The
rows are ordered by urgency: grok (expiring soon), claude-code (ahead of pace),
claude-code:wati, codex, command-code, then the disabled pools. Disabled pools
are deliberately visible, including opencode, rather than looking like missing
data. There are no colour codes.

## Source snapshot (2026-09-18)

The required commands were run in this workspace:

```text
$ node bin/bullswarm.js pools
claude-code    weekly used 63% elapsed 53% [cache] surplus=-10 inflight=0 5h=3% (48% elapsed) ready
claude-code:petsona ... unmetered ... disabled
claude-code:wati weekly used 76% elapsed 92.3% [cache] surplus=16.3 inflight=0 ... resets in 12h55m EXPIRING-SOON urgency=212
codex          weekly used 59% elapsed 73.1% [cache] surplus=14.1 inflight=3 ready
echo           ... unmetered ... free=echo-local disabled
grok           weekly used 97% elapsed 99.2% [cache] surplus=2.2 inflight=1 ... resets in 1h25m EXPIRING-SOON urgency=33
command-code   monthly used 0.4% elapsed 3.6% [cache] surplus=3.2 inflight=0 ... ready
opencode       ... unmetered ... free=...:free disabled

$ node bin/bullswarm.js workflow usage --json
Usage: bullswarm workflow [<command>] [options]
```

The second requested command is not implemented in this checkout: it printed
workflow help to stderr and exited 2, with no usage figures. The plain `pools`
output marks readings as `[cache]` but prints no capture timestamp. Therefore
the frames say “sample age not printed” rather than inventing a freshness
number. The disabled opencode pool is shown explicitly in both frames.

## What Enter reveals

Enter on an enabled row opens its per-window detail: each available 5-hour,
7-day, or monthly window shows used percentage, elapsed percentage, reset text,
pace verdict, and in-flight count where the pool reports one. The command-code
row is monthly; the snapshot does not provide a reset time for every enabled
pool, so the detail keeps that field unavailable rather than guessing. Enter on
a disabled row shows its disabled/free reason and no licence meter.

## Design decisions

1. A word-first verdict (urgent, hot, watch, fine, disabled) tells the reader
   which licence needs attention before any percentage is read.
2. Each verdict owns one bar, with `#` for used and `-` for remaining; this is
   legible in a colourless terminal and keeps the comparison out of a wall of
   percentages.
3. The phone frame keeps details behind Enter and spends its rows on all pools;
   freshness is called out once in the footer instead of repeated per row.
