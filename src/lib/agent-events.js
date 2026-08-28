// Provider-neutral event decoding for coding-agent CLIs.
//
// Provider event shapes are declared in connectors/*.json. Core only knows
// how to apply declarative path/match rules and emit the common action shape.

function getPath(value, path) {
  if (!path) return value;
  return String(path).split('.').reduce((current, key) => {
    if (current == null) return undefined;
    return current[key];
  }, value);
}

function matches(value, match) {
  if (!match) return true;
  const actual = getPath(value, match.path);
  if (Array.isArray(match.values)) return match.values.includes(actual);
  if (Object.hasOwn(match, 'equals')) return actual === match.equals;
  return actual != null;
}

function firstValue(value, paths = []) {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return null;
}

function compact(value, max = 180) {
  if (value == null) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else return null; // Never leak an arbitrary tool input/output object into the pane.
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function outputText(value, max = 1_000_000) {
  if (typeof value !== 'string' || !value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function contextsFor(root, path) {
  if (!path) return [root];
  const expanded = getPath(root, path);
  return Array.isArray(expanded) ? expanded : [];
}

function mappedStatus(rule, context) {
  if (rule.status) return rule.status;
  const raw = rule.statusPath ? getPath(context, rule.statusPath) : null;
  if (raw == null) return rule.defaultStatus ?? null;
  return rule.statusMap?.[String(raw)] ?? compact(raw, 40) ?? rule.defaultStatus ?? null;
}

/**
 * Incrementally decode a connector-declared JSONL event stream.
 * Invalid/non-JSON lines remain ordinary transport output and are ignored here.
 */
export function createAgentEventDecoder(eventStream, { onEvent, onProgress } = {}) {
  if (!eventStream || eventStream.format !== 'jsonl') return null;
  const buffers = { stdout: '', stderr: '' };
  const outputMatches = (eventStream.output ?? []).map(() => []);
  let sequence = 0;
  const consecutive = new Map();
  let lastRuleIndex = null;
  let activeAggregate = null;

  const finalizeAggregate = (at, stream) => {
    if (!activeAggregate) return;
    const { ruleIndex: _ruleIndex, ...event } = activeAggregate;
    onEvent?.({
      ...event,
      at,
      source: stream,
      status: 'completed',
      summary: null,
      summaryMode: 'replace',
    });
    activeAggregate = null;
  };

  const decode = (root, stream, at) => {
    onProgress?.({ at, stream, providerType: compact(getPath(root, eventStream.typePath ?? 'type'), 80) });

    for (const [index, outputRule] of (eventStream.output ?? []).entries()) {
      if (!matches(root, outputRule.match)) continue;
      for (const context of contextsFor(root, outputRule.forEach)) {
        if (!matches(context, outputRule.itemMatch)) continue;
        const value = outputText(getPath(context, outputRule.path), outputRule.maxLength ?? 1_000_000);
        if (value != null) outputMatches[index].push(value);
      }
    }

    for (const [ruleIndex, rule] of (eventStream.rules ?? []).entries()) {
      if (!matches(root, rule.rootMatch)) continue;
      for (const context of contextsFor(root, rule.forEach)) {
        if (!matches(context, rule.match)) continue;
        if (activeAggregate && activeAggregate.ruleIndex !== ruleIndex) finalizeAggregate(at, stream);
        sequence += 1;
        let id = compact(firstValue(context, rule.idPaths), 120);
        if (!id && rule.aggregate === 'consecutive') {
          if (lastRuleIndex !== ruleIndex || !consecutive.has(ruleIndex)) {
            consecutive.set(ruleIndex, `stream-${ruleIndex}-${sequence}`);
          }
          id = consecutive.get(ruleIndex);
        }
        id ??= `event-${sequence}`;
        const rawSummary = firstValue(context, rule.summaryPaths) ?? rule.summary;
        const summary = rule.summaryMode === 'concat' && typeof rawSummary === 'string'
          ? rawSummary.slice(0, 180)
          : compact(rawSummary);
        const rawKind = compact(firstValue(context, rule.kindPaths) ?? rule.kind, 80) ?? 'agent';
        const normalized = {
          id,
          at,
          source: stream,
          providerType: compact(getPath(root, eventStream.typePath ?? 'type'), 80),
          kind: rule.kindMap?.[rawKind] ?? rawKind,
          status: mappedStatus(rule, context) ?? 'observed',
          summary,
          summaryMode: rule.summaryMode ?? 'replace',
        };
        onEvent?.(normalized);
        if (rule.aggregate === 'consecutive') {
          activeAggregate = {
            ruleIndex,
            id,
            providerType: normalized.providerType,
            kind: normalized.kind,
          };
        }
        lastRuleIndex = ruleIndex;
      }
    }
  };

  const flush = (stream, at) => {
    const line = buffers[stream].trim();
    buffers[stream] = '';
    if (!line) return;
    try { decode(JSON.parse(line), stream, at); } catch { /* ordinary CLI text */ }
  };

  return {
    push(chunk, stream = 'stdout', at = new Date().toISOString()) {
      buffers[stream] += chunk.toString();
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { decode(JSON.parse(line), stream, at); } catch { /* ordinary CLI text */ }
      }
    },
    finish(at = new Date().toISOString()) {
      flush('stdout', at);
      flush('stderr', at);
      finalizeAggregate(at, 'event-stream');
    },
    output() {
      for (const [index, rule] of (eventStream.output ?? []).entries()) {
        const values = outputMatches[index];
        if (!values.length) continue;
        return rule.mode === 'concat' ? values.join(rule.separator ?? '') : values.at(-1);
      }
      return '';
    },
  };
}

export function recordAgentAction(agent, event, maxActions = 3) {
  agent.lastActions ??= [];
  const existingIndex = agent.lastActions.findIndex((action) => action.id === event.id);
  const existing = existingIndex >= 0 ? agent.lastActions.splice(existingIndex, 1)[0] : {};
  const isNew = existingIndex < 0;
  const statusChanged = existing.status != null && existing.status !== event.status;
  let summary = event.summary ?? existing.summary ?? null;
  let summaryRaw = event.summary ?? existing._summaryRaw ?? existing.summary ?? null;
  if (event.summaryMode === 'concat' && event.summary) {
    summaryRaw = `${existing._summaryRaw ?? existing.summary ?? ''}${event.summary}`.slice(-1000);
    summary = compact(summaryRaw);
  }
  const action = { ...existing, ...event, summary, summaryMode: undefined };
  Object.defineProperty(action, '_summaryRaw', { value: summaryRaw, writable: true, enumerable: false });
  agent.lastActions.push(action);
  agent.lastActions = agent.lastActions.slice(-maxActions);
  agent.lastActionAt = event.at;
  agent.lastProgressAt = event.at;
  return { action: agent.lastActions.at(-1), isNew, statusChanged };
}

export function classifyAgentProgress(agent, nowMs = Date.now(), silenceThresholdSec = 600) {
  const timestamps = [agent.lastActionAt, agent.lastEventAt, agent.lastActivityAt, agent.startedAt]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const lastProgressMs = timestamps.length ? Math.max(...timestamps) : nowMs;
  const silentForSec = Math.max(0, Math.floor((nowMs - lastProgressMs) / 1000));
  return {
    status: silentForSec >= silenceThresholdSec ? 'suspected_stalled' : 'active',
    silentForSec,
    thresholdSec: silenceThresholdSec,
    lastProgressAt: new Date(lastProgressMs).toISOString(),
    autoTerminate: false,
  };
}
