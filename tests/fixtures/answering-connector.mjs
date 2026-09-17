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
console.log('The answering fixture completed the bounded dispatch and recorded the selected fallback pool.');
console.log('The durable result contains the observed answer and the routing decision for later inspection.');
