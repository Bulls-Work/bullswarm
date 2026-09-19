# Step timeline study

This study is for the bullswarm Step page. It compares project-n's transcript
presentation with the event data bullswarm can currently persist, then proposes
the smallest durable contract that makes a readable attempt timeline possible.

## Evidence boundary

There were no real bullswarm stream files at the time of this study. The check
below returned `0`:

```text
find /home/dev/.bullswarm/workflows -type f -name 'stream-*-attempt-*.jsonl' -print | wc -l
0
```

The two terminal frames therefore use this real Claude transcript instead:

`/home/dev/.claude-acme/projects/-home-dev-Repo-bullswarm/af411e34-f6b3-4ca0-be25-7d8be6e024fe.jsonl`

The source window is lines 11–28 (`nl -ba <path> | sed -n '9,28p'`). It contains
the parent greeting (line 11), a human `/statusline` request (lines 14–15), an
`Agent` tool call for `statusline-setup` (line 18), its dispatch result (line
19), the parent background message (line 25), and a completed task notification
(line 27). A focused extraction command also observed the Agent call's usage as
`input: 2`, `output: 219`, `cacheRead: 37009`, `cacheWrite: 332`; the nested
completion usage was `subagent_tokens: 23676`, `tool_uses: 2`,
`duration_ms: 25495`. Those are source observations, not estimates.

The frame dimensions are the requested `55×26` and `120×40` from the task-step
instruction; the files are checked for those exact dimensions below. No stream
or transcript was edited.

## What project-n does

### Parse into a provider-neutral event model

project-n's `SessionEvent` has explicit roles (`user`, `agent`, thinking,
tool-call, tool-result, system, meta), the original timestamp, a session-relative
offset and inter-event gap, message/request identifiers, full content blocks,
usage, model, tool name/use id and tool result (`packages/parser/src/types.ts:9-16,
41-67`). Its content block union keeps tool input and result payloads available
to drawers (`types.ts:29-39`). `Usage` separates fresh input, output, cache-read
and cache-write tokens (`types.ts:18-27`).

The Claude adapter reads parent JSONL plus the sibling `subagents/` directory,
deduplicates parent/subagent usage by message/request key, and loads each
`agent-<id>.jsonl` sidechain (`claude-code.ts:263-323, 404-425`). A subagent
summary records start/end wall time, duration, session-relative offsets, event
count, deduped usage, parent UUID/tool-use id, background flag, prompt, model,
tool counts and final text (`claude-code.ts:434-552, 616-699`; the public shape is
`types.ts:192-248`). Parent dispatches are matched to sidechains by description
first and then by a timestamp tolerance (`claude-code.ts:554-613`).

The Codex adapter maps its `event_msg`/`response_item` vocabulary into the same
roles: user and agent messages, reasoning, function calls and function-call
outputs (`codex.ts:7-17, 161-285`). It retains function-call name, call id,
parsed arguments, output and error status (`codex.ts:238-275`). Cumulative
`token_count` usage is attached once to the final agent-side event, then
timestamps become offsets/gaps and session duration/active time (`codex.ts:288-330`).

### Turn and tool presentation

`buildPresentation` hides system/meta, tool-result and thinking noise, keeps
human/agent/error/task-notification rows, groups adjacent tool calls into a
`tool-group`, and preserves all events in that group for the drawer
(`presentation.ts:291-353`). Agent rows retain every event sharing a
`messageId`, so thinking and text can be inspected together
(`presentation.ts:292-300, 443-450`).

`buildMegaRows` closes a turn at each user or interrupt row. The buffered rows
become one `TurnMegaRow` with the user anchor, duration from anchor to final
row, counts for agent messages/tools/errors, first and conclusion previews,
tool-name counts and deduped per-turn usage (`presentation.ts:88-107,
114-232`). The conclusion walker deliberately skips an agent message immediately
following a task notification, then falls back to the last agent message
(`presentation.ts:158-177`).

