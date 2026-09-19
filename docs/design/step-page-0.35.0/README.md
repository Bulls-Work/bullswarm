# Step page study and implementation contract

This record captures the read-only study dependency for the 0.35.0 Step page. It records the real project-n source, the real Bullswarm renderer, the copied-home records used for the designs, the gap list, the proposed information architecture, the extraction plan, and the caller-authored implementation program. The nine plain-text frame files alongside this README are the proposed frames exactly as drawn by the study.

## 1. Evidence boundary

The copied home contains 316 workflows. The ordinary live-only listing returned zero because the copied kernel PIDs are no longer alive; `workflow runs --all --json` still exposed all 316 durable records.

The selected action is genuinely live in the snapshot:

- `study`, attempt 1, `running`
- pool `codex`, model `gpt-5.6-sol`
- lane `analyze`, effort `high`, reasoning `medium`
- task and output paths recorded
- no finished timestamp, failure, usage, or result envelope yet
- output activity recorded, but `state.json` does not directly point to the stream file

Evidence: `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/state.json:177-400`, `:414-417`.

The stream was discovered by naming convention at `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/stream-study-attempt-1.jsonl`. It contained seven events at snapshot time:

- Lines 1–5: response; command start; command completion; response; second command start.
- Lines 3–7: first command completion; response; second command start/completion; copy command start.

The current action has no result envelope yet: `workflow runs result qvh8e2` correctly reported that the V2 result is unavailable. Any finished-state examples below therefore use separate, completed real workflows.

## 2. project-n study

project-n separates parsing, persistence, and presentation: provider parsers normalize sessions into shared event, usage, session, and subagent records, while the web app renders those records. `/home/dev/project-n/CLAUDE.md:9-34`, `/home/dev/project-n/packages/parser/src/types.ts:9-67`, `:117-248`.

Its session route loads the session and entries, optionally loads team information for a lead session, strips raw storage fields, and passes the normalized data to `SessionView`. `/home/dev/project-n/apps/web/app/sessions/[id]/page.tsx:13-64`.

The session page contains:

- Transcript, Team, and Debug tabs. `/home/dev/project-n/apps/web/components/session-view.tsx:97-109`, `:705-725`.
- A sticky identity header with session ID, live/running state, model, entrypoint, project, agent time, token summary, event count, pull request, and relative start. `/home/dev/project-n/apps/web/components/session-view.tsx:764-864`.
- Live detection based on the latest event being less than 45 seconds old. `/home/dev/project-n/apps/web/components/session-view.tsx:390-395`.
- Filters for turns, actions, all events, user, agent, tools, and errors, plus counts and copying/Ask actions. `/home/dev/project-n/apps/web/components/session-view.tsx:78-88`, `:866-928`.
- Turn grouping with messages, tool calls, errors, tokens, and duration. `/home/dev/project-n/apps/web/lib/presentation.ts:114-233`, `:291-454`.
- A timeline minimap and hover inspection. `/home/dev/project-n/apps/web/components/session-view.tsx:931-976`, `:2065-2444`.
- Collapsed turns showing the initiating message, intermediate work, outcome or in-progress state, token chip, and offset. `/home/dev/project-n/apps/web/components/session-view.tsx:3201-3425`.
- Specialized cards for Write, Edit, Read, Bash, Grep, Glob, Skill, ToolSearch, Todo, MCP, and generic tools. `/home/dev/project-n/apps/web/components/tool-cards.tsx:150-460`.
- An error filter and rate-limit/error grouping. `/home/dev/project-n/apps/web/lib/presentation.ts:97-106`, `:126-155`, `:235-239`, `:413-440`.
- A subagent drawer with metadata, prompt, duration, token/tool summaries, and final output. `/home/dev/project-n/apps/web/components/session-view.tsx:4244-4565`.
- Structured Debug output, an Ask drawer, and tail-mode controls. `/home/dev/project-n/apps/web/components/session-view.tsx:4173-4241`; `/home/dev/project-n/apps/web/components/ask.tsx:3-60`, `:96-212`; `/home/dev/project-n/apps/web/components/tail-mode.tsx:3-12`, `:17-180`.

One important correction to the earlier design precedent: project-n shows ordinary per-turn token counts, but not ordinary per-turn dollar cost. Dollar figures appear around compaction/cache-rebuild markers, not as a general turn-cost column. `/home/dev/project-n/apps/web/components/session-view.tsx:3020-3155`, `:4115-4171`.

