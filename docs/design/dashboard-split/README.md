Read-only study complete. The repository is unchanged and clean: `## dash-split`.

## 1. Function inventory

Classification is based on `rg` call sites and transitive callers, not function names. Nested closures move with their parent and are not separate exports.

### Home-only

- `taskToday`, `todayMinutesText`, `todayMinutesNumberText`, `measuredTaskMinutes`, `todayDateLabel`, `todayGoalLine`, `todayWorkflowLine`, `todayTaskLine`, `todayRows`, `poolRatePerMinute`, `todayLicenceRows`, `todayPoolName`, `todayTableRow`, `todayBareRule`, `todayPadded`, `todayLicenceFootnotes`, `homeTodayBand` — [dashboard.js:1371-1700](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1371)
- `compactUsageBasisText`, `percentText`, `shareText` — [dashboard.js:2174-2207](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2174)
- `paceOnly`, `budgetWeekLines`, `breakdownCells`, `summaryBand`, `homePage`, `homeDetails`, `recordCost`, `recordCostInfo` — [dashboard.js:2801-3242](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2801)

### Runs-only

- `keyHint`, `navigationFooter`, `breadcrumbSegments`, `breadcrumbLine`, `isWaitingWorkflow`, `workflowConcernCount`, `dashboardRunLines`, `listWindow`, `humanWorkflowStatus`, `humanPhaseName`, `filterDashboardRows`, `runsPage` — [dashboard.js:220-598](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:220), [dashboard.js:3245-3285](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:3245)
- `renderDashboard` is the legacy Runs-list adapter, but it also invokes the Run overview renderer, so it remains a shell compatibility adapter rather than a pure Runs module — [dashboard.js:432-497](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:432)

### Run-only

- `runFrame`, `workflowTechnicalLines`, `humanStatus`, `plannerDisplayStatus`, `plannerUsageSummary`, `orchestratorDetailLines`, `compactAgentPreviewLines`, `panelWindow`, `dimLine`, `runningMark`, `actionNamedIn`, `markStepRows` — [dashboard.js:721-895](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:721), [dashboard.js:1702-2045](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1702), [dashboard.js:2430-2457](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2430)
- `planAttemptDetail`, `planStageLabel`, `planStageHeader`, `planStageActions`, `planMoreParts`, `phaseActionGlyph`, `fittedParts`, `planPhaseActionParts`, `planDagLines`, `flatTimelineLines`, `stepTally`, `runBudgetRows`, `runLiveRows`, `runSoFarRows`, `runBlankReasons`, `runPage` — [dashboard.js:3344-3932](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:3344)

### Step-only

- `stepPage` — [dashboard.js:3938-4049](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:3938)

The Step design record confirms that Step should consume shared helpers and that `stepProgressText` has no caller: [step-page README:282-375](/home/dev/Repo/bullswork/bullswarm-0.35.0/docs/design/step-page-0.35.0/README.md:282).

### Shared by exactly two

- Home + Runs: `workflowRunLabel`, `taskIdText`, `taskPoolModelText`, `taskElapsedText`, `taskIdentity`, `strong`, `ageText`, `planStripParts`, `stepBarText`, `assignmentOf`, `stepPool` — [dashboard.js:504-511](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:504), [dashboard.js:1357-1388](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1357), [dashboard.js:1749-1753](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1749), [dashboard.js:2215-2220](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2215), [dashboard.js:2541-2560](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2541), [dashboard.js:2752-2790](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2752)
- Home + Run: `okMark`, `failMark`, `pendingMark`, `pushColumns` — [dashboard.js:1756-1785](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1756)
- Runs + Run: `stateStatus`, `stateFinishedAt`, `tokenText`, `renderPanel`, `joinPanels`, `renderWorkflowOverviewPanel`, `sectionDivider`, `groupedTimeline`, `timelineSegmentDisplayName`, `workflowTimelineLines`, `segmentHeader`, `continuationHeader`, `currentTimelineSegment`, `timelineText`, `workflowLiveLines`, `workflowNextLines`, `streamActivityLine`, `friendlyActionKind`, `friendlyActionSummary`, `workflowStatusIcon`, `panelCell`, `selectLine`, `alignRight` — [dashboard.js:183-185](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:183), [dashboard.js:282-294](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:282), [dashboard.js:897-1336](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:897), [dashboard.js:1817-1845](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1817), [dashboard.js:1990-2045](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1990)
- Run + Step: `compactUsage`, `actionRoleLabel`, `agentDetailLines`, `taskPreview`, `outcomePreview`, `about` — [dashboard.js:266-280](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:266), [dashboard.js:1832-1959](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1832), [dashboard.js:2148-2150](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2148)

