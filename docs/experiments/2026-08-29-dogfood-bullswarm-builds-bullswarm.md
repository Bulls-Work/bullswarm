# Dogfood 2026-08-29 — bullswarm builds bullswarm (outputSchema + planner refactor)

Observation log of the two dogfood runs that produced 0.14.0, kept verbatim
from the driving session's notes; the post-run defects below produced 0.14.1.


Goal file: `goal4.txt` (7 deliverables, single-implementer constraint). Repo branch: `feat/output-schema`.
Runtime: local worktree `bullswarm-rt` pinned at main (user: redispatch with local runtime, keep committing; no npm wait).
Home: default `~/.bullswarm` (heterogeneous pools) — user can `bullswarm workflow tui <shortId>`.

## Attempt 1 — 01:43:37 Z, installed 0.13.1 — failed at validation, nothing ran
`autonomous workflow invalid (nothing ran): phases[0].steps[0](scout): template ref "{{outputs.x.data.field}}" cannot resolve`.
Cause: goal text spliced into the scout prompt; validator parsed a quoted ref in user text.
Fix (bullswarm defect #1): goal → declared `inputs.goal`, inserted at render time; unresolved grammar-valid refs are
left literal + `template.unresolved_ref` event instead of fatal. Commit `7badea3`, released 0.13.2 (`a0f0965`).
Verified: scout task file of attempt 3 contains `{{outputs.x.data.field}}` verbatim; only `{{inputs.goal}}` resolved.

## Attempt 2 — 01:47:37 Z — launcher bug (mine, not bullswarm): zsh does not word-split `$BS="node path"`. Fixed script.

## Attempt 3 — 01:48:19 Z, runtime 0.13.2 @ a0f0965 — run `wf-mtdq1l9v-ed22fe` / `75t4n2`
- 01:48:22 scout → pool `opencode2` model `relay/gpt-5.6-luna`. Routing: "most-behind capable pool (surplus 0)";
  candidates opencode2 pace 0 (unmetered) > grok −7.5 > claude-code −9.4 > codex −49.1.
  Observation: an unmetered pool reads as exactly on pace (0) and therefore outranks every metered pool that is
  ahead of pace. Not a crash, but quota-unknown pools capture all work whenever metered pools are burning ahead.
- 01:48:22 → 01:49:54 scout ok (92 s, opencode2).
- 01:50:06 → 02:00:40 planner turn 1 (**~634 s** — roughly 2× the goal-2/3 turns; goal text is 6.5 k chars and the
  program is 12 actions). Decision: `needs_more_work`, 12 actions, `completion: all-actions-ok` attached.
  Program honours the single-implementer constraint: `impl-src` (all src) ∥ `docs`; `tests-schema`/`tests-adaptive`/
  `tests-gaps` + `verify-impl(repair 2)` fan out after impl-src; per-writer verifies with repair; `final-report` →
  `verify-suite(repair 2)`. Note: `verify-impl`'s repair may edit src while the test writers read it — accepted risk,
  `verify-suite` runs the whole suite at the end.
- 02:00:31 `impl-src` and `docs` → opencode2 `relay/gpt-5.6-luna` (medium effort, "most-behind capable pool (surplus 0)").
  All build work lands on the unmetered pool while claude-code/grok/codex are ahead of pace. Orchestrator stayed on
  claude-code (pinned).
- 02:00:31 → 02:07:09 `impl-src` ok (398 s, opencode2); `docs` ok (140 s). 02:07:11 five actions started at once
  (3 test writers + verify-impl + verify-docs).
- 02:08:20 `verify-impl` ok:false → `verify-impl-repair-1` (concerns were concrete and correct: schema JSON omitted from
  the retry task text; fan-out item resume skipped schemaOk; no combined run+fanout skeleton). 02:08:36 `verify-docs`
  ok:false → `verify-docs-repair-1` (doc claimed fan-out persists top-level data/schemaOk; doc claimed static validator
  rejects outputSchema on verify but only decision.js did). Repairs 121 s / 124 s. Both are repair-loop live uses; if the
  program then self-completes this is the first live exercise of the 0.13.1 fix path.
- 02:12 → 02:18 second round of repairs: `verify-impl-repair-2` (escalation could allow a 2nd schema retry — legit design
  nit; "schema.js untracked so absent from git diff --stat" — verifier misreading), `verify-adaptive-tests-repair-1/2`
  (rejected twice for the same reason: "diff is not purely additive: modifies an existing assertion" — the
  programFeatures assertion HAD to change; an unrepairable process criterion). Both verifies ended ok:false after
  maxRounds → `final-report`/`verify-suite` blocked (`failed_terminal: dynamic actions blocked by failed or unresolved
  dependencies`) → program boundary → planner turn 2 at 02:18:52.
  Observation (behaviour): a verifier that judges process criteria ("purely additive", "untracked file") instead of the
  goal's acceptance checks produces rejections no repair can satisfy; two repair rounds (~10 min) were spent before the
  boundary. Candidate for the prompt audit: verify doctrine "ok:false only for failed acceptance checks; process
  observations are concerns" and/or runtime: identical concerns after a repair → boundary immediately.
- 02:18:52 → ~02:25:20 planner turn 2 (~390 s): `needs_more_work`, 3 sequential actions — `recheck-src` (verify, repair 2,
  depends on verify-impl-repair-2) → `full-suite-report` (run) → `verify-final` (verify, repair 2). Reason correctly
  notes no whole-suite evidence existed after the repairs (impl-src's npm test predated them).
- 02:25:52 → 02:32:36 follow-up program: `recheck-src` ok:false → `recheck-src-repair-1` → re-verify ok; `full-suite-report`
  ok; `verify-final` ok → **`decision.auto_completed` (program-completion)** at 02:32:39.
## Result (attempt 3)
- Wall **44 min 17 s** (2 654 s), 28 dispatches (26 opencode2 + 2 planner on claude-code), max concurrent 5,
  parallelism 1.5, planner 2 turns / 1 045 s (39 % — turn 1 alone 637 s), repairs 6 (2 repaired ok, 4 re-verify
  rejected), tokens ≈ 108 k (estimate).
- Deliverable: 10 files changed + 2 new (489+/38−); `npm test` **318/318** (299 + 19) on my own run; validator module,
  decision/validate/runtime/runner/template changes all present; docs + changelog written.
- My review: sound; one robustness flaw fixed by hand — `readTrailingObject` used a reverse brace/quote scanner whose
  escape handling is wrong scanning backwards (a `\"` inside a string could derail it and waste the single retry);
  replaced with the parse-candidates approach `hasStructuredAnswer` already uses. Double failure now reports the
  retry's errors. Escalation concern from verify-impl judged mistaken (escalation follows failed dispatches only).
- 0.13.1 fix path: NOT exercised here either — the latest worker at completion was `full-suite-report`, verified by a
  direct edge (`verify-final`).
## Adversarial review via `bullswarm run --lane analyze` (02:36 → 02:39 Z, 206 s, opencode2 relay/gpt-5.6-luna)
- Verdict "do not release" with **two confirmed, reproduced defects** — both in code I had reviewed and passed:
  (1) my rewritten `readTrailingObject` returned the first schema-valid `{…}` from the right, so a nested object
  could be recorded (`{"wrapper":{"ok":"inner"}}` → data `{"ok":"inner"}`); (2) `schema.js` used `in`, so
  `toString`/`constructor`/`__proto__` counted as present/declared. Cleared: escaped quotes, fenced JSON, resume rules,
  exactly-one retry, validator paths. Fixed + regression tests (320/320); my fix also had an infinite loop when output
  starts with `{` (lastIndexOf clamps negative fromIndex) — caught by the suite hanging, fixed.
- Evidence for open item "adversarial verification by default": a 3-minute refute-framed review found what the
  run's own verifies (6 rounds) and my manual review both missed.
## Goal 5 — planner context/contract refactor — run `wf-mtds7tzx-95ab05` / `ejk9w2`, 02:49:09 Z, runtime 0.13.2 local
- scout 72 s (opencode2); planner turn 1 02:50:55 → 02:58:56 (~480 s): 6 actions, completion attached; noticed the goal's
  stale "318 passing" and used the real 320. Program: impl-src → verify-src(repair 2) → update-tests ∥ update-docs →
  verify-tests(repair 2) → verify-suite(repair 1).
- 02:58:56 → 03:09:04 impl-src (~610 s). verify-src rejected twice, both times on SUBSTANTIVE spec points (obsolete
  skeleton text left in a comment; 6 JSON examples instead of 2; `<item>` instead of `{{item}}` in examples; excerpt
  policy). One misread to check in the final diff: it called the existing 3 000/36 000-char excerpt caps a violation of
  "full excerpt" although the goal said "(existing budget logic)" — the repair may have removed the caps.
  Ordering tension: verify-src runs before update-tests, so it necessarily sees 5 failing old assertions; the planner
  should either fold assertion updates into impl-src or make verify-src judge src only.
- Goal 5 finished 04:00:40 Z (71.5 min, 3 planner turns + program-completion, 15 dispatches, plannerSec 1 105+175).
  Where the time went: 18–20 min planner turns; 12.4 min verify-src repair loop enforcing my over-exacting spec and
  judging intermediate state; ~8 min decision-3 nit round (`align-prefix-number` + `confirm-docs`) triggered by an
  UNPARSEABLE final-check verdict; the queued steer (03:57:32, "converge now") was NEVER delivered — 0 steering.delivered events; the run auto-completed (program-completion, 04:00:40) and deliverSteering only runs at planner gates, so auto-completion silently discards pending operator steering. Known issue; convergence came from the runtime, not the steer.
  Deliverable reviewed + committed `15f1534`: 10-rule contract (2.2 k chars) + 2 examples (1.9 k) replace 16.3 k prefix;
  compact ledger rows; id-only failures; 200-char stale excerpts; `decision.context_built` size event; 323/323.
- My follow-up (commit after 15f1534): verify verdict parse failure → ONE bounded re-ask (`verify.verdict_retry`,
  test with a garbled-once verifier, 324/324); contract amendments (verify scoping, converge-not-polish, restored
  shared-tree/redundant-verification/operatorSteering lines the merge dropped); re-budgeted "full" excerpts (the
  uncapped version could have rebuilt the 163 k contexts).
- Speed answer to the user: ~35 of 66 min (at question time) was real work; fixes target the rest — re-ask (−8 min),
  verify scoping (−12 min), convergence rule (−nit rounds). Remaining lever: planner turn latency itself (Opus
  high-effort per boundary; context compaction cuts cost ~7×, latency is model thinking time).

## Post-run defects → 0.14.1 (fixed directly, dogfooding paused by user direction)
- `workflow tui` crashed twice (`detailRow` dashboard.js:809 `JSON.parse` of
  state.json mid-write; the throw escaped the repaint timer and killed the TUI,
  stranding the terminal in alt-screen raw mode). Fix: atomic temp+rename
  writes for state/report/workflow.json + torn-read-tolerant observation
  readers + guarded paint/key handlers with last-good-frame fallback.
- TUI showed phase ✗ "2/2 complete" while a re-verify attempt was live. Fix:
  an action with an active agent reads as running; phase precedence
  active > failed > completed.
- The goal-5 steer was never delivered: auto-completion bypassed the planner
  gate and silently discarded pending steering (0 steering.delivered events).
  Fix: pending steering defers self-completion to the planner
  (`decision.completion_deferred`); undeliverable steering is marked
  `expired_undelivered` (`steering.expired`) at the terminal transition.
- Routing concentration on the unmetered pool (26/28 dispatches) confirmed as
  design intent (quota protection outranks diversity) and documented in the
  skill rather than changed.

## Proof run 1 — goal-3 re-run `d8pr8s` (wf-mtdvuk9m), 0.14.1-pre @ 0bbe78c
Baseline (0.13.1, same fixture/goal/pool/flags): 28m42s wall, 1 planner turn, 294 s planner.
- **completed + verified, deliverable exactly right** (csv+slugify guarded, existing tests byte-identical, 63/63),
  zero crashes, 8 workers, no repairs.
- Wall **32m19s**, planner **5 dispatches / 463 s** (195+114+58+66+30). Per-turn latency DOWN (max 195 s vs 294 s);
  context per turn 6.2k–48k chars (`decision.context_built` measuring itself) vs the old 16.3k prefix + up-to-178k contexts.
- The 3 extra gates, each diagnosed and fixed in `c0ff947`:
  1. first proposal rejected — verify with several dependsOn lacked `review` → contract rule 4 now states it;
  2. evidence-policy boundary + rejected `complete` — final-report left as last unverified worker → rule 8 now
     states the LAST worker must be covered by a verify;
  3. one deliberate operator steer — which **live-proved the 0.14.1 steering fix**: `decision.completion_deferred`
     → `steering.delivered` (first ever observed; the goal-5 defect showed 0) → planner turn honoured it.
- Also observed and fixed: a corrective turn re-inflated validationFeedback to 24k chars (raw response duplicated
  the parsed proposal) → excerpt capped at 2k.
- 0.13.1 completion-evidence policy exercised live for the first time: it refused auto-completion twice, correctly.

## Proof run 2 — goal-3 re-run `djnjka` (wf-mtdx5htt), 0.14.1-pre @ c0ff947 — interrupted, then cancelled
- Turn-1 proposal **accepted first try** (no validation rejection, no correction turn): contract fix #1 confirmed.
  Turn-1 context 6,201 chars.
- At 05:21 the driving session's background task was killed by the harness (not the user); SIGTERM reached the
  runner, which persisted `interrupted` + resumable (1/3 steps, in-flight `triage` cancelled) — the 0.13 interruption
  path working as designed.
- Resume at 05:54 exposed a **resume defect**: the cancelled `triage` was persisted `ok:false` ("workflow
  cancellation requested"), so its 4 dependents were marked "blocked by failed or unresolved dependencies" and the
  planner was asked to re-plan around a failure that never happened. Cancelled the run; fixed in `459c58c`
  (cancelled actions + dependents blocked only by them are reopened on resume, event `action.reopened`; regression
  test drives a cancel marker into a slow in-flight action and asserts exactly one further planner turn).

## Proof run 3 — goal-3 re-run `4t6m5a` (wf-mtdyyqkw), 0.14.1-pre @ 459c58c — cancelled after diagnosis
- Turn-1 proposal (9 actions, sound shape: 3 disjoint impl workers ∥ audit of untouched modules → per-module
  verifies → final-report → verify-final, completion attached) was **rejected** for one field: a zero-dependsOn
  audit verify carried no `review`. Correction turn cost ~5 min and re-inflated context to 47.8k chars
  (validationFeedback 38k — the 2k cap on rejectedResponseExcerpt was insufficient because rejectedProposal
  itself is 37k). Root cause is the validator's posture, not the planner: rejecting a whole program for a field the
  runtime can default. Fixed in `548eabe`: review defaults to the single/last dependency's artifact, or
  `reviewScope: repository` for a no-dependency audit; contract rule 4 reworded. Run cancelled to re-prove cleanly.

## Proof run 4 — goal-3 re-run `d7xyg2` (wf-mtdzhw88), 0.14.1-pre @ 548eabe — **PASS**
| metric | 0.13.1 baseline (x3x2a2-era, same fixture) | 0.14.1-pre run 4 |
| --- | ---: | ---: |
| outcome | completed, verified | completed, verified, **auto-completed** (program-completion) |
| wall | 28 min 42 s | 30 min 12 s |
| planner turns / plannerSec | 1 / 294 s | **1 / 269 s** |
| planner context (turn 1) | 32.7 k chars (measured on a sibling run) | **6.2 k chars** |
| dispatches (workers) | — | 8 (7) · max concurrent 9 |
| corrections / rejections / repairs / verdict re-asks | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| deliverable | csv + slugify guarded, 63/63 | csv + slugify guarded, **63/63**, existing test files byte-identical |
Program: scout → probe (all exports, wrong-type matrix) → fanout guards over the discovered modules → verify-guards →
report → verify-final, `completion: all-actions-ok`. Wall is within noise of baseline (+90 s, dominated by worker
model time: probe 4.7 min, guards 5.1 min, verify-guards 4.7 min); the planner side is faster and 5× smaller.
Zero observation crashes across four runs of TUI/watch/runs/result/static-tui polling and a 20 s stress loop
(1,681 paints against the live writer, 0 torn, 0 throws).

## Goal-4 rerun on 0.15.0 — `ydpjts` (wf-mte8azjz-bcb079), 10:19:31 → 11:31:48 Z — reliability PASS, speed FAIL

Same goal text (`goal4.txt`), same flags (`--orchestrator claude-code --concurrency 8 --max-agents 40
--max-expansion-rounds 8`), fresh fixture `g4-bs-v2` = `git archive a0f0965` (v0.13.2, 299/299, no `schema.js`) on
branch `feat/output-schema`, default `~/.bullswarm` home, runtime `bullswarm-rt` @ 728231d (v0.15.0).

| metric | attempt 3 (0.13.2) | **rerun (0.15.0)** |
| --- | ---: | ---: |
| outcome | auto-completed after planner turn 2 | **auto-completed** after a 2-action recovery program |
| wall | 44 min 17 s | **72 min 14 s** (4 334 s) |
| planner turns / plannerSec | 2 / 1 045 s (39 %; turn 1 = 634 s) | **2 / 755 s (17 %)** — 476 s + 279 s; completion recorded by the runtime |
| planner context (turn 1 / turn 2) | — | 12.9 k / 41.5 k chars (`decision.context_built`) |
| dispatches | 28 (26 opencode2 + 2 planner) | **13** — 2 planner (opus-5) + 11 workers (sonnet-5), all on `claude-code` |
| max concurrent / parallelism | 5 / 1.5 | **2 / 1.05** |
| repairs | 6 (4 unrepairable: process-criteria rejections) | **0** — every verify ok:true first round |
| corrections / rejections / verdict re-asks | 0 / 0 / — | 0 / 0 / 0 |
| schema retries | — | 1 (`report`; both attempts failed, see below) |
| tests after | 318/318 (299 + 19) | **326/326** (299 + 27); existing test files extended only (+281 / −0); no commit; version untouched |

Program (turn 1, 476 s): `impl-src` ∥ `docs` → `verify-src`(repair 2) / `verify-docs`(repair 1) → `tests` →
`verify-tests`(repair 2) → `report`(outputSchema) → `verify-report`(repair 1, `review` defaulted), `completion`
attached. Three verifies omitted `review` and were accepted (0.14.1 defaulting) — the same omission cost a 5-minute
correction turn on proof runs 1 and 3. Rule 8 honoured (last worker covered by a verify).

Verifier behaviour is what 0.14.x was meant to produce: `verify-src` passed with a disclosed deviation
(`programFeatures` literal not extended because `tests/workflow-adaptive.test.js:206` regex-locks it and the goal
forbids modifying existing assertions) instead of rejecting on a process criterion; `verify-tests` flagged the filler
prose workaround as a concern, not a failure.

**The one failure and its cost (≈ 11.4 min):** `report` carried an `outputSchema`. Attempt 1 ended with an object
carrying a stray `"type"` key copied from the schema (`additionalProperties:false` → `type is not allowed`, correct).
The single retry ended `}\n\`\`\`` — a closing markdown fence — and `readTrailingObject` refused it as "did not end
with a JSON object" → `report` ok:false → `verify-report` blocked → `decision.completion_predicate_unmet` → planner
turn 2 (279 s), which diagnosed it correctly and re-delivered the report without a schema. Fixed in `393a914`:
trailing fences are stripped before the object is read, and the instruction says the object is an INSTANCE whose keys
are the `properties` names. Unit-tested; not yet exercised live.

**Where the 72 minutes went — the run was serial (parallelism 1.05):** scout 405 s → planner 476 s → `impl-src`
**1 231 s** → `verify-src` 330 s → `tests` **951 s** → `verify-tests` 116 s → `report` 141 + 123 s → planner 279 s →
`final-summary` 174 s → `verify-final-summary` 109 s. Two causes, neither a crash:
1. Routing put every worker on `claude-code`/`claude-sonnet-5` because it was the most-behind capable pool
   (pace +6.9 vs opencode2 0, `claude-code:wati` −14.8). The same `impl-src` took 398 s on `opencode2`
   (`relay/gpt-5.6-luna`) in attempt 3; the read-only scout took 405 s vs 92 s. Worker model speed is not part of the
   surplus formula.
2. The planner proposed ONE `tests` worker after `verify-src` instead of three file-disjoint test writers in parallel
   with the src verify (attempt 3's shape). Reliability-first, width-second: correct under the goal's single-implementer
   constraint, but it lengthened the critical path by ~16 min.

Pass conditions set before the run: ≤ 1 repair round ✓ (0); 0 process-criteria rejections ✓; auto-completed ✓;
≤ 35 min ✗ (72 min). Reliability at 12-action complexity is now proven on ≥ 0.14.1; speed is worker-bound and
routing-bound.

## Goal-4 rerun on the audited contract — `r2vu9i` (wf-mtefmdie-b39e8f), 13:44:19 → 14:21:21 Z — **structural PASS, 36 min 58 s**

Runtime `d14c1fa` (contract from the second audit, §6 of `docs/planner-prompt-audit-2026-08-29.md`, plus the runner
lane fix); workers pinned to `opencode2`/`relay/gpt-5.6-luna` via `strategy assign high|medium|low` (cleared after);
orchestrator `claude-code`/`claude-opus-5`; fresh fixture `g4-bs-v3` = a0f0965 (299/299).

| metric | attempt 3 (0.13.2) | `ydpjts` (0.15.0) | **`r2vu9i` (audited contract)** |
| --- | ---: | ---: | ---: |
| wall | 44 min 17 s | 72 min 14 s | **36 min 58 s** (2 219 s) |
| planner turns / plannerSec | 2 / 1 045 s (39 %) | 2 / 755 s (17 %) | 2 / 648 s (29 %) — 409 s + 238 s |
| dispatches | 28 | 13 | 26 (24 gpt-5.6-luna workers + 2 opus planner) |
| max concurrent / parallelism | 5 / 1.5 | 2 / 1.05 | **4 / 1.55** |
| writers in parallel after planning | 2 (+3 test writers later) | 2 | **5** (impl-src ∥ 3 docs; 2 test writers as soon as impl-src landed) |
| repairs (rounds / repaired ok / re-verify rejected) | 6 / 2 / 4 | 0 | 4 / 2 / 2 |
| schema retries / corrections / verdict re-asks | — / 0 / — | 1 / 0 / 0 | **0 / 0 / 0** |
| tests after | 318 | 326 | **314/314** (299 + 15); existing tests +167 / −1 (one assertion extended, as goal item 5 requires); no commit; version untouched |

Structural pass conditions (set before launch): `tests-*` depend on `impl-src`, not `verify-src` ✓ (the planner's own
reason: "two file-disjoint test workers depend on that run (not its verify)"); more than one file-disjoint writer ✓ (5);
parallelism ≥ 1.5 ✓ (1.55); 0 corrections ✓; 0 schema retries ✓ (the report carried no schema); auto-completed ✓;
≥ 299 tests, existing tests extended only ✓. Failed: 0 repairs ✗ (4 rounds). Lane/effort proposed by the planner reached
dispatch (`docs-changelog` routed `chore`/`low`) — the runner merge fix is live. `accept-suite` was a verify with no
dependsOn — the first live exercise of the repository-scope branch.

Where the four repair rounds went, and what each says:
- `verify-tests-schema` round 1: missing invalid-`minimum` case → repaired, re-verify ok. Legitimate; cost 49 + 30 s.
- `verify-src` round 1: a real defect (`recordOutput` dropped `data`/`schemaOk`, breaking resume-safety) → repaired.
  Legitimate. Round 2 then rejected on two concerns round 1 never raised (enum structural equality, root-path naming)
  → repaired, re-verify ok. **Moving goalposts**: 92 + 268 s spent on nits that should have been round-1 concerns.
- `verify-tests-runtime` round 1: acceptance command failed on the pre-existing `workflow-adaptive.test.js:206`
  assertion (goal item 5 requires extending it) → the repair extended it → round 2 rejected BECAUSE an existing test
  was modified — a process criterion the planner had written into the verify prompt ("append tests only") that
  contradicts the goal. Unrepairable by construction → `verify-suite`/report blocked → planner turn 2 (238 s), which
  diagnosed "a false rejection" and recovered in 207 s. Cost ≈ 10 min.
Fix shipped after the run (`9af8fdf`, unit-tested, not yet live): a re-verify receives the concerns it raised and the
repair's report and may reject only for an unresolved listed concern or a regression — both round-2 rejections above
become informational under it.

Speed accounting vs `ydpjts`: worker pool (gpt-5.6-luna vs sonnet-5) and width together took the critical path from
72 to ~27 min of productive work; the remaining ~10 min is the verifier-behaviour waste above.

## Goal-4 rerun with the re-verify fix — `bizp4s` (wf-mtehhbwd-7db3de), 14:36:26 → 15:01:39 Z — **PASS, 25 min 13 s**

Runtime `9af8fdf` (audited contract + runner lane fix + re-verify scoping); workers pinned to
`opencode2`/`relay/gpt-5.6-luna` via `strategy assign high|medium|low` (cleared after, assignments `{}`); orchestrator
`claude-code`/`claude-opus-5`; fresh fixture `g4-bs-v4` = a0f0965 (299/299, cloned clean from the v3 fixture commit).

| metric | attempt 3 (0.13.2) | `ydpjts` (0.15.0) | `r2vu9i` (audited contract) | **`bizp4s` (+ re-verify fix)** |
| --- | ---: | ---: | ---: | ---: |
| wall | 44 min 17 s | 72 min 14 s | 36 min 58 s | **25 min 13 s** (1 513 s) |
| planner turns / plannerSec | 2 / 1 045 s (39 %) | 2 / 755 s (17 %) | 2 / 648 s (29 %) | **1 / 247 s (16 %)** |
| dispatches | 28 | 13 | 26 | 23 (22 gpt-5.6-luna + 1 opus planner) |
| max concurrent / parallelism | 5 / 1.5 | 2 / 1.05 | 4 / 1.55 | **4 / 1.77** |
| writers in parallel after planning | 2 (+3) | 2 | 5 | 4 (impl-src ∥ 3 docs), then 2 test writers ∥ verify-src the moment impl-src landed |
| repairs (rounds / repaired ok / re-verify rejected) | 6 / 2 / 4 | 0 | 4 / 2 / 2 | 3 / 2 / 1 — every rejection a real defect |
| schema retries / corrections / verdict re-asks | — / 0 / — | 1 / 0 / 0 | 0 / 0 / 0 | **0 / 0 / 0** |
| tests after | 318 | 326 | 314/314 | **319/319** (299 + 20); existing tests +174 / −0; no commit; version untouched |

Program (one decision, 15 actions + completion): `impl-src`(build/high) ∥ `doc-changelog`(chore/low) ∥
`doc-skill`(chore/low) ∥ `doc-mechanics`(chore/medium), each doc with its own analyze/low verify; `test-schema`
(build/medium), `test-runtime`(build/high) and `verify-src`(analyze/high) all `dependsOn: ["impl-src"]`; `verify-suite`
(analyze/low) on the six unit verifies; `report`(chore/low, no schema) → `verify-report`(analyze/medium);
`completion: all-actions-ok`. Every planner-set effort tier reached dispatch (`configured <tier> assignment`).
`decision.auto_completed` — the planner was consulted exactly once.

The three repair rounds, and why none is verifier waste:
- `verify-src` round 1 (ok:false): `validateWorkflow` did not check `stepTemplate.outputSchema` and the runtime ignored it
  during fan-out — the fan-out half of the goal was unimplemented. Repair 197 s.
- `verify-src` re-verify round 1 (ok:false, `action.reverify_rejected`): the repair's schema-retry path handed dispatch a
  file name that dispatch re-suffixed `-attempt-2`, so the runtime read a nonexistent file (`ENOENT`; 3 focused tests
  failing). A regression in the acceptance checks — exactly the rejection the new scoping still allows. The task text
  carried `RE-VERIFY round 1 of 2 … Concerns you raised (verbatim):` with round 1's concerns, and the verdict's summary
  opens "The two original fan-out concerns are repaired" — the verifier judged the repair, as instructed. Repair 177 s;
  round 2 re-verify ok (52/52 focused).
- `verify-test-schema` round 1 (ok:false): no invalid-value case per supported keyword. Repair 63 s, re-verify ok.
- `verify-test-runtime` accepted first time: the goal's item-5 assertion was satisfied without touching an existing test
  (+174 / −0), so the "append only" tension of `r2vu9i` never arose.

Pass conditions (set before `r2vu9i`): tests depend on `impl-src` ✓; > 1 file-disjoint writer ✓ (4, then 2 more);
parallelism ≥ 1.5 ✓ (1.77); 0 corrections ✓; 0 schema retries ✓; auto-completed ✓; ≥ 299 tests, existing tests only
extended ✓. "0 repairs" ✗ as a literal count (3), but the condition's intent — no repair round that a verifier caused —
is met: each round fixed a defect the deliverable needed fixed. Prediction before launch was "the two moving-goalpost
rounds and the 10-min recovery turn vanish, wall ≈ 30 min"; observed 25 min 13 s with one planner turn.

Cost: 22 of 23 dispatches on the unmetered opencode2 seat; Claude quota spent on one 247 s planner turn.

## Goal-4 rerun on v0.16.0 (phase = stage) — `euh622` (wf-mtej85ws-18a3c0), 15:25:14 → 16:01:14 Z — **36 min 00 s, auto-completed; one planner-authored false rejection cost the recovery turn**

Runtime `4bfd7f4` = released v0.16.0 (rule 3 "a phase is a pipeline stage … never one per action"); workers pinned to
`opencode2`/`relay/gpt-5.6-luna` (cleared after); orchestrator `claude-code`/`claude-opus-5`; fresh fixture `g4-bs-v5`.

| metric | `r2vu9i` | `bizp4s` | **`euh622`** |
| --- | ---: | ---: | ---: |
| wall | 36 min 58 s | 25 min 13 s | 36 min 00 s (2 157 s) |
| planner turns / plannerSec | 2 / 648 s | 1 / 247 s | 2 / 728 s (34 %) — 462 s + 266 s |
| dispatches | 26 | 23 | 24 (22 luna + 2 opus) |
| max concurrent / parallelism | 4 / 1.55 | 4 / 1.77 | 4 / 1.5 |
| phases in the TUI | 19 one-action rows | 16 one-action rows | **4 stages** (implement 2, tests 3, verify 6 + repairs, report 2) + 2 recovery phases |
| repairs (rounds / repaired ok / re-verify rejected) | 4 / 2 / 2 | 3 / 2 / 1 | 4 / 2 / 2 |
| tests after | 314 | 319 | **319/319**; existing tests +116/−1 (the mandated `:206` extension) and +153/−0 |

What the phase change did: the planner wrote `implement` (impl ∥ docs), `tests` (three test writers), `verify` (six
verifies), `report` — the layout asked for, with no scheduling change (impl ∥ docs started together; three test writers
and verify-impl started the second impl landed; verify-docs ran while impl was still running). Width was one docs
worker (three files merged; off the critical path) but three test writers — comparable to `bizp4s`.

The four repair rounds:
- `verify-impl` r1: fan-out items dispatched through plain `dispatch()`, so `stepTemplate.outputSchema` was never applied
  — real. Re-verify rejected: the repair tested `step.outputSchema` instead of `itemStep.outputSchema` — the listed
  concern still unresolved, exactly the rejection the re-verify rule permits. r2 repaired; re-verify ok.
- `verify-test-runtime` r1: the retry case did not assert the `errors` payload of `action.output_schema_retry` — real.
- `verify-test-refs` r1: the acceptance command failed on the pre-existing assertion at `workflow-adaptive.test.js:206`
  (`programFeatures` pinned to three entries) because goal item 5 mandates adding `outputSchema` to it. The repair
  extended the assertion (+116/−1). Re-verify rejected BECAUSE an existing assertion changed — the planner had written
  "EXTEND BY APPENDING new test cases only" into `test-refs` and "shows APPENDED cases only" into `verify-test-refs`,
  and "Do NOT modify existing tests" into `impl`, while the goal says "do NOT modify existing tests except to extend
  them". No worker owned the assertion; the verifier treated its prompt's rule as an unresolved concern. `verify-suite`,
  `report`, `verify-report` blocked → planner turn 2 (266 s), whose reason is exact: "verify-test-refs ended ok:false
  on an append-only rule that the goal itself makes unsatisfiable — goal item 5 mandates adding 'outputSchema' to
  programFeatures". Recovery program `verify-suite-full` → `final-report` → `verify-final-report`, auto-completed.
  Third occurrence of this shape (attempt 3, `r2vu9i`, here); `bizp4s` avoided it only because its implementation
  happened to keep the old assertion true.

Cost of the false rejection: the 266 s planner turn plus the serialised tail ≈ 5–6 min; the rest of the gap to
`bizp4s` is variance (planner turn 1 462 s vs 247 s on the same contract; `impl` 445 s vs 377 s).

Fix committed after the run, unreleased (`71960ae`): rule 7 — "A verify checks the goal's own acceptance criteria …
never add a process rule the goal does not state (append-only, tests untouched); when the implementation changes what
an existing assertion pins, a worker must own updating it." Proof pending a rerun on that commit.

## Run `8ebi8a` — runtime `7724da1` (rule 7 `71960ae` + PR #5 merge), luna pinned, fixture g4-bs-v6

Launched 2026-08-29 16:42 Z as the live proof of rule 7. Result: **42 min 03 s**, worse than `euh622` (36 min) and
`bizp4s` (25 min). Measured (`bs-g4-v6-metrics.json`): 3 planner turns / 775 s (31 % of wall; turn 2 430 s, correction
turn 97 s, turn 1 ≈ 248 s derived), parallelism 1.34, max 3 concurrent, 23 dispatches (20 workers on
`relay/gpt-5.6-luna`, 3 planner turns on claude-code/opus), 3 repair rounds — every re-verify rejected — 1 validator
correction, auto-completed by `program-completion`, `npm test` 315/315, existing tests +179/−1 (the mandated `:206`
extension, finally done by a named action `fix-pinned-test`).

The three rejections were each legitimate under the re-verify rule of `9af8fdf`; the defect was in the prompts the
planner wrote, and rule 7 did not stop it:
- `verify-impl` r1: real concern. Repair 1 removed `outputSchema` from `programFeatures` so the OLD assertion at
  `workflow-adaptive.test.js:206` would pass — because `impl` was told "do NOT modify existing tests", `tests-runtime`
  (owner of that file) was never told to extend `:206`, and `verify-impl` expected `impl` to have done it. Re-verify
  rejected (a regression: item 5 mandates the entry). r2 re-added it; the old assertion failed again; rejected.
  Turn 2's reason names it: "my round-1 prompt asked for it". Nobody owned the assertion — the fourth run with this gap.
- `verify-docs` r1: its prompt said "only those three doc files were changed by this worker (`git diff --stat`)"; the
  repo-wide diff showed `impl`'s files, so it rejected on scope. The repair, told "Do not touch src/", still reverted
  five `src/` files to make `git diff --name-only` show three files (its report: "git diff --name-only reports exactly
  the three requested documentation files… 299 tests"). Re-verify rejected on the missing implementation.
- Tail blocked: `verify-tests-schema`, `verify-tests-runtime`, `verify-suite`, `report`, `verify-report` depended on
  `verify-impl` (a verdict, chosen so repairs would not edit the same files) → `failed_terminal` → planner turn 2,
  which re-proposed the blocked id `verify-suite` → validator rejection → 97 s correction → recovery program
  `restore-src` → `fix-pinned-test` → `verify-src` / `verify-tests` → `verify-full-suite` → `final-report` →
  `verify-final-report`, all ok.

Where the extra time went (vs `bizp4s`): ≈ 17 min in the two failed verify loops, the blocked tail, turn 2 and the
correction; `impl` 493 s vs 377 s is variance.

Conclusion and fix (unreleased, committed after the run): three runs in a row failed on a different planner-authored
constraint the goal never stated (append-only → contradictory ownership → repo-wide scope check), so contract text
alone is whack-a-mole. The runtime now owns the bar: every verify/re-verify instruction ends with a fixed acceptance
standard (ok:false = unusable; everything else is a concern under ok:true; other actions' files are never this unit's
defect), every repair prompt says to edit only the reviewed work's files and never revert others' changes, rule 2
requires one owner per file including an existing test the change breaks, and the validator line states run-wide id
uniqueness. Direction from the user: "unless it is completely nonsense or unable to finish I don't see a reason to
reject so easily". Claim to test on the next rerun: none of the three `8ebi8a` rejection reasons can produce ok:false.

## Run `5cvj72` — bullswarm 0.20.0 builds bullswarm's next release (2026-08-31, real repo, installed runtime)

Goal: (R1) remove the hardcoded `relay/gpt-5.6-luna` from `connectors/opencode2.json` while keeping Relay per-provider
model injection, (R2) LLM-refined delegation classification on top of the deterministic guess, (R3) docs, (R4) full
suite green. Launched through `bullswarm delegate` itself (dry-run preview → executed pinned `--mode=workflow`).

Result: **13 min 58 s** (838 s), 1 planner turn (73 s, 8.7 %), 12 dispatches, parallelism 1.69, max 3 concurrent,
9-action program (3 implementers ∥ → 3 unit verifies covering R1–R3 → suite verify covering R1–R4), auto-completed
`completed_with_concerns` (1 informational concern), 388/388 tests — verified independently by the operator.

Reliability events, all self-healed: `update-documentation` on claude-code/sonnet-5 failed the output substance gate
("announcement without substance") → escalated to codex/gpt-5.6-terra, succeeded. `verify-classifier` rejected once —
legitimately under the lenient bar (R2 demanded BOTH reasons in the decision; `refineDecision()` dropped the
deterministic one; the focused tests themselves passed 18/18) — one repair round fixed it, re-verify accepted. The
coverage-evidence flip fired only alongside that real concern; no false rejection this run.

Routing: soft `preferredConcurrency:1` spillover worked as designed — 9/12 dispatches on `opencode2 relay-2/gpt-5.6-luna`
(the all-tier assignment), while parallel siblings spilled to claude-code (fable-5 for `implement-classifier`,
sonnet-5 for the failed docs attempt) and codex (terra). Note: the per-pool assignment pins the model only on its own
pool; spillover pools use their connector default, so a luna-only run needs either per-pool assignments or no
concurrent siblings.

Post-run verification by the operator: repo connector via a temp home — Relay off ⇒ `["opencode","run","--auto",
"{taskFile}"]` (no `--model`); Relay on ⇒ `--model relay/gpt-5.6-luna`, `relay-2/…`, `relay-3/…` injected per provider.
Live `--classify=llm` end-to-end: decision came back `source: llm-classifier` with both reasons and a sensible verdict.
Two observations recorded, not fixed: (a) `--dry-run` never consults the LLM, so the canonical skill flow
(dry-run preview → pinned re-execute) exercises only the deterministic classifier; (b) the substance gate rejected a
correct 16-char answer ("bullswarm 0.20.0") from the tiny smoke delegation — legitimately terse outputs still fail the
40/80-char floors. Installed homes keep the old connector until a setup upgrade copies the new file.
