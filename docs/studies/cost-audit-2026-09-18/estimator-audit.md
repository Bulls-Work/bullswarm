# Estimator audit — 2026-09-18

Scope: trace invocation token estimation, persistence, API≈ aggregation, and the
relationship to provider meters. This report is the owned deliverable for the
`estimator-audit` action. Source references use repository paths and line ranges;
the workflow-state counts and test counts are copied from the commands shown
below. No source, test, workflow state, or home-directory file was changed.

## How invocation usage is produced

`watchOnce` is the common path. It writes the caller's `taskText` to the task
file, runs the connector, extracts a semantic `output`, writes that output to the
output file, and calls `estimateInvocationUsage({ taskText, outputText:
output, connector, model, subscription })` (`src/lib/watch.js:427-445`). For an
event stream, `extractOutput` prefers the decoder's `eventOutput`, then stdout,
then stderr (`src/lib/watch.js:357-381`). The declarative event decoder only
extracts string values named by connector output rules; it does not inspect an
arbitrary usage object (`src/lib/agent-events.js:63-175`).

`estimateInvocationUsage` works as follows (`src/lib/usage.js:14-17,33-50,94-149`):

| Value | Production rule |
| --- | --- |
| Standard input/read tokens | Parse `outputText` for `input_tokens`, `inputTokens`, `prompt_tokens`, or `promptTokens`; if none is found, estimate `taskText` as `Math.ceil(Buffer.byteLength(text, 'utf8') / 4)`, with a minimum of `1` for non-empty text. |
| Cache-read/cache-write tokens | Parse the cache aliases (`cache_read_input_tokens`, `cacheReadInputTokens`, `cached_input_tokens`; and `cache_creation_input_tokens`, `cacheCreationInputTokens`, `cache_write_tokens`). Otherwise these fields are `null`. |
| Output tokens | Parse `output_tokens`, `outputTokens`, `completion_tokens`, or `completionTokens`; if none is found, estimate `outputText` with the same UTF-8-byte/`4` rule. |
| `totalKnown` | Sum every finite token field; unknown cache fields contribute nothing. |
| `tokenSource` | `provider-reported` if any recognized counter was found in `outputText`; otherwise `estimated:utf8-bytes/4`. |
| `cost.estimatedUsd` | Match the selected model to `connector.modelProfiles`, price each known token field using the profile's per-million rates, and round the sum. With no matching pricing metadata, the cost is `null`. |

The parser is text-based: `lastCounter` scans all matches for each alias and
sums them, returning `null` when no alias matches (`src/lib/usage.js:19-31`). It
does not parse a provider response schema or read a provider invoice. The cost
basis explicitly says `api-equivalent rate; subscription debit may differ`, and
the normalized-quota field is a separate estimate against declared subscription
value (`src/lib/usage.js:126-149`). Thus the byte estimate applies independently
to the task input and extracted output, while a partial provider report can mix
reported input/output with `null` cache fields.

Claude's connector declares a JSONL event stream and extracts only the final
`result` string (`src/providers/claude-code/connector.json:32-47`). Its result
event may contain sibling `usage`, `total_cost_usd`, and `modelUsage` fields in
raw provider output, but no connector rule maps those fields into `eventOutput`.
`total_cost_usd` is not one of the parser's token-counter names, and
`modelUsage` is not directly read. A camelCase token key can be counted only if
that text survives in the extracted output. The repository has raw/out examples
showing the shapes: Claude usage/`total_cost_usd`/`modelUsage` matches in
`/home/dev/.bullswarm/workflows/wf-mtcof6lr-187c3e/out-orchestrator-mtcof6mi.json`
(read-only `rtk rg -n 'usage|total_cost_usd|modelUsage' ...`), and command-code
events with `inputTokens`, `outputTokens`, `cacheReadTokens`, and
`cacheWriteTokens` in
`/home/dev/.bullswarm/workflows/wf-mtcqlrhi-c1673e/out-verify-architecture-report-mtcqsh5l.md`
(read-only `rtk rg -n 'usage' ...`). Those artifacts explain observed
`provider-reported` labels, but do not change the current connector contract.

## Provider reporting versus provider meters

The provider modules' `readUsage` exports are live quota/meter readers, not the
per-invocation `tokens` object. Claude parses its usage endpoint in
`src/providers/claude-code/provider.mjs:315-393`; Codex, Grok, and command-code
have corresponding meter readers in `src/providers/codex/provider.mjs:162-277`,
`src/providers/grok/provider.mjs:168-214`, and
`providers/contrib/command-code/provider.mjs:190-236`. OpenCode has no
`readUsage` export (`providers/contrib/opencode/provider.mjs:1-8`). The provider
CLI treats `readUsage` as an optional provider export and probe records its
result under `result.usage.snapshot` (`src/provider-cli.js:175-257,362-370,
630-679`). That snapshot is not used to populate an invocation's
`tokenSource`.

In the scanned state corpus, `provider-reported` is empirical rather than a
capability guarantee: it occurred for Claude pools and command-code output;
Codex and Grok had no such invocation label in this scan. A missing or estimated
label therefore means “what this stored output allowed the parser to know,” not
“the vendor cannot report usage.”

