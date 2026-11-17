import test from 'node:test';
import assert from 'node:assert/strict';
import { argvWithModel, followUpArgv, substituteArgv } from '../src/lib/worker-argv.js';

const PATTERNS = ['a$&b', "a$'b", 'a$`b', 'a$$b', 'a$1b', 'a$<n>b'];

test('substituteArgv inserts cwd and taskFile literally, whatever replacement patterns they hold', () => {
  for (const value of PATTERNS) {
    assert.deepEqual(
      substituteArgv(['run', '{cwd}', '{taskFile}'], { cwd: `/tmp/${value}`, taskFile: `/t/${value}` }),
      ['run', `/tmp/${value}`, `/t/${value}`],
    );
  }
});

test('substituteArgv does not rescan an inserted value for another placeholder', () => {
  assert.deepEqual(
    substituteArgv(['{taskFile}', '{cwd}'], { taskFile: '/t/{cwd}/x', cwd: '/w/{taskFile}' }),
    ['/t/{cwd}/x', '/w/{taskFile}'],
  );
});

test('substituteArgv leaves an unknown placeholder as written and passes spaces and quotes through', () => {
  const cwd = `/tmp/my "dir" it's here`;
  assert.deepEqual(
    substituteArgv(['{unknown}', '--cwd={cwd}', '{cwd}:{cwd}'], { taskFile: '/t', cwd }),
    ['{unknown}', `--cwd=${cwd}`, `${cwd}:${cwd}`],
  );
});

const followUp = (cmd) => ({ conversation: { followUp: { cmd } } });

test('followUpArgv inserts cwd, taskFile, sessionId and prompt literally', () => {
  for (const value of [...PATTERNS, 'cost $& and $1']) {
    assert.deepEqual(
      followUpArgv(followUp(['x', '{cwd}', '{taskFile}', '{sessionId}', '{prompt}']), {
        cwd: `/tmp/${value}`, taskFile: `/t/${value}`, sessionId: `s-${value}`, prompt: value,
      }),
      ['x', `/tmp/${value}`, `/t/${value}`, `s-${value}`, value],
    );
  }
});

test('followUpArgv does not rescan values and keeps unknown placeholders and non-string entries', () => {
  assert.deepEqual(
    followUpArgv(followUp(['{prompt}', '{sessionId}', '{nope}', 7]), {
      cwd: '/w', taskFile: '/t', sessionId: '{prompt}', prompt: '{sessionId} {cwd} {taskFile}',
    }),
    ['{sessionId} {cwd} {taskFile}', '{prompt}', '{nope}', '7'],
  );
});

test('followUpArgv passes a path with spaces and quotes through unchanged', () => {
  const cwd = `/tmp/my "dir" it's here`;
  assert.deepEqual(
    followUpArgv(followUp(['{cwd}']), { cwd, taskFile: '/t', sessionId: 's', prompt: 'p' }),
    [cwd],
  );
});

test('argvWithModel inserts paths and the conversation sessionId literally', () => {
  const connector = {
    spawn: { cmd: ['tool', '{cwd}', '{taskFile}'] },
    conversation: { newArgs: ['--session', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] },
  };
  for (const value of PATTERNS) {
    const paths = { cwd: `/tmp/${value}`, taskFile: `/t/${value}` };
    assert.deepEqual(
      argvWithModel(connector, paths, null, { sessionId: `s-${value}` }),
      ['tool', paths.cwd, paths.taskFile, '--session', `s-${value}`],
    );
    assert.deepEqual(
      argvWithModel(connector, paths, null, { sessionId: `s-${value}`, resume: true }).slice(-2),
      ['--resume', `s-${value}`],
    );
  }
  assert.deepEqual(
    argvWithModel(connector, { cwd: '/w', taskFile: '/t' }, null, { sessionId: '{cwd}' }).slice(-2),
    ['--session', '{cwd}'],
  );
});
