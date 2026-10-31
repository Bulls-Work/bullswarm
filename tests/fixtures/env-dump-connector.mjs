import { writeFileSync } from 'node:fs';

// Fixture worker: records the one cache variable it was launched with (or
// `unset`) in the file named by BS_ENV_DUMP, then answers with enough text for
// the content judge.
writeFileSync(process.env.BS_ENV_DUMP, process.env.FORCE_PROMPT_CACHING_5M ?? 'unset');
console.log('The env-dump fixture recorded its launch environment and completed the bounded dispatch.');
console.log('The durable result contains the observed answer for later inspection by the caller.');
