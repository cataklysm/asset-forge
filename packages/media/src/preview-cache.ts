import { lstat, readdir, rm, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoFormat, VideoFrames, VideoInfo } from './video-frames.js';
import type { WorkerPool } from './worker-pool.js';

export type PreviewSize = 'thumb' | 'detail' | 'full';

export const PREVIEW_EDGE: Record<PreviewSize, number> = { thumb: 256, detail: 1024, full: 8192 };
export const PREVIEW_FORMAT_VERSION = 1;
/** Version of the lossless `full` rendition, independent of `PREVIEW_FORMAT_VERSION`. */
export const FULL_FORMAT_VERSION = 1;
export const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;
export const CACHE_TARGET_RATIO = 0.9;
export const CLEANUP_EVERY = 500;
/** Full renditions are large, so they trigger a cleanup far sooner than thumbnails. */
export const FULL_CLEANUP_EVERY = 8;

/** Version of the extracted video frames, independent of the preview versions. */
export const FRAME_FORMAT_VERSION = 1;

const DIRECTORIES: Record<PreviewSize, string> = { thumb: 'thumbnails', detail: 'previews', full: 'full' };
const FRAMES_DIRECTORY = 'frames';
/** Every directory the LRU cleanup trims, each against its own budget. */
const CACHE_DIRECTORIES = [...Object.values(DIRECTORIES), FRAMES_DIRECTORY];
const SHA256 = /^[0-9a-f]{64}$/;
const VIDEO_FORMATS: readonly string[] = ['mp4', 'webm'] satisfies VideoFormat[];
/** A temporary file this old belongs to a write that will never be renamed. */
const STALE_TMP_MS = 60 * 60 * 1000;

/** Path relative to the cache root, e.g. `thumbnails/ab/<sha256>-256-v1.webp` or `full/ab/<sha256>-8192-v1.png`. */
export function previewRelativePath(sha256: string, size: PreviewSize): string {
  if (size === 'full') {
    return `${DIRECTORIES.full}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE.full}-v${FULL_FORMAT_VERSION}.png`;
  }
  return `${DIRECTORIES[size]}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE[size]}-v${PREVIEW_FORMAT_VERSION}.webp`;
}

/** Path of an extracted video frame relative to the cache root, e.g. `frames/ab/<sha256>-v1.jpg`. */
export function frameRelativePath(sha256: string): string {
  return `${FRAMES_DIRECTORY}/${sha256.slice(0, 2)}/${sha256}-v${FRAME_FORMAT_VERSION}.jpg`;
}

export interface PreviewRequest {
  sha256: string;
  sourcePath: string;
  size: PreviewSize;
  /** Set for a video: the preview is rendered from one extracted frame, never from the video. */
  video?: VideoFormat;
}

export interface PreviewService {
  /** Absolute path of the cached WebP (PNG for `full`), or null for "no preview". Never throws. */
  get(request: PreviewRequest): Promise<string | null>;
  /** Size and duration of a video through a temporary frame that is removed afterwards. Never throws. */
  measureVideo(sourcePath: string, format: VideoFormat): Promise<VideoInfo | null>;
  /**
   * Evicts least recently used entries from `thumbnails`, `previews`, `full` and `frames`, each
   * directory separately against `limitBytes`; concurrent calls share one run. Never throws.
   */
  cleanup(): Promise<void>;
  close(): Promise<void>;
}

