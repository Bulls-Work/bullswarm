> Historical (2026-08-28): accurate when written; see CHANGELOG for what changed since.

# Trending AI repository autonomy experiment — 2026-08-28

## Question

Can the current Bullswarm source checkout autonomously plan, delegate, implement,
and verify real work in unfamiliar, currently trending AI repositories without
operator intervention after launch?

## Frozen protocol

- Research snapshot: GitHub Trending and live repository metadata on 2026-08-28.
- Candidate shortlist: `project-l`, `project-i`,
  `project-o`, and `project-p` (public third-party repositories; owners and URLs omitted).
- Execution subjects: project-l and project-i. They have local, credential-free test
  surfaces and represent JavaScript and Python agent-oriented projects.
- Each subject is a clean, shallow clone at the commit recorded below.
- Dependency installation and baseline tests occur before workflow launch.
- After launch, the operator may only read Bullswarm state/events/logs and target
  repository state. No prompt correction, follow-up action, edit, reroute,
  cancellation, retry, or manual repair is allowed before terminal status.
- After terminal status, independent read-only verification may run tests and
  inspect diffs. It may not repair the result.
- A run counts as autonomous success only when its durable workflow reaches
  `completed`, the requested repository change exists, focused tests pass, the
  original acceptance criteria are met by content, and intervention count is 0.

## Frozen subjects and goals

### project-l

- Repository: public third-party repository (URL omitted)
- Baseline commit: `49a7821d194a70c531219f48fd0d6a08ba9ba9d7`
- Baseline: `npm test` from `project-l/` passed 721 tests with 25 skips (746 total).
- Goal:

> [other project's task text removed]

### project-i

- Repository: public third-party repository (URL omitted)
- Baseline commit: `29025f5a8bfaeed8a8c0daf22c770afd9d023dd0`
- Baseline: 6,257 passed, 24 skipped, 1 pre-existing unrelated failure in a TUI launcher test (test id omitted).
- Issue: an open issue in that repository (URL omitted)
- Goal:

> [other project's task text removed]

## Results

### Outcome

Both frozen workflows completed autonomously. Operator intervention after each
launch was **0**: no prompt corrections, follow-up messages, edits, retries,
reroutes, cancellations, or repairs were made. The observer only read workflow
events/state and, after terminal status, ran independent read-only verification.

| Subject | Run | Result | Elapsed | Dispatches | Adaptive rounds | Known tokens | Cost visibility |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| project-l | `wf-mtchnk88-e8691f` (`awd62a`) | completed | 28m 43s | 5 | 1 | 19,021 | $0.03708 known subtotal; Claude portion unknown |
| project-i | `wf-mtcipy51-ca04c8` (`becfki`) | completed | 46m 05s | 7 | 2 | 31,910 | unknown; Claude and Command Code model rates unavailable |

Both runs stayed below the advisory 30-dispatch and 60-minute planning targets.
Those values were exposed to the orchestrator as planning context and did not
hard-stop or skip any action.

### project-l execution

Bullswarm initially selected Grok 4.6 because its live weekly meter had the most
surplus. The orchestrator created one cohesive discovery/implementation action,
followed by a dependent skeptical verification action and a final decision gate.

| Phase / step | Agent | Status | Known tokens | Evidence |
| --- | --- | --- | ---: | --- |
| Plan 1 / `orchestrator` | Grok 4.6 | succeeded | 3,415 | created bounded find/fix plus verify plan |
| Execute / `find-fix-regression` | Grok 4.6 | succeeded | 1,874 | found, reproduced, fixed, and tested a real bug |
| Verify / `verify-find-fix` | Grok 4.6 | succeeded | 1,597 | independently accepted the content and tests |
| Final gate / `orchestrator` attempt 2 | Grok 4.6 | retryable failure | 5,794 | provider emitted a rate-limit signature |
| Final gate / `orchestrator` attempt 3 | Claude Code | succeeded | 6,341 | Bullswarm quarantined Grok and rerouted without operator help |

The discovered bug and its fix are in the subject repository ([other project's task text removed]). The autonomous result
added a focused 22-line regression test, rebuilt the package archive that the repository's
package-freshness gate requires, and left a worker evidence report, with no commit, push, or PR.

The new test failed against the original implementation (18/19 passing), then
passed with the fix (19/19). The full suite finished at 747 total, 722 passed,
25 skipped, 0 failed. Independent post-terminal verification repeated the 19
focused tests and `git diff --check`; both passed.

### project-i execution

Grok remained quarantined after the project-l rate limit, so Bullswarm selected
Claude Code for orchestration and Command Code for implementation/verification.

| Phase / step | Agent | Elapsed | Status | Known tokens | Evidence |
| --- | --- | ---: | --- | ---: | --- |
| Plan 1 / `orchestrator` | Claude Code | 4m 26s | succeeded | 4,970 | localized the issue and planned fix plus skeptical verify |
| Execute / `implement-fix` | Command Code | 9m 16s | succeeded | 2,326 | implemented the fix and initial tests |
| Verify 1 / `verify-fix` | Command Code | 6m 34s | succeeded | 2,249 | returned a pass, but its evidence was later challenged |
| Gate 2 / `orchestrator` | Claude Code | 5m 28s | succeeded | 8,652 | mutation-tested the result, rejected the weak pass, expanded plan |
| Execute / `strengthen-tests` | Command Code | 12m 39s | succeeded | 2,036 | repaired the identity test and added coverage through the real entry point |
| Verify 2 / `verify-strengthened-tests` | Command Code | 5m 08s | succeeded | 1,716 | independently killed both mutations and ran focused/full suites |
| Final gate / `orchestrator` | Claude Code | 2m 34s | succeeded | 9,961 | spot-checked durable state and declared complete |

The implementation and its design are in the subject repository ([other project's task text removed]). The final diff is two files,
235 insertions and 1 deletion: 21/-1 production lines and 214 test lines.

The important autonomous behavior was the second planning round. Although the
first verifier returned a pass, the Claude gate mutated the code and found that:

1. removing the identity guard from the fix still passed the three initial tests; and
2. restoring the original buggy wiring still passed the relevant tests.

Bullswarm therefore did not complete. It dispatched a test-strengthening worker
and a second verifier. The strengthened tests then killed both mutations: removing
the identity guard fails the replacement-group test, and restoring the original
wiring fails the test that runs through the real entry point.

Independent post-terminal checks confirmed:

- 4/4 strengthened tests pass;
- Ruff passes on both touched Python files;
- `git diff --check` passes;
- the stash is empty and only the intended two files are modified; and
- no commit, push, PR, credentials, or external services were used.

The full suite was run post-fix by autonomous workers and reported 5,337 passed,
8 skipped, and the same single pre-existing TUI launcher failure. The clean
baseline independently demonstrated that failure before launch; it is unrelated
to the active-task change.

### Provider-meter observations

Live project-n snapshots before and after the two runs showed Codex weekly usage
moving from 28% to 30%, Claude from 49% to 50%, and Grok from 26% to 31%.
Command Code remained at 42.0522% weekly / 40.57 credits remaining; its meter did
not expose a visible delta at this granularity. These snapshots are useful quota
signals, not precise per-workflow billing attribution.

### Friction and remaining gaps

The autonomous delivery behavior passed, but the audit exposed four reporting or
efficiency gaps:

1. Claude Code and Command Code attempts record `model: null`; consequently their
   dollar costs cannot be calculated and both run totals are partial.
2. Claude's internal "advisor" activity is visible only as prose in its stream,
   not as a separately attributable Bullswarm agent or usage row.
3. Some Grok tool events normalize to `kind: null`, even though byte activity and
   neighboring read/search actions remain visible.
4. One verifier's early full-suite evidence was tainted by temporarily stashing
   tracked files while its test process was active. That evidence was excluded;
   clean worker, later verifier, baseline, and independent checks supplied the
   accepted proof. The workflow could more explicitly isolate mutation/pre-fix
   checks from concurrent long-running tests.

Post-experiment follow-up adds `workflow watch` for low-noise progress and
terminal timing, captures actual Claude/Command Code model IDs when their event
streams expose them, preserves Grok tool kinds across name-less update frames,
queues optional steering only at future planning checkpoints, and tells the
planner to reuse clean full-suite evidence and isolate mutation/pre-fix checks.
Claude's forwarded-subagent text is now requested for better activity context,
but provider-internal advisor usage still cannot be separately attributed unless
the provider exposes distinct model/usage records in the outer event stream.

Long quiet full-suite periods did not produce false dead-agent decisions: the
event stream showed the last shell action, increasing elapsed silence, and an
active process/output-byte signal until the command finished.

## Conclusion

For these two real, unfamiliar, locally testable AI repositories, Bullswarm met
the frozen autonomy bar: it planned dynamically, delegated work, verified by
content, rerouted around a provider rate limit, rejected a false-positive test
verdict, expanded its plan, and reached completion with zero operator steering.
This is strong evidence for autonomous bounded repository work, not a claim that
every repository or credentialed/browser/deployment workflow is solved. Model and
internal-subagent attribution remain the clearest gaps before calling the audit
and spend breakdown perfect.
