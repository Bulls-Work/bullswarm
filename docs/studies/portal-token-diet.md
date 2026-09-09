# Portal token diet — what transfers to bullswarm

**Verdict.** Portal's headline "90% savings" is not reproducible from Portal's own repository, and the mechanism behind it — a hook that blocks a frontier model from reading big files — has no cheap path into bullswarm today. Every bullswarm dispatch is a full agentic CLI session; read-only dispatches already run a median of 72.1 s, far past Portal's own stated floor where "the overhead of delegation exceeds the savings" (`.study-inputs/article.txt:86`). What does transfer is Portal's *policy*, not its plumbing: name the kinds of work a frontier model is worth, and keep everything else off it. Bullswarm's own 7-day log says that is where the money sits — `claude-opus-5` took 35.6% of dispatches but 75.2% of worker wall-minutes. Build L1 and L5 first. L2 (the hook) is the least justified rung on the ladder.

All numbers below come from a file read or a command run during this study; each is cited. Anything not measured is labelled **unmeasured**.

## 1. What Portal does, and what its 90% counted

Portal's `shunt` plugin has three layers (`.study-inputs/portal-ai-plugins/plugins/shunt/`):

1. **Two PreToolUse hooks.** `hooks/check-file-size` blocks a `Read` when the file exceeds `MIN_LINES="${SHUNT_MIN_LINES:-350}"` (`check-file-size:5`), allowing it through when `offset`/`limit` is set. `hooks/check-bash-read` applies the same rule to `cat/head/tail/less/more`.
2. **Two one-shot scripts** over a single stateless `aika:invoke-chat` call: `bulk-read` (files + a question) and `code-write` (spec + mandatory reference). Transport caps: `SHUNT_TIMEOUT_SECONDS=180` and `SHUNT_MAX_PAYLOAD_BYTES` 400000 on macOS / 120000 on Linux (`scripts/lib/aika.sh:22-30`).
3. **Two skill docs** telling Claude when to delegate. The README states plainly that "only bulk-reader has hook enforcement" (`README.md:190`).

**What the 90% counted.** It is a prose table in `README.md:177-186`: "Tested against a 162K-line Java monorepo", four scenarios at 82% / 94% / 94%, "Mean bulk-read savings: **90%**". There is no Java code and no raw run output anywhere in the repo backing it. The only runnable measurement is `evals/run.sh --benchmark` over three TypeScript fixtures — `wc -l` gives 602, 35 and 55 lines — using `"token_estimate": "chars / 4"` (`evals/benchmarks.json:3`), not a tokenizer. In that harness the code-write row's "with shunt" cost is hardcoded to `0` and its "without" is weighted `output_tokens * 5`. The worker's own token spend and all latency are excluded by the script's own footer.

Two more repo-vs-article discrepancies worth carrying: the article says "Portal caps a single invocation at 30 seconds" while the shipped default is 180 s, and the article never mentions the payload ceiling or the `offset:0`/`limit:0` hook bypass documented in `evals/hook-evals.json:103-116`.

**Portal's own stated limits** (`article.txt:84-86`, quoted): "You can't delegate editing. The worker model's summaries don't include reliable line numbers." — "You can't delegate reasoning… The routing explicitly excludes debugging, architectural decisions, and safety-critical code." — "This is acceptable for large reads, but counterproductive for small ones."

## 2. Applicability to bullswarm

| Measurement | Value | How |
|---|---|---|
| 7-day dispatches | 188 (analyze 85, build 103, **chore 0**) | `node` over `.study-inputs/decision-log-7d.json` |
| `claude-opus-5` | 67 dispatches (35.6%), **1294.3 of 1721.5 wall-min (75.2%)** | same |
| high-effort dispatches | 66; **65 on opus (98.5%)**; 47 of 66 are `build` lane | same |
| opus at applied `xhigh` | 4/188 (2.1%); `reasoning` is null on 180/188 | same |
| token source | **184/188 (97.9%) `estimated:utf8-bytes/4`**, 4 `provider-reported` (all `claude-code`, anomalous shapes) | same |
| pools | claude-code 118, command-code 40, grok 26, opencode2 4 | same |
| failures | 13/188 (6.9%) `ok:false` | same |
| caller skill surface | `SKILL.md` 8,232 B + `references/operations.md` 15,320 B = 23,552 B | `wc -c` |
| planning contract | 10,221 B (`workflow plan contract … --json`); a real planner response 28,204 B | map-caller / map-worker |
| run result envelope | 19,623 B (`workflow runs result 84fc3s --json \| wc -c`) | map-caller |

