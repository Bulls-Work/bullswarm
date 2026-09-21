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
| `pick.pool` | pool that ran, or `null` when kept on the caller |
| `pick.model` | model id sent to the CLI |
| `pick.command` | argv template (`spawn.cmd`). On `--dry-run` this is the resolved argv including the clamped reasoning flag |
| `outFile` | `~/.bullswarm/runs/out-<stamp>.md` (or `$BULLSWARM_HOME/runs/...`) — the extracted answer. Always read this when `ok` is true |
| `taskFile` | the prompt file the worker was given |
| `contentUsableDespiteExit` | `true` when `ok` is false, the process exited non-zero, and the content judge still passed. Do not discard that `outFile` |
| `failureKind` | present on failure: `quota`, `auth`, `provider`, `process`, `schema`, `stalled` |
| `quarantineHint` | `true` on auth or quota; the pool is benched until `quarantinedUntil` |
| `quarantineUntil` / `quarantineSource` | quota reset deadline and whether it came from the provider message or the cached 5-hour meter |
| `quarantinedSiblings` | other pools in the same `credentialGroup` benched on an **auth** failure. Quota never spreads |
| `cancelled` | `true` when a workflow cancellation stopped the worker |
| `dryRun` | `true` on `--dry-run`. Nothing was spawned, logged, or registered in the assignment ledger |
| `forecast` | the numbers routing compared: `inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `expectedMinutes`, `ratePerMinute`, `estimateSource` |
| `candidates` | routing candidate rows (dry-run and keep-on-caller include this) |
| `reasoning` | `{ requested, applied, source, clamped }` — the level this attempt actually ran at |
| `meta.exitCode`, `meta.signal`, `meta.timedOut`, `meta.stalled`, `meta.cancelled` | process observation |
| `meta.wallSec`, `meta.outBytes` | duration and extracted output size |
| `meta.usage` | complete v2 attempt usage: provider-reported, transcript-summed, estimated, or unknown exclusive token classes; `api.usd` is the local dated rate-card calculation and `subscription.usd` is the separately measured or calibrated quota-window amount |
| `structured` | only when an output validator ran (workflow evidence): `{ ok, errors, value? }` |

`--dry-run` prints `ok`, `dryRun: true`, `keepOnClaude`, `why`, `forecast`, `candidates`, `pick` (resolved argv including the clamped reasoning flag), and `reasoning`. It omits `outFile`, `taskFile`, `contentUsableDespiteExit`, `meta`, and quarantine fields, because nothing was spawned. `--dry-run` with no eligible pool and `keepOnClaude: true` still exits 0. `--dry-run` that cannot pick and cannot keep the task sets `ok: false` and exits 1.

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
| `reason` | one-line outcome. Completed-but-unverified names which requirement is open |
| `executionMode` | `"program"` on caller-authored (and dispatched-planner) programs |
| `workspace` | Git status inventory on program runs: `cwd`, `changedFiles`, `baselineChangedFiles`, `warnings`. Not per-worker attribution; files stay in the target directory |
| `requirements[]` | ledger: `id`, `text`, `mandatory`, `status` (`pending`/`passed`/`failed`/`blocked`), `workRevision`, `evidence[]` |
| `actions[]` | `id`, `purpose`, `status`, `outputFile`, `artifactIds`, `reasoning`, `kind`, `bytes`, and on program runs `failure` |
| `verifyRounds` | program runs from 0.35.2 on: the repair loop's record, `{ max, used, stoppedBy, phases[] }`, one phase per verify round and per repair (`used: 0` when no evidence step ran). See [Verify rounds](#verify-rounds) |
| `callerDecision` | program runs from 0.35.2 on: `null`, or what is still open and one suggested next step each: the mandatory requirements the last closed round left failing, and every declared requirement no evidence step covers (`not judged · no evidence step covers it`, on a verified run too). See [The caller-decision block](#the-caller-decision-block) |
| `gaps` | `null` on a verified completed run; otherwise `bullswarm.workflow.gaps.v2` with open requirements and failed/blocked/cancelled/interrupted actions |
| `usage` | `{ total, byPool, bytes, steps, totals }`; `bytes` keeps UTF-8 byte counts, while `steps` and `totals` expose measured token and money rollups |
| `finishedAt` | ISO timestamp |
| `handback` | present unless the run is completed, verified, and has no unread steering. See below |

Requirement `status` values: `pending`, `passed`, `failed`, `blocked`. Action `status` values: `pending`, `ready`, `running`, `waiting`, `succeeded`, `failed`, `blocked`, `cancelled`, `interrupted`, `removed`.

Each requirement `evidence[]` entry is `{ sourceAction, status, evidence, concerns, eventSequence, mechanicalFailure? }`. Only evidence from the current `workRevision` is current. Negative evidence does not open another planner round.

Each action `bytes` is `{ taskFile, authorPrompt, kernel, dependencyInputs, output }` — the task file the kernel wrote, the action's own prompt, the remainder after subtracting that prompt, the sum of dependency output files (0 when there are none), and the durable out file. Missing values are `null`, never guessed.

`failure` is `{ kind, message? }`. Kinds a plain `workflow resume` can retry: `provider`, `quota`, `auth`, `process`, `unavailable`, `interrupted`, `runtime`, `schema`, `stalled`. A check that failed the work, or a semantic failure, is not retried; add a fix step or name the id in `plan revise --rerun`.

## Verify rounds

When a mandatory requirement fails its evidence, the kernel repairs it itself: at most 3 verify rounds, each failing round followed by one `repair-<n>` step (see [Verify rounds](/reference/program#verify-rounds) for what each round judges). The result records what that cost, in `verifyRounds`:

```json
"verifyRounds": { "max": 3, "used": 3, "stoppedBy": "rounds", "phases": [
  { "kind": "verify", "round": 1, "steps": ["verify"], "judged": <n>, "failed": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" },
  { "kind": "repair", "round": 1, "steps": ["repair-1"], "requirements": ["requirement-3"],
    "wallMinutes": <number>, "pools": ["<pool>"], "apiUsd": <number|null>, "unmeasured": <n>, "cost": "<text>" } ] }
```

Angle brackets are placeholders, not figures.

| Field | Meaning |
|---|---|
| `max` | the cap in force: `defaults.verifyRounds`, else 3 |
| `used` | rounds opened; on a run that stopped because a step failed, the last one may not have closed |
| `stoppedBy` | `null` while the loop has not stopped, then `passed` (nothing left failing, or a repair left nothing to re-check), `rounds` (the cap was reached with requirements failing), `revision` (a plan revision removed the kernel's step or its round's verify steps, or the kernel could not add its step) or `step-failed` (a step failed or was blocked after a round had closed) |
| `phases[]` | one entry per verify round (`kind: "verify"`) and per repair (`kind: "repair"`), in order |
| `phases[].steps` | the ids of the steps that made up the phase |
| `phases[].judged`, `.failed` | (verify) how many requirements the round judged, and which failed or were blocked |
| `phases[].notJudged` | (verify, round 1, only when there is one) the declared requirements no evidence step covers |
| `phases[].requirements` | (repair) the requirements the repair was asked to fix |
| `phases[].wallMinutes` | the union of the phase's attempt intervals, one decimal; parallel steps count once |
| `phases[].pools` | distinct pools that ran the phase, in start order |
| `phases[].apiUsd`, `.unmeasured`, `.cost` | API-rate money for the phase; `cost` is `$X`, `at least $X · N unmeasured`, or `—` when nothing was priced. Unknown money is never a zero |

`verifyRounds: 1` runs a single round as before and still carries the keys; its `reason` line and Run header do not mention rounds. A run saved before 0.35.2 has neither key.

## The caller-decision block

After the last round, whatever is still failing is yours to decide. The block is present when the run is not verified and its last closed round left mandatory requirements failing, and it names each of them. It also names every declared requirement that no evidence step covers, mandatory or not, because round 1 could not judge it; on a run that is verified (every mandatory requirement passed) those are the only entries:

```json
"callerDecision": { "verifyRounds": "3/3", "requirements": [
  { "id": "requirement-3", "status": "failed", "round": 3,
    "evidence": "<first line of the latest evidence, 200 characters>", "next": "<one suggested next step>" } ] }
```

| Field | Meaning |
|---|---|
| `verifyRounds` | rounds used over the cap, for example `3/3` |
| `requirements[].id`, `.status` | a mandatory requirement that has not passed: `failed`, `blocked`, or `pending` when the last round it was given recorded no evidence for it; or a requirement no evidence step covers, with the status `not judged · no evidence step covers it` (it never counts as passed and never starts a repair) |
| `requirements[].round` | the round that last judged it (`1` for a requirement that was not judged) |
| `requirements[].evidence` | the first line of its latest evidence, at most 200 characters (the requirement's own text when it was not judged) |
| `requirements[].next` | for a requirement that was not judged, `add an evidence step whose evidenceFor names <id>, then judge it: bullswarm workflow plan export <shortId> --out plan.json, edit it, then plan revise`; otherwise the first item of `## Suggested next step` in the last repair report that covered it; if there is none, `add a step that fixes <id> (owning <up to 3 files>) and rerun <last verify step>: bullswarm workflow plan export <shortId> --out plan.json, edit it, then plan revise` |

With a cap above 1 the run's `reason` then reads `… but not verified after verify rounds 3/3: …`. `bullswarm workflow runs result <shortId> --json --summary` copies `verifyRounds` once a round has run and `callerDecision` when it is not `null`. When the summary must shrink to fit its budget, the phases shrink to `{ kind, round, wallMinutes, pools, cost }` and then `evidence` to 120 characters; ids and `next` are never dropped. Only when that is not enough and dropping the phase rows alone brings the summary under budget does it keep `phases: []` (the full result keeps them). In text, `runs result` and `workflow watch` print the block when there is a decision or more than one round ran:

A verified run whose only open items are requirements no evidence step covers prints `verify rounds 1/3 · verified, but some requirements were not judged — your decision:` and one `<id> not judged · no evidence step covers it — <requirement text>` line each. The round-1 `verify` phase then also carries `notJudged: [<id>, …]` (only when there is one), and the round-1 finished event does too.

```
verify rounds 3/3 · not verified — your decision:
  requirement-3 failed in round 3 — <evidence>
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

Both are read with `bullswarm workflow action show <shortId> <step> --json`. The `action.finished` event carries `returnedEarly: { count }`, and the run and step pages read `returned early · N not done`. Early return is not a failure: it does not change the step's status, and it is not counted against `verified`. The verifiers receive the items with the rest of the evidence and judge the requirements as the workspace stands.

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

## handback

Anything short of a verified run with no unread guidance is handed back. The run never waits for the caller.

| Field | Meaning |
|---|---|
| `unfinished[]` | `{ id, status, failureKind, why, retryAfter?, retryable }` for every action that is not `succeeded` or `removed` |
| `unresolvedRequirements[]` | `{ id, status, why }` for every requirement that is not `passed` |
| `unreadSteering[]` | `{ id, message, queuedAt }` guidance queued with `workflow steer` that nobody acted on |

The compact summary adds `options`:

| Option | When | Command it names |
|---|---|---|
| `continue` | program-mode run whose plan needs a fix, a new step, or a redo | `workflow plan export` then `plan revise` |
| `retry` | at least one unfinished step is retryable | `workflow resume` (with `retryAfter` when every retry waits on a paused pool) |
| `takeOver` | always offered when handback exists | do the unfinished work yourself; the full envelope names every `outputFile` |
| `restart` | the goal or the approach was wrong | a new `workflow goal --program` |

`retry` is omitted when nothing is retryable. `workflow resume` on a finished run with nothing retryable prints `nothing to retry`, starts nothing, and exits 1.

## Launch versus result

`workflow goal --json` without `--foreground` prints a launch document (`schemaVersion: "bullswarm.goal.launcher.v2"`), not a result. It includes an `instructions` handoff with four named paths: `agentInspect`, `watch`, `humanTui`, and `result`. Use `--watch` when the initiating terminal should follow progress; otherwise the command returns after printing that handoff.

A dead kernel with no terminal state is diagnosable: `workflow watch`, `runs show`, and the TUI print the last 20 lines of `~/.bullswarm/goals/<runId>/stderr.log`.

Legacy authored-graph runs are listed as `legacy` rows. Driving commands, including `runs result`, print `legacy authored-graph run <shortId>: its executor was removed in 0.27.0; files remain under <dir>` and exit 2.

## Next steps

- [CLI reference](/reference/cli) — `run` and `workflow runs result` flags
- [Observing](/guide/observing) — watch, TUI, and the status loop
- [Workflow program](/reference/program) — the graph whose outcomes this envelope reports
