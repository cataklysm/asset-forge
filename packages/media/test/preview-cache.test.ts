import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewJob, PreviewResult } from '../src/messages.js';
import {
  CACHE_LIMIT_BYTES,
  CACHE_TARGET_RATIO,
  CLEANUP_EVERY,
  createPreviewService,
  evictLeastRecentlyUsed,
  PREVIEW_EDGE,
  PREVIEW_FORMAT_VERSION,
  previewRelativePath,
  type PreviewService,
} from '../src/preview-cache.js';
import { createWorkerPool, type WorkerPool } from '../src/worker-pool.js';
import { TEST_WORKER_URL } from './worker-url.js';

/** Lets a test act between a directory listing and the stats that follow it. */
const hooks = vi.hoisted(() => ({
  beforeReaddir: undefined as ((path: string) => void) | undefined,
  afterReaddir: undefined as ((path: string, entries: unknown[]) => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdirWithHook = async (...args: Parameters<typeof actual.readdir>) => {
    hooks.beforeReaddir?.(String(args[0]));
    const entries = (await actual.readdir(...args)) as unknown[];
    hooks.afterReaddir?.(String(args[0]), entries);
    return entries;
  };
  return { ...actual, default: { ...actual, readdir: readdirWithHook }, readdir: readdirWithHook };
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const HOUR_MS = 60 * 60 * 1000;

let dir: string;
let cacheDir: string;
const services: PreviewService[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assetforge-cache-'));
  cacheDir = join(dir, 'cache');
});

afterEach(async () => {
  hooks.beforeReaddir = undefined;
  hooks.afterReaddir = undefined;
  await Promise.all(services.splice(0).map((service) => service.close()));
  // No retries: after close() no worker may still hold a file handle.
  await rm(dir, { recursive: true, force: true });
});

/** Writes 100 bytes per job with ascending mtimes; sources containing `broken` yield `none`. */
function fakePool() {
  const fake = {
    calls: [] as PreviewJob[],
    async run(job: PreviewJob): Promise<PreviewResult> {
      fake.calls.push(job);
      if (job.sourcePath.includes('broken')) return 'none';
      await mkdir(dirname(job.targetPath), { recursive: true });
      await writeFile(job.targetPath, Buffer.alloc(100));
      const seconds = 1_600_000_000 + fake.calls.length;
      await utimes(job.targetPath, seconds, seconds);
      return 'ok';
    },
    async close() {},
  };
  return fake;
}

function service(pool: WorkerPool, options: { limitBytes?: number; cleanupEvery?: number } = {}) {
  const created = createPreviewService({ cacheDir, pool, ...options });
  services.push(created);
  return created;
}

async function source(name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, 'source');
  return path;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Ten 100-byte entries in two shards, mtimes ascending with the index. */
async function fillShards(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < 10; i++) {
    const path = join(root, i % 2 === 0 ? 'aa' : 'bb', `${i}.webp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(100));
    const seconds = 1_600_000_000 + i;
    await utimes(path, seconds, seconds);
    paths.push(path);
  }
  return paths;
}

describe('preview cache', () => {
  it('the key changes with hash and size and carries the format version', () => {
    expect(previewRelativePath(A, 'thumb')).toBe(`thumbnails/${A.slice(0, 2)}/${A}-256-v1.webp`);
    expect(previewRelativePath(A, 'detail')).toBe(`previews/${A.slice(0, 2)}/${A}-1024-v1.webp`);
    expect(previewRelativePath(B, 'thumb')).not.toBe(previewRelativePath(A, 'thumb'));
  });

  it('limits are 2 GiB, 90 % and every 500 entries', () => {
    expect(CACHE_LIMIT_BYTES).toBe(2 * 1024 ** 3);
    expect(CACHE_TARGET_RATIO).toBe(0.9);
    expect(CLEANUP_EVERY).toBe(500);
    expect(PREVIEW_EDGE).toEqual({ thumb: 256, detail: 1024 });
    expect(PREVIEW_FORMAT_VERSION).toBe(1);
  });

  it('a hit does not call the pool again', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = await source('a.png');
    const first = await s.get({ sha256: A, sourcePath, size: 'thumb' });
    expect(first).toBe(join(cacheDir, previewRelativePath(A, 'thumb')));
    const before = (await stat(first as string)).mtimeMs;
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBe(first);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]).toEqual({ sourcePath, targetPath: first, longestEdge: 256 });
    // The hit refreshes the LRU position.
    expect((await stat(first as string)).mtimeMs).toBeGreaterThan(before);
  });

  it('concurrent identical requests produce one file', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = await source('a.png');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.get({ sha256: A, sourcePath, size: 'detail' })),
    );
    expect(new Set(results)).toEqual(new Set([join(cacheDir, previewRelativePath(A, 'detail'))]));
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.longestEdge).toBe(1024);
  });

  it('two files with the same content share one entry', async () => {
    const pool = fakePool();
    const s = service(pool);
    const first = await s.get({ sha256: A, sourcePath: await source('a.png'), size: 'thumb' });
    const second = await s.get({ sha256: A, sourcePath: await source('copy-of-a.png'), size: 'thumb' });
    expect(second).toBe(first);
    expect(pool.calls).toHaveLength(1);
  });

  it('a failed source is remembered for the session', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = await source('broken.png');
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBeNull();
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBeNull();
    expect(pool.calls).toHaveLength(1);
  });

  it('a missing source is not remembered as failed', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = join(dir, 'later.png');
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBeNull();
    expect(pool.calls).toHaveLength(0);
    await writeFile(sourcePath, 'source');
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBe(
      join(cacheDir, previewRelativePath(A, 'thumb')),
    );
    expect(pool.calls).toHaveLength(1);
  });

  it('a malformed hash yields no preview', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = await source('a.png');
    expect(await s.get({ sha256: '../../escape', sourcePath, size: 'thumb' })).toBeNull();
    expect(pool.calls).toHaveLength(0);
  });

  it('a deleted cache directory is recreated on the next request', async () => {
    const real = createWorkerPool({ workerUrl: TEST_WORKER_URL, size: 1, timeoutMs: 30_000 });
    let calls = 0;
    const counting: WorkerPool = {
      run: (job) => {
        calls++;
        return real.run(job);
      },
      close: () => real.close(),
    };
    const s = service(counting);
    const sourcePath = join(dir, 'a.png');
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#38a' } })
      .png()
      .toFile(sourcePath);
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).not.toBeNull();
    await rm(cacheDir, { recursive: true });
    const path = await s.get({ sha256: A, sourcePath, size: 'thumb' });
    expect(path).not.toBeNull();
    expect(await exists(path as string)).toBe(true);
    expect(calls).toBe(2);
  });

  it('evicts least recently used entries down to the target', async () => {
    const root = join(cacheDir, 'thumbnails');
    const paths = await fillShards(root);
    expect(await evictLeastRecentlyUsed(root, 500, 0.9)).toEqual({ removedFiles: 6 });
    const remaining = await Promise.all(paths.map(exists));
    expect(remaining).toEqual([false, false, false, false, false, false, true, true, true, true]);
  });

  it('does nothing while the total stays within the limit', async () => {
    const root = join(cacheDir, 'thumbnails');
    await fillShards(root);
    expect(await evictLeastRecentlyUsed(root, 1000, 0.9)).toEqual({ removedFiles: 0 });
    expect(await evictLeastRecentlyUsed(join(cacheDir, 'missing'), 1, 0.9)).toEqual({ removedFiles: 0 });
  });

  it('removes stale temporary files and leaves them out of the size', async () => {
    const root = join(cacheDir, 'thumbnails');
    const paths = await fillShards(root);
    const stale = join(root, 'aa', `0.webp.${'1'.repeat(8)}.tmp`);
    const fresh = join(root, 'bb', `1.webp.${'2'.repeat(8)}.tmp`);
    await writeFile(stale, Buffer.alloc(5000));
    await writeFile(fresh, Buffer.alloc(5000));
    const old = (Date.now() - 2 * HOUR_MS) / 1000;
    await utimes(stale, old, old);
    expect(await evictLeastRecentlyUsed(root, 1000, 0.9)).toEqual({ removedFiles: 1 });
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect((await Promise.all(paths.map(exists))).every(Boolean)).toBe(true);
  });

  it('eviction tolerates files vanishing underneath it', async () => {
    const root = join(cacheDir, 'thumbnails');
    const paths = await fillShards(root);
    const vanished = paths.filter((_, i) => i % 2 === 0).map((path) => basename(path));
    hooks.afterReaddir = (path) => {
      if (basename(path).length !== 2) return;
      for (const name of vanished) rmSync(join(path, name), { force: true });
    };
    // 5 of 10 entries vanish; 500 bytes remain against a 300-byte limit, so 3 more go.
    expect(await evictLeastRecentlyUsed(root, 300, 0.9)).toEqual({ removedFiles: 3 });
    const left = (await readdir(join(root, 'aa'))).length + (await readdir(join(root, 'bb'))).length;
    expect(left).toBe(2);
  });

  it('limits thumbnails and previews separately', async () => {
    // previews: 1000 bytes, older than every thumbnail; thumbnails: 500 bytes, newest.
    const previews = await fillShards(join(cacheDir, 'previews'));
    const thumbs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = join(cacheDir, 'thumbnails', 'aa', `${i}.webp`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(100));
      await utimes(path, 1_700_000_000 + i, 1_700_000_000 + i);
      thumbs.push(path);
    }
    const s = service(fakePool(), { limitBytes: 600 });
    await s.cleanup();
    // Only previews exceed the limit and shrink to at most 540 bytes; thumbnails stay whole.
    expect(await Promise.all(previews.map(exists))).toEqual([
      false, false, false, false, false, true, true, true, true, true,
    ]);
    expect((await Promise.all(thumbs.map(exists))).every(Boolean)).toBe(true);
  });

  it('runs cleanup after every `cleanupEvery` new entries', async () => {
    const pool = fakePool();
    const s = service(pool, { cleanupEvery: 3, limitBytes: 150 });
    // A cleanup run starts by listing `thumbnails`, synchronously within the triggering get.
    let cleanupRuns = 0;
    hooks.beforeReaddir = (path) => {
      if (path === join(cacheDir, 'thumbnails')) cleanupRuns++;
    };
    const sourcePath = await source('a.png');
    const first = (await s.get({ sha256: A, sourcePath, size: 'thumb' })) as string;
    await s.get({ sha256: B, sourcePath, size: 'thumb' });
    expect(cleanupRuns).toBe(0);
    const third = (await s.get({ sha256: C, sourcePath, size: 'thumb' })) as string;
    expect(cleanupRuns).toBe(1);
    // Joins the run the third entry started instead of starting a new one.
    await s.cleanup();
    expect(cleanupRuns).toBe(1);
    expect(await exists(first)).toBe(false);
    expect(await exists(third)).toBe(true);
  });

  it('runs real previews end to end', async () => {
    const s = service(createWorkerPool({ workerUrl: TEST_WORKER_URL, size: 1, timeoutMs: 30_000 }));
    const sourcePath = join(dir, 'a.png');
    await sharp({ create: { width: 900, height: 300, channels: 3, background: '#38a' } })
      .png()
      .toFile(sourcePath);
    const path = await s.get({ sha256: A, sourcePath, size: 'thumb' });
    expect(path).toBe(join(cacheDir, previewRelativePath(A, 'thumb')));
    const info = await sharp(await readFile(path as string)).metadata();
    expect(info.format).toBe('webp');
    expect(Math.max(info.width ?? 0, info.height ?? 0)).toBeLessThanOrEqual(256);
  });
});
