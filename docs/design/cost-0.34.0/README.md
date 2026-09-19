# Bullswarm 0.34.0 cost design record

This record copies the implementation contract for 0.34.0 sections A–H. The
audit that motivated it is preserved under
[`docs/studies/cost-audit-2026-09-18/`](../../studies/cost-audit-2026-09-18/),
including the [cost fix plan](../../studies/cost-audit-2026-09-18/cost-fix-plan.md),
[estimator audit](../../studies/cost-audit-2026-09-18/estimator-audit.md),
[Budget page audit](../../studies/cost-audit-2026-09-18/budget-page-audit.md),
[Claude actual-vs-recorded audit](../../studies/cost-audit-2026-09-18/claude-actual-vs-recorded.md),
and [Grok/Codex actual-vs-recorded audit](../../studies/cost-audit-2026-09-18/grok-codex-actual-vs-recorded.md).

## A. `attempt.usage` v2

Canonical record:

```ts
type AttemptUsageV2 = {
  model: string | null;
  sessionId: string | null;

  tokens: {
    standardRead: number | null;
    cacheRead: number | null;
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
    cacheWrite: number | null;       // compatibility sum/alias
    output: number | null;           // excludes separately reported reasoning
    reasoning: number | null;
    totalKnown: number | null;
  };

  tokenSource:
    | "provider-reported"
    | "transcript-summed"
    | "estimated:utf8-bytes/4"
    | "unknown";

  api: {
    usd: number | null;
    breakdown: {
      standardReadUsd: number | null;
      cacheReadUsd: number | null;
      cacheWrite5mUsd: number | null;
      cacheWrite1hUsd: number | null;
      cacheWriteUsd: number | null;  // compatibility sum/alias
      outputUsd: number | null;
      reasoningUsd: number | null;
    };
    pricedFields: string[];
    unpricedFields: string[];
    rateCard: {
      source: string | null;
      updatedAt: string | null;
    };
    basis:
      | "rate-card:complete"
      | "rate-card:partial"
      | "unknown:no-model"
      | "unknown:no-rate-card";
  };

  subscription: {
    pool: string | null;
    window: "5h" | "weekly" | "monthly" | null;
    deltaPct: number | null;
    usd: number | null;
    monthlyPriceUsd: number | null;
    windowDays: number | null;
    basis:
      | "observed:meter-delta"
      | "calibrated:usd-per-pct"
      | "unknown:no-price"
      | "unknown:no-meter"
      | "unknown:no-cost";
    snapshots: {
      start: {
        at: string;
        usedPct: number;
        resetsAt: string | null;
      } | null;
      end: {
        at: string;
        usedPct: number;
        resetsAt: string | null;
      } | null;
    };
  } | null;

  // Compatibility aliases:
  pricing: object | null;
  costSource: string | null;
  cost: {
    estimatedUsd: number | null;
    breakdown: object | null;
    basis: string;
  };
  normalizedQuota: {
    estimatedPercent: number | null;
    window: string | null;
    includedValueUsd: number | null;
    basis: string;
  };
};
```

Rules:

- Token classes are mutually exclusive. When a provider counter includes another class, subtract before storing.
- `totalKnown` is the sum of non-null exclusive classes. It is null when no token class is known.
- Missing or unknowable values are null, never zero.
- A reported zero remains zero.
- A missing price produces a null breakdown entry and appears in `unpricedFields`.
- `api.usd` is null when any positive token class is unpriced. A reported zero with no rate may appear in `unpricedFields` without preventing a complete total.
- Provider `total_cost_usd` may be retained only as diagnostic evidence; `api.usd` is the dated local rate-card calculation required by requirement 2.

Compatibility mapping:

