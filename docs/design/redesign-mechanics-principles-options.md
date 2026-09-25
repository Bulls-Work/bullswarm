# Bullswarm redesign: core mechanics, four principles, options and patterns

Status: proposed, 2026-09-24. Nothing here is built yet.

## Summary

Bullswarm runs other agents for a caller agent. Today its core mixes facts with
opinions, and it assumes the work is code:

- it decides a step "verified" from how the output text looks;
- it tells callers to give every writer an exact-file territory;
- it adds repair steps on its own;
- it routes reviews away from the writer's pools;
- its vocabulary is about files, diffs and tests.

A week of real runs showed the cost of that:

- runs marked verified were fixed again later;
- a worker that refused and changed nothing was recorded as verified;
- file territories split one behavior across writers, so the integrator did
  the real work;
- leftovers from one run were lost before the next.

Non-code work also had to be squeezed into code-shaped lanes and briefs:
research, image generation, audits and evaluations.

The redesign has four parts:

1. **Core mechanics.** Facts only, with no assumptions, for any kind of work.
2. **Four mandatory principles.** These make Bullswarm worth using, and they
   still work with a single subscription.
3. **Options.** The caller turns these on per situation. Domain-specific
   options are grouped into packs.
4. **Patterns.** A library of example shapes for many kinds of work, plus the
   caller's and the person's own saved patterns. Patterns are for inspiration,
   not for running as-is.

One failure rule runs through all of it: **one automatic retry, then the
caller.**

## What Bullswarm is for

Use Bullswarm when the work benefits from more than one agent in at least one
of these ways:

| Reason | Meaning | Examples |
|---|---|---|
| Breadth | many parts done at once | research several sources in parallel; triage 200 tickets; fix six issues |
| Depth | work that outlives one session | a multi-hour build; a week-long campaign |
| Diversity | different models give genuinely different answers | three design concepts; opposing arguments on a decision |
| Independence | the checker is not the maker | fact-check a report; review a change |
| Economy | spreading work across prepaid quota | bulk extraction on spare quota |

If a task needs none of these, the caller should do it itself.

## The four actors

| Actor | Role | Scarce resource |
|---|---|---|
| Person | intent, taste, outward actions (release, publish, send, spend) | attention |
| Caller agent | plans, judges, talks to the person | its context window |
| Bullswarm | runs the work, records facts, remembers across runs | nothing: it is code |
| Workers | each do one bounded outcome | prepaid subscription quota |

## A step: role, deliverable, evidence

Every step is described in the same three terms, whatever the domain.

- **Role**: what kind of work the step does.

  | Role | Does | Today's kind |
  |---|---|---|
  | investigate | reads, searches, measures; reports | `io-read`, `architecture` |
  | produce | creates something new | `implement` |
  | transform | changes many items mechanically | `mechanical` |
  | combine | joins or condenses other steps' results | `integration`, `digest` |
  | check | judges something against criteria | `check`, `adversarial-acceptance` |
  | act | changes the outside world (send, post, publish, deploy) | none |

