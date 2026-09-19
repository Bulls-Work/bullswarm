# Budget page audit — 2026-09-18

This is a read-only audit of the Budget page as it looked in a phone capture
taken at the cutoff. The capture itself is not kept in the repository, so the
"capture" values below are the transcription made at audit time. The live
checks use the cutoff
`2026-09-18T06:20:00Z`, the time named by the task brief. The checkout and
`/home/dev/.bullswarm` were not modified.

The capture and the live home are not one frozen corpus. The current meter
files are captured a few minutes later and the current rollup index contains
additional finished work. I therefore label capture values, current
rollup values, and raw-attempt values separately.

## Evidence commands and sources

The following read-only checks were run from this repository.

- **State scan:** a Node scan of
  `/home/dev/.bullswarm/workflows/*/state.json` counted attempts,
  `usage.tokenSource`, wall minutes, and `usage.cost.estimatedUsd`; the global
  result was `311` state files, `0` parse errors, and `1,802` attempts, with
  `1,724` `estimated:utf8-bytes/4`, `33` `provider-reported`, and `45`
  missing token-source values (command: `rtk node --input-type=module` scan of
  that path).
- **Budget reconstruction:** a Node command imported
  `src/meters/registry.js`, `src/lib/spend.js`,
  `src/workflow/budget-model.js`, and `src/meters/framework.js`, then read
  `/home/dev/.bullswarm/history/runs.jsonl`,
  `/home/dev/.bullswarm/state.json`, and
  `/home/dev/.bullswarm/meters/history/*.jsonl`; it rebuilt
  `budgetModel()` at the cutoff.
- **Meter samples:** the latest history line not later than the cutoff was
  read from each of
  `/home/dev/.bullswarm/meters/history/claude-code.jsonl`,
  `/home/dev/.bullswarm/meters/history/claude-code:acme.jsonl`,
  `/home/dev/.bullswarm/meters/history/codex.jsonl`,
  `/home/dev/.bullswarm/meters/history/grok.jsonl`, and
  `/home/dev/.bullswarm/meters/history/command-code.jsonl`.
- **Raw meter-window minutes:** a second Node scan clipped each completed
  attempt interval in `/home/dev/.bullswarm/workflows/*/state.json` to
  the reset-to-cutoff window read from the meter-history files. It did not use
  the Budget rollup's whole-run selection.
- **Focused tests:** `rtk node --test tests/usage.test.js
  tests/spend.test.js tests/workflow-rollup.test.js
  tests/workflow-stats-model.test.js tests/workflow-budget-model.test.js
  tests/workflow-history.test.js`.

## 1. How invocation usage is produced

`src/lib/watch.js:427-445` writes the task, runs the selected connector,
extracts its semantic output, and calls
`estimateInvocationUsage({ taskText, outputText, connector, model,
subscription })`. For event streams, `src/lib/watch.js:357-381` takes the
decoder output before falling back to stdout/stderr.

`src/lib/usage.js` has exactly two byte-estimate sites:

1. `src/lib/usage.js:94-103` uses reported counters when
   `parseReportedUsage()` finds them. Otherwise `standardRead` is
   `estimateTextTokens(taskText)`, and `output` is
   `estimateTextTokens(outputText)`.
2. `src/lib/usage.js:14-17` defines that fallback as
   `Math.ceil(Buffer.byteLength(text, 'utf8') / 4)`, with a minimum of `1` for
   non-empty text. Thus both the task text and the extracted answer can be
   estimated from bytes; cache-read and cache-write fields stay `null` unless
   a recognized counter is found.

`src/lib/usage.js:19-50` is text matching, not provider-schema parsing. It
   recognizes `input_tokens`/`inputTokens`/`prompt_tokens`/`promptTokens`, the
   three cache-read aliases, the three cache-write aliases, and
   `output_tokens`/`outputTokens`/`completion_tokens`/`completionTokens`.
   `lastCounter()` sums every matching occurrence in the extracted text.
   `src/lib/usage.js:104-118` sums finite fields into `totalKnown` and prices
   them with the selected connector model profile. `src/lib/usage.js:126-149`
   labels the result `estimated:utf8-bytes/4` or `provider-reported`, records
   `cost.estimatedUsd`, and derives `normalizedQuota.estimatedPercent` only
   from that API-equivalent estimate and a declared included value.

