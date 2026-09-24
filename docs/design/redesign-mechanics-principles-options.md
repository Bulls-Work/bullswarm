# Bullswarm redesign: core mechanics, four principles, and options

Status: proposed, 2026-09-24. Nothing here is built yet.

## Summary

Bullswarm today mixes facts and opinions in its core. It decides a step
"verified" from how the output text looks, tells callers to give every writer
an exact-file territory, adds repair steps on its own, and routes reviews away
from the writer's pools. The review of a week of real runs showed where those
opinions cost the caller and the owner:

- runs marked verified were fixed again later;
- a worker that refused and changed nothing was recorded as verified;
- file territories split one behavior across writers, so the integrator did
  the real work;
- leftovers from one run were lost before the next.

The redesign separates three layers:

1. **Core mechanics.** Facts only, with no assumptions. They work for any kind
   of work: code, docs, research, design.
2. **Four mandatory principles.** These are what make Bullswarm worth using for
   a caller agent. Every one of them must still work with a single subscription.
3. **Options.** The caller turns these on per situation. Bullswarm has no
   preference between them.

A single failure rule runs through all three: **one automatic retry, then the
caller.**

## The four actors

| Actor | Role | Scarce resource |
|---|---|---|
| Person | intent, taste, outward actions (release, push, spend) | attention |
| Caller agent | plans, judges, talks to the person | its context window |
| Bullswarm | runs the work, records facts, remembers across runs | nothing: it is code |
| Workers | each do one bounded outcome | prepaid subscription quota |

Bullswarm turns spare worker quota into progress the caller can trust, and
spends as little of the person's attention and the caller's context as
possible.

## Layer 1: core mechanics

Each mechanic records facts. None of them decides whether work is good.

| Mechanic | What it does | Facts it records |
|---|---|---|
| Pools | Registry of signed-in agent CLI accounts, and how to launch each one headless (provider directories) | models, reasoning options, enabled or not |
| Meters | Reads each pool's quota | used %, reset time, source |
| Selection | Picks a pool that satisfies a step's constraints, using a ranking that can be swapped | every candidate and why it was or was not picked |
| Dispatch | Runs one brief on one pool and supervises the process | exit, crash, silence, timeout, auth or quota errors, tokens, time, event stream, output |
| Workspace snapshot | Captures the work area before and after an attempt | files changed, whether a commit moved |
| Command runner | Runs a given command in the work area | exit code, output tail, whether the command changed the tree |
| Graph | Starts a step when its dependencies' gates are open, up to a concurrency limit; durable state | every event, append-only |
| Revision | Changes the plan while it runs (add, amend, remove, rerun); pause, resume, cancel | what changed and why |
| Observation | Wakes the caller on conditions it chose; the dashboard | nothing new: it reads the facts above |

Changes from today:

- **Added.** The command runner and the workspace snapshot become core. They
  are the raw material for proofs.
- **Removed.** The content heuristic that decides "verified" leaves the core
  (see "Facts that replace the text verdict").

## Layer 2: mandatory principles

| # | Principle | What replaces it if we drop it | Why it is mandatory |
|---|---|---|---|
| P1 | **Spend the quota most at risk of expiring, within what the step needs.** Caller constraints and capability come first; pace ranks what is left. With one pool, it means pacing that pool. | Cheapest first, best model always, fixed pool per task type, round-robin | Prepaid quota expires. Without this, Bullswarm is a slower copy of in-session subagents. |
| P2 | **Facts over claims.** Every "done" label says what backs it: proof commands, a review step, or the caller's acceptance. The writer's own report never counts. Bullswarm records who reviewed as a plain fact and does not prefer any reviewer. | Trust the exit code or the worker's report | Otherwise the caller must re-check everything, which is the largest drain on caller context. |
| P3 | **The caller decides; Bullswarm executes and never blocks.** Bullswarm does not plan and does not wait for a person. A run goes as far as it can, then hands back decisions with options. | Bullswarm plans or classifies goals; approval gates inside runs | The caller holds the context. Blocked runs waste quota windows. |
| P4 | **The caller's attention is scarcest.** Silence while things go well; wake only on decisions; hand back a short digest instead of files. | Per-step status replies; raw output files as the main interface | Otherwise the caller drowns in watching and reading. |

What these principles do **not** include:

- **Reviewer independence.** Which model or provider reviews a step is the
  caller's choice, made through step routing constraints (see Options).
- **File territories.** These are an option.
- **Automatic repair.** This is covered by the failure rule.

## The failure rule: one retry, then the caller

