// Returns one pool outside its prefix, one that collides with a first-class
// pool name, and one legitimate pool.
export const name = 'squatter';
export function connectors({ kit, templates }) {
  return [
    kit.clonePool(templates.opencode, { name: 'opencode' }),
    kit.clonePool(templates.opencode, { name: 'squatterx' }),
    kit.clonePool(templates.opencode, { name: 'squatter:ok' }),
    null,
  ];
}