### What Bullswarm should borrow

Borrow:

- Sticky identity and status.
- A compact chronological feed with selection.
- Turn/tool/error grouping when the event schema supports it.
- Follow-tail behavior.
- Progressive detail: concise list first, selected event/tool detail second.
- Honest “not captured” states.

Do not lose Bullswarm-specific strengths:

- Attempt history and retries.
- Routing decision and candidate context.
- Workflow success versus independent `verified`.
- API-rate and subscription-cost bases.
- Requirement evidence and durable result envelopes.

The current Bullswarm stream only proves capture sequence, time, source/provider type, kind, status, and summary. It does not yet provide stable turn IDs, tool-call IDs, tool arguments/results, event-level usage, parent/subagent relationships, or provider-origin timestamps. The new page must not infer those fields from prose.

## 3. Current Bullswarm Step page

`stepPage` currently renders:

- Header, status, pool/model/reasoning, purpose, route, and time.
- Failure or stall information.
- One budget line.
- Task preview.
- Output preview.
- Artifact paths.
- A header-level output sparkline.

Source: `src/workflow/dashboard.js:3934-4049`. Its documentation describes Step as answering “What is this action doing?” and defines responsive layout and keyboard behavior. `docs/guide/observing.md:30-90`, `:147-163`.

The current page does **not** read or render the attempt stream. It shows the output file, which is a different artifact.

### Current rendered frame: 55 columns

```text
 Home  Runs  Budget  Stats  Fleet
 ⠋ study · run qvh8e2 · running · output ▁▆██ 12 KB
 Status    running · gpt-5.6-sol · medium
 Pool      codex · attempt 1 · effort high · reasoning…
 Purpose   Study project-n and the current Step page, …
 Route     analyze lane → codex: expiring soon: codex
           resets in 10h54m, surplus 21.4 over 6.5% of
 Time      started 23:24 · elapsed 4m40s · no expected…

── budget ─────────────────────────────────────────────
 codex   free model · no licence meter · cost unknown

── task · first lines ─────────────────────────────────
   Bullswarm program action: study
   Purpose: Study project-n and the current Step page,
   design the new page, and plan the extraction
   refactor
   … 138 more lines

── output ─────────────────────────────── live · 12 KB ──
   nothing has been written to the output file yet

── artifacts ──────────────────────────────────────────
   task:   /home/dev/.bullswarm/workflows/wf-mu8…
   output: /home/dev/.bullswarm/workflows/wf-mu8…









 [ back ] [Top] [End] [?.Help]
```

### Current rendered frame: 120 columns

```text
 Home  Runs  Budget  Stats  Fleet
 ⠋ study · run qvh8e2 · running · output ▁▆██ 12 KB
 Status    running · gpt-5.6-sol · medium
 Pool      codex · attempt 1 · effort high · reasoning medium
 Purpose   Study project-n and the current Step page, design the new page, and plan the extraction refactor
 Route     analyze lane → codex: expiring soon: codex resets in 10h54m, surplus 21.4 over 6.5% of the week left →
           urgency 329, forecast 72.1% (1 in flight)
 Time      started 23:24 · elapsed 4m40s · no expected duration recorded

── budget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 codex   free model · no licence meter · cost unknown

── task · first lines ──────────────────────────────────────────────────────────────────────────────────────────────────
   Bullswarm program action: study
   Purpose: Study project-n and the current Step page, design the new page, and plan the extraction refactor
   … 63 more lines

── output ────────────────────────────────────────────────────────────────────────────── live · 12 KB ──
   nothing has been written to the output file yet

── artifacts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
   task:   /home/dev/.bullswarm/workflows/wf-mu8jg6cd-9d7b33/task-study-attempt-1.md
   output: /home/dev/.bullswarm/workflows/wf-mu8jg6cd-9d7b33/out-study-attempt-1.md









 [ back ] [ ?.help ] [ quit ]
```

### Current rendered frame: 200 columns

