import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewJob } from '../src/messages.js';
import { createWorkerPool, POOL_SIZE, type WorkerPool } from '../src/worker-pool.js';
import { TEST_WORKER_URL } from './worker-url.js';

const crashUrl = new URL('./fixtures/crash-worker.mjs', import.meta.url);
const hangUrl = new URL('./fixtures/hang-worker.mjs', import.meta.url);
const brokenUrl = new URL('./fixtures/broken-worker.mjs', import.meta.url);

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

  it('serves queued jobs newest first', async () => {
    const p = pool({ workerUrl: crashUrl, size: 1, timeoutMs: 5_000 });
    const order: string[] = [];
    const runs = ['a', 'b', 'c', 'd'].map((name) => p.run(job(name)).then(() => order.push(name)));
    await Promise.all(runs);
    // 'a' starts at once; the others wait and the last requested runs first.
    expect(order).toEqual(['a', 'd', 'c', 'b']);
  });

  it('ignores null and foreign messages from a worker', async () => {
    const p = pool({ workerUrl: crashUrl, size: 1, timeoutMs: 5_000 });
    expect(await p.run(job('a-noise'))).toBe('none');
    expect(await p.run(job('b'))).toBe('ok');
  });

  it('a worker error fails its job, logs one line without the path and the pool recovers', async () => {
    const log = vi.fn<(line: string) => void>();
    const p = pool({ workerUrl: crashUrl, size: 1, timeoutMs: 5_000, log });
    const secret = join(tmpdir(), 'secret-dir', 'a-throw');
    expect(await p.run(job(secret))).toBe('none');
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0]!;
    expect(line).not.toContain('\n');
    expect(line).not.toContain('secret-dir');
    expect(line).not.toContain(tmpdir());
    expect(await p.run(job('b'))).toBe('ok');
  });

  it('a worker that fails to start fails its job and logs one line without the path', async () => {
    const log = vi.fn<(line: string) => void>();
    const p = pool({ workerUrl: brokenUrl, size: 1, timeoutMs: 5_000, log });
    expect(await p.run(job('a'))).toBe('none');
    expect(await p.run(job('b'))).toBe('none');
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('broken-worker');
      expect(line).not.toContain('fixtures');
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a pool size of %s at once', (size) => {
    expect(() => createWorkerPool({ workerUrl: crashUrl, size, timeoutMs: 1_000 })).toThrow(RangeError);
  });

  it('POOL_SIZE is 2', () => expect(POOL_SIZE).toBe(2));
});
