---
name: bullswarm
description: Use when the user invokes /bullswarm or $bullswarm, asks to delegate or offload a self-contained task, or wants Bullswarm to choose between one quota-routed agent and an autonomous multi-agent workflow. Classify first, show the decision and conceptual plan, then execute through the common delegate interface.
---

# Bullswarm — one delegation interface

Use Bullswarm to decide the smallest execution shape that can deliver a
verified result. The caller supplies the task; Bullswarm selects either one
bounded agent or an autonomous workflow and routes providers by capability,
quota pace, and persisted model policy.

If `BULLSWARM_DEPTH` is already set, perform the assigned task directly. Do not
invoke Bullswarm recursively unless the user explicitly requires another
bounded delegation.

## Default `/bullswarm` flow

1. Preserve the user's request verbatim and identify the working directory.
   Do not broaden authority, invent external writes, or move live conversation
   context into a delegate that cannot see it.
2. Preview the common decision without dispatching work:

   ```bash
   bullswarm delegate --dry-run --json --cwd=<abs-dir> --prompt='<request>'
   ```

3. Before execution, tell the user:

   - `Single bounded agent` or `Autonomous workflow`;
   - the decision's `reason`;
   - the short conceptual `phases` plan.

   This is an update, not an approval gate. Continue immediately unless the
   selected work itself needs new authority or the user asked only for a plan.
4. Execute the same decision explicitly so the preview cannot drift:

   ```bash
   bullswarm delegate --mode=<single|workflow> --cwd=<abs-dir> \
     --plan='<decision.suggestedPlan>' --prompt='<request>' --json
   ```

   Use `--task-file` instead of `--prompt` when the request is already in a
   file or contains text that is awkward to quote safely.
5. Judge the returned evidence, not the process exit alone.

   - Single mode: if `execution.keepOnClaude`/`keepOnCaller` is true, complete
     the task in the current agent even if `execution.ok` is also true. Otherwise,
     when `execution.ok` is true, read `execution.outFile` and use its content.
     Report concrete failures; do not pretend delegation succeeded.
   - Workflow mode: `delegate` returns the planning **contract**
     (`action: "plan-required"`), because you are the Workflow Planner. Author
     the program from it and launch with `workflow goal --program` — the loop
     in "You are the planner" below. Add `--orchestrator auto` only when you
     want a planner agent dispatched instead. Once a run exists, report the
     short ID and observation commands, watch when the user asked to wait, and
     obtain the terminal contract with
     `bullswarm workflow runs result <id> --json`.

Every command self-initializes. Use `bullswarm doctor --json` only when a
dispatch reports a readiness problem; it is not required before every task.

## How the decision should read

Prefer **single** when one agent can own one bounded outcome without an
orchestration round:

- explain or inspect one module;
- review one diff or draft one message;
- make one localized fix and run its focused test;
- perform one mechanical conversion or summary.

Prefer **workflow** when coordination materially improves correctness or wall
time:

- multiple explicit deliverables or lifecycle stages;
- independent, file-disjoint units that can run concurrently;
- broad repeated inspection across files, commands, packages, issues, or data;
- implementation plus independent acceptance, release, or deployment proof;
- unknown scope requiring discovery followed by fan-out;
- a goal likely to expose a real semantic gap that benefits from one bounded planner update.

Do not choose a workflow merely because a prompt is long. Do not choose one
agent merely to save a dispatch when the result has independent units or a
high-stakes acceptance boundary. In automatic execution, the CLI starts with
deterministic signals and lets an LLM refine its decision; if that refinement
is unavailable or unusable, it keeps the deterministic decision. Pass
`--classify deterministic` to bypass LLM refinement, or `--classify llm` to
require a usable LLM decision (and fail if none is available). In automatic
mode, `--dry-run` still performs that same bounded low-effort classification
request before printing the plan — it previews the decision without ever
dispatching the work itself. `--classify deterministic` remains the instant,
no-dispatch preview. The classifier is transparent and overridable: an
explicit `--mode single|workflow` is the caller's choice and bypasses
automatic LLM classification.

## Workflow plan boundary

The preview is an imagined execution shape, not a hand-authored graph. Pass it
through `--plan`; Bullswarm persists it as `intent.suggestedPlan`. The workflow
planner may refine it using repository evidence, but must still obey the
original goal, runtime-owned requirements, verification policy, budgets, and
proposal validator. Never generate action IDs, pool choices, dependency JSON,
or a draft workflow unless the user specifically says the graph is the
contract.

Optimize for convergence:

- batch cheap related edits rather than paying one worker and verifier per
  tiny file;
- run substantial disjoint work concurrently;
- use focused checks while siblings are editing and one final acceptance check;
- let the kernel retry only mechanical failures; semantic gaps return to the planner once as a consolidated report;
- stop with a useful verified result and disclosed non-blocking concerns rather
  than expanding for optional polish.

## You are the planner (this is the default)

`workflow goal` needs a program: you are the Workflow Planner unless you
explicitly ask for a dispatched one. Author the V2 program yourself and let the
kernel do only what it is better at (quota routing, file ownership, independent
evidence, the requirement ledger, completion, the stable result). This is
Bullswarm's equivalent of Claude Code's `Workflow` tool: you write the program
once, the kernel executes it, and you are consulted again only at a real
planning boundary.

Exit codes are a contract: **0** done or paused durably for you (nothing is
running), **1** the run ended without completing, **2** usage or validation
error with nothing launched. Every refusal names the next commands.

1. Read the contract for the exact goal text you will launch:

   ```bash
   bullswarm workflow plan contract "<goal>" --cwd=<abs-dir> --json
   ```

   It returns the requirement IDs the kernel derives (numbered clauses become
   `requirement-1..n`; a trailing "Finish with ..." line becomes the last
   requirement), the read-only constraint, the planning rules, the action
   fields, the validation the kernel enforces, and a worked example. Number
   the goal's deliverables; prose collapses to one requirement.
2. Scout inline with your own tools (list files, run the tests) and write the
   program to a file: file-disjoint work actions in parallel, ordered only by
   real data or same-file dependencies, self-contained prompts with the exact
   workspace path and focused acceptance command, and at least one evidence
   action per mandatory requirement that depends on every action affecting it.
   Never name pools or models; lane and effort pick the tier.
3. Optionally dry-run the file against the contract, then launch. Both use the
   same validator; an invalid program exits 2 with the issues, launches
   nothing, and points back at `plan contract`/`plan validate`:

   ```bash
   bullswarm workflow plan validate "<goal>" --cwd=<abs-dir> --program plan.json --json
   bullswarm workflow goal "<goal>" --cwd=<abs-dir> --program plan.json --json
   bullswarm workflow watch <shortId>
   ```

4. `watch` ends either at a terminal result or when the run pauses for you.
   A pause means the kernel consolidated real gaps (failed or blocked
   requirements, failed actions) and will not guess: read them and decide.

   ```bash
   bullswarm workflow plan show <shortId> --json
   bullswarm workflow plan submit <shortId> --program plan-2.json --watch
   bullswarm workflow plan submit <shortId> --exhausted --reason "<why>"
   ```

   A submitted program contains only new actions (known actions are already in
   the run; reuse their IDs in `dependsOn`). A rejected submission exits 2 and
   leaves the run unchanged. `--exhausted` finalizes a partial result with the
   gaps disclosed.
5. Obtain the terminal envelope with `bullswarm workflow runs result <shortId>
   --json`; the same lenient acceptance applies (concerns are data, not
   failures).

Manage a live run with `bullswarm workflow steer <id> --message "<guidance>"`
(surfaced in the next request you read, and consumed by the program you
submit), `bullswarm workflow cancel <id>` (a paused run is finalized
immediately), and `bullswarm workflow resume <id>` (idempotent at a pause).

Two other ways to start, both explicit:

- `--scout` with no program: the kernel surveys the repository first and pauses
  at the initial boundary so you plan against its survey. Its unit list is
  advisory for a caller planner, never a rejection rule.
- `--orchestrator auto|<pool>`: dispatch a Workflow Planner agent instead of
  planning yourself. Use it for callers that cannot hold the repository in
  context or must not block on a conversation; `--suggested-plan`,
  `--no-scout`, `--orchestrator-model`, and `--orchestrator-strict` apply only
  to this mode.

## Direct modes and advanced operation

Use the common `delegate` interface by default. Reach for the underlying
commands only when the user explicitly chooses the execution shape or needs a
fixed graph:

- `bullswarm run` — one bounded task;
- `bullswarm workflow goal --program` / `workflow plan` — an autonomous goal
  whose planner is you (section above); this is the default shape;
- `bullswarm workflow goal --orchestrator auto` — an autonomous goal whose
  planner is a dispatched agent;
- `bullswarm workflow draft` — a fixed graph whose exact structure is the
  contract.

For observation, resume, fan-out, verification, strategy, and failure handling,
read [references/operations.md](references/operations.md) only when that detail
is needed.
