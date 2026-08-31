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
   - Workflow mode: report the short ID and observation commands. Use the
     low-noise watch when the user asked to wait for completion, and obtain the
     terminal contract with `bullswarm workflow runs result <id> --json`.

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
- a goal likely to need repair and re-verification.

Do not choose a workflow merely because a prompt is long. Do not choose one
agent merely to save a dispatch when the result has independent units or a
high-stakes acceptance boundary. In automatic execution, the CLI starts with
deterministic signals and lets an LLM refine its decision; if that refinement
is unavailable or unusable, it keeps the deterministic decision. Pass
`--classify deterministic` to bypass LLM refinement, or `--classify llm` to
require a usable LLM decision (and fail if none is available). `--dry-run`
uses only the deterministic decision. The classifier is transparent and
overridable: an explicit `--mode single|workflow` is the caller's choice and
bypasses automatic LLM classification.

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
- repair only genuine rejection failures;
- stop with a useful verified result and disclosed non-blocking concerns rather
  than expanding for optional polish.

## Direct modes and advanced operation

Use the common `delegate` interface by default. Reach for the underlying
commands only when the user explicitly chooses the execution shape or needs a
fixed graph:

- `bullswarm run` — one bounded task;
- `bullswarm workflow goal` — an autonomous goal;
- `bullswarm workflow draft` — a fixed graph whose exact structure is the
  contract.

For observation, resume, fan-out, verification, strategy, and failure handling,
read [references/operations.md](references/operations.md) only when that detail
is needed.
