---
title: Bullswarm documentation
permalink: /
---

Bullswarm is a CLI that sends a coding task to whichever of your installed
agent CLIs — Claude Code, Codex, Grok, OpenCode, or Command Code — currently
has unused subscription quota, then checks the result by its content.

It routes by quota and pace instead of a fixed map from work type to agent,
and it judges every delegate's output by content, never by exit code. A
**pool** is one installed agent CLI, or one account of that CLI. A **lane**
is the nature of the work: `analyze` (read-only), `build` (edits), or
`chore` (mechanical edits).

## Guides

| Page | What it covers |
|---|---|
| [Entry points](./guide/entry-points/) | `run` vs `workflow goal`, and every top-level verb with its one-line purpose |
| [Doctrine](./guide/doctrine/) | The four non-negotiable rules, and the result verdict shape |
| [Getting started](./guide/getting-started/) | Install, integration with Codex/Claude/Grok, quick-start commands |
| [Strategy](./guide/strategy/) | Model/provider configuration, rungs (model plus reasoning level per effort tier), benchmark evidence |
| [Workflows](./guide/workflows/) | Authoring a program, kinds, advisories, the plan contract/validate/goal flow |
| [Operations](./guide/operations/) | Listing and inspecting runs, the result envelope, context diet |
| [Dashboard](./guide/dashboard/) | `workflow watch`, the interactive TUI, terminal glyph fallback |
| [Repository operations](./guide/repository-operations/) | The issue-watcher launchd agent |
| [Routing](./guide/routing/) | How a pool is picked: pace, 5-hour headroom, expiring-soon urgency, load, quarantine |

## Internal notes and studies

These are historical working notes, audits, and experiment writeups, kept as
records rather than as current documentation. Skip this list unless you are
working on the Bullswarm codebase itself:

- [claude-dynamic-workflow-mechanics.md](./claude-dynamic-workflow-mechanics.md)
- [dynamic-workflow-handoff.md](./dynamic-workflow-handoff.md)
- [dynamic-workflow-qa.md](./dynamic-workflow-qa.md)
- [dynamic-workflow-v2-execution-plan.md](./dynamic-workflow-v2-execution-plan.md)
- [integration-audit-2026-08-31.md](./integration-audit-2026-08-31.md)
- [planner-prompt-audit-2026-08-29.md](./planner-prompt-audit-2026-08-29.md)
- [workflow-agent-usability-audit-2026-08-27.md](./workflow-agent-usability-audit-2026-08-27.md)
- [workflow-design.md](./workflow-design.md)
- [workflow-simplification.md](./workflow-simplification.md)
- [audits/2026-09-09-codebase-audit.md](./audits/2026-09-09-codebase-audit.md)
- [design/2026-09-06-caller-first-cli.md](./design/2026-09-06-caller-first-cli.md)
- [experiments/2026-08-28-trending-ai-autonomy.md](./experiments/2026-08-28-trending-ai-autonomy.md)
- [experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm.md](./experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm.md)
- [experiments/2026-08-29-ultracode-vs-bullswarm.md](./experiments/2026-08-29-ultracode-vs-bullswarm.md)
- [experiments/2026-08-31-v2-component-probes.md](./experiments/2026-08-31-v2-component-probes.md)
- [experiments/2026-09-06-caller-planner-evaluation.md](./experiments/2026-09-06-caller-planner-evaluation.md)
- [studies/portal-token-diet.md](./studies/portal-token-diet.md)
