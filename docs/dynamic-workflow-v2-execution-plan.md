# Dynamic Workflow V2 Execution Plan

**Status:** execution in progress  
**Written:** 2026-08-31  
**Current baseline:** Bullswarm 0.21.0  
**Primary objective:** make autonomous workflows fast, high quality, easy to
understand, and unlikely to waste money on avoidable rejection or recovery
loops.

This plan consolidates the design and reliability findings from the current
dynamic-workflow implementation, its dogfood runs, and the recent TUI work. It
is both the implementation order and the acceptance ledger below; unchecked
provider and release gates must not be inferred from completed local work.

During this revamp, delegated work must use bounded `bullswarm run` calls. Do
not dogfood `bullswarm workflow goal` to build its own replacement until the
new deterministic kernel gates pass.

### Current execution checkpoint

As of 2026-09-01, sequences 0-15 are implemented or accepted in the candidate
worktree and the offline suite passes 507/507. This includes the V2-only goal/state/result
schemas, generic action and evidence contracts, requirement ledger, planner
validator, dependency scheduler, changed-path ownership, isolated integration,
mechanical-only retry/fallback, gap consolidation, kernel completion, durable
presentation stages, unified desktop/mobile dashboard, quiet watch, native V2
runs/result commands, cancellation/resume, help, README, and skill updates.

The retired autonomous V1 builder, resume-override helpers, and runtime
migration rewrite have been removed. Old autonomous documents and run IDs fail
before dispatch. The separately authored fixed-graph engine remains supported.

The bounded real-Luna component probes passed without model rejection or
schema correction; their timings, token counts, routes, and durable outputs are
recorded in `docs/experiments/2026-08-31-v2-component-probes.md`.

The first difficult-goal canary exposed two plan-boundary weaknesses before the
acceptance streak began. Evidence prompts could prescribe the retired V1
`{ok, concerns, summary}` shape in conflict with the kernel-owned V2 envelope,
and a mutating action could satisfy a green suite with a disconnected no-op
behavioral test. The candidate now rejects planner-owned evidence formats
before dispatch and requires mutating workers to demonstrate behavioral
regressions through the real production path. Focused coverage and the full
offline suite pass after both corrections.

A subsequent difficult-goal probe was cancelled before its evidence verdict
after direct inspection found that one high-effort Luna action had grouped four
independently testable TUI behaviors and produced shallow coverage. The scout
and planner now distinguish mutation ordering from task size: shared files
forbid parallel writers, but several coherent acceptance slices may reuse those
files in a short ordered sequence, with each behavior kept beside its focused
regression test.

The next planning probe improved to two ordered work actions, but the first
still used one umbrella action for several independently observable clauses
inside a single long requirement. Direct inspection found missing Esc-at-list
and sibling-workflow fallback semantics before the next slice finished, so the
run was cancelled without waiting for rejection. Scout and planner guidance
now permits multiple ordered actions to affect the same requirement and keeps
independently testable clauses as separate default task boundaries.

The next probe produced the intended seven ordered acceptance slices, but its
first worker still implemented later breadcrumb and transition work early. The
planner was no longer the source of the merge: the runtime-generated worker
task repeated the full parent goal and full affected-requirement prose ahead of
the bounded action prompt. Work tasks now expose only the action purpose,
owned files, traceability identifiers, dependencies, and the planner-authored
slice, with an explicit prohibition on sibling, downstream, or whole-goal work.
The full requirement text remains available to the kernel-owned evidence
action, where it belongs.

The following retry exposed a separate isolation leak before the first worker
finished: the runtime header named the isolated action worktree, while the
planner-authored action prose still repeated the integration target path. A
worker command consequently created scratch files in the target worktree
instead of its isolated worktree. The kernel now rewrites exact target-path
references in mutating action prose to the action's actual workspace before
dispatch; regression coverage proves the integration path is absent from an
isolated worker task.

The first fully executed retry reached independent evidence with seven clean
first-attempt work actions, then failed one mandatory navigation clause: the
pure helper moved between agents, but the live TUI still scrolled detail text
instead of changing the selected agent. Its live-input test only searched the
aggregate terminal output for strings that were already present and therefore
could not prove the transition. Planner and worker contracts now require an
explicit level-by-input transition matrix, distinguishable before/after
fixtures, observable live-state assertions, and a clause-by-clause final
coverage audit for interactive or state-machine work.

