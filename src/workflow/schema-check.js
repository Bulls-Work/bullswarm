// Zero-dependency validator for a declared JSON Schema subset (stage-2 E19,
// spec §2.9). Keywords outside the subset are refused, never skipped, so a
// check that passes never hides a rule nobody ran. `format` is an annotation
// (as JSON Schema 2020-12 defines it) and is reported in a note.
//
// No imports beyond node:fs and node:path: bin/check-schema.js runs this in a
// child process so large parses stay off the kernel's event loop.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCHEMA_ASSERTED_KEYWORDS = Object.freeze([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'allOf', 'anyOf', 'oneOf', 'not', '$ref',
]);
export const SCHEMA_IGNORED_KEYWORDS = Object.freeze([
  '$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format',
]);
export const SCHEMA_MAX_DATA_BYTES = 32 * 1024 * 1024;
export const SCHEMA_MAX_SCHEMA_BYTES = 1024 * 1024;
export const SCHEMA_MAX_ERRORS = 100;
export const SCHEMA_MAX_DEPTH = 64;

const ASSERTED = new Set(SCHEMA_ASSERTED_KEYWORDS);
const IGNORED = new Set(SCHEMA_IGNORED_KEYWORDS);
const TYPE_NAMES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const DEPTH_MESSAGE = `schema nesting deeper than ${SCHEMA_MAX_DEPTH}`;

const hasOwn = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSchema = (value) => typeof value === 'boolean' || isObject(value);

function pointerPart(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}
const childPointer = (at, ...keys) => `${at}${keys.map((key) => `/${pointerPart(key)}`).join('')}`;

function resolvePointer(root, ref) {
  if (ref === '#') return { found: true, value: root };
  if (!ref.startsWith('#/')) return { found: false };
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < node.length) node = node[Number(key)];
    else if (isObject(node) && hasOwn(node, key)) node = node[key];
    else return { found: false };
  }
  return { found: true, value: node };
}

/**
 * The refusals of §2.9: `[{ keyword, at, message }]`, in document order.
 * Also counts `format` places (returned as `formatPlaces` on the array).
 */
export function schemaSubsetIssues(schema) {
  const issues = [];
  let formatPlaces = 0;
  const refuse = (keyword, at, message) => issues.push({ keyword, at, message: message ?? `unsupported keyword "${keyword}" at ${at}` });
  const walk = (node, at, depth) => {
    if (depth > SCHEMA_MAX_DEPTH) {
      if (!issues.some((issue) => issue.message === DEPTH_MESSAGE)) refuse('$depth', at, DEPTH_MESSAGE);
      return;
    }
    if (typeof node === 'boolean') return;
    if (!isObject(node)) { refuse('$schema-value', at, `schema at ${at} must be an object or a boolean`); return; }
    for (const key of Object.keys(node)) {
      const value = node[key];
      const here = childPointer(at, key);
      if (IGNORED.has(key)) {
        if (key === 'format') formatPlaces += 1;
        if ((key === '$defs' || key === 'definitions') && isObject(value)) {
          for (const name of Object.keys(value)) walk(value[name], childPointer(here, name), depth + 1);
        }
        continue;
      }
      if (!ASSERTED.has(key)) { refuse(key, at); continue; }
      switch (key) {
        case '$ref':
          if (typeof value !== 'string' || !(value === '#' || value.startsWith('#/'))) {
            refuse(key, at, `$ref ${JSON.stringify(value)} is not local`);
          } else if (!resolvePointer(schema, value).found) {
            refuse(key, at, `$ref ${JSON.stringify(value)} does not resolve at ${at}`);
          }
          break;
        case 'type': {
          const names = Array.isArray(value) ? value : [value];
          if (!names.length || names.some((name) => typeof name !== 'string' || !TYPE_NAMES.has(name))) {
            refuse(key, at, `type at ${at} must name object, array, string, number, integer, boolean or null`);
          }
          break;
        }
        case 'properties':
          if (!isObject(value)) refuse(key, at, `properties at ${at} must be an object`);
          else for (const name of Object.keys(value)) walk(value[name], childPointer(here, name), depth + 1);
          break;
        case 'additionalProperties':
        case 'not':
          walk(value, here, depth + 1);
          break;
        case 'items':
          if (Array.isArray(value)) refuse(key, at);
          else walk(value, here, depth + 1);
          break;
        case 'allOf': case 'anyOf': case 'oneOf':
          if (!Array.isArray(value) || !value.length) refuse(key, at, `${key} at ${at} must be a non-empty array of schemas`);
          else value.forEach((sub, index) => walk(sub, childPointer(here, index), depth + 1));
          break;
        case 'required':
          if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) refuse(key, at, `required at ${at} must be an array of strings`);
          break;
        case 'enum':
          if (!Array.isArray(value)) refuse(key, at, `enum at ${at} must be an array`);
          break;
        case 'exclusiveMinimum': case 'exclusiveMaximum':
          if (typeof value === 'boolean') refuse(key, at);
          else if (typeof value !== 'number') refuse(key, at, `${key} at ${at} must be a number`);
          break;
        case 'minimum': case 'maximum':
          if (typeof value !== 'number') refuse(key, at, `${key} at ${at} must be a number`);
          break;
        case 'multipleOf':
          if (typeof value !== 'number' || !(value > 0)) refuse(key, at, `multipleOf at ${at} must be a number above 0`);
          break;
        case 'minLength': case 'maxLength': case 'minItems': case 'maxItems':
        case 'minProperties': case 'maxProperties':
          if (!Number.isInteger(value) || value < 0) refuse(key, at, `${key} at ${at} must be a non-negative integer`);
          break;
        case 'uniqueItems':
          if (typeof value !== 'boolean') refuse(key, at, `uniqueItems at ${at} must be a boolean`);
          break;
        case 'pattern':
          if (typeof value !== 'string') refuse(key, at, `pattern at ${at} must be a string`);
          else {
            try { new RegExp(value, 'u'); } catch (error) { refuse(key, at, `pattern at ${at} is not a valid regular expression: ${error.message}`); }
          }
          break;
        default:
          break;
      }
    }
  };
  walk(schema, '#', 0);
  Object.defineProperty(issues, 'formatPlaces', { value: formatPlaces, enumerable: false });
  return issues;
}