The transcript builds presentation rows once, derives mega rows for Turns mode,
and maps every row back to its containing turn so a mini-map click can expand
and scroll to the correct place (`apps/web/app/sessions/[id]/session-view.tsx:558-602`).
Collapsed turns show a first message, a Ghostty-style activity line, middle
steps, a heuristic conclusion and an explicit “Show all” control; a token chip
and offset sit at the right (`session-view.tsx:3201-3425`). The activity line
categorizes Edit/Write/Read/Bash/Grep/Glob/Agent and includes duration and the
last file path (`session-view.tsx:3562-3794`).

Tool groups are compact one-line labels in the list (unique names with counts),
while the detail view expands each call into a real `ToolUseCard` with its name
and input (`session-view.tsx:3918-4048`; `team-tab/turn-drawer.tsx:631-710`).
The team drawer uses the same turn structure as a vertical card: human prompt,
first agent message, stats, middle steps and conclusion
(`team-tab/turn-drawer.tsx:191-267`). It limits the inline step list and offers
“Show all” before the caller opens an individual step (`turn-drawer.tsx:345-393`).

### Mini-map and parallel work

The mini-map consumes the same display-row stream as the transcript. A collapsed
turn is one segment spanning its duration; expanded child rows are atomic
segments; idle bands are inserted and everything is sorted by start offset
(`session-view.tsx:1706-1806`). Tiny segments receive a minimum visible width,
the whole strip is scaled to fit, and a playhead interpolates through the
segments (`session-view.tsx:1854-1897`).

Subagents become separate lanes. A greedy sweep assigns overlapping runs to
different lanes (`session-view.tsx:1899-1931`). Each lane bar uses the same
time-to-x mapping as the parent, with a brighter/dashed treatment for a
background run and a click target for its drawer (`session-view.tsx:2065-2127`).
Hovering a lane shows description, start/end offsets, duration, event count,
input/output tokens and final preview (`session-view.tsx:2313-2442`). Idle-band
calculation also removes delegated spans so a parent waiting for a subagent is
not mislabelled as user idle (`session-view.tsx:400-541`).

The README summarizes the same contract: adaptive selectable mini-map, turn
cards with first/middle/conclusion, pretty tool cards and token chips
(`project-n/README.md:119-127`), with structured events carrying roles,
timestamps, offsets and usage, presentation rows, and mega rows
(`README.md:156-163`).

## What bullswarm currently has

### Decoder and persisted stream

The provider-neutral decoder is declarative. It reads connector paths, emits
`id`, capture time, source, provider type, mapped kind, status, compact summary
and summary mode, and separately reports provider type/model through
`onProgress` (`bullswarm-0.33.1/src/lib/agent-events.js:59-147`). Consecutive
rules can be aggregated and are finalized with a completed event
(`agent-events.js:68-84, 137-145`). Summary compaction intentionally rejects
arbitrary objects, so a tool input/result object is not retained by this layer
(`agent-events.js:30-43`).

The attempt sink does not persist that full normalized object. Its durable JSONL
record is only:

```json
{
  "seq": "...",
  "at": "...",
  "source": "...",
  "providerType": "...",
  "kind": "...",
  "status": "...",
  "summary": "..."
}
```

That field selection is literal in `persistRecord` (`attempt-stream.js:100-116`).
The sink appends under a bounded head, keeps a bounded tail, emits a truncation
marker when needed, and folds the tail into the final file on close
(`attempt-stream.js:44-85, 126-179, 204-224`). A connector may override the
response/file byte budgets, otherwise the source defines `64000` response bytes
and `1048576` file bytes (`attempt-stream.js:9-25`). If no JSONL event stream is
configured, only bounded plain stdout is available (`attempt-stream.js:192-203`).

### Current Step page

The current TUI Step page is a label/value table for status, pool/attempt,
purpose, route and elapsed time, followed by a budget line, task-file preview,
output preview and artifact paths (`src/workflow/dashboard.js:3315-3425`). The
selected-agent detail can show only the last semantic `lastActions`, each with
kind/status/summary; if none exist it says it is waiting for semantic action
events (`dashboard.js:1525-1548`). It can show attempt usage, but the compact
preview explicitly treats running-attempt tokens as pending
(`dashboard.js:1560-1578`). Output is read from the artifact or durable output
text, capped for the TUI, and the Step page displays only a viewport-sized
prefix (`dashboard.js:1595-1605, 3409-3418`). There is no persisted event
timeline, turn id, tool-argument card, tool-result size, sidechain relation or
per-turn token bucket.