The next difficult-goal retry completed four first-attempt actions, then an
ancestor-navigation worker left the normally sub-second focused dashboard test
process idle with an open handle for several minutes. The process remained
alive but semantic activity had stopped, so the watchdog investigation
cancelled the run instead of waiting indefinitely. Planner and worker
contracts now define a focused test exceeding 60 seconds or twice its observed
baseline without progress as a defect to interrupt and diagnose. Subsequent
canaries move work actions to Command Code Luna while retaining Luna-only
routing, so provider-shell behavior is tested independently of the planning
contract.

That route probe immediately exposed a CLI contract defect: `--worker-pool
command-code` was stored as a preference, so the ineligible analyze-only scout
silently fell through to `claude-code` with the Luna model and failed. The flag
is documented as a pin and now persists an exact strict worker pool; an
ineligible pinned pool fails closed instead of dispatching a different
provider. Because Command Code is currently declared build/chore-only, the
full hard-case canary remains on Relay/OpenCode Luna rather than pretending it
can pin every scout, work, and evidence action to Command Code.

The first strict OpenCode hard-case canary then exposed an ordering defect in
evidence dispatch: ancestor-pool avoidance ran before the strict pool filter.
The presence of unrelated eligible pools removed the pinned OpenCode ancestor,
then strict filtering removed those unrelated pools, producing `no eligible
pool` without an agent attempt. Strict routing now defines the candidate scope
first; evidence prefers an independent credential only inside that scope and
reuses the pinned ancestor when independence would otherwise deadlock.

The replacement hard-case canary then found that a prompt-only instruction to
interrupt a focused test after 60 seconds cannot help while the coding agent is
blocked inside its synchronous shell tool. A Luna worker added an interactive
dashboard regression that kept `node --test` alive far beyond the repository's
normal full-suite time. V2 work and planning prompts now require Node focused
tests to run as `node --test-timeout=60000 --test <focused files>` and forbid
`--test-force-exit`; a broken async test therefore returns a deterministic
failure to the same worker for diagnosis without imposing a wall-clock limit on
the overall agent conversation.

The next hard-case evidence action then correctly rejected a superficially
green implementation: the scout had identified eight independently observable
units, but the planner collapsed footer wording, sibling Tab navigation, and
level-by-level ascent into one long action, which missed those clauses. The
scout's trailing kebab-case unit array is now a validated kernel handoff. On the
initial program, every exact scout unit ID must exist as its own non-evidence
work action before dispatch; shared files are ordered by dependencies, while
the planner may no longer silently rename, omit, or absorb a unit.

That exact-unit canary still exposed a second information-loss boundary: the
final evidence agent found `q exit` versus `q detach`, but the responsible work
task contained only requirement identifiers and planner-authored prose. The
explicit original clause naming that inconsistency had been removed in an
earlier anti-scope-leak hardening. Bounded work tasks now include the exact text
of only the requirements listed in `affects`, framed as authoritative
clause-by-clause acceptance evidence rather than permission to perform sibling
or downstream work; the full parent goal remains omitted.

The following repetition exposed two deeper transport defects. First,
`extractGoalRequirements` had compacted every numbered acceptance clause to 600
characters, so the durable requirement and bounded work task still lost the
decisive suffix even though the handoff claimed to be exact. V2 requirements
are now whitespace-normalized but lossless; only presentation code may
truncate copies. Second, an evidence agent validated a correct temporary JSON
file and then mangled the JSON while retyping it into its final response. The
kernel now names a durable per-action candidate path, requires the agent to
validate that exact file, and consumes that exact file after dispatch. Model
response prose is no longer the evidence schema transport.

The next initial planner attempt exposed the same split path for plans: its
temporary candidate passed the CLI checker, but the checker had not loaded the
scout's exact unit list, while the runtime validator did. The model then
retyped malformed JSON and omitted one unit to fit an artificially tight
canary action cap. Planner turns now use a durable candidate file too, and the
CLI checker derives the same required scout units as runtime. Canary limits
must reserve capacity for the scout, planner, every required work unit, and at
least one evidence action; the difficult fixture therefore uses 12 action and
16 dispatch slots rather than an impossible 10/12 split.

