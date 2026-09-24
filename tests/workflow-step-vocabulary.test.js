import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_KINDS, KIND_DEFAULTS } from '../src/workflow/action-validator.js';
import {
  DELIVERABLE_TYPES, EVIDENCE_TYPES, KIND_ROLES, ROLES,
  ROLE_DEFAULT_DELIVERABLE, ROLE_ROUTING,
  declaredDeliverable, deliverableTypeOf, laneFitsDeliverable, roleOf, roleRouting,
} from '../src/workflow/step-vocabulary.js';

test('ROLES, DELIVERABLE_TYPES and EVIDENCE_TYPES are the exact lists', () => {
  assert.deepEqual([...ROLES], ['investigate', 'produce', 'transform', 'combine', 'check', 'act']);
  assert.deepEqual([...DELIVERABLE_TYPES], ['files', 'report', 'data', 'media', 'outward']);
  assert.deepEqual([...EVIDENCE_TYPES], ['command', 'schema', 'review', 'choice']);
});

test('KIND_ROLES keys match ACTION_KINDS and values are the D8 roles', () => {
  assert.deepEqual(Object.keys(KIND_ROLES), [...ACTION_KINDS]);
  assert.deepEqual(KIND_ROLES, {
    mechanical: 'transform',
    'io-read': 'investigate',
    digest: 'combine',
    check: 'check',
    implement: 'produce',
    integration: 'combine',
    architecture: 'investigate',
    'adversarial-acceptance': 'check',
  });
  for (const role of Object.values(KIND_ROLES)) assert.ok(ROLES.includes(role), role);
});

test('ROLE_ROUTING matches the role table, including combine + data', () => {
  const cell = (lane, effort) => ({ lane, effort });
  const writer = {
    files: cell('build', 'medium'),
    data: cell('build', 'medium'),
    media: cell('build', 'medium'),
    report: cell('analyze', 'medium'),
  };
  assert.deepEqual(ROLE_ROUTING, {
    investigate: writer,
    produce: writer,
    transform: {
      files: cell('chore', 'low'),
      data: cell('chore', 'low'),
      media: cell('chore', 'low'),
      report: cell('analyze', 'low'),
    },
    combine: {
      files: cell('build', 'high'),
      data: cell('build', 'medium'),
      media: cell('build', 'medium'),
      report: cell('analyze', 'medium'),
    },
    check: { report: cell('analyze', 'medium') },
    act: { outward: cell('analyze', 'medium') },
  });
  assert.deepEqual(roleRouting('combine', 'data'), { lane: 'build', effort: 'medium' });
  assert.equal(roleRouting('investigate', 'outward'), null);
  assert.equal(roleRouting('check', 'files'), null);
  assert.equal(roleRouting('act', 'report'), null);
  assert.equal(Object.hasOwn(ROLE_DEFAULT_DELIVERABLE, 'combine'), false);
});

test('only kind check and role check route identically; other rows match the difference table', () => {
  const difference = {
    mechanical: { role: 'transform', kind: { lane: 'chore', effort: 'low' }, roleAlone: { lane: 'chore', effort: 'low' } },
    'io-read': { role: 'investigate', kind: { lane: 'analyze', effort: 'low' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    architecture: { role: 'investigate', kind: { lane: 'analyze', effort: 'high' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    implement: { role: 'produce', kind: { lane: 'build', effort: 'medium' }, roleAlone: { lane: 'build', effort: 'medium' } },
    integration: { role: 'combine', kind: { lane: 'build', effort: 'high' }, roleAlone: null },
    digest: { role: 'combine', kind: { lane: 'analyze', effort: 'low' }, roleAlone: null },
    check: { role: 'check', kind: { lane: 'analyze', effort: 'medium' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
    'adversarial-acceptance': { role: 'check', kind: { lane: 'analyze', effort: 'high' }, roleAlone: { lane: 'analyze', effort: 'medium' } },
  };
  const identical = [];
  for (const kind of ACTION_KINDS) {
    const row = difference[kind];
    const role = KIND_ROLES[kind];
    const kindRoute = { lane: KIND_DEFAULTS[kind].lane, effort: KIND_DEFAULTS[kind].effort };
    const defaultType = ROLE_DEFAULT_DELIVERABLE[role];
    const roleRoute = defaultType ? roleRouting(role, defaultType) : null;
    assert.equal(role, row.role, kind);
    assert.deepEqual(kindRoute, row.kind, kind);
    if (row.roleAlone) assert.deepEqual(roleRoute, row.roleAlone, kind);
    else assert.equal(roleRoute, null, kind);
    if (kind === role && roleRoute && roleRoute.lane === kindRoute.lane && roleRoute.effort === kindRoute.effort) identical.push(kind);
  }
  assert.deepEqual(identical, ['check']);
});

test('roleOf, deliverableTypeOf, declaredDeliverable and laneFitsDeliverable', () => {
  assert.equal(roleOf({ role: 'act' }), 'act');
  assert.equal(roleOf({ kind: 'implement' }), 'produce');
  assert.equal(roleOf({ lane: 'build' }), null);
  assert.equal(roleOf({ role: 'check', kind: 'implement' }), 'check');
  for (const kind of ['constructor', 'toString', '__proto__', 'bogus']) assert.equal(roleOf({ kind }), null, kind);
  assert.equal(deliverableTypeOf('report'), 'report');
  assert.equal(deliverableTypeOf({ type: 'data', paths: ['out/a.json'] }), 'data');
  assert.equal(deliverableTypeOf('actions'), null);
  assert.equal(deliverableTypeOf(undefined), null);
  assert.deepEqual(declaredDeliverable({ deliverable: 'files' }), { type: 'files' });
  assert.deepEqual(declaredDeliverable({ deliverable: { type: 'files', paths: [] } }), { type: 'files' });
  assert.deepEqual(declaredDeliverable({ deliverable: { type: 'data', paths: ['out/a.json'], note: 1 } }), { type: 'data', paths: ['out/a.json'] });
  assert.equal(declaredDeliverable({}), null);
  assert.equal(laneFitsDeliverable('build', 'files'), true);
  assert.equal(laneFitsDeliverable('chore', 'media'), true);
  assert.equal(laneFitsDeliverable('analyze', 'data'), false);
  assert.equal(laneFitsDeliverable('analyze', 'report'), true);
  assert.equal(laneFitsDeliverable('analyze', 'outward'), true);
  assert.equal(laneFitsDeliverable('build', 'report'), false);
  assert.equal(laneFitsDeliverable('chore', 'outward'), false);
});