```text
cost.estimatedUsd                 = api.usd
cost.breakdown                    = api.breakdown
cost.basis                        = api.basis
costSource                        = api.usd != null ? "local-rate-card" : null
pricing.source/updatedAt          = api.rateCard.source/updatedAt
tokens.cacheWrite                 = cacheWrite5m + cacheWrite1h, or direct generic cacheWrite
normalizedQuota.estimatedPercent  = subscription.deltaPct
normalizedQuota.window            = subscription.window
normalizedQuota.basis             = subscription.basis
tokenSource/model/sessionId       = canonical fields unchanged
```

Keep `normalizedQuota.includedValueUsd` if an older connector declared it; new subscription accounting must not depend on it.

Preference ladder:

```text
provider-reported
> transcript-summed
> estimated:utf8-bytes/4
> unknown
```

Transcript fallback is attempted only before accepting the last two.

## B. `src/lib/transcripts/`

`index.js` exports:

```js
readTranscriptUsage({
  provider,
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  home
})
```

Each provider module exports the same signature and returns:

```ts
{
  tokens: {
    standardRead: number|null,
    cacheRead: number|null,
    cacheWrite5m: number|null,
    cacheWrite1h: number|null,
    cacheWrite: number|null,
    output: number|null,
    reasoning: number|null,
    totalKnown: number|null
  };
  model: string|null;
  sessionId: string|null;
  file: string|null;
  firstAt: string|null;
  lastAt: string|null;
  requests: Array<{
    at: string|null;
    model: string|null;
    tokens: object;
    contextTier?: "short"|"long";
  }>;
  confidence: "exact"|"window"|"ambiguous"|"none";
}
```

Resolution:

1. A direct session ID selects a unique provider file/session.
2. `startedAt`/`endedAt` still slice that session so resumed conversations are not charged repeatedly.
3. Without an ID, resolve by exact cwd and inclusive attempt time window.
4. Exactly one candidate gives `confidence:"window"`.
5. Multiple candidates give `confidence:"ambiguous"` with null tokens/file; no arbitrary candidate is selected.
6. No candidate gives `confidence:"none"`.
7. An exact ID gives `confidence:"exact"`.

Provider algorithms:

- Claude:
  - Search `~/.claude/projects` and every `~/.claude-*/projects`.
  - Derive cwd slug with `cwd.replace(/[^A-Za-z0-9]/g, "-")`.
  - Traverse `<session-id>/subagents/agent-*.jsonl`.
  - Deduplicate across parent and subagents by `message.id:requestId`.
  - Missing message ID uses physical `file:line` identity.
  - Retain the last streaming row for each identity.
  - Sum only assistant rows within the attempt interval.
  - `output_tokens_details.thinking_tokens` becomes reasoning; subtract it from output.
- Codex:
  - Search `~/.codex/sessions/YYYY/MM/DD/rollout-*-${sessionId}.jsonl`.
  - Otherwise inspect `session_meta.cwd` and timestamps.
  - Never sum cumulative `total_token_usage`.
  - For a bounded attempt, use the last cumulative total at/before `endedAt` minus the last cumulative total strictly before `startedAt`; without a prior baseline, subtract zero.
  - Convert inclusive input/output to exclusive classes.
- Grok:
  - Filter `~/.grok/logs/unified.jsonl` by `sid`.
  - Sum `shell.turn.inference_done` rows within the interval.
  - `standardRead = prompt_tokens - min(prompt_tokens,cached_prompt_tokens)`.
  - Store each request so pricing can apply the 200,000-token threshold separately.
  - Requests with `prompt_tokens >= 200000` use the long-context tier.

## C. Provider hooks and stream rules

Each first-class provider exports:

```js
export function readTranscriptUsage(args) {
  return providerTranscriptReader(args);
}
```

`src/lib/providers.js` must:

- expose `entry.hasReadTranscriptUsage`;
- retain `entry.module.readTranscriptUsage`;
- provide a helper that resolves a pool through `providerFor()` and returns the hook closure;
- return null when the provider has no hook.

A provider without the hook falls through to byte estimate or unknown. It is not an error.

Exact Codex connector rule:

```json
"usage": [
  {
    "match": { "path": "type", "equals": "thread.started" },
    "mode": "last",
    "fields": {
      "sessionId": "thread_id"
    }
  },
  {
    "match": { "path": "type", "equals": "turn.completed" },
    "mode": "last",
    "fields": {
      "standardRead": "usage.input_tokens",
      "cacheRead": "usage.cached_input_tokens",
      "cacheWrite": "usage.cache_write_input_tokens",
      "output": "usage.output_tokens",
      "reasoning": "usage.reasoning_output_tokens"
    },
    "inclusive": {
      "standardRead": ["cacheRead"],
      "output": ["reasoning"]
    }
  }
]
```

`inclusive` is a generic declarative rule: after collection, subtract listed component fields, floor at zero. This keeps the Codex quirk in its connector.

Claude’s existing rule must add:

```json
"reasoning": "usage.output_tokens_details.thinking_tokens"
```

and:

```json
"inclusive": {
  "output": ["reasoning"]
}
```

Grok gets no stdout usage rule until a captured stream proves one. Its transcript hook is authoritative.

`provider validate` warnings:

```text
eventStream.usage: eventStream is declared but no usage rules exist; attempts require transcript or byte fallback
modelProfiles[i].pricing: cache-write rate missing (cacheWrite5mUsdPerMillion/cacheWrite1hUsdPerMillion)
```

The second warning remains valid for Codex/Grok because their published cards do not declare a cache-write rate.

## D. `src/lib/subscription-cost.js`

Exports:

```js
windowDays(window, resetsAt)
windowPriceUsd(monthlyPriceUsd, window, resetsAt)
subscriptionUsdFromPct(pct, windowPriceUsd)
readCalibration(pool, { home })
appendCalibration(pool, sample, { home })
subscriptionCost({ ... })
```

Formulas:

```text
windowDays("5h")      = 5 / 24
windowDays("weekly")  = 7
windowDays("monthly") = calendar duration from one UTC month before resetsAt
                         through resetsAt, in days

windowPriceUsd = monthlyPriceUsd × windowDays / 30.4375
subscriptionUsdFromPct = windowPriceUsd × pct / 100
```

Ledger path:

```text
$BULLSWARM_HOME/calibration/<pool>.json
```

Format:

```json
{
  "schema": "bullswarm.calibration.v1",
  "pool": "codex",
  "window": "weekly",
  "samples": [
    {
      "at": "2026-09-19T15:00:00.000Z",
      "apiUsd": 0.42,
      "deltaPct": 1.2,
      "runId": "wf-...",
      "attemptId": "design-1"
    }
  ],
  "usdPerPct": 0.35,
  "sampleCount": 3,
  "updatedAt": "2026-09-19T15:00:00.000Z"
}
```

Derivation:

```text
eligible samples: finite apiUsd >= 0 and finite deltaPct > 0
usdPerPct = sum(apiUsd) / sum(deltaPct)
minimum usable sampleCount = 3
maximum retained samples = newest 500
```

A changed quota-window kind starts a fresh calibration for that pool.

Decision tree:

1. Resolve plan price. If absent, preserve any observed `deltaPct` but set `usd:null`, basis `unknown:no-price`.
2. If valid same-window meter snapshots exist, calculate `deltaPct=end-start`, `usd` from window price, basis `observed:meter-delta`.
3. Otherwise, if `api.usd` is null, basis `unknown:no-cost`.
4. Otherwise, if a compatible calibration has at least three samples, calculate:
   - `deltaPct = api.usd / usdPerPct`
   - subscription USD from that percentage
   - basis `calibrated:usd-per-pct`.
5. Otherwise basis `unknown:no-meter`.

Append a sample only for `observed:meter-delta`, positive `deltaPct`, and known `api.usd`.

## E. `src/lib/quota-snapshot.js`

```js
snapshotPool(poolName, { home, now = Date.now() })
```

Implementation:

- `new MeterCache(join(home,"meters")).get(poolName)`;
- determine the pool’s quota window through the declared subscription first, then connector subscription;
- select `five_hour`, `seven_day`, or `monthly`;
- return:

```ts
{
  at: string;                 // cached captured_at
  window: "5h"|"weekly"|"monthly";
  usedPct: number;
  resetsAt: string|null;
  ageMs: number;
}
```

Return null for unreadable, missing, undated, or nonnumeric data.

```js
deltaBetween(start, end, { maxStartAgeMs = 60000 })
```

Returns either:

```ts
{ deltaPct: number, reason: null }
```

or:

```ts
{ deltaPct: null, reason:
  "missing-snapshot" |
  "stale-start" |
  "window-changed" |
  "reset-between-snapshots" |
  "counter-decreased"
}
```

Rules:

- start older than 60 seconds is stale;
- windows must match;
- reset timestamps must match when both are present;
- differing reset timestamps, or end utilization below start, invalidates observation;
- valid delta is `end.usedPct-start.usedPct`, including a measured zero.

Wiring placement:

- start snapshot: in `watchOnce`, immediately before `runDelegate`;
- end snapshot: immediately after the child exits;
- if the cached reading at end is older than 60 seconds, call `getMeterReading(poolName,{bullswarmDir:home,force:true})` once, then reread through `snapshotPool`;
- a failed forced read retains the stale cache but produces no observed delta.

## F. Wiring

Exact `watchOnce` sequence:

```text
write task file
snapshotPool(start)
runDelegate
extract output and structured event usage
estimateInvocationUsage
if source is estimated/unknown:
    resolve sessionId from structured usage, conversation, or stdout identity
    call provider readTranscriptUsage with session/cwd/time window
    if exact/window match, rebuild usage as transcript-summed
snapshotPool(end), forcing one meter read if required
attach subscription result
append calibration sample only for observed basis + known api.usd
write output
judge content
return verdict.meta.usage
```

`v2-dispatch` must pass:

```ts
{
  bullswarmDir,
  poolName: pool.name,
  runId,
  attemptId,
  conversation,
  startedAt
}
```

`usage.sessionId` uses the stream-reported ID first, then the Bullswarm conversation ID.

`bullswarm run` human output becomes one shared formatted line, for example:

```text
usage: read=14157 cache-read=6912 cache-write=0 output=7 reasoning=13 tokens (provider-reported)
cost: $0.00 api · · sub unknown (no plan price)
```

JSON output carries the complete v2 usage record without flattening.

## G. Aggregation and formatter

Per-pool rollup fields:

```ts
{
  attempts: number;
  minutes: number|null;
  tokens: number|null;
  cacheRead: number|null;
  cacheWrite: number|null;
  apiUsd: number|null;
  apiKnownSubtotalUsd: number|null;
  subscriptionUsd: number|null;
  subscriptionKnownSubtotalUsd: number|null;
  measuredAttempts: number;
  pricedAttempts: number;
  subscriptionPricedAttempts: number;
  tokenSource: TokenSource;              // worst
  subscriptionBasis: SubscriptionBasis;  // worst
}
```

Top-level run rollup adds the same cost/coverage fields under `usage`. `apiUsd` and `subscriptionUsd` are null unless every relevant attempt has that amount; partial sums live only in the explicitly named subtotal fields.

Worst-source order:

```text
unknown
< estimated:utf8-bytes/4
< transcript-summed
< provider-reported
```

Worst subscription order:

```text
unknown:no-price
< unknown:no-meter
< unknown:no-cost
< calibrated:usd-per-pct
< observed:meter-delta
```

The result envelope retains existing `usage.total`, `usage.byPool`, and `usage.bytes`, and adds:

```ts
usage.steps[actionId] = aggregate
usage.totals = aggregate
```

Each action entry may also carry its aggregate as `action.usage`; envelope validation must accept it. `workflow runs result --json` then exposes per-step and total cost; `workflow action show` already exposes individual attempts.

