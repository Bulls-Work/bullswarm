# Contrib providers

Providers in this directory ship with bullswarm but are **disabled by default**.
Bullswarm loads one only when your machine opts in. The providers under
`src/providers/` (claude-code, codex, grok, echo) always load. These don't.

| provider | what it runs | meter |
|---|---|---|
| `command-code` | the Command Code CLI (`command-code -p`) | monthly credits, 5-hour and weekly windows from the Command Code billing API |
| `opencode2` | the OpenCode CLI (`opencode run`) | none; also the template reseller providers clone as `ctx.templates.opencode2` |

## Enabling one

List it in `~/.bullswarm/providers.json` (or `$BULLSWARM_HOME/providers.json`):

```json
{ "enabled": ["command-code"] }
```

or run `bullswarm provider enable command-code`. Remove the name, or run
`bullswarm provider disable command-code`, to stop loading it. Once a provider
is loaded, you turn its individual pools on and off with
`strategy set-provider`, the same as any other pool.

## Adding a provider here

A contrib provider is a directory `providers/contrib/<name>/` holding a
`connector.json` (the pool template), a `provider.mjs` (`name`, and optionally
`displayName`, `connectors`, `readUsage`, `doctor`), or both. Follow
[docs/reference/providers.md](../../docs/reference/providers.md) for the contract.
Run `bullswarm provider validate providers/contrib/<name>` before you open
the pull request.
