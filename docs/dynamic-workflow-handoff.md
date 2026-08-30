# Bullswarm Dynamic Workflow Handoff (Historical)

**Purpose:** iteration brief for making bullswarm's workflow system behave like
Claude Code's dynamic workflows while preserving bullswarm's provider routing,
quota pacing, content verification, and agent-friendly CLI contracts.

**Audience:** the next implementation agent.

**Status:** historical implementation brief from 2026-08-21. The gaps and task
list below describe the state at that date; they are not a current capability
matrix. For current behavior use `README.md`, `skill/SKILL.md`,
`docs/claude-dynamic-workflow-mechanics.md`, and the contextual CLI help.

## Executive Summary

Claude's dynamic workflow is fundamentally a durable control loop:

```text
understand request
  -> plan
  -> execute actions
  -> observe results
  -> plan again
  -> execute newly needed actions
  -> repeat until complete
```

Bullswarm now has the control loop this brief proposed: a durable orchestrator
observes completed work, proposes a bounded program, deterministic validation
accepts or rejects it, and the runtime schedules ready actions before the next
checkpoint. Static JSON workflows remain supported alongside zero-graph
`workflow goal` execution. The rest of this document preserves the historical
evidence and build rationale that led to that implementation.

The target is not an uncontrolled mutable DAG and not an LLM that owns the
runtime. The target is a hybrid:

```text
deterministic runtime owns execution and safety
planner agent supplies semantic decisions only when needed
worker agents perform bounded actions
verifier checks evidence
dashboard and agents read the same durable state
```

## 1. Observed Claude Mechanism

### Evidence source

Fleetlens session inspected:

```text
http://localhost:3321/sessions/8f75ae10-9d92-4a24-8bca-202bf45d20af#workflows
```

The page contained the session's serialized conversation, workflow output,
event history, checkpoints, and action records. This is an observation of the
runtime behavior, not a claim that every internal implementation detail is
public or complete.

### The repeated planning loop

A representative run emitted this event sequence:

```text
run.queued
run.started
kernel.checkpointed: intake
kernel.checkpointed: interpreted
kernel.checkpointed: gated
kernel.checkpointed: planning
kernel.checkpointed: executing
kernel.checkpointed: observing
kernel.checkpointed: planning
kernel.checkpointed: executing
kernel.checkpointed: observing
kernel.checkpointed: planning
kernel.checkpointed: executing
artifact.published
kernel.checkpointed: observing
kernel.checkpointed: planning
kernel.checkpointed: delivered
kernel.delivered
run.succeeded
```

The key fact is that `planning` appears multiple times in one run. The system
does not assume that the initial plan is enough. It executes, observes, then
re-enters planning when the result changes what should happen next.

### Durable state shape

Observed checkpoint concepts included:

```json
{
  "stage": "planning",
  "intent": {},
  "plan": {},
  "state": {
    "task": {},
    "action": {},
    "workspace": {},
    "artifact": {},
    "authorization": {},
    "conversation": {}
  },
  "budget": {},
  "gate": {}
}
```

The exact fields vary by run, but the separation matters:

- `intent` describes what the user wants.
- `plan` describes proposed actions.
- `state` describes facts discovered so far.
- `budget` limits work.
- `gate` records whether the run may proceed.
- `stage` tells observers where the runtime is.

### Action records

Observed actions had stable IDs, operations, dependencies, inputs, status, and
outputs. A simplified form is:

```json
{
  "id": "workspace-list-1",
  "operation": "workspace_list",
  "dependsOn": ["workspace-write-1"],
  "inputs": { "path": "outputs" },
  "status": "done",
  "output": { "entries": ["sample.txt"] },
  "error": null
}
```

The action ledger is separate from the plan. The plan says what should happen;
the ledger says what actually happened.

### How more work is discovered

The planner observes action outputs and can decide that the original plan is
incomplete. For example:

```text
list files
  -> observe that auth files were missed
  -> plan auth-file review actions
  -> execute those actions
```

The decision is semantic. It is not based only on process exit code.

Possible decisions include:

```text
proceed
complete
retry
escalate
needs_more_work
wait_for_approval
stop
```

### Attempts and retry state

Claude separates a logical run from attempts:

```text
task
  -> attempt 1: failed
  -> attempt 2: succeeded
```

Observed statuses included concepts such as:

```text
retry_scheduled
failed_retryable
failed_terminal
timed_out
waiting_for_approval
```

This is more informative than replacing one flat step result with another.

### Event log

Observed event records had this shape:

```json
{
  "sequence": 32,
  "type": "artifact.published",
  "schemaVersion": 1,
  "payload": {},
  "committedAt": "2026-08-20T08:23:19.764Z"
}
```

