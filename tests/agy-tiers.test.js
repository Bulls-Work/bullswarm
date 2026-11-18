
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { buildStrategy, discoverConnectorModels } from '../src/lib/strategy.js';
import { argvWithModel } from '../src/lib/worker-argv.js';
import { resolveReasoningLevel } from '../src/lib/reasoning.js';
import { connectors } from '../src/providers/agy/provider.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const AGY_DIR = join(REPO, 'src', 'providers', 'agy');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'agy');
const MODELS_TXT = readFileSync(join(FIXTURES, 'models.txt'), 'utf8');

async function setup() {
  const template = JSON.parse(readFileSync(join(AGY_DIR, 'connector.json'), 'utf8'));
  const [agy, claude] = connectors({ template });
  const provider = { name: 'agy', ctx: { now: () => Date.now() } };
  const executor = async () => MODELS_TXT;
  
  const discoveries = {
    agy: await discoverConnectorModels(agy, { provider, providerExecutor: executor }),
    'agy:claude': await discoverConnectorModels(claude, { provider, providerExecutor: executor }),
  };
  
  return { agy, claude, discoveries };
}

test('agy rungs/suggestions = hydrogen on all three tiers at high/high/medium, agy:claude unchanged', async () => {
  const { agy, claude, discoveries } = await setup();
  const poolFor = (connector) => ({
    name: connector.name, connector, enabled: true, pace: 0, costRank: connector.costRank,
    lanes: connector.lanes, capabilities: connector.capabilities,
  });
  
  const report = buildStrategy({
    connectors: { agy, 'agy:claude': claude }, 
    pools: [poolFor(agy), poolFor(claude)], 
    state: {}, 
    discoveries,
  });
  
  const gemini = report.providerSuggestions.agy;
  assert.equal(gemini.high.recommended.model, 'gemini-4-hydrogen', 'high');
  assert.equal(gemini.medium.recommended.model, 'gemini-4-hydrogen', 'medium');
  assert.equal(gemini.low.recommended.model, 'gemini-4-hydrogen', 'low');
  
  // Verify reasoning levels
  const at = (tier, model, level) => resolveReasoningLevel({ 
    connector: agy, tier, model, 
    strategy: { lastReport: { discoveries } }, 
    actionOverride: level 
  });
  
  assert.equal(at('high', 'gemini-4-hydrogen', 'high').applied, 'high');
  assert.equal(at('medium', 'gemini-4-hydrogen', 'high').applied, 'high');
  assert.equal(at('low', 'gemini-4-hydrogen', 'medium').applied, 'medium');

  const other = report.providerSuggestions['agy:claude'];
  assert.equal(other.high.recommended, null);
  assert.equal(other.medium.recommended.model, 'claude-opus-4-6-thinking');
});

test('dispatch argv per tier on agy: --model gemini-4-hydrogen with --effort high, high, medium', async () => {
  const { agy } = await setup();
  const paths = { taskFile: '/w/task.md', cwd: '/w' };
  
  for (const [tier, level, effort] of [['high', 'high', 'high'], ['medium', 'high', 'high'], ['low', 'medium', 'medium']]) {
    const reasoning = { applied: level };
    const argv = argvWithModel(agy, paths, 'gemini-4-hydrogen', null, reasoning);
    assert.ok(argv.includes('--model'), `missing --model for ${tier}`);
    assert.ok(argv.includes('gemini-4-hydrogen'), `wrong model for ${tier}`);
    assert.ok(argv.includes('--effort'), `missing --effort for ${tier}`);
    assert.ok(argv.includes(effort), `wrong effort ${effort} for ${tier}`);
  }
});

test('a pinned --model gemini-4-carbon (and gemini-3.8-flash) still dispatches on agy', async () => {
    const { agy } = await setup();
    const paths = { taskFile: '/w/task.md', cwd: '/w' };
    
    for (const model of ['gemini-4-carbon', 'gemini-3.8-flash']) {
        const reasoning = { applied: 'high' }; // carbon/flash dont have reasoning, but resolver provides one
        const argv = argvWithModel(agy, paths, model, null, reasoning);
        assert.ok(argv.includes(model), `wrong model ${model}`);
    }
});

test('--reasoning xhigh on agy sends --effort high', async () => {
    const { agy } = await setup();
    const strategy = { lastReport: { discoveries: { agy: { models: [] } } } };
    const reasoning = resolveReasoningLevel({ 
        connector: agy, tier: 'high', model: 'gemini-4-hydrogen', 
        strategy, 
        actionOverride: 'xhigh' 
    });
    assert.equal(reasoning.applied, 'high', 'xhigh clamped to high');
});

test('provider unit test: connectors() gives agy only gemini-* families and agy:claude only claude/gpt families, and agy:claude has no generationFallback', async () => {
    const template = JSON.parse(readFileSync(join(AGY_DIR, 'connector.json'), 'utf8'));
    const [agy, claude] = connectors({ template });
    
    assert.ok(agy.modelFamilies.every(f => f.family.startsWith('gemini-')), 'agy has gemini families');
    assert.ok(claude.modelFamilies.every(f => !f.family.startsWith('gemini-')), 'agy:claude has no gemini families');
    assert.ok(!claude.generationFallback, 'agy:claude has no generationFallback');
});
