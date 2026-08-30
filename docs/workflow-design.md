# bullswarm Dynamic Workflows — Design

**Status:** implemented; historical design rationale retained · **Created:** 2026-08-21

## Problem

bullswarm routes ONE task to ONE pool with ONE verdict. Real work comes in
shapes: audit 47 route handlers, review every changed file in a PR, sweep a
repo for a bug class, research across sources and cross-check. Claude Code
solved this with dynamic workflows: the orchestration plan moves from the
model's context window into an executable artifact. This design brings that
capability to bullswarm's multi-subscription world — where the execution
fabric is metered, verified, and provider-diverse.

## Prior art (studied)

| System | Core idea | What we take | What we reject |
|---|---|---|---|
| Claude Code dynamic workflows | Plan-in-JS executed by runtime; 16 concurrent / 1000 cap; resumable; adversarial verification enforced structurally | Phases + fan-out + skeptic patterns; background run; script-as-artifact | JS-sandbox authoring (Claude writes code; our users/agents shouldn't have to) |
| open-dynamic-workflow (odw) | Open reimplementation pointed at external CLIs; vm sandbox; deterministic resume via call fingerprints; artifacts per run | Deterministic-replay resume; artifact tree; item-streaming pipelines; event stream → renderer separation; declarative safety limits | TS workflow authoring; static per-call providers; no meters; no content verify |
| MS Conductor | YAML workflows, deterministic routing, zero tokens on orchestration | Declarative format; human gates; dry-run validation | Full DAG generality |
| pilotfish | Role policy; verdicts are evidence not authority; bounded escalation | Verdict vocabulary; escalation caps | Prompt-only enforcement |

## Thesis

Claude's workflows answer "how do I run 500 agent calls without drowning my
context?" — but every call burns the SAME subscription. bullswarm answers a
question nobody else asks: "what if each of those 500 calls could land on
whichever subscription has headroom, and get content-verified before it
counts?" The workflow feature makes bullswarm the metered execution fabric
for plan-driven work.

## Format decision: declarative JSON, not executable JS

Claude/odw execute user-written JS in sandboxes. That buys expressiveness at
the cost of a security boundary, nondeterminism guards, and requiring the
author to be a programmer. Bullswarm's workflows are:

- **JSON documents** — validatable before anything runs (`workflow validate`),
  writable by any agent via its existing file tools, diffable in PRs.
- **Templated, not programmed.** The only "logic" is `{{ref}}` substitution
  from prior step outputs and JSON-path extraction. Everything Claude's
  example scripts do between `agent()` calls (filter, dedupe, merge) is
  either a step option here or belongs in a delegate's prompt.
- **Deterministic by construction** — no user code runs in-process, so
  resume/replay is trivially safe.

If expressiveness becomes a wall later, odw-compatible `.ts` workflows can be
added as a second format without touching the runtime contract.

## Schema

```jsonc
{
  "name": "route-review",                  // required, kebab-case
  "description": "...",                     // required
  "version": "1.0.0",
  "inputs": {                               // optional, overridable per run
    "targetDir": { "default": "." },
    "files":     { "required": false }
  },
  "phases": [                               // ordered; UX grouping + gates
    {
      "name": "review",
      "steps": [
        {
          "id": "fanout-review",            // required, unique
          "type": "run",                    // run | fanout | verify | decide
          "taskFile": "/tmp/wf/{{runId}}/task-{{item}}.md",
          "lane": "analyze",
          "addDir": "{{inputs.targetDir}}",
          "timeoutSec": 600,
          "onError": "continue"             // continue | fail | skip-phase
        },
        {
          "id": "per-file-review",
          "type": "fanout",
          "itemsFrom": "discover.files",   // JSON path into state.outputs
          "concurrency": 4,
          "stepTemplate": {                 // expanded once per item
            "lane": "chore",
            "addDir": "{{inputs.targetDir}}",
            "prompt": "Review {{item}} for auth gaps."
          },
          "onError": "continue"
        }
      ]
    }
  ],
  "settings": {
    "concurrency": 8,                       // global cap across fanouts
    "stopOnPhaseFailure": false,
    "escalateOnFail": true                  // retry failed steps on next pool
  }
}
```

Step fields (all pass through to the existing `run` pipeline):
`lane`, `addDir`, `taskFile`, `prompt`, `timeoutSec`, `pool`
(pin a pool; default = paced routing), `onError`.

### Step types

- **`run`** — one offload. Verdict recorded.
- **`fanout`** — expand `stepTemplate` once per item from `itemsFrom`.
  Items may be strings or objects (`{{item.path}}` paths work). Concurrency
  capped by min(step, settings).
- **`verify`** — independently review a prior artifact and require structured
  `{ok, concerns, summary}` evidence before dependent work may trust it.
- **`decide`** — give the durable orchestrator current intent, outputs,
  failures, budgets, and capabilities. Its versioned proposal is validated
  before bounded `run`, `fanout`, or `verify` actions enter the plan.

`run` and fan-out templates may declare `outputSchema` when later actions need
structured `outputs.<id>.data` or data-backed fan-out. Ordinary prose should
leave it unset; `verify` has its own fixed verdict schema.

### Templating

`{{...}}` resolves against a single scope, precedence: loop item > inputs >
prior outputs (`outputs.<stepId>`), whole-run metadata (`runId`, `wfDir`).
Missing reference → validation error *unless* inside `fanout.stepTemplate`
where `{{item}}`/`{{item.*}}` resolve per-expansion.

## Runtime

```
load → validate → resolve inputs → for each phase:
  for each step:
    run | expand fanout → dispatch tasks through router+verify (existing
    watchOnce pipeline) with concurrency limiter
    record outputs → next
artifacts + report + exit code
```

- **Dispatch** reuses `watchOnce` verbatim — same verdict contract
  (`ok`, `keepOnClaude`, `why`, `contentUsableDespiteExit`), same quarantine
  side effects, same meter accounting as single runs.
- **Escalation** (`escalateOnFail`): a failed step retries once on the next
  pool by surplus (existing `pickPool` minus incumbent). Mirrors odw retry
  but is verdict-driven, not timer-driven.
- **Concurrency**: one limiter across all in-flight dispatches.
- **State**: `~/.bullswarm/workflows/<runId>/state.json` after every step —
  crash-safe by construction.
- **Resume**: `workflow run --resume <runId>` skips steps whose saved verdict
  is `ok:true` and whose declared output schema, if any, is satisfied;
  everything else re-runs. Fanout items resume by content fingerprint, so
  already verified items remain complete even when discovery order changes.
- **Artifacts** per run: `state.json`, `report.json`, every task/out file.

## Terminal UX (the deliverable's face)

Claude-style live view, plain ANSI (no deps):

```
bullswarm workflow · route-review · run wf-a1b2c3

▐ phase 1/2 · discover                                    ⏳ running
  ✓ discover.files              codex        12.3s   ok · 47 items

▐ phase 2/2 · review                                      ⏳ running
  ⟡ per-file-review[0/47]       grok         31.0s   … verifying
  ✓ per-file-review[1/47]       command-code 28.9s   ok
  ✗ per-file-review[2/47]       opencode2    40.1s   fail · announcement without substance
    ↳ escalate → codex
  ⋈ per-file-review[3/47]       —            —       quarantined pool, waiting

── summary ──────────────────────────────────────────────
✓ 45 · ✗ 2 · ⋈ 0                        elapsed 6m 12s
report: ~/.bullswarm/workflows/wf-a1b2c3/report.json
```

Marks: `✓` ok · `✗` fail · `⟡` running · `⋈` blocked · `⏭` skipped · `⏳` phase.
Non-TTY: same events as indented JSONL lines. `--json`: machine report only.

## CLI

- `bullswarm workflow validate <file>` — schema + template refs + lane/pool names
- `bullswarm workflow list` — discovered workflows in `./workflows`,
  `~/.bullswarm/workflows`
- `bullswarm workflow run <file> [--input k=v]… [--resume <runId>] [--json]
  [--quiet]`
- bare `bullswarm workflow run <file>` works headless (no TTY prompts ever)

## Non-goals (prototype)

- No JS/TS executable workflows (see format decision)
- No child workflows, loops, or conditionals beyond `onError`
- No parallel phases
- No web dashboard

## Success proofs

1. `workflow validate` catches: bad lane, unknown pool pin, missing template
   ref, duplicate step id, bad onError value, non-unique phase names.
2. Example workflow runs end-to-end on echo connector in CI-safe mode.
3. A fanout of N items produces N verdicts + N output files, concurrency
   never exceeds the cap (assert via timing/ordering in test).
4. Kill mid-fanout → `--resume` completes remaining items only.
5. Escalation: forced-fail first pool → step retries on second pool → ok.
6. Dogfood: real workflow over bullswarm's own connectors directory;
   outputs QA'd by me.
7. Terminal UX shows phases/steps/pool/status exactly as specced above
   (screenshot-in-text captured in QA notes).