## Where usage is persisted

For V2 workflow actions, dispatch creates an attempt record without usage, then
adds `clone(verdict.meta?.usage ?? null)` after the attempt verdict and also puts
that usage on the decision-log record (`src/workflow/v2-dispatch.js:456-478,
545-580`). Runtime normalization preserves `attempt.usage`; `addUsage` reads
only `attempt.usage.tokens.totalKnown` into top-level workflow token totals and
does not add `estimatedUsd` there (`src/workflow/v2-runtime.js:442-487,
1351-1373`).

The single-run CLI has no `attempt` array. Its `cmdRun` calls `watchOnce`, then
stores `verdict.meta?.usage` on a `state.decisionLog` entry
(`src/cli.js:235-300,475-491,528-558`). Therefore “single-run
`attempt.usage`” is not a separate write path: the durable location is the
decision log, while V2 has both the attempt and its decision-log entry.

## How API≈ reaches the views

`src/workflow/rollup.js:15-21,80-112,139-165` derives per-pool `costUsd` from
`attempt.usage.cost.estimatedUsd` and keeps it `null` when no finite estimate is
recorded. It also sums known tokens, minutes, and attempt counts; model rows get
attempts/minutes but not a model-level cost field. `writeRunRollup` persists
those records and updates the history index (`src/workflow/rollup.js:252-260`).

- **Home.** `dashboard.js` computes live run economics by summing each
  `attempt.usage.cost.estimatedUsd`, counts priced attempts, and then feeds
  project overview and today's stats; the Home summary and spend tiles render
  that API-equivalent amount (`src/workflow/dashboard.js:2172-2203,2451-2473,
  2528-2536,3694-3723`).
- **Runs.** The same run-economics path powers active/run-detail views; recent
  rollups use direct record cost or the sum of pool `costUsd`, and step detail
  displays the individual attempt estimate (`src/workflow/dashboard.js:2639-2646,
  2757-2766,3130-3149,3363-3369`).
- **Stats.** `stats-model.js` adds pool `costUsd` into project/pool totals and
  spend trends, rounds the API-equivalent totals, and labels the basis as the
  recorded per-attempt estimate. Model rows intentionally have no cost because
  rollups do not provide model-level cost (`src/workflow/stats-model.js:225-237,
  317-378,452-521,783-805,938-961`).
- **Budget.** `budget-model.js` sums rollup API-equivalent cost per selected
  period/pool, while subscription money is a separate declared value. Its
  license-share and fit calculations use worker minutes and measured spend
  rates, not tokenSource or `estimatedUsd` (`src/workflow/budget-model.js:150-170,
  274-409,430-565`).
- **History.** `history.js` records daily spend by summing rollup pool
  `costUsd`; a day remains `null` when no cost is recorded, rather than becoming
  zero (`src/workflow/history.js:101-118,240-294`). The history view
  formats the value as an API estimate and falls back to per-pool record cost when
  needed (`src/workflow/history-view.js:141-169,311-319`).
- **Spend pacing.** `src/lib/spend.js` deliberately ignores token counts (the
  source comment says they are estimated UTF-8-byte/`4` values) and computes
  worker minutes, utilization, rates, and projections from wall-clock intervals
  and meter readings (`src/lib/spend.js:131-153,251-270,302-369,451-507`). It
  has no `tokenSource`-based API≈ aggregation. API≈ and license pacing are
  separate accounting paths.

## Read-only state scan

The following command walked `~/.bullswarm/workflows/*/state.json`, counted
attempts by `tokenSource`, and sorted the ten longest attempts by `wallSec / 60`
(falling back to the `startedAt`/`finishedAt` delta). It read only state files:

~~~sh
rtk node -e 'const fs=require("fs"),path=require("path"); const root="/home/dev/.bullswarm/workflows"; const files=fs.readdirSync(root).filter((name)=>name.startsWith("wf-")).map((name)=>path.join(root,name,"state.json")).filter(fs.existsSync); const attempts=[]; let parseErrors=0; for(const file of files){try{const state=JSON.parse(fs.readFileSync(file,"utf8")); for(const attempt of Array.isArray(state.attempts)?state.attempts:[]){const started=Date.parse(attempt?.startedAt??""); const finished=Date.parse(attempt?.finishedAt??""); const wallSec=Number(attempt?.wallSec); const minutes=Number.isFinite(wallSec)&&wallSec>0?wallSec/60:(Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started?(finished-started)/60000:null); attempts.push({file,runId:state.runId??path.basename(path.dirname(file)),actionId:attempt?.actionId??null,attemptNumber:attempt?.attemptNumber??attempt?.ordinal??null,pool:attempt?.pool??null,model:attempt?.model??null,minutes,totalKnown:attempt?.usage?.tokens?.totalKnown??null,estimatedUsd:attempt?.usage?.cost?.estimatedUsd??null,tokenSource:attempt?.usage?.tokenSource??"missing"});}}catch{parseErrors++;}} const counts={}; for(const a of attempts) counts[a.tokenSource]=(counts[a.tokenSource]??0)+1; const longest10=attempts.filter((a)=>a.minutes!=null).sort((a,b)=>b.minutes-a.minutes).slice(0,10).map((a)=>({runId:a.runId,actionId:a.actionId,attemptNumber:a.attemptNumber,pool:a.pool,model:a.model,minutes:Number(a.minutes.toFixed(2)),totalKnown:a.totalKnown,estimatedUsd:a.estimatedUsd,tokenSource:a.tokenSource,file:a.file})); console.log(JSON.stringify({stateRoot:root,filesRead:files.length,parseErrors,attempts:attempts.length,tokenSourceCounts:counts,longest10},null,2));'
~~~

