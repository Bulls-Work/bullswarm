> Historical (2026-08-31): accurate when written; see CHANGELOG for what changed since.

# Autonomous Workflow V2 Component Probes

**Candidate revision:** `0030e12` plus this evidence note  
**Date:** 2026-08-31  
**Scope:** sequence 15 of `docs/dynamic-workflow-v2-execution-plan.md`

These probes exercised the model-sensitive boundaries separately before any
end-to-end autonomous canary. Every paid call used a Relay GPT-5.6 Luna pool.
No Minimax or Fable model was eligible. A failed or rejected model response
would have stopped the sequence; none occurred.

## Results

| Boundary | Pool and model | Result | Wall | Known tokens | Durable evidence |
| --- | --- | --- | ---: | ---: | --- |
| Initial planner program | `opencode2` / `relay/gpt-5.6-luna` | Accepted by the real V2 planner-response parser without correction | 58.0 s | 1,230 | `~/.bullswarm/runs/out-1788187364874-j3wtn.md` |
| Bounded mutating worker | `opencode2` / `relay/gpt-5.6-luna` | Changed only `src/counter.js` in a disposable repository; external tests passed 2/2 | 32.9 s | 241 | `~/.bullswarm/runs/out-1788187490363-5dkb2.md` |
| Evidence envelope and worker self-validation | `opencode2` / `relay/gpt-5.6-luna` | Worker ran `check-v2-evidence.js`; runtime parser accepted one scoped passing requirement with no concerns | 50.6 s | 487 | `~/.bullswarm/runs/out-1788187584619-o9wjr.md` |
| Consolidated semantic-gap planning | `opencode2` / `relay/gpt-5.6-luna` | Accepted exactly one bounded fix plus one evidence action; no reviewer, repair, or reverify loop | 36.7 s | 756 | `~/.bullswarm/runs/out-1788187686903-z2ubs.md` |
| Authentication replacement | simulated unavailable Luna, then `opencode2:relay-2` / `relay-2/gpt-5.6-luna` | First attempt classified `auth` and quarantined; second pool completed immediately | 0.1 s + 28.6 s | 61 + 168 | isolated route state and output under the temporary `bullswarm-v2-route-y45TRb` fixture |

The routing probe used the production `dispatchV2Action` and `watchOnce`
seam. Only the first connector was synthetic: it emitted an authentication
failure. The replacement was the real configured Relay-2 OpenCode connector.
The probe passed only after asserting the exact attempt order, quarantine
record, two durable decision-log entries, successful output content, and the
replacement model ID. Its isolated Bullswarm home prevented the simulated
failure from quarantining a real user pool.

## Presentation boundaries

The result, quiet-watch, and human-TUI boundaries are deterministic consumers
of durable V2 state, so they were probed without another paid model call:

- native V2 `runs list`, `show`, and stable `result` envelope: 1 focused test
  passed;
- compact V2 watch heartbeat, freshness, terminal result handoff: 1 focused
  test passed; and
- durable timeline, live-agent filtering, narrow/mobile layout, and
  non-clearing spinner repaint: 3 focused tests passed.

The broader result/watch/dashboard component batch passed 54/54 tests. These
checks prove each sequence-15 boundary in isolation. They do not count toward
the sequence-16 five-run end-to-end streak.

## Sequence-15 conclusion

All five model-in-the-loop component probes completed without content
rejection, schema correction, semantic repair loops, ownership violations, or
use of a disallowed model. Planner validity, worker execution, evidence
validation, gap handling, provider replacement, stable result consumption,
quiet watch, and wide/mobile TUI rendering are ready for end-to-end canaries.
