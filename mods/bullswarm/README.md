# bullswarm as a Claude Mod

A Claude Mod is a Claude Code plugin whose behaviour is TypeScript running
inside Claude Code's engine ("function hooks", early access, enabled with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). This folder is that plugin.

The terminal dashboard is Bullswarm's main screen. This Mod is its read-only
counterpart: the strip is the run list, and the pane shows the dashboard's
**Run**, **Step**, and **Usage/Pools** view in the same meter colours. It does
not show the dashboard's **Home**, **Runs**, **Budget**, **Stats**, **History**,
**Fleet**, or **Help** pages, and deliberately exposes no `[edit]` or
`[install]` action. The pane's bottom row is `back` (on a step), the workflow
and standalone-task buttons, `usage`, and `close`. Navigation matches the dashboard's mouse rules:
click any button, tab, run, or step, and use the wheel to scroll.

Workflow buttons keep their digit hotkeys. A standalone dispatch has its own
`task <8-character-tail>` button without taking a workflow digit; selecting it
opens that task, and `back` returns to the selected workflow. A task is promoted
automatically only when no workflow is in flight.

The pane's `usage` button is available even when no workflow is running, so it
always opens the read-only pools and rungs page. When the workflow list is
empty but a live `bullswarm run` assignment is present, the empty pane opens
with `Single task in flight` and shows that task's lane, pool and model, the
tail of its task-file path (falling back to its project or working directory)
and its elapsed time; the same in-flight refresh cadence keeps that elapsed
value current. Workflow assignments remain part of the run views, while the empty
pane only promotes the standalone `source: "run"` record.

What it adds beyond the packaged skill and the MCP server:

| Hook | What happens |
| --- | --- |
| `engine.create` | `$.bullswarm` (`pools`, `refresh`, `run`) for any other plugin |
| `session.start` | registers `/bullswarm`, reads the meters, runs and in-flight ledger; re-reads every 2 min, every 20 s while work is in flight |
| `prompt.context` | a context block naming every pool's surplus and every ongoing workflow run, re-sent only when a pool changes by a bucket or a run starts or ends |
| `tool.call` on `Agent` | a general-purpose, Explore or Plan subagent runs on the pool with the most surplus via `bullswarm run --no-caller`; the tool result carries the verified output plus a routing note |
| `tool.call` on `Bash` | a `bullswarm run` / `bullswarm workflow goal` result gets the verdict appended in the doctrine's words |
| `command.run` `/bullswarm` | `pools`, `runs`, `pane`, `open <step> [run]`, `on`, `off`, `refresh`, `routed` |
| `ui.render` `AbovePrompt` | the strip: one header line (run count, dispatches in flight, `route off` when routing is off) with `[w]`, which opens or closes the runs pane; then one row per ongoing workflow run (progress, the step each pool is running with elapsed/expected minutes, the goal) and one per standalone dispatch; a digit in front of a run row opens that run. Routing and refresh are `/bullswarm on`, `off` and `refresh`. The `strip` option picks `runs` (default), `full` (pool meter rows too) or `off`. Nothing is pinned under the prompt |
| `ui.render` `Pane` + `ui.scroll` | the runs pane, docked beside the transcript. Fixed at the top: the run's header (with `first–last/total` while scrolled) and `[Top] [End]`. Fixed at the bottom: the pool rows, the page's hint line, then a button per workflow and standalone task, `usage`, `close`. Under 20 body rows (a phone terminal, a short inline pane) the pane draws a compact layout: one header row, one nav row with `[Top] [End]` and no `close` (the frame's ✕ closes it), nothing else pinned; `ctrl+x up` grows an inline pane while it has focus. Between them the whole overview as `bullswarm workflow tui` draws it (Preflight with the accepted goal and the goal and plan files, every phase, Live workers with their latest activity, Next) from `bullswarm workflow tui <id> --overview`, with the pool meters last (each bar carries a white mark where the window's elapsed time falls, in the status line's colours). `Pools ▸` opens a pools page: every meter window of every pool as a full-width bar with reset time and pace, the credit meter where there is one, and the rungs (model, reasoning and record per pool × tier) grouped by lane or by provider with two tabs; read-only, `back` returns even when no workflow is running. The mod owns that window: the wheel over the pane, and arrows, PgUp/PgDn, Home/End once the pane has focus (click it), move the middle only. Every workflow step row opens the dashboard's finished Step v2 grammar from compact `step.schemaVersion: 2` JSON in `bullswarm workflow action show <run> <step> --json`; a task button reads the same schema from `bullswarm workflow task show <taskId> --json`. The mod resolves the selected attempt and its canonical activity while rendering the same rows. Both show one verdict header with the visible `overview · detail` toggle; the latest 10 turns (5 below 100 columns) and its `click for detail` fold line; the full turn-and-tool transcript in detail; structured result, task facts, and the dashboard cost rows. Phone order is result → activity → task → cost. The newest overview turn is selected and expanded until the reader chooses another; a running command shows its name and a one-second elapsed clock from the CLI projection. The mod maps good/running/failure, dim, bold and pool-series roles onto its meter palette. `v` toggles the view, clicking either top tab selects it, and clicking expands overview turns. If the task JSON read fails, the honest unavailable fallback remains. Other in-flight pages refresh every 20 s; an open running Step refreshes every four seconds. |
| `tool.call` `mcp__bullswarm__route` | a tool the mod registers so the model can switch auto-routing on or off when the person asks ("stop routing my subagents"); the same switch as `/bullswarm on|off` |
| `ui.close` | keeps the strip's `[w]` label in step when the person closes the pane |

Pool names in the session context, strip, pane and usage page are display names: an account pool such as
`claude-code:acme` shows as `claude-code:a` (first letter of the account slug,
unless two accounts would collide). A core label set with `bullswarm pools
label <pool> <label>` is used when present. The plugin option `poolAliases`
(`/config`, or `pluginConfigs` in settings) overrides any name:
`claude-code:acme=cc:a,claude-code:initech=cc:i`. The durable pool ids remain
unchanged because bullswarm derives them from the account's config directory
(`~/.claude-acme`) and the keychain entry is keyed by it.

Observing a run: press the digit shown in front of a run row in the strip
(`1` for the first run) from an empty prompt, click the row, or press `[w]`,
or type `/bullswarm pane`. Letter hotkeys (`b`, `r`, `w`) fire while the band
has focus (click it, or ctrl+x tab); digits fire from an empty composer.
Inside the pane, `q` closes it, `r` re-reads, and a digit switches runs.

Run it from source for one session:

    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir mods/bullswarm

Load it in every session with plain `claude`. The CLI does both halves,
linking the folder into the skills directory (a plugin there auto-loads as
`bullswarm@skills-dir`) and setting the early-access flag under `env` in
`~/.claude/settings.json`; `integrate status` reports both and `integrate
remove` undoes them:

    bullswarm integrate install --agents claude --yes

Or install it from the repository's plugin marketplace, which copies the mod
into Claude's plugin cache (refresh it with `claude plugin update`) and
still needs the flag set:

    claude plugin marketplace add Bulls-Work/bullswarm
    claude plugin install bullswarm@bullswarm

By hand, the two halves are:

    ln -sfn "$(npm root -g)/bullswarm/mods/bullswarm" ~/.claude/skills/bullswarm-mod

    { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }

Use one route: an installed marketplace copy takes precedence over a
skills-dir link with the same name, and Claude says so at startup.

Typecheck against this build's own declarations: inside a session with the
mod loaded, `/plugin-types mods/types` writes `claude-code.d.ts` (the engine
API plus every built-in tool's input and result schema) next to this folder,
where `tsconfig.json` includes it; `mods/types/` is generated, not committed.

    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir mods/bullswarm -p "/plugin-types mods/types"
    npx -p typescript tsc -p mods/bullswarm/tsconfig.json

Known limits: bullswarm's content gate wants real substance (80+ characters
after any "I'll read…" narration), so a delegate that answers in one short
line is rejected and the call falls back to an in-session subagent; a
delegate run is capped at 9 minutes by `$.process.run`; `/bullswarm` is
owned by the packaged skill, so the mod answers only its own subcommands on
it and hands anything else to the skill.
