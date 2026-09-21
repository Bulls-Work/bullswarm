---
title: Configuration
description: The Bullswarm home directory, state.json, strategy models and rungs, local providers, and environment variables the CLI reads.
---

# Configuration

After this page you can point Bullswarm at a home directory, read what `state.json` stores, change model and reasoning rungs without guessing field names, and list every environment variable the running CLI actually reads.

Every non-help command self-initializes this home on first use. `--help` never reads or writes it.

## Home directory

The home is `$BULLSWARM_HOME` when that variable is a non-empty string, otherwise `~/.bullswarm`. Changing `BULLSWARM_HOME` moves every file below, including local providers.

| Path | What lives there |
|---|---|
| `state.json` | pools, quarantine, incumbents, the decision log, `config`, and `strategy` |
| `state.lock` | exclusive lock for every read-modify-write of `state.json` |
| `routing.json` | a suggested per-lane order written by `setup`; dispatch does not read it |
| `providers.json` | `{ "enabled": ["command-code"] }` — which contrib providers to load |
| `providers/<name>/` | local providers (always loaded) |
| `connectors/*.json` | JSON-only local providers from older installs; still loaded |
| `assignments/` | in-flight ledger that `pools` counts as `inflight` |
| `meters/` | cached usage readings |
| `runs/` | `task-*` and `out-*` files from `bullswarm run` |
| `workflows/<runId>/` | durable workflow state, events, attempts |
| `goals/<runId>/` | detached `workflow goal` launcher (`request.json`, `stdout.log`, `stderr.log`) |
| `cache/` | OpenRouter and Epoch benchmark datapacks |
| `maintenance/<job>.json` | the last result of each background job (`prune`, `reprice`): `at`, `trigger`, `ok`, and a one-line summary that `bullswarm home status` prints |
| `pricing/reconcile.json` | the automatic reprice ledger: one entry per attempt it tried (tries, next retry, outcome) plus a per-run cursor, so a second pass repeats no work |
| `pricing/transcript-index/<provider>.json` | cached transcript-store index the reprice pass updates incrementally |
| `pricing/active.json`, `pricing.lock` | the running reprice pass (one at a time); the dashboard reads `active.json` for its `pricing … older records` note |
| `calibration/<pool>.json` | meter samples attributed to runs; Home's `% measured` window share reads them |

```bash
# Initialize the home with discovered agent CLIs and write state.json.
bullswarm setup --yes
```

::: warning
`setup` prints "edit ~/.bullswarm/routing.json to change" the suggested table. Nothing in `src/` reads that file. Enable or disable a pool with `bullswarm strategy set-provider`, and change models with `strategy set-rung` or `strategy set-model`.
:::

## state.json

The file is version `1`. Every write is atomic (temp + rename). Every mutation goes through a locked fresh load, so a long `run` cannot clobber a `strategy set-provider` that happened while the worker ran.

```json
{
  "version": 1,
  "pools": {},
  "incumbents": {},
  "decisionLog": [],
  "config": {
    "depthLimit": 2,
    "callerName": "claude-code",
    "worktreeIsolation": "agent-decides"
  }
}
```

