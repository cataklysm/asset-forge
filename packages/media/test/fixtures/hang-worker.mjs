// Test worker: never answers a job whose source path ends with `hang`, otherwise answers 'ok'.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  if (request.job.sourcePath.endsWith('hang')) return;
  parentPort.postMessage({ id: request.id, result: 'ok' });
});