### Shared by three

The requested buckets omit this important middle category:

- Home + Runs + Run: `stateStartedAt`, `planLevels`, `planProgress`, `planStages`, `clockAt`
- Runs + Run + Step: `reasoningText`, `clockText`, `formatBytes`, `outputSparkline`, `statusIcon`, `durationText`, `wrapLines`

These live at [dashboard.js:184-185](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:184), [dashboard.js:300-303](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:300), [dashboard.js:1325-1355](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1325), [dashboard.js:1973-2017](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1973), [dashboard.js:2469-2538](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2469), and [dashboard.js:3379-3402](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:3379).

### Shared by all four pages

`workflowPanelModel`, `dimText`, `rgbOf`, `tint`, `visibleLength`, `meterAnsi`, `blank`, `tokenSourceOf`, `worstTokenSource`, `usageBasisText`, `truncate`, `clamp`, `moneyText`, `minutesText`, `runEconomics` — [dashboard.js:656-713](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:656), [dashboard.js:1718-1746](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:1718), [dashboard.js:2019-2053](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2019), [dashboard.js:2138-2212](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2138), [dashboard.js:2570-2613](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2570).

### Shell/API and dead definitions

Keep these in the shell or existing adapters: `localDayKey`, `dayStart`, `pacedWindow`, `poolDayReadings`, `readLicencePerDay`, `writeClipboard`, `requestCancel`, `enrichRunRow`, `byNewestStart`, `dashboardRows`, `activeDashboardRows`, `renderDetails`, `renderV2Details`, `detailRow`, `overviewSnapshot`, `renderDashboardPage`, `tileSparklines`, `dashboardModel`, `renderWorkflowTui`, `runDashboard`, `dashboardJson`, plus the existing Task/Budget/Stats/History/Fleet/Help adapters and dashboard constants — [dashboard.js:58-497](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:58), [dashboard.js:4052-4492](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4052), [dashboard.js:4512-5899](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4512).

Do not move definition-only dead blocks: `stepProgressText`, `tileText`, `homeLicencePools`, `todayPoolMinute`, `todayLivePoolMinute`, `licencePoolName`, `homeLicenceDisplay`, and `planAttemptMeta` — [dashboard.js:2616-2745](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:2616), [dashboard.js:3325-3342](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:3325).

## 2. Dependency graph and state ownership

```text
dashboardRows
  -> enrichRunRow -> stateStatus/stateStartedAt/stateFinishedAt

dashboardModel
  -> budgetModel + statsModel + tileSparklines

renderDashboardPage
  -> homePage
  -> runsPage
  -> existing budget/stats/history/fleet/help pages
  -> stepPage
  -> taskPage
  -> runPage

homePage -> homeTodayBand + activeRunLines + homeDetails
runsPage -> activeRunLines + daysWithTasks + history rendering
runPage -> runFrame
runFrame -> overview/timeline/plan/live/technical renderers
stepPage -> workflowPanelModel + shared Run/Step helpers

renderWorkflowTui
  -> dashboardModel
  -> renderDashboardPage
```

The dispatch is explicit at [dashboard.js:4404-4492](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4404). `dashboardModel` is the composition boundary at [dashboard.js:4512-4575](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4512), and the static TUI path is [dashboard.js:4582-4584](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4582).

