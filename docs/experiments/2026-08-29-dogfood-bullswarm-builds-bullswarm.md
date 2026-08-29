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

## Proof run 4 — goal-3 re-run `d7xyg2` (wf-mtdzhw88), 0.14.1-pre @ 548eabe
(pending)