The connector output rules do not import native billing objects into this
path. Claude extracts only the `result` string
(`src/providers/claude-code/connector.json:32-47`); Codex extracts
`item.text` (`src/providers/codex/connector.json:31-91`); Grok extracts text
`data` (`src/providers/grok/connector.json:22-92`); command-code extracts
`finalText` (`providers/contrib/command-code/connector.json:29-125`); and
OpenCode extracts `part.text` (`providers/contrib/opencode/connector.json:14-26`).
If a provider's final text happens to contain token-shaped keys, the text
parser can call that `provider-reported`; a sibling `usage` object is not
automatically consumed.

The provider modules' `readUsage` exports are quota readers, not per-attempt
token readers: Claude parses its OAuth quota response
(`src/providers/claude-code/provider.mjs:315-393`), Codex parses WHAM windows
(`src/providers/codex/provider.mjs:157-203,234-277`), Grok parses its weekly
credits endpoint (`src/providers/grok/provider.mjs:168-214`), and command-code
parses credit windows (`providers/contrib/command-code/provider.mjs:190-236`).
OpenCode has no meter reader (`providers/contrib/opencode/provider.mjs:1-7`).

The actual state corpus showed provider-reported invocation usage only for:

| pool | attempts with `provider-reported` | evidence |
| --- | ---: | --- |
| `claude-code` | `18` | state-scan command over `/home/dev/.bullswarm/workflows/*/state.json` |
| `claude-code:acme` | `11` | same state-scan command |
| `command-code` | `4` | same state-scan command |
| `codex` | `0` | same state-scan command |
| `grok` | `0` | same state-scan command |

Examples were `/home/dev/.bullswarm/workflows/wf-mtcof6lr-187c3e/state.json`
(`claude-code`, `30,431` known tokens),
`/home/dev/.bullswarm/workflows/wf-mtscan4w-9a0baf/state.json`
(`claude-code:acme`, `420,825` known tokens), and
`/home/dev/.bullswarm/workflows/wf-mtcqlrhi-c1673e/state.json`
(`command-code`, `29,606` known tokens); these values came from the
provider-reported-example scan command.

## 2. Persistence and API≈ aggregation

V2 dispatch attaches `verdict.meta.usage` to the attempt and decision-log
record (`src/workflow/v2-dispatch.js:456-478,545-580`). The rollup path then
reads only `attempt.usage.cost.estimatedUsd`:

- `src/workflow/rollup.js:83-112` groups attempts by pool, sums wall minutes,
  known tokens, and finite estimated costs, and leaves cost `null` when no
  attempt recorded one.
- `src/workflow/rollup.js:139-165` writes those pool totals and a models map
  containing attempts/minutes but no model-level cost.
- `src/workflow/rollup.js:252-260` persists `rollup.json` and the
  `/home/dev/.bullswarm/history/runs.jsonl` index.

The resulting API≈ paths are:

- **Home and Runs:** run detail sums the current attempt estimates directly
  (`src/workflow/dashboard.js:2172-2203`); list/detail rows fall back to the
  rollup's pool `costUsd` (`src/workflow/dashboard.js:2757-2766`).
- **Stats:** pool/project rows add rollup `costUsd`; spend trends use the same
  per-pool values (`src/workflow/stats-model.js:225-237,317-378,452-521`). The
  Overview “today” tile sums only runs that finished today
  (`src/workflow/stats-model.js:783-805,938-961`). Model rows intentionally
  have `apiEquivalentUsd: null` because the rollup does not have model cost
  (`src/workflow/stats-model.js:328-336,732-755`).
- **Budget:** `src/workflow/budget-model.js:164-170` reads per-pool rollup
  `costUsd`; `src/workflow/budget-model.js:286-299` sums it over the page
  period; `src/workflow/budget-model.js:430-465` totals the rows. Subscription
  money is a separate declared price, not inferred from API≈.
- **History:** `src/workflow/history.js:108-118,240-294` sums rollup pool
  costs onto the finish day and keeps a no-cost day `null`, not zero.

The `≈` money is therefore a local model-priced proxy. It is never a provider
invoice and is not the same unit as a subscription meter percentage.

## 3. Trace of the four Budget line types