| What failed | The automatic retry | Then |
|---|---|---|
| The process (crash, auth, quota) | once, on another eligible pool, because the pool failed | the caller |
| A gate (failed proof, no changes on a build step, failed review, merge conflict) | once, on the same pool, with the failure attached as handoff | the caller |

Rules that hold throughout:

- **Exhausted quota is not a failure.** A pool that is out of quota makes the
  step wait, and the step says so.
- **Only dependents wait.** Steps that do not depend on the failed one keep
  running (P3).
- **The repair loop becomes one case of this rule.** A failed review step gets
  one fix attempt built from its findings, then the review runs again. If it
  still fails, the step goes to the caller.
- **More rounds are the caller's choice.** `defaults.verifyRounds` (default 1)
  lets the caller allow more.

The watcher output is where a step hands over to the caller:

```
✗ markers needs you · proof failed after 1 retry
  proof  npm run test:e2e -- -g markers → exit 1
         expected marker at (412,318), got (412,0)
  try 1  command-code · gpt-6-luna · 14m · 3 files
  try 2  same pool, failure attached · 9m · 1 file
  still running: unsent, docs · waiting on this: ship, accept
  your call:
    rerun elsewhere  bullswarm workflow step rerun <id> markers --avoid command-code
    change the step  bullswarm workflow plan export <id> → revise
    take over        output: …/out-markers-attempt-2.md
    accept anyway    bullswarm workflow step accept <id> markers --reason "…"
  next: bullswarm workflow watch <id> --until trouble --after 212
```

`step rerun --avoid` and `step accept` are new. When the caller uses "accept
anyway", the record says "accepted by caller", never "proven".

## Facts that replace the text verdict

The content heuristic stops being a verdict. What it was useful for is reported
as facts in the digest:

- no output;
- no files changed;
- the report has no `## Done` section;
- the worker reports N items not done, labeled as the worker's claim.

One fact remains a default gate: **a build step that changed no files and moved
no commit fails.** This is the no-op rule. It catches refusals, such as a
worker that switched itself into plan mode and edited nothing.

A step with no proofs reports `finished · unproven` and still unblocks its
dependents.

## Layer 3: options

| Family | Option | Helps when | Costs |
|---|---|---|---|
| Proof and judgment | **Proofs** (`proofs`): commands a step declares. The worker sees them; Bullswarm runs them after the attempt; a failure closes the gate. | anything a command can check | writing proofs; run time |
| | **Review step**: a judging step with per-requirement evidence, routed wherever the caller chooses | acceptance matters; subjective or cross-cutting work | a strong-model step |
| | **Review rounds** (`defaults.verifyRounds` above 1) | the caller wants more autonomy | may act on wrong findings |
| Routing | **Step routing constraints** (`route`): lane, pools to use or avoid, model family | choosing a reviewer; keeping a rerun off a bad pool | fewer candidates |
| | **Capability floor** (`needs: judgment \| spec-complete`) | mixed work where cheap models fit only precise steps | uses strong quota |
| | **Escalation** after a failed proof, one capability level up | cheap-first, checkable work | extra attempts |
| | **Free pools allowed** | only for machine-checkable work | odd failures (silence, refusals) |
| Coordination | **Handoff**: a retry receives the prior attempt's diff, output and last words; `## Handed on` items are routed to the owning step | retries; long steps | brief size |
| | **Own worktree** (`workspace: own`) | overlapping writers; full-suite proofs; alternative attempts | merge conflicts |
| | **File hints** (`ownedFiles`): scheduling hints in a shared worktree | avoiding collisions | planning effort |
| | **Time boxes** | clean early handoffs | can cut work short |
| | **Digest step** | readers with large inputs | one step of delay |
| Memory | **Project record** (see below) | iteration campaigns on one project | confirming entries |

The skill becomes a set of recipes built from these options. It stops being a
rulebook.

### Workspace

- **Default.** All steps work in one shared worktree.
- **`workspace: own`.** Bullswarm creates a worktree for that step from the
  current state and merges it back when the step's gate passes.
- **Overlapping writers.** Several steps each get their own worktree and are
  merged back in dependency order.
- **Alternatives (later).** Several attempts at one outcome run in separate
  worktrees. A proof, a review step or the caller picks one; the rest are
  discarded.
- **Merge conflicts.** A conflict is a failed gate. The step gets one retry on
  the updated base with the conflict attached, then goes to the caller.

## Proof-carrying steps

Schema, on any action:

```json
"proofs": [
  { "cmd": "npm test -- tests/probe.test.js", "timeoutSec": 120 },
  { "cmd": "node scripts/check-frames.mjs", "cwd": "tools", "expectExit": 0 }
]
```

Semantics for v1:

- **Brief.** The commands are listed in the worker's brief with the words "the
  kernel will run these after you finish".
