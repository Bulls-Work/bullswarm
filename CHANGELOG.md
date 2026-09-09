# bullswarm changelog

## 0.27.0 — one workflow engine

- There is now one workflow engine. The authored-graph verbs `workflow run`,
  `validate`, `list`, `draft`, `inspect` and `approval` are gone — each falls to
  the workflow-level unknown-verb message, exits 2 and spawns nothing — and with
  them the eleven V1 modules they drove: `runtime.js` (1,902 lines),
  `runner.js` (1,304), `draft-cli.js` (434), `validate.js` (366),
  `decision.js` (357), `tui.js` (297), `draft.js` (268), `result.js` (239),
  `template.js` (146), `schema.js` (81) and `semaphore.js` (56). The V1 panel
  model, timeline and orchestrator-detail twins came out of `dashboard.js`
  (−965), the V1 branches out of `cli.js` (−291), `runs-cli.js` (−141),
  `short-id.js` (−127) and `watch-cli.js` (−132). `src/workflow/*.js` goes from
  16,941 lines to 10,257. Also deleted: the five saved definitions
  `workflows/adaptive-code-review.json`, `agent-model-comparison.json`,
  `connector-audit.json`, `smoke-two-step.json` and `verify-and-cap.json`
  (257 lines) together with the `workflows/` entry in package.json `files`;
  `scripts/sanity-multi-claude.mjs` (131), which only exercised `runWorkflow`;
  and two more tools that could only reach deleted modules —
  `bin/check-output-schema.js` (30, the V1 `outputSchema` worker preflight) and
  `scripts/planner-contract-probe.mjs` (175, a probe for the V1 `decide`
  planner). `workflow capabilities` now reports `engines.authoredGraphs` as
  `{ retired: '0.27.0', command: null }` instead of advertising a verb that
  exits 2. `bullswarm workflow --help` describes one engine.

- `newRunId` moved from `runner.js` into `src/workflow/short-id.js`, same
  behaviour, exported; `v2-runtime.js` imports it from there.

- Removed the last V1 remnants that no gate caught because they named no
  deleted symbol: the dead authored-graph planner prompt in
  `src/workflow/goal.js` (`AUTONOMOUS_ORCHESTRATOR_PROMPT`,
  `PLANNER_RULES_SECTION`, `PLANNER_EXAMPLES_SECTION` — 36 lines whose only
  consumer was the deleted `runtime.js`, and which still taught `type`,
  `stepTemplate`, `itemsFrom`, `outputSchema`, `covers` and `completion.when`
  to a planner the V2 validator would reject), and the permanently-zero
  `fanout: { total, ok, failed }` counter that `dashboard.js` still put on every
  row and rendered behind an unreachable branch. `outputSchema`, `itemsFrom` and
  `stepTemplate` now appear nowhere in `src/`. The `skill/references/operations.md`
  "Adversarial verification" section described the removed `{ok, concerns,
  summary}` verify verdict; it now documents the `bullswarm.workflow.evidence.v2`
  envelope the kernel actually enforces. `AGENTS.md` doctrine item 5 pointed at
  the deleted `runtime.js` and now points at `v2-dispatch.js`.

- Historical authored-graph runs stay readable, read-only, and nothing tries to
  drive them. A run directory whose `state.json` lacks
  `schemaVersion: 'bullswarm.workflow.state.v2'` is a legacy run: `workflow runs`
  (with `--all` and `--json`) lists it as one row — short id, run id, name or
  goal, status, age — marked `legacy`, reading only those five fields and never
  throwing on a missing one, and the workflow home lists the same row. Every
  driving command — `runs show`, `runs result`, `watch`, `cancel`, `resume`,
  `steer`, `action show`, `tui <runId>` — prints exactly one line, `legacy
  authored-graph run <shortId>: its executor was removed in 0.27.0; files remain
  under <dir>`, and exits 2 before touching anything; the workflow home shows
  that same line in its detail pane. `events <runId>` still replays the durable
  JSONL and `runs delete <id> --yes` still removes the directory. Historical
  directories are never modified. The stale-owner reconciliation that used to
  run before every dispatch is gone with the V1 liveness model it served.

- Tests: 818 -> 652. Six V1-only files were deleted
  (`workflow-adaptive`, `workflow-gaps`, `workflow-draft`, `workflow-schema`,
  `workflow-validate`, `workflow-run` — 151 tests); `workflow-runs`,
  `workflow-watch`, `assignments`, `workflow-interruption`, `workflow-steering`
  and `workflow-goal` were rewritten onto the V2 kernel keeping every assertion
  about shared behaviour; `workflow-dashboard` dropped its 19 V1-only cases; and
  a new `workflow-legacy-runs` (10 tests) proves the legacy contract against a
  synthetic legacy `state.json`. `tests/manual-dynamic-real.mjs` (330 lines), a
  manual real-provider matrix for authored `run`/`decide` graphs, went with the
  executor; it was never part of the suite count. No test dispatches a real
  provider.

## 0.26.0 — two entry points, kinds and rungs

- There are now exactly two ways to start work, and `bullswarm delegate` is
  gone. `delegate` existed to decide, on the caller's behalf, whether a request
  needed one agent or a workflow — with `--mode auto` it spent a real
  analyze-lane dispatch on a deterministic-then-LLM classifier before doing any
  of the actual work. The calling agent already knows the shape of its own
  request, so that round trip bought latency and quota, not accuracy. `bullswarm
  run` is the single-agent entry point and `bullswarm workflow goal` is the
  workflow entry point; `bullswarm --help` names those two, in that order, and
  `bullswarm delegate` now exits 2 with the standard unknown-verb message and
  dispatches nothing. The packaged skill and the awareness block registered into
  Codex, Claude, and Grok say the same thing in six lines: decide the shape
  yourself, there is no preview step.

- `bullswarm run --lane analyze` now defaults to `medium` effort instead of
  `high`. The V2 validator has always defaulted an analyze action to medium, so
  the same lane meant a different tier depending on which entry point you used.
  `run` and the validator now read one exported `DEFAULT_EFFORT_BY_LANE` table,
  and `run --help` states the corrected default.

- Program actions can now say what they *are* instead of restating how to route
  them. The optional `kind` field takes one of seven values — `mechanical`,
  `io-read`, `check`, `implement`, `integration`, `architecture`,
  `adversarial-acceptance` — and derives `lane` and `effort` from a table
  exported alongside the existing per-lane default. Resolution is per field: an
  explicit action field wins, then the kind table, then a new optional
  program-level `defaults` object (`effort` and `reasoning` only), then the lane
  default. A kind outside the closed list is a validation error with the allowed
  values named, because it is a typo in the program rather than a runtime
  condition. Programs that use neither `kind` nor `defaults` and state
  `lane` and `effort` on every action normalise byte-identically to before;
  `effort` itself is now optional and falls back to the per-lane default
  where it used to be rejected as missing.

- Two non-blocking advisories, never rejections. `all-writers-high` fires when
  three or more build/chore actions run and none is below high effort;
  `docs-at-high` fires when a build/chore action owns only `*.md` files at high
  effort. `workflow plan validate --json` carries them as `advisories` and the
  human output prints `advisory:` lines; `workflow goal --program` prints the
  same lines at launch. Neither changes acceptance or an exit code. The kernel
  records them on the run, and `workflow runs show` lists them.

- `workflow runs result`, `runs show`, and `action show` print `kind` next to
  lane and effort when an action has one. `workflow action show` now understands
  autonomous V2 runs at all — it previously read only the V1 action ledger and
  failed on every V2 run.

- **Rungs: one pool's model plus its reasoning level, for one effort tier, read
  and written as one thing.** `bullswarm strategy rungs [--json] [--pool <name>]`
  prints one row per enabled pool and configured tier with the effective model
  and its source, the effective reasoning level and the layer that chose it, the
  dated Epoch benchmark evidence for that model *at that level* (`blended`, cost
  per task, tokens per task), and the local record from the decision log for that
  pool and tier (dispatches, median wall minutes, ok share). Absent evidence
  prints `no evidence` and an unmeasured tier prints `no dispatches`; neither is
  ever estimated. `strategy inventory --json` gained the same rows under `rungs`.

