---
title: Claude Code
description: The three ways Bullswarm appears inside Claude Code — the packaged skill, the MCP server, and the Claude Mod.
---

# Claude Code

After this page you can choose how Bullswarm shows up inside Claude Code — a skill the model invokes itself, an MCP server any client can call, or a Mod that routes Claude's own subagents — and load the one you want.

The three are independent: installing the skill does not install the Mod, and the MCP server is not involved in either.

## The packaged skill

`bullswarm integrate install --yes` symlinks the packaged skill into `~/.claude/skills/bullswarm` and appends a short awareness rule to `~/.claude/CLAUDE.md`. Claude Code then offers it as a skill you invoke with `/bullswarm`.

```bash
# link the packaged skill into Claude Code's global config
bullswarm integrate install --yes --agents claude

# report whether the link and the awareness rule are in place
bullswarm integrate status --agents claude

# reverse it: unlink the skill and strip the rule
bullswarm integrate remove --yes --agents claude
```

The skill's instructions send the agent straight to `bullswarm run` for one bounded outcome, or to `bullswarm workflow goal` when the work has parallel territories, an integration step, or acceptance judged on its own — there is no classifier or preview command to learn first. The exact text written into each agent's config is on [Codex and Grok](/integrations/agent-clis).

## The MCP server

`bullswarm-mcp` (`mcp/server.mjs`, exposed as a `bin` in the package) is a stdio JSON-RPC 2.0 server that runs the same verbs and returns their result as text. It needs no arguments and no environment.

| Tool | What it does |
|---|---|
| `bullswarm_run` | takes `lane`, `task`, optional `addDir` and `timeout`; dispatches one bounded task and returns `{ exitCode, verdict }` |
| `bullswarm_health` | re-judges saved outputs against their verdicts and reports verify-gate failures |
| `bullswarm_pools` | returns each pool's meter state, pace position, and quarantine status |

```bash
# register the server for your user account, so every project sees it
claude mcp add --scope user bullswarm -- bullswarm-mcp

# confirm the client starts it and connects
claude mcp list
```

`claude mcp list` answers `bullswarm: bullswarm-mcp  - ✔ Connected` when the handshake works. `bullswarm-mcp` is installed as a `bin` beside the `bullswarm` command, so any client that inherits your shell's PATH finds it.

## The Claude Mod

`mods/bullswarm` is the same routing injected into Claude Code's own engine as a Claude Mod — a plugin of TypeScript function hooks, behind the early-access flag `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Unlike the skill and the MCP server, it hooks the session itself.

### What it changes in the interface

- An `Agent` call — general-purpose, Explore or Plan — runs on the pool with the most surplus instead of in-session, and comes back with the verified output plus a routing note.
- A `Bash` call whose result is a `bullswarm run` or `bullswarm workflow goal` gets the verdict appended in the doctrine's words, so Claude reads the gate, not the exit code.
- A strip above the prompt: one header line with the run count, dispatches in flight, `route off` when routing is off, and `[w]` to open the runs pane; then one row per ongoing run and per standalone dispatch, each with a digit that opens it.
- A context block naming every pool's surplus and every ongoing run, re-sent only when a pool moves a bucket or a run starts or ends.

### The runs pane

`[w]`, a digit in the strip, or `/bullswarm pane` opens a pane docked beside the transcript. Its header and `[Top] [End]` stay fixed at the top, the run buttons with `usage` and `close` at the bottom, and between them scrolls what `bullswarm workflow tui <id> --overview` draws: Preflight with the accepted goal, every dependency level, Live workers with their latest activity, Next, and the pool meters last. The wheel over the pane, or arrows, PgUp/PgDn, Home/End once it has focus, move that middle. It re-reads every 20 seconds while the run is in flight.

Every step row is a button. Pressing it opens the step laid out as the TUI's agent panel: status, model and reasoning; pool, attempt and effort; the route reason; started, elapsed, last activity; the verdict or failure; the first lines of the task file; usage; the latest agent event; the tail of the output; and the task and output paths. `back` returns. `/bullswarm open <step> [run]` does the same from the keyboard.

`usage` in the bottom nav (or the `Pools ▸` header) opens the usage page: every meter window of every pool (5h, 7d, monthly) as a bar with a white mark where the window's elapsed time falls, its reset time and pace, the credit meter where the provider counts credits, and one row per pool × tier rung with the model, the reasoning level and the local record. It is read-only: `bullswarm setup` or `bullswarm strategy` change it; a run button returns to the run.

### Load it

```bash
# one session, from a checkout of this repository
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir mods/bullswarm

# one session, from the installed package
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$(npm root -g)/bullswarm/mods/bullswarm"
```

For every session, link the folder into the skills directory — a plugin there auto-loads as `bullswarm@skills-dir` — and keep the early-access flag on in `~/.claude/settings.json`:

```bash
# make plain `claude` load the mod in every session
ln -sfn "$(npm root -g)/bullswarm/mods/bullswarm" ~/.claude/skills/bullswarm-mod
```

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

### `/bullswarm` subcommands

The mod answers `/bullswarm` `pools`, `status`, `runs`, `pane`, `open <step> [run]`, `on`, `off`, `refresh`, and `routed`, and contributes `$.bullswarm` (`pools`, `refresh`, `runs`, `assignments`, `detail`, `step`, `rungs`, `run`) to other plugins.

### Options

| Option | Meaning | Default |
|---|---|---|
| `strip` | what the band above the prompt shows: `runs` (run rows), `full` (pool meters too), `off` (nothing; `/bullswarm pane` still opens the pane) | `runs` |
| `poolAliases` | display names as `from=to` pairs, so `claude-code:wati=cc:w` shortens an account pool's name in the strip and pane | empty (an account pool shows as prefix plus the first letter of its slug) |

Set them through `/config`, or under `pluginConfigs` in settings. The real pool names are unchanged everywhere else.

### Known limits

- The content gate wants real substance — 80+ characters after any "I'll read…" narration — so a delegate that answers in one short line is rejected and the `Agent` call falls back to an in-session subagent.
- A delegate run is capped at 9 minutes by `$.process.run`.
- `/bullswarm` is owned by the packaged skill, so the mod answers only its own subcommands on it and hands anything else to the skill.

## Next steps

- [Codex and Grok](/integrations/agent-clis) — the same integration for the other agent CLIs.
- [Observing runs](/guide/observing) — the terminal views whose overview the pane draws.
- [Run one task](/guide/run) — what the skill and the MCP server reach for first.