`runDashboard` owns all mutable shell state: active/catalog/all rows, filtering, selection, painted frame, hover and chart-slice registries, usage/integration/install state, rollups, prices, meter history, task ledger, and the `ui` page/focus/scroll/follow/cancel/orchestrator state — [dashboard.js:4611-4818](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4611).

The important mutation paths are:

- `paintUnsafe` builds models, calls `renderDashboardPage`, replaces hit regions, and writes the differential frame — [dashboard.js:4915-4950](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4915).
- `refresh` handles TTL/signature checks and selection preservation — [dashboard.js:4970-5015](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:4970).
- `openRun`, `openStep`, `openTask`, `openPage`, and `moveOut` mutate page/focus/selection — [dashboard.js:5020-5235](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:5020).
- `runAction`, mouse-region handling, scrolling, timers, listeners, and terminal cleanup remain shell responsibilities — [dashboard.js:5236-5863](/home/dev/Repo/bullswork/bullswarm-dash-split/src/workflow/dashboard.js:5236).

## 3. Proposed module layout

### `src/workflow/home-model.js`

Exact exports:

```text
taskToday
taskIdentity
todayMinutesText
todayMinutesNumberText
measuredTaskMinutes
todayDateLabel
todayRows
poolRatePerMinute
todayLicenceRows
recordCost
recordCostInfo
```

### `src/workflow/home-view.js`

Exact exports:

```text
homePage
homeTodayBand
homeDetails
todayGoalLine
todayWorkflowLine
todayTaskLine
todayPoolName
todayTableRow
todayBareRule
todayPadded
todayLicenceFootnotes
paceOnly
budgetWeekLines
breakdownCells
summaryBand
activeRunLines
taskIdText
taskPoolModelText
taskElapsedText
stepBarText
assignmentOf
stepPool
```

`activeRunLines` is intentionally exported because `runsPage` consumes it.

### `src/workflow/runs-view.js`

Exact exports:

```text
isWaitingWorkflow
workflowConcernCount
dashboardRunLines
listWindow
humanWorkflowStatus
humanPhaseName
filterDashboardRows
daysWithTasks
runsPage
```

The legacy `renderDashboard` remains in `dash-shell.js` as a compatibility adapter.

### `src/workflow/run-model.js`

Exact exports:

```text
workflowPanelModel
planLevels
planProgress
planStripParts
runEconomics
planAttemptDetail
planStages
planStageLabel
planStageHeader
planStageActions
planMoreParts
phaseActionGlyph
fittedParts
planPhaseActionParts
stepTally
```

### `src/workflow/run-view.js`

Exact exports:

```text
runFrame
renderWorkflowOverviewPanel
sectionDivider
groupedTimeline
timelineSegmentDisplayName
workflowTimelineLines
segmentHeader
continuationHeader
currentTimelineSegment
timelineText
workflowLiveLines
workflowNextLines
workflowTechnicalLines
timelineRow
timelineDetail
alignRight
orchestratorDetailLines
humanStatus
plannerDisplayStatus
plannerUsageSummary
friendlyActionKind
friendlyActionSummary
compactAgentPreviewLines
planDagLines
flatTimelineLines
runBudgetRows
runLiveRows
runSoFarRows
runBlankReasons
runPage
actionNamedIn
markStepRows
```

`streamActivityLine` remains private to `workflowLiveLines`; shared Run/Step helpers remain shell-owned to preserve the Step contract.

### `src/workflow/dash-shell.js`

Retain the current public API and re-export `workflowPanelModel` for compatibility:

```text
DASHBOARD_KEYS
readLicencePerDay
writeClipboard
requestCancel
dashboardRows
activeDashboardRows
renderDashboard
renderDetails
workflowPanelModel
overviewSnapshot
renderDashboardPage
dashboardModel
renderWorkflowTui
runDashboard
dashboardJson
```

The shell also owns shared ANSI/layout primitives, data/index access, caches, timers, hit-region registration, event handlers, legacy render adapters, and existing Budget/Stats/History/Fleet/Help pages. Avoid duplicating helpers across page modules.

## 4. Extraction order