### `used … · … gone → pace`

`budget-view.js:98-109` prints `row.usedPct`, `row.elapsedPct`,
`row.paceWord`, and optional credits. `budget-model.js:282-286,348-365`
copies the provider reading into the row. `usedPct` is provider-measured; the
elapsed percentage is derived from the provider `resets_at` and the window
length by `src/meters/framework.js:36-50,111-163`; `paceWord` is the fixed
`±15` percentage-point comparison in `budget-model.js:185-191`.

At the capture cutoff, the meter-history samples were:

| pool | captured sample and provider reading | source |
| --- | --- | --- |
| `claude-code` | `64%` weekly, reset `2026-09-21T12:00:00.701129+00:00` | `/home/dev/.bullswarm/meters/history/claude-code.jsonl`, line selected at or before the cutoff (`2026-09-18T06:17:24.440Z`) |
| `claude-code:acme` | `77%` weekly, reset `2026-09-18T18:00:00.013106+00:00` | `/home/dev/.bullswarm/meters/history/claude-code:acme.jsonl`, sample `2026-09-18T06:19:18.783Z` |
| `codex` | `60%` weekly, reset `2026-09-20T02:18:33.000Z` | `/home/dev/.bullswarm/meters/history/codex.jsonl`, sample `2026-09-18T06:17:58.372Z` |
| `grok` | `99%` weekly, reset `2026-09-18T06:29:14.153Z` | `/home/dev/.bullswarm/meters/history/grok.jsonl`, sample `2026-09-18T06:16:07.384Z` |
| `command-code` | monthly utilization `0.4285714285714286%`, monthly quota `0.3` of `70` credits | `/home/dev/.bullswarm/meters/history/command-code.jsonl`, sample `2026-09-18T06:18:10.076Z` |

The capture rounds these to the visible `64/54`, `77/93`, `60/74`,
`99/100`, and `0/4` lines (source: the Budget page capture, not retained). The
latest snapshot files now show Claude weekly `65%`
(`/home/dev/.bullswarm/meters/claude-code.json`, captured
`2026-09-18T06:27:36.475Z`) while the other visible whole-percent readings
remain `77%`, `60%`, `99%`, and command-code's monthly value still rounds to
`0%` (the same five meter JSON paths). That is normal meter movement after the
capture, not evidence that the capture parser invented the used values.

### `by bullswarm … · other tools …`

`budget-view.js:111-124` prints `share.workflows`, `share.workflowMinutes`,
and `share.rest`. `budget-model.js:301-320` defines the arithmetic:

```text
workflowsPct = ratePerMinute × shareMinutes
restPct      = max(0, usedPct − workflowsPct)
```

The rate is not a token rate. `src/lib/spend.js:302-369` walks consecutive
meter-history readings with the same reset, rejects utilization drops, divides
the total utilization delta by the worker-minutes dispatched between those
readings, and requires at least `2` usable pairs and at least `5` worker
minutes (`src/lib/spend.js:45-64`). If that cannot be satisfied it tries a
whole-window bootstrap; otherwise the rate is `null`.

At the cutoff, the fitted rates were:

| pool | rate (% of its pacing window per worker-minute) | source/sample count | source |
| --- | ---: | --- | --- |
| `claude-code` | `0.090511` | `history`, `3` pairs | Budget-reconstruction command reading `/home/dev/.bullswarm/meters/history/claude-code.jsonl` and `/home/dev/.bullswarm/state.json` |
| `claude-code:acme` | `0.034051` | `history`, `146` pairs | same command and `claude-code:acme.jsonl` |
| `codex` | `0.010317` | `history`, `124` pairs | same command and `codex.jsonl` |
| `grok` | `0.15979` | `history`, `38` pairs | same command and `grok.jsonl` |
| `command-code` | unavailable (`null`) | no usable pair | same command and `command-code.jsonl` |

The worker-minute numerator is not independently measured by the provider.
The Budget model selects whole rollup records whose **finish time** falls in
the meter window (`budget-model.js:214-224,301-307`) and sums their recorded
pool minutes. That is a derived attribution. A run that started before a
reset but finished after it is counted in full. A strict interval clip of the
completed attempt records gives, at the same cutoff:

| pool | Budget share minutes | strict attempt minutes in reset→cutoff window | source |
| --- | ---: | ---: | --- |
| `claude-code` | `41.77` | `33.13` | Budget reconstruction versus raw-window scan of `/home/dev/.bullswarm/workflows/*/state.json`; the extra `8.64` minutes are the whole `4f8bn2` run counted after its reset boundary (`/home/dev/.bullswarm/history/runs.jsonl`) |
| `claude-code:acme` | `1148.95` | `1148.91` | same two commands/paths; rounding difference |
| `codex` | `1083.78` | `1083.78` | same two commands/paths |
| `grok` | `832.86` | `832.86` | same two commands/paths |
| `command-code` | `19.31` | `0` | same two commands/paths; the `19.31`-minute `w89k6s` attempt finished after the monthly reset but ran before it (`/home/dev/.bullswarm/workflows/wf-mu4vhjvu-8dd5d4/state.json`) |

`rest` is not an independently measured “other tools” counter. It is just the
non-negative subtraction above; the code explicitly rejects a hidden
interactive term (`budget-model.js:366-384`).

### `room … medium runs before reset`

`budget-view.js:125-136` supplies the word “medium”. The arithmetic is
`budget-model.js:322-330`:

```text
medianRunMinutes = median(pool run minutes in the page period)
drawPerRunPct    = ratePerMinute × medianRunMinutes
fits             = floor((100 − usedPct) / drawPerRunPct)
```

So “medium” is a display label, not a provider-reported model tier and not the
`DEFAULT_EXPECTED_MINUTES` routing table in `src/lib/spend.js:197-235`. A null
rate, null run duration, or zero draw produces unknown room
(`budget-model.js:390-398`), which is why command-code correctly says “no
measured usage rate yet”.

### `so far … API-equivalent work · biggest …`

`budget-view.js:138-149` formats `row.apiEquivalentUsd` and the first two
entries from `biggestRuns`. `budget-model.js:286-299,388-389` sums each
selected rollup's pool `costUsd`; `budget-model.js:501-565` builds the
“biggest” list **by measured worker minutes**, then displays each run's
recorded API-equivalent cost. It is not a ranking by measured tokens or by
licence draw.

The money is the rollup sum of `attempt.usage.cost.estimatedUsd`
(`src/workflow/rollup.js:83-112`), which in turn comes from the byte fallback
or local model pricing described in Section 1. The Budget code itself warns
that `apiEquivalentUsd` is an estimate, not an invoice
(`src/workflow/budget-model.js:467-476`).

## 4. Page capture versus current durable state

The Budget page capture showed the following visible values (source for every
capture value in this table: the Budget page capture, not retained). The
current reconstruction at the same cutoff uses the current rollup index and
the historical meter sample, so it exposes what changed after the capture.

