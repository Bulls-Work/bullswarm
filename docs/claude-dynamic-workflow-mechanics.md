# How Claude Code drives a dynamic workflow — mechanics, and what bullswarm adopts

Written 2026-08-29 from inside a Claude Code session that has the `Workflow`
tool ("ultracode") loaded, by the model that authors those workflows.

Every statement is tagged:

- **[SPEC]** — quoted or closely paraphrased from the `Workflow` tool contract
  and the `workflow-authoring` reference as loaded into the session on
  2026-08-29. This is the documented behaviour the orchestrating model is
  told to rely on.
- **[OBSERVED]** — measured in this repository's experiments
  (`docs/experiments/2026-08-29-ultracode-vs-bullswarm.md`).
- **[INFERRED]** — my reading of how the harness must behave to satisfy the
  spec. Not confirmed by source; treat as a hypothesis.
- **[IMPLEMENTED]** — behavior shipped in Bullswarm and backed by its source
  and regression suite, rather than a claim about Claude's workflow contract.

## 0. The one-paragraph shape

Claude's orchestrator (the main-loop model) does **not** decide step-by-step at
runtime. It writes a *program* — a small JavaScript script — that declares the
phases and calls `agent(prompt, opts)` once per worker, wired together with
`pipeline()` / `parallel()` / plain loops. The harness executes that program
deterministically, spawning subagents concurrently up to a cap, and the model
reads the aggregate return value when the program finishes. Planning is
front-loaded into one authoring act; parallelism is explicit in the code; every
worker receives an individually written, self-contained prompt and (usually) a
JSON schema its answer must satisfy. Re-planning happens either as ordinary
code (loops, conditionals) inside the script, or between scripts when the model
reads a result and authors the next one. **[SPEC]**

bullswarm's `workflow goal`, by contrast, runs an LLM *at every checkpoint*: a
`decide` step proposes JSON actions, the runtime validates and executes them,
then asks the LLM again. **[SPEC — bullswarm source]** The rest of this document
is about which of Claude's mechanics that loop can adopt without giving up its
one advantage — the user supplies a goal, never a graph.

## 1. Mechanics, one at a time

### 1.1 The control plane is code, authored once **[SPEC]**

- A script must begin with a pure-literal `export const meta = { name,
  description, phases: [{ title, detail }] }`; the body uses `phase()`,
  `agent()`, `pipeline()`, `parallel()`, `log()`, `args`, `budget`, and
  `workflow()` (one level of nesting).
- The tool is explicitly for "multi-step orchestration where control flow
  should be deterministic (loops, conditionals, fan-out) rather than
  model-driven."
- The recommended pattern is **hybrid**: "scout inline first (list the files,
  find the channels, scope the diff) to discover the work-list, then call
  Workflow to pipeline over it. You don't need to know the shape before the
  *task* — only before the *orchestration step*."
- Multi-phase work is several workflows in sequence: "run several in sequence —
  read each result before deciding the next phase. You stay in the loop; each
  workflow is one well-scoped fan-out."

Consequence: between two agents inside one workflow there is **no model
round-trip**. The next agent starts the instant its inputs exist. **[INFERRED
from spec; consistent with OBSERVED timings]**

### 1.2 Phases are progress groups, not barriers **[SPEC]**

- `phase(title)` starts a new phase; "subsequent agent() calls are grouped
  under this title in the progress display". `opts.phase` on `agent()` assigns
  the group explicitly and exists precisely "to avoid races on the global
  phase() state" inside `pipeline()`/`parallel()` stages.
- Titles are matched exactly against `meta.phases`; an unmatched title "just
  gets its own progress group".
- Nothing about a phase synchronises work. The **only** barrier is
  `parallel()`.

### 1.3 Parallelism primitives **[SPEC]**

- `pipeline(items, stage1, stage2, …)`: "run each item through all stages
  independently, NO barrier between stages. Item A can be in stage 3 while item
  B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock =
  slowest single-item chain, not sum-of-slowest-per-stage." A stage that throws
  drops that item to `null` and skips its remaining stages.
