export const name = 'sidecar';
export const displayName = 'Sidecar';
export function connectors({ templates, kit }) {
  return [kit.clonePool(templates.relaykit, { name: 'sidecar' })];
}
