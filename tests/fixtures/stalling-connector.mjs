// Fixture worker for the free-pool fallback probe. It proves that a worker can
// leave durable partial output before going silent; the kernel's silence timer
// is responsible for ending this process.
console.log('## Partial\n\nRead the task file and enumerated 3 candidate files before going quiet.');
setTimeout(() => {
  console.log('recovered');
}, 600_000);
