# bullswarm

Bullswarm is a CLI that sends a coding task to whichever of your installed
agent CLIs — Claude Code, Codex, Grok, OpenCode, or Command Code — currently
has unused subscription quota, then checks the result by its content.

One command runs one task. A second command runs a graph of dependent tasks
across those same CLIs. Every result is judged by what was actually written,
not by whether the process exited 0.

For an agent already working in a repo, the packaged `bullswarm` skill
(`/bullswarm`, or `$bullswarm` where a skill uses that syntax) goes straight
to `bullswarm run` or `bullswarm workflow goal`. A skill here is a short
instruction file the agent CLI loads. There is no separate preview or
classifier command to learn first.

## Why it exists

Subscription quota expires on a clock, whether you spend it or not, and a
single coding agent's judgment on whether its own work is done should not be
the only check in the loop. Bullswarm picks whichever installed agent CLI has
the most unused quota right now, and treats every delegate's output as
evidence to be verified — never as an authority to be trusted on its word.

The same problem compounds on multi-step goals: one agent planning and
executing everything serially leaves every other installed CLI's quota idle,
and having that same agent be the sole judge of whether the whole goal is
done multiplies the risk instead of dividing it. Bullswarm's workflow engine
runs a graph of dependent actions across whichever pools have quota to spare
— a pool is one installed agent CLI, or one account of that CLI — and
computes completion from evidence the graph itself required, not from any one
delegate's own say-so.

## Install

```bash
npm i -g bullswarm
bullswarm setup
```