- **Deliverable**: what the step promises to leave behind. One of:
  - files (code, docs, images);
  - a report (the step's own output);
  - structured data (JSON that must match a schema);
  - media;
  - outward actions (drafts, or actions taken).
- **Evidence**: what backs "done":

  | Evidence | Backed by | Examples |
  |---|---|---|
  | command | a fact: a command's exit code | tests, a link checker, an image-size check |
  | schema | a fact: validation against a schema | extracted records match the format |
  | review | a judgment by another step against a rubric | every claim traces to a source the checker opened |
  | choice | the caller or the person picked it | "concept B, chosen by the person" |

## Layer 1: core mechanics

Each mechanic records facts. None of them decides whether work is good.

| Mechanic | What it does | Facts it records |
|---|---|---|
| Pools | Registry of signed-in agent CLI accounts, and how to launch each one headless (provider directories) | models, reasoning options, enabled or not |
| Meters | Reads each pool's quota | used %, reset time, source |
| Selection | Picks a pool that satisfies a step's constraints, using a ranking that can be swapped | every candidate and why it was or was not picked |
| Dispatch | Runs one brief on one pool and supervises the process | exit, crash, silence, timeout, auth or quota errors, tokens, time, event stream, output |
| Deliverable snapshot | Records what the step's declared deliverable looks like before and after | files changed, data produced, actions recorded |
| Evidence runner | Runs declared command and schema evidence | exit code or validation result, output tail, whether it changed anything |
| Graph | Starts a step when its dependencies' gates are open; durable state | every event, append-only |
| Revision | Changes the plan while it runs (add, amend, remove, rerun); pause, resume, cancel | what changed and why |
| Observation | Wakes the caller on conditions it chose; the dashboard | nothing new: it reads the facts above |

For software, the deliverable snapshot is the git diff, which is what exists
today. The content heuristic that decides "verified" leaves the core.

The failure rule makes one exception to automatic recovery: an `act` step has no
automatic retry once its worker starts, so an outward action is never repeated
by retry. A started step that needs the caller returns a needs-you block. Choose
one of its four commands, then relaunch the printed `next:` watch line. A usage
limit, or no free pool, returns a needs-you block at once too, with the time
the pool is back when that is known. Accepting records evidence `choice`, never
proof.

## Layer 2: mandatory principles

| # | Principle | What replaces it if we drop it | Why it is mandatory |
|---|---|---|---|
| P1 | **Spend the quota most at risk of expiring, within what the step needs.** Caller constraints and capability come first; pace ranks what is left. With one pool, it means pacing that pool. | cheapest first, best model always, fixed pools, round-robin | Prepaid quota expires. Without this, Bullswarm is a slower copy of in-session subagents. |
| P2 | **Facts over claims.** Every "done" label names its evidence: command, schema, review or choice. The worker's own report never counts. Who reviewed is recorded as a fact; Bullswarm prefers no reviewer. | trust the exit code or the worker's report | Otherwise the caller must re-check everything. |
| P3 | **The caller decides; Bullswarm executes and never blocks.** Bullswarm does not plan and does not wait for a person. A run goes as far as it can, then hands back decisions with options. Outward actions happen only in steps whose program says so; every other step produces drafts. | Bullswarm plans; approval gates inside runs; workers act on the world whenever they like | The caller holds the context. Blocked runs waste quota windows. Irreversible actions must be deliberate. |
| P4 | **The caller's attention is scarcest.** Silence while things go well; wake only on decisions; hand back a short digest instead of files. | per-step status replies; raw outputs as the interface | Otherwise the caller drowns. |

What these principles do **not** include:

- **Reviewer independence.** This is the caller's choice, through step routing
  constraints.
- **File territories.** These are part of the software pack.
- **Automatic repair.** This is covered by the failure rule.

## The failure rule: one retry, then the caller

| What failed | The automatic retry | Then |
|---|---|---|
| A process failure (crash, sign-in failure, provider error) | one retry on another eligible pool; the same pool if it is the only candidate (except auth) | the caller |
| A gate failure (failed evidence, deliverable not produced, report format, output check) | one retry on the same pool, with the failure attached | the caller |
| A usage limit (a spent 5-hour or weekly window, or no credit left), or no capable pool free | none: no wait, no move, no retry; a transient rate limit backs off on the same pool at most twice first | the caller (owner decision, 2026-09-25) |
| An `act` step after its worker starts | no automatic retry | the caller |

Rules that hold throughout:

- **A usage limit goes to the caller.** It ends the step at once; nothing
  waits for a pool or moves the step by itself. The caller reruns it
  elsewhere, waits for the pool, accepts or cancels.
- **A spent or dead pool is never remembered across steps** (owner decision,
  2026-09-25). Nothing pauses or benches a pool; each pick reads the live
  meters, so a window at 100% keeps a pool out until its reset. After a
  sign-in failure the step's retry skips the pools that share the dead
  credential, for that step only.
- **Only dependents wait.** Steps that do not depend on the failed one keep
  running.
- **A failed review** gets one fix step built from its findings and one
  re-review. If it still fails, the step goes to the caller.
- **More fix cycles** are the caller's choice (`defaults.verifyRounds`,
  0–3, default 1; 0 means review only). Saved runs keep their original rules.
- **Review placement** is the caller's choice through `route`; Bullswarm records
  who reviewed and whether that provider also wrote the work.

The watcher is where a step hands over to the caller:

