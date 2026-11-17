// Opt-in: a Claude Code worker writes its prompt cache at the 5-minute price
// instead of the 1-hour price. BULLSWARM_CLAUDE_CACHE_5M is `off` (default,
// also unset or any value not named here), `analyze` (attempts in the analyze
// lane only) or `all`. It relies on FORCE_PROMPT_CACHING_5M, an undocumented
// Claude Code variable; see docs/guide/cost.md.
import { modelFamilyOf } from '../lib/route.js';

export const CLAUDE_CACHE_5M_ENV = 'BULLSWARM_CLAUDE_CACHE_5M';
export const CLAUDE_CACHE_5M_VARIABLE = 'FORCE_PROMPT_CACHING_5M';

/** The configured mode: 'off', 'analyze' or 'all'. An invalid value reads as off. */
export function claudeCache5mMode(env = process.env) {
  const value = String(env?.[CLAUDE_CACHE_5M_ENV] ?? '').trim().toLowerCase();
  return value === 'analyze' || value === 'all' ? value : 'off';
}

/**
 * The mode when it applies to this attempt (a claude-code pool, and for
 * `analyze` an analyze-lane action), else null.
 */
export function claudeCache5mFor({ env = process.env, pool, action }) {
  const mode = claudeCache5mMode(env);
  if (mode === 'off' || modelFamilyOf(pool) !== 'claude-code') return null;
  if (mode === 'analyze' && (action?.lane ?? 'chore') !== 'analyze') return null;
  return mode;
}