Later, `bullswarm update` upgrades that install to the latest published
version in place (`bullswarm update --check` only reports). Requires Node.js
22.12 or later. `bullswarm setup` walks through detecting your
installed agent CLIs, showing their quota state, and writing a routing
configuration. See
[Getting started](https://bulls-work.github.io/bullswarm/guide/getting-started)
for integrating Bullswarm's skill into Codex, Claude, and Grok, and for the
full quick-start command list.

## Claude Mod (early access)

`mods/bullswarm` is the same routing injected into Claude Code's own engine
as a Claude Mod (a plugin of TypeScript function hooks, behind
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`): the pool meters drawn above the
prompt, the pools named in the model's context, Claude's general-purpose
subagents routed to whichever pool has surplus and answered with the
verified output, and the verdict appended to every `bullswarm run` the model
runs. The Mod is the dashboard's read-only counterpart: its pane shows Run,
Step, and the Usage/Pools view in the same meter colours. It does not expose
the dashboard's Home, Runs, Budget, Stats, Fleet, or Help pages, and
it has no edit or install action. See [mods/bullswarm/README.md](mods/bullswarm/README.md).

Three ways to load it:

```bash
# with the CLI: links the mod under ~/.claude/skills and sets the flag in ~/.claude/settings.json
bullswarm integrate install --agents claude --yes

# from Claude Code's plugin marketplace (a copy that `claude plugin update` refreshes)
claude plugin marketplace add Bulls-Work/bullswarm
claude plugin install bullswarm@bullswarm

# one session only, from the installed package
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$(npm root -g)/bullswarm/mods/bullswarm"
```

The marketplace route still needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, in
the shell or under `env` in `~/.claude/settings.json`, and the `bullswarm`
CLI on `PATH`. Pick one route: an installed marketplace copy takes precedence
over the skills-dir link, and Claude says so at startup.

## Quick start

Once setup is complete, bare `bullswarm` opens the dashboard on its Home page.
Use `bullswarm --setup` or `bullswarm setup` to open setup again, and use
`bullswarm workflow tui` when you want the explicit dashboard command. The
eight pages answer different questions:

| Page | What it answers |
|---|---|
| Home | What happened today, what is verified, what measured or labelled money/licence data exists, and what is active or recent; includes pool/model/project breakdowns. |
| Runs | Which workflows are active or historical — one `active` block and the History day table below it — plus the product commands; the integration line and `/` filter live here, and `?` carries the agents and `run it` blocks. |
| Run | Where one workflow is in its plan, which workers are live or next, and its ETA and budget shares. |
| Step | What one action is doing: route, attempt, activity, verdict/failure, prompt, usage, events, output, and artifacts. |
| Budget | Pool quota windows, measured worker-minutes versus rest, measured or `≈` money, fit, and biggest workflows. |
| Stats | Runs, spend, worker-minutes, and verification over 7d/30d/all, by pool, model, and project. |
| Fleet | Lane/provider model and reasoning rungs, records, meter state, and the setup edit hand-off. |
| Help | Every key, click, layout rule, and dashboard command. |

The visual-fidelity pass keeps the same real numbers while composing and
colouring these pages like the approved prototype. At 55 columns every Home
today tile and per-step bar, every Stats model, project and its sparkline, every
Stats and Fleet pool row, and every run row in the Runs history table keeps one
row per item on the phone; Budget's per-pool block (a header over `used`,
`by bullswarm`, `room` and `so far`), Home's `budget · this week` pool (meter
plus a reset line, as the prototype draws it) and the Runs `active` entry are
the deliberate exceptions. At 200 columns every page composes to the frame
rather than capping at the 120-column composition. Estimated figures still
carry `≈` and their basis; a figure that cannot be measured is a line of words
saying so — no page draws an empty or dotted track for missing data.

Every page has a sticky header, a page tab row, and a sticky bottom nav. The
tab row is five tabs — Home, Runs, Budget, Stats, Fleet — with Run and Step
marking Runs, and Help shown only while it is open. The shared key table is:

| Key | Does |
|---|---|
| `r` | open Runs; the view refreshes itself, so `r` is no longer refresh |
| `b` | open Budget; it is no longer move-out |
| `s` | open Stats |
| `y` | open Runs at its History table (the first day header), except that it confirms a pending stop |
| `f` | open Fleet |
| `h` | open Home |
| `?` | open Help |
| `1`–`9` | open that run from the nav |
| `Tab` | cycle the current page's sub-tabs |
| `Shift+Tab` | cycle workflows |
| `p` | cycle the period on Home and Stats |
| `Esc` / `←` | move out one page, then Home |
| `↑`/`k`, `↓`/`j` | move one line |
| `Enter` / `→` / `l` | open the selected run, step, tab, or action |
| `PgUp` / `PgDn` | scroll one screen |
| `Home` / `End` | jump to the top or bottom |
| `ctrl+s` | copy the screen through OSC 52, falling back to `pbcopy`, `wl-copy`, or `xclip` |
| `q` | quit the dashboard; workflows keep running |

The 0.33.0 rebinding is deliberate: `r` no longer refreshes, `b` no longer
moves out, and `Tab` no longer cycles workflows. Esc/left moves out, the view
refreshes itself, and Shift+Tab still cycles workflows. Runs also provides `/`
(filter), `a` (active/all), and `i` (install); Run provides `o`, `v`, and `t`,
and Fleet provides `e` for setup. Click tabs, tiles, bars, runs, steps, dates,
or controls, or use the wheel to scroll.

Home, Runs, Budget, and Stats read a per-run rollup that every finishing
run appends to `~/.bullswarm/history/runs.jsonl`. After upgrading, backfill
the runs that finished before 0.33.0 once with `bullswarm workflow reindex`;
legacy runs get a minimal record and only runs still in flight are skipped.

One bounded outcome — a task with a clear finish line:

```bash
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json
```

`--lane analyze` tags the work as read-only analysis. The other lanes are
`build` (edits) and `chore` (mechanical edits). This routes the prompt to
whichever pool is eligible, dispatches it, watches it to completion, verifies
the output, and prints one JSON verdict — nothing else runs and nothing is
left in the background.

Multi-step work, where you author the plan. The kernel — Bullswarm's own
runtime, not an agent — validates that program and executes it:

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    { "id": "fix", "kind": "implement", "purpose": "Fix the failing tests",
      "dependsOn": [], "ownedFiles": ["src/parser.js"], "affects": ["requirement-1"],
      "evidenceFor": [], "prompt": "In ~/some-repo, fix the failing tests with the smallest correct change." }
  ]
}
```

```bash
# 1. Write plan.json — the bounded action program the kernel will enforce.
bullswarm workflow plan validate "Fix the failing tests and verify the change" \
  --cwd ~/some-repo --program plan.json --json     # exit 0 valid, exit 2 with the issues; nothing launches
bullswarm workflow goal "Fix the failing tests and verify the change" \
  --cwd ~/some-repo --program plan.json             # launches, prints a short ID and observation commands, returns
```

`workflow goal` starts a durable background run and returns immediately by
default; add `--watch` to follow its low-noise progress in the same terminal
instead.

## How it picks a pool

- Work is tagged by lane — read-only analysis, ordinary build work, or
  mechanical chores — not assigned to a fixed pool ahead of time.
- Among the pools that can do the work, the one furthest behind its own quota
  pace (the most unspent surplus) wins, so quota doesn't expire unused.
- A pool close to its rolling 5-hour usage ceiling gives way to one with
  headroom only while another pool is actually behind its own pace — it is an
  ordering penalty, not a cutoff. A step may run a pool all the way to 100% of
  that window, because if the provider stops the worker at the wall the retry
  is briefed on what it had already written.
- A pool whose weekly or monthly subscription window is about to reset gets
  priority for its remaining surplus, so quota doesn't run out the clock
  unspent.
- A pool already busy with other in-flight work yields to a quieter pool at a
  similar pace, so a burst of parallel work spreads out instead of piling onto
  one pool.
- A pool that reports a usage-limit error is benched until the provider's own
  reset time and automatically re-tried after that — never left down for good,
  and never retried early.

The full mechanics behind each of these are in
[Routing](https://bulls-work.github.io/bullswarm/guide/routing).

## What you get back

`bullswarm run` prints a JSON verdict when it finishes:

- `keepOnClaude: true` — the router says do this in-session; nothing ran
- `ok: true` (and `keepOnClaude` is false) — the output passed verification;
  read `outFile`
- `ok: false` — `why` names the gate that failed
- `contentUsableDespiteExit: true` — the process exited non-zero but the
  content still verified; read it before re-running

A non-zero exit from the delegate is never treated as success on its own. See
[Result envelope](https://bulls-work.github.io/bullswarm/reference/result) for the full
verdict shape.

A workflow produces a durable, versioned result envelope — a JSON document
with `runId` / `shortId`, status, per-requirement evidence, per-action
outcomes, and usage — instead of leaving you to parse a transcript.

```bash
bullswarm workflow watch <shortId> --next                  # wait for the next notable event, then exit
bullswarm workflow runs result <shortId> --json --summary  # compact status once the run is terminal
```

`workflow watch --next` prints one line per event and relaunches itself with
the exact flags to keep polling; `runs result --summary` is what to read once
a run finishes, and `runs result --json` (no `--summary`) gives the full
envelope for a failed or partial run. See
[Observing runs](https://bulls-work.github.io/bullswarm/guide/observing) for the
full shape of both.

## Documentation

The full documentation is published at
[bulls-work.github.io/bullswarm](https://bulls-work.github.io/bullswarm/).

The dashboard is the main screen after setup: bare `bullswarm` opens Home,
`bullswarm --setup` or `bullswarm setup` opens setup, and
`bullswarm workflow tui` is the explicit form. The [Observing runs](https://bulls-work.github.io/bullswarm/guide/observing)
page maps its pages, keys, and mouse controls.

| Page | What it covers |
|---|---|
| [Introduction](https://bulls-work.github.io/bullswarm/guide/) | What Bullswarm is, the two entry points, and the four rules it never breaks |
| [Getting started](https://bulls-work.github.io/bullswarm/guide/getting-started) | Install, `setup`, `doctor`, agent integration, and your first verified run |
| [Concepts](https://bulls-work.github.io/bullswarm/guide/concepts) | Pools, lanes, surplus, the two windows, verdicts, quarantine, and the run directory |
| [Run one task](https://bulls-work.github.io/bullswarm/guide/run) | Every `bullswarm run` option, and what each verdict asks you to do |
| [Workflows](https://bulls-work.github.io/bullswarm/guide/workflows) | Authoring the program `workflow goal` executes: territories, dependencies, integration, acceptance |
| [Observing runs](https://bulls-work.github.io/bullswarm/guide/observing) | `workflow watch`, the Home/Runs/Run/Step/Budget/Stats/Fleet/Help dashboard pages, keys, mouse, and terminal glyphs |
| [Routing](https://bulls-work.github.io/bullswarm/guide/routing) | How a pool is picked: pace, 5-hour headroom, urgency, load, quarantine |
| [CLI reference](https://bulls-work.github.io/bullswarm/reference/cli) | Every verb and nested subcommand, with its flags and defaults |
| [Workflow program](https://bulls-work.github.io/bullswarm/reference/program) | The `bullswarm.workflow.program.v2` document: action fields, kinds, validation rules |
| [Configuration](https://bulls-work.github.io/bullswarm/reference/configuration) | The Bullswarm home, `state.json`, strategy models and rungs, environment variables |
| [Providers](https://bulls-work.github.io/bullswarm/reference/providers) | Adding your own agent CLI or reseller account as a provider plugin |
| [Result envelope](https://bulls-work.github.io/bullswarm/reference/result) | Every field of `run --json` and of the workflow result document |
| [Claude Code](https://bulls-work.github.io/bullswarm/integrations/claude-code) | The packaged skill, the MCP server, and the read-only Claude Mod counterpart under `mods/bullswarm` |
| [Codex and Grok](https://bulls-work.github.io/bullswarm/integrations/agent-clis) | What `bullswarm integrate` writes for each agent CLI, and how to check it |
| [Issue watcher](https://bulls-work.github.io/bullswarm/integrations/issue-watcher) | The launchd agent that triages and fixes new GitHub issues |
| [Historical notes](https://bulls-work.github.io/bullswarm/notes/) | Working notes, audits, and experiment writeups, kept as records |

## License

MIT
