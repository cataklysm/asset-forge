// Test worker: exits the whole worker on a job whose source path ends with `crash`, otherwise answers 'ok'.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  if (request.job.sourcePath.endsWith('crash')) process.exit(1);
  parentPort.postMessage({ id: request.id, result: 'ok' });
});
