import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/messages.js';
import { TEST_WORKER_URL } from './worker-url.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assetforge-media-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('sharp loads under the Electron ABI and resizes', async () => {
  expect(process.versions.electron).toBeDefined();
  const out = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#f00' },
  })
    .resize({ width: 10 })
    .webp()
    .toBuffer({ resolveWithObject: true });
  expect(out.info).toMatchObject({ format: 'webp', width: 10, height: 5 });
});

it('sharp resizes inside a worker thread', async () => {
  const sourcePath = join(dir, 'source.png');
  const targetPath = join(dir, 'preview.webp');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#00f' } })
    .png()
    .toFile(sourcePath);

  const worker = new Worker(TEST_WORKER_URL);
  try {
    const messages: unknown[] = [];
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not answer')), 4000);
      worker.on('message', (message: unknown) => {
        messages.push(message);
        if (messages.length < 2) return;
        clearTimeout(timer);
        resolve(message as WorkerResponse);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      const request: WorkerRequest = {
        id: 1,
        work: { kind: 'render', job: { sourcePath, targetPath, longestEdge: 10, format: 'webp' } },
      };
      worker.postMessage(request);
    });
    expect(messages[0]).toEqual({ ready: true });
    expect(response).toEqual({ id: 1, result: 'ok' });
    // Read through a buffer: libvips caches opened files, which keeps them locked on Windows.
    expect(await sharp(await readFile(targetPath)).metadata()).toMatchObject({
      format: 'webp',
      width: 10,
      height: 5,
    });
  } finally {
    await worker.terminate();
  }
});
