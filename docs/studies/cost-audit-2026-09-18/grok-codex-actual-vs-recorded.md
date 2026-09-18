# Grok and Codex actual versus recorded cost

This audit matches the three requested Bullswarm attempts to their durable
provider records, reads the provider-reported token fields, and compares them
with the estimate stored in the completion artifact. The measured dollar
amounts below are API-equivalent published-rate calculations. They are not a
claim about a Grok Build or ChatGPT subscription debit; each recorded
completion artifact says `api-equivalent rate; subscription debit may differ`
(`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/completion-verify.json`,
`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-widget.json`,
and `/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-integrate.json`,
`.verdict.meta.usage.cost.basis`).

## Result

| Attempt and model | Recorded estimate | Measured provider usage | Measured API-equivalent USD | Measured / recorded |
|---|---:|---:|---:|---:|
| `fuyyca` / `verify-1`, Grok 4.6 | `4,316` tokens; `$0.009668` (`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/completion-verify.json`, `.verdict.meta.usage`) | `9,400,999` billed tokens (`rtk node scripts/cost-audit/grok-session-cost.mjs --log /home/dev/.grok/logs/unified.jsonl --session-id ee40deee-8f12-4dfc-98d8-4bb85d60bfef`, output below) | `$7.783282` (same reader command) | `2,178.174004x` tokens; `805.056061x` USD (ratio command output below) |
| `2yrcxi` / `widget-1`, GPT-5.6 Luna | `1,757` tokens; `$0.0006554` (`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-widget.json`, `.verdict.meta.usage`) | `37,677,530` tokens (`rtk node scripts/cost-audit/codex-session-cost.mjs /home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-9b02-7e30-a869-6ca18d6677f4.jsonl`) | `$0.96434956` (Codex arithmetic command output below) | `21,444.240182x` tokens; `1,471.390845x` USD (ratio command output below) |
| `2yrcxi` / `integrate-1`, GPT-5.6 Sol | `1,766` tokens; `$0.016424` (`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-integrate.json`, `.verdict.meta.usage`) | `8,853,907` tokens (`rtk node scripts/cost-audit/codex-session-cost.mjs /home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T12-08-59-01a0b2b4-0b9a-7161-b59d-4c7476cf26b9.jsonl`) | `$4.5087544` (Codex arithmetic command output below) | `5,013.537373x` tokens; `274.522309x` USD (ratio command output below) |

The recorded attempt identity, model, and time window are in
`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json` for
`verify-1`, and
`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/state.json` for
`widget-1` and `integrate-1`. The token and dollar values in the table come
from the completion artifacts named in the table, not from the human-readable
durations in the task prompt.

The widget rollout was selected by action identity, not by the first file
with a matching start second. The workflow event log records `widget-1`
starting at `2026-09-18T03:12:47.767Z` and finishing at
`2026-09-18T03:56:36.031Z`
(`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/events.jsonl`,
sequences `18` and `24`). The matching rollout is
`/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-9b02-7e30-a869-6ca18d6677f4.jsonl`:
its durable `task_complete` message closes that action ([other project's task
text removed]) and its last timestamp is `2026-09-18T03:56:34.042Z`. The other
nearby rollouts are separate actions of the same workflow
(`/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-997e-7972-bfbe-d2c7308f18af.jsonl`,
`/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-48-01a0b280-9c4c-7950-8d2e-a26fe7d057e6.jsonl`,
and the later
`/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-56-36-01a0b2a8-b815-79f3-a1c9-2743bebd3559.jsonl`).
They are deliberately not added to the widget total.

The remaining boundary checks are also inside their recorded windows: the
Grok state starts at `2026-09-17T21:15:23.757Z` and finishes at
`2026-09-17T21:41:21.693Z`, while the selected Grok session spans
`2026-09-17T21:15:25.266Z` through `2026-09-17T21:41:19.704Z`
(`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json` and
the Grok reader command below). The integrate state spans
`2026-09-18T04:08:58.795Z` through `2026-09-18T04:24:40.637Z`, while its
rollout spans `2026-09-18T04:08:59.351Z` through
`2026-09-18T04:24:38.410Z`
(`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/state.json` and
the integrate reader command below).

The recorded token estimates are the UTF-8 fallback components in those same
artifacts: Grok `4,057` standard-read + `259` output = `4,316` total-known;
widget `1,453` + `304` = `1,757`; integrate `1,181` + `585` = `1,766`.
The source field is `estimated:utf8-bytes/4` in each `.verdict.meta.usage`
object (`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/completion-verify.json`,
`/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-widget.json`,
and `/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-integrate.json`).