- **Order.** Bullswarm runs them after the workspace snapshot and before the
  no-op check.
- **Result.** Each proof records `{ status, exit, tail }`. Any failure gives
  `failureKind: failed-proof`, and the failure rule applies: one same-pool
  retry with the proof output as handoff, then the caller.
- **Timeouts.** `timeoutSec` defaults to 120 and is capped at 600.
- **Side effects.** A proof must leave the tree unchanged. A changed tree fails
  the proof with `proof changed the tree`.
- **Shared worktree.** In a shared worktree, writers declare narrow proofs.
  Full suites run on steps that run alone (integration, ship) or in their own
  worktree.
- **No proofs.** A step without proofs is `unproven`. Rubric text for a review
  step is guidance for the reviewer, not a computed verdict.
- **Known gap.** A worker can weaken the test its proof runs. v1 accepts this.
  Later, a review step reruns the declared proofs and checks the diff of the
  test files.

Where it plugs in:

- `ACTION_FIELDS` in `src/workflow/action-validator.js` and
  `V2_PROGRAM_ACTION_FIELDS` in `src/workflow/v2-planner.js` gain `proofs`.
- `buildProgramWorkTask` in `src/workflow/v2-runtime.js` gains the brief
  paragraph.
- `dispatchV2Action` in `src/workflow/v2-dispatch.js` gains the runner.
- `summarizeV2Result` in `src/workflow/v2-outcome.js` gains proof status per
  action.

Replay on a week of real runs. These counts are recorded defects that a proof
on the step that caused them would have failed:

| Run | Caught at the owning step | Not caught |
|---|---|---|
| a 23-step release batch | 7 of 7 | — |
| a 9-writer prototype | 5 | 1 needed a browser |
| a 27-step dashboard tidy-up | 25 | 6 (docs written before the code settled, an unowned file, a release-only check) |

## Project record (cross-run memory)

The name is to be decided. `src/workflow/ledger.js` already means the per-run
requirement ledger, so the new store needs a different name.

- **Key.** The normalized git remote (`host/owner/repo`), with a fallback to a
  hash of the toplevel. Today `projectNameFromRemote` keeps only the last path
  segment, so `acme/app` and `other/app` collide.
- **Location.** On this machine only, in `~/.bullswarm/projects/<slug>/`, as
  `events.jsonl` plus a derived `record.json`. It is never committed, because
  entries hold people's words and private paths.
- **Entry types:**

  | Type | Holds | Closes when |
  |---|---|---|
  | `fact` | commands, ports, gates, conventions such as a commit trailer; optional `key` | a new value is set for the same key |
  | `decision` | a settled choice in force | an explicit `supersedes` |
  | `gap` | a leftover, unfinished item or acceptance concern; optional proof | its proof passes, or the caller closes it |
  | `proof` | a command that should keep passing (a regression check) | the caller retires it |

- **Created.** At the end of a run, Bullswarm proposes entries from three
  sources: acceptance concerns, unresolved requirements, and `## Not done`
  items from the last writing steps. An identical entry adds a sighting instead
  of a duplicate. The caller confirms or drops proposed entries. Proposed
  entries never reach workers.
- **Used:**
  - `bullswarm project show` gives the caller a short summary before planning.
  - Worker briefs get a capped "Project facts" block with confirmed facts and
    decisions only.
  - A gap reaches a worker only when the caller carries it into the run
    (`--carry <id>`).
- **Link to proofs.** A step proof that fails, or is missing, becomes the proof
  of a gap. The gap closes only when that proof passes. Passing proofs build
  up as the project's regression checks.

Evidence from one project's campaign of 11 runs:

- **Repeated prompts.** 35–49% of the sentences in the worker prompts of a run
  repeated project facts.
- **Lost leftovers.** Seven items were still open after later runs.
- **Rediscovered findings.** An audit finding and a commit-trailer decision
  were found again from scratch. The trailer cost a full repair round.
- **A hand-kept log.** The caller was already maintaining its own decisions
  log by hand.

## Outside the principles

- **Constraints.** There is no real alternative:
  - never expose a subscription as an API;
  - never handle credentials;
  - stop recursive delegation (`BULLSWARM_DEPTH`);
  - real data only.
- **Engineering rules.** These concern how the code is built:
  - provider quirks live in provider directories;
  - no runtime dependencies;
  - tests never touch the network;
  - every command works without a person at the keyboard.
- **Premise.** Drive each vendor's own CLI with the accounts the person already
  signed in.

## What changes from today

