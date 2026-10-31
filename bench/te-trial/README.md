# TokenEconomizer (TE) trial harness

An A/B harness for trialling the TE Claude Code plugin on replayed, real bug fixes. One arm runs
one sequence of 8 tasks, in order, each in a fresh clone; the lead runs the paid sessions.
Nothing here calls a model: `run_trial.py` shells out to the `claude` on PATH, and only when you
start it without `--dry-run`.

## Run one arm

```
python3 bench/te-trial/run_trial.py --repo A --arm off \
  --tasks bench/te-trial/tasks/A --out /tmp/te/A-off \
  --plugin <TE plugin dir> --te-home /tmp/te/home-A-off [--model claude-sonnet-5-5] [--only 01,03] [--dry-run]
```

`--repo A` = bullswarm (node `--test`), `--repo B` = notion-in-claude (vitest); `--tasks` is the
matching folder under `tasks/`. Source repos are cloned from `/Users/cowcow02/Repo/bullswork/bullswarm`
and `/Users/cowcow02/Repo/notion-in-claude` (override with `--src`). Transcripts are read from
`~/.claude/projects/*/<session_id>.jsonl` (override with `--claude-home`). Use a different
`--te-home` per run; run the two arms one after the other, not at once (shared transcript dir
and CPU), and kill leftover processes from `<out>/pids-<nn>.txt` yourself.

Per task: fresh `git clone` into `<out>/work/<nn>` at the task's `parent` commit, `node_modules`
symlinked from the source repo; `claude -p "<prompt.md>" --model M --output-format json
--dangerously-skip-permissions` with cwd = the clone. Arm **on** adds `--plugin-dir <plugin>` and
`TOKENECONOMIZER_HOME=<te-home> TE_MICROSKILLS=on TE_TOOLPRUNE=auto TE_TOOLPRUNE_QUIET_MINUTES=0
TE_LOOPGUARD=nudge`. Arm **off** unsets every `TE_*` and `TOKENECONOMIZER_HOME`. The runner never
sets `CLAUDE_CONFIG_DIR`. Then the hidden check: `checkFiles` are copied in from `testsFrom` (the
red commit, else `fixCommit`) and `checkCmd` runs (only those files).

## Outputs