| pool | capture | current reconstruction at `2026-09-18T06:20:00Z` | judgment |
| --- | --- | --- | --- |
| `claude-code` | `64%`, `54%` gone, `≈4%` / `42` min, `14` runs, `≈$3.06`; biggest `dahnys ≈$0.43`, `w6p38i ≈$0.46` | `64%`, `53.8%` gone, `3.7806%` / `41.77` min, `14` fits, `apiEquivalentUsd 3.06022`; top-by-minutes `dahnys` `114.22` min / `$0.430842`, `w6p38i` `109.9` min / `$0.455542` (Budget-reconstruction command; `/home/dev/.bullswarm/history/runs.jsonl`) | Meter and arithmetic match after rounding. The `42` minutes are not a strict reset-window total: raw attempts give `33.13` minutes. |
| `claude-code:acme` | `77%`, `93%` gone, `≈36%` / `1065` min, `41` runs, `≈$2.63`; biggest `j2ws3i ≈$0.33`, `w89k6s ≈$0.20` | `77%`, `93.1%` gone, `39.1229%` / `1148.95` min, `40` fits, `apiEquivalentUsd 2.786764`; top `j2ws3i` `286.86` min / `$0.333835`, `w89k6s` `166.02` min / `$0.19541` (Budget-reconstruction command; same index path) | Screenshot is stale relative to the current index. The current completed-attempt sum is `1165.73` min and `$2.786762` over the seven-day page period (raw-state command; `/home/dev/.bullswarm/workflows/*/state.json`). |
| `codex` | `60%`, `74%` gone, `≈9%` / `922` min, `95` runs, `≈$0.18`; biggest `w89k6s ≈$0.05`, `j2ws3i ≈$0.02` | `60%`, `73.8%` gone, `11.1814%` / `1083.78` min, `92` fits, `apiEquivalentUsd 0.209959`; top `w89k6s` `294.2` min / `$0.045324`, `2yrcxi` `147.69` min / `$0.030378`, `j2ws3i` `141.31` min / `$0.015999` (Budget-reconstruction command; same index path) | Screenshot is stale. Current completed-attempt sum is `1083.77` min and `$0.20996`; the extra current rollups include `ipccf2` (`14.08` min, `$0.000656`) and `2yrcxi` (`147.69` min, `$0.030378`) (raw-state/index comparison command). |
| `grok` | `99%`, `100%` gone, `≈129%` / `807` min, no room, `≈$0.67`; biggest `jvxw6s ≈$0.18`, `y3s782 ≈$0.06` | `99%`, `99.9%` gone, `133.0827%` / `832.86` min, `0` fits, `apiEquivalentUsd 0.68325`; top `jvxw6s` `191.18` min / `$0.18411`, `y3s782` `88.68` min / `$0.06079` (Budget-reconstruction command; same index path) | The 129% idea is a derived extrapolation, not a meter reading. The current page is `133.08%` because the current rollup set is larger; the current completed-attempt sum is `817.45` min and `$0.68325` (raw-state command). |
| `command-code` | `0%`, `4%` gone, no measured rate, no room, `0 of 70` credits, `≈$0.07`; biggest `p374ea ≈$0.01`, `mbpzj2 ≈$0.01` | monthly used `0.4%` (renders `0%`), `3.8%` gone, no rate/room, `19.31` attributed minutes, `apiEquivalentUsd 0.070712`; top `p374ea` `136.82` min / `$0.006096`, `mbpzj2` `112.47` min / `$0.008008` (Budget-reconstruction command; same index path) | The credit meter is measured, but the share and room are correctly unknown. The `19.31` attributed minutes are a whole-run boundary artifact; the strict post-reset attempt total is `0`. |

The seven-day page period used by the reconstruction is not a rolling “reset
window”: `periodRange('week')` returned `from=2026-09-11T16:00:00.000Z`,
`to=2026-09-18T06:20:00.000Z`, and `days=7` (command importing
`src/workflow/stats-model.js:181-190`). The share rows use each pool's own
meter window instead. This is why a money total and the minutes printed beside
the share should not be divided to infer a price per minute.

## 5. Why the alarming figures look the way they do

### Why Grok can say `≈129%` while the meter says `99%`

At the capture cutoff the fitted Grok rate was `0.15979` percentage points
per worker-minute over `38` history pairs (Budget-reconstruction command;
`/home/dev/.bullswarm/meters/history/grok.jsonl`). The capture's
`807` attributed minutes therefore produce
`0.15979 × 807 = 128.95053`, rounded by the view to `129%` (source for `807`
is the Budget page capture; rate and multiplication are the reconstruction
command). The current set gives `0.15979 × 832.86 = 133.0827%`.

The code never clamps `workflowsPct` to the meter: it multiplies the fitted
rate by minutes (`src/workflow/budget-model.js:310-317`) and only clamps the
subtraction used for `rest` (`src/workflow/budget-model.js:318-320`). It even
records `share.exceedsMeter` when the derived value is above the provider
reading (`src/workflow/budget-model.js:366-384`). In plain words, `129%` means
“the historical utilization-per-minute slope, applied to Bullswarm's recorded
minutes, is more than one full weekly-window equivalent.” It does **not** mean
the provider meter physically reached `129%`. The slope can include shared
licence consumption by other tools, meter quantization/lag, and whole-run
boundary attribution; it is an attribution heuristic, not a provider counter.

### Why `≈$3.06` is not an Opus invoice for `42` minutes

First, those two figures are from different windows. The `42` minutes are the
Budget share's pool-meter window; `$3.06022` is the sum of rollup costs in the
seven-day page period (`budget-model.js:286-299`). The page puts them on
adjacent lines, but it does not calculate one from the other.

