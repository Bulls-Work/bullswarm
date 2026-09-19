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

const NUMERIC_USAGE_FIELDS = new Set([
  'standardRead', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'output', 'reasoning', 'costUsd',
]);

function usageScalar(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (NUMERIC_USAGE_FIELDS.has(field)) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function mergeUsageField(target, field, value, mode) {
  const normalized = usageScalar(value, field);
  if (normalized === null) return;
  if (NUMERIC_USAGE_FIELDS.has(field) && mode === 'sum') {
    target[field] = (Number.isFinite(target[field]) ? target[field] : 0) + normalized;
  } else if (NUMERIC_USAGE_FIELDS.has(field) && mode === 'max') {
    target[field] = Math.max(Number.isFinite(target[field]) ? target[field] : 0, normalized);
  } else {
    // `last` is the cumulative-total rule. Non-numeric fields also use the
    // latest value for sum/max rules because a session id/model is identity,
    // not a quantity to add or compare.
    target[field] = normalized;
  }
}

function applyInclusiveUsage(target, inclusive) {
  if (!inclusive || typeof inclusive !== 'object' || Array.isArray(inclusive)) return;
  for (const [field, components] of Object.entries(inclusive)) {
    if (!Number.isFinite(target[field]) || !Array.isArray(components)) continue;
    const included = components.reduce((sum, component) => (
      sum + (Number.isFinite(target[component]) ? target[component] : 0)
    ), 0);
    target[field] = Math.max(0, target[field] - included);
  }
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
  const usageRules = Array.isArray(eventStream.usage)
    ? eventStream.usage
    : eventStream.usage ? [eventStream.usage] : [];
  const usageMatches = usageRules.map(() => ({}));
  const usageSeen = usageRules.map(() => false);
  const usageFields = new Set(usageRules.flatMap((rule) => Object.keys(rule?.fields ?? {})));
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
    onProgress?.({
      at,
      stream,
      providerType: compact(getPath(root, eventStream.typePath ?? 'type'), 80),
      model: compact(firstValue(root, eventStream.modelPaths), 120),
    });

    for (const [index, outputRule] of (eventStream.output ?? []).entries()) {
      if (!matches(root, outputRule.match)) continue;
      for (const context of contextsFor(root, outputRule.forEach)) {
        if (!matches(context, outputRule.itemMatch)) continue;
        const value = outputText(getPath(context, outputRule.path), outputRule.maxLength ?? 1_000_000);
        if (value != null) outputMatches[index].push(value);
      }
    }

    // Usage is deliberately a separate declarative rule family from output
    // and semantic actions. A provider can report cumulative totals on one
    // final event (`last`), per-request counters on many events (`sum`), or
    // a monotonic counter where the safest fallback is the largest value
    // (`max`) without core knowing the provider's event vocabulary.
    for (const [index, usageRule] of usageRules.entries()) {
      if (!matches(root, usageRule.rootMatch)) continue;
      const mode = ['last', 'sum', 'max'].includes(usageRule.mode) ? usageRule.mode : 'last';
      for (const context of contextsFor(root, usageRule.forEach)) {
        if (!matches(context, usageRule.match)) continue;
        usageSeen[index] = true;
        for (const [field, path] of Object.entries(usageRule.fields ?? {})) {
          mergeUsageField(usageMatches[index], field, getPath(context, path), mode);
        }
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
        const fullSummary = typeof rawSummary === 'string' ? rawSummary
          : (typeof rawSummary === 'number' || typeof rawSummary === 'boolean' ? String(rawSummary) : null);
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
        // Second arg is the pre-compaction scalar so a persist sink can keep
        // full response text; the pane reads `normalized.summary` only.
        onEvent?.(normalized, fullSummary);
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
    usage() {
      if (!usageSeen.some(Boolean)) return null;
      const result = {};
      for (const field of usageFields) {
        for (let index = usageMatches.length - 1; index >= 0; index -= 1) {
          if (usageSeen[index] && usageMatches[index][field] !== undefined) {
            result[field] = usageMatches[index][field];
            break;
          }
        }
      }
      // Some providers report inclusive counters (for example Codex reports
      // cached input inside input_tokens and reasoning inside output_tokens).
      // Apply connector-declared subtraction only after all usage rules have
      // been merged, and floor each exclusive class at zero.
      for (const usageRule of usageRules) applyInclusiveUsage(result, usageRule.inclusive);
      return result;
    },
  };
}