## Gap table

| project-n presents | Bullswarm stream presently carries | Missing or lossy contract | Step-page consequence |
|---|---|---|---|
| Stable event role, original timestamp, offset/gap, message/request ids, model, full blocks and usage | `seq`, sink `at`, `source`, `providerType`, overloaded `kind`, `status`, compact `summary` | No canonical event id is persisted; no raw/provider timestamp, offset/gap, model, message id or usage object | A reader cannot place events in a provider-accurate timeline or explain token spend per turn. |
| A named tool call with call id, arguments and its result/error | A connector may map a name into `kind`; a scalar summary may describe it | No `tool.name`/call id/arguments; no result payload, byte count, truncation flag or structured error | A tool row is a label, not an inspectable card; large results look identical to empty results. |
| User/interrupt anchors and explicit turn boundaries; turn summary counts | No turn marker or parent/child event relation | No `turnId`, boundary reason or stable parent event | Turns cannot be collapsed or expanded without guessing from time/order. |
| Sidechain id, parent Agent call, prompt, background flag, interval and tokens | Nothing sidechain-specific survives the sink; a provider's `Agent` name is at most a `kind` | No subagent id, parent link, interval, parallel flag or usage | Parallel work cannot be indented, lane-aligned or removed from idle time. |
| Per-turn input/output/cache tokens, deduped by message id | Attempt-level usage may be in `attempt.usage`, but not on stream records | No event usage and no turn aggregation key | The Step page can say “pending” or show a total, not “this turn used …”. |
| Original event timestamps plus start/end/duration and active/idle spans | `at` is the sink's capture stamp | No provider timestamp, monotonic offset, start/end marker or duration; capture time can be missing for a replayed artifact | Mini-map widths and elapsed seconds are not trustworthy; latency and idle cannot be separated. |

## Proposed normalized event extension

Keep the existing bounded JSONL mechanics and extend each persisted record with
fields that are scalar, redacted and independently optional. The proposed shape
is deliberately additive; old readers can continue to use `kind`, `status` and
`summary`.

```json
{
  "seq": "existing monotonically increasing sequence",
  "at": "capture timestamp",
  "eventId": "decoder id, retained instead of discarded",
  "source": "stdout or stderr",
  "providerType": "provider event type",
  "model": "provider model when known",
  "kind": "response, tool, thinking, result, ...",
  "status": "running, completed, failed, observed, ...",
  "summary": "compact one-line preview",
  "eventAt": "provider event timestamp when supplied",
  "turnId": "stable attempt-local turn id",
  "turnPhase": "start, continue or end when explicit",
  "parentEventId": "causal parent, if supplied",
  "subagentId": "sidechain/worker id, if supplied",
  "parallel": "true only for a concurrently running child",
  "tool": {
    "name": "canonical tool name",
    "callId": "provider call id",
    "arguments": "bounded redacted scalar/object snapshot",
    "resultPreview": "bounded result text",
    "resultBytes": "observed result byte count",
    "resultTruncated": "true when the result was clipped",
    "isError": "provider error bit when known"
  },
  "usage": {
    "input": "fresh input tokens",
    "output": "output tokens",
    "cacheRead": "cache-read tokens",
    "cacheWrite": "cache-write tokens",
    "cumulative": "true when values are cumulative"
  },
  "elapsedMs": "event/turn elapsed when a matching end is known"
}
```

Capture rules should populate `tool` from connector-declared paths, retain the
decoder's `id`, carry `model` from the existing progress callback, and preserve
provider timestamps when present. A provider that cannot supply a field leaves
it absent; it must not invent a timestamp, token count or parent link. Keep the
current bounded response/file caps and truncation marker, but record the result
byte count before clipping so the UI can distinguish “empty” from “clipped”.
Arguments and results must pass the same scalar/redaction policy as summaries;
never serialize arbitrary credential-bearing objects.

