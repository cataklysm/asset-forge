// worker_threads entry: answers each WorkerRequest from the parent port with a WorkerResponse.
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import type { PreviewJob, PreviewResult, WorkerRequest, WorkerResponse } from './messages.js';

async function run(job: PreviewJob): Promise<PreviewResult> {
  try {
    await sharp(job.sourcePath)
      .resize({ width: job.longestEdge, height: job.longestEdge, fit: 'inside' })
      .webp()
      .toFile(job.targetPath);
    return 'ok';
  } catch {
    return 'none';
  }
}

const port = parentPort;
if (!port) throw new Error('preview-worker must run in a worker thread');

port.on('message', (request: WorkerRequest) => {
  void run(request.job).then((result) => {
    const response: WorkerResponse = { id: request.id, result };
    port.postMessage(response);
  });
});