The one formatter is:

```js
formatMoneyPair({ api, subscription })
```

Exact basis strings:

```text
provider-reported API:        "$0.42 api"
transcript-summed API:        "≈ $0.42 api summed"
estimated API:                "~ $0.42 api estimated"
unknown API:                  "· api unknown"

observed subscription:        "1.2% wk $0.84 sub"
calibrated subscription:      "1.2% wk ≈ $0.84 sub"
unknown:no-price:             "· sub unknown (no plan price)"
unknown:no-meter:             "· sub unknown (no meter/calibration)"
unknown:no-cost:              "· sub unknown (no API cost)"
```

Pair example:

```text
$0.42 api · 1.2% wk ≈ $0.84 sub
```

Glyph rule:

```text
$ = measured provider tokens or observed meter delta
≈ = transcript sum or calibration
~ = byte estimate
· = unknown
```

Run, Home, Stats, workflow-result summaries, and single-run CLI must call this formatter; none may construct its own money label.

## H. `workflow reprice`

Command:

```text
bullswarm workflow reprice [--apply] [--since <date>|--all] [--pool <name>] [--json]
```

Behavior:

- dry-run is the default;
- terminal V2 runs only; ongoing runs are skipped;
- `--since` filters attempts by `startedAt`, inclusively;
- `--pool` is an exact pool-name filter;
- provider-reported attempts retain their measured tokens but are repriced against the current dated card;
- the default window is 30 days (`--all` overrides it); each transcript store is indexed once from bounded heads/tails, only matches are read in full, and output streams one row per decision;
- other attempts invoke the provider transcript hook;
- exact/window match writes `tokenSource:"transcript-summed"`;
- none/ambiguous writes `tokenSource:"unknown"`, `tokens.totalKnown:null`, `api.usd:null`, `cost.estimatedUsd:null`;
- historical repricing reads calibration but never appends calibration samples;
- dry-run writes neither run files nor calibration.

Exact dry-run columns:

```text
run     action          try  pool               match       tokens       api          subscription
mu5...  integrate-2       1  claude-code:acme  exact       34908081     $22.54       unknown:no-meter
```

Use `-` for null values. JSON result:

```ts
{
  action: "reprice";
  apply: boolean;
  filters: { since: string|null, pool: string|null };
  scannedRuns: number;
  scannedAttempts: number;
  matched: number;
  ambiguous: number;
  missing: number;
  changedRuns: number;
  rows: Array<{
    runId, shortId, actionId, attemptId, ordinal, pool,
    confidence, tokenSource, totalKnown, apiUsd,
    subscriptionUsd, subscriptionBasis
  }>;
  failures: Array<{runId:string,error:string}>;
}
```

On `--apply`, for each changed run:

1. atomically rewrite `state.json`;
2. recompute `state.usage`;
3. regenerate `result.json` through `createV2ResultEnvelope`, preserving its recorded `finishedAt`;
4. call `writeRunRollup(runDir,state,result)`;
5. `writeRunRollup` writes `rollup.json` and calls `appendRollupIndex`, updating `history/runs.jsonl` idempotently.

These are the same rollup/index primitives used by `cmdReindex`; do not duplicate index-writing logic.

## Open questions

- Which provider transcript stores are available in every deployment, and what retention or permission failures should be surfaced separately from an absent match?
- Should a provider-reported `total_cost_usd` ever be promoted from diagnostic evidence to a dated local card, or remain diagnostic permanently?
- How should bundled rate cards be refreshed and audited when a provider changes cache-write tiers or adds a long-context tier?
- Should calibration samples expire by age, in addition to resetting when the quota-window kind changes?
- What operator-facing policy should govern applying a reprice when a transcript match is ambiguous or a run's old provider session has been deleted?
- Should `workflow reprice` expose a bounded concurrency control for very large histories, or remain a single deterministic scan?