## Codex measurement

project-n documents the Codex storage layout as
`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<sessionId>.jsonl`
(`/home/dev/project-n/packages/parser/src/codex.ts:4-13`). Its parser
reads the cumulative `event_msg/token_count` total under
`payload.info.total_token_usage` and maps input, output, and cached-input
fields at lines `150-158`. It explicitly treats those values as cumulative
and attaches the final cumulative total once at lines `288-309`; summing all
`token_count` events would overcount. The parser's ordinary turn counter is
based on visible `event_msg/user_message` records at lines `161-169`.

The new dependency-free reader is
[`scripts/cost-audit/codex-session-cost.mjs`](../../../scripts/cost-audit/codex-session-cost.mjs).
It prints the last cumulative total, counts unique root/turn IDs from
`token_usage_record`, and reports both possible user-message shapes. These are
the exact rollout paths and command outputs used:

```text
rtk node scripts/cost-audit/codex-session-cost.mjs \
  /home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-9b02-7e30-a869-6ca18d6677f4.jsonl
=> model gpt-5.6-luna, turns 1, tokenCountEvents 259,
   input 37,603,121, cached input 36,919,808, cache write 0, output 74,409,
   reasoning output 34,405, total 37,677,530,
   event_msg user messages 0, response_item user messages 2,
   malformedLines 0

rtk node scripts/cost-audit/codex-session-cost.mjs \
  /home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T12-08-59-01a0b2b4-0b9a-7161-b59d-4c7476cf26b9.jsonl
=> model gpt-5.6-sol, turns 1, tokenCountEvents 72,
   input 8,834,905, cached input 8,669,696, cache write 0, output 19,002,
   reasoning output 5,771, total 8,853,907,
   event_msg user messages 0, response_item user messages 2,
   malformedLines 0
```

The rollout scan independently inspected `token_usage_record` usage and
found, for widget and integrate respectively, `259` and `72` records,
maximum input requests of `240,477` and `158,477` tokens, and `0` requests above the
OpenAI `272K` long-prompt threshold. That validation was run with:

```sh
rtk node --input-type=module <<'NODE'
import fs from 'node:fs';
const files={widget:'/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-9b02-7e30-a869-6ca18d6677f4.jsonl',integrate:'/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T12-08-59-01a0b2b4-0b9a-7161-b59d-4c7476cf26b9.jsonl'};
const out={}; for(const [name,p] of Object.entries(files)){let n=0,max=0,over=0,sum={input:0,cached:0,output:0,reasoning:0,total:0};const roots=new Set(),turns=new Set();for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){if(!l)continue;const r=JSON.parse(l);if(r.type==='token_usage_record'){if(r.payload?.root_turn_id)roots.add(r.payload.root_turn_id);if(r.payload?.turn_id)turns.add(r.payload.turn_id);const u=r.payload?.usage??{};n++;max=Math.max(max,u.input_tokens??0);if((u.input_tokens??0)>272000)over++;for(const [k,f] of [['input','input_tokens'],['cached','cached_input_tokens'],['output','output_tokens'],['reasoning','reasoning_output_tokens'],['total','total_tokens']])sum[k]+=u[f]??0;}}out[name]={tokenUsageRecords:n,sum,maxInputTokens:max,requestsOver272K:over,uniqueRoots:roots.size,uniqueTurns:turns.size};} console.log(JSON.stringify(out,null,2));
NODE
```

For the dollar calculation, output tokens include the reasoning subset in
the Codex cumulative total, so reasoning output is reported for diagnostics
but is not added a second time. The calculation uses uncached input as
`input - cached_input`, cached input at the cached-input rate, and output at
the output rate:

```sh
rtk node --input-type=module <<'NODE'
import fs from 'node:fs';
const rows=[
 {name:'widget', rollout:'/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T11-12-47-01a0b280-9b02-7e30-a869-6ca18d6677f4.jsonl', completion:'/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-widget.json', rate:{input:.2,cached:.02,output:1.2}},
 {name:'integrate', rollout:'/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T12-08-59-01a0b2b4-0b9a-7161-b59d-4c7476cf26b9.jsonl', completion:'/home/dev/.bullswarm/workflows/wf-mu6db6m7-bee921/completion-integrate.json', rate:{input:4,cached:.4,output:20}},
];
const parse=p=>{let u;for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){if(!l)continue;const r=JSON.parse(l);if(r.type==='event_msg'&&r.payload?.type==='token_count'&&r.payload.info?.total_token_usage)u=r.payload.info.total_token_usage;}return u;};
const out={};for(const x of rows){const u=parse(x.rollout), rec=JSON.parse(fs.readFileSync(x.completion,'utf8')).verdict.meta.usage, uncached=u.input_tokens-u.cached_input_tokens, cost=(uncached*x.rate.input+u.cached_input_tokens*x.rate.cached+u.output_tokens*x.rate.output)/1e6;out[x.name]={recordedTokens:rec.tokens.totalKnown,recordedUsd:rec.cost.estimatedUsd,actualTokens:u.total_tokens,actualUsd:Number(cost.toFixed(8)),uncachedInput:uncached,cachedInput:u.cached_input_tokens,output:u.output_tokens,tokenRatio:Number((u.total_tokens/rec.tokens.totalKnown).toFixed(6)),usdRatio:Number((cost/rec.cost.estimatedUsd).toFixed(6))};}console.log(JSON.stringify(out,null,2));
NODE
```