| Field | Meaning |
|---|---|
| `pools.<name>.enabled` | whether the pool is in the routing set. Test-fixture pools are opt-in (`enabled === true`); every other pool is opt-out (`enabled !== false`) |
| `pools.<name>.quarantine` | a pause: `{ until, reason, kind }` or absent. `kind` is `auth` (default 10 minutes) or `quota`, which is written only on proof — the pool's meter at 95% or more on a running window, or a provider line naming a spent window and its reset — and also records `rule` (`meter` or `message`), `line`, `meter`, `meterWindow`, `resetsAt` and `pausedAt`. Expired pauses auto-release on the next command that sweeps state; `bullswarm pools resume <pool>` lifts one at once |
| `retention` | `{ enabled, workspacesDays }`; see [Retention](#retention) |
| `incumbents` | last successful pool per lane, so picks do not flap |
| `decisionLog` | last 500 dispatch records (`ts`, `lane`, `picked`, `keepOnClaude`, `ok`, `why`, `wallSec`, `model`, `reasoning`, `usage`, `outFile`, `forecast`) |
| `config.depthLimit` | recursion cap. Core sets `BULLSWARM_DEPTH` on children; callers cannot widen this via flags. Default `2` |
| `config.callerName` | which pool counts as the calling agent when `run` is allowed to keep the task. Default `claude-code` |
| `config.worktreeIsolation` | `agent-decides` (default), `off`, or `required`. Set by the setup wizard. `workflow goal --isolation` opts a run into per-worker worktrees regardless |

`strategy` is added the first time you assign models, set reasoning, or apply a refresh. Do not hand-edit `state.json` while a command is running; use the `strategy` and `provider` verbs.

## Retention

The home stops growing forever. Isolated workflow actions work in disposable copies under `workflows/<runId>/workspaces/<action>`; once a run is old and finished, those copies are the only bulk left, and they are all Bullswarm removes.

```json
{ "retention": { "enabled": true, "workspacesDays": 7 } }
```

| Field | Meaning |
|---|---|
| `retention.enabled` | `true` (default) lets the automatic background prune run. `false` turns it off; `bullswarm home prune --yes` still works when you ask |
| `retention.workspacesDays` | how many days after a run's own `finishedAt` its `workspaces/` copies are removed. A number greater than 0; default `7` |

The block is optional; an absent key takes the default shown. A value of the wrong type is reported by `home status` and pauses the automatic prune until it is fixed — a background delete never runs on a policy it could not read. Edit the block while no `bullswarm` command is running.

**What goes:** every direct child of `workflows/<runId>/workspaces/`, for runs that are `completed`, `partial`, `cancelled` or `failed`, older than the limit, with no kernel lease held. A git worktree is unregistered with `git worktree remove` before its files go, so no stale `.git/worktrees` entry is left behind.

**What never goes:** `state.json`, `goal.json`, `events.jsonl`, `result*.json`, `report.json`, `rollup.json`, every `task-*`, `out-*`, `diff-*`, `stream-*` and `stdout-*` file, contracts, receipts, workspace baselines, `history/`, `runs/`, and anything of an `interrupted`, paused, waiting, running, legacy or unreadable run. A symlinked run directory, `workspaces` directory or workspace is skipped, and a symlink inside a copy is unlinked, never followed.

```bash
bullswarm home prune --dry-run          # list what would go, with bytes; changes nothing
bullswarm home prune --yes              # remove it
bullswarm home prune --yes --days 3     # this once, with a 3-day limit
bullswarm home status                   # policy, bytes on disk, last prune and last reprice
```

Bare `home prune` only lists. The automatic prune is the same rule run as a detached background process (`home prune --auto`): it honours `enabled`, waits at least six hours after its last result, takes a one-at-a-time lock, and records what it did in `maintenance/prune.json`. It never blocks a kernel finalize or a dashboard paint.

## Strategy models and rungs

A **pool** is one installed agent CLI, or one account of that CLI. Effort tiers are `high`, `medium`, and `low`. A **rung** is one pool's model plus its reasoning level for one effort tier — the two halves you actually choose together. Rungs are a view over `state.strategy.modelTiers` and `state.strategy.reasoning`; the JSON shape did not change when the rung commands landed.

```bash
# Read every enabled pool × configured tier, with evidence and local record.
bullswarm strategy rungs
# Set both halves of one rung in one atomic save.
bullswarm strategy set-rung codex high --model gpt-5.6-sol --reasoning xhigh
```

| `state.strategy` field | Written by | Meaning |
|---|---|---|
| `modelTiers` | `set-model`, `set-rung`, `apply`, `configure` | `{ [pool]: { [model]: ["high","medium"] } }` allow-lists |
| `configuredTiers` | same | which tiers are explicit allow-lists instead of automatic |
| `assignments` | `assign`, `apply` | hard `{ pool, model }` pin per tier; a model-tier write clears the pin for that tier |
| `reasoning.tiers` | `set-reasoning`, `set-rung`, `configure` | global level per effort tier |
| `reasoning.pools` | `set-reasoning --pool`, `set-rung` | per-pool override of that global |
| `excludedModels` | `exclude-model` / `include-model` | blocked from any dispatch |
| `disabledModels` | `set-model ... --tiers off` | per-pool disabled model ids |
| `subscriptions` | `set-subscription` | `{ plan, monthlyPriceUsd, includedValueUsd, quotaWindow, resetsAt }` per pool; overrides the connector |
| `policy` | `apply`, `refresh --apply`, `auto off` | auto-apply-on-refresh cadence |
| `lastReport` | `refresh` / `show` | cached discovery report |
| `pausing` | `set-pausing` | `"off"` stops every automatic pool pause — quota ('limit notices are retried, then move to another pool'), auth, the credential-group siblings an auth pause benches with it, and the soft bench; absent means on |

Reasoning is a separate dimension from the model: the tier chooses which model runs, reasoning chooses how deeply it thinks. Precedence per attempt: action `reasoning` field → `--worker-reasoning` / `run --reasoning` → strategy per-pool → strategy per-tier → connector default → nothing. `default` means append nothing and let the worker CLI decide. A level a connector cannot express is clamped down, never up.

`strategy inventory --json` is the agent-readable dump of providers, models, selections, meters, rungs, and effective routes. `strategy configure --file` applies `providers`, `models`, and `reasoning` in one validated write.

How a pick interacts with pace and 5-hour headroom is in [Routing](/guide/routing). The `strategy` verb flags are in the [CLI reference](/reference/cli).

### Where the benchmark evidence comes from

`strategy rungs` and the discovery in `strategy refresh` read two public datapacks, both published as replaceable assets on the `benchmark-data-latest` GitHub Release and cached under `<home>/cache/`.

| Datapack | Source | How it is fetched |
|---|---|---|
| `epoch-benchmarks.json` | Epoch AI's benchmarking hub — the per-model, per-reasoning-level evidence behind `blended`, `$/task`, and `tok/task` | a fresh cache first, then the bundled `data/epoch-benchmarks.json` when nothing is cached yet, then the release; a stale cache or the bundled copy is the last resort, so a missing network never blocks `setup` |
| `openrouter-benchmarks.json` | OpenRouter's benchmarks and models APIs — the agentic/coding/intelligence indices and API-equivalent pricing used to recommend tiers | cache-or-network only; nothing is bundled, and a cache miss with no network yields an empty catalog |

Installed CLIs download only those two public files and never need an OpenRouter key. A model the datapack does not cover prints `no evidence` rather than an estimate.

Epoch data is used under CC BY 4.0: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from <https://epoch.ai/benchmarks>. The schema and the refresh job are in [`data/README.md`](https://github.com/Bulls-Work/bullswarm/blob/main/data/README.md).

## Custom providers

A provider is a directory with `connector.json` and/or `provider.mjs`. Three tiers load on every start: first-class in the package, contrib listed in `providers.json`, and local under `<home>/providers/`. Existing `<home>/connectors/*.json` files keep working as JSON-only local providers.

```bash
# Write a local provider directory (default ~/.bullswarm/providers/<name>/).
bullswarm provider scaffold relay --from opencode
bullswarm provider validate relay
bullswarm provider probe relay
```

A local provider loads on the next Bullswarm start. A contrib provider loads only after `bullswarm provider enable <name>`. Loading is not routing: `bullswarm strategy set-provider <pool> on|off --yes` still decides whether a loaded pool gets work.

::: warning
The 2026-09-13 design discussion of a short-form `agent` / `quota` / `instances` manifest is not implemented. `bullswarm provider scaffold` writes today's full `connector.json` plus a `provider.mjs` skeleton. There is no `provider add` verb. Put pointers in `env`, never a secret.
:::

The contract (exports, `ctx`, the kit, pool fields) is [Providers](/reference/providers).

## Environment variables

These are the variables `src/` reads. Pool `env` values are merged into the child process as declared by the provider and are not listed here.

| Variable | Read by | Meaning |
|---|---|---|
| `BULLSWARM_HOME` | CLI, setup, meters, workflow | home directory; default `~/.bullswarm` |
| `BULLSWARM_DEPTH` | `src/lib/state.js`, dispatch | recursion counter. Core increments it on children. When it is already set, workers must not re-delegate. Limit is `state.config.depthLimit` (default 2) |
| `BULLSWARM_WORKER_SILENCE_SEC` | workflow dispatch | stop a worker that writes nothing for this many seconds. Default `3600`. The clock restarts on every byte |
| `BULLSWARM_ASCII` | glyphs | force ASCII table characters. Wins over auto-detection |
| `BULLSWARM_UNICODE` | glyphs | force Unicode table characters when ASCII was not set |
| `BULLSWARM_NO_PACKAGED_PROVIDERS` | provider loader | `1` skips first-class and contrib providers |
| `BULLSWARM_DISABLE_CLAUDE_PROFILES` | claude-code provider | `1` returns only the base Claude pool, no extra `CLAUDE_CONFIG_DIR` accounts |
| `HOME` | setup, integrate | expand `~` in `configDirs`; locate `~/.codex`, `~/.claude`, `~/.grok` |
| `CLAUDE_CONFIG_DIR` | claude-code provider | extra Claude home used to expand account pools |
| `PWD` | runner | set to the target directory when a pool declares `spawn.cwdMode: "pwd"` |
| `NODE_TEST_CONTEXT` | provider loader, claude-code | set by `node --test`; skips local providers and extra Claude accounts unless a test injects them |
| `LC_ALL`, `LC_CTYPE`, `LANG`, `TERM`, `TERM_PROGRAM` | glyphs | auto-detect ASCII vs Unicode when the two `BULLSWARM_*` overrides are unset |

`provider probe` ignores `BULLSWARM_DEPTH` so a nested agent can still probe a CLI.

## Next steps

- [CLI reference](/reference/cli) — `setup`, `strategy`, and `provider` flags
- [Providers](/reference/providers) — author a local provider
- [Routing](/guide/routing) — how pace and 5-hour headroom use this state