The first full repetition on that candidate completed all ten work units on
their first attempt, then evidence rejected one cross-cutting layout clause.
The scout had correctly warned that narrow run/phase/agent views still
collapsed to one pane and contradicted the goal's `always` qualifier, but it
made the final integration unit tests-only. The planner then preserved the
contradictory mobile tests instead of assigning a production owner to migrate
them. Scout, planner, and worker contracts now treat universal, negative, and
boundary qualifiers as separate mandatory checks; current tests never outrank
the goal; and a requirement spread over several slices must end in a
mutation-capable cross-cutting acceptance unit that owns production code and
tests and may close integrated gaps. The zero-rejection streak remains reset
until this correction passes the difficult canary from a fresh worktree.

The immediate replacement stopped earlier on the corrected uniform-layout
slice, but for a different mechanical reason: the planner listed the broad
tests-and-changelog requirement in `affects` merely because the action edited
dashboard tests. Runtime therefore supplied the unrelated changelog clause
while exact ownership correctly forbade `CHANGELOG.md`; the worker followed
the clause and was rejected for out-of-scope mutation. `affects` now means
direct ownership of a bounded acceptance slice, not incidental test/file
association. Requirement prose is explicit context for the named purpose and
prompt, never an ownership expansion; sibling clauses requiring another file
must remain with their own scout unit. The streak remains 0/5.

A later read-only reliability canary found a deterministic cancellation
durability mismatch: the dashboard persisted `source` and `requesterPid`, but
the V2 state validator rejected those fields on reload or resume. The schema
now accepts and validates that provenance, and a round-trip/resume regression
guards it. The same canary also clarified that ordinary work output and
evidence transport are intentionally different: non-evidence workers deliver
their full result in the captured final response, while evidence workers write
the kernel-provided candidate JSON so exact schema validation does not depend
on the model retyping its verdict. Those rules must not be conflated in future
acceptance prompts. The suite passes 507/507 at commit `f9c6718`, and the clean
streak restarted from that exact revision with three parallel Luna-only hard
repetitions: `j4yp52`, `fcpins`, and `ib22vs`.

Sequences 16-17 remain acceptance work: the five-run zero-rejection canary
streak (including the difficult goal three times), independent review/PR/CI,
release, installed-binary verification, and the final installed canary.

## 1. Locked product shape

The V2 engine follows one rule:

> The planner decides what to try. Agents produce work or evidence. The kernel
> controls execution and decides what is true.

```text
User goal
   |
   v
+-------------------+
| Workflow Planner  |  Creates or updates a bounded work program.
+-------------------+  It does not declare success or failure.
   |
   v
+-------------------+
| Kernel Validator  |  Rejects unsafe, malformed, cyclic, overlapping,
+-------------------+  or needlessly serial plans before they spend money.
   |
   v
+-------------------+       +--------------------+
| Work Agents       | ----> | Durable Artifacts  |
+-------------------+       +--------------------+
   |                              |
   |                              v
   |                    +--------------------+
   +------------------> | Evidence Agents    |
                        +--------------------+
                                  |
                                  v
                        +--------------------+
                        | Requirement Ledger |
                        +--------------------+
                                  |
                  +---------------+---------------+
                  |                               |
          all requirements pass          verified gaps still remain
                  |                               |
                  v                               v
          stable result envelope          planner gets one gap summary
```

### 1.1 Four concepts only

1. **Workflow Planner** — proposes the complete useful program, then returns
   only when the kernel has a real semantic gap that cannot be handled
   mechanically.
2. **Actions** — generic bounded agent jobs. An action either produces work or
   collects evidence. There is no special reviewer or repair role.
3. **Workflow Kernel** — validates plans, schedules dependency-ready actions,
   routes providers, retries mechanical failures, persists state, and computes
   completion.
4. **Requirement Ledger** — records each acceptance requirement as `pending`,
   `passed`, `failed`, or `blocked`, with evidence and concerns.

### 1.2 Generic action contract

The autonomous V2 planner should emit one action shape:

```jsonc
{
  "id": "implement-result-envelope",
  "purpose": "Persist the stable workflow result envelope",
  "dependsOn": ["inspect-result-surface"],
  "affects": ["result-envelope"],
  "ownedFiles": ["src/workflow/result.js"],
  "prompt": "...self-contained bounded task...",
  "lane": "build",
  "effort": "medium",
  "evidenceFor": []
}
```

An evidence action uses the same shape but names the requirements it evaluates:

```jsonc
{
  "id": "check-result-envelope",
  "purpose": "Collect independent evidence for the result-envelope requirement",
  "dependsOn": ["implement-result-envelope"],
  "affects": [],
  "ownedFiles": [],
  "prompt": "Inspect the implementation and run the focused checks...",
  "lane": "analyze",
  "effort": "low",
  "evidenceFor": ["result-envelope"]
}
```

Evidence output is structured and scoped. A deterministic check may directly
evaluate mechanical requirements such as command success, schema validity,
file existence, or changed-path boundaries. An evidence agent evaluates
semantic requirements such as correctness, clarity, or completeness. It does
not return a global workflow verdict:

```jsonc
{
  "requirements": {
    "result-envelope": {
      "status": "passed",
      "evidence": ["tests/result.test.js passed", "src/workflow/result.js:53"],
      "concerns": []
    }
  }
}
```

The evidence envelope is versioned and V2-only. Old autonomous
`{ok, concerns, summary}` outputs are not migrated or normalized into the new
ledger. Existing run directories may remain on disk for manual inspection or
explicit deletion, but they are not resumable V2 state.

### 1.3 Requirement-ledger resolution

The ledger is authoritative about workflow state, but it does not pretend to
understand semantic truth. Agents judge meaning; the kernel validates and
aggregates their judgments. Its mechanical rules are:

- every evidence record carries its source action, the artifact/work revision
  it inspected, its committed event sequence, and its schema version;
- evidence is accepted only for requirements named by the action's
  `evidenceFor` declaration;
- for a requirement with one accepted source, the newest fresh evidence for
  the current work revision determines the requirement state;
- conflicting fresh evidence makes the requirement `blocked` and records both
  sources for planner/human resolution; it is never silently last-write-wins;
- a mechanical evidence-action failure leaves the requirement `pending` and is
  eligible for mechanical retry; a schema-valid semantic `failed` or `blocked`
  result updates the ledger without starting a repair loop;
- later work whose `affects` includes the requirement invalidates all earlier
  evidence for completion purposes while retaining it in history; and
- concerns remain attached to the evidence record. A `passed` requirement with
  concerns is still passed unless the requirement contract explicitly defines
  a concern as a failing condition.

### 1.4 Deliberate removals from autonomous V2

- No formal `verify` action type. Verification is an ordinary evidence action.
- No formal `reviewer` role. Independent evidence matters; the persona name
  does not.
- No automatic semantic `repair -> reverify` loop. A failed requirement is a
  compact gap for the planner, not permission for an unbounded correction
  cycle.
- No planner-owned phase barriers. The kernel derives presentation stages and
  execution waves from the dependency graph.
- No planner authority to mark the workflow successful or failed. Completion
  is computed from the requirement ledger and terminal action state.

Static JSON workflows and drafts retain their existing explicit step types and
fixed-graph executor. They are a separate authored-graph product surface, not
an autonomous-engine compatibility layer, and V2 must not silently reinterpret
their semantics.

The autonomous cutover is intentionally one-way:

- `bullswarm workflow goal` always creates V2 state and uses the V2 kernel;
- no engine selector, global legacy default, or dual autonomous executor is
  retained;
- a resume request for an old autonomous run returns a clear unsupported-run
  diagnostic before dispatching anything; and
- old autonomous run directories are disposable development data. They may be
  deleted at cutover and V2 listing, resume, result, watch, and TUI code has no
  obligation to parse or display them; and
- there is no autonomous state adapter, migration command, compatibility
  renderer, mixed-version test matrix, or fallback into the old planner.

The only compatibility behavior is fail-closed detection: if an old
autonomous run directory is encountered explicitly, Bullswarm reports that it
is unsupported and performs no dispatch. This guard exists to prevent an
accidental paid run, not to preserve V1 data.

## 2. Kernel invariants

These are code-enforced rules, not prompt advice:

1. A work action may depend on other work, never on an evidence verdict unless
   that verdict itself is the required input artifact.
2. Evidence actions depend on the work and artifacts they inspect.
3. Dependency-ready, file-disjoint actions start concurrently up to the
   configured cap.
4. Overlapping `ownedFiles` cannot mutate concurrently. The kernel also checks
   actual changed paths after a mutating action: an out-of-scope mutation is
   rejected and cannot become trusted evidence. Declaration-only ownership is
   insufficient.
5. New work that affects a requirement makes prior evidence for that
   requirement stale and returns it to `pending`.
6. Concerns are data attached to evidence. They are not automatically a
   failure.
7. Only mechanical failures retry automatically: authentication or provider
   availability, interrupted process, malformed structured output, or schema
   mismatch.
