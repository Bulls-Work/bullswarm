# Is bullswarm's workflow system at Claude `Workflow`/ultracode quality? — evaluation and the caller-planner change (2026-09-06)

Written from a Claude Code session (Fable 5.1) with the `Workflow` tool
("ultracode") loaded, against bullswarm 0.23.2 → 0.24.0 (this change). Every
number in the measured section is copied from durable run state
(`state.json`, `events.jsonl`) of runs on this machine; nothing is projected.

## 0. Verdict in three lines

- **Execution kernel: at parity or better.** Dependency-ready concurrency,
  enforced file ownership with isolated worktrees, independent evidence per
  requirement, a requirement ledger that invalidates stale evidence, durable
  events, resume, cancellation, and a stable result envelope. Claude's harness
  has none of the last five as first-class objects; its script author writes
  them as code each time.
- **Control plane (before this change): structurally behind.** The planner was
  always a *dispatched* CLI process planning from a scout report, blind to the
  caller's conversation, at 73 s–775 s per turn, at high-tier model cost. Claude
  Code's orchestrator is the session model itself, which already holds the
  repository in context; it writes the program once and is never re-invoked
  inside the workflow.
- **After this change: the same two shapes Claude has.** `workflow goal
  --program` / `workflow plan` let the calling agent be the planner; the kernel
  executes and pauses durably at a real boundary. The dispatched planner stays
  for callers without repository context. Measured on the same fixture and
  goal: see §3.

## 1. What "Claude Dynamic Workflow / ultracode" is, precisely

From the `Workflow` tool contract loaded into this session (unchanged since
`docs/claude-dynamic-workflow-mechanics.md`, 2026-08-29):

1. The **orchestrator is the session model**. It scouts inline with its own
   tools, then authors one JavaScript program (`agent()`, `pipeline()`,
   `parallel()`, loops) and hands it to a harness.
2. The **harness executes deterministically**: spawns subagents up to
   `min(16, CPUs−2)`, enforces `schema` on structured returns at the tool layer,
   journals every return value, supports prefix-cached resume, hard token
   budgets, and progress display grouped by `phase()`.
3. **Re-planning is at workflow boundaries only**: the model reads the return
   value and authors the next program; steering is stop → edit → resume.
4. **Quality patterns are the author's responsibility**: adversarial verify
   (N refuters), judge panels, loop-until-dry, completeness critic — all written
   as code, none provided by the harness.
5. **Ultracode** is a standing opt-in to do this for every substantive task.

## 2. bullswarm autonomous V2 (0.23.2) versus that, mechanic by mechanic

