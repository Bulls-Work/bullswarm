# Claude ultracode dynamic workflow vs bullswarm `workflow goal` — side-by-side (2026-08-29)

Status: IN PROGRESS — results sections are filled in as runs complete. Numbers
below are observed, not projected; anything estimated is labelled.

## Question

Same goal, same models, same fixture: how does bullswarm's autonomous
`workflow goal` loop behave next to Claude Code's native dynamic workflow
(the `Workflow` tool, "ultracode"), and what has to change in bullswarm to make
it feel as smooth?

## Setup (identical on both sides)

- **Fixture**: `swarmbench`, a zero-dependency Node ESM project with six small
  pure-logic modules under `src/`, one `node:test` file per module under
  `tests/`, plus an intentionally incomplete `src/index.js` barrel with its own
  test. Bugs were planted by a separate subagent; the orchestrator of the Claude
  side (this session) was told only file names and baseline counts, never the
  bugs, so both orchestrators had to discover them.
- **Two byte-identical copies**, each `git init`-ed so the diff can be audited
  afterwards. Test files are SHA-256 fingerprinted before and after each run to
  prove neither side edited a test.
- **Goal text (verbatim, both sides)**: see "Goal" below.
- **Models locked to one account**: workers on both sides are `claude-opus-5`.
  Orchestrator: Claude side = this Claude Code session (Fable 5, authoring and
  running the workflow script); bullswarm side = `claude-code` connector pinned
  with `--orchestrator claude-code` and `strategy assign high|medium|low --pool
  claude-code --model claude-opus-5`, `claude-fable-5` excluded.
- **bullswarm** 0.10.9 (released and installed from npm for this experiment),
  run from the installed binary with an isolated `BULLSWARM_HOME` in which every
  pool except `claude-code` is disabled and the connector meter is `none` so a
  5-hour burst gate cannot bench the only pool mid-run.
- **Sequential runs** on the same laptop so wall-clock numbers are not skewed
  by contention for the same subscription and CPUs.

## Goal

Verbatim, passed as the single goal argument to bullswarm and as the task
statement the Claude-side workflow script decomposes:

```text
Make `npm test` pass in this repository. Every failing test is caused by a bug in a file under src/ (including an incomplete src/index.js barrel that must re-export every module's public API). Fix the source so all tests pass. You must not modify, delete, or add any file under tests/. Finish by running the full `npm test` and report, per file changed, what was wrong and what you changed.
```

## Fixture baseline

`swarmbench`: `src/{csv,duration,index,intervals,lru,semver,slugify}.js`,
`tests/{csv,duration,index,intervals,lru,semver,slugify}.test.js`, `npm test`
= `node --test tests/*.test.js`. Baseline on both copies (Node v22.23.2):

```text
# tests 52
# pass 37
# fail 15      (failures present in all 7 test files)
```

Test-file SHA-256 before any run (identical in both copies):

```text
5106804683c7f6cef0dbc3629c4c14f4ab2e88319d934626d79bb18a080ae707  tests/csv.test.js
b7c7d77daad8bfe03dd0b755574cf59faaf677df7d2701a717cf8e44138bd108  tests/duration.test.js
27aa49f0f601d22748f36e161c963ac77bd9861fe84028a69e02a456a9b38302  tests/index.test.js
80abeecbea763df43b2260a7ee03df211db5b092ea87e418e0be740c59383cbd  tests/intervals.test.js
2aa610981dcb9a6c65a0dd9b7b3362f23c95ef5c6436a43cb3d969fc0cc3dded  tests/lru.test.js
d62bc016abe37f4400499f4a77b94c7b60cc8f473bac6b63f5a461f9a18b6a20  tests/semver.test.js
d611fd789caed8820eaf03b08aeb2799f564e5f0d320485f886fd9c5cf6ac112  tests/slugify.test.js
```

Both bullswarm runs and the Claude workflow use a concurrency cap of 8
(Claude's own cap on this 10-CPU laptop is min(16, CPUs − 2) = 8; bullswarm
gets `--concurrency 8`), so parallelism differences come from the driving
loop, not the cap.

## Warm-up: bullswarm 0.10.9 smoke goal (observed)

Goal: "Create a file named hello.txt in this directory containing exactly the
single line 'hello from smoke test', then verify it exists with that exact
content." Run `srdwjs`, single pool `claude-code` pinned to `claude-opus-5`,
`--max-agents 5 --max-expansion-rounds 2 --concurrency 2`.

| metric | value |
| --- | --- |
| wall | 553 s (9m13s) |
| dispatches | 6 (4 orchestrator turns, 1 worker, 1 verifier) |
| orchestrator time | 438 s = 79 % of wall (turns: 108 s, 102 s, 151 s, 77 s) |
| worker time | 38 s (create) + 76 s (verify) |
| max concurrent attempts | 1 |
| tokens | ≈29.1 k (bullswarm estimate: utf8 bytes / 4) |
| outcome | `completed`, verified |

Two of the four planning turns were spent on `verify` actions that died inside
the runtime without dispatching: the planner put reviewer instructions (turn 2)
and then a filesystem path (turn 3) into `verify.review`, which the runtime
resolves as a dotted scope path to an artifact. The 0.10.9 planner skeleton had
shown exactly that wrong shape. Fixed in the 0.11.0 work (see below).

## Results