`results.jsonl` (one line per task), `summary.md`, `raw/<nn>.json` (claude's stdout), `pids-<nn>.txt`.

| field | meaning |
|---|---|
| `check_pass`, `check_exit`, `check_tail` | hidden check result and the tail of its output |
| `wall_sec`, `timed_out`, `claude_exit` | wall time of the `claude -p` call (timeout from `task.json`, default 1200 s) |
| `session_id`, `reported_cost_usd`, `usage`, `reported_turns`, `is_error` | from claude's JSON result (`total_cost_usd`, `num_turns`) |
| `cost_usd` | **transcript cost**: per assistant message id the LAST usage record, summed input / cache-write 5m / cache-write 1h / cache-read / output tokens, priced with the rate table in `run_trial.py` |
| `turns`, `transcript_stats.tool_calls`, `.tools` | assistant messages, and tool calls by name (deduped by tool_use id) |
| `redirects` | transcript lines (not assistant messages) that carry the loop-guard text `Process check (automated)`; on the on arm raised to the plugin's own nudge count if that is higher |
| `transcript_stats.plugin_context_lines` | non-assistant lines mentioning `TokenEconomizer` (any injected context or notice) |
| `plugin.*`, `plugin_overhead_tokens`, `plugin_nudges` | on arm: rows for this session in the plugin's `ledger.jsonl` (`session` and `overhead` records) and `events.jsonl` (action counts by kind) found anywhere under `--te-home`. Overhead is in the plugin's token units (`spiral_judge_tokens`, `spiral_nudge_writer_tokens`, `optimizer_tokens`, ...), **not dollars**: the ledger stores no dollar cost for side calls |
| `stray_pids` | processes whose command line contains `<out>/work/` or the te-home, after the task |

Rates (USD per million tokens) are read from Bullswarm's rate card,
`src/providers/claude-code/connector.json`: sonnet-5-5 input 2, cache read 0.1 (since 2026-10-07),
cache write 5m 2.5 / 1h 4, output 10; haiku-5-5 input 0.1, cache read 0.01, write 0.125 / 0.2,
output 0.5, and the long-context rates when one request's prompt is over 100,000 tokens. A model
not in the table is listed in `transcript_stats.unpriced_models` and priced at 0. Only the main session transcript is read; if a run spawns sub-agents their usage may be missing
from `cost_usd` (unverified here, no real session was run), so compare `cost_usd` with `reported_cost_usd`.

## Check it works

`python3 bench/te-trial/selftest.py` runs both arms against a fake `claude` and a throw-away repo
(clone, check, transcript cost, redirects, plugin overhead, summary, dry run) with no model calls.
`tools/verify_task.py <task dir> <source repo> <tmp dir>` redoes a task's red/green verification.

## Tasks

Each `tasks/<set>/<nn>-<slug>/` has `task.json` (`repo, parent, fixCommit, [testsFrom], checkFiles,
checkCmd, timeoutSec`), `prompt.md` (the ticket the agent sees) and `verification.json` (the
recorded red/green run). Verification: with `parent` checked out and `checkFiles` copied from
`testsFrom`, `checkCmd` **fails**; at `fixCommit` (same files) it **passes**; `package.json` and
the lockfile do not differ between parent and fix (so the shared `node_modules` is valid).
Tasks are ordered oldest to newest. Task 08 of set A is a red/fix pair (tests from the red
commit `f15c078`, fix `d3b6e6e`); the rest are single commits that touch src and tests.

Caveat: some hidden tests call a name or option that only the fix introduces (A01 `waitForRunMs`,
B01 `waitMs`, B08 `tablesAsCode`, A08's lock files). Their prompts state that interface as
part of the ticket; an agent that picks other names fails the check although its behaviour may
be right.

### Set A

| task | parent | fix | tests from | red at parent | green at fix |
|---|---|---|---|---|---|
| 01-watch-grace | `9b6cc42` | `58a9837` | `58a9837` | FAIL (exit 1) 1 of 8 tests fail | PASS (exit 0) |
| 02-ownership-glob | `c632190` | `6ca6c0a` | `6ca6c0a` | FAIL (exit 1) 1 of 6 tests fail | PASS (exit 0) |
| 03-integrate-skill-link | `25fa8ba` | `08b6502` | `08b6502` | FAIL (exit 1) 1 of 6 tests fail | PASS (exit 0) |
| 04-runs-summary-compact | `ab39bad` | `17c8efe` | `17c8efe` | FAIL (exit 1) 2 of 5 tests fail | PASS (exit 0) |
| 05-issue-watcher-tap | `cba4789` | `6e6dcc6` | `6e6dcc6` | FAIL (exit 1) 1 of 25 tests fail | PASS (exit 0) |
| 06-health-fresh-home | `a6325b1` | `1d27342` | `1d27342` | FAIL (exit 1) 1 of 12 tests fail | PASS (exit 0) |
| 07-tui-narrow-wrap | `c5b25cc` | `36c89b3` | `36c89b3` | FAIL (exit 1) 1 of 36 tests fail | PASS (exit 0) |
| 08-status-lock-holder | `84079ac` | `d3b6e6e` | `f15c078` | FAIL (exit 1) 3 of 12 tests fail | PASS (exit 0) |

### Set B

| task | parent | fix | tests from | red at parent | green at fix |
|---|---|---|---|---|---|
| 01-late-window-claude | `704f5a6` | `e4b4dcb` | `e4b4dcb` | FAIL (exit 1) | PASS (exit 0) |
| 02-csv-names | `f09d26e` | `02d3c45` | `02d3c45` | FAIL (exit 1) | PASS (exit 0) |
| 03-shortcut-key-names | `4fbf827` | `4aace81` | `4aace81` | FAIL (exit 1) | PASS (exit 0) |
| 04-activity-title-quotes | `9101d9b` | `3b30945` | `3b30945` | FAIL (exit 1) | PASS (exit 0) |
| 05-artifact-case-tags | `d88d47c` | `2ed1afd` | `2ed1afd` | FAIL (exit 1) | PASS (exit 0) |
| 06-restore-unloaded-rows | `2ff5f71` | `278f680` | `278f680` | FAIL (exit 1) | PASS (exit 0) |
| 07-stamp-needs-pages | `14647a0` | `c3445c1` | `c3445c1` | FAIL (exit 1) | PASS (exit 0) |
| 08-md-table-block | `886b44b` | `1c2167f` | `1c2167f` | FAIL (exit 1) | PASS (exit 0) |
