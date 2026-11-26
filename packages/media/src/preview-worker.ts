// worker_threads entry: answers each WorkerRequest from the parent port with a WorkerResponse.
import { parentPort } from 'node:worker_threads';
import { generatePreview, measureImage, modelJpeg } from './generate.js';
import type { WorkerRequest, WorkerResponse } from './messages.js';

const port = parentPort;
if (!port) throw new Error('preview-worker must run in a worker thread');

port.on('message', (request: WorkerRequest) => {
  const work = request.work;
  const answer =
    work.kind === 'measure'
      ? measureImage(work.sourcePath)
      : work.kind === 'jpeg'
        ? modelJpeg(work.sourcePath)
        : generatePreview(work.job);
  void answer.then((result) => {
    const response: WorkerResponse = { id: request.id, result };
    port.postMessage(response);
  });
});