**Transfers directly.** (a) *Lazy skill surfaces.* Already done: 15,320 B of 23,552 B (65%) is gated behind SKILL.md's own last line ("Read operations.md only when you need steering, cancellation, resume, scouting…"). Treat as do-not-regress. (b) *Cheap pre-digest before an expensive consumer.* `preflight-scout` already is this — `{id:'preflight-scout', lane:'analyze', effort:'low'}` (`src/workflow/v2-runtime.js:686`), 8/8 real dispatches at `low` on haiku-4-5 / gpt-5.6-luna. (c) *Reserve the expensive model for judgment.* Portal's rule inverted.

**Needs adaptation.** Portal's hook is a *mechanical* gate; bullswarm's equivalent is prose. `connectors/claude-code.json:14` passes `--dangerously-skip-permissions` to every worker regardless of lane, so "analyze = read-only" is trust, not a sandbox. Any hook-shaped idea also needs a bounded, non-agentic call mode that does not exist: there is no payload-size input to `pickPool` (`src/lib/route.js`) and no implicit timeout (`connectors/claude-code.json:86`).

**Does not apply.** (a) Portal's savings arithmetic. Its code-write row assumes the caller never reads the result back; bullswarm callers always read out-files (4,786–5,897 B) and result envelopes (19,623 B), so a "0-token" counterfactual would overstate. (b) Portal's chars/4 confidence. `src/lib/spend.js:110-111` already refuses this series: token counts "are `estimated:utf8-bytes/4` in this log and would not survive S1". Wall-clock is bullswarm's only trustworthy budget signal. (c) A chore-lane code-writer backend — 0 of 188 chore dispatches means zero demand.

## 3. Depth ladder

### L1 — Skill and prompt guidance only
- **Mechanism:** fix the one live contradiction and say the effort rule out loud. `src/cli.js:160` defaults `{analyze:'high', …}` while `DEFAULT_EFFORT_BY_LANE` in `src/workflow/action-validator.js:10-14` says `analyze:'medium'`. Align cli/V1/help to `medium`; state in SKILL.md that `high` is exceptional.
- **Files:** `src/cli.js`, `src/workflow/runtime.js`, `src/help.js`, `skill/SKILL.md`, `README.md`.
- **Prerequisites:** none. Zero schema change.
- **Expected saving:** every future `bullswarm run --lane analyze` without `--effort` stops competing for the high tier, which is opus on this machine 65/66 times. 14 log rows have null effort/source (the `run` path); 2 landed on opus. Aggregate saving **unmeasured**.
- **Risks:** callers relying on the undocumented `analyze→high` silently lose opus.
- **Portal limit:** none engaged — this is guidance, not delegation.

### L2 — Caller-side shunt hook, bullswarm as bulk-reader / code-writer backend
- **Mechanism:** a PreToolUse hook in the calling session that redirects large `Read`/`cat` to `bullswarm run --lane analyze`.
- **Files:** `src/lib/route.js`, `src/delegate.js`, `connectors/claude-code.json`, `skill/SKILL.md`, plus a new hook.
- **Prerequisites:** a capped, non-agentic, single-call dispatch mode with sub-30 s observed latency and `offset`/`limit` passthrough. None exists.
- **Expected saving:** **none substantiated.** Portal's own 90% is unreproducible, and bullswarm's I/O-like median is already 72.1 s (map-policy classification over the 188 rows) — above Portal's own "counterproductive for small ones" line. Do not budget a number here.
- **Risks:** the analyze lane is not sandboxed, so a redirected read can still produce edits; a summarizing worker returns no reliable line numbers.
- **Portal limit:** hits all three — no line numbers, no delegated reasoning, and the latency floor is the disqualifier.