```text
 Home  Runs  Budget  Stats  Fleet
 ⠋ study · run qvh8e2 · running · output ▁▆██ 12 KB
 Status    running · gpt-5.6-sol · medium
 Pool      codex · attempt 1 · effort high · reasoning medium
 Purpose   Study project-n and the current Step page, design the new page, and plan the extraction refactor
 Route     analyze lane → codex: expiring soon: codex resets in 10h54m, surplus 21.4 over 6.5% of the week left → urgency 329, forecast 72.1% (1 in flight)
 Time      started 23:24 · elapsed 4m40s · no expected duration recorded

── budget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 codex   free model · no licence meter · cost unknown

── task · first lines ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Bullswarm program action: study
   Purpose: Study project-n and the current Step page, design the new page, and plan the extraction refactor
   … 40 more lines

── output ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   nothing has been written to the output file yet

── artifacts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   task:   /home/dev/.bullswarm/workflows/wf-mu8jg6cd-9d7b33/task-study-attempt-1.md
   output: /home/dev/.bullswarm/workflows/wf-mu8jg6cd-9d7b33/out-study-attempt-1.md









 [ back ] [ ?.help ] [ quit ]
```

The new proposed frames are in `frames/running-55.txt`, `frames/running-120.txt`, `frames/running-200.txt`, `frames/finished-55.txt`, `frames/finished-120.txt`, `frames/finished-200.txt`, `frames/failed-55.txt`, `frames/failed-120.txt`, and `frames/failed-200.txt`.

## 4. Gap list

The study establishes these gaps and evidence limits:

1. The current Step page shows the output file rather than the attempt stream, so it has no captured activity feed. `src/workflow/dashboard.js:3934-4049`.
2. The current stream proves capture sequence, time, source/provider type, kind, status, and summary only; stable turn IDs, tool-call IDs, arguments/results, event-level usage, parent/subagent relationships, and provider-origin timestamps are not available. The new page must not infer them from prose.
3. The selected running action has no finished timestamp, failure, usage, or result envelope yet, and `state.json` does not directly point to its stream file; the stream was found by naming convention. `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/state.json:177-400`, `:414-417`; `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/stream-study-attempt-1.jsonl:1-7`.
4. The finished historical attempt has no retained stream, so turns, tools, and event timing cannot be reconstructed; the failed historical attempts likewise have no retained event streams. `/tmp/bsw-study35/workflows/wf-mu7873tx-3b973b/result.json:1-38`, `:185-227`; `/tmp/bsw-study35/workflows/wf-mtwyg33h-a19ccd/result.json:1-9`, `:74`, `:143-310`; `/tmp/bsw-study35/workflows/wf-mtwyg33h-a19ccd/state.json:254-470`.
5. The completed 0.34 usage/cost record is not landed in this worktree; the design can consume the sibling worktree's program contract, but implementation still needs to prove the fields. `/home/dev/Repo/bullswork/bullswarm-0.34.0/docs/plans/cost-0.34.0.goal.txt:1-8`, `/home/dev/Repo/bullswork/bullswarm-0.34.0/docs/plans/cost-0.34.0.program.json:20`.
6. Final keyboard behavior, automated line-width assertions for the nine frames, and full-suite verification remain implementation-time proof obligations.

## 5. Real records used by the new design

### Running

The `study` record supplies identity, attempt, route, candidate, forecast, reasoning, timestamps, byte-count, and last-activity fields. `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/state.json:177-400`.

Its stream has seven real captured events. `/tmp/bsw-study35/workflows/wf-mu8jg6cd-9d7b33/stream-study-attempt-1.jsonl:1-7`.

### Finished and verified

Workflow `wf-mu7873tx-3b973b` is finished and `verified: true`. Its `stats-design` action succeeded and has durable result metadata. `/tmp/bsw-study35/workflows/wf-mu7873tx-3b973b/result.json:1-38`, `:185-227`.

Its attempt used `codex/gpt-5.6-luna`, lasted 2,361 seconds, recorded an estimated 1,832 tokens, and has an estimated API-equivalent cost of `$0.0005564`. Its historical stream was not retained, so the page must say that rather than manufacture a timeline.

### Failed after two attempts

Workflow `wf-mtwyg33h-a19ccd` finished `partial` and unverified. Its `cli` action failed after two interrupted provider-stream attempts. `/tmp/bsw-study35/workflows/wf-mtwyg33h-a19ccd/result.json:1-9`, `:74`, `:143-310`; corresponding attempts are in `/tmp/bsw-study35/workflows/wf-mtwyg33h-a19ccd/state.json:254-470`.

