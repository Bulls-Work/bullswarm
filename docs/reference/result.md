---
title: Result envelope
description: Field-by-field JSON returned by bullswarm run --json and workflow runs result --json.
---

# Result envelope

After this page you can parse `bullswarm run --json` and `bullswarm workflow runs result --json` without opening `state.json`, and know which fields mean the work is done versus merely launched.

Judge delegate output by content, not exit code. A clean process exit is not proof of success. Read `ok` / `verified` and the saved artifact before treating a run as done.

## run --json

`bullswarm run --json` prints one verdict object. Without `--json` it prints a one-line `OK`/`FAIL` summary and, on `--dry-run`, the command and a `forecast:` line.

```bash
# Dispatch one bounded task and print the verdict document.
bullswarm run --lane analyze --add-dir . --json "List every TODO in src/ with file:line"
```

| Field | Meaning |
|---|---|
| `ok` | `true` when the content judge passed **and** the process exited 0. `false` on a failed judge, a non-zero exit, spawn failure, timeout, stall, quota, or auth |
| `keepOnClaude` | `true` when routing kept the task on the calling agent instead of spawning a delegate. `ok` is then `true` and `pick.pool` is `null` |
| `why` | one-line reason. Success is `verified`. A non-zero exit with passing content is `verified content but non-zero exit` |
| `id` | once a delegate ran: the run's decision-log id (`null` only when the in-flight ledger could not be written). Pass it, or `outFile`, to a later run's `--independent-of`. In a `run --batch` array it is `runId`, and `id` is the line's |
| `pick.pool` | pool that ran, or `null` when kept on the caller |
| `pick.model` | model id sent to the CLI |
| `pick.command` | argv template (`spawn.cmd`). On `--dry-run` this is the resolved argv including the clamped reasoning flag |
| `outFile` | `~/.bullswarm/runs/out-<stamp>.md` (or `$BULLSWARM_HOME/runs/...`) — the extracted answer. Always read this when `ok` is true |
| `taskFile` | the prompt file the worker was given |
| `contentUsableDespiteExit` | `true` when `ok` is false, the process exited non-zero, and the content judge still passed. Do not discard that `outFile` |
| `failureKind` | present on failure: `quota`, `throttle`, `auth`, `provider`, `process`, `schema`, `stalled` |
| `retryAfter` | on a usage limit whose reset is known: that reset, as an ISO time. It is known when the provider's line named it, or when the pool's own meter reads 95% or more on a window still running (that window's reset). Absent otherwise. Nothing is stored about the pool: the next pick reads its meters again |
| `cancelled` | `true` when a workflow cancellation stopped the worker |
| `dryRun` | `true` on `--dry-run`. Nothing was spawned, logged, or registered in the assignment ledger |
| `forecast` | the numbers routing compared: `inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `expectedMinutes`, `ratePerMinute`, `estimateSource` |
| `candidates` | routing candidate rows (dry-run and keep-on-caller include this) |
| `routeFilter` | only with a route filter flag (`--avoid-pool`, `--use-provider`, `--avoid-provider`, `--independent-of`), dry-run included: `summary`, `left`, `filteredOut` (`pool`, `provider`, `why`), `callerFilteredOut`, `independentOf`, `empty`. When `empty` is `true`, nothing ran and the command exited 1. See [Route filters](/reference/cli#route-filters) |
| `reasoning` | `{ requested, applied, source, clamped }` — the level this attempt actually ran at |
| `meta.exitCode`, `meta.signal`, `meta.timedOut`, `meta.stalled`, `meta.cancelled` | process observation |
| `meta.wallSec`, `meta.outBytes` | duration and extracted output size |
| `meta.usage` | complete v2 attempt usage: provider-reported, transcript-summed, estimated, or unknown exclusive token classes; `api.usd` is the local dated rate-card calculation and `subscription.usd` is the separately measured or calibrated quota-window amount |
| `structured` | only when an output validator ran (workflow evidence): `{ ok, errors, value? }` |
| `answer` | only with `--answer-schema`: the parsed typed answer, or `null` when the file is missing or not JSON |
| `answerCheck` | only with `--answer-schema`: the schema check, `{ ok, errors, file, why }`. `ok` then also needs `answerCheck.ok` — see [Typed answers](/reference/cli#typed-answers) |
| `workerOk` | only with `--answer-schema`: the worker's own verdict, apart from the check |

`--dry-run` prints `ok`, `dryRun: true`, `keepOnClaude`, `why`, `forecast`, `candidates`, `pick` (resolved argv including the clamped reasoning flag), and `reasoning`. It omits `id`, `outFile`, `taskFile`, `contentUsableDespiteExit`, `meta`, and the failure fields, because nothing was spawned. `--dry-run` with no eligible pool and `keepOnClaude: true` still exits 0. `--dry-run` that cannot pick and cannot keep the task sets `ok: false` and exits 1.

::: warning
`ok: true` with `keepOnClaude: true` means the caller should do the work itself. It is not a completed delegate. The skill documents this as `keepOnClaude: true`.
:::

## workflow runs result --json

After a workflow reaches a terminal state, consume this envelope instead of probing `state.json` or provider-specific output. `runs show` remains the low-level debugging surface.

```bash
# Compact status-loop envelope (implies --json). Use this to poll.
bullswarm workflow runs result <shortId> --json --summary
# Full versioned document. Read this on failed or partial runs, or before judging evidence.
bullswarm workflow runs result <shortId> --json
```

The full document is `schemaVersion: "bullswarm.workflow.result.v2"`. Allowed top-level fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | `bullswarm.workflow.result.v2` |
| `runId` | durable `wf-...` id |
| `shortId` | 6-character Crockford-style handle (no `0/1/i/l/o`) |
| `intentId` | goal/intent id |
| `goal` | the goal text as launched |
| `status` | `completed`, `partial`, or `cancelled` |
| `verified` | `true` only when `status` is `completed` **and** every mandatory requirement has passing evidence. A completed program can be unverified |
| `reason` | one-line outcome. Completed-but-unverified names which requirement is open. In a run started by this version, a dispatched planner or a scout that a usage limit, a rate limit or no free pool stopped reads `the workflow planner stopped on a usage limit: <why> · back at <time> · your call: …` (or `the preflight scout stopped on a usage limit: …` for a scout with no program after it; `stopped: no pool free` when a pool was out for another reason or no pool can run it at all) |
| `executionMode` | `"program"` on caller-authored (and dispatched-planner) programs |
| `workspace` | Git status inventory on program runs: `cwd`, `changedFiles`, `baselineChangedFiles`, `warnings`. Not per-worker attribution; files stay in the target directory |
| `requirements[]` | ledger: `id`, `text`, `mandatory`, `status` (`pending`/`passed`/`failed`/`blocked`), `workRevision`, `evidence[]`, `accepted` when a caller accepted a failing requirement |
| `actions[]` | `id`, `purpose`, `status`, `outputFile`, `artifactIds`, `reasoning`, `kind`, `role` when the step stated one, `evidenceResults` when the step declared evidence, `acceptance` when accepted, `bytes`, and on program runs `failure` |
| `verifyRounds` | program runs from 0.35.2 on: the repair loop's record, `{ max, used, stoppedBy, phases[] }`, one phase per verify round and per repair (`used: 0` when no evidence step ran). See [Verify rounds](#verify-rounds) |
| `callerDecision` | program runs from 0.35.2 on: `null`, or what is still open and one suggested next step each: the mandatory requirements the last closed round left failing, and every declared requirement no evidence step covers (`not judged · no evidence step covers it`, on a verified run too). See [The caller-decision block](#the-caller-decision-block) |
| `gaps` | `null` on a verified completed run; otherwise `bullswarm.workflow.gaps.v2` with open requirements and failed/blocked/cancelled/interrupted actions |
| `usage` | `{ total, byPool, bytes, steps, totals }`; `bytes` keeps UTF-8 byte counts, while `steps` and `totals` expose measured token and money rollups |
| `finishedAt` | ISO timestamp |
| `handback` | present unless the run is completed, verified, and has no unread steering. See below |

Requirement `status` values: `pending`, `passed`, `failed`, `blocked`. Action `status` values: `pending`, `ready`, `running`, `waiting` (only in a run saved by an earlier version; no current run writes it), `succeeded`, `failed`, `blocked`, `cancelled`, `interrupted`, `removed`.

Each requirement `evidence[]` entry is `{ sourceAction, status, evidence, concerns, eventSequence, mechanicalFailure?, reviewer?, independent? }`. A reviewer records `{pool, model, provider}`; `independent` is `true` when no provider that did work on the judged steps is the reviewer's provider, `false` when one is, and `null` when no writer is known or the reviewer's or a writer's provider is unknown. An accepted requirement adds `accepted: {step, reason, at}`. Only evidence from the current `workRevision` is current. Negative evidence does not open another planner round.

A step's `acceptance` is `{evidence:"choice", reason, at, attemptId, failureKind, requirements?}`. This records a caller decision, never proof. Accepted steps have the proof label `choice`, not `proven`; accepted requirements do not become verified. Rerunning the step clears acceptance.

A step that declares `evidence` adds `actions[].evidenceResults`; when the worker failed first and no check ran, the value is `null`, and the step's handback line reads `evidence not run`. Each item records its declared type and fields, `status` (`passed`, `failed`, or `not-run`), `exit`, `durationMs`, `tail`, `log` and `why`, plus optional timeout, signal, side-effect and schema-error facts. A schema item's `tail` is the checker's `--json` report line. This item is copied from a real run of a schema check on `[{"date":20260901}]` against a schema that requires `date` to be a string:

```json
{"type":"schema","file":"out/records.json","schema":"schemas/record.json","timeoutSec":120,"status":"failed","exit":1,"durationMs":47,"errorCount":1,"errors":["$[0].date must be string (got integer)"],"tail":"{\"ok\":false,\"exit\":1,\"errorCount\":1,\"errors\":[\"$[0].date must be string (got integer)\"],\"notes\":[],\"why\":\"not valid: 1 error\",\"fault\":null}","log":"<runDir>/evidence-records-attempt-1-1.log","why":"not valid: 1 error"}
```

Evidence results are not added to the requirement ledger and do not make a requirement `verified`.

The compact summary adds `proof` to each eligible action row and a top-level proof count. The row's array names `command`, `schema`, `review`, and `choice`; an accepted step has `proof: ["choice"]`. A choice is not proof: `proof.byType.choice` and `accepted` count choices separately, while `proven` counts only steps backed by command, schema, or review. `unproven` counts the other finished eligible steps. The row field is omitted for old runs without the `proofLabels` marker unless that step declares evidence; saved runs are not rewritten.

Each action `bytes` is `{ taskFile, authorPrompt, kernel, dependencyInputs, output }` — the task file the kernel wrote, the action's own prompt, the remainder after subtracting that prompt, the sum of dependency output files (0 when there are none), and the durable out file. Missing values are `null`, never guessed.

`failure` is `{ kind, message? }`. A new run gives each step one automatic retry: process failures go to another eligible pool, gate failures go to the same pool with the failure attached, and a usage limit (`quota`), or no free pool, comes back to you at once with no retry. A transient rate limit (`throttle`) first backs off on the same pool at most twice without spending the retry. Nothing waits for a pool. An `act` step is not retried after its worker starts. Runs started by an earlier version keep their saved retry rules. Kinds a plain `workflow resume` can retry: `provider`, `quota`, `throttle`, `auth`, `process`, `unavailable`, `interrupted`, `runtime`, `schema`, `stalled`. A failed step whose failure is about the work itself (declared evidence, a deliverable not produced, a check that failed it, output judged failed, or a build-lane step with no declared deliverable that changed nothing) is not rerun by `workflow resume`: that is `failed-evidence`, `not-produced` (a declared deliverable was not produced, or, in a run started by this version, a build-lane step with no declared deliverable changed no file and made no commit), a check that failed the work, and `semantic`. Use `step rerun`, `step accept`, or `plan revise` for those failures.

## Verify rounds

In a new run, a failed mandatory requirement gets one fix step and one re-review by default. `defaults.verifyRounds` counts fix cycles (0–3, default 1; 0 means review only). Remaining failures go to the caller. Saved runs keep their original limit of up to 3 review rounds. A read-only `analyze` step with deliverable `report` is used when every affecting step declares a report; a requirement an `act` step affects is never repaired. The result records the loop in `verifyRounds`:

```json
"verifyRounds": { "max": 2, "used": 2, "stoppedBy": "rounds", "phases": [
  { "kind": "verify", "round": 1, "steps": ["verify"], "judged": <n>, "failed": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" },
  { "kind": "repair", "round": 1, "steps": ["repair-1"], "requirements": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" } ] }
```

Angle brackets are placeholders, not figures.

| Field | Meaning |
|---|---|
| `max` | the cap in force: up to 4 review rounds; in a new program `defaults.verifyRounds` counts fix cycles (0–3, default 1) |
| `used` | rounds opened; on a run that stopped because a step failed, the last one may not have closed |
| `stoppedBy` | `null` while the loop has not stopped, then `passed` (nothing left failing, or a repair left nothing to re-check), `rounds` (the cap was reached with requirements failing), `revision` (a plan revision removed the kernel's step or its round's verify steps, or the kernel could not add its step), `step-failed` (a step failed or was blocked after a round had closed) or `act-step` (a failing requirement an act step affects; the kernel never repeats outward actions) |
| `phases[]` | one entry per verify round (`kind: "verify"`) and per repair (`kind: "repair"`), in order |
| `phases[].steps` | the ids of the steps that made up the phase |
| `phases[].judged`, `.failed` | (verify) how many requirements the round judged, and which failed or were blocked |
| `phases[].notJudged` | (verify, round 1, only when there is one) the declared requirements no evidence step covers |
| `phases[].requirements` | (repair) the requirements the repair was asked to fix |
| `phases[].wallMinutes` | the union of the phase's attempt intervals, one decimal; parallel steps count once |
| `phases[].pools` | distinct pools that ran the phase, in start order |
| `phases[].apiUsd`, `.unmeasured`, `.cost` | API-rate money for the phase; `cost` is `$X`, `at least $X · N unmeasured`, or `—` when nothing was priced. Unknown money is never a zero |

In a new run, `verifyRounds.max` is the number of review rounds: the fix-cycle count plus the first review. The default one fix cycle means `max: 2`; zero cycles means `max: 1`. Saved runs keep their original meaning and default. A run saved before 0.35.2 has no `verifyRounds` record.

## The caller-decision block

After the last round, whatever is still failing is yours to decide. The block is present when the run is not verified and its last closed round left mandatory requirements failing, and it names each of them. It also names every declared requirement that no evidence step covers, mandatory or not, because round 1 could not judge it; on a run that is verified (every mandatory requirement passed) those are the only entries:

```json
"callerDecision": { "verifyRounds": "2/2", "requirements": [
  { "id": "requirement-3", "status": "failed", "round": 2,
    "evidence": "<first line of the latest evidence, 200 characters>", "next": "<one suggested next step>" } ] }
```

| Field | Meaning |
|---|---|
| `verifyRounds` | rounds used over the cap, for example `2/2` |
| `requirements[].id`, `.status` | a mandatory requirement that has not passed: `failed`, `blocked`, or `pending` when the last round it was given recorded no evidence for it; or a requirement no evidence step covers, with the status `not judged · no evidence step covers it` (it never counts as passed and never starts a repair) |
| `requirements[].round` | the round that last judged it (`1` for a requirement that was not judged) |
| `requirements[].evidence` | the first line of its latest evidence, at most 200 characters (the requirement's own text when it was not judged) |
| `requirements[].next` | for a requirement that was not judged, `add an evidence step whose evidenceFor names <id>, then judge it: bullswarm workflow plan export <shortId> --out plan.json, edit it, then plan revise`; for a requirement an act step affects, `an act step affects <id>; Bullswarm never repeats an outward action on its own. Check what was done, then add an act step if it must be redone: bullswarm workflow plan export <shortId> --out plan.json, edit it, then plan revise`; otherwise, in a run started by this version, for a failed or blocked requirement: `fix it with a step (bullswarm workflow plan export <shortId> --out plan.json, edit it, then bullswarm workflow plan revise <shortId> --program plan.json), rerun the review elsewhere (bullswarm workflow step rerun <shortId> <check> --avoid <pool>), or accept it (bullswarm workflow step accept <shortId> <check> --requirement <id> --reason "…")`, naming the check that judged it last and its pool (`<pool>` when unknown); the accept part is left out when that check neither succeeded nor failed. A requirement left `pending` names the step that kept it from being judged instead: `<step> failed, so no review judged <id> after it: rerun <step> (bullswarm workflow step rerun <shortId> <step>), …, or fix it with a step (…)`. The last repair report's first `## Suggested next step` item follows as `; suggested: <item>`. In runs started earlier: that first suggested item, or when there is none `fix it with a step (…), rerun the review elsewhere (bullswarm workflow step rerun <shortId> <check> --avoid <pool>), or accept it (bullswarm workflow step accept <shortId> <check> --reason "…")` |

With a cap above 1 the run's `reason` then reads `… but not verified after verify rounds 2/2: …`. `bullswarm workflow runs result <shortId> --json --summary` copies `verifyRounds` once a round has run and `callerDecision` when it is not `null`. When the summary must shrink to fit its budget, the phases shrink to `{ kind, round, wallMinutes, pools, cost }` and then `evidence` to 120 characters; ids and `next` are never dropped. Only when that is not enough and dropping the phase rows alone brings the summary under budget does it keep `phases: []` (the full result keeps them). In text, `runs result` and `workflow watch` print the block when there is a decision or more than one round ran:

A verified run whose only open items are requirements no evidence step covers prints `verify rounds 1/2 · verified, but some requirements were not judged — your decision:` and one `<id> not judged · no evidence step covers it — <requirement text>` line each. The round-1 `verify` phase then also carries `notJudged: [<id>, …]` (only when there is one), and the round-1 finished event does too.

```
verify rounds 2/2 · not verified — your decision:
  requirement-3 failed in round 2 — <evidence>
    next: <next>
rounds:
  verify round 1 · <m>m · <pool> · <cost>
  repair round 1 · <m>m · <pool> · <cost>
```

Read the block first on a not-verified run. Act on it, and only on it, for what is left: take the work over, or add a step that names the requirement through a plan revision. Do not hand-add a fix step for an ordinary failing check before the rounds are spent: the kernel does that.

## Early return

A work step that is asked to stop at its time box reports `## Done`, `## Not done` and `## Suggested next step`. When `## Not done` lists items, the step still `succeeded`, and its attempt record carries:

| Field | Meaning |
|---|---|
| `returnedEarly` | `{ count, items }`: how many items the report listed under `## Not done`, and the first 20 of them, each at most 300 characters. Absent when the section is empty, `- none`, or missing |
| `timeBox` | `{ minutes, wrapUpMinutes, source, n, medianMinutes, startClock }`: the box the attempt was given and where it came from (`pair`, `kind`, `fallback`, `program`) |

Both are read with `bullswarm workflow action show <shortId> <step> --json`. The `action.finished` event carries `returnedEarly: { count }`, and the run and step pages read `returned early · N not done`. The selected Run timeline row, the Run live block, and the Step header also list the stored items, clipped to the width; a collapsed timeline row keeps the count. Early return is not a failure: it does not change the step's status, and it is not counted against `verified`. The verifiers receive the items with the rest of the evidence and judge the requirements as the workspace stands.

## Cost rollups

The result envelope keeps the older `usage.total`, `usage.byPool`, and
`usage.bytes` fields for callers that only need counts. The v2 cost view adds:

```ts
usage.steps[actionId] = aggregate
usage.totals = aggregate
```

An action can also carry the same value as `action.usage`. Each `aggregate` has
these fields:

| Field | Meaning |
|---|---|
| `attempts` | number of attempts included |
| `minutes` | summed wall minutes, or `null` when unavailable |
| `tokens` | total exclusive known tokens, or `null` |
| `cacheRead`, `cacheWrite` | cache token subtotals, or `null` |
| `apiUsd` | API-rate amount only when every relevant attempt has one |
| `apiKnownSubtotalUsd` | partial API-rate sum when some attempts are unpriced |
| `subscriptionUsd` | subscription amount only when every relevant attempt has one |
| `subscriptionKnownSubtotalUsd` | partial subscription sum |
| `measuredAttempts` | attempts with measured provider or transcript usage |
| `pricedAttempts` | attempts with a non-null API amount |
| `subscriptionPricedAttempts` | attempts with a non-null subscription amount |
| `tokenSource` | worst token basis across attempts: `unknown` < `estimated:utf8-bytes/4` < `transcript-summed` < `provider-reported` |
| `subscriptionBasis` | worst subscription basis across attempts: `unknown:no-price` < `unknown:no-meter` < `unknown:no-cost` < `calibrated:usd-per-pct` < `observed:meter-delta` |

`apiUsd` and `subscriptionUsd` stay `null` when coverage is incomplete; the
explicit subtotal fields are where partial sums live. Null means unknown and
is not a zero. Individual attempt records, including their full v2 usage
objects and money-pair basis, are available through `workflow action show`.

## Compact summary

`--summary` implies `--json` and prints `schemaVersion: "bullswarm.workflow.result-summary.v1"` as a single `JSON.stringify` line, fitted under a 4,096-byte budget.

| Field | Meaning |
|---|---|
| `runId`, `shortId` | same ids as the full envelope |
| `status`, `verified`, `executionMode`, `reason`, `finishedAt` | same facts, compacted |
| `goal` | first line of the goal, at most 120 characters, plus `goalBytes` |
| `requirements[]` | `{ id, status, mandatory, evidenceCount, why }`. `why` is filled only when the requirement is not `passed` |
| `actions[]` | `{ id, kind, lane, effort, status, pool, model, reasoning, wallSec, outFile, bytes }`. `outFile` is a basename inside `next.runDir` |
| `concerns` | `{ count, first }` — first few concern strings from requirement evidence |
| `usage` | copied from the full envelope |
| `handback` | compacted unfinished steps, unread steering, and `options` commands |
| `verifyRounds`, `callerDecision` | copied from the full envelope: `verifyRounds` once a round has run, `callerDecision` when it is not `null`; phases shrink to `{ kind, round, wallMinutes, pools, cost }` under budget pressure |
| `next` | `{ full, runDir, outputs }`. `full` is the command for the full envelope. Every `outputs` entry is a basename inside `runDir` |

If the summary would exceed 4,096 bytes, fields shrink in a fixed order (concerns, then per-action detail, then an open requirement's `why` last); the verify-round phases shrink to `{ kind, round, wallMinutes, pools, cost }` and a decision's `evidence` to 120 characters, and its ids and `next` are never dropped.

A run started with the stage-3 marker (`failureRule`) sheds its per-step usage before any handback entry, handback `why`, requirement `why` or round row: first each `usage.steps` entry's null fields, then each entry down to `{ attempts, minutes, tokens }`, then `usage.steps` becomes `{}` with `usage.stepsOmitted: true` (`usage.totals` and `usage.byPool` stay; the full result keeps every row).

## handback

Anything short of a verified run with no unread guidance is handed back. The run never waits for the caller.

| Field | Meaning |
|---|---|
| `unfinished[]` | `{ id, status, failureKind, why, retryAfter?, retryable, retries? }` for every action that is not `succeeded` or `removed`; `retries` counts automatic retries spent by the current definition. `retryAfter` is when the step's pool is back: in a run started by this version, the failed pool's reset after a usage limit, the end of a rate limit's named wait, the return of the pool a rate-limit backoff could no longer use, or, when no pool that can run the step was free, the earliest known return among them; in runs started by an earlier version, the return time their saved result recorded. In the compact summary, a failed step that declares evidence and whose worker failed before any check ran adds `evidenceNotRun: true` |
| `unresolvedRequirements[]` | `{ id, status, why }` for every requirement that is not `passed` |
| `unreadSteering[]` | `{ id, message, queuedAt }` guidance queued with `workflow steer` that nobody acted on |

The compact summary adds `options`, one command per key, in this order; the text handback prints them under `your call:` with the printed label:

| Key | Printed as | When it is present | Command it names |
|---|---|---|---|
| `continue` | continue | a program run | `bullswarm workflow plan export <shortId> --out plan.json, edit it, then bullswarm workflow plan revise <shortId> --program plan.json (--rerun <step ids> runs finished steps again)` |
| `retry` | retry | a step is retryable, or, in a run started by this version, a usage limit or no free pool stopped the planner or scout and ended the run | `bullswarm workflow resume <shortId> (reruns <step ids>)`, with `after <time>`, the earliest of their `retryAfter` times, when every step to retry has one. A stopped planner or scout comes first in the list (`reruns the workflow planner`, or `the preflight scout`), and `after <time>` is then its own return time, left out when that is not known |
| `rerun` | rerun | a run started by this version has a failed step | `bullswarm workflow step rerun <shortId> <step> [--avoid <pool>] (runs it again with its last attempt's handoff)`; `<step>` is literal when several failed |
| `accept` | accept | the same | `bullswarm workflow step accept <shortId> <step> --reason "…" (recorded as your choice, never proof)` |
| `rerunReview` | rerun | a run started by this version whose review loop left a requirement failing | `bullswarm workflow step rerun <shortId> <check> --avoid <pool> (judges it again on another pool)`, for the check that judged it |
| `acceptRequirement` | accept | the same, while the requirement is not accepted | `bullswarm workflow step accept <shortId> <check> --requirement <id> --reason "…" (recorded as your choice, never proof)`, with one `--requirement` for each failing requirement that check judged |
| `takeOver` | take over | always | `do the unfinished work yourself; bullswarm workflow runs result <shortId> --json names every step's output` |
| `restart` | restart | always | `start a new run: bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>` |

Near the byte budget the stage-3 additions give way before any handback line: first the explanations in brackets at the end of the new options, then the new options, then `retries`, then acceptance reasons. A requirement row accepted by choice carries `accepted: "<reason>"` and prints as `requirement <id>: failed · accepted by choice "<reason>"`; it stays failed.

`retry` is omitted when nothing is retryable and no planner or scout stop ended the run. `workflow resume` on a finished run with nothing retryable prints `nothing to retry`, starts nothing, and exits 1.

## Launch versus result

`workflow goal --json` without `--foreground` prints a launch document (`schemaVersion: "bullswarm.goal.launcher.v2"`), not a result. It includes an `instructions` handoff with four named paths: `agentInspect`, `watch`, `humanTui`, and `result`. Use `--watch` when the initiating terminal should follow progress; otherwise the command returns after printing that handoff.

A dead kernel with no terminal state is diagnosable: `workflow watch`, `runs show`, and the TUI print the last 20 lines of `~/.bullswarm/goals/<runId>/stderr.log`.

Legacy authored-graph runs are listed as `legacy` rows. Driving commands, including `runs result`, print `legacy authored-graph run <shortId>: its executor was removed in 0.27.0; files remain under <dir>` and exit 2.

## Next steps

- [CLI reference](/reference/cli) — `run` and `workflow runs result` flags
- [Observing](/guide/observing) — watch, TUI, and the status loop
- [Workflow program](/reference/program) — the graph whose outcomes this envelope reports
