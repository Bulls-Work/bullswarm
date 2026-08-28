# bullswarm changelog

## 0.11.1 — reliable `--watch` handoff

- `workflow goal --watch` no longer races the detached child: the watcher now
  waits up to 30 s for the run's `state.json` to appear before attaching, and
  `runWorkflowWatch` accepts `waitForRunMs`. The 0.11.0 tag failed to publish
  because this race made the release-gate test fail on the CI runner; 0.11.1
  carries the full 0.11.0 change set below.

## 0.11.0 — plan the whole graph, run it wide

Adopts the driving mechanics of Claude Code's dynamic workflow (documented in
`docs/claude-dynamic-workflow-mechanics.md`) into the autonomous loop.

- Ready-set scheduler: every planner action whose dependencies have succeeded
  starts immediately, and a dependent action starts the moment its own inputs
  finish rather than when the whole round finishes. The global
  `settings.concurrency` limiter caps real parallelism. Verify-B now overlaps
  fix-C exactly like a Claude `pipeline()` stage.
- Planning doctrine: the planner is told to propose the complete dependency
  graph in one decision (per-item fix→verify chains plus one whole-system
  verify), to declare file ownership per action and order same-file edits with
  `dependsOn`, to write self-contained worker prompts, and what a planning round
  trip costs. The goal orchestrator prompt no longer asks for "the smallest
  useful set" of actions. `executionConstraints.concurrency` is exposed.