The attempts recorded 2,766 and 2,765 estimated tokens, totaling 5,531. Both costs are unknown. Its event streams were not retained.

## 6. Proposed Step information architecture

Priority order:

1. **Identity and verdict** — action, run, status, purpose, workflow outcome, and independent verification.
2. **Selected attempt** — ordinal, pool, model, reasoning, timestamps, duration, failure, and output.
3. **Attempt history** — retries and interruption/failure transitions.
4. **Route** — lane, effort, reason, candidates, urgency, and forecast.
5. **Money pair and tokens** — API-rate and subscription figures with bases; unknown is `—`, never zero.
6. **Activity** — captured event feed, minimap, follow state, and capture-order warning.
7. **Selected activity detail** — tool, arguments, result, usage, or plain summary when captured.
8. **Outcome and verification** — durable output, requirement evidence, and result-envelope verdict.
9. **Prompt and artifacts** — task preview and file paths.

The cost presentation should consume the 0.34 contract:

- Token classes and `tokenSource`.
- `api.usd`, breakdown, rate card, and basis.
- `subscription.usd`, window/delta, and basis.
- Start/end meter snapshots.
- Compatibility fallbacks for `cost.estimatedUsd`, `tokens.totalKnown`, and `normalizedQuota`.

That contract is defined by `/home/dev/Repo/bullswork/bullswarm-0.34.0/docs/plans/cost-0.34.0.goal.txt:1-8` and `/home/dev/Repo/bullswork/bullswarm-0.34.0/docs/plans/cost-0.34.0.program.json:20`. The proposed design directory was still absent in that worktree, so the program is the current contract, not a completed implementation.

### Interaction

- `↑/↓`: select activity or attempt.
- `Enter`: open/close selected-event detail.
- `Tab` / `Shift-Tab`: cycle Activity, Attempts, Outcome, Prompt.
- `Space`: toggle follow-tail.
- `a`: jump to attempts.
- `o`: jump to outcome.
- `p`: show prompt.
- `e`: errors-only activity filter.
- `t`: tools-only activity filter.
- `Esc`/`Backspace`: close detail or return.
- Existing `?`, `q`, `Home`, and `End` semantics remain.

At 55 columns, the page is one column and selected detail replaces the feed. At 120 columns, summary and activity stay full-width with compact detail. At 200 columns, activity and selected detail can share the middle row. Missing structure must degrade explicitly: “turns not captured,” “tool arguments unavailable,” or “event stream unavailable.”

## 7. Proposed frames

The study drew nine content frames from real running, finished-verified, and failed-two-attempt records. Every line fits its stated width; unused terminal rows are omitted. The exact frame text is stored one frame per file under `frames/`:

- `running-55.txt`, `running-120.txt`, `running-200.txt`
- `finished-55.txt`, `finished-120.txt`, `finished-200.txt`
- `failed-55.txt`, `failed-120.txt`, `failed-200.txt`

## 8. Extraction and implementation plan

Create two modules:

### `src/workflow/step-model.js`

Own all pure data work:

- Select the action and its attempts.
- Select an attempt by ordinal.
- Resolve the convention-based stream file.
- Parse JSONL defensively.
- Pair start/completion events only when identifiers make that safe.
- Aggregate attempts, tokens, and the 0.34 money-pair fields.
- Read legacy cost aliases.
- Resolve durable outcome and verification independently.
- Produce explicit availability flags such as `streamAvailable`, `turnsCaptured`, `toolDetailsCaptured`, and `usagePending`.
- Return one width-independent model suitable for snapshot testing.

This separate model is warranted because the page combines at least four durable sources: state/action/attempt data, stream JSONL, output files/state outputs, and the result envelope.

### `src/workflow/step-view.js`

Own only rendering and hit regions:

- Responsive 55/120/200 layouts.
- Summary, activity, attempts, outcome, prompt, and detail sections.
- Truncation and wrapping.
- Follow/selection/filter labels.
- Keyboard hints.
- No file I/O and no record-shape inference.

### Helpers that should stay shared

Despite their names, these are not Step-only helpers:

- `workflowPanelModel`: `src/workflow/dashboard.js:656`.
- `reasoningText`: `:300-303`.
- `clockText`: `:1325-1329`.
- `formatBytes`: `:1338-1343`.
- `outputSparkline`: `:1346-1355`.
- `taskPreview` and `outcomePreview`: `:1947-1971`.
- `wrapLines`, `statusIcon`, `durationText`, `truncate`: `:1973-2022`.
- `visibleLength`, `meterAnsi`, `blank`, `about`, `moneyText`: `:2126-2193`.
- `runEconomics`: `:2570-2612`.

