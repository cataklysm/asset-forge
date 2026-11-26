// Test worker: exits the whole worker on a job whose source path ends with `crash`, throws an
// uncaught error (naming the path) on one ending with `throw`, sends stray 'ok'-looking messages and
// then answers 'none' on one ending with `noise`, otherwise answers 'ok' (a measurement: 1 x 1).
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  const sourcePath = request.work.job?.sourcePath ?? request.work.sourcePath;
  const measure = request.work.kind === 'measure';
  if (sourcePath.endsWith('crash')) process.exit(1);
  if (sourcePath.endsWith('throw')) throw new Error(`cannot read ${sourcePath}`);
  if (sourcePath.endsWith('noise')) {
    for (const stray of [null, undefined, 'ok', 42, {}, { result: 'ok' }, { id: request.id + 1000, result: 'ok' }]) {
      parentPort.postMessage(stray);
    }
    parentPort.postMessage({ id: request.id, result: 'none' });
    return;
  }
  parentPort.postMessage({ id: request.id, result: measure ? { width: 1, height: 1 } : 'ok' });
});
