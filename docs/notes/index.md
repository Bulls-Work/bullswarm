---
title: Historical notes
description: Working notes, audits, and experiment writeups, kept as records of what the repository looked like when they were written.
---

# Historical notes

These are working notes, audits, and experiment writeups, kept as records of
what the repository looked like when they were written rather than as current
documentation — read the [guide](/guide/) for how Bullswarm works today.

| Note | Date | What it records |
|---|---|---|
| [Bullswarm codebase audit](/audits/2026-09-09-codebase-audit) | 2026-09-09 | A full audit of the 0.26/0.27 checkout: version drift between `package.json` and `CHANGELOG.md`, vocabulary, and the defects found. |
| [How Claude Code drives a dynamic workflow](/claude-dynamic-workflow-mechanics) | 2026-08-29 | The mechanics of Claude Code's `Workflow` tool, written from inside such a session, and what bullswarm adopted from it. |
| [Caller-first workflow CLI](/design/2026-09-06-caller-first-cli) | 2026-09-06 | The design for the caller-planned CLI shipped in 0.24.0, including the removal of `bullswarm delegate`. |
| [Dynamic workflow handoff](/dynamic-workflow-handoff) | 2026-08-21 | The iteration brief for making the workflow system behave like Claude Code's dynamic workflows without giving up provider routing or content verification. |
| [Dynamic workflow acceptance evidence](/dynamic-workflow-qa) | 2026-08-27 | The acceptance run recorded against that handoff's criteria, accurate as of the date it was written. |
| [Dynamic Workflow V2 execution plan](/dynamic-workflow-v2-execution-plan) | 2026-08-31 | The execution plan for the program-based V2 engine that replaced the authored graph. |
| [Trending AI repository autonomy experiment](/experiments/2026-08-28-trending-ai-autonomy) | 2026-08-28 | Whether the checkout could autonomously plan, delegate, and implement work found in trending AI repositories. |
| [Dogfood: bullswarm builds bullswarm](/experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm) | 2026-08-29 | Verbatim notes from the two dogfood runs that produced 0.14.0 (outputSchema plus planner refactor) and the 0.14.1 defects they exposed. |
| [Ultracode vs `workflow goal`](/experiments/2026-08-29-ultracode-vs-bullswarm) | 2026-08-29 | A side-by-side of Claude's ultracode dynamic workflow and bullswarm `workflow goal`. |
| [Workflow V2 component probes](/experiments/2026-08-31-v2-component-probes) | 2026-08-31 | The component probes behind the V2 revision, with each acceptable revision checked against them. |
| [Is the workflow system at ultracode quality?](/experiments/2026-09-06-caller-planner-evaluation) | 2026-09-06 | The evaluation behind the caller-planner change, written against 0.23.2 → 0.24.0 with every claim measured or labelled. |
| [Custom provider configuration handoff](/handoff-2026-09-13-custom-provider-config) | 2026-09-13 | A design discussion, not yet implemented, on letting a package user add their own provider without touching the repository. |
| [Integration audit](/integration-audit-2026-08-31) | 2026-08-31 | Whether Codex, Claude, and Grok can discover the Bullswarm skill, as read-only evidence at commit `8908ef8`. |
| [Planner prompt and context audit](/planner-prompt-audit-2026-08-29) | 2026-08-29 | Whether the orchestrator/planner instruction set still made sense after the 0.11 → 0.14 iterations. |
| [Portal token diet](/studies/portal-token-diet) | 2026-09-09 | What transfers from Portal's token-diet claims to bullswarm — the policy of naming work worth a frontier model, not the plumbing. |
| [Workflow agent usability audit](/workflow-agent-usability-audit-2026-08-27) | 2026-08-27 | Four isolated Node projects handed to four entry paths, and how usable the workflow surface proved for an agent. |
| [Dynamic workflows design](/workflow-design) | 2026-08-21 | The design of the authored-graph engine removed in 0.27.0, kept for its rationale. |
| [Shared program execution](/workflow-simplification) | 2026-09-07 | The proposal for the thin program executor — shared files, prompt-level territories, and a sole integrator after parallel work. |