### bullswarm 0.10.9 `workflow goal` (baseline, installed binary)

Run `wf-mtd6lxfn-3912fd`, started 2026-08-28T16:44:18Z, `--orchestrator
claude-code --concurrency 8 --max-agents 30 --max-expansion-rounds 8`.

First planning turn: 152 s. It proposed one strictly serial chain —
`discover-failures` → `implement-fixes` → `verify-suite` — and explained why
(verbatim from `state.json` `decisions[0].reason`):

> Implementation is deliberately NOT fanned out: all fixes land in one shared
> working tree and converge on src/index.js, so concurrent workers would violate
> the shared-target mutation policy and race on the barrel file.

The "shared-target mutation policy" it cites is a caution line in the 0.10.9
planner prompt. `discover-failures` (read-only diagnosis of 7 test files) then
ran alone for 458 s before the single `implement-fixes` worker started.

Final numbers (run `xnujua`, 16:44:18Z → 17:19:26Z):

| metric | value |
| --- | --- |
| outcome | `completed`, verified; **52/52 tests pass**; `tests/` byte-identical (SHA-256 unchanged); 7 `src/` files changed, +20/−14 lines |
| wall | **2108 s (35m08s)** |
| dispatches | 7 = 3 orchestrator turns + 4 workers |
| orchestrator time | 431 s (20 %) — turns of 152 s, 189 s, 90 s |
| worker time | 1677 s: discover 458 s → implement 356 s → (verify-suite: runtime failure, 0 s) → independent-audit 618 s → final-verification 245 s |
| max concurrent attempts | **1** (parallelism 1.00 — every second of the run had exactly one process working) |
| planning rounds | 2 expansion rounds + 1 completion |
| tokens | ≈35.8 k by bullswarm's utf8-bytes/4 estimate of outputs only — **not comparable** to real provider usage (the Claude session's own status line showed ~49 k input tokens after its first four tool calls) |

Timeline of attempts (UTC):

```text
16:44:18 → 16:46:50  orchestrator turn 1 (152 s)   → serial chain of 3
16:46:50 → 16:54:28  discover-failures (458 s)     read-only diagnosis
16:54:28 → 17:00:24  implement-fixes (356 s)       one worker fixes all 7 files; 52/52
                     verify-suite                  failed inside runtime (review = instructions), never dispatched
17:00:24 → 17:03:33  orchestrator turn 2 (189 s)   → independent-audit + final-verification
17:03:33 → 17:13:51  independent-audit (618 s)     re-tests, fuzzes (3 000 interval sets, 2 000 LRU trials, …)
17:13:51 → 17:17:57  final-verification (245 s)    verify verdict ok
17:17:57 → 17:19:26  orchestrator turn 3 (90 s)    complete
```

