// worker_threads entry: answers each WorkerRequest from the parent port with a WorkerResponse.
import { parentPort } from 'node:worker_threads';
import { generatePreview } from './generate.js';
import type { WorkerRequest, WorkerResponse } from './messages.js';

const port = parentPort;
if (!port) throw new Error('preview-worker must run in a worker thread');

port.on('message', (request: WorkerRequest) => {
  void generatePreview(request.job).then((result) => {
    const response: WorkerResponse = { id: request.id, result };
    port.postMessage(response);
  });
});