### L3 — Worker-side hooks and pre-digest actions in the kernel
- **Mechanism:** two halves. *Refuted half:* inject a shunt hook into dispatched Claude Code workers. *Kept half:* generalize `preflight-scout` into a reusable low-effort **digest** action that reads a worker's `dependencyArtifacts()` (`v2-runtime.js:264-269`) so the consumer is handed a condensed artifact instead of raw out-files.
- **Files:** `src/workflow/v2-planner.js`, `src/workflow/v2-runtime.js`, `src/workflow/action-validator.js`, `skill/references/operations.md`.
- **Prerequisites:** digests must be extractive (quoted lines, file lists, command output) and must **never** feed an `evidenceFor` action — `v2-runtime.js:358` already requires "Independently inspect the actual workspace and dependency artifacts. Do not trust another agent summary as proof."
- **Expected saving:** pattern proven by `preflight-scout` (8/8 at low on cheap pools, 759–924 standardRead tokens, while the planner that consumes it runs high on opus). Byte reduction for the general case is **unmeasured**.
- **Risks:** an evaluative digest is delegated reasoning; a hooked worker would consume the only nested-dispatch headroom (`depthLimit: 2`, `src/lib/state.js`) and cannot be tested honestly, since real pools are forbidden in tests.
- **Portal limit:** "You can't delegate reasoning" — hence extractive-only.

### L4 — Kernel context diet
- **Mechanism:** shrink what the kernel itself puts in front of a model — a `--summary` mode for `workflow runs result`, lazily-referenced rather than inlined dependency envelopes, and a tighter evidence-task footer.
- **Files:** `src/cli.js`, `src/workflow/v2-runtime.js`, `src/workflow/evidence-output.js`.
- **Prerequisites:** a before/after byte harness (§5) so the claim is measurable at merge time.
- **Expected saving:** the targets are real and measured — result envelope 19,623 B for every status check; evidence/integrate task files are the most template-heavy. The kernel-vs-author share itself is **unreconciled**: three lenses defined "kernel" differently (991 fixed chars = 10.1–12.5% counting only literal constants; 29–51% splitting on template markers, 80% for `task-verify-forecast-attempt-1.md`). Do not quote a single percentage until one definition is fixed. Net saving **unmeasured**.
- **Risks:** a caller reading only a summary can miss a partial failure; SKILL.md already warns verified work "can still miss bugs".
- **Portal limit:** the same summary-loses-detail failure Portal names for its thread-safety bug.

### L5 — Frontier reservation policy
- **Mechanism:** three parts. **(i) `kind` → tier.** A closed, kernel-owned enum added to `ACTION_FIELDS` (`action-validator.js:16-19`, today 12 fields, no `kind`): `mechanical | io-read | check | implement | architecture | integration | adversarial-acceptance`. It supplies default effort/reasoning when the author omits them and never names a pool or model. **(ii) Frontier gate.** Extend the existing `model.autoRecommend !== false` filter (`src/lib/strategy.js:467,490`) so a frontier-capable model is eligible only for the three frontier kinds; pace, 5 h forecast and load still choose among the survivors. **(iii) Rungs.** `claude-fable-5` today: `autoRecommend:false`, `$10/$50` per million vs opus `$5/$25` (`connectors/claude-code.json:75`, priced 2026-08-27), and excluded in `.study-inputs/strategy-inventory.json`. `grep -rn Astra src/ connectors/ skill/ README.md` → **0 hits**; do not stub it.
- **Files:** `src/workflow/action-validator.js`, `src/workflow/v2-planner.js`, `src/workflow/v2-dispatch.js`, `src/lib/strategy.js`, `connectors/_schema.json`, `skill/SKILL.md`.
- **Prerequisites:** L1 shipped; the gate must degrade byte-for-byte to today's behavior when `kind` is absent.
- **Expected saving:** the leak is measured — 66 high-effort dispatches consumed 1287.1 of 1721.5 wall-minutes (74.8%), 47 of them in the `build` lane, and 12 of 50 verifier actions were authored `high` and ran 315–1526 s on opus. Wall-minutes recovered are **unmeasured** until the gate exists.
- **Risks:** mis-tagging a mechanical verify as `adversarial-acceptance` recreates today's leak; failing closed on a missing `kind` would starve Fable once un-excluded.
- **Portal limit:** this is Portal's rule inverted — Portal excludes architecture from the cheap worker; bullswarm reserves the expensive worker for it.