- `bullswarm strategy set-rung <pool> <tier> --model <model> [--reasoning <level>]
  [--force]` writes both halves of a rung in one atomic state save, so the model
  and the thinking depth can never land separately. A rung is singular per pool
  and tier: the tier moves off whichever model held it, and that model keeps its
  other tiers. A level the connector cannot express is clamped to the strongest
  it accepts and the clamp is printed. An unknown pool or tier exits 2; a model
  absent from the pool's cached discovery exits 2 and lists the known models
  unless `--force` is given. Neither `rungs` nor `set-rung` ever spawns model
  discovery. No state migration: rungs are a projection of `strategy.modelTiers`
  and `strategy.reasoning`, and `~/.bullswarm/state.json` gained no keys.

- The setup wizard's tier step now shows each suggested rung with its benchmark
  evidence line and asks one reasoning question per configured tier. **Behavior
  change:** Enter keeps that connector's own per-tier default and writes nothing,
  where the previous question stored a suggested level (`xhigh`/`high`/`medium`)
  on a blank answer. Connector defaults remain the final fallback, so a pool with
  no configured rung behaves exactly as before. Non-TTY and `--yes` paths are
  unchanged.

- A dated evidence datapack per model *and reasoning level*, from Epoch AI.
  `data/epoch-benchmarks.json` (schema `bullswarm.epoch.benchmarks.v1`) is built
  by the new `scripts/refresh-epoch-benchmarks.mjs` from Epoch's cursorbench,
  deepswe, arc-agi-2, and critpt exports, and `src/lib/epoch-benchmarks.js`
  reads it with the same cache → bundled → URL fallback as the OpenRouter pack.
  `rungEvidence()` returns the mean of whichever of those four scores exist for a
  (model, level) pair as `blended`, with cost and tokens per task from
  cursorbench; `normalizeModelId()` is how connector model ids match the export.
  The data is used under CC BY 4.0 — Epoch AI, 'AI Benchmarking Hub'. Published
  online at epoch.ai. Retrieved from https://epoch.ai/benchmarks.

- The daily refresh job is renamed `.github/workflows/refresh-benchmarks.yml` and
  now refreshes both assets on the rolling `benchmark-data-latest` release: it
  downloads and unzips Epoch's public export, runs the script, runs the new
  tests, and uploads `epoch-benchmarks.json` next to `openrouter-benchmarks.json`.
  The ambiguous `npm run refresh:benchmarks` script is split into
  `refresh:openrouter` and `refresh:epoch`, since only one of the two now
  refreshes "the benchmarks".

- The OpenRouter builder is unchanged, and that is a finding rather than an
  omission: the Artificial Analysis records in the 2026-09-08 capture carry only
  `agentic_index`, `coding_index`, and `intelligence_index` per model, with no
  reasoning-effort marker on any of the `reasoning_effort`, `effort`, `variant`,
  `reasoning`, or `reasoning_level` fields checked, so there is no per-effort row
  to keep. `data/README.md` records the field names inspected.

## 0.25.5 — forecast-aware routing

- Bullswarm now knows what it is already running. Every dispatch registers the
  work it starts in a small ledger on disk (`~/.bullswarm/assignments/`, one
  atomically written file per assignment), and every process reads it: a
  `bullswarm run` in one terminal, a V1 runtime and four concurrent V2 kernel
  actions all see each other's agents instead of each assuming the pool is
  idle. Records whose process is gone, or that are older than 12 hours, are
  pruned on read, so a crash cannot leave phantom load behind. `bullswarm
  assignments` lists what is in flight right now — pool, run, action, how long
  it has been going and how much longer it is expected to take — and
  `bullswarm pools` carries the same count as `inflight=<n>`.

