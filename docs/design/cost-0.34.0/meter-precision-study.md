Read-only study complete. No repository files were changed; `git status --short` is clean. I also did not intentionally write to `~/.bullswarm`.

One limitation: the durable workflow state says `running`, but the process table had no active Codex/Claude/Grok workers. The timed polls therefore sampled idle provider accounts, not active agent work.

## 1. Live provider evidence

All requests used the provider paths and headers; credentials were never printed.

### Codex WHAM

Endpoint: `https://chatgpt.com/backend-api/wham/usage`, using [`loadAuth` and the provider fetch headers](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/providers/codex/provider.mjs:209>).

Raw body from poll 1:

```json
{
  "user_id": "user-STHs9jkuwH6HPtUqwylxYauO",
  "account_id": "5d76b3e4-a3ea-4761-a650-2eff3ec6c967",
  "email": "dev+codex@example.com",
  "plan_type": "prolite",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 84,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 30201,
      "reset_at": 1789870713
    },
    "secondary_window": null
  },
  "code_review_rate_limit": null,
  "additional_rate_limits": null,
  "model_usage": {
    "gpt-6-astra": {
      "available": true,
      "available_at": null,
      "credits_would_enable": false
    }
  },
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "overage_limit_reached": false,
    "balance": "0",
    "approx_local_messages": [0, 0],
    "approx_cloud_messages": [0, 0]
  },
  "spend_control": {
    "reached": false,
    "individual_limit": null
  },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": {
    "available_count": 3,
    "applicable_available_count": 0
  }
}
```

Three polls, two minutes apart:

| Poll | UTC | HTTP | `used_percent` | `reset_after_seconds` |
|---|---|---:|---:|---:|
| 1 | 2026-09-19T17:55:11.882Z | 200 | `84` | `30201` |
| 2 | 2026-09-19T17:57:12.506Z | 200 | `84` | `30080` |
| 3 | 2026-09-19T17:59:13.388Z | 200 | `84` | `29959` |

The utilization source is observed as whole-percent integer data. [`parseCodexWhamUsage`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/providers/codex/provider.mjs:145>) accepts numbers or numeric strings and does not round, so the schema could carry a float, but no sub-percent value appeared.

There is no per-request or per-day spend counter. `credits.balance` is the string `"0"`; message arrays and `available_count` are allowance metadata, not spend.

Historical meter rows confirm the coarse quantization:

```json
{"captured_at":"2026-09-19T13:48:57.710Z","weekly":{"utilization":72,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T15:25:55.935Z","weekly":{"utilization":73,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T15:31:04.490Z","weekly":{"utilization":74,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T15:36:06.545Z","weekly":{"utilization":75,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T15:46:13.743Z","weekly":{"utilization":76,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T16:06:27.285Z","weekly":{"utilization":77,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T16:31:48.492Z","weekly":{"utilization":78,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T16:41:50.284Z","weekly":{"utilization":79,"resets_at":"2026-09-20T02:18:33.000Z"}}
{"captured_at":"2026-09-19T17:02:04.189Z","weekly":{"utilization":81,"resets_at":"2026-09-20T02:18:33.000Z"}}
```

The planner’s 72→79 observation is real, but the retained history later reached 81 before 17:05.

### Claude Code