## 4. The "worthy of frontier" rule

| Work kind | Should Fable or Astra touch it? | What handles it otherwise |
|---|---|---|
| `mechanical` (deterministic mutation) | No | `chore`/low — cheapest pool by pace (0 real dispatches in 7 d) |
| `io-read` (read, digest, quote) | No | `analyze`/low — haiku-4-5 or gpt-5.6-luna, as `preflight-scout` does today |
| `check` (run fixed acceptance commands) | No | `analyze`/low — 28 of 50 verifies already ran low on luna/grok/haiku |
| `implement` (contextual build work) | No | `build`/medium — sonnet-5 (47 dispatches) or grok-4.6 (26) |
| `architecture` (design, tradeoffs) | Yes, once gated | opus-5 at high until a frontier rung is enabled |
| `integration` (cross-cutting reconcile) | Yes, once gated | opus-5 at high; longest real action was `integrate-continuation` at 11,072 s (`integrate-acceptance` ran 7,558 s) |
| `adversarial-acceptance` (interpreting ambiguous evidence) | Yes, once gated | opus-5 at high — the 12 long high verifies belong here, not in `check` |

Conditions on the "yes" rows: an extractive digest runs first; Fable stays user-excluded until the gate ships; Astra is never added without a real connector.

## 5. Measurement plan

**Which pools report real tokens: none, today.** `connectors/claude-code.json:45-47` extracts only `{"path":"result"}` from the stream-json `result` event; the sibling `usage` object is discarded before `src/lib/usage.js` runs. The other four real connectors extract text only. The 4 `provider-reported` rows are noise from `--forward-subagent-text` (`standardRead: 2` with `cacheRead` 32k–418k) — not a working path. **Prerequisite experiment:** capture one live `claude --output-format stream-json` run and confirm the `usage` field's actual shape before writing any extraction rule. Both lenses that proposed this (`surface-instream-usage`, `capture-claude-usage-event`) are the same fix and neither verified the premise.

**What the before/after harness records,** per attempt: `actionId`, `lane`, `effort`, `kind` (once it exists), `pool`, `model`, `wallSec`, `ok`, task-file bytes, out-file bytes, and `tokenSource` verbatim. Any token delta is stored as `frontierTokensAvoided` and **labelled estimated** — it is `estimateTextTokens` (`usage.js:14`), a bytes/4 proxy, exactly the heuristic that makes Portal's own 90% untrustworthy. Wall-minutes by kind is the primary series.

**First experiment.** Ship L1, then re-run the same decision-log aggregation over the following 7 days and compare two numbers against this baseline: high-effort share (66/188 = 35.1%) and opus wall-minute share (75.2%). It needs no schema change, no new field, and the baseline already exists.

## 6. Refuted ideas

| Idea | Why it fails |
|---|---|
| Caller-side or worker-side shunt hook redirecting large reads to bullswarm | No bounded non-agentic call mode; I/O-like median is already 72.1 s, past Portal's own latency floor. The worker-side variant also burns the only nested-dispatch headroom (`depthLimit: 2`) and cannot be tested — real pools are forbidden in tests. |
| Chore-lane code-writer backend | 0 of 188 chore dispatches in 7 days. Building a backend for a lane nobody uses is speculation. |
| Treat `--forward-subagent-text` leakage as real usage reporting | The 4 rows have implausible shapes (`standardRead: 2`, `cacheRead` up to 418,218). Encoding a regex accident as a feature. |
| Gate frontier access on token counts or estimated USD | 184/188 are estimates; `spend.js:111` already says these "would not survive S1". Task-file bytes are dominated by kernel boilerplate anyway. |
| Keep architecture work on the calling session, Portal-style | Inverts `R5` (`src/lib/route.js:13`): "The caller wins its lane only when no eligible delegate remains — it has to WIN, not be protected." Also shifts spend onto the user's own session rather than saving it. |
| Blanket-ban `effort: high` on verifier actions | Some of the 12 are genuine adversarial acceptance; the planner already distinguishes "deterministic acceptance commands = low" from "interpreting ambiguous cross-cutting acceptance evidence = high". `kind` separates them; an id-prefix rule cannot. |