1. Finish and checkpoint the separate Step extraction first. Freeze its shared-helper contract according to the Step design record.
2. Extract Home model/view. Add focused Home tests, run them, then run `npm test`.
3. Extract Runs view. Preserve the Home/Runs `activeRunLines` identity assertion. Run focused tests and `npm test`.
4. Extract Run model/view. This is the largest and riskiest move; keep compatibility exports and preserve hit-region behavior. Run focused tests and `npm test`.
5. Integrate only after all three mechanical moves are present. Reconcile imports/exports, run the full suite, and perform the byte-identity proof below.
6. Do not combine the dead-code cleanup with extraction.

## 5. Test map

These tests import `dashboard.js`:

- `tests/workflow-dead-kernel.test.js:11`, assertions at `120-122`: import-only shell API.
- `tests/workflow-v2-caller-planner.test.js:21`, `requestCancel` at `704`: import-only.
- `tests/workflow-program.test.js:11`, `requestCancel` at `230`: import-only.
- `tests/glyphs.test.js:9`, renderer assertions at `160-169`: import-only shell API.
- `tests/workflow-v2-recovery.test.js:9`, `requestCancel` at `98`: import-only.
- `tests/workflow-legacy-runs.test.js:19`, behavior at `287-316`: import-only shell/API and legacy renderer.
- `tests/workflow-dashboard.test.js:7`: broad behavior suite. The only directly extracted non-shell symbol is `workflowPanelModel` at `216`, `1672`, `2064`, `2134`, and `3762-3764`; either update that import to `run-model.js` or preserve the compatibility re-export. Existing expected frames should not be rewritten — [workflow-dashboard.test.js:155-280](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:155), [workflow-dashboard.test.js:1108-1191](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:1108), [workflow-dashboard.test.js:2898-2999](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:2898), [workflow-dashboard.test.js:3346-3408](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:3346), [workflow-dashboard.test.js:3503-3579](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:3503).

Add focused tests:

```text
tests/workflow-home-model.test.js
tests/workflow-home-view.test.js
tests/workflow-runs-view.test.js
tests/workflow-run-model.test.js
tests/workflow-run-view.test.js
```

## 6. Byte-identical proof

Use a test-created temporary fixture, never live `~/.bullswarm`. The existing fixture and fidelity sizes are at [workflow-dashboard.test.js:956-990](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:956) and [workflow-dashboard.test.js:3177-3191](/home/dev/Repo/bullswork/bullswarm-dash-split/tests/workflow-dashboard.test.js:3177).

For each extraction:

1. Capture pre-change and post-change raw ANSI output for `home`, `runs`, `run`, and `step`.
2. Render at widths `55`, `120`, and `200`, with fixed height, `nowMs`, `spinnerFrame: 0`, selection, phase, and agent indices.
3. Use `renderDashboardPage(dashboardModel(...), options).lines.join('\n')`; also verify `renderWorkflowTui` because it delegates to the same entry.
4. Preserve ANSI bytes in the comparison.

Comparison:

```sh
for page in home runs run step; do
  for width in 55 120 200; do
    cmp --silent \
      "before/${page}-${width}.txt" \
      "after/${page}-${width}.txt" || \
    diff -u --label before --label after \
      "before/${page}-${width}.txt" \
      "after/${page}-${width}.txt"
  done
done
```

Also verify stripped-ANSI line widths, hit-region coordinates, page dispatch, mouse/key actions, and run `npm test`. A successful extraction requires `cmp` success for every captured page/width plus the full suite.

## 7. Risk and sizing

Using the exact proposed lists, current declaration-span estimates are approximately:

- Home: `153 + 579 = 732` lines.
- Runs: `147` lines.
- Run: `365 + 1,043 = 1,408` lines.

The call-site audit found approximately 22 Home boundary references, 13 Runs references, and 38 Run references, in addition to dispatcher/import/re-export edits. Run is riskiest because it combines the largest move with `runFrame`, timeline rendering, shared legacy overview rendering, Step helpers, shell-owned hit regions, caches, timers, and interactive handlers. Every step should therefore be mechanical, checkpointed, focused-tested, and followed by `npm test`.