8. Every schema-bound worker receives a deterministic local validation command
   and must validate its candidate before final delivery. The runtime validates
   again before accepting it.
9. Semantic rejection never starts an automatic repair loop. The kernel waits
   for all independent useful actions to settle, consolidates the remaining
   gaps once, and then asks the planner for the smallest coherent follow-up.
10. A quota-blocked pool is replaced by another eligible Luna pool when one is
    available; an individual run should not wait indefinitely for one license.
11. `complete` means all mandatory requirements have fresh passing evidence,
    no required action is still runnable, and the stable result envelope was
    written.
12. Agent, action, and expansion values are advisory planning targets, not
    execution ceilings. The planner should consolidate optional work near a
    target, while the kernel continues the smallest essential program past it.
    Only explicit cancellation, an invalid or unsafe program, genuine provider
    failure, or semantic exhaustion can end unfinished useful work.

For clarity, `complete` is a process conclusion: every required mechanical
check passed and every required semantic judgment has valid, fresh,
non-conflicting evidence. It is not a claim that non-LLM code independently
understood the semantics of the user's requirement.

The ownership check compares a repository/worktree snapshot before and after
each mutating action. Non-git workspaces require an equivalent bounded file
manifest or must run in isolated worktrees; V2 must not claim enforced
ownership when it only has advisory metadata.

## 3. Planner invocation policy

The planner is a single logical, resumable conversation, shown separately from
worker phases in the TUI. It is invoked only at these boundaries:

```text
initial goal + scout evidence
    -> create complete bounded program

runnable work exhausted + unresolved semantic requirements
    -> update program from one consolidated gap report

material user steering, approval boundary, or new external fact
    -> update program
```

The planner is not called after every worker and does not poll. Mechanical
retry, dependency scheduling, schema correction, provider replacement, state
persistence, completion, and event rendering stay in the kernel.

Before dispatch, the kernel validates the planner proposal for:

- schema and known operations;
- unique IDs and acyclic dependencies;
- artifact and requirement references;
- file ownership overlap;
- unnecessary serial dependencies;
- missing evidence coverage;
- unbounded fan-out or retry behavior;
- provider/model fields that belong to routing rather than the plan; and
- invalid completion claims.

For autonomous V2, a work action with an evidence-only dependency is rejected
unless it declares that evidence artifact as a real input. Static workflows
keep their authored fixed-graph dependency semantics.

Invalid proposals receive one compact machine-generated correction request.
Repeated invalidity terminates planning with a diagnostic outcome before any
worker budget is spent.

## 4. Human and agent observability

### 4.1 One human application shell

Bare `bullswarm workflow` opens the full-screen workflow application:

```text
+ Workflows ------------------++ Workflow timeline ---------------------------+
| running / recent runs       || completed milestones, timestamped            |
| compact health dashboard    || [Preflight: Scout] completed                 |
| mobile: one pane at a time  || [Workflow Planner] plan created              |
|                              || [Phase: Implement] started/completed          |
+------------------------------+|                                               |
| Workflow Planner             || Live agents                                  |
| status, model, checkpoints   || planner + workers, latest semantic event     |
|                              || stale finished agents removed from Live      |
+ Phases ----------------------++-----------------------------------------------+
```

Wide layout uses the workflow list/sidebar plus the timeline/detail pane.
Narrow terminals use one pane at a time with explicit back navigation and the
same information hierarchy. The terminal renderer should diff frames and avoid
unnecessary full-screen redraws so SSH/mobile clients do not flash.

Default view is human language. `v` reveals technical details: prompts,
sessions, routing reasons, usage, raw events, and artifact paths.

Status vocabulary and icons must be consistent:

```text
○ not started    spinner running    ⧖ waiting    ✓ completed
× rejected/failed action            ◇ planner milestone
```

### 4.2 Timeline semantics

- `[Preflight: Scout] started/completed` describes repository reconnaissance.
- `[Workflow Planner] plan created` is the first accepted program.
- `[Workflow Planner] plan updated #N` is a later accepted program.
- `[Phase: Name] started/completed` is a kernel-derived presentation stage.
- Derived stages have stable IDs based on declared action purpose and graph
  membership, not completion order. An execution wave is scheduler state; a
  presentation stage is a durable human grouping. Concurrent completion order
  must not rename or reorder prior timeline milestones after resume.
