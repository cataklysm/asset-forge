import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewJob } from '../src/messages.js';
import { createWorkerPool, POOL_SIZE, type WorkerPool } from '../src/worker-pool.js';
import { TEST_WORKER_URL } from './worker-url.js';

const crashUrl = new URL('./fixtures/crash-worker.mjs', import.meta.url);
const hangUrl = new URL('./fixtures/hang-worker.mjs', import.meta.url);

const pools: WorkerPool[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  // No retries: after close() no worker may still hold a file handle.
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pool(options: Parameters<typeof createWorkerPool>[0]): WorkerPool {
  const created = createWorkerPool(options);
  pools.push(created);
  return created;
}

function job(sourcePath: string): PreviewJob {
  return { sourcePath, targetPath: `${sourcePath}.webp`, longestEdge: 256 };
}

describe('createWorkerPool', () => {
  it('runs at most `size` jobs at once', async () => {
    const p = pool({ workerUrl: hangUrl, size: 2, timeoutMs: 200 });
    const start = performance.now();
    const timed = ['1-hang', '2-hang', '3-hang'].map((name) =>
      p.run(job(name)).then((result) => ({ result, elapsed: performance.now() - start })),
    );
    const outcomes = await Promise.all(timed);
    expect(outcomes.map((outcome) => outcome.result)).toEqual(['none', 'none', 'none']);
    const [first, second, third] = outcomes.map((outcome) => outcome.elapsed);
    expect(first).toBeGreaterThanOrEqual(200);
    expect(second).toBeGreaterThanOrEqual(200);
    expect(third).toBeGreaterThanOrEqual(400);
  });

  it('runs real previews through the bundled worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assetforge-pool-'));
    dirs.push(dir);
    const jobs: PreviewJob[] = [];
    for (let i = 0; i < 4; i++) {
      const sourcePath = join(dir, `${i}.png`);
      await sharp({ create: { width: 300 + i, height: 200, channels: 3, background: '#38a' } })
        .png()
        .toFile(sourcePath);
      jobs.push({ sourcePath, targetPath: join(dir, 'out', `${i}.webp`), longestEdge: 256 });
    }
    const p = pool({ workerUrl: TEST_WORKER_URL, size: 2, timeoutMs: 30_000 });
    expect(await Promise.all(jobs.map((j) => p.run(j)))).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('a crashed worker fails its job as none and is replaced', async () => {
    const p = pool({ workerUrl: crashUrl, size: 1, timeoutMs: 5_000 });
    expect(await p.run(job('a-crash'))).toBe('none');
    expect(await p.run(job('b'))).toBe('ok');
  });

  it('a job that exceeds the timeout resolves none and the pool keeps serving', async () => {
    const p = pool({ workerUrl: hangUrl, size: 1, timeoutMs: 200 });
    expect(await p.run(job('a-hang'))).toBe('none');
    expect(await p.run(job('b'))).toBe('ok');
  });

  it('close terminates the workers and later runs resolve none', async () => {
    const p = pool({ workerUrl: hangUrl, size: 1, timeoutMs: 30_000 });
    expect(await p.run(job('warm'))).toBe('ok');
    const running = p.run(job('a-hang'));
    const queued = p.run(job('b'));
    await p.close();
    expect(await running).toBe('none');
    expect(await queued).toBe('none');
    expect(await p.run(job('c'))).toBe('none');
  });

  it('POOL_SIZE is 2', () => expect(POOL_SIZE).toBe(2));
});
