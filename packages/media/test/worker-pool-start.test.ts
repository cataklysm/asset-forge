import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewJob } from '../src/messages.js';
import {
  createWorkerPool,
  WORKER_START_BACKOFF_MAX_MS,
  WORKER_START_BACKOFF_MS,
  type WorkerPool,
} from '../src/worker-pool.js';

const started = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  /** Counts every worker the pool starts. */
  class CountingWorker extends actual.Worker {
    constructor(...parameters: ConstructorParameters<typeof actual.Worker>) {
      super(...parameters);
      started.count++;
    }
  }
  return { ...actual, Worker: CountingWorker };
});

const brokenUrl = new URL('./fixtures/broken-worker.mjs', import.meta.url);
const crashUrl = new URL('./fixtures/crash-worker.mjs', import.meta.url);

const pools: WorkerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  started.count = 0;
});

function job(sourcePath: string): PreviewJob {
  return { sourcePath, targetPath: `${sourcePath}.webp`, longestEdge: 256, format: 'webp' };
}

function setup(workerUrl: URL, size = 1) {
  const clock = { now: 1_000_000 };
  const log = vi.fn<(line: string) => void>();
  const pool = createWorkerPool({ workerUrl, size, timeoutMs: 5_000, log, now: () => clock.now });
  pools.push(pool);
  return { pool, clock, log };
}

describe('createWorkerPool when the worker cannot start', () => {
  it('has the agreed back-off', () => {
    expect(WORKER_START_BACKOFF_MS).toBe(2_000);
    expect(WORKER_START_BACKOFF_MAX_MS).toBe(60_000);
  });

  it('fails the whole queue on one failed start and logs one line', async () => {
    const { pool, log } = setup(brokenUrl);
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((name) => pool.run(job(name))));
    expect(results).toEqual(['none', 'none', 'none', 'none']);
    expect(started.count).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe('Preview worker failed to start (Error)');
  });

  it('fails requests fast during the back-off and doubles it after the next failed start', async () => {
    const { pool, clock, log } = setup(brokenUrl, 2);
    expect(await pool.run(job('a'))).toBe('none');
    expect(started.count).toBe(1);

    expect(await pool.measure('b')).toBeNull();
    expect(await pool.jpeg('c')).toBeNull();
    clock.now += WORKER_START_BACKOFF_MS - 1;
    expect(await pool.run(job('d'))).toBe('none');
    expect(started.count).toBe(1);

    clock.now += 1;
    expect(await pool.run(job('e'))).toBe('none');
    expect(started.count).toBe(2);

    clock.now += WORKER_START_BACKOFF_MS;
    expect(await pool.run(job('f'))).toBe('none');
    expect(started.count).toBe(2);
    clock.now += WORKER_START_BACKOFF_MS;
    expect(await pool.run(job('g'))).toBe('none');
    expect(started.count).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('never waits longer than the longest back-off', async () => {
    const { pool, clock } = setup(brokenUrl);
    for (let i = 0; i < 8; i++) {
      expect(await pool.run(job(`a${i}`))).toBe('none');
      clock.now += WORKER_START_BACKOFF_MAX_MS;
    }
    expect(started.count).toBe(8);
  });

  it('starts one worker for one job and treats a job that throws as no failed start', async () => {
    const { pool } = setup(crashUrl, 2);
    expect(await pool.run(job('a-throw'))).toBe('none');
    expect(started.count).toBe(1);
    expect(await pool.run(job('b'))).toBe('ok');
    expect(started.count).toBe(2);
  });
});