- Completed timeline rows are dense; do not insert blank rows between every
  nested action.
- Every completed phase and action shows a timestamp; durations appear at the
  right when space permits.
- The lower `Live agents` section shows only running or genuinely waiting
  agents, each with its latest semantic streamed event and freshness.
- The `Next` line uses direct wording such as `Waiting for 1 worker`,
  `Planner will reassess remaining gaps`, or `Workflow complete - result is
  ready`.

### 4.3 Quiet machine watch

`bullswarm workflow watch <run>` should optimize for an observing agent's
context budget:

- default: one low-noise heartbeat every 30-60 seconds only when meaningful;
- heartbeat: terminal state, running/waiting counts, new durable event count,
  most recent semantic event, and seconds since last activity;
- no repeated prompts, raw streamed bytes, or unchanged action lists;
- `--verbose` opts into the richer semantic event stream;
- terminal output ends with the exact next command for the stable result;
- a separate snapshot/result command supplies detail after watch completes.

## 5. Execution sequence and delegation map

Delegation labels:

- **Luna-owned** — suitable for one bounded `bullswarm run` with explicit file
  ownership and a focused acceptance command.
- **Luna-assisted** — Luna may audit, design fixtures, or implement an isolated
  portion; the primary agent owns integration and the final semantic decision.
- **Primary only** — cross-cutting contract, cutover, release, or final
  acceptance work should remain in the controlling agent's context.

All Luna calls during this revamp use `bullswarm run`, pinned through strategy
to an eligible `opencode2` Relay GPT-5.6 Luna pool. Do not use Minimax, Fable,
or `bullswarm workflow goal` for delegated implementation.

| Seq | Work package | Ownership | Exit gate |
| ---: | --- | --- | --- |
| 0 | Freeze this V2 contract; inventory current planner, decision, runner, result, event, dashboard, and watch surfaces | Luna-assisted | Reviewed map of symbols/tests; no behavior changed |
| 1 | Add V2 requirement-ledger data types and pure state transitions | Luna-owned | Unit tests cover pending/pass/fail/block/stale and serialization |
| 2 | Add the generic V2 action/evidence schema and deterministic proposal validator | Luna-owned | Invalid cycles, refs, overlap, serialization, evidence coverage, and bounds fail before dispatch |
| 3 | Define the V2-only autonomous run format and cutover boundary while preserving the separate static workflow/draft executor | Luna-assisted | Every new goal is V2; an old autonomous resume is rejected before dispatch; fixed authored graphs remain unchanged |
| 4 | Add scheduler rules for generic actions, enforced file ownership, dependency-ready concurrency, and evidence independence | Luna-assisted | Simulations prove no evidence action blocks unrelated work, no overlapping writers race, and out-of-scope mutation is rejected |
| 5 | Add requirement invalidation when later work affects already-evaluated requirements | Luna-owned | Focused state-machine tests prove stale evidence cannot satisfy completion |
| 6 | Add the V2 evidence-output schema, worker-side validator command, and authoritative runtime validation | Luna-owned | Malformed outputs never become success; valid output needs no schema retry |
| 7 | Replace autonomous semantic repair loops with gap consolidation and bounded planner re-entry | Primary only | One semantic rejection yields one consolidated gap; no automatic repair/reverify chain |
| 8 | Refactor the planner contract to emit complete generic programs and consume compact requirement gaps | Primary only | One valid initial plan on canonical fixtures; invalid plan correction is bounded |
| 9 | Move completion authority entirely into the kernel and emit one stable V2 result envelope, including partial outcomes | Primary only | Planner cannot force completion/failure; the result explains passed and unresolved requirements |
| 10 | Derive stable presentation stages separately from execution waves and emit durable timeline events | Luna-assisted | Replay with varied concurrent completion order recreates the same stage IDs, order, action, and planner milestones |
| 11 | Finish unified workflow list/detail TUI, mobile pane navigation, frame diffing, icons, live-agent filtering, and plain-language `Next` | Luna-owned in disjoint UI slices | Golden wide/narrow snapshots; no flashing under unchanged refresh; completed agents leave Live |
| 12 | Make `watch` heartbeat-quiet by default and add `--verbose` | Luna-owned | Token-sized snapshot tests; unchanged intervals do not repeat verbose state |
| 13 | Refresh every workflow/help/README/skill surface and the explicit cutover note | Luna-owned | Help audit covers all verbs/subverbs; examples match live CLI and V2 terminology |
| 14 | Run deterministic component reliability suite and fault injection | Luna-assisted | Zero unexpected dispatches; all mechanical and semantic branches have tests |
| 15 | Run bounded real-provider component probes on Luna, aborting on first rejection | Primary only | Planner, worker schema, evidence, routing fallback, result, watch, and TUI probes pass separately |
| 16 | Run end-to-end canaries across representative goals | Primary only | Five consecutive zero-rejection runs; the historical difficult goal passes three times |
| 17 | Independent review, release, installed-binary verification, and post-release rerun | Primary only | PR approved, CI green, npm version current, PATH binary current, canary passes installed CLI |