| Mechanic | Claude `Workflow` | bullswarm V2 (0.23.2) | Assessment |
| --- | --- | --- | --- |
| Who plans | The session model, with the repo in context | A dispatched planner agent (`claude -p`/codex/opencode) planning from a scout report and a JSON context | **Gap** — no conversation context; every turn is a fresh high-effort process (measured 73–775 s) |
| When the planner is consulted | Once (author), then between workflows | Once (initial), then only at a consolidated gap/steering boundary | Parity (since 0.22) |
| Program shape | JS with `pipeline`/`parallel`/loops; data-driven fan-out (`pipeline(discovered.items,…)`) | Flat DAG of generic actions (`dependsOn`, `affects`, `ownedFiles`, `evidenceFor`); no fan-out primitive in V2 | **Gap** — discovered item lists need a planner boundary (or an inline scout by the caller) |
| Parallelism | Up to 16 concurrent; default is no barrier | Ready-set scheduler, `--concurrency` (default 4), file-disjoint writers concurrent, shared-tree writers serialized | Parity in mechanism; lower default width |
| Isolation | `isolation: 'worktree'` opt-in per agent | Isolated git worktree per mutating action by default, integrated only if the changed-path set ⊆ `ownedFiles` | **Better** — ownership is enforced, not declared |
| Structured worker output | `schema` enforced at the tool layer for every agent | Evidence actions: kernel-owned envelope validated from a durable candidate file. Work actions: prose captured verbatim; no `outputSchema` in V2 | **Gap** for typed work output (V1 had `outputSchema`; not carried into V2) |
| Verification | Whatever the author writes (adversarial patterns recommended) | Independent evidence action per requirement, routed away from the pool that did the work; kernel flips a requirement to `failed`/`blocked`; conflicting evidence → `blocked`, never last-write-wins | **Better as a default**; but no majority-vote pattern (N verifiers on one requirement conflict instead of vote) |
| Repair | `while (!ok) fix()` written as code | None by design: a failed requirement becomes one consolidated gap for the planner | Different by decision (user: lenient verify; no grind loops) |
| Budget | Hard ceiling (`budget.remaining()`) | Advisory targets; only cancel/invalid program/provider failure/exhausted end useful work | Intentional difference (user decision) |
| Routing / cost | One provider (the session's); `model` override per agent | Quota-paced routing across every installed CLI subscription; lane+effort → tier → pool/model; burst gates, quarantine, waits for rate-limit resets | **Better** — this is bullswarm's reason to exist |
| Durability | Journal + prefix resume | `state.json` (validated schema) + ordered `events.jsonl` + attempts + resume + cooperative cancel + detached runner | **Better** |
| Observability | Progress tree, `/workflows` | TUI (timeline/phases/agents), `watch` heartbeat, `events --after`, `runs result` envelope | Parity or better |
| Completion authority | The script returns | Kernel: all mandatory requirements have fresh passing evidence | **Better** (cannot self-declare success) |
| Ultracode-style "always orchestrate" | Session directive | `delegate` classifier (deterministic + LLM refinement) picks single vs workflow | Comparable |

Net: the kernel is not the weak part. The one structural gap that matters for
"a frontier agent using bullswarm to save expensive tokens in the most natural
way" is the first row — and it is exactly what this change closes.

## 3. The change: caller-planner mode

Shipped in 0.24.0 (this working tree):

- `bullswarm workflow plan contract "<goal>"` — requirement IDs the kernel will
  derive, the shared rulebook, action fields, validation, worked example.
- `bullswarm workflow goal "<goal>" --program plan.json` — the caller's program
  is validated against a preview of the exact durable state before anything
  launches (invalid → exit 2, nothing dispatched); scout off by default (the
  caller scouted inline); zero planner dispatches.
- At a later boundary (gaps/steering) the kernel writes
  `planner-request-turn-N.json` (the same context a dispatched planner gets +
  consolidated gaps), records `planner.awaiting`, sets `lifecycle.status =
  waiting`, emits `planner.awaiting_caller`, and exits. `watch` ends there and
  prints the next command.
- `bullswarm workflow plan show <id>` / `plan submit <id> --program plan-2.json`
  (or `--exhausted --reason`) — validated against the durable state at that
  boundary with the same validator; recorded with the same turn/expansion/event
  bookkeeping as a dispatched turn (`planner.finished` with `source: caller`);
  kernel relaunched through the normal resume path.
- One shared rulebook (`v2PlannerContractRules`) renders both the dispatched
  planner prompt and the caller contract, so the two modes cannot drift.
- Scout units are advisory for a caller planner (a frontier planner should not
  be forced to mirror a cheaper scout's decomposition); they remain
  kernel-required for dispatched planners.

Offline proof: `tests/workflow-v2-caller-planner.test.js` (15 tests: shared
rulebook, bare-program wrapping, zero-dispatch initial program, invalid program
→ correction pause, gap pause → idempotent resume → rejected collision →
accepted submit → completion, exhausted → partial, scout-then-pause, refusal
cases, CLI contract/launch/show/submit/watch/result/detached). Full suite
561/561.

## 4. Measured: same fixture, same goal, same routing — dispatched vs caller planner

Fixture `swarmbench-mini` (scratchpad `bench/`): a Node ESM project with three
modules (`slugify`, `semver`, `intervals`), one planted bug each, 19 tests of
which 4 fail at baseline. Two byte-identical git copies. Goal (verbatim, both
runs):

```text
Fix the three planted bugs so the test suite passes.
1. Fix src/slugify.js so tests/slugify.test.js passes: trailing separators must be trimmed from the slug.
2. Fix src/semver.js so tests/semver.test.js passes: a prerelease version sorts before its release version in compare().
3. Fix src/intervals.js so tests/intervals.test.js passes: touching integer intervals such as [1,3] and [4,6] merge into [1,6].
Finish with the full `npm test` passing 19/19 without modifying, adding, or deleting any file under tests/.
```

Routing: the machine's live default strategy (no pins): high → `claude-code:petsona` / `claude-opus-5`,
medium → `claude-code:petsona` / `claude-sonnet-5`, low → `command-code` / `gpt-5.6-luna`; Fable
excluded. Default `~/.bullswarm` home, isolated worktrees, concurrency 4.

Caller program (authored by this session after reading the fixture inline, ~1
minute): three parallel `build/medium` fixes with disjoint `ownedFiles` + one
`analyze/low` evidence action for requirement-1..4 depending on all three.

Both runs were launched from the same working tree (this change), sequentially,
on the same laptop, with no other bullswarm run active. Outcome audit was done
independently after each run: `npm test`, `git diff --stat`, SHA-256 of every
`tests/*.test.js` versus the pristine copy.

| Measure | Dispatched planner (`y3r5ka`, 0.23.2 behaviour) | Caller planner (`b8hwzi`, this change) |
| --- | --- | --- |
| Outcome | `completed`, verified; **19/19**; tests byte-identical; 3 `src/` files, +6/−7 | `completed`, verified; **19/19**; tests byte-identical; 3 `src/` files, +5/−7 |
| Requirements | 4/4 passed, 0 concerns | 4/4 passed, 0 concerns |
| Wall (goal accepted → result written) | **9 min 03 s** (543 s) | **2 min 11 s** (131 s) |
| Scout | 2 attempts, 110 s (first attempt failed the report schema: no trailing unit array; one bounded correction) | 0 (author scouted inline: `cat` the six files, ran the suite) |
| Planner | 1 turn, 172 s, `claude-opus-5` (high effort) = **32 % of wall**; scout+planner = **52 % of wall** | 0 dispatched turns; ~1 min of the author's own time writing `plan-caller.json` |
| Program | 9 actions: 5 work (semver split into two ordered actions + a `full-suite-integration` action owning all three files) + 4 evidence (one per requirement) | 4 actions: 3 parallel file-disjoint fixes + 1 evidence action for all four requirements |
| Dispatches (paid agent processes) | **12** | **4** |
| Max concurrent / mean parallelism | 4 / 1.60 | 3 / 1.52 |
| Known tokens (provider-reported where available) | **21,331** (opus 3,577 · sonnet-5 10,498 · luna 7,256) | **6,043** (sonnet-5 5,066 · luna 977) |
| Pools used | `claude-code:petsona` (opus, sonnet-5), `command-code` (luna) | `claude-code:petsona` (sonnet-5), `command-code` (luna) |
| Worker time (sum) | 585 s workers + 172 s planner + 110 s scout = 867 s agent-seconds | 198 s agent-seconds |

Reading. Same fixture, same goal, same routing, same kernel, same worker
model tier, same correct result — the only difference is who planned. The
dispatched planner spent 282 s (52 % of wall) and 3 of 12 dispatches before
the first fix started, then compiled a heavier program (a redundant
`full-suite-integration` build action and a two-step semver chain) because it
planned from a scout report rather than from having read the code. The
caller-authored program was lighter because the author *had* read the code:
4.1× faster wall, 3× fewer paid dispatches, 3.5× fewer tokens, and the
highest-tier model (opus) was not used at all. Those savings are per planning
boundary; a run that needs a gap round pays the dispatched planner again
(previously measured 73–775 s per turn) while the caller pays only its own
authoring time.

What did not change: worker quality and evidence independence (both runs'
fixes are minimal and correct; both evidence passes ran the real suite and
checked `tests/` was untouched), the ownership/worktree enforcement, and the
result envelope. Caller mode removes planning overhead; it does not make the
workers smarter.

Caveats. One run per arm; wall times include provider latency variance
(luna evidence took 72–120 s per action in both arms). The fixture is small
by design (bounded cost); the *relative* saving grows with the number of
planning boundaries, not with fixture size.

## 5. What still separates the two, honestly

1. **No fan-out / per-item chains in V2.** A caller can author N actions after
   scouting inline (Claude's own hybrid pattern) or at a gap boundary, but the
   program cannot say "one action per item of that artifact". Recommended next:
   an `expand` action kind resolved by the kernel from a JSON-array artifact.
2. **No typed work output.** Evidence has a kernel-owned schema; work actions
   return prose. Recommended: bring `outputSchema` (V1 0.14.0) into V2 as an
   optional field on work actions, validated from a durable candidate file like
   evidence.
3. **Verification patterns are single-vote.** Two evidence actions on one
   requirement produce `blocked`, not a vote. Adversarial N-of-M is a small
   ledger policy addition if wanted.
4. **Default width 4** vs Claude's 8–16. Configurable today; the default is a
   cost choice.
5. **The pause is a process exit.** Deliberate (durable, survives caller death,
   `--resume` machinery reused), but a caller wanting a single blocking call
   must loop `watch` → `plan submit`. An MCP tool wrapping that loop is a small
   follow-up.
6. **A steering boundary needs at least one new action.** The program
   validator rejects an empty action list in both planner modes, so a caller
   who reads queued steering and concludes "no change needed" cannot say so;
   it must add an action (typically one evidence action). A `kind: acknowledge`
   response for steering boundaries would close this.

## 6. Adversarial review and fixes (same day)

A 24-agent review (find → refute, three lenses per finding) of the first
implementation confirmed six majors and several minors; all are fixed and
regression-tested in `tests/workflow-v2-caller-planner.test.js` (23 tests;
suite 569/569):

| Finding | Fix |
| --- | --- |
| `finalize()` left `planner.awaiting` set, so `watch`/`plan show` reported a cancelled run as still waiting | finalize clears it; validator rejects terminal + awaiting; `watch` checks terminal before awaiting; `plan show` treats a terminal run as not waiting |
| Cancel while paused never finalized and `plan submit` ignored the pending request | submit refuses with the finalize command; `tui --cancel`, `plan show`, `watch`, TUI Next line all point at the one `goal --resume` that records `cancelled` |
| Steering queued while paused replaced the gaps request with a steering request (gaps dropped), and was consumed before any program saw it | pause is authoritative at loop top; steering is peeked into `pendingSteering` and consumed only by the submission; unseen steering opens a `steering` boundary after resume |
| Bare `--program` silently launched a dispatched-planner run | value flags without a value are usage errors (exit 2) |
| `plan submit` mutated state, then crashed with ENOENT when the goal cwd had vanished; detached spawn had no error handler | cwd checked first; spawn `error` surfaced with a manual-resume hint |
| `plan submit` help advertised `--watch` with `--json`, which the code rejects | grammar now `[--foreground [--json] \| --watch \| --json]` |
| `--exhausted` advertised at every boundary | only at `gaps` (next commands, `plan show`, help) |
| Rulebook told a caller planner that scout units are kernel-required | rulebook parameterized by planner mode; caller wording says advisory |
| Unapplied `--program` lost if the kernel died during `--scout` | kept as `initial-planner-response.json` in the run dir until applied |

### Found live during the demo run (`b49rua`)

Driving a three-turn caller-planner run by hand exposed a ledger rule the
benchmark had not: the cross-cutting requirement "full `npm test` passes
19/19" failed on turn 1 (one bug deliberately left), then passed on turn 2, and
the kernel reported it `blocked`, not `passed`. Both evidence records carried
the same per-requirement `inspectedRevision` because no work action listed
that requirement in `affects`, so the ledger saw same-revision conflicting
evidence. The workspace *had* changed between them (global work revision
`work-1-7-fix-semver` → `work-2-27-fix-intervals`). Fix: evidence records now
carry the ledger-wide `workspaceRevision`, and semantic evidence on a newer
workspace supersedes older evidence for the same requirement
(`staleReason: "workspace-superseded"`); same-workspace disagreement still
blocks; pending mechanical records never supersede. Legacy records without the
field are superseded by the first current-workspace judgment, which is how the
paused demo run completed on turn 3 with one evidence-only action.

Refuted by the review and left as designed: the double-submit race (the
compare-and-swap re-read in `submitCallerPlannerResponse` holds), the framing
that steering is "invisible" to a caller planner, and the severity of the
crash window between candidate write and state persist (pre-existing, shared
with dispatched mode).
