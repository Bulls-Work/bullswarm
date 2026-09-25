---
title: CLI reference
description: Every bullswarm command, subcommand, flag, and default, in the order bullswarm --help lists them.
---

# CLI reference

After this page you can invoke any `bullswarm` verb with the flags the running binary actually accepts, and look up a default without guessing.

There are exactly two ways to start work: `bullswarm run` dispatches one bounded task, and `bullswarm workflow goal` executes a program you author. Reach for a specific command's `--help` when this page and the binary might have drifted after an upgrade.

```bash
# Print the top-level command list, then one command's full help.
bullswarm --help
bullswarm run --help
```

`--help` / `-h` / a trailing `help` never reads or writes state, calls a network endpoint, or spawns a process. Every other command self-initializes `~/.bullswarm/state.json` (or `$BULLSWARM_HOME`) on first use. An unrecognized option prints `unknown flag --name` plus that command's synopsis and exits 2, before routing or spawning anything. Malformed values (a missing `--lane`, a `--limit` that is not a positive integer) are rejected at the same boundary with exit 2.

Bare `bullswarm` opens setup until the installation is configured, then opens
the dashboard. It accepts every option that setup documents. `--yes` on the
bare command skips the interactive wizard and auto-initializes with discovered
defaults (default: prompts on a TTY; auto-initializes for a non-TTY caller).

## The root dashboard

Once setup has completed, bare `bullswarm` opens the full-screen dashboard on
Home. `bullswarm --setup` or `bullswarm setup` opens the setup control centre;
`bullswarm workflow tui` is the explicit dashboard form. The dashboard has
Home, Runs, Run, Step, Budget, Stats, Fleet, and Help pages, and a five-tab row
— Home, Runs, Budget, Stats, Fleet. Home answers what happened today and what
is active; Runs is the `active` block over the day-grouped history table, plus
the product commands; Run and Step explain a workflow and one action; Budget
shows quota, measured worker-time share, and labelled money; Stats shows
period trends and pool/model/project breakdowns; Fleet shows lane/provider
rungs; Help names the controls. A sticky header and bottom nav keep the page
and run controls visible. The shared keys are `h` (Home), `r` (Runs), `b`
(Budget), `s` (Stats), `y` (the first day header of the Runs history table),
`f` (Fleet), `?` (Help),
`1`–`9` (open a run), `Tab` (sub-tabs), `Shift+Tab` (workflows), `p` (period),
`Esc`/`←` (back), arrows (one line), `PgUp`/`PgDn` (one screen), `Home`/`End`
(top/bottom), `ctrl+s` (copy), and `q` (quit). `Enter`/`→`/`l` opens the
selection. In 0.33.0, `r` no longer refreshes, `b` no longer moves out, `Tab`
no longer cycles workflows, and `h` opens Home rather than Help; the view
refreshes itself, Esc/left moves out, and Shift+Tab still cycles workflows.
Mouse reporting lets you click any tab, tile, bar, run, step, date, or control,
and the wheel scrolls the body.
The Claude Mod is this dashboard's read-only counterpart: its pane keeps only
Run, Step, and its Usage/Pools view; it does not expose the dashboard's Home,
Runs, Budget, Stats, Fleet, or Help pages, nor edit/install actions.

```bash
# main screen after setup
bullswarm

# open setup explicitly
bullswarm --setup
bullswarm setup

# explicit dashboard entry point
bullswarm workflow tui
```

## setup

Discover installed agent CLIs and initialize local routing state. Bare setup on a TTY opens the provider/model control center; agents and CI retain deterministic non-interactive setup.

```bash
# Non-interactive initialization plus skill install for Claude and Codex.
bullswarm setup --yes --integrate --agents claude,codex
```

| Flag | Meaning | Default |
|---|---|---|
| `--wizard` | open the question-based wizard for worktree, reasoning-depth, and integration settings | off; bare setup opens the provider/model control center |
| `--yes` | skip interactive setup and initialize with discovered defaults | interactive control center on a TTY |
| `--strategy` | discover models, set each pool's recommended model per effort tier (its rungs; no tier is pinned), and enable strategy autopilot; requires `--yes` | off |
| `--integrate` | also install agent integration (skill symlink + awareness block); requires `--yes` | off |
| `--agents <list>` | comma-separated agent list for `--integrate` (`codex`, `claude`, `grok`) | all three |
| `--json` | machine-readable result | human summary |

Writes `state.json` and `routing.json`. With `--integrate --yes`, also writes under `~/.codex`, `~/.claude`, `~/.grok`. A non-TTY caller auto-applies discovered defaults without prompting, even without `--yes`.

## home

Create a compact, dashboard-readable copy of a Bullswarm home without touching
the source. `home snapshot` copies routing, provider and meter state (including
meter history), connectors, calibration, the single-task ledger, and only the
selected workflow run directories. It then rebuilds each copied rollup and
`history/runs.jsonl`, so Home, Runs, and Stats describe the same trimmed set.

```bash
# Keep the three newest workflow runs and omit large per-attempt streams.
bullswarm home snapshot /tmp/bsw-snapshot --recent 3 --no-streams --json

# Select runs by their short ids instead.
bullswarm home snapshot /tmp/bsw-snapshot --runs ab12cd,ef34gh
```

| Flag | Meaning | Default |
|---|---|---|
| `--runs <shortId,...>` | comma-separated short ids or full `wf-...` run ids to copy | three newest workflow runs |
| `--recent <n>` | copy the newest `n` workflow runs | `3` |
| `--since <date>` | keep only runs started at or after an ISO/date-only bound; relative bounds such as `7d` are accepted | unbounded |
| `--no-streams` | omit `stream-*.jsonl` and `stdout-*.log` from copied workflow directories | keep them |
| `--json` | print destination, byte size, and the selected run list as JSON | human summary |

The destination must be new or empty and outside both the source home and the
live `~/.bullswarm`. Single-task records remain available in the copied
`state.json`, `assignments/`, and `runs/` surfaces; only workflow directories
are trimmed. Point inspection commands at the copy with `BULLSWARM_HOME`:

```bash
BULLSWARM_HOME=/tmp/bsw-snapshot bullswarm workflow tui --json --all
```

Snapshot destinations carry a small marker so `workflow tui --json` includes
the complete copied catalogue by default; ordinary homes retain the usual
ongoing-only default and need `--all` for historical runs.

### home prune

List or remove retained isolated-workspace copies from old terminal runs. Bare
`home prune` and `--dry-run` are read-only; deletion requires `--yes`.

```bash
bullswarm home prune --dry-run
bullswarm home prune --yes --days 7
```

| Flag | Meaning | Default |
|---|---|---|
| `--dry-run` | list eligible workspaces and bytes without removing them | on unless `--yes` is passed |
| `--yes` | remove the listed workspace copies | off |
| `--days <n>` | override `state.json.retention.workspacesDays` for this command | `7` |
| `--json` | machine-readable plan/result | human rows and summary |

Internal `--auto` and `--trigger` flags run the same guarded sweep from the
kernel, watch completion, or dashboard. Records, reports, streams, task/output
files, running/interrupted runs, and live kernel workspaces are never removed.

### home status

Print the effective retention policy, bytes currently held under workflow
`workspaces/`, and the last recorded `prune` and `reprice` maintenance results.
`--json` emits the same facts as a machine-readable object.

## integrate

Manage the packaged Bullswarm skill and a short recursion-safe awareness rule inside each installed coding agent's global configuration.

```bash
# Check which agents already have the skill and awareness block.
bullswarm integrate status
```

| Flag | Meaning | Default |
|---|---|---|
| `--agents codex,claude,grok` | restrict the action to specific agents | all three |
| `--json` | machine-readable output | human summary |

Install refuses to replace a non-Bullswarm file at the same path. `retire-legacy` renames, never deletes, the legacy skill directory.

### status

Report, per agent, whether the packaged skill symlink and the awareness block are installed, and whether a legacy pre-Bullswarm offload skill needs retiring.

```bash
# Machine-readable install report for every discovered agent.
bullswarm integrate status --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--agents codex,claude,grok` | restrict the report | all three |
| `--json` | machine-readable output | human summary lines |

Does not change agent integration files.

### install

Symlink the packaged skill and append the awareness block marker into each selected agent's global instructions file.

```bash
# Install for Codex and Claude. --yes is required.
bullswarm integrate install --agents codex,claude --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--agents codex,claude,grok` | restrict install | all three |
| `--yes` | required — approves writing global agent configuration | none; the command refuses without it |
| `--json` | machine-readable output | human summary |

Idempotent. Refuses to replace a non-Bullswarm skill path.

### remove

Remove only the Bullswarm-managed skill symlink and awareness marker block, leaving any other content in the agent's configuration untouched.

```bash
# Remove the managed symlink and awareness block for every agent.
bullswarm integrate remove --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--agents codex,claude,grok` | restrict removal | all three |
| `--yes` | required — approves editing global agent configuration | none; the command refuses without it |
| `--json` | machine-readable output | human summary |

A conflicting non-symlink path is left untouched, not deleted.

### retire-legacy

Recoverably archive the retired pre-Bullswarm `~/.claude/skills/offload` skill so it stops shadowing Bullswarm guidance for Claude.

