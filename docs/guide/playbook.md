---
title: Day-to-day playbook
description: A practical rhythm for designing outcomes, launching parallel work, watching, steering, and signing off.
---

# Day-to-day playbook

Bullswarm works best as the execution layer beneath your main coding agent.
Keep the goal, plan, trade-offs, and final review in that conversation; use the
fleet for bounded implementation and independent evidence.

## 1. Design the outcome

Start with what must be true when the work is finished, not a list of agent
roles. Name observable requirements and the proof each one needs. A small
feature might become three actions:

- **implementation** changes the product behavior;
- **docs** explains the behavior and shows it in use;
- **acceptance** runs the focused checks and inspects both outputs.

Give parallel actions disjoint territories where possible. Put integration
after the work it combines, and make acceptance depend on the integrated
result. The [program format](/reference/program) turns that shape into a graph.

## 2. Hand the goal to your main agent

Ask the main agent to use the packaged Bullswarm skill. One bounded answer can
go through `bullswarm run`; work with parallel territories, integration, or an
independent check needs a caller-authored workflow program.

The main agent should read the contract, inspect the repository, write the
program, and validate it before launch. Bullswarm does not invent missing
steps or automatically add gap rounds after the graph finishes.

## 3. Let the workflow fan out

The kernel schedules dependency-ready actions across eligible provider pools.
Independent implementation and docs actions can run together; integration
waits for both; acceptance waits for integration. Routing still applies the
same quota pace, five-hour protection, load, quarantine, and model-rung rules
that a single `bullswarm run` uses.

```bash
bullswarm workflow goal \
  "Implement the change, document it, and verify the result" \
  --cwd . --program plan.json --watch
```

Shared-workspace file territories are coordination hints. Use `--isolation`
only when the workflow needs strict per-worker worktrees and exact ownership
checks.

## 4. Watch without taking ownership away

Use the dashboard for the whole fleet, or the watcher for one run:

```bash
bullswarm
bullswarm workflow watch <runId> --until trouble
```

Home shows what is active and recent. Runs finds the workflow; Run shows the
phase plan and attempts; Step opens the worker's turns, result, task, and cost
evidence. If you work in Claude Code, its Bullswarm pane provides the same
read-only Run, Step, and usage facts inside the agent session.

Watching is not controlling. Quitting the dashboard leaves the workflow
running, and a completed process is not automatically a verified outcome.

## 5. Steer or revise deliberately

Use steering to queue guidance for a workflow with a planner checkpoint. For a
caller-authored program, export the durable plan, edit it, and revise the run:

```bash
bullswarm workflow steer <runId> --message "Keep the public output backward compatible"
bullswarm workflow plan export <runId> --out plan.json
bullswarm workflow plan revise <runId> --program plan.json --rerun acceptance \
  --summary "Re-run acceptance after the compatibility fix"
```

Revise when the evidence reveals a missing action, dependency, or requirement.
Resume when the plan is still right and a retryable mechanical failure stopped
a step. Do not treat a failed acceptance check as a reason to repeat the same
unchecked plan.

## 6. Sign off from evidence

Open the compact result and inspect every action, unfinished requirement, and
verification record:

```bash
bullswarm workflow runs result <runId> --json --summary
```

Sign off only when the required actions succeeded **and** the requirement
ledger is verified. Read the underlying output for consequential changes; a
worker report is evidence to assess, not authority.

## 7. Run several goals in parallel

Workflows launch independently, so the main agent can start another unrelated
goal while the first continues. Each kernel shares the assignment ledger, and
routing charges in-flight work before choosing another pool. The dashboard
brings all active and historical runs back into one place.

Prefer several coherent goals over one enormous graph. Give each a distinct
outcome and repository scope. Bullswarm refuses an accidental duplicate of the
same ongoing goal in the same directory unless you explicitly pass `--again`.

## Keep the main agent in the lead

The main agent should retain planning and review because it holds the user's
intent, current conversation, and cross-step trade-offs. Let workers own clear
execution territories and independent checks; let the main agent reconcile
their evidence, revise the graph when needed, and make the final call.

Next, see [Workflows](/guide/workflows) for the complete program lifecycle and
[Observing runs](/guide/observing) for the dashboard and watcher reference.
