export const name = 'thrower';
export function connectors() {
  throw new Error('thrower exploded');
}