function formatNote(places) {
  return `format is not checked (${places} ${places === 1 ? 'place' : 'places'})`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const childPath = (path, key) => (IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, name) {
  switch (name) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

export function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

function cutJson(value, max = 80) {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isMultiple(value, divisor) {
  const quotient = value / divisor;
  if (!Number.isFinite(quotient)) return false;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

class SchemaCheckFault extends Error {}

/**
 * Validate a parsed value. Returns `{ errors, count, notes, capped }`:
 * `errors` holds at most `maxErrors` messages, `count` the number kept, and
 * `capped` is true when more errors existed. Throws a SchemaCheckFault
 * (message `schema nesting deeper than 64`) for a `$ref` chain that loops
 * without consuming data.
 */
export function validateAgainstSchema(value, schema, { maxErrors = SCHEMA_MAX_ERRORS, root = schema, prefix = '' } = {}) {
  const sink = { errors: [], capped: false };
  const push = (target, message) => {
    if (target.errors.length >= maxErrors) { target.capped = true; return; }
    target.errors.push(`${prefix}${message}`);
  };

  // `refDepth` counts $ref hops at the same data location.
  const check = (data, node, path, target, refDepth) => {
    if (target.capped) return;
    if (node === true) return;
    if (node === false) { push(target, `${path} is not allowed`); return; }
    if (!isObject(node)) return;

    if (hasOwn(node, '$ref')) {
      if (refDepth >= SCHEMA_MAX_DEPTH) throw new SchemaCheckFault(DEPTH_MESSAGE);
      const target$ = resolvePointer(root, node.$ref);
      if (target$.found) check(data, target$.value, path, target, refDepth + 1);
    }

    if (hasOwn(node, 'type')) {
      const names = Array.isArray(node.type) ? node.type : [node.type];
      if (!names.some((name) => matchesType(data, name))) {
        push(target, `${path} must be ${names.join('|')} (got ${typeOf(data)})`);
      }
    }
    if (hasOwn(node, 'enum') && !node.enum.some((option) => jsonEqual(option, data))) {
      push(target, `${path} must be one of ${cutJson(node.enum)}`);
    }
    if (hasOwn(node, 'const') && !jsonEqual(node.const, data)) {
      push(target, `${path} must equal ${cutJson(node.const)}`);
    }

    if (typeof data === 'string') {
      const length = [...data].length;
      if (hasOwn(node, 'minLength') && length < node.minLength) push(target, `${path} must be at least ${node.minLength} characters`);
      if (hasOwn(node, 'maxLength') && length > node.maxLength) push(target, `${path} must be at most ${node.maxLength} characters`);
      if (hasOwn(node, 'pattern') && !new RegExp(node.pattern, 'u').test(data)) push(target, `${path} must match pattern ${node.pattern}`);
    }

    if (typeof data === 'number') {
      if (hasOwn(node, 'minimum') && !(data >= node.minimum)) push(target, `${path} must be >= ${node.minimum}`);
      if (hasOwn(node, 'maximum') && !(data <= node.maximum)) push(target, `${path} must be <= ${node.maximum}`);
      if (hasOwn(node, 'exclusiveMinimum') && !(data > node.exclusiveMinimum)) push(target, `${path} must be > ${node.exclusiveMinimum}`);
      if (hasOwn(node, 'exclusiveMaximum') && !(data < node.exclusiveMaximum)) push(target, `${path} must be < ${node.exclusiveMaximum}`);
      if (hasOwn(node, 'multipleOf') && !isMultiple(data, node.multipleOf)) push(target, `${path} must be a multiple of ${node.multipleOf}`);
    }

    if (Array.isArray(data)) {
      if (hasOwn(node, 'minItems') && data.length < node.minItems) push(target, `${path} must have at least ${node.minItems} items`);
      if (hasOwn(node, 'maxItems') && data.length > node.maxItems) push(target, `${path} must have at most ${node.maxItems} items`);
      if (node.uniqueItems === true) {
        outer: for (let i = 0; i < data.length; i += 1) {
          for (let j = i + 1; j < data.length; j += 1) {
            if (jsonEqual(data[i], data[j])) { push(target, `${path} has duplicate items at [${i}] and [${j}]`); break outer; }
          }
        }
      }
      if (hasOwn(node, 'items')) data.forEach((item, index) => check(item, node.items, `${path}[${index}]`, target, 0));
    }

    if (isObject(data)) {
      const keys = Object.keys(data);
      if (hasOwn(node, 'minProperties') && keys.length < node.minProperties) push(target, `${path} must have at least ${node.minProperties} properties`);
      if (hasOwn(node, 'maxProperties') && keys.length > node.maxProperties) push(target, `${path} must have at most ${node.maxProperties} properties`);
      if (Array.isArray(node.required)) {
        for (const name of node.required) if (!hasOwn(data, name)) push(target, `${path} is missing required property ${JSON.stringify(name)}`);
      }
      const properties = isObject(node.properties) ? node.properties : null;
      for (const key of keys) {
        const declared = properties && hasOwn(properties, key);
        if (declared) check(data[key], properties[key], childPath(path, key), target, 0);
        else if (hasOwn(node, 'additionalProperties')) {
          if (node.additionalProperties === false) push(target, `${childPath(path, key)} is not allowed`);
          else check(data[key], node.additionalProperties, childPath(path, key), target, 0);
        }
      }
    }

    if (Array.isArray(node.allOf)) for (const sub of node.allOf) check(data, sub, path, target, refDepth);
    const passes = (sub) => {
      const probe = { errors: [], capped: false };
      checkProbe(data, sub, path, probe, refDepth);
      return probe.errors.length === 0;
    };
    if (Array.isArray(node.anyOf) && !node.anyOf.some(passes)) {
      push(target, `${path} must match at least one of anyOf (${node.anyOf.length} options)`);
    }
    if (Array.isArray(node.oneOf)) {
      const matched = node.oneOf.filter(passes).length;
      if (matched !== 1) push(target, `${path} must match exactly one of oneOf (matched ${matched} of ${node.oneOf.length})`);
    }
    if (hasOwn(node, 'not') && passes(node.not)) push(target, `${path} must not match the not schema`);
  };
  // A branch probe stops at its first error: only pass or fail matters.
  const checkProbe = (data, node, path, probe, refDepth) => {
    const saved = maxErrors;
    maxErrors = 1;
    try { check(data, node, path, probe, refDepth); } finally { maxErrors = saved; }
  };

  check(value, schema, '$', sink, 0);
  return { errors: sink.errors, count: sink.errors.length, capped: sink.capped, notes: [] };
}

function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fileSize(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { size: stat.size } : { directory: stat.isDirectory() };
  } catch { return null; }
}

const FENCE = /^\s*```[^\n`]*\n([\s\S]*?)\n?```\s*$/;

/** Unwrap a text that is exactly one fenced code block, or return null. */
export function unwrapOneFence(text) {
  const match = FENCE.exec(text);
  if (!match) return null;
  if (/^\s*```/m.test(match[1])) return null;
  return match[1];
}

