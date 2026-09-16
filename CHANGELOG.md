# bullswarm changelog

## Unreleased

- routing: measured pacing rates now charge timed in-flight work at the actual
  `rate × remaining minutes` with no 3-point floor, so an expiring-soon pool
  with a known burn rate is not demoted by a tie-breaker meant for unmeasured
  pools. `config.inflightPenaltyPct` remains the per-agent fallback for pools
  without a measured rate (and for in-flight records with unknown duration).
- workflow: every attempt record now carries `routeWhy` (the router's reason)
  and `routeCandidates` (each pool's effective surplus, urgency state and
  pacing forecast at pick time); `workflow action show --json` and
  `runs result --json` print them, and older state files still load.

- routing: a pool whose pacing window is about to reset is `draining` only
  when its forecast is at or above 95% *and* ahead of the window's own clock,
  the same clock-relative shape the 5h near-limit line already has. A pool on
  or behind pace keeps spending right up to its reset instead of being ranked
  last by a fixed line (observed 2026-09-16: command-code at 94.9% used with
  98% of the month gone was passed over while +3 points of quota expired).
  The skip reason now reads `expiring but draining (forecast >= 95% and past
  its clock): <pool> <forecast>% (<elapsed>% elapsed)`.
- workflow goal: refuses to launch a duplicate of a run that is already going.
  Before anything is validated or launched, an ongoing run with the same goal
  text and cwd exits 2, naming that run's shortId, age, and watch command
  (JSON: `{"error":"duplicate-goal",...}`); `--again` starts the copy anyway
  (observed 2026-09-16: a caller whose JSON parser failed on the first
  launch's output retried five seconds later and two identical workflows ran
  side by side in the same directory).

## 0.32.0 — the dashboard is the main screen

- wording: a program run's dependency levels are called phases everywhere the
  product prints them (`Phase 2 · integrate`), matching what the planner's runs
  already say; the ids in the events are unchanged.
- dashboard: the full-screen Home, Run, Step, Usage, and Help pages now share
  a sticky header and bottom nav, keyboard shortcuts, mouse clicks, and wheel
  scrolling, so a live workflow can be understood in one place.
- usage and edit: Usage renders every meter window, elapsed mark, reset, pace,
  credit meter, and rung record with the same coloured cells as the status
  view; its read-only note hands `[edit]` to setup and returns with fresh data.
- install: Home's `[install]` action runs the same integration install as
  `bullswarm integrate install --yes`, then shows each agent's skill,
  awareness, and Claude Mod status.
- bare command: after setup, bare `bullswarm` opens the dashboard; the first
  run and `bullswarm --setup` or `bullswarm setup` open setup, while
  `bullswarm workflow tui` remains the explicit dashboard form.
- docs: the README, guides, CLI reference, and Claude Code pages now make the
  dashboard the main screen and describe the Claude Mod as its read-only
  counterpart — the same Run, Step, and Usage pages in the same colours, with
  no edit or install action.

## 0.31.0 — the Claude Mod, and a documentation site

- mod: `mods/bullswarm` puts Bullswarm inside Claude Code's own interface as a
  Claude Mod (function hooks, early access behind
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). Claude's general-purpose subagents
  are routed to the pool with spare quota through `bullswarm run --no-caller`
  and answered with the verified output; the verdict of every `bullswarm run`
  and `workflow goal` the model runs is appended to its Bash result; the pool
  meters are named in the model's context; a strip above the prompt lists
  the ongoing workflow runs; and a docked pane shows one run as
  `bullswarm workflow tui` draws it, every step a button that opens the
  step laid out as the TUI's agent panel. `/bullswarm pools|status|on|off|
  refresh|runs|pane|open <step> [run]|routed` answer from the mod; anything
  else still reaches the packaged skill. The pool rows draw a white mark
  where the window's elapsed time falls, and `usage` in the pane's bottom
  nav opens a page with every meter window of every pool, its reset time
  and pace, the credit meter where there is one, and every pool × tier rung
  with its model, reasoning and record, grouped by lane or by provider. A
  `route` tool lets the model switch routing when the person asks. Pool
  display names come from the
  `poolAliases` option; `strip` picks `runs`, `full` or `off`.
- integrate: `bullswarm integrate install --agents claude --yes` also links
  the mod under `~/.claude/skills/bullswarm-mod` and sets
  `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` to `"1"` in `~/.claude/settings.json`;
  `status` reports both and `remove` undoes both. A `settings.json` that is
  not a JSON object is left alone and reported. `.claude-plugin/marketplace.json`
  at the repository root makes `claude plugin marketplace add Bulls-Work/bullswarm`
  and `claude plugin install bullswarm@bullswarm` work too.
- workflow tui: the Preflight milestone now states the accepted goal (wrapped)
  with the paths of `goal.json` and `initial-planner-response.json`, and the
  planner milestone says how many actions in how many dependency levels the
  plan has. The Live section lists the planner only while it is planning;
  the "waiting for N workers" planner row and the "· N waiting" count are
  gone, since Next already says that. The first plan's own milestone is gone
  too: the levels that follow it say what it planned; plan revisions and
  rejected planning attempts still appear. A goal with several lines wraps
  line by line instead of carrying a line break inside one row. `workflow tui <run> --overview
  [--width <cols>] [--height <rows>]` prints one overview frame (or `--json`)
  for a caller that draws its own.
- docs: the documentation site is now a VitePress site under `docs-site/`,
  built from `docs/` and deployed to GitHub Pages by
  `.github/workflows/docs.yml` at https://bulls-work.github.io/bullswarm/.
  Guide (introduction, getting started, concepts, run, workflows, observing,
  routing), Reference (CLI, workflow program, configuration, providers,
  result envelope) and Integrations (Claude Code, Codex and Grok, issue
  watcher) replace the Jekyll pages; the historical notes are indexed under
  `/notes/`. `tests/unknown-flags.test.js` now checks every command form on
  the new pages against the CLI.

## 0.30.0 — a run never waits: it finishes and hands back what is left

- workflow: a run no longer waits for anyone. Every point where a
  caller-planned run used to hold now finishes it and hands the decision
  back: a `--scout` run with no program, a launch program the kernel could not
  accept, requirements still open with nothing left to run, and steering still
  unread when the last step ended. In a study of 41 caller runs on a real
  project (2026-09-14), one run sat 197 minutes waiting for a caller that had
  moved on.
- result: a new optional `handback` field lists every unfinished step with its
  failure kind, its reason, whether a plain resume runs it again, and
  `retryAfter` when every pool that could run it was paused; every open
  requirement with its latest reason; and steering nobody acted on.
  `runs result --summary` adds `handback.options`, one command each to
  continue (plan revise), retry (resume), take over, or restart. Results
  written before 0.30.0 still validate, and their summaries derive the same
  view.
- result: the reason line says what happened. "all program actions finished
  successfully; consult evidence for verification" read as success on runs
  whose check had failed the work. It now reads, for example, "all 4 steps
  succeeded, but not verified: requirement-2 failed — requirement-2: …" or "2
  of 5 steps did not succeed: build-api failed (stalled), …". A long finding
  quoted there is cut between words and ends in `…`; the full text is in the
  requirement's `why`.
- summary: an open requirement's `why` is no longer blanked to fit the 4 KB
  budget. Concerns, per-step detail and output names shrink first, and a
  passed requirement carries no `why`. The same study found `why` blank in 6
  of 10 unverified runs.
- watch: a finished run prints `outcome: <status> · verified|not verified`,
  `reason:`, one line per unfinished step and open requirement, unread
  steering, and `your call:` with the command for each option. A `--jsonl`
  `finished` object carries `verified`, `reason` and `handback`.
- resume: `workflow resume` on a finished run is a retry. It reopens the run
  for pending and cancelled steps, failed steps whose kind a retry fixes
  (`provider`, `quota`, `auth`, `process`, `unavailable`, `interrupted`,
  `runtime`, `schema`, `stalled`) and the steps blocked behind them, moves the
  result to `result-before-resume-<n>.json`, and relaunches. With nothing
  retryable it prints `nothing to retry`, starts nothing, and exits 1.
- dispatch: with no pool able to run a step, the step fails at once and says
  which case it is: every capable pool is paused until a time (recorded as
  `retryAfter`), the pinned pool cannot run that lane and effort, or no enabled
  pool has a model on that tier.
- workers: a worker that writes nothing for 60 minutes is stopped and fails as
  `stalled`, a mechanical failure retried once. The clock restarts on every
  byte, so a long step that keeps working is never cut off.
  `BULLSWARM_WORKER_SILENCE_SEC` sets the limit.
- kernel: a kernel that throws marks its run `interrupted` with `kernel
  stopped on an error: <message>` instead of leaving it claiming to run, and
  `runs show` reports a run whose kernel died as `interrupted`, with the
  reason and the resume command.
- validate: an `ownedFiles` entry naming a directory (`src/`, or an existing
  `src`) or a glob is refused by `plan validate`, `workflow goal` and
  `plan revise`; it used to pass and then stop the kernel right after launch.
  A pinned worker pool that cannot run a step's lane and effort is refused
  before launch. A new advisory, `requirement-unchecked`, names requirements
  no step checks.
- legacy: runs an older version left waiting still accept `plan show` and
  `plan submit`; `workflow resume` now finishes them with a handback instead
  of pausing again.

## 0.29.1 — a revised cancelled run runs its cancelled steps again

- workflow: revising a cancelled run reopened it but left every step the
  cancellation had stopped as `cancelled`, so the kernel finalized `partial`
  in the same second and nothing ran. Found on a real claude-code run
  (`pxkr7s`, revision 7). Reopening now returns those steps to pending, lists
  them as `reopened.requeued` in the revise output and the `workflow.reopened`
  event, and never counts their earlier attempts as completion. Failed steps
  still wait for an explicit `--rerun`.
- watch: a run waiting for its caller planner now also prints the
  `plan export` / `plan revise` commands next to `plan show`.
- workflow: an attempt stopped by a plan revision or a pause now records
  `failureKind: superseded` or `paused` on the attempt and in
  `attempt.finished`, the same kind `action.finished` already carried. It was
  recorded as a plain `cancelled`, which made deliberate steering look like
  worker failures.
- strategy: `strategy rungs` no longer counts a stopped dispatch against a
  pool's "% ok". On 2026-09-14 all 11 claude-code dispatches recorded as not
  ok were workflow cancellations, plan revisions or pauses, none a worker
  failure. Dispatch records now carry `failureKind`. The share was display
  only; routing never read it.

## 0.29.0 — steer a running workflow, providers become directories, a declared reset date

- workflow: the plan of a caller-planned program run can be changed at any
  time. `bullswarm workflow plan export <id>` writes the live plan as an
  editable revision document, and `bullswarm workflow plan revise <id>
  --program plan.json` replaces it: the kernel matches actions by id and
  applies the difference within about a second while agents keep running. A
  new id is added; an unchanged action keeps its result and its running agent;
  a changed action is stopped if running and starts over with the new
  definition; an id in `rerun` discards its result and runs again; a missing id
  is removed (stopped, never run, reported as `removed` and not counted against
  the result); and every step downstream of a changed or rerun step runs again.
  Evidence from a removed or rerun check stops counting until judged again.
  Revisions carry `baseRevision`, so a revision written against an outdated
  export is rejected instead of silently undoing another change, and an
  invalid revision changes nothing. Revising a finished run reopens it and
  archives the earlier result as `result-before-revision-<n>.json`.
- workflow: `bullswarm workflow pause <id>` stops new work while running agents
  finish (`--now` stops them too and requeues their steps). The kernel exits
  with `outcome: paused`; revisions apply while paused, and `workflow resume`
  is the only way to continue.
- workflow: steering a caller-planned program run no longer halts it at the
  next boundary. Watchers print `steering received`, the export lists the
  pending messages, and a revision delivers them; only a run about to finish
  with steering still unread pauses for the caller.
- watch: new lines for `plan revised`, `plan revision rejected`, pause
  requested/lifted, run reopened, steering received, and steps stopped by a
  revision or a pause.
- skill: SKILL.md gains "Steer a running workflow" and treats every watch
  wake-up as a point to decide whether the plan still fits; operations.md
  documents revision semantics, pause and resume, and steering.

- providers: every coding-agent CLI is now a provider directory holding
  `connector.json`, `provider.mjs`, or both, loaded by one synchronous loader
  (`src/lib/providers.js`) from three tiers. First-class (`src/providers/`)
  always loads and holds claude-code, codex, grok and echo. Contrib
  (`providers/contrib/`) ships in the package but loads only where
  `~/.bullswarm/providers.json` lists it, and holds command-code and the
  generic opencode2 connector. Local (`~/.bullswarm/providers/`) is the
  operator's own and never appears in this repository. A module exports at most
  `name`, `displayName`, `connectors(ctx)`, `readUsage(pool, ctx)` and
  `doctor(ctx)`; everything else stays the connector JSON four CLIs already
  ran through. Echo ships JSON-only and grok keeps its OAuth-refreshing meter
  as real code, so both paths stay exercised.
- providers: `bullswarm provider list|enable|disable|validate|scaffold|probe`.
  `probe` spawns one pool through the dispatcher's own runner with a one-word
  task and then reads its meter once, which is the only evidence that a new
  provider's model flag, event parsing and meter all actually work.
- core: the per-vendor branching is gone. The meter registry resolves a pool's
  reader through its owning provider instead of a name-prefix map, connector
  loading is one call into the loader, setup discovery and the strategy labels
  come from provider entries, and both hard-coded connector expanders are
  deleted. `credentialGroup` is the honest name for `upstreamGroup`, which is
  still read.
- requires Node >= 22.12: the loader reads `provider.mjs` through
  `require(esm)` so `loadConnectors` and `buildPools` stay synchronous for
  their twenty-odd call sites.
- providers: built-in support for one specific reseller was removed entirely.
  It is expressible as a local provider with no repository changes at all,
  which was the point of the tiers.
- setup: `BULLSWARM_NO_PACKAGED_PROVIDERS=1` forces the packaged tiers off, for
  tests that spawn the real CLI against a fixture home and assert an exact pool
  list. Never set it in production.
- workflow: evidence actions are routed like any other action. They used to be
  steered away from the pools that did the work, which bought little
  independence (the judging model is chosen by tier, not by pool) and overrode
  pacing. The `avoidPools` dispatch option is gone.
- codex: the connector runs `codex exec -s danger-full-access`. Codex sandboxes
  writes to its workspace, so a workflow evidence action could do the work and
  still fail with EPERM writing its candidate file into the run's state
  directory under the bullswarm home.
- command-code: the connector passes `--max-turns 10000`. command-code's print
  mode stops after 100 turns by default and exits 8 mid-task, which bullswarm
  could only report as a non-zero exit and retry from scratch on another pool.

- routing: an upstream auth failure reported inside a provider's event stream
  is now the `auth` failure kind with a quarantine hint, and it benches every
  pool that shares the same upstream credential. On 2026-09-11 the pooled Codex
  OAuth account behind `https://relay.example` was invalidated at 12:24 UTC and
  answered every request with
  `{"error":{"message":"Encountered invalidated oauth token for user, failing
  request","type":"authentication_error","code":"auth_unavailable"}}` (401) or
  `auth_unavailable: no auth available (providers=codex, model=gpt-5.6-luna; …)`
  (503); non-GPT models on the same host answered `No available channel for
  model <name> under group default`. `src/lib/watch.js` turned any stream
  `error` event into a bare `provider` verdict before the auth gate ran, so no
  pool was ever benched: a failed action's retry walked
  `opencode2:relay-3` → `opencode2:relay-2` → `opencode2` — three names for the
  one dead credential — and runs m4xiva and ytdsii ended `partial` with their
  integrate/verify actions blocked (failures at 12:24, 12:25, 12:52, 12:53,
  12:54; last good dispatch 11:22). Four upstream phrases now ship as
  `DEFAULT_AUTH_SIGNATURES` (`src/lib/auth-signatures.js`), matched only on a
  stream that already declared a failure and only on an error-shaped line or
  the raw JSON error event itself, so an agent that merely reads auth code is
  still never quarantined. Connectors may declare `upstreamGroup`;
  `src/lib/opencode-relay.js` sets `relay:<host>` on every expanded Relay pool,
  and an auth quarantine now spreads to that group on one shared 10-minute
  deadline in both dispatch paths. Claude account pools get no group — separate
  seats are separate credentials — and a `quota` quarantine never spreads,
  because a sibling's own window still has work in it.

- cli: `bullswarm update [--check] [--json]` upgrades the installation in
  place — the verb a teammate reached for and found missing (2026-09-11). It
  reads the latest version from the npm registry, tells the install shape
  from the running package's real path rather than from `which` or `npm root
  -g` (which can name a different Node install), and acts accordingly: a
  global install gets `npm install -g bullswarm@<latest> --prefix <its own
  prefix>`; a source checkout, including a global `npm link` into one, gets
  `git pull --ff-only` and is refused while it has local changes; anything
  else prints the manual command and exits 1. Success is verified by
  re-reading package.json on disk, never by npm's exit code, and a shell
  whose `bullswarm` resolves elsewhere is called out. `--check` compares
  without changing anything.
- routing: the reasoning level now reaches every model a Relay pool can run,
  not only `gpt-5.6-luna`. opencode forwards `--variant <level>` only when its
  config declares that variant for that exact model, and the config
  `src/lib/opencode-relay.js` injects declared the five levels for luna alone,
  so moving a tier onto `<id>/gpt-5.6-sol` (2026-09-12, when luna had no
  upstream channel left but sol did) would have sent a `--variant medium` that
  opencode silently dropped while `strategy rungs` kept reporting medium.
  Discovery now records each provider's model list from opencode.json and the
  variants are declared on all of them; a provider that lists none keeps the
  luna default.
- meters: a Relay pool's used% is read against its own declared plan total
  (`strategy set-subscription <pool> --included-usd <n>`) before the host-wide
  `RELAY_PLAN_USD` and the $50 default. The wallets differ — relay-4 is a $20
  newcomer plan — and one shared number would have shown a $10 spend on it as
  20% used.
- meters: a pool whose provider reports usage but no reset date can be paced
  from a reset the operator declares —
  `bullswarm strategy set-subscription <pool> --resets-at <iso|unknown>`.
  The Relay token API stopped returning `expires_at` for the `1` and `Moham`
  wallets on 2026-09-03 (the project-n log holds 28 dated snapshots between
  2026-08-31 and 2026-09-03, then only nulls), so `opencode2` and
  `opencode2:relay-3` printed `unmetered` at 73.8% and 10.7% of their $50
  wallets and ranked as neutral. With a declared reset the used% stays the
  provider's, elapsed% runs to the declared date, the date rolls forward one
  calendar month (or week) at a time once it passes, and `bullswarm pools`
  labels the row `[live declared-reset]`; `pools --json` and
  `strategy show` carry `resetSource` (`provider` | `declared`). A window
  the provider does date is never overridden. Doctrine M2 in
  `src/meters/framework.js` and the guide's rule 2 record the operator path.

## 0.28.8 — a README for visitors and a documentation site

- docs: README rewritten for external visitors landing on the GitHub page —
  pitch, why it exists, install, quick start, how routing picks a pool, and
  what a run gives back — with the detailed reference material moved to a
  GitHub Pages site under `docs/`: `guide/entry-points`, `guide/doctrine`,
  `guide/getting-started`, `guide/strategy`, `guide/workflows`,
  `guide/operations`, `guide/dashboard`, `guide/repository-operations`, and
  `guide/routing`. Terms a newcomer would trip on (pool, lane, kernel,
  envelope, rung) are defined on first use; the 5-hour gate is documented as
  clock-relative. The site needs the repository owner to enable Pages
  (Settings → Pages → deploy from branch `main`, folder `/docs`) before
  `https://cowcow02.github.io/bullswarm/` serves it; until then the same pages
  are readable directly under `docs/guide/` in the repository.

## 0.28.7 — pools about to reset spend their leftover first

- routing: quota that expires sooner is worth more. A pool whose pacing window
  resets within 24 hours (weekly) or 3 days (monthly) is now ranked on urgency
  — its effective surplus divided by the fraction of the window still to run —
  ahead of every pool whose window is not about to close, instead of on the
  surplus alone. At 2026-09-11 12:26 HKT the medium lane went to
  `claude-code:acme` (+22.9 points, 13h33m and 8.1% of its week left) over
  `grok` (+13.8 points, 2h02m and 1.2% left, urgency ~1150 against acme's
  ~283), and grok's points expired unspent two hours later; the owner had been
  pinning grok by hand for such runs. Three states for an expiring pool:
  `urgent` (surplus still to spend and a pacing forecast — the reading plus
  in-flight work plus this candidate, each clipped at the reset — below 95%,
  with 5 points of extra headroom demanded when no spend rate was measured),
  which outranks incumbency and a configured effort assignment but never a
  strict pin or the 5-hour rules; `draining` (forecast at/above 95%), ranked
  behind every normal pool so a window about to be emptied is not fed one more
  run; and `normal` (on or ahead of pace), ranked exactly as today. A pool with
  no parsable `paceResetsAt`, a reset already past, or any other window is
  never expiring soon and nothing about it changes. `bullswarm pools` ends an
  expiring pool's line with `resets in 2h02m EXPIRING-SOON urgency=1150`, and
  each routing candidate row carries `paceResetsInMinutes`, `expiringSoon`,
  `urgency`, `forecastPacingPct` and `urgencyState`.

## 0.28.6 — the 5-hour near-limit line reads the clock

- routing: the 5-hour near-limit line is now clock-relative. A pool is
  deprioritized only when its 5h forecast is at/above 75% AND ahead of the
  share of the 5h window that has already elapsed. On 2026-09-10 at 22:19Z a
  high-tier integrator skipped `claude-code:acme` (81% used, 23 minutes to the
  reset — 92.3% of the window elapsed, 88.1% projected) and
  `claude-code:initech` (75.3% projected, 85.7% elapsed) and went to the one
  account already ahead of its weekly pace, while acme still held 34% of its
  weekly quota unspent with 13% of the week left to spend it. Both pools now keep the lane:
  88.1% with 23 minutes left is a pool spending at the clock's pace, not a pool
  about to hit a wall. Pools with no `resets_at`, an unparsable one, or a reset
  already past keep the fixed 75% line, and the 90% burst gate is unchanged —
  it ignores the clock. The routing reason and the `candidates[]` rows say
  which case applied: `5h used 81% -> 88.1% projected, under the clock (92.3%
  elapsed)`, `skipped near 5h limit (projected): claude-code:acme 88.1% (20.0%
  elapsed)`, and a new `fiveHourElapsedPct` field. `bullswarm pools` shows the
  same clock: `5h=81% (92% elapsed)`.
- routing: 5-hour spend is clipped at the reset. Quota spent after the window
  rolls over lands in the next window, so the candidate's minutes and each
  in-flight record's remaining minutes are charged to the 5h forecast only up
  to `fiveHourResetsAt` — 10 minutes from a reset, a 40-minute task at 0.5
  points per minute adds 5 points to the forecast, not 20. The weekly/monthly
  pacing charge is deliberately not clipped: that spend counts against its
  window whichever side of the 5h reset it lands on.

## 0.28.5 — narrow-terminal detail panes use the whole screen

- tui: on a narrow terminal (under 100 columns, e.g. a phone over SSH) the
  agent detail, workflow technical details and planner overview panes wrapped
  their text to the width they would have beside the 34-column sidebar, so a
  60-column screen showed 22-character lines inside a 58-character panel. The
  text now wraps to the pane it occupies: full width when narrow, the right
  column otherwise. Regression test at 60 columns.

## 0.28.4 — the skill says how, the schema file says what

- skill: the method and the schema are now separate files. `skill/SKILL.md`
  (1,345 → 914 words) keeps only what the kernel cannot check: choosing the
  shape, decomposing into territories, dependencies as inputs rather than
  phases, the integrator, evidence, the effort rule (writers are `implement`;
  high belongs to `integration`, `architecture`, `adversarial-acceptance`;
  never `defaults.effort: high`), and an explicit validate → read `advisories`
  → adjust → launch sequence. The new `skill/references/program.md` holds the
  program format: fields, kinds, requirement-ID derivation, enforced rules and
  one example that validates with no advisories. `plan contract` is no longer a
  step in the default flow; operations.md documents it as the live fallback
  and the dispatched planner's brief. Reasoning depth, digest details and the
  watch flags live in operations.md only.

## 0.28.3 — connector upgrades learn new packaged profiles

- command-code: a profile entry for `deepseek/deepseek-v4.1-flash` that
  carries the model's own pricing from
  https://commandcode.ai/docs/resources/pricing-limits (2026-09-11): input
  $0.15, cache read $0.003, output $0.60 per million tokens off peak (the
  peak window is documented in the entry). Tier and rank stay exactly what the
  generic flash catch-all gives; this is not a recommendation, and none will
  be packaged without benchmark evidence. Note for operators: model discovery
  is only re-run by `bullswarm strategy refresh`, so a model a CLI added since
  the last refresh is rejected by `strategy set-rung` until you refresh.
- Connector upgrades now insert packaged `modelProfiles` entries that the
  installed connector lacks (keyed by `match` or `id`) at the position the
  packaged order implies: before the installed generic catch-all a specific
  entry was written to precede, never ahead of a profile the operator
  authored. Profiles the installed connector already holds are never touched.
  Before this, `modelProfiles` was copied only when the installed connector
  had none at all, so existing installations never learned new entries.

## 0.28.2 — terminal glyph fallback, issue watcher, health on a fresh home

- `bullswarm workflow` repainted flashing `?` characters on macOS
  Terminal.app. Cause is font coverage, not encoding: parsing the `cmap` of
  every monospace face Terminal.app offers shows **zero** glyphs in the
  Braille block `U+2800-U+28FF` — Andale Mono, Menlo, SF Mono, Monaco and
  Courier New are all 0/256 — and none of the five has `⧖` (`U+29D6`) or `⟡`
  (`U+27E1`). The dashboard's 10-frame Braille spinner advances every 400ms,
  so every repaint drew a question mark that flashed; the static `✓ ✗ ⊘ ◇ ↳
  ⚠ ● ○ ■ ♡ ◆ ↻ ↺ ▶ ⚙` icons beside it were the steady ones. Terminal.app
  does not substitute another face for these ranges.
- New `src/lib/glyphs.js` holds one table per mode and the detection order:
  `BULLSWARM_ASCII` forces ASCII, `BULLSWARM_UNICODE` forces Unicode and
  overrides detection, then a non-UTF-8 locale, `TERM=dumb`/`TERM=linux`, and
  `TERM_PROGRAM=Apple_Terminal` select ASCII. Every replacement is one column
  of printable ASCII, because panel width maths uses `String#length` and a
  wide substitute would shear the borders. Box drawing, `· › × … ≈ ≥ █` are in
  all five fonts and are left alone, so panels keep their borders.
- Wired through the three live-refreshing renderers only:
  `src/workflow/dashboard.js`, `src/workflow/watch-cli.js` and
  `src/strategy-dashboard.js`. One-shot `✓`/`✗` message prefixes in
  `src/workflow/cli.js`, `src/help.js`, `src/integrate.js`,
  `src/workflow/runs-cli.js`, `src/strategy-cli.js` and
  `src/lib/cli-flags.js` are untouched — they do not flash and are a separate
  change.
- `spinnerGlyph` now parks a non-finite frame counter on frame 0. The previous
  expression `SPINNER_FRAMES[Math.abs(Number(f) || 0) % SPINNER_FRAMES.length]`
  returned `undefined` for `Infinity`, so a repaint could have painted the
  string "undefined" into the frame.
- `tests/glyphs.test.js` covers the detection matrix (including that `''`,
  `'0'` and `'false'` do not switch tables, and that `LC_ALL` outranks
  `LANG`), asserts every Unicode entry has a one-column pure-ASCII twin that
  is never `?`, and renders both dashboards, `renderWatchSnapshot`,
  `renderWatchEvent` over 15 event shapes and `renderAnalysisProgress` at five
  spinner frames, asserting no substituted glyph survives in ASCII mode while
  the Braille spinner still appears in Unicode mode.
- `tests/strategy-cli.test.js`, `tests/workflow-dashboard.test.js` and
  `tests/workflow-watch.test.js` assert the Unicode presentation, so they now
  pin `BULLSWARM_UNICODE=1` and `delete process.env.BULLSWARM_ASCII`; without
  the pin the suite's own output depended on which terminal the developer ran
  it in, and without the delete an ambient `BULLSWARM_ASCII=1` — the very
  workaround the README hands an affected user — outranked the pin and broke
  22 tests.
- The four arrows `↑ ↓ ← →` are deliberately not substituted. They are only
  missing from Monaco, and they live in the frozen `DASHBOARD_KEYS` constant,
  which binds at import time — before any env pin could apply.
- `scripts/issue-watcher/` — a durable GitHub issue watcher for this
  repository, installed as a launchd agent
  (`node scripts/issue-watcher/install.mjs`). Idle costs ZERO model tokens:
  a pass is one `gh issue list` and nothing else. Only when an issue appears
  that is new since install does it delegate — one
  `bullswarm run --lane analyze` to triage (label + plain-words comment),
  and for a bug it judged fixable at confidence >= 0.7 one
  `bullswarm run --lane build` to fix, which the watcher then verifies
  itself (test suite green in its own clone, diff non-empty) before pushing
  `fix/issue-<n>` and opening a pull request. Both delegations run on the
  owner's subscriptions through normal bullswarm routing, never API tokens.
  Capped at 6 triages and 2 fix attempts per UTC day, one fix attempt per
  issue; guarded by a pass lock, a `paused` file, and a 3-attempt triage
  retry cap. Delegates get no GitHub credentials and issue text is quoted as
  untrusted data. It never merges, closes, or releases — a maintainer does.

## 0.28.1 — summary bytes on the wire, monthly pacing

- `workflow runs result <id> --summary` was budgeted by `fitResultSummary`
  against compact `JSON.stringify(summary)` (`RESULT_SUMMARY_BYTE_BUDGET =
  4096` in `src/workflow/v2-outcome.js`) but `jsonOut` printed
  `JSON.stringify(obj, null, 2)`, so the bytes on the wire exceeded the
  budget. `--summary` now prints compact single-line JSON
  (`JSON.stringify(obj)` in `src/workflow/runs-cli.js`); `--json` without
  `--summary` still pretty-prints the full envelope, and `--summary --json`
  stays identical to `--summary`. Measured on
  `tests/fixtures/real-result-ze5xz2.json` through the summariser / CLI:
  compact `--summary` is 3,786 bytes
  (`tests/workflow-result-summary.test.js` prints `result-summary size:
  full=57141 summary=3786`; same figure as
  `Buffer.byteLength(JSON.stringify(summarizeV2Result(fixture)))`); the
  full envelope as `--json` prints it is 60,709 bytes
  (`JSON.stringify(envelope, null, 2)` plus the trailing newline
  `console.log` adds — `tests/workflow-result-summary.test.js` prints
  `result-summary cli: prettyFull=60709`).

- Routing paced every pool by `windows.seven_day ?? windows.monthly`
  (`paceSnapshot` in `src/meters/framework.js`), so command-code — whose real
  budget is a monthly credit allocation — was paced by its weekly rate-limit
  window. Live meter, captured 2026-09-09T10:45:28Z and evaluated at
  2026-09-09T11:09:44.982Z: weekly `used 73.1% elapsed 91.8% surplus +18.7`
  against monthly `used 79.4% elapsed 75.3% surplus -4.1`, with 14.43 of 70
  credits left for the 7.66 days to the 2026-09-17T03:06:55Z reset. Routing
  therefore called it "the most-behind capable pool" and kept sending it work
  while its monthly budget was already 4.1 points overspent. Pacing is now per
  pool: `pacingWindowFor({connector, subscription})` resolves
  `state.strategy.subscriptions[pool].quotaWindow`, then
  `connector.subscription.quotaWindow`, normalised to `weekly` | `monthly` |
  `null` (any other label — including a pre-0.28.1 free-text one — is ignored
  for pacing and keeps the old weekly-first order). `paceSnapshot(snapshot,
  nowMs, {pacingWindow})` takes `monthly` → `windows.monthly ??
  windows.seven_day`, `weekly`/`null` → `windows.seven_day ??
  windows.monthly`, and returns `pacingWindow` naming the window actually
  used. `src/lib/config.js` `buildPools` resolves the choice once per pool
  (where the connector and the state both are) and re-paces `usedPct`,
  `elapsedPct`, `pace` and `paceResetsAt` off `reading.windows`, so cache,
  stale and live readings are paced identically; the pool view carries
  `pacingWindow`. The 5h gate is untouched: `command-code` still gates on 5h
  `25.2%`. Connectors already declared this — `command-code` and the relay
  pools `monthly`, `claude-code`/`codex`/`grok` `weekly`; nothing read it for
  pacing before.
- The spend model follows the pacing window. `WINDOW_KEYS` (framework.js)
  gains `monthly: {snapshot: 'monthly', history: 'monthly', windowMs: null}`,
  and `rateForWindow` (`src/lib/spend.js`) derives the bootstrap window start
  with `meta.windowMs ?? monthlyWindowMs(resetsAtMs)` — the calendar month
  ending at the provider's `resets_at` (M2), never an assumed 30 days.
  `attachSpend` now writes `pool.spend.monthly` and `pool.projectedMonthlyPct`
  next to the fiveHour/weekly fields, plus `pool.spend.pacing = {window,
  ratePerMinute, source, samples}` and `pool.projectedPacingPct` for the
  window that paces the pool (default `weekly`, so a pool that declares
  nothing keeps its old numbers). `inflightLoad` (`src/lib/route.js`) charges
  the in-flight penalty from `spend.pacing?.ratePerMinute ??
  spend.weekly?.ratePerMinute` with that rate's own source label, so the
  surplus and the penalty are measured in the same window; candidate rows gain
  `pacingWindow` and `projectedPacingPct` beside the unchanged
  `projectedWeeklyPct`.
- Operator control and display. `bullswarm strategy set-subscription <pool>
  --quota-window <weekly|monthly>` now selects the window that paces routing
  (help text in `src/help.js`) and validates it: anything else exits 2 with
  `--quota-window must be weekly or monthly (or unknown to clear)`, and
  `unknown` clears the override back to the connector's declaration. Labels
  already stored are ignored for pacing, never rejected on read. `bullswarm
  pools` names the window in the meter column — `cmd-fixture    cost=5
  lanes=chore monthly used 79.4% elapsed 75.3% [cache] surplus=-4.1
  inflight=0 5h=25.2% ready` — and `pools --json` entries carry
  `pacingWindow`. `strategy refresh`/`show` print the window on each
  subscription line (`command-code: GOAT · ... · monthly 79.4% used · surplus
  -4.1`) and carry `pacingWindow` next to the free-text `quotaWindow` label in
  `--json`; `strategy inventory --json` carries it per provider.
- Tests: 738 -> 750, 0 failures. The new behaviour is covered in
  `tests/meters.test.js` (the live command-code snapshot as a fixture, the
  helper's precedence, `buildPools` pacing), `tests/spend.test.js` (monthly
  bootstrap window start, `spend.pacing`/`projectedPacingPct`),
  `tests/route.test.js` (the penalty on the pacing window; weekly-only pools
  unchanged), `tests/strategy-cli.test.js` (`--quota-window` validation) and
  `tests/assignments.test.js` (the `pools` meter column and `--json`
  `pacingWindow`).

## 0.28.0 — context diet

- `workflow runs result <id> --summary` prints a compact status-loop
  envelope, `schemaVersion: "bullswarm.workflow.result-summary.v1"`. It
  carries `runId`, `shortId`, `status`, `verified`, `executionMode`,
  `reason`, `finishedAt`, the goal's first line trimmed to 120 characters
  plus `goalBytes`, each requirement as `{ id, status, mandatory,
  evidenceCount, why }` (`why` is the latest evidence's first line trimmed
  to 200 characters), each action as `{ id, kind, lane, effort, status,
  pool, model, reasoning, wallSec, outFile, bytes }`, `concerns: { count,
  first }` (up to three one-liners), the `usage` block, and `next: { full:
  "bullswarm workflow runs result <id> --json", outputs: [<outFile paths>]
  }`. `--summary` implies JSON with or without `--json`; it is not
  TTY-dependent. The full `bullswarm.workflow.result.v2` envelope is
  unchanged and stays the default. Read the full envelope on a failed or
  partial run, or before judging evidence. Flag, help, and example:
  `src/lib/cli-flags.js`, `src/help.js` (`Usage: bullswarm workflow runs
  result <shortId|runId> [--json] [--summary]`; `--summary` "print the
  compact JSON status-loop envelope; implies --json"). A terminal `workflow
  watch` prints `next: bullswarm workflow runs result <shortId> --json
  --summary`.

- Byte accounting on every action attempt. `state.attempts[].bytes` is
  `{ taskFile, authorPrompt, kernel, dependencyInputs, output }` — the task
  file the kernel wrote, the action's own prompt text as authored, the
  remainder after subtracting that prompt and any embedded requirement
  text, the sum of the dependency output files the task points at (0 when
  there are none; `digestOf` drill-down paths are pointers, not inputs),
  and the durable out file on completion. The result envelope copies the
  last attempt's `bytes` onto `actions[]` and totals `usage.bytes: {
  taskFiles, dependencyInputs, outputs }`. `workflow runs show` appends
  `in <taskFile>/<dependencyInputs> out <output>` per attempt (the unit
  fixture prints `in 3.1K/60.8K out 14.8K`); missing values stay blank /
  null, never guessed. These are UTF-8 byte counts, never tokens.

- `kind: "digest"` (analyze/low) is an extractive condensation of its
  dependencies' outputs so an expensive consumer reads one artifact
  instead of many raw out-files. The kernel writes the whole task: quote
  verbatim (never paraphrase or judge) each source's delivered items,
  validation numbers, commands and their output, unfinished work, and
  every shared-file or integrator request; one section per source headed
  by its absolute output path; no verdicts, no recommendations, no new
  claims; target at most a quarter of the input bytes or 8 KB, whichever
  is larger. The author's prompt is focus guidance only. Validation
  (exit 2 with the reason at `workflow plan validate` and `workflow goal
  --program`): a digest must depend on at least one action, must have
  empty `evidenceFor`, owns no files, needs no `affects`. No evidence
  action may list a digest in `dependsOn` — evidence reads the real
  artifacts. Consumers that depend on a digest receive, in their
  dependency artifacts, the digest entry plus `digestOf: [{ actionId,
  outputFile }]` for each digested source. Use one when three or more
  writers feed a single integrator, or when a consumer's dependency
  outputs would exceed roughly 20 KB; never for evidence.

- The planning contract states the kind. `workflow plan contract --json`
  (`Usage: bullswarm workflow plan contract "<goal>" [--cwd <dir>]
  [--json]`) returns 16 rules; `rules[5]` lists `digest=analyze/low` in
  the kind table and `rules[6]` is the extractive digest rule (when to
  insert one, `digestOf`, empty `evidenceFor` / `ownedFiles`, evidence
  must not depend on a digest).

- The packaged skill's status loop (`skill/SKILL.md`,
  `skill/references/operations.md`) now recommends `bullswarm workflow
  runs result <shortId> --json --summary`. Read the full envelope with
  `--json` alone when the run is failed or partial, or before judging
  evidence.

- Measured numbers, each with its command. On the real 0.27.1 build run
  `ze5xz2` (files under `.diet-inputs/`): `workflow runs result ze5xz2
  --json` is 60,709 bytes on disk (`wc -c .diet-inputs/real-result-ze5xz2.json`;
  the same file is `tests/fixtures/real-result-ze5xz2.json`). The 0.28.0
  goal recorded that envelope's `requirements` as 39,231 bytes and `goal`
  as 11,009 bytes. Re-measuring the same file: `Buffer.byteLength(goal)` =
  10,996 (the summary's `goalBytes`) and `JSON.stringify(requirements)` =
  39,288; compact `JSON.stringify` of the parsed envelope is 57,141.
  `summarizeV2Result` of that fixture is 3,786 bytes —
  `tests/workflow-result-summary.test.js` prints `result-summary size:
  full=57141 summary=3786` (numbers re-measured in 0.28.1). The 0.28.0
  goal recorded the integrator's inputs as 60,790 bytes; `wc -c` of the
  seven dependency out-files under `.diet-inputs/` sums to 46,022
  (out-surface 18,659, out-routing-cleanup
  10,202, out-state-bugs 7,052, out-docs 6,831, out-dead-kernel 1,377,
  out-verify-gate 974, out-dead-code 927) and the integrator task file is
  14,768 (`wc -c .diet-inputs/task-integrate-attempt-1.md`), which
  together are 60,790.

- Fixture measurement, the same goal run twice under a temporary home
  (`tests/workflow-context-diet-measurement.test.js`, which prints both
  lines below). Three writers each padded to a few KB feed one integrator
  directly, then the same three feed a `kind: "digest"` that feeds the
  integrator: the integrator's `bytes.dependencyInputs` falls from
  **12,477 bytes to 63 bytes** (`context diet: integrator dependencyInputs
  without digest=12477 with digest=63`). The 63 is a floor, not a
  condensation ratio — the deterministic fixture worker answers with a
  fixed stub instead of really condensing. The ceiling is the byte target
  the kernel writes into that digest's own task, **8,192 bytes** for this
  input, and the test asserts the saving holds at that ceiling too
  (8,192 < 12,477). The same run's envelopes print as `context diet: run B
  envelope full=<n> summary=<n>` (the full envelope embeds the temporary
  home's absolute paths, so its size varies a few bytes between runs; the
  summary carries one `next.runDir` string plus basenames, so it does not);
  the deterministic envelope comparison to quote is the real-run fixture
  above (57,141 full vs the measured summary).

- `workflow capabilities` now reports the closed kind list at
  `engines.autonomousV2.actionKinds`, cloned from the validator's
  `KIND_DEFAULTS` rather than hand-listed, so `digest` and every future
  kind are discoverable by a probing agent
  (`src/workflow/cli.js`). The planning contract's
  `program.actionFields.kind` description is derived from the same table
  (`src/workflow/v2-planner.js`).

- `TIER_LANES` (`src/lib/strategy.js`) excludes kernel-owned kinds from the
  effort-tier count, so the map stays `{ high: analyze, medium: build,
  low: chore }`. A digest is a mechanism the kernel writes, not a nature of
  work that should define which lane a tier routes to; counting it would
  have flipped low from `chore` to `analyze` on the strength of an action
  no planner has to reason about. No shipped connector's routing changes
  either way — all six declare all three lanes.

- The three Relay-backed OpenCode pools can now run gpt-5.6-luna at a
  chosen reasoning level. `connectors/opencode2.json` declares
  `reasoning: { flag: "--variant", levels: [low, medium, high, xhigh,
  max], defaults: { high: high, medium: medium, low: low } }` — the same
  five levels as `connectors/command-code.json`, which fronts the same
  backend — so rungs for these pools stop printing `— (unsupported)`.
  opencode only forwards a `--variant` its config declares for that
  model, so the flag alone would be silently dropped;
  `expandOpenCodeRelayConnectors` (`src/lib/opencode-relay.js`) therefore
  sets `env.OPENCODE_CONFIG_CONTENT` on the base pool and on every clone
  to the variants for that pool's OWN provider id, via the new pure
  helper `relayVariantsConfig(providerId, model = RELAY_OPENCODE_MODEL)`:
  `{"provider":{"relay-2":{"models":{"gpt-5.6-luna":{"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},"xhigh":{"reasoningEffort":"xhigh"},"max":{"reasoningEffort":"max"}}}}}}}`.
  opencode merges that JSON string over the config file, so the API key
  and everything else in `~/.config/opencode/opencode.json` stays in
  force. An `OPENCODE_CONFIG_CONTENT` the operator set by hand in the
  installed connector is never overwritten, on the base pool or on the
  clones. A medium/max dispatch on `opencode2:relay-2` composes
  `opencode run --auto --model relay-2/gpt-5.6-luna <taskFile> --variant
  max --format json`; a level already pinned in the template is replaced,
  not duplicated. Per pool:
  `bullswarm strategy set-rung opencode2 medium --model relay/gpt-5.6-luna --reasoning max`,
  `bullswarm strategy set-rung opencode2:relay-2 medium --model relay-2/gpt-5.6-luna --reasoning max`,
  `bullswarm strategy set-rung opencode2:relay-3 medium --model relay-3/gpt-5.6-luna --reasoning max`.
  Existing installations pick the block up through
  `upgradeConnectorMetadata` (`src/setup.js`), which backfills a missing
  `reasoning` block and leaves a customised one alone. Non-Relay opencode
  installations get no injected variants, so `--variant` is a no-op there
  rather than an error — recorded in the connector's
  `$comment-reasoning`.

- Tests: 713 -> 738, 0 failures
  (`env -u CLAUDE_CONFIG_DIR -u FORCE_COLOR -u NO_COLOR npm test`). Four
  new files carry the new behaviour: `tests/workflow-bytes.test.js`,
  `tests/workflow-digest.test.js`,
  `tests/workflow-result-summary.test.js` (with the
  `tests/fixtures/real-result-ze5xz2.json` envelope it measures) and
  `tests/workflow-context-diet-measurement.test.js`.

## 0.27.1 — audit cleanup

- Deleted the remaining dead symbols the 2026-09-09 audit listed as Tier A:
  `recordAgentAction` and `classifyAgentProgress`, `aggregateUsage`,
  `parseEvidenceOutput`, `fiveHourTier`, `REASONING_DEFAULT_TIERS`, the twelve
  alias re-exports around `runAutonomousV2` /
  `assertV2ResumeCompatible` / `validateEvidenceEnvelope`, and
  `integrationBlock`. `'workflow-v1'` is no longer an assignment source.
  `currentUsedPct` no longer reads a `weeklyUsedPct` field no producer writes,
  and the identical `--json` ternary in `strategy-cli` collapsed to one
  `JSON.stringify`. `fixtures/openrouter/` stays; a new
  `tests/refresh-openrouter-benchmarks.test.js` runs the refresh script against
  those fixtures instead of deleting them.

- `state.json` is no longer last-writer-wins (D5). EVERY state writer goes
  through one locked read-modify-write — take `state.lock`, reload FRESH,
  mutate, atomically replace the file, release. That is `run`, `pools`,
  `health` and the fixture migration plus the twenty-two remaining
  load-mutate-save sites: fifteen in `strategy-cli` (set-rung, set-model,
  reset-tier, set/reset-reasoning, configure, apply, auto off, assign,
  clear-assignment, exclude/include-model, set-subscription and the persisted
  refresh report), three in the strategy TUI, and four in `setup`
  (`setup --yes`, both writing steps of the wizard, and the reasoning step).
  `grep -n 'saveState(' src/` now finds only `src/lib/state.js`, which defines
  it and calls it once, inside `updateState`. Waiters retry for 10 s and a lock
  older than 30 s is taken over so a killed process cannot bench the file
  forever. `run --dry-run` no longer refreshes strategy or hits the network
  (D3). The fixture migration no longer force-disables a pool the operator
  explicitly enabled (D1). Disabled pools are no longer polled (D6). When every
  lane-capable pool was dropped by an empty tier allow-list, the routing reason
  now says so instead of blaming missing capabilities (D7). `pools`, `health`
  and `run --dry-run` leave `state.json` byte-for-byte alone when they have
  nothing to change. `src/workflow/fsjson.js` — the re-export shim that carried
  the workflow importers through the move of the atomic writer into
  `src/lib/fsjson.js` — is deleted; both layers import `src/lib/fsjson.js`
  directly.

- The content gate no longer treats an error-shaped JSON object as an answer,
  and long outputs are scanned at both the head and the tail for failure
  patterns.

- An unrecognized `--flag` is a usage error on every command: Bullswarm prints
  `unknown flag --name` plus that command's synopsis and exits 2, before
  self-initializing, routing, or spawning anything. `--lane` is required on
  `run` (omitting it, or passing anything else, exits 2). `--limit` on
  `workflow runs` must be a positive integer. `health --json` now selects the
  machine-readable report; the default is a human summary of the same facts.
  Help for `run --no-caller`, the always-JSON verbs, and the plan-contract /
  plan-validate worker flags matches what the parsers actually accept.

- A dead kernel is visible: `watch`, `runs show`, `runs result --json`, and the
  TUI surface the last 20 lines of `stderr.log` instead of a silent stall.

- Four small refactors from the audit's C1–C4 list: `TIER_LANES` is derived
  from the 0.26 kind/effort tables so the strategy preview cannot disagree with
  the validator; `clearTierAssignment` is the one writer of a cleared tier pin;
  `finiteOrNull` is the one numeric coercion (blank/null prices and scores stay
  unmeasured instead of becoming 0); quota signatures live in one table.

- The OpenRouter datapack no longer pretends to have a bundled last-resort
  file. Loaders try `~/.bullswarm/cache/` then the rolling GitHub Release; a
  cache miss with no network yields an empty catalog. Epoch still ships
  `data/epoch-benchmarks.json`.

- Documentation made true: README no longer lists `runs cleanup`; bare
  `bullswarm` is a TTY wizard and non-TTY callers self-initialize; the
  OpenRouter/Epoch datapack fallback is described as it actually works; the
  duplicated planning-targets paragraph appears once; `--name` is an exact
  goal/name filter; `--classic` is V2-only and legacy watch exits 2;
  `workflow-v1` is gone from the skill; `workflow goal` is no longer described
  as an LLM-at-every-checkpoint loop; `delegate` is marked historical in the
  2026-09-06 design note; GOAL.md and the ten dated `docs/` files that needed
  a banner carry one.

- Tests: 661 -> 713, 0 failures. Eight new files carry the new behaviour:
  `unknown-flags` (11 — one bogus flag per parser, the two typed inputs, and a
  drift guard that re-extracts every documented command form), `cli-run` (6 —
  the D3/D1/D7 CLI contracts), `config` (5 — D6), `num` (4 — strict
  `finiteOrNull`), `workflow-dead-kernel` (4), `state-race` (1 — an operator
  write during a live run), `state-lock-sites` (3 — two real `strategy`
  processes racing one home, four issued at once, and a `configure` document
  that throws mid-mutation, writing nothing and freeing the lock) and
  `refresh-openrouter-benchmarks` (1 — the refresh script against
  `fixtures/openrouter/`). Existing files lost the
  cases that only covered deleted symbols (`agent-events` 19 -> 13, and the
  `fiveHourTier` case in `route`, which kept its
  `FIVE_HOUR_NEAR_LIMIT_PCT === 75` assertion) and gained coverage for the
  locked state writers, the fixture-migration rule, and the content gate.

## 0.27.0 — one workflow engine

- Fixed: a worker that floods its stdout could kill the kernel. Every chunk of a
  worker's stdout and stderr was appended to one string; a command-code worker
  whose transcript outgrew Node's maximum string length threw
  `RangeError: Invalid string length` inside the stream handler, the kernel died
  as an uncaught exception, and every worker it supervised died with it (seen
  twice on the same action in one day; the trace is in
  `~/.bullswarm/goals/<runId>/stderr.log`). Streams are now captured through a
  bounded buffer that keeps the first and last 16 MiB of each stream, counts what
  it dropped (`captureTruncated` on the attempt observation), and any exception
  raised while reading a worker now fails that attempt instead of the kernel.
  Fatal-signature matching already looked only at the last 4,000 characters, so
  quota and auth detection are unchanged.

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
  under <dir>`, and exits 2 before touching anything — including on the older
  directories that hold only a `workflow.json` and never had a `state.json` at
  all; the workflow home shows
  that same line in its detail pane. `events <runId>` still replays the durable
  JSONL and `runs delete <id> --yes` still removes the directory. Historical
  directories are never modified. The stale-owner reconciliation that used to
  run before every dispatch is gone with the V1 liveness model it served.

- Tests: 818 -> 661. Six V1-only files were deleted
  (`workflow-adaptive`, `workflow-gaps`, `workflow-draft`, `workflow-schema`,
  `workflow-validate`, `workflow-run` — 151 tests); `workflow-runs`,
  `workflow-watch`, `assignments`, `workflow-interruption`, `workflow-steering`
  and `workflow-goal` were rewritten onto the V2 kernel keeping every assertion
  about shared behaviour; `workflow-dashboard` went from 48 cases to 35 — 21
  V1-only cases removed and 2 added with the rewrite, then 6 re-added against V2
  fixtures for the rendering behaviours the removal had dropped (blocked-action
  naming, one segment header per phase or dependency level, the mid-segment
  continuation header, parallel levels grouped in declared order, the narrow
  layout, and auto-follow); and a new `workflow-legacy-runs` (11 tests) proves
  the legacy contract against a synthetic legacy `state.json`.
  `tests/manual-dynamic-real.mjs` (330 lines), a
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