```
✗ variants needs you · schema failed after 1 retry
  evidence  node check-assets.mjs out/ → exit 1
            banner-b.png is 1536×1024, expected 1600×533
  try 1  pool-a · image model · 11m · 3 files
  try 2  same pool, failure attached · 7m · 3 files
  still running: copy · waiting on this: pick
  your call:
    rerun elsewhere  bullswarm workflow step rerun <id> variants --avoid pool-a
    change the step  bullswarm workflow plan export <id> --out plan.json → plan revise <id> --program plan.json
    take over        output: <absolute output path>
    accept anyway    bullswarm workflow step accept <id> variants --reason "…"
  next: bullswarm workflow watch <id> --until trouble --after <sequence> --since <iso>
```

`step rerun --avoid` and `step accept` are new. "Accept anyway" is recorded as
evidence `choice`, never as `command` or `review`.

## Facts that replace the text verdict

What the content heuristic was useful for becomes facts in the digest:

- no output;
- the deliverable was not produced;
- the report has no `## Done` section;
- the worker reports N items not done, labeled as the worker's claim.

One fact remains a default gate: **a step whose declared deliverable was not
produced fails.** This gate catches refusals, such as a worker that switched
itself into plan mode and edited nothing. Two details:

- **Software form.** A produce or transform step with a file deliverable that
  changed no files and moved no commit fails.
- **Act steps.** An act step's deliverable is its recorded actions, so it is
  not judged by files.

A step without evidence reports `finished · unproven` unless a review passes
the requirements it affects, and still unblocks its dependents.

## Layer 3: options

### General options

| Family | Option | Helps when | Costs |
|---|---|---|---|
| Evidence | **Command and schema evidence** (`evidence`): the worker sees it; Bullswarm runs it; a failure closes the gate | anything a machine can check | writing checks; run time |
| | **Review step**: a check step with per-requirement findings, routed wherever the caller chooses | judgment, subjective or cross-cutting work | a strong-model step |
| | **Review rounds** above 1 | the caller wants more autonomy | may act on wrong findings |
| Routing | **Step routing constraints** (`route`): lane, pools to use or avoid, model family | choosing a reviewer; keeping a rerun off a bad pool; diversity | fewer candidates |
| | **Capability floor** (`needs: judgment \| spec-complete`) | mixed work where cheaper models fit only precise steps | uses strong quota |
| | **Escalation** after failed evidence, one capability level up | cheap-first, checkable work | extra attempts |
| | **Free pools allowed** | only for machine-checkable work | odd failures |
| Coordination | **Handoff**: a retry receives the prior attempt's output, deliverable and last words; `## Handed on` items are routed to the owning step | retries; long steps | brief size |
| | **Variants** (later): N attempts at one outcome; evidence, a review step or a choice picks one | diversity; creative work; uncertain approaches | N times the quota |
| | **Time boxes** | clean early handoffs | can cut work short |
| | **Digest step** | readers with large inputs | one step of delay |
| Memory | **Project record** | campaigns on one project | confirming entries |

### Packs

| Pack | Options |
|---|---|
| Software | own worktree per step (`workspace: own`, merged back when the gate passes); file hints (`ownedFiles`) in a shared worktree; test commands as evidence; a ship step for gates, commits and pull requests |
| Research | source tracing (every claim cites a source the checker can open); synthesis steps; claim-check review |
| Content | variants plus choice; format checks (size, length, dimensions) as command evidence |
| Operations | drafts before actions; act steps that name the actions they may take; read-back evidence (fetch what was sent or created) |

In the software pack, the worktree default is shared. A step marked
`workspace: own` gets its own worktree, created from the current state and
merged back when its gate passes. A merge conflict is a failed gate.

## Evidence in detail

Schema, on any step:

```json
{
  "evidence": [
    { "type": "command", "cmd": "npm test -- tests/probe.test.js", "timeoutSec": 120 },
    { "type": "schema", "file": "out/records.json", "schema": "schemas/record.json" }
  ]
}
```

Semantics for v1:

- **Brief.** Evidence is listed in the worker's brief with the words "Bullswarm
  will run these after you finish".
- **Order.** Bullswarm runs evidence after the deliverable snapshot, once the
  "not produced" gate has passed; a step that produced nothing is not checked.
- **Result.** Each item records its type, status, exit, output tail and any
  side-effect facts. A failure gives `failureKind: failed-evidence`; one retry
  runs on the same pool with the failure attached. After that, the step returns
  to the caller. An act step and a check that cannot run go to the caller
  without a retry.
