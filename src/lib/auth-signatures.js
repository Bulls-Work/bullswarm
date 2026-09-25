// bullswarm auth signatures — the phrases that mean "the credential is dead".
//
// Doctrine:
//   A1. A relayed credential fails UPSTREAM, not in the transport. opencode
//       talking to a reseller that relays to a pooled OAuth account never
//       emits its own auth wording: the upstream body arrives verbatim inside the
//       provider's error event, so the shared list matches that body, not the
//       CLI's vocabulary. Connector-declared phrases stay first — an
//       installation's own wording outranks a default.
//   A2. The shared defaults are read ONLY once a stream has already declared a
//       failure. Matching them on ordinary output would fail a worker for
//       reading auth code, which is precisely the false positive the
//       error-shape gate exists to prevent (Q2).
//   A3. Zero dependencies. Case-insensitive substring, exactly like quota
//       signatures, so one rule explains both tables.

import { ERROR_SHAPED_LINE } from './quota.js';

/**
 * Upstream phrases that mean the credential behind the pool is unusable right
 * now. Earned 2026-09-11: at 12:24 UTC the OAuth pool behind a relaying
 * reseller was invalidated and answered every request with one of
 *   {"error":{"message":"Encountered invalidated oauth token for user, failing
 *    request","type":"authentication_error","param":"","code":"auth_unavailable"}}
 *   {"error":{"message":"auth_unavailable: no auth available (providers=codex,
 *    model=gpt-5.6-luna; last upstream error: auth_unavailable: Encountered
 *    invalidated oauth token: [REDACTED])","type":"server_error",…}}
 * None of those phrases appeared in any connector's own auth list, so every
 * attempt was reported as a generic provider error and the retry walked the
 * pools that share the dead credential. Only phrases any relay can emit belong here; wording one reseller
 * uses for its own outages is declared by that provider's `authSignatures`.
 */
export const DEFAULT_AUTH_SIGNATURES = Object.freeze([
  'auth_unavailable',
  'authentication_error',
  'invalidated oauth token',
]);

/** Connector-declared phrases first, then the shared upstream defaults. */
export function authSignaturesFor(connector) {
  const declared = Array.isArray(connector?.authSignatures) ? connector.authSignatures : [];
  return [...declared, ...DEFAULT_AUTH_SIGNATURES];
}

/**
 * A raw JSONL provider event carrying an error payload. It is a machine record
 * of a failure, never prose, so it counts as error-shaped even though it reads
 * nothing like `error: …`.
 */
export const JSON_ERROR_EVENT_LINE = /^\s*\{.*"error"/i;

/**
 * First auth phrase present on an error-shaped line of `text`, with that line.
 *
 * The narrative guard is kept (A2) and widened by exactly one case: the raw
 * error event itself. That is a bypass of ERROR_SHAPED_LINE, not an extension
 * of it — the shared regex also gates quota detection, where a JSON blob is
 * still prose until it says something quota-shaped.
 *
 * @returns {{signature: string, line: string}|null}
 */
export function findUpstreamAuthFailure(connector, text) {
  const raw = String(text ?? '');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const signature of authSignaturesFor(connector)) {
    const needle = String(signature ?? '').toLowerCase();
    if (!needle) continue;
    const index = lower.indexOf(needle);
    if (index < 0) continue;
    const start = lower.lastIndexOf('\n', index) + 1;
    const newline = lower.indexOf('\n', index);
    const line = raw.slice(start, newline < 0 ? raw.length : newline).trim();
    if (!line) continue;
    if (!ERROR_SHAPED_LINE.test(line) && !JSON_ERROR_EVENT_LINE.test(line)) continue;
    return { signature, line };
  }
  return null;
}