```bash
# Move the legacy offload skill into ~/.claude/skills-archive/.
bullswarm integrate retire-legacy --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required — approves moving a user skill directory | none; the command refuses without it |
| `--json` | machine-readable output | human summary |

Renames into `~/.claude/skills-archive/`. A no-op if the legacy skill is not installed.

## run

Dispatch one bounded task to the best-available delegate pool (or keep it on the calling agent when nothing suitable is eligible), then verify the saved output before reporting a verdict.

```bash
# Route one analysis task and print the verdict.
bullswarm run --lane analyze --add-dir . "List every TODO comment in src/ with file:line"
```

Trailing `<task text...>` is mutually exclusive with `--prompt` and `--task-file`.

| Flag | Meaning | Default |
|---|---|---|
| `--lane <analyze\|build\|chore>` | routing lane: analyze (exploratory/large), build (implementation), chore (small/cheap) | required — omitting it, or passing anything else, exits 2 |
| `--add-dir <dir>` | working directory the delegate operates in | current directory |
| `--task-file <file>` | read the task text from a file instead of trailing words | unset |
| `--prompt <text>` | pass the task text inline as one flag value | unset |
| `--batch <tasks.jsonl>` | run each line of a JSONL file as its own single run and print one JSON array of the verdicts; see [Many tasks in one call](#many-tasks-in-one-call) | off — one task |
| `--concurrency <n>` | with `--batch`: how many tasks run at once | 4 |
| `--effort <high\|medium\|low>` | override the effort tier used for model-tier routing | derived from `--lane` (analyze→medium, build→medium, chore→low) |
| `--reasoning <low\|medium\|high\|xhigh\|max\|default>` | run-wide thinking-level override, clamped to what the picked pool's connector accepts; `default` passes nothing | strategy reasoning setting for the effort tier, else the connector default |
| `--timeout <seconds>` | hard wall-clock kill timer for the delegate process | none — the delegate is allowed to run to completion |
| `--heartbeat <seconds>` | print one compact progress heartbeat to stderr per interval without streaming delegate output | off |
| `--dry-run` | print the routing decision, the forecast, and the exact command that would be spawned, without spawning, registering an assignment, or writing the decision log | off (dispatches for real) |
| `--no-caller` | exclude the calling agent from routing, so the task must go to a delegate pool or fail | off — the caller competes for the lane like any other pool |
| `--avoid-pool <pool>` | route filter: never use this pool (its id or label); repeat the flag or give a comma list. See [Route filters](#route-filters) | none |
| `--use-provider <provider>` | route filter: use only pools of this provider; repeat or comma list | any provider |
| `--avoid-provider <provider>` | route filter: never use a pool of this provider; repeat or comma list | none |
| `--independent-of <run>` | route filter: never use the provider that ran an earlier run (its `outFile` or decision-log `id`); repeatable | none |
| `--json` | print the machine-readable verdict document | human-readable summary line |

One attempt only: a usage limit exits 1 with no retry, and the pool's meter is read again at once, so a window it shows at 100% keeps the pool out of later picks until that window resets. Nothing else about a failed pool is remembered. The JSON shape is in [Result envelope](/reference/result).

```bash
# Show the exact argv, including the clamped reasoning flag, without dispatching.
bullswarm run --lane build --add-dir . --reasoning max --dry-run --json "Refactor the loader"
```

### Route filters

Four flags narrow where one run may go, so your own code can decide who checks whom. They are the workflow step `route` as flags: `--avoid-pool` is `pools.avoid`, `--use-provider` and `--avoid-provider` are `providers.use` and `providers.avoid`, and `--independent-of` is `independentOf` for an earlier run.

```bash
# A writer, then a checker that never shares the writer's provider.
bullswarm run --lane build --add-dir . --json "Fix the date parser"   # note its outFile
bullswarm run --lane analyze --add-dir . --no-caller --independent-of ~/.bullswarm/runs/out-<stamp>.md --json "Review the date parser fix"
```

- **A provider** is the part of a pool id before `:`. `claude-code` and
  `claude-code:acme` are both provider `claude-code`.
- **Hard filters, before pace.** A pool they take out is not a candidate. The
  calling agent is held to them too: with `--use-provider grok` the caller
  cannot keep the task either.
- **Never widened.** When they take out every enabled pool, the run exits 1
  with `no pool left after route filters (<filters>): <pool> (<why>), ...`.
  A pool they keep that is switched off is named at the end
  (`; passes the filters but disabled: <pool>`). Nothing runs and nothing is
  logged. This holds with `--dry-run` too.
- **`--independent-of <run>`** reads this home's decision log. `<run>` is the
  `outFile` from the earlier run's `--json` verdict, or its decision-log `id`.
  Every pool of the provider that ran it is taken out. A run that is not in the
  log exits 2: it is still running, it stayed with the caller, it was only a
  `--dry-run`, or it is older than the last 500 decisions.
- **Names are checked.** A pool that is not configured, or a provider that no
  configured pool uses, exits 2. A pool label resolves to its id.
- **What you see.** The `--json` verdict carries `routeFilter`: `summary`,
  the resolved `avoidPools`, `useProviders` and `avoidProviders`,
  `independentOf` (`ref`, `id`, `pool`, `provider`, `outFile` for each earlier
  run), `left` (the enabled pools still in play), `filteredOut` (`pool`,
  `provider`, `why` for each pool taken out), `callerFilteredOut` when the
  caller was taken out, and `empty`. `routeWhy` ends with `· route: <summary>`,
  in the decision log too. Without `--json`, a `filtered out:` line lists the
  pools, the caller as `the caller <name>`.

### What a run records

A real dispatch (not `--dry-run`) writes two durable records, which is what makes
a single task visible on the dashboard alongside workflow runs:

- While it runs, an **assignment** in `~/.bullswarm/assignments/` with
  `source: "run"`, plus `project`, `cwd`, `taskFile`, `outFile` and `startedAt`. This
  is the row the `Runs` page shows in its `active` block and the Claude mod
  shows on its pane.
- When it finishes, a **decision-log entry** in `state.json` with
  `kind: "run"`. Alongside the pool, model, verdict and route it always
  recorded, the entry now carries `lane`, `taskFile` and `outFile`, plus `id`,
  `project`, `cwd`, `startedAt`, `endedAt` and `durationMs`. Those are the fields the
  `Runs` history day table and its task detail read; an entry written before
  them shows `—` for what it does not have rather than a guess.

### Free-model liveness probe

Before a real dispatch to a pool whose rung for this effort tier **names** a
free model, `run` sends the one-word prompt `PONG` through that pool's own CLI
and waits at most 30 seconds. The answer is cached per pool and model for 15
minutes in `$BULLSWARM_HOME/cache/free-model-probes.json`.

A pool that fails the probe is dropped from this pick with the reason
`probe: 404`, `probe: provider error` or `probe: timeout`, and routing falls through to the next eligible pool — the reason appears
in the run's `routeWhy`. A rung left on the connector's CLI default is never
probed, a paid model is never probed, no model catalogue is scanned, and a
replacement model is never chosen. `--dry-run` never probes: a preview does not
call a provider.

### Many tasks in one call

`run --batch` runs each line of a JSONL file as its own `run` and prints one
JSON array of the verdicts, in file order. Use it when your own code (a loop,
or the one agent a Workflow script uses to run commands) has many independent
tasks to hand out.

```bash
# Run every line as its own task, two at a time, and print one array of verdicts.
bullswarm run --batch tasks.jsonl --concurrency 2 --json
```

Each line is one JSON object:

```json
{"id": "auth", "lane": "analyze", "addDir": ".", "prompt": "Does src/auth.js check token expiry? Answer with file:line."}
{"id": "db", "lane": "chore", "taskFile": "tasks/db.md", "effort": "low"}
```

| Key | Meaning |
|---|---|
| `id` | required: a non-empty string, unique in the file; its verdict carries it |
| `lane` | required: `analyze`, `build` or `chore`, as `--lane` |
| `prompt` or `taskFile` | exactly one, as `--prompt` or `--task-file` |
| `addDir` | as `--add-dir` (default: the current directory) |
| `effort`, `reasoning` | as `--effort` and `--reasoning` |
| `avoidPool`, `useProvider`, `avoidProvider`, `independentOf` | the [route filters](#route-filters) `--avoid-pool`, `--use-provider`, `--avoid-provider` and `--independent-of`; each takes one value or a list. `independentOf` names a finished run, so not a line of the same batch |

Relative paths resolve against the current directory, as the flags do.

- **Checked before anything runs.** A line that is not a JSON object, a missing
  or bad value, a duplicate `id`, an unknown key, or a route filter that names
  no configured pool or provider or no finished run exits 2, with one message
  per problem. `answerSchema` and `answerFile` are refused the same way until
  `run` has `--answer-schema`.
- **Each task is a normal single run.** Same routing, same checks, same records
  (an assignment while it runs, a decision-log entry after), one attempt, no
  retry. A usage limit fails that task only.
- **At most N at a time** (`--concurrency`, default 4). Tasks start in file
  order, and each one is routed only after the task before it has booked its
  pool in the in-flight ledger, so routing sees the batch's own picks.
- **One array out.** Each element is that task's `run --json` verdict plus `id`
  and `exit` (the code a single run would have exited with). Exit 0 when every
  task is ok, 1 when any failed; the array says which. A task that routing keeps
  on the caller comes back `ok: true, keepOnClaude: true` and did not run.
- **Batch-wide flags:** only `--concurrency`, `--json`, `--no-caller`,
  `--timeout` and `--dry-run`, applied to every task. Any other `run` flag exits
  2: set it on each line. `--dry-run` previews each line on its own; previews
  book nothing, so they do not see each other.
- **No saved state.** A batch cannot be resumed. Work that must outlive the
  calling session belongs in `workflow goal`.

Without `--json` it prints one line per task (`OK <id> [pool] why`, then the
output file) and a total.

## health

Re-judge every saved delegate output against the real verify gate and report where a logged FAIL verdict re-judges as a pass (the "gate ate real work" signal).

```bash
# Re-judge saved outputs. Exit 1 means unhealthy, not a crash.
bullswarm health --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the machine-readable health report | human-readable summary of the same facts |

Reads every `out-*` file under `~/.bullswarm/runs/` and `state.json`, and never changes `state.json`.