export interface PreviewServiceOptions {
  cacheDir: string;
  pool: WorkerPool;
  /** Without it a video has no preview. */
  frames?: VideoFrames;
  limitBytes?: number;
  cleanupEvery?: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content-keyed preview cache below `cacheDir`. Previews are generated on demand through the
 * worker pool; identical concurrent requests share one generation. A source that produced no
 * preview is remembered for the session, a source that cannot be reached is not.
 */
export function createPreviewService(options: PreviewServiceOptions): PreviewService {
  const { cacheDir, pool, frames } = options;
  const limitBytes = options.limitBytes ?? CACHE_LIMIT_BYTES;
  const cleanupEvery = options.cleanupEvery ?? CLEANUP_EVERY;
  const failed = new Set<string>();
  const inflight = new Map<string, Promise<string | null>>();
  /** Video measurements by format and source path: the running ones, and those that failed this session. */
  const measuring = new Map<string, Promise<VideoInfo | null>>();
  const failedMeasurements = new Set<string>();
  const newEntries = { thumb: 0, full: 0 };
  let cleaning: Promise<void> | undefined;
  let closed = false;

  /** Thumbnails, previews and frames share one counter, full renditions have their own. */
  function countNewEntry(counter: 'thumb' | 'full'): void {
    newEntries[counter]++;
    if (newEntries[counter] >= (counter === 'full' ? FULL_CLEANUP_EVERY : cleanupEvery)) {
      newEntries[counter] = 0;
      void cleanup();
    }
  }

  async function touch(path: string): Promise<void> {
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
  }

  /** The cached frame of a video, extracted once; deduplicated and remembered like a preview. */
  function frameOf(request: PreviewRequest & { video: VideoFormat }, extractor: VideoFrames): Promise<string | null> {
    const key = `${request.sha256}:frame`;
    if (failed.has(key)) return Promise.resolve(null);
    const running = inflight.get(key);
    if (running) return running;
    const promise = (async () => {
      const framePath = join(cacheDir, frameRelativePath(request.sha256));
      if (await exists(framePath)) {
        await touch(framePath);
        return framePath;
      }
      if (!(await exists(request.sourcePath))) return null;
      if (await extractor.extract(request.sourcePath, request.video, framePath)) {
        countNewEntry('thumb');
        return framePath;
      }
      if (!closed && (await exists(request.sourcePath))) failed.add(key);
      return null;
    })()
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  async function resolvePreview(key: string, request: PreviewRequest): Promise<string | null> {
    const targetPath = join(cacheDir, previewRelativePath(request.sha256, request.size));
    if (await exists(targetPath)) {
      await touch(targetPath);
      return targetPath;
    }
    let renderSource = request.sourcePath;
    if (request.video) {
      // A video never reaches the worker pool: only its extracted frame does.
      const frame = frames ? await frameOf({ ...request, video: request.video }, frames) : null;
      if (!frame) return null;
      renderSource = frame;
    } else if (!(await exists(request.sourcePath))) {
      return null;
    }
    const result = await pool.run({
      sourcePath: renderSource,
      targetPath,
      longestEdge: PREVIEW_EDGE[request.size],
      format: request.size === 'full' ? 'png' : 'webp',
    });
    if (result === 'ok') {
      countNewEntry(request.size === 'full' ? 'full' : 'thumb');
      return targetPath;
    }
    // A pool that was closed or a source (or frame) that vanished meanwhile says nothing about the content.
    if (!closed && (await exists(renderSource))) failed.add(key);
    return null;
  }

  function cleanup(): Promise<void> {
    cleaning ??= (async () => {
      // Each directory has its own budget (ReadMe §15.3).
      for (const directory of CACHE_DIRECTORIES) {
        await evictLeastRecentlyUsed(join(cacheDir, directory), limitBytes, CACHE_TARGET_RATIO).catch(
          () => undefined,
        );
      }
    })().finally(() => {
      cleaning = undefined;
    });
    return cleaning;
  }

  return {
    get(request) {
      if (closed || !SHA256.test(request.sha256) || !(request.size in PREVIEW_EDGE)) {
        return Promise.resolve(null);
      }
      if (
        request.video !== undefined &&
        (!frames || request.size === 'full' || !VIDEO_FORMATS.includes(request.video))
      ) {
        return Promise.resolve(null);
      }
      const key = `${request.sha256}:${request.size}`;
      if (failed.has(key)) return Promise.resolve(null);
      const running = inflight.get(key);
      if (running) return running;
      const promise = resolvePreview(key, request)
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    measureVideo(sourcePath, format) {
      if (closed || !frames || !VIDEO_FORMATS.includes(format)) return Promise.resolve(null);
      const key = `${format}:${sourcePath}`;
      if (failedMeasurements.has(key)) return Promise.resolve(null);
      const running = measuring.get(key);
      if (running) return running;
      const extractor = frames;
      const promise = (async () => {
        // Ends in `.tmp`, so a target left by a crash is removed by the stale-file sweep of the cleanup.
        const target = join(cacheDir, FRAMES_DIRECTORY, `measure-${randomUUID()}.tmp`);
        let info: VideoInfo | null = null;
        try {
          info = await extractor.extract(sourcePath, format, target);
        } catch {
          info = null;
        } finally {
          await rm(target, { force: true, maxRetries: 3 }).catch(() => undefined);
        }
        // A source that is gone (or unreachable) may come back, so only a present one is remembered as failed.
        if (info === null && !closed && (await exists(sourcePath))) failedMeasurements.add(key);
        return info;
      })()
        .catch(() => null)
        .finally(() => measuring.delete(key));
      measuring.set(key, promise);
      return promise;
    },
    cleanup,
    async close() {
      closed = true;
      frames?.close();
      await pool.close();
      await cleaning;
    },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Reads a directory; a directory that does not exist (any more) is empty. */
async function listOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Unlinks a file; true when it was removed by this call, false when it was already gone. */
async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Walks `dir` recursively (including its two-character shard directories) as one LRU set.
 * Deletes temporary files older than one hour, then, if the remaining entries exceed
 * `limitBytes`, deletes the least recently used (oldest mtime) until the total is at most
 * `limitBytes * targetRatio`. Temporary files never count towards the total. Files that vanish
 * during the walk are skipped.
 */
export async function evictLeastRecentlyUsed(
  dir: string,
  limitBytes: number,
  targetRatio: number,
): Promise<{ removedFiles: number }> {
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  let removedFiles = 0;
  const staleBefore = Date.now() - STALE_TMP_MS;

  async function walk(current: string): Promise<void> {
    for (const name of await listOrEmpty(() => readdir(current))) {
      const path = join(current, name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      // lstat: symbolic links and junctions are neither followed nor counted.
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) continue;
      if (name.endsWith('.tmp')) {
        if (info.mtimeMs < staleBefore && (await removeIfPresent(path))) removedFiles++;
        continue;
      }
      entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  await walk(dir);

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return { removedFiles };
  const target = limitBytes * targetRatio;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= target) break;
    if (await removeIfPresent(entry.path)) removedFiles++;
    total -= entry.size;
  }
  return { removedFiles };
}
