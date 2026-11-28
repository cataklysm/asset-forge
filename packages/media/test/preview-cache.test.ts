import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewJob, PreviewResult } from '../src/messages.js';
import {
  CACHE_LIMIT_BYTES,
  CACHE_TARGET_RATIO,
  CLEANUP_EVERY,
  createPreviewService,
  FRAME_FORMAT_VERSION,
  frameRelativePath,
  FULL_CLEANUP_EVERY,
  FULL_FORMAT_VERSION,
  PREVIEW_EDGE,
  PREVIEW_FORMAT_VERSION,
  previewRelativePath,
  type PreviewService,
} from '../src/preview-cache.js';
import { evictLeastRecentlyUsed } from '../src/cache-eviction.js';
import { FailureMemory, MAX_REMEMBERED_FAILURES } from '../src/failure-memory.js';
import type { VideoInfo } from '../src/video-diagnostics.js';
import type { VideoFormat } from '../src/video-frame-arguments.js';
import { createVideoFrames, type VideoFrames } from '../src/video-frames.js';
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
    async jpeg() {
      return null;
    },
    async measure() {
      return null;
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
    expect(previewRelativePath(A, 'full')).toBe(`full/${A.slice(0, 2)}/${A}-8192-v1.png`);
    expect(previewRelativePath(B, 'thumb')).not.toBe(previewRelativePath(A, 'thumb'));
  });

  it('limits are 2 GiB, 90 % and every 500 entries', () => {
    expect(CACHE_LIMIT_BYTES).toBe(2 * 1024 ** 3);
    expect(CACHE_TARGET_RATIO).toBe(0.9);
    expect(CLEANUP_EVERY).toBe(500);
    expect(PREVIEW_EDGE).toEqual({ thumb: 256, detail: 1024, full: 8192 });
    expect(FULL_FORMAT_VERSION).toBe(1);
    expect(FULL_CLEANUP_EVERY).toBe(8);
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
    expect(pool.calls[0]).toEqual({ sourcePath, targetPath: first, longestEdge: 256, format: 'webp' });
    // The hit refreshes the LRU position.
    expect((await stat(first as string)).mtimeMs).toBeGreaterThan(before);
  });

  it('renders the full size as lossless png in its own directory and serves it from the cache', async () => {
    const pool = fakePool();
    const s = service(pool);
    const sourcePath = await source('a.png');
    const path = await s.get({ sha256: A, sourcePath, size: 'full' });
    expect(path).toBe(join(cacheDir, `full/${A.slice(0, 2)}/${A}-8192-v1.png`));
    expect(pool.calls).toEqual([{ sourcePath, targetPath: path, longestEdge: 8192, format: 'png' }]);
    expect(await s.get({ sha256: A, sourcePath, size: 'full' })).toBe(path);
    expect(pool.calls).toHaveLength(1);
  });

  it('detail previews are requested as webp', async () => {
    const pool = fakePool();
    const s = service(pool);
    await s.get({ sha256: A, sourcePath: await source('a.png'), size: 'detail' });
    expect(pool.calls[0]).toMatchObject({ longestEdge: 1024, format: 'webp' });
  });

  it('limits full separately from thumbnails and previews', async () => {
    const full: string[] = [];
    for (let i = 0; i < 10; i++) {
      const path = join(cacheDir, 'full', 'aa', `${i}.png`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(100));
      await utimes(path, 1_600_000_000 + i, 1_600_000_000 + i);
      full.push(path);
    }
    const others: string[] = [];
    for (const directory of ['thumbnails', 'previews']) {
      const path = join(cacheDir, directory, 'aa', 'x.webp');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(500));
      others.push(path);
    }
    await service(fakePool(), { limitBytes: 600 }).cleanup();
    // Only full exceeds the limit and shrinks to at most 540 bytes.
    expect(await Promise.all(full.map(exists))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect((await Promise.all(others.map(exists))).every(Boolean)).toBe(true);
  });

  it('runs cleanup after FULL_CLEANUP_EVERY new full entries', async () => {
    const pool = fakePool();
    const s = service(pool, { limitBytes: 350 });
    let cleanupRuns = 0;
    hooks.beforeReaddir = (path) => {
      if (path === join(cacheDir, 'thumbnails')) cleanupRuns++;
    };
    const sourcePath = await source('a.png');
    const hashes = Array.from({ length: FULL_CLEANUP_EVERY }, (_, i) => String(i).repeat(64).slice(0, 64));
    for (const sha256 of hashes.slice(0, -1)) await s.get({ sha256, sourcePath, size: 'full' });
    expect(cleanupRuns).toBe(0);
    const last = (await s.get({ sha256: hashes.at(-1) as string, sourcePath, size: 'full' })) as string;
    // Joins the run the last entry started instead of starting a new one.
    await s.cleanup();
    expect(cleanupRuns).toBe(1);
    expect(await exists(last)).toBe(true);
    expect(await exists(join(cacheDir, previewRelativePath(hashes[0] as string, 'full')))).toBe(false);
  });

  it('thumbnails do not count towards the full counter', async () => {
    const s = service(fakePool(), { limitBytes: 50 });
    let cleanupRuns = 0;
    hooks.beforeReaddir = (path) => {
      if (path === join(cacheDir, 'thumbnails')) cleanupRuns++;
    };
    const sourcePath = await source('a.png');
    for (let i = 0; i < FULL_CLEANUP_EVERY; i++) {
      await s.get({ sha256: String(i).repeat(64).slice(0, 64), sourcePath, size: 'thumb' });
    }
    expect(cleanupRuns).toBe(0);
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
    expect(await s.get({ sha256: A, sourcePath, size: 'thumb' })).toBe(join(cacheDir, previewRelativePath(A, 'thumb')));
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
      measure: (path) => real.measure(path),
      jpeg: (path) => real.jpeg(path),
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
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
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

  describe('videos', () => {
    /** Writes a 50-byte frame unless the source contains `broken`; records every call. */
    function fakeFrames() {
      const fake = {
        calls: [] as { sourcePath: string; format: VideoFormat; targetPath: string }[],
        closed: false,
        async extract(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null> {
          fake.calls.push({ sourcePath, format, targetPath });
          if (sourcePath.includes('broken')) return null;
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, Buffer.alloc(50));
          return { width: 640, height: 360, durationMs: 4000 };
        },
        close() {
          fake.closed = true;
        },
      };
      return fake;
    }

    function videoService(
      pool: WorkerPool,
      frames: VideoFrames,
      options: { limitBytes?: number; cleanupEvery?: number } = {},
    ) {
      const created = createPreviewService({ cacheDir, pool, frames, ...options });
      services.push(created);
      return created;
    }

    it('the frame key carries its own format version', () => {
      expect(FRAME_FORMAT_VERSION).toBe(1);
      expect(frameRelativePath(A)).toBe(`frames/${A.slice(0, 2)}/${A}-v1.jpg`);
    });

    it('renders thumb and detail from one extracted frame, never from the video', async () => {
      const pool = fakePool();
      const frames = fakeFrames();
      const s = videoService(pool, frames);
      const sourcePath = await source('a.mp4');
      const framePath = join(cacheDir, frameRelativePath(A));
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).toBe(
        join(cacheDir, previewRelativePath(A, 'thumb')),
      );
      expect(await s.get({ sha256: A, sourcePath, size: 'detail', video: 'mp4' })).toBe(
        join(cacheDir, previewRelativePath(A, 'detail')),
      );
      expect(frames.calls).toEqual([{ sourcePath, format: 'mp4', targetPath: framePath }]);
      expect(pool.calls.map((call) => call.sourcePath)).toEqual([framePath, framePath]);
      expect(pool.calls.map((call) => call.longestEdge)).toEqual([256, 1024]);
      expect(pool.calls.every((call) => call.format === 'webp')).toBe(true);
    });

    it('full answers null for a video', async () => {
      const pool = fakePool();
      const frames = fakeFrames();
      const s = videoService(pool, frames);
      expect(await s.get({ sha256: A, sourcePath: await source('a.webm'), size: 'full', video: 'webm' })).toBeNull();
      expect(frames.calls).toHaveLength(0);
      expect(pool.calls).toHaveLength(0);
    });

    it('without a frame tool a video answers null', async () => {
      const pool = fakePool();
      const s = service(pool);
      expect(await s.get({ sha256: A, sourcePath: await source('a.mp4'), size: 'thumb', video: 'mp4' })).toBeNull();
      expect(pool.calls).toHaveLength(0);
    });

    it('concurrent requests share one extraction', async () => {
      const pool = fakePool();
      const frames = fakeFrames();
      const s = videoService(pool, frames);
      const sourcePath = await source('a.mp4');
      await Promise.all([
        s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' }),
        s.get({ sha256: A, sourcePath, size: 'detail', video: 'mp4' }),
        s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' }),
      ]);
      expect(frames.calls).toHaveLength(1);
      expect(pool.calls).toHaveLength(2);
    });

    it('a video without a frame is remembered for the session', async () => {
      const pool = fakePool();
      const frames = fakeFrames();
      const s = videoService(pool, frames);
      const sourcePath = await source('broken.mp4');
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).toBeNull();
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).toBeNull();
      expect(await s.get({ sha256: A, sourcePath, size: 'detail', video: 'mp4' })).toBeNull();
      expect(frames.calls).toHaveLength(1);
      expect(pool.calls).toHaveLength(0);
    });

    it('a missing video is not remembered as failed', async () => {
      const frames = fakeFrames();
      const s = videoService(fakePool(), frames);
      const sourcePath = join(dir, 'later.mp4');
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).toBeNull();
      expect(frames.calls).toHaveLength(0);
      await writeFile(sourcePath, 'source');
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).not.toBeNull();
    });

    it('a cached frame is reused after its previews were evicted', async () => {
      const pool = fakePool();
      const frames = fakeFrames();
      const s = videoService(pool, frames);
      const sourcePath = await source('a.mp4');
      await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' });
      await rm(join(cacheDir, 'thumbnails'), { recursive: true });
      expect(await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' })).not.toBeNull();
      expect(frames.calls).toHaveLength(1);
      expect(pool.calls).toHaveLength(2);
    });

    it('frames count towards the cleanup trigger and have their own budget', async () => {
      const s = videoService(fakePool(), fakeFrames(), { cleanupEvery: 2, limitBytes: 120 });
      let cleanupRuns = 0;
      let framesWalked = 0;
      hooks.beforeReaddir = (path) => {
        if (path === join(cacheDir, 'thumbnails')) cleanupRuns++;
        if (path === join(cacheDir, 'frames')) framesWalked++;
      };
      const sourcePath = await source('a.mp4');
      // One frame and one thumbnail are two new entries, so the first request starts a run.
      await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' });
      expect(cleanupRuns).toBe(1);
      await s.cleanup();
      expect(framesWalked).toBeGreaterThan(0);
      await s.get({ sha256: B, sourcePath, size: 'thumb', video: 'mp4' });
      await s.get({ sha256: C, sourcePath, size: 'thumb', video: 'mp4' });
      await s.cleanup();
      // 150 bytes of frames against 120: the frames directory is trimmed on its own.
      const left = await Promise.all([A, B, C].map((sha) => exists(join(cacheDir, frameRelativePath(sha)))));
      expect(left.filter(Boolean).length).toBe(2);
    });

    it('close closes the frame tool', async () => {
      const frames = fakeFrames();
      const s = createPreviewService({ cacheDir, pool: fakePool(), frames });
      await s.close();
      expect(frames.closed).toBe(true);
      expect(await s.get({ sha256: A, sourcePath: await source('a.mp4'), size: 'thumb', video: 'mp4' })).toBeNull();
    });

    it('measureVideo uses a temporary target that is removed afterwards', async () => {
      const frames = fakeFrames();
      const s = videoService(fakePool(), frames);
      const sourcePath = await source('a.mp4');
      expect(await s.measureVideo(sourcePath, 'mp4')).toEqual({ width: 640, height: 360, durationMs: 4000 });
      expect(frames.calls).toHaveLength(1);
      const target = frames.calls[0]?.targetPath as string;
      expect(dirname(target).startsWith(cacheDir)).toBe(true);
      expect(await exists(target)).toBe(false);
      expect(await s.measureVideo(join(dir, 'broken.mp4'), 'webm')).toBeNull();
      expect(await service(fakePool()).measureVideo(sourcePath, 'mp4')).toBeNull();
    });

    it('measureVideo shares one run between concurrent calls for the same source and format', async () => {
      const frames = fakeFrames();
      const s = videoService(fakePool(), frames);
      const sourcePath = await source('a.mp4');
      const answers = await Promise.all([s.measureVideo(sourcePath, 'mp4'), s.measureVideo(sourcePath, 'mp4')]);
      expect(answers).toEqual([
        { width: 640, height: 360, durationMs: 4000 },
        { width: 640, height: 360, durationMs: 4000 },
      ]);
      expect(frames.calls).toHaveLength(1);
      await s.measureVideo(sourcePath, 'webm');
      expect(frames.calls).toHaveLength(2);
      await s.measureVideo(sourcePath, 'mp4');
      expect(frames.calls).toHaveLength(3);
    });

    it('measureVideo remembers a failed measurement of a present source for the session', async () => {
      const frames = fakeFrames();
      const s = videoService(fakePool(), frames);
      const broken = await source('broken.mp4');
      expect(await s.measureVideo(broken, 'mp4')).toBeNull();
      expect(await s.measureVideo(broken, 'mp4')).toBeNull();
      expect(frames.calls).toHaveLength(1);

      const missing = join(dir, 'gone-broken.mp4');
      expect(await s.measureVideo(missing, 'mp4')).toBeNull();
      expect(await s.measureVideo(missing, 'mp4')).toBeNull();
      expect(frames.calls).toHaveLength(3);
    });

    it('runs real video previews end to end', async () => {
      const sourcePath = join(dir, 'a.mp4');
      await new Promise<void>((resolve, reject) =>
        execFile(
          ffmpegPath as string,
          [
            '-nostdin',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=640x360:rate=25:duration=2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            sourcePath,
          ],
          { windowsHide: true },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      const s = videoService(
        createWorkerPool({ workerUrl: TEST_WORKER_URL, size: 1, timeoutMs: 30_000 }),
        createVideoFrames({ binaryPath: ffmpegPath }),
      );
      const thumb = await s.get({ sha256: A, sourcePath, size: 'thumb', video: 'mp4' });
      expect(thumb).toBe(join(cacheDir, previewRelativePath(A, 'thumb')));
      const info = await sharp(await readFile(thumb as string)).metadata();
      expect(info).toMatchObject({ format: 'webp', width: 256, height: 144 });
      expect(await exists(join(cacheDir, frameRelativePath(A)))).toBe(true);
      expect(await s.get({ sha256: A, sourcePath, size: 'full', video: 'mp4' })).toBeNull();
      expect(await s.measureVideo(sourcePath, 'mp4')).toEqual({ width: 640, height: 360, durationMs: 2000 });
      expect((await readdir(join(cacheDir, 'frames'))).filter((name) => !/^[0-9a-f]{2}$/.test(name))).toEqual([]);
    });
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

describe('FailureMemory', () => {
  it('keeps at most its limit, forgetting the oldest key first', () => {
    const memory = new FailureMemory(2);
    memory.add('a');
    memory.add('b');
    memory.add('a');
    memory.add('c');
    expect(memory.size).toBe(2);
    expect(memory.has('b')).toBe(false);
    expect(memory.has('a')).toBe(true);
    expect(memory.has('c')).toBe(true);
  });

  it('is bounded by default and refuses a limit below 1', () => {
    const memory = new FailureMemory();
    for (let i = 0; i <= MAX_REMEMBERED_FAILURES; i++) memory.add(`key-${i}`);
    expect(memory.size).toBe(MAX_REMEMBERED_FAILURES);
    expect(memory.has('key-0')).toBe(false);
    expect(() => new FailureMemory(0)).toThrow(RangeError);
  });
});
