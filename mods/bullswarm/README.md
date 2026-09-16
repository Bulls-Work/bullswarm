# bullswarm as a Claude Mod

A Claude Mod is a Claude Code plugin whose behaviour is TypeScript running
inside Claude Code's engine ("function hooks", early access, enabled with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). This folder is that plugin.

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
| `ui.render` `Pane` + `ui.scroll` | the runs pane, docked beside the transcript. Fixed at the top: the run's header (with `first–last/total` while scrolled) and `[Top] [End]`. Fixed at the bottom: a button per run, `usage`, `close`. Between them the whole overview as `bullswarm workflow tui` draws it (Preflight with the accepted goal and the goal and plan files, every dependency level, Live workers with their latest activity, Next) from `bullswarm workflow tui <id> --overview`, with the pool meters last (each bar carries a white mark where the window's elapsed time falls, in the status line's colours). `Pools ▸` opens a pools page: every meter window of every pool as a full-width bar with reset time and pace, the credit meter where there is one, and one row per pool × tier rung with model, reasoning and record; read-only, a run button returns. The mod owns that window: the wheel over the pane, and arrows, PgUp/PgDn, Home/End once the pane has focus (click it), move the middle only. Every step row is a button: pressing it opens the step, laid out as the TUI's agent panel from `bullswarm workflow action show`: status, model and reasoning; pool, attempt and effort; the step and its purpose; the route reason; started, elapsed or finished, last activity; the failure or verdict; the first lines of the task file; usage; the latest agent event; the tail of the output; the task and output paths. `back` returns. The frame is re-read every 20 s while the run is in flight |
| `ui.close` | keeps the strip's `[w]` label in step when the person closes the pane |

Pool names in the strip and pane are display names: an account pool such as
`claude-code:acme` shows as `claude-code:w` (first letter of the account slug,
unless two accounts would collide). The plugin option `poolAliases`
(`/config`, or `pluginConfigs` in settings) overrides any name:
`claude-code:acme=cc:w,claude-code:initech=cc:p`. The real pool names are
unchanged everywhere else, because bullswarm derives them from the account's
config directory (`~/.claude-acme`) and the keychain entry is keyed by it.

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