## 6. How Luna delegation will be used

### 6.1 Preflight

Before any direct delegation:

1. Save the existing strategy assignments.
2. Confirm an eligible `opencode2` Luna model is visible and not quarantined.
3. Temporarily assign the required effort tier to
   `opencode2/relay/gpt-5.6-luna` (or another explicitly approved Relay Luna
   pool).
4. Run `bullswarm strategy show --json` and verify the assignment actually
   resolves to Luna.
5. Restore prior assignments after the delegated batch unless the user has
   chosen a persistent Luna-only development policy.

If a second Relay credential is configured, expose it as a separate eligible
pool rather than embedding credentials in prompts or logs. The router may then
replace a quota-blocked Luna pool with the other Luna pool. Authentication
material must never appear in this plan, task files, events, or command output.
The two-pool fault-injection gate is conditional on both pools being configured
and eligible; otherwise the acceptance record must say exactly which pool or
meter prerequisite was absent rather than claiming fallback was tested.

### 6.2 Task shape

Each delegated task is intentionally small:

```bash
bullswarm run \
  --lane build \
  --effort low \
  --add-dir /Users/cowcow02/Repo/bullswarm \
  --task-file /absolute/path/to/bounded-task.md \
  --heartbeat 30 \
  --json
```

Direct Luna work has no default wall-clock timeout. `--heartbeat 30` emits only
aggregate elapsed/event/byte/freshness state on stderr while leaving JSON
stdout clean; it is implemented and covered by CLI tests. A long-running worker may
continue while its process, output artifact, or semantic heartbeat shows fresh
activity. Silence triggers inspection, not automatic cancellation. Stop a
delegate only after confirming a real stall, unsafe behavior, revoked scope, or
an explicit user request.

Every task prompt must state:

- exact owned files or read-only scope;
- the single outcome;
- constraints and non-goals;
- focused tests or inspection commands;
- the expected final response shape; and
- that unrelated user changes must not be reverted.

The primary agent accepts a delegate result only when Bullswarm returns
`ok:true`, the referenced `outFile` contains substantive evidence, the diff is
within ownership, and the focused tests pass locally. Exit code alone is never
authority.

### 6.3 Parallelism

Direct Luna runs may overlap only when their file ownership is disjoint. Tasks
that touch the same contract, schema, runtime, or snapshots run sequentially.
The primary agent integrates after each small batch to keep failures easy to
attribute.

### 6.4 Direct-delegation smoke evidence

Two consecutive read-only plan reviews were dispatched through direct
`bullswarm run` after pinning the low effort tier to
`opencode2/relay/gpt-5.6-luna`:

| Probe | Bullswarm verdict | Wall time | Known tokens | Runtime behavior |
| --- | --- | ---: | ---: | --- |
| Initial architecture/sequence review | `ok:true`, `why: verified` | 95.9 s | 1,646 | exit 0; no timeout, cancellation, schema rejection, or content rejection |
| Eight-gate plan recheck | `ok:true`, `why: verified` | 34.9 s | 787 | exit 0; all eight requested gates returned `PASS` |

The saved outputs are
`~/.bullswarm/runs/out-1788167364085-oognp.md` and
`~/.bullswarm/runs/out-1788167616123-eig4o.md`. Both contained substantive
repository-cited analysis and their `pick` records named
`opencode2/relay/gpt-5.6-luna`.

This is evidence that direct, bounded, read-only Luna delegation is working
twice in succession. It is not yet evidence that mutating implementation tasks,
long tasks, parallel calls, or provider fallback are reliable; those remain in
Layers B and C. The preflight also observed a second configured
`opencode2:relay-2` pool exposing Luna, so the later fallback fault-injection
gate has a candidate, but no authentication or quota-failure simulation was
performed while writing this plan.