Events use a monotonic sequence and can be resumed with a cursor, conceptually:

```text
GET /events?after=31
```

This lets a UI or agent receive only events it has not seen yet.

### Cancellation and recovery

Observed cancellation was a state transition:

```text
running -> cancelling -> cancelled
```

The telemetry recorded cancellation request time, cancellation latency, and
terminal status. The system also used worker/lease recovery so an interrupted
worker could later be marked abandoned rather than silently remaining active.

## 2. Bullswarm Current Baseline

### Workflow shape

Bullswarm workflows are declarative JSON documents validated before execution.
The current structure is:

```text
workflow
  -> ordered phases
      -> ordered steps
```

Supported step types:

- `run`: one delegate invocation.
- `fanout`: one delegate invocation per item.
- `verify`: a skeptical review of a prior output artifact.
- `decide`: a durable adaptive planning gate whose proposal is validated before
  any new action is appended or executed.

The implementation is mainly in:

```text
src/workflow/validate.js
src/workflow/runner.js
src/workflow/runtime.js
src/workflow/template.js
src/workflow/dashboard.js
src/workflow/cli.js
```

### Current execution path

```text
load JSON
  -> validate
  -> resolve inputs
  -> phase 1
  -> phase 2
  -> phase N
  -> report
```

The runtime persists `state.json` after steps and writes a final `report.json`.
Each dispatch produces task and output artifacts in the run directory.

### Result passing between phases

Results are stored in:

```text
state.outputs
```

A later step can reference them with templates:

```text
{{outputs.previous.pool}}
{{outputs.previous.outputText}}
{{outputs.previous.outFile}}
{{outputs.previous.data.field}}
```

For a structured `run`, declare an object `outputSchema` when a later step
needs typed data. The successful state record contains `data` and
`schemaOk: true`; after the single schema correction retry fails it retains the
output text and contains `schemaOk: false` and `schemaErrors`. A schema retry is
observable as `action.output_schema_retry`, followed by
`action.output_validated` only when the corrected object passes validation.
The task also supplies an exact local schema-preflight command. The worker uses
it on a temporary candidate before replying, while the runtime independently
revalidates the captured response before exposing `data` downstream.

A fan-out can use a prior output file as its item source:

```json
{
  "type": "fanout",
  "itemsFrom": "outputs.discover.outFile",
  "stepTemplate": {
    "prompt": "Review {{item}}."
  }
}
```

The runtime first consumes an already-recorded array such as
`outputs.discover.data.items`. For the legacy `outputs.<id>.outFile` form it
reads the referenced file and parses a JSON array. This is dynamic item
expansion, not dynamic workflow graph expansion. Fan-out schemas belong on
`stepTemplate.outputSchema`; each item stores its own `data`, `schemaOk`, and
possible `schemaErrors`, and resume re-runs only items whose verdict or schema
is incomplete.

### Routing and model selection

Automatic routing currently filters pools by:

- Enabled state
- Lane capability
- Quarantine state
- Exhaustion state
- Burst-gate state

It then ranks candidates by:

```text
time-adjusted quota surplus = elapsed percentage - used percentage
```

The highest-surplus capable pool normally wins, subject to incumbency and cost
guards in `src/lib/route.js`.

This does not infer model intelligence. `--auto` is not an intelligence or
quota selector. For OpenCode, `--auto` approves tool permissions in headless
mode. The connector controls the model. The QA connector now pins:

```text
opencode run --auto --model relay/gpt-5.6-luna {taskFile}
```

### Current reliability features

Bullswarm currently has:

- Content-based verification instead of exit-code trust
- One alternate-pool escalation when enabled
- Configurable bounded same-pool retries with `retryAttempts` from 0 to 3
- Global concurrency limiting, capped at 16
- `maxAgents` spend guard
- Required input enforcement
- Quarantine on auth/throttle verdicts
- Burst-gated pool exclusion
- Recursion-depth propagation and guard
- Resume of successful steps
- Fan-out resume by item fingerprint
- Structured worker output with one schema retry and durable schema state
- Cooperative cancellation through `state.json`
- Heartbeats during long dispatches
- Basic interactive dashboard
- JSON dashboard operations for agents

### Current inspection commands

```bash
bullswarm doctor --json
bullswarm workflow capabilities --json
bullswarm workflow inspect <file-or-name>
bullswarm workflow runs result <shortId> --json
bullswarm workflow tui --json
bullswarm workflow tui --json <shortId>
bullswarm workflow tui --json --cancel <shortId>
```

The intended commands are:

```bash
bullswarm doctor --json
bullswarm workflow capabilities --json
bullswarm workflow inspect <file-or-name>
bullswarm workflow tui --json
```

## 3. Historical Gaps, Ordered by Priority

This section is an as-built checklist from the original handoff. The adaptive
decision loop, bounded graph expansion, structured decisions, attempt ledger,
ordered event log, cancellation, and timeline/dashboard surfaces described
below are implemented now. The past-tense gap text is retained so reviewers can
trace requirements to the resulting runtime and tests; it must not be read as
current product status.

### P0: no observe-plan-execute loop

This is the central gap. Bullswarm executes a predeclared plan but does not
re-enter planning after observing results.

Required behavior:

```text
execute action
  -> persist result
  -> observe state
  -> decide next action
  -> schedule accepted action
```

### P0: no bounded dynamic graph/action expansion

Bullswarm can create more calls for more fan-out items, but it cannot accept a
structured decision such as:

```json
{
  "decision": "needs_more_work",
  "actions": [
    {
      "type": "run",
      "prompt": "Investigate the newly discovered auth issue."
    }
  ]
}
```

The runtime must be able to append validated actions to a running plan while
keeping hard budget limits.

### P0: no structured insufficiency decision

`verify` can return `ok: false`, but that only marks a step failed. It does not
say what additional work should be scheduled.

The system needs a structured decision contract that can distinguish:

```text
result is sufficient
result needs more work
result should be retried
result should be escalated
result needs human approval
result is terminally failed
```

### P1: attempt history is not first-class

Retries exist, but the run state should represent one logical action with many
attempts. Each attempt must preserve its pool, model, status, timings, failure
reason, task file, and output file.

### P1: no durable ordered event log

The current callback stream and state snapshots are not enough for robust event
replay, crash diagnosis, or a resume cursor. Add a sequence-numbered event log.

### P1: incomplete live visibility

The dashboard now exposes current phase, current step, and active agents, but it
does not yet provide a full action tree, dependency view, decision history,
retry history, or per-agent event stream.

### P1: no explicit capability model

Pools declare lanes, but lanes are not model intelligence. Add explicit,
connector-owned capability metadata so a workflow can require facts such as:

```text
strong-analysis
code-editing
browser-use
artifact-publishing
workflow-planning
```

Quota surplus should rank eligible capable pools; it should not pretend to
measure intelligence.

### P2: no adaptive model policy

If a workflow requires a strong planner or verifier, the requirement must be
declared explicitly. The router can then choose among pools that satisfy the
requirement. Do not make `--auto` responsible for this.

### P2: cancellation and recovery are simpler than Claude's

Bullswarm supports cooperative cancellation, but not yet:

- `running -> cancelling -> cancelled` lifecycle details
- Cancellation latency
- Child process termination records
- Abandoned attempts
- Lease ownership and recovery
- Human approval waiting state

## 4. Target Architecture

### Hybrid authority model

Use three layers:

```text
initiator
  -> supplies user intent and initial plan

deterministic runtime
  -> validates, schedules, routes, limits, persists, retries, and stops work

planner agent
  -> judges semantic sufficiency and proposes additional actions
```

The planner proposes. The runtime decides whether the proposal is legal.

The planner must not directly:

- Spawn arbitrary processes
- Bypass pool routing
- Ignore budgets
- Modify durable state freely
- Create unbounded recursion
- Skip verification

### Static and adaptive modes

Keep existing workflows working unchanged:

```text
static mode:
  validated JSON graph -> deterministic execution

adaptive mode:
  validated initial graph
    -> deterministic execution
    -> planner gate
    -> validated action additions
    -> deterministic execution
```

Do not force an LLM planner onto every workflow. Predetermined pipelines should
remain zero-extra-LLM orchestration.

### Proposed state model

Extend state toward:

```json
{
  "runId": "wf-...",
  "status": "running",
  "stage": "executing",
  "currentPhase": {},
  "currentStep": {},
  "intent": {},
  "budget": {
    "dispatchesUsed": 8,
    "dispatchLimit": 100,
    "expansionRound": 1,
    "expansionLimit": 3
  },
  "plan": {
    "version": 2,
    "actions": []
  },
  "activeAgents": {},
  "attempts": [],
  "actionLedger": [],
  "decisions": [],
  "events": [],
  "outputs": {}
}
```

### Proposed action model

```json
{
  "id": "review-auth-files",
  "parentId": "discover",
  "kind": "fanout",
  "status": "queued",
  "dependsOn": ["discover"],
  "items": [
    "src/auth/login.js",
    "src/auth/session.js"
  ],
  "itemsTotal": 2,
  "itemsCompleted": 0,
  "itemsFailed": 0,
  "attempts": []
}
```