## pools

Show every configured pool: cost rank, lanes, live meter usage/elapsed percentage, pace surplus, in-flight assignment count, projected 5-hour utilization, and whether a window is spent.

The 5-hour column reads `5h=<reading>%` alone when nothing is in flight and `5h=<reading>%-><projected>%` when in-flight work is expected to push the window further; routing decides on the right-hand number. A trailing `(<n>% elapsed)` is how much of that 5-hour window has already run. A pool whose weekly window resets within 24 hours, or whose monthly window resets within 3 days, ends its line with `resets in <Nd Nh|Nh Nm|Nm> EXPIRING-SOON urgency=<n>`.

The pool's status comes after the columns: `disabled`, or `ready` followed by
`BURST-GATED` when the 5-hour window is at 100% and `NEAR-5H-LIMIT` when it is
near its line. A weekly or monthly window at 100% keeps the pool out of routing
until that window resets; the meter column shows the pacing window's reading
(`weekly used 100%`).
After a usage limit whose forced meter read failed, the meter source reads
`[blocked · refused <age>]`: the pool counts as full until the reset the
provider named or an earlier reading gave. When nobody knows that reset it
reads `[refused <age> · reset unknown]` instead (with `used ?%`) and does not
keep the pool out. Nothing pauses or benches a pool, so there is nothing to
lift: a spent window comes back by itself when it resets.

A limit notice that says a usage window, a quota or a balance is spent is a
usage limit, with or without a reset named. In a workflow started by this
version it ends the step and comes back to you at once; its reset, when known,
is the `back at` time. A single `bullswarm run` makes one attempt and exits 1.
Either way the pool's meter is read again at once, and a window it shows at
100% keeps the pool out of later picks until that window resets.

Any other rate limit — `Error: Rate limit exceeded. Please wait a moment and try again.`,
`429 Too Many Requests`, an overload — backs off on the same pool at most twice
(20 s, then 60 s, or the wait it names when that is at most 2 minutes) and then
comes back to you; one that names a longer wait comes back to you at once, with
`back at` at the end of that wait. Nothing moves to another pool, and a single
`bullswarm run` exits 1 on it. In a workflow started by an earlier version the
attempt backs off and retries on the same pool, then moves to another pool for
that attempt only.

Quota and auth signatures are matched against the provider's own error channel:
its stderr, the events it flags as errors, and its terminal `result` record.
Never an assistant's reply or a tool result — a report that *quotes* a limit
phrase is not evidence about the pool.

```bash
# Bypass the meter cache and re-read live usage for every pool.
bullswarm pools --force
```

| Flag | Meaning | Default |
|---|---|---|
| `--force` | bypass the meter cache and re-read live usage for every pool | off (cached meter readings reused within their TTL) |
| `--json` | machine-readable `{ pools }`; each pool carries `inflight`, `spend` rates, `pacingWindow`, `paceResetsAt`, `resetSource` (`provider` \| `declared` \| `null`), and projected percentages | human-readable aligned table |

`--json` is also where the per-window numbers behind the `Budget` page live.
Each entry's `meterSnapshot` is the provider's own reply: `captured_at` (how
fresh the reading is), and one block per window it reported — `five_hour`,
`seven_day`, `monthly`, each with `utilization` and `resets_at` — plus the plan
fields Budget detects a price from (`plan_type`, `subscription_type`,
`rate_limit_tier`). A window the provider did not report is `null`, never zero.

```json
{ "captured_at": "2026-09-18T10:08:18.767Z", "pool": "claude-code:acme",
  "five_hour": { "utilization": 61, "resets_at": "2026-09-18T11:00:00.643684+00:00" },
  "seven_day": { "utilization": 84, "resets_at": "2026-09-18T18:00:00.643713+00:00" },
  "monthly": null, "plan_type": "team", "rate_limit_tier": "default_claude_max_5x" }
```

Never changes `state.json`. Reading the in-flight ledger prunes entries left behind by crashed processes (dead pids, or older than 12 hours).

## assignments

List the work in flight right now across every Bullswarm process — one line per live assignment with its pool, lane/effort, source, run/action, age in minutes, expected duration, and worker pid. This is the shared ledger `bullswarm pools` counts as `inflight=<n>`.

```bash
# One line per live assignment, including runs started by another terminal.
bullswarm assignments
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | machine-readable array of live assignment records (`pool`, `source`, `runId`, `actionId`, `kernelPid`, `workerPid`, `startedAt`, `elapsedMinutes`, `expectedMinutes`, `remainingMinutes`) | one human-readable line per assignment |

Reads `~/.bullswarm/assignments/` only — no meters, no network, no pool build.

## strategy

Open the provider/model strategy control center on a terminal, or run a subcommand non-interactively. Toggle whole providers, assign each detected model to any combination of high/medium/low effort, and preview the live route.

```bash
# Inspect providers, models, selections, meters, and effective routes.
bullswarm strategy inventory --json
```

`--json` is accepted on subcommands that support it. `refresh` / `apply` / `assign` / `clear-assignment` / `exclude-model` / `include-model` / `set-subscription` / `set-reasoning` / `reset-reasoning` / `set-rung` all mutate `state.json`. `refresh` (and a cold `show`) perform live discovery against every installed agent CLI and the public OpenRouter model API.

Concepts (rungs, allow-lists, autopilot) are in [Configuration](/reference/configuration).

### tui

Open the full-screen provider and model strategy control center. Analysis previews one OpenRouter-backed default per provider/tier before Y applies it. Enter on a provider opens its card: one row per effort tier with its reasoning level, an indented row for each model selected on that tier, then the model matrix. ←/→ on a tier row steps that provider's reasoning through auto, the levels its CLI accepts, and "CLI decides" (`default`), the same write as `strategy set-reasoning --pool`; on a model row it sets a level for that model only (`--pool --model`), which beats the tier row. `/` searches the models. Provider Space toggles, reasoning changes, and model-tier Enter toggles persist immediately; select Finish setup or press F to exit.

```bash
# Browse providers, models, effort tiers, meters, and effective routes.
bullswarm strategy tui
```

No flags. Bare `bullswarm strategy` on a TTY is the same control center.

### inventory

Return detected provider pools, models, selections, live meters, and effective routes for an agentic caller. The output is always JSON.

```bash
# Rerun model discovery and meters, then dump the inventory.
bullswarm strategy inventory --json --refresh
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | accepted so agents can pass it uniformly; it selects nothing | output is always JSON, with or without the flag |
| `--refresh` | rerun model discovery and meters | off |

Read-only apart from refreshing the cached discovery report.

### routes

Show the live effective choice for high/analyze, medium/build, and low/chore. The output is always JSON.

```bash
# Print the currently effective high/medium/low choices.
bullswarm strategy routes --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | accepted so agents can pass it uniformly; it selects nothing | output is always JSON, with or without the flag |
| `--refresh` | refresh meters first | off |

### rungs

List every rung: one pool's model plus its reasoning level for one effort tier, with the dated benchmark evidence for that exact pair and what this machine actually recorded for it.

```bash
# Machine-readable rungs for one pool.
bullswarm strategy rungs --json --pool codex
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | machine-readable rows (the same rows `strategy inventory --json` carries under `rungs`) | human table |
| `--pool <name>` | limit the table to one provider pool | every enabled pool |

Read-only: writes no state, spawns no model discovery, and downloads no meter or datapack. A rung with no benchmark row prints `no evidence`; one with no matching attempt prints `no dispatches`. Neither is ever estimated.

### set-provider

Enable or disable one detected provider/account as a whole.

```bash
# Take relay:b out of the routing set.
bullswarm strategy set-provider relay:b off --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required approval | none |

Arguments: `<pool>` (exact name from `strategy inventory`) and `<on|off>`. Changes routing immediately for new dispatches.

### set-model

Assign one model to one or more effort tiers.

```bash
# Put one model on every effort tier for the relay pool.
bullswarm strategy set-model relay a/gpt-5.6-sol --tiers high,medium,low --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--tiers <list\|off>` | comma-separated multi-selection or `off` | required |
| `--yes` | required approval | none |

A configured tier becomes an allow-list; leaving it with no enabled models makes that tier unavailable.

### set-rung

Set one rung — the model and the reasoning level a pool uses for one effort tier — in a single atomic state save.

```bash
# Move the codex high rung onto gpt-5.6-sol thinking at xhigh.
bullswarm strategy set-rung codex high --model gpt-5.6-sol --reasoning xhigh
```

Arguments: `<pool>` and `<tier>` (`high`, `medium`, or `low`).

| Flag | Meaning | Default |
|---|---|---|
| `--model <model>` | model to run on that tier; must appear in the pool's cached discovery unless `--force` | required |
| `--reasoning <level>` | `low`, `medium`, `high`, `xhigh`, `max`, or `default` | leaves the configured level untouched |
| `--force` | accept a model the cached discovery has not seen | off |

A rung is singular per pool and tier: the tier moves off whichever model held it, and that model keeps its other tiers. Never spawns model discovery — an unknown pool, tier, or model exits 2 instead.

### reset-tier

Remove the explicit model allow-list for one effort tier and return it to automatic routing.

```bash
# Restore low to automatic routing.
bullswarm strategy reset-tier low --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required approval | none |

Argument: `<high|medium|low>`. Removes that tier from every model selection and clears its legacy pin.

### set-reasoning

Set how hard one effort tier thinks. This is a separate dimension from the model.

```bash
# Every pool's high tier thinks at xhigh, clamped per connector.
bullswarm strategy set-reasoning --tier high --level xhigh --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--tier <high\|medium\|low>` | effort tier to configure | required |
| `--level <level>` | `low`, `medium`, `high`, `xhigh`, `max`, or `default` | required |
| `--pool <name>` | apply to one provider pool only | every pool |
| `--yes` | required approval | none |

