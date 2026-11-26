// Test worker: never answers a job whose source path ends with `hang`, otherwise answers 'ok' (a measurement: 1 x 1).
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  if ((request.work.job?.sourcePath ?? request.work.sourcePath).endsWith('hang')) return;
  const measure = request.work.kind === 'measure';
  parentPort.postMessage({ id: request.id, result: measure ? { width: 1, height: 1 } : 'ok' });
});
