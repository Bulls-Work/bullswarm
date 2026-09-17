import { readFileSync, writeFileSync } from 'node:fs';

// Fixture worker that emits enough substantive text for the normal content
// judge and exits cleanly after one answer. Evidence actions also hand the
// worker a task file containing the kernel-owned candidate-*.json path; write
// the smallest valid envelope there so the acceptance step exercises the real
// evidence validator instead of failing on a missing artifact.
const taskFile = process.argv[2];
let taskText = '';
try { taskText = readFileSync(taskFile, 'utf8'); } catch { /* plain answer still works */ }
const candidatePath = taskText.match(/'([^']*candidate-[^']+\.json)'/)?.[1]
  ?? taskText.match(/(?:^|\s)(\/[^\s'" ]*candidate-[^\s'" ]*\.json)(?=$|\s)/)?.[1]
  ?? null;
const requirementsText = taskText.match(/Requirements to judge:\s*([\s\S]*?)(?:\nDependency artifacts:|$)/)?.[1] ?? '';
const requirementIds = [...requirementsText.matchAll(/^\s*-\s+([a-z0-9][a-z0-9-]*):/gm)].map((match) => match[1]);
if (candidatePath && requirementIds.length) {
  writeFileSync(candidatePath, JSON.stringify({
    schemaVersion: 'bullswarm.workflow.evidence.v2',
    requirements: Object.fromEntries(requirementIds.map((id) => [id, {
      status: 'passed',
      evidence: [`Fixture inspected ${id} and found the recorded answer.`],
      concerns: [],
    }])),
  }));
}
const ANSWER = [
  'The answering fixture completed the bounded dispatch and recorded the selected fallback pool.',
  'The durable result contains the observed answer and the routing decision for later inspection.',
].join('\n');
// BULLSWARM_FIXTURE_EVENTS=jsonl makes this worker speak the codex line shape
// (src/providers/codex/connector.json) so a connector manifest carrying that
// `eventStream` block exercises the persisted per-attempt stream. Unset, the
// worker prints the same two plain lines it always has.
if (process.env.BULLSWARM_FIXTURE_EVENTS === 'jsonl') {
  const say = (row) => console.log(JSON.stringify(row));
  say({ type: 'item.started', item: { id: 'a1', type: 'command_execution', command: 'cat owned.txt' } });
  say({ type: 'item.completed', item: { id: 'a1', type: 'command_execution', command: 'cat owned.txt' } });
  say({ type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: 'Reviewed the prior attempt block and kept the edit it left in owned.txt.' } });
  say({ type: 'item.completed', item: { id: 'a3', type: 'agent_message', text: ANSWER } });
} else {
  console.log(ANSWER);
}