A level a CLI cannot express is clamped down to the strongest level it accepts, never up.

### reset-reasoning

Remove configured reasoning levels so the affected tiers fall back to each connector's own defaults.

```bash
# Clear the low-tier reasoning override everywhere.
bullswarm strategy reset-reasoning --tier low --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--tier <high\|medium\|low>` | clear one effort tier everywhere | every tier |
| `--pool <name>` | clear one provider pool only | the global tier defaults too |
| `--yes` | required approval | none |

With no `--tier` and no `--pool` this clears every configured reasoning level at once. `--tier` alone also removes that tier from every per-pool override.

### configure

Atomically apply provider toggles, model tier combinations, and reasoning depth from an agent-authored JSON file.

```bash
# Validate and save a complete strategy document.
bullswarm strategy configure --file strategy.json --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--file <json>` | object with optional `providers`, `models`, and `reasoning` maps. `reasoning` is `{ "tiers": { "high": "xhigh" }, "pools": { "codex": { "high": "high" } } }` where each level is `low`, `medium`, `high`, `xhigh`, `max`, `default`, or `null` to remove it | required |
| `--yes` | required approval | none |

Validates the complete document before saving. An invalid reasoning section rejects the whole document; nothing is written.

### refresh

Run live model discovery against every installed agent CLI and recompute high/medium/low tier recommendations from capability and cost. `strategy recommend` is an alias with identical options and behavior.

```bash
# Discover models and print the report without changing routing.
bullswarm strategy refresh --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the full report as JSON | human-readable summary |
| `--apply` | also approve and persist the resulting recommendations; requires `--yes` | off (discovery only) |
| `--yes` | required alongside `--apply` — approves changing routing | none; `--apply` refuses without it |
| `--refresh-hours <n>` | auto-refresh cadence to record when combined with `--apply` | `24` |

Writes the report to `state.json`; with `--apply --yes` also writes each pool's recommended rungs, the reasoning level a suggestion carries (never over one you set), and enables the auto-refresh policy. It pins no tier: see [apply](#apply).

### apply

Approve and persist the most recently discovered recommendations (from the last `refresh` or `show`) without running discovery again.

```bash
# Persist the last refresh and enable autopilot at the default cadence.
bullswarm strategy apply --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required — approves changing routing | none; the command refuses without it |
| `--refresh-hours <n>` | auto-refresh cadence to record | `24` |

Writes each pool's recommended model per tier (`state.strategy.modelTiers`, the pool's rungs) and the auto-refresh policy. It never pins a tier, so every dispatch still picks its pool by spare quota and runs that pool's rung model and reasoning. `strategy rungs` shows the rungs; `strategy routes` shows what routing picks now.