Action status should be explicit and extensible:

```text
queued
running
succeeded
failed_retryable
retry_scheduled
failed_terminal
waiting_for_approval
cancelled
abandoned
```

### Proposed attempt model

```json
{
  "actionId": "review-auth-files[0]",
  "attemptNumber": 1,
  "pool": "opencode2",
  "model": "relay/gpt-5.6-luna",
  "status": "running",
  "startedAt": "...",
  "lastHeartbeatAt": "...",
  "taskFile": "...",
  "outFile": "...",
  "why": null
}
```

### Proposed planner contract

Add an adaptive decision step or equivalent runtime gate. The planner must
return JSON only:

```json
{
  "decision": "needs_more_work",
  "reason": "The first scan did not cover authentication files.",
  "actions": [
    {
      "id": "review-auth-files",
      "type": "fanout",
      "items": [
        "src/auth/login.js",
        "src/auth/session.js"
      ],
      "stepTemplate": {
        "lane": "analyze",
        "prompt": "Review {{item}} for authentication defects."
      }
    }
  ]
}
```

Allowed decisions should be versioned and validated:

```text
proceed
complete
needs_more_work
retry
escalate
wait_for_approval
stop
```

The runtime must reject malformed actions, unknown operation types, missing
IDs, invalid dependencies, excessive item counts, and proposals over budget.

## 5. Ordered Implementation Tasks

### Task 1: preserve static workflow behavior

- Keep `run`, `fanout`, and `verify` valid.
- Keep preflight validation before dispatch.
- Keep current routing, verification, quarantine, recursion, and resume rules.
- Add regression tests before changing the execution model.

### Task 2: introduce durable event append

- Add a run-local event file, for example `events.jsonl`.
- Assign a monotonic sequence number per run.
- Include `type`, `schemaVersion`, `payload`, and `committedAt`.
- Append events atomically enough that a crash cannot create misleading
  partial records.
- Add an agent command to read events after a cursor.

Suggested events:

```text
run.queued
run.started
phase.started
phase.completed
plan.created
plan.updated
action.queued
action.started
action.observed
action.completed
action.failed
decision.created
attempt.started
attempt.completed
artifact.published
run.cancelling
run.cancelled
run.completed
```

### Task 3: promote attempts to first-class state

- Store every attempt, not only the final verdict.
- Distinguish retryable from terminal failure.
- Preserve pool and model used for each attempt.
- Record task/output artifacts per attempt.
- Make resume skip successful actions/items without hiding failed history.

### Task 4: add explicit capabilities

Extend connector metadata with facts, for example:

```json
{
  "name": "opencode2",
  "model": "relay/gpt-5.6-luna",
  "capabilities": [
    "strong-analysis",
    "code-reading",
    "file-editing",
    "workflow-planning"
  ]
}
```

The router should filter by required capability and then rank by quota surplus.
If no pool satisfies the requirement, return a clear reason; never silently
choose a weaker pool.

### Task 5: add the planner/decision contract

- Add a `decide` step type or an adaptive workflow setting.
- Require JSON output with a versioned schema.
- Always provide the planner with intent, completed actions, failures,
  artifacts, verification results, budgets, and available capabilities.
- Record the planner response as a decision artifact.
- Treat planner output as a proposal, not authority.

### Task 6: add the observe-plan-execute loop

Implement the loop explicitly:

```text
load initial plan
  -> execute ready actions
  -> persist outputs and events
  -> invoke planner at a decision gate
  -> validate planner proposal
  -> append accepted actions
  -> execute newly ready actions
  -> repeat
```

The loop must terminate on:

- Planner decision `complete`
- Planner decision `stop`
- Successful final gate
- Budget exhaustion
- Expansion-round exhaustion
- Cancellation
- Fatal runtime error

### Task 7: add safety limits

Support and validate limits such as:

```json
{
  "settings": {
    "maxAgents": 100,
    "maxExpansionRounds": 3,
    "maxActions": 100,
    "maxItemsPerExpansion": 50,
    "retryAttempts": 2,
    "maxWorkflowSeconds": 3600
  }
}
```

Enforce limits in deterministic code before accepting planner actions.

### Task 8: improve cancellation and recovery

- Record `cancelling` before `cancelled`.
- Record cancellation request time and terminal time.
- Record active child termination or abandonment.
- Ensure a restart can identify actions that were running when the process
  stopped.
- Make resume safe for actions introduced during expansion.

### Task 9: upgrade dashboard and agent inspection together

