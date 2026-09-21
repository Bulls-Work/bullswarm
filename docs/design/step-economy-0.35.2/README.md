# Step economy (0.35.2): the soft time box and the repair loop

The contract the `time-box` and `repair-loop` steps implement and the `docs` step teaches. Words
used below: a **box** is the soft time limit written into a task; a **round** is one pass of
verification; a **repair** is the step the kernel adds between two rounds; a requirement
**carries forward** when a later round does not judge it again.

## 1. Soft time box

### 1.1 Which box

Order: the action's `timeBox`, else `program.defaults.timeBox`, else history, else 20 minutes.

- `validateActionProgram` (`action-validator.js`) accepts `timeBox` in `ACTION_FIELDS` and
  `PROGRAM_DEFAULT_FIELDS`: whole minutes 0–240, 0 meaning no paragraph, used as given. It folds
  the default onto each action at acceptance, as it does for effort, so `plan export` shows it.
  Messages: `actions[2].timeBox must be a whole number of minutes from 0 to 240`;
  `program.defaults.x is not allowed; only effort, reasoning, timeBox and verifyRounds`.
- History, in the new `src/workflow/time-box.js`:
  `timeBoxHistory(bullswarmDir) → { pairs: Map<"pool|kind", minutes[]>, kinds: Map<kind, minutes[]> }` and
  `resolveTimeBox({ action, pool, history }) → { minutes, wrapUpMinutes, source, n, medianMinutes } | null`.
  - Records: `attempts[]` with `status: "succeeded"` in every `<home>/workflows/*/state.json`.
    The kind is that of the program action `attempt.actionId`; no kind → skipped (single tasks
    under `runs/` have none and are not read). Minutes = `wallSec / 60`, else
    `finishedAt − startedAt`. A pool whose name starts with `opencode` never counts
    (`opencode`, `opencode:*`, the older `opencode2*`).
  - Formula: the (pool, kind) pair with at least 5 attempts, else the kind with at least 5
    (D1), else 20. Box = 1.5 × median (mean of the two middles for an even count), then
    `Math.round(x / 5) * 5`, kept within 10–60. `source`: `pair`, `kind`, `fallback`, `program`.
  - Cache: an in-process memo per `bullswarmDir`, kept 10 minutes; no file. A script reading
    all 60 runs of the 0.35.2 home snapshot took 0.16 s end to end.
- The box is resolved per attempt, because a retry can land on another pool. Today's values:

| Home | (pool, kind) | n | median min | box |
| --- | --- | --- | --- | --- |
| `tests/fixtures/home-351` | codex, implement | 80 | 18.86 | 30 |
| `tests/fixtures/home-351` | grok, implement (pair has 2 → kind implement) | 82 | 18.26 | 25 |
| `tests/fixtures/home-351` | grok, check (kind check has 2) | – | – | 20 |
| 0.35.2 snapshot | codex, implement | 130 | 20.02 | 30 |
| 0.35.2 snapshot | command-code, implement | 70 | 13.37 | 20 |
| 0.35.2 snapshot | codex, digest | 10 | 4.95 | 10 |

The first row is the test pair for requirement 7: 1.5 × 18.86 = 28.29 → 30.

### 1.2 The paragraph

The pool and the start clock exist only once `dispatchV2Action` (`v2-dispatch.js`) picks the
attempt, so the paragraph is composed there. `runAction` passes a new option
`timeBox: ({ pool, startedAt, evidence }) => ({ text, record }) | null` built on
`timeBoxParagraph({ minutes, startedAt, evidence })`. The text goes at the very end of that
attempt's task (after any handoff or correction block) and not into the base text, so a retry
gets its own clock. The attempt records `timeBox: { minutes, wrapUpMinutes, source, n,
medianMinutes, startClock }`. `W = Math.round(0.7 × B)`; `START` is the local start as
`date +%T` prints it; `WRAP` = START + W and `END` = START + B, as `HH:MM`; the clock is
injectable so tests do not depend on the timezone.

