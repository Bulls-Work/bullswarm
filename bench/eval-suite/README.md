# Biweekly eval suite

What every other-Saturday efficiency eval runs, so evals compare like with like
(order bs-eval, `fleet/mail-details/bs-eval-biweekly.md`). Two parts:

1. `scorecard.mjs`: the real-use scorecard for the last N days, read-only
   from Bullswarm's own records (`~/.bullswarm`) and, with `--orders`, the
   fleet's order files. Measured figures only; anything the records cannot
   give is printed as "not recorded" or "not measurable".
2. `run-bench.mjs` + `tasks/`: a frozen benchmark of four tasks, each with a
   fixture (what the agent sees), hidden tests, and a reference solution.

## Run it

```bash
# 1. scorecard (baseline: no --previous)
node bench/eval-suite/scorecard.mjs --days 14 --until <ISO> \
  --orders ~/Repo/second-mate-watcher/fleet/orders \
  --previous ~/Repo/bullswork/out/evals/<last date>/scorecard.json \
  --out ~/Repo/bullswork/out/evals/<date>

# 2. prove the kits (no Bullswarm, no quota)
node bench/eval-suite/run-bench.mjs --check-kits

# 3. benchmark (spends quota: route to the most underpaced pool)
node bench/eval-suite/run-bench.mjs --out <dir> \
  --run-flags "--use-provider=claude-code --avoid-pool=claude-code:kipwise,claude-code:wati" \
  --goal-flags "--worker-pool claude-code"
```

Compare a previous release by passing its binary with `--bullswarm <path>`.

## Tasks

| task | mode | exercises | hidden tests |
|---|---|---|---|
| t1-bounded-fix | `bullswarm run` | one bounded fix (CSV parsing) | 15 |
| t2-review-loop | program | find and fix 8 seeded defects with a dry review loop over 3 areas | 32 |
| t3-parallel | program | two parallel builds and an integration step (a ledger CLI) | 77 |
| t4-minisql | program | a long build (cut-down SQL engine) then a dry review loop | 141 |

The runner copies a task's `fixture/` to a fresh git repo, replaces `{cwd}`
in `prompt.md` / `program.json`, runs it, and scores it with `check.sh`
(hidden tests copied in after the run). Interventions count each time a run
stopped for a person: a run that came back, or a loop out of rounds, which the
runner ends with `workflow continue` (condition not met). It never rescues a
failed step.

## Rules for changing it

- Do not change a task, its hidden tests or a program between evals unless
  a kit is wrong; when you must, say so in this file with the first eval the
  change applies to, so trends are not compared across it.
- `t4-minisql/hidden/perf.test.js` has a 3 s CPU budget (wall time until
  2026-10-31, when it failed once under machine load).
- The scorecard definitions are printed at the top of its output; change
  them only with a note here.

## History

- 2026-10-31: first eval (baseline), Bullswarm 0.38.18. Results:
  `~/Repo/bullswork/out/evals/2026-10-31/`.
- Scorecard v2 (first applies to the next eval after 2026-10-31): adds
  "Review loops" (how each v3 loop ended; `continued` = ended by the caller
  after running out of rounds, `rounds-spent` = ended by itself under
  `--out-of-rounds end`) and saved stale warnings (`attempt.stale` events,
  saved from 0.38.19) with the limit that stopped each stalled attempt. All v1
  figures are unchanged; the trend shows the new ones as — against a v1
  scorecard. Re-run on the 2026-10-31 window it gives 16 loops ended by the
  caller of 49 and 0 saved stale warnings, as the report said.
- Scorecard v2 also counts every strict review (any run whose checked
  answer carries a boolean `passed`, whatever its goal says) and the review
  loops' reviewer answers inside workflows; the v1 "goal starts with Review"
  figures stay as they were. On the 2026-10-31 window: 97 strict reviews,
  first try 12/75 (16%); 397 loop reviewer answers, 4.52 findings each.
- t4 `perf.test.js` measures CPU time (`process.cpuUsage`) instead of wall
  time from the next eval on, with the same 3 s budget: under load the wall
  clock measured the machine. It passes with 8 busy processes running;
  `--check-kits` still gives fixture 0/141, reference 141/141.
