const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'enum', 'minimum', 'maximum', 'minLength', 'pattern', 'description']);

function matches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateNode(value, schema, path, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matches(value, type))) {
      errors.push(`${path || 'value'} must be ${types.join('|')}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) errors.push(`${path || 'value'} must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path || 'value'} must have at least ${schema.minLength} characters`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) errors.push(`${path || 'value'} must match pattern ${JSON.stringify(schema.pattern)}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path || 'value'} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path || 'value'} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path || 'value'} must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path || 'value'} must contain at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path ? `${path}.` : ''}${key} is required`);
    for (const [key, child] of Object.entries(properties)) if (key in value) validateNode(value[key], child, `${path ? `${path}.` : ''}${key}`, errors);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${path ? `${path}.` : ''}${key} is not allowed`);
  }
}

function schemaIssues(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path} must be an object`];
  const issues = [];
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) issues.push(`${path}.${key} is an unknown keyword`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !TYPES.has(type))) issues.push(`${path}.type must be a supported type or array of supported types`);
  }
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) issues.push(`${path}.properties must be an object`);
  else for (const [key, child] of Object.entries(schema.properties ?? {})) issues.push(...schemaIssues(child, `${path}.properties.${key}`));
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) issues.push(`${path}.required must be an array of strings`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') issues.push(`${path}.additionalProperties must be a boolean`);
  if (schema.items !== undefined) issues.push(...schemaIssues(schema.items, `${path}.items`));
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) issues.push(`${path}.enum must be an array`);
  for (const key of ['minItems', 'maxItems', 'minLength']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) issues.push(`${path}.${key} must be a non-negative integer`);
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) issues.push(`${path}.${key} must be a finite number`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') issues.push(`${path}.pattern must be a string`);
    else try { new RegExp(schema.pattern); } catch (err) { issues.push(`${path}.pattern is not a valid regex: ${err.message}`); }
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') issues.push(`${path}.description must be a string`);
  return issues;
}

export function isValidOutputSchema(schema) {
  const issues = schemaIssues(schema);
  return { ok: issues.length === 0, issues };
}

export function validateAgainstSchema(value, schema) {
  const validity = isValidOutputSchema(schema);
  if (!validity.ok) return { ok: false, errors: validity.issues };
  const errors = [];
  validateNode(value, schema, '', errors);
  return { ok: errors.length === 0, errors };
}