The capture layer should also accept optional lifecycle markers (`turnPhase`),
or derive a conservative boundary only from explicit connector events. Do not
infer a turn from a long time gap: a long Bash/tool call is active work, and an
unobserved user pause is not a completed turn. For a sidechain, persist the
child id, parent event id, `parallel` flag, start/end event times and usage so a
reader can reconstruct the same lane model as project-n.

## Step page design

The Step page remains an attempt detail page, but its main body becomes a
timeline backed by the persisted records.

* Header: status, pool/model/attempt, purpose, route, elapsed time and the
  attempt-level budget stay in the existing header. Add a compact count of
  observed events, turns, tool calls and child runs only when those counts are
  actually present.
* Mini-map: render a selectable strip immediately under the header. A turn is a
  wide block from its first to last event; a tool call is a smaller block; an
  idle/unknown interval is hatched. Clicking a block selects the corresponding
  turn/event. The strip is a time-order guide, not a promise of proportional
  pixels when timestamps are incomplete.
* Turn rows: each turn has a boundary label, first agent/user preview, a compact
  stats line (`input/output/cache` tokens and elapsed seconds when known), its
  one-line tool cards, and a conclusion/output preview. The existing “show all”
  behavior is appropriate: keep the overview short, then expand to every event.
* Tool cards: show status, canonical tool name, a compact arguments preview,
  result preview/byte count and an error marker. Selecting a card opens the full
  bounded argument/result payload and the artifact link. A response card uses
  the persisted full response cap; it does not claim that the cap is the
  provider's complete output.
* Subagent groups: an Agent dispatch starts an indented child group under its
  parent turn. The group header shows child id/type, parent relation and
  background/parallel state; its rows use the same tool-card treatment. If the
  child has start/end offsets, draw a parallel lane in the mini-map and remove
  that span from the parent's idle calculation.
* Wide terminal (`120×40`): keep a left turn/mini-map rail and a right detail
  pane, so selecting a turn leaves its context visible while cards scroll. Keep
  arguments/results on one visual line in the rail and allow detail expansion
  in the pane.
* Narrow terminal (`55×26`): use one full-width column. Keep the header,
  mini-map and selected turn visible; collapse arguments/results to one-line
  ellipsized cards and use explicit “open detail/back” navigation. Do not draw
  an empty budget bar or a fake zero-token chip.

### Degradation rules

The renderer must state what is unknown rather than manufacture precision.

* Missing `eventAt`: order by `at`, label the mini-map “capture order” and use
  equal/minimum visual blocks; do not compute seconds from sequence numbers.
* Missing `turnId`/`turnPhase`: show a flat attempt timeline with a “turns not
  captured” note. Never split on an arbitrary gap.
* Missing tool name/arguments: use `kind`/`summary` as a plain activity row and
  label the card “tool details unavailable”.
* Missing result size/result: show status only and “result not captured”; keep
  the output artifact link if one exists.
* Missing subagent id/parent: keep the event in the parent stream; do not
  fabricate an indented group or parallel lane.
* Missing usage: show `tokens —` at the turn and event, while retaining any
  attempt-level total elsewhere.
* Missing start/end: show elapsed as `—`, use event offsets that are known, and
  keep the mini-map selectable without implying a duration.
* Truncated stream: surface the existing truncation marker and a “head + tail”
  notice; never imply that the omitted middle was idle or absent.

These fallbacks preserve the current evidence-gated posture: a Step page can be
useful with partial capture, but it must distinguish observed fields from
derived or unavailable ones.

## Source-backed terminal frames

`step-timeline-55.txt` and `step-timeline-120.txt` use the Claude transcript
identified above. The visible rows are the real greeting, `/statusline` request,
`Agent` dispatch, parent background state, and completion notification. The
`+48.5s`, `+50.9s`, `+52.2s`, `+54.2s`, `+56.0s` and `+81.2s` offsets are from a
focused timestamp extraction over that JSONL. The `2 → 219` token chip is the
assistant usage on transcript line 18; `23,676 tok · 2 tools · 25.495s` is the
subagent completion usage nested in line 27. The frame source intentionally
shows the available Agent group but does not print the internal agent id from
the transcript's tool result.

