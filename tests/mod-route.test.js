import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argvOf, decide } from '../mods/bullswarm/hooks/route.ts';

const pools = [
  { name: 'claude-code', enabled: true, quarantine: false },
  { name: 'grok', enabled: true, quarantine: false },
];

// A v3 build run must change a file (run-step.js), so a subagent that only
// answers a question would fail `not-produced`. General subagents read and
// answer on the analyze lane.
test('a general-purpose or untyped subagent with a read-only prompt routes on lane analyze', () => {
  const prompt = 'Where is the pace computed? Answer with the file and function name only.';
  for (const subagent_type of [undefined, '', 'general-purpose', 'claude']) {
    const decision = decide({ prompt, subagent_type }, pools);
    assert.equal(decision.route, true, `subagent_type ${subagent_type}`);
    assert.equal(decision.lane, 'analyze', `subagent_type ${subagent_type}`);
  }
});

test('Explore and Plan still route on lane analyze; other types stay in-session', () => {
  assert.equal(decide({ prompt: 'map the repo', subagent_type: 'Explore' }, pools).lane, 'analyze');
  assert.equal(decide({ prompt: 'plan it', subagent_type: 'Plan' }, pools).lane, 'analyze');
  assert.equal(decide({ prompt: 'x', subagent_type: 'code-reviewer' }, pools).route, false);
});

// The mod's process budget (register.ts RUN_PROCESS_MS, 585 s) holds one
// 540 s attempt, and a failed run already falls back in-session, so the run
// must not start a retry the mod would kill.
test('the routed run asks for one attempt only', () => {
  const argv = argvOf({ lane: 'analyze', cwd: '/tmp/acme', task: 'hi', timeoutSec: 540 });
  assert.ok(argv.includes('--no-retry'), argv.join(' '));
  assert.deepEqual(argv.slice(0, 4), ['bullswarm', 'run', '--lane', 'analyze']);
  assert.equal(argv.at(-1), 'hi');
});
