---
title: Issue watcher
description: The launchd agent that polls GitHub for new issues, delegates a triage, and makes one verified fix attempt per qualifying bug.
---

# Issue watcher

After this page you can install the issue watcher as a macOS launchd agent, tell whether it is loaded and what a pass would do, pause it, and remove it without losing its history.

`scripts/issue-watcher/` watches one GitHub repository's issues. Idle it costs zero model tokens — a pass with no new issue is one `gh issue list` and nothing else — and when an issue arrives it delegates the triage through `bullswarm run` on your own subscriptions.

## What a pass does

launchd runs `<node> <dir>/bin/watch.mjs --once` every `StartInterval` seconds (default 300) and again at load. The pass takes a lock, runs `gh issue list --state open --limit 50`, and compares numbers against `state.json`.

An issue is **new** when its number is not in `state.json` *and* it was created at or after `installedAt`. Anything else is skipped by number, so no issue is ever triaged twice, and a first pass records the whole open backlog as pre-existing instead of firing delegations at it.

## Triage

For each new issue, oldest first, the watcher refreshes its clone, writes a task file, and hands it to a delegate:

```bash
# the delegation the watcher makes for one new issue, one per pass
bullswarm run --lane analyze --effort medium --no-caller --add-dir <dir>/repo --task-file <dir>/tasks/issue-<n>-triage.md --json
```

It reads the `ok` field of the verdict, never the exit code, and requires the report to end in a JSON block. From that it adds one label — `bug`, `enhancement`, `question`, `invalid` or `duplicate` — and posts a plain-words comment: a summary, whether the issue was reproduced and how, the affected files, and either a proposed fix or the one question the reporter must answer.

A triage that keeps producing junk is attempted three times and then dropped.

## The one fix attempt

Only when the triage says `kind: "bug"`, `fixable: true` and `confidence >= 0.7` — and the issue has never had a fix attempt — the watcher branches `fix/issue-<n>` from `origin/main` and delegates the fix:

```bash
# the one fix attempt a qualifying bug gets, after its branch exists
bullswarm run --lane build --effort high --no-caller --add-dir <dir>/repo --task-file <dir>/tasks/issue-<n>-fix.md --json
```

Then it verifies the work itself, not on the delegate's word: the test command (default `npm test`) must exit 0 in the watcher's own clone, and the diff must be non-empty.

Only then does it commit, push the branch, open a pull request against `main`, and comment the PR link on the issue. If the run failed, the suite failed, or the diff was empty, the clone is restored, the issue gets one honest comment and the `help wanted` label, and a human takes it from there.

It never merges, closes, reopens, releases, force-pushes, or touches any branch other than `fix/issue-<n>`, and never pushes to `main`.

## Install

```bash
# print the plist and every command without writing anything
node scripts/issue-watcher/install.mjs --dry-run

# install and start, watching Bulls-Work/bullswarm every 300 seconds
node scripts/issue-watcher/install.mjs
```

| Flag | Meaning | Default |
|---|---|---|
| `--dir <path>` | watcher root: state, clone, tasks, logs | `~/.bullswarm/issue-watcher` |
| `--repo owner/name` | repository to watch | `Bulls-Work/bullswarm` |
| `--interval <sec>` | launchd `StartInterval`, minimum 10 | `300` |
| `--uninstall` | bootout and remove the plist; state and logs are kept | off |
| `--dry-run` | print the plist and every command; write nothing | off |

The installer is idempotent: re-run it after editing `watch.mjs` and it re-copies the files and re-bootstraps the job, keeping `installedAt` and every seen issue.

## What install writes

It creates `<dir>/{bin,tasks,log}`, copies `watch.mjs` and the two task templates into `<dir>/bin` so the agent does not depend on this checkout surviving, clones the repository into `<dir>/repo` if it is missing, and seeds `state.json` with every open issue as pre-existing.