Pins are explicit only: [`assign`](#assign) makes one and [`clear-assignment`](#clear-assignment) removes it. Apply keeps every pin you set (`keptPins` in its JSON). Versions up to 0.35.4 pinned every tier on apply and recorded that pin in `lastReport.suggestions[tier].assignment`. Apply and the auto-refresh remove such a pin when it still has the recorded pool and model (`unpinned`); a pin that differs from the record, or one from a home where apply never ran, is treated as yours and kept. The JSON also carries `rungs` (pool → tier → model) and `bestNow` (the tier-wide pick, for display only).

A suggestion that carries a reasoning level (a newest-generation fallback, such as `medium: gpt-6-luna · max reasoning — no gpt-6 terra yet, newest generation preferred`, or Grok's `low: grok-4.7 · medium reasoning — one Grok line, lighter reasoning for lighter tiers`) also has that level written into its pool+tier rung, marked as the recommendation's. A level you set per pool or per tier is never overwritten.

### show

Print the last captured strategy report (subscriptions, tier suggestions, exclusions). Runs a first discovery pass automatically if none is cached yet.

```bash
# Print the cached strategy report as JSON.
bullswarm strategy show --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the full report as JSON | human-readable summary |

Does not change routing. A tier line such as `high: codex/gpt-6-astra (best now; routing picks by spare quota)` names the best pick right now; it is not a pin. A pinned tier adds a line such as `pinned to claude-code/claude-opus-5 by you · high dispatches go there while it is available · strategy clear-assignment high removes it`. Models no family rule ranks are counted per pool on one line, `unranked: 312 models (command-code 180, opencode 130, grok 2) · never recommended · strategy show --json lists them`; `--json` keeps the full `unranked` list.

### assign

Pin one pool/model for an effort tier: dispatches of that tier go to that pool, running that model, while the pool is available, instead of the pool with the most spare quota.

```bash
# Pin high to a specific Claude model.
bullswarm strategy assign high --pool claude-code --model claude-opus-5
```

| Flag | Meaning | Default |
|---|---|---|
| `--pool <pool>` | connector/pool name to assign | required; no default |
| `--model <model>` | exact model identifier to assign | required; no default |

Argument: `<high|medium|low>`. Writes `state.strategy.assignments[tier]` as `{ pool, model, source: "user" }`, makes the model that pool's rung for the tier when the tier has rungs, and invalidates the cached report. A pin you set is never removed by `apply` or the auto-refresh; only `clear-assignment` (or `set-model`, `reset-tier`, `configure` for that tier) removes it.

### clear-assignment

Remove a tier pin, so dispatches of that tier go back to the pool with the most spare quota, running that pool's rung model.

```bash
# Release the high-tier pin.
bullswarm strategy clear-assignment high
```

No flags. Argument: `<high|medium|low>`.

### exclude-model

Persistently prevent this exact model from orchestration and worker dispatch, even if it would otherwise be recommended or assigned.

```bash
# Block gpt-5.4-mini from every dispatch.
bullswarm strategy exclude-model gpt-5.4-mini
```

No flags. Argument: exact model identifier. Reverse with `include-model`.

### include-model

Remove a previously persisted model exclusion.

```bash
# Unblock a previously excluded model.
bullswarm strategy include-model gpt-5.4-mini
```

No flags. Argument: exact model identifier.

### set-subscription

Record known subscription pricing for a pool so refresh's value-multiple math is accurate, choose the quota window routing paces this pool by, and declare when that window ends for a provider that reports usage but no reset date.

```bash
# Record plan economics, then declare a refill date a wallet does not report.
bullswarm strategy set-subscription claude --plan max --monthly-usd 200 --included-usd 1000
bullswarm strategy set-subscription opencode --resets-at 2026-09-17T01:46:01Z
```

| Flag | Meaning | Default |
|---|---|---|
| `--plan <name>` | plan label to record | unchanged |
| `--monthly-usd <n\|unknown>` | monthly subscription price | unchanged |
| `--included-usd <n\|unknown>` | estimated included usage value | unchanged |
| `--quota-window <weekly\|monthly>` | the subscription window that paces routing for this pool (used% vs elapsed% of it); `unknown` clears it back to the connector default | unchanged |
| `--resets-at <iso\|unknown>` | the date-time this pool's quota window next ends, used only when the provider reports usage but no reset; a provider-reported reset always wins; `unknown` clears it | unchanged |

Writes `state.strategy.subscriptions[pool]` and invalidates the cached report.

### auto

Inspect or disable the policy that re-applies discovery recommendations automatically on a cadence, set by a prior `apply` or `refresh --apply`.

```bash
# Show whether auto-apply-on-refresh is enabled and its cadence.
bullswarm strategy auto status
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required for `off` — approves changing routing policy | not needed for `status` |

`auto status` is read-only. `auto off --yes` writes `state.strategy.policy` and keeps the last-applied rungs, and any pins you set, as-is.

## provider

Manage providers, the plugins that define pools. A provider is a directory with a `connector.json` and/or a `provider.mjs`. Bare `bullswarm provider` runs `list`. Loading is not routing: whether a loaded pool gets work stays `bullswarm strategy set-provider <pool> on|off --yes`.

```bash
# See what loaded and what failed.
bullswarm provider list
```

The contract is [Providers](/reference/providers).

### list

Show every provider — first-class, contrib, and local — with its tier, whether it is loaded, the pools it returned, the pools the loader skipped, its load error, and whether it exports `readUsage`.

```bash
# Machine-readable provider table.
bullswarm provider list --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the report as JSON | human table |

Read-only; loads every provider module and calls `connectors()` for the loaded ones.

### enable

Load a contrib provider: add its directory name to `~/.bullswarm/providers.json`. Its pools appear on the next bullswarm start.

```bash
# Load the shipped command-code contrib provider.
bullswarm provider enable command-code
```

No flags. Argument: a directory name under `providers/contrib/`. Refuses a name with no contrib directory, and a name a local provider already claims. Writes `providers.json` only; `state.json` is never touched.

### disable

Stop loading a contrib provider: remove its name from `~/.bullswarm/providers.json`.

```bash
# Unload a contrib provider. A name that is not listed writes nothing.
bullswarm provider disable command-code
```

No flags. Argument: a contrib provider name listed in `providers.json`.

### validate

Import a provider directory, check name and the export types, call `connectors()` with the real shipped templates, and check the prefix rule and every returned pool against `src/providers/_schema.json`.

```bash
# Check a local provider directory against the contract.
bullswarm provider validate ~/.bullswarm/providers/relay
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the report as JSON | human report |

Argument: a provider directory path, or a provider name looked up in the local, contrib, then first-class directories. Runs the module and `connectors()`; never spawns the CLI or reads usage. Exits 2 on any failure; warnings alone exit 0.

### scaffold

Write a commented provider directory: a `provider.mjs` skeleton showing every export and, with `--from`, a `connector.json` copied from that shipped template and renamed. The result passes validate unchanged.

```bash
# Scaffold a reseller that runs through OpenCode.
bullswarm provider scaffold relay --from opencode
```

| Flag | Meaning | Default |
|---|---|---|
| `--from <template>` | copy this shipped provider's `connector.json` (a reader meter is set to `none` until you export `readUsage`) | no `connector.json`; the pool is written inline |
| `--dir <path>` | the provider directory to create | `~/.bullswarm/providers/<name>/` |

Argument: provider name (lowercase letters, digits, and dashes). Writes only inside the target directory, and refuses one that already exists and is not empty.

### probe

Spawn one pool's CLI directly with the task "Reply with the single word PONG and nothing else" through the dispatcher's own runner, then, when its provider exports `readUsage`, read usage once with the pool's declared subscription.

```bash
# Acceptance step: spawn the CLI once and print argv, output, elapsed time, snapshot.
bullswarm provider probe relay:b --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the result as JSON | human report |
| `--timeout <sec>` | kill the CLI after this many seconds | `300` |

Argument: a pool name; contrib providers are probed even when not enabled. Spawns in a throwaway directory with no routing, quota gate, or assignment ledger, and ignores `BULLSWARM_DEPTH`. Values from the pool's `env` are redacted. Exits 1 when the reply does not contain `PONG` or `readUsage` threw.

## doctor

Report installation readiness — config present, at least one agent CLI discovered, meters reachable, at least one delegate pool enabled — with the exact fix command for anything failing. The `connector-copies` check warns (`!`, never a failure) about an edited copy of a packaged connector that an install older than 0.29.0 left in `<home>/connectors/`, naming its stale fields and whether it is read at all.

```bash
# Machine-readable { version, configured, ok, checks[], nextActions[] }.
bullswarm doctor --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | machine-readable `{ version, configured, ok, checks[], nextActions[] }` | human-readable checklist with ✓/!/✗ per check |

Self-heals: if `~/.bullswarm` is not yet configured, runs the same auto-setup as any other verb before reporting. Exit code is 0 when every check passes, 1 if any check fails.

## workflow

Plan, execute, observe, and audit durable multi-agent workflows with the single V2 action/evidence engine. With no command on a TTY, opens the unified full-screen workflow home. Non-interactive callers receive this help text instead.

```bash
# Author plan.json from `workflow plan contract`, then launch.
bullswarm workflow goal "1. Fix the parser. 2. Verify it." --cwd . --program plan.json
```

Legacy authored-graph runs are read-only; driving commands fail closed before dispatch. Goal dispatches real coding-agent CLI processes and writes durable state under `~/.bullswarm/workflows/<runId>/`. How to author a program is in [Workflows](/guide/workflows); the JSON fields are in [Workflow program](/reference/program).

### goal

Run an autonomous V2 goal end to end. Pass the program you authored (`--program`) and the kernel validates it against the exact requirements, schedules the dependency graph in a shared workspace, and returns every action result. File territories guide coordination; exact-file enforcement and worktree copying require `--isolation`. Completion means all actions succeeded; verified separately reports requirement evidence. There are no automatic gap rounds.

Without a program the command refuses (exit 2, nothing launched) unless `--scout` or `--orchestrator` is given. `--scout` alone surveys the repository and finishes partial with the scout report. `--orchestrator` dispatches a Workflow Planner agent instead of planning yourself. A run never waits for its caller: when nothing more can run on its own it finishes and hands back what is left.

In a run started by this version the dispatched planner and the scout follow the steps' usage-limit rule: a usage limit, a rate limit still there after its short backoff, or no free pool stops it and tells you, with no move to another pool, and a nearly spent pool is never given to it. The watch prints `✗ planner stopped · <label> on <pool> · back at <time>` for the planner, and the run finishes `partial` with `the workflow planner stopped on a usage limit: <why> · back at <time> · your call: resume after <time> with bullswarm workflow resume <shortId>, plan it yourself with bullswarm workflow plan revise <shortId> --program <file.json>, or start a new run` (`the preflight scout stopped on a usage limit: …` for a scout with no program after it; `bullswarm workflow resume <shortId> once a pool is free` when no return time is known). After the `back at` time, `resume` runs the stopped planner or scout again and prints `✓ reopened the partial run <shortId>; running again: the workflow planner` (or `the preflight scout`); before then it can stop the same way, and resume adds a `note:` saying so. `plan revise` with your own program and a new run stay the other choices. A scout before your own program lets the run go on without its report, `watch` prints `⚠ preflight scout stopped · …`, and `resume` does not run that scout again. Any other planner failure still prints `× planning attempt rejected · <why>`. A sign-in failure, a provider error or a worker that died at start still moves the planner or the scout to another pool.

Launches independently by default. `--resume <shortId|runId>` resumes a V2 run and is mutually exclusive with new goal text.

A duplicate launch is refused before anything is validated or started: when an ongoing run in the same `--cwd` already has this goal text, the command exits 2 with that run's `shortId`, its age, and the command to watch it. `--json` prints `{"error":"duplicate-goal","shortId":…,"runId":…,"startedAt":…,"next":{"watch":…,"again":…}}`. Pass `--again` to start the second copy anyway.

```bash
# Caller-planned launch that follows progress until terminal.
bullswarm workflow goal "1. Fix src/parser.js. 2. Update docs." --cwd . --program plan.json --watch
```

| Flag | Meaning | Default |
|---|---|---|
| `--cwd <dir>` | working directory the goal executes in | current directory |
| `--isolation` | opt into per-worker worktrees and strict exact-file ownership checks; saved runs retain their original workspace policy on resume | off (shared workspace, advisory territories) |
| `--watch` | immediately follow low-noise progress until terminal; only valid for a new human-readable independent launch — cannot combine with `--detach`, `--foreground`, `--json`, `--resume`, or `--request` | off |
| `--foreground` | keep execution attached to this terminal instead of detaching | off (detaches into a background process) |
| `--json` | print the launch/report document as JSON | human-readable launch instructions |
| `--program <file.json>` | planner-response envelope or bare `bullswarm.workflow.program.v2` document; validated before anything launches (exit 2 with the issues when invalid) | required unless `--scout` or `--orchestrator` is given |
| `--summary <text>` | one-line summary recorded for a bare `--program` document | derived from the action purposes |
| `--scout` | with `--program`: run the kernel scout first and hand its units as advisory context; alone: survey, then finish partial with the scout report | off |
| `--orchestrator <auto\|pool>` | dispatch a Workflow Planner agent at every planning boundary: `auto` lets the kernel route it, a pool name prefers that pool and falls back when it is already quota-gated or unavailable at the pick; in a run started by this version a usage limit it hits while it plans stops the run instead | off (you are the planner) |
| `--orchestrator-model <model\|auto>` | with `--orchestrator`: pin the exact model used by the dispatched planner; only pools that can guarantee it remain eligible | `auto` (effort-tier strategy or connector default) |
| `--orchestrator-strict` | with `--orchestrator <pool>`: require exactly that pool; fails if it is unavailable rather than silently substituting | off |
| `--strict-orchestrator <pool>` | deprecated alias for `--orchestrator <pool> --orchestrator-strict` | off |
| `--suggested-plan <text>` | with `--orchestrator`: persist a caller-imagined conceptual execution shape for the dispatched planner | none |
| `--worker-pool <pool\|auto>` | pin every non-planner dispatch, including scout, work actions, and evidence actions, to one pool | `auto` (normal routing) |
| `--worker-model <model\|auto>` | pin the exact model for every non-planner dispatch; only pools that can guarantee it remain eligible | `auto` |
| `--worker-reasoning <level>` | run-wide reasoning depth for every non-planner dispatch: `low\|medium\|high\|xhigh\|max`, or `default`; a per-action `reasoning` field outranks this; clamped to the picked connector | the configured strategy level, else the connector default |
| `--planner-reasoning <level>` | with `--orchestrator`: the same run-wide reasoning depth for every dispatched Workflow Planner turn | the configured strategy level, else the connector default |
| `--max-agents <n>` | soft planning target for total scout, planner, work, evidence, and correction dispatches; essential work may exceed it | `30` |
| `--max-expansion-rounds <n>` | legacy planning target retained for compatibility; new programs do not generate gap rounds | `2` |
| `--max-actions <n>` | soft planning target for total actions across planner revisions; essential actions may exceed it | `100` |
| `--no-scout` | with `--orchestrator`: skip the read-only repository reconnaissance before the dispatched planner creates its first program | the scout runs first for a dispatched planner |
| `--concurrency <n>` | max parallel dispatches; dependency-ready file-disjoint actions run concurrently up to this cap | `4` |
| `--retry-attempts <0..3>` | automatic retries per step before it comes back to you; a process failure retries elsewhere, a gate failure retries on the same pool with its failure attached | `1` |
| `--resume <shortId\|runId>` | resume a V2 autonomous run; old autonomous runs fail closed before dispatch | starts a new goal |
| `--detach` | rarely needed — explicitly requests the default independent-launch behavior; cannot combine with `--watch` | the default launch already detaches |
| `--again` | start another copy even when an ongoing run already has the same goal text in the same `--cwd`; only a new launch is checked, never `--resume` or the internal `--request` relaunch | off (a duplicate of an ongoing goal is refused) |

Workers keep their edits even when their action fails. Failed dependencies skip downstream actions and independent branches finish. Saved V2 runs keep their original completion and isolation policy when resumed.

### plan

You are the Workflow Planner. `contract` prints the planning contract for a goal before any run exists; `validate` checks a program against that contract without launching; `export` and `revise` change the plan of a live or finished run. `show` and `submit` answer only a run an older version left waiting for its caller. Launch the initial program with `workflow goal --program`.

```bash
# Print the contract, then dry-run a program, then launch with the same goal text.
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json
```

### plan contract

Print everything a caller planner needs to author a valid initial program: requirement IDs, read-only constraints, planning rules, generic action fields, validation, the response envelope, and one worked example.

```bash
# Derive requirement IDs from numbered clauses and print the contract as JSON.
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--cwd <dir>` | working directory the goal will execute in | current directory |
| `--isolation` | describe strict per-worker worktree isolation and retain the flag in launch guidance | off (shared workspace) |
| `--json` | accepted for consistency; the contract is always printed as JSON | JSON |
| `--max-agents <n>` | advisory dispatch target recorded in the contract settings | `30` |
| `--max-actions <n>` | advisory action target recorded in the contract settings | `100` |
| `--max-expansion-rounds <n>` | advisory gap-round target recorded in the contract settings | `2` |
| `--concurrency <n>` | execution concurrency recorded in the contract settings | `4` |
| `--retry-attempts <0..3>` | automatic retries per step recorded in the contract settings | `1` |
| `--scout` | describe a kernel scout ahead of your program and retain the flag in launch guidance | off for a caller-authored program |
| `--worker-pool <pool\|auto>` | pin the worker pool the contract echoes back | `auto` |
| `--worker-model <model\|auto>` | pin the worker model the contract echoes back | `auto` |
| `--worker-reasoning <level>` | run-wide worker thinking level the contract echoes back | the strategy setting for the action effort tier |

Read-only. Rejects launch-only and dispatched-planner flags (`--program`, `--orchestrator*`) so the contract cannot silently describe a different run.

### plan validate

Check a program you authored against the exact contract a launch would enforce, without creating a run. Exit 0 prints the accepted actions and the launch line; exit 2 prints every validator issue.

```bash
# Same validator as workflow goal --program; nothing is launched.
bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--program <file.json>` | planner response envelope or bare `bullswarm.workflow.program.v2` document | required |
| `--cwd <dir>` | working directory the goal will execute in (must exist) | current directory |
| `--summary <text>` | one-line summary recorded for a bare program document | derived from the action purposes |
| `--json` | print the acceptance document (`{action: "plan-valid", requirements, program, next}`) or the refusal (`{error: "program-invalid", issues, next}`) | human summary |
| `--isolation` | validate against strict per-worker worktree isolation | off (shared workspace) |
| `--scout` | validate against a run that scouts before your program | off for a caller-authored program |
| `--worker-pool <pool\|auto>` | pin the worker pool the preview routes with | `auto` |
| `--worker-model <model\|auto>` | pin the worker model the preview routes with | `auto` |
| `--worker-reasoning <level>` | run-wide worker thinking level for the preview | the strategy setting for the action effort tier |
| `--max-agents <n>` | advisory dispatch target for the previewed run | `30` |
| `--max-actions <n>` | advisory action target for the previewed run | `100` |
| `--max-expansion-rounds <n>` | advisory gap-round target for the previewed run | `2` |
| `--concurrency <n>` | execution concurrency for the previewed run | `4` |
| `--retry-attempts <0..3>` | automatic retries per step for the previewed run | `1` |

Read-only. Exit 0 valid, 2 invalid, 1 bad cwd.

### plan show

For a run an older version left waiting for its caller (current versions never wait), print the durable planner request it left. Exits 1 when the run is not waiting for a submission.

```bash
# Print the pending planner request of a waiting run.
bullswarm workflow plan show ab12cd --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the full request document | compact human summary |

Never changes run state, except it may rewrite the request document so it lists steering queued since the pause (`requestRefreshed: true`).

### plan submit

Submit your planner response to a run an older version left waiting. Current versions never wait; change a current run with `plan revise`. `--exhausted` records that no useful bounded action remains (gaps boundary only).

```bash
# Accept a follow-up program and relaunch the waiting kernel.
bullswarm workflow plan submit ab12cd --program plan-2.json --watch
```

| Flag | Meaning | Default |
|---|---|---|
| `--program <file.json>` | planner response or bare program with the new actions only | none |
| `--exhausted` | declare that no further useful bounded action exists; valid only at a gaps boundary | off |
| `--reason <text>` | required with `--exhausted` | none |
| `--summary <text>` | one-line summary recorded for a bare program document | derived from the action purposes |
| `--foreground` | resume the kernel attached to this terminal; combines with `--json` | off (detaches) |
| `--watch` | detach, then follow until terminal or paused; cannot combine with `--foreground` or `--json` | off |
| `--json` | print the acceptance and relaunch document (or, with `--foreground`, the final result) | human summary plus operating commands |

A rejected program exits 2 and leaves the run untouched. A run with a pending cancellation refuses every submission.

### plan export

Write the live plan of a program-mode run as an editable revision document: every action still in the plan, `baseRevision`, and pending steering ids. Works while agents run, while paused, or after the run finished.

```bash
# Write the live plan so you can edit it and pass it to plan revise.
bullswarm workflow plan export ab12cd --out plan.json
```

| Flag | Meaning | Default |
|---|---|---|
| `--out <file.json>` | write the revision document to this file and print a status summary | print the revision document itself on stdout |
| `--json` | print `{programRevision, status, actions[] with each status, pendingSteering, document\|out, next}` | the document (no `--out`) or a human summary (`--out`) |

Read-only for the run; `--out` writes only the named file.

### plan revise

Replace the plan of a program-mode run with the complete program you want now. The kernel compares it with the live plan by action id: a new id is added; an unchanged action keeps its result or keeps running; a changed action is stopped if running and starts over; an action missing from the program is removed; ids in `--rerun` discard their finished result and run again; every step depending on a changed or rerun step runs again too. A finished run is reopened; a paused run stays paused until resume.

```bash
# Apply an edited export, and rerun one finished step.
bullswarm workflow plan revise ab12cd --program plan.json --rerun write-docs --summary "Docs must cover the new flag"
```

| Flag | Meaning | Default |
|---|---|---|
| `--program <file.json>` | the whole desired program: a document from `plan export`, a bare program, or a planner response envelope | required |
| `--rerun <id,...>` | comma-separated action ids whose finished results are discarded so they run again (merged with the document's `rerun` list) | none |
| `--summary <text>` | why the plan changed, recorded on the revision and shown by watch | the document summary, else `Plan revision <n>` |
| `--base-revision <n>` | refuse the revision if the run is no longer at program revision n | the document's `baseRevision`; none for a bare program |
| `--wait <seconds>` | how long to wait for a running kernel to apply or reject it; `0` returns once it is queued | `120` |
| `--json` | print `{status: applied\|rejected\|queued, programRevision, changes, appliedBy, reopened, relaunch}` | human summary of the changes |

An invalid program, an unknown rerun id, a stale base revision, or a revision that changes nothing exits 2 and leaves the run untouched. Files a stopped agent already changed stay in the workspace.

### pause

Pause a run: the kernel starts no new step. By default running agents finish first and their results are kept; with `--now` they are stopped and those steps run again after resume.

```bash
# Let running agents finish, then record the pause.
bullswarm workflow pause ab12cd
```

| Flag | Meaning | Default |
|---|---|---|
| `--now` | stop running agents instead of letting them finish, and wait up to 60s for the pause to take effect | off (running agents finish) |
| `--json` | print `{status: paused\|pausing, mode, appliedBy, next}` | one human line |

Writes `pause.json` in the run directory. Refuses a terminal run. `--now` stops agents mid-step; files they already changed stay in the workspace.

### cancel

Stop a run. A running kernel is asked to stop cooperatively at its next safe checkpoint (active workers are never killed mid-write). A run with no kernel alive is finalized here and now. A plan revision can still reopen a cancelled run.

```bash
# Request cooperative cancellation.
bullswarm workflow cancel ab12cd --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print `{action: "cancel", finalized, status, result\|next}` | one human line |

Idempotent: an already-terminal run reports `alreadyFinished` and exits 0.

### resume

Resume a V2 run with its durable planner mode and routing. On a finished run (`completed`, `partial`, or `cancelled`) resume is a retry: it reopens pending and cancelled steps, failed steps whose failure kind a retry fixes, and the steps blocked behind them. In a run started by this version where a usage limit or no free pool stopped the dispatched planner or the scout and ended the run, it runs that planner or scout again first (`running again: the workflow planner`); run it after the `back at` time, or it can stop the same way. A scout the run went on without (one before your own program) is not run again. With nothing retryable it prints `nothing to retry`, starts nothing, and exits 1.

```bash
# Retry a partial run once the handback's retryAfter time has passed.
bullswarm workflow resume ab12cd --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--foreground` | run the kernel attached to this terminal; combines with `--json` | off (detaches) |
| `--watch` | detach, then follow until terminal or paused; cannot combine with `--foreground` or `--json` | off |
| `--json` | print the relaunch document (or, with `--foreground`, the final result or pause document) | human launch instructions |

`--program`, `--orchestrator`, `--scout`, and `--suggested-plan` are rejected here (use `plan revise` to change the plan). In a new run, `failed-evidence` and `not-produced` stay failed: use `step rerun`, `step accept`, or `plan revise`. Saved runs keep their original resume rules.

### reindex

Backfill the append-only rollup history index from finished workflow run
directories. Runs completed before 0.33.0, or whose finish-time rollup write
failed, are included. Legacy authored-graph runs get a minimal record marked
`legacy`; only unfinished runs are skipped. The dashboard reads this index
instead of parsing every `state.json` on each refresh.

```bash
bullswarm workflow reindex [--json] [--force]
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print `{ ok, indexPath, scanned, written, skipped, legacy, unfinished, present, failed, failures[] }` | human summary line |
| `--force` | rebuild rollups that already exist, then refresh their index entries | leave existing rollups in place |

The command writes `<runDir>/rollup.json` and
`~/.bullswarm/history/runs.jsonl` (or the equivalent `$BULLSWARM_HOME`
paths), and is safe to run again: an already indexed run is counted as
`present` rather than duplicated.

### reprice

Recalculate terminal V2 attempt usage against the current dated rate cards and
the provider transcript hooks. The default is a dry run; use `--apply` only
after reviewing the rows it would change.

```bash
# Inspect every terminal attempt without writing run files or calibration.
bullswarm workflow reprice --json
bullswarm workflow reprice --all --json

# Reprice only attempts started on or after a date for one exact pool, then persist.
bullswarm workflow reprice --since 2026-09-18 --pool claude-code:acme --apply

# Run the same incremental pass the kernel and dashboard use automatically.
bullswarm workflow reprice --incremental
```

| Flag | Meaning | Default |
|---|---|---|
| `--apply` | atomically rewrite changed `state.json` files, regenerate `result.json`, and refresh rollup/index records | dry run; no run or calibration writes |
| `--all` | scan all retained attempts; cannot be combined with `--since` | last 30 days |
| `--since <date>` | include attempts whose `startedAt` is on or after this date, inclusively | all terminal attempts |
| `--pool <name>` | exact pool-name filter | all pools |
| `--json` | stream one JSON object per attempt and finish with a summary object | human rows plus an attempt-count and elapsed-time summary |
| `--incremental` | apply only still-unknown or byte-estimated attempts not closed by the retry ledger | off; manual full reprice |
| `--transcript-home <dir>` | read provider transcript stores beneath this home | current user home |
| `--trigger <name>` | label an incremental pass in `home status` | `manual` |
| `--delay-ms <n>` | delay an incremental pass; used by detached completion hooks | `0` |

Only terminal V2 runs are scanned; ongoing and legacy runs are skipped.
The command indexes each provider store once from bounded file heads and tails,
then reads only matched transcripts in full. A provider-reported attempt keeps
its measured tokens and is repriced. Other
attempts call the provider transcript hook: an exact or time-window match is
`transcript-summed`, while an absent or ambiguous match becomes `unknown` with
null token totals and API cost. Historical repricing reads calibration but never
appends a sample.

The automatic incremental reconciler shares these matching and pricing
primitives. It runs at quiet/final kernel boundaries and in detached children
started after watch completion and after the dashboard's first paint. Its
per-attempt ledger prevents repeated work; changed transcript stores or a new
reader version reopen unresolved attempts. Provider-reported capture is never
downgraded by a later transcript sum.

The human table columns are `run`, `action`, `try`, `pool`, `match`, `tokens`,
`api`, and `subscription`; `-` represents null. With `--json`, the result is:

```ts
{
  action: "reprice",
  apply: boolean,
  filters: { since: string|null, pool: string|null },
  scannedRuns: number,
  scannedAttempts: number,
  matched: number,
  ambiguous: number,
  missing: number,
  changedRuns: number,
  rows: Array<{
    runId, shortId, actionId, attemptId, ordinal, pool,
    confidence, tokenSource, totalKnown, apiUsd,
    subscriptionUsd, subscriptionBasis
  }>,
  failures: Array<{runId:string,error:string}>
}
```

### capabilities

Report the workflow engine, step roles, current routing policy, and live pool/model/meter state.

```bash
# Always JSON: pools, lanes, models, meters, routing constraints.
bullswarm workflow capabilities
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | accepted so agents can pass it uniformly; it selects nothing | output is always JSON, with or without the flag |

Read-only. Performs live pool discovery; nothing is written.

### tui

Open the interactive full-screen workflow dashboard, or print a static/JSON snapshot for a non-interactive caller. Bare `bullswarm workflow` is equivalent on a TTY.

The interactive dashboard has eight pages: Home (today's tiles, active and
recent workflows, and pool/model/project breakdown), Runs (the `active` block
over the day-grouped history table, plus the commands), Run (plan, Live, Next,
ETA, and budget), Step (one action's full panel), Budget (quota, measured
worker-time share, labelled money, fit, and biggest workflows), Stats
(Spending, Pool, Model, Project), Fleet (lane/provider rungs), and
Help. The tab row is Home, Runs, Budget, Stats, Fleet — Run and Step read as
Runs, and Help appears only while it is open. Every page has a sticky header
and bottom nav; the current run or page is marked `●`, and Step prepends
`[ back ]`. The shared keys are `h` Home, `r` Runs, `b` Budget, `s` Stats,
`y` the first day header of the Runs history table, `f` Fleet, `?` Help,
`1`–`9` to open a run, `Tab` for sub-tabs, `Shift+Tab` for workflows, `p` for
the period, `v` to switch Spending between By Pool and By Model, `Esc`/`←` for back, arrows for one line, `PgUp`/`PgDn` for a
screen, `Home`/`End` for top/bottom, `ctrl+s` to copy, and `q` to quit.
`Enter`/`→`/`l` opens a selection. In 0.33.0, `r` no longer refreshes, `b` no
longer moves out, `Tab` no longer cycles workflows, and `h` opens Home rather
than Help; the view refreshes itself, Esc/left moves out, and Shift+Tab still
cycles workflows. Click any tab, tile, bar, run, step, date, or control; the
mouse wheel scrolls.

```bash
# One plain-text frame of the timeline, live, and next sections.
bullswarm workflow tui ab12cd --overview --width 90 --height 24
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print a JSON snapshot instead of opening the interactive browser | opens the interactive browser on a TTY; without a TTY, a given runId prints one static text detail tree |
| `--all` | print the JSON run list including historical (finished) runs; implies `--json` and cannot be combined with a runId | ongoing only |
| `--show <runId>` | equivalent to passing `<runId>` positionally; forces the `--json` code path for that one run | none |
| `--cancel <runId>` | request cooperative cancellation of that run instead of viewing it | none |
| `--overview` | print one static frame of the run's overview panel as plain text with no escape codes; needs a runId | off |
| `--width <cols>` | columns of the `--overview` frame, at least 40 | `100` |
| `--height <rows>` | rows of the `--overview` frame, at least 12 | `30` |

Interactive mode and the snapshot views are read-only. `--cancel` writes `cancelRequested=true`. Inside the browser, `q` detaches without stopping the workflow; `c` requests cancellation with a confirmation prompt.

### watch

Follow one V2 run by printing one attach line, then one line per notable event, staying silent while work is merely in progress. Plain `workflow watch <runId>` follows until the outcome (a terminal status, a caller-planner wait, or an operator pause). `--next` prints no attach line and returns after the first notable event, or immediately at a pause or terminal status. Every `--next` exit that leaves the run going prints a `next:` relaunch line carrying `--after` and `--since`. A legacy authored-graph run cannot be watched: the watcher prints the legacy line and exits 2 before polling.

```bash
# Print the next notable event and exit; relaunch until outcome reports pause or terminal.
bullswarm workflow watch ab12cd --next
bullswarm workflow watch ab12cd --next --after 42 --since 2026-09-08T10:15:00.000Z

# Standard background observer: silent until caller attention is needed.
bullswarm workflow watch ab12cd --until trouble
```

| Flag | Meaning | Default |
|---|---|---|
| `--classic` | force the older heartbeat-based watcher instead of event mode; V2 runs only; cannot combine with `--next` | off (event mode) |
| `--interval <seconds>` | poll interval while following | `2` |
| `--heartbeat <seconds>` | print a periodic heartbeat line when nothing has changed; opt-in for V2, must be >= 1 | off in event mode, `60` with `--classic` |
| `--stall-after <seconds>` | report a running agent as silent after this many seconds without activity; must be >= 1 | `300` |
| `--next` | print no attach line; exit after the first poll that printed a notable event, or immediately at a pause or terminal status | off (follows until terminal or pause) |
| `--until <outcome\|trouble>` | print only trouble and outcome lines; `trouble` exits for a needs-you block (a usage limit or no free pool is one), a review needing you, a rejected revision, a planner or scout stopped on a usage limit, pause, stale step, or steering; blocked dependents are listed inside the needs-you block | off |
| `--after <sequence>` | start from this durable event sequence instead of the current high-water mark | attach at the current high-water mark |
| `--since <iso-timestamp>` | the previous watcher's exit time, so an already-reported stall does not fire again | report every agent silent past `--stall-after` at attach |
| `--jsonl` | emit one JSON object per line instead of human text; every object carries `sequence`; the `next:` relaunch line is not printed | off (human text) |
| `--once` | print a single current snapshot and exit immediately instead of following | off |
| `--verbose` | include started, retry, and steering-delivered lines in event mode, and per-agent action detail with `--classic` | off (compact) |

Read-only. Exits 0 if the run reaches a delivered status (or on `--once`), 1 if it reaches a non-delivered terminal status. `--next` exits 0 while the run continues or when it delivered, 1 when it ended without delivering or the kernel is not running. `--until trouble` prints a cursor-bearing relaunch line and, for stale work, the exact `workflow step restart` command. `--until` cannot combine with `--next`, `--once`, `--classic`, or `--heartbeat`.

### step rerun

Rerun a failed or finished step, carrying its last attempt's handoff. Add
`--avoid` to exclude pools; the exclusions are saved in the step's route.

```bash
bullswarm workflow step rerun ab12cd write-report
bullswarm workflow step rerun ab12cd write-report --avoid pool-a,pool-b
```

| Flag | Meaning | Default |
|---|---|---|
| `--avoid <pool,...>` | repeat the flag or pass a comma-separated list; avoid these pools on this rerun and later reruns | no additional exclusions |
| `--wait <seconds>` | wait for a live kernel to apply the revision | `120` |
| `--json` | machine-readable result | human confirmation |

A pending step accepts `--avoid` to amend its route without running it. A
running step needs `step restart`; a blocked step needs its failed dependency
resolved first. `failed-evidence` and `not-produced` are not rerun by
`workflow resume`. The command checks that some capable pool remains.

### step accept

Record your choice to accept a failed step or failing requirements from a check.
A choice is recorded as evidence `choice`; it never makes a requirement
verified.

```bash
bullswarm workflow step accept ab12cd write-report --reason "The report is sufficient"
bullswarm workflow step accept ab12cd verify --requirement requirement-2 --reason "Accept this gap"
```

| Flag | Meaning | Default |
|---|---|---|
| `--reason <text>` | required, one line, at most 500 characters; saved with the choice | required |
| `--requirement <id>` | accept only this failing requirement checked by the step; may be repeated | all failing requirements checked by the step |
| `--wait <seconds>` | wait for a live kernel to apply the revision | `120` |
| `--json` | machine-readable result | human confirmation |

Accepting a failed step lets its dependents run. A later rerun clears the
acceptance. An isolated writer whose work was never merged cannot be accepted.

### step restart

Stop one currently running step and put it straight back in the queue with the
stopped attempt's durable handoff. Nothing restarts automatically.

```bash
bullswarm workflow step restart ab12cd write-report
bullswarm workflow step restart ab12cd write-report --pool codex
```

| Flag | Meaning | Default |
|---|---|---|
| `--pool <pool>` | strictly pin the next attempt to this configured pool | normal routing |
| `--wait <seconds>` | wait for the live kernel to stop and requeue the step | `60` |
| `--json` | machine-readable result | human confirmation |

The command refuses finished runs, non-running steps, unknown pools, and dead
kernels without writing an intent. Shared-workspace edits remain in place;
isolated workspaces are retained for review and the new attempt starts fresh.

### events

Replay one run's durable, ordered event log from a sequence cursor — the machine-oriented alternative to watch/tui.

```bash
# Return every event from the start of the log.
bullswarm workflow events ab12cd --after 0
```

| Flag | Meaning | Default |
|---|---|---|
| `--after <sequence>` | only return events with a sequence number greater than this cursor | `0` (all events) |
| `--json` | accepted for consistency, but has no effect | output is always JSON |

Read-only.

### steer

Queue free-text guidance for a running goal's next orchestration checkpoint, without interrupting the currently active step. In a caller-planned program run the guidance never halts work: watch prints it at once, and the caller acts on it with `plan export` and `plan revise`. A run that finishes before anyone acts on it lists it as steering not acted on.

```bash
# Queue guidance. The active worker is unaffected.
bullswarm workflow steer ab12cd --message "Focus only on the auth module"
```

| Flag | Meaning | Default |
|---|---|---|
| `--message <guidance>` | the guidance text; if omitted, all words after `<runId>` are joined and used instead | required, in one of the two forms |
| `--json` | machine-readable confirmation | human-readable confirmation line |

Refuses if the run is already terminal, and refuses a legacy authored-graph run with the legacy line and exit 2.

### action show

Print one action's full record — its ledger entry, every dispatch attempt, its saved output, and the events tied to it.

```bash
# Inspect one action and all of its attempts.
bullswarm workflow action show ab12cd act-3
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | accepted for consistency, but has no effect | output is always JSON |

Read-only. The action id comes from the run's action ledger (`workflow runs show` or the TUI).

The outer `actionRecord`, `attempts`, and action-scoped `events` fields retain
the durable records. `step` is the compact, versioned Step display document:

```json
{
  "schemaVersion": 2,
  "identity": { "actionId": "sample-step", "status": "succeeded" },
  "selectedAttemptOrdinal": 2,
  "selectedAttempt": { "sameAs": "attempts[1]" },
  "attempts": [
    { "ordinal": 1, "activity": { "events": [], "turns": [] } },
    { "ordinal": 2, "activity": { "events": [], "turns": [] } }
  ],
  "presentation": { "header": {}, "activity": {}, "result": {}, "task": {}, "cost": {} }
}
```

The complete durable attempt records remain in the outer `attempts`; the
attempts inside `step` carry selection facts and activity only. Each distinct
attempt activity occurs once. `activity.events` is its canonical
event array; turn `eventIndices` select from it. Filtered aliases such as
`visibleEvents`, `todayEvents`, and `visibleDetailEvents`, and the dashboard's
top-level model aliases, are not serialized. A `{ "sameAs": "…" }` object is
a JSON reference marker for an identical value. `workflow task show` emits the
same `step` schema around a standalone task record.

### runs

Search ongoing and historical workflow run instances, including read-only legacy rows, or drill into one with `show` / `result` / `delete`. `bullswarm runs` is a documented alias that prints the same help with `bullswarm runs` in the synopsis.

Time filters compare each run's initiation timestamp and accept ISO timestamps, local dates (`YYYY-MM-DD`), `today`/`yesterday`/`tomorrow`/`now`, or relative durations such as `30m`, `24h`, `7d`, `2w`. `--since` is inclusive and `--until` is exclusive; `--from` / `--started-after` and `--to` / `--started-before` are aliases.

```bash
# List every run started in the last week.
bullswarm workflow runs --all --since 7d
```

| Flag | Meaning | Default |
|---|---|---|
| `--all` | include both ongoing and historical runs | ongoing only |
| `--historical` | only historical (finished) runs | ongoing only |
| `--name <goal>` | filter by exact goal text (a legacy row matches on its recorded workflow name) | no filter |
| `--since <time>` | lower bound on start time (inclusive) | no lower bound |
| `--until <time>` | upper bound on start time (exclusive) | no upper bound |
| `--limit <n>` | cap the number of results; must be a positive integer, and anything else exits 2 | no cap |
| `--json` | machine-readable output | human-readable one-line-per-run summary |

`list` is the default when no subcommand is given and takes the same flags.

### runs show

Show one run's durable state and status summary.

```bash
# Human-readable state and report for one run.
bullswarm workflow runs show ab12cd
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the full state/report as JSON | human-readable summary lines |

Read-only.

### runs result

Print the stable caller envelope. This is the intended integration point for scripts and agents. Use `--summary` for the compact status-loop envelope; read the full envelope on failed or partial runs and before judging evidence. Field-by-field documentation is in [Result envelope](/reference/result).

```bash
# Compact status-loop JSON, then the full envelope.
bullswarm workflow runs result ab12cd --json --summary
bullswarm workflow runs result ab12cd --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--json` | print the full versioned result document as JSON | human-readable result summary |
| `--summary` | print the compact JSON status-loop envelope; implies `--json` | full result envelope |

The full JSON `usage` object retains `total`, `byPool`, and `bytes`, and adds
`steps[actionId]` plus `totals`. Each aggregate contains `attempts`, `minutes`,
`tokens`, `cacheRead`, `cacheWrite`, `apiUsd`, `apiKnownSubtotalUsd`,
`subscriptionUsd`, `subscriptionKnownSubtotalUsd`, `measuredAttempts`,
`pricedAttempts`, `subscriptionPricedAttempts`, `tokenSource`, and
`subscriptionBasis`. An action may carry the same aggregate as `action.usage`.
The complete per-attempt v2 record is exposed by `workflow action show`; null
means that a value is unknown, while the explicitly named subtotal fields hold
partial sums.

Read-only.

### runs delete

Permanently remove one run's directory (state, report, events, logs).

```bash
# Irreversible delete of a finished run directory.
bullswarm workflow runs delete ab12cd --yes
```

| Flag | Meaning | Default |
|---|---|---|
| `--yes` | required — approves the deletion | none; the command refuses without it |
| `--force` | also delete an ongoing run | refuses to delete an ongoing run |
| `--json` | machine-readable confirmation | human confirmation line |

Recursively deletes `~/.bullswarm/workflows/<runId>/`.

## runs

Alias for `workflow runs`. Every subcommand, flag, and default is the same; the synopsis prints `bullswarm runs` instead of `bullswarm workflow runs`.

```bash
# Top-level shorthand for the same run list.
bullswarm runs --all --since 7d
```

## version

Print the installed bullswarm package version. `bullswarm --version` is an equivalent alias handled the same way by the command dispatcher.

```bash
# Print the package version from package.json.
bullswarm version
```

No flags. Self-initializes `state.json` on first use, like every other non-help command.

## update

Upgrade this installation of bullswarm to the latest version published on npm, in place. A global npm install is upgraded with `npm install -g bullswarm@<latest> --prefix <its own prefix>`. A global pnpm install lives in a per-version store directory (`<pnpm home>/.pnpm/bullswarm@<version>/`) that is not a prefix, so it is upgraded with `pnpm add -g bullswarm@<latest>` and verified through the link under the pnpm global `node_modules`. A source checkout (a clone, or a global install that is an `npm link` into one) is pulled with `git pull --ff-only` instead and is refused while it has local changes. The result is verified by re-reading `package.json` on disk, never by the package manager's exit code.

```bash
# Compare with the registry, then upgrade in place.
bullswarm update --check
bullswarm update
```

| Flag | Meaning | Default |
|---|---|---|
| `--check` | only compare the installed version with the latest published one; changes nothing | off (upgrades) |
| `--json` | machine-readable result: install `{kind: global\|pnpm-global\|checkout\|unknown, root, prefix}`, `verifiedAt`, `before`, `latest`, `after`, `upToDate`, `updated`, `error`, `notes[]` | human-readable lines |

`install.root` is where the **running** copy was found. pnpm leaves that per-version store directory behind on upgrade, so it is not "where bullswarm lives now" — read `verifiedAt`, the copy `after` was read from, for that.

Reads `https://registry.npmjs.org/bullswarm/latest` (8s timeout). Exit 0 = at the latest published version afterwards (or `--check` reported); exit 1 = registry, npm, pnpm or git refused, or the install shape is unknown. The running process keeps its old version; the next `bullswarm` command runs the new one.

## Next steps

- [Getting started](/guide/getting-started) — install, setup, and the first `run`
- [Workflow program](/reference/program) — the `plan.json` `workflow goal --program` executes
- [Result envelope](/reference/result) — JSON `run --json` and `runs result --json` return
