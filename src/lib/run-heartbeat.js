function compactDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${minutes}m`;
}

function compactBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
}

export function formatRunHeartbeat({ elapsedMs, events, bytes, idleMs }) {
  return [
    'bullswarm run · active',
    compactDuration(elapsedMs),
    `· ${events} event${events === 1 ? '' : 's'}`,
    `· ${compactBytes(bytes)}`,
    `· activity ${compactDuration(idleMs)} ago`,
  ].join(' ');
}

export function createRunHeartbeat({ intervalSec, write = (line) => process.stderr.write(`${line}\n`), now = Date.now }) {
  const startedAt = now();
  let lastActivityAt = startedAt;
  let bytes = 0;
  let events = 0;
  let timer = null;

  return {
    start() {
      if (timer || intervalSec == null) return;
      timer = setInterval(() => {
        const at = now();
        write(formatRunHeartbeat({
          elapsedMs: at - startedAt,
          events,
          bytes,
          idleMs: at - lastActivityAt,
        }));
      }, intervalSec * 1000);
      timer.unref?.();
    },
    activity(observation = {}) {
      bytes += Number(observation.bytes) || 0;
      lastActivityAt = now();
    },
    event() {
      events += 1;
      lastActivityAt = now();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