Then it writes `~/Library/LaunchAgents/com.bullswarm.issue-watcher.plist` and loads it with `launchctl bootstrap gui/<uid>`. The plist carries the invoking shell's `PATH` plus node's own directory — launchd hands a user agent a minimal environment, and `gh`, `git`, `bullswarm` and the worker CLIs all have to stay findable from a daemon.

## Check it

```bash
# is the job loaded, and when did it last run
launchctl print gui/$(id -u)/com.bullswarm.issue-watcher

# state summary: paths, lock, pause flag, seen counts, today's counters
node ~/.bullswarm/issue-watcher/bin/watch.mjs --status

# what the next pass would do, without posting, dispatching, or writing state
node ~/.bullswarm/issue-watcher/bin/watch.mjs --dry-run
```

`--status` and `--dry-run` never take the lock and never write state, so both are safe while the agent is mid-pass. `--once` runs one pass by hand. The audit trail is `<dir>/log/watch.log`, one timestamped line per step, rotated to `watch.log.1` past 5 MB.

## Pause and resume

```bash
# stop acting, polling included; the pass logs and exits before it polls
touch ~/.bullswarm/issue-watcher/paused
rm ~/.bullswarm/issue-watcher/paused
```

## Remove

```bash
# bootout the job and delete the plist; state.json and the logs stay
node scripts/issue-watcher/install.mjs --uninstall
```

Re-installing afterwards resumes where it left off: `installedAt` and every seen issue survive, so nothing already triaged is triaged again.

## Guards

| Guard | What it prevents |
|---|---|
| `<dir>/lock`, stale after 2 h | two passes overlapping when a triage takes minutes |
| `<dir>/paused` | anything at all, until you remove the file |
| 6 triages and 2 fix attempts per UTC day | one busy day on GitHub emptying your quota meters |
| 3 triage attempts, then silence | a delegate that emits junk retrying forever |
| one fix attempt per issue, ever | an unattended fix loop |
| watcher-side test run and diff check | a pull request whose tests do not actually pass |
| no GitHub credentials for delegates | a worker acting as you on GitHub if issue text talks it into trying |

Issue text is untrusted: it reaches a model only inside a fenced block introduced as quoted material, and any run of six or more backticks is clipped so it cannot close that fence.

## Configuration

| Variable | Default |
|---|---|
| `BULLSWARM_ISSUE_WATCHER_DIR` | `~/.bullswarm/issue-watcher` |
| `BULLSWARM_ISSUE_WATCHER_REPO` | `Bulls-Work/bullswarm`, else `state.json` |
| `BULLSWARM_ISSUE_WATCHER_GH` | `gh` |
| `BULLSWARM_ISSUE_WATCHER_BULLSWARM` | `bullswarm` |
| `BULLSWARM_ISSUE_WATCHER_TEST_COMMAND` | `npm test` |
| `BULLSWARM_ISSUE_WATCHER_MAX_TRIAGES_PER_DAY` | `6` |
| `BULLSWARM_ISSUE_WATCHER_MAX_FIXES_PER_DAY` | `2` |
| `BULLSWARM_ISSUE_WATCHER_NO_NOTIFY` | unset; `1` skips the macOS notification |
| `BULLSWARM_ISSUE_WATCHER_HOME` | `$HOME` — where `Library/LaunchAgents` lives |

## Known limits

- A qualifying bug that meets the daily fix limit stays `triaged` and is not picked up again on a later pass. Fix it by hand, or raise the limit.
- `gh issue list --limit 50` means a repository with more than 50 open issues will not show its oldest ones to the watcher.
- The pool, model and wall time in an automated comment's footer are whatever the run reported, so they vary from run to run.

## Next steps

- [Run one task](/guide/run) — the two commands the watcher delegates with, and what their verdicts mean.
- [Routing](/guide/routing) — how the watcher's delegations pick a pool without you choosing one.
- [Observing runs](/guide/observing) — reading the artifacts a delegation leaves behind.
