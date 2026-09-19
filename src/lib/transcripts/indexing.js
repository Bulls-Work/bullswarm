import { closeSync, openSync, readSync, statSync } from 'node:fs';

const EDGE_BYTES = 128 * 1024;

function parseLines(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch { /* an edge can begin or end in the middle of a JSON row */ }
  }
  return rows;
}

/** Read bounded head/tail metadata without loading a transcript body. */
export function transcriptEdges(filePath, bytes = EDGE_BYTES) {
  let fd;
  try {
    const size = statSync(filePath).size;
    fd = openSync(filePath, 'r');
    const headSize = Math.min(size, bytes);
    const tailStart = Math.max(0, size - bytes);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(size - tailStart);
    readSync(fd, head, 0, head.length, 0);
    readSync(fd, tail, 0, tail.length, tailStart);
    return {
      file: filePath,
      size,
      head: parseLines(head.toString('utf8')),
      tail: parseLines(tail.toString('utf8')),
    };
  } catch {
    return { file: filePath, size: 0, head: [], tail: [] };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function edgeTimes(edge, field = 'timestamp') {
  const values = [...edge.head, ...edge.tail]
    .map((row) => row?.[field])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  values.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { firstAt: values[0] ?? null, lastAt: values.at(-1) ?? null };
}

export function overlapsIndex(entry, startedAt, endedAt) {
  const start = startedAt == null ? null : Date.parse(startedAt);
  const end = endedAt == null ? null : Date.parse(endedAt);
  const first = entry.firstAt == null ? null : Date.parse(entry.firstAt);
  const last = entry.lastAt == null ? null : Date.parse(entry.lastAt);
  if (start == null && end == null) return true;
  if (!Number.isFinite(first) && !Number.isFinite(last)) return false;
  return (!Number.isFinite(end) || !Number.isFinite(first) || first <= end)
    && (!Number.isFinite(start) || !Number.isFinite(last) || last >= start);
}