export function defaultSchemaFormat(file) {
  return /\.(jsonl|ndjson)$/i.test(String(file ?? '')) ? 'jsonl' : 'json';
}

function errorsWhy(count, capped) {
  if (capped) return `not valid: ${count}+ errors`;
  return `not valid: ${count} ${count === 1 ? 'error' : 'errors'}`;
}

/**
 * Check a data file against a schema file. Returns
 * `{ exit, errorCount, errors, notes, why, fault }`: exit 0 valid, 1 invalid,
 * 2 cannot check (`fault` `data` for a missing or unparsable data file, `check`
 * for every schema-side reason and the data size cap; null otherwise).
 */
export function checkSchemaFiles({ cwd = process.cwd(), file, schema, format, unfence = false, maxErrors = SCHEMA_MAX_ERRORS } = {}) {
  const fail = (fault, why, notes = []) => ({ exit: 2, errorCount: 0, errors: [], notes, why, fault });
  const schemaPath = resolve(cwd, schema);
  const dataPath = resolve(cwd, file);
  const mode = format ?? defaultSchemaFormat(file);
  if (mode !== 'json' && mode !== 'jsonl') return fail('check', `format must be json or jsonl (got ${mode})`);

  const schemaStat = fileSize(schemaPath);
  if (!schemaStat) return fail('check', `schema missing: ${schema}`);
  if (schemaStat.directory) return fail('check', `schema names a directory: ${schema}`);
  if (schemaStat.size > SCHEMA_MAX_SCHEMA_BYTES) return fail('check', `schema too large: ${mib(schemaStat.size)} (limit 1 MiB)`);
  let schemaValue;
  try { schemaValue = JSON.parse(readFileSync(schemaPath, 'utf8')); } catch (error) {
    return fail('check', `schema is not JSON: ${error.message}`);
  }
  const issues = schemaSubsetIssues(schemaValue);
  if (issues.length) return fail('check', issues[0].message);
  const notes = [];

  const dataStat = fileSize(dataPath);
  if (!dataStat) return fail('data', `file missing: ${file}`);
  if (dataStat.directory) return fail('data', `file names a directory: ${file}`);
  if (dataStat.size > SCHEMA_MAX_DATA_BYTES) return fail('check', `file too large: ${mib(dataStat.size)} (limit 32 MiB)`);
  let text;
  try { text = readFileSync(dataPath, 'utf8'); } catch (error) { return fail('data', `file unreadable: ${error.message}`); }
  if (unfence) {
    const inner = unwrapOneFence(text);
    if (inner != null) { text = inner; notes.push('unwrapped one fenced code block'); }
  }
  if (issues.formatPlaces) notes.push(formatNote(issues.formatPlaces));

  const records = [];
  if (mode === 'json') {
    try { records.push({ value: JSON.parse(text), prefix: '' }); } catch (error) {
      return fail('data', `not JSON: ${error.message}`, notes);
    }
  } else {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      try { records.push({ value: JSON.parse(lines[index]), prefix: `line ${index + 1}: ` }); } catch (error) {
        return fail('data', `line ${index + 1}: not JSON: ${error.message}`, notes);
      }
    }
  }

  const errors = [];
  let capped = false;
  try {
    for (const record of records) {
      if (errors.length >= maxErrors) { capped = true; break; }
      const result = validateAgainstSchema(record.value, schemaValue, { maxErrors: maxErrors - errors.length, prefix: record.prefix });
      errors.push(...result.errors);
      if (result.capped) capped = true;
    }
  } catch (error) {
    if (error instanceof SchemaCheckFault) return fail('check', error.message, notes);
    if (error instanceof RangeError) return fail('data', 'data nesting too deep to check', notes);
    throw error;
  }
  if (!errors.length) return { exit: 0, errorCount: 0, errors: [], notes, why: null, fault: null };
  return { exit: 1, errorCount: errors.length, errors, notes, why: errorsWhy(errors.length, capped), fault: null };
}