## 8. Draft `bullswarm.workflow.program.v2`

Goal text:

```text
1. Extract Home, Runs, and Run from dashboard.js into the specified modules without changing behavior.
2. Prove the extraction is byte-identical at 55, 120, and 200 columns and leaves npm test green.
```

Program:

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    {
      "id": "home-extraction",
      "kind": "mechanical",
      "purpose": "Extract Home model and view into dedicated modules",
      "dependsOn": [],
      "affects": ["requirement-1"],
      "ownedFiles": [
        "src/workflow/home-model.js",
        "src/workflow/home-view.js",
        "src/workflow/dashboard.js",
        "tests/workflow-home-model.test.js",
        "tests/workflow-home-view.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-dash-split, mechanically extract exactly the Home model and view functions from the study into home-model.js and home-view.js, update dashboard.js imports and dispatch, preserve all public compatibility exports and output bytes, do not alter Step or existing page behavior, add focused tests, run the focused tests and npm test, and report the summary. Others share this tree: preserve their edits and do not revert unrelated work."
    },
    {
      "id": "runs-extraction",
      "kind": "mechanical",
      "purpose": "Extract Runs view into a dedicated module",
      "dependsOn": ["home-extraction"],
      "affects": ["requirement-1"],
      "ownedFiles": [
        "src/workflow/runs-view.js",
        "src/workflow/dashboard.js",
        "tests/workflow-runs-view.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-dash-split, mechanically extract exactly the Runs view functions from the study into runs-view.js, consume activeRunLines from home-view.js, preserve the legacy renderDashboard adapter and all existing output, add focused tests, run the focused tests and npm test, and report the summary. Others share this tree: preserve their edits and do not revert unrelated work."
    },
    {
      "id": "run-extraction",
      "kind": "mechanical",
      "purpose": "Extract Run model and view into dedicated modules",
      "dependsOn": ["runs-extraction"],
      "affects": ["requirement-1"],
      "ownedFiles": [
        "src/workflow/run-model.js",
        "src/workflow/run-view.js",
        "src/workflow/dashboard.js",
        "tests/workflow-run-model.test.js",
        "tests/workflow-run-view.test.js"
      ],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-dash-split, mechanically extract exactly the Run model and view functions from the study into run-model.js and run-view.js, preserve the Step shared-helper contract, preserve workflowPanelModel compatibility, keep hit regions and interactive behavior identical, add focused tests, run the focused tests and npm test, and report the summary. Others share this tree: preserve their edits and do not revert unrelated work."
    },
    {
      "id": "integrate",
      "kind": "integration",
      "purpose": "Reconcile the page extractions and prove the full suite remains green",
      "dependsOn": ["home-extraction", "runs-extraction", "run-extraction"],
      "affects": ["requirement-1", "requirement-2"],
      "ownedFiles": [],
      "evidenceFor": [],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-dash-split, inspect all dependency outputs and reconcile imports, exports, compatibility adapters, and shared-helper ownership. Use only a safe temporary fixture, never live ~/.bullswarm. Capture Home, Runs, Run, and Step raw ANSI frames before and after at widths 55, 120, and 200 with fixed inputs; compare them with cmp and diff; check hit-region widths and dispatch; run npm test; report exact commands and results."
    },
    {
      "id": "verify",
      "kind": "adversarial-acceptance",
      "purpose": "Independently try to disprove behavioral and byte identity",
      "dependsOn": ["integrate"],
      "affects": [],
      "ownedFiles": [],
      "evidenceFor": ["requirement-1", "requirement-2"],
      "prompt": "In /home/dev/Repo/bullswork/bullswarm-dash-split, inspect only and try to break the extraction: compare raw frames at 55, 120, and 200 columns, exercise page dispatch, narrow layouts, unknown budgets, legacy Runs, Step rendering, keyboard and mouse actions, hit regions, cache refresh, timers, and public dashboard imports. Use a safe copied fixture and never live ~/.bullswarm. Do not edit files; report any discrepancy and quote npm test evidence."
    }
  ]
}
```