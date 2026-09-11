---
title: Model strategy and invocation telemetry
permalink: /guide/strategy/
---

Bullswarm can inventory the models exposed by installed agent CLIs and combine
connector-declared, dated pricing/benchmark metadata with live quota surplus.
Effort tiers are `high`, `medium`, and `low`. A **pool** is one installed
agent CLI, or one account of that CLI.

```bash
bullswarm setup                            # TTY: interactive control center
bullswarm strategy                         # explicit routing-focused alias
bullswarm strategy inventory --json        # agent-readable detection + policy + routes
bullswarm strategy routes --json           # compact effective choices
bullswarm strategy set-provider codex off --yes
bullswarm strategy set-model opencode2 relay/gpt-5.6-luna \
  --tiers high,medium,low --yes
bullswarm strategy configure --file strategy.json --yes  # atomic agent-created policy
bullswarm strategy reset-tier low --yes     # restore one tier to automatic
bullswarm strategy set-reasoning --tier high --level xhigh --yes
bullswarm strategy set-reasoning --tier high --level high --pool codex --yes
bullswarm strategy reset-reasoning --tier high --yes  # back to connector defaults
bullswarm strategy refresh
bullswarm strategy show --json
bullswarm strategy apply --yes --refresh-hours 24
bullswarm strategy auto status
bullswarm strategy set-subscription command-code \
  --plan GOAT --monthly-usd 10 --included-usd 70 --quota-window monthly
bullswarm strategy assign high --pool claude-code --model claude-opus-4-6
bullswarm strategy exclude-model claude-fable-5
bullswarm run --effort high --lane analyze --task-file /tmp/task.md --json
```

### Rungs

A **rung** is one pool's model *plus its reasoning level* for one effort tier —
the two halves you actually choose together. `bullswarm strategy rungs` reads
them as one table and `bullswarm strategy set-rung` writes both halves in one
atomic save:

```bash
bullswarm strategy rungs                      # every enabled pool x configured tier
bullswarm strategy rungs --json --pool codex  # machine-readable, one pool
bullswarm strategy set-rung codex high --model gpt-5.6-sol --reasoning xhigh
```

Each row carries the effective model and where it came from, the effective
reasoning level and which layer chose it, the dated benchmark evidence for that
model *at that reasoning level* (`blended`, `$/task`, `tok/task`), and what this
machine recorded for that pool and tier (dispatch count, median wall minutes, ok
share). Evidence and record are never estimated: a model the datapack does not
cover prints `no evidence`, and a tier with no matching attempt prints `no
dispatches`. `strategy inventory --json` carries the identical rows under
`rungs`.

Reading is free of side effects — no state write, no model discovery, no
download. `set-rung` never spawns discovery either: a model absent from the
pool's cached discovery exits 2 and lists the models it does know, unless you
pass `--force`. A reasoning level the connector cannot express is clamped down
to the strongest level it accepts and the clamp is printed. A rung is singular
per pool and tier, so the tier moves off whichever model held it while that
model keeps its other tiers. Nothing about `state.json` changed shape: rungs are
a view over `strategy.modelTiers` and `strategy.reasoning`.

The Relay-backed OpenCode pools (`opencode2`, `opencode2:relay-2`,
`opencode2:relay-3`) express reasoning as opencode's `--variant <level>`, at the
same five levels as `command-code`. opencode only forwards a variant its own
config declares for that model, so bullswarm injects them: each pool is spawned
with `OPENCODE_CONFIG_CONTENT` declaring `low`/`medium`/`high`/`xhigh`/`max` as
`reasoningEffort` variants of `<providerId>/gpt-5.6-luna`, merged over your
`~/.config/opencode/opencode.json` (your API keys stay in force). Without that
injection opencode accepts `--variant` and silently drops it. Set a rung per
pool, using that pool's own provider prefix:

```bash
bullswarm strategy set-rung opencode2:relay-2 medium \
  --model relay-2/gpt-5.6-luna --reasoning max
```

If you set `OPENCODE_CONFIG_CONTENT` yourself in
`~/.bullswarm/connectors/opencode2.json`, bullswarm leaves it alone and injects
nothing — you own the variants from then on.