- `workflow goal` default `--concurrency` is 8 (was 3; max 16).
- The planner prompt's shared-working-tree caution now says what is actually
  unsafe (whole-tree mutation, running the full suite while others edit) and
  states that concurrent workers editing disjoint files is the expected mode;
  the 0.10.9 orchestrator had cited the old wording as its reason not to fan
  out ("Implementation is deliberately NOT fanned out … shared-target mutation
  policy").
- `verify.review` is recovered when a planner puts instructions or a filesystem
  path there: instructions move to `prompt`, the single dependency's artifact is
  inferred, and any `review` that is not `outputs.<actionId>.outFile` is
  rejected at validation (feeding the corrective turn) instead of failing a
  dispatch after a full planning round trip.

## 0.10.9 — planner self-correction and honest silence

- An invalid or non-JSON orchestrator decision no longer fails the run. The
  runtime feeds the exact validator issues, the rejected proposal, and a
  response excerpt back to the same orchestrator thread for bounded corrective
  turns (`settings.maxPlannerCorrections`, default 2, emits
  `decision.correction_requested`), then benches that pool as orchestrator for
  the rest of the run and escalates to one other eligible pool
  (`decision.orchestrator_escalated`), and only then settles on a qualified
  `completed_with_concerns`/`blocked` outcome. The decide action's ledger status
  now agrees with that outcome (`failed_retryable` while correcting,
  `failed_terminal` on exhaustion) instead of reporting `succeeded`.
- The planner prompt now shows complete `run`, `fanout` (`items` +
  `stepTemplate.prompt` with `{{item}}`), and `verify` (`review`) skeletons, so
  the first proposal can match what `decision.js` validates.
- `workflow watch` separates two silences: `quiet` counts durable workflow
  events, and a new `agent output … ago` figure (JSONL `transportQuietForSec`)
  counts raw output from live agents, so a thinking agent and a dead one look
  different on the same heartbeat line.
- Removed the dead thin-leaf help renderer left over from the help unification
  and stopped hard-coding the test count in AGENTS.md.

## 0.10.8 — quieter monitoring and resilient orchestration

- Made `workflow watch` aggregate low-level activity into compact interval
  heartbeats by default, with event/action deltas, quiet duration, prompt
  semantic transitions, terminal result handoff, and `--verbose` drill-down.
- Implemented the documented top-level `run --prompt` form and standardized
  usage errors as exit 2 across run, workflow drafts/runs, and strategy paths.
- Added explicit goal-resume orchestrator pin/unpin behavior and strengthened
  the orchestrator as a control-plane-only decision thread.
- Recognize Claude's exact `Failed to authenticate` response as an auth failure
  and migrate the connector signature additively without replacing local
  connector customization.
- Expanded non-network CLI, health, release, watch, resume, auth, help, and
  documentation coverage. The full suite now contains 271 tests.

## 0.10.7 — clearer orchestration overview

- Replaced the orchestrator trace dump with a summary-first view showing what
  it is doing now, the latest decision and reason, the next action, worker
  progress, and the last three semantic events.
- Added `v` progressive disclosure for provider sessions, checkpoint prompts,
  per-turn usage, full decisions, and artifact paths, keeping audit detail
  available without making it the default human experience.

## 0.10.6 — safe setup and boolean flags

- Marked the deterministic `echo` connector as a test fixture and excluded it
  from automatic setup, routing suggestions, connector readiness, and delegate
  readiness. Existing installations receive a one-time migration that disables
  an accidentally enabled fixture while preserving later explicit choices.
- Interactive setup labels test fixtures and defaults them to disabled;
  `doctor` now requires at least one real enabled delegate instead of treating
  canned fixture output as offload capability.
- Made top-level boolean flags explicit so options such as `--no-caller`,
  `--force`, and `--dry-run` cannot swallow a following positional task.
- Thanks to @kwunlokng for reporting both defect classes and supplying focused
  reproductions in #1, #2, and #3.

## 0.10.4 — durable interactive workflow viewer

- Added `workflow runs result <id> [--json]`, a stable
  `bullswarm.workflow.result.v1` handoff for parent agents. It selects the final
  successful delivery rather than the last orchestrator response, pairs it with
  its dependent verification verdict, and reports progress, step logs, token
  usage, and honest complete-or-partial tool-call counts.
- Goal launches now return and print a four-part operating handoff for agentic
  inspection, low-noise watching, the human TUI, and terminal result retrieval.
- Plain `workflow goal` now launches independently, prints that handoff, and
  returns. The new explicit `--watch` flag follows low-noise progress until the
  terminal state; the human TUI is opened from the printed command.
- `--foreground` retains terminal-owned execution and `--detach` remains an
  explicit backward-compatible spelling of the new default.
- Rebuilt interactive workflow inspection as a responsive Phase → Agent →
  Agent-activity browser: desktop uses two contextual panes while mobile and
  narrow SSH terminals use one full-width level. It includes arrow/Enter/Esc
  navigation, numbered semantic actions, active-agent following, scrolling,
  completed-agent outcomes, total semantic-action counts, terminal agent
  progress, resize handling, safe detach, and confirmed stopping.
- Made the autonomous orchestrator a compact selectable control-plane panel
  stacked above the phase tree. Arrow/Enter or `o` opens its
  durable session, checkpoint decisions, semantic
  activity, usage, prompt, outcomes, and artifacts without counting planner
  turns as phase workers.
- Standardized workflow TUI state marks across orchestrator, phases, agents,
  and semantic activity: `○` pending, animated Braille spinner active, `⧖`
  waiting, `✓` complete, and `✗` failed or interrupted.
- Made `maxExpansionRounds` an advisory convergence target instead of a hard
  failure boundary. Near the target the orchestrator is told to consolidate
  existing evidence and avoid marginal expansion; essential bounded work may
  exceed it and the overage is recorded.
- Added truthful qualified terminal outcomes: planner `stop` now yields
  `completed_with_concerns` with a ready best-effort delivery when useful work
  exists, or `blocked` when it does not. Result envelopes expose `verified`,
  the stopping reason, and unresolved concerns without relabeling failed
  verification as success.
- Made phase and agent status derive from semantic output verdicts, so a
  verifier process that successfully returns `ok:false` is displayed as a
  failed verification rather than a completed check.
- Added persisted `strategy exclude-model` / `include-model` policy. Excluded
  models are removed from strategy recommendations and dispatch assignments;
  connectors pin an allowed same-tier fallback or become ineligible when they
  cannot guarantee the exclusion.
- Let the CLI process drain stdout before exiting, preventing large
  `workflow tui --json` snapshots from being truncated around the platform
  pipe-buffer boundary.
- Expanded `workflow --help` into an operational map for building, observing,
  controlling, and auditing workflows.

## 0.10.3 — contextual help everywhere

- Added side-effect-free `-h` / `--help` handling for the top-level CLI and
  every command and nested subcommand, including workflow drafts, run history,
  approvals, actions, integrations, and strategy policy controls.
- Added a centralized command help tree so contextual help is consistent and
  intercepted before setup, provider discovery, state writes, or destructive
  command execution.

## 0.10.2 — cross-agent skill integration

- Added explicit `bullswarm integrate status|install|remove` support for Codex,
  Claude, and Grok. Installation registers one packaged `bullswarm` skill with
  all selected agents and writes concise marker-delimited global awareness
  rules; removal touches only Bullswarm-managed links and blocks.
- Added recoverable `integrate retire-legacy --yes` migration for the retired
  Claude `offload` skill. Detection is read-only and retirement always moves the
  old skill into `~/.claude/skills-archive/`.
- Added recursion-aware global guidance: a worker with `BULLSWARM_DEPTH` set
  performs its assigned task directly instead of casually spawning another
  swarm.
- Renamed the published agent skill from `bullswarm-setup` to `bullswarm` and
  documented single-task, zero-graph goal, fixed-workflow, observation, and
  integration paths together.
- Corrected README language so agent/time targets are advisory while graph
  expansion limits remain hard safeguards.

## 0.10.1 — initiated-time workflow history search

- Added `workflow runs --since <time> --until <time>` filtering against the
  workflow's initiation timestamp (`startedAt`), with an inclusive lower bound
  and exclusive upper bound.
- Added `--from`/`--to` and `--started-after`/`--started-before` aliases plus
  ISO timestamps, local dates, calendar keywords, and relative durations such
  as `7d`.
- Historical listing now falls back to `report.startedAt` when an older state
  record lacks its initiation timestamp, and JSON output reports the normalized
  range used for the audit.

## 0.10.0 — battle-tested advisory orchestration and agent activity

- Made `maxAgents` and `maxWorkflowSeconds` advisory planning targets instead
  of hard stops. Workflows can exceed them to finish required implementation
  and verification; structural graph-growth limits remain enforced.
- Removed implicit connector and generated-goal wall-clock timeouts. Delegates
  wait for natural completion unless an operator explicitly supplies a timeout,
  requests cancellation, or a definitive auth/quota failure is observed.
- Added compatibility migration for generated 0.9.0 goals carrying Bullswarm's
  former 900-second planner/action timeout defaults.
- Fixed adaptive completion policy, current-action metadata, provider routing
  history, usage aggregation, latest-worker verification, and truthful partial
  token/cost accounting found during the Kipwise battle test.
- Added connector-owned native JSONL event adapters for Codex, Claude, Grok,
  Command Code, and OpenCode. Workflows now retain and display the latest three
  semantic shell/read/edit/write/response actions for every active agent.
- Added conservative stall evidence: ten minutes without transport, parsed
  event, or semantic action activity is labeled `suspected_stalled` but never
  causes an automatic kill.
- Added a low-noise `workflow watch <id>` progress stream with semantic-change
  updates, heartbeats, last-three agent actions, and terminal per-attempt timing.
- Added optional durable `workflow steer <id> --message ...` guidance delivered
  only at the next planning checkpoint, never injected into an active worker.
- Captured runtime model IDs declared in provider event streams for more complete
  model/cost attribution, preserved Grok tool kinds across name-less updates,
  and enabled Claude's supported forwarded-subagent text stream.
- Taught planners to reuse clean full-suite evidence and isolate mutation/pre-fix
  experiments instead of redundantly or concurrently testing a changing tree.
- Expanded the offline suite to 224 tests. Real bounded CLI probes confirmed
  all five provider event formats, and an exact packaged OpenCode watch smoke
  passed argument injection, action normalization, final-output extraction,
  and the content gate together.

## 0.9.0 — resilient dynamic workflow routing

- Added cooperative `SIGTERM`/`SIGINT` handling, durable `interrupted` states,
  dead/stale owner reconciliation, and clean resume after interruption.
- Added capability-context filtering for model recommendations plus an explicit
  `strategy apply --yes` approval gate and TTL-based automatic refresh.
- Added setup-time worktree policy and strategy-autopilot choices.
- Added per-attempt routing reasons/candidate surplus to durable events, state,
  decision logs, and the printable workflow tree.
- Added top-level `runs` and `--version` aliases, complete `workflow goal`
  budget help, and correct phase/terminal display for completed runs.

## 0.8.0 — autonomous goals, model strategy, and auditable usage

- Added `workflow goal` for bounded observe-plan-execute loops without an
  upfront graph, including planner-owned expansion, completion policy,
  detachment, resume, cancellation, ordered events, and durable action and
  attempt ledgers.
- Added first-class `decide` and adversarial `verify` actions with strict JSON
  contracts, capability-aware routing, bounded retries/escalation, and hard
  expansion/dispatch/time limits.
- Added `strategy refresh/show/set-subscription/assign` to discover models from
  installed CLIs, combine connector-owned dated price/benchmark metadata with
  live quota surplus, and persist high/medium/low effort preferences.
- Added connector-owned model selection plus `--effort` routing for ordinary
  runs and workflow actions. Safety eligibility always overrides preferences.
- Added per-attempt agent/model, standard-read/cache-read/cache-write/output
  token estimates, API-equivalent cost, subscription-normalized quota, and
  honest partial totals when a provider omits model or usage data.
- Added `workflow tui <runId>` as a printable historical phase/action/attempt
  tree in both TTY and non-TTY environments, alongside JSON state/events.
- Expanded the offline suite to 195 tests. A fresh-home real-provider trial
  autonomously fixed and independently verified a failing Node fixture; a
  deliberately undersized dispatch budget also stopped truthfully rather than
  claiming completion.

## 0.7.0 — short run IDs + workflow runs

Workflow runs were opaque (`wf-mtapqmfm-ad9ba7` everywhere) and
there was no way to list or operate on past runs except by
file-system diving. v0.7.0 adds:

- **6-character short IDs** (Crockford-style 32-char alphabet, no
  `0/1/i/l/o` for visual clarity). Every new run gets a `shortId`
  on both `state.json` and `report.json`. The full `wf-...` runId
  stays the durable handle.
- **`bullswarm workflow runs ...`** sub-verb:
  - `runs` (default = ongoing only) — list with a `●`/`○` marker
  - `runs --all` — ongoing + historical
  - `runs --historical` — only historical
  - `runs --name <wf>` — filter by workflow
  - `runs --limit N` — cap result count
  - `runs show <id>` — dump `state.json` + `report.json`. Accepts
    shortId, full runId, or run-dir path.
  - `runs delete <id> --yes` — remove a run directory. Refuses
    ongoing runs without `--force`.
- **Resume by short ID**: `bullswarm workflow run <wf> --resume
  <shortId>` resolves the shortId to the full runId before any
  dispatch. Bogus tokens fail fast, before workflow load.
- **`isOngoing(runDir, state)`** helper: classifies a run as
  ongoing when `state.finishedAt` is unset AND `state.json` was
  modified within the last 90 s. After the 90 s window a run is
  treated as historical even if `finishedAt` was never written
  (e.g. process killed before terminal `persist()`).

### New files

- `src/workflow/short-id.js` — Crockford-style generator, resolver,
  `isOngoing`, `listRuns`
- `src/workflow/runs-cli.js` — `cmdRuns` dispatch
- `tests/workflow-runs.test.js` — 16 new tests

### Tests

- 16 new tests covering shortId generation, resolution, lock-free
  ongoing detection, list filtering, show, delete, and the resume
  pre-flight.
- Full suite is 147 green (131 prior + 16 new), stable across 3
  stress runs.
- Verified end-to-end by `cmd -p --yolo` against a real CLI
  installation: every step of the runbook passed.

## 0.6.0 — incremental workflow drafts (CLI builder)

The static `workflow run <file>` shape required every workflow to be
authored as a JSON file in advance. That's not "dynamic" — it's a script
of record. v0.6.0 introduces `bullswarm workflow draft ...`, a
sub-verb group that lets you build a workflow interactively from the
shell, one mutation at a time. Drafts persist under
`~/.bullswarm/drafts/<name>/` and are promoted to first-class
workflows (discoverable, runnable by name, validatable) the moment
they're created.

### New CLI surface

```
bullswarm workflow draft create <name> [--description ...] [--input k=v]...
bullswarm workflow draft show <name>
bullswarm workflow draft list
bullswarm workflow draft phase add <name> <phase>
bullswarm workflow draft phase remove <name> <phase>
bullswarm workflow draft step add <name> <phase> <step-id> --type run|fanout|verify [--lane ... --prompt ... --add-dir ... --pool ... --items-from ... --review ... --concurrency N --timeout N --on-error ... --step-template <json>]
bullswarm workflow draft step remove <name> <phase> <step-id>
bullswarm workflow draft step set <name> <phase> <step-id> <field> --value <text>
bullswarm workflow draft set <name> <field> --value <text>
bullswarm workflow draft validate <name>
bullswarm workflow draft export <name> <out-file>
bullswarm workflow draft delete <name> --yes
bullswarm workflow draft run <name> [--input k=v]... [--resume id] [--json] [--quiet]
```

- Every mutation re-validates immediately and persists the verdict on
  `meta.json.lastValidation`. `bullswarm workflow list` shows drafts
  with a `(draft)` tag.
- `bullswarm workflow run <draft-name>` and `workflow validate
  <draft-name>` accept a draft name the same way they accept a JSON
  filename — the new `workflowDirs()` entry `~/.bullswarm/drafts/`
  makes drafts first-class.
- `bullswarm workflow draft export <name> <file>` promotes a draft
  to a checked-in JSON for version control.
- Partial drafts (zero phases, or a phase with zero steps) are
  treated as BUILDING, not INVALID — the validator's
  `phases-must-be-non-empty` rule is downgraded to a warning during
  construction. Real schema violations (bad lane, duplicate step id,
  etc.) still return nonzero.
- `delete` requires `--yes` so a stray arrow-key can't nuke a draft.
- The `BULLSWARM_HOME` env var redirects drafts to a sandbox under
  any temp dir, so the same `autoSetup` flow agents use elsewhere
  works here.

### Tests

- 25 new tests in `tests/workflow-draft.test.js`. Two layers:
  module-level (no spawn) for every mutation, CLI-level (spawnSync)
  for the user-facing contract.
- Full suite is now 131 green (106 prior + 25 new).

### Files

- New: `src/workflow/draft.js` — storage, atomic writes, validation hook
- New: `src/workflow/draft-cli.js` — `cmdDraft` dispatch + flag parsing
- New: `tests/workflow-draft.test.js`
- Modified: `src/workflow/cli.js` (added `draft` sub-verb, drafts in
  `workflowDirs()` and `discover()`)

## 0.5.0 — gap-closure release

Workflow parity with Claude Code dynamic workflows plus deep-QA hardening.
All 10 gaps identified in the v0.4.0 audit are closed; 23 new tests
added; full suite is 105 green (82 prior + 23 new).

### Workflow runtime (R-numbered doctrine)

- **R4 — global concurrency limiter**: a real `Semaphore` (`src/workflow/semaphore.js`) is shared by every `runSingle` and every fanout worker. Per-fanout worker count is capped at `min(per-fanout, limiter.permits, items.length)`. A `step.blocked` event fires when items queue behind the cap.
- **R6 — recursion-guard propagation**: every workflow dispatch computes `childDepthEnv(parentEnv)` and passes it to `watchOnce`. The runtime asserts `assertDepthAllowed(coreState, parentEnv)` before each dispatch. A workflow that itself spawns `bullswarm` is refused at the core's depth limit instead of recursing forever. `src/lib/watch.js` now honors caller-supplied `opts.env` so the depth env actually reaches the child.
- **R7 — quarantine + decision log on workflow auth failures**: when a dispatch inside a workflow returns `quarantineHint: true`, the runtime calls `quarantinePool(state, poolName, why, now)` against the core state file and appends a `source: "workflow"` entry to the shared `decisionLog` so `bullswarm health` and `pools` see workflow runs. The live `pools` view is updated so the next dispatch in the same run does not re-select the benched pool.
- **R8 — burst-gate exclusion in workflows**: `preparePools` now drops any pool with `burstGate === true` (5h ≥ 90 %), matching the single-run path.
- **R10 — fingerprint-aligned fanout resume**: every fanout result is now stamped with `sha1(JSON.stringify(item)).slice(0,12)`. On resume, items are matched by fingerprint first; positional alignment is a fallback for state.json from prior versions. Reordering, adding, or removing items no longer breaks resume.
- **R9 — outputText truncation**: `recordOutput` caps `state.outputs[id].outputText` at `OUTPUT_TEXT_CAP_BYTES = 64 KB`. The on-disk outFile always holds the full transcript. Persisted state.json is now bounded.

### New step type: `verify` (skeptic)

- Adversarial review of a prior step. Schema: `{ type: "verify", review: "outputs.<prior>.outFile", lane, prompt?, timeoutSec? }`. The runtime reads the prior outFile, inlines it into a structured prompt asking for `RETURN ONLY {"ok": <bool>, "concerns": [...], "summary": ...}`, dispatches through the standard pool-routed pipeline, and parses the first JSON object in the response. Step is `ok:true` only if dispatch verifies AND the JSON `ok` is `true`. The parsed `verify` object is recorded on `state.outputs[id].verify` so downstream steps can reference `concerns` and `summary`.
- Validated: `review` must resolve to a known prior outFile or a declared input; `inputs.<k>.required` is now type-checked and runtime-enforced.
- See `workflows/verify-and-cap.json` for an end-to-end example.

### New settings

- `settings.maxAgents` — hard cap; a step that would push dispatch count past the cap fails with `why: "spend guard: maxAgents=... reached"`.
- `settings.warnAtAgents` — advisory; a `workflow.large` event fires once when the threshold is crossed. TUI renders it as `⚠ Large workflow: N dispatches ≥ threshold M`.
- `settings.concurrency` is now validated to be `≤ 16`, matching Claude Code's runtime cap.
- `inputs.<k>.required: true` is now a hard pre-flight refusal. `runWorkflow` throws `required input "<k>" missing` before any dispatch.

### New runtime events

- `item.skipped` — emitted by fanout resume; was dropped silently in TTY mode. Now rendered as `⏭ <stepId>[i]   ok from previous run (resume)`.
- `step.blocked` — emitted when items queue behind the global cap; rendered as `⋈ N item(s) queued behind concurrency cap in <stepId>`.
- `workflow.large` — emitted once when the dispatch threshold is crossed.

### CLI

- `BULLSWARM_HOME` env var now overrides the workflow CLI's `BULLSWARM_DIR` (previously hardcoded to `~/.bullswarm`). Matches the meter registry.
- `--input k=v` accepts JSON-encoded values so arrays and objects can be passed: `--input 'items=["a","b"]'`. The legacy string form is unchanged.

### TUI

- `item.skipped`, `step.blocked`, and `workflow.large` are all rendered in human mode (previously `item.skipped` was TTY-invisible).

### Tests

- 23 new tests in `tests/workflow-gaps.test.js`, one per gap closure.
- 105 total tests, all green, no network, ~1 s.

### Files

- New: `src/workflow/semaphore.js`
- New: `tests/workflow-gaps.test.js`
- New: `workflows/verify-and-cap.json`
- New: `CHANGELOG.md`
- Modified: `src/workflow/runtime.js`, `src/workflow/runner.js`, `src/workflow/validate.js`, `src/workflow/tui.js`, `src/workflow/cli.js`, `src/lib/watch.js`
