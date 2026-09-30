// Tool kinds: the finite operation kind (command, read, edit, search, other)
// each captured tool name maps to, as each connector declares it in its
// connector.json. The declared table is read once and kept for the process.

import { loadTemplates, ownsPoolName, providerDirs } from '../lib/providers.js';

// Each connector declares how its captured tool names map to the Step page's
// finite operation kinds. Provider quirks stay in connector.json, not here.
const TOOL_KINDS = new Set(['command', 'read', 'edit', 'search', 'other']);
let connectorToolKinds = null;

function declaredToolKinds() {
  if (connectorToolKinds) return connectorToolKinds;
  let templates = {};
  try { templates = loadTemplates(providerDirs('')); } catch { templates = {}; }
  const byProvider = new Map();
  const every = new Map();
  for (const [name, template] of Object.entries(templates)) {
    const map = new Map();
    for (const [tool, kind] of Object.entries(template?.eventStream?.toolKinds ?? {})) {
      const key = String(tool).trim().toLowerCase();
      if (!key || !TOOL_KINDS.has(kind)) continue;
      map.set(key, kind);
      if (!every.has(key)) every.set(key, kind);
    }
    byProvider.set(name, map);
  }
  connectorToolKinds = { byProvider, every };
  return connectorToolKinds;
}

export function toolKindsForPool(pool) {
  const { byProvider, every } = declaredToolKinds();
  const owner = [...byProvider.keys()]
    .filter((name) => ownsPoolName(name, pool))
    .sort((a, b) => b.length - a.length)[0];
  return owner ? byProvider.get(owner) : every;
}

function withToolKinds(events, pool) {
  const kinds = toolKindsForPool(pool);
  return events.map((event) => {
    const toolKind = kinds.get(String(event?.kind ?? '').trim().toLowerCase()) ?? 'other';
    return event && typeof event === 'object' ? { ...event, toolKind } : event;
  });
}

function toolKindCategory(event) {
  const declared = event?.toolKind ?? toolKindsForPool(null).get(String(event?.kind ?? '').trim().toLowerCase()) ?? null;
  return declared && declared !== 'other' ? declared : null;
}

export {
  withToolKinds,
  toolKindCategory,
};
