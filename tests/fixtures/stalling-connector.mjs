import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fixture worker for the free-pool fallback probe. It proves that a worker can
// leave durable partial output before going silent; the kernel's silence timer
// is responsible for ending this process. When the caller left a tracked
// `owned.txt` in cwd, edit it so a retry handoff can snapshot a real diff.
const owned = join(process.cwd(), 'owned.txt');
if (existsSync(owned)) {
  writeFileSync(owned, `${readFileSync(owned, 'utf8')}stalling-fixture edit\n`);
}
// BULLSWARM_FIXTURE_EVENTS=jsonl makes this worker speak the codex line shape
// (src/providers/codex/connector.json), so a connector manifest with that
// `eventStream` block exercises the persisted per-attempt stream. Without the
// variable the worker prints the same plain markdown it always has.
if (process.env.BULLSWARM_FIXTURE_EVENTS === 'jsonl') {
  const say = (row) => console.log(JSON.stringify(row));
  say({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls src/workflow' } });
  say({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls src/workflow' } });
  say({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Read the task file and enumerated 3 candidate files.' } });
  say({ type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'sed -n 1,80p src/workflow/stats-view.js' } });
  say({ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'sed -n 1,80p src/workflow/stats-view.js' } });
  say({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Editing owned.txt with the first pass before checking the tests.' } });
  say({ type: 'item.completed', item: { id: 'm3', type: 'agent_message', text: '## Partial\n\nRead the task file and enumerated 3 candidate files before going quiet.' } });
} else {
  console.log('## Partial\n\nRead the task file and enumerated 3 candidate files before going quiet.');
}
setTimeout(() => {
  console.log('recovered');
}, 600_000);
