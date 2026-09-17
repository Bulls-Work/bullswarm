---
title: Providers
description: What a provider is, the three load tiers, provider.mjs exports, ctx, the kit, the usage snapshot, pool fields, and the provider verb.
---

# Providers

After this page you can author a provider directory that `bullswarm provider validate` accepts, know which export and pool field the core actually reads, and probe a pool before routing work to it.

A **provider** is the plugin that teaches Bullswarm one agent CLI: how to launch it, how to read its output, which models and reasoning levels it takes, and, when the vendor exposes one, how to read its usage meter. A provider returns one or more **pools**. Everything specific to one CLI lives in its provider directory, never in core logic.

A provider is a directory holding a `connector.json`, a `provider.mjs`, or both. `connector.json` is a pool template in the fields listed under [Pool fields](#pool-fields-and-who-reads-them), checked against `src/providers/_schema.json`. `provider.mjs` adds code: several pools from one template, a live usage reader, a custom health check.

## Directory layout and tiers

| Tier | Directory | Loaded when | Members |
|---|---|---|---|
| first-class | `src/providers/<name>/` | always | `claude-code`, `codex`, `grok`, `echo` |
| contrib | `providers/contrib/<name>/` | listed in `~/.bullswarm/providers.json` | `command-code`, `opencode` |
| local | `~/.bullswarm/providers/<name>/` | always | your own, never in the repository |

First-class and contrib providers ship in the package. A contrib provider loads only on a machine that lists it:

```json
{ "enabled": ["command-code"] }
```

```bash
# Load or unload a contrib provider. Writes only providers.json, never state.json.
bullswarm provider enable command-code
bullswarm provider disable command-code
```

Local providers live under the Bullswarm home, so `BULLSWARM_HOME` moves them too. Under `node --test` local providers are skipped unless a test passes the directory explicitly. Existing `~/.bullswarm/connectors/*.json` files keep working as local providers made of JSON alone.

"Enabled" means two separate things, and both remain. A contrib provider is enabled, or loaded at all, through `providers.json`. A pool that is loaded is enabled or disabled for routing through `bullswarm strategy set-provider`.

## Loading

The loader reads first-class, then enabled contrib, then local providers, synchronously, on every Bullswarm start.

- Every pool a provider returns must be named `name` or `name:<suffix>`. A pool that breaks the rule is skipped.
- A pool whose name is already taken is skipped, never overwritten.
- Bad JSON, an import error, or a thrown `connectors()` is caught and recorded on that provider. A run never crashes because of a provider.

Skipped pools and errors are shown by `bullswarm setup` and `bullswarm provider list`.

## provider.mjs

```js
export const name = 'x';                        // required when provider.mjs exists
export const displayName = 'X';                 // optional
export function connectors(ctx) {}              // optional; sync, returns Pool[]
export async function readUsage(pool, ctx) {}   // optional; returns a Snapshot
export function doctor(ctx) {}                  // optional; returns a health object
```

| Export | Contract | When absent |
|---|---|---|
| `name` | the provider's name and the prefix of every pool it returns | the `name` in `connector.json` |
| `displayName` | the label strategy tables print | the provider name |
| `connectors(ctx)` | synchronous, cheap, no network; returns an array of pools | one pool: the template |
| `readUsage(pool, ctx)` | async; returns a [snapshot](#the-snapshot); throws an `Error`, with an optional `.code` | the pool falls back to a declared meter, else it is unmetered |
| `doctor(ctx)` | returns `{ installed: boolean, loggedIn: boolean \| null, hint?: string }` | installed means `bin` is on `PATH`; logged in means any `configDirs` entry exists |

The core never branches on a thrown error's `code`; it is there for people reading the output of `bullswarm provider probe`.

## ctx

Every method receives the same `ctx`:

| Key | Value |
|---|---|
| `kit` | the [provider kit](#the-kit) |
| `template` | this directory's `connector.json`, parsed, or `null` |
| `templates` | every shipped `connector.json` by provider name, first-class and contrib, whether enabled or not |
| `home` | the Bullswarm home directory |
| `env` | the process environment |
| `bullswarmDir` | the package root |

`readUsage` also receives `subscription`: the pool's entry in `state.strategy.subscriptions`, or `null`. It carries `includedValueUsd`, `quotaWindow`, `resetsAt`, `plan`, and `monthlyPriceUsd`.

`templates` exists so a provider can build on a shipped CLI without copying its template: a reseller of OpenCode access clones `templates.opencode`.

## The kit

The kit is `ctx.kit`, and in-repo providers can also import it as `bullswarm/provider-kit`. A local provider must use `ctx.kit`: a file outside the package cannot resolve that bare import.

| Member | What it does |
|---|---|
| `REASONING_LEVELS` | the common scale `low`, `medium`, `high`, `xhigh`, `max` |
| `clonePool(template, overrides)` | deep-copies the template, shallow-merges `overrides`, sets `flags.isCaller = false`, and when `overrides.model` is given replaces or appends the model flag in `spawn.cmd` using the template's `modelSelection` (default `--model`) |
| `opencodeVariants(providerId, models)` | the `OPENCODE_CONFIG_CONTENT` JSON string that declares every reasoning level as `{ reasoningEffort: level }` for each listed model under `provider.<providerId>.models`, so OpenCode's `--variant <level>` reaches the API |
| `bearerJson(url, token, { headers })` | fetches JSON with `Authorization: Bearer`; throws `MeterError` with code `network`, `http` (the message carries the status), or `parse` |
| `MeterError(message, code)` | the error class `bearerJson` throws |
| `snapshot({ pool, five_hour, seven_day, monthly, monthly_quota, plan_type, used_usd })` | builds a snapshot, filling `captured_at` and any missing window with nulls |
| `pct(used, cap)` | a percentage clamped to 0..100, or `null` when `cap` is not positive |

## The snapshot

```text
{ captured_at: iso, pool,
  five_hour:  { utilization, resets_at },
  seven_day:  { utilization, resets_at },
  monthly:    { utilization, resets_at },
  monthly_quota?: { used, limit, remaining, unit },
  plan_type?: string | null,
  used_usd?: number | null }
```

`utilization` is 0..100 or `null`; `resets_at` is an ISO timestamp or `null`. Pacing reads `five_hour`, `seven_day`, and `monthly` (see [Routing](/guide/routing)). Display reads `plan_type` and `monthly_quota`.

## Pool fields and who reads them

These are all the pool fields a provider may set, and the part of the core that reads each one. A field no core consumer reads is not part of the contract.

| Field | Read by |
|---|---|
| `name` (required) | routing, strategy state, meter cache, quarantine |
| `spawn.cmd` with `{taskFile}` (required), `spawn.cwdMode` | the runner (`src/lib/watch.js`). Placeholders: `{taskFile}`, `{cwd}`, `{sessionId}`, `{bullswarmDir}`. `cwdMode: "pwd"` makes the runner set `PWD` and spawn inside the target repository, for CLIs that resolve their project from `$PWD` |
| `outputExtraction.strategy` (required: `stdout`, `stdout-tail`, `json-field`, `file`, `event-stream`), `eventStream.output` | the watcher |
| `model`, `modelSelection.flag` and `mode`, `knownModels`, `modelDiscovery` (required: at least `model`) | dispatch, `set-rung`, model discovery. The only `mode` is `replace-or-append` |
| `displayName` (a provider export) | strategy tables |
| `bin`, `configDirs` | the default `setup` health check |
| `env` | merged into the child process environment verbatim, never inspected |
| `conversation.newArgs`, `resumeArgs` | dispatch session resume |
| `eventStream.rules`, `silenceThresholdSec`, `modelPaths`, `args`, `format` | watcher progress and silence detection |
| `eventStream.capture.responseBytes`, `capture.fileBytes` (both optional positive integers) | the per-attempt stream sink (`src/lib/attempt-stream.js`). Core defaults are 64000 bytes per persisted `response` event and 1048576 bytes per stream file; set either only when this CLI's answers or event volume make the default the wrong size. Omit the block and a connector still gets a persisted stream with no code |
| `authSignatures`, `quotaSignatures` | verdict classification and quarantine. Generic phrases stay core defaults; list only this CLI's own |
| `modelProfiles[]` (`match`, `tier`, `qualityRank`, `pricing`, `pricingSource`, `pricingUpdatedAt`, `autoRecommend`, `free`, `benchmark`) | rungs, the spend model, benchmarks |
| `reasoning.flag` or `args`, `levels`, `defaults`, `skipModels` | the reasoning precedence chain ([Configuration](/reference/configuration)) |
| `meter.type` (`none`, `declared`, `reader`), `meter.window` | the pool builder's meter ladder: a `readUsage` reading first, then a declared meter, then unmetered |
| `subscription.plan`, `quotaWindow`, `includedValueUsd`, `resetsAt`, `monthlyPriceUsd` | the pacing window and its denominators; values set in strategy state override them |
| `costRank` (default 5), `lanes` (default all), `capabilities`, `flags.testFixture`, `flags.isCaller`, `flags.stealth` | routing and strategy |
| `credentialGroup` (a string; the older `upstreamGroup` is still read) | quarantining siblings that share a credential, and dispatch avoidance |
| `profile.providerId` | dispatch accepts an `<id>/<model>` pin only on this pool. `profile.configDir` and `profile.command` are display only |

For each attempt, a connector with `eventStream.format: "jsonl"` leaves a
bounded `stream-<actionId>-attempt-<n>.jsonl` file: head records, one
`{"truncated":true,"dropped":<n>}` marker, then tail records. A connector with
no event stream leaves a marker-free bounded
`stdout-<actionId>-attempt-<n>.log` tail instead. The sink appends head records
synchronously and flushes its in-memory tail to `.tail` every 32 events or 2
seconds, whichever comes first; normal close folds the segments into the final
file. After a kernel `SIGKILL` the head is on disk in the final file, the
flushed `.tail` sibling is left as an orphan that nothing folds back in, and
the still-unflushed events are lost.

`meter.readerCmd` and the `{outFile}` placeholder appeared in the old schema but nothing ever read them. They are gone.

## Two rules

1. **No top-level `await` in `provider.mjs`.** Providers load synchronously through `createRequire(import.meta.url)(path)`, which cannot load a module that awaits at top level. This needs Node.js 22.12 or later. For the same reason `connectors()` must be cheap and offline: it runs on every Bullswarm start.
2. **Secrets stay out of `env`.** A pool's `env` reaches the child process verbatim. Where the CLI allows it, put a pointer there, such as a config directory, a key-file path, or a config blob with no secret in it, and never the secret itself. Credentials are the provider's business: `readUsage` reads its own key file, keychain entry, OAuth refresh, or another tool's config. The core never sees a key and has no concept of a credential.

## Example: a reseller named relay

Relay sells OpenCode access through two accounts. The provider clones the shipped `opencode` template once per account, pins each account's model and reasoning variants, groups both under one credential so a usage limit on one benches its sibling, and reports spend from a wallet:

```js
// ~/.bullswarm/providers/relay/provider.mjs
export const name = 'relay';
export const displayName = 'Relay';

export function connectors({ kit, templates }) {
  const accounts = [{ id: 'a', models: ['gpt-5.6-sol'] }, { id: 'b', models: ['gpt-5.6-sol'] }];
  return accounts.map((acc, i) => kit.clonePool(templates.opencode, {
    name: i === 0 ? 'relay' : `relay:${acc.id}`,
    model: `${acc.id}/gpt-5.6-sol`,
    env: { OPENCODE_CONFIG_CONTENT: kit.opencodeVariants(acc.id, acc.models) },
    profile: { providerId: acc.id },
    credentialGroup: 'relay:relay.example',
    meter: { type: 'reader', window: 'monthly' },
    subscription: { plan: 'relay-wallet', quotaWindow: 'monthly' },
  }));
}

export async function readUsage(pool, { kit, subscription }) {
  const usedUsd = 12.5;                              // a real provider fetches this
  const included = subscription?.includedValueUsd ?? null;
  return kit.snapshot({ pool, used_usd: usedUsd,
    monthly: { utilization: kit.pct(usedUsd, included), resets_at: null } });
}
```

This yields two pools, `relay` and `relay:b`. `OPENCODE_CONFIG_CONTENT` holds model and variant declarations only; OpenCode reads the key from its own config file. With no `includedValueUsd` declared, `pct` returns `null` and the pool is not paced by spend. Declare one with `bullswarm strategy set-subscription relay`. With no reset date from the wallet, pacing uses a reset you declare with `--resets-at <iso>`.

The `usedUsd = 12.5` line is a placeholder: a real `readUsage` fetches the wallet. Probe the pool before enabling it so a fake number never reaches routing.

## The provider verb

| Command | What it does |
|---|---|
| `bullswarm provider list [--json]` | every provider with its tier, enabled state, pools, skipped pools, error, and whether it has `readUsage` |
| `bullswarm provider enable <name>` / `disable <name>` | add or remove a contrib provider in `~/.bullswarm/providers.json`. `enable` refuses when no contrib provider of that name exists, or a local provider already uses the name |
| `bullswarm provider validate <dir\|name> [--json]` | import the directory, check `name` and the export types, call `connectors(ctx)` with real templates, and check the prefix rule and every pool against the schema. Exits 2 on any failure |
| `bullswarm provider scaffold <name> [--from <template>] [--dir <path>]` | write a commented provider directory, by default `~/.bullswarm/providers/<name>/`; `--from` copies a shipped `connector.json` into it |
| `bullswarm provider probe <pool> [--json]` | spawn the pool's CLI once with a one-word task through the dispatcher's own runner, with no routing, quota gate, or ledger, then call `readUsage` once. Prints the argv, the output, the elapsed time, and the snapshot or error. Exits 1 if the reply lacks `PONG` or `readUsage` threw. Contrib providers can be probed before they are enabled |

```bash
# Author a local provider from a shipped template, then check shape and spawn.
bullswarm provider scaffold relay --from opencode
bullswarm provider validate relay
bullswarm provider probe relay --json
```

Flags, defaults, and safety notes for each subcommand are in the [CLI reference](/reference/cli). The authoring method for agents, from discovery to enablement, ships in the packaged skill as `references/providers.md`.

## Next steps

- [CLI reference](/reference/cli) — `provider` subcommand flags
- [Configuration](/reference/configuration) — `providers.json`, local directories, and `BULLSWARM_HOME`
- [Routing](/guide/routing) — how a loaded pool is paced and picked