| Today | Redesign |
|---|---|
| A step is "verified" when the text looks like work (`judgeContent`) | Facts in the digest; `finished · unproven` unless proofs or a review back it; the no-op gate for build steps |
| Kernel adds up to 3 repair and verify rounds on its own | One fix plus one re-review, then the caller; more rounds only if the caller sets `verifyRounds` |
| Evidence steps are routed away from writer pools automatically (`AGENTS.md` doctrine 6) | Reviewer placement is the caller's choice through `route`; who reviewed is recorded as a fact |
| Skill says every writer gets an exact-file territory | `ownedFiles` are scheduling hints; plans are cut by outcome |
| Mechanical failures may walk several pools | One retry on another pool, then the caller |
| `--isolation` for the whole run | `workspace: own` per step; shared by default |
| Each run starts from nothing | Project record carries facts, decisions and gaps |
| Free pools first | Free pools only where the caller allows them |

`AGENTS.md` doctrine items 1, 5, 6 and 7 need rewording when this lands. Saved
runs keep their original semantics, as the current doctrine already requires.

## Examples

### A feature loop on a web widget

1. **Person to caller.** "Markers should land where I click, and unsent
   comments must show."
2. **Caller reads the project.** `bullswarm project show` lists the gates, the
   e2e ports, the commit trailer, and two open gaps: "the off switch has no
   test" and "presence rate 12/s in the protocol vs 10/s in the widget". The
   caller carries both.
3. **Caller writes the program:**
   - `contract`: proof `npm run typecheck`.
   - `markers` and `unsent`: `needs: judgment`; proofs are their unit tests
     plus one e2e spec each.
   - `ship`: runs alone; proofs are the full suite, the bundle size check and a
     trailer check.
   - `accept`: a review step. The caller routes it to a pool other than the
     writers' pools; `verifyRounds: 1`.
4. **Bullswarm runs it.**
   - It routes each slice to the eligible pool with the most expiring quota.
   - `unsent` fails its e2e proof, retries once with the failure attached, and
     passes.
   - `ship` passes.
   - `accept` finds one mismatch, gets one fix and a re-review, and passes.
   - It closes the two carried gaps because their proofs passed, and proposes
     two new gaps from acceptance concerns.
5. **The caller wakes once.** The digest reads: "4 steps proven by 9 commands;
   accepted by review on grok; 2 gaps proposed". The caller confirms one gap,
   drops the other, and shows the person the pull request.

### A batch of small fixes

1. **Caller writes the program.** Six independent steps, each
   `needs: spec-complete` with its own focused test as the proof. Escalation
   and free pools are on. A `gate` step runs the full suite alone. There is no
   review step.
2. **Bullswarm runs it.** One item fails its proof, escalates one capability
   level, and passes.
3. **The digest states what backs the result.** "6 of 6 proven by tests; no
   review." The caller decides whether that is enough, or adds a review step by
   revision.

### A read-only study

The caller sends one `bullswarm run` on the analyze lane with no options. The
result reads "report only, unproven", and the caller spot-checks the claims
that matter. The four principles still apply; none of the options are used.

## Build plan

1. **Caller-feedback fixes** (branch `fix/caller-feedback`): the no-op gate,
   per-attempt diff files, the Command Code tool set, tier and reasoning
   labels, the stale-check fix and the watch buffer fix.
2. **Proof-carrying steps v1:** the field, the brief paragraph, the runner,
   `failed-proof`, and proof status in the digest.
3. **Failure rule:**
   - one retry, then the caller;
   - `verifyRounds` defaults to 1;
   - the watcher's needs-you block;
   - `step rerun --avoid` and `step accept`;
   - `route` constraints, with review placement made opt-in.
4. **Facts instead of the text verdict:** the digest flags and the
   `finished · unproven` label.
5. **Project record v1:** facts, decisions and gaps; `project show`, `note`,
   `confirm` and `--carry`; the brief block; entries proposed at finish.
6. **Workspace per step:** `workspace: own` with merge back and conflicts as
   gate failures.
7. **Later:**
   - alternative attempts;
   - reviews that rerun proofs and check test diffs;
   - the capability floor and escalation;
   - a project page on the dashboard.

## Open risks

- **Flaky proofs in a shared worktree.** Proofs on parallel writers can fail on
  a sibling's half-finished edit. The mitigations are narrow proofs and
  `workspace: own`.
- **Weakened tests.** A test weakened to pass reports as proven until reviews
  rerun proofs against the original test files.
- **Stale project facts.** Facts that outlive reality can steer workers wrong.
  Entries are keyed, briefs show their date and source, and old entries are
  flagged.
- **Extra caller wakes.** One review round by default means more wakes than
  the automatic three-round loop. The caller filters wrong findings earlier in
  exchange.
