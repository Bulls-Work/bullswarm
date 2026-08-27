# Dynamic workflow acceptance evidence

Verified on 2026-08-27 against the acceptance criteria in
`docs/dynamic-workflow-handoff.md`.

## Deterministic, offline coverage

`npm test` is the release gate. The focused dynamic-workflow coverage is in:

- `tests/workflow-adaptive.test.js`: planning, bounded plan expansion, planner-added
  fan-out, dependency execution, replanning, proceed/stop/approval decisions,
  expansion budgets, crash/resume, capability fail-closed routing, escalation,
  ordered event cursors, and active-child cancellation.
- `tests/workflow-dashboard.test.js`: TUI/JSON parity, action inspection,
  cancellation requests, and durable human approval decisions.
- `tests/workflow-gaps.test.js`: recursion, burst gates, quarantine and decision
  logs, dispatch caps, retry bounds, adversarial verification, fan-out fingerprint
  resume, and output durability.
- `tests/workflow-run.test.js`: static two-phase compatibility, static fan-out,
  artifacts, reports, and resume behavior.

These tests use deterministic local connectors and require no network.

## Real-provider matrix

The bounded harness is `tests/manual-dynamic-real.mjs`. It uses the configured
`opencode2` connector pinned to `relay/gpt-5.6-luna`, operates read-only against
this repository, and cleans its temporary Bullswarm homes after each case.
Run the whole matrix with:

```bash
node tests/manual-dynamic-real.mjs
```

The real-provider evidence captured during final acceptance was:

| Acceptance case | Evidence |
| --- | --- |
| 1. Static two-phase workflow | `qa-opencode-luna`, run `wf-mtbef6re-980cbb`, completed |
| 2. Runtime fan-out over a discovered list | Same static QA run, completed fan-out before skeptic verification |
| 3. Planner says `proceed` | Harness run `wf-mtbfcqx7-88b0f5`, completed |
| 4. `needs_more_work` adds fan-out | Harness run `wf-mtbfinse-907c75`, two items completed, then planner returned `complete` |
| 5. Retry succeeds later | Harness run `wf-mtbf7b4w-81f4c1`, two attempts |
| 6. Escalation changes capable pool | Harness run `wf-mtbf7rux-f20348`, `real-bad` then `opencode2` |
| 7. Budget stops expansion | Harness run `wf-mtbfawsa-79aaff`, terminal `budget_exhausted` |
| 8. Cancel active action | Harness run `wf-mtbfdxya-fa5b99`, terminal `cancelled`, 260 ms observed latency |
| 9. Resume partial expansion | Harness run `wf-mtbfdy6g-527002`, successful first action not duplicated, event sequence 64 |
| 10. TUI and JSON parity | Resume harness compared dashboard JSON to the exact durable event log; deterministic dashboard tests compare state/report/events |

An additional persistent adaptive CLI run, `wf-mtbeh0mu-239648` (short ID
`e8rtda`), demonstrated `needs_more_work`, durable plan version 2, execution of
`followup-version`, a second planner call returning `complete`, cursor reads,
action inspection, and JSON dashboard inspection.

## Zero-steering goal bootstrap

The later usability pass removed the requirement for an initiating user or
agent to author the initial workflow graph. The public entrypoint is:

```bash
bullswarm workflow goal "<goal>" --cwd <repo> --detach --json
```

`tests/workflow-goal.test.js` proves offline that this single invocation:

- synthesizes the bounded adaptive kernel from goal text;
- automatically selects a capable orchestrator and workers;
- executes and verifies a planner-created graph;
- rejects premature completion until successful worker and verification
  evidence both exist;
- persists `workflow.json` for restart/resume;
- survives termination of the initiating CLI in detached mode; and
- remains exactly observable through dashboard JSON and ordered event cursors.

Controlled real-provider coding trials used separate disposable JavaScript
projects with a failing test. The CLI received only the goal and working
directory; no workflow document, phases, action IDs, dependency graph, worker
prompts, or verification schema came from the caller.

| Requested orchestrator | Run | Result |
| --- | --- | --- |
| Grok | `wf-mtbgy3kf-444577` (`6927a2`) | Grok planned the fix and independent verifier; four dispatches; completed; external `npm test` passed |
| Claude Code | `wf-mtbgp9ir-1d9966` (`b2zm3s`) | Detached launch; Claude orchestrated; quota routing sent fix and verification to Grok; completed; external `npm test` passed |
| OpenCode / Luna | `wf-mtbgs9mf-6a0de5` (`62se2a`) | Detached launch; OpenCode chose diagnosis, replanned, then fix and verification; six dispatches; completed; external `npm test` passed |

An unpinned detached run, `wf-mtbh1z2z-c2a1dd` (`7n8jua`), supplied no
agent choice at all. Capability and quota routing selected Claude Code as the
orchestrator, then automatically routed implementation and verification. The
kernel accepted `complete` only after both actions succeeded; the run completed
in four dispatches and a separate `npm test` passed.

The first exploratory Grok run exposed that a natural verifier proposal omitted
the internal `review` artifact path. Bullswarm now deterministically infers that
path for a verifier with one dependency and always appends the required JSON
verdict contract. This is deliberately runtime knowledge, not caller steering.

## Acceptance interpretation

- Provider output is accepted by content verification, never by exit status alone.
- Planner proposals remain untrusted until schema, operation, dependency, and
  budget validation succeeds.
- Pool choice, working directory, task files, process authority, quarantine,
  retry, and verification remain runtime-owned.
- Capability eligibility is evaluated before quota-surplus ranking. A required
  capability fails closed when no eligible pool exists.
- Terminal state distinguishes completed, failed, cancelled, budget exhausted,
  and waiting for approval. Attempts and ordered events preserve the reason.