- **Timeouts.** `timeoutSec` defaults to 120 and is capped at 600.
- **Side effects.** Evidence must not change the deliverable (tracked files,
  declared paths or owned files). A change fails the item; untracked
  by-products are recorded. A failed check on an act step goes to the caller
  without a retry.
- **No evidence.** In a new run, a finished step without evidence reads
  `proven by review` once a review passes every requirement it affects,
  `review pending` while a review step still covers them, and `finished ·
  unproven` otherwise. Passing command or schema checks add `proven by command`
  or `proven by schema`. Labels are derived, not saved: runs started before
  this version show labels only on steps that declare evidence. Review rubrics
  are guidance for the reviewing step, not computed verdicts.
- **Known gap.** A worker can weaken the check its evidence runs. v1 accepts
  this and records when a schema file changed; later, review steps rerun
  declared evidence and inspect changes to check files.

Where it plugs in:

- `ACTION_FIELDS` in `src/workflow/action-validator.js` and
  `V2_PROGRAM_ACTION_FIELDS` in `src/workflow/v2-planner.js`;
- `buildProgramWorkTask` in `src/workflow/v2-runtime.js`;
- `dispatchV2Action` in `src/workflow/v2-dispatch.js`;
- `summarizeV2Result` in `src/workflow/v2-outcome.js`.

Replay on three real software runs, measured on 2026-09-25 with offline
checks against each run's recorded defect and fixed trees. A defect counts as
caught, observed only when a check that could have been declared when the
owning step ran failed on the defect tree and passed on the fixed tree; argued
when no tree pair exists or the check depends on a file the fix changed; not
caught when it needs a browser or a judgment or no step owned the file; and
inconclusive when the fixed tree fails too.

| Run | Defects | Caught, observed | Caught, argued | Not caught | Inconclusive |
|---|---:|---:|---:|---:|---:|
| a 23-step release batch | 9 | 5 | 1 | 1 | 2 |
| a 9-writer prototype | 6 | 3 | 0 | 3 | 0 |
| a 27-step dashboard tidy-up | 44 | 11 | 12 | 20 | 1 |
| Total | 59 | 19 | 13 | 24 | 3 |

The earlier estimates (7 of 7; 5 caught and 1 not; 25 caught and 6 not) were
not supported by the replay. 18 of the 19 observed catches needed a new check
the caller would write from the step's prompt, and only 1 came from a check
already in the repository.

## Project record

The record is cross-run memory for one project. Its name is to be decided,
because `src/workflow/ledger.js` already names the per-run requirement ledger.

- **Key.** The normalized git remote (`host/owner/repo`), or a hash of the
  folder for non-git work. Today `projectNameFromRemote` keeps only the last
  path segment, so `acme/app` and `other/app` collide.
- **Location.** On this machine only, in `~/.bullswarm/projects/<slug>/`. It is
  never committed.
- **Entry types:**

  | Type | Holds | Closes when |
  |---|---|---|
  | fact | commands, conventions, sources, style rules; optional `key` | a new value for the same key |
  | decision | a settled choice in force | an explicit `supersedes` |
  | gap | a leftover, unfinished item or reviewer concern; optional evidence | its evidence passes, or the caller closes it |
  | check | evidence that should keep passing | the caller retires it |

- **Created.** At the end of a run, Bullswarm proposes entries from:
  - reviewer concerns;
  - unresolved requirements;
  - `## Not done` items from the last producing steps.

  An identical entry adds a sighting instead of a duplicate. The caller
  confirms or drops proposals. Proposed entries never reach workers.
- **Used:**
  - `bullswarm project show` before planning;
  - a capped "Project facts" block (confirmed facts and decisions) in briefs;
  - gaps only when carried (`--carry <id>`).

Evidence from one campaign of 11 runs:

- 35–49% of the sentences in the worker prompts of a run repeated project
  facts;
- seven leftovers stayed open after later runs;
- a convention decision was rediscovered at the cost of a repair round;
- the caller kept its own decisions log by hand.

## Patterns

A pattern is a short card describing a shape of work: when to reach for it,
the steps as role, deliverable and evidence, what the caller decides, what
backs "done", where more than one provider helps, pitfalls, and neighboring
patterns.

- **Inspiration, not a program.** Cards are prose sketches with no JSON and
  nothing runnable. The caller writes its own program.
