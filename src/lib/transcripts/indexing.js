import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const EDGE_BYTES = 128 * 1024;
// A delegate's first user turn sits after the CLI's own injected context
// (memory, plugin lists, AGENTS.md). On the owner's Codex store that context
// reached 108 KB, so the prompt scan reads past the index edge, bounded.
const PROMPT_SCAN_BYTES = 1024 * 1024;
const PROMPT_CHUNK_BYTES = 64 * 1024;
const MAX_TASK_PATHS = 32;

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

/**
 * Visit JSON rows from the start of a transcript until `visit` returns true or
 * `maxBytes` have been read. Only whole lines are parsed; a malformed row is
 * skipped exactly as the full readers skip it.
 */
export function scanHeadRows(filePath, visit, { maxBytes = PROMPT_SCAN_BYTES, chunkBytes = PROMPT_CHUNK_BYTES } = {}) {
  let fd;
  let offset = 0;
  let pending = '';
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(chunkBytes);
    while (offset < maxBytes) {
      const read = readSync(fd, buffer, 0, Math.min(chunkBytes, maxBytes - offset), offset);
      if (read <= 0) break;
      offset += read;
      pending += buffer.toString('utf8', 0, read);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row && typeof row === 'object' && visit(row) === true) return { bytesRead: offset, stopped: true };
      }
    }
    if (pending.trim() && offset < maxBytes) {
      try {
        const row = JSON.parse(pending);
        if (row && typeof row === 'object' && visit(row) === true) return { bytesRead: offset, stopped: true };
      } catch { /* a torn final row */ }
    }
  } catch {
    return { bytesRead: offset, stopped: false };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  return { bytesRead: offset, stopped: false };
}

/**
 * Build index entries for `files`, reusing a previous entry whose file still
 * has the same size and mtime. `changedFiles` lists every file (re)read, so a
 * caller can tell which transcripts are new or grew since the last build;
 * `grownFrom` maps a file that already existed to its previous last
 * timestamp, because only rows after it are new.
 */
export function incrementalEntries(files, previous, build) {
  const prior = new Map();
  for (const entry of Array.isArray(previous?.entries) ? previous.entries : []) {
    if (entry && typeof entry.file === 'string') prior.set(entry.file, entry);
  }
  const entries = [];
  const changedFiles = [];
  const grownFrom = {};
  for (const filePath of files) {
    let stat = null;
    try { stat = statSync(filePath); } catch { continue; }
    const old = prior.get(filePath);
    if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) {
      entries.push(old);
      continue;
    }
    entries.push({ ...build(filePath), size: stat.size, mtimeMs: stat.mtimeMs });
    changedFiles.push(filePath);
    if (old && stat.size >= old.size) grownFrom[filePath] = old.lastAt ?? null;
  }
  return { entries, changedFiles, grownFrom };
}

/** Line endings and outer whitespace never distinguish two task texts. */
export function normalizeTaskText(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  return normalized || null;
}

export function taskTextHash(text) {
  const normalized = normalizeTaskText(text);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

// Absolute POSIX paths quoted in a prompt: `Read /…/task-x-attempt-1.md and
// follow…`. Sentence punctuation after the path is not part of it.
function promptPaths(text) {
  const paths = [];
  for (const match of String(text).matchAll(/(?:^|[\s"'`(<[])(\/[^\s"'`<>()[\]{}]+)/g)) {
    const path = match[1].replace(/[.,;:!?]+$/, '');
    if (path.length > 1 && path.includes('/', 1)) paths.push(path);
  }
  return paths;
}

/**
 * The comparable keys of a delegate's first user turn: every absolute path it
 * quotes and the hash of each message's text. The text itself is not kept.
 */
export function promptKeys(texts) {
  const taskPaths = new Set();
  const promptHashes = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const hash = taskTextHash(text);
    if (hash) promptHashes.add(hash);
    for (const path of promptPaths(text)) {
      if (taskPaths.size >= MAX_TASK_PATHS) break;
      taskPaths.add(path);
    }
  }
  return { taskPaths: [...taskPaths], promptHashes: [...promptHashes] };
}

/** The keys an attempt offers: its recorded task file path and its text. */
export function attemptTaskKeys({ taskText = null, taskFile = null, taskPath = null } = {}) {
  const paths = [...new Set([taskFile, taskPath]
    .filter((value) => typeof value === 'string' && value.startsWith('/')))];
  const hash = taskTextHash(taskText);
  return paths.length || hash ? { paths, hash } : null;
}

/** Whether one transcript's first user turn names or carries this task. */
export function promptMatchesTask(entry, keys) {
  if (!entry || !keys) return false;
  if (keys.paths.some((path) => entry.taskPaths?.includes(path))) return true;
  return Boolean(keys.hash && entry.promptHashes?.includes(keys.hash));
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