What the orchestrator did well: it delivered a correct result with an honest,
detailed completion report, refused to fan out for a stated reason, and
recovered from its own `verify.review` mistake ("it was my control-plane
error") in one extra turn. What cost time: a strictly serial plan under a
concurrency cap of 8 that was never used; a 458 s read-only discovery step
before any fix; a 618 s audit that fuzzed every module; and one wasted
planning round on the `verify.review` shape.

### Claude Code, fresh interactive session (Opus, ultracode)

Set-up: a brand-new Claude Code 2.1.250 session started by `herdr` in its own
tab (`claude-compare`), `--model claude-opus-5 --dangerously-skip-permissions`
(the same permission posture bullswarm's connector uses), `/effort ultracode`
confirmed on screen, cwd = the twin fixture copy, no prior context. The goal
text above was submitted as the first and only prompt at 17:19:16 Z. The
bullswarm baseline's final single-process planning turn was still running
until 17:19:26 Z — a 10-second overlap, noted for honesty.

Result (session `309931b0…`, goal turn 17:19:16 Z → 17:22:45 Z):

| metric | value |
| --- | --- |
| outcome | **52/52 tests pass**; `tests/` byte-identical (SHA-256 unchanged); 7 `src/` files changed, +21/−14 lines; per-file bug explanation printed |
| wall | **209 s (3m29s)** — the session's own footer: "Baked for 3m 29s" |
| agents spawned | **0** — no `Workflow`, no `Agent` call; 11 `Bash` calls in total |
| planning round trips | 0 |
| how it decided | 17:19:19–17:20:34 read every `src/` and `tests/` file and ran `npm test` inline; 17:20:34 "I have a complete picture: 15 failures across 7 modules. Let me get a review before I start editing." → advisor: apply directly, "the ultracode carve-out for trivial mechanical edits applies now that diagnosis is done"; 17:22:09 one Python patch script over all 7 files; 17:22:14–17:22:29 `npm test`, `git diff -- tests/` (empty), `git diff -- src/` |
| tokens (real provider usage from the transcript) | output 41 042; cache-read 1 939 219; cache-write 119 052; uncached input 62 — 24 assistant messages |

**The finding that matters for this experiment:** a fresh Opus session with
ultracode on judged this goal *too small to orchestrate* and did it solo. The
"smoothness" here is a fast inline scout (75 s to a complete diagnosis) and
zero planning round trips — not parallel agents. bullswarm's orchestrator, by
contrast, cannot do anything inline: every observation costs a worker
dispatch and every decision a full planning turn, so the same 15 bugs took
7 dispatches and 35 minutes.

Goal #1 therefore cannot show the fan-out mechanic the user asked about. Goal
#2 below is sized to require it.

### Correctness audit — goal #1

Independent `npm test` after each run: bullswarm copy 52/52, Claude copy
52/52. All seven `tests/*.test.js` SHA-256 values identical to the pre-run
fingerprints on both copies. Diff stat: bullswarm +20/−14 across the same 7
`src/` files; Claude +21/−14. Both fixed the same bugs the same way.

## Goal #2 — sized to require fan-out

Base: the fixed fixture (52/52) committed clean, copied three times
(`g2-claude`, `g2-bs-v2`, `g2-bs-base`). Goal text (verbatim, both sides):

```text
This repository (swarmbench) has six modules under src/ — csv, duration, intervals, lru, semver, slugify — and a passing test suite. For EACH of the six modules deliver three things: (1) a new test file tests/<module>.edge.test.js using node:test and node:assert/strict with at least 6 additional edge-case tests that are not already covered by tests/<module>.test.js, all passing against the current implementation; (2) complete JSDoc on every exported function or class in src/<module>.js (parameter types, return type, thrown errors, one @example) without changing any behaviour; (3) a documentation page docs/<module>.md describing the public API, edge-case behaviour, and examples. Then write docs/README.md as an index table linking all six pages with a one-line summary each. Do not modify the existing tests/<module>.test.js files. Finish with the full `npm test` passing (existing plus new tests) and report what you created.
```

Six independent items, three deliverables each, one cross-cutting index — the
shape `pipeline()` exists for.

### Claude Code, fresh interactive session #2 (Opus, ultracode)

New session (`0754e69f…`) in herdr tab `claude-compare-2`, same set-up as
session #1; goal submitted 17:24:4x Z. Observed driving sequence:

- 17:24:50–17:25:20 inline scouting (ls, `cat -n` every source and test file,
  `npm test` → 52 passing). First words: "I'll start by orienting myself in the
  repo before authoring the workflow."
- 17:25:20–17:26:44 advisor consultation ("Advisor sharpened the plan"); then
  `mkdir docs` and a baseline snapshot of `src/` for behaviour-preservation
  checks.
- 17:28:42 `Workflow` call: script `swarmbench-docs-and-edge-tests`, phases
  Probe → Author → Verify, five `agent()` call sites in a per-module
  `pipeline()` ("probe → author → adversarially verify → fix-loop, pipelined
  per module"), ≈23 k characters, workers inherit the session model (Opus).
- The first call was **rejected by the harness**: "Invalid workflow script:
  Script parse error: Unexpected token (48:15) … Workflow scripts must be plain
  JavaScript". The session replied "Backtick inside a template literal in the
  lru hints. Fixing and resending." — the same validate-and-correct loop
  bullswarm 0.10.9 now has for planner decisions, except here the correction is
  an inline retry inside one turn rather than a fresh planning process.

Execution numbers (from the workflow journal `wf_b235c760…/journal.jsonl` and
the session transcript; read-only, no interference):

| Measure | Value |
| --- | --- |
| Goal submitted → session idle | 17:24:46 → 18:22:45 Z = **58 min 0 s** |
| Inline scouting + advisor before the Workflow call | 4 min (17:24:46 → 17:28:42) |
| Workflow call rejected (parse error) → corrected resend | 94 s (17:28:42 → 17:30:16) |
| Workflow execution | 17:30:16 → 18:19:07 = **48 min 51 s**, 24 agents, 0 errors |
| Agents by stage | 6 probe, 6 author, 9 adversarial verify, 3 fix (slugify ×2, intervals ×1) |
| Max concurrent agents / mean parallelism | **6** (= the six items; cap was 8) / 3.1 |
| Orchestrator (session) model turns during execution | **0** — the session sat in "Waiting for 1 dynamic workflow to finish" |
| Session tool calls overall | 16 Bash, 2 Workflow, 1 ToolSearch, 0 Agent |
| Post-workflow inline verification | 18:19:15 → 18:22:44 (3.5 min): own `npm test`, comment-stripped code identity diff, executing every `@example`, link check, advisor |
| Session output tokens (orchestrator only) | 91 k; workers 534 k output, 52.9 M cache-read |

How the program actually ran (agent start → end):

```text
probe     ×6  17:30:16 → 17:34:36 … 17:36:53   all six in flight at once
author    ×6  17:34:36 → 17:41:20 … 17:46:59   each starts the second ITS probe ends (pipeline, no barrier)
verify    ×6  17:41:20 → 17:45:48 … 17:52:08   each starts the second ITS author ends
fix       slugify 17:46:45→17:55:10 · intervals 17:48:41→17:53:06 · slugify 18:01:34→18:11:52
re-verify intervals 17:53:07→17:58:36 · slugify 17:55:10→18:01:34 · slugify 18:11:52→18:19:07
```

Four of the six modules were completely done by 17:49; the remaining 30 min of
wall time was one module's (slugify) two-round fix loop, pre-authored in the
script as `while (!verdict.ok && rounds < N)`. No planner turn was spent on
"how many items", "did the verify pass", or "repair or not" — all three were
data-driven inside the program. This is the concrete shape 0.12.0 reproduces
(`itemsFrom`, `repair`).

Correctness audit of `g2-claude` (mine, read-only): `npm test` 168/168 (52 → 116
new); every existing `tests/<module>.test.js` SHA unchanged; every `src/*.js`
byte-identical to the base after stripping comment/blank lines (JSDoc only);
6 edge test files (16–24 tests each), 6 docs pages + `docs/README.md` index,
`@example` on every export. No deliverable missing.

### bullswarm 0.11.1 (installed binary) — same goal, `g2-bs-v2`

Launched 18:23:39 Z via `run-bs-g2-v2.sh` (`--concurrency 8 --max-agents 40
--max-expansion-rounds 8`, orchestrator `claude-code`, single pool, Fable
excluded). Started only after the Claude session went idle so the two never
competed for the machine.

Run `wf-mtda5qq5-c6166f`, isolated `BULLSWARM_HOME`, single pool
`claude-code` / `claude-opus-5`, `--concurrency 8 --max-agents 40
--max-expansion-rounds 8 --foreground`, launched 18:23:42 Z on a pristine copy
of the fixture. Observed read-only from `state.json` / `events.jsonl`.

**Timeline**

| When (Z) | What happened |
| --- | --- |
| 18:23:42 → 18:27:55 | Planner turn 1 (253 s). ONE decision carrying the whole graph: **14 actions** — `module-{csv,duration,intervals,lru,semver,slugify}` (run, no deps), `verify-<module>` ×6 (each depending only on its own module), `docs-index` (depends on all six modules), `verify-suite` (depends on `docs-index` + all six verifies, `review: outputs.docs-index.outFile`). |
| 18:27:55 | All six module writers start together — **6 concurrent workers** (cap 8, six items). |
| 18:33:17 → 18:36:39 | Writers finish one by one; each `verify-<module>` starts the moment its own writer finishes (ready-set scheduler); `docs-index` starts at 18:36:40 when the last writer lands. |
| 18:35:26 | **`verify-slugify` dies with zero attempts**: `template ref "{{maxLength?: number}}" unresolved at render time`. The planner had quoted a JSDoc record type literally in the prompt; the renderer treated the double braces as a template ref. `verify-suite` is then blocked by a failed dependency. |
| 18:41 → 18:46:01 | Planner turn 2 (~5 min). It diagnosed the render-time death correctly ("two consecutive opening curly braces … treated as an unresolved reference") and proposed **7 actions**: `slugify-recheck` + `verify-slugify-2`, `polish-semver` + `verify-semver-2`, `polish-lru` + `verify-lru-2`, `final-suite`. The two `polish-*` actions react to *non-blocking* nits reported by verifiers that had **passed** (`verify-semver` and `verify-lru` were `ok:true`). |
| 18:46:01 → 19:03:06 | Remediation round runs (3 fixes → 3 re-verifies → `final-suite`), max 3 concurrent. |
| 19:03:06 → 19:04:56 | Planner turn 3 (110 s): `complete`, verified, no concerns. |

What this run settles, before the numbers: 0.11.x's planning doctrine already
produces the Claude shape — one decision = the whole graph, six writers in
parallel, per-item verify overlapping other items' writes, a final
whole-suite verify at the end. The remaining differences are (a) a runtime
robustness bug (literal braces), (b) repair happening as a *planner turn*
rather than inside the program, (c) the planner treating informational
concerns as work, and (d) no scout before the first program (the planner
compiled from the goal text alone — correctly here, because the goal names the
six modules).

**Numbers** (from `state.json`/`events.jsonl` via `metrics-bullswarm.mjs`; audit
via `audit-fixture.sh`, read-only, after the run ended)

| Measure | bullswarm 0.11.1 | Claude Code #2 (for reference) |
| --- | --- | --- |
| Goal submitted → terminal | 18:23:42 → 19:04:56 Z = **41 min 14 s** (2 474 s) | 58 min 0 s (48 min 51 s of it inside `Workflow`) |
| Planner / orchestrator time | **667 s = 27 % of wall**, 3 turns (253 s, 304 s, 110 s) | 4 min scouting + 94 s script fix before execution; **0 turns during** the 48 min 51 s execution |
| Agents dispatched | **22** (19 workers + 3 planner) | 24 workers (6 probe, 6 author, 9 verify, 3 fix) |
| Max concurrent / mean parallelism | **6** / 2.74 | 6 / 3.1 |
| Actions per decision | 14, 7, 0 | one script (24 agents) |
| Actions that died without running | 2 (`verify-slugify` render-time template ref; `verify-suite` blocked by it) | 0 |
| Remediation rounds | 1 (as a planner turn) | fix loops inside the script (3 fix agents) |
| Outcome | `completed`, verified, no concerns | done, self-verified inline |
| Tests after | **130/130** (52 existing + 78 new: 15/14/12/11/13/13 per module) | 168/168 (52 + 116 new: 24/18/19/21/… per module) |
| Existing `tests/*.test.js` | byte-identical to base (all 7) | byte-identical (all 7) |
| `src/` changes | comment-only in all 6 modules (0 non-comment line diffs) | comment-only in all 7 files |
| Deliverables | 6 edge suites, 6 docs pages, `docs/README.md` index (6 links) — all present | same set, all present |
| Tokens | 148 k *estimated* (utf8 bytes/4 — provider gave no usage; not comparable) | orchestrator 91 k output; workers 534 k output, 52.9 M cache-read (real usage) |

Two things worth noting beyond the table. (1) The run *modified the fixture
to route around the tool's bug*: the planner's remediation rewrote
`src/slugify.js`'s JSDoc from `@param {{maxLength?: number}} [options]` to the
dotted `@param {number} [options.maxLength=0]` form so that no later verify
would trip on the double braces. Comment-only, goal-compliant, but a
runtime defect leaked into the deliverable. Root cause is two-fold and both
are fixed in 0.12.0: the renderer treated any `{{…}}` as a ref, and `verify`
template-rendered the *review artifact* (a worker's report, arbitrary text)
together with its instructions. (2) The remediation round spent two of its
three fixes on "non-blocking" nits from verifiers that had returned
`ok:true`; 0.12.0's doctrine tells the planner those are informational.

### bullswarm 0.12.0 (installed binary) — same goal, fresh copy `g2-bs-v3`

**First launch, 19:09:48 Z, installed 0.12.0 — failed in 4 s.** Both the
scout and the orchestrator were `failed_terminal` with `no eligible pool`
before any process was spawned. Cause: the account's Claude 5-hour window read
**91 %** (live meter at 19:09:49 Z, reset 22:30 Z) after the two long Opus
runs, so the pace gate excluded the only pool. Not a 0.12.0 regression (the
gate pre-dates it) but exactly the class of difference this comparison is
for: Claude Code, rate-limited mid-workflow, waits and retries; bullswarm
failed the run with no reset time in the reason. Fixed as **0.12.1** (`beeed94`):
the runtime parks the dispatch in `waiting_for_quota`, re-reads the meter
every 60 s, continues when the window resets, and only fails — naming pool,
usage and reset time — after reset + 10 min grace.

**Second launch, 19:28:03 Z, installed 0.12.1, run `wf-mtdcghw0-bfefc7` on a
fresh pristine `g2-bs-v3` — observed the wait working.** The meter read 95 %
at launch, so the runtime parked the first dispatch (the scout) in stage
`waiting_for_quota` with `until 22:40:00 Z` (reset 22:30 + 10 min grace),
event `dispatch.waiting_for_quota` carrying pool, usage and reset time. It
re-read the meter every 60 s for **3 h 2 min 14 s** (`waitedMs 10933739`) and
emitted `dispatch.quota_available` at **22:30:16.979 Z** — 17 s after the
provider reset — then dispatched the scout with no operator action. Wall-clock
numbers below therefore exclude this wait (`metrics-bullswarm.mjs` reports
`quotaWaitSec` and `wallExclWaitSec` separately); the wait is a provider
constraint, not execution time.

**Outcome: `completed`, `verified: true`, 23:18:38 Z.** Timeline (all Z):

| when | what |
|---|---|
| 22:30:17 | scout dispatched (read-only survey), 197 s |
| 22:33:34 → 22:39:14 | planner turn 1, **340 s** → one `needs_more_work` program of 14 actions |
| 22:39:14 | **7 workers started in the same second**: `build-{csv,duration,intervals,lru,semver,slugify}` + `write-docs-index` |
| 22:44:45 → 22:46:36 | each `verify-<module>` started the moment its own builder finished — per-chain pipelining, no stage barrier (`verify-intervals` was running while `build-slugify` still built) |
| 22:52:29 | all six module verifies `ok:true` (`verify-slugify` 354 s — see landmine note) → `verify-full-delivery` |
| 22:59:02 | `verify-full-delivery` **ok:false**: `docs/README.md` missing → runtime spawned `verify-full-delivery-repair-1` (`source: repair-policy`), no planner turn |
| 23:01:19 → 23:07:58 | repair wrote `docs/README.md` (137 s); re-verify passed (399 s) |
| 23:07:58 → 23:09:42 | planner turn 2 (105 s): `complete` — **rejected by the runtime**: "missing a successful verification of latest worker verify-full-delivery-repair-1" |
| 23:09:42 → 23:12:25 | planner turn 3 (163 s): diagnosed the rejection as mechanical, added one read-only `verify-final-acceptance` depending on the repair |
| 23:12:25 → 23:17:54 | `verify-final-acceptance` ok:true (328 s) |
| 23:17:54 → 23:18:38 | planner turn 4 (44 s): `complete`, accepted |

Numbers (`metrics-bullswarm.mjs`, wait excluded):

| metric | 0.11.1 (`g2-bs-v2`) | **0.12.1 (`g2-bs-v3`)** | Claude #2 |
|---|---|---|---|
| execution wall | 41 min 14 s | **48 min 21 s** (2 901 s; +10 934 s quota wait) | 58 min |
| planner turns / seconds | 3 / 667 s (27 %) | **4 / 652 s (22 %)** — turns 2–4 (312 s) plus `verify-final-acceptance` (328 s) exist only because of the rejection bug below | 0 during execution |
| dispatches / max concurrent | 22 / 6 | **22 / 7** | 24 / ~10 |
| parallelism (busy ÷ wall) | 2.74 | **2.11** | 3.1 |
| actions by source | planner 14+7+0 | **planner 14 + 1, repair-policy 1** | script |
| tests after | 130/130 | **120/120** (52 + 68 new, 6 files ≥ 9 tests each) | 168/168 |
| existing tests / src | byte-identical / comment-only | **byte-identical / comment-only** (audit-fixture.sh: 0 non-comment line diffs in all 7 src files) | same |
| deliverables | all | **all** (6 docs pages, `docs/README.md` 6-row index) | all |
| estimated tokens | — | 201 568 (utf8/4 estimate) | — |

What the run showed:

1. **The brace landmine is closed (controlled A/B).** `g2-bs-v3` is a pristine copy, so `src/slugify.js` still carries the `@param {{maxLength?: number}}` JSDoc that killed 0.11.1's `verify-slugify` with zero attempts. On 0.12.1 the same verify dispatched, reviewed the artifact with the braces intact, and returned `ok:true` (with three informational concerns, none of which spawned a polish action — the doctrine held).
2. **The planner compiled a Claude-shaped program on the first turn.** Six independent `build → verify` chains + a parallel docs-index builder + one final gate, each verify carrying `repair {maxRounds: 1}`. The runtime then ran it as a pipeline: verifies started per chain, not after a barrier.
3. **The repair loop worked live, and paid for a planner mistake.** `write-docs-index` was compiled with `dependsOn: []`, so it launched with the builders and found no `docs/` to index; the worker refused to invent summaries and returned a status note. The final verify caught the missing file and the runtime's repair round fixed it — no planner turn, ~9 min. In Claude's model the same mistake is an authoring error in the script; here it is a compile error by the planner. Neither runtime can catch it deterministically; both recover through verification.
4. **Runtime bug found: a repair action is never "verified".** `completionEvidenceGaps` accepts a verify as evidence for the latest worker only if `verify.dependsOn` includes that worker. A repair action depends on its verify (the reverse edge), and the verify's post-repair re-run *is* its verification, but the check does not know that — so a clean `complete` was rejected and the run spent 3 more turns and ~11 min proving what it already had. The same check gates 0.13.0's `all-actions-ok` auto-completion, which would have been blocked the same way. Fix: 0.13.1 (below).

Take the bug and the dependency slip out and this run is ~29 min of execution with two planner turns — the shape the 0.12.0 design targeted.

The originally planned 0.10.9 goal-2 run was dropped at the user's request
(2026-08-29): the installed latest is the only baseline that matters.

### bullswarm 0.13.1 (installed binary) — goal 3, discovery-shaped, fresh copy `g3-bs-v3`

Goal 3 was written to exercise what goal 2 cannot: an **unknown item list**.
"Some — not all — of the exported functions accept a wrong-typed argument and
misbehave. Find out which modules actually have this problem (probe every
export; keep only the misbehaving modules), then for EACH affected module only:
add top-of-function argument validation (TypeError naming function, parameter,
expected type; behaviour for valid input unchanged) and `tests/<module>.guards.test.js`
(node:test, one test per guard). Do not modify existing tests or touch modules
that already validate. Finish with `npm test` passing and report exactly which
modules you changed and which you left alone, with evidence." Same fixture
family, same single pool (`claude-opus-5`), 0.13.1 installed after the goal-2
run ended so the binary each run used is unambiguous. Run `wf-mtdkvx0k-c40480`,
23:23:56 → 23:52:41 Z.

| when (Z) | what |
|---|---|
| 23:23:59 → 23:28:05 | scout (246 s): probed all six modules; found exactly three misbehaving (csv, slugify, semver) with per-function evidence |
| 23:28:05 → 23:32:59 | planner turn 1 (294 s): **one 9-action program with `completion: {when: "all-actions-ok"}`** — `fix-{csv,slugify,semver}` + `audit-remaining` (independently re-probe duration/intervals/lru/index) in parallel, each with its own `verify-*` carrying `repair {maxRounds: 2}`, then `verify-suite` |
| 23:32:59 | 4 workers started in the same second |
| 23:37:04 → 23:39:31 | each `verify-<m>` started as its own fix finished (pipeline, no barrier) |
| 23:42:44 → 23:52:41 | `verify-suite` (597 s) ok:true |
| 23:52:41 | **runtime recorded `complete` itself** — `decision.auto_completed`, `source: program-completion`; no second planner process |

| metric | value |
|---|---|
| wall | **28 min 42 s** (1 722 s), no quota wait |
| planner turns / seconds | **1 / 294 s (17 %)** |
| dispatches / max concurrent / parallelism | 11 / 4 / 1.82 (four items → four chains; width was item-bound, cap 8 unused) |
| repairs | 0 needed (every verify ok:true first time) |
| actions by source | planner 9; completion recorded by the runtime |
| result (audit-fixture.sh + `npm test`) | `src/csv.js`, `src/semver.js`, `src/slugify.js` modified (24/9/9 non-comment lines); duration/intervals/lru/index untouched; 3 new `*.guards.test.js`; existing tests byte-identical; **75/75** (52 + 23) |
| tokens (estimate) | 51 422 |

Two notes. First, the planner did **not** use `fanout.itemsFrom` — it inlined
the three modules the scout had already named and gave the "not yet confirmed"
half of the repo to one `audit-remaining` worker. That is the right call (the
scout had done the discovery), and it is exactly what Claude's author does when
it discovers the list inline before writing the script; `itemsFrom` stays the
tool for lists that only exist after a worker runs. Second, `verify-others` and
`verify-suite` both flagged `lru` throwing `RangeError` rather than `TypeError`
for a wrong-typed capacity and both correctly treated it as informational (the
existing test pins `RangeError`): passing-with-nits produced no extra work,
as the doctrine intends.

## Behaviour differences observed

Same goal, same fixture, same model (Opus for every worker and for bullswarm's
planner; the Claude session's author was Opus too). Read left to right: what
Claude did, what bullswarm 0.11.1 did on the identical run, and what 0.12.x
now does about it. Every 0.12.x/0.13.x cell is unit-tested; cells marked
**observed** were also seen live in the `g2-bs-v3` (0.12.1) and `g3-bs-v3`
(0.13.1) runs above.

| Dimension | Claude Code `Workflow` (ultracode) — observed | bullswarm 0.11.1 — observed | bullswarm 0.12.1 / 0.13.1 |
| --- | --- | --- | --- |
| Who plans, and when | The session author read every file and ran the tests inline (4 min), then wrote **one script** (23 k chars, 5 `agent()` sites). **0 orchestrator turns during the 48 min 51 s of execution.** | The planner compiled the **whole 14-action graph in one decision** (253 s) — but blind: goal text + cwd only, no repo survey, no worker output text in its context. Consulted **3 times** (253 s, 304 s, 110 s) = **27 % of wall**. | Read-only `scout` action before the planner; `outputExcerpt` of every finished action in the planner context; prompt reframed as "compile the goal into a PROGRAM"; planner told it is consulted only at the program boundary. **Observed:** both runs compiled the whole program on turn 1 from the scout's survey; goal 3 ran on **one planner turn** (0.13.0 self-completion). |
| Item discovery | `pipeline(MODULES, probe, author, verify, fix-loop)` over a known list; when a list is unknown Claude discovers it inline *before* writing the script. | Goal named the six modules → inlined them. Nothing to discover here. | `fanout.itemsFrom: "outputs.<discovery>.outFile"` resolved at run time (+ one bounded read-only extraction retry), so an unknown item count never costs a planner turn. |
| Parallel width and overlap | **6 concurrent** (= six items, cap 8), mean parallelism 3.1. Per-item pipeline: author-B starts the second probe-B ends; no barriers. | **6 concurrent**, mean parallelism 2.74. Ready-set scheduler: each `verify-<m>` started the second its own `module-<m>` finished; `docs-index` waited for all six by design. | Unchanged for known items. Limitation stays: a verify on a *discovered* fan-out waits for all items (no per-item chain inside a fan-out yet). |
| Verify → fix | Fix loops **pre-authored in code** (`while (!verdict.ok && rounds < N)`): slugify ×2, intervals ×1, all inside the script; 9 verifies, 3 fixes, 0 planner involvement. | A failed/blocked verify came back to the **planner** (turn 2, 304 s), which authored `slugify-recheck` + `verify-slugify-2`. Round trip ≈ 5 min before the fix even started. | `verify.repair { prompt, maxRounds 1–3 }` — the executor runs `<verify>-repair-<n>` with the concerns verbatim and re-runs the same verify; only still-failing verifies return to the planner. **Observed** (goal 2): `verify-full-delivery` failed on a missing `docs/README.md`, the repair wrote it and the re-verify passed, ~9 min, no planner turn. Exposed the 0.13.1 bug (repair never counted as verified). |
| Passing verifies with nits | Schema-forced `{ok, issues}`; the script fixes only when `!ok`. Nits on passing modules were ignored. | Planner spent **2 of 3 remediation fixes** (`polish-semver`, `polish-lru`) on "non-blocking" notes from verifiers that had returned `ok:true` — an extra ~10 min program round. | Doctrine line: an `ok:true` verify is accepted; its concerns are informational. **Observed:** 6 + 4 passing verifies with concerns in the two runs, zero polish actions. |
| Robustness to content | Prompts are JS strings; the runtime substitutes nothing. A parse error in the *script* was caught by the harness and corrected inline in 94 s. | The template renderer parsed **any** `{{…}}` — in a planner prompt *and* in the review artifact it appended. `verify-slugify` died at render time with **0 attempts**, blocked `verify-suite`, cost a planner round, and the fix **rewrote fixture source** (JSDoc) to dodge the bug. | Only a known root + dotted identifiers is a template ref; other double braces are text. `verify` appends the reviewed artifact verbatim, never rendered. **Observed:** same pristine `slugify.js` with `{{maxLength?: number}}`, `verify-slugify` ran and passed. |
| Provider rate limits | Agents retry on API errors; a terminal error resolves the agent to `null`, the script keeps going. The session waits. | Pool burst-gated (5h window 91 %) → the whole run **failed in 4 s** with `no eligible pool`, no reset time named (first 0.12.0 launch, 19:09 Z). | 0.12.1: `waiting_for_quota` stage, meter re-read every 60 s, continue when the window resets; fail only after reset + 10 min grace, naming pool / usage / reset time. **Observed:** waited 3 h 2 min at 95 %, resumed 17 s after the reset, no operator action. |
| Structured worker output | `schema:` forces a `StructuredOutput` tool call; mismatches retry at the tool layer, so the script never parses prose. | Prose "content gate" (`looksLikeWork`); a bare JSON array answer was rejected as an "announcement"; the verify verdict is the only structured channel. | Content gate accepts JSON; `parseJsonArray` prefers the trailing array; one extraction action when discovery output has no array. A general `outputSchema` on run actions is still open. |
| Failure semantics | In code: `parallel()` never rejects, a throwing stage drops its item to `null`, `.filter(Boolean)`. | Runtime `onError: continue` per step; failed dependencies block dependents; blocked graph → planner. | Same, plus: a failed scout is non-fatal; fan-out `ok` is a boolean so dependents can wait on a whole fan-out. |
| Outcome quality (audits, read-only) | 168/168 tests (52 + 116 new); existing tests byte-identical; `src` comment-only; every deliverable present. | 130/130 tests (52 + 78 new); existing tests byte-identical; `src` comment-only; every deliverable present. | Goal 2 on 0.12.1: 120/120 (52 + 68); existing tests byte-identical; `src` comment-only; every deliverable present. Goal 3 on 0.13.1: exactly the three unguarded modules changed, 75/75. |
| Time and agents | 58 min end to end; 24 agents. | 41 min end to end; 22 dispatches. Faster because it wrote fewer tests per module (11–15 vs 16–24) and skipped Claude's probe stage — not because it orchestrated better. | Goal 2 on 0.12.1: 48 min of execution (+3 h quota wait), 22 dispatches, max 7 concurrent — ~11 min of it spent on the 0.13.1 bug and ~9 min on one repair round. Goal 3 on 0.13.1: 28 min 42 s, 11 dispatches, 1 planner turn. |

The short version: after 0.11.x the *shape* already matched (one decision =
whole graph, six in parallel, per-item verify overlap). What still separated
the two was everything Claude keeps **inside the program** — reading the repo
before planning, data-driven fan-out, repair loops, tolerating passing-with-
nits, tolerating rate limits — which bullswarm was still paying a 2–5 minute
planner round trip for, or failing on. 0.12.0/0.12.1 move each of those into
the runtime.

## What to change in bullswarm

**Shipped in this cycle** (0.12.0 `c1b71a8`, 0.12.1 `beeed94`, 0.13.0
`6e5f620`, 0.13.1 `1bf0840` — all released to npm and installed; unit suite
299/299):

1. Orchestrator as **compiler**: prompt reframed; planner consulted only at the
   program boundary; `programFeatures: ['itemsFrom', 'repair']` advertised.
2. `fanout.itemsFrom` — data-driven fan-out resolved at execution time, one
   bounded read-only extraction retry, `maxItemsPerExpansion` default 24.
3. `verify.repair { prompt, maxRounds }` — pre-authored fix loops run by the
   executor.
4. Fan-out summary artifact; fan-out `ok` is a boolean (count in `succeeded`).
5. `scout` step before the first program (`--no-scout`), non-fatal.
6. `outputExcerpt` for every output in the planner context.
7. Content gate accepts structured JSON; `parseJsonArray` prefers the
   trailing array.
8. Template refs are grammar-checked; review artifacts are never rendered.
9. Doctrine: `ok:true` verifies are accepted; concerns are informational.
10. Burst-gated providers are waited for (`waiting_for_quota`), not failed.
11. **Program-level completion predicate** (0.13.0): `completion: { when:
    "all-actions-ok", reason }` lets a clean program record its own `complete`
    decision — no final planner turn just to say so. Anything failing still
    returns to the planner. **Observed** on goal 3: the planner attached it
    unprompted, the runtime recorded `complete` (`source: program-completion`)
    at 23:52:41 Z, one planner turn for the whole run.
12. **A repaired verify counts as verification of its repair** (0.13.1): the
    completion-evidence check only followed `verify.dependsOn`; a repair action
    depends on its verify (reverse edge), so after a clean repair round every
    `complete` was rejected as "missing a successful verification of latest
    worker <verify>-repair-1" — observed on goal 2 (three extra planner turns,
    ~11 min) and it would have blocked item 11 in the same situation.

**Still open, in priority order** (each is a measured gap, not a guess):

1. **Per-item chains for discovered items.** `itemsFrom` removes the planner
   turn but not the stage barrier; a fan-out whose `stepTemplate` is itself a
   chain (`run → verify(repair)` per item) would give Claude's `pipeline()`
   overlap for unknown item lists too.
2. **General `outputSchema` on run actions** (Claude's `StructuredOutput`):
   validate a worker's JSON at the dispatch layer and retry once, instead of
   the prose gate plus an extraction action.
3. **Planner latency.** Every planner turn is a fresh `claude -p --resume`
   process reading a large durable context (253–304 s here vs Claude's ~4 min
   *once*). With repair-in-program and self-completion a clean run is one turn;
   the remaining lever is a smaller planner context (excerpts already budgeted
   at 36 k chars).
4. **Adversarial verification by default.** Claude's script verified every
   module with a reviewer told to *refute*; bullswarm's verify prompt is
   whatever the planner wrote. A default skeptic framing in the verify wrapper
   is cheap and would have caught nothing extra here — listed for parity, not
   urgency.
5. **Dependency slips by the planner.** Goal 2's `write-docs-index` was
   compiled with `dependsOn: []` although it reads the six `docs/<m>.md` files
   the builders create; it ran first and found nothing. The verify + repair
   loop recovered it (~9 min). Claude has the same failure class (a mis-ordered
   `pipeline` stage) and the same recovery. A doctrine line — "an action that
   reads another proposed action's deliverable must depend on it" — is free;
   a deterministic check is not possible without declared outputs, which would
   be a small schema addition (`produces: [paths]`).
6. **Record `completion` on the decision.** The planner artifact carries the
   predicate but `state.decisions[]` does not, so `watch`/metrics cannot show
   that a program declared itself self-completing until it does. One field.