## 7. Reliability method

End-to-end reruns are the final proof, not the debugging method.

### Layer A - deterministic component tests

- proposal schema and graph validation;
- dependency and ownership scheduling;
- requirement-ledger transitions and stale evidence;
- worker output preflight plus runtime schema validation;
- completion and partial-result computation;
- V2 run-format validation and fail-closed rejection of old autonomous resume;
- retry classification and Luna-pool replacement;
- event replay, quiet watch, and wide/narrow TUI snapshots.

### Layer B - model-in-the-loop component probes

Use small disposable fixtures to test separately:

1. Can Luna create a valid, sufficiently wide plan?
2. Can a Luna worker complete a correctly scoped task without violating file
   ownership?
3. Can an evidence agent return schema-valid, requirement-scoped evidence?
4. Can the kernel consolidate a semantic gap without creating repair loops?
5. Can routing replace an unavailable Luna pool without waiting indefinitely?

The result layer emits one explicitly versioned V2 envelope. CLI JSON consumers
must receive its schema version; no field may silently change meaning.

Any rejected or failed agent stops that probe immediately. Inspect its durable
task, output, events, route decision, schema errors, and diff; add the smallest
deterministic fix and regression before trying again.

### Layer C - representative end-to-end canaries

Use the same routing policy and fresh disposable worktrees for:

- read-only architecture/report audit;
- single-module implementation with focused tests;
- file-disjoint multi-module implementation;
- discovery-driven fan-out;
- documentation/help freshness audit;
- structured-output producer/consumer flow;
- quota/auth replacement between Luna pools; and
- the historical TUI/workflow goal that produced repeated verifier rejection.

Success target:

- five consecutive terminal runs with zero rejected agents, zero schema
  corrections, zero semantic repair loops, and correct external acceptance;
- within that streak, the historical difficult goal succeeds three times;
- no run is counted if its result is only superficially green: inspect durable
  actions, artifacts, diffs, tests, evidence ledger, cost, planner turns,
  parallelism, and final result envelope;
- on the first rejection, cancel the workflow, diagnose, patch, and restart the
  streak after deterministic regression coverage is added.

Track per run: wall time, planner time/turns, worker count, peak concurrency,
tokens/cost by pool, mechanical retries, semantic failures, schema corrections,
requirements passed/blocked, and external acceptance result.

## 8. Performance targets

The revamp is successful only if it improves both reliability and economics:

- one initial planner turn in the normal case;
- no planner turn between dependency-ready actions;
- no automatic semantic repair loops;
- file-disjoint work runs concurrently;
- planner context contains compact action/requirement summaries, not full
  historical routing metadata and repeated output;
- ordinary structured outputs validate before final delivery and require zero
  runtime correction retries;
- default watch output remains a small heartbeat;
- a quota-blocked provider is replaced promptly when an eligible Luna pool
  exists; and
- partial useful work is delivered with gaps instead of being discarded behind
  a blanket failure label.

Baseline and final measurements must use the same fixtures. Claims about
speed, cost, quality, or rejection rate require observed numbers, not a green
process exit.

## 9. Release and rollback gates

1. All offline tests pass without network.
2. Static workflows, drafts, V2 resume, cancellation, routing, and quarantine
   remain green; old autonomous resume fails before dispatch.
3. The V2 autonomous engine remains unreleased until component probes pass.
4. The five-run zero-rejection streak and three hard-case repetitions pass on
   the exact candidate revision.
5. A separate agent reviews the PR from code and evidence, not from this plan.
6. Release through the repository release command and trusted publishing.
7. Verify the npm registry version, the actual PATH-resolved `bullswarm`
   binary, installed skill source, `--help`, unified TUI, quiet watch, and a
   final installed-binary canary.
8. If V2 produces a regression in durable state, completion, or routing, stop
   new autonomous launches and preserve the V2 artifacts for replay; do not
   fall back to the retired autonomous engine.

## 10. Definition of done

V2 is done when a user can provide a goal and observe this simple lifecycle:

```text
goal accepted
  -> plan created
  -> independent work runs in parallel
  -> evidence updates visible requirements
  -> one replan only if real gaps remain
  -> stable result is ready
```

The user should not need to understand planner cycles, reviewer personas,
repair rounds, internal verifier status, provider quota details, or raw event
streams to know what is happening. Those details remain available under the
technical view for diagnosis and audit.