`stepBarText` and `stepPool` belong to the Home active-step rendering, not the Step page. `src/workflow/dashboard.js:2752-2789`, `:3079-3080`.

`stepTally` serves the Run page. `src/workflow/dashboard.js:3667-3679`, `:3750`, `:3835`.

`stepProgressText` currently has no caller and should be removed separately if confirmed dead, rather than moved into the new module. `src/workflow/dashboard.js:2616-2625`.

### Callers and tests

`renderDashboardPage` should import and call the extracted Step model/view at its existing Step dispatch point. `src/workflow/dashboard.js:4404-4491`.

Preserve and extend the existing public-render tests:

- Page contract and navigation: `tests/workflow-dashboard.test.js:1105-1191`.
- Unmetered Step: `:2948-2971`.
- Current Step layout: `:3371-3408`.
- Sparkline: `:3750-3775`.

Add focused tests:

- `tests/workflow-step-model.test.js`
  - running stream
  - finished result
  - two failed attempts
  - malformed/missing stream
  - new and legacy cost records
  - success versus verification
- `tests/workflow-step-view.test.js`
  - 55/120/200 frames
  - no line exceeds width
  - unavailable-field wording
  - selection/follow/filter states
  - bare `$` prohibited for estimated cost

A broader dashboard split should wait. `dashboard.js` is 5,899 lines, but Home, Runs, Run, shared navigation, and layout helpers are tightly coupled to the current renderer tests. Step is a bounded seam; splitting every page simultaneously would unnecessarily mix structural risk with the new observability feature.

## 9. Caller-authored implementation program

The complete valid JSON draft is saved at `docs/plans/step-page-0.35.0.program.json`. It follows the existing `bullswarm.workflow.program.v2` structure and the non-overlapping territory pattern used by `/home/dev/Repo/bullswork/bullswarm-0.34.0/docs/plans/cost-0.34.0.program.json:1-190`.

For the prescribed validator invocation, the JSON shape was normalized after validation: the adversarial `verify` action has empty `affects` and `ownedFiles`, and requirement references were limited to the two requirement IDs supplied by its placeholder goal. The action prompts and territories remain the study's draft content.

The draft has one bounded Step extraction/feature action, one additive provider-neutral stream-contract action, a documentation action depending on both, an integration action depending on all three, and an adversarial acceptance action depending on integration. The Step action keeps extraction and feature work together with an explicit internal checkpoint because they share files; making them separate parallel actions would create overlapping territories.

The Step action owns `src/workflow/step-model.js`, `src/workflow/step-view.js`, `src/workflow/dashboard.js`, `tests/workflow-step-model.test.js`, `tests/workflow-step-view.test.js`, and `tests/workflow-dashboard.test.js`. Its prompt requires mechanical extraction first, the existing dashboard test checkpoint, then the evidence-honest design.

The stream-contract action owns `src/lib/agent-events.js`, `src/lib/attempt-stream.js`, the provider schemas/connectors, and their focused tests. Its prompt permits optional normalized fields only where real provider output proves them and preserves old streams.

The docs action owns `docs/guide/observing.md`, `docs/reference/providers.md`, and `CHANGELOG.md`, and depends on the two implementation actions. The integration action has no owned files and runs focused tests plus `npm test`, real copied-home renders, width checks, and cost-display assertions. The verify action edits no files and challenges the evidence claims independently.

## 10. Verification and unfinished items

Confirmed by the study:

- Live Bullswarm state was copied before inspection.
- No live workflow state was modified.
- The repository remained clean.
- `node --test tests/workflow-dashboard.test.js`: 89 passed, 0 failed.
- Current and proposed designs use real running, finished-verified, and failed-two-attempt records.
- Unknown fields are presented as unknown or unavailable.

Still requiring implementation-time proof:

- Whether each provider can supply stable turn/tool/subagent fields.
- The completed 0.34 usage/cost record, which is currently a worktree program contract rather than landed code.
- Final keyboard behavior in the interactive shell.
- Automated line-width assertions for the nine proposed frames.
- Full-suite verification after extraction and implementation.