The benchmark evidence comes from Epoch AI's benchmarking hub, used under
CC BY 4.0: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai.
Retrieved from <https://epoch.ai/benchmarks>. `blended` is the mean of the
cursorbench, deepswe, arc-agi-2, and critpt scores recorded for that exact
model and reasoning level; cost and tokens per task come from cursorbench. See
[data/README.md](../../data/README.md) for the schema and the refresh job.

Setup first asks whether to analyze live usage and recommend routes or open the
current configuration for manual editing. Analysis shows a spinner plus
per-provider usage progress, then presents the proposed defaults before making
any routing change. Press `Y` to apply them or `N` to retain the current policy.
The analysis selects at most one default model for each provider and effort
tier. It uses OpenRouter's agentic, coding, and intelligence indices as quality
signals and API-equivalent pricing as the budget signal. A repository-owned
benchmark refresh job refreshes two public assets on the rolling
`benchmark-data-latest` GitHub Release:
`openrouter-benchmarks.json` from the authenticated OpenRouter APIs, and
`epoch-benchmarks.json` from Epoch AI's CC BY 4.0 benchmark export, which is
what `strategy rungs` reads for per-model-per-reasoning-level evidence.
Installed CLIs download only those public files and never need or receive an
OpenRouter key.
The sources are OpenRouter's [benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks)
and [models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
The CLI caches each datapack under `~/.bullswarm/cache/`. OpenRouter is
cache-or-network only: a fresh cache is used as-is, otherwise the rolling
release is fetched, and a cache miss with no network yields an empty catalog
plus connector metadata — there is no bundled `data/openrouter-benchmarks.json`.
Epoch keeps `data/epoch-benchmarks.json` as a bundled last-resort, so a missing
network never blocks setup when that file exists.

The TUI lists every detected provider/account separately so its toggle matches
its own quota meter. Enter drills into that provider's detected models. In the
model matrix, `Up`/`Down` selects a model, `Left`/`Right` moves a visibly
highlighted cell across High, Medium, and Low, and `Enter` toggles that cell.
Type to filter model names; assigned models sort above unassigned or disabled
models. Select `Finish setup` and press `Enter`, or press `F` directly, to leave
the control center. The effective-route panel is recomputed from the same policy
and live surplus used by real dispatch. Provider and model edits affect new
direct runs and workflow dispatches.

An external AI agent should first read `strategy inventory --json`, then use
the validated `set-provider` / `set-model` commands or write one JSON document
for `strategy configure --file`. Unknown pools and models are rejected before
state is saved. Existing automatic choices are preserved when a human begins
curating a tier; a model-level `off` never empties unrelated tiers.

```json
{
  "providers": { "codex": false, "opencode2": true },
  "models": {
    "opencode2": {
      "relay/gpt-5.6-sol": ["high"],
      "relay/gpt-5.6-luna": ["medium", "low"]
    }
  }
}
```

Interactive setup asks whether to enable strategy autopilot; non-interactive
setup requires the explicit `setup --yes --strategy` flag. Recommendations are
context-filtered before ranking: high requires analysis plus workflow-planning,
medium requires build/edit capabilities, and low targets bounded chores. An
approved policy refreshes stale discovery before later runs and re-applies the
best eligible models on its configured interval. Disable it with
`strategy auto off --yes`. Discovery commands, model argument syntax, pricing,
and benchmark declarations remain connector-owned. Unknown license value,
prices, and benchmarks stay `null` rather than being guessed.

How an assignment interacts with pace, 5-hour headroom, and load at dispatch
time — and the routing reason and candidate rows that explain a pick — is
covered in [Routing](./routing.md), not repeated here.

Model exclusions are hard routing policy. An excluded model is removed from
recommendations and assignments, and Bullswarm pins a same-tier allowed model
through the connector-owned model flag whenever the provider default could be
excluded. A pool that cannot guarantee the exclusion is ineligible for that
dispatch. Reverse the policy with `bullswarm strategy include-model <model>`.

Every run and workflow attempt reports its selected agent/model and estimated
usage. When a delegate does not expose counters, Bullswarm labels its UTF-8
byte/4 token estimate. The breakdown separates standard read, cache read,
cache write, and output; API-equivalent cost and normalized subscription quota
remain unknown unless the connector and user-provided subscription data can
support them. `workflow tui --json <id>` exposes the aggregate and the full
phase/step/attempt tree.