- **Depth.** 40–80 lines per card. The caller reads a one-line index (about
  4 KB for 40 cards) and opens 1–3 cards, under 12 KB in all.
- **Grounded in real runs.** Pitfalls come from real runs where we have them.
- **Checked against the kernel.** A test fails if a card names a role, option
  or evidence type that does not exist.

### Where patterns come from

Patterns live in tiers, like providers:

| Tier | Location | Who sees it |
|---|---|---|
| Built-in | `skill/patterns/` in the package | everyone |
| Contributed | `patterns/contrib/` in the package | everyone |
| Project | `.bullswarm/patterns/` in a repo | whoever uses that repo |
| Personal | `~/.bullswarm/patterns/` | this machine only |

A project or personal card with the same name as a built-in card is listed
next to it, not instead of it.

### Saving a good run as a pattern

To replicate a run, there are two routes:

- **Exact replay, private.** `bullswarm workflow plan export <id>` gives the
  full program, prompts included, to adapt for a similar run. This exists
  today.
- **A reusable, shareable card.** `bullswarm patterns save <id> --name <slug>
  [--scope personal|project]` drafts a card from a finished run:
  - the shape, from the graph: roles, dependencies and which steps ran in
    parallel;
  - the evidence the steps used;
  - pitfalls taken from facts: failed attempts, retries, caller revisions and
    their summaries.

  The caller then writes the "reach for it when" section and edits the
  pitfalls.

Privacy rules for saved cards:

- A draft never copies prompts, goal text, paths or pool account names.
- A project-scope save runs the repository's forbidden-word check, when there
  is one, before writing.
- Sharing a card means sharing a file. There is no Bullswarm service.

### Catalog (first version, about 40 cards)

| Family | Cards |
|---|---|
| Research | single deep study · multi-source research · landscape scan · root-cause hunt · measurement study |
| Exploration | many angles · design variants · naming and copy options · prototype spikes · argue both sides |
| Mass items | bulk transform · triage at scale · extract to structured data · bulk code migration · batch of independent fixes |
| Produce | feature slices · long document · content pack from one source · data pipeline · visual assets |
| Review and audit | parallel review then verify each finding · security and privacy scan · consistency audit · evaluate a list of suggestions · review past work against hypotheses |
| Decide | compare options against criteria · pre-mortem · estimate and size |
| Operations | triage with drafts, then act on approved · release · outreach batch · recurring check-in |
| Campaigns | build, try, fix loop · explore, decide, build · work down a backlog from the project record |
| Meta | scout first · critique the plan before launch |

Draft index and reference cards: `docs/design/patterns/`.

### Effect on the skill

The skill shrinks to four things:

- the four principles;
- the step vocabulary (role, deliverable, evidence);
- the options;
- the instruction "find the closest pattern, adapt it, don't copy it".

The software guidance moves into software cards: feature slices, batch of
fixes, bulk code migration, release, and build, try, fix. That covers
territories, integrators and ship gates.

## Outside the principles

- **Constraints.** There is no real alternative:
  - never expose a subscription as an API;
  - never handle credentials;
  - stop recursive delegation (`BULLSWARM_DEPTH`);
  - real data only.
- **Engineering rules.**
  - provider quirks live in provider directories;
  - no runtime dependencies;
  - tests never touch the network;
  - every command works without a person at the keyboard.
- **Premise.** Drive each vendor's own CLI with the accounts the person already
  signed in.

## What changes from today

| Today | Redesign |
|---|---|
| Kinds and lanes about code | roles, deliverables and evidence for any work; software is a pack |
| A step is "verified" when the text looks like work | evidence names what backs "done"; `finished · unproven` otherwise; a "deliverable not produced" gate |
| Kernel adds up to 3 repair and verify rounds on its own | one fix plus one re-review, then the caller; more only if the caller sets it |
| Evidence steps routed away from writer pools automatically | the caller places reviews with `route`; who reviewed is recorded |
| Exact-file territories for every writer | file hints in the software pack; plans cut by outcome |
| Mechanical failures may walk several pools | one retry on another pool, then the caller |
| `--isolation` for the whole run | `workspace: own` per step (software pack) |
| Workers may act on the outside world when prompted | act steps declare their actions; other steps produce drafts |
| Each run starts from nothing | the project record carries facts, decisions and gaps |
| A rulebook skill | a small skill plus a pattern library, with personal and project patterns |
| Free pools first | free pools only where the caller allows them |

