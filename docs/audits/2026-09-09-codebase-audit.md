# Bullswarm codebase audit — 2026-09-09

Workspace: `/Users/cowcow02/Repo/bullswarm-worktrees/audit-0.27`, branch `audit/codebase-2026-09-09`,
HEAD `b8487b1`. `package.json` says `0.26.0`; `CHANGELOG.md:3` says `0.27.0`.

Words used in this report, defined once:

- **Tier A** — dead: nothing outside its own tests refers to it. Safe to delete in a patch release.
- **Tier B** — superseded but still wired: an older way of doing something is still connected to the
  live code path. Deleting it needs a decision, not just a patch.
- **Tier C** — refactor: the code works, but one job is implemented more than once.
- **Reachable** — the file can be arrived at by following `import` statements from a real entry point
  (`bin/bullswarm.js`, `mcp/server.mjs`, `scripts/*.mjs`, the paths in `package.json`, and the `node`
  commands in `.github/workflows/*.yml`).
- **Refuted** — a lens called something dead, and an experiment proved it is used.
- **Pool** — one configured provider account Bullswarm can send work to.
- **Rung** — the (pool, effort tier) → (model, reasoning level) choice, added in 0.26.0.

---

## Table of contents

1. [Verdict](#1-verdict)
2. [Tier A — dead code to delete in 0.27.1](#2-tier-a--dead-code-to-delete-in-0271)
3. [Tier B — superseded but still wired](#3-tier-b--superseded-but-still-wired)
4. [Tier C — refactor opportunities, best value first](#4-tier-c--refactor-opportunities-best-value-first)
5. [Command surface](#5-command-surface)
6. [README and documentation](#6-readme-and-documentation)
7. [Refuted candidates — looked dead, is used](#7-refuted-candidates--looked-dead-is-used)
8. [Audit-run incidents — what the audit learned about its own workers](#8-audit-run-incidents--what-the-audit-learned-about-its-own-workers)
9. [How this was measured](#9-how-this-was-measured)
10. [Appendix A — full command-surface table (all 64 paths)](#appendix-a--full-command-surface-table-all-64-paths)
11. [Appendix B — analyzer scripts, verbatim](#appendix-b--analyzer-scripts-verbatim)

---

## 1. Verdict

Very little of this codebase is dead: **64 source files are reachable and 2 are not**, and both of
those two are executed by worker processes through a shell command rather than an `import`, so they
are alive too. The genuinely dead material is **187 lines across 11 items** — five test-only helper
functions, twelve one-line alias exports nobody imports, one unused constant, one dead string in a
frozen list, one dead arithmetic operand, one `if`-statement whose two branches are identical, and a
36-line fixture pack — and the refutation pass deleted all of it at once for a green suite: 659 tests
before, 651 after, 0 failures. That is the whole 0.27.1 patch scope, and **eight verdicts from the
three code lenses were reversed or downgraded** before reaching it, including two files that every
worker prompt executes.

Three things need a decision rather than a patch: the 90 %-of-quota burst gate exists in two
generations and the older one wins, so two pools at 95 % of their 5-hour window make the CLI return
`no eligible pool` and exit 1 while the newer router hands back a pick; `state.json` is a
last-writer-wins file with no lock, and a concurrent `strategy set-provider beta off --yes` during a
9-second `run` was silently undone; and `run --dry-run`, documented as writing nothing, added 186
lines to `state.json` and performed a live datapack download.

The command surface is structurally strong and weak on validation — all 64 help paths render, exit 0
and carry all seven required sections, but every command silently ignores unknown flags
(`pools --bogus-flag` and `workflow runs list --limit nope` both exit 0) and three `--json` flags
(`health`, `workflow capabilities`, `strategy inventory`) produce byte-identical output with and
without them. Documentation is mostly accurate: of 17 files under `docs/`, 2 are stale-misleading, 3
are current and 12 are historical-keep of which 10 need a banner. Its two worst defects are that
`package.json` says `0.26.0` while the changelog, README and `AGENTS.md` all describe `0.27.0` as
shipped, and that README promises a bundled `data/openrouter-benchmarks.json` that does not exist.

The audit's own workers failed in two fixable ways. A worker's stdout outgrew Node's maximum string
length and threw `RangeError: Invalid string length` inside `src/lib/watch.js`, killing the detached
kernel and every worker under it — twice — and nothing in `events.jsonl`, `result.json` or
`state.json` records it, because the trace exists only in `~/.bullswarm/goals/<runId>/stderr.log`,
so `workflow watch` showed nothing but a run that stopped moving. Separately, one worker on the
`command-code` pool spent 4 minutes 43 seconds to return a 253-byte statement of intent instead of
findings, which the content gate correctly rejected — and every number in this verdict reappears
below with the command that produced it.

---

## 2. Tier A — dead code to delete in 0.27.1

The refutation pass deleted each item in an `rsync` copy of the tree at `/tmp/bullswarm-audit/copy/`
and ran the suite. Baseline in that copy: `# tests 659  # pass 659  # fail 0`.

### The table

| File or export | Lines | Superseded by | Only referenced by | Evidence |
|---|---:|---|---|---|
| `recordAgentAction` — `src/lib/agent-events.js:179-218` | 40 | 0.10.0 agent-event/TUI generation | `tests/agent-events.test.js:7,80,100` | `sed -n '179,218p' src/lib/agent-events.js \| wc -l` → `40`. Case R9: delete → 655 tests, 654 pass, 1 fail, and the one failure is its own test file |
| `aggregateUsage` — `src/lib/usage.js:135-183` | 49 | 0.8 usage accounting; `watch.js` uses `estimateInvocationUsage` | `tests/usage.test.js:4,65,77,87` | `sed -n '135,183p' src/lib/usage.js \| wc -l` → `49`. Case R11: → 654 / 653 / 1, own test file only |
| `fixtures/openrouter/{benchmarks,models}.json` | 36 | never superseded — never wired | nothing | `wc -l fixtures/openrouter/*.json` → `23` + `13` = `36`. `grep -rIn 'fixtures/openrouter' .` → no output. Case R5: → **659 / 659 / 0** |
| `parseEvidenceOutput` — `src/workflow/evidence-output.js:141-157` | 17 | durable candidate JSON + `bin/check-v2-evidence.js`; runtime imports `readEvidenceCandidate` | `tests/workflow-evidence-output.test.js:11,34,36,37` | `sed -n '141,157p' src/workflow/evidence-output.js \| wc -l` → `17`. Case R6: → 652 / 651 / 1, own test file only |
| `classifyAgentProgress` — `src/lib/agent-events.js:220-233` | 14 | same generation as `recordAgentAction` | `tests/agent-events.test.js:7,109,110` | `sed -n '220,233p' src/lib/agent-events.js \| wc -l` → `14`. Case R10: → 655 / 654 / 1 |
| 12 alias exports, 6 files (list below) | 14 | each is a one-line re-export of a live symbol | nothing — `src=1 tests=0 docs=0` each | Case R14: all 12 at once → **659 / 659 / 0**, no test touched |
| `fiveHourTier` — `src/lib/route.js:99-103` plus its comment `94-98` | 11 | 0.25.5 — the tier is recomputed inline on the *forecast* at `route.js:317` | `tests/route.test.js:4,129-134` | `grep -rn '\bfiveHourTier\b' --include='*.js' . \| grep -v node_modules \| grep -v '^\./tests/'` → one line, the definition. Case R1b: fn + its test → **658 / 658 / 0** |
| `REASONING_DEFAULT_TIERS` — `src/lib/strategy.js:85` | 1 | 0.26.0 — the wizard's tier step now writes nothing on Enter | nothing at all | `sed -n '85p' src/lib/strategy.js` → `export const REASONING_DEFAULT_TIERS = Object.freeze({ high: 'xhigh', medium: 'high', low: 'medium' });`. `git grep -n REASONING_DEFAULT_TIERS 4b18d2b -- src/` → that line only. Case R2: → **659 / 659 / 0** |
| Inert `--json` ternary — `src/strategy-cli.js:684` | 1, in place | — | — | `sed -n '684p' src/strategy-cli.js` → `console.log(opts.json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));` — both branches identical. Case R17: collapse → **659 / 659 / 0** |
| `'workflow-v1'` inside `ASSIGNMENT_SOURCES` — `src/lib/assignments.js:31` | 1, in place | 0.27.0 — the V1 engine is gone (`e8c841a`) | prose at `skill/references/operations.md:217` | `sed -n '31p' src/lib/assignments.js` → `export const ASSIGNMENT_SOURCES = Object.freeze(['run', 'workflow-v1', 'workflow-v2']);`. Every live writer passes `'workflow-v2'` or `'run'`. Case R3: → **659 / 659 / 0** |
| `pool.weeklyUsedPct` operand — `src/lib/spend.js:381` | 1, in place | — | only that read | `sed -n '381p' src/lib/spend.js` → `return num(pool?.weeklyUsedPct) ?? rate.windowUsedPct ?? null;`. `grep -rn weeklyUsedPct --include='*.js' --include='*.json' .` → one line, the read itself; `config.js` writes `usedPct` and `fiveHourUsedPct`, never `weeklyUsedPct`. Case R4: → **659 / 659 / 0** |

The 12 alias exports, each verified present by `sed`:

```
src/workflow/v2-scheduler.js:167  export const scheduleActions = scheduleV2Actions;
src/workflow/v2-scheduler.js:168  export const getReadySet = scheduleV2Actions;
src/workflow/v2-scheduler.js:169  export const selectReadyActions = scheduleV2Actions;
src/workflow/v2-state.js:8        export const GOAL_SCHEMA_VERSION = V2_GOAL_SCHEMA_VERSION;
src/workflow/v2-state.js:9        export const STATE_SCHEMA_VERSION = V2_STATE_SCHEMA_VERSION;
src/workflow/v2-state.js:617      export const V2_PLANNER_MODES = Object.freeze([...PLANNER_MODES]);
src/workflow/v2-state.js:649      export const assertV2ResumeCompatible = assertV2Resume;
src/workflow/ownership.js:173     export const verifyOwnership = checkOwnership;
src/workflow/v2-runtime.js:1308   export const runAutonomousV2 = runV2AutonomousWorkflow;
src/workflow/evidence-output.js:138  export const validateV2EvidenceOutput = validateEvidenceOutput;
src/workflow/evidence-output.js:139  export const validateEvidenceEnvelope = validateEvidenceOutput;
src/setup.js:134-136              export function integrationBlock() { return awarenessBlock(); }
```

Eleven one-liners plus a three-line pass-through = 14 lines. Sibling aliases that *do* have
importers were kept: `createV2State` (37 test references), `serializeV2ResultEnvelope` (12),
`parseV2PlannerResponse` (3), `changedManifestPaths` (2).

### Proposed 0.27.1 patch scope

**Delete these exports and functions.** `recordAgentAction`, `classifyAgentProgress`,
`aggregateUsage`, `parseEvidenceOutput`, `fiveHourTier` and its doc comment,
`REASONING_DEFAULT_TIERS`, and the 12 alias exports listed above.

**Edit these three lines in place.** Remove `'workflow-v1'` from `ASSIGNMENT_SOURCES`
(`assignments.js:31`); remove the `num(pool?.weeklyUsedPct) ??` operand (`spend.js:381`); collapse
the identical ternary (`strategy-cli.js:684`).

**Delete this directory.** `fixtures/openrouter/` — but read the risk note below first.

**Tests to delete or rewrite — 8 tests, 4 files.**

| Test file | Change |
|---|---|
| `tests/agent-events.test.js` | drop the import and 3 tests (`:72`, `:89`, `:107`); keep everything covering `createAgentEventDecoder` |
| `tests/usage.test.js` | drop the import and 3 tests (`:62`, `:74`, `:85`); keep `estimateInvocationUsage` coverage |
| `tests/route.test.js` | drop the import and the `5h tier:` test (`:127-136`), **but move its `FIVE_HOUR_NEAR_LIMIT_PCT === 75` assertion into the next test** — that constant is still live and README:249 documents the number |
| `tests/workflow-evidence-output.test.js` | drop the import and 1 test (`:33`) |

**Total lines removed: 187.** This is the sum of the per-file `wc -l` deltas the refuter measured
when it deleted the whole set at once (case R20): `route.js` 571→560 (11), `evidence-output.js`
187→167 (20), `agent-events.js` 233→177 (56), `usage.js` 183→133 (50), `v2-scheduler.js` 169→166 (3),
`v2-state.js` 649→645 (4), `setup.js` 582→578 (4), `ownership.js` 173→172 (1), `v2-runtime.js`
1308→1307 (1), `strategy.js` 776→775 (1), `fixtures/openrouter/` 36→0 (36) — which sums to exactly
187. Test files shrink too: `route.test.js` 458→448, `workflow-evidence-output.test.js` 115→107,
`agent-events.test.js` 122→78, `usage.test.js` 98→61 — 99 test lines.

*One arithmetic discrepancy, stated plainly:* the itemised column in the table above sums to **185**,
not 187. The gap is 2 lines and has two causes — three rows are in-place edits that remove zero net
lines, and the per-file deltas include blank separator lines that an itemised count of declarations
does not. The 187 is the empirical `wc -l` figure and is the number to trust; the exact line-by-line
reconciliation of the last 2 lines is **unverified** because I did not re-run case R20 myself.

**Expected test-count change: 659 → 651.** Measured in this workspace today:

```
$ env -u CLAUDE_CONFIG_DIR -u FORCE_COLOR -u NO_COLOR npm test
# tests 659
# suites 0
# pass 659
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12048.127875
exit 0
```

So the answer to "659 or 661" is **659 in this workspace**. The 661 figure is real but belongs to a
different commit: `16dddb0` on branch `feat/one-workflow-engine` says "Suite 661/661" in its message,
and that commit is **not** an ancestor of this HEAD (`git merge-base --is-ancestor 16dddb0 HEAD` →
not an ancestor). A patch built on `feat/one-workflow-engine` should therefore expect **661 → 653**.

**Risks.**

1. **`fixtures/openrouter/` is a working input, not rot.** It is the only key-free way to exercise
   the datapack builder, and it works today:
   `node scripts/refresh-openrouter-benchmarks.mjs --benchmarks-file fixtures/openrouter/benchmarks.json --models-file fixtures/openrouter/models.json --output /tmp/…`
   → exit 0, `wrote 1 models and 2 benchmark records`. Deleting it is safe for the suite and removes
   the only offline exercise of that script. **Preferred: add one test that runs the script in
   fixture mode, and keep the directory.** That test would also have caught the missing
   `data/openrouter-benchmarks.json` (see Tier B).
2. **`pool.weeklyUsedPct` is a choice, not a cleanup.** Deleting the operand makes the fall-through
   to `rate.windowUsedPct` honest. *Writing* the field in `buildPools` would instead fix
   `projectedWeeklyPct` returning `null` for pools that do have a pacing reading — a `null` that
   currently reads as "unmeasured" when the measurement exists. Pick one deliberately.
3. **`fiveHourTier` deletion must not take the threshold with it.** `FIVE_HOUR_NEAR_LIMIT_PCT` is
   live and its value (75) is documented at `README.md:249`. Deleting the function alone without
   fixing the test import fails loudly: case R1 gave `not ok 17 - tests/route.test.js`, 631 tests,
   1 failure, because the whole test file failed to import.
4. **Deleting `'workflow-v1'` changes behaviour by design.** The ledger will start *rejecting* a
   `workflow-v1` record instead of accepting one no live writer can produce. If any installed home
   holds pre-0.27.0 assignment records with that source, reading them becomes an error. Not
   verified against a real installed home — **unverified**.
5. **The alias exports may be someone's API.** All 12 have zero importers *in this repo*. A static
   audit cannot see an external `import { runAutonomousV2 } from 'bullswarm/…'`. Since `src/` is not
   a declared entry point in `package.json`, the risk is low, but it is a judgement call, not a
   measurement.

**Acceptance checks the patch must pass.**

1. `env -u CLAUDE_CONFIG_DIR -u FORCE_COLOR -u NO_COLOR npm test` → `# pass 651  # fail 0` (or
   `653` on `feat/one-workflow-engine`).
2. `tests/route.test.js` still asserts `FIVE_HOUR_NEAR_LIMIT_PCT === 75`.
3. `grep -rn 'fiveHourTier\|REASONING_DEFAULT_TIERS\|aggregateUsage\|recordAgentAction\|classifyAgentProgress\|parseEvidenceOutput' --include='*.js' src bin mcp scripts tests` → no output.
4. `node bin/bullswarm.js run --lane build --effort medium --dry-run --json --no-caller --prompt hi`
   under a fixture home still routes and still reports `nearFiveHourLimit` and `forecastGated`.
5. `node /tmp/bullswarm-audit/graph.mjs` (run from the repo root) still reports `64` reachable and
   `2` unreachable — the two `bin/check-v2-*.js` files, which this patch does **not** touch.
6. `node bin/bullswarm.js strategy inventory --json` still emits a parseable JSON document after the
   ternary collapse.
7. `skill/references/operations.md:217` no longer names `workflow-v1` as an assignment source.

---

## 3. Tier B — superseded but still wired

Each entry: what the current flow uses instead, who still references the old thing, the exact code
path that changes, and a recommendation.

### B1 — Two generations of the 90 % burst gate, and the older one wins

- **Current flow uses:** `route.js:321` gates on the *forecast* —
  `gated: forecast.forecasted && forecast.forecast != null && forecast.forecast >= BURST_BLOCK_PCT` —
  and `route.js:373-388` keeps a least-loaded fallback so work is never stranded.
- **Still referenced by:** the older reading-based pre-filter, at `src/cli.js:241-242`
  (`const gated = pools.filter((p) => p.burstGate);` / `const ungatedPools = gated.length ? pools.filter((p) => !p.burstGate) : pools;`)
  and `src/workflow/v2-dispatch.js:51`
  (`if (pool.enabled === false || pool.burstGate === true || isQuarantined(pool, now)) continue;`).
- **What breaks:** the pre-filter removes gated pools before `pickPool` ever sees them, so
  `pickPool`'s own "if every capable pool is gated, still name one" branch is unreachable from the
  CLI. Measured with two pools at 95 % of their 5-hour window: the CLI returned
  `{"ok": false, "why": "no eligible pool"}` and exit 1, while `pickPool` called directly with the
  same pools returned `pick: alpha`, `why: every capable pool is forecast-gated at/above 90% of its 5h window; least loaded wins`.
  Opposite outcomes from the two generations.
- **Exact code path that would change:** make `route.js` gate on `forecast.forecast ?? raw` (drop the
  `forecasted` guard), then delete `cli.js:241-242` and the `burstGate` test in `v2-dispatch.js:51`,
  keeping `pool.burstGate` only as a display flag for `cli.js:92`.
- **Recommendation: fold into `route.js`.** This is the highest-value item in the section. Not
  deletable as-is — the reading gate is currently the only thing covering a pool with no spend model,
  because `route.js:321` requires `forecast.forecasted`, which is false without a rate or a producer
  projection. Doing it makes the 0.25.5 promise at `CHANGELOG.md:210-212` true on both entry points.

### B2 — `strategy recommend` alias, with zero test coverage

- **Current flow uses:** `strategy refresh`. `sed -n '794p' src/strategy-cli.js` →
  `if (sub === 'refresh' || sub === 'recommend') {` — one handler, identical behaviour.
- **Still referenced by:** `src/help.js:391` calls it an alias, and `help.js:568-578` documents it as
  a separate command with its own usage block and its own `HELP_PATHS` entry.
- **Exact code path:** drop `|| sub === 'recommend'`, delete `strategyRecommendText`
  (`help.js:568-578`) and its `HELP_PATHS` entry, re-run `tests/help.test.js`.
- **New finding:** the alias has **no test at all**. Case R19 deleted the branch and the suite still
  passed 659/659. A documented command path with zero coverage can be broken silently.
- **Recommendation: keep the alias, add one dispatch test** — or delete alias and help block
  together. What must not continue is documenting a command that nothing tests.

### B3 — `strategy show` is presented as read-only but refreshes on a cold cache

- **Current flow uses:** `strategy inventory` and `strategy rungs` as the structured read surfaces.
- **Still referenced by:** `strategy-cli.js:806-810`. On a cold cache `show` calls
  `refreshStrategy(useOpenRouter: true)`, which spawns model discovery (`strategy-cli.js:207`),
  downloads the datapack with `force: true` (`:211`, bypassing the 24-hour TTL) and writes
  `state.json` (`:217-220`). `src/help.js:601` already admits this.
- **Exact code path:** make `show` print `no cached report; run \`strategy refresh\`` instead of
  refreshing. That is a behaviour change, so `help.js`, `tests/strategy-cli.test.js` and the
  `strategy tui` bootstrap (`strategy-cli.js:592-593`) move together.
- **Recommendation: keep the command, split the refresh out.** Not re-probed in the refutation pass
  because confirming it needs the live network fetch the routing lens already exercised — the
  cold-cache network behaviour is therefore **carried from one lens run, not independently
  reproduced**.

### B4 — Three inert `--json` flags

- **Current flow uses:** nothing — the flag changes no output.
- **Still referenced by:** `help.js:422,429` document `--json` on `strategy inventory`/`routes` as an
  option whose default is a different format. There is no human renderer for either verb.
- **Measured today**, fixture home `/tmp/bullswarm-audit/report-home.8wkEbT`:

```
$ node bin/bullswarm.js health          # exit 1
$ node bin/bullswarm.js health --json   # exit 1
$ cmp -s h1.txt h2.txt && echo identical
HEALTH BYTE-IDENTICAL (7 lines)

$ node bin/bullswarm.js workflow capabilities         # exit 0
$ node bin/bullswarm.js workflow capabilities --json  # exit 0
CAPABILITIES BYTE-IDENTICAL (239 lines)

$ node bin/bullswarm.js strategy inventory  vs  --json   # capturedAt normalised
INVENTORY IDENTICAL (2404 lines)
```

  `cmdHealth(opts)` at `src/cli.js:474` never reads `opts.json` — zero matches for `opts.json` in
  lines 474-500. The static flag analyzer agreed: `counts.json` lists `documentedButUnread: 1` for
  both `cli health` and `workflow capabilities`.
- **Exact code path:** either delete the flag from the handlers and from `help.js:422-431`, making
  JSON the only documented format, or write the human renderer the help promises.
- **Recommendation: delete the flags and fix the help** for `strategy inventory`/`routes`; **keep
  `--json` on `health` and `workflow capabilities` as accepted no-ops** but say in help that output
  is always JSON, because agents already pass the flag. The one-line dead ternary at
  `strategy-cli.js:684` is Tier A and goes now.

### B5 — `assignments[tier]` versus `modelTiers` — the largest two-generation overlap

- **Current flow uses:** *both.* `assignments[tier] = {pool, model}` is a hard pool pin that becomes
  `pickPool`'s `preferredPool` (`cli.js:260`); `modelTiers[pool][model] = [tiers]` is the allow-list
  that becomes `allowedModels`. 0.26.0 says rungs are a projection of `strategy.modelTiers` and
  `strategy.reasoning` (`CHANGELOG.md:148-150`) and never mentions `assignments`.
- **Still referenced by:** 8-9 non-test read sites — `cli.js:243,260`,
  `v2-dispatch.js:64,125,222`, `strategy.js:378,704`, `config.js:79` — plus five hand-written
  `delete state.strategy.assignments[tier]` invalidations at `strategy-cli.js:502,720,783,899` and
  `strategy-dashboard.js:335`.
- **Exact code path:** `set-rung` would first have to gain a pool-pin (or `preferredPool` be derived
  from `modelTiers`), then delete `assign`/`clear-assignment`, the eight read sites, the five
  invalidation lines, and the `workflow capabilities` field at `cli.js:1203`.
- **Recommendation: keep both for now.** They are not interchangeable: only `assignments` can pin a
  *pool*, only `modelTiers` can express an allow-list, and `applyStrategyRecommendations` writes
  both. This is a project, not a patch. Fix C7 (one `clearTierAssignment` helper) as the cheap step.

### B6 — `TIER_CONTEXTS`, plus a third inline copy

- **Current flow uses:** `DEFAULT_EFFORT_BY_LANE` and `KIND_DEFAULTS`
  (`src/workflow/action-validator.js:10-25`) as the canonical lane/effort tables.
- **Still referenced by:** `src/lib/strategy.js:632-648`, 3 non-test references, plus an inline third
  copy at `strategy-cli.js:366`:
  `const context = report.suggestions?.[tier]?.requirements ?? { lane: ({ high: 'analyze', medium: 'build', low: 'chore' })[tier], capabilities: [] };`
- **The disagreement:** `TIER_CONTEXTS` says `high→analyze, medium→build, low→chore`;
  `DEFAULT_EFFORT_BY_LANE` says `analyze→medium, build→medium, chore→low`; `KIND_DEFAULTS` puts
  `high` on `analyze` *and* on `build`.
- **Exact code path:** delete the inline fallback at `strategy-cli.js:366` and derive
  `TIER_CONTEXTS[tier].lane` from the 0.26 tables.
- **Recommendation: keep `TIER_CONTEXTS`, delete the inline copy.** `TIER_CONTEXTS` also carries
  per-tier capability requirements that nothing else does, so it cannot simply go.

### B7 — `preferredConcurrency` promises a cap nothing enforces (moved down from Tier A)

- **Current flow uses:** nothing enforces it. `git grep -n preferredConcurrency e8c841a^ -- src/`
  → `src/workflow/runtime.js:202: const preferred = Number(connector.preferredConcurrency);` — the
  V1 authored-graph executor that `e8c841a` deleted in 0.27.0. 0.25.5's load spread only *prefers* a
  quieter pool.
- **Still referenced by:** `src/setup.js:270` copies the field forward on upgrade, and
  `tests/setup.test.js:162` asserts that. `grep -rn preferredConcurrency --include='*.js' src/` →
  only `setup.js:270`.
- **Why it moved out of Tier A:** case R13 deleted the key and its `$comment-` and the suite went
  **659 → 658 pass, 1 fail**: `not ok 176 - connector metadata upgrades additive provider concurrency preferences`.
- **Exact code path:** either re-implement the cap in `route.js`/`v2-dispatch.js`, or delete the key,
  its `$comment-`, the `setup.js:270` entry and the setup assertion together.
- **Recommendation: decide, do not drift.** The connector's own `$comment-` documents a real
  OpenCode failure mode (sibling workers killing each other). Right now `connectors/opencode2.json`
  advertises a constraint the engine does not apply. Which way to go depends on real OpenCode
  behaviour, which a read-only repo audit cannot settle — **unverified**.

### B8 — `connectors/_schema.json` is dead to code but is the only connector-format reference

- **Current flow uses:** nothing reads it. `setup.js:89` skips `_`-prefixed files, and case R12
  deleted it with **659 / 659 / 0**.
- **Still referenced by:** `package.json files[]` ships `connectors/`, and
  `docs/studies/portal-token-diet.md:78` cites it.
- **Recommendation: keep the file, fix its content** — see B9. It is documentation that happens to
  live in a `.json`.

### B9 — `json-field` is advertised but never implemented

- **Advertised:** `sed -n '17p' connectors/_schema.json` →
  `"strategy": "stdout|stdout-tail|json-field|file|event-stream",`
- **Implemented:** `src/lib/watch.js:255-283` has exactly four `case` labels — `event-stream`,
  `stdout`, `stdout-tail`, `file`. **No `json-field`.** A connector declaring it would fall through
  silently.
- **Related:** shipped connectors declare only `event-stream` (5 of them) and `stdout` (`echo`), so
  `stdout-tail` and `file` are implemented-but-unused compatibility paths.
- **Recommendation: delete the `json-field` option from the schema line.** Implementing it has no
  demand — no connector asks for it.

### B10 — Deleting a verification fixture silently removes a test case

- **Current flow uses:** `tests/verify.test.js:12-21` `readdirSync`s `fixtures/failures/` and
  `fixtures/real/`.
- **The hole:** case R16 deleted `fixtures/failures/01-rate-limit-head.json` and the suite reported
  **658 tests, 658 pass, 0 fail** — coverage shrank by one case with no failure. The only guard is a
  floor at `verify.test.js:23` (`fixtures.length >= 17`), and there are 23 fixtures (`find fixtures/failures fixtures/real -type f | wc -l` → `23`).
- **Recommendation: raise the floor to the current count, or enumerate the fixtures explicitly.**
  Cheap, and it closes a way to lose coverage without noticing.

### B11 — The `claude` alias in `READERS` is dead in this repo only

- **Still referenced by:** `src/meters/registry.js:19` and `readerFor` at `:58`. Case R18 removed
  both with **659 / 659 / 0**. `git log -- connectors/claude.json` → **no commits, ever**; no
  packaged connector is named `claude` (the packaged names are `claude-code`, `codex`,
  `command-code`, `echo`, `grok`, `opencode2`).
- **Recommendation: hold.** Only an already-installed, hand-written home carrying a `claude.json`
  could still need it. Whether such a home exists is **unverified** — a repo audit cannot see
  installed homes. 2 lines; not worth the breakage risk without that check.

### Tier B items re-checked and confirmed still wired — keep as they are

`execution-policy.js` (23 lines, 6 non-test importers) · `workspace-report.js` (33 lines, imported at
`v2-runtime.js:35`) · `v2-presentation.js` (101 lines, 4 non-test refs — Tier C candidate, not
deletion) · `steering.js` (74 lines, 5 non-test refs) · preflight scout (7 non-test, 8 test refs) ·
gap planning (`automaticGapRounds: false` for programs, but gap boundaries live at
`v2-outcome.js:176-219`) · `workflow capabilities.engines.authoredGraphs` (asserted at
`tests/workflow-goal.test.js:194-198`; deleting it would turn explicit retirement into an ambiguous
missing field) · `--strict-orchestrator` and the planner compatibility flags (8 non-test refs) ·
top-level `runs` alias (`cli.js:694-695`) · `workflow watch --classic` and `workflow events` (20
non-test, 10 test refs) · `integrate retire-legacy` (11 non-test refs; it *moves*, does not delete) ·
`bumpVersion` (used internally at `release.js:36` — only the `export` keyword is surplus) ·
`verify.js` content gate (`judgeContent`, 6 non-test and 7 test refs) · invocation usage estimation
(`estimateInvocationUsage`, 3 non-test refs) · `health` versus `workflow runs result` · setup/strategy
overlap · `strategy set-subscription` (consumed by `config.js:75-78`) · `claude-accounts.js` and
`opencode-relay.js` (both are the current generation of their mechanism — see section 7).

### Behaviour findings that are not dead code but should ship with the patch

These came out of the lenses' live probes. They are not deletions, and two of them are more serious
than anything in Tier A.

| # | Finding | Where | How it was seen |
|---|---|---|---|
| D5 | **`state.json` is last-writer-wins with no lock, and a long `run` holds a stale copy for its whole duration.** A concurrent operator write is silently discarded. | `src/lib/state.js:45-51` (bare `writeFileSync`, while `atomicWriteFileSync` already exists at `src/workflow/fsjson.js:18-23`); `src/cli.js:206,218,417`; `src/workflow/v2-dispatch.js:110-121` | With a 9-second `run` in flight, `strategy set-provider beta off --yes` set `beta.enabled = false` (confirmed mid-run); after the run's own `saveState`, `beta.enabled` was **`true`** again, and only 1 decision-log entry survived. The same mechanism can erase a quota quarantine. |
| D3 | **`run --dry-run` can rewrite `state.strategy` and hit the network.** | `maybeRefreshStrategy` at `src/cli.js:217`, 51 lines before the `dryRun` check at `:268` | On a home with `autoApplyRecommendations: true` and a stale `lastRefreshedAt`, a `run --dry-run --json` added **186 lines** to `state.json`, and the persisted report's `openRouter.cache` read `"refreshed"` — a live HTTPS fetch. Contradicts `CHANGELOG.md:238-240`. The decision-log half of that promise is true; the strategy half is not. |
| D1 | **Read-only commands mutate `state.json` on first use**, and the fixture migration force-disables a pool the operator explicitly enabled. | `src/cli.js:672`; `src/setup.js:288-311,366-372` | One `bullswarm pools` turned `echo.enabled` from `true` to `false` and added `testFixturesMigrated: true`. The comment at `setup.js:285-287` claims explicit choices are respected; it cannot tell a post-migration choice from a legacy default. |
| D6 | **Disabled pools are still polled.** | `src/lib/config.js:161-164` polls, `:89` discards | With `beta.enabled = false`, an injected `getReadings` was still asked for `["alpha","beta"]`. On a real home that means a disabled pool's credentials are read and its usage endpoint called on every `pools`, every `run`, and every 15-second V2 refresh. |
| D7 | **A misleading routing reason when the tier allow-list is empty.** | `src/lib/route.js:356-367` | `strategy routes` reported `medium → "no eligible pool with capabilities: code-reading, file-editing"` while all three pools declared both. The true cause, from `strategy rungs --json`, was `"modelSource": "tier-selection-empty"`. |
| — | **The content gate accepts error-shaped structured output.** | `hasStructuredAnswer()` at `src/lib/verify.js:139-153` | `judgeContent('{"error":"provider unavailable"}')` → `{"verdict":"pass","why":"content passed all gates"}`, and a controlled `watchOnce` returning that body produced `{"ok":true,"why":"verified"}`. Related: `scanForFailure()` only inspects the first 400 characters of outputs ≥600 characters (`verify.js:92-96`), so a 401-character prefix followed by `Error: provider unavailable` passed. |
| — | **MCP exposes no workflow tool.** | `mcp/server.mjs:12-39` | Handshake returned version `0.26.0` and exactly three tools: `bullswarm_run`, `bullswarm_health`, `bullswarm_pools`. No way to launch or read a workflow over MCP. Either add one or say the limit is intentional. |

---

## 4. Tier C — refactor opportunities, best value first

Ordered by value over risk: cheap and contained first.

| # | Step | Size | Risk | Why it is worth it |
|---|---|---:|---|---|
| C1 | **Delete the inline third lane table** at `strategy-cli.js:366` and derive `TIER_CONTEXTS[tier].lane` from the 0.26 tables. | 1 line deleted, ~5 changed | Low | Three tables describe one relation and two disagree (B6). One-line fix, removes a whole class of drift between the strategy preview and the V2 validator. |
| C2 | **One `clearTierAssignment(strategy, tier)` helper** to replace five hand-written `delete state.strategy.assignments[tier]` lines (`strategy-cli.js:502,720,783,899`, `strategy-dashboard.js:335`). | ~5 → 1 | Low | Every writer of `modelTiers` must currently remember to clear the overlapping `assignments` entry. Forgetting once leaves the two stores disagreeing about routing. |
| C3 | **Export one strict `finiteOrNull` and delete the five copies.** `meters/framework.js:148` `numberOrNull` · `route.js:114` `num` · `spend.js:64` `num` · `config.js:130` `finiteOrNull` · `openrouter-models.js:15` `finite` · `epoch-benchmarks.js:62` `finite`. | ~30 → ~6 | Low | Not just noise: four of the six reject `''` and booleans (the "a missing measurement never becomes a zero" rule) and two do not, so `Number('') === 0` slips through in the two datapack loaders. This is a latent correctness gap. |
| C4 | **Derive `GENERIC_QUOTA_SIGNATURES` from `DEFAULT_QUOTA_SIGNATURES`** instead of restating 6 of 14 phrases by hand (`quota.js:28-44`, `:54-61`). | ~8 | Low | A phrase added to one list and not the other changes quota detection asymmetrically. |
| C5 | **Extract one `eligibleModelsFor(pool, tier, …)`** and build both projections from it — `buildStrategy` currently scores the same candidates twice (`strategy.js:663-687` and `:688-730` inside a 104-line function). | 68 of 104 | Low-medium | Two nested `pools × tiers` loops that both call `recommendationModels`, both filter on `autoRecommend !== false`, both apply the exclusion set, and differ only in whether the winner is per-pool or global. Blast radius is contained to `tests/strategy.test.js`. |
| C6 | **Extract one `renderTable(header, rows)` and one `formatRoute(route)`**; `strategy-cli.js:48-66` `render()` and `strategy-dashboard.js:113-125` `routeLines()` print the same three route facts with independently written padding, and the pad-to-column-width algorithm exists twice (`strategy-cli.js:335-343`, `strategy-dashboard.js:108-111`). | 32 duplicated, across 911 + 551 lines | Medium | Widest formatting overlap in the codebase; the dashboard then keeps only its cursor and inverse-video concerns. |
| C7 | **Extract the shared "strip vendor prefix, lower-case, collapse separators" step** from the three model-id normalisers (`epoch-benchmarks.js:143-151`, `openrouter-models.js:208-221`, `usage.js:49-61`), and replace `openRouterModelKey`'s hard-coded 7-vendor regex table with a lookup over the datapack's own model keys. | 34 | Medium | A new vendor currently has to be added by hand in two of the three. The datapack already contains every id the table could match. |
| C8 | **Centralise lifecycle status classification.** `src/workflow/status.js` defines terminal/delivered workflow statuses; `v2-state.js:17-20` separately defines planner, action, attempt and lifecycle sets; dashboard and watch each add local terminal sets. | 4 sites | Medium | Preserve legacy `completed_with_concerns` and the V2 action statuses as distinct compatibility values — the point is one classifier, not one vocabulary. |
| C9 | **Split `src/workflow/short-id.js`** into ID/resolution, legacy history, and runner-liveness modules. | 276 | Medium | It currently combines short-ID generation, run resolution, legacy detection, run listing, process liveness, heartbeat liveness, and ongoing-run classification. |
| C10 | **Split `src/help.js`** into per-surface modules, or generate parts from dispatcher metadata. | 1,349 | Medium | Must preserve `HELP_PATHS`, the aliases, and the parser-drift tests — those are what make the 64-path guarantee testable. |
| C11 | **Extract shared liveness/event primitives** from the watch layers: `src/lib/watch.js` 449, `src/workflow/watch-cli.js` 831, `src/lib/run-heartbeat.js` 59, `src/lib/agent-events.js` 233. | 1,572 | Medium-high | They serve genuinely different contracts (single-delegate transport, workflow event watch, heartbeat formatting, connector event decoding) but share liveness and status vocabulary. **Do not merge the user-facing modes.** Note the incident in section 8 lived in exactly this layer. |
| C12 | **Make `paceSnapshot` the single producer of "is this pool near or over its 5h limit"**, have `config.js:141-151` copy its fields instead of recomputing what `framework.js:98-99` already put on the reading, then fold the pre-filter into `route.js` per B1. Five places currently decide this. | layers total 1,509 (route 571, spend 452, framework 209, config 166, forecast 111) | High | Highest-value correctness fix in the codebase — it resolves B1 — and the highest risk, because it sits directly on dispatch. Requires the routing and forecast suites green before and after. |
| C13 | **Split `src/workflow/v2-runtime.js`**: extract planner-boundary handling, action execution, and terminal publication behind tested interfaces. | 1,308 | High | Currently combines leases, resume reconciliation, scout dispatch, caller/dispatched planning, steering, action execution, evidence transport, isolated workspaces, heartbeats, cancellation, result publication and finalization. **Do not attempt without the SIGTERM/SIGKILL, resume, cancellation, evidence and concurrent-action tests.** |
| C14 | **Split `src/workflow/dashboard.js`** into data projection, timeline formatting, static detail output, and interactive terminal control. | 1,920 | High | Largest file in the repo. Still uses V1-era "orchestrator" vocabulary while rendering caller-planner runs. Preserve legacy read-only rendering and the current keyboard behaviour. |
| C15 | **Separate `src/workflow/cli.js`** goal/planning commands from observation and legacy-compatibility commands. | 1,482 | High | Parses flags, resolves planner modes, builds goals, launches detached kernels, manages resume/cancel/steer, prints capabilities, runs watch/events, and handles legacy refusal — all in one file. |
| C16 | **Generate connector schema/reference documentation** instead of maintaining 24 top-level `$comment*` keys across 7 JSON files plus a 96-line `_schema.json`. | 7 files | Medium | Keeps connector quirks declarative and gives B8/B9 a home that cannot drift from the code. |

Do C1-C5 in the patch. Treat C12 as the next real project, because it is the one that fixes a
wrong answer rather than tidying a right one.

---

## 5. Command surface

64 command paths, from
`node -e "import('./src/help.js').then(m => console.log(JSON.stringify(m.HELP_PATHS)))"`.
All 64 rendered with exit `0`, and all 64 contained all seven required rich-help sections (usage,
purpose, args/commands, options, safety, example, next). From `help-probes.json`:
`help paths: 64  exit0: 64  complete: 64`, and the list of paths with any defect is empty.

No public dispatcher verb lacks a help path, and no declared public help path lacks a dispatcher.
Five internal dispatcher-only paths stay undocumented on purpose: `--version`, `strategy help`,
`integrate help`, `workflow plan help`, and the detached `workflow goal --request/--run-id/--quiet`.

### Rows with findings

Full 64-row table in [Appendix A](#appendix-a--full-command-surface-table-all-64-paths). Legend:
`2U` = exit 2 with usage guidance · `2V` = exit 2 with validation guidance · `1V` = validation
message but exit 1, which is wrong · `I` = bogus flags silently ignored · `J*` = JSON always emitted
or the flag has no effect.

| Path | Missing / drift | `--json` | Bad input | Unknown flag | Fix |
|---|---|---|---|---|---|
| `run` | help omits the accepted `--no-caller` | yes | missing lane exits **1** with `FAIL unknown lane undefined`; malformed values correctly exit 2 | `I` | **High priority: require the lane and exit 2** |
| `workflow goal` | none | yes | missing program exits 2 with next commands | `I` — a bogus flag is accepted; the launch itself was not reproduced by the appendix probe (its case exits 2 for a missing program), so "launched a run" is **unverified** | **High priority: reject unknown flags** |
| `workflow plan validate` | none | yes | 2U on missing/invalid program | `I` — valid command plus bogus flag still exit 0 | **High priority: strict flags** |
| `workflow runs` / `runs list` | none | yes | 2U on time filters, but `--limit nope` exits **0** | `I` | Reject invalid numeric limits |
| `workflow capabilities` | usage omits the advertised `--json` | `J*` always JSON | 1 on live-pool failure | `I` | Add `[--json]` to usage, or delete the flag |
| `health` | none | `J*` always JSON | semantic unhealthy result exits 1 | `I` | Document that output is always JSON |
| `version` | package reports `0.26.0`, help and release context say `0.27.0` | no | — | `I` | **Reconcile version metadata** |
| `workflow` (root) | one root example omits the required `--program`, `--scout` or `--orchestrator` | no | non-TTY prints help, exits 2 | `I` | Fix the invalid example |
| `integrate` + all 4 subcommands | parent help omits install/remove `--yes` context | yes | `1V` on bad agent and on missing `--yes` | `I` | Change approval/bad-agent errors to exit 2 |
| `strategy set-provider`, `set-model`, `reset-tier`, `set-reasoning`, `set-rung`, `reset-reasoning`, `configure`, `apply`, `assign`, `clear-assignment`, `exclude-model`, `include-model`, `set-subscription`, `auto`, `auto status`, `auto off` (16 paths) | no advertised JSON, but output is always JSON | not offered; always JSON | 2U / 2V | `I` | Document the output format, or add `--json` |
| `strategy inventory` / `strategy routes` | none | yes, but **inert** — see B4 | `1V`/`2V` on discovery errors | `I` | Delete the flag and fix `help.js:422-431` |
| `strategy rungs` | none | yes | `--pool` with no value becomes `unknown pool "true"`, exit 2 | `I` | Improve the missing-value message |
| `strategy tui` | none | no | exits 1: requires a TTY | `I` | Message is clear; exit 2 would be more correct for a usage error |
| `workflow tui` | non-TTY without an ID requires `--json` or an ID; help is broad | yes | bare non-TTY exits 1 | `I` | Clarify the non-TTY refusal in help |
| `setup`, `pools`, `assignments`, `doctor` | none | yes | nothing meaningful / readiness failure exits 1 | `I` | Strict flags |

### The unknown-flag problem, reproduced today

Fixture home `/tmp/bullswarm-audit/report-home.8wkEbT`, `BULLSWARM_DISABLE_CLAUDE_PROFILES=1
BULLSWARM_DISABLE_OPENCODE_RELAY=1`, no provider dispatched:

```
$ node bin/bullswarm.js run --lane analyze --bogus-flag --dry-run probe
exit=0
OK (keep-on-caller) caller pool won the lane; keep work in-session

$ node bin/bullswarm.js pools --bogus-flag
exit=0
claude-code    cost=4 lanes=analyze/build/chore unmetered surplus=0 inflight=0 ready

$ node bin/bullswarm.js strategy rungs --bogus-flag
exit=0
no rungs yet: enable a provider pool and configure an effort tier …

$ node bin/bullswarm.js workflow runs list --bogus-flag
exit=0
no ongoing runs (try --all to see historical)

$ node bin/bullswarm.js assignments --bogus-flag
exit=0
no in-flight assignments
```

And the two malformed-input cases:

```
$ node bin/bullswarm.js run --add-dir . --dry-run probe
exit=1
FAIL unknown lane undefined            # should be exit 2 with a required-lane fix

$ node bin/bullswarm.js workflow runs list --limit nope
exit=0                                  # invalid numeric input silently ignored
```

`behavior-probes.json` records the same 26 probes from the command lens, including two that show the
validation *is* right where it was written: `run --lane analyze --heartbeat nope` → exit 2,
`--heartbeat must be a number...`, and `run --lane analyze --effort extreme` → exit 2,
`--effort must be high, medium, or low`. The gap is that only selected fields are checked.

Non-TTY behaviour is sane everywhere it was tested: piped `run --dry-run` produced the normal human
summary without prompting; bare non-TTY `workflow` printed help and exited 2; `strategy tui` exited 1
with `strategy tui requires an interactive terminal`; `workflow tui` without an ID exited 1 with
`workflow dashboard requires a TTY, or pass a run ID for a static text tree`.

### Overlap decisions

| Overlap | Decision |
|---|---|
| `workflow runs` vs top-level `runs` | Keep `workflow runs` canonical; retain `runs` as a short alias. The skill should teach the canonical form. |
| `strategy refresh` vs `recommend` | Keep `refresh`. Retain `recommend` — but add the missing test (B2). |
| `strategy show` vs `inventory` | Keep both. `show` is the last strategy report; `inventory` is the agent-facing full machine document. |
| `strategy routes` vs `rungs` | Keep both. `routes` answers "what will route now"; `rungs` answers "which model/reasoning/evidence/record backs each pool-tier choice". `rungs` is also the only one that gives the true cause when a tier allow-list is empty (D7). |
| `health` vs `workflow runs result` | Keep both. `health` is a global verifier/quarantine signal; `runs result` is the stable per-run delivery envelope. |
| `doctor` vs `integrate status` vs `pools` | Keep all three: installation readiness, agent integration, routing/quota/load. |
| `workflow capabilities` vs `pools` vs `strategy inventory` | Keep all three: engine constraints, live quota state, models and assignments. |

### Skill cross-check

28 unique command forms extracted from `skill/SKILL.md` and `skill/references/operations.md` were
run with `--help`. **All 28 returned exit 0** (`skill-command-help.json`: `entries: 28  exit0: 28`),
including equals-form flags such as `--cwd=<abs-dir>` and `--program=plan.json`. The documented agent
path is covered with no detours: choose `run` or `workflow goal` → `workflow plan contract` →
`workflow plan validate` → `workflow goal --program` → `workflow watch --next` → repeat with
`--after`/`--since` → `workflow runs result --json`.

Two problems with the skill text:

1. **One contradiction.** `operations.md:60-63` says `--classic` is a no-op for legacy runs; the CLI
   and implementation refuse legacy watching with exit 2 *before* polling. **Keep the fail-closed CLI
   behaviour and fix the skill.**
2. **One omission that matters for agent safety.** The skill does not warn that unknown flags are
   currently ignored. An agent that typos a flag gets exit 0 and no signal.

Also confirmed from `skill-help-checks.tsv`: `workflow capabilities --json --help` prints
`Usage: bullswarm workflow capabilities` — the synopsis really does omit `[--json]`.

### Ease-of-use verdict

The hierarchy and the help renderer are genuinely strong. All 64 paths are discoverable, structurally
complete, and machine-readable, and the agent flow reads cleanly end to end. **Ease of use is
moderate for a careful operator and unsafe for a typo-prone agent**, for one reason: bogus flags pass
through silently and some malformed values return exit 0 or exit 1 where exit 2 is the contract. An
agent that misspells a flag on `workflow goal` does not get an error — it gets a launched run.

### The five fixes that matter most

1. **Reject unknown flags centrally.** Report `unknown flag --name`, print the relevant help path,
   exit 2. This single change fixes the `I` column on all 64 rows.
2. **Validate required and typed inputs at the boundary** — especially `run --lane`,
   `workflow runs --limit`, flags given without a value, and integration agent names.
3. **Align help with actual behaviour**: add `run --no-caller`, add `--json` to
   `workflow capabilities` usage, document the always-JSON strategy mutations, and replace the
   invalid bare `workflow goal` example.
4. **Correct the `--classic` statement** in `skill/references/operations.md`.
5. **Reconcile `0.26.0` against `0.27.0`** across `package.json`, `bullswarm version`, the changelog,
   README and `AGENTS.md`.

---

## 6. README and documentation

### README.md findings

Every line number below was re-read in this workspace.

| Line | Finding | Evidence | Fix |
|---|---|---|---|
| `README.md:116` | Claims the `runs` alias includes **cleanup** operations. It does not. | `sed -n '116p' README.md` → ``\| `runs` \| Short alias for `workflow runs`, including list, show, result, delete, and cleanup operations. \|``. `src/workflow/runs-cli.js:41-49` dispatches only `list`, `show`, `result`, `delete`. `node bin/bullswarm.js workflow runs cleanup` → **exit 2** | Remove "and cleanup" |
| `README.md:91` | Says bare `bullswarm` launches an interactive setup wizard on first run. True only on a TTY. | `sed -n '91p' README.md` → `bullswarm          # first run: interactive setup wizard`. `src/cli.js:678` → `if (opts.yes \|\| !process.stdin.isTTY) return cmdSetup({ ...opts, yes: true });` — non-TTY callers self-initialize silently | Qualify as "on a TTY" |
| `README.md:183-208` | Claims two replaceable benchmark assets with a bundled fallback. The OpenRouter bundled file does not exist. | `ls data/` → `README.md`, `epoch-benchmarks.json` only. `src/lib/openrouter-models.js:13` builds the path and `:159` uses it as the `bundledFile` default. Offline probe: OpenRouter `cache=miss models=0`; Epoch `cache=bundled records=547` | Commit a seed pack, or drop the `bundledFile` tier so offline behaviour is honest |
| `README.md:342-346` and `README.md:505-510` | The soft planning-target explanation is duplicated almost verbatim. | Both passages open `` `--max-agents`, `--max-actions`, and `--max-expansion-rounds` are soft V2 planning targets `` | Keep one canonical explanation; link to it from the other section |
| `README.md:572` | Comment says `--name` filters "by workflow"; it is an exact goal/workflow-name filter. | `sed -n '572p' README.md` → `bullswarm workflow runs --name audit-code  # filter by workflow`; `src/workflow/runs-cli.js:6-8` | Say "filter by exact goal/name" |
| `README.md:152-313` and `612-780` | A 162-line rungs section and a 169-line dashboard section duplicate detailed command help. | Line ranges measured in the file | Keep concise operational guidance; link to command help |
| `README.md:585, 651` | Legacy-run behaviour and the 0.27.0 executor-removal message match the implementation but conflict with the version the CLI reports. | `sed -n '585p' README.md` → `removed in 0.27.0; files remain under <dir>` and exits 2`; `node bin/bullswarm.js version` → `0.26.0` | Resolve with the version reconciliation |
| `README.md:249, 264` | **Correct.** 75 % near-limit and 90 % forecast gate match the code. | `sed -n '249p;264p' README.md` → `` `FIVE_HOUR_NEAR_LIMIT_PCT` (75) `` and `` `BURST_BLOCK_PCT` (90) ``; both live in `src/meters/framework.js:47,49` | none |
| `README.md:511-517, 599-603` | **Correct.** Shared-workspace program execution and the separate `verified` qualification match `src/workflow/cli.js:482-489, 1159-1179`. | as cited | none |
| `README.md:282-298` | **Correct.** In-flight load and the 500-line meter history match `src/meters/registry.js:153-166`. | as cited | none |
| `README.md:14-15, 31-35, 98-101, 319-340, 430-463, 568-580` | **Correct.** The documented `run`, `workflow goal`, `workflow plan`, `runs`, `watch`, `tui`, `events` and `action show` surfaces all exist. | checked against the help tree and fixture execution | none |

### Other required files

| File:line | Finding | Fix |
|---|---|---|
| `AGENTS.md:34-36` | Describes 0.27.0 behaviour as installed. `sed -n '34,36p' AGENTS.md` → "Their executor was removed in 0.27.0", while `package.json:3` and `bullswarm version` both report `0.26.0`. | Align the version metadata before release, or stop documenting unreleased behaviour as installed |
| `AGENTS.md:41-71` | **Correct.** Test, doctor, workflow, run-history, recursion, dependency and release guidance match the current CLI. The full suite is offline. | none |
| `GOAL.md:26-32` | Still describes a four-verb prototype as the intended outcome. `sed -n '26,32p' GOAL.md` → "**`bullswarm` CLI** with four verbs" listing `setup`, `run`, `health`, `pools`. The CLI now has 64 help paths and exactly two work-entry points. | Mark as a historical prototype charter, or rewrite |
| `GOAL.md:112-119` | "No measured routing table yet" is stale against the current strategy, meter, rungs and invocation-telemetry implementation. | Move to historical project rationale |
| `data/README.md:7-12` | Says both datapacks have a bundled fallback. `sed -n '7,12p' data/README.md` → "then the copy bundled in this directory". The OpenRouter bundled file is missing. | Restore the asset, or correct the statement |
| `data/README.md:42-48` | **Correct.** The Epoch refresh command and source paths are consistent with `.github/workflows/refresh-benchmarks.yml`. | none |
| `skill/SKILL.md:8-15, 17-23, 44-115` | **Correct.** Caller-planner, shared-workspace, evidence-envelope, routing and observation flow are consistent with the CLI. No stale behaviour claim found. | none |
| `skill/references/operations.md:60-63` | `--classic` is described as a no-op for legacy runs; it is rejected with exit 2 before polling. | Say it applies only to V2 and that legacy runs are refused |
| `skill/references/operations.md:217` | Names `workflow-v1` as an assignment source — the only remaining mention of the string the Tier A patch deletes. | Update with the patch |
| `skill/references/operations.md:3-31, 67-84, 161-185, 274-278, 311-331` | **Correct.** Workflow, resume, isolation, evidence, recovery and strategy guidance match the implementation. | none |

### Cross-document contradictions

| # | Contradiction | The two sides |
|---|---|---|
| 1 | **Release version** | `AGENTS.md:35` and README legacy text say executor removal happened in `0.27.0`, and `CHANGELOG.md:3` declares `0.27.0` — but `grep -n '"version"' package.json` → `3:  "version": "0.26.0",` and `node bin/bullswarm.js version` → `0.26.0`. The repository is split between its release notes and its installed metadata. |
| 2 | **Number of entry points** | `README.md:11-26` and `skill/SKILL.md:17-23` both say exactly two ways to start work. `GOAL.md:26-32` still presents the four-verb prototype. |
| 3 | **Planner mode** | `README.md:316-340` says caller-authored `--program` is the default and `--orchestrator` is explicit. `docs/claude-dynamic-workflow-mechanics.md:42-46` still says `workflow goal` "runs an LLM *at every checkpoint*" without limiting that to the older engine. |
| 4 | **Workspace policy** | `README.md:511-517` and `src/help.js:770` say shared workspace by default. `docs/experiments/2026-09-06-caller-planner-evaluation.md:118-120` says isolated worktrees were the default. Historical, but needs a banner. |
| 5 | **Action vocabulary** | `README.md:378-402` defines the V2 `kind` values. `docs/workflow-design.md:70-116, 190-197` still presents `run`, `fanout`, `verify`, `decide` as the active schema. |
| 6 | **`bullswarm delegate`** | `docs/design/2026-09-06-caller-first-cli.md:123-134` documents `delegate` as current — `sed -n '123,127p'` → "## `bullswarm delegate`" / "`delegate` keeps its single-agent branch unchanged". But `CHANGELOG.md:81-92` states it was removed, and `node bin/bullswarm.js delegate` → `unknown verb "delegate". Run "bullswarm --help" for the list of commands.` |

### `docs/` classification

| File | Size / date | Class | Note |
|---|---|---|---|
| `docs/claude-dynamic-workflow-mechanics.md` | 26,589 B; dated 2026-08-29, updated 2026-09-08 | **Stale-misleading** | `:42-46` describes every `workflow goal` as an LLM checkpoint loop, despite caller-planner program execution being current. Rewrite that paragraph to name it as pre-caller-planner behaviour. |
| `docs/design/2026-09-06-caller-first-cli.md` | 8,606 B; dated 2026-09-06 | **Stale-misleading** | `:123-134` presents `bullswarm delegate` as live after its removal. Remove the section or mark it superseded. |
| `docs/workflow-simplification.md` | 12,875 B; live acceptance dated 2026-09-08 | **Current** | Claims match current V2 source and tests. |
| `docs/studies/portal-token-diet.md` | 17,793 B; no self-dated sentence, committed 2026-09-09 | **Current** | Add a study date for reproducibility. Also the only citer of `connectors/_schema.json` (see B8). |
| `docs/dynamic-workflow-handoff.md` | 24,899 B; historical 2026-08-21 | **Historical-keep** | Already has an explicit historical banner. Retain as is. |
| `docs/workflow-design.md` | 10,521 B; created 2026-08-21 | **Historical-keep** | Lines `3-7` already identify it as historical. Retain. |
| `docs/dynamic-workflow-qa.md` | 6,601 B; verified 2026-08-27 | **Historical-keep** | Add a one-line banner: `:61` still shows the old `--detach` zero-graph launch. |
| `docs/dynamic-workflow-v2-execution-plan.md` | 44,393 B; written 2026-08-31, baseline 0.21.0 | **Historical-keep** | Add a banner saying it is a dated plan, not the current capability matrix. |
| `docs/integration-audit-2026-08-31.md` | 25,704 B; dated 2026-08-31, version 0.20.0 | **Historical-keep** | Add a historical banner. |
| `docs/planner-prompt-audit-2026-08-29.md` | 12,802 B; dated 2026-08-29 | **Historical-keep** | Add a historical banner. |
| `docs/workflow-agent-usability-audit-2026-08-27.md` | 13,961 B; dated 2026-08-27 | **Historical-keep** | Add a banner; its `0.7.2`/`0.4.0` version-skew findings are not current product status. |
| `docs/experiments/2026-08-28-trending-ai-autonomy.md` | 11,965 B; dated 2026-08-28 | **Historical-keep** | Add a historical banner. |
| `docs/experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm.md` | 49,163 B; dated 2026-08-29, documents 0.13-0.21 runs | **Historical-keep** | Add a historical banner. |
| `docs/experiments/2026-08-29-ultracode-vs-bullswarm.md` | 41,870 B; dated 2026-08-29, versions 0.10.9-0.13.1 | **Historical-keep** | Add a historical banner. |
| `docs/experiments/2026-08-31-v2-component-probes.md` | 3,421 B; dated 2026-08-31, candidate revision `0030e12` | **Historical-keep** | Add a historical banner. |
| `docs/experiments/2026-09-06-caller-planner-evaluation.md` | 19,291 B; dated 2026-09-06, versions 0.23.2→0.24.0 | **Historical-keep** | Add a historical banner; it is side 2 of contradiction 4. |
| `docs/audits/2026-09-09-codebase-audit.md` | this file | **Current** | — |

**17 files: 2 stale-misleading, 3 current, 12 historical-keep.** Ten of the twelve need a banner —
`docs/dynamic-workflow-handoff.md` and `docs/workflow-design.md` already have one.

### The ten documentation fixes that matter most

1. Align `package.json`, `bullswarm version`, `CHANGELOG.md`, README and `AGENTS.md` around the
   actual release version. This is the single most-reported defect: all three code lenses, the
   command lens and the docs lens each found it independently.
2. Remove the nonexistent `runs cleanup` claim (`README.md:116`).
3. Qualify the bare-`bullswarm` setup behaviour by TTY versus non-TTY (`README.md:91`).
4. Restore `data/openrouter-benchmarks.json` or correct the bundled-datapack claim in both
   `README.md:183-208` and `data/README.md:7-12`.
5. Move `GOAL.md` to historical project rationale, or rewrite its prototype outcome and non-goals.
6. Correct or supersede the live `delegate` section in `docs/design/2026-09-06-caller-first-cli.md`.
7. Clarify the stale checkpoint-loop paragraph in `docs/claude-dynamic-workflow-mechanics.md:42-46`.
8. Add explicit historical banners to the nine dated audits, experiments, plans and acceptance
   documents listed above.
9. Consolidate the duplicated README planning-target material and shorten the oversized rungs and
   dashboard sections.
10. Correct the `--classic` legacy-run statement in `skill/references/operations.md:60-63`, and add
    the warning that unknown flags are currently ignored.

---

## 7. Refuted candidates — looked dead, is used

Nine candidates the lenses called dead survived an experiment. Where a lens and the refuter disagree,
**the refuter's empirical result wins**, and it is said so explicitly in each row below.

| Candidate | Called dead by | What actually keeps it alive | Result of deleting it |
|---|---|---|---|
| `bin/check-v2-evidence.js` (26 lines) | the **run lens** and the **reachability report** — both wrong; the workflow lens got it right | Not imported by anything. `evidence-output.js:174` builds the path with `new URL('../../bin/check-v2-evidence.js', import.meta.url)`, and `v2-runtime.js:365` embeds the resulting shell command in **every worker prompt**. A worker process runs it. | Case R7 → `not ok 391 - CLI returns deterministic statuses for valid, invalid, malformed, and usage input` |
| `bin/check-v2-plan.js` (36 lines) | the **run lens** and the **reachability report** — both wrong | Same mechanism: `v2-planner.js:508` plus `v2-runtime.js:831`, embedded in every planner prompt | Case R8 → `not ok 577 - planner checker enforces the exact scout unit handoff used by runtime` |
| `connectors/command-code.json` | the reachability report's "unreferenced assets" list (which flagged this caveat itself) | Dynamically scanned by `src/setup.js:85-112` — nothing names the file as a literal | Case R15 → **648 tests, 644 pass, 4 failures across 3 test files** |
| The 23 `fixtures/failures/*` and `fixtures/real/*` files | the reachability report's "unreferenced assets" list | `tests/verify.test.js:12-21` `readdirSync`s both directories | Case R16 → **658 tests, 658 pass, 0 fail** — the suite went *green while losing a test case*. This is the most dangerous kind of false positive, and it is now B10. |
| `workflow` flags `concurrency`, `max-actions`, `max-agents`, `max-expansion-rounds`, `no-scout`, `retry-attempts` | the reachability report's `flags.json` "documented-but-unread" list — a **false positive** | All six *are* read, through a rename table in `goalSettings()` that uses computed access `opts[flag]` at `src/workflow/cli.js:118-131`. `--no-scout` is read as `opts.noScout` at `cli.js:481`. A static flag analyzer cannot follow computed property access. | not deleted — refuted by reading the code |
| `connectors/opencode2.json:31-32` `preferredConcurrency` | the routing lens as Tier A3 | `src/setup.js:270` copies the field forward on upgrade, and `tests/setup.test.js:162` asserts it | Case R13 → `not ok 176 - connector metadata upgrades additive provider concurrency preferences`. **Downgraded to B7.** The routing lens's underlying observation still stands: no routing code *reads* it. |
| `connectors/_schema.json` (96 lines) | the reachability report as Tier A | Genuinely dead to code (`setup.js:89` skips `_`-prefixed files) and case R12 gave **659/659/0** — but `package.json files[]` ships `connectors/`, `docs/studies/portal-token-diet.md:78` cites it, and it is the only connector-format reference | **Downgraded to B8: fix it, do not delete it.** |
| `src/lib/claude-accounts.js` (202 lines) | the audit brief's premise ("versus the `claude-code:<name>` pool mechanism") | **This file *is* that mechanism.** `poolNameForSlug` (`:48-50`) mints `claude-code:<slug>`; `expandClaudeAccountConnectors` (`:160-201`) clones the connector per login; `config.js:34` calls it on every `loadConnectors`; `registry.js:12,26-40` routes the meter per seat | not deleted — there is no separate mechanism to compare against |
| `src/lib/opencode-relay.js` (131 lines) | the audit brief | Live via `config.js:35` and `registry.js:13,42-55` | not deleted. One thing to watch: `retargetOpenCodeModel` (`:31-46`) hard-pins `--model <providerId>/gpt-5.6-luna` into `connector.spawn.cmd` at load time, and a 0.26 rung appends its own `--model` later, so two model flags coexist on one command line. Which one the OpenCode CLI honours is **unverified** — it needs a real provider. |
| `data/openrouter-benchmarks.json` | the routing lens as Tier A6 | Nothing to delete — the file **is already absent**. `openrouter-models.js:13` builds the path, `:159` uses it as the `bundledFile` default. It is a missing asset, not dead code. | reclassified: a documentation and packaging defect (section 6, fix 4) |
| Every `src/meters/*` module (914 lines across 5 files) | the audit brief ("meter frameworks for providers no longer configured") | Every meter maps to a packaged connector: `claude.js`→`claude-code`, `codex.js`→`codex`, `command-code.js`→`command-code`, `grok.js`→`grok`, `relay.js`→`opencode2*`, via `READERS` at `registry.js:18-24` and `readerFor` at `:57-65` | **No orphans.** Only two leftovers, 1-2 lines each: the `claude` alias key (now B11) and `monthlyWindowMs` (`framework.js:155`), documented as "Copilot/cmd period-end semantics" while no Copilot connector exists — the function itself is live for `command-code`. |
| `reconcileInterruptedRun(s)` | the audit brief, as a candidate to judge | Already gone. `e8c841a` removed the V1 stale-owner reconciliation with the V1 executor. The only match left is a historical test comment at `tests/workflow-dashboard.test.js:1039`. | no action remains |
| ~34 "never-imported" exports in `src/lib/route.js`, `spend.js`, `quota.js`, `state.js`, `strategy.js`, `forecast.js`, `reasoning.js`, `verify.js`, `watch.js` and the meters | the reachability report's never-imported list | They all have real in-file callers — only the `export` keyword is surplus, not the code. Examples: `route.js:53 elapsedPct` used at `:84`; `route.js:67 costOf` at `:426`; `route.js:189 inflightLoad` at `:305`; `route.js:239 isExhausted` at `:300,414`; `state.js:18 DEFAULT_STATE` at `:32,36,38,41`; `strategy.js:21 isModelExcluded` at `:196,217,224,232,698` | not deleted — "never imported" is not the same as "never called" |
| `src/lib/release.js:17 bumpVersion` | the reachability report and the workflow and run lenses, as a tests-only export | Used internally at `release.js:36` | keep the function; only the `export` keyword is surplus |
| `src/help.js:1280 HELP_PATHS` | flagged tests-only by the analyzer — the reachability report offered this as its own deliberate false-positive example | It drives the help test enumeration and is exported for that contract on purpose | keep |

**Eight of these were verdicts the refutation pass reversed or downgraded** — the first seven rows
of the table above plus `data/openrouter-benchmarks.json`. The remaining rows in the table refute a
premise in the audit brief rather than a lens verdict, or record a deliberate false-positive example.

**The pattern worth naming.** Every single false positive came from one of three blind spots: a path
built at runtime with `new URL(...)` and executed as a shell command; a directory scanned with
`readdirSync`; or a flag read through computed property access `opts[flag]`. A static analyzer cannot
see any of the three. That is why the refutation pass existed.

---

## 8. Audit-run incidents — what the audit learned about its own workers

Two things went wrong while producing this report. Both are findings about worker reliability per
pool, and both are recorded here because they are more actionable than anything in Tier A.

### Incident A — a flooding worker killed the kernel twice, and `watch` could not tell you

**What happened.** A `command-code` worker's stdout grew past Node's maximum string length. The
stream handler in `src/lib/watch.js` appends each chunk to one accumulating string, so the append
threw, inside an event handler, in the detached kernel process — which killed the kernel and every
worker under it. It happened **twice** during the `reachability` action.

**The trace**, from `~/.bullswarm/goals/wf-mttj9k9w-baca81/stderr.log`, which contains this block
exactly twice:

```
file:///Users/cowcow02/Repo/bullswarm/src/lib/watch.js:207
      stdout += d;
                ^

RangeError: Invalid string length
    at Socket.<anonymous> (file:///Users/cowcow02/Repo/bullswarm/src/lib/watch.js:207:17)
    at Socket.emit (node:events:518:28)
    at addChunk (node:internal/streams/readable:561:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:512:3)
    at Readable.push (node:internal/streams/readable:392:5)
    at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)

Node.js v22.17.0
```

The unbounded append is still present in this workspace:

```
$ sed -n '205,207p' src/lib/watch.js
    child.stdout.on('data', (d) => {
      stdout += d;
```

**What the operator saw instead.** Two `interrupted` attempts with a generic reason:

```
reachability  attempt 1  interrupted  03:22:56.433Z → 03:51:36.300Z
              why: "runner stopped before the attempt reached a durable terminal state"
reachability  attempt 2  interrupted  03:51:36.447Z → 04:22:51.149Z
              why: "runner stopped before the attempt reached a durable terminal state"
```

**The observability gap, measured.** The string `RangeError` appears **0 times** in `events.jsonl`,
**0 times** in `result.json` and **0 times** in `state.json` for that run. And the event stream shows
the shape of the loss directly:

```
$ grep -o '"type":"[a-z.-]*"' events.jsonl | sort | uniq -c | sort -rn
   9 "type":"action.finished"
   8 "type":"attempt.started"
   8 "type":"action.started"
   6 "type":"attempt.finished"
   2 "type":"workflow.resumed"
   1 "type":"workflow.started"
   1 "type":"workflow.finished"
   1 "type":"planner.finished"
```

Eight attempts started, six finished. The two killed attempts never emitted `attempt.finished`, so
`workflow watch` — which reads `events.jsonl` — had nothing to show but a run that stopped moving.
The only record of *why* was a file `watch` never reads.

**The fix, on the PR branch.** Commit `16dddb0` on `feat/one-workflow-engine`:

```
$ git show --stat 16dddb0
commit 16dddb00689acd67413f1902b9b7b25b6b029092
Date:   Wed Sep 9 12:22:30 2026 +0800

    fix(watch): bound worker stream capture so a flooding worker cannot kill the kernel
    …
 CHANGELOG.md        |  15 ++++++-
 src/lib/watch.js    | 113 ++++++++++++++++++++++++++++++++++++++++++----------
 tests/watch.test.js |  47 +++++++++++++++++++++-
 3 files changed, 153 insertions(+), 22 deletions(-)
```

It introduces a bounded head-plus-tail capture:

```
+export const MAX_CAPTURED_STREAM_BYTES = 32 * 1024 * 1024;
+export class BoundedCapture {
+  constructor(limit = MAX_CAPTURED_STREAM_BYTES) {
…
+      captureTruncated: { stdout: stdoutCapture.dropped, stderr: stderrCapture.dropped },
```

32 MiB per stream, first and last half kept, dropped characters counted on the observation, and a
throw while reading a worker now fails **the attempt**, not the kernel. Fatal-signature matching
already used only the last 4,000 characters, so quota and auth detection are unchanged.

The timeline supports the fix: `16dddb0` is dated `2026-09-09 12:22:30 +0800` = `04:22:30Z`; the
kernel's last resume launched at `04:22:47.671Z` (`launcher.json`), 17 seconds later; and attempt 3
of `reachability` then succeeded (`04:22:51.305Z → 04:35:37.441Z`, `why: "verified"`).

**This fix is not in the audited tree.** `git merge-base --is-ancestor 16dddb0 HEAD` → not an
ancestor, and `grep -c 'BoundedCapture' src/lib/watch.js` → `0`. Anything running from this branch,
or from the main checkout at `890b4b9`, still has the unbounded append.

**Two things to carry forward.**

1. **Land `16dddb0` before 0.27.1.** A worker that talks too much should not be able to kill the
   supervisor and its siblings. It is a denial-of-service by verbosity, from the inside.
2. **Surface `stderr.log` on dead-kernel detection.** When the kernel dies without writing a
   terminal attempt state, `watch` and `runs show` should say so and print the tail of
   `~/.bullswarm/goals/<runId>/stderr.log`. Today the reason exists on disk and no command shows it,
   which turns a five-second diagnosis into an hour of guessing. Attach it to the existing
   `interrupted` reason — that reason is where an operator already looks.

### Incident B — a worker announced its plan instead of doing the work, and burned 4m43s

**What happened.** The `lens-routing` action, attempt 1, was rejected by the content gate:

```
lens-routing  attempt 1  failed
  pool: command-code   model: gpt-5.6-luna
  reasoning: { requested: "max", applied: "max", source: "strategy-pool", clamped: false }
  startedAt:  2026-09-09T04:35:39.767Z
  finishedAt: 2026-09-09T04:40:22.520Z
  why: "announcement without substance"
  usage.tokens: { standardRead: 1626, output: 64, totalKnown: 1690 }
  tokenSource: "estimated:utf8-bytes/4"
  cost.estimatedUsd: 0.000402
```

Elapsed = `04:40:22.520 − 04:35:39.767` = **282.75 s = 4 m 42.8 s**. (The audit brief rounds this to
4m45s; the timestamps give 4m43s, and the timestamps are the source.)

The entire output was **253 bytes** — `out-lens-routing-attempt-1.md`, quoted in full:

> I'll seed the temporary home with `connectors/echo.json`, a configured state, and no provider
> credentials. Then I'll run `pools`, `strategy inventory --json`, `strategy rungs`, and
> `run --dry-run`, capturing exit codes, outputs, and file-tree diffs.

That is a statement of intent. It contains no finding. 64 output tokens at
`estimated:utf8-bytes/4` ≈ 256 bytes, consistent with the 253 measured bytes.

**The gate worked.** `semantic: announcement without substance` is exactly the right verdict, and it
is worth noting that this is the failure mode the `fixtures/failures/13-announcement-477b.json`
fixture exists to cover — one of the 23 fixtures that case R16 showed can be deleted without turning
the suite red (B10).

**The attempt table for the whole run** — every attempt of `wf-mttj9k9w-baca81`, from
`node bin/bullswarm.js workflow runs show e8ffk2 --json`:

| Action | Attempt | Pool | Model | Reasoning | Started → finished | Status | Why | Output tokens |
|---|---:|---|---|---|---|---|---|---:|
| `reachability` | 1 | `command-code` | `gpt-5.6-luna` | max | 03:22:56.433 → 03:51:36.300 | **interrupted** | runner stopped before the attempt reached a durable terminal state | — |
| `lens-commands` | 1 | `command-code` | `gpt-5.6-luna` | max | 03:22:56.453 → 03:34:34.020 | succeeded | verified | 3,977 |
| `lens-docs` | 1 | `command-code` | `gpt-5.6-luna` | max | 03:22:56.469 → 03:31:00.807 | succeeded | verified | 2,937 |
| `reachability` | 2 | `command-code` | `gpt-5.6-luna` | max | 03:51:36.447 → 04:22:51.149 | **interrupted** | runner stopped before the attempt reached a durable terminal state | — |
| `reachability` | 3 | `command-code` | `gpt-5.6-luna` | max | 04:22:51.305 → 04:35:37.441 | succeeded | verified | 6,617 |
| `lens-routing` | 1 | `command-code` | `gpt-5.6-luna` | max | 04:35:39.767 → 04:40:22.520 | **failed** | announcement without substance | **64** |
| `lens-workflow` | 1 | `command-code` | `gpt-5.6-luna` | max | 04:35:39.787 → 04:44:50.830 | succeeded | verified | 3,316 |
| `lens-run` | 1 | `command-code` | `gpt-5.6-luna` | max | 04:35:39.804 → 04:50:21.554 | succeeded | verified | 3,381 |

**Every attempt of this run landed on `command-code` / `gpt-5.6-luna` / reasoning `max`, with
`source: "strategy-pool"`.** Eight for eight. There was no variation to compare against.

**What this says about the medium rung.** Five of eight attempts succeeded on this rung and produced
substantial work — the `lens-commands`, `lens-docs`, `lens-run`, `lens-workflow` and `reachability`
outputs in this report are all its output, between 2,937 and 6,617 tokens each. So the rung is
capable. But one attempt in eight returned an announcement, and the announcement cost the same
4-minute wall clock as real work while producing 64 tokens — 1.6 % of the median successful output.
Three observations follow, and the limits of each:

1. **The routing evidence is not a comparison.** Because all eight attempts used one pool, model and
   reasoning level, this run says nothing about whether another rung would have done better. Any
   claim that `command-code gpt-5.6-luna` is worse or better than an alternative for lens work is
   **unverified** — there is no control group in this data.
2. **`reasoning: max` did not prevent the failure.** The failed attempt requested and applied `max`,
   unclamped, from `strategy-pool`. Turning reasoning up is not a defence against a worker that
   decides to describe the task instead of doing it.
3. **The gate is the load-bearing part, and it earned its keep.** `verify.js`'s content gate caught
   this in one attempt for $0.0004, and the retry on the same rung produced the 42.6 KB routing lens
   this report's sections 3, 4 and 5 draw on. Keep the gate (it is on the Tier B keep list), and
   **keep it covered** — which is exactly why B10 matters, since its fixtures can currently be
   deleted without a red test.

**One process observation.** The `refute` action was the highest-value action in this workflow and
it is the reason nine candidates in section 7 are not in the patch scope. An audit that had stopped
at the three lenses would have proposed deleting two files that every worker prompt executes.

---

## 9. How this was measured

### The four analyzers

All four live under `/tmp/bullswarm-audit/` and are plain zero-dependency Node. Their source is
copied verbatim into [Appendix B](#appendix-b--analyzer-scripts-verbatim) so this report stands
alone. Each writes its JSON next to itself (`outDir` is the script's own directory), never into the
repository.

| Script | Lines | What it does | Output |
|---|---:|---|---|
| `graph.mjs` | 224 | Parses every `.js`/`.mjs` under `src/`, `bin/`, `mcp/`, `scripts/` for static `import … from`, `export … from` and dynamic `import('…')` of relative paths. Entry roots: `bin/bullswarm.js`, `mcp/server.mjs`, every `scripts/*.mjs`, every path in `package.json` `bin`/`scripts`, and every `node …` command in `.github/workflows/*.yml`. Then, per exported symbol, every non-test file that imports it by name. | `reachability.json`, `exports.json` |
| `identifiers.mjs` | 82 | For every top-level function/const/class in `src/**`, counts bare-identifier occurrences (word boundary) across `src`, `bin`, `mcp`, `scripts`, `connectors`, `skill`, `tests`, `.github`, `README.md`, `AGENTS.md`. | `identifiers.json` |
| `assets.mjs` | 38 | For every file under `fixtures/`, `data/`, `connectors/`, checks whether its basename or relative path appears as a literal anywhere in src/tests/scripts/.github/package.json. | `assets.json` |
| `flags.mjs` | 122 | Per command, collects flag names the parser accepts versus flag names `src/help.js` documents, and reports documented-but-unread and read-but-undocumented sets. | `flags.json` |
| `probe.mjs` | 58 | Runs 26 CLI cases under a fixture `BULLSWARM_HOME` and records exit code, stdout, stderr, whether stdout parses as JSON, and line count. | `behavior-probes.json` |

### Re-run today, in this workspace

```
$ cd /Users/cowcow02/Repo/bullswarm-worktrees/audit-0.27
$ node /tmp/bullswarm-audit/graph.mjs
{ "reachable": 64, "unreachable": 2, "neverImported": 103, "testsOnly": 121, "entries": 4 }

$ node /tmp/bullswarm-audit/identifiers.mjs
{ "definitions": 1067, "singleReference": 13, "testsOnly": 16 }

$ node /tmp/bullswarm-audit/assets.mjs
{ "assets": 35, "referenced": 9, "unreferenced": 26 }
```

Every count matches `counts.json` exactly:
`{"reachable":64,"unreachable":2,"neverImported":103,"testsOnly":121,"singleReferenceIdentifiers":13,"testsOnlyIdentifiers":16,"unreferencedAssets":26}`.
The two unreachable files are `bin/check-v2-evidence.js` and `bin/check-v2-plan.js` — both refuted
(section 7).

### Known limitations of the heuristics

These are not caveats for form's sake. Each one produced a wrong verdict that the refutation pass
had to reverse.

1. **`graph.mjs` cannot see a path built at runtime.** `new URL('../../bin/check-v2-evidence.js', import.meta.url)`
   followed by a shell invocation is invisible to it. This is why both `bin/check-v2-*.js` files were
   reported unreachable when a worker process executes them on every run.
2. **`assets.mjs` matches literals only, so any `readdirSync` directory looks unreferenced.** 26 of
   35 assets came back unreferenced and at least 26 of those are false positives —
   `connectors/command-code.json` (scanned by `setup.js:85-112`) and the 23 verification fixtures
   (scanned by `tests/verify.test.js:12-21`). The script's own report flagged this caveat; R15 and
   R16 confirmed it.
3. **`flags.mjs` cannot follow computed property access.** `opts[flag]` through a rename table made
   all six `workflow` planning flags look documented-but-unread. All six are read.
4. **"Never imported" is not "never called."** 103 exports have no importer; ~34 of those in the
   routing and meter layers have real in-file callers, so only the `export` keyword is surplus.
5. **"Tests-only" is sometimes the point.** `HELP_PATHS` exists to be enumerated by the help test.
   The analyzer offered this as its own deliberate false-positive example.
6. **A static audit cannot see an installed home or an external consumer.** Three decisions rest on
   that and are labelled **unverified** in this report: the `claude` reader alias (B11), the real
   OpenCode behaviour behind `preferredConcurrency` (B7), and whether any external package imports
   the 12 alias exports.
7. **One published count is wrong.** The reachability report states `src/**/*.js: 16,881 lines`. That
   figure omits the six top-level `src/*.js` files, because a shell `src/**/*.js` glob without
   `globstar` matches only one directory level:

```
$ wc -l src/*.js | tail -1
    4385 total
$ find src -name '*.js' | xargs wc -l | tail -1
   21266 total
```

   `16,881 + 4,385 = 21,266`. **The real `src/` total is 21,266 lines, not 16,881.** The per-file
   numbers in `line-counts.txt` are correct; only the total is short. All Tier A and Tier C line
   counts in this report were taken from per-file `wc -l`, so none of them inherit this error.
   Similarly, the reachability report sized `strategy-dashboard.js` at 278 lines and `src/help.js`
   against a 1,724-line figure from the task brief; the measured values here are **551** and
   **1,349**.

### The empirical removal results

This is the part that separates a guess from a finding. The refutation pass copied the tree to
`/tmp/bullswarm-audit/copy/` with `rsync -a --exclude .git`, restored it from
`/tmp/bullswarm-audit/pristine/` between every case (`diff -rq` clean), and ran the suite each time.
Baseline in the copy: `# tests 659  # pass 659  # fail 0  # duration_ms 11669`, exit 0.

| Case | Deleted | tests | pass | fail | Reading |
|---|---|---:|---:|---:|---|
| R1 | `fiveHourTier` alone | 631 | 630 | 1 | own test file fails to import |
| R1b | `fiveHourTier` + its test | 658 | 658 | 0 | **confirmed A** |
| R2 | `REASONING_DEFAULT_TIERS` | 659 | 659 | 0 | **confirmed A**, no test to change |
| R3 | `'workflow-v1'` | 659 | 659 | 0 | **confirmed A** |
| R4 | `weeklyUsedPct` operand | 659 | 659 | 0 | **confirmed A** |
| R5 | `fixtures/openrouter/` | 659 | 659 | 0 | **confirmed A** |
| R6 | `parseEvidenceOutput` | 652 | 651 | 1 | own test file only → **confirmed A** |
| R7 | `bin/check-v2-evidence.js` | 659 | 658 | 1 | **refuted** |
| R8 | `bin/check-v2-plan.js` | 659 | 658 | 1 | **refuted** |
| R9 | `recordAgentAction` | 655 | 654 | 1 | own test file only → **confirmed A** |
| R10 | `classifyAgentProgress` | 655 | 654 | 1 | own test file only → **confirmed A** |
| R11 | `aggregateUsage` | 654 | 653 | 1 | own test file only → **confirmed A** |
| R12 | `connectors/_schema.json` | 659 | 659 | 0 | dead to code; kept for other reasons (B8) |
| R13 | `preferredConcurrency` + `$comment-` | 659 | 658 | 1 | **downgraded to B7** |
| R14 | 12 alias exports (14 lines) | 659 | 659 | 0 | **confirmed A** |
| R15 | `connectors/command-code.json` | 648 | 644 | 4 | **refuted** |
| R16 | one `fixtures/failures` file | 658 | 658 | 0 | **refuted** — coverage shrank silently (B10) |
| R17 | inert `--json` ternary | 659 | 659 | 0 | dead branch removable |
| R18 | `claude` alias in `READERS` | 659 | 659 | 0 | dead in-repo; hold (B11) |
| R19 | `\|\| sub === 'recommend'` | 659 | 659 | 0 | alias has **zero** test coverage (B2) |
| **R20** | **the whole confirmed Tier A set at once** | **651** | **651** | **0** | **187 source lines + 99 test lines, 8 tests** |

### Where the refuter overruled a lens

Stated explicitly, because the refuter's empirical result wins in each case:

1. **`bin/check-v2-evidence.js` and `bin/check-v2-plan.js` are not Tier A.** The run lens and the
   reachability report both said unreachable. The workflow lens said they are dynamically invoked and
   was right. R7 and R8 settled it with failing tests.
2. **The `flags.json` "documented-but-unread" list for `workflow` is a false positive.** The
   reachability report's own data was misleading; reading `cli.js:118-131` settled it.
3. **`connectors/command-code.json` and the 23 fixtures are not deletable.** R15 and R16.
4. **`connectors/_schema.json` moved from Tier A to Tier B**, and `preferredConcurrency` from Tier A3
   to Tier B — R12 and R13.
5. **`strategy-dashboard.js` is 551 lines, not 278**, and `src/help.js` is 1,349, not 1,724.
6. **`data/openrouter-benchmarks.json` is not deletable code** — it is an absent asset.
7. **The `659` baseline is this workspace's.** The `661` figure in `16dddb0`'s message belongs to
   `feat/one-workflow-engine`, which this HEAD does not contain.

Three inputs to this report were **not independently reproduced** and are flagged where they appear:
B3's cold-cache network refresh (needs the live fetch the routing lens performed), B7's real OpenCode
concurrency behaviour, and B11's installed-home question.

### Everything that was read to produce this report

Confirmed with `ls -la` before writing; all read in full.

```
/Users/cowcow02/.bullswarm/workflows/wf-mttmenoy-b96de2/out-refute-attempt-1.md   10.1K
/tmp/bullswarm-audit/lenses/refute.md                                             21.5K
/tmp/bullswarm-audit/lenses/lens-routing.md                                       42.6K
/tmp/bullswarm-audit/lenses/out-lens-workflow-attempt-1.md                        13.0K
/tmp/bullswarm-audit/lenses/out-lens-run-attempt-1.md                             13.2K
/tmp/bullswarm-audit/lenses/out-lens-commands-attempt-1.md                         15.5K
/tmp/bullswarm-audit/lenses/out-lens-docs-attempt-1.md                             11.5K
/tmp/bullswarm-audit/lenses/out-reachability-attempt-3.md                          25.8K
/tmp/bullswarm-audit/{graph,identifiers,assets,flags,probe}.mjs
/tmp/bullswarm-audit/counts.json  help-probes.json  behavior-probes.json
/tmp/bullswarm-audit/skill-command-help.json  skill-help-checks.tsv  line-counts.txt
/tmp/bullswarm-audit/{reachability,exports,identifiers,assets,flags}.json
/Users/cowcow02/.bullswarm/workflows/wf-mttj9k9w-baca81/state.json                 91.0K
/Users/cowcow02/.bullswarm/workflows/wf-mttj9k9w-baca81/events.jsonl               34.6K
/Users/cowcow02/.bullswarm/workflows/wf-mttj9k9w-baca81/out-lens-routing-attempt-1.md  253B
/Users/cowcow02/.bullswarm/goals/wf-mttj9k9w-baca81/stderr.log                      1.1K
/Users/cowcow02/.bullswarm/goals/wf-mttj9k9w-baca81/launcher.json                    327B
```

No provider was dispatched to produce this report. `.relay-api-key*` and `.openrouter-api-key` were
never read. Every CLI command run for this section used a temporary `BULLSWARM_HOME` under
`/tmp/bullswarm-audit/` with `BULLSWARM_DISABLE_CLAUDE_PROFILES=1` and
`BULLSWARM_DISABLE_OPENCODE_RELAY=1`, and only `--dry-run`, `--help` and read verbs were used.

---

## Appendix A — full command-surface table (all 64 paths)

Copied verbatim from the command-surface audit
(`/tmp/bullswarm-audit/lenses/out-lens-commands-attempt-1.md`). Legend: `2U` = exit 2 with
usage/fix guidance · `2V` = exit 2 with validation guidance · `1V` = validation message but incorrect
exit 1 · `I` = bogus flags silently ignored · `J*` = JSON is always emitted or the flag has no
effect.

| Path | Dispatcher | Help complete? | Missing fields / drift | `--json` | Non-TTY | Bad input | Unknown flag | Verdict / fix |
|---|---:|---:|---|---|---|---|---|---|
| root | yes | yes | none | no | help/status path | 2U for unknown verb | rejects as unknown verb | good |
| `setup` | yes | yes | none | yes | auto-setup, no prompt | 2V for invalid setup options | I | good; strict flags needed |
| `integrate` | yes | yes | parent help omits install/remove `--yes` context | yes | human or JSON | 2U subcommand; `1V` bad agent | I | good surface; fix exit code |
| `integrate status` | yes | yes | none | yes | normal | `1V` unknown agent | I | fix bad-agent exit to 2 |
| `integrate install` | yes | yes | none | yes | normal | `1V` missing `--yes` | I | fix approval error to 2 |
| `integrate remove` | yes | yes | none | yes | normal | `1V` missing `--yes` | I | fix approval error to 2 |
| `integrate retire-legacy` | yes | yes | none | yes | normal | `1V` missing `--yes` | I | fix approval error to 2 |
| `run` | yes | yes | omits accepted `--no-caller` | yes | human or JSON | missing lane exits `1`: `FAIL unknown lane undefined`; malformed values exit 2 | I | high priority: require lane and exit 2 |
| `health` | yes | yes | none | J* always JSON | JSON | semantic unhealthy result exits 1 | I | behavior documented |
| `pools` | yes | yes | none | yes | human or JSON | none meaningful | I | good; strict flags needed |
| `assignments` | yes | yes | none | yes | human or JSON | none meaningful | I | good; strict flags needed |
| `doctor` | yes | yes | none | yes | human or JSON | readiness failure exits 1 | I | good; strict flags needed |
| `version` | yes | yes | package reports `0.26.0`, help/task context says `0.27.0` | no | normal | 2U only for unrelated dispatcher errors | I | reconcile version metadata |
| `release` | yes | yes | none | no | normal | 2U missing bump kind | I | good maintainer surface |
| `strategy` | yes | yes | none | yes | defaults to non-TTY `show` | 2U bad subcommand | I | good |
| `strategy tui` | yes | yes | none | no | exits 1: requires TTY | 1V/2U depending dashboard failure | I | message is clear; code could use 2 for usage |
| `strategy inventory` | yes | yes | none | yes, always JSON | JSON | 1V/2V underlying discovery errors | I | useful machine surface |
| `strategy routes` | yes | yes | none | yes, always JSON | JSON | 1V/2V underlying discovery errors | I | useful narrow surface |
| `strategy set-provider` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U approval/args | I | document output or add `--json` |
| `strategy set-model` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U approval/args | I | document output or add `--json` |
| `strategy reset-tier` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U approval/args | I | document output or add `--json` |
| `strategy set-reasoning` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy rungs` | yes | yes | none | yes | human or JSON | `--pool` without value becomes `unknown pool "true"` and exits 2 | I | improve missing-value message |
| `strategy set-rung` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy reset-reasoning` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy configure` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy refresh` | yes | yes | none | yes | human or JSON | 2U/2V | I | keep as canonical refresh |
| `strategy recommend` | yes | yes | none | yes | human or JSON | 2U/2V | I | retain as compatibility alias |
| `strategy apply` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U approval | I | document output or add `--json` |
| `strategy show` | yes | yes | none | yes | human or JSON | 1V discovery failure | I | distinct cached-report view |
| `strategy assign` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy clear-assignment` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy exclude-model` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy include-model` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy set-subscription` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy auto` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy auto status` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U/2V | I | document output or add `--json` |
| `strategy auto off` | yes | yes | no advertised JSON; output is always JSON | not offered; always JSON | JSON | 2U approval | I | document output or add `--json` |
| `workflow` | yes | yes | one root example omits required `--program`, `--scout`, or `--orchestrator` | no | non-TTY prints help and exits 2 | 2U bad subcommand | generally I | fix invalid example |
| `workflow goal` | yes | yes | none | yes | detached launch; not TTY-dependent | missing program exits 2 with next commands | I; bogus flag accepted (launch unverified) | high priority: reject unknown flags |
| `workflow plan` | yes | yes | none | no | normal | 2U bad/missing subcommand | I | good parent help |
| `workflow plan contract` | yes | yes | none | J* always JSON | JSON | 2U/1V cwd | I | good |
| `workflow plan validate` | yes | yes | none | yes | human or JSON | 2U missing/invalid program; 1 cwd | I; valid bogus flag still exit 0 | high priority: strict flags |
| `workflow plan show` | yes | yes | none | yes | human or JSON | 2U missing ID; 1 missing/non-paused run | I | good |
| `workflow plan submit` | yes | yes | none | yes | human or JSON | 2U/2V; 1 relaunch/runtime error | I | good |
| `workflow capabilities` | yes | yes | usage omits advertised `--json` | J* always JSON | JSON | 1 live-pool failure | I | add `[--json]` to usage |
| `workflow tui` | yes | yes | non-TTY without ID requires `--json` or an ID; help is broad | yes | bare non-TTY exits 1; ID gives static tree | 1 dashboard/runtime error | I | clarify non-TTY refusal |
| `workflow watch` | yes | yes | none | no; use `--jsonl` | normal follow loop | 2U/2V typed values | I | good agent loop |
| `workflow events` | yes | yes | none | J* always JSON | JSON | 2U missing/bad cursor | I | good |
| `workflow steer` | yes | yes | none | yes | human or JSON | 2U missing message/ID; 1 runtime | I | good |
| `workflow cancel` | yes | yes | none | yes | human or JSON | 2U missing ID; 1 missing run | I | good |
| `workflow resume` | yes | yes | none | yes | human or JSON | 2U invalid combinations; 1 missing run | I | good |
| `workflow action` | yes | yes | none | no | normal | 2U bad subcommand | I | good parent help |
| `workflow action show` | yes | yes | none | J* always JSON | JSON | 2U missing args; 1 missing run/action | I | good |
| `workflow runs` | yes | yes | none | yes | human or JSON | 2U time filters; `--limit nope` exits 0 | I | reject invalid numeric limits |
| `workflow runs list` | yes | yes | none | yes | human or JSON | 2U time filters; `--limit nope` exits 0 | I | reject invalid numeric limits |
| `workflow runs show` | yes | yes | none | yes | human or JSON | 2U missing ID; 1 missing run | I | good |
| `workflow runs result` | yes | yes | none | yes | human or JSON | 2U missing ID; 1 missing/not-ready run | I | canonical stable result |
| `workflow runs delete` | yes | yes | none | yes | human or JSON | 2U missing `--yes`/ID; 1 missing run | I | good destructive guard |
| `runs` | yes | yes | alias-specific text only | yes | same as `workflow runs` | same as canonical | I | retain compatibility alias |
| `runs list` | yes | yes | none | yes | same as canonical | same as canonical | I | retain compatibility alias |
| `runs show` | yes | yes | none | yes | same as canonical | same as canonical | I | retain compatibility alias |
| `runs result` | yes | yes | none | yes | same as canonical | same as canonical | I | retain compatibility alias |
| `runs delete` | yes | yes | none | yes | same as canonical | same as canonical | I | retain compatibility alias |

---

## Appendix B — analyzer scripts, verbatim

Five zero-dependency Node scripts, copied byte-for-byte from `/tmp/bullswarm-audit/` so this report
can be reproduced without that directory. Each writes its JSON output next to itself, never into the
repository. Run them from the repository root:

```
$ cd /Users/cowcow02/Repo/bullswarm-worktrees/audit-0.27
$ node /tmp/bullswarm-audit/graph.mjs
$ node /tmp/bullswarm-audit/identifiers.mjs
$ node /tmp/bullswarm-audit/assets.mjs
$ node /tmp/bullswarm-audit/flags.mjs
$ BULLSWARM_HOME=<fixture-home> node /tmp/bullswarm-audit/probe.mjs
```

Each accepts the repository root as `argv[2]` and falls back to `process.cwd()`.

### B.1 — `graph.mjs` (224 lines) — import graph, reachability, per-symbol importers

```javascript
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const outDir = dirname(fileURLToPath(import.meta.url));
const sourceRoots = ['src', 'bin', 'mcp', 'scripts'];
const isTest = (p) => p === 'tests' || p.startsWith('tests/') || /\.test\.[cm]?js$/.test(p);
const rel = (p) => relative(repo, p).replaceAll('\\', '/');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

const files = sourceRoots.flatMap((root) => walk(join(repo, root)))
  .filter((p) => ['.js', '.mjs'].includes(extname(p)))
  .map(rel)
  .sort();
const consumerFiles = [...new Set([...files, ...walk(join(repo, 'tests'))])]
  .filter((p) => ['.js', '.mjs'].includes(extname(p)))
  .map(rel)
  .sort();
const fileSet = new Set(files);

function resolveRelative(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(repo, dirname(from), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')];
  return candidates.map(rel).find((candidate) => fileSet.has(candidate)) ?? null;
}

function masked(source) {
  let out = '';
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (mode === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '*' && n === '/') { out += ' '; i += 1; mode = 'code'; }
      continue;
    }
    if (mode === 'string') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\\') { if (source[i + 1] === '\n') out += '\n'; i += 1; out += ' '; continue; }
      if (c === quote) mode = 'code';
      continue;
    }
    if (c === '/' && n === '/') { out += '  '; i += 1; mode = 'line'; continue; }
    if (c === '/' && n === '*') { out += '  '; i += 1; mode = 'block'; continue; }
    if (c === '\'' || c === '"' || c === '`') { out += ' '; quote = c; mode = 'string'; continue; }
    out += c;
  }
  return out;
}

function importSpecs(source) {
  const specs = [];
  const staticRe = /\bimport\s+(?!\()(?:(?:[\s\S]*?)\sfrom\s*)?["']([^"']+)["']/g;
  const exportRe = /\bexport\s+(?:(?:[\s\S]*?)\sfrom\s*)["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, exportRe, dynamicRe]) {
    for (const match of source.matchAll(re)) specs.push({ specifier: match[1], kind: re === dynamicRe ? 'dynamic' : re === exportRe ? 're-export' : 'static' });
  }
  return specs;
}

function exportedSymbols(source) {
  const code = masked(source);
  const symbols = new Map();
  const add = (name, line = 1) => { if (name && !symbols.has(name)) symbols.set(name, { name, line }); };
  for (const match of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(match[1], source.slice(0, match.index).split('\n').length);
  for (const match of code.matchAll(/\bexport\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) add(match[1], source.slice(0, match.index).split('\n').length);
  for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const line = source.slice(0, match.index).split('\n').length;
    for (const item of match[1].split(',')) {
      const cleaned = item.trim().replace(/\/\/.*$/, '');
      if (!cleaned) continue;
      const parts = cleaned.split(/\s+as\s+/);
      add((parts[1] ?? parts[0]).trim(), line);
    }
  }
  return [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function importBindings(source) {
  const bindings = [];
  const staticRe = /\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  const exportRe = /\bexport\s*\{([^}]*)\}\s+from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(staticRe)) {
    const clause = match[1].trim();
    const values = [];
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const item of named[1].split(',')) {
        const parts = item.trim().split(/\s+as\s+/);
        if (parts[0]) values.push({ imported: parts[0].trim(), local: (parts[1] ?? parts[0]).trim(), kind: 'named' });
      }
    }
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) values.push({ imported: '*', local: namespace[1], kind: 'namespace' });
    const defaultPart = clause.replace(named?.[0] ?? '', '').replace(namespace?.[0] ?? '', '').replace(',', '').trim();
    if (defaultPart && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) values.push({ imported: 'default', local: defaultPart, kind: 'default' });
    bindings.push({ specifier: match[2], bindings: values });
  }
  const dynamicNamedRe = /\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*[\"']([^\"']+)[\"']\s*\)/g;
  for (const match of source.matchAll(dynamicNamedRe)) {
    const values = [];
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s*:\s*/);
      if (parts[0]) values.push({ imported: parts[0].trim(), local: (parts[1] ?? parts[0]).trim(), kind: 'dynamic-named' });
    }
    bindings.push({ specifier: match[2], bindings: values });
  }
  const dynamicNamespaceRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\(\s*[\"']([^\"']+)[\"']\s*\)/g;
  for (const match of source.matchAll(dynamicNamespaceRe)) {
    bindings.push({ specifier: match[2], bindings: [{ imported: '*', local: match[1], kind: 'dynamic-namespace' }] });
  }
  for (const match of source.matchAll(exportRe)) {
    const values = [];
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      if (parts[0]) values.push({ imported: parts[0].trim(), local: (parts[1] ?? parts[0]).trim(), kind: 're-export' });
    }
    bindings.push({ specifier: match[2], bindings: values });
  }
  return bindings;
}

const graph = Object.fromEntries(files.map((file) => [file, { imports: [], importers: [] }]));
const exportMap = Object.fromEntries(files.map((file) => [file, exportedSymbols(readFileSync(join(repo, file), 'utf8'))]));
const allBindings = [];
for (const file of consumerFiles) {
  const source = readFileSync(join(repo, file), 'utf8');
  for (const item of importSpecs(source)) {
    const target = resolveRelative(file, item.specifier);
    if (!target) continue;
    if (graph[file]) graph[file].imports.push({ file: target, specifier: item.specifier, kind: item.kind });
    graph[target].importers.push(file);
  }
  for (const item of importBindings(source)) {
    const target = resolveRelative(file, item.specifier);
    if (target) allBindings.push({ importer: file, target, bindings: item.bindings });
  }
}
for (const file of files) {
  graph[file].imports = [...new Map(graph[file].imports.map((x) => [`${x.file}:${x.kind}`, x])).values()].sort((a, b) => a.file.localeCompare(b.file));
  graph[file].importers = [...new Set(graph[file].importers)].sort();
}

const entryCandidates = new Set(['bin/bullswarm.js', 'mcp/server.mjs', ...files.filter((file) => file.startsWith('scripts/') && file.endsWith('.mjs'))]);
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
for (const value of Object.values(pkg.bin ?? {})) if (typeof value === 'string') entryCandidates.add(value.replace(/^\.\//, ''));
for (const value of Object.values(pkg.scripts ?? {})) {
  for (const match of value.matchAll(/(?:^|\s)node(?:\s+[^\s]+)*\s+([^\s]+)/g)) entryCandidates.add(match[1].replace(/^\.\//, ''));
}
for (const yml of walk(join(repo, '.github')).filter((p) => /\.ya?ml$/.test(p))) {
  const text = readFileSync(yml, 'utf8');
  for (const match of text.matchAll(/\bnode\s+(?:--[^\s]+\s+)*([^\s'"`\\|;&]+)/g)) entryCandidates.add(match[1].replace(/^\.\//, ''));
}
const entries = [...entryCandidates].filter((file) => fileSet.has(file)).sort();
const reachable = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const next of graph[file].imports.map((x) => x.file)) if (!reachable.has(next)) queue.push(next);
}

const exports = {};
for (const file of files) {
  const imported = new Map();
  for (const item of allBindings.filter((x) => x.target === file)) {
    for (const binding of item.bindings) {
      for (const symbol of exportMap[file]) {
        if (binding.imported === symbol.name || binding.imported === '*') {
          const list = imported.get(symbol.name) ?? [];
          list.push({ file: item.importer, importedAs: binding.local, kind: binding.kind, namespace: binding.imported === '*' });
          imported.set(symbol.name, list);
        }
      }
    }
  }
  const all = exportMap[file].map((symbol) => ({ ...symbol, importers: [...(imported.get(symbol.name) ?? [])].sort((a, b) => a.file.localeCompare(b.file)) }));
  exports[file] = all;
}
const neverImported = [];
const testsOnly = [];
for (const [file, symbols] of Object.entries(exports)) {
  for (const symbol of symbols) {
    const nonTest = symbol.importers.filter((x) => !isTest(x.file));
    const test = symbol.importers.filter((x) => isTest(x.file));
    const item = { file, symbol: symbol.name, line: symbol.line, importers: symbol.importers, evidenceCommand: `rg -n "\\b${symbol.name}\\b" src bin mcp scripts tests` };
    if (!nonTest.length && !test.length) neverImported.push(item);
    else if (!nonTest.length && test.length) testsOnly.push(item);
  }
}
const output = {
  generatedAt: new Date().toISOString(),
  repo,
  heuristic: 'Static relative imports/re-exports/dynamic imports only; package and node imports are ignored. Reachability graph nodes are src/**, bin/**, mcp/**, and scripts/**; tests/** are scanned only as export consumers. Namespace imports count as importing every named export found in the target. Test files are tests/** or *.test.js/*.test.mjs.',
  entries,
  files: graph,
  reachable: [...reachable].sort(),
  unreachable: files.filter((file) => !reachable.has(file)),
};
writeFileSync(join(outDir, 'reachability.json'), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(outDir, 'exports.json'), `${JSON.stringify({ generatedAt: output.generatedAt, repo, heuristic: output.heuristic, exports, neverImported, testsOnly }, null, 2)}\n`);
console.log(JSON.stringify({ reachable: output.reachable.length, unreachable: output.unreachable.length, neverImported: neverImported.length, testsOnly: testsOnly.length, entries: entries.length }, null, 2));
```

### B.2 — `identifiers.mjs` (82 lines) — single-reference and tests-only identifiers

```javascript
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const roots = ['src', 'bin', 'mcp', 'scripts', 'connectors', 'skill', 'tests', '.github'];
const isTest = (p) => p === 'tests' || p.startsWith('tests/') || /\.test\.[cm]?js$/.test(p);
const rel = (p) => relative(repo, p).replaceAll('\\', '/');
function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(path)); else result.push(path);
  }
  return result;
}
const files = [...new Set(roots.flatMap((root) => walk(join(repo, root))).concat([
  join(repo, 'README.md'), join(repo, 'AGENTS.md'),
]))].filter((p) => existsSync(p)).map(rel).sort();
function mask(source) {
  let out = ''; let mode = 'code'; let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]; const n = source[i + 1];
    if (mode === 'line') { out += c === '\n' ? '\n' : ' '; if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { out += c === '\n' ? '\n' : ' '; if (c === '*' && n === '/') { out += ' '; i += 1; mode = 'code'; } continue; }
    if (mode === 'string') { out += c === '\n' ? '\n' : ' '; if (c === '\\') { i += 1; out += ' '; continue; } if (c === quote) mode = 'code'; continue; }
    if (c === '/' && n === '/') { out += '  '; i += 1; mode = 'line'; continue; }
    if (c === '/' && n === '*') { out += '  '; i += 1; mode = 'block'; continue; }
    if (c === '\'' || c === '"' || c === '`') { out += ' '; quote = c; mode = 'string'; continue; }
    out += c;
  }
  return out;
}
function definitions(file) {
  if (!file.startsWith('src/') || !['.js', '.mjs'].includes(extname(file))) return [];
  const source = readFileSync(join(repo, file), 'utf8');
  const code = mask(source);
  const result = [];
  let depth = 0;
  for (const [index, line] of code.split('\n').entries()) {
    if (depth === 0) {
      const functionMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      const classMatch = line.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
      const valueMatch = line.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (functionMatch) result.push({ file, line: index + 1, name: functionMatch[1], kind: 'function' });
      if (classMatch) result.push({ file, line: index + 1, name: classMatch[1], kind: 'class' });
      if (valueMatch) result.push({ file, line: index + 1, name: valueMatch[1], kind: 'const/let' });
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return result;
}
const texts = Object.fromEntries(files.map((file) => [file, readFileSync(join(repo, file), 'utf8')]));
const defs = files.flatMap(definitions);
const singleReference = []; const testsOnly = []; const all = [];
for (const definition of defs) {
  const escaped = definition.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
  const references = [];
  for (const [file, text] of Object.entries(texts)) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) references.push({ file, line: text.slice(0, match.index).split('\n').length, context: text.split('\n')[text.slice(0, match.index).split('\n').length - 1].trim() });
  }
  const nonDefining = references.filter((reference) => !(reference.file === definition.file && reference.line === definition.line));
  const item = { ...definition, count: references.length, references, evidenceCommand: `rg -n "\\b${definition.name}\\b" src bin mcp scripts connectors skill tests .github README.md AGENTS.md` };
  all.push(item);
  if (references.length === 1) singleReference.push(item);
  if (nonDefining.length > 0 && nonDefining.every((reference) => isTest(reference.file))) testsOnly.push(item);
}
const output = {
  generatedAt: new Date().toISOString(), repo,
  heuristic: 'Top-level declarations are line-oriented declarations at brace depth zero in src/**/*.js or src/**/*.mjs. Bare word-boundary counts include comments, strings, JSON, YAML, and same-name unrelated symbols; only references outside the defining declaration line are used for tests-only classification.',
  singleReference: singleReference.sort((a, b) => `${a.file}:${a.line}:${a.name}`.localeCompare(`${b.file}:${b.line}:${b.name}`)),
  testsOnly: testsOnly.sort((a, b) => `${a.file}:${a.line}:${a.name}`.localeCompare(`${b.file}:${b.line}:${b.name}`)),
  definitions: all.sort((a, b) => `${a.file}:${a.line}:${a.name}`.localeCompare(`${b.file}:${b.line}:${b.name}`)),
};
writeFileSync(join(outDir, 'identifiers.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ definitions: defs.length, singleReference: singleReference.length, testsOnly: testsOnly.length }, null, 2));
```

### B.3 — `assets.mjs` (38 lines) — unreferenced fixtures, data and connectors

```javascript
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const rel = (p) => relative(repo, p).replaceAll('\\', '/');
function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(path)); else result.push(path);
  }
  return result;
}
const assets = ['fixtures', 'data', 'connectors'].flatMap((root) => walk(join(repo, root))).map(rel).sort();
const searchFiles = ['src', 'tests', 'scripts', '.github'].flatMap((root) => walk(join(repo, root))).concat([join(repo, 'package.json')]).filter(existsSync).map(rel);
const texts = Object.fromEntries(searchFiles.map((file) => [file, readFileSync(join(repo, file), 'utf8')]));
const findings = assets.map((asset) => {
  const tokenSet = [...new Set([basename(asset), asset])];
  const matches = [];
  for (const [file, text] of Object.entries(texts)) {
    const tokens = tokenSet.filter((token) => text.includes(token));
    if (tokens.length) matches.push({ file, tokens });
  }
  return { file: asset, basename: basename(asset), relativePath: asset, matches, referenced: matches.length > 0, evidenceCommand: `rg -n -F -e ${JSON.stringify(basename(asset))} -e ${JSON.stringify(asset)} src tests scripts .github package.json` };
});
const output = {
  generatedAt: new Date().toISOString(), repo,
  heuristic: 'A literal substring match of either the asset basename or repository-relative path in src/, tests/, scripts/, .github/, or package.json counts as referenced. Runtime directory scans, generated paths, JSON keys, and semantic fixture loading are not inferred.',
  searchFiles,
  assets: findings,
  unreferenced: findings.filter((item) => !item.referenced),
};
writeFileSync(join(outDir, 'assets.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ assets: assets.length, referenced: output.assets.length - output.unreferenced.length, unreferenced: output.unreferenced.length }, null, 2));
```

### B.4 — `flags.mjs` (122 lines) — documented-but-unread and read-but-undocumented flags

```javascript
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const fileText = (file) => readFileSync(join(repo, file), 'utf8');
const sourceFiles = ['src/cli.js', 'src/strategy-cli.js', 'src/workflow/cli.js', 'src/workflow/runs-cli.js', 'src/setup.js', 'src/integrate.js'];

function functionBody(source, name) {
  const start = source.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  let parens = 0;
  let signatureEnd = -1;
  for (let i = source.indexOf('(', start); i >= 0 && i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    if (source[i] === ')') { parens -= 1; if (parens === 0) { signatureEnd = i; break; } }
  }
  const open = source.indexOf('{', signatureEnd < 0 ? start : signatureEnd);
  if (open < 0) return '';
  let depth = 0; let quote = ''; let mode = 'code';
  for (let i = open; i < source.length; i += 1) {
    const c = source[i]; const n = source[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'string') { if (c === '\\') { i += 1; continue; } if (c === quote) mode = 'code'; continue; }
    if (c === '/' && n === '/') { mode = 'line'; i += 1; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i += 1; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; mode = 'string'; continue; }
    if (c === '{') depth += 1;
    if (c === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  return source.slice(start);
}

function flagsRead(source) {
  const result = new Set();
  for (const match of source.matchAll(/\bopts(?:\[['"]([A-Za-z0-9_-]+)['"]\]|\.([A-Za-z0-9_-]+))/g)) result.add(match[1] ?? match[2]);
  for (const match of source.matchAll(/['"]([A-Za-z0-9_-]+)['"]\s*:/g)) {
    if (['mappings', 'settings', 'next', 'status', 'message'].includes(match[1])) continue;
  }
  return [...result].sort();
}

function flagsAccepted(source) {
  const result = new Set();
  for (const match of source.matchAll(/(?:BOOLEAN_FLAGS|valueFlags|new Set\(\s*\[)([\s\S]*?)(?:\]|\)\s*;)/g)) {
    for (const item of match[1].matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)) result.add(item[1]);
  }
  for (const match of source.matchAll(/(?:===|has\()\s*['"]--?([A-Za-z0-9_-]+)['"]/g)) result.add(match[1]);
  return [...result].sort();
}

const help = await import(pathToFileURL(join(repo, 'src/help.js')).href);
function documented(paths) {
  const result = new Set();
  const texts = [];
  for (const path of paths) {
    const text = help.helpText(path);
    texts.push({ path: path.join(' '), text });
    for (const line of text.split('\n')) {
      const match = line.match(/^\s{2}(--[a-z0-9-]+)/);
      if (match) result.add(match[1].slice(2));
    }
  }
  return { flags: [...result].sort(), texts };
}
function unionBodies(source, names) {
  return names.map((name) => functionBody(source, name)).join('\n');
}
function entry({ command, source, paths, bodies = null, acceptedSource = null, note = '' }) {
  const sourceText = fileText(source);
  const readSource = bodies ? unionBodies(sourceText, bodies) : sourceText;
  const read = flagsRead(readSource);
  const accepted = flagsAccepted(acceptedSource ?? sourceText);
  const docs = documented(paths);
  return {
    command, source, paths: paths.map((path) => path.join(' ')),
    parserAccepted: accepted,
    directlyRead: read,
    documented: docs.flags,
    documentedButUnread: docs.flags.filter((flag) => !read.includes(flag)),
    readButUndocumented: read.filter((flag) => !docs.flags.includes(flag)),
    heuristic: note || 'Flags are inferred from opts.foo/opts["foo"] in the selected handler bodies; parserAccepted also includes explicit parser literals. Help flags come from option lines in helpText() for the mapped command paths.',
  };
}
const rootPaths = [[], ['setup'], ['run'], ['health'], ['pools'], ['assignments'], ['doctor'], ['release']];
const workflowPaths = [
  ['workflow'], ['workflow', 'goal'], ['workflow', 'plan'], ['workflow', 'plan', 'contract'], ['workflow', 'plan', 'validate'],
  ['workflow', 'plan', 'show'], ['workflow', 'plan', 'submit'], ['workflow', 'cancel'], ['workflow', 'resume'],
  ['workflow', 'capabilities'], ['workflow', 'tui'], ['workflow', 'watch'], ['workflow', 'events'], ['workflow', 'steer'],
  ['workflow', 'action'], ['workflow', 'action', 'show'],
];
const entries = [
  entry({ command: 'cli top-level', source: 'src/cli.js', paths: rootPaths, note: 'The top-level parser accepts arbitrary --name tokens. This entry unions the root command help paths and all cli.js handler reads; delegated strategy/workflow/integrate flags are analyzed in their own entries.' }),
  entry({ command: 'cli setup', source: 'src/cli.js', paths: [['setup']], bodies: ['cmdSetup'] }),
  entry({ command: 'cli run', source: 'src/cli.js', paths: [['run']], bodies: ['cmdRun', 'emit'] }),
  entry({ command: 'cli pools', source: 'src/cli.js', paths: [['pools']], bodies: ['cmdPools'] }),
  entry({ command: 'cli assignments', source: 'src/cli.js', paths: [['assignments']], bodies: ['cmdAssignments'] }),
  entry({ command: 'cli health', source: 'src/cli.js', paths: [['health']], bodies: ['cmdHealth'] }),
  entry({ command: 'cli doctor', source: 'src/cli.js', paths: [['doctor']], bodies: ['cmdDoctor'] }),
  entry({ command: 'cli release', source: 'src/cli.js', paths: [['release']], bodies: ['cmdRelease'] }),
  entry({ command: 'strategy', source: 'src/strategy-cli.js', paths: [
    ['strategy'], ['strategy', 'tui'], ['strategy', 'inventory'], ['strategy', 'routes'], ['strategy', 'set-provider'], ['strategy', 'set-model'], ['strategy', 'set-rung'], ['strategy', 'reset-tier'], ['strategy', 'set-reasoning'], ['strategy', 'reset-reasoning'], ['strategy', 'rungs'], ['strategy', 'configure'], ['strategy', 'refresh'], ['strategy', 'recommend'], ['strategy', 'apply'], ['strategy', 'show'], ['strategy', 'assign'], ['strategy', 'clear-assignment'], ['strategy', 'exclude-model'], ['strategy', 'include-model'], ['strategy', 'set-subscription'], ['strategy', 'auto'], ['strategy', 'auto', 'status'], ['strategy', 'auto', 'off'],
  ], bodies: ['cmdStrategy'] }),
  entry({ command: 'workflow', source: 'src/workflow/cli.js', paths: workflowPaths, bodies: ['cmdWorkflow', 'wfGoal', 'goalSettings', 'buildNewGoalDocument', 'resolvePlanning', 'planContract', 'planValidate', 'planShow', 'planSubmit', 'wfCancel', 'wfResume', 'wfCapabilities', 'wfEvents', 'wfWatch', 'wfSteer', 'wfAction'], note: 'The workflow module has shared parsing and helper functions; this entry unions direct opts reads across dispatch and command helpers.' }),
  entry({ command: 'workflow capabilities', source: 'src/workflow/cli.js', paths: [['workflow', 'capabilities']], bodies: ['wfCapabilities'] }),
  entry({ command: 'workflow events', source: 'src/workflow/cli.js', paths: [['workflow', 'events']], bodies: ['wfEvents'] }),
  entry({ command: 'workflow watch', source: 'src/workflow/cli.js', paths: [['workflow', 'watch']], bodies: ['wfWatch'] }),
  entry({ command: 'workflow steer', source: 'src/workflow/cli.js', paths: [['workflow', 'steer']], bodies: ['wfSteer'] }),
  entry({ command: 'workflow action show', source: 'src/workflow/cli.js', paths: [['workflow', 'action', 'show']], bodies: ['wfAction'] }),
  entry({ command: 'workflow runs', source: 'src/workflow/runs-cli.js', paths: [['workflow', 'runs'], ['workflow', 'runs', 'list'], ['workflow', 'runs', 'show'], ['workflow', 'runs', 'result'], ['workflow', 'runs', 'delete']], note: 'Runs flags are parsed in parseRunsFlags and consumed by several handlers; this entry uses the complete module read set.' }),
  entry({ command: 'setup module', source: 'src/setup.js', paths: [['setup']], bodies: ['runWizard'], note: 'setup.js is not the CLI parser; cli.js owns setup flag dispatch. This reports opts directly read by setup.js only.' }),
  entry({ command: 'integrate', source: 'src/integrate.js', paths: [['integrate'], ['integrate', 'status'], ['integrate', 'install'], ['integrate', 'remove'], ['integrate', 'retire-legacy']], bodies: ['cmdIntegrate'] }),
];
const output = {
  generatedAt: new Date().toISOString(), repo,
  heuristic: 'Best-effort static comparison. Help flags are parsed from generated option lines in src/help.js. Handler-scoped entries use opts property reads in named functions; module-scoped entries union all reads because dispatch is split across helpers. A generic parser may accept unknown flags syntactically even when no handler reads them. --help/-h contextual handling is not treated as a command option unless it appears in the command help option block.',
  entries,
};
writeFileSync(join(outDir, 'flags.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(Object.fromEntries(entries.map((item) => [item.command, { documentedButUnread: item.documentedButUnread.length, readButUndocumented: item.readButUndocumented.length }])), null, 2));
```

### B.5 — `probe.mjs` (58 lines) — the 26 CLI behaviour probes

```javascript
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const node = process.execPath;
const repo = process.cwd();
const home = process.env.BULLSWARM_HOME;
const baseEnv = { ...process.env, BULLSWARM_HOME: home, HOME: home, PATH: `${process.env.PATH}:${home}/bin` };
const cases = [
  ['run-missing-lane', ['run', '--add-dir', '.', '--dry-run', 'probe']],
  ['run-bogus-flag', ['run', '--lane', 'analyze', '--bogus-flag', '--dry-run', 'probe']],
  ['run-json-dry', ['run', '--lane', 'analyze', '--add-dir', '.', '--dry-run', '--json', 'probe']],
  ['run-piped', ['run', '--lane', 'analyze', '--add-dir', '.', '--dry-run', 'probe'], true],
  ['pools-bogus-flag', ['pools', '--bogus-flag']],
  ['pools-json', ['pools', '--json']],
  ['strategy-rungs-bogus-flag', ['strategy', 'rungs', '--bogus-flag']],
  ['strategy-rungs-json', ['strategy', 'rungs', '--json']],
  ['strategy-set-rung-bogus-flag', ['strategy', 'set-rung', 'echo', 'low', '--model', 'echo-local', '--bogus-flag']],
  ['strategy-set-rung-missing-model', ['strategy', 'set-rung', 'echo', 'low']],
  ['workflow-goal-bogus-flag', ['workflow', 'goal', 'probe', '--program', 'missing.json', '--bogus-flag']],
  ['workflow-goal-no-program', ['workflow', 'goal', 'probe']],
  ['workflow-plan-validate-bogus-flag', ['workflow', 'plan', 'validate', 'probe', '--program', 'missing.json', '--bogus-flag']],
  ['workflow-plan-validate-missing-program', ['workflow', 'plan', 'validate', 'probe']],
  ['workflow-runs-list-bogus-flag', ['workflow', 'runs', 'list', '--bogus-flag']],
  ['workflow-runs-list-json', ['workflow', 'runs', 'list', '--json']],
  ['health-bogus-flag', ['health', '--bogus-flag']],
  ['health-json', ['health', '--json']],
  ['doctor-bogus-flag', ['doctor', '--bogus-flag']],
  ['doctor-json', ['doctor', '--json']],
  ['assignments-bogus-flag', ['assignments', '--bogus-flag']],
  ['assignments-json', ['assignments', '--json']],
  ['workflow-capabilities-json', ['workflow', 'capabilities', '--json']],
  ['workflow-events-missing-run', ['workflow', 'events']],
  ['workflow-watch-missing-run', ['workflow', 'watch']],
  ['workflow-runs-result-missing-run', ['workflow', 'runs', 'result']],
];
const results = [];
for (const [name, args, pipe] of cases) {
  const r = spawnSync(node, ['bin/bullswarm.js', ...args], {
    cwd: repo,
    env: baseEnv,
    input: pipe ? '' : undefined,
    encoding: 'utf8',
    timeout: 30000,
  });
  const stdout = r.stdout ?? '';
  let json = false;
  try { JSON.parse(stdout); json = true; } catch {}
  results.push({
    name, args, piped: Boolean(pipe), exit: r.status, signal: r.signal,
    stdout, stderr: r.stderr ?? '', jsonDocument: json,
    stdoutLines: stdout.trimEnd() ? stdout.trimEnd().split('\n').length : 0,
  });
}
writeFileSync('/tmp/bullswarm-audit/behavior-probes.json', JSON.stringify(results, null, 2));
for (const r of results) {
  const out = r.stdout.trim().replaceAll('\n', ' \\n ').slice(0, 220);
  const err = r.stderr.trim().replaceAll('\n', ' \\n ').slice(0, 220);
  console.log(`${r.name}\texit=${r.exit}\tjson=${r.jsonDocument}\tstdout=${JSON.stringify(out)}\tstderr=${JSON.stringify(err)}`);
}
```

---

*Audit produced 2026-09-09 against `audit/codebase-2026-09-09` at `b8487b1`. Read-only: the only
file written was this one.*
