// Which Claude Code login a long-lived caller (a lead, a watcher, a pipeline
// stage) should start on, and whether an existing one should move.
//
// Read-only. No meter read, no cache write, no state write: the caller hands
// in the pool list `livePools` already built. Ranking is the pacing-window
// catch-up routing uses as pace surplus, highest first.

const FIVE_HOUR_MS = 5 * 3600_000;
const SPENT_PCT = 98;

const ROLE_TIER = Object.freeze({ lead: 'high', stage: 'medium', watcher: 'low' });

export class PlaceUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlaceUsageError';
    this.code = 'PLACE_USAGE';
  }
}

function numText(value) {
  if (!Number.isFinite(value)) return '?';
  const rounded = Math.round(value * 10) / 10;
  return String(rounded);
}

/** 5h elapsed, 0–100, or null when the pool has no reset time. */
function fiveHourElapsedPct(resetsAt, now) {
  const resets = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt ?? '');
  if (!Number.isFinite(resets)) return null;
  const elapsed = (100 * (FIVE_HOUR_MS - (resets - now))) / FIVE_HOUR_MS;
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, Math.min(100, elapsed));
}

function loginOf(pool) {
  const raw = pool?.meterSnapshot?.login;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (pool.name === 'claude-code') return 'personal';
  const prefix = 'claude-code:';
  if (pool.name.startsWith(prefix) && pool.name.length > prefix.length) return pool.name.slice(prefix.length);
  return pool.name;
}

function configDirOf(pool) {
  if (pool.name === 'claude-code') return null;
  const dir = pool.connector?.configDirs?.[0];
  return typeof dir === 'string' && dir ? dir : null;
}

function modelFor(pool, tier) {
  const table = pool.strategyModelTiers?.[pool.name];
  if (!table || typeof table !== 'object') return null;
  for (const [model, tiers] of Object.entries(table)) {
    if (Array.isArray(tiers) && tiers.includes(tier)) return model;
  }
  return null;
}

function matches(pool, token) {
  return loginOf(pool) === token || pool.name === token;
}

function exclusionReason(pool, { fiveHourCap, avoid }) {
  if (pool.enabled === false) return 'disabled';
  if (pool.hold && typeof pool.hold === 'object') {
    const why = typeof pool.hold.reason === 'string' && pool.hold.reason.trim() ? pool.hold.reason.trim() : '';
    return why ? `held (${why})` : 'held';
  }
  if (pool.reserve && typeof pool.reserve === 'object') return 'reserved';
  if (typeof pool.meterError === 'string' && pool.meterError.trim()) return `meter error: ${pool.meterError.trim()}`;
  const snap = pool.meterSnapshot;
  if (snap?.stale === true) return 'meter stale';
  if (!snap || typeof snap !== 'object') return 'meter not ok';
  if (snap.state != null && snap.state !== 'ok') return `meter state ${snap.state}`;
  if (!Number.isFinite(pool.usedPct) || !Number.isFinite(pool.elapsedPct)) return 'meter not ok';
  if (Number.isFinite(pool.fiveHourUsedPct) && pool.fiveHourUsedPct >= fiveHourCap) {
    return `5h used ${numText(pool.fiveHourUsedPct)}% >= cap ${numText(fiveHourCap)}%`;
  }
  if (pool.usedPct >= SPENT_PCT) return `window spent (used ${numText(pool.usedPct)}%)`;
  if (avoid.some((token) => matches(pool, token))) return 'avoid';
  return null;
}

function viewOf(pool, tier, now) {
  const used = pool.usedPct;
  const elapsed = pool.elapsedPct;
  const catchUp = (100 - used) / Math.max(1, 100 - elapsed);
  const deficit = elapsed - used;
  const fiveElapsed = fiveHourElapsedPct(pool.fiveHourResetsAt, now);
  const window = pool.pacingWindow || 'window';
  return {
    login: loginOf(pool),
    pool: pool.name,
    configDir: configDirOf(pool),
    model: modelFor(pool, tier),
    tier,
    usedPct: used,
    elapsedPct: elapsed,
    pacingWindow: pool.pacingWindow ?? null,
    deficit,
    catchUp,
    fiveHourUsedPct: Number.isFinite(pool.fiveHourUsedPct) ? pool.fiveHourUsedPct : null,
    fiveHourElapsedPct: fiveElapsed,
    reason: `${window} used ${numText(used)}% elapsed ${numText(elapsed)}% catch-up ${numText(catchUp)} deficit ${numText(deficit)} 5h used ${numText(pool.fiveHourUsedPct)}%`,
  };
}

function byRank(a, b) {
  if (a.catchUp !== b.catchUp) return b.catchUp - a.catchUp;
  const af = Number.isFinite(a.fiveHourUsedPct) ? a.fiveHourUsedPct : Infinity;
  const bf = Number.isFinite(b.fiveHourUsedPct) ? b.fiveHourUsedPct : Infinity;
  if (af !== bf) return af - bf;
  return a.login.localeCompare(b.login) || a.pool.localeCompare(b.pool);
}

