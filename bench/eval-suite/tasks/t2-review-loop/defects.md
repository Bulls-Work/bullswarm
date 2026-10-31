# Seeded defects (answer key — not part of fixture/)

All line numbers refer to `fixture/src/ranges.js`. Each defect is independent:
applying only that one to the correct file fails exactly its 3 hidden tests
(checked), and fixing it does not depend on any other fix.

| # | Kind | Where | Wrong behaviour | Correct behaviour | Hidden tests |
|---|------|-------|-----------------|-------------------|--------------|
| 1 | off-by-one | `daysIn`, line 115 | `end - start`, so a one-day range gives 0 | inclusive count, `end - start + 1` (one-day range = 1) | `daysIn:` x3 |
| 2 | boundary condition | `merge`, line 139 | `item.startDay <= current.endDay`, so ranges that touch (next starts the day after) stay separate | `item.startDay <= current.endDay + 1` | `merge touching:` x3 |
| 3 | wrong comparison | `subtract`, line 172 | `bEnd !== aEnd` also adds a right piece when b runs past a's end, producing an inverted range like `{start: bEnd+1, end: aEnd}` | add a right piece only when `bEnd < aEnd` | `subtract end:` x3 |
| 4 | wrong convention | `split` (week), line 202 | `weekdayOf(cursor)` counts days since Sunday, so pieces end on Saturday | `(weekdayOf(cursor) + 6) % 7` days since Monday, so pieces end on Sunday | `split week:` x3 |
| 5 | missing case | `daysInMonth`, line 65 | February is always 28 days, so Feb 29 is lost from month splits | `isLeapYear(year) ? 29 : 28` (2000 leap, 2100 not) | `split month leap:` x3 |
| 6 | missing step | `merge`, lines 133-134 | input is never sorted, so unsorted input merges wrongly or comes back unsorted | sort by start (then end) before merging | `merge unsorted:` x3 |
| 7 | missing validation | `parseRange`, lines 93-94 | end before start is accepted | throw `RangeError` when end is earlier than start (same day stays valid) | `parseRange order:` x3 |
| 8 | formatting | `format`, line 105 | day is not zero-padded (`2026-01-5`) | pad month and day to two digits | `format padding:` x3 |

Notes
- `isLeapYear` (line 59) is correct but unused in the fixture; the defect is that `daysInMonth` no longer calls it.
- `reference/src/ranges.js` is the fully corrected file; `reference/tests/regression.test.js` holds one regression test per defect.
- Expected scores: fixture `SCORE 8/32` (the 8 `happy:` tests pass), reference `SCORE 32/32`.
