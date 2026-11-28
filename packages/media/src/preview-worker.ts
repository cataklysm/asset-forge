// worker_threads entry: answers each WorkerRequest from the parent port with a WorkerResponse.
import { parentPort } from 'node:worker_threads';
import { generatePreview, measureImage, modelJpeg } from './generate.js';
import type { ImageSize, PreviewResult, WorkerJob, WorkerRequest, WorkerResponse } from './messages.js';

const port = parentPort;
if (!port) throw new Error('preview-worker must run in a worker thread');

/**
 * Does the work of one request.
 *
 * @param work the work the parent asked for
 * @returns the answer; never rejects
 */
function answerOf(work: WorkerJob): Promise<PreviewResult | ImageSize | Uint8Array | null> {
  if (work.kind === 'measure') return measureImage(work.sourcePath);
  if (work.kind === 'jpeg') return modelJpeg(work.sourcePath);
  return generatePreview(work.job);
}

port.on('message', (request: WorkerRequest) => {
  void answerOf(request.work).then((result) => {
    const response: WorkerResponse = { id: request.id, result };
    port.postMessage(response);
  });
});