Second, `$3.06022` is built from local `estimatedUsd` values. For Claude Opus,
the connector's local profile is `$5` per million input tokens and `$25` per
million output tokens (`src/providers/claude-code/connector.json:74-79`),
while the fallback token count is UTF-8 bytes divided by `4`
(`src/lib/usage.js:14-17`). It has no cache-read/write count unless token-like
text happens to be parsed. A real transcript can therefore be many orders of
magnitude larger than the recorded fallback.

The companion read-only transcript audit in
`docs/studies/cost-audit-2026-09-18/claude-actual-vs-recorded.md` gives concrete
provider-token evidence: `integrate-2` recorded `$0.089705` for `5,605`
estimated tokens but its matched Claude transcript contained `34,908,081`
tokens and priced to `$22.542275`; `accept-3` recorded `$0.01664` versus
`$8.3322965` on `10,007,108` transcript tokens. Those values came from the
script commands and transcript paths listed in that file, not from elapsed
time. They demonstrate why the Budget `$3.06` line is useful only as a clearly
labelled API-equivalent estimate, not as a subscription debit or invoice.

## 6. Final classification table

| Budget figure | source kind today | trustworthy today? | What it should become when every attempt has measured token usage |
| --- | --- | --- | --- |
| `used N%` | measured provider meter snapshot | **Yes**, for the capture time and provider window; it can change between captures | Keep the provider value and capture/reset timestamp. Token usage does not replace this meter. |
| `N% of window gone` and `on track/slow/hot` | derived from provider `resets_at` and `usedPct` | **Yes** as a pacing label; not a spend amount | Keep as meter timing, explicitly separate from token/API cost. |
| `by bullswarm ≈N%` | derived: fitted meter-rate × rollup worker minutes | **No** as an actual licence share; Grok demonstrates it can exceed the meter, and reset-straddling runs are counted whole | Sum provider-reported per-attempt usage in the provider's native quota unit, reconcile that sum to the same meter window, and show unknown when the units cannot be reconciled. Do not infer it from minutes. |
| `other tools N%` | derived subtraction `max(0, used − workflows)` | **No** as an independently observed other-tools total | Show `meter remainder` only when measured Bullswarm usage and meter units are compatible; otherwise say “other usage unknown.” |
| `room about N more medium runs` | derived rate × median recorded worker minutes; “medium” is a UI label | **No** as a capacity forecast; it inherits the rate and duration problems | Use measured per-attempt token/quota units for the selected medium assignment and a measured distribution, with a minimum sample gate; otherwise show unknown. |
| `so far ≈$N API-equivalent` | estimated/local-priced sum of `attempt.usage.cost.estimatedUsd` | **No** as a bill; useful only as a labelled proxy | Use provider-reported input/cache/output tokens per attempt for API-equivalent pricing, and display provider-billed cost separately when supplied. Keep subscription debit separate. |
| `biggest: id ≈$N` | estimated cost attached to the top worker-minute runs | **No** as “most expensive”; current list is ranked by minutes | Rank by measured per-run provider usage/cost when available; show unpriced runs instead of silently ranking them as cheap. |
| `no measured usage rate yet` | label for a null fitted/bootstrap rate | **Yes** as an honest missing-data label | Retain until the measured-attempt sample and meter-unit reconciliation gates pass. |
| `0 of 70 credits` | measured command-code credit snapshot, rounded by the view | **Yes** for the captured credit endpoint; it is not token usage | Keep as the provider's credit meter and do not turn it into a share percentage without a measured rate. |

## Validation and handoff

The focused test command named in the evidence section was run after the
read-only scans. It is the relevant behavior coverage for usage parsing,
spend-rate fitting, rollups, Stats, Budget, and History: `121` tests passed,
`0` failed (`rtk node --test tests/usage.test.js tests/spend.test.js
tests/workflow-rollup.test.js tests/workflow-stats-model.test.js
tests/workflow-budget-model.test.js tests/workflow-history.test.js`, exit code
`0`). The report itself is the only file this action owns:
`docs/studies/cost-audit-2026-09-18/budget-page-audit.md`.

No source, test, provider credential, meter snapshot, workflow state, or
kernel-owned output file was edited. The integrator should treat this report
as audit evidence only; implementing provider-native per-attempt usage and
unit-reconciled licence accounting is separate work.