`AGENTS.md` doctrine items 1, 5, 6 and 7 need rewording when this lands. Saved
runs keep their original semantics.

## Examples

### Research: many angles

1. **The person asks** whether to price the product per seat or per usage.
2. **The caller** picks the "many angles" card and writes four investigate
   steps, one lens each: customers, competitors, cost to serve, and a skeptic.
   It routes them to three different providers for diversity. Each report must
   cite a source per claim. A combine step maps agreements and conflicts, and a
   check step opens a sample of the cited sources.
3. **Bullswarm** runs the four angles in parallel on the most expiring quota.
   One angle's report fails the check (two uncited claims), gets one retry with
   the finding attached, and passes.
4. **The digest** says: "4 angles and 1 comparison; claims checked by review;
   2 conflicts need a decision". The caller brings the two conflicts to the
   person. The decision is recorded in the project record. A build run may
   follow.

### Mass items: triage 300 support tickets

1. **The caller** picks "triage at scale".
   - A transform step classifies batches of 50 tickets into a JSON file per
     batch. Evidence is `schema`. Cheap pools are allowed, with escalation.
   - A check step reviews a random 5% sample against the rubric.
   - A produce step drafts replies for the "urgent" class.
   - There is no act step.
2. **Bullswarm** fans the batches out across spare quota. One batch fails its
   schema, retries, and passes. The sample review flags one mislabeled
   category.
3. **The digest** says: "300 classified (schema-valid); sample review 14 of 15
   correct; 22 drafts ready". The caller shows the person the drafts. Sending
   is a separate run with an act step.

### Software: a feature loop

1. **The caller** reads `bullswarm project show`: gates, ports, conventions,
   and two open gaps, which it carries. It picks the "feature slices" and
   "build, try, fix" cards.
   - A contract step, with command evidence: a type check.
   - Two outcome slices, each with unit and end-to-end tests as evidence.
   - A ship step that runs alone: the full suite, bundle size, the commit
     convention.
   - A review step on a pool the caller chose.
2. **Bullswarm** runs it.
   - One slice fails its end-to-end test, retries with the failure, and
     passes.
   - The review finds one mismatch, gets one fix and a re-review, and passes.
   - The two carried gaps close because their evidence passed. Two new gaps
     are proposed.
3. **The caller** wakes once, confirms one gap, and shows the person the pull
   request.

### A read-only study

The caller sends one `bullswarm run` with no options. The result reads "report
only, unproven", and the caller spot-checks what matters.

## Build plan

1. **Caller-feedback fixes** (branch `fix/caller-feedback`). Before merging,
   change the no-op gate to "declared deliverable not produced", or limit it to
   file deliverables.
2. **Step vocabulary.** Roles, deliverables and evidence types, with today's
   kinds each belonging to one role while keeping their exact routing.
3. **Evidence v1.** Command and schema evidence, the brief paragraph, the
   runner, `failed-evidence`, evidence in the digest, and the `proven by` /
   `finished · unproven` labels.
4. **Failure rule.** One retry, then the caller; `verifyRounds` default 1; the
   watcher's needs-you block; `step rerun --avoid`, `step accept`, `route`;
   review placement becomes opt-in.
5. **Facts instead of the text verdict.** The digest flags and the
   `finished · unproven` label; act steps and the drafts-by-default rule.
6. **Patterns.** The index, the catalog cards, `bullswarm patterns` (list,
   show, save), the tiers, the drift test, and the smaller skill.
7. **Project record v1.**
8. **Software pack.** `workspace: own` per step, with merge back.
9. **Later.** Variants, reviews that rerun evidence, the capability floor and
   escalation, and a project page on the dashboard.

## Open risks

- **Flaky evidence in a shared worktree.** Mitigations: narrow checks and
  `workspace: own`.
- **Weakened checks.** A check weakened to pass reports as passed until review
  steps rerun evidence against the original check files.
- **Stale project facts.** Mitigations: keys, dates and sources shown in
  briefs; old entries flagged.
- **More caller wakes.** One review round by default wakes the caller more
  often than the three automatic rounds did.
- **Copied patterns.** Callers may copy patterns rather than adapt them.
  Mitigation: prose-only cards, and the skill's "adapt, don't copy".
- **Pattern sprawl.** Mitigation: the index stays one line per card, and cards
  that duplicate each other are merged.