The command output was:

```text
widget: recordedTokens 1757, recordedUsd 0.0006554,
  actualTokens 37677530, actualUsd 0.96434956,
  uncachedInput 683313, cachedInput 36919808, output 74409,
  tokenRatio 21444.240182, usdRatio 1471.390845
integrate: recordedTokens 1766, recordedUsd 0.016424,
  actualTokens 8853907, actualUsd 4.5087544,
  uncachedInput 165209, cachedInput 8669696, output 19002,
  tokenRatio 5013.537373, usdRatio 274.522309
```

The vendor pages name the exact models. OpenAI's GPT-5.6 Luna page says
“Per 1M tokens — Input $0.20, Cached input $0.02, Output $1.20”
([model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
lines `888-902`) and applies the `>272K` input multiplier at line `923`.
The GPT-5.6 Sol page says “Per 1M tokens — Input $4.00, Cached input $0.40,
Output $20.00” ([model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
lines `887-901`) and gives the same long-prompt rule at line `924`.
Therefore the two Codex sessions use the short-context rates: no request in
the rollout scan crossed that threshold.

## Grok measurement

The Grok provider module confirms that Bullswarm's meter is a weekly credit
endpoint, not a per-session token ledger: `src/providers/grok/provider.mjs`
defines `CREDITS_URL` and returns `seven_day` utilization in
`fetchGrokUsage` (lines `14-18`, `168-213`). The CLI does retain a session
record. The relevant safe inventory under `~/.grok` is:

```text
/home/dev/.grok/logs/unified.jsonl
/home/dev/.grok/sessions/%2Fhome%2Fdev%2FRepo%2Fbullswork%2Fbullswarm-dashboard/ee40deee-8f12-4dfc-98d8-4bb85d60bfef/
  summary.json
  events.jsonl
  chat_history.jsonl
  updates.jsonl
  prompt_context.json
  resources_state.json
  rewind_points.jsonl
  signals.json
```

No credential-bearing files were printed. The target session's
`summary.json` identifies cwd `/home/dev/Repo/bullswork/bullswarm-dashboard`
and model `grok-4.6`; `events.jsonl` contains one `turn_started`, `58`
`loop_started` events, and one completed `turn_ended`. The session ID is
`ee40deee-8f12-4dfc-98d8-4bb85d60bfef`, selected by matching the
`verify-1` window in
`/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/state.json`.

[`scripts/cost-audit/grok-session-cost.mjs`](../../../scripts/cost-audit/grok-session-cost.mjs)
filters `~/.grok/logs/unified.jsonl` to that session ID and sums each
`shell.turn.inference_done` record. Its exact command output was:

```text
rtk node scripts/cost-audit/grok-session-cost.mjs \
  --log /home/dev/.grok/logs/unified.jsonl \
  --session-id ee40deee-8f12-4dfc-98d8-4bb85d60bfef \
  --session-dir /home/dev/.grok/sessions/%2Fhome%2Fdev%2FRepo%2Fbullswork%2Fbullswarm-dashboard/ee40deee-8f12-4dfc-98d8-4bb85d60bfef
=> model grok-4.6, turns 1, inferenceLoops 58, inferenceRecords 58,
   prompt 9,311,859, cached prompt 9,046,912,
   uncached prompt 264,947, completion 58,164,
   reasoning 30,976, totalBilledTokens 9,400,999,
   short-context requests 42 / $3.393098,
   long-context requests 16 / $4.390184,
   apiEquivalentUsd $7.783282, malformedLines 0
```

Grok's model page names the exact rate card: “Input Tokens $2.00/1M
tokens,” “Cached tokens $0.50/1M tokens,” and “Output Tokens $6.00/1M
tokens” ([Grok 4.6 pricing](https://docs.x.ai/developers/models/grok-4.6),
lines `261-277`). The model page says requests exceeding the `200K` context
window use higher-context pricing (lines `285-287`). The xAI API pricing table
names the exact long-context row for `grok-4.6`: short `2 / 0.50 / 6` and
long `4 / 1 / 12` USD per million input/cached/output tokens, with the
threshold shown as `≥ 200k` ([API pricing](https://docs.x.ai/developers/pricing),
lines `226-238`). xAI's usage/pricing page specifies that reasoning tokens use
the full completion rate and that, when the total prompt exceeds the
threshold, cached and non-cached prompt tokens use their respective
long-context rates ([usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing),
lines `306-312`). The Grok reader therefore prices `42` prompts below
`200,000` at input/cache/output rates `2 / 0.5 / 6` USD per million, and
`16` prompts at or above that threshold at `4 / 1 / 12`, charging reasoning
at the completion rate. The exact arithmetic and ratio command output was:

```sh
rtk node --input-type=module <<'NODE'
import fs from 'node:fs';
const sid='ee40deee-8f12-4dfc-98d8-4bb85d60bfef';
const log='/home/dev/.grok/logs/unified.jsonl';
const grokRecorded=JSON.parse(fs.readFileSync('/home/dev/.bullswarm/workflows/wf-mu5ul9j7-4a3a73/completion-verify.json','utf8')).verdict.meta.usage;
let total={prompt:0,cached:0,completion:0,reasoning:0,cost:0,requests:0,long:0,short:0};
for (const line of fs.readFileSync(log,'utf8').split(/\r?\n/)) { if (!line) continue; const r=JSON.parse(line); if(r.sid!==sid||r.msg!=='shell.turn.inference_done') continue; const c=r.ctx??{}; const p=Number(c.prompt_tokens)||0, cache=Math.min(p,Number(c.cached_prompt_tokens)||0), comp=Number(c.completion_tokens)||0, reason=Number(c.reasoning_tokens)||0; const long=p>=200000; const rates=long?{input:4,cached:1,output:12,reasoning:12}:{input:2,cached:.5,output:6,reasoning:6}; total.prompt+=p; total.cached+=cache; total.completion+=comp; total.reasoning+=reason; total.cost+=((p-cache)*rates.input+cache*rates.cached+comp*rates.output+reason*rates.reasoning)/1e6; total.requests++; total[long?'long':'short']++; }
total.totalBilled=total.prompt+total.completion+total.reasoning; console.log(JSON.stringify({recordedTokens:grokRecorded.tokens.totalKnown,recordedUsd:grokRecorded.cost.estimatedUsd,actual:total,tokenRatio:Number((total.totalBilled/grokRecorded.tokens.totalKnown).toFixed(6)),usdRatio:Number((total.cost/grokRecorded.cost.estimatedUsd).toFixed(6))},null,2));
NODE
```

The command output was:

```text
recordedTokens 4316, recordedUsd 0.009668,
prompt 9311859, cached 9046912, completion 58164, reasoning 30976,
requests 58, long 16, short 42, totalBilled 9400999,
cost 7.783282000000002, tokenRatio 2178.174004,
usdRatio 805.056061
```

The extra precision in the arithmetic command is ordinary floating-point
representation; the report uses the reader's rounded `$7.783282` output.

## Validation and boundaries

Focused validation passed:

```text
rtk node --check scripts/cost-audit/codex-session-cost.mjs
rtk node --check scripts/cost-audit/grok-session-cost.mjs
=> exit 0 for both files
```

Both readers were then executed against the exact provider records shown
above; both reported `malformedLines 0`. The arithmetic commands reproduced
the table's actual USD values and ratios. No files under `src/`, `tests/`,
`~/.bullswarm`, `~/.claude-acme`, `~/.codex`, or `~/.grok` were modified, and
no commit or other git-changing command was run. The only delivered files are
the two readers and this report.

`rtk npm test` was also run as a repository-wide check. It exited `1` with
`1,228` tests, `1,200` passing, and `28` failing. The failures are existing
terminal-rendering assertions in `tests/dash-kit.test.js` (Unicode glyphs
were rendered as ASCII); the test output also reports that `NO_COLOR` is
ignored because `FORCE_COLOR` is set. None of the failures exercise either
new reader, so this unrelated environment-sensitive suite failure remains
unfinished.

The unresolved boundary is billing identity: the durable records expose
provider token counts and published-rate equivalents, but neither CLI log
exposes a subscription debit. A provider billing export would be required to
turn the API-equivalent USD values into account-charge values.