Work tasks (started from the experiment's wording):

> Time box: B minutes, starting at START. It is a guide, not a hard stop. Run `date +%T` every
> few turns to keep track. Work through the items in order and finish each before starting the
> next. At about W minutes (WRAP), stop starting new work and wrap up: make what you have
> consistent and its tests passing. At B minutes (END), stop and write the report with three
> sections: `## Done`, `## Not done` (one line per unfinished item, or `- none`), and
> `## Suggested next step`. An honest partial report, with unfinished items listed under
> `## Not done`, is better than running long, and much better than calling unfinished work done.

Evidence tasks:

> Time box: B minutes, starting at START. It is a guide, not a hard stop. Run `date +%T` every
> few turns to keep track. Judge the requirements one at a time and settle each before starting
> the next. At about W minutes (WRAP), stop opening new lines of inspection and settle what you
> have. At B minutes (END), finish the evidence preflight with what you have: a requirement you
> could not finish inspecting is `blocked`, with what is missing as its evidence. Then end with
> the preflight's confirmation and three sections: `## Done`, `## Not done` and
> `## Suggested next step`. An honest `blocked` is better than running long, and much better
> than a guess.

No paragraph for `timeBox: 0`, planner turns or the scout. Digests carry it like every other dispatched step (D2). Timeouts, stall
detection, cancellation, routing and retries are unchanged; nothing stops at the box.

## 2. Honest early return

`parseNotDone(text) → { count, items }` in `time-box.js`:

- The section: the **last** heading (1–6 `#`) reading `Not done` (any case, optional colon), up
  to the next heading of any level or the end.
- Items: top-level list lines (`-`, `*`, `+`, `1.`, `1)`, indent ≤ 1 space), text after the
  marker, trimmed; nested and continuation lines ignored. `none`, `nothing`, `n/a`, `-`, `—`
  (any case, optional period) and empty text are not items. `count` counts all; `items` keeps
  the first 20, each cut to 300 characters at a word.

When `count > 0`, `runAction` sets `returnedEarly: { count, items }` on the succeeded attempt
from its durable out file (work actions only). The step still succeeds; `action.finished` gains
`returnedEarly: { count }`; `normalizeAttempt` and `ATTEMPT_FIELDS` (`v2-state.js`) carry
`timeBox` and `returnedEarly`. The items reach verify: `buildEvidenceTask` lists every step
whose `affects` meets its `evidenceFor` and whose latest succeeded attempt returned early:

> Steps that returned early (their own `## Not done`, quoted; judge each requirement as the
> workspace stands):
> - time-box · 2 not done: first item; second item

## 3. Repair loop

### 3.1 Scope and budget

Program runs only. The kernel writes `state.verifyLoop` when it accepts the first program
(`acceptCallerPlannerResponse`, the dispatched branch of `runPlanner`); a saved run without it
keeps its old behaviour. `program.defaults.verifyRounds` is 1–3, default 3, 1 = today (no
repair); `validateActionProgram` returns it beside `actions` and the runtime copies it into
`verifyLoop.max`. A run with no evidence step has no rounds.

### 3.2 The durable record

`state.verifyLoop`, checked by `v2-state.js`. No key may be `verify`, `repair`, `decision`,
`result` or `completion`: `noUnknown` rejects those legacy names at any depth.

```json
{ "max": 3, "stoppedBy": null,
  "rounds": [{ "round": 1, "verifyActionIds": ["verify"], "startedAt": "…", "closedAt": "…",
    "toJudge": ["requirement-1", "requirement-3"], "carried": [], "passed": ["requirement-1"],
    "failed": ["requirement-3"], "discovery": [], "repairActionId": "repair-1",
    "repairRequirements": ["requirement-3"], "repairOwnedFiles": ["src/a.js"],
    "repairUnrestricted": false, "repairStartedAt": "…", "repairFinishedAt": "…", "changedFiles": ["src/a.js"] }] }
```

`failed` = mandatory requirements in `toJudge` that are `failed` or `blocked` at close (D4); one
no evidence step judges goes to the caller as today. `stoppedBy`: null, then `passed`,
`rounds`, `revision` (the caller removed a kernel step) or `step-failed`.

### 3.3 State machine

The boundary is where `evaluateV2Progress` returns `ready-to-finalize` (every live step
succeeded). `runV2Kernel` now calls `nextLoopStep(state)` (new `verify-rounds.js`) there first.

| Where the loop is | Trigger | Kernel does | Event |
| --- | --- | --- | --- |
| no round yet | first evidence step starts (`runAction`) | open round 1; `toJudge` = every live evidence step's `evidenceFor` (a declared requirement none names is `not judged`, see 3.10) | verify-round started |
| round r open | boundary | close round r: `passed`, `failed`, `discovery` | verify-round finished |
| round r closed, nothing failing | same boundary | finish, `stoppedBy: passed` | – |
| round r closed, failing, r < max | same boundary | add `repair-r` | repair started |
| round r closed, failing, r = max | same boundary | finish, `stoppedBy: rounds` | – |
| repair r succeeded | boundary | record `changedFiles`; compute the re-check set (3.6); empty → finish, else add `verify-round-(r+1)` | repair finished, verify-round started |
| a step failed or blocked | `evaluateV2Progress` says `partial` | finalize as today; `stoppedBy: step-failed` once a round has closed | – |

A repair is added only when r < max and a verify round only after a repair: never a fourth round.

### 3.4 Kernel steps

`planLoopStep(state)` returns the step to add. The runtime writes the loop record first (so
validation knows the step is the kernel's), then applies the step as `applyQueuedRevision`
does: a request `{ id: "kernel-loop-<r>-repair|verify", source: "kernel", summary,
baseRevision, program: live program + the new step }` through `planV2Revision` and
`commitV2Revision`. It lands in `state.revisions` and emits `program.revised`; watch hides
kernel-source revisions because the loop events say it.

- **Repair** id `repair-<r>` (if taken, `repair-<r>-<k>`, smallest free k ≥ 2; the kernel knows
  its steps from `verifyLoop`, never from the id). Kind `implement`; effort = the highest among
  the affecting steps; normal routing, no pool pin. affects = the round's failing requirements;
  dependsOn = the round's `verifyActionIds`. ownedFiles = the sorted union of the affecting
  steps' `ownedFiles` (live steps, earlier repairs included, whose `affects` hold a failing
  requirement); if one of them is an unrestricted integrator (build/chore, no ownedFiles), the
  repair has none either and runs alone (`repairUnrestricted: true`). Purpose `Repair after
  verify round <r>: <ids>`; prompt `Kernel repair: make <ids> pass. The kernel adds the failing
  evidence, discovery items, not-done items and handoffs below.` (short, so `plan export` stays
  readable).
- **Verify** id `verify-round-<r+1>` (same rule). Kind `adversarial-acceptance`; effort = the
  highest of the round-1 evidence steps; `evidenceFor` = the re-check set; dependsOn
  `[repair-r]`; purpose `Verify round <r+1> of <max>: re-check <n> requirement(s)`; prompt
  `Re-check <ids> after <repair id>.` The router's evidence rule already prefers a pool other
  than the repair's.

Validator exemption: `validateActionProgram` requires every evidence step for X to depend on
every work step that affects X, but a repair affects X and runs after the verify that judged X.
`v2LiveProgramRuntime(state)` passes `kernelRepairActionIds` (from `verifyLoop`), and that one
rule skips them. Nothing else is relaxed.

### 3.5 Task text per round

The repair brief, `repairBrief(state, actionId, runDir)`, is appended after the prompt by
`buildProgramWorkTask`:

```
## Kernel repair after verify round {r} of {max}
Make every requirement below pass. An independent verifier failed it; its evidence is quoted.
### {id} · {failed|blocked} in round {r} ({verify step})
{requirement text} — then Evidence (up to 6 lines, 400 chars each) and Concerns (up to 3)
### Also fix: discovery items from verify round {r}             (rounds ≥ 2 only)
### Not done in the steps that affect these requirements        (- {step}: {item})
### What those steps did                                        (one block per affecting step)
Keep passing requirements passing. Do not weaken, skip or delete a test to make it pass. Run the
focused tests and the goal's acceptance command. Under `## Done`, name each requirement id you
fixed and the command that proves it.
```

Each step block is `durableAttemptHandoff(lastSucceededAttempt, runDir, repairHandoffBlock)`:
the facts `handoffBlock` prints (pool, model, times, changed files, diff stat, output file and
bytes, stream file, last responses) under `### <step> · attempt <id>`, without the `Failure`
and "unverified edits" lines, because these attempts succeeded.

`roundBrief(state, actionId)` is appended by `buildEvidenceTask`:

- Round 1 (the author's evidence steps): *Verify round 1 of {max}. A requirement you fail starts a
  kernel repair built from your evidence, so make each failing line actionable: the file, the
  command you ran and what it printed.*
- Middle rounds (2 ≤ r < max): *Verify round {r} of {max}: re-check and discovery. {repair}
  changed: {files}. Re-check each requirement below as the workspace is now; the previous
  round's failing evidence is quoted under each. Then look for (a) regressions the repair caused
  in the files it changed and (b) the same defect as each re-checked failure elsewhere. Report
  each finding as a concern starting `Discovery:` that names the file, on the requirement it
  threatens; a finding that breaks a requirement you judge makes it failed. Carried forward,
  not yours to judge: {ids}.*
- Final round (r = max ≥ 2; round 2 when `verifyRounds` is 2): *Verify round {r} of {max}:
  final closure. Re-check only whether each requirement below now passes (previous evidence
  quoted). Do not look for new problems or add `Discovery:` concerns: nothing runs after this.*

### 3.6 Carry-forward rule

When repair r succeeds, the re-check set is (1) the round's failing requirements (the repair
invalidated them when it started, like every work step), plus (2) every passed requirement whose
current passing evidence (evidence and concern lines) names a file repair r changed: its
repository path appears, or its basename as a whole word. Evidence naming no file at all is
workspace-wide (a suite run, a CLI behaviour): any repair that changed a file re-opens it (D3).
Unknown changed files re-open every passed requirement. Set 2 is invalidated
(`invalidateRequirements`, revision `loop-<r>-touched`) and reads pending until judged. Every
other passed requirement carries forward: its evidence stays current and no later round judges it.

Changed files = the union of `changedFiles` over repair r's attempts. Attempts record only
`changedFileCount` and a diff stat today (git shortens long paths there with `...`), so
`dispatchV2Action` also records the path list `changedFiles` (at most 200) and `ATTEMPT_FIELDS`
allows it. Side fix: `durableHandoffFacts` already reads `attempt.changedFiles`, so resumed
handoffs have always printed `none` for it.

### 3.7 Discovery

In a middle round, concern lines starting `Discovery:` (any case) are recorded on that round as
`{ requirementId, text }` (prefix removed, 300 characters, at most 20). The next repair lists
them under "Also fix"; its `affects` stays the failing requirements. The final round records
none. If a middle round fails nothing, the run ends and its discovery lines stay in the result
as ordinary concerns.

### 3.8 Plan revisions during the loop

Always accepted and applied as today. What they do to the round count:

1. Only the kernel counts rounds; a revision never adds, resets or refunds one.
2. Kernel steps are ordinary steps in `plan export`; keeping, amending or rerunning one keeps
   the loop going.
3. Removing the kernel step in progress stops the loop (`stoppedBy: revision`); the run
   finishes at the next boundary with the caller-decision block.
4. Evidence from caller-added or rerun verify steps belongs to the round the next boundary
   closes; it is not a round.
5. `defaults.verifyRounds` in a revision sets `max` for the rest of the run (1–3, never below
   the rounds already closed); absent leaves it unchanged. Applied after the commit in
   `applyQueuedRevision` and `commitRevisionUnderLease`. A revision that changes only the
   budget is a change: `planV2Revision` asks `revisedVerifyRounds` and accepts it with empty
   step changes (added at integration).
6. Reopening a finished run (plan revise, workflow resume) keeps the record. A run stopped at
   `rounds` never gets another kernel round: the caller's own verify runs and the next boundary
   finalizes. A run stopped at `step-failed` continues its loop once that step succeeds.

### 3.9 What the caller gets

`result.json` gains two keys (`validateV2ResultEnvelope` allows them; older results have
neither). Angle brackets are placeholders, not figures:

```json
"verifyRounds": { "max": 3, "used": 3, "stoppedBy": "rounds", "phases": [
  { "kind": "verify", "round": 1, "steps": ["verify"], "judged": <n>, "failed": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" },
  { "kind": "repair", "round": 1, "steps": ["repair-1"], "requirements": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" } ] },
"callerDecision": { "verifyRounds": "3/3", "requirements": [
  { "id": "requirement-3", "status": "failed", "round": 3,
    "evidence": "<first line of the latest evidence, 200 chars>", "next": "<one suggested next step>" } ] }
```

- `wallMinutes`: union of the phase's attempt intervals (parallel steps count once), one
  decimal. `pools`: distinct, in start order. `cost`: `honestApiTotalText(recordSpendFacts(null,
  attempts), { api: null, counts: 'unmeasured' })` — `$X` or `at least $X · N unmeasured`;
  nothing priced reads `—`.
- `callerDecision` appears when the run is not verified and its last closed round left failing
  mandatory requirements, whatever `max` is (D5), and for requirements no evidence step covers (3.10). `next` = the first item of `## Suggested next
  step` in the last repair report covering the requirement, else `add a step that fixes {id}
  (owning {up to 3 files}) and rerun {last verify step}: bullswarm workflow plan export {token}
  --out plan.json, edit it, then plan revise`. `reason` reads `… but not verified after verify
  rounds 3/3: …`.
- `summarizeV2Result` (`runs result <id> --summary`) copies `verifyRounds` once a round has run
  (`used > 0`) and `callerDecision` when it is not null (the full result keeps
  `callerDecision: null` whenever a loop exists and nothing is left for the caller). `fitResultSummary` shrinks the phases to
  `{ kind, round, wallMinutes, pools, cost }` first (requirement 5 names the pool), then
  `evidence` to 120 characters; ids and `next` are never dropped. As a last resort, and only when
  that alone reaches the 4096-byte budget, the summary keeps `phases: []`. Text (`formatV2HandbackLines`, for `runs result` and watch):

```
verify rounds 3/3 · not verified — your decision:
  requirement-3 failed in round 3 — <evidence>
    next: <next>
rounds:
  verify round 1 · <m>m · <pool> · <cost>
  repair round 1 · <m>m · <pool> · <cost>
```

### 3.10 A requirement no evidence step covers

Round 1 judges every requirement an evidence step names. It also accounts for every other
declared requirement, so none vanishes (revised after verify round 1 of the 0.35.2 loop run,
which found an optional `beta` silently dropped when `evidenceFor` listed only `alpha`):

- The status is `not judged · no evidence step covers it` (`NOT_JUDGED_STATUS`). It is a
  derived state, not a ledger status: the ledger keeps `pending`, and the round record gains no
  field. `notJudgedRequirements(state)` = the declared requirements outside round 1's `toJudge`
  that are still `pending` and that no live evidence step names now (a step a revision adds
  judges it like any other).
- It never counts as passed and does not start a repair by itself: `failingRequirements` reads
  only `failed`, `blocked`, and `pending` inside a round's `toJudge`, so a repair is for
  requirements a verifier judged.
- It appears in `callerDecision` (`round: 1`, `evidence` = the requirement's text, `next` = add
  an evidence step naming it) whenever the run ends, mandatory or not. A verified run (every
  mandatory requirement passed) therefore may carry a `callerDecision` whose entries are all
  `not judged`; `validateV2ResultEnvelope` accepts that and still refuses a verified result with
  any other entry. `loopVerdictText` and the `not verified · verify rounds` label still read only
  the failing requirements.
- The round-1 finished event and the round-1 `verify` phase carry `notJudged: [ids]` when there
  is one. `runs result` prints `verify rounds 1/3 · verified, but some requirements were not
  judged — your decision:` for a verified run, and `not verified — your decision:` otherwise.

## 4. Events

| Type | When | Payload |
| --- | --- | --- |
| `workflow.verify-round` | a round opens | `{ round, of, stage: "started", steps, toJudge, carried }` |
| `workflow.verify-round` | a round closes | `{ round, of, stage: "finished", passed, failed, discovery, next, wallMinutes }` |
| `workflow.repair` | a repair is added | `{ round, stage: "started", actionId, requirements, ownedFiles, unrestricted, discovery }` |
| `workflow.repair` | the boundary after it succeeded | `{ round, stage: "finished", actionId, status, changedFiles, recheck }`; a failed repair ends the run `partial` (`stoppedBy: step-failed`) with no finished event |

`next`: `repair`, `finish` or `caller` (failures left, loop done). `discovery` and
`changedFiles` are counts (the latter null when unknown).

## 5. Display strings

| Surface | String | Built in |
| --- | --- | --- |
| Run phase, verify | `verify · round 2 of 3 · 2 to re-check` (round 1: `verify · round 1 of 3 · 7 to judge`) | `run-model.js` stage names via `loopStageLabel(state, stage)`, when every step of the stage is that round's verify step |
| Run phase, repair | `repair · round 1 · 2 requirements` | same |
| Run header, finished | `completed · verified`; `completed · not verified · verify rounds 3/3` | `run-view.js`, from `result.verifyRounds` |
| Run timeline row | `returned early · N not done` after the attempt's duration | `run-view.js` (`runTimelineFacts` already carries the attempt) |
| Home card | `verify round 2/3` in place of `running` | `home-model.js` via `verifyRoundLabel(state)` |
| Runs list | `verify round 2/3` as the phase | `runs-view.js` via `verifyRoundLabel(state)` |
| Step header | `returned early · N not done`; `box 20m · ran 34m` when the attempt ran past its box, else `box 20m` | `step-model.js` (`earlyText`, `boxText`), `step-view.js` |
| watch | `◐ <step> returned early · N not done`, instead of the `✓ … finished` line | `watch-cli.js`; glyph `early`: `◐`, ASCII `-` |
| watch | `◆ verify round 2 of 3 · 3 to re-check`; `✓ verify round 2 of 3 · all 3 passed`; `✗ verify round 1 of 3 · 2 failed · repair next`; `✗ verify round 3 of 3 · 1 failed · your decision` | `watch-cli.js` |
| watch | `↻ repair round 1 · 2 requirements · repair-1`; `✓ repair round 1 finished · 4 files changed` | `watch-cli.js` |
| watch outcome | `outcome: completed · not verified · verify rounds 3/3`, then the decision lines | `watch-cli.js` |

`verifyRoundLabel(state)` shows from the first repair until the run is terminal, numbering the
round being worked toward (`verify round 2/3` during `repair-1` and `verify-round-2`). `ran` is
the attempt's wall minutes, rounded. watch trouble: a round close with `next: caller` is
`rejected`; with `max` above 1 a failing `evidence.recorded` is not trouble (the kernel repairs
it). `watch --until outcome` is unchanged: the run stays `running` between rounds.

## 6. History comparison

The history facts from the goal: 16 of 35 runs needed more than one verify round; rounds 2+
took 754 agent-minutes (47 per such run); verify is 19% of agent-minutes; the median attempt
stops editing at 88% of its wall time.

- **Caller wait.** Each extra round used to wait for the caller to `plan revise`; the loop
  starts the repair at the boundary. That wait was never recorded, so the saving is unmeasured.
- **The cap.** Approximated on the 0.35.2 snapshot (a round = a run of `evidence.recorded`
  events with no succeeded work step between): of 52 program runs with an evidence step, 32
  closed 1 round, 10 two, 5 three, 2 four, 1 nine, 2 none. 47 of the 50 that closed one did so
  within 3; the other 3 would hand back at 3/3.
- **Cost of rounds 2+.** Not cheaper by itself: later rounds judge only the re-check set, and
  every repair is time-boxed. Whether rounds 2+ drop below 47 agent-minutes per looped run, and
  verify below 19%, is a measurement for `result.verifyRounds.phases`, not a claim.
- **Where the box bites.** Box = 1.5 × median, so the wrap-up point (70%) falls at 1.05 ×
  median: a typical attempt never reaches it. It speaks to the tail: attempts over twice their
  kind's median were 36/235 implement, 7/80 adversarial-acceptance and 9/46 integration. That
  tail is work, not idling: the 15 attempts over 30 minutes kept editing until 0.8–6.9 minutes
  before the end (median over 71 attempts: 2.0 of 18.7 minutes after the last edit). A box cuts
  scope, not an idle tail.
- **The experiment.** Boxed at 15 minutes: 10m54s and 10m03s against 23m30s and 48m44s alone,
  54% and 79% shorter pairwise (the goal's "about 55–80%"), with honest partial reports; suites
  passed 1534 and 1533 against 1536 and 1539 (0 failed), so the boxed runs added fewer tests.
  n = 2 per arm: a direction, not a measurement.

## 7. Ownership

The split works with three additions (bold) to `time-box`'s territory; `repair-loop` runs after
it, so the sharing is sequential. `docs` runs alongside `time-box` and touches none of them.

| Step | Files | What changes |
| --- | --- | --- |
| time-box | `time-box.js` (new) | `timeBoxHistory`, `resolveTimeBox`, `timeBoxParagraph`, `parseNotDone` |
| time-box | `action-validator.js` | `timeBox` field and default; `verifyRounds` default, returned beside `actions` |
| time-box | `v2-runtime.js` | `runAction` passes the `timeBox` option and records `returnedEarly`; `normalizeAttempt`; the not-done block in `buildEvidenceTask` |
| time-box | **`v2-dispatch.js`** (add) | the paragraph per attempt; `timeBox` on the started record |
| time-box | **`v2-state.js`** (add) | `ATTEMPT_FIELDS`: `timeBox`, `returnedEarly`, and their checks |
| time-box | **`src/lib/glyphs.js`** (add) | `early`: `◐`, ASCII `-` |
| time-box | `step-model.js`, `step-view.js`, `run-view.js`, `watch-cli.js` | early-return and box strings |
| repair-loop | `verify-rounds.js` (new) | `nextLoopStep`, `planLoopStep`, `repairBrief`, `roundBrief`, `repairHandoffBlock`, `recheckSet`, `loopStageLabel`, `verifyRoundLabel`, `roundPhases`, `callerDecision` |
| repair-loop | `v2-runtime.js` | loop hook before `finalize` in `runV2Kernel`; round 1 opened in `runAction`; `verifyLoop` created in both accept paths; `max` from revisions; brief call sites |
| repair-loop | `v2-state.js`, `v2-dispatch.js` | `verifyLoop` checks; `kernelRepairActionIds` in `v2LiveProgramRuntime`; `changedFiles` |
| repair-loop | `action-validator.js` | the ancestor-rule exemption |
| repair-loop | `v2-outcome.js`, `runs-cli.js` | result keys, summary, text lines, reason |
| repair-loop | `run-model.js`, `run-view.js`, `home-model.js`, `home-view.js`, `runs-view.js`, `watch-cli.js` | round labels, round lines, trouble rule |
| docs | `v2-planner.js` | `defaults.allowed` gains `timeBox` and `verifyRounds`; `actionFields` gains `timeBox`; the rules say the kernel adds `repair-<n>` and `verify-round-<n>` steps and authors must not write repair steps; `repair` stays a forbidden field |

`v2-scheduler.js` needs no change. `v2-revision.js` was planned unchanged; integration added
the budget-only revision (3.8 rule 5). Proof (requirement 7): fake-worker kernel
tests (`dependencies.watchOnce`, temp homes); carry-forward uses evidence naming `src/b.js` and
a repair changing `src/a.js`, then `src/b.js`; the fixture box is (codex, implement) → 30.

## 8. Decisions made here

- **D1** The kind level also needs 5 attempts (the goal names the threshold only for the
  pair); a median of 2 is noise.
- **D2** Digest tasks get the paragraph like every other dispatched step (revised after verify
  round 1 of the 0.35.2 loop run: the goal says every task the kernel writes, and history has
  digest attempts, so the kind fallback applies; the fixture's (codex, digest) box is 10, median
  3.96). `timeBox: 0` is the only opt-out. A digest's `## Not done` is quoted from its sources, so
  its attempt never records `returnedEarly`.
- **D3** Evidence that names no file is workspace-wide (3.6); otherwise a "full suite passes"
  requirement would carry forward through a repair that broke the suite.
- **D4** `blocked` counts as failing: a repair can remove what blocked the verifier.
- **D5** `verifyRounds: 1` runs as today; the result still carries both new keys (additive).
- **D6** Kernel steps are ordinary program steps added by a kernel-source revision, so
  scheduling, dispatch, cost, pages and resume need no second path. The price: one validator
  exemption, and kernel steps in `plan export`.
- **D7** The evidence paragraph asks for the sections after the preflight's confirmation
  ("only a short confirmation"); they are not parsed, and the candidate file stays the contract.
