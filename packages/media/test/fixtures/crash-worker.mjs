// Test worker: exits the whole worker on a job whose source path ends with `crash`, throws an
// uncaught error (naming the path) on one ending with `throw`, sends stray 'ok'-looking messages and
// then answers 'none' on one ending with `noise`, otherwise answers 'ok'.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  const { sourcePath } = request.job;
  if (sourcePath.endsWith('crash')) process.exit(1);
  if (sourcePath.endsWith('throw')) throw new Error(`cannot read ${sourcePath}`);
  if (sourcePath.endsWith('noise')) {
    for (const stray of [null, undefined, 'ok', 42, {}, { result: 'ok' }, { id: request.id + 1000, result: 'ok' }]) {
      parentPort.postMessage(stray);
    }
    parentPort.postMessage({ id: request.id, result: 'none' });
    return;
  }
  parentPort.postMessage({ id: request.id, result: 'ok' });
});
