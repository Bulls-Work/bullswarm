// The local calendar day of an instant (H1 in history.js): the reader's own
// zone, resolved at call time, never a hard-coded zone or a UTC "day".

// Resolving the zone builds an Intl.DateTimeFormat, and Home asks once per day
// key, which made it most of a Home paint. Node only changes the process zone
// when TZ is assigned, so the answer is cached against TZ's value.
let zoneTz;
let zoneName = null;
export function localTimeZone() {
  const tz = process.env.TZ ?? '';
  if (zoneName !== null && tz === zoneTz) return zoneName;
  try { zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { zoneName = 'UTC'; }
  zoneTz = tz;
  return zoneName;
}

// Building an Intl.DateTimeFormat costs about 0.1 ms, and a 181-run history
// asks for two day keys per run. The formatter is cached against the zone it
// was built for, so a zone change (a test pinning TZ, a laptop crossing a
// border) still rebuilds it rather than answering from the old one.
let formatterZone = null;
let formatter = null;
function dayFormatter() {
  const zone = localTimeZone();
  if (zone !== formatterZone) {
    formatterZone = zone;
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return formatter;
}

/**
 * 'YYYY-MM-DD' for an instant, in the resolved local zone (H1).
 *
 * @param {string|number|Date} iso  an ISO timestamp, epoch ms, or a Date
 * @returns {string|null} null when the instant cannot be read
 */
export function dayKey(iso) {
  const ms = iso instanceof Date ? iso.getTime()
    : typeof iso === 'number' ? iso
    : typeof iso === 'string' ? Date.parse(iso)
    : NaN;
  if (!Number.isFinite(ms)) return null;
  const parts = dayFormatter().formatToParts(new Date(ms));
  const field = (type) => parts.find((part) => part.type === type)?.value ?? null;
  const [year, month, day] = [field('year'), field('month'), field('day')];
  return year && month && day ? `${year}-${month}-${day}` : null;
}