The command output at audit time was `filesRead: 311`, `parseErrors: 0`, and
`attempts: 1799`, with token-source counts `missing: 46`,
`estimated:utf8-bytes/4: 1720`, and `provider-reported: 33` (all values copied
from the JSON emitted by that command; active workflows can change the corpus).

The ten longest rows from the same output were:

| Run / action / attempt | Pool / model | Minutes | `totalKnown` | `estimatedUsd` | `tokenSource` | State file |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `wf-mtshxsjk-f91d0a` / `integrate-continuation` / `3` | `claude-code` / `claude-opus-5` | `184.54` | `3037` | `0.043345` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mtshxsjk-f91d0a/state.json` |
| `wf-mu5ea0dx-b6a959` / `integrate` / `4` | `opencode` / `opencode/union-alpha` | `147.28` | `3712` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json` |
| `wf-mtscan4w-9a0baf` / `integrate-acceptance` / `1` | `claude-code:acme` / `claude-opus-5` | `125.96` | `420825` | `0.209519` | `provider-reported` | `/home/dev/.bullswarm/workflows/wf-mtscan4w-9a0baf/state.json` |
| `wf-mu4vhjvu-8dd5d4` / `integrate-2` / `1` | `opencode` / `opencode/union-alpha` | `121.9` | `2465` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu4vhjvu-8dd5d4/state.json` |
| `wf-mu5ul9j7-4a3a73` / `home-runs-keys` / `1` | `opencode` / `openrouter/stealth/union-alpha` | `115.22` | `12396` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json` |
| `wf-mu4vhjvu-8dd5d4` / `dashboard-pages` / `1` | `claude-code:acme` / `claude-opus-5` | `106.81` | `4671` | `0.067935` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu4vhjvu-8dd5d4/state.json` |
| `wf-mu4vhjvu-8dd5d4` / `phone-and-step` / `1` | `opencode` / `opencode/union-alpha` | `105.78` | `2737` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu4vhjvu-8dd5d4/state.json` |
| `wf-mu43q89h-678e07` / `shell-home` / `1` | `claude-code:acme` / `claude-opus-5` | `102.78` | `3925` | `0.059265` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu43q89h-678e07/state.json` |
| `wf-mu561vxs-afd0a6` / `fix-durability-and-diff` / `1` | `opencode` / `opencode/union-alpha` | `82.85` | `2155` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu561vxs-afd0a6/state.json` |
| `wf-mu5ea0dx-b6a959` / `integrate` / `3` | `opencode` / `opencode/union-alpha` | `73.73` | `2664` | `null` | `estimated:utf8-bytes/4` | `/home/dev/.bullswarm/workflows/wf-mu5ea0dx-b6a959/state.json` |

## Validation and handoff

Focused validation was run with:

~~~sh
rtk node --test tests/usage.test.js tests/agent-events.test.js tests/spend.test.js tests/workflow-rollup.test.js tests/workflow-stats-model.test.js tests/workflow-budget-model.test.js tests/workflow-history.test.js tests/workflow-history-view.test.js tests/workflow-dashboard.test.js tests/workflow-v2-dispatch.test.js tests/workflow-v2-runtime.test.js
~~~

The test runner reported `1..276`, `# tests 276`, `# pass 273`,
`# fail 3`, `# cancelled 0`, `# skipped 0`, and `# todo 0` (command output). The three
failures were the existing `workflow-history-view` glyph expectations: tests
expected a check mark while the renderer emits `+` for the newest/finished
entries and its shared palette. The usage, event-decoder, spend, rollup, stats,
budget, dashboard, dispatch, and runtime checks passed. This is validation
coverage, not a claim that the whole repository is green.

Unfinished: none within this owned report. Integrator request: consume this file
as the evidence report; any change to parse provider-native usage or reconcile
API≈ with invoices requires a separate, explicitly scoped implementation task.

Plain-words verdict: API≈ is a useful, model-priced proxy, not a provider bill.
Most rows are UTF-8 byte estimates of the task text and extracted output; a
smaller set is counted from token-shaped text in provider output. Even when a
provider supplies `total_cost_usd` or `modelUsage`, the current path recomputes
cost from local model pricing and does not import that billed amount. `null`
means the parser or pricing metadata could not produce a known estimate. The
license/spend figures shown beside it come from wall time and meter history, so
neither number should be presented as the other's invoice.
