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

Local providers live under the Bullswarm home, so `BULLSWARM_HOME` moves them too. Under `node --test` local providers are skipped unless a test passes the directory explicitly. Existing `~/.bullswarm/connectors/*.json` files keep working as local providers made of JSON alone, except for the old copies of packaged connectors described in [Copies in `<home>/connectors/`](#copies-in-home-connectors).

"Enabled" means two separate things, and both remain. A contrib provider is enabled, or loaded at all, through `providers.json`. A pool that is loaded is enabled or disabled for routing through `bullswarm strategy set-provider`.

## Loading

The loader reads first-class, then enabled contrib, then local providers, synchronously, on every Bullswarm start.

- Every pool a provider returns must be named `name` or `name:<suffix>`. A pool that breaks the rule is skipped.
- A pool whose name is already taken is skipped, never overwritten.
- Bad JSON, an import error, or a thrown `connectors()` is caught and recorded on that provider. A run never crashes because of a provider.

Skipped pools and errors are shown by `bullswarm setup` and `bullswarm provider list`.

## Copies in `<home>/connectors/`

Until 0.29.0, `bullswarm setup` copied every packaged connector into `<home>/connectors/<name>.json`. The loader read only those copies, and `setup` overwrote each copy that differed from the package. Since 0.29.0 nothing makes copies, but older homes still hold them, and every verb still fills newly shipped fields into them. Which file is read:

- **The package wins for its own pools.** A copy named after a pool that a loaded packaged provider defines (`claude-code.json`, `codex.json`, `grok.json`, `echo.json`, or a contrib connector you enabled) is skipped as a duplicate. Its prices and rows are never used. A `claude-code.json` from 0.28.8 still holds the old Opus 5 catch-all row, but `claude-opus-5-5` is priced from the packaged $4/$20 row.
- **Otherwise the copy is the pool.** A copy is read when no loaded provider defines its pool, for example `command-code.json` while the contrib `command-code` provider is not enabled. It then serves routing with whatever fields it had.

Each verb first sorts the copies that have a packaged counterpart (a copy with none is your own local provider and is never touched):

- **An unmodified older copy follows the package.** "Unmodified" means every field holds a value that some packaged version shipped. The check uses the provider's `connector-history.json`, which holds fingerprints of every value each field ever shipped with, generated from git by `node scripts/connector-history.mjs`. A value merged by the fill-only upgrade still counts, because each of its items shipped. Such a copy moves to `<home>/connectors/retired/`, and the packaged connector loads in its place. When the copy was the pool (a contrib provider that is not enabled), the contrib provider is enabled in `providers.json` first, but only if it defines a pool of that name. Nothing is deleted.
- **An edited copy is kept.** A field no packaged version had, or a field that every version shipped and the copy removed, makes the copy yours. `bullswarm doctor` shows it under `connector-copies` as a `!` warning that never fails readiness. The warning names the edited fields and the stale ones (fields where the copy holds an older packaged value), and says whether the copy is read at all. `strategy show` prints the same lines. To use the package instead, move the file into `connectors/retired/` yourself.
- **A copy equal to the package** is left alone; it is harmless.

A test fails when a shipped `connector.json` holds a value its `connector-history.json` lacks, so regenerate the history after changing a connector.

## provider.mjs

```js
export const name = 'x';                        // required when provider.mjs exists
export const displayName = 'X';                 // optional
export function connectors(ctx) {}              // optional; sync, returns Pool[]
export async function discoverModels(pool, ctx) {} // optional; returns { models, command }
export async function readUsage(pool, ctx) {}   // optional; returns a Snapshot
export function buildTranscriptIndex({ home }) {}   // optional; bulk repricing hint
export function readTranscriptUsage({ provider, sessionId = null, cwd = null, startedAt = null, endedAt = null, home, index = null }) {}
export function doctor(ctx) {}                  // optional; returns a health object
```

| Export | Contract | When absent |
|---|---|---|
| `name` | the provider's name and the prefix of every pool it returns | the `name` in `connector.json` |
| `displayName` | the label strategy tables print | the provider name |
| `connectors(ctx)` | synchronous, cheap, no network; returns an array of pools | one pool: the template |
| `discoverModels(pool, ctx)` | async; performs this CLI's bounded, no-prompt discovery protocol and returns `{ models: [{ id, ...metadata }], command }` | core runs the connector's declarative `modelDiscovery.cmd`, or falls back to `knownModels` |
| `readUsage(pool, ctx)` | async; returns a [snapshot](#the-snapshot); throws an `Error`, with an optional `.code` | the pool falls back to a declared meter, else it is unmetered |
| `buildTranscriptIndex({ home })` | optional; builds a reusable index for this provider's durable store during bulk repricing | each lookup may scan the provider store directly |
| `readTranscriptUsage(args)` | optional; sums this provider's durable transcript for one attempt and returns token classes plus `confidence` (`exact`, `window`, `ambiguous`, or `none`) | the attempt falls through to a UTF-8 byte estimate, then `unknown` |
| `doctor(ctx)` | returns `{ installed: boolean, loggedIn: boolean \| null, hint?: string }` | installed means `bin` is on `PATH`; logged in means any `configDirs` entry exists |

The core never branches on a thrown error's `code`; it is there for people reading the output of `bullswarm provider probe`. A failed `discoverModels` call is different: strategy records the error, labels the source `connector-fallback`, and uses `knownModels` only for that failed/old-CLI case.

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

`discoverModels` receives the concrete pool as its first argument, including that pool's `env`. Account-cloned providers must launch discovery with this environment so availability is measured for the same login that will run the work.

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
| `model`, `modelSelection.flag` and `mode`, `knownModels`, `modelDiscovery` (required: at least `model`) | dispatch, `set-rung`, model discovery. The only `mode` is `replace-or-append`; `knownModels` is a last-resort list when live discovery fails |
| `displayName` (a provider export) | strategy tables |
| `bin`, `configDirs` | the default `setup` health check |
| `env` | merged into the child process environment verbatim, never inspected |
| `conversation.newArgs`, `resumeArgs`, `followUp` | dispatch session resume and one connector-declared recovery turn |
| `eventStream.rules`, `silenceThresholdSec`, `modelPaths`, `args`, `format` | watcher progress and silence detection |
| `eventStream.usage` (`match`, `mode`, `fields`, optional `inclusive`) | provider-reported usage extraction; the watcher prefers this before transcript and byte fallback |
| `eventStream.capture.responseBytes`, `capture.fileBytes` (both optional positive integers) | the per-attempt stream sink (`src/lib/attempt-stream.js`). Core defaults are 64000 bytes per persisted `response` event and 1048576 bytes per stream file; set either only when this CLI's answers or event volume make the default the wrong size. Omit the block and a connector still gets a persisted stream with no code |
| `authSignatures`, `quotaSignatures`, `throttleSignatures` | verdict classification. An auth hit pauses the pool for 10 minutes; a limit notice pauses it for quota only on proof — the notice names a spent window and its reset, or the pool's meter reads 95% or more on a running window. Every other limit notice, throttle wording included, gets a bounded same-pool retry and never pauses the pool. Generic phrases stay core defaults; list only this CLI's own |
| `modelFamilies[]` (`family`, `match`, `tier`, `qualityRank`, `autoRecommend`) | strategy tier suggestions, rungs, and the per-tier model pick; see [Model families, versions, and `unranked`](#model-families-versions-and-unranked) |
| `generationFallback` (`label`, `tiers[tier].reasoning`) | strategy tier suggestions and the rung reasoning `apply` writes; see [Newest-generation fallback](#newest-generation-fallback-generationfallback) |
| `modelProfiles[]` (`match`, `tier`, `qualityRank`, `pricing`, `pricingSource`, `pricingUpdatedAt`, `autoRecommend`, `free`, `benchmark`) | rungs, the spend model, benchmarks |
| `reasoning.flag` or `args`, `levels`, `defaults`, `skipModels` | the reasoning precedence chain ([Configuration](/reference/configuration)) |
| `meter.type` (`none`, `declared`, `reader`), `meter.window` | the pool builder's meter ladder: a `readUsage` reading first, then a declared meter, then unmetered |
| `subscription.plan`, `quotaWindow`, `includedValueUsd`, `resetsAt`, `monthlyPriceUsd` | the pacing window and its denominators; values set in strategy state override them |
| `costRank` (default 5), `lanes` (default all), `capabilities`, `flags.testFixture`, `flags.isCaller`, `flags.stealth` | routing and strategy |
| `credentialGroup` (a string; the older `upstreamGroup` is still read) | quarantining siblings that share a credential, and dispatch avoidance |
| `profile.providerId` | dispatch accepts an `<id>/<model>` pin only on this pool. `profile.configDir` and `profile.command` are display only |

## First-class CLI model discovery

`strategy refresh` asks the installed CLI under each pool's own environment. It sends no user prompt and therefore consumes no model quota.

- Claude Code is started in print/stream-JSON mode with `--safe-mode` and `--no-session-persistence`. Bullswarm sends only the `initialize` control request and reads `control_response.response.models`. Safe mode disables user/project customizations, installed plugins, and hooks while retaining account auth. Claude currently returns aliases for some rows. Literal `claude-*` IDs are kept. Alias rows are converted from the CLI's structured family/version description (for example, `Opus 5.5` becomes `claude-opus-5-5`) and carry `idSource: description-inferred`; an explicit `[1m]` selector is preserved. If a future description cannot be parsed, Bullswarm does not invent an ID.
- Codex is started as `codex app-server --stdio`. Bullswarm sends JSON-RPC `initialize`, the `initialized` notification, then pages through `model/list` until `nextCursor` is empty. Hidden rows are excluded. The visible rows retain `isDefault` and `supportedReasoningEfforts`; the latter refines reasoning clamping for that model. Levels outside Bullswarm's common scale, such as `ultra`, remain recorded but are not passed as a Bullswarm reasoning level.

Both protocols have a 15-second bound and Bullswarm terminates the child after an answer, error, or timeout. A successful handshake is reported as `source: cli`. Bad JSON, an old CLI without the method, process failure, or timeout produces `source: connector-fallback`, includes the error text, and uses the connector's small compatibility list.

## Model families, versions, and `unranked`

Discovery finds a new model the day a CLI lists it. A family rule ranks it on the same day, without a new per-model row:

```json
"modelFamilies": [
  { "family": "sol", "match": "^gpt-[0-9][0-9.]*-sol$", "tier": "high", "qualityRank": 6 },
  { "family": "fable", "match": "^claude-fable-[0-9]", "tier": "high", "qualityRank": 6, "autoRecommend": false }
]
```

- **Match.** The first rule whose `match` regex (case-insensitive) hits the model id gives it `tier`, `qualityRank`, and `autoRecommend`. The id is tested without a trailing `[1m]`-style selector.
- **Version.** Bullswarm reads the version from the id: the first standalone run of digits, with `.` and `-` both separating components. `gpt-6-sol` is 6, `gpt-5.6-sol` is 5.6, `claude-opus-5-5` is 5.5, `claude-haiku-4-5` is 4.5. A vendor prefix, a `[1m]` selector, and a date stamp (`-20251001`) are ignored. Versions compare numerically, so 5.10 is newer than 5.9. For an id shape this parser cannot read, put a named capture group `(?<version>...)` in `match`.
- **Exact rows.** `modelProfiles[]` rows still apply on top of the family. A row may override a family's `tier`, `qualityRank`, or `autoRecommend` for one model. Pricing, a benchmark, and `free` are facts about one model, so they are allowed only on a row. `bullswarm provider validate` refuses them on a family, so a new version never gets an older model's price. A new model stays unpriced until a row cites its own rate card.

The built-in families:

| Connector | Family: tier, rank |
|---|---|
| `codex` | `*-astra`: high, 7 · `*-sol`: high, 6 · bare `gpt-N.M`: high, 5 · `*-terra`: medium, 4 · `*-luna`: low, 3 · `mini`: low, 2 (`gpt-5.3-codex` keeps its own row) |
| `claude-code` | `fable`: high, 6, never auto-recommended · `opus`: high, 5 · `sonnet`: medium, 4 · `haiku`: low, 3 |

Grok's two rows put its two versions on different tiers, so they form no family. The contrib providers keep their own rows.

### How a tier's candidates are ordered

For each tier, only models of that tier compete, minus any model excluded everywhere or disabled for its pool. They are compared on these keys, in this order:

1. **Quality rank**: the family's base rank, or an exact row's. This is the one quality scale. On the low tier, a free model comes before this key.
2. **Benchmarks, only to break equal ranks.** First the benchmark datapack's OpenRouter agentic, coding, and intelligence indices, compared only with other OpenRouter indices. Then a connector-declared dated `benchmark.score`, compared only with other declared scores. A benchmark never outweighs a rank, and a model without one loses only this tie-break.
3. **Budget**: live quota surplus (pace) against the pool's `costRank`, weighted per tier as before.
4. **API price**, last: the row's rate card, else the datapack's price. A known price beats an unknown one only when everything above is equal.

**Newer wins inside a family, on every tier.** Within one pool and family, a newer version is never ranked below an older one. Before sorting, each newer member takes the best key of any older member of its family in the same list. So a missing benchmark, price, or local record cannot push it below its predecessor. The report shows this as `inheritsFrom` on the candidate. Pace, pool cost, and price still order different families and pools. They never reorder one family. An exact row that sets `autoRecommend: false` removes that model from the candidates, and that is the only way an older version is suggested over a newer one.

The same ordering picks the model within a pool when a tier has an explicit allow-list, and when exclusions force a pinned model (`resolveDispatchModel`).

### Newest-generation fallback (`generationFallback`)

A connector may let a tier fall back to a newer generation when the family that normally serves it lags behind:

```json
"generationFallback": {
  "label": "gpt-{generation}",
  "tiers": { "medium": { "reasoning": "max" } }
}
```

The rule is generic. Only the connector says which tiers use it and at what reasoning.

- **Generation.** A generation is the leading version number: `gpt-6-luna` and `gpt-6-sol` are generation 6, `gpt-5.6-terra` and `gpt-5.5` are generation 5. The pool's newest generation is the highest one among the models it may recommend: discovered, ranked, not opted out, not disabled, and in a family. Only the leading number counts, so a point release of one family never makes another family look stale. `claude-opus-5-5` and `claude-sonnet-5` are both generation 5.
- **Stale.** A tier's serving family is its best-ranked family in `modelFamilies`. It is stale when none of its models is in the newest generation.
- **Fallback.** A stale tier that the connector opts in takes the newest model of the next-lower-ranked family that has one in the newest generation. It never takes a higher family. With no such family, nothing changes.
- **Reasoning.** The stand-in carries the declared `reasoning`, clamped to what that model supports: the levels its CLI reported at discovery, else the connector's `reasoning.levels`. So it is the strongest supported level not above the request, and never above `max`; a CLI-only `ultra` is outside the scale. A model the connector skips gets no level.
- **Standing.** The stand-in takes the place of the candidate it replaces, normally the stale family's newest model. Other pools are compared with it exactly as before, and the stale model is still listed directly below it with the reason.

The suggestion carries the level and the reason: `{ "model": "gpt-6-luna", "reasoning": "max", "why": "no gpt-6 terra yet, newest generation preferred" }`. `strategy show` prints `medium: codex/gpt-6-luna · max reasoning (recommended) — no gpt-6 terra yet, newest generation preferred`. The setup screens show `M  gpt-6-luna · max reasoning` with the reason below it. Applying the suggestion writes the level into that rung ([Configuration](/reference/configuration#strategy-models-and-rungs)).

Codex opts medium in, and this is an owner decision, not a benchmark result. Codex's newest generation is 6 (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`), while terra's newest is 5.6, so medium is `gpt-6-luna` at `max` today. The owner's own record backs it: 168 medium dispatches ran as luna at max reasoning, with 99% ok. Once a `gpt-6-terra` is discovered, medium is terra again at the connector's normal medium reasoning. High (astra, then sol, by family order) and low (the newest luna) do not fall back. Claude does not opt in: Sonnet 5 is in the newest generation, and Haiku takes no reasoning flag.

### `unranked`

A discovered model that matches no family and no row with a `tier` is `ranking: "unranked"` in `discoveries`. It is also listed in the report's top-level `unranked` array (`pool`, `model`, `reason`). `strategy show` and the setup review screen count these models per pool on one line (`unranked: 2 models (grok 2) · never recommended · strategy show --json lists them`), because a pool with no family rules can list hundreds; `strategy show --json` keeps the full list, and the model pickers label each one `(unranked)`. It is never dropped, and because it has no tier it is never auto-recommended. To use it, select it for a tier explicitly (`strategy set-model` or `set-rung`), or add a family rule or row.

### `eventStream.usage`

Usage rules are independent of response extraction. A rule's `mode` is `last`
for one cumulative result event, `sum` for per-request rows, or `max` for a
monotonic counter. `fields` maps provider paths to these mutually exclusive
token classes:

| Field | Meaning |
|---|---|
| `standardRead` | uncached input tokens |
| `cacheRead` | cached input tokens |
| `cacheWrite5m` / `cacheWrite1h` | five-minute or one-hour prompt-cache writes |
| `cacheWrite` | a vendor's single or aggregate cache-write counter |
| `output` | output tokens, excluding separately reported reasoning |
| `reasoning` | reasoning or thinking tokens reported by the provider |
| `sessionId`, `model`, `costUsd` | identity and diagnostic/provider-billed fields |

Some vendor counters are inclusive. The optional `inclusive` map names the
component fields contained in each parent; the decoder subtracts those
components after collection and floors the parent at zero. Codex therefore
declares `standardRead: ["cacheRead"]` and `output: ["reasoning"]`, while
Claude Code declares `output: ["reasoning"]` because its thinking count is
reported separately from output.

### `conversation.followUp`

An optional connector-owned recovery command lets the watcher send one more
turn to the same provider session when an event-stream response is visibly
truncated. It is a direct argv template, never a shell command. The watcher
substitutes `{sessionId}`, `{prompt}`, `{cwd}`, `{taskFile}`, and
`{bullswarmDir}`, then appends the declared `eventStreamArgs` (or the
connector's `eventStream.args` when the follow-up block omits it):

```json
{
  "conversation": {
    "followUp": {
      "cmd": ["example-cli", "resume", "{sessionId}", "{prompt}"],
      "eventStreamArgs": ["--json"]
    }
  }
}
```

The watcher runs at most one follow-up, using the session id decoded from the
provider's `thread.started` event, and records `outputSource: "follow-up"`.
When no `followUp` is declared, a truncated response is replaced by a derived
report containing `git status --short`, `git diff --stat`, and the last
`# tests`/`# pass`/`# fail` block found in the captured stream. Such a report
is marked `outputSource: "derived"`; a non-truncated response is never
overwritten.

### Optional normalized activity fields

Every persisted event keeps the seven transport fields — `seq`, `at`,
`source`, `providerType`, `kind`, `status`, and `summary`. Connector rules may
append these optional fields when a provider path resolves. The decoder bounds
and redacts structured values before they reach the stream; an absent value is
omitted, not guessed from a neighbouring summary.

`eventStream.toolKinds` declares how captured tool names are counted on the
Step page. It is an object whose keys are the values resolved by `kindPaths`
(matched case-insensitively) and whose values are `command`, `read`, `search`,
`edit`, or `other`. A connector owns its vocabulary; core workflow code keeps
no provider-specific tool-name table. An undeclared name remains visible and
counts as `other`. Validation warns when an event stream declares no map and
rejects values outside those five kinds.

| Field | Meaning and boundary |
| --- | --- |
| `eventId` | The provider's event identity, when one exists. |
| `turnId` | A stable provider turn identity. No shipped real fixture currently supplies one. |
| `toolCallId` | The stable id used to correlate a tool start and completion. |
| `toolName` | Provider tool name, bounded to a short scalar. |
| `arguments` / `result` | Bounded JSON-safe provider input/output; sensitive keys are redacted. |
| `providerAt` | Timestamp emitted by the provider; distinct from the kernel-captured `at`. |
| `durationMs` | Provider-reported duration in milliseconds. |
| `usage` | Per-event numeric fields from the rule: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, and optionally `costUsd` (plus `cumulative` where declared). This is not an attempt's `standardRead`/`totalKnown` aggregate. |
| `parentId` / `subagentId` | Causal or child-agent identity, only when the provider emits it and the connector maps it. |

The following matrix is what the current shipped mappings actually supplied in
the real trimmed captures under `tests/fixtures/stream/`. It describes those
captures, not a promise that every event from a provider has every field:

| Provider and capture | Optional fields supplied | Not supplied by that capture |
| --- | --- | --- |
| `codex` (`codex.jsonl`) | `eventId`, `toolCallId`, `toolName`, `arguments`, and `result` on command events; `usage` on `turn.completed` with `input`, `cacheRead`, `cacheWrite`, `output`, and `reasoning` | `turnId`, `providerAt`, `durationMs`, `costUsd`, `parentId`, and `subagentId` |
| `claude-code` (`claude-code.jsonl`) | `eventId`, `toolCallId`, `toolName`, `arguments`, `result`, and `providerAt`; `durationMs` on the result; event `usage` with input/cache/output/reasoning fields and `costUsd` on the result | No `turnId` or `subagentId`; the mapped `parentId` is null in this capture; no provider timestamp is present on the result event |
| `grok` (`grok.jsonl`) | `toolCallId`, `toolName`, `arguments`, and `result` on tool events; `eventId` on the end event; event `usage` with input/cache/output/reasoning fields and `costUsd` on the end event | No `turnId`, `providerAt`, `durationMs`, `parentId`, or `subagentId`; the tool events have no `eventId` in this capture |

For example, a Codex command can be paired because its `item.started` and
`item.completed` records both map `item.id` to `toolCallId`. Claude Code's
`tool_use_id` and Grok's `toolCallId` provide the same safe correlation. The
core does not pair two events merely because their summaries look alike.

The transcript fallback hook has this exact signature:

```js
export function readTranscriptUsage({
  provider,
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  home,
}) {
  // return { tokens, model, sessionId, file, firstAt, lastAt, requests, confidence }
}
```

`tokens` uses the same classes above plus `totalKnown`; `confidence` is
`exact`, `window`, `ambiguous`, or `none`. A provider without this hook is
valid and falls through to `estimated:utf8-bytes/4` or `unknown`.

## Contrib transcript readers

The shipped `opencode` and `command-code` contrib providers implement the
same hook instead of teaching the accounting core either CLI's storage
format. Both modules may also export `buildTranscriptIndex({ home })`; bulk
operations build one bounded index per provider and pass it back to the hook.

### OpenCode

OpenCode's durable store is the SQLite database at
`~/.local/share/opencode/opencode.db`. The reader opens that database in place
with Node's `node:sqlite` `readOnly` option; it never copies or writes the
database. `session` rows provide the directory, model, aggregate token
columns, and creation/update times. Assistant `message.data` JSON provides
the exclusive token classes (`tokens.input`, `tokens.cache.read`,
`tokens.cache.write`, `tokens.output`, and `tokens.reasoning`), model/provider
identity, `path.cwd`, and message timestamps. `part` rows are used only when
the matcher needs the first user text or task-file path; they are not needed
to sum usage.

For a pool owned by this provider (including account-shaped names such as
`opencode2:orbit-2`), matching first narrows sessions by exact `cwd` and the
attempt's inclusive start/end window. If more than one session remains, the
reader compares the first user part with the task-file path/text. A unique
match is returned with `confidence: "window"` (or `"exact"` when a session
ID was recorded); multiple candidates stay `"ambiguous"` with null token
totals. A missing session stays `"none"`.

### Command Code

Command Code's durable conversation files, when session persistence is
enabled, are JSONL files under
`~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl`. Assistant `message`
lines can carry `usage.inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, and `costUsd`, together with a model ID. The reader
normalizes fresh input as
`inputTokens - cacheReadTokens - cacheWriteTokens`; it does not treat
`inputTokens` as an additional cache class. `sessions/` hook logs and
`history.jsonl` are operational history, not authoritative token ledgers.

Since 0.35.2 the shipped Bullswarm connector leaves Command Code sessions
enabled, so each new attempt can retain a usage-bearing
`<session-id>.jsonl` transcript. Historical attempts made with `--no-session`
have checkpoint files but cannot be backfilled from those checkpoints. An
attempt recovers only when a matching, persisted JSONL transcript actually
exists; otherwise the
reader returns null usage with `reason: "no matching command-code transcript"`
or, for a matching file with no usage rows,
`reason: "command-code transcripts record no token usage"`. This is an honest
absence, not a zero-cost result.

## Provider-owned reader registry

Transcript lookup is provider-owned. Code that has loaded providers must
resolve the pool with `providerFor(providers, pool)` and obtain the optional
hook with `transcriptReaderFor(providers, pool)` from `src/lib/providers.js`.
`src/lib/transcripts/index.js`, the watcher, and `workflow reprice` use this
registry, so first-class readers and enabled contrib readers follow the same
path. A provider name is not inferred from a pool prefix in accounting code;
the loaded provider entry owns the pool (including `name:<suffix>` account
pools) and its module owns the on-disk format. A provider without a reader is
supported and falls through to the byte estimate or `unknown` path.

The registry also means a contrib provider must be enabled in
`~/.bullswarm/providers.json` before its pools and reader are loaded. Enabling
`opencode` or `command-code` does not make a reader global; it registers only
that provider's pools and hook.

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

`bullswarm provider validate` keeps its existing exit codes and reports two
non-fatal usage warnings. It warns
`eventStream.usage: eventStream is declared but no usage rules exist; attempts
require transcript or byte fallback` when a connector has an event stream with
no usage rules, and warns
`modelProfiles[i].pricing: cache-write rate missing
(cacheWrite5mUsdPerMillion/cacheWrite1hUsdPerMillion)` when a pricing block has
no published cache-write rate. The latter is intentional for vendors whose
rate card publishes cache reads but no cache-write tier; omitting the field is
preferable to silently pricing it at zero.

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
