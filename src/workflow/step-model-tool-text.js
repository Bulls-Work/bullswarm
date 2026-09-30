// The words a tool row prints for one captured operation: the command it ran
// with the connector's shell wrapper unwrapped, the files a change touched,
// or the tool's own kind when nothing else was captured.

import { toolKindCategory } from './step-model-tool-kinds.js';
import { textOrNull } from './step-model-values.js';

/**
 * The command a worker meant to run. Codex captures a shell invocation as
 * `/bin/zsh -lc "…"`; the design prints the command itself, so the outer
 * wrapper a connector adds around its own spawn is unwrapped and nothing else
 * is touched. Prose is never rewritten — this is the captured summary field.
 */
export function toolSummaryText(kind, summary) {
  const value = textOrNull(summary);
  if (!value) return toolKindWords(kind);
  if (kind !== 'command') return value;
  const match = /^\S*(?:zsh|bash|sh|dash)\s+-l?c\s+([\s\S]*)$/.exec(value);
  if (!match) return value;
  const inner = match[1];
  const quote = inner[0];
  if (quote === '"' || quote === "'") {
    if (inner.endsWith(quote)) return inner.slice(1, -1);
    if (inner.endsWith(`\\${quote}`)) return `${inner.slice(1, -2)}${quote}`;
    // A clipped capture keeps the text it has; its `…` is the provider's own.
    return inner.slice(1);
  }
  return inner;
}

function toolKindWords(kind, category = null) {
  if (category === 'command') return 'command';
  const raw = textOrNull(kind);
  if (!raw) return 'tool';
  return raw.toLowerCase().replace(/[_-]+/g, ' ');
}

function changeKindWords(kind) {
  const raw = textOrNull(kind)?.toLowerCase() ?? '';
  if (raw === 'add' || raw === 'create' || raw === 'created') return 'add';
  if (raw === 'delete' || raw === 'remove' || raw === 'deleted') return 'delete';
  if (raw === 'update' || raw === 'modify' || raw === 'modified' || raw === 'edit') return 'edit';
  return raw.replace(/[_-]+/g, ' ') || 'edit';
}

function changeEntries(value) {
  // Codex `file_change` keeps its complete `changes` array (or the array
  // itself) in `arguments`; Claude's Edit/Write keep a single file path. Any
  // other object (a Bash call's {command, description}) is not a change list,
  // so its keys must never be read as paths.
  const list = Array.isArray(value) ? value : (Array.isArray(value?.changes) ? value.changes : null);
  if (list) {
    return list.map((entry) => {
      if (typeof entry === 'string') return { path: entry, kind: null };
      return entry && typeof entry === 'object' ? entry : null;
    }).filter(Boolean);
  }
  const path = textOrNull(value?.file_path) ?? textOrNull(value?.filePath) ?? textOrNull(value?.path);
  return path ? [{ path, kind: textOrNull(value?.kind) ?? textOrNull(value?.type) }] : [];
}

function changeSummaryText(event) {
  if (toolKindCategory(event) !== 'edit') return null;
  const entries = changeEntries(event?.arguments);
  if (!entries.length) return null;
  const labels = entries.map((entry) => {
    const path = textOrNull(entry.path);
    if (!path) return null;
    return `${changeKindWords(entry.kind)} ${path}`;
  }).filter(Boolean);
  if (!labels.length) return null;
  const shown = labels.slice(0, 3);
  if (labels.length > 3) shown.push(`+${labels.length - 3} more`);
  return shown.join(' · ');
}

export function eventToolSummary(event) {
  const kind = textOrNull(event?.kind);
  const category = toolKindCategory(event);
  const changes = changeSummaryText(event);
  if (changes) return changes;
  const summary = textOrNull(event?.summary)
    ? toolSummaryText(category, event.summary)
    : null;
  if (summary) {
    // An edit whose captured arguments name no change says so in front of its
    // scalar summary, regardless of which connector supplied it.
    if (category === 'edit' && !/^(?:add|edit|delete)\s/.test(summary)) {
      return `edit ${summary}`;
    }
    return summary;
  }
  return toolKindWords(kind, category);
}
