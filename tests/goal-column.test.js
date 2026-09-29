// The goal column of `workflow runs` (QA37 rerun, N2): a goal that starts
// with a folder is shown by the words after it, so runs in different
// folders with the same lead-in can be told apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { goalColumnText } from '../src/workflow/goal-column.js';

test('a leading folder, with or without a lead-in, is dropped', () => {
  assert.equal(goalColumnText('Work in /Users/dev/qa/runs/s2-triage-r1/proj. Read every ticket in tickets/'), 'Read every ticket in tickets/');
  assert.equal(goalColumnText('In ~/src/acme, fix the failing tests'), 'fix the failing tests');
  assert.equal(goalColumnText('/srv/acme/app/: add a health endpoint'), 'add a health endpoint');
  assert.equal(goalColumnText('cd ./acme && run the linter'), 'run the linter');
  assert.equal(goalColumnText('Working in `/tmp/acme` then summarise README.md'), 'summarise README.md');
  // A note in brackets right after the folder describes the folder.
  assert.equal(goalColumnText('Work in /srv/acme/proj (a small Node ESM package, `npm test` runs `node --test (all)`). Add discount codes'), 'Add discount codes');
});

test('a goal that does not start with a folder is left as it is', () => {
  assert.equal(goalColumnText('Fix the failing tests in /srv/acme'), 'Fix the failing tests in /srv/acme');
  assert.equal(goalColumnText('Work in pairs on the parser'), 'Work in pairs on the parser');
  assert.equal(goalColumnText('Summarise the acme readme\nsecond line'), 'Summarise the acme readme');
});

test('a goal that is only a folder keeps the folder name; nothing gives ?', () => {
  assert.equal(goalColumnText('Work in /srv/acme/app'), 'app');
  assert.equal(goalColumnText(''), '?');
  assert.equal(goalColumnText(null), '?');
});

// QA37 wave H: a bare leading path with no lead-in may be the file the goal
// is about. Only a folder (a trailing "/") or a path after a lead-in is
// dropped; any other bare path is shown by its last part.
test('a bare leading file path is kept by its name, not dropped', () => {
  assert.equal(goalColumnText('./src/parser.js: fix the off-by-one'), 'parser.js: fix the off-by-one');
  assert.equal(goalColumnText('/etc/hosts is wrong, fix it'), 'hosts is wrong, fix it');
  assert.equal(goalColumnText('/srv/acme/app/: add a health endpoint'), 'add a health endpoint');
});

test('a folder alone on the first line is followed by the next non-empty line', () => {
  assert.equal(goalColumnText('Work in /srv/a/proj\n\nRead tickets'), 'Read tickets');
  assert.equal(goalColumnText('cd ~/acme\n  \nWork in /srv/acme/app. Summarise README.md'), 'Summarise README.md');
});