- A spend model turns those records into percentage points. It measures how
  fast a pool actually burns its 5-hour and weekly windows by pairing meter
  readings with the worker-minutes dispatched between them, and how long an
  assignment on a given lane and effort tier usually runs by taking the median
  of real attempts from the decision log. Every number carries its basis —
  `history` (measured), `bootstrap` (one window's usage so far), or the
  documented `default` table — and the sample count behind it. A pool nobody
  has measured reports `null`, never a plausible-looking guess.

- Routing now decides on the forecast instead of on the last reading. Each
  pool's projection (reading + what its in-flight agents will still spend) gets
  the expected consumption of the assignment being routed added on top, and the
  existing thresholds apply to that number: a pool projected at or above 75% of
  its 5-hour window drops to the near-limit tier while its reading is still
  below the line, and one projected at or above 90% is dropped from selection
  as forecast-gated. Nothing is gated on an unknown forecast, and if every
  capable pool is gated, the least loaded of them is still picked — with the
  reason saying exactly that — rather than the action being stranded.

- Parallel work now spreads instead of stacking. Within a tier, a pool's pace
  surplus is reduced by the weekly quota its in-flight agents and this
  assignment are expected to spend, and by at least a flat 3 surplus points
  per in-flight agent (`DEFAULT_INFLIGHT_PENALTY_PCT`, `config.inflightPenaltyPct`
  in state.json, `0` disables it). The floor matters: at measured weekly rates
  a six-minute agent projects to under one point, which would leave a burst on
  one pool. The charge is labeled `penalty` when the floor set it and by its
  measured basis otherwise. Load also beats incumbency: an incumbent carrying
  more in-flight agents than a challenger keeps neither its margin nor its cost
  guard. Four actions launched within the same second land on
  four different providers rather than all on the single most-behind one, and
  the V2 kernel re-reads the ledger before every pick rather than only on its
  throttled meter refresh, so actions launched seconds apart still see each
  other.

- Everything that observes routing shows the new numbers. `bullswarm
  assignments [--json]` is a new command listing the live ledger; `bullswarm
  pools` gained an `inflight=<n>` column and prints its 5-hour cell as
  `5h=<reading>%-><projected>%` when in-flight work is expected to move it,
  with `spend`, `projectedFiveHourPct` and `projectedWeeklyPct` in `--json`;
  `bullswarm run --dry-run` prints the forecast the pick was made on and, being
  a preview, still registers nothing and writes no decision log; and the
  strategy control center shows each provider's in-flight count next to its
  usage. Live meter readings are now retained as a capped per-pool series at
  `~/.bullswarm/meters/history/<pool>.jsonl`, because the snapshot cache keeps
  only the newest reading and a rate needs two.

- A rate is only reported once the dispatch behind it is real: at least five
  worker-minutes must be attributable to a window before its utilization
  counts as percentage-points-per-minute. Without that floor a pool at 26% of
  its 5-hour window with one six-second-old agent measures as 260% per minute
  and forecasts every provider past the burst line, which is the failure this
  model exists to prevent rather than cause.

- All of it is visible after the fact. The routing reason names the in-flight
  counts and projections that moved the pick (`5h used 30% -> 41% projected, 2
  in flight`, `skipped near 5h limit (projected): acme 76%`, `forecast-gated
  at/above 90%: …`, `preferred over busier: …`), every candidate row carries
  `pace`, `effectiveSurplus`, `inflight`, `projectedFiveHourPct`,
  `forecastFiveHourPct`, `projectedWeeklyPct`, `ratePerMinute`,
  `estimateSource` and `forecastGated`, and the decision log records the
  forecast the pick was made on. Pools that carry no ledger or spend fields
  route exactly as they did before.

## 0.25.4 — reasoning levels

- A connector now declares how its own CLI expresses a thinking level, and
  every dispatch resolves exactly one level per attempt. The block is
  `reasoning: { flag | args, levels, defaults, skipModels? }` — `flag` for a
  CLI that takes `--effort <level>`, `args` for one whose control is a config
  override (`-c model_reasoning_effort={level}`). The packaged `claude-code`,
  `codex`, `grok`, and `command-code` templates carry the block read from
  their installed CLIs or an official source (Claude Code and Command Code from
  `--help`, Codex from its config reference, Grok from the binary's own
  validation message); Command Code's model-dependent set stays marked
  UNVERIFIED rather than invented. One shared resolver applies the precedence
  chain — the action's own `reasoning` field, the run-wide override, the
  configured `strategy.reasoning` level for that pool and tier, the same for
  the tier globally, then the connector's default for the effort tier — so
  the first layer that sets a level wins, not the strongest. The level is
  appended to the spawned command exactly as `--model` is appended today;
  nothing is appended for a connector with no block, for the literal level
  `default`, or for a model the connector marks under `skipModels`. A level
  the connector does not accept is clamped to the nearest one it does, never
  dropped and never invented. `{ requested, applied, source, clamped }` is
  recorded on every attempt, in the decision log, in `bullswarm run --json`,
  in the V2 result envelope, and in the new `bullswarm run --dry-run` command
  preview — which builds its argv through the same builder that spawns, so
  preview and dispatch cannot drift.

- `bullswarm setup` asks one reasoning level per effort tier (suggesting
  high=xhigh, medium=high, low=medium, with `default` always offered to leave
  a worker CLI's own setting untouched) and stores the answers under
  `state.strategy.reasoning`. Agents configure the same thing without a
  terminal: `bullswarm strategy set-reasoning --tier <high|medium|low> --level
  <low|medium|high|xhigh|max|default> [--pool <name>] --yes`, `bullswarm
  strategy reset-reasoning [--tier ..] [--pool ..] --yes`, and a `reasoning`
  section in `strategy configure --file <json> --yes` whose invalidity rejects
  the whole document. `bullswarm strategy inventory --json` reports the
  configured levels and, through the resolver dispatch itself uses, the
  effective level and its source for every pool and tier. Installed home
  connectors receive the packaged `reasoning` block additively on upgrade, and
  a block the user has customized is never overwritten.

- A V2 program action accepts an optional `reasoning` field
  (`low|medium|high|xhigh|max|default`) that the calling agent or the
  Workflow Planner can set and that outranks every configured level for that
  one action; `workflow plan contract` documents the field and echoes the
  run-wide levels a launch would apply. `workflow goal` takes
  `--worker-reasoning <level>` for every non-planner dispatch and
  `--planner-reasoning <level>` for a dispatched Workflow Planner, and
  `bullswarm run` takes `--reasoning <level>`; a level off the scale is a
  usage error that launches nothing. The applied level appears next to the
  model in `workflow runs show` (text and `--json`), `workflow runs result
  --json`, the TUI attempt rows and agent pane, so a run that thought more
  cheaply than asked is visible rather than inferred.

## 0.25.3 — usage-limit recovery and headroom-aware routing

- A provider that reports a usage limit is now its own mechanical failure kind,
  `quota` — never `process`, `semantic`, or `auth`. The attempt is killed at
  once instead of waiting out a CLI that printed its limit and then hung, and
  the pool is quarantined until the reset the message named, falling back to
  that pool's cached 5-hour `resets_at` and then to 30 minutes rather than the
  flat 10. The quarantine record carries `kind: 'quota'` and excludes the pool
  from every later dispatch, in that run and in others, until it expires; the
  action moves to another pool with quota and is never retried on the one that
  hit the limit. `bullswarm run`, the V1 runtime, and V2 dispatch all apply the
  same deadline. Detection is shape-gated: an agent report that discusses usage
  limits, or tool output quoting them, is not a limit, and phrases that other
  services also emit (`rate limited`, `too many requests`, `quota exceeded`)
  count only as a bare notice, never as narration about someone else's quota
  ("rate limited by the GitHub API, retrying"). Connectors declare their
  own phrases under `quotaSignatures`; installed connectors receive new ones on
  upgrade.

- Routing avoids pools that are close to their 5-hour limit. A pool at or above
  `FIVE_HOUR_NEAR_LIMIT_PCT` (75) is chosen only when no eligible pool below it
  exists for the lane, ahead of pace, an approved assignment, and incumbency;
  pools at or above 90 stay excluded outright, and a pool with no 5-hour
  reading counts as having headroom. Routing reasons and candidate lists name
  the utilization that decided the pick, and `bullswarm pools` shows it as
  `5h=<n>%` with a `NEAR-5H-LIMIT` label. Meters and quarantines are re-read
  from the meter cache and core state before every action dispatch and before
  every retry inside one — forced live right after a usage limit — so a long
  run no longer dispatches from the pool snapshot frozen at launch.

- `workflow watch` reports a usage-limit retry as a notable event in both
  modes' vocabulary: `⚠ <action> usage limit on <pool> · paused until
  <deadline> · retrying on another pool`, then `↺ <action> now on <pool> ·
  <model>` once the retry lands. Both print without `--verbose`, wake `--next`,
  and appear in `--jsonl` as `attempt.quota` and `attempt.moved`. The new
  `--classic` flag forces the older heartbeat-based watcher (transition-on-change
  snapshots plus a periodic heartbeat, 60 seconds unless `--heartbeat <seconds>`
  is given) for a V2 run; it is a no-op for legacy runs and cannot combine with
  `--next`.

## 0.25.2 — event-based watch

- `workflow watch <run> --next` is safe to relaunch after every wake-up: each
  such exit prints `next: bullswarm workflow watch <id> --next --after <seq>
  --since <time>`; relaunching with those values replays notable events that
  landed while no watcher was attached, reports a level at most once, and does
  not repeat a stall already reported (its recovery line still prints). `--jsonl`
  objects carry `sequence`.

- `workflow watch` for V2 runs is event-based by default: one attach line,
  then one line per notable event (action finished/failed/blocked/cancelled,
  evidence, stage completion, planner turn, stall/recovery, cancellation)
  and silence while work is merely in progress. `--next` prints no attach
  line and exits after the first notable event (0 while the run continues or
  delivered, 1 when it ended without delivering or the kernel is not
  running). `--stall-after <seconds>` (default 300) reports a silent running
  agent; `--heartbeat <seconds>` is opt-in for V2 (legacy still defaults to
  60s). `--jsonl` emits one object per event with a stable `type`. Agent
  starts, mechanical retries, and steering delivery remain `--verbose` only.
  `--once` and legacy (non-V2) transition-plus-heartbeat output are
  unchanged.

## 0.25.0 — shared programs that finish with the graph

- New goal workflows share the target worktree by default. File territories
  guide scheduling; newly created files and edits survive worker failure or
  cancellation. Use `--isolation` for strict per-worker worktrees and exact-file
  ownership. Saved older runs keep their original execution policy.
- Independent actions run concurrently, and dependents start as soon as their
  own inputs finish. An unrestricted integrator (`build`, empty `ownedFiles`)
  runs alone after its writers and can reconcile shared files.
- Programs finish when their graph finishes, without automatic gap-planning
  rounds. `completed` describes execution; `verified` separately records
  passing requirement evidence. Negative evidence stays visible, and further
  repairs use explicitly authored programs.
- Unexpected worker errors become action failures; independent branches keep
  running. Quiet workers retain a kernel heartbeat, dead kernels are identified
  in the TUI, and resume preserves durable successes and published results.
- Cancellation intent survives concurrent kernel writes. Resume uses a kernel
  lease and tracks delegate process groups; SIGTERM/SIGINT produce a resumable
  interruption, and surviving delegates are drained before replacement work.
  Durable completion receipts recover both successful worker output and partial
  isolated integration without replaying the worker.
- Failed/interrupted isolated workspaces are retained, conflicting user edits
  block integration, and submodule file trees no longer break manifest capture.
- Program dashboards show dependency levels instead of keyword-inferred phases,
  including for saved runs. Independent levels can overlap as actions become ready.
- Plain dependencies no longer need artificial artifact declarations. Evidence
  prompts can inspect product JSON/output formats without being mistaken for
  instructions to replace the kernel's verdict format.
- The agent skill now presents one short choose → plan → launch → inspect flow,
  with advanced operations in a separate reference. It distinguishes a planning
  contract from a launch and passing evidence from guaranteed correctness.
- Isolated ownership checks exclude dependency trees at every depth and handle
  literal filenames containing glob metacharacters.

## 0.24.0 — the calling agent is the Workflow Planner

**BREAKING.** `bullswarm workflow goal` now needs a program. Add
`--orchestrator auto` to any existing invocation to keep the previous
behaviour, or pass the program you authored with `--program <file.json>`.

- **Caller-first by default.** `workflow goal "<goal>"` with no
  `--program`, `--scout`, or `--orchestrator` exits 2, launches nothing, and
  prints the commands that come next (`{"error": "program-required", "next":
  {contract, validate, launch, scout, orchestrator}}` under `--json`). The
  kernel never plans on the caller's behalf unless the caller asks for it by
  name. Exit codes are a contract: 0 done or paused durably for the caller
  (nothing running), 1 the run ended without completing, 2 usage or validation
  error with nothing launched.

- `bullswarm workflow goal --program <file.json>` makes the invoking agent the
  Workflow Planner. The kernel validates the caller-authored V2 program against
  the exact requirement ledger before anything launches, executes it with zero
  planner and (by default) zero scout dispatches, and keeps every kernel-owned
  guarantee: quota routing, isolated worktrees and changed-path ownership,
  independent evidence, the requirement ledger, completion, and the stable
  result envelope. This is Bullswarm's equivalent of Claude Code's `Workflow`
  tool: the frontier model writes the program once and is consulted again only
  at a real planning boundary. `--scout` alone has the kernel survey the
  repository first and pause at the initial boundary for the caller's program.

- **Flag surface.** `--planner dispatched|caller` is removed; the presence of
  `--orchestrator auto|<pool>` is the switch. `--strict-orchestrator <pool>`
  becomes `--orchestrator <pool> --orchestrator-strict` and remains as a
  deprecated alias for one release. `--suggested-plan`, `--no-scout`,
  `--orchestrator-model`, and `--orchestrator-strict` are rejected without
  `--orchestrator`: when the caller is the planner, the plan is the program.

- **New commands.** `workflow plan validate "<goal>" --program <file>` dry-runs
  a program against the contract (same validator, same preview state, no run
  created) and exits 0 with the accepted actions or 2 with the issues.
  `workflow cancel <runId>` is a first-class verb that finalizes a run paused
  for its caller planner inline, and `workflow resume <runId>` is the verb form
  of `goal --resume`; `goal --resume` and `tui --cancel` remain as aliases.

- **`delegate`.** For workflow-shaped work it now returns the planning contract
  (`action: "plan-required"`) plus the exact launch line, instead of launching
  an orchestrated run on the caller's behalf. `--orchestrator auto|<pool>`
  passes through for callers that do not want to plan.

- **Requirement granularity is surfaced, never forced.** When a goal collapses
  to a single requirement, `plan contract` adds an `advice.requirements` line
  and `delegate` adds the same text to its `handoff` (printed as
  `Requirements ·`): one requirement means one pass/fail verdict for the whole
  goal, and any gap reopens all of it, so numbering distinct deliverables
  (`1. ... 2. ...`) buys a tracked requirement, a separate verdict, and gap
  rounds scoped to the part that failed. A goal that already splits into
  several requirements never carries the advice, and the text says explicitly
  not to invent clauses to split a genuinely holistic outcome.

- New `bullswarm workflow plan` surface: `plan contract "<goal>"` prints the
  requirement IDs the kernel will derive, the planning rules, the generic action
  fields, the validation it enforces, and a worked example; `plan show <run>`
  prints the durable planner request a paused run left behind (boundary,
  context, consolidated gaps, known actions); `plan submit <run> --program
  <file>` (or `--exhausted --reason <text>`) validates the response against the
  exact durable state, records it as the next program revision with the same
  counters a dispatched planner turn would produce (planner turn, expansion
  round, program revision) plus a `planner.finished` event tagged
  `source: "caller"` (no `planner.started` and no planner attempt is recorded,
  because nothing was dispatched), and relaunches the kernel.

- Caller-planner pauses are authoritative and lossless. A resume without a
  submission re-pauses on the same boundary and turn, even when steering was
  queued meanwhile: the request is refreshed to list the pending steering
  (`pendingSteering`), `plan show` does the same refresh, and a submission
  marks exactly the listed steering delivered; steering queued after that stays
  pending and opens a steering boundary after the resume. A cancellation
  requested while paused refuses every submission and `plan show`, `watch`, and
  the TUI point at the one `workflow goal --resume` that finalizes the
  cancelled result; finalizing always clears the pause record, and the state
  validator rejects a terminal run that still claims to be waiting. A caller
  program supplied at launch is kept in the run directory until applied, so an
  interruption during an opt-in scout does not lose it. Bare value flags
  (`--program` with no file) are usage errors instead of a silent
  dispatched-mode launch, and `plan submit` checks the goal directory before
  touching state.

- Caller-planner runs pause durably instead of dispatching: at a planning
  boundary the kernel writes `planner-request-turn-N.json`, records
  `planner.awaiting` in state, emits `planner.awaiting_caller`, sets the run to
  `waiting`, and exits. `workflow watch` ends at that pause (exit 0) and prints
  the `plan show` command; `runs result` and the TUI Next line explain the
  pause; resuming without a submission re-pauses on the same request. An
  invalid initial program supplied through `--program` at launch is rejected
  synchronously; one that fails only against live state pauses with a
  correction request instead of dispatching anything.

- The dispatched planner prompt and the caller-facing contract now render from
  one shared rulebook (`v2PlannerContractRules`), so the two planning modes
  cannot drift. A durable `exhausted` planner decision now survives resume: the
  kernel finalizes the partial result instead of reopening the boundary.

- `workflow capabilities` reports `plannerModes` and the `callerPlanner`
  feature; the `bullswarm` skill and operations reference document the
  caller-planner loop for frontier agents.

- Fixed (ledger): evidence records now carry the ledger-wide `workspaceRevision`
  they inspected, and semantic evidence recorded on a newer workspace
  supersedes older evidence for the same requirement (`stale: true`,
  `staleReason: "workspace-superseded"`). Before, a cross-cutting requirement
  such as "the full suite passes 19/19" kept its first failed verdict alive
  forever, because no work action listed it in `affects`; a later passing
  verdict then conflicted with it and the requirement stayed `blocked` on every
  gap round. Same-workspace disagreement between two verifiers still blocks,
  and a mechanical (pending) record never supersedes a judgment. Found live
  while driving a caller-planner run.

- Fixed: a one-line goal with inline numbered clauses (`"1. Fix the parser.
  2. Update the docs."`) produced a single requirement; only the
  newline-separated form split. Both forms now yield one requirement per
  clause, so `plan contract` advertises the IDs the run will enforce. Inline
  markers are honored only when the list starts at 1, so prose such as
  "version 2. Then" is not split.

## 0.22.1 — unified workflow dashboard navigation

- The workflow dashboard now keeps V2 runs in the unified list and timeline
  shell on both desktop and narrow terminals, with stable mobile borders and
  the same phase-segmented timeline for current and historical runs.

- Timeline phases are numbered and presented in declared program order, so
  parallel workers finishing out of order cannot place Phase 2 above Phase 1.
  Preflight is selectable and opens the Workflow Planner; Up and Down move
  through Preflight, Phase 1, Phase 2, and later phases, while Enter or Right
  opens the selected planner or phase agents.

## 0.22.0 — autonomous Dynamic Workflow V2

- Autonomous goals now run on the V2 kernel: agents propose bounded programs
  and requirement-scoped evidence, while Bullswarm deterministically owns
  proposal validation, scheduling, workspace ownership, retries, the evidence
  ledger, completion, and the stable result envelope. Retired autonomous V1
  runs are intentionally not migrated; authored graph workflows remain a
  separate supported engine.

- Worker and evidence contracts now use durable candidate files plus local
  schema validators, preventing malformed agent output from entering workflow
  state. Public V2 results are atomically published, recoverable after an
  interrupted terminal write, deeply validated when read, and expose only a
  stable failure summary shape.

- The interactive workflow application now combines the workflow list and
  responsive run browser. Its main view presents a phase-aware timeline,
  Workflow Planner milestones, live workers with their latest streamed event,
  and a concise next action; technical prompts, sessions, usage, and artifact
  paths remain available on demand. Narrow/mobile terminals use the same
  hierarchy without requiring a separate command surface.

- `bullswarm run --heartbeat` and the default workflow watch provide compact,
  interval-based progress instead of streaming raw agent output. Rich help and
  the packaged agent skill document how to inspect, watch, browse, and obtain a
  stable terminal result.

- Autonomous V2 `maxAgents`, `maxActions`, and `maxExpansionRounds` are now
  soft planning targets instead of hard termination or proposal-rejection
  limits. The planner sees usage and remaining-target signals and is urged to
  consolidate optional work, while the kernel continues the smallest essential
  program past a target. `concurrency` remains an execution bound on
  simultaneous work, not on the total program size.

- OpenCode event-stream failures are now classified as transient provider
  interruptions before structured-output validation runs. A recoverable
  transport or schema attempt is recorded as `interrupted` while Bullswarm
  performs its bounded mechanical retry; only an unrecovered final attempt is
  recorded as `failed`, keeping provider instability distinct from agent work
  rejection.

## 0.21.0 — unified TUI shell and LLM-first delegation

- The interactive workflow viewer is now one application shell instead of
  several screens with their own rules. The workflows list, a run, a phase and
  an agent are four depths of one hierarchy: every screen carries the same
  persistent breadcrumb at the top (`Workflows › hdtdxs · timeline-segments ›
  Verify › verify-renderer`), which drops its deepest segments first when the
  terminal is too narrow to hold the whole path. All four depths share key
  bindings generated from a single key-map definition: Up/Down (or k/j) move
  within the current level, Enter and Right (or l) go one level in, Esc and
  Left (or h) go one level out, and Tab/Shift+Tab jump to the next or previous
  workflow, re-entering the sibling at the same depth when the equivalent phase
  exists. The drill-down layout is uniform too — a left sidebar listing the
  current level beside a right pane previewing the highlighted item — at every
  depth and on narrow terminals as well, including the run list, which was a
  full-width table with no preview pane before.

- Workflow timelines now render in phase-segmented sections with continued
  headers for interleaved phases, grouped Preflight scout/planner milestones,
  elapsed or running phase state, and consistent desktop, narrow, and scroll
  continuation behavior without per-line phase prefixes. Phase-completion
  summary rows are retained, so rows such as `└─✓ completed 4/4` remain visible
  beneath their phase headers.

- Non-interactive `workflow tui <run-id>` output now includes the same static
  segmented timeline as the interactive viewer, alongside the historical detail
  tree, so real command output can be used to inspect and verify the layout.

- Documentation now describes concerns as an attribute of a completed
  outcome — `outcome.concerns` on a delivered result — rather than
  presenting `completed_with_concerns` as its own terminal status to handle
  separately from `completed`. Run records that carry the
  `completed_with_concerns` status value, including legacy runs recorded
  before this framing, remain fully readable: `runs result`, the TUI, and
  `workflow watch` still read it exactly like `completed` — a delivered
  result with concerns to review, never a failure.

- Delegation classification now starts with deterministic signals and, in
  automatic execution, lets an LLM refine the choice between a single delegate
  and a workflow. `--dry-run` performs that same bounded low-effort
  classification request (one analyze-lane, low-effort dispatch) before
  printing the plan, so the preview matches what a live run would decide — it
  never dispatches the work itself. `--classify deterministic` bypasses that
  refinement and remains the instant, no-dispatch preview; `--classify llm`
  requires the refinement and fails if no usable LLM decision is available.
  An explicit `--mode single|workflow` remains the caller's choice and bypasses
  automatic LLM classification.

- OpenCode connector portability: `connectors/opencode2.json` no longer
  hardcodes `--model relay/gpt-5.6-luna` in `spawn.cmd`. A plain OpenCode
  install with no Relay provider configured now dispatches with OpenCode's
  own default model instead of failing to resolve a Relay-only model.
  `src/lib/opencode-relay.js` still injects the explicit
  `--model <providerId>/gpt-5.6-luna` for each discovered Relay provider, so
  the primary `opencode2` pool and any extra `opencode2:<id>` pools keep
  dispatching with their pinned per-provider model exactly as before.

## 0.20.0 — common agent delegation entry point

- `/bullswarm` and `bullswarm delegate` now give agents one transparent entry
  point for arbitrary self-contained tasks: classify the request as one bounded
  delegate or an autonomous workflow, show the reason and conceptual plan, then
  execute the selected engine. Explicit mode and lane overrides remain
  available, and `--dry-run --json` exposes the decision after its bounded
  classification request without dispatching the work itself.
- Workflow decisions persist the suggested conceptual plan alongside the
  original intent, while the packaged skill keeps the common path concise and
  moves operational detail into a focused reference.
- Planner context now labels the preflight scout as completion-ineligible and
  requires the first program to contain a real delivery worker plus its
  verifier, preventing an apparently complete scout report from causing a
  rejected completion and redundant recovery round.
- Ready siblings now honor a connector-owned soft concurrency preference. The
  OpenCode route prefers one in-flight worker, so additional parallel work is
  spread across healthy subscriptions instead of risking correlated headless
  session exits; a lone eligible pool still runs rather than failing capacity.
- Agent integration upgrades its managed awareness marker to advertise the
  common interface consistently across Codex, Claude, and Grok.
- Classification now understands negated and instructional mutation language,
  so read-only requests that discuss how to add or write something do not
  accidentally enter the build lane, while a later affirmative implementation
  request still does.
- A trailing `help` token remains contextual and side-effect-free even after
  options, matching `-h` and `--help`; several README and setup/help examples
  were also brought back into sync with the real CLI.
- Historical workflow design documents now identify themselves as dated
  implementation records and list the current `verify`, `decide`, and
  `outputSchema` surfaces instead of presenting resolved gaps as current.
- Extra Relay providers in `~/.config/opencode/opencode.json` (`relay-2`, …)
  become `opencode2:<id>` pools, spawned with `--model <id>/gpt-5.6-luna`.
  Spend is read from `GET /api/usage/token` plus
  `/v1/dashboard/billing/usage` (USD = `total_usage / 100`). The HTML wallet
  page still needs a browser session and is not the key API.

## 0.19.0 — unified workflow dashboard

- Running `bullswarm workflow` on an interactive terminal now opens one
  full-screen home for active and recent runs, with filtering, safe detach,
  and direct navigation into each workflow's timeline, planner, phases,
  agents, and activity.
- Wide terminals pair the run list with a live selected-run preview. Narrow
  phone and SSH terminals use a full-width stacked list before opening the
  selected workflow, preserving readable navigation without duplicating the
  desktop layout.
- Non-interactive callers still receive side-effect-free help, existing JSON
  contracts remain stable, and `workflow tui` remains a compatibility alias.
- Exact-height mobile repainting now preserves the footer while retaining the
  no-flash in-place refresh behavior.

## 0.18.5 — no-flash workflow TUI

- Full-screen workflow views repaint rows in place instead of repeatedly
  clearing the terminal, removing the visible flash on slower mobile and SSH
  sessions.

## 0.18.4 — reliable auto-follow tail

- Timestamp-aligned mobile auto-follow now preserves the newest workflow
  milestone instead of replacing it with a spurious newer-rows marker.

## 0.18.3 — mobile timeline polish

- Auto-follow now begins at a timestamped milestone instead of exposing an
  orphaned detail line when a long timeline is clipped on a small terminal.
- Qualified terminal runs state the number of concerns and direct the user to
  review them in the result envelope.

## 0.18.2 — truthful recovery timeline and verifier cleanup

- Dependency-blocked plan branches now appear as a single skipped phase in the
  workflow timeline instead of several failed agents followed by a
  contradictory completed phase.
- The Live panel ignores stale terminal agent records, and verifier retry
  cleanup now removes the retrying agent as soon as the bounded retry ends.
- Verifier verdict parsing conservatively repairs an otherwise valid JSON
  object truncated only by missing final closing brackets. Malformed content
  still fails closed, while provider truncation no longer forces an expensive
  planner recovery round.

## 0.18.1 — original-goal verification and denser timeline

- Goal workflows now derive a durable requirement ledger from the original
  user goal. Planner verify actions declare which requirements they cover, and
  neither explicit nor program-level completion is accepted until every
  requirement has a successful verifier with specific evidence. The verifier
  receives the original goal from the runtime, so a reduced planner scope can
  no longer silently omit requested APIs, events, tests, or documentation.
- Successful verifier concerns are preserved in a verified
  `completed_with_concerns` result instead of being discarded or triggering
  unnecessary follow-up spending.
- The human timeline calls its first accepted planner decision `plan created`,
  later decisions `plan updated`, and the final one `completion confirmed`.
  Execution milestones are rendered as one dense block without blank rows.
  Finished workflows now say `No agents running · workflow finished` and
  `Workflow finished · result ready` instead of control-plane terminology.

## 0.18.0 — exact routes, cheaper plans, clearer results

- `workflow goal` can now guarantee an exact planner model and a separate exact
  worker route with `--orchestrator-model`, `--worker-pool`, and
  `--worker-model`. The worker lock is runtime-owned and propagates through the
  scout, ordinary actions, fan-out items, verification repairs, reverification,
  and extraction helpers; unsupported or excluded models fail closed instead
  of silently substituting another model.
- An action-bearing planner `proceed` is normalized to the schema-equivalent
  `needs_more_work` program before validation. This removes a redundant
  correction turn without changing the proposed graph or weakening any safety
  check (the prior real run spent four frontier planner turns correcting this
  exact representation mismatch).
- `workflow runs result` now selects the latest successful verifier that
  transitively covers the delivery, so a final suite verifier depending on
  unit verifiers is surfaced ahead of a narrower direct unit check.
- The same result envelope now adds a backward-compatible `deliveries[]`
  frontier for parallel multi-worker outcomes while preserving the singular
  `delivery` field for existing callers.
- The autonomous planner now batches cheap homogeneous edits instead of paying
  for a worker and unit verifier per tiny file; substantial independent units
  still fan out and retain focused verification before the final suite.
- Narrow SSH and phone terminals now open on a full-width workflow timeline;
  `t` toggles between that overview and the phase browser without affecting the
  existing Enter/Esc agent drill-down.
- Goal-level `--orchestrator <pool>` is now a preference with immediate
  fallback when that pool is quota-gated, ineligible, or unavailable. Exact
  provider testing moves to `--strict-orchestrator <pool>`. Quota waits now
  refresh the durable runner heartbeat at least every 30 seconds, preventing a
  live waiting run from being falsely reconciled as interrupted and making
  cooperative cancellation responsive during long meter-poll intervals.

- The runtime now owns the acceptance bar for every verify and re-verify. Each
  verifier's instructions end with a fixed "Acceptance standard (runtime-owned;
  it overrides any stricter rule in the instructions above)": `ok:false` means
  the work is unusable — its acceptance command fails, a required deliverable
  is missing, or the answer is nonsense — and everything else (style, scope,
  cosmetic mismatches, process rules the goal never stated such as append-only,
  files changed by other actions in the shared tree) goes in `concerns` under
  `ok:true`. A re-verify rejects only when the work is still unusable or the
  repair broke the acceptance checks. Direction from the user after `8ebi8a`:
  "unless it is completely nonsense or unable to finish I don't see a reason to
  reject so easily".
- Repair prompts carry a runtime-owned shared-tree rule: edit only the files
  the reviewed work owns; a concern about other files is not the repair's to
  resolve; never revert, checkout or delete other actions' changes. Earned on
  `8ebi8a`: `verify-docs` rejected on a repo-wide `git diff --stat` scope check
  while siblings were writing, and its repair reverted five `src/` files it did
  not own to satisfy the concern.
- Planner contract: rule 2 requires exactly one owner per file, including any
  existing test the change breaks (the `workflow-adaptive.test.js:206` gap for
  the fourth time); rule 7 restates the lenient bar above; the validator line
  now says ids are unique across the whole run, finished and failed actions
  included (turn 2 of `8ebi8a` re-proposed the blocked id `verify-suite` and
  spent a 97 s correction turn on it).
- Goal-4 rerun on `7724da1` (`8ebi8a`, rule 7 + PR #5): 42 min 03 s, three
  planner turns (775 s, 31 %), parallelism 1.34, 23 dispatches (20 on
  `relay/gpt-5.6-luna`), three repair rounds each rejected on re-verify for
  reasons the prompts caused, tail of five actions blocked, recovery program
  auto-completed, 315/315, existing tests +179/−1. Goal-4 line:
  44 → 72 → 37 → 25 → 36 → 42 min.

## 0.17.0 — the timeline tells the execution story

- Workflow timeline (PR #5) hardened after a 16-agent adversarial review against
  real run state (23 findings, 21 confirmed): worker rows now name their phase
  (`├─✓ [Verify] verify-impl`) because concurrent phases interleave in time
  order and the tree glyph alone hung a row under the wrong phase; a phase whose
  actions never started (a blocked tail) is shown as `[Phase: X] blocked`
  instead of vanishing; the header line is truncated so widths down to 20
  columns really hold; PgUp now scrolls the timeline to earlier rows (it was a
  dead key at the newest view) and scroll state resets when the pane changes;
  below 100 columns the footer and status line no longer advertise a timeline
  the narrow layout does not render. Confirmed minors left open are listed on
  PR #5.
- Reworked the autonomous workflow TUI around a human-readable execution story:
  the existing Workflow Planner and phase sidebar now sits beside a timestamped
  timeline of completed preflight, planner, phase, and worker milestones; active
  workers and the waiting/running planner are isolated in a Live section with
  their latest normalized action and stream heartbeat, and future work stays in
  a distinct Next section. `v` keeps raw action-ledger and event evidence one key
  away without mixing it into the default view.
- Rule 7: a verify checks the goal's own acceptance criteria and never adds a
  process rule the goal does not state (append-only, existing tests
  untouched); when the implementation changes what an existing assertion
  pins, a worker must own updating it. Earned three times on goal 4 (attempt
  3, `r2vu9i`, `euh622`): the planner wrote "EXTEND BY APPENDING only" into
  the test worker and its verify while the goal said "do NOT modify existing
  tests except to extend them" and item 5 forced `programFeatures` to grow,
  so the assertion at `workflow-adaptive.test.js:206` had no owner, the
  re-verify rejected the mandated extension, and a planner turn recovered.
- Goal-4 rerun on v0.16.0 (`euh622`): 36 min 00 s, four stage phases in the TUI
  (implement, tests, verify, report) instead of sixteen one-action rows, 22/24
  dispatches on `relay/gpt-5.6-luna`, auto-completed, 319/319; two planner
  turns because of the false rejection above (planner turn 2: "an append-only
  rule that the goal itself makes unsatisfiable").

## 0.16.0 — the planner sets the width; a re-verify judges the repair

- A re-verify after a repair round now receives the concerns it raised and the
  repair's report, and may return ok:false only for an unresolved listed
  concern or a regression; anything newly noticed is informational. Earned on
  `r2vu9i`: `verify-src` round 2 rejected on two concerns round 1 never raised;
  `verify-tests-runtime` round 2 rejected the very edit its round 1 demanded.
  Live-proven on `bizp4s`: the one re-verify rejection was an `ENOENT`
  regression in the acceptance checks, and its verdict opens "the two
  original concerns are repaired".
- A phase is a pipeline stage: rule 3 now says one kebab-case name shared by
  its actions, never one phase per action, and the complete-program example
  uses five phases for eight actions (`verify` holds verify-fix, verify-tests
  and verify-suite). Earned on `bizp4s`: the planner mirrored the example and
  wrote sixteen one-action phases — no scheduling cost (phases never gate;
  `dependsOn` does), but a TUI phase list carrying no information.
- Goal-4 rerun on this release (`bizp4s`, runtime `9af8fdf`, workers on
  `relay/gpt-5.6-luna`): **25 min 13 s** (attempt 3: 44 min; 0.15.0: 72 min;
  audited contract alone: 37 min), one planner turn (247 s, 16 % of wall),
  parallelism 1.77, 3 repair rounds each fixing a real defect, 0 schema
  retries, 0 corrections, auto-completed, 319/319, existing tests +174/−0.
- Goal-4 rerun on the audited contract (`r2vu9i`): 36 min 58 s (attempt 3:
  44 min; 0.15.0: 72 min), 5 parallel writers, parallelism 1.55, tests depend
  on the implementation run rather than its verify, 0 schema retries, 0
  corrections, auto-completed, 314/314.
- Planner contract audited against Claude Code's workflow-authoring reference
  (three-lens review + adversarial verification, run on the real goal-4 task
  text) and rewritten within the same caps (rules 3,999 / examples 2,938
  chars). New in substance: a verdict is never data (depend on the run that
  wrote your files, not on its verify); split to the width the tree allows
  (one worker for N independent files is N chains in series); outputSchema
  only where a later action reads the object, never on prose; a repair edits
  files and cannot rewrite the answer under review; workers run their unit's
  focused command, never the full suite; the planner sets `lane` and `effort`
  per action. The complete-program example is now valid JSON and shows tests
  running beside the src verify. `docs/planner-prompt-audit-2026-08-29.md` §6.
- Planner-proposed `lane`/`effort`/`requiresCapabilities` now survive the
  gate defaults (`runner.js` spread order let `lane: build` overwrite every
  proposal); `lane` is validated like `effort`.
- `outputSchema` output reading tolerates a closing markdown fence after the
  trailing JSON object, and the schema instruction says the object is an
  INSTANCE whose keys are the `properties` names (never the schema itself).
  Earned on the goal-4 rerun `ydpjts` (0.15.0): a stray `"type"` key and then
  a `}\n```` tail spent the single schema retry and a 279 s planner turn on
  an otherwise complete report (≈ 11 min).
- Goal-4 rerun recorded in `docs/experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm.md`:
  0 repairs (attempt 3: 6), planner 17 % of wall (39 %), 326/326 — but 72 min
  vs 44 min because every worker landed on the slowest most-behind pool and
  the program ran serially (parallelism 1.05).

## 0.15.0 — extra Claude Code logins as separate pools

- Claude Code extra logins (`~/.claude-<slug>` / `$CLAUDE_CONFIG_DIR`) become
  their own pools (`claude-code:<slug>`), metered and spawned with
  `CLAUDE_CONFIG_DIR` set. Discovery is dynamic from the filesystem; there
  is no hardcoded extra-profile list. The spawn command for each profile is
  `CLAUDE_CONFIG_DIR=<dir> claude`.

## 0.14.1 — the TUI survives its writer; steering lands or expires truthfully

Proven on a goal-3 re-run (`d7xyg2`): 1 planner turn / 269 s (baseline 0.13.1: 1 / 294 s), planner context 6.2 k chars (from 32.7 k), auto-completed, deliverable verified, zero observation crashes — `docs/experiments/2026-08-29-dogfood-bullswarm-builds-bullswarm.md`.

- Workflow `state.json`/`report.json`/`workflow.json` writes are atomic
  (temp + rename, new `src/workflow/fsjson.js`): a concurrent reader can never
  observe a half-written file. Earned: `workflow tui` crashed with
  "Unterminated string in JSON at position 138968" parsing `state.json`
  mid-write (observed twice, 2026-08-29).
- Observation readers tolerate torn or missing JSON: the TUI keeps painting
  the last good frame of the same run, and a render or key-handler error is
  shown in the message line instead of killing the process and stranding the
  terminal in alt-screen raw mode. Mutating commands (stop, approval) retry
  the read once and then refuse loudly instead of silently dropping the
  operator's command. `runs delete` treats an unreadable `state.json` as
  ongoing (refuses without `--force`) rather than deleting a possibly-live run.
- An action being re-run (repair round, re-verify, schema retry) reads as
  `running` and its phase as `active` even when its previous round recorded
  `ok:false`; a failed mark now means failed-and-not-being-retried. (User
  report: the TUI showed ✗ "2/2 complete" beside a live spinner.)
- Pending operator steering defers program self-completion: a clean program
  with `completion: all-actions-ok` returns to the planner gate (event
  `decision.completion_deferred`), which delivers the steer — instead of
  auto-completing and silently discarding it (defect observed live:
  0 `steering.delivered` events for a queued steer). Steering that can no
  longer reach any gate is marked `expired_undelivered` with event
  `steering.expired` at the terminal transition; interrupted runs keep their
  queue for the resumed run's next gate.
- Resume re-runs an action the interruption cancelled mid-flight instead of
  re-planning around a phantom failure: cancelled actions and the dependents
  blocked only by them are reopened (event `action.reopened`) and the accepted
  program continues from where it stopped. Observed on a SIGTERM-interrupted
  run: 1 cancelled action → 4 "blocked" → a spurious planner turn.
- Planner contract: a verify with several `dependsOn` must set `review`
  (rule 4); the program's last worker must be covered by a successful verify
  (rule 8) — both were the causes of extra planner gates on the goal-3 proof
  run. A corrective turn's `validationFeedback.rejectedResponseExcerpt` is
  capped at 2 000 chars, and the rejected proposal is resent as a skeleton
  (ids, shapes, dependsOn; prompts elided) — the planner's thread already
  holds it verbatim.
- A verify without `review` is no longer grounds to reject a whole program:
  it reviews its single (or last) dependency's artifact, or audits the
  repository directly when it has no `dependsOn` (`reviewScope: repository`).
  Observed on two proof runs: a 9-action program bounced for one field,
  costing a 5-minute correction turn each time.

## 0.14.0 — structured worker output, compact planner contract

- A verify whose reply cannot be parsed as the verdict JSON gets ONE bounded
  re-ask (event `verify.verdict_retry`) before its failure can reach a planner
  boundary — observed on run `ejk9w2`: one unparseable verdict cost a full
  planner turn plus ~8 minutes of re-proving a passing state.
- Planner contract amendments from the same run's observations: a verify is
  scoped to what can be true at its point in the graph (later-scheduled work is
  not a defect; cosmetic mismatches are concerns, never ok:false); when the
  goal's acceptance checks pass the planner returns complete instead of adding
  polish actions; restored the shared-working-tree, redundant-verification,
  and operatorSteering guidance dropped by the contract merge.
- "Full" planner-context excerpts (scout, new-since-last-decision, failing
  verifies) obey the per-excerpt and total budgets again; the compaction must
  never rebuild the 163 k-char contexts it replaced.
- Planner context and contract compacted: complete emitted planner task text up to the durable-context marker, worktree-isolation suffix included **OBSERVED** `16,316 -> 5,208` characters, and a sample turn-2 durable context **COMPUTED** `163,000 -> 23,547` characters by replacing full attempt records with compact ledger rows and retaining full output excerpts only for new/scout or `ok:false` verify actions.
- Planner `run` actions and fan-out `stepTemplate`s may declare an optional
  `outputSchema`, an object-typed JSON-Schema subset. The runtime tells the
  worker to end its output with one matching JSON object, parses and validates
  it, and persists a `run` result as `outputs.<id>.data` with `schemaOk: true`;
  fan-out results store those fields inside each `outputs.<fanoutId>.items[]`
  entry. Successful validation emits `action.output_validated`.
- Schema failures emit `action.output_schema_retry` and receive exactly one
  bounded retry with the validation errors and the previous output tail. If
  that retry also fails, the action remains `ok:false`, records
  `schemaOk:false` and `schemaErrors`, and keeps the output text with the
  reason `output did not match outputSchema: <errors>`. Resumed runs do not
  re-dispatch actions already marked `schemaOk:true`.
- Dependent prompts can render `{{outputs.<id>.data.<field>}}`, and
  `fanout.itemsFrom` accepts `outputs.<id>.data.items` without an extraction
  agent when the array is already present. Planner decision validation rejects
  `outputSchema` on a proposed `verify` because verify has a fixed verdict
  shape.

## 0.13.2 — user text is never a template

- `workflow goal` failed before anything ran when the goal text quoted
  something shaped like a template ref (`{{outputs.x.data.field}}` in a goal
  *about* templates): the goal was spliced into the scout prompt and the
  workflow validator rejected the ref as unresolvable — "autonomous workflow
  invalid (nothing ran)". The goal is now a declared input (`inputs.goal`)
  inserted at render time, so nothing in user text is ever parsed.
- A grammar-valid ref with nothing behind it no longer kills the action at
  render time. It is left literally in the prompt and reported as
  `template.unresolved_ref { actionId, ref }`; planner-authored prompts may
  quote refs as text, and a worker can usually still act on the literal.
  `renderTemplate(str, scope, { strict: true })` keeps the old hard failure.

## 0.13.1 — a repaired verify counts as verification of its repair

- `completionEvidenceGaps` accepted a verify as evidence for the latest worker
  only when the verify depended on that worker. The executor's repair loop
  produces the reverse edge — `<verify>-repair-N` depends on `<verify>`, then
  the same verify re-runs — so after a clean repair round every `complete`
  was rejected with "missing a successful verification of latest worker
  <verify>-repair-1", and 0.13.0's `all-actions-ok` auto-completion would
  have been blocked the same way. Observed on goal-2 run `wf-mtdcghw0`
  (2026-08-28): three extra planner turns and one redundant verify (~11 min)
  to prove what the re-verify had already shown. A verify that ended ok:true
  after its own repair action now verifies that repair.

## 0.13.0 — programs can complete themselves

- A planner may attach `completion: { when: "all-actions-ok", reason }` to a
  program (a `needs_more_work` decision that includes at least one verify).
  When every action of that program — repairs included — finishes ok and the
  completion policy is satisfied, the runtime records the `complete` decision
  itself (`source: "program-completion"`, event `decision.auto_completed`) and
  the run ends without another planner turn. Anything failing emits
  `decision.completion_predicate_unmet` (with the failing action ids) and the
  boundary returns to the planner as before. Measured motivation: in the goal-2
  comparison every clean bullswarm run still paid a final 110–250 s planner
  turn just to say "complete"; Claude's script ends when its code says so.

## 0.12.1 — a burst-gated provider is waited for, never failed on the spot

- `workflow` runs no longer die with `no eligible pool` when every candidate
  pool is burst-gated (provider 5-hour window ≥ 90 % used). The runtime parks
  the dispatch in a new `waiting_for_quota` stage (`state.quotaWait` names the
  pool, its 5h usage and reset time; events `dispatch.waiting_for_quota`,
  `dispatch.quota_available`, `dispatch.quota_wait_expired`), re-reads the
  provider meter every 60 s, and continues the moment the gate lifts. It gives
  up — with the pool, usage and reset time in the failure reason — only after
  the known reset time plus 10 min of grace (5 h when no reset time is known).
  The planner's context is composed after the wait, so it never sees an empty
  pool list. Observed 2026-08-28 19:09 Z: the first 0.12.0 comparison run
  failed in 4 s because the account's Claude 5h window read 91 % (reset
  22:30 Z); Claude Code in the same situation waits on the rate limit.
  Options for embedding callers/tests: `quotaPollMs`, `quotaWaitGraceMs`,
  `quotaWaitUnknownResetMs` on `runWorkflow`; `readMeter` injection.

## 0.12.0 — one decision is a whole program

Completes the convergence on Claude Code's dynamic-workflow mechanics
(`docs/claude-dynamic-workflow-mechanics.md` §1.11 and §4.2): the orchestrator
is positioned as the compiler of the goal into a program the runtime runs to
the end, and it is consulted again only at the program boundary (every action
finished, or the graph blocked).

- Data-driven fan-out in proposals: a planner `fanout` may carry
  `itemsFrom: "outputs.<actionId>.outFile"` instead of inline `items`. The
  producer becomes an implicit `dependsOn` and the runtime resolves the item
  list when the producer finishes, so the planner no longer spends a round trip
  waiting to see how many items discovery found. If the producer's output has
  no parseable JSON array, the runtime runs ONE bounded, read-only extraction
  action (`<fanoutId>-items`, `source: "runtime-extraction"`) over that output
  before failing the fan-out truthfully. Resolved lists above
  `maxItemsPerExpansion` fail the fan-out with the count. Events:
  `action.items_resolved`, `action.items_extraction_requested`,
  `action.items_extracted`.
- Repair policy on verify: `repair: { prompt, maxRounds (1–3), effort? }` on a
  planner `verify`. When the verifier returns `ok:false`, the executor runs a
  fix action (`<verifyId>-repair-<n>`, `source: "repair-policy"`) carrying the
  verifier's concerns verbatim and re-runs the same verify, without a planner
  turn. Dispatch or JSON-parse failures are not repaired. Events:
  `action.repair_started`, `action.reverify_started`, `action.repaired`,
  `action.reverify_rejected`, `action.repair_failed`.
- Fan-out artifact: a fan-out now writes `out-<id>-summary-*.md` (every item's
  verdict plus an output excerpt) and records it as `outputs.<id>.outFile`, so a
  verify can depend on a fan-out directly and `review` is inferred as usual.
- Fix: fan-out outputs stored the success COUNT in `ok`, so a dynamic action
  depending on a fan-out could never become ready ("blocked by failed or
  unresolved dependencies") and a fan-out never counted as a successful worker
  for completion evidence. `ok` is now a boolean and the count moved to
  `succeeded`; `fanoutSucceededCount()` reads pre-0.12 state files.
- Fix: the content gate rejected a worker whose whole answer is a JSON array
  or object as an "announcement without substance", which is exactly what a
  discovery step is told to return. Structured answers now pass
  (`hasStructuredAnswer`).
- `parseJsonArray` prefers the trailing array, so prose containing brackets
  before the list no longer poisons `itemsFrom`.
- Planner prompt: PLANNING DOCTRINE rewritten around "you are compiling the
  goal into a program"; new data-driven fanout and repair skeletons; a
  four-action program skeleton (discover → fanout(itemsFrom) → verify(repair)
  → verify-suite); `executionConstraints.programFeatures` and
  `plannerConsultedOnlyAtProgramBoundary`. The goal orchestrator prompt is
  reframed the same way.
- Literal double braces in prompts no longer kill actions. Only a known root
  followed by dotted identifiers (`{{item}}`, `{{outputs.<id>.outFile}}`,
  `{{inputs.x}}`, `{{runId}}`, `{{wfDir}}`) is a template ref; any other
  `{{…}}` text (a JSDoc type such as `{{maxLength?: number}}`, Mustache, a JS
  object in a template literal) is left exactly as written by the renderer
  and ignored by the validator. Observed in the 0.11.1 comparison run: a
  planner-authored verify prompt containing `{{maxLength?: number}}` failed
  at render time with zero attempts. Relatedly, `verify` no longer
  template-renders the artifact it reviews: only the reviewer instructions
  are a template; the worker's report is appended verbatim.
- Doctrine: an `ok:true` verify is accepted; its concerns are informational.
  The 0.11.1 comparison run spent a whole extra program round (7 actions,
  ~10 min) polishing "non-blocking" nits reported by verifiers that had
  passed, which Claude's fix stage never does.
- Scout before compiling: `workflow goal` now starts with a read-only `scout`
  run action (tree, manifest, test status, units of work with the files each
  owns, shared files, risks; ends with a JSON array of unit names) so the
  orchestrator's first program names real files and commands — the counterpart
  of the inline scouting a Claude Code session does before authoring a
  Workflow script. `--no-scout` skips it. A failed scout is non-fatal: the
  planner still runs and sees `outputs.scout.ok=false` with the reason, and
  the scout never counts as a delivery worker.
- The planner finally sees what workers said: every `outputs.<id>` in the
  durable planner context carries `outputExcerpt` (up to 3 000 chars each,
  36 000 total, newest first) instead of only `ok`/`why`/`outFile`.
- `workflow goal` default `maxItemsPerExpansion` raised 8 → 24 so a
  data-driven fan-out over a medium repository does not fail on the bound.
- Known limitation: `itemsFrom` removes the planner turn, not the stage
  barrier. A verify that depends on a data-driven fan-out waits for all items;
  per-item verify overlap on discovered items would need chained
  `stepTemplate`s (not in this release). For known items keep proposing N fix
  + N verify chains inline, which already overlap under the ready-set
  scheduler.

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
  token/cost accounting found during the project-b battle test.
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