The default `claude-code` pool returned this body on all three timed polls:

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limited. Please try again later."
  }
}
```

The discovered `claude-code:acme` account, using the same reader path and headers from [`fetchClaudeUsageWithCredentials`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/providers/claude-code/provider.mjs:416>), produced:

```json
{"five_hour":{"utilization":19.0,"resets_at":"2026-09-19T21:00:00.717883+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"seven_day":{"utilization":8.0,"resets_at":"2026-09-25T18:00:00.717906+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,"seven_day_omelette":null,"tangelo":null,"iguana_necktie":null,"omelette_promotional":null,"nimbus_quill":{"utilization":0.0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"cinder_cove":null,"copper_kite":null,"harbor_lantern":null,"wattle_ember":null,"amber_ladder":null,"juniper_tide":null,"cedar_ember":null,"amber_gauge":null,"extra_usage":{"is_enabled":true,"monthly_limit":0,"used_credits":0.0,"utilization":null,"currency":"USD","decimal_places":2,"disabled_reason":null,"user_disabled":false,"spend_limit_reached":false,"credits_ever_enabled":true,"daily":null,"weekly":null},"limits":[{"kind":"session","group":"session","percent":19,"severity":"normal","resets_at":"2026-09-19T21:00:00.717883+00:00","scope":null,"is_active":true},{"kind":"weekly_all","group":"weekly","percent":8,"severity":"normal","resets_at":"2026-09-25T18:00:00.717906+00:00","scope":null,"is_active":false},{"kind":"weekly_scoped","group":"weekly","percent":8,"severity":"normal","resets_at":"2026-09-25T18:00:00.718083+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}],"spend":{"used":{"amount_minor":0,"currency":"USD","exponent":2},"limit":{"amount_minor":0,"currency":"USD","exponent":2},"percent":0,"severity":"normal","enabled":true,"disabled_reason":null,"cap":{"money":null,"credits":{"amount_minor":0,"exponent":2}},"balance":null,"auto_reload":null,"disclaimer":"Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)","can_purchase_credits":false,"can_toggle":false},"member_dashboard_available":false,"seven_day_breakdown":null}
```

Timed `claude-code:acme` polls:

| Poll | UTC | HTTP | Result |
|---|---|---:|---|
| 1 | 2026-09-19T17:59:26.786Z | 429 | rate-limited body above |
| 2 | 2026-09-19T18:01:27.006Z | 200 | 5h `19.0`, 7d `8.0` |
| 3 | 2026-09-19T18:03:27.564Z | 429 | rate-limited body above |

[`normalizeWindow`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/providers/claude-code/provider.mjs:379>) preserves any JSON number; it does not round. The successful body visibly uses one decimal place (`19.0`, `8.0`), while duplicate `limits[].percent` fields are integers.

There is no per-request counter. `used_dollars`, `remaining_dollars`, `extra_usage.daily`, and `extra_usage.weekly` are null in the successful body. `spend.amount_minor` is an aggregate credit amount, zero here.

Because of the endpoint’s 429 response, three successful two-minute Claude samples could not be obtained. The precise evidence is therefore “JSON number, observed at 0.1 percentage-point notation,” not proof that the vendor’s internal resolution is limited to 0.1.

### Grok credits

Endpoint: `https://cli-chat-proxy.grok.com/v1/billing?format=credits`. The expired local token was refreshed in memory only; the provider’s local write-back was not used.

Raw body:

```json
{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-18T06:29:14.153692+00:00","end":"2026-09-25T06:29:14.153692+00:00"},"creditUsagePercent":19.0,"onDemandCap":{"val":0},"onDemandUsed":{"val":0},"productUsage":[{"product":"GrokBuild","usagePercent":19.0}],"isUnifiedBillingUser":true,"prepaidBalance":{"val":0},"topUpMethod":"TOP_UP_METHOD_SAVED_PAYMENT_METHOD","billingPeriodStart":"2026-09-18T06:29:14.153692+00:00","billingPeriodEnd":"2026-09-25T06:29:14.153692+00:00"}}
```

Three polls:

| Poll | UTC | HTTP | `creditUsagePercent` | `productUsage.usagePercent` |
|---|---|---:|---:|---:|
| 1 | 2026-09-19T17:55:11.882Z | 200 | `19.0` | `19.0` |
| 2 | 2026-09-19T17:57:12.506Z | 200 | `19.0` | `19.0` |
| 3 | 2026-09-19T17:59:13.388Z | 200 | `19.0` | `19.0` |

[`parseGrokCreditsConfig`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/providers/grok/provider.mjs:126>) converts with `Number()` and clamps, but does not round. Observed precision is one decimal place. There is no request/day counter; the payload is a weekly aggregate. `onDemandUsed.val` and `prepaidBalance.val` are zero balance fields, not request spend.

## 2. Tonight’s seven writer attempts

The current durable records store the API amount under the compatibility path `usage.cost.estimatedUsd`; `v2-runtime.js` explicitly reads `usage.api.usd ?? usage.cost.estimatedUsd`. The seven writer amounts are:

```json
[
  {"id":"transcripts-1","apiUsd":0.0006984,"startedAt":"2026-09-19T15:27:22.413Z","finishedAt":"2026-09-19T15:47:26.954Z"},
  {"id":"provider-rules-2","apiUsd":0.001033,"startedAt":"2026-09-19T15:28:46.938Z","finishedAt":"2026-09-19T15:52:53.325Z"},
  {"id":"subscription-1","apiUsd":0.0007394,"startedAt":"2026-09-19T15:27:22.688Z","finishedAt":"2026-09-19T16:01:03.890Z"},
  {"id":"wiring-2","apiUsd":0.000899,"startedAt":"2026-09-19T15:28:47.053Z","finishedAt":"2026-09-19T15:58:39.003Z"},
  {"id":"views-1","apiUsd":0.0007854,"startedAt":"2026-09-19T15:47:27.291Z","finishedAt":"2026-09-19T16:45:30.800Z"},
  {"id":"reprice-1","apiUsd":0.000612,"startedAt":"2026-09-19T15:52:53.644Z","finishedAt":"2026-09-19T16:27:48.060Z"},
  {"id":"docs-1","apiUsd":0.000656,"startedAt":"2026-09-19T15:58:39.359Z","finishedAt":"2026-09-19T16:13:39.578Z"}
]
```

Total API amount:

```text
0.0006984 + 0.001033 + 0.0007394 + 0.000899
+ 0.0007854 + 0.000612 + 0.000656
= 0.0054232 USD
```

The Codex plan is `"prolite"`, but no monthly price is resolved for that plan, so subscription dollars must remain `null`.

### (a) Per-attempt snapshots as shipped

Using the nearest retained Codex history row at or before each attempt:

```text
transcripts     73 → 76 = 3 pp
provider-rules  73 → 76 = 3 pp
subscription    73 → 76 = 3 pp
wiring          73 → 76 = 3 pp
views            76 → 79 = 3 pp
reprice          76 → 77 = 1 pp
docs             76 → 77 = 1 pp
                               ----
                               17 pp
```

The shared pool moved only 7 percentage points over the requested 72→79 interval, so naive summation overcounts by 10 pp because the attempts overlap. In the actual shipped probe, the integrator recorded:

> “the start and end weekly snapshots were both `81%`”

That produces a false zero and no calibration sample even though the pool was visibly moving.

With whole-percent readings, an individual snapshot difference has a conservative quantization uncertainty of `<2 pp` unless the vendor’s quantizer is known to be nearest-integer (`±1 pp` difference error). A zero delta therefore does not prove zero spend.

### (b) Run-level snapshots, proportional to API USD

Weights sum to `0.0054232`. Applying the observed 7 pp to those weights:

| Attempt | Weight | Allocated quota |
|---|---:|---:|
| transcripts-1 | 12.8780% | 0.901460 pp |
| provider-rules-2 | 19.0478% | 1.333346 pp |
| subscription-1 | 13.6340% | 0.954381 pp |
| wiring-2 | 16.5769% | 1.160385 pp |
| views-1 | 14.4822% | 1.013756 pp |
| reprice-1 | 11.2849% | 0.789940 pp |
| docs-1 | 12.0962% | 0.846733 pp |
| **Total** | **100%** | **7.000000 pp** |

This conserves the run total and avoids seven independent false zeros. It still cannot identify which concurrent attempt actually caused a meter increment. Aggregate measurement error remains `<2 pp`; individual attribution error can approach the full run delta if the proportionality assumption is wrong.

If a weekly plan price were `W`, each subscription amount would be `(allocated_pp / 100) × W`. Here `W` is unknown, so USD remains null.

### (c) Continuous meter ledger

The existing live history already contains the needed sequence. During the seven writer windows:

```text
15:31:04  73 → 74   active: transcripts, provider-rules, subscription, wiring
15:36:06  74 → 75   active: transcripts, provider-rules, subscription, wiring
15:46:13  75 → 76   active: transcripts, provider-rules, subscription, wiring
16:06:27  76 → 77   active: views, reprice, docs
16:31:48  77 → 78   active: views
16:41:50  78 → 79   active: views
```

That is 6 pp attributable to the actual attempt windows. The 72→73 increment at 15:25:55 occurred before the first writer started and should be recorded as an unassigned pre-wave delta.

Splitting each increment among concurrent attempts by API USD gives:

```text
transcripts-1     0.621758 pp
provider-rules-2  0.919639 pp
subscription-1    0.658259 pp
wiring-2          0.800344 pp
views-1           2.382488 pp
reprice-1         0.298042 pp
docs-1            0.319470 pp
                   -------
                   6.000000 pp
```

This is the best of the three designs because it conserves observed meter movement, does not charge spend that happened before the attempt wave, and avoids counting the same shared delta once per overlapping attempt.

The remaining uncertainty is:

- Codex quantization: `<2 pp` aggregate over a start/end interval.
- Existing history cadence is about five minutes (`FRESH_MS = 300000`), so an increment’s exact time is only known within its poll bucket.
- Per-attempt attribution still has model uncertainty when several attempts overlap; it is bounded by the shared increment, not eliminated.

## 3. Recommended implementation

Implement design (c), with a run-level conservation record and a distinct basis such as `observed:meter-ledger`. Do not treat `deltaPct: 0` as exact zero without also recording `resolutionPct: 1`.

Exact touch points:

- [`src/meters/framework.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/meters/framework.js:323>): define meter resolution metadata and ledger interval helpers alongside `FRESH_MS`, `MeterCache`, and the history primitives.
- [`src/meters/registry.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/meters/registry.js:132>): `getMeterReading`, `appendMeterHistory`, and `readMeterHistory` are the actual live-poll hooks. The current implementation appends live reads but not cache hits; retain provider timestamps and add resolution/window metadata.
- [`src/lib/quota-snapshot.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/lib/quota-snapshot.js:85>): preserve `snapshotPool`’s `{at, window, usedPct, resetsAt, ageMs}` shape, but add a history cursor/precision marker; keep `deltaBetween` as the fallback for non-overlapping providers.
- [`src/lib/watch.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/lib/watch.js:585>): in `watchOnce`, capture the history cursor before spawn and after exit, pass `startedAt`, `finishedAt`, `pool`, and `apiUsd` to subscription accounting, and stop appending calibration samples from a single rounded start/end pair.
- [`src/lib/subscription-cost.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/lib/subscription-cost.js:252>): extend `meterDelta`/`subscriptionCost` with a history-ledger path that computes positive interval deltas, shares concurrent deltas by API USD, records `resolutionPct`, and uses `observed:meter-ledger` or `unknown:below-resolution`.
- [`src/workflow/v2-runtime.js`](</home/dev/Repo/bullswork/bullswarm-0.34.0/src/workflow/v2-runtime.js:442>): preserve the attribution envelope in `normalizeAttempt`; extend `SUBSCRIPTION_BASIS_ORDER`; reconcile same-pool attempts at the finish path around lines 1516–1548; make `addUsage` aggregate conserved ledger deltas and unassigned quota rather than summing overlapping attempt deltas.
- Keep legacy aliases (`cost.estimatedUsd`, `normalizedQuota`) and unknown-as-null behavior.

## 4. Draft `bullswarm.workflow.program.v2`

Use this with the original five-numbered requirements:

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "defaults": {
    "effort": "medium",
    "reasoning": "high"
  },
  "actions": [
    {
      "id": "meter-ledger",
      "kind": "implement",
      "purpose": "Persist provider meter history with precision metadata and concurrent-attribution inputs",
      "dependsOn": [],
      "affects": ["requirement-1", "requirement-3"],
      "ownedFiles": [
        "src/meters/framework.js",
        "src/meters/registry.js",
        "src/lib/quota-snapshot.js",
        "tests/meter-ledger.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-0.34.0, extend the live meter history path to retain provider timestamps, window identity, observed resolution, and monotonic interval deltas. Preserve cache/hold behavior and add deterministic fixture tests for whole-percent readings, resets, stale starts, and missing windows. Do not edit files outside this territory."
    },
    {
      "id": "subscription-ledger",
      "kind": "implement",
      "purpose": "Attribute quota deltas from the continuous meter ledger",
      "dependsOn": ["meter-ledger"],
      "affects": ["requirement-3", "requirement-4"],
      "ownedFiles": [
        "src/lib/subscription-cost.js",
        "tests/subscription-cost-ledger.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-0.34.0, add ledger-based subscription attribution to subscription-cost.js. Share each positive meter interval among concurrent attempts by api.usd, preserve unknown/null semantics, add observed:meter-ledger and below-resolution handling, and append calibration only for positive conserved ledger deltas. Keep legacy per-attempt behavior for non-overlapping providers."
    },
    {
      "id": "watch-ledger-wiring",
      "kind": "implement",
      "purpose": "Capture ledger cursors and attach conserved subscription attribution to every attempt",
      "dependsOn": ["meter-ledger", "subscription-ledger"],
      "affects": ["requirement-3", "requirement-4"],
      "ownedFiles": [
        "src/lib/watch.js",
        "tests/attempt-usage-ledger.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-0.34.0, update watchOnce so start/end history cursors bracket the delegate, the finished attempt receives the ledger attribution envelope, and the existing transcript/API pricing path remains unchanged. Exercise overlapping attempts and a stale-cache case through the production watch seam."
    },
    {
      "id": "runtime-ledger-rollup",
      "kind": "implement",
      "purpose": "Persist and aggregate ledger attribution through V2 attempt and run state",
      "dependsOn": ["watch-ledger-wiring", "subscription-ledger"],
      "affects": ["requirement-3", "requirement-4"],
      "ownedFiles": [
        "src/workflow/v2-runtime.js",
        "tests/workflow-runtime-ledger.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-0.34.0, preserve the full subscription attribution envelope in normalizeAttempt, extend basis ordering, reconcile same-pool concurrent attempts at the durable finish path, and aggregate conserved quota plus unassigned deltas in addUsage. Keep cost.estimatedUsd and normalizedQuota compatibility aliases."
    },
    {
      "id": "integrate-ledger",
      "kind": "integration",
      "purpose": "Reconcile the ledger implementation and run the complete acceptance suite",
      "dependsOn": [
        "meter-ledger",
        "subscription-ledger",
        "watch-ledger-wiring",
        "runtime-ledger-rollup"
      ],
      "affects": ["requirement-1", "requirement-2", "requirement-3", "requirement-4", "requirement-5"],
      "ownedFiles": [],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-0.34.0, read every dependency report, resolve shared-file requests, preserve pre-existing work, run the focused ledger tests and npm test, and exercise a copied-home seven-attempt overlap fixture. Verify that the run total equals the sum of attributed meter intervals and that unknown remains null."
    },
    {
      "id": "verify-ledger",
      "kind": "adversarial-acceptance",
      "purpose": "Independently try to break precision, concurrency, reset, and conservation guarantees",
      "dependsOn": ["integrate-ledger"],
      "affects": [],
      "ownedFiles": [],
      "evidenceFor": [
        "requirement-1",
        "requirement-2",
        "requirement-3",
        "requirement-4",
        "requirement-5"
      ],
      "prompt": "Inspect the actual implementation in /home/dev/Repo/bullswork/bullswarm-0.34.0. Use fixture histories with integer and decimal meters, unchanged rounded readings, a reset, missing polls, overlapping attempts with unequal api.usd, and an attempt that starts after an already-observed increment. Confirm conservation, bounded error metadata, correct basis labels, compatibility aliases, and null unknowns. Do not modify files."
    }
  ]
}
```

The key implementation point is to conserve the pool’s observed ledger delta first, then allocate it; independent per-attempt snapshots cannot do that with Codex’s whole-percent meter.