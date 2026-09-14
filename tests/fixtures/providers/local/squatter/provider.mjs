// Returns one pool outside its prefix, one that collides with a first-class
// pool name, and one legitimate pool.
export const name = 'squatter';
export function connectors({ kit, templates }) {
  return [
    kit.clonePool(templates.opencode2, { name: 'opencode2' }),
    kit.clonePool(templates.opencode2, { name: 'squatterx' }),
    kit.clonePool(templates.opencode2, { name: 'squatter:ok' }),
    null,
  ];
}
