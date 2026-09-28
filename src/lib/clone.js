// A deep copy of JSON data; undefined stays undefined.
export const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
