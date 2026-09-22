// Compact, versioned JSON projection of the in-process Step page model.
//
// stepPageModel intentionally exposes aliases for dashboard renderers. Those
// aliases are useful in memory, but JSON.stringify expands every reference and
// used to write the same activity seven or more times. Keep the dashboard
// model untouched and remove repetition only at the CLI boundary.

export const STEP_JSON_SCHEMA_VERSION = 2;

function compactTurn(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  const {
    // All three are views of records already present in activity.events.
    atomicEvents: _atomicEvents,
    response: _response,
    responseEvent: _responseEvent,
    ...rest
  } = turn;
  return rest;
}

function compactActivity(activity) {
  if (!activity || typeof activity !== 'object') return activity;
  const {
    // These arrays contain the same event objects as `events`, selected or
    // filtered in different ways. Their derivation is named by the remaining
    // filter/date/index fields.
    visibleEvents: _visibleEvents,
    todayEvents: _todayEvents,
    visibleDetailEvents: _visibleDetailEvents,
    // These are renderer projections of `turns`; presentation.activity is the
    // sole JSON display projection.
    overviewRows: _overviewRows,
    turnSummaries: _turnSummaries,
    turns,
    ...rest
  } = activity;
  return {
    ...rest,
    turns: Array.isArray(turns) ? turns.map(compactTurn) : [],
  };
}

function compactAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return attempt;
  return {
    id: attempt.id ?? null,
    actionId: attempt.actionId ?? null,
    ordinal: attempt.ordinal ?? null,
    status: attempt.status ?? 'unknown',
    pool: attempt.pool ?? null,
    model: attempt.model ?? null,
    lane: attempt.lane ?? null,
    effort: attempt.effort ?? null,
    startedAt: attempt.startedAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
    lastActivityAt: attempt.lastActivityAt ?? null,
    activity: compactActivity(attempt.activity),
  };
}

/**
 * Project the shared dashboard Step model into the public CLI JSON schema.
 * Every attempt owns one activity; selectedAttempt is a JSON reference marker
 * instead of another expanded copy. Display-ready fields live once under
 * presentation, while the dashboard continues to receive the full model.
 */
export function stepJsonModel(model) {
  const attempts = Array.isArray(model?.attempts) ? model.attempts.map(compactAttempt) : [];
  const selectedOrdinal = model?.selectedAttempt?.ordinal ?? null;
  const selectedIndex = attempts.findIndex((attempt) => attempt?.ordinal === selectedOrdinal);
  if (selectedIndex >= 0) {
    const selectedActivity = attempts[selectedIndex]?.activity;
    const selectedJson = JSON.stringify(selectedActivity);
    attempts.forEach((attempt, index) => {
      if (index !== selectedIndex && JSON.stringify(attempt?.activity) === selectedJson) {
        attempt.activity = { sameAs: `attempts[${selectedIndex}].activity` };
      }
    });
  }
  return {
    schemaVersion: STEP_JSON_SCHEMA_VERSION,
    identity: model?.identity ?? {},
    view: model?.view ?? 'overview',
    sectionOrder: model?.sectionOrder ?? ['header', 'task', 'activity', 'result', 'cost'],
    selectedAttemptOrdinal: selectedOrdinal,
    selectedAttempt: selectedIndex >= 0 ? { sameAs: `attempts[${selectedIndex}]` } : null,
    attempts,
    presentation: model?.presentation ?? {},
  };
}

export default stepJsonModel;