- `parallel(thunks)`: "run tasks concurrently. This is a BARRIER … Use ONLY
  when you genuinely need all results together." A barrier is justified only
  when stage N needs cross-item context from all of stage N−1 (dedup/merge,
  early exit on zero count, "compare with the other findings").
- Anti-barrier guidance is explicit: "'I need to flatten/map/filter first' —
  do it inside a pipeline stage"; "'The stages are conceptually separate' —
  that's what pipeline() models. Separate stages ≠ synchronized stages."
- Caps: "Concurrent agent() calls are capped at min(16, available CPUs − 2) per
  workflow — excess calls queue and run as slots free up." Lifetime cap 1000
  agents; ≤ 4096 items per `parallel()`/`pipeline()` call.

### 1.4 One prompt per agent, structured return **[SPEC]**

- `agent(prompt, opts)`; "Subagents are told their final text IS the return
  value (not a human-facing message), so they return raw data."
- `opts.schema` (JSON Schema): "the subagent is forced to call a
  StructuredOutput tool and agent() returns the validated object — no parsing
  needed … validation happens at the tool-call layer so the model retries on
  mismatch."
- Other per-agent knobs: `label` (display), `phase` (group), `model`
  (override; "default to omitting it"), `effort` (`low`…`max`), `isolation:
  'worktree'` ("EXPENSIVE … use ONLY when agents mutate files in parallel and
  would otherwise conflict"), `agentType` (custom subagent definition).
- `agent()` "returns null if the user skips the agent mid-run or the subagent
  dies on a terminal API error after retries (filter with .filter(Boolean))."

### 1.5 Failure semantics live in code **[SPEC]**

- `parallel()` "never rejects" — a failing thunk becomes `null`.
- Retry, repair and convergence are ordinary loops: *loop-until-count*,
  *loop-until-budget*, *loop-until-dry* ("keep spawning finders until K
  consecutive rounds return nothing new"). No planner turn is spent deciding to
  retry; the script already says so.

### 1.6 Determinism and resume **[SPEC]**

- `Date.now()`, `Math.random()`, argless `new Date()` throw in scripts ("they
  would break resume"); timestamps come in via `args`.
- Every invocation persists its script; the run's `journal.jsonl` "records each
  agent's actual return value". Resume = same script + `resumeFromRunId`: "the
  longest unchanged prefix of agent() calls returns cached results instantly;
  the first edited/new call and everything after it runs live."

### 1.7 Budget is a hard ceiling **[SPEC]**

- `budget.total / spent() / remaining()`; "The target is a HARD ceiling, not
  advisory: once spent() reaches total, further agent() calls throw."
- bullswarm deliberately does the opposite (advisory targets, by user
  decision: "a failed run is more costly than a slightly over budget run").
  This difference is kept on purpose.

### 1.8 Observability **[SPEC]**

- Progress is rendered as a tree grouped by phase, with per-agent labels;
  `log()` "emit[s] a progress message to the user (shown as a narrator line
  above the progress tree)"; `/workflows` shows live progress; the tool result
  carries the `runId` and transcript directory.

### 1.9 Quality patterns the orchestrator is told to compose **[SPEC]**

Adversarial verify (N skeptics prompted to refute; kill on majority),
perspective-diverse verify (distinct lenses instead of N identical refuters),
judge panel (N independent attempts → parallel judges → synthesis), loop-until-
dry, multi-modal sweep, completeness critic, and "no silent caps: if a workflow
bounds coverage (top-N, no-retry, sampling), log() what was dropped."

### 1.10 Ultracode **[SPEC]**

"When a system-reminder confirms ultracode is on, that opt-in is standing:
author and run a workflow for every substantive task by default … For
multi-phase work (understand → design → implement → review), that often means
several workflows in sequence — one per phase — so you stay in the loop between
them."

## 1.11 Upfront plan or mid-flight steering? — the answer

The question that decides how bullswarm should converge: does Claude prepare
all phases and parallelism **before** the workflow starts, or does it keep
planning **during** execution?

**Before. Entirely.** The orchestrator model writes one complete program, the
harness validates it, and then executes it without consulting the model again.
Evidence:

- **[SPEC]** the script is passed whole and parsed before any agent runs;
  "Use this tool for multi-step orchestration where control flow should be
  deterministic (loops, conditionals, fan-out) rather than model-driven";
  "Workflows run in the background — this tool returns immediately … a
  task-notification arrives when the workflow completes."
- **[OBSERVED, goal 2]** ~4 minutes of inline scouting and advisor review →
  one 23 k-character script (probe → author → adversarial verify → fix-loop,
  per module) → rejected on a parse error before any agent spawned → corrected
  in 80 s → ~20 minutes of execution with six agents concurrent and **zero
  orchestrator decisions**. The session's own words: "the harness will
  re-invoke me when it completes, so polling would just burn tokens. Waiting."

What *looks* like mid-flight steering is pre-authored into the program:

1. **Data-driven shape.** A stage's structured result (`schema`) becomes the
   next stage's items: `pipeline(discovery.failures, fix, verify)`,
   loop-until-dry. The author fixes the *policy*; the runtime fixes the *size*.
2. **Repair as code.** `if (!verify.ok) { fix; verify }` bounded by a counter.
   Every fix → re-verify handoff observed in the goal-2 journal was this `if`.
3. **Budget as data.** `budget.remaining()` scales loops; the ceiling is hard.

Model-level re-planning exists only **at workflow boundaries**: "run several
in sequence — read each result before deciding the next phase"; the hybrid
"scout inline first … then call Workflow"; and edit-and-resume ("the longest
unchanged prefix of agent() calls returns cached results instantly; the first
edited/new call and everything after it runs live"). Steering means stop, edit
the program, resume — never a per-step decision.

**Consequence for bullswarm.** Converge on *Direction A — a program, not a
step list*: one planning turn produces the complete graph **plus** the
adaptation policy, the runtime executes it to completion, and the planner is
consulted again only at the boundary (complete, or next program). Do not build
a continuous mid-flight steering loop (Direction B); Claude has none inside a
workflow, and bullswarm already has `steer`, cancel and resume for the
boundary-level levers. What the runtime still lacks to express a program is
listed in §4.2 (0.12.0 scope).

## 2. What that looks like from the outside **[OBSERVED]**

Filled from the experiment report as runs complete. Numbers here are copied
from `docs/experiments/2026-08-29-ultracode-vs-bullswarm.md`, never projected.

- bullswarm 0.10.9 smoke goal ("create hello.txt and verify it"), single pool
  `claude-code` pinned to `claude-opus-5`: wall 553 s; **4 orchestrator turns =
  438 s (79 % of wall)**; 2 worker attempts = 114 s; max concurrency 1; 6
  dispatches; ~29 k tokens (bullswarm's byte/4 estimate). Two of the four turns
  were spent recovering from a `verify` proposal whose `review` field carried
  instructions instead of an artifact path — a shape the 0.10.9 planner
  skeleton itself had suggested.
- bullswarm 0.10.9 on the 7-module fixture (baseline, `--concurrency 8`): the
  orchestrator's first decision (152 s) proposed one serial chain
  discover → implement → verify and wrote: "Implementation is deliberately NOT
  fanned out: all fixes land in one shared working tree and converge on
  src/index.js, so concurrent workers would violate the shared-target mutation
  policy and race on the barrel file." The policy it cites was a caution line
  in the planner prompt; a concurrency cap of 8 was available and unused.
  Discovery alone then ran 458 s. (Final numbers: experiment report.)
- Final comparison on the 6-module fixture (experiment report for the full
  tables). Goal 2 (known items): Claude 58 min, 24 agents, 0 orchestrator
  turns during execution, parallelism 3.1 · bullswarm 0.11.1 41 min, 3 planner
  turns (27 %), max 6 concurrent, parallelism 2.74 · bullswarm 0.12.1 48 min of
  execution after a 3 h quota wait it survived, 4 planner turns (two caused by
  the bug fixed in 0.13.1), max 7 concurrent, one live repair round. Goal 3
  (discovered items) on 0.13.1: 28 min 42 s, **one planner turn**, the runtime
  recorded `complete` itself, exactly the three unguarded modules fixed,
  75/75 tests.

## 3. bullswarm today, mechanic by mechanic

| Mechanic | Claude `Workflow` | bullswarm ≤ 0.10.9 | Gap |
| --- | --- | --- | --- |
| Control plane | Code, authored once; no model call between agents | LLM `decide` turn at every checkpoint; each turn is a fresh `claude -p --resume` process reading the full durable context | Structural. Reachable target: **one planning turn per replan-worthy event** (initial DAG; then only on failure/completion), not per action |
| Phases | Labels for grouping; never synchronise | Forward-only kebab-case names per action; also just labels | None |
| Parallelism | `pipeline` default, `parallel` barrier; cap min(16, CPUs−2) | `executeActions` ran dependency-ready siblings **serially** (`runner.js:558`); only `fanout` items ran concurrently; goal default concurrency 3 | **Fixed in 0.11.0** — ready-set scheduler + default 8 |
| Planner bias | Script author is told to fan out and default to pipeline | Goal prompt said "return needs_more_work with the **smallest useful set** of bounded … actions" (`goal.js:18`) and planner prompt said "keep actions cohesive" | **Fixed in 0.11.0** — "propose the COMPLETE dependency graph", per-item fix→verify chains, file ownership, self-contained prompts |
| Per-agent prompt | Self-contained, plus JSON schema enforced at tool layer | Planner-authored prompt; `outputSchema` validates structured worker data, while `verify` retains its fixed JSON verdict | Adopted for declared schemas; tool-layer enforcement remains a difference |
| Failure handling | Loops in code; `null` on agent death | Planner replans (costly); 0.10.9 added corrective turns for invalid decisions and 0.11.0 recovers mis-shaped `verify.review` before dispatch | Improved; retry-in-code per action still absent |
| Determinism / resume | Journal of return values; prefix cache | Durable `state.json` + `events.jsonl` + action ledger; resume skips durable outputs | Equivalent |
| Data-driven fan-out | `pipeline(discovered.items, …)` — count unknown when the script is written | Decision schema forced inline `items`; the planner spent a turn waiting for discovery | **Fixed in 0.12.0** — `itemsFrom` on proposed fan-outs + one bounded extraction retry |
| Repair loops | `while`/retry in code | Planner replanned after every failed verify | **Fixed in 0.12.0** — `verify.repair` policy runs fix → re-verify inside the executor |
| Budget | Hard ceiling | Advisory targets (user decision) | Intentional difference |
| Observability | Progress tree, narrator, `/workflows` | `watch` heartbeat (semantic quiet + agent-output quiet since 0.10.9), `tui`, events | Comparable |
| Isolation | `isolation: 'worktree'` per agent | Shared `addDir`; planner-declared file ownership | Candidate |

## 4. Adopted into bullswarm 0.11.0

1. **Ready-set scheduler** (`src/workflow/runner.js`, `executeActions`).
   Every action whose `dependsOn` have all succeeded is launched immediately;
   a dependent action starts the moment *its own* dependencies finish, not when
   the whole round finishes. The global dispatch limiter
   (`settings.concurrency`) caps real concurrency. This gives `pipeline`
   semantics to any DAG the planner proposes: verify-B overlaps fix-C.
   Test: `dependency-ready sibling actions run concurrently and dependents
   start as soon as their own inputs finish` (`tests/workflow-adaptive.test.js`).
2. **Planning doctrine in the planner prompt** (`src/workflow/runtime.js`) and
   goal orchestrator prompt (`src/workflow/goal.js`): propose the complete graph
   in one decision; independent actions run concurrently; per-item fix→verify
   chains plus one final whole-system verify; explicit file ownership per
   action and `dependsOn` for any same-file edits; self-contained worker
   prompts with absolute paths and the exact acceptance command. The prompt
   also states the cost of a planning turn so the model can weigh it. The
   context exposes `executionConstraints.concurrency` and
   `readySiblingsRunConcurrently: true`.
3. **Default `--concurrency` 8** for `workflow goal` (was 3; max 16).
4. **`verify.review` contract made survivable**: instructions placed in
   `review` are moved to `prompt` and the single dependency's artifact is
   inferred; a `review` that is not `outputs.<actionId>.outFile` is rejected at
   validation (so the 0.10.9 corrective turn fixes it) instead of failing a
   dispatch after a planning round trip.

### 4.2 Adopted in 0.12.0 — a *program* expressible in one decision

The user's framing for this release: position the orchestrator as the
**compiler** of the goal into a workflow program; the program drives every
phase and turn; the model is consulted again only at a boundary that needs
judgement — the same division of labour Claude Code uses between the script
author and the `Workflow` runtime.

1. **Data-driven fan-out in proposals** — shipped. A proposed `fanout` takes
   `itemsFrom: "outputs.<actionId>.outFile"` (producer may be co-proposed; it
   becomes an implicit `dependsOn`). The runtime resolves the list when the
   producer finishes. This is Claude's `pipeline(discovery.failures, …)`: the
   planner no longer spends a turn waiting to see how many items there are.
2. **Structured worker output** — shipped in its cheap form. Discovery workers
   are told to end with a JSON array; `parseJsonArray` prefers the trailing
   array; the content gate accepts a bare JSON array/object as substance; and
   if the output still has no array the runtime runs ONE bounded, read-only
   extraction action over it (never re-running the producer, which may have
   mutated files). That is the "schema retry" of Claude's `StructuredOutput`,
   done as a second cheap agent instead of a tool-layer retry.
3. **Pre-authored repair** — shipped. `repair: { prompt, maxRounds }` on a
   verify: verify-fail → `<verifyId>-repair-<n>` (concerns verbatim) →
   re-verify, inside the executor. Claude's fix-loop as code.
4. **Boundary-only consultation** — the loop is now: decision 1 = the program;
   the ready-set executor runs it to completion (fan-outs resolve, repairs run);
   decision 2 = `complete` or the next program. The planner prompt says so
   explicitly (`plannerConsultedOnlyAtProgramBoundary`), and the goal
   orchestrator prompt is reframed as "compile the goal into a complete
   workflow program".
5. **Scout, then compile** — shipped. Claude's author reads the repo inline
   for ~4 min before writing the script; bullswarm's orchestrator was compiling
   blind (goal text + cwd, forbidden to run commands, and the planner context
   exposed no worker output text at all — only `ok`/`why`/`outFile`). `workflow
   goal` now runs a read-only `scout` action first, and every output in the
   planner context carries an `outputExcerpt`, so the first program is written
   against a real survey and boundary decisions read what workers reported.
6. Two bugs found on the way that had silently blocked this shape in ≤ 0.11.1:
   fan-out outputs recorded the success *count* in `ok`, so nothing could ever
   depend on a fan-out (the ready-set test is `ok === true`); and the content
   gate rejected a worker whose whole answer was a JSON array as an
   "announcement without substance".

7. Two robustness gaps the 0.11.1 comparison run itself exposed, fixed
   before 0.12.0 shipped: (a) a planner-authored verify prompt that quoted a
   JSDoc type literally — `{{maxLength?: number}}` — was parsed as a template
   ref and killed the action at render time with zero attempts, forcing an
   extra planner turn to re-issue it. Only a known root plus dotted
   identifiers is a ref now; other double-brace text is prompt content.
   (Claude never has this class of bug: prompts are JS strings, the runtime
   does no substitution.) (b) The new scout is a failable step ahead of the
   planner; it is non-fatal by construction (`onError: continue`), the planner
   sees `outputs.scout.ok=false` with the reason, and a run where only the
   scout succeeded is `blocked`, never "delivered".

8. **Program-level completion** (0.13.0) —
   `completion: { when: "all-actions-ok", reason }` on a program. Claude's
   script simply returns when its code is done; bullswarm still spent a final
   planner turn (110–250 s measured) to say `complete` after a clean run. Now
   the runtime records that decision itself (`source: "program-completion"`,
   never below the completion policy) and consults the planner only when
   something failed. With 0.12.0's repair-in-program this makes a clean run
   **one planner turn**: compile, execute, done — Claude's "0 orchestrator turns
   during execution" for the passing case. **[OBSERVED]** goal-3 run
   `wf-mtdkvx0k` (0.13.1): the planner attached the predicate on its own, the
   runtime emitted `decision.auto_completed` (`source: program-completion`),
   one planner process for the whole 28 min run.
9. **Rate limits are waited for** (0.12.1): a burst-gated provider parks the
   dispatch in `waiting_for_quota` until the window resets instead of failing
   the run in 4 s, which is what the first 0.12.0 comparison launch did.
   **[OBSERVED]** goal-2 run `wf-mtdcghw0`: parked at 95 % for 3 h 2 min,
   dispatched 17 s after the provider reset.
10. **A repair is verified by its verify's re-run** (0.13.1). The executor's
   repair loop creates `<verify>-repair-N` *depending on* the verify, then runs
   the verify again; the completion-evidence check only followed
   `verify.dependsOn` and so never saw a repair as verified. **[OBSERVED]** on
   `wf-mtdcghw0`: a clean `complete` rejected, three more planner turns
   (~11 min) to re-prove a passed re-verify. In Claude's model this bug cannot
   exist — the script's `while (!ok)` loop *is* the evidence — which is the
   general lesson: every piece of control flow bullswarm moves from planner
   into runtime needs its evidence rule moved with it.
11. **[IMPLEMENTED] Schema-enforced worker output** — a planner `run` action or fan-out
    `stepTemplate` may declare an object-typed `outputSchema` subset. The
    runtime appends instructions for one trailing matching JSON object, with no
    prose or markdown fences after it, then parses and validates the object.
    A successful `run` persists `outputs.<id>.data` and `schemaOk: true`; a
    fan-out stores those schema results inside each
    `outputs.<fanoutId>.items[]` entry. Both emit `action.output_validated`. A mismatch emits
    `action.output_schema_retry` and gets exactly one bounded retry carrying
    the validation errors and the previous output tail; a second mismatch
    fails the action while retaining its output text and recording
    `schemaOk:false` and `schemaErrors`. Dependent prompts can render data
    fields, and `fanout.itemsFrom` can consume `outputs.<id>.data.items` without
    extraction when it is already an array. Planner decision validation rejects
    `outputSchema` on a proposed `verify` because verify has a fixed verdict
    shape. Schema-backed dispatches suppress ordinary same-pool retries so the
    schema contract gets exactly its one bounded correction attempt. On resume,
    a fan-out item is skipped only when both its verdict and declared schema
    are satisfied; the schema must be declared on `stepTemplate.outputSchema`.

**Honest limitation.** `itemsFrom` removes the planner *turn*, not the stage
*barrier*: a verify depending on a data-driven fan-out waits for all items,
whereas Claude's `pipeline()` overlaps verify-B with fix-C for discovered items
too. Per-item overlap on unknown items would need a fan-out whose
`stepTemplate` is itself a chain — not in 0.12.0. For known items the planner
proposes N fix + N verify inline and the ready-set scheduler already overlaps
them.

## 5. Not adopted (yet), and why

- **Per-action worktree isolation.** File ownership declared by the planner is
  cheaper and matches Claude's own guidance ("EXPENSIVE … use ONLY when agents
  mutate files in parallel and would otherwise conflict").
- **Hard budgets.** Deliberately advisory; see 1.7.
- **Retry policy in the graph.** Claude writes repair loops as code. A per-
  action `retryPolicy` proposed by the planner would remove one planner turn per
  transient failure; not yet built.
- **Identical control plane.** bullswarm's orchestrator remains an LLM per
  checkpoint because the user supplies only a goal. The convergence target is
  therefore "few planning turns, full width between them", measured as
  `plannerSec / wallSec` and `maxConcurrentAttempts` in the experiment report.