function requireKnown(claude, token) {
  const found = claude.find((pool) => matches(pool, token));
  if (!found) throw new PlaceUsageError(`unknown login "${token}"`);
  return found;
}

function moveOf(currentPool, pick, now, reason) {
  const login = loginOf(currentPool);
  const used = currentPool.fiveHourUsedPct;
  const elapsed = fiveHourElapsedPct(currentPool.fiveHourResetsAt, now);
  const numbers = `5h ${numText(used)}% used, ${numText(elapsed)}% elapsed`;
  if (!pick || pick.login === login) {
    const why = pick ? `${login} is the pick (${numbers})` : `no eligible login (${numbers})`;
    return { login, moveSuggested: false, moveReason: why };
  }
  if (Number.isFinite(used) && used > 85) {
    return { login, moveSuggested: true, moveReason: `${login} ${numbers}; 5h used > 85%` };
  }
  if (elapsed != null && Number.isFinite(used) && used > 1.5 * elapsed) {
    return {
      login,
      moveSuggested: true,
      moveReason: `${login} 5h ${numText(used)}% used > 1.5 × ${numText(elapsed)}% elapsed`,
    };
  }
  if (reason) {
    return { login, moveSuggested: true, moveReason: `${login} excluded: ${reason} (${numbers})` };
  }
  return { login, moveSuggested: false, moveReason: `${login} ${numbers}` };
}

/**
 * Decide the login. `pools` is the livePools list. Returns the JSON document
 * `bullswarm place --json` prints. Throws PlaceUsageError on a bad role or a
 * login that is not a Claude pool.
 */
export function placeCaller(pools, {
  role,
  current = null,
  pin = null,
  avoid = [],
  fiveHourCap = 70,
  now = Date.now(),
} = {}) {
  if (!Object.hasOwn(ROLE_TIER, role)) {
    throw new PlaceUsageError(`unknown role "${role}" (lead, stage, or watcher)`);
  }
  if (typeof fiveHourCap !== 'number' || !Number.isFinite(fiveHourCap) || fiveHourCap < 0 || fiveHourCap > 100) {
    throw new PlaceUsageError('--five-hour-cap needs a percentage from 0 to 100');
  }
  if (!Array.isArray(avoid) || avoid.some((token) => typeof token !== 'string' || !token.trim())) {
    throw new PlaceUsageError('--avoid needs a comma-separated login list');
  }
  const avoidList = avoid.map((token) => token.trim());
  const tier = ROLE_TIER[role];
  const claude = (Array.isArray(pools) ? pools : []).filter(
    (pool) => pool?.connector?.bin === 'claude' && typeof pool?.name === 'string',
  );
  for (const token of avoidList) requireKnown(claude, token);
  const pinned = pin == null || pin === '' ? null : requireKnown(claude, pin);
  const currentPool = current == null || current === '' ? null : requireKnown(claude, current);
  const considered = pinned ? [pinned] : claude;
  const eligible = [];
  const excluded = [];
  let pinnedReason = null;
  for (const pool of considered) {
    const reason = exclusionReason(pool, { fiveHourCap, avoid: avoidList });
    if (reason) {
      excluded.push({ login: loginOf(pool), pool: pool.name, reason });
      if (pinned && pool === pinned) pinnedReason = reason;
    } else {
      eligible.push(viewOf(pool, tier, now));
    }
  }
  eligible.sort(byRank);
  const pick = pinned && pinnedReason ? viewOf(pinned, tier, now) : (eligible[0] ?? null);
  const doc = {
    role,
    pick,
    candidates: pinned && pinnedReason ? [] : eligible,
    excluded,
  };
  if (pinnedReason) doc.warning = pinnedReason;
  if (currentPool) {
    const currentReason = exclusionReason(currentPool, { fiveHourCap, avoid: avoidList });
    doc.current = moveOf(currentPool, pick, now, currentReason);
  }
  return doc;
}

/** Plain text for the document placeCaller returns. */
export function formatPlace(doc) {
  const lines = [];
  if (doc.pick) {
    const dir = doc.pick.configDir == null ? '(unset)' : doc.pick.configDir;
    const model = doc.pick.model == null ? 'default' : doc.pick.model;
    lines.push(`${doc.pick.login}\tCLAUDE_CONFIG_DIR=${dir}\tmodel ${model}`);
    lines.push(doc.pick.reason);
  }
  if (doc.warning) lines.push(`warning: ${doc.warning}`);
  if (doc.current) {
    lines.push(`${doc.current.moveSuggested ? 'move suggested' : 'stay'}: ${doc.current.moveReason}`);
  }
  for (const row of doc.excluded ?? []) lines.push(`skipped: ${row.login} (${row.reason})`);
  return lines.join('\n');
}
