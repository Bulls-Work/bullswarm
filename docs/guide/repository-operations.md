---
title: Repository operations
permalink: /guide/repository-operations/
---

`scripts/issue-watcher/` is a launchd agent (macOS's built-in job scheduler)
that watches this repository's GitHub issues. Idle it costs zero model tokens — a pass is one `gh issue
list` and nothing else. When an issue arrives that is new since install, it
delegates one analyze run to triage it (label plus a plain-words comment),
and for a bug it judged fixable at confidence >= 0.7 one build run to fix
it, verifying the result itself (suite green in its own clone, diff
non-empty) before pushing `fix/issue-<n>` and opening a pull request. Both
delegations route through `bullswarm run` on the owner's subscriptions. It
never merges, closes, or releases. Install, guards, cost model and paths:
[`scripts/issue-watcher/README.md`](../../scripts/issue-watcher/README.md).