## 7. Recommended order of work

1. **L1 — align the `analyze` effort default** (`cli.js:160`, `runtime.js`, `help.js`). One contradiction, zero schema change, immediate effect on every `bullswarm run`.
2. **Measurement baseline** — freeze today's aggregates (§2 table) and add the `pctReal`/`sampleCount` usage report so the 97.9%-estimated fact is visible instead of buried.
3. **L5(i) — the `kind` enum**, closed and kernel-resolved, defaulting effort when omitted. This is the field everything else in the ladder depends on.
4. **L5(ii) — the frontier gate**, built as an extension of `autoRecommend`, degrading to current behavior when `kind` is absent.
5. **Budget advisories** on `plan validate` / `run --dry-run` using `spend.js:expectedMinutesFor` — wall-minutes only, never estimated tokens, and never blocking (matching `RS5`: resolution never blocks a dispatch).
6. **L3 digest action** (extractive, never for `evidenceFor`) and **L4 `--summary` envelope**, each shipping with its own before/after byte measurement.
7. **L2** only if a capped single-call dispatch mode is ever built for other reasons. Do not build it for this.

**Build first: L1 plus the measurement baseline.** Everything else on this ladder is currently unmeasured, and without the baseline there is no way to tell whether the gate worked.

## Status (2026-09-09)

**Shipped.** L1 (analyze default medium) and L5(i) (the closed `kind` enum) shipped in 0.26.0 — CHANGELOG 0.26.0: "`bullswarm run --lane analyze` now defaults to `medium` effort instead of `high`" and "The optional `kind` field takes one of seven values — `mechanical`, `io-read`, `check`, `implement`, `integration`, `architecture`, `adversarial-acceptance`". L4 (`workflow runs result --summary`, per-attempt byte accounting) and L3 (`kind: "digest"`) ship in 0.28.0. Digest is an eighth kind (`digest=analyze/low`); `workflow plan contract --json` lists it in `rules[5]` and states the extractive rule as `rules[6]`.

**Measured** on the real 0.27.1 build run `ze5xz2` (files under `.diet-inputs/`; commands and figures are in CHANGELOG 0.28.0). The full result envelope is 60,709 bytes on disk (`wc -c .diet-inputs/real-result-ze5xz2.json` / `tests/fixtures/real-result-ze5xz2.json`). Compact `--summary` of that same fixture is 3,786 bytes (`tests/workflow-result-summary.test.js` prints `result-summary size: full=57141 summary=3786`; 57,141 is `JSON.stringify` of the parsed envelope). The integrator's task file is 14,768 bytes (`wc -c .diet-inputs/task-integrate-attempt-1.md`); its seven dependency out-files sum to 46,022 bytes; those two together are 60,790 — the figure the 0.28.0 goal named as integrator inputs. The fixture before/after comparison is now measured too: running the same goal twice under a temporary home (`tests/workflow-context-diet-measurement.test.js`), three padded writers feeding one integrator directly give it 12,477 bytes of `dependencyInputs`; putting a `kind: "digest"` between them drops that to 63 bytes. The 63 is a floor — the deterministic fixture worker answers with a fixed stub rather than really condensing — so the test also asserts the saving against the ceiling, the 8,192-byte target the kernel writes into that digest's own task (8,192 < 12,477).

**Not scheduled.** Real token accounting (§5), wall-minute budget advisories (§7 item 5), and the frontier gate (L5 ii) are recorded as potential roadmap items, not scheduled.

**Not planned.** L2 (caller-side shunt hook) is not planned. §7 item 7 still holds: do not build it for this.