The TUI and JSON output must read the same state and event log.

Human view should expose:

```text
left: phases and action tree
center: selected action/item
right: pool, model, attempt, status, timing
bottom: event stream, decisions, artifacts, failure reason
```

Agent commands should expose equivalent information:

```bash
bullswarm workflow tui --json <runId>
bullswarm workflow events --json <runId> --after 20
bullswarm workflow action show --json <runId> <actionId>
bullswarm workflow capabilities --json
bullswarm workflow inspect <workflow>
```

### Task 10: provide adaptive examples

Add checked-in examples for:

- Fixed sequential pipeline
- Static fan-out
- Discovery followed by fan-out
- Verify then stop on insufficiency
- Adaptive expansion after a planner decision
- Retry and alternate-pool escalation
- Human approval/waiting, if implemented

Every example must state whether it is static or adaptive.

## 6. Recommended LLM Usage

Do not spend an LLM call on deterministic facts.

### No extra LLM required

- Schema validation
- Template rendering
- Dependency checks
- Fan-out expansion of a known array
- Concurrency scheduling
- Quota ranking
- Retry counters
- Quarantine
- State persistence
- Event sequencing
- Resume matching

### LLM required

- Decide whether a report is semantically complete
- Identify missing work
- Resolve conflicting results
- Propose new actions
- Decide whether evidence supports proceeding
- Write a synthesis

### Planner placement

Use a hybrid policy:

```text
initiator supplies initial intent and plan
runtime handles normal execution
planner is called only at explicit decision gates
```

The planner may be the initiating agent or a dedicated worker, but the runtime
must not depend on the initiating process remaining alive. For long-running or
resumable workflows, a dedicated planner role is cleaner.

### Planner routing

Planner selection should be capability-aware and quota-aware:

```text
required capability: workflow-planning + strong-analysis
  -> eligible pools
  -> exclude unavailable/quarantined/burst-gated pools
  -> rank by quota surplus
```

Do not use quota surplus as a proxy for intelligence.

## 7. Acceptance Criteria

The adaptive implementation is ready only when all of these are true.

### Core behavior

- A static existing workflow behaves as before.
- A planner can return `needs_more_work` with new actions.
- The runtime validates and appends those actions.
- Dependencies determine when appended actions run.
- The planner is called again after appended actions complete.
- The workflow terminates on a clear success, stop, cancel, or budget state.

### Safety

- `maxAgents` cannot be exceeded.
- `maxExpansionRounds` cannot be exceeded.
- `maxActions` cannot be exceeded.
- `maxItemsPerExpansion` cannot be exceeded.
- Retry attempts cannot exceed their configured bound.
- A malformed planner response cannot execute arbitrary work.
- A planner cannot bypass routing, verification, or quarantine.

### Durability

- Every action and attempt is persisted.
- Every important transition has an ordered event.
- A process restart can resume without duplicating successful actions.
- A fan-out expansion can resume by stable action/item fingerprint.
- Cancellation leaves a truthful terminal record.

### Observability

- TUI shows phases, actions, items, attempts, pool, model, status, and timing.
- JSON inspection exposes the same information.
- An agent can read events after a sequence cursor.
- An agent can see why a planner requested more work.
- An agent can see remaining budget and available capabilities.

### Real QA

Run at least these end-to-end cases with a real configured provider and with
the deterministic test connector:

1. Static two-phase workflow.
2. Runtime fan-out over a discovered list.
3. Planner says `proceed`.
4. Planner says `needs_more_work` and adds a fan-out.
5. Retry succeeds on a later attempt.
6. Escalation moves to another capable pool.
7. Budget stops an expansion.
8. Cancellation during an active action.
9. Restart/resume after partial expansion.
10. TUI and JSON show the same run state.

## 8. Non-Goals

Do not add these as part of the first adaptive implementation:

- Arbitrary user-written JavaScript execution
- Unbounded autonomous loops
- Full general-purpose DAG scheduling before action scheduling works
- Silent model-quality assumptions
- LLM control over shell/process authority
- A dashboard that is richer than the underlying durable state
- Removing the deterministic static workflow mode

## 9. Final Build Principle

The implementation should preserve this division:

```text
facts -> deterministic code
meaning -> planner model
execution -> deterministic runtime
work -> worker agents
trust -> verifier
visibility -> durable state and events
```

The most important code path to build is:

```text
execute
  -> observe
  -> decide
  -> validate
  -> schedule
  -> execute again
```

Once that loop exists, dynamic graph expansion is no longer a special trick. It
is simply the runtime accepting a bounded, validated set of new actions after a
planner observes that the previous result was insufficient.
